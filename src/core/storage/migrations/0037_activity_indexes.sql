-- 0037 — the event stream's two range reads get indexes.
--
-- `recordActivity` now records the revision its own insert produced (unique and
-- strictly increasing), so the SSE cursor is the whole query:
--   SELECT * FROM task_activities WHERE revision > ? ORDER BY revision, id LIMIT ?
-- Without `ix_activities_revision` every 500 ms poll scans the audit trail,
-- once per connected client. The project weight's 30-day activity window
-- (`repositories/projects.mjs#activityByProject`) filters on `created_at` and
-- scans today for the same reason.
--
-- Both indexes are built inside the migration transaction at startup; on a
-- large log that is a one-time pause under the single writer, not a per-request
-- cost. The table stays append-only: 0001 … 0036 are never edited.

CREATE INDEX IF NOT EXISTS ix_activities_revision ON task_activities(revision);
CREATE INDEX IF NOT EXISTS ix_activities_created ON task_activities(created_at);
