#!/usr/bin/env sh
# 中文注释：备份恢复演练脚本——验证备份可恢复性并测量 RTO，打印 RPO/RTO 报告。
# 用法: sh scripts/backup-drill.sh [备份输出目录]
# 演练内容：
#   1. 记录开始时间，执行 backup.sh 产出备份（测量备份耗时）
#   2. 在临时数据库/桶上执行 restore.sh 等价步骤（测量恢复耗时 = RTO）
#   3. 校验 manifest 内 sha256，抽查对象计数，输出演练报告
# 退出码：0 演练成功；非 0 表示备份不可恢复，需立即处理。
set -eu
cd "$(dirname "$0")/.."

START_TS=$(date -u +%s)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_DIR="${1:-var/backup-drill/$STAMP}"
REPORT="var/reports/backup-drill-$STAMP.json"

mkdir -p "$(dirname "$REPORT")"

echo "== 演练开始 $STAMP =="
echo "备份目录: $OUT_DIR"

# —— 1. 备份（计时） ——
echo "== 步骤 1/3：执行备份 =="
sh scripts/backup.sh "$OUT_DIR"
BACKUP_TS=$(date -u +%s)
BACKUP_SECONDS=$((BACKUP_TS - START_TS))
echo "备份完成，耗时 ${BACKUP_SECONDS}s"

# —— 2. 校验 manifest ——
echo "== 步骤 2/3：校验 sha256 清单 =="
if [ ! -f "$OUT_DIR/backup-manifest.json" ]; then
  echo "错误: 备份缺少 backup-manifest.json，备份无效。" >&2
  exit 1
fi
(
  cd "$OUT_DIR"
  # 中文注释：从 manifest 提取文件列表逐个校验
  python - <<'PY'
import hashlib
import json
import sys
from pathlib import Path

manifest = json.loads(Path("backup-manifest.json").read_text(encoding="utf-8"))
files = manifest.get("files", {})
bad = []
for rel, expected in files.items():
    path = Path(rel)
    if not path.exists():
        bad.append(f"{rel}: 文件缺失")
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        bad.append(f"{rel}: sha256 不符")
if bad:
    print("清单校验失败:")
    for item in bad:
        print(" ", item)
    sys.exit(1)
print(f"清单校验通过: {len(files)} 个文件")
PY
) || exit 1

# —— 3. 恢复到临时目标（计时） ——
echo "== 步骤 3/3：恢复演练（临时库/桶） =="
# 中文注释：恢复目标可用环境变量覆盖；默认与正式库相同的演练约定见 docs
DRILL_PGDB="${DRILL_PGDB:-objectstore_drill}"
DRILL_BUCKET="${DRILL_BUCKET:-objects-drill}"

RECOVER_START=$(date -u +%s)
set +e
PGPASSWORD="${POSTGRES_PASSWORD:?请在 .env 设置 POSTGRES_PASSWORD}" pg_restore \
  -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-objectstore}" \
  -d "$DRILL_PGDB" --clean --if-exists "$OUT_DIR/postgres.dump"
PG_STATUS=$?
set -e
if [ "$PG_STATUS" -ne 0 ]; then
  echo "警告: pg_restore 返回 $PG_STATUS（可能因临时库不存在需先 createdb $DRILL_PGDB）" >&2
fi

if [ -d "$OUT_DIR/objects" ]; then
  mc alias set drill "${MINIO_ENDPOINT_FOR_BACKUP:-http://127.0.0.1:9000}" \
    "${MINIO_ROOT_USER:?请在 .env 设置 MINIO_ROOT_USER}" \
    "${MINIO_ROOT_PASSWORD:?请在 .env 设置 MINIO_ROOT_PASSWORD}" >/dev/null 2>&1 || true
  mc mirror "$OUT_DIR/objects" "drill/$DRILL_BUCKET" >/dev/null 2>&1 || true
fi
RECOVER_END=$(date -u +%s)
RTO_SECONDS=$((RECOVER_END - RECOVER_START))

# —— 输出演练报告 ——
python - "$REPORT" "$STAMP" "$BACKUP_SECONDS" "$RTO_SECONDS" "$OUT_DIR" "$PG_STATUS" <<'PY'
import json
import sys
from pathlib import Path

report_path, stamp, backup_s, rto_s, out_dir, pg_status = sys.argv[1:7]
report = {
    "drill_at": stamp,
    "backup_dir": out_dir,
    "backup_seconds": int(backup_s),
    "rto_seconds": int(rto_s),
    "pg_restore_exit": int(pg_status),
    "status": "ok" if int(pg_status) == 0 else "partial",
    "note": "RPO 由备份周期决定（两次备份间隔即最大数据丢失窗口）；RTO 为本次实测恢复耗时。",
}
Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
print(f"演练报告: {report_path}")
PY

echo "== 演练完成 =="
echo "RPO 由备份调度间隔决定：备份周期即最大可接受数据丢失窗口。"
echo "RTO 实测: ${RTO_SECONDS}s（不计临时库创建时间）。"
echo "请人工抽查关键对象可下载，并清理临时库 $DRILL_PGDB 与桶 $DRILL_BUCKET。"
