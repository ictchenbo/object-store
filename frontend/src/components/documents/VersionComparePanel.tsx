import * as React from "react";
import { ArrowLeftRight } from "lucide-react";
import type { VersionItem } from "@/lib/types";
import { formatDateTime, truncate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface VersionComparePanelProps {
  versions: VersionItem[];
  /** 初始左侧版本号 */
  defaultLeft?: number;
  /** 初始右侧版本号 */
  defaultRight?: number;
}

/** 计算 attrs 差异键：值不同或仅一侧存在 */
function diffKeys(left: Record<string, unknown>, right: Record<string, unknown>): Set<string> {
  const keys = new Set<string>([...Object.keys(left || {}), ...Object.keys(right || {})]);
  const changed = new Set<string>();
  for (const key of keys) {
    const a = JSON.stringify((left || {})[key] ?? null);
    const b = JSON.stringify((right || {})[key] ?? null);
    if (a !== b) changed.add(key);
  }
  return changed;
}

function CellValue({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-xs text-muted-foreground">（无此键）</span>;
  if (value === null) return <span className="text-xs text-muted-foreground">null</span>;
  if (typeof value === "object") {
    return <span className="text-xs">{truncate(JSON.stringify(value), 60)}</span>;
  }
  return <span className="text-xs">{String(value)}</span>;
}

/**
 * 版本并排对比：doc_type 快照 / attrs 键值差异高亮 / raw·body 对象 / 附件列表。
 * 不做文本 diff——raw/body 是字节对象，正文差异需下载后人工或外部工具比对。
 */
export function VersionComparePanel({ versions, defaultLeft, defaultRight }: VersionComparePanelProps) {
  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => b.version_no - a.version_no),
    [versions],
  );

  const [leftNo, setLeftNo] = React.useState<number | null>(
    defaultLeft ?? (sorted.length > 1 ? sorted[1].version_no : sorted[0]?.version_no ?? null),
  );
  const [rightNo, setRightNo] = React.useState<number | null>(
    defaultRight ?? (sorted.length > 0 ? sorted[0].version_no : null),
  );

  const left = sorted.find((item) => item.version_no === leftNo) || null;
  const right = sorted.find((item) => item.version_no === rightNo) || null;

  if (sorted.length < 2) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">版本对比</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">至少需要两个已发布版本才能对比。</p>
        </CardContent>
      </Card>
    );
  }

  const changed = diffKeys(left?.attrs || {}, right?.attrs || {});
  const attrKeys = Array.from(
    new Set([...Object.keys(left?.attrs || {}), ...Object.keys(right?.attrs || {})]),
  ).sort();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowLeftRight className="size-4" />
          版本对比
        </CardTitle>
        <CardDescription>
          并排比较类型快照、属性键值与引用对象；属性差异以高亮标记。正文与原始字节请下载后比对。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="对比左侧版本">
              左侧版本
            </label>
            <Select
              value={leftNo !== null ? String(leftNo) : ""}
              onValueChange={(value) => setLeftNo(Number(value))}
            >
              <SelectTrigger id="对比左侧版本" className="w-[180px]">
                <SelectValue placeholder="选择版本" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((item) => (
                  <SelectItem key={item.id} value={String(item.version_no)}>
                    v{item.version_no} · {formatDateTime(item.published_at)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="对比右侧版本">
              右侧版本
            </label>
            <Select
              value={rightNo !== null ? String(rightNo) : ""}
              onValueChange={(value) => setRightNo(Number(value))}
            >
              <SelectTrigger id="对比右侧版本" className="w-[180px]">
                <SelectValue placeholder="选择版本" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((item) => (
                  <SelectItem key={item.id} value={String(item.version_no)}>
                    v{item.version_no} · {formatDateTime(item.published_at)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLeftNo(rightNo);
              setRightNo(leftNo);
            }}
          >
            <ArrowLeftRight className="size-4" />
            交换
          </Button>
        </div>

        {left && right ? (
          <div className="space-y-4">
            {/* 概要对比 */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">字段</TableHead>
                  <TableHead>左侧 v{left.version_no}</TableHead>
                  <TableHead>右侧 v{right.version_no}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">类型快照</TableCell>
                  <TableCell>
                    <Badge variant={left.doc_type === right.doc_type ? "secondary" : "warning"}>
                      {left.doc_type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={left.doc_type === right.doc_type ? "secondary" : "warning"}>
                      {right.doc_type}
                    </Badge>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">发布时间</TableCell>
                  <TableCell className="text-xs">{formatDateTime(left.published_at)}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(right.published_at)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">raw 对象</TableCell>
                  <TableCell className="font-mono text-xs">
                    {left.raw_object_id ? truncate(left.raw_object_id, 16) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {right.raw_object_id ? truncate(right.raw_object_id, 16) : "—"}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">body 对象</TableCell>
                  <TableCell className="font-mono text-xs">
                    {left.body_object_id ? truncate(left.body_object_id, 16) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {right.body_object_id ? truncate(right.body_object_id, 16) : "—"}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">附件数</TableCell>
                  <TableCell className="text-xs">{left.assets.length}</TableCell>
                  <TableCell className="text-xs">{right.assets.length}</TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {/* attrs 键值对比 */}
            <div>
              <h4 className="mb-2 text-sm font-medium">属性差异（{changed.size} 项变更）</h4>
              {attrKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">两版本均无自定义属性。</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">键</TableHead>
                      <TableHead>左侧 v{left.version_no}</TableHead>
                      <TableHead>右侧 v{right.version_no}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {attrKeys.map((key) => {
                      const isChanged = changed.has(key);
                      return (
                        <TableRow key={key} className={cn(isChanged && "bg-warning/10")}>
                          <TableCell className="font-mono text-xs">
                            {key}
                            {isChanged ? (
                              <Badge variant="warning" className="ml-2">
                                差异
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className={cn(isChanged && "bg-warning/15")}>
                            <CellValue value={(left.attrs || {})[key]} />
                          </TableCell>
                          <TableCell className={cn(isChanged && "bg-warning/15")}>
                            <CellValue value={(right.attrs || {})[key]} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* 附件对比 */}
            <div>
              <h4 className="mb-2 text-sm font-medium">附件清单</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                {[left, right].map((version) => (
                  <div key={version.id} className="rounded-md border p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">v{version.version_no}</div>
                    {version.assets.length === 0 ? (
                      <p className="text-xs text-muted-foreground">无附件</p>
                    ) : (
                      <ul className="space-y-1">
                        {version.assets.map((asset) => (
                          <li key={`${asset.object_id}-${asset.role}-${asset.ordinal}`} className="text-xs">
                            <Badge variant="outline" className="mr-1">
                              {asset.role}
                            </Badge>
                            {asset.reference_name || truncate(asset.object_id, 12)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">请选择左右两侧版本。</p>
        )}
      </CardContent>
    </Card>
  );
}
