# Task Panel — containerized verification / deploy image.
#
# There are two build layers, and keeping them apart is the whole point of the stages:
#
#   * runtime (the final stage) — Node 22 plus the repository itself. The engine
#     (`src/core`, `src/cli`, `src/server`, `src/mcp`) has ZERO runtime dependencies:
#     nothing is installed, nothing is fetched, so this stage builds offline and
#     reproduces exactly on any machine.
#   * webbuild (the first stage) — the `web/` board frontend, in one of two modes:
#       - offline build: when BOTH `web/package.json` and the vendored cache
#         (`web/.vendor/npm-cache`) are present, Vue 3 / Vite / Tailwind/daisyUI are
#         installed from that cache alone (`npm ci --offline`) and `web/dist` is built.
#       - skipped: when either is absent (the vendored cache is not committed), the
#         frontend build is skipped with a one-line note and this stage emits an empty
#         `web/dist` (see the caveat on the stage below) — a no-op for the static host,
#         which probes for `index.html` and reports `available: false`.
#     Either way nothing from this stage ships except `web/dist`; devDependencies and
#     `node_modules` never cross into the runtime stage, and no network is ever reached.
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

# The guard tests the thing the build actually needs, not just the manifest: the frontend
# workspace (`web/package.json`, `web/package-lock.json`) has landed with M6b stage S2, but
# the vendored offline cache (`web/.vendor/npm-cache/`) is not committed while the
# offline-assembly decision is still open. Guarding on the manifest alone made an absent
# cache fatal (`npm ci --offline` fails, and rightly so — it is the gate against a silent
# network fetch). Guarding on manifest AND cache instead keeps both modes honest: a
# complete checkout builds `web/dist` offline, an incomplete one skips with a note.
#
# The skip path still emits `/app/web/dist` because the runtime stage's
# `COPY --from=webbuild /app/web/dist` needs a source. An empty `web/dist` is equivalent to
# no `web/dist`: `createStaticHost` probes for `index.html` and reports `available: false`,
# so the server 404s exactly as before. Note this guard is a directory-existence test, not
# a completeness test: when the cache IS present but stale, `npm ci --offline` still fails
# the build loudly — that remains the intended gate. If a later stage adopts root
# `package.json` `workspaces: ["web"]`, these two commands are the line to revisit.
#
# Caveat (known, not this stage's to fix): this guard only controls what *this* stage emits.
# The runtime stage also runs `COPY . .`, and a directory COPY merges rather than replaces —
# so if the build context already carries a locally-built `web/dist`, those files land in
# the image no matter which branch runs here. `web/dist/` is gitignored, so a clean checkout
# and CI are unaffected, but a developer machine that ran the frontend build is. Excluding
# `web/dist` in .dockerignore is the one-line fix if that non-determinism ever matters.
RUN if [ -f web/package.json ] && [ -d web/.vendor/npm-cache ]; then \
      echo "webbuild: building web/ offline from the vendored npm cache"; \
      npm ci --offline --cache /app/web/.vendor/npm-cache --prefix /app/web \
      && npm --prefix /app/web run build; \
    else \
      echo "webbuild: web/package.json or web/.vendor/npm-cache absent — skipping the frontend build (web/dist stays empty)"; \
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
