# TEST_REPORT_v2

[依据] 生成时间：2026-10-10。对应缺口修复计划阶段 1–6 全量落地后的验收记录；同日完成 Docker 真实栈部署与集成冒烟。

## 执行摘要

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 后端单元/集成测试 | `python -m pytest -q` | **43 passed, 1 skipped**（4.3s） |
| 静态检查 | `python -m ruff check app tests` | **All checks passed** |
| 前端类型检查 | `npx tsc --noEmit` | **无输出（通过）** |
| 前端构建 | `npm run build` | **✓ built in 23.5s**（1716 modules，`index-*.js` 468.27 kB / gzip 143.61 kB） |
| 脚本语法 | `sh -n scripts/*.sh` | **7 个脚本全部通过** |
| Compose 配置 | `docker compose config` | **可解析** |
| **真实栈集成冒烟** | `python tests/integration_smoke.py` | **PASS** |
| **Compose 栈健康** | `docker compose ps` | **api / worker / web / postgres / minio 全部 healthy** |

[不确定] **仍未执行**：浏览器手动回归、`-m pg`（SKIP LOCKED）用例——未提供 `TEST_DATABASE_URL`，浏览器回归需人工操作。

## 测试覆盖明细

### 业务流程（tests/test_mvp.py）

| 能力 | 覆盖 |
| --- | --- |
| 上传 / 直传 / 转正 / 删除 | ✅ staging 成功路径删除、SHA-256 落地、大小校验失败 422、幂等重放 |
| 租户隔离 | ✅ 跨 Key 访问返回 404 |
| 标签复用 / 查找 | ✅ 自动创建、前缀建议、`tag_mode=all\|any`、未知标签空列表 |
| 文档版本 / 附件 | ✅ 一次建齐 `parts`、追加版本、附件角色与 ordinal |
| 重分类 | ✅ 追加新版本、`document_type_changes` 落库、旧版本保留 |
| 过期上传恢复 | ✅ 产生 `finalize_upload` job 且 staging 保留；重试耗尽 → failed |
| 幂等契约 | ✅ `request_fingerprint` 冲突 409、相同指纹重放 |
| DELETE 语义 | ✅ 已删幂等 204、被引用 409 |
| **document_internal 下载授权** | ✅ 无文档上下文 403、错误文档 404、正确上下文 200、文档版本端点 200 |
| **预览签名 URL** | ✅ `disposition=inline` + `ttl_seconds=120`；URL 同时携带内联标记与 `response-content-type` 覆盖 |

### 阶段 3 后台能力（tests/test_mvp.py）

| 能力 | 覆盖 |
| --- | --- |
| 对账四类发现 | ✅ `pending_missing_bytes` / `ready_missing_object` / `formal_orphan` / `staging_orphan` |
| 孤儿 TTL 回收 | ✅ 无引用 `document_internal` 进入 `deleting` + delete job；软删版本不阻塞回收 |
| 版本删除指针保护 | ✅ 删当前版本 409；软删后从列表消失 |
| 文档删除 | ✅ staging 版本存在时 409；软删全版本 + 入队清理；已删幂等 204 |
| 审计只读 | ✅ type-changes / events 可查且不接受写 |
| 任务可视与复活 | ✅ 列表过滤；failed/dead → pending、attempts 清零 |
| 保留策略 | ✅ GET 默认值 + PUT 回读 |
| CSV 导出 | ✅ overview/buckets/daily 三视图，UTF-8 BOM |

### 可观测（tests/test_observability.py）

| 能力 | 覆盖 |
| --- | --- |
| 健康检查 | ✅ `/health` 与 `/health/live` 别名；`/health/ready` 双检查；bucket 故障 503 |
| 指标 | ✅ `http_requests_total` / `http_request_duration_ms_*` / `jobs_queue_depth` |
| 错误信封 | ✅ 401/403/404/422/503 的 `code` / `message` / `request_id` |

### 流式晋级适配器（tests/test_mvp.py，集成冒烟暴露后补）

| 能力 | 覆盖 |
| --- | --- |
| `GeneratorStream` 分块 read / EOF 语义 | ✅ |
| 上游生成器异常冒泡不被吞掉 | ✅ |
| `MinioStorage.put_stream` 接受裸生成器 | ✅ 复刻 minio-py 的 `getattr(data,"read")` 判定 |

### 并发（tests/test_worker_pg.py）

| 能力 | 覆盖 |
| --- | --- |
| `FOR UPDATE SKIP LOCKED` | ⚠️ 需 `TEST_DATABASE_URL`；本次 **1 skipped** |

## 前端能力验收（阶段 5–6）

### 缺陷修复（阶段 5，已在构建中验证）

| 项 | 状态 |
| --- | --- |
| 30 处 Label `htmlFor` + 控件 `id` 配对 | ✅ |
| 上传 XHR 真实进度 + 1 GiB 客户端预检 | ✅ |
| TagPicker：Enter 不误选、↑↓/Esc、listbox ARIA | ✅ |
| IngestPage：ordinal 删行重编号、`bodySetObject`→`setBodyObject` | ✅ |
| ThemeToggle 受控化 | ✅ |
| 全局 401 → 跳设置页；`X-Actor-Id` 随请求发送 | ✅ |
| 死代码清理（`getVersion` / `tabs.tsx`） | ✅ |

### 控制台能力（阶段 6，`tsc` + `vite build` 通过）

| 能力 | 文件 | 状态 |
| --- | --- | --- |
| 后台任务列表 + 失败复活 | `pages/JobsPage.tsx` | ✅ 编译通过 |
| 审计流水双视图（类型变更 / 事件） | `pages/AuditPage.tsx` | ✅ 编译通过 |
| 保留策略表单 + 「保留期待业务确认」页脚 | `pages/SettingsPage.tsx` | ✅ 编译通过 |
| 对象批量删除 / 批量打标（并发 4、上限 200、成功 N / 失败 M 含 request_id） | `pages/ObjectsPage.tsx` | ✅ 编译通过 |
| 对象预览（120s inline 签名、image/PDF 内联、其余下载） | `components/objects/ObjectPreviewDialog.tsx` | ✅ 编译通过 |
| 版本并排对比（类型快照 / attrs 键差高亮 / raw·body / 附件） | `components/documents/VersionComparePanel.tsx` | ✅ 编译通过 |
| 文档删除 / 版本删除 / 附件预览入口 | `pages/DocumentDetailPage.tsx` | ✅ 编译通过 |
| 统计 CSV 导出（服务端 `stats/export.csv` + 客户端小表 BOM） | `pages/DashboardPage.tsx` | ✅ 编译通过 |
| 路由 + 导航（jobs / audit） | `App.tsx` / `AppShell.tsx` | ✅ 编译通过 |

[推断] 「编译通过」只保证类型与打包正确，不等于浏览器行为已回归。

## 集成冒烟脚本覆盖（tests/integration_smoke.py）

[实现] 脚本在真实栈上按顺序校验：

1. 健康检查 → 直传 standalone（含 SHA-256、staging 清理）
2. 标签查找
3. 文档发布（`document_internal` body）→ 重分类 → 版本列表顺序
4. **预览签名 URL**（文档版本端点，`expires_in=120`）
5. **jobs / audit type-changes / audit events / retention-policy / ops/reconcile / stats/export.csv（BOM）**
6. 异步删除（Worker 20s 内完成）

[依据] **2026-10-10 已在 Compose 真实栈执行，结果 PASS。** 对账产物落 `var/reports/reconcile-*.jsonl`，四类发现可复现。

### 冒烟暴露并已修复的缺陷

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `complete` 500：`'generator' object has no attribute 'read'` | `MinioStorage.put_stream` 把裸生成器交给 minio-py，SDK 要求 file-like | 新增 `GeneratorStream` 适配器；`FakeStorage` 改走同一 `read()` 路径防回归；补 3 个单测 |
| 2 | 冒烟脚本 502 | `localhost` 在 Windows 优先解析到 IPv6 `::1`，该地址有别的监听者 | 脚本默认地址改 `127.0.0.1:3000` |
| 3 | 直传 `upload_url` 502 | `MINIO_PUBLIC_ENDPOINT=localhost:9000` 同上 | 改 `127.0.0.1:9000`（`.env` 与 compose 默认值） |
| 4 | worker 恒 `unhealthy` | healthcheck 用 `pgrep`，镜像（python:3.11-slim）无 procps | 改 `kill -0 1` 探测 PID 1 存活 |
| 5 | 上传 PDF 后点预览，提示「该媒体类型不支持内联预览」 | `DocumentDetailPage` 把 `undefined` 当 `contentType` 传入 `openPreview`，`previewKind` 落到 `download` 分支；版本负载也没返回 `content_type` | `version_data()` 返回 `raw/body` 的 `content_type` + `size_bytes`；`VersionItem` 补字段；两处调用点传真实类型 |
| 6 | 修完 5 后仍不渲染：iframe 收到 `application/octet-stream` | ① `put_stream` 未把 `content_type` 传给 `put_object`，正式对象被落成 octet-stream；② `download_url` 只签 `response-content-disposition`，未覆盖响应头媒体类型 | ① `put_stream` / `promote_staging` 贯通 `content_type`；② `download_url` 在 `inline` 时同时签 `response-content-type`，**对存量对象无需重传即可生效**；补 5 个单测 |

[限制] 缺陷 2/3 属本地网络环境（IPv6 监听者），非代码逻辑错误；但默认值改为 `127.0.0.1` 对 Windows/双栈主机更稳。

[依据] 缺陷 6 是**双重根因**：只修任一层都还不能预览。写入层修正后新对象元数据正确；签名层的 `response-content-type` 覆盖让已上传对象（含用户刚传的 arXiv PDF）立即可预览。已用 `mc cp --attr` 回填 2 个存量对象的 MinIO 侧 Content-Type，使 `mc stat` 与直接下载一致。

[依据] 真实栈复验（`var/verify_pdf_preview.py`）：`GET` 返回 `Content-Type: application/pdf`、`Content-Disposition: inline`、1362924 字节、magic `%PDF-1.7` → **PASS**。

## 内联预览扩展（txt / csv / json / md + xlsx + docx）

[依据] 2026-10-10 落地。范围经用户确认：文本族 + xlsx + docx，渲染精度「能看内容就行」（客户端渲染，markdown 显示原文）；**`.doc` / `.xls` 不做**，提示另存为 `.docx` / `.xlsx`。

### 构建门禁（已执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | **无输出（通过）**，并用故意制造的类型错误反证工具确实在检查 |
| 构建 | `npm run build` | **✓ built in 4.01s**（2110 modules） |
| 后端回归 | `python -m pytest -q` | **43 passed, 1 skipped**（后端零改动，防误伤） |
| 静态检查 | `python -m ruff check app tests` | **All checks passed** |

### 打包体积

| chunk | 体积 | gzip |
| --- | --- | --- |
| `index-*.js`（主包） | 484.62 kB | 149.66 kB |
| `docx-*.js`（异步） | 343.07 kB | 111.81 kB |
| `spreadsheet-*.js`（异步） | 51.90 kB | 16.79 kB |

[依据] 主包较扩展前（468.27 kB）仅 **+16.35 kB**（预览纯逻辑 + UI 组件）。`mammoth` + `dompurify` + `read-excel-file` 全部留在异步 chunk —— 曾因 `DocxPreview` 静态引入 `sanitize.ts` 导致 DOMPurify 落进主包（516 kB），改为由动态加载的 `docx.ts` 暴露 `createFragment()` 工厂后移出。[推断] 首屏不加载这两个 chunk（DevTools Network 待手测确认）。

### 新增文件

```
frontend/src/lib/preview/
  limits.ts        # 全部上限常量 + PREVIEW_TTL_SECONDS + maxBytesForKind()
  kind.ts          # normalizeMime / previewKind 白名单映射 + legacyOfficeHint()
  fetch-bytes.ts   # PreviewFetchError + fetchSignedBytes（三道尺寸防线）
  decode-text.ts   # BOM → 严格 UTF-8 → GB18030 → 有损兜底
  zip-budget.ts    # zip 中央目录预检（不解压）
  sanitize.ts      # DOMPurify 白名单配置 + sanitizeDocxHtml()
  docx.ts          # convertDocxToHtml（动态，含消毒）
  spreadsheet.ts   # parseXlsx + formatSheetCell（动态）
frontend/src/components/objects/preview/
  TextPreview.tsx / DocxPreview.tsx / SpreadsheetPreview.tsx / PreviewPlaceholder.tsx
```

### 安全设计要点

| 关注点 | 处置 |
| --- | --- |
| HTML / 脚本内联 XSS | MIME 白名单 `Set`，**禁止** `startsWith("text/")`；`text/html` 恒为 download |
| 扩展名绕过 | 仅当 MIME 为 `""`/`application/octet-stream` 时才按扩展名兜底；具体 MIME 永不看文件名 |
| **现存 XSS 洞**（本次一并修） | `ObjectPreviewDialog` 旧版只要签发过 URL 就显示「新窗口打开」，SVG 顶层导航会执行 `<script>`、HTML 直接是活文档。现改为：`download` 不调 `resolveUrl`，SVG 与 download 不给该按钮 |
| docx → HTML | mammoth 明确**不做消毒**，DOMPurify 白名单 + `FORBID_CONTENTS` 是唯一屏障；`RETURN_DOM_FRAGMENT` + `replaceChildren`，前端源码 `dangerouslySetInnerHTML\|innerHTML` **grep 为空** |
| DOMPurify 绕过面 | 刻意不用 `IN_PLACE` / `ADD_TAGS`·`ADD_ATTR` 函数形式 / `USE_PROFILES` / `CUSTOM_ELEMENT_HANDLING` / `SAFE_FOR_TEMPLATES`（均为历史公告重灾区）；禁 `id`/`name`（DOM clobbering）、`style`（CSS 外带）、`target`（反向 tabnabbing） |
| zip 炸弹 | 字节上限拦不住（2 MB zip 可解压到数 GB）；解析前读 zip 中央目录累加 `uncompressedSize`，**不解压**，80 MiB 封顶 |
| 签名 URL 泄露 | 错误消息只由状态码与字节数拼成，不插值 URL，不透传原始 fetch rejection |
| Cookie CSRF | `fetch` 用 `credentials: "omit"`，签名在 query 里，不带 cookie |

### 依赖选型（已查 GitHub Advisory API）

| 包 | 版本 | 结论 |
| --- | --- | --- |
| `xlsx`（SheetJS） | 0.18.5 | **禁用**。CVE-2023-30533 原型污染 + CVE-2024-22363 ReDoS（均 high），修复版从未发到 npm |
| `read-excel-file` | 9.3.12 | **采用**。零漏洞，MIT，`./browser` 导出 |
| `mammoth` | 1.13.0 | **采用**。目录穿越 CVE-2025-11849 已在 1.11.0 修；自带 `lib/index.d.ts`（无需 ambient 声明） |
| `dompurify` | 3.4.16 | **采用**。零依赖，自带类型 |

[依据] 已验证 `DEFAULT_DATA_URI_TAGS` 含 `img`，DOMPurify 放行 `img src="data:…"`（mammoth 内嵌图必需）；`<a href="data:text/html:…">` 不在白名单内被拦。

### 纯逻辑行为冒烟（已执行，Node + esbuild）

[依据] 这三处是安全与正确性关键，超出「tsc 通过」的覆盖范围，故用 Node 直接跑纯函数。

| 模块 | 用例数 | 结果 |
| --- | --- | --- |
| `kind.ts` MIME 白名单映射 | 34 | **全通过** |
| `decode-text.ts` 编码阶梯与截断 | 16 | **全通过** |
| `zip-budget.ts` 解压预算预检 | 11 | **全通过** |

`kind.ts` 关键用例：`text/html` 改名 `notes.txt` 仍 download；`application/octet-stream` + `evil.html` 扩展名兜底仍 download；`text/plain` + `evil.html` 走文本（MIME 优先于名字，React 转义所以安全）；`application/pdf; charset=binary` 归一化后命中 pdf；SVG 禁「新窗口打开」而 PNG/PDF 允许。

`decode-text.ts` 关键用例：UTF-8 / UTF-8-BOM（剥除）/ UTF-16LE / UTF-16BE / GB18030 中文均正确；截断切在行边界（末行完整）。[依据] 字节 `0x81×6` 被 GB18030 解成「亖亖亖」—— 阶梯终止在 gb18030，印证「GB18030 几乎能解任意字节序列，阶梯必然终止」；`binary-fallback` 是极少触发的最后兜底。

`zip-budget.ts` 关键用例：500 MiB 声明抛 `ZipBudgetError`（非格式错）；**恰好 80 MiB 通过、80 MiB+1 拒绝**（边界用 `>` 不是 `>=`）；ZIP64 占位拒绝；非 zip / 空 / 截断抛 `ZipFormatError`；与 Python `zipfile` 的条目数与字节数一致。

### 冒烟暴露并已修复的缺陷

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 7 | `.xlsm` 预期 `sheet` 实得 `download` | MIME 集合里写规范拼写 `macroEnabled`（大写 E），而 `normalizeMime()` 会小写化输入 → 永不命中 | 集合一律存小写（`macroenabled.12`），注释写明「MIME 大小写不敏感」；补全大写输入用例 |
| 8 | 主包 516 kB（预期 ~470） | `DocxPreview` 静态引入 `sanitize.ts` → `dompurify` 落进主包 | 消毒移到动态加载的 `docx.ts`，以 `createFragment()` 工厂暴露（同时避免 Fragment 被 `replaceChildren` 消费后复用空节点）；主包回到 484.59 kB |
| 9 | 判别联合无法窄化，`state.payload.result` 报 TS2339 | `{ kind: "image" \| "pdf" }` 合并成一个成员，两个字面量共用导致假分支排不掉它 | 拆成 `image` / `pdf` 两个成员；闭包处抽 `newWindowUrl` 常量（窄化不穿透闭包） |

[教训] 缺陷 7 是**大小写归一化不一致**：比较前小写化了输入，却在查找表里存了非小写键。这类 bug 只在特定输入（`.xlsm`）上暴露，`tsc` 与主流程手测都拦不住。

## 浏览器手动回归清单（待执行）

| # | 场景 | 预期 |
| --- | --- | --- |
| 1 | 上传 >1 GiB 文件 | 客户端拦截，不发起请求 |
| 2 | 上传过程中取消/关闭对话框 | 上传中禁止关闭 |
| 3 | TagPicker 输入后按 Enter（未高亮） | 创建新标签，不误选首条建议 |
| 4 | 主题切换 | 图标与 `class` 同步（light/dark/system） |
| 5 | 断开后端后发请求 | toast + 跳转设置页 |
| 6 | 对象列表批量删除 | jobs 页可见 `delete_object` 任务；汇总「成功 N / 失败 M」 |
| 7 | 预览 PNG / PDF | `<img>` / `<iframe>` 内联显示；HTML 类型提示下载 |
| 8 | 版本对比 | 差异键高亮；可交换左右 |
| 9 | 审计页筛选再分类记录 | 出现对应 `type-changes` 行 |
| 10 | CSV 导出后用 Excel 打开 | 中文不乱码（BOM 生效） |

### 内联预览扩展专项（从 ObjectsPage / ObjectDetailPage / DocumentDetailPage **三个入口各走一遍**）

| # | 场景 | 预期 |
| --- | --- | --- |
| P1 | `.txt`(UTF-8) / `.md` / `.json` / `.jsonl` / `.csv` | 等宽原文；顶部显示编码标签 |
| P2 | `text/html` 对象 | **仅下载**占位面板；Network 里**无对象 GET** |
| P3 | `.doc` / `.xls` | 占位面板显示「旧版格式不支持预览，请另存为 .docx / .xlsx」+ 下载按钮 |
| P4 | 多 sheet `.xlsx` | 按钮切表；200×50 截断提示；`Date` 单元格格式化 |
| P5 | `.docx`（标题/列表/表格/超链接/嵌图） | 格式可见；>512 KiB 图变占位 |
| P6 | **编码**：GBK `.csv`、UTF-8-BOM `.txt`、UTF-16LE `.txt` | 中文正确，不乱码 |
| P7 | 6 MB `.txt` | 显示「文件过大」+ 下载可用（5 MiB 上限） |
| P8 | 20 MB 文件 | Network 里**只有** download-url POST，**无对象 GET** |
| P9 | 大文件预览中途关闭对话框 | 请求 cancelled；重开重新签名并正常 |
| P10 | 首屏 Network | 不加载 `docx-*.js` / `spreadsheet-*.js`，点预览对应类型时才加载 |
| P11 | 图片 / PDF 回归 | 原行为不破；PNG 有「新窗口打开」，SVG **没有** |

### XSS 冒烟（**验收门禁，不过不收工**）

准备样本：`evil.docx`（正文含 `<script>alert(1)</script>` 字面文本；超链接 `javascript:alert(...)`；`document.xml` 里绕过 Word 转义直接塞 `<script>alert(2)</script>`）、`evil.xlsx`（单元格 `<img src=x onerror=alert(1)>`）、`evil.txt`（`<script>alert(1)</script>`）、`evil.svg`（含 `<script>alert(1)</script>`）、`evil.html`。

| # | 样本 | 通过标准 |
| --- | --- | --- |
| X1 | `evil.docx` | 全程无 alert；`previewBody` 的 HTML **不含** `<script` / `onerror=` / `javascript:`；超链接不可点出脚本 |
| X2 | `evil.xlsx` | 单元格显示为字面文本 `<img src=x onerror=alert(1)>`，无 alert |
| X3 | `evil.txt` | `<pre>` 内字面文本，无 alert |
| X4 | `evil.svg` | `<img>` 不执行脚本；**无「新窗口打开」按钮** |
| X5 | `evil.html` | 仅下载占位；Network 里看不到对象 GET；**无「新窗口打开」按钮** |

[限制] 以上均为浏览器人工执行项，本次未跑。残余风险：无前端单元测试 —— 日后 DOMPurify 升级或 `sanitize.ts` 单行改动重新放行 `onerror` 时，手测清单拦不住。若引入测试，`sanitize.ts` 的 XSS 矩阵与 `kind.ts` 的 MIME 白名单是投入产出比最高的两处。

## 已知测试缺口

- [限制] `FOR UPDATE SKIP LOCKED` 多 worker 抢占互斥仅在 PostgreSQL 验证，SQLite 无法覆盖（1 skipped）。
- [限制] 性能压测（3000 万装载、p95）未执行，保留为验收项。
- [限制] 备份/恢复演练（`backup.sh` / `restore.sh`）脚本语法已过 `sh -n`，但**未做隔离环境实际演练**。
- [限制] TLS 全链路（`TLS_ENABLED=true` + `sh scripts/gen-certs.sh` + `curl -k https://localhost:18443/health`）未在本次执行。
- [限制] 浏览器手动回归 10 项清单待人工执行。

## 真实栈部署记录（2026-10-10）

[依据] 从旧镜像升级到阶段 1–6 代码时遇到并解决的运维阻塞，供后续部署参考：

| 阻塞 | 现象 | 处置 |
| --- | --- | --- |
| 存量库 schema 落后 | 缺 3 表 + 7 列，`create_all` 只建表不加列 | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 非破坏性补齐，再 `alembic stamp head` |
| PostgreSQL 口令漂移 | `.env` 换强凭据后，PG 卷仍是首次初始化的弱口令 | 库内 `ALTER USER objectstore WITH PASSWORD`（保留数据） |
| MinIO root 口令漂移 | 同上，root 仍是 `minioadmin` | `docker compose up -d --force-recreate minio` 读新 `.env`，数据卷不动 |
| `minio-init` 镜像拉不到 | `minio/mc` 被 registry 拒绝 | 在 minio 容器内用自带 `/usr/bin/mc` 复刻同一套脚本 |
| worker healthcheck | `pgrep` 不在镜像内 | 改 `kill -0 1` |

[教训] **凭据类环境变量（PostgreSQL/MinIO）只在数据卷首次初始化时生效**，轮换凭据必须显式 `ALTER USER` 或重建对应容器，仅改 `.env` 不够。

[依据] 测试代码：`tests/test_mvp.py`、`tests/test_observability.py`、`tests/test_worker_pg.py`、`tests/conftest.py`、`tests/integration_smoke.py`。
