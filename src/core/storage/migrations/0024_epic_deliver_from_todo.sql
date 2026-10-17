-- 0024_epic_deliver_from_todo.sql — an `epic` may be delivered straight out of
-- `todo`, so a container is no longer parked on a `blocked` that is not true.
--
-- ---------------------------------------------------------------------------
-- The dead end this closes
-- ---------------------------------------------------------------------------
--
-- An `epic` is a container: it is **never claimable** (`domain/claim.mjs`
-- `decideClaim` refuses it, and `AUTO_CLAIM_EXCLUDED_KINDS` keeps it out of the
-- automatic candidate read), so `todo → in_progress` is a door no epic can walk
-- through. And until this file, `todo → in_review` was not a pair — the row read
-- `backlog | in_progress | blocked | canceled`. Since `done` is reachable only
-- from `in_review`, a card that was `kind = 'epic'` *and* `status = 'todo'` had
-- no legal path to `done` at all (T-20261017-063808).
--
-- That is not a rare shape. `taskctl issue create --kind epic` births a
-- container in `todo`, a human's board creates one the same way, and the skill's
-- container protocol promotes a card in place — leaving it wherever the claim
-- had put it. The only exit was `todo → blocked`, and twice a lie: it records
-- `blocked_at` for a card that is not waiting on anything external, and the
-- audit trail then says a container was blocked when it was merely ready.
--
-- ---------------------------------------------------------------------------
-- The ruling: the overlay, not the status quo
-- ---------------------------------------------------------------------------
--
-- **A — a `kind`-aware exception: an epic may go `todo → in_review`**
-- (`domain/status.mjs#EPIC_ONLY_TRANSITIONS`, one pair). The alternative —
-- refusing the stranded initial state at create/promote time — was rejected
-- because it does not repair the dead end, it only forbids making it: a board
-- that already holds a `todo` epic stays stuck, `todo` is anyway the correct
-- "ready" status for a container, and `blocked` is the only other status with a
-- direct exit — so refusing would push every epic onto the same false block.
--
-- What is *not* relaxed is the delivery gate. An epic arriving in `in_review`
-- still owes a report for the current round — its rollup — and `done` is still
-- reachable only from `in_review`. Nor is the claim gate touched: `epic` stays
-- unclaimable (`GLOSSARY.md` "Epic"); the pair `todo → in_progress` stays on the
-- row below, because it is `decideClaim`, not the state machine, that refuses an
-- epic there.
--
-- ---------------------------------------------------------------------------
-- Two triggers, one table
-- ---------------------------------------------------------------------------
--
-- The whitelist is re-encoded below exactly as `domain/status.mjs` holds it —
-- `ALLOWED_TRANSITIONS` plus the epic overlay — and it is **one clause** longer
-- than 0020's text, carrying `AND NEW.kind = 'epic'`, which is part of the rule
-- and not a convenience: without it a `task` in `todo` could skip the work cycle
-- straight into review.
--
-- The second trigger is the one that is easy to forget.
-- `tr_deliver_gate`'s `OLD.status IN ('in_progress','blocked')` list is exactly
-- the set of `in_review` sources in the transition table, and it has been exactly
-- that set since 0002, which is why the mirror held. A new source without a new
-- arming condition would leave the **database** accepting a reportless delivery
-- on `todo → in_review` (a `task` cannot reach it, but an `epic` can) while the
-- service layer still refused it — the "the invariant is pushed down into the
-- schema" property gone quietly, on the one pair this file adds. So the gate
-- moves in the same migration, with the same kind condition, and
-- `test/contract/state-machine.test.mjs` walks the pair down both paths.
--
-- Everything else on `tasks` is untouched: the terminal guard, the archive
-- guard, the kind-downgrade guard, the round bump and the revision cursor are
-- not re-created, because nothing about them moves. This is a trigger rebuild,
-- not a table rebuild — no `PRAGMA` request, no data movement, and the upgrade
-- and a fresh install land on the same trigger text by construction.
--
-- Append-only: 0001 … 0023 are never edited.

-- ---------------------------------------------------------------------------
-- 1 · The transition whitelist — 0020's text plus the epic's one pair
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_tasks_transition;
CREATE TRIGGER tr_tasks_transition BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND OLD.status NOT IN ('done','canceled')
BEGIN
  SELECT CASE
    WHEN NOT (
         (OLD.status = 'backlog'     AND NEW.status IN ('todo','canceled'))
      OR (OLD.status = 'todo'        AND NEW.status IN ('backlog','in_progress','blocked','canceled'))
      -- 0024 · the epic overlay: a container never enters the work cycle, so
      -- `in_review` is the one destination its `todo` row gains.
      OR (OLD.status = 'todo'        AND NEW.status = 'in_review' AND NEW.kind = 'epic')
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','canceled','awaiting'))
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
      OR (OLD.status = 'awaiting'    AND NEW.status IN ('in_progress','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;

-- ---------------------------------------------------------------------------
-- 2 · The delivery gate arms for the new source
-- ---------------------------------------------------------------------------
--
-- 0003's trigger, re-created with one widened arming clause and otherwise
-- verbatim (0020's text). The gate itself — a `delivery` report for the *current*
-- round, or the audited waiver — is not touched; only *which* arrivals it
-- watches grows by the pair above.

DROP TRIGGER IF EXISTS tr_deliver_gate;
CREATE TRIGGER tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND (OLD.status IN ('in_progress','blocked')
      -- 0024 · the epic's direct arrival. This list is exactly the set of
      -- `in_review` sources in tr_tasks_transition above; the two move together.
      OR (OLD.status = 'todo' AND NEW.kind = 'epic'))
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
