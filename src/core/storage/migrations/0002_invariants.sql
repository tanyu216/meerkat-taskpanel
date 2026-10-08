-- 0002_invariants.sql — the invariants that must hold no matter who writes.
--
-- ARCHITECTURE §4.2: these are *machine* guarantees. The service layer repeats
-- the same checks only to produce friendlier messages; if the two ever drift,
-- `test/contract/invariants.test.mjs` walks both paths and fails.
--
-- ---------------------------------------------------------------------------
-- Determinism rule (plan §3.3.6④, learned the hard way)
-- ---------------------------------------------------------------------------
-- SQLite fires every matching trigger for an event, and the order between them
-- is NOT guaranteed. Two triggers that can both be true on one row therefore
-- make the reason code a coin flip. So every guard here is **conditionally
-- disjoint** from the others that share its event:
--
--   INSERT ON task_relations
--     tr_rel_self_ref       source = target                (type independent)
--     tr_rel_cross_project  source <> target, projects differ
--     tr_rel_parent_guard   source <> target, same project, type = parent
--     -> exactly one can be true. The `source <> target` clause on the parent
--        guard is what keeps a self-referencing parent edge from reporting
--        RELATION_CYCLE instead of SELF_REFERENCE.
--
--   UPDATE OF status ON tasks
--     tr_tasks_terminal     OLD.status is terminal         (done/canceled)
--     tr_tasks_transition   OLD.status is NOT terminal
--     -> disjoint on OLD.status; 0003's delivery gate adds
--        `OLD.status IN ('in_progress','blocked')`, which is a subset of the
--        non-terminal side, so it is disjoint from the terminal guard too.
--
-- Constraint failures (CHECK/UNIQUE) are evaluated *after* BEFORE triggers, so
-- a trigger's reason code always wins over a constraint message on the same
-- row. That ordering is what makes `ux_relations_single_parent` a
-- SINGLE_PARENT_VIOLATION in the quiet case and a RELATION_CYCLE in the loud one.

-- ---------------------------------------------------------------------------
-- Relations
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS tr_rel_self_ref BEFORE INSERT ON task_relations
WHEN NEW.source_task_id = NEW.target_task_id
BEGIN
  SELECT RAISE(ABORT, 'SELF_REFERENCE');
END;

-- Both endpoints must exist before we judge projects: foreign keys are checked
-- *after* BEFORE triggers, so without the IS NOT NULL guards a typo'd task id
-- would come back as CROSS_PROJECT_RELATION instead of NOT_FOUND.
CREATE TRIGGER IF NOT EXISTS tr_rel_cross_project BEFORE INSERT ON task_relations
WHEN (SELECT project_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS NOT (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION');
END;

-- Parent/child shape guards, in one place so the precedence is explicit rather
-- than emergent.
--
-- Direction convention: for `relation_type = 'parent'`, **source is the parent
-- and target is the child** (matching the single-parent index on target).
--
-- Cycle detection walks *up* from the new parent (NEW.source_task_id) and asks
-- whether it can reach the new child (NEW.target_task_id): that is exactly the
-- case where the new edge closes a loop. Getting this direction backwards
-- fails silently — see the two-length ring cases in the contract test.
--
-- `anc.depth < 64` caps the recursion so a malformed chain cannot spin.
CREATE TRIGGER IF NOT EXISTS tr_rel_parent_guard BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.source_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.id = NEW.target_task_id
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    -- depth of the new child = max(anc.depth) + 2 (the child, plus the parent);
    -- the chain may not exceed 8 nodes.
    WHEN EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.source_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.depth > 6
    ) THEN RAISE(ABORT, 'CHAIN_TOO_LONG')
    WHEN (SELECT COUNT(*) FROM task_relations
           WHERE relation_type = 'parent' AND source_task_id = NEW.source_task_id) >= 8
    THEN RAISE(ABORT, 'FANIN_TOO_HIGH')
    ELSE NULL
  END;
END;

-- Relations are add/remove only: history stays readable (§4.1).
CREATE TRIGGER IF NOT EXISTS tr_rel_immutable BEFORE UPDATE ON task_relations
BEGIN
  SELECT RAISE(ABORT, 'RELATION_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- Task lifecycle (F1 whitelist, mirrored from domain/status.mjs)
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS tr_tasks_terminal BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'TERMINAL_STATE');
END;

-- Same table as domain/status.mjs#ALLOWED_TRANSITIONS. A change to one without
-- the other is caught by test/contract/state-machine.test.mjs, which walks all
-- 49 ordered pairs down both paths.
CREATE TRIGGER IF NOT EXISTS tr_tasks_transition BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND OLD.status NOT IN ('done','canceled')
BEGIN
  SELECT CASE
    WHEN NOT (
         (OLD.status = 'backlog'     AND NEW.status IN ('todo','canceled'))
      OR (OLD.status = 'todo'        AND NEW.status IN ('backlog','in_progress','blocked','canceled'))
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','canceled'))
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;

-- Archiving is for finished work only (I6). `archive()` never changes status,
-- so this can never collide with the two guards above.
CREATE TRIGGER IF NOT EXISTS tr_tasks_archive_terminal BEFORE UPDATE OF archived_at ON tasks
WHEN NEW.archived_at IS NOT NULL AND NEW.status NOT IN ('done','canceled')
BEGIN
  SELECT RAISE(ABORT, 'ARCHIVE_NOT_TERMINAL');
END;

-- ---------------------------------------------------------------------------
-- Comments (I4: append-only)
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS tr_comments_no_update BEFORE UPDATE ON comments
BEGIN
  SELECT RAISE(ABORT, 'COMMENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_comments_no_delete BEFORE DELETE ON comments
BEGIN
  SELECT RAISE(ABORT, 'COMMENT_APPEND_ONLY');
END;
