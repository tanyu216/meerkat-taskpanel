# Task Panel — containerized verification / deploy image.
#
# There are two build layers, and keeping them apart is the whole point of the stages:
#
#   * runtime (the final stage) — Node 22 plus the repository itself. The engine
#     (`src/core`, `src/cli`, `src/server`, `src/mcp`) has ZERO runtime dependencies:
#     nothing is installed, nothing is fetched, so this stage builds offline and
#     reproduces exactly on any machine.
#   * webbuild (the first stage) — the `web/` board frontend. This is the ONE stage that
#     may reach the network. `web/package.json` and `web/package-lock.json` are committed
#     and the lockfile pins every devDependency, so `npm ci` is deterministic whether it
#     runs offline or over the network. Nothing from this stage ships except the static
#     `web/dist`.
#
# Boundary (honest): runtime and every verification step stay OFFLINE. The offline-
# assembly constraint applies to what the project *runs*, not to the image's frontend
# build stage. A strictly-offline image build would require vendoring the npm cache at
# `web/.vendor/npm-cache` (not currently committed); if that cache is present the guard
# below takes the offline path automatically. The guard documents a networked `npm ci`
# as an expected mode, so this comment names the network explicitly.
#
# Nothing is installed with apt — no apt mirror is reachable at build time, which is the
# point (Terry, 2026-10-08: local verification runs isolated in a container, never on the
# host).
#
# Build:  docker build -f docker/Dockerfile -t task-panel:verify .
# Verify: docker run --rm task-panel:verify bash docker/verify-in-container.sh

# ── Stage 1: web build (build-time devDependencies only) ──────────────────────────────
#
# Three-way guard over what this stage does:
#   1. `web/package.json` AND `web/.vendor/npm-cache` present — build OFFLINE from the
#      provided cache (`npm ci --offline`); `--offline` hard-fails rather than silently
#      reaching the network.
#   2. `web/package.json` present, no cache — a networked `npm ci`, pinned by the committed
#      `web/package-lock.json` (the default in a clean checkout).
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

# Same trimmed context as the runtime stage (repository-root .dockerignore).
COPY . .

RUN if [ -f web/package.json ] && [ -d web/.vendor/npm-cache ]; then \
      echo "webbuild: building web/ offline from the provided npm cache"; \
      npm ci --offline --cache /app/web/.vendor/npm-cache --prefix /app/web \
      && npm --prefix /app/web run build; \
    elif [ -f web/package.json ]; then \
      echo "webbuild: building web/ with a networked npm ci (pinned by web/package-lock.json)"; \
      npm ci --prefix /app/web \
      && npm --prefix /app/web run build; \
    else \
      echo "webbuild: web/package.json absent — skipping the frontend build (web/dist stays empty)"; \
    fi \
 && mkdir -p /app/web/dist

# ── Stage 2: runtime (the shipped image) ──────────────────────────────────────────────
FROM node:22-bookworm-slim

# Node ships the ICU tz database, so TZ takes effect without installing tzdata.
ENV TZ=Asia/Shanghai
ENV TASKD_HOST=0.0.0.0
ENV TASKD_PORT=9527

WORKDIR /app

# The build context is trimmed by the repository-root .dockerignore (no .git, no
# prototype/, no design/, no node_modules).
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
