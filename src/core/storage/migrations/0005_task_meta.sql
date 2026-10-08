-- 0005_task_meta.sql — per-task extension metadata.
--
-- `projects` has carried `meta_json` from the start; tasks needed the same for
-- the md migrator (F2): the original text of a legacy status word, the
-- frontmatter keys this version does not understand, and the parsed checkbox
-- list of `## Acceptance`.
--
-- Storing *unrecognised* keys verbatim is what makes the export reversible — a
-- card can be rewritten by the migrator and still contain everything its author
-- put in it. Added by ALTER, as migrations are append-only.
--
-- Shape:
--   {
--     "legacy_status": "ready",                 -- the word the card used
--     "legacy": { "git_rules": "...", ... },    -- unknown frontmatter keys
--     "acceptance_legacy": [{text, checked}],   -- the '## Acceptance' checkboxes
--     "notify_elon": "yes",
--     "import_warnings": ["report_missing"]
--   }

ALTER TABLE tasks ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';

-- The import idempotency key is (project, source_path); add a covering index for
-- the lookup the migrator does per card.
CREATE INDEX IF NOT EXISTS ix_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;
