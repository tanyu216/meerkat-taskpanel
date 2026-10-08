-- 0006_report_waiver.sql — the audited escape hatch (F-B1).
--
-- 0003 shipped the gate *hard* and said so: "There is deliberately NO escape
-- hatch (F4) … Enabling a waiver later means a new migration *plus* auditing it
-- as `report_waived`." This is that migration, and the card requires it:
-- `--no-report --reason <why>` must exist for the case where a card genuinely
-- cannot carry a report, and it must be *visible* rather than convenient.
--
-- What the waiver is, in full:
--
--   * it is per **delivery round**. `report_waiver_round` must equal the round
--     the task is being delivered in. Coming back from review bumps the round
--     (0003's `tr_tasks_round_bump`), so last round's waiver is dead the moment
--     work resumes — exactly like a report.
--   * it requires a **reason** of at least 8 characters after trimming. A
--     one-letter waiver is not a reason.
--   * it is written on the task row *and* as a `report_waived` activity, so
--     `issue get --json` shows `report_waivers[]` to whoever reviews the card.
--
-- The `RAISE` vocabulary is unchanged: the gate still raises `REPORT_REQUIRED`,
-- it simply has one more condition under which it does not.
-- (test/contract/sql-parity.test.mjs pins that the code set is identical.)
--
-- Migrations are append-only, so this file DROPs and re-CREATEs the two
-- triggers it needs to widen rather than editing 0001/0003.

ALTER TABLE tasks ADD COLUMN report_waiver_round INTEGER;
ALTER TABLE tasks ADD COLUMN report_waiver_reason TEXT;
ALTER TABLE tasks ADD COLUMN report_waived_at TEXT;

-- ---------------------------------------------------------------------------
-- The gate, re-created with the waiver branch
-- ---------------------------------------------------------------------------
--
-- Everything above the last clause is 0003 verbatim — the comments there explain
-- why `OLD.status IN ('in_progress','blocked')` keeps the three status triggers
-- disjoint and why `IS NOT` is used rather than `<>`.
--
-- The added clause is the *only* new way past the gate:
--
--   NEW.report_waiver_round IS NEW.delivery_round   -- this round, not an old one
--   AND NEW.report_waiver_reason IS NOT NULL
--   AND length(trim(NEW.report_waiver_reason)) >= 8 -- a real reason
--
-- `IS` (not `=`) is NULL-safe, which matters: for an ordinary delivery both
-- sides are non-NULL, and for a waiver round is always set — but `IS` keeps the
-- clause false rather than NULL in every other combination, so the WHEN clause
-- never degrades into "unknown".
DROP TRIGGER IF EXISTS tr_deliver_gate;
CREATE TRIGGER tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND OLD.status IN ('in_progress','blocked')
 AND (NEW.report_latest_id IS NULL
      OR (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM task_reports WHERE task_id = NEW.id AND round = NEW.delivery_round
 )
 AND NOT (
   NEW.report_waiver_round IS NEW.delivery_round
   AND NEW.report_waiver_reason IS NOT NULL
   AND length(trim(NEW.report_waiver_reason)) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

-- ---------------------------------------------------------------------------
-- global_revision coverage for the three new columns
-- ---------------------------------------------------------------------------
--
-- 0001 cropped this trigger's column domain on purpose (see the note there about
-- `delivery_round`), and the list must stay a whitelist. The waiver columns are
-- a genuine content change — a reviewer watching the board has to see them — so
-- they join the domain. A waived delivery still costs exactly one revision: the
-- status/version/updated_at columns were already in the list, and one UPDATE
-- fires this trigger once however many of its columns it touches.
DROP TRIGGER IF EXISTS tr_rev_tasks_upd;
CREATE TRIGGER tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at,
  report_waiver_round, report_waiver_reason, report_waived_at ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
