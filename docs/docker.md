# Verifying and deploying with Docker

## Why

Local verification, deployment and the four-host skill installs all happen **inside a
container**, never on the host machine. This is a hard constraint for this repository
(Terry, 2026-10-08) and it is recorded in `ARCHITECTURE.md §9.1`:

- a host run mutates the developer's real `$HOME` (skill installs), leaves stray Node
  processes behind, and depends on whatever Node version happens to be on `PATH`;
- a container run is reproducible, disposable, and identical to what CI does.

The rule is not "prefer Docker" — it means the *verification* path is containerized. A
small set of checks is still allowed on the host; see
[Host-allowed checks](#host-allowed-checks).

The **runtime image installs nothing**: the engine is dependency-free, so the final stage
builds offline and there is no root lockfile to drift. The one exception is a separate
`webbuild` stage that assembles the `web/` frontend — its build-time devDependencies are
pinned by the committed `web/package-lock.json` and restored **offline** from the npm cache
committed at `web/.vendor/npm-cache`, and only the static `web/dist` crosses into the
runtime image. See [The web build stage](#the-web-build-stage).

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Engine ≥ 20.10 | `docker version` must reach a daemon. Docker Desktop, colima and rootless Docker all work. |
| Docker Compose v2 ≥ 2.4 | `docker compose` (space, not hyphen). Used for the deploy smoke test only. |
| Network (first build only) | Pulling `node:22-bookworm-slim`. Nothing else: the `web/` devDependencies are restored from the committed cache with `npm ci --offline`, so the image build itself needs no network. The runtime image and every verification step are offline. |

No Node install is required on the host to build or run the image — the image brings
its own. (You *do* need Node on the host for the [host-allowed checks](#host-allowed-checks)
and for driving `npm run verify:docker`, which only shells out to `docker`.)

## Build

```bash
docker build -f docker/Dockerfile -t task-panel:verify .
```

The build context is the repository root, trimmed by the root `.dockerignore` (no `.git`,
no `prototype/`, no `design/`, no `node_modules`). The image:

- is based on `node:22-bookworm-slim`;
- sets `TZ=Asia/Shanghai` — no `tzdata` package is installed, Node's bundled ICU supplies
  the zone. Verify with
  `docker run --rm task-panel:verify node -e "console.log(new Date().toString())"`,
  which should print a `CST` time;
- sets `TASKD_HOST=0.0.0.0` and `TASKD_PORT=9527`;
- runs as the non-root `node` user;
- exposes `9527`;
- defaults to `node src/cli/index.mjs --help`;
- carries `web/dist` — the built board frontend — copied from the `webbuild` stage. `taskd`
  serves that directory as the hosted root (`STATIC_DIR_REL = "web/dist"`). There is no
  `node_modules` in the image.

## The web build stage

`docker/Dockerfile` is multi-stage, because the repository has two build layers (see
[development.md](development.md#two-build-layers-engine-and-web)):

1. **`webbuild`** — `COPY . .`, then a three-way guard decides how the `web/` frontend is
   installed, followed by the Vite build, producing `web/dist`:

   | `web/package.json` | `web/.vendor/npm-cache` | Action |
   |---|---|---|
   | present | present | `npm ci --offline --cache /app/web/.vendor/npm-cache` — **offline**, from the committed cache. The path a clean checkout always takes. |
   | present | absent | plain `npm ci` — networked, pinned by `web/package-lock.json`. Only a stripped checkout that deleted the committed cache lands here; it is **not** the committed configuration. |
   | absent | — | skip; `web/dist` stays empty |

   Every branch runs `mkdir -p /app/web/dist`, so the runtime stage's
   `COPY --from=webbuild /app/web/dist` always has a source. An empty `web/dist` is
   equivalent to none at all: `taskd` probes for `index.html` and 404s as before.

   > **Boundary (F1-c, ruling O1, 2026-10-09).** The npm cache at `web/.vendor/npm-cache`
   > **is committed**, so the image builds with **no network** — `docker build
   > --network=none` succeeds. `npm ci --offline` hard-fails rather than silently reaching
   > the registry if a tarball is missing, so the offline path cannot quietly degrade to
   > the network. Runtime and every verification step are offline too. The cache is a
   > **generated artefact** (linux/arm64, produced inside the arm64 container), not a
   > hand-edited source: **after any `web/package.json` dependency bump, re-vendor it**
   > (see [Re-vendoring the npm cache](#re-vendoring-the-npm-cache)) and commit the
   > refreshed cache together with the lockfile. `web/package-lock.json` stays committed —
   > it pins the dependency tree the cache is built from.
2. **runtime** (`node:22-bookworm-slim`, the final stage) — the repository as-is, plus
   `COPY --from=webbuild /app/web/dist /app/web/dist`. This stage installs nothing and is
   unchanged by the frontend build mode. Nothing from the frontend toolchain ships: no
   `node_modules`, no Vite.

The `web/` workspace has landed with M6b; its built `web/dist` is the hosted frontend root.
When `web/package.json` is absent from a checkout the stage is a no-op that still emits an
empty `/app/web/dist`, so the image keeps building and the runtime contract holds.

## Re-vendoring the npm cache

`web/.vendor/npm-cache` is the committed npm cache that makes the `webbuild` stage offline.
It is the npm cache **of the arm64 linux container**, not of the host: it holds only the
linux/arm64 optional binaries (`@rolldown/binding-linux-arm64-gnu`,
`@tailwindcss/oxide-linux-arm64-gnu`, `lightningcss-linux-arm64-gnu`, …) — the packages the
in-image `npm ci` actually needs — and no darwin/win32 variants. That is why the vendoring
step runs **inside the container** and never against the host `web/node_modules`:

```bash
mkdir -p web/.vendor/npm-cache
docker run --rm \
  -v "$PWD/web/package.json:/src/package.json:ro" \
  -v "$PWD/web/package-lock.json:/src/package-lock.json:ro" \
  -v "$PWD/web/.vendor/npm-cache:/cache" -w /src node:22-bookworm-slim \
  sh -c 'npm ci --cache /cache --ignore-scripts'
```

This installs the tree into the throwaway container (from `package.json` /
`package-lock.json`, mounted read-only) and leaves only the cache tarballs in
`web/.vendor/npm-cache` — the host `web/node_modules` is never touched. Re-run it whenever
`web/package.json`/`web/package-lock.json` change, then commit the refreshed cache **with**
the lockfile; they must move together. The `--ignore-scripts` flag keeps the step to a pure
download-and-cache — no native build runs here.

Confirm the F1-c guarantee after re-vendoring:

```bash
docker build --network=none -t task-panel:verify -f docker/Dockerfile .
```

`--network=none` must succeed; if it fails, a tarball the lockfile needs is missing from
the cache.

## Run

The `taskd` service is described by `docker/docker-compose.yml`:

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps        # wait for "healthy"
curl -s http://127.0.0.1:9527/health
docker compose -f docker/docker-compose.yml down -v
```

`/health` answers:

```json
{"status":"ok","stage":"scaffold","version":"1.0.0","uptimeMs":42}
```

Anything else returns `404 {"error":"not_found"}`.

> **M0 note (still true after M6a).** `docker/serve-skeleton.mjs` is a deploy skeleton:
> it serves `/health` and nothing else, purely so the compose path (build → healthcheck →
> teardown) can be exercised without starting a real board with real state. The **real**
> HTTP surface now exists under `src/server/` (M6a) and is what the container suite starts
> and drives: `docker run --rm task-panel:verify node src/server/main.mjs`, plus the
> `test/server/*` integration cases that run inside `npm run verify:docker`. Pointing
> `docker-compose.yml`'s `command` at `src/server/main.mjs` is a one-line deploy change
> left for a follow-up card, because the compose healthcheck contract (`/health` says
> ok) is shared by both servers and this milestone keeps it pinned as-is.

The board's runtime state is bind-mounted from the repository (`../.data` →
`/app/.data`), so `docker compose down -v` never destroys it. Only named volumes are
removed; the bind mount is a host directory.

## One-click verify

```bash
npm run verify:docker
```

This is the whole suite, host-side, in one command. It:

1. builds `task-panel:verify` from `docker/Dockerfile`;
2. runs `docker run --rm task-panel:verify bash docker/verify-in-container.sh`;
3. brings the compose service up, polls `docker inspect` until the `/health`
   healthcheck reports `healthy` (60 s budget), then always tears down with
   `docker compose down -v` — teardown is in a `finally` block, so a failure does not
   leave containers or volumes behind;
4. prints a `SUMMARY` of every phase and exits non-zero if any of them failed.

It exits immediately with a clear message if no Docker daemon is reachable, changing
nothing.

Already inside the image? Run the same suite directly:

```bash
npm run verify:docker:container      # bash docker/verify-in-container.sh
```

`docker/verify-in-container.sh` is the single source of truth for "is this repository
healthy" — CI runs it too:

| Step | Command |
|---|---|
| 1 | `node --test` |
| 2 | `npm run check` (skill sync, manifests, skill definition, tests) |
| 3 | `bash install.sh --target all --dry-run` |
| 4 | `node scripts/verify/profiles.mjs` |

Each step prints an `== ... ==` header and the script aborts on the first failure.

## Profiles

`docker/profiles/*.yml` describes one flat profile per supported agent host:

| Host | `target_dir` | `installer` |
|---|---|---|
| `claude` | `.claude/skills/task-panel` | `scripts/install/claude.sh` |
| `openclaw` | `.openclaw/skills/task-panel` | `scripts/install/openclaw.sh` |
| `codex` | `.codex/skills/task-panel` | `scripts/install/codex.sh` |
| `pi` | `.agents/skills/task-panel` | `scripts/install/pi.sh` |

Each file has the same six keys: `host`, `label`, `installer`, `target_dir`,
`skill_entry`, `wrapper`. They are read by a tiny flat-map parser
(`scripts/verify/lib/mini-yaml.mjs`) — this project takes no YAML dependency, so a
profile must stay a flat `key: value` map. Unsupported syntax is a hard error with a
line number.

`node scripts/verify/profiles.mjs` installs all four hosts and asserts, per host:

- the skill directory exists at `<home>/<target_dir>`;
- `SKILL.md` still carries `name: task-panel` in its frontmatter;
- `node <dest>/scripts/run.mjs --version` prints the version from
  `src/shared/constants.mjs`.

### Why a temporary home

Nothing is ever installed into a real host directory. Every profile install runs against
a throwaway home:

```bash
node scripts/verify/profiles.mjs --home "$(mktemp -d)"
```

The default is `$TMPDIR/taskpanel-profiles-<pid>`, and the installer is driven through
the same `TASKPANEL_TARGET_HOME` variable that `install.sh --prefix <dir>` sets — so the
check is equivalent to a real install while touching only a temp directory. This is how
the four-host matrix is verified on a machine that does not (and should not) have those
hosts installed: the profile's `target_dir` and `installer` are exercised for real, and
the installed skill is executed through its own wrapper.

The verification installs with `--link` semantics (`TASKPANEL_LINK=1`), matching
`install.sh --link`. The skill's wrapper resolves the CLI relative to its own file
location, so only a symlinked skill points back at this checkout; a copied skill has no
`src/` next to it. See [Troubleshooting](#troubleshooting).

## Host-allowed checks

The container rule covers *running the project and its installs*. These stay on the
host, because they are static or pure and touch nothing:

- `node --test` and `node --check` (parsing and unit tests);
- `node scripts/verify/manifests.mjs`, `node scripts/verify/skill.mjs`,
  `node scripts/sync-skills.mjs --check`;
- `git` operations, file listing and inspection;
- static rendering/screenshots of the design prototype under `prototype/`;
- browser-rendered frontend checks — the DOM/selector contract assertions and the
  prototype-vs-implementation screenshots for `web/`. The image has no Chromium (installing
  it needs an apt mirror, i.e. network at build time), so these stay on the host, driving a
  host-installed Chrome. This is the "browser rendering" exception under §9.1. For the same
  reason `test/web/tokens.parity.test.mjs` reads `design/brand/tokens.css`, which
  `.dockerignore` keeps out of the image, so it skips inside the container.

Everything that *installs*, *serves*, or *deploys* goes through Docker.

## CI

`.github/workflows/check.yml` has two jobs:

- `check` — the host-side static job, on a **Node 22 and Node 24 matrix**
  (`fail-fast: false`, both legs run the full step list; **no `npm install`**: it only runs
  source, scripts and tests, which need no packages). It runs `node --test`, the coverage
  gate (`npm run test:coverage`) and the `scripts/verify/*` checkers;
- `docker` — builds `task-panel:verify` exactly like the local command and runs the same
  in-container script. This is the authoritative job, and the only one that touches the
  frontend: the `webbuild` stage installs `web/`'s devDependencies **offline** from the
  committed cache (`npm ci --offline`), so the CI build reaches no registry. There is
  deliberately no host-side frontend job, which would install packages on the runner and
  violate the container-first rule.

Same tag, same command, same script as `npm run verify:docker` — locally green means
CI green. See
[development.md](development.md#local-and-ci-run-the-same-commands) for the local
equivalent of each job.

## Cleanup

```bash
docker compose -f docker/docker-compose.yml down -v   # containers + anonymous volumes
docker rmi task-panel:verify task-panel:local         # images
docker image prune                                    # dangling layers, if you want them gone
```

`npm run verify:docker` cleans up after itself; these commands are for when a run was
interrupted. To confirm nothing is left:

```bash
docker ps -a --filter ancestor=task-panel:verify --filter ancestor=task-panel:local
```

## Troubleshooting

**`verify:docker` exits immediately: "cannot reach the Docker daemon".**
The daemon is not running. Start Docker Desktop / `colima start`, confirm with
`docker version`, then re-run. Nothing was changed.

**The image build hangs, or the pull of `node:22-bookworm-slim` stalls.**
This is usually the host's proxy plus a fake-IP DNS resolver: the daemon resolves
`registry-1.docker.io` to a synthetic address it cannot reach. Options, in order:

1. Build with a mirror, e.g.
   `docker build --build-arg HTTP_PROXY=... `, or configure the daemon's proxy in the
   Docker Desktop settings / `~/.docker/config.json`;
2. Pull the base image separately and let the build hit the local cache:
   `docker pull node:22-bookworm-slim`;
3. Retry — the first pull is the slow part; afterwards the image is cached and the build
   never touches the network.

**A container cannot resolve DNS.**
Do not rely on the host's DNS inside the container. The verification suite needs no
network at all (no installs, no external calls), so if something inside the container is
reaching out, it is a bug — the point of the container is that the suite runs offline.

**The image build is slow every time.**
Check the build context size. The root `.dockerignore` excludes `.git`, `prototype/`,
`design/`, `node_modules/`, `.data/` and `coverage/`; a large context almost always means
one of those got re-included. The one thing under `web/` that *is* shipped is the committed
npm cache at `web/.vendor/npm-cache` (linux-only, ~25 MB / ~100 files) — that is expected,
not bloat. `web/node_modules/` and `web/dist/` are gitignored, so a clean checkout's context
stays small.

**The build fails with `npm error code EUSAGE`/`ENOTCACHED` under `npm ci --offline`.**
A tarball the lockfile needs is missing from `web/.vendor/npm-cache` — usually because
`web/package.json`/`web/package-lock.json` were bumped without re-vendoring. Re-run the
[re-vendoring step](#re-vendoring-the-npm-cache) and commit the refreshed cache with the
lockfile.

**`profiles: ... wrapper ... exit 1` / `Cannot find module .../src/cli/index.mjs`.**
The skill was *copied* instead of linked, so the wrapper's relative path walked up out of
the checkout. Install with `--link` (`install.sh --link`, or `TASKPANEL_LINK=1`), which
is what `scripts/verify/profiles.mjs` does.

**Port 9527 is already in use on the host.**
`docker compose up` fails to bind. Stop the other listener, or edit the published port in
`docker/docker-compose.yml` (the container-internal port stays 9527).
