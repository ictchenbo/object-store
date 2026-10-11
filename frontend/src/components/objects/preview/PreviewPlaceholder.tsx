import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PreviewPlaceholderProps {
  /** 主标题，例如「该媒体类型不支持内联预览」 */
  title: string;
  /** 说明文案 */
  description?: React.ReactNode;
  /** 附加明细（类型、字节对比等） */
  detail?: React.ReactNode;
  /** 下载出口。**任何阻断态都必须给**，预览失败永远不是死胡同 */
  onDownload?: () => void;
  downloadLabel?: string;
}

/**
 * 阻断态占位面板（虚线）。
 *
 * 中文注释：这是 `blocked` 态，不是红色错误 —— 「文件太大」「类型不支持」
 * 都是预期情况，用虚线中性面板 + 显眼的下载按钮，而不是 ErrorAlert。
 */
export function PreviewPlaceholder({
  title,
  description,
  detail,
  onDownload,
  downloadLabel = "下载文件",
}: PreviewPlaceholderProps) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-prose text-xs text-muted-foreground">{description}</p>
      ) : null}
      {detail ? (
        <p className="max-w-prose break-all font-mono text-xs text-muted-foreground">{detail}</p>
      ) : null}
      {onDownload ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onDownload}>
          <Download className="size-4" />
          {downloadLabel}
        </Button>
      ) : null}
    </div>
  );
}
