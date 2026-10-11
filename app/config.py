import json
import re
from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 中文注释：操作者 ID 允许的字符（可含邮箱风格），用于审计主体标识
ACTOR_ID_PATTERN = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")

# 中文注释：弱凭据特征；生产环境（ENVIRONMENT=prod）与启动脚本都会拒绝
WEAK_SECRET_TOKENS = ("change-me", "dev-key", "minioadmin", "objectstore")


def is_weak_secret(value: str) -> bool:
    lowered = value.lower()
    return any(token in lowered for token in WEAK_SECRET_TOKENS)


def parse_api_keys(raw: str) -> dict[str, tuple[str, str]]:
    """解析 API_KEYS_JSON：值可为租户字符串或 {"tenant_id","actor_id"} 对象。"""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("API_KEYS_JSON 不是有效 JSON") from exc
    if not isinstance(parsed, dict) or not parsed:
        raise ValueError("API_KEYS_JSON 必须是非空对象")
    result: dict[str, tuple[str, str]] = {}
    for key, value in parsed.items():
        if not isinstance(key, str) or not key:
            raise ValueError("API_KEYS_JSON 的键必须是非空字符串")
        if isinstance(value, str):
            if not value:
                raise ValueError("API_KEYS_JSON 的租户值必须是非空字符串")
            result[key] = (value, "tenant-default")
        elif isinstance(value, dict):
            tenant_id = value.get("tenant_id")
            actor_id = value.get("actor_id", "tenant-default")
            if not isinstance(tenant_id, str) or not tenant_id:
                raise ValueError("API_KEYS_JSON 对象形态必须包含非空 tenant_id")
            if not isinstance(actor_id, str) or not ACTOR_ID_PATTERN.match(actor_id):
                raise ValueError("API_KEYS_JSON 的 actor_id 格式无效")
            result[key] = (tenant_id, actor_id)
        else:
            raise ValueError("API_KEYS_JSON 的值必须是字符串或对象")
    return result


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["dev", "prod"] = "dev"
    database_url: str = "postgresql+psycopg2://objectstore:objectstore@localhost:5432/objectstore"
    minio_endpoint: str = "localhost:9000"
    minio_public_endpoint: str = "localhost:9000"
    minio_region: str = "us-east-1"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    minio_bucket: str = "objects"
    api_keys_json: str = '{"dev-key":"demo"}'
    # 中文注释：默认禁止 X-Actor-Id 覆盖审计操作者，防止伪造身份；确需开启须显式配置
    allow_actor_override: bool = False
    upload_url_ttl_seconds: int = 900
    download_url_ttl_seconds: int = 300
    max_object_bytes: int = 1_073_741_824
    # 中文注释：过期上传的暂存复制重试策略（业务默认值，待业务确认）
    staging_retry_max_attempts: int = 10
    staging_retry_grace_seconds: int = 86400
    # 中文注释：孤儿对象回收宽限（业务默认值，待业务确认）
    orphan_object_grace_hours: int = 72
    # 中文注释：后台任务最大尝试次数，超过后标记为 dead 不再拾取
    job_max_attempts: int = 10
    # 中文注释：对账调度间隔与告警出口
    reconcile_interval_seconds: int = 3600
    alert_webhook_url: str | None = None
    reports_dir: str = "var/reports"
    # 中文注释：TLS 由反代（nginx）终止；以下配置供部署编排与文档使用，默认关闭
    tls_enabled: bool = False
    tls_cert_file: str = "certs/fullchain.pem"
    tls_key_file: str = "certs/privkey.pem"
    public_base_url: str = "http://localhost:18000"
    force_https_redirect: bool = False

    @property
    def api_keys(self) -> dict[str, tuple[str, str]]:
        return parse_api_keys(self.api_keys_json)

    @model_validator(mode="after")
    def _reject_weak_secrets_in_prod(self) -> "Settings":
        if self.environment != "prod":
            return self
        secrets_to_check = {"minio_secret_key": self.minio_secret_key}
        for key, (tenant_id, _actor) in self.api_keys.items():
            secrets_to_check[f"api_key({tenant_id})"] = key
        # 中文注释：从数据库连接串中提取密码部分做弱值检查
        if "@" in self.database_url and ":" in self.database_url.rsplit("@", 1)[0]:
            password = self.database_url.rsplit("@", 1)[0].rsplit(":", 1)[-1]
            secrets_to_check["database_url.password"] = password
        weak = [name for name, value in secrets_to_check.items() if is_weak_secret(value) or not value]
        if weak:
            raise ValueError(f"生产环境禁止弱凭据或空值: {', '.join(weak)}")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
