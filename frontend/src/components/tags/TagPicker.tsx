import * as React from "react";
import { Loader2, Plus, Tag as TagIcon, X } from "lucide-react";
import { api } from "@/lib/api";
import type { TagItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";

interface TagPickerProps {
  /** 已选标签 */
  value: TagItem[];
  onChange: (tags: TagItem[]) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** 传给内部 Input 的 id，便于外部 <Label htmlFor> 关联 */
  inputId?: string;
}

/**
 * 标签选择器：支持搜索已有标签（前缀建议）、选择多个标签、输入新标签名。
 * 新名称提交时由服务端归一化并自动创建，此处先本地暂存。
 */
export function TagPicker({ value, onChange, placeholder = "搜索或输入新标签…", className, disabled, inputId }: TagPickerProps) {
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<TagItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  // 中文注释：高亮索引仅由 ↑↓ 键驱动；未高亮时 Enter 不自动选中首条，避免误选
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listboxId = React.useId();

  // 中文注释：输入变化时做前缀建议查询；空串查询当前租户标签列表。
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api.listTags(query);
        if (!cancelled) {
          const selectedIds = new Set(value.map((item) => item.id));
          setSuggestions(result.items.filter((item) => !selectedIds.has(item.id)));
          setActiveIndex(-1);
        }
      } catch (error) {
        if (!cancelled) {
          setSuggestions([]);
          setActiveIndex(-1);
          toast({
            title: "标签建议加载失败",
            description: error instanceof Error ? error.message : String(error),
            tone: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, value]);

  // 中文注释：点击外部关闭建议列表。
  React.useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function addTag(tag: TagItem) {
    if (value.some((item) => item.id === tag.id)) return;
    onChange([...value, tag]);
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
  }

  function addNewName() {
    const name = query.trim();
    if (!name) return;
    if (value.some((item) => item.name === name)) {
      setQuery("");
      return;
    }
    // 新标签用临时 id 标记，提交时走 new_tag_names
    onChange([...value, { id: `new:${name}`, name }]);
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
  }

  function removeTag(tag: TagItem) {
    onChange(value.filter((item) => item.id !== tag.id));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // 中文注释：仅当用户显式高亮某条建议时才选中；否则按「新建标签」处理
      if (activeIndex >= 0 && activeIndex < suggestions.length) addTag(suggestions[activeIndex]);
      else if (canCreate) addNewName();
    }
  }

  const exactExists = suggestions.some((item) => item.name.toLowerCase() === query.trim().toLowerCase());
  const canCreate = query.trim().length > 0 && !exactExists;
  const showList = open && (query.trim() || suggestions.length > 0 || loading);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {value.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <Badge key={tag.id} variant="brand" className="gap-1 pr-1">
              <TagIcon className="size-3" />
              {tag.name}
              {!disabled ? (
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-brand/20"
                  onClick={() => removeTag(tag)}
                  aria-label={`移除标签 ${tag.name}`}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={showList ? true : false}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <Button type="button" variant="outline" disabled={disabled || !canCreate} onClick={addNewName}>
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      {showList ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="标签建议"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover shadow-md"
        >
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> 加载标签…
            </div>
          ) : null}
          {!loading && suggestions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">没有匹配的已有标签</div>
          ) : null}
          {suggestions.map((item, index) => (
            <button
              key={item.id}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                index === activeIndex && "bg-muted",
              )}
              onClick={() => addTag(item)}
            >
              <TagIcon className="size-3.5 text-muted-foreground" />
              {item.name}
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm text-primary hover:bg-muted"
              onClick={addNewName}
            >
              <Plus className="size-3.5" />
              创建标签「{query.trim()}」
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 拆分标签列表为已有 ID 与新名称（供 API 提交） */
export function splitTags(tags: TagItem[]): { tag_ids: string[]; new_tag_names: string[] } {
  const tag_ids: string[] = [];
  const new_tag_names: string[] = [];
  for (const tag of tags) {
    if (tag.id.startsWith("new:")) new_tag_names.push(tag.name);
    else tag_ids.push(tag.id);
  }
  return { tag_ids, new_tag_names };
}
