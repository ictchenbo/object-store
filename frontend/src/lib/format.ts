// 中文注释：展示层格式化工具（字节、时间、JSON 等）。

/** 字节数转人类可读字符串 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/** ISO 时间转本地可读字符串 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** ISO 时间转日期（YYYY-MM-DD） */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN");
}

/** 截断长文本用于表格展示 */
export function truncate(value: string, max = 42): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** 对象格式化为可读 JSON 文本 */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

/** JSON 文本解析；返回错误信息而不是抛出 */
export function parseJsonObject(text: string): { value: Record<string, unknown>; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: {}, error: "属性必须是 JSON 对象（不能是数组或标量）" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { value: {}, error: error instanceof Error ? error.message : "JSON 解析失败" };
  }
}

/** 状态徽标映射：对象/版本状态 → 展示文案与色调 */
export function statusMeta(status: string): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  switch (status) {
    case "ready":
      return { label: "就绪", tone: "success" };
    case "pending":
    case "staging":
      return { label: "处理中", tone: "warning" };
    case "deleting":
      return { label: "删除中", tone: "warning" };
    case "deleted":
      return { label: "已删除", tone: "neutral" };
    case "failed":
      return { label: "失败", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/**
 * 距离目标时间的剩余天数（向上取整）。
 * 已过期返回 0；入参无效返回 null。用于回收站「剩余恢复天数」展示。
 */
export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  const diff = target - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86_400_000);
}

/** 附件角色展示名 */
export function assetRoleLabel(role: string): string {
  switch (role) {
    case "cover":
      return "封面";
    case "inline_image":
      return "内嵌图片";
    case "attachment":
      return "附件";
    default:
      return role;
  }
}
