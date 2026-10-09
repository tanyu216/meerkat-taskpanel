# CLAUDE.md

Project guidance for Claude Code. Auto-loaded; keep it accurate and non-duplicative —
`README.md` and `docs/` remain the single source of truth for prose.

## Overview

Task Panel is a **local-first task board for AI-agent teams**: agents claim work, send
heartbeats, report progress and roll results up a dependency tree, while humans watch the
same state on a kanban board. Persistence is a single SQLite database (Node's built-in
`node:sqlite`) — no external services. Node **>= 22**, **zero runtime dependencies**,
MIT, public repo.

**Status (honest):** **M1** (core engine), **M2** (the `taskctl` CLI + a minimal loopback
`taskd`) and **M3** (the stdio MCP server) have landed. `src/core/` has the domain model,
SQLite storage + migrations, use-cases and `openBoard()`; `src/cli/` is the real `taskctl`
command surface and auto-starts the local `taskd` (`TASKD_NO_AUTOSTART=1` disables it);
`src/server/` is that minimal loopback HTTP `taskd`; and `src/mcp/` is a real stdio MCP
server — 18 frozen tools, a thin proxy to `taskd`, gate-equivalent (`task_deliver` is the
only tool that reaches `in_review`; no dictionary-management tools). Still planned (M6):
the full board HTTP API + SSE backend and the `web/` board frontend. See `src/mcp/README.md`
and the roadmap in `README.md` / `README.zh-CN.md`.

## Repository layout

```text
task-panel/
├── package.json            # bin(taskctl), scripts; type:module; engines node>=22
├── install.sh              # install dispatcher: --target claude|openclaw|codex|pi|all
├── src/
│   ├── core/               # engine: domain model, SQLite storage, commands, bootstrap
│   │   ├── domain/         #   entities, state machine, invariants, delivery gate (no Node builtins)
│   │   ├── storage/        #   driver, migrations, repositories, secrets, md import/export
│   │   ├── commands/       #   use-cases
│   │   └── bootstrap.mjs   #   openBoard()
│   ├── cli/                # taskctl CLI (command surface; reaches taskd through shared/transport)
│   ├── mcp/                # stdio MCP server (M3; 18 tools, thin proxy to taskd)
│   ├── server/             # minimal loopback taskd (CLI auto-start); full HTTP API + SSE board backend = M6
│   └── shared/             # DTOs, constants, errors, pure helpers + the taskd transport seam (shared/transport/**)
├── web/                    # board frontend (Vue 3 + Vite): build-time devDeps -> web/dist (README placeholder)
├── skills/task-panel/      # the skill — single source of truth (author here)
├── plugins/{claude,codex,openclaw,pi}/  # per-host manifests + generated skills/ copies
├── design/                 # brand assets, tokens; prototype/assets + PRD/DESIGN/BLOCKS are placeholders
├── prototype/              # HTML + Tailwind/daisyUI prototype + screenshots (visual baseline)
├── scripts/                # build, install/, sync-skills.mjs, verify/{manifests,skill,profiles,docker}
├── docker/                 # containerised verify env: Dockerfile, docker-compose.yml, profiles/, serve-skeleton.mjs, verify-in-container.sh
├── test/                   # contract, core, concurrency, scaffold tests + fixtures
├── docs/                   # install.md, development.md, docker.md, README.md
└── .github/workflows/      # CI: check.yml (host static + container jobs), release.yml
```

`dist/`, `.data/`, `node_modules/` and `coverage/` are build/runtime output — gitignored,
never committed. Directories or files listed above but not present in a given checkout are
planned, not implemented (e.g. `design/` has `brand/` only; there is no PRD/DESIGN/BLOCKS
file yet; `web/` is still a README placeholder — its workspace lands with M6b).

Mind the two different `dist` trees: `dist/` is the **npm release tree** that
`scripts/build.mjs` writes; the **hosted frontend root** is `web/dist`, the static build of
`web/` that `taskd` serves (`STATIC_DIR_REL`). They are not the same directory.

## Commands

- `npm test` (`node --test`) — smoke / contract / unit suite.
- `npm run check` (`check:skills` + `verify` + `test`) — the full local gate.
- `npm run verify:docker` — containerised verification entry (build image + in-container suite + compose health smoke; always tears down).
- `npm run verify:docker:container` — run `docker/verify-in-container.sh` when already inside the image.
- `npm run check:skills` (`node scripts/sync-skills.mjs --check`) — assert generated skill copies match `skills/`.
- `npm run build` (`node scripts/build.mjs`) — produce `dist/` (deletes and recreates it).
- `npm run test:coverage` — `node --test` with an 80% line/branch/function floor on `src/core/**` + `src/shared/**`.
- `node src/core/storage/md/migrate-cli.mjs check --dir <cards>` — md-card migration check (also `import` / `export`; exit 3 when `check` finds differences).
- `bash install.sh --target claude|openclaw|codex|pi|all` — install the skill into each host's skill directory (flags: `--prefix`, `--link`, `--force`, `--dry-run`).
- `taskctl` (`bin` → `src/cli/index.mjs`) — the CLI (`project`, `issue`, `comment`, `relation`, `session`, `report`, `export`, `token`, … groups; auto-starts the local `taskd`).

## Constraints / MUST-follow rules

- **Verification runs inside Docker, not on the host.** Everything that *runs* — unit/integration/e2e tests, starting or serving the app, the CLI, host skill installs, plugin/bundle installs, migration rehearsals — must run in the container (`docker/`, `npm run verify:docker`, `docker/verify-in-container.sh`). Only pure static checks (lint/typecheck, `node --check`, text/static assertions, `git` operations) and prototype screenshots may run on the host.
- **Runtime zero-dependency, no network.** The engine — `src/core/`, `src/cli/`, `src/server/`, `src/mcp/` — and every script and test use Node builtins only and work fully offline. Do not run `npm install` for them: there is no root lockfile and no `node_modules/` is expected.
- **`web/` is the one exception, and it is build-time only.** The board frontend (Vue 3 + Vite + Tailwind/daisyUI) has its own `web/package.json` + committed `web/package-lock.json`, installed with a plain `npm ci` in the image's `webbuild` stage (**F1-g**). That stage — and only that stage — needs network; the runtime image and all verification stay offline, and the committed lockfile pins the build. Strict-offline image builds would require vendoring the npm cache (the rejected F1-c). Nothing from `web/` reaches the runtime image — the hosted artefact is the static `web/dist` that `taskd` serves (`STATIC_DIR_REL`). Never install frontend deps into the repository root.
- **The skill is generated, never hand-edited.** Author only under `skills/task-panel/`. After any edit run `node scripts/sync-skills.mjs`; `plugins/*/skills/` are generated copies that must stay identical (`--check` fails CI on drift).
- **Single writer.** The design assumes one local service owns the SQLite file — avoid concurrent writers against the same database.
- **Commit with explicit paths:** `git commit -- <path>` (never a bare `git commit -a`).
- **Code style / layering:** `src/core/domain/` imports **no Node builtins**; dependency direction is `cli|mcp|server -> core -> shared` (nothing imports from `cli`/`mcp`/`server`; `shared` imports nothing from `src/`); every failure is a domain error with a code, never a bare `Error`.

## Key invariants to remember

- The **delivery gate** requires a report **for the current delivery round** before a card can move to `in_review`; a report from an earlier round is history, not evidence. It is enforced by a DB trigger *and* a domain check, tested against each other. There is one narrow escape hatch (**M2**, F-B1): a documented, audited waiver — `--no-report --reason "<why>"` (reason of at least 8 characters, mutually exclusive with `--report-file`, only valid on a move to `in_review`, recorded as a `report_waived` activity, valid only for the current delivery round). The normal, compliant path remains writing a report. The **MCP surface is stricter**: `task_move` carries no waiver, so `task_deliver` is the only tool that reaches `in_review`.
- Invariants are pushed **down into the database** (triggers), not only enforced in the app layer; the trigger and the domain check are tested against each other under `test/contract/`.
- The service model is **single-writer**: one local service owns the SQLite database.

## Docs to read next (do not re-paste)

- `README.md` / `README.zh-CN.md` — what the project is, install, roadmap.
- `src/mcp/README.md` — what the stdio MCP server owns (and refuses to own), the 18 tools, protocol decisions.
- `docs/install.md` — `install.sh` flags, host destinations, uninstall.
- `docs/development.md` — layout, Node requirement, commands, no-network/no-dependency policy.
- `docs/docker.md` — why verification is containerised, build/run, profiles, troubleshooting.
- `src/core/README.md` — what the core engine owns and the rules it enforces.
