"""PostgreSQL 专属并发语义测试（FOR UPDATE SKIP LOCKED）。

SQLite 不支持 SKIP LOCKED，无法在默认单测中验证并发拾取互斥；
标记 @pytest.mark.pg，需设置 TEST_DATABASE_URL 指向真实 PostgreSQL 后手动执行：
    TEST_DATABASE_URL=postgresql+psycopg2://... pytest -m pg -q
"""
import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.database import Job, ObjectRecord
from app.worker import process_one


pytestmark = pytest.mark.pg


@pytest.fixture
def pg_env():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("未设置 TEST_DATABASE_URL，跳过 PostgreSQL 专属测试")
    engine = create_engine(url, pool_pre_ping=True)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    class _Storage:
        def remove(self, _key):
            return None

    yield session_factory, _Storage()
    engine.dispose()


def test_skip_locked_lets_second_worker_take_next_job(pg_env):
    """两个 worker 并发拾取时互不阻塞，各自拿到不同任务。"""
    session_factory, storage = pg_env
    with session_factory() as session:
        for i in range(2):
            obj_id = str(uuid4())
            session.add(ObjectRecord(
                id=obj_id, tenant_id="tenant-a", purpose="standalone", bucket="objects",
                object_key=f"objects/tenant-a/{obj_id}", display_name=f"o{i}",
                size_bytes=1, content_type="application/octet-stream", status="deleting",
            ))
            session.add(Job(
                id=str(uuid4()), tenant_id="tenant-a", kind="delete_object",
                target_id=obj_id, status="pending",
            ))
        session.commit()

    picked: list[str] = []
    for _ in range(2):
        with session_factory() as session:
            assert process_one(session, storage)
            done = session.scalars(select(Job).where(Job.status == "done")).all()
            picked.extend(job.target_id for job in done)
    assert len(set(picked)) == 2
