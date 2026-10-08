-- 0003_reports.sql — the Report entity and the HARD delivery gate.
--
-- ARCHITECTURE §4.5 / card acceptance A6–A8:
--   * a report is a first-class, append-only row per (task, delivery round);
--   * `→ in_review` is impossible without a report for the *current* round;
--   * round = one delivery attempt: every exit from `in_review` that is not
--     `done` starts the next attempt, so last round's report cannot be reused
--     (F3).
--
-- There is deliberately NO escape hatch (F4): no `--no-report --reason`
-- column, no waiver branch. The gate is hard, in the trigger and in the
-- service. Enabling a waiver later means a new migration *plus* auditing it as
-- `report_waived`.

CREATE TABLE IF NOT EXISTS task_reports (
  id               INTEGER PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  round            INTEGER NOT NULL CHECK (round >= 1),
  seg              TEXT,
  session_id       TEXT,
  conclusion       TEXT NOT NULL CHECK (length(trim(conclusion)) > 0),
  acceptance_json  TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  leftovers        TEXT,
  author_kind      TEXT NOT NULL CHECK (author_kind IN ('agent','human','system')),
  author_id        TEXT NOT NULL,
  source_seq       INTEGER,
  created_at       TEXT NOT NULL,
  -- F5: one report per (task, round) — "the conclusion for round N" is unique.
  UNIQUE (task_id, round)
) STRICT;

-- No separate index on (task_id, round): the UNIQUE constraint above already
-- creates one, and `EXPLAIN QUERY PLAN` confirms the gate uses it
-- (test/contract/invariants.test.mjs).

-- `report_latest_id` points at the newest report. It is added by ALTER rather
-- than declared in 0001 for two reasons: migrations are append-only, and the
-- ownership rule is a trigger below rather than a FOREIGN KEY (a self-referencing
-- FK from tasks to task_reports is not expressible in the 0001 ordering).
ALTER TABLE tasks ADD COLUMN report_latest_id INTEGER;
-- Every task starts on its first delivery attempt (F3).
ALTER TABLE tasks ADD COLUMN delivery_round INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Append-only history (A6)
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS tr_reports_no_update BEFORE UPDATE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_reports_no_delete BEFORE DELETE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- report_latest_id must belong to this task
-- ---------------------------------------------------------------------------
--
-- `IS NOT` rather than `<>`: with `<>`, a subquery that finds no row yields
-- NULL, `NULL <> NEW.id` is NULL, the WHEN clause is false and the write is
-- silently allowed (plan §3.3.6⑤). `IS NOT` also rejects a bogus id, which is
-- what we want.
CREATE TRIGGER IF NOT EXISTS tr_latest_report_belongs BEFORE UPDATE OF report_latest_id ON tasks
WHEN NEW.report_latest_id IS NOT NULL
 AND (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'REPORT_TASK_MISMATCH');
END;

-- ---------------------------------------------------------------------------
-- THE GATE (A7) — no report for the current round ⇒ no in_review
-- ---------------------------------------------------------------------------
--
-- Two deliberate refinements over the plan's sketch, both to keep the reason
-- code deterministic when several guards could fire on one UPDATE:
--
--   1. `OLD.status IN ('in_progress','blocked')` — `in_review` is reachable
--      only from those two, so this is equivalent to `OLD.status <> 'in_review'`
--      for every whitelisted transition, while being disjoint from
--      tr_tasks_terminal (whose OLD.status is terminal) and from
--      tr_tasks_transition (which only speaks when NEW.status is not allowed).
--   2. the third clause — a *bad* report_latest_id is tr_latest_report_belongs'
--      business, and it now cannot be reported as REPORT_REQUIRED by mistake.
CREATE TRIGGER IF NOT EXISTS tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND OLD.status IN ('in_progress','blocked')
 AND (NEW.report_latest_id IS NULL
      OR (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM task_reports WHERE task_id = NEW.id AND round = NEW.delivery_round
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

-- ---------------------------------------------------------------------------
-- Round bump (F3)
-- ---------------------------------------------------------------------------
--
-- AFTER UPDATE: the gate above has already had its say. The nested UPDATE
-- touches only `delivery_round`, which is excluded from tr_rev_tasks_upd's
-- column domain, so a delivery that comes back costs exactly one revision.
CREATE TRIGGER IF NOT EXISTS tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- global_revision for task_reports
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS tr_rev_task_reports_ins AFTER INSERT ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_task_reports_upd AFTER UPDATE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_task_reports_del AFTER DELETE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
