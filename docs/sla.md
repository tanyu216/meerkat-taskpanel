# SLA design: the wait-time inspector

This is the design of the SLA mechanism — the part of the product that answers one
question about a board: **which wait has gone on too long, and who owes it?** It records
the problem the mechanism exists for, the model it rests on, the detectors that implement
it, the delivery rules that keep it quiet and honest, and the decisions behind each of
those, with their costs.

It is also normative. Where a section states a number, a field name or a rule, the code
transcribes it: `src/foundation/sla-config.mjs` owns the table and its parser,
`src/foundation/sla-patrol.mjs` owns the detectors and the delivery decisions,
`src/core/commands/sla.mjs` is the board's read, and `test/orchestrator/sla-patrol.test.mjs`
fails if this document and the table drift apart. Section references in the code
(`docs/sla.md §…`) resolve here.

The design in one sentence: **the board computes, from facts it already holds, which waits
have exceeded their limit; the loop de-duplicates those rows, re-reads each survivor once,
and notifies the leader — and nothing on either side moves a card.**

Reading order: §1 says why the mechanism exists and what shape it takes; §2–§5 define the
model (rows, clock, tuple, tiers); §6–§7 are the detectors and their hints; §8–§9 are the
delivery rules for one pass; §10–§11 are peer interoperability and the confirmation-gate
comment kind; §12–§15 are the boundaries, the decisions and their costs, how to run it, and
what the detectors depend on.

## 1. Purpose

### 1.1 The failure this exists for

A multi-agent board fails quietly. Nothing throws when the leader never answers a blocked
card, when nobody queues the acceptance review, when a defect is reported and no fix card
is ever created, when a worker stops heartbeating while holding a card, or when the
inspector that would have noticed has itself stopped running. Each of those is a *state*
the board records faithfully — an accurate status, an accurate timestamp — and nobody acts
on it. There is no error, no failed request and no red test. A board can be entirely green
and completely stalled.

The design question is therefore narrow: **can elapsed time in a state be turned into a
deterministic, shared, notify-only signal that costs nothing when the board is healthy, and
that cannot go quietly green when it cannot see?**

The six silences, and the row that watches each:

| The silence | The row |
|---|---|
| a card parked on the leader's clarification, decision or hand-back | `blocked_clarification` |
| a confirmation request the leader never answered | `confirmation_gate` |
| a defect with no fix card | `defect_card_creation` |
| a delivery with no acceptance review card | `acceptance_card_creation` |
| a worker that stopped heartbeating on a claimed card | `heartbeat_stale` |
| the leader's own patrol, or the peer inspector, going quiet | `leader_stalled`, `inspector_liveness` |

### 1.2 Goals and the invariants that follow

Four properties are load-bearing. The first three have a test; the fourth is enforced by
construction — the loop has no second detector to disagree with.

- **Notify-only.** Every alert carries `target: "leader"`. No code path here moves a card,
  releases a claim, accepts a delivery or starts an agent turn for a new row. The
  releasability hint says a card *looks* releasable; releasing it remains the leader's act.
  A board whose inspector can write is a board with two writers.
- **Zero-cost idle.** A wait still inside its lead produces no candidate at all — not a
  suppressed one, not a logged one. A healthy board costs no notification, no model turn
  and no operator attention, which is what makes it safe to run every few minutes.
- **Fail-safe, never false-green.** An unreadable origin alerts rather than staying quiet;
  an undecidable open/closed predicate counts as **open**; a re-check that cannot run lets
  the alert through; a failed board read fails the pass. The mechanism's failure direction
  is always "say something", never "assume fine".
- **One decision rule.** The board computes every card row. The loop does not re-derive
  one; it re-reads through the same endpoint and adds only the row it can uniquely see (the
  peer marker file on its own host). Two mechanisms therefore cannot label one card
  differently.

### 1.3 Architecture: the board computes, the loop notifies

```text
  board: cards + trails + effective TASKD_SLA_* table
        │
        ▼
  planSlaPatrol (pure) ── GET /api/v1/sla (taskctl sla list|get) ──►  alerts[]
                                                                          │
  loop patrol pass:  + inspector_liveness (host-local marker)  ◄──────────┘
                     → drop keys already notified (ledger)
                     → re-read each surviving card row (sla get <ref> — the same detector)
                     → notify (--notify hook) → record → publish last-ok
```

The split follows what each side can see. The **board** owns the read: the card snapshot,
the comment trails, the effective configuration, and the one decision over them. The
**loop** owns the ledger, the pre-emit re-read, the notification, and the last-successful-run
marker — all local files or local commands. `inspector_liveness` stays with the loop for the
same reason: it watches a marker file on the loop's host that the board cannot see.

Two consequences are deliberate. The board's HTTP surface is the only transport, so the
loop speaks `taskctl` and never the board's internals; and the same response is available to
any second mechanism, so interoperability is a published fact rather than a private
arrangement.

### 1.4 Mechanisms

- **`loop-patrol`** (`MECHANISM`) is this repository's inspector, run by the loop.
- A deployment may run a second inspector. Its marker is read through `--sla-peer` as an
  optional interoperability channel; `openclaw-cron` (`PEER_MECHANISM`) is the peer name this
  repository uses. Nothing in this design depends on that peer running.

## 2. The model and the threshold table

The model has five words.

| Term | Meaning |
|---|---|
| **row** | One kind of wait, named after the work that is owed (e.g. `defect_card_creation`). A row is a trigger, an origin, an open predicate and a pair of limits. |
| **trigger** | The board state that makes the row applicable at all (e.g. `status == blocked`). No trigger, no candidate. |
| **origin** | The instant the wait started, read from the most exact source available. Everything else is measured from it. |
| **open predicate** | The condition under which the wait is still open. Deciding it is what makes an alert meaningful, and an undecidable predicate is treated as open. |
| **T** | Elapsed **working** minutes from the origin to the observation instant (§3). |

The limits are `L` (the normal limit), `F` (the further timeout) and `P` (this mechanism's
own measurement period). All are **working minutes** except `P`, which is wall-clock seconds
because it times an inspector, not a person.

Mechanism parameters:

| Parameter | Default | `.env` key | Meaning |
|---|---:|---|---|
| `PEER_PERIOD_MIN` | 15 | `TASKD_SLA_PEER_PERIOD_MIN` | fallback cadence for a peer inspector that does not declare one |
| `PEER_LIVENESS_K` | 3 | `TASKD_SLA_PEER_LIVENESS_K` | missed peer periods before `inspector_liveness` fires |
| `LEADER_LOOKBACK_DAYS` | 7 | `TASKD_SLA_LEADER_LOOKBACK_DAYS` | how far back a leader event can be called "recent" |
| `P` | 300 s | `TASKD_SLA_PERIOD_SECONDS` | the measurement period; it schedules nothing |

The threshold table — the published defaults:

| Row | L | F | Warn lead | Origin | Covered by |
|---|---:|---:|---:|---|---|
| `blocked_clarification` | 120 | 1440 | `L − P` | `blocked_at` | `sla-patrol` |
| `confirmation_gate` | 240 | 1440 | `L − P` | `gate_at` | `sla-patrol` |
| `defect_card_creation` | 1440 | 2880 | `L − P` | `trail_event` | `sla-patrol` |
| `acceptance_card_creation` | 1440 | 2880 | `L − P` | `status_changed_at` | `sla-patrol` |
| `heartbeat_stale` | 30 | 360 | `L − P` | `heartbeat_at` | `sla-patrol+legacy-stale-alert` |
| `leader_stalled` | 60 | 360 | `L` (no lead) | `trail_event` | `sla-patrol` |
| `inspector_liveness` | — | — | `k × P_peer` | peer marker | `sla-patrol` |

The table is a **transcription**. `DEFAULT_SLA_ROWS` in `src/foundation/sla-config.mjs`
(re-exported as `SLA_ROWS` by `src/foundation/sla-patrol.mjs`) carries the same numbers next
to a reference string, and `test/orchestrator/sla-patrol.test.mjs` pins both sides. Changing
a **default** is a contract change: update this table, the constant and the test together.
Changing an install's **effective** value is configuration, below.

The warn lead is derived, never invented: `warn = L − P`, so the notice arrives one period
before the limit. `leader_stalled` is exempt — its published bound is already a
"no action for" bound — and `inspector_liveness` has no limit at all.

### 2.1 Install-level overrides

The published numbers are the **defaults**. A deployment may override the six limited rows'
`L` and `F` plus the four mechanism parameters in the install-root `.env`:

```text
TASKD_SLA_PERIOD_SECONDS=300
TASKD_SLA_LEADER_LOOKBACK_DAYS=7
TASKD_SLA_PEER_PERIOD_MIN=15
TASKD_SLA_PEER_LIVENESS_K=3
TASKD_SLA_BLOCKED_CLARIFICATION_LIMIT_MIN=120
TASKD_SLA_BLOCKED_CLARIFICATION_FURTHER_MIN=1440
TASKD_SLA_CONFIRMATION_GATE_LIMIT_MIN=240
TASKD_SLA_CONFIRMATION_GATE_FURTHER_MIN=1440
TASKD_SLA_DEFECT_CARD_CREATION_LIMIT_MIN=1440
TASKD_SLA_DEFECT_CARD_CREATION_FURTHER_MIN=2880
TASKD_SLA_ACCEPTANCE_CARD_CREATION_LIMIT_MIN=1440
TASKD_SLA_ACCEPTANCE_CARD_CREATION_FURTHER_MIN=2880
TASKD_SLA_HEARTBEAT_STALE_LIMIT_MIN=30
TASKD_SLA_HEARTBEAT_STALE_FURTHER_MIN=360
TASKD_SLA_LEADER_STALLED_LIMIT_MIN=60
TASKD_SLA_LEADER_STALLED_FURTHER_MIN=360
```

- **Precedence per key**: process environment → install-root `.env` → default. A *blank*
  process value does not shadow the file (it is treated as unset); a **blank file value is
  refused**, because that is an operator writing a key and then deleting its value.
- **Validation**: every value is a non-negative integer with a per-key range, and the
  effective `F ≥ L` — a further bound below its normal limit would escalate before it is
  overdue. One side may be overridden alone; the check is against the effective pair.
- **Failure direction differs by reader**: an invalid value in the file stops `taskd` with
  `CONFIG_FILE_INVALID`; an invalid value in the process environment makes the SLA read fail
  closed while `/meta` reports it as a degraded `capabilities.sla` block without failing the
  whole meta read.
- **Delivery**: the board re-reads the file per call, so a hand edit applies to the next
  `GET /api/v1/sla` without a restart. The loop reads the effective table on every pass.
- **`P` per call**: the loop's `--patrol-interval` is the mechanism's own measurement period
  and overrides the deployment's period for that pass, so two inspectors with different
  cadences still share one `L`/`F` table while each computes its own `warn = L − P`. A
  period ≥ `L` clamps the lead to 0 (every pass reports that row).
- **`heartbeat_stale` is alerting only.** Its defaults mirror `CLAIM_STALE_SAME_MS` /
  `CLAIM_STALE_ANY_MS`, but an override changes when the **alert** fires, not when a claim
  becomes re-claimable. Recovery is the claim's own rule and is independent by design.

## 3. The clock: working hours

`T` accumulates only inside a fixed civil window: **09:00–23:00 Asia/Shanghai**, every
calendar day. The window rolls over, never resets: a wait that spans the off-hours stretch
is measured honestly on both sides of it. Asia/Shanghai is UTC+8 all year (no DST), so the
conversion is exact integer arithmetic, needs no timezone database, and a host in another
timezone measures the same `T`.

The choice is the point of the mechanism. A card blocked at 22:50 must not be "overdue"
at 09:15 for the sole reason that its owner slept; and a deployment whose inspector runs on
a server in another region must not measure a different wait from its peer.

There is **no weekend or holiday calendar**. Saturday and Sunday count exactly like a
weekday. A deployment that wants a different calendar must change this contract, the
`WORKING_WINDOW` constant and the tests together.

`elapsedWorkingMinutes` returns `null` for an unreadable instant; callers must treat that as
unverifiable, never as fresh. The inverse projection (`addWorkingMinutes`) exists only for
the display-only `due_at` field; no verdict reads it.

## 4. The alert tuple

Every alert is the same flat object (26 fields). The field set is the interface shared by
both mechanisms and by the notify hook; a peer that implements only this tuple is
compatible.

| # | Field | What it carries |
|---:|---|---|
| 1 | `alert_id` | `<card>#<row>#<severity>` |
| 2 | `dedup_key` | `<alert_id>@<measure_start_at>` (§8) |
| 3 | `card_id` | the card the wait belongs to, or the `board` sentinel for a board-level row |
| 4 | `sla_row` | the row name |
| 5 | `sla_ref` | this document's reference for the row's numbers |
| 6 | `severity` | `warn` / `overdue` / `escalate` |
| 7 | `measure_start_kind` | how the origin was found (`blocked_at`, `status_changed_at`, `gate_at`, `trail_event`, `heartbeat_at`, `unverifiable`) |
| 8 | `measure_start_at` | the origin instant, ISO-8601 UTC |
| 9 | `measure_start_source` | `frontmatter` / `comments` / `mechanism-marker` / `missing` |
| 10 | `elapsed_working_min` | `T`, to three decimals |
| 11 | `elapsed_basis` | always `working_hours` |
| 12 | `threshold_min` | the limit the severity was decided against, or `null` |
| 13 | `due_at` | the projected instant when `threshold_min` is reached — **display only** |
| 14 | `action` | what the leader should do, plus any releasability hint |
| 15 | `target` | always `leader` |
| 16 | `notify` | `immediate` at `escalate`, otherwise `digest` |
| 17 | `releasable` | a hint, never an action (§7) |
| 18 | `releasable_basis` | which hint, or `null` |
| 19 | `blocked_reason` | the card's reason when it is blocked |
| 20 | `confidence` | `high` / `low` (§6) |
| 21 | `mechanism` | the inspector that emitted it |
| 22 | `mechanism_actor` | the inspector's actor id |
| 23 | `first_seen` | when the ledger first recorded the key |
| 24 | `last_seen` | the latest pass that observed it |
| 25 | `observed_by` | every mechanism that has observed the key |
| 26 | `evidence` | the facts behind the verdict |

`evidence` carries the card's `status`, `status_changed_at`, `has_sessions`,
`has_workspace`, `threshold_ref` and `open_predicate`. `has_workspace` is always `null` —
the board holds no project directory, and a boolean would be a claim it cannot make. The
liveness row has no card and puts the peer's own facts there instead (`peer`, `peer_last_ok`,
`peer_age_min`, `peer_bound_min`, `peer_state`).

Two provenance rules matter. The board builds the tuple stamped `mechanism: "taskd"` (a
**mechanism label**, not an actor kind — it stays `taskd` so a rename never re-keys the
alert ledger),
`mechanism_actor: null`; the **notifier** restamps `mechanism` / `mechanism_actor` before
sending, so the peer sees who delivered it, not who computed it. And fields 23–25 are
**ledger provenance**: a freshly computed plan sets `first_seen` to the origin and
`last_seen` to `null`, and the runner fills all three from the recorded ledger entry at the
moment of delivery, so there is exactly one source for "when was this first reported".

The verdict is always `elapsed_working_min ≥ threshold_min`. `due_at` is a projection for a
human reading the tuple; no code decides green from it.

## 5. Tiers and leader-owed work

### 5.1 Leader-owed work

`leader_stalled` only evaluates when at least one of the four **leader-owed** rows is open:
`blocked_clarification`, `confirmation_gate`, `defect_card_creation`,
`acceptance_card_creation`.

A stale heartbeat and a silent peer inspector are deliberately not leader-owed. They are
facts about the board, not work parked on a person; admitting either would make a quiet
night read as a stalled leader and break zero-cost idle every evening.

### 5.2 The tier ladder

One definition, shared by both mechanisms:

1. `warn` ⇔ `T ≥ max(0, L − P)` — "due soon", **no breach**;
2. `overdue` ⇔ `T ≥ L`;
3. `escalate` ⇔ `T ≥ F`, where the row has a further bound;
4. a row with **no threshold** (visibility-only, or an unreadable origin) can only ever be
   `warn`;
5. `leader_stalled` is exempt from the `−P` lead: it reaches `warn` at `L`, `escalate` at
   `F`, and never reports `overdue`.

The highest crossed tier wins. An alert at `escalate` carries `notify: "immediate"`; every
other tier carries `digest`.

### 5.3 Inspector liveness

Each mechanism publishes a last-successful-run marker after a completed pass and watches
the peer's:

```text
peer_stale  ⇔  now − peer.last_ok > k × P_peer
```

The bound is **derived** from parameters, never invented, so the row has no
`threshold_min` and can only reach `warn`. The comparison is **wall-clock** minutes: this
row watches a process cadence, not a person's work, so the working-hours window does not
apply to it. The tuple's `elapsed_working_min` is still the shared basis's number (for
consistency of the field), while `evidence.peer_age_min` carries the wall-clock age the
verdict used.

Two cases the caller decides, because only the caller can see the filesystem:

- **no marker at all** — if no peer is configured, the peer's half is a registered
  dependency and nothing alarms. If a peer *is* configured (`peerRequired`), a missing marker
  fires: the deployment says both mechanisms are installed, so silence is a fault.
- **a stale marker** — always an alert. A peer that once ran and stopped is exactly what the
  watchdog is for, and a silent inspector reads exactly like a healthy board.

An unreadable observer clock fires too: an injected fault must not produce a clean envelope.

## 6. The row detectors

Each row is a pure function of a card (or the board) plus the trail the pass was given. The
shape of every row:

| Row | Trigger | Origin | The wait is open while | Confidence |
|---|---|---|---|---|
| `blocked_clarification` | `status == blocked` | `blocked_at`, else `status_changed_at` | no leader answer after the block | `high` from `blocked_at`; `low` from the fallback |
| `confirmation_gate` | a confirmation request on the card | `meta.gate_at`, a `confirm_request` comment, the legacy marker, the prose shape | no later leader-authored `confirm` | `high` except the prose shape |
| `defect_card_creation` | a `kind=defect` trail entry | the earlier of that entry and the card's entry into `blocked`/`canceled` | no bug-labelled card references this one | `high`; `low` when the board read was capped |
| `acceptance_card_creation` | `status == in_review` on a non-review card | `status_changed_at` | no open review card for this delivery round | `high`; `low` when capped or unreadable |
| `heartbeat_stale` | `status == in_progress` and `kind != epic` | `heartbeat_at` | the card is still `in_progress` | `high`; `low` when unreadable |
| `leader_stalled` | at least one leader-owed row is open | the latest leader-attributed event | the leader acts | `high` inside the lookback; `low` outside it |
| `inspector_liveness` | peer age > `k × P_peer` | the peer's `last_ok` | the peer completes a pass | `high` |

**Confidence is pinned.** `high` iff the chosen origin was read verbatim from one
unambiguous source; `low` iff it came from a fallback, a shape match, or a predicate that
could not be decided. Picking the latest among several exact candidates stays `high`; a
pre-lookback catch-up thread is the only `low` case for `leader_stalled`.

### 6.1 `blocked_clarification`

Trigger: `status == blocked`. Origin: `blocked_at` (`high`), else `status_changed_at`
(`low`), else unverifiable (alert at `warn`, no threshold).

The row name is historical: it fires for **every** blocked card, and the reason decides
whether a limit applies at all.

| `blocked_reason` | A limit applies | Releasability hint (§7) |
|---|---|---|
| absent (treated as `clarify`) | yes | `clarification_trail_after_block` |
| `clarify`, `decision` | yes | `clarification_trail_after_block` |
| `dependency` | **no** — visibility only | `deps_satisfied` |
| `external`, `resource` | **no** — visibility only | none |
| `out_of_bounds` | yes | `assignee_changed` |
| `defect`, `unknown` | yes | none |

`dependency` / `external` / `resource` have no contract row: they get **visibility without a
due point** rather than an invented limit, and the alert's action says so. An absent reason
behaves exactly as `clarify` — absence preserves today's semantics and never silences the
block; `unknown` is a writer saying "there is a block I cannot classify", which is a
different statement and keeps the limit.

### 6.2 `confirmation_gate`

Trigger: a confirmation request on the card. Detection priority:

1. an explicit `meta.gate_at` (forward-compatible exact field) — `high`;
2. a `confirm_request` comment (§11) — `high`;
3. the legacy `[confirm-request]` body marker — `high`;
4. the three-part prose shape (a `.md` path, a confirmation ask, open items) — `low`.

Within one channel the latest `created_at` wins; between channels, priority wins even when a
lower-priority channel is newer. **No detectable request means no trigger** — the row is
about an *unanswered request*, not about a card's age, and inventing a gate would alert on
every card on the board.

The gate closes when a later **leader-authored** `kind=confirm` entry appears. A worker's
confirmation does not close it: the gate is the leader's to answer, and letting any worker
close it would be a false-green.

### 6.3 `defect_card_creation` and leader attribution

Trigger: a `kind=defect` trail entry. (The defect ticket itself lives in the Report, which
carries no timestamp, so the trail is the only observable.) Origin: the earlier of that
entry and the card's entry into `blocked` / `canceled`.

The wait closes only for a fix card that carries a bug label (`bug` or `category:bug`)
**and** references the origin through one of `meta.fixes`, the card's review identity
(`review_of`), `meta.origin` or `meta.parent`. A label without a reference back is not
enough, and a reference without the label is not either.

An incomplete board read makes "no fix card" undecidable. The row is still reported as open
— an unknown must not become silence — at `low`, with an open predicate that says so.

**Leader attribution is an author test, not a kind test.** A leader action is:

- **A** — a `confirm` / `decision` / `change` comment authored by the leader;
- **B** — a card created by the leader (the reporter);
- **C** — a transition to `done` (leader-only), except an automated acceptance carrying
  `meta.accepted_by` in `{loop-review, loop-auto}`;
- **D** — the attribution rule behind A–C: the **author** decides. The default leader is
  the board's own decision authority, `author_kind == "human"`; a deployment whose leader
  writes as an agent sets `--sla-leader <id>` to the **same** actor id on both mechanisms,
  which narrows the same filter by one author rather than replacing it.

A worker's `change` never resets the stall clock: the point of D is that `kind` alone cannot
tell a leader's `change` from a worker's, and counting the worker's would let any chatty
worker mask a real stall. An automated `done` (C's exception) must not reset the clock
either, or the loop could hide a stalled leader indefinitely.

### 6.4 `acceptance_card_creation`

Applies to a card in `in_review` that is **not itself a review card**. The exclusion is the
card's review identity (the `review_of_id` / `review_round` columns through
`src/foundation/review-identity.mjs`), not a patchable `meta.flow` label.

Origin: `status_changed_at`. The wait closes for an **open** review card whose `review_of`
names this card and whose `review_round` is `null` or equals this card's `delivery_round`.
The "open" half matters: a `done` review means the verdict landed but the original is still
`in_review` — the designed `human` acceptance waiting for its person, or a crash before an
`agent` original moved. That state does not close the wait; it becomes the acceptance
reminder and the action says so. A `canceled` review is ignored.

A review card from an earlier round does not suppress a fresh delivery: a rejected,
re-delivered card is a new round with no review card yet, and the rejection path depends on
this. A review card written before `review_round` existed carries `null`, which suppresses
while it is open — the pre-round behaviour and the only honest reading of such a card.

An incomplete board read lowers confidence to `low` and marks the predicate undecidable; the
row is still reported.

### 6.5 `heartbeat_stale`

Applies to `in_progress` **work** cards. An `epic` is excluded: a container is never claimed and
never pulses, and its auto-start enters `in_progress` with no holder by design
(`src/core/README.md`), so a heartbeat predicate over it can only report the board's own state as
a defect. Origin: `heartbeat_at` (`high`). An unreadable heartbeat is not green: it alerts at
`warn` with no threshold, mirroring the legacy `heartbeat-unreadable` alert rather than
replacing it.

The row emits the shared tuple **beside** the legacy heartbeat alert stream that
`planPatrol` produces (`{type: "stale" | "heartbeat-unreadable", …}`), which keeps its
published per-card shape and its consumer. Both channels skip the container: `planPatrol` reads
`src/foundation/task-kind.mjs#isContainer`, the same reading the row uses. One stale heartbeat therefore notifies twice, on
two channels, by design: the legacy shape has no `dedup_key`, `sla_row` or working-hours
basis, so without the tuple the two mechanisms could not de-duplicate it.

### 6.6 `inspector_liveness`

Board-level; §5.3 defines the predicate. It has no card, so it is anchored on the stable
pseudo-card `board`, which keeps its `dedup_key` constant for one outage and lets the runner
tell "there is no card here" apart from "the card could not be read".

`leader_stalled` is board-level too but is anchored on a **real** card for display — the
leader-owed card with the earliest `status_changed_at` — while its open predicate remains
the board's. Re-reading that card cannot answer "is the leader stalled", which is why neither
board-level row is re-read before sending (§9.2).

## 7. Releasability hints

A blocked card can carry `releasable: true` with a basis. This is a **hint**, never an
action: it says the evidence of an answer is already on the board, and releasing the card
stays the leader's decision.

### 7.1 The bases

| Basis | Applies when `blocked_reason` is | Evidence |
|---|---|---|
| `clarification_trail_after_block` | absent, `clarify`, `decision` | a leader-authored `change` / `confirm` / `decision` entry newer than `blocked_at` |
| `deps_satisfied` | `dependency` | every `meta.depends_on` entry names a card in a terminal status (`done` / `canceled`) |
| `assignee_changed` | `out_of_bounds` | a leader-authored `change` newer than `blocked_at` whose body says it was a reassignment (`改派` / `reassign` / `assignee:`) |

### 7.2 A hint is not an action

The hint rides in `action`, so the tuple that fires is unchanged — a hinted card is still an
open wait, and the patrol still never moves it.

### 7.3 Which reason selects which hint

1. A card whose reason is `dependency` gets `deps_satisfied` once every `meta.depends_on`
   target is terminal.
2. A card whose reason is **absent** behaves exactly as `clarify`: absence preserves today's
   semantics and never silences the block, so it gets the clarification hint.
3. `clarify`, `decision` and absent get `clarification_trail_after_block`;
   `out_of_bounds` gets `assignee_changed`.
4. The remaining reasons (`defect`, `unknown`, `external`, `resource`) offer no hint — the
   mechanism does not guess at evidence it cannot read.

### 7.4 The evidence channel for `assignee_changed`

The board snapshot carries only the *current* assignee, so a re-read can never show that the
assignee changed; the trail is the only machine-readable change channel, and both mechanisms
read the same one. The body must then say it **is** a reassignment: a card can be `change`d
a dozen times for other reasons, and reporting each as "the assignee moved" would be a false
hint rather than a fail-safe one. Over-reporting a hint is noise, not coverage.

## 8. Delivery: de-duplication and the ledger

### 8.1 The ledger

The ledger is a JSON file beside the loop's state (`sla-ledger.json`):

```json
{ "version": 1, "seen": { "<dedup_key>": { "first_seen": "…", "last_seen": "…", "observed_by": ["loop-patrol"] } } }
```

A missing or unreadable ledger reads as **empty**, so the pass notifies rather than
suppresses. A failed write costs a duplicate, never an alert. The same code and file shape
serve the workflow pass's own ledger; both read only `dedup_key`.

### 8.2 Keys

```text
alert_id  = <card_id>#<sla_row>#<severity>
dedup_key = <alert_id>@<measure_start_at>
```

Three properties are deliberate:

- the **tier** in the key means a promotion is a *new* key — an escalation is never
  de-duplicated away;
- the **origin** in the key means a new wait on the same card/row/tier re-notifies — a
  re-blocked card is a new wait, not a duplicate;
- a repeat of the same key is suppressed.

### 8.3 Notify, then record

1. Partition against the ledger; already-seen keys are suppressed.
2. Re-check the survivors (§9.2). A candidate dropped here leaves **no** marker.
3. Only after the send is the key recorded.

The order is the whole rule: a marker written before the send would suppress the very alert
that was never delivered, and a lost alert is the one failure the ledger must never cause. A
duplicate is admissible; a lost alert is not. An unreadable ledger therefore suppresses
nothing.

A suppressed duplicate still refreshes `last_seen` and grows `observed_by`, so a duplicate
that was *seen* remains auditable even though it was not sent.

### 8.4 The watchdog under the same ledger

`inspector_liveness` is keyed on the `board` sentinel and the peer's last-ok instant
(`measure_start_at`). One peer outage therefore produces one key and one notification, and a
peer that recovers and fails again produces a new key because the origin moved.

### 8.5 Pruning

Keys older than 30 days (`last_seen`) are dropped, and if that still leaves more than 5,000
keys, the oldest go too. Dropping a key costs at most one duplicate notification, which is
the admissible failure. An outage that outlives the prune window re-notifies for the same
reason.

## 9. One pass

### 9.1 What a pass reads

The cost of a pass is bounded by construction, because every read is a file or an HTTP call
on the board:

- **one board snapshot** (`?limit`, default 500, hard cap 5,000), which is the same
  projection `issue list` returns;
- **the comment trails only for cards that could fire a trail-derived row** (`?trail_limit`,
  default 200 cards, hard cap 2,000; 200 comments per card). A trail is read only once the
  card is old enough for `confirmation_gate`, `defect_card_creation` or the
  `blocked_clarification` hint to be able to fire — below the warn lead no trail-derived
  value is ever needed. `done` cards are skipped entirely, so an archive does not grow the
  read; a card whose `status_changed_at` cannot be read is fetched anyway, because an
  unreadable origin must not be able to suppress a row;
- **one card read per surviving alert** (`sla get <ref>`), which always includes that
  card's trail.

The trade-off is stated under §13: a leader event recorded on a card young enough to be
outside the trail read is not observable to `leader_stalled`.

### 9.2 Truncation is reported

A capped snapshot or capped trail reads are always reported (`board_truncated` /
`trails_truncated`), never smoothed into a quiet board. Rows whose negative predicate then
cannot be decided (`no_fix_card`, `no_review_card`) stay open at `low` and say so.

### 9.3 Fail-safe directions

- A re-check that cannot run **lets the alert through**. Only a successful read that no
  longer contains the row is grounds for a drop.
- A card read that fails (a deleted card, a board error) is "could not run", not "closed".
- A failed SLA read fails the whole pass (exit 1). A patrol that looks quiet because it
  never asked is the failure this mechanism exists to prevent.

### 9.4 Zero-cost idle

A wait inside its lead is not a candidate at all — not an alert, not a "dropped" line. This
is a property of the decision function, not of how the runner chooses to log, so a quiet
board produces no notification, no model turn and no noise. The pre-emit re-check's
`dropped` channel is only for candidates that were open and then closed.

### 9.5 What the pass reports

One pass logs what it did: how many alerts went out, how many were suppressed, how many were
dropped, whether the board or the trail reads were capped, and any configuration warning.
Its result carries the same counts plus the emitted tuples and the updated ledger. It never
reports an LLM turn for an SLA alert — the count is always zero.

### 9.6 The pre-emit re-check, and its drops

Immediately before notifying, the loop asks the board for the surviving card's rows again.
The board runs the **same** detectors, so this is one decision rule rather than a second
restatement of it. A row still absent from the fresh response is dropped; the row is matched
by **`(card, row)`**, not by the de-duplication key, because a tier promotion during the
re-read keeps the row open (the next pass emits the new key).

Board-level rows are never re-read: `inspector_liveness` has no card, and `leader_stalled`'s
anchor card cannot answer whether the leader is stalled.

A dropped candidate is reported with a reason (`recheck:<row>:not_open`), never swallowed,
and leaves the ledger untouched — it is a candidate that was open and then closed, not a
wait that never fired.

## 10. Peer interoperability

The files and the tuple are the whole surface; no external document is needed to read them.

### 10.1 The marker

Written atomically (temp file + rename) after a completed, non-dry-run pass:

```json
{
  "mechanism": "loop-patrol",
  "last_ok": "2026-10-14T10:00:00.000Z",
  "mechanism_actor": "claude/linus",
  "cadence_period_min": 5
}
```

A reader takes `last_ok` (or `lastOk`) and `cadence_period_min` (or `cadencePeriodMin`). A
missing, zero or non-numeric cadence falls back to the deployment's effective
`peer_period_min` (default 15). A failed marker write is logged, never fatal: the peer's
watchdog is what notices.

### 10.2 The ledger

The `{version, seen}` object of §8.1, shared by both mechanisms. `observed_by` is the
record of who has seen a key.

### 10.3 The tuple and the table

A peer may consume `GET /api/v1/sla` instead of re-implementing the table: the response
carries the effective configuration and the same §4 tuples. A peer that keeps its own
implementation still interoperates through the tuple and the ledger. The minimum a peer
must do is publish its own marker (§10.1) and honour the `dedup_key`.

A client that mirrors the table rather than trusting the tuples reads the block all or
nothing (`slaFromWire`): a missing block means "an older board — use the defaults", an
invalid field is reported rather than half-applied, and unknown rows or fields are ignored
so a newer board can add one without breaking an older reader. The block carries a `version`
for exactly that kind of feature detection. Only numbers cross this wire; the row prose
(`ref`, `action`, …) stays local to the engine.

### 10.4 Leader identity must agree

`--sla-leader` must name the same **actor id** on both mechanisms. A display name is not an
id: the attribution test compares ids, and a configured value that only matches a display
name (or matches no author at all) produces a board on which no leader event is ever
observed — `leader_stalled` then fires on every pass with leader-owed work, which reads like
a board problem rather than a typo. The board returns the observation in `warnings`, the loop
logs it, and nothing about the attribution itself is changed by the warning.

## 11. `confirm_request`

`confirm_request` is the formal comment kind for "send this back to the leader for
confirmation". It is a **request**, not a decision:

- it does **not** enter `DECISION_KINDS`, `isDecisionComment`, `listDecisions`, the
  leader-attribution set, or the blocked-answer predicate;
- it opens a gate; a leader-authored `kind=confirm` closes it;
- it is written by a worker or the leader through `taskctl comment add --kind
  confirm_request` (or the equivalent HTTP call). The patrol never writes it.

Detection priority is §6.2. The legacy `[confirm-request]` marker and the three-part prose
shape remain as fallbacks for deployments that have not adopted the kind; a `confirm_request`
entry wins over either.

## 12. Non-goals

- **No per-agent-kind override.** The install-root `.env` is the one install-wide override,
  read by the board and published on the API; changing a **default** remains a contract
  change.
- **No weekend or holiday calendar.**
- **No writes and no turns.** The board computes the rows; it never notifies, writes a card,
  starts an LLM turn or accepts a delivery. The patrol never writes a card; `--patrol-llm`
  governs the legacy heartbeat lane only.
- **The legacy heartbeat alert stream is not re-shaped.** It keeps its per-card objects and
  its consumer; the tuple is added beside it.
- **`inspector_liveness` is not computed by the board.** It watches a marker file on the
  loop's host.
- **The mechanism is not a scheduler.** `P` measures; it does not schedule. When the patrol
  runs is the loop's cadence (`docs/scheduling.md`), and nothing here depends on that
  number matching `P`.
- **This is not the service SLO.** `/health`'s SLO verdict (`docs/ops/observability.md`) is
  about the board's own availability; these rows are about work waiting on a person.
- **The ordering score is a different clock.** `TASK_ORDER_SLA_HOURS` (the weight order's
  "how long has this waited" factor) is wall clock and does not use this basis; applying
  working hours there is a separate, unshipped extension.

## 13. Decisions, alternatives and costs

Each decision below is the difference between the mechanism agreeing with itself and merely
resembling itself.

- **D1 — the board computes, the loop notifies.** *Why:* the board owns the facts and the
  configuration, and one implementation cannot disagree with itself; the loop owns the
  ledger, the marker and the notification, which are host-local. *Cost:* the loop needs a
  reachable board; a failed read is a failed pass, not a silent one.
- **D2 — `warn = L − P`, no new number.** *Why:* the notice should arrive one period early,
  and the contract must not invent a second threshold per row. *Cost:* an operator who
  raises `P` past `L` gets every row on every pass (the lead clamps at 0).
- **D3 — a fixed working-hours window, no calendar.** *Why:* deterministic across hosts
  and timezones without a timezone database or a holiday service; a wait must not age while
  nobody is at work. *Cost:* weekends count, and a deployment with a different working day
  must change the contract.
- **D4 — fail safe, in one direction.** *Why:* silence and a false green are
  indistinguishable to an operator; over-alerting is visible and correctable. *Cost:* an
  unreadable card, a capped read or an unknown predicate produces an alert at `low` that a
  human must dismiss.
- **D5 — notify, then record.** *Why:* a lost alert cannot be recovered; a duplicate costs
  one notification. *Cost:* a crash between the send and the ledger write re-notifies.
- **D6 — re-check by `(card, row)`, not by key.** *Why:* a promotion during the re-read is
  still an open row; suppressing it on a key mismatch would lose the escalation. *Cost:* a
  promoted row can be reported once per tier.
- **D7 — the heartbeat row is a real SLA channel beside the legacy one.** *Why:* the legacy
  objects carry no `dedup_key`, so two mechanisms could never agree about one heartbeat; the
  tuple is the shared channel, and removing the legacy shape would break its consumer.
  *Cost:* two notifications for one stale heartbeat, by design.
- **D8 — attribution on the author, not the kind.** *Why:* a worker's `change` is narration;
  counting it would let a chatty worker mask a real stall. *Cost:* a deployment whose leader
  writes as an agent must configure `--sla-leader` or no leader event will ever count.
- **D9 — hints, never actions.** *Why:* the mechanism's value is that it cannot move a
  card; a wrong hint is a suggestion, a wrong action is a corruption. *Cost:* an operator
  must act on the hint.
- **D10 — one install-wide table.** *Why:* both mechanisms must compare the same numbers,
  and a peer reading `GET /api/v1/sla` must see what the board would compute. *Cost:* no
  per-agent-kind tuning.

Rejected alternatives, and why:

- **Take the external contract / the peer as the source of truth.** The repository would
  then not be readable on its own, and the document could not be changed with the code.
- **Wall clock.** Simpler, but it turns every overnight wait into an incident and makes two
  hosts disagree.
- **A per-card due date.** Each card would carry its own clock; the board would stop being
  able to say what "overdue" means once.
- **A scheduler that escalates.** Turning an alert into an action (a nudge card, a
  reassignment) makes the inspector a writer and gives it a second failure mode.
- **A sliding-window rate.** "No leader action in 60 minutes" needs an event window, which
  is exactly the trail read; the derived lead needs only the timestamp already on the card.

Known limits, accepted:

- Leader events are only observable in the trails the pass read (cards old enough for a
  trail-derived row). A leader acting only on fresh cards could, in principle, read as
  stalled once older work is pending — mitigated by the read being scoped to *old* cards and
  the row requiring pending leader work.
- A capped board read makes a negative predicate undecidable; the row stays open at `low`.
- Pruning can cost one duplicate notification; a peer that has never published a marker is
  indistinguishable from one that was never installed (which is why `--sla-peer` means
  "required").

## 14. Running it

- **The pass** is `taskctl loop patrol`, also part of `taskctl loop tick`. Its cadence is
  the loop's continue clock, not `P`; see `docs/scheduling.md`. A pass reads the board,
  notifies, writes the ledger and publishes the marker.
- **Delivery** is the operator's `--notify <cmd>`: each alert is passed as JSON on the
  command's stdin, with a 10-second timeout. A timeout or a non-zero exit is logged, not
  retried — retrying would break "notify, then record". With no `--notify`, alerts are logged
  only.
- **`--dry-run`** sends nothing and writes neither the ledger nor the marker.
- **`--patrol-llm=yes`** affects the legacy heartbeat lane only; an SLA alert never starts a
  turn.

Flags:

| Flag | Meaning |
|---|---|
| `--patrol-interval <sec>` | this mechanism's measurement period `P`; sent as `?period=` only when explicitly set |
| `--sla-leader <id>` | the actor id the leader writes under (default: the board's human decision authority) |
| `--sla-peer <path>` | the peer's marker, and the switch that makes the peer a required dependency |
| `--sla-last-ok <path>` | this mechanism's marker |
| `--sla-ledger <path>` | the de-duplication ledger |
| `--board-limit <n>` / `--trail-limit <n>` | the two read caps (§9.1) |

Default files, beside the loop's state: `sla-ledger.json`, `loop-patrol-last-ok.json`. The
peer's marker path is exactly what `--sla-peer` names; the peer may be another mechanism's
`--sla-last-ok`.

The two settings a deployment has to get right are stated in the loop log at the start of
every pass: the leader identity and the peer path. A mis-set leader silently changes which
events count as "the leader acted"; a missing peer silently disables half a contract — which
is why the log says which one it is, in words.

## 15. Conventions the detectors depend on

The rows read board facts that are defined elsewhere. Changing one of these changes the
meaning of a row, so they are listed together here rather than repeated in each detector.

| Fact | Where it is defined | What a row assumes |
|---|---|---|
| Comment kinds | `src/core/domain/enums.mjs` | `confirm`, `decision`, `change` are leader-attributable kinds; `confirm_request` opens a gate and is not a decision; `defect` reports one. |
| Decision authority | `author_kind == "human"`, or `--sla-leader` | The leader is an author, not a role column. |
| Review identity | `src/foundation/review-identity.mjs` over the `review_of_id` / `review_round` columns | A review card is identified structurally; `meta.review_of` is a mirror. Every layer reads it through this one reader. |
| Bug label | `bug` / `category:bug` | A fix card must both carry the label and reference the origin. |
| Meta keys read | `gate_at`, `fixes`, `origin`, `parent`, `depends_on`, `accepted_by` | These are the machine-readable channels. Prose is parsed only in the documented fallbacks: the `[confirm-request]` marker, the confirmation prose shape, and the reassignment body. |
| Blocked reasons | `BLOCKED_REASONS` | The taxonomy in §6.1; absent is not a member and behaves as `clarify`. |
| Timestamps | `created_at`, `status_changed_at`, `blocked_at`, `heartbeat_at` | Exact frontmatter fields are `high` confidence; a derived or missing one is `low`. |

### 15.1 Where a change lands

| To change | Touch |
|---|---|
| a published default | the §2 table, `DEFAULT_SLA_ROWS`, and the pinned test — one contract change |
| an install's numbers | nothing in the code: `.env` override (§2.1) |
| the clock basis | §3, `WORKING_WINDOW`, and the working-hours tests |
| a row's detector | §6 for that row, its pure function in `sla-patrol.mjs`, and its trigger/silence tests |
| the tuple | §4, `buildSlaAlert` / `slaAlertToWire`, and the API contract snapshot |
| the peer format | §10 and both readers; the ledger and marker shapes are the compatibility surface |
| add a row | §2 and §6, `SLA_ENV_KEYS` / `SLA_ROW_KEYS`, `DEFAULT_SLA_ROWS`, a detector, the `.env` template, and the drift test |
