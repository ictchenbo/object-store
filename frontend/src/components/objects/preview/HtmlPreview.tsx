import type { DecodedText } from "@/lib/preview/decode-text";

interface HtmlPreviewProps {
  decoded: DecodedText;
  displayName: string;
}

// 中文注释：沙箱不授予脚本、同源、表单或顶层导航权限；CSP 禁止外部请求。
const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** HTML 只在不可信源的 iframe 内渲染，绝不插入控制台 DOM。 */
export function HtmlPreview({ decoded, displayName }: HtmlPreviewProps) {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  // 中文注释：保留原文开头的 DOCTYPE，避免预览落入浏览器怪异模式。
  const doctype = decoded.text.match(/^\s*<!doctype html[^>]*>/i)?.[0];
  const srcDoc = doctype
    ? `${doctype}${cspMeta}${decoded.text.slice(doctype.length)}`
    : `${cspMeta}${decoded.text}`;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        安全预览：脚本与外部资源已禁用。{decoded.truncated ? "内容已截断，完整内容请下载。" : ""}
      </p>
      <iframe
        title={`预览 ${displayName}`}
        srcDoc={srcDoc}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[60vh] w-full rounded-md border bg-white"
      />
    </div>
  );
}
