# The triage decision

An accepted card that carries `meta.stage_handoff=required` owes follow-up work. Read the
current delivery's `## Handoff` and decide; record `handoff_consumed_round` on the producer, or
`handoff_declined_round` when no downstream card is needed. The marker is the completion; a
linked child alone is not proof. A proposed child that expands scope is E1: create it only if the map gives E1 to the director; otherwise read `escalation.md` and escalate.

## Read the project graph first

Resolve the project directory and read `<dir>/docs/agents/epic-graphs.md`. It is the project's
only source for multi-role epic shapes; the generic mechanics and the exact commands are the
`meerkat` skill's `references/scenarios/epic.md`. The graph is guidance, not board data:
nothing stores it.

1. Match the producer to one graph and one stage by its role and delivery shape — for example a
   delivered Jobs design card is `requirement`'s `design`.
2. Find an existing instance from the producer's parent or from its graph and instance metadata
   — the recipe's lookup. Reuse it; fill only what is missing.
3. With no instance, create the epic with the graph's settings. **Adopt the delivered producer
   as its matching stage**: link it with the recipe's parent edge and set `meta.epic_stage=<id>`
   on it so a later recipe re-run does not recreate it.
4. Create every missing stage with the recipe's idempotency convention: the same
   `--parent <epic> --target <stage-id>` pair and `meta.epic_graph` / `meta.epic_stage`. Do not
   write design/verification classification meta, and do not use the `loop-handoff|...` idem
   for a graph stage. An adopted producer's existing hints stay as they are.
5. When no graph matches, or the producer matches no stage, keep the per-deliverable behavior:
   one card per deliverable with its accountable role, seeded from the handoff's
   `Acceptance source`.
6. A delivered producer's acceptance mode cannot be changed retroactively. If the graph's stage
   is `human` and the producer was not, record the deviation on the epic and let the human
   confirm it when the epic closes.
