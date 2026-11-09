# The triage decision

An accepted card that carries `meta.stage_handoff=required` owes follow-up work. The decision
is the **close-out**: build one ledger from every open item the delivery records, give each
item exactly one disposition, then record the round marker. The marker is the completion; a
linked child alone leaves the handoff open. A proposed child that expands scope is E1: create it only if the map gives E1 to the director; otherwise read `escalation.md` and escalate.

## The close-out ledger

The delivery is the ledger's source, and every item the delivery records ends with a
disposition. Read, for the current delivery round:

- the `## Handoff` block — its `Downstream cards`, `Delivery shape`, `Acceptance source` and
  `Open questions / leftovers` lines;
- the report's `leftovers` field;
- the review cards of the same round — their observations are follow-up work whose cards the
  reviewer leaves to this decision;
- the `backlog` cards that already name this card in `meta.fixes` or carry its `handoff_of`
  key.

Each item ends in exactly one disposition:

- **owned** — an existing card or epic stage covers it; reuse that card as it is.
- **created** — no card covers it and the handoff authorizes the work; create one card per
  deliverable, seeded from the `Acceptance source` (the behavior below).
- **declined** — the item owes no card because it lies outside the board's scope or already
  sits with a named owner; the note names the item and that reason.
- **escalated** — a card for it would expand scope or change acceptance, design, security or
  architecture; it follows `escalation.md`.

The ledger is the card's scope boundary at close: work the delivery leaves outside the card
becomes an owned card, a recorded decline, or an escalation. A work item the delivery leaves
unnamed is a scope change: E1, and it follows `escalation.md` before any card.

The round is complete when every item above has a disposition, every stage of the matched
graph exists, and the marker's value names what was created. An item with no disposition
leaves the round open.

## Read the project graph first

Resolve the project directory and read `<dir>/docs/agents/epic-graphs.md`. It is the project's
only source for multi-role epic shapes; the generic mechanics and the exact commands are the
`meerkat` skill's `references/scenarios/epic.md`. The graph is guidance; the document is its
only home.

1. Match the producer to one graph and one stage by its role and delivery shape — for example a
   delivered Jobs design card is `requirement`'s `design`.
2. Find an existing instance from the producer's parent or from its graph and instance metadata
   — the recipe's lookup. Reuse it; fill only what is missing.
3. With no instance, create the epic with the graph's settings; honor the graph's `Epic mode`
   as the epic's `acceptance_mode`. **Adopt the delivered producer as its matching stage**:
   link it with the recipe's parent edge and set `meta.epic_stage=<id>` on it so a later
   recipe re-run reuses it.
4. Create every missing stage with the recipe's idempotency convention: the same
   `--parent <epic> --target <stage-id>` pair and `meta.epic_graph` / `meta.epic_stage`. The
   stage's identity is those two keys; design and verification classification lives in the
   project's `docs/agents/epic-graphs.md` and the role skills, and a graph stage keeps the
   graph's own idempotency convention. An adopted producer's existing hints stay as they are.
5. When no graph matches, or the producer matches no stage, keep the per-deliverable behavior:
   one card per deliverable with its accountable role, seeded from the handoff's
   `Acceptance source`.
6. A delivered producer's acceptance mode stays as delivered. If the graph's stage is `human`
   and the producer was not, record the deviation on the epic and let the human confirm it when
   the epic closes.

## Recording

The marker carries the ledger. `handoff_consumed_round=<round>` records the round and the
created refs after it; `handoff_declined_round=<round>` records a declined round, with a note
that accounts for every declined item and its reason.
