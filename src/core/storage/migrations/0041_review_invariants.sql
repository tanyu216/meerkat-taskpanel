-- 0041_review_invariants.sql — the review-only rules the app already enforced
-- become machine guarantees.
--
-- The command layer has refused all three of these since 0025:
--
--   * a review card cannot be reopened (`commands/tasks.mjs`, the reopen edge);
--   * a review card cannot be a parent or a child (`domain/relation.mjs`);
--   * a review cannot itself be reviewed (`resolveReviewMarker`).
--
-- A writer that bypasses the command layer could still do all three by raw SQL.
-- This migration is the backstop. It adds no rows and rebuilds no table, so it
-- is a no-op on an existing board.
--
-- Codes:
--   * reopen → `INVALID_TRANSITION`, the same code the app raises for a review
--     card's reopen (`assertTransition`'s terminal-source branch);
--   * parent / review-of-review → an **unmapped** RAISE. The error mapper turns
--     an unmapped RAISE into `VALIDATION_FAILED` (the code the app uses for both),
--     keeping the raw sentence in `details.unmappedRaise`. This follows the
--     existing `tr_rel_parent_epic` precedent: a lowercase sentence is a message,
--     not a new reason code, so `DB_RAISE_CODES` does not grow.
--
-- Append-only: 0001 … 0040 are never edited.

-- A review card is a loop artefact. Reopening the *original* is what produces
-- the next round's review; a reopened review card would point at a round that is
-- already history. The app refuses this in `moveStatus`; this is the same rule.
CREATE TRIGGER tr_tasks_review_no_reopen BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status = 'todo'
 AND NEW.review_of_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'INVALID_TRANSITION');
END;

-- The parent edge is containment. A review card is a work item about another
-- card, not a container, and it must not become a child either (its round and
-- its own acceptance would then be part of an epic rollup).
CREATE TRIGGER tr_rel_review_no_parent BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND (
   (SELECT review_of_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
   OR (SELECT review_of_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'a review card cannot be a parent or a child');
END;

-- A review card is never itself reviewed: one delivery, one independent review,
-- one verdict. The `acceptance_mode = 'off'` clause keeps this trigger disjoint
-- from the 0040 review-card-mode trigger (a non-off review card is that
-- trigger's finding, and the two must not race to raise different codes).
CREATE TRIGGER tr_tasks_review_not_review BEFORE INSERT ON tasks
WHEN NEW.review_of_id IS NOT NULL
 AND NEW.acceptance_mode = 'off'
 AND (SELECT review_of_id FROM tasks WHERE id = NEW.review_of_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a review cannot itself be reviewed');
END;
