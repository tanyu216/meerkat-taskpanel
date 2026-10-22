-- 0034_questions_awaiting.sql — a worker can ask, and the answer re-queues it.
--
-- Two changes, one protocol:
--
--   1. `comments.kind` gains `question`. A worker that cannot proceed asks on
--      the card (the question is the payload `awaiting` has always promised);
--      the human answers with a `decision` / `confirm` / `change` comment.
--   2. `awaiting → todo` becomes legal. The answer arrives from a *different*
--      conversation than the one that asked — a worker is a one-shot subagent,
--      and the human may answer minutes or hours later — so the card has to go
--      back to the queue where `issue candidates` will dispatch it again. The
--      old `awaiting → in_progress` edge stays, for the case where the asking
--      worker is still live.
--
-- Why `todo` and not `in_progress`: only `todo` is claimable (`CLAIMABLE_STATUS`
-- = todo). A card resumed straight into `in_progress` has no claimant, and no
-- poll would ever pick it up. `todo` also releases the dormant claim in the same
-- UPDATE (the execution cycle is `in_progress` / `awaiting` / `in_review` /
-- `blocked`; `todo` is outside it).
--
-- This is not a reopen: the delivery round does not move, `idem`/`archived_at`
-- are untouched, and no reason is required. `tr_tasks_round_bump` (0027) names
-- its pairs explicitly, so it does not grow an `awaiting` arm by accident.
--
-- SQLite cannot widen a CHECK, so `comments` is rebuilt exactly as 0030 did it:
-- create-new / copy / drop-old / rename-new, foreign keys off (attachments point
-- at comments), with `tr_dict_actors_delete` parked because its body names the
-- table.
--
-- Append-only: 0001 … 0033 are never edited.

-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- 1 · Park the trigger that names `comments`
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_dict_actors_delete;

-- ---------------------------------------------------------------------------
-- 2 · Rebuild the table with the widened CHECK
-- ---------------------------------------------------------------------------

CREATE TABLE comments_question_v2 (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('discuss','decision','confirm','confirm_request','change','note','defect','question')),
  author_kind    TEXT NOT NULL,
  author_id      TEXT NOT NULL REFERENCES actors(id),
  agent_session  TEXT,
  refs_json      TEXT NOT NULL DEFAULT '[]',
  source_seq     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL
) STRICT;

INSERT INTO comments_question_v2 (
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
)
SELECT
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
FROM comments;

DROP TABLE comments;
ALTER TABLE comments_question_v2 RENAME TO comments;

-- ---------------------------------------------------------------------------
-- 3 · Indexes (0001, re-created by 0020/0030)
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
-- 5 · Restore the actor-delete guard (0020/0030, verbatim)
-- ---------------------------------------------------------------------------

CREATE TRIGGER tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE claimed_by = OLD.id)
  OR EXISTS (SELECT 1 FROM comments WHERE author_id = OLD.id)
  OR EXISTS (SELECT 1 FROM task_reports WHERE author_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

-- ---------------------------------------------------------------------------
-- 6 · `awaiting → todo` — the answered card returns to the queue
-- ---------------------------------------------------------------------------
--
-- 0024's trigger, with one target added to the `awaiting` row (0027 left the
-- trigger alone; its `WHEN` still skips terminal sources).

DROP TRIGGER IF EXISTS tr_tasks_transition;
CREATE TRIGGER tr_tasks_transition BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND OLD.status NOT IN ('done','canceled')
BEGIN
  SELECT CASE
    WHEN NOT (
         (OLD.status = 'backlog'     AND NEW.status IN ('todo','canceled'))
      OR (OLD.status = 'todo'        AND NEW.status IN ('backlog','in_progress','blocked','canceled'))
      -- 0024 · the epic overlay: a container never enters the work cycle, so
      -- `in_review` is the one destination its `todo` row gains.
      OR (OLD.status = 'todo'        AND NEW.status = 'in_review' AND NEW.kind = 'epic')
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','canceled','awaiting'))
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
      -- 0034 · an answered question re-queues the card (releases the claim);
      -- `in_progress` stays for the worker that is still live.
      OR (OLD.status = 'awaiting'    AND NEW.status IN ('todo','in_progress','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;
