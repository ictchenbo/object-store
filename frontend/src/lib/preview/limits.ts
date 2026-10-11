/**
 * 预览能力的全部数值上限与共享常量。
 *
 * 中文注释：集中放在一处，避免上限散落在各渲染组件里改不全。
 * 上限分两类 ——
 *   1. 硬拒：超了就不出内容，给出「下载文件」出口（不是死胡同）。
 *   2. 软截断：内容照常显示，顶部提示条说明截断，完整内容走下载。
 */

/** 预览签名 URL 有效期（秒）：短 TTL，避免长期有效的直链 */
export const PREVIEW_TTL_SECONDS = 120;

/** 单次取字节的超时（毫秒） */
export const FETCH_TIMEOUT_MS = 20_000;

const MiB = 1024 * 1024;

// ---------- 文本族（txt / csv / json / md / xml / …） ----------

/** 文本：下载前与流式读取的字节上限 */
export const TEXT_MAX_BYTES = 5 * MiB;

/** 文本：解码后展示的字符上限，超出按行截断 */
export const TEXT_MAX_CHARS = 200_000;

// ---------- xlsx 表格 ----------

/** xlsx：下载前与流式读取的字节上限 */
export const XLSX_MAX_BYTES = 15 * MiB;

/** xlsx：zip 解压后总字节上限（防 zip 炸弹，见 zip-budget.ts） */
export const XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES = 80 * MiB;

/** xlsx：展示的行数上限 */
export const XLSX_MAX_ROWS = 200;

/** xlsx：展示的列数上限 */
export const XLSX_MAX_COLS = 50;

/** xlsx：解析的工作表数量上限 */
export const XLSX_MAX_SHEETS = 10;

// ---------- docx 文档 ----------

/** docx：下载前与流式读取的字节上限 */
export const DOCX_MAX_BYTES = 10 * MiB;

/** docx：zip 解压后总字节上限（防 zip 炸弹，见 zip-budget.ts） */
export const DOCX_MAX_TOTAL_UNCOMPRESSED_BYTES = 80 * MiB;

/** docx：转换后 HTML 字符上限，超出先丢图重转，仍超则按标签边界截断 */
export const DOCX_MAX_HTML_CHARS = 300_000;

/** docx：单张内嵌图的字节上限，超出替换为 1×1 透明占位图 */
export const DOCX_MAX_IMAGE_BYTES = 512 * 1024;

// ---------- 按 kind 取字节上限 ----------

/** 预览形态；与 kind.ts 的 PreviewKind 保持一致 */
export type PreviewKindLike = "image" | "pdf" | "html" | "text" | "sheet" | "docx" | "download";

/**
 * 返回某类预览的字节上限；不需要取字节的形态返回 0。
 *
 * 中文注释：image / pdf 由浏览器直接渲染签名 URL，我们不取字节，
 * 因此返回 0 —— 调用方见到 0 就不该走 fetch 管线。
 */
export function maxBytesForKind(kind: PreviewKindLike): number {
  switch (kind) {
    case "text":
    case "html":
      return TEXT_MAX_BYTES;
    case "sheet":
      return XLSX_MAX_BYTES;
    case "docx":
      return DOCX_MAX_BYTES;
    case "image":
    case "pdf":
    case "download":
      return 0;
  }
}
