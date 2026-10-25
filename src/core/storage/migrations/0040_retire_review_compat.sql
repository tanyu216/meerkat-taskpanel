-- 0040_retire_review_compat.sql — one acceptance word, one place to write it.
--
-- 0038 introduced `projects.acceptance` / `tasks.acceptance_mode` and kept the
-- old spelling alive for one release: `projects.review_policy`,
-- `tasks.review_required`, and the two triggers that mirrored the card pair.
-- The compatibility window is closed here. Keeping both representations had a
-- real cost — the two columns could disagree, and every new write had to keep
-- them in step — while its only benefit was that an old CLI invocation still
-- worked. The application stopped reading and writing the legacy columns first;
-- this file removes them from the schema (test/contract/sql-parity.test.mjs
-- compares the vocabulary both ways).
--
-- ---------------------------------------------------------------------------
-- Order matters
-- ---------------------------------------------------------------------------
--
-- SQLite refuses `DROP COLUMN` while any trigger still names the column, and it
-- refuses *silently enough* to be dangerous: the failure is reported as an
-- error in the trigger. So every object that names a retired column is dropped
-- **before** the columns go, and the two that must survive are re-created with
-- the retired name removed from their text.
--
-- ---------------------------------------------------------------------------
-- What replaces the mirror pair
-- ---------------------------------------------------------------------------
--
--   `tr_tasks_acceptance_mode_ins` / `_upd` — 0038's two jobs collapse into one:
--   a review card is always `off` (flow B is never reviewed again). The other
--   job, `acceptance_mode = agent ⇔ review_required = 1`, has no column left to
--   disagree with.
--
-- `REVIEW_CARD_MARKER_INVALID` stays the refusal code, and 0031's two
-- review-card triggers (`tr_tasks_review_card_not_required*`) are subsumed:
-- both predates the mode column and checked only the retired integer.
--
-- Append-only: 0001 … 0039 are never edited.

-- The objects that name a retired column, in dependency order.
DROP TRIGGER IF EXISTS tr_tasks_acceptance_mode_ins;
DROP TRIGGER IF EXISTS tr_tasks_acceptance_mode_upd;
DROP TRIGGER IF EXISTS tr_tasks_review_card_not_required;
DROP TRIGGER IF EXISTS tr_tasks_review_card_not_required_update;
DROP TRIGGER IF EXISTS tr_rev_tasks_upd;
DROP TRIGGER IF EXISTS tr_rev_projects_upd;

-- No table rebuild: an inline column CHECK is dropped with its column, and
-- neither column is indexed or referenced by a foreign key.
ALTER TABLE tasks DROP COLUMN review_required;
ALTER TABLE projects DROP COLUMN review_policy;

-- A review card is never a review target. (The 0038 pair enforced this
-- alongside the mirror; this is the half that remains a rule.)
CREATE TRIGGER tr_tasks_acceptance_mode_ins BEFORE INSERT ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.acceptance_mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

CREATE TRIGGER tr_tasks_acceptance_mode_upd
BEFORE UPDATE OF acceptance_mode, review_of_id ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.acceptance_mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

-- The revision cursors, re-created with the retired columns removed from their
-- column lists and every other name preserved verbatim.

CREATE TRIGGER tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_id, reporter_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at,
  report_waiver_round, report_waiver_reason, report_waived_at,
  awaiting_reason, acceptance_mode ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER tr_rev_projects_upd AFTER UPDATE OF
  name, labels, meta_json, readme, archived_at, updated_at,
  reviewer, acceptance ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
