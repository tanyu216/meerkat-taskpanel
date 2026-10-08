# Development

## Requirements

- **Node >= 22** — the project targets the `node:sqlite` era and uses modern ESM.
- **No dependencies.** Everything in the scaffold uses Node builtins only
  (`node:fs`, `node:path`, `node:test`, `node:child_process`, …).

> **Do not run `npm install`.** The M0 scaffold needs no packages, no lockfile and no
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
| `skills/task-dashboard/` | The skill — **single source of truth** |
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

## The skill is generated, never hand-edited

`skills/task-dashboard/` is the only place the skill is authored. `scripts/sync-skills.mjs`
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
