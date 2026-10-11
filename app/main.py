import secrets
import hashlib
import hmac
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Callable, Literal, NamedTuple
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.orm import Session

from app.config import ACTOR_ID_PATTERN, Settings, get_settings
from app.database import (
    Document,
    DocumentAsset,
    DocumentTag,
    DocumentType,
    DocumentTypeChange,
    DocumentVersion,
    IdempotencyRecord,
    Job,
    ObjectRecord,
    ObjectTag,
    OutboxEvent,
    ShareLink,
    Tag,
    TenantSettings,
    UploadSession,
    User,
    UserSession,
    ensure_aware,
    get_session,
    release_document_identity,
    run_migrations,
    utcnow,
)
from app.retention import RETENTION_NOTE, load_retention_policy, purge_after_from_now
from app.schemas import (
    BulkDeleteInput,
    BulkTagInput,
    DownloadUrlInput,
    IngestComplete,
    IngestCreate,
    LoginInput,
    ReclassifyInput,
    RestoreInput,
    RetentionPolicyInput,
    ShareLinkCreate,
    TagInput,
    TagMode,
    UploadCreate,
    UserCreateInput,
    request_fingerprint,
)
from app.storage import ContentMismatch, MinioStorage, ObjectMissing, StorageError, get_storage, promote_staging
from app.tags import bind_tags, filtered_target_ids, get_tags, insert_ignore, normalize_name
from app.logging_conf import configure_logging

logger = logging.getLogger(__name__)

# 中文注释：进程内请求指标，供 /metrics 输出 Prometheus 文本（单实例即可，不引依赖）
_request_counts: dict[tuple[str, str, int], int] = {}
_request_duration_sum_ms: dict[tuple[str, str], float] = {}
_request_duration_count: dict[tuple[str, str], int] = {}
_JOB_STATUS_KEYS = ("pending", "running", "failed", "done", "dead")


class AuthContext(NamedTuple):
    """中文注释：鉴权上下文；操作者身份来自 Key 配置、登录会话或 X-Actor-Id。"""

    tenant_id: str
    actor_id: str
    api_key_id: str
    role: str = "admin"  # admin | viewer


def _hash_password(password: str, *, salt: bytes | None = None) -> str:
    """PBKDF2-HMAC-SHA256 密码哈希；格式 pbkdf2$<iterations>$<salt_hex>$<hash_hex>。"""
    salt = salt or secrets.token_bytes(16)
    iterations = 200_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2${iterations}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations_s, salt_hex, hash_hex = stored.split("$")
        if scheme != "pbkdf2":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations_s)
        )
        return hmac.compare_digest(digest.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def _session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def auth_context(
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    x_actor_id: str | None = Header(default=None, alias="X-Actor-Id"),
    settings: Settings = Depends(get_settings),
    session: Session = Depends(get_session),
) -> AuthContext:
    """支持两种鉴权来源：X-API-Key（服务间调用）或 Authorization: Bearer（登录会话）。"""
    # 中文注释：登录会话优先——控制台用户走 Bearer，服务集成走 API Key
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        token_hash = _session_token_hash(token)
        row = session.scalar(select(UserSession).where(UserSession.token_hash == token_hash))
        if row is None or row.revoked_at is not None or ensure_aware(row.expires_at) <= utcnow():
            raise HTTPException(401, "会话无效或已过期")
        user = session.get(User, row.user_id)
        if user is None or not user.active:
            raise HTTPException(401, "用户已停用")
        return AuthContext(tenant_id=user.tenant_id, actor_id=user.username, api_key_id=f"user:{user.id}", role=user.role)

    if not x_api_key:
        raise HTTPException(401, "缺少 X-API-Key 或登录会话")
    matched: tuple[str, str, str] | None = None
    for key, triple in _api_key_roles(settings).items():
        if secrets.compare_digest(x_api_key, key):
            matched = triple
            break
    if matched is None:
        raise HTTPException(401, "API Key 无效")
    tenant_id, actor_id, role = matched
    if x_actor_id:
        if not settings.allow_actor_override:
            raise HTTPException(403, "当前配置不允许覆盖操作者")
        if not ACTOR_ID_PATTERN.match(x_actor_id):
            raise HTTPException(422, "X-Actor-Id 格式无效")
        actor_id = x_actor_id
    # 中文注释：api_key_id 仅用于日志关联，不写入业务表
    api_key_id = hashlib.sha256(x_api_key.encode()).hexdigest()[:12]
    return AuthContext(tenant_id=tenant_id, actor_id=actor_id, api_key_id=api_key_id, role=role)


def _api_key_roles(settings: Settings) -> dict[str, tuple[str, str, str]]:
    """把 API_KEYS_JSON 解析为 key -> (tenant_id, actor_id, role)。"""
    import json as _json

    raw = _json.loads(settings.api_keys_json)
    result: dict[str, tuple[str, str, str]] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            result[key] = (value, "tenant-default", "admin")
        else:
            result[key] = (
                value["tenant_id"],
                value.get("actor_id", "tenant-default"),
                value.get("role", "admin"),
            )
    return result


def require_admin(auth: AuthContext = Depends(auth_context)) -> AuthContext:
    """写操作统一入口：viewer 只读。"""
    if auth.role != "admin":
        raise HTTPException(403, "只读角色不允许写操作")
    return auth


def admin_tenant_id(auth: AuthContext = Depends(require_admin)) -> str:
    # 中文注释：写接口只需租户时的薄封装；需要 actor 审计时直接 Depends(require_admin)
    return auth.tenant_id


def tenant_from_auth(auth: AuthContext = Depends(auth_context)) -> str:
    # 中文注释：仅需租户的场景走此薄封装，鉴权统一收口在 auth_context
    return auth.tenant_id


def append_outbox(
    session: Session, *, tenant_id: str, event_kind: str, target_type: str,
    target_id: str, actor_id: str | None = None, payload: dict | None = None,
) -> None:
    """同事务追加事件流水；不单独 commit，由调用方统一提交。"""
    session.add(OutboxEvent(
        id=str(uuid4()), tenant_id=tenant_id, event_kind=event_kind,
        target_type=target_type, target_id=target_id,
        actor_id=actor_id, payload=payload,
    ))


def _resolve_download_ttl(payload: DownloadUrlInput | None, settings: Settings) -> int:
    """解析下载/预览 TTL：请求值（30..3600）再夹到配置上限内。"""
    ttl = settings.download_url_ttl_seconds
    if payload and payload.ttl_seconds:
        ttl = max(30, min(int(payload.ttl_seconds), ttl))
    return ttl


def idempotent_write(
    session: Session,
    *,
    tenant_id: str,
    idempotency_key: str | None,
    endpoint: str,
    fingerprint: str,
    run: Callable[[], tuple[int, dict | list | None]],
):
    """可选 Idempotency-Key 的写操作封装。

    - 无 key：直接执行并提交
    - 同 key 同指纹：重放已存响应（不重复执行）
    - 同 key 不同指纹：409
    - 首次执行：业务变更与幂等记录同一事务提交，保证至少一次可见
    """
    if idempotency_key:
        record = session.scalar(
            select(IdempotencyRecord).where(
                IdempotencyRecord.tenant_id == tenant_id,
                IdempotencyRecord.idempotency_key == idempotency_key,
            )
        )
        if record is not None:
            if record.request_fingerprint != fingerprint:
                raise HTTPException(409, "幂等键已用于不同请求")
            return JSONResponse(status_code=record.response_status, content=record.response_body)
    status, body = run()
    encoded = jsonable_encoder(body)
    if idempotency_key:
        session.add(IdempotencyRecord(
            id=str(uuid4()), tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint=endpoint, request_fingerprint=fingerprint,
            response_status=status, response_body=encoded,
        ))
    session.commit()
    if encoded is None:
        return Response(status_code=status)
    return JSONResponse(status_code=status, content=encoded)


def require_object(session: Session, tenant_id: str, object_id: str, *, lock: bool = False) -> ObjectRecord:
    query = select(ObjectRecord).where(ObjectRecord.id == object_id, ObjectRecord.tenant_id == tenant_id)
    obj = session.scalar(query.with_for_update() if lock else query)
    if obj is None:
        raise HTTPException(404, "对象不存在")
    return obj


def require_document(session: Session, tenant_id: str, document_id: str, *, lock: bool = False, allow_deleted: bool = False) -> Document:
    query = select(Document).where(Document.id == document_id, Document.tenant_id == tenant_id)
    if not allow_deleted:
        query = query.where(Document.deleted_at.is_(None))
    document = session.scalar(query.with_for_update() if lock else query)
    if document is None:
        raise HTTPException(404, "文档不存在")
    return document


def object_data(session: Session, obj: ObjectRecord) -> dict:
    return {
        "id": obj.id,
        "purpose": obj.purpose,
        "bucket": obj.bucket,
        "object_key": obj.object_key,
        "display_name": obj.display_name,
        "size_bytes": obj.size_bytes,
        "sha256": obj.sha256,
        "content_type": obj.content_type,
        "status": obj.status,
        "created_at": obj.created_at,
        "ready_at": obj.ready_at,
        # 中文注释：软删信息随对象返回，回收站/恢复 UI 需要
        "deleted_at": obj.deleted_at,
        "purge_after": obj.purge_after,
        "purged_at": obj.purged_at,
        "tags": get_tags(session, obj.tenant_id, obj.id, "object"),
    }


def version_data(session: Session, version: DocumentVersion) -> dict:
    assets = session.scalars(
        select(DocumentAsset).where(DocumentAsset.version_id == version.id).order_by(DocumentAsset.role, DocumentAsset.ordinal)
    ).all()
    # 中文注释：顺带取对象元数据，前端预览需要 content_type / size_bytes。
    # raw/body 必须一并返回 —— document_internal 受授权约束，前端无法自行 GET /objects/{id}。
    object_ids = [item.object_id for item in assets]
    object_ids.extend(item for item in (version.raw_object_id, version.body_object_id) if item)
    object_meta: dict[str, ObjectRecord] = {}
    if object_ids:
        for row in session.scalars(select(ObjectRecord).where(ObjectRecord.id.in_(object_ids))).all():
            object_meta[row.id] = row

    def _object_meta(object_id: str | None) -> tuple[str | None, int | None]:
        row = object_meta.get(object_id) if object_id else None
        return (row.content_type, row.size_bytes) if row else (None, None)

    raw_content_type, raw_size_bytes = _object_meta(version.raw_object_id)
    body_content_type, body_size_bytes = _object_meta(version.body_object_id)
    return {
        "id": version.id,
        "version_no": version.version_no,
        "status": version.status,
        "doc_type": version.doc_type_snapshot,
        "raw_object_id": version.raw_object_id,
        "body_object_id": version.body_object_id,
        "raw_content_type": raw_content_type,
        "raw_size_bytes": raw_size_bytes,
        "body_content_type": body_content_type,
        "body_size_bytes": body_size_bytes,
        "attrs": version.attrs,
        "published_at": version.published_at,
        # 中文注释：软删版本随列表可见，供前端展示「已删除」与恢复入口
        "deleted_at": version.deleted_at,
        "purge_after": version.purge_after,
        "purged_at": version.purged_at,
        "assets": [
            {
                "object_id": item.object_id,
                "role": item.role,
                "ordinal": item.ordinal,
                "reference_name": item.reference_name,
                "content_type": object_meta[item.object_id].content_type if item.object_id in object_meta else "application/octet-stream",
                "size_bytes": object_meta[item.object_id].size_bytes if item.object_id in object_meta else None,
            }
            for item in assets
        ],
    }


def document_data(session: Session, document: Document, *, include_current: bool = True) -> dict:
    result = {
        "id": document.id,
        "source": document.source,
        "external_id": document.external_id,
        "doc_type": document.doc_type,
        "title": document.title,
        "attrs": document.attrs,
        "current_version_id": document.current_version_id,
        "created_at": document.created_at,
        # 中文注释：软删/清除信息随文档返回，回收站与恢复 UI 需要
        "deleted_at": document.deleted_at,
        "purge_after": document.purge_after,
        "purged_at": document.purged_at,
        "tags": get_tags(session, document.tenant_id, document.id, "document"),
    }
    if include_current:
        version = session.get(DocumentVersion, document.current_version_id) if document.current_version_id else None
        result["current_version"] = version_data(session, version) if version else None
    return result


def apply_cursor(
    query, model, session: Session, tenant_id: str, cursor: str | None,
    *, time_field: str = "created_at", sort_field: str | None = None, ascending: bool = False,
):
    """按 (排序字段, id) 游标分页；sort_field 缺省用 time_field，ascending 控制方向。"""
    if not cursor:
        return query
    record = session.scalar(select(model).where(model.id == cursor, model.tenant_id == tenant_id))
    if record is None:
        raise HTTPException(400, "无效游标")
    field_name = sort_field or time_field
    sort_col = getattr(model, field_name)
    record_val = getattr(record, field_name)
    if ascending:
        return query.where(or_(sort_col > record_val, and_(sort_col == record_val, model.id > record.id)))
    return query.where(or_(sort_col < record_val, and_(sort_col == record_val, model.id < record.id)))


def order_by_sort(model, *, sort_field: str, ascending: bool):
    col = getattr(model, sort_field)
    if ascending:
        return [col.asc(), model.id.asc()]
    return [col.desc(), model.id.desc()]


def has_document_reference(session: Session, obj: ObjectRecord) -> bool:
    """对象是否仍被「未永久清除」的版本引用。

    中文注释：软删版本（status=deleted 但 purged_at 为空）仍在恢复窗口内，
    必须继续持有引用——否则孤儿回收会提前清掉字节，版本恢复成功但内容丢失。
    只有 purge_version / purge_document 落了 purged_at 之后才真正释放引用。
    """
    direct = session.scalar(
        select(DocumentVersion.id).where(
            DocumentVersion.tenant_id == obj.tenant_id,
            DocumentVersion.purged_at.is_(None),
            or_(DocumentVersion.raw_object_id == obj.id, DocumentVersion.body_object_id == obj.id),
        ).limit(1)
    )
    if direct:
        return True
    # 中文注释：附件引用同样只算未永久清除的版本——软删版本保留 asset 行以支持恢复
    asset = session.scalar(
        select(DocumentAsset.id)
        .join(DocumentVersion, DocumentVersion.id == DocumentAsset.version_id)
        .where(
            DocumentAsset.tenant_id == obj.tenant_id,
            DocumentAsset.object_id == obj.id,
            DocumentVersion.purged_at.is_(None),
        )
        .limit(1)
    )
    return bool(asset)


def version_references_object(session: Session, version: DocumentVersion, object_id: str) -> bool:
    # 中文注释：判定单个版本是否通过正文/原文/附件引用该对象
    if object_id in {version.raw_object_id, version.body_object_id}:
        return True
    asset = session.scalar(
        select(DocumentAsset.id).where(DocumentAsset.version_id == version.id, DocumentAsset.object_id == object_id).limit(1)
    )
    return bool(asset)


def document_references_object(
    session: Session, document: Document, object_id: str, version_no: int | None = None
) -> bool:
    # 中文注释：判定文档（可限定版本）是否引用该对象；document_internal 下载需经此校验
    query = select(DocumentVersion).where(
        DocumentVersion.document_id == document.id,
        DocumentVersion.status == "ready",
    )
    if version_no is not None:
        query = query.where(DocumentVersion.version_no == version_no)
    return any(version_references_object(session, version, object_id) for version in session.scalars(query).all())


def _ingest_session_body(session: Session, version: DocumentVersion, document: Document, *, storage, settings) -> dict:
    """重建采集会话响应；parts 重放时为仍待上传的分片重新签发 upload_url。"""
    body = {
        "ingest_session_id": version.id,
        "document_id": document.id,
        "version_no": version.version_no,
        "status": version.status,
    }
    plan = version.upload_plan or {}
    parts = plan.get("parts") or []
    if not parts:
        return body
    now = utcnow()
    uploads = []
    for entry in parts:
        upload = session.get(UploadSession, entry["upload_id"])
        obj = session.get(ObjectRecord, entry["object_id"])
        url = None
        expires_at = None
        if upload is not None and obj is not None and obj.status == "pending" and ensure_aware(upload.expires_at) > now:
            remaining = max(1, int((ensure_aware(upload.expires_at) - now).total_seconds()))
            url = storage.upload_url(upload.staging_key, min(settings.upload_url_ttl_seconds, remaining))
            expires_at = upload.expires_at
        uploads.append({
            **entry,
            "upload_url": url,
            "expires_at": expires_at,
            "object_status": obj.status if obj is not None else None,
        })
    body["uploads"] = uploads
    return body


@asynccontextmanager
async def production_lifespan(_app: FastAPI):
    # 中文注释：PostgreSQL 走 alembic 受控迁移；sqlite/演示退回 create_all
    for attempt in range(30):
        try:
            run_migrations()
            get_storage().ensure_bucket()
            break
        except Exception:
            if attempt == 29:
                raise
            time.sleep(2)
    yield


def create_app(*, initialize: bool = True) -> FastAPI:
    configure_logging()
    app = FastAPI(title="Object + Document Store MVP", version="0.1.0", lifespan=production_lifespan if initialize else None)

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        request.state.request_id = request_id
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            path = request.url.path
            key = (request.method, path, status)
            _request_counts[key] = _request_counts.get(key, 0) + 1
            dkey = (request.method, path)
            _request_duration_sum_ms[dkey] = _request_duration_sum_ms.get(dkey, 0.0) + duration_ms
            _request_duration_count[dkey] = _request_duration_count.get(dkey, 0) + 1
            logger.info(
                "access", extra={
                    "request_id": request_id, "method": request.method, "path": path,
                    "status": status, "duration_ms": duration_ms,
                },
            )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": f"HTTP_{exc.status_code}", "message": str(exc.detail), "request_id": request.state.request_id},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={"code": "VALIDATION_ERROR", "message": str(exc.errors()), "request_id": request.state.request_id},
        )

    @app.exception_handler(StorageError)
    async def storage_error(request: Request, _exc: StorageError):
        return JSONResponse(
            status_code=503,
            content={"code": "STORAGE_UNAVAILABLE", "message": "对象存储暂不可用", "request_id": request.state.request_id},
        )

    @app.get("/health")
    @app.get("/health/live")
    def health_live():
        # 中文注释：存活探针，静态 ok；/health 保留为兼容别名
        return {"status": "ok"}

    @app.get("/health/ready")
    def health_ready(session: Session = Depends(get_session), storage: MinioStorage = Depends(get_storage)):
        """就绪探针：DB SELECT 1 + 桶存在性；失败 503 并带分项 checks。"""
        checks: dict[str, str] = {}
        try:
            session.execute(text("SELECT 1"))
            checks["database"] = "ok"
        except Exception as exc:
            checks["database"] = f"error: {exc}"
        try:
            storage.ensure_bucket()
            checks["storage"] = "ok"
        except Exception as exc:
            checks["storage"] = f"error: {exc}"
        ready = all(value == "ok" for value in checks.values())
        return JSONResponse(status_code=200 if ready else 503, content={"status": "ok" if ready else "degraded", "checks": checks})

    @app.get("/metrics", response_class=PlainTextResponse)
    def metrics(session: Session = Depends(get_session)):
        """手写 Prometheus 文本：请求计数/耗时与任务队列深度。"""
        lines = [
            "# HELP http_requests_total HTTP requests by method/path/status",
            "# TYPE http_requests_total counter",
        ]
        for (method, path, status), count in sorted(_request_counts.items()):
            lines.append(f'http_requests_total{{method="{method}",path="{path}",status="{status}"}} {count}')
        lines += [
            "# HELP http_request_duration_ms_sum Total request duration in milliseconds",
            "# TYPE http_request_duration_ms_sum counter",
        ]
        for (method, path), total in sorted(_request_duration_sum_ms.items()):
            lines.append(f'http_request_duration_ms_sum{{method="{method}",path="{path}"}} {total}')
        lines += [
            "# HELP http_request_duration_ms_count Request count for duration aggregation",
            "# TYPE http_request_duration_ms_count counter",
        ]
        for (method, path), count in sorted(_request_duration_count.items()):
            lines.append(f'http_request_duration_ms_count{{method="{method}",path="{path}"}} {count}')
        lines += [
            "# HELP jobs_queue_depth Background jobs by status",
            "# TYPE jobs_queue_depth gauge",
        ]
        rows = session.execute(select(Job.status, func.count(Job.id)).group_by(Job.status)).all()
        depths = {status: count for status, count in rows}
        for status in _JOB_STATUS_KEYS:
            lines.append(f'jobs_queue_depth{{status="{status}"}} {depths.get(status, 0)}')
        # 中文注释：库侧持久化 gauge（重启不丢），补强进程内计数的观测缺口
        lines += [
            "# HELP objects_total Objects by status (from database)",
            "# TYPE objects_total gauge",
        ]
        obj_rows = session.execute(
            select(ObjectRecord.status, func.count(ObjectRecord.id)).group_by(ObjectRecord.status)
        ).all()
        for status, count in sorted(obj_rows):
            lines.append(f'objects_total{{status="{status}"}} {count}')
        document_count = session.scalar(select(func.count(Document.id)).where(Document.deleted_at.is_(None))) or 0
        trash_documents = session.scalar(
            select(func.count(Document.id)).where(Document.deleted_at.is_not(None), Document.purged_at.is_(None))
        ) or 0
        trash_objects = session.scalar(
            select(func.count(ObjectRecord.id)).where(ObjectRecord.deleted_at.is_not(None), ObjectRecord.purged_at.is_(None))
        ) or 0
        lines += [
            "# HELP documents_total Non-deleted documents (from database)",
            "# TYPE documents_total gauge",
            f"documents_total {document_count}",
            "# HELP trash_items Soft-deleted items awaiting purge (from database)",
            "# TYPE trash_items gauge",
            f'trash_items{{kind="document"}} {trash_documents}',
            f'trash_items{{kind="object"}} {trash_objects}',
        ]
        return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4; charset=utf-8")

    @app.post("/api/v1/uploads", status_code=201)
    def create_upload(
        payload: UploadCreate,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
        storage: MinioStorage = Depends(get_storage),
        settings: Settings = Depends(get_settings),
    ):
        tenant_id = auth.tenant_id
        if payload.expected_size > settings.max_object_bytes:
            raise HTTPException(422, "超过对象大小上限")
        fingerprint = request_fingerprint(payload)
        # 中文注释：内容去重——声明哈希且开启 dedup 时，命中同租户同哈希同大小的 ready 对象直接复用，不存新字节
        if payload.dedup and payload.sha256 and payload.purpose == "standalone":
            existing = session.scalar(
                select(ObjectRecord).where(
                    ObjectRecord.tenant_id == tenant_id,
                    ObjectRecord.purpose == "standalone",
                    ObjectRecord.status == "ready",
                    ObjectRecord.sha256 == payload.sha256.lower(),
                    ObjectRecord.size_bytes == payload.expected_size,
                ).limit(1)
            )
            if existing is not None:
                session.commit()
                return {
                    "upload_id": None, "object_id": existing.id, "status": "ready",
                    "upload_url": None, "deduped": True,
                }
        upload = session.scalar(
            select(UploadSession).where(UploadSession.tenant_id == tenant_id, UploadSession.idempotency_key == idempotency_key)
        )
        if upload is None:
            object_id = str(uuid4())
            upload_id = str(uuid4())
            candidate = ObjectRecord(
                id=object_id,
                tenant_id=tenant_id,
                purpose=payload.purpose,
                bucket=settings.minio_bucket,
                object_key=f"objects/{tenant_id}/{object_id}",
                display_name=payload.display_name,
                content_type=payload.content_type,
                status="pending",
            )
            session.add(candidate)
            session.flush()
            insert_ignore(
                session, UploadSession,
                {
                    "id": upload_id, "tenant_id": tenant_id, "object_id": object_id,
                    "staging_key": f"staging/{tenant_id}/{upload_id}",
                    "idempotency_key": idempotency_key, "expected_size": payload.expected_size,
                    "declared_sha256": payload.sha256, "request_fingerprint": fingerprint,
                    "expires_at": utcnow() + timedelta(seconds=settings.upload_url_ttl_seconds),
                },
                ["tenant_id", "idempotency_key"],
            )
            upload = session.scalar(
                select(UploadSession).where(UploadSession.tenant_id == tenant_id, UploadSession.idempotency_key == idempotency_key)
            )
            if upload.object_id != object_id:
                session.delete(candidate)
                session.flush()
        obj = session.get(ObjectRecord, upload.object_id)
        # 中文注释：幂等冲突以请求指纹为准；旧数据无指纹时回退字段比对
        if upload.request_fingerprint and upload.request_fingerprint != fingerprint:
            raise HTTPException(409, "幂等键已用于不同请求")
        if not upload.request_fingerprint and (obj.display_name, obj.content_type, obj.purpose, upload.expected_size) != (
            payload.display_name, payload.content_type, payload.purpose, payload.expected_size
        ):
            raise HTTPException(409, "幂等键已用于不同请求")
        bind_tags(session, tenant_id, obj.id, "object", payload)
        if obj.status == "ready":
            session.commit()
            return {"upload_id": upload.id, "object_id": obj.id, "status": "ready", "upload_url": None}
        if ensure_aware(upload.expires_at) <= utcnow():
            raise HTTPException(409, "上传会话已过期")
        remaining = max(1, int((ensure_aware(upload.expires_at) - utcnow()).total_seconds()))
        url = storage.upload_url(upload.staging_key, min(settings.upload_url_ttl_seconds, remaining))
        session.commit()
        return {"upload_id": upload.id, "object_id": obj.id, "status": obj.status, "upload_url": url, "expires_at": upload.expires_at}

    @app.post("/api/v1/uploads/{upload_id}/complete")
    def complete_upload(
        upload_id: str,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
        storage: MinioStorage = Depends(get_storage),
    ):
        tenant_id = auth.tenant_id
        upload = session.scalar(
            select(UploadSession).where(UploadSession.id == upload_id, UploadSession.tenant_id == tenant_id).with_for_update()
        )
        if upload is None:
            raise HTTPException(404, "上传会话不存在")
        obj = require_object(session, tenant_id, upload.object_id, lock=True)
        if obj.status == "ready":
            return object_data(session, obj)
        if obj.status != "pending":
            raise HTTPException(409, "对象状态不允许完成上传")
        if ensure_aware(upload.expires_at) <= utcnow():
            raise HTTPException(409, "上传会话已过期")
        try:
            staging_size = storage.size(upload.staging_key)
        except ObjectMissing as exc:
            raise HTTPException(409, "暂存对象尚未上传") from exc
        if staging_size != upload.expected_size:
            raise HTTPException(422, "上传大小与声明不符")
        # 中文注释：流式晋级（边读边写边算 SHA-256）；声明不符则回滚，不产生正式对象
        try:
            size, digest, final_type = promote_staging(
                storage, upload.staging_key, obj.object_key,
                expected_size=upload.expected_size, expected_sha256=upload.declared_sha256,
                content_type=obj.content_type,
            )
        except ContentMismatch as exc:
            raise HTTPException(422, "上传内容与声明不符") from exc
        obj.size_bytes = size
        obj.sha256 = digest
        # 中文注释：嗅探后的最终媒体类型落库（伪装活动内容会被降级为 octet-stream）
        obj.content_type = final_type
        obj.status = "ready"
        obj.ready_at = utcnow()
        upload.completed_at = obj.ready_at
        upload.last_copy_error = None
        # 中文注释：成功后删除暂存对象，避免 staging 与正式副本双份占用
        try:
            storage.remove(upload.staging_key)
        except ObjectMissing:
            pass
        append_outbox(
            session, tenant_id=tenant_id, event_kind="object.created",
            target_type="object", target_id=obj.id, actor_id=auth.actor_id,
            payload={"display_name": obj.display_name, "size_bytes": size, "sha256": digest, "purpose": obj.purpose},
        )
        session.commit()
        return object_data(session, obj)

    @app.get("/api/v1/objects")
    def list_objects(
        q: str | None = None,
        tag: str | None = None,
        tag_ids: list[str] = Query(default=[]),
        tag_mode: TagMode = "all",
        bucket: str | None = None,
        name_prefix: str | None = None,
        content_type: str | None = None,
        content_type_prefix: str | None = None,
        ready_from: datetime | None = None,
        ready_to: datetime | None = None,
        min_size: int | None = Query(default=None, ge=0),
        max_size: int | None = Query(default=None, ge=0),
        sha256: str | None = Query(default=None, pattern="^[0-9a-fA-F]{64}$"),
        sort: Literal["newest", "oldest", "name_asc", "name_desc"] = "newest",
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        query = select(ObjectRecord).where(
            ObjectRecord.tenant_id == tenant_id,
            ObjectRecord.purpose == "standalone",
            ObjectRecord.status == "ready",
        )
        tag_filter = filtered_target_ids(session, tenant_id, "object", tag, tag_ids, tag_mode)
        if tag_filter is not None:
            query = query.where(ObjectRecord.id.in_(tag_filter))
        if q:
            # 中文注释：模糊搜索显示名；% 需转义防止通配注入
            escaped_q = q.strip().replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped_q}%"
            query = query.where(ObjectRecord.display_name.like(pattern, escape="\\"))
        if name_prefix:
            query = query.where(ObjectRecord.display_name.startswith(name_prefix, autoescape=True))
        if bucket:
            query = query.where(ObjectRecord.bucket == bucket)
        if content_type:
            query = query.where(ObjectRecord.content_type == content_type)
        if content_type_prefix:
            query = query.where(ObjectRecord.content_type.startswith(content_type_prefix, autoescape=True))
        if sha256:
            query = query.where(ObjectRecord.sha256 == sha256.lower())
        if ready_from:
            query = query.where(ObjectRecord.ready_at >= ready_from)
        if ready_to:
            query = query.where(ObjectRecord.ready_at < ready_to)
        if min_size is not None:
            query = query.where(ObjectRecord.size_bytes >= min_size)
        if max_size is not None:
            query = query.where(ObjectRecord.size_bytes <= max_size)
        sort_field, ascending = {
            "newest": ("created_at", False),
            "oldest": ("created_at", True),
            "name_asc": ("display_name", True),
            "name_desc": ("display_name", False),
        }[sort]
        query = apply_cursor(
            query, ObjectRecord, session, tenant_id, cursor,
            sort_field=sort_field, ascending=ascending,
        )
        rows = session.scalars(
            query.order_by(*order_by_sort(ObjectRecord, sort_field=sort_field, ascending=ascending)).limit(limit + 1)
        ).all()
        return {"items": [object_data(session, row) for row in rows[:limit]], "next_cursor": rows[limit - 1].id if len(rows) > limit else None}

    @app.get("/api/v1/objects/{object_id}")
    def get_object(object_id: str, tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        obj = require_object(session, tenant_id, object_id)
        if obj.purpose != "standalone":
            raise HTTPException(403, "文档内部对象需通过文档访问")
        return object_data(session, obj)

    @app.post("/api/v1/objects/{object_id}/download-url")
    def object_download_url(
        object_id: str,
        payload: DownloadUrlInput | None = None,
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
        storage: MinioStorage = Depends(get_storage),
        settings: Settings = Depends(get_settings),
    ):
        obj = require_object(session, tenant_id, object_id)
        if obj.status != "ready":
            raise HTTPException(409, "对象尚未就绪")
        if obj.purpose != "standalone":
            # 中文注释：文档内部对象必须携带文档上下文，与 GET /objects/{id} 的 403 语义一致
            if payload is None or not payload.document_id:
                raise HTTPException(403, "文档内部对象需通过文档接口访问")
            document = require_document(session, tenant_id, payload.document_id)
            if not document_references_object(session, document, obj.id, payload.version_no):
                raise HTTPException(404, "对象未被该文档引用")
        ttl = _resolve_download_ttl(payload, settings)
        inline = bool(payload and payload.disposition == "inline")
        # 中文注释：带上 content_type，签名时覆盖响应头，保证预览 iframe 能识别 PDF/图片
        return {"url": storage.download_url(obj.object_key, ttl, inline=inline, content_type=obj.content_type), "expires_in": ttl}

    @app.delete("/api/v1/objects/{object_id}", status_code=202)
    def delete_object(
        object_id: str,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id
        obj = require_object(session, tenant_id, object_id, lock=True)
        if obj.purpose != "standalone":
            raise HTTPException(403, "文档内部对象不能直接删除")
        if has_document_reference(session, obj):
            raise HTTPException(409, "对象被文档版本引用")

        def _run() -> tuple[int, dict | None]:
            if obj.status == "deleted":
                # 中文注释：已删对象幂等返回 204
                return 204, None
            if obj.status == "deleting":
                # 中文注释：删除任务卡死/丢失时重建 job，避免对象永久停留在 deleting
                active = session.scalar(
                    select(Job.id).where(
                        Job.kind == "delete_object", Job.target_id == obj.id,
                        Job.status.in_(["pending", "running", "failed"]),
                    ).limit(1)
                )
                if active is None:
                    policy = load_retention_policy(session, tenant_id)
                    purge_at = purge_after_from_now(tenant_id, policy, kind="object")
                    session.add(Job(
                        id=str(uuid4()), tenant_id=tenant_id, kind="delete_object", target_id=obj.id,
                        status="pending", next_run_at=purge_at or utcnow(),
                    ))
                return 202, {"status": "deleting", "purge_after": obj.purge_after}
            if obj.status != "ready":
                raise HTTPException(409, "对象状态不允许删除")
            policy = load_retention_policy(session, tenant_id)
            purge_at = purge_after_from_now(tenant_id, policy, kind="object")
            obj.status = "deleting"
            obj.deleted_at = utcnow()
            obj.deleted_reason = "user_delete"
            obj.purge_after = purge_at
            # 中文注释：带恢复窗口——purge_after 前可 restore；窗口为 0 则立即排队永久删除
            session.add(Job(
                id=str(uuid4()), tenant_id=tenant_id, kind="delete_object", target_id=obj.id,
                status="pending", next_run_at=purge_at or utcnow(),
            ))
            append_outbox(
                session, tenant_id=tenant_id, event_kind="object.deleted",
                target_type="object", target_id=obj.id, actor_id=auth.actor_id,
                payload={"object_key": obj.object_key, "deleted_reason": "user_delete", "purge_after": purge_at.isoformat() if purge_at else None},
            )
            return 202, {"status": "deleting", "purge_after": purge_at}

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="delete_object", fingerprint=object_id, run=_run,
        )

    @app.post("/api/v1/objects/{object_id}/restore")
    def restore_object(
        object_id: str,
        payload: RestoreInput | None = None,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        """恢复软删对象；永久删除后不可恢复。"""
        obj = require_object(session, tenant_id=auth.tenant_id, object_id=object_id, lock=True)
        if obj.purpose != "standalone":
            raise HTTPException(403, "文档内部对象需通过文档恢复")
        if obj.status not in {"deleting", "deleted"}:
            raise HTTPException(409, "对象未处于删除状态")
        if obj.status == "deleted" or obj.purged_at is not None:
            raise HTTPException(409, "对象已永久删除，不可恢复")
        # 中文注释：purge_after 为 None 表示策略窗口为 0 天——无恢复窗口
        if obj.purge_after is None:
            raise HTTPException(409, "无恢复窗口，不可恢复")
        if ensure_aware(obj.purge_after) <= utcnow():
            raise HTTPException(409, "对象已超过恢复窗口")
        obj.status = "ready"
        obj.deleted_at = None
        obj.deleted_reason = None
        obj.purge_after = None
        # 中文注释：取消待执行的字节删除任务
        session.execute(
            delete(Job).where(
                Job.kind == "delete_object", Job.target_id == obj.id,
                Job.status.in_(["pending", "failed"]),
            )
        )
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="object.restored",
            target_type="object", target_id=obj.id, actor_id=auth.actor_id,
            payload={"reason": payload.reason if payload else None},
        )
        session.commit()
        return object_data(session, obj)

    @app.get("/api/v1/stats/overview")
    def object_stats(tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        count, size = session.execute(
            select(func.count(ObjectRecord.id), func.coalesce(func.sum(ObjectRecord.size_bytes), 0)).where(
                ObjectRecord.tenant_id == tenant_id, ObjectRecord.status == "ready"
            )
        ).one()
        return {"object_count": count, "logical_bytes": size, "as_of": utcnow()}

    @app.get("/api/v1/stats/buckets")
    def bucket_stats(tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        rows = session.execute(
            select(ObjectRecord.bucket, func.count(ObjectRecord.id), func.coalesce(func.sum(ObjectRecord.size_bytes), 0))
            .where(ObjectRecord.tenant_id == tenant_id, ObjectRecord.status == "ready")
            .group_by(ObjectRecord.bucket)
        ).all()
        return {"items": [{"bucket": bucket, "object_count": count, "logical_bytes": size} for bucket, count, size in rows], "as_of": utcnow()}

    @app.get("/api/v1/stats/daily")
    def daily_stats(
        days: int = Query(default=30, ge=1, le=366),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        start = (utcnow() - timedelta(days=days - 1)).date()
        created = session.execute(
            select(func.date(ObjectRecord.ready_at), func.count(ObjectRecord.id))
            .where(ObjectRecord.tenant_id == tenant_id, ObjectRecord.ready_at.is_not(None), func.date(ObjectRecord.ready_at) >= str(start))
            .group_by(func.date(ObjectRecord.ready_at))
        ).all()
        deleted = session.execute(
            select(func.date(ObjectRecord.deleted_at), func.count(ObjectRecord.id))
            .where(ObjectRecord.tenant_id == tenant_id, ObjectRecord.deleted_at.is_not(None), func.date(ObjectRecord.deleted_at) >= str(start))
            .group_by(func.date(ObjectRecord.deleted_at))
        ).all()
        totals: dict[str, dict] = {}
        for day, count in created:
            totals[str(day)] = {"day": str(day), "created_count": count, "deleted_count": 0}
        for day, count in deleted:
            totals.setdefault(str(day), {"day": str(day), "created_count": 0, "deleted_count": 0})["deleted_count"] = count
        return {"items": [totals[day] for day in sorted(totals)], "as_of": utcnow()}

    @app.get("/api/v1/tags")
    def list_tags(
        q: str = "", tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)
    ):
        query = select(Tag).where(Tag.tenant_id == tenant_id, Tag.active)
        if q.strip():
            _, prefix = normalize_name(q)
            query = query.where(Tag.normalized_name.startswith(prefix, autoescape=True))
        rows = session.scalars(query.order_by(Tag.name).limit(50)).all()
        return {"items": [{"id": tag.id, "name": tag.name} for tag in rows]}

    @app.post("/api/v1/objects/{object_id}/tags")
    def add_object_tags(
        object_id: str,
        payload: TagInput,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id
        obj = require_object(session, tenant_id, object_id)
        if obj.purpose != "standalone" or obj.status != "ready":
            raise HTTPException(403, "对象不允许直接编辑标签")

        def _run() -> tuple[int, dict]:
            tags = bind_tags(session, tenant_id, object_id, "object", payload)
            append_outbox(
                session, tenant_id=tenant_id, event_kind="object.tags_updated",
                target_type="object", target_id=object_id, actor_id=auth.actor_id,
                payload={"tag_ids": payload.tag_ids, "new_tag_names": payload.new_tag_names},
            )
            return 200, {"items": tags}

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="add_object_tags", fingerprint=request_fingerprint(payload), run=_run,
        )

    @app.delete("/api/v1/objects/{object_id}/tags/{tag_id}", status_code=204)
    def remove_object_tag(
        object_id: str,
        tag_id: str,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id
        obj = require_object(session, tenant_id, object_id)
        if obj.purpose != "standalone":
            raise HTTPException(403, "对象不允许直接编辑标签")

        def _run() -> tuple[int, None]:
            relation = session.get(ObjectTag, (tenant_id, object_id, tag_id))
            if relation:
                session.delete(relation)
            append_outbox(
                session, tenant_id=tenant_id, event_kind="object.tag_removed",
                target_type="object", target_id=object_id, actor_id=auth.actor_id,
                payload={"tag_id": tag_id},
            )
            return 204, None

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="remove_object_tag", fingerprint=f"{object_id}:{tag_id}", run=_run,
        )

    @app.get("/api/v1/document-types")
    def document_types(_tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        rows = session.scalars(select(DocumentType).where(DocumentType.active).order_by(DocumentType.code)).all()
        return {"items": [{"code": item.code, "display_name": item.display_name, "schema_version": item.schema_version} for item in rows]}

    @app.post("/api/v1/ingest-sessions", status_code=201)
    def create_ingest(
        payload: IngestCreate,
        tenant_id: str = Depends(admin_tenant_id),
        session: Session = Depends(get_session),
        storage: MinioStorage = Depends(get_storage),
        settings: Settings = Depends(get_settings),
    ):
        doc_type = session.get(DocumentType, payload.doc_type)
        if doc_type is None or not doc_type.active:
            raise HTTPException(422, "文档类型无效或已停用")
        for part in payload.parts:
            if part.expected_size > settings.max_object_bytes:
                raise HTTPException(422, f"分片 {part.display_name} 超过对象大小上限")
        fingerprint = request_fingerprint(payload)
        # 中文注释：身份槽位仲裁——软删占用中拒绝重采集；已清除则让出槽位后新建。
        # 历史数据可能有多行同 external_id，取最新一行裁决，避免 scalar 撞多行。
        holders = session.scalars(
            select(Document).where(
                Document.tenant_id == tenant_id,
                Document.source == payload.source,
                Document.external_id == payload.external_id,
            ).order_by(Document.created_at.desc()).with_for_update()
        ).all()
        if any(row.deleted_at is not None and row.purged_at is None for row in holders):
            raise HTTPException(409, "文档在回收站，请先恢复或永久删除后再采集")
        for row in holders:
            if row.purged_at is not None:
                release_document_identity(row)
        if holders:
            session.flush()
        insert_ignore(
            session, Document,
            {
                "id": str(uuid4()), "tenant_id": tenant_id, "source": payload.source,
                "external_id": payload.external_id, "doc_type": payload.doc_type,
                "title": payload.title, "attrs_jsonb": payload.attrs,
            },
            ["tenant_id", "source", "external_id"],
        )
        document = session.scalar(
            select(Document).where(
                Document.tenant_id == tenant_id, Document.source == payload.source, Document.external_id == payload.external_id
            ).order_by(Document.created_at.desc()).limit(1).with_for_update()
        )
        if document.doc_type != payload.doc_type:
            raise HTTPException(409, "已有文档类型不同，请走重分类流程")
        version = session.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == document.id, DocumentVersion.ingest_key == payload.ingest_key)
        )
        if version is not None:
            # 中文注释：同 ingest_key 重放——指纹一致返回 200，不一致 409
            if version.request_fingerprint and version.request_fingerprint != fingerprint:
                raise HTTPException(409, "ingest_key 已用于不同请求")
            body = _ingest_session_body(session, version, document, storage=storage, settings=settings)
            return JSONResponse(status_code=200, content=jsonable_encoder(body))
        next_no = session.scalar(
            select(func.coalesce(func.max(DocumentVersion.version_no), 0) + 1).where(DocumentVersion.document_id == document.id)
        )
        version = DocumentVersion(
            id=str(uuid4()), tenant_id=tenant_id, document_id=document.id,
            version_no=next_no, ingest_key=payload.ingest_key, status="staging",
            doc_type_snapshot=payload.doc_type, type_schema_version=doc_type.schema_version,
            request_fingerprint=fingerprint,
        )
        session.add(version)
        session.flush()
        uploads: list[dict] = []
        plan_parts: list[dict] = []
        for index, part in enumerate(payload.parts):
            object_id = str(uuid4())
            upload_id = str(uuid4())
            staging_key = f"staging/{tenant_id}/{upload_id}"
            session.add(ObjectRecord(
                id=object_id, tenant_id=tenant_id, purpose="document_internal",
                bucket=settings.minio_bucket, object_key=f"objects/{tenant_id}/{object_id}",
                display_name=part.display_name, content_type=part.content_type, status="pending",
            ))
            expires_at = utcnow() + timedelta(seconds=settings.upload_url_ttl_seconds)
            session.add(UploadSession(
                id=upload_id, tenant_id=tenant_id, object_id=object_id, staging_key=staging_key,
                idempotency_key=f"ingest:{version.id}:{index}", expected_size=part.expected_size,
                declared_sha256=part.sha256, request_fingerprint=fingerprint, expires_at=expires_at,
            ))
            entry = {
                "part_index": index, "role": part.role, "ordinal": part.ordinal,
                "reference_name": part.reference_name, "object_id": object_id, "upload_id": upload_id,
                "display_name": part.display_name, "content_type": part.content_type,
                "expected_size": part.expected_size,
            }
            plan_parts.append(entry)
            uploads.append({**entry, "upload_url": storage.upload_url(staging_key, settings.upload_url_ttl_seconds), "expires_at": expires_at})
        version.upload_plan = {"parts": plan_parts} if plan_parts else None
        bind_tags(session, tenant_id, document.id, "document", payload)
        session.commit()
        body = {
            "ingest_session_id": version.id, "document_id": document.id,
            "version_no": version.version_no, "status": version.status,
        }
        if uploads:
            body["uploads"] = uploads
        return JSONResponse(status_code=201, content=jsonable_encoder(body))

    @app.post("/api/v1/ingest-sessions/{version_id}/complete")
    def complete_ingest(
        version_id: str, payload: IngestComplete, tenant_id: str = Depends(admin_tenant_id), session: Session = Depends(get_session)
    ):
        version = session.scalar(select(DocumentVersion).where(DocumentVersion.id == version_id, DocumentVersion.tenant_id == tenant_id))
        if version is None:
            raise HTTPException(404, "采集会话不存在")
        document = require_document(session, tenant_id, version.document_id, lock=True)
        version = session.scalar(select(DocumentVersion).where(DocumentVersion.id == version_id).with_for_update())
        if version.status == "ready":
            return document_data(session, document)
        if version.status != "staging":
            raise HTTPException(409, "版本状态不允许发布")
        ids = {item for item in [payload.raw_object_id, payload.body_object_id] if item}
        ids.update(item.object_id for item in payload.assets)
        if not ids:
            raise HTTPException(422, "版本至少需要一个原文、正文或附件对象")
        asset_keys = [(item.role, item.ordinal) for item in payload.assets]
        if len(asset_keys) != len(set(asset_keys)):
            raise HTTPException(422, "附件角色与顺序重复")
        for object_id in sorted(ids):
            obj = require_object(session, tenant_id, object_id, lock=True)
            if obj.status != "ready" or obj.purpose != "document_internal":
                raise HTTPException(409, "版本引用了未就绪或非文档对象")
        version.raw_object_id = payload.raw_object_id
        version.body_object_id = payload.body_object_id
        version.attrs = payload.attrs
        version.status = "ready"
        version.published_at = utcnow()
        for item in payload.assets:
            session.add(DocumentAsset(
                id=str(uuid4()), tenant_id=tenant_id, version_id=version.id, object_id=item.object_id,
                role=item.role, ordinal=item.ordinal, reference_name=item.reference_name,
            ))
        current = session.get(DocumentVersion, document.current_version_id) if document.current_version_id else None
        if current is None or version.version_no > current.version_no:
            document.current_version_id = version.id
        append_outbox(
            session, tenant_id=tenant_id, event_kind="document.version_published",
            target_type="document", target_id=document.id,
            payload={"version_id": version.id, "version_no": version.version_no, "doc_type": version.doc_type_snapshot},
        )
        # 中文注释：发布后按保留策略裁剪历史版本（keep_all 时 Worker 内跳过）
        session.add(Job(
            id=str(uuid4()), tenant_id=tenant_id, kind="prune_versions",
            target_id=document.id, status="pending",
        ))
        session.commit()
        return document_data(session, document)

    @app.get("/api/v1/documents")
    def list_documents(
        q: str | None = None,
        tag: str | None = None,
        tag_ids: list[str] = Query(default=[]),
        tag_mode: TagMode = "all",
        doc_type: str | None = None,
        source: str | None = None,
        external_id: str | None = None,
        created_from: datetime | None = None,
        created_to: datetime | None = None,
        sort: Literal["newest", "oldest", "title_asc", "title_desc"] = "newest",
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        query = select(Document).where(
            Document.tenant_id == tenant_id,
            Document.current_version_id.is_not(None),
            Document.deleted_at.is_(None),
        )
        tag_filter = filtered_target_ids(session, tenant_id, "document", tag, tag_ids, tag_mode)
        if tag_filter is not None:
            query = query.where(Document.id.in_(tag_filter))
        if q:
            # 中文注释：标题/来源/外部 ID 模糊搜索；转义通配符防止注入
            escaped_q = q.strip().replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped_q}%"
            query = query.where(or_(
                Document.title.like(pattern, escape="\\"),
                Document.source.like(pattern, escape="\\"),
                Document.external_id.like(pattern, escape="\\"),
            ))
        if doc_type:
            query = query.where(Document.doc_type == doc_type)
        if source:
            query = query.where(Document.source == source)
        if external_id:
            query = query.where(Document.external_id == external_id)
        if created_from:
            query = query.where(Document.created_at >= created_from)
        if created_to:
            query = query.where(Document.created_at < created_to)
        sort_field, ascending = {
            "newest": ("created_at", False),
            "oldest": ("created_at", True),
            "title_asc": ("title", True),
            "title_desc": ("title", False),
        }[sort]
        query = apply_cursor(
            query, Document, session, tenant_id, cursor,
            sort_field=sort_field, ascending=ascending,
        )
        rows = session.scalars(
            query.order_by(*order_by_sort(Document, sort_field=sort_field, ascending=ascending)).limit(limit + 1)
        ).all()
        return {"items": [document_data(session, row, include_current=False) for row in rows[:limit]], "next_cursor": rows[limit - 1].id if len(rows) > limit else None}

    @app.get("/api/v1/documents/{document_id}")
    def get_document(document_id: str, tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        document = require_document(session, tenant_id, document_id)
        if document.current_version_id is None:
            raise HTTPException(404, "文档尚未发布")
        return document_data(session, document)

    @app.post("/api/v1/documents/{document_id}/reclassify")
    def reclassify_document(
        document_id: str,
        payload: ReclassifyInput,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id

        def _run() -> tuple[int, dict]:
            # 中文注释：校验必须放在幂等边界之内——重放时不得因状态已变化而误判 409
            new_type = session.get(DocumentType, payload.doc_type)
            if new_type is None or not new_type.active:
                raise HTTPException(422, "文档类型无效或已停用")
            document = require_document(session, tenant_id, document_id, lock=True)
            if document.current_version_id is None:
                raise HTTPException(409, "文档尚未发布")
            if document.doc_type == payload.doc_type:
                raise HTTPException(409, "目标类型与当前类型相同")
            current = session.scalar(select(DocumentVersion).where(DocumentVersion.id == document.current_version_id).with_for_update())
            asset_rows = session.scalars(select(DocumentAsset).where(DocumentAsset.version_id == current.id)).all()
            referenced_ids = {value for value in [current.raw_object_id, current.body_object_id] if value}
            referenced_ids.update(item.object_id for item in asset_rows)
            for object_id in sorted(referenced_ids):
                obj = require_object(session, tenant_id, object_id, lock=True)
                if obj.status != "ready":
                    raise HTTPException(409, "当前版本引用的对象不可用")
            next_no = session.scalar(
                select(func.coalesce(func.max(DocumentVersion.version_no), 0) + 1).where(DocumentVersion.document_id == document.id)
            )
            new_version = DocumentVersion(
                id=str(uuid4()), tenant_id=tenant_id, document_id=document.id,
                version_no=next_no, ingest_key=f"reclassify:{uuid4()}", status="ready",
                raw_object_id=current.raw_object_id, body_object_id=current.body_object_id,
                doc_type_snapshot=payload.doc_type, type_schema_version=new_type.schema_version,
                attrs=payload.attrs if "attrs" in payload.model_fields_set else current.attrs,
                published_at=utcnow(),
            )
            session.add(new_version)
            session.flush()
            for item in asset_rows:
                session.add(DocumentAsset(
                    id=str(uuid4()), tenant_id=tenant_id, version_id=new_version.id,
                    object_id=item.object_id, role=item.role, ordinal=item.ordinal,
                    reference_name=item.reference_name,
                ))
            old_type = document.doc_type
            document.doc_type = payload.doc_type
            document.current_version_id = new_version.id
            session.add(DocumentTypeChange(
                id=str(uuid4()), tenant_id=tenant_id, document_id=document.id,
                old_type=old_type, new_type=payload.doc_type,
                actor_id=auth.actor_id,
                reason=payload.reason, new_version_id=new_version.id,
            ))
            append_outbox(
                session, tenant_id=tenant_id, event_kind="document.reclassified",
                target_type="document", target_id=document.id, actor_id=auth.actor_id,
                payload={"old_type": old_type, "new_type": payload.doc_type, "reason": payload.reason, "new_version_id": new_version.id},
            )
            return 200, document_data(session, document)

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="reclassify", fingerprint=request_fingerprint(payload), run=_run,
        )

    @app.get("/api/v1/documents/{document_id}/versions")
    def list_versions(
        document_id: str,
        cursor: int | None = Query(default=None, ge=1),
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        require_document(session, tenant_id, document_id)
        # 中文注释：软删版本（status=deleted）一并返回，前端据此展示「已删除」与恢复入口
        query = select(DocumentVersion).where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.status.in_(["ready", "deleted"]),
        )
        if cursor is not None:
            # 中文注释：按 version_no 降序游标，下一页取严格小于当前游标的版本
            query = query.where(DocumentVersion.version_no < cursor)
        rows = session.scalars(query.order_by(DocumentVersion.version_no.desc()).limit(limit + 1)).all()
        return {
            "items": [version_data(session, row) for row in rows[:limit]],
            "next_cursor": rows[limit - 1].version_no if len(rows) > limit else None,
        }

    @app.get("/api/v1/documents/{document_id}/versions/{version_no}")
    def get_version(document_id: str, version_no: int, tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        require_document(session, tenant_id, document_id)
        version = session.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document_id,
                DocumentVersion.version_no == version_no,
                DocumentVersion.status.in_(["ready", "deleted"]),
            )
        )
        if version is None:
            raise HTTPException(404, "版本不存在")
        return version_data(session, version)

    @app.post("/api/v1/documents/{document_id}/versions/{version_no}/objects/{object_id}/download-url")
    def document_object_download_url(
        document_id: str,
        version_no: int,
        object_id: str,
        payload: DownloadUrlInput | None = None,
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
        storage: MinioStorage = Depends(get_storage),
        settings: Settings = Depends(get_settings),
    ):
        # 中文注释：文档内部对象下载主路径；授权上下文即「经该文档该版本访问」
        document = require_document(session, tenant_id, document_id)
        version = session.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id,
                DocumentVersion.version_no == version_no,
                DocumentVersion.status == "ready",
                DocumentVersion.deleted_at.is_(None),
            )
        )
        if version is None:
            raise HTTPException(404, "版本不存在")
        obj = require_object(session, tenant_id, object_id)
        if obj.status != "ready":
            raise HTTPException(409, "对象尚未就绪")
        if not version_references_object(session, version, obj.id):
            raise HTTPException(404, "对象未被该版本引用")
        ttl = _resolve_download_ttl(payload, settings)
        inline = bool(payload and payload.disposition == "inline")
        # 中文注释：同上，覆盖响应头媒体类型，PDF/图片才能内联渲染
        return {"url": storage.download_url(obj.object_key, ttl, inline=inline, content_type=obj.content_type), "expires_in": ttl}

    @app.post("/api/v1/documents/{document_id}/tags")
    def add_document_tags(
        document_id: str,
        payload: TagInput,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id
        require_document(session, tenant_id, document_id)

        def _run() -> tuple[int, dict]:
            tags = bind_tags(session, tenant_id, document_id, "document", payload)
            append_outbox(
                session, tenant_id=tenant_id, event_kind="document.tags_updated",
                target_type="document", target_id=document_id, actor_id=auth.actor_id,
                payload={"tag_ids": payload.tag_ids, "new_tag_names": payload.new_tag_names},
            )
            return 200, {"items": tags}

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="add_document_tags", fingerprint=request_fingerprint(payload), run=_run,
        )

    @app.delete("/api/v1/documents/{document_id}/tags/{tag_id}", status_code=204)
    def remove_document_tag(
        document_id: str,
        tag_id: str,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id
        require_document(session, tenant_id, document_id)

        def _run() -> tuple[int, None]:
            relation = session.get(DocumentTag, (tenant_id, document_id, tag_id))
            if relation:
                session.delete(relation)
            append_outbox(
                session, tenant_id=tenant_id, event_kind="document.tag_removed",
                target_type="document", target_id=document_id, actor_id=auth.actor_id,
                payload={"tag_id": tag_id},
            )
            return 204, None

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="remove_document_tag", fingerprint=f"{document_id}:{tag_id}", run=_run,
        )

    @app.get("/api/v1/document-stats/overview")
    def document_stats(tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        document_count = session.scalar(
            select(func.count(Document.id)).where(
                Document.tenant_id == tenant_id, Document.current_version_id.is_not(None), Document.deleted_at.is_(None)
            )
        )
        version_count = session.scalar(
            select(func.count(DocumentVersion.id)).where(
                DocumentVersion.tenant_id == tenant_id,
                DocumentVersion.status == "ready",
                DocumentVersion.deleted_at.is_(None),
            )
        )
        asset_count = session.scalar(select(func.count(DocumentAsset.id)).where(DocumentAsset.tenant_id == tenant_id))
        return {"document_count": document_count, "version_count": version_count, "asset_count": asset_count, "as_of": utcnow()}

    # —— 阶段 3：后台任务 / 版本与文档删除 / 审计 / 保留策略 / 对账 / 导出 ——

    @app.get("/api/v1/jobs")
    def list_jobs(
        status: str | None = None,
        kind: str | None = None,
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        query = select(Job).where(Job.tenant_id == tenant_id)
        if status:
            query = query.where(Job.status == status)
        if kind:
            query = query.where(Job.kind == kind)
        query = apply_cursor(query, Job, session, tenant_id, cursor)
        rows = session.scalars(query.order_by(Job.created_at.desc(), Job.id.desc()).limit(limit + 1)).all()
        return {
            "items": [
                {
                    "id": row.id, "kind": row.kind, "target_id": row.target_id, "status": row.status,
                    "attempts": row.attempts, "last_error": row.last_error, "next_run_at": row.next_run_at,
                    "claimed_at": row.claimed_at, "created_at": row.created_at,
                }
                for row in rows[:limit]
            ],
            "next_cursor": rows[limit - 1].id if len(rows) > limit else None,
        }

    @app.post("/api/v1/jobs/{job_id}/retry")
    def retry_job(
        job_id: str,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        job = session.scalar(select(Job).where(Job.id == job_id, Job.tenant_id == auth.tenant_id).with_for_update())
        if job is None:
            raise HTTPException(404, "任务不存在")
        if job.status not in {"failed", "dead"}:
            raise HTTPException(409, "仅 failed/dead 任务可复活")
        job.status = "pending"
        job.attempts = 0
        job.next_run_at = utcnow()
        job.last_error = None
        job.claimed_at = None
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="job.retried",
            target_type="job", target_id=job.id, actor_id=auth.actor_id,
            payload={"kind": job.kind, "target_id": job.target_id},
        )
        session.commit()
        return {"id": job.id, "status": job.status}

    @app.delete("/api/v1/documents/{document_id}/versions/{version_no}", status_code=202)
    def delete_document_version(
        document_id: str,
        version_no: int,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id

        def _run() -> tuple[int, dict]:
            document = require_document(session, tenant_id, document_id, lock=True)
            # 中文注释：当前版本指针受保护，需先发布更高版本或删除文档
            current = session.get(DocumentVersion, document.current_version_id) if document.current_version_id else None
            if current is not None and current.version_no == version_no:
                raise HTTPException(409, "不能删除当前版本")
            version = session.scalar(
                select(DocumentVersion).where(
                    DocumentVersion.document_id == document.id,
                    DocumentVersion.version_no == version_no,
                    DocumentVersion.status == "ready",
                    DocumentVersion.deleted_at.is_(None),
                ).with_for_update()
            )
            if version is None:
                raise HTTPException(404, "版本不存在")
            policy = load_retention_policy(session, tenant_id)
            purge_at = purge_after_from_now(tenant_id, policy, kind="document")
            version.status = "deleted"
            version.deleted_at = utcnow()
            version.purge_after = purge_at
            # 中文注释：保留 DocumentAsset 行以支持恢复；到期由 purge_version 清理
            session.add(Job(
                id=str(uuid4()), tenant_id=tenant_id, kind="purge_version",
                target_id=version.id, status="pending", next_run_at=purge_at or utcnow(),
            ))
            append_outbox(
                session, tenant_id=tenant_id, event_kind="document.version_deleted",
                target_type="document", target_id=document.id, actor_id=auth.actor_id,
                payload={"version_id": version.id, "version_no": version_no, "purge_after": purge_at.isoformat() if purge_at else None},
            )
            return 202, {"status": "version_deleted", "version_no": version_no, "purge_after": purge_at}

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="delete_document_version", fingerprint=f"{document_id}:{version_no}", run=_run,
        )

    @app.post("/api/v1/documents/{document_id}/versions/{version_no}/restore")
    def restore_document_version(
        document_id: str,
        version_no: int,
        payload: RestoreInput | None = None,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        """恢复软删版本；永久清除后不可恢复。"""
        document = require_document(session, auth.tenant_id, document_id, lock=True)
        version = session.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id,
                DocumentVersion.version_no == version_no,
                DocumentVersion.status == "deleted",
            ).with_for_update()
        )
        if version is None:
            raise HTTPException(404, "版本不存在或未删除")
        if version.purged_at is not None:
            raise HTTPException(409, "版本已永久删除，不可恢复")
        # 中文注释：purge_after 为 None 表示策略窗口为 0 天——无恢复窗口
        if version.purge_after is None:
            raise HTTPException(409, "无恢复窗口，不可恢复")
        if ensure_aware(version.purge_after) <= utcnow():
            raise HTTPException(409, "版本已超过恢复窗口")
        version.status = "ready"
        version.deleted_at = None
        version.purge_after = None
        session.execute(
            delete(Job).where(Job.kind == "purge_version", Job.target_id == version.id, Job.status.in_(["pending", "failed"]))
        )
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="document.version_restored",
            target_type="document", target_id=document.id, actor_id=auth.actor_id,
            payload={"version_id": version.id, "version_no": version_no},
        )
        session.commit()
        return version_data(session, version)

    @app.delete("/api/v1/documents/{document_id}", status_code=202)
    def delete_document(
        document_id: str,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id

        def _run() -> tuple[int, dict]:
            # 中文注释：软删进回收站，保留版本与附件关系，窗口内可恢复
            document = require_document(session, tenant_id, document_id, lock=True, allow_deleted=True)
            if document.deleted_at is not None:
                return 204, None
            staging = session.scalar(
                select(DocumentVersion.id).where(
                    DocumentVersion.document_id == document.id, DocumentVersion.status == "staging"
                ).limit(1)
            )
            if staging:
                raise HTTPException(409, "存在未发布版本，请先完成或等待其过期")
            policy = load_retention_policy(session, tenant_id)
            purge_at = purge_after_from_now(tenant_id, policy, kind="document")
            document.deleted_at = utcnow()
            document.purge_after = purge_at
            job_id = str(uuid4())
            session.add(Job(
                id=job_id, tenant_id=tenant_id, kind="purge_document", target_id=document.id,
                status="pending", next_run_at=purge_at or utcnow(),
            ))
            append_outbox(
                session, tenant_id=tenant_id, event_kind="document.deleted",
                target_type="document", target_id=document.id, actor_id=auth.actor_id,
                payload={"purge_after": purge_at.isoformat() if purge_at else None, "recoverable": purge_at is not None},
            )
            return 202, {"status": "deleted", "job_id": job_id, "purge_after": purge_at}

        return idempotent_write(
            session, tenant_id=tenant_id, idempotency_key=idempotency_key,
            endpoint="delete_document", fingerprint=document_id, run=_run,
        )

    @app.post("/api/v1/documents/{document_id}/restore")
    def restore_document(
        document_id: str,
        payload: RestoreInput | None = None,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        """恢复软删文档；永久清除后不可恢复。"""
        document = require_document(session, auth.tenant_id, document_id, lock=True, allow_deleted=True)
        if document.deleted_at is None:
            raise HTTPException(409, "文档未删除")
        if document.purged_at is not None:
            raise HTTPException(409, "文档已永久删除，不可恢复")
        # 中文注释：purge_after 为 None 表示策略窗口为 0 天——无恢复窗口
        if document.purge_after is None:
            raise HTTPException(409, "无恢复窗口，不可恢复")
        if ensure_aware(document.purge_after) <= utcnow():
            raise HTTPException(409, "文档已超过恢复窗口")
        document.deleted_at = None
        document.purge_after = None
        session.execute(
            delete(Job).where(Job.kind == "purge_document", Job.target_id == document.id, Job.status.in_(["pending", "failed"]))
        )
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="document.restored",
            target_type="document", target_id=document.id, actor_id=auth.actor_id,
            payload={"reason": payload.reason if payload else None},
        )
        session.commit()
        return document_data(session, document)

    @app.get("/api/v1/trash/documents")
    def list_trash_documents(
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        """回收站：软删且尚未永久清除的文档列表。"""
        query = select(Document).where(
            Document.tenant_id == tenant_id,
            Document.deleted_at.is_not(None),
            Document.purged_at.is_(None),
        )
        query = apply_cursor(query, Document, session, tenant_id, cursor, sort_field="deleted_at", ascending=False)
        rows = session.scalars(query.order_by(Document.deleted_at.desc(), Document.id.desc()).limit(limit + 1)).all()
        items = []
        for row in rows[:limit]:
            items.append(document_data(session, row, include_current=False))
        return {"items": items, "next_cursor": rows[limit - 1].id if len(rows) > limit else None}

    @app.delete("/api/v1/trash/documents/{document_id}", status_code=202)
    def purge_document_now(
        document_id: str,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        """立即永久删除软删文档（跳过恢复窗口）。"""
        document = require_document(session, auth.tenant_id, document_id, lock=True, allow_deleted=True)
        if document.deleted_at is None:
            raise HTTPException(409, "文档未处于回收站")
        if document.purged_at is not None:
            raise HTTPException(409, "文档已永久删除")
        job_id = str(uuid4())
        session.add(Job(id=job_id, tenant_id=auth.tenant_id, kind="purge_document", target_id=document.id, status="pending", next_run_at=utcnow()))
        # 中文注释：把窗口压到立即执行
        document.purge_after = utcnow()
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="document.purge_requested",
            target_type="document", target_id=document.id, actor_id=auth.actor_id,
        )
        session.commit()
        return {"status": "purging", "job_id": job_id}

    @app.get("/api/v1/trash/objects")
    def list_trash_objects(
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        """回收站：软删且未永久清除的独立对象列表。"""
        query = select(ObjectRecord).where(
            ObjectRecord.tenant_id == tenant_id,
            ObjectRecord.purpose == "standalone",
            ObjectRecord.deleted_at.is_not(None),
            ObjectRecord.purged_at.is_(None),
        )
        query = apply_cursor(query, ObjectRecord, session, tenant_id, cursor, sort_field="deleted_at", ascending=False)
        rows = session.scalars(query.order_by(ObjectRecord.deleted_at.desc(), ObjectRecord.id.desc()).limit(limit + 1)).all()
        return {
            "items": [object_data(session, row) for row in rows[:limit]],
            "next_cursor": rows[limit - 1].id if len(rows) > limit else None,
        }

    @app.delete("/api/v1/trash/objects/{object_id}", status_code=202)
    def purge_object_now(
        object_id: str,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        """立即永久删除软删对象（跳过恢复窗口，字节排队清除）。"""
        obj = require_object(session, tenant_id=auth.tenant_id, object_id=object_id, lock=True)
        if obj.purpose != "standalone":
            raise HTTPException(403, "文档内部对象由文档清除流程处理")
        if obj.purged_at is not None or obj.status == "deleted":
            raise HTTPException(409, "对象已永久删除")
        if obj.deleted_at is None:
            raise HTTPException(409, "对象未处于回收站")
        job_id = str(uuid4())
        obj.purge_after = utcnow()
        session.add(Job(
            id=job_id, tenant_id=auth.tenant_id, kind="delete_object",
            target_id=obj.id, status="pending", next_run_at=utcnow(),
        ))
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="object.purge_requested",
            target_type="object", target_id=obj.id, actor_id=auth.actor_id,
        )
        session.commit()
        return {"status": "purging", "job_id": job_id}

    @app.get("/api/v1/audit/type-changes")
    def audit_type_changes(
        document_id: str | None = None,
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        query = select(DocumentTypeChange).where(DocumentTypeChange.tenant_id == tenant_id)
        if document_id:
            query = query.where(DocumentTypeChange.document_id == document_id)
        query = apply_cursor(query, DocumentTypeChange, session, tenant_id, cursor, time_field="changed_at")
        rows = session.scalars(
            query.order_by(DocumentTypeChange.changed_at.desc(), DocumentTypeChange.id.desc()).limit(limit + 1)
        ).all()
        return {
            "items": [
                {
                    "id": row.id, "document_id": row.document_id, "old_type": row.old_type, "new_type": row.new_type,
                    "actor_id": row.actor_id, "reason": row.reason, "changed_at": row.changed_at, "new_version_id": row.new_version_id,
                }
                for row in rows[:limit]
            ],
            "next_cursor": rows[limit - 1].id if len(rows) > limit else None,
        }

    @app.get("/api/v1/audit/events")
    def audit_events(
        event_kind: str | None = None,
        target_id: str | None = None,
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        query = select(OutboxEvent).where(OutboxEvent.tenant_id == tenant_id)
        if event_kind:
            query = query.where(OutboxEvent.event_kind == event_kind)
        if target_id:
            query = query.where(OutboxEvent.target_id == target_id)
        query = apply_cursor(query, OutboxEvent, session, tenant_id, cursor)
        rows = session.scalars(query.order_by(OutboxEvent.created_at.desc(), OutboxEvent.id.desc()).limit(limit + 1)).all()
        return {
            "items": [
                {
                    "id": row.id, "event_kind": row.event_kind, "target_type": row.target_type, "target_id": row.target_id,
                    "actor_id": row.actor_id, "payload": row.payload, "created_at": row.created_at,
                }
                for row in rows[:limit]
            ],
            "next_cursor": rows[limit - 1].id if len(rows) > limit else None,
        }

    @app.get("/api/v1/retention-policy")
    def get_retention_policy(tenant_id: str = Depends(tenant_from_auth), session: Session = Depends(get_session)):
        policy = load_retention_policy(session, tenant_id)
        return {**policy, "note": RETENTION_NOTE}

    @app.put("/api/v1/retention-policy")
    def put_retention_policy(
        payload: RetentionPolicyInput,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        tenant_id = auth.tenant_id
        row = session.get(TenantSettings, tenant_id)
        data = payload.model_dump()
        if row is None:
            session.add(TenantSettings(tenant_id=tenant_id, settings_json=data))
        else:
            row.settings_json = data
        append_outbox(
            session, tenant_id=tenant_id, event_kind="retention_policy.updated",
            target_type="settings", target_id=tenant_id, actor_id=auth.actor_id,
            payload=data,
        )
        session.commit()
        return {**load_retention_policy(session, tenant_id), "note": RETENTION_NOTE}

    @app.post("/api/v1/ops/reconcile", status_code=202)
    def trigger_reconcile(
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        job_id = str(uuid4())
        session.add(Job(id=job_id, tenant_id=auth.tenant_id, kind="reconcile", target_id=auth.tenant_id, status="pending"))
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="ops.reconcile_requested",
            target_type="job", target_id=job_id, actor_id=auth.actor_id,
        )
        session.commit()
        return {"job_id": job_id, "status": "pending"}

    @app.get("/api/v1/stats/export.csv")
    def export_stats_csv(
        view: Literal["overview", "buckets", "daily"] = "overview",
        days: int = Query(default=30, ge=1, le=366),
        tenant_id: str = Depends(tenant_from_auth),
        session: Session = Depends(get_session),
    ):
        rows: list[list] = []
        if view == "overview":
            count, size = session.execute(
                select(func.count(ObjectRecord.id), func.coalesce(func.sum(ObjectRecord.size_bytes), 0)).where(
                    ObjectRecord.tenant_id == tenant_id, ObjectRecord.status == "ready"
                )
            ).one()
            rows = [["object_count", "logical_bytes"], [count, size]]
        elif view == "buckets":
            data = session.execute(
                select(ObjectRecord.bucket, func.count(ObjectRecord.id), func.coalesce(func.sum(ObjectRecord.size_bytes), 0))
                .where(ObjectRecord.tenant_id == tenant_id, ObjectRecord.status == "ready")
                .group_by(ObjectRecord.bucket)
            ).all()
            rows = [["bucket", "object_count", "logical_bytes"], *[[b, c, s] for b, c, s in data]]
        else:
            start = (utcnow() - timedelta(days=days - 1)).date()
            created = dict(session.execute(
                select(func.date(ObjectRecord.ready_at), func.count(ObjectRecord.id))
                .where(ObjectRecord.tenant_id == tenant_id, ObjectRecord.ready_at.is_not(None), func.date(ObjectRecord.ready_at) >= str(start))
                .group_by(func.date(ObjectRecord.ready_at))
            ).all())
            deleted = dict(session.execute(
                select(func.date(ObjectRecord.deleted_at), func.count(ObjectRecord.id))
                .where(ObjectRecord.tenant_id == tenant_id, ObjectRecord.deleted_at.is_not(None), func.date(ObjectRecord.deleted_at) >= str(start))
                .group_by(func.date(ObjectRecord.deleted_at))
            ).all())
            days_list = sorted({*created.keys(), *deleted.keys()})
            rows = [["day", "created_count", "deleted_count"], *[[str(d), created.get(d, 0), deleted.get(d, 0)] for d in days_list]]
        # 中文注释：UTF-8 BOM 便于 Excel 直接打开
        import csv
        import io

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerows(rows)
        return Response(
            content="﻿" + buffer.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="stats-{view}.csv"'},
        )

    # —— 登录会话 / 用户管理 ——

    @app.post("/api/v1/auth/login")
    def auth_login(
        payload: LoginInput,
        session: Session = Depends(get_session),
        settings: Settings = Depends(get_settings),
    ):
        """用户名密码登录，签发 Bearer 会话 token（仅此一次返回明文）。"""
        user = session.scalar(select(User).where(User.username == payload.username, User.active))
        if user is None or not _verify_password(payload.password, user.password_hash):
            raise HTTPException(401, "用户名或密码错误")
        token = secrets.token_urlsafe(32)
        session_row = UserSession(
            id=str(uuid4()), user_id=user.id, tenant_id=user.tenant_id,
            token_hash=_session_token_hash(token),
            expires_at=utcnow() + timedelta(hours=12),
        )
        session.add(session_row)
        append_outbox(
            session, tenant_id=user.tenant_id, event_kind="auth.login",
            target_type="user", target_id=user.id, actor_id=user.username,
        )
        session.commit()
        return {
            "token": token, "token_type": "Bearer",
            "expires_in": 12 * 3600,
            "user": {"id": user.id, "username": user.username, "tenant_id": user.tenant_id, "role": user.role},
        }

    @app.post("/api/v1/auth/logout")
    def auth_logout(auth: AuthContext = Depends(auth_context), session: Session = Depends(get_session)):
        if auth.api_key_id.startswith("user:"):
            user_id = auth.api_key_id.split(":", 1)[1]
            session.execute(
                update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
                .values(revoked_at=utcnow())
            )
            session.commit()
        return {"status": "ok"}

    @app.get("/api/v1/auth/me")
    def auth_me(auth: AuthContext = Depends(auth_context)):
        return {"tenant_id": auth.tenant_id, "actor_id": auth.actor_id, "role": auth.role}

    @app.post("/api/v1/users", status_code=201)
    def create_user(
        payload: UserCreateInput,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        existing = session.scalar(select(User).where(User.tenant_id == auth.tenant_id, User.username == payload.username))
        if existing is not None:
            raise HTTPException(409, "用户名已存在")
        user = User(
            id=str(uuid4()), tenant_id=auth.tenant_id, username=payload.username,
            password_hash=_hash_password(payload.password), role=payload.role,
        )
        session.add(user)
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="user.created",
            target_type="user", target_id=user.id, actor_id=auth.actor_id,
            payload={"username": payload.username, "role": payload.role},
        )
        session.commit()
        return {"id": user.id, "username": user.username, "role": user.role}

    @app.get("/api/v1/users")
    def list_users(auth: AuthContext = Depends(require_admin), session: Session = Depends(get_session)):
        rows = session.scalars(select(User).where(User.tenant_id == auth.tenant_id).order_by(User.username)).all()
        return {
            "items": [
                {"id": row.id, "username": row.username, "role": row.role, "active": row.active, "created_at": row.created_at}
                for row in rows
            ]
        }

    # —— 分享链接 ——

    @app.post("/api/v1/share-links", status_code=201)
    def create_share_link(
        payload: ShareLinkCreate,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
        settings: Settings = Depends(get_settings),
    ):
        if payload.target_type == "document":
            require_document(session, auth.tenant_id, payload.target_id)
        else:
            obj = require_object(session, auth.tenant_id, payload.target_id)
            if obj.purpose != "standalone":
                raise HTTPException(403, "文档内部对象请直接分享所在文档")
            # 中文注释：软删/已清除对象不可新建分享，避免生成必然 404 的死链
            if obj.deleted_at is not None or obj.purged_at is not None or obj.status != "ready":
                raise HTTPException(409, "对象已删除或未就绪，不可分享")
        token = secrets.token_urlsafe(24)
        link = ShareLink(
            id=str(uuid4()), tenant_id=auth.tenant_id, token=token,
            target_type=payload.target_type, target_id=payload.target_id,
            permission=payload.permission, created_by=auth.actor_id,
            expires_at=utcnow() + timedelta(seconds=payload.expires_in_seconds),
        )
        session.add(link)
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="share_link.created",
            target_type=payload.target_type, target_id=payload.target_id, actor_id=auth.actor_id,
            payload={"share_link_id": link.id, "permission": payload.permission, "expires_at": link.expires_at.isoformat()},
        )
        session.commit()
        return {
            "id": link.id, "token": link.token, "permission": link.permission,
            "expires_at": link.expires_at,
            "url": f"{settings.public_base_url.rstrip('/')}/share/{link.token}",
        }

    @app.get("/api/v1/share-links")
    def list_share_links(auth: AuthContext = Depends(auth_context), session: Session = Depends(get_session)):
        rows = session.scalars(
            select(ShareLink).where(ShareLink.tenant_id == auth.tenant_id).order_by(ShareLink.created_at.desc())
        ).all()
        return {
            "items": [
                {
                    "id": row.id, "token": row.token, "target_type": row.target_type, "target_id": row.target_id,
                    "permission": row.permission, "created_by": row.created_by, "created_at": row.created_at,
                    "expires_at": row.expires_at, "revoked_at": row.revoked_at,
                    "last_accessed_at": row.last_accessed_at,
                }
                for row in rows
            ]
        }

    @app.delete("/api/v1/share-links/{link_id}", status_code=204)
    def revoke_share_link(
        link_id: str,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        link = session.scalar(select(ShareLink).where(ShareLink.id == link_id, ShareLink.tenant_id == auth.tenant_id))
        if link is None:
            raise HTTPException(404, "分享链接不存在")
        if link.revoked_at is None:
            link.revoked_at = utcnow()
            append_outbox(
                session, tenant_id=auth.tenant_id, event_kind="share_link.revoked",
                target_type=link.target_type, target_id=link.target_id, actor_id=auth.actor_id,
                payload={"share_link_id": link.id},
            )
            session.commit()
        return Response(status_code=204)

    @app.get("/api/v1/public/share/{token}")
    def public_share_meta(token: str, session: Session = Depends(get_session)):
        """公开入口：按 token 取分享元信息（无需 API Key）。"""
        link = session.scalar(select(ShareLink).where(ShareLink.token == token))
        if link is None or link.revoked_at is not None or ensure_aware(link.expires_at) <= utcnow():
            raise HTTPException(404, "分享链接无效或已过期")
        link.last_accessed_at = utcnow()
        session.commit()
        if link.target_type == "document":
            document = session.scalar(
                select(Document).where(Document.id == link.target_id, Document.deleted_at.is_(None))
            )
            if document is None:
                raise HTTPException(404, "分享内容已删除")
            return {
                "target_type": "document", "permission": link.permission,
                "title": document.title, "doc_type": document.doc_type,
                "created_at": document.created_at, "expires_at": link.expires_at,
            }
        obj = session.scalar(select(ObjectRecord).where(ObjectRecord.id == link.target_id, ObjectRecord.status == "ready"))
        if obj is None:
            raise HTTPException(404, "分享内容已删除")
        return {
            "target_type": "object", "permission": link.permission,
            "display_name": obj.display_name, "content_type": obj.content_type,
            "size_bytes": obj.size_bytes, "expires_at": link.expires_at,
        }

    @app.post("/api/v1/public/share/{token}/download-url")
    def public_share_download(
        token: str,
        session: Session = Depends(get_session),
        storage: MinioStorage = Depends(get_storage),
        settings: Settings = Depends(get_settings),
    ):
        link = session.scalar(select(ShareLink).where(ShareLink.token == token))
        if link is None or link.revoked_at is not None or ensure_aware(link.expires_at) <= utcnow():
            raise HTTPException(404, "分享链接无效或已过期")
        if link.permission != "download":
            raise HTTPException(403, "该分享链接仅可查看")
        ttl = min(settings.download_url_ttl_seconds, 300)
        if link.target_type == "document":
            document = session.scalar(
                select(Document).where(Document.id == link.target_id, Document.deleted_at.is_(None))
            )
            if document is None or document.current_version_id is None:
                raise HTTPException(404, "分享内容已删除")
            version = session.get(DocumentVersion, document.current_version_id)
            if version is None or version.raw_object_id is None:
                raise HTTPException(404, "无可下载对象")
            obj = session.get(ObjectRecord, version.raw_object_id)
        else:
            obj = session.scalar(select(ObjectRecord).where(ObjectRecord.id == link.target_id, ObjectRecord.status == "ready"))
        if obj is None or obj.status != "ready":
            raise HTTPException(404, "分享内容已删除")
        link.last_accessed_at = utcnow()
        session.commit()
        return {
            "url": storage.download_url(obj.object_key, ttl, inline=False, content_type=obj.content_type),
            "expires_in": ttl, "display_name": obj.display_name,
        }

    # —— 批量操作 ——

    @app.post("/api/v1/documents/bulk-tag")
    def bulk_tag_documents(
        payload: BulkTagInput,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        results = []
        for target_id in payload.target_ids:
            try:
                require_document(session, auth.tenant_id, target_id)
                tags = bind_tags(session, auth.tenant_id, target_id, "document", payload)
                results.append({"id": target_id, "status": "ok", "tags": tags})
            except HTTPException as exc:
                results.append({"id": target_id, "status": "error", "message": str(exc.detail)})
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="document.bulk_tagged",
            target_type="document", target_id="bulk", actor_id=auth.actor_id,
            payload={"count": len(payload.target_ids), "tag_ids": payload.tag_ids, "new_tag_names": payload.new_tag_names},
        )
        session.commit()
        return {"items": results}

    @app.post("/api/v1/documents/bulk-delete", status_code=202)
    def bulk_delete_documents(
        payload: BulkDeleteInput,
        auth: AuthContext = Depends(require_admin),
        session: Session = Depends(get_session),
    ):
        results = []
        for target_id in payload.target_ids:
            try:
                document = require_document(session, auth.tenant_id, target_id, lock=True)
                # 中文注释：与单删对齐——存在未发布版本时拒绝，避免留下 staging 悬挂
                staging = session.scalar(
                    select(DocumentVersion.id).where(
                        DocumentVersion.document_id == document.id, DocumentVersion.status == "staging"
                    ).limit(1)
                )
                if staging:
                    raise HTTPException(409, "存在未发布版本，请先完成或等待其过期")
                policy = load_retention_policy(session, auth.tenant_id)
                purge_at = purge_after_from_now(auth.tenant_id, policy, kind="document")
                document.deleted_at = utcnow()
                document.purge_after = purge_at
                session.add(Job(
                    id=str(uuid4()), tenant_id=auth.tenant_id, kind="purge_document",
                    target_id=document.id, status="pending", next_run_at=purge_at or utcnow(),
                ))
                results.append({"id": target_id, "status": "deleted", "purge_after": purge_at})
            except HTTPException as exc:
                results.append({"id": target_id, "status": "error", "message": str(exc.detail)})
        append_outbox(
            session, tenant_id=auth.tenant_id, event_kind="document.bulk_deleted",
            target_type="document", target_id="bulk", actor_id=auth.actor_id,
            payload={"count": len(payload.target_ids)},
        )
        session.commit()
        return {"items": results}

    return app


app = create_app()
