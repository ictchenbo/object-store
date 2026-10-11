import { Tag as TagIcon, X } from "lucide-react";
import type { TagItem } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TagListProps {
  tags: TagItem[];
  onRemove?: (tag: TagItem) => void;
  className?: string;
}

/** 已绑定标签展示；可选提供解绑回调 */
export function TagList({ tags, onRemove, className }: TagListProps) {
  if (!tags.length) return <span className="text-xs text-muted-foreground">无标签</span>;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {tags.map((tag) => (
        <Badge key={tag.id} variant="brand" className={cn("gap-1", onRemove && "pr-1")}>
          <TagIcon className="size-3" />
          {tag.name}
          {onRemove ? (
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-brand/20"
              onClick={() => onRemove(tag)}
              aria-label={`解绑标签 ${tag.name}`}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </Badge>
      ))}
    </div>
  );
}
