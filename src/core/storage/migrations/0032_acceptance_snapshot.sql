-- 0032_acceptance_snapshot.sql — the card's acceptance baseline becomes a
-- frozen column instead of a patchable meta key.
--
-- Why a column: `meta_json` is a writable bag. A worker could otherwise shrink
-- `meta.acceptance` immediately before `done` and make the coverage gate pass
-- vacuously. 0025 and 0031 already made the same ruling for the review marker
-- and the review decision; this is the acceptance half of it.
--
-- The snapshot is seeded once (create / first claim / migration backfill) and
-- thereafter only grows. A prune needs a human and an audited
-- `acceptance_pruned` activity with a reason; the trigger below is the raw-write
-- guarantee. `acceptance_revision` is both the optimistic-lock counter and the
-- audit trail: every change to the JSON must advance it by exactly one.
--
-- The `in_review` grandfather: cards already in flight were delivered against a
-- report written before this column existed. Backfilling them would make their
-- current-round report retroactively fail a baseline it never saw, so they keep
-- an empty baseline (vacuously covered) until they are reworked into a new
-- round. New deliveries from the work cycle are seeded normally.
--
-- Append-only: 0001 … 0031 are never edited.

-- ---------------------------------------------------------------------------
-- 1 · The frozen baseline and its revision
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN acceptance_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(acceptance_json) AND json_type(acceptance_json) = 'array');

ALTER TABLE tasks ADD COLUMN acceptance_revision INTEGER NOT NULL DEFAULT 0
  CHECK (acceptance_revision >= 0);

-- ---------------------------------------------------------------------------
-- 2 · Backfill the cards that are not mid-delivery
-- ---------------------------------------------------------------------------
--
-- Modern `meta.acceptance` (a string array) wins; `meta.acceptance_legacy`
-- (`{text, checked}`) is the fallback. `checked` is never evidence — only the
-- text is carried. The SQL is deliberately best-effort: the JS reader applies
-- NFKC/whitespace normalisation, so the seed only has to be a faithful list of
-- trimmed, non-empty strings. Review cards get the 64-item ceiling because
-- their list is the original's up-to-60 plus the generic checks.

UPDATE tasks
SET acceptance_json = (
  SELECT json_group_array(value)
  FROM (
    SELECT MIN(value) AS value
    FROM (
      SELECT trim(j.value) AS value, 0 AS src, j.key AS k
      FROM json_each(
        CASE
          WHEN json_type(COALESCE(json_extract(tasks.meta_json, '$.acceptance'), '[]')) = 'array'
            THEN COALESCE(json_extract(tasks.meta_json, '$.acceptance'), '[]')
          ELSE '[]'
        END
      ) j
      WHERE j.type = 'text' AND trim(j.value) <> ''

      UNION ALL

      SELECT trim(json_extract(j.value, '$.text')) AS value, 1 AS src, j.key AS k
      FROM json_each(
        CASE
          WHEN json_type(COALESCE(json_extract(tasks.meta_json, '$.acceptance_legacy'), '[]')) = 'array'
            THEN COALESCE(json_extract(tasks.meta_json, '$.acceptance_legacy'), '[]')
          ELSE '[]'
        END
      ) j
      WHERE j.type = 'object'
        -- `typeof` is SQLite's value-type test. `json_type` would try to parse
        -- the extracted prose as JSON and raise "malformed JSON".
        AND typeof(json_extract(j.value, '$.text')) = 'text'
        AND trim(json_extract(j.value, '$.text')) <> ''
        -- Modern wins: the legacy checkboxes are only the fallback when the
        -- card has no modern list at all.
        AND json_array_length(
          CASE
            WHEN json_type(COALESCE(json_extract(tasks.meta_json, '$.acceptance'), '[]')) = 'array'
              THEN COALESCE(json_extract(tasks.meta_json, '$.acceptance'), '[]')
            ELSE '[]'
          END
        ) = 0
    )
    GROUP BY lower(value)
    ORDER BY MIN(src), MIN(k)
    -- 64 is the report's own ceiling. The user-facing 60-item cap is enforced
    -- by `normalizeAcceptanceList` on create/update; the extra room here is for
    -- a review card's original-plus-generic list. A backfill is best-effort:
    -- a pathological `meta.acceptance` is bounded rather than rejected.
    LIMIT 64
  )
)
WHERE tasks.status <> 'in_review'
  AND (
    json_array_length(
      CASE
        WHEN json_type(COALESCE(json_extract(tasks.meta_json, '$.acceptance'), '[]')) = 'array'
          THEN COALESCE(json_extract(tasks.meta_json, '$.acceptance'), '[]')
        ELSE '[]'
      END
    ) > 0
    OR json_array_length(
      CASE
        WHEN json_type(COALESCE(json_extract(tasks.meta_json, '$.acceptance_legacy'), '[]')) = 'array'
          THEN COALESCE(json_extract(tasks.meta_json, '$.acceptance_legacy'), '[]')
        ELSE '[]'
      END
    ) > 0
  );

UPDATE tasks
SET acceptance_revision = 1
WHERE json_array_length(acceptance_json) > 0;

-- ---------------------------------------------------------------------------
-- 3 · The raw-write guarantees
-- ---------------------------------------------------------------------------

-- Any change to the JSON advances the revision by exactly one. The command
-- layer uses this for optimistic concurrency; a raw writer that forgets it is
-- refused rather than silently rewriting the baseline.
CREATE TRIGGER tr_tasks_acceptance_revision
BEFORE UPDATE OF acceptance_json ON tasks
WHEN NEW.acceptance_json IS NOT OLD.acceptance_json
 AND NEW.acceptance_revision IS NOT OLD.acceptance_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_SNAPSHOT_IMMUTABLE');
END;

-- Old items are never dropped or rewritten silently. A shrink (or a same-length
-- rewrite that removes an old item) needs an audited `acceptance_pruned`
-- activity with a reason of at least eight characters, written by the same
-- command transaction. The check is coarse — it does not tie the activity to
-- this revision — but the command layer is the only supported writer, and the
-- trigger still makes a bare `UPDATE ... SET acceptance_json = '[]'` fail.
CREATE TRIGGER tr_tasks_acceptance_prune_audited
BEFORE UPDATE OF acceptance_json ON tasks
WHEN NEW.acceptance_json IS NOT OLD.acceptance_json
 AND EXISTS (
   SELECT 1
   FROM json_each(OLD.acceptance_json) o
   WHERE o.value NOT IN (SELECT value FROM json_each(NEW.acceptance_json))
 )
 AND NOT EXISTS (
   SELECT 1
   FROM task_activities a
   WHERE a.task_id = NEW.id
     AND a.event = 'acceptance_pruned'
     AND length(trim(json_extract(a.changes_json, '$.reason'))) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_SNAPSHOT_IMMUTABLE');
END;

-- `not_applicable` is a verdict, not a shrug: it has to say why. The service
-- layer validates the same rule (`validateReport`); this is the raw-write half.
CREATE TRIGGER tr_reports_not_applicable_note
BEFORE INSERT ON task_reports
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.acceptance_json)
  WHERE json_extract(value, '$.status') = 'not_applicable'
    AND (
      json_extract(value, '$.note') IS NULL
      OR length(trim(json_extract(value, '$.note'))) = 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'REPORT_NOT_APPLICABLE_NOTE');
END;
