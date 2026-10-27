# Verifying and deploying with Docker

## Why

Local verification, deployment and the four-agent-kind skill installs all happen **inside a
container**, never on the operator's machine. This is a hard constraint for this repository
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

**Docker is not the distribution path.** The user-facing install is `npx meerkat-taskpanel`
(or `install.sh --target server`) on the user's own machine, which materializes the runtime
at `~/.meerkat-taskpanel` — see [install.md § Install methods](install.md#install-methods).
The container keeps its own layout (`/app`, with `/app/.data` as the compose volume) and the
install tree never enters the image. What the container gate checks is the *installer*: step
8 below runs both entry points against a throwaway home, the same rule as every other
install.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Engine ≥ 20.10 | `docker version` must reach a daemon. Docker Desktop, colima and rootless Docker all work. |
| Docker Compose v2 ≥ 2.4 | `docker compose` (space, not hyphen). Used for the deploy smoke test only. |
| Network (only if the base image is absent) | `node:22-bookworm-slim`. Nothing else: the `web/` devDependencies are restored from the committed cache with `npm ci --offline`, so the image build itself needs no network. `verify:docker` **preflights** the base image against the local image store — a cached image means the run never touches the network, and only a genuinely missing one causes a single explicit `docker pull`. See [Base image cache](#base-image-cache). The runtime image and every verification step are offline. |

No Node install is required on the host to build or run the image — the image brings
its own. (You *do* need Node on the host for the [host-allowed checks](#host-allowed-checks)
and for driving `npm run verify:docker`, which only shells out to `docker`.)

## Build

```bash
docker build -f docker/Dockerfile -t meerkat-taskpanel:verify .
```

The build context is the repository root, trimmed by the root `.dockerignore` (no `.git`,
no `design/`, no `node_modules`). The image:

- is based on `node:22-bookworm-slim`;
- sets `TZ=Asia/Shanghai` — no `tzdata` package is installed, Node's bundled ICU supplies
  the zone. Verify with
  `docker run --rm meerkat-taskpanel:verify node -e "console.log(new Date().toString())"`,
  which should print a `CST` time;
- sets `TASKD_HOST=0.0.0.0` and `TASKD_PORT=9527`;
- runs as the non-root `node` user;
- exposes `9527`;
- defaults to `node src/cli/index.mjs --help`;
- carries `web/dist` — the built board frontend — copied from the `webbuild` stage. `taskd`
  serves that directory as the hosted root (`STATIC_DIR_REL = "web/dist"`). There is no
  `node_modules` in the image.
- reads the install-root `.env` like a host install. `.env` is in `.dockerignore`, so a
  developer's file (and any token in it) is never baked into the image. The compose files set
  `MEERKAT_TASKPANEL_ENV_FILE=/app/.data/.env`, so an Access-panel save lands on the data
  volume and survives a container recreate; the scaffold (`docker/serve-skeleton.mjs`) uses
  the same loader. `--env-file` / `MEERKAT_TASKPANEL_ENV_FILE` is the escape hatch for a
  read-only install root.

## Base image cache

`node:22-bookworm-slim` is the only external artefact the build needs, and Docker's
default build policy is `--pull=missing`: a pruned image store, a fresh CI runner or a new
machine silently re-downloads it before the gate can start. The base image is ~80 MB
compressed, and on a host whose daemon proxy or DNS is broken that pull does not just cost
time — it turns a healthy tree into a red gate.

`npm run verify:docker` therefore runs a **preflight** before any build
(`scripts/verify/lib/base-image.mjs`):

1. every base image named by a `FROM` line is inspected in the local image store
   (`docker image inspect`). Present → the run never touches the network;
2. missing → one explicit `docker pull`, announced in the step header, and nothing else;
3. `MEERKAT_TASKPANEL_OFFLINE=1` forbids even that one pull. The failure tells you how to
   seed the local store from a tarball:
   ```bash
   docker pull node:22-bookworm-slim && docker save node:22-bookworm-slim -o node-22-bookworm-slim.tar
   docker load -i node-22-bookworm-slim.tar
   ```
4. the build is given the builder's no-pull flag — `--pull=false` on the legacy builder,
   `--pull=never` on BuildKit, chosen from the `docker build --help` text — so the build
   itself can never fetch implicitly, even if the image disappeared between the preflight
   and the build.

The preflight is per-image and per-run, not per-layer: the build cache still decides how
much of the image is rebuilt. It is also deliberately **not** a freshness check — a cached
`node:22-bookworm-slim` is used as-is, however old. Refreshing it is an explicit act:
`docker pull node:22-bookworm-slim`, then re-run (or `docker rmi` it first to have the
preflight do the one pull).

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

> **`web/dist` is excluded from the build context** (`.dockerignore`), so the `webbuild`
> stage's own `vite build` is the only thing that writes `/app/web/dist`. That matters
> because a directory `COPY` **merges**: a developer machine carrying a locally built
> `web/dist` would otherwise land it beside the fresh one, and Vite's `emptyOutDir` cannot
> remove files it did not write. The two builds name their chunks by content hash, so the
> mixture survives as a tree with several generations of `assets/*.js` in it — and the
> hook-surface leg (`test/web/blocks.bundle.test.mjs`) scans *every* chunk, so the stale
> ones are read as if the app still carried retired hooks. The runtime stage's
> `COPY . .` no longer brings a frontend build with it; `COPY --from=webbuild` does.

## Re-vendoring the npm cache

`web/.vendor/npm-cache` is the committed npm cache that makes the `webbuild` stage offline.
It is the npm cache **of a linux container**, not of the host: it holds the linux optional
binaries (`@rolldown/binding-linux-*-gnu`, `@tailwindcss/oxide-linux-*-gnu`,
`lightningcss-linux-*-gnu`, …) — the packages the in-image `npm ci` actually needs — and no
darwin/win32 variants. That is why the vendoring step runs **inside the container** and
never against the host `web/node_modules`.

It has to cover **both** linux architectures the image is built on, and the command below
is therefore run **once per architecture**, into the same cache directory. cacache is
content-addressed, so the two runs merge rather than overwrite:

```bash
mkdir -p web/.vendor/npm-cache
for platform in linux/arm64 linux/amd64; do
  docker run --rm --platform "$platform" \
    -v "$PWD/web/package.json:/src/package.json:ro" \
    -v "$PWD/web/package-lock.json:/src/package-lock.json:ro" \
    -v "$PWD/web/.vendor/npm-cache:/cache" -w /src node:22-bookworm-slim \
    sh -c 'npm ci --cache /cache --ignore-scripts'
done
```

> **Why both, and why it is easy to miss.** The image is built on `linux/arm64` (a
> developer on Apple Silicon) *and* on `linux/amd64` (CI's `docker` job runs on
> `ubuntu-latest`, x86_64). A cache produced by only one of those runs names only that
> architecture's binaries.
>
> The failure that follows is **quiet**: `npm ci --offline` does *not* fail on the
> uncovered architecture, because those platform packages are `optionalDependencies` and
> npm tolerates their absence. It surfaces one step later, in `vite build`, as
> `Error: Cannot find native binding` — rolldown loads no native binding and then falls
> back to `@rolldown/binding-wasm32-wasi`, which a single-architecture cache does not hold
> either. So a single-arch cache does not break the *install*; it breaks the *build*, on
> the architecture nobody ran the vendoring step on.
>
> `test/docker.test.mjs` asserts all six binaries are present, straight from the cacache
> index — no docker and no network, so it runs with the rest of the suite.

This installs the tree into the throwaway container (from `package.json` /
`package-lock.json`, mounted read-only) and leaves only the cache tarballs in
`web/.vendor/npm-cache` — the host `web/node_modules` is never touched. Re-run it whenever
`web/package.json`/`web/package-lock.json` change, then commit the refreshed cache **with**
the lockfile; they must move together. The `--ignore-scripts` flag keeps the step to a pure
download-and-cache — no native build runs here.

Confirm the F1-c guarantee after re-vendoring, on **each** architecture:

```bash
docker build --network=none --platform linux/arm64 -t meerkat-taskpanel:verify -f docker/Dockerfile .
docker build --network=none --platform linux/amd64 -t meerkat-taskpanel:verify -f docker/Dockerfile .
```

`--network=none` must succeed for both; if it fails, a tarball the lockfile needs is
missing from the cache for that architecture.

## Run

The `taskd` service is described by `docker/docker-compose.yml`:

```bash
# -p: one project per checkout. Without it compose derives the name from the
# directory — and every worktree has a `docker/` — so two lanes verifying at once
# share `docker-taskd-1` and the later one fails with "container name ... is
# already in use". `verify:docker` passes this itself (`composeProjectName`); the
# line below shows what to type by hand.
docker compose -p meerkat-taskpanel-local -f docker/docker-compose.yml up -d --build
docker compose -p meerkat-taskpanel-local -f docker/docker-compose.yml ps   # wait for "healthy"
curl -s http://127.0.0.1:9527/health
docker compose -p meerkat-taskpanel-local -f docker/docker-compose.yml down -v
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
> and drives: `docker run --rm meerkat-taskpanel:verify node src/server/main.mjs`, plus the
> `test/server/*` integration cases that run inside `npm run verify:docker`. Pointing
> `docker-compose.yml`'s `command` at `src/server/main.mjs` is a one-line deploy change
> left for a follow-up card, because the compose healthcheck contract (`/health` says
> ok) is shared by both servers and this milestone keeps it pinned as-is.

The board's runtime state is bind-mounted from the repository (`../.data` →
`/app/.data`), so `docker compose down -v` never destroys it. Only named volumes are
removed; the bind mount is a host directory.

## Dev / manual preview (Vite HMR)

The verification image is deliberately install-free at run time. For **manual
preview**, `docker/Dockerfile` carries a separate `dev` target (placed before the
runtime stage, so a plain build still produces the shipping image): it reuses the
`webbuild` stage's offline `npm ci`, starts `taskd` on loopback and Vite's dev
server in the same container, and bind-mounts `web/src` (plus the HTML / public /
config) for HMR. The browser talks only to Vite at **19527**; `/api` and `/health`
are proxied to the container's taskd by `web/vite.config.js`.

```bash
# Optional: point the container at an existing board's data directory. Unset it
# to use the repository's gitignored .data/.
export TASKD_DATA_DIR=/path/to/.board-test

docker compose -p meerkat-taskpanel-dev -f docker/docker-compose.dev.yml up -d --build
curl -s http://127.0.0.1:19527/health       # proxied to the container's taskd
# open http://127.0.0.1:19527/
docker compose -p meerkat-taskpanel-dev -f docker/docker-compose.dev.yml logs -f
docker compose -p meerkat-taskpanel-dev -f docker/docker-compose.dev.yml down
```

- `web/node_modules` stays the image's own (anonymous volume); the bind mounts
  cover source only.
- `VITE_USE_POLLING=1` is set for Docker Desktop / macOS file watching. A plain
  host `npm run dev` keeps the event-based watcher.
- **Live on both halves.** `web/src` updates through Vite HMR; `src/**` is
  bind-mounted too and restarts taskd in place through Node's `--watch` (the
  dev entry runs `node --watch --watch-preserve-output src/server/main.mjs`).
  No rebuild or republish is needed for either. Changes to `docker/`, `web/vite.config.js`,
  `web/package.json` or dependencies still need a compose restart/rebuild.
- This environment is for a human to inspect changes live; it is not the
  verification gate (`npm run verify:docker`).

## One-click verify

```bash
npm run verify:docker
```

This is the whole suite, host-side, in one command. It:

1. builds `meerkat-taskpanel:verify` from `docker/Dockerfile`;
2. runs `docker run --rm meerkat-taskpanel:verify bash docker/verify-in-container.sh`;
3. brings the compose service up, polls `docker inspect` until the `/health`
   healthcheck reports `healthy` (60 s budget), then always tears down with
   `docker compose down -v` — teardown is in a `finally` block, so a failure does not
   leak a container or a volume. Both are addressed by a **per-checkout project
   name** (`composeProjectName`), which is what lets two worktrees verify
   concurrently
   leave containers or volumes behind;
4. prints a `SUMMARY` of every phase and exits non-zero if any of them failed.

It exits immediately with a clear message if no Docker daemon is reachable, changing
nothing.

The same command runs automatically from `.githooks/pre-push` on every **branch** push,
after the static gates and only when they pass. A tag-only push and a branch deletion change
no tree, so they skip it; `SKIP_CONTAINER_VERIFY=1 git push …` opts out for one push, and
`git push --no-verify` bypasses the hook entirely. Because the gate runs on the push, merging
into `dev` ends with `npm run check` (host-static) rather than a separate container run. The
image bakes the working tree, so commit before pushing.

Already inside the image? Run the same suite directly:

```bash
npm run verify:docker:container      # bash docker/verify-in-container.sh
```

`docker/verify-in-container.sh` is the single source of truth for "is this repository
healthy" — the CI `docker` job runs the exact same script, so this file is where a new
check belongs. Its steps, in order:

| Step | Command |
|---|---|
| 0 | `node scripts/verify/web-dist.mjs --require=bundle` (frontend coverage verdict) |
| 1 | `node --test` |
| 2 | `npm run test:coverage` (the line/branch/function floors) |
| 3 | `npm run check` (skill sync, manifests, skill definition, tests) |
| 4 | `node scripts/verify/contract.mjs` (API contract snapshot) |
| 5 | `node scripts/verify/route-request.mjs` (declared request schema vs handler reads) |
| 6 | `bash install.sh --target all --dry-run` |
| 7 | `node scripts/verify/profiles.mjs` (every agent kind, throwaway home) |
| 8 | `node scripts/verify/server-install.mjs` (npm/npx and source server install, launchers, `/health`) |
| 9 | `node scripts/verify/kind-runtime.mjs` (offline agent-kind runtime harness) |
| 10 | `bash scripts/verify/install-e2e.sh` (install + first-run end-to-end) |

Each step prints an `== ... ==` header and the script aborts on the first failure.

> Steps 7, 8 and 10 install into throwaway homes. Step 8 materializes the server tree at a
> temporary `--prefix`, drives both entry points (`scripts/install/cli.mjs`, which is what
> `npx` runs, and `install.sh --target server`), and finally starts the installed
> `bin/taskd` on an ephemeral port to prove `/health` — so it is container-only, because it
> starts a real board. Step 10 is the deepest — it also drives the real `taskctl` against a
> real `taskd` — and it is the reason `npm run verify:docker` and the CI `docker` job can no
> longer disagree: it used to live only in CI, as a separate `docker run` *after* this
> script, so the two tracks diverged and the local command could be green while CI was red.
> See [CI](#ci).

## Profiles

`docker/profiles/*.yml` describes one flat profile per supported agent kind:

| Agent kind | `target_dir` | `installer` |
|---|---|---|
| `claude` | `.claude/skills/meerkat-taskpanel` | `scripts/install/claude.sh` |
| `openclaw` | `.openclaw/skills/meerkat-taskpanel` | `scripts/install/openclaw.sh` |
| `codex` | `.codex/skills/meerkat-taskpanel` | `scripts/install/codex.sh` |
| `pi` | `.agents/skills/meerkat-taskpanel` | `scripts/install/pi.sh` |

Each file has the same six keys: `actor_kind`, `label`, `installer`, `target_dir`,
`skill_entry`, `wrapper`. They are read by a tiny flat-map parser
(`scripts/verify/lib/mini-yaml.mjs`) — this project takes no YAML dependency, so a
profile must stay a flat `key: value` map. Unsupported syntax is a hard error with a
line number.

`node scripts/verify/profiles.mjs` installs every profiled agent kind and asserts, per agent kind:

- the skill directory exists at `<home>/<target_dir>`;
- `SKILL.md` still carries `name: meerkat-taskpanel` in its frontmatter;
- `node <dest>/scripts/run.mjs --version` prints the version from
  `src/foundation/constants.mjs`.

### Why a temporary home

Nothing is ever installed into a real agent directory. Every profile install runs against
a throwaway home:

```bash
node scripts/verify/profiles.mjs --home "$(mktemp -d)"
```

The default is `$TMPDIR/meerkat-taskpanel-profiles-<pid>`, and the installer is driven through
the same `MEERKAT_TASKPANEL_TARGET_HOME` variable that `install.sh --prefix <dir>` sets — so the
check is equivalent to a real install while touching only a temp directory. This is how
the four-agent-kind matrix is verified on a machine that does not (and should not) have those
agent kinds installed: the profile's `target_dir` and `installer` are exercised for real, and
the installed skill is executed through its own wrapper.

The verification installs with `--link` semantics (`MEERKAT_TASKPANEL_LINK=1`), matching
`install.sh --link`. That is what keeps this check on the wrapper's **checkout-relative**
rung: a symlinked skill still has this checkout three levels up, so `run.mjs` finds the CLI
beside it, and `--version` exercises that path end to end. The mode `install.sh` *defaults*
to — a copy, which carries no `src/` — is covered per agent kind by
`test/install/installed-copy.test.mjs`: it installs the agent kinds by copy and asserts the
wrapper falls back to `taskctl` on `PATH` or to an explicitly named checkout, and otherwise
refuses with an actionable remedy rather than a crash. See
[Troubleshooting](#troubleshooting).

## Host-allowed checks

The container rule covers *running the project and its installs*. These stay on the
host, because they are static or pure and touch nothing:

- `node --test` and `node --check` (parsing and unit tests);
- `node scripts/verify/manifests.mjs`, `node scripts/verify/skill.mjs`;
- `git` operations, file listing and inspection;
- static rendering/screenshots of the design prototype under `design/prototype/`;
- browser-rendered frontend checks — the DOM/selector contract assertions and the
  prototype-vs-implementation screenshots for `web/`. The image has no Chromium (installing
  it needs an apt mirror, i.e. network at build time), so these stay on the host, driving a
  host-installed Chrome. This is the "browser rendering" exception under §9.1. For the same
  reason `test/web/i18n.catalogue.test.mjs` reads `design/prototype/index.html`, which
  `.dockerignore` keeps out of the image, so it self-skips inside the container.

Everything that *installs*, *serves*, or *deploys* goes through Docker.

## Which of `node --test`'s legs actually ran

Two of the suites live behind a `web/dist` guard — `test/web/blocks.bundle.test.mjs` (the
hook surface survived the build) and `test/web/blocks.dom.test.mjs` (the browser layer).
They **skip** rather than fail when there is no build, so `node --test`'s `fail 0` is also
true of a run that never exercised either. In practice they skip in two places:

- a **lane worktree**, because `web/dist` is a gitignored build product and there is none;
  and
- the **container**, for the DOM leg only — the image deliberately carries no Chromium.

`scripts/verify/web-dist.mjs` reads the build on disk and names each leg:

```bash
node scripts/verify/web-dist.mjs              # verdict only; exits 0
node scripts/verify/web-dist.mjs --build      # rebuild first when the build is missing/stale
npm run verify:web-dist                       # the fail-closed form (exit 3 unless both legs ran)
```

It classifies the build as `unbuilt`, `stale` or `fresh`, and reports each leg `COVERED` or
`UNCOVERED` with the reason. `npm run verify` runs it (rebuilding when it can), and
`docker/verify-in-container.sh` runs it with `--require=bundle` — the image builds the
frontend itself, so the bundle leg is required there and a `webbuild` stage that quietly
emitted nothing fails the run instead of showing up as two quiet skips.

The rebuild is a whole-tree write, so it goes through the team's `build-guard.mjs` lock when
that checkout has one (`--build-guard=auto`, the default): another lane's build serializes
with it rather than racing. A lock held elsewhere means the rebuild is **not attempted**, and
the verdict says that instead of reporting a failed build.

**A stale build is a false red.** When `web/dist` is older than `web/src`, the bundle leg
reports "these hooks are absent from the bundle" and the DOM leg a rule failure — both of
which read like contract violations and are really one stale artefact. Rebuild
(`npm -w web run build`, or the `--build` form above) before believing either. A host that
cannot build (a `darwin` machine with only the committed linux/arm64 cache, say) cannot
repair it either, which is exactly why the missing build is *reported* rather than treated
as a failure by default.

## CI

`.github/workflows/check.yml` has two jobs:

- `check` — the host-side static job, on a **Node 22 and Node 24 matrix**
  (`fail-fast: false`, both legs run the full step list; **no `npm install`**: it only runs
  source, scripts and tests, which need no packages). It runs `node --test`, the coverage
  gate (`npm run test:coverage`) and the `scripts/verify/*` checkers;
- `docker` — builds `meerkat-taskpanel:verify` exactly like the local command and runs the same
  in-container script, `docker/verify-in-container.sh`. This is the authoritative job, and
  the only one that touches the frontend: the `webbuild` stage installs `web/`'s
  devDependencies **offline** from the committed cache (`npm ci --offline`), so the CI
  build reaches no registry. There is deliberately no host-side frontend job, which would
  install packages on the runner and violate the container-first rule.

Same tag, same command, same script as `npm run verify:docker`'s second phase, and the
same step list — no check runs in the container here that does not also run locally.
The one asymmetry left is *additive and local-only*: `npm run verify:docker` also runs a
third phase, the compose deploy smoke test (`docker compose up -d --build` → poll `/health`
→ `down -v`, see [One-click verify](#one-click-verify)), which the CI job does not repeat.
It can only make the local run stricter, never greener.

The **`check` job**, by contrast, does *not* have a local one-command equivalent, and two
of its properties are not reproduced by `verify:docker`:

- it runs a **Node 22 and Node 24 matrix**, while the image is Node 22 only
  (`node:22-bookworm-slim`) — a Node-24-only regression would be red in CI and green
  locally;
- it runs `bash -n` on the shell scripts directly on the host. (Its behaviour is still
  covered in the container — `test/docker.test.mjs` runs `bash -n` on both container
  scripts — but the standalone check is not.)

"Locally green means CI green" therefore holds for the `docker` job exactly, and for the
`check` job only up to the Node version and that standalone checker. See
[development.md](development.md#local-and-ci-run-the-same-commands) for the local
equivalent of each job.

## Cleanup

```bash
docker compose -f docker/docker-compose.yml down -v   # containers + anonymous volumes
docker rmi meerkat-taskpanel:verify meerkat-taskpanel:local         # images
docker image prune                                    # dangling layers, if you want them gone
```

`npm run verify:docker` cleans up after itself; these commands are for when a run was
interrupted. To confirm nothing is left:

```bash
docker ps -a --filter ancestor=meerkat-taskpanel:verify --filter ancestor=meerkat-taskpanel:local
```

## Troubleshooting

**`verify:docker` exits immediately: "cannot reach the Docker daemon".**
The daemon is not running. Start Docker Desktop / `colima start`, confirm with
`docker version`, then re-run. Nothing was changed.

**The base-image preflight fails, or its one pull stalls.**
If the image is already local the preflight never pulls, so a stall here means the image is
genuinely missing *and* the daemon cannot reach the registry. That is usually the host's
proxy plus a fake-IP DNS resolver: the daemon resolves `registry-1.docker.io` to a synthetic
address it cannot reach. Options, in order:

1. Configure the daemon's proxy in the Docker Desktop settings / `~/.docker/config.json`,
   or seed the image through a mirror;
2. Seed the local store once from a host that can reach the registry, then re-run — the
   preflight will find it and the build will never touch the network:
   ```bash
   docker pull node:22-bookworm-slim
   docker save node:22-bookworm-slim -o node-22-bookworm-slim.tar   # or copy this file over
   docker load -i node-22-bookworm-slim.tar
   ```
3. If you want the gate to prove it is fully offline, run it with
   `MEERKAT_TASKPANEL_OFFLINE=1 npm run verify:docker` — a missing image is then a clear
   failure instead of a silent download.

**A container cannot resolve DNS.**
Do not rely on the host's DNS inside the container. The verification suite needs no
network at all (no installs, no external calls), so if something inside the container is
reaching out, it is a bug — the point of the container is that the suite runs offline.

**The image build is slow every time.**
Check the build context size. The root `.dockerignore` excludes `.git`, `design/`,
`node_modules/`, `.data/` and `coverage/`; a large context almost always means
one of those got re-included. The one thing under `web/` that *is* shipped is the committed
npm cache at `web/.vendor/npm-cache` (linux-only, ~25 MB / ~100 files) — that is expected,
not bloat. `web/node_modules/` and `web/dist/` are gitignored, so a clean checkout's context
stays small.

**The build fails with `npm error code EUSAGE`/`ENOTCACHED` under `npm ci --offline`.**
A tarball the lockfile needs is missing from `web/.vendor/npm-cache` — usually because
`web/package.json`/`web/package-lock.json` were bumped without re-vendoring. Re-run the
[re-vendoring step](#re-vendoring-the-npm-cache) and commit the refreshed cache with the
lockfile.

**`profiles: ... wrapper ... exit 1` / `meerkat-taskpanel: cannot find the board CLI to run`.**
The wrapper found no CLI on any rung: no checkout named by `MEERKAT_TASKPANEL_ROOT` or
`MEERKAT_TASKPANEL_REPO`, no checkout around the skill itself (an installed copy carries no
`src/`), and no `taskctl` on `PATH`. The message prints what it looked for and the three
ways in; pick one — install the CLI and put it on `PATH` (`install.sh --target <agent-kind>`),
name a checkout in `MEERKAT_TASKPANEL_ROOT`, or run that checkout's own
`skills/meerkat-taskpanel/scripts/run.mjs`. A *copied* skill is not a failure by itself:
before T-20261014-214002 this case died with `Cannot find module .../src/cli/index.mjs`,
and reinstalling with `--link` was the only way out.

**Port 9527 is already in use on the host.**
`docker compose up` fails to bind. Stop the other listener, or edit the published port in
`docker/docker-compose.yml` (the container-internal port stays 9527).
