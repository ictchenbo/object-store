import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Eye, Filter, Loader2, Plus, RefreshCw, Search, Tag as TagIcon, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ObjectFilters, ObjectItem, ObjectSort, TagItem } from "@/lib/types";
import { daysUntil, formatBytes, formatDateTime, statusMeta, truncate } from "@/lib/format";
import { PREVIEW_TTL_SECONDS } from "@/lib/preview/limits";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Pagination } from "@/components/common/Pagination";
import { TagList } from "@/components/tags/TagList";
import { TagPicker, splitTags } from "@/components/tags/TagPicker";
import { ObjectPreviewDialog } from "@/components/objects/ObjectPreviewDialog";
import { UploadObjectDialog } from "@/components/objects/UploadObjectDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";

const PAGE_SIZE = 20;
/** 批量操作上限：单次最多处理 200 个对象，避免长时间占用请求 */
const BATCH_LIMIT = 200;

/** 是否仍在恢复窗口内（与后端 restore 校验对齐：无窗口/已到期均不可恢复） */
function restorableObject(item: ObjectItem): boolean {
  if (!item.purge_after) return false;
  const days = daysUntil(item.purge_after);
  return days !== null && days > 0;
}
/** 批量并发数：前端并发池，不建服务端批量端点 */
const BATCH_CONCURRENCY = 4;

interface BatchResult {
  ok: number;
  failed: { id: string; message: string; requestId?: string }[];
}

/**
 * 前端并发池：固定并发度执行任务，返回成功/失败明细。
 * 单项失败不影响其他项；失败信息含 request_id 便于排查。
 */
async function runBatch<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
): Promise<BatchResult> {
  const result: BatchResult = { ok: 0, failed: [] };
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      try {
        await worker(item);
        result.ok += 1;
      } catch (error) {
        const requestId = error instanceof ApiError ? error.requestId : undefined;
        result.failed.push({
          id: String((item as { id?: string }).id ?? index),
          message: error instanceof Error ? error.message : String(error),
          requestId,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, () => runner()));
  return result;
}

/** 汇总批量结果为一条提示 */
function summarize(title: string, result: BatchResult) {
  const failText = result.failed.length
    ? `失败 ${result.failed.length}：${result.failed
        .slice(0, 3)
        .map((item) => `${item.id.slice(0, 8)}${item.requestId ? `(${item.requestId})` : ""}`)
        .join("；")}${result.failed.length > 3 ? "…" : ""}`
    : "";
  toast({
    title: `${title}：成功 ${result.ok} / 失败 ${result.failed.length}`,
    description: failText || "全部处理完成",
    tone: result.failed.length ? "warning" : "success",
  });
}

/** 对象列表页：搜索/排序/筛选 + 游标分页 + 上传/下载/删除 */
export function ObjectsPage() {
  const { canWrite } = useAuth();
  const [searchParams] = useSearchParams();
  const tagFromUrl = searchParams.get("tag") || "";
  // 中文注释：搜索框防抖 300ms 后触发查询
  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState<ObjectSort>("newest");
  const [filters, setFilters] = React.useState({
    name_prefix: "",
    bucket: "",
    content_type: "",
    content_type_prefix: "",
    sha256: "",
    ready_from: "",
    ready_to: "",
    min_size: "",
    max_size: "",
  });
  const [tagMode, setTagMode] = React.useState<"all" | "any">("all");
  const [selectedTags, setSelectedTags] = React.useState<TagItem[]>([]);
  const [applied, setApplied] = React.useState({
    ...filters,
    tag_ids: [] as string[],
    tag: tagFromUrl,
    tag_mode: "all" as "all" | "any",
  });
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = React.useState<ObjectItem | null>(null);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);
  // 中文注释：批量选择与操作；仅对当前页可见项生效
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = React.useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = React.useState(false);
  const [batchTagOpen, setBatchTagOpen] = React.useState(false);
  const [batchTags, setBatchTags] = React.useState<TagItem[]>([]);
  const [previewTarget, setPreviewTarget] = React.useState<ObjectItem | null>(null);

  const cursor = cursorStack[pageIndex];

  // 中文注释：搜索防抖 300ms 后触发查询并重置分页游标
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qInput.trim());
      setCursorStack([null]);
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [qInput]);

  function onSortChange(value: ObjectSort) {
    setSort(value);
    setCursorStack([null]);
    setPageIndex(0);
  }

  const list = useAsync(() => {
    const params: ObjectFilters = {
      limit: PAGE_SIZE,
      cursor,
      q: q || undefined,
      sort,
      name_prefix: applied.name_prefix || undefined,
      bucket: applied.bucket || undefined,
      content_type: applied.content_type || undefined,
      content_type_prefix: applied.content_type_prefix || undefined,
      sha256: applied.sha256 || undefined,
      ready_from: applied.ready_from || undefined,
      ready_to: applied.ready_to ? `${applied.ready_to}T23:59:59` : undefined,
      min_size: applied.min_size ? Number(applied.min_size) : null,
      max_size: applied.max_size ? Number(applied.max_size) : null,
      tag: applied.tag || undefined,
      tag_ids: applied.tag_ids.length ? applied.tag_ids : undefined,
      tag_mode: applied.tag_mode,
    };
    return api.listObjects(params);
  }, [cursor, applied, q, sort, refreshKey]);

  function applyFilters() {
    const { tag_ids, new_tag_names } = splitTags(selectedTags);
    if (new_tag_names.length) {
      toast({ title: "筛选只能使用已有标签", description: "列表筛选不自动创建标签", tone: "warning" });
      return;
    }
    setApplied({ ...filters, tag_ids, tag: "", tag_mode: tagMode });
    setCursorStack([null]);
    setPageIndex(0);
  }

  function resetFilters() {
    const empty = {
      name_prefix: "",
      bucket: "",
      content_type: "",
      content_type_prefix: "",
      sha256: "",
      ready_from: "",
      ready_to: "",
      min_size: "",
      max_size: "",
    };
    setQInput("");
    setQ("");
    setSort("newest");
    setFilters(empty);
    setSelectedTags([]);
    setTagMode("all");
    setApplied({ ...empty, tag_ids: [], tag: tagFromUrl, tag_mode: "all" });
    setCursorStack([null]);
    setPageIndex(0);
  }

  async function download(item: ObjectItem) {
    setDownloadingId(item.id);
    try {
      const result = await api.downloadUrl(item.id);
      window.open(result.url, "_blank", "noopener,noreferrer");
      toast({ title: "已签发下载链接", description: `有效期 ${result.expires_in} 秒`, tone: "success" });
    } catch (error) {
      toast({
        title: "获取下载链接失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  async function remove(item: ObjectItem) {
    setDeletingId(item.id);
    try {
      const result = await api.deleteObject(item.id);
      // 中文注释：202=软删受理（进回收站可恢复）；204=已删除（幂等重放）
      toast({
        title: result ? "删除已受理" : "对象已删除",
        description: result ? "进入回收站，按保留策略自动永久删除" : "该对象此前已删除",
        tone: "success",
      });
      setConfirmTarget(null);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast({
        title: "删除失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  }

  /** 恢复软删对象（status=deleting） */
  async function restore(item: ObjectItem) {
    setRestoringId(item.id);
    try {
      await api.restoreObject(item.id);
      toast({ title: "对象已恢复", description: item.display_name, tone: "success" });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast({
        title: "恢复失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setRestoringId(null);
    }
  }

  const items = list.data?.items || [];
  const nextCursor = list.data?.next_cursor || null;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const pageIds = items.map((item) => item.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (allSelected) next.delete(id);
        else if (next.size < BATCH_LIMIT) next.add(id);
      }
      return next;
    });
    if (!allSelected && pageIds.length > BATCH_LIMIT) {
      toast({
        title: "已达批量上限",
        description: `单次最多 ${BATCH_LIMIT} 个对象，已截断选择`,
        tone: "warning",
      });
    }
  }

  /** 批量删除：并发池逐个调用删除接口，汇总成功/失败 */
  async function batchDelete() {
    const targets = items.filter((item) => selectedIds.has(item.id)).slice(0, BATCH_LIMIT);
    if (targets.length === 0) return;
    setBatchBusy(true);
    try {
      const result = await runBatch(targets, async (item) => {
        await api.deleteObject(item.id);
      });
      summarize("批量删除", result);
      setConfirmBatchDelete(false);
      setSelectedIds(new Set());
      setRefreshKey((value) => value + 1);
    } finally {
      setBatchBusy(false);
    }
  }

  /** 批量打标：并发池逐个绑定标签 */
  async function batchAddTags() {
    const targets = items.filter((item) => selectedIds.has(item.id)).slice(0, BATCH_LIMIT);
    if (targets.length === 0) return;
    const payload = splitTags(batchTags);
    if (payload.tag_ids.length === 0 && payload.new_tag_names.length === 0) {
      toast({ title: "请先选择或输入标签", tone: "warning" });
      return;
    }
    setBatchBusy(true);
    try {
      const result = await runBatch(targets, async (item) => {
        await api.addObjectTags(item.id, payload);
      });
      summarize("批量打标", result);
      setBatchTagOpen(false);
      setBatchTags([]);
      setSelectedIds(new Set());
      setRefreshKey((value) => value + 1);
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            对象
            <InfoHint content="仅列出独立且就绪的对象；文档内部对象请通过文档详情访问。" label="查看对象列表说明" />
          </h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={list.loading}>
            {list.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
          {canWrite ? (
            <Button onClick={() => setUploadOpen(true)}>
              <Plus className="size-4" />
              上传对象
            </Button>
          ) : null}
        </div>
      </div>

      {/* 筛选区 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="size-4" />
            搜索与筛选
            <InfoHint content="关键词输入 300ms 后自动查询；可按名称前缀、桶、媒体类型、就绪时间、大小、哈希与标签组合过滤。" label="查看对象筛选说明" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="关键词-q">关键词</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="关键词-q"
                  value={qInput}
                  placeholder="显示名模糊搜索…"
                  className="pl-8"
                  onChange={(event) => setQInput(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="排序-sort">排序</Label>
              <Select value={sort} onValueChange={(value: ObjectSort) => onSortChange(value)}>
                <SelectTrigger id="排序-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">创建时间从新到旧</SelectItem>
                  <SelectItem value="oldest">创建时间从旧到新</SelectItem>
                  <SelectItem value="name_asc">名称 A→Z</SelectItem>
                  <SelectItem value="name_desc">名称 Z→A</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="名称前缀">名称前缀</Label>
              <Input id="名称前缀"
                value={filters.name_prefix}
                placeholder="display_name 前缀"
                onChange={(event) => setFilters((prev) => ({ ...prev, name_prefix: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="媒体类型前缀">媒体类型前缀</Label>
              <Input id="媒体类型前缀"
                value={filters.content_type_prefix}
                placeholder="如 image/ 或 application/pdf"
                onChange={(event) => setFilters((prev) => ({ ...prev, content_type_prefix: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="桶">桶</Label>
              <Input id="桶"
                value={filters.bucket}
                placeholder="objects"
                onChange={(event) => setFilters((prev) => ({ ...prev, bucket: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="媒体类型">媒体类型（精确）</Label>
              <Input id="媒体类型"
                value={filters.content_type}
                placeholder="application/pdf"
                onChange={(event) => setFilters((prev) => ({ ...prev, content_type: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sha256">SHA-256</Label>
              <Input id="sha256"
                value={filters.sha256}
                placeholder="64 位十六进制"
                onChange={(event) => setFilters((prev) => ({ ...prev, sha256: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="标签匹配">标签匹配</Label>
              <Select value={tagMode} onValueChange={(value: "all" | "any") => setTagMode(value)}>
                <SelectTrigger id="标签匹配">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">同时具备（all）</SelectItem>
                  <SelectItem value="any">具备其一（any）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="就绪起日期">就绪起（日期）</Label>
              <Input id="就绪起日期"
                type="date"
                value={filters.ready_from}
                onChange={(event) => setFilters((prev) => ({ ...prev, ready_from: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="就绪止日期">就绪止（日期）</Label>
              <Input id="就绪止日期"
                type="date"
                value={filters.ready_to}
                onChange={(event) => setFilters((prev) => ({ ...prev, ready_to: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="最小字节">最小字节</Label>
              <Input id="最小字节"
                type="number"
                min={0}
                value={filters.min_size}
                placeholder="0"
                onChange={(event) => setFilters((prev) => ({ ...prev, min_size: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="最大字节">最大字节</Label>
              <Input id="最大字节"
                type="number"
                min={0}
                value={filters.max_size}
                placeholder="不限"
                onChange={(event) => setFilters((prev) => ({ ...prev, max_size: event.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="标签已有标签未知标签返回空列表">标签（已有标签；未知标签返回空列表）</Label>
            <TagPicker inputId="标签已有标签未知标签返回空列表" value={selectedTags} onChange={setSelectedTags} placeholder="搜索对象标签…" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={applyFilters}>
              <Search className="size-4" />
              查询
            </Button>
            <Button variant="outline" onClick={resetFilters}>
              重置
            </Button>
            {applied.tag ? (
              <Badge variant="brand" className="gap-1">
                标签：{applied.tag}
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-brand/20"
                  aria-label="清除标签筛选"
                  onClick={() => setApplied((prev) => ({ ...prev, tag: "" }))}
                >
                  ×
                </button>
              </Badge>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {list.error ? <ErrorAlert error={list.error} title="对象列表加载失败" /> : null}

      {/* 批量操作栏 */}
      {canWrite && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 px-4 py-2">
          <span className="text-sm font-medium">已选 {selectedIds.size} 个对象</span>
          <Badge variant="outline">上限 {BATCH_LIMIT}</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={batchBusy} onClick={() => setBatchTagOpen(true)}>
              {batchBusy ? <Loader2 className="size-4 animate-spin" /> : <TagIcon className="size-4" />}
              批量打标
            </Button>
            <Button size="sm" variant="destructive" disabled={batchBusy} onClick={() => setConfirmBatchDelete(true)}>
              {batchBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              批量删除
            </Button>
            <Button size="sm" variant="ghost" disabled={batchBusy} onClick={() => setSelectedIds(new Set())}>
              <X className="size-4" />
              清除选择
            </Button>
          </div>
        </div>
      ) : null}

      {/* 列表 */}
      {list.loading && !list.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="没有匹配的对象"
          description="调整筛选条件，或上传新的独立对象。"
          action={
            canWrite ? (
              <Button onClick={() => setUploadOpen(true)}>
                <Plus className="size-4" />
                上传对象
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {canWrite ? (
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="全选当前页"
                        checked={
                          items.length > 0 &&
                          items.every((item) => selectedIds.has(item.id))
                        }
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                  ) : null}
                  <TableHead>名称</TableHead>
                  <TableHead>媒体类型</TableHead>
                  <TableHead className="text-right">大小</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>就绪时间</TableHead>
                  <TableHead>标签</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    {canWrite ? (
                      <TableCell>
                        <Checkbox
                          aria-label={`选择 ${item.display_name}`}
                          checked={selectedIds.has(item.id)}
                          onCheckedChange={() => toggleSelect(item.id)}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <Link to={`/objects/${item.id}`} className="font-medium text-primary hover:underline">
                        {truncate(item.display_name, 36)}
                      </Link>
                      <div className="cell-muted">{item.bucket}</div>
                    </TableCell>
                    <TableCell className="text-xs">{item.content_type}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(item.size_bytes)}</TableCell>
                    <TableCell>
                      <Badge variant={statusMeta(item.status).tone === "success" ? "success" : "secondary"}>
                        {statusMeta(item.status).label}
                      </Badge>
                    </TableCell>
                    <TableCell className="cell-muted">{formatDateTime(item.ready_at)}</TableCell>
                    <TableCell>
                      <TagList tags={item.tags} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="预览"
                          onClick={() => setPreviewTarget(item)}
                        >
                          <Eye className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="下载"
                          disabled={downloadingId === item.id}
                          onClick={() => download(item)}
                        >
                          {downloadingId === item.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Download className="size-4" />
                          )}
                        </Button>
                        {canWrite && item.status === "deleting" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={
                              restorableObject(item)
                                ? "恢复"
                                : "已过恢复窗口或无恢复窗口，不可恢复"
                            }
                            disabled={restoringId === item.id || !restorableObject(item)}
                            onClick={() => restore(item)}
                          >
                            {restoringId === item.id ? (
                              <Loader2 className="size-4 animate-spin text-success" />
                            ) : (
                              <RefreshCw className="size-4 text-success" />
                            )}
                          </Button>
                        ) : null}
                        {canWrite && item.status !== "deleting" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="删除"
                            disabled={deletingId === item.id}
                            onClick={() => setConfirmTarget(item)}
                          >
                            {deletingId === item.id ? (
                              <Loader2 className="size-4 animate-spin text-destructive" />
                            ) : (
                              <Trash2 className="size-4 text-destructive" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="px-4 pb-3">
              <Pagination
                hasNext={Boolean(nextCursor)}
                hasPrev={pageIndex > 0}
                loading={list.loading}
                page={pageIndex + 1}
                onNext={() => {
                  if (!nextCursor) return;
                  setCursorStack((stack) => {
                    const next = [...stack];
                    next[pageIndex + 1] = nextCursor;
                    return next;
                  });
                  setPageIndex((value) => value + 1);
                }}
                onPrev={() => setPageIndex((value) => Math.max(0, value - 1))}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <UploadObjectDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => setRefreshKey((value) => value + 1)}
      />

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title="确认删除对象"
        description={
          confirmTarget
            ? `确认删除对象「${confirmTarget.display_name}」？删除进入回收站，按保留策略自动永久删除；恢复窗口内可撤销。`
            : undefined
        }
        confirmLabel="删除"
        destructive
        busy={Boolean(deletingId)}
        onConfirm={() => {
          if (confirmTarget) void remove(confirmTarget);
        }}
      />

      <ConfirmDialog
        open={confirmBatchDelete}
        onOpenChange={(open) => !open && setConfirmBatchDelete(false)}
        title="确认批量删除对象"
        description={`将删除已选 ${Math.min(selectedIds.size, BATCH_LIMIT)} 个对象。删除进入回收站，按保留策略自动永久删除；被文档引用的对象会被拒绝。`}
        confirmLabel="批量删除"
        destructive
        busy={batchBusy}
        onConfirm={() => void batchDelete()}
      />

      <ObjectPreviewDialog
        open={Boolean(previewTarget)}
        onOpenChange={(open) => !open && setPreviewTarget(null)}
        displayName={previewTarget?.display_name || ""}
        contentType={previewTarget?.content_type || ""}
        sizeBytes={previewTarget?.size_bytes}
        resolveUrl={() =>
          api.objectDownloadUrl(previewTarget!.id, {
            disposition: "inline",
            ttl_seconds: PREVIEW_TTL_SECONDS,
          })
        }
        onDownload={previewTarget ? () => void download(previewTarget) : undefined}
      />

      <Dialog open={batchTagOpen} onOpenChange={(open) => !batchBusy && setBatchTagOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量打标</DialogTitle>
            <DialogDescription>
              为已选 {Math.min(selectedIds.size, BATCH_LIMIT)} 个对象绑定标签；新名称会自动创建。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="批量标签">标签</Label>
            <TagPicker inputId="批量标签" value={batchTags} onChange={setBatchTags} disabled={batchBusy} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchTagOpen(false)} disabled={batchBusy}>
              取消
            </Button>
            <Button onClick={() => void batchAddTags()} disabled={batchBusy || batchTags.length === 0}>
              {batchBusy ? <Loader2 className="size-4 animate-spin" /> : <TagIcon className="size-4" />}
              绑定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
