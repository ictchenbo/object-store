import { parseJsonObject } from "@/lib/format";
import { Textarea } from "@/components/ui/textarea";

interface JsonFieldProps {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}

/** JSON 对象编辑器：实时校验并把解析结果通过 onValid 上抛 */
export function JsonField({ label, value, onChange, placeholder = '{\n  "key": "value"\n}', disabled, rows = 4 }: JsonFieldProps) {
  const { error } = parseJsonObject(value);
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <Textarea
        value={value}
        disabled={disabled}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={error ? "border-destructive font-mono text-xs" : "font-mono text-xs"}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">必须是 JSON 对象</p>}
    </div>
  );
}
