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

## The rest of the SLA table: the same pass, five more rows

A stale heartbeat is **one** row of `PROTOCOL §⑮`'s timeout table. The others —
a card parked on the leader's clarification, an unanswered confirmation gate, a
delivery nobody queued an acceptance review for, a defect whose fix card was
never created, and the leader's own patrol going quiet — used to be invisible to
the same pass that watched the heartbeat. They are now covered by the **same
patrol tick**, through the shared inspection contract
(`sla-inspection-contract.md`, the `team/guides/` document both mechanisms are
written against), which also gives the stale-heartbeat row a channel the two
mechanisms can share and adds a row for the inspectors' own liveness — an
inspector that has stopped reads exactly like a healthy board.

What that means concretely:

- **One tuple, shared with the openclaw-side inspector.** Each alert is the flat
  25-field object of the contract (§4): `alert_id`, `dedup_key`, `sla_row`,
  `severity`, `measure_start_at`, `threshold_min`, `due_at`, `action`, `target`,
  `evidence`, … A field means the same thing on both mechanisms, so the two can
  never label one card differently.
- **Thresholds are `PROTOCOL §⑮`'s, referenced.** `SLA_ROWS` in
  `src/shared/sla-patrol.mjs` is the runtime mapping table: every limit sits next
  to the row it came from. `warn` is `L − P` (the mechanism's own period before
  the published limit — 到点提醒, not a breach), `overdue` is `L`, `escalate` is
  the published further timeout.
- **Working hours, not wall clock.** `T` accumulates only inside the
  Asia/Shanghai 09:00–23:00 window, off-hours rolled over — a card blocked at the
  end of a working day cannot be "overdue" overnight, and a host in another
  timezone measures the same `T`.
- **Notify-only, always.** Every alert is addressed to the **leader**
  (`target: "leader"`; the card field is `notify_leader`, never a person's name).
  The releasability hint (`releasable` / `releasable_basis`) points at a card that
  *looks* releasable — releasing it stays the leader's `§⑦` action, and no code
  path in the patrol writes card state or starts an LLM turn for a new row.
- **Leader attribution is an *author* test, not a *kind* test.** The
  `leader_stalled` row counts an event as the leader's by **who did it** — a
  `confirm` / `decision` / `change` comment whose author is the leader, a card
  the leader created, a card that moved through the leader-only `done`
  transition. A `change` comment written by a *worker* does not reset the stall
  clock, because otherwise any chatty worker could mask a real stall. "Who" is
  the board's own decision authority by default (`author_kind = "human"`, the
  same reading `isDecisionComment` and `listDecisions` use); a deployment whose
  leader writes as an agent names it with `--sla-leader <id>` — set the same
  identity on both mechanisms, since the contract requires **one** set.
- **Confidence is pinned, not guessed.** `confidence: "high"` means the origin
  instant was read verbatim from one unambiguous source; `"low"` means it came
  from a fallback, a shape match, or a predicate that could not be decided. A
  quietly-picking-latest among several *exact* candidates stays `high`.
- **Zero-cost idle.** A board with nothing past a lead produces no alert, no
  notification and no extra read. `leader_stalled` additionally conditions on
  there being leader-owed work at all, so a quiet night is never read as a
  stalled leader.
- **Fail-safe.** An origin that cannot be read alerts (at `warn`, with no
  threshold) instead of staying quiet; a pre-emit re-check that cannot run lets
  the alert through rather than silencing it; a defect wait whose fix-card check
  could not be decided (an incomplete board read) is still reported — as open,
  with `confidence: "low"`; and a candidate the re-check drops is always
  reported, never swallowed.
- **De-duplicated.** A ledger beside the supervisor's state file keys each alert
  by `<card>#<row>#<tier>@<origin>`, so a repeat is suppressed, a *tier
  promotion* is not (an escalation is never de-duplicated away), and a new wait on
  the same card re-notifies. An unreadable ledger suppresses nothing.

### Two rows that used to be exceptions

- **`heartbeat_stale` now emits the §4 tuple as well**, beside the legacy
  `{stale: […]}` alert. The legacy envelope is a published consumer contract and
  keeps working exactly as before, but it carries no `dedup_key` and no
  `sla_row`, so it cannot take part in the shared ledger — without the tuple the
  two mechanisms would each notify the same stale heartbeat. The stale heartbeat
  therefore goes out twice, to two different channels, on purpose.
- **`inspector_liveness` is the mutual watchdog.** Every completed pass rewrites
  this mechanism's own last-successful-run marker
  (`--sla-last-ok`, default `loop-patrol-last-ok.json` beside the state file).
  Point `--sla-peer <path>` at the other mechanism's marker and a marker older
  than `3 × 15min` raises the row at `warn` — a stopped inspector otherwise looks
  exactly like a healthy board. **With no `--sla-peer` configured, the peer's
  half is a registered dependency, not an alarm**: the peer inspector's marker
  does not exist on this board yet, and alarming every pass on that would be the
  permanently-red failure this contract exists to prevent.

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
> [`install.md`](install.md#the-taskd-guard-keepalive-always-enabled).

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
absolute `<dataDir>/logs/taskd.log`; `{{NODE}}` is the **absolute** node that ran
`install.sh` (`process.execPath`); `{{PATH}}` is `{{NODE}}`'s directory followed by
launchd's own default `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`); and `{{ENV_PLIST}}`
expands to the operator's `TASKD_DATA_DIR` / `TASKD_RUNTIME_POINTER` as `<key>`/
`<string>` pairs — or to nothing when neither was set.

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
     loads it immediately. Logs append to the same file the lazy-start path uses.

     ProgramArguments[0] is the ABSOLUTE node that rendered this file — never
     `/usr/bin/env node`. launchd runs a job with PATH=/usr/bin:/bin:/usr/sbin:/sbin,
     which holds no nvm and no Homebrew directory, so an `env node` job on a machine
     whose node lives only there exits 127 and restart-loops forever. PATH below
     prepends node's own directory to that same default, so a child that looks `node`
     up by name finds it too. The path is version-pinned: after a node upgrade, run
     `install.sh --force` to refresh this plist.

     EnvironmentVariables also carries the operator's TASKD_DATA_DIR /
     TASKD_RUNTIME_POINTER when they set either at install time, so the guard and the
     CLI resolve the same board. `install.sh` renders the entries below. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.meerkat-taskpanel.taskd</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{NODE}}</string>
    <string>{{SERVER_ENTRY}}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{{PATH}}</string>
{{ENV_PLIST}}
  </dict>
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
- **`ProgramArguments`** — `[{{NODE}}, {{SERVER_ENTRY}}]`: the absolute interpreter, then
  the absolute entry point. **Never `/usr/bin/env node`**, and never a bare `node`. A
  launchd job runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which contains no nvm and
  no Homebrew directory, so `env node` exits `127` on any machine whose node lives only
  there — and `KeepAlive` then turns that into a restart loop that never ends
  (T-20261014-052428). Naming the interpreter outright removes `PATH` from the question
  entirely.
- **`EnvironmentVariables.PATH`** — node's own directory, then launchd's default. The
  absolute `ProgramArguments[0]` is what starts the server; this is for anything the
  server (or a CLI that inherits the job's environment) may *spawn* by name. It is the
  documented default set with one directory prepended, so nothing else about the job's
  environment changes.
- **`EnvironmentVariables` (`TASKD_DATA_DIR` / `TASKD_RUNTIME_POINTER`)** — written only
  when the operator set that variable for the install, resolved to an absolute path. See
  [Coexisting with `taskctl`'s lazy start](#coexisting-with-taskctls-lazy-start) — the
  unit and the CLI must resolve the *same* board.
- **Node upgrades.** `{{NODE}}` is a real path into a versioned directory
  (`~/.nvm/versions/node/vX/bin/node`, `/opt/homebrew/Cellar/node/X.Y.Z/bin/node`), so a
  node upgrade can leave the unit naming an interpreter that no longer exists. The fix is
  `install.sh --force`, and the next install says so rather than loading a unit it did not
  write: the drifted unit is reported and left alone (see below).

#### systemd unit (Linux)

`{{NODE}}`, `{{SERVER_ENTRY}}` and `{{LOG}}` are the same absolute paths as on macOS;
`{{ENV_SYSTEMD}}` expands to one `Environment=` line per variable the operator set, or to
nothing.

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
#
# ExecStart names the ABSOLUTE node that rendered this unit — never
# `/usr/bin/env node`, which systemd would resolve against the *service's* PATH
# and which fails outright on a machine whose node lives only under nvm or
# Homebrew. The path is version-pinned: after a node upgrade, run
# `install.sh --force` to refresh this unit.
#
# The Environment= line(s) at the end of [Service] carry the operator's
# TASKD_DATA_DIR / TASKD_RUNTIME_POINTER when they set either at install time, so
# the guard and the CLI resolve the same board. `install.sh` renders them.
[Unit]
Description=Meerkat TaskPanel taskd (board server) guard
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart={{NODE}} {{SERVER_ENTRY}}
Restart=always
RestartSec=5
StandardOutput=append:{{LOG}}
StandardError=append:{{LOG}}
{{ENV_SYSTEMD}}
[Install]
WantedBy=default.target
```

- **`ExecStart`** — `{{NODE}} {{SERVER_ENTRY}}`: two absolute paths and no interpreter
  lookup. `/usr/bin/env node` is not an option here at all — systemd resolves `ExecStart`'s
  first word against the *service's* `PATH`, which has no nvm and no Homebrew directory, so
  an `env node` unit fails on exactly the machines the macOS unit used to crash on. The
  macOS `PATH` override has no counterpart here on purpose: with an absolute `ExecStart`
  the service does not need one, and writing one would only narrow systemd's own default.
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

**`enabled` means the board answers `/health`** — not merely that the supervisor accepted
the job. A loaded unit gets a pid within milliseconds of a spawn that may then die, which
is exactly how a `PATH`-broken unit could report `enabled (…, pid 17388)` while the log
filled with `env: node: No such file or directory`. So after loading, the install waits
for the runtime pointer to name this unit's board *and* for that address to answer
`/health` — the same `probeHealth` the CLI trusts.

The budget is `READY_TIMEOUT_MS` (10s), deliberately **twice** the CLI's
`AUTOSTART_TIMEOUT_MS`: that one bounds a *call*, this one the last step of an *install*,
and the two mistakes are not symmetric — a slow but healthy board reported `not ready`
reads exactly like the crash loop this gate exists to expose. A unit that is loaded but
not serving is reported as such, with the log to read:

```text
taskd guard: loaded (com.meerkat-taskpanel.taskd, pid 17388); /health did not answer within 10000ms — read <dataDir>/logs/taskd.log
```

Neither line fails the install (the host skills are installed either way), but only the
first one claims the guard works.

To stop and remove the guard:

```bash
# macOS
launchctl bootout gui/$UID/com.meerkat-taskpanel.taskd
rm <prefix>/taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
# Linux
systemctl --user disable --now meerkat-taskpanel-taskd.service
rm ~/.config/systemd/user/meerkat-taskpanel-taskd.service
```

Three **internal** bypasses exist; none is a user option:

- `--no-automation`, or its environment form `MEERKAT_TASKPANEL_NO_AUTOMATION=1` (the
  variable `install.sh` sets for each host installer) — **skips the guard too**,
  semantically consistent with its other targets (the Codex claim trigger and the
  scheduling units). It is one bypass with two spellings, an advanced install bypass
  rather than a switch for the guard alone.
- `--dry-run` — writes and loads nothing; the report line becomes
  `taskd guard: skipped (dry-run)`.
- `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1` — **for tests only**; skips the guard so a
  CI or test install never loads a real unit.

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
  construction. If the operator exports `TASKD_DATA_DIR` or `TASKD_RUNTIME_POINTER` for the
  install, `install.sh` writes **the same absolute path** into the unit's own environment
  (plist `<key>TASKD_DATA_DIR</key><string>…</string>` under `EnvironmentVariables`;
  systemd `Environment=TASKD_DATA_DIR=…` under `[Service]`) — a unit that resolved a
  different directory would guard a board nobody installed. Resolution stays single-sourced
  in `resolveDataDir` and `resolveRuntimePointerPath`, so there is one answer per process,
  and the readiness probe reads the pointer the unit itself would write (`TASKD_RUNTIME_POINTER`
  when set, else the machine-wide one, else `<dataDir>/runtime.json` when another live board
  holds the machine-wide slot). `TASKD_NO_AUTOSTART` and `TASKD_PORT` are deliberately **not**
  propagated — a client policy and an ephemeral port, respectively; see the two bullets above.
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

That is the **manual** path, and it is all a plain install does. Loading is a separate,
explicit act: the opt-in switch is [`--supervisor=enable`](#enabling-the-supervisor-opt-in)
below, and it is the one thing that makes an installer load a unit or run `crontab` for you
— see the exception stated there.

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

## Enabling the supervisor (opt-in)

Everything above describes units the installer **writes and never loads**. The enable
capability adds one deliberate act on top: `install.sh --supervisor=enable` (alias
`--enable-supervisor`) performs the per-OS load below. Without it, behaviour is unchanged —
the manual commands in the section above are still the whole story.

That is the single exception to the rule, stated once and pointed at rather than repeated:
**an installer never loads a unit or runs `crontab` for you — unless you ask.** Asking is
always explicit (the flag, `MEERKAT_TASKPANEL_SUPERVISOR=enable`, or answering **yes** to
the one-time TTY question, whose default is **N**): enabling is never a silent default, and
a plain `install.sh` still only prints the load command. The flag surface, the TTY question
and the env var are documented once in
[`install.md §Enabling the supervisor (opt-in)`](install.md#enabling-the-supervisor-opt-in);
this section is the per-OS detail, the failure modes, and what an enabled daemon runs.

The switch is `--supervisor=enable|disable|status` with
`--supervisor-hosts claude,codex,pi` (which hosts; default: the loop hosts in `--target`)
and `--scheduler auto|launchd|systemd|cron` (which mechanism; default `auto`). On
`--target all`, `--supervisor=enable` enables **claude, codex and pi** — and only those
(see [OpenClaw stays excluded](#openclaw-stays-excluded)).

Per-OS commands below are written for the Claude install (`~/.claude`); for Codex and Pi
substitute `~/.codex` / `~/.agents` for the host directory and `codex` / `pi` for
`--host`. `<agent>` is the `--agent-name` from the install (default `$USER`), and
`<uid>` is `id -u`.

### macOS — launchd

The installer already wrote both units
(`<host-dir>/scheduling/launchd/com.meerkat-taskpanel.{poll,patrol}.plist`); enabling means
bootstrapping them, one per unit:

```bash
launchctl bootstrap gui/$(id -u) ~/.claude/scheduling/launchd/com.meerkat-taskpanel.poll.plist
launchctl bootstrap gui/$(id -u) ~/.claude/scheduling/launchd/com.meerkat-taskpanel.patrol.plist
```

`launchctl bootstrap gui/$(id -u)` is the modern, persistent form (the job survives a
reboot). Where `bootstrap` is unavailable (older macOS), the legacy fallback is
`launchctl load -w <plist>` (`-w` = persist across reboot).

**Disable** — by label, both units:

```bash
launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.poll
launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.patrol
```

(legacy fallback: `launchctl unload -w <plist>`).

**Status**:

```bash
launchctl print gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.poll
```

Exit 0 with a `state =` line ⇒ loaded; `Could not find service …` ⇒ not loaded. Repeat for
`patrol`.

**Failure modes.**

| Symptom | Meaning | What the enable path does |
|---|---|---|
| `Bootstrap failed: 5: Input/output error` | no Aqua/GUI session — an SSH-only or headless launchd context | reports it and tells you to retry from a GUI login session (or use `launchctl load -w`). It does **not** claim success |
| `Bootstrap failed: 37: … already bootstrapped` (legacy: `service already loaded`) | already loaded | **idempotent success** — reports `already enabled`, exit 0 |
| `Could not find service` on disable | not loaded | **idempotent no-op** — reports `already disabled`, exit 0 |

### Linux — systemd `--user`

A `--user` unit has to be copied **and** reloaded before it can be enabled — the ordering
is load-bearing:

```bash
mkdir -p ~/.config/systemd/user
cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
```

**Enable / disable / status:**

```bash
systemctl --user enable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer
systemctl --user disable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer
systemctl --user is-enabled meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer   # add is-active for "running now"
```

**The headless caveat: lingering.** A `systemd --user` manager is torn down when the user's
last session ends, so without lingering the "enabled" units stop the moment the login
session closes — the background supervisor then **silently does nothing**. To run truly
headless, while logged out, lingering must be on:

```bash
loginctl enable-linger "$USER"
```

The enable path therefore **warns when linger is off**; turn it on if the supervisor is
meant to survive logout. The warning appears in the enable report on Linux hosts.

**Failure modes.**

| Symptom | Meaning | What the enable path does |
|---|---|---|
| `Failed to connect to bus: …` | no user D-Bus / no `systemd --user` (containers, WSL without systemd, non-systemd distros) | reports it and recommends `--scheduler=cron` |
| unit not found | the `cp` was skipped, or `daemon-reload` never ran | names both steps |

### Anywhere — cron

Cron is the cross-platform fallback — any OS, and the only option where launchd and systemd
are absent. The generated `~/.claude/scheduling/cron/meerkat-taskpanel.cron` is the
*content*; enabling installs it into your crontab **wrapped in a managed marker block**, so
it is idempotent and cleanly removable:

```cron
# >>> meerkat-taskpanel (~/.claude) >>>
* * * * * /usr/bin/env node ~/.claude/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --once --log ~/.claude/meerkat-taskpanel/supervisor.log --state ~/.claude/meerkat-taskpanel/supervisor.state.json >/dev/null 2>&1
*/5 * * * * /usr/bin/env node ~/.claude/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --patrol-only --once --log ~/.claude/meerkat-taskpanel/supervisor.log --state ~/.claude/meerkat-taskpanel/supervisor.state.json >/dev/null 2>&1
# <<< meerkat-taskpanel (~/.claude) <<<
```

(The manual path above — `crontab <file>` — drops the same two lines in *without* a marker
block; the enable path is the one that wraps them. The `(~/.claude)` in the marker is the
host directory, so the three hosts get three independent blocks.)

- **Enable** reads `crontab -l`, strips any existing `meerkat-taskpanel (~/.claude)` block,
  appends the fresh one, and writes it back with `crontab -`. Re-enabling **replaces**,
  never duplicates — the marker block *is* the idempotency key, because cron has no other
  machine-readable "enabled" state.
- **Disable** does the same but only strips; no block ⇒ no-op.
- **Status** is `crontab -l | sed -n '/>>> meerkat-taskpanel (~/.claude) >>>/,/<<< meerkat-taskpanel (~/.claude) <<</p'`.

**Failure modes.**

| Symptom | Meaning | What happens |
|---|---|---|
| `no crontab for <user>` (`crontab -l` exits 1) | no crontab yet | treated as empty — the enable does not abort |
| the cron daemon is not running | nothing fires | the block is written but never runs; stated, not hidden |
| macOS TCC | a job touching a protected path is silently blocked | the cron / `node` binary needs Full Disk Access — a caveat, not an error |
| the machine sleeps | cron has no run-at-load | a tick is simply missed; the 60s poll recovers on the next tick |

### What an enabled supervisor runs

An enabled unit is just a clock: it runs the supervisor, and the supervisor claims and
wakes. Enabling does **not** change the worker's permission boundary, which is documented
in full at [Headless permission boundary](#headless-permission-boundary) — nothing here
loosens it: the generated wake glues ship **no** bypass flag by default, and turning one on
still needs the written authorization, documented at the point of use, that section
describes.

- **Identity and parameters.** The units start the supervisor with `--agent <agent>`
  (`--agent-name`, default `$USER`), `--host <h>`, `--once` per tick, the default
  `--max-concurrency 8`, and the claim policy read from `<host-dir>/meerkat-taskpanel.env`.
  The supervisor then starts the wake glue (`<host-dir>/bin/wake-<host>.sh`), which runs the
  host's headless entry point non-interactively: `claude -p "<handoff>" [--resume <sid>]` /
  `codex exec "<handoff>"` / `pi --print "<handoff>"`.
- **Logs.** `<host-dir>/meerkat-taskpanel/supervisor.log` (the supervisor's `--log`). The
  unit's own stdout/stderr go to the **same** file — launchd `StandardOutPath` /
  `StandardErrorPath`, systemd `append:{{LOG}}`, and cron `>/dev/null 2>&1` because `--log`
  already writes it.
- **State.** `<host-dir>/meerkat-taskpanel/supervisor.state.json` — the running registry.
- **Working directory.** A woken worker still `cd`s to the card's project directory,
  resolved by the wake glue from the host-local `projects.json`; enabling changes nothing
  here (see [Where a worker runs](#where-a-worker-runs)).

### One mechanism per host, and the cost gate

- **One scheduler per host.** `--scheduler` picks exactly one. To move a host from, say,
  cron to launchd, disable the first: the enable path may do disable-then-enable, but it
  never leaves two loaded. Two loaded units for one host only race each other for the same
  cards.
- **The cost gate does not change.** Enabling adds the 1-minute scan and nothing else — it
  is **not** an always-on LLM, and it does not alter the cost model. An empty tick is one
  local `taskctl issue candidates` read (**$0**), and an LLM turn starts **only when a
  claim succeeded**; patrol stays LLM-free by default (`--patrol-llm=no`). See
  [The cost gate: a turn starts only on fire](#the-cost-gate-a-turn-starts-only-on-fire).
- **Disable and status** are part of the same entry point: `--supervisor=disable` unloads /
  removes, `--supervisor=status` prints the per-host load state and changes nothing
  (per-OS forms above).

### OpenClaw stays excluded

The new switch does not change the [OpenClaw
ruling](#openclaw-do-not-build-a-supervisor). `--target openclaw` still installs the
**board skill only** — no `meerkat-loop` skill, no units, no glue, so nothing to enable.
`--target all --supervisor=enable` **skips** openclaw: the enable action applies only to
`{claude,codex,pi}`. `--supervisor-hosts openclaw` is **rejected** (reason on stderr, exit
2).

> **Where it is implemented.** `scripts/install/_common.sh` (`apply_supervisor`, the
> per-host action) drives `scripts/install/lib/supervisor.mjs`, which owns the per-OS
> commands above and their failure modes. A refusal is reported
> (`supervisor: not enabled …`) and does **not** fail the install: the host's skills are
> installed either way, and the printed command is what finishes the job.

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
| `--notify <cmd>` | — | run `<cmd>` with each patrol alert as JSON on stdin — both the legacy heartbeat alert and the SLA tuple |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--log <path>` | `<home>/<host-dir>/meerkat-taskpanel/supervisor.log` | where the tick log appends |
| `--state <path>` | `<home>/<host-dir>/meerkat-taskpanel/supervisor.state.json` | the running registry |
| `--sla-ledger <path>` | `sla-ledger.json` beside `--state` | the SLA de-duplication ledger; an unreadable one suppresses nothing |
| `--sla-leader <id>` | from `$MEERKAT_TASKPANEL_SLA_LEADER`, else unset | the author id the leader writes under, for the `leader_stalled` attribution set; unset ⇒ the board's own decision authority (`author_kind = "human"`). Set the **same** identity on both mechanisms |
| `--sla-last-ok <path>` | `loop-patrol-last-ok.json` beside `--state` | where this mechanism publishes its own last-successful-run marker for the peer's watchdog |
| `--sla-peer <path>` | from `$MEERKAT_TASKPANEL_SLA_PEER`, else unset | the peer inspector's last-ok marker; a marker older than `3 × 15min` raises `inspector_liveness`. Unset ⇒ the peer's half is a registered dependency and nothing alarms |
| `--board-limit <n>` | `500` | max cards read in one patrol pass |
| `--trail-limit <n>` | `200` | max comment trails read in one pass (a cap is always logged) |
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

- [`install.md`](install.md) — the installer flags, including `--claim-unassigned` and the
  opt-in `--supervisor=enable|disable|status`.
- [`../skills/meerkat-loop/SKILL.md`](../skills/meerkat-loop/SKILL.md) — the loop as the
  skill it is distributed as, and the board interface generation it requires;
  [`references/operation.md`](../skills/meerkat-loop/references/operation.md) is the
  operator's view.
- [`../skills/meerkat-taskpanel/references/practice-guides.md`](../skills/meerkat-taskpanel/references/practice-guides.md) —
  the "Waking & patrol" section, for the agent-facing view.
- [`../skills/meerkat-taskpanel/references/cli.md`](../skills/meerkat-taskpanel/references/cli.md) —
  `issue candidates --include-unassigned`.
- [openclaw-team](https://github.com/tanyu216/openclaw-team) — the OpenClaw supervisor.
