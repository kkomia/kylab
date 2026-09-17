# KYLAB

A **local-first knowledge base RAG system**: bring in your scattered documents, ask questions
with your own models, and get answers with citations back to the source text. An AI notes
module completes the loop on the "write" side — notes can be attached to a knowledge base
with one click and become searchable corpus. Capabilities are exposed equivalently through
**REST (OpenAPI) + MCP Server + an official Skill**.

> Status: **M0–M7 milestones all complete**, v0.1.0 released (2026-09-11). Iteration since then
> follows the [knowledge base product benchmark](docs/知识库产品对标调研-v0.1.md) (Chinese):
> notes module, agentic multi-turn retrieval, streaming rendering improvements.
> Gate baseline: 1400+ backend / 348 frontend tests, all green.

## How the positioning drifted (vs. the original design)

The original design ([Architecture v0.2](docs/架构设计-v0.2.md)) positioned this as a **pure
vector retrieval service**: return raw retrieval results only, no LLM pre-processing, no
document editing. During development the positioning shifted three times, explicitly:

1. **From "retrieval service" to "retrieval + Q&A"**: v0.1.0 added chat — streaming answers,
   forced citation of source text, citation snapshots (revisiting a turn still shows the exact
   passages the answer was based on). Chat is now the main entry point;
2. **From "no LLM" to "LLM deeply involved"**: thinking mode (dialect adapters for 8 providers),
   agentic multi-turn retrieval, context compression, conversation title generation, note AI
   actions. The **retrieval channel keeps its "raw results" semantics** — the LLM only appears
   on the chat and writing side;
3. **A notes module was added** (benchmarked against Tencent ima, see the
   [research report](docs/笔记功能调研-v0.1.md)): Tiptap rich-text editing + AI actions +
   one-click attachment into a knowledge base.

What did not change: single machine, zero middleware (SQLite + sqlite-vec + FTS5 + DuckDB),
an asynchronous ingestion pipeline (leases / backoff / resumable runs / cooperative cancel),
and per-file dynamic parser routing.

## What it is

- **Ingestion pipeline**: upload -> per-file probing (text layer / scan / layout) -> parse ->
  chunk -> embed -> index. Cloud parsers (MinerU / PaddleOCR) and local ones are routed per
  file, with automatic fallback to the next channel when the first choice fails. Routing
  decisions are recorded — the console can explain *why* a file went through OCR.
  Everything is converted to Markdown; only Markdown is embedded.
- **Retrieval**: vector + BM25 dual-channel recall fused with RRF, optional rerank, metadata
  filtering, and "retrieve small chunks, read the big section" — a hit on a small chunk is
  expanded to its enclosing section. A retrieval debug console lets you verify results.
- **Chat**: SSE streaming with smooth output, forced citations (`[n]` mapped to sources below;
  a source card can be expanded in place to show the full passage), three levels of thinking
  mode, agentic multi-turn retrieval with context compression, conversations and messages
  persisted with citation snapshots.
- **Notes**: Tiptap rich text (images / task lists / placeholder guidance), Markdown on disk
  as the single source of truth, AI actions, image insertion, autosave;
  `attach_note` attaches a note to a knowledge base and runs it through the ingestion pipeline.
- **Document governance**: folder tree, bulk operations, impact list before deletion,
  a 7-day trash, and manual chunk curation (edit / disable / delete — parsers *will* make
  mistakes; this is the last line of defense for quality).
- **Data sources**: RSS / Atom feeds and single-page HTML with conditional GET incremental
  fetching; body extraction strips navigation and ads.
- **Integration**: ~110 REST endpoints; MCP server with dual transports and 7 tools;
  API keys with scoped permissions; webhook event push (HMAC-SHA256 signatures, at-least-once
  delivery, failures are pushed too).
- **Accounts and governance**: argon2 login with sliding session renewal, admin / member roles,
  knowledge base sharing with read / write levels (no open registration — the first account is
  created by the setup wizard); usage stats aggregated by local calendar day / purpose / model
  (deliberately no cost estimation).
- **Fully embedded storage**: SQLite (WAL) + sqlite-vec (partitioned per knowledge base) +
  FTS5 (jieba) + DuckDB (tabular copies). No mandatory Redis / PostgreSQL / MinIO;
  runs on a 4 GB machine with cloud parsing.

## Product boundaries (important)

- **Not doing**: agent orchestration, workflow engines, collaborative document editing,
  open registration, multi-tenancy;
- The **retrieval channel returns raw results only**; prompt-injection protection is the
  caller's responsibility (the chat channel mitigates internally with source-block delimiters,
  "not an instruction" declarations, and scrambling look-alike markers inside documents);
- The default embedding provider is a free cloud API, which means **text chunks leave your
  machine**. Privacy-sensitive users should switch to a local model;
- Built for a single user or a small team on a LAN — no multi-writer concurrency, no
  collaborative editing.

## Quick start

### Backend (Python 3.11+ / uv)

```powershell
cd backend
uv sync
Copy-Item .env.example .env      # fill in as needed; .env is never committed
uv run uvicorn app.main:app --reload
```

- Health probe: http://127.0.0.1:8000/api/v1/health
- API docs: http://127.0.0.1:8000/api/v1/docs

### Frontend (Node 20+ / pnpm)

```powershell
cd frontend
pnpm install
pnpm dev                          # http://127.0.0.1:5173, /api proxied to port 8000
```

LAN access and deployment details: [deployment & operations v0.1](docs/部署与运行-v0.1.md) (Chinese).

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
├── tests/e2e/             Cross-stack E2E (Playwright)
├── skills/                Official MCP Skill artifact
├── scripts/               Dev/deploy scripts and convention checks
├── deploy/                Docker Compose and other deployment artifacts (not yet verified on a clean machine)
├── .workflow/             CI (Gitee Go, the default carrier)
└── .github/workflows/     CI (GitHub variant, kept for future mirroring)
```

**Iron rule**: every file has exactly one home directory. No loose files in the repository root.

## Documentation

| Document | Contents |
|----------|----------|
| [Architecture v0.2](docs/架构设计-v0.2.md) | Original positioning, architecture, ingestion pipeline, retrieval, storage choice (positioning superseded by the "drift" section above) |
| [Engineering spec v0.3](docs/项目工程规范-v0.3.md) | Layout, naming, layering discipline, testing, commits and branches |
| [Frontend design spec v0.13](docs/前端设计规范-v0.13.md) | Design tokens, light/dark themes, accessible controls, UI information architecture (values measured from Kimi) |
| [Development plan v0.1](docs/开发计划-v0.1.md) | Milestones M0–M7, task breakdown, quality gates, risk register |
| [Handover 2026-09-11](docs/交接说明-2026-09-11.md) | Read this first when taking over: current status, three commands to get running, honest list of open items, discipline and pitfalls |
| [Product benchmark v0.1](docs/知识库产品对标调研-v0.1.md) | Gap analysis and trade-offs against Dify / RAGFlow / FastGPT / WeKnora and peers |
| [Notes research v0.1](docs/笔记功能调研-v0.1.md) | Feature decomposition vs. Tencent ima, editor selection (Tiptap), landing checklist |
| [Wiki generation research v0.1](docs/Wiki生成调研-v0.1.md) | Four routes for auto-generating wiki pages, product examples, and a copy-ready checklist |
| [Retrieval evaluation v0.1](docs/检索评测-v0.1.md) | Retrieval quality evaluation method and conclusions |
| [Deployment & operations v0.1](docs/部署与运行-v0.1.md) | LAN access, deployment recipes and known pitfalls |

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

- **Container path unverified**: no Docker on the dev machine; `deploy/docker-compose.yml` has
  not been run on a clean machine. The local venv path is field-tested.
- **No capacity sizing table**: measured data across memory tiers is missing; concurrency
  numbers are not fabricated.
- **WebDAV data source not implemented** (deferred, Architecture §14); the API reports
  "not implemented" explicitly rather than shipping an empty stub.
- **No JS-rendered pages**: the HTML data source fetches server-returned HTML only.
- **Retrieval calls are not logged**: usage stats currently cannot show retrieval volume
  (registered in the benchmark report).

## Contributing

- Branches: `main` is protected, `develop` integrates, `feat/<topic>` and `fix/<topic>` for work;
- Commit messages: `<type>: <summary>` with type limited to `feat/fix/docs/test/refactor/chore`;
- CI must be green before merging — **CI is the final judge**, passing locally is not enough;
- New files follow the decision tree in engineering spec §7; tests follow §5.1.

## License

[MIT](LICENSE)
