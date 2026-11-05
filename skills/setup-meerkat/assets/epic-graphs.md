# Epic graphs

This project's only source for multi-role epic construction. A graph is guidance, not board
data: `taskd` never reads it, nothing is stored or inherited. The recipe that instantiates a
graph is the `meerkat` skill's `references/scenarios/epic.md`.

## Format

A graph is one `##` section named by its graph id. Its table has these required columns:

| stage | role | mode | depends_on | <project columns...> |
|---|---|---|---|---|
| <stage-id> | <Role> | <auto\|human\|off> | <stage ids, or —> | ... |

- `stage` ids are stable and unique inside the graph; `depends_on` names stages in the same
  graph and must be acyclic; a graph has at most 8 stages.
- `role` is an installed worker-lane role; `mode` is that card's `acceptance_mode`.
- The generic recipe only passes a project column through; the project's role skills interpret it.
  This project uses `design input: yes|none` (`yes` = read the upstream
  design card's `## Handoff`/PRD; `none` = no design input).
- Each stage has a `### stage <id>` block with a `Title:` template and its `Acceptance:`
  items; those seed the card's frozen acceptance at creation.

## dev-verify

A single change that needs independent verification: development, then a verification card.

| stage | role | mode | depends_on | design input |
|---|---|---|---|---|
| dev | Linus | auto | — | none |
| verify | Turing | auto | dev | none |

### stage dev
- Title: <what the change is>
- Acceptance:
  - The change satisfies the card's frozen acceptance.
  - Every surface it touches (core, CLI, web, docs and fixtures) is updated in the same card.
  - The project's gates are green on the delivery commit; the report carries the `commit` anchor.

### stage verify
- Title: Verify <the change>
- Acceptance:
  - Every acceptance item has a test or real behaviour evidence.
  - The full matrix runs on dev's delivery commit; commands and exit codes are recorded.
  - Coverage is at the project floor, or the exception is justified.
  - The report names the dev card and its evidence.

## requirement

A product requirement carried from design through development, testing and product acceptance.

| stage | role | mode | depends_on | design input |
|---|---|---|---|---|
| design | Jobs | human | — | none |
| dev | Linus | auto | design | yes |
| test-design | Turing | auto | design | yes |
| test-exec | Turing | auto | dev, test-design | yes |
| product-acceptance | Jobs | auto | test-exec | yes |

### stage design
- Title: Design <the requirement>
- Acceptance:
  - Problem, users, outcome, constraints and non-goals have evidence.
  - One direction is frozen and recorded.
  - Every PRD Must is testable and traceable to the requirement.
  - The `## Handoff` names the archived paths, the acceptance source and the downstream cards.

### stage dev
- Title: Implement <the requirement>
- Acceptance:
  - Every accepted PRD Must is implemented and traced in the report.
  - The project's gates are green on the delivery commit; the report carries the `commit` anchor.
  - The touched surfaces are named.

### stage test-design
- Title: Design the tests for <the requirement>
- Acceptance:
  - Every PRD Must and every frozen acceptance item maps to at least one test.
  - Fixtures and real-behaviour boundaries are explicit.
  - No unmerged implementation is imported.

### stage test-exec
- Title: Execute the tests for <the requirement>
- Acceptance:
  - The full matrix runs on dev's delivery commit; commands and exit codes are recorded.
  - Coverage is at the project floor.
  - A failure names the fix card or the accepted exception.
  - Security evidence is recorded, or `n/a — <reason>`.

### stage product-acceptance
- Title: Product acceptance of <the requirement>
- Acceptance:
  - Every PRD Must is marked met/unmet against the delivered build with evidence.
  - Every unmet item names the gap, its owner and the follow-up card.
  - The report carries evidence only; no code is changed.
