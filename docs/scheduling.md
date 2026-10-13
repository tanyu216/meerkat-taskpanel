# Scheduling & patrol

How a board gets worked **continuously** when the host that does the work has no
clock: the cheap scan, the atomic claim, the wake, and the slow patrol that
catches what the scan misses. The supervisor that runs the loop lives **outside**
the host — `scripts/supervisor.mjs`, which `install.sh` copies into the host out of
the **[`meerkat-loop`](../skills/meerkat-loop/SKILL.md) skill** — and the host is only
ever the worker that gets woken.

The loop is a skill of its own, and it is distributed as one: `claude`, `codex` and `pi`
install it, and OpenClaw deliberately does not (see
[OpenClaw: do not build a supervisor](#openclaw-do-not-build-a-supervisor)).

This is the design the OpenClaw host already ships as
[openclaw-team](https://github.com/tanyu216/openclaw-team) — a per-agent poll and a
`task-patrol`; this document is the host-agnostic statement of it, plus what
Claude Code, Codex and Pi add on top.

## The two layers

Two cadences, deliberately separate. One is fast and nearly free; the other is
slow and exists to notice what the fast one cannot.

| | **poll** | **patrol** |
|---|---|---|
| Cadence | 1 minute | 5 minutes (5–15 is the useful band) |
| Job | find new claimable work | find work that is *stuck* |
| Reads | `issue candidates` | `issue list --status in_progress` |
| On a hit | claim, then wake a worker | escalate — **no worker by default** |
| Cost of an empty tick | $0 (a local CLI read) | $0 |
| Why it exists | a card should start within a minute of becoming claimable | a crashed agent must not wedge a card, and a vanished heartbeat must not be silent |

Keeping them apart is the point. Folding patrol into the 1-minute poll would
mean re-reading every `in_progress` card 60 times an hour to find a handful of
stale ones; folding the poll into patrol would add up to five minutes of latency
to every start.

## The cost gate: a turn starts only on fire

Waking an LLM every minute burns money on the ~99% of ticks that find nothing.
So the scan is a **plain CLI process** — `taskctl issue candidates` — with no
model attached, and a model turn starts **only when the scan produced work and
the claim succeeded**:

```
tick
 ├─ scan        taskctl issue candidates …        → no candidates? stop. 0 workers spawned
 └─ candidates? ├─ claim  taskctl issue move … in_progress   → refused? stop. no worker
                └─ wake   claude -p "<handoff>" / codex exec  ← the only thing that costs tokens
```

A tick with nothing to do therefore costs one local subprocess. `--dry-run`
prints the plan and starts neither a claim nor a worker.

## Atomic claim = the single dispatch source

The board, not the supervisor, decides who gets a card. Moving a card to
`in_progress` is compare-and-swap in SQLite, so when several agents (or several
supervisor ticks) race the same card **exactly one claim succeeds**; every loser
gets a conflict and, crucially, **no worker is started**. That is what makes the
claim the *only* dispatch path — a supervisor never "reserves" a card out of band,
never wakes a worker for a card it did not win, and never claims success on a
failed spawn.

This is also why there is no supervisor lock file: the service model is
single-writer and the CAS already serialises dispatch. Two supervisors racing
each other is wasteful, not incorrect — the loser's claim is refused.

### Idempotent wake + a concurrency cap

Waking must be safe to repeat, or a re-run of a tick (or an overlapping cron
line) double-starts work. Two guards:

- **De-dup by card.** The supervisor keeps a small registry of running cards
  (`--state`, default `<host-dir>/meerkat-taskpanel/supervisor.state.json`: card →
  `{agent, pid, startedAt}`). A card already in the registry is never woken
  again; a card offered twice in one tick (the public pool, read by every agent)
  is claimed once.
- **Cap by count.** New wakes per tick are limited to
  `--max-concurrency − running` (default 8). A full fleet skips candidates rather
  than piling up.
- **Crash recovery.** On each tick the registry is pruned of pids that are gone,
  so a crashed worker releases its slot instead of pinning it forever.

## Fresh heartbeat is a no-op; a broken one is never silent

A claim carries a heartbeat. The board treats it as *fresh* for 10 minutes and
*same-holder-recoverable* after 30; these windows are shared with
[openclaw-team](https://github.com/tanyu216/openclaw-team).

| Heartbeat age | Meaning | What the supervisor does |
|---|---|---|
| ≤ 30 min | live | nothing — the poll will not see a claimable card, and patrol stays quiet |
| > 30 min | stale | patrol **escalates**: a log line and, if configured, `--notify <cmd>` |
| unreadable / absent | a corrupt or half-written claim | patrol reports it (`heartbeat-unreadable`) — **never** swallowed |

The last row is the fail-safe. A card whose heartbeat cannot be parsed is
exactly the state that used to disappear: it is neither fresh nor reliably
stale, so the supervisor surfaces it instead of guessing. Patrol does not start
an LLM turn by default — escalation is a notification, not a model call
(`--patrol-llm=yes` opts in).

## Continuity: a fresh handoff, not a resumed pile

Every wake hands the worker a **bounded, fresh handoff** built by
`buildHandoff()`: the card id and title, the exact `taskctl` commands to read and
deliver it, and the attribution flags
`--agent <name> --agent-platform <host> --session-id <id>`. The handoff is capped
(≈1–2 KB) so a wake never drags an unbounded context into the model. It names no
directory: the board holds none (O3), and the working directory is the host's
business — see [Where a worker runs](#where-a-worker-runs).

Continuity across wakes comes from the **board**, not the prompt: the card's
comments, reports and session record are durable, so a resumed conversation can
re-attach to the same work. When a session id is known, the wake adds the host's
own resume form: Claude resumes with `claude -p … --resume <sid>`, Codex with
`codex exec resume <sid> <prompt>`, and Pi with `pi --print --session <sid>
<prompt>`. These are the forms verified against the real CLIs (see
`scripts/verify/host-resume-matrix.mjs`). opencode is **not** a supported
`--host`, and its resume form was **not verified** (its CLI was not installed) —
nothing is promised about it here.

## Where a worker runs

A woken worker must run in the **target directory of the card's project** — the
checkout the work is actually about. The board cannot say which directory that is
(it holds no directories, O3), and neither can the supervisor: it knows a project
**identity** and nothing else.

So the directory is resolved **by the host, locally**, in the one piece of the chain
that lives on the host: the wake glue.

- The supervisor starts the worker *through* the glue
  (`<host-dir>/bin/wake-<host>.sh`) when one is installed, handing it the card's
  project identity in `TP_PROJECT` and the map path in `TP_PROJECTS_JSON`.
- The glue resolves that identity against the host-local `projects.json` beside the
  skill (`references/projects-json.md`), **validates** the result (absolute, exists,
  is a directory), `cd`s into it, and only then execs the host CLI.
- **If it cannot resolve, it refuses the wake** (exit 3, reason on stderr) and the
  card stays unwoken. There is no fallback directory: a session that runs in the
  wrong checkout produces confident, misplaced work, which is worse than no session.
- With **no glue installed**, the supervisor falls back to the host CLI directly,
  pins it to `--repo`, and logs an explicit warning that no target directory was
  resolved. That fallback is visible on every tick — never silent.
- An explicit **`--wake-command`** outranks both: an operator who supplies their
  own wake command chose it deliberately, so it is used verbatim (and still handed
  `TP_PROJECT` / `TP_PROJECTS_JSON` / `TP_NODE` if it wants them).

The same map answers the interactive question: `taskctl project dir <project>`
prints a project's registered directory, or exits non-zero asking which directory it
should be, rather than continuing.

## Where the supervisor runs

The loop cannot live inside the host, because Claude Code and Codex have **no
timers** — their hooks fire only on session events. So the loop lives outside:

| Option | Shape |
|---|---|
| `scripts/supervisor.mjs` (this repo) | standalone; `--once` for cron/launchd/systemd, or its own interval loop |
| the host-installed copy | what `install.sh` deploys, out of the [`meerkat-loop`](../skills/meerkat-loop/SKILL.md) skill: the body is copied under `<host-dir>/meerkat-taskpanel/`, and the scheduling units name *that* path |
| the local `taskd` process | a natural home for the same loop in a future milestone |
| [openclaw-team](https://github.com/tanyu216/openclaw-team) | on OpenClaw, the framework *is* the supervisor |

The host is just a worker: the supervisor claims on the board, then starts the
host's own headless entry point.

### The taskd guard (keepalive)

`taskd` — the board server, `src/server/main.mjs` — has an **OS-level keepalive**: the
supervisor restarts it after **any** exit (a crash, an `SIGKILL`, a non-zero exit). It
exists because `taskctl` *lazy-starts* `taskd` only when a CLI call needs it: a board
whose server dies while nobody is calling it would stay down until the next call, and
the guard removes that gap.

It is **not a scheduled tick**: there is no `StartInterval` and no `.timer`. It is the
single long-running process, and therefore the single owner of the data directory's
write lock (R1: one `taskd` per data directory).

> This is the board **server**'s guard, not the loop. It is separate from the table
> above, which asks where the *loop* might one day run; the guard answers only "keep
> `taskd` up". Enabling and stopping it is in
> [`install.md`](install.md#the-taskd-guard-enabled-by-default).

#### Where the unit lands (ownership separation)

```text
<prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
<prefix>/taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service
```

A **neutral** directory (`<prefix>` is `install.sh --prefix`, default `$HOME`),
deliberately **not** `<host-dir>/scheduling/` where the loop's `poll`/`patrol` units
live ([Scheduling units](install.md#scheduling-units-claude-codex-pi)). Re-installing a
host's loop units never touches this directory, and the two are never confused for one
another.

There is **one guard per machine** — per effective data directory — and **not** one per
host: the `Label` and the unit name carry no agent or host segment (unlike the loop's
`com.meerkat-taskpanel.poll` / `meerkat-taskpanel-patrol`), so installing for several
hosts does not multiply the guard.

The unit writes its stdout/stderr into `<dataDir>/logs/taskd.log` — the **same file the
lazy-start path uses**. `install.sh` creates `<dataDir>/logs` before writing the unit,
because neither scheduler creates a missing log directory.

#### launchd unit (macOS)

`{{SERVER_ENTRY}}` is the **absolute** `<repo>/src/server/main.mjs`; `{{LOG}}` is the
absolute `<dataDir>/logs/taskd.log`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Meerkat TaskPanel taskd guard — generated by `install.sh`.
     Keeps the board server (`src/server/main.mjs`) alive: launchd restarts it after
     ANY exit — a crash, a SIGKILL, or a clean shutdown. `KeepAlive` is unconditional,
     so `kill` alone cannot stop it; stop it for good with
     `launchctl bootout gui/$UID/com.meerkat-taskpanel.taskd`.

     This is NOT a scheduled tick (no StartInterval): it is the single long-running
     owner of the data directory's write lock (R1). `install.sh` writes this plist and
     loads it immediately. Logs append to the same file the lazy-start path uses. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.meerkat-taskpanel.taskd</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>{{SERVER_ENTRY}}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>{{LOG}}</string>
  <key>StandardErrorPath</key>
  <string>{{LOG}}</string>
</dict>
</plist>
```

- **`RunAtLoad`** — start the server as soon as the plist is loaded.
- **`KeepAlive` (`true`)** — restart it after it exits, *whatever* the reason. To stop
  the server for good you must remove the job
  (`launchctl bootout gui/$UID/com.meerkat-taskpanel.taskd`, or the older
  `launchctl unload -w <plist>`); a bare `kill` is undone immediately.
- **`ThrottleInterval` (`10`)** — launchd's own back-off: it will not restart the job
  more than once every 10 seconds, so a crash loop cannot spin (see
  [Robustness](#robustness)).
- **`StandardOutPath` / `StandardErrorPath`** — both point at the one runtime log.

#### systemd unit (Linux)

```ini
# Meerkat TaskPanel taskd guard — generated by `install.sh`.
#
# Keeps the board server (`src/server/main.mjs`) alive: systemd restarts it after
# ANY exit — a crash, a SIGKILL, or a clean shutdown. `Restart=always` is
# unconditional, so `kill` alone cannot stop it; `systemctl --user stop` stops it
# for good.
#
# This is NOT a scheduled tick (no .timer): it is the single long-running owner of
# the data directory's write lock (R1). `install.sh` copies this unit into
# ~/.config/systemd/user/ and enables it immediately.
#
#   mkdir -p ~/.config/systemd/user
#   cp <prefix>/taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service ~/.config/systemd/user/
#   systemctl --user enable --now meerkat-taskpanel-taskd.service
[Unit]
Description=Meerkat TaskPanel taskd (board server) guard
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/usr/bin/env node {{SERVER_ENTRY}}
Restart=always
RestartSec=5
StandardOutput=append:{{LOG}}
StandardError=append:{{LOG}}

[Install]
WantedBy=default.target
```

- **`Restart=always`** — restart the server after it exits, whatever the reason. Only an
  explicit `systemctl --user stop meerkat-taskpanel-taskd.service` stops it for good; a
  bare `kill` is undone.
- **`RestartSec=5`** — wait 5 seconds between restarts (systemd's own back-off).
- **`StartLimitIntervalSec=60` / `StartLimitBurst=5`** — at most 5 starts per 60 seconds.
  Past that the unit enters `failed` and systemd stops trying; clear it with
  `systemctl --user reset-failed meerkat-taskpanel-taskd.service` and start it again
  (see [Robustness](#robustness)). These live in `[Unit]`, not `[Service]`.
- **No `.timer`** — this is a long-running service, not a tick.

#### Enabling: written and loaded at install

The `taskd` guard is **enabled at install time**, with **no interactive question and no
user switch**. `install.sh` writes the unit and then loads/enables it:

```bash
# macOS
launchctl bootstrap gui/$UID <prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
#   (older systems: launchctl load -w <plist>)
# Linux (user unit)
mkdir -p ~/.config/systemd/user
cp <prefix>/taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-taskd.service
```

**This is an explicit exception**, and it is the *only* one, to the installer's standing
rule that it writes a unit and prints the load command but **never starts a daemon for
you**. It holds **only** for the `taskd` service guard: the `meerkat-loop` supervisor's
units are still written and left for the operator to load, and OpenClaw still gets none.

The install reports what it did, and how to undo it:

```text
taskd guard: enabled (com.meerkat-taskpanel.taskd, pid …)
```

To stop and remove the guard:

```bash
# macOS
launchctl bootout gui/$UID/com.meerkat-taskpanel.taskd
rm <prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
# Linux
systemctl --user disable --now meerkat-taskpanel-taskd.service
rm ~/.config/systemd/user/meerkat-taskpanel-taskd.service
```

Two **internal** bypasses exist; neither is a user option:

- `--dry-run` — writes and loads nothing; the report line becomes
  `taskd guard: skipped (dry-run)`.
- `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1` — **for tests only**; skips the guard so a
  CI or test install never loads a real unit.

`--no-automation` does **not** suppress the guard: that flag governs the host
supervisor's automation (the Codex claim trigger and the scheduling units), not the
board server.

#### Coexisting with `taskctl`'s lazy start

The guard and `taskctl`'s lazy start share one runtime pointer, one data directory and
one write lock, so they never fight over the slot:

- **The order is unchanged.** `taskctl` still resolves its board as *explicit `--url`* →
  *a healthy run pointer* → *lazy start* (unless `TASKD_NO_AUTOSTART` is set). A guarded
  `taskd` leaves a **healthy pointer**, so a CLI call reuses it and never starts a second
  server.
- **One slot.** Both use the same run pointer (the machine-wide default, or the same
  `TASKD_RUNTIME_POINTER`), the same data directory, and the same write lock. `pid`
  reuse through the pointer is tolerated by the transport's wait-for-pointer step.
- **The write lock (R1) still holds.** Only one `taskd` may own a data directory. If the
  guard is running, a CLI lazy-start loses cleanly (`BOARD_ALREADY_RUNNING`, non-zero
  exit); if the CLI started first, the guard's next start loses the same way — and the
  restart back-off (below) keeps that from becoming a storm.
- **The unit must not set `TASKD_NO_AUTOSTART`.** That is a *client* policy — it belongs
  to whoever calls `taskctl`, not to the server's own unit — and exporting it from the
  guard would mislead any CLI that inherited the environment.
- **The unit must not set `TASKD_PORT=0`.** A long-running guard needs a **stable**
  port: the default `9527`, or an explicit `TASKD_PORT`. `0` (an ephemeral port) is for
  the lazy-start and test paths only — a client that has lost the pointer cannot guess a
  random port to find the server again.
- **The data directory matches.** Both the unit and the CLI run `main.mjs` from the
  *same* checkout, so the default data directory (`<repo>/.data`) is the same by
  construction. If the operator sets `TASKD_DATA_DIR`, the unit must set **the same
  absolute path** in its environment, e.g.

  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>TASKD_DATA_DIR</key>
    <string>/abs/path/to/board-data</string>
  </dict>
  ```

  (systemd: an `Environment=TASKD_DATA_DIR=/abs/path/to/board-data` line under
  `[Service]`). The same applies to `TASKD_RUNTIME_POINTER`. Resolution stays single-sourced
  in `resolveDataDir` and `resolveRuntimePointerPath`, so there is one answer per process.
- **If something else already owns the slot**, the guard's `taskd` exits non-zero with
  `BOARD_ALREADY_RUNNING`, the supervisor restarts it, and the back-off below ends the
  retries. Stop the hand-started board first, or accept the unit going `failed`.

#### Robustness

- **Back-off and crash-loop protection are the supervisor's own** — launchd
  `ThrottleInterval=10`; systemd `RestartSec=5` with `StartLimitIntervalSec=60` /
  `StartLimitBurst=5`. The contract adds **no retry script of its own**. To recover a
  unit that systemd has put in `failed`:

  ```bash
  systemctl --user reset-failed meerkat-taskpanel-taskd.service
  systemctl --user start meerkat-taskpanel-taskd.service
  ```
- **Log rotation is the OS's job.** The unit appends to `<dataDir>/logs/taskd.log`, the
  same file the lazy start writes, both in append mode. The contract ships **no rotator**:
  on macOS, point `newsyslog` (or a user `logrotate`) at that file by size or time; on
  Linux, replace the two `StandardOutput=append:` / `StandardError=append:` lines with
  `StandardOutput=journal` / `StandardError=journal` and let journald own rotation.
- **One guard per machine**, per effective data directory — see
  [Where the unit lands](#where-the-unit-lands-ownership-separation).

### The loop body is installed, not referenced

`install.sh` **copies** the executor into the host rather than pointing a unit at
this checkout:

```text
<home>/<host-dir>/meerkat-taskpanel/
├── scripts/supervisor.mjs        the executor the units run
├── scripts/wake-cwd.mjs          what the wake glue calls to resolve a card's directory
├── src/shared/*.mjs              the modules those two import
├── supervisor.log                runtime
└── supervisor.state.json         runtime
```

The `scripts/` + `src/shared/` shape is load-bearing: `supervisor.mjs` imports
`../src/shared/scheduling.mjs`, and that module in turn imports `constants.mjs` and
`errors.mjs` (which imports `redact.mjs`). One file alone would leave a relative import
resolving to nothing, so the transitive closure travels with it.

**The list is not restated anywhere.** `scripts/sync-loop.mjs` computes the closure from
the body's two entry points (`scripts/supervisor.mjs` and `scripts/wake-cwd.mjs`) and
writes it into the loop skill as `body/manifest.txt`; the installer copies exactly what
that manifest lists, and `test/install/scheduling-units.test.mjs` proves the same list is
closed under its own imports. So the loop skill's payload is generated and guarded
(`node scripts/sync-skills.mjs --check`), and a new import cannot leave the installer, the
test, or a host's copy silently behind. The installer refreshes a differing copy only with
`--force` (merge, never clobber — the same contract as every other installed artefact),
and `--dry-run` reports which members would be refreshed.

The units, the wake glues and the host config are rendered from the **loop skill's own
templates** (`skills/meerkat-loop/templates/…`), not from a second copy under
`scripts/install/templates/` — the installer deploys what the loop distributes.

What that buys: a unit a user has already **loaded** names no checkout path, and the wake
glue resolves the card's directory through the host-local `scripts/wake-cwd.mjs` rather
than the checkout's — so moving, renaming or removing the checkout does not invalidate
either. Pointing the loop at a new location is a re-run of `install.sh`, with no
`launchctl` / `systemctl` / `crontab` reload.

What it does not buy (yet): the **board engine** still lives in the checkout. The copied
executor drives `taskctl`, and the shim that names it (`<host-dir>/bin/taskctl`) is
checkout-resident, so a moved checkout still needs `install.sh` re-run (or `--force`) for
that to follow. The host config records where the board is — `MEERKAT_TASKPANEL_REPO` in
`<host-dir>/meerkat-taskpanel.env` — which is what lets a host-installed executor find its
CLI at all. That one remaining dependency is named rather than hidden: the loop skill's
`references/operation.md` §"What the loop still needs from a checkout" is where it is
recorded, and the loop's interface requirement on the board (which release/interface
generation it drives) is declared in its `SKILL.md`.

## Headless permission boundary

A wake is **non-interactive**: the supervisor starts the worker with no human at
the keyboard to answer a prompt. An interactive host that stops to ask "may I run
this?" has no one to answer, so the worker must run under a **pre-declared
boundary** — a tool allowlist, a permission mode, or a sandbox — chosen up front
rather than confirmed per call.

The rule that follows from that is a **no-default-bypass** rule:

- The supervisor and the generated wake scripts **must not** run workers with
  permissions bypassed by default — no `claude --dangerously-skip-permissions`,
  no Codex `--dangerously-bypass-approvals-and-sandbox` (or equivalent), on by
  default. Neither the repo's `scripts/supervisor.mjs` nor the host wake glue
  (`wake-claude.sh`, `wake-codex.sh`, `wake-pi.sh`) ships such a flag.
- Turning a bypass **on** is a deliberate act that requires **explicit written
  authorization** and must be **documented at the point of use** — in the wake
  script or host config that carries it — so a reader can see the bypass, the
  reason, and who authorized it. An undocumented bypass is a bug, not a config.
- The recommended mechanism is a **narrow allowlist or sandbox**, not a blanket
  bypass:
  - **Claude Code** — `claude -p` with `--permission-mode` (e.g. `acceptEdits`
    or `plan`) plus `--allowedTools` naming the tools the worker may use, or a
    container / sandbox the turn runs inside.
  - **Codex** — `codex exec` with its sandbox and approval-policy flags (the
    non-interactive sandbox profile), rather than disabling approvals.

Prefer running the worker in a container or sandbox whose filesystem and network
reach are already bounded: for a `-p`/`exec` turn, the process boundary *is* the
permission boundary, and it does not depend on a human catching a prompt.

## The three hosts: how each one is triggered

Claude Code, Codex and Pi have no clock, and their wake surfaces differ. The
supervisor's `--host` selects the wake command; the rest (scan, claim, patrol,
registry) is identical.

| Host | Wake command | Trigger / scheduling | Continuity |
|---|---|---|---|
| **Claude Code** | `claude -p "<handoff>"` (headless) | external: launchd / systemd / cron running `supervisor.mjs --once`, or the supervisor's own loop | `claude -p … --resume <sid>` — resume the session that owns the card |
| **Codex** | `codex exec "<handoff>"` | external: the same units, or Codex app automation (`intervalMinutes`, `quotaAware`, `model`, `reasoningEffort`) | resume the thread with `codex exec resume <sid> <prompt>`; carry `$CODEX_THREAD_ID` as `--session-id` |
| **Pi** | `pi --print "<handoff>"` | external units + `wake-pi.sh` | resume with `pi --print --session <sid> <prompt>`; pass the session id through the handoff |
| **OpenClaw** | *n/a — no self-scheduler* | install **openclaw-team**; its `poll`/`patrol` automations are this design | the framework keeps the id stable across resumes |

(opencode is not a supported `--host`; its headless and resume forms were **not
verified** — its CLI was not installed — so this table promises nothing about it.)

The wake command column is what the *host CLI* is called with. When the host's glue
is installed, the supervisor starts **the glue** with that handoff and lets it set
the working directory first — see [Where a worker runs](#where-a-worker-runs).

Installers also install the **loop skill** itself, at `<host-dir>/skills/meerkat-loop/` —
the payload the units and glues are rendered from, and the operator's documentation for
running the loop. It is always a copy: `--link` names the board skill only.

Installers write per-host units under `<host-dir>/scheduling/{launchd,systemd,cron}`
and the wake glue at `<host-dir>/bin/wake-<host>.sh`, then **print the load
command** — they never enable a daemon or run `crontab` for you:

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.poll.plist   # and .patrol.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer
# Anywhere
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

### OpenClaw: do not build a supervisor

OpenClaw is the one host with a scheduler of its own. The
[openclaw-team](https://github.com/tanyu216/openclaw-team) framework already
implements exactly this pattern — a per-agent poll (its schedule *is* the trigger,
so an idle tick costs nothing) for the scan and a `task-patrol` for the stale pass.
Neither framework cadence is repeated here; the framework's `AUTOMATIONS.md` is the
single source of truth for it.
`install.sh --target openclaw` therefore installs the **board skill only**: no
`meerkat-loop` skill, no scheduler, no wake glue, no host config — permanently, by
ruling, not as a gap to be filled later. Two supervisors on one board would only race
each other for the same cards, and the board's claim is atomic, so the race is bounded
but the second supervisor is pure waste. Point OpenClaw at the framework instead:

```bash
git clone https://github.com/tanyu216/openclaw-team && cd openclaw-team
./install.sh --dry-run      # preview
./install.sh                # idempotent
```

Meerkat TaskPanel is that framework's default board, and its claim and candidate
criteria are kept in lockstep with openclaw-team's poll — which is the point.

## Running the supervisor

```bash
node scripts/supervisor.mjs --host claude --agent alice --once        # one tick, in the checkout
node scripts/supervisor.mjs --agent alice,bob --host codex            # loop
node scripts/supervisor.mjs --agent alice --dry-run --once            # plan only

node ~/.claude/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --once   # the installed copy
```

The flags are the same either way; the installed copy is what a loaded unit names, and it
takes the board's location from `MEERKAT_TASKPANEL_REPO` in the host config.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--host claude\|codex\|pi` | `claude` | which worker to wake |
| `--repo <path>` | this checkout — or, for a host-installed copy, the `MEERKAT_TASKPANEL_REPO` in the host config | repository root: what `--cli` is resolved from, and the fallback working directory |
| `--poll-interval <sec>` | `60` | loop cadence for the poll layer |
| `--patrol-interval <sec>` | `300` | loop cadence for the patrol layer |
| `--max-concurrency <n>` | `8` | cap on simultaneously running workers |
| `--claim-unassigned=yes\|no` | from host config → `yes` | also claim unassigned cards (the public pool) |
| `--assignee-only` | — | alias for `--claim-unassigned=no` |
| `--once` | off | one tick, then exit (for cron / launchd / systemd / tests) |
| `--patrol-only` | off | with `--once`, run only the patrol pass |
| `--patrol-llm=yes\|no` | `no` | let patrol start an LLM turn on a stale card |
| `--notify <cmd>` | — | run `<cmd>` with each patrol alert as JSON on stdin |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--log <path>` | `<home>/<host-dir>/meerkat-taskpanel/supervisor.log` | where the tick log appends |
| `--state <path>` | `<home>/<host-dir>/meerkat-taskpanel/supervisor.state.json` | the running registry |
| `--config <path>` | `<home>/<host-dir>/meerkat-taskpanel.env` | host config: the claim default, and (for a host copy) `MEERKAT_TASKPANEL_REPO` |
| `--home <path>` | `$HOME` | base for those defaults |
| `--glue <path>` | `<home>/<host-dir>/bin/wake-<host>.sh` | the wake glue that resolves the project directory and starts the worker ([Where a worker runs](#where-a-worker-runs)) |
| `--projects-json <path>` | `<home>/<host-dir>/skills/meerkat-taskpanel/projects.json` | the host-local map handed to the glue |
| `--wake-command <cmd>` | — | your own wake command instead of the built-in host forms; called as `<cmd> <handoff> [<sid>]` |

**Fixed paths.** Logs and state always land at the paths in the table — a user
who wants to know why a card did not start reads
`~/.claude/meerkat-taskpanel/supervisor.log` (or `.codex/`, `.agents/`).

## The claim-unassigned policy

The supervisor's one policy knob is whether it may take **unassigned** cards —
the public pool — or only cards routed to the agent. The board exposes both
through one read: `issue candidates --assignee <name> [--include-unassigned]`.

`install.sh` asks once (when stdin is a TTY and no flag was given):

```
Allow claiming unassigned tasks? [Y/n]
```

and remembers the answer in the host config file:

```ini
# <home>/<host-dir>/meerkat-taskpanel.env
MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes
```

Precedence when the supervisor resolves it: `--claim-unassigned` flag →
`$MEERKAT_TASKPANEL_CLAIM_UNASSIGNED` → the config file → default `yes`. A non-interactive
install defaults to **yes**; `--claim-unassigned=no` / `--assignee-only`
persist `no`.

## The end-to-end path

```
launchd / systemd / cron  ──poll 60s──▶  supervisor --once
                                            │  issue candidates --assignee alice --include-unassigned
                                            │      (empty → stop; 0 workers)
                                            ▼
                                        issue move <ref> in_progress     ← atomic claim, the only dispatch
                                            │  refused → stop
                                            ▼
                                        claude -p "<handoff>" [--resume <sid>]   ← the one LLM turn
                                            │  record {ref, pid} in the registry
                                            ▼
                                        … the worker reads, works, reports, delivers …
patrol 300s ──▶ supervisor --patrol-only --once
                     issue list --status in_progress
                     heartbeat > 30m  → escalate    (no LLM)
                     unreadable       → report      (never silent)
```

## Verifying the generated trigger / wake glue

The installer *generates* the per-host claim entry points — the Claude SessionStart
hook, the Codex claim trigger, and each `wake-<host>.sh`. `scripts/verify/profiles.mjs`
only proves they *landed*; it never runs them. `scripts/verify/host-runtime.mjs` runs
them, offline, in CI:

```bash
node scripts/verify/host-runtime.mjs            # all hosts; exit 0 only if every assert passes
node scripts/verify/host-runtime.mjs --host codex
```

The harness installs into a throwaway prefix (never `$HOME`), then swaps in a **canned
`taskctl` shim** (the board boundary) and fake `claude`/`codex`/`pi` executables (the
wake boundary), both of which record their argv. It then asserts the actual invocation,
not just the exit code:

| Path | Asserted |
|---|---|
| `session-start.sh` (claude) | calls `issue candidates --assignee <agent>`, prints candidates + the eight rules, and is **non-fatal** — a failing or missing shim still exits 0 with a PATH-independent fallback |
| `meerkat-taskpanel-claim.sh` (codex) | claims the first candidate (`issue move <ref> in_progress`) when free; **skips** when a held card is mine (identity matched under the board's NFKC/whitespace/case rule); still claims when the held card is someone else's; exits 0 on an empty pool; exits 1 when the shim is missing |
| `wake-claude.sh` | no prompt → exit 2; mapped project → `claude -p <prompt>` **run in the mapped directory**; plus `--resume <sid>` when a session is given; unmapped project / bad target directory → exit 3, no worker started; **no** permission-bypass flag |
| `wake-codex.sh` | the same, with `codex exec <prompt>` (and `codex exec resume <sid> <prompt>`) |
| `wake-pi.sh` | the same, with `pi --print <prompt>` (and `pi --print --session <sid> <prompt>`) |

The wake assertions compare the recorded argv against `wakeCommand()` (the same pure
function `scripts/supervisor.mjs` dispatches through), so the generated script and the
supervisor can't drift apart — and they compare the **working directory** the mock host
CLI was actually started in, so "a woken worker runs in its project's directory" is
executed, not merely documented. The harness drives each wake script with a prompt only; the
**resume** branches (the `<sid>` column above) are asserted at the `wakeCommand()` level in
`test/scheduling/`, not re-executed against a mock host CLI.

**Coverage boundary (what this does *not* prove).** It pins the generated *shell glue*
against mocks. It does not drive the real host CLIs (that is the supplementary
`scripts/verify/host-cli.mjs`, which SKIPs when a CLI is absent) and it does not exercise
the real board's claim semantics (`scripts/verify/install-e2e.sh` drives the real
`taskctl`/`taskd`). Per host, only the forms the bundle actually ships are covered:
Claude has a hook and no trigger, Codex has a trigger and no hook, and **Pi has neither a
hook nor a trigger nor a shim** — only the external `wake-pi.sh` applies, which is why
its row above is the wake form alone.

## See also

- [`install.md`](install.md) — the installer flags, including `--claim-unassigned`.
- [`../skills/meerkat-loop/SKILL.md`](../skills/meerkat-loop/SKILL.md) — the loop as the
  skill it is distributed as, and the board interface generation it requires;
  [`references/operation.md`](../skills/meerkat-loop/references/operation.md) is the
  operator's view.
- [`../skills/meerkat-taskpanel/references/practice-guides.md`](../skills/meerkat-taskpanel/references/practice-guides.md) —
  the "Waking & patrol" section, for the agent-facing view.
- [`../skills/meerkat-taskpanel/references/cli.md`](../skills/meerkat-taskpanel/references/cli.md) —
  `issue candidates --include-unassigned`.
- [openclaw-team](https://github.com/tanyu216/openclaw-team) — the OpenClaw supervisor.
