// 中文注释：类型定义与 FastAPI /api/v1 响应体保持一致。

/** 标签字典项 */
export interface TagItem {
  id: string;
  name: string;
}

/** 对象目录记录 */
export interface ObjectItem {
  id: string;
  purpose: "standalone" | "document_internal";
  bucket: string;
  object_key: string;
  display_name: string;
  size_bytes: number | null;
  sha256: string | null;
  content_type: string;
  status: "pending" | "ready" | "deleting" | "deleted" | "failed";
  created_at: string;
  ready_at: string | null;
  /** 软删时间；回收站内非空 */
  deleted_at?: string | null;
  /** 恢复截止时间；null 表示无恢复窗口（策略 0 天）或未删除 */
  purge_after?: string | null;
  /** 永久清除完成时间；非空表示不可恢复 */
  purged_at?: string | null;
  tags: TagItem[];
}

/** 回收站对象：软删独立对象 + 删除/清理时间 */
export type TrashObjectItem = ObjectItem;

/** 上传会话创建结果 */
export interface UploadCreated {
  /** 命中内容去重时为 null（无会话，object_id 指向已存在对象） */
  upload_id: string | null;
  object_id: string;
  status: string;
  upload_url: string | null;
  expires_at?: string;
  /** 命中内容去重时为 true */
  deduped?: boolean;
}

/** 文档附件关系 */
export interface AssetItem {
  object_id: string;
  role: "cover" | "inline_image" | "attachment";
  ordinal: number;
  reference_name: string | null;
  /** 对象媒体类型（预览用） */
  content_type?: string;
  /** 对象字节数 */
  size_bytes?: number | null;
}

/** 文档版本 */
export interface VersionItem {
  id: string;
  version_no: number;
  /** deleted = 软删进回收站，窗口内可恢复 */
  status: "staging" | "ready" | "failed" | "deleted";
  doc_type: string;
  raw_object_id: string | null;
  body_object_id: string | null;
  /** 原文对象媒体类型；预览需要，document_internal 无法单独查对象 */
  raw_content_type?: string | null;
  /** 原文对象字节数 */
  raw_size_bytes?: number | null;
  /** 正文对象媒体类型 */
  body_content_type?: string | null;
  /** 正文对象字节数 */
  body_size_bytes?: number | null;
  attrs: Record<string, unknown>;
  published_at: string | null;
  assets: AssetItem[];
  /** 软删时间；恢复窗口内非空 */
  deleted_at?: string | null;
  /** 恢复截止时间；null 表示无恢复窗口（策略 0 天）或未删除 */
  purge_after?: string | null;
  /** 永久清除完成时间；非空表示不可恢复 */
  purged_at?: string | null;
}

/** 逻辑文档 */
export interface DocumentItem {
  id: string;
  source: string;
  external_id: string;
  doc_type: string;
  title: string;
  attrs: Record<string, unknown>;
  current_version_id: string | null;
  created_at: string;
  /** 软删时间；回收站内非空 */
  deleted_at?: string | null;
  /** 恢复截止时间；null 表示无恢复窗口（策略 0 天）或未删除 */
  purge_after?: string | null;
  /** 永久清除完成时间；非空表示不可恢复 */
  purged_at?: string | null;
  tags: TagItem[];
  current_version?: VersionItem | null;
}

/** 回收站文档：软删文档 + 删除/清理时间 */
export interface TrashDocumentItem extends DocumentItem {
  deleted_at: string | null;
  purge_after: string | null;
}

/** 文档类型字典项 */
export interface DocumentTypeItem {
  code: string;
  display_name: string;
  schema_version: number;
}

/** 游标分页响应 */
export interface PageResponse<T> {
  items: T[];
  next_cursor: string | null;
}

/** 对象统计概览 */
export interface ObjectStatsOverview {
  object_count: number;
  logical_bytes: number;
  as_of: string;
}

/** 桶级统计 */
export interface BucketStatItem {
  bucket: string;
  object_count: number;
  logical_bytes: number;
}

export interface BucketStatsResponse {
  items: BucketStatItem[];
  as_of: string;
}

/** 每日流量统计 */
export interface DailyStatItem {
  day: string;
  created_count: number;
  deleted_count: number;
}

export interface DailyStatsResponse {
  items: DailyStatItem[];
  as_of: string;
}

/** 文档层统计 */
export interface DocumentStatsOverview {
  document_count: number;
  version_count: number;
  asset_count: number;
  as_of: string;
}

/** 采集会话创建结果 */
export interface IngestCreated {
  ingest_session_id: string;
  document_id: string;
  version_no: number;
  status: string;
}

/** 标签绑定结果 */
export interface TagBindResult {
  items: TagItem[];
}

/** 统一错误体 */
export interface ApiErrorBody {
  code: string;
  message: string;
  request_id?: string;
}

/** 对象列表排序 */
export type ObjectSort = "newest" | "oldest" | "name_asc" | "name_desc";

/** 文档列表排序 */
export type DocumentSort = "newest" | "oldest" | "title_asc" | "title_desc";

/** 对象列表筛选条件 */
export interface ObjectFilters {
  /** 显示名模糊搜索 */
  q?: string;
  tag?: string;
  tag_ids?: string[];
  tag_mode?: "all" | "any";
  bucket?: string;
  name_prefix?: string;
  content_type?: string;
  /** 媒体类型前缀过滤，如 image/ */
  content_type_prefix?: string;
  sha256?: string;
  ready_from?: string;
  ready_to?: string;
  min_size?: number | null;
  max_size?: number | null;
  sort?: ObjectSort;
  cursor?: string | null;
  limit?: number;
}

/** 文档列表筛选条件 */
export interface DocumentFilters {
  /** 标题/来源/外部 ID 模糊搜索 */
  q?: string;
  tag?: string;
  tag_ids?: string[];
  tag_mode?: "all" | "any";
  doc_type?: string;
  source?: string;
  external_id?: string;
  /** 创建时间下界（含） */
  created_from?: string;
  /** 创建时间上界（不含） */
  created_to?: string;
  sort?: DocumentSort;
  cursor?: string | null;
  limit?: number;
}

/** 附件录入行（采集用） */
export interface AssetDraft {
  object_id: string;
  role: "cover" | "inline_image" | "attachment";
  ordinal: number;
  reference_name: string;
}

/** 后台任务 */
export interface JobItem {
  id: string;
  kind: string;
  target_id: string;
  status: "pending" | "running" | "failed" | "done" | "dead";
  attempts: number;
  last_error: string | null;
  next_run_at: string | null;
  claimed_at: string | null;
  created_at: string;
}

/** 任务复活结果 */
export interface JobRetryResult {
  id: string;
  status: string;
}

/** 文档类型变更审计记录 */
export interface TypeChangeItem {
  id: string;
  document_id: string;
  old_type: string;
  new_type: string;
  actor_id: string | null;
  reason: string;
  changed_at: string;
  new_version_id: string | null;
}

/** 状态转移事件流水 */
export interface AuditEventItem {
  id: string;
  event_kind: string;
  target_type: string;
  target_id: string;
  actor_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/** 租户保留策略：由 Worker 自动执行 */
export interface RetentionPolicy {
  orphan_object_grace_hours: number;
  staging_retry_grace_seconds: number;
  staging_retry_max_attempts: number;
  version_retention: "keep_all" | "keep_last_n" | "keep_current_only";
  /** keep_last_n 时保留的历史版本数 */
  version_retention_n: number;
  /** 0=立即永久删除；>0 为恢复窗口天数 */
  deleted_object_purge_days: number;
  /** 0=立即永久删除；>0 为回收站恢复窗口天数 */
  deleted_document_purge_days: number;
  note?: string;
}

/** 文档删除受理结果 */
export interface DocumentDeleteResult {
  status: string;
  job_id: string;
  purge_after?: string | null;
}

/** 版本删除受理结果 */
export interface VersionDeleteResult {
  status: string;
  version_no: number;
  purge_after?: string | null;
}

/** 对象删除受理结果；204 时无响应体 */
export interface ObjectDeleteResult {
  status: string;
  purge_after?: string | null;
}

/** 立即永久删除受理结果 */
export interface PurgeResult {
  status: string;
  job_id: string;
}

/** 对账触发结果 */
export interface ReconcileResult {
  job_id: string;
  status: string;
}

/** 签名下载/预览 URL */
export interface SignedUrl {
  url: string;
  expires_in: number;
}

// —— 登录会话 / 用户 ——

/** 登录成功响应 */
export interface LoginResult {
  token: string;
  token_type: string;
  expires_in: number;
  user: {
    id: string;
    username: string;
    tenant_id: string;
    role: UserRole;
  };
}

/** GET /auth/me 响应 */
export interface MeResult {
  tenant_id: string;
  actor_id: string;
  role: UserRole;
}

export type UserRole = "admin" | "viewer";

/** 用户列表项 */
export interface UserItem {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  created_at: string;
}

// —— 分享链接 ——

export type ShareTargetType = "document" | "object";
export type SharePermission = "view" | "download";

/** 分享链接记录 */
export interface ShareLinkItem {
  id: string;
  token: string;
  target_type: ShareTargetType;
  target_id: string;
  permission: SharePermission;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
}

/** 创建分享链接结果 */
export interface ShareLinkCreated {
  id: string;
  token: string;
  permission: SharePermission;
  expires_at: string;
  /** 服务端拼好的公开地址（public_base_url/share/{token}） */
  url?: string;
}

// —— 批量操作 ——

/** 批量打标结果行 */
export interface BulkTagResultItem {
  id: string;
  status: "ok" | "error";
  message?: string;
}

export interface BulkTagResult {
  items: BulkTagResultItem[];
}

/** 批量删除结果行 */
export interface BulkDeleteResultItem {
  id: string;
  status: string;
  purge_after?: string | null;
  message?: string;
}

export interface BulkDeleteResult {
  items: BulkDeleteResultItem[];
}
