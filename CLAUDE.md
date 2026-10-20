# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Project guidance for Claude Code. Auto-loaded; keep it accurate and non-duplicative —
`README.md`, `CONTRIBUTING.md` and `docs/` remain the single source of truth for prose.

## Overview

Meerkat TaskPanel is a **local-first task board for AI-agent teams**: agents claim work, send
heartbeats, report progress and roll results up a dependency tree, while humans watch the
same state on a kanban board (deliberately read-only). Persistence is a single SQLite
database (Node's built-in `node:sqlite`) — no external services. Node **>= 22**,
**zero runtime dependencies**, MIT, public repo.

**Status (honest):** the engine has landed in full — the core engine, the `taskctl` CLI and
its local `taskd`, the six-host installers, and the board HTTP API + SSE plus the `web/`
frontend. `src/core/` has the domain model, SQLite storage
+ migrations, use-cases and `openBoard()`; `src/cli/` is the real `taskctl` command surface
and auto-starts the local `taskd` (`TASKD_NO_AUTOSTART=1` disables it); `src/server/` is the
board HTTP API + SSE; `web/` is the Vue 3 + Vite frontend that builds to `web/dist` and is
served by `taskd`. Still planned: the **epic view** and **iteration management** — the
roadmap lives in `README.md` / `README.zh-CN.md`.

The agent integration is **skill-only**, driving the `taskctl` CLI (see `docs/install.md`).
The board owns the workflow decisions (`issue reconcile --workflow`); the loop executes the
resulting plan. The host-external supervisor is a **skill of its own**
(`skills/meerkat-loop/`), never installed for OpenClaw and **not** distributed through the
marketplace: `install.sh --target claude|codex|pi` is its only path, and it carries no
version of its own.

## How to work here

**Decompose before executing.** Any request that is more than a couple of tool calls gets a
todo list first (TodoWrite): one item per independently verifiable step — a test that must go
green, a file to change, a gate to run — kept current while you work (exactly one
`in_progress`). Write the list before editing; if the decomposition changes, rewrite the list
rather than drifting along with a stale plan. A step is done when its own check is green, not
when the edit lands.

**Default to TDD.** Failing test first (red), smallest change that makes it pass (green),
then refactor. Prefer extending the test file that already owns the behaviour — `test/contract/**`
for invariants, `test/core/**`, `test/server/**`, `test/concurrency/**`, `test/web/**`,
`test/install/**` — over adding a parallel file; for the browser/DOM layer add legs to
`test/web/blocks.dom.test.mjs` rather than a second browser file, which flakes the shared
harness. Turn a reported bug into a red test before fixing it.

**Then verify in the right place.** The host-static checks below are the iteration loop. The
authoritative gate is `npm run verify:docker`, and it bakes the tree it finds at build start —
**commit before you run it**.

**Finish by confirming with the user.** Do not declare a task complete, integrate it, or
delete anything on your own initiative. Confirm first, then integrate and clean up per the
section below.

## Branch & worktree workflow

**`dev` is the only development branch** — never invent a second long-lived development
branch, and branch parallel work off `dev`. `main` is the release line: it advances by
merging `dev`, and only after the user has confirmed.

- **A parallel task gets a worktree, not another branch in this checkout:**
  `git worktree add .worktrees/<slug> -b <branch> dev`. One worktree per task; the primary
  checkout stays where it is, and the tree lives under the checkout's gitignored
  `.worktrees/` (also dockerignored, so it never enters the image's build context). Before
  creating one, follow the `using-git-worktrees` skill's Step 0 (isolation detection);
  `.worktrees/` here is the declared preference that skill honors over its own default.
  (The board's own lanes — `lane/<ref>-segN` — are the automated instance of this pattern;
  older ones live beside the checkout and you will find them in `git worktree list`.)
- **Report, confirm, then integrate.** When the work is done, say so and wait — the user
  decides whether it lands. Nothing here is self-closing.
- **On confirmation, land it into `dev` and clean up** (a worktree *and* any branch that is
  not `dev`):
  1. commit every path you touched first (`git commit -- <path>`): a worktree with
     uncommitted changes cannot be removed without `--force`, and a dirty tree is not what
     the container gate sees;
  2. merge into `dev` — `git checkout dev && git merge --no-ff <branch>` — and resolve
     conflicts against `dev`;
  3. remove the worktree, *then* delete the branch — `git worktree remove <path>` followed by
     `git branch -d <branch>` from the primary checkout. The order is load-bearing: git
     refuses to delete a branch that is still checked out in a worktree. Use `-d`, not `-D`
     (which would silently discard an unmerged branch); if `-d` refuses, the merge did not
     land and that is the finding;
  4. re-run the gate on the integration result (`npm run check`, then `npm run verify:docker`
     after committing) — a merge produces a new tree, and green on the branch does not
     transfer to it.

The log contains `lane/… → main` merges from before this rule; treat the section above as the
policy going forward.

## Commands

```bash
node --test                                  # full suite (also: npm test)
node --test test/core/index.test.mjs         # one file
node --test "test/contract/**/*.test.mjs"    # one directory (a bare dir arg does NOT work here)
npm run test:coverage                        # tap reporter + 80% line/branch/function floors
npm run check                                # check:skills + verify + test (fast, host-static)
npm run verify                               # manifests + skill + migrations + paths + signposts checkers
npm run verify:docker                        # AUTHORITATIVE gate: build image + in-container suite
npm run verify:docker:container              # run docker/verify-in-container.sh inside the image
node scripts/sync-skills.mjs                 # regenerate the loop payload + plugin skill copies
node scripts/build.mjs                       # produce dist/ (the npm release tree; deletes + recreates)
node scripts/verify/contract.mjs             # API contract snapshot; --update refreshes it, drift exits 1
node scripts/verify/cli-contract.mjs         # CLI surface snapshot (commands/flags/envelope); --update
node scripts/verify/route-request.mjs        # declared request schema vs what the handler reads; --print
node src/server/main.mjs                     # start taskd directly (taskctl also auto-starts it)
bash install.sh --target claude|openclaw|codex|pi|opencode|cursor|all   # --prefix --link --force --dry-run
```

`test:coverage` gates `src/core/**`, `src/shared/**`, `src/cli/**` and `src/server/**`; the
floors live once, in `package.json`. Other checkers: `verify:migrations`, `verify:changelog`.

## Repository layout

```text
meerkat-taskpanel/
├── src/core/               # engine: domain (no Node builtins), storage (SQLite + migrations,
│                           #   repositories, md export), commands (use-cases), bootstrap.openBoard()
├── src/cli/                # taskctl (argv, usage, commands/, output/); reaches taskd via shared/transport
├── src/server/             # taskd: auth + CIDR, router, routes/, sse, static, writer lock, graceful stop
├── src/shared/             # DTOs, constants, errors, pure helpers + the taskd transport seam
├── web/                    # Vue 3 + Vite board frontend (own lockfile) -> web/dist, served by taskd
├── skills/                 # the two skills: meerkat-taskpanel (board), meerkat-loop (supervisor)
├── .claude-plugin/ .pi/ .opencode/ .cursor-plugin/   # harness markers; the plugin root IS the repo root
├── design/                 # DESIGN / BLOCKS, the interactive prototype/, brand/, assets/, fidelity-rNN.md
├── scripts/                # build, install/, sync-skills + sync-loop, supervisor, verify/{manifests,skill,
│                           #   migrations,paths,contract,cli-contract,route-request,changelog,version,docker,…}
├── docker/                 # Dockerfile (webbuild stage + runtime), compose, profiles, verify-in-container.sh
├── monitoring/             # OTel / Prometheus exporter
├── test/                   # contract, core, concurrency, server, web, install, scheduling, verify, skill, design
├── docs/                   # install, development, docker, contract, migration, scheduling, observability,
│                           #   projects, publishing, security, web-local-first
└── .githooks/              # pre-commit / pre-push / pre-tag — offline gates (see below)
```

`dist/`, `.data/`, `node_modules/` and `coverage/` are build/runtime output — gitignored,
never committed. Mind the two different `dist` trees: `dist/` is the **npm release tree**
that `scripts/build.mjs` writes (and a stale M0 `dist/web/.gitkeep` placeholder lives there);
the **hosted frontend root** is `web/dist`, the static build of `web/` that `taskd` serves
(`STATIC_DIR_REL`). They are not the same directory.

## Constraints / MUST-follow rules

- **Verification runs inside Docker, not on the host.** Everything that *runs* — tests,
  starting or serving the app, the CLI, host skill installs, plugin installs, migration
  rehearsals — runs in the container (`npm run verify:docker`, `docker/verify-in-container.sh`).
  Host-allowed (static/pure only, per `docs/docker.md` §Host-allowed checks): `node --test`,
  `node --check`, the `scripts/verify/*` checkers, `git` and file inspection, prototype
  screenshots, and the browser-rendered `web/` DOM/selector checks (the image has no Chromium).
- **Runtime zero-dependency, no network.** The engine and every script and test use Node
  builtins only and work fully offline. Do not run `npm install` for them: there is no root
  lockfile and no root `node_modules/`.
- **`web/` is the one exception, and it is build-time only.** Its committed
  `web/package-lock.json` + committed npm cache at `web/.vendor/npm-cache` let the image's
  `webbuild` stage run `npm ci --offline`, so the image builds with no network. The cache is a
  **generated artefact** (linux/arm64) — after a dependency bump, re-vendor per `docs/docker.md`
  and commit the refreshed cache with the lockfile. Never install frontend deps into the repo root.
- **The skills are generated, never hand-edited.** Author only under `skills/meerkat-taskpanel/`
  and the loop's hand-written surface (`skills/meerkat-loop/`: `SKILL.md`, `references/`,
  `scripts/board-check.mjs`). The loop's `manifest.txt` + `scripts/` (except the gate) +
  `src/` + `templates/` are generated from `scripts/supervisor.mjs`, `scripts/loop/`,
  `scripts/wake-cwd.mjs`, `src/shared/` and
  `scripts/install/templates/` (the workflow decisions live in
  `src/core/domain/workflow.mjs` and are not in the body — the loop gets them from
  `issue reconcile --workflow`). After any edit touching those inputs run
  `node scripts/sync-skills.mjs`; CI runs `--check` and fails on drift. There are **no committed
  copies of a skill** anywhere: `skills/` is the only `skills` tree in the repository, and
  `test/scaffold.test.mjs` asserts it.
- **Migrations are append-only.** Never edit or delete a committed
  `src/core/storage/migrations/*.sql`; add a new numbered file. The DB runner refuses a database
  whose applied file changed, and adding a migration reds several hand-kept version lists — see
  `npm run verify:migrations` and `docs/migration.md`.
- **The contracts are explicit.** A route, error code or wire-field change must update
  `test/fixtures/contract/api.snapshot.json` via `node scripts/verify/contract.mjs --update` —
  never let it drift. Adding a new `DomainError` code touches `ERROR_CODES`, its bucket and that
  snapshot. A command, positional or flag change must update
  `test/fixtures/contract/cli.snapshot.json` via `node scripts/verify/cli-contract.mjs
  --update`, and `skills/meerkat-taskpanel/references/cli.md` must name every frozen command
  and flag — the loop and user scripts bind to that surface.
- **Commit with explicit paths:** `git commit -- <path>` (never a bare `git commit -a`).
- **Code style / layering:** `src/core/domain/` imports **no Node builtins**; dependency
  direction is `cli|server -> core -> shared` (nothing imports from `cli`/`server`; `shared`
  imports nothing from `src/`); every failure is a domain error with a code, never a bare `Error`.
- **`design/` is a live oracle.** Prototype pages under `design/prototype/` are read by tests
  (`test/design/`, `test/web/blocks.*`, `test/web/i18n.catalogue.test.mjs`), so editing them
  changes what green means. `design/` is excluded from the image by `.dockerignore`, so
  design-derived tests self-skip inside Docker — do not read that skip as a pass.
- **`ARCHITECTURE.md` is not in this tree** (and never has been), yet `src/**`, `scripts/**`,
  `test/**`, `docs/**` and `design/**` cite it by section (`ARCHITECTURE §4.6`, `§7.1`, …).
  Those citations are historical orientation only — none resolves to a file. Project ordering
  lives in `design/DESIGN.md` §20; do not add a new `ARCHITECTURE.md` citation, name the live
  document instead. See `docs/README.md`.

## Git hooks (offline gates, run on the host)

A fresh clone has none until `git config core.hooksPath .githooks` (do **not** run `npm install`
to get them). Hook and CI run the same checkers:

| Hook | Enforces |
|---|---|
| `pre-commit` | migrations append-only, contiguous from `0001`, none edited or deleted (`verify/migrations.mjs`) |
| `pre-push` | contract snapshot matches the live surface; declared request schema equals what the handler reads; no tracked file carries a host-absolute path (`verify/paths.mjs`) or a signpost out of the repository (`verify/signposts.mjs`); every pushed `refs/tags/vX.Y.Z` has a `## [X.Y.Z]` CHANGELOG section |
| `pre-tag` | the same API + tag rules, run by hand before `git tag` (git has no native pre-tag hook) |

Two workflows guard the tree itself. `paths-gate.yml`: a host-absolute `/Users/<someone>/…`
path fails the build — its allowlist (`test/fixtures/host-paths-allowlist.json`) is checked in
both directions. `signposts-gate.yml`: a walkable path into an external framework's private
store, or one of its internal mechanism names, fails the build — its allowlist
(`test/fixtures/framework-signposts-allowlist.json`) is keyed by `{file, rule}` and checked in
both directions too. The rule behind the second is `design/contracts/naming-boundary.md`
(which is **retired and narrowed**, not the unexecuted work order it once was); CI is its
authoritative home, because the container image drops `design/`.

## Key invariants to remember

- **One config file at the install root.** `.env` (gitignored and dockerignored) is read by
  both `taskd` and `taskctl`; the process environment wins key by key and CLI flags win above
  both. `--env-file` / `MEERKAT_TASKPANEL_ENV_FILE` selects another path. The old
  `<dataDir>/taskd.env` is no longer read (hard switch). Identity (`--actor-kind`) is required
  on every command except `--help` / `--version`; `--agent` names the role and is not a
  shared-file key.
- The **delivery gate** requires a report **for the current delivery round** before a card can
  move to `in_review`; a report from an earlier round is history, not evidence. It is enforced by
  a DB trigger *and* a domain check, tested against each other under `test/contract/`. There is
  one narrow escape hatch (M2, F-B1): `--no-report --reason "<why>"` (reason ≥ 8 characters,
  mutually exclusive with `--report-file`, only on a move to `in_review`, recorded as a
  `report_waived` activity, valid only for the current delivery round).
- Invariants are pushed **down into the database** (triggers), not only enforced in the app layer.
- **Single writer.** One local service owns the SQLite file: `taskd` takes `<dataDir>/writer.lock`
  with `O_EXCL` *before* opening the DB, refuses a second instance with `BOARD_ALREADY_RUNNING`,
  and removes a fossil lock whose pid is gone. Write-lock contention past `busy_timeout` (pinned
  5 s) is a bounded retry, then `503 DB_BUSY` + `Retry-After: 1` — never a 500.
- **The board holds no project directory.** A project carries no `workspace_path`, the CLI has no
  `context` command (`src/core/commands/context.mjs` is actor/execution context, unrelated) and no
  registry `root` anchor; a card's `target` is an opaque per-card value, never derived from a
  project. The directory↔project map lives in a `projects.json` beside the installed skill
  (`skills/meerkat-taskpanel/references/projects-json.md`); whether a project's source data is
  managed with `meta` is the agent's own decision and taskpanel neither prescribes nor advises it.
  An entry names its directory as `local_path`, else as the `run_dir` launch pad, or names **none** —
  a project with no local directory is a complete answer (`dir: null`, exit 0), distinct from the
  `PROJECT_DIR_UNMAPPED` "no entry — ask the user" case; a *wake* needs a directory, so it refuses
  both of those. Both keys are **worker** directories, not data locations — where a task's results
  live is the business's call, and the entry's other keys (the metadata an agent reads) are the
  business's to define, never validated or interpreted here.
- **Auth:** a loopback caller is trusted; a remote caller must be inside `TASKD_ALLOW_CIDRS` and
  present the token. `POST /token` is loopback-only. The built board injects no token, so serving
  it to a remote browser is 401 by design (`docs/web-local-first.md`).
- **Stopping `taskd`:** `SIGTERM`/`SIGINT` is graceful and bounded — it ends SSE streams with a
  named `shutdown` frame before closing, because `/api/v1/events` never ends on its own.

## Docs to read next (do not re-paste)

- `GLOSSARY.md` — the canonical vocabulary: one word per concept, the words to avoid, and the terms that are *not* in the model.
- `README.md` / `README.zh-CN.md` — what the project is, install, roadmap.
- `CONTRIBUTING.md` — the container gate, PR flow, conventions the gates enforce.
- `docs/development.md` — layout, commands, the two build layers, skills generation, constraints.
- `docs/docker.md` — why verification is containerised, build/run, profiles, host-allowed checks.
- `docs/contract.md` — the API and CLI contract snapshots + route-request lint.
- `docs/migration.md`, `docs/scheduling.md`, `docs/observability.md`, `docs/security.md` — the named subsystems.
- `src/core/README.md` — what the core engine owns and the rules it enforces.
