import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SpreadsheetParseResult, SheetView } from "@/lib/preview/spreadsheet";
import { XLSX_MAX_COLS, XLSX_MAX_ROWS } from "@/lib/preview/limits";

interface SpreadsheetPreviewProps {
  result: SpreadsheetParseResult;
  onDownload?: () => void;
}

/** 单个工作表的截断提示 */
function SheetNotices({ sheet }: { sheet: SheetView }) {
  if (!sheet.truncatedRows && !sheet.truncatedCols) return null;
  return (
    <Alert>
      <AlertTitle>仅显示部分数据</AlertTitle>
      <AlertDescription>
        {sheet.truncatedRows
          ? `显示前 ${XLSX_MAX_ROWS} 行（共 ${sheet.totalRows} 行）`
          : null}
        {sheet.truncatedRows && sheet.truncatedCols ? "；" : null}
        {sheet.truncatedCols
          ? `每行显示前 ${XLSX_MAX_COLS} 列（共 ${sheet.totalCols} 列）`
          : null}
        。完整内容请下载文件。
      </AlertDescription>
    </Alert>
  );
}

/**
 * xlsx 表格预览。单元格是 React 文本子节点 → 自动转义，
 * 单元格里的 `<img src=x onerror=…>` 就是字面文本。
 */
export function SpreadsheetPreview({ result, onDownload }: SpreadsheetPreviewProps) {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const active = result.sheets[activeIndex];

  if (result.sheets.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
        该工作簿没有可显示的工作表。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {result.skippedSheets > 0 ? (
        <Alert>
          <AlertTitle>工作表数量超限</AlertTitle>
          <AlertDescription>
            还有 {result.skippedSheets} 个工作表未解析（上限 {result.sheets.length} 个）。
            {onDownload ? "完整内容请下载文件。" : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {result.sheets.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {result.sheets.map((sheet, index) => (
            <Button
              key={`${sheet.name}-${index}`}
              size="sm"
              variant={index === activeIndex ? "default" : "outline"}
              onClick={() => setActiveIndex(index)}
            >
              {sheet.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">工作表：{active.name}</p>
      )}

      {active ? <SheetNotices sheet={active} /> : null}

      {active && active.rows.length > 0 ? (
        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {active.rows[0].map((cell, col) => (
                  <TableHead key={col} className="whitespace-nowrap">
                    {cell}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.rows.slice(1).map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {row.map((cell, col) => (
                    <TableCell key={col} className="whitespace-nowrap">
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-md border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
          该工作表为空。
        </div>
      )}
    </div>
  );
}
