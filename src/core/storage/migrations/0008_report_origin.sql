-- 0008_report_origin.sql — a report written by the md importer is history, not delivery.
--
-- The md importer writes a card's `## Report` into `task_reports` so a migrated
-- board arrives with its delivery history intact. `c668bf4` widened that path to
-- also import a *degraded* report — a free-form narrative, or a structured report
-- with no evidence block — by inserting a row with `acceptance_json='[]'` /
-- `evidence_json='[]'` and pointing `tasks.report_latest_id` at it.
--
-- That is right for history, but it quietly satisfied the delivery gate: the gate
-- only asked "is there a report for the current round?", so an imported narrative
-- let a card move to `in_review` — the exact end-to-end regression the drill
-- caught. An imported report was never checked by `normalizeReportCreate`, so it
-- is not evidence of a delivery and must never open the gate. (Before c668bf4 the
-- same card was refused `REPORT_REQUIRED`; this migration restores that without
-- withdrawing history import: the row is still written, tagged `origin='import'`.)
--
-- The distinction is the *writer*:
--
--   * the delivery path (`writeReport` / `deliver`, whose content is validated
--     non-empty by `normalizeReportCreate`) writes `origin='delivery'`;
--   * the importer writes `origin='import'`, whatever shape the card's report took.
--
-- The gate then counts only `origin='delivery'` rows, so "acceptance and evidence
-- are present" holds by construction and the domain and the trigger can judge a
-- move to `in_review` identically.

ALTER TABLE task_reports ADD COLUMN origin TEXT NOT NULL DEFAULT 'delivery' CHECK (origin IN ('delivery','import'));

-- ---------------------------------------------------------------------------
-- The gate, re-created with the origin clause
-- ---------------------------------------------------------------------------
--
-- Everything is 0006 verbatim — the waiver branch and the `report_latest_id`
-- ownership clause included (the comments there explain both) — with one added
-- term: the `NOT EXISTS` subquery now also requires `origin = 'delivery'`. A row
-- the importer wrote is invisible to the gate; a row `writeReport`/`deliver`
-- wrote is exactly what it asks for.
--
-- Migrations are append-only, so this file DROPs and re-CREATEs the trigger
-- rather than editing 0006.
DROP TRIGGER IF EXISTS tr_deliver_gate;
CREATE TRIGGER tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND OLD.status IN ('in_progress','blocked')
 AND (NEW.report_latest_id IS NULL
      OR (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM task_reports
   WHERE task_id = NEW.id AND round = NEW.delivery_round AND origin = 'delivery'
 )
 AND NOT (
   NEW.report_waiver_round IS NEW.delivery_round
   AND NEW.report_waiver_reason IS NOT NULL
   AND length(trim(NEW.report_waiver_reason)) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;
