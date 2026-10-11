/**
 * xlsx → 表格视图模型。整个模块由对话框动态 import()，不进主包。
 *
 * 中文注释：行/列上限是**展示层**的 —— read-excel-file 会先把全部行
 * 物化再返回，上限约束的是 DOM 成本与渲染耗时，不是解析内存。
 * 解析内存上界由字节上限 + zip 预检兜住。
 */

import readXlsxFile from "read-excel-file/browser";
import {
  XLSX_MAX_COLS,
  XLSX_MAX_ROWS,
  XLSX_MAX_SHEETS,
  XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES,
} from "./limits";
import { formatDateTime } from "@/lib/format";
import { assertZipBudget } from "./zip-budget";

export interface SheetView {
  /** 工作表名 */
  name: string;
  /** 已格式化、已切片的单元格文本；第一行在 UI 里作表头 */
  rows: string[][];
  /** 解析出的原始行数 */
  totalRows: number;
  /** 解析出的原始最大列数 */
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

export interface SpreadsheetParseResult {
  sheets: SheetView[];
  /** 解析到的工作表总数 */
  totalSheets: number;
  /** 超过 XLSX_MAX_SHEETS 未解析的表数 */
  skippedSheets: number;
}

/**
 * 单元格值 → 展示文本。
 *
 * 中文注释：入参按 unknown 处理 —— read-excel-file 的 CellValue 类型把
 * 日期标成 `typeof Date`（构造函数类型），与运行时返回 Date 实例不符。
 * 展示函数按运行时形态防御比信一份不准的类型更可靠。
 */
export function formatSheetCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value instanceof Date) return formatDateTime(value.toISOString());
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  // 兜底：对象/符号等一律转字符串，且不抛错
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * 解析 xlsx 字节为切片后的表格视图。
 */
export async function parseXlsx(bytes: Uint8Array): Promise<SpreadsheetParseResult> {
  // 中文注释：解压体积预检必须在解析之前 —— 解析会自己解压
  assertZipBudget(bytes, XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES, "xlsx");

  // read-excel-file 的 Input 接受 ArrayBuffer，但不能是底层更大缓冲的视图
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const buffer = copy.buffer;

  // 默认导出一次读全部工作表：[{ sheet: name, data: rows }]
  const raw = await readXlsxFile(buffer);

  const totalSheets = raw.length;
  const skippedSheets = Math.max(0, totalSheets - XLSX_MAX_SHEETS);
  const kept = raw.slice(0, XLSX_MAX_SHEETS);

  const sheets: SheetView[] = kept.map((entry) => {
    const data = entry.data;
    const totalRows = data.length;
    const totalCols = data.reduce((max, row) => Math.max(max, row.length), 0);
    const rows = data.slice(0, XLSX_MAX_ROWS).map((row) => {
      const cells = row.slice(0, XLSX_MAX_COLS).map((cell) => formatSheetCell(cell));
      // 中文注释：补齐短行，避免表格渲染时列数错位
      while (cells.length < Math.min(totalCols, XLSX_MAX_COLS)) cells.push("");
      return cells;
    });
    return {
      name: entry.sheet || "工作表",
      rows,
      totalRows,
      totalCols,
      truncatedRows: totalRows > XLSX_MAX_ROWS,
      truncatedCols: totalCols > XLSX_MAX_COLS,
    };
  });

  return { sheets, totalSheets, skippedSheets };
}
