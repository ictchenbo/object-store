#!/usr/bin/env sh
# 中文注释：数据库迁移入口。生产库用 upgrade；已有 create_all 建出的库先 stamp head 再 upgrade。
# 用法:
#   sh scripts/migrate.sh            # 升级到最新
#   sh scripts/migrate.sh stamp      # 将当前库标记为已最新（仅限已用 create_all 建表的存量库）
#   sh scripts/migrate.sh current    # 查看当前版本
set -eu
cd "$(dirname "$0")/.."

MODE="${1:-upgrade}"

case "$MODE" in
  upgrade)
    echo "正在执行 alembic upgrade head ..."
    python -m alembic upgrade head
    echo "迁移完成。"
    ;;
  stamp)
    echo "正在将当前库标记为 alembic head（仅限已用 create_all 建表的存量库）..."
    python -m alembic stamp head
    echo "已标记。后续变更请用 upgrade。"
    ;;
  current)
    python -m alembic current
    ;;
  *)
    echo "用法: sh scripts/migrate.sh [upgrade|stamp|current]" >&2
    exit 1
    ;;
esac
