#!/usr/bin/env sh
# 中文注释：从备份目录恢复。先 PostgreSQL 后 MinIO，最后跑一次只读对账确认一致性。
# 用法: sh scripts/restore.sh <备份目录>
set -eu
cd "$(dirname "$0")/.."

BACKUP_DIR="${1:-}"
if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "用法: sh scripts/restore.sh <备份目录>" >&2
  exit 1
fi
if [ ! -f "$BACKUP_DIR/postgres.dump" ]; then
  echo "错误: $BACKUP_DIR 下缺少 postgres.dump" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "错误: 缺少 .env，无法确定恢复目标。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${POSTGRES_PASSWORD:?请在 .env 设置 POSTGRES_PASSWORD}"
: "${MINIO_ROOT_USER:?请在 .env 设置 MINIO_ROOT_USER}"
: "${MINIO_ROOT_PASSWORD:?请在 .env 设置 MINIO_ROOT_PASSWORD}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-objectstore}"
PGDB="${PGDB:-objectstore}"
MINIO_ALIAS="${MINIO_ALIAS:-local}"
MINIO_ENDPOINT="${MINIO_ENDPOINT_FOR_BACKUP:-http://127.0.0.1:9000}"
MINIO_BUCKET="${MINIO_BUCKET:-objects}"

echo "== 校验清单 =="
if [ -f "$BACKUP_DIR/backup-manifest.json" ]; then
  # 中文注释：转成 sha256sum -c 格式后校验；POSIX sh 不用进程替换
  CHECK_FILE="$BACKUP_DIR/.sha256check"
  python -c '
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    for path, digest in data.get("files", {}).items():
        handle.write(f"{digest}  {path}\n")
' "$BACKUP_DIR/backup-manifest.json" "$CHECK_FILE"
  (cd "$BACKUP_DIR" && sha256sum -c --quiet .sha256check) || {
    echo "错误: 备份清单校验失败，中止恢复。" >&2
    exit 1
  }
  rm -f "$CHECK_FILE"
else
  echo "警告: 未找到 backup-manifest.json，跳过校验。" >&2
fi

echo "== 恢复 PostgreSQL（覆盖目标库）=="
PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" \
  --clean --if-exists "$BACKUP_DIR/postgres.dump"

echo "== 恢复 MinIO 对象 =="
mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
if [ -d "$BACKUP_DIR/objects" ]; then
  mc mirror "$BACKUP_DIR/objects" "$MINIO_ALIAS/$MINIO_BUCKET" >/dev/null
else
  echo "警告: 备份目录无 objects/，跳过对象恢复。" >&2
fi

echo "== 恢复后只读对账 =="
python - <<'PY'
from sqlalchemy.orm import Session

from app.database import get_engine, init_database
from app.reconcile import run_reconcile
from app.storage import get_storage

try:
    engine = get_engine()
    init_database(engine)
    with Session(engine) as session:
        result = run_reconcile(session, get_storage())
    print("对账 counts:", result.get("counts"), "report:", result.get("report_path"))
except Exception as exc:  # 中文注释：对账失败不回滚恢复，只提示人工介入
    print("对账执行失败（恢复已完成，请人工核对）:", exc)
PY

echo "恢复完成。请人工抽查关键对象可下载后再开放流量。"
