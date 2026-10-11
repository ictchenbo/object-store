"""阶段 4：身份/角色、分享链接、搜索排序、批量、去重、回收站恢复。"""
from datetime import timedelta

from sqlalchemy import func, select

from app.database import DocumentVersion, Job, ObjectRecord, utcnow
from app.worker import process_one

DATA_SHA256 = "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7"


def upload_ready(client, fake, headers, name="file.txt", purpose="standalone", tags=None, sha256=None, content_type="text/plain"):
    from uuid import uuid4

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


def published_document(client, fake, headers, external_id="doc-x", ingest_key="r1"):
    raw = upload_ready(client, fake, headers, name=f"{external_id}.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": external_id, "doc_type": "paper", "title": f"T-{external_id}", "ingest_key": ingest_key},
        headers=headers,
    ).json()
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw["id"]}, headers=headers,
    )
    assert completed.status_code == 200, completed.text
    return ingest["document_id"], raw


def set_immediate_purge(client, headers):
    response = client.put(
        "/api/v1/retention-policy",
        json={"deleted_object_purge_days": 0, "deleted_document_purge_days": 0},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def test_login_user_roles_and_viewer_readonly(env, headers):
    """用户登录签发 Bearer 会话；viewer 只读，admin 可写。"""
    client, fake, session_factory = env
    created = client.post(
        "/api/v1/users",
        json={"username": "alice", "password": "password123", "role": "admin"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    viewer = client.post(
        "/api/v1/users",
        json={"username": "bob", "password": "password123", "role": "viewer"},
        headers=headers,
    )
    assert viewer.status_code == 201
    # 中文注释：重复用户名 409
    assert client.post(
        "/api/v1/users",
        json={"username": "alice", "password": "password123", "role": "admin"},
        headers=headers,
    ).status_code == 409
    # 中文注释：登录失败 401
    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "wrong"}).status_code == 401
    login = client.post("/api/v1/auth/login", json={"username": "alice", "password": "password123"})
    assert login.status_code == 200, login.text
    token = login.json()["token"]
    assert login.json()["user"]["role"] == "admin"
    auth_headers = {"Authorization": f"Bearer {token}"}
    me = client.get("/api/v1/auth/me", headers=auth_headers)
    assert me.status_code == 200 and me.json()["role"] == "admin"
    # 中文注释：登录会话可执行写操作
    obj = upload_ready(client, fake, auth_headers, name="via-session.txt")
    assert obj["status"] == "ready"
    # 中文注释：viewer 登录后写操作 403，读操作正常
    vlogin = client.post("/api/v1/auth/login", json={"username": "bob", "password": "password123"})
    vheaders = {"Authorization": f"Bearer {vlogin.json()['token']}"}
    assert client.get("/api/v1/auth/me", headers=vheaders).json()["role"] == "viewer"
    assert client.get("/api/v1/objects", headers=vheaders).status_code == 200
    denied = client.post(
        "/api/v1/uploads",
        json={"display_name": "x.txt", "content_type": "text/plain", "expected_size": 1},
        headers={**vheaders, "Idempotency-Key": "viewer-try"},
    )
    assert denied.status_code == 403
    # 中文注释：logout 后 token 失效
    assert client.post("/api/v1/auth/logout", headers=auth_headers).status_code == 200
    assert client.get("/api/v1/auth/me", headers=auth_headers).status_code == 401


def test_share_links_lifecycle_and_public_access(env, headers):
    """分享链接：创建/公开访问/撤销/过期。"""
    client, fake, session_factory = env
    obj = upload_ready(client, fake, headers, name="shared.txt")
    created = client.post(
        "/api/v1/share-links",
        json={"target_type": "object", "target_id": obj["id"], "permission": "download", "expires_in_seconds": 3600},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    link = created.json()
    assert link["token"] and link["url"].endswith(link["token"])
    # 中文注释：公开元信息无需鉴权
    meta = client.get(f"/api/v1/public/share/{link['token']}")
    assert meta.status_code == 200
    assert meta.json()["display_name"] == "shared.txt"
    # 中文注释：download 权限可取下载 URL
    download = client.post(f"/api/v1/public/share/{link['token']}/download-url")
    assert download.status_code == 200 and "url" in download.json()
    # 中文注释：view 权限拒绝下载
    view_link = client.post(
        "/api/v1/share-links",
        json={"target_type": "object", "target_id": obj["id"], "permission": "view", "expires_in_seconds": 3600},
        headers=headers,
    ).json()
    assert client.post(f"/api/v1/public/share/{view_link['token']}/download-url").status_code == 403
    # 中文注释：撤销后公开访问 404
    assert client.delete(f"/api/v1/share-links/{link['id']}", headers=headers).status_code == 204
    assert client.get(f"/api/v1/public/share/{link['token']}").status_code == 404
    listed = client.get("/api/v1/share-links", headers=headers).json()
    assert len(listed["items"]) == 2
    assert any(item["revoked_at"] is not None for item in listed["items"])


def test_search_and_sort_on_objects_and_documents(env, headers):
    """列表搜索（q）与排序参数生效。"""
    client, fake, session_factory = env
    a = upload_ready(client, fake, headers, name="alpha-report.bin")
    upload_ready(client, fake, headers, name="beta-notes.bin")
    hit = client.get("/api/v1/objects", params={"q": "alpha"}, headers=headers).json()["items"]
    assert [item["id"] for item in hit] == [a["id"]]
    by_name = client.get("/api/v1/objects", params={"sort": "name_asc"}, headers=headers).json()["items"]
    assert [item["display_name"] for item in by_name] == ["alpha-report.bin", "beta-notes.bin"]
    # 中文注释：文档搜索命中 title/external_id
    published_document(client, fake, headers, external_id="search-target")
    docs = client.get("/api/v1/documents", params={"q": "search-target"}, headers=headers).json()["items"]
    assert len(docs) == 1
    empty = client.get("/api/v1/documents", params={"q": "不存在的关键字"}, headers=headers).json()["items"]
    assert empty == []
    # 中文注释：LIKE 通配符被转义，不产生全表误命中
    escaped = client.get("/api/v1/objects", params={"q": "%"}, headers=headers).json()["items"]
    assert escaped == []


def test_bulk_tag_and_bulk_delete_documents(env, headers):
    """批量打标签与批量软删。"""
    client, fake, session_factory = env
    doc1, _ = published_document(client, fake, headers, external_id="bulk-1")
    doc2, _ = published_document(client, fake, headers, external_id="bulk-2")
    tagged = client.post(
        "/api/v1/documents/bulk-tag",
        json={"target_ids": [doc1, doc2], "new_tag_names": ["批量标签"]},
        headers=headers,
    )
    assert tagged.status_code == 200, tagged.text
    assert {item["status"] for item in tagged.json()["items"]} == {"ok"}
    deleted = client.post(
        "/api/v1/documents/bulk-delete",
        json={"target_ids": [doc1, doc2]},
        headers=headers,
    )
    assert deleted.status_code == 202, deleted.text
    results = deleted.json()["items"]
    assert {item["status"] for item in results} == {"deleted"}
    trash = client.get("/api/v1/trash/documents", headers=headers).json()["items"]
    assert {item["id"] for item in trash} == {doc1, doc2}


def test_upload_dedup_reuses_ready_object(env, headers):
    """声明 sha256 + dedup=true 时复用同租户 ready 对象，不再存字节。"""
    client, fake, session_factory = env
    first = upload_ready(client, fake, headers, name="orig.bin", sha256=DATA_SHA256)
    assert first["sha256"] == DATA_SHA256
    before_keys = set(fake.objects.keys())
    created = client.post(
        "/api/v1/uploads",
        json={
            "display_name": "copy.bin", "content_type": "text/plain", "expected_size": 4,
            "sha256": DATA_SHA256, "dedup": True,
        },
        headers={**headers, "Idempotency-Key": "dedup-1"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body.get("deduped") is True
    assert body.get("object_id") == first["id"]
    assert body.get("upload_id") is None
    assert set(fake.objects.keys()) == before_keys, "去重后不应新增字节"


def test_object_restore_within_window_and_reject_after_purge(env, headers):
    """软删对象可恢复；永久删除后恢复接口拒绝。"""
    client, fake, session_factory = env
    obj = upload_ready(client, fake, headers, name="restore-me.bin")
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 202
    restored = client.post(f"/api/v1/objects/{obj['id']}/restore", json={"reason": "误删"}, headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "ready"
    # 中文注释：恢复后删除任务被取消，永久清除不再发生
    with session_factory() as session:
        assert session.scalar(select(func.count(Job.id)).where(Job.kind == "delete_object")) == 0
    # 中文注释：0 天窗口永久删除后不可恢复
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 202
    with session_factory() as session:
        process_one(session, fake)
    assert client.post(f"/api/v1/objects/{obj['id']}/restore", headers=headers).status_code == 409


def test_trash_objects_list_and_immediate_purge(env, headers):
    """对象回收站：软删对象可列出并立即永久清除。"""
    client, fake, session_factory = env
    obj = upload_ready(client, fake, headers, name="trash-obj.bin")
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 202
    trash = client.get("/api/v1/trash/objects", headers=headers).json()["items"]
    assert [item["id"] for item in trash] == [obj["id"]]
    assert trash[0]["deleted_at"] is not None and trash[0]["purge_after"] is not None
    # 中文注释：立即永久删除 → Worker 清字节
    purged = client.delete(f"/api/v1/trash/objects/{obj['id']}", headers=headers)
    assert purged.status_code == 202, purged.text
    with session_factory() as session:
        process_one(session, fake)
    assert fake.objects.get(obj["object_key"]) is None
    # 中文注释：已清除对象不在回收站，恢复拒绝
    assert client.get("/api/v1/trash/objects", headers=headers).json()["items"] == []
    assert client.post(f"/api/v1/objects/{obj['id']}/restore", headers=headers).status_code == 409


def test_trash_documents_exclude_purged_and_restore_rejects(env, headers):
    """文档回收站：永久清除后不可见、不可恢复。"""
    client, fake, session_factory = env
    doc_id, raw = published_document(client, fake, headers, external_id="trash-doc")
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/documents/{doc_id}", headers=headers).status_code == 202
    # 中文注释：清完 purge_document → delete_object 链路
    with session_factory() as session:
        for _ in range(10):
            if not process_one(session, fake):
                break
    assert client.get("/api/v1/trash/documents", headers=headers).json()["items"] == []
    assert client.post(f"/api/v1/documents/{doc_id}/restore", headers=headers).status_code == 409


def test_document_purge_marks_versions_purged_and_blocks_version_restore(env, headers):
    """文档永久清除后连带版本落 purged_at，版本恢复接口拒绝。"""
    client, fake, session_factory = env
    doc_id, raw = published_document(client, fake, headers, external_id="purge-ver")
    assert client.post(
        f"/api/v1/documents/{doc_id}/reclassify",
        json={"doc_type": "report", "reason": "换类型"}, headers=headers,
    ).status_code == 200
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/documents/{doc_id}", headers=headers).status_code == 202
    with session_factory() as session:
        for _ in range(10):
            if not process_one(session, fake):
                break
    versions = client.get(f"/api/v1/documents/{doc_id}/versions", headers=headers)
    # 中文注释：文档已删，版本列表接口 404（require_document 默认排除软删）
    assert versions.status_code == 404
    with session_factory() as session:
        rows = session.scalars(select(DocumentVersion).where(DocumentVersion.document_id == doc_id)).all()
        assert rows and all(row.purged_at is not None for row in rows)
    # 中文注释：0 天窗口下软删后、Worker 清除前也不可恢复
    doc2, _ = published_document(client, fake, headers, external_id="no-window", ingest_key="r2")
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/documents/{doc2}", headers=headers).status_code == 202
    assert client.post(f"/api/v1/documents/{doc2}/restore", headers=headers).status_code == 409


def test_version_retention_prune_keeps_current_and_recent(env, headers):
    """保留策略 keep_last_n 真生效：发布后 Worker 裁剪旧版本进回收站，当前版本保留。"""
    client, fake, session_factory = env
    doc_id, raw = published_document(client, fake, headers, external_id="prune-doc", ingest_key="v1")
    # 中文注释：再发两版（reclassify 会 append version），共 3 版
    for index, doc_type in enumerate(("report", "article"), start=2):
        raw_n = upload_ready(client, fake, headers, name=f"prune-{index}.pdf", purpose="document_internal")
        ingest = client.post(
            "/api/v1/ingest-sessions",
            json={"source": "crawler", "external_id": "prune-doc", "doc_type": "paper", "title": "T", "ingest_key": f"v{index}"},
            headers=headers,
        ).json()
        assert client.post(
            f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
            json={"raw_object_id": raw_n["id"]}, headers=headers,
        ).status_code == 200
    policy = client.put(
        "/api/v1/retention-policy",
        json={"version_retention": "keep_last_n", "version_retention_n": 1},
        headers=headers,
    )
    assert policy.status_code == 200, policy.text
    # 中文注释：发布新版本触发 prune_versions；再手动入队一次以覆盖已发布文档
    raw4 = upload_ready(client, fake, headers, name="prune-4.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "prune-doc", "doc_type": "paper", "title": "T", "ingest_key": "v4"},
        headers=headers,
    ).json()
    assert client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw4["id"]}, headers=headers,
    ).status_code == 200
    with session_factory() as session:
        for _ in range(10):
            if not process_one(session, fake):
                break
    versions = client.get(f"/api/v1/documents/{doc_id}/versions", headers=headers).json()["items"]
    by_no = {item["version_no"]: item for item in versions}
    assert by_no[4]["status"] == "ready"
    # 中文注释：keep_last_n=1 只留当前；v1-v3 进回收站（status=deleted 且有恢复窗口）
    assert by_no[3]["status"] == "deleted" and by_no[3]["purge_after"] is not None
    assert by_no[2]["status"] == "deleted"
    assert by_no[1]["status"] == "deleted"


def test_version_retention_keep_current_only_prunes_all_history(env, headers):
    """保留策略 keep_current_only：历史版本全部进回收站，只留当前。"""
    client, fake, session_factory = env
    doc_id, raw = published_document(client, fake, headers, external_id="only-cur", ingest_key="v1")
    for index, doc_type in enumerate(("report", "article"), start=2):
        raw_n = upload_ready(client, fake, headers, name=f"only-cur-{index}.pdf", purpose="document_internal")
        ingest = client.post(
            "/api/v1/ingest-sessions",
            json={"source": "crawler", "external_id": "only-cur", "doc_type": "paper", "title": "T", "ingest_key": f"v{index}"},
            headers=headers,
        ).json()
        assert client.post(
            f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
            json={"raw_object_id": raw_n["id"]}, headers=headers,
        ).status_code == 200
    policy = client.put(
        "/api/v1/retention-policy",
        json={"version_retention": "keep_current_only"},
        headers=headers,
    )
    assert policy.status_code == 200, policy.text
    # 中文注释：再发一版触发 prune_versions
    raw4 = upload_ready(client, fake, headers, name="only-cur-4.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "only-cur", "doc_type": "paper", "title": "T", "ingest_key": "v4"},
        headers=headers,
    ).json()
    assert client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw4["id"]}, headers=headers,
    ).status_code == 200
    with session_factory() as session:
        for _ in range(10):
            if not process_one(session, fake):
                break
    versions = client.get(f"/api/v1/documents/{doc_id}/versions", headers=headers).json()["items"]
    by_no = {item["version_no"]: item for item in versions}
    assert by_no[4]["status"] == "ready"
    for no in (1, 2, 3):
        assert by_no[no]["status"] == "deleted", f"v{no} 应被 keep_current_only 裁剪"
        assert by_no[no]["purge_after"] is not None


def test_share_link_rejects_deleted_or_pending_object(env, headers):
    """软删/未就绪对象不可新建分享链接（避免死链）。"""
    client, fake, session_factory = env
    obj = upload_ready(client, fake, headers, name="share-guard.bin")
    assert client.delete(f"/api/v1/objects/{obj['id']}", headers=headers).status_code == 202
    rejected = client.post(
        "/api/v1/share-links",
        json={"target_type": "object", "target_id": obj["id"], "permission": "download", "expires_in_seconds": 3600},
        headers=headers,
    )
    assert rejected.status_code == 409, rejected.text
    # 中文注释：恢复后可正常分享
    assert client.post(f"/api/v1/objects/{obj['id']}/restore", json={"reason": "误删"}, headers=headers).status_code == 200
    created = client.post(
        "/api/v1/share-links",
        json={"target_type": "object", "target_id": obj["id"], "permission": "download", "expires_in_seconds": 3600},
        headers=headers,
    )
    assert created.status_code == 201, created.text


def test_reingest_blocked_while_in_trash_and_freed_after_purge(env, headers):
    """软删占用 (source, external_id) 槽位时拒绝重采集；永久清除后槽位释放可再采。"""
    client, fake, session_factory = env
    doc_id, raw = published_document(client, fake, headers, external_id="slot-doc", ingest_key="v1")
    assert client.delete(f"/api/v1/documents/{doc_id}", headers=headers).status_code == 202
    # 中文注释：回收站窗口内同 external_id 重采集 409
    blocked = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "slot-doc", "doc_type": "paper", "title": "T", "ingest_key": "v2"},
        headers=headers,
    )
    assert blocked.status_code == 409, blocked.text
    # 中文注释：立即永久清除后身份槽位释放，可作为新文档再采
    set_immediate_purge(client, headers)
    assert client.delete(f"/api/v1/trash/documents/{doc_id}", headers=headers).status_code == 202
    with session_factory() as session:
        for _ in range(10):
            if not process_one(session, fake):
                break
    raw2 = upload_ready(client, fake, headers, name="slot-doc-again.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "slot-doc", "doc_type": "paper", "title": "T-new", "ingest_key": "v2"},
        headers=headers,
    )
    assert ingest.status_code == 201, ingest.text
    completed = client.post(
        f"/api/v1/ingest-sessions/{ingest.json()['ingest_session_id']}/complete",
        json={"raw_object_id": raw2["id"]}, headers=headers,
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["id"] != doc_id
    # 中文注释：旧文档身份存档在 attrs，便于审计追溯
    with session_factory() as session:
        from app.database import Document

        old = session.get(Document, doc_id)
        assert old is not None and old.purged_at is not None
        assert old.attrs.get("purged_external_id") == "slot-doc"


def test_soft_deleted_version_keeps_object_reference(env, headers):
    """软删版本在恢复窗口内仍持有对象引用，孤儿回收不得提前清字节。"""
    client, fake, session_factory = env
    doc_id, raw = published_document(client, fake, headers, external_id="hold-ref", ingest_key="v1")
    # 中文注释：发 v2 后可软删 v1（当前版本受保护）
    raw2 = upload_ready(client, fake, headers, name="hold-ref-2.pdf", purpose="document_internal")
    ingest = client.post(
        "/api/v1/ingest-sessions",
        json={"source": "crawler", "external_id": "hold-ref", "doc_type": "paper", "title": "T", "ingest_key": "v2"},
        headers=headers,
    ).json()
    assert client.post(
        f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
        json={"raw_object_id": raw2["id"]}, headers=headers,
    ).status_code == 200
    assert client.delete(f"/api/v1/documents/{doc_id}/versions/1", headers=headers).status_code == 202
    # 中文注释：把两个对象都老化到宽限期之外，触发孤儿回收
    with session_factory() as session:
        for object_id in (raw["id"], raw2["id"]):
            obj = session.get(ObjectRecord, object_id)
            obj.ready_at = utcnow() - timedelta(hours=100)
            session.commit()
        from app.reconcile import reclaim_orphans

        assert reclaim_orphans(session, fake) == 0
        assert session.get(ObjectRecord, raw["id"]).status == "ready"
    # 中文注释：v1 仍可恢复（字节还在）
    restored = client.post(f"/api/v1/documents/{doc_id}/versions/1/restore", headers=headers)
    assert restored.status_code == 200, restored.text
    assert fake.objects.get(raw["object_key"]) == b"data"


def test_document_purge_keeps_objects_shared_with_other_document(env, headers):
    """文档永久清除不得删除仍被其他文档版本引用的共享对象。"""
    client, fake, session_factory = env
    # 中文注释：同一 document_internal 对象被两份文档的版本引用
    shared = upload_ready(client, fake, headers, name="shared-raw.pdf", purpose="document_internal")
    for external_id, ingest_key in (("share-a", "r1"), ("share-b", "r1")):
        ingest = client.post(
            "/api/v1/ingest-sessions",
            json={"source": "crawler", "external_id": external_id, "doc_type": "paper", "title": "T", "ingest_key": ingest_key},
            headers=headers,
        ).json()
        assert client.post(
            f"/api/v1/ingest-sessions/{ingest['ingest_session_id']}/complete",
            json={"raw_object_id": shared["id"]}, headers=headers,
        ).status_code == 200
    set_immediate_purge(client, headers)
    docs = client.get("/api/v1/documents", params={"q": "share-"}, headers=headers).json()["items"]
    assert {item["external_id"] for item in docs} == {"share-a", "share-b"}
    target = next(item["id"] for item in docs if item["external_id"] == "share-a")
    keep_id = next(item["id"] for item in docs if item["external_id"] == "share-b")
    assert client.delete(f"/api/v1/documents/{target}", headers=headers).status_code == 202
    with session_factory() as session:
        for _ in range(10):
            if not process_one(session, fake):
                break
    # 中文注释：共享对象仍在，文档 share-b 完好
    assert fake.objects.get(shared["object_key"]) == b"data"
    kept = client.get(f"/api/v1/documents/{keep_id}", headers=headers)
    assert kept.status_code == 200, kept.text
