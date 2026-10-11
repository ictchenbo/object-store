import logging
import time
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.orm import Session

from app.logging_conf import configure_logging

from app.config import get_settings
from app.database import (
    Document,
    DocumentAsset,
    DocumentVersion,
    Job,
    ObjectRecord,
    ObjectTag,
    OutboxEvent,
    UploadSession,
    ensure_aware,
    get_engine,
    release_document_identity,
    utcnow,
)
from app.retention import load_retention_policy, version_keep_limit
from app.storage import ContentMismatch, ObjectMissing, StorageError, get_storage, promote_staging


configure_logging()
logger = logging.getLogger(__name__)


def process_one(session: Session, storage) -> bool:
    settings = get_settings()
    now = utcnow()
    job = session.scalar(
        select(Job).where(
            Job.attempts < settings.job_max_attempts,
            or_(
                and_(Job.status.in_(["pending", "failed"]), Job.next_run_at <= now),
                and_(Job.status == "running", Job.claimed_at < now - timedelta(minutes=5)),
            ),
        )
        .order_by(Job.created_at, Job.id).with_for_update(skip_locked=True).limit(1)
    )
    if job is None:
        return False
    job.status = "running"
    job.attempts += 1
    job.claimed_at = now
    session.commit()
    try:
        # 中文注释：runner 返回 False 表示已自我改期（未到恢复窗口），不能标记 done
        completed = True
        if job.kind == "delete_object":
            completed = _run_delete_object(session, storage, job)
        elif job.kind == "finalize_upload":
            _run_finalize_upload(session, storage, job)
        elif job.kind == "purge_document":
            completed = _run_purge_document(session, storage, job)
        elif job.kind == "purge_version":
            completed = _run_purge_version(session, storage, job)
        elif job.kind == "prune_versions":
            _run_prune_versions(session, storage, job)
        elif job.kind == "reconcile":
            _run_reconcile(session, storage, job)
        else:
            raise ValueError(f"未知任务类型: {job.kind}")
        job.status = "done" if completed else "pending"
        job.last_error = None if completed else job.last_error
        job.claimed_at = None
        session.commit()
        return True
    except (StorageError, ValueError) as exc:
        session.rollback()
        job = session.get(Job, job.id)
        # 中文注释：耗尽尝试次数后标记 dead，不再被拾取；需人工或 API 重试复活
        job.status = "dead" if job.attempts >= settings.job_max_attempts else "failed"
        job.last_error = str(exc)[:1000]
        job.claimed_at = None
        job.next_run_at = utcnow() + timedelta(seconds=min(60 * (2 ** min(job.attempts, 6)), 3600))
        session.commit()
        logger.warning("任务失败 %s: %s", job.id, exc)
        return True
    except Exception as exc:
        # 中文注释：兜底捕获——避免非 StorageError 异常让任务卡在 running
        session.rollback()
        job = session.get(Job, job.id)
        if job is not None:
            job.status = "dead" if job.attempts >= settings.job_max_attempts else "failed"
            job.last_error = f"unhandled: {str(exc)[:900]}"
            job.claimed_at = None
            job.next_run_at = utcnow() + timedelta(seconds=min(60 * (2 ** min(job.attempts, 6)), 3600))
            session.commit()
        logger.exception("任务异常 %s", job.id if job else "?")
        return True


def _object_still_referenced(session: Session, obj: ObjectRecord) -> bool:
    """对象是否仍被「未永久清除」的版本引用（含软删待恢复版本）。"""
    direct = session.scalar(
        select(DocumentVersion.id).where(
            DocumentVersion.tenant_id == obj.tenant_id,
            DocumentVersion.purged_at.is_(None),
            or_(DocumentVersion.raw_object_id == obj.id, DocumentVersion.body_object_id == obj.id),
        ).limit(1)
    )
    if direct:
        return True
    asset = session.scalar(
        select(DocumentAsset.id)
        .join(DocumentVersion, DocumentVersion.id == DocumentAsset.version_id)
        .where(
            DocumentAsset.tenant_id == obj.tenant_id,
            DocumentAsset.object_id == obj.id,
            DocumentVersion.purged_at.is_(None),
        ).limit(1)
    )
    return bool(asset)


def _run_delete_object(session: Session, storage, job: Job) -> bool:
    """返回 True 表示任务完成；False 表示未到 purge_after，已改期待执行。"""
    obj = session.get(ObjectRecord, job.target_id)
    if obj is None:
        raise ValueError("目标对象不存在")
    # 中文注释：恢复窗口内不删字节——任务可能在 purge_after 之前被调度
    if obj.status == "ready" and obj.deleted_at is None:
        return True
    # 中文注释：已永久清除的任务重放直接完成，避免重复删字节/写 outbox
    if obj.purged_at is not None:
        return True
    if obj.purge_after is not None and ensure_aware(obj.purge_after) > utcnow():
        job.next_run_at = obj.purge_after
        return False
    try:
        storage.remove(obj.object_key)
    except ObjectMissing:
        # 中文注释：字节已不在（幂等），按已删处理
        pass
    obj.status = "deleted"
    obj.deleted_at = obj.deleted_at or utcnow()
    obj.purged_at = utcnow()
    session.execute(delete(ObjectTag).where(ObjectTag.tenant_id == obj.tenant_id, ObjectTag.object_id == obj.id))
    session.add(OutboxEvent(
        id=str(uuid4()), tenant_id=obj.tenant_id, event_kind="object.purged",
        target_type="object", target_id=obj.id, actor_id="system",
        payload={"object_key": obj.object_key, "deleted_reason": obj.deleted_reason or "user_delete"},
    ))
    return True


def _run_finalize_upload(session: Session, storage, job: Job) -> None:
    """过期上传的暂存复制收尾：流式晋级成功后删暂存；永久性不符则放弃并归档幂等键。"""
    upload = session.get(UploadSession, job.target_id)
    if upload is None:
        raise ValueError("上传会话不存在")
    obj = session.get(ObjectRecord, upload.object_id)
    if obj is None:
        raise ValueError("目标对象不存在")
    if obj.status != "pending":
        # 中文注释：对象已被 complete 或已放弃，任务按完成处理
        return
    upload.copy_attempts += 1
    try:
        size, digest, final_type = promote_staging(
            storage, upload.staging_key, obj.object_key,
            expected_size=upload.expected_size, expected_sha256=upload.declared_sha256,
            content_type=obj.content_type,
        )
    except ContentMismatch as exc:
        # 中文注释：确定性不符（声明哈希错误/暂存丢失或尺寸不对）重试无意义，直接放弃
        upload.last_copy_error = str(exc)[:1000]
        _give_up_upload(session, storage, upload, obj)
        logger.error("暂存晋级内容不符，已放弃 %s: %s", obj.id, exc)
        return
    obj.size_bytes = size
    obj.sha256 = digest
    obj.content_type = final_type
    obj.status = "ready"
    obj.ready_at = utcnow()
    upload.completed_at = obj.ready_at
    upload.last_copy_error = None
    try:
        storage.remove(upload.staging_key)
    except ObjectMissing:
        pass
    logger.info("暂存晋级完成 %s (copy_attempts=%s)", obj.id, upload.copy_attempts)


def _run_purge_document(session: Session, storage, job: Job) -> bool:
    """文档永久清除：窗口到期后清理版本、附件关系与引用对象字节。

    若文档已被恢复（deleted_at 为空）则跳过；未到 purge_after 时自我改期。
    返回 True 表示完成；False 表示已改期。
    """
    document = session.get(Document, job.target_id)
    if document is None:
        raise ValueError("文档不存在")
    if document.deleted_at is None:
        logger.info("文档已恢复，跳过永久清除 %s", document.id)
        return True
    # 中文注释：已永久清除的任务重放直接完成，避免重复写 purged_at 与 outbox
    if document.purged_at is not None:
        logger.info("文档已永久清除，跳过 %s", document.id)
        return True
    if document.purge_after is not None and ensure_aware(document.purge_after) > utcnow():
        job.next_run_at = document.purge_after
        return False
    versions = session.scalars(
        select(DocumentVersion).where(DocumentVersion.document_id == document.id)
    ).all()
    object_ids: set[str] = set()
    for version in versions:
        if version.raw_object_id:
            object_ids.add(version.raw_object_id)
        if version.body_object_id:
            object_ids.add(version.body_object_id)
        version.status = "deleted"
        version.deleted_at = version.deleted_at or utcnow()
        # 中文注释：文档级永久清除连带版本一并标记，防止版本侧误显示可恢复
        version.purge_after = version.purge_after or document.purge_after
        version.purged_at = version.purged_at or utcnow()
    if versions:
        for asset in session.scalars(
            select(DocumentAsset).where(DocumentAsset.version_id.in_([v.id for v in versions]))
        ).all():
            object_ids.add(asset.object_id)
        session.execute(delete(DocumentAsset).where(DocumentAsset.version_id.in_([v.id for v in versions])))
    document.current_version_id = None
    document.purged_at = utcnow()
    # 中文注释：永久清除后释放 (source, external_id) 唯一槽位，允许同一外部文档重新采集；
    # 原 external_id 存入 attrs.purged_external_id 供审计
    release_document_identity(document)
    enqueued = 0
    for object_id in object_ids:
        obj = session.get(ObjectRecord, object_id)
        if obj is None or obj.status in {"deleted", "deleting"}:
            continue
        # 中文注释：对象可能被其他文档版本共享；本文档版本已全部落 purged_at，
        # 仍被其他未永久清除版本引用时绝不能删字节
        if _object_still_referenced(session, obj):
            logger.info("对象仍被其他版本引用，跳过删除 %s", obj.id)
            continue
        obj.status = "deleting"
        obj.deleted_reason = obj.deleted_reason or "purge"
        obj.deleted_at = obj.deleted_at or utcnow()
        # 中文注释：文档已过恢复窗口，对象字节立即排队删除
        obj.purge_after = None
        session.add(Job(
            id=str(uuid4()), tenant_id=obj.tenant_id, kind="delete_object",
            target_id=obj.id, status="pending", next_run_at=utcnow(),
        ))
        enqueued += 1
    session.add(OutboxEvent(
        id=str(uuid4()), tenant_id=document.tenant_id, event_kind="document.purged",
        target_type="document", target_id=document.id, actor_id="system",
        payload={"version_count": len(versions), "object_count": enqueued},
    ))
    logger.info("文档永久清除 %s：入队 %s 个删除任务", document.id, enqueued)
    return True


def _run_purge_version(session: Session, storage, job: Job) -> bool:
    """版本永久清除：到期后清附件关系，释放对象引用供孤儿回收。"""
    version = session.get(DocumentVersion, job.target_id)
    if version is None:
        raise ValueError("版本不存在")
    if version.deleted_at is None or version.status != "deleted":
        logger.info("版本已恢复，跳过永久清除 %s", version.id)
        return True
    # 中文注释：已永久清除的任务重放直接完成
    if version.purged_at is not None:
        return True
    if version.purge_after is not None and ensure_aware(version.purge_after) > utcnow():
        job.next_run_at = version.purge_after
        return False
    session.execute(delete(DocumentAsset).where(DocumentAsset.version_id == version.id))
    version.purged_at = utcnow()
    session.add(OutboxEvent(
        id=str(uuid4()), tenant_id=version.tenant_id, event_kind="document.version_purged",
        target_type="document", target_id=version.document_id, actor_id="system",
        payload={"version_id": version.id, "version_no": version.version_no},
    ))
    logger.info("版本永久清除 %s (v%s)", version.id, version.version_no)
    return True


def _run_prune_versions(session: Session, storage, job: Job) -> None:
    """按租户 version_retention 策略裁剪历史版本（软删 + 进入恢复窗口）。

    只处理 target_id 指定的文档；keep_all 不做任何事。
    """
    from app.retention import purge_after_from_now

    document = session.get(Document, job.target_id)
    if document is None:
        raise ValueError("文档不存在")
    if document.deleted_at is not None:
        return
    policy = load_retention_policy(session, document.tenant_id)
    keep = version_keep_limit(policy)
    if keep is None:
        return
    versions = session.scalars(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.status == "ready",
            DocumentVersion.deleted_at.is_(None),
        ).order_by(DocumentVersion.version_no.desc())
    ).all()
    current_id = document.current_version_id
    pruned = 0
    for index, version in enumerate(versions):
        # 中文注释：当前版本始终保留；keep_current_only 时只留当前
        if version.id == current_id:
            continue
        if index < keep:
            continue
        purge_at = purge_after_from_now(document.tenant_id, policy, kind="document")
        version.status = "deleted"
        version.deleted_at = utcnow()
        version.purge_after = purge_at
        session.add(Job(
            id=str(uuid4()), tenant_id=version.tenant_id, kind="purge_version",
            target_id=version.id, status="pending", next_run_at=purge_at or utcnow(),
        ))
        pruned += 1
    if pruned:
        session.add(OutboxEvent(
            id=str(uuid4()), tenant_id=document.tenant_id, event_kind="document.versions_pruned",
            target_type="document", target_id=document.id, actor_id="system",
            payload={"pruned": pruned, "keep": keep, "version_retention": policy.get("version_retention")},
        ))
        logger.info("版本保留策略裁剪文档 %s：%s 个版本进入回收站", document.id, pruned)


def _run_reconcile(session: Session, storage, job: Job) -> None:
    """对账任务：只告警不改状态；发现写入 var/reports/reconcile-*.jsonl。"""
    from app.reconcile import run_reconcile

    result = run_reconcile(session, storage)
    logger.info(
        "对账完成 counts=%s report=%s", result.get("counts"), result.get("report_path"),
    )


def _give_up_upload(session: Session, storage, upload: UploadSession, obj: ObjectRecord) -> None:
    """放弃该上传：对象置 failed、删暂存、归档幂等键以释放原键可重建。"""
    obj.status = "failed"
    try:
        storage.remove(upload.staging_key)
    except ObjectMissing:
        pass
    _archive_idempotency_key(upload)
    session.commit()


def _archive_idempotency_key(upload: UploadSession) -> None:
    """归档幂等键：改写为 "{key}#failed-{uuid8}"，原键可被新请求重建。"""
    if "#failed-" not in upload.idempotency_key:
        upload.idempotency_key = f"{upload.idempotency_key}#failed-{uuid4().hex[:8]}"


def expire_one_upload(session: Session, storage) -> bool:
    """过期上传状态机。

    - 正式副本存在且大小一致 → 对象 ready + 删暂存（恢复目录状态）
    - 正式缺失/不符且暂存有字节、未超重试上限、未过宽限期 → 入队 finalize_upload，
      对象保持 pending、不删暂存
    - 耗尽重试或超宽限 → 对象 failed + 删暂存 + 归档幂等键
    """
    settings = get_settings()
    now = utcnow()
    active_finalize = (
        select(Job.id)
        .where(
            Job.kind == "finalize_upload",
            Job.target_id == UploadSession.id,
            Job.status.in_(["pending", "running", "failed"]),
        )
        .exists()
    )
    row = session.execute(
        select(UploadSession, ObjectRecord)
        .join(ObjectRecord, UploadSession.object_id == ObjectRecord.id)
        .where(UploadSession.expires_at < now, ObjectRecord.status == "pending", ~active_finalize)
        .order_by(UploadSession.expires_at)
        .with_for_update(skip_locked=True)
        .limit(1)
    ).first()
    if row is None:
        return False
    upload, obj = row
    from app.retention import load_retention_policy

    policy = load_retention_policy(session, upload.tenant_id)
    try:
        try:
            final_size = storage.size(obj.object_key)
        except ObjectMissing:
            final_size = None
        if final_size == upload.expected_size:
            # 中文注释：正式副本已就绪，恢复目录状态
            obj.size_bytes = final_size
            obj.status = "ready"
            obj.ready_at = utcnow()
            upload.completed_at = obj.ready_at
            try:
                storage.remove(upload.staging_key)
            except ObjectMissing:
                pass
            session.commit()
            return True

        staging_size: int | None
        try:
            staging_size = storage.size(upload.staging_key)
        except ObjectMissing:
            staging_size = None

        past_grace = ensure_aware(upload.expires_at) + timedelta(seconds=policy.get("staging_retry_grace_seconds", settings.staging_retry_grace_seconds)) < now
        exhausted = upload.copy_attempts >= policy.get("staging_retry_max_attempts", settings.staging_retry_max_attempts)
        if staging_size is not None and not past_grace and not exhausted:
            session.add(Job(
                id=str(uuid4()), tenant_id=upload.tenant_id, kind="finalize_upload",
                target_id=upload.id, status="pending",
            ))
            session.commit()
            logger.info("过期上传待收尾 %s (copy_attempts=%s)", upload.id, upload.copy_attempts)
            return True

        upload.last_copy_error = upload.last_copy_error or (
            "暂存对象缺失" if staging_size is None else "重试次数或宽限期耗尽"
        )
        _give_up_upload(session, storage, upload, obj)
        logger.warning("过期上传已放弃 %s: %s", upload.id, upload.last_copy_error)
        return True
    except StorageError:
        session.rollback()
        raise


def _schedule_maintenance(session: Session) -> bool:
    """按间隔入队维护任务：孤儿回收（直接跑）与对账（入队执行）。"""
    settings = get_settings()
    now = utcnow()
    # 中文注释：reconcile 用 target_id 标记调度来源，避免与手动触发重复拾取
    active = session.scalar(
        select(Job.id).where(
            Job.kind == "reconcile", Job.target_id == "schedule",
            Job.status.in_(["pending", "running"]),
        ).limit(1)
    )
    if active is None:
        last = session.scalar(
            select(func.max(Job.created_at)).where(Job.kind == "reconcile", Job.target_id == "schedule")
        )
        if last is None or ensure_aware(last) + timedelta(seconds=settings.reconcile_interval_seconds) <= now:
            session.add(Job(
                id=str(uuid4()), tenant_id="system", kind="reconcile",
                target_id="schedule", status="pending",
            ))
            session.commit()
            return True
    return False


def _check_job_health(session: Session) -> None:
    """任务健康巡检：死信/积压/最老待执行任务超阈值时发告警。"""
    from app.reconcile import send_alert

    now = utcnow()
    dead = session.scalar(select(func.count(Job.id)).where(Job.status == "dead")) or 0
    pending = session.scalar(select(func.count(Job.id)).where(Job.status == "pending")) or 0
    oldest = session.scalar(
        select(func.min(Job.next_run_at)).where(Job.status.in_(["pending", "failed"]))
    )
    oldest_age_s = (now - ensure_aware(oldest)).total_seconds() if oldest else 0.0
    alerts = []
    if dead > 0:
        alerts.append({"kind": "jobs_dead", "count": dead, "detail": f"{dead} 个任务耗尽重试进入 dead，需人工 retry"})
    if pending > 1000:
        alerts.append({"kind": "jobs_backlog", "count": pending, "detail": f"待执行任务积压 {pending}"})
    if oldest_age_s > 3600:
        alerts.append({"kind": "jobs_stuck", "count": int(oldest_age_s), "detail": f"最老待执行任务已等待 {int(oldest_age_s)} 秒"})
    if alerts:
        logger.warning("任务健康告警: %s", alerts)
        send_alert({"summary": "任务队列健康告警", "alerts": alerts})


def _schedule_prune(session: Session, document_id: str, tenant_id: str) -> None:
    """版本发布后按保留策略裁剪历史版本；keep_all 时 Worker 内直接跳过。"""
    session.add(Job(
        id=str(uuid4()), tenant_id=tenant_id, kind="prune_versions",
        target_id=document_id, status="pending",
    ))


def main() -> None:
    from app.reconcile import reclaim_orphans

    storage = get_storage()
    last_reclaim = 0.0
    last_health = 0.0
    while True:
        try:
            with Session(get_engine()) as session:
                worked = process_one(session, storage) or expire_one_upload(session, storage)
                worked = _schedule_maintenance(session) or worked
                # 中文注释：孤儿回收每 60s 扫一批，避免与业务任务抢锁
                if time.monotonic() - last_reclaim >= 60:
                    try:
                        reclaim_orphans(session, storage)
                    except Exception:
                        logger.exception("孤儿回收异常")
                    last_reclaim = time.monotonic()
                # 中文注释：任务健康巡检每 5 分钟一次，死信/积压告警
                if time.monotonic() - last_health >= 300:
                    try:
                        _check_job_health(session)
                    except Exception:
                        logger.exception("任务健康巡检异常")
                    last_health = time.monotonic()
            if not worked:
                time.sleep(2)
        except Exception:
            logger.exception("Worker 循环异常")
            time.sleep(5)


if __name__ == "__main__":
    main()
