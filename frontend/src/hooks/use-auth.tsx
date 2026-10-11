import * as React from "react";
import { api, ApiError, loadApiKey, loadSessionToken, saveSessionToken } from "@/lib/api";
import type { UserRole } from "@/lib/types";

/** 鉴权状态：loading=探测中，anonymous=无有效凭证，authed=已识别身份，error=探测失败 */
type AuthStatus = "loading" | "anonymous" | "authed" | "error";

interface AuthContextValue {
  status: AuthStatus;
  error: string | null;
  /** admin 可写；viewer 只读；anonymous 时为 null */
  role: UserRole | null;
  tenantId: string | null;
  /** 当前操作者标识（登录用户名或 Key 配置的 actor） */
  actorId: string | null;
  /** 是否通过登录会话鉴权（否则为 API Key） */
  isSession: boolean;
  /** 写操作入口判定：admin 才允许写 */
  canWrite: boolean;
  /** 重新探测身份（登录/退出后调用） */
  refresh: () => void;
  /** 退出登录：吊销服务端会话并清除本地 token */
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

/**
 * 中文注释：鉴权提供者。
 * 启动时若有会话 token 或 API Key 则调用 GET /auth/me 识别角色；
 * viewer 只读由 canWrite 统一判定，各页面据此隐藏写入口。
 * 取舍：不做路由级强制登录拦截——纯 API Key 集成场景仍可直接使用控制台。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AuthStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [role, setRole] = React.useState<UserRole | null>(null);
  const [tenantId, setTenantId] = React.useState<string | null>(null);
  const [actorId, setActorId] = React.useState<string | null>(null);
  const [isSession, setIsSession] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    const sessionToken = loadSessionToken();
    const apiKey = loadApiKey();
    setError(null);
    setRole(null);
    setTenantId(null);
    setActorId(null);
    if (!sessionToken && !apiKey) {
      setStatus("anonymous");
      setIsSession(false);
      return;
    }
    setStatus("loading");
    setIsSession(Boolean(sessionToken));
    api
      .me()
      .then((me) => {
        if (cancelled) return;
        setStatus("authed");
        setRole(me.role);
        setTenantId(me.tenant_id);
        setActorId(me.actor_id);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 401) {
          // 中文注释：仅明确的 401 才清除过期会话；网络故障保留凭证以便重试。
          if (sessionToken) saveSessionToken("");
          setStatus("anonymous");
          setIsSession(false);
        } else {
          // 中文注释：身份未获确认时不展示写入口，也不把服务故障当作会话失效。
          setStatus("error");
          setError(reason instanceof Error ? reason.message : "身份验证暂不可用");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = React.useCallback(() => setTick((value) => value + 1), []);

  const logout = React.useCallback(async () => {
    try {
      if (loadSessionToken()) await api.logout();
    } catch {
      /* 吊销失败也继续清除本地状态 */
    }
    saveSessionToken("");
    refresh();
  }, [refresh]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      error,
      role,
      tenantId,
      actorId,
      isSession,
      canWrite: role === "admin",
      refresh,
      logout,
    }),
    [status, error, role, tenantId, actorId, isSession, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 读取当前鉴权上下文；必须在 AuthProvider 内使用 */
export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}
