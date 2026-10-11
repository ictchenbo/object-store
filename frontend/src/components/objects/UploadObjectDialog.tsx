import * as React from "react";
import { Loader2, UploadCloud } from "lucide-react";
import { api, putToPresignedUrl, ApiError, MAX_UPLOAD_BYTES } from "@/lib/api";
import type { ObjectItem, TagItem } from "@/lib/types";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { TagPicker, splitTags } from "@/components/tags/TagPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";

interface UploadObjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: (item: ObjectItem) => void;
  /** 固定用途；文档入库时传 document_internal */
  purpose?: "standalone" | "document_internal";
}

type Phase = "idle" | "creating" | "uploading" | "completing" | "done";

/** 浏览器端计算 SHA-256 的文件大小上限（超过则跳过，避免一次性读入内存） */
const DEDUP_HASH_MAX_BYTES = 64 * 1024 * 1024;

/** 计算文件 SHA-256（十六进制小写）；Web Crypto 不可用时抛错由调用方降级 */
async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 独立对象上传对话框：
 * 1) POST /uploads 建会话拿预签名 URL
 * 2) 浏览器 PUT 直传 staging key
 * 3) POST /uploads/{id}/complete 由服务端复制到正式 key 并置 ready
 * 支持点击选择与拖拽放入（多文件进入待传列表，逐个走同一预签名流程）。
 */
export function UploadObjectDialog({ open, onOpenChange, onUploaded, purpose = "standalone" }: UploadObjectDialogProps) {
  // 中文注释：待传文件列表；拖拽/选择均可填入多文件，逐个上传
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [displayName, setDisplayName] = React.useState("");
  const [contentType, setContentType] = React.useState("application/octet-stream");
  const [tags, setTags] = React.useState<TagItem[]>([]);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState<unknown>(null);
  const [dragOver, setDragOver] = React.useState(false);

  const busy = phase === "creating" || phase === "uploading" || phase === "completing";
  const file = pendingFiles[activeIndex] || null;

  function reset() {
    setPendingFiles([]);
    setActiveIndex(0);
    setDisplayName("");
    setContentType("application/octet-stream");
    setTags([]);
    setPhase("idle");
    setProgress(0);
    setError(null);
    setDragOver(false);
  }

  /** 统一关闭入口：取消按钮也必须清空表单，避免重开后残留上次的文件与标签 */
  function close() {
    reset();
    onOpenChange(false);
  }

  /** 把 FileList 合入待传列表（去重：同名+同大小+同 lastModified 视为同一文件） */
  function appendFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list).filter((item) => item.size > 0);
    if (incoming.length === 0) {
      setError(new Error("拖入的文件为空或不可读"));
      return;
    }
    setPendingFiles((prev) => {
      const seen = new Set(prev.map((item) => `${item.name}|${item.size}|${item.lastModified}`));
      const merged = [...prev];
      for (const item of incoming) {
        const key = `${item.name}|${item.size}|${item.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
      return merged;
    });
    setError(null);
  }

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    appendFiles(event.target.files);
    // 中文注释：清空 value 允许再次选择同名文件
    event.target.value = "";
  }

  /** 文件夹选择（webkitdirectory）：扁平化目录内全部文件进待传列表 */
  function onFolderChange(event: React.ChangeEvent<HTMLInputElement>) {
    appendFiles(event.target.files);
    event.target.value = "";
  }

  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(true);
  }

  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    if (busy) return;
    // 中文注释：拖入文件夹时递归展开（webkitGetAsEntry）；普通文件走 FileList
    const items = event.dataTransfer?.items;
    if (items && items.length > 0 && typeof (items[0] as DataTransferItem).webkitGetAsEntry === "function") {
      void collectDroppedEntries(Array.from(items)).then((files) => appendFiles(files));
      return;
    }
    appendFiles(event.dataTransfer?.files || null);
  }

  /** 递归收集拖入的文件/目录条目（目录取全部子文件，扁平化进待传列表） */
  async function collectDroppedEntries(items: DataTransferItem[]): Promise<File[]> {
    const collected: File[] = [];
    async function walk(entry: FileSystemEntry | null): Promise<void> {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) =>
          (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
        );
        if (file) collected.push(file);
        return;
      }
      if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        for (const child of children) await walk(child);
      }
    }
    for (const item of items) {
      if (item.kind !== "file") continue;
      await walk(item.webkitGetAsEntry?.() ?? null);
    }
    return collected;
  }

  /** 选中文件变化时自动带出展示名与媒体类型（仅首个未命名时） */
  React.useEffect(() => {
    if (!file) return;
    setDisplayName((current) => current || file.name);
    setContentType((current) =>
      current === "application/octet-stream" && file.type ? file.type : current,
    );
  }, [file]);

  /** 上传单个文件：沿用 create → PUT → complete 预签名流程 */
  async function uploadOne(target: File, name: string): Promise<ObjectItem> {
    if (target.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `文件 ${target.size.toLocaleString("zh-CN")} 字节超过上限 ${MAX_UPLOAD_BYTES.toLocaleString("zh-CN")} 字节（1 GiB）`,
      );
    }
    if (target.size <= 0) throw new Error("文件内容为空，无法上传");
    // 中文注释：小文件在浏览器端算 SHA-256 以启用内容去重；大文件跳过（内存与耗时考虑）
    let declaredSha256: string | undefined;
    if (target.size <= DEDUP_HASH_MAX_BYTES && purpose === "standalone") {
      try {
        declaredSha256 = await sha256Hex(target);
      } catch {
        declaredSha256 = undefined;
      }
    }
    const payload = {
      display_name: name,
      content_type: contentType.trim() || "application/octet-stream",
      expected_size: target.size,
      purpose,
      ...splitTags(tags),
      ...(declaredSha256 ? { sha256: declaredSha256, dedup: true } : {}),
    };
    const created = await api.createUpload(payload);

    // 中文注释：去重命中 / 幂等重放且对象已 ready 时 upload_url 为 null，直接取现成对象
    if (!created.upload_url || !created.upload_id) {
      return api.getObject(created.object_id);
    }
    setPhase("uploading");
    setProgress(5);
    // 中文注释：XHR 真实进度映射到 5–85 区间，留下完成阶段的余量
    await putToPresignedUrl(created.upload_url, target, (percent) => {
      setProgress(5 + Math.round(percent * 0.8));
    });
    setPhase("completing");
    setProgress(90);
    const completed = await api.completeUpload(created.upload_id);
    setProgress(100);
    return completed;
  }

  async function submit() {
    if (pendingFiles.length === 0) {
      setError(new Error("请选择或拖入要上传的文件"));
      return;
    }
    const name = displayName.trim() || file?.name || "";
    if (!name) {
      setError(new Error("文件名不能为空"));
      return;
    }
    setError(null);
    // 中文注释：客户端预检体积上限，避免白传 1GiB 后才被服务端拒绝
    try {
      // 多文件时逐个上传；单文件保持原交互（成功后关闭）
      const isBatch = pendingFiles.length > 1;
      let okCount = 0;
      for (let i = 0; i < pendingFiles.length; i += 1) {
        const target = pendingFiles[i];
        setActiveIndex(i);
        setPhase("creating");
        setProgress(2);
        const currentName = isBatch ? target.name : name;
        const completed = await uploadOne(target, currentName);
        okCount += 1;
        onUploaded(completed);
        toast({
          title: "上传成功",
          description: `${completed.display_name} 已就绪`,
          tone: "success",
        });
      }
      if (isBatch) {
        toast({ title: "批量上传完成", description: `成功 ${okCount} / ${pendingFiles.length}`, tone: "success" });
      }
      onOpenChange(false);
      reset();
    } catch (err) {
      setPhase("idle");
      setProgress(0);
      setError(err);
      if (err instanceof ApiError && err.status === 409) {
        toast({ title: "上传冲突", description: err.message, tone: "warning" });
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return; // 上传中禁止关闭
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>上传独立对象</DialogTitle>
          <DialogDescription>
            客户端直传暂存位置，服务端校验大小后复制到正式 key。支持拖拽多个文件，逐个上传。正式前缀仅服务端可写。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 拖拽区 + 文件选择 */}
          <div className="space-y-1.5">
            <Label htmlFor="upload-file">文件</Label>
            <div
              role="button"
              tabIndex={0}
              aria-label="拖拽或点击选择文件"
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
                dragOver
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-muted-foreground/30 text-muted-foreground hover:border-brand/50"
              }`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => document.getElementById("upload-file")?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  document.getElementById("upload-file")?.click();
                }
              }}
            >
              <UploadCloud className="size-6" />
              <div className="text-sm">
                {dragOver ? "松开以加入待传列表" : "拖拽文件或文件夹到此处，或点击选择"}
              </div>
              <div className="text-xs">支持多文件与文件夹；单文件上限 1 GiB</div>
            </div>
            <Input id="upload-file" type="file" multiple onChange={onFileChange} disabled={busy} className="hidden" />
            {/* 中文注释：webkitdirectory 让目录内文件扁平化进入待传列表 */}
            <input
              id="upload-folder"
              type="file"
              multiple
              className="hidden"
              onChange={onFolderChange}
              disabled={busy}
              {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => document.getElementById("upload-folder")?.click()}
            >
              选择文件夹
            </Button>
            {pendingFiles.length > 0 ? (
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                {pendingFiles.map((item, index) => (
                  <div
                    key={`${item.name}|${item.size}|${item.lastModified}`}
                    className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-xs ${
                      index === activeIndex ? "bg-brand/10 text-brand" : ""
                    }`}
                  >
                    <span className="truncate" title={item.name}>
                      {item.name}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {item.size.toLocaleString("zh-CN")} B
                    </span>
                    {!busy ? (
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={`移除 ${item.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPendingFiles((prev) => prev.filter((_, i) => i !== index));
                        }}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {pendingFiles.length === 1 && file ? (
              <p className="text-xs text-muted-foreground">
                大小 {file.size.toLocaleString("zh-CN")} 字节 · 类型 {file.type || "未知"}
              </p>
            ) : null}
            {pendingFiles.length > 1 ? (
              <p className="text-xs text-muted-foreground">
                共 {pendingFiles.length} 个文件，将逐个上传（第 {Math.min(activeIndex + 1, pendingFiles.length)} 个）
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="upload-name">展示名称</Label>
            <Input
              id="upload-name"
              value={displayName}
              disabled={busy}
              placeholder="默认取文件名；多文件时各自使用原名"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="媒体类型-contenttype">媒体类型 content_type</Label>
            <Select value={contentType} onValueChange={setContentType} disabled={busy}>
              <SelectTrigger id="媒体类型-contenttype">
                <SelectValue placeholder="选择媒体类型" />
              </SelectTrigger>
              <SelectContent>
                {[
                  "application/octet-stream",
                  "application/pdf",
                  "application/json",
                  "text/plain",
                  "text/csv",
                  "text/html",
                  "image/png",
                  "image/jpeg",
                  "image/webp",
                  "audio/mpeg",
                  "video/mp4",
                ].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="自定义标签可选新名称自动创建">自定义标签（可选，新名称自动创建）</Label>
            <TagPicker inputId="自定义标签可选新名称自动创建" value={tags} onChange={setTags} disabled={busy} />
          </div>

          {busy ? (
            <div className="space-y-1.5">
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                {phase === "creating" ? "创建上传会话…" : phase === "uploading" ? "直传对象存储…" : "服务端核验并转正…"}
              </p>
            </div>
          ) : null}

          <ErrorAlert error={error} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || pendingFiles.length === 0}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
            {busy ? "处理中…" : pendingFiles.length > 1 ? `上传 ${pendingFiles.length} 个文件` : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
