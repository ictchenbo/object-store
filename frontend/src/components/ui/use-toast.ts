// 中文注释：轻量 toast 状态管理（不引入外部依赖）。
import * as React from "react";

export type ToastTone = "default" | "success" | "destructive" | "warning";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastState {
  toasts: ToastItem[];
}

const listeners = new Set<(state: ToastState) => void>();
let memoryState: ToastState = { toasts: [] };

function emit() {
  for (const listener of listeners) listener(memoryState);
}

let counter = 0;

export function toast(item: Omit<ToastItem, "id">) {
  counter += 1;
  const next: ToastItem = { id: `toast-${counter}`, tone: "default", ...item };
  memoryState = { toasts: [...memoryState.toasts, next] };
  emit();
  // 自动消失
  setTimeout(() => dismissToast(next.id), 4200);
}

export function dismissToast(id: string) {
  memoryState = { toasts: memoryState.toasts.filter((item) => item.id !== id) };
  emit();
}

export function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState);
  React.useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return { toasts: state.toasts, toast, dismiss: dismissToast };
}
