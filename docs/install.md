# Installation

Meerkat TaskPanel ships as **a local server**, **three Agent Skills** and **one plugin root**
— the repository itself, which every harness reads in place:

- **`meerkat-taskpanel`** (`skills/meerkat-taskpanel/`) — the board. Installed for all four
  agents.
- **`meerkat-loop`** (`skills/meerkat-loop/`) — the external supervisor that keeps a
  board moving when no agent is looking. Installed for **every agent except OpenClaw**
  (claude, codex, pi); OpenClaw gets the board on its own, because the
  openclaw-team framework already runs an equivalent poll / patrol (see
  [`scheduling.md`](scheduling.md#openclaw-do-not-build-a-supervisor)).
- **`setup-meerkat`** (`skills/setup-meerkat/`) — the user-invoked `/setup-meerkat`
  command: it detects what is installed, repairs what is missing, offers the Matt Pocock
  issue-tracker integration, and installs an optional Jobs/Linus/Turing plus reviewer
  team. The bash installer copies it **with the Claude bundle only**; the repository
  bundle and marketplace still carry it for the other agent kinds.

> **"Actor kind" and "agent".** An **actor kind** is the application that runs the agent — Claude
> Code, OpenClaw, Codex or Pi / Agent Skills: the values `--target` takes.
> An **agent** is the identity recorded on the board (`--agent jobs|linus|turing`,
> `install.sh --agent-name`). Kind answers *which application*, agent answers *who*. A
> **host** in this repository means the machine, never the application.

There are three layers, and it is worth keeping them straight:

1. **The skills** — `SKILL.md` + `references/` + a wrapper, copied (or, for the board
   skill, symlinked) into the agent's skill directory by `install.sh`. This is
   deterministic, offline, and needs no agent tooling. The board skill is what makes the
   agent able to drive `taskctl`; the loop skill carries the decisions the loop applies,
   and the loop itself runs as `taskctl loop …`.
2. **The agent bundle** (Claude Code and Codex) — `install.sh --target claude|codex`
   deploys the rest of that agent's setup too, not just the skill: the agent config
   (`~/.claude/settings.json` / `~/.codex/AGENTS.md`), slash commands (Claude)
   or the scheduling units (Codex), and a `taskctl` shim that pins the agent identity. Writes
   are **merge-style and idempotent**: a repeat install **exits 0**, leaves every managed
   file and config key at its existing value, and prints a
   `left unchanged — use --force to overwrite` notice; `--force` is the *only* way to
   overwrite. See [Idempotence](#idempotence-re-running-and-force).
3. **The plugin/bundle** — the manifest that lets the agent's own plugin system discover
   and enable the skill. This step needs that agent's CLI, so `install.sh` does **not** run
   it; it prints the command and you run it once. The repository root *is* the board's
   plugin root (`.claude-plugin/plugin.json`), which is what lets every harness share the
   one `skills/` tree instead of receiving a copy. The marketplace has a single entry —
   `meerkat-taskpanel`, sourced at `./`. `meerkat-loop` and `setup-meerkat` are **not**
   separate marketplace plugins: the root bundle carries them from the same tree, and
   `install.sh` copies them into an agent's skill directory (the loop for the three
   non-OpenClaw agents, the setup command for Claude).

> **Status: the engine has landed in full.** The skill is discoverable, the `taskctl`
> commands it describes are implemented, and the board backend (`src/server/`, HTTP + SSE)
> plus the `web/` frontend are in place. See `CLAUDE.md` for what is still planned (the
> Epic view and iteration management).

## Install methods

Two entry points drive **one** materializer, so an npm install and a source install produce
the same tree, the same launchers and the same config file.

### npm / npx (preferred)

```bash
npx meerkat-taskpanel                                    # server + taskctl + every agent-kind skill
npm install -g meerkat-taskpanel                         # or install the package globally …
meerkat-taskpanel install                                # … and run the installer whenever needed
npx meerkat-taskpanel install --target server            # server runtime + taskctl only
npx meerkat-taskpanel install --target claude,server,pi  # server + those two agents
npx meerkat-taskpanel install --no-server                # agent-kind skills only
```

With no subcommand, `install` is assumed. The wrapper ships inside the package, so `npx`
needs `meerkat-taskpanel` to be published (see [`publishing.md`](publishing.md)) — it fetches
nothing else. The published tarball carries the built `web/dist`, so the installed board
serves its UI with no build step.

### From a source checkout

```bash
bash install.sh --target all                # server + the skill for every agent (the default)
bash install.sh --target claude,server,pi   # server + those two agents
bash install.sh --target all --no-server    # the agent-kind skills, no server
bash install.sh --target server             # server runtime + taskctl only
bash install.sh --target claude             # one agent, no server
```

`all` is every agent **plus** the server; `--no-server` leaves the server out, and an
explicit comma list selects exactly the targets named. From a checkout, `web/dist` is
copied if present; if it is absent and `web/node_modules` exists the installer builds it;
otherwise it warns and installs an API-only server (it never runs `npm ci`).

### The server tree

The server target materializes a self-contained runtime at `<home>/.meerkat-taskpanel`
(`<home>` is `$HOME`, or `--prefix`):

```text
~/.meerkat-taskpanel/
├── src/**                # the whole program, migrations included
├── web/dist/**           # the built board (API-only if it could not be produced)
├── package.json
├── bin/taskd             # 0755 launcher: exec node <tree>/src/server/main.mjs
├── bin/taskctl           # 0755 launcher: exec node <tree>/src/cli/index.mjs
├── .env                  # 0600, seeded from the template; never overwritten
└── .data/                # 0700, the SQLite board; never deleted
```

The tree is self-locating: `src/` resolves `.env`, `.data` and `web/dist` from its own
position, so `bin/taskd` and `bin/taskctl` work from any directory and with no environment
variables. Add `~/.meerkat-taskpanel/bin` to `PATH`, or use `npm install -g`.

When the server is installed alongside agent-kind skills (the default, and every npm/npx
install), the agent shim and loop config (`MEERKAT_TASKPANEL_REPO`,
`MEERKAT_TASKPANEL_ENV_FILE`) point at this tree, never at the npx cache or the checkout,
and the `taskd` guard's unit runs the tree's `src/server/main.mjs` with
`TASKD_DATA_DIR=<tree>/.data`. An agent-only install (`--no-server`) is unchanged: it keeps
pointing at the checkout.

The installer is **idempotent**: a re-run exits 0 and leaves `.env` and `.data` byte-for-byte
alone; `src/` and the launchers are refreshed. `--force` additionally prunes stale files
under `src/` (it still never touches `.env` or `.data`); `--dry-run` writes nothing.

### Upgrading and removing

Upgrade by running the installer again (`--force` to refresh managed files). To remove,
delete the agent-kind skill directories listed below and the tree itself; **keep `.data/` if you
want the board**: `rm -rf ~/.meerkat-taskpanel` deletes the database with it.

## Quick start (agent-kind skills)

```bash
bash install.sh --target all --agent-name "$USER"   # everything; full bundle for claude+codex
bash install.sh --target claude --link --agent-name alice  # or one agent, symlinked, named alice
```

Then register the plugin/bundle for the agents you use (one command each — see
[Per-agent-kind steps](#per-agent-kind-steps)). `--agent-name` names the agent on the board and must
match the assignee the board uses for it; it defaults to `$USER`.

## Where things land

| Agent | `--target` | Board skill | Loop skill | Bundle |
|---|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/meerkat-taskpanel` | `~/.claude/skills/meerkat-loop` | `.` — the repository root (`.claude-plugin/plugin.json`) |
| OpenClaw | `openclaw` | `~/.openclaw/skills/meerkat-taskpanel` | **none** — see [OpenClaw](scheduling.md#openclaw-do-not-build-a-supervisor) | `.` — the same root bundle |
| Codex | `codex` | `~/.codex/skills/meerkat-taskpanel` | `~/.codex/skills/meerkat-loop` | `.` — the same root bundle, through the marketplace |
| Pi / Agent Skills | `pi` | `~/.agents/skills/meerkat-taskpanel` | `~/.agents/skills/meerkat-loop` | `.` — the root `package.json`'s `pi` field |

The **setup skill** is an extra row with no column of its own: `install.sh --target claude`
copies `setup-meerkat` to `~/.claude/skills/setup-meerkat`, and no other target copies it.
The repository bundle and marketplace still expose it, so another agent kind can read it in
place; the bash installer just does not put a second copy on disk for them.

The repository-root Claude marketplace `.claude-plugin/marketplace.json` lists a single
plugin, `./` (the board); Codex reads the same marketplace manifest, which is why it has no
bundle of its own.

Every agent above has both routes: a `--target` that lands the skill on disk, and a
plugin/bundle that agent's own plugin system reads in place.

`--link` applies to the **board** skill only. The loop skill is always copied: it is small
and standalone (docs plus decisions), and a symlink would put a checkout into the load path
of a skill that is meant to read the same in every install. The loop's execution body is not
in the skill at all — it is `taskctl loop …`, shipped with the runtime tree.

**Every agent kind gets a `taskctl` shim**, at `<agent-dir>/bin/taskctl`
(`~/.claude/bin/taskctl`, `~/.codex/bin/taskctl`, `~/.agents/bin/taskctl`, …), and it injects
**both halves of the identity** on every call — `--agent <name>` and `--actor-kind <kind>` —
with `TASKCTL_AGENT` / `TASKCTL_ACTOR_KIND` as the fallbacks. It is not the supervisor and
not a scheduling unit: it is one wrapper around a command the agent already runs itself,
which is why every agent kind — including OpenClaw, which has no loop — gets it.
Without it a write from that agent kind carries a name and no kind, and the board reads a write
with no kind as a **person's** — which is what would put it on the record as a decision.

The two bundle agent kinds write more than the skill. **Claude** additionally writes
`~/.claude/settings.json` (merged `env.TASKCTL_AGENT`, `env.TASKCTL_ACTOR_KIND`,
`env.TASKCTL_HUMAN` + a `SessionStart` hook),
`~/.claude/hooks/meerkat-taskpanel-session-start.sh`, `~/.claude/commands/{board,claim,deliver}.md`
and `~/.claude/bin/taskctl`. **Codex** writes `~/.codex/AGENTS.md` (a claim-first snippet),
the scheduling units under `~/.codex/scheduling/`, and `~/.codex/bin/taskctl`.
(Their shims are the same file described above — every agent kind gets one.)

The kind is not decoration. It is what the board reads to tell a person from an agent:
a human's comment resumes an `awaiting` card (any kind), and a `decision` / `confirm` /
`change` is what goes on the record (I5) and what the patrol counts as the leader acting.
A shim that set only the name recorded every agent write as a human's.

`--as-human` is the other direction — the one write an agent makes in the user's voice,
signing with `TASKCTL_HUMAN` instead of itself. `--actor-kind human` is refused: it is the
value every one of those decisions turns on, so a caller may not declare it.

### The local `projects.json` (beside the skill)

The board holds no project directories, so the local map from a **directory** to a
**board project** — and from a project to the directory its **workers** run in — is a
`projects.json` created **inside the installed skill directory**, next to `SKILL.md` —
`~/.claude/skills/meerkat-taskpanel/projects.json` for Claude Code, and the matching
skill directory for each other agent kind. The skill's own reference,
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
| loop skill | `<agent-dir>/skills/meerkat-loop/` | the loop as a skill: its `SKILL.md` and `references/`. The execution body is `taskctl loop …` in the runtime tree, not a copy. Always **copied**, never symlinked |
| loop state | `<agent-dir>/meerkat-taskpanel/` | the loop's runtime state — queue, ledger, locks, `sessions.state.json`, `continue.state.json`, `supervisor.log` (see [`scheduling.md §The loop's state directory`](scheduling.md#the-loops-state-directory)) |
| launchd | `<agent-dir>/scheduling/launchd/com.meerkat-taskpanel.{session,ping,continue,subscribe}.plist` | `KeepAlive` for the resident pool and the event subscriber; `StartInterval` 60 / 600 for the two clocks |
| systemd | `<agent-dir>/scheduling/systemd/meerkat-taskpanel-{session,ping,continue,subscribe}.{service,timer}` | `Type=simple` + `Restart=always` for the pool and subscriber; 60s / 600s timers for the clocks |
| cron | `<agent-dir>/scheduling/cron/meerkat-taskpanel.cron` | `* * * * *` ping, `*/10 * * * *` continue — **no pool**: no worker dispatch |

Each unit names the **absolute `node`** that rendered it and carries a **`PATH`** holding
the agent CLI's directory and node's ahead of the scheduler's own default. Neither is
optional: a scheduler starts a unit with a minimal `PATH` that holds no nvm and no Homebrew
directory, so `/usr/bin/env node` is exit 127 — and the resident session's `exec claude`,
and the worker's own tool tree, resolve on that same set. If the agent CLI is not on `PATH` at
install time, the installer says so and renders node's directory alone rather than guessing.
See [`scheduling.md` §What the loop's units run with](scheduling.md#what-the-loops-units-run-with).
| agent config | `<agent-dir>/meerkat-taskpanel.env` | `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes\|no`, `MEERKAT_TASKPANEL_RECOVER_STALE=yes\|no`, `MEERKAT_TASKPANEL_REPO=<checkout>` (where the board engine the executor drives lives), the workflow channel's `MEERKAT_TASKPANEL_WORKFLOW` and `MEERKAT_TASKPANEL_REVIEWER`, the clocks' `MEERKAT_TASKPANEL_PING_INTERVAL`, `MEERKAT_TASKPANEL_CONTINUE_INTERVAL` and `MEERKAT_TASKPANEL_CONTINUE`, the concurrency cap's `MEERKAT_TASKPANEL_MAX_CONCURRENCY`, and the pool's `MEERKAT_TASKPANEL_RESIDENT`, `..._SESSION_MAX_AGE`, `..._SESSION_TURN_TIMEOUT`, `..._SESSION_POLL_MS`, `..._SESSION_POOL_MAX`, `..._PROJECT_CONCURRENCY` and `..._PROJECT_IDLE_MS`. Full tool access is off unless both `MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS=yes` and `..._ALLOW_ALL_TOOLS_REASON="…"` are set |
| log (runtime) | `<agent-dir>/meerkat-taskpanel/supervisor.log` | the supervisor's tick log |
| state (runtime) | `<agent-dir>/meerkat-taskpanel/supervisor.state.json` | the running registry (legacy one-shot path) |
| state (runtime) | `<agent-dir>/meerkat-taskpanel/{sessions,subagents}.state.json` | the resident pool's session ids + heartbeat, and the subagent ledger |
| state (runtime) | `<agent-dir>/meerkat-taskpanel/subscribe.state.json` | the event daemon's pid, last connection/event and pending reconnect — what `--supervisor=status` reports |

`<agent-dir>` is `~/.claude`, `~/.codex` or `~/.agents`. **OpenClaw gets none of these, and no
`meerkat-loop` skill** — it installs the board skill only and uses the
[openclaw-team](https://github.com/tanyu216/openclaw-team) framework's own
`poll`/`patrol` instead (see [`scheduling.md`](scheduling.md#openclaw-do-not-build-a-supervisor)).

**Load one of them to start the supervisor** — this is the **manual** path, and a plain
install stops here (nothing is loaded for you):

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.session.plist  # the resident pool
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist    # and .continue.plist + .subscribe.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-subscribe.service
# Anywhere — no long-lived process, so patrol + workflow only (no worker dispatch)
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

`--supervisor=enable` is the **opt-in** path that runs the right one of these for you —
see [Enabling the supervisor (opt-in)](#enabling-the-supervisor-opt-in) below.

### Enabling the supervisor (opt-in)

A plain install **writes** the units above and prints the load command — it never loads
anything. Starting the daemon is a separate, **explicit request**, and it is one flag:

```bash
bash install.sh --target all --supervisor=enable                # enable every non-OpenClaw loop agent kind
bash install.sh --supervisor=enable --supervisor-actor-kinds claude   # …just one agent kind
bash install.sh --supervisor=status                             # what is loaded right now
bash install.sh --supervisor=disable --supervisor-actor-kinds claude  # stop and remove it
```

**Per-agent-kind selection is `--supervisor-actor-kinds claude,codex,pi`** — a
subset of the loop actor kinds the install covers (default: the loop actor kinds present in
`--target`). The flag selects *which* kinds an action applies to, rather than naming the kind
the installer itself runs as, which is why it is not called `--actor-kind` here: that name is
the per-command identity flag (`taskctl loop … --actor-kind claude|codex|pi`).
**`openclaw` is rejected** in this list (reason on stderr, exit 2) — it has no loop
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
agent kind requires disabling the first, so the installer never leaves two loaded. `--dry-run`
always wins: with it, `--supervisor=enable` prints the exact commands it would run and
changes nothing. On success the installer reports what it enabled **and how to stop it**:

```text
supervisor: enabled (kind=claude, scheduler=launchd, units=com.meerkat-taskpanel.<agent>.claude.session,.ping,.continue,.subscribe)
to disable:  install.sh --supervisor=disable --supervisor-actor-kinds claude
```

Enabling installs the resident pool, the two clocks **and the event daemon**: a long-lived
`taskctl loop session` manager, a $0 ping, one bounded `Continue` judgment turn per continue cadence
that the pool runs in its control session, and the `taskctl loop subscribe` daemon on launchd/systemd.
The daemon is part of that set, not a separate flag: it is the low-latency path, the
continue cadence remains the fallback, and an event wakes a turn only while the pool is
live. It is not a closure component — with no pool it skips the turn and the timer still
runs patrol + workflow — and `--supervisor=status` reports whether it is `streaming`,
`reconnecting` or `not running` from `subscribe.state.json`. To run without it, disable that
one unit in the service manager; `--event-continue=no` is the runtime soft-off. Inside that turn the poll is still the
$0 local scan; it claims and enqueues, and the project session spawns the
subagent — so a worker turn still starts only when a claim succeeded (see
[`scheduling.md §The cost gate`](scheduling.md#the-cost-gate-a-worker-turn-starts-only-on-fire)).
A cron install has no pool; it runs the clocks only, and dispatch stays paused.

The exact per-OS commands, their failure modes, and the `loginctl enable-linger` caveat are
in [`scheduling.md §Enabling the supervisor (opt-in)`](scheduling.md#enabling-the-supervisor-opt-in).

An enable that the OS refuses — a `launchctl bootstrap` with no GUI session, a
`systemctl --user` with no D-Bus — is **reported, not disguised**: the install prints
`supervisor: not enabled (…)` with the reason and the exact command to run by hand, and
still exits 0, because the agent's skills are installed either way and an OS-level refusal
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
`<agent-dir>/scheduling/`, so re-installing an agent kind's loop units never touches it:

```text
<prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
<prefix>/taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service
```

`<prefix>` is `--prefix` (default `$HOME`). There is **one guard per machine** — and
therefore **one guarded board** — not one per agent kind: the label and unit name carry
no agent or actor-kind segment, and which board it serves is chosen at install time. See
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

**Which program the unit runs.** With the server target selected (`--target server` /
`all`, which includes it, and always for an npm/npx install unless `--no-server`), the unit
runs the installed tree's
`src/server/main.mjs` with `TASKD_DATA_DIR=<home>/.meerkat-taskpanel/.data` pinned in its
environment — so the guarded board is the installed one, not whatever checkout you happened
to install from, and it keeps working after the checkout moves or the npx cache is pruned.
Without the server target the unit runs the checkout's `src/server/main.mjs` and leaves the
data directory to the normal config chain. A unit written for one layout does not match the
other, so re-pointing an agent-only install at a server install (or back) is a deliberate
`--force`.

**A second board does not inherit the guard.** The guard is one per machine
([`scheduling.md § One guard per machine`](scheduling.md#one-guard-per-machine)), so a
re-install for a *different* board is refused rather than silently re-pointing the machine's
only guard (on Linux, systemd reads `~/.config/systemd/user/meerkat-taskpanel-taskd.service`
and that file is the guard). The refusal names both boards, leaves the unit alone, and is
the install's one non-zero guard outcome — **exit 3**, which `install.sh` reports and then
carries on from (the agent-kind skills are installed either way, and the install's own exit status
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
form `MEERKAT_TASKPANEL_NO_AUTOMATION=1` — the variable `install.sh` sets for each agent kind
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

The answer is persisted to `<agent-dir>/meerkat-taskpanel.env` as
`MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes|no`; the supervisor reads it as its default (an
explicit `--claim-unassigned` flag or `$MEERKAT_TASKPANEL_CLAIM_UNASSIGNED` overrides it).
Non-interactive installs default to **yes**; `--claim-unassigned=no` /
`--assignee-only` persist `no`. **Stale recovery is a separate opt-out**:
`--recover-stale=no` (or `$MEERKAT_TASKPANEL_RECOVER_STALE=no`) persists
`MEERKAT_TASKPANEL_RECOVER_STALE=no`, and the supervisor then never takes over an
`in_progress` card — the same holder's 30-minute re-claim included. The file is merge-style: a re-run without
`--force` keeps the existing value, and it also records where the board engine
lives (`MEERKAT_TASKPANEL_REPO=<runtime tree>`) — a key the installer adds when it is
missing, so an install made before that key existed still learns it (see
[`scheduling.md §The loop's state directory`](scheduling.md#the-loops-state-directory)).

The same merge rule covers the workflow channel's two keys, written with their defaults when
the file is created and added only when missing on an upgrade:

```ini
MEERKAT_TASKPANEL_WORKFLOW=yes
MEERKAT_TASKPANEL_REVIEWER=
```

Acceptance is **not** install configuration any more: each project stores a default
(`auto | off | agent | human`) and each card a snapshot, both set through
`taskctl project update <id> --acceptance …` / `issue create --acceptance-mode …`.
The file is merged, never rewritten.

`MEERKAT_TASKPANEL_ENV_FILE` points the installer and both binaries at a different file (a
read-only package root, a container, or the test suite).

The SLA thresholds are seeded as a **commented** block in the same `.env` (every
`TASKD_SLA_*` key with its default). Uncomment a line to override it: `taskd` validates the
table and publishes it on `GET /api/v1/sla`, and the loop reads it on the next patrol pass —
no restart and no per-agent-kind copy. See [`sla.md §2.1`](sla.md#21-install-level-overrides).

`--reviewer` (or `MEERKAT_TASKPANEL_REVIEWER`) is what turns review dispatch on. With it
unset the supervisor still reconciles containers and applies verdicts already in flight —
it simply creates no new review cards, and deliveries wait for a human.
[`scheduling.md §The workflow channel`](scheduling.md#the-workflow-channel-review-acceptance-and-containers)
is the full contract.

## install.sh reference

```text
install.sh [--target claude|openclaw|codex|pi|server|all] [--prefix <home>]
           [--agent-name <name>] [--no-automation]
           [--claim-unassigned=yes|no] [--assignee-only] [--recover-stale=yes|no]
           [--workflow=yes|no] [--reviewer <agent>]
           [--ping-interval <sec>] [--continue-interval <sec>] [--continue=yes|no]
           [--supervisor=enable|disable|status] [--supervisor-actor-kinds <list>]
           [--scheduler auto|launchd|systemd|cron]
           [--link] [--force] [--dry-run] [--skip-node-check] [--skip-web-build] [-h|--help]
```

| Flag | Effect |
|---|---|
| `--target <agent-kind>` | Which agent kind(s) to install for, or `server` for the runtime tree. Default `all` — every agent plus the server. Repeatable, and a comma-separated list (`--target claude,server,pi`) works too. `--no-server` removes the server from whatever the selection resolves to. |
| `--no-server` | Install the agent-kind skills only, leaving the runtime tree out (`--target all --no-server` is the old `all`). |
| `--prefix <home>` | Install relative to `<home>` instead of `$HOME`; the server tree lands at `<home>/.meerkat-taskpanel`. |
| `--skip-web-build` | Never try to build `web/dist`. A server install without a prebuilt `web/dist` is then API-only (with a warning) instead of building it. |
| `--agent-name <name>` | The agent's identity on the board, written into the claude/codex bundle (default `$USER`). Must equal the board assignee for the agent to claim cards. |
| `--no-automation` | Skip the Codex scheduling units **and** the `taskd` keepalive guard; the Claude/OpenClaw/Pi skill bundles are otherwise unaffected. |
| `MEERKAT_TASKPANEL_NO_AUTOMATION=1` | The environment form of the `--no-automation` bypass — `install.sh` sets exactly this variable for each agent-kind installer, and `scripts/install/_common.sh` reads it, so a direct installer run honours it too. Internal bypass, not a user option. |
| `--claim-unassigned=yes\|no` | May the supervisor claim **unassigned** cards (the public pool)? Persisted to `<home>/<agent-dir>/meerkat-taskpanel.env`; overrides the interactive answer. Default `yes`. |
| `--assignee-only` | Alias for `--claim-unassigned=no`. |
| `--recover-stale=yes\|no` | May the supervisor recover stale `in_progress` claims — the same holder after 30 minutes, any agent after 6 hours? Persisted to the agent config; default `yes`. |
| `--workflow=yes\|no` | Run the supervisor's workflow sub-pass — ask the board for the workflow plan (`issue reconcile --workflow`) and apply its review actions. Persisted to the agent config; default `yes`. `no` means the loop writes no card at all. |
| `--reviewer <agent>` | The independent agent that reviews delivered cards. Persisted to the agent config. Unset (the default) disables **dispatch** only; a delivery then waits for a human to accept it. |
| `--ping-interval <sec>` | The liveness clock, rendered into the units; default `60`. It only prunes dead worker pids — no board read, no LLM. |
| `--continue-interval <sec>` | The judgment clock, rendered into the units; default `600` (10 minutes). It wakes the agent kind with a bounded `Continue` prompt; that turn runs poll, patrol and workflow. |
| `--continue=yes\|no` | Enable the continue turn. Persisted to the agent config; default `yes`. `no` keeps the ping clock but discovers no work until a human runs the poll entry. |
| `--supervisor=enable\|disable\|status` | Opt-in control of the supervisor **daemon** (the units above): `enable` loads/enables it, `disable` unloads/removes it, `status` prints the per-agent-kind load state and changes nothing. Off by default — a plain install still only *prints* the load command. Aliases: `--enable-supervisor`, `--disable-supervisor`, `--supervisor-status`. See [Enabling the supervisor (opt-in)](#enabling-the-supervisor-opt-in). |
| `--supervisor-actor-kinds <list>` | Which loop agent kinds the `--supervisor` action applies to — a comma list ⊆ `{claude,codex,pi}` (default: the loop actor kinds present in `--target`). Not `--actor-kind`: that is the loop's per-command identity flag, and this flag selects a set. `openclaw` is **rejected** (reason on stderr, exit 2). |
| `--scheduler <auto\|launchd\|systemd\|cron>` | Which mechanism the `--supervisor` action acts on (default `auto`: launchd on macOS, systemd on Linux, cron elsewhere). Only one mechanism may be loaded per agent kind — see [`scheduling.md §Enabling the supervisor (opt-in)`](scheduling.md#enabling-the-supervisor-opt-in). |
| `MEERKAT_TASKPANEL_SUPERVISOR=enable\|disable\|status` | The non-interactive form of `--supervisor` (an explicit flag wins) — the same precedence style as `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED`. |
| `--link` | Symlink the **board** skill instead of copying it — edits to the repo take effect immediately. Recommended for a checkout. The `meerkat-loop` skill is always copied (it is standalone docs + decisions). For `--target server` it only warns: the runtime tree is always copied, because it must survive the checkout and the npx cache. |
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
runs from `scripts/install/_common.sh`, so a direct `scripts/install/<agent-dir>.sh` invocation
is guarded too.

`install.sh` is a thin dispatcher: it parses the flags once, then runs
`scripts/install/<actor-kind>.sh` for each target and prints a per-agent-kind summary. It
exits non-zero if any agent kind failed, and each failure names the destination and the fix.

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
bash install.sh --target all                           # full install: runtime tree + every agent
bash install.sh --target server --skip-web-build       # API-only server, no frontend build
```

## Per-agent-kind steps

### Claude Code

```bash
# 1. skill + agent bundle (settings.json, slash commands, shim)
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
`~/.claude/bin/taskctl`, and the scheduling set (`~/.claude/scheduling/*` and
`~/.claude/meerkat-taskpanel.env`). Re-running is safe: existing
`settings.json` keys and hooks are preserved, and `--force` is the only way to overwrite.

Uninstall:

```bash
claude plugin uninstall meerkat-loop@meerkat-taskpanel-marketplace   # if you installed it
claude plugin uninstall meerkat-taskpanel@meerkat-taskpanel-marketplace
claude plugin marketplace remove meerkat-taskpanel-marketplace
rm -rf ~/.claude/skills/meerkat-taskpanel ~/.claude/skills/meerkat-loop \
       ~/.claude/skills/setup-meerkat \
       ~/.claude/commands/{board,claim,deliver}.md \
       ~/.claude/hooks/meerkat-taskpanel-session-start.sh ~/.claude/bin/taskctl \
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
Bundle format: claude
Bundle capabilities: skills
```

**Why `claude`?** The repository root carries `.claude-plugin/`, and OpenClaw's detection
precedence is **codex → cursor → claude**; with no Codex or Cursor marker present, the root
is reported as a claude bundle.

> **No supervisor for OpenClaw.** Unlike the other three agent kinds, OpenClaw gets **no**
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
# 1. skill + agent bundle (AGENTS.md snippet, scheduling units, shim)
bash install.sh --target codex --link --agent-name alice

# 2. plugin
codex plugin marketplace add "$PWD"
codex plugin add meerkat-taskpanel@meerkat-taskpanel-marketplace

# verify
codex plugin list
```

Step 1 writes, merge-style and idempotently: the skill, a claim-first snippet appended to
`~/.codex/AGENTS.md` (existing content is preserved), the `taskctl` shim at
`~/.codex/bin/taskctl`, and the scheduling set (`~/.codex/scheduling/*` and
`~/.codex/meerkat-taskpanel.env`). Codex has no hooks, so scheduling is the auto-claim
mechanism — load one of the units (see
[Scheduling units](#scheduling-units-claude-codex-pi)). `--no-automation` (or its environment
form `MEERKAT_TASKPANEL_NO_AUTOMATION=1`) skips the scheduling set.

Uninstall:

```bash
codex plugin remove meerkat-taskpanel
codex plugin marketplace remove meerkat-taskpanel-marketplace
rm -rf ~/.codex/skills/meerkat-taskpanel ~/.codex/skills/meerkat-loop \
       ~/.codex/bin/taskctl \
       ~/.codex/scheduling ~/.codex/meerkat-taskpanel.env ~/.codex/meerkat-taskpanel
```

### Pi / Agent Skills

```bash
# 1. skill + scheduling set (units, ~/.agents/meerkat-taskpanel.env)
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
`~/.agents/scheduling/`; load one of them to run the supervisor (see
[Scheduling units](#scheduling-units-claude-codex-pi)).

The loop dispatches one subagent per card, and Pi has no native subagent mechanism. A Pi
host therefore needs an extension; the installer checks
`~/.pi/agent/extensions/subagent` and prints the recommended command when it is missing:

```bash
pi install npm:pi-subagents
```

Install it before enabling the supervisor. Without it the project session can start, but it
cannot spawn the worker/reviewer subagents, so cards are never worked.

Uninstall:

```bash
pi remove "$PWD"
rm -rf ~/.agents/skills/meerkat-taskpanel ~/.agents/skills/meerkat-loop \
       ~/.agents/scheduling ~/.agents/meerkat-taskpanel.env
```

## Agent integration: skill only

> **The MCP integration has been removed — agent integration is skill-only.** The stdio
> MCP server and its `meerkat-taskpanel-mcp` bin are gone. An agent kind left with an MCP
> registration should drop it — `claude mcp remove meerkat-taskpanel`, `codex mcp remove
> meerkat-taskpanel`, or the matching entry in OpenClaw's or Pi's MCP configuration. No
> replacement is needed: the skill drives the `taskctl` CLI directly.

The installed skill is self-contained but carries **no engine**: `install.sh` copies
`SKILL.md`, `references/` and `scripts/` into the agent directory, never `src/`. So the wrapper
`scripts/run.mjs` resolves the CLI on a ladder — a checkout named by
`MEERKAT_TASKPANEL_ROOT` (or by `MEERKAT_TASKPANEL_REPO`, the key the installer records in
the agent config), then a checkout around the skill itself, then **the agent kind's own `taskctl`
shim** beside the skill, then `taskctl` on `PATH` — and when none of those holds a CLI it
stops with the ways to fix it, instead of the module-not-found stack an earlier version died
with (T-20261014-214002). In the normal case it is the shim that answers: `install.sh` writes
it into the agent kind's own `bin/` (`~/.claude/bin/taskctl`, `~/.codex/bin/taskctl`, …), and the
ladder finds it **without** `PATH` having to include that directory — one fewer thing to get
right, and the rung that carries the identity. Putting the directory on `PATH` also works,
as does `npm link` or a global install.

## Verifying the install

**Everything that runs is verified inside the container** (see
[`docker.md`](docker.md) and ARCHITECTURE §9.1): the four agent CLIs are not installed in
the image and there is no network, so the container asserts each agent kind's *detection
contract* offline instead.

```bash
npm run verify:docker                     # the full container suite, all four agent kinds
```

That run includes `scripts/verify/profiles.mjs`, which for each agent kind installs into a
throwaway home and asserts: the skill lands at the agent kind's destination, `SKILL.md`
frontmatter still names `meerkat-taskpanel`, the wrapper resolves back to this checkout, the
manifest parses, and the bundle is recognized with a loadable skill. Run one agent kind
on its own with:

```bash
node scripts/verify/profiles.mjs --actor-kind openclaw
```

### Supplementary: the real agent CLIs

When the agent CLIs *are* present (a developer machine, never CI), the same four steps are
driven for real, each in a throwaway `HOME`, touching no network:

```bash
node scripts/verify/kind-cli.mjs            # all agent kinds; absent CLIs are SKIPPED
node scripts/verify/kind-cli.mjs --actor-kind openclaw
```

This is a cross-check that the offline detection rules match what the real CLI does — it
is supplementary, not the acceptance evidence.

### The runtime claim path (offline mock harness)

`profiles.mjs` proves the bundle *installed*; it never runs what the install generated.
`scripts/verify/kind-runtime.mjs` does — offline, with no agent CLI and no board:

```bash
node scripts/verify/kind-runtime.mjs            # all agent kinds; exit 0 only if every assert passes
node scripts/verify/kind-runtime.mjs --actor-kind claude
```

It installs into a throwaway prefix (never `$HOME`), replaces the generated `taskctl`
shim with a canned one — it records every argv — then drives the generated SessionStart
hook, asserting the **actual invocation** (exit code + argv + output), not just "it ran".
This is the step that covers the claim path in CI, where the real CLIs are absent. The full
matrix and the per-agent-kind coverage boundary (Pi has no hook) are in
[`scheduling.md`](scheduling.md#verifying-the-generated-hook).

## Isolated installs and testing

Nothing is ever written outside the destination paths in the table above. To install
without touching a real user home — for a test, or a CI assert — use a throwaway home.
The bundle agent kinds write their config, commands and trigger into the same home, so the whole
bundle stays isolated:

```bash
bash install.sh --target all --prefix /tmp/tp-home
MEERKAT_TASKPANEL_TARGET_HOME=/tmp/tp-home bash scripts/install/claude.sh   # env equivalent
```

The agent CLIs honour their own config-directory variables, so a fully isolated plugin
install is possible too:

```bash
HOME=/tmp/tp-home CLAUDE_CONFIG_DIR=/tmp/tp-home/.claude claude plugin marketplace add "$PWD"
HOME=/tmp/tp-home CODEX_HOME=/tmp/tp-home/.codex codex plugin marketplace add "$PWD"
```

## Uninstalling

Each agent kind's section above lists the plugin/bundle removal command. The skills themselves
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
- **An older install still has `skills/meerkat-loop/scripts/`, `templates/` or
  `manifest.txt`** — those were the generated payload, retired when the loop moved into
  `taskctl`. Re-run the install with `--force` to replace the skill directory; a re-run also
  removes the old copied body under `<agent-dir>/meerkat-taskpanel/scripts/`.
- **OpenClaw does not list the plugin** — install the bundle at the repository root
  (`openclaw plugins install "$PWD" ...`); see the OpenClaw section above.
