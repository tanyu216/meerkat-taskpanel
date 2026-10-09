-- 0011_parent_kind_update.sql — an epic with children may not be downgraded
-- (ARCHITECTURE §4.1).
--
-- 0010 made it impossible to *create* a `task → task` parent edge: `tr_rel_parent_epic`
-- refuses an INSERT whose source is not an epic. But inserting an edge is not the only
-- way to reach that state. Once a parent edge exists, changing the parent's `kind` from
-- `epic` to `task` re-creates the exact shape 0010 forbids — the edge is still there,
-- only its source stops being an epic. The domain layer (`updateTask`) refused nothing on
-- this path, so the domain/service, CLI and MCP surfaces could all downgrade an epic that
-- still parents a child, leaving a `task → task` parent edge behind (D-DB-1).
--
-- This trigger closes the UPDATE side of the same rule: `BEFORE UPDATE OF kind ON tasks`
-- aborts when the row is an epic being downgraded (`OLD.kind = 'epic'`, `NEW.kind <> 'epic'`)
-- AND it still parents at least one child (a `parent` edge in `task_relations` whose source
-- is this row).
--
-- Determinism (same discipline 0002/0010 document): this is the only trigger on
-- `UPDATE OF kind ON tasks` — the 0002 task guards fire on `status`/`archived_at`, and
-- 0010 fires on `INSERT ON task_relations` — so the reason code never depends on trigger
-- firing order. `NEW.kind` is never NULL (`tasks.kind` is NOT NULL), so `NEW.kind <> 'epic'`
-- is a real boolean, not a NULL that silently skips the guard. The message is a string
-- literal because SQLite requires it for `RAISE`; an unmapped `RAISE(ABORT, …)` surfaces as
-- `VALIDATION_FAILED` via `storage/sqlite-errors.mjs` — the same code the domain raises in
-- `assertEpicDowngradeAllowed`.
--
-- Append-only: this migration only adds a trigger; it never edits 0001/0002/0010.

CREATE TRIGGER IF NOT EXISTS tr_tasks_kind_downgrade BEFORE UPDATE OF kind ON tasks
WHEN OLD.kind = 'epic'
 AND NEW.kind <> 'epic'
 AND EXISTS (
       SELECT 1 FROM task_relations
        WHERE relation_type = 'parent' AND source_task_id = OLD.id
     )
BEGIN
  SELECT RAISE(ABORT, 'an epic with children cannot be downgraded');
END;
