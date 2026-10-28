# Acceptance: who closes a card

`done` is the board's acceptance act. A card's **acceptance mode** is the one word that decides
who may perform it. It does **not** decide whether the card is reviewed: every card except an
explicit `off` is sent to an independent reviewer, and the mode only selects the **closer** —
the loop for `agent`, a person for `human`.

Two layers, one word:

- `projects.acceptance` — `auto | off | agent | human`, the default a new card inherits.
  `auto` means "the creator decides per card"; it is never stored on a card.
- `tasks.acceptance_mode` — `off | agent | human`, the resolved snapshot, frozen at creation.

## Resolution at creation

A card's mode is decided once, in this order:

1. a **review card is always `off`** — a review is never reviewed again;
2. an explicit mode on the card wins — except `human` on a card that declares a parent, which
   is refused;
3. a concrete project value is the default — except `human`, which is a **top-level-only**
   default: a child that names no mode falls through;
4. project `auto`, no project, or a project-level `human` on a child → **`agent`**.

**The fallback is `agent`**, for every kind: an unresolved card is reviewed. It used to be
`human` (and `off` for an epic), which left the container — the one card whose job is to
aggregate the others — as the only card nobody audited.

The snapshot is not re-derived later. An agent may only **tighten** it (`off → agent|human`);
a person may set any value. `human` is refused on a card that already has a parent, whichever
writer asks, and the parent edge onto a `human` card is refused too.

## The three modes

<!-- acceptance-matrix:begin -->
| Card mode | Review card | Who may move it to `done` |
|---|---|---|
| `off` | none | the deliverer (any actor kind), `taskd`, or a human; `in_progress → done` is allowed |
| `agent` | yes — an agent reviewer | `taskd` (after a current-round `APPROVE`) or a human |
| `human` | yes — an agent reviewer | a human only |
| a review card | — | a human or `taskd` — never the reviewer itself |
<!-- acceptance-matrix:end -->

In agent terms:

- **`off`** — trust mode. No review; the deliverer may close, and a delivery may go straight to
  `done` without passing through `in_review`.
- **`agent`** — the loop applies a current-round `APPROVE`: it records the loop as the
  acceptor, moves the card to `done`, then closes the review card. A human may close instead,
  on the review's evidence.
- **`human`** — the review still runs. On `APPROVE` the loop records the verdict for that
  round, comments it, closes the review card, and leaves the original in `in_review`; the
  person then closes it through the ordinary acceptance gate. Opt-in only, and top-level only.

## Review is independent of the mode

- **Dispatch.** An ordinary card in `in_review` whose mode is not `off` gets one review card
  per delivery round. There is no kind filter: an epic is dispatched in the same pass that
  rolls it up, and its reviewer reads the children and the rollup.
- **The reviewer moves nothing.** It reads the original, the report, the trail (and the
  children, for an epic) and delivers exactly one `VERDICT: APPROVE` or `VERDICT: REJECT` on
  the review card.
- **The loop applies the verdict** and closes the review card last, so an interrupted pass is
  recovered on the next one. `REJECT` puts the card back on the rework path and appends the
  reviewer's numbered must-fix items to the frozen acceptance.
- **`off` is the one mode with no review.** The loop auto-accepts it; a `human` card never
  reaches auto-accept.

## Standing states

| State | Meaning |
|---|---|
| a current-round review is open | normal, in flight |
| the review is finished, an `agent` card is still `in_review` | the loop has not applied the verdict — a finding |
| the review is finished, a `human` card is still `in_review` | the designed wait for its person, recorded and not alerted |

The SLA patrol keeps the last state as an acceptance reminder: a finished review does not
silence the card's only watcher.

## Enforcement

The mode is enforced at three layers, so a raw writer cannot bypass it:

- **Domain.** The actor kind is checked against the mode: a violation is `ACCEPTANCE_FORBIDDEN`.
  A `human` close on a child, or a parent edge onto a `human` card, is `VALIDATION_FAILED`.
- **Storage.** Storage-level invariants force a review card to `off` and constrain the close
  paths, so the application layer is never the only guard.
- **Gates.** An `agent` card owes a current-round `APPROVE` (`REVIEW_REQUIRED`). A human
  closing an `agent` card while its review is still open is `REVIEW_PENDING`. An `APPROVE`
  must cover the frozen acceptance, point each `met` at an evidence anchor, and record a
  command the reviewer ran; `ACCEPTANCE_INCOMPLETE` names what is missing.

## What the board does not enforce

- **A person may close a `human` card while its review is still open.** The recorded verdict is
  what the design expects them to close on, but the board does not make them wait for it.
- **A project-level `human` with no reviewer is not refused at start.** A project whose default
  is `agent` cannot start without an effective reviewer; for `human` the board reports the
  missing reviewer per card, and the person can still close.
