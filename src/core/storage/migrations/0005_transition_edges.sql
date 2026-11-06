-- 0005 — two direct exits out of the work cycle (TP-0125).
--
-- `tr_tasks_transition` is the database's copy of
-- `src/core/domain/status.mjs#ALLOWED_TRANSITIONS`; 0004 last rebuilt it. The
-- pair set gains exactly two edges:
--
--   * `in_progress → backlog` — leaving the work does not have to re-enter
--     `todo` (which the poll would claim again on the way out);
--   * `in_review → canceled` — a delivered card abandoned at review is one
--     move, not `→ in_progress → canceled`.
--
-- Nothing else moves. `tr_tasks_round_bump`, the terminal trigger and the
-- delivery gate are untouched: a terminal move from `in_review` does not bump
-- the round, and the reopen family still does. The table is not rebuilt, so no
-- `@foreign-keys: off` pragma is needed.
--
-- Migrations are append-only: the old trigger is dropped by name and recreated
-- from 0004's body with only the two clauses widened.

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
      -- TP-0125 · `backlog` joins the exits: a released card must not be
      -- re-claimed through `todo` on its way out of the work.
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','backlog','canceled','awaiting'))
      -- 0038 · the off-mode direct path. `auto`/`human` are absent on purpose,
      -- and a review card is flow B: it must deliver its verdict through
      -- `in_review`, so it never gets the shortcut. The CHECK keeps every
      -- `kind='review'` row on the marker branch.
      OR (OLD.status = 'in_progress' AND NEW.status = 'done'
          AND NEW.acceptance_mode = 'off' AND NEW.review_of_id IS NULL)
      -- TP-0125 · `canceled` joins the exits: a terminal move from review is
      -- one edge and does not bump the round (see `tr_tasks_round_bump`).
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked','canceled'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
      OR (OLD.status = 'awaiting'    AND NEW.status IN ('todo','in_progress','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;
