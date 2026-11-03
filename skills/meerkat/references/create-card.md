# Creating a card

A create is one call and three decisions: whether the work becomes a card, whether it is one card
or an `epic` container, and which acceptance mode it carries. Each is cheap to get right now and
expensive to repair later — a card nobody owns, a container whose rollup can never close, or a
review that waits for a person who was never named.

`issue create` is the whole handoff: the card lands in `todo` — the queue the loop polls — in the
same call. The queue is per assignee; an unassigned card is the public pool. Only
`--status backlog` keeps it out of a queue. The INSERT gate:
[§8](status-lifecycle.md#8-creating-a-card-in-a-status).

## Before the create

Resolve the project's working directory, then read the project's own card rules:

```bash
taskctl project dir <id> --json     # data.dir
```

Read `<project-dir>/docs/agents/create-card.md` when it exists. That page is a **thin override**:
it records only this project's choices, and what it states wins over this page. A topic it does
not state falls back to this page — so a project may answer one question and inherit the other
two. An explicit instruction from the human wins over both.

If the file, the directory or the map is absent, this page plus the board rules is the whole
answer. Never invent a project default, and never store one on the project row: the card's own
fields are the authority.

## Scope: what work becomes a card

A board that accepts every request stops being a signal. A card costs a claim, a delivery report
and an acceptance, so the default is deliberately narrow: **the work a role owns** — product
design, development and architecture, bug fixes and refactors, test design and regression,
performance work, independent review.

**Outside the roles is outside the board.** A question, a lookup, a one-off command, a scratch
experiment, the change already being made in this conversation, or work the human is doing
themselves has no owner and does not become a card. Saying it here is the answer; filing it
creates work nobody will claim.

A project may narrow this ("only work that crosses sessions") or widen it ("every change"). Its
answer lives in its own `docs/agents/create-card.md`; read it rather than guessing.

## The epic decision: when work is a container

An epic exists only where someone named one. A title and description naming the **sum** of the
work is the container; naming **one deliverable** makes it a child.

**Who splits.** Splitting is a scope decision the `meerkat-director` owns. A worker that finds
several deliverables writes an agent `question` comment describing the pieces, keeps the card
`in_progress`, and **holds** with `issue wait`. It does not create the children itself. An
explicit instruction from the human wins over this.

**A child is a deliverable, not a layer.** Ask four questions of every proposed child:

1. **Can it land on the base branch alone?** Its branch merges without carrying a sibling's
   unmerged commit.
2. **Does landing it leave the tree coherent?** Every surface it touches — core, CLI, web, docs and fixtures — is updated in the same card, and the suite is green.
3. **Is the outcome visible?** A reader of the epic sees a result, not "the CLI flag" or "the
   docs".
4. **Does it owe a cleanup card?** No fixture sweep or documentation catch-up exists only to pay
   its debt.

A later child may build on an earlier child already on the base branch; a stack on an unmerged sibling is not. The layers of one change are its **scope**: enforcing the 1-4 character project prefix on every create path is one child, not five. The routing table's "one card per shape" sizes a **role** handoff, not a technical layer.

| Card you have | Role | What to do |
|---|---|---|
| already an `epic` | — | add children; never convert it |
| `task`, no parent | the whole job | promote in place (below) |
| `task`, no parent | one deliverable among several | create a new `--kind epic` container; link it and the new children |
| `task`, with a parent | the whole job | promote to a nested epic; its parent edge stays |
| `task`, with a parent | one deliverable among several | keep it as a child; add siblings under the same parent |
| `in_review`, `done`, `canceled` or archived | — | do **not** promote; create a new container and link the old card |
| a review card | — | do **not** promote; split a separate container |

**Promote before the card delivers its current-round report.** The rollup collects the
**children's** delivery reports, not the container's own history, so promoting a card that
already delivered strands every child attached after it; start a *new* container instead.

```bash
taskctl issue update <ref> --kind epic       # the card keeps its status
taskctl comment add <ref> --kind note --body "split into N cards: …"
taskctl issue create --project <p> --title "…" [--assignee <role>] --target <t> --acceptance "…"
taskctl relation add <ref> --type parent --target <child>     # <ref> is the parent
```

**An epic's acceptance is its children**; its delivery is a rollup of their reports. The board
starts the container when a child enters work and closes it to `in_review` (never `done`) when
the tree is finished — but a `backlog` or `awaiting` epic does not auto-start, and an `in_review`
epic that gains a child must move back to `in_progress` to roll up again. An all-canceled tree is
not a delivery — cancel the container instead. Attempt the close; the refusal names anything
still open.

Three rules that fail **silently**:

- **Each child needs its own `--target`.** The create guard keys on kind + assignee + source +
  target; two children for one owner with nothing to tell them apart are the *same card*. Use
  `--allow-dup` when a target does not apply.
- **`issue create --parent <epic>` links nothing** — only `relation add --type parent` does.
- **A child attached after the rollup makes it stale**; rework the epic to start a new round.

Claim exactly **one** leaf child; the container holds no work of its own. Enforcement and the
child guards: [§6](status-lifecycle.md#6-containers-epic); promotion:
[promoting a card](cli.md#promoting-an-existing-card-to-an-epic).

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

## Acceptance mode: who closes the card

The mode is decided at creation and frozen on the card. It selects the **closer**, not whether a
review happens:

- **`off`** — no review. The deliverer, or a human, closes it; `in_progress → done` is allowed.
- **`auto`** — an independent review, then the loop closes the card on a current-round `APPROVE`.
  This is the **fallback when the mode is omitted**.
- **`human`** — an independent review, then a person closes the card after that review finishes.

Any card, at any depth, may be `human`; an `epic` follows the same rule and defaults to `auto`. A
review card is always `off`. An agent may only tighten the mode (`off → auto|human`); loosening
one needs `--reason` and no open current-round review card.

There is **no project default**. A project may document how its creators choose between the
words in its `docs/agents/create-card.md`; an explicit instruction from the human wins over that
page. Never invent a project default, and never store one on the project row. Gate, rounds and
the board's matrix: [§7](status-lifecycle.md#7-acceptance-one-mode-per-card),
[the reviewer's protocol](review-protocol.md#4-acceptance-mode).

## Routing: name the accountable role

The create *is* the routing decision, not a step after it. Read the role catalog first — it is
the valid range:

```bash
taskctl role list --json     # data.roles[].agent | id | title | summary | lanes | shapes
```

Name one worker-lane role in the same call (never the reviewer; a reviewer-lane role is not
routed ordinary work):

```bash
taskctl issue create --project <p> --title "…" --assignee <role> --assignee-kind agent --acceptance "…"
```

When the catalog is non-empty, the CLI refuses an `--assignee` outside it
(`ASSIGNEE_NOT_IN_CATALOG`) — tell the human the valid names rather than guessing;
`--force-create` is only for an explicit human instruction to use a name outside the range.

An unassigned card is **unowned**, not handed off: the supervisor's pool claim can take it as the
Worker role, or the `meerkat-director` routes it. A shape no role describes goes to the Worker
role, named explicitly. **With no role installed** — including before the supervisor's first
sync, when `role list` is empty — do not invent a role name; leave the card unassigned (the
public pool) or name your own worker identity. Ambiguous between two shapes: split it into one
card per **role** shape — a handoff boundary, not a technical layer — or leave the routing to the
director.

## Filing as the human

File a card in the human's name when you are in an interactive session with the human,
or when the instruction to create this card comes explicitly from them. Either one is enough:
`--as-human` records that human as both the writer and the reporter.

Do not use it when you are working from a loop handoff or a card brief with no explicit human
instruction, when you file a card yourself outside a human conversation, or for your own
claim, heartbeat, delivery or review. If the human asked but `--as-human` is unavailable, pass
`--reporter <name>` for the create.

## Attaching a document

A document the work must follow is attached, not retyped. When the human points at a file — a plan,
a spec, a vendor's PDF to read closely — that pointing *is* the instruction; nobody says "upload it".
Attach it straight after the create, and when the file is the plan itself, store it as `plan.md`
whatever it is called on disk:

```bash
taskctl --as-human issue create --project <p> --title "…" [--assignee <role>] --acceptance "…"
taskctl attachment add <ref> --file <path> --name plan.md   # the plan's one name; create has no --file
```

Anything else keeps its own name, and a non-text plan keeps its extension (`plan.pdf`). The
worker reads the card and its brief, never this conversation, so a path said only here reaches
nobody: attach the file and point `--description` at the attachment instead of retyping it. A
file named without a path gets one question for the path — never go hunting the tree for a
document nobody named.

## The one-line outcome

Say the outcome in one line, then stop: the identifier, that it is queued, and the file when you
attached one — `已建卡 PROJ-0007，已排队处理（附 spec.pdf）`. Do not ask whether to start.
Commands and flags: [issue create](cli.md#issue-create), [attachment](cli.md#attachment).

## Where the rules live

| Topic | Read |
|---|---|
| creating in a status, the INSERT gate | [§8](status-lifecycle.md#8-creating-a-card-in-a-status) |
| containers, rollup, promotion | [§6](status-lifecycle.md#6-containers-epic) |
| acceptance modes and the matrix | [§7](status-lifecycle.md#7-acceptance-one-mode-per-card) |
| delivery gate and round | [§4](status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round) |
| `issue create`, attachments, promotion | [create](cli.md#issue-create), [attachment](cli.md#attachment), [promotion](cli.md#promoting-an-existing-card-to-an-epic) |
| relation caps (8 children, 8 deep) | [caps](card-schema.md#relation-caps) |
| what an `APPROVE` closes | [review protocol](review-protocol.md#4-acceptance-mode) |
