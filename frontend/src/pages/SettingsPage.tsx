import * as React from "react";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Plug,
  Save,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import {
  DEFAULT_API_BASE,
  api,
  loadActorId,
  loadApiBase,
  loadApiKey,
  loadSessionToken,
  saveActorId,
  saveApiBase,
  saveApiKey,
} from "@/lib/api";
import type { RetentionPolicy, UserItem, UserRole } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InfoHint } from "@/components/ui/info-hint";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";

/** 保留策略默认值（与服务端 DEFAULT_RETENTION_POLICY 对齐） */
const DEFAULT_POLICY: RetentionPolicy = {
  orphan_object_grace_hours: 72,
  staging_retry_grace_seconds: 86400,
  staging_retry_max_attempts: 10,
  version_retention: "keep_all",
  version_retention_n: 10,
  deleted_object_purge_days: 7,
  deleted_document_purge_days: 7,
};

/** 设置：API Key、API 基址、连通性检查、保留策略与用户管理 */
export function SettingsPage() {
  const { canWrite, role, refresh } = useAuth();
  const [apiKey, setApiKey] = React.useState(loadApiKey());
  const [apiBase, setApiBase] = React.useState(loadApiBase());
  const [actorId, setActorId] = React.useState(loadActorId());
  const [healthState, setHealthState] = React.useState<"idle" | "checking" | "ok" | "unauthorized" | "fail">("idle");
  const [healthError, setHealthError] = React.useState<unknown>(null);
  const [policy, setPolicy] = React.useState<RetentionPolicy>(DEFAULT_POLICY);
  const [policyLoading, setPolicyLoading] = React.useState(false);
  const [policySaving, setPolicySaving] = React.useState(false);
  const [policyError, setPolicyError] = React.useState<unknown>(null);
  const [policyLoaded, setPolicyLoaded] = React.useState(false);
  // 中文注释：用户管理（admin）
  const [users, setUsers] = React.useState<UserItem[]>([]);
  const [usersLoading, setUsersLoading] = React.useState(false);
  const [usersError, setUsersError] = React.useState<unknown>(null);
  const [newUsername, setNewUsername] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [newRole, setNewRole] = React.useState<UserRole>("viewer");
  const [creatingUser, setCreatingUser] = React.useState(false);

  // 中文注释：进入页面即尝试加载保留策略；会话或 API Key 均可，未配置时静默跳过
  React.useEffect(() => {
    if ((!loadApiKey() && !loadSessionToken()) || policyLoaded) return;
    let cancelled = false;
    setPolicyLoading(true);
    setPolicyError(null);
    api
      .getRetentionPolicy()
      .then((result) => {
        if (!cancelled) {
          setPolicy({
            orphan_object_grace_hours: result.orphan_object_grace_hours,
            staging_retry_grace_seconds: result.staging_retry_grace_seconds,
            staging_retry_max_attempts: result.staging_retry_max_attempts,
            version_retention: result.version_retention,
            version_retention_n: result.version_retention_n ?? 10,
            deleted_object_purge_days: result.deleted_object_purge_days,
            deleted_document_purge_days: result.deleted_document_purge_days ?? 7,
          });
          setPolicyLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) setPolicyError(error);
      })
      .finally(() => {
        if (!cancelled) setPolicyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [policyLoaded]);

  // 中文注释：admin 时加载用户列表
  const loadUsers = React.useCallback(() => {
    if (!canWrite) return;
    let cancelled = false;
    setUsersLoading(true);
    setUsersError(null);
    api
      .listUsers()
      .then((result) => {
        if (!cancelled) setUsers(result.items || []);
      })
      .catch((error) => {
        if (!cancelled) setUsersError(error);
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canWrite]);

  React.useEffect(() => {
    if (!canWrite) return;
    return loadUsers();
  }, [canWrite, loadUsers]);

  async function savePolicy() {
    if (!canWrite || !policyLoaded) return;
    setPolicySaving(true);
    setPolicyError(null);
    try {
      const saved = await api.putRetentionPolicy(policy);
      setPolicy({
        orphan_object_grace_hours: saved.orphan_object_grace_hours,
        staging_retry_grace_seconds: saved.staging_retry_grace_seconds,
        staging_retry_max_attempts: saved.staging_retry_max_attempts,
        version_retention: saved.version_retention,
        version_retention_n: saved.version_retention_n ?? 10,
        deleted_object_purge_days: saved.deleted_object_purge_days,
        deleted_document_purge_days: saved.deleted_document_purge_days ?? 7,
      });
      setPolicyLoaded(true);
      toast({
        title: "保留策略已保存",
        description: saved.note || "由 Worker 自动执行：软删进入回收站，到期自动永久清除",
        tone: "success",
      });
    } catch (error) {
      setPolicyError(error);
      toast({
        title: "保存保留策略失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setPolicySaving(false);
    }
  }

  async function checkHealth(keyOverride?: string, baseOverride?: string) {
    const probeKey = keyOverride ?? apiKey;
    const probeBase = baseOverride ?? apiBase;
    setHealthState("checking");
    setHealthError(null);
    try {
      // 中文注释：第一跳用免鉴权 /health 判定服务是否可达
      const result = await fetch(`${probeBase.replace(/\/api\/v1\/?$/, "")}/health`);
      if (!result.ok) throw new Error(`健康检查返回 HTTP ${result.status}`);
      // 中文注释：第二跳带会话 token 或 API Key 请求轻量接口，验证凭证是否有效，
      // 否则错误凭证也会显示「后端在线」，用户要到数据页才发现 401
      const sessionToken = loadSessionToken();
      const headers: Record<string, string> = sessionToken
        ? { Authorization: `Bearer ${sessionToken}` }
        : { "X-API-Key": probeKey.trim() };
      const probe = await fetch(`${probeBase.replace(/\/$/, "")}/tags?limit=1`, { headers });
      if (!probe.ok) {
        const body = (await probe.json().catch(() => ({}))) as { message?: string };
        if (probe.status === 401 || probe.status === 403) {
          setHealthState("unauthorized");
          setHealthError(
            new Error(body.message || (sessionToken ? `会话鉴权失败（HTTP ${probe.status}）` : `API Key 鉴权失败（HTTP ${probe.status}）`)),
          );
          return;
        }
        throw new Error(body.message || `鉴权探针返回 HTTP ${probe.status}`);
      }
      setHealthState("ok");
      toast({
        title: "后端连通正常",
        description: sessionToken ? "登录会话验证通过" : "API Key 验证通过",
        tone: "success",
      });
    } catch (error) {
      setHealthState("fail");
      setHealthError(error);
    }
  }

  function save() {
    const trimmedKey = apiKey.trim();
    const trimmedBase = apiBase.trim() || DEFAULT_API_BASE;
    // 中文注释：会话登录场景可不配 API Key
    if (!trimmedKey && !loadSessionToken()) {
      toast({ title: "API Key 不能为空", description: "未登录时所有 /api/v1 请求都需要 X-API-Key", tone: "warning" });
      return;
    }
    saveApiKey(trimmedKey);
    saveApiBase(trimmedBase);
    saveActorId(actorId);
    refresh();
    setApiKey(trimmedKey);
    setApiBase(trimmedBase);
    setActorId(actorId.trim());
    toast({ title: "配置已保存", description: "保存在浏览器 localStorage", tone: "success" });
    // 中文注释：Key 配置后重载保留策略（此前可能因无 Key 跳过了加载）
    setPolicyLoaded(false);
    void checkHealth(trimmedKey, trimmedBase);
  }

  /** 创建用户（admin） */
  async function createUser() {
    const username = newUsername.trim();
    if (!username || !newPassword.trim()) {
      toast({ title: "请填写用户名与密码", tone: "warning" });
      return;
    }
    setCreatingUser(true);
    try {
      await api.createUser({ username, password: newPassword.trim(), role: newRole });
      toast({ title: "用户已创建", description: `${username}（${newRole}）`, tone: "success" });
      setNewUsername("");
      setNewPassword("");
      setNewRole("viewer");
      loadUsers();
    } catch (error) {
      toast({
        title: "创建用户失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setCreatingUser(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">设置</h2>
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
          配置保存在当前浏览器（localStorage）；发起请求时，凭证会发送到所配置的后端。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            鉴权与连接
            <InfoHint
              content="支持登录会话或 API Key；一个 API Key 对应一个租户。默认 API 前缀 /api/v1 经同源代理转发到后端。"
              label="查看鉴权与连接说明"
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="api-key">X-API-Key</Label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              placeholder="输入 API Key"
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              API Key 由服务端 API_KEYS_JSON 配置。已登录会话时可留空。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="api-base">API 基址</Label>
            <Input
              id="api-base"
              value={apiBase}
              placeholder={DEFAULT_API_BASE}
              onChange={(event) => setApiBase(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              保持 <code className="text-xs">/api/v1</code> 即可走 Vite/Nginx 同源代理；也可填完整地址如{" "}
              <code className="text-xs">http://127.0.0.1:3000/api/v1</code>（需后端允许跨域）。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="actor-id">X-Actor-Id（可选）</Label>
            <Input
              id="actor-id"
              value={actorId}
              placeholder="留空则使用 Key 配置的默认操作者"
              autoComplete="off"
              onChange={(event) => setActorId(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              用于审计流水标识操作者；仅当服务端 <code className="text-xs">ALLOW_ACTOR_OVERRIDE=true</code> 时生效，格式为字母数字与 . _ @ - ，最长 64。会话登录时使用登录用户身份。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save}>
              <Save className="size-4" />
              保存配置
            </Button>
            <Button variant="outline" onClick={() => void checkHealth()} disabled={healthState === "checking"}>
              {healthState === "checking" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              连通性检查
            </Button>
            {healthState === "ok" ? (
              <Badge variant="success">
                <CheckCircle2 className="mr-1 size-3" />
                后端在线
              </Badge>
            ) : healthState === "unauthorized" ? (
              <Badge variant="danger">
                <XCircle className="mr-1 size-3" />
                凭证无效
              </Badge>
            ) : healthState === "fail" ? (
              <Badge variant="danger">
                <XCircle className="mr-1 size-3" />
                无法连接
              </Badge>
            ) : null}
          </div>

          {healthError ? (
            <ErrorAlert
              error={healthError}
              title={healthState === "unauthorized" ? "鉴权失败" : "连通性检查失败"}
            />
          ) : null}
        </CardContent>
      </Card>

      {/* 用户管理（admin） */}
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              用户管理
              <InfoHint content="创建登录用户并分配角色：admin 可读写，viewer 只读。仅管理员可见此区块。" label="查看用户管理说明" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {usersError ? <ErrorAlert error={usersError} title="用户列表加载失败" /> : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="新用户名">用户名</Label>
                <Input
                  id="新用户名"
                  value={newUsername}
                  autoComplete="off"
                  placeholder="字母数字与 . _ @ -"
                  onChange={(event) => setNewUsername(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="新用户密码">密码</Label>
                <Input
                  id="新用户密码"
                  type="password"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="新用户角色">角色</Label>
                <Select value={newRole} onValueChange={(value: UserRole) => setNewRole(value)}>
                  <SelectTrigger id="新用户角色">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">只读（viewer）</SelectItem>
                    <SelectItem value="admin">可写（admin）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button className="w-full" onClick={() => void createUser()} disabled={creatingUser}>
                  {creatingUser ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                  创建用户
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">已有用户</div>
                <Button variant="outline" size="sm" onClick={() => loadUsers()} disabled={usersLoading}>
                  {usersLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                  刷新
                </Button>
              </div>
              {usersLoading && users.length === 0 ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  加载中…
                </div>
              ) : users.length === 0 ? (
                <div className="py-4 text-sm text-muted-foreground">暂无用户</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户名</TableHead>
                      <TableHead>角色</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>创建时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">{user.username}</TableCell>
                        <TableCell>
                          <Badge variant={user.role === "admin" ? "brand" : "secondary"}>
                            {user.role === "admin" ? "可写 · admin" : "只读 · viewer"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={user.active ? "success" : "warning"}>
                            {user.active ? "启用" : "停用"}
                          </Badge>
                        </TableCell>
                        <TableCell className="cell-muted">{formatDateTime(user.created_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            {role ? (
              <p className="text-xs text-muted-foreground">
                <ShieldCheck className="mr-1 inline size-3" />
                当前角色：{role === "admin" ? "可写 · admin" : "只读 · viewer"}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              用户管理
            </CardTitle>
            <CardDescription>只读角色（viewer）无法查看或管理用户，请联系管理员。</CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4" />
            保留策略
          </CardTitle>
          <CardDescription className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-foreground">
            删除后进入回收站，到期自动永久清除；历史版本也会按当前策略自动裁剪。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {policyError ? <ErrorAlert error={policyError} title="保留策略加载/保存失败" /> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="孤儿宽限小时">孤儿对象宽限（小时）</Label>
              <Input
                id="孤儿宽限小时"
                type="number"
                min={0}
                max={8760}
                value={policy.orphan_object_grace_hours}
                disabled={policyLoading || policySaving || !canWrite}
                onChange={(event) =>
                  setPolicy((prev) => ({ ...prev, orphan_object_grace_hours: Number(event.target.value) || 0 }))
                }
              />
              <p className="text-xs text-muted-foreground">document_internal 对象就绪满该时长且无引用后可回收（默认 72）</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="暂存重试宽限秒">暂存重试宽限（秒）</Label>
              <Input
                id="暂存重试宽限秒"
                type="number"
                min={0}
                value={policy.staging_retry_grace_seconds}
                disabled={policyLoading || policySaving || !canWrite}
                onChange={(event) =>
                  setPolicy((prev) => ({ ...prev, staging_retry_grace_seconds: Number(event.target.value) || 0 }))
                }
              />
              <p className="text-xs text-muted-foreground">上传收尾失败后，staging 字节保留多久用于重试（默认 86400）</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="暂存重试次数">暂存重试上限</Label>
              <Input
                id="暂存重试次数"
                type="number"
                min={1}
                max={100}
                value={policy.staging_retry_max_attempts}
                disabled={policyLoading || policySaving || !canWrite}
                onChange={(event) =>
                  setPolicy((prev) => ({ ...prev, staging_retry_max_attempts: Number(event.target.value) || 1 }))
                }
              />
              <p className="text-xs text-muted-foreground">finalize_upload 任务最大尝试次数（默认 10）</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="版本保留策略">版本保留策略</Label>
              <Select
                value={policy.version_retention}
                onValueChange={(value: RetentionPolicy["version_retention"]) =>
                  setPolicy((prev) => ({ ...prev, version_retention: value }))
                }
                disabled={policyLoading || policySaving || !canWrite}
              >
                <SelectTrigger id="版本保留策略">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep_all">保留全部（keep_all）</SelectItem>
                  <SelectItem value="keep_last_n">保留最近 N 个（keep_last_n）</SelectItem>
                  <SelectItem value="keep_current_only">仅保留当前（keep_current_only）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">由 prune_versions 任务执行；keep_all 不裁剪历史版本</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="版本保留数量">版本保留数量 N</Label>
              <Input
                id="版本保留数量"
                type="number"
                min={1}
                max={1000}
                value={policy.version_retention_n}
                disabled={policyLoading || policySaving || !canWrite || policy.version_retention !== "keep_last_n"}
                onChange={(event) =>
                  setPolicy((prev) => ({ ...prev, version_retention_n: Number(event.target.value) || 1 }))
                }
              />
              <p className="text-xs text-muted-foreground">仅 keep_last_n 生效，范围 1–1000（默认 10）</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="已删对象清理天数">已删对象清理（天）</Label>
              <Input
                id="已删对象清理天数"
                type="number"
                min={0}
                max={3650}
                value={policy.deleted_object_purge_days}
                disabled={policyLoading || policySaving || !canWrite}
                onChange={(event) =>
                  setPolicy((prev) => ({ ...prev, deleted_object_purge_days: Number(event.target.value) || 0 }))
                }
              />
              <p className="text-xs text-muted-foreground">0 = 立即永久删除；&gt;0 为回收站恢复窗口天数</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="已删文档清理天数">已删文档清理（天）</Label>
              <Input
                id="已删文档清理天数"
                type="number"
                min={0}
                max={3650}
                value={policy.deleted_document_purge_days}
                disabled={policyLoading || policySaving || !canWrite}
                onChange={(event) =>
                  setPolicy((prev) => ({ ...prev, deleted_document_purge_days: Number(event.target.value) || 0 }))
                }
              />
              <p className="text-xs text-muted-foreground">0 = 立即永久删除；&gt;0 为回收站恢复窗口天数</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void savePolicy()} disabled={!policyLoaded || policyLoading || policySaving || !canWrite}>
              {policySaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存保留策略
            </Button>
            <Button
              variant="outline"
              disabled={policyLoading || policySaving}
              onClick={() => {
                setPolicyLoaded(false);
                setPolicyError(null);
              }}
            >
              重新加载
            </Button>
            {policyLoading ? (
              <span className="text-xs text-muted-foreground">
                <Loader2 className="mr-1 inline size-3 animate-spin" />
                加载中…
              </span>
            ) : null}
          </div>

          <div className="rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-xs text-muted-foreground">
            保留策略由 Worker 自动执行：软删进入回收站，到期自动永久清除；版本策略由 prune_versions 任务执行。
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>使用说明</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>1. 启动后端：Linux 上运行 <code className="text-xs">sh scripts/start.sh</code>（PostgreSQL + MinIO + API + Worker + 前端）。</p>
          <p>2. 本地开发前端：<code className="text-xs">cd frontend && npm run dev</code>，访问 http://127.0.0.1:18000。</p>
          <p>3. 对象上传为浏览器直传 MinIO 预签名 URL；若被拦截，请检查 MinIO 公网地址（MINIO_PUBLIC_ENDPOINT）与 CORS 配置。</p>
          <p>4. 写操作自动携带 Idempotency-Key；错误体统一为 code / message / request_id。</p>
          <p>5. 鉴权优先级：登录会话 token（Authorization: Bearer）&gt; X-API-Key；401 时跳转登录页或设置页。</p>
        </CardContent>
      </Card>
    </div>
  );
}
