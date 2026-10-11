/**
 * 从签名 URL 取对象字节。带尺寸、超时、中止三道防线。
 *
 * 中文注释：错误消息**绝不**包含签名 URL —— 它是可下载的凭证，
 * 进了 toast / console / 链接就是泄露。消息只由状态码与字节数拼成。
 */

import type { SignedUrl } from "@/lib/types";

export type PreviewFetchErrorCode = "TOO_LARGE" | "TIMEOUT" | "ABORTED" | "HTTP" | "NETWORK";

/** 预览取字节失败。message 不含签名 URL。 */
export class PreviewFetchError extends Error {
  readonly code: PreviewFetchErrorCode;
  /** 仅 HTTP 错误时给出状态码 */
  readonly status?: number;

  constructor(code: PreviewFetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = "PreviewFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface FetchBytesOptions {
  /** 字节上限；超限立即中止并抛 TOO_LARGE */
  maxBytes: number;
  /** 外部中止信号（对话框关闭时触发） */
  signal?: AbortSignal;
  /** 超时毫秒；默认 20 秒 */
  timeoutMs?: number;
  /** 调用方已知的对象大小，可提前拒绝，省一次请求 */
  expectedBytes?: number | null;
}

/**
 * 手写信号联动，不依赖 `AbortSignal.any` / `AbortSignal.timeout`。
 *
 * 中文注释：tsconfig 的 lib 是 ["ES2022","DOM"]，那两个静态方法的
 * 可用性随浏览器与 TS 版本漂移；手写 20 行换掉跨版本不确定性。
 */
function linkSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("预览加载超时", "TimeoutError"));
  }, timeoutMs);
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternalAbort);
    },
  };
}

/** 判定中止原因，把超时与主动关闭区分开 */
function toAbortError(reason: unknown): PreviewFetchError {
  const isTimeout =
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: string }).name === "TimeoutError";
  if (isTimeout) {
    return new PreviewFetchError("TIMEOUT", "预览加载超时，请下载文件后查看。");
  }
  // 中文注释：对话框已关闭时调用方会静默处理 ABORTED，不打扰用户
  return new PreviewFetchError("ABORTED", "预览已取消。");
}

/**
 * 拉取签名 URL 的全部字节。
 *
 * 防线：
 *   1. 下载前拒：已知大小超上限 → 不发请求
 *   2. 响应头拒：Content-Length 超上限 → 不读 body
 *   3. 流式拒：边读边计数，超限 cancel() 防 Content-Length 缺失或撒谎
 */
export async function fetchSignedBytes(
  signed: SignedUrl,
  options: FetchBytesOptions,
): Promise<Uint8Array> {
  const { maxBytes, signal: externalSignal, timeoutMs = 20_000, expectedBytes } = options;

  // ---- 防线 1：下载前拒 ----
  if (typeof expectedBytes === "number" && expectedBytes > maxBytes) {
    throw new PreviewFetchError(
      "TOO_LARGE",
      `文件过大，不支持内联预览（上限 ${maxBytes} 字节，实际 ${expectedBytes} 字节）。`,
    );
  }

  const { signal, dispose } = linkSignals(externalSignal, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(signed.url, {
        mode: "cors",
        // 中文注释：签名在 query 里，不带 cookie —— 避免对 MinIO 的 cookie-CSRF 面
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    } catch {
      // 中文注释：abort 会走到这里；其余按网络错误处理。原始 rejection
      // 有意不透传、不绑定 —— 它可能含签名 URL。
      if (signal.aborted) throw toAbortError(signal.reason);
      throw new PreviewFetchError("NETWORK", "无法从存储服务读取文件，请稍后重试。");
    }

    if (!response.ok) {
      if (signal.aborted) throw toAbortError(signal.reason);
      throw new PreviewFetchError(
        "HTTP",
        `存储服务返回错误（HTTP ${response.status}）。`,
        response.status,
      );
    }

    // ---- 防线 2：Content-Length 已超限 ----
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PreviewFetchError(
        "TOO_LARGE",
        `文件过大，不支持内联预览（上限 ${maxBytes} 字节，实际 ${declared} 字节）。`,
      );
    }

    const body = response.body;
    if (!body) {
      // 中文注释：极端情况下（老浏览器 / 代理剥掉 body）退回 arrayBuffer 并复检
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new PreviewFetchError(
          "TOO_LARGE",
          `文件过大，不支持内联预览（上限 ${maxBytes} 字节，实际 ${buf.byteLength} 字节）。`,
        );
      }
      return buf;
    }

    // ---- 防线 3：流式计数 ----
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new PreviewFetchError(
            "TOO_LARGE",
            `文件过大，不支持内联预览（上限 ${maxBytes} 字节，实际已超过 ${total} 字节）。`,
          );
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof PreviewFetchError) throw err;
      if (signal.aborted) throw toAbortError(signal.reason);
      throw new PreviewFetchError("NETWORK", "读取文件内容失败，请稍后重试。");
    }

    // 拼接成单块连续内存
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    dispose();
  }
}
