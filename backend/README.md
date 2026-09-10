# backend

KYLAB 知识库后端：FastAPI（REST）+ MCP Server，共用 `services/` 业务层。
技术栈与进程模型见《架构设计 v0.2》§2；工程约束见《项目工程规范 v0.1》。

## 快速开始

```powershell
cd backend
uv sync                      # 安装基础依赖 + dev 依赖组（ruff/pytest/...）
Copy-Item .env.example .env  # 按需填写，.env 不入库
uv run uvicorn app.main:app --reload
```

打开 http://127.0.0.1:8000/api/v1/docs 查看 OpenAPI 文档；
`GET /api/v1/health` 为存活探针。

> M1/M2/M4 起再按需安装重依赖：`uv sync --extra storage --extra parsers --extra mcp`。
> M0 只装基础依赖，保证 CI 快且稳。

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
