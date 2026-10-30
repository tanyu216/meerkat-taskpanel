# The scheduling model: task-card dispatch, the supervisor and the loop

A board is a state machine; something has to turn it. This page is the **design** of that
something: how a card that is ready gets claimed, dispatched, watched, reviewed and closed
when the agent kind doing the work has **no clock of its own** — Claude Code, Codex and Pi
only run when a session starts them.

The design stance, in four sentences:

- The scheduler lives **outside** the agent application: `taskctl loop …`
  (`src/orchestrator/`) ships with the toolkit, and the application is only ever the worker
  that gets woken. The decisions the loop applies are the
  **[`meerkat-loop`](../skills/meerkat-loop/SKILL.md) skill**; this page is the system those
  decisions run inside.
- It owns **two clocks** — a cheap *ping* for liveness and one *continue* judgment turn — and
  performs no board I/O of its own.
- The board work is **deterministic passes** — `taskctl loop poll|patrol|workflow` — that the
  continue turn invokes; the model's invariants live in those passes and in the board, never
  in a prompt.
- A **resident session pool** turns an abstract "dispatch" into one project session per
  target directory and one subagent per card. Without it the loop still patrols and applies
  workflow, but it dispatches nothing.

## Design at a glance

| Component | Responsibility | Invariant it upholds |
|---|---|---|
| **ping** clock | prunes dead pids, keeps the registry honest | no board read and no model turn |
| **continue** turn | one judgment turn per cadence; runs the deterministic passes | bounded — one per interval |
| **poll** | scans candidates, claims, enqueues the handoff | **the atomic claim is the single dispatch source** |
| **patrol** | the SLA pass: stale claims, review aging, recovery | no silent state; every alert is re-checked before emit |
| **workflow** | review dispatch, verdict application, containers | the delivery gate is enforced by the board, not the prompt |
| **session pool** | one control session plus one project session per directory | one writer per card; concurrency is capped |
| **subscriber** | event-driven continue turns | a latency path only — the clocks remain the fallback |
| **taskd guard** | keepalive for the board service itself | one guard per machine; one writer per data directory |
| **loop supervisor** | the loop's clocks, pool and subscriber for one agent kind | one loop supervisor per machine; one mechanism per agent kind |

The model in one line: **the board is the source of truth, the claim is the only dispatch
source, and every clock is a bounded, idempotent pass over state the board already holds.**

Two execution shapes serve the same model:

- **resident** (default on launchd/systemd): `taskctl loop session` runs a long-lived *session
  pool* — one control conversation that runs the continue turn, plus one *project
  session* per target directory whose subagents do the work. Poll claims a card and
  **enqueues** the handoff; the pool spawns the worker/reviewer as a subagent of the
  project session, so it inherits the project directory as its cwd.
- **one-shot** (cron, or an agent kind with no session service): each continue cadence
  starts one agent process for the judgment turn. With no resident pool, poll claims
  nothing and worker/reviewer dispatch is paused — see
  [No resident pool: what still runs](#no-resident-pool-what-still-runs).

What the loop does **not** own: the board's data, the review decision and the acceptance
authority. Those belong to the board, the
[`meerkat`](../skills/meerkat/SKILL.md) skill and [acceptance.md](acceptance.md). This page
stops at the boundary of the scheduler.

**How to read the rest** — the model ([two clocks](#the-two-clocks),
[time contract](#the-time-contract)); dispatch
([atomic claim](#atomic-claim--the-single-dispatch-source),
[the cost gate](#the-cost-gate-a-worker-turn-starts-only-on-fire),
[the session pool](#the-resident-session-pool)); liveness and SLA
([heartbeat](#fresh-heartbeat-is-a-no-op-a-broken-one-is-never-silent),
[the rest of the table](#the-rest-of-the-sla-table-the-same-pass-five-more-rows)); delivery
([the workflow channel](#the-workflow-channel-review-acceptance-and-containers),
[team roles](#team-roles-optional)); runtime
([where a worker runs](#where-a-worker-runs),
[where the supervisor runs](#where-the-supervisor-runs),
[the agent kinds](#the-three-agent-kinds-how-each-one-is-triggered)); operations
([enabling](#enabling-the-supervisor-opt-in), [running](#running-the-supervisor),
[verifying the hook](#verifying-the-generated-hook)); and the policies every deployment
shares ([claim-unassigned](#the-claim-unassigned-policy),
[end to end](#the-end-to-end-path)).

The loop is a skill of its own, and it is distributed as one: `claude`, `codex` and `pi`
install it; OpenClaw installs the board skill only, because its agent framework runs the
equivalent automations itself (see
[OpenClaw: no loop units](#openclaw-no-loop-units)).

## The two clocks

The supervisor is a **scheduler**. It owns two clocks and performs no board I/O
of its own. The deterministic work — poll, patrol, workflow — lives in
separate `taskctl loop` verbs, and the continue turn invokes them.

| | **ping** | **continue** | **session** |
|---|---|---|---|
| Cadence | 60 seconds | 600 seconds (10 minutes) | long-lived |
| Job | process liveness: prune worker registry entries whose pid is gone | enqueue the bounded `/meerkat-loop Continue` turn for the control session (or run it one-shot when no pool is live) | hold the control and project conversations; route queued handoffs to project sessions |
| Reads | `supervisor.state.json` only | the scheduler reads nothing | the queues, the ledger, `sessions.state.json` |
| On a hit | — | the control turn runs `patrol → workflow → poll` | poll claims + enqueues; the project session spawns the subagent |
| Cost | one small file read | one bounded LLM turn | one agent conversation per active project |
| Why it exists | a dead worker must not pin a concurrency slot | the loop's work needs a turn that can judge, claim and dispatch | a subagent inherits its parent session's cwd, so a project needs its own session |

The split is deliberate. A 60-second clock that read the board would be a poll
again; a 10-minute clock that ran the entries itself would keep the loop's
responsibilities inside the scheduler. On launchd/systemd the **event subscriber**
(`taskctl loop subscribe`) follows the local event hub through `taskctl events follow` and asks for a
continue turn when a dispatch-relevant event arrives, so a new card or a completed dependency
is seen within seconds; the hub owns the host's single board connection and its reconnect
ladder, and the subscriber's `follow` child sees the same records `events tail` would. It is
part of the enabled set, not a separate switch, and it is a **latency path only**: the
continue clock remains the fallback and the only path for time-based work (stale claims,
review aging, SLA tiers), and an event wakes a turn only while a resident pool is live.
On cron — which cannot host a long-lived process — discovery stays at most one continue
cadence. `--continue-interval` is still the lever for that fallback; lowering it raises the
LLM cost linearly.

The deterministic passes are **not scheduled individually**:

| Entry | Job | Writes |
|---|---|---|
| `taskctl loop poll` | scan → atomic claim → **enqueue the handoff**; also enqueues open agent questions (the question lane) | claims, card queue |
| `taskctl loop patrol` | heartbeat alerts + SLA rows | card queue only with `--patrol-llm=yes` |
| `taskctl loop workflow` | apply the board's workflow plan (`issue reconcile --workflow`) | review actions, as `system`/`Orchestrator` |

`taskctl loop doctor` is **not** one of these passes. It is the read-only inspection a human
runs: one report covering the supervisor verdict, the resolved scan set, board compatibility,
the patrol's last-successful-run marker, the tail of the loop log, the queue and subagent
ledger, the cards that look stuck (a stale or unreadable heartbeat, judged by the patrol's own
plan — an `epic` container is not a stale worker), and the `in_review` cards waiting on a human
with their age. That last list is **facts
only**: review aging is the workflow pass's judgement and applies to review cards that are
*not* `in_review` (`docs/lifecycle.md`), so the inspection neither restates nor widens it. It
claims, dispatches, starts and writes nothing — its board read runs
with autostart disabled — and it exits 0 whenever a report was produced, so a scheduled
inspection reads `attention` from `--json` rather than an exit code.

The continue prompt runs them in the order **patrol → workflow → poll**: the
workflow pass dispatches a review card, and the poll that follows in the same
turn can enqueue its reviewer immediately. Polling first would delay that review
by a whole cadence.

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
| continue interval | 10 min | `src/orchestrator/options.mjs` |
| queue `recoverStaleCards` | `2 × turn` | `src/orchestrator/session.mjs` |
| ledger live-row reap | 2 h (`LEDGER_STALE_MS`) | `src/foundation/scheduling.mjs` |
| pool heartbeat / stale | 15 s / 60 s | `src/orchestrator/session.mjs` |
| project idle / session max age | 30 min / 24 h | `src/orchestrator/options.mjs` |

The contract:

- `HEARTBEAT_FRESH_MS < CLAIM_STALE_SAME_MS < CLAIM_STALE_ANY_MS` — a claim is fresh longer
  than a worker is told to pulse, and a takeover is later still.
- `2 × HEARTBEAT_FRESH_MS ≤ TURN_MIN` and `TURN_DEFAULT < LEDGER_STALE_MS` — a turn covers two
  pulse windows and still ends before the ledger reclaims a live row.
- `CONTINUE_INTERVAL < TURN_DEFAULT`; `PATROL_STALE_MS = CLAIM_STALE_SAME_MS`;
  `POOL_STALE_MS > POOL_HEARTBEAT_MS`.

**`awaiting` is exempt from three scans**, by design:

- `planPatrol` scans `in_progress` only, so an awaiting card never produces a stale-heartbeat
  alert — it holds a *dormant* claim;
- `issue candidates --stale` returns `in_progress` recoveries only, so an awaiting card is
  never offered as a stealable claim;
- the ledger's live-row reap is age-based, so a stopped worker's concurrency slot is
  reclaimed by the 2-hour bound at the latest regardless of which state the card is in.

After a human answers, the card is `todo`; dispatch happens on the next continue/poll (the
default 10-minute cadence, or sooner when the event subscriber fires). That delay is the
continue interval, not a new clock.

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
other is wasteful, not incorrect — the loser's claim is refused. The continue
turn does have a single-flight lock (`continue.state.json`), because a second
LLM turn is pure cost, not a wasted claim; the lock is separate from the worker
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
  its session rather than reusing it.

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
 └─ enqueue    cards.queue.json (handoff, target_dir, role, task_id)
                     ↓
                project session (cwd = target_dir) → one subagent per card  ← the tokens
```

The continue turn itself is the one LLM turn the scheduler pays for, once per
cadence, whether or not the board has work: it is the loop's judgment turn.
Inside it, the poll entry is still the deterministic cost gate above. The project
session's turn — one per batch of handoffs for a directory, not one per card — is
the second cost, and it buys a subagent that starts in the right directory.
`--dry-run` prints the plan and starts neither a claim nor a worker.

## The resident session pool

A subagent inherits the **launch cwd of the session that spawns it**; a main
session that `cd`s later does not move its subagents. Claude Code's Agent tool
also ignores a per-call `cwd`. One board-wide session therefore cannot give two
projects two directories — so the pool keeps **one worker session per target
directory**, each launched in that directory, and the subagents it spawns are
already where they belong. A review card gets a **second conversation in the same
directory**, opened with the `reviewer` role: a subagent inherits its session's
permission surface, and only that lane's surface excludes Write.

```text
session service (`taskctl loop session`)
├── control session        cwd = the taskpanel checkout
│     /meerkat-loop Continue → patrol → workflow → poll
│     poll: export .meerkat/<id>/card.md, claim, write the handoff queue
├── project session        cwd = <project target_dir>   (one per directory)
│     batch prompt → spawn one worker subagent per card
│     worker subagents inherit the project directory
└── reviewer session       cwd = the same target_dir     (opened on demand)
      batch prompt → spawn one reviewer subagent per review card
      the reviewer allowlist has no Write
```

- **Control session** — runs the judgment turn; it never spawns a worker and never
  works a card itself. Poll only claims and enqueues.
- **Project sessions** — created on demand from the machine-local
  `projects.json` at the config root (`local_path ?? run_dir`, through the same
  `resolveWakeDir` the glue uses). A card whose project is unmapped or names no directory is **deferred
  before the claim**, so the board never shows a claim that has nowhere to run.
  The batch prompt tells the session to spawn one subagent per card, **in the
  listed order** (the loop pairs agent ids with cards by position), and return
  without working them.
- **Reviewer sessions** — keyed `<dir>#reviewer`, opened only when a review card
  is queued and evicted by the same idle clock. The batch prompt is the reviewer
  variant: no question ladder, verdict-only. The allowlist is real for Claude and
  Pi; Codex, OpenCode and Cursor adapters have no per-role tool surface, and the
  pool logs a one-time warning for them.
- **Ledger** (`subagents.state.json`) — the application-level record of each
  subagent: `sessionKey` (the project directory), `lane` (`worker`/`reviewer`),
  actor kind, subagent id, role, card, status. The live-row reap is the only
  completion signal the supervisor trusts beyond a finished turn.
- **Resume** — the control and project sessions resume by session id. Subagents do
  not: on start the pool sends a re-attach prompt (native reattach where the agent kind
  supports it — Claude `SendMessage`, Codex child `thread/resume`, Pi subagent
  resume), and anything that cannot be
  reattached is marked stale and left to the board's claim recovery.
- **Capacity** — `--session-pool-max` (8), `--project-concurrency`
  (default `--max-concurrency`) and `--max-concurrency` bound the pool. Poll's
  claim budget is `max-concurrency − live subagents − queued cards`; at zero it
  claims nothing and says so. `--max-concurrency` is **one cap for all
  subagents**: workers and reviewers share it and compete for slots by demand —
  the loop reserves no slots per role, so a review backlog may take the whole cap
  (at the default 8, 6 workers + 2 reviewers is the nominal steady state, not a
  guarantee). `--session-pool-max` bounds **lanes**, so a directory running both
  a worker and a reviewer session holds two of them. An idle lane closes after
  `--project-idle-ms` (30 min) and keeps its session id; every session gets a
  fresh conversation after `--session-max-age` (24 h).
- **Concurrency and the working tree.** Planning and claiming are sequential; the project
  turns then fan out, so one slow project does not serialize the others. The per-tick
  budget is fixed before the first send, and `--project-concurrency` counts a project's
  worktrees and both of its lanes as one project. Each card in a git project runs in its own
  worktree (see "Per-card workspace isolation" below); `--workspace=shared` is the explicit
  opt-out and logs one warning per directory when parallel cards share a git checkout.
- **One lock** — a second `taskctl loop session` on the same state directory is refused
  (`session.lock`). The pool writes a heartbeat every 15 s so a pass in another
  process can tell "busy" from "gone".

### Per-card workspace isolation

The loop creates a git worktree for every card in a git project
(`.worktrees/<ref>[-r<round>]` on branch `lane/<ref>[-r<round>]`) and points the queue's
`target_dir` at it. The base is the project's declared `base_ref`, else the project
directory's current branch; a rework starts from the previous round's lane branch. A
creation failure defers the card — there is no fallback to the shared checkout.
`--workspace=shared` restores the old behaviour explicitly.

The per-project cap counts a project's worktrees as one project (`--project-concurrency`),
not one directory. Acceptance **lands** the work: the lane branch is merged into the
project's current branch before the card reaches `done`; a dirty project checkout or a
merge conflict keeps the card in `in_review` and leaves the worktree and branch for a human.
Cleanup (worktree first, then the merged branch) happens only when the card is terminal.

### No resident pool: what still runs

The pool is the only dispatcher, so without it a claim has nowhere to go. The
fallback is deliberately smaller rather than silently degraded:

| Piece | Without a resident pool |
|---|---|
| `poll` | **claims nothing**, scans nothing, logs why; one `--notify` alert per cadence (`kind: no_resident`) |
| one-shot continue | runs **patrol + workflow only** — the prompt omits poll entirely |
| `patrol --patrol-llm=yes` | notify-only; no LLM turn |
| `workflow` | runs; review cards accumulate and are claimed once the pool is back |

With an **external-control** pool the pool row does not apply: the pool exists, so `poll`
claims; the live session, not a headless control, runs the turn.

This is the cron shape: cron cannot host a long-lived process, so a cron install
runs ping + a one-shot continue and **cannot dispatch worker/reviewer subagents**.
An agent kind with a session service gets the full loop. `--resident=no` forces the
fallback even when a pool is running.

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

## The rest of the SLA table: the same pass, five more rows

A stale heartbeat is **one** row of the SLA contract's threshold table. The others —
a card parked on the leader's clarification, an unanswered confirmation gate, a
delivery nobody queued an acceptance review for, a defect whose fix card was
never created, and the leader's own patrol going quiet — used to be invisible to
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
- **The board computes; the loop notifies.** `planSlaPatrol` is still the one
  decision, but it runs in the board (`GET /api/v1/sla`, `taskctl sla list|get`).
  The loop's patrol reads those rows, de-duplicates them against its ledger,
  re-reads a survivor (`sla get <ref>`) and notifies. `inspector_liveness` is the
  one row the loop computes itself, because the peer marker is a file on the machine that runs it.
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
  is the loop's one writing channel, and it is a separate pass with its own plan.
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
human. The **board** now owns those decisions; the loop's **workflow pass**
(`taskctl loop workflow`) executes them. It is a pass of its own, run by the
continue turn after patrol.

The board computes one plan through `issue reconcile --workflow` (see
[`status-lifecycle.md`](../skills/meerkat/references/status-lifecycle.md#11-the-boards-workflow-decisions) —
provenance: `src/core/domain/workflow.mjs`; the lifecycle the plan acts on is
[lifecycle.md](lifecycle.md)). The loop never re-derives a decision. The plan has four parts,
in this order:

1. **reconcile.** The board replays the container rules
   (`src/core/commands/rollup.mjs`) and returns the classified changes and notices.
   Normal in-flight verdicts (`children_unfinished`, `no_child_started`,
   `awaiting_acceptance`) are silent — the SLA pass already watches stuck children.
   `empty_epic` waits out a 30-minute grace period; `no_delivery_evidence`,
   `no_child_done` and `dangling_child_edge` are notified, naming the blocking children.
2. **outcomes.** The plan says what each readable verdict means for the card it audits
   (below); the loop applies it.
3. **auto-accept.** For every flow-A card in `in_review` whose `acceptance_mode` is `off`,
   and with no current-round review card (a canceled one does not block), the plan emits
   `auto_accept`. The loop writes `meta.accepted_by=loop-auto` and moves the card
   `in_review → done`. A `human` card never reaches this part — its mode is not `off`, so it
   is reviewed instead, and only the close waits for the person. Nothing is alerted for this
   state: silence is the implemented behaviour.
4. **dispatch.** For every flow-A card in `in_review` whose `acceptance_mode` is `agent` or
   `human` — review is mode-independent; only `off` is skipped — create a review card for the
   effective reviewer, one per `(original, delivery round)`, with the deterministic
   idempotency key `loop-review|<ref>|r<round>`. The effective reviewer is
   `project.reviewer ??` the deployment reviewer (the reconcile request's `--reviewer`).
   There is no kind filter: a finished epic is dispatched in the same pass that rolls it up,
   and its reviewer reads the child cards and the rollup report.

### The review card, and who closes it

A review card is an ordinary `kind=task` card, created with `review_of` (the original's
identifier or id) and, optionally, `review_round` (a positive integer), plus `meta.flow=B`
and a `review` label for discoverability. At creation the board resolves that reference and
stamps **both** the immutable structural marker (`review_of_id` / `review_round`, 0025) and
its readable mirror in `meta` (`meta.review_of` = the original's identifier,
`meta.review_round` = the integer round). Detection reads the structural column first and
falls back to `meta.review_of` for a snapshot written before 0025; the acceptance gate reads
the column only. A caller-supplied `meta.review_of` given as an id, or a string round, is
normalized to the resolved identifier and an integer, and a meta patch is canonicalized
from the column, so a later PATCH cannot make the two spellings disagree. There is no
`kind=review`: the board's kinds are `task`/`epic` (0038 retired `deploy`), and a review is
a task like any other.

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
- the loop applies the verdict as `--actor-kind system --agent Orchestrator`. An `APPROVE` on an `agent` original
  writes `meta.accepted_by=loop-review` and moves it `in_review → done`; on a `human`
  original it writes `meta.review_verdict=approve` / `meta.review_verdict_round` and leaves
  the card `in_review` for the person. A `REJECT` — in either mode — comments the findings,
  writes `meta.rework_round`, moves the card back to rework, and appends the reviewer's
  numbered must-fix items to the original's frozen acceptance (the move to `in_progress` is
  what unlocks the baseline). Each item is then an ordinary acceptance criterion: the next
  round's report template lists it and the next review card's baseline carries it, so a
  dropped finding fails the coverage gate. A `REJECT` with no numbered list appends one
  pointer item rather than nothing. Only after that does it close the review card.
- The loop always closes the review card it dispatched — there is no switch that could leave
  it for nobody. On a `human` card it records the round-scoped verdict and stops; the person
  closes the original through the ordinary acceptance gate.
- An `agent` card with no effective reviewer is refused at startup: the loop reads
  `project list` and computes `project.reviewer ?? the deployment reviewer`. The board still
  reports `reviewer_not_configured` per project at runtime.

Why not let the reviewer close its own card (or skip the card entirely)? A reviewer that
both produces the verdict and accepts it is not a second pair of eyes, and a card is the
retryable artefact: a crash between "apply the verdict" and "close the review" is
recovered on the next pass, whereas a missing card leaves nothing to recover from. The
separation is exactly what the `review_of` card encodes — a separate card carries the
verdict, and an actor other than the reviewer applies it; the loop is that actor's automated
stand-in.

### Acceptance authority is enforced by the board

The separation is not only a prompt rule. `in_review → done` has a **board-level
acceptance authority**: the card's own `acceptance_mode` decides who may perform it.
`off` may be closed by the deliverer, the loop (the workflow pass) or a human, and
`in_progress → done` is allowed; `agent` waits for a current-round `APPROVE`, then any
actor but the one who wrote the verdict closes it — the loop, another agent, or a human;
`human` is a person only. A review card is the one structural exception — its reviewer
reports the verdict, and anyone but that reviewer (or a human) closes it. The **kind is not
an allow-list**: the authority is the evidence, so the board's own `system` writes carry no
extra right. There is no board-level policy and no child/top-level matrix. The refusal is
`ACCEPTANCE_FORBIDDEN` (409) and it changes nothing. This is what makes "a worker stops
at `in_review`" a machine rule rather than a habit, and it is why the loop's automated
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

- **One agent kind per supervisor.** The reviewer is woken by the same supervisor and the same
  agent CLI as the workers; a reviewer on a different agent kind (there is no cross-kind reviewer flag) is not implemented.
  If review needs a different runtime, run a second supervisor with its own `--reviewer`
  on that machine.
- **The reviewer's tool surface is enforced only where the adapter can enforce it.**
  A review card runs in its own `role=reviewer` conversation, so Claude and Pi apply
  the reviewer allowlist (no `Edit`/`Write`) to the subagent it spawns. Codex,
  OpenCode and Cursor adapters have no per-role tool surface; there the boundary is
  the prompt plus the board's acceptance authority and the loop's report-attribution
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
  the reviewer is woken by the poll entry in the continue turn, through the normal claim, so the cost gate
  is unchanged. A dedicated reviewer is scanned for review cards only and never claims the
  public pool; a reviewer that is also a worker keeps the ordinary lane.
- **Bounded.** At most `--workflow-max-actions` (default 20) writes per pass. Reads are
  bounded by `--board-limit` (default 500), which also decides whether the snapshot is
  truncated. When the combined outcome+dispatch slice drops work, the plan carries one
  `actions_capped` (cap / dropped / outcomes / dispatch); `dispatch_capped` remains the
  log-only dispatch-only overflow. A cap is logged.
- **Fail-safe.** An unreadable verdict, an unseen original or a conflicting verdict
  (`done` + `REJECT`) produces an alert and **no write**; the review card stays put and the
  next pass retries. A round mismatch closes the review card (`close_review`, reason
  `round_mismatch`); no configuration makes the loop leave it behind. A truncated board read dispatches nothing; an `original_unseen`
  found on that partial read is marked `reason: board_truncated` / `undecidable: true` (with
  its own ledger key), because the original may sit below the read cap.
- **The verdict must come from the reviewer.** The report's author is checked against the
  review card's assignee — the effective reviewer recorded at dispatch — with the deployment
  reviewer as the fallback, by id and display name. A report written by anybody else is
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
- **Notified only when actionable.** Standing state — no reviewer configured, a
  dispatch-only cap — is logged, not sent to `--notify` on every period. Findings an
  operator can act on (including `review_aging`, an unattributable verdict and
  `actions_capped`) are notified; the ledger suppresses repeats, keyed to the state rather
  than the clock.
- **One action failing never stops the rest**; the review card is always closed last, so
  every half-applied outcome is recoverable (`original done + APPROVE`,
  `rework_round` matching a rework in progress, …).
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
| reviewer (deployment default) | `--reviewer <agent>` | `MEERKAT_TASKPANEL_REVIEWER` | `Reviewer` (empty disables dispatch) |
| project reviewer override | `project create/update --reviewer <agent>` | — | `null` (use the deployment reviewer) |
| writes per pass | `--workflow-max-actions <n>` | `MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS` | `20` |
| silent-review threshold | `--review-aging-minutes <n>` | `MEERKAT_TASKPANEL_REVIEW_AGING_MINUTES` | `60` |
| workflow alert ledger | `--workflow-ledger <path>` | — | `workflow-ledger.json` beside `--state` |

Precedence is flag → environment → per-kind config → default, the same as the claim policy.
For the board path, `taskctl` reads the same file as a layer between the process environment
and the shared `.env` (so `.env.<kind>` supplies per-agent identity and project-map defaults).
`workflow` gates the whole channel; the reviewer gates only **dispatch** — outcomes still run
without one, so reviews already in flight can finish after a deployment removes its reviewer.

The effective reviewer for a card is `projects.reviewer ??` the deployment reviewer. The loop
reads `project list` at startup to merge every project reviewer into its scan/wake set, and
refuses to start when an `agent` card would be dispatachable with no effective reviewer.

**Who closes a card is the card's own `acceptance_mode`** — `off` (the deliverer may close it,
and `in_progress → done` is allowed), `agent` (a current-round `APPROVE`, applied by the loop)
or `human` (a person only, after the verdict is recorded). The project's `acceptance`
(`auto | off | agent | human`) is the default a new card inherits; an unresolved card — task
or epic — falls back to `agent`. `human` is opt-in and **top-level only**: a project-level
`human` gives a child that names no mode `agent`, and no parent edge may attach to a `human`
card. The loop's creator path passes `--acceptance-mode` explicitly when the project says
`auto`. There is no board-level policy and no local copy to keep in step. A `human` card is
reviewed like an `agent` one; the loop records the verdict and stops, and it never closes the
card itself. A container is a card too: an epic is dispatched a review card like any other
(its review reads the rollup and the child cards) and is closed only after an `APPROVE`.

## Team roles (optional)

A deployment may give its agents named roles — the standard team is **Jobs** (product
design), **Linus** (architecture, implementation and refactoring), **Turing** (acceptance) and a
separate **Reviewer**. The board never sees a "role": Jobs/Linus/Turing are ordinary board
**agent names**, so the creator, the assignee and the report author are recorded as those
names. Roles are installed by `/setup-meerkat`, never by `install.sh`; with no roles root
the loop behaves exactly as it did before the feature.

A roles root is a directory with `manifest.json`:

```text
<roles-root>/
├── manifest.json
├── ownership.md                optional; routes work shapes to one accountable role
├── jobs/{workflow.md,ui-workflow.md,self-check.md}
├── linus/{workflow.md,architecture-workflow.md,implementation-workflow.md,refactor-workflow.md,self-check.md}
├── turing/{workflow.md,test-design-workflow.md,regression-workflow.md,performance-workflow.md,self-check.md}
└── reviewer/{workflow.md,self-check.md,reviewer-prompt.md}
```

Each role carries its board `agent` name, an optional `native_agent` (the Claude/Codex
subagent definition), its `lanes` (`worker` and/or `reviewer`), and relative paths to its
workflow, self-check and reviewer prompt. The loader resolves the **whole manifest** at the
first root that has one:

1. `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`
2. `<project>/.meerkat/roles/`
3. `<agent-dir>/skills/meerkat-loop/roles/` (the global install)

A project set replaces the global set; the roles are not merged one by one. Every path must
stay inside the root, including through symlinks — an escaping or malformed entry warns and
leaves that path `null`, and a broken manifest degrades to "no roles" rather than wedging
the poll or the wake.

**Two layers.** The loop routes by the card's assignee and puts the role's title,
responsibilities and boundaries into the handoff (layer 1); the spawned subagent reads the
role's `workflow.md` (and `self-check.md`) before acting (layer 2). The reviewer's prompt is
inlined at the start of the review handoff, bounded at 2,400 characters. Every role is told
to write and maintain `.meerkat/<identifier>/plan.md`, which the reviewer reads.

**Ownership.** If a team ships an `ownership.md`, it is the work→role routing guide: the
project session receives it in full (bounded at 2,500 characters) when it spawns a batch, and
the control/continue turn receives a compact summary and its path. It assigns one accountable
role per work shape; the card's assignee still selects the executing role, and it never
changes who decides. A shape the guide does not describe is not force-fit into a role — it
goes to a worker outside the roles, whose board name must be in `MEERKAT_TASKPANEL_AGENTS`
because the manifest does not name it. **The create is the routing step**: a team card is
created with its role as the assignee. A card that still lands unowned past 30 minutes is the
control turn's bounded fallback — it carries the role names, since its lane cannot read the
guide — and with `claim_unassigned: no` the workflow pass reports it as `unowned_todo`
instead of letting a scan race for it.

**Decisions.** A subagent does not decide an unauthorized question: it writes an agent
`question` comment on the `in_progress` card and stops. Poll's **question lane** sees the
unanswered question and enqueues a question row for the directory, so the project session is
woken without waiting for the claim to go stale. It answers operationally with a `note`
(and moves the card to `todo`), or escalates to the human with
`issue move <ref> awaiting --awaiting-reason E1..E5`; any human comment resumes an awaiting
card, whatever its kind, and the resumed worker judges from its content whether it is a
complete decision. A question row is not a card handoff: it is never claimed, never opens a
reviewer lane, and does not consume a subagent slot. The read is bounded by `--board-limit`
and costs one `comment list` per `in_progress` card per poll. The ladder is the loop's
`references/decision-policy.md`; it is the single decision-authority source, and a team file
cannot override it.

Questions are asked as one **decision round**: the frontier of decisions whose prerequisites
are settled, numbered Q1..Qn with a recommendation each, one question string per card, with
the asker looking up the facts. The complete protocol — including the collaborative card
mode and the adversarial design mode `/setup-meerkat` uses for the setup interview and team
co-design — is the loop's `references/decision-policy.md` §Decision rounds.

The scan set is still explicit: write `MEERKAT_TASKPANEL_AGENTS=Jobs,Linus,Turing` (and
`MEERKAT_TASKPANEL_REVIEWER=Reviewer`) to the per-kind config, or the loop scans only its
default agent and a role card is never claimed. The installed units carry no `--agent`, so
this key **is** the loop's identity — a name not listed here can never claim its cards.
`/setup-meerkat` does this merge with the user's consent. Roles are installed and upgraded **only** by that skill: `install.sh` never
creates, writes or deletes a roles root, and a forced loop reinstall replaces the **skill**,
not the team — its `roles/` directory is kept, as is any config key the installer's template
does not carry.

## Continuity: a fresh handoff, not a resumed pile

Every wake hands the worker a **bounded, fresh handoff** built by
`buildHandoff()`: the card id and title, that it is a subagent of the project
session and already holds the claim (heartbeat, do not re-claim), the working
directory it inherits, the acceptance-list step (read the card with
`issue get --json`, work to an existing list, or derive one and persist it with
`meta.acceptance_derived=yes`), the exact `taskctl` commands to read and deliver it, and
the attribution flags `--agent <name> --actor-kind <kind> --session-id <id>`. The handoff
is capped at **under 3600 characters** (a test pins it, including a maximum title and a
UUID session id) so a wake never drags an unbounded context into the model.

It names the task's **process directory**, relative to the project session's cwd:
`.meerkat/<identifier>/`. `card.md` inside it is the loop's authoritative export of the
card: poll registers it with the local event hub before the claim, the hub writes the first
snapshot synchronously (a temp file plus an atomic rename), and the registration keeps it
fresh until the card is `done` or `canceled`. The handoff tells the subagent to read it
first, to re-read it on resume, and never to edit it. Every other process file — notes, logs, evidence, report drafts, downloaded
attachments — belongs in the same directory. The board still holds no directory (O3): the
project session's cwd **is** the directory, and `.meerkat/` is the loop's convention under
it — see [Where a worker runs](#where-a-worker-runs).

The hub owns the refresh for every registration: a debounced batch updates each watched file
(and a review card's original, because the loop registers both), independent of whether an
event wakes a continue turn. The refresh is a file write, not an LLM turn; a failure leaves
the previous brief in place.

Continuity across wakes comes from the **board**, not the prompt: the card's
comments, reports and session record are durable, so a resumed conversation can
re-attach to the same work. When a session id is known, the wake adds the agent kind's
own resume form: Claude resumes with `claude -p … --resume <sid>`, Codex with
`codex exec resume <sid> <prompt>`, and Pi with `pi --print --session <sid>
<prompt>`. All three are verified against the real CLIs;
`scripts/verify/kind-resume-matrix.mjs` probes each binary's help output when the CLI
is installed.

## Where a worker runs

A woken worker must run in the **directory its project's work happens in** — the
checkout the work is actually about, or the launch directory a project that has no
checkout supplies. The board cannot say which directory that is (it holds no
directories, O3), and neither can the supervisor: it knows a project **identity** and
nothing else.

So the directory is resolved **locally by the poll pass**, against the one
`<config root>/projects.json` (`references/projects-json.md`) as
`local_path ?? run_dir`, **validated** (absolute, exists, is a directory).

The directory is a **worker's** start directory. The loop writes its own per-task process
data beneath it (`.meerkat/<identifier>/`: `card.md` plus the subagent's files). That is
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
the queue entry as `target_dir`; the pool launches the project session in that
directory, and the subagent inherits it. If the project is unmapped or names no
directory, the card is **deferred before the claim** — it stays `todo`, where the
next turn can offer it again, and the log says why. There is no fallback directory:
a session that runs in the wrong checkout produces confident, misplaced work, which
is worse than no session.

The same map answers the interactive question: `taskctl project dir <project>` prints
a project's registered directory, reports that the entry names none, or exits non-zero
asking which directory it should be, rather than continuing.

## Where the supervisor runs

The loop cannot live inside the agent application, because Claude Code and Codex have **no
timers** — their hooks fire only on session events. So the loop lives outside:

| Option | Shape |
|---|---|
| `taskctl loop …` (this tree) | the scheduler: `loop run --ping-once` / `--continue-once` for the clocks, `loop session` for the resident pool, `loop run` for its own daemon clocks |
| the installed runtime tree | what `install.sh` deploys; the units name `<tree>/src/cli/index.mjs loop …`, and an agent-only install names the checkout |
| the local `taskd` process | a natural home for the same loop in a future milestone |
| the OpenClaw agent framework | on OpenClaw, the framework itself is the supervisor |

The application is just a worker: the poll entry claims on the board, then the resident
project session spawns the agent's subagent in the project directory.

### What the loop's units run with

A scheduler does not start a unit in your login shell. It starts it with a **minimal
`PATH`** of its own — launchd's is `/usr/bin:/bin:/usr/sbin:/sbin`, cron's is typically
`/usr/bin:/bin` — and that set holds no nvm and no Homebrew directory. On such a machine
the loop fails **twice**, and fixing only the first failure makes the symptom worse rather
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
  `taskctl` (the control turn's board reads, a worker's card operations, a reviewer's
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

* * * * * /home/you/.nvm/versions/node/v24.20.0/bin/node /path/to/runtime/src/cli/index.mjs loop run --ping-once --actor-kind claude --log ~/.claude/meerkat-taskpanel/supervisor.log --state-dir ~/.claude/meerkat-taskpanel >/dev/null 2>&1
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

> This is the board **server**'s guard, not the loop. It is separate from the table
> above, which asks where the *loop* might one day run; the guard answers only "keep
> `taskd` up". Enabling and stopping it is in
> [`install.md`](ops/install.md#the-taskd-guard-keepalive-always-enabled).

#### Where the unit lands (ownership separation)

```text
<prefix>/.meerkat-taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
<prefix>/.meerkat-taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service
```

The install root (`<prefix>/.meerkat-taskpanel/`; `<prefix>` is `install.sh --prefix`,
default `$HOME`), deliberately **not** `<agent-dir>/scheduling/` where the loop's `ping`/`continue` units
live ([Scheduling units](ops/install.md#scheduling-units-claude-codex-pi)). Re-installing a
agent kind's loop units never touches this directory, and the two are never confused for one
another.

There is **one guard per machine** — and therefore **one guarded board** — and **not** one
per agent kind: the `Label` and the unit name carry no agent or actor-kind segment (unlike the loop's
`com.meerkat-taskpanel.ping` / `meerkat-taskpanel-continue`), so installing for several
agent kinds does not multiply the guard. Which board it serves is chosen **at install time**, and
a second board is the unguarded case; see
[One guard per machine](#one-guard-per-machine).

#### One loop supervisor per machine

The loop follows the same machine-level rule: `install.sh --supervisor=enable` acts on the
**first loop kind in normalized `--target` order** (`all` → `claude`; `--target pi,claude` →
`pi`), not on every loop kind in the target. The atomic claim keeps two loops from executing
the same card, but not from doubling the work around it: two polling cadences, two session
pools, two logs and two SLA ledgers over one board. Per-loop alarm de-duplication makes the
cost visible — one `unowned_todo` alerts once per loop — and one loop's `recover_stale` can
take a card another loop is still heartbeating.

Running more than one kind is therefore explicit: `--supervisor-actor-kinds claude,codex`.
On **systemd** the six unit names are machine-wide — the installer copies the same files for
every kind — so enabling a second kind rewrites and restarts the first rather than adding a
supervisor; launchd labels and cron markers do carry the kind. Status reports that difference
instead of counting one systemd set three times.

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
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart={{NODE}} {{SERVER_ENTRY}}
Restart=always
RestartSec=5
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
  [What the loop's units run with](#what-the-loops-units-run-with).
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
launchctl bootstrap gui/$UID <prefix>/.meerkat-taskpanel/scheduling/launchd/com.meerkat-taskpanel.taskd.plist
#   (older systems: launchctl load -w <plist>)
# Linux (user unit)
mkdir -p ~/.config/systemd/user
cp <prefix>/.meerkat-taskpanel/scheduling/systemd/meerkat-taskpanel-taskd.service ~/.config/systemd/user/
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

### The loop's state directory

The loop ships with the toolkit, so there is no copied execution body to install and no
checkout path in a unit. What the installer creates beside the skill is the loop's **state
directory**:

```text
<home>/<agent-dir>/meerkat-taskpanel/
├── supervisor.state.json         runtime (legacy worker registry)
├── supervisor.log                runtime
├── sessions.state.json           runtime (resident pool: pids, session ids, heartbeat)
├── continue.state.json           runtime (the single-flight continue lock)
├── subscribe.state.json          runtime (the event subscriber's last connection)
├── cards.queue.json              runtime (claim → handoff dispatch queue)
└── subagents.state.json          runtime (ledger: subagent id → project, role, card, status)
```

The units name the runtime tree's CLI entry, not this directory:

```text
program: <absolute node> <runtime>/src/cli/index.mjs loop run --ping-once
                                  --actor-kind <kind>
                                  --log <state>/supervisor.log --state-dir <state>
```

`<runtime>` is `MEERKAT_TASKPANEL_REPO`: `~/.meerkat-taskpanel` for a combined install
(`--target all`, npm/npx), or the checkout for an agent-only install. The per-kind config records
it, so moving the tree is a re-install — no `launchctl` / `systemctl` / `crontab` reload,
because the unit never hard-codes a versioned body path.

`--state-dir <dir>` is the documented spelling; the loop derives every file above from it.
`--state <file>` still names the registry file explicitly, and `--log` the log. The installer
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
| control | `Read`, `Bash(taskctl *)`, `Bash(node *)` |
| reviewer | `Read`, `Grep`, `Glob`, `Agent`, `Bash(taskctl *)`, `Bash(git *)`, `Bash(npm run *)`, `Bash(node *)`, `Bash(bash *)` |
| worker | `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Agent`, `Bash(taskctl *)`, `Bash(node *)`, `Bash(git *)` |

`Agent` is the subagent-spawning tool (older CLIs spell it `Task`; both are listed
so one adapter serves either). The reviewer's `npm run` / `node` / `bash` entries
exist because its contract is to re-run the project's declared gate
(`project.meta.review_gate`) itself; a read-only lane with only `taskctl` and
`git` cannot reproduce anything and turns "reproducible evidence" into "read the
report and trust it". It still has no `Edit`/`Write`. The Pi adapter carries the
same split through `--tools`, and its lists also include `subagent` /
`subagents_enable` — the `pi-subagents` extension's tools (inert when the
extension is not installed, but a lane without them could not spawn). Codex,
OpenCode and Cursor have no equivalent option.

An operator who needs unattended runs that edit and execute without prompts can
opt into **full tool access** — `--allow-all-tools`, or, for the installed
service, the per-kind config:

```bash
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS=yes
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON="<who authorized it and why>"
```

The reason is **required**; `--allow-all-tools` without it is a startup error. With
it the Claude adapter runs `--permission-mode bypassPermissions`, and the control,
project and subagent sessions alike have the installing user's full OS
permissions. **The project directory is not an isolation boundary** — cwd is
where the work happens, not a sandbox. Codex uses `approvalPolicy: "never"` with
the full-access sandbox, and Pi adds `--approve`. The flag is printed in `--supervisor=status`, and the
installed units never carry it: the config file is where the authorization is
recorded.

## The three agent kinds: how each one is triggered

Claude Code, Codex and Pi have no clock, and their headless entry points
differ. The supervisor's `--actor-kind` selects the one-shot continue command; the rest
(scan, claim, patrol, registry) is identical.

| Agent kind | Wake command | Trigger / scheduling | Continuity |
|---|---|---|---|
| **Claude Code** | `claude -p "<handoff>"` (headless) | external: launchd / systemd / cron running `taskctl loop run --ping-once` / `--continue-once`, or the scheduler's own two clocks | `claude -p … --resume <sid>` — resume the session that owns the card |
| **Codex** | `codex exec "<handoff>"` | external: the same units, or Codex app automation (`intervalMinutes`, `quotaAware`, `model`, `reasoningEffort`) | resume the thread with `codex exec resume <sid> <prompt>`; carry `$CODEX_THREAD_ID` as `--session-id` |
| **Pi** | `pi --print "<handoff>"` | external units | resume with `pi --print --session <sid> <prompt>`; pass the session id through the handoff |
| **OpenClaw** | *n/a — no self-scheduler* | the agent framework's own `poll`/`patrol` automations — this design is their statement | the framework keeps the id stable across resumes |

The wake command column is what the *agent CLI* is called with for a one-shot
continue turn. A resident pool spawns the provider CLI directly instead, and the
project session spawns the worker subagent in the mapped directory — see
[Where a worker runs](#where-a-worker-runs).

**Resident adapters:** the pool ships one per agent kind, each on that agent kind's native
persistent protocol.

| Agent kind | Resident form | Session identity | Subagent handle |
|---|---|---|---|
| Claude Code | one `claude -p --input-format stream-json --output-format stream-json` process per session | `--resume <session_id>` | Agent tool's `agentId`; reattach with `SendMessage` |
| Codex | one `codex app-server --listen stdio://`; one **thread** per session | `thread/resume` | child thread (`receiverThreadIds`) |
| Pi | one `pi --mode rpc` process per session | `--session-id <id>` | the `pi-subagents` extension's `agentId` |

Claude, Codex and Pi are verified against the real CLIs (Codex's app-server
schema is pinned by `codex app-server generate-json-schema`);
`node scripts/verify/kind-session-matrix.mjs` is the agent-kind-only probe. An agent kind whose
CLI lacks the resident protocol keeps the one-shot
path: patrol + workflow run, dispatch is paused. The seam is agent-kind-agnostic by
design — an adapter implements `openSession({cwd, sessionId, role}) →
{send, interrupt, close}` in `src/orchestrator/actor-kinds/`, and the pool manager never
names a CLI.

Pi has no native subagents. The pool's Pi adapter warns when no `pi-subagents` payload is
found — `~/.pi/agent/npm/node_modules/pi-subagents` for a pi 1.x npm install, or the legacy
`~/.pi/agent/extensions/{subagent,pi-subagents}` pair; `setup-meerkat` reports the same
check and `install.sh --target pi` prints `pi install npm:pi-subagents`. Without the
extension the project session cannot spawn worker/reviewer subagents.

Installers also install the **loop skill** itself, at `<agent-dir>/skills/meerkat-loop/` —
the operator's documentation and the decisions the loop applies. It is always a copy:
`--link` names the board skill only. The execution body is `taskctl loop …`, not a file the
skill carries.

Installers write per-agent kind units under `<agent-dir>/scheduling/{launchd,systemd,cron}`,
then **print the load command** — they never enable a daemon or run `crontab` for you. A
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

The `.session` unit is the **resident pool** — one manager, a control session, one
worker session per target directory, and a reviewer session in the same directory
when a review card is queued. It is the only unit that can dispatch a worker or a
reviewer; without it the continue turn still runs patrol and workflow, and poll
stops at "no resident pool".

The `.subscribe` unit is the **event daemon**. launchd (`KeepAlive`) and systemd
(`Type=simple`, `Restart=always`) follow the local event hub through
`taskctl events follow` and ask for a continue turn when a dispatch-relevant event arrives.
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

### The same control turn in a live session

The loop has **one** control turn. A live `/meerkat-loop` session can host it instead of the
installed clock: the pool starts with `--control=external` (no control session,
`continue.pending` untouched; project sessions still dispatch), the session runs
`patrol → workflow → poll`, and the session's console cycle surfaces `awaiting`/question
cards to the human. The answer is recorded as a `--as-human` board comment — the comment is
the record, the in-session question is only the front-end. `status.mjs --json` reports
`running | busy | starting | configured-idle | partial | absent`; `--take-over` starts the
external-control pool only when the verdict is `absent`, and `--stop` stops only what it
started. The scheduler's clocks and the session's loop are different **drivers** of the same
turn; the units and the session's pool are the same dispatcher.

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
`meerkat-loop` skill, no scheduler, no per-kind config — permanently, by ruling, not as a
gap to be filled later. The framework's own automations are the supervisor on that host;
this page stops at the boundary of what they must preserve — the atomic claim and the
candidate criteria the board hands out.

## Enabling the supervisor (opt-in)

Everything above describes units the installer **writes and never loads**. The enable
capability adds one deliberate act on top: `install.sh --supervisor=enable` (alias
`--enable-supervisor`) performs the per-OS load below. Without it, behaviour is unchanged —
the manual commands in the section above are still the whole story.

That is the single exception to the rule, stated once and pointed at rather than repeated:
**an installer never loads a unit or runs `crontab` for you — unless you ask.** Asking is
always explicit (the flag, `MEERKAT_TASKPANEL_SUPERVISOR=enable`, or answering **yes** to
the one-time TTY question — also asked by the no-options wizard, default **none** — whose
default is **N**): enabling is never a silent default, and
a plain `install.sh` still only prints the load command. The flag surface, the TTY question
and the env var are documented once in
[`install.md §Enabling the supervisor (opt-in)`](ops/install.md#enabling-the-supervisor-opt-in);
this section is the per-OS detail, the failure modes, and what an enabled daemon runs.

The switch is `--supervisor=enable|disable|status` with
`--supervisor-actor-kinds claude,codex,pi` (which agent kinds) and
`--scheduler auto|launchd|systemd|cron` (which mechanism; default `auto`). The defaults are
the [one-supervisor-per-machine](#one-loop-supervisor-per-machine) rule:
**`enable` acts on the first loop kind in `--target` order** (`--target all` → `claude`),
while **`disable` and `status` act on every loop kind in `--target`** so no stray is left
unseen or running. On `--target all`, `--supervisor=enable` therefore does **not** enable
`codex`/`pi`, and never OpenClaw (see
[OpenClaw stays excluded](#openclaw-stays-excluded)).

Per-OS commands below are written for the Claude install (`~/.claude`); for Codex and Pi
substitute `~/.codex` / `~/.agents` for the agent kind directory and `codex` / `pi` for
`--actor-kind`. `<agent>` names the unit label and state directory from the install's
`--agent-name` (default `Worker`), and `<uid>` is `id -u`. The units carry no `--agent`:
the loop's scan set is the per-kind config's `MEERKAT_TASKPANEL_AGENTS`, which `install.sh`
seeds with that name and `/setup-meerkat` replaces with the team's roles.

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
| **the loop's** `Bootstrap failed: 37: … already bootstrapped` (legacy: `service already loaded`) | already loaded, same definition | **idempotent success** — the **supervisor** reports `supervisor: already enabled (…)`, exit 0. The `taskd` guard is bootstrapped the same way but reports its own, board-aware line instead — `already enabled` is *not* its wording ([`install.md § The taskd guard`](ops/install.md#the-taskd-guard-keepalive-always-enabled)) |
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
* * * * * /home/you/.nvm/versions/node/v24.20.0/bin/node /path/to/runtime/src/cli/index.mjs loop run --ping-once --actor-kind claude --log ~/.claude/meerkat-taskpanel/supervisor.log --state-dir ~/.claude/meerkat-taskpanel >/dev/null 2>&1
*/10 * * * * /home/you/.nvm/versions/node/v24.20.0/bin/node /path/to/runtime/src/cli/index.mjs loop run --continue-once --actor-kind claude --log ~/.claude/meerkat-taskpanel/supervisor.log --state-dir ~/.claude/meerkat-taskpanel >/dev/null 2>&1
# <<< meerkat-taskpanel (~/.claude) <<<
```

The interpreter is absolute and the block opens with a `PATH=` setting line for the reasons
in [What the loop's units run with](#what-the-loops-units-run-with) — a cron job inherits
cron's own minimal `PATH`, not yours.

(The manual path above — `crontab <file>` — drops the same lines in *without* a marker
block; the enable path is the one that wraps them. The `(~/.claude)` in the marker is the
agent kind directory, so the three loop agent kinds get three independent blocks.)

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

- **Identity and parameters.** The units start the scheduler with `--actor-kind <h>` and one
  pass (`taskctl loop run --ping-once` / `--continue-once`); they deliberately carry no
  `--agent`, so the scan set is the per-kind config's `MEERKAT_TASKPANEL_AGENTS` (seeded by
  `install.sh` with the install's agent name, replaced by `/setup-meerkat` with the team's
  roles). A flag here would outrank that key and leave a team's role cards unclaimed. The continue turn starts the
  agent kind's headless entry point directly with the bounded `Continue` prompt — no
  project directory. Poll claims a card and enqueues it; a resident project session
  spawns the worker as a subagent of the provider CLI, which runs non-interactively
  (`claude -p "<handoff>" [--resume <sid>]` / `codex exec "<handoff>"` /
  `pi --print "<handoff>"` are the one-shot shapes).
- **Logs.** `<agent-dir>/meerkat-taskpanel/supervisor.log` (the supervisor's `--log`),
  written and rotated by the loop itself. The units do **not** redirect their
  stdout/stderr into it — that would duplicate every line; cron sends the same output to
  `/dev/null` because `--log` already writes it.
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

### One mechanism per agent kind, and the cost gate

- **One scheduler per agent kind.** `--scheduler` picks exactly one. To move an agent kind from, say,
  cron to launchd, disable the first: the enable path may do disable-then-enable, but it
  never leaves two loaded. Two loaded units for one agent kind only race each other for the same
  cards.
- **The cost model.** Enabling installs two clocks. The **ping** clock is $0: one
  small registry read, no board, no LLM. The **continue** clock is one bounded LLM
  turn per cadence (default every 10 minutes) whether or not the board has work;
  inside that turn the poll entry is still the deterministic cost gate — a worker
  turn starts only when a claim succeeded, and patrol stays LLM-free by default
  (`--patrol-llm=no`). See
  [The cost gate: a worker turn starts only on fire](#the-cost-gate-a-worker-turn-starts-only-on-fire).
- **Disable and status** are part of the same entry point: `--supervisor=disable` unloads /
  removes, `--supervisor=status` prints the per-agent kind load state and changes nothing
  (per-OS forms above). Status also names that kind's **platform** and its configured
  **scan set** (`MEERKAT_TASKPANEL_AGENTS`), and closes with a machine line — a machine that
  still runs a second kind's loop is visible there, with the command that stops it.

### OpenClaw stays excluded

The new switch does not change the [OpenClaw
ruling](#openclaw-no-loop-units). `--target openclaw` still installs the
**board skill only** — no `meerkat-loop` skill, no units, no glue, so nothing to enable.
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
taskctl loop run --actor-kind claude --agent alice --continue-once  # one continue turn
```

The flags are the same either way; a loaded unit names the runtime tree's CLI entry and
`MEERKAT_TASKPANEL_REPO` in the per-kind config is what tells it where that tree is.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--actor-kind claude\|codex\|pi` | `claude` | which worker to wake |
| `--repo <path>` | this checkout — or, for a agent-installed copy, the `MEERKAT_TASKPANEL_REPO` in the per-kind config | repository root: what `--cli` is resolved from, and the fallback working directory |
| `--ping-interval <sec>` | `60` | liveness clock: prune dead worker pids; no board read |
| `--continue-interval <sec>` | `600` | judgment clock: wake the agent kind for one `Continue` turn |
| `--max-concurrency <n>` | `8` | cap on simultaneously running subagents; workers and reviewers share it and the split follows demand (no per-role reservation) |
| `--workspace=worktree\|shared` | `worktree` | a git project's cards each run in `.worktrees/<ref>[-r<round>]` on `lane/<ref>[-r<round>]`; a creation failure defers the card (no fallback). `shared` restores the old shared-checkout behaviour |
| `--claim-unassigned=yes\|no` | from per-kind config → `yes` | also claim unassigned cards (the public pool) |
| `--assignee-only` | — | alias for `--claim-unassigned=no` |
| `--recover-stale=yes\|no` | from per-kind config → `yes` | add stale `in_progress` cards to the candidate read (`--stale`); the claim itself is `issue claim` (holder after 10 min, anyone after 6 h) |
| `--workflow=yes\|no` | from per-kind config → `yes` | run the workflow sub-pass (reconcile → outcomes → dispatch) |
| `--reviewer <agent>` | from `$MEERKAT_TASKPANEL_REVIEWER` / the per-kind config, else `null` | the independent reviewer; the installer writes `Reviewer`, and an empty value disables dispatch only |
| `--workflow-max-actions <n>` | `20` | max workflow writes (and bounded reads) per pass |
| `--review-aging-minutes <n>` | `60` | report a review card that has had no readable verdict this long |
| `--continue=yes\|no` | from per-kind config → `yes` | enable the continue turn |
| `--continue-state <path>` | `continue.state.json` beside `--state` | the single-flight lock for the continue turn |
| `--ping-once` / `--continue-once` | off | on `loop run`: run only that clock's pass, then exit |
| `--patrol-interval <sec>` | `300` | the SLA **measurement** period (it no longer schedules anything) |
| `--patrol-llm=yes\|no` | `no` | let patrol start an LLM turn on a stale card |
| `--notify <cmd>` | — | run `<cmd>` with each patrol alert as JSON on stdin — both the legacy heartbeat alert and the SLA tuple |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--log <path>` | `<home>/<agent-dir>/meerkat-taskpanel/supervisor.log` | where the tick log appends |
| `--state <path>` | `<home>/<agent-dir>/meerkat-taskpanel/supervisor.state.json` | the running registry |
| `--sla-ledger <path>` | `sla-ledger.json` beside `--state` | the SLA de-duplication ledger; an unreadable one suppresses nothing |
| `--workflow-ledger <path>` | `workflow-ledger.json` beside `--state` | the workflow alert de-duplication ledger; an unreadable one suppresses nothing |
| `--sla-leader <id>` | from `$MEERKAT_TASKPANEL_SLA_LEADER`, else unset | the author id the leader writes under, for the `leader_stalled` attribution set; unset ⇒ the board's own decision authority (`author_kind = "human"`). Set the **same** identity on both mechanisms |
| `--sla-last-ok <path>` | `loop-patrol-last-ok.json` beside `--state` | where this mechanism publishes its own last-successful-run marker for the peer's watchdog |
| `--sla-peer <path>` | from `$MEERKAT_TASKPANEL_SLA_PEER`, else unset | the peer inspector's last-ok marker; a marker older than `3 × P_peer` raises `inspector_liveness`, where `P_peer` is the cadence the marker declares (fallback 15min). Unset ⇒ the peer's half is a registered dependency and nothing alarms |
| `--board-limit <n>` | `500` | max cards read in one patrol pass |
| `--trail-limit <n>` | `200` | max comment trails read in one pass (a cap is always logged) |
| `--config <path>` | `<program root>/.env.<actor-kind>` (or `MEERKAT_TASKPANEL_CONFIG_DIR`) | per-kind config: the loop's claim default and concurrency cap, `MEERKAT_TASKPANEL_REPO`, and — on the board path — the per-agent identity |
| `--env-file <path>` | `$MEERKAT_TASKPANEL_ENV_FILE`, else `<repo>/.env` | the shared config file the subscriber's `taskctl` calls read (`TASKD_URL`, `TASKD_TOKEN`, …) |
| `--home <path>` | `$HOME` | base for the agent directories (state, log, skills) |

The project map is not a flag: the poll pass and `taskctl project dir` read the same
`<config root>/projects.json` ([Where a worker runs](#where-a-worker-runs)).

**Fixed paths.** Logs and state always land at the paths in the table — a user
who wants to know why a card did not start reads
`~/.claude/meerkat-taskpanel/supervisor.log` (or `.codex/`, `.agents/`).

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
`issue claim`; with it off, the loop never takes over an `in_progress` card and the SLA
alert is the only signal. The two policies are independent: an assignee-only supervisor can
still recover its own stale claims, and a public-pool supervisor can refuse takeovers.

The same three-source precedence governs the workflow channel's answers, persisted beside
it:

```ini
MEERKAT_TASKPANEL_WORKFLOW=yes
MEERKAT_TASKPANEL_REVIEWER=Reviewer
```

An empty `MEERKAT_TASKPANEL_REVIEWER` is a complete answer — "no independent reviewer" —
not a missing one: the board still gets the container rules and the verdicts already in
flight, and a delivery waits for a human to accept it. It is the manual opt-out: the
installer's default is `Reviewer`, and the wizard does not ask. Re-running the installer
adds keys an older config lacks and never overwrites one it already has.

## The end-to-end path

```
launchd / systemd / cron  ──ping 60s──▶  taskctl loop run --ping-once
                                            prune registry entries whose pid is gone
                                            no board, no claim, no LLM

launchd / systemd / cron  ──continue 600s──▶  taskctl loop run --continue-once
                                            claude -p "Continue …"   ← the judgment turn (no card, no project)
                                                ├─ passes.mjs patrol    notify-only SLA
                                                ├─ passes.mjs workflow  apply board workflow plan (taskd)
                                                └─ passes.mjs poll
                                                      issue candidates --assignee alice --include-unassigned
                                                          (empty → stop; 0 workers)
                                                      issue claim <ref>        ← atomic claim, the only dispatch
                                                          refused → stop
                                                      claude -p "<handoff>"    ← the worker turn
                                                          record {ref, pid} in the registry
                                                          … reads, works, reports, delivers …
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
covered: Claude has a SessionStart hook; Codex and Pi have no hook, and their scheduling
units are the automation. (The `taskctl` shim is not one of these forms and is not part of
this boundary: every agent kind gets one — see `docs/ops/install.md`.)

## See also

- [`install.md`](ops/install.md) — the installer flags, including `--claim-unassigned` and the
  opt-in `--supervisor=enable|disable|status`.
- [`../skills/meerkat-loop/SKILL.md`](../skills/meerkat-loop/SKILL.md) — the loop as the
  skill it is distributed as, and the board interface generation it requires;
  [`references/operation.md`](../skills/meerkat-loop/references/operation.md) is the
  operator's view.
- [`../skills/meerkat/SKILL.md`](../skills/meerkat/SKILL.md) —
  the agent-facing view: §Owning the clock.
- [`../skills/meerkat/references/cli.md`](../skills/meerkat/references/cli.md) —
  `issue candidates --include-unassigned`.
