import * as React from "react";
import { Loader2, ListChecks, RefreshCw, RotateCcw, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { JobItem } from "@/lib/types";
import { formatDateTime, truncate } from "@/lib/format";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Pagination } from "@/components/common/Pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

/** 任务状态 → 徽标色调 */
function jobStatusTone(status: JobItem["status"]): "success" | "warning" | "danger" | "secondary" {
  switch (status) {
    case "done":
      return "success";
    case "pending":
    case "running":
      return "warning";
    case "failed":
    case "dead":
      return "danger";
    default:
      return "secondary";
  }
}

/** 任务状态中文标签 */
function jobStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待处理";
    case "running":
      return "执行中";
    case "failed":
      return "失败";
    case "done":
      return "完成";
    case "dead":
      return "已放弃";
    default:
      return status;
  }
}

/** 任务列表：查看删除/收尾/对账等后台任务，支持失败任务复活 */
export function JobsPage() {
  const { canWrite } = useAuth();
  const [statusFilter, setStatusFilter] = React.useState("");
  const [kindFilter, setKindFilter] = React.useState("");
  const [applied, setApplied] = React.useState({ status: "", kind: "" });
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [retryingId, setRetryingId] = React.useState<string | null>(null);

  const cursor = cursorStack[pageIndex];

  const list = useAsync(
    () =>
      api.listJobs({
        status: applied.status || undefined,
        kind: applied.kind || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    [applied, cursor, refreshKey],
  );

  function applyFilters() {
    setApplied({ status: statusFilter.trim(), kind: kindFilter.trim() });
    setCursorStack([null]);
    setPageIndex(0);
  }

  async function retry(job: JobItem) {
    setRetryingId(job.id);
    try {
      await api.retryJob(job.id);
      toast({ title: "任务已复活", description: `任务 ${job.id.slice(0, 8)} 已重置为待处理`, tone: "success" });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast({
        title: "复活任务失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setRetryingId(null);
    }
  }

  const items = list.data?.items || [];
  const nextCursor = list.data?.next_cursor || null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            后台任务
            <InfoHint content="删除对象、文档清理、上传收尾与对账等异步任务；失败或已放弃的任务可重试。" label="查看后台任务说明" />
          </h2>
        </div>
        <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={list.loading}>
          {list.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4" />
            筛选
            <InfoHint content="按状态与任务类型过滤；留空表示不过滤。" label="查看筛选说明" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="任务状态">状态</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger id="任务状态">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">待处理</SelectItem>
                  <SelectItem value="running">执行中</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                  <SelectItem value="done">完成</SelectItem>
                  <SelectItem value="dead">已放弃</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="任务类型">任务类型</Label>
              <Input
                id="任务类型"
                value={kindFilter}
                placeholder="delete_object / purge_document / finalize_upload / reconcile"
                onChange={(event) => setKindFilter(event.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={applyFilters} className="w-full sm:w-auto">
                <Search className="size-4" />
                查询
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {list.error ? <ErrorAlert error={list.error} title="任务列表加载失败" /> : null}

      {list.loading && !list.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="没有匹配的任务"
          description="删除对象或文档后会生成异步清理任务；对账任务由 Worker 周期入队。"
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>任务 ID</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>目标</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">尝试</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最近错误</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-xs" title={job.id}>
                      {job.id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs">{job.kind}</TableCell>
                    <TableCell className="font-mono text-xs" title={job.target_id}>
                      {truncate(job.target_id, 12)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={jobStatusTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{job.attempts}</TableCell>
                    <TableCell className="cell-muted">{formatDateTime(job.created_at)}</TableCell>
                    <TableCell className="cell-muted max-w-[220px]" title={job.last_error || ""}>
                      {job.last_error ? truncate(job.last_error, 40) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          title="复活任务"
                          disabled={!canWrite || (job.status !== "failed" && job.status !== "dead")}
                          onClick={() => void retry(job)}
                        >
                          {retryingId === job.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <RotateCcw className="size-4" />
                          )}
                          重试
                        </Button>
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
    </div>
  );
}
