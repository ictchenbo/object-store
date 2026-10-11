import * as React from "react";
import { Loader2, RefreshCw, Search, Tags } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/hooks/use-async";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "react-router-dom";

/** 标签字典：本租户可复用标签（前缀建议查询） */
export function TagsPage() {
  const [query, setQuery] = React.useState("");
  const [applied, setApplied] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);

  const list = useAsync(() => api.listTags(applied), [applied, refreshKey]);
  const items = list.data?.items || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            标签字典
            <InfoHint content="对象与文档共用租户内标签字典；创建后即可复用，解绑不删除字典项。" label="查看标签字典说明" />
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
            前缀查询
            <InfoHint content="按规范化名称前缀匹配，最多返回 50 条。筛选时未知标签返回空结果，不会自动创建。" label="查看前缀查询说明" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              value={query}
              placeholder="输入标签名称前缀…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setApplied(query.trim());
              }}
            />
            <Button onClick={() => setApplied(query.trim())}>
              <Search className="size-4" />
              查询
            </Button>
          </div>
        </CardContent>
      </Card>

      {list.error ? <ErrorAlert error={list.error} title="标签加载失败" /> : null}

      {list.loading && !list.data ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="暂无标签"
          description="在对象上传或文档入库时输入新标签名，服务端会自动创建。"
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标签名</TableHead>
                  <TableHead>标签 ID</TableHead>
                  <TableHead className="text-right">快速筛选</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((tag) => (
                  <TableRow key={tag.id}>
                    <TableCell>
                      <Badge variant="brand">{tag.name}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{tag.id}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/objects?tag=${encodeURIComponent(tag.name)}`}>对象</Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/documents?tag=${encodeURIComponent(tag.name)}`}>文档</Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
