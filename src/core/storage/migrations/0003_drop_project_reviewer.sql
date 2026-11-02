-- 0003 — a project names no reviewer.
--
-- The review card's assignee selects the role; a project-level override is a
-- second source of truth the board no longer models. Rebuilds `projects`
-- without the column, using the documented create-new / copy / drop-old /
-- rename-new procedure, and recreates the revision triggers. `projects` has no
-- index of its own; the foreign keys that point at it (`tasks.project_id`,
-- `labels.project_id`, attachments) are left dangling only for the length of
-- the rebuild and resolve again once the rename lands.

-- @foreign-keys: off

-- ---------------------------------------------------------------- projects
-- The project keeps every column except `reviewer`.

CREATE TABLE projects_new (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  next_task_number  INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
  labels            TEXT NOT NULL DEFAULT '[]',
  meta_json         TEXT NOT NULL DEFAULT '{}',
  readme            TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

INSERT INTO projects_new (
  id, name, next_task_number, labels, meta_json, readme, archived_at,
  created_at, updated_at
)
SELECT
  id, name, next_task_number, labels, meta_json, readme, archived_at,
  created_at, updated_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_ins AFTER INSERT ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_del AFTER DELETE ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_upd AFTER UPDATE OF
  name, labels, meta_json, readme, archived_at, updated_at ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
