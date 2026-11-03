# Creating a card

This page is complete for creating a card; do not read the other scenario pages.

## When this applies

You are filing a new card with `issue create`. It is not the claim/deliver cycle
(`execute.md`), and a card that is or becomes an epic also reads `epic.md` for the split.

## The create

`issue create` is the whole handoff: the card lands in `todo` — the queue the loop's poll
reads — in the same call, addressed to whoever it is assigned to. The queue is per assignee,
not global; an unassigned card is the public pool. Only `--status backlog` keeps it out of a
queue. The INSERT gate:
[`../lifecycle/transitions.md#8-creating-a-card-in-a-status`](../lifecycle/transitions.md#8-creating-a-card-in-a-status).

## Resolve the acceptance mode

The mode is decided at creation, not by a project default. `off` means no review and the
deliverer may close; `auto` means an independent review, then the loop closes on `APPROVE`
(the fallback when the mode is omitted); `human` means an independent review, then a person
closes after it finishes.

Resolve the project's own selection rules in this order:

1. Resolve the project working directory: `taskctl project dir <id> --json`.
2. Read `<project-dir>/docs/agents/create-card.md` when it exists.
3. An explicit instruction from the human wins over that document.
4. If the file, the directory or the map is absent, use the three meanings above. Never invent a project default or store one on the project row.

The same document records the project's epic sizing boundary; read it when the card is an
epic or you are creating children.

## Route the card at creation

The create *is* the routing decision, not a step after it. When a role skill fits the card's
work shape (each role's `SKILL.md` lists its shapes), name that one accountable role in the
same call:

```bash
taskctl issue create --project <p> --title "…" --assignee <role> --assignee-kind agent --acceptance "…"
```

An unassigned card is **unowned**, not handed off: the supervisor's pool claim can take it as
the Worker role, or the `meerkat-director` routes it. A shape no role describes goes to the
Worker role, named explicitly. **With no role installed, do not invent a role name** — leave
the card unassigned (the public pool) or name your own worker identity. Ambiguous between two
shapes: split it into one card per **role** shape — a handoff boundary, not a technical layer
— or leave the routing to the director.

## File it in the human's name

File a card in the human's name when you are in an interactive session with the human, or
when the instruction to create this card comes explicitly from them. Either one is enough:
`--as-human` records that human as both the writer and the reporter. Do not use it when you
are working from a loop handoff or a card brief with no explicit human instruction, when you
file a card yourself outside a human conversation, or for your own claim, heartbeat, delivery or review. If the human asked but `--as-human` is unavailable, pass `--reporter <name>` for
the create.

## Attach the document

A document the work must follow is attached, not retyped. When the human points at a file —
a plan, a spec, a vendor's PDF to read closely — that pointing *is* the instruction; nobody says "upload it". Attach it straight after the create, and when the file is the plan itself,
store it as `plan.md` whatever it is called on disk:

```bash
taskctl --as-human issue create --project <p> --title "…" [--assignee <role>] --acceptance "…"
taskctl attachment add <ref> --file <path> --name plan.md   # the plan's one name; create has no --file
```

Anything else keeps its own name, and a non-text plan keeps its extension (`plan.pdf`). The
worker reads the card and its brief, never this conversation, so a path said only here
reaches nobody: attach the file and point `--description` at the attachment instead of
retyping it. A file named without a path gets one question for the path — never go hunting
the tree for a document nobody named.

## Say the outcome

Say the outcome in one line, then stop: the identifier, that it is queued, and the file when
you attached one — `已建卡 PROJ-0007，已排队处理（附 spec.pdf）`. Do not ask whether to start.

<!-- read-next:begin -->
- [`../lifecycle/transitions.md#8-creating-a-card-in-a-status`](../lifecycle/transitions.md#8-creating-a-card-in-a-status)
<!-- read-next:end -->
