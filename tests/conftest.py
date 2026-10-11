import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import Settings, get_settings
from app.database import get_session, init_database
from app.main import create_app
from app.storage import CHUNK_SIZE, GeneratorStream, ObjectMissing, StorageError, get_storage

# 中文注释：单测默认压掉访问日志噪音；需排查时用 --log-cli-level=INFO
logging.getLogger("app.main").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)


class FakeStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        # 中文注释：记录写入时的媒体类型，便于断言 promote_staging 会落 content_type
        self.content_types: dict[str, str | None] = {}
        self.fail_ensure_bucket = False

    def ensure_bucket(self) -> None:
        if self.fail_ensure_bucket:
            raise StorageError("bucket unavailable")

    def upload_url(self, key: str, _ttl: int) -> str:
        return f"fake://upload/{key}"

    def download_url(self, key: str, _ttl: int, *, inline: bool = False, content_type: str | None = None) -> str:
        # 中文注释：把 content_type 回显进假 URL，单测可断言签名侧确实带上了它
        parts = []
        if inline:
            parts.append("inline=1")
        if content_type:
            parts.append(f"type={content_type}")
        suffix = ("?" + "&".join(parts)) if parts else ""
        return f"fake://download/{key}{suffix}"

    def size(self, key: str) -> int:
        if key not in self.objects:
            raise ObjectMissing(key)
        return len(self.objects[key])

    def copy(self, source_key: str, target_key: str) -> None:
        if source_key not in self.objects:
            raise ObjectMissing(source_key)
        self.objects[target_key] = self.objects[source_key]
        self.content_types[target_key] = self.content_types.get(source_key)

    def iter_object(self, key: str, chunk_size: int = 1_048_576):
        if key not in self.objects:
            raise ObjectMissing(key)
        data = self.objects[key]
        for start in range(0, len(data), chunk_size):
            yield data[start:start + chunk_size]

    def put_stream(self, key: str, stream, length: int, content_type: str | None = None) -> None:
        # 中文注释：与真实 MinioStorage 一致，经 GeneratorStream 以 read() 消费，
        # 确保单测覆盖 minio SDK 的 file-like 契约，而不是直接 join 裸生成器
        adapter = GeneratorStream(stream)
        buffer = b""
        while True:
            chunk = adapter.read(CHUNK_SIZE)
            if not chunk:
                break
            buffer += chunk
        if len(buffer) != length:
            raise StorageError(f"写入长度不符: {len(buffer)} != {length}")
        self.objects[key] = buffer
        self.content_types[key] = content_type

    def list_keys(self, prefix: str) -> list[tuple[str, int]]:
        return [(key, len(data)) for key, data in self.objects.items() if key.startswith(prefix)]

    def remove(self, key: str) -> None:
        self.objects.pop(key, None)


@pytest.fixture
def env():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection, _connection_record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    init_database(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    fake = FakeStorage()
    settings = Settings(
        database_url="sqlite://", api_keys_json='{"a-key":"tenant-a","b-key":"tenant-b"}',
        minio_bucket="objects",
    )
    # 中文注释：把 settings 挂到 fake 上，单测可按需改配置（如 allow_actor_override）
    fake.settings = settings
    app = create_app(initialize=False)

    def session_dependency():
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_storage] = lambda: fake
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as client:
        yield client, fake, session_factory
    engine.dispose()


@pytest.fixture
def headers():
    return {"X-API-Key": "a-key"}
