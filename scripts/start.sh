#!/usr/bin/env sh
# 中文注释：一键启动。启动前校验凭据强度，启动后等待 API 就绪。
set -eu
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已创建 .env；请先填写强密码与 API Key，再运行此脚本。" >&2
  exit 1
fi

# 中文注释：弱凭据防线；本地调试可用 ALLOW_INSECURE=1 跳过
if [ "${ALLOW_INSECURE:-0}" != "1" ]; then
  if grep -Eiq 'change-me|dev-key|minioadmin' .env; then
    echo "错误: .env 中仍含弱占位凭据（change-me / dev-key / minioadmin）。" >&2
    echo "请更换为强随机值后重试；仅本地调试可 ALLOW_INSECURE=1 跳过。" >&2
    exit 1
  fi
  for var in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD MINIO_APP_PASSWORD; do
    if grep -Eq "^${var}=\s*$" .env; then
      echo "错误: .env 中 ${var} 为空。" >&2
      exit 1
    fi
  done
fi

# 中文注释：启用 TLS 且证书缺失时自动生成自签证书
if grep -Eq '^TLS_ENABLED=true' .env 2>/dev/null; then
  if [ ! -f certs/fullchain.pem ] || [ ! -f certs/privkey.pem ]; then
    echo "TLS_ENABLED=true 且证书缺失，正在生成自签证书..."
    sh scripts/gen-certs.sh
  fi
fi

docker compose up -d --build

# 中文注释：等待 API 就绪后再返回，避免用户过早访问
echo "等待 API 就绪..."
i=0
until curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "错误: API 就绪等待超时，请查看 docker compose logs api" >&2
    exit 1
  fi
  sleep 2
done

echo "启动完成。"
echo "前端:   http://localhost:18000"
echo "API:    http://127.0.0.1:3000/docs"
echo "MinIO:  http://127.0.0.1:9001 (Console)"
if grep -Eq '^TLS_ENABLED=true' .env 2>/dev/null; then
  echo "HTTPS:  https://localhost:18443"
fi
