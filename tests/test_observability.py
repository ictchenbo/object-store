"""阶段 4：健康探针、指标与错误信封契约。"""
from app.storage import StorageError, get_storage


def test_health_live_alias(env, headers):
    client, fake, _ = env
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/health/live").json() == {"status": "ok"}


def test_health_ready_reports_checks(env, headers):
    client, fake, _ = env
    response = client.get("/health/ready", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["checks"]["database"] == "ok"
    assert body["checks"]["storage"] == "ok"
    # 中文注释：存储不可用时就绪探针降级为 503，便于编排摘流
    fake.fail_ensure_bucket = True
    degraded = client.get("/health/ready", headers=headers)
    assert degraded.status_code == 503
    assert degraded.json()["status"] == "degraded"
    assert degraded.json()["checks"]["database"] == "ok"
    assert "error" in degraded.json()["checks"]["storage"]


def test_metrics_exposes_request_and_job_series(env, headers):
    client, fake, _ = env
    client.get("/health", headers=headers)
    response = client.get("/metrics", headers=headers)
    assert response.status_code == 200
    text = response.text
    assert "http_requests_total" in text
    assert "http_request_duration_ms_sum" in text
    assert "jobs_queue_depth" in text
    assert 'jobs_queue_depth{status="pending"}' in text
    assert 'path="/health"' in text or 'path="/metrics"' in text
    # 中文注释：库侧持久化 gauge 补强（重启不丢）
    assert "objects_total" in text
    assert "documents_total" in text
    assert 'trash_items{kind="document"}' in text
    assert 'trash_items{kind="object"}' in text


def test_error_envelope_codes(env, headers):
    client, fake, _ = env
    # 401 缺少密钥
    unauthorized = client.get("/api/v1/objects")
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "HTTP_401"
    assert unauthorized.json()["request_id"]
    # 404 资源不存在
    missing = client.get("/api/v1/objects/nope", headers=headers)
    assert missing.status_code == 404
    assert missing.json()["code"] == "HTTP_404"
    # 422 校验失败（expected_size 必须 > 0）
    invalid = client.post(
        "/api/v1/uploads",
        json={"display_name": "x", "content_type": "text/plain", "expected_size": 0},
        headers={**headers, "Idempotency-Key": "env-422"},
    )
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "VALIDATION_ERROR"
    # 409 状态冲突：文档内部对象不能直接删除
    created = client.post(
        "/api/v1/uploads",
        json={"display_name": "d.bin", "content_type": "application/octet-stream", "expected_size": 4,
              "purpose": "document_internal"},
        headers={**headers, "Idempotency-Key": "env-409"},
    ).json()
    fake.objects[created["upload_url"].removeprefix("fake://upload/")] = b"data"
    ready = client.post(f"/api/v1/uploads/{created['upload_id']}/complete", headers=headers).json()
    conflict = client.delete(f"/api/v1/objects/{ready['id']}", headers=headers)
    assert conflict.status_code == 403
    assert conflict.json()["code"] == "HTTP_403"
    # 503 存储不可用
    class BrokenStorage:
        def upload_url(self, _key, _ttl):
            raise StorageError("down")

        def ensure_bucket(self):
            raise StorageError("down")

    client.app.dependency_overrides[get_storage] = lambda: BrokenStorage()
    try:
        unavailable = client.post(
            "/api/v1/uploads",
            json={"display_name": "s.bin", "content_type": "application/octet-stream", "expected_size": 4},
            headers={**headers, "Idempotency-Key": "env-503"},
        )
        assert unavailable.status_code == 503
        assert unavailable.json()["code"] == "STORAGE_UNAVAILABLE"
        assert unavailable.json()["request_id"]
    finally:
        client.app.dependency_overrides.pop(get_storage, None)
