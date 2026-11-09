# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Auto-loaded. Keep it accurate and non-duplicative: `README.md`, `CONTRIBUTING.md` and `docs/`
own the prose.

## Overview

Meerkat TaskPanel is a local-first task board for AI-agent teams: agents claim work, send
heartbeats, report progress and roll results up a dependency tree, while humans watch the same
state on a read-only kanban board. Persistence is one SQLite database (`node:sqlite`); there are
no external services. Node >= 22, zero runtime dependencies, MIT.

## Design principles

Six principles bind every agent, not only the architect:

- **Simple** — one obvious way per task; no abstraction before a second caller.
- **Reliable** — every dependency's failure mode is named: fail-fast config, timeouts,
  idempotency, health.
- **Efficient** — no optimization without a measured number and a stated bound.
- **Elegant** — one source of truth, consistent naming, boring technology, least surprise.
- **Not over-engineered** — every abstraction names what breaks if you delete it.
- **High cohesion, low coupling** — one owner and one reason to change per module; dependencies
  point one way.

When they conflict: simplicity and reliability win; efficiency needs a measurement; elegance
constrains how and never adds machinery. A violated principle is a recorded decision with its
cost, never a silent drift.

## How to work here

- Work the card by the role skill it names: read that role's `SKILL.md` and follow it, the
  installed copy is authoritative. Card operations go through `/meerkat`, and this project's
  board rules live in `docs/agents/` (`create-card.md`, `worktrees.md`, `issue-tracker.md`,
  `triage-labels.md`, `domain.md`, `decision-policy.md`, `review-scenarios/`).
- Reviewer scenarios live in `docs/agents/review-scenarios/` — currently `meerkat.md` — and
  the reviewer reads every file there at the delivered sha. Add or change one through the
  installed `setup-meerkat` skill's Step 4, never by a role or a card by hand; the
  agent-instruction entry names the directory and every file in it.
- Card scope is the work a role owns. Outside the roles is outside the board: a question, a
  lookup, a one-off command, a scratch experiment or the change already being made in this
  conversation is not a card.
- Decompose first when a request is more than a couple of tool calls; a step is done when its own
  check is green, not when the edit lands.
- TDD by default: failing test first, then the smallest change. Extend the test file that already
  owns the behaviour — `test/contract/**` for invariants, then the layer's own directory
  (`test/core/**`, `test/server/**`, `test/cli/**`, `test/orchestrator/**`, `test/concurrency/**`,
  `test/web/**`, `test/install/**`). Add browser legs to `test/web/blocks.dom.test.mjs`; a second
  browser file flakes the shared harness.
- Iterate with the host-static checks (`npm run check`). `npm run verify:docker` is the
  **push-time gate, not a work step**: `.githooks/pre-push` runs it on every branch push and CI
  runs the same container suite. Run it by hand only as a deliberate final check, not in the
  edit loop. It bakes the **working tree** at build start, so **commit before you push**;
  `SKIP_CONTAINER_VERIFY=1` skips it for one push.
- Report, then wait: do not call the task complete, integrate it or delete anything without the
  user's confirmation.

## Branch & worktree workflow

`dev` is the only development branch; branch parallel work off it. `main` is the release line and
advances only by merging `dev`, after the user confirms.

- **Isolate a parallel task in a worktree**, never a second branch in the primary checkout:
  `taskctl worktree create <slug> --base dev` is the managed path (it checks the root, the
  ignore rule and the branch name); the low-level equivalent is
  `git worktree add .worktrees/<slug> -b <branch> dev` (`.worktrees/` is gitignored and
  dockerignored). Follow the `using-git-worktrees` skill's Step 0 first.
- **Land only after confirmation**: commit every path you touched (`git commit -- <path>`), then
  `git checkout dev && git merge --no-ff <branch>`, then `git worktree remove <path>` **before**
  `git branch -d <branch>` (git refuses to delete a branch still checked out; use `-d`, never
  `-D`), and re-run `npm run check` on the merged tree.
- **Never edit `CHANGELOG.md` here.**

### CHANGELOG.md is written only on the release branch

`CHANGELOG.md` is the release line's record. Write it only on `release/vX.Y.Z` (the PR
`workflow_dispatch release-prep` opens to `main`), after the user confirms the release, from what
the merge contains: `git log --no-merges --reverse <last-release-tag>..dev` (first release:
`main..dev`). `[Unreleased]` stays empty between releases; a version section on `main` is frozen
(typo fixes only). `npm run release:bump <version> --changelog` creates an empty scaffold.

## Non-obvious commands

The ordinary scripts live in `package.json`. Only these invocations cannot be inferred:

```bash
node --test test/core/index.test.mjs        # one file
node --test "test/contract/**/*.test.mjs"   # quoted glob; a bare directory arg does not work
node scripts/verify/contract.mjs --update   # refresh the API contract snapshot
node scripts/verify/cli-contract.mjs --update
node scripts/verify/route-request.mjs       # declared request schema vs what the handler reads
```

`test:coverage` gates `src/core/**`, `src/foundation/**`, `src/cli/**` and `src/server/**` at
80 % line, branch and function; the floors live once in `package.json`.

## Repository layout

The canonical tree is `docs/architecture.md` § Directory tree. Before the first command, only
these matter:

- `src/` is layered `cli|server -> core -> foundation`; `src/core/domain/` imports no Node
  builtins.
- `web/` builds to `web/dist`, the static root `taskd` serves (`STATIC_DIR_REL`). `dist/` is a
  different tree: the npm release tree written by `scripts/build.mjs`, never served. `web/dist`
  is gitignored yet in the npm `files` whitelist.
- `.meerkat/<identifier>/` is the loop's per-task process directory under a project's working
  directory (`card.md` is hub-maintained, never hand-edited); `loop/` at the config root is
  the loop's own runtime state (queue, session records, locks, transcripts). `dist/`, `.data/`,
  `node_modules/`, `coverage/`, `.meerkat/` and `loop/` are build/runtime output, never
  committed.

## Constraints

- **Verification runs inside Docker, not the host.** Everything that *runs* — tests, serving the
  app, the CLI, skill/plugin installs, migration rehearsals — runs in the container
  (`npm run verify:docker`), normally as the `pre-push`/CI gate rather than a by-hand session
  command. The host-allowed static checks are listed in
  `docs/maintenance/docker.md` §Host-allowed checks.
- **Runtime zero-dependency, no network.** The engine and every script/test use Node builtins and
  work offline. Never run `npm install` at the root; there is no root lockfile or `node_modules/`.
- **`web/` is the build-time exception.** Its committed `web/package-lock.json` and
  `web/.vendor/npm-cache` let the image run `npm ci --offline`; re-vendor the cache
  (linux/arm64) after a dependency bump and commit it with the lockfile.
- **Skills are authored source.** `skills/` is the only skills tree: no generator, no manifest,
  no committed copies (`test/scaffold.test.mjs`).
- **Migrations are append-only.** Never edit or delete a committed
  `src/core/storage/migrations/*.sql`; add a new numbered file (`npm run verify:migrations`).
- **Contracts are explicit.** A route, error code or wire-field change updates
  `test/fixtures/contract/api.snapshot.json` via `scripts/verify/contract.mjs --update` (a new
  `DomainError` code also touches `ERROR_CODES` and its bucket). A CLI change updates the CLI
  snapshot via `cli-contract.mjs --update`, and `skills/meerkat/references/cli.md` must name the
  frozen surface.
- **Commit with explicit paths:** `git commit -- <path>`, never `git commit -a`.
- **Layering and errors:** `cli|server -> core -> foundation` (nothing imports from `cli`/`server`;
  `foundation` imports nothing from `src/`); every failure is a domain error with a code, never a
  bare `Error`.
- **`design/` is a live oracle.** Prototype pages under `design/prototype/` are read by tests
  (`test/design/`, `test/web/blocks.*`, `test/web/i18n.catalogue.test.mjs`). `.dockerignore` drops
  `design/`, so design-derived tests self-skip in the image — do not read that as a pass.
- **Cite the live document, never `ARCHITECTURE.md`.** That file is not in this tree and never has
  been; its section citations are historical orientation only. The system record is
  `docs/architecture.md`; project ordering is `design/DESIGN.md` §20. Add no new citation.
- **Configuration has one inventory:** `.env.example`, held to `src/foundation/constants.mjs` by
  `test/contract/config-keys.test.mjs`.
- **Security is four arms plus an inventory** (dependency audit, secret scan, SAST, SBOM); the
  block threshold, waivers and strict switch are in `docs/tech-spec.md` § Security toolchain.

## Git hooks

A fresh clone has none: `git config core.hooksPath .githooks` (do not run `npm install`).
`pre-push` runs the static checkers and then the container gate; what each hook enforces is in
`.githooks/README.md`.

## Key invariants

- **Invariants live in the database first.** A rule for every writer is a trigger under
  `src/core/storage/migrations/`, mirrored by a domain check and tested in `test/contract/`.
- **One reader for a review card's identity.** `review_of_id` / `review_round` are authority and
  `meta.review_of` a mirror; every layer reads them through `src/foundation/review-identity.mjs`.
- **One reader for a handoff round marker.** `meta.handoff_consumed_round` /
  `meta.handoff_declined_round` may carry the created refs after the round, so every layer reads
  them through `src/foundation/handoff-round.mjs`; a direct `Number(value)` read is a regression.
- **The supervisor speaks only `taskctl`.** `src/orchestrator/**` never calls the HTTP API; the
  live stream is `taskctl events follow`, and the supervisor carries no board discovery or token
  code.
- **A claim-cycle exit is a new attempt.** Leaving `in_progress`/`awaiting`/`in_review`/`blocked`
  interrupts the running turn (`stateDir/interrupts/`, the adapter's `interrupt()`), records the
  queue row `interrupted` without spending a counter, and deletes the session record and
  transcript. Only a re-dispatch inside the claim resumes; ADR 0017.

## Pointers

- `docs/tech-spec.md` — the numbered `TS-NN` rules every change must satisfy.
- `docs/architecture.md` — the system record: boundaries, layers, data model, contract, tree.
- `docs/adr/` and `GLOSSARY.md` — decisions and canonical vocabulary.
- `CONTRIBUTING.md` and `README.md` — how a change lands; what the project is.
- `.env.example` — the configuration inventory.
- `docs/maintenance/{docker,contract,migration}.md`, `docs/ops/observability.md`,
  `docs/events.md`, `docs/scheduling.md`, `src/core/README.md`.
