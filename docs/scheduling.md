# The scheduling model: task-card dispatch, the supervisor and the director

A board is a state machine; something has to turn it. This page is the **design** of that
something: how a card that is ready gets claimed, dispatched, watched, reviewed and closed
when the agent kind doing the work has **no clock of its own** — Claude Code, Codex and Pi
only run when a session starts them.

The design stance, in four sentences:

- The **supervisor** lives **outside** the agent application: `taskctl loop …`
  (`src/orchestrator/`) ships with the toolkit, and the application is only ever the worker
  that gets woken. The collaboration decisions are the
  **[`meerkat-director`](../skills/meerkat-director/SKILL.md) skill**; the human's live view
  of the same board is the [`meerkat-chat`](../skills/meerkat-chat/SKILL.md) console. This
  page is the system those decisions run inside.
- It owns **two clocks** — a cheap *ping* for liveness and one *tick* that runs the
  deterministic passes — and performs no board I/O outside those passes.
- The board work is **deterministic code** — `taskctl loop poll|patrol|workflow` — run by
  the supervisor in-process; the model's invariants live in those passes and in the board,
  never in a prompt. There is **no control/continue LLM turn**.
- A **resident session pool** turns an abstract "dispatch" into one top-level session per
  card, running in the card's directory. Without it the supervisor still patrols and applies
  workflow, but it dispatches nothing. The one LLM decision lane is the **director**: it
  assigns unowned cards, answers worker questions and escalates E1–E5 to the human.

## Design at a glance

| Component | Responsibility | Invariant it upholds |
|---|---|---|
| **ping** clock | prunes dead pids, keeps the registry honest | no board read and no model turn |
| **tick** clock | runs the deterministic passes in-process | one tick per cadence, under one lock |
| **poll** | scans candidates, claims, enqueues the handoff | **the atomic claim is the single dispatch source** |
| **patrol** | the SLA pass: stale claims, review aging, recovery | no silent state; every alert is re-checked before emit |
| **workflow** | review dispatch, verdict application, containers | the delivery gate is enforced by the board, not the prompt |
| **session pool** | worker sessions per card, a reviewer lane per directory, a director lane per project | one writer per card; concurrency is capped |
| **director** | assigns unowned cards, answers worker questions, escalates E1–E5 | the only LLM decision lane; it moves nothing to `done` |
| **subscriber** | event-driven early ticks | a latency path only — the clocks remain the fallback |
| **taskd guard** | keepalive for the board service itself | one guard per machine; one writer per data directory |
| **supervisor** | the clocks, pool and subscriber for one machine | one supervisor per machine, holding sessions of several agent kinds |

The model in one line: **the board is the source of truth, the claim is the only dispatch
source, and every clock is a bounded, idempotent pass over state the board already holds.**

## The architecture in one picture

The supervisor is a pipeline, not a dispatcher with a queue beside it. Read top to bottom:
the OS units start it, a pass writes a row, the pool opens the lane, and every lane writes
the board back through `taskctl`.

```text
        OS UNITS  (launchd / systemd / cron) — one supervisor per machine
        ping · continue · session · subscribe
                                  │ starts
┌─────────────────────────────────▼────────────────────────────────────────┐
│ BOARD  (taskd) — node:sqlite, the source of truth                        │
│ cards · atomic claim (CAS) · workflow plan · SLA rows · events (SSE)     │
│ taskd guard keeps this process alive — it does not tick the loop         │
└──────────────▲──────────────────────────────────┬────────────────────────┘
               │ taskctl (writes/reads)           │ taskctl events follow
               │                                  │
┌──────────────▼───────────┐                  ┌───▼────────────────────────┐
│ SCHEDULER                │                  │ SUBSCRIBER                 │
│ `loop run`               │◀─────────────────│ `loop subscribe`           │
│ ping 60 s                │ early tick       │ debounce                   │
│ continue 600 s           │                  │ (local hub)                │
│ patrol/workflow/         │                  └────────────────────────────┘
│ poll (one lock)          │
└──────────────┬───────────┘
               │ enqueue row (handoff | question; route is a question row)
┌──────────────▼───────────────────────────────────────────────────────────┐
│ CARD QUEUE + STATE (durable files beside --state)                        │
│ cards.queue.json · sessions.state.json · subagents.state.json            │
│ workspaces.json · deferrals.json · SLA/workflow ledgers · locks          │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ drain — only the pool opens, resumes or closes a lane
┌──────────────▼───────────────────────────────────────────────────────────┐
│ POOL  `loop session` — one process; sessions keyed by (lane, actor kind) │
│ worker:<card>:r<n>   <dir>#reviewer[@<kind>]   <dir> (director)          │
│ cwd = card worktree  cwd = target dir          cwd = project dir         │
└─────────┬───────────────────────────┬───────────────────────────┬────────┘
          │ kind=claude               │ kind=codex                │ kind=pi
  ┌───────▼───────┐           ┌───────▼───────┐           ┌───────▼───────┐
  │ Claude        │           │ Codex         │           │ Pi            │
  │ adapter       │           │ adapter       │           │ adapter       │
  └───────┬───────┘           └───────┬───────┘           └───────┬───────┘
          │                           │                           │
┌─────────▼───────────────────────────▼───────────────────────────▼────────┐
│ ROLE SKILLS (installed per kind, discovered from role.json)              │
│ jobs · linus · turing · reviewer · worker                                │
│ Claude lanes open with `/skill` + Flags; director is supervisor-only     │
└──────────────────────────────────────────────────────────────────────────┘
```

The 600-second clock is the installed `continue` unit — the *tick* this page names.
A lane's claim, heartbeat, progress, deliver and comment all go back to the board through
`taskctl`; the board's activity event then reaches the subscriber through the local hub and
comes back as an early continue. That is the whole loop.

What the shape makes visible:

- **The clocks are the only triggers.** One supervisor per machine; the `taskd` guard keeps
  the board process alive but never ticks the loop. A lane is woken by a queue row, and a
  queue row exists only because a pass wrote it.
- **The passes decide, the lanes run.** The scheduler and subscriber are plain code — no
  model turn is spent deciding what to dispatch. The only LLM turns are the worker, reviewer
  and director lanes.
- **The queue is the only handoff.** A row is `queue_kind: handoff | question`; an unowned
  card's route row is a question row (`route: true`), not a third kind. Only the pool opens,
  resumes or closes a lane.
- **No arrow skips a layer.** The board is the source of truth, `taskctl` is the only way to
  it, and the subscriber is a latency path: the 600-second continue is the fallback that
  keeps working when it is not installed.
- **The supervisor holds no card state.** Everything it knows durably is in the queue and
  state files; everything authoritative is on the board. That is why a restart resumes
  rather than re-decides.
- **The one-shot deployment stops at the pool.** Without a resident pool the continue clock
  still runs patrol and workflow, but poll claims nothing, so no row ever reaches a lane.

The read-only verbs — `loop status`, `loop doctor`, `loop console` — read the state files and
the board; they are not slots in the pipeline.

Two execution shapes serve the same model:

- **resident** (default on launchd/systemd): `taskctl loop session` runs a long-lived *session
  pool* — one *worker session* per card, a reviewer lane per directory and a director lane
  per project. Poll claims a card and **enqueues** the handoff; the pool opens or resumes the
  card's own session, so a same-round re-dispatch continues the worker that already holds
  the context.
- **one-shot** (cron, or an agent kind with no session service): each tick cadence runs the
  passes in-process but, with no resident pool, poll claims nothing and worker/reviewer
  dispatch is paused — see [No resident pool: what still runs](#no-resident-pool-what-still-runs).

What the supervisor does **not** own: the board's data, the review decision and the
acceptance authority. Those belong to the board, the
[`meerkat`](../skills/meerkat/SKILL.md) skill and [acceptance.md](acceptance.md). This page
stops at the boundary of the supervisor.

**How to read the rest** — the whole picture
([the architecture](#the-architecture-in-one-picture)); the model ([two clocks](#the-two-clocks),
[time contract](#the-time-contract)); the question timeline
([the question lane](#the-question-lane-end-to-end)); dispatch
([atomic claim](#atomic-claim--the-single-dispatch-source),
[the cost gate](#the-cost-gate-a-worker-turn-starts-only-on-fire),
[the session pool](#the-resident-session-pool)); the decision lane
([the director](#the-director-lane)); liveness and SLA
([heartbeat](#fresh-heartbeat-is-a-no-op-a-broken-one-is-never-silent),
[the rest of the table](#the-rest-of-the-sla-table-the-same-pass-five-more-rows)); delivery
([the workflow channel](#the-workflow-channel-review-acceptance-and-containers),
[role skills and platforms](#role-skills-and-platform-routing)); runtime
([where a worker runs](#where-a-worker-runs),
[where the supervisor runs](#where-the-supervisor-runs),
[the agent kinds](#the-three-agent-kinds-how-each-one-is-triggered)); operations
([enabling](#enabling-the-supervisor-opt-in), [running](#running-the-supervisor),
[verifying the hook](#verifying-the-generated-hook)); and the policies every deployment
shares ([claim-unassigned](#the-claim-unassigned-policy),
[end to end](#the-end-to-end-path)).

The director is a skill of its own, and the five role skills ship beside it. `install.sh`
puts the director, the chat console, `setup-meerkat` and a fresh install's roles on the
**primary kind**; an upgrade refreshes each role on the kind(s) that already carry it.
OpenClaw installs the board skill only, because its agent framework runs the equivalent
automations itself (see [OpenClaw: no loop units](#openclaw-no-loop-units)). The runtime
finds the director by scanning the installed skills trees, never from a config value.

## The two clocks

The supervisor is a **scheduler**. It owns two clocks and performs no board I/O
outside the deterministic passes. The passes — poll, patrol, workflow — live in
separate `taskctl loop` verbs, and the supervisor runs them **in process**.

| | **ping** | **tick** | **session** |
|---|---|---|---|
| Cadence | 60 seconds | 600 seconds (10 minutes); the installed unit is still named `continue` | long-lived |
| Job | process liveness: prune worker registry entries whose pid is gone | run `patrol → workflow → poll` under one single-flight lock | hold each card's worker session, each directory's reviewer lane and each project's director lane; route queued rows to them |
| Reads | `supervisor.state.json` only | the board, through the passes | the queues, the ledger, `sessions.state.json` |
| On a hit | — | the supervisor claims and enqueues; the pool opens or resumes the matching session | drains the queue; a worker/reviewer/director session runs the handed-off work |
| Cost | one small file read | no model turn | one agent conversation per active lane |
| Why it exists | a dead worker must not pin a concurrency slot | claim and dispatch are deterministic state work, not a judgment | a session is bound to its launch cwd, so a card needs a session opened in its worktree |

The split is deliberate. A 60-second clock that read the board would be a poll
again; a 10-minute tick that runs the passes is bounded and needs no model. On
launchd/systemd the **event subscriber** (`taskctl loop subscribe`) follows the local event
hub through `taskctl events follow` and asks for an **early tick** when a dispatch-relevant
event arrives, so a new card or a completed dependency is seen within seconds; the hub owns
the host's single board connection and its reconnect ladder, and the subscriber's `follow`
child sees the same records `events tail` would. It is part of the enabled set, not a
separate switch, and it is a **latency path only**: the tick clock remains the fallback and
the only path for time-based work (stale claims, review aging, SLA tiers), and an event
wakes a tick only while a resident pool is live. On cron — which cannot host a long-lived
process — discovery stays at most one tick cadence. `--continue-interval` is still the lever
for that fallback.

The deterministic passes are **not scheduled individually**:

| Entry | Job | Writes |
|---|---|---|
| `taskctl loop poll` | scan → atomic claim → **enqueue the handoff**; also enqueues open agent questions and the 30-minute routing fallback (the director's queue) | claims, card queue |
| `taskctl loop patrol` | heartbeat alerts + SLA rows | card queue only with `--patrol-llm=yes` |
| `taskctl loop workflow` | apply the board's workflow plan (`issue reconcile --workflow`) | review actions, as `system`/`Orchestrator` |

`taskctl loop doctor` is **not** one of these passes. It is the read-only inspection a human
runs: one report covering the supervisor verdict, the resolved scan set,
the patrol's last-successful-run marker, the tail of the supervisor log, the queue and the
worker/reviewer ledger, the worker sessions and their resume state, the cards that look stuck (a stale or unreadable heartbeat, judged by the patrol's own
plan — an `epic` container is not a stale worker), and the `in_review` cards waiting on a human
with their age. That last list is **facts
only**: review aging is the workflow pass's judgement and applies to review cards that are
*not* `in_review` (`docs/lifecycle.md`), so the inspection neither restates nor widens it.
A third list, `blocked_acceptance`, names the cards carrying `meta.accepted_by` for their
**current** round while still `in_review` — an acceptance the board refused, which the round
bump of the routed reopen otherwise turns invisible. A fourth section, `looping`, names the
cards that keep going round the same loop, from the snapshot and the rows already read:
**rework rounds** (`delivery_round >= 4`, i.e. the work came back three times),
**review reopens** (a review card at the workflow's re-dispatch bound — `meta.review_retry >= 2`
or its own round `>= 3`), **dispatch retries** (five handoffs for one card, or two handoffs that
each exhausted their attempt budget, inside the queue's 24 h retention), **worker and
subagent failures** (three `failed`/`interrupted`/`stale` ledger rows for one card inside the ledger's
7-day retention), **deferred admission** (three consecutive card-scoped admission
failures in `deferrals.json` — the card is never enqueued, so no queue row can show it),
**held** cards (a `blocked` card carrying `meta.loop_hold_code`: the cycle, its E-code, the
round it was held at and its age — the loop already stopped, so this is the human's queue),
**awaiting** cards (reason and age), **question-lane** cards (a director row that exhausted
its two attempts, with the last error and lane), **unowned** `todo` cards past the route
window, and **orphaned** rows (a processing handoff whose agent child is alive past twice the
turn timeout — read-only, because re-dispatching under it is exactly what must not happen). A
card the board snapshot knows is `done`/`canceled` is dropped from the three local halves;
when the board cannot be read those halves still report, and a truncated board
read makes the two board-derived lists a lower bound (the board line says `TRUNCATED`).
A `workspaces.json` record for a non-terminal card whose worktree is not a checkout **and**
whose branch no longer resolves is reported separately as `stale_workspaces`; it can no longer
be landed and must not seed a rework.
`looping.total` counts **distinct cards** — one card may appear under more than one kind.
These are current-state readings only: a worker pulsing a fresh heartbeat without progress,
claim/release or `blocked`/`awaiting` churn inside one round, and activity-level oscillation
are not counted — the first belongs beside the stale-heartbeat rule, and the rest would need
the activity trail rather than the card row. The inspection claims, dispatches, starts and
writes nothing — its board read runs with autostart disabled — and it exits 0 whenever a
report was produced, so a scheduled inspection reads `attention` from `--json` rather than an
exit code.

The tick runs them in the order **patrol → workflow → poll**: the workflow pass dispatches
a review card, and the poll that follows in the same tick can enqueue its reviewer
immediately. Polling first would delay that review by a whole cadence.

## The time contract

The clocks below are not independent knobs: each one is a bound on another, and the
inequalities are asserted in `test/orchestrator/time-contract.test.mjs`. `--session-turn-timeout`
is validated at parse time (`1200 ≤ turn < 7200` seconds; the default is `1800`).

| Clock | Default | Where |
|---|---:|---|
| agent turn timeout | 30 min (`--session-turn-timeout`) | `src/orchestrator/options.mjs`, `src/orchestrator/session.mjs` |
| worker heartbeat interval | ≤ 10 min | worker handoff (`src/foundation/scheduling.mjs`) |
| `HEARTBEAT_FRESH_MS` | 10 min | `src/foundation/constants.mjs` |
| `CLAIM_STALE_SAME_MS` | 30 min | `src/foundation/constants.mjs` |
| `CLAIM_STALE_ANY_MS` | 6 h | `src/foundation/constants.mjs` |
| patrol stale (scans `in_progress` work cards; an epic container is excluded) | 30 min (= `CLAIM_STALE_SAME_MS`) | `src/foundation/scheduling.mjs` |
| tick interval (the `continue` unit) | 10 min | `src/orchestrator/options.mjs` |
| queue `recoverStaleCards` | `2 × turn` | `src/orchestrator/session.mjs` |
| pool `wedged` verdict | `turn + POOL_WEDGE_MARGIN_MS` (default 32 min) | `src/foundation/loop-state.mjs` |
| ping kill deadline (the only authority) | `wedged + POOL_KILL_GRACE_MS` (60 s); starting at `POOL_START_BUDGET_MS + 60 s` | `src/foundation/loop-state.mjs`, `src/orchestrator/supervisor.mjs` |
| pool start budget / reattach bound | 5 min / `min(turn, 120 s)` | `src/foundation/loop-state.mjs`, `src/orchestrator/session.mjs` |
| `runCli` spawn bound | 60 s (`CLI_TIMEOUT_MS`) | `src/orchestrator/runtime.mjs` |
| admission deferral backoff | 30 s → 1 h, from the 3rd failure | `src/orchestrator/deferrals.mjs` |
| ledger live-row reap | 2 h (`LEDGER_STALE_MS`) | `src/foundation/scheduling.mjs` |
| pool heartbeat / stale | 15 s / 90 s (6 beats) | `src/foundation/loop-state.mjs` |
| project idle / session max age | 30 min / 24 h | `src/orchestrator/options.mjs` |

The contract:

- `HEARTBEAT_FRESH_MS < CLAIM_STALE_SAME_MS < CLAIM_STALE_ANY_MS` — a claim is fresh longer
  than a worker is told to pulse, and a takeover is later still.
- `2 × HEARTBEAT_FRESH_MS ≤ TURN_MIN` and `TURN_DEFAULT < LEDGER_STALE_MS` — a turn covers two
  pulse windows and still ends before the ledger reclaims a live row.
- `CONTINUE_INTERVAL < TURN_DEFAULT`; `PATROL_STALE_MS = CLAIM_STALE_SAME_MS`;
  `POOL_STALE_MS > POOL_HEARTBEAT_MS`.
- `sendDeadlineMs > turn` and `killDeadlineMs = sendDeadlineMs + POOL_KILL_GRACE_MS`; the
  starting phase's kill deadline is `POOL_START_BUDGET_MS + POOL_KILL_GRACE_MS`. A legitimate
  turn is never a kill, and the ping waits one more minute after the verdict says `wedged`.
- `CLI_TIMEOUT_MS = 60 s` is the outer child bound and is longer than the CLI's own 30 s HTTP
  bound (`REQUEST_TIMEOUT_MS`), so a slow board is not a hung one.

**`awaiting` is exempt from three scans**, by design:

- `planPatrol` scans `in_progress` only, so an awaiting card never produces a stale-heartbeat
  alert — it holds a *dormant* claim;
- `issue candidates --stale` returns `in_progress` recoveries only, so an awaiting card is
  never offered as a stealable claim;
- the ledger's live-row reap is age-based, so a stopped worker's concurrency slot is
  reclaimed by the 2-hour bound at the latest regardless of which state the card is in.

The `question_stale` SLA row is the one reader that deliberately looks at an awaiting card:
it ages the human wait and notifies the leader. It never moves the card (the SLA is
notify-only).

After a human answers, the card is `todo`; `task_resumed` is a dispatch event, so the
subscriber wakes a continue turn within its one-minute floor (the plain 10-minute continue
clock remains the fallback when the subscriber is not installed). That delay is the event
floor, not a new clock. The same holds for a worker's own `question`: `comment_added` with
`kind: "question"` wakes the question lane immediately, and the director's release
(`in_progress → todo`) wakes the worker's same-round resume.

## Liveness bounds: every cycle has a stop

The clocks above say *when* the passes run. This section says *when they stop*. Every retry
in the loop has a counter with one home and a defined action at its bound; a card that
reaches the bound is parked for a human, never cancelled and never silently dropped. The
policy is ADR [0009](adr/0009-a-cycle-stops-at-a-human-decision.md).

| Cycle | Counter (home) | Bound | At the bound |
|---|---|---|---|
| Deliver → review → rework | `delivery_round − meta.loop_hold_round` (board) | `--rework-max-rounds` = 4 | `hold_card`: question + `blocked/decision` + close the review |
| Review verdict unappliable | `meta.review_retry − meta.loop_hold_retry_base` (board) | 2 | `hold_card` on the original + `close_review` |
| Card handoff turn | queue row `attempts` | 3 | row `failed`; execution hold |
| Crash recovery | queue row `recoveries` | 3 | row `failed` + card `blocked/resource` |
| Admission failure | `deferrals.json` `count` | backoff at 3 (30 s→1 h), hold at 5 | `blocked/external` + `Orchestrator` question |
| Dispatch failure after a claim | `deferrals.json` `DISPATCH_FAILED` | 3 | claim released immediately; `blocked/resource` at the bound |
| Worker session unrestorable | session record | first failure | row failed, claim released, `blocked/resource` |
| Question turn | director row dispatches | 2 | left for the human; `question_stale` + doctor |
| Route turn | route row dispatches | 2 | the card is parked `blocked/decision` (never assigned) |
| Wedged pool | `sessions.state.json` `tickStartedAt` / `startStartedAt` | verdict at `turn + POOL_WEDGE_MARGIN_MS` / start budget; ping acts 60 s later | one `pool_killed` + SIGTERM, recorded in `pool-wedge.json`; SIGKILL on a later ping if it survives; the unit restarts it |
| Hung `taskctl` | `runCli` | 60 s (`CLI_TIMEOUT_MS`) | the child is killed with SIGKILL; the pass fails and releases the tick lock |

**The hold is an epoch, not a latch.** `meta.loop_hold_round` records the round the card was
held at; the next hold is due only after another full bound. A human who moves the card back
therefore gets a fresh bounded run — never an unbounded one — and a `held: true` re-emission
recovers a crash between the marker and the move.

**Why `blocked`, not `awaiting`.** `awaiting` is reachable only from `in_progress`, while a
looping card is normally `todo` or `in_review`; a two-hop move into `in_progress` would
fabricate a claim with no owner. `blocked` is legal from every active status and is watched
by the SLA's `blocked_clarification` row (120/1440 min), so a held card is never invisible.
The requested E-code rides in the `question` comment and `meta.loop_hold_e_code`.

**The pool has five live verdicts.** A live pid is always `live: true`; `starting`,
`running`, `busy` (a dispatch tick is in flight), `unresponsive` (heartbeat stale) and
`wedged` (`starting` past the start budget, or `tickStartedAt` past `turn +
POOL_WEDGE_MARGIN_MS`) say which kind of live it is. Only `gone` — a dead pid or a start-token
mismatch — is absent, and the heartbeat never decides it. A second pool is refused in every
one of them, and only `wedged` is acted on by the ping clock — `starting` and `unresponsive` may
still recover. The verdict is not yet permission to kill: the ping acts one minute later
(`POOL_KILL_GRACE_MS`), SIGTERMs once, and SIGKILLs only if the same pool survives to a later
ping; the wedge identity is recorded in `pool-wedge.json` so one wedge is acted on once. No
in-process timer kills or exits a pool — a blocked event loop would not run it, so the ping,
a separate process, is the sole authority. `lastTickOkAt` is display only: a fast-failing tick
is degraded, not wedged. A row whose agent child is alive is never recovered:
`recoverStaleCards` reads the session record, so a SIGKILLed pool cannot put a second worker on
a card its orphan still holds. The one verdict is `poolVerdict` and the one kill decision is
`wedgeKillAction`, both in `src/foundation/loop-state.mjs`.

## Atomic claim = the single dispatch source

The board, not the supervisor, decides who gets a card. A claim is
compare-and-swap in SQLite (`issue claim`, or `issue move … in_progress` for a
`todo` card), so when several agents (or several supervisor ticks) race the same
card **exactly one claim succeeds**; every loser gets a conflict and, crucially,
**no worker is started**. That is what makes the claim the *only* dispatch path —
a supervisor never "reserves" a card out of band, never wakes a worker for a card
it did not win, and never claims success on a failed spawn.

`issue claim` is also the **stale-recovery** path. A claim is not always a
transition: re-taking an `in_progress` card does not change its status, so the
move route (whose table has no `in_progress → in_progress`) cannot express it.
The thresholds are layered:

- the same holder may re-claim after **10 minutes** (refreshing ownership/heartbeat);
- only after **30 minutes** does the card enter the `issue candidates --stale`
  recovery pool;
- any agent may take over after **6 hours**, and a takeover writes a `change` comment.

The supervisor runs with `--recover-stale=yes` by default, adds `--stale` to the
candidate read, and claims every candidate through `issue claim` — one path for
ready and recovered work. Discovery and ownership are separate: the candidate read
only *finds* stale cards; `issue claim` (backed by the board's CAS) is what
transfers ownership.

SLA patrol measures and alerts; by default it moves nothing. `--patrol-llm` is its
only authorized move path — and that path is `move`, not `claim`: ownership changes
always go through `issue claim` and the board's CAS.

This is also why worker dispatch needs no lock file: the service model is
single-writer and the CAS already serialises dispatch. Two entries racing each
other is wasteful, not incorrect — the loser's claim is refused. The tick does
have a single-flight lock (`continue.state.json`), because a second overlapping
tick would double-scan and double-enqueue; the lock is separate from the worker
registry so it never consumes a concurrency slot.

### Idempotent wake + a concurrency cap

Waking must be safe to repeat, or a re-run of a tick (or an overlapping cron
line) double-starts work. Guards:

- **De-dup by card.** In the resident path the card queue coalesces a
  `(card, role)` pair that is still pending or processing; a card offered twice
  in one tick (the public pool, read by every agent) is claimed once. The legacy
  one-shot path keeps the process registry (`supervisor.state.json`: card →
  `{agent, pid, startedAt}`) for operators who still use it.
- **Cap by count.** Poll's claim budget is
  `max-concurrency − live subagents − queued cards` (default 8), and each project
  directory has its own cap (`--project-concurrency`). Workers and reviewers draw
  from the same budget — there is no per-role reservation; whichever cards are
  offered first take the slots. The candidate read is **weight-ordered**, so
  "first" means the highest-weight card (tier, then priority, time in status,
  age, SLA pressure and downstream fan-out), not the oldest one. A full fleet
  defers candidates rather than piling up handoffs.
- **Crash recovery.** The **ping** clock prunes the legacy registry of pids that
  are gone every 60 seconds. The resident path releases a slot from the ledger:
  every live row is either a turn in flight or an orphan, so a row whose last
  sighting outlives the 2-hour bound is marked stale and its slot freed; a
  stalled queue entry is requeued up to three attempts, then failed and left to
  the board's stale-claim recovery. A **retried** handoff (and every card of a
  failed or timed-out turn) re-reads the card first: one that has already left
  `todo`/`in_progress` — the worker delivered just before the interrupt — is
  completed locally instead of being re-dispatched. A timed-out turn also closes
  its session rather than reusing it. A **successful reviewer batch** that reports no
  subagent id for a card follows the same rule against a weaker test: a card that
  has left `todo` — including one still `in_progress`, which is where a missing id
  usually comes from — is completed locally as `handoff already in flight`,
  because re-dispatching it would put a second worker on the same card. Queue
  rows are terminal-aware: `requeueCards` and `completeCards` never rewrite a
  retained `done`/`failed` row, so the three-attempt bound belongs to the row
  that is actually in flight.

## The cost gate: a worker turn starts only on fire

Waking a worker for every candidate on every pass would burn money on the work
that is not ready. So the scan is a **plain CLI process** —
`taskctl issue candidates` — with no model attached, and a worker turn starts
**only when the scan produced work and the claim succeeded**:

```
poll entry
 ├─ resident?  sessions.state.json: pool pid + fresh heartbeat → no? claim nothing, alert once
 ├─ scan       taskctl issue candidates …        → no candidates? stop. 0 handoffs
 ├─ budget     max-concurrency − live − queued   → 0? defer, claim nothing
 ├─ admit      project → target_dir + per-project cap → no directory? defer before the claim
 ├─ brief      register the watch → .meerkat/<id>/card.md → failed? defer unclaimed
 ├─ claim      taskctl issue claim …             → refused? stop. no handoff
 └─ enqueue    cards.queue.json (handoff, worker_key, round, target_dir, role)
                     ↓
                worker session (cwd = the card's workspace) → one card  ← the tokens
```

A **card-scoped** admission or brief-watch failure is recorded in `deferrals.json`; a
successful admission clears the streak. Budget, no-pool and per-project-cap defers are
backpressure, not a stuck card, and are not counted. Three consecutive failures raise one
`Orchestrator` card comment (see "Deferred admission" below).

The tick itself costs **no model turn**: it is deterministic code, and the claim gate above
decides whether any conversation is opened. The worker session's turn — one per card — is
the cost, and it buys a conversation that starts, and on a same-round re-dispatch resumes,
in the card's own workspace. The director is the only other LLM lane, and it runs only when
a question, route or escalation row exists. `--dry-run` prints the plan and starts neither a
claim nor a session.

## The resident session pool

A session is bound to the **cwd it was launched with**: an agent tool that spawns a
subagent takes no per-call directory (Claude's `Agent` ignores `cwd`), and a main session
that `cd`s later does not move the subagents it already spawned. One board-wide session
cannot give two cards two workspaces — so the pool keeps **one top-level worker session per
card**, opened in the card's own worktree, and resumes that same session when the card
comes back. A review card gets a **reviewer session in the same directory**, opened with
the `reviewer` role: the allowlist that excludes `Write` is per session.

```text
session pool (`taskctl loop session`, one process, sessions keyed by actor kind)
├── worker session         cwd = the card's workspace       (one per card, per kind)
│     (kind, worker:<card>:r<round>) — resumed by session id
├── reviewer session       cwd = the same target_dir         (one lane per dir, per kind)
│     (kind, reviewer:<dir>) — batch prompt, no Write
└── director session       cwd = the project directory       (one lane per project)
      (primary, director:<dir>) — meerkat-director, question/route/escalation rows
```

- **No control session.** The supervisor process runs the passes itself; nothing in the
  pool executes `patrol|workflow|poll` and nothing wakes an LLM just to tick.
- **Residency is the pool's own timers.** The tick, question and heartbeat timers are
  ref'd in every deployment shape — the installed daemon, a `--take-over` pool, a hand-run
  `loop session`. Agent children are created lazily, so a fully idle board has none; the
  manager still stays resident and keeps its heartbeat fresh. `KeepAlive` /
  `Restart=always` is recovery, not residency, and `--control` changes none of this.
- **Worker sessions** — keyed `(actor_kind, worker:<card>:r<round>)` and opened from the
  machine-local `projects.json` at the config root (`local_path ?? run_dir`, through the
  same `resolveWakeDir` the glue uses). A card whose project is unmapped or names no
  directory is **deferred before the claim**, so the board never shows a claim that has
  nowhere to run. The handoff tells the session it is the card's own worker — not a
  subagent of a shared conversation — and that the supervisor holds the claim. The role
  skill loads once, when the session opens: Claude receives a `/<role>` message with a
  `Flags:` line; Codex receives the skill entry as `developerInstructions` on
  `thread/start`/`thread/resume`; Pi receives it as an appended system-prompt file. The
  handoff is then a thin task envelope (brief, plan, board moves, no role layer). On an
  inline kind the envelope carries the `Flags:` line itself, because no opener message
  exists to carry it. The session's cwd is the card's admitted worktree, and its id is
  persisted **before** the turn so a crash can resume it. The key includes the actor kind: a
  role migrated between platforms never resumes the old platform's native session. A changed
  installed skill reopens the lane the same way on every kind.
- **Reviewer sessions** — keyed `(actor_kind, reviewer:<dir>)`, opened only when a review
  card is queued and evicted by the same idle clock. The reviewer skill loads at open by the
  kind's mechanism (`/reviewer` on Claude, developer instructions on Codex, an appended
  system prompt on Pi). The batch prompt is the reviewer variant: no question ladder,
  verdict-only. Each review card is one subagent with its **full** review handoff — a
  subagent does not inherit the parent's loaded skill, so the review protocol and the role
  path must be in that first context. The allowlist is real for Claude and Pi; Codex and
  other adapters have no per-role tool surface, and the pool logs a one-time warning for
  them.
- **Director session** — keyed `(primary, director:<dir>)`, opened only when a question,
  route or escalation row is queued. It is the one LLM decision lane: it assigns unowned
  cards, answers worker questions with a `note` + `todo`, or escalates E1–E5 with
  `awaiting --awaiting-reason --question`. It never claims, never implements and never
  moves a card to `done`. It runs on the kind that carries the director skill (the primary
  kind first, then the configured kind order — discovered at session open, never from a
  config value that names the skill). The lane signs every board write as `Director` —
  `--agent Director` on the opener and on every per-turn row, the same shape a worker uses.
  The director skill loads
  once, at session open (`/meerkat-director` on Claude, developer instructions on Codex, an
  appended system prompt on Pi), so each later turn carries only the rows. A missing skill
  falls back to naming the decision-policy path in every prompt.
- **Resume and replay** — a same-round re-dispatch (a human answer to an `awaiting`
  question, same-round rework, crash recovery) opens the stored session id **in the same
  actor kind** and sends a **resume** prompt carrying the answer or reason, in the same
  workspace. A **round bump**, a recreated workspace or a role migrated to another platform
  is a new generation: the old record is retired and the card starts fresh. When the native
  session is gone (expired, deleted, or the resume is rejected), the pool replays a
  **bounded, supervisor-owned transcript** — the last 12 worker turns, at most 8 000
  characters — into a fresh session in the same workspace and marks the record
  `resumed_by_replay`. If replay fails too, the record is `stale`/`blocked`, the queue row
  fails, and the doctor raises it. The supervisor never silently starts a second worker for
  a card whose session it could not restore.
- **Ledger** (`subagents.state.json`) — the application-level record of each reviewer
  subagent: `sessionKey` (the project directory), `lane` (`worker`/`reviewer`), actor kind,
  subagent id, role, card, status. A worker session writes only a **terminal** audit row
  (`type: "worker-session"`) when its turn ends; its live concurrency slot is the
  processing queue row, so one worker turn is never counted twice.
- **Capacity** — `--max-concurrency` bounds worker sessions and running reviewer
  subagents together; poll's claim budget is `max-concurrency − live subagents − queued
  cards`, and at zero it claims nothing and says so. The supervisor reserves no slots per
  role, so a review backlog may take the whole cap. The **director lane does not consume a
  worker slot**; it is bounded by `--project-concurrency`, so it cannot starve workers.
  When open worker sessions reach the cap, the pool closes the **least recently used idle**
  one and keeps its session id, so the next dispatch resumes it. `--session-pool-max` (8)
  bounds the non-worker lanes (reviewer and director sessions) and does not count worker
  sessions; `--project-concurrency` (default `--max-concurrency`) still caps one project's
  in-flight cards across its worktrees. An idle worker closes after `--project-idle-ms`
  (30 min) and keeps its session id; past `--session-max-age` (24 h) it is marked
  `needsReplay`, so the next dispatch replays rather than starting a silent new worker.
  `--session-max-age` on a reviewer or director lane opens a fresh conversation.
- **Concurrency and the working tree.** Planning and claiming are sequential; the worker
  turns then fan out, so one slow card does not serialize the others. The per-tick
  budget is fixed before the first send, and `--project-concurrency` counts a project's
  worktrees and all of its worker sessions as one project. Each card in a git project runs in its own
  worktree (see "Per-card workspace isolation" below); `--workspace=shared` is the explicit
  opt-out and logs one warning per directory when parallel cards share a git checkout.
- **One lock** — a second `taskctl loop session` on the same state directory is refused
  (`session.lock`). The pool writes a heartbeat every 15 s so a pass in another
  process can tell "busy" from "gone".

### Per-card workspace isolation

The supervisor creates a git worktree for every card in a git project
(`.worktrees/<ref>[-r<round>]` on branch `lane/<ref>[-r<round>]`) and points the queue's
`target_dir` at it. Every base ref is **probed** (`rev-parse --verify --quiet`): the
project's declared `base_ref` first (a missing one is `WORKSPACE_BASE_UNRESOLVED`, not a
silent fallback), then the most recent previous round's lane branch that still resolves,
then the current branch. A previous lane branch whose work was merged and deleted therefore
falls back instead of failing every pass on `invalid reference`. A rework that repairs a
missing current-round record re-attaches its lane branch (`worktree add` without `-b`, after
`git worktree prune`); a non-checkout directory left in the slot is moved aside to
`<path>.orphan-<epoch>`, preserving its contents. A review whose original workspace is gone is
deferred (`WORKSPACE_REVIEW_TARGET_MISSING`) — it never runs in the shared checkout, where a
write would block that project's landing. A creation failure defers the card; there is no
fallback to the shared checkout. `--workspace=shared` restores the old behaviour explicitly.

The patrol drops a **non-terminal** registry record only when its tree is not a checkout and
its branch is gone *and* the probe could actually run; a transient git failure keeps the
record. A surviving branch holds unmerged work and is never discarded by the sweep alone.

The per-project cap counts a project's worktrees as one project (`--project-concurrency`),
not one directory. Acceptance **lands** the work: the lane branch is merged into the
project's current branch before the card reaches `done`; a dirty project checkout or a
merge conflict keeps the card in `in_review` and leaves the worktree and branch for a human.
Cleanup (worktree first, then the merged branch) happens only when the card is terminal.
A card a human closes directly is merged by the patrol before cleanup, under the same
`merge_ref` check; a project on another branch, or with no registered target, keeps the
worktree and is logged for a human rather than merged on a guess.

Landing covers the lanes **admission created and registered** in `workspaces.json`. A worktree
a session makes for itself (`using-git-worktrees`, any `.worktrees/<slug>`) is never in that
registry, so accepting its card merges nothing: the pass logs `has no lane record`, and `done`
means *accepted*, not *merged*. `loop doctor` reports those cards as `unlanded` (branch still
outside the project's current branch), which is the only place they surface.

### Session worktrees: the human half

A live session's tree is not a card lane. `taskctl worktree` owns it locally: `create` makes
`<project>/.worktrees/<slug>` on a `<type>/<slug>` branch; `status` reads `git worktree list`
(the only registry — there is no session equivalent of `workspaces.json`); `leave --remove` and
`sweep` delete only a **clean** tree whose branch is already an ancestor of the project's
`merge_ref`, and report every survivor instead of forcing it. The command refuses a `lane/`
branch: the loop owns that namespace, and its acceptance/patrol sweep owns its lifecycle.

A project opts into the write guard by carrying `docs/agents/worktrees.md`. setup-meerkat's
Step 4 writes it and, only if the user accepts, merges the runtime adapters: Claude and Codex
`PreToolUse` → `taskctl worktree guard`, pi a `tool_call` extension. The policy allows a linked
worktree and denies a write to the protected primary checkout with the recovery command. It is
a **guardrail, not a sandbox**: Claude project hooks can be disabled, Codex hooks need trust
(and its `workspace-write` sandbox is the stronger boundary), and pi has no sandbox at all.
Shell matching is best-effort; a script or a Node process can bypass it. The initialization
lives only in setup-meerkat, never in `install.sh`.

### No resident pool: what still runs

The pool is the only dispatcher, so without it a claim has nowhere to go. The
fallback is deliberately smaller rather than silently degraded:

| Piece | Without a resident pool |
|---|---|
| `poll` | **claims nothing**, scans nothing, logs why; one `--notify` alert per cadence (`kind: no_resident`) |
| one-shot tick | runs **patrol + workflow only**; poll is skipped |
| `patrol --patrol-llm=yes` | no action is enqueued (there is no lane to run it) |
| `workflow` | runs; review cards accumulate and are claimed once the pool is back |

This is the cron shape: cron cannot host a long-lived process, so a cron install
runs ping + a one-shot tick and **cannot dispatch workers or reviewers**.
An agent kind with a session service gets the full supervisor. `--resident=no` forces the
fallback even when a pool is running.

### Failure modes

Every dependency's failure is named; nothing degrades silently.

| Failure | Behaviour |
|---|---|
| no resident pool | the tick runs patrol + workflow; poll claims nothing and alerts once per cadence |
| no director skill | the pool refuses to start, so no decision row runs — the failure is not silent |
| no decision policy | one warning; the generated prompt falls back to the built-in summary and decisions still run |
| a role's kind cannot start | fall back to another kind that carries the role; if none does, claim nothing for that role's cards and report |
| role skill absent | the card still runs with a plain handoff (no role layer); one warning |
| malformed `role.json` | that role is skipped with a warning; never an exception |
| tick lock held | the tick is skipped; the event subscriber keeps its early-tick request pending |
| board unreachable | the pass logs the error and claims nothing |
| worker crashed | the next tick resumes the session by id, or replays a bounded transcript; three failed recoveries park the card |
| worker session cannot be restored | row failed, claim released, card `blocked/resource` with a question — never a 30-minute re-dispatch loop |
| dispatch failed after the claim | the claim is handed back to `todo` immediately; at three consecutive failures the card is parked |
| a card keeps coming back | the board's plan emits `hold_card`; the card is `blocked/decision` with a question, and a human move starts a fresh epoch |
| resident pool wedged | `loop doctor`/`status` report `wedged`; one minute later the ping clock SIGTERMs it once and SIGKILLs on a later ping if needed (`--recover-wedged=no` opts out) |
| stale claim | `--recover-stale` offers it; the claim itself is `issue claim` |
| old roles tree / old `ROLES_DIR` shape | a directory with no `role.json` is reported as deprecated by `/setup-meerkat`; never deleted automatically. A directory of role directories is a valid custom team and replaces discovery |

## Fresh heartbeat is a no-op; a broken one is never silent

A claim carries a heartbeat. The board treats it as *fresh* for 10 minutes and
*same-holder-recoverable* after 30; these are the board's own windows, and the supervisor
enforces exactly them.

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

## The rest of the SLA table: the same pass, the other rows

A stale heartbeat is **one** row of the SLA contract's threshold table. The others —
a card parked on the leader's clarification, an unanswered confirmation gate, a
delivery nobody queued an acceptance review for, a defect whose fix card was
never created, a worker's question nobody released, and the leader's own patrol
going quiet — used to be invisible to
the same pass that watched the heartbeat. They are now covered by the **same
patrol entry**, through the repository's own inspection contract
(`docs/sla.md`), which also gives the stale-heartbeat row a channel the two
mechanisms can share and adds a row for the inspectors' own liveness — an
inspector that has stopped reads exactly like a healthy board.

What that means concretely:

- **One tuple, shared with a peer inspector.** Each alert is the flat
  26-field object of the contract (`docs/sla.md` §4): `alert_id`, `dedup_key`, `sla_row`,
  `severity`, `measure_start_at`, `threshold_min`, `due_at`, `action`, `target`,
  `evidence`, … A field means the same thing on both mechanisms, so the two can
  never label one card differently.
- **The board computes; the supervisor notifies.** `planSlaPatrol` is still the one
  decision, but it runs in the board (`GET /api/v1/sla`, `taskctl sla list|get`).
  The supervisor's patrol reads those rows, de-duplicates them against its ledger,
  re-reads a survivor (`sla get <ref>`) and notifies. `inspector_liveness` is the
  one row the supervisor computes itself, because the peer marker is a file on the machine that runs it.
- **Thresholds are the contract's defaults, overridable install-wide.** The
  table is `DEFAULT_SLA_ROWS` in `src/foundation/sla-config.mjs`; every limit
  sits next to the row it came from. `warn` is `L − P` (the mechanism's own
  period before the limit — 到点提醒, not a breach), `overdue` is `L`, `escalate`
  is the further bound. `TASKD_SLA_*` in the install-root `.env` overrides them;
  the board validates the table and publishes it (`docs/sla.md` §2.1).
- **Working hours, not wall clock.** `T` accumulates only inside the
  Asia/Shanghai 09:00–23:00 window, off-hours rolled over — a card blocked at the
  end of a working day cannot be "overdue" overnight, and a machine in another
  timezone measures the same `T`.
- **The SLA half is notify-only, always.** Every alert is addressed to the
  **leader** (`target: "leader"`; the card field is `notify_leader`, never a
  person's name). The releasability hint (`releasable` / `releasable_basis`)
  points at a card that *looks* releasable — releasing it stays the leader's `§⑦`
  action, and no code path in this half writes card state or starts an LLM turn
  for a new row. The **workflow half** ([below](#the-workflow-channel-review-acceptance-and-containers))
  is the supervisor's one writing channel, and it is a separate pass with its own plan.
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
  per-card heartbeat alert (`{type: "stale" | "heartbeat-unreadable", …}`). Both
  channels skip an `epic` container: it is never claimed and never pulses, so its
  `in_progress` is the board's design rather than a stopped worker
  (`src/foundation/task-kind.mjs`). That
  shape is a published consumer contract and keeps working exactly as before, but
  it carries no `dedup_key` and no `sla_row`, so it cannot take part in the
  shared ledger — without the tuple the two mechanisms would each notify the same
  stale heartbeat. The stale heartbeat therefore goes out twice, to two different
  channels, on purpose.
- **`inspector_liveness` is the mutual watchdog.** Every completed pass rewrites
  this mechanism's own last-successful-run marker
  (`--sla-last-ok`, default `loop-patrol-last-ok.json` beside the state file).
  Point `--sla-peer <path>` at the other mechanism's marker and a marker older
  than `3 × 15min` raises the row at `warn` — a stopped inspector otherwise looks
  exactly like a healthy board. **With no `--sla-peer` configured, the peer's
  half is a registered dependency, not an alarm**: the peer inspector's marker
  does not exist on this board yet, and alarming every pass on that would be the
  permanently-red failure this contract exists to prevent.

## The workflow channel: review, acceptance and containers

The SLA half notifies. Everything after that — accepting a delivery, rejecting it and
opening a rework, rolling a container up, splitting a card into one — used to wait for a
human. The **board** now owns those decisions; the supervisor's **workflow pass**
(`taskctl loop workflow`) executes them. It is a pass of its own, run by the
tick after patrol.

The board computes one plan through `issue reconcile --workflow` (see
[`status-lifecycle.md`](../skills/meerkat/references/status-lifecycle.md#11-the-boards-workflow-decisions) —
provenance: `src/core/domain/workflow.mjs`; the lifecycle the plan acts on is
[lifecycle.md](lifecycle.md)). The supervisor never re-derives a decision. The plan has four parts,
in this order:

1. **reconcile.** The board replays the container rules
   (`src/core/commands/rollup.mjs`) and returns the classified changes and notices.
   Normal in-flight verdicts (`children_unfinished`, `no_child_started`,
   `awaiting_acceptance`) are silent — the SLA pass already watches stuck children.
   `empty_epic` waits out a 30-minute grace period; `no_delivery_evidence`,
   `no_child_done` and `dangling_child_edge` are notified, naming the blocking children.
2. **outcomes.** The plan says what each readable verdict means for the card it audits
   (below); the supervisor applies it.
3. **auto-accept.** For every flow-A card in `in_review` whose `acceptance_mode` is `off`,
   and with no current-round review card (a canceled one does not block), the plan emits
   `auto_accept`. The supervisor writes `meta.accepted_by=loop-auto` and moves the card
   `in_review → done`. A `human` card never reaches this part — its mode is not `off`, so it
   is reviewed instead, and only the close waits for the person. Nothing is alerted for this
   state: silence is the implemented behaviour.
4. **dispatch.** For every flow-A card in `in_review` whose `acceptance_mode` is `auto` or
   `human` — review is mode-independent; only `off` is skipped — create a review card for the
   reviewer, one per `(original, delivery round)`, with the deterministic
   idempotency key `loop-review|<ref>|r<round>`. The reviewer is the local role catalog's
   `default_reviewer`, else the first reviewer-lane role (the reconcile request's `--assignee`;
   `--reviewer` is a deprecated alias).
   There is no kind filter: a finished epic is dispatched in the same pass that rolls it up,
   and its reviewer reads the child cards and the rollup report.

### The review card, and who closes it

A review card is `kind='review'` (ADR 0014), created with `review_of` (the original's
identifier or id) and, optionally, `review_round` (a positive integer), plus `meta.flow=B`
and a `review` label for discoverability. At creation the board resolves that reference and
stamps **both** the immutable structural marker (`review_of_id` / `review_round`, 0025) and
its readable mirror in `meta` (`meta.review_of` = the original's identifier,
`meta.review_round` = the integer round). Detection reads the structural column first and
falls back to `meta.review_of` for a snapshot written before 0025; the acceptance gate reads
the column only. A caller-supplied `meta.review_of` given as an id, or a string round, is
normalized to the resolved identifier and an integer, and a meta patch is canonicalized
from the column, so a later PATCH cannot make the two spellings disagree. The board's kinds
are `task`/`epic`/`review` (0038 retired `deploy`): `review_of` forces `kind='review'`, and
`kind='review'` without a marker is refused, so the type and the identity cannot disagree.

Its lifecycle cannot skip `in_review`:

```text
todo --(claim)--> in_progress --(reviewer delivers VERDICT report)--> in_review --(loop)--> done
```

`done` is reachable only from `in_review`, and a card cannot be *created* in `in_review`
or `done` (`REPORT_REQUIRED` — there is no evidence yet). So the only question was **who
applies the last transition**. The answer here is the **loop**, not the reviewer:

- the reviewer reads the original with `issue get --json` (the human form omits the
  description and the list), its acceptance list, the current round's report, the
  comment trail and (for an epic) the rollup and children. If the original carries
  `meta.acceptance_derived=yes`, it checks the list covers the description and comments — a
  list that narrows the card is grounds for `REJECT`. It ledgers the requirements, verifies
  at the report's `commit` anchor rather than the live tree, and answers every baseline item
  with a status, how it checked and an `evidence[n]` anchor; a `met` the board cannot trace,
  or an `APPROVE` with no command anchor, is refused rather than applied. It delivers a
  report whose first line is `VERDICT: APPROVE` or `VERDICT: REJECT`; it moves nothing.
- the supervisor applies the verdict as `--actor-kind system --agent Orchestrator`. An `APPROVE` on an `auto` original
  writes `meta.accepted_by=loop-review` and moves it `in_review → done`; on a `human`
  original it writes `meta.review_verdict=approve` / `meta.review_verdict_round` and leaves
  the card `in_review` for the person. A `REJECT` — in either mode — comments the findings,
  writes `meta.rework_round`, moves the card back to rework, and appends the reviewer's
  numbered must-fix items to the original's frozen acceptance (the move to `in_progress` is
  what unlocks the baseline). Each item is then an ordinary acceptance criterion: the next
  round's report template lists it and the next review card's baseline carries it, so a
  dropped finding fails the coverage gate. A `REJECT` with no numbered list appends one
  pointer item rather than nothing. Only after that does it close the review card.
- The supervisor always closes the review card it dispatched — there is no switch that could leave
  it for nobody. On a `human` card it records the round-scoped verdict and stops; the person
  closes the original through the ordinary acceptance gate.
- A reviewed card with no installed reviewer-lane role is reported at runtime
  (`dispatch_skipped`, reason `reviewer_not_configured`): the catalog resolves no default
  reviewer, so the pass names the projects that are waiting instead of refusing to start.

Why not let the reviewer close its own card (or skip the card entirely)? A reviewer that
both produces the verdict and accepts it is not a second pair of eyes, and a card is the
retryable artefact: a crash between "apply the verdict" and "close the review" is
recovered on the next pass, whereas a missing card leaves nothing to recover from. The
separation is exactly what the `review_of` card encodes — a separate card carries the
verdict, and an actor other than the reviewer applies it; the supervisor is that actor's automated
stand-in.

### Acceptance authority is enforced by the board

The separation is not only a prompt rule. `in_review → done` has a **board-level
acceptance authority**: the card's own `acceptance_mode` decides who may perform it.
`off` may be closed by the deliverer, the supervisor (the workflow pass) or a human, and
`in_progress → done` is allowed; `auto` waits for a current-round `APPROVE`, then any
actor but the one who wrote the verdict closes it — the supervisor, another agent, or a human;
`human` is a person only. A review card is the one structural exception — its reviewer
reports the verdict, and anyone but that reviewer (or a human) closes it. The **kind is not
an allow-list**: the authority is the evidence, so the board's own `system` writes carry no
extra right. There is no board-level policy and no scope matrix. The refusal is
`ACCEPTANCE_FORBIDDEN` (409) and it changes nothing. This is what makes "a worker stops
at `in_review`" a machine rule rather than a habit, and it is why the supervisor's automated
acceptance is attributable as `system`.

Two honest limits. First, the check reads the actor's **declared** id and the stored
verdict: a loopback caller is trusted and `--actor-kind human` is refused, but the board has
no cryptographic identity — an agent that omits `--actor-kind` writes as `human` by default.
Second, it is a
service-layer invariant, not a trigger: the actor is not a column of the `tasks` row, so —
unlike the delivery gate, whose evidence is the report table — no `tasks` trigger can see
it. Both limits are properties of the board's attribution model, and improving them means
authenticating agents, not adding a rule to the same layer.

### Known limits

- **The reviewer runs on the kind that carries its role.** The pool holds sessions of several
  kinds and falls back to another kind that carries the same role; if no installed kind does,
  the card is not dispatched. A reviewer installed only on a non-loop kind (for example
  OpenClaw) is not dispatched; install the role on a loop kind instead — a second supervisor
  does not help.
- **The reviewer's tool surface is enforced only where the adapter can enforce it.**
  A review card runs in its own `role=reviewer` conversation, so Claude and Pi apply
  the reviewer allowlist (no `Edit`/`Write`) to the subagent it spawns. Codex,
  OpenCode and Cursor adapters have no per-role tool surface; there the boundary is
  the prompt plus the board's acceptance authority and the supervisor's report-attribution
  check. The pool logs a one-time warning when it opens a reviewer lane on such a
  kind.

### Rejecting an epic: the fix child comes first

`rollup.mjs#assessClose` closes a container from `todo` / `in_progress` / `blocked` the
moment every child is terminal and at least one is done. Moving a rejected `in_review`
epic straight to `in_progress` therefore leaves a container that the **very next
reconcile re-closes**. So a rejection creates and links a non-terminal **fix child**
before it reopens the epic; `assessClose` then refuses with `children_unfinished`, and the
container stays open while the fix is worked. When the fix child completes, the event hook
rolls the epic back to `in_review` on the new round, and a fresh review is dispatched.
`test/cli/issue.test.mjs` proves both halves: without the fix child the sweep re-closes
the container; with it, the container stays `in_progress` and names the child blocking it.

### Cost, bounds and failure

- **No new LLM cost at patrol time.** The workflow pass runs plain CLI reads and writes;
  the reviewer is woken by the poll entry in the same tick, through the normal claim, so the
  cost gate is unchanged. A dedicated reviewer is scanned for review cards only and never claims the
  public pool; a reviewer that is also a worker keeps the ordinary lane.
- **Bounded.** At most `--workflow-max-actions` (default 20) writes per pass. Reads are
  bounded by `--board-limit` (default 500), which also decides whether the snapshot is
  truncated. When the combined outcome+dispatch slice drops work, the plan carries one
  `actions_capped` (cap / dropped / outcomes / dispatch); `dispatch_capped` remains the
  log-only dispatch-only overflow. A cap is logged.
- **Fail-safe.** An unreadable verdict, an unseen original or a conflicting verdict
  (`done` + `REJECT`) produces an alert and **no write**; the review card stays put and the
  next pass retries. A round mismatch closes the review card (`close_review`, reason
  `round_mismatch`); no configuration makes the supervisor leave it behind. A truncated board read dispatches nothing; an `original_unseen`
  found on that partial read is marked `reason: board_truncated` / `undecidable: true` (with
  its own ledger key), because the original may sit below the read cap.
- **The verdict must come from the reviewer.** The report's author is checked against the
  review card's assignee — the reviewer recorded at dispatch — by id and display name. There
  is no deployment fallback. A report written by anybody else is
  `review_report_not_by_reviewer` and is not applied.
- **A silent reviewer is not silent forever.** An **open** review card suppresses the
  original's `acceptance_card_creation` row, so a reviewer that is never woken would
  otherwise have no watcher at all. A review card in `in_review` whose report has no readable
  verdict raises `verdict_unsupported` — a `met` with no resolvable anchor, or an APPROVE
  whose report carries no `command` anchor — and is re-dispatched the same bounded way. A
  verdict that cannot be read raises `verdict_unreadable` and is re-dispatched (`reopen_review`, bounded by
  `meta.review_retry`, at most two reopens; the exhaustion alert is
  `review_retries_exhausted`). A review card that is not `in_review`
  (todo / in_progress / blocked / awaiting) older than `--review-aging-minutes` (default 60)
  raises `review_aging`.
- **Notified only when actionable.** Standing state — no reviewer-lane role installed, a
  dispatch-only cap — is logged, not sent to `--notify` on every period. Findings an
  operator can act on (including `review_aging`, an unattributable verdict and
  `actions_capped`) are notified; the ledger suppresses repeats, keyed to the state rather
  than the clock.
- **One action failing never stops the rest**; the review card is always closed last, so
  every half-applied outcome is recoverable (`original done + APPROVE`,
  `rework_round` matching a rework in progress, …).
- **A refused acceptance is routed, not retried.** The board can refuse an `approve` /
  `auto_accept` with `ACCEPTANCE_INCOMPLETE` when the original's delivery report cannot close
  the card. Re-planning reproduces the same action — the report binds its round — so the tick
  counts it `blocked` (beside `executed` / `failed` / `skipped`), comments the refused items,
  reopens the card through the same two-hop `reject_task` uses, closes the review card and
  notifies `acceptance_blocked` once per round. `docs/lifecycle.md` §4.5 has the order.
- **Idempotent.** Deterministic `--idem` keys plus the SQLite partial unique index; both
  `done` and `canceled` release the key (the index excludes both terminal statuses). The
  planner's policy is what differs: a `canceled` review is recreated, while a `done` review
  leaves the original open as `review_done_but_original_open`. Illegal transitions are
  refused by the state machine, so two overlapping passes are wasteful at worst, never
  duplicating.
- **A transient SLA alert is possible.** In the tick that dispatches a review, the SLA
  pass may not yet see the review card and can emit one `acceptance_card_creation` notice;
  the next tick suppresses it (for that round only — see below). The reverse ordering
  would delay every dispatch by a tick for no benefit.
- **Round-aware suppression.** `acceptance_card_creation` is silenced by an **open** review
  card for the **same delivery round**, or by a legacy open review card with no
  `review_round` (the conservative reading). A review card from a previous round does not
  silence a fresh delivery, which is what makes the rejection → rework → re-review loop work.
  A **closed** review card does not silence it either: a `done` one turns the row into the
  acceptance reminder (the verdict landed, the original still waits), and a `canceled` one
  leaves the standard "create a review card" action. A closed review must never be the
  original's only watcher.

### Configuration

| Setting | Flag | Env / per-kind config | Default |
|---|---|---|---|
| workflow channel | `--workflow=yes\|no` | `MEERKAT_TASKPANEL_WORKFLOW` | `yes` |
| writes per pass | `--workflow-max-actions <n>` | `MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS` | `20` |
| silent-review threshold | `--review-aging-minutes <n>` | `MEERKAT_TASKPANEL_REVIEW_AGING_MINUTES` | `60` |
| workflow alert ledger | `--workflow-ledger <path>` | — | `workflow-ledger.json` beside `--state` |

Precedence is flag → environment → per-kind config → default, the same as the claim policy.
For the board path, `taskctl` reads the same file as a layer between the process environment
and the shared `.env` (so `.env.<kind>` supplies per-agent identity and project-map defaults).
`workflow` gates the whole channel; the reviewer role gates only **dispatch** — outcomes still
run without one, so reviews already in flight can finish after the reviewer role is removed.

The reviewer for a card is the local role catalog's `default_reviewer`, else the first
reviewer-lane role. A card whose mode needs review but has no reviewer-lane role installed is
reported at runtime (`dispatch_skipped`, reason `reviewer_not_configured`), naming the waiting
projects — not as a start-up refusal. Reviewer selection is not configuration: `--reviewer` is
a deprecated no-op and `MEERKAT_TASKPANEL_REVIEWER` is ignored.

**Who closes a card is the card's own `acceptance_mode`** — `off` (the deliverer may close it,
and `in_progress → done` is allowed), `auto` (a current-round `APPROVE`, applied by the
supervisor) or `human` (a person only, after the review finishes). A card that names no mode
falls back to `auto`; there is no project-level default and no local copy to keep in step. A
project may document its creators' selection guidance in
`<project-dir>/docs/agents/create-card.md`, which the `meerkat` skill reads when it creates a
card; that document is not board data. A `human` card is reviewed like an `auto` one; the
supervisor records the verdict and stops, and it never closes the card itself. A container is
a card too: an epic is dispatched a review card like any other (its review reads the rollup
and the child cards) and is closed only after an `APPROVE`.

## Role skills and platform routing

A deployment may give its agents named roles — the standard set is **Jobs** (product
design), **Linus** (architecture, implementation and refactoring), **Turing** (verification),
a separate **Reviewer**, and the fallback **Worker**. The board never sees a "role":
Jobs/Linus/Turing/Worker are ordinary board **agent names**, so the creator, the assignee
and the report author are recorded as those names. Each role's own workflow names the work
shapes it owns; the director lane is the only content-decision authority, and no role decides
its own escalation.

Each role is a standalone **skill**, installed by `install.sh` on the primary kind (and
refreshed on whichever kinds already carry it during an upgrade):

```text
skills/<role>/
├── SKILL.md            role entry: routing branches and the workflow index
├── role.json           machine-readable identity, read by the supervisor
└── references/         branch workflows, self-check, reviewer prompt, checklist
```

`role.json` carries `id`, `agent`, `native_agent`, `lanes`, `title`, `summary`,
`responsibilities`, `boundaries`, `shapes` (the work shapes it owns), `self_check` and
`reviewer_prompt`. It must carry `"schema": "meerkat-role"`; a skill without that marker is
not a role, so a third-party skill cannot register itself as a board agent. Every referenced
path must stay inside the skill directory, including through symlinks.

**Discovery is the routing.** The supervisor scans every installed kind's skills tree
(`<home>/<agent-dir>/skills/*/role.json` for claude, codex and pi) and merges by role id.
Each hit records the kind that carries it. The effective platform is the supervisor's
**primary kind** when the role is installed there, else the first kind that carries it in
the configured order `MEERKAT_TASKPANEL_AGENT_KIND_ORDER` (install writes the `--target`
order; the default is claude → codex → pi). At dispatch, an adapter that cannot start falls
back to another kind that carries the same role; if none does, the card is left unclaimed
and reported. Installation location is the routing; the only other configuration is that
preference order — there is no platform-mapping key.

**Two layers.** The supervisor routes by the card's assignee and puts the role's title,
responsibilities and boundaries into the full handoff (layer 1); a resident worker session
has the role's `SKILL.md` loaded from the **selected kind's** skill directory at session
open, and reads `self_check` from the same directory before acting (layer 2). The inline
forms are verified against codex-cli 0.161.0 (`developerInstructions`) and pi 1.4.0
(`--append-system-prompt` reads an existing file path). The reviewer's
prompt is inlined at the start of the review handoff,
bounded at 2,400 characters. Every role is told to write and maintain
`.meerkat/<identifier>/plan.md`, which the reviewer reads.

**Routing.** The routing table is generated from each **worker-capable** role's `shapes`; there
is no separate `ownership.md`. The Reviewer is never routed: review cards are created and
assigned by the supervisor. Routing happens when the card is created — its assignee is the
role — and a worker session does not re-route. A card that still lands unowned past 30 minutes is the
**director's** fallback: poll enqueues a route row carrying the generated table, and the
director assigns it. With `claim_unassigned: no` the workflow pass reports such a card as
`unowned_todo` instead.

**Decisions.** A worker does not decide an unauthorized question: it writes an agent
`question` comment on the `in_progress` card and **holds** the turn with
`taskctl issue wait <ref> --question <id>` (bounded, default 110 s, max 540 s). Poll's
question lane wakes on the question (`comment_added`, `kind: "question"`) and enqueues a
**director row**; the director answers operationally with a `note` and **releases** the card
to `todo`, or escalates to the human with
`issue move <ref> awaiting --awaiting-reason E1..E5 --question "..."`. The pool routes
question rows on their **own interval**, not inside the dispatch tick: the tick awaits every
worker turn, and routing from it would serialize the answer behind the very hold it unblocks.
The full timeline is [the question lane, end to end](#the-question-lane-end-to-end).

The wait's `answered` returns only when the card is **released**; a `note` (the director's or
the worker's own) is shown but does not end the hold. The worker continues **in the same
turn** and re-claims the card if the release left it `todo`. `escalated`, `moved`, `timeout`
and `error` end the call; the worker may re-invoke one bounded wait, then parks and the
**same worker session** is resumed with the answer when it lands. The director turn is
verified against the board: a `note` without a release is requeued after a 30 s backoff and
retried once, never a silent completion. Any human comment resumes an awaiting card, whatever
its kind, and the
resumed worker judges from its content whether it is a complete decision.

A director row is not a card handoff: it is never claimed, never opens a reviewer lane, and
does not consume a worker slot. The read is bounded by `--board-limit` and costs one
`comment list` per `in_progress` card per poll. The ladder is stated here: worker → director →
human. A worker asks and waits; the director decides the collaboration questions and the
handoff triage, records the decision and releases the card; the human owns E1–E5 and the
reserved matters. The director skill ships that ladder as its **deployed contract**
(`references/decision-policy.md`, the shared core); a role skill or `--roles-dir` cannot
override it. The contract's E1–E5 mapping and reserved-matters list are defaults in
`references/escalation.md`: a project's own `docs/agents/decision-policy.md` may refine them
item by item, but the ladder itself is not refinable.

Questions are asked as one **decision round**: the frontier of decisions whose prerequisites
are settled, numbered Q1..Qn with a recommendation each, one question string per card, with
the asker looking up the facts. The director skill ships the full round method as
`references/rounds.md`; the frontier rule above is the design requirement.

**The scan set.** Discovery *is* the claim set: every discovered worker-lane role's board
name, plus every discovered reviewer-lane role. There is no scan-set key — a writer identity
with no role skill can write, but its cards are never claimed. Each scheduling unit carries
`--agent <installer name>` as the loop's **writer** identity (a launchd/systemd/cron start
has no shell `TASKCTL_AGENT` to inherit); that flag does not narrow the claim set. The
discovered set is published locally as `<config root>/roles.json` by `taskctl role sync`
(every poll, full replacement), and `taskctl role list` is the assignee range
`/setup-meerkat` and the `meerkat` skill read. `/setup-meerkat` offers the cross-platform
migration with `scripts/route-role.mjs`: copy a role skill into another kind's tree, remove
the source only with explicit consent (`--confirm-remove`, never in a dry run), and report an
old `meerkat-loop` roles tree as deprecated without deleting it.

## The director lane

The director is the supervisor's one content-decision lane. It is a
[`meerkat-director`](../skills/meerkat-director/SKILL.md) session in the pool, opened on
demand, one per project directory, on the kind that carries the director skill (primary
first, then the configured kind order). It is not a role: it receives no card, has no
assignee, and never appears in the scan set.

| Row | Source | The director's move |
|---|---|---|
| `question` | a worker wrote an agent `question` and is waiting | answer with an agent `note` and **release** the card to `todo`; or escalate. A note without the release is retried |
| `route` | an unassigned `todo` card past 30 minutes | assign the one role the generated routing table names. A card assigned to an agent no worker lane can claim is the workflow's `assignee_not_scanned` finding, not a route decision |
| `triage` | an accepted producer carries `meta.stage_handoff=required` and has no decision for its delivery round | read the current report's `## Handoff`; create/seed/link the proposed cards, or record `handoff_declined_round`; record `handoff_consumed_round` on the producer |
| escalation | the director cannot decide | `issue move <ref> awaiting --awaiting-reason E1..E5 --question "..."` |

The skill loads once, at session open: Claude opens with `/meerkat-director` + a `Flags:`
line, Codex receives it as `developerInstructions`, and Pi appends it to the system prompt.
The skill's `references/decision-policy.md` names the decision file for the matter. A
deployment whose skill is missing falls back to the decision-policy path in each prompt. The
per-decision prompt is generated by the supervisor: the routing table built from each role's
`shapes`, the rows and the exact `taskctl` commands. Every row signs `--agent Director
--actor-kind <the kind running the lane>`: the identity is the lane's own, not the asking
worker's. The director never claims a card, never
implements, never writes `decision`/`confirm`/`change` kinds, never uses `--as-human`, and
never moves a card to `done`. A question row is capped at two attempts; a route row is enqueued once per window.
A triage row is enqueued **after** the question and route rows: it is post-acceptance work
and never displaces a held worker. Its completion is the marker on the producer, not a linked
child; a producer that moved off `done` makes the row stale. A triage that exhausts its two
attempts records a note on the `done` producer and becomes a `loop doctor`
`handoff_unconsumed` finding; it is never parked. Both the triage read and that finding
look back over the archive window (seven days): an older accepted handoff is not re-offered,
though its marker stays on the producer's archived row.
The director skill is a start-up requirement of the pool; when it is missing the pool
refuses to start rather than silently dropping decision rows. A missing
`references/decision-policy.md` is different: the supervisor logs one warning and the
generated prompt falls back to the built-in summary, so decisions still run.

### The question lane, end to end

A question is the one board interaction that is **not** a dispatch: the card stays claimed,
the worker holds its turn, and a second lane answers it without starting a second worker.
The sequence below is the implemented one — `src/orchestrator/runners.mjs` (enqueue),
`session.mjs` (the lane), `src/foundation/question-settle.mjs` (the settle rule) and
`src/cli/commands/issue.mjs` (`issue wait`).

```text
    WORKER SESSION            BOARD (taskd)             SUPERVISOR (poll·pool)    DIRECTOR LANE
    card in_progress          tasks · comments          src/orchestrator          LLM · project dir
    │                         │                         │                         │
    │ (1) ask a question      │                         │                         │
    ├─comment kind=question──▶│                         │                         │
    │ (2) hold the turn       │                         │                         │
    ├─issue wait─────────────▶│                         │                         │
    │ poll 2 s · pulse 240 s  │                         │                         │
    │ ≤110 s default, 540 max │                         │                         │
    │ (timeout: re-invoke 1×) │                         │                         │
    │                         ├─comment_added──────────▶│                         │
    │                         │                         │ (3) early tick          │
    │                         │                         │ else the 600 s tick     │
    │                         ├─issue list─────────────▶│                         │
    │                         ├─comment list───────────▶│                         │
    │                         │                         │ (4) newest question     │
    │                         │                         │ skip epic · skip review │
    │                         │                         │ cap 2 · resolve dir     │
    │                         │                         ├─question row───────────▶│
    │                         │                         │ (5) own interval        │
    │                         │                         │ not the dispatch tick   │
    │                         │◀────────────────────────┼───get · comment list────┤
    │                         │                         │ (6) re-read first       │
    │                         │◀────────────────────────┼─────note + move todo────┤
    │                         │◀────────────────────────┼ or move awaiting E1-E5──┤
    │                         ├─get · comments─────────▶│                         │
    │                         │                         │ (7) verify the board    │
    │                         │                         │ not the turn exit code  │
    │                         │                         │ note-only: retry 30 s   │
    │                         │                         │ (max 2 turns)           │
    │ (8a) released: todo     │                         │                         │
    │◀───────wait: answered───┤                         │                         │
    │ re-claims, same turn    │                         │                         │
    │ (8b) escalated: awaiting│                         │                         │
    │◀──────wait: escalated───┤                         │                         │
    │ worker parks; id kept   │                         │                         │
  (8c) human comment ─────────▶│ awaiting → todo        │                         │
    │                         │                         │ (9) ticks on the event  │
    │◀────────────────────────┼─resume worker session───┤                         │
```

**What each step pins** (the numbers are the diagram's):

1. **Ask.** The worker writes an agent `question` comment and leaves the card
   `in_progress`. Only the newest **agent** question counts — a human counter-question is
   an answer-side event, never the wait's cursor.
2. **Hold.** `issue wait <ref> --question <id>` reads the card every 2 s, pulses its own
   heartbeat every 240 s, and is bounded at **110 s** (max **540 s**). It writes nothing.
   `answered` is the release and only the release; a `note` — the Director's or the worker's
   own — does not end the hold, because the settle is the release, not the author.
3. **Wake.** `comment_added` with `kind: "question"` is a dispatch event, so the subscriber
   asks for an early tick; without a subscriber the next 600-second tick finds it.
4. **Enqueue.** Poll reads `issue list --status in_progress` and then `comment list` per
   card; an epic and a review card are skipped. A question is *open* while the card is
   `in_progress` and no status change followed it. This runs **before** the concurrency
   budget — a question is a project-session turn, not a subagent, and its row does not
   count against the cap. The attempt cap is two dispatches per question id.
5. **Route.** Question rows have their **own interval**, not the dispatch tick: the tick
   awaits worker turns, and the worker is holding in exactly that turn. One lane per project
   directory, at most 8 questions per turn, and the question body is bounded in the prompt.
6. **Answer.** The director re-reads the card first. Not `in_progress` any more → do
   nothing. A later comment already answers it → release only. Otherwise: a `note` and
   `issue move <ref> todo`, or `issue move <ref> awaiting --awaiting-reason E1..E5
   --question "..."`.
7. **Verify.** The supervisor judges the **board**, not the turn's exit code:
   `classifyQuestionOutcome` says settled when the card left `in_progress` (a release or an
   escalation). A note-only turn is requeued after 30 s, at most two turns; past that the
   row fails and the question is left for the human.
8. **The two endings.**
   - **Released (`todo`).** `issue wait` returns `answered` with the bounded answer trail
     (≤ 2 000 characters); the worker re-claims and continues **in the same turn**. Poll
     skips a card whose worker session is running, so no duplicate prompt is queued; a
     handoff already queued waits and is dropped if the worker moved the card first.
   - **Escalated (`awaiting`).** `issue wait` returns `escalated`; the worker parks and its
     session id is kept. A human comment is the board's own resume (`awaiting → todo`,
     migration 0034), and the answer then takes the ordinary dispatch path.
9. **Resume rides the event.** The release that follows a human answer reaches the worker
   the same way a new card does: `comment_added` wakes the subscriber, a dispatch tick
   claims the card, and the pool resumes the **same** worker session with the answer in the
   resume prompt. The 600-second tick is the fallback when no subscriber is installed.

Outside the diagram, `question_stale` in [`sla.md`](sla.md) watches the same wait on either
status — a 60-minute normal limit, a 1440-minute escalation — and is notify-only: it never
releases the card and never starts a turn. Without a resident pool no question row is
enqueued at all, so that row is the only thing that will speak.

## Continuity: the same worker, resumed by id

A **new** dispatch hands the worker a **bounded handoff** built by `buildHandoff()`: the
card id and title, that it is the card's own worker session and the supervisor already holds
the claim (heartbeat, do not re-claim), the working directory it runs in, the acceptance-list
step (read the card with `issue get --json`, work to an existing list, or derive one and
persist it with `meta.acceptance_derived=yes`), the exact `taskctl` commands to read and
deliver it, and the attribution flags `--agent <name> --actor-kind <kind> --session-id
<id>`. The handoff is capped at **under 3600 characters** (a test pins it, including a
maximum title and a UUID session id) so a wake never drags an unbounded context into the
model.

A **same-round** re-dispatch does not build that handoff again. It opens the stored
session id and sends a bounded **resume** prompt carrying what changed — the human's
answer, the rework reason, or "the previous turn was interrupted" — and tells the worker to
re-read `card.md` and the comments before continuing, not to start over. When the native
session cannot be restored, a **replay** prompt carries the supervisor-owned transcript instead
(bounded at 12 turns / 8 000 characters) and the record is marked `resumed_by_replay`. A
**new round** is a new generation: it gets the full handoff and a fresh session.

The handoff names the task's **process directory**, relative to the session's cwd:
`.meerkat/<identifier>/`. `card.md` inside it is the supervisor's authoritative export of the
card: poll registers it with the local event hub before the claim, the hub writes the first
snapshot synchronously (a temp file plus an atomic rename), and the registration keeps it
fresh until the card is `done` or `canceled`. The handoff tells the worker to read it
first, to re-read it on resume, and never to edit it. Every other process file — notes, logs, evidence, report drafts, downloaded
attachments — belongs in the same directory. The board still holds no directory (O3): the
worker session's cwd **is** the directory, and `.meerkat/` is the supervisor's convention
under it — see [Where a worker runs](#where-a-worker-runs).

The hub owns the refresh for every registration: a debounced batch updates each watched file
(and a review card's original, because the supervisor registers both), independent of
whether an event wakes an early tick. The refresh is a file write, not an LLM turn; a
failure leaves the previous brief in place.

Continuity across wakes comes from the **session**, with the board as the durable record:
the card's comments, reports and session record survive a session that is closed, and a
resume re-attaches to the same work. The three resident adapters resume by their own form:
Claude `--resume <sid>`, Codex `thread/resume`, Pi `--session-id <sid>`. All three are
verified against the real CLIs; `scripts/verify/kind-resume-matrix.mjs` probes each
binary's help output when the CLI is installed.

## Where a worker runs

A woken worker must run in the **directory its project's work happens in** — the
checkout the work is actually about, or the launch directory a project that has no
checkout supplies. The board cannot say which directory that is (it holds no
directories, O3), and neither can the supervisor: it knows a project **identity** and
nothing else.

So the directory is resolved **locally by the poll pass**, against the one
`<config root>/projects.json` (`references/projects-json.md`) as
`local_path ?? run_dir`, **validated** (absolute, exists, is a directory).

The directory is a **worker's** start directory. The supervisor writes its own per-task process
data beneath it (`.meerkat/<identifier>/`: `card.md` plus the worker's files). That is
loop state, not project data — where a project keeps its results is still its own business
— and a project should ignore `.meerkat/` in version control. A target directory where the
hub cannot write the brief blocks dispatch: a failed registration (or a card already
terminal) defers the card unclaimed, and a refused claim unregisters it again — but only a
registration this pass created. A review admission registers the review card together with
its original; when the original's brief is already kept fresh by a live detached
registration (made when it was dispatched, and still live because `in_review` is not
terminal), that card is **covered**: the hub drops it from the new registration and admits
the review card. The covered card belongs to the other registration and is never stopped
on a refused claim.

Poll resolves the candidate's project before claiming it and writes the result into
the queue entry as `target_dir`; the pool launches the card's worker session in that
directory (its admitted worktree, when the project is a git checkout). If the project is
unmapped or names no directory, the card is **deferred before the claim** — it stays `todo`, where the
next turn can offer it again, and the log says why. There is no fallback directory:
a session that runs in the wrong checkout produces confident, misplaced work, which
is worse than no session.

The same map answers the interactive question: `taskctl project dir <project>` prints
a project's registered directory, reports that the entry names none, or exits non-zero
asking which directory it should be, rather than continuing.

### Deferred admission

A card that cannot be admitted stays `todo` and is offered again next turn. That is correct
for backpressure and wrong for a persistent failure, which used to retry silently for hours.
The supervisor now keeps `<state>/deferrals.json`:

```json
{
  "version": 1,
  "cards": {
    "TP-0009": {
      "identifier": "TP-0009", "round": 3, "count": 4, "version": 12,
      "first_at": "…", "last_at": "…", "retry_at": "…",
      "code": "WORKSPACE_CREATE_FAILED", "reason": "…",
      "alerted_code": "WORKSPACE_CREATE_FAILED", "alerted_at": "…"
    }
  }
}
```

Both admission sites record into it — the poll pass and the patrol's LLM turn. A successful
admission (a claim in the patrol lane; admission itself in poll) removes the entry. At
`count >= 3` the supervisor writes **one** `Orchestrator` note on the card for that failure code,
logs at error, and (when `--notify` is configured) pushes the same alert; a new failure code
earns its own note, and a failed comment is retried on the next deferral. From the third
failure the card also backs off — 30 s, then doubling to a one-hour cap (`retry_at`) — so a
persistent failure stops spinning the scan. At `count >= 5` the loop stops dispatching the
card and parks it `blocked/external` with a question: the execution hold. The patrol prunes
terminal cards and entries older than seven days. A card whose board `version` changed since
the failure (a human edited it) resets the streak to one and is offered immediately — that
is the one-attempt override. After a hold is cleared by a human move, the entry has already
been dropped, so the card starts a fresh, still-bounded run.

## Where the supervisor runs

The supervisor cannot live inside the agent application, because Claude Code and Codex have
**no timers** — their hooks fire only on session events. So the supervisor lives outside:

| Option | Shape |
|---|---|
| `taskctl loop …` (this tree) | the supervisor: `loop run --ping-once` / `--continue-once` for the clocks, `loop session` for the resident pool, `loop run` for its own daemon clocks |
| the installed runtime tree | what `install.sh` deploys; the units name `<tree>/src/cli/index.mjs loop …`, and an agent-only install names the checkout |
| the local `taskd` process | a natural home for the same supervisor in a future milestone |
| the OpenClaw agent framework | on OpenClaw, the framework itself is the supervisor |

One supervisor runs per machine, on a **primary actor kind** (the installed unit's kind). It
holds sessions of several kinds at once: a card's worker/reviewer runs on the kind that
carries its role skill, while the director and the supervisor's own board writes stay on the
primary kind. The application is just a worker: the poll entry claims on the board, then the
resident pool runs the card in its own worker session, on the role's platform and in the
card's worktree.

### What the supervisor's units run with

A scheduler does not start a unit in your login shell. It starts it with a **minimal
`PATH`** of its own — launchd's is `/usr/bin:/bin:/usr/sbin:/sbin`, cron's is typically
`/usr/bin:/bin` — and that set holds no nvm and no Homebrew directory. On such a machine
the supervisor fails **twice**, and fixing only the first failure makes the symptom worse rather
than better:

| Layer | What it is | What a minimal `PATH` does to it |
|---|---|---|
| ① the unit's interpreter | `/usr/bin/env node <cli>/index.mjs` | `env: node: No such file or directory` — exit 127, and no tick ever runs |
| ② the agent process the tick starts | the resident session launches `claude` / `codex` / `pi` | 127 again, on the *inherited* minimal `PATH` — the tick now starts and the session still fails. Underneath it sits the worker's own process tree (`git`, `node`, `taskctl`), which is equally blind |

So each loop unit names **both** things outright:

- the **absolute `node`** that rendered it (launchd `ProgramArguments[0]`, the command on
  each cron line) — the interpreter never goes through `env` at all;
- a **`PATH`** whose head is the agent **shim's** directory, the agent CLI's, and node's,
  followed by that scheduler's own documented default — so the names the tick *derives*
  still resolve, and the suffix keeps `sh`, `git` and the rest exactly where the scheduler
  would have put them. The shim heads the list because every layer below the tick runs
  `taskctl` (the supervisor's board reads, a worker's card operations, a reviewer's
  evidence), and a globally installed `taskctl` — nvm's global bin is node's directory —
  would otherwise answer first and write the wrong actor identity.

Neither is optional. An absolute interpreter with a bare `exec claude` underneath is the
half-fix above; a `PATH` alone leaves the interpreter looking at a set it was never in.
Both are **version-pinned** (the directories carry a node/CLI version), so after an upgrade
run `install.sh --force` to rewrite the units.

The value comes from one recipe (`scripts/install/lib/unit-path.mjs`), read two ways — the
installer's bash side asks it through its CLI, and JavaScript callers (the taskd guard, the
`--supervisor=enable` dry-run) import it — so the two can differ only by a bug in that file,
never by drift.

```xml
  <!-- launchd: com.meerkat-taskpanel.ping.plist -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/home/you/.claude/bin:/home/you/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
```

```cron
# cron: ~/.claude/scheduling/cron/meerkat-taskpanel.cron
PATH=/home/you/.claude/bin:/home/you/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin

* * * * * /home/you/.nvm/versions/node/v24.20.0/bin/node /path/to/runtime/src/cli/index.mjs loop run --ping-once --actor-kind claude --log ~/.meerkat-taskpanel/logs/supervisor.log --state-dir ~/.claude/meerkat-taskpanel >/dev/null 2>&1
```

(Both are rendered for the agent CLI you installed *for*, and only for it: a unit that wakes
`claude` has no use for `codex`'s directory, and a union would only make the resolution
longer and less predictable.)

The **systemd** service is the third rendering of the same value and is deliberately **not
rendered yet**: whether its `Environment=PATH=` takes the documented default (decisive, and
identical in shape to launchd's) or inherits the login session's `PATH` (richer, but a
*trailing colon* when that `PATH` is empty — which POSIX reads as "the current directory")
is an open ruling. Until it lands, that service keeps its current form; shipping the
absolute interpreter alone would be exactly the half-fix described above.

When the agent CLI is **not** on the installing machine's `PATH` — you installed for an application
that is not there yet — the installer says so and renders the shim directory and node's
alone. It does not invent a directory, and it does not fail silently:

```text
claude: claude is not on PATH — the scheduling units will carry the shim directory and node's,
claude:   so a woken claude would not resolve. Install it, then re-run this install with --force.
```

### The taskd guard (keepalive)

`taskd` — the board server, `src/server/main.mjs` — has an **OS-level keepalive**: the
supervisor restarts it after **any** exit (a crash, an `SIGKILL`, a non-zero exit). It
exists because `taskctl` *lazy-starts* `taskd` only when a CLI call needs it: a board
whose server dies while nobody is calling it would stay down until the next call, and
the guard removes that gap.

It is **not a scheduled tick**: there is no `StartInterval` and no `.timer`. It is the
single long-running process, and therefore the single owner of the data directory's
write lock (R1: one `taskd` per data directory).

> This is the board **server**'s guard, not the supervisor. It is separate from the table
> above, which asks where the *supervisor* might one day run; the guard answers only "keep
> `taskd` up". Enabling and stopping it is in
> [`install.md`](ops/install.md#the-taskd-guard-keepalive-always-enabled).

#### Where the unit lands (ownership separation)

```text
<prefix>/.meerkat-taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
<prefix>/.meerkat-taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service
```

The install root (`<prefix>/.meerkat-taskpanel/`; `<prefix>` is `install.sh --prefix`,
default `$HOME`), deliberately **not** `<agent-dir>/scheduling/` where the supervisor's `ping`/`continue` units
live ([Scheduling units](ops/install.md#scheduling-units-claude-codex-pi)). Re-installing a
agent kind's loop units never touches this directory, and the two are never confused for one
another.

There is **one guard per machine** — and therefore **one guarded board** — and **not** one
per agent kind: the `Label` and the unit name carry no agent or actor-kind segment (unlike the supervisor's
`com.meerkat-taskpanel.ping` / `meerkat-taskpanel-continue`), so installing for several
agent kinds does not multiply the guard. Which board it serves is chosen **at install time**, and
a second board is the unguarded case; see
[One guard per machine](#one-guard-per-machine).

#### One supervisor per machine

The supervisor follows the same machine-level rule: `install.sh --supervisor=enable` acts on
the **first loop kind in normalized `--target` order** (`all` → `claude`; `--target pi,claude`
→ `pi`). That kind is the supervisor's **primary kind** — the loop's own board identity
(patrol, workflow) and its config; the team skills (director, chat, setup and a fresh
install's roles) are installed there too. The director lane itself follows the **director
skill's** location, discovered at session open (primary kind first, then
`MEERKAT_TASKPANEL_AGENT_KIND_ORDER`), which is also where its decision policy is read; it
signs its own writes as `Director`. It is not the only kind that runs work: role discovery assigns each card's
session to the kind that carries its role skill, so one supervisor process holds claude,
codex and pi sessions at once. The atomic claim still keeps two supervisors from executing
the same card, but a second supervisor doubles the cadences, pools, logs and SLA ledgers, so
one per machine remains the rule.

`--supervisor-actor-kinds` is now a **primary-kind selector**; listing several kinds is
refused with a hint that role placement, not a second supervisor, is how another platform
joins. On **systemd** the unit names are machine-wide — the installer copies the same files
for every kind — so a second enable rewrites and restarts the first rather than adding a
supervisor; launchd labels and cron markers do carry the kind. Status reports that
difference instead of counting one systemd set three times.

`--supervisor=status` and `--supervisor=disable` always cover **every** loop kind in
`--target`; status flags a machine with more than one kind loaded, and disable stops all of
them, including the three a pre-rule install left behind. An action whose kinds do not cover
a loaded stray names it and prints the disable command.

`taskd` writes its own log at `<dataDir>/logs/taskd.log` — one line per event, rotated
by size (see [Observability](ops/observability.md#structured-logs)). The unit deliberately
**does not** redirect stdout/stderr into that file: the application is the only writer,
and a redirect would duplicate every line. `install.sh` still creates `<dataDir>/logs`
before writing the unit, and anything written before the logger starts (an unreadable
config file, say) lands in the journal or the macOS unified log.

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
     loads it immediately. taskd writes and rotates its own log file (`{{LOG}}`).

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
  <!-- No StandardOutPath/StandardErrorPath: taskd writes and rotates {{LOG}}
       itself. A redirect into the same file would duplicate every line;
       anything written before the logger starts goes to the unified log. -->
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
- **no `StandardOutPath` / `StandardErrorPath`** — the daemon owns that file; a redirect
  into it would write every line twice.
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
#   cp <prefix>/.meerkat-taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service ~/.config/systemd/user/
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
# No start limit: a guard that gives up is a board that stays down. `0` disables
# the rate limit, so even a crash loop keeps being restarted.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart={{NODE}} {{SERVER_ENTRY}}
Restart=always
RestartSec=2
# EX_CONFIG (78) is a permanent fault — an unsupported Node, a configuration
# that can never be read. Restarting it would only spin.
RestartPreventExitStatus=78
# No StandardOutput/StandardError redirect: taskd writes and rotates
# {{LOG}} itself. A redirect into the same file would duplicate every line;
# the journal keeps anything written before the logger starts (a config file
# that cannot be read).
{{ENV_SYSTEMD}}
[Install]
WantedBy=default.target
```

- **`ExecStart`** — `{{NODE}} {{SERVER_ENTRY}}`: two absolute paths and no interpreter
  lookup. `/usr/bin/env node` is not an option here at all — systemd resolves `ExecStart`'s
  first word against the *service's* `PATH`, which has no nvm and no Homebrew directory, so
  an `env node` unit fails on exactly the machines the macOS unit used to crash on.
- **No `PATH`, and that is specific to this unit family.** With an absolute `ExecStart` the
  guard never resolves another name: it starts node on the board server and nothing else, so
  a `PATH` of its own would only narrow systemd's own default. The **loop** units are the
  other family — their tick *derives* executables (the resident session's agent CLI, and
  the worker's own `git` / `node` / `taskctl` tree), so they carry an absolute interpreter *and*
  a `PATH`. Same scheduler, two answers, each for a stated reason: see
  [What the supervisor's units run with](#what-the-supervisors-units-run-with).
- **`Restart=always`** — restart the server after it exits, whatever the reason. Only an
  explicit `systemctl --user stop meerkat-taskpanel-taskd.service` stops it for good; a
  bare `kill` is undone.
- **`RestartSec=2`** — wait 2 seconds between restarts, inside the epic's "a crash costs at
  most one restart interval" bound.
- **`StartLimitIntervalSec=0`** — disable the start-rate limit. The unit never gives up: a
  crash loop is restarted indefinitely, so the defect this card fixes (5 starts in 60 seconds
  then `failed` **permanently**) cannot recur. There is no `StartLimitBurst`; with the
  interval at `0` it has no meaning. The key lives in `[Unit]`, not `[Service]`.
- **`RestartPreventExitStatus=78`** — an `EX_CONFIG` fault (an unsupported runtime, a
  configuration that can never be read) is not restarted. This is the one deliberate stop:
  a fault that restarting cannot repair would otherwise spin forever. launchd has no
  equivalent; see [Robustness](#robustness).
- **No `.timer`** — this is a long-running service, not a tick.

#### Enabling: written and loaded at install

The `taskd` guard is **enabled at install time**, with **no interactive question and no
user switch**. `install.sh` writes the unit and then loads/enables it:

```bash
# macOS
launchctl bootstrap gui/$UID <prefix>/.meerkat-taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
#   (older systems: launchctl load -w <plist>)
# Linux (user unit)
mkdir -p ~/.config/systemd/user
cp <prefix>/.meerkat-taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-taskd.service
```

**This is an explicit exception**, and it is the *only* one, to the installer's standing
rule that it writes a unit and prints the load command but **never starts a daemon for
you**. It holds **only** for the `taskd` service guard: the supervisor's units are still
written and left for the operator to load, and OpenClaw still gets none.

A **restart is not a start**, and the installer does restart what it would otherwise leave
running the previous code. When the server target replaced `src/**` (a content digest, not a
timestamp), the already-loaded `taskd` guard is re-run (`launchctl kickstart -k` /
`systemctl --user restart`), and so are the loaded `session` and `subscribe` units; the two
timers are skipped (one-shot — their next fire reads the new code) and a stopped unit stays
stopped. The lazily started local event hub has no unit, so it is **stopped** instead
(`taskctl events hub --stop`, autostart disabled) and the next consumer starts one from the
new tree (`docs/events.md` §6.2). Nothing is ever loaded, enabled or disabled by this path.

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

Neither line fails the install (the agent-kind skills are installed either way), but only the
first one claims the guard works.

A board that is **already answering** at the runtime pointer's address is a third case, and
it is not loaded over: a second `taskd` on the same port is an `EADDRINUSE` restart loop, not
a keepalive. The units are written, the load is skipped, and the report names the running
board:

```text
taskd guard: not loaded — a board is already serving http://127.0.0.1:9527 (pid …); stop it and re-run to install the guard
```

A **second board** is where the install has to be careful, because the guard is one per
machine ([One guard per machine](#one-guard-per-machine)): on Linux the file systemd reads
`~/.config/systemd/user/meerkat-taskpanel-taskd.service`, and that file *is* the machine's
guard. So the loaded probe is asked **before** anything is written there, and a guard that
is already loaded for a different board is a refusal — the file is left alone, and the
refusal names both boards:

```text
taskd guard: refused — com.meerkat-taskpanel.taskd is already loaded and serves another board (<its dataDir>);
  ~/.config/systemd/user/meerkat-taskpanel-taskd.service was left unchanged, and this board (<this dataDir>) is not guarded by it
taskd guard: this machine runs one guarded board — re-run with --force to point it at <this dataDir>
```

That is the one non-zero outcome of an install — **exit 3** (`install.sh` reports a non-zero
guard step and carries on; the install's own status is unaffected). A re-install of the
**same** board is not a refusal: it reports which board the loaded guard serves, so
`already loaded` can no longer read as "your board is guarded" when it is not:

```text
taskd guard: already loaded (no change) — the machine's guard serves this board (<dataDir>)
taskd guard: already loaded (no change) — which board it serves could not be read here
```

The second form is the honest one for a machine where neither the unit file nor a runtime
pointer carrying the guard's pid names a board; it is never smoothed into a bare no-change.
On macOS there is no machine-side unit file to read, so the pointer is the evidence install
has — and a guard that is already loaded for another board is reported there too, though
nothing can be refused (nothing is written over the loaded job's plist).

To stop and remove the guard:

```bash
# macOS
launchctl bootout gui/$UID/com.meerkat-taskpanel.taskd
rm <prefix>/.meerkat-taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
# Linux
systemctl --user disable --now meerkat-taskpanel-taskd.service
rm ~/.config/systemd/user/meerkat-taskpanel-taskd.service
```

Three **internal** bypasses exist; none is a user option:

- `--no-automation`, or its environment form `MEERKAT_TASKPANEL_NO_AUTOMATION=1` (the
  variable `install.sh` sets for each agent-kind installer) — **skips the guard too**,
  semantically consistent with its other target (the Codex scheduling units). It is one
  bypass with two spellings, an advanced install bypass rather than a switch for the guard
  alone.
- `--dry-run` — writes and loads nothing; the report line becomes
  `taskd guard: skipped (dry-run)`.
- `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1` — **for tests only**; skips the guard so a
  CI or test install never loads a real unit.

#### Coexisting with `taskctl`'s lazy start

The guard and `taskctl`'s lazy start share one runtime pointer, one data directory and
one write lock, so they never fight over the slot:

- **The order gains one rung.** `taskctl` resolves its board as *explicit `--url`* (a pin) →
  *`TASKD_URL`* (preferred: a dead **loopback** address falls through, a dead **remote** one is
  an error) → *a healthy run pointer* → *lazy start* (unless `TASKD_NO_AUTOSTART` is set). A
  guarded `taskd` leaves a **healthy pointer**, so a CLI call reuses it and never starts a
  second server. The subscriber inherits the same order because `taskctl events follow`
  resolves the board to find its hub, and the hub resolved the same board when it started.
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
  port: the default `9527`, or a port from **outside** the unit (macOS: the launchd session
  environment; Linux: an operator drop-in on the unit). `0` — the *value*, an ephemeral
  port — is for the lazy-start and test paths only, because a client that has lost the
  pointer cannot guess a random port to find the server again. The ban is on `0`, not on
  the variable name: `install.sh` renders only `TASKD_DATA_DIR` / `TASKD_RUNTIME_POINTER`
  into the unit (`unitEnv()`, `scripts/install/lib/taskd-guard.mjs`), which is the
  installer's choice for the one-guard boundary below — not a claim that a port in a unit
  would be wrong. See [One guard per machine](#one-guard-per-machine).
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
  propagated — a client policy, and (for the one guarded board this machine has) a port that
  belongs outside the unit; see the two bullets above and
  [One guard per machine](#one-guard-per-machine).
- **If something else already owns the slot**, the guard's `taskd` exits non-zero with
  `BOARD_ALREADY_RUNNING` and the supervisor restarts it. Stop the hand-started board first;
  the unit keeps retrying while the collision lasts (see [Robustness](#robustness)).

#### Robustness

**A managed unit never gives up.** `Restart=always` / `KeepAlive` stay: the goal is "always
up", and the supported way to stop a managed unit is `systemctl --user stop` /
`launchctl bootout` (the service manager cancels the restart). `taskctl loop status --stop`
only stops a pool started by `--take-over` and is not a reason to change restart policy.

- **launchd** — `KeepAlive=true` and `ThrottleInterval=10`. launchd never enters a terminal
  failed state; 10 seconds is its floor, not a policy this project chose.
- **systemd** — `Restart=always`, `RestartSec=2`, `StartLimitIntervalSec=0`. The taskd guard
  used to carry `StartLimitIntervalSec=60` / `StartLimitBurst=5`: five starts in a minute put
  the unit in `failed` **permanently**, which is the one place the system really did give up.
  The loop services had no explicit limit (the default rate never trips at `RestartSec=2`),
  and now state the zero interval outright so the intent is written down. No unit carries
  `StartLimitBurst`; with a zero interval it has no meaning.
- **A permanent fault stops instead of spinning.** A missing skill and an unsupported Node
  cannot be repaired by a restart, so those paths exit **78** (`EX_CONFIG`). systemd is told
  `RestartPreventExitStatus=78` and leaves the unit inactive; the operator sees the one error
  line and the fix. **launchd has no equivalent filter** — the asymmetry is documented here
  and not faked with a second mechanism: on macOS the fault is throttled to one start every
  10 seconds, indefinitely, until the operator fixes the skill or boots the job out. Exit 78
  is deliberately **not** counted by the boot ladder (below): a permanent fault should stop
  at once, not sleep first, and a real process manager is the only thing that can refuse the
  restart.
- **The boot ladder delays only a boot that never worked.** The long-lived loop entries
  (`loop session`, `loop subscribe`, the daemon clocks) keep
  `supervisor.health.json` — `{startedAt, pid, version, lastCrash, starts, bootFailures}`.
  A completed first tick (the pool's first dispatch tick, the subscriber's first connection,
  the daemon's first ping) clears `bootFailures`; a non-zero exit or a crash **before** that
  tick counts one more. After more than three consecutive failed boots the entry logs
  `crash_loop` at `error` and sleeps `5 s → 15 s → 60 s → 300 s` (cap) **before exiting**, so
  the service manager's restart is what is delayed. A crash after a successful run is recorded
  but never delayed. There is **no retry script** of its own: the units own restarting, the
  ladder only decides how soon.
- **No `failed` state to clear.** With `StartLimitIntervalSec=0` there is no `reset-failed`
  step in the recovery path: stopping a unit is `systemctl --user stop`, and starting it again
  is `systemctl --user start`.
- **Log rotation belongs to the application.** `taskd` appends to
  `<dataDir>/logs/taskd.log` itself and rotates it by size (`TASKD_LOG_MAX_BYTES`,
  default 10 MiB, keeping `TASKD_LOG_KEEP`, default 5). Neither the unit nor the lazy
  start writes that file — there is one writer and one rotation policy, and no
  `newsyslog`/`logrotate` rule is needed. The journal (systemd) and the unified log
  (launchd) keep only what is written before the logger starts.
- **One guard per machine** — see [One guard per machine](#one-guard-per-machine).

#### One guard per machine

**A machine runs one `taskd` guard unit, and therefore one guarded board. Running two
guarded boards on one machine is out of scope, deliberately and permanently
(T-20261014-063205 §3.2–§3.4, ruled on by Elon 2026-10-15).**

This is a **design boundary**, not a defect to be closed:

- The job's identity is machine-level: `TASKD_LABEL` and `TASKD_UNIT` in
  `scripts/install/lib/taskd-guard.mjs` carry no board or actor-kind segment, and `enablePlan()`
  refers to them directly — on Linux it resolves the directory systemd reads itself. A
  second install cannot create a second job; it can only re-point the one that exists.
- **Which board it serves is decided at install time** and carried in the unit's own
  environment (`TASKD_DATA_DIR` / `TASKD_RUNTIME_POINTER`, rendered by `unitEnv()`). It is
  not chosen at run time, and it is not per-agent kind: installing for several agent kinds does not
  multiply the guard.
- The second board is the **unguarded** case, and it is a supported one: `TASKD_DATA_DIR`
  plus an explicit `TASKD_PORT`, with its address falling back to
  `<dataDir>/runtime.json` so the machine-wide slot and the incumbent board are untouched
  (`src/core/storage/secrets/runtime-pointer.mjs`, R1). A board that must be *resident*
  belongs on its own machine or in its own container — which is what `docker/` is for.
- Because the guard is unique, a second install **does not silently inherit it**: the one
  unconditional write to a machine-side path, in `installGuard()`, is reached only after the
  loaded guard's own board has been read (`unitBoard()` / `servedBoard()`), and a guard
  already loaded for another board is a **named refusal** that leaves that file alone —
  exit 3 (`exitCode()`), with `--force` as the deliberate way to re-point it.
  `docs/ops/install.md § The taskd guard` has the report lines.

**Not adopted — for the record.** If a resident second guarded board is ever really
needed, the minimal change set is: (a) parameterise the Label/unit name with a board slug;
(b) let a unit carry a validated **non-zero** `TASKD_PORT` (a clarification of the contract
above, not a break of it) by injecting one more variable in `unitEnv()`; (c) restate this
section per board; (d) document migrating the Label for machines that already have a job
installed. None of it is implemented, and none of it should be done "for symmetry" — the
cost lands on the unit identity, which is the one thing every client-facing address
(`9527`, the pointer, the compose healthcheck) is built on. Kept here only so a future
decision starts from the analysis rather than from scratch.

### The supervisor's state directory

The supervisor ships with the toolkit, so there is no copied execution body to install and no
checkout path in a unit. What the installer creates beside the skill is the supervisor's **state
directory**:

```text
<home>/<agent-dir>/meerkat-taskpanel/
├── supervisor.state.json         runtime (legacy worker registry)
├── sessions.state.json           runtime (pool: pid, heartbeat, session ids per actor kind)
├── continue.state.json           runtime (the single-flight tick lock)
├── subscribe.state.json          runtime (the event subscriber's last connection)
├── cards.queue.json              runtime (claim → handoff/decision dispatch queue)
├── workspaces.json               runtime (per-card worktree/branch records)
├── deferrals.json                runtime (consecutive admission failures per card)
├── pool-wedge.json               runtime (ping-owned: the wedge it signalled, `wedgedKillAt`/`wedgedSigkillAt`)
├── supervisor.health.json        runtime (the long-lived entries' boot ledger: `startedAt`, `pid`, `version`,
│                                 `lastCrash`, `starts`, `bootFailures` — the restart ladder's input)
├── subagents.state.json          runtime (ledger: worker/reviewer/director id → project, actor kind, role, card, status)
└── worker-transcripts/           runtime (bounded worker turn transcript per (kind, worker:<card>:r<round>),
                                  used only to replay a session the native CLI can no longer resume)
```

The log is **not** here. There is one supervisor log for every actor kind, at the config
root — the program root, or `MEERKAT_TASKPANEL_CONFIG_DIR` when it names another:

```text
<config root>/logs/supervisor.log
├── supervisor.log                runtime, one file for claude + codex + pi
└── supervisor.log.1 … .5         runtime rotation (10 MiB each, 5 kept)
```

Every line carries `actor_kind=<kind>`, so one file is still readable per kind:

```text
time=2026-10-30T14:47:32.174Z level=info component=supervisor msg="ping: 0 live, no write" actor_kind=claude
```

The state directory belongs to the **primary kind**: one supervisor per machine, so one
queue, one lock and one ledger. Session records inside it carry the actor kind of the
conversation they describe, so a multi-kind pool never confuses two platforms. Only the log
is shared across primary kinds, because reading one machine's history should not require the
agent-kind → dot-directory table. A spawned session's own stderr is appended to the same file
as raw bytes, so those lines carry no `actor_kind=` field.

The units name the runtime tree's CLI entry, not this directory:

```text
program: <absolute node> <runtime>/src/cli/index.mjs loop run --ping-once
                                  --actor-kind <kind>
                                  --log <config root>/logs/supervisor.log --state-dir <state>
```

`<runtime>` is `MEERKAT_TASKPANEL_REPO`: `~/.meerkat-taskpanel` for a combined install
(`--target all`, npm/npx), or the checkout for an agent-only install. The per-kind config records
it, so moving the tree is a re-install — no `launchctl` / `systemctl` / `crontab` reload,
because the unit never hard-codes a versioned body path.

`--state-dir <dir>` is the documented spelling; the supervisor derives every state file above from
it. `--state <file>` still names the registry file explicitly, and `--log` the log (its
default is the config root's `logs/supervisor.log`). The installer
removes an execution body left by an older install (`<state>/scripts/`, `<state>/templates/`,
`<state>/manifest.txt`) on its next run, so an upgrade leaves no second implementation
behind.

## Headless permission boundary

A wake is **non-interactive**: the supervisor starts the worker with no human at
the keyboard to answer a prompt. An interactive agent kind that stops to ask "may I run
this?" has no one to answer, so the worker must run under a **pre-declared
boundary** — a tool allowlist, a permission mode, or a sandbox — chosen up front
rather than confirmed per call.

The rule that follows from that is a **no-default-bypass** rule:

- The supervisor and the resident adapters **must not** run workers with
  permissions bypassed by default — no `claude --dangerously-skip-permissions`,
  no Codex `--dangerously-bypass-approvals-and-sandbox` (or equivalent), on by
  default. Neither `taskctl loop` nor any actor-kind adapter
  ships such a flag.
- Turning a bypass **on** is a deliberate act that requires **explicit written
  authorization** and must be **documented at the point of use** — in the agent
  config that carries it — so a reader can see the bypass, the reason, and who
  authorized it. An undocumented bypass is a bug, not a config.
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

### The resident pool's default, and the authorized opt-out

The session pool keeps the same rule. By default each role runs under its own
allowlist:

| Role | Tools (Claude adapter, default) |
|---|---|
| director | `Read`, `Grep`, `Glob`, `Bash(taskctl *)`, `Bash(node *)` |
| reviewer | `Read`, `Grep`, `Glob`, `Bash(taskctl *)`, `Bash(git *)`, `Bash(npm run *)`, `Bash(node *)`, `Bash(bash *)` |
| worker | `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash(taskctl *)`, `Bash(node *)`, `Bash(git *)` |

No role carries `Agent`/`Task`: a card session owns its whole card and spawns
nothing. The reviewer's `npm run` / `node` / `bash` entries exist because its
contract is to re-run the project's declared gate (`project.meta.review_gate`)
itself; a read-only lane with only `taskctl` and `git` cannot reproduce anything
and turns "reproducible evidence" into "read the report and trust it". It still
has no `Edit`/`Write`. The Pi adapter carries the same split through `--tools`
(`read,bash` for the reviewer, `read,bash,edit,write` for the worker). Codex,
OpenCode and Cursor have no equivalent option.

An operator who needs unattended runs that edit and execute without prompts can
opt into **full tool access** — `--allow-all-tools`, or, for the installed
service, the per-kind config:

```bash
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS=yes
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON="<who authorized it and why>"
```

The reason is **required**; `--allow-all-tools` without it is a startup error. With
it the Claude adapter runs `--permission-mode bypassPermissions`, and the director,
worker and reviewer sessions alike have the installing user's full OS
permissions. **The project directory is not an isolation boundary** — cwd is
where the work happens, not a sandbox. Codex uses `approvalPolicy: "never"` with
the full-access sandbox, and Pi adds `--approve`. The flag is printed in `--supervisor=status`, and the
installed units never carry it: the config file is where the authorization is
recorded.

## The three agent kinds: how each one is triggered

Claude Code, Codex and Pi have no clock, and their headless entry points differ. The
supervisor's `--actor-kind` selects the **primary kind** — the loop's own board identity
(patrol, workflow) and its config; the rest (scan, claim, patrol, registry) is identical.
Each card's worker/reviewer session runs on the kind that carries its role skill, and the
director lane runs on the kind that carries the director skill (primary first, then the
configured kind order), signing its writes as `Director`.

| Agent kind | Session command | Trigger / scheduling | Continuity |
|---|---|---|---|
| **Claude Code** | `claude -p "<handoff>"` (headless) | external: launchd / systemd / cron running `taskctl loop run --ping-once` / `--continue-once`, or the supervisor's own two clocks | `claude -p … --resume <sid>` — resume the session that owns the card |
| **Codex** | `codex exec "<handoff>"` | external: the same units, or Codex app automation (`intervalMinutes`, `quotaAware`, `model`, `reasoningEffort`) | resume the thread with `codex exec resume <sid> <prompt>`; carry `$CODEX_THREAD_ID` as `--session-id` |
| **Pi** | `pi --print "<handoff>"` | external units | resume with `pi --print --session <sid> <prompt>`; pass the session id through the handoff |
| **OpenClaw** | *n/a — no self-scheduler* | the agent framework's own `poll`/`patrol` automations — this design is their statement | the framework keeps the id stable across resumes |

The command column is what the *pool* calls to open a session of that kind. The supervisor
itself wakes no agent: it runs the passes in-process and enqueues rows. Each card's worker
session runs that card in the mapped directory or its worktree — see
[Where a worker runs](#where-a-worker-runs).

**Resident adapters:** the pool ships one per agent kind, each on that agent kind's native
persistent protocol.

| Agent kind | Resident form | Session identity |
|---|---|---|
| Claude Code | one `claude -p --input-format stream-json --output-format stream-json` process per session | `--resume <session_id>` |
| Codex | one `codex app-server --listen stdio://`; one **thread** per session | `thread/resume` |
| Pi | one `pi --mode rpc` process per session | `--session-id <id>` |

A **card session is a top-level session**: the identity column is what the pool stores and
resumes for it. No adapter spawns a subagent, so no adapter needs a subagent handle.

Claude, Codex and Pi are verified against the real CLIs (Codex's app-server
schema is pinned by `codex app-server generate-json-schema`);
`node scripts/verify/kind-session-matrix.mjs` is the agent-kind-only probe. An agent kind whose
CLI lacks the resident protocol keeps the one-shot
path: patrol + workflow run, dispatch is paused. The seam is agent-kind-agnostic by
design — an adapter implements `openSession({cwd, sessionId, role}) →
{send, interrupt, close}` in `src/orchestrator/actor-kinds/`, and the pool manager never
names a CLI.

Pi needs no subagent extension: the session pool runs every card — worker or review — as its
own top-level `pi --mode rpc` session, so nothing is spawned from inside a session. A Pi host
needs only the CLI, a selected provider and model, and the role skills.

Installers also install the **director skill** at `<agent-dir>/skills/meerkat-director/`, the
**chat console** at `<agent-dir>/skills/meerkat-chat/` and the five **role skills** beside
them (`jobs`, `linus`, `turing`, `reviewer`, `worker`) — the operator's documentation, the
decision protocol, the human's console and the role workflows. They are always copies:
`--link` names the board skill only. The execution body is `taskctl loop …`, not a file the
skills carry.

Installers write per-agent kind units under `<agent-dir>/scheduling/{launchd,systemd,cron}`,
then **print the load command** — they never enable a daemon or run `crontab` for you. (They
do restart an already-loaded `session`/`subscribe` pair when the installed tree changed; see
[The taskd guard (keepalive)](#the-taskd-guard-keepalive) for why that is a restart and not a
start.) A
reinstall that *rewrites* units the manager already has loaded says so instead of printing
"nothing is loaded for you": the running job still carries the old definition, and
`install.sh --supervisor=enable` is the one command that reloads it (see
[Reloading a changed unit](#reloading-a-changed-unit)):

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.session.plist  # the pool
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist   # and .continue.plist + .subscribe.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-subscribe.service
# Anywhere (no long-lived process: patrol + workflow only, no worker dispatch)
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

The `.session` unit is the **resident pool** — one manager, one worker session per card, a
reviewer lane per directory and a director lane per project. It is the only unit that can
dispatch a worker, a reviewer or a director; without it the tick still runs patrol and
workflow, and poll stops at "no resident pool".

The `.subscribe` unit is the **event daemon**. launchd (`KeepAlive`) and systemd
(`Type=simple`, `Restart=always`) follow the local event hub through
`taskctl events follow` and ask for an early tick when a dispatch-relevant event arrives.
The hub — not the subscriber — owns the board connection. It ships with every
launchd/systemd `--supervisor=enable`; it is a latency path, not a closure component:
ping/continue remain the fallback, and they are the only path for time-based work (stale
claims, review aging, SLA tiers). **cron cannot host it** — a crontab entry is not a
long-lived process — so a cron deployment stays on the continue cadence.

An event-triggered turn requires a **live resident pool**. With no pool it could not
dispatch anything, so the subscriber logs and skips the turn; the continue timer still runs
patrol + workflow. The subscriber is observable: it publishes
`<agent-dir>/meerkat-taskpanel/subscribe.state.json`, and `--supervisor=status` reports
`streaming`, `reconnecting`, `starting`, or `not running` from it. To run without the
daemon, take its unit down with the service manager (`launchctl bootout …` /
`systemctl --user disable --now meerkat-taskpanel-subscribe.service`); status then reports
it as not loaded. `--event-continue=no` is the runtime soft-off — the process keeps the
briefs fresh but no event wakes a turn.

### The human's console

There is no control turn to host. A live `/meerkat-chat` session is the **human's console**,
not a second dispatcher: the supervisor keeps its clocks and the pool keeps dispatching. It
asks the human about `awaiting` cards **one at a time**, records the answer as a
`--as-human` board comment after showing the exact body, reports `doctor`'s health plus every
card in `blocked` status with its reason, and releases `backlog → todo` on request — the only
forward edge, since `in_progress` belongs to a claim. Every board write is shown before it
happens; the comment is the record, the in-session question is only the front-end.

The console is its own skill ([`meerkat-chat`](../skills/meerkat-chat/SKILL.md)), not a manual
mode of the director. The director remains command-only and supervisor-opened; its manual
agenda moved to the console, and its decision authority did not.

`status.mjs --json` reports `running | busy | starting | unresponsive | wedged |
configured-idle | partial | absent` (the first five are the pool's own verdict — a live pid is
never `absent`); `--take-over` starts the pool only when the verdict is `absent` (with no control
turn there is nothing to take over), and `--stop` stops only what it started. `--control` is
retained as a deprecated, inert flag for one release so the CLI snapshot does not move; it
changes neither the pool's lifetime nor what it dispatches.

This "live-session mode" is not the install's **manual path** described next (units written
but not loaded); the two words name different things.

That is the **manual** path, and it is all a plain install does. Loading is a separate,
explicit act: the opt-in switch is [`--supervisor=enable`](#enabling-the-supervisor-opt-in)
below, and it is the one thing that makes an installer load a unit or run `crontab` for you
— see the exception stated there.

### OpenClaw: no loop units

OpenClaw is the one agent kind whose framework already ships a scheduler: a per-agent poll
(the schedule *is* the trigger, so an idle tick costs nothing) for the scan, and a
stale-pass patrol. That is this design implemented on the framework's side; repeating it
here would put two supervisors on one board, racing for the same cards. The board's claim is
atomic, so the race is bounded — but the second supervisor is pure waste.

`install.sh --target openclaw` therefore installs the **board skill only**: no
`meerkat-director`, `meerkat-chat` or role skills, no scheduler, no per-kind config —
permanently, by ruling, not as a gap to be filled later. The framework's own automations are the supervisor on that host;
this page stops at the boundary of what they must preserve — the atomic claim and the
candidate criteria the board hands out.

## Enabling the supervisor (opt-in)

Everything above describes units the installer **writes and never loads**. The enable
capability adds one deliberate act on top: `install.sh --supervisor=enable` (alias
`--enable-supervisor`) performs the per-OS load below. Without it, behaviour is unchanged —
the manual commands in the section above are still the whole story.

That is the single exception to the rule, stated once and pointed at rather than repeated:
**an installer never loads a unit or runs `crontab` for you — unless you ask** (it may
*restart* one that is already running after a code change; see the note on `taskd` above). Asking is
always explicit (the flag, `MEERKAT_TASKPANEL_SUPERVISOR=enable`, or answering **yes** to
the one-time TTY question — also asked by the no-options wizard, default **none** — whose
default is **N**): enabling is never a silent default, and
a plain `install.sh` still only prints the load command. The flag surface, the TTY question
and the env var are documented once in
[`install.md §Enabling the supervisor (opt-in)`](ops/install.md#enabling-the-supervisor-opt-in);
this section is the per-OS detail, the failure modes, and what an enabled daemon runs.

The switch is `--supervisor=enable|disable|status` with
`--supervisor-actor-kinds` (one primary kind for `enable`; a narrowing list for
`disable`/`status`) and
`--scheduler auto|launchd|systemd|cron` (which mechanism; default `auto`). The defaults are
the [one-supervisor-per-machine](#one-supervisor-per-machine) rule:
**`enable` acts on the first loop kind in `--target` order** (`--target all` → `claude`),
while **`disable` and `status` act on every loop kind in `--target`** so no stray is left
unseen or running. On `--target all`, `--supervisor=enable` therefore does **not** enable
`codex`/`pi`, and never OpenClaw (see
[OpenClaw stays excluded](#openclaw-stays-excluded)).

Per-OS commands below are written for the Claude install (`~/.claude`); for Codex and Pi
substitute `~/.codex` / `~/.agents` for the agent kind directory and `codex` / `pi` for
`--actor-kind`. `<agent>` names the unit label, state directory and `--agent` flag from the
install's `--agent-name` (default `Worker`), and `<uid>` is `id -u`. The unit's `--agent` is
the loop's **writer** identity; the claim set is every worker-lane role skill discovered on
the installed kinds plus every discovered reviewer-lane role. `install.sh` renders the flag
and writes `MEERKAT_TASKPANEL_AGENT_KIND_ORDER` from the `--target` order.

### macOS — launchd

The installer already wrote the units
(`<agent-dir>/scheduling/launchd/com.meerkat-taskpanel.{session,ping,continue,subscribe}.plist`);
enabling means bootstrapping them, one per unit — the pool first:

```bash
launchctl bootstrap gui/$(id -u) ~/.claude/scheduling/launchd/com.meerkat-taskpanel.session.plist
launchctl bootstrap gui/$(id -u) ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist
launchctl bootstrap gui/$(id -u) ~/.claude/scheduling/launchd/com.meerkat-taskpanel.continue.plist
launchctl bootstrap gui/$(id -u) ~/.claude/scheduling/launchd/com.meerkat-taskpanel.subscribe.plist
```

`launchctl bootstrap gui/$(id -u)` is the modern, persistent form (the job survives a
reboot). Where `bootstrap` is unavailable (older macOS), the legacy fallback is
`launchctl load -w <plist>` (`-w` = persist across reboot).

**Disable** — by label, every unit:

```bash
launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.session
launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.ping
launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.continue
launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.subscribe
```

(legacy fallback: `launchctl unload -w <plist>`).

**Status**:

```bash
launchctl print gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.ping
```

Exit 0 with a `state =` line ⇒ loaded; `Could not find service …` ⇒ not loaded. Repeat for
`continue`.

**Failure modes.**

| Symptom | Meaning | What the enable path does |
|---|---|---|
| `Bootstrap failed: 5: Input/output error` | no Aqua/GUI session — an SSH-only or headless launchd context | reports it and tells you to retry from a GUI login session (or use `launchctl load -w`). It does **not** claim success |
| **the supervisor's** `Bootstrap failed: 37: … already bootstrapped` (legacy: `service already loaded`) | already loaded, same definition | **idempotent success** — the **supervisor** reports `supervisor: already enabled (…)`, exit 0. The `taskd` guard is bootstrapped the same way but reports its own, board-aware line instead — `already enabled` is *not* its wording ([`install.md § The taskd guard`](ops/install.md#the-taskd-guard-keepalive-always-enabled)) |
| a unit file was rewritten while its job stayed loaded | the live job runs the **old** definition (e.g. an old `--agent`) | `enable` compares the loaded definition with the file: a difference is taken down and loaded again, reported as `supervisor: reloaded (…)`; an unreadable definition is left alone and reported |
| `Could not find service` on disable | not loaded | **idempotent no-op** — reports `already disabled`, exit 0 |

#### Reloading a changed unit

A service manager reads a unit's definition **once**, when it loads it. Editing the plist or
the `.service` file afterwards changes nothing about the running job — `KeepAlive` restarts
and `launchctl kickstart` re-run the old definition too. That is how a loop ends up scanning
`Worker,Reviewer` for days while the per-kind config says `Jobs,Linus,Turing`: an `--agent`
flag baked into the loaded definition outranks the config, and the file that no longer has
it is never re-read.

`install.sh --supervisor=enable` therefore does not stop at "is it loaded?". For launchd it
compares the `ProgramArguments` the plist declares with the `arguments` block
`launchctl print` reports; for systemd it compares the installed unit file with the rendered
one. Same → `already enabled` (idempotent, nothing touched). Different → `bootout` (or
`disable --now`) then load again, reported as:

```text
supervisor: reloaded (kind=claude, scheduler=launchd, units=…)
supervisor:   reloaded com.meerkat-taskpanel.<agent>.claude.session — the definition on disk had changed and a loaded unit is only read at bootstrap
```

Not comparable (an older `launchctl print` without an `arguments` block) → the job is left
exactly as it is, with the disable/enable pair printed for a manual reload. A reload
interrupts the resident pool; in-flight child turns are cut and their cards recover through
the pool's stale-card logic.

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
systemctl --user enable --now meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-subscribe.service
systemctl --user disable --now meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer
systemctl --user is-enabled meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer   # add is-active for "running now"
```

**The headless caveat: lingering.** A `systemd --user` manager is torn down when the user's
last session ends, so without lingering the "enabled" units stop the moment the login
session closes — the background supervisor then **silently does nothing**. To run truly
headless, while logged out, lingering must be on:

```bash
loginctl enable-linger "$USER"
```

The enable path therefore **warns when linger is off**; turn it on if the supervisor is
meant to survive logout. The warning appears in the enable report on Linux agent kinds.

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
PATH=/home/you/.claude/bin:/home/you/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin
* * * * * /home/you/.nvm/versions/node/v24.20.0/bin/node /path/to/runtime/src/cli/index.mjs loop run --ping-once --actor-kind claude --log ~/.meerkat-taskpanel/logs/supervisor.log --state-dir ~/.claude/meerkat-taskpanel >/dev/null 2>&1
*/10 * * * * /home/you/.nvm/versions/node/v24.20.0/bin/node /path/to/runtime/src/cli/index.mjs loop run --continue-once --actor-kind claude --log ~/.meerkat-taskpanel/logs/supervisor.log --state-dir ~/.claude/meerkat-taskpanel >/dev/null 2>&1
# <<< meerkat-taskpanel (~/.claude) <<<
```

The interpreter is absolute and the block opens with a `PATH=` setting line for the reasons
in [What the supervisor's units run with](#what-the-supervisors-units-run-with) — a cron job inherits
cron's own minimal `PATH`, not yours.

(The manual path above — `crontab <file>` — drops the same lines in *without* a marker
block; the enable path is the one that wraps them. The `(~/.claude)` in the marker is the
primary kind's directory, so a machine has one block; a second kind's enable is refused by
the one-supervisor rule.)

- **Enable** reads `crontab -l`, strips any existing `meerkat-taskpanel (~/.claude)` block,
  appends the fresh one, and writes it back with `crontab -`. Re-enabling **replaces**,
  never duplicates — the marker block *is* the idempotency key, because cron has no other
  machine-readable "enabled" state.
- **Disable** does the same but only strips; no block ⇒ no-op.
- **Status** is `crontab -l | sed -n '/>>> meerkat-taskpanel (~/.claude) >>>/,/<<< meerkat-taskpanel (~/.claude) <<</p'`.

> **`PATH=` is a cron *setting line*: it applies to every line below it.** That is cron's
> own idiom, and it is what the manual path (`crontab <file>`) relies on — there the file
> *is* the crontab, so the setting covers exactly the two jobs. The **enable** path is the
> different case, and the one to know about: the block is **appended** to your crontab, so
> the `PATH=` reaches every line you add *after* it. Which is deliberate housekeeping, not a
> side effect — the value is still just `dir(<your CLI>):dir(node):<cron's default>`, and
> `--supervisor=disable` removes the line together with the block. If you keep your own jobs
> below the block and depend on your own `PATH`, either put them above it or repeat your
> own `PATH=` — a cron setting line is not scoped the way a shell's is.

**Failure modes.**

| Symptom | Meaning | What happens |
|---|---|---|
| `no crontab for <user>` (`crontab -l` exits 1) | no crontab yet | treated as empty — the enable does not abort |
| the cron daemon is not running | nothing fires | the block is written but never runs; stated, not hidden |
| macOS TCC | a job touching a protected path is silently blocked | the cron / `node` binary needs Full Disk Access — a caveat, not an error |
| the machine sleeps | cron has no run-at-load | a tick is simply missed; the next ping or continue firing recovers |

### What an enabled supervisor runs

An enabled unit is just a clock: it runs the supervisor, and the supervisor claims and
wakes. Enabling does **not** change the worker's permission boundary, which is documented
in full at [Headless permission boundary](#headless-permission-boundary) — nothing here
loosens it: the resident adapters ship **no** bypass flag by default, and turning one on
still needs the written authorization, documented at the point of use, that section
describes.

- **Identity and parameters.** The units start the supervisor with `--actor-kind <h>`, `--agent
  <installer name>` and one pass (`taskctl loop run --ping-once` / `--continue-once`). The
  `--agent` is the loop's **writer** identity — the minimal unit environment has no
  `TASKCTL_AGENT` to inherit. It does not narrow the claim set, which is every discovered
  worker-lane role (plus every discovered reviewer-lane role). The tick runs the passes
  in-process; poll claims a card and enqueues it, and the resident pool runs the card in its
  own worker session on the kind that carries the role. A resumed session continues it (`claude --resume <sid>` /
  `codex thread/resume` / `pi --session-id <sid>` are the resident resume forms;
  `claude -p "<handoff>" [--resume <sid>]` etc. are the one-shot shapes).
- **Logs.** `<config root>/logs/supervisor.log` (the supervisor's `--log`) — one file for
  every actor kind, each line tagged `actor_kind=<kind>` — written and rotated by the supervisor
  itself. The units do **not** redirect their stdout/stderr into it — that would duplicate
  every line; cron sends the same output to `/dev/null` because `--log` already writes it.
- **State.** `<agent-dir>/meerkat-taskpanel/supervisor.state.json` — the running registry.
- **Working directory.** A woken worker still `cd`s to the directory the map names for
  the card's project (`local_path ?? run_dir`), resolved by the poll pass from the
  config-root `projects.json`; enabling changes nothing here (see
  [Where a worker runs](#where-a-worker-runs)).
- **Task process data.** A dispatched card's brief (`card.md`) and the subagent's files —
  including downloaded attachments — live under `.meerkat/<identifier>/` in that working
  directory. Poll registers the brief watch before the claim; a failed registration (or an
  already-terminal card) defers the card unclaimed. A review card whose original is already
  covered by a live detached registration is still admitted (the covered card stays with
  that registration), and only a registration this pass created is unregistered again when
  the claim is refused.

### One mechanism per machine, and the cost gate

- **One scheduler per machine.** `--scheduler` picks exactly one mechanism (launchd, systemd or
  cron), and `--supervisor=enable` loads one primary kind. To move from, say, cron to launchd,
  disable the first: the enable path may do disable-then-enable, but it never leaves two
  loaded. Two loaded units only race each other for the same cards.
- **The cost model.** Enabling installs two clocks. The **ping** clock is $0: one
  small registry read, no board, no LLM. The **tick** clock is also $0 in tokens — it runs
  deterministic passes; the only model turns are the worker/reviewer sessions a successful
  claim opens and the director rows a question/route/escalation creates. The poll entry is
  the deterministic cost gate — a worker turn starts only when a claim succeeded, and patrol
  stays LLM-free by default (`--patrol-llm=no`). See
  [The cost gate: a worker turn starts only on fire](#the-cost-gate-a-worker-turn-starts-only-on-fire).
- **Disable and status** are part of the same entry point: `--supervisor=disable` unloads /
  removes, `--supervisor=status` prints the per-agent kind load state and changes nothing
  (per-OS forms above). Status also names the **primary platform**, the discovered **scan
  set** (worker roles + reviewer-lane roles, read from the target home's role skills) and the
  discovered **role → platform** map (every `installedOn` entry and the effective kind), and
  closes with a machine line — a machine that still runs a second kind's supervisor is visible
  there, with the command that stops it.

### OpenClaw stays excluded

The new switch does not change the [OpenClaw
ruling](#openclaw-no-loop-units). `--target openclaw` still installs the
**board skill only** — no `meerkat-director`, `meerkat-chat` or role skills, no units, no
glue, so nothing to enable.
`--target all --supervisor=enable` **skips** openclaw: the enable action applies only to
`{claude,codex,pi}` — and, by the one-supervisor-per-machine rule, by default only to the
first of those in `--target` order. `--supervisor-actor-kinds openclaw` is **rejected**
(reason on stderr, exit 2).

> **Where it is implemented.** `scripts/install/_common.sh` (`apply_supervisor`, the
> per-agent kind action) drives `scripts/install/lib/supervisor.mjs`, which owns the per-OS
> commands above and their failure modes. A refusal is reported
> (`supervisor: not enabled …`) and does **not** fail the install: the agent kind's skills are
> installed either way, and the printed command is what finishes the job.

## Running the supervisor

```bash
taskctl loop run --actor-kind claude --agent alice                  # both clocks (daemon)
taskctl loop run --actor-kind claude --agent alice --ping-once      # one ping
taskctl loop run --agent alice,bob --actor-kind codex               # loop
taskctl loop run --agent alice --dry-run --ping-once                # plan only
taskctl loop run --actor-kind claude --agent alice --continue-once  # one tick
```

The flags are the same either way; a loaded unit names the runtime tree's CLI entry and
`MEERKAT_TASKPANEL_REPO` in the per-kind config is what tells it where that tree is.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--actor-kind claude\|codex\|pi` | `claude` | the supervisor's **primary kind**: its board identity and config (the director lane follows the director skill's location) |
| `--repo <path>` | this checkout — or, for a agent-installed copy, the `MEERKAT_TASKPANEL_REPO` in the per-kind config | repository root: what `--cli` is resolved from, and the fallback working directory |
| `--ping-interval <sec>` | `60` | liveness clock: prune dead worker pids; no board read |
| `--continue-interval <sec>` | `600` | tick clock: run `patrol → workflow → poll` in-process |
| `--max-concurrency <n>` | `8` | cap on simultaneously running worker sessions and reviewer subagents; both share it and the split follows demand (no per-role reservation) |
| `--workspace=worktree\|shared` | `worktree` | a git project's cards each run in `.worktrees/<ref>[-r<round>]` on `lane/<ref>[-r<round>]`; a creation failure defers the card (no fallback). `shared` restores the old shared-checkout behaviour |
| `--claim-unassigned=yes\|no` | from per-kind config → `yes` | also claim unassigned cards (the public pool) |
| `--assignee-only` | — | alias for `--claim-unassigned=no` |
| `--recover-stale=yes\|no` | from per-kind config → `yes` | add stale `in_progress` cards to the candidate read (`--stale`); the claim itself is `issue claim` (holder after 10 min, anyone after 6 h) |
| `--workflow=yes\|no` | from per-kind config → `yes` | run the workflow sub-pass (reconcile → outcomes → dispatch) |
| `--reviewer <agent>` | — | deprecated no-op; the review card's assignee — the role catalog's `default_reviewer` — selects the reviewer |
| `--workflow-max-actions <n>` | `20` | max workflow writes (and bounded reads) per pass |
| `--review-aging-minutes <n>` | `60` | report a review card that has had no readable verdict this long |
| `--continue=yes\|no` | from per-kind config → `yes` | enable the tick clock |
| `--continue-state <path>` | `continue.state.json` beside `--state` | the single-flight lock for the tick |
| `--ping-once` / `--continue-once` | off | on `loop run`: run only that clock's pass, then exit |
| `--patrol-interval <sec>` | `300` | the SLA **measurement** period (it no longer schedules anything) |
| `--patrol-llm=yes\|no` | `no` | let patrol start an LLM turn on a stale card |
| `--notify <cmd>` | — | run `<cmd>` with each patrol alert as JSON on stdin — both the legacy heartbeat alert and the SLA tuple |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--log <path>` | `<config root>/logs/supervisor.log` | where the tick log appends (one file for every actor kind) |
| `--state <path>` | `<home>/<agent-dir>/meerkat-taskpanel/supervisor.state.json` | the running registry |
| `--sla-ledger <path>` | `sla-ledger.json` beside `--state` | the SLA de-duplication ledger; an unreadable one suppresses nothing |
| `--workflow-ledger <path>` | `workflow-ledger.json` beside `--state` | the workflow alert de-duplication ledger; an unreadable one suppresses nothing |
| `--sla-leader <id>` | from `$MEERKAT_TASKPANEL_SLA_LEADER`, else unset | the author id the leader writes under, for the `leader_stalled` attribution set; unset ⇒ the board's own decision authority (`author_kind = "human"`). Set the **same** identity on both mechanisms |
| `--sla-last-ok <path>` | `loop-patrol-last-ok.json` beside `--state` | where this mechanism publishes its own last-successful-run marker for the peer's watchdog |
| `--sla-peer <path>` | from `$MEERKAT_TASKPANEL_SLA_PEER`, else unset | the peer inspector's last-ok marker; a marker older than `3 × P_peer` raises `inspector_liveness`, where `P_peer` is the cadence the marker declares (fallback 15min). Unset ⇒ the peer's half is a registered dependency and nothing alarms |
| `--board-limit <n>` | `500` | max cards read in one patrol pass |
| `--trail-limit <n>` | `200` | max comment trails read in one pass (a cap is always logged) |
| `--config <path>` | `<program root>/.env.<actor-kind>` (or `MEERKAT_TASKPANEL_CONFIG_DIR`) | per-kind config: the supervisor's claim default and concurrency cap, `MEERKAT_TASKPANEL_REPO`, and — on the board path — the per-agent identity |
| `--env-file <path>` | `$MEERKAT_TASKPANEL_ENV_FILE`, else `<repo>/.env` | the shared config file the subscriber's `taskctl` calls read (`TASKD_URL`, `TASKD_TOKEN`, …) |
| `--home <path>` | `$HOME` | base for the agent directories (state, skills — not the log) |

The project map is not a flag: the poll pass and `taskctl project dir` read the same
`<config root>/projects.json` ([Where a worker runs](#where-a-worker-runs)).

**Fixed paths.** Logs and state always land at the paths in the table — a user
who wants to know why a card did not start reads one file,
`~/.meerkat-taskpanel/logs/supervisor.log` for a combined install (the config
root's `logs/` for an agent-only one); its lines name their `actor_kind=`. The state
stays per kind: `~/.claude/meerkat-taskpanel/` (or `.codex/`, `.agents/`).

## The claim-unassigned policy

The supervisor's one policy knob is whether it may take **unassigned** cards —
the public pool — or only cards routed to the agent. The board exposes both
through one read: `issue candidates --assignee <name> [--include-unassigned]`.

`install.sh` asks once (when stdin is a TTY and no flag was given; the no-options wizard
asks it as part of its one flow and then skips this prompt):

```
Allow claiming unassigned tasks? [Y/n]
```

and remembers the answer in the per-kind config file:

```ini
# <program root>/.env.<actor-kind>
MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes
MEERKAT_TASKPANEL_RECOVER_STALE=yes
```

Precedence when the supervisor resolves it: `--claim-unassigned` flag →
`$MEERKAT_TASKPANEL_CLAIM_UNASSIGNED` → the config file → default `yes`. A non-interactive
install defaults to **yes**; `--claim-unassigned=no` / `--assignee-only`
persist `no`.

**Stale recovery is a second opt-out**, resolved the same way:
`--recover-stale` → `$MEERKAT_TASKPANEL_RECOVER_STALE` → the config file → `yes`. With it
on, the poll's candidate read includes `--stale` and every wake claims through
`issue claim`; with it off, the supervisor never takes over an `in_progress` card and the SLA
alert is the only signal. The two policies are independent: an assignee-only supervisor can
still recover its own stale claims, and a public-pool supervisor can refuse takeovers.

The same three-source precedence governs the workflow channel's answer, persisted beside
it:

```ini
MEERKAT_TASKPANEL_WORKFLOW=yes
```

Reviewer selection is not configuration: the local role catalog's `default_reviewer` owns
it, and `MEERKAT_TASKPANEL_REVIEWER` is deprecated and ignored. Re-running the installer adds
keys an older config lacks and never overwrites one it already has.

## The end-to-end path

```
launchd / systemd / cron  ──ping 60s──▶  taskctl loop run --ping-once
                                            prune registry entries whose pid is gone
                                            no board, no claim, no LLM

launchd / systemd / cron  ──tick 600s──▶  taskctl loop run --continue-once
                                            (single-flight lock; no model turn)
                                                ├─ passes.mjs patrol    notify-only SLA
                                                ├─ passes.mjs workflow  apply board workflow plan (taskd)
                                                └─ passes.mjs poll
                                                      scan set = discovered worker-lane roles ∪ discovered reviewer-lane roles
                                                      issue candidates --assignee <role> --include-unassigned
                                                          (empty → stop; 0 sessions)
                                                      issue claim <ref>        ← atomic claim, the only dispatch
                                                          refused → stop
                                                      enqueue {kind, handoff}  ← the pool takes it from here
                                                          ↓
                                        pool opens/resumes worker:<card>:r<round>
                                          on the role's kind, cwd = the card's worktree
                                          … reads card.md + role skill, works, reports, delivers …
```

## Verifying the generated hook

The installer *generates* one claim entry point — the Claude SessionStart hook.
`scripts/verify/profiles.mjs` only proves it *landed*; it never runs it.
`scripts/verify/kind-runtime.mjs` runs it, offline, in CI:

```bash
node scripts/verify/kind-runtime.mjs            # all agent kinds; exit 0 only if every assert passes
node scripts/verify/kind-runtime.mjs --actor-kind claude
```

The harness installs into a throwaway prefix (never `$HOME`), then swaps in a **canned
`taskctl` shim** (the board boundary), which records its argv. It then asserts the actual
invocation, not just the exit code:

| Path | Asserted |
|---|---|
| `session-start.sh` (claude) | calls `issue candidates --assignee <agent>`, prints candidates + the eight rules, and is **non-fatal** — a failing or missing shim still exits 0 with a PATH-independent fallback |

**Coverage boundary (what this does *not* prove).** It pins the generated *shell entry
point* against a mock board. It does not drive the real agent CLIs (that is the
supplementary `scripts/verify/kind-cli.mjs`, which SKIPs when a CLI is absent) and it does
not exercise the real board's claim semantics (`scripts/verify/install-e2e.sh` drives the
real `taskctl`/`taskd`). Per agent kind, only the forms the bundle actually ships are
covered: Claude has a SessionStart hook; the bundle writes none for Codex and Pi (setup-meerkat's
optional worktree step can add a guard adapter), and their scheduling units are the automation. (The `taskctl` shim is not one of these forms and is not part of
this boundary: every agent kind gets one — see `docs/ops/install.md`.)

## See also

- [`install.md`](ops/install.md) — the installer flags, including `--claim-unassigned` and the
  opt-in `--supervisor=enable|disable|status`.
- [`../skills/meerkat-director/SKILL.md`](../skills/meerkat-director/SKILL.md) — the decision
  hub; its `references/decision-policy.md` is the shared core and `references/rounds.md` the
  round method this page designs. The skill is supervisor-only: the human console is
  `meerkat-chat`, never this one.
- [`../skills/meerkat-chat/SKILL.md`](../skills/meerkat-chat/SKILL.md) — the human's live
  console: progress, awaiting questions, acceptance, `loop doctor` and abnormal cards.
- [`../skills/jobs/SKILL.md`](../skills/jobs/SKILL.md) and its four siblings — the role
  workflows, discovered per platform from their `role.json`.
- [`../skills/meerkat/SKILL.md`](../skills/meerkat/SKILL.md) —
  the agent-facing view: §Owning the clock.
- [`../skills/meerkat/references/cli.md`](../skills/meerkat/references/cli.md) —
  `issue candidates --include-unassigned`.
