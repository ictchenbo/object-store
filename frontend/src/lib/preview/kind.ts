/**
 * MIME → 预览形态的映射。纯函数，无 IO、无 DOM。
 *
 * 中文注释：匹配走白名单 Set，**禁止** `startsWith("text/")` ——
 * HTML 只能进入隔离预览框，不能走普通文本或直接链接。
 * 同样禁止「扩展名覆盖具体 MIME」。
 */

export type PreviewKind = "image" | "pdf" | "html" | "text" | "sheet" | "docx" | "download";

/**
 * 归一化媒体类型：trim → 小写 → 按首个 `;` 截断 → 再 trim。
 *
 * 中文注释：必须做 —— 精确比对 `application/pdf` 会把
 * `application/pdf; charset=binary` 漏到下载分支，而 `image/png; x=1`
 * 又因 `startsWith("image/")` 命中，前后不一致。
 */
export function normalizeMime(contentType: string | null | undefined): string {
  const raw = (contentType ?? "").trim().toLowerCase();
  if (!raw) return "";
  const cut = raw.indexOf(";");
  return (cut === -1 ? raw : raw.slice(0, cut)).trim();
}

/** 归一化扩展名（含前导点、小写）；无扩展名返回 "" */
function normalizeExt(displayName: string | null | undefined): string {
  const name = (displayName ?? "").trim();
  if (!name) return "";
  // 中文注释：只看最后一段；隐藏文件如 `.gitignore` 视为无扩展名
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = slash === -1 ? name : name.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

/** MIME 缺失的两种写法：空串，或存储侧默认的「未知」 */
const UNKNOWN_MIMES = new Set(["", "application/octet-stream"]);

/**
 * 明确禁止内联预览的类型。
 *
 * 中文注释：xhtml 与脚本族仍禁止预览；text/html 仅进入隔离预览框；
 * 旧版 Office 二进制格式前端没有解析器（用户已确认 .doc/.xls 不做）；
 * tiff 浏览器普遍不渲染，给「仅下载」比给一个破预览诚实；
 * 压缩归档同理。
 *
 * **集合里一律存小写**：MIME 按 RFC 大小写不敏感，而 normalizeMime()
 * 会先小写化输入，集合若写规范拼写（如 macroEnabled）就永不命中。
 */
const DOWNLOAD_ONLY_MIMES = new Set([
  "application/xhtml+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/vbscript",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/tiff",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
]);

/**
 * 可按纯文本展示的 MIME 白名单。
 * 中文注释：csv/json 也走文本 —— 栈里没有 RFC4180 解析器，朴素
 * split(",") 会破坏引号字段与内嵌换行；错表格比诚实的原文更糟。
 * 同理 JSON 显示原文不重排（大 JSON 重排既费时又改内容）。
 */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/x-markdown",
  "text/xml",
  "application/xml",
  "application/json",
  "application/jsonl",
  "application/x-ndjson",
  "application/csv",
  "text/tab-separated-values",
]);

/** 可解析为表格的 xlsx MIME（含启用宏的 .xlsm 容器）；一律小写，见上 */
const SHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);

/** 可转换为 HTML 的 docx MIME */
const DOCX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/** 扩展名兜底表；**仅**在 MIME 缺失时使用 */
const EXT_FALLBACK = new Map<string, PreviewKind>([
  [".txt", "text"],
  [".log", "text"],
  [".md", "text"],
  [".csv", "text"],
  [".tsv", "text"],
  [".json", "text"],
  [".jsonl", "text"],
  [".xml", "text"],
  [".html", "html"],
  [".htm", "html"],
  [".xlsx", "sheet"],
  [".docx", "docx"],
]);

/**
 * 按媒体类型（必要时扩展名兜底）决定预览形态。
 *
 * 优先级：
 *   1. MIME 缺失（"" / octet-stream）→ 仅此处才允许扩展名兜底
 *   2. 明确禁内联 → download
 *   3. HTML / 文本 / xlsx / docx 白名单 → html / text / sheet / docx
 *   4. application/pdf → pdf
 *   5. image/*（除 tiff，tiff 已在步骤 2）→ image；SVG 也走 <img>，浏览器不执行其中脚本
 *   6. 其余具体 MIME → download（不猜扩展名，否则 text/html 改名可绕过）
 */
export function previewKind(
  contentType: string | null | undefined,
  displayName?: string | null,
): PreviewKind {
  const mime = normalizeMime(contentType);

  // 步骤 1：未知类型才看扩展名。具体 MIME 一律不看名字。
  if (UNKNOWN_MIMES.has(mime)) {
    return EXT_FALLBACK.get(normalizeExt(displayName)) ?? "download";
  }

  // 步骤 2：禁内联黑名单优先于一切白名单
  if (DOWNLOAD_ONLY_MIMES.has(mime)) return "download";

  // 步骤 3–5
  if (mime === "text/html") return "html";
  if (TEXT_MIMES.has(mime)) return "text";
  if (SHEET_MIMES.has(mime)) return "sheet";
  if (DOCX_MIMES.has(mime)) return "docx";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";

  // 步骤 6
  return "download";
}

/**
 * 是否允许「在新窗口打开签名链接」。
 *
 * 中文注释：顶层导航到 SVG 文档**会执行其中的 <script>**，
 * 而 <img> 不会 —— 所以 SVG 必须与 download 一样不给这个按钮。
 * 光栅图与 PDF 顶层打开是浏览器内置渲染器，安全。
 */
export function canOpenInNewWindow(kind: PreviewKind, contentType: string | null | undefined): boolean {
  if (kind === "pdf") return true;
  if (kind === "image") return normalizeMime(contentType) !== "image/svg+xml";
  return false;
}

/** 旧版 Office 二进制格式（.doc/.xls/.ppt）—— 用户已确认不做解析 */
const LEGACY_OFFICE_MIMES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

const LEGACY_OFFICE_EXTS = new Set([".doc", ".xls", ".ppt", ".dot", ".xlt", ".pps"]);

/**
 * 若是旧版 Office 格式，返回「请另存为 …」的提示；否则 null。
 *
 * 中文注释：普通「不支持预览」对这类文件不够 —— 用户需要知道改成存什么。
 */
export function legacyOfficeHint(
  contentType: string | null | undefined,
  displayName?: string | null,
): string | null {
  const mime = normalizeMime(contentType);
  if (mime && LEGACY_OFFICE_MIMES.has(mime)) return "旧版格式不支持预览，请另存为 .docx / .xlsx";
  if (UNKNOWN_MIMES.has(mime) && LEGACY_OFFICE_EXTS.has(normalizeExt(displayName))) {
    return "旧版格式不支持预览，请另存为 .docx / .xlsx";
  }
  return null;
}
