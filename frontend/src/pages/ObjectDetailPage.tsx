import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Eye, Link2, Loader2, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ObjectItem, TagItem } from "@/lib/types";
import { daysUntil, formatBytes, formatDateTime, statusMeta } from "@/lib/format";
import { PREVIEW_TTL_SECONDS } from "@/lib/preview/limits";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ObjectPreviewDialog } from "@/components/objects/ObjectPreviewDialog";
import { ShareLinkDialog } from "@/components/share/ShareLinkDialog";
import { TagList } from "@/components/tags/TagList";
import { TagPicker, splitTags } from "@/components/tags/TagPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";

/** 是否仍在恢复窗口内（与后端 restore 校验对齐：无窗口/已到期均不可恢复） */
function restorableObject(item: ObjectItem | null | undefined): boolean {
  if (!item?.purge_after) return false;
  const days = daysUntil(item.purge_after);
  return days !== null && days > 0;
}

/** 对象详情：元数据 + 标签管理 + 预览/下载/分享/删除/恢复 */
export function ObjectDetailPage() {
  const { objectId = "" } = useParams();
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const [newTags, setNewTags] = React.useState<TagItem[]>([]);
  const [savingTags, setSavingTags] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);

  const detail = useAsync(() => api.getObject(objectId), [objectId]);
  const item = detail.data;

  async function addTags() {
    if (!item || newTags.length === 0) return;
    setSavingTags(true);
    try {
      await api.addObjectTags(item.id, splitTags(newTags));
      setNewTags([]);
      toast({ title: "标签已绑定", tone: "success" });
      detail.reload();
    } catch (error) {
      toast({
        title: "绑定标签失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setSavingTags(false);
    }
  }

  async function removeTag(tag: TagItem) {
    if (!item || !canWrite) return;
    try {
      await api.removeObjectTag(item.id, tag.id);
      toast({ title: "已解绑标签", tone: "success" });
      detail.reload();
    } catch (error) {
      toast({
        title: "解绑失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    }
  }

  async function download() {
    if (!item) return;
    setBusy(true);
    try {
      const result = await api.downloadUrl(item.id);
      window.open(result.url, "_blank", "noopener,noreferrer");
      // 中文注释：与对象列表页保持一致，签发成功后给出反馈
      toast({ title: "已签发下载链接", description: `有效期 ${result.expires_in} 秒`, tone: "success" });
    } catch (error) {
      toast({
        title: "获取下载链接失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item) return;
    setBusy(true);
    try {
      const result = await api.deleteObject(item.id);
      // 中文注释：202=软删受理（进回收站可恢复）；204=已删除（幂等重放）
      toast({
        title: result ? "删除已受理" : "对象已删除",
        description: result ? "进入回收站，按保留策略自动永久删除" : "该对象此前已删除",
        tone: "success",
      });
      setConfirmOpen(false);
      navigate("/objects");
    } catch (error) {
      toast({
        title: "删除失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
      setBusy(false);
    }
  }

  /** 恢复软删对象（status=deleting） */
  async function restore() {
    if (!item) return;
    setRestoring(true);
    try {
      await api.restoreObject(item.id);
      toast({ title: "对象已恢复", description: item.display_name, tone: "success" });
      detail.reload();
    } catch (error) {
      toast({
        title: "恢复失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/objects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            返回对象列表
          </Link>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">
            {item ? item.display_name : <Skeleton className="inline-block h-8 w-48" />}
          </h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{objectId}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={detail.reload} disabled={detail.loading}>
            <RefreshCw className={detail.loading ? "size-4 animate-spin" : "size-4"} />
            刷新
          </Button>
          <Button variant="outline" onClick={() => setPreviewOpen(true)} disabled={!item || busy}>
            <Eye className="size-4" />
            预览
          </Button>
          <Button variant="outline" onClick={download} disabled={!item || busy}>
            <Download className="size-4" />
            下载
          </Button>
          <Button variant="outline" onClick={() => setShareOpen(true)} disabled={!item}>
            <Link2 className="size-4" />
            分享
          </Button>
          {canWrite && item?.status === "deleting" ? (
            <Button
              variant="outline"
              onClick={() => void restore()}
              disabled={restoring || busy || !restorableObject(item)}
              title={
                restorableObject(item)
                  ? "恢复对象"
                  : "已过恢复窗口或无恢复窗口，不可恢复"
              }
            >
              {restoring ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
              恢复对象
            </Button>
          ) : null}
          {canWrite && item && item.status !== "deleting" && item.status !== "deleted" ? (
            <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={busy}>
              <Trash2 className="size-4" />
              删除
            </Button>
          ) : null}
        </div>
      </div>

      {detail.error ? <ErrorAlert error={detail.error} title="对象加载失败" /> : null}

      {item ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                对象元数据
                <InfoHint content="对象目录信息存于 PostgreSQL，文件字节存于 MinIO。" label="查看对象元数据说明" />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">状态</div>
                  <div className="mt-1">
                    <Badge variant={statusMeta(item.status).tone === "success" ? "success" : "secondary"}>
                      {statusMeta(item.status).label}
                    </Badge>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">用途 purpose</div>
                  <div className="mt-1">{item.purpose}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">桶</div>
                  <div className="mt-1 font-mono text-xs">{item.bucket}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">对象 key</div>
                  <div className="mt-1 break-all font-mono text-xs">{item.object_key}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">大小</div>
                  <div className="mt-1 tabular-nums">{formatBytes(item.size_bytes)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">SHA-256</div>
                  <div className="mt-1 break-all font-mono text-xs">{item.sha256 || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">媒体类型</div>
                  <div className="mt-1">{item.content_type}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">创建时间</div>
                  <div className="mt-1">{formatDateTime(item.created_at)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">就绪时间</div>
                  <div className="mt-1">{formatDateTime(item.ready_at)}</div>
                </div>
              </div>
              <Separator />
              <div>
                <div className="text-xs text-muted-foreground">对象 ID</div>
                <div className="mt-1 break-all font-mono text-xs">{item.id}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                标签
                <InfoHint content="对象直接绑定的标签；解绑不删除字典项。" label="查看对象标签说明" />
              </CardTitle>
              {!canWrite ? <CardDescription>只读角色不可修改标签。</CardDescription> : null}
            </CardHeader>
            <CardContent className="space-y-4">
              <TagList tags={item.tags} onRemove={canWrite ? removeTag : undefined} />
              {canWrite ? (
                <div className="space-y-2">
                  <TagPicker value={newTags} onChange={setNewTags} disabled={savingTags} />
                  <Button onClick={addTags} disabled={savingTags || newTags.length === 0} className="w-full">
                    {savingTags ? <Loader2 className="size-4 animate-spin" /> : null}
                    绑定标签
                  </Button>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                新名称由服务端归一化后自动创建；若已存在同名标签则复用。
              </p>
            </CardContent>
          </Card>
        </div>
      ) : detail.loading ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="确认删除对象"
        description={
          item
            ? `确认删除对象「${item.display_name}」？被文档引用时接口将返回 409。删除进入回收站，按保留策略自动永久删除；恢复窗口内可撤销。`
            : undefined
        }
        confirmLabel="删除"
        destructive
        busy={busy}
        onConfirm={remove}
      />

      <ObjectPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        displayName={item?.display_name || ""}
        contentType={item?.content_type || ""}
        sizeBytes={item?.size_bytes}
        resolveUrl={() =>
          api.objectDownloadUrl(objectId, {
            disposition: "inline",
            ttl_seconds: PREVIEW_TTL_SECONDS,
          })
        }
        onDownload={item ? download : undefined}
      />

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        targetType="object"
        targetId={objectId}
        targetName={item?.display_name}
      />
    </div>
  );
}
