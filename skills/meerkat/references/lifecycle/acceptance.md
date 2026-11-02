# Acceptance: one mode per card

> Section 7. The delivery gate is `delivery.md`; the review protocol is `../review-workflow.md`.

## 7. Acceptance: one mode per card

`done` is the board's acceptance act, and the card's own `acceptance_mode` names who may
perform it. There is no board-level policy, no project default and no scope matrix: a card at
any depth is closed by whoever its own mode names, and a review card is the one structural
exception. The mode is the **closer** selector, not a review selector — an `auto` and a
`human` card are both reviewed; only `off` skips the review.

<!-- acceptance-matrix:begin -->
| Card mode | Review card | Who may move it to `done` |
|---|---|---|
| `off` | none | the deliverer (any actor kind), or a human; `in_progress → done` is allowed |
| `auto` | yes — an agent reviewer | the loop after a current-round `APPROVE`; anyone but the reviewer; a human may always |
| `human` | yes — an agent reviewer | a human only, after the current-round review is finished |
| a review card | — | a human, or any actor but its reviewer — never the one who wrote the verdict |
<!-- acceptance-matrix:end -->

The creator states the mode at creation; an explicit `--acceptance-mode` is the whole
decision. An unresolved card — task or epic — falls back to `auto`: review is the default,
and `human` is opt-in. A project may document how its creators choose in
`docs/agents/acceptance-mode.md` under its working directory; the `meerkat` skill discovers that file
when it creates a card. It is guidance for the creator, not board data — not stored, not
inherited, not read by `taskd`. The structural rules:

- a review card is always `off`;
- there is no parent/depth restriction: any card, at any depth, may be `human`, `auto` or
  `off`;
- an epic is a card like any other: it is dispatched a review card (against its children and
  rollup) and closed only after an `APPROVE`; `off` remains the one explicit skip.

- A worker agent delivers an `auto`, `human` or review card to `in_review`; a card whose mode
  is `off` may also go **straight to `done`** (`issue deliver --report-file - --to done`).
- A worker must not close its own work. The board's authority is evidence-based: `auto` admits
  any actor except the verdict's author (and a human always); `human` admits only a human.
  `details` carry `mode` and `reviewCard`, never a policy or scope.
- A `human` card cannot be closed before its current-round review is finished:
  `REVIEW_PENDING` while the review card is open, and `REVIEW_REQUIRED` without an `APPROVE`.
  A human may also close an `auto` card as a fallback once its current-round `APPROVE` exists.
- `--actor-kind human` is reserved; a human write uses `--as-human` — in a conversation with
  the human, or when the instruction explicitly came from them (see the board skill's create
  section).
- The mode is board data, readable on the card (`acceptance_mode`); there is **no project
  field and no `taskctl` command that reads a policy**. Attempt the move and handle
  `ACCEPTANCE_FORBIDDEN`.
- Changing the mode is the audited `issue update <ref> --acceptance-mode <value> --reason
  "<why>"`: an agent may only tighten (`off → auto|human`), and leaving `auto` needs no open
  current-round review card.
