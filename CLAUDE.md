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
authoritative gate is `npm run verify:docker`, and it runs from `.githooks/pre-push` on every
branch push (and again in CI), so a merge is not a container-gate moment any more — push the
result and the hook bakes it. The gate bakes the **working tree** at build start, so **commit
before you push**; a dirty tracked tree is announced and included. Run it by hand only when you
want the verdict before committing or the hook is not installed; `SKIP_CONTAINER_VERIFY=1 git
push …` skips it for one push.

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
  (The loop creates this pair itself for every card in a git project, per round:
  `.worktrees/<ref>[-r<round>]` on `lane/<ref>[-r<round>]`, based on the project's declared
  `base_ref` (else its current branch). Acceptance merges the lane branch back into the
  project's current branch before the card reaches `done`; cleanup removes the worktree,
  then the merged branch. Older `lane/<ref>-segN` worktrees live beside the checkout and you
  will find them in `git worktree list`.)
- **Report, confirm, then integrate.** When the work is done, say so and wait — the user
  decides whether it lands. Nothing here is self-closing.
- **On confirmation, land it into `dev` and clean up** (a worktree *and* any branch that is
  not `dev`):
  1. commit every path you touched first (`git commit -- <path>`): a worktree with
     uncommitted changes cannot be removed without `--force`, and the container gate at
     `pre-push` bakes the working tree — commit first;
  2. merge into `dev` — `git checkout dev && git merge --no-ff <branch>` — and resolve
     conflicts against `dev`; **do not edit `CHANGELOG.md` here** — it is written later, at
     the `dev` → `main` merge;
  3. remove the worktree, *then* delete the branch — `git worktree remove <path>` followed by
     `git branch -d <branch>` from the primary checkout. The order is load-bearing: git
     refuses to delete a branch that is still checked out in a worktree. Use `-d`, not `-D`
     (which would silently discard an unmerged branch); if `-d` refuses, the merge did not
     land and that is the finding;
  4. re-run the host-static gate on the integration result (`npm run check`) — a merge produces
     a new tree, and green on the branch does not transfer to it. The container gate is no
     longer part of the merge step: it runs at `pre-push` when the result is pushed.

The log contains `lane/… → main` merges from before this rule; treat the section above as the
policy going forward.

### CHANGELOG.md is written only on the release branch

`CHANGELOG.md` is the release line's record, not a work log. Write it **only** on the
release branch (`release/vX.Y.Z`, the PR `workflow_dispatch release-prep` opens to `main`)
after the user has confirmed the release — that branch *is* the `dev` → `main` integration —
and derive the entries from what that merge actually contains:

```sh
git log --no-merges --reverse <last-release-tag>..dev   # first release: main..dev
git diff --stat <last-release-tag>..dev
```

- Never add entries on a feature branch, in a worktree, or on `dev` itself. `[Unreleased]`
  stays empty between releases.
- A release merge writes (or updates) the `## [X.Y.Z] - YYYY-MM-DD` section from that diff.
  Group the user-visible outcomes under Keep a Changelog's `Added` / `Changed` / `Removed` /
  `Fixed`; no commit hashes, no card ids. Internal-only changes may be omitted.
- Bump the version carriers in the same merge, then tag. The tag gate
  (`scripts/verify/changelog.mjs`) still requires the matching section before a `vX.Y.Z`
  tag is cut — the timing rule above is what makes that section exist.
- Once a version section is on `main`, treat it as frozen (the same spirit as migrations);
  only typo fixes are allowed.
- `npm run release:bump <version> --changelog` creates an **empty** scaffold; filling it from
  the diff is part of that same release merge.

## Commands

```bash
node --test test/core/index.test.mjs         # one file
node --test "test/contract/**/*.test.mjs"    # one directory (a bare dir arg does NOT work here)
node scripts/verify/contract.mjs             # API contract snapshot; --update refreshes it, drift exits 1
node scripts/verify/cli-contract.mjs         # CLI surface snapshot (commands/flags/envelope); --update
node scripts/verify/route-request.mjs        # declared request schema vs what the handler reads; --print
node src/server/main.mjs                     # start taskd directly (taskctl also auto-starts it)
bash install.sh --target claude|openclaw|codex|pi|server|all   # --prefix --link --force --dry-run --skip-web-build
npx meerkat-taskpanel [install] [--target …] [--no-server] [--prefix <home>]   # defaults to all: server + every agent
```

`test:coverage` gates `src/core/**`, `src/foundation/**`, `src/cli/**` and `src/server/**`; the
floors live once, in `package.json`. Other checkers: `verify:migrations`, `verify:changelog`.

## Repository layout

`dist/`, `.data/`, `node_modules/`, `coverage/` and `.meerkat/` are build/runtime output —
gitignored, never committed. `.meerkat/<identifier>/` is the loop's per-task process
directory under a project's working directory: `card.md` (kept fresh by the hub watch,
never hand-edited), the subagent's notes/evidence, and downloaded attachments. Mind the two
different `dist` trees: `dist/` is the **npm release tree**
that `scripts/build.mjs` writes (and a stale M0 `dist/web/.gitkeep` placeholder lives there);
the **hosted frontend root** is `web/dist`, the static build of `web/` that `taskd` serves
(`STATIC_DIR_REL`). They are not the same directory. `web/dist` is gitignored yet **in the
npm `files` whitelist** — the published tarball is a runnable board, not a source drop, and
the release workflow stages the image's build there before `npm pack`.

## Constraints / MUST-follow rules

- **Verification runs inside Docker, not on the host.** Everything that *runs* — tests,
  starting or serving the app, the CLI, agent skill installs, plugin installs, migration
  rehearsals — runs in the container (`npm run verify:docker`, `docker/verify-in-container.sh`).
  `.githooks/pre-push` runs that gate on every branch push, so the push itself is the merge-time
  container check. Host-allowed (static/pure only, per `docs/docker.md` §Host-allowed checks):
  `node --test`, `node --check`, the `scripts/verify/*` checkers, `git` and file inspection,
  prototype screenshots, and the browser-rendered `web/` DOM/selector checks (the image has no
  Chromium).
- **Runtime zero-dependency, no network.** The engine and every script and test use Node
  builtins only and work fully offline. Do not run `npm install` for them: there is no root
  lockfile and no root `node_modules/`.
- **`web/` is the one exception, and it is build-time only.** Its committed
  `web/package-lock.json` + committed npm cache at `web/.vendor/npm-cache` let the image's
  `webbuild` stage run `npm ci --offline`, so the image builds with no network. The cache is a
  **generated artefact** (linux/arm64) — after a dependency bump, re-vendor per `docs/docker.md`
  and commit the refreshed cache with the lockfile. Never install frontend deps into the repo root.
- **The skills are authored source, never generated.** `skills/meerkat/`,
  `skills/meerkat-loop/` (docs + decisions only) and `skills/setup-meerkat/` (standalone)
  are edited in place; there is no payload generator and no `manifest.txt`. The loop itself
  is `src/orchestrator/` (the workflow decisions live in
  `src/core/domain/workflow.mjs`; the loop gets them from `issue reconcile --workflow`).
  There are **no committed copies of a skill** anywhere: `skills/` is the only `skills`
  tree in the repository, and `test/scaffold.test.mjs` asserts it.
- **Migrations are append-only.** Never edit or delete a committed
  `src/core/storage/migrations/*.sql`; add a new numbered file. The DB runner refuses a database
  whose applied file changed, and adding a migration reds several hand-kept version lists — see
  `npm run verify:migrations` and `docs/migration.md`.
- **The contracts are explicit.** A route, error code or wire-field change must update
  `test/fixtures/contract/api.snapshot.json` via `node scripts/verify/contract.mjs --update` —
  never let it drift. Adding a new `DomainError` code touches `ERROR_CODES`, its bucket and that
  snapshot. A command, positional or flag change must update
  `test/fixtures/contract/cli.snapshot.json` via `node scripts/verify/cli-contract.mjs
  --update`, and `skills/meerkat/references/cli.md` must name every frozen command
  and flag — the loop and user scripts bind to that surface.
- **Commit with explicit paths:** `git commit -- <path>` (never a bare `git commit -a`).
- **Code style / layering:** `src/core/domain/` imports **no Node builtins**; dependency
  direction is `cli|server -> core -> foundation` (nothing imports from `cli`/`server`;
  `foundation` imports nothing from `src/`); every failure is a domain error with a code,
  never a bare `Error`.
- **`design/` is a live oracle.** Prototype pages under `design/prototype/` are read by tests
  (`test/design/`, `test/web/blocks.*`, `test/web/i18n.catalogue.test.mjs`), so editing them
  changes what green means. `design/` is excluded from the image by `.dockerignore`, so
  design-derived tests self-skip inside Docker — do not read that skip as a pass.
- **`ARCHITECTURE.md` is not in this tree** (and never has been), yet `src/**`, `scripts/**`,
  `test/**`, `docs/**` and `design/**` cite it by section (`ARCHITECTURE §4.6`, `§7.1`, …).
  Those citations are historical orientation only — none resolves to a file. Project ordering
  lives in `design/DESIGN.md` §20; do not add a new `ARCHITECTURE.md` citation, name the live
  document instead. See `docs/README.md`.

## Git hooks (gates, run on the host)

A fresh clone has none until `git config core.hooksPath .githooks` (do **not** run `npm install`
to get them). Hook and CI run the same checkers:

| Hook | Enforces |
|---|---|
| `pre-commit` | migrations append-only, contiguous from `0001`, none edited or deleted (`verify/migrations.mjs`) |
| `pre-push` | contract snapshot matches the live surface; declared request schema equals what the handler reads; no tracked file carries a host-absolute path (`verify/paths.mjs`) or a signpost out of the repository (`verify/signposts.mjs`); the four version carriers agree (`verify/version.mjs`); every pushed `refs/tags/vX.Y.Z` names that version, is on `main` (`verify/tag-version.mjs`), and has a **filled** `## [X.Y.Z] - YYYY-MM-DD` section (`verify/changelog.mjs --strict`); `main` is not pushed directly; **then the container gate** (`npm run verify:docker`) on a branch push — skipped for a tag-only push or a branch deletion, and by `SKIP_CONTAINER_VERIFY=1` |
| `pre-tag` | the same API + tag rules, run by hand before `git tag` (git has no native pre-tag hook) |

Two jobs in `check.yml` guard the tree itself. `paths`: a host-absolute `/Users/<someone>/…`
path fails the build — its allowlist (`test/fixtures/host-paths-allowlist.json`) is checked in
both directions. `signposts`: a walkable path into an external framework's private
store, or one of its internal mechanism names, fails the build — its allowlist
(`test/fixtures/framework-signposts-allowlist.json`) is keyed by `{file, rule}` and checked in
both directions too. The rule behind the second is `design/contracts/naming-boundary.md`
(which is **retired and narrowed**, not the unexecuted work order it once was); CI is its
authoritative home, because the container image drops `design/`.

## Key invariants to remember

- **One config file at the install root.** `.env` (gitignored and dockerignored) is read by
  both `taskd` and `taskctl`; the process environment wins key by key and CLI flags win above
  both. `--env-file` / `MEERKAT_TASKPANEL_ENV_FILE` selects another path. This file is
  board-facing only: each actor kind also has a **per-kind config**,
  `<program root>/.env.<actor-kind>` (for example `.env.claude`), read by `taskctl` as a
  per-agent default layer (identity, the engine location) and by
  `taskctl loop …` for the loop policy; the loader refuses loop-policy keys here, so the
  two never merge. The one machine-local project map, `projects.json`, sits beside those
  files at the same config root. `--config` overrides it for a loop run, and
  `MEERKAT_TASKPANEL_CONFIG_DIR` relocates the directory (tests, containers, read-only
  roots). The old
  `<dataDir>/taskd.env` is no longer read (hard switch). Identity (`--actor-kind`) is required
  on every command that talks to the board, except `--help` / `--version`, the local read
  `taskctl status` (it reads the runtime pointer, never the board) and the local
  `taskctl project map` actions (they read and write the config-root map, never the board);
  `--agent` names the role
  and is not a shared-file key. The install root is the **running program's** root: the checkout, `/app`
  in the image, or `~/.meerkat-taskpanel` for an installed tree. On a combined install
  (`--target all`, which includes the server, or npm/npx) the agent shims and per-kind config
  name the installed tree (`MEERKAT_TASKPANEL_REPO`, `MEERKAT_TASKPANEL_ENV_FILE`) — never
  the checkout and never the npx cache; `--no-server` installs keep pointing at the checkout.
- **The `taskd` guard follows the same root.** Selecting the server target writes
  `ExecStart` = `<node> <home>/.meerkat-taskpanel/src/server/main.mjs` and pins
  `TASKD_DATA_DIR=<home>/.meerkat-taskpanel/.data` in the unit; without it the unit runs the
  checkout's entry. One guard per machine, and switching layout is a deliberate `--force`
  (a mismatched unit is refused with exit 3, non-fatal).
- **The loop speaks only `taskctl`.** `src/orchestrator/**` never calls the board's HTTP API
  directly — the live event stream is `taskctl events follow` (the local event hub), not
  `fetch`, and the loop carries no board discovery or token code. Board capability detail (invocations,
  JSON keys) lives in `skills/meerkat/references/capabilities.md`; the loop skill
  records decisions only.
- **One local event hub per user and board.** `taskctl events hub` owns the host's single
  SSE connection to a board and fans it out to local consumers (`events follow` and watch
  registrations); it binds loopback, publishes an owner-only pointer, and is started detached
  on demand. `export watch` registers with it (`--detach`), `--standalone` keeps the direct
  stream, and the loop's subscriber consumes `events follow`. The loop's poll **registers the
  card brief before the claim** (`cards[]`, per-card absolute paths, `ttl_ms: 0`) and unregisters
  it if the claim is refused; the hub — not the subscriber — owns every brief write, until the
  card is `done` or `canceled`. The board still never writes a user directory: the hub is a
  client-side process.
- The **delivery gate** requires a report **for the current delivery round** before a card can
  move to `in_review`; a report from an earlier round is history, not evidence. It is enforced by
  a DB trigger *and* a domain check, tested against each other under `test/contract/`. There is
  one narrow escape hatch (M2, F-B1): `--no-report --reason "<why>"` (reason ≥ 8 characters,
  mutually exclusive with `--report-file`, only on a move to `in_review`, recorded as a
  `report_waived` activity, valid only for the current delivery round).
- **A review card is flow B, not a kind.** It is an ordinary `kind=task` card carrying the
  immutable `review_of_id` / `review_round` marker. Every layer reads that identity through
  `src/foundation/review-identity.mjs` (the columns are authority; `meta.review_of` is a
  readable/legacy mirror), so the workflow planners, the SLA patrol and the CLI agree. A
  review card cannot be reopened, cannot be a parent or a child, and cannot itself be
  reviewed; the command layer refuses first, and the `0041` triggers refuse a raw writer.
- Invariants are pushed **down into the database** (triggers), not only enforced in the app layer.
- **Single writer.** One local service owns the SQLite file: `taskd` takes `<dataDir>/writer.lock`
  with `O_EXCL` *before* opening the DB, refuses a second instance with `BOARD_ALREADY_RUNNING`,
  and removes a fossil lock whose pid is gone. Write-lock contention past `busy_timeout` (pinned
  5 s) is a bounded retry, then `503 DB_BUSY` + `Retry-After: 1` — never a 500.
- **The board holds no project directory.** A project carries no `workspace_path`, the CLI has no
  `context` command (`src/core/commands/context.mjs` is actor/execution context, unrelated) and no
  registry `root` anchor; a card's `target` is an opaque per-card value, never derived from a
  project. The project→directory map is **one** machine-local `projects.json` at the config
  root (the program root, or `MEERKAT_TASKPANEL_CONFIG_DIR`), maintained only through
  `taskctl project map` and read through `taskctl project dir`; agents never parse or edit it
  (`skills/meerkat/references/projects-json.md`). Whether a project's source data is
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
- **Diagnostics go through `src/foundation/log.mjs`.** The logger is callable as the long-standing
  `logger({ event, ... })` seam and also carries `.debug/.info/.warn/.error`. `taskd` owns and
  rotates `<dataDir>/logs/taskd.log`; the service units and the lazy start do **not** redirect
  into it. Levels: success is `info` (or `debug` for per-command detail), a 4xx refusal is
  `warn`, a 5xx/unmapped failure is `error`. Logger events are **not** activity events — new
  names go in `EVENT_LEVELS`, never `ACTIVITY_EVENTS`.
- **Stopping `taskd`:** `SIGTERM`/`SIGINT` is graceful and bounded — it ends SSE streams with a
  named `shutdown` frame before closing, because `/api/v1/events` never ends on its own.

## Agent skills

### Issue tracker

Work is tracked as cards on the local Meerkat TaskPanel board; `/meerkat` is the entry for
every card operation. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles keep their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Docs to read next (do not re-paste)

- `GLOSSARY.md` — the canonical vocabulary: one word per concept, the words to avoid, and the terms that are *not* in the model.
- `README.md` / `README.zh-CN.md` — what the project is, install, roadmap.
- `CONTRIBUTING.md` — the container gate, PR flow, conventions the gates enforce.
- `docs/development.md` — layout, commands, the two build layers, skills generation, constraints.
- `docs/docker.md` — why verification is containerised, build/run, profiles, host-allowed checks.
- `docs/contract.md` — the API and CLI contract snapshots + route-request lint.
- `docs/migration.md`, `docs/scheduling.md`, `docs/observability.md`, `docs/security.md` — the named subsystems.
- `src/core/README.md` — what the core engine owns and the rules it enforces.
