# Card acceptance mode for this project

The board's three card modes and their guarantees are in [acceptance.md](../acceptance.md).
This page is the **project-level selection guidance** the `meerkat` skill reads when it
creates a card in this repository. It is not board data: nothing stores it, no card inherits
it, and `taskd` never reads it.

## The words

- **`off`** — no review. The deliverer (or a human) closes the card, and a delivery may go
  straight from `in_progress` to `done`.
- **`auto`** — an independent review, then the loop closes the card on a current-round
  `APPROVE`. This is the default when the creator states nothing.
- **`human`** — an independent review, then a person closes the card after that review
  finishes.

## Choosing for a card

State the mode explicitly when the card's context calls for `off` or `human`: they are
opt-outs from the default review-and-loop-close path. An explicit instruction from the human
wins over this page. When the card's context does not call for either, leave the mode to its
`auto` fallback.

Do not add project-specific acceptance criteria anywhere else — not to a project row, a
configuration key, or a second local convention. If this project needs a rule, write it here
and keep it to the three words above.
