# backend

KYLAB 知识库后端：FastAPI（REST）+ MCP Server，共用 `services/` 业务层。
技术栈与进程模型见《架构设计 v0.2》§2；工程约束见《项目工程规范 v0.3》。

## 快速开始

```powershell
cd backend
uv sync --all-extras          # 见下方"依赖分层"：光 uv sync 起不来
Copy-Item .env.example .env  # 按需填写，.env 不入库
uv run uvicorn app.main:app --reload
```

打开 http://127.0.0.1:8000/api/v1/docs 查看 OpenAPI 文档；
`GET /api/v1/health` 为存活探针。

> **依赖分层（踩过坑，照实写）**：`sqlite-vec`、`jieba`、`argon2-cffi` 在核心依赖里；
> 但**光 `uv sync` 是起不来的**——`app/core/storage.py` 会无条件构造 DuckDB 表格副本
> （`tabular` extra），缺了它 `import app.main` 直接 `ModuleNotFoundError`。
> 所以本地、CI、Docker 一律用 `uv sync --all-extras`：
>
> - `tabular`（duckdb）——storage 组合根的必需项，不是可选项；
> - `parsers`（pypdf / pymupdf / python-docx / openpyxl / pandas / markdown-it-py）——
>   上传→解析→入库主链路要用；代码里是惰性导入，缺了只是该功能不可用，对应测试也写了
>   `importorskip`，但**运行产品就该装上**；
> - `mcp`（M4）——只在跑 MCP Server 那个入口时需要。
>
> 只想跑一个「不解析文档的最小 API」时才用裸 `uv sync`，那种情况下解析相关测试会跳过。

## 常用命令

| 目的 | 命令 |
|------|------|
| Lint | `uv run ruff check app/ tests/` |
| 单元 + 集成测试 | `uv run pytest tests/ -m "not bench and not cloud"` |
| 基准测试（手动） | `uv run pytest tests/bench/` |
| 覆盖率 | `uv run pytest --cov=app` |
| emoji 扫描 | `python ../scripts/scan_emoji.py app/` |
| 分层纪律检查 | `python ../scripts/check_layering.py` |

## 目录与纪律

```
app/
├── main.py            FastAPI 入口
├── api/v1/            REST 路由层（协议适配，无业务逻辑）
├── mcp_server/        MCP Server（stdio / Streamable HTTP）
├── core/              配置、日志、鉴权、异常
├── services/          业务服务（禁止直接写 SQL）
├── pipeline/          摄入流水线状态机
├── parsers/           ParserProvider 接口与实现（互不引用）
├── storage/           Repository 抽象 + sqlite_impl/
├── models/            Pydantic / 领域模型
└── workers/           asyncio + SQLite 任务队列
tests/
├── unit/              与被测模块镜像同构
├── integration/       跨模块（状态机、存储、API 端到端）
├── fixtures/          小样本与 mock 响应（单文件 ≤ 5MB）
└── bench/             性能与容量基准
```

三条铁律（工程规范 §3.3，由 `scripts/check_layering.py` 自动核查）：

1. `api/`、`mcp_server/` 禁止写业务逻辑，一律转发 `services/`；
2. `services/` 禁止直接写 SQL，存储访问只能经 `storage/` 的 Repository 接口；
3. `parsers/` 各实现只依赖 `base.py` 的 `ParseResult`，实现之间禁止互相 import。
