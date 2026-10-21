# Development

## Requirements

- **Node >= 22** — the project targets the `node:sqlite` era and uses modern ESM.
- **The engine has no dependencies.** `src/**`, the scripts and every test use Node
  builtins only (`node:fs`, `node:path`, `node:test`, `node:child_process`, …).
- **The board frontend (`web/`) has build-time devDependencies** — Vue 3, Vite,
  Tailwind/daisyUI. They are pinned by the committed `web/package-lock.json` and never
  ship: the hosted artefact is the static `web/dist`.

> **Do not run `npm install` for the engine.** It needs no packages, no lockfile and no
> network access; a root `node_modules/` is gitignored and unexpected. The only install is
> `web/`'s, and it happens inside the image build (see [docker.md](docker.md)) — never into
> the repository root.

## Layout

| Path | Responsibility |
|---|---|
| `src/core/` | Domain model, SQLite repository, state machine, invariants (M1) |
| `src/cli/` | `taskctl` — the CLI entry point |
| `src/server/` | Local HTTP API + SSE for the board (M6) |
| `src/foundation/` | Foundation DTOs, constants, small pure helpers |
| `web/` | Vue 3 + Vite board frontend → `web/dist` (the hosted frontend root) |
| `skills/meerkat-taskpanel/` | The skill — **single source of truth** |
| `.claude-plugin/` | The board plugin manifest and the marketplace; the plugin root is the repository root, which is how every harness shares the one `skills/` tree |
| `.pi/` | The Pi extension, declared by the root `package.json`'s `pi` field (which also names the skills directory) |
| `.opencode/` | The OpenCode plugin — a Shape-B host: it registers the shared `skills/` directory at runtime, so it too needs no copy |
| `.cursor-plugin/` | Cursor's marker. Cursor reads `skills` out of its plugin root, which is why the repository root is a Cursor plugin root as well |
| `scripts/` | Build, install, sync and verify scripts |
| `test/` | Smoke / contract tests |
| `design/` | Product design artifacts — the DESIGN / BLOCKS documents, the interactive `prototype/`, brand assets and exported assets (see `design/README.md`) |
| `docs/` | Usage and development documentation |

Dependency direction: `core`, `cli` and `server` may import from `foundation`;
nothing imports from `cli` or `server`; `foundation` imports nothing from `src/`.
`src/foundation/` is the **public SDK**: both the board and the loop may import it.

The loop is an **orchestrator, not a co-owner**. `scripts/loop/**`, the supervisor and
`scripts/wake-cwd.mjs` may import `foundation/` but never `src/core|cli|server`; the board may
not import the loop's clocks/wake policy (`foundation/scheduling.mjs`); and no shipped skill
imports `src/core|cli|server` at all — an installed skill and a checkout are not co-located,
so such an import would resolve here and fail on a host. All three directions are asserted by
`test/cli/imports.test.mjs`.

SLA is the one surface that moved sides. The board now **computes** the inspection rows
(`foundation/sla-patrol.mjs` via `core/commands/sla.mjs`, published as `GET /api/v1/sla`), so
`src/core` and `src/server` may import the engine — through that one command, which the
import test names explicitly. `src/cli` remains a thin HTTP client and must not. The loop
keeps the de-duplication ledger, the pre-emit re-read and the notification, plus
`inspector_liveness` (a marker file on the loop's host).

The ownership rule behind them: a rule that decides **what state is legal or required**
belongs to the board; a rule that decides **when to act, whom to involve, or where to wake**
belongs to the loop. The loop reaches the board only through its public surface (`taskctl
--json` / HTTP), never by importing it.

## Commands

```bash
node --test                          # smoke / contract test suite
node scripts/sync-skills.mjs         # regenerate the loop payload (manifest + scripts/ + templates/)
node scripts/sync-skills.mjs --check # verify both are in sync
node scripts/verify/manifests.mjs    # validate the host + loop + marketplace manifests
node scripts/verify/skill.mjs        # validate the board skill's SKILL.md frontmatter
node scripts/verify/web-dist.mjs     # are the two web/dist-guarded tests legs actually run?
node scripts/build.mjs               # produce dist/ — the npm release tree (not web/dist)
```

Or via npm aliases:

```bash
npm test          # node --test
npm run check:skills
npm run verify
npm run verify:web-dist  # fail unless both web/dist-guarded legs ran (see below)
npm run build
npm run check     # check:skills + verify + test
npm run test:coverage   # node --test + the coverage gate (see below)
```

### Local and CI run the same commands

`.github/workflows/check.yml` is a thin wrapper: it shells out to the same scripts and
tests a developer runs locally, so a green local run and a green CI run mean the same
thing.

- The **`check` job** runs on a **Node 22 and Node 24 matrix** (`fail-fast: false`, both
  legs run the full step list) — the floor the project promises (`engines: node >= 22`)
  and the current release line. It runs `node --test`, the coverage gate, and the
  `scripts/verify/*` checkers.
- The **`docker` job** is the authoritative one: it builds `meerkat-taskpanel:verify` and runs
  `docker/verify-in-container.sh`, exactly as `npm run verify:docker` does — including the
  install + first-run end-to-end, which is a step *inside* that script rather than a
  separate CI-only `docker run`. (`verify:docker` then adds a local-only compose deploy
  smoke test, which is strictly extra.)

`verify:docker` is not a substitute for the **`check` job**, and does not reproduce two of
its properties: the Node **22/24 matrix** (the image is Node 22 only, so a Node-24-only
regression is invisible locally) and the standalone `scripts/verify/version.mjs` /
`bash -n` host checkers. See [docker.md](docker.md#ci).

The **coverage gate** is `npm run test:coverage`, the same script
`docker/verify-in-container.sh` runs. The line/branch/function floors live **once**, in
that script in `package.json`; the workflow invokes the script rather than restating the
numbers, so there is a single place to change them. A miss makes the script exit non-zero
and turns the job red.

## Contributing: the pull-request flow

[CONTRIBUTING.md](../CONTRIBUTING.md) is the contributor-facing version of this section.
The mechanics:

1. Branch off `main`.
2. Push the branch and **open a pull request**.
3. Wait for CI. Three workflows already carry a `pull_request` trigger, so no workflow
   change is needed for PR gating:
   - `.github/workflows/check.yml` — the Node 22/24 matrix plus the container job;
   - `.github/workflows/contract-gate.yml` — the API and CLI contract snapshots and the route-request lint;
   - `.github/workflows/security-scan.yml`.
4. Merge once green.

Nothing in the tree can *require* step 2 — that is GitHub's rule to set (below). The
`pre-push` hook refuses a direct push to `main` as the local half, so the mistake surfaces
before the network; it is still a courtesy, `git push --no-verify` bypasses it, and a fresh
clone has no hooks at all until `git config core.hooksPath .githooks` — see
[.githooks/README.md](../.githooks/README.md).

### Repository settings a maintainer must set by hand

These live in GitHub, not in the repository, so nothing here can assert them. On `main`:

- **Require a pull request before merging.**
- **Require status checks to pass.** The names, exactly as they appear on a check run —
  search for them by these strings, not by job id: `check (22)` and `check (24)` and
  `docker` (from `check.yml`), `contract` (from `contract-gate.yml`), and
  `Dependency scan (osv-scanner + npm audit)` and `SBOM (syft)` (from `security-scan.yml`,
  which spell their jobs out with a `name:`). `docker` is the authoritative job — a rule
  that requires `check` but not `docker` gates the fast half and not the real one.
  `sbom` also runs on every trigger, but it exists to publish a release artefact rather than
  to judge a change; requiring it is defensible but slower than the rest, so it is a
  per-repository call. A check can only be required once it has *reported* — a workflow
  GitHub rejects never registers one, so an invalid workflow file leaves its two checks
  absent from the picker with no trace anywhere in the UI.
- **Do not allow bypassing the above settings**, if the intent is that `main` is genuinely
  protected rather than advisory. Check who can approve first: with **no** second
  collaborator, a required approval can never be given (GitHub does not let you approve your
  own pull request), so this combination freezes `main` outright.

## Two build layers: engine and web

The repository builds two independent layers plus a release tree, and the two `dist` names
are **not** the same directory:

| Layer | Source | Build | Output |
|---|---|---|---|
| Engine | `src/**`, `scripts/**` | nothing — Node runs the sources directly | *(no build step)* |
| Web board | `web/**` | Vite (`npm --prefix web run build`) | `web/dist` — the **hosted frontend root**, served by `taskd` (`STATIC_DIR_REL`) |
| Release tree | the tree as the npm whitelist sees it | `node scripts/build.mjs` | `dist/` — the npm **release tree**; never served |

The web layer is the only part with dependencies. Vue/Vite/Tailwind/daisyUI are
**build-time devDependencies**: they are installed by the image's `webbuild` stage from the
**committed npm cache** at `web/.vendor/npm-cache` (`npm ci --offline`), pinned by the
committed `web/package-lock.json`, and only the built `web/dist` crosses into the runtime
image. No `node_modules` ships, and the runtime image itself installs nothing.

> The cache is a **generated artefact** (linux/arm64, produced inside the arm64 container),
> not a source file. After any dependency bump in `web/package.json`, re-run the vendoring
> step in [docker.md](docker.md#re-vendoring-the-npm-cache) and commit the refreshed cache
> with the lockfile.

> The `web/` workspace has landed with **M6b**. When `web/package.json` is absent from a
> checkout the image's `webbuild` stage is a guarded no-op that emits an empty `web/dist`.

The container-first path is the image build — see
[docker.md](docker.md#the-web-build-stage). Runtime, every verification step and the
frontend build stage are all offline: with the cache committed, the image builds with **no
network** (`docker build --network=none` succeeds).

Because `web/dist` is a build product and not committed, the two suites that read it —
`test/web/blocks.bundle.test.mjs` and `test/web/blocks.dom.test.mjs` — **skip** in any tree
that has not built the frontend, which includes every lane worktree and the CI `check` job.
`node --test`'s `fail 0` is silent about that. `node scripts/verify/web-dist.mjs` is the
verdict: it names the legs that ran, and `npm run verify` (inside `npm run check`) runs it —
rebuilding first when a toolchain is present — so the answer to "did the gate cover the
browser?" is printed rather than inferred. See
[docker.md](docker.md#which-of-node---tests-legs-actually-ran).

## The `taskd` HTTP surface (M6)

`src/server/` is the local service every other surface talks to. Start it with
`node src/server/main.mjs`; `taskctl` starts it on demand.

| Route (`/api/v1` unless noted) | Methods | Notes |
|---|---|---|
| `/health`, `/meta` | GET | liveness + version/capabilities; `/health` is unauthenticated |
| `/projects`, `/projects/:id`, `/projects/:id/readme` | GET/POST/PATCH/PUT | `/projects` is ordered server-side (DESIGN.md §20) and carries each project's `task_count` (the sidebar badge — total tasks, archived included, independent of the order) |
| `/tasks`, `/tasks/:ref` | GET/POST/PATCH | `:ref` is an identifier or a UUID |
| `/tasks/:ref/move`, `/tasks/:ref/reopen`, `/tasks/:ref/deliver`, `/tasks/:ref/assign`, `/tasks/:ref/archive` | POST | the delivery gate bites on `/move` and `/deliver`; `/reopen` is the audited `done|canceled → todo` edge |
| `/tasks/:ref/comments`, `/tasks/:ref/relations`, `/tasks/:ref/sessions`, `/tasks/:ref/activities`, `/tasks/:ref/reports` | GET/POST/DELETE | activities is the audit cursor read |
| `/attachments/:id/content` | GET/PUT | raw bytes; not JSON — handled outside the router |
| `/events` | GET (SSE) | `global_revision` increments; `?after=<rev>` replays; a deliberate stop sends a named `shutdown` frame (see [Stopping the daemon](#stopping-the-daemon)) |
| `/actors`, `/labels` | GET | read-only by design (§4.4) |
| `/token` | POST | rotate; loopback only |
| `/access` | GET/PUT | the persisted token + allow-list policy; loopback only (the read answers the credential) |
| `/` and everything else | GET/HEAD | built frontend from `web/dist`, when it exists |

Beyond `/health`, every request is authorised before it is routed (§7):

- a **loopback** caller is trusted — no token, never filtered by the allow-list;
- a **remote** caller must be inside the allow-list (when one is enabled; see
  below) and must present the token, as `Authorization: Bearer <token>` or
  `?token=<token>` (the query form exists for `EventSource`);
- `POST /token` and both `/access` verbs are refused (403, `loopback_only`) from
  anywhere but this machine.

The allow-list is server configuration, persisted **outside the database** in
the install-root `.env` (`TASKD_ALLOW_LIST_ENABLED` + `TASKD_ALLOW_CIDRS`). The
precedence is: an explicit process-environment value (an operator override, and
the Access panel turns read-only), then the `.env` values, then the defaults —
the list **off**, seeded with `192.168.0.0/16` and `10.0.0.0/8`. A loopback save
through `PUT /access` writes the file and applies the policy to the next request
without a restart; `rotate_token: true` rotates the token in the same save.

**One config file, environment first.** `<program root>/.env` is read by both
`taskd` and `taskctl` (and the loop's SSE subscriber). The process environment
wins key by key; CLI flags win over both. `--env-file <path>` or
`MEERKAT_TASKPANEL_ENV_FILE` selects a different file (tests, containers, a
read-only package root). A file named with `--env-file` that does not exist is an
error; a missing `MEERKAT_TASKPANEL_ENV_FILE` target or default is "no
configuration" (the Access panel creates the file on its first save). The file
grammar is the simple `KEY=VALUE` subset
(`#` comments, matching quotes; no interpolation or multiline values). Only
known keys are merged: unknown keys outside the project's namespaces are
ignored, while a typo inside them is an error.

`.env` is not tracked (`git` and `docker` both ignore it); the Access panel
writes it 0600. An inline `TASKD_TOKEN` requires that mode. The old
`<dataDir>/taskd.env` is **no longer read** — this is a hard switch; move its
keys into `.env`.

Security-relevant environment variables:

| Variable | Meaning |
|---|---|
| `TASKD_HOST` / `TASKD_PORT` | bind address / port (defaults `0.0.0.0:9527`) |
| `TASKD_URL` | client's preferred board address; probed. A dead loopback address may fall through to the pointer or a lazy start; a dead remote address is an error. `--url` is a pin |
| `TASKD_ALLOW_CIDRS` | comma-separated CIDR allow-list for non-loopback callers; unset = no list (allow all), malformed entries fail closed. Setting it (or `TASKD_ALLOW_LIST_ENABLED`) makes the process environment own the policy, so the Access panel is read-only |
| `TASKD_ALLOW_LIST_ENABLED` | `true`/`false`: whether the list is in force. Both keys are also read from the install-root `.env`, which the Access panel writes |
| `TASKD_DATA_DIR` / `TASKD_DB` | data directory / database file |
| `TASKD_TOKEN` | token a client presents (`--token` outranks it) |
| `TASKD_TOKEN_FILE` | a token file the client reads (`TASKD_TOKEN` outranks it) |
| `MEERKAT_TASKPANEL_ENV_FILE` | selects the config file; not a secret |
| `TASKD_LABEL_GC`, `TASKD_LABEL_TTL_DAYS` | label housekeeping (§4.4) |
| `TASKD_SLA_*` | the SLA policy table (`docs/sla.md` §2.1): per-row `LIMIT_MIN`/`FURTHER_MIN`, `PERIOD_SECONDS`, `LEADER_LOOKBACK_DAYS`, `PEER_PERIOD_MIN`, `PEER_LIVENESS_K`. Validated as integers with `F ≥ L`; published by `GET /api/v1/sla` and `/meta` → `capabilities.sla`, re-read per request |

### One writer per data directory

The single-writer model is enforced, not assumed (R1). On startup the daemon
takes `<dataDir>/writer.lock` with `O_EXCL` **before** it opens the database; a
second `taskd` on the same `TASKD_DATA_DIR` is refused with
`BOARD_ALREADY_RUNNING` (HTTP 409 in the payload; the program prints the message
and exits non-zero). The refusal names the pid that holds the lock.

Three operator-facing consequences:

- **A crashed daemon needs no cleanup.** A lock whose `pid` is gone is a fossil:
  the next start logs `writer_lock_stale`, removes it and carries on. Only a
  *live* holder blocks a start. (`SIGKILL` therefore costs nothing but the lock
  file.)
- **The runtime pointer belongs to its owner, and the owner is the
  `(pid, dataDir)` pair.** Both halves are load-bearing: a process removes the
  pointer only while the file still names its own pid *and* its own data
  directory, so an exiting instance can never unplug a live board — not one
  behind another pid, and not one behind another data directory wearing the same
  pid. The write side obeys the same pair: a board whose data directory is not
  the sitting board's does not displace it, and is addressed beside its own data
  directory instead, at `<dataDir>/runtime.json`.
- **The reader falls back to that same file.** `taskctl` finds its board as
  *explicit `--url`* → *a healthy runtime pointer* → *lazy start*. The pointer
  step reads the machine-wide slot first, and only when the slot is absent or
  unreadable, or names a **different** board's data directory, is
  `<dataDir>/runtime.json` preferred over it — which is what keeps a board that
  has been pushed off the slot reachable while it runs. A pointer path the caller
  *named* (`TASKD_RUNTIME_POINTER`) is obeyed verbatim, on the reading side as on
  the writing one. And if the fallback file turns out to be a fossil (a board
  killed before it could remove it), the slot's board is believed *when it
  answers* before anything is spawned, so the lazy start cannot take a live
  board's address away from it. The other half of that guarantee is on the
  **starting** side: autostart hands the machine-wide slot to the daemon it
  spawns only when the *caller* named a pointer, and with no name the child
  addresses itself beside its own data directory while the parent waits at
  **both** files, believing only one that carries the pid it just started —
  so starting a board cannot overwrite the slot a live board is sitting in
  either, however unhealthy that board looks.

If you see `BOARD_ALREADY_RUNNING` and believe no board is running, stop the
named pid first; if that process is gone, the stale lock is removed
automatically on the next start (or by hand: `rm <dataDir>/writer.lock`).

### Stopping the daemon

`SIGTERM` / `SIGINT` is the graceful stop, and it is **bounded**. The daemon
releases the database (so no `-wal` is left beside it), removes its own runtime
pointer, releases the write lock and exits 0 — which is what lets a deployment
restart it without reaching for `SIGKILL`. (A `SIGKILL` is survivable — the stale
lock, the fossil pointer and the `-wal` are all handled on the next start — but
it is no longer the only way to stop a board.)

What has to be bounded is the SSE stream. `server.close()` stops *accepting*,
and settles only when every socket is gone — and a `/api/v1/events` response is an
**active** request with no reason to end on its own, so waiting for it is waiting
forever. The daemon therefore ends those streams itself, and tells the client
why: a named `shutdown` frame (`event: shutdown`) just before the stream closes,
carrying no `id:`, so no client can advance its cursor past events it has not
seen. Anything still connected after a short grace is destroyed rather than
waited on (`src/server/index.mjs`: `closeServer`, `SHUTDOWN_GRACE_MS`).

The board client takes that frame for what it is — a restart, not a failure —
and owns its reconnect either way: the socket is closed and re-opened after an
exponential backoff (1 s, 2 s, 4 s … held at 30 s), resumed from
`?after=<cursor>`, with the ladder reset by a successful `open`. That is the
point of owning it: the browser's built-in retry is a fixed interval that
repeats forever, and a board that is down for an hour must not be a board that is
polled twice a second.

### Lock contention is a 503, not a 500

Writes take the SQLite write lock for the length of one transaction. When
another writer holds it past `busy_timeout` (5s), the request is **retried** a
bounded number of times (see `DB_BUSY_MAX_ATTEMPTS` in `src/foundation/constants.mjs`)
and, if it still cannot get in, answered with:

```
503 DB_BUSY   Retry-After: 1
```

The write changed nothing, so the retry is safe. This replaced a
`VALIDATION_FAILED`/500: "the server is broken" was the wrong thing to tell a
client about a lock that clears on its own. An operation that holds the write
lock for longer than `busy_timeout × attempts` (a large migration, a stalled
disk) will make online writes retry and then fail with `DB_BUSY`; the honest
fix is to shorten the hold, not to raise the timeout.

> `busy_timeout` is pinned at 5000ms per connection. The tests that exercise
> contention pass `busyTimeoutMs` to `createTaskd`/`openBoard` to shorten it,
> which is also the only supported way to override the pin.

The access token is never echoed in a response and never logged. The SSE stream
filters `task_heartbeat` out of the increments, because a pulse changes no board
state (§4.3); the row still exists in `task_activities` and under
`/tasks/:ref/activities`.

> **The built board is loopback-only.** It injects no token, so a browser reaching
> `taskd` from a non-loopback address is answered 401 across the board — a known
> local-first limitation, not a defect. See
> [web-local-first.md](web-local-first.md) for what works, the SSH-forward
> workaround, and what a fix would require.

## The skills are generated, never hand-edited

There are two skills, and `scripts/sync-skills.mjs` owns the whole generated surface
around them (it delegates the payload half to `scripts/sync-loop.mjs`):

| Skill | Authored in | Generated into |
|---|---|---|
| `meerkat-taskpanel` (the board) | `skills/meerkat-taskpanel/` | nothing — every harness reads `skills/` in place |
| `meerkat-loop` (the supervisor) | `skills/meerkat-loop/` — `SKILL.md`, `references/`, `scripts/board-check.mjs` | its own `manifest.txt` + `scripts/` (except the gate) + `templates/`; foundation is generated inside `scripts/foundation/` |

There is exactly one `skills` tree in the repository. No harness receives a copy: each reads
`skills/` in place through a manifest at the repository root, which is the board's plugin
root. `test/scaffold.test.mjs` asserts that, since with no copy targets left
`sync-skills.mjs --check` has nothing to compare and could not notice an orphan tree.

The loop's `manifest.txt` and `scripts/` are generated *from this repository*:
`manifest.txt` is the transitive import closure of `scripts/supervisor.mjs`,
`scripts/loop/*.mjs` and `scripts/wake-cwd.mjs` (the list the installer copies), `scripts/`
holds those modules and `scripts/foundation/` holds the foundation modules they import.
`templates/` mirrors the loop-side files under `scripts/install/templates/`.
`scripts/board-check.mjs` is the one authored file inside a generated root —
`sync-loop.mjs` never writes, prunes or reports it. That direction matters — the foundation
modules in the repository's `src/foundation/` are **not** moved into the skill; they stay
where the CLI imports them, and the skill's copy is generated and guarded. The vendored set
is the loop's foundation closure only: the loop body never contains `src/core`, `src/cli`,
`src/server`, or any foundation module the entry points do not import. Foundation copies are
byte-for-byte; entry scripts differ only in their foundation import specifiers
(`../src/foundation/x` → `./foundation/x`), and `--check` compares against that transform. The **workflow
decisions** are not in
the loop body at all: they live in `src/core/domain/workflow.mjs`, and the loop gets them
from the board through `issue reconcile --workflow`. OpenClaw never receives the loop at
all, by ruling: its framework already ships an equivalent supervisor, and `install.sh
--target openclaw` copies the board skill only.

**After editing anything under `skills/`, `scripts/supervisor.mjs`, `scripts/loop/`,
`scripts/wake-cwd.mjs`, `src/foundation/`, or `scripts/install/templates/`, run:**

```bash
node scripts/sync-skills.mjs
```

CI runs `node scripts/sync-skills.mjs --check` and fails if the generated payload has
drifted. The same reasoning applies to `dist/`: build output is never edited by hand and is
gitignored.

**One more rule for the skills, because they are distributed rather than read in place:** a
link inside `skills/**` must resolve wherever the skill is *installed*, not where it was
authored. A host's skill store holds `skills/<name>/` and nothing above it, so a
`../../../docs/…` link dangles in every install — link out by absolute URL instead. (Sharing
the tree across harnesses does not relax this: `install.sh` still lands one skill directory
in the host's store.) `test/skill/loop.test.mjs` asserts no link climbs out of the skill
tree.

## Build output

`node scripts/build.mjs` deletes and recreates `dist/` and writes a `dist/web/.gitkeep`
placeholder. It verifies the loop payload is current (`sync-loop --check`) rather than
regenerating it: a build must not rewrite the source tree, so a stale payload is a red build
instead of a silent divergence. It copies no skill — every harness reads `skills/` in place,
so `dist/` carries the tree as-is through the npm `files` whitelist. `dist/` is gitignored, and
**it is the npm release tree — not the hosted frontend.** The `dist/web/` placeholder is
left over from the M0 scaffold; the real board frontend builds to `web/dist` (see
[Two build layers](#two-build-layers-engine-and-web)).

## Constraints

- **No network.** Scripts, tests and the CLI must work fully offline.
- **No runtime dependencies.** Prefer Node builtins; adding a *runtime* package requires a
  deliberate decision and an update to this document. `web/`'s build-time devDependencies
  are the bounded exception — see [Two build layers](#two-build-layers-engine-and-web).
- **Shell scripts** are POSIX `bash` with `set -eu`. Check them with
  `bash -n install.sh scripts/install/*.sh`.
