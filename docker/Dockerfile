# Meerkat TaskPanel — containerized verification / deploy image.
#
# There are two build layers, and keeping them apart is the whole point of the stages:
#
#   * runtime (the final stage) — Node 22 plus the repository itself. The engine
#     (`src/core`, `src/cli`, `src/server`) has ZERO runtime dependencies:
#     nothing is installed, nothing is fetched, so this stage builds offline and
#     reproduces exactly on any machine.
#   * webbuild (the first stage) — the `web/` board frontend. Its build-time
#     devDependencies (Vue/Vite/Tailwind/daisyUI) are pinned by the committed
#     `web/package-lock.json`, and their tarballs are vendored in the npm cache committed
#     at `web/.vendor/npm-cache`. The guard below therefore installs the frontend OFFLINE
#     (`npm ci --offline`). Nothing from this stage ships except the static `web/dist`.
#
# Boundary (F1-c, ruling O1, 2026-10-09): the image builds with NO NETWORK. Runtime and
# every verification step are offline, and — because the cache is committed — so is the
# frontend build stage: `npm ci --offline` never reaches the registry, so `docker build
# --network=none` succeeds. The cache is a GENERATED artefact, produced inside a container
# by the vendoring step in `docs/agents/docker.md`: re-run it after any `web/package.json`
# dependency bump, and commit the refreshed cache with the lockfile.
#
# It must cover **both** linux architectures. The cache holds platform-specific optional
# binaries (`@rolldown/binding-*`, `@tailwindcss/oxide-*`, `lightningcss-*`), and it is
# built inside whichever container runs the vendoring step — so a single-arch cache builds
# on one architecture only. That is a live difference, not a hypothetical one: CI's
# `docker` job runs on `ubuntu-latest` (x86_64) while a developer on Apple Silicon builds
# linux/arm64. And the shortfall is quiet — `npm ci --offline` **succeeds** on the
# uncovered architecture, because those binaries are `optionalDependencies` — so it
# surfaces one step later, in `vite build`, as "Cannot find native binding" (rolldown
# falls back to `@rolldown/binding-wasm32-wasi`, which a single-arch cache does not hold
# either). `test/docker.test.mjs` asserts the cache covers both, from the cacache index.
#
# Nothing is installed with apt — no apt mirror is reachable at build time, which is the
# point (Terry, 2026-10-08: local verification runs isolated in a container, never on the
# host).
#
# Build:  docker build -f docker/Dockerfile -t meerkat-taskpanel:verify .
# Verify: docker run --rm meerkat-taskpanel:verify bash docker/verify-in-container.sh
#
# Base image: `verify:docker` preflights
# `node:22-bookworm-slim` against the LOCAL image store and pass the builder's no-pull
# flag (`--pull=false` on the legacy builder, `--pull=never` on BuildKit), so a routine
# verification never re-downloads it. A manual `docker build` keeps Docker's default
# (`missing`): it uses the cached image and pulls only when it is genuinely absent.

# ── Stage 1: web build (build-time devDependencies only) ──────────────────────────────
#
# Three-way guard over what this stage does:
#   1. `web/package.json` AND `web/.vendor/npm-cache` present — build OFFLINE from the
#      committed cache (`npm ci --offline`); `--offline` hard-fails rather than silently
#      reaching the network. This is the path a clean checkout always takes (F1-c).
#   2. `web/package.json` present, cache absent — a networked `npm ci`, pinned by the
#      committed `web/package-lock.json`. This branch only runs in a stripped checkout
#      that deleted `web/.vendor/npm-cache`; it is NOT the committed configuration.
#   3. `web/package.json` absent — skip and leave `web/dist` empty.
# `mkdir -p /app/web/dist` always runs so the runtime stage's
# `COPY --from=webbuild /app/web/dist` always has a source. An empty `web/dist` is
# equivalent to none at all: `createStaticHost` probes for `index.html` and reports
# `available: false`, so the server 404s exactly as before.
#
# Caveat (known, not this stage's to fix): this guard only controls what *this* stage
# emits. The runtime stage also runs `COPY . .`, and a directory COPY merges rather than
# replaces — so if the build context already carries a locally-built `web/dist`, those files
# land in the image no matter which branch runs here. `web/dist/` is gitignored, so a clean
# checkout and CI are unaffected, but a developer machine that ran the frontend build is.
# Excluding `web/dist` in .dockerignore is the one-line fix if that non-determinism ever
# matters.
FROM node:22-bookworm-slim AS webbuild

WORKDIR /app

# Only the frontend tree first, so the install and build layers below are keyed on
# `web/` — a commit outside it reuses them. A directory COPY (rather than listing
# web/package.json and the cache separately) keeps all three guard branches
# evaluable: an absent file is seen by the RUN below, not by a COPY that hard-fails.
COPY web ./web

RUN if [ -f web/package.json ] && [ -d web/.vendor/npm-cache ]; then \
      echo "webbuild: installing web/ offline from the committed npm cache (no network)"; \
      npm ci --offline --cache /app/web/.vendor/npm-cache --prefix /app/web; \
    elif [ -f web/package.json ]; then \
      echo "webbuild: no committed cache found — falling back to a networked npm ci (pinned by web/package-lock.json)"; \
      npm ci --prefix /app/web; \
    else \
      echo "webbuild: web/package.json absent — skipping the frontend install (web/dist stays empty)"; \
    fi

# The build only needs `web/`, which is already here, so it runs *before* the
# repository-wide copy below. A change outside `web/` therefore still reuses this
# layer.
RUN if [ -f web/package.json ]; then \
      npm --prefix /app/web run build; \
    else \
      echo "webbuild: web/package.json absent — skipping the frontend build (web/dist stays empty)"; \
    fi \
 && mkdir -p /app/web/dist

# The rest of the repository. The runtime stage copies it again for its own image;
# here it is what lets `FROM webbuild AS dev` inherit the sources it serves.
COPY . .

# ── Stage 1b: dev (manual preview; NOT the default target) ───────────────────────────
#
# The shipping image is the runtime stage and installs nothing at run time. This
# sibling reuses `webbuild` — it already holds the committed-cache `npm ci`
# result and the frontend source — and starts taskd + Vite's dev server through
# `docker/dev-entry.mjs`. It is deliberately placed before the runtime stage so
# the runtime stays the final/default target: a plain `docker build` still
# produces the shipping image, and only `--target dev` (or the dev compose file)
# builds this one.
#
# Source is bind-mounted by `docker/docker-compose.dev.yml` for HMR; the image's
# `web/node_modules` stays in place behind an anonymous volume.
FROM webbuild AS dev

ENV TASKD_HOST=127.0.0.1
ENV TASKD_PORT=9527
ENV TASKD_DATA_DIR=/app/.data
# Vite watches bind-mounted sources through polling on Docker Desktop/macOS.
ENV VITE_USE_POLLING=1

RUN mkdir -p /app/.data && chown -R node:node /app

USER node

EXPOSE 5173

CMD ["node","docker/dev-entry.mjs"]

# ── Stage 2: runtime (the shipped image) ──────────────────────────────────────────────
FROM node:22-bookworm-slim

# Node ships the ICU tz database, so TZ takes effect without installing tzdata.
ENV TZ=Asia/Shanghai
ENV TASKD_HOST=0.0.0.0
ENV TASKD_PORT=9527

WORKDIR /app

# The build context is trimmed by the repository-root .dockerignore (no .git,
# no design/, no node_modules).
COPY . .

# The built frontend is the only thing the webbuild stage contributes: no devDependencies
# and no `node_modules` ever enter this image. `taskd` serves this directory as the hosted
# root (`STATIC_DIR_REL = "web/dist"`) and falls back to `index.html` for SPA routes.
COPY --from=webbuild /app/web/dist /app/web/dist

# Run as the unprivileged `node` user that the base image already provides. The board's
# runtime state lives in /app/.data (bind-mounted by docker-compose.yml), so it must be
# writable by that user.
RUN mkdir -p /app/.data && chown -R node:node /app

USER node

EXPOSE 9527

# Default to the CLI so `docker run <image>` is a useful smoke test.
CMD ["node","src/cli/index.mjs","--help"]
