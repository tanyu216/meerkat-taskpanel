# Scenario — product planning

Refines the universal floor in `SKILL.md` and `references/review-protocol.md`; read those first.
Board operations are the `meerkat` board skill's contract.

**Applies to:** a brief, PRD, requirement set, product glossary or ADR, a `product-acceptance`
card, or any delivery whose product is a decision about what to build and why.

## Checks

- The problem, its evidence, the users, goals and non-goals, metrics, scope, and what is out of
  scope.
- Every PRD Must maps to a testable acceptance item, and every acceptance item traces to a Must
  or a stated requirement. A `product-acceptance` card's ledger traces every Must and marks it
  met/unmet with evidence.
- The requirement → acceptance → evidence chain closes; every boundary state is named; the
  chosen solution is the simplest reliable one.
- Terms agree with the glossary and the ADRs; a new term has a definition and an owner.
- When a downstream stage depends on it the card sets `stage_handoff=required`: the current
  report's `## Handoff` is complete, its archived paths resolve, its acceptance source matches
  the frozen acceptance, and every downstream follow-up named in `leftovers` is in the block. A
  defect follow-up filed in `backlog` is named by its identifier.
- The plan-quality refinement (protocol Step 8) is applied to the PRD itself.

## Blocks APPROVE

- A Must with no testable acceptance item.
- A `product-acceptance` ledger that does not trace every Must.
- A missing or invalid handoff, or a downstream follow-up absent from it.
- A requirement that exists only in the report's summary.

## Beyond

Comparable options, rollout/measurement plan, open-question disposition. Design taste is not a
verdict reason; audit conformance and evidence.
