#!/bin/sh
# 中文注释：按 TLS_ENABLED / FORCE_HTTPS 选择 nginx 配置模板。
# 证书缺失时回退 HTTP 并告警，避免容器启动失败导致整栈不可用。
set -eu

if [ "${TLS_ENABLED:-false}" = "true" ]; then
  if [ -f /certs/fullchain.pem ] && [ -f /certs/privkey.pem ]; then
    if [ "${FORCE_HTTPS:-false}" = "true" ]; then
      cp /etc/nginx/templates-src/nginx.tls-redirect.conf /etc/nginx/conf.d/default.conf
      echo "TLS 已启用（HTTPS 强制跳转）"
    else
      cp /etc/nginx/templates-src/nginx.tls.conf /etc/nginx/conf.d/default.conf
      echo "TLS 已启用（HTTP/HTTPS 并存）"
    fi
  else
    echo "警告: TLS_ENABLED=true 但 /certs 缺少 fullchain.pem/privkey.pem，回退 HTTP 配置" >&2
    cp /etc/nginx/templates-src/nginx.conf /etc/nginx/conf.d/default.conf
  fi
else
  cp /etc/nginx/templates-src/nginx.conf /etc/nginx/conf.d/default.conf
fi

# 中文注释：预览字节由浏览器从公开 MinIO 地址读取，只放行此来源。
minio_endpoint="${MINIO_PUBLIC_ENDPOINT:-127.0.0.1:9000}"
if ! printf '%s' "$minio_endpoint" | grep -Eq '^[A-Za-z0-9.:-]+$'; then
  echo "MINIO_PUBLIC_ENDPOINT 格式无效，无法生成预览 CSP" >&2
  exit 1
fi
minio_scheme=http
if [ "${MINIO_SECURE:-false}" = "true" ]; then
  minio_scheme=https
fi
minio_origin="${minio_scheme}://${minio_endpoint}"
sed -i "s|__MINIO_CSP_ORIGIN__|${minio_origin}|g" /etc/nginx/conf.d/default.conf
