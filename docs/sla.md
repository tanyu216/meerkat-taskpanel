# SLA inspection

The SLA contract this repository implements. It is **in-repo and self-contained**:
the thresholds, the tier ladder, the working-hours basis, the de-duplication rules
and the mutual watchdog are defined here, and the code
(`src/foundation/sla-patrol.mjs`) and its tests are written against this document.
No external document is required to read, operate or change the mechanism.

The inspector is **notify-only**: every alert is addressed to the leader, and no
code path in the patrol writes a card. The board's workflow pass is the loop's one
writing channel.

## 1. Scope and status

- **Mechanism identity.** `loop-patrol` (`MECHANISM`). A deployment may run a
  second inspector; its marker is read through `--sla-peer` as an optional
  interoperability channel (`openclaw-cron` is the constant this repository names).
  Nothing in this document depends on that peer running.
- **The board computes, the loop notifies.** `planSlaPatrol` is a pure decision
  over a board snapshot and the trails it is given. The **board** owns the read:
  `src/core/commands/sla.mjs` builds the six card/board rows and exposes them as
  `GET /api/v1/sla` (`taskctl sla list|get` is its CLI face). The **loop** owns
  the de-duplication ledger, the pre-emit re-read and the notification.
  `inspector_liveness` stays with the loop, because it watches a marker file on
  the loop's host that the board cannot see.
- **Invariants.** notify-only; zero-cost idle (no alert below the warn lead);
  fail-safe, never false-green (an unreadable origin alerts instead of staying
  quiet; an undecidable open/closed predicate counts as open).

## 2. Mechanism parameters and the threshold table

| Parameter | Default | `.env` key | Meaning |
|---|---:|---|---|
| `PEER_PERIOD_MIN` | 15 | `TASKD_SLA_PEER_PERIOD_MIN` | fallback cadence for a peer inspector that does not declare one |
| `PEER_LIVENESS_K` | 3 | `TASKD_SLA_PEER_LIVENESS_K` | missed peer periods before `inspector_liveness` fires |
| `LEADER_LOOKBACK_DAYS` | 7 | `TASKD_SLA_LEADER_LOOKBACK_DAYS` | how far back a leader event can be called "recent" |
| `P` | 300 s | `TASKD_SLA_PERIOD_SECONDS` | the measurement period; it schedules nothing |

`L` = normal limit, `F` = further timeout, `P` = the measurement period. All
values are **working minutes**.

| Row | L | F | Warn lead | Origin | Covered by |
|---|---:|---:|---:|---|---|
| `blocked_clarification` | 120 | 1440 | `L − P` | `blocked_at` | `sla-patrol` |
| `confirmation_gate` | 240 | 1440 | `L − P` | `gate_at` | `sla-patrol` |
| `defect_card_creation` | 1440 | 2880 | `L − P` | `trail_event` | `sla-patrol` |
| `acceptance_card_creation` | 1440 | 2880 | `L − P` | `status_changed_at` | `sla-patrol` |
| `heartbeat_stale` | 30 | 360 | `L − P` | `heartbeat_at` | `sla-patrol+legacy-stale-alert` |
| `leader_stalled` | 60 | 360 | `L` (no lead) | `trail_event` | `sla-patrol` |
| `inspector_liveness` | — | — | `k × P_peer` | peer marker | `sla-patrol` |

The table is a **transcription**: `DEFAULT_SLA_ROWS` in
`src/foundation/sla-config.mjs` (re-exported as `SLA_ROWS` by
`src/foundation/sla-patrol.mjs`) carries the same numbers next to a reference
string, and `test/orchestrator/sla-patrol.test.mjs` pins both sides so the document
and the code cannot drift apart. Changing a **default** is a contract change:
update the table, the constant and the test together.

### 2.1 Install-level overrides

The published numbers are the **defaults**. A deployment may override any of the
six limited rows' `L` and `F` (`TASKD_SLA_<ROW>_LIMIT_MIN` /
`TASKD_SLA_<ROW>_FURTHER_MIN`) plus the four mechanism parameters, in the
install-root `.env`:

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

- **Precedence per key**: process environment → install-root `.env` → default.
- **Validation**: every value is a non-negative integer with a per-key range; the
  effective `F ≥ L` (a further bound below its normal limit would escalate before
  it is overdue). An invalid `.env` value stops `taskd` with
  `CONFIG_FILE_INVALID`; an invalid process value is reported by the SLA read and
  by `/meta` without stopping the board.
- **Delivery**: the board re-reads the file per request and publishes the effective
  table at `GET /api/v1/sla` (and `/meta` → `capabilities.sla`). The loop's patrol
  reads it on every pass; a hand edit applies without a restart.
- **`P` per call**: `--patrol-interval` is the mechanism's own measurement period
  and overrides the deployment's `TASKD_SLA_PERIOD_SECONDS` for that pass, so two
  inspectors with different cadences still share one `L`/`F` table while each
  computes its own `warn = L − P`. A period ≥ `L` clamps the lead to 0 (every
  pass reports that row).
- **`heartbeat_stale` is alerting only.** Its defaults mirror
  `CLAIM_STALE_SAME_MS` / `CLAIM_STALE_ANY_MS`, but an override changes when the
  alert fires, **not** when a claim becomes re-claimable; the two are independent
  by design.

`leader_stalled` is deliberately exempt from the `−P` lead and never reports
`overdue`: its published bound is already a "no action for" bound.

## 3. Working hours

`T` is accumulated only inside a fixed civil window: **09:00–23:00 Asia/Shanghai**,
every calendar day. The window rolls over, never resets, so a wait that spans an
off-hours stretch is still measured honestly. Asia/Shanghai is UTC+8 all year (no
DST), so the conversion is exact integer arithmetic and a host in another timezone
measures the same `T`.

There is **no weekend or holiday calendar**. Saturday and Sunday count exactly like
a weekday; a deployment that wants a different calendar must change this contract,
the `WORKING_WINDOW` constant and the tests together.

`elapsedWorkingMinutes` returns `null` for an unreadable instant; callers must treat
that as unverifiable, never as fresh.

## 4. The alert tuple

Every alert is the same flat object (26 fields):

`alert_id`, `dedup_key`, `card_id`, `sla_row`, `sla_ref`, `severity`,
`measure_start_kind`, `measure_start_at`, `measure_start_source`,
`elapsed_working_min`, `elapsed_basis`, `threshold_min`, `due_at`, `action`,
`target`, `notify`, `releasable`, `releasable_basis`, `blocked_reason`,
`confidence`, `mechanism`, `mechanism_actor`, `first_seen`, `last_seen`,
`observed_by`, `evidence`.

`evidence` carries the card's `status`, `status_changed_at`, `has_sessions`,
`has_workspace` (always `null` — the board holds no project directory),
`threshold_ref` and `open_predicate`. The liveness row has no card and puts the
peer's own facts there instead.

`due_at` is display-only; no verdict reads it. The verdict is always
`elapsed_working_min ≥ threshold_min`.

## 5. Tier ladder and liveness

### 5.1 Leader-owed work

`leader_stalled` only evaluates when at least one of the four leader-owed rows is
open: `blocked_clarification`, `confirmation_gate`, `defect_card_creation`,
`acceptance_card_creation`. A stale heartbeat and a silent peer inspector are not
leader-owed; admitting either would make a quiet night read as a stalled leader.

### 5.2 Tiers

One definition, shared by both mechanisms:

- `warn` ⇔ `T ≥ max(0, L − P)` — "due soon", **no breach**;
- `overdue` ⇔ `T ≥ L`;
- `escalate` ⇔ `T ≥ F` (when the row has a further bound).

`leader_stalled` is exempt from the lead and never reports `overdue`. An alert at
`escalate` carries `notify: "immediate"`; every other tier carries `digest`.

### 5.3 Inspector liveness

Each mechanism publishes a last-successful-run marker after a completed pass and
watches the peer's: `peer_stale ⇔ now − peer.last_ok > k × P_peer`. The bound is
**derived**, never invented; the row has no `threshold_min` and can only reach
`warn`.

If no peer is configured, the peer's half is a registered dependency and nothing
alarms. If a peer is configured but its marker is missing or stale, the row fires.
An unreadable observer clock fires too — an injected fault must not produce a clean
envelope.

## 6. Row origins, triggers and confidence

Confidence is pinned: `high` iff the chosen origin was read verbatim from one
unambiguous source; `low` iff it came from a fallback, a shape match, or a predicate
that could not be decided. Picking the latest among several **exact** candidates
stays `high`; a pre-lookback catch-up thread is the only `low` case.

### 6.1 `blocked_clarification`

Trigger: `status == blocked`. Origin: `blocked_at` (`high`), else
`status_changed_at` (`low`), else unverifiable (alert at `warn`, no threshold).
`blocked_reason` in `{dependency, external, resource}` has no contract row: it gets
visibility without a due point. An absent reason behaves exactly as `clarify`.

### 6.2 `confirmation_gate`

Trigger: a confirmation request on the card. Priority: an explicit `meta.gate_at`
(forward-compatible exact field), then a `confirm_request` comment (§11), then the
legacy `[confirm-request]` body marker, then the three-part prose shape. The first
three are `high`; the shape is `low`.

The gate closes when a later **leader-authored** `kind=confirm` entry appears. A
worker's confirmation does not close it.

### 6.3 `defect_card_creation` and leader attribution

Trigger: a `kind=defect` trail entry. Origin: the earlier of that entry and the
card's entry into `blocked`/`canceled`. The wait closes only for a fix card that
carries a bug label (`bug` or `category:bug`) **and** references the origin through
one of `meta.fixes`, `meta.review_of`, `meta.origin`, `meta.parent`. A label without
a reference back is not enough. An incomplete board read makes the "no fix card"
check undecidable: the row is still reported as open, at `low`.

Leader attribution is an **author** test, not a kind test. A leader action is:

- a `confirm` / `decision` / `change` comment authored by the leader;
- a card created by the leader (the reporter);
- a transition to `done` (leader-only), except an automated acceptance carrying
  `meta.accepted_by = "loop-review"`.

The default leader is the board's own decision authority: `author_kind == "human"`.
A deployment whose leader writes as an agent sets `--sla-leader <id>` to the **same**
identity on both mechanisms. A worker's `change` never resets the stall clock.

### 6.4 `acceptance_card_creation`

Applies to flow A only (an absent flow is treated as A). Origin:
`status_changed_at`. The wait closes for a review card whose `review_of` names this
card and whose `review_round` is `null` or equals this card's `delivery_round`. A
review card from an earlier round does not suppress a fresh delivery. An incomplete
board read lowers confidence to `low` and marks the predicate undecidable.

### 6.5 `heartbeat_stale` and never-false-green

Applies to `in_progress` cards. Origin: `heartbeat_at` (`high`). An unreadable
heartbeat alerts at `warn` with no threshold. The row emits the shared tuple **beside**
the legacy `{stale: […]}` envelope; the legacy shape is a published consumer contract
and is not re-shaped. One stale heartbeat therefore notifies twice, on two channels,
by design — the legacy envelope has no `dedup_key`, so without the tuple the two
mechanisms could not de-duplicate it.

### 6.6 `inspector_liveness`

Board-level; see §5.3. It is anchored on the stable pseudo-card `board`, so its
`dedup_key` is constant for one outage and the runner knows there is no card to
re-read.

## 7. Releasability hints

A blocked card can carry `releasable: true` with a basis. This is a **hint**, never an
action; releasing it stays the leader's decision.

- `clarification_trail_after_block` — a leader-authored `change` / `confirm` /
  `decision` entry newer than `blocked_at`;
- `deps_satisfied` — every `meta.depends_on` entry names a terminal card;
- `assignee_changed` — a leader-authored `change` after the block whose body says it
  was a reassignment.

## 8. De-duplication

The ledger is `{version: 1, seen: {<dedup_key>: {first_seen, last_seen, observed_by}}}`.

- `alert_id = <card>#<row>#<severity>`;
- `dedup_key = <alert_id>@<measure_start_at>`.

A tier promotion is a new key (an escalation is never suppressed). A new wait on the
same card/row is a new key (a re-blocked card re-notifies). A repeat of the same key
is suppressed.

**Notify, then record.** A candidate dropped before the send must not leave a marker,
or the next pass would suppress an alert that was never delivered — the one failure
the ledger must never cause. An unreadable ledger suppresses nothing. A suppressed
duplicate still grows `observed_by` and refreshes `last_seen`.

The ledger is pruned by age (30 days) and size (5,000 keys). Dropping a key costs at
most one duplicate notification.

## 9. Pre-emit re-check and safe operation

Immediately before notifying, the loop asks the board for the surviving card's
rows again (`taskctl sla get <ref>`, i.e. `GET /api/v1/sla?card=<ref>`). The board
runs the **same** detectors, so this is one decision rule rather than a second
restatement. A row still absent from the fresh response is dropped; the row is
matched by `(card, row)`, not by the de-duplication key, because a promotion
during the re-read keeps the row open (the next pass emits the new key).

A re-check that cannot run lets the alert through. A drop is always reported with a
reason (`recheck:<row>:not_open`), never swallowed. A board-level row
(`leader_stalled`, `inspector_liveness`) is not about one card and is never
re-read; `leader_stalled` is anchored on a real card for display, but the anchor
cannot answer whether the leader is stalled.

Bounded reads move with the computation: the board reads one snapshot
(`?limit`, default 500), trails only for cards old enough for a trail-derived row
to fire (`?trail_limit`, default 200), and one card's rows per surviving alert.
A capped read is always reported (`board_truncated` / `trails_truncated`); it never
looks like a quiet board.

## 10. Peer interoperability

The last-ok marker is written atomically:

```json
{
  "mechanism": "loop-patrol",
  "last_ok": "2026-10-14T10:00:00.000Z",
  "mechanism_actor": "claude/linus",
  "cadence_period_min": 5
}
```

A reader takes `last_ok` (or `lastOk`) and `cadence_period_min`; a missing, zero or
non-numeric cadence falls back to `PEER_PERIOD_MIN` (15). The ledger file is the
`{version, seen}` object of §8. These two files are the whole interoperability
surface; no external document is needed to read them.

A peer may also consume `GET /api/v1/sla` instead of re-implementing the table:
the response carries the effective configuration and the same §4 tuples. The
marker and ledger formats are unchanged either way, so a peer that keeps its own
implementation still interoperates through the tuple and the ledger.

`--sla-leader` must name the same **actor id** on both mechanisms. A display name is
not an id; the patrol logs a warning when the configured value only matches a display
name, or matches no author at all.

## 11. `confirm_request`

`confirm_request` is the formal comment kind for "send this back to the leader for
confirmation". It is a request, not a decision:

- it does **not** enter `DECISION_KINDS`, `isDecisionComment`, `listDecisions`, the
  leader-attribution set, or the blocked-answer predicate;
- it opens a gate; `kind=confirm` (leader-authored) closes it;
- it is written by a worker or the leader through `taskctl comment add --kind
  confirm_request` / the equivalent HTTP call. The patrol never writes it.

Detection priority is §6.2. The legacy `[confirm-request]` body marker and the
three-part prose shape remain as fallbacks for deployments that have not adopted the
kind; a `confirm_request` entry wins over either. Within one channel the latest
`created_at` wins.

## 12. Non-goals

- There is no **per-agent-kind** override. The install-root `.env` is the one
  install-wide override, read by the board and published on the API; changing a
  **default** remains a contract change.
- No weekend or holiday calendar.
- The board computes the rows; it never notifies, writes a card, starts an LLM
  turn, or accepts a delivery. The patrol never writes a card.
- The legacy `{stale: […]}` envelope is not re-shaped.
- `inspector_liveness` is not computed by the board: it watches a marker file on
  the loop's host.
