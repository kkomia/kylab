# KYLAB

A **lightweight knowledge base** for personal use on a LAN. Its core capability is
**vector retrieval**, exposed equivalently through **MCP Server + OpenAPI (REST) + an official Skill**.

After trying countless open-source knowledge base products, I decided to design one myself.

> Status: **M0 (repository foundation) complete**. M1 (storage and domain model) is next.
> See [`docs/开发计划-v0.1.md`](docs/开发计划-v0.1.md) for milestones and schedule (Chinese).

## What it is

- **A knowledge base only** — no agents, no workflow orchestration, no document editor;
- **Fully asynchronous pipeline**: upload -> probe -> parse -> chunk -> embed -> searchable,
  every step retryable and resumable;
- **Per-file dynamic parser routing** (the differentiator): sample pages to measure text-layer
  coverage, extract text-based PDFs directly, send scans to OCR, route mixed PDFs page by page,
  and record the routing decision so the console can explain *why* a file went through OCR;
- **Markdown as the single artifact**: everything is converted to Markdown, and only Markdown
  is embedded;
- **Fully embedded storage**: SQLite + sqlite-vec + FTS5 + DuckDB + local filesystem.
  No mandatory Redis / PostgreSQL / MinIO; runs on a 4 GB machine with cloud parsing.

## Product boundaries (important)

- The API **returns raw retrieval results only and never pre-processes them with an LLM**.
  Prompt-injection protection is the caller's responsibility;
- The default embedding provider is a free cloud API, which means **text chunks leave your machine**.
  Privacy-sensitive users should switch to a local model;
- Built for a single user on a LAN — no multi-writer concurrency, no knowledge base sharing.

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
├── docs/                  Design and specification documents
├── backend/               Python backend (FastAPI + MCP Server)
├── frontend/              Vue 3 + Vite web console
├── tests/e2e/             Cross-stack E2E (Playwright)
├── scripts/               Dev/deploy scripts and convention checks
├── deploy/                Docker Compose and other deployment artifacts
└── .github/workflows/     CI (host still undecided, see plan §8 D3)
```

**Iron rule**: every file has exactly one home directory. No loose files in the repository root.

## Documentation

| Document | Contents |
|----------|----------|
| [Architecture v0.2](docs/架构设计-v0.2.md) | Positioning, architecture, ingestion pipeline, retrieval, storage choice, MVP scope |
| [Engineering spec v0.2](docs/项目工程规范-v0.2.md) | Layout, naming, layering discipline, testing, commits and branches |
| [Frontend design spec v0.1](docs/前端设计规范-v0.1.md) | Notion-style grayscale system, light/dark theme tokens, no-emoji and inline SVG rules |
| [Development plan v0.1](docs/开发计划-v0.1.md) | Milestones M0–M7, task breakdown, quality gates, risk register |

> Documents are written in Chinese; the English README is a summary only.

## Quality gates

Every commit and every CI run executes the same checks (`scripts/lint.*`, `scripts/ci.*`):

| Check | Tool |
|-------|------|
| Backend lint | `ruff` |
| Backend tests | `pytest -m "not bench and not cloud"` |
| Frontend lint | `eslint` (including the custom `kylab/no-emoji` rule) + `prettier` |
| Frontend tests | `vitest` |
| Emoji scan | `scripts/scan_emoji.py` |
| Layering and test placement | `scripts/check_layering.py` |

Three layering rules are enforced mechanically rather than by reviewer memory:

1. `api/` and `mcp_server/` adapt protocols only — no business logic;
2. `services/` never writes SQL — all storage access goes through `storage/` repository interfaces;
3. parser implementations depend only on `ParseResult` from `base.py` and never import each other.

## Contributing

- Branches: `main` is protected, `develop` integrates, `feat/<topic>` and `fix/<topic>` for work;
- Commit messages: `<type>: <summary>` with type limited to `feat/fix/docs/test/refactor/chore`;
- CI must be green before merging — **CI is the final judge**, passing locally is not enough;
- New files follow the decision tree in engineering spec §7; tests follow §5.1.

## License

[MIT](LICENSE)
