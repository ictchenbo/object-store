from collections.abc import Generator
from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.config import get_settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ensure_aware(value: datetime) -> datetime:
    """SQLite 可能返回 naive datetime；统一按 UTC 处理。"""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


class Base(DeclarativeBase):
    pass


class ObjectRecord(Base):
    __tablename__ = "objects"
    __table_args__ = (
        UniqueConstraint("tenant_id", "id"),
        UniqueConstraint("bucket", "object_key"),
        Index("ix_objects_tenant_status_ready", "tenant_id", "status", "ready_at", "id"),
        # 中文注释：内容哈希索引，支撑按哈希查找/去重发现
        Index("ix_objects_tenant_sha256", "tenant_id", "sha256"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100), index=True)
    purpose: Mapped[str] = mapped_column(String(32), default="standalone")
    bucket: Mapped[str] = mapped_column(String(100))
    object_key: Mapped[str] = mapped_column(String(300))
    display_name: Mapped[str] = mapped_column(String(255))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    # 中文注释：服务端流式计算得到的 SHA-256（十六进制小写），晋级成功后落库
    sha256: Mapped[str | None] = mapped_column(String(64))
    content_type: Mapped[str] = mapped_column(String(150))
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：删除原因（user_delete / orphan / purge / manual），供审计与对账
    deleted_reason: Mapped[str | None] = mapped_column(String(32))
    # 中文注释：软删后字节可永久回收的时间；未到期前可 restore
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：永久清除完成时间；非空表示字节已删，不再可恢复
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UploadSession(Base):
    __tablename__ = "upload_sessions"
    __table_args__ = (UniqueConstraint("tenant_id", "idempotency_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    object_id: Mapped[str] = mapped_column(ForeignKey("objects.id"))
    staging_key: Mapped[str] = mapped_column(String(300))
    idempotency_key: Mapped[str] = mapped_column(String(200))
    expected_size: Mapped[int] = mapped_column(BigInteger)
    # 中文注释：客户端声明的 SHA-256；完成上传时校验，不符则拒绝晋级
    declared_sha256: Mapped[str | None] = mapped_column(String(64))
    # 中文注释：创建请求的 canonical JSON 指纹，用于幂等冲突检测
    request_fingerprint: Mapped[str | None] = mapped_column(String(64))
    # 中文注释：过期后的暂存复制尝试次数与最近错误，驱动重试状态机
    copy_attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_copy_error: Mapped[str | None] = mapped_column(String(1000))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentType(Base):
    __tablename__ = "document_types"

    code: Mapped[str] = mapped_column(String(50), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("tenant_id", "source", "external_id"),
        UniqueConstraint("tenant_id", "id"),
        Index("ix_documents_tenant_type_created", "tenant_id", "doc_type", "created_at", "id"),
        Index("ix_documents_tenant_title", "tenant_id", "title"),
        ForeignKeyConstraint(
            ["id", "current_version_id"],
            ["document_versions.document_id", "document_versions.id"],
            name="fk_document_current_version",
            use_alter=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100), index=True)
    source: Mapped[str] = mapped_column(String(100))
    external_id: Mapped[str] = mapped_column(String(255))
    doc_type: Mapped[str] = mapped_column(String(50), ForeignKey("document_types.code"))
    title: Mapped[str] = mapped_column(String(500))
    attrs: Mapped[dict] = mapped_column("attrs_jsonb", JSON, default=dict)
    current_version_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    # 中文注释：文档软删时间；软删后进入回收站，到期才永久清除
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：软删后可永久清除的时间；未到期前可 restore
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：永久清除完成时间；非空表示字节/版本已清，不再可恢复
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentVersion(Base):
    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint("document_id", "version_no"),
        UniqueConstraint("document_id", "ingest_key"),
        UniqueConstraint("document_id", "id"),
        UniqueConstraint("tenant_id", "id"),
        ForeignKeyConstraint(["tenant_id", "document_id"], ["documents.tenant_id", "documents.id"]),
        ForeignKeyConstraint(["tenant_id", "raw_object_id"], ["objects.tenant_id", "objects.id"]),
        ForeignKeyConstraint(["tenant_id", "body_object_id"], ["objects.tenant_id", "objects.id"]),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    document_id: Mapped[str] = mapped_column(String(36), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    ingest_key: Mapped[str] = mapped_column(String(200))
    # 中文注释：采集创建请求指纹；同 ingest_key 重放时据此判定 200/409
    request_fingerprint: Mapped[str | None] = mapped_column(String(64))
    # 中文注释：parts 一次建齐的上传计划；重放时据此重新签发 upload_url
    upload_plan: Mapped[dict | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="staging")
    raw_object_id: Mapped[str | None] = mapped_column(String(36))
    body_object_id: Mapped[str | None] = mapped_column(String(36))
    doc_type_snapshot: Mapped[str] = mapped_column(String(50), ForeignKey("document_types.code"))
    type_schema_version: Mapped[int] = mapped_column(Integer, default=1)
    attrs: Mapped[dict] = mapped_column("attrs_jsonb", JSON, default=dict)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：版本软删时间；软删后进入回收站，到期才永久清除
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：软删后可永久清除的时间；未到期前可 restore
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 中文注释：永久清除完成时间；非空表示附件关系已清，不再可恢复
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentAsset(Base):
    __tablename__ = "document_assets"
    __table_args__ = (
        UniqueConstraint("version_id", "role", "ordinal"),
        ForeignKeyConstraint(["tenant_id", "version_id"], ["document_versions.tenant_id", "document_versions.id"]),
        ForeignKeyConstraint(["tenant_id", "object_id"], ["objects.tenant_id", "objects.id"]),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    version_id: Mapped[str] = mapped_column(String(36), index=True)
    object_id: Mapped[str] = mapped_column(String(36))
    role: Mapped[str] = mapped_column(String(50))
    ordinal: Mapped[int] = mapped_column(Integer)
    reference_name: Mapped[str | None] = mapped_column(String(255))


def release_document_identity(document: "Document") -> None:
    """永久清除后释放 (source, external_id) 身份槽位，允许同一外部文档重新采集。

    中文注释：documents 唯一约束是 (tenant_id, source, external_id)，软删期间必须继续
    占用（否则恢复会与新文档撞车）；落 purged_at 时改写 external_id 让出槽位，
    原值存 attrs.purged_external_id 供审计。
    """
    from uuid import uuid4

    attrs = dict(document.attrs or {})
    attrs.setdefault("purged_external_id", document.external_id)
    document.attrs = attrs
    document.external_id = f"{document.external_id}#purged-{uuid4().hex[:8]}"


class DocumentTypeChange(Base):
    __tablename__ = "document_type_changes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    document_id: Mapped[str] = mapped_column(String(36), ForeignKey("documents.id"))
    old_type: Mapped[str] = mapped_column(String(50))
    new_type: Mapped[str] = mapped_column(String(50))
    actor_id: Mapped[str] = mapped_column(String(100))
    reason: Mapped[str] = mapped_column(String(500))
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    new_version_id: Mapped[str] = mapped_column(String(36), ForeignKey("document_versions.id"))


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("tenant_id", "normalized_name"),
        UniqueConstraint("tenant_id", "id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(80))
    normalized_name: Mapped[str] = mapped_column(String(80))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ObjectTag(Base):
    __tablename__ = "object_tags"
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "object_id"], ["objects.tenant_id", "objects.id"]),
        ForeignKeyConstraint(["tenant_id", "tag_id"], ["tags.tenant_id", "tags.id"]),
        Index("ix_object_tags_lookup", "tenant_id", "tag_id", "object_id"),
    )

    tenant_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    object_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tag_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DocumentTag(Base):
    __tablename__ = "document_tags"
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "document_id"], ["documents.tenant_id", "documents.id"]),
        ForeignKeyConstraint(["tenant_id", "tag_id"], ["tags.tenant_id", "tags.id"]),
        Index("ix_document_tags_lookup", "tenant_id", "tag_id", "document_id"),
    )

    tenant_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    document_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tag_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Job(Base):
    """后台任务。status: pending / running / failed / done / dead（耗尽重试不再拾取）。"""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(30))
    target_id: Mapped[str] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(1000))
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IdempotencyRecord(Base):
    """通用幂等记录：可选 Idempotency-Key 的写接口用指纹冲突检测与响应重放。"""

    __tablename__ = "idempotency_records"
    __table_args__ = (UniqueConstraint("tenant_id", "idempotency_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    idempotency_key: Mapped[str] = mapped_column(String(200))
    endpoint: Mapped[str] = mapped_column(String(100))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int] = mapped_column(Integer)
    response_body: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OutboxEvent(Base):
    """状态转移事件流水（append-only）。同事务写入，供审计页与未来增量统计。

    不建消费管道：processed_at 预留给未来消费者，当前直接服务审计查询。
    """

    __tablename__ = "outbox_events"
    __table_args__ = (Index("ix_outbox_events_tenant_created", "tenant_id", "created_at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100))
    event_kind: Mapped[str] = mapped_column(String(50))
    target_type: Mapped[str] = mapped_column(String(30))
    target_id: Mapped[str] = mapped_column(String(36))
    actor_id: Mapped[str | None] = mapped_column(String(100))
    payload: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TenantSettings(Base):
    """租户级可配置项；承载保留策略（由 Worker 按策略执行）。"""

    __tablename__ = "tenant_settings"

    tenant_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    settings_json: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class User(Base):
    """控制台登录用户；role: admin（可写）/ viewer（只读）。"""

    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("tenant_id", "username"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100), index=True)
    username: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="viewer")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UserSession(Base):
    """登录会话；token 仅存 SHA-256 摘要，明文只在签发时返回一次。"""

    __tablename__ = "user_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    tenant_id: Mapped[str] = mapped_column(String(100), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ShareLink(Base):
    """文档/对象分享链接；独立实体，可撤销、可过期，权限为 view/download。"""

    __tablename__ = "share_links"
    __table_args__ = (UniqueConstraint("token"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(100), index=True)
    token: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(20))  # document | object
    target_id: Mapped[str] = mapped_column(String(36))
    permission: Mapped[str] = mapped_column(String(20), default="view")  # view | download
    created_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_accessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


@lru_cache
def get_engine():
    return create_engine(get_settings().database_url, pool_pre_ping=True)


def get_session() -> Generator[Session, None, None]:
    session_factory = sessionmaker(bind=get_engine(), expire_on_commit=False)
    with session_factory() as session:
        yield session


def init_database(engine=None) -> None:
    target = engine or get_engine()
    Base.metadata.create_all(target)
    with Session(target) as session:
        for code, name in (
            ("article", "文章"),
            ("paper", "论文"),
            ("report", "报告"),
            ("image_record", "图片记录"),
        ):
            if session.get(DocumentType, code) is None:
                session.add(DocumentType(code=code, display_name=name))
        session.commit()


def run_migrations() -> None:
    """生产启动迁移：PostgreSQL 走 alembic upgrade head，其余（sqlite/演示）退回 create_all。

    中文注释：迁移历史在 migrations/；已用 create_all 建过的存量库可先
    `sh scripts/migrate.sh stamp` 再 upgrade。种子数据（document_types）在迁移后补齐。
    """
    settings = get_settings()
    if settings.database_url.startswith("postgresql"):
        from alembic import command
        from alembic.config import Config

        config = Config("alembic.ini")
        command.upgrade(config, "head")
        # 中文注释：迁移不含种子数据，补齐文档类型
        with Session(get_engine()) as session:
            for code, name in (
                ("article", "文章"),
                ("paper", "论文"),
                ("report", "报告"),
                ("image_record", "图片记录"),
            ):
                if session.get(DocumentType, code) is None:
                    session.add(DocumentType(code=code, display_name=name))
            session.commit()
    else:
        init_database()
