# KYLAB

**A local agent that runs on your own computer**: the chat and tool loop, the sandbox, notes and
memory, skills and plugins, workspaces, scheduled tasks and Office deliverables all run locally;
data lives in a local SQLite file and no server is required. Models are called straight from this
machine with your own key (DeepSeek and others).

The current form is the **web app**: local backend plus a Vite frontend. For versions and the
change-by-change log, see the [changelog](CHANGELOG.md).

## What it is

- **Chat is the main entry point and the main flow is a tool loop**: SSE streaming answers; the
  agent reads files in the workspace, runs commands in the sandbox, searches the web and fetches
  pages, runs read-only SQL over tabular copies, schedules tasks, spawns sub-agents. Which
  directories a tool may touch is scoped per session and per workspace; context is compressed
  automatically when it outgrows the window, and a turn that hits its step or time limit can
  continue from where it stopped instead of starting over.
- **A permanent column on the right of the chat**: "Files" is this conversation's file area as a
  tree you can expand in place and preview by clicking; "Web" offers two modes — embed the original
  page, or read the article body we fetched — with a probe picking the default and you free to
  override it either way. The panel is part of the page, not an overlay, so the chat on the left
  stays readable and scrollable.
- **Notes and memory**: notes are rich text (images, task lists, pasted screenshots) with Markdown
  as the single source of truth; memory is a Markdown profile on disk (persona plus standing facts)
  that stays readable and editable even with the memory service switched off.
- **Capabilities**: skills (`SKILL.md`, progressively expanded) and external MCP servers, admitted
  in four tiers — allow / deny / ask / sandbox. The `ask` tier genuinely stops and asks you; if
  nobody answers it says so, instead of letting that read as "the user refused".
- **Workspaces and sandbox**: projects hold conversations; the sandbox gives execution tools a
  restricted directory and refuses to run without isolation. The two are separate things.
- **Work that happens on schedule**: scheduled tasks (cron or one-shot) live in the task center,
  run a full turn when they fire, and drop the result into a conversation.
- **Office deliverables**: docx / xlsx / pptx / pdf written as files you can hand to someone else;
  they arrive together with the answer at the end of the turn.
- **Where the data is**: conversations, messages, events, artifacts, notes, memory and settings all
  live on this machine in `%APPDATA%\com.kylab.desktop\kylab.db` (SQLite with WAL); workspaces and
  memory are files in the same directory. Long-lived credentials (model keys) go into the system
  keychain — empty in the database, never in logs.

**Not doing**: visual orchestration, workflow engines, collaborative document editing; no real-time
cross-machine sync — moving between machines goes through backup and restore.

## Running it

The desktop shell is paused for this round (it comes back as a wrapper in a later major version),
so this section only covers the web path. Prerequisites: Python 3.12 (dependencies managed with uv)
and Node 20+.

```sh
# terminal 1: the local backend (sidecar) — chat + all local data, :8765
sh scripts/dev-sidecar.sh

# terminal 2: the frontend, :5173
pnpm --dir frontend install
pnpm --dir frontend dev
```

http://127.0.0.1:5173 is then the complete product. On Windows every `.sh` here has a `.ps1` twin.

- **The sidecar is the local backend**: `sh scripts/dev-sidecar.sh` starts it on `127.0.0.1:8765`,
  listening on this machine only — the chat and all local data live there.
- **Models** are called from this machine with your own key: set the model and key in settings, and
  the key goes into the system keychain.
- Data defaults to the shell's real data directory (same database, same conversations as the
  shell); set `KYLAB_DATA_DIR` for an isolated copy that does not touch it.
- **If the port is taken the sidecar refuses to start** instead of quietly picking another one —
  two instances running at once look like "I changed the backend but the UI still behaves the old
  way".
- `scripts/dev-backend.sh` (`:8000`) runs the **server-profile** backend; you only need it when
  changing the old monolith on the NAS.

Gate scripts: `sh scripts/check-backend.sh`, `sh scripts/check-frontend.sh`, `sh scripts/ci.sh`.

## Repository layout

```
kylab/
├── backend/               Python backend (FastAPI): local-profile entry point app/sidecar.py,
│                          server-profile entry point app/main.py, sharing one services layer;
│                          see backend/README.md
├── frontend/              React 19 + Vite + TS web UI (the current form)
├── desktop/               Tauri 2 desktop shell (paused for this round)
├── shell/                 the shell's built-in boot page: starts the frontend from local
│                          resources, or offers a "change server" entry when it cannot
├── skills/                official skill artifacts (SKILL.md)
├── scripts/               dev / gate / generator scripts (dev-*.sh, check-*.sh, ci.sh, …)
├── docs/                  specs / design / plans-and-records / archive (index: docs/README.md;
│                          written in Chinese)
├── deploy/                legacy deployment artifacts (not needed by the local form)
├── tests/e2e/             where cross-stack E2E goes; a placeholder for now
├── .github/workflows/     GitHub Actions gates (kept for a future mirror)
└── .workflow/             Gitee Go gates (the default carrier)
```

**Iron rule**: every file has exactly one home directory. No loose files in the repository root.

## Quality gates

CI runs on **Gitee Go** (`.workflow/kylab-ci.yml`); the GitHub Actions copy is kept for a future
mirror. Both invoke the **same scripts**, so "green locally, red in CI" cannot happen. Run the one
that matches what you changed:

| Changed | Run |
| --- | --- |
| backend only | `sh scripts/check-backend.sh` — ruff + emoji + layering + API docs and types sync + pytest |
| frontend only | `sh scripts/check-frontend.sh` — eslint + prettier + tsc + vitest + production build + emoji |
| both / wrap-up | `sh scripts/ci.sh` — convention checks + backend tests + frontend tests and build |

- For a single change, `python scripts/affected_tests.py --run` picks the tests to run from the
  reverse dependency graph; the true full suite is for wrapping up a large block, and the report
  gives the full suite's own numbers.
- Backend tests need no external service: storage is local-only (SQLite plus a data directory) and
  every test gets its own temp directory (`cd backend && uv run pytest tests -q`).

Three layering rules are checked mechanically by `scripts/check_layering.py`, not by reviewer memory:

1. `api/` adapts protocols only — no business logic;
2. `services/` never writes SQL — storage access goes through the `storage/` repository interfaces;
3. parser implementations depend only on `ParseResult` from `base.py` and never import each other.

## Contributing

- Branches: `main` is protected, `develop` integrates, `feat/<topic>` and `fix/<topic>` for work;
- Commit messages: `<type>: <summary>`, type limited to `feat/fix/docs/test/refactor/chore`;
- CI must be green before merging — **CI is the final judge**, passing locally is not enough;
- New files follow the decision tree in the
  [engineering spec v0.6](docs/规范/项目工程规范-v0.6.md) §7, and tests follow §5.1; which folder a
  document belongs in is covered by [`docs/README.md`](docs/README.md).

## License

[MIT](LICENSE)
