-- 0027_reopen_terminal.sql — a done/canceled card may be reopened to `todo`.
--
-- ---------------------------------------------------------------------------
-- The edge
-- ---------------------------------------------------------------------------
--
-- Until now `done` and `canceled` were hard terminal states: `tr_tasks_terminal`
-- refused every status change out of them, and the domain's `ALLOWED_TRANSITIONS`
-- gave both rows no targets. Reopening is now a first-class transition, but
-- exactly one destination — `todo`:
--
--   done     → todo
--   canceled → todo
--
-- `in_progress` is deliberately absent. It is a *claimed* state, and a reopened
-- card has no claim holder; landing there would produce an `in_progress` row
-- with `claimed_by IS NULL`, the corruption I2 exists to prevent. The card goes
-- back to the queue and is claimed normally.
--
-- The service layer additionally demands an audited `--reason` for this edge
-- (`commands/tasks.mjs#moveStatus`); that is an audit rule, not a machine
-- invariant, so it is not encoded here. Raw SQL may reopen without a reason,
-- exactly as it may take a claim without `--allow-steal`.
--
-- ---------------------------------------------------------------------------
-- The bookkeeping the finish released
-- ---------------------------------------------------------------------------
--
-- A terminal card has released its idempotency key (the partial unique index
-- `ux_tasks_idem_active` only covers non-terminal rows) and may have been
-- archived. Reopening makes it active again, so both must be cleared:
--
--   * `idem = NULL` — otherwise the row re-enters the unique index and can
--     collide with another active card that legitimately reused the key;
--   * `archived_at = NULL` — otherwise the card is back in the work but hidden
--     from the board's default reads.
--
-- This is done by a BEFORE trigger, and the service path clears the same two
-- columns in its own UPDATE. BEFORE is load-bearing: an AFTER trigger runs
-- *after* the unique index has checked the outer row, so an idem collision
-- would fail before the clear could help.
--
-- ---------------------------------------------------------------------------
-- The delivery round
-- ---------------------------------------------------------------------------
--
-- A reopen starts a new round, for the same reason leaving `in_review` does: the
-- previous round's report is evidence about work that has already been accepted,
-- not evidence about the new work. The round-bump trigger gains the pair.
--
-- The whitelist trigger (`tr_tasks_transition`, last rebuilt by 0024) is left
-- alone: its `WHEN` already skips terminal sources, and `tr_tasks_terminal` is
-- the guard that owns them. The two together are the terminal source's whitelist.
--
-- Append-only: 0001 … 0026 are never edited.

-- ---------------------------------------------------------------------------
-- 1 · The terminal guard — one exit, and only one
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_tasks_terminal;
CREATE TRIGGER tr_tasks_terminal BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status <> OLD.status
 AND NEW.status <> 'todo'
BEGIN
  SELECT RAISE(ABORT, 'TERMINAL_STATE');
END;

-- ---------------------------------------------------------------------------
-- 2 · The reopened row is active again
-- ---------------------------------------------------------------------------
--
-- Guarded on the values it is about: the service path already writes both NULL
-- in its own UPDATE, so this trigger does not fire there and the move keeps its
-- two-revision cost (status + activity). A raw writer that leaves either value
-- behind gets the same state, at the cost of one extra revision row.

DROP TRIGGER IF EXISTS tr_tasks_reopen_state;
CREATE TRIGGER tr_tasks_reopen_state BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status = 'todo'
 AND (NEW.archived_at IS NOT NULL OR NEW.idem IS NOT NULL)
BEGIN
  UPDATE tasks SET archived_at = NULL, idem = NULL WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- 3 · The round bump — a reopen starts a new delivery round
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_tasks_round_bump;
CREATE TRIGGER tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN (OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked'))
  OR (OLD.status IN ('done','canceled') AND NEW.status = 'todo')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;
