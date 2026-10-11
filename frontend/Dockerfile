# 构建阶段：编译 TypeScript + Vite 产物
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# 中文注释：使用 ci 保证依赖版本与锁文件一致，构建可复现
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# 运行阶段：Nginx 托管静态资源并代理 /api
FROM nginx:1.27-alpine
# 中文注释：配置模板由 40-configure-tls.sh 按 TLS_ENABLED 选择后写入 conf.d
COPY nginx.conf nginx.tls.conf nginx.tls-redirect.conf /etc/nginx/templates-src/
COPY 40-configure-tls.sh /docker-entrypoint.d/40-configure-tls.sh
RUN chmod +x /docker-entrypoint.d/40-configure-tls.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 18000 18443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:18000/ || exit 1
