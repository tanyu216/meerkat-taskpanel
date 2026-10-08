# Installation

Task Panel ships as an **Agent Skill** plus per-host plugin manifests. Installation
copies (or symlinks) the skill from `skills/task-panel/` — the single source of truth —
into each host's skill directory.

> **Status: core (M1) and CLI (M2) have landed.** Installation works today and the skill is
> discoverable, and the `taskctl` commands it describes are implemented. The board frontend,
> the full MCP server and the full HTTP/SSE backend are still planned — see `CLAUDE.md` /
> `docs/development.md`.

## Quick start

```bash
bash install.sh --target all
```

This installs into every supported host. Pick one host instead with
`--target claude`, `--target openclaw`, `--target codex` or `--target pi`.

## Where things land

| Host | `--target` value | Destination |
|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/task-panel` |
| OpenClaw | `openclaw` | `~/.openclaw/skills/task-panel` |
| Codex | `codex` | `~/.codex/skills/task-panel` |
| Pi / Agent Skills | `pi` | `~/.agents/skills/task-panel` |

## Usage

```text
install.sh [--target claude|openclaw|codex|pi|all] [--prefix <home>]
           [--link] [--force] [--dry-run] [-h|--help]
```

| Flag | Effect |
|---|---|
| `--target <host>` | Which host to install for. Default `all`. |
| `--prefix <home>` | Install relative to `<home>` instead of `$HOME`. |
| `--link` | Symlink the skill instead of copying it — edits to the repo take effect immediately. |
| `--force` | Overwrite an existing installation. Without it, an existing destination is an error. |
| `--dry-run` | Print the destination paths and change nothing. |
| `-h`, `--help` | Show usage. |

### Examples

Preview what would happen:

```bash
bash install.sh --target all --dry-run
```

Development install — symlink so the repo stays authoritative:

```bash
bash install.sh --target claude --link --force
```

Install into an isolated home (useful for testing):

```bash
bash install.sh --target all --prefix /tmp/taskpanel-home
```

## How it works

`install.sh` is a thin dispatcher. It parses the flags once, then runs
`scripts/install/<host>.sh` for each requested host, forwarding the options through
environment variables:

| Variable | Meaning |
|---|---|
| `TASKPANEL_TARGET_HOME` | Base home directory (default `$HOME`) |
| `TASKPANEL_LINK` | Symlink instead of copy |
| `TASKPANEL_FORCE` | Overwrite an existing destination |
| `TASKPANEL_DRY_RUN` | Print only, change nothing |

All four host installers share one implementation, `scripts/install/_common.sh`, so the
behaviour above is identical everywhere. You can invoke a host script directly if you
prefer:

```bash
bash scripts/install/codex.sh
```

## Uninstalling

Installation only writes to the destination paths listed above; nothing else is touched.
Remove the install with:

```bash
rm -rf ~/.claude/skills/task-panel
```

Nothing is written outside those directories, and nothing is sent over the network — see
[PRIVACY.md](../PRIVACY.md).
