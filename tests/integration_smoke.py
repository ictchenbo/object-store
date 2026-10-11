"""对已启动的 PostgreSQL + MinIO Compose 栈执行真实对象直传验收。"""

import json
import os
import sys
import time
from pathlib import Path
from uuid import uuid4

import httpx


def resolve_api_key() -> str:
    """中文注释：优先 SMOKE_API_KEY；否则从 .env 的 API_KEYS_JSON 取第一个键。"""
    from_env = os.getenv("SMOKE_API_KEY")
    if from_env:
        return from_env
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("API_KEYS_JSON="):
                raw = line.split("=", 1)[1].strip()
                try:
                    keys = json.loads(raw)
                except json.JSONDecodeError:
                    break
                if isinstance(keys, dict) and keys:
                    return next(iter(keys))
                break
    raise SystemExit("未设置 SMOKE_API_KEY，且 .env 中无法解析 API_KEYS_JSON")


def main() -> None:
    # 中文注释：默认用 127.0.0.1 而非 localhost —— 后者在 Windows 上常优先解析到 IPv6 ::1，
    # 若该地址有其它监听者会返回 502，导致冒烟误判失败。
    api_url = os.getenv("SMOKE_API_URL", "http://127.0.0.1:3000")
    api_key = resolve_api_key()
    headers = {"X-API-Key": api_key}
    suffix = uuid4().hex[:12]
    with httpx.Client(base_url=api_url, timeout=20) as client:
        health = client.get("/health")
        health.raise_for_status()

        def upload(name: str, purpose: str, tag: str | None = None) -> dict:
            payload = {
                "display_name": name, "content_type": "text/plain", "expected_size": 4,
                "purpose": purpose, "new_tag_names": [tag] if tag else [],
            }
            response = client.post(
                "/api/v1/uploads", json=payload,
                headers={**headers, "Idempotency-Key": f"smoke-{suffix}-{name}"},
            )
            response.raise_for_status()
            created = response.json()
            put = client.put(created["upload_url"], content=b"data")
            put.raise_for_status()
            complete = client.post(f"/api/v1/uploads/{created['upload_id']}/complete", headers=headers)
            complete.raise_for_status()
            body = complete.json()
            # 中文注释：服务端流式晋级必须落 SHA-256，并删除暂存（不产生双份）
            assert body.get("sha256"), f"完成上传未返回 sha256: {body}"
            return body

        standalone = upload(f"sample-{suffix}.txt", "standalone", f"smoke-{suffix}")
        found = client.get("/api/v1/objects", params={"tag": f"smoke-{suffix}"}, headers=headers)
        found.raise_for_status()
        assert [item["id"] for item in found.json()["items"]] == [standalone["id"]]

        internal = upload(f"source-{suffix}.txt", "document_internal")
        ingest = client.post(
            "/api/v1/ingest-sessions",
            json={"source": "smoke", "external_id": suffix, "doc_type": "article", "title": "Smoke document", "ingest_key": "v1", "new_tag_names": [f"smoke-{suffix}"]},
            headers=headers,
        )
        ingest.raise_for_status()
        session_id = ingest.json()["ingest_session_id"]
        published = client.post(
            f"/api/v1/ingest-sessions/{session_id}/complete", json={"body_object_id": internal["id"]}, headers=headers
        )
        published.raise_for_status()
        assert published.json()["current_version"]["body_object_id"] == internal["id"]
        document_id = published.json()["id"]
        reclassified = client.post(
            f"/api/v1/documents/{document_id}/reclassify",
            json={"doc_type": "report", "reason": "integration smoke"}, headers=headers,
        )
        reclassified.raise_for_status()
        assert reclassified.json()["doc_type"] == "report"
        versions = client.get(f"/api/v1/documents/{document_id}/versions", headers=headers)
        versions.raise_for_status()
        assert [item["doc_type"] for item in versions.json()["items"]] == ["report", "article"]

        # 中文注释：预览签名 URL —— inline 短 TTL；文档内部对象走文档端点
        preview = client.post(
            f"/api/v1/documents/{document_id}/versions/1/objects/{internal['id']}/download-url",
            json={"disposition": "inline", "ttl_seconds": 120}, headers=headers,
        )
        preview.raise_for_status()
        assert preview.json()["expires_in"] == 120
        assert preview.json()["url"]

        # 中文注释：任务 / 审计 / 保留策略 / 对账 / CSV 导出
        jobs = client.get("/api/v1/jobs", params={"limit": 5}, headers=headers)
        jobs.raise_for_status()
        assert "items" in jobs.json()

        changes = client.get("/api/v1/audit/type-changes", headers=headers)
        changes.raise_for_status()
        assert any(item["document_id"] == document_id for item in changes.json()["items"]), "类型变更审计缺失"

        events = client.get("/api/v1/audit/events", headers=headers)
        events.raise_for_status()
        assert events.json()["items"], "事件流水为空"

        policy = client.get("/api/v1/retention-policy", headers=headers)
        policy.raise_for_status()
        assert "orphan_object_grace_hours" in policy.json()

        reconcile = client.post("/api/v1/ops/reconcile", headers=headers)
        assert reconcile.status_code == 202, reconcile.text
        assert reconcile.json()["job_id"]

        export_csv = client.get("/api/v1/stats/export.csv", params={"view": "overview"}, headers=headers)
        export_csv.raise_for_status()
        assert export_csv.text.startswith("﻿"), "CSV 应带 UTF-8 BOM"

        delete = client.delete(f"/api/v1/objects/{standalone['id']}", headers=headers)
        delete.raise_for_status()
        for _ in range(20):
            detail = client.get(f"/api/v1/objects/{standalone['id']}", headers=headers)
            detail.raise_for_status()
            if detail.json()["status"] == "deleted":
                break
            time.sleep(1)
        else:
            raise AssertionError("删除 Worker 未在 20 秒内完成")
        print("PASS: 直传、标签、文档发布、重分类、预览签名、审计/任务/保留策略/对账/CSV、异步删除")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
