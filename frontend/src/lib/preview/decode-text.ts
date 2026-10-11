/**
 * 文本字节解码：BOM 嗅探 → 严格 UTF-8 → GB18030 → 有损 UTF-8 兜底。
 *
 * 中文注释：两个 TextDecoder 语义常被弄反，这里必须记住 ——
 *   - `ignoreBOM: false`（**默认**）= **剥除** BOM，不是保留它。
 *   - `fatal: true` 才能当「这真是 UTF-8 吗」的探针：非法序列会抛错。
 * 没有 fatal 就无法区分「UTF-8」和「UTF-8 有损替换」。
 */

export interface DecodeTextOptions {
  /** 展示字符上限；超出按行截断 */
  maxChars: number;
}

export interface DecodedText {
  /** 已截断或完整的文本 */
  text: string;
  /** 选用的编码标签，展示给用户 */
  encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "gb18030" | "binary-fallback";
  /** 是否已按行截断 */
  truncated: boolean;
  /** 截断前的完整字符数 */
  originalChars: number;
}

/** 从 BOM 判断编码标签；只负责选标签，剥除交给 TextDecoder（ignoreBOM 默认 false） */
function sniffBom(bytes: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8"; // 报告时标成 utf-8-bom
  }
  // 中文注释：FF FE 也是 UTF-32LE 的前缀，但 UTF-32 不在浏览器支持的编码表里，
  // 按 UTF-16LE 处理是正确取舍
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

/** 按最后一个换行截断，避免把一行劈成两半；没有可用换行则硬切 */
function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return cut <= 0 ? text.slice(0, maxChars) : text.slice(0, cut);
}

/**
 * 解码文本字节。块大小已由 TEXT_MAX_BYTES 限制（≤5 MiB），可整块解码。
 */
export function decodeText(input: ArrayBuffer | Uint8Array, options: DecodeTextOptions): DecodedText {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { maxChars } = options;

  const bom = sniffBom(bytes);
  let encoding: DecodedText["encoding"];
  let text: string;

  if (bom) {
    // 有 BOM：信任标签，不走 fatal（BOM 之后的非法字节用 U+FFFD 代替）
    encoding = bom === "utf-8" ? "utf-8-bom" : bom;
    text = new TextDecoder(bom, { fatal: false, ignoreBOM: false }).decode(bytes);
  } else {
    // 无 BOM：严格 UTF-8 当探针
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      encoding = "utf-8";
    } catch {
      // 非 UTF-8 —— 中文 Windows 导出的 txt/csv 多为 GB18030（GBK 是其别名，
      // Encoding Standard 必选标签）。它几乎能解任意字节序列，阶梯必然终止。
      try {
        text = new TextDecoder("gb18030", { fatal: true, ignoreBOM: false }).decode(bytes);
        encoding = "gb18030";
      } catch {
        // 兜底：有损 UTF-8（U+FFFD 替换），保证不抛错
        text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
        encoding = "binary-fallback";
      }
    }
  }

  const originalChars = text.length;
  if (originalChars > maxChars) {
    return {
      text: truncateAtLine(text, maxChars),
      encoding,
      truncated: true,
      originalChars,
    };
  }
  return { text, encoding, truncated: false, originalChars };
}
