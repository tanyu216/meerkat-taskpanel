# Task Panel — containerized verification / deploy image.
#
# Everything the project needs at runtime is Node 22 plus the repository itself: there
# are no dependencies to install, so this image builds offline and reproduces exactly
# on any machine. Nothing is installed with apt — that also means no apt mirror is
# reachable at build time, which is the point (Terry, 2026-10-08: local verification
# runs isolated in a container, never on the host).
#
# Build:  docker build -f docker/Dockerfile -t task-panel:verify .
# Verify: docker run --rm task-panel:verify bash docker/verify-in-container.sh

FROM node:22-bookworm-slim

# Node ships the ICU tz database, so TZ takes effect without installing tzdata.
ENV TZ=Asia/Shanghai
ENV TASKD_HOST=0.0.0.0
ENV TASKD_PORT=9527

WORKDIR /app

# The build context is trimmed by the repository-root .dockerignore (no .git, no
# prototype/, no design/, no node_modules).
COPY . .

# Run as the unprivileged `node` user that the base image already provides. The board's
# runtime state lives in /app/.data (bind-mounted by docker-compose.yml), so it must be
# writable by that user.
RUN mkdir -p /app/.data && chown -R node:node /app

USER node

EXPOSE 9527

# Default to the CLI so `docker run <image>` is a useful smoke test.
CMD ["node","src/cli/index.mjs","--help"]
