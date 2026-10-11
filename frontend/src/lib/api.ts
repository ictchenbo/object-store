// 中文注释：FastAPI 客户端。所有写操作自动携带 Idempotency-Key，错误统一抛出 ApiError。
// 鉴权支持两种来源：登录会话 token（Authorization: Bearer，优先）或 X-API-Key。
import type {
  AssetDraft,
  AuditEventItem,
  BulkDeleteResult,
  BulkTagResult,
  BucketStatsResponse,
  DailyStatsResponse,
  DocumentDeleteResult,
  DocumentFilters,
  DocumentItem,
  DocumentStatsOverview,
  DocumentTypeItem,
  IngestCreated,
  JobItem,
  JobRetryResult,
  LoginResult,
  MeResult,
  ObjectDeleteResult,
  ObjectFilters,
  ObjectItem,
  ObjectStatsOverview,
  PageResponse,
  PurgeResult,
  ReconcileResult,
  RetentionPolicy,
  ShareLinkCreated,
  ShareLinkItem,
  SharePermission,
  ShareTargetType,
  SignedUrl,
  TagBindResult,
  TagItem,
  TrashDocumentItem,
  TrashObjectItem,
  TypeChangeItem,
  UploadCreated,
  UserItem,
  UserRole,
  VersionDeleteResult,
  VersionItem,
} from "./types";

const API_BASE_KEY = "object-store.api-base";
const API_KEY_STORAGE = "object-store.api-key";
const SESSION_TOKEN_STORAGE = "object-store.session-token";
const ACTOR_KEY_STORAGE = "object-store.actor-id";
const THEME_STORAGE = "object-store.theme";

/** 客户端上传体积上限（与服务端 max_object_bytes 默认值一致） */
export const MAX_UPLOAD_BYTES = 1_073_741_824;

/** 401 时广播的事件名；App 监听后跳转登录页或设置页 */
export const UNAUTHORIZED_EVENT = "object-store:unauthorized";

/** 默认 API 前缀：开发与容器部署均通过同源代理访问后端 */
export const DEFAULT_API_BASE = "/api/v1";

export function loadApiBase(): string {
  try {
    return localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

export function saveApiBase(value: string) {
  try {
    localStorage.setItem(API_BASE_KEY, value.trim() || DEFAULT_API_BASE);
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function loadApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function saveApiKey(value: string) {
  try {
    if (value) localStorage.setItem(API_KEY_STORAGE, value);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 读取登录会话 token；有值时请求走 Authorization: Bearer */
export function loadSessionToken(): string {
  try {
    return localStorage.getItem(SESSION_TOKEN_STORAGE) || "";
  } catch {
    return "";
  }
}

export function saveSessionToken(value: string) {
  try {
    if (value) localStorage.setItem(SESSION_TOKEN_STORAGE, value);
    else localStorage.removeItem(SESSION_TOKEN_STORAGE);
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function loadActorId(): string {
  try {
    return localStorage.getItem(ACTOR_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function saveActorId(value: string) {
  try {
    if (value) localStorage.setItem(ACTOR_KEY_STORAGE, value.trim());
    else localStorage.removeItem(ACTOR_KEY_STORAGE);
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function loadTheme(): "light" | "dark" | "system" {
  try {
    const saved = localStorage.getItem(THEME_STORAGE);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* 忽略 */
  }
  return "system";
}

export function saveTheme(value: "light" | "dark" | "system") {
  try {
    if (value === "system") localStorage.removeItem(THEME_STORAGE);
    else localStorage.setItem(THEME_STORAGE, value);
  } catch {
    /* 忽略 */
  }
}

/** API 错误对象：携带状态码与统一错误体字段 */
export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const base = loadApiBase().replace(/\/$/, "");
  const url = `${base}${path}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") search.append(key, String(item));
      }
    } else {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * 中文注释：组装鉴权头。
 * 会话 token 优先（Authorization: Bearer），否则退回 X-API-Key；
 * 两者都没有时返回 null，由调用方决定是否放行（如登录、公开分享）。
 */
function buildAuthHeaders(): Record<string, string> | null {
  const sessionToken = loadSessionToken();
  if (sessionToken) return { Authorization: `Bearer ${sessionToken}` };
  const apiKey = loadApiKey();
  if (apiKey) return { "X-API-Key": apiKey };
  return null;
}

/** 生成幂等键；浏览器环境优先使用 crypto.randomUUID */
export function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* 回退 */
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, unknown>;
  idempotent?: boolean;
  signal?: AbortSignal;
  /** false = 免鉴权请求（登录、公开分享）；默认 true */
  auth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.auth !== false) {
    const authHeaders = buildAuthHeaders();
    if (!authHeaders) {
      throw new ApiError(
        401,
        "MISSING_CREDENTIALS",
        "尚未登录且未配置 X-API-Key，请先登录或在设置页填写",
      );
    }
    Object.assign(headers, authHeaders);
    // 中文注释：可选操作者覆盖；未配置时不发送该头（会话身份由服务端解析）
    const actorId = loadActorId();
    if (actorId && !authHeaders.Authorization) headers["X-Actor-Id"] = actorId;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotent) headers["Idempotency-Key"] = newIdempotencyKey();

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.params), {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (networkError) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      `无法连接后端服务：${networkError instanceof Error ? networkError.message : String(networkError)}`,
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = (parsed || {}) as Partial<{ code: string; message: string; request_id: string; detail: unknown }>;
    const message =
      typeof body.message === "string" && body.message
        ? body.message
        : typeof body.detail === "string"
          ? body.detail
          : `请求失败（HTTP ${response.status}）`;
    // 中文注释：全局 401 广播，由 App 统一跳转登录页/设置页
    if (response.status === 401 && options.auth !== false && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { message } }));
    }
    throw new ApiError(response.status, body.code || `HTTP_${response.status}`, message, body.request_id);
  }
  return parsed as T;
}

export const api = {
  // —— 健康检查（无鉴权）——
  async health(): Promise<{ status: string }> {
    const base = loadApiBase().replace(/\/api\/v1\/?$/, "");
    const response = await fetch(`${base}/health`);
    if (!response.ok) throw new ApiError(response.status, "HEALTH_FAILED", "后端健康检查失败");
    return response.json();
  },

  // —— 登录会话 / 用户 ——
  /** 用户名密码登录，成功后由调用方 saveSessionToken 保存 token */
  login(payload: { username: string; password: string }): Promise<LoginResult> {
    return request("/auth/login", { method: "POST", body: payload, auth: false });
  },

  /** 退出登录：服务端吊销当前用户全部会话 */
  logout(): Promise<{ status: string }> {
    return request("/auth/logout", { method: "POST", body: {} });
  },

  /** 当前鉴权身份与角色 */
  me(): Promise<MeResult> {
    return request("/auth/me");
  },

  /** 创建用户（admin） */
  createUser(payload: { username: string; password: string; role: UserRole }): Promise<{ id: string; username: string; role: UserRole }> {
    return request("/users", { method: "POST", body: payload });
  },

  /** 用户列表（admin） */
  listUsers(): Promise<{ items: UserItem[] }> {
    return request("/users");
  },

  // —— 标签 ——
  listTags(q?: string): Promise<{ items: TagItem[] }> {
    return request("/tags", { params: { q: q || undefined } });
  },

  // —— 对象 ——
  listObjects(filters: ObjectFilters = {}): Promise<PageResponse<ObjectItem>> {
    return request("/objects", {
      params: {
        q: filters.q,
        tag: filters.tag,
        tag_ids: filters.tag_ids,
        tag_mode: filters.tag_mode,
        bucket: filters.bucket,
        name_prefix: filters.name_prefix,
        content_type: filters.content_type,
        content_type_prefix: filters.content_type_prefix,
        sha256: filters.sha256,
        ready_from: filters.ready_from,
        ready_to: filters.ready_to,
        min_size: filters.min_size ?? undefined,
        max_size: filters.max_size ?? undefined,
        sort: filters.sort,
        cursor: filters.cursor,
        limit: filters.limit,
      },
    });
  },

  getObject(objectId: string): Promise<ObjectItem> {
    return request(`/objects/${encodeURIComponent(objectId)}`);
  },

  /** 删除对象：202 = 软删受理（可恢复）；204 = 已删除（幂等重放） */
  deleteObject(objectId: string): Promise<ObjectDeleteResult | undefined> {
    return request(`/objects/${encodeURIComponent(objectId)}`, { method: "DELETE" });
  },

  /** 恢复软删对象；仅 status=deleting 可恢复 */
  restoreObject(objectId: string, reason?: string): Promise<ObjectItem> {
    return request(`/objects/${encodeURIComponent(objectId)}/restore`, {
      method: "POST",
      body: { reason: reason || null },
    });
  },

  addObjectTags(objectId: string, payload: { tag_ids?: string[]; new_tag_names?: string[] }): Promise<TagBindResult> {
    return request(`/objects/${encodeURIComponent(objectId)}/tags`, {
      method: "POST",
      body: { tag_ids: payload.tag_ids || [], new_tag_names: payload.new_tag_names || [] },
    });
  },

  removeObjectTag(objectId: string, tagId: string): Promise<void> {
    return request(`/objects/${encodeURIComponent(objectId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  },

  // —— 上传会话 ——
  createUpload(payload: {
    display_name: string;
    content_type: string;
    expected_size: number;
    purpose?: "standalone" | "document_internal";
    tag_ids?: string[];
    new_tag_names?: string[];
    /** 可选客户端声明哈希；complete 时服务端流式校验 */
    sha256?: string;
    /** 声明哈希后可选内容去重，命中同租户 ready 对象时直接复用 */
    dedup?: boolean;
  }): Promise<UploadCreated> {
    return request("/uploads", {
      method: "POST",
      idempotent: true,
      body: {
        display_name: payload.display_name,
        content_type: payload.content_type,
        expected_size: payload.expected_size,
        purpose: payload.purpose || "standalone",
        tag_ids: payload.tag_ids || [],
        new_tag_names: payload.new_tag_names || [],
        ...(payload.sha256 ? { sha256: payload.sha256, dedup: payload.dedup ?? true } : {}),
      },
    });
  },

  completeUpload(uploadId: string): Promise<ObjectItem> {
    return request(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST", body: {} });
  },

  // —— 文档类型 ——
  listDocumentTypes(): Promise<{ items: DocumentTypeItem[] }> {
    return request("/document-types");
  },

  // —— 文档采集 ——
  createIngest(payload: {
    source: string;
    external_id: string;
    doc_type: string;
    title: string;
    ingest_key: string;
    attrs?: Record<string, unknown>;
    tag_ids?: string[];
    new_tag_names?: string[];
  }): Promise<IngestCreated> {
    return request("/ingest-sessions", {
      method: "POST",
      idempotent: true,
      body: {
        source: payload.source,
        external_id: payload.external_id,
        doc_type: payload.doc_type,
        title: payload.title,
        ingest_key: payload.ingest_key,
        attrs: payload.attrs || {},
        tag_ids: payload.tag_ids || [],
        new_tag_names: payload.new_tag_names || [],
      },
    });
  },

  completeIngest(
    versionId: string,
    payload: {
      raw_object_id?: string | null;
      body_object_id?: string | null;
      assets?: AssetDraft[];
      attrs?: Record<string, unknown>;
    },
  ): Promise<DocumentItem> {
    return request(`/ingest-sessions/${encodeURIComponent(versionId)}/complete`, {
      method: "POST",
      body: {
        raw_object_id: payload.raw_object_id || null,
        body_object_id: payload.body_object_id || null,
        assets: (payload.assets || []).map((item) => ({
          object_id: item.object_id,
          role: item.role,
          ordinal: item.ordinal,
          reference_name: item.reference_name || null,
        })),
        attrs: payload.attrs || {},
      },
    });
  },

  // —— 文档 ——
  listDocuments(filters: DocumentFilters = {}): Promise<PageResponse<DocumentItem>> {
    return request("/documents", {
      params: {
        q: filters.q,
        tag: filters.tag,
        tag_ids: filters.tag_ids,
        tag_mode: filters.tag_mode,
        doc_type: filters.doc_type,
        source: filters.source,
        external_id: filters.external_id,
        created_from: filters.created_from,
        created_to: filters.created_to,
        sort: filters.sort,
        cursor: filters.cursor,
        limit: filters.limit,
      },
    });
  },

  getDocument(documentId: string): Promise<DocumentItem> {
    return request(`/documents/${encodeURIComponent(documentId)}`);
  },

  reclassifyDocument(
    documentId: string,
    payload: { doc_type: string; reason: string; attrs?: Record<string, unknown> },
  ): Promise<DocumentItem> {
    return request(`/documents/${encodeURIComponent(documentId)}/reclassify`, {
      method: "POST",
      body: {
        doc_type: payload.doc_type,
        reason: payload.reason,
        ...(payload.attrs !== undefined ? { attrs: payload.attrs } : {}),
      },
    });
  },

  listVersions(documentId: string): Promise<{ items: VersionItem[] }> {
    return request(`/documents/${encodeURIComponent(documentId)}/versions`);
  },

  addDocumentTags(documentId: string, payload: { tag_ids?: string[]; new_tag_names?: string[] }): Promise<TagBindResult> {
    return request(`/documents/${encodeURIComponent(documentId)}/tags`, {
      method: "POST",
      body: { tag_ids: payload.tag_ids || [], new_tag_names: payload.new_tag_names || [] },
    });
  },

  removeDocumentTag(documentId: string, tagId: string): Promise<void> {
    return request(`/documents/${encodeURIComponent(documentId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  },

  // —— 统计 ——
  objectStats(): Promise<ObjectStatsOverview> {
    return request("/stats/overview");
  },

  bucketStats(): Promise<BucketStatsResponse> {
    return request("/stats/buckets");
  },

  dailyStats(days = 30): Promise<DailyStatsResponse> {
    return request("/stats/daily", { params: { days } });
  },

  documentStats(): Promise<DocumentStatsOverview> {
    return request("/document-stats/overview");
  },

  // —— 后台任务 ——
  listJobs(filters: { status?: string; kind?: string; cursor?: string | null; limit?: number } = {}): Promise<PageResponse<JobItem>> {
    return request("/jobs", {
      params: { status: filters.status, kind: filters.kind, cursor: filters.cursor, limit: filters.limit },
    });
  },

  retryJob(jobId: string): Promise<JobRetryResult> {
    return request(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", body: {} });
  },

  // —— 文档/版本删除与恢复 ——
  /** 删除文档：202 = 软删受理（进回收站）；204 = 已删除（幂等重放） */
  deleteDocument(documentId: string): Promise<DocumentDeleteResult | undefined> {
    return request(`/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
  },

  /** 恢复软删文档 */
  restoreDocument(documentId: string, reason?: string): Promise<DocumentItem> {
    return request(`/documents/${encodeURIComponent(documentId)}/restore`, {
      method: "POST",
      body: { reason: reason || null },
    });
  },

  /** 删除版本：202 = 软删受理；当前版本会被拒绝（409） */
  deleteVersion(documentId: string, versionNo: number): Promise<VersionDeleteResult> {
    return request(`/documents/${encodeURIComponent(documentId)}/versions/${versionNo}`, { method: "DELETE" });
  },

  /** 恢复软删版本 */
  restoreVersion(documentId: string, versionNo: number, reason?: string): Promise<VersionItem> {
    return request(`/documents/${encodeURIComponent(documentId)}/versions/${versionNo}/restore`, {
      method: "POST",
      body: { reason: reason || null },
    });
  },

  // —— 回收站 ——
  listTrashDocuments(filters: { cursor?: string | null; limit?: number } = {}): Promise<PageResponse<TrashDocumentItem>> {
    return request("/trash/documents", {
      params: { cursor: filters.cursor, limit: filters.limit },
    });
  },

  /** 立即永久删除回收站文档（跳过恢复窗口，不可恢复） */
  purgeTrashDocument(documentId: string): Promise<PurgeResult> {
    return request(`/trash/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
  },

  listTrashObjects(filters: { cursor?: string | null; limit?: number } = {}): Promise<PageResponse<TrashObjectItem>> {
    return request("/trash/objects", {
      params: { cursor: filters.cursor, limit: filters.limit },
    });
  },

  /** 立即永久删除回收站对象（跳过恢复窗口，字节排队清除） */
  purgeTrashObject(objectId: string): Promise<PurgeResult> {
    return request(`/trash/objects/${encodeURIComponent(objectId)}`, { method: "DELETE" });
  },

  // —— 批量操作（文档）——
  bulkTagDocuments(payload: { target_ids: string[]; tag_ids?: string[]; new_tag_names?: string[] }): Promise<BulkTagResult> {
    return request("/documents/bulk-tag", {
      method: "POST",
      body: {
        target_ids: payload.target_ids,
        tag_ids: payload.tag_ids || [],
        new_tag_names: payload.new_tag_names || [],
      },
    });
  },

  bulkDeleteDocuments(payload: { target_ids: string[] }): Promise<BulkDeleteResult> {
    return request("/documents/bulk-delete", {
      method: "POST",
      body: { target_ids: payload.target_ids },
    });
  },

  // —— 分享链接 ——
  createShareLink(payload: {
    target_type: ShareTargetType;
    target_id: string;
    permission: SharePermission;
    expires_in_seconds: number;
  }): Promise<ShareLinkCreated> {
    return request("/share-links", {
      method: "POST",
      idempotent: true,
      body: {
        target_type: payload.target_type,
        target_id: payload.target_id,
        permission: payload.permission,
        expires_in_seconds: payload.expires_in_seconds,
      },
    });
  },

  listShareLinks(): Promise<{ items: ShareLinkItem[] }> {
    return request("/share-links");
  },

  revokeShareLink(linkId: string): Promise<void> {
    return request(`/share-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
  },

  /** 公开分享元信息（免鉴权） */
  getPublicShare(token: string): Promise<{
    target_type: ShareTargetType;
    permission: SharePermission;
    title?: string;
    doc_type?: string;
    display_name?: string;
    content_type?: string;
    size_bytes?: number | null;
    created_at?: string;
    expires_at: string;
  }> {
    return request(`/public/share/${encodeURIComponent(token)}`, { auth: false });
  },

  /** 公开分享下载 URL（免鉴权，仅 permission=download） */
  publicShareDownloadUrl(token: string): Promise<{ url: string; expires_in: number; display_name: string }> {
    return request(`/public/share/${encodeURIComponent(token)}/download-url`, { method: "POST", body: {}, auth: false });
  },

  // —— 审计流水 ——
  listTypeChanges(filters: { document_id?: string; cursor?: string | null; limit?: number } = {}): Promise<PageResponse<TypeChangeItem>> {
    return request("/audit/type-changes", {
      params: { document_id: filters.document_id, cursor: filters.cursor, limit: filters.limit },
    });
  },

  listAuditEvents(filters: { event_kind?: string; target_id?: string; cursor?: string | null; limit?: number } = {}): Promise<PageResponse<AuditEventItem>> {
    return request("/audit/events", {
      params: { event_kind: filters.event_kind, target_id: filters.target_id, cursor: filters.cursor, limit: filters.limit },
    });
  },

  // —— 保留策略 ——
  getRetentionPolicy(): Promise<RetentionPolicy> {
    return request("/retention-policy");
  },

  putRetentionPolicy(payload: RetentionPolicy): Promise<RetentionPolicy> {
    return request("/retention-policy", {
      method: "PUT",
      body: {
        orphan_object_grace_hours: payload.orphan_object_grace_hours,
        staging_retry_grace_seconds: payload.staging_retry_grace_seconds,
        staging_retry_max_attempts: payload.staging_retry_max_attempts,
        version_retention: payload.version_retention,
        version_retention_n: payload.version_retention_n,
        deleted_object_purge_days: payload.deleted_object_purge_days,
        deleted_document_purge_days: payload.deleted_document_purge_days,
      },
    });
  },

  // —— 运维 ——
  triggerReconcile(): Promise<ReconcileResult> {
    return request("/ops/reconcile", { method: "POST", body: {} });
  },

  // —— 签名 URL ——
  /** 独立对象下载/预览；document_internal 必须带 document_id */
  objectDownloadUrl(
    objectId: string,
    opts: { document_id?: string; version_no?: number; disposition?: "inline" | "attachment"; ttl_seconds?: number } = {},
  ): Promise<SignedUrl> {
    return request(`/objects/${encodeURIComponent(objectId)}/download-url`, {
      method: "POST",
      body: {
        document_id: opts.document_id ?? null,
        version_no: opts.version_no ?? null,
        disposition: opts.disposition || "attachment",
        ttl_seconds: opts.ttl_seconds ?? null,
      },
    });
  },

  /** 文档内部对象下载主路径（raw / body / 附件） */
  documentObjectDownloadUrl(
    documentId: string,
    versionNo: number,
    objectId: string,
    opts: { disposition?: "inline" | "attachment"; ttl_seconds?: number } = {},
  ): Promise<SignedUrl> {
    return request(
      `/documents/${encodeURIComponent(documentId)}/versions/${versionNo}/objects/${encodeURIComponent(objectId)}/download-url`,
      {
        method: "POST",
        body: {
          disposition: opts.disposition || "attachment",
          ttl_seconds: opts.ttl_seconds ?? null,
        },
      },
    );
  },

  downloadUrl(objectId: string): Promise<SignedUrl> {
    return this.objectDownloadUrl(objectId);
  },
};

/** 统计导出视图 */
export type StatsExportView = "overview" | "buckets" | "daily";

/**
 * 拉取服务端 CSV（UTF-8 BOM）并触发浏览器下载。
 * 签名 URL 不入日志；此处返回文件名便于调用方提示。
 */
export async function downloadStatsCsv(view: StatsExportView, days = 30): Promise<string> {
  const authHeaders = buildAuthHeaders();
  if (!authHeaders) {
    throw new ApiError(401, "MISSING_CREDENTIALS", "尚未登录且未配置 X-API-Key，请先登录或在设置页填写");
  }
  const headers: Record<string, string> = { ...authHeaders };
  const actorId = loadActorId();
  if (actorId && !authHeaders.Authorization) headers["X-Actor-Id"] = actorId;

  let response: Response;
  try {
    response = await fetch(buildUrl(`/stats/export.csv`, { view, days }), { method: "GET", headers });
  } catch (networkError) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      `无法连接后端服务：${networkError instanceof Error ? networkError.message : String(networkError)}`,
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Partial<{ code: string; message: string; request_id: string }>;
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { message: body.message } }));
    }
    throw new ApiError(response.status, body.code || `HTTP_${response.status}`, body.message || `导出失败（HTTP ${response.status}）`, body.request_id);
  }
  const blob = await response.blob();
  const filename = `stats-${view}.csv`;
  triggerBrowserDownload(blob, filename);
  return filename;
}

/** 客户端小表 CSV：UTF-8 BOM + RFC4180 转义，便于 Excel 直接打开 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const escapeCell = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "﻿" + rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

/** 触发浏览器保存对话框 */
export function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 中文注释：延迟释放，避免部分浏览器尚未开始下载就失效
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

/** 从 CSV 文本生成 Blob 并下载（配合 toCsv） */
export function downloadCsvText(csvText: string, filename: string) {
  triggerBrowserDownload(new Blob([csvText], { type: "text/csv;charset=utf-8" }), filename);
}

/**
 * 中文注释：直传文件到 MinIO 预签名 URL（仅可写 staging key）。
 * 用 XHR 而非 fetch，以获取真实的 upload.onuploadprogress 进度；不把 multipart ETag 当作 SHA-256。
 */
export function putToPresignedUrl(
  uploadUrl: string,
  file: File | Blob,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        const detail = (xhr.responseText || "").slice(0, 200);
        reject(new ApiError(xhr.status, "UPLOAD_REJECTED", `对象存储拒绝上传（HTTP ${xhr.status}）${detail ? `：${detail}` : ""}`));
      }
    };
    xhr.onerror = () =>
      reject(
        new ApiError(
          0,
          "UPLOAD_NETWORK_ERROR",
          "直传对象存储失败：网络错误。请检查 MinIO 地址与浏览器 CORS 配置。",
        ),
      );
    xhr.onabort = () => reject(new ApiError(0, "UPLOAD_ABORTED", "上传已取消"));
    try {
      xhr.send(file);
    } catch (error) {
      reject(new ApiError(0, "UPLOAD_NETWORK_ERROR", `直传对象存储失败：${error instanceof Error ? error.message : String(error)}`));
    }
  });
}
