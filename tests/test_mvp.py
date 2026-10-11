from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.database import Document, DocumentTypeChange, DocumentVersion, Job, ObjectRecord, Tag, UploadSession, utcnow
from app.storage import StorageError
from app.worker import expire_one_upload, process_one

DATA_SHA256 = "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7"
EVIL_SHA256 = "b5c1fb2efc6d6b4674c2fdcc48ce01b43a3b7c03763c0c3355de0099ee0f8c73"


def set_immediate_purge(client, headers):
    """保留策略设为 0 天恢复窗口，删除后立即永久清除，便于测试 Worker 删除链路。"""
    response = client.put(
        "/api/v1/retention-policy",
        json={"deleted_object_purge_days": 0, "deleted_document_purge_days": 0},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def upload_ready(client, fake, headers, name="file.txt", purpose="standalone", tags=None, sha256=None, content_type="text/plain"):
    request = {
        "display_name": name,
        "content_type": content_type,
        "expected_size": 4,
        "purpose": purpose,
        "new_tag_names": tags or [],
    }
    if sha256:
        request["sha256"] = sha256
    response = client.post("/api/v1/uploads", json=request, headers={**headers, "Idempotency-Key": str(uuid4())})
    assert response.status_code == 201, response.text
    created = response.json()
    staging_key = created["upload_url"].removeprefix("fake://upload/")
    fake.objects[staging_key] = b"data"
    response = client.post(f"/api/v1/uploads/{created['upload_id']}/complete", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_upload_download_delete_and_stats(env, headers):
    client, fake, session_factory = env
    assert client.get("/api/v1/objects").status_code == 401
    obj = upload_ready(client, fake, headers, tags=["项目A"])
    assert obj["status"] == "ready"
    assert obj["tags"][0]["name"] == "项目A"
    assert client.get("/api/v1/stats/overview", headers=headers).json()["object_count"] == 1
    download = client.post(f"/api/v1/objects/{obj['id']}/download-url", headers=headers)
    assert download.status_code == 200
    assert obj["object_key"] in download.json()["url"]
    denied = client.get(f"/api/v1/objects/{obj['id']}", headers={"X-API-Key": "b-key"})
    assert denied.status_code == 404
    # 中文注释：默认 7 天恢复窗口——软删进回收站，字节暂不清理
    response = client.delete(f"/api/v1/objects/{obj['id']}", headers=headers)
    assert response.status_code == 202
    assert response.json()["status"] == "deleting"
    assert response.json()["purge_after"] is not None
    with session_factory() as session:
        record = session.get(ObjectRecord, obj["id"])
        assert record.status == "deleting" and record.deleted_at is not None
    assert obj["object_key"] in fake.objects, "恢复窗口内字节应保留"
    assert client.get("/api/v1/stats/overview", headers=headers).json()["object_count"] == 0
    # 中文注释：恢复后可继续使用
    restored = client.post(f"/api/v1/objects/{obj['id']}/restore", headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "ready"
    assert client.get("/api/v1/stats/overview", headers=headers).json()["object_count"] == 1
    # 中文注释：0 天窗口 → 立即永久删除
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 202
    with session_factory() as session:
        assert process_one(session, fake)
        assert session.scalar(select(Job.status)) == "done"
        assert session.get(ObjectRecord, obj["id"]).status == "deleted"
    assert obj["object_key"] not in fake.objects
    assert client.get("/api/v1/stats/overview", headers=headers).json()["object_count"] == 0


def test_upload_missing_or_wrong_size_cannot_publish(env, headers):
    client, fake, _ = env
    response = client.post(
        "/api/v1/uploads",
        json={"display_name": "bad.bin", "content_type": "application/octet-stream", "expected_size": 4},
        headers={**headers, "Idempotency-Key": "bad-upload"},
    )
    assert response.status_code == 201
    upload = response.json()
    assert client.post(f"/api/v1/uploads/{upload['upload_id']}/complete", headers=headers).status_code == 409
    fake.objects[upload["upload_url"].removeprefix("fake://upload/")] = b"bad"
    assert client.post(f"/api/v1/uploads/{upload['upload_id']}/complete", headers=headers).status_code == 422
    assert client.get("/api/v1/stats/overview", headers=headers).json()["object_count"] == 0


def test_completed_upload_ignores_staging_replay_and_idempotency_conflict(env, headers):
    client, fake, _ = env
    payload = {"display_name": "stable.txt", "content_type": "text/plain", "expected_size": 4}
    first = client.post(
        "/api/v1/uploads", json=payload, headers={**headers, "Idempotency-Key": "stable-key"}
    ).json()
    staging_key = first["upload_url"].removeprefix("fake://upload/")
    fake.objects[staging_key] = b"data"
    ready = client.post(f"/api/v1/uploads/{first['upload_id']}/complete", headers=headers).json()
    fake.objects[staging_key] = b"evil"
    repeated = client.post(f"/api/v1/uploads/{first['upload_id']}/complete", headers=headers)
    assert repeated.status_code == 200
    assert fake.objects[ready["object_key"]] == b"data"
    reused = client.post(
        "/api/v1/uploads", json={**payload, "display_name": "other.txt"},
        headers={**headers, "Idempotency-Key": "stable-key"},
    )
    assert reused.status_code == 409


def test_tags_auto_create_reuse_search_and_tenant_isolation(env, headers):
    client, fake, session_factory = env
    first = upload_ready(client, fake, headers, name="first", tags=["  项目A  ", "重要"])
    second = upload_ready(client, fake, headers, name="second", tags=["项目a"])
    assert len(client.get("/api/v1/tags", headers=headers).json()["items"]) == 2
    with session_factory() as session:
        assert session.scalar(select(func.count(Tag.id))) == 2
    only_a = client.get("/api/v1/objects", params={"tag": "项目A"}, headers=headers).json()["items"]
    assert {item["id"] for item in only_a} == {first["id"], second["id"]}
    important = next(item for item in first["tags"] if item["name"] == "重要")
    all_result = client.get(
        "/api/v1/objects", params=[("tag_ids", first["tags"][0]["id"]), ("tag_ids", important["id"]), ("tag_mode", "all")], headers=headers
    ).json()["items"]
    assert [item["id"] for item in all_result] == [first["id"]]
    assert client.get("/api/v1/objects", params={"tag": "不存在"}, headers=headers).json()["items"] == []
    other = client.post(
        f"/api/v1/objects/{first['id']}/tags", json={"tag_ids": [important["id"]]}, headers={"X-API-Key": "b-key"}
    )
    assert other.status_code == 404


def test_document_version_assets_tags_and_type_conflict(env, headers):
    client, fake, session_factory = env
    raw = upload_ready(client, fake, headers, name="paper.pdf", purpose="document_internal")
    image = upload_ready(client, fake, headers, name="figure.png", purpose="document_internal")
    create = {
        "source": "crawler", "external_id": "doc-1", "doc_type": "paper", "title": "Paper 1",
        "ingest_key": "revision-1", "new_tag_names": ["科研"],
    }
    response = client.post("/api/v1/ingest-sessions", json=create, headers=headers)
    assert response.status_code == 201, response.text
    ingest = response.json()
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"], "assets": [{"object_id": image["id"], "role": "inline_image", "ordinal": 0}], "attrs": {"doi": "10.example/x"}},
        headers=headers,
    )
    assert completed.status_code == 200, completed.text
    document = completed.json()
    assert document["current_version"]["assets"][0]["object_id"] == image["id"]
    assert document["tags"][0]["name"] == "科研"
    assert client.get("/api/v1/documents", params={"tag": "科研"}, headers=headers).json()["items"][0]["id"] == document["id"]
    assert client.get("/api/v1/objects", params={"tag": "科研"}, headers=headers).json()["items"] == []
    assert client.delete(f"/api/v1/objects/{raw['id']}", headers=headers).status_code == 403
    assert client.get("/api/v1/document-stats/overview", headers=headers).json()["version_count"] == 1
    assert client.post("/api/v1/ingest-sessions", json={**create, "doc_type": "report", "ingest_key": "revision-2"}, headers=headers).status_code == 409
    replay = client.post("/api/v1/ingest-sessions", json=create, headers=headers)
    assert replay.json()["ingest_session_id"] == ingest["ingest_session_id"]
    with session_factory() as session:
        assert session.scalar(select(func.count(Document.id))) == 1
        assert session.scalar(select(func.count(DocumentVersion.id))) == 1


def test_version_payload_carries_raw_and_body_content_type(env, headers):
    """回归护栏：版本负载必须带 raw/body 的 content_type，否则前端无法决定预览形态。

    背景：document_internal 受授权约束，前端不能自行 GET /objects/{id} 取媒体类型，
    一旦版本负载缺失，PDF 会被误判为 application/octet-stream 而只给下载、无法内联预览。
    """
    client, fake, _ = env
    raw = upload_ready(client, fake, headers, name="paper.pdf", purpose="document_internal", content_type="application/pdf")
    body = upload_ready(client, fake, headers, name="paper.txt", purpose="document_internal", content_type="text/markdown")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "ct-1", "doc_type": "paper", "title": "CT", "ingest_key": "v1"},
        headers=headers,
    ).json()
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"], "body_object_id": body["id"]},
        headers=headers,
    )
    assert completed.status_code == 200, completed.text
    version = completed.json()["current_version"]
    assert version["raw_content_type"] == "application/pdf"
    assert version["raw_size_bytes"] == 4
    assert version["body_content_type"] == "text/markdown"
    assert version["body_size_bytes"] == 4

    # 中文注释：版本列表与版本详情是同一 version_data，需一并覆盖
    document_id = completed.json()["id"]
    listed = client.get(f"/api/v1/documents/{document_id}/versions", headers=headers).json()["items"][0]
    assert listed["raw_content_type"] == "application/pdf"
    assert listed["body_content_type"] == "text/markdown"

    # 中文注释：缺失一侧时返回 None，前端据此回落到下载提示
    raw_only = upload_ready(client, fake, headers, name="only.pdf", purpose="document_internal", content_type="application/pdf")
    solo = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "ct-2", "doc_type": "paper", "title": "CT2", "ingest_key": "v1"},
        headers=headers,
    ).json()
    solo_version = client.post(
        f"/api/v1/ingest-sessions/{solo['ingest_session_id']}/complete",
        json={"raw_object_id": raw_only["id"]},
        headers=headers,
    ).json()["current_version"]
    assert solo_version["raw_content_type"] == "application/pdf"
    assert solo_version["body_object_id"] is None
    assert solo_version["body_content_type"] is None


def test_standalone_object_cannot_be_used_as_document_body(env, headers):
    client, fake, _ = env
    obj = upload_ready(client, fake, headers)
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-2", "doc_type": "article", "title": "Article", "ingest_key": "r1"},
        headers=headers,
    ).json()
    response = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"body_object_id": obj["id"]}, headers=headers,
    )
    assert response.status_code == 409


def test_object_filters_pagination_and_daily_stats(env, headers):
    client, fake, _ = env
    first = upload_ready(client, fake, headers, name="alpha.txt")
    second = upload_ready(client, fake, headers, name="beta.txt")
    page = client.get("/api/v1/objects", params={"limit": 1}, headers=headers).json()
    assert len(page["items"]) == 1
    assert page["next_cursor"]
    next_page = client.get("/api/v1/objects", params={"limit": 1, "cursor": page["next_cursor"]}, headers=headers).json()
    assert {page["items"][0]["id"], next_page["items"][0]["id"]} == {first["id"], second["id"]}
    filtered = client.get(
        "/api/v1/objects", params={"name_prefix": "alpha", "min_size": 4, "max_size": 4, "bucket": "objects"}, headers=headers
    ).json()["items"]
    assert [item["id"] for item in filtered] == [first["id"]]
    daily = client.get("/api/v1/stats/daily", headers=headers).json()["items"]
    assert sum(item["created_count"] for item in daily) == 2


def test_reclassification_appends_version_and_audit(env, headers):
    client, fake, session_factory = env
    raw = upload_ready(client, fake, headers, purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-3", "doc_type": "paper", "title": "Paper", "ingest_key": "r1"},
        headers=headers,
    ).json()
    client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"], "attrs": {"doi": "10.example/a"}}, headers=headers,
    )
    response = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify",
        json={"doc_type": "report", "reason": "来源分类纠错"}, headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["doc_type"] == "report"
    versions = client.get(f"/api/v1/documents/{ingest['document_id']}/versions", headers=headers).json()["items"]
    assert [item["doc_type"] for item in versions] == ["report", "paper"]
    assert versions[0]["raw_object_id"] == versions[1]["raw_object_id"]
    with session_factory() as session:
        audit = session.scalar(select(DocumentTypeChange))
        assert (audit.old_type, audit.new_type, audit.reason) == ("paper", "report", "来源分类纠错")


def test_worker_retries_failed_delete(env, headers):
    client, fake, session_factory = env
    set_immediate_purge(client, headers)
    obj = upload_ready(client, fake, headers)
    client.delete(f"/api/v1/objects/{obj['id']}", headers=headers)

    class FailingStorage:
        def remove(self, _key):
            raise StorageError("temporary failure")

    with session_factory() as session:
        assert process_one(session, FailingStorage())
        job = session.scalar(select(Job))
        assert job.status == "failed" and job.attempts == 1
        job.next_run_at = utcnow()
        session.commit()
        assert process_one(session, fake)
        assert session.scalar(select(Job.status)) == "done"


def test_expired_upload_cleanup_and_formal_recovery(env, headers):
    client, fake, session_factory = env
    for key in ["expired-a", "expired-b"]:
        response = client.post(
            "/api/v1/uploads",
            json={"display_name": key, "content_type": "text/plain", "expected_size": 4},
            headers={**headers, "Idempotency-Key": key},
        )
        assert response.status_code == 201
    with session_factory() as session:
        uploads = session.scalars(select(UploadSession).order_by(UploadSession.idempotency_key)).all()
        for upload in uploads:
            upload.expires_at = utcnow().replace(year=2020)
        recover = session.get(ObjectRecord, uploads[1].object_id)
        fake.objects[recover.object_key] = b"data"
        fake.objects[uploads[0].staging_key] = b"data"
        session.commit()
        assert expire_one_upload(session, fake)
        assert expire_one_upload(session, fake)
        assert session.get(ObjectRecord, uploads[0].object_id).status == "failed"
        assert session.get(ObjectRecord, uploads[1].object_id).status == "ready"
        assert uploads[0].staging_key not in fake.objects


def test_api_key_config_object_form_and_actor_validation():
    from app.config import Settings, parse_api_keys

    assert parse_api_keys('{"a-key":"tenant-a"}')["a-key"] == ("tenant-a", "tenant-default")
    parsed = parse_api_keys('{"k":{"tenant_id":"t1","actor_id":"svc-ingest"}}')
    assert parsed["k"] == ("t1", "svc-ingest")
    for bad in ["{}", "[]", '{"k":""}', '{"k":{"actor_id":"x"}}', '{"k":{"tenant_id":"t","actor_id":"bad actor"}}']:
        try:
            parse_api_keys(bad)
        except ValueError:
            continue
        raise AssertionError(f"应当拒绝: {bad}")
    # 中文注释：生产环境拒绝弱凭据
    import pytest
    with pytest.raises(Exception):
        Settings(environment="prod", api_keys_json='{"dev-key":"demo"}')
    Settings(environment="prod", api_keys_json='{"strong-random-key-32chars-abcdefgh":"tenant-x"}',
             minio_secret_key="s3cret-not-weak", database_url="postgresql+psycopg2://u:StrongPass99@host/db")


def test_actor_override_and_audit_actor_id(env, headers):
    client, fake, session_factory = env
    # 中文注释：默认禁止 X-Actor-Id 覆盖，防止伪造审计身份
    raw = upload_ready(client, fake, headers, purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-actor", "doc_type": "paper", "title": "Paper", "ingest_key": "r1"},
        headers=headers,
    ).json()
    client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"]}, headers=headers,
    )
    denied = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify",
        json={"doc_type": "report", "reason": "纠错"},
        headers={**headers, "X-Actor-Id": "alice@example.com"},
    )
    assert denied.status_code == 403
    # 中文注释：显式开启覆盖后，非法格式仍拒绝
    fake.settings.allow_actor_override = True
    bad = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify",
        json={"doc_type": "report", "reason": "纠错"},
        headers={**headers, "X-Actor-Id": "bad actor!!"},
    )
    assert bad.status_code == 422
    # 中文注释：合法 X-Actor-Id 覆盖配置中的 actor
    response = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify",
        json={"doc_type": "report", "reason": "来源分类纠错"},
        headers={**headers, "X-Actor-Id": "alice@example.com"},
    )
    assert response.status_code == 200, response.text
    with session_factory() as session:
        audit = session.scalar(select(DocumentTypeChange))
        assert audit.actor_id == "alice@example.com"
    # 中文注释：不传 X-Actor-Id 时回退到配置的 actor
    from app.config import parse_api_keys
    assert parse_api_keys('{"a-key":"tenant-a"}')["a-key"][1] == "tenant-default"


def test_document_internal_download_requires_document_context(env, headers):
    client, fake, _ = env
    raw = upload_ready(client, fake, headers, name="paper.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-dl", "doc_type": "article", "title": "A", "ingest_key": "r1"},
        headers=headers,
    ).json()
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"]}, headers=headers,
    )
    assert completed.status_code == 200, completed.text
    # 中文注释：无文档上下文 → 403（与 GET /objects/{id} 一致）
    bare = client.post(f"/api/v1/objects/{raw['id']}/download-url", headers=headers)
    assert bare.status_code == 403
    empty_body = client.post(f"/api/v1/objects/{raw['id']}/download-url", json={}, headers=headers)
    assert empty_body.status_code == 403
    # 中文注释：错误文档上下文（该文档引用的是另一个对象）→ 404
    other_raw = upload_ready(client, fake, headers, name="other.pdf", purpose="document_internal")
    other = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-dl-other", "doc_type": "article", "title": "B", "ingest_key": "r1"},
        headers=headers,
    ).json()
    client.post(
        f"/api/v1/ingest-sessions/{other['ingest_session_id']}/complete",
        json={"raw_object_id": other_raw["id"]}, headers=headers,
    )
    wrong_doc = client.post(
        f"/api/v1/objects/{raw['id']}/download-url",
        json={"document_id": other["document_id"]}, headers=headers,
    )
    assert wrong_doc.status_code == 404
    # 中文注释：正确文档上下文 → 200；文档版本端点 → 200
    ok = client.post(
        f"/api/v1/objects/{raw['id']}/download-url",
        json={"document_id": ingest["document_id"], "version_no": 1}, headers=headers,
    )
    assert ok.status_code == 200, ok.text
    scoped = client.post(
        f"/api/v1/documents/{ingest['document_id']}/versions/1/objects/{raw['id']}/download-url",
        headers=headers,
    )
    assert scoped.status_code == 200, scoped.text
    assert raw["object_key"] in scoped.json()["url"]
    # 中文注释：预览请求 inline + 短 TTL，URL 携带内联标记且 expires_in 收敛到 120
    preview = client.post(
        f"/api/v1/objects/{raw['id']}/download-url",
        json={"document_id": ingest["document_id"], "version_no": 1, "disposition": "inline", "ttl_seconds": 120},
        headers=headers,
    )
    assert preview.status_code == 200, preview.text
    # 中文注释：预览签名必须同时带内联标记与媒体类型覆盖，否则 iframe 认不出 PDF
    assert "inline=1" in preview.json()["url"]
    assert "type=text/plain" in preview.json()["url"]
    assert preview.json()["expires_in"] == 120


def test_pdf_preview_url_carries_pdf_response_content_type(env, headers):
    """回归护栏：PDF 论文预览 URL 必须签署 response-content-type=application/pdf。

    用户实际场景：上传 arXiv PDF 后点预览，浏览器 iframe 靠响应头 Content-Type
    判定是否渲染；只给 inline 不给类型，就永远退化成「该媒体类型不支持内联预览」。
    """
    client, fake, _ = env
    raw = upload_ready(client, fake, headers, name="2604.17870v1.pdf", purpose="document_internal", content_type="application/pdf")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "arxiv", "external_id": "2604.17870v1", "doc_type": "article", "title": "P", "ingest_key": "pdf-prev"},
        headers=headers,
    ).json()
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"]}, headers=headers,
    )
    assert completed.status_code == 200, completed.text

    preview = client.post(
        f"/api/v1/documents/{ingest['document_id']}/versions/1/objects/{raw['id']}/download-url",
        json={"disposition": "inline", "ttl_seconds": 120},
        headers=headers,
    )
    assert preview.status_code == 200, preview.text
    url = preview.json()["url"]
    assert "inline=1" in url
    assert "type=application/pdf" in url, f"预览 URL 未覆盖 PDF 媒体类型: {url}"
    # 中文注释：正式对象也必须落正确类型，mc stat / 直接下载才认得出
    assert fake.content_types[raw["object_key"]] == "application/pdf"


# —— 阶段 2：SHA-256 / 暂存生命周期 / 过期重试 / 幂等 / API 语义 ——


def test_complete_upload_streams_sha256_and_removes_staging(env, headers):
    client, fake, _ = env
    payload = {"display_name": "hashed.txt", "content_type": "text/plain", "expected_size": 4, "sha256": DATA_SHA256}
    created = client.post("/api/v1/uploads", json=payload, headers={**headers, "Idempotency-Key": "sha-ok"}).json()
    staging_key = created["upload_url"].removeprefix("fake://upload/")
    fake.objects[staging_key] = b"data"
    done = client.post(f"/api/v1/uploads/{created['upload_id']}/complete", headers=headers)
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["sha256"] == DATA_SHA256
    assert body["size_bytes"] == 4
    # 中文注释：成功晋级后必须删除暂存，避免双份占用
    assert staging_key not in fake.objects
    assert body["object_key"] in fake.objects


def test_complete_upload_rejects_sha256_mismatch_without_formal_object(env, headers):
    client, fake, session_factory = env
    payload = {"display_name": "bad-hash.txt", "content_type": "text/plain", "expected_size": 4, "sha256": EVIL_SHA256}
    created = client.post("/api/v1/uploads", json=payload, headers={**headers, "Idempotency-Key": "sha-bad"}).json()
    staging_key = created["upload_url"].removeprefix("fake://upload/")
    fake.objects[staging_key] = b"data"
    done = client.post(f"/api/v1/uploads/{created['upload_id']}/complete", headers=headers)
    assert done.status_code == 422, done.text
    # 中文注释：哈希不符不产生正式对象，暂存保留供排查/重试
    assert created["object_id"] and f"objects/tenant-a/{created['object_id']}" not in fake.objects
    assert staging_key in fake.objects
    with session_factory() as session:
        assert session.get(ObjectRecord, created["object_id"]).status == "pending"


def test_expired_upload_within_grace_enqueues_finalize_and_recovers(env, headers):
    client, fake, session_factory = env
    created = client.post(
        "/api/v1/uploads",
        json={"display_name": "retry.txt", "content_type": "text/plain", "expected_size": 4},
        headers={**headers, "Idempotency-Key": "retry-a"},
    ).json()
    staging_key = created["upload_url"].removeprefix("fake://upload/")
    fake.objects[staging_key] = b"data"
    with session_factory() as session:
        upload = session.scalar(select(UploadSession).where(UploadSession.idempotency_key == "retry-a"))
        # 中文注释：过期但在宽限期内（默认 86400s），应走重试而非放弃
        upload.expires_at = utcnow() - timedelta(seconds=60)
        session.commit()
        assert expire_one_upload(session, fake)
        obj = session.get(ObjectRecord, created["object_id"])
        assert obj.status == "pending"
        job = session.scalar(select(Job).where(Job.kind == "finalize_upload"))
        assert job is not None and job.status == "pending"
        assert session.get(UploadSession, upload.id).copy_attempts == 0
    # 中文注释：暂存不得在重试路径上被删除
    assert staging_key in fake.objects
    # 中文注释：执行 finalize_upload 任务后对象就绪、暂存清理
    with session_factory() as session:
        assert process_one(session, fake)
        assert session.get(ObjectRecord, created["object_id"]).status == "ready"
    assert staging_key not in fake.objects
    assert fake.objects[f"objects/tenant-a/{created['object_id']}"] == b"data"


def test_expired_upload_gives_up_and_archives_idempotency_key(env, headers):
    client, fake, session_factory = env
    created = client.post(
        "/api/v1/uploads",
        json={"display_name": "giveup.txt", "content_type": "text/plain", "expected_size": 4},
        headers={**headers, "Idempotency-Key": "giveup-a"},
    ).json()
    staging_key = created["upload_url"].removeprefix("fake://upload/")
    fake.objects[staging_key] = b"data"
    with session_factory() as session:
        upload = session.scalar(select(UploadSession).where(UploadSession.idempotency_key == "giveup-a"))
        upload.expires_at = utcnow().replace(year=2020)
        session.commit()
        assert expire_one_upload(session, fake)
        obj = session.get(ObjectRecord, created["object_id"])
        assert obj.status == "failed"
        reloaded = session.get(UploadSession, upload.id)
        assert reloaded.idempotency_key.startswith("giveup-a#failed-")
    assert staging_key not in fake.objects
    # 中文注释：原幂等键已释放，可重建新上传
    again = client.post(
        "/api/v1/uploads",
        json={"display_name": "giveup.txt", "content_type": "text/plain", "expected_size": 4},
        headers={**headers, "Idempotency-Key": "giveup-a"},
    )
    assert again.status_code == 201


def test_delete_already_deleted_returns_204_and_stuck_deleting_rebuilds_job(env, headers):
    client, fake, session_factory = env
    set_immediate_purge(client, headers)
    obj = upload_ready(client, fake, headers)
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 202
    with session_factory() as session:
        assert process_one(session, fake)
        assert session.get(ObjectRecord, obj["id"]).status == "deleted"
    # 中文注释：已删对象幂等删除返回 204（破坏性变更，前端已同步）
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 204
    # 中文注释：卡死在 deleting 且无活动 job 时重建
    other = upload_ready(client, fake, headers, name="stuck.txt")
    client.delete(f"/api/v1/objects/{other['id']}", headers=headers)
    with session_factory() as session:
        session.query(Job).delete()
        session.commit()
    rebuilt = client.delete(f"/api/v1/objects/{other['id']}", headers=headers)
    assert rebuilt.status_code == 202
    with session_factory() as session:
        assert session.scalar(select(func.count(Job.id)).where(Job.kind == "delete_object")) == 1


def test_idempotency_fingerprint_conflict_on_uploads_and_reclassify(env, headers):
    client, fake, session_factory = env
    base = {"display_name": "fp.txt", "content_type": "text/plain", "expected_size": 4}
    first = client.post("/api/v1/uploads", json=base, headers={**headers, "Idempotency-Key": "fp-1"})
    assert first.status_code == 201
    same = client.post("/api/v1/uploads", json=base, headers={**headers, "Idempotency-Key": "fp-1"})
    assert same.status_code == 201
    assert same.json()["upload_id"] == first.json()["upload_id"]
    conflict = client.post("/api/v1/uploads", json={**base, "expected_size": 5}, headers={**headers, "Idempotency-Key": "fp-1"})
    assert conflict.status_code == 409
    # 中文注释：reclassify 带 Idempotency-Key 重放同指纹返回原响应，不新增版本
    raw = upload_ready(client, fake, headers, name="paper.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-fp", "doc_type": "paper", "title": "P", "ingest_key": "r1"},
        headers=headers,
    ).json()
    client.post(f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete", json={"raw_object_id": raw["id"]}, headers=headers)
    body = {"doc_type": "report", "reason": "纠错"}
    first_reclass = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify", json=body,
        headers={**headers, "Idempotency-Key": "reclass-1"},
    )
    assert first_reclass.status_code == 200, first_reclass.text
    replay = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify", json=body,
        headers={**headers, "Idempotency-Key": "reclass-1"},
    )
    assert replay.status_code == 200
    assert replay.json() == first_reclass.json()
    with session_factory() as session:
        assert session.scalar(select(func.count(DocumentVersion.id))) == 2
    changed = client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify",
        json={"doc_type": "article", "reason": "另一请求"},
        headers={**headers, "Idempotency-Key": "reclass-1"},
    )
    assert changed.status_code == 409


def test_ingest_replay_fingerprint_and_parts(env, headers):
    client, fake, session_factory = env
    create = {
        "source": "crawler", "external_id": "doc-parts", "doc_type": "article",
        "title": "Parts", "ingest_key": "v1",
        "parts": [
            {"role": "raw", "display_name": "raw.txt", "content_type": "text/plain", "expected_size": 4},
            {"role": "body", "display_name": "body.txt", "content_type": "text/plain", "expected_size": 4},
        ],
    }
    first = client.post("/api/v1/ingest-sessions", json=create, headers=headers)
    assert first.status_code == 201, first.text
    body = first.json()
    assert len(body["uploads"]) == 2
    assert body["uploads"][0]["role"] == "raw"
    # 中文注释：同指纹重放返回 200 并重新签发 upload_url
    replay = client.post("/api/v1/ingest-sessions", json=create, headers=headers)
    assert replay.status_code == 200
    assert replay.json()["ingest_session_id"] == body["ingest_session_id"]
    assert replay.json()["uploads"][0]["upload_url"].startswith("fake://upload/")
    # 中文注释：同 ingest_key 不同指纹 → 409
    conflict = client.post(
        "/api/v1/ingest-sessions", json={**create, "title": "Changed"}, headers=headers
    )
    assert conflict.status_code == 409
    # 中文注释：parts 创建的上传会话可正常直传并完成
    for entry in body["uploads"]:
        fake.objects[entry["upload_url"].removeprefix("fake://upload/")] = b"data"
        done = client.post(f"/api/v1/uploads/{entry['upload_id']}/complete", headers=headers)
        assert done.status_code == 200, done.text
    published = client.post(
        f"/api/v1/ingest-sessions/{body['ingest_session_id']}/complete",
        json={"raw_object_id": body["uploads"][0]["object_id"], "body_object_id": body["uploads"][1]["object_id"]},
        headers=headers,
    )
    assert published.status_code == 200, published.text


def test_documents_time_filters_and_versions_cursor(env, headers):
    client, fake, _ = env
    raw = upload_ready(client, fake, headers, name="a.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-cursor", "doc_type": "paper", "title": "T", "ingest_key": "r1"},
        headers=headers,
    ).json()
    client.post(f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete", json={"raw_object_id": raw["id"]}, headers=headers)
    client.post(
        f"/api/v1/documents/{ingest['document_id']}/reclassify",
        json={"doc_type": "report", "reason": "r"}, headers=headers,
    )
    future = client.get(
        "/api/v1/documents", params={"created_from": "2099-01-01T00:00:00Z"}, headers=headers
    ).json()
    assert future["items"] == []
    page = client.get(f"/api/v1/documents/{ingest['document_id']}/versions", params={"limit": 1}, headers=headers).json()
    assert len(page["items"]) == 1
    assert page["items"][0]["version_no"] == 2
    # 中文注释：游标为当前页最后一条的 version_no，下一页取严格小于它的版本
    assert page["next_cursor"] == 2
    rest = client.get(
        f"/api/v1/documents/{ingest['document_id']}/versions",
        params={"limit": 10, "cursor": page["next_cursor"]}, headers=headers,
    ).json()
    assert [item["version_no"] for item in rest["items"]] == [1]


def test_job_dead_status_after_max_attempts(env, headers):
    from app.config import get_settings

    client, fake, session_factory = env
    set_immediate_purge(client, headers)
    obj = upload_ready(client, fake, headers)
    client.delete(f"/api/v1/objects/{obj['id']}", headers=headers)

    class FailingStorage:
        def remove(self, _key):
            raise StorageError("temporary failure")

    max_attempts = get_settings().job_max_attempts
    with session_factory() as session:
        for _ in range(max_attempts):
            assert process_one(session, FailingStorage())
            job = session.scalar(select(Job))
            job.next_run_at = utcnow()  # 跳过退避等待，直接进入下次尝试
            session.commit()
        job = session.scalar(select(Job))
        assert job.status == "dead" and job.attempts == max_attempts
        # 中文注释：dead 任务不再被拾取
        assert process_one(session, fake) is False


# —— 阶段 3：对账 / 孤儿回收 / 版本与文档删除 / 审计 / 任务 / 保留策略 / 导出 ——


def _published_document(client, fake, headers, external_id="doc-p3", ingest_key="r1"):
    """建一份已发布文档，返回 (document_id, raw_obj, version_id)。"""
    raw = upload_ready(client, fake, headers, name=f"{external_id}.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": external_id, "doc_type": "paper", "title": "T", "ingest_key": ingest_key},
        headers=headers,
    ).json()
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"]}, headers=headers,
    )
    assert completed.status_code == 200, completed.text
    return ingest["document_id"], raw


def test_reconcile_reports_four_finding_kinds(env, headers):
    from app.reconcile import run_reconcile

    client, fake, session_factory = env
    # pending 缺字节：只建上传会话不传内容
    pending = client.post(
        "/api/v1/uploads",
        json={"display_name": "p.bin", "content_type": "application/octet-stream", "expected_size": 4},
        headers={**headers, "Idempotency-Key": "rec-pending"},
    ).json()
    # ready 缺正式：上传完成后删掉存储字节
    ready = upload_ready(client, fake, headers, name="r.bin")
    fake.objects.pop(ready["object_key"], None)
    # 正式孤儿：存储有字节但目录无记录
    fake.objects["objects/tenant-a/ghost"] = b"ghost"
    # 暂存孤儿：存储有暂存但无上传会话
    fake.objects["staging/tenant-a/ghost"] = b"tmp"

    with session_factory() as session:
        result = run_reconcile(session, fake)
    counts = result["counts"]
    assert counts.get("pending_missing_bytes") == 1
    assert counts.get("ready_missing_object") == 1
    assert counts.get("formal_orphan") == 1
    assert counts.get("staging_orphan") == 1
    # 中文注释：对账只告警，不改目录状态
    with session_factory() as session:
        assert session.get(ObjectRecord, ready["id"]).status == "ready"
    assert pending["upload_id"]


def test_reclaim_orphans_marks_unreferenced_document_internal(env, headers):
    from app.reconcile import reclaim_orphans

    client, fake, session_factory = env
    # 未被任何文档引用的 document_internal 对象
    orphan = upload_ready(client, fake, headers, name="orphan.bin", purpose="document_internal")
    kept = _published_document(client, fake, headers, external_id="doc-keep")[1]
    with session_factory() as session:
        for object_id in (orphan["id"], kept["id"]):
            obj = session.get(ObjectRecord, object_id)
            obj.ready_at = utcnow() - timedelta(hours=100)
            session.commit()
        assert reclaim_orphans(session, fake) == 1
        assert session.get(ObjectRecord, orphan["id"]).status == "deleting"
        assert session.get(ObjectRecord, orphan["id"]).deleted_reason == "orphan"
        assert session.get(ObjectRecord, kept["id"]).status == "ready"
        job = session.scalar(select(Job).where(Job.kind == "delete_object", Job.target_id == orphan["id"]))
        assert job is not None and job.status == "pending"


def test_delete_version_protects_current_pointer(env, headers):
    client, fake, session_factory = env
    document_id, raw = _published_document(client, fake, headers, external_id="doc-ver")
    assert client.post(
        f"/api/v1/documents/{document_id}/reclassify",
        json={"doc_type": "report", "reason": "改类型"}, headers=headers,
    ).status_code == 200
    # 中文注释：当前版本（version_no=2）受指针保护
    assert client.delete(f"/api/v1/documents/{document_id}/versions/2", headers=headers).status_code == 409
    assert client.delete(f"/api/v1/documents/{document_id}/versions/1", headers=headers).status_code == 202
    versions = client.get(f"/api/v1/documents/{document_id}/versions", headers=headers).json()
    # 中文注释：软删版本随列表可见（status=deleted），供前端展示恢复入口
    by_no = {item["version_no"]: item for item in versions["items"]}
    assert set(by_no) == {1, 2}
    assert by_no[1]["status"] == "deleted" and by_no[1]["deleted_at"] is not None
    assert by_no[2]["status"] == "ready"
    detail = client.get(f"/api/v1/documents/{document_id}/versions/1", headers=headers)
    assert detail.status_code == 200 and detail.json()["status"] == "deleted"
    with session_factory() as session:
        version = session.scalar(select(DocumentVersion).where(DocumentVersion.version_no == 1))
        assert version.status == "deleted" and version.deleted_at is not None
    # 中文注释：软删版本可在窗口内恢复，恢复后任务取消
    restored = client.post(f"/api/v1/documents/{document_id}/versions/1/restore", headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "ready"
    with session_factory() as session:
        assert session.scalar(select(func.count(Job.id)).where(Job.kind == "purge_version")) == 0
    assert raw["id"]


def test_delete_document_soft_deletes_and_schedules_cleanup(env, headers):
    client, fake, session_factory = env
    document_id, raw = _published_document(client, fake, headers, external_id="doc-del")
    # 中文注释：存在未发布版本时拒绝删除
    staging = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "doc-del", "doc_type": "paper", "title": "T", "ingest_key": "r2"},
        headers=headers,
    ).json()
    assert client.delete(f"/api/v1/documents/{document_id}", headers=headers).status_code == 409
    assert client.post(
        f"/api/v1/ingest-sessions/{staging['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"]}, headers=headers,
    ).status_code == 200

    # 中文注释：默认 7 天窗口——软删进回收站，字节与版本保留
    response = client.delete(f"/api/v1/documents/{document_id}", headers=headers)
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "deleted" and body["job_id"]
    assert body["purge_after"] is not None
    # 中文注释：已删文档幂等 204；查询侧不再可见
    assert client.delete(f"/api/v1/documents/{document_id}", headers=headers).status_code == 204
    assert client.get(f"/api/v1/documents/{document_id}", headers=headers).status_code == 404
    # 中文注释：回收站可见且可恢复
    trash = client.get("/api/v1/trash/documents", headers=headers).json()
    assert [item["id"] for item in trash["items"]] == [document_id]
    restored = client.post(f"/api/v1/documents/{document_id}/restore", headers=headers)
    assert restored.status_code == 200, restored.text
    assert client.get(f"/api/v1/documents/{document_id}", headers=headers).status_code == 200
    with session_factory() as session:
        assert session.get(Document, document_id).deleted_at is None
        assert session.get(ObjectRecord, raw["id"]).status == "ready"

    # 中文注释：0 天窗口 → 立即永久清除链路
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/documents/{document_id}", headers=headers).status_code == 202
    with session_factory() as session:
        kinds = {row.kind for row in session.scalars(select(Job))}
        assert "purge_document" in kinds
        # 跑完全部异步任务
        for _ in range(10):
            if not process_one(session, fake):
                break
        assert session.get(ObjectRecord, raw["id"]).status == "deleted"
        assert session.get(Document, document_id).deleted_at is not None
    assert raw["object_key"] not in fake.objects


def test_audit_type_changes_and_events_are_read_only(env, headers):
    client, fake, _ = env
    document_id, _ = _published_document(client, fake, headers, external_id="doc-audit")
    assert client.post(
        f"/api/v1/documents/{document_id}/reclassify",
        json={"doc_type": "report", "reason": "业务重分"}, headers=headers,
    ).status_code == 200
    changes = client.get("/api/v1/audit/type-changes", headers=headers).json()
    assert len(changes["items"]) == 1
    assert changes["items"][0]["old_type"] == "paper"
    assert changes["items"][0]["new_type"] == "report"
    assert changes["items"][0]["actor_id"]
    events = client.get("/api/v1/audit/events", params={"event_kind": "document.reclassified"}, headers=headers).json()
    assert len(events["items"]) == 1
    assert events["items"][0]["target_id"] == document_id
    # 中文注释：审计为只读数据源，无写入口
    assert client.post("/api/v1/audit/events", headers=headers).status_code in {404, 405}
    assert client.put("/api/v1/audit/type-changes", headers=headers).status_code in {404, 405}


def test_jobs_list_and_retry_revives_dead(env, headers):
    from app.config import get_settings

    client, fake, session_factory = env
    set_immediate_purge(client, headers)
    obj = upload_ready(client, fake, headers)
    client.delete(f"/api/v1/objects/{obj['id']}", headers=headers)

    class FailingStorage:
        def remove(self, _key):
            raise StorageError("boom")

    max_attempts = get_settings().job_max_attempts
    with session_factory() as session:
        for _ in range(max_attempts):
            assert process_one(session, FailingStorage())
            job = session.scalar(select(Job))
            job.next_run_at = utcnow()
            session.commit()
        job_id = session.scalar(select(Job.id))
    listed = client.get("/api/v1/jobs", params={"status": "dead"}, headers=headers).json()
    assert [item["id"] for item in listed["items"]] == [job_id]
    revived = client.post(f"/api/v1/jobs/{job_id}/retry", headers=headers)
    assert revived.status_code == 200
    assert revived.json()["status"] == "pending"
    with session_factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "pending" and job.attempts == 0
        assert process_one(session, fake)
        assert session.get(Job, job_id).status == "done"
    # 中文注释：done 任务不可再复活
    assert client.post(f"/api/v1/jobs/{job_id}/retry", headers=headers).status_code == 409


def test_retention_policy_get_and_put(env, headers):
    client, fake, _ = env
    default = client.get("/api/v1/retention-policy", headers=headers).json()
    assert default["orphan_object_grace_hours"] == 72
    assert default["deleted_object_purge_days"] == 7
    assert default["deleted_document_purge_days"] == 7
    assert default["version_retention"] == "keep_all"
    # 中文注释：note 描述 Worker 执行语义，不再是占位文案
    assert "Worker" in default["note"]
    assert "待业务确认" not in default["note"]
    updated = client.put(
        "/api/v1/retention-policy",
        json={"orphan_object_grace_hours": 1, "staging_retry_grace_seconds": 10, "staging_retry_max_attempts": 3,
              "version_retention": "keep_last_n", "version_retention_n": 5,
              "deleted_object_purge_days": 30, "deleted_document_purge_days": 14},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["orphan_object_grace_hours"] == 1
    assert updated.json()["version_retention"] == "keep_last_n"
    assert updated.json()["version_retention_n"] == 5
    reloaded = client.get("/api/v1/retention-policy", headers=headers).json()
    assert reloaded["deleted_object_purge_days"] == 30
    assert reloaded["deleted_document_purge_days"] == 14


def test_stats_export_csv_views(env, headers):
    client, fake, _ = env
    upload_ready(client, fake, headers, name="e1.bin")
    upload_ready(client, fake, headers, name="e2.bin")
    for view in ("overview", "buckets", "daily"):
        response = client.get("/api/v1/stats/export.csv", params={"view": view}, headers=headers)
        assert response.status_code == 200, response.text
        assert response.text.startswith("﻿"), view
        assert "attachment" in response.headers["content-disposition"]
    overview = client.get("/api/v1/stats/export.csv", params={"view": "overview"}, headers=headers).text
    assert "object_count" in overview and "2" in overview


def test_generator_stream_read_chunked_and_eof():
    """minio SDK 以 read() 消费流；验证分块与 EOF 语义，防止 put_stream 回退成裸生成器。"""
    from app.storage import GeneratorStream

    stream = GeneratorStream(iter([b"ab", b"cd", b"ef"]))
    assert callable(getattr(stream, "read")), "minio SDK 要求 file-like 对象提供 read()"
    assert stream.read(3) == b"abc"
    assert stream.read(3) == b"def"
    assert stream.read(3) == b"", "EOF 后应返回空字节串，而非抛 StopIteration"

    # 中文注释：size<0 表示一次读到 EOF
    whole = GeneratorStream(iter([b"x", b"yy", b"zzz"]))
    assert whole.read(-1) == b"xyyzzz"
    assert whole.read(-1) == b""


def test_generator_stream_propagates_upstream_errors():
    """生成器内部异常必须冒泡给调用方，不能被适配器吞掉。"""
    from app.storage import GeneratorStream

    def broken() -> "object":
        yield b"ok"
        raise RuntimeError("upstream boom")

    stream = GeneratorStream(broken())
    assert stream.read(2) == b"ok"
    with pytest.raises(RuntimeError, match="upstream boom"):
        stream.read(2)


def test_minio_put_stream_accepts_generator():
    """回归护栏：MinioStorage.put_stream 必须把生成器包装成 file-like 再交给 SDK。"""
    from app.storage import MinioStorage

    seen: dict[str, object] = {}

    class StubClient:
        def put_object(self, bucket, key, data, length, content_type=None):
            # 中文注释：复刻 minio-py 的判定方式，裸生成器会在此失败
            if not callable(getattr(data, "read")):
                raise AttributeError("'generator' object has no attribute 'read'")
            seen["key"] = key
            seen["length"] = length
            seen["content_type"] = content_type
            chunks = []
            while True:
                chunk = data.read(4)
                if not chunk:
                    break
                chunks.append(chunk)
            seen["payload"] = b"".join(chunks)

    storage = MinioStorage(StubClient(), bucket="objects")
    storage.put_stream("formal/key", iter([b"1234", b"5678"]), 8, content_type="application/pdf")
    assert seen == {"key": "formal/key", "length": 8, "content_type": "application/pdf", "payload": b"12345678"}


def test_minio_put_stream_defaults_content_type_to_none():
    """未声明媒体类型时不应臆造，交给 SDK 落默认值。"""
    from app.storage import MinioStorage

    seen: dict[str, object] = {}

    class StubClient:
        def put_object(self, bucket, key, data, length, content_type=None):
            seen["content_type"] = content_type

    MinioStorage(StubClient(), bucket="objects").put_stream("k", iter([b"ab"]), 2)
    assert seen == {"content_type": None}


def test_minio_download_url_overrides_response_content_type_for_inline():
    """回归护栏：预览签名必须覆盖 response-content-type。

    背景：预签名 PUT 直传的对象在 MinIO 侧是 application/octet-stream，
    浏览器 iframe 只看响应头 Content-Type 决定是否渲染 PDF。
    不覆盖就永远退化成「下载」分支。
    """
    from app.storage import MinioStorage

    seen: dict[str, object] = {}

    class StubClient:
        def presigned_get_object(self, bucket, key, expires=None, response_headers=None):
            seen["response_headers"] = response_headers
            return "https://signed.example/x"

    storage = MinioStorage(StubClient(), bucket="objects")
    url = storage.download_url("objects/x", 120, inline=True, content_type="application/pdf")
    assert url == "https://signed.example/x"
    assert seen["response_headers"] == {
        "response-content-disposition": "inline",
        "response-content-type": "application/pdf",
    }
    # 中文注释：下载路径同样带上真实媒体类型
    storage.download_url("objects/x", 60, content_type="application/pdf")
    assert seen["response_headers"] == {"response-content-type": "application/pdf"}
    # 中文注释：未声明媒体类型时不覆盖，避免把未知类型写死
    storage.download_url("objects/x", 60, inline=True)
    assert seen["response_headers"] == {"response-content-disposition": "inline"}


def test_promote_staging_writes_content_type(env):
    """回归护栏：正式对象必须落目录库声明的媒体类型，而不是 octet-stream。"""
    client, fake, _ = env
    from app.storage import promote_staging

    fake.objects["staging/s1"] = b"data"
    fake.content_types["staging/s1"] = "application/octet-stream"  # 中文注释：模拟客户端直传的不可靠类型
    size, digest, final_type = promote_staging(fake, "staging/s1", "formal/f1", expected_size=4, content_type="application/pdf")
    assert size == 4
    assert final_type == "application/pdf"
    assert fake.content_types["formal/f1"] == "application/pdf"


def test_mime_sniff_downgrades_disguised_active_content(env, headers):
    """伪装成安全类型的活动内容必须被降级为 octet-stream（防存储型 XSS）。"""
    client, fake, _ = env
    from app.mime_sniff import reconcile_content_type
    from app.storage import promote_staging

    # 中文注释：HTML 字节伪装成 image/png → 降级
    evil = b"<!DOCTYPE html><html><script>alert(1)</script></html>"
    fake.objects["staging/evil"] = evil
    size, digest, final_type = promote_staging(
        fake, "staging/evil", "formal/evil", expected_size=len(evil), content_type="image/png",
    )
    assert final_type == "application/octet-stream"
    assert fake.content_types["formal/evil"] == "application/octet-stream"
    # 中文注释：声明 text/html 但内容是 PDF → 降级
    type2, reason2 = reconcile_content_type("text/html", b"%PDF-1.7\n...")
    assert type2 == "application/octet-stream" and reason2
    # 中文注释：HTML 片段从 title 开始也属于有效网页，避免误降级
    type_html, reason_html = reconcile_content_type("text/html", b"<title>Report</title><style>body{color:black}</style>")
    assert type_html == "text/html" and reason_html is None
    # 中文注释：PNG 声明 PNG 内容 → 保持
    type3, reason3 = reconcile_content_type("image/png", b"\x89PNG\r\n\x1a\nxxxx")
    assert type3 == "image/png" and reason3 is None
    # 中文注释：无声明时按魔数识别
    type4, _ = reconcile_content_type(None, b"%PDF-1.4 rest")
    assert type4 == "application/pdf"
    # 中文注释：无法识别的自定义二进制保持声明
    type5, reason5 = reconcile_content_type("application/x-custom", b"\x00\x01\x02\x03")
    assert type5 == "application/x-custom" and reason5 is None


def test_upload_ready_object_keeps_declared_content_type(env, headers):
    """端到端：complete 后正式对象的媒体类型应与上传声明一致，供预览分支判定。"""
    client, fake, _ = env
    obj = upload_ready(client, fake, headers, name="paper.pdf", content_type="application/pdf")
    assert obj["content_type"] == "application/pdf"
    assert fake.content_types[obj["object_key"]] == "application/pdf"
