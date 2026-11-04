# 0015 — Stale-claim recovery keeps the assignee; Worker is the explicit fallback

## Status

Accepted — 2026-11-05.

## Context

A claim has two halves: the **route** (`assignee`, who the card belongs to) and the
**execution lock** (`claimed_by` / heartbeat, who is doing it now). ADR 0007 makes the route
select the executing role. The six-hour stale-recovery path did not: past the bound the board
handed the card to *any* actor as an audited takeover, and the supervisor claimed as whichever
agent scanned the recovery pool first. TP-0077 delivered a Linus card as `/jobs` because Jobs
was the first name in the scan order — a cross-role execution no rule authorized.

## Decision

- **Six hours is a liveness bound, not an assignment grant.** A rotted claim's route still
  decides who may execute.
- **The assignee recovers its own card** past six hours (or with no usable heartbeat) as an
  audited takeover (`steal: true`, no extra reason: the staleness is the reason).
- **Any other actor needs `--allow-steal --reason`** — the same audited escape hatch a first
  claim uses. The refusal keeps the existing `not_assignee` code; the repair hint names
  `issue claim`, because a same-status `move` is not a transition. The takeover records an
  override and a `change` comment naming the assignee and the reason.
- **The board stays role-blind** (ADR 0013): it compares the actor to the assignee and nothing
  more. Role resolution and availability remain the supervisor's.
- **The candidate read carries the route** (`assignee`, `assignee_id`, `assignee_kind`), and
  the supervisor claims and dispatches as the card's assignee role — whichever scanner offered
  the card first.
- **Worker is the fallback only when that role cannot run**: the assignee role is not
  installed, or no available kind carries it. The fallback is a **formal re-assignment** —
  version-guarded, with a `change` comment naming the old assignee and why — performed by the
  orchestrator's identity before the claim. It applies only to a rotted (`stale_any`) **work**
  card. Review cards are never re-routed to Worker, and a `human`-assigned card is never
  claimed or re-assigned by the loop at all.

## Why

The route is the durable, human-readable decision about who owns the work; the scan order is an
accident of discovery. Selecting the executor from the scanner made a liveness event silently
change the accountable role. Worker as a named, commented, version-guarded fallback keeps the
loop's recovery honest without teaching the board the role catalog.

## Considered options

- **Teach the board the role catalog.** Rejected: it contradicts ADR 0013 and makes the board a
  second source of role truth.
- **Fix only the supervisor.** Rejected: a direct CLI or HTTP caller could still take a card
  across its route, so the rule would be a convention, not a gate.
- **Re-assign automatically after 30 minutes.** Rejected: the board still allows only the
  holder inside the six-hour window; the change would need a second ownership rule.
- **Add a new error code for "someone else's stale card".** Rejected: `not_assignee` already
  means exactly that, and the message can say why the takeover is refused.

## Consequences

- A non-assignee stale takeover now needs two flags (`--allow-steal --reason`); scripts that
  relied on the old open takeover are refused until they state the override.
- A card whose role is unavailable waits for the six-hour bound before the Worker fallback;
  before that, `stale_same` / `ready` deliberately do not fall back.
- The fallback adds one write before the claim and a narrow reassign→claim race; the
  version guard (`--if-version`) turns a concurrent edit into a deferral, not a lost update.
- A review card whose reviewer role is unavailable may stay stuck instead of running on the
  wrong lane. That is the intended trade.
- ADR 0007 is unchanged; its rule is now enforced on the recovery path too.

**2026-11-05 —** The rule binds **both supervisor lanes**. The patrol's LLM turn reads
`issue list`, whose `assignee` is an actor-ref object, and used to claim and dispatch as the
holder (`claimed_by_actor`) — the same cross-role execution this decision removes. It now
derives the claim identity with the same `planClaimIdentity` (through `planPatrolClaim`) and
performs the Worker fallback's formal, version-guarded re-assignment before claiming. A patrol
alert inside the six-hour window whose route moved off the holder defers, exactly as the poll's
rule 5a.

**2026-11-05 —** Inside the six-hour window the board still lets only the **holder** re-claim
(`stale_same`). A route that changed after the claim — an audited override, or an `issue
assign` of an `in_progress` card — therefore cannot be recovered by the loop as the assignee:
claiming as the new assignee is refused with `EXECUTION_ACTIVE` on every tick. The supervisor
defers that candidate (`planClaimIdentity`, rule 5a) instead of planning a claim the board
refuses, and the six-hour bound then hands the card to its route. The same holder-only window
binds an **unassigned** `stale_same` card (rule 2a): the public pool would claim it as
`defaultAgent`, which the board refuses unless that agent is the holder, so the planner defers
there too rather than letting the scan order select the executor.
