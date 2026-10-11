import * as React from "react";
import { InfoHintProvider } from "@/components/ui/info-hint";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/toaster";
import { toast } from "./components/ui/use-toast";
import { UNAUTHORIZED_EVENT, loadApiKey, loadSessionToken } from "./lib/api";
import { AuthProvider } from "./hooks/use-auth";
// 中文注释：按路由加载页面，减少登录页和控制台首屏需要下载的代码。
const AuditPage = React.lazy(() => import("./pages/AuditPage").then((module) => ({ default: module.AuditPage })));
const DashboardPage = React.lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const DocumentsPage = React.lazy(() => import("./pages/DocumentsPage").then((module) => ({ default: module.DocumentsPage })));
const DocumentDetailPage = React.lazy(() => import("./pages/DocumentDetailPage").then((module) => ({ default: module.DocumentDetailPage })));
const IngestPage = React.lazy(() => import("./pages/IngestPage").then((module) => ({ default: module.IngestPage })));
const JobsPage = React.lazy(() => import("./pages/JobsPage").then((module) => ({ default: module.JobsPage })));
const LoginPage = React.lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const ObjectDetailPage = React.lazy(() => import("./pages/ObjectDetailPage").then((module) => ({ default: module.ObjectDetailPage })));
const ObjectsPage = React.lazy(() => import("./pages/ObjectsPage").then((module) => ({ default: module.ObjectsPage })));
const SettingsPage = React.lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const TagsPage = React.lazy(() => import("./pages/TagsPage").then((module) => ({ default: module.TagsPage })));
const TrashPage = React.lazy(() => import("./pages/TrashPage").then((module) => ({ default: module.TrashPage })));

/**
 * 全局 401 监听：
 * - 有会话 token（或未配置 API Key）→ 跳登录页重新登录；
 * - 纯 API Key 场景 → 跳设置页重新配置 Key。
 */
function UnauthorizedRedirect() {
  const navigate = useNavigate();
  React.useEffect(() => {
    function onUnauthorized(event: Event) {
      const detail = (event as CustomEvent<{ message?: string }>).detail || {};
      const useLogin = Boolean(loadSessionToken()) || !loadApiKey();
      toast({
        title: "鉴权失败",
        description: detail.message || (useLogin ? "会话无效或已过期，请重新登录" : "API Key 无效或已过期，请在设置页重新配置"),
        tone: "destructive",
      });
      navigate(useLogin ? "/login" : "/settings");
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate]);
  return null;
}

/** 路由表：登录 / 总览 / 对象 / 文档 / 入库 / 标签 / 任务 / 审计 / 回收站 / 设置 */
export default function App() {
  return (
    <InfoHintProvider>
      <BrowserRouter>
        <AuthProvider>
          <UnauthorizedRedirect />
          <React.Suspense fallback={<div role="status" className="p-6 text-sm text-muted-foreground">页面加载中…</div>}>
            <Routes>
              <Route path="login" element={<LoginPage />} />
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="objects" element={<ObjectsPage />} />
                <Route path="objects/:objectId" element={<ObjectDetailPage />} />
                <Route path="documents" element={<DocumentsPage />} />
                <Route path="documents/:documentId" element={<DocumentDetailPage />} />
                <Route path="ingest" element={<IngestPage />} />
                <Route path="tags" element={<TagsPage />} />
                <Route path="jobs" element={<JobsPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="trash" element={<TrashPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </React.Suspense>
          <Toaster />
        </AuthProvider>
      </BrowserRouter>
    </InfoHintProvider>
  );
}
