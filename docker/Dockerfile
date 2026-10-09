# Task Panel — containerized verification / deploy image.
#
# There are two build layers, and keeping them apart is the whole point of the stages:
#
#   * runtime (the final stage) — Node 22 plus the repository itself. The engine
#     (`src/core`, `src/cli`, `src/server`, `src/mcp`) has ZERO runtime dependencies:
#     nothing is installed, nothing is fetched, so this stage builds offline and
#     reproduces exactly on any machine.
#   * webbuild (the first stage) — the `web/` board frontend, installed with a plain
#     `npm ci` from the committed `web/package.json` + `web/package-lock.json` (F1-g) and
#     built with Vite. **This is the one and only place the image build needs network:**
#     `npm ci` restores exactly the locked dependency tree, so the build is reproducible
#     from the lockfile alone. Nothing from this stage ships except `web/dist`;
#     devDependencies and `node_modules` never cross into the runtime stage. When
#     `web/package.json` is absent (no frontend workspace in this checkout) the frontend
#     build is skipped with a one-line note and this stage emits an empty `web/dist` (see
#     the caveat on the stage below) — a no-op for the static host, which probes for
#     `index.html` and reports `available: false`.
#
# Network boundary (F1-g): the webbuild stage above may reach the network. The runtime
# image and every verification step run by `docker/verify-in-container.sh` (the test suite,
# `npm run check`, the host skill installs) stay fully offline. Reproducibility of the
# frontend build is guaranteed by the committed lockfile, not by a vendored cache; a
# strict-offline image build (no network even in the webbuild stage) would require
# vendoring the npm cache — the rejected F1-c option.
#
# Nothing is installed with apt — no apt mirror is reachable at build time, which is the
# point (Terry, 2026-10-08: local verification runs isolated in a container, never on the
# host).
#
# Build:  docker build -f docker/Dockerfile -t task-panel:verify .
# Verify: docker run --rm task-panel:verify bash docker/verify-in-container.sh

# ── Stage 1: web build (build-time devDependencies only; needs network) ────────────────
#
# Plain `npm ci` against the committed lockfile (`web/package-lock.json`): it restores the
# exact pinned tree, so the build reproduces from the lockfile alone. This is the ONLY step
# in the whole image that needs the network — the runtime stage and everything
# `docker/verify-in-container.sh` runs stay offline. (If a strict-offline image build is
# ever required, revert this to `npm ci --offline --cache /app/web/.vendor/npm-cache` with a
# committed `web/.vendor/npm-cache` — the rejected F1-c option.)
FROM node:22-bookworm-slim AS webbuild

WORKDIR /app

# Same trimmed context as the runtime stage (repository-root .dockerignore).
COPY . .

# The frontend workspace (`web/package.json` + `web/package-lock.json`) is committed, so
# the manifest alone is the guard: when it is absent there is nothing to build and the
# stage skips with a note.
#
# The skip path still emits `/app/web/dist` because the runtime stage's
# `COPY --from=webbuild /app/web/dist` needs a source. An empty `web/dist` is equivalent to
# no `web/dist`: `createStaticHost` probes for `index.html` and reports `available: false`,
# so the server 404s exactly as before. `npm ci` itself fails the build loudly if the
# lockfile and manifest disagree — that remains the intended gate. If a later stage adopts
# root `package.json` `workspaces: ["web"]`, the install command is the line to revisit.
#
# Caveat (known, not this stage's to fix): this guard only controls what *this* stage emits.
# The runtime stage also runs `COPY . .`, and a directory COPY merges rather than replaces —
# so if the build context already carries a locally-built `web/dist`, those files land in
# the image no matter which branch runs here. `web/dist/` is gitignored, so a clean checkout
# and CI are unaffected, but a developer machine that ran the frontend build is. Excluding
# `web/dist` in .dockerignore is the one-line fix if that non-determinism ever matters.
RUN if [ -f web/package.json ]; then \
      echo "webbuild: building web/ from the committed lockfile (needs network)"; \
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
