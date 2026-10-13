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
| `src/shared/` | Shared DTOs, constants, small pure helpers |
| `web/` | Vue 3 + Vite board frontend → `web/dist` (the hosted frontend root) |
| `skills/meerkat-taskpanel/` | The skill — **single source of truth** |
| `plugins/<host>/` | Per-host manifests + generated `skills/` copies |
| `scripts/` | Build, install, sync and verify scripts |
| `test/` | Smoke / contract tests |
| `design/` | Product design artifacts — the DESIGN / BLOCKS documents, the interactive `prototype/`, brand assets and exported assets (see `design/README.md`) |
| `docs/` | Usage and development documentation |

Dependency direction: `core`, `cli` and `server` may import from `shared`;
nothing imports from `cli` or `server`; `shared` imports nothing from `src/`.

## Commands

```bash
node --test                          # smoke / contract test suite
node scripts/sync-skills.mjs         # regenerate the loop payload + every plugin skill copy
node scripts/sync-skills.mjs --check # verify both are in sync
node scripts/verify/manifests.mjs    # validate the host + loop + marketplace manifests
node scripts/verify/skill.mjs        # validate the board skill's SKILL.md frontmatter
node scripts/build.mjs               # produce dist/ — the npm release tree (not web/dist)
```

Or via npm aliases:

```bash
npm test          # node --test
npm run check:skills
npm run verify
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

## Two build layers: engine and web

The repository builds two independent layers plus a release tree, and the two `dist` names
are **not** the same directory:

| Layer | Source | Build | Output |
|---|---|---|---|
| Engine | `src/**`, `scripts/**` | nothing — Node runs the sources directly | *(no build step)* |
| Web board | `web/**` | Vite (`npm --prefix web run build`) | `web/dist` — the **hosted frontend root**, served by `taskd` (`STATIC_DIR_REL`) |
| Release tree | skills + host plugins | `node scripts/build.mjs` | `dist/` — the npm **release tree**; never served |

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

## The `taskd` HTTP surface (M6)

`src/server/` is the local service every other surface talks to. Start it with
`node src/server/main.mjs`; `taskctl` starts it on demand.

| Route (`/api/v1` unless noted) | Methods | Notes |
|---|---|---|
| `/health`, `/meta` | GET | liveness + version/capabilities; `/health` is unauthenticated |
| `/projects`, `/projects/:id`, `/projects/:id/readme` | GET/POST/PATCH/PUT | `/projects` is ordered server-side (§4.6) and carries each project's `task_count` (the sidebar badge — total tasks, archived included, independent of the order) |
| `/tasks`, `/tasks/:ref` | GET/POST/PATCH | `:ref` is an identifier or a UUID |
| `/tasks/:ref/move`, `/tasks/:ref/deliver`, `/tasks/:ref/assign`, `/tasks/:ref/archive` | POST | the delivery gate bites on `/move` and `/deliver` |
| `/tasks/:ref/comments`, `/tasks/:ref/relations`, `/tasks/:ref/sessions`, `/tasks/:ref/activities`, `/tasks/:ref/reports` | GET/POST/DELETE | activities is the audit cursor read |
| `/attachments/:id/content` | GET/PUT | raw bytes; not JSON — handled outside the router |
| `/events` | GET (SSE) | `global_revision` increments; `?after=<rev>` replays |
| `/assignees`, `/reporters`, `/labels` | GET | read-only by design (§4.4) |
| `/token` | POST | rotate; loopback only |
| `/` and everything else | GET/HEAD | built frontend from `web/dist`, when it exists |

Beyond `/health`, every request is authorised before it is routed (§7):

- a **loopback** caller is trusted — no token, never filtered by the allow-list;
- a **remote** caller must be inside `TASKD_ALLOW_CIDRS` (when set; unset = allow
  all) and must present the token, as `Authorization: Bearer <token>` or
  `?token=<token>` (the query form exists for `EventSource`);
- `POST /token` is refused (403) from anywhere but this machine.

Security-relevant environment variables:

| Variable | Meaning |
|---|---|
| `TASKD_HOST` / `TASKD_PORT` | bind address / port (defaults `0.0.0.0:9527`) |
| `TASKD_ALLOW_CIDRS` | comma-separated CIDR allow-list for non-loopback callers; unset = allow all, malformed entries fail closed |
| `TASKD_DATA_DIR` / `TASKD_DB` | data directory / database file |
| `TASKD_TOKEN` | token a client presents (`--token` outranks it) |
| `TASKD_LABEL_GC`, `TASKD_LABEL_TTL_DAYS` | label housekeeping (§4.4) |

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
  board's address away from it.

If you see `BOARD_ALREADY_RUNNING` and believe no board is running, stop the
named pid first; if that process is gone, the stale lock is removed
automatically on the next start (or by hand: `rm <dataDir>/writer.lock`).

### Lock contention is a 503, not a 500

Writes take the SQLite write lock for the length of one transaction. When
another writer holds it past `busy_timeout` (5s), the request is **retried** a
bounded number of times (see `DB_BUSY_MAX_ATTEMPTS` in `src/shared/constants.mjs`)
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
| `meerkat-taskpanel` (the board) | `skills/meerkat-taskpanel/` | `plugins/{claude,codex,openclaw,pi}/skills/meerkat-taskpanel/` |
| `meerkat-loop` (the supervisor) | `skills/meerkat-loop/` — `SKILL.md`, `references/`, `scripts/board-check.mjs` | its own `body/` + `templates/`, then `plugins/{claude,codex,pi}/skills/meerkat-loop/` **and** `plugins/loop/skills/meerkat-loop/` |

The loop's `body/` and `templates/` are generated *from this repository*: `body/` is the
transitive import closure of `scripts/supervisor.mjs` and `scripts/wake-cwd.mjs` (written out
as `body/manifest.txt`, the list the installer copies), and `templates/` mirrors the
loop-side files under `scripts/install/templates/`. That direction matters — the shared
modules in `src/shared/` are **not** moved into the skill; they stay where the CLI imports
them, and the skill's copy is generated and guarded. OpenClaw never receives the loop copy,
by ruling: its framework already ships an equivalent supervisor.

Those copies are generated artifacts and are committed so that each host directory is
self-contained — but they must always match their sources.

**After editing anything under `skills/`, `scripts/supervisor.mjs`, `scripts/wake-cwd.mjs`,
`src/shared/`, or `scripts/install/templates/`, run:**

```bash
node scripts/sync-skills.mjs
```

CI runs `node scripts/sync-skills.mjs --check` and fails if a generated payload or copy has
drifted. The same reasoning applies to `dist/`: build output is never edited by hand and is
gitignored.

**One more rule for the skills, because they are distributed rather than read in place:** a
link inside `skills/**` must resolve wherever the skill is *installed*, not where it was
authored. The plugin bundles carry `skills/<name>/` and nothing above it, so a
`../../../docs/…` link dangles in every install — link out by absolute URL instead.
`test/skill/loop.test.mjs` asserts no link climbs out of the skill tree.

## Build output

`node scripts/build.mjs` deletes and recreates `dist/`, writes a `dist/web/.gitkeep`
placeholder, and syncs every skill into `dist/plugins/<target>/skills/`. It verifies the
loop payload is current (`sync-loop --check`) rather than regenerating it: a build must not
rewrite the source tree, so a stale payload is a red build instead of a silent divergence.
`dist/` is gitignored, and
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
