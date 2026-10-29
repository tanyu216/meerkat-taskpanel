# The card lifecycle: flow A, flow B and the workflow pass

A card moves through a whitelisted set of statuses, accumulates evidence for exactly one
delivery round at a time, and is closed by an authority check that reads the card's own mode.
Two flows share that machinery: a **flow-A** card is the work; a **flow-B** card is the
independent review of one delivery of it. This page is the design of both flows and of the
workflow channel that joins them.

It is a design page, not a procedure. The agent-facing contract is
[`status-lifecycle.md`](../skills/meerkat/references/status-lifecycle.md) (the state model) and
[`review-workflow.md`](../skills/meerkat/references/review-workflow.md) (the reviewer's
protocol); the acceptance model is [acceptance.md](acceptance.md); when the passes run is
[scheduling.md](scheduling.md); the wait-time watcher is [sla.md](sla.md). This page states
what each mechanism guarantees, where the guarantee lives, and why it is shaped that way.

The design stance, in four sentences:

- **One whitelist, enforced twice.** Every status move comes from one table in
  `src/core/domain/status.mjs`, and the schema re-encodes the same table as triggers. A raw
  writer meets the machine guarantee, not just the command layer.
- **Evidence belongs to a delivery round.** A report, a waiver and a review card each cover
  one `(card, delivery_round)` pair; when work comes back, the previous round's evidence is
  history rather than proof.
- **A review is a card, not a flag.** The audited card and round are immutable columns, and
  the review travels through the same lifecycle as the work — claimable, retryable and
  crash-recoverable.
- **The board decides, the loop writes.** `issue reconcile --workflow` returns a plan and
  performs no review write; the loop applies it, and closes the review card last.

## Design at a glance

| Component | Home | Invariant it upholds |
|---|---|---|
| **status whitelist** | `src/core/domain/status.mjs`, `tr_tasks_transition` | every ordered pair not in the table is refused |
| **delivery round** | `bumpsDeliveryRound`, `tr_tasks_round_bump` | evidence expires exactly when work comes back |
| **delivery gate** | `src/core/domain/delivery-gate.mjs`, `tr_deliver_gate` | `in_review` needs evidence for the current round |
| **acceptance snapshot** | `src/core/domain/acceptance.mjs`, the acceptance triggers | append-only, locked in review, checked on `done` |
| **claim** | `CLAIM_HOLDING_STATUSES`, `repositories/tasks.mjs#moveCas` | the execution lock lives with the attempt, not the column |
| **review identity** | `src/foundation/review-identity.mjs`, `review_of_id` / `review_round`, the review triggers | one reader, immutable columns, no review of a review |
| **workflow plan** | `src/core/domain/workflow.mjs` | decisions only: reconcile, outcomes, auto-accept, dispatch |
| **workflow executor** | `src/orchestrator/runners.mjs` | bounded writes; the review card closes last |
| **container rules** | `src/core/commands/rollup.mjs` | the board starts and closes an epic; a container is never claimed |

## 1. The record

A card has three independent axes:

- **`status`** — the stage. Seven are stages on the board; `awaiting` is an eighth literal that
  is an *overlay* on an in-progress card, displayed under `in_progress`.
- **`kind`** — `task` or `epic`. Kind changes one edge (`todo → in_review` for an `epic`) and
  the claim rule (an epic is never claimable). Nothing else.
- **`role`** — derived, not stored: `task`, `epic`, or `review`. A review card is a
  `kind=task` card that carries the review marker; ask `role`, not `kind`, when deciding what
  a card is for.

| Stage | Meaning |
|---|---|
| `backlog` | Not released for work. |
| `todo` | Released and waiting. The only status a card can be claimed from. |
| `in_progress` | Being worked; holds the claim. |
| `in_review` | Delivery evidence attached, awaiting a verdict. |
| `blocked` | Stopped on something external; `blocked_reason` says what. |
| `awaiting` | The same attempt, paused on a human question. Not a board column. |
| `done` | Accepted. Terminal, with one audited exit: reopen to `todo`. |
| `canceled` | Abandoned. Terminal, with the same one exit. |

The whitelist is the whole state machine:

```text
backlog     → todo, canceled
todo        → backlog, in_progress, blocked, canceled        (an epic also → in_review)
in_progress → in_review, blocked, todo, canceled, awaiting
awaiting    → in_progress, todo, canceled
in_review   → done, in_progress, blocked
blocked     → todo, in_progress, in_review, canceled
done        → todo
canceled    → todo
```

Three rules outside the table are load-bearing:

- **`x → x` is not a transition.** A stale `in_progress` is recovered with `issue claim`, not a
  self-move.
- **An unknown status is `VALIDATION_FAILED`**, not `INVALID_TRANSITION`.
- **`in_review → canceled` does not exist.** Abandoning a review takes two moves through
  `in_progress`, and both exits from `in_review` start a new round — there is no quiet cancel
  that leaves the round untouched.

The two overlays are additive, never replacements: the **epic overlay** adds one pair, and the
**`off`-mode overlay** adds `in_progress → done`. Both are keyed on an explicitly supplied
`kind`/mode, so a caller that has not read the card gets the base table. That is the
fail-closed direction: an unstated kind or mode is never *more* permissive.

## 2. Flow A: the work cycle

### 2.1 Creation

A card is born in a status that presupposes no work it has not done. `issue create` goes
through the same door for the CLI and HTTP, and applies an INSERT-shaped gate
(`assertCreationGate`):

| Initial status | Result |
|---|---|
| `backlog`, `todo`, `blocked`, `canceled` | allowed for a `task` |
| `in_progress` | `VALIDATION_FAILED` — it is a claim, and a create can neither claim nor be a system start |
| `awaiting` | `VALIDATION_FAILED` — a card is not born waiting |
| `in_review`, `done` | `REPORT_REQUIRED` — there is no evidence yet |
| an `epic` in anything but `backlog` / `todo` | `VALIDATION_FAILED` |

The gate is not a trigger because a create is an INSERT while the delivery gate fires on
UPDATE. The refusal is the *same structured error* a reportless move produces — same code,
same `details`, same repair hint — so the two paths cannot tell a caller different stories.

### 2.2 Claim and the work cycle

`todo → in_progress` **is** the claim: it stamps `claimed_by`/`claimed_at`/`heartbeat_at` in
the same write. Only `todo` is claimable; `issue claim` and `issue move … in_progress` are the
same path, and the assignment check (or an audited `--allow-steal`) runs before the write.

The claim is a lock on *this attempt*, so it lives exactly as long as the attempt:

| Status | Holds the claim? | Why |
|---|---|---|
| `in_progress` | yes | the work is running |
| `awaiting` | yes | the same attempt, paused on a human |
| `in_review` | yes | the same executor's card, handed over for review |
| `blocked` | yes | the same attempt, stopped on something external |
| `todo`, `backlog`, `done`, `canceled` | no — the write releases it | outside the attempt |

`in_review` and `blocked` are inside the cycle because both can be exited back into
`in_progress` (`rework`, `unblock`), and the card that comes back must still be the same
executor's card. Releasing on entry would silently hand the lock to whoever performed the
bounce, and the original executor's next heartbeat would be refused with `EXECUTION_ACTIVE`.

The release on leaving the cycle is not cosmetic: the schema refuses a claim on a `backlog`
card, while `in_progress → todo` and `todo → backlog` are both legal. A leaked `claimed_by`
across those two legs used to surface as a raw `CHECK constraint failed` in the UI.

Heartbeats refresh `heartbeat_at` and nothing else, only in `in_progress`, only from the
holder. The thresholds are one clock with three readings: the holder may re-claim after ten
minutes, `issue candidates --stale` offers a card after thirty, and anyone may take over after
six hours as an audited takeover.

The dependency rule is a **read** rule: `issue candidates` withholds a card whose `blocks`
predecessor is not `done` (literally `status !== "done"`, so a `canceled` predecessor withholds
too), while `issue claim` / `issue move` do not re-check it. A worker that skips the candidates
read can claim blocked work.

### 2.3 The waiting states

- **`blocked`** is an ordinary state with an optional `blocked_reason`. Entering it does not
  bump the round. `in_review → blocked` does — because the delivery came back, not because it
  was blocked.
- **`awaiting`** is the attention overlay. Only `in_progress → awaiting` enters it, with an
  enumeration (`E1`…`E5`) and, for an agent, a `question` comment written in the same
  transaction. **Any human comment answers it**, whatever its kind, and re-queues the card to
  `todo` in that transaction — the asking subagent is a one-shot and is gone, so only the
  queue gets it dispatched again. The board does not read the prose; the resumed worker judges
  whether the answer is complete. A `decision`/`confirm`/`change` comment remains the explicit
  record, not the resume gate.

`awaiting → in_progress` is a **resume of the same attempt**, not a rework: the round does not
move and the round's report, once written, still counts. The forbidden exits are the point:
`awaiting → in_review | done` is a delivery-gate bypass, and the whitelist and trigger both
refuse it.

### 2.4 Delivery

A card enters `in_review` only with evidence **for the current delivery round**: a `delivery`
report whose round is the card's current `delivery_round`, or an audited waiver
(`--no-report --reason "<why>"`, at least eight characters) that names the same round. The
waiver is stamped on the row, recorded as `report_waived`, and shown under `report_waivers[]`;
it excuses the delivery gate, not acceptance.

Three shape rules ride along:

- **A path anchor must name its commit.** A report with a `path` anchor and no `commit` anchor
  is `DELIVERY_NEEDS_COMMIT`, because a path is a claim about the working tree and the tree can
  be stashed before the reviewer reads it. Review cards and epics are exempt.
- **An `epic` delivers a rollup.** A report written on an epic is marked `is_rollup = 1`; a
  waiver cannot stand in, because a container has nothing to deliver but its children's work.
  The rollup must name every live child — `done` is `met`, `canceled` is `not_applicable` with
  a reason — and at least one child must be `done`.
- **A report is part of the move, not a separate step.** `issue deliver` writes the report and
  moves the card in one transaction. `--to done` is the `off` mode's direct acceptance and
  still consults the gate for a non-empty baseline.

The gate is implemented twice: `assertDeliveryGate` in the domain and `tr_deliver_gate` in the
schema. The trigger covers the UPDATE path; the domain adds the waiver's shape and the
creation gate. Both implementations are checked against each other in
`test/contract/state-machine.test.mjs`.

### 2.5 Acceptance

`done` is the board's acceptance act, and the card's own `acceptance_mode` names who may
perform it. The rules, the three modes and the enforcement layers are
[acceptance.md](acceptance.md)'s subject; the lifecycle-relevant half is:

- From `in_review`, `done` is the ordinary exit. From `in_progress`, it exists only in `off`
  mode.
- An `agent` card's `done` needs a current-round review card that has itself reached
  `in_review` or `done` (`REVIEW_REQUIRED`), and the service layer additionally requires that
  review's `APPROVE` to cover the baseline. A human closing it while a current-round review is
  still open gets `REVIEW_PENDING`. The `human` mode deliberately does not have the latter
  guard — a person may close while the review is open.
- A non-empty acceptance baseline must be covered by the current round's delivery report
  (`ACCEPTANCE_UNVERIFIED` / `ACCEPTANCE_INCOMPLETE`). A waiver excuses the delivery gate, not
  this.
- Both children rules are shared with `in_review`: no child may still be open (`CHILDREN_OPEN`).

`canceled` is abandonment, never acceptance. It is legal from most stages, has no child guard
and needs no evidence, so treating it as "closing" a card silently orphans the work.

`done` and `canceled` are terminal, with one audited exit: **reopen to `todo`**. The reopen
requires a reason, clears the archive, releases the idempotency key and starts a new delivery
round. `in_progress` is deliberately not a reopen target: a reopened card has no claim holder,
and landing there would create an `in_progress` row with `claimed_by IS NULL` — the corruption
the claim invariant exists to prevent.

## 3. The delivery round

A round is the unit of evidence. It is bumped by exactly two families of move:

| Move | Round |
|---|---|
| create | `1` |
| entering `in_review` | unchanged |
| `in_review → in_progress` | **+1** |
| `in_review → blocked` | **+1** |
| `in_review → done` | unchanged |
| `awaiting → in_progress` | unchanged |
| `awaiting → todo` | unchanged |
| `done`/`canceled → todo` | **+1** |
| everything else | unchanged |

The two `+1` families mean the same thing: **the delivery came back**. A rework voids the
previous report *and* waiver; the next delivery needs fresh evidence. A terminal reopen must
bump too, or the old round's report would satisfy the gate for the first delivery after a
reopen.

A round is what four mechanisms key on, and they must agree:

1. the delivery gate (a report for the current round),
2. the review card (`review_round` is the original's audited round),
3. the dispatch idempotency key (`loop-review|<ref>|r<round>`),
4. the SLA suppression (an open review card silences `acceptance_card_creation` for that round
   only).

The round is also the baseline's lock boundary: the acceptance snapshot is append-only and
frozen in `in_review`/terminal; a rework re-opens it, which is how a rejection's must-fix
items can be appended before the card is re-queued.

## 4. Flow B: the review card

### 4.1 Identity

A review card is an ordinary `kind=task` card. Its identity is two immutable columns:

| Column | Meaning |
|---|---|
| `review_of_id` | the internal id of the card it audits |
| `review_round` | the original's `delivery_round` it audits, or `NULL` for a round-agnostic review |

`meta.review_of` / `meta.review_round` mirror the columns for export and readability. The
mirror is **not** a policy input; `meta.flow=B` is a discovery convention, not the predicate.
Every reader — dispatch, outcomes, the SLA patrol, the CLI — goes through
`src/foundation/review-identity.mjs`, so "is this a review card" has one answer.

The structural rules are enforced at creation, in the domain and in triggers:

- the original must be `in_review` at creation, and a supplied `review_round` must equal the
  original's current round;
- a review card is always `acceptance_mode = off` — flow B is never reviewed again;
- a review card is created as `kind=task` — an epic cannot be claimed, so an epic review would
  never be woken; a later promotion is unsupported. It may not be either end of a `parent`
  edge (the trigger refuses both ends, promoted or not);
- a review cannot be created against a review (`tr_tasks_review_not_review`);
- the marker columns are immutable, so a later PATCH cannot re-point the audit.

A review card also has **its own** `delivery_round`, starting at `1`; the two rounds are
deliberately different. The original's round is `review_round`; the review card's round is the
round its own verdict report is stamped with. A re-dispatch after an unreadable verdict is a
rework of the review card, so its own round bumps and the second verdict needs a fresh report.

On the board it runs the ordinary cycle, with one difference at the end — who applies the last
move:

```text
dispatch                 todo
  claim                  in_progress
  verdict report         in_review
  the loop (or a human)  done
```

`done` is reachable only from `in_review`, so a verdict is a delivery like any other and the
report gate applies to it. The card can also be canceled (its original was canceled), sent back
to `todo` for another review attempt, or moved out by the two-hop cancel; it can never be
reopened, and it is never reviewed again.

### 4.2 Dispatch

The workflow pass dispatches **one review card per `(original, delivery round)`** with the
deterministic idempotency key `loop-review|<ref>|r<round>`. The dispatch predicate is:

- flow A (not a review card), status `in_review`;
- `acceptance_mode` is `agent` or `human` — review is mode-independent; `off` is the one mode
  with no review;
- no non-terminal review card already covers this round (a `done` one is the
  "review finished, original still open" finding; a `canceled` one no longer blocks);
- an effective reviewer exists: `project.reviewer ??` the deployment reviewer;
- the reviewer is not the card's own assignee/holder (`self_review_not_independent`).

The review card is assigned to the reviewer actually used. A deployment with `agent` cards and
no effective reviewer reports `dispatch_skipped` per project — not silently.

Candidates are ordered by `status_changed_at`, then ref, and sliced by the pass cap. A
truncated board read dispatches nothing. A missing reviewer, a self-review and a capped
dispatch are standing states, not findings an operator can act on in a single tick, so they
are logged (or alerted once) rather than notified every period.

### 4.3 The verdict

The reviewer reports; it moves nothing. It delivers a report **on the review card** whose first
line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`; everything after that line, plus
`leftovers`, carries the findings.

An `APPROVE` is checked against two baselines before it can close anything:

- the original's frozen acceptance snapshot, and
- the review card's own snapshot (the original's list plus the generic review checklist).

Every item must be answered; each `met` must cite an `evidence[n]` that resolves inside the
report (`no_anchor` / `dangling_anchor` are `ACCEPTANCE_INCOMPLETE`), and the report must carry
at least one `command` anchor, because the reviewer runs the gate itself
(`details.reason = "no_command_evidence"`). The gate is the project's declared one
(`project.meta.review_gate`, copied into the review card's description) when there is one;
otherwise the reviewer runs the targeted checks and records `n/a — none declared`. For an epic,
the current-round rollup must still match the children (`rollup_unverified` / `rollup_stale`).

A `REJECT` is never checked for coverage — `partial` / `not_met` is its normal shape — but its
findings must survive the round. A numbered list is appended to the original's frozen
baseline; prose or no findings still appends one pointer item, because silence is the one
outcome a rejection may not have.

### 4.4 What the loop does with each verdict

The board's plan is a function of the **original's mode** and the verdict:

| Original | APPROVE | REJECT |
|---|---|---|
| `agent` | `approve`: close the original, close the review | `reject_task` / `reject_epic`, then close the review |
| `human` | `record_verdict`: record the round-scoped verdict, close the review, leave the original `in_review` | same rejection path; a later `APPROVE` is recorded, never applied |
| `off` | `close_review` only (an ad-hoc review card; the mode owns acceptance) | same |

The executor sequences each one so a crash leaves a recoverable, re-plannable state:

- **`approve`** — comment the verdict on the original, write `meta.accepted_by=loop-review`,
  move the original `in_review → done`, then close the review card. When the loop runs with
  per-card worktree lanes, a **landing** step runs first: the lane branch is merged into the
  project's current branch, and a dirty checkout or a merge conflict keeps the card in
  `in_review` with its verdict recorded (see [scheduling.md](scheduling.md)). An `auto_accept`
  lands the same way before its `done` write.
- **`record_verdict`** — comment, write `meta.review_verdict=approve` with
  `meta.review_verdict_round`, close the review card, stop. The person closes the original
  through the ordinary acceptance gate.
- **`reject_task`** — comment the findings with `kind=change`, write `meta.rework_round`, move
  `in_review → in_progress` (the bump is what unlocks the baseline), append the must-fix items,
  move to `todo`, then close the review card.
- **`reject_epic`** — create and link a non-terminal **fix child** first, then reopen the
  container. Without the child, the very next `reconcile` would see every child terminal and
  re-close the container before the fix could be worked.

The loop always closes the review card it dispatched. A `canceled` original cancels the
review. A review that audited a round the original has moved past is closed as history
(`round_mismatch`) unless the move was its own half-applied rework, in which case the rework is
finished (`reject_task_finish` / `rework_applied`) rather than re-judged.

### 4.5 When there is no outcome: recovery and alerts

The design rule is **alert, never guess**. A verdict the loop cannot apply leaves the review
card in place and raises an alert; the next tick re-plans.

| State | Handling |
|---|---|
| the report has no readable verdict | `verdict_unreadable`, re-dispatch (`reopen_review`) |
| an `APPROVE` that fails coverage or anchor checks | `verdict_incomplete` / `verdict_unsupported`, same bounded re-dispatch |
| the report's author is not the review card's assignee | `review_report_not_by_reviewer`, no write |
| the original is not in the snapshot | `original_unseen`; on a truncated read it is marked `undecidable` |
| the original is `done`, the verdict is `REJECT` | `verdict_conflict`, no write |
| the review card is not `in_review` (todo / in_progress / blocked / awaiting) past the aging threshold | `review_aging` |
| the re-dispatch bound (`meta.review_retry`, default two) is exhausted | `review_retries_exhausted`, left for a human |

A re-dispatch writes the retry marker **before** the two-hop `in_review → in_progress → todo`,
so a crash between the hops is finished on the next pass. An `in_progress` review card whose
heartbeat is newer than the marker was genuinely re-claimed and is left alone.

The author check is the loop's half of reviewer identity. The board has no per-agent ACL, so a
report written by anybody other than the review card's assignee is not a verdict, whatever it
says.

### 4.6 Why the review card closes last

Every outcome ends with the review card's close, after the original's write. A crash between
the two leaves the original in its final state and the review card open; the next pass reads
the original and completes the close (`already_approved`, `rework_applied`, `reject_task_finish`).
The reverse order would leave nothing to recover from: the card was the only artefact
carrying the verdict.

That is also why the review card is a card: it is claimable, heartbeatable and retryable, and
its report has a durable home. A flag on the original could not be re-claimed by a fresh
reviewer after a crash.

### 4.7 The exchange in one picture

```text
worker      todo ──claim──▶ in_progress ──report──▶ in_review              (round N)
board       in_review + agent|human ──dispatch──▶ review card              (audits round N)
reviewer    todo ──claim──▶ in_progress ──VERDICT report──▶ in_review
loop        APPROVE · agent  original → done, review card → done
            APPROVE · human  verdict recorded, review card → done, original stays in_review
            REJECT           original → in_progress (round N+1) → todo, review card → done
```

An `off` card skips the dispatch and verdict rows: the delivery pass auto-accepts it, or the
deliverer closes it directly with `issue deliver --to done`. Everything else — the gate, the
round, the claim, the report — is shared between the two flows.

## 5. The workflow pass

`taskctl issue reconcile --workflow` returns a plan in four parts, and the loop executes it in
that order:

1. **reconcile** — the container rules (`commands/rollup.mjs`) replayed; normal in-flight
   verdicts are silent, while `empty_epic`, `no_delivery_evidence`, `no_child_done` and
   `dangling_child_edge` are notices.
2. **outcomes** — one action per readable verdict (the table in §4.4).
3. **auto-accept** — every flow-A, `off` card in `in_review` with no non-canceled
   current-round review. The loop writes `meta.accepted_by=loop-auto` and
   `meta.accepted_round`, then moves the card to `done`. Guards: a truncated read accepts
   nothing; the baseline must be covered (or empty); an epic needs a current-round rollup.
4. **dispatch** — §4.2, told which originals outcomes and auto-accept already handled, so a
   card approved in this pass is not immediately re-dispatched.

The plan is pure: no I/O, no clock (the time is an input), no board. That is what lets one
implementation serve the board's `issue reconcile --workflow` and the loop without the two
drifting.

Three properties make the pass safe to run repeatedly:

- **Bounded.** At most `--workflow-max-actions` (default 20) writes per pass, over a board read
  capped by `--board-limit` (default 500). When the combined slice drops work, the plan carries
  one `actions_capped`; dispatch-only overflow is the log-only `dispatch_capped`.
- **Idempotent.** The dispatch key plus the partial unique index make a second card impossible;
  both `done` and `canceled` release the key. Overlapping passes are wasteful, never
  duplicating — the state machine refuses the illegal second move.
- **Failure-isolated.** One action failing never stops the rest. A plan that outlived its
  snapshot (`ACCEPTANCE_*`, `ROLLUP_*`, `REVIEW_PENDING`) is *skipped* and re-planned, not
  counted as a failure; a repeated refusal is a standing alarm
  (`workflow_action_failed`), because it means the deployment's policy and the board's state
  disagree.

Alerts split into two channels: findings an operator can act on are notified, standing state
(no reviewer configured, a dispatch cap, a `human` card waiting for its person) is logged.
The ledger de-duplicates by state, so a standing condition does not re-notify every period.

## 6. Containers (`epic`)

An epic is a card whose job is to aggregate other cards. It is never claimed and never
`in_progress` by a claim; its `in_progress` is written by the board itself when its first child
starts (`epic_auto_start`). That one departure is why it needs the extra `todo → in_review`
edge: `todo` is its ready state, and without an exit there a container could never be
delivered.

The board also performs the container's delivery: when every child is terminal, at least one is
`done`, and there is evidence to roll up, `rollup.mjs` writes the rollup report and moves the
epic to `in_review`. Acceptance stays separate — the epic is reviewed like any other card and
closed only after an `APPROVE`, unless its mode is the explicit `off`.

The rules that make that safe:

- **A container is never claimed**, and the claim gate refuses one by kind, not by a role.
- **No parent closes over an open child** (`CHILDREN_OPEN`, domain and trigger).
- **A rollup is the only delivery evidence.** A missing current-round rollup is
  `ROLLUP_REQUIRED`; one that no longer matches the children is `ROLLUP_STALE`. A stale rollup
  blocks acceptance, not the board: repair is a rework, which starts a new round.
- **An empty epic cannot be delivered.** No children means no rollup; cancel it or give it
  work.
- **A rejected epic gets a fix child first**, so `reconcile` cannot re-close the container
  before the fix is worked.
- **A terminal container never rolls up.** The sweep scans non-terminal epics only; a card
  promoted to an epic after it was delivered will not close over children attached later.
  Start a new container instead.

## 7. Enforcement: layers and order

The same rules are enforced wherever a writer can enter:

| Layer | What it sees | What it guarantees |
|---|---|---|
| **domain** (`src/core/domain/`) | the intended move, the card, the actor | the whitelist, the round, the gate shape, the reason vocabulary |
| **use-cases** (`src/core/commands/`) | the board, the actor's declared kind | acceptance authority, review evidence, children, the snapshot, the audit |
| **storage** (`0001_init.sql` triggers + repositories) | rows, not actors or prose | the whitelist, the round bump, the evidence row, the marker, the baseline |

The triggers that carry the lifecycle:

| Trigger | Guarantee |
|---|---|
| `tr_tasks_transition` | the whitelist, including the epic overlay and the `off` direct edge |
| `tr_tasks_terminal` | a terminal card may leave only to `todo` |
| `tr_tasks_round_bump` | the two round-bumping families |
| `tr_deliver_gate` / `tr_deliver_gate_done` | current-round evidence for `in_review` / `off`-direct `done` |
| `tr_tasks_acceptance_agent_done` | `REVIEW_REQUIRED` on an `agent` card |
| `tr_tasks_children_terminal` | `CHILDREN_OPEN` |
| `tr_tasks_epic_rollup_done` | `ROLLUP_REQUIRED` |
| `tr_tasks_acceptance_mode_ins` / `tr_tasks_acceptance_mode_upd` | a review card is always `off` |
| `tr_tasks_review_marker_immutable` | `review_of_id` / `review_round` never change |
| `tr_tasks_review_not_review` | no review of a review |
| `tr_tasks_review_no_reopen` | a review card cannot be reopened |
| `tr_rel_review_no_parent` | a review card is neither parent nor child |
| `tr_tasks_acceptance_revision` / `tr_tasks_acceptance_prune_audited` | the baseline is append-only and every removal is audited |

The service layer runs its guards in a fixed order, so the error a caller sees is stable:

1. waiver shape → 2. the `awaiting`/`blocked` vocabulary → 3. the whitelist → 3a. the reopen
reason and the review-card refusal → 4. acceptance authority → 5. children terminal →
5a. acceptance coverage → 6. the claim gate → 7. the delivery gate → 8. review evidence →
9. the compare-and-swap (`VERSION_CONFLICT`).

The full refusal table, with the HTTP status of each code, is
[`status-lifecycle.md` §9](../skills/meerkat/references/status-lifecycle.md#9-refusals). The
point of the order is not the list but the property: the first refusal wins, so a caller gets
the same actionable answer for the same state every time.

## 8. Standing states

Not every non-terminal state is a finding. Some are designed and must be read as such; the
others are findings an operator can act on:

| State | Meaning |
|---|---|
| a current-round review is open | normal, in flight |
| the review is finished, an `agent` card is still `in_review` | the loop has not applied the verdict — a finding |
| the review is finished, a `human` card is still `in_review` | the designed wait for its person; recorded, not alerted |
| `awaiting`, with a question on the card | normal, in flight; the SLA row is the watcher |
| `in_review` with no effective reviewer | the deployment is unconfigured; `dispatch_skipped` names the project |
| a truncated board read | `undecidable` — "not in the snapshot" is not "gone" |

The SLA patrol keeps the review states watched: an open review card suppresses the original's
`acceptance_card_creation` row, a finished review turns it into an acceptance reminder, and a
canceled review leaves the standard action. A closed review must never be the original's only
watcher.

## 9. Decisions, alternatives and costs

- **D1 — `done` only through `in_review`, except an explicit `off`.** *Why:* "no delivery
  without review" is a property of the machine, not a habit; the `off` exception is an
  explicit opt-out, not a forgotten mode. *Cost:* an `epic` needed an overlay edge because its
  ready state is `todo`, and a trivial internal card must state `off` to skip review.
- **D2 — evidence is scoped to a round, not to a card.** *Why:* a rework means the previous
  conclusion is history; a card-level "has ever reported" gate would accept work the reviewer
  never saw. *Cost:* every consumer must be round-aware — dispatch, SLA suppression, review
  identity, crash recovery.
- **D3 — a review is a card.** *Why:* it is claimable and retryable, it records the verdict on
  the artefact the reviewer owns, and a crash between the verdict and the close is
  recoverable. *Cost:* a second claimable row per delivery, a two-hop cancel, and the
  no-parent/no-reopen/no-review-of-review constraints that keep its shape from drifting.
- **D4 — the board plans, the loop writes.** *Why:* one decision implementation cannot disagree
  with itself, and the write path stays where the host-local ledger and supervisor live.
  *Cost:* the loop must be running; without it `in_review` is a parking state.
- **D5 — the review card closes last.** *Why:* a half-applied outcome is re-planned from the
  original's state; the card is the only artefact that can carry the verdict forward. *Cost:*
  the "review done, original open" state exists and needs a watcher.
- **D6 — alert, never guess.** *Why:* a card closed on an unreadable verdict is not recoverable;
  a review card left open is. *Cost:* alerts and a liveness watch for the reviewer.
- **D7 — cancellation is not acceptance.** *Why:* `canceled` is legal from most stages, has no
  child guard and needs no evidence; allowing it to close a container would silently orphan
  work. *Cost:* abandoning a review takes two moves.
- **D8 — the mode selects the closer, not the review.** *Why:* a person choosing to close their
  own card must not lose the second pair of eyes. *Cost:* a `human` card legitimately waits in
  `in_review` with a finished review, and silence is the implemented behaviour.
- **D9 — the board never re-derives a container close.** *Why:* `rollup.mjs` is the single
  start/close predicate; a second copy in the planner would drift. *Cost:* the workflow pass
  can only classify what reconcile reported, never decide a new close itself.

Rejected alternatives:

- **Let the reviewer close the card.** It would make the reviewer both producer and acceptor,
  and leave no artefact to retry after a crash.
- **A `status=reviewing` stage.** It would double the state machine for a fact the marker
  columns already carry.
- **A `kind=review`.** Kinds are `task`/`epic`; a review is a task whose role is derived, which
  keeps every claim/heartbeat/report path shared.
- **Move the card in the same transaction as the verdict report.** The reviewer would need
  acceptance authority, and a crash would leave no review artefact.

## 10. Known limits

- **Acceptance attribution is declared, not proven.** The service check reads the actor's
  declared kind; loopback callers are trusted, `--actor-kind human` is reserved, but an agent
  that omits a kind writes as `human`. This is an authentication gap, not a missing rule — see
  [access.md](access.md).
- **The actor is not a column, so no trigger sees it.** `REVIEW_REQUIRED`, `CHILDREN_OPEN` and
  the round gates are database guarantees; acceptance authority is not.
- **A raw SQL reopen needs no reason.** The trigger allows `done|canceled → todo`; the reason
  is an audit rule in the service layer, like `--allow-steal`.
- **A round-agnostic review card (`review_round` NULL) suppresses every round.** That is the
  conservative reading for a row written before the column existed; the loop always writes the
  round.
- **An unreadable verdict over an already-`done` original is left for a human**, and so is a
  review card whose retry budget is exhausted. The loop raises an alert rather than inventing
  an outcome.
- **A transient SLA alert is possible.** In the tick that dispatches a review, the SLA pass may
  not yet see the card and can emit one `acceptance_card_creation`; the next tick suppresses
  it. The reverse ordering would delay every dispatch by a tick.
- **One agent kind per supervisor.** A reviewer on a different agent kind is not implemented;
  run a second supervisor with its own `--reviewer` (see [scheduling.md](scheduling.md)).
- **The reviewer's tool surface is adapter-dependent.** Claude and Pi apply a per-role
  allowlist; other adapters have no per-role tool surface, where the boundary is the prompt
  plus the board's authority and the loop's report-attribution check.

## 11. Where the rules live

| Question | Authority |
|---|---|
| What moves are legal? | `src/core/domain/status.mjs`; `tr_tasks_transition` |
| What does a round cover? | `bumpsDeliveryRound`; `tr_tasks_round_bump` |
| May this card be delivered? | `src/core/domain/delivery-gate.mjs`; `tr_deliver_gate` |
| Who may close it? | `src/core/domain/acceptance-mode.mjs`; `src/core/commands/acceptance.mjs`; [acceptance.md](acceptance.md) |
| Is this card a review? | `src/foundation/review-identity.mjs`; `review_of_id` / `review_round` |
| What happens after a delivery? | `src/core/domain/workflow.mjs` |
| Who performs the writes? | `src/orchestrator/runners.mjs` |
| When do the passes run? | [scheduling.md](scheduling.md) |
| What does the agent do? | [`status-lifecycle.md`](../skills/meerkat/references/status-lifecycle.md), [`review-workflow.md`](../skills/meerkat/references/review-workflow.md), [`cli.md`](../skills/meerkat/references/cli.md) |

## See also

- [`../GLOSSARY.md`](../GLOSSARY.md) — the canonical vocabulary: status, claim, delivery round,
  review card.
- [`../skills/meerkat/SKILL.md`](../skills/meerkat/SKILL.md) — the board rules an agent follows.
- [acceptance.md](acceptance.md) — who closes a card, and the two deliberate gaps.
- [scheduling.md](scheduling.md) — the clocks and passes that run this channel.
- [sla.md](sla.md) — the wait-time inspector and the acceptance row.
- [events.md](events.md) — the activity log, the revision cursor and the consumers.
