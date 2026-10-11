-- 0012_drop_project_workspace.sql — a project no longer owns a directory (O3).
--
-- The ruling this implements: taskpanel does no project-directory management at
-- all. The "which local directory is this project" question is answered on the
-- agent side, by the skill's own `projects.json`; the board stops carrying a
-- directory string. So `projects.workspace_path` and the unique index that
-- guarded it (both from 0001) go away.
--
-- Order is evidence, not guesswork: SQLite refuses the column drop while the
-- unique index still names it —
--   `error in index ux_projects_workspace after drop column: no such column`
-- — so `DROP INDEX` has to run first (verified against the bundled engine,
-- SQLite 3.53.4).
--
-- The revision trigger needs the same treatment. 0001 wires
-- `tr_rev_projects_upd` with `AFTER UPDATE OF name, workspace_path, …`; after the
-- column is gone that name is a dangling reference in a live schema object.
-- SQLite tolerates it (the trigger still fires — measured), but a schema that
-- names a column it does not have is a trap for the next migration, so this file
-- recreates the trigger with the identical body and the column removed: same
-- revision semantics, nothing pointing at a column that no longer exists.
-- Append-only is respected — 0001 is never edited.
--
-- Row data: existing `workspace_path` values are intentionally discarded. The
-- directory mapping moves to the skill side and the board keeps no copy. Every
-- other column, and every other table, is preserved.

DROP INDEX IF EXISTS ux_projects_workspace;

DROP TRIGGER IF EXISTS tr_rev_projects_upd;
CREATE TRIGGER tr_rev_projects_upd AFTER UPDATE OF
  name, labels, meta_json, readme, archived_at, updated_at ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

ALTER TABLE projects DROP COLUMN workspace_path;
