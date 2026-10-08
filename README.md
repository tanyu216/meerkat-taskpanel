# Task Panel

**Task management board for AI Agent teams.**

A local-first task board designed for teams of AI agents and humans: agents claim work,
heartbeat, report progress, and roll results up a dependency tree, while humans watch the
same state on a kanban board.

> **Status: M0 scaffold — core not implemented yet.**
> This repository currently contains only the engineering scaffold: directory layout, a
> thin CLI stub, host plugin manifests, skill synchronisation scripts, and a smoke/contract
> test suite. There is no domain model, no SQLite repository, no state machine, and no
> board frontend yet. See the roadmap below for what lands in which milestone.

## Repository layout

```text
task-panel/
├── README.md / README.zh-CN.md   # docs (English default, Chinese mirror)
├── LICENSE / PRIVACY.md
├── package.json                  # workspace root, bin(taskctl), scripts
├── install.sh                    # install dispatcher: --target claude|openclaw|codex|pi|all
├── .claude-plugin/               # Claude marketplace manifest
├── src/                          # engineering source
│   ├── core/                     #   domain model / SQLite repo / state machine / invariants
│   ├── cli/                      #   taskctl (CLI entry)
│   ├── mcp/                      #   MCP server (stdio)
│   ├── server/                   #   local HTTP API + SSE
│   └── shared/                   #   shared DTOs / constants
├── web/                          # board frontend (React + Vite) → dist/web
├── skills/task-panel/        # skill — single source of truth
├── plugins/                      # one dispatch unit per host (claude/codex/openclaw/pi)
├── design/                       # product design artifacts (PRD / DESIGN / BLOCKS / prototype / assets)
├── scripts/                      # build / install / sync / verify
├── test/                         # contract + smoke tests
├── docs/                         # usage and development docs
└── dist/                         # build output (gitignored)
```

## Install

```bash
bash install.sh --target claude|openclaw|codex|pi|all
```

Default target is `all`. The dispatcher forwards to `scripts/install/<host>.sh`, which
installs the skill into each host's skill directory:

| Host | Destination |
|---|---|
| `claude` | `~/.claude/skills/task-panel` |
| `openclaw` | `~/.openclaw/skills/task-panel` |
| `codex` | `~/.codex/skills/task-panel` |
| `pi` | `~/.agents/skills/task-panel` |

Useful flags: `--prefix <home>` (override the target home), `--link` (symlink instead of
copy), `--force` (overwrite an existing destination), `--dry-run` (print destinations and
change nothing).

## Development

Requires **Node >= 22** (the `node:sqlite` era). No network access and no dependencies are
needed — everything here uses Node builtins only.

```bash
node --test                          # run the smoke / contract test suite
node scripts/sync-skills.mjs         # skills/ → plugins/<host>/skills
node scripts/sync-skills.mjs --check # verify generated skill copies are in sync
node scripts/verify/manifests.mjs    # validate plugin manifests
node scripts/verify/skill.mjs        # validate SKILL.md frontmatter
node scripts/build.mjs               # produce dist/
```

Or run everything at once:

```bash
npm run check
```

## Roadmap

| Milestone | Contents |
|---|---|
| **M0** | Scaffold: layout, CLI stub, manifests, sync/verify scripts, tests *(this repo state)* |
| M1 | `src/core`: domain model, SQLite repository, state machine, invariants |
| M2 | `taskctl` command surface aligned with `task-interface v1` |
| M3 | `src/mcp`: stdio MCP server |
| M6 | `src/server` + `web`: local HTTP API, SSE, and the React board |

## License

MIT — see [LICENSE](LICENSE).
