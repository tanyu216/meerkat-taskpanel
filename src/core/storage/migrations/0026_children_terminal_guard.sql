-- 0026_children_terminal_guard.sql — a parent may not be delivered or accepted
-- while one of its children is still in flight.
--
-- ---------------------------------------------------------------------------
-- The gap this closes
-- ---------------------------------------------------------------------------
--
-- The automatic rollup (`commands/rollup.mjs`) has always refused to move a
-- container to `in_review` until **every** child is terminal. The *manual* path
-- had no such rule: `taskctl issue move <epic> in_review` (and `deliver`) asked
-- only the delivery gate and the state machine, so a human or an agent could
-- hand a half-finished container to acceptance. With acceptance now policy-driven
-- (`human-only`, `both`, `agent-only`) that hole widens: on an `agent-only`
-- board nothing else stands between an epic and `done`.
--
-- The rule is the same one the rollup applies, and no more:
--
--   * only `done` and `canceled` are terminal;
--   * the guard watches `in_review` **and** `done`, because `in_review` is where
--     a reviewer reads the container, and a still-flying child makes that
--     delivery a lie;
--   * it is a *trigger*, so a raw `UPDATE tasks SET status = …` cannot bypass it.
--     `createTask` is an INSERT and stays outside it (importing history is a
--     different act), which is the same boundary the delivery gate has had since
--     0008.
--
-- The command layer performs the same check first, so a caller gets the friendly
-- `CHILDREN_OPEN` with the children named in `details`; the trigger is the
-- machine guarantee behind it. `test/contract/state-machine.test.mjs` walks both.
--
-- Append-only: 0001 … 0025 are never edited.

CREATE TRIGGER tr_tasks_children_terminal
BEFORE UPDATE OF status ON tasks
WHEN NEW.status IN ('in_review', 'done')
 AND NEW.status <> OLD.status
 AND EXISTS (
   SELECT 1
     FROM task_relations r
     JOIN tasks child ON child.id = r.target_task_id
    WHERE r.relation_type = 'parent'
      AND r.source_task_id = NEW.id
      AND child.status NOT IN ('done', 'canceled')
 )
BEGIN
  SELECT RAISE(ABORT, 'CHILDREN_OPEN');
END;
