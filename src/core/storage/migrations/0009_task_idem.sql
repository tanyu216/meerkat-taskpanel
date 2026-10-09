-- 0009_task_idem.sql — the mechanical idempotency guard for task creation.
--
-- `idem` holds the derived key `<kind> | <assignee> | <source> | <target>`
-- (see `domain/idem.mjs`). It is nullable on purpose: `NULL` means "this card
-- carries no key", which is what `--allow-dup` writes.
--
-- The UNIQUE index is **partial**, and the two halves of its WHERE clause are
-- the whole point:
--
--   * `idem IS NOT NULL` — SQLite treats NULLs as distinct in a unique index,
--     so an unkeyed card can never collide with another. That is exactly the
--     `--allow-dup` escape hatch: two cards with the same key become two rows
--     with the same *NULL*, and NULL never participates in the constraint.
--
--   * `status NOT IN ('done','canceled')` — the key is held only while the card
--     is *non-terminal*. A finished card releases its key, so the same work can
--     legitimately be re-created later. Un-indexing a row when it reaches a
--     terminal status is what makes that "release" a fact of the schema rather
--     than a rule the command layer has to remember.
--
-- Together they give the concurrency guarantee: two racing creates for the same
-- key cannot both commit — the second INSERT fails with
-- `UNIQUE constraint failed: tasks.idem`, which `storage/sqlite-errors.mjs`
-- maps to `IDEM_EXISTS` and the create path converges onto the existing row.
--
-- Append-only: this migration only adds a column and an index; it never edits
-- an earlier file.

ALTER TABLE tasks ADD COLUMN idem TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_idem_active
  ON tasks(idem)
  WHERE idem IS NOT NULL AND status NOT IN ('done','canceled');
