# KYLAB

一个**本地优先的知识库 RAG 系统**：把散落的文档收进来，用自己的模型提问，
拿到带原文引用的回答；AI 笔记补上「写」的一环，记录可一键入库成为可检索语料。
对外通过 **REST (OpenAPI) + MCP Server + 官方 Skill** 三条等价方式提供能力。

> 当前状态：**M0–M7 主干全部完成**，v0.1.0 已发布（2026-09-11），
> 此后按[知识库产品对标调研](docs/知识库产品对标调研-v0.1.md)持续迭代
> （笔记板块、Agent 多轮检索、流式渲染增强）。
> 门禁基线：后端 1400+ / 前端 348 测试全绿。

## 定位演化（与最初设计的差异）

最初设计（[架构设计 v0.2](docs/架构设计-v0.2.md) 成稿时）把它定位成**纯向量检索服务**：
只返回检索结果原文、不做任何 LLM 预处理、不做文档编辑。开发过程中定位发生了三次明确偏移：

1. **从「检索服务」到「检索 + 问答」**：v0.1.0 加入对话——流式回答、强制引用原文、
   引用存快照（回看时依据的仍是当时那几段），对话成为主入口；
2. **从「不碰 LLM」到「LLM 深度参与」**：思考模式（8 家供应商方言适配）、
   Agent 多轮检索、上下文压缩、会话标题生成、笔记 AI 处理。
   **检索通道「返回原文」的语义保持不变**，LLM 只出现在对话与写作侧；
3. **新增笔记板块**（对标腾讯 ima，见[调研报告](docs/笔记功能调研-v0.1.md)）：
   Tiptap 富文本编辑 + AI 处理 + 一键入库知识库。

不变的地基：单机零中间件（SQLite + sqlite-vec + FTS5 + DuckDB）、
异步摄入流水线（租约/退避/断点续跑/协作取消）、逐文件动态解析路由。

## 它是什么

- **摄入流水线**：上传 → 逐文件探测（文本层 / 扫描件 / 版式）→ 解析 → 切块 → 向量化 → 索引。
  云端解析（MinerU / PaddleOCR）与本地解析按文件动态路由，首选失败自动降级换通道，
  路由决策写进任务记录——控制台能看到「这个文件为什么走了 OCR」。
  所有格式统一转 Markdown，向量化只针对 Markdown。
- **检索**：向量 + BM25 双通道 RRF 融合，可选 rerank，元数据过滤，
  「小块检索、大块阅读」——命中的小块自动补全为整段小节；检索调试台可复核效果。
- **对话**：SSE 流式 + 平滑输出，强制引用原文（`[n]` 对应下方出处，
  出处卡片可就地展开看全文）；思考模式三档强度；Agent 多轮检索与上下文压缩；
  会话与消息落库，引用快照可回看。
- **笔记**：Tiptap 富文本（图文混排 / 待办 / 占位引导），Markdown 落库为唯一事实源；
  AI 处理动作、图片插入、自动保存；`attach_note` 一键把笔记挂进知识库走摄入流水线。
- **文档治理**：目录树、批量操作、删除前影响清单、7 天回收站、切块人工干预
  （编辑 / 禁用 / 删除——解析器一定会出错，这是质量的最后兜底）。
- **数据源**：RSS / Atom 订阅与单页 HTML，条件 GET 增量拉取，正文提取剥离导航与广告。
- **接入**：约 110 个 REST 端点；MCP Server 双传输 7 工具；API Key（范围控制）；
  Webhook 事件推送（HMAC-SHA256 验签、至少一次投递、失败也推）。
- **账号与治理**：argon2 登录 + 会话滑动续期，管理员 / 成员两档角色，
  知识库分享读 / 写两档（不开放注册，首个账号由设置向导创建）；
  用量统计按本地日历日 / 用途 / 模型聚合（刻意不算钱）。
- **全嵌入式存储**：SQLite（WAL）+ sqlite-vec（按知识库分区）+ FTS5（jieba）+ DuckDB（表格副本），
  无 Redis / PostgreSQL / MinIO 必选依赖，纯云端解析路线 4GB 内存可跑。

## 产品边界（重要）

- **不做** Agents 编排 / 工作流引擎 / 文档协作编辑器 / 开放注册 / 多租户；
- 对外**检索通道只返回检索结果原文**，提示注入防护的责任在调用方（对话通道内部已有
  资料块定界、声明「非指令」、打散文档内同形标记等缓解）；
- 默认 embedding 走云端免费 API，意味着**文本分片会外发**；隐私敏感用户请改用本地模型；
- 面向局域网单用户或小团队，不做多用户并发写与协作编辑。

## 快速开始

### 后端（Python 3.11+ / uv）

```powershell
cd backend
uv sync
Copy-Item .env.example .env      # 按需填写，.env 不入库
uv run uvicorn app.main:app --reload
```

- 探针：http://127.0.0.1:8000/api/v1/health
- 接口文档：http://127.0.0.1:8000/api/v1/docs

### 前端（Node 20+ / pnpm）

```powershell
cd frontend
pnpm install
pnpm dev                          # http://127.0.0.1:5173，/api 自动代理到 8000
```

局域网访问与部署细节见[部署与运行 v0.1](docs/部署与运行-v0.1.md)。

### 一键脚本

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-backend.ps1     # 后端开发服务
powershell -ExecutionPolicy Bypass -File scripts\dev-frontend.ps1    # 前端开发服务
powershell -ExecutionPolicy Bypass -File scripts\lint.ps1            # 规范检查（提交前跑）
powershell -ExecutionPolicy Bypass -File scripts\ci.ps1              # CI 门禁（规范检查 + 前后端测试）
```

装了 PowerShell 7 的话，`pwsh -File scripts\lint.ps1` 等价；Linux / macOS 用同名 `.sh`。

> 脚本兼容 Windows PowerShell 5.1 与 PowerShell 7；`.ps1` 必须以 **UTF-8 with BOM** 保存，
> 否则 5.1 会按 GBK 解码导致中文输出乱码。

## 仓库结构

```
kylab/
├── docs/                  设计与规范文档（本项目的核心资产）
├── backend/               Python 后端（FastAPI，app/ 分层：api → services → storage/parsers）
├── frontend/              Vue 3 + Vite + TS + Pinia Web 控制台
├── tests/e2e/             跨端 E2E（Playwright）
├── skills/                官方 MCP Skill 产物
├── scripts/               开发/部署/规范检查脚本
├── deploy/                Docker Compose 等部署产物（尚未在干净机器实测）
├── .workflow/             CI（Gitee Go，默认承载）
└── .github/workflows/     CI（GitHub 版，保留备将来镜像）
```

**铁律**：任何文件都有唯一归属目录，不允许在仓库根目录散落临时文件。

## 文档索引

| 文档 | 内容 |
|------|------|
| [架构设计 v0.2](docs/架构设计-v0.2.md) | 最初定位、总体架构、摄入流水线、检索、存储选型（注意：定位部分已被本 README §「定位演化」修正） |
| [项目工程规范 v0.3](docs/项目工程规范-v0.3.md) | 目录、命名、分层纪律、测试规范、提交与分支 |
| [前端设计规范 v0.12](docs/前端设计规范-v0.12.md) | 设计令牌、黑白双主题、无障碍控件、界面信息架构 |
| [开发计划 v0.1](docs/开发计划-v0.1.md) | M0–M7 里程碑、任务分解、质量门禁、风险登记 |
| [交接说明 2026-09-11](docs/交接说明-2026-09-11.md) | 接手必读：现状、三条命令、诚实欠账清单、纪律与踩过的坑 |
| [知识库产品对标调研 v0.1](docs/知识库产品对标调研-v0.1.md) | 对标 Dify/RAGFlow/FastGPT/WeKnora 等的差距分析与取舍 |
| [笔记功能调研 v0.1](docs/笔记功能调研-v0.1.md) | 对标 ima 笔记的选型（Tiptap）与落地清单 |
| [检索评测 v0.1](docs/检索评测-v0.1.md) | 检索效果评测方法与结论 |
| [部署与运行 v0.1](docs/部署与运行-v0.1.md) | 局域网访问、部署写法与已知坑 |

## 工程质量门禁

**CI 在 Gitee Go**（`.workflow/kylab-ci.yml`）。它与本地命令
`scripts/ci.ps1` / `scripts/ci.sh` **调用同一批脚本**，
所以不存在「本地绿、CI 红」的分叉。

> 门禁也可以随时在本地完整复跑——这是刻意的：CI 挂了不该阻塞开发，
> 而「能在本地跑出与 CI 一样的结论」是这类项目最实用的一条性质。

每次提交与 CI 都跑同一套检查（内容见 `scripts/lint.*` 与 `scripts/ci.*`）：

| 检查 | 工具 |
|------|------|
| 后端 lint | `ruff` |
| 后端测试 | `pytest -m "not bench and not cloud"` |
| 前端类型检查 | `vue-tsc` |
| 前端 lint | `eslint`（含自定义 `kylab/no-emoji` 规则）+ `prettier` |
| 前端测试 | `vitest` |
| 禁 emoji 扫描 | `scripts/scan_emoji.py` |
| 分层纪律与测试位置 | `scripts/check_layering.py`（机械核查工程规范 §3.3 / §5.1） |

三条分层铁律由脚本强制，不靠 review 记忆：

1. `api/`、`mcp_server/` 只做协议适配，禁止写业务逻辑；
2. `services/` 禁止直接写 SQL，存储访问只能经 `storage/` 的 Repository 接口；
3. `parsers/` 各实现只依赖 `base.py` 的 `ParseResult`，实现之间禁止互相 import。

## 已知限制（诚实清单）

- **容器路线未验证**：开发机无 docker，`deploy/docker-compose.yml` 尚未在干净机器上跑通；本地 venv 路线已实测。
- **容量推荐表未填**：不同内存档位的实测数据尚未做，不编造并发数。
- **WebDAV 数据源未实现**（架构 §14 缓做），接口处明确报「未实现」而非空实现。
- **不支持 JS 渲染的页面**：HTML 数据源抓的是服务端返回的 HTML。
- **检索调用不落库**：用量统计目前看不到检索量（对标调研已登记）。

## 贡献

- 分支：`main` 保护，集成分支 `develop`，功能分支 `feat/<简述>`，修复 `fix/<简述>`；
- 提交信息：`<类型>: <简述>`，类型限 `feat/fix/docs/test/refactor/chore`；
- 合并前 CI 必须全绿（**CI 是最终裁判**，本地通过不算数）；
- 新增文件先查工程规范 §7 决策树，测试按 §5.1 对号入座。

## 许可

[MIT](LICENSE)
