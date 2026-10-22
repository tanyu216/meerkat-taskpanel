-- 0035_drop_report_origin.sql — a report is a report.
--
-- ---------------------------------------------------------------------------
-- Why this removes `origin` instead of exposing it
-- ---------------------------------------------------------------------------
--
-- 0008 added `origin` (`delivery` | `import`) so an imported narrative could not
-- satisfy the delivery gate. It did that job, but the distinction is no longer
-- the board's to make: the only writer that produced `import` was the one-off
-- markdown importer, removed in `dc076e4`. Every remaining write path goes
-- through `insertDeliveryReport`, which hard-coded `delivery` — the gate was
-- defending against a writer that no longer exists.
--
-- The board records reports and enforces their shape; *who* wrote one and
-- whether it is trustworthy is the consumer's judgement. `in_review` therefore
-- means "the current round has a report", not "a delivery-path report exists".
-- `conclusion` must still be non-empty (the column CHECK), and `deliver`/
-- `writeReport` still run `normalizeReportCreate`; only provenance is gone.
--
-- Consequence, stated plainly: a row that a pre-0035 board called `import` is
-- now an ordinary current-round report and opens the gate. That is the point of
-- this migration, and `test/core/storage/migrations-0035.test.mjs` pins it.
--
-- Append-only: 0001 … 0034 are never edited. SQLite has no `DROP COLUMN` once a
-- CHECK has referenced the column, so this follows the established rebuild
-- (`CREATE new → copy → DROP old → RENAME`). Every index and trigger is
-- re-created, and the four triggers on *other* tables whose bodies name
-- `task_reports` are parked first: a trigger body is re-validated on a schema
-- change, and a body naming a momentarily-absent table is fatal (0020's rule).

-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- 1 · Park the triggers that live elsewhere and name `task_reports`
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_latest_report_belongs;   -- 0003
DROP TRIGGER IF EXISTS tr_deliver_gate;            -- 0024
DROP TRIGGER IF EXISTS tr_tasks_epic_rollup_done;  -- 0033
DROP TRIGGER IF EXISTS tr_dict_actors_delete;      -- 0034

-- ---------------------------------------------------------------------------
-- 2 · Rebuild `task_reports` without `origin`
-- ---------------------------------------------------------------------------

-- 0020's table with `is_rollup` (0033) declared in place and `origin` removed.
CREATE TABLE task_reports_no_origin (
  id               INTEGER PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  round            INTEGER NOT NULL CHECK (round >= 1),
  seg              TEXT,
  session_id       TEXT,
  conclusion       TEXT NOT NULL CHECK (length(trim(conclusion)) > 0),
  acceptance_json  TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  leftovers        TEXT,
  author_kind      TEXT NOT NULL,
  author_id        TEXT NOT NULL REFERENCES actors(id),
  source_seq       INTEGER,
  created_at       TEXT NOT NULL,
  is_rollup        INTEGER NOT NULL DEFAULT 0 CHECK (is_rollup IN (0, 1)),
  UNIQUE (task_id, round)
) STRICT;

INSERT INTO task_reports_no_origin (
  id, task_id, round, seg, session_id, conclusion, acceptance_json, evidence_json,
  leftovers, author_kind, author_id, source_seq, created_at, is_rollup
)
SELECT
  r.id, r.task_id, r.round, r.seg, r.session_id, r.conclusion, r.acceptance_json, r.evidence_json,
  r.leftovers, r.author_kind, r.author_id, r.source_seq, r.created_at, r.is_rollup
FROM task_reports r;

DROP TABLE task_reports;
ALTER TABLE task_reports_no_origin RENAME TO task_reports;

-- ---------------------------------------------------------------------------
-- 3 · The triggers that live on `task_reports`
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_reports_no_update;
CREATE TRIGGER tr_reports_no_update BEFORE UPDATE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS tr_reports_no_delete;
CREATE TRIGGER tr_reports_no_delete BEFORE DELETE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS tr_rev_task_reports_ins;
CREATE TRIGGER tr_rev_task_reports_ins AFTER INSERT ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_task_reports_upd;
CREATE TRIGGER tr_rev_task_reports_upd AFTER UPDATE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_task_reports_del;
CREATE TRIGGER tr_rev_task_reports_del AFTER DELETE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

-- 0032 verbatim: `not_applicable` is a verdict and must say why.
DROP TRIGGER IF EXISTS tr_reports_not_applicable_note;
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

-- 0033 with the `origin` clause removed: a rollup is structurally a marked row
-- on an epic, and nothing about who wrote it matters.
DROP TRIGGER IF EXISTS tr_reports_rollup_valid;
CREATE TRIGGER tr_reports_rollup_valid
BEFORE INSERT ON task_reports
WHEN NEW.is_rollup = 1
 AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND kind = 'epic')
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_INVALID');
END;

-- ---------------------------------------------------------------------------
-- 4 · The parked triggers, re-created
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_latest_report_belongs;
CREATE TRIGGER tr_latest_report_belongs BEFORE UPDATE OF report_latest_id ON tasks
WHEN NEW.report_latest_id IS NOT NULL
 AND (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'REPORT_TASK_MISMATCH');
END;

-- 0024's gate, with the `origin = 'delivery'` clause removed. Everything else —
-- the epic `todo` arming edge, the `report_latest_id` ownership clause and the
-- audited waiver — is verbatim.
DROP TRIGGER IF EXISTS tr_deliver_gate;
CREATE TRIGGER tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND (OLD.status IN ('in_progress','blocked')
      OR (OLD.status = 'todo' AND NEW.kind = 'epic'))
 AND (NEW.report_latest_id IS NULL
      OR (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM task_reports
   WHERE task_id = NEW.id AND round = NEW.delivery_round
 )
 AND NOT (
   NEW.report_waiver_round IS NEW.delivery_round
   AND NEW.report_waiver_reason IS NOT NULL
   AND length(trim(NEW.report_waiver_reason)) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

-- 0033's done guard, likewise without the provenance clause: a current-round
-- rollup is required, not a current-round delivery-origin rollup.
DROP TRIGGER IF EXISTS tr_tasks_epic_rollup_done;
CREATE TRIGGER tr_tasks_epic_rollup_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND NEW.kind = 'epic'
 AND OLD.status = 'in_review'
 AND NOT EXISTS (
   SELECT 1 FROM task_reports r
    WHERE r.task_id = NEW.id
      AND r.round = NEW.delivery_round
      AND r.is_rollup = 1
 )
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_REQUIRED');
END;

-- 0034 verbatim: an actor still referenced by a report cannot be deleted.
DROP TRIGGER IF EXISTS tr_dict_actors_delete;
CREATE TRIGGER tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE claimed_by = OLD.id)
  OR EXISTS (SELECT 1 FROM comments WHERE author_id = OLD.id)
  OR EXISTS (SELECT 1 FROM task_reports WHERE author_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;
