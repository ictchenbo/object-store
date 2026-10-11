import { AlertCircle } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ErrorAlertProps {
  error: unknown;
  title?: string;
}

/** 统一错误展示：ApiError 显示 code / request_id，其余显示原始消息 */
export function ErrorAlert({ error, title = "请求失败" }: ErrorAlertProps) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div>{message}</div>
        {apiError ? (
          <div className="mt-1 text-xs opacity-80">
            code: {apiError.code}
            {apiError.requestId ? ` · request_id: ${apiError.requestId}` : ""}
            {apiError.status ? ` · HTTP ${apiError.status}` : ""}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
