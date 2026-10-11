"""目录与对象存储对账：四类比对，只告警不改状态、不自动删字节。

发现分类
  pending_missing_bytes  对象 pending，正式 key 无字节
  ready_missing_object   对象 ready，正式 key 缺失（最严重，数据丢失）
  formal_orphan          存储有正式字节，但目录无对应非删除对象
  staging_orphan         存储有暂存字节，但无未完成的上传会话

出口 = 结构化日志 + var/reports/reconcile-*.jsonl（一行一发现）+ 可选 ALERT_WEBHOOK_URL
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import ObjectRecord, UploadSession, ensure_aware, utcnow

logger = logging.getLogger(__name__)


def _finding(kind: str, *, tenant_id: str, detail: str, object_id: str | None = None, object_key: str | None = None) -> dict:
    return {
        "kind": kind,
        "tenant_id": tenant_id,
        "object_id": object_id,
        "object_key": object_key,
        "detail": detail,
    }


def run_reconcile(session: Session, storage) -> dict:
    """执行一次对账，返回 {"report_path", "counts", "findings"}。不修改任何目录或字节状态。"""
    findings: list[dict] = []
    known_formal: set[str] = set()
    known_staging: set[str] = set()

    objects = session.scalars(select(ObjectRecord)).all()
    for obj in objects:
        known_formal.add(obj.object_key)
        if obj.status == "pending":
            try:
                storage.size(obj.object_key)
            except Exception:
                findings.append(_finding(
                    "pending_missing_bytes", tenant_id=obj.tenant_id, object_id=obj.id,
                    object_key=obj.object_key, detail="pending 对象正式 key 无字节",
                ))
        elif obj.status == "ready":
            try:
                storage.size(obj.object_key)
            except Exception:
                findings.append(_finding(
                    "ready_missing_object", tenant_id=obj.tenant_id, object_id=obj.id,
                    object_key=obj.object_key, detail="ready 对象正式 key 缺失，可能数据丢失",
                ))

    uploads = session.scalars(select(UploadSession)).all()
    for upload in uploads:
        known_staging.add(upload.staging_key)

    # 中文注释：扫描存储侧，找出目录里没有的正式/暂存对象
    for key, size in _iter_storage(storage, "objects/"):
        if key not in known_formal:
            findings.append(_finding(
                "formal_orphan", tenant_id=_tenant_from_key(key), object_key=key,
                detail=f"存储有正式字节 {size}B，但目录无对应非删除对象",
            ))
    for key, size in _iter_storage(storage, "staging/"):
        if key not in known_staging:
            findings.append(_finding(
                "staging_orphan", tenant_id=_tenant_from_key(key), object_key=key,
                detail=f"存储有暂存字节 {size}B，但无未完成上传会话",
            ))

    counts: dict[str, int] = {}
    for item in findings:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1

    report_path = _write_report(findings)
    for item in findings:
        logger.warning("对账发现 %s: %s", item["kind"], item.get("detail"))
    _send_alerts(findings, report_path)

    return {"report_path": str(report_path) if report_path else None, "counts": counts, "findings": findings}


def _iter_storage(storage, prefix: str):
    """枚举存储对象；FakeStorage 无 list 时返回空（对账退化为只查目录侧）。"""
    lister = getattr(storage, "list_keys", None)
    if lister is None:
        return []
    try:
        return lister(prefix)
    except Exception as exc:
        logger.error("枚举存储前缀 %s 失败: %s", prefix, exc)
        return []


def _tenant_from_key(key: str) -> str:
    # 中文注释：正式/暂存 key 形如 objects/{tenant}/{id} 或 staging/{tenant}/{id}
    parts = key.split("/")
    return parts[1] if len(parts) > 2 else "unknown"


def _write_report(findings: list[dict]) -> Path | None:
    if not findings:
        return None
    try:
        reports_dir = Path(get_settings().reports_dir)
        reports_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = reports_dir / f"reconcile-{stamp}.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            for item in findings:
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        return path
    except OSError as exc:
        logger.error("写入对账报告失败: %s", exc)
        return None


def send_alert(payload: dict) -> None:
    """可选告警出口；失败只记录日志，不影响主流程。"""
    url = get_settings().alert_webhook_url
    if not url:
        return
    try:
        import urllib.request

        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(request, timeout=10)  # noqa: S310 — 内部告警地址由运维配置
    except Exception as exc:
        logger.error("发送告警失败: %s", exc)


def _send_alerts(findings: list[dict], report_path: Path | None) -> None:
    """对账发现告警。"""
    if not findings:
        return
    send_alert({
        "summary": f"对账发现 {len(findings)} 项",
        "report_path": str(report_path) if report_path else None,
        "findings": findings[:50],
    })


def reclaim_orphans(session: Session, storage, *, actor_id: str = "system", max_items: int = 50) -> int:
    """孤儿对象 TTL 回收：document_internal ready 且无引用且超过宽限期 → 走删除流程。

    只处理 document_internal（standalone 无「引用」概念）；返回处理条数。
    宽限期按租户保留策略取值（orphan_object_grace_hours）。
    """
    from app.database import DocumentAsset, DocumentVersion, Job
    from app.retention import load_retention_policy, purge_after_from_now

    settings = get_settings()
    now = utcnow()
    candidates = session.scalars(
        select(ObjectRecord).where(
            ObjectRecord.purpose == "document_internal",
            ObjectRecord.status == "ready",
            ObjectRecord.ready_at.is_not(None),
        ).limit(max_items * 3)
    ).all()
    reclaimed = 0
    policy_cache: dict[str, dict] = {}
    for obj in candidates:
        if obj.tenant_id not in policy_cache:
            policy_cache[obj.tenant_id] = load_retention_policy(session, obj.tenant_id)
        policy = policy_cache[obj.tenant_id]
        grace_hours = int(policy.get("orphan_object_grace_hours", settings.orphan_object_grace_hours))
        threshold = now - timedelta(hours=grace_hours)
        if ensure_aware(obj.ready_at) > threshold:
            continue
        # 中文注释：软删但未永久清除的版本仍持有引用（恢复窗口内可还原），不能提前回收
        referenced = session.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.tenant_id == obj.tenant_id,
                DocumentVersion.purged_at.is_(None),
                (DocumentVersion.raw_object_id == obj.id) | (DocumentVersion.body_object_id == obj.id),
            ).limit(1)
        )
        if referenced:
            continue
        # 中文注释：附件引用同样只算未永久清除的版本（软删版本保留 asset 行以支持恢复）
        asset = session.scalar(
            select(DocumentAsset.id)
            .join(DocumentVersion, DocumentVersion.id == DocumentAsset.version_id)
            .where(
                DocumentAsset.tenant_id == obj.tenant_id,
                DocumentAsset.object_id == obj.id,
                DocumentVersion.purged_at.is_(None),
            ).limit(1)
        )
        if asset:
            continue
        purge_at = purge_after_from_now(obj.tenant_id, policy, kind="object")
        obj.status = "deleting"
        obj.deleted_reason = "orphan"
        obj.deleted_at = now
        obj.purge_after = purge_at
        session.add(Job(
            id=str(uuid4()), tenant_id=obj.tenant_id, kind="delete_object",
            target_id=obj.id, status="pending", next_run_at=purge_at or now,
        ))
        reclaimed += 1
        logger.info("孤儿对象进入回收 %s (%s)", obj.id, actor_id)
        if reclaimed >= max_items:
            break
    if reclaimed:
        session.commit()
    return reclaimed
