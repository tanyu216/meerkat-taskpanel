# Installation

Meerkat TaskPanel ships as **two Agent Skills** and **one plugin root** — the repository
itself, which every harness reads in place:

- **`meerkat-taskpanel`** (`skills/meerkat-taskpanel/`) — the board. Installed for all six
  hosts.
- **`meerkat-loop`** (`skills/meerkat-loop/`) — the host-external supervisor that keeps a
  board moving when no agent is looking. Installed for **claude, codex and pi only**;
  OpenClaw gets the board on its own, because the openclaw-team framework already runs an
  equivalent poll / patrol (see [`scheduling.md`](scheduling.md#openclaw-do-not-build-a-supervisor)).

There are three layers, and it is worth keeping them straight:

1. **The skills** — `SKILL.md` + `references/` + a wrapper, copied (or, for the board
   skill, symlinked) into the host's skill directory by `install.sh`. This is
   deterministic, offline, and needs no host tooling. The board skill is what makes the
   agent able to drive `taskctl`; the loop skill carries the supervisor's execution body
   and the templates the units are rendered from.
2. **The host bundle** (Claude Code and Codex) — `install.sh --target claude|codex`
   deploys the rest of the host's setup too, not just the skill: the host config
   (`~/.claude/settings.json` / `~/.codex/AGENTS.md`), slash commands (Claude)
   or a claim trigger (Codex), and a `taskctl` shim that pins the agent identity. Writes
   are **merge-style and idempotent**: a repeat install **exits 0**, leaves every managed
   file and config key at its existing value, and prints a
   `left unchanged — use --force to overwrite` notice; `--force` is the *only* way to
   overwrite. See [Idempotence](#idempotence-re-running-and-force).
3. **The plugin/bundle** — the manifest that lets the host's own plugin system discover
   and enable the skill. This step needs the host CLI, so `install.sh` does **not** run
   it; it prints the command and you run it once. The repository root *is* the board's
   plugin root (`.claude-plugin/plugin.json`), which is what lets every harness share the
   one `skills/` tree instead of receiving a copy. The marketplace has a single entry —
   `meerkat-taskpanel`, sourced at `./`. `meerkat-loop` is **not** a marketplace plugin: it
   is installed by `install.sh`, and only for claude, codex and pi.

> **Status: the engine has landed in full.** The skill is discoverable, the `taskctl`
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

| Host | `--target` | Board skill | Loop skill | Bundle |
|---|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/meerkat-taskpanel` | `~/.claude/skills/meerkat-loop` | `.` — the repository root (`.claude-plugin/plugin.json`) |
| OpenClaw | `openclaw` | `~/.openclaw/skills/meerkat-taskpanel` | **none** — see [OpenClaw](scheduling.md#openclaw-do-not-build-a-supervisor) | `.` — the same root bundle |
| Codex | `codex` | `~/.codex/skills/meerkat-taskpanel` | `~/.codex/skills/meerkat-loop` | `.` — the same root bundle, through the marketplace |
| Pi / Agent Skills | `pi` | `~/.agents/skills/meerkat-taskpanel` | `~/.agents/skills/meerkat-loop` | `.` — the root `package.json`'s `pi` field |
| OpenCode | `opencode` | `~/.config/opencode/skills/meerkat-taskpanel` | **none** — see [OpenCode](#opencode) | `.opencode/plugins/` (in-process registration) |
| Cursor | `cursor` | `~/.cursor/skills/meerkat-taskpanel` | **none** — see [Cursor](#cursor) | `.` — the repository root (`.cursor-plugin/plugin.json`) |

The repository-root Claude marketplace `.claude-plugin/marketplace.json` lists a single
plugin, `./` (the board); Codex reads the same marketplace manifest, which is why it has no
bundle of its own.

Every host above has both routes: a `--target` that lands the skill on disk, and a
plugin/bundle the host's own plugin system reads in place. OpenCode and Cursor are no
exception — see [OpenCode](#opencode) and [Cursor](#cursor).

`--link` applies to the **board** skill only. The loop is always copied: a symlinked
execution body would put the checkout back into the load path of the very thing the split
exists to make independent of it (`skills/meerkat-loop/scripts/`).

**Every host gets a `taskctl` shim**, at `<host>/bin/taskctl`
(`~/.claude/bin/taskctl`, `~/.codex/bin/taskctl`, `~/.agents/bin/taskctl`, …), and it injects
**both halves of the identity** on every call — `--agent <name>` and `--actor-kind <host>` —
with `TASKCTL_AGENT` / `TASKCTL_ACTOR_KIND` as the fallbacks. It is not the supervisor and
not a scheduling unit: it is one wrapper around a command the agent already runs itself,
which is why hosts whose rulings keep the loop out (OpenClaw, OpenCode, Cursor) still get it.
Without it a write from that host carries a name and no kind, and the board reads a write
with no kind as a **person's** — which is what would put it on the record as a decision.

The two bundle hosts write more than the skill. **Claude** additionally writes
`~/.claude/settings.json` (merged `env.TASKCTL_AGENT`, `env.TASKCTL_ACTOR_KIND`,
`env.TASKCTL_HUMAN` + a `SessionStart` hook),
`~/.claude/hooks/meerkat-taskpanel-session-start.sh`, `~/.claude/commands/{board,claim,deliver}.md`
and `~/.claude/bin/taskctl`. **Codex** writes `~/.codex/AGENTS.md` (a claim-first snippet),
`~/.codex/meerkat-taskpanel-claim.sh` (the schedulable trigger) and `~/.codex/bin/taskctl`.
(Their shims are the same file described above — every host gets one.)

The kind is not decoration. It is what the board reads to tell a person from an agent:
a human's `decision` is what goes on the record (I5), what resumes an `awaiting` card, and
what the patrol counts as the leader acting. A shim that set only the name recorded every
agent write as a human's.

`--as-human` is the other direction — the one write an agent makes in the user's voice,
signing with `TASKCTL_HUMAN` instead of itself. `--actor-kind human` is refused: it is the
value every one of those decisions turns on, so a caller may not declare it.

### The local `projects.json` (beside the skill)

The board holds no project directories, so the local map from a **directory** to a
**board project** — and from a project to the directory its **workers** run in — is a
`projects.json` created **inside the installed skill directory**, next to `SKILL.md` —
`~/.claude/skills/meerkat-taskpanel/projects.json` for Claude Code, and the matching
skill directory for each other host. The skill's own reference,
[`projects-json.md`](../skills/meerkat-taskpanel/references/projects-json.md), documents
the schema: an entry names the board `project`, may name a directory (`local_path`, or
the `run_dir` launch directory for a project that has none of its own), and may carry
whatever else the agent should know about the project. `install.sh` ships **no**
`projects.json` and never writes one: the file is yours to create and edit.

**It is never overwritten.** A plain re-run leaves the whole existing skill directory
untouched (an existing install is the desired end state), so a `projects.json` beside
the skill survives every non-forced re-install — the same "merge, never clobber"
rule as the rest of the install. The one exception is `--force`, which deletes and
re-copies the skill directory: **back the file up before a forced re-install** (or
re-create it afterwards). With `--link` the skill directory is a symlink into a
checkout, so the file lands in `skills/meerkat-taskpanel/` there — keep it out of
version control.

### Scheduling units (claude, codex, pi)

| Artefact | Where | What |
|---|---|---|
| loop skill | `<host>/skills/meerkat-loop/` | the loop as a skill: its `SKILL.md`, the generated execution body (`manifest.txt` + `scripts/` + `src/`), the unit/wake/config templates it is deployed with, and the authored board-interface gate (`scripts/board-check.mjs`). Always **copied**, never symlinked |
| loop body | `<host>/meerkat-taskpanel/scripts/supervisor.mjs` + `.../scripts/loop/*.mjs` + `.../scripts/wake-cwd.mjs` + `.../src/foundation/*.mjs` | a **copy** of the scheduler, the deterministic entries, the glue's directory resolver and the modules they import — what the units run, so a loaded unit survives this checkout being moved, renamed or removed (see [`scheduling.md §The loop body is installed, not referenced`](scheduling.md#the-loop-body-is-installed-not-referenced)). The exact file list is the loop skill's generated `manifest.txt` |
| launchd | `<host>/scheduling/launchd/com.meerkat-taskpanel.{ping,continue}.plist` | `StartInterval` 60 / 600 |
| systemd | `<host>/scheduling/systemd/meerkat-taskpanel-{ping,continue}.{service,timer}` | 60s / 600s timers |
| cron | `<host>/scheduling/cron/meerkat-taskpanel.cron` | `* * * * *` ping, `*/10 * * * *` continue |

Each unit names the **absolute `node`** that rendered it and carries a **`PATH`** holding
the host CLI's directory and node's ahead of the scheduler's own default. Neither is
optional: a scheduler starts a unit with a minimal `PATH` that holds no nvm and no Homebrew
directory, so `/usr/bin/env node` is exit 127 — and the wake glue's `exec claude`, and the
worker's own tool tree, resolve on that same set. If the host CLI is not on `PATH` at
install time, the installer says so and renders node's directory alone rather than guessing.
See [`scheduling.md` §What the loop's units run with](scheduling.md#what-the-loops-units-run-with).
| wake glue | `<host>/bin/wake-<host>.sh` | resolves the directory a worker for the card's project runs in (`local_path`, else `run_dir`) from the board skill's `projects.json` via the host-local `meerkat-taskpanel/scripts/wake-cwd.mjs`, `cd`s there (refusing the wake if it cannot), then runs `claude -p` (+`--resume`), `codex exec`, or `pi --print` |
| host config | `<host>/meerkat-taskpanel.env` | `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes\|no`, `MEERKAT_TASKPANEL_RECOVER_STALE=yes\|no`, `MEERKAT_TASKPANEL_REPO=<checkout>` (where the board engine the executor drives lives), the workflow channel's `MEERKAT_TASKPANEL_WORKFLOW`, `MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS`, `MEERKAT_TASKPANEL_REVIEWER` and `MEERKAT_TASKPANEL_ACCEPTANCE_POLICY`, and the clocks' `MEERKAT_TASKPANEL_PING_INTERVAL`, `MEERKAT_TASKPANEL_CONTINUE_INTERVAL` and `MEERKAT_TASKPANEL_CONTINUE` |
| log (runtime) | `<host>/meerkat-taskpanel/supervisor.log` | the supervisor's tick log |
| state (runtime) | `<host>/meerkat-taskpanel/supervisor.state.json` | the running registry |

`<host>` is `~/.claude`, `~/.codex` or `~/.agents`. **OpenClaw gets none of these, and no
`meerkat-loop` skill** — it installs the board skill only and uses the
[openclaw-team](https://github.com/tanyu216/openclaw-team) framework's own
`poll`/`patrol` instead (see [`scheduling.md`](scheduling.md#openclaw-do-not-build-a-supervisor)).

**Load one of them to start the supervisor** — this is the **manual** path, and a plain
install stops here (nothing is loaded for you):

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist    # and .continue.plist + .subscribe.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-subscribe.service
# Anywhere
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

`--supervisor=enable` is the **opt-in** path that runs the right one of these for you —
see [Enabling the supervisor (opt-in)](#enabling-the-supervisor-opt-in) below.

### Enabling the supervisor (opt-in)

A plain install **writes** the units above and prints the load command — it never loads
anything. Starting the daemon is a separate, **explicit request**, and it is one flag:

```bash
bash install.sh --target all --supervisor=enable                # enable claude, codex and pi
bash install.sh --supervisor=enable --supervisor-hosts claude   # …just one host
bash install.sh --supervisor=status                             # what is loaded right now
bash install.sh --supervisor=disable --supervisor-hosts claude  # stop and remove it
```

**Per-host selection is `--supervisor-hosts claude,codex,pi`** — a subset of the loop hosts
the install covers (default: the loop hosts present in `--target`). It is deliberately
*not* `--host`: in this repo `--host` already means the **wake** selector inside
`scripts/supervisor.mjs --host claude|codex|pi`, and reusing the name on `install.sh` would
collide. **`openclaw` is rejected** in this list (reason on stderr, exit 2) — it has no loop
supervisor to enable (see
[`scheduling.md §OpenClaw: do not build a supervisor`](scheduling.md#openclaw-do-not-build-a-supervisor)).

**One entry point, three actions.** `--supervisor=enable|disable|status` (aliases
`--enable-supervisor`, `--disable-supervisor`, `--supervisor-status`), with
`--scheduler auto|launchd|systemd|cron` choosing the mechanism — there is no second script
to remember. Non-interactive callers use
`MEERKAT_TASKPANEL_SUPERVISOR=enable|disable|status` instead of the flag (an explicit flag
wins), the same precedence style as `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED`.

**The TTY question.** When stdin is a TTY and neither a flag nor the env var was given, the
installer asks once:

```text
Enable the supervisor now? It runs headless in the background (ping 60s / continue 600s). [y/N]
```

The default is **N** — deliberately the opposite of the `--claim-unassigned` question
below, which asks the same way but defaults **Y**. The supervisor is a **daemon** that runs
unattended, so silence must mean *no*: it is opt-in, never silent residency, and a plain
`install.sh` never enables it.

**Idempotence and safety.** A repeat enable never double-loads — an already-loaded unit is
reported as `already enabled` and exits 0 — and enabling a second mechanism for the same
host requires disabling the first, so the installer never leaves two loaded. `--dry-run`
always wins: with it, `--supervisor=enable` prints the exact commands it would run and
changes nothing. On success the installer reports what it enabled **and how to stop it**:

```text
supervisor: enabled (host=claude, scheduler=launchd, units=com.meerkat-taskpanel.<agent>.claude.ping,.continue,.subscribe)
to disable:  install.sh --supervisor=disable --supervisor-hosts claude
```

Enabling installs the two clocks described above: a $0 ping and one bounded `继续`
judgment turn per continue cadence. Inside that turn the poll is still the $0 local
scan, and a worker turn still starts only when a claim succeeded (see
[`scheduling.md §The cost gate`](scheduling.md#the-cost-gate-a-worker-turn-starts-only-on-fire)).

The exact per-OS commands, their failure modes, and the `loginctl enable-linger` caveat are
in [`scheduling.md §Enabling the supervisor (opt-in)`](scheduling.md#enabling-the-supervisor-opt-in).

An enable that the OS refuses — a `launchctl bootstrap` with no GUI session, a
`systemctl --user` with no D-Bus — is **reported, not disguised**: the install prints
`supervisor: not enabled (…)` with the reason and the exact command to run by hand, and
still exits 0, because the host's skills are installed either way and an OS-level refusal
is not something `--force` fixes.


### The taskd guard (keepalive, always enabled)

The board server `taskd` (`src/server/main.mjs`) is kept alive by an **OS-level guard**,
and — alone among the units `install.sh` writes — it is **enabled at install time**.
`taskctl` lazy-starts `taskd` only when a CLI call needs it, so an idle board whose
server dies stays down until the next call (see
[`scheduling.md § The taskd guard (keepalive)`](scheduling.md#the-taskd-guard-keepalive));
the guard closes that gap by restarting the server after any exit.

This is a deliberate, **narrow exception** to the rule that the installer never starts
a daemon for you (the [Scheduling units](#scheduling-units-claude-codex-pi) above). It
applies **only to the `taskd` service guard**: the `meerkat-loop` supervisor's units are
still written and left for you to load, and OpenClaw still gets none.

**Where it lands** — a neutral directory, deliberately *not* the loop units'
`<host>/scheduling/`, so re-installing a host's loop units never touches it:

```text
<prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
<prefix>/taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service
```

`<prefix>` is `--prefix` (default `$HOME`). There is **one guard per machine** — and
therefore **one guarded board** — not one per host: the label and unit name carry no agent
or host segment, and which board it serves is chosen at install time. See
[`scheduling.md § One guard per machine`](scheduling.md#one-guard-per-machine).

**What install does:** it writes the unit and loads it immediately — no question, no
separate flag:

```bash
# macOS
launchctl bootstrap gui/$UID <prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
# Linux (user unit)
mkdir -p ~/.config/systemd/user
cp <prefix>/taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-taskd.service
```

The install ends with a report line, followed by the commands that undo it:

```text
taskd guard: enabled (com.meerkat-taskpanel.taskd, pid …)
```

`enabled` is claimed only once the board itself answers `/health` — a loaded unit with a
pid is not a working board. When the unit is loaded but nothing answers, install says so
and names the log to read:

```text
taskd guard: loaded (com.meerkat-taskpanel.taskd, pid …); /health did not answer within 10000ms — read <dataDir>/logs/taskd.log
```

Neither line fails the install. The unit names the **absolute** node that ran the install,
so a node that lives only under nvm or Homebrew still starts the server — see
[`scheduling.md § The taskd guard (keepalive)`](scheduling.md#the-taskd-guard-keepalive).

**A second board does not inherit the guard.** The guard is one per machine
([`scheduling.md § One guard per machine`](scheduling.md#one-guard-per-machine)), so a
re-install for a *different* board is refused rather than silently re-pointing the machine's
only guard (on Linux, systemd reads `~/.config/systemd/user/meerkat-taskpanel-taskd.service`
and that file is the guard). The refusal names both boards, leaves the unit alone, and is
the install's one non-zero guard outcome — **exit 3**, which `install.sh` reports and then
carries on from (the host skills are installed either way, and the install's own exit status
is unchanged). `--force` is how you re-point it deliberately:

```text
taskd guard: refused — com.meerkat-taskpanel.taskd is already loaded and serves another board (<its dataDir>);
  ~/.config/systemd/user/meerkat-taskpanel-taskd.service was left unchanged, and this board (<this dataDir>) is not guarded by it
taskd guard: this machine runs one guarded board — re-run with --force to point it at <this dataDir>
```

A re-install of the **same** board is not a refusal, and says which board the loaded guard
serves — so `already loaded (no change)` can no longer read as "your board is guarded" when
it is not:

```text
taskd guard: already loaded (no change) — the machine's guard serves this board (<dataDir>)
taskd guard: already loaded (no change) — which board it serves could not be read here
```

**Stopping / uninstalling it.** The guard restarts the server after *any* exit, so a
plain `kill` is not enough — use the supervisor's own stop:

```bash
# macOS
launchctl bootout gui/$UID/com.meerkat-taskpanel.taskd
rm <prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
# Linux
systemctl --user disable --now meerkat-taskpanel-taskd.service
rm ~/.config/systemd/user/meerkat-taskpanel-taskd.service
```

**Internal bypasses** (not user options): `--no-automation` skips the guard along with
its other automation targets (see its row in the flag table below), and its environment
form `MEERKAT_TASKPANEL_NO_AUTOMATION=1` — the variable `install.sh` sets for each host
installer — skips exactly the same things; `--dry-run`
writes and loads nothing and reports `taskd guard: skipped (dry-run)`;
`MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1` skips the guard and is **for tests only**.

The unit files in full, the restart and back-off semantics, and how the guard coexists
with `taskctl`'s lazy start are in
[`scheduling.md § The taskd guard (keepalive)`](scheduling.md#the-taskd-guard-keepalive).


### The claim-unassigned question

When stdin is a TTY and no flag was given, `install.sh` asks once:

```text
Allow claiming unassigned tasks? [Y/n]
```

The answer is persisted to `<host>/meerkat-taskpanel.env` as
`MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes|no`; the supervisor reads it as its default (an
explicit `--claim-unassigned` flag or `$MEERKAT_TASKPANEL_CLAIM_UNASSIGNED` overrides it).
Non-interactive installs default to **yes**; `--claim-unassigned=no` /
`--assignee-only` persist `no`. **Stale recovery is a separate opt-out**:
`--recover-stale=no` (or `$MEERKAT_TASKPANEL_RECOVER_STALE=no`) persists
`MEERKAT_TASKPANEL_RECOVER_STALE=no`, and the supervisor then never takes over an
`in_progress` card — the same holder's 30-minute re-claim included. The file is merge-style: a re-run without
`--force` keeps the existing value, and it also records where the board engine
lives (`MEERKAT_TASKPANEL_REPO=<checkout>`) — a key the installer adds when it is
missing, so an install made before that key existed still learns it (see
[`scheduling.md §The loop body is installed, not referenced`](scheduling.md#the-loop-body-is-installed-not-referenced)).

The same merge rule covers the workflow channel's three keys, written with their defaults
when the file is created and added only when missing on an upgrade:

```ini
MEERKAT_TASKPANEL_WORKFLOW=yes
MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=yes
MEERKAT_TASKPANEL_REVIEWER=
MEERKAT_TASKPANEL_ACCEPTANCE_POLICY=both
```

The board's own copy — what it actually enforces — is `TASKD_ACCEPTANCE_POLICY` in the
**install-root `.env`**, seeded by the installer (`<program root>/.env`, 0600) and the same
file the Access panel and the client read. `both` is the default; `human-only` makes the loop
hold a top-level approval for a human, and `agent-only` lets any non-human writer close a card.
The file is merged, never rewritten. The old `<dataDir>/taskd.env` is no longer read: move any
keys it has into `.env`.

`MEERKAT_TASKPANEL_ENV_FILE` points the installer and both binaries at a different file (a
read-only package root, a container, or the test suite).

`--reviewer` (or `MEERKAT_TASKPANEL_REVIEWER`) is what turns review dispatch on. With it
unset the supervisor still reconciles containers and applies verdicts already in flight —
it simply creates no new review cards, and deliveries wait for a human.
[`scheduling.md §The workflow channel`](scheduling.md#the-workflow-channel-review-acceptance-and-containers)
is the full contract.

## install.sh reference

```text
install.sh [--target claude|openclaw|codex|pi|opencode|cursor|all] [--prefix <home>]
           [--agent-name <name>] [--no-automation]
           [--claim-unassigned=yes|no] [--assignee-only] [--recover-stale=yes|no]
           [--workflow=yes|no] [--reviewer <agent>] [--auto-accept-reviews=yes|no]
           [--ping-interval <sec>] [--continue-interval <sec>] [--continue=yes|no]
           [--supervisor=enable|disable|status] [--supervisor-hosts <list>]
           [--scheduler auto|launchd|systemd|cron]
           [--link] [--force] [--dry-run] [--skip-node-check] [-h|--help]
```

| Flag | Effect |
|---|---|
| `--target <host>` | Which host(s) to install for. Default `all`. Repeatable, and a comma-separated list (`--target claude,codex`) works too. |
| `--prefix <home>` | Install relative to `<home>` instead of `$HOME`. |
| `--agent-name <name>` | The agent's identity on the board, written into the claude/codex bundle (default `$USER`). Must equal the board assignee for the agent to claim cards. |
| `--no-automation` | Skip **all** Codex automation — the claim trigger *and* the scheduling units — **and** the `taskd` keepalive guard; the Claude/OpenClaw/Pi skill bundles are otherwise unaffected. |
| `MEERKAT_TASKPANEL_NO_AUTOMATION=1` | The environment form of the `--no-automation` bypass — `install.sh` sets exactly this variable for each host installer, and `scripts/install/_common.sh` reads it, so a direct installer run honours it too. Internal bypass, not a user option. |
| `--claim-unassigned=yes\|no` | May the supervisor claim **unassigned** cards (the public pool)? Persisted to `<home>/<host>/meerkat-taskpanel.env`; overrides the interactive answer. Default `yes`. |
| `--assignee-only` | Alias for `--claim-unassigned=no`. |
| `--recover-stale=yes\|no` | May the supervisor recover stale `in_progress` claims — the same holder after 30 minutes, any agent after 6 hours? Persisted to the host config; default `yes`. |
| `--workflow=yes\|no` | Run the supervisor's workflow sub-pass — ask the board for the workflow plan (`issue reconcile --workflow`) and apply its review actions. Persisted to the host config; default `yes`. `no` means the loop writes no card at all. |
| `--reviewer <agent>` | The independent agent that reviews delivered cards. Persisted to the host config. Unset (the default) disables **dispatch** only; a delivery then waits for a human to accept it. |
| `--auto-accept-reviews=yes\|no` | Let the loop close a review card after applying its verdict. Persisted; default `yes`. `no` is the escape hatch: the verdict is still applied, but the review card stays in `in_review` for a human. |
| `--ping-interval <sec>` | The liveness clock, rendered into the units; default `60`. It only prunes dead worker pids — no board read, no LLM. |
| `--continue-interval <sec>` | The judgment clock, rendered into the units; default `600` (10 minutes). It wakes the host with a bounded `继续` prompt; that turn runs poll, patrol and workflow. |
| `--continue=yes\|no` | Enable the continue turn. Persisted to the host config; default `yes`. `no` keeps the ping clock but discovers no work until a human runs the poll entry. |
| `--supervisor=enable\|disable\|status` | Opt-in control of the supervisor **daemon** (the units above): `enable` loads/enables it, `disable` unloads/removes it, `status` prints the per-host load state and changes nothing. Off by default — a plain install still only *prints* the load command. Aliases: `--enable-supervisor`, `--disable-supervisor`, `--supervisor-status`. See [Enabling the supervisor (opt-in)](#enabling-the-supervisor-opt-in). |
| `--supervisor-hosts <list>` | Which loop hosts the `--supervisor` action applies to — a comma list ⊆ `{claude,codex,pi}` (default: the loop hosts present in `--target`). Deliberately **not** a `--host` flag: `--host` already means the **wake** selector in `scripts/supervisor.mjs`, so reusing the name here would collide. `openclaw` is **rejected** (reason on stderr, exit 2). |
| `--scheduler <auto\|launchd\|systemd\|cron>` | Which mechanism the `--supervisor` action acts on (default `auto`: launchd on macOS, systemd on Linux, cron elsewhere). Only one mechanism may be loaded per host — see [`scheduling.md §Enabling the supervisor (opt-in)`](scheduling.md#enabling-the-supervisor-opt-in). |
| `MEERKAT_TASKPANEL_SUPERVISOR=enable\|disable\|status` | The non-interactive form of `--supervisor` (an explicit flag wins) — the same precedence style as `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED`. |
| `--link` | Symlink the **board** skill instead of copying it — edits to the repo take effect immediately. Recommended for a checkout. The `meerkat-loop` skill is always copied, because the loop's whole point is that its execution body does not live in a checkout. |
| `--force` | The **only** way to overwrite. Without it, an existing destination is left untouched (merge, never clobber) and the installer prints a `left unchanged — use --force to overwrite` notice, so a re-run is safe, idempotent, and exits 0. With it, managed files and managed config keys are re-rendered from the current flags. |
| `--dry-run` | Print every path that would be written/changed and change nothing. |
| `--skip-node-check` | Skip the Node version check (see below). |

**The `taskd` guard is always enabled and has no user flag.** Every install writes
the `taskd` keepalive unit and loads it — there is no switch to turn it on and no prompt
to answer (see [The taskd guard](#the-taskd-guard-keepalive-always-enabled)). The
bypasses are `--no-automation` (or its environment form
`MEERKAT_TASKPANEL_NO_AUTOMATION=1`), `--dry-run`, and — **for tests only** —
`MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1`. This is the one exception to "write the unit,
print the load command, never start a daemon"; the `meerkat-loop` units keep that rule.

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
  `AGENTS.md` snippet, `env.TASKCTL_AGENT` / `env.TASKCTL_ACTOR_KIND` / `env.TASKCTL_HUMAN`,
  and the `SessionStart` hook are all left
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
bash install.sh --target all --supervisor=enable       # opt in: install + load the supervisor
```

## Per-host steps

### Claude Code

```bash
# 1. skill + host bundle (settings.json, slash commands, shim)
bash install.sh --target claude --link --agent-name alice

# 2. plugin (registers the marketplace, then installs the plugin)
claude plugin marketplace add "$PWD"
claude plugin install meerkat-taskpanel@meerkat-taskpanel-marketplace -y

# verify
claude plugin list                  # → meerkat-taskpanel@meerkat-taskpanel-marketplace, enabled
claude plugin validate "$PWD"       # validates the plugin + marketplace manifests
```

Step 1 writes, merge-style and idempotently: the skill, `~/.claude/settings.json`
(`env.TASKCTL_AGENT=alice` + a `SessionStart` hook that starts the board and lists
claimable cards), `~/.claude/commands/{board,claim,deliver}.md`, the `taskctl` shim at
`~/.claude/bin/taskctl`, and the scheduling set (`~/.claude/scheduling/*`, the
`wake-claude.sh` glue and `~/.claude/meerkat-taskpanel.env`). Re-running is safe: existing
`settings.json` keys and hooks are preserved, and `--force` is the only way to overwrite.

Uninstall:

```bash
claude plugin uninstall meerkat-loop@meerkat-taskpanel-marketplace   # if you installed it
claude plugin uninstall meerkat-taskpanel@meerkat-taskpanel-marketplace
claude plugin marketplace remove meerkat-taskpanel-marketplace
rm -rf ~/.claude/skills/meerkat-taskpanel ~/.claude/skills/meerkat-loop \
       ~/.claude/commands/{board,claim,deliver}.md \
       ~/.claude/hooks/meerkat-taskpanel-session-start.sh ~/.claude/bin/taskctl \
       ~/.claude/bin/wake-claude.sh \
       ~/.claude/scheduling ~/.claude/meerkat-taskpanel.env ~/.claude/meerkat-taskpanel
```

### OpenClaw

```bash
# 1. skill
bash install.sh --target openclaw --link --force

# 2. bundle — OpenClaw consumes the Claude-format bundle at the repository root
openclaw plugins install "$PWD" --force --accept-capabilities

# verify
openclaw plugins inspect meerkat-taskpanel
```

`openclaw plugins inspect meerkat-taskpanel` reports the bundle mapping:

```text
Format: bundle
Bundle format: cursor
Bundle capabilities: skills
```

**Why `cursor`?** The repository root carries two client markers — `.cursor-plugin/` and
`.claude-plugin/` — and OpenClaw's detection precedence is **codex → cursor → claude**. The
root is therefore reported as a cursor bundle. That is the only line the second marker
changes: `Format: bundle`, `Shape`, `Capability mode` and `Bundle capabilities: skills` are
identical either way (measured against OpenClaw 2026.9.8 with and without the marker).

> **No supervisor for OpenClaw.** Unlike claude, codex and pi, OpenClaw gets **no**
> scheduling unit and **no `meerkat-loop` skill**: it already has a scheduler in the
> [openclaw-team](https://github.com/tanyu216/openclaw-team) framework, whose
> per-agent poll and `task-patrol` automations *are* the design in
> [`scheduling.md`](scheduling.md). `install.sh --target openclaw` writes the board skill
> only — install that framework instead. The exclusion is permanent, not a gap: two
> supervisors on one board would only race each other for the same cards.

> **No native manifest.** Meerkat TaskPanel does not ship an `openclaw.plugin.json`. A
> *native* OpenClaw plugin is an in-process runtime module and must ship
> `package.json#openclaw.extensions` plus an entry point that imports the OpenClaw plugin
> SDK — a real dependency this zero-dependency project deliberately does not take, so such
> a manifest could not be installed as what it claims to be. The **skill-only** pack
> installs through the supported bundle route above (or, equivalently, by placing the skill
> in `~/.openclaw/skills/`). OpenClaw's detector does recognise a native manifest when one
> is present; the repository simply has none.

Uninstall:

```bash
openclaw plugins uninstall meerkat-taskpanel
rm -rf ~/.openclaw/skills/meerkat-taskpanel
```

### Codex

```bash
# 1. skill + host bundle (AGENTS.md snippet, claim trigger, shim)
bash install.sh --target codex --link --agent-name alice

# 2. plugin
codex plugin marketplace add "$PWD"
codex plugin add meerkat-taskpanel@meerkat-taskpanel-marketplace

# verify
codex plugin list
```

Step 1 writes, merge-style and idempotently: the skill, a claim-first snippet appended to
`~/.codex/AGENTS.md` (existing content is preserved), the schedulable claim trigger
`~/.codex/meerkat-taskpanel-claim.sh`, the `taskctl` shim at `~/.codex/bin/taskctl`, and the
scheduling set (`~/.codex/scheduling/*`, the `wake-codex.sh` glue and
`~/.codex/meerkat-taskpanel.env`). Codex has no hooks, so scheduling is the auto-claim
mechanism — load one of the units (see
[Scheduling units](#scheduling-units-claude-codex-pi)); the legacy trigger remains a
minimal fallback you can schedule yourself. `--no-automation` (or its environment form
`MEERKAT_TASKPANEL_NO_AUTOMATION=1`) skips the trigger *and* the scheduling set.

Uninstall:

```bash
codex plugin remove meerkat-taskpanel
codex plugin marketplace remove meerkat-taskpanel-marketplace
rm -rf ~/.codex/skills/meerkat-taskpanel ~/.codex/skills/meerkat-loop \
       ~/.codex/meerkat-taskpanel-claim.sh ~/.codex/bin/taskctl \
       ~/.codex/bin/wake-codex.sh \
       ~/.codex/scheduling ~/.codex/meerkat-taskpanel.env ~/.codex/meerkat-taskpanel
```

### Pi / Agent Skills

```bash
# 1. skill + scheduling set (units, wake-pi.sh, ~/.agents/meerkat-taskpanel.env)
bash install.sh --target pi --link --force

# 2. package — the repository's own package.json declares the pi manifest
pi install "$PWD"

# verify
pi list
```

The root `package.json` carries Pi's manifest, so no copy of the skill tree is made:

```jsonc
"pi": { "skills": ["./skills"], "extensions": ["./.pi/extensions/meerkat-taskpanel.ts"] }
```

`pi.skills` is the skills directory, and `pi.extensions` is the module that re-registers
the same directory at runtime through Pi's `resources_discover` event. Those are two of the
four resource fields Pi reads from a package's `pi` object (`extensions`, `skills`,
`prompts`, `themes`), which is why the board needs no Pi bundle directory of its own.

Pi has no timer of its own, so step 1 also drops the units under
`~/.agents/scheduling/` and the `~/.agents/bin/wake-pi.sh` glue; load one of them to
run the supervisor (see [Scheduling units](#scheduling-units-claude-codex-pi)).

Uninstall:

```bash
pi remove "$PWD"
rm -rf ~/.agents/skills/meerkat-taskpanel ~/.agents/skills/meerkat-loop \
       ~/.agents/scheduling ~/.agents/bin/wake-pi.sh ~/.agents/meerkat-taskpanel.env
```

### OpenCode

```bash
# 1. skill + host config
bash install.sh --target opencode --link --force

# 2. plugin (optional — it delivers the same skills, read in place)
#    see the registration below
```

Step 1 writes the board skill to `~/.config/opencode/skills/meerkat-taskpanel` and the
host config `~/.config/opencode/meerkat-taskpanel.env`, whose `MEERKAT_TASKPANEL_REPO`
is what lets the skill's wrapper find the board engine once the skill no longer sits
beside the checkout (see the resolution ladder in
[the wrapper](../skills/meerkat-taskpanel/scripts/run.mjs)).

> **No supervisor, and no scheduling unit.** OpenCode gets no `~/.config/opencode/scheduling`,
> no `meerkat-loop` skill and no `wake-opencode.sh`. The supervisor's glue is a *headless*
> invocation, and OpenCode's headless and resume forms are **unverified** here —
> `docs/scheduling.md` says so in as many words ("opencode is not a supported `--host`;
> its headless and resume forms were **not verified** — its CLI was not installed").
> Pointing an unattended daemon at an unverified command is a different risk class from
> copying a skill, so `--supervisor-hosts opencode` is rejected (exit 2). Use the plugin
> route below and wake OpenCode yourself until someone can probe those forms.

Uninstall:

```bash
rm -rf ~/.config/opencode/skills/meerkat-taskpanel ~/.config/opencode/meerkat-taskpanel.env
```

#### The plugin route

The step above copies the skill; the plugin hands OpenCode the repository's own copy
*in place*, so a host that registers it needs no step 1 at all. Register it in
`opencode.json` (V2 `>= 2.0.4`; V1 uses the singular `plugin` key):

```jsonc
{
  // V2: { "plugins": ["meerkat-taskpanel@git+https://github.com/tanyu216/meerkat-taskpanel.git"] }
  "plugin": ["meerkat-taskpanel@git+https://github.com/tanyu216/meerkat-taskpanel.git"]
}
```

`.opencode/plugins/meerkat-taskpanel.js` then hands OpenCode the repository's own
`skills/` directory — nothing is copied. On V1 it pushes that directory into
`config.skills.paths`; on V2, where `config.skills` is a flat array, it registers one
`Skill.Info` per `skills/<name>/SKILL.md` instead. Both skills arrive together, because
OpenCode's registration unit is a directory.

```bash
# verify — a session should list meerkat-taskpanel as a skill
opencode run --standalone --print-logs "hello" 2>&1 | grep -i meerkat
```

Uninstall: remove the entry from `opencode.json`. Update: restart OpenCode; some OpenCode
and Bun versions pin the resolved git dependency in a lockfile or cache, in which case a
restart alone picks up nothing — clear that cache, or pin explicitly with `#vX.Y.Z`.

**Unverified, and flagged as such.** OpenCode's CLI is not installed in this repository's
container or on the development host, so the *host integration* above has never been run
from here. The plugin's own logic is covered by `test/install/opencode-plugin.test.mjs`,
which drives it against a fake plugin context.

### Cursor

```bash
# 1. skill + host config
bash install.sh --target cursor --link --force

# 2. plugin (optional — it delivers the same skills, read in place)
#    in Cursor's agent chat:  /add-plugin meerkat-taskpanel
#    or search for it in the plugin marketplace
```

Step 1 writes the board skill to `~/.cursor/skills/meerkat-taskpanel` and the host config
`~/.cursor/meerkat-taskpanel.env`, whose `MEERKAT_TASKPANEL_REPO` is what lets the skill's
wrapper find the board engine once the skill no longer sits beside the checkout.

> **Rank of the evidence.** `~/.cursor/skills/` is where Cursor reads user skills, per
> secondary sources (Cursor's help index and a third-party agent-skills guide agree;
> Cursor also reads `~/.agents/skills/` and the `~/.claude` / `~/.codex` compatibility
> directories, so an existing `--target claude` install is already visible to it). It is a
> *skill directory*, so a wrong guess leaves an inert folder — which is why this target
> ships while the supervisor below does not.

Uninstall:

```bash
rm -rf ~/.cursor/skills/meerkat-taskpanel ~/.cursor/meerkat-taskpanel.env
```

> **No supervisor, and no scheduling unit.** Cursor gets no `~/.cursor/scheduling`, no
> `meerkat-loop` skill and no `wake-cursor.sh`, and `--supervisor-hosts cursor` is
> rejected (exit 2). `docs/scheduling.md` has no Cursor row at all — its headless and
> resume forms are unverified here, and the only invocation anyone records
> (`cursor-agent -p`) appears in a third-party experiment table, not in an install or
> reference document. The units start *the glue*, which is a headless call; an unattended
> daemon is not the place to guess.

#### The plugin route

`.cursor-plugin/plugin.json` declares `"skills": "./skills/"` — the repository's one
`skills/` tree, read in place, so Cursor needs no `skills/` directory of its own. Like
OpenCode, Cursor registers a *directory*, so both skills arrive together.

**No hooks are shipped, deliberately.** Cursor's hook contract is its own schema (a
lowercase `sessionStart` key, a relative `command`, `additional_context` rather than Claude
Code's `hookSpecificOutput.additionalContext`), and Cursor's own documentation has no
uninstall or update path to follow. Rather than invent one, the plugin is skills-only —
which is also what the board's Claude plugin and OpenClaw bundle are. Porting the
session-start briefing to Cursor is a follow-up card, and it must be proved with a
unique-marker test (a throwaway hook whose marker must reach the model with no tool call)
rather than assumed.

**Unverified, and flagged as such.** Cursor's CLI is not installed here, so nothing in this
section has been run from this repository. Upstream does not document Cursor's
uninstall/update path at all, so even the install gesture above is transcribed from
`obra/superpowers` rather than reproduced.

## Agent integration: skill only

> **The MCP integration has been removed — agent integration is skill-only.** The stdio
> MCP server and its `meerkat-taskpanel-mcp` bin are gone. A host left with an MCP
> registration should drop it — `claude mcp remove meerkat-taskpanel`, `codex mcp remove
> meerkat-taskpanel`, or the matching entry in OpenClaw's or Pi's MCP configuration. No
> replacement is needed: the skill drives the `taskctl` CLI directly.

The installed skill is self-contained but carries **no engine**: `install.sh` copies
`SKILL.md`, `references/` and `scripts/` into the host, never `src/`. So the wrapper
`scripts/run.mjs` resolves the CLI on a ladder — a checkout named by
`MEERKAT_TASKPANEL_ROOT` (or by `MEERKAT_TASKPANEL_REPO`, the key the installer records in
the host config), then a checkout around the skill itself, then **the host's own `taskctl`
shim** beside the skill, then `taskctl` on `PATH` — and when none of those holds a CLI it
stops with the ways to fix it, instead of the module-not-found stack an earlier version died
with (T-20261014-214002). In the normal case it is the shim that answers: `install.sh` writes
it into the host's own `bin/` (`~/.claude/bin/taskctl`, `~/.codex/bin/taskctl`, …), and the
ladder finds it **without** `PATH` having to include that directory — one fewer thing to get
right, and the rung that carries the identity. Putting the directory on `PATH` also works,
as does `npm link` or a global install.

## Verifying the install

**Everything that runs is verified inside the container** (see
[`docker.md`](docker.md) and ARCHITECTURE §9.1): the six host CLIs are not installed in
the image and there is no network, so the container asserts each host's *detection
contract* offline instead.

```bash
npm run verify:docker                     # the full container suite, all six hosts
```

That run includes `scripts/verify/profiles.mjs`, which for each host installs into a
throwaway home and asserts: the skill lands at the host's destination, `SKILL.md`
frontmatter still names `meerkat-taskpanel`, the wrapper resolves back to this checkout, the
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
record their argv and working directory — then drives the generated SessionStart hook, the
Codex claim trigger and each `wake-<host>.sh`, asserting the **actual invocation** (exit
code + argv + cwd + output), not just "it ran". This is the step that covers the claim
path in CI, where the real CLIs are absent. The full matrix, the argv-vs-`wakeCommand()`
cross-check, the resolved-working-directory assertions and the
per-host coverage boundary (Pi has no hook/trigger/shim) are in
[`scheduling.md`](scheduling.md#verifying-the-generated-trigger--wake-glue).

## Isolated installs and testing

Nothing is ever written outside the destination paths in the table above. To install
without touching a real host home — for a test, or a CI assert — use a throwaway home.
The bundle hosts write their config, commands and trigger into the same home, so the whole
bundle stays isolated:

```bash
bash install.sh --target all --prefix /tmp/tp-home
MEERKAT_TASKPANEL_TARGET_HOME=/tmp/tp-home bash scripts/install/claude.sh   # env equivalent
```

The host CLIs honour their own config-directory variables, so a fully isolated plugin
install is possible too:

```bash
HOME=/tmp/tp-home CLAUDE_CONFIG_DIR=/tmp/tp-home/.claude claude plugin marketplace add "$PWD"
HOME=/tmp/tp-home CODEX_HOME=/tmp/tp-home/.codex codex plugin marketplace add "$PWD"
```

## Uninstalling

Each host's section above lists the plugin/bundle removal command. The skills themselves
are removed by deleting their destinations:

```bash
rm -rf ~/.claude/skills/meerkat-taskpanel ~/.claude/skills/meerkat-loop      # claude
rm -rf ~/.openclaw/skills/meerkat-taskpanel                                  # openclaw (no loop)
rm -rf ~/.codex/skills/meerkat-taskpanel ~/.codex/skills/meerkat-loop        # codex
rm -rf ~/.agents/skills/meerkat-taskpanel ~/.agents/skills/meerkat-loop      # pi
```

Nothing is written outside those directories, and nothing is sent over the network — see
[`PRIVACY.md`](../PRIVACY.md).

## Troubleshooting

- **`no 'node' on PATH` / `Node vNN.x is too old`** — Meerkat TaskPanel needs **Node >= 22**
  (the engine uses the built-in `node:sqlite` module). Install or upgrade Node and re-run;
  `--skip-node-check` bypasses the check if you know what you are doing.
- **`… left unchanged — use --force to overwrite` (or `already installed … unchanged`)** —
  that is the desired end state, not an error: a re-run leaves existing files and config
  keys untouched (merge, never clobber) and exits **0**. If you *meant* to change something
  (e.g. a new `--agent-name`), re-run with `--force` to overwrite the managed files/keys,
  or delete the destination first for a clean slate. See
  [Idempotence](#idempotence-re-running-and-force).
- **`skill source not found`** — run `install.sh` from this checkout (it resolves
  `skills/meerkat-taskpanel/` relative to itself); a `dist/` bundle must be unpacked first.
- **`loop payload out of date`** — `skills/meerkat-loop/manifest.txt`, `scripts/`, `src/`
  and `templates/` are generated. Run `node scripts/sync-skills.mjs`; `npm run
  check:skills` fails CI on drift.
- **An older install still has `skills/meerkat-loop/body/`** — that wrapper was retired; the
  leftover is inert (units and wake glue read `<host>/meerkat-taskpanel/`). Re-run the
  install with `--force` to replace the skill directory.
- **OpenClaw does not list the plugin** — install the bundle at the repository root
  (`openclaw plugins install "$PWD" ...`); see the OpenClaw section above.
