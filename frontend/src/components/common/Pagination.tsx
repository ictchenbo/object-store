import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  /** 是否还有下一页（游标） */
  hasNext: boolean;
  hasPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  /** 当前已加载页数 */
  page: number;
  loading?: boolean;
}

/** 游标分页控件：后退由前端页栈维护，前进使用 next_cursor */
export function Pagination({ hasNext, hasPrev, onNext, onPrev, page, loading }: PaginationProps) {
  return (
    <div className="flex items-center justify-between gap-2 pt-3">
      <div className="text-xs text-muted-foreground">第 {page} 页</div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!hasPrev || loading} onClick={onPrev}>
          <ChevronLeft className="size-4" />
          上一页
        </Button>
        <Button variant="outline" size="sm" disabled={!hasNext || loading} onClick={onNext}>
          下一页
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
