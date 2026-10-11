#!/usr/bin/env sh
# 中文注释：一键停止。等待在途请求收尾后移除容器；命名卷（pg_data/minio_data）保留。
set -eu
cd "$(dirname "$0")/.."

echo "正在停止服务（给在途请求 10 秒收尾）..."
docker compose stop --timeout 10
docker compose down --remove-orphans
echo "已停止全部服务（前端 / API / Worker / PostgreSQL / MinIO）。数据卷已保留。"
