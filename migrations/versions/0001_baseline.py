"""baseline: 12 表（含阶段 2 的 sha256 / 幂等 / 重试列）

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "objects",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False, server_default="standalone"),
        sa.Column("bucket", sa.String(length=100), nullable=False),
        sa.Column("object_key", sa.String(length=300), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("content_type", sa.String(length=150), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("tenant_id", "id", name="uq_objects_tenant_id"),
        sa.UniqueConstraint("bucket", "object_key", name="uq_objects_bucket_key"),
    )
    op.create_index("ix_objects_tenant_id", "objects", ["tenant_id"])
    op.create_index("ix_objects_status", "objects", ["status"])
    op.create_index("ix_objects_tenant_status_ready", "objects", ["tenant_id", "status", "ready_at", "id"])

    op.create_table(
        "document_types",
        sa.Column("code", sa.String(length=50), primary_key=True),
        sa.Column("display_name", sa.String(length=100), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default="1"),
    )

    op.create_table(
        "tags",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("normalized_name", sa.String(length=80), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "normalized_name", name="uq_tags_tenant_normalized"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_tags_tenant_id"),
    )

    op.create_table(
        "upload_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("object_id", sa.String(length=36), nullable=False),
        sa.Column("staging_key", sa.String(length=300), nullable=False),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("expected_size", sa.BigInteger(), nullable=False),
        sa.Column("declared_sha256", sa.String(length=64), nullable=True),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("copy_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_copy_error", sa.String(length=1000), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["object_id"], ["objects.id"]),
        sa.UniqueConstraint("tenant_id", "idempotency_key", name="uq_upload_sessions_tenant_key"),
    )

    # 中文注释：documents 先建（不含循环外键），document_versions 再建，最后补 current_version 约束
    op.create_table(
        "documents",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("external_id", sa.String(length=255), nullable=False),
        sa.Column("doc_type", sa.String(length=50), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("attrs_jsonb", sa.JSON(), nullable=False),
        sa.Column("current_version_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["doc_type"], ["document_types.code"]),
        sa.UniqueConstraint("tenant_id", "source", "external_id", name="uq_documents_tenant_source_ext"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_documents_tenant_id"),
    )
    op.create_index("ix_documents_tenant_id", "documents", ["tenant_id"])
    op.create_index("ix_documents_tenant_type_created", "documents", ["tenant_id", "doc_type", "created_at", "id"])

    op.create_table(
        "document_versions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("ingest_key", sa.String(length=200), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("upload_plan", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="staging"),
        sa.Column("raw_object_id", sa.String(length=36), nullable=True),
        sa.Column("body_object_id", sa.String(length=36), nullable=True),
        sa.Column("doc_type_snapshot", sa.String(length=50), nullable=False),
        sa.Column("type_schema_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("attrs_jsonb", sa.JSON(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id", "document_id"], ["documents.tenant_id", "documents.id"]),
        sa.ForeignKeyConstraint(["tenant_id", "raw_object_id"], ["objects.tenant_id", "objects.id"]),
        sa.ForeignKeyConstraint(["tenant_id", "body_object_id"], ["objects.tenant_id", "objects.id"]),
        sa.ForeignKeyConstraint(["doc_type_snapshot"], ["document_types.code"]),
        sa.UniqueConstraint("document_id", "version_no", name="uq_document_versions_doc_no"),
        sa.UniqueConstraint("document_id", "ingest_key", name="uq_document_versions_doc_key"),
        sa.UniqueConstraint("document_id", "id", name="uq_document_versions_doc_id"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_document_versions_tenant_id"),
    )
    op.create_index("ix_document_versions_document_id", "document_versions", ["document_id"])

    # 中文注释：循环外键延后创建；batch 模式兼容 SQLite（无 ALTER ADD CONSTRAINT）与 PostgreSQL
    with op.batch_alter_table("documents") as batch_op:
        batch_op.create_foreign_key(
            "fk_document_current_version", "document_versions",
            ["id", "current_version_id"], ["document_id", "id"],
        )

    op.create_table(
        "document_assets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("version_id", sa.String(length=36), nullable=False),
        sa.Column("object_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=50), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("reference_name", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id", "version_id"], ["document_versions.tenant_id", "document_versions.id"]),
        sa.ForeignKeyConstraint(["tenant_id", "object_id"], ["objects.tenant_id", "objects.id"]),
        sa.UniqueConstraint("version_id", "role", "ordinal", name="uq_document_assets_role_ordinal"),
    )
    op.create_index("ix_document_assets_version_id", "document_assets", ["version_id"])

    op.create_table(
        "document_type_changes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("old_type", sa.String(length=50), nullable=False),
        sa.Column("new_type", sa.String(length=50), nullable=False),
        sa.Column("actor_id", sa.String(length=100), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("new_version_id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"]),
        sa.ForeignKeyConstraint(["new_version_id"], ["document_versions.id"]),
    )

    op.create_table(
        "object_tags",
        sa.Column("tenant_id", sa.String(length=100), primary_key=True),
        sa.Column("object_id", sa.String(length=36), primary_key=True),
        sa.Column("tag_id", sa.String(length=36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id", "object_id"], ["objects.tenant_id", "objects.id"]),
        sa.ForeignKeyConstraint(["tenant_id", "tag_id"], ["tags.tenant_id", "tags.id"]),
    )
    op.create_index("ix_object_tags_lookup", "object_tags", ["tenant_id", "tag_id", "object_id"])

    op.create_table(
        "document_tags",
        sa.Column("tenant_id", sa.String(length=100), primary_key=True),
        sa.Column("document_id", sa.String(length=36), primary_key=True),
        sa.Column("tag_id", sa.String(length=36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id", "document_id"], ["documents.tenant_id", "documents.id"]),
        sa.ForeignKeyConstraint(["tenant_id", "tag_id"], ["tags.tenant_id", "tags.id"]),
    )
    op.create_index("ix_document_tags_lookup", "document_tags", ["tenant_id", "tag_id", "document_id"])

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(length=1000), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "idempotency_records",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=100), nullable=False),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("endpoint", sa.String(length=100), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("response_status", sa.Integer(), nullable=False),
        sa.Column("response_body", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "idempotency_key", name="uq_idempotency_records_tenant_key"),
    )


def downgrade() -> None:
    op.drop_table("idempotency_records")
    op.drop_table("jobs")
    op.drop_index("ix_document_tags_lookup", table_name="document_tags")
    op.drop_table("document_tags")
    op.drop_index("ix_object_tags_lookup", table_name="object_tags")
    op.drop_table("object_tags")
    op.drop_table("document_type_changes")
    op.drop_index("ix_document_assets_version_id", table_name="document_assets")
    op.drop_table("document_assets")
    with op.batch_alter_table("documents") as batch_op:
        batch_op.drop_constraint("fk_document_current_version", type_="foreignkey")
    op.drop_index("ix_document_versions_document_id", table_name="document_versions")
    op.drop_table("document_versions")
    op.drop_index("ix_documents_tenant_type_created", table_name="documents")
    op.drop_index("ix_documents_tenant_id", table_name="documents")
    op.drop_table("documents")
    op.drop_table("upload_sessions")
    op.drop_table("tags")
    op.drop_table("document_types")
    op.drop_index("ix_objects_tenant_status_ready", table_name="objects")
    op.drop_index("ix_objects_status", table_name="objects")
    op.drop_index("ix_objects_tenant_id", table_name="objects")
    op.drop_table("objects")
