# Task Panel — containerized verification / deploy image.
#
# There are two build layers, and keeping them apart is the whole point of the stages:
#
#   * runtime (the final stage) — Node 22 plus the repository itself. The engine
#     (`src/core`, `src/cli`, `src/server`, `src/mcp`) has ZERO runtime dependencies:
#     nothing is installed, nothing is fetched, so this stage builds offline and
#     reproduces exactly on any machine.
#   * webbuild (the first stage) — the `web/` board frontend. Vue 3, Vite and
#     Tailwind/daisyUI are BUILD-TIME devDependencies, resolved from the committed
#     offline npm cache (`web/.vendor/npm-cache`). They never ship: only the built
#     static tree (`web/dist`) crosses into the runtime stage.
#
# Nothing is installed with apt — no apt mirror is reachable at build time, which is the
# point (Terry, 2026-10-08: local verification runs isolated in a container, never on the
# host).
#
# Build:  docker build -f docker/Dockerfile -t task-panel:verify .
# Verify: docker run --rm task-panel:verify bash docker/verify-in-container.sh

# ── Stage 1: web build (build-time devDependencies only) ──────────────────────────────
#
# `npm ci --offline` reads *only* the committed cache and hard-fails rather than silently
# reaching the network. The machine proof of that is the build itself:
#   docker build --network=none -f docker/Dockerfile -t task-panel:verify .
FROM node:22-bookworm-slim AS webbuild

WORKDIR /app

# Same trimmed context as the runtime stage (repository-root .dockerignore).
COPY . .

# `web/` is still a README placeholder: the frontend workspace (`web/package.json`,
# `web/package-lock.json`, `web/.vendor/npm-cache/`) lands with M6b stage S1. Until then
# the guard makes this stage a no-op that still emits an empty `/app/web/dist`, so the
# image keeps building and the runtime contract (`STATIC_DIR_REL = "web/dist"`) is already
# in place. An empty `web/dist` is equivalent to no `web/dist`: `createStaticHost` probes
# for `index.html` and reports `available: false`, so the server still 404s exactly as
# before. Once `web/package.json` exists, a missing lockfile or an incomplete cache fails
# the build loudly — that is the intended gate. If S1 adopts root `package.json`
# `workspaces: ["web"]`, these two commands are the line to revisit.
RUN if [ -f web/package.json ]; then \
      echo "webbuild: assembling web/ from the vendored offline cache"; \
      npm ci --offline --cache /app/web/.vendor/npm-cache --prefix /app/web \
      && npm --prefix /app/web run build; \
    else \
      echo "webbuild: web/package.json absent (frontend workspace lands with M6b S1) — skipping"; \
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
