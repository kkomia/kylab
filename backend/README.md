# backend

KYLAB 桌面端的**本机后端**（Python / FastAPI 边车）：会话、笔记、记忆、设置、模型凭据
都落这一台机器，知识库在别处（本机是它的客户端）。

**入口只有一条**：`app/sidecar.py`（桌面壳拉起它，默认 `127.0.0.1:8765`）。
`app/main.py` 是同一个应用的另一条启动路径（`uvicorn app.main:app`，开发与脚本用）——
两者共用同一份 `services/`，差别只在壳传了哪些参数。工程约束见
《[项目工程规范 v0.6](../docs/规范/项目工程规范-v0.6.md)》。

原先那个「服务器档」（PostgreSQL + 对象存储 + DuckDB 的旧单体）随知识库产品剥离一起
删掉了，所以这里不再有第二个入口、也没有按档分流的装配。

## 跑起来

```sh
uv sync --all-extras          # 解析器与导出链都在 extras 里，跑产品就装上
uv run python -m app.sidecar  # 或 sh ../scripts/dev-sidecar.sh（与桌面壳同一个数据目录）
```

`--workspace` / `--data-dir` 可改落点，系统目录一律拒绝；只监听本机。
数据落 `<data_dir>/kylab.db`（SQLite）与数据目录下的 `originals/` / `markdown/` / `images/`。

接知识库那一侧用 `KYLAB_SERVER_URL` + `KYLAB_TOKEN`（壳起边车时自己传），
`KYLAB_KB_URL` / `KYLAB_KB_TOKEN` 是排障用的覆盖。三样都不配也能起，只是检索会如实报
「知识库不可用」（503），而不是回一个空的命中列表。

## 测试与检查

```sh
uv run pytest tests -m "not bench and not cloud"   # 不需要任何外部服务
uv run ruff check app/ tests/
python ../scripts/scan_emoji.py app/
python ../scripts/check_layering.py
```

存储只有本机一套（SQLite + 数据目录），每个用例自带临时目录
（见 `tests/conftest.py` 的 `isolated_data_dir`），**不需要数据库容器、也不需要对象存储**。

## 分层

`api/`（协议适配）→ `services/`（业务，禁止直接写 SQL）→ `storage/`（Repository 抽象 +
`sqlite_impl` / `local_impl` / `split_impl`），另有 `pipeline/`、`parsers/`（互不引用）、
`workers/`、`models/`、`core/`。三条铁律由 `scripts/check_layering.py` 自动核查：

1. `api/` 禁止写业务逻辑，一律转发 `services/`；
2. `services/` 禁止直接写 SQL / 直连驱动，存储访问只能经 `storage/` 的 Repository 接口；
3. `parsers/` 各实现只依赖 `base.py` 的 `ParseResult`，实现之间禁止互相 import。
