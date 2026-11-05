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
`<project-dir>/docs/agents/create-card.md` when it exists; absent, use the questions below.

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

## Epic patterns

A pattern is a shape, not a quota. Every child still has to answer the four questions above; if
one cannot land alone, it is not a child — fold it into the card whose scope it is.

### Pattern 1: build and test design in parallel

An epic names a product requirement that will be built. Its children:

```
EPIC  <the sum of the requirement>
├─ dev            the implementation, with the surfaces it touches
├─ test-design    the test inventory, the acceptance-to-test trace, the fixtures
└─ test-execution runs the tests once dev and test-design are on the base branch
```

`dev` and `test-design` are scheduled at the same time. `test-execution` is `blocks`-ed by both:

```bash
taskctl relation add <dev> --type blocks --target <test-execution>
taskctl relation add <test-design> --type blocks --target <test-execution>
```

**The precondition is what makes the split legal.** Parallel means scheduled together, never
stacked on each other's branches, and `test-design` must land green with `dev` absent — its
deliverable is independent of the feature (a test inventory, an acceptance-to-test trace, fixtures,
or cases against an interface that is already merged). If it would author executable tests that
import the new module, it is not a sibling: fold that work into `dev`, or let `test-execution`
author and run the tests after `dev` lands. Check by running the suite on the `test-design`
branch before merging it.

`test-execution` lands only after both are on the base branch, so its branch carries no unmerged
sibling commit. One more trap: `issue candidates` withholds a card whose `blocks` predecessor is
not `done`, and a `canceled` predecessor withholds it too — canceling `test-design` does not
unblock `test-execution`.

### Pattern 2: expand, migrate, contract

A change that replaces an interface, a command or a storage shape while callers still exist:

1. **expand** — add the new path beside the old one; the old one still works, so the tree is
   coherent and the card lands alone.
2. **migrate** — move every caller and surface to the new path.
3. **contract** — remove the old path.

Each step is `blocks`-ed by the previous one. The failure mode is contracting before the last
caller moved: the tree goes red in the middle of the epic, and the missing caller is nobody's
card.

### Pattern 3: independent user-visible slices

Several outcomes that can each ship alone: a CSV export and a PDF export, not "backend", "frontend"
and "docs". Each child carries its own core, CLI, web, docs and fixtures for its outcome, and
usually has no `blocks` edge. Add one only when a later slice genuinely needs an earlier one
merged. The failure mode is splitting by layer, which produces children that cannot land alone.

## Instantiate the project's epic graph

A project may carry `docs/agents/epic-graphs.md`: the named stages, roles, modes and
dependencies its multi-role epics use. This skill defines the format and the mechanics; the
graph's *content* belongs to the project. No graph is built in here.

**Pre-flight — write nothing yet.** Resolve the project directory with
`taskctl project dir <p> --json` and read `<dir>/docs/agents/epic-graphs.md`.

- File missing: **stop**. Say the project has no epic graph, that it is the only source for
  multi-role epics, and point at `setup-meerkat` to install one from its default template
  after the user confirms. Never fall back to a built-in graph.
- Named graph missing: stop and list the graph names the file does carry.
- Validate the generic structure: unique stage ids; every `depends_on` names a stage in this
  graph; the graph is acyclic and has at most 8 stages; every stage has a role, mode and at
  least one acceptance item; every role is in `taskctl role list --json` on a worker lane.
  Do not validate a project column — the project's role skills interpret it. Stop on any
  failure; create nothing.
- Look for an existing instance:
  `taskctl issue list --project <p> --meta epic_graph=<name> --meta epic_instance=<slug> --json`.
  If one exists, continue it; never create a second epic.
- Show the whole graph in the conversation — the epic, every card's role/mode/dependencies
  and acceptance, and which cards are immediately claimable — and get an explicit OK.
  Use `--as-human` only in a human-started session.

**Create the epic.**

```bash
taskctl --as-human issue create --project <p> --title "<title>" --kind epic \
  --acceptance-mode human --acceptance "<epic acceptance>" \
  --meta epic_graph=<name> --meta epic_instance=<slug> \
  --target epic:<slug> --json
```

`<slug>` defaults to the title's kebab-case; the same title returns the same epic.

**Create the children in topological order, in `backlog`.** A `backlog` card is not claimable
before its edges exist.

```bash
taskctl --as-human issue create --project <p> --title "<stage title>" \
  --assignee <Role> --assignee-kind agent --acceptance-mode <mode> \
  --acceptance "<item>" --acceptance "<item>" \
  --status backlog --parent <epic-identifier> --target <stage-id> \
  --meta epic_graph=<name> --meta epic_stage=<stage-id> --json
```

`--parent` **only fills the idempotency key's source slot; it creates no edge.** The pair
`--parent <epic-identifier> --target <stage-id>` derives the key
`task | <Role> | <epic-id> | <stage-id>`, so a re-run returns the same card. Reuse both
values verbatim on a re-run.

**Create the edges.** Read first; skip one that already exists.

```bash
taskctl --as-human relation add <epic-identifier> --type parent --target <child-identifier>
taskctl --as-human relation add <dependency-identifier> --type blocks --target <child-identifier>
```

`depends_on` is the reverse of `blocks`: the **source** is the predecessor.

**Release to `todo` after every edge exists.**

```bash
taskctl --as-human issue move <child-identifier> todo
```

**Read back the whole graph.** `taskctl issue get <epic-identifier> --include relations --json`
and `taskctl issue list --parent <epic-identifier> --json`. Check: the child count equals the
stage count; every child's parent is the epic; `blocked_by` equals the graph's `depends_on`;
role, mode and frozen acceptance match. Report and stop on any mismatch — never "create one
more" to patch it.

**Deleting a stage.** Remove every `blocks` edge that names it **before**
`taskctl issue move <child-identifier> canceled`: a canceled predecessor withholds its
dependents forever.

Hand back one map: the epic identifier, the stage → identifier table, the cards claimable now,
and each gate's closer. Normal flow then needs no director: a predecessor's `done` puts its
dependents in the owning role's `issue candidates`.

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
