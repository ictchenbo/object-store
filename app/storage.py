from collections.abc import Iterator
from datetime import timedelta
from functools import lru_cache
import hashlib

from minio import Minio
from minio.commonconfig import CopySource
from minio.error import S3Error

from app.config import get_settings


class StorageError(Exception):
    pass


class ObjectMissing(StorageError):
    pass


class ContentMismatch(StorageError):
    """中文注释：声明的大小或 SHA-256 与实际内容不符；晋级已回滚，正式对象不存在。"""

    def __init__(self, message: str, *, size: int | None = None, sha256: str | None = None):
        super().__init__(message)
        self.size = size
        self.sha256 = sha256


# 中文注释：流式读写块大小 1MiB，哈希计算内存占用 O(chunk)
CHUNK_SIZE = 1_048_576


class GeneratorStream:
    """把字节生成器适配成 minio SDK 需要的 file-like 对象（只需 read）。

    背景：minio-py 的 put_object 用 getattr(data, "read") 判定流式来源，
    裸生成器没有 read 方法会直接 AttributeError。此处只实现按需取块的 read，
    不做预读缓存，保证 promote_staging 边读边写边算哈希的 O(chunk) 内存约束。
    """

    def __init__(self, chunks: Iterator[bytes]) -> None:
        self._iterator = iter(chunks)
        self._buffer = b""

    def read(self, size: int = -1) -> bytes:
        """按需从生成器取字节；size<0 或 None 表示一次读到 EOF，EOF 后返回空字节串。"""
        if size is None or size < 0:
            parts = [self._buffer, *self._iterator]
            self._buffer = b""
            return b"".join(parts)
        while len(self._buffer) < size:
            try:
                self._buffer += next(self._iterator)
            except StopIteration:
                break
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data


class MinioStorage:
    def __init__(self, client: Minio, bucket: str, public_client: Minio | None = None):
        self.client = client
        self.public_client = public_client or client
        self.bucket = bucket

    def ensure_bucket(self) -> None:
        try:
            if not self.client.bucket_exists(self.bucket):
                self.client.make_bucket(self.bucket)
        except S3Error as exc:
            raise StorageError(str(exc)) from exc

    def upload_url(self, key: str, ttl_seconds: int) -> str:
        try:
            return self.public_client.presigned_put_object(self.bucket, key, expires=timedelta(seconds=ttl_seconds))
        except S3Error as exc:
            raise StorageError(str(exc)) from exc

    def download_url(self, key: str, ttl_seconds: int, *, inline: bool = False, content_type: str | None = None) -> str:
        """签发下载 URL。

        inline=True 时签署 response-content-disposition=inline 供预览内联展示。
        中文注释：同时签署 response-content-type 覆盖对象侧元数据 ——
        浏览器 iframe 渲染 PDF 严格看响应头 Content-Type，而历史对象
        （预签名 PUT 直传）在 MinIO 侧落的是 application/octet-stream，
        不覆盖就会永远「不支持内联预览」。
        """
        try:
            response_headers: dict[str, str] | None = None
            if inline:
                response_headers = {"response-content-disposition": "inline"}
                if content_type:
                    response_headers["response-content-type"] = content_type
            elif content_type:
                # 中文注释：下载路径同样带上真实媒体类型，便于客户端按扩展名关联程序
                response_headers = {"response-content-type": content_type}
            return self.public_client.presigned_get_object(
                self.bucket, key, expires=timedelta(seconds=ttl_seconds), response_headers=response_headers
            )
        except S3Error as exc:
            raise StorageError(str(exc)) from exc

    def size(self, key: str) -> int:
        try:
            return self.client.stat_object(self.bucket, key).size
        except S3Error as exc:
            if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchVersion"}:
                raise ObjectMissing(key) from exc
            raise StorageError(str(exc)) from exc

    def copy(self, source_key: str, target_key: str) -> None:
        try:
            self.client.copy_object(self.bucket, target_key, CopySource(self.bucket, source_key))
        except S3Error as exc:
            raise StorageError(str(exc)) from exc

    def iter_object(self, key: str, chunk_size: int = CHUNK_SIZE) -> Iterator[bytes]:
        """流式读取对象内容；内存占用 O(chunk)，供服务端哈希计算使用。"""
        try:
            response = self.client.get_object(self.bucket, key)
        except S3Error as exc:
            if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchVersion"}:
                raise ObjectMissing(key) from exc
            raise StorageError(str(exc)) from exc
        try:
            yield from response.stream(chunk_size)
        except S3Error as exc:
            raise StorageError(str(exc)) from exc
        finally:
            response.close()
            response.release_conn()

    def put_stream(self, key: str, stream: Iterator[bytes], length: int, content_type: str | None = None) -> None:
        """流式写入对象；S3 协议要求写入前已知总长度。

        中文注释：必须显式传 content_type，否则 minio-py 默认落
        application/octet-stream，预览与下载都认不出真实媒体类型。
        """
        try:
            # 中文注释：minio SDK 要求 file-like（有 .read()），不接受裸生成器
            self.client.put_object(self.bucket, key, GeneratorStream(stream), length, content_type=content_type)
        except S3Error as exc:
            raise StorageError(str(exc)) from exc

    def list_keys(self, prefix: str) -> list[tuple[str, int]]:
        """枚举前缀下的对象，返回 [(key, size)]；供对账扫描孤儿使用。"""
        try:
            return [(obj.object_name, obj.size or 0) for obj in self.client.list_objects(self.bucket, prefix=prefix, recursive=True)]
        except S3Error as exc:
            raise StorageError(str(exc)) from exc

    def remove(self, key: str) -> None:
        try:
            self.client.remove_object(self.bucket, key)
        except S3Error as exc:
            raise StorageError(str(exc)) from exc


def promote_staging(
    storage,
    staging_key: str,
    formal_key: str,
    *,
    expected_size: int,
    expected_sha256: str | None = None,
    content_type: str | None = None,
) -> tuple[int, str, str]:
    """将暂存对象流式晋级为正式对象，返回 (size, sha256, content_type)。

    边读边写边算哈希；若声明哈希不符则删除已写入的正式对象并抛 ContentMismatch，
    保证「不产生正式对象」的契约。成功后由调用方负责删除暂存对象。
    content_type 会写进正式对象元数据 —— 暂存侧是客户端预签名 PUT 直传，
    媒体类型不可靠；先按魔数嗅探校验（app.mime_sniff），伪装成安全类型的
    活动内容会被降级为 application/octet-stream。
    """
    from app.mime_sniff import reconcile_content_type

    try:
        staging_size = storage.size(staging_key)
    except ObjectMissing as exc:
        raise ContentMismatch("暂存对象不存在") from exc
    if staging_size != expected_size:
        raise ContentMismatch(f"暂存大小 {staging_size} 与声明 {expected_size} 不符", size=staging_size)
    hasher = hashlib.sha256()
    written = 0

    # 中文注释：先读前 512 字节做类型嗅探（iter_object 可重复调用），再整体流式写出
    head = b""
    for chunk in storage.iter_object(staging_key):
        head += chunk
        if len(head) >= 512:
            break
    final_type, downgrade_reason = reconcile_content_type(content_type, head[:512])
    if downgrade_reason:
        # 中文注释：类型伪装降级——仅影响目录与预览安全，不影响哈希
        import logging

        logging.getLogger(__name__).warning(
            "内容类型降级 %s -> %s: %s", content_type, final_type, downgrade_reason
        )

    def _stream() -> Iterator[bytes]:
        nonlocal written
        for chunk in storage.iter_object(staging_key):
            hasher.update(chunk)
            written += len(chunk)
            yield chunk

    storage.put_stream(formal_key, _stream(), expected_size, content_type=final_type)
    digest = hasher.hexdigest()
    if written != expected_size:
        # 中文注释：流式过程中字节数变化，删除正式对象后按不符处理
        try:
            storage.remove(formal_key)
        except StorageError:
            pass
        raise ContentMismatch(f"实际读取 {written} 字节与声明 {expected_size} 不符", size=written, sha256=digest)
    if expected_sha256 and digest.lower() != expected_sha256.lower():
        try:
            storage.remove(formal_key)
        except StorageError:
            pass
        raise ContentMismatch("SHA-256 与客户端声明不符", size=written, sha256=digest)
    return written, digest, final_type or content_type or "application/octet-stream"


@lru_cache
def get_storage() -> MinioStorage:
    settings = get_settings()
    client = Minio(
        settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
        region=settings.minio_region,
    )
    public_client = Minio(
        settings.minio_public_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
        region=settings.minio_region,
    )
    return MinioStorage(client, settings.minio_bucket, public_client)
