# Development

## Requirements

- **Node >= 22** — the project targets the `node:sqlite` era and uses modern ESM.
- **No dependencies.** Everything in the project uses Node builtins only
  (`node:fs`, `node:path`, `node:test`, `node:child_process`, …).

> **Do not run `npm install`.** The project needs no packages, no lockfile and no
> network access. A `node_modules/` directory is gitignored and is not expected to exist.

## Layout

| Path | Responsibility |
|---|---|
| `src/core/` | Domain model, SQLite repository, state machine, invariants (M1) |
| `src/cli/` | `taskctl` — the CLI entry point |
| `src/mcp/` | Stdio MCP server (M3) |
| `src/server/` | Local HTTP API + SSE for the board (M6) |
| `src/shared/` | Shared DTOs, constants, small pure helpers |
| `web/` | React + Vite board frontend → `dist/web` |
| `skills/task-panel/` | The skill — **single source of truth** |
| `plugins/<host>/` | Per-host manifests + generated `skills/` copies |
| `scripts/` | Build, install, sync and verify scripts |
| `test/` | Smoke / contract tests |
| `design/` | Product design artifacts (PRD, DESIGN, BLOCKS, prototype, assets) |
| `docs/` | Usage and development documentation |

Dependency direction: `core`, `cli`, `mcp` and `server` may import from `shared`;
nothing imports from `cli`, `mcp` or `server`; `shared` imports nothing from `src/`.

## Commands

```bash
node --test                          # smoke / contract test suite
node scripts/sync-skills.mjs         # skills/ → plugins/<host>/skills (regenerate)
node scripts/sync-skills.mjs --check # verify the generated copies are in sync
node scripts/verify/manifests.mjs    # validate the host + marketplace manifests
node scripts/verify/skill.mjs        # validate SKILL.md frontmatter
node scripts/build.mjs               # produce dist/ (web placeholder + host plugins)
```

Or via npm aliases:

```bash
npm test          # node --test
npm run check:skills
npm run verify
npm run build
npm run check     # check:skills + verify + test
```

## The `taskd` HTTP surface (M6)

`src/server/` is the local service every other surface talks to. Start it with
`node src/server/main.mjs`; `taskctl` starts it on demand.

| Route (`/api/v1` unless noted) | Methods | Notes |
|---|---|---|
| `/health`, `/meta` | GET | liveness + version/capabilities; `/health` is unauthenticated |
| `/projects`, `/projects/:id`, `/projects/current`, `/projects/:id/readme` | GET/POST/PATCH/PUT | `/projects` is ordered server-side (§4.6) |
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

The access token is never echoed in a response and never logged. The SSE stream
filters `task_heartbeat` out of the increments, because a pulse changes no board
state (§4.3); the row still exists in `task_activities` and under
`/tasks/:ref/activities`.

## The skill is generated, never hand-edited

`skills/task-panel/` is the only place the skill is authored. `scripts/sync-skills.mjs`
copies it into `plugins/claude/skills/`, `plugins/codex/skills/`, `plugins/openclaw/skills/`
and `plugins/pi/skills/`. Those copies are generated artifacts and are committed so that
each host directory is self-contained — but they must always match the source.

**After editing anything under `skills/`, run:**

```bash
node scripts/sync-skills.mjs
```

CI runs `node scripts/sync-skills.mjs --check` and fails if a generated copy has drifted.
The same reasoning applies to `dist/`: build output is never edited by hand and is
gitignored.

## Build output

`node scripts/build.mjs` deletes and recreates `dist/`, writes a `dist/web/.gitkeep`
placeholder, and syncs the skill into `dist/plugins/<host>/`. `dist/` is gitignored.

## Constraints

- **No network.** Scripts, tests and the CLI must work fully offline.
- **No dependencies.** Prefer Node builtins; adding a package requires a deliberate
  decision and an update to this document.
- **Shell scripts** are POSIX `bash` with `set -eu`. Check them with
  `bash -n install.sh scripts/install/*.sh`.
