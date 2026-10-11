import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { DecodedText } from "@/lib/preview/decode-text";
import { TEXT_MAX_CHARS } from "@/lib/preview/limits";

interface TextPreviewProps {
  decoded: DecodedText;
  onDownload?: () => void;
}

/** 编码标签 → 人话 */
const ENCODING_LABEL: Record<DecodedText["encoding"], string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8（含 BOM）",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  gb18030: "GB18030 / GBK",
  "binary-fallback": "未知编码（按 UTF-8 有损显示）",
};

/**
 * 纯文本预览。React 文本子节点自动转义 —— `<script>alert(1)</script>`
 * 在这里是字面文本，不是可执行标记。
 */
export function TextPreview({ decoded, onDownload }: TextPreviewProps) {
  return (
    <div className="space-y-2">
      {decoded.truncated ? (
        <Alert>
          <AlertTitle>已截断显示</AlertTitle>
          <AlertDescription>
            仅显示前 {TEXT_MAX_CHARS.toLocaleString("zh-CN")} 字符（全文共{" "}
            {decoded.originalChars.toLocaleString("zh-CN")} 字符），完整内容请下载文件。
            {onDownload ? (
              <button
                type="button"
                className="ml-1 underline underline-offset-2"
                onClick={onDownload}
              >
                下载
              </button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-xs text-muted-foreground">
        编码：{ENCODING_LABEL[decoded.encoding]} ·{" "}
        {decoded.originalChars.toLocaleString("zh-CN")} 字符
        {decoded.truncated ? "（已截断）" : ""}
      </p>

      <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
        {decoded.text}
      </pre>
    </div>
  );
}
