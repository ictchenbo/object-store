"""软删恢复窗口、审计/租户设置、用户会话与分享链接

Revision ID: 0002_identity_share_retention
Revises: 0001_baseline
Create Date: 2026-10-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_identity_share_retention"
down_revision: str | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 中文注释：软删恢复窗口列（0/NULL 语义由应用层保留策略决定）
    with op.batch_alter_table("objects") as batch_op:
        batch_op.add_column(sa.Column("deleted_reason", sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column("purge_after", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_objects_tenant_sha256", "objects", ["tenant_id", "sha256"])

    with op.batch_alter_table("documents") as batch_op:
        batch_op.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("purge_after", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_documents_tenant_title", "documents", ["tenant_id", "title"])

    with op.batch_alter_table("document_versions") as batch_op:
        batch_op.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("purge_after", sa.DateTime(timezone=True), nullable=True))

    # 中文注释：审计事件流水与租户保留策略（0001 漏建，补齐）
    op.create_table(
        "outbox_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("event_kind", sa.String(length=50), nullable=False),
        sa.Column("target_type", sa.String(length=30), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=False),
        sa.Column("actor_id", sa.String(length=100), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_outbox_events_tenant_created", "outbox_events", ["tenant_id", "created_at", "id"])

    op.create_table(
        "tenant_settings",
        sa.Column("tenant_id", sa.String(length=100), primary_key=True),
        sa.Column("settings_json", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 中文注释：控制台用户、登录会话（token 只存哈希）与可撤销分享链接
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False, server_default="viewer"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "username", name="uq_users_tenant_username"),
    )
    op.create_index("ix_users_tenant_id", "users", ["tenant_id"])

    op.create_table(
        "user_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint("token_hash", name="uq_user_sessions_token_hash"),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_tenant_id", "user_sessions", ["tenant_id"])

    op.create_table(
        "share_links",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=False),
        sa.Column("permission", sa.String(length=20), nullable=False, server_default="view"),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token", name="uq_share_links_token"),
    )
    op.create_index("ix_share_links_tenant_id", "share_links", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_share_links_tenant_id", table_name="share_links")
    op.drop_table("share_links")
    op.drop_index("ix_user_sessions_tenant_id", table_name="user_sessions")
    op.drop_index("ix_user_sessions_user_id", table_name="user_sessions")
    op.drop_table("user_sessions")
    op.drop_index("ix_users_tenant_id", table_name="users")
    op.drop_table("users")
    op.drop_table("tenant_settings")
    op.drop_index("ix_outbox_events_tenant_created", table_name="outbox_events")
    op.drop_table("outbox_events")

    with op.batch_alter_table("document_versions") as batch_op:
        batch_op.drop_column("purge_after")
        batch_op.drop_column("deleted_at")
    op.drop_index("ix_documents_tenant_title", table_name="documents")
    with op.batch_alter_table("documents") as batch_op:
        batch_op.drop_column("purge_after")
        batch_op.drop_column("deleted_at")
    op.drop_index("ix_objects_tenant_sha256", table_name="objects")
    with op.batch_alter_table("objects") as batch_op:
        batch_op.drop_column("purge_after")
        batch_op.drop_column("deleted_reason")
