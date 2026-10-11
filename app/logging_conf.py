"""结构化 JSON 日志：ts/level/msg/request_id/tenant_id/path/status/duration_ms。

自写 JsonFormatter，不引额外依赖；供 API 访问日志与 worker 复用。
"""
import json
import logging
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    """将日志记录渲染为单行 JSON；extra 字段并入顶层便于日志采集检索。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # 中文注释：request_id 等上下文字段由调用方通过 extra 传入
        for key in ("request_id", "tenant_id", "actor_id", "path", "method", "status", "duration_ms", "job_id", "kind"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        try:
            return json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            # 中文注释：序列化失败时退回纯文本，绝不因日志本身抛异常
            return json.dumps({"ts": payload["ts"], "level": payload["level"], "msg": payload["msg"]}, ensure_ascii=False)


def configure_logging(level: int = logging.INFO) -> None:
    """根处理器换成 JSON 输出；重复调用幂等。"""
    root = logging.getLogger()
    root.setLevel(level)
    handler = None
    for existing in root.handlers:
        if getattr(existing, "_object_store_json", False):
            handler = existing
            break
    if handler is None:
        handler = logging.StreamHandler()
        handler._object_store_json = True  # type: ignore[attr-defined]
        root.addHandler(handler)
    handler.setFormatter(JsonFormatter())
    # 中文注释：uvicorn 自带 handler 会重复输出，统一收口到根 logger
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers = []
        logging.getLogger(name).propagate = True
