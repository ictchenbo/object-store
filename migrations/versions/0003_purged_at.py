"""永久清除完成标记 purged_at

Revision ID: 0003_purged_at
Revises: 0002_identity_share_retention
Create Date: 2026-10-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_purged_at"
down_revision: str | None = "0002_identity_share_retention"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 中文注释：purged_at 非空表示永久清除已完成，回收站列表据此排除，restore 据此拒绝
    with op.batch_alter_table("objects") as batch_op:
        batch_op.add_column(sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("documents") as batch_op:
        batch_op.add_column(sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("document_versions") as batch_op:
        batch_op.add_column(sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("document_versions") as batch_op:
        batch_op.drop_column("purged_at")
    with op.batch_alter_table("documents") as batch_op:
        batch_op.drop_column("purged_at")
    with op.batch_alter_table("objects") as batch_op:
        batch_op.drop_column("purged_at")
