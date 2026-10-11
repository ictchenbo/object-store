import * as React from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { TrashDocumentItem, TrashObjectItem } from "@/lib/types";
import { daysUntil, formatDateTime, truncate } from "@/lib/format";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Pagination } from "@/components/common/Pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";

const PAGE_SIZE = 20;

type TrashKind = "documents" | "objects";

/** 剩余恢复天数徽标：按 purge_after 计算；0 表示即将/已到期 */
function RemainingBadge({ purgeAfter }: { purgeAfter: string | null }) {
  const days = daysUntil(purgeAfter);
  if (days === null) return <Badge variant="secondary">立即清除</Badge>;
  if (days <= 0) return <Badge variant="danger">已到期</Badge>;
  return <Badge variant={days <= 2 ? "warning" : "outline"}>剩 {days} 天</Badge>;
}

/** 是否仍可恢复：有 purge_after 且未到期；null/已到期均不可恢复（与后端 restore 409 对齐） */
function restorable(purgeAfter: string | null | undefined): boolean {
  if (!purgeAfter) return false;
  const days = daysUntil(purgeAfter);
  return days !== null && days > 0;
}

/**
 * 回收站：软删文档与独立对象（含删除时间与清理截止），支持恢复与立即永久删除。
 * 恢复窗口由保留策略 deleted_document_purge_days / deleted_object_purge_days 决定，到期 Worker 自动永久清除。
 */
export function TrashPage() {
  const { canWrite } = useAuth();
  const [kind, setKind] = React.useState<TrashKind>("documents");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [docCursorStack, setDocCursorStack] = React.useState<(string | null)[]>([null]);
  const [objCursorStack, setObjCursorStack] = React.useState<(string | null)[]>([null]);
  const [docPageIndex, setDocPageIndex] = React.useState(0);
  const [objPageIndex, setObjPageIndex] = React.useState(0);
  const [restoreDoc, setRestoreDoc] = React.useState<TrashDocumentItem | null>(null);
  const [purgeDoc, setPurgeDoc] = React.useState<TrashDocumentItem | null>(null);
  const [restoreObj, setRestoreObj] = React.useState<TrashObjectItem | null>(null);
  const [purgeObj, setPurgeObj] = React.useState<TrashObjectItem | null>(null);
  const [busy, setBusy] = React.useState(false);

  const docCursor = docCursorStack[docPageIndex];
  const objCursor = objCursorStack[objPageIndex];
  const docList = useAsync(
    () => api.listTrashDocuments({ cursor: docCursor, limit: PAGE_SIZE }),
    [docCursor, refreshKey],
  );
  const objList = useAsync(
    () => api.listTrashObjects({ cursor: objCursor, limit: PAGE_SIZE }),
    [objCursor, refreshKey],
  );

  const activeList = kind === "documents" ? docList : objList;
  const items = activeList.data?.items || [];
  const nextCursor = activeList.data?.next_cursor || null;
  const pageIndex = kind === "documents" ? docPageIndex : objPageIndex;

  function refresh() {
    setRefreshKey((value) => value + 1);
  }

  async function restoreDocument(item: TrashDocumentItem) {
    setBusy(true);
    try {
      await api.restoreDocument(item.id);
      toast({ title: "文档已恢复", description: `「${truncate(item.title, 30)}」回到文档列表`, tone: "success" });
      setRestoreDoc(null);
      refresh();
    } catch (error) {
      toast({
        title: "恢复失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function purgeDocument(item: TrashDocumentItem) {
    setBusy(true);
    try {
      await api.purgeTrashDocument(item.id);
      toast({ title: "永久删除已受理", description: "Worker 将立即清除该文档及其关联对象", tone: "success" });
      setPurgeDoc(null);
      refresh();
    } catch (error) {
      toast({
        title: "永久删除失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function restoreObject(item: TrashObjectItem) {
    setBusy(true);
    try {
      await api.restoreObject(item.id);
      toast({ title: "对象已恢复", description: `「${truncate(item.display_name, 30)}」回到对象列表`, tone: "success" });
      setRestoreObj(null);
      refresh();
    } catch (error) {
      toast({
        title: "恢复失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function purgeObject(item: TrashObjectItem) {
    setBusy(true);
    try {
      await api.purgeTrashObject(item.id);
      toast({ title: "永久删除已受理", description: "Worker 将立即清除该对象字节", tone: "success" });
      setPurgeObj(null);
      refresh();
    } catch (error) {
      toast({
        title: "永久删除失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">回收站</h2>
          <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
            删除的文档与独立对象可在恢复期内还原；到期后自动永久清除。「立即永久删除」不可恢复。
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={activeList.loading}>
          {activeList.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          刷新
        </Button>
      </div>

      {/* 中文注释：文档/对象切换——两者恢复窗口与清除链路不同，分开展示 */}
      <div className="flex gap-2">
        {(
          [
            { key: "documents" as const, label: `文档（${docList.data?.items.length ?? "—"}）` },
            { key: "objects" as const, label: `独立对象（${objList.data?.items.length ?? "—"}）` },
          ]
        ).map((tab) => (
          <Button
            key={tab.key}
            variant={kind === tab.key ? "default" : "outline"}
            size="sm"
            onClick={() => setKind(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {activeList.error ? <ErrorAlert error={activeList.error} title="回收站加载失败" /> : null}

      {activeList.loading && !activeList.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="回收站为空"
          description={
            kind === "documents"
              ? "删除文档后会先进入这里，在清理截止前可恢复。"
              : "删除独立对象后会先进入这里，在清理截止前可恢复。"
          }
        />
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {kind === "documents" ? "已删除文档" : "已删除对象"}
              <InfoHint content="删除时间与清理截止来自服务端；剩余天数按本地时钟估算。" label="查看回收时间说明" />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {kind === "documents" ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标题</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>删除时间</TableHead>
                    <TableHead>清理截止</TableHead>
                    <TableHead>剩余</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(items as TrashDocumentItem[]).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Link to={`/documents/${item.id}`} className="font-medium text-primary hover:underline">
                          {truncate(item.title, 36)}
                        </Link>
                        <div className="cell-muted">external_id: {truncate(item.external_id, 24)}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="brand">{item.doc_type}</Badge>
                      </TableCell>
                      <TableCell className="cell-muted">{formatDateTime(item.deleted_at)}</TableCell>
                      <TableCell className="cell-muted">{formatDateTime(item.purge_after)}</TableCell>
                      <TableCell>
                        <RemainingBadge purgeAfter={item.purge_after} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canWrite || busy || !restorable(item.purge_after)}
                            title={
                              !canWrite
                                ? "只读角色不可恢复"
                                : restorable(item.purge_after)
                                  ? "恢复文档"
                                  : "已过恢复窗口或无恢复窗口，不可恢复"
                            }
                            onClick={() => setRestoreDoc(item)}
                          >
                            <RotateCcw className="size-4" />
                            恢复
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!canWrite || busy}
                            title={canWrite ? "立即永久删除" : "只读角色不可删除"}
                            onClick={() => setPurgeDoc(item)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                            立即永久删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>大小</TableHead>
                    <TableHead>删除时间</TableHead>
                    <TableHead>清理截止</TableHead>
                    <TableHead>剩余</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(items as TrashObjectItem[]).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Link to={`/objects/${item.id}`} className="font-medium text-primary hover:underline">
                          {truncate(item.display_name, 36)}
                        </Link>
                        <div className="cell-muted">{item.content_type}</div>
                      </TableCell>
                      <TableCell className="cell-muted tabular-nums">
                        {item.size_bytes != null ? `${item.size_bytes.toLocaleString("zh-CN")} B` : "—"}
                      </TableCell>
                      <TableCell className="cell-muted">{formatDateTime(item.deleted_at)}</TableCell>
                      <TableCell className="cell-muted">{formatDateTime(item.purge_after)}</TableCell>
                      <TableCell>
                        <RemainingBadge purgeAfter={item.purge_after ?? null} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canWrite || busy || !restorable(item.purge_after)}
                            title={
                              !canWrite
                                ? "只读角色不可恢复"
                                : restorable(item.purge_after)
                                  ? "恢复对象"
                                  : "已过恢复窗口或无恢复窗口，不可恢复"
                            }
                            onClick={() => setRestoreObj(item)}
                          >
                            <RotateCcw className="size-4" />
                            恢复
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!canWrite || busy}
                            title={canWrite ? "立即永久删除" : "只读角色不可删除"}
                            onClick={() => setPurgeObj(item)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                            立即永久删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="px-4 pb-3">
              <Pagination
                hasNext={Boolean(nextCursor)}
                hasPrev={pageIndex > 0}
                loading={activeList.loading}
                page={pageIndex + 1}
                onNext={() => {
                  if (!nextCursor) return;
                  if (kind === "documents") {
                    setDocCursorStack((stack) => {
                      const next = [...stack];
                      next[docPageIndex + 1] = nextCursor;
                      return next;
                    });
                    setDocPageIndex((value) => value + 1);
                  } else {
                    setObjCursorStack((stack) => {
                      const next = [...stack];
                      next[objPageIndex + 1] = nextCursor;
                      return next;
                    });
                    setObjPageIndex((value) => value + 1);
                  }
                }}
                onPrev={() => {
                  if (kind === "documents") {
                    setDocPageIndex((value) => Math.max(0, value - 1));
                  } else {
                    setObjPageIndex((value) => Math.max(0, value - 1));
                  }
                }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(restoreDoc)}
        onOpenChange={(open) => !open && setRestoreDoc(null)}
        title="确认恢复文档"
        description={
          restoreDoc
            ? `恢复「${truncate(restoreDoc.title, 40)}」？文档将回到文档列表，版本与附件关系一并还原。`
            : undefined
        }
        confirmLabel="恢复"
        busy={busy}
        onConfirm={() => {
          if (restoreDoc) void restoreDocument(restoreDoc);
        }}
      />

      <ConfirmDialog
        open={Boolean(purgeDoc)}
        onOpenChange={(open) => !open && setPurgeDoc(null)}
        title="确认立即永久删除"
        description={
          purgeDoc
            ? `「${truncate(purgeDoc.title, 40)}」及其关联对象将被立即永久清除，跳过恢复窗口，此操作不可恢复。`
            : undefined
        }
        confirmLabel="永久删除"
        destructive
        busy={busy}
        onConfirm={() => {
          if (purgeDoc) void purgeDocument(purgeDoc);
        }}
      />

      <ConfirmDialog
        open={Boolean(restoreObj)}
        onOpenChange={(open) => !open && setRestoreObj(null)}
        title="确认恢复对象"
        description={
          restoreObj
            ? `恢复「${truncate(restoreObj.display_name, 40)}」？对象将回到对象列表。`
            : undefined
        }
        confirmLabel="恢复"
        busy={busy}
        onConfirm={() => {
          if (restoreObj) void restoreObject(restoreObj);
        }}
      />

      <ConfirmDialog
        open={Boolean(purgeObj)}
        onOpenChange={(open) => !open && setPurgeObj(null)}
        title="确认立即永久删除"
        description={
          purgeObj
            ? `「${truncate(purgeObj.display_name, 40)}」的字节将被立即永久清除，跳过恢复窗口，此操作不可恢复。`
            : undefined
        }
        confirmLabel="永久删除"
        destructive
        busy={busy}
        onConfirm={() => {
          if (purgeObj) void purgeObject(purgeObj);
        }}
      />
    </div>
  );
}
