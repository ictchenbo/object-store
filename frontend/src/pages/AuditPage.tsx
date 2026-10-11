import * as React from "react";
import { ClipboardList, Loader2, RefreshCw, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { AuditEventItem, TypeChangeItem } from "@/lib/types";
import { formatDateTime, prettyJson, truncate } from "@/lib/format";
import { useAsync } from "@/hooks/use-async";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Pagination } from "@/components/common/Pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

type AuditTab = "type-changes" | "events";

const TAB_ITEMS: { id: AuditTab; label: string; description: string }[] = [
  { id: "type-changes", label: "类型变更", description: "文档类型再分类记录（document_type_changes）" },
  { id: "events", label: "事件流水", description: "状态转移事件（outbox_events，append-only）" },
];

/** 审计流水页：类型变更 + 事件流水双视图，只读 */
export function AuditPage() {
  const [tab, setTab] = React.useState<AuditTab>("type-changes");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          审计流水
          <InfoHint content="只读视图：类型变更记录与状态转移事件均由写操作同事务落库，不做修改。" label="查看审计流水说明" />
        </h2>
      </div>

      {/* 简易 Tab：避免为两视图引入额外组件库 */}
      <div className="flex items-center gap-2 border-b">
        <div role="tablist" aria-label="审计视图" className="flex flex-wrap gap-1">
          {TAB_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`audit-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`audit-panel-${item.id}`}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === item.id
                  ? "border-brand text-brand"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <InfoHint content={TAB_ITEMS.find((item) => item.id === tab)?.description} label="查看当前审计类型说明" />
      </div>

      <div
        role="tabpanel"
        id={`audit-panel-${tab}`}
        aria-labelledby={`audit-tab-${tab}`}
        className="space-y-4"
      >
        {tab === "type-changes" ? <TypeChangesPanel /> : <EventsPanel />}
      </div>
    </div>
  );
}

/** 类型变更面板：支持按 document_id 过滤 */
function TypeChangesPanel() {
  const [documentId, setDocumentId] = React.useState("");
  const [applied, setApplied] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = React.useState(0);

  const cursor = cursorStack[pageIndex];
  const list = useAsync(
    () => api.listTypeChanges({ document_id: applied || undefined, cursor, limit: PAGE_SIZE }),
    [applied, cursor, refreshKey],
  );
  const items: TypeChangeItem[] = list.data?.items || [];
  const nextCursor = list.data?.next_cursor || null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4" />
            筛选
            <InfoHint content="可按文档 ID 精确过滤；留空列出全部类型变更。" label="查看类型变更筛选说明" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[240px] flex-1 space-y-1.5">
              <Label htmlFor="变更文档ID">文档 ID</Label>
              <Input
                id="变更文档ID"
                value={documentId}
                placeholder="留空查看全部"
                onChange={(event) => setDocumentId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setApplied(documentId.trim());
                    setCursorStack([null]);
                    setPageIndex(0);
                  }
                }}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => {
                  setApplied(documentId.trim());
                  setCursorStack([null]);
                  setPageIndex(0);
                }}
              >
                <Search className="size-4" />
                查询
              </Button>
              <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={list.loading}>
                {list.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {list.error ? <ErrorAlert error={list.error} title="类型变更加载失败" /> : null}

      {list.loading && !list.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="暂无类型变更记录"
          description="对文档执行再分类后，变更记录会出现在这里。"
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>文档</TableHead>
                  <TableHead>原类型</TableHead>
                  <TableHead>新类型</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="cell-muted">{formatDateTime(row.changed_at)}</TableCell>
                    <TableCell>
                      <Link
                        to={`/documents/${row.document_id}`}
                        className="font-mono text-xs text-primary hover:underline"
                        title={row.document_id}
                      >
                        {row.document_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{row.old_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="brand">{row.new_type}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{row.actor_id || "—"}</TableCell>
                    <TableCell className="cell-muted max-w-[240px]" title={row.reason}>
                      {truncate(row.reason, 40)}
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
    </div>
  );
}

/** 事件流水面板：支持按 event_kind / target_id 过滤 */
function EventsPanel() {
  const [eventKind, setEventKind] = React.useState("");
  const [targetId, setTargetId] = React.useState("");
  const [applied, setApplied] = React.useState({ event_kind: "", target_id: "" });
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = React.useState(0);

  const cursor = cursorStack[pageIndex];
  const list = useAsync(
    () =>
      api.listAuditEvents({
        event_kind: applied.event_kind || undefined,
        target_id: applied.target_id || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    [applied, cursor, refreshKey],
  );
  const items: AuditEventItem[] = list.data?.items || [];
  const nextCursor = list.data?.next_cursor || null;

  function apply() {
    setApplied({ event_kind: eventKind.trim(), target_id: targetId.trim() });
    setCursorStack([null]);
    setPageIndex(0);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4" />
            筛选
            <InfoHint content="事件类型如 document.created、object.deleted、job.retried；目标 ID 精确匹配。" label="查看事件筛选说明" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="事件类型">事件类型</Label>
              <Input
                id="事件类型"
                value={eventKind}
                placeholder="document.reclassified"
                onChange={(event) => setEventKind(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") apply();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="事件目标ID">目标 ID</Label>
              <Input
                id="事件目标ID"
                value={targetId}
                placeholder="document / object / job id"
                onChange={(event) => setTargetId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") apply();
                }}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={apply}>
                <Search className="size-4" />
                查询
              </Button>
              <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={list.loading}>
                {list.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {list.error ? <ErrorAlert error={list.error} title="事件流水加载失败" /> : null}

      {list.loading && !list.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="暂无事件"
          description="写操作（入库、删除、再分类等）会在此追加事件记录。"
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>目标</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>载荷</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="cell-muted">{formatDateTime(row.created_at)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.event_kind}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <div className="text-muted-foreground">{row.target_type}</div>
                        <div className="font-mono" title={row.target_id}>
                          {truncate(row.target_id, 12)}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{row.actor_id || "—"}</TableCell>
                    <TableCell className="cell-muted max-w-[280px]" title={prettyJson(row.payload)}>
                      {row.payload ? truncate(prettyJson(row.payload), 48) : "—"}
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
    </div>
  );
}
