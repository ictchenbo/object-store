import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import type { DocumentFilters, DocumentSort, TagItem } from "@/lib/types";
import { formatDateTime, truncate } from "@/lib/format";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Pagination } from "@/components/common/Pagination";
import { TagList } from "@/components/tags/TagList";
import { TagPicker, splitTags } from "@/components/tags/TagPicker";
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
/** 批量操作上限（与服务端 BulkTagInput/BulkDeleteInput max_length 一致） */
const BATCH_LIMIT = 200;

/** 文档列表：关键词搜索、排序、类型/来源/标签筛选，游标分页 + 批量操作 */
export function DocumentsPage() {
  const { canWrite } = useAuth();
  const [searchParams] = useSearchParams();
  const tagFromUrl = searchParams.get("tag") || "";
  // 中文注释：即时输入态；q 经防抖 300ms 进入查询参数，避免每键一次请求
  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState<DocumentSort>("newest");
  const [docType, setDocType] = React.useState("");
  const [source, setSource] = React.useState("");
  const [createdFrom, setCreatedFrom] = React.useState("");
  const [createdTo, setCreatedTo] = React.useState("");
  const [tagMode, setTagMode] = React.useState<"all" | "any">("all");
  const [selectedTags, setSelectedTags] = React.useState<TagItem[]>([]);
  const [applied, setApplied] = React.useState({
    doc_type: "",
    source: "",
    created_from: "",
    created_to: "",
    tag_ids: [] as string[],
    tag: tagFromUrl,
    tag_mode: "all" as "all" | "any",
  });
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = React.useState(0);
  // 中文注释：批量选择与操作；仅对当前页可见项生效
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = React.useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = React.useState(false);
  const [batchTagOpen, setBatchTagOpen] = React.useState(false);
  const [batchTags, setBatchTags] = React.useState<TagItem[]>([]);
  const cursor = cursorStack[pageIndex];

  // 中文注释：搜索框防抖 300ms 后触发查询并重置分页游标
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qInput.trim());
      setCursorStack([null]);
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [qInput]);

  // 中文注释：排序变化立即重查
  function onSortChange(value: DocumentSort) {
    setSort(value);
    setCursorStack([null]);
    setPageIndex(0);
  }

  const types = useAsync(() => api.listDocumentTypes(), []);
  const list = useAsync(() => {
    const params: DocumentFilters = {
      limit: PAGE_SIZE,
      cursor,
      q: q || undefined,
      sort,
      doc_type: applied.doc_type || undefined,
      source: applied.source || undefined,
      created_from: applied.created_from ? `${applied.created_from}T00:00:00` : undefined,
      created_to: applied.created_to ? `${applied.created_to}T23:59:59` : undefined,
      tag: applied.tag || undefined,
      tag_ids: applied.tag_ids.length ? applied.tag_ids : undefined,
      tag_mode: applied.tag_mode,
    };
    return api.listDocuments(params);
  }, [cursor, applied, q, sort, refreshKey]);

  function applyFilters() {
    const { tag_ids, new_tag_names } = splitTags(selectedTags);
    if (new_tag_names.length) {
      toast({ title: "筛选只能使用已有标签", description: "未知标签返回空列表，不会自动创建", tone: "warning" });
      return;
    }
    setApplied({ doc_type: docType, source, created_from: createdFrom, created_to: createdTo, tag_ids, tag: "", tag_mode: tagMode });
    setCursorStack([null]);
    setPageIndex(0);
  }

  function resetFilters() {
    setQInput("");
    setQ("");
    setSort("newest");
    setDocType("");
    setSource("");
    setCreatedFrom("");
    setCreatedTo("");
    setSelectedTags([]);
    setTagMode("all");
    setApplied({ doc_type: "", source: "", created_from: "", created_to: "", tag_ids: [], tag: tagFromUrl, tag_mode: "all" });
    setCursorStack([null]);
    setPageIndex(0);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < BATCH_LIMIT) next.add(id);
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
        description: `单次最多 ${BATCH_LIMIT} 个文档，已截断选择`,
        tone: "warning",
      });
    }
  }

  /** 批量打标签：调服务端 bulk-tag 一次处理 */
  async function bulkAddTags() {
    const targetIds = [...selectedIds].slice(0, BATCH_LIMIT);
    if (targetIds.length === 0) return;
    const payload = splitTags(batchTags);
    if (payload.tag_ids.length === 0 && payload.new_tag_names.length === 0) {
      toast({ title: "请先选择或输入标签", tone: "warning" });
      return;
    }
    setBatchBusy(true);
    try {
      const result = await api.bulkTagDocuments({ target_ids: targetIds, ...payload });
      const failed = result.items.filter((item) => item.status !== "ok");
      toast({
        title: `批量打标：成功 ${result.items.length - failed.length} / 失败 ${failed.length}`,
        description: failed.length
          ? failed
              .slice(0, 3)
              .map((item) => `${item.id.slice(0, 8)}：${item.message || item.status}`)
              .join("；")
          : "全部处理完成",
        tone: failed.length ? "warning" : "success",
      });
      setBatchTagOpen(false);
      setBatchTags([]);
      setSelectedIds(new Set());
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast({
        title: "批量打标失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBatchBusy(false);
    }
  }

  /** 批量删除：进回收站，按保留策略自动清除 */
  async function bulkDelete() {
    const targetIds = [...selectedIds].slice(0, BATCH_LIMIT);
    if (targetIds.length === 0) return;
    setBatchBusy(true);
    try {
      const result = await api.bulkDeleteDocuments({ target_ids: targetIds });
      const failed = result.items.filter((item) => item.status === "error");
      toast({
        title: `批量删除：受理 ${result.items.length - failed.length} / 失败 ${failed.length}`,
        description: failed.length
          ? failed
              .slice(0, 3)
              .map((item) => `${item.id.slice(0, 8)}：${item.message || item.status}`)
              .join("；")
          : "已进入回收站，按保留策略自动清除",
        tone: failed.length ? "warning" : "success",
      });
      setConfirmBatchDelete(false);
      setSelectedIds(new Set());
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast({
        title: "批量删除失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBatchBusy(false);
    }
  }

  const items = list.data?.items || [];
  const nextCursor = list.data?.next_cursor || null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            文档
            <InfoHint content="仅列出已发布（存在当前版本）的逻辑文档；关键词匹配标题、来源和外部 ID。" label="查看文档列表说明" />
          </h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={list.loading}>
            {list.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
          {canWrite ? (
            <Button asChild>
              <Link to="/ingest">
                <Plus className="size-4" />
                文档入库
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="size-4" />
            搜索与筛选
            <InfoHint content="关键词输入 300ms 后自动查询；排序立即生效。文档类型、来源与标签组合过滤支持 all / any。" label="查看文档筛选说明" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="关键词-q">关键词</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="关键词-q"
                  value={qInput}
                  placeholder="标题 / 来源 / 外部 ID…"
                  className="pl-8"
                  onChange={(event) => setQInput(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="排序-sort">排序</Label>
              <Select value={sort} onValueChange={(value: DocumentSort) => onSortChange(value)}>
                <SelectTrigger id="排序-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">创建时间从新到旧</SelectItem>
                  <SelectItem value="oldest">创建时间从旧到新</SelectItem>
                  <SelectItem value="title_asc">标题 A→Z</SelectItem>
                  <SelectItem value="title_desc">标题 Z→A</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="文档类型">文档类型</Label>
              <Select value={docType || "all"} onValueChange={(value) => setDocType(value === "all" ? "" : value)}>
                <SelectTrigger id="文档类型">
                  <SelectValue placeholder="全部类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  {(types.data?.items || []).map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.display_name}（{item.code}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="来源-source">来源 source</Label>
              <Input id="来源-source"
                value={source}
                placeholder="crawler"
                onChange={(event) => setSource(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="创建起">创建日期起</Label>
              <Input id="创建起" type="date" value={createdFrom}
                onChange={(event) => setCreatedFrom(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="创建止">创建日期止</Label>
              <Input id="创建止" type="date" value={createdTo}
                onChange={(event) => setCreatedTo(event.target.value)}
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
            <div className="flex items-end">
              <div className="flex w-full gap-2">
                <Button className="flex-1" onClick={applyFilters}>
                  <Search className="size-4" />
                  查询
                </Button>
                <Button variant="outline" onClick={resetFilters}>
                  重置
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
          <div className="space-y-1.5">
            <Label htmlFor="标签">标签</Label>
            <TagPicker inputId="标签" value={selectedTags} onChange={setSelectedTags} placeholder="搜索文档标签…" />
          </div>
        </CardContent>
      </Card>

      {list.error ? <ErrorAlert error={list.error} title="文档列表加载失败" /> : null}

      {/* 批量操作栏 */}
      {canWrite && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 px-4 py-2">
          <span className="text-sm font-medium">已选 {selectedIds.size} 个文档</span>
          <Badge variant="outline">上限 {BATCH_LIMIT}</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={batchBusy} onClick={() => setBatchTagOpen(true)}>
              {batchBusy ? <Loader2 className="size-4 animate-spin" /> : <TagIcon className="size-4" />}
              批量打标签
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

      {list.loading && !list.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="没有匹配的文档"
          description="可通过「文档入库」创建采集会话并发布第一个版本。"
          action={
            canWrite ? (
              <Button asChild>
                <Link to="/ingest">
                  <Plus className="size-4" />
                  文档入库
                </Link>
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
                        checked={items.length > 0 && items.every((item) => selectedIds.has(item.id))}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                  ) : null}
                  <TableHead>标题</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>标签</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    {canWrite ? (
                      <TableCell>
                        <Checkbox
                          aria-label={`选择 ${item.title}`}
                          checked={selectedIds.has(item.id)}
                          onCheckedChange={() => toggleSelect(item.id)}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <Link to={`/documents/${item.id}`} className="font-medium text-primary hover:underline">
                        {truncate(item.title, 40)}
                      </Link>
                      <div className="cell-muted">external_id: {truncate(item.external_id, 28)}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="brand">{item.doc_type}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{item.source}</TableCell>
                    <TableCell className="cell-muted">{formatDateTime(item.created_at)}</TableCell>
                    <TableCell>
                      <TagList tags={item.tags} />
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

      <ConfirmDialog
        open={confirmBatchDelete}
        onOpenChange={(open) => !open && setConfirmBatchDelete(false)}
        title="确认批量删除文档"
        description={`将删除已选 ${Math.min(selectedIds.size, BATCH_LIMIT)} 个文档。删除进入回收站，按保留策略自动永久删除；窗口内可恢复。`}
        confirmLabel="批量删除"
        destructive
        busy={batchBusy}
        onConfirm={() => void bulkDelete()}
      />

      <Dialog open={batchTagOpen} onOpenChange={(open) => !batchBusy && setBatchTagOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量打标签</DialogTitle>
            <DialogDescription>
              为已选 {Math.min(selectedIds.size, BATCH_LIMIT)} 个文档绑定标签；新名称会自动创建。
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
            <Button onClick={() => void bulkAddTags()} disabled={batchBusy || batchTags.length === 0}>
              {batchBusy ? <Loader2 className="size-4 animate-spin" /> : <TagIcon className="size-4" />}
              绑定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
