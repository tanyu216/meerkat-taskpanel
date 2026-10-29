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

**Work by the team's workflow.** Before starting work a role owns, read the team's
`ownership.md` from the loop's roles root — `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`, else
`<project>/.meerkat/roles/`, else `<agent-dir>/skills/meerkat-loop/roles/` — and follow the
workflow it names for that work shape: for the standard team, Jobs takes product design and UI,
Linus architecture, implementation, refactors and bugs, Turing test design, regression and
performance, and Reviewer independent review. The installed copy is authoritative; the template
under `skills/setup-meerkat/assets/team/standard/` is only what `/setup-meerkat` seeds it from.
The loop injects the guide only for cards it dispatches, so a session taking the work itself
reads it first. The card is still created and delivered through `/meerkat`.

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
  container check. Host-allowed (static/pure only, per `docs/agents/docker.md` §Host-allowed checks):
  `node --test`, `node --check`, the `scripts/verify/*` checkers, `git` and file inspection,
  prototype screenshots, and the browser-rendered `web/` DOM/selector checks (the image has no
  Chromium).
- **Runtime zero-dependency, no network.** The engine and every script and test use Node
  builtins only and work fully offline. Do not run `npm install` for them: there is no root
  lockfile and no root `node_modules/`.
- **`web/` is the one exception, and it is build-time only.** Its committed
  `web/package-lock.json` + committed npm cache at `web/.vendor/npm-cache` let the image's
  `webbuild` stage run `npm ci --offline`, so the image builds with no network. The cache is a
  **generated artefact** (linux/arm64) — after a dependency bump, re-vendor per `docs/agents/docker.md`
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
  `npm run verify:migrations` and `docs/agents/migration.md`.
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

Repo-layer rules a change here must respect. **Board usage is the `meerkat` skill's** — how a
card is claimed, delivered, reviewed or closed, and what `projects.json` means, live in
`skills/meerkat/`; do not restate them here.

- **Invariants live in the database first.** A rule that must hold for every writer is a trigger
  under `src/core/storage/migrations/`, mirrored by a domain check and tested against it under
  `test/contract/`. Shipping only the app-layer half is a bug: a raw writer walks past it.
- **One reader for a review card's identity.** The `review_of_id` / `review_round` columns are
  authority and `meta.review_of` is a mirror; every layer reads them through
  `src/foundation/review-identity.mjs`. A second reader forks the workflow planners, the SLA
  patrol and the CLI. The card rules themselves (cannot be reopened, a parent, a child or
  reviewed) are the `meerkat` skill's.
- **The loop speaks only `taskctl`.** `src/orchestrator/**` never calls the board's HTTP API —
  the live stream is `taskctl events follow` (the local hub), not `fetch` — and the loop carries
  no board discovery or token code.

The mechanisms those rules rest on, by home:

- `skills/meerkat/` — every board rule: the claim/heartbeat/deliver cycle, the round-scoped
  delivery gate, review cards (flow B), `projects.json`, the brief.
- `skills/meerkat-loop/` — when the loop patrols, dispatches and claims; the local event hub.
- `docs/agents/development.md` — one writer per data directory and `DB_BUSY`; auth (`TASKD_ALLOW_CIDRS`
  and the token, loopback trusted); the bounded `SIGTERM` stop.
- `docs/ops/install.md` — config topology: `.env` layering, the per-kind `.env.<actor-kind>` at the
  program root, the install root, and the `taskd` guard unit.
- `docs/ops/observability.md` — log levels, rotation, and why logger events are not activity events.
- `docs/events.md` — the event system's design: the activity log and revision cursor, the SSE
  contract, each consumer's policy, and the local event hub.

## Agent skills

### Issue tracker

Work is tracked as cards on the local Meerkat TaskPanel board; `/meerkat` is the entry for
every card operation — a card is created, claimed, kept alive with a heartbeat and delivered
through that skill, never through a side-channel queue. A card stops at `in_review`; the
card's `acceptance_mode` names who moves it to `done` (`agent`: the loop after a current-round
`APPROVE`; `human`: a person; `off`: the deliverer). See `docs/agents/issue-tracker.md`.

A card is the work a role owns: product design, architecture, implementation, bug fixes,
refactors, test design, regression, performance and independent review. A question, a lookup,
a one-off command, a scratch experiment, or the change being made in this conversation right
now has no owner, so it is not a card.

### Triage labels

The five canonical triage roles keep their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Docs to read next (do not re-paste)

- `GLOSSARY.md` — the canonical vocabulary: one word per concept, the words to avoid, and the terms that are *not* in the model.
- `README.md` / `README.zh-CN.md` — what the project is, install, roadmap.
- `CONTRIBUTING.md` — the container gate, PR flow, conventions the gates enforce.
- `docs/tech-spec.md` — this repository's standard: the authoritative pointer per section, and the security toolchain with its decision policy.
- `docs/agents/development.md` — the two build layers and the server operations (one writer, bounded stop, lock contention).
- `docs/agents/docker.md` — why verification is containerised, build/run, profiles, host-allowed checks.
- `docs/agents/contract.md` — the API and CLI contract snapshots + route-request lint.
- `docs/agents/migration.md`, `docs/scheduling.md`, `docs/ops/observability.md` — the named subsystems.
- `src/core/README.md` — what the core engine owns and the rules it enforces.
