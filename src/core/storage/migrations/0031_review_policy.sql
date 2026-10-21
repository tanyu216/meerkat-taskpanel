-- 0031_review_policy.sql — a per-project review policy, a per-card review
-- decision, and an optional per-project reviewer override.
--
-- ---------------------------------------------------------------------------
-- Why the decision is a task column
-- ---------------------------------------------------------------------------
--
-- `projects.review_policy` is the project's **default** (required | optional |
-- off). `tasks.review_required` is the card's **decision**, resolved at creation
-- and stored here. In an `optional` project two cards can legitimately differ,
-- so the decision cannot be re-derived from the project row. It also must not
-- live in `meta_json`: 0025 exists precisely because an acceptance-relevant fact
-- in a patchable bag is forgeable and invisible to a trigger.
--
-- The decision is a snapshot: changing the project policy later does not rewrite
-- cards already in flight. A human may waive a required card with a reason (the
-- service layer records `review_override`); nothing else rewrites the column.
--
-- ---------------------------------------------------------------------------
-- Why the backfill is conservative
-- ---------------------------------------------------------------------------
--
-- New cards get the column from the creation logic. Cards that already existed
-- before this migration keep the **old** behaviour: every non-review flow-A
-- delivery was dispatched for review. Backfilling them to 1 keeps that, and
-- avoids the alternative — a default of 0 would make the first reconcile tick
-- auto-accept every in-flight `in_review` card.
--
-- 0025 already backfilled the structural marker (including the legacy
-- `meta.review_of` spelling), so `review_of_id IS NULL` is the reliable
-- "ordinary card" predicate here.
--
-- Append-only: 0001 … 0030 are never edited.

ALTER TABLE projects ADD COLUMN review_policy TEXT NOT NULL DEFAULT 'optional'
  CHECK (review_policy IN ('required','optional','off'));

-- An optional per-project reviewer override. NULL means "use the deployment's
-- reviewer" (the loop's --reviewer / MEERKAT_TASKPANEL_REVIEWER / host config).
ALTER TABLE projects ADD COLUMN reviewer TEXT;

ALTER TABLE tasks ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0
  CHECK (review_required BETWEEN 0 AND 1);

-- Conservative backfill: existing ordinary cards keep requiring review; review
-- cards stay 0 (they are flow B and are never dispatched again).
UPDATE tasks SET review_required = 1 WHERE review_of_id IS NULL;

-- A review card is never itself a review target. The resolver forces 0; this
-- trigger is the raw-write guarantee. It also covers the UPDATE direction so a
-- later writer cannot turn an ordinary card into a review card *and* mark it
-- required in the same write.
CREATE TRIGGER tr_tasks_review_card_not_required
BEFORE INSERT ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.review_required <> 0
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

CREATE TRIGGER tr_tasks_review_card_not_required_update
BEFORE UPDATE OF review_of_id, review_required ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.review_required <> 0
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

-- The machine half of "required means a review happened". Deliberately coarse:
-- the DB-checkable fact is the existence of a current-round review card that
-- reached the reviewer (`in_review` or `done`). The APPROVE verdict remains a
-- service-layer rule — the loop moves the original *before* closing the review
-- card, so requiring a terminal review here would deadlock that protocol.
--
-- A `canceled` review does not satisfy the gate; the loop will dispatch a new
-- one for the round.
CREATE TRIGGER tr_tasks_review_required_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND OLD.status <> 'done'
 AND NEW.review_required = 1
 AND NEW.review_of_id IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM tasks review
    WHERE review.review_of_id = NEW.id
      AND review.status IN ('in_review','done')
      AND (review.review_round IS NULL OR review.review_round = NEW.delivery_round)
 )
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_REQUIRED');
END;
