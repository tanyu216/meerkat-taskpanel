# The review workflow — flow A, flow B, and the verdict contract

> One delivery, one independent review, one verdict. `status-lifecycle.md` is the state
> model; `cli.md` is the command surface. This page is the agent-facing contract: what a
> review card is, how to recognise one, what a reviewer writes, and who may close what.

## 1. Two flows

| Flow | What it is | Who writes the marker |
|---|---|---|
| **A** | An ordinary work card awaiting a delivery verdict. | Nobody — `meta.flow` is absent, and absent means A. |
| **B** | A review card that carries a `VERDICT:` report for a flow-A card. | The loop, when it dispatches: `meta.flow=B`. |

- A flow-A card that reaches `in_review` is dispatched to the configured reviewer as a
  review card **unless its `acceptance_mode` is `off`** — review is mode-independent, so
  `agent` and `human` are dispatched exactly the same way. The mode decides only **who
  closes the original**: the loop for `agent`, a person for `human`. There is no kind filter:
  an **epic** is dispatched on the same terms, and its reviewer reads the child cards and the
  rollup report. The mode is resolved at creation (an explicit `--acceptance-mode` wins, else
  the project's `acceptance` default, else `agent`) and is never re-derived later.
- A flow-B card is **never dispatched for review again**. A delivery on a review card is the
  end of the chain, not a new review target.
- `meta.flow` is a loop convention, not the review-card predicate: an absent value is A
  (fail-safe — an unknown card is not exempted from review), and detection reads the
  structural marker below.

## 2. The review card's identity

A review card is an ordinary `kind=task` card. Its identity is two **immutable columns**:

| Column | Meaning |
|---|---|
| `review_of_id` | The internal id of the card it audits. |
| `review_round` | The original's `delivery_round` this review audits. |

A review card is always `acceptance_mode = off`: it is flow B and is never reviewed again.
The creation resolver forces it, and the domain refuses a review card that asks for its own
review.

The structural columns are the **authority**: every reader resolves the original's identifier
from `review_of_id` (falling back to `meta.review_of` only for a legacy row) and the audited
round from `review_round`. The board still mirrors both into `meta.review_of` /
`meta.review_round` for export and readability, but the mirror is **not** a policy input; nor
is `meta.flow`.
The `review` label is a discovery aid; it is **never** the predicate. A card is a review card
when `issue get <ref> --json` carries `review_of_id` (or, for a legacy row, `meta.review_of`),
and the envelope also carries the resolved `review_of` identifier for display. Its derived
`role` is the readable word — `task`, `epic`, or `review` — while `kind` stays `task`; ask
`role`, not `kind`, when deciding what a card is for. `issue list --kind review` (and
`GET /tasks?kind=review`) is a **filter over the marker**, not a third kind: `--kind task`
still returns review cards, and `issue create --kind review` is refused.

### Two rounds, deliberately different

- `review_round` — the **original's** round being audited.
- the review card's own `delivery_round` — the round its own report is stamped with. A fresh
  review card starts at `1`, even when it audits the original's round 3.

A re-delivery after a rejection is a **new round of the original**, so it needs a **new review
card**. One review card covers one `(original, delivery round)` pair; the loop's idempotency
key is `loop-review|<original-ref>|r<round>`.

## 3. The reviewer's protocol

### Step 0 — the review is still valid

```bash
taskctl issue get <original> --json --actor-kind <kind> --agent <reviewer>
```

If the original is no longer `in_review`, or its `delivery_round` is not the round recorded
on the review card:

1. leave a `note` comment on the review card saying so;
2. stop. Do **not** deliver a verdict, and never move either card.

What the loop does next depends on why the target moved:

- **The original was canceled** — the loop cancels the review card (`cancel_review`).
- **The original is on a later round** — the verdict is history; the loop closes the review
  card (`round_mismatch`) without touching the original.
- **The original is `done` at the same round** — the loop raises `verdict_unreadable` and
  leaves the review card open. A human must cancel it with the two-hop
  `in_review → in_progress → canceled`.
- **The verdict cannot be read, or an `APPROVE` does not cover its baseline** — the loop
  re-dispatches the review card for a second review (`meta.review_retry`, at most two
  reopens). A reopen is the two-hop `in_review → in_progress → todo`; the card is claimed
  again and reviewed from scratch. When the bound is reached the loop raises
  `review_retries_exhausted` and leaves the card for a human. A done original is not
  reopened: there is nothing left to review.

### Read

- the original's description and every acceptance item — the **frozen snapshot** (`acceptance`
  in `issue get --json`); `meta.acceptance` / `meta.acceptance_legacy` only fill in for a
  grandfathered card whose snapshot was never seeded;
- `.meerkat/<original>/card.md` (the authoritative brief) and `.meerkat/<original>/plan.md`
  (the worker's plan, if it exists), plus the notes, evidence, report drafts and attachments
  in that directory;
- the current round's delivery report and its evidence anchors;
- the comment trail, looking for unresolved decision / defect entries;
- for an epic: the rollup report and each child's state.

An `APPROVE` is checked against **two** baselines before it can close anything: the review
report must cover every item of the original's snapshot and of the review card's own snapshot
(the original's list plus the generic review items). A `REJECT` is never checked for coverage
— `partial` / `not_met` is its normal shape. If the baseline itself is wrong, rework the
original (a new round re-freezes it); a reviewer cannot edit it. The pass/fail rules for an
item, and the omission check's `meta.acceptance_derived` flag, are in
[`status-lifecycle.md` §4a](status-lifecycle.md#4a-the-acceptance-baseline).

For an **epic**, the rollup is the delivery. An `APPROVE` additionally needs the epic's
current-round rollup (`is_rollup = 1`) to still match its children; a missing rollup is
`rollup_unverified`, a stale one is `rollup_stale` (both are log-only alerts — the loop plans
no approval). The repair is a rework of the epic, which starts a new round and a fresh
rollup. The rollup's own shape is in
[`status-lifecycle.md` §6](status-lifecycle.md#6-containers-epic).

The omission check is unconditional: every requirement in the description, comments and plan
must map to an acceptance item and to evidence, or be explicitly deferred with a recorded
decision. A narrowed acceptance list, an unexplained deviation from `plan.md`, or a missing
requirement is grounds for `VERDICT: REJECT`. If `plan.md` does not exist, say so and fall back
to the description and acceptance snapshot; absence alone is not a reject. For an epic, check
that the children cover the epic's description and that no child is omitted from the rollup.

### What an APPROVE must contain

The board checks an APPROVE against the original's snapshot and the review card's own
baseline. It also refuses one it cannot check:

- **the ledger** — every requirement in the description, comments, `plan.md` and the handoff
  mapped to an acceptance item *and* an implementation (`path:line`, a test, a visible
  behaviour); an uncovered row is a `VERDICT: REJECT`, not a note;
- **the delivered sha** — the report names the `commit` it verified, and every `path` anchor
  exists at that sha (`git show <sha>:<path>`); a claim visible only in the live working tree
  is unverified (another lane may be writing there), and a `path` anchor absent at the sha is
  a fabricated anchor;
- **an anchor per claim** — each `met` cites `evidence[n]` from the review report's own
  `evidence[]`. A `met` with no reference (`no_anchor`) or one that points past the list
  (`dangling_anchor`) is `ACCEPTANCE_INCOMPLETE`. The report must also carry at least one
  `command` anchor, because the reviewer runs the declared gate itself
  (`details.reason = "no_command_evidence"`);
- **the earlier findings** — every item the baseline carries from an earlier round is
  resolved with its evidence or explicitly deferred; a silent drop is a `REJECT`;
- **the gate** — the project's `meta.review_gate` command, its exit code and the coverage it
  reports, or `n/a — none declared` with the targeted checks named.

A `met` that cannot be reproduced is `not_met`; `partial` never softens a requirement that
was not implemented. These are the same rules the role assets state
(`skills/setup-meerkat/assets/team/standard/reviewer/`), and the loop mirrors them before it
plans an `approve` (`verdict_unsupported`, then the bounded `reopen_review`).

### Deliver

Write the verdict **on the review card**, not on the original:

```bash
taskctl report template <review-ref>
taskctl issue deliver <review-ref> --report-file - <attribution flags>
```

The report's `conclusion` must have **`VERDICT: APPROVE`** or **`VERDICT: REJECT`** as its
**first line**. Everything after that line is carried into the rework comment, together with
the report's `leftovers` — this is where the reviewer writes its findings once.

### Do not move

- Do not claim or heartbeat the original.
- Do not move the original.
- Do not move the review card. The loop applies the verdict and closes the review card.

The board parses the verdict and the loop performs the writes. A reviewer that moves a card
is racing the acceptor.

## 4. Acceptance mode

The card's own `acceptance_mode` is the whole rule; there is no policy and no scope. It
selects the closer, not the review: `agent` and `human` both produce a review card, and only
`off` does not. The reviewer for a dispatched card is
`project.reviewer ?? the deployment reviewer` (the loop's `--reviewer` /
`MEERKAT_TASKPANEL_REVIEWER` / per-kind config), and the review card's assignee records the one
actually used.

**The fallback is `agent`.** An unresolved card — task or epic — is reviewed; `human` appears
only when explicitly set, and `off` only when explicitly set. **`human` is top-level only**: a
card with a parent is never human-accepted, because the mode is a closure gate a person
exercises on a card they own, not on a subtask (a subtask's decision is an `awaiting`
question). The invariant is enforced at the parent edge (attaching a parent to a `human` card
is refused, `--force` included) and at
`issue update --acceptance-mode human` (refused on a card that already has a parent). A
project-level `human` is a top-level default: a child that names no mode under it resolves to
`agent`.

`done` is the board's acceptance act, and the mode decides who may perform it:

<!-- acceptance-matrix:begin -->
| Card mode | Review card | Who may move it to `done` |
|---|---|---|
| `off` | none | the deliverer (any actor kind), `taskd`, or a human; `in_progress → done` is allowed |
| `agent` | yes — an agent reviewer | `taskd` (after a current-round `APPROVE`) or a human |
| `human` | yes — an agent reviewer | a human only |
| a review card | — | a human or `taskd` — never the reviewer itself |
<!-- acceptance-matrix:end -->

In agent terms: on an `agent` card the loop applies a current-round `APPROVE` and closes
both cards; a human may close either. On an `off` card nobody has to review it — the
deliverer may close it, or deliver straight to `done`. A `human` card is reviewed like an
`agent` one: the loop records the round-scoped verdict and closes the review card, and only
a person closes the original. A reviewer never closes the card it reviewed.

The board enforces the mode; `ACCEPTANCE_FORBIDDEN` carries `mode` and `reviewCard` in its
`details`. What the matrix means for the loop is in
[`status-lifecycle.md` §7](status-lifecycle.md#7-acceptance-one-mode-per-card).

## 5. The human's side

- **`REVIEW_PENDING`** — a human closing an **`agent`** card while a **current-round** review
  card is still open. Let the review finish (or cancel an abandoned review card) first.
- **An `agent` card after `APPROVE`** — the loop accepts it; a human may also close it. A
  `human` card is never auto-accepted, whatever the loop records: its review runs like any
  other, the verdict is recorded, and the close is the person's.
- **Cancel an abandoned review card** — a review card in `in_review` cannot go directly to
  `canceled`; the move is two hops: `in_review → in_progress → canceled`.
- **Reopen the original, never the review card.** A review card is a loop artefact and cannot
  be reopened; reopening the original produces the next round's review.

## 6. What happens after a delivery

```text
worker delivers            original in_review (round N)
board dispatches           review card created, review_round = N
reviewer wakes             claims the review card, reads, delivers VERDICT
loop applies               APPROVE → accept (agent) / record (human); REJECT → rework round N+1
loop closes last           review card → done (or canceled if the original was canceled)
```

When the card's `acceptance_mode` is `off`, steps 2–5 do not run. The board's plan emits
`auto_accept` instead; the loop writes `meta.accepted_by=loop-auto` and moves the original
`in_review → done`. A `human` card never reaches auto-accept at all — its mode is not `off`,
so it follows the review path and only the final close is the person's; nothing is alerted
for that state, because silence is the implemented behaviour. An `off` card may also skip
`in_review` entirely: `issue deliver --to done`.

- **APPROVE** — on an `agent` card the loop writes `meta.accepted_by=loop-review` and moves
  the original `in_review → done`, then closes the review card. On a `human` card the loop
  writes `meta.review_verdict=approve` with `meta.review_verdict_round`, comments the
  verdict, closes the review card, and leaves the original in `in_review`; the person then
  closes it through the ordinary acceptance gate.
- **REJECT on a work card** — the loop comments the findings, writes `meta.rework_round`,
  moves the original `in_review → in_progress`, appends the reviewer's numbered must-fix
  items to the original's frozen acceptance, and moves it to `todo`. It is re-claimed and
  re-delivered on the new round; the next round's report template and the next review card
  both carry those items, so a finding cannot be dropped silently. A REJECT with no numbered
  list still appends one pointer item, so the next round owes an answer either way.
- **REJECT on an epic** — the loop creates and links a **fix child** first, then reopens the
  container to `in_progress`; the open child stops `reconcile` from re-closing the container.

Failure isolation is the loop's: one action failing never stops the rest, and the review card
is closed last, so a crash between the original's move and the card's close is recovered on
the next pass.

## 7. Review-side refusals

A review card can be refused by the same codes as any other card — `REPORT_REQUIRED`,
`REPORT_ROUND_MISMATCH`, `ACCEPTANCE_FORBIDDEN`, `REVIEW_PENDING`, `REVIEW_REQUIRED`,
`REVIEW_CARD_MARKER_INVALID`, `VALIDATION_FAILED` — plus `INVALID_TRANSITION` for a reopen or
a direct `in_review → canceled`. The reopen, parent/child and review-of-review refusals are
also database triggers, so a raw writer cannot bypass the command layer. The full
table, with when each fires, is in
[`status-lifecycle.md` §9](status-lifecycle.md#9-refusals).

## 8. Boundaries

- A review card is an ordinary card of kind `task`: it is claimable, heartbeat-able, and delivered like any
  other card. It is special only in what its report must contain and in who may close it.
- Do not promote a review card to an epic, and do not derive an acceptance list on one.
- A `parent` edge is refused when either end is a review card (`VALIDATION_FAILED`,
  `details.field = source|target`, `details.type = parent`), even with `--force`. Attach the
  edge to the original work card instead. Existing edges are not repaired; raw repository
  writes remain a bypass.
- The original must be `in_review` at review-card creation (`VALIDATION_FAILED` otherwise).
  Deliver first: `taskctl issue deliver <original> --report-file -`; then create the review
  card for the original's current round. The reviewer's Step 0 still guards a target that
  moved between dispatch and wake.
