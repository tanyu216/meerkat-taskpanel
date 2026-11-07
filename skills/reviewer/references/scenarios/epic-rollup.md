# Scenario — epic / rollup

Refines the universal floor in `SKILL.md` and `references/review-protocol.md`; read those first.
Board operations are the `meerkat` board skill's contract.

**Applies to:** an epic, a rollup of child cards, or a parent whose conclusion depends on its
children.

## Checks

- Every child has a conclusion: done with evidence, or an explicit disposition.
- Scope coverage: every child the epic promised exists; no silent scope loss and no orphan.
- The rollup is current at the delivered sha, and names each child's conclusion and the
  aggregate.
- A fix child links to the finding that created it; a dropped child is explained.
- Dependency order: a child's conclusion does not rest on an unfinished dependency.

## Blocks APPROVE

- A dropped or orphan child.
- A stale rollup.
- A child with no conclusion.
- A dependency claimed done while it is still open.

## Beyond

Cross-epic dependency risk.
