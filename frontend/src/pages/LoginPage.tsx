import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Boxes, Loader2, LogIn } from "lucide-react";
import { api, saveSessionToken } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

/**
 * 登录页：用户名密码换会话 token（Authorization: Bearer）。
 * 成功后跳回来源路由（location.state.from）或首页。
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useAuth();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const from = (location.state as { from?: string } | null)?.from || "/";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError(new Error("请输入用户名与密码"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.login({ username: username.trim(), password });
      saveSessionToken(result.token);
      // 中文注释：写回本地后刷新 AuthProvider，再跳转目标路由
      refresh();
      toast({
        title: "登录成功",
        description: `${result.user.username} · ${result.user.role === "admin" ? "管理员" : "只读"}`,
        tone: "success",
      });
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-brand/10 p-2 text-brand">
              <Boxes className="size-5" />
            </div>
            <div>
              <CardTitle className="text-lg">对象与文档存储</CardTitle>
              <CardDescription>控制台登录</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="login-username">用户名</Label>
              <Input
                id="login-username"
                value={username}
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">密码</Label>
              <Input
                id="login-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />
            </div>
            {error ? <ErrorAlert error={error} title="登录失败" /> : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              登录
            </Button>
            <p className="text-xs text-muted-foreground">
              首次使用可在<Link to="/settings" className="text-brand underline underline-offset-2 hover:text-brand/80">设置页</Link>
              配置 X-API-Key 并创建登录用户；viewer 角色仅可查看。
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
