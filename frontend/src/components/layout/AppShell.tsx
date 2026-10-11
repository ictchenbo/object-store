import * as React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  FileText,
  KeyRound,
  ListChecks,
  LogIn,
  LogOut,
  Menu,
  PlusCircle,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { loadApiKey, loadApiBase, loadSessionToken } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/use-toast";

interface NavItem {
  to: string;
  label: string;
  icon: typeof BarChart3;
  end: boolean;
  /** 仅 admin 可见（写入口） */
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "总览", icon: BarChart3, end: true },
  { to: "/objects", label: "对象", icon: Boxes, end: false },
  { to: "/documents", label: "文档", icon: FileText, end: false },
  { to: "/ingest", label: "文档入库", icon: PlusCircle, end: false, adminOnly: true },
  { to: "/tags", label: "标签字典", icon: Tags, end: false },
  { to: "/jobs", label: "后台任务", icon: ListChecks, end: false },
  { to: "/audit", label: "审计流水", icon: ClipboardList, end: false },
  { to: "/trash", label: "回收站", icon: Trash2, end: false },
  { to: "/settings", label: "设置", icon: KeyRound, end: false },
];

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const { canWrite } = useAuth();
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3">
      {NAV_ITEMS.filter((item) => !item.adminOnly || canWrite).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-brand/10 text-brand"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )
          }
        >
          <item.icon className="size-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** 应用外壳：左侧导航 + 内容区；移动端保留菜单入口 */
export function AppShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { status, error, role, canWrite, isSession, actorId, refresh, logout } = useAuth();
  const hasKey = Boolean(loadApiKey());
  const hasSession = Boolean(loadSessionToken());
  const apiBase = loadApiBase();

  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  async function onLogout() {
    await logout();
    toast({ title: "已退出登录", tone: "success" });
    navigate("/login", { replace: true });
  }

  /** 底部鉴权状态区：会话角色 / API Key / 登录入口 */
  const authFooter = (
    <div className="space-y-2">
      {hasSession || hasKey ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {role ? (
            <Badge variant={canWrite ? "success" : "warning"}>{canWrite ? "可写 · admin" : "只读 · viewer"}</Badge>
          ) : (
            <Badge variant={hasKey ? "success" : "warning"}>{hasKey ? "API Key 已配置" : "未配置 Key"}</Badge>
          )}
          {actorId ? (
            <span className="truncate" title={actorId}>
              {actorId}
            </span>
          ) : null}
        </div>
      ) : (
        <Badge variant="warning">未登录</Badge>
      )}
      <div className="truncate text-xs text-muted-foreground" title={apiBase}>
        API: {apiBase}
      </div>
      {isSession ? (
        <Button variant="outline" size="sm" className="w-full" onClick={() => void onLogout()}>
          <LogOut className="size-4" />
          退出登录
        </Button>
      ) : !hasSession ? (
        <Button variant="outline" size="sm" className="w-full" onClick={() => navigate("/login")}>
          <LogIn className="size-4" />
          登录
        </Button>
      ) : null}
      <div className="border-t pt-3">
        <ThemeToggle />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* 桌面侧栏 */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card lg:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="rounded-lg bg-brand/10 p-2 text-brand">
            <Boxes className="size-5" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">对象与文档存储</div>
            <div className="text-xs text-muted-foreground">控制台 · v1</div>
          </div>
        </div>
        <SideNav />
        <div className="mt-auto px-5 py-4">{authFooter}</div>
      </aside>

      {/* 移动端抽屉 */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r bg-card shadow-xl">
            <div className="flex items-center justify-between px-4 py-4">
              <div className="text-sm font-semibold">导航</div>
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="关闭导航">
                <X className="size-4" />
              </Button>
            </div>
            <SideNav onNavigate={() => setMobileOpen(false)} />
            <div className="mt-auto px-4 py-4">{authFooter}</div>
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <Button variant="outline" size="sm" className="mb-4 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="打开导航">
              <Menu className="size-4" />
              菜单
            </Button>
            {status === "error" ? (
              <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
                <span>身份验证暂不可用：{error || "请检查后端连接"}。已暂停写入操作。</span>
                <Button variant="outline" size="sm" onClick={refresh}>重试验证</Button>
              </div>
            ) : null}
            <React.Suspense fallback={<div role="status" className="py-8 text-sm text-muted-foreground">页面加载中…</div>}>
              <Outlet />
            </React.Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
