-- 0038 — the activity log is append-only in the schema, not just by convention.
--
-- `task_activities` is the board's history and its change feed. An UPDATE would
-- silently rewrite a row a client already received; a DELETE would punch a hole
-- that the revision cursor can never replay. Every production writer goes
-- through `recordActivity`, which inserts only — these triggers keep it that
-- way (and refuse a direct SQL edit before the 0001 revision trigger fires).
--
-- The table is a STRICT audit log: no `archived_at`, no soft delete. A wrong
-- row is corrected by writing the next one, the same rule comments follow.

CREATE TRIGGER IF NOT EXISTS tr_activities_no_update BEFORE UPDATE ON task_activities
BEGIN
  SELECT RAISE(ABORT, 'ACTIVITY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_activities_no_delete BEFORE DELETE ON task_activities
BEGIN
  SELECT RAISE(ABORT, 'ACTIVITY_APPEND_ONLY');
END;
