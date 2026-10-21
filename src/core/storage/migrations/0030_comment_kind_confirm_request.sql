-- 0030 — `comments.kind` gains `confirm_request`.
--
-- SQLite cannot widen a `CHECK`, so the table is rebuilt: create-new / copy /
-- drop-old / rename-new. The 0020 shape is preserved byte for byte except for
-- the one new literal.
--
-- Two things make this rebuild different from 0020's:
--
--   * `attachments.comment_id REFERENCES comments(id)` is an **inbound** foreign
--     key, so the rebuild runs with foreign-key resolution off. The pragma is a
--     no-op inside a transaction, so the request goes to the runner — the marker
--     line below — exactly as 0018 and 0020 do it.
--   * `tr_dict_actors_delete` (on `actors`) names `comments` in its `WHEN`
--     clause. A trigger body is re-validated on any schema change, and a body
--     naming a momentarily-absent table is fatal, so the trigger is parked
--     before the drop and re-created verbatim after the rename.
--
-- Append-only: 0001 … 0029 are never edited.

-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- 1 · Park the trigger that names `comments`
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_dict_actors_delete;

-- ---------------------------------------------------------------------------
-- 2 · Rebuild the table with the widened CHECK
-- ---------------------------------------------------------------------------

CREATE TABLE comments_confirm_v2 (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('discuss','decision','confirm','confirm_request','change','note','defect')),
  author_kind    TEXT NOT NULL,
  author_id      TEXT NOT NULL REFERENCES actors(id),
  agent_session  TEXT,
  refs_json      TEXT NOT NULL DEFAULT '[]',
  source_seq     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL
) STRICT;

INSERT INTO comments_confirm_v2 (
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
)
SELECT
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
FROM comments;

DROP TABLE comments;
ALTER TABLE comments_confirm_v2 RENAME TO comments;

-- ---------------------------------------------------------------------------
-- 3 · Indexes (0001, re-created by 0020)
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS ux_comments_source;
CREATE UNIQUE INDEX ux_comments_source ON comments(task_id, source_seq) WHERE source_seq IS NOT NULL;
DROP INDEX IF EXISTS ix_comments_task;
CREATE INDEX ix_comments_task ON comments(task_id, created_at);

-- ---------------------------------------------------------------------------
-- 4 · The five comment triggers (append-only, revision cursor)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_comments_no_update;
CREATE TRIGGER tr_comments_no_update BEFORE UPDATE ON comments
BEGIN
  SELECT RAISE(ABORT, 'COMMENT_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS tr_comments_no_delete;
CREATE TRIGGER tr_comments_no_delete BEFORE DELETE ON comments
BEGIN
  SELECT RAISE(ABORT, 'COMMENT_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS tr_rev_comments_ins;
CREATE TRIGGER tr_rev_comments_ins AFTER INSERT ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_comments_upd;
CREATE TRIGGER tr_rev_comments_upd AFTER UPDATE ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_comments_del;
CREATE TRIGGER tr_rev_comments_del AFTER DELETE ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

-- ---------------------------------------------------------------------------
-- 5 · Restore the actor-delete guard, widened by 0020
-- ---------------------------------------------------------------------------

CREATE TRIGGER tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE claimed_by = OLD.id)
  OR EXISTS (SELECT 1 FROM comments WHERE author_id = OLD.id)
  OR EXISTS (SELECT 1 FROM task_reports WHERE author_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;
