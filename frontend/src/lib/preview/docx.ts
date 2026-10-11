/**
 * DOCX → 消毒 HTML。整个模块由对话框动态 import()，不进主包。
 *
 * 中文注释：mammoth 只产出窄标签集并转义文本，但它是跑在攻击者 OOXML
 * 上的解析器；消毒在 sanitize.ts，这里只负责转换、体积控制与降级。
 */

import mammoth from "mammoth";
import {
  DOCX_MAX_HTML_CHARS,
  DOCX_MAX_IMAGE_BYTES,
  DOCX_MAX_TOTAL_UNCOMPRESSED_BYTES,
} from "./limits";
import { assertZipBudget } from "./zip-budget";
import { sanitizeDocxHtml } from "./sanitize";

/** 1×1 透明 PNG，用于替换超限内嵌图 */
const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export interface DocxConvertResult {
  /** 未消毒的 HTML；仅供长度统计与排查，**不可直接挂载** */
  html: string;
  /**
   * 生成一个**新的**已消毒 DocumentFragment。
   * 中文注释：必须是工厂而不是字段 —— replaceChildren 会把 Fragment 的
   * 子节点移走，同一个实例第二次挂载就是空的。消毒也因此留在本动态模块里，
   * DOMPurify 不进主包。
   */
  createFragment: () => DocumentFragment;
  /** mammoth 转换警告（不阻断） */
  warnings: string[];
  /** 是否因超长做了截断 */
  truncated: boolean;
  /** 因超过单图上限而替换为占位图的数量 */
  droppedImages: number;
  /** 是否走了「丢图重转」降级 */
  usedImagelessFallback: boolean;
}

/** ArrayBuffer → base64；分块避免大数组展开撑爆调用栈 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 按标签边界截断 HTML，避免切出半个标签；DOMPurify 之后会补全未闭合标签 */
function truncateAtTagBoundary(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  const cut = html.lastIndexOf(">", maxChars);
  return cut <= 0 ? html.slice(0, maxChars) : html.slice(0, cut + 1);
}

/**
 * 转换 docx 字节为 HTML。
 *
 * 流程：zip 预算预检 → 带图转换 → 超长则丢图重转一次 → 仍超长则按标签边界截断。
 */
export async function convertDocxToHtml(bytes: Uint8Array): Promise<DocxConvertResult> {
  // 中文注释：解压体积预检必须在 mammoth 之前 —— 它会自己解压
  assertZipBudget(bytes, DOCX_MAX_TOTAL_UNCOMPRESSED_BYTES, "docx");

  // mammoth 的 BrowserInput 要求独立的 ArrayBuffer，不能是视图
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const arrayBuffer = copy.buffer;

  let droppedImages = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    try {
      const buf = new Uint8Array(await image.readAsArrayBuffer());
      if (buf.byteLength > DOCX_MAX_IMAGE_BYTES) {
        droppedImages += 1;
        return { src: PLACEHOLDER_IMAGE };
      }
      return { src: `data:${image.contentType};base64,${toBase64(buf)}` };
    } catch {
      // 中文注释：单图读失败不应让整篇文档预览失败
      droppedImages += 1;
      return { src: PLACEHOLDER_IMAGE };
    }
  });

  const first = await mammoth.convertToHtml({ arrayBuffer }, { convertImage });
  const warnings = first.messages.map((m) => m.message);

  let html = first.value;
  let usedImagelessFallback = false;

  if (html.length > DOCX_MAX_HTML_CHARS) {
    // 降级 1：丢掉全部内嵌图重转（base64 是 HTML 体积的大头）
    usedImagelessFallback = true;
    droppedImages = 0;
    const dropAll = mammoth.images.imgElement(async () => ({ src: PLACEHOLDER_IMAGE }));
    const second = await mammoth.convertToHtml({ arrayBuffer }, { convertImage: dropAll });
    for (const m of second.messages) warnings.push(m.message);
    html = second.value;
  }

  let truncated = false;
  if (html.length > DOCX_MAX_HTML_CHARS) {
    // 降级 2：按标签边界截断
    truncated = true;
    html = truncateAtTagBoundary(html, DOCX_MAX_HTML_CHARS);
  }

  return {
    html,
    createFragment: () => sanitizeDocxHtml(html),
    warnings,
    truncated,
    droppedImages,
    usedImagelessFallback,
  };
}
