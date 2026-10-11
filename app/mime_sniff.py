"""服务端媒体类型嗅探：用魔数校验声明的 content_type，防止内容类型混淆。

背景：暂存字节是客户端预签名 PUT 直传，声明的 content_type 不可信。
若把 HTML/SVG/脚本声明成 image/png 等“安全”类型后再以内联方式预览，
浏览器可能按真实内容执行脚本（存储型 XSS）。

策略（保守、可预期）：
  1. 识别常见魔数（图片/PDF/压缩包等）与活动内容特征（HTML/SVG/JS）；
  2. 活动内容 + 非活动声明 → 降级为 application/octet-stream（强制下载语义）；
  3. 魔数识别出的类型与声明明显冲突（如声明 image/png 实为 PDF）→ 同样降级；
  4. 无法识别时保持声明不变（不误伤自定义二进制格式）。
"""
from __future__ import annotations

# 中文注释：活动内容类型——内联渲染时可执行脚本，必须与声明严格匹配
ACTIVE_CONTENT_TYPES = {
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "text/vbscript",
    "application/xslt+xml",
    "text/xsl",
}

# 中文注释：魔数表（前缀 → 媒体类型）；按最长前缀优先匹配
_MAGIC_PREFIXES: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF-", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
    (b"\x1f\x8b", "application/gzip"),
    (b"BM", "image/bmp"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
    (b"\x00\x00\x00\x0cjP  ", "image/jp2"),
    (b"\x1aE\xdf\xa3", "video/webm"),
    (b"OggS", "audio/ogg"),
    (b"ID3", "audio/mpeg"),
    (b"\xff\xfb", "audio/mpeg"),
    (b"RIFF", None),  # 需要二次判定 WAVE/WEBP/AVI
]

# 中文注释：声明类型 → 魔数识别结果的兼容集合（同族视为一致）
_TYPE_FAMILY: dict[str, str] = {
    "image/png": "image",
    "image/jpeg": "image",
    "image/gif": "image",
    "image/bmp": "image",
    "image/webp": "image",
    "image/x-icon": "image",
    "image/jp2": "image",
    "image/tiff": "image",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/gzip": "gzip",
    "application/x-gzip": "gzip",
    "audio/mpeg": "audio",
    "audio/ogg": "audio",
    "audio/wav": "audio",
    "video/webm": "video",
    "video/mp4": "video",
    "text/plain": "text",
}


def _normalize(content_type: str) -> str:
    return (content_type or "").split(";")[0].strip().lower()


def is_active_content(content_type: str) -> bool:
    """声明类型是否为活动内容（可执行脚本/标记）。"""
    return _normalize(content_type) in ACTIVE_CONTENT_TYPES


def sniff_prefix(head: bytes) -> str | None:
    """按魔数识别媒体类型；无法识别返回 None。"""
    if not head:
        return None
    # 中文注释：RIFF 容器需看第 8~12 字节区分 WAVE/WEBP/AVI
    if head.startswith(b"RIFF") and len(head) >= 12:
        fourcc = head[8:12]
        if fourcc == b"WAVE":
            return "audio/wav"
        if fourcc == b"WEBP":
            return "image/webp"
        if fourcc == b"AVI ":
            return "video/x-msvideo"
        return None
    for magic, mime in _MAGIC_PREFIXES:
        if mime is not None and head.startswith(magic):
            return mime
    return None


def sniff_text_markup(head: bytes) -> str | None:
    """识别 HTML/SVG/XML 等文本标记的活动内容（无魔数，看前缀）。"""
    try:
        text = head.lstrip()[:512].lower()
    except Exception:
        return None
    if text.startswith((b"<!doctype html", b"<html", b"<head", b"<body", b"<title", b"<meta", b"<link", b"<style")):
        return "text/html"
    if text.startswith(b"<svg") or (text.startswith(b"<?xml") and b"<svg" in text):
        return "image/svg+xml"
    if text.startswith(b"<!doctype") or text.startswith(b"<?xml"):
        return "application/xml"
    stripped = text.lstrip()
    if stripped.startswith(b"#!") or stripped.startswith(b"<script"):
        return "text/javascript"
    return None


def reconcile_content_type(declared: str | None, head: bytes) -> tuple[str | None, str | None]:
    """校验声明的 content_type 与真实字节；返回 (最终 content_type, 降级原因)。

    - 声明为活动内容但字节不是该类活动内容 → 降级 octet-stream
    - 魔数识别出与声明不同族 → 降级 octet-stream
    - 其余保持声明；返回原因 None 表示无需干预
    """
    normalized = _normalize(declared or "") or None
    sniffed_magic = sniff_prefix(head)
    sniffed_markup = sniff_text_markup(head)
    sniffed = sniffed_magic or sniffed_markup

    if normalized is None:
        # 中文注释：未声明时给嗅探结果；仍识别不出则保持 None（由上层落默认值）
        return sniffed, None

    if is_active_content(normalized):
        # 中文注释：声明活动内容时必须与字节一致，否则视为伪装
        if sniffed is None:
            # 中文注释：无法验证的活动内容一律降级，宁可误伤也不放行伪装脚本
            return "application/octet-stream", "活动内容无法验证"
        if sniffed != normalized and not (normalized == "application/xml" and sniffed in {"image/svg+xml", "application/xml"}):
            return "application/octet-stream", f"声明 {normalized} 与内容 {sniffed} 不符"
        return normalized, None

    if sniffed is not None and sniffed != normalized:
        declared_family = _TYPE_FAMILY.get(normalized)
        sniffed_family = _TYPE_FAMILY.get(sniffed)
        if sniffed in ACTIVE_CONTENT_TYPES:
            return "application/octet-stream", f"声明 {normalized} 但内容为活动类型 {sniffed}"
        if declared_family and sniffed_family and declared_family != sniffed_family:
            return "application/octet-stream", f"声明 {normalized} 与魔数 {sniffed} 类型族不符"
    return normalized, None
