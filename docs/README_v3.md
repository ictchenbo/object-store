# Object + Document Store MVP v3

[实现] 基于 v7 方案的 FastAPI 服务。PostgreSQL 保存对象目录、文档版本、附件关系与标签；MinIO 保存文件字节；独立 Worker 处理异步删除和过期上传。接口文档由 FastAPI 提供。

## 启动

1. [操作] 将 `.env.example` 复制为 `.env`，修改 PostgreSQL、MinIO 密码及 `API_KEYS_JSON`。若客户端不在部署机上，将 `MINIO_PUBLIC_ENDPOINT` 改为客户端可访问的 MinIO 地址。
2. [操作] 在 Linux 上运行 `sh scripts/start.sh`；API 文档位于 `http://localhost:3000/docs`，MinIO Console 位于 `http://localhost:9001`。停止服务运行 `sh scripts/stop.sh`。
3. [操作] 本地开发依赖可用 `pip install -e ".[test]"` 安装，随后运行 `python -m pytest -q`。

[设计] Compose 中的 MinIO 为单实例开发部署；API 和 Worker 可无状态扩容。生产环境可把 `MINIO_ENDPOINT` 改为已有分布式 MinIO 集群，并单独配置 PostgreSQL 高可用、备份和密钥管理。

## API 使用顺序

1. [实现] 所有 `/api/v1` 请求携带 `X-API-Key`；一个 Key 映射到一个租户。`GET /health` 无需鉴权。
2. [实现] 调用 `POST /api/v1/uploads` 创建上传会话，提供文件名、媒体类型、预计字节数、`Idempotency-Key`，可同时提供已有标签 ID 或新标签名。客户端向返回的短时 `upload_url` 直传文件，再调用 `POST /api/v1/uploads/{id}/complete`。正式对象只由服务端复制生成。
3. [实现] 独立对象可按名称、桶、媒体类型、时间、大小和标签列出；可获取短时下载 URL。删除进入 Worker 队列。对象数、逻辑字节及每日增删量通过统计接口读取。
4. [实现] 文档采集先调用 `POST /api/v1/ingest-sessions`，为原文、正文和附件分别上传 `document_internal` 对象，再调用 `POST /api/v1/ingest-sessions/{id}/complete` 传入对象 ID 与附件角色。发布后可按稳定文档 ID、类型、标签及版本查询。重分类会追加新版本并保留审计记录。
5. [实现] `GET /api/v1/tags` 返回可复用标签；对象或文档的 `/tags` 接口支持选择已有标签或自动创建新标签。两个列表的 `tag=名称` 及 `tag_ids`、`tag_mode=all|any` 只匹配各自直接绑定的标签。

## 已验证

[测试] `tests/test_mvp.py` 的 10 个测试使用 SQLite 与 MinIO 假实现验证 API 业务流程，包括上传失败、暂存凭证重放、租户隔离、标签复用与查找、文档版本及附件、重分类、删除任务重试和过期上传恢复。`ruff check app tests` 通过，PostgreSQL 方言 DDL 可编译，Compose 配置可解析。

[测试] `tests/integration_smoke.py` 已在真实 PostgreSQL 17 + MinIO + API + Worker 的隔离 Compose 栈中通过：签名 URL 直传、对象完成、标签查找、文档发布和异步删除。还核对了真实 PostgreSQL 中的当前版本及标签关系外键。该集成测试可在 Compose 启动后用 `python tests/integration_smoke.py` 重跑。

## MVP 边界

- [限制] 已完成单次真实 PostgreSQL + MinIO 流程联调；尚未做并发压测、长时间稳定性测试与 3,000 万规模装载。
- [限制] 统计通过 PostgreSQL 实时聚合；在千万级数据上应改为事务事件与增量汇总，当前未验证目标规模性能。
- [限制] 类型校验目前只校验类型字典、对象状态和附件角色；各类型的专有必填属性、更多附件规则尚需业务清单。
- [限制] 当前仅有租户级 API Key 权限；未实现细粒度文档 ACL、正式数据库迁移、完整目录对账、PITR 演练及生产分布式 MinIO 部署。
- [限制] 上传完成核验对象存在和大小；对内容 SHA-256 的受控流式校验尚未实现，不应把该版本用于要求强字节完整性证明的场景。
- [限制] 单对象上限暂定 1 GiB；多段复制、版本/对象保留期清理和全文检索不在本次 MVP。

[依据] 方案基线见 [v7 HTML](object_storage_design_v7.html)。
