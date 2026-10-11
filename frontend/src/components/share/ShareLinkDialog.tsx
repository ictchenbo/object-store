import * as React from "react";
import { Copy, Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { api, loadApiBase } from "@/lib/api";
import type { ShareLinkItem, SharePermission, ShareTargetType } from "@/lib/types";
import { formatDateTime, truncate } from "@/lib/format";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";

/** 有效期预设（秒）；服务端限制 60..2592000 */
const EXPIRY_OPTIONS: { label: string; seconds: number }[] = [
  { label: "1 小时", seconds: 3600 },
  { label: "1 天", seconds: 86400 },
  { label: "7 天", seconds: 7 * 86400 },
  { label: "30 天", seconds: 30 * 86400 },
];

/** 有效期秒数 -> 展示文案 */
function expiryLabel(seconds: number): string {
  return EXPIRY_OPTIONS.find((item) => item.seconds === seconds)?.label || `${seconds} 秒`;
}

/** 拼出可复制的公开访问链接文本 */
export function buildShareText(token: string, serverUrl?: string): string {
  if (serverUrl) return serverUrl;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${loadApiBase()}/public/share/${token}`;
}

interface ShareLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetType: ShareTargetType;
  targetId: string;
  /** 目标展示名，仅用于文案 */
  targetName?: string;
}

/**
 * 分享链接对话框：创建公开访问链接（view/download + 有效期），
 * 列出当前租户已创建链接并支持撤销。创建/撤销仅 admin 可用。
 */
export function ShareLinkDialog({ open, onOpenChange, targetType, targetId, targetName }: ShareLinkDialogProps) {
  const { canWrite } = useAuth();
  const [permission, setPermission] = React.useState<SharePermission>("view");
  const [expiry, setExpiry] = React.useState(String(86400));
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<unknown>(null);
  const [lastCreated, setLastCreated] = React.useState<{ token: string; text: string } | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const links = useAsync(() => (open ? api.listShareLinks() : Promise.resolve({ items: [] as ShareLinkItem[] })), [open, refreshKey]);

  // 中文注释：只展示与当前目标关联的链接
  const items = (links.data?.items || []).filter(
    (item) => item.target_type === targetType && item.target_id === targetId,
  );

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createShareLink({
        target_type: targetType,
        target_id: targetId,
        permission,
        expires_in_seconds: Number(expiry),
      });
      const text = buildShareText(created.token, created.url);
      setLastCreated({ token: created.token, text });
      toast({ title: "分享链接已创建", description: `有效期 ${expiryLabel(Number(expiry))}`, tone: "success" });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(link: ShareLinkItem) {
    setRevokingId(link.id);
    try {
      await api.revokeShareLink(link.id);
      toast({ title: "分享链接已撤销", tone: "success" });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast({
        title: "撤销失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setRevokingId(null);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "已复制到剪贴板", tone: "success" });
    } catch {
      // 剪贴板不可用时降级为提示手动复制
      toast({ title: "复制失败", description: "请手动选中链接文本复制", tone: "warning" });
    }
  }

  function isExpired(item: ShareLinkItem): boolean {
    return Boolean(item.expires_at && new Date(item.expires_at).getTime() <= Date.now());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-4" />
            分享{targetType === "document" ? "文档" : "对象"}
          </DialogTitle>
          <DialogDescription>
            {targetName ? `目标：${truncate(targetName, 40)}。` : ""}
            创建免登录公开链接，可随时撤销。仅 admin 可创建与撤销。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 创建表单 */}
          {canWrite ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="share-permission">权限</Label>
                <Select value={permission} onValueChange={(value: SharePermission) => setPermission(value)}>
                  <SelectTrigger id="share-permission">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="view">仅查看（view）</SelectItem>
                    <SelectItem value="download">可下载（download）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="share-expiry">有效期</Label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger id="share-expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((item) => (
                      <SelectItem key={item.seconds} value={String(item.seconds)}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Button onClick={() => void create()} disabled={creating || !targetId} className="w-full">
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  创建分享链接
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">只读角色不能创建或撤销分享链接，以下为已有链接。</p>
          )}

          {createError ? <ErrorAlert error={createError} title="创建分享链接失败" /> : null}

          {/* 新建结果：可复制链接 */}
          {lastCreated ? (
            <div className="space-y-1.5 rounded-lg border border-brand/30 bg-brand/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium">新链接（请妥善保存 token）</div>
                <Button variant="outline" size="sm" onClick={() => void copyText(lastCreated.text)}>
                  <Copy className="size-4" />
                  复制
                </Button>
              </div>
              <div className="break-all font-mono text-xs">{lastCreated.text}</div>
            </div>
          ) : null}

          {/* 已创建链接列表 */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">当前目标的分享链接</div>
            {links.error ? <ErrorAlert error={links.error} title="分享链接加载失败" /> : null}
            {links.loading && !links.data ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> 加载中…
              </div>
            ) : items.length === 0 ? (
              <div className="py-3 text-sm text-muted-foreground">暂无分享链接</div>
            ) : (
              <div className="max-h-56 space-y-2 overflow-y-auto">
                {items.map((item) => {
                  const expired = isExpired(item);
                  const revoked = Boolean(item.revoked_at);
                  return (
                    <div key={item.id} className="flex items-start gap-2 rounded-lg border p-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={item.permission === "download" ? "brand" : "secondary"}>
                            {item.permission === "download" ? "可下载" : "仅查看"}
                          </Badge>
                          {revoked ? <Badge variant="danger">已撤销</Badge> : null}
                          {!revoked && expired ? <Badge variant="warning">已过期</Badge> : null}
                          <span className="text-xs text-muted-foreground">
                            至 {formatDateTime(item.expires_at)}
                          </span>
                        </div>
                        <div className="break-all font-mono text-xs text-muted-foreground">
                          {buildShareText(item.token)}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="复制链接"
                          onClick={() => void copyText(buildShareText(item.token))}
                        >
                          <Copy className="size-4" />
                        </Button>
                        {canWrite && !revoked ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="撤销"
                            disabled={revokingId === item.id}
                            onClick={() => void revoke(item)}
                          >
                            {revokingId === item.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4 text-destructive" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
