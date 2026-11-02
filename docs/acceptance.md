# The acceptance model: who closes a card

This page is the **design** of the board's acceptance model, not a procedure. It answers one
question — once a card is delivered, who is allowed to move it to `done` — and records the
invariants that make that answer enforceable at every layer.

Two decisions are deliberately separate:

- **Review is independent of acceptance.** Every card except an explicit `off` is sent to an
  independent reviewer; a person's intention to close the card themselves never skips the
  review.
- **Acceptance is the closer.** The card's *acceptance mode* is a single word that names who may
  perform the `done` move: the loop after a current-round `APPROVE`, or a person.

The states, the delivery round and the review card this move closes are
[lifecycle.md](lifecycle.md)'s subject.

`done` is the board's acceptance act. `canceled` is abandonment, never an acceptance: it is
legal from most stages and has no child guard, so treating it as "closing" a card silently
orphans the work.

## Vocabulary: one card, one word

- `tasks.acceptance_mode` — `off | auto | human`, chosen by the card's creator and frozen at
  creation.
- There is **no project-level acceptance default**. A project supplies a reviewer, never a
  mode; a card that omits the field resolves to `auto`.
- A project may document how its creators choose between the three words in
  `docs/acceptance-mode.md` under the project's working directory. The `meerkat` skill discovers
  that file when it creates a card. It is guidance for the creator, not board data: it is not
  stored, inherited or read by `taskd`. This repository's own guidance is
  [acceptance-mode.md](acceptance-mode.md).

## Resolution at creation

A card's mode is decided once, in this order:

1. a **review card is always `off`** — a review is never reviewed again;
2. an explicit mode on the card wins;
3. an unresolved card — task or epic — falls back to **`auto`**.

**The fallback is `auto`**, for every kind: an unresolved card is reviewed, and the loop applies
the verdict. `off` and `human` are explicit opt-outs or hand-offs.

The snapshot is not re-derived later. An agent may only **tighten** it (`off → auto|human`); a
person may set any value. There is no parent/depth restriction: any card, at any depth, may be
`human`, `auto` or `off`.

## The three modes

<!-- acceptance-matrix:begin -->
| Card mode | Review card | Who may move it to `done` |
|---|---|---|
| `off` | none | the deliverer (any actor kind), or a human; `in_progress → done` is allowed |
| `auto` | yes — an agent reviewer | the loop after a current-round `APPROVE`; anyone but the reviewer; a human may always |
| `human` | yes — an agent reviewer | a human only, after the current-round review is finished |
| a review card | — | a human, or any actor but its reviewer — never the one who wrote the verdict |
<!-- acceptance-matrix:end -->

In agent terms:

- **`off`** — trust mode. No review; the deliverer may close, and a delivery may go straight to
  `done` without passing through `in_review`. An `off` card delivered to `in_review` is
  auto-accepted by the loop.
- **`auto`** — the reviewer's current-round `APPROVE` is the authority. The loop applies it
  (moves the card to `done`, then closes the review card), and any actor **except the one who
  wrote the verdict** may apply it too; a human may close instead, on the same evidence. The
  kind is not an allow-list: declaring `system` buys no right to accept.
- **`human`** — the review still runs. On `APPROVE` the loop records the verdict for that round,
  comments it, closes the review card, and leaves the original in `in_review`; the person then
  closes it. The person cannot close before that finished review: an open review is
  `REVIEW_PENDING`, and a missing APPROVE is `REVIEW_REQUIRED`. A person may still close an
  `auto` card as a fallback once its current-round APPROVE exists.

## Review is independent of the mode

- **Dispatch.** An ordinary card in `in_review` whose mode is not `off` gets one review card per
  delivery round. There is no kind filter: an epic is dispatched in the same pass that rolls it
  up, and its reviewer reads the children and the rollup.
- **The reviewer moves nothing.** It reads the original, the report, the trail (and the
  children, for an epic) and delivers exactly one `VERDICT: APPROVE` or `VERDICT: REJECT` on the
  review card.
- **The loop applies the verdict** and closes the review card last, so an interrupted pass is
  recovered on the next one. `REJECT` puts the card back on the rework path and appends the
  reviewer's numbered must-fix items to the frozen acceptance.
- **`off` is the one mode with no review.** The loop auto-accepts it; a `human` card never
  reaches auto-accept.

## Standing states

| State | Meaning |
|---|---|
| a current-round review is open | normal, in flight |
| the review is finished, an `auto` card is still `in_review` | the loop has not applied the verdict — a finding |
| the review is finished, a `human` card is still `in_review` | the designed wait for its person, recorded and not alerted |

The SLA patrol keeps the last state as an acceptance reminder: a finished review does not
silence the card's only watcher.

## Enforcement: three layers

The mode is enforced at three layers, so a raw writer cannot bypass it:

- **Domain.** The writer is checked against the mode and against the current-round verdict's
  author: a violation is `ACCEPTANCE_FORBIDDEN`.
- **Storage.** Storage-level invariants force a review card to `off` and constrain the close
  paths: an `auto` card needs a current-round review card that has been entered or finished, and
  a `human` card needs it **finished**. The application layer is never the only guard.
- **Gates.** A reviewed card owes a current-round `APPROVE` (`REVIEW_REQUIRED`). A human closing
  a `human` card while its review is still open is `REVIEW_PENDING`. An `APPROVE` must cover the
  frozen acceptance, point each `met` at an evidence anchor, and record a command the reviewer
  ran; `ACCEPTANCE_INCOMPLETE` names what is missing. Because a person can only close after the
  review, the reviewer is also refused when it tries to APPROVE a delivery the close gate could
  never accept.

## Known limits

- The actor's kind is **declared**, not authenticated. A loopback caller is trusted and
  `--actor-kind human` is refused, but the board has no cryptographic identity; an agent that
  omits `--actor-kind` writes as `human` by default.
- The actor check is a service-layer invariant, not a trigger: the actor is not a `tasks`
  column, so no trigger can see it. The storage trigger checks the review's existence/state;
  the verdict's content and the acceptance coverage are checked in the service layer.
