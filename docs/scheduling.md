# Scheduling & patrol

How a board gets worked **continuously** when the host that does the work has no
clock: the cheap scan, the atomic claim, the wake, and the slow patrol that
catches what the scan misses. The supervisor that runs the loop lives **outside**
the host — `scripts/supervisor.mjs` — and the host is only ever the worker that
gets woken.

This is the design the OpenClaw host already ships as
[openclaw-team](https://github.com/tanyu216/openclaw-team) (`poll-<agent>` and
`task-patrol`); this document is the host-agnostic statement of it, plus what
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
  (`--state`, default `<host-dir>/task-panel/supervisor.state.json`: card →
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
`buildHandoff()`: the card id and title, the workspace, the exact `taskctl`
commands to read and deliver it, and the attribution flags
`--agent <name> --agent-platform <host> --session-id <id>`. The handoff is capped
(≈1–2 KB) so a wake never drags an unbounded context into the model.

Continuity across wakes comes from the **board**, not the prompt: the card's
comments, reports and session record are durable, so a resumed conversation can
re-attach to the same work. Claude additionally resumes a specific session with
`claude -p … --resume <sid>` when a session id is known.

## Where the supervisor runs

The loop cannot live inside the host, because Claude Code and Codex have **no
timers** — their hooks fire only on session events. So the loop lives outside:

| Option | Shape |
|---|---|
| `scripts/supervisor.mjs` (this repo) | standalone; `--once` for cron/launchd/systemd, or its own interval loop |
| the local `taskd` process | a natural home for the same loop in a future milestone |
| [openclaw-team](https://github.com/tanyu216/openclaw-team) | on OpenClaw, the framework *is* the supervisor |

The host is just a worker: the supervisor claims on the board, then starts the
host's own headless entry point.

## The three hosts: how each one is triggered

Claude Code, Codex and Pi have no clock, and their wake surfaces differ. The
supervisor's `--host` selects the wake command; the rest (scan, claim, patrol,
registry) is identical.

| Host | Wake command | Trigger / scheduling | Continuity |
|---|---|---|---|
| **Claude Code** | `claude -p "<handoff>"` (headless) | external: launchd / systemd / cron running `supervisor.mjs --once`, or the supervisor's own loop | `claude -p … --resume <sid>` — resume the session that owns the card |
| **Codex** | `codex exec "<handoff>"` | external: the same units, or Codex app automation (`intervalMinutes`, `quotaAware`, `model`, `reasoningEffort`) | the running thread; carry `$CODEX_THREAD_ID` as `--session-id` |
| **Pi** | `pi run "<handoff>"` | external units + `wake-pi.sh`; if pi has no headless entry point, use the in-session trigger and let the supervisor own only scan/claim/patrol | whatever session id pi exposes; passed through the handoff |
| **OpenClaw** | *n/a — no self-scheduler* | install **openclaw-team**; its `poll`/`patrol` automations are this design | the framework keeps the id stable across resumes |

Installers write per-host units under `<host-dir>/scheduling/{launchd,systemd,cron}`
and the wake glue at `<host-dir>/bin/wake-<host>.sh`, then **print the load
command** — they never enable a daemon or run `crontab` for you:

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.taskpanel.poll.plist   # and .patrol.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now taskpanel-poll.timer taskpanel-patrol.timer
# Anywhere
crontab ~/.claude/scheduling/cron/taskpanel.cron
```

### OpenClaw: do not build a supervisor

OpenClaw is the one host with a scheduler of its own. The
[openclaw-team](https://github.com/tanyu216/openclaw-team) framework already
implements exactly this pattern — `poll-<agent>` (`every 1m + trigger`) for the
expensive-free scan and `task-patrol` (`every 5m + trigger`) for the stale pass.
`install.sh --target openclaw` therefore installs the **skill only**: no
scheduler, no wake glue, no host config. Point OpenClaw at the framework instead:

```bash
git clone https://github.com/tanyu216/openclaw-team && cd openclaw-team
./install.sh --dry-run      # preview
./install.sh                # idempotent
```

Task Panel is that framework's default board, and its claim and candidate
criteria are kept in lockstep with openclaw-team's poll — which is the point.

## Running `scripts/supervisor.mjs`

```bash
node scripts/supervisor.mjs --host claude --agent alice --once        # one tick
node scripts/supervisor.mjs --agent alice,bob --host codex            # loop
node scripts/supervisor.mjs --agent alice --dry-run --once            # plan only
```

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--host claude\|codex\|pi` | `claude` | which worker to wake |
| `--repo <path>` | this checkout | repository root |
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
| `--log <path>` | `<home>/<host-dir>/task-panel/supervisor.log` | where the tick log appends |
| `--state <path>` | `<home>/<host-dir>/task-panel/supervisor.state.json` | the running registry |
| `--config <path>` | `<home>/<host-dir>/task-panel.env` | host config the default is read from |
| `--home <path>` | `$HOME` | base for those defaults |

**Fixed paths.** Logs and state always land at the paths in the table — a user
who wants to know why a card did not start reads
`~/.claude/task-panel/supervisor.log` (or `.codex/`, `.agents/`).

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
# <home>/<host-dir>/task-panel.env
TASKPANEL_CLAIM_UNASSIGNED=yes
```

Precedence when the supervisor resolves it: `--claim-unassigned` flag →
`$TASKPANEL_CLAIM_UNASSIGNED` → the config file → default `yes`. A non-interactive
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

## See also

- [`install.md`](install.md) — the installer flags, including `--claim-unassigned`.
- [`../skills/task-panel/references/practice-guides.md`](../skills/task-panel/references/practice-guides.md) —
  the "Waking & patrol" section, for the agent-facing view.
- [`../skills/task-panel/references/cli.md`](../skills/task-panel/references/cli.md) —
  `issue candidates --include-unassigned`.
- [openclaw-team](https://github.com/tanyu216/openclaw-team) — the OpenClaw supervisor.
