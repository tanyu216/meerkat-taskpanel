# Epic cards for this project

The board's epic mechanics — `kind=epic`, the rollup, promotion and the child guards — are
the `meerkat` skill's. This page is the **project-level splitting rule** the skill reads when
a creator is unsure whether the work is one card or a container. It is guidance, not board
data: nothing stores it and no card inherits it.

## When this project uses an epic

An epic is the container for **several deliverables that can each land alone**. Name the
**sum** of the work in the epic; name **one deliverable** in a child.

A single change is not an epic, however many layers it touches. The layers of one change —
core, CLI, web, docs and fixtures for the same outcome — are the card's **scope**, not
separate children.

## What makes a child

Every proposed child answers yes to all of these:

1. It can land on the base branch alone, without carrying a sibling's unmerged commit.
2. Landing it leaves the tree coherent: the suite is green and every surface it touches is
   updated in the same card.
3. A reader of the epic sees a result, not an internal step ("the CLI flag", "the docs").
4. It owes no cleanup card — no fixture sweep or documentation catch-up exists only to pay
   its debt.

A later child may build on an earlier child that is already on the base branch. A stack on
an unmerged sibling is not a child; it is the same deliverable.

## Who splits

Splitting is a scope decision the `meerkat-director` owns. A worker that finds several
deliverables writes an agent `question` comment describing the pieces, keeps the card
`in_progress`, and **holds** with `issue wait`. It does not create the children itself.

An explicit instruction from the human wins over this page. If this page is absent or says
nothing about the piece in front of you, the `meerkat` skill's epic rules are the whole
answer.
