import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 中文注释：前端固定 18000 端口；开发态把 /api 与 /health 代理到本机 3000 的 FastAPI 服务。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 18000,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3000",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 18000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
