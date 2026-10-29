# 0002 — The stack: Node 22 with `node:sqlite`, zero runtime dependencies, the board built offline

## Status

Accepted (reconstructed) — 2026-10-30 (E5).

Read back from the tree at `999a5a8c` and accepted on that basis; the provenance stays so a
later reader can tell a derived decision from one taken in a decision round.

## Context

The product is a local-first board for agent teams: it must run on a developer's or an agent's
machine with no services, no network and no install step that can fail. It also ships a browser
board, which needs a real frontend toolchain. Those two requirements pull in opposite directions,
so the stack is recorded as one bundle rather than a row-by-row choice.

The authoritative table is [`docs/tech-spec.md`](../tech-spec.md) § Tech stack; this ADR records
why it looks the way it does and what was rejected.

## Decision

| Layer | Choice | Forcing function |
|---|---|---|
| Backend | Node **>= 22**, ESM, **zero runtime dependencies**, npm | `node:sqlite` first shipped in the 22 line; no dependency means no audit surface, no lockfile, no network at runtime |
| Persistence | `node:sqlite`, one database file, append-only SQL migrations | no driver, no ORM, one writer per data directory |
| Frontend | Vue 3.5 + Vite 8 + Tailwind 4 + daisyUI 5, **build-time only** | a real component model for a board with many interactive surfaces; only `web/dist` crosses into the runtime image |
| Container | `node:22-bookworm-slim`, multi-stage (`webbuild` → runtime), non-root `node` | the image must build with no network, so the frontend's dependencies come from a committed offline cache |
| Contracts | code-first snapshots (`api.snapshot.json`, `cli.snapshot.json`), no OpenAPI | the handlers are the surface; a generated document would be a second description that drifts |

The image installs nothing at runtime: the `webbuild` stage runs `npm ci --offline` against
`web/.vendor/npm-cache`, and the runtime stage carries only `web/dist`. A dependency bump
re-vendors that cache and commits it with `web/package-lock.json`.

## Considered options

| Option | Why rejected |
|---|---|
| Express/Fastify + `better-sqlite3` | two native/third-party dependencies for a single-process local board; both add install and audit surface, and neither buys a capability the built-ins lack |
| A hosted Postgres + a server framework | contradicts local-first: an external service to run, back up and secure |
| Next.js / SSR frontend | the board is served statically by the same process that serves the API; SSR adds a second runtime and a build we do not need |
| Electron or a desktop shell | the board is one page; a browser tab is the deployment target, and the container path already proves the build |
| TypeScript + a bundler for the engine | the engine has no build step today; a transpile step would add a toolchain to the part that must keep working offline |

## Consequences

- The engine cannot lean on a library for a hard problem: the parsing, the HTTP router, the
  migration runner and the logger are all local code with tests. That is the cost of the zero-dependency
  guarantee and it is paid deliberately.
- Lint, format and type-check are **absent** by the same decision — there is no compiler and no
  toolchain to configure. The static gate is `scripts/verify/*` plus `node --check`; adding a
  toolchain is a new decision, not a cleanup.
- The frontend's offline cache is a **generated artefact** (linux/arm64) and part of the
  repository; it is refreshed with the lockfile, never by hand.
- Revisit if a runtime dependency is proposed (record the licence and the offline guarantee), or
  if the engine gains a build step.
