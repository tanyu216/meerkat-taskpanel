-- 0007_labels.sql — the label registry (§4.1 / §4.4, rulings F1/F2/F3/F5).
--
-- Labels grow by use, exactly like assignees and reporters: a card names one
-- and it appears. This table is a *registry* — `tasks.labels` keeps storing the
-- display-name strings it always has (F3-B), and the registry holds the parts a
-- task row cannot: a stable identity (`norm`), a colour, a use count and a
-- lifetime.
--
-- Rules the schema itself owns:
--   * `UNIQUE(project_id, norm)` — one row per label per project, and it counts
--     *archived* rows too, so a label that comes back after GC reuses its row
--     (colour and first-seen display name intact) instead of duplicating.
--   * `use_count >= 0` — deliberately NOT the assignees/reporters `>= 1`: a label
--     can legitimately fall to zero (nothing references it) and that is the
--     precondition for collection (F5-B). Copying the dictionary's `>= 1` would
--     make the GC condition `use_count = 0` unsatisfiable.
--   * `archived_at` is the soft delete. Nothing here is ever physically deleted;
--     reclamation is a future, explicit VACUUM.
--
-- Append-only: rollback is a *new* migration, never an edit to this file.

CREATE TABLE IF NOT EXISTS labels (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  norm          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  color         TEXT NOT NULL,
  use_count     INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  archived_at   TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_labels_project_norm ON labels(project_id, norm);
-- The GC's candidate scan: active, unused labels of a project.
CREATE INDEX IF NOT EXISTS ix_labels_project_archived ON labels(project_id, archived_at);
-- Colour assignment: which colours a project's active labels already use.
CREATE INDEX IF NOT EXISTS ix_labels_project_color ON labels(project_id, color);

CREATE TRIGGER IF NOT EXISTS tr_rev_labels_ins AFTER INSERT ON labels
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_labels_upd AFTER UPDATE ON labels
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_labels_del AFTER DELETE ON labels
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
