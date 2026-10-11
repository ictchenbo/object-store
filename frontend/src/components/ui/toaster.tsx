import { CheckCircle2, Info, TriangleAlert, XCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dismissToast, useToast } from "./use-toast";

/** 全局 toast 容器：固定右下角展示 */
export function Toaster() {
  const { toasts } = useToast();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((item) => {
        const tone = item.tone || "default";
        const Icon =
          tone === "success" ? CheckCircle2 : tone === "destructive" ? XCircle : tone === "warning" ? TriangleAlert : Info;
        return (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-lg border bg-card p-3 shadow-lg animate-fade-in",
              tone === "success" && "border-success/40",
              tone === "destructive" && "border-destructive/40",
              tone === "warning" && "border-warning/40",
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                tone === "success" && "text-success",
                tone === "destructive" && "text-destructive",
                tone === "warning" && "text-warning",
                tone === "default" && "text-primary",
              )}
            />
            <div className="flex-1 text-sm">
              <div className="font-medium">{item.title}</div>
              {item.description ? <div className="mt-0.5 text-muted-foreground">{item.description}</div> : null}
            </div>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => dismissToast(item.id)}
              aria-label="关闭通知"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
