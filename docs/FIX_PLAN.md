# P0-P2 修复进度清单

目标：修完 P0→P1→P2，评审后再修，直到无 P0/P1/P2 问题。

## P0
- [x] P0-1 保留策略真生效（version_retention / deleted_object_purge_days / 按租户宽限）—— Worker 执行，prune_versions + purge 任务
- [x] P0-2 软删 + 恢复窗口 + restore 接口 + 回收站 UI —— 文档/对象双回收站、恢复、立即永久删除；`purged_at` 标记永久清除完成
- [x] P0-3 标题/元数据搜索 + 排序 + 日期过滤前端暴露 —— ObjectsPage/DocumentsPage 筛选栏 + q/sort/日期

## P1
- [x] P1-4 用户身份（登录/会话/角色 admin|viewer）+ allow_actor_override 默认 False —— LoginPage + require_admin
- [x] P1-5 MIME 内容嗅探 + CSP + 前端预览自动化测试 —— 嗅探/CSP/后端测试 + `frontend/tests/preview-safety.test.ts`
- [x] P1-6 死信/队列/积压告警 + 指标补强 —— 任务健康巡检告警 + /metrics DB gauge（含 trash 计数）

## P2
- [x] P2-7 分享链接（独立实体、可撤销、可过期）—— 后端 + ShareLinkDialog
- [x] P2-8 批量操作（文档侧）+ 拖拽/文件夹上传 + 按哈希去重发现/复用 —— bulk-tag/bulk-delete + UploadObjectDialog 多文件/去重
- [x] P2-9 备份 RPO/RTO 文档化 + 演练脚本 + 迁移自动化 —— README RPO/RTO + backup-drill.sh + run_migrations()

## 复审修复（第 2 轮）
- [x] 对象回收站：`GET/DELETE /api/v1/trash/objects` + TrashPage 对象页签
- [x] `purged_at` 列（migration 0003）：Worker 永久清除落标记；回收站排除已清除；restore/purge-now 拒绝已清除
- [x] restore 语义对齐：无恢复窗口（策略 0 天 / purge_after 为空）与过期窗口一律 409
- [x] 文档永久清除连带版本落 `purged_at`，版本恢复不可再误用
- [x] Worker 任务重放幂等：已 purged 目标直接完成，不重复删字节/写 outbox
- [x] 前端恢复入口按窗口禁用（TrashPage / ObjectsPage / ObjectDetailPage / DocumentDetailPage 版本与文档）
- [x] README 迁移节补 0003_purged_at 与手工补列 SQL；回收站语义写明 purged_at

## 复审修复（第 3 轮）
- [x] 引用计数对齐 `purged_at`：软删待恢复版本继续持有对象引用（`has_document_reference` / `reclaim_orphans`），防止孤儿回收提前清掉可恢复字节
- [x] 文档永久清除不再偷走共享对象：`_run_purge_document` 对仍被其他未永久清除版本引用的对象跳过删字节
- [x] DocumentDetailPage 回收站卡片「恢复文档」按恢复窗口禁用，与后端 409 对齐
- [x] 分享链接拒绝软删/已清除/未就绪对象，避免生成必然 404 的死链
- [x] `bulk-delete` 与单删对齐：存在 staging 版本时 409 拒绝（避免留下未发布悬挂）
- [x] `keep_current_only` 版本保留补回归测试；分享链接死链补回归测试
- [x] README / retention.py 文档纠正：`orphan_object_grace_hours` 按 `ready_at` 起算宽限，非「无引用后计时」

## 复审修复（第 4 轮）
- [x] 身份槽位 `(source, external_id)`：回收站窗口内重采集 409（防止软删文档被旁路重建）；永久清除后 `release_document_identity` 改写 `external_id` 让出唯一键，原值存 `attrs.purged_external_id` 供审计，同一外部文档可重新采集
- [x] 补「软删占用槽位 / 清除后释放槽位」回归测试

## 回归
- [x] pytest 全绿（59 passed, 1 skipped）
- [x] ruff 全绿
- [x] tsc / vite build（scripts/check.sh 全绿）
- [x] 复审清单（按原缺口逐条核对）
