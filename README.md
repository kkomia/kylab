# KYLAB

一个**轻量级知识库产品**：面向个人消费级用户、局域网部署，主打**向量检索服务**，
以 **MCP Server + OpenAPI (REST) + 官方 Skill** 三种等价方式对外提供能力。

用了无数个开源知识库产品之后，决定自己设计一个。

> 当前状态：**M0（仓库治理与地基）已完成**，M1 起进入存储与领域模型开发。
> 里程碑与排期见 [`docs/开发计划-v0.1.md`](docs/开发计划-v0.1.md)。

## 它是什么

- **纯知识库**：不做 Agents、不做工作流编排、不做文档编辑器；
- **全程异步流水线**：上传 → 探测 → 解析 → 切分 → 向量化 → 可检索，每步可重试、可断点续跑；
- **逐文件动态解析引擎**（差异化能力）：抽样探测文本层覆盖率，文字型 PDF 直提、扫描件走 OCR、
  混合型按页路由，路由决策写进任务记录，控制台能看到"这个文件为什么走了 OCR"；
- **统一 Markdown 产物**：所有格式解析后统一转 Markdown，向量化只针对 Markdown；
- **全嵌入式存储**：SQLite + sqlite-vec + FTS5 + DuckDB + 本地文件系统，
  无 Redis / PostgreSQL / MinIO 必选依赖，纯云端解析路线 4GB 内存可跑。

## 产品边界（重要）

- 对外**只返回检索结果原文，不做任何 LLM 预处理**。提示注入防护的责任在调用方；
- 默认 embedding 走云端免费 API，意味着**文本分片会外发**；隐私敏感用户请改用本地模型；
- 面向局域网单用户，不做多用户并发写与知识库分享协作。

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
├── docs/                  设计与规范文档（本文件及架构文档的家）
├── backend/               Python 后端（FastAPI + MCP Server）
├── frontend/              Vue 3 + Vite Web 控制台
├── tests/e2e/             跨端 E2E（Playwright）
├── scripts/               开发/部署脚本与规范检查
├── deploy/                Docker Compose 等部署产物
├── .workflow/            **CI（Gitee Go，默认承载）**
└── .github/workflows/     CI（GitHub 版，保留备将来镜像）
```

**铁律**：任何文件都有唯一归属目录，不允许在仓库根目录散落临时文件。

## 文档索引

| 文档 | 内容 |
|------|------|
| [架构设计 v0.2](docs/架构设计-v0.2.md) | 产品定位、总体架构、摄入流水线、检索、存储选型、MVP 范围 |
| [项目工程规范 v0.3](docs/项目工程规范-v0.3.md) | 目录、命名、分层纪律、测试规范、提交与分支 |
| [前端设计规范 v0.4](docs/前端设计规范-v0.4.md) | Notion 风灰阶体系、黑白双主题 Token（含实测对比度）、禁 emoji 与内联 SVG、形态随数据量、界面信息架构判定、破坏性动作确认口径 |
| [开发计划 v0.1](docs/开发计划-v0.1.md) | M0–M7 里程碑、任务分解、质量门禁、风险登记 |
| [交接说明 2026-09-11](docs/交接说明-2026-09-11.md) | 接手必读：现状、跑起来的三条命令、诚实欠账清单、纪律与踩过的坑 |

## 工程质量门禁

**CI 在 Gitee Go**（`.workflow/kylab-ci.yml`）。它与本地命令
`scripts/ci.ps1` / `scripts/ci.sh` **调用同一批脚本**，
所以不存在"本地绿、CI 红"的分叉。

> 门禁也可以随时在本地完整复跑——这是刻意的：CI 挂了不该阻塞开发，
> 而"能在本地跑出与 CI 一样的结论"是这类项目最实用的一条性质。

每次提交与 CI 都跑同一套检查（内容见 `scripts/lint.*` 与 `scripts/ci.*`）：

| 检查 | 工具 |
|------|------|
| 后端 lint | `ruff` |
| 后端测试 | `pytest -m "not bench and not cloud"` |
| 前端 lint | `eslint`（含自定义 `kylab/no-emoji` 规则）+ `prettier` |
| 前端测试 | `vitest` |
| 禁 emoji 扫描 | `scripts/scan_emoji.py` |
| 分层纪律与测试位置 | `scripts/check_layering.py`（机械核查工程规范 §3.3 / §5.1） |

三条分层铁律由脚本强制，不靠 review 记忆：

1. `api/`、`mcp_server/` 只做协议适配，禁止写业务逻辑；
2. `services/` 禁止直接写 SQL，存储访问只能经 `storage/` 的 Repository 接口；
3. `parsers/` 各实现只依赖 `base.py` 的 `ParseResult`，实现之间禁止互相 import。

## 贡献

- 分支：`main` 保护，集成分支 `develop`，功能分支 `feat/<简述>`，修复 `fix/<简述>`；
- 提交信息：`<类型>: <简述>`，类型限 `feat/fix/docs/test/refactor/chore`；
- 合并前 CI 必须全绿（**CI 是最终裁判**，本地通过不算数）；
- 新增文件先查工程规范 §7 决策树，测试按 §5.1 对号入座。

## 许可

[MIT](LICENSE)
