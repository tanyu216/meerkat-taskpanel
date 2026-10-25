-- 0038_acceptance_mode.sql — one acceptance vocabulary.
--
-- The board used to answer "who may close this card?" with two orthogonal axes:
-- the project's `review_policy` (required | optional | off) and the board's
-- `TASKD_ACCEPTANCE_POLICY` (human-only | both | agent-only), further split by a
-- card's scope (child / review card / top-level). Three axes produced a 3×3
-- matrix and two documented dead configurations. This migration starts the
-- collapse into one word:
--
--   * `projects.acceptance` — `auto | off | agent | human`; `auto` means "the
--     creator (in practice the loop) decides per card";
--   * `tasks.acceptance_mode` — `off | agent | human`; the resolved snapshot.
--     `auto` is never stored on a card — an unresolved card has no owner.
--
-- 0038 is deliberately **additive**. The legacy columns are still written and
-- still drive behaviour for one release; the new column is the decision the next
-- phases read. 0039 retires `review_required` / `review_policy`.
--
-- ---------------------------------------------------------------------------
-- What each mode means
-- ---------------------------------------------------------------------------
--
--   `off`   — no review. The deliverer (or the board, or a human) may close it;
--             `in_progress → done` is the direct path.
--   `agent` — an independent agent review card must APPROVE first; the loop
--             applies the verdict and closes the card. A human may also close.
--   `human` — only a human closes; no review card is dispatched.
--
-- `deploy` is not an acceptance rule. Whether a card belongs to a release line
-- is the loop's own decision; the board only stores the mode the loop chose.
--
-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Projects: `required → agent`, `optional → auto`, `off → off`. The old
-- `optional` project let the creator decide, so `auto` is its faithful twin.
--
-- Cards: `review_required = 1 → agent`. A card at 0 becomes `off`, except an
-- in-flight `in_review` card — that one becomes `human`. This is a one-time
-- conservative stop: before 0038 a human-only board would leave that delivery
-- for a human, and the first reconcile tick after an upgrade must not silently
-- auto-accept it. Review cards are always `off` (flow B is never reviewed).
--
-- ---------------------------------------------------------------------------
-- The compatibility mirror
-- ---------------------------------------------------------------------------
--
-- `review_required` is kept for one release. The pair must agree:
--
--   review_required = 1  ⇔  acceptance_mode = 'agent'
--   review_required = 0  ⇔  acceptance_mode IN ('off','human')
--
-- and a review card is always `off` / 0. The two triggers below make a raw
-- INSERT/UPDATE that sets only one half impossible, so the dispatch, the done
-- gate and the wire cannot read different answers.
--
-- Append-only: 0001 … 0036 are never edited.

ALTER TABLE projects ADD COLUMN acceptance TEXT NOT NULL DEFAULT 'auto'
  CHECK (acceptance IN ('auto','off','agent','human'));

UPDATE projects SET acceptance =
  CASE review_policy
    WHEN 'required' THEN 'agent'
    WHEN 'off'      THEN 'off'
    ELSE                 'auto'
  END;

ALTER TABLE tasks ADD COLUMN acceptance_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (acceptance_mode IN ('off','agent','human'));

UPDATE tasks SET acceptance_mode =
  CASE
    WHEN review_of_id IS NOT NULL THEN 'off'
    WHEN review_required = 1      THEN 'agent'
    WHEN status = 'in_review'     THEN 'human'
    ELSE                               'off'
  END;

-- ---------------------------------------------------------------------------
-- The mirror invariant (raw writes)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_tasks_acceptance_mode_ins;
CREATE TRIGGER tr_tasks_acceptance_mode_ins BEFORE INSERT ON tasks
WHEN (NEW.review_of_id IS NOT NULL
      AND (NEW.acceptance_mode <> 'off' OR NEW.review_required <> 0))
  OR (NEW.review_of_id IS NULL
      AND (NEW.acceptance_mode <> 'agent') <> (NEW.review_required <> 1))
BEGIN
  SELECT CASE
    WHEN NEW.review_of_id IS NOT NULL THEN RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID')
    ELSE RAISE(ABORT, 'ACCEPTANCE_MODE_CONFLICT')
  END;
END;

DROP TRIGGER IF EXISTS tr_tasks_acceptance_mode_upd;
CREATE TRIGGER tr_tasks_acceptance_mode_upd
BEFORE UPDATE OF acceptance_mode, review_required, review_of_id ON tasks
WHEN (NEW.review_of_id IS NOT NULL
      AND (NEW.acceptance_mode <> 'off' OR NEW.review_required <> 0))
  OR (NEW.review_of_id IS NULL
      AND (NEW.acceptance_mode <> 'agent') <> (NEW.review_required <> 1))
BEGIN
  SELECT CASE
    WHEN NEW.review_of_id IS NOT NULL THEN RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID')
    ELSE RAISE(ABORT, 'ACCEPTANCE_MODE_CONFLICT')
  END;
END;

-- ---------------------------------------------------------------------------
-- The transition table gains the one direct edge: `off` may go to done
-- ---------------------------------------------------------------------------
--
-- `agent` and `human` still reach done only through `in_review`; `off` may take
-- the direct path. The JS whitelist grows the same overlay in the next phase;
-- the DB is the machine guarantee from here on.

DROP TRIGGER IF EXISTS tr_tasks_transition;
CREATE TRIGGER tr_tasks_transition BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND OLD.status NOT IN ('done','canceled')
BEGIN
  SELECT CASE
    WHEN NOT (
         (OLD.status = 'backlog'     AND NEW.status IN ('todo','canceled'))
      OR (OLD.status = 'todo'        AND NEW.status IN ('backlog','in_progress','blocked','canceled'))
      -- 0024 · the epic overlay.
      OR (OLD.status = 'todo'        AND NEW.status = 'in_review' AND NEW.kind = 'epic')
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','canceled','awaiting'))
      -- 0038 · the off-mode direct path. `agent`/`human` are absent on purpose,
      -- and a review card is flow B: it must deliver its verdict through
      -- `in_review`, so it never gets the shortcut.
      OR (OLD.status = 'in_progress' AND NEW.status = 'done'
          AND NEW.acceptance_mode = 'off' AND NEW.review_of_id IS NULL)
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
      OR (OLD.status = 'awaiting'    AND NEW.status IN ('todo','in_progress','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;

-- ---------------------------------------------------------------------------
-- The done gate reads the mode, not the legacy mirror
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_tasks_review_required_done;
DROP TRIGGER IF EXISTS tr_tasks_acceptance_agent_done;
CREATE TRIGGER tr_tasks_acceptance_agent_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 -- The only legal source for an `agent`/`human` card; checking it keeps this
 -- trigger from masking the whitelist's INVALID_TRANSITION on an illegal pair.
 AND OLD.status = 'in_review'
 AND NEW.acceptance_mode = 'agent'
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

-- A direct `off` delivery still owes the baseline's evidence. The delivery gate
-- (0035) only speaks about `in_review`; this is its direct-done twin. An empty
-- baseline is vacuous, exactly as `assertAcceptanceCoverage` reads it.
DROP TRIGGER IF EXISTS tr_deliver_gate_done;
CREATE TRIGGER tr_deliver_gate_done BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND OLD.status = 'in_progress'
 AND NEW.acceptance_mode = 'off'
 AND NEW.acceptance_json NOT IN ('[]','')
 AND NOT EXISTS (
   SELECT 1 FROM task_reports
    WHERE task_id = NEW.id AND round = NEW.delivery_round
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

-- The epic rollup gate must cover the direct path too.
DROP TRIGGER IF EXISTS tr_tasks_epic_rollup_done;
CREATE TRIGGER tr_tasks_epic_rollup_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND NEW.kind = 'epic'
 -- The legal done sources: the ordinary acceptance exit, or the `off` direct
 -- edge. Anything else is the transition trigger's refusal, not this one.
 AND (OLD.status = 'in_review'
      OR (OLD.status = 'in_progress' AND NEW.acceptance_mode = 'off'))
 AND NOT EXISTS (
   SELECT 1 FROM task_reports r
    WHERE r.task_id = NEW.id
      AND r.round = NEW.delivery_round
      AND r.is_rollup = 1
 )
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_REQUIRED');
END;

-- ---------------------------------------------------------------------------
-- Revision cursors: the new columns produce SSE frames
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_rev_tasks_upd;
CREATE TRIGGER tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_id, reporter_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at,
  report_waiver_round, report_waiver_reason, report_waived_at,
  awaiting_reason, acceptance_mode, review_required ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_projects_upd;
CREATE TRIGGER tr_rev_projects_upd AFTER UPDATE OF
  name, labels, meta_json, readme, archived_at, updated_at,
  review_policy, reviewer, acceptance ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
