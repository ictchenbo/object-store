import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  className?: string;
}

/** 指标卡片：图标 + 标签 + 数值 + 备注 */
export function StatCard({ icon: Icon, label, value, hint, className }: StatCardProps) {
  return (
    <Card className={cn("", className)}>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="rounded-lg bg-brand/10 p-2 text-brand">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-0.5 truncate text-xl font-semibold tabular-nums">{value}</div>
          {hint ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}
