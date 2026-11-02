# Splitting and building an epic

This page is complete for splitting a card into an epic or adding children; do not read the
other scenario pages. When the card is already a leaf child, use `execute.md`.

## When this applies

An epic exists only where someone named one. Splitting is a scope decision: it belongs to the
`meerkat-director` (an out-of-scope expansion to the human, `E1`), so a worker that finds
several deliverables writes an agent `question` comment describing the pieces, keeps the card
`in_progress`, and **holds** with `issue wait`. A title and description naming the **sum** of
the work is the container; naming **one deliverable** makes it a child.

When the split is yours to make, read the project's epic sizing guidance at
`<project-dir>/docs/agents/epic-cards.md` when it exists; absent, use the questions below.

## A child is a deliverable, not a layer

Ask four questions of every proposed child:

1. **Can it land on the base branch alone?** Its branch merges without carrying a sibling's
   unmerged commit.
2. **Does landing it leave the tree coherent?** Every surface it touches — core, CLI, web, docs and fixtures — is updated in the same card, and the suite is green.
3. **Is the outcome visible?** A reader of the epic sees a result, not "the CLI flag" or
   "the docs".
4. **Does it owe a cleanup card?** No fixture sweep or documentation catch-up exists only to
   pay its debt.

A later child may build on an earlier child already on the base branch; a stack on an
unmerged sibling is not. The layers of one change are its **scope**: enforcing the 1-4 character project prefix on every create path is one child, not five. The role routing
table's "one card per shape" sizes a **role** handoff, not a technical layer.

| Card you have | Role | What to do |
|---|---|---|
| already an `epic` | — | add children; never convert it |
| `task`, no parent | the whole job | promote in place (below) |
| `task`, no parent | one deliverable among several | create a new `--kind epic` container; link it and the new children |
| `task`, with a parent | the whole job | promote to a nested epic; its parent edge stays |
| `task`, with a parent | one deliverable among several | keep it as a child; add siblings under the same parent |
| `in_review`, `done`, `canceled` or archived | — | do **not** promote; create a new container and link the old card |
| a review card | — | do **not** promote; split a separate container |

## Promote before delivery

Promote before the card delivers its current-round report. The rollup collects the
**children's** delivery reports, not the container's own history, so promoting a card that
already delivered strands every child attached after it; start a *new* container instead.

```bash
taskctl issue update <ref> --kind epic       # the card keeps its status
taskctl comment add <ref> --kind note --body "split into N cards: …"
taskctl issue create --project <p> --title "…" [--assignee <role>] --target <t> --acceptance "…"
taskctl relation add <ref> --type parent --target <child>     # <ref> is the parent
```

## The rollup

An epic's acceptance is its children; its delivery is a rollup of their reports. The board
starts the container when a child enters work and closes it to `in_review` (never `done`)
when the tree is finished — but a `backlog` or `awaiting` epic does not auto-start, and an
`in_review` epic that gains a child must move back to `in_progress` to roll up again. An
all-canceled tree is not a delivery — cancel the container instead. Attempt the close; the
refusal names anything still open.

Three rules that fail **silently**:

- **Each child needs its own `--target`.** The create guard keys on kind + assignee + source +
  target; two children for one owner with nothing to tell them apart are the *same card*. Use
  `--allow-dup` when a target does not apply.
- **`issue create --parent <epic>` links nothing** — only `relation add --type parent` does.
- **A child attached after the rollup makes it stale**; rework the epic to start a new round.

Claim exactly **one** leaf child; the container holds no work of its own.

<!-- read-next:begin -->
- [`../lifecycle/containers.md#6-containers-epic`](../lifecycle/containers.md#6-containers-epic)
<!-- read-next:end -->
