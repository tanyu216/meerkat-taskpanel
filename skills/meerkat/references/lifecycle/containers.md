# Containers (`epic`)

> Section 6. Claims are `claims.md`; acceptance is `acceptance.md`.

## 6. Containers (`epic`)

- **Sizing is not schema-enforced.** The board enforces shape — children, depth — not whether
  a child is a deliverable. A child must land on the base branch alone and leave the tree
  coherent; one change's core, CLI, web, docs and fixtures are its scope, not five children.
  The four questions are in
  [`../scenarios/epic.md` §A child is a deliverable, not a layer](../scenarios/epic.md#a-child-is-a-deliverable-not-a-layer).
- **Never claimable.** `issue move <epic> in_progress` is `not_claimable`.
- **The board starts it.** The first child to enter the work moves the container
  `todo → in_progress` (actor kind `system`, no claim), with an `epic_auto_start` activity and
  a `kind=note` comment naming the child. A `backlog` epic is not auto-started.
- **The board closes it to `in_review`, never `done`.** When every child is terminal, at least
  one is `done`, and there is evidence to roll up, it writes the **rollup report**
  (`is_rollup = 1`) and moves the epic. Auto-close works from `todo`, `in_progress` and
  `blocked`; acceptance stays separate.
- **An epic is reviewed like any other card.** Its default mode is `auto`, so the workflow
  pass dispatches a review card for it in the same tick that rolls it up (the reconcile runs
  before the snapshot). The reviewer reads the children and the rollup; `APPROVE` closes the
  container (both cards), `REJECT` creates a fix child and reworks the container. An explicit
  `off` epic skips the review and is auto-accepted by the loop.
- **An epic's delivery is a rollup, always.** A report written on an epic is marked as its
  rollup; a `--no-report` waiver cannot deliver a container. The rollup must name **every
  live child** by `ref`: a `done` child is `met`, a `canceled` child is `not_applicable` with
  the reason it was acceptable, and at least one child must be `done`. A mismatch is
  `ROLLUP_STALE`; a missing current-round rollup is `ROLLUP_REQUIRED`.
- **An empty epic cannot be delivered.** No children means no rollup; cancel it or give it
  work.
- **Nothing delivered, nothing to close.** Close by hand with a rollup: `report template
  <epic>` lists the children, then `issue deliver <epic> --report-file -`.
- **The epic's own `acceptance` snapshot is informational for the delivery/done gate.**
  `done` on an epic checks the current-round rollup, not the container's `acceptance_json`.
  The review-verdict gate (`assertReviewEvidence`) does enforce it: an `APPROVE` on a review
  of the epic must cover the epic's frozen `acceptance` plus the review card's own baseline.
- **A stale rollup blocks acceptance, not the board.** `issue reconcile` reports an
  `in_review` epic whose rollup no longer matches its children (`rollup_stale`) without
  moving it. Repair it by reworking the epic (`in_review → in_progress`, which starts a new
  round); the sweep then writes a fresh rollup.
- **`todo → in_review` is the epic-only repair edge** for a child attached after the container
  finished; it still passes the delivery gate.
- **No parent closes over an open child.** `CHILDREN_OPEN` guards both `in_review` and `done`.
- **Evidence is the children's, not the container's.** The rollup reads each child's latest
  delivery report; the container's own earlier reports prove nothing, and a child delivered
  under `--no-report` contributes no anchor. With no child evidence the container stays open.
- **A terminal container never rolls up.** The sweep scans non-terminal epics only, so a
  `done`/`canceled` card promoted to an epic will never close over children attached later.
  A delivered card starts a new container instead.
- **Status at promotion.** A `backlog` or `awaiting` epic needs a move to `todo` first, and
  an `in_review` epic that gains a child needs a rework back to `in_progress`.

`issue reconcile` replays the start/close rules over every non-terminal epic and is
idempotent; the ordinary path does not need it.
