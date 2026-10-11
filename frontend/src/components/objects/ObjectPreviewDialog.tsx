import * as React from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import type { SignedUrl } from "@/lib/types";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import {
  canOpenInNewWindow,
  legacyOfficeHint,
  previewKind,
  type PreviewKind,
} from "@/lib/preview/kind";
import {
  FETCH_TIMEOUT_MS,
  PREVIEW_TTL_SECONDS,
  TEXT_MAX_CHARS,
  maxBytesForKind,
} from "@/lib/preview/limits";
import { PreviewFetchError, fetchSignedBytes } from "@/lib/preview/fetch-bytes";
import { decodeText, type DecodedText } from "@/lib/preview/decode-text";
import { ZipBudgetError, ZipFormatError } from "@/lib/preview/zip-budget";
import type { DocxConvertResult } from "@/lib/preview/docx";
import type { SpreadsheetParseResult } from "@/lib/preview/spreadsheet";
import { PreviewPlaceholder } from "./preview/PreviewPlaceholder";
import { TextPreview } from "./preview/TextPreview";
import { HtmlPreview } from "./preview/HtmlPreview";
import { DocxPreview } from "./preview/DocxPreview";
import { SpreadsheetPreview } from "./preview/SpreadsheetPreview";

interface ObjectPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 展示名称 */
  displayName: string;
  /** 媒体类型 */
  contentType: string;
  /** 对象字节数；已知时可在下载前就拒绝超限文件，省一次请求 */
  sizeBytes?: number | null;
  /** 签发预览 URL 的解析器（standalone 或文档内部对象路径不同） */
  resolveUrl: () => Promise<SignedUrl>;
  /** 可选：下载入口（独立对象可复用同一签名；文档对象走文档端点） */
  onDownload?: () => void;
}

/**
 * 已就绪的预览内容；image/pdf 只带签名 URL，其余已解析成可渲染形态。
 * 中文注释：image 与 pdf **必须拆成两个成员** —— 合并成 `kind: "image" | "pdf"`
 * 会让判别联合无法按 kind 窄化（两个字面量共用一个成员，假分支排不掉它）。
 */
type PreviewPayload =
  | { kind: "image"; signed: SignedUrl }
  | { kind: "pdf"; signed: SignedUrl }
  | { kind: "text"; decoded: DecodedText }
  | { kind: "html"; decoded: DecodedText }
  | { kind: "sheet"; result: SpreadsheetParseResult }
  | { kind: "docx"; result: DocxConvertResult };

/**
 * 单一状态机。`blocked` 是预期阻断（超限 / 类型不支持），走中性占位面板；
 * `error` 才是异常，走 ErrorAlert。
 */
type PreviewState =
  | { phase: "loading"; label: string }
  | { phase: "ready"; payload: PreviewPayload }
  | { phase: "blocked"; title: string; description?: string; detail?: string }
  | { phase: "error"; error: unknown };

/**
 * 对象预览对话框：
 * 1) 短 TTL（PREVIEW_TTL_SECONDS）签名 URL + response-content-disposition=inline
 * 2) image → <img>；pdf → <iframe>；HTML → 沙箱；text/sheet/docx → 取字节后客户端渲染；其余仅下载
 * 3) 签名 URL 不写入 console / history / 错误消息
 *
 * 中文注释：`download` 形态**不调用 resolveUrl** —— 不给不需要签名的类型发凭证。
 */
export function ObjectPreviewDialog({
  open,
  onOpenChange,
  displayName,
  contentType,
  sizeBytes,
  resolveUrl,
  onDownload,
}: ObjectPreviewDialogProps) {
  const [state, setState] = React.useState<PreviewState>({
    phase: "loading",
    label: "正在准备预览…",
  });

  const kind: PreviewKind = previewKind(contentType, displayName);
  const allowNewWindow = canOpenInNewWindow(kind, contentType);
  const legacyHint = legacyOfficeHint(contentType, displayName);

  // 中文注释：把会影响结果的 props 合成一个 key，换目标即重新加载。
  // resolveUrl 是调用方每次渲染新建的 lambda，不能进依赖，否则会无限重取。
  const targetKey = `${displayName} ${contentType} ${sizeBytes ?? ""}`;

  React.useEffect(() => {
    if (!open) {
      setState({ phase: "loading", label: "正在准备预览…" });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const blocked = (title: string, description?: string, detail?: string) => {
      if (!cancelled) setState({ phase: "blocked", title, description, detail });
    };

    (async () => {
      // ---- 仅下载：不签发任何 URL ----
      if (kind === "download") {
        blocked(
          legacyHint ?? "该媒体类型不支持内联预览",
          legacyHint
            ? "可下载后用本地应用打开。"
            : "为安全起见，网页、脚本与未知类型不会在浏览器内渲染。",
          `类型：${contentType || "未知"} · ${formatBytes(sizeBytes)}`,
        );
        return;
      }

      setState({ phase: "loading", label: "正在签发预览链接…" });

      let signed: SignedUrl;
      try {
        signed = await resolveUrl();
      } catch (err) {
        if (!cancelled) setState({ phase: "error", error: err });
        return;
      }
      if (cancelled) return;

      // ---- image / pdf：浏览器直接渲染签名 URL ----
      if (kind === "image" || kind === "pdf") {
        setState({ phase: "ready", payload: { kind, signed } });
        return;
      }

      // ---- html / text / sheet / docx：取字节后客户端渲染 ----
      const maxBytes = maxBytesForKind(kind);
      setState({ phase: "loading", label: "正在读取文件内容…" });

      let bytes: Uint8Array;
      try {
        bytes = await fetchSignedBytes(signed, {
          maxBytes,
          timeoutMs: FETCH_TIMEOUT_MS,
          expectedBytes: sizeBytes ?? null,
          signal: controller.signal,
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof PreviewFetchError) {
          // 对话框已关闭时静默，不打扰用户
          if (err.code === "ABORTED") return;
          if (err.code === "TOO_LARGE" || err.code === "TIMEOUT") {
            blocked(
              err.code === "TOO_LARGE" ? "文件过大，不支持内联预览" : "预览加载超时",
              err.message,
              err.code === "TOO_LARGE" && typeof sizeBytes === "number"
                ? `上限 ${formatBytes(maxBytes)} · 实际 ${formatBytes(sizeBytes)}`
                : undefined,
            );
            return;
          }
        }
        setState({ phase: "error", error: err });
        return;
      }
      if (cancelled) return;

      try {
        if (kind === "text") {
          setState({
            phase: "ready",
            payload: { kind, decoded: decodeText(bytes, { maxChars: TEXT_MAX_CHARS }) },
          });
          return;
        }

        if (kind === "html") {
          setState({
            phase: "ready",
            payload: { kind, decoded: decodeText(bytes, { maxChars: TEXT_MAX_CHARS }) },
          });
          return;
        }

        setState({
          phase: "loading",
          label: kind === "sheet" ? "正在解析表格…" : "正在转换文档…",
        });

        if (kind === "sheet") {
          // 中文注释：解析器按需加载，不进主包
          const { parseXlsx } = await import("@/lib/preview/spreadsheet");
          const result = await parseXlsx(bytes);
          if (cancelled) return;
          setState({ phase: "ready", payload: { kind, result } });
          return;
        }

        const { convertDocxToHtml } = await import("@/lib/preview/docx");
        const result = await convertDocxToHtml(bytes);
        if (cancelled) return;
        setState({ phase: "ready", payload: { kind, result } });
      } catch (err) {
        if (cancelled) return;
        // zip 炸弹预检失败是预期阻断，不是崩溃
        if (err instanceof ZipBudgetError || err instanceof ZipFormatError) {
          blocked("无法预览该文件", err.message);
          return;
        }
        setState({ phase: "error", error: err });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey, kind, legacyHint]);

  /**
   * 「新窗口打开」的签名 URL；不适用时为 null。
   * 中文注释：必须在这里收窄成常量 —— 判别联合的窄化不穿透闭包，
   * 直接在 onClick 里读 state.payload.signed 会被放宽成整个联合。
   */
  const newWindowUrl =
    state.phase === "ready" &&
    (state.payload.kind === "image" || state.payload.kind === "pdf") &&
    allowNewWindow
      ? state.payload.signed.url
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            预览
            <Badge variant="outline">{contentType || "未知类型"}</Badge>
          </DialogTitle>
          <DialogDescription>
            {displayName}
            {kind === "download"
              ? " · 该类型仅支持下载。"
              : ` · 签名链接有效期 ${PREVIEW_TTL_SECONDS} 秒，仅本次预览使用。`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {state.phase === "loading" ? (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 size-5 animate-spin" />
              {state.label}
            </div>
          ) : null}

          {state.phase === "error" ? <ErrorAlert error={state.error} title="预览失败" /> : null}

          {state.phase === "blocked" ? (
            <PreviewPlaceholder
              title={state.title}
              description={state.description}
              detail={state.detail}
              onDownload={onDownload}
            />
          ) : null}

          {state.phase === "ready" ? (
            state.payload.kind === "image" ? (
              <div className="flex max-h-[60vh] items-center justify-center overflow-auto rounded-md border bg-muted/30 p-2">
                {/* 中文注释：SVG 也用 <img>，浏览器不执行其中脚本 */}
                <img
                  src={state.payload.signed.url}
                  alt={displayName}
                  className="max-h-[56vh] max-w-full object-contain"
                />
              </div>
            ) : state.payload.kind === "pdf" ? (
              <iframe
                src={state.payload.signed.url}
                title={`预览 ${displayName}`}
                className="h-[60vh] w-full rounded-md border"
              />
            ) : state.payload.kind === "text" ? (
              <TextPreview decoded={state.payload.decoded} onDownload={onDownload} />
            ) : state.payload.kind === "html" ? (
              <HtmlPreview decoded={state.payload.decoded} displayName={displayName} />
            ) : state.payload.kind === "sheet" ? (
              <SpreadsheetPreview result={state.payload.result} onDownload={onDownload} />
            ) : (
              <DocxPreview result={state.payload.result} />
            )
          ) : null}
        </div>

        <DialogFooter>
          {onDownload ? (
            <Button variant="outline" onClick={onDownload}>
              <Download className="size-4" />
              下载
            </Button>
          ) : null}
          {/* 中文注释：SVG 顶层打开会执行脚本，download 类本就不签发 —— 两者都不给这个按钮 */}
          {newWindowUrl ? (
            <Button
              variant="outline"
              onClick={() => window.open(newWindowUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="size-4" />
              新窗口打开
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
