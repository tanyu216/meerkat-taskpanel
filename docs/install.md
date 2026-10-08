# Installation

Task Panel ships as an **Agent Skill** (`skills/task-panel/`) plus one distribution
bundle per host (`plugins/`). There are two independent layers, and it is worth keeping
them straight:

1. **The skill** — `SKILL.md` + `references/` + a wrapper, copied (or symlinked) into the
   host's skill directory by `install.sh`. This is deterministic, offline, and needs no
   host tooling. It is what makes the agent able to drive `taskctl`.
2. **The plugin/bundle** — the per-host manifest under `plugins/<host>/` that lets the
   host's own plugin system discover and enable the skill. This step needs the host CLI,
   so `install.sh` does **not** run it; it prints the command and you run it once.

> **Status: core (M1), CLI (M2) and the MCP server (M3) have landed.** The skill is
> discoverable and the `taskctl` commands it describes are implemented. The board
> frontend and the full HTTP/SSE backend are still planned — see `CLAUDE.md`.

## Quick start

```bash
bash install.sh --target all             # copy the skill into every host
bash install.sh --target claude --link   # or one host, symlinked from this checkout
```

Then register the plugin/bundle for the hosts you use (one command each — see
[Per-host steps](#per-host-steps)).

## Where things land

| Host | `--target` | Skill destination | Bundle |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/task-panel` | `plugins/claude` (`.claude-plugin/plugin.json`) |
| OpenClaw | `openclaw` | `~/.openclaw/skills/task-panel` | `plugins/openclaw` (native `openclaw.plugin.json`) |
| Codex | `codex` | `~/.codex/skills/task-panel` | `plugins/codex` (`.codex-plugin/plugin.json`) |
| Pi / Agent Skills | `pi` | `~/.agents/skills/task-panel` | `plugins/pi` (`package.json`) |

The repository-root Claude marketplace `.claude-plugin/marketplace.json` points at
`./plugins/claude`; Codex reads the same marketplace manifest.

## install.sh reference

```text
install.sh [--target claude|openclaw|codex|pi|all] [--prefix <home>]
           [--link] [--force] [--dry-run] [-h|--help]
```

| Flag | Effect |
|---|---|
| `--target <host>` | Which host(s) to install for. Default `all`. Repeatable, and a comma-separated list (`--target claude,codex`) works too. |
| `--prefix <home>` | Install relative to `<home>` instead of `$HOME`. |
| `--link` | Symlink the skill instead of copying it — edits to the repo take effect immediately. Recommended for a checkout. |
| `--force` | Overwrite an existing installation. Without it, an existing destination is an error (so a re-run never silently clobbers local edits). |
| `--dry-run` | Print the destination paths and change nothing. |

`install.sh` is a thin dispatcher: it parses the flags once, then runs
`scripts/install/<host>.sh` for each host and prints a per-host summary. It exits
non-zero if any host failed, and each failure names the destination and the fix.

### Examples

```bash
bash install.sh --target all --dry-run                 # preview
bash install.sh --target claude --link --force         # development install
bash install.sh --target all --prefix /tmp/tp-home     # isolated home (testing)
```

## Per-host steps

### Claude Code

```bash
# 1. skill
bash install.sh --target claude --link --force

# 2. plugin (registers the marketplace, then installs the plugin)
claude plugin marketplace add "$PWD"
claude plugin install task-panel@task-panel-marketplace -y

# verify
claude plugin list                  # → task-panel@task-panel-marketplace, enabled
claude plugin validate "$PWD"       # validates the plugin + marketplace manifests
```

Uninstall:

```bash
claude plugin uninstall task-panel@task-panel-marketplace
claude plugin marketplace remove task-panel-marketplace
rm -rf ~/.claude/skills/task-panel
```

### OpenClaw

```bash
# 1. skill
bash install.sh --target openclaw --link --force

# 2. bundle — OpenClaw consumes the Claude-format bundle
openclaw plugins install "$PWD/plugins/claude" --force --accept-capabilities

# verify
openclaw plugins inspect task-panel
```

`openclaw plugins inspect task-panel` reports the bundle mapping:

```text
Format: bundle
Bundle format: claude
Bundle capabilities: skills
```

> **Native vs bundle.** `plugins/openclaw/openclaw.plugin.json` is a *native* OpenClaw
> manifest. A native plugin is an in-process runtime module and must ship
> `package.json#openclaw.extensions` plus an entry point that imports the OpenClaw plugin
> SDK — a real dependency this zero-dependency project deliberately does not take. A
> **skill-only** pack therefore installs through the supported bundle route above (or,
> equivalently, by placing the skill in `~/.openclaw/skills/`). OpenClaw's detector still
> classifies `plugins/openclaw` as a native plugin, which is why its profile asserts that
> and the bundle assertions run against `plugins/claude`.

Uninstall:

```bash
openclaw plugins uninstall task-panel
rm -rf ~/.openclaw/skills/task-panel
```

### Codex

```bash
# 1. skill
bash install.sh --target codex --link --force

# 2. plugin
codex plugin marketplace add "$PWD"
codex plugin add task-panel@task-panel-marketplace

# verify
codex plugin list
```

Uninstall:

```bash
codex plugin remove task-panel
codex plugin marketplace remove task-panel-marketplace
rm -rf ~/.codex/skills/task-panel
```

### Pi / Agent Skills

```bash
# 1. skill
bash install.sh --target pi --link --force

# 2. package
pi install "$PWD/plugins/pi"

# verify
pi list
```

Uninstall:

```bash
pi remove "$PWD/plugins/pi"
rm -rf ~/.agents/skills/task-panel
```

## MCP (optional)

The skill drives the `taskctl` CLI and needs no MCP server. If you prefer the boolean
tool interface, M3 ships a stdio MCP server as the `taskpanel-mcp` bin
(`src/mcp/main.mjs`), a thin proxy to the same local `taskd`. Point the host at it:

```bash
# Claude Code (stdio)
claude mcp add taskpanel -- node "$PWD/src/mcp/main.mjs"

# Codex
codex mcp add taskpanel -- node "$PWD/src/mcp/main.mjs"
```

For OpenClaw/Pi, add the same command to that host's MCP configuration. MCP is strictly
additive — a host that cannot register MCP is fully functional through the skill.

## Verifying the install

**Everything that runs is verified inside the container** (see
[`docker.md`](docker.md) and ARCHITECTURE §9.1): the four host CLIs are not installed in
the image and there is no network, so the container asserts each host's *detection
contract* offline instead.

```bash
npm run verify:docker                     # the full container suite, all four hosts
```

That run includes `scripts/verify/profiles.mjs`, which for each host installs into a
throwaway home and asserts: the skill lands at the host's destination, `SKILL.md`
frontmatter still names `task-panel`, the wrapper resolves back to this checkout, the
host manifest parses, and the bundle is recognized with a loadable skill. Run one host
on its own with:

```bash
node scripts/verify/profiles.mjs --host openclaw
```

### Supplementary: the real host CLIs

When the host CLIs *are* present (a developer host, never CI), the same four steps are
driven for real, each in a throwaway `HOME`, touching no network:

```bash
node scripts/verify/host-cli.mjs            # all hosts; absent CLIs are SKIPPED
node scripts/verify/host-cli.mjs --host openclaw
```

This is a cross-check that the offline detection rules match what the real CLI does — it
is supplementary, not the acceptance evidence.

## Isolated installs and testing

Nothing is ever written outside the destination paths in the table above. To install
without touching a real host home — for a test, or a CI assert — use a throwaway home:

```bash
bash install.sh --target all --prefix /tmp/tp-home
TASKPANEL_TARGET_HOME=/tmp/tp-home bash scripts/install/claude.sh   # env equivalent
```

The host CLIs honour their own config-directory variables, so a fully isolated plugin
install is possible too:

```bash
HOME=/tmp/tp-home CLAUDE_CONFIG_DIR=/tmp/tp-home/.claude claude plugin marketplace add "$PWD"
HOME=/tmp/tp-home CODEX_HOME=/tmp/tp-home/.codex codex plugin marketplace add "$PWD"
```

## Uninstalling

Each host's section above lists the plugin/bundle removal command. The skill itself is
removed by deleting its destination:

```bash
rm -rf ~/.claude/skills/task-panel      # claude
rm -rf ~/.openclaw/skills/task-panel    # openclaw
rm -rf ~/.codex/skills/task-panel       # codex
rm -rf ~/.agents/skills/task-panel      # pi
```

Nothing is written outside those directories, and nothing is sent over the network — see
[`PRIVACY.md`](../PRIVACY.md).

## Troubleshooting

- **`destination already exists`** — an install is already present. Re-run with
  `--force` to overwrite, or remove the directory first if you want to keep local edits.
- **`skill source not found`** — run `install.sh` from this checkout (it resolves
  `skills/task-panel/` relative to itself); a `dist/` bundle must be unpacked first.
- **`plugins/*/skills` out of date** — those copies are generated. Run
  `node scripts/sync-skills.mjs`; `npm run check:skills` fails CI on drift.
- **OpenClaw does not list the plugin** — install the bundle
  (`openclaw plugins install "$PWD/plugins/claude" ...`), not `plugins/openclaw`; see the
  native-vs-bundle note above.
