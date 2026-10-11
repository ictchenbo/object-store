#!/usr/bin/env sh
# 中文注释：备份 PostgreSQL（pg_dump -Fc）与 MinIO 对象（mc mirror），并写 sha256 清单。
# 用法: sh scripts/backup.sh [输出目录]   # 默认 var/backup/YYYYmmddTHHMMSSZ
set -eu
cd "$(dirname "$0")/.."

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_DIR="${1:-var/backup/$STAMP}"
mkdir -p "$OUT_DIR"

# 中文注释：从 .env 读取连接信息；缺失时给出明确错误而不是静默用弱默认
if [ ! -f .env ]; then
  echo "错误: 缺少 .env，无法确定备份源。" >&2
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

echo "== 备份 PostgreSQL =="
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -Fc \
  -f "$OUT_DIR/postgres.dump"

echo "== 备份 MinIO 对象 =="
mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mirror "$MINIO_ALIAS/$MINIO_BUCKET" "$OUT_DIR/objects" >/dev/null

echo "== 生成 sha256 清单 =="
MANIFEST="$OUT_DIR/backup-manifest.json"
# 中文注释：清单内路径相对备份目录，便于 restore.sh 校验时直接 sha256sum -c
(
  cd "$OUT_DIR"
  {
    printf '{\n  "created_at": "%s",\n  "files": {\n' "$STAMP"
    find . -type f ! -name backup-manifest.json ! -name .sha256check -print0 \
      | xargs -0 sha256sum \
      | awk '{printf "    \"%s\": \"%s\",\n", $2, $1}' \
      | sed '$ s/,$//'
    printf '\n  }\n}\n'
  } > backup-manifest.json
)

echo "备份完成: $OUT_DIR"
echo "清单: $MANIFEST"
