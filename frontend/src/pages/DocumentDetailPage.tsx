import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Download,
  Eye,
  FileText,
  History,
  Link2,
  Loader2,
  RefreshCw,
  Shuffle,
  Trash2,
  Undo2,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { TagItem, TrashDocumentItem, VersionItem } from "@/lib/types";
import { assetRoleLabel, daysUntil, formatDateTime, prettyJson, statusMeta, truncate } from "@/lib/format";
import { PREVIEW_TTL_SECONDS } from "@/lib/preview/limits";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { TagList } from "@/components/tags/TagList";
import { TagPicker, splitTags } from "@/components/tags/TagPicker";
import { ReclassifyDialog } from "@/components/documents/ReclassifyDialog";
import { VersionComparePanel } from "@/components/documents/VersionComparePanel";
import { ObjectPreviewDialog } from "@/components/objects/ObjectPreviewDialog";
import { ShareLinkDialog } from "@/components/share/ShareLinkDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";

/** 预览目标：附件或 raw/body 对象 */
interface PreviewTarget {
  objectId: string;
  displayName: string;
  contentType: string;
  versionNo: number;
  /** 对象字节数；已知时可在下载前拒绝超限文件 */
  sizeBytes?: number | null;
}

function ObjectLink({ objectId, label }: { objectId: string | null; label: string }) {
  if (!objectId) return <span className="text-xs text-muted-foreground">未设置</span>;
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Link to={`/objects/${objectId}`} className="break-all font-mono text-xs text-primary hover:underline">
        {objectId}
      </Link>
    </div>
  );
}

/** 剩余恢复天数徽章 */
function RemainingBadge({ purgeAfter }: { purgeAfter: string | null | undefined }) {
  const days = daysUntil(purgeAfter);
  if (days === null) return <Badge variant="outline">按保留策略自动清除</Badge>;
  if (days <= 0) return <Badge variant="danger">已到期</Badge>;
  return <Badge variant="warning">剩 {days} 天</Badge>;
}

/** 是否仍在恢复窗口内（与后端 restore 校验对齐：无窗口/已到期/已永久清除均不可恢复） */
function restorableWindow(purgeAfter: string | null | undefined): boolean {
  if (!purgeAfter) return false;
  const days = daysUntil(purgeAfter);
  return days !== null && days > 0;
}

/** 文档详情：当前版本、版本历史、附件、标签、对比、重分类、分享与恢复 */
export function DocumentDetailPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const [newTags, setNewTags] = React.useState<TagItem[]>([]);
  const [savingTags, setSavingTags] = React.useState(false);
  const [reclassifyOpen, setReclassifyOpen] = React.useState(false);
  const [activeVersion, setActiveVersion] = React.useState<VersionItem | null>(null);
  const [previewTarget, setPreviewTarget] = React.useState<PreviewTarget | null>(null);
  const [versionToDelete, setVersionToDelete] = React.useState<VersionItem | null>(null);
  const [versionToRestore, setVersionToRestore] = React.useState<VersionItem | null>(null);
  const [confirmDocDelete, setConfirmDocDelete] = React.useState(false);
  const [confirmDocRestore, setConfirmDocRestore] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  // 中文注释：详情 404 时从回收站捞软删记录，提供恢复入口
  const [trashItem, setTrashItem] = React.useState<TrashDocumentItem | null>(null);
  const [trashLookup, setTrashLookup] = React.useState(false);

  const detail = useAsync(() => api.getDocument(documentId), [documentId]);
  const versions = useAsync(() => api.listVersions(documentId), [documentId]);
  const types = useAsync(() => api.listDocumentTypes(), []);

  const document = detail.data;
  const currentVersionNo = document?.current_version?.version_no ?? null;

  // 中文注释：详情加载 404 时尝试从回收站找到该文档（软删后 require_document 默认 404）
  React.useEffect(() => {
    let cancelled = false;
    const err = detail.error;
    if (!err) {
      setTrashItem(null);
      return;
    }
    const status = err instanceof ApiError ? err.status : 0;
    if (status !== 404) return;
    setTrashLookup(true);
    // 回收站接口按页返回，这里扫前几页找目标 id
    (async () => {
      try {
        let cursor: string | null = null;
        for (let page = 0; page < 5; page += 1) {
          const result = await api.listTrashDocuments({ cursor, limit: 50 });
          const hit = result.items.find((item) => item.id === documentId);
          if (!cancelled && hit) {
            setTrashItem(hit);
            break;
          }
          if (!result.next_cursor) break;
          cursor = result.next_cursor;
        }
      } catch {
        /* 回收站不可读时忽略，仍展示原始 404 */
      } finally {
        if (!cancelled) setTrashLookup(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.error, documentId]);

  async function addTags() {
    if (!document || newTags.length === 0) return;
    setSavingTags(true);
    try {
      await api.addDocumentTags(document.id, splitTags(newTags));
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
    if (!document || !canWrite) return;
    try {
      await api.removeDocumentTag(document.id, tag.id);
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

  /**
   * 下载文档内部对象：必须走文档版本端点（document_internal 无文档上下文会 403）。
   * versionNo 为 null 时回退到当前版本。
   */
  async function downloadObject(objectId: string, versionNo?: number | null) {
    const effectiveNo = versionNo ?? currentVersionNo;
    if (!effectiveNo) {
      toast({ title: "无法下载", description: "文档尚未发布版本", tone: "warning" });
      return;
    }
    try {
      const result = await api.documentObjectDownloadUrl(documentId, effectiveNo, objectId);
      window.open(result.url, "_blank", "noopener,noreferrer");
      // 中文注释：签发成功给出反馈，与对象详情页一致
      toast({ title: "已签发下载链接", description: `有效期 ${result.expires_in} 秒`, tone: "success" });
    } catch (error) {
      toast({
        title: "获取下载链接失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    }
  }

  /** 打开预览对话框；content_type 缺省时按 application/octet-stream 走下载提示 */
  function openPreview(
    objectId: string,
    displayName: string,
    contentType?: string | null,
    versionNo?: number | null,
    sizeBytes?: number | null,
  ) {
    const effectiveNo = versionNo ?? currentVersionNo;
    if (!effectiveNo) {
      toast({ title: "无法预览", description: "文档尚未发布版本", tone: "warning" });
      return;
    }
    setPreviewTarget({
      objectId,
      displayName,
      contentType: contentType || "application/octet-stream",
      versionNo: effectiveNo,
      sizeBytes: sizeBytes ?? null,
    });
  }

  async function deleteVersion(target: VersionItem) {
    setDeleting(true);
    try {
      const result = await api.deleteVersion(documentId, target.version_no);
      toast({
        title: "版本删除已受理",
        description: result.purge_after
          ? `v${target.version_no} 进入回收站，按保留策略自动永久删除`
          : `v${target.version_no} 已软删，按保留策略自动清除`,
        tone: "success",
      });
      setVersionToDelete(null);
      if (activeVersion?.id === target.id) setActiveVersion(null);
      versions.reload();
      detail.reload();
    } catch (error) {
      toast({
        title: "删除版本失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  /** 恢复软删版本 */
  async function restoreVersion(target: VersionItem) {
    setDeleting(true);
    try {
      await api.restoreVersion(documentId, target.version_no);
      toast({ title: "版本已恢复", description: `v${target.version_no}`, tone: "success" });
      setVersionToRestore(null);
      versions.reload();
      detail.reload();
    } catch (error) {
      toast({
        title: "恢复版本失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  async function deleteDocument() {
    setDeleting(true);
    try {
      const result = await api.deleteDocument(documentId);
      if (result) {
        toast({
          title: "文档删除已受理",
          description: "进入回收站，按保留策略自动永久删除；窗口内可在回收站恢复",
          tone: "success",
        });
      } else {
        toast({ title: "文档已删除", description: "该文档此前已删除", tone: "success" });
      }
      setConfirmDocDelete(false);
      navigate("/documents");
    } catch (error) {
      toast({
        title: "删除文档失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  /** 恢复软删文档 */
  async function restoreDocument() {
    setDeleting(true);
    try {
      await api.restoreDocument(documentId);
      toast({ title: "文档已恢复", tone: "success" });
      setConfirmDocRestore(false);
      setTrashItem(null);
      detail.reload();
      versions.reload();
    } catch (error) {
      toast({
        title: "恢复文档失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  const displayVersion = activeVersion || document?.current_version || null;
  // 中文注释：文档已软删（详情 404 但回收站命中）时只展示恢复入口
  const isTrashed = !document && Boolean(trashItem);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/documents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            返回文档列表
          </Link>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">
            {document ? (
              document.title
            ) : trashItem ? (
              trashItem.title
            ) : (
              <Skeleton className="inline-block h-8 w-56" />
            )}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{documentId}</span>
            {document ? (
              <>
                <Badge variant="brand">{document.doc_type}</Badge>
                <Badge variant="secondary">{document.source}</Badge>
                <Badge variant="outline">external_id: {truncate(document.external_id, 24)}</Badge>
              </>
            ) : null}
            {trashItem ? (
              <>
                <Badge variant="warning">回收站</Badge>
                <RemainingBadge purgeAfter={trashItem.purge_after} />
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              detail.reload();
              versions.reload();
              setTrashItem(null);
            }}
            disabled={detail.loading}
          >
            <RefreshCw className={detail.loading ? "size-4 animate-spin" : "size-4"} />
            刷新
          </Button>
          {document ? (
            <Button variant="outline" onClick={() => setShareOpen(true)}>
              <Link2 className="size-4" />
              分享
            </Button>
          ) : null}
          {canWrite && isTrashed ? (
            <Button
              variant="outline"
              onClick={() => setConfirmDocRestore(true)}
              disabled={deleting || !restorableWindow(trashItem?.purge_after)}
              title={
                restorableWindow(trashItem?.purge_after)
                  ? "恢复文档"
                  : "已过恢复窗口或无恢复窗口，不可恢复"
              }
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
              恢复文档
            </Button>
          ) : null}
          {canWrite && document ? (
            <>
              <Button onClick={() => setReclassifyOpen(true)}>
                <Shuffle className="size-4" />
                重分类
              </Button>
              <Button variant="destructive" onClick={() => setConfirmDocDelete(true)} disabled={deleting}>
                <Trash2 className="size-4" />
                删除文档
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {detail.error && !trashItem ? (
        <ErrorAlert error={detail.error} title="文档加载失败" />
      ) : null}
      {trashLookup ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在查询回收站…
        </div>
      ) : null}

      {isTrashed ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trash2 className="size-4" />
              文档在回收站
            </CardTitle>
            <CardDescription className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-foreground">
              该文档已删除，恢复期内可撤销；到期后自动永久清除。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">删除时间</div>
                <div className="mt-0.5">{formatDateTime(trashItem!.deleted_at)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">自动清除时间</div>
                <div className="mt-0.5">{formatDateTime(trashItem!.purge_after)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">剩余恢复期</div>
                <div className="mt-1">
                  <RemainingBadge purgeAfter={trashItem!.purge_after} />
                </div>
              </div>
            </div>
            {canWrite ? (
              <Button
                onClick={() => setConfirmDocRestore(true)}
                disabled={deleting || !restorableWindow(trashItem!.purge_after)}
                title={
                  restorableWindow(trashItem!.purge_after)
                    ? "恢复文档"
                    : "已过恢复窗口或无恢复窗口，不可恢复"
                }
              >
                {deleting ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
                恢复文档
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">只读角色不能恢复文档，请联系管理员。</p>
            )}
          </CardContent>
        </Card>
      ) : document ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            {/* 当前 / 选中版本 */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="size-4" />
                      {activeVersion ? `版本 v${activeVersion.version_no}` : "当前版本"}
                      {displayVersion ? (
                        <Badge variant={statusMeta(displayVersion.status).tone === "success" ? "success" : "secondary"}>
                          {statusMeta(displayVersion.status).label}
                        </Badge>
                      ) : null}
                    </CardTitle>
                    <CardDescription>
                      {displayVersion?.published_at
                        ? `发布于 ${formatDateTime(displayVersion.published_at)}`
                        : "尚未选择历史版本"}
                    </CardDescription>
                  </div>
                  {activeVersion ? (
                    <Button variant="outline" size="sm" onClick={() => setActiveVersion(null)}>
                      查看当前版本
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {!displayVersion ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">文档尚未发布版本</div>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ObjectLink objectId={displayVersion.raw_object_id} label="原文对象 raw_object_id" />
                      <ObjectLink objectId={displayVersion.body_object_id} label="正文对象 body_object_id" />
                    </div>
                    {displayVersion.status === "deleted" ? (
                      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                        该版本已删除，进入回收站，按保留策略自动永久删除。
                        {canWrite ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-2"
                            disabled={deleting || !restorableWindow(displayVersion.purge_after)}
                            title={
                              restorableWindow(displayVersion.purge_after)
                                ? "恢复版本"
                                : "已过恢复窗口或无恢复窗口，不可恢复"
                            }
                            onClick={() => setVersionToRestore(displayVersion)}
                          >
                            <Undo2 className="size-3" />
                            恢复版本
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {displayVersion.raw_object_id || displayVersion.body_object_id ? (
                      <div className="flex flex-wrap gap-2">
                        {displayVersion.raw_object_id ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                openPreview(
                                  displayVersion.raw_object_id!,
                                  `raw-v${displayVersion.version_no}`,
                                  displayVersion.raw_content_type,
                                  displayVersion.version_no,
                                  displayVersion.raw_size_bytes,
                                )
                              }
                            >
                              <Eye className="size-4" />
                              预览原文
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadObject(displayVersion.raw_object_id!, displayVersion.version_no)}
                            >
                              <Download className="size-4" />
                              下载原文
                            </Button>
                          </>
                        ) : null}
                        {displayVersion.body_object_id ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                openPreview(
                                  displayVersion.body_object_id!,
                                  `body-v${displayVersion.version_no}`,
                                  displayVersion.body_content_type,
                                  displayVersion.version_no,
                                  displayVersion.body_size_bytes,
                                )
                              }
                            >
                              <Eye className="size-4" />
                              预览正文
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadObject(displayVersion.body_object_id!, displayVersion.version_no)}
                            >
                              <Download className="size-4" />
                              下载正文
                            </Button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    <div>
                      <div className="mb-2 text-xs text-muted-foreground">版本属性 attrs（类型专有属性快照）</div>
                      <pre className="max-h-52 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">
                        {prettyJson(displayVersion.attrs)}
                      </pre>
                    </div>
                    <Separator />
                    <div>
                      <div className="mb-2 text-xs font-medium">附件与图片</div>
                      {displayVersion.assets.length === 0 ? (
                        <div className="text-sm text-muted-foreground">本版本无附件</div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>角色</TableHead>
                              <TableHead>顺序</TableHead>
                              <TableHead>引用名</TableHead>
                              <TableHead>对象 ID</TableHead>
                              <TableHead className="text-right">操作</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {displayVersion.assets.map((asset) => (
                              <TableRow key={`${asset.object_id}-${asset.role}-${asset.ordinal}`}>
                                <TableCell>
                                  <Badge variant="secondary">{assetRoleLabel(asset.role)}</Badge>
                                </TableCell>
                                <TableCell className="tabular-nums">{asset.ordinal}</TableCell>
                                <TableCell className="text-xs">{asset.reference_name || "—"}</TableCell>
                                <TableCell>
                                  <Link
                                    to={`/objects/${asset.object_id}`}
                                    className="break-all font-mono text-xs text-primary hover:underline"
                                  >
                                    {truncate(asset.object_id, 18)}
                                  </Link>
                                </TableCell>
                                <TableCell>
                                  <div className="flex justify-end">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      title="预览附件"
                                      onClick={() =>
                                        openPreview(
                                          asset.object_id,
                                          asset.reference_name || asset.object_id,
                                          asset.content_type,
                                          displayVersion.version_no,
                                          asset.size_bytes,
                                        )
                                      }
                                    >
                                      <Eye className="size-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      title="下载附件"
                                      onClick={() => downloadObject(asset.object_id, displayVersion.version_no)}
                                    >
                                      <Download className="size-4" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* 版本历史 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <History className="size-4" />
                  版本历史
                  <InfoHint content="历史版本持续追加；附件关系固定在版本上，不随当前版变化。" label="查看版本历史说明" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                {versions.error ? <ErrorAlert error={versions.error} title="版本列表加载失败" /> : null}
                {versions.loading && !versions.data ? (
                  <Skeleton className="h-24" />
                ) : (versions.data?.items || []).length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">暂无已发布版本</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>版本</TableHead>
                        <TableHead>类型快照</TableHead>
                        <TableHead>发布时间</TableHead>
                        <TableHead>附件数</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(versions.data?.items || []).map((version) => (
                        <TableRow
                          key={version.id}
                          className={displayVersion?.id === version.id ? "bg-muted/50" : undefined}
                        >
                          <TableCell>
                            <span className="font-medium">v{version.version_no}</span>
                            {document.current_version_id === version.id ? (
                              <Badge variant="success" className="ml-2">
                                当前
                              </Badge>
                            ) : null}
                            {version.status === "deleted" ? (
                              <Badge variant="warning" className="ml-2">
                                已删除
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant="brand">{version.doc_type}</Badge>
                          </TableCell>
                          <TableCell className="cell-muted">{formatDateTime(version.published_at)}</TableCell>
                          <TableCell className="tabular-nums">{version.assets.length}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button variant="outline" size="sm" onClick={() => setActiveVersion(version)}>
                                查看
                              </Button>
                              {canWrite && version.status === "deleted" ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={
                                    restorableWindow(version.purge_after)
                                      ? "恢复该版本"
                                      : "已过恢复窗口或无恢复窗口，不可恢复"
                                  }
                                  disabled={deleting || !restorableWindow(version.purge_after)}
                                  onClick={() => setVersionToRestore(version)}
                                >
                                  <Undo2 className="size-4 text-success" />
                                </Button>
                              ) : null}
                              {canWrite &&
                              version.status !== "deleted" &&
                              document.current_version_id !== version.id ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="删除该版本（当前版本受保护）"
                                  onClick={() => setVersionToDelete(version)}
                                >
                                  <Trash2 className="size-4 text-destructive" />
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* 版本对比 */}
            {(versions.data?.items || []).length >= 2 ? (
              <VersionComparePanel versions={versions.data?.items || []} />
            ) : null}
          </div>

          {/* 侧栏：标签与元数据 */}
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  标签
                  <InfoHint content="标签随逻辑文档存在，新增版本仍可见；附件对象不自动继承。" label="查看文档标签说明" />
                </CardTitle>
                {!canWrite ? <CardDescription>只读角色不可修改标签。</CardDescription> : null}
              </CardHeader>
              <CardContent className="space-y-4">
                <TagList tags={document.tags} onRemove={canWrite ? removeTag : undefined} />
                {canWrite ? (
                  <div className="space-y-2">
                    <TagPicker value={newTags} onChange={setNewTags} disabled={savingTags} />
                    <Button onClick={addTags} disabled={savingTags || newTags.length === 0} className="w-full">
                      {savingTags ? <Loader2 className="size-4 animate-spin" /> : null}
                      绑定标签
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  文档属性
                  <InfoHint content="随逻辑文档稳定的补充属性。" label="查看文档属性说明" />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">创建时间</div>
                  <div className="mt-0.5">{formatDateTime(document.created_at)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">当前版本 ID</div>
                  <div className="mt-0.5 break-all font-mono text-xs">{document.current_version_id || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">attrs</div>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs">
                    {prettyJson(document.attrs)}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : detail.loading || trashLookup ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Skeleton className="h-72 lg:col-span-2" />
          <Skeleton className="h-72" />
        </div>
      ) : null}

      {document ? (
        <ReclassifyDialog
          open={reclassifyOpen}
          onOpenChange={setReclassifyOpen}
          document={document}
          types={types.data?.items || []}
          onDone={(updated) => {
            detail.reload();
            versions.reload();
            setActiveVersion(updated.current_version || null);
          }}
        />
      ) : null}

      <ObjectPreviewDialog
        open={Boolean(previewTarget)}
        onOpenChange={(open) => !open && setPreviewTarget(null)}
        displayName={previewTarget?.displayName || ""}
        contentType={previewTarget?.contentType || ""}
        sizeBytes={previewTarget?.sizeBytes}
        resolveUrl={() =>
          api.documentObjectDownloadUrl(
            documentId,
            previewTarget!.versionNo,
            previewTarget!.objectId,
            { disposition: "inline", ttl_seconds: PREVIEW_TTL_SECONDS },
          )
        }
        onDownload={
          previewTarget
            ? () => downloadObject(previewTarget.objectId, previewTarget.versionNo)
            : undefined
        }
      />

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        targetType="document"
        targetId={documentId}
        targetName={document?.title}
      />

      <ConfirmDialog
        open={Boolean(versionToDelete)}
        onOpenChange={(open) => !open && setVersionToDelete(null)}
        title="确认删除版本"
        description={
          versionToDelete
            ? `确认删除 v${versionToDelete.version_no}？进入回收站，按保留策略自动永久删除；当前版本受保护无法删除。`
            : undefined
        }
        confirmLabel="删除版本"
        destructive
        busy={deleting}
        onConfirm={() => {
          if (versionToDelete) void deleteVersion(versionToDelete);
        }}
      />

      <ConfirmDialog
        open={Boolean(versionToRestore)}
        onOpenChange={(open) => !open && setVersionToRestore(null)}
        title="确认恢复版本"
        description={
          versionToRestore
            ? `确认恢复 v${versionToRestore.version_no}？恢复后版本重新可见。`
            : undefined
        }
        confirmLabel="恢复版本"
        busy={deleting}
        onConfirm={() => {
          if (versionToRestore) void restoreVersion(versionToRestore);
        }}
      />

      <ConfirmDialog
        open={confirmDocDelete}
        onOpenChange={(open) => !open && setConfirmDocDelete(false)}
        title="确认删除文档"
        description="删除后文档与其全部版本进入回收站，按保留策略自动永久删除；恢复窗口内可在回收站撤销。"
        confirmLabel="删除文档"
        destructive
        busy={deleting}
        onConfirm={() => void deleteDocument()}
      />

      <ConfirmDialog
        open={confirmDocRestore}
        onOpenChange={(open) => !open && setConfirmDocRestore(false)}
        title="确认恢复文档"
        description="恢复后文档重新可见，可继续浏览与管理。"
        confirmLabel="恢复文档"
        busy={deleting}
        onConfirm={() => void restoreDocument()}
      />
    </div>
  );
}
