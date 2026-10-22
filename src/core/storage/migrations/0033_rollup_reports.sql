-- 0033_rollup_reports.sql — an epic's delivery is a rollup over its children.
--
-- Before this migration an epic's `in_review` accepted *any* delivery report for
-- the current round. The board's own `advanceContainer` wrote a proper rollup
-- (one acceptance item per child), but a hand-written `deliver` on the epic — or
-- a waiver — could satisfy the gate with a report that never mentioned a child.
-- The done gate then checked nothing at all: "every child terminal" was the
-- whole rule, so a container could be accepted in a round whose rollup was stale
-- or absent.
--
-- The marker is the report's, not the epic's: a report either is a rollup or it
-- is not, and only the board's readers need to tell them apart. `is_rollup` is
-- set by the writer (the board's `advanceContainer` and a manual `writeReport` /
-- `deliver` on an epic), never by a caller-supplied field — `validateReport`
-- does not read it, so a report payload cannot forge the marker.
--
-- Two triggers, one meaning each:
--
--   * `tr_reports_rollup_valid` — a rollup row must be a *delivery* report
--     (`origin='delivery'`) on an *epic*. An imported narrative cannot be one
--     (it was never checked, exactly as 0008 argues for the gate), and a
--     rollup on an ordinary card or a review card is a caller bug.
--   * `tr_tasks_epic_rollup_done` — an epic may not reach `done` without a
--     rollup row for its **current** `delivery_round`. A rework bumps the round,
--     so a rollup written for round N is history after an `in_review →
--     in_progress`; the board must roll up again.
--
-- `tasks.report_latest_id` is deliberately not consulted: the rule is about a
-- row for the round, and the indicator may point at a different (newer) report.
--
-- Append-only: a plain ALTER plus new triggers. No table is rebuilt.

ALTER TABLE task_reports ADD COLUMN is_rollup INTEGER NOT NULL DEFAULT 0
  CHECK (is_rollup IN (0, 1));

-- Existing rows keep the default 0. Every rollup on a board that predates this
-- migration is unmarked, which is why the done guard is a *new* refusal and not
-- a retro-active one: a historical `done` epic is not re-checked.

CREATE TRIGGER tr_reports_rollup_valid
BEFORE INSERT ON task_reports
WHEN NEW.is_rollup = 1
 AND (
   NEW.origin <> 'delivery'
   OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND kind = 'epic')
 )
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_INVALID');
END;

CREATE TRIGGER tr_tasks_epic_rollup_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND NEW.kind = 'epic'
 -- Only the legal edge. Without this the trigger would also answer an illegal
 -- `backlog → done` with ROLLUP_REQUIRED, masking the whitelist's own verdict
 -- (`INVALID_TRANSITION` / `TERMINAL_STATE`) — a refusal about the *wrong* thing.
 AND OLD.status = 'in_review'
 AND NOT EXISTS (
   SELECT 1 FROM task_reports r
    WHERE r.task_id = NEW.id
      AND r.round = NEW.delivery_round
      AND r.origin = 'delivery'
      AND r.is_rollup = 1
 )
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_REQUIRED');
END;
