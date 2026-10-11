import * as React from "react";
import { Link } from "react-router-dom";
import { Boxes, Database, Download, FileText, HardDrive, Layers, Loader2, Paperclip, RefreshCw, Table2 } from "lucide-react";
import { api, ApiError, downloadCsvText, downloadStatsCsv, toCsv } from "@/lib/api";
import type { StatsExportView } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { DailyFlowChart } from "@/components/charts/DailyFlowChart";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { StatCard } from "@/components/common/StatCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";

/** 总览：对象层 + 文档层双口径统计（各自携带 as_of） */
export function DashboardPage() {
  const { status } = useAuth();
  const isAuthed = status === "authed";
  const [exporting, setExporting] = React.useState<StatsExportView | "client" | null>(null);
  const overview = useAsync(async () => {
    if (!isAuthed) return null;
    const [objectStats, documentStats, buckets, daily] = await Promise.all([
      api.objectStats(),
      api.documentStats(),
      api.bucketStats(),
      api.dailyStats(30),
    ]);
    return { objectStats, documentStats, buckets, daily };
  }, [isAuthed]);

  const authError = overview.error instanceof ApiError && overview.error.status === 401;

  /** 服务端 CSV 导出（UTF-8 BOM，Excel 可直接打开） */
  async function exportServer(view: StatsExportView) {
    setExporting(view);
    try {
      const filename = await downloadStatsCsv(view, 30);
      toast({ title: "导出完成", description: filename, tone: "success" });
    } catch (error) {
      toast({
        title: "导出失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setExporting(null);
    }
  }

  /** 小表客户端导出：桶级统计（与页面所见一致） */
  function exportClientBuckets() {
    if (!overview.data) return;
    setExporting("client");
    try {
      const rows: (string | number)[][] = [
        ["bucket", "object_count", "logical_bytes"],
        ...overview.data.buckets.items.map((row) => [row.bucket, row.object_count, row.logical_bytes]),
      ];
      downloadCsvText(toCsv(rows), "stats-buckets-client.csv");
      toast({ title: "导出完成", description: "stats-buckets-client.csv", tone: "success" });
    } catch (error) {
      toast({
        title: "导出失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            总览
            <InfoHint content="对象层与文档层分口径统计；同一对象被多版本引用时，对象层只计一次物理目录记录。" label="查看总览统计口径" />
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={!isAuthed || authError || Boolean(exporting)}>
                {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                导出 CSV
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>服务端导出</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => void exportServer("overview")}>概览（overview）</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportServer("buckets")}>桶级（buckets）</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportServer("daily")}>每日流量（daily）</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>客户端小表</DropdownMenuLabel>
              <DropdownMenuItem onClick={exportClientBuckets}>
                <Table2 className="mr-2 size-4" />
                当前桶级表格
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={overview.reload} disabled={overview.loading}>
            <RefreshCw className={overview.loading ? "size-4 animate-spin" : "size-4"} />
            刷新
          </Button>
        </div>
      </div>

      {status === "anonymous" || authError ? (
        <Card>
          <CardHeader>
            <CardTitle>请先登录或配置 API Key</CardTitle>
            <CardDescription>
              控制台支持登录会话，也支持在设置页配置 API Key。
              <Link to="/login" className="ml-1 text-primary underline-offset-4 hover:underline">
                前往登录 →
              </Link>
              <Link to="/settings" className="ml-1 text-primary underline-offset-4 hover:underline">
                前往设置 →
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {overview.error && isAuthed && !authError ? <ErrorAlert error={overview.error} title="统计加载失败" /> : null}

      {overview.loading && !overview.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : null}

      {isAuthed && overview.data ? (
        <>
          {/* 对象层 KPI */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Boxes}
              label="对象总数"
              value={overview.data.objectStats.object_count.toLocaleString("zh-CN")}
              hint={`as_of ${formatDateTime(overview.data.objectStats.as_of)}`}
            />
            <StatCard
              icon={HardDrive}
              label="逻辑字节"
              value={formatBytes(overview.data.objectStats.logical_bytes)}
              hint="不含 MinIO 冗余与历史版本"
            />
            <StatCard
              icon={FileText}
              label="文档数"
              value={overview.data.documentStats.document_count.toLocaleString("zh-CN")}
              hint="已发布（有当前版本）"
            />
            <StatCard
              icon={Layers}
              label="已发布版本数"
              value={overview.data.documentStats.version_count.toLocaleString("zh-CN")}
              hint={`as_of ${formatDateTime(overview.data.documentStats.as_of)}`}
            />
          </div>

          {/* 文档层补充指标 */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="rounded-lg bg-accent/15 p-2 text-accent">
                  <Paperclip className="size-5" />
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground">附件关系数</div>
                  <div className="text-xl font-semibold tabular-nums">
                    {overview.data.documentStats.asset_count.toLocaleString("zh-CN")}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="sm:col-span-1 lg:col-span-2">
              <CardContent className="flex h-full items-center justify-between gap-4 p-4">
                <div className="text-sm text-muted-foreground">
                  文档层统计与桶级对象统计<strong className="mx-1 text-foreground">不相加</strong>
                  ：正文与附件对象在对象完成时已计入对象层，文档发布不再累加。
                </div>
                <Badge variant="secondary">双口径</Badge>
              </CardContent>
            </Card>
          </div>

          {/* 每日流量 */}
          <Card>
            <CardHeader>
              <CardTitle>每日对象流量（近 30 天）</CardTitle>
              <CardDescription>新增 = ready 时间；删除 = deleted 时间。来源于对象层 stats 口径。</CardDescription>
            </CardHeader>
            <CardContent>
              <DailyFlowChart items={overview.data.daily.items} />
            </CardContent>
          </Card>

          {/* 桶级统计 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                桶级当前存量
                <InfoHint content="按桶汇总就绪对象数与逻辑字节。" label="查看桶级统计口径" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {overview.data.buckets.items.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">暂无就绪对象</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>桶</TableHead>
                      <TableHead className="text-right">对象数</TableHead>
                      <TableHead className="text-right">逻辑字节</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.data.buckets.items.map((row) => (
                      <TableRow key={row.bucket}>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            <Database className="size-3.5 text-muted-foreground" />
                            {row.bucket}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{row.object_count.toLocaleString("zh-CN")}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBytes(row.logical_bytes)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
