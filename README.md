# Object + Document Store v8

[实现] FastAPI + PostgreSQL 17 + MinIO 的对象与文档版本存储服务，附 React 18 控制台。对象字节存 MinIO、目录与版本关系存 PostgreSQL；独立 Worker 处理删除、上传收尾与对账。接口文档见 `http://localhost:3000/docs`。

## 目录

- [启动](#启动)
- [数据库迁移](#数据库迁移)
- [备份与恢复](#备份与恢复)
- [弱凭据防护](#弱凭据防护)
- [TLS](#tls)
- [保留策略](#保留策略)
- [鉴权与操作者](#鉴权与操作者)
- [健康检查与可观测](#健康检查与可观测)
- [测试](#测试)
- [端点附录](#端点附录)
- [已知边界](#已知边界)

---

## 启动

### 生产 / Linux 一键启停

1. [操作] 复制 `.env.example` 为 `.env`，**必须**修改全部密码与 `API_KEYS_JSON`。若客户端不在部署机上，把 `MINIO_PUBLIC_ENDPOINT` 改为客户端可访问的 MinIO 地址（浏览器直传依赖该地址）。
2. [操作] `sh scripts/start.sh` —— 启动 PostgreSQL + MinIO + minio-init + API + Worker + Web（前端 18000、API 3000、MinIO 9000/9001）。
3. [操作] `sh scripts/stop.sh` —— 停止并清理孤儿容器。
4. [操作] 就绪探针：`curl -f http://localhost:3000/health/ready`（DB + bucket 双检查）。

### 本地开发

```bash
# 后端（SQLite 可跑单测；连真实栈需 PostgreSQL + MinIO）
pip install -e ".[test]"
python -m pytest -q

# 前端
cd frontend && npm ci && npm run dev   # http://localhost:18000
```

[设计] Compose 中的 MinIO 为单实例开发部署；API 与 Worker 可无状态扩容。生产可将 `MINIO_ENDPOINT` 指向已有分布式 MinIO 集群，并单独配置 PostgreSQL 高可用、备份与密钥管理。

## 数据库迁移

[实现] Alembic 管理表结构：`0001_baseline.py` 建 12 张基础表，`0002_identity_share_retention.py` 补身份/分享/软删列（`users` / `user_sessions` / `share_links` / `deleted_reason` / `purge_after` 等），`0003_purged_at.py` 补永久清除完成标记 `purged_at`（`objects` / `documents` / `document_versions`）。API 启动时 `run_migrations()` 自动执行：`postgresql://` 走 `alembic upgrade head` + 补种子 `document_types`；其余（SQLite 演示/单测）退回 `create_all`。

| 场景 | 操作 |
| --- | --- |
| 全新库 | 启动 API 自动迁移；或手动 `sh scripts/migrate.sh`（= `alembic upgrade head`） |
| **已有库**（此前用 `create_all` 建表） | 先 `sh scripts/migrate.sh stamp` 标记为最新（0001 范围），再 `upgrade` 补 0002/0003 |
| 后续变更 | `alembic revision --autogenerate -m "..."` 后人工审阅再 upgrade |

[限制] 旧的 `create_all` 兜底**只补表、不补列**。若存量库比当前模型旧且未走 Alembic，直接升级镜像会因缺列报 UndefinedColumn。迁移前可手工补列后再启动，例如：

```sql
-- 中文注释：示例——按模型补齐存量库缺失列（幂等，可重复执行）
BEGIN;
ALTER TABLE objects           ADD COLUMN IF NOT EXISTS sha256            VARCHAR(64);
ALTER TABLE objects           ADD COLUMN IF NOT EXISTS deleted_reason    VARCHAR(32);
ALTER TABLE upload_sessions   ADD COLUMN IF NOT EXISTS declared_sha256   VARCHAR(64);
ALTER TABLE upload_sessions   ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);
ALTER TABLE upload_sessions   ADD COLUMN IF NOT EXISTS copy_attempts     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_sessions   ADD COLUMN IF NOT EXISTS last_copy_error   VARCHAR(1000);
ALTER TABLE documents         ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;
ALTER TABLE documents         ADD COLUMN IF NOT EXISTS purge_after       TIMESTAMPTZ;
ALTER TABLE documents         ADD COLUMN IF NOT EXISTS purged_at         TIMESTAMPTZ;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS upload_plan       JSON;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS purge_after       TIMESTAMPTZ;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS purged_at         TIMESTAMPTZ;
ALTER TABLE objects           ADD COLUMN IF NOT EXISTS purge_after       TIMESTAMPTZ;
ALTER TABLE objects           ADD COLUMN IF NOT EXISTS purged_at         TIMESTAMPTZ;
COMMIT;
```

补列后再启动（`create_all` 会补上 `idempotency_records` / `outbox_events` / `tenant_settings`），最后 `alembic stamp head` 对齐版本。

[依据] SQLite 单测继续走 `Base.metadata.create_all`，不经过 Alembic；PostgreSQL 生产库务必走迁移。

## 凭据轮换（重要）

[教训] **PostgreSQL 与 MinIO 的凭据只在数据卷首次初始化时生效**。之后只改 `.env` 不会改变已有实例的口令，新容器会用新口令去连旧实例 → 认证失败。

| 组件 | 轮换方式 |
| --- | --- |
| PostgreSQL | `psql -U objectstore -d objectstore -c "ALTER USER objectstore WITH PASSWORD '...';"`（保留数据） |
| MinIO root | `docker compose up -d --force-recreate minio` 让其读新 `.env`；对象数据在卷中不受影响 |
| MinIO 应用账号 | 重跑 `minio-init` 逻辑（`mc admin user add/update` + `policy attach`） |

[操作] `minio-init` 依赖镜像 `minio/mc`。若 registry 拉不到，可在 minio 容器内用自带的 `/usr/bin/mc` 执行等价命令（注意 Windows 下 `docker exec` 需 `MSYS_NO_PATHCONV=1` 防止路径被改写）。

## 备份与恢复

```bash
# 备份：pg_dump -Fc + mc mirror 对象 + sha256 清单 backup-manifest.json
sh scripts/backup.sh /path/to/backup-dir

# 恢复：先校验清单，再 pg_restore，再 mc mirror 回 MinIO，最后只读对账
sh scripts/restore.sh /path/to/backup-dir

# 演练：备份 + 清单校验 + 恢复到临时库/桶，实测 RTO 并输出 JSON 报告
sh scripts/backup-drill.sh
```

[实现] `backup-manifest.json` 内路径相对于备份目录，便于异地搬迁后校验。恢复后执行一次 `POST /api/v1/ops/reconcile` 或等待 Worker 周期对账，确认目录与字节一致。

### RPO / RTO

| 指标 | 定义 | 本项目取值 | 依据 |
| --- | --- | --- | --- |
| RPO（恢复点目标） | 最大可接受数据丢失窗口 | = 备份调度间隔（例如每日备份 → RPO 24h；建议生产每小时） | [事实] 无 WAL 归档/连续复制，恢复点即最近一次成功备份 |
| RTO（恢复目标） | 从故障到可服务的时长 | 实测值见演练报告 `var/reports/backup-drill-*.json` 的 `rto_seconds` | [代码依据] `scripts/backup-drill.sh` 计时 pg_restore + mc mirror |

[操作] RPO 由备份周期决定：把 `backup.sh` 挂到 cron（建议 `17 * * * *` 每小时，避开整点），并在异地保存最近 N 份备份。RTO 需每季度演练一次：

```bash
# 中文注释：演练前先在临时库建空库；演练后清理
createdb objectstore_drill
sh scripts/backup-drill.sh
dropdb objectstore_drill
```

[限制] 演练恢复到 `DRILL_PGDB`（默认 `objectstore_drill`）与 `DRILL_BUCKET`（默认 `objects-drill`），不会覆盖生产数据；MinIO 需有 `mc` 客户端与只读演练权限。[不确定] 实际 RTO 取决于数据量与磁盘，上表不承诺固定数值，以演练报告为准。

## 弱凭据防护

[实现] `scripts/start.sh` 启动前 grep 拒绝弱值（`change-me` / `dev-key` / `minioadmin` / 空密码）：

- 本地调试逃生：`ALLOW_INSECURE=1 sh scripts/start.sh`
- `ENVIRONMENT=prod` 时应用启动即失败（`app/config.py` 校验），不能靠脚本绕过

[操作] MinIO 分为 ROOT 与 APP 两套账号：ROOT 仅供 `minio-init` 一次性建用户与策略；API / Worker 只持有 `MINIO_APP_*` 应用凭据。MinIO 控制台端口仅绑定 `127.0.0.1`。

## TLS

[实现] TLS **默认关闭**，由反向代理（nginx）终止。相关配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TLS_ENABLED` | `false` | 由编排层消费，应用本身只读 HTTP |
| `FORCE_HTTPS` | `false` | 是否强制 301 到 https |
| `MINIO_SECURE` | `false` | MinIO 客户端是否走 TLS |
| `PUBLIC_BASE_URL` | `http://localhost:18000` | 对外基址（生成链接用） |

[操作] 本地验证自签证书：

```bash
sh scripts/gen-certs.sh          # 生成 certs/fullchain.pem + privkey.pem
TLS_ENABLED=true sh scripts/start.sh
curl -k https://localhost:18443/health
```

[设计] 生产环境在反代终止 TLS，应用继续监听内网 HTTP；证书续期与 HSTS 策略由反代负责。

## 保留策略

[实现] `GET/PUT /api/v1/retention-policy` 保存于 `tenant_settings`，控制台「设置 → 保留策略」可改。**保留策略由 Worker 执行**：软删进入回收站，到期自动永久清除；版本策略由 `prune_versions` 任务执行。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `orphan_object_grace_hours` | 72 | `document_internal` 对象就绪满 N 小时且无未永久清除版本引用才回收 |
| `staging_retry_grace_seconds` | 86400 | 上传收尾失败后 staging 字节保留时长 |
| `staging_retry_max_attempts` | 10 | `finalize_upload` 任务最大尝试次数 |
| `version_retention` | `keep_all` | 版本保留：`keep_all` / `keep_last_n` / `keep_current_only` |
| `version_retention_n` | 10 | `keep_last_n` 时保留的版本数（含当前版本） |
| `deleted_object_purge_days` | 7 | 已删对象字节清理延迟天数（0 = 立即永久删除） |
| `deleted_document_purge_days` | 7 | 已删文档永久清除延迟天数（0 = 立即） |

[语义] 删除默认为**软删**：对象/文档进回收站（`GET /api/v1/trash/documents`、`GET /api/v1/trash/objects`），窗口内 `POST .../restore` 可恢复并取消清除任务；`purge_after` 到期后 Worker 永久清除字节并写审计事件，同时落 `purged_at`。恢复接口对已永久清除（`purged_at` 非空）、无恢复窗口（策略 0 天，`purge_after` 为空）或已过窗口的目标返回 409；回收站列表只含「已软删且未永久清除」的条目。

[语义] 文档身份槽位 `(source, external_id)`：**软删期间仍占用**（同 ID 重采集 409，请先恢复或永久删除）；**永久清除后释放**（`external_id` 改写为 `…#purged-<hex>`，原值存 `attrs.purged_external_id` 供审计），同一外部文档可作为新文档重新采集。

## 鉴权与操作者

[实现] 两种鉴权方式，均按请求解析租户：

1. **API Key**（服务间调用）：`X-API-Key`，一个 Key 映射一个租户。`API_KEYS_JSON` 值可为字符串或对象：

```json
{
  "prod-key-1": "tenant-a",
  "prod-key-2": {"tenant_id": "tenant-b", "actor_id": "alice"}
}
```

2. **登录会话**（控制台）：`POST /api/v1/auth/login` 换取 Bearer token（`Authorization: Bearer <token>`，服务端仅存 SHA-256 摘要）。用户经 `POST /api/v1/users` 创建，角色 `admin`（可写）/ `viewer`（只读，写操作 403）；`POST /api/v1/auth/logout` 使会话失效。

- 字符串形态的 API Key actor 默认 `tenant-default`。
- 可选请求头 `X-Actor-Id`（`^[A-Za-z0-9._@-]{1,64}$`）覆盖审计操作者，仅当 `ALLOW_ACTOR_OVERRIDE=true`；默认关闭，携带即 403。
- 审计流水（`document_type_changes` / `outbox_events`）记录 `auth.actor_id`，不再由密钥哈希派生。

### 分享链接

[实现] `POST /api/v1/share-links` 为对象/文档创建独立可撤销链接（`view`/`download` 权限，`expires_in_seconds` 过期），公开端点 `GET /api/v1/public/share/{token}` 与 `POST .../download-url` 无需 API Key；`DELETE /api/v1/share-links/{id}` 撤销后公开访问立即 404。

[破坏性] `document_internal` 对象下载/预览**必须**携带 `document_id`（可选 `version_no`）走 `POST /objects/{id}/download-url`，或直接走 `POST /documents/{id}/versions/{no}/objects/{obj}/download-url`；否则返回 403。控制台已改走文档侧端点。

## 健康检查与可观测

| 端点 | 语义 |
| --- | --- |
| `GET /health` `GET /health/live` | 存活探针，静态 `{"status":"ok"}` |
| `GET /health/ready` | 就绪探针 = `SELECT 1` + `ensure_bucket`，失败 503 带 checks |
| `GET /metrics` | Prometheus 文本：`http_requests_total` / `http_request_duration_ms_*` / `jobs_queue_depth` / `objects_total` / `documents_total` / `trash_items` |

[实现] 请求计数为**进程内计数**（重启清零，无直方图分位数），多实例需 Prometheus 抓取后聚合；`jobs_queue_depth` / `objects_total` / `documents_total` / `trash_items` 为**库侧实时 gauge**，重启不丢。生产告警另依赖 Worker 的死信/积压/卡死检查（每 300s，经 `ALERT_WEBHOOK_URL` 推送）。

[实现] 访问日志为 JSON（`ts/level/logger/msg/request_id/tenant_id/actor_id/path/method/status/duration_ms`），Worker 同格式。Compose 为 api/worker/web 配置 HEALTHCHECK；后端容器以非 root（uid 10001）运行。

对账：Worker 每 `reconcile_interval_seconds`（默认 3600）入队 `reconcile` 任务，产出四类发现（pending 缺字节 / ready 缺正式 / 正式孤儿 / staging 孤儿），**只告警不改状态**，出口为结构化日志 + `var/reports/reconcile-*.jsonl` + 可选 `ALERT_WEBHOOK_URL`。也可手动 `POST /api/v1/ops/reconcile`。

## 测试

```bash
python -m pytest -q                  # 50 passed, 1 skipped（SKIP LOCKED 需 PostgreSQL）
python -m ruff check app tests
cd frontend && npm test              # 预览安全单测（node --test，MIME 白名单 + zip 炸弹）
sh scripts/check.sh                  # ruff + pytest + 预览安全单测 + tsc + vite build 一键

# 真实栈集成冒烟（需 Compose 栈已启动）
python tests/integration_smoke.py

# SKIP LOCKED 并发语义（需 TEST_DATABASE_URL 指向 PostgreSQL）
TEST_DATABASE_URL=postgresql://... python -m pytest -q -m pg
```

[依据] 集成冒烟已在 Compose 栈执行通过；详见 [TEST_REPORT_v2.md](TEST_REPORT_v2.md)。

[依据] 详见 [TEST_REPORT_v2.md](TEST_REPORT_v2.md)。

## 端点附录

### 删除与回收

| 方法 路径 | 语义 |
| --- | --- |
| `DELETE /api/v1/objects/{id}` | 软删独立对象（202，进回收站窗口）；已删幂等 204；被文档引用 409 |
| `POST /api/v1/objects/{id}/restore` | 窗口内恢复软删对象；已永久清除 409 |
| `DELETE /api/v1/documents/{id}/versions/{no}` | 软删版本（202）；当前版本 409 |
| `POST /api/v1/documents/{id}/versions/{no}/restore` | 恢复软删版本 |
| `DELETE /api/v1/documents/{id}` | 软删文档（202）+ 入队 `purge_document`（到期清除）；已删幂等 204；有 staging 版本 409 |
| `POST /api/v1/documents/{id}/restore` | 窗口内恢复文档并取消清除任务 |
| `GET /api/v1/trash/documents` | 回收站列表（软删未清除文档） |
| `DELETE /api/v1/trash/documents/{id}` | 跳过窗口立即请求永久清除 |
| `GET /api/v1/trash/objects` | 回收站列表（软删未清除独立对象） |
| `DELETE /api/v1/trash/objects/{id}` | 跳过窗口立即请求永久清除对象字节 |
| （Worker）`reclaim_orphans` | `document_internal` 就绪满宽限且无未永久清除版本引用 → 软删 + delete job |

### 批量与分享

| 方法 路径 | 语义 |
| --- | --- |
| `POST /api/v1/documents/bulk-tag` | 批量打标签，返回 `items[]` 逐条状态 |
| `POST /api/v1/documents/bulk-delete` | 批量软删（202），逐条状态 |
| `POST /api/v1/share-links` `GET /api/v1/share-links` `DELETE /api/v1/share-links/{id}` | 分享链接管理 |
| `GET /api/v1/public/share/{token}` `POST .../download-url` | 公开访问（无需鉴权） |

### 身份

| 方法 路径 | 语义 |
| --- | --- |
| `POST /api/v1/auth/login` `POST /api/v1/auth/logout` `GET /api/v1/auth/me` | 登录会话（Bearer） |
| `POST /api/v1/users` | 创建控制台用户（admin/viewer） |

### 审计与运维

| 方法 路径 | 语义 |
| --- | --- |
| `GET /api/v1/audit/type-changes` | 再分类审计（游标分页，`changed_at` 倒序） |
| `GET /api/v1/audit/events` | `outbox_events` 事件流水（append-only） |
| `GET /api/v1/jobs` `POST /api/v1/jobs/{id}/retry` | 任务可视与 failed/dead 复活 |
| `GET/PUT /api/v1/retention-policy` | 租户保留策略（待业务确认） |
| `POST /api/v1/ops/reconcile` | 触发对账，返回 job_id |
| `GET /api/v1/stats/export.csv` | UTF-8 BOM CSV（overview/buckets/daily） |

### 签名 URL

| 方法 路径 | 语义 |
| --- | --- |
| `POST /api/v1/objects/{id}/download-url` | body 可带 `document_id`/`version_no`/`disposition`/`ttl_seconds` |
| `POST /api/v1/documents/{id}/versions/{no}/objects/{obj}/download-url` | 文档内部对象主路径 |

[实现] `disposition=inline` 签署 `response-content-disposition=inline`（预览用，默认 attachment）；`ttl_seconds` 范围 30..3600 并夹到 `download_url_ttl_seconds` 上限内。控制台预览固定 120s。同时签署 `response-content-type` 覆盖对象侧元数据 —— 浏览器 iframe 渲染 PDF 严格看响应头 `Content-Type`，而历史对象（预签名 PUT 直传）在 MinIO 侧落的是 `application/octet-stream`。

## 内联预览支持的文件类型

[实现] 预览在**浏览器端**渲染，签名 URL 有效期 120 秒。MIME 匹配走白名单；仅当媒体类型缺失（空串或 `application/octet-stream`）时才按扩展名兜底，**扩展名永不覆盖具体 MIME**（`text/html` 即使叫 `notes.txt` 也只给下载）。

| 类型族 | MIME / 扩展名 | 渲染方式 | 上限 |
| --- | --- | --- | --- |
| 图片 | `image/*`（含 SVG） | `<img>`（SVG 不执行脚本） | 浏览器原生 |
| PDF | `application/pdf` | `<iframe>` | 浏览器原生 |
| 纯文本 | `text/plain` `text/csv` `text/markdown` `text/xml` `application/json` `application/jsonl` 等 / `.txt .log .md .csv .tsv .json .jsonl .xml` | `<pre>` 原文（UTF-8 → GB18030 → 有损兜底） | 5 MiB / 20 万字符 |
| 表格 | `…spreadsheetml.sheet`、`…sheet.macroEnabled.12` / `.xlsx` | 客户端表格（按需加载解析器） | 15 MiB / 200×50×10 表 |
| 文档 | `…wordprocessingml.document` / `.docx` | 转 HTML 后**消毒**渲染 | 10 MiB / 30 万字符 / 单图 512 KiB |

[限制] **不支持预览**（仅下载）：`text/html` / `application/xhtml+xml`（活文档，内联即 XSS）、脚本族、`.doc` / `.xls` / `.ppt` 等旧版 Office（提示「旧版格式不支持预览，请另存为 .docx / .xlsx」）、`image/tiff`、压缩归档、其余未知类型。

[限制] csv / json 显示**原文**不做结构化解析：栈里没有 RFC4180 解析器，朴素 `split(",")` 会破坏引号字段与内嵌换行；错表格比诚实的原文更糟。markdown 同理只显示源码。

[实现] 安全边界：`docx` 转换结果必须过 DOMPurify 白名单消毒后以 `DocumentFragment` 挂载，前端源码不使用任何 inner-HTML 注入通道；`.xlsx`/`.docx` 解析前做 zip 中央目录预检（不解压，累计解压体积 80 MiB 封顶）防 zip 炸弹；取字节走流式计数，超限即中止。

[限制] 解析器（`read-excel-file` / `mammoth` + `dompurify`）按需动态加载，不进主包；行/列上限约束的是 DOM 成本与渲染耗时，不是解析内存。

## 安全增强

[实现] **MIME 内容嗅探**（`app/mime_sniff.py`）：晋级时读取前 512 字节，魔数 + 文本标记嗅探，与声明不符以嗅探为准；伪装的活内容（HTML/SVG/JS 以 `text/plain` 等名义上传）降级为 `application/octet-stream`，从源头防存储型 XSS。前端预览白名单不预览 `text/html`，DOMPurify 消毒 docx 转换结果。

[实现] **CSP**：nginx 响应头 `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'self'` 等（见 `frontend/nginx*.conf`），限制注入面。

## 已知边界

- [限制] 单对象上限 1 GiB；不支持分片上传（>1 GiB 需要扩展 `uploads` 为 multipart）。
- [限制] 无全文检索 / OCR；内容哈希去重仅在**声明 sha256 + `dedup=true`** 上传路径生效（复用同租户 ready 对象），不做全库后台去重与引用计数。
- [限制] 无文档级 ACL；控制台用户分 admin/viewer 两级，租户隔离由 API Key / 会话映射。
- [限制] 统计为 PostgreSQL 实时聚合，千万级规模需改为增量汇总（3000 万装载与 p95 压测保留为验收项，本次未跑）。
- [限制] 无外部队列（Celery/Redis/Kafka）与 outbox 消费管道；`outbox_events.processed_at` 为预留字段。
- [限制] `/metrics` 为进程内计数（重启清零，无直方图）；多实例需 Prometheus 侧聚合。
- [限制] `tests/test_worker_pg.py`（`FOR UPDATE SKIP LOCKED` 并发语义）需 `TEST_DATABASE_URL`，SQLite 环境跳过。

[依据] 方案基线见 [v7 HTML](object_storage_design_v7.html)。
