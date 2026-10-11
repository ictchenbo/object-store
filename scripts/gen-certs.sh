#!/usr/bin/env sh
# 中文注释：生成本地自签证书（certs/），仅供 TLS_ENABLED=true 的本地验证。
# 生产环境请使用受信任 CA 签发证书或在反代终止 TLS。
set -eu
cd "$(dirname "$0")/.."
mkdir -p certs
if [ -f certs/fullchain.pem ] && [ -f certs/privkey.pem ] && [ "${FORCE_REGEN:-0}" != "1" ]; then
  echo "certs/ 已存在证书；如需重新生成请 FORCE_REGEN=1 运行。"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -days 365 -nodes \
  -keyout certs/privkey.pem -out certs/fullchain.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "已生成自签证书: certs/fullchain.pem certs/privkey.pem（CN=localhost，365 天）"
