# KYLAB

A **local-first knowledge base RAG system**: bring in your scattered documents, ask questions
with your own models, and get answers with citations back to the source text. An AI notes
module completes the loop on the "write" side — notes can be attached to a knowledge base
with one click and become searchable corpus. Capabilities are exposed equivalently through
**REST (OpenAPI) + MCP Server + an official Skill**.

> Status: **M0–M7 milestones all complete**, latest release **v0.2.0** (2026-09-17) — a breaking
> storage change (SQLite -> PostgreSQL) plus everything built since 0.1.0; see the
> [changelog](CHANGELOG.md). Iteration follows the
> [knowledge base product benchmark](docs/调研/知识库产品对标调研-v0.1.md) and the
> [Agent workspace & capability layer design](docs/设计/Agent-工作区与能力层设计-v0.1.md) (both Chinese):
> notes, knowledge-base wiki, memory layer, the agent tool loop with sub-agents, skills and
> external MCP servers, session sandboxes, Office export, web search.
> Gate baseline: 2176 backend test cases (a PostgreSQL test database is required, see below)
> and 526 frontend test cases; the latest all-green run is recorded in the
> [development plan §12](docs/计划与记录/开发计划-v0.1.md), and `scripts/ci.*` is the way to reproduce it.

## How the positioning drifted (vs. the original design)

The original design ([Architecture v0.2](docs/设计/架构设计-v0.2.md)) positioned this as a **pure
vector retrieval service**: return raw retrieval results only, no LLM pre-processing, no
document editing. During development the positioning shifted five times, explicitly:

1. **From "retrieval service" to "retrieval + Q&A"**: v0.1.0 added chat — streaming answers,
   forced citation of source text, citation snapshots (revisiting a turn still shows the exact
   passages the answer was based on). Chat is now the main entry point;
2. **From "no LLM" to "LLM deeply involved"**: thinking mode (dialect adapters for 8 providers),
   context compression, conversation title generation, note AI actions;
3. **A notes module was added** (benchmarked against Tencent ima, see the
   [research report](docs/调研/笔记功能调研-v0.1.md)): Tiptap rich-text editing + AI actions +
   one-click attachment into a knowledge base. The same idea later grew a knowledge-base wiki
   and a memory layer;
4. **From "knowledge base Q&A" to "a personal agent with tools"**: the main chat flow became a
   tool loop, and the knowledge base was demoted from *the* channel to *one tool among many*;
   workspaces, skills and external MCP servers, sub-agent spawning and session sandboxes were
   layered on top. Note that the **external retrieval channel did not change with it** — it
   still returns raw retrieval results only;
5. **The storage layer was re-founded once**: the original promise of "single machine, zero
   middleware" (SQLite + sqlite-vec + FTS5) is void — the SQLite implementation was deleted
   outright and **PostgreSQL is now a mandatory dependency** (pgvector for vectors, tsvector
   for full text, DuckDB for tabular copies). That is the only breaking foundation change in
   this project, and it is the claim this README got wrong for the longest time.

**Current foundation**: PostgreSQL (mandatory) + object storage (local directory or any
S3-compatible service) + DuckDB; an asynchronous ingestion pipeline (leases / backoff /
resumable runs / cooperative cancel); per-file dynamic parser routing. Only two things survive
from the original design: the retrieval channel's "raw results" semantics, and
**single-machine deployability** — PostgreSQL on the same host is enough, no Redis, no message
queue, no separate retrieval service.

> Superseded positioning statements are not kept in the body: this README describes only what
> the project **is today**. For the history, see git and the [changelog](CHANGELOG.md).

## What it is

- **Ingestion pipeline**: upload -> per-file probing (text layer / scan / layout) -> parse ->
  chunk -> embed -> index. Cloud parsers (MinerU / PaddleOCR) and local ones are routed per
  file, with automatic fallback to the next channel when the first choice fails. Routing
  decisions are recorded — the console can explain *why* a file went through OCR.
  Everything is converted to Markdown; only Markdown is embedded.
- **Retrieval**: vector + BM25 dual-channel recall fused with RRF, optional rerank, metadata
  filtering, and "retrieve small chunks, read the big section" — a hit on a small chunk is
  expanded to its enclosing section. A retrieval debug console lets you verify results.
- **Chat and agent**: SSE streaming with smooth output, forced citations (`[n]` mapped to
  sources below; a source card can be expanded in place to show the full passage), three levels
  of thinking mode, and **a tool loop as the main flow** — knowledge-base retrieval, web search
  and page fetching, Office export (docx/xlsx/pptx/pdf), sub-agent spawning, **reading files in
  the workspace, running commands in the sandbox, read-only SQL over tabular copies, and
  scheduling a task**, with what a tool may touch scoped by session and workspace;
  a turn that hits its step/time budget can **resume where it stopped**; context is compressed
  automatically when it outgrows the window; conversations and messages are persisted with
  citation snapshots (revisiting a turn still shows the exact passages it was based on).
- **Workspaces and the capability layer**: account -> agent -> workspace (project) -> session;
  capabilities are **skills** (`SKILL.md`, progressively expanded) and **external MCP servers**
  (four permission tiers — allow / deny / ask / sandbox — following Claude Code's model).
  A session sandbox gives execution tools a restricted directory; it is not the same thing as
  a workspace.
- **Notes / wiki / memory**: notes are Tiptap rich text (images / task lists / placeholder
  guidance) with Markdown as the single source of truth, and `attach_note` attaches one to a
  knowledge base; the wiki is a knowledge-base mode (a page tree with citations); the memory
  layer keeps the persona files and long-term memory as plain Markdown on disk, readable and
  editable even with the memory service switched off.
- **Document governance**: folder tree, bulk operations, impact list before deletion,
  a 7-day trash, and manual chunk curation (edit / disable / delete — parsers *will* make
  mistakes; this is the last line of defense for quality).
- **Data sources**: RSS / Atom feeds and single-page HTML with conditional GET incremental
  fetching; body extraction strips navigation and ads.
- **Integration**: 148 REST endpoints; MCP server with dual transports and 18 tools;
  API keys with scoped permissions; webhook event push (HMAC-SHA256 signatures, at-least-once
  delivery, failures are pushed too).
- **Accounts and governance**: argon2 login with sliding session renewal, admin / member roles,
  knowledge base sharing with read / write levels (no open registration — the first account is
  created by the setup wizard); usage stats aggregated by local calendar day / purpose / model
  (deliberately no cost estimation).
- **Storage**: PostgreSQL is mandatory — metadata, vectors (pgvector + HNSW, partitioned per
  knowledge base) and full text (tsvector generated column + GIN + jieba tokenization) all live
  in the same database; tabular documents get an additional structured DuckDB copy; originals,
  Markdown and images go to object storage (local directory or S3-compatible). No Redis, no
  message queue, no separate retrieval service — PostgreSQL on the same host is enough.

## Product boundaries (important)

- **Not doing**: visual orchestration, workflow engines, collaborative document editing,
  open registration, multi-tenancy. The agent stops at "one agent per account + a tool loop +
  sub-agents" — there is no orchestration canvas and no agent sharing across accounts;
- The **retrieval channel returns raw results only**; prompt-injection protection is the
  caller's responsibility (the chat channel mitigates internally with source-block delimiters,
  "not an instruction" declarations, and scrambling look-alike markers inside documents);
- The default embedding provider is a free cloud API, which means **text chunks leave your
  machine**. Privacy-sensitive users should switch to a local model;
- Built for a single user or a small team on a LAN — no multi-writer concurrency, no
  collaborative editing.

## Quick start

### Backend (Python 3.11+ / uv + PostgreSQL)

**First, get a PostgreSQL with pgvector** (mandatory — SQLite was retired in v0.12 and there is
no local implementation to fall back on). The official image, matching the version this project
has been tested against:

```powershell
docker run -d --name kylab-postgres -p 5432:5432 `
  -e POSTGRES_PASSWORD=kylab-dev-secret -e POSTGRES_DB=kylab `
  pgvector/pgvector:pg17-trixie
```

Tables and migrations are created and brought up to date by the application at startup; there
is no manual schema step.

```powershell
cd backend
uv sync
Copy-Item .env.example .env      # at minimum set KYLAB_DATABASE_URL; .env is never committed
uv run uvicorn app.main:app --reload
```

> Without `KYLAB_DATABASE_URL` the service **fails at startup** and tells you what to set —
> it never silently falls back to another implementation (that would only make "the tests never
> ran" look like "the tests passed"). Running the backend tests needs a **separate test
> database** as well: `KYLAB_TEST_DATABASE_URL`; without it the repository-backed tests are
> skipped wholesale.

- Health probe: http://127.0.0.1:8000/api/v1/health
- API docs: http://127.0.0.1:8000/api/v1/docs

### Frontend (Node 20+ / pnpm)

```powershell
cd frontend
pnpm install
pnpm dev                          # http://127.0.0.1:5173, /api proxied to port 8000
```

LAN access and deployment details: [deployment & operations v0.2](docs/规范/部署与运行-v0.2.md) (Chinese).

### Desktop shell (optional, Rust + Tauri 2)

A **thin shell** for "server on the NAS, users on other machines": no server code inside,
it just remembers your server address and points the window at it. Enter the address once
on first launch; every launch after that goes straight to the UI.

```powershell
cd desktop/src-tauri
cargo run --release            # needs Rust, VS build tools and the WebView2 runtime
```

Packaging: [desktop/README.md](desktop/README.md); the stack choice and pitfalls:
[desktop shell research v0.1](docs/调研/桌面端套壳调研-v0.1.md) (Chinese).

### Helper scripts

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-backend.ps1     # backend dev server
powershell -ExecutionPolicy Bypass -File scripts\dev-frontend.ps1    # frontend dev server
powershell -ExecutionPolicy Bypass -File scripts\lint.ps1            # convention checks (before committing)
powershell -ExecutionPolicy Bypass -File scripts\ci.ps1              # CI gate (conventions + both test suites)
```

With PowerShell 7 installed, `pwsh -File scripts\lint.ps1` is equivalent.
Use the identically named `.sh` variants on Linux / macOS.

> Scripts support both Windows PowerShell 5.1 and PowerShell 7. `.ps1` files must be saved as
> **UTF-8 with BOM**, otherwise 5.1 decodes them as GBK and mangles non-ASCII output.

## Repository layout

```
kylab/
├── docs/                  Design and specification documents (the project's core asset)
├── backend/               Python backend (FastAPI; app/ layered: api -> services -> storage/parsers)
├── frontend/              Vue 3 + Vite + TS + Pinia web console
├── desktop/               Tauri 2 desktop shell (thin client for a NAS-hosted server)
├── tests/e2e/             Cross-stack E2E (Playwright)
├── skills/                Official MCP Skill artifact
├── scripts/               Dev/deploy scripts and convention checks
├── deploy/                Docker Compose and other deployment artifacts (the postgres service is field-tested; the full stack has not been brought up on a clean machine in one command)
├── .workflow/             CI (Gitee Go, the default carrier)
└── .github/workflows/     CI (GitHub variant, kept for future mirroring)
```

**Iron rule**: every file has exactly one home directory. No loose files in the repository root.

## Documentation

| Document | Contents |
|----------|----------|
| **specs/** — mandatory when changing code or deploying | |
| [Engineering spec v0.4](docs/规范/项目工程规范-v0.4.md) | Layout, naming, layering discipline, testing, **the five doc folders** and the freeze rule, commits and branches |
| [Frontend design spec v0.14](docs/规范/前端设计规范-v0.14.md) | Design tokens, light/dark themes, accessible controls, UI information architecture (values measured from Kimi) |
| [API spec v0.1](docs/规范/API-接口规范-v0.1.md) | REST routes, request/response conventions, error envelope (accepted when it matches the generated OpenAPI) |
| [Deployment & operations v0.2](docs/规范/部署与运行-v0.2.md) | PostgreSQL prerequisite, local and container routes, backup/restore, capacity and pitfalls |
| **design/** — how the system is built, and why | |
| [Architecture v0.2](docs/设计/架构设计-v0.2.md) | Original positioning, architecture, ingestion pipeline, retrieval, capacity planning. **Two parts are void**: the positioning (see the "drift" section above) and §8's storage choice (SQLite), superseded by PostgreSQL |
| [Agent workspace & capability layer v0.1](docs/设计/Agent-工作区与能力层设计-v0.1.md) | Workspaces, skills and external MCP, tool admission policy, session sandboxes, sub-agents |
| [Memory layer design v0.1](docs/设计/记忆层设计-v0.1.md) | Persona files and long-term memory (benchmarked against ReMe / QwenPaw), phases and acceptance |
| **research/** — one-off evidence behind decisions | |
| [Product benchmark v0.1](docs/调研/知识库产品对标调研-v0.1.md) | Gap analysis and trade-offs against Dify / RAGFlow / FastGPT / WeKnora and peers |
| [Notes research v0.1](docs/调研/笔记功能调研-v0.1.md) | Feature decomposition vs. Tencent ima, editor selection (Tiptap), landing checklist |
| [Wiki generation research v0.1](docs/调研/Wiki生成调研-v0.1.md) | Four routes for auto-generating wiki pages and a copy-ready checklist |
| [Skills repo & marketplace research v0.1](docs/调研/技能仓库与技能市场调研-v0.1.md) | Open-source skill repos and third-party marketplaces (research only, no implementation) |
| [Thinking mode research v0.1](docs/调研/思考模式调研-v0.1.md) | Provider dialects and effort levels for thinking mode (see `services/thinking.py`) |
| [Tool-call limits research v0.1](docs/调研/工具调用限制调研-v0.1.md) | Turn/budget/timeout/termination designs across agent frameworks, plus our own values (`tool_loop.py`) |
| [Desktop shell research v0.1](docs/调研/桌面端套壳调研-v0.1.md) | A thin desktop shell for the NAS-hosted server: Tauri 2 choice, loading a remote address, clipboard and menu pitfalls |
| [Retrieval evaluation v0.1](docs/调研/检索评测-v0.1.md) | Retrieval quality evaluation method and conclusions |
| [UI review & improvement plan v0.2](docs/调研/界面评审与改进计划-v0.2.md) | Second round of UI review items (executed); the first round is v0.1 |
| [UI assessment v0.1](docs/调研/UI-评估与优化方案-v0.1.md) | Measured performance, visual/layout assessment, and a feature comparison against Dify / MaxKB / WeKnora |
| [Kimi design token reference](docs/调研/Kimi-设计token对照表.md) | The reference values behind the frontend art direction (measured from Kimi's stylesheet; not the spec itself) |
| **plan/** — read on a timeline | |
| [Development plan v0.1](docs/计划与记录/开发计划-v0.1.md) | Milestones M0–M7, task breakdown, quality gates, risk register; §11–§12 log each iteration's gap absorption and what actually landed (the longest document) |
| [Handover 2026-09-11](docs/计划与记录/交接说明-2026-09-11.md) | Read this first when taking over: three commands to get running, discipline, pitfalls. **A snapshot of that day** — it still describes SQLite storage, so this README wins |
| **archive/** — superseded versions and historical reports | |
| [Engineering spec v0.3](docs/归档/项目工程规范-v0.3.md) | Superseded by v0.4 (the doc-folders change) |
| [Frontend design spec v0.13](docs/归档/前端设计规范-v0.13.md) | Superseded by v0.14 (radii, motion, overlay surface) |
| [Deployment & operations v0.1](docs/归档/部署与运行-v0.1.md) | Superseded by v0.2 (dependency install, required env var, a wrong attribution) |
| [Code review M2/M4 v0.1](docs/归档/质检报告-M2M4-async-worker-rest-api-v0.1.md) | Milestone review of the async consumer and core REST API (verdict: pass) |
| [Code review M5 v0.1](docs/归档/质检报告-M5-web-console-v0.1.md) | Milestone review of the web console (verdict: pass) |

> `docs/` is split into five folders by type — the path tells you whether a document is
> binding, background, evidence or history (see Engineering spec v0.4 §2.3); the per-document
> index is [`docs/README.md`](docs/README.md).
> Documents are written in Chinese; the English README is a summary only.

## Quality gates

**CI runs on Gitee Go** (`.workflow/kylab-ci.yml`). It invokes the **same scripts** as the
local commands `scripts/ci.ps1` / `scripts/ci.sh`, so "green locally, red in CI" cannot happen.

> The gates can always be reproduced locally — this is deliberate: a red CI should not block
> development, and "being able to reproduce the CI verdict locally" is the most useful property
> a project like this can have.

Every commit and every CI run executes the same checks (`scripts/lint.*`, `scripts/ci.*`):

| Check | Tool |
|-------|------|
| Backend lint | `ruff` |
| Backend tests | `pytest -m "not bench and not cloud"` |
| Frontend type check | `vue-tsc` |
| Frontend lint | `eslint` (including the custom `kylab/no-emoji` rule) + `prettier` |
| Frontend tests | `vitest` |
| Emoji scan | `scripts/scan_emoji.py` |
| Layering and test placement | `scripts/check_layering.py` |

Three layering rules are enforced mechanically rather than by reviewer memory:

1. `api/` and `mcp_server/` adapt protocols only — no business logic;
2. `services/` never writes SQL — all storage access goes through `storage/` repository interfaces;
3. parser implementations depend only on `ParseResult` from `base.py` and never import each other.

## Known limitations (honest list)

- **Container path only half verified**: the **PostgreSQL service** in `deploy/docker-compose.yml`
  is field-tested on a real deployment server (same `pgvector/pgvector:pg17-trixie` image,
  PG 17.11 + pgvector 0.8.6, self-bootstrapping schema, HNSW search verified working), but the
  full compose stack has not been brought up on a clean machine in one command. The local venv
  path is field-tested.
- **No capacity sizing table**: measured data across memory tiers is missing; concurrency
  numbers are not fabricated.
- **No performance baseline**: `backend/tests/bench/` is an empty shell and CI excludes it with
  `-m "not bench"`, so there is no regression guardrail — a performance change cannot be backed
  by comparable numbers.
- **No type contract between frontend and backend**: the interfaces in `frontend/src/api/*.ts`
  are hand-copied from `api/v1/schemas.py`; a field change on the backend will not fail the
  frontend type check, it will simply misalign at runtime.
- **WebDAV data source not implemented** (deferred, Architecture §14); the API reports
  "not implemented" explicitly rather than shipping an empty stub.
- **No JS-rendered pages**: the HTML data source fetches server-returned HTML only.

## Contributing

- Branches: `main` is protected, `develop` integrates, `feat/<topic>` and `fix/<topic>` for work;
- Commit messages: `<type>: <summary>` with type limited to `feat/fix/docs/test/refactor/chore`;
- CI must be green before merging — **CI is the final judge**, passing locally is not enough;
- New files follow the decision tree in engineering spec §7; tests follow §5.1.

## License

[MIT](LICENSE)
