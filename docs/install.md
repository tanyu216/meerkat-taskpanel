# Installation

Task Panel ships as an **Agent Skill** (`skills/task-panel/`) plus one distribution
bundle per host (`plugins/`). There are three layers, and it is worth keeping them
straight:

1. **The skill** — `SKILL.md` + `references/` + a wrapper, copied (or symlinked) into the
   host's skill directory by `install.sh`. This is deterministic, offline, and needs no
   host tooling. It is what makes the agent able to drive `taskctl`.
2. **The host bundle** (Claude Code and Codex) — `install.sh --target claude|codex`
   deploys the rest of the host's setup too, not just the skill: MCP registration, the
   host config (`~/.claude/settings.json` / `~/.codex/AGENTS.md`), slash commands (Claude)
   or a claim trigger (Codex), and a `taskctl` shim that pins the agent identity. Writes
   are **merge-style and idempotent**: a repeat install **exits 0**, leaves every managed
   file and config key at its existing value, and prints a
   `left unchanged — use --force to overwrite` notice; `--force` is the *only* way to
   overwrite. See [Idempotence](#idempotence-re-running-and-force).
3. **The plugin/bundle** — the per-host manifest under `plugins/<host>/` that lets the
   host's own plugin system discover and enable the skill. This step needs the host CLI,
   so `install.sh` does **not** run it; it prints the command and you run it once.

> **Status: the engine has landed through M6.** The skill is discoverable, the `taskctl`
> commands it describes are implemented, and the board backend (`src/server/`, HTTP + SSE)
> plus the `web/` frontend are in place. See `CLAUDE.md` for what is still planned (the
> Epic view and iteration management).

## Quick start

```bash
bash install.sh --target all --agent-name "$USER"   # skill everywhere; full bundle for claude+codex
bash install.sh --target claude --link --agent-name alice  # or one host, symlinked, named alice
```

Then register the plugin/bundle for the hosts you use (one command each — see
[Per-host steps](#per-host-steps)). `--agent-name` names the agent on the board and must
match the assignee the board uses for it; it defaults to `$USER`.

## Where things land

| Host | `--target` | Skill destination | Bundle |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/task-panel` | `plugins/claude` (`.claude-plugin/plugin.json`) |
| OpenClaw | `openclaw` | `~/.openclaw/skills/task-panel` | `plugins/openclaw` (native `openclaw.plugin.json`) |
| Codex | `codex` | `~/.codex/skills/task-panel` | `plugins/codex` (`.codex-plugin/plugin.json`) |
| Pi / Agent Skills | `pi` | `~/.agents/skills/task-panel` | `plugins/pi` (`package.json`) |

The repository-root Claude marketplace `.claude-plugin/marketplace.json` points at
`./plugins/claude`; Codex reads the same marketplace manifest.

The two bundle hosts write more than the skill. **Claude** additionally writes
`~/.claude/settings.json` (merged `env.TASKCTL_AGENT` + a `SessionStart` hook),
`~/.claude/hooks/task-panel-session-start.sh`, `~/.claude/commands/{board,claim,deliver}.md`
and `~/.claude/bin/taskctl`; it also runs `claude mcp add …` when the CLI is on `PATH`.
**Codex** writes `~/.codex/AGENTS.md` (a claim-first snippet), `~/.codex/task-panel-claim.sh`
(the schedulable trigger) and `~/.codex/bin/taskctl`, and runs `codex mcp add …`. Both
shims inject `--agent <name>` on every call, with `TASKCTL_AGENT` as the fallback.

### Scheduling units (claude, codex, pi)

Claude Code, Codex and Pi have **no timers**, so the poll/patrol loop lives outside
them: `install.sh` drops a set of scheduling units, a per-host wake-glue script, and
a host config, then **prints the load command** — it never runs `launchctl`,
`systemctl` or `crontab` for you. The design is in
[`scheduling.md`](scheduling.md); the wake scripts run workers headlessly, so
they obey the no-default-permission-bypass boundary in
[`scheduling.md §Headless permission boundary`](scheduling.md#headless-permission-boundary).

| Artefact | Where | What |
|---|---|---|
| launchd | `<host>/scheduling/launchd/com.taskpanel.{poll,patrol}.plist` | `StartInterval` 60 / 300 |
| systemd | `<host>/scheduling/systemd/taskpanel-{poll,patrol}.{service,timer}` | 60s / 300s timers |
| cron | `<host>/scheduling/cron/taskpanel.cron` | `* * * * *` poll, `*/5 * * * *` patrol |
| wake glue | `<host>/bin/wake-<host>.sh` | `claude -p` (+`--resume`), `codex exec`, `pi run` |
| host config | `<host>/task-panel.env` | `TASKPANEL_CLAIM_UNASSIGNED=yes\|no` |
| log (runtime) | `<host>/task-panel/supervisor.log` | the supervisor's tick log |
| state (runtime) | `<host>/task-panel/supervisor.state.json` | the running registry |

`<host>` is `~/.claude`, `~/.codex` or `~/.agents`. **OpenClaw gets none of these** —
it installs the skill only and uses the
[openclaw-team](https://github.com/tanyu216/openclaw-team) framework's own
`poll`/`patrol` instead (see [`scheduling.md`](scheduling.md#openclaw-do-not-build-a-supervisor)).

Load one of them to start the supervisor:

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.taskpanel.poll.plist    # and .patrol.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now taskpanel-poll.timer taskpanel-patrol.timer
# Anywhere
crontab ~/.claude/scheduling/cron/taskpanel.cron
```

### The claim-unassigned question

When stdin is a TTY and no flag was given, `install.sh` asks once:

```text
Allow claiming unassigned tasks? [Y/n]
```

The answer is persisted to `<host>/task-panel.env` as
`TASKPANEL_CLAIM_UNASSIGNED=yes|no`; the supervisor reads it as its default (an
explicit `--claim-unassigned` flag or `$TASKPANEL_CLAIM_UNASSIGNED` overrides it).
Non-interactive installs default to **yes**; `--claim-unassigned=no` /
`--assignee-only` persist `no`. The file is merge-style: a re-run without
`--force` keeps the existing value.

## install.sh reference

```text
install.sh [--target claude|openclaw|codex|pi|all] [--prefix <home>]
           [--agent-name <name>] [--no-automation]
           [--claim-unassigned=yes|no] [--assignee-only]
           [--link] [--force] [--dry-run] [--skip-node-check] [-h|--help]
```

| Flag | Effect |
|---|---|
| `--target <host>` | Which host(s) to install for. Default `all`. Repeatable, and a comma-separated list (`--target claude,codex`) works too. |
| `--prefix <home>` | Install relative to `<home>` instead of `$HOME`. |
| `--agent-name <name>` | The agent's identity on the board, written into the claude/codex bundle (default `$USER`). Must equal the board assignee for the agent to claim cards. |
| `--no-automation` | Skip **all** Codex automation — the claim trigger *and* the scheduling units (Claude/OpenClaw/Pi are unaffected). |
| `--claim-unassigned=yes\|no` | May the supervisor claim **unassigned** cards (the public pool)? Persisted to `<home>/<host>/task-panel.env`; overrides the interactive answer. Default `yes`. |
| `--assignee-only` | Alias for `--claim-unassigned=no`. |
| `--link` | Symlink the skill instead of copying it — edits to the repo take effect immediately. Recommended for a checkout. |
| `--force` | The **only** way to overwrite. Without it, an existing destination is left untouched (merge, never clobber) and the installer prints a `left unchanged — use --force to overwrite` notice, so a re-run is safe, idempotent, and exits 0. With it, managed files and managed config keys are re-rendered from the current flags. |
| `--dry-run` | Print every path that would be written/changed and change nothing. |
| `--skip-node-check` | Skip the Node version check (see below). |

Before dispatching, `install.sh` requires **Node >= 22** — the engine stores to SQLite
through the built-in `node:sqlite` module, which the 22.x line is the first to ship. A
missing or older `node` is a hard error (`exit 2`), so a machine that cannot run the board
never gets a "successful" install; `--skip-node-check` bypasses the check. The same check
runs from `scripts/install/_common.sh`, so a direct `scripts/install/<host>.sh` invocation
is guarded too.

`install.sh` is a thin dispatcher: it parses the flags once, then runs
`scripts/install/<host>.sh` for each host and prints a per-host summary. It exits
non-zero if any host failed, and each failure names the destination and the fix.

### Idempotence: re-running and `--force`

Installing is **merge-style and idempotent**, so a re-run is never destructive and
never an error:

- **Re-running exits 0** even when nothing changed — an existing install is the desired
  end state, not a conflict.
- **Managed files and managed config keys keep their existing value by default.** The
  skill directory, the emitted scripts (hook / trigger / shim / slash commands), the
  `AGENTS.md` snippet, `env.TASKCTL_AGENT`, and the `SessionStart` hook are all left
  exactly as they are, and the installer reports each as unchanged — for an emitted file,
  `left unchanged — use --force to overwrite`. This means changing a flag such as
  `--agent-name` on its own does **not** take effect on an existing install — it still
  exits 0, with only the unchanged notices on stdout.
- **`--force` is the only way to overwrite.** With it, the managed files and managed
  config keys are re-rendered from the current flags (unrelated keys and hooks are still
  preserved). Deleting the destination first also gives a clean slate.

> One cosmetic exception: re-rendering the Codex `AGENTS.md` snippet with `--force` adds
> exactly one trailing blank line (the sha256 changes; the rendered block and any
> pre-existing content do not). A plain re-run without `--force` is byte-identical, and a
> second `--force` is stable.

### Examples

```bash
bash install.sh --target all --dry-run                 # preview
bash install.sh --target claude --link --force         # development install
bash install.sh --target all --prefix /tmp/tp-home     # isolated home (testing)
```

## Per-host steps

### Claude Code

```bash
# 1. skill + host bundle (MCP registration, settings.json, slash commands, shim)
bash install.sh --target claude --link --agent-name alice

# 2. plugin (registers the marketplace, then installs the plugin)
claude plugin marketplace add "$PWD"
claude plugin install task-panel@task-panel-marketplace -y

# verify
claude plugin list                  # → task-panel@task-panel-marketplace, enabled
claude plugin validate "$PWD"       # validates the plugin + marketplace manifests
```

Step 1 writes, merge-style and idempotently: the skill, `~/.claude/settings.json`
(`env.TASKCTL_AGENT=alice` + a `SessionStart` hook that starts the board and lists
claimable cards), `~/.claude/commands/{board,claim,deliver}.md`, the `taskctl` shim at
`~/.claude/bin/taskctl`, and the scheduling set (`~/.claude/scheduling/*`, the
`wake-claude.sh` glue and `~/.claude/task-panel.env`). It also runs
`claude mcp add taskpanel -- node <repo>/src/mcp/main.mjs` when the `claude` CLI is on
`PATH` (otherwise it prints the exact command). Re-running is safe: existing
`settings.json` keys and hooks are preserved, and `--force` is the only way to overwrite.

Uninstall:

```bash
claude mcp remove taskpanel
claude plugin uninstall task-panel@task-panel-marketplace
claude plugin marketplace remove task-panel-marketplace
rm -rf ~/.claude/skills/task-panel ~/.claude/commands/{board,claim,deliver}.md \
       ~/.claude/hooks/task-panel-session-start.sh ~/.claude/bin/taskctl \
       ~/.claude/bin/wake-claude.sh \
       ~/.claude/scheduling ~/.claude/task-panel.env ~/.claude/task-panel
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

> **No supervisor for OpenClaw.** Unlike the other three hosts, OpenClaw gets **no**
> scheduling unit: it already has a scheduler in the
> [openclaw-team](https://github.com/tanyu216/openclaw-team) framework, whose
> `poll-<agent>` and `task-patrol` automations *are* the design in
> [`scheduling.md`](scheduling.md). `install.sh --target openclaw` writes the skill
> only — install that framework instead.

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
# 1. skill + host bundle (MCP registration, AGENTS.md snippet, claim trigger, shim)
bash install.sh --target codex --link --agent-name alice

# 2. plugin
codex plugin marketplace add "$PWD"
codex plugin add task-panel@task-panel-marketplace

# verify
codex plugin list
```

Step 1 writes, merge-style and idempotently: the skill, a claim-first snippet appended to
`~/.codex/AGENTS.md` (existing content is preserved), the schedulable claim trigger
`~/.codex/task-panel-claim.sh`, the `taskctl` shim at `~/.codex/bin/taskctl`, and the
scheduling set (`~/.codex/scheduling/*`, the `wake-codex.sh` glue and
`~/.codex/task-panel.env`). It also runs
`codex mcp add taskpanel -- node <repo>/src/mcp/main.mjs` when the `codex` CLI is on
`PATH`. Codex has no hooks, so scheduling is the auto-claim mechanism — load one of the
units (see [Scheduling units](#scheduling-units-claude-codex-pi)); the legacy trigger
remains a minimal fallback you can schedule yourself. `--no-automation` skips the trigger
*and* the scheduling set.

Uninstall:

```bash
codex mcp remove taskpanel
codex plugin remove task-panel
codex plugin marketplace remove task-panel-marketplace
rm -rf ~/.codex/skills/task-panel ~/.codex/task-panel-claim.sh ~/.codex/bin/taskctl \
       ~/.codex/bin/wake-codex.sh \
       ~/.codex/scheduling ~/.codex/task-panel.env ~/.codex/task-panel
```

### Pi / Agent Skills

```bash
# 1. skill + scheduling set (units, wake-pi.sh, ~/.agents/task-panel.env)
bash install.sh --target pi --link --force

# 2. package
pi install "$PWD/plugins/pi"

# verify
pi list
```

Pi has no timer of its own, so step 1 also drops the units under
`~/.agents/scheduling/` and the `~/.agents/bin/wake-pi.sh` glue; load one of them to
run the supervisor (see [Scheduling units](#scheduling-units-claude-codex-pi)).

Uninstall:

```bash
pi remove "$PWD/plugins/pi"
rm -rf ~/.agents/skills/task-panel ~/.agents/scheduling ~/.agents/bin/wake-pi.sh ~/.agents/task-panel.env
```

## MCP (optional)

The skill drives the `taskctl` CLI and needs no MCP server. If you prefer the boolean
tool interface, M3 ships a stdio MCP server as the `taskpanel-mcp` bin
(`src/mcp/main.mjs`), a thin proxy to the same local `taskd`.

For **Claude Code and Codex**, `install.sh` already runs the registration (when the host
CLI is on `PATH`); on a machine without it, it prints the exact command instead:

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

### The runtime claim path (offline mock harness)

`profiles.mjs` proves the bundle *installed*; it never runs what the install generated.
`scripts/verify/host-runtime.mjs` does — offline, with no host CLI and no board:

```bash
node scripts/verify/host-runtime.mjs            # all hosts; exit 0 only if every assert passes
node scripts/verify/host-runtime.mjs --host claude
```

It installs into a throwaway prefix (never `$HOME`), replaces the generated `taskctl`
shim with a canned one and puts fake `claude`/`codex`/`pi` executables on `PATH` — both
record their argv — then drives the generated SessionStart hook, the Codex claim trigger
and each `wake-<host>.sh`, asserting the **actual invocation** (exit code + argv +
output), not just "it ran". This is the step that covers the claim path in CI, where the
real CLIs are absent. The full matrix, the argv-vs-`wakeCommand()` cross-check and the
per-host coverage boundary (Pi has no hook/trigger/shim) are in
[`scheduling.md`](scheduling.md#verifying-the-generated-trigger--wake-glue).

## Isolated installs and testing

Nothing is ever written outside the destination paths in the table above. To install
without touching a real host home — for a test, or a CI assert — use a throwaway home.
The bundle hosts write their config, commands and trigger into the same home, and MCP
registration runs with `HOME` (and, for codex, `CODEX_HOME`) pointed there, so the whole
bundle stays isolated:

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

- **`no 'node' on PATH` / `Node vNN.x is too old`** — Task Panel needs **Node >= 22**
  (the engine uses the built-in `node:sqlite` module). Install or upgrade Node and re-run;
  `--skip-node-check` bypasses the check if you know what you are doing.
- **`… left unchanged — use --force to overwrite` (or `already installed … unchanged`)** —
  that is the desired end state, not an error: a re-run leaves existing files and config
  keys untouched (merge, never clobber) and exits **0**. If you *meant* to change something
  (e.g. a new `--agent-name`), re-run with `--force` to overwrite the managed files/keys,
  or delete the destination first for a clean slate. See
  [Idempotence](#idempotence-re-running-and-force).
- **`skill source not found`** — run `install.sh` from this checkout (it resolves
  `skills/task-panel/` relative to itself); a `dist/` bundle must be unpacked first.
- **`plugins/*/skills` out of date** — those copies are generated. Run
  `node scripts/sync-skills.mjs`; `npm run check:skills` fails CI on drift.
- **OpenClaw does not list the plugin** — install the bundle
  (`openclaw plugins install "$PWD/plugins/claude" ...`), not `plugins/openclaw`; see the
  native-vs-bundle note above.
