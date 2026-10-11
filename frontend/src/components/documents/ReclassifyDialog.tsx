import * as React from "react";
import { Loader2, Shuffle } from "lucide-react";
import { api } from "@/lib/api";
import type { DocumentItem, DocumentTypeItem } from "@/lib/types";
import { parseJsonObject } from "@/lib/format";
import { ErrorAlert } from "@/components/common/ErrorAlert";
import { JsonField } from "@/components/common/JsonField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";

interface ReclassifyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: DocumentItem;
  types: DocumentTypeItem[];
  onDone: (updated: DocumentItem) => void;
}

/**
 * 重分类对话框：追加引用原对象的新版本，同事务更新 doc_type 与当前版本指针，
 * 并写入 document_type_changes 审计记录。
 */
export function ReclassifyDialog({ open, onOpenChange, document, types, onDone }: ReclassifyDialogProps) {
  const [docType, setDocType] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [attrsText, setAttrsText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      setDocType("");
      setReason("");
      setAttrsText("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (!docType) {
      setError(new Error("请选择目标类型"));
      return;
    }
    if (!reason.trim()) {
      setError(new Error("请填写重分类原因"));
      return;
    }
    const parsed = parseJsonObject(attrsText);
    if (parsed.error) {
      setError(new Error(parsed.error));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.reclassifyDocument(document.id, {
        doc_type: docType,
        reason: reason.trim(),
        attrs: parsed.value,
      });
      toast({ title: "重分类完成", description: `已追加版本并记录审计`, tone: "success" });
      onDone(updated);
      onOpenChange(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重分类文档</DialogTitle>
          <DialogDescription>
            当前类型：<strong>{document.doc_type}</strong>。普通版本发布不会更改类型；纠错请走此受权流程。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="目标类型">目标类型</Label>
            <Select value={docType} onValueChange={setDocType} disabled={busy}>
              <SelectTrigger id="目标类型" data-testid="reclassify-type">
                <SelectValue placeholder="选择新类型" />
              </SelectTrigger>
              <SelectContent>
                {types
                  .filter((item) => item.code !== document.doc_type)
                  .map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.display_name}（{item.code}）
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="原因-reason">原因 reason</Label>
            <Textarea id="原因-reason"
              value={reason}
              disabled={busy}
              rows={3}
              placeholder="例如：来源分类纠错"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <JsonField label="属性快照 attrs（可选，留空则沿用当前值）" value={attrsText} onChange={setAttrsText} disabled={busy} />

          <ErrorAlert error={error} title="重分类失败" />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button data-testid="reclassify-submit" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Shuffle className="size-4" />}
            确认重分类
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
