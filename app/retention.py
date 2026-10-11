"""保留策略：读取租户配置并映射到可执行动作。

策略字段（tenant_settings.settings_json，缺省用 DEFAULT_RETENTION_POLICY）：
  orphan_object_grace_hours    孤儿对象就绪后满多少小时才允许回收（须同时无未永久清除引用）
  staging_retry_grace_seconds  上传收尾失败后暂存字节保留秒数
  staging_retry_max_attempts   finalize_upload 最大尝试次数
  version_retention            keep_all | keep_last_n | keep_current_only
  version_retention_n          keep_last_n 时保留的最新版本数
  deleted_object_purge_days    软删后进入回收站的天数（0 = 立即永久删除）
  deleted_document_purge_days  文档软删后可恢复天数（0 = 立即永久删除）

这些值驱动 Worker 实际行为，不再是占位配置。
"""
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.database import TenantSettings, utcnow

DEFAULT_RETENTION_POLICY: dict = {
    "orphan_object_grace_hours": 72,
    "staging_retry_grace_seconds": 86400,
    "staging_retry_max_attempts": 10,
    "version_retention": "keep_all",
    "version_retention_n": 10,
    # 中文注释：默认 7 天恢复窗口——软删可撤销；0 表示立即永久删除（不可恢复）
    "deleted_object_purge_days": 7,
    "deleted_document_purge_days": 7,
}

RETENTION_NOTE = "保留策略由 Worker 执行：软删进入回收站，到期自动永久清除；版本策略由 prune_versions 任务执行。"


def load_retention_policy(session: Session, tenant_id: str) -> dict:
    row = session.get(TenantSettings, tenant_id)
    stored = (row.settings_json or {}) if row else {}
    return {**DEFAULT_RETENTION_POLICY, **stored}


def purge_after_from_now(tenant_id: str, policy: dict, *, kind: str) -> datetime | None:
    """按策略计算 purge_after；返回 None 表示立即永久删除（无恢复窗口）。

    kind: "document" | "object"
    """
    if kind == "document":
        days = int(policy.get("deleted_document_purge_days", 7))
    else:
        days = int(policy.get("deleted_object_purge_days", 7))
    if days <= 0:
        return None
    return utcnow() + timedelta(days=days)


def version_keep_limit(policy: dict) -> int | None:
    """按策略返回应保留的历史版本数；None 表示不限制（keep_all）。"""
    mode = policy.get("version_retention", "keep_all")
    if mode == "keep_all":
        return None
    if mode == "keep_current_only":
        return 1
    return max(1, int(policy.get("version_retention_n", 10)))
