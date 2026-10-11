import hashlib
import json
from typing import Literal

from pydantic import BaseModel, Field


class TagInput(BaseModel):
    tag_ids: list[str] = Field(default_factory=list, max_length=30)
    new_tag_names: list[str] = Field(default_factory=list, max_length=30)


class UploadCreate(TagInput):
    display_name: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=150)
    # 中文注释：大小上限只由 settings.max_object_bytes 判定，不在 schema 硬编码 1GiB
    expected_size: int = Field(gt=0)
    purpose: Literal["standalone", "document_internal"] = "standalone"
    # 中文注释：可选客户端声明哈希；complete 时服务端流式校验，不符则 422
    sha256: str | None = Field(default=None, pattern="^[0-9a-fA-F]{64}$")
    # 中文注释：声明哈希后可选内容去重——命中同租户同哈希同大小的 ready 对象时直接复用，不再存字节
    dedup: bool = False


class IngestPartInput(BaseModel):
    """采集一次建齐的分片声明；仅创建上传会话，字节仍由客户端直传。"""

    role: Literal["raw", "body", "attachment"] = "attachment"
    display_name: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=150)
    expected_size: int = Field(gt=0)
    sha256: str | None = Field(default=None, pattern="^[0-9a-fA-F]{64}$")
    ordinal: int = Field(default=0, ge=0)
    reference_name: str | None = Field(default=None, max_length=255)


class IngestCreate(TagInput):
    source: str = Field(min_length=1, max_length=100)
    external_id: str = Field(min_length=1, max_length=255)
    doc_type: str = Field(min_length=1, max_length=50)
    title: str = Field(min_length=1, max_length=500)
    ingest_key: str = Field(min_length=1, max_length=200)
    attrs: dict = Field(default_factory=dict)
    # 中文注释：可选；传入则一次建齐上传会话并返回 uploads[]，不传兼容旧两步流
    parts: list[IngestPartInput] = Field(default_factory=list, max_length=100)


class AssetInput(BaseModel):
    object_id: str
    role: Literal["cover", "inline_image", "attachment"]
    ordinal: int = Field(ge=0)
    reference_name: str | None = Field(default=None, max_length=255)


class IngestComplete(BaseModel):
    raw_object_id: str | None = None
    body_object_id: str | None = None
    assets: list[AssetInput] = Field(default_factory=list, max_length=100)
    attrs: dict = Field(default_factory=dict)


class ReclassifyInput(BaseModel):
    doc_type: str = Field(min_length=1, max_length=50)
    reason: str = Field(min_length=1, max_length=500)
    attrs: dict = Field(default_factory=dict)


class DownloadUrlInput(BaseModel):
    # 中文注释：document_internal 对象下载时必须提供文档上下文
    document_id: str | None = Field(default=None, max_length=36)
    version_no: int | None = Field(default=None, ge=1)
    # 中文注释：预览用 inline + 短 TTL；默认保持下载（attachment）语义
    disposition: Literal["inline", "attachment"] = "attachment"
    ttl_seconds: int | None = Field(default=None, ge=30, le=3600)


class RetentionPolicyInput(BaseModel):
    """租户保留策略；由 Worker 实际执行（见 app/retention.py）。"""

    orphan_object_grace_hours: int = Field(default=72, ge=0, le=8760)
    staging_retry_grace_seconds: int = Field(default=86400, ge=0)
    staging_retry_max_attempts: int = Field(default=10, ge=1, le=100)
    version_retention: Literal["keep_all", "keep_last_n", "keep_current_only"] = "keep_all"
    version_retention_n: int = Field(default=10, ge=1, le=1000)
    # 中文注释：0 = 立即永久删除（不可恢复）；>0 = 软删进入回收站，N 天后自动清除
    deleted_object_purge_days: int = Field(default=7, ge=0, le=3650)
    deleted_document_purge_days: int = Field(default=7, ge=0, le=3650)


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserCreateInput(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Literal["admin", "viewer"] = "viewer"


class BulkTagInput(TagInput):
    target_ids: list[str] = Field(min_length=1, max_length=200)


class BulkDeleteInput(BaseModel):
    target_ids: list[str] = Field(min_length=1, max_length=200)


class ShareLinkCreate(BaseModel):
    target_type: Literal["document", "object"]
    target_id: str = Field(min_length=1, max_length=36)
    permission: Literal["view", "download"] = "view"
    expires_in_seconds: int = Field(default=86400, ge=60, le=30 * 86400)


class RestoreInput(BaseModel):
    """恢复软删项；可附带操作备注进审计。"""

    reason: str | None = Field(default=None, max_length=500)


TagMode = Literal["all", "any"]


def request_fingerprint(payload: BaseModel | dict | list | None) -> str:
    """计算请求的 canonical JSON SHA-256 指纹，用于幂等冲突检测。

    键排序 + 紧凑分隔符，保证同一语义请求在不同序列化顺序下指纹一致。
    """
    if isinstance(payload, BaseModel):
        data = payload.model_dump(mode="json")
    else:
        data = payload
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
