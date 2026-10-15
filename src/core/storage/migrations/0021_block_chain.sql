-- 0021_block_chain.sql — a `blocks` edge may not join an ancestor and a descendant.
--
-- ---------------------------------------------------------------------------
-- Why this did not exist
-- ---------------------------------------------------------------------------
--
-- `0017_block_cycle.sql` gave a `blocks` edge the cycle guard its `parent`
-- counterpart had always had in `0002_invariants.sql`, but it only looked at
-- the `blocks` graph. The *parent chain* — the other order the board carries —
-- stayed unread, so an edge between two cards that are already ancestor and
-- descendant went in:
--
--   E  (epic)
--   └─ D          parent edge E → D
--
--   D blocks E    accepted, though D is E's child
--   E blocks D    accepted, though E is D's parent
--
-- Both are deadlocks by the reasoning 0017 already sets out: the poll refuses to
-- offer a card whose blockers are unfinished (`README.md` §3), so `D depends_on E`
-- leaves a card waiting on its own ancestor and `E depends_on D` leaves the epic
-- waiting on a child it contains — neither can ever be claimed. It is also the
-- one direction the board's own UI never offers: the drawer's dependency picker
-- omits ancestors by construction (the prototype's red line #10), so the API was
-- accepting a shape the frozen design had already excluded.
--
-- Elon's ruling on the reading of "ancestor" (T-20261014-212017, kind=decision,
-- reading 乙) is what this file implements: **an ancestor/descendant pair may not
-- be joined by a `blocks` edge, in either direction.**
--
-- ---------------------------------------------------------------------------
-- What is *not* refused
-- ---------------------------------------------------------------------------
--
-- Siblings. Two children of one epic share a parent and are therefore "related"
-- in the loose sense, but neither is an ancestor of the other and neither blocks
-- the other, which is an ordinary and wanted dependency: a card and its sibling
-- run in sequence all the time. The test below walks both the rejection and this
-- non-rejection, because a guard that also refuses siblings is not this guard.
--
-- ---------------------------------------------------------------------------
-- Direction, and why it is a two-way walk
-- ---------------------------------------------------------------------------
--
-- Convention: for `blocks`, **source is the blocker** and target is the card that
-- waits. For `parent`, **source is the parent** and target is the child. The edge
-- is refused when either end is reachable from the other by walking *up* the
-- parent chain — i.e. both walks below start at one end and follow
-- `target_task_id → source_task_id` (child → parent), asking whether the other
-- end is on the way up. `0017`'s walk goes the other way (`source → target`)
-- because a `blocks` edge points the other way; the two are mirrors, not copies.
--
-- ---------------------------------------------------------------------------
-- Determinism (0002's rule, restated because this trigger bends it)
-- ---------------------------------------------------------------------------
--
-- SQLite fires every matching trigger for an event in no guaranteed order, so
-- two that can both be true on one row make the reason code a coin flip. The
-- existing guards on INSERT ON task_relations are **conditionally disjoint**:
--
--   tr_rel_self_ref       source = target                       (type independent)
--   tr_rel_cross_project  source <> target, projects differ
--   tr_rel_parent_guard   source <> target, same project, type = 'parent'
--   tr_rel_block_cycle    source <> target, same project, type = 'blocks'
--   tr_rel_block_chain    source <> target, same project, type = 'blocks'
--
-- The new pair is the exception, and it is a safe one: `tr_rel_block_cycle` and
-- `tr_rel_block_chain` are not disjoint in *eligibility* — a row can be both a
-- closing link and an ancestor/descendant link (a chain `E → D` plus `E blocks D`
-- then `D blocks E` is exactly that) — but they are identical in *outcome*.
-- Both `RAISE(ABORT, 'RELATION_CYCLE')`, so whichever fires first the row reports
-- one code, which is all the determinism rule is for. What would break it is a
-- *different* code on that row, and that is what the `source <> target` and
-- project clauses below keep this trigger from producing: SELF_REFERENCE still
-- owns `source = target` and CROSS_PROJECT_RELATION still owns the cross-project
-- row. `test/contract/invariants.test.mjs` asserts both halves of that claim.
--
-- `depth < 64` caps the recursion so a malformed chain cannot spin — the same cap
-- and the same reason as `tr_rel_parent_guard` and `tr_rel_block_cycle`.

CREATE TRIGGER IF NOT EXISTS tr_rel_block_chain BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'blocks'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    -- The blocker is on the blocked card's parent chain (it is its ancestor).
    WHEN EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.target_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.id = NEW.source_task_id
    -- …or the blocked card is on the blocker's (the edge is the other way up).
    ) OR EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.source_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.id = NEW.target_task_id
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    ELSE NULL
  END;
END;
