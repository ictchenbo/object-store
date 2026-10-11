import unicodedata
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import DocumentTag, ObjectTag, Tag
from app.schemas import TagInput


def normalize_name(value: str) -> tuple[str, str]:
    name = unicodedata.normalize("NFC", value.strip())
    normalized = unicodedata.normalize("NFC", name.casefold())
    if not name or len(name) > 80 or len(normalized) > 80:
        raise HTTPException(422, "标签名称必须为 1–80 个字符")
    return name, normalized


def insert_ignore(session: Session, model, values: dict, columns: list[str]) -> None:
    # 中文注释：由数据库唯一约束裁决并发同名创建，避免先查后写竞态。
    dialect = session.bind.dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        raise RuntimeError(f"不支持的数据库方言: {dialect}")
    session.execute(insert(model).values(**values).on_conflict_do_nothing(index_elements=columns))


def bind_tags(
    session: Session, tenant_id: str, target_id: str, kind: str, payload: TagInput
) -> list[dict]:
    if kind not in {"object", "document"}:
        raise ValueError("未知标签目标")
    tag_ids = set(payload.tag_ids)
    if tag_ids:
        rows = session.scalars(select(Tag).where(Tag.tenant_id == tenant_id, Tag.id.in_(tag_ids), Tag.active)).all()
        if len(rows) != len(tag_ids):
            raise HTTPException(422, "标签不存在、已停用或不属于当前租户")
    for raw_name in payload.new_tag_names:
        name, normalized = normalize_name(raw_name)
        insert_ignore(
            session,
            Tag,
            {"id": str(uuid4()), "tenant_id": tenant_id, "name": name, "normalized_name": normalized, "active": True},
            ["tenant_id", "normalized_name"],
        )
        tag = session.scalar(select(Tag).where(Tag.tenant_id == tenant_id, Tag.normalized_name == normalized))
        if tag is None or not tag.active:
            raise HTTPException(409, "标签已停用")
        tag_ids.add(tag.id)
    relation = ObjectTag if kind == "object" else DocumentTag
    id_field = "object_id" if kind == "object" else "document_id"
    for tag_id in tag_ids:
        insert_ignore(
            session,
            relation,
            {"tenant_id": tenant_id, id_field: target_id, "tag_id": tag_id},
            ["tenant_id", id_field, "tag_id"],
        )
    return get_tags(session, tenant_id, target_id, kind)


def get_tags(session: Session, tenant_id: str, target_id: str, kind: str) -> list[dict]:
    relation = ObjectTag if kind == "object" else DocumentTag
    target_col = relation.object_id if kind == "object" else relation.document_id
    rows = session.execute(
        select(Tag.id, Tag.name)
        .join(relation, relation.tag_id == Tag.id)
        .where(relation.tenant_id == tenant_id, target_col == target_id)
        .order_by(Tag.name)
    ).all()
    return [{"id": tag_id, "name": name} for tag_id, name in rows]


def filtered_target_ids(session: Session, tenant_id: str, kind: str, name: str | None, ids: list[str], mode: str):
    relation = ObjectTag if kind == "object" else DocumentTag
    target_col = relation.object_id if kind == "object" else relation.document_id
    if name and ids:
        raise HTTPException(400, "tag 与 tag_ids 不能同时使用")
    if name:
        _, normalized = normalize_name(name)
        tag = session.scalar(select(Tag).where(Tag.tenant_id == tenant_id, Tag.normalized_name == normalized))
        ids = [tag.id] if tag else []
        if not ids:
            return select(target_col).where(False)
    if not ids:
        return None
    unique_ids = set(ids)
    known = session.scalars(select(Tag.id).where(Tag.tenant_id == tenant_id, Tag.id.in_(unique_ids))).all()
    if len(known) != len(unique_ids):
        return select(target_col).where(False)
    query = select(target_col).where(relation.tenant_id == tenant_id, relation.tag_id.in_(unique_ids))
    if mode == "all":
        query = query.group_by(target_col).having(func.count(func.distinct(relation.tag_id)) == len(unique_ids))
    return query
