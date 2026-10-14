-- 0017_block_cycle.sql — a `blocks` edge may not close a loop.
--
-- ---------------------------------------------------------------------------
-- Why this did not exist
-- ---------------------------------------------------------------------------
--
-- `0002_invariants.sql` guards the shape of a `parent` edge (cycle, chain depth,
-- fan-in) and, type-independently, self-reference and cross-project. A `blocks`
-- edge — which is what a card's `depends_on` is (`src/core/storage/md/import.mjs`
-- stores `depends_on: [X]` as `type='blocks', source=X, target=this`, and
-- `export.mjs` rebuilds it from `listBlockerOf`) — therefore only had the
-- type-independent two. `a blocks b` plus `b blocks a` was accepted.
--
-- That is a deadlock, not a shape nobody minds: the poll refuses to offer a card
-- whose blockers are unfinished (`README.md` §3, "`depends_on` links form a DAG,
-- so independent work runs in parallel and dependent work waits"), so a cycle
-- makes every card in it permanently unclaimable with nothing on the board
-- saying why. The DSL statement is that the dependency graph *is* a DAG, and an
-- invariant that only the service layer believes is not an invariant
-- (ARCHITECTURE §4.2) — hence a trigger, added by T-20261014-212017-4 with the
-- drawer's `depends_on` write surface.
--
-- ---------------------------------------------------------------------------
-- Direction, and why it is the mirror of the parent guard
-- ---------------------------------------------------------------------------
--
-- Convention: for `blocks`, **source is the blocker** and target is the card
-- that waits. The new edge is blocker → blocked. It closes a loop exactly when
-- `blocked` can already reach `blocker` by following `blocks` edges *forwards*
-- — i.e. when the thing we are about to make wait on us is already, transitively,
-- waiting on us. The walk below therefore starts at NEW.target_task_id and
-- follows source → target, which is the same walk `tr_rel_parent_guard` does in
-- the opposite direction (it starts at the new child and follows target →
-- source, because a parent edge points the other way).
--
-- ---------------------------------------------------------------------------
-- Determinism (0002's rule, restated because it is easy to lose)
-- ---------------------------------------------------------------------------
--
-- SQLite fires every matching trigger for an event in no guaranteed order, so
-- two that can both be true on one row make the reason code a coin flip. This
-- guard is **conditionally disjoint** from its neighbours on INSERT ON
-- task_relations, exactly as 0002's three are from each other:
--
--   tr_rel_self_ref       source = target                       (type independent)
--   tr_rel_cross_project  source <> target, projects differ
--   tr_rel_parent_guard   source <> target, same project, type = 'parent'
--   tr_rel_block_cycle    source <> target, same project, type = 'blocks'
--
-- `relation_type` alone separates this trigger from `tr_rel_parent_guard`; the
-- `source <> target` clause keeps a self-referencing dependency reporting
-- SELF_REFERENCE rather than RELATION_CYCLE; and the project clause — the same
-- `IS` comparison 0002 uses, NULL-safe so a nonexistent endpoint cannot masquerade
-- as a same-project pair — keeps it off `tr_rel_cross_project`'s row. For any one
-- row at most one of the four can fire.
--
-- `depth < 64` caps the recursion so a malformed graph cannot spin, the same cap
-- and the same reason as the parent guard.

CREATE TRIGGER IF NOT EXISTS tr_rel_block_cycle BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'blocks'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      WITH RECURSIVE downstream(id, depth) AS (
        SELECT NEW.target_task_id, 0
        UNION ALL
        SELECT r.target_task_id, downstream.depth + 1
          FROM task_relations r JOIN downstream ON r.source_task_id = downstream.id
         WHERE r.relation_type = 'blocks' AND downstream.depth < 64
      )
      SELECT 1 FROM downstream WHERE downstream.id = NEW.source_task_id
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    ELSE NULL
  END;
END;
