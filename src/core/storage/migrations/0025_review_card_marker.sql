-- 0025_review_card_marker.sql — a review card's identity becomes structural.
--
-- ---------------------------------------------------------------------------
-- Why the marker cannot stay in `meta_json`
-- ---------------------------------------------------------------------------
--
-- A review card is an ordinary `kind = 'task'` card the loop creates to carry an
-- independent `VERDICT:` report for another card. Until this file its identity
-- lived only in `meta.review_of` (plus `meta.review_round`), and `meta` is a
-- *patchable* field: `PATCH /tasks/:ref` merges it. That was harmless while the
-- only thing reading it was the loop's dispatch; it stops being harmless once
-- the acceptance policy exempts review cards from the human/board rule — any
-- writer that could add `meta.review_of` to a card would mint itself the
-- exemption. The identity therefore moves into two columns, written at creation
-- and immutable afterwards.
--
-- `meta.review_of` keeps being written by the loop: it is an **identifier**
-- (the key the loop and the SLA patrol match on), while the column is the
-- internal task **id**. Both are kept, and `workflow.mjs` reads the columns
-- first with the meta value as the compatibility fallback.
--
-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------
--
-- Existing boards hold the reference as an identifier (`PROJ-0007`), not as a
-- task id, so the correlated subquery matches **either** spelling within the
-- card's own project. A reference that resolves to nothing (a deleted card, a
-- typo, a cross-project name) leaves the column NULL: fail closed, because the
-- exemption must never be inferred from a dangling name.
--
-- `review_round` is copied only when it parses as a positive integer **and** the
-- card really is a review card. A round without a marker is meaningless (the
-- card is not exempt, and the round would describe nothing), so it stays NULL.
--
-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
--
-- The trigger refuses every change to either column after the INSERT — NULL →
-- value as well as value → value. That is what makes "I can make this card a
-- review card" impossible through any UPDATE. `createTask` writes the marker in
-- the INSERT itself; a later writer that needs to repair a board uses a
-- migration, not an UPDATE.
--
-- Append-only: 0001 … 0024 are never edited.

ALTER TABLE tasks ADD COLUMN review_of_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN review_round INTEGER CHECK (review_round IS NULL OR review_round > 0);

UPDATE tasks
   SET review_of_id = (
     SELECT parent.id
       FROM tasks parent
      WHERE parent.project_id = tasks.project_id
        AND (
          parent.id = COALESCE(
            json_extract(tasks.meta_json, '$.review_of'),
            json_extract(tasks.meta_json, '$.legacy.review_of')
          )
          OR parent.identifier = COALESCE(
            json_extract(tasks.meta_json, '$.review_of'),
            json_extract(tasks.meta_json, '$.legacy.review_of')
          )
        )
      LIMIT 1
   )
 WHERE tasks.review_of_id IS NULL
   AND json_valid(tasks.meta_json)
   AND COALESCE(
         json_extract(tasks.meta_json, '$.review_of'),
         json_extract(tasks.meta_json, '$.legacy.review_of')
       ) IS NOT NULL;

UPDATE tasks
   SET review_round = CAST(
         COALESCE(
           json_extract(tasks.meta_json, '$.review_round'),
           json_extract(tasks.meta_json, '$.legacy.review_round')
         ) AS INTEGER
       )
 WHERE tasks.review_of_id IS NOT NULL
   AND tasks.review_round IS NULL
   AND json_valid(tasks.meta_json)
   AND CAST(
         COALESCE(
           json_extract(tasks.meta_json, '$.review_round'),
           json_extract(tasks.meta_json, '$.legacy.review_round')
         ) AS INTEGER
       ) > 0;

CREATE INDEX ix_tasks_review_of ON tasks(review_of_id) WHERE review_of_id IS NOT NULL;

CREATE TRIGGER tr_tasks_review_marker_immutable
BEFORE UPDATE OF review_of_id, review_round ON tasks
WHEN OLD.review_of_id IS NOT NEW.review_of_id
  OR OLD.review_round IS NOT NEW.review_round
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_OF_IMMUTABLE');
END;
