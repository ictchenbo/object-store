import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
// 中文注释：只引入类型，不引入运行时 —— 消毒与 DOMPurify 留在动态加载的 docx.ts 里
import type { DocxConvertResult } from "@/lib/preview/docx";

interface DocxPreviewProps {
  /** 转换结果；挂载用的是其中的 createFragment()（已消毒） */
  result: DocxConvertResult;
}

/**
 * DOCX 预览：以 DocumentFragment 挂载已消毒内容。
 *
 * 中文注释：**绝不走任何 inner-HTML 注入通道** —— 不用 React 的危险注入
 * prop，也不用原生 inner-HTML 属性。Fragment 在惰性 createHTMLDocument
 * 上下文里生成，无活 DOM 解析窗口。
 * 项目不变量：前端源码里不得出现这两类注入通道（门禁见 TEST_REPORT）。
 */
export function DocxPreview({ result }: DocxPreviewProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { html, createFragment, truncated, droppedImages, warnings } = result;

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 中文注释：每次 effect 都要一个新 Fragment —— 上次的已被 replaceChildren 移空
    el.replaceChildren(createFragment());
    return () => {
      el.replaceChildren();
    };
  }, [html, createFragment]);

  // 中文注释：禁了 target 属性防反向 tabnabbing，代价是 <a> 会把 SPA 导航走。
  // 这里在容器上拦截，改用带 noopener 的新窗口，两头都占。
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor || !el.contains(anchor)) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      window.open(href, "_blank", "noopener,noreferrer");
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="space-y-2">
      {truncated ? (
        <Alert>
          <AlertTitle>内容过长，已截断显示</AlertTitle>
          <AlertDescription>完整内容请下载原文档。</AlertDescription>
        </Alert>
      ) : null}

      {droppedImages ? (
        <Alert>
          <AlertTitle>部分图片未内联</AlertTitle>
          <AlertDescription>
            {droppedImages} 张图片超过内嵌上限，已替换为占位图。原图请下载文档查看。
          </AlertDescription>
        </Alert>
      ) : null}

      {warnings && warnings.length > 0 ? (
        <Alert>
          <AlertTitle>转换提示</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {warnings.slice(0, 5).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 样式走 Tailwind 子选择器变体：不引入全局 CSS，也不允许源文档带 style */}
      <div
        ref={ref}
        data-preview-body="docx"
        className="max-h-[60vh] overflow-auto rounded-md border p-4 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_br]:my-1 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_hr]:my-3 [&_img]:my-2 [&_img]:max-w-full [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:text-xs [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  );
}
