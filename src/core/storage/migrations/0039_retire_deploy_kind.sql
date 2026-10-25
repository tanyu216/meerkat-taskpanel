-- 0039_retire_deploy_kind.sql — the card model forgets `deploy` (0038, phase 2).
--
-- 0015 widened `tasks.kind` to ('task','epic','deploy') so a deployment card
-- could be marked. 0038 retired the concept: whether a card belongs to a release
-- line is the loop's own decision, and a card that needs an independent gate
-- says `acceptance_mode: agent`. The application stopped producing or accepting
-- the value first; this file narrows the table so the schema cannot outlive the
-- vocabulary (test/contract/sql-parity.test.mjs compares the two directions).
--
-- SQLite cannot alter a CHECK, so this is the 0015 rebuild procedure again:
-- CREATE new → copy → DROP old → RENAME new. Every row and every column
-- survives; a historical `deploy` row is copied as `task` — its review gate was
-- already carried over as `acceptance_mode = 'agent'` by 0038, so nothing about
-- its acceptance changes.
--
-- Triggers on *other* tables that name `tasks` in their bodies are parked and
-- re-created verbatim: SQLite re-parses every object when the schema changes,
-- and a trigger pointing at a momentarily absent table is fatal.
-- @foreign-keys: off

-- The triggers outside `tasks` that name it: parked, not edited.
DROP TRIGGER IF EXISTS tr_dict_actors_delete;
DROP TRIGGER IF EXISTS tr_rel_block_chain;
DROP TRIGGER IF EXISTS tr_rel_block_cycle;
DROP TRIGGER IF EXISTS tr_rel_cross_project;
DROP TRIGGER IF EXISTS tr_rel_parent_block_pair;
DROP TRIGGER IF EXISTS tr_rel_parent_epic;
DROP TRIGGER IF EXISTS tr_rel_parent_guard;
DROP TRIGGER IF EXISTS tr_reports_rollup_valid;

-- The replacement table: the 0038 shape, one token different in the kind CHECK.
CREATE TABLE tasks_retire_deploy (
  id                      TEXT PRIMARY KEY,
  identifier              TEXT NOT NULL,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','canceled','awaiting')),
  priority                TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  kind                    TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','epic')),
  labels                  TEXT NOT NULL DEFAULT '[]',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  assignee_id             TEXT REFERENCES actors(id),
  reporter_id             TEXT REFERENCES actors(id),
  agent_session           TEXT,
  thread_id               TEXT,
  thread_source           TEXT,
  claimed_by              TEXT REFERENCES actors(id),
  claimed_at              TEXT,
  heartbeat_at            TEXT,
  blocked_at              TEXT,
  status_changed_at       TEXT NOT NULL DEFAULT '',
  archived_at             TEXT,
  source_path             TEXT,
  source_hash             TEXT,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  report_latest_id        INTEGER,
  delivery_round          INTEGER NOT NULL DEFAULT 1,
  meta_json               TEXT NOT NULL DEFAULT '{}',
  report_waiver_round     INTEGER,
  report_waiver_reason    TEXT,
  report_waived_at        TEXT,
  idem                    TEXT,
  awaiting_reason         TEXT CHECK (awaiting_reason IN ('E1','E2','E3','E4','E5')),
  blocked_reason          TEXT CHECK (blocked_reason IN ('clarify','decision','dependency','out_of_bounds','defect','external','resource','unknown')), assignee_kind TEXT, reporter_kind TEXT, claimed_kind TEXT, review_of_id TEXT REFERENCES tasks(id), review_round INTEGER CHECK (review_round IS NULL OR review_round > 0), review_required INTEGER NOT NULL DEFAULT 0
  CHECK (review_required BETWEEN 0 AND 1), acceptance_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(acceptance_json) AND json_type(acceptance_json) = 'array'), acceptance_revision INTEGER NOT NULL DEFAULT 0
  CHECK (acceptance_revision >= 0), acceptance_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (acceptance_mode IN ('off','agent','human')),
  -- A backlog task is never claimed (0001's table CHECK, preserved verbatim).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

INSERT INTO tasks_retire_deploy (
  id,
  identifier,
  project_id,
  title,
  description,
  status,
  priority,
  kind,
  labels,
  sort_order,
  assignee_id,
  reporter_id,
  agent_session,
  thread_id,
  thread_source,
  claimed_by,
  claimed_at,
  heartbeat_at,
  blocked_at,
  status_changed_at,
  archived_at,
  source_path,
  source_hash,
  version,
  created_at,
  updated_at,
  report_latest_id,
  delivery_round,
  meta_json,
  report_waiver_round,
  report_waiver_reason,
  report_waived_at,
  idem,
  awaiting_reason,
  blocked_reason,
  assignee_kind,
  reporter_kind,
  claimed_kind,
  review_of_id,
  review_round,
  review_required,
  acceptance_json,
  acceptance_revision,
  acceptance_mode
)
SELECT
  id,
  identifier,
  project_id,
  title,
  description,
  status,
  priority,
  CASE WHEN kind = 'deploy' THEN 'task' ELSE kind END,
  labels,
  sort_order,
  assignee_id,
  reporter_id,
  agent_session,
  thread_id,
  thread_source,
  claimed_by,
  claimed_at,
  heartbeat_at,
  blocked_at,
  status_changed_at,
  archived_at,
  source_path,
  source_hash,
  version,
  created_at,
  updated_at,
  report_latest_id,
  delivery_round,
  meta_json,
  report_waiver_round,
  report_waiver_reason,
  report_waived_at,
  idem,
  awaiting_reason,
  blocked_reason,
  assignee_kind,
  reporter_kind,
  claimed_kind,
  review_of_id,
  review_round,
  review_required,
  acceptance_json,
  acceptance_revision,
  acceptance_mode
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_retire_deploy RENAME TO tasks;

-- The complete index set (0001 + 0005 + 0009 + 0025), re-created because the
-- DROP took them with the table.
CREATE INDEX ix_tasks_assignee ON tasks(project_id, assignee_id);

CREATE INDEX ix_tasks_board ON tasks(project_id, status, sort_order);

CREATE INDEX ix_tasks_heartbeat ON tasks(status, heartbeat_at);

CREATE INDEX ix_tasks_review_of ON tasks(review_of_id) WHERE review_of_id IS NOT NULL;

CREATE INDEX ix_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;

CREATE UNIQUE INDEX ux_tasks_idem_active
  ON tasks(idem)
  WHERE idem IS NOT NULL AND status NOT IN ('done','canceled');

CREATE UNIQUE INDEX ux_tasks_identifier ON tasks(project_id, identifier);

CREATE UNIQUE INDEX ux_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;

-- The triggers attached to `tasks`, re-created verbatim.
CREATE TRIGGER tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND (OLD.status IN ('in_progress','blocked')
      OR (OLD.status = 'todo' AND NEW.kind = 'epic'))
 AND (NEW.report_latest_id IS NULL
      OR (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM task_reports
   WHERE task_id = NEW.id AND round = NEW.delivery_round
 )
 AND NOT (
   NEW.report_waiver_round IS NEW.delivery_round
   AND NEW.report_waiver_reason IS NOT NULL
   AND length(trim(NEW.report_waiver_reason)) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

CREATE TRIGGER tr_deliver_gate_done BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND OLD.status = 'in_progress'
 AND NEW.acceptance_mode = 'off'
 AND NEW.acceptance_json NOT IN ('[]','')
 AND NOT EXISTS (
   SELECT 1 FROM task_reports
    WHERE task_id = NEW.id AND round = NEW.delivery_round
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

CREATE TRIGGER tr_latest_report_belongs BEFORE UPDATE OF report_latest_id ON tasks
WHEN NEW.report_latest_id IS NOT NULL
 AND (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'REPORT_TASK_MISMATCH');
END;

CREATE TRIGGER tr_rev_tasks_del AFTER DELETE ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER tr_rev_tasks_ins AFTER INSERT ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_id, reporter_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at,
  report_waiver_round, report_waiver_reason, report_waived_at,
  awaiting_reason, acceptance_mode, review_required ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER tr_tasks_acceptance_agent_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 -- The only legal source for an `agent`/`human` card; checking it keeps this
 -- trigger from masking the whitelist's INVALID_TRANSITION on an illegal pair.
 AND OLD.status = 'in_review'
 AND NEW.acceptance_mode = 'agent'
 AND NEW.review_of_id IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM tasks review
    WHERE review.review_of_id = NEW.id
      AND review.status IN ('in_review','done')
      AND (review.review_round IS NULL OR review.review_round = NEW.delivery_round)
 )
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_REQUIRED');
END;

CREATE TRIGGER tr_tasks_acceptance_mode_ins BEFORE INSERT ON tasks
WHEN (NEW.review_of_id IS NOT NULL
      AND (NEW.acceptance_mode <> 'off' OR NEW.review_required <> 0))
  OR (NEW.review_of_id IS NULL
      AND (NEW.acceptance_mode <> 'agent') <> (NEW.review_required <> 1))
BEGIN
  SELECT CASE
    WHEN NEW.review_of_id IS NOT NULL THEN RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID')
    ELSE RAISE(ABORT, 'ACCEPTANCE_MODE_CONFLICT')
  END;
END;

CREATE TRIGGER tr_tasks_acceptance_mode_upd
BEFORE UPDATE OF acceptance_mode, review_required, review_of_id ON tasks
WHEN (NEW.review_of_id IS NOT NULL
      AND (NEW.acceptance_mode <> 'off' OR NEW.review_required <> 0))
  OR (NEW.review_of_id IS NULL
      AND (NEW.acceptance_mode <> 'agent') <> (NEW.review_required <> 1))
BEGIN
  SELECT CASE
    WHEN NEW.review_of_id IS NOT NULL THEN RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID')
    ELSE RAISE(ABORT, 'ACCEPTANCE_MODE_CONFLICT')
  END;
END;

CREATE TRIGGER tr_tasks_acceptance_prune_audited
BEFORE UPDATE OF acceptance_json ON tasks
WHEN NEW.acceptance_json IS NOT OLD.acceptance_json
 AND EXISTS (
   SELECT 1
   FROM json_each(OLD.acceptance_json) o
   WHERE o.value NOT IN (SELECT value FROM json_each(NEW.acceptance_json))
 )
 AND NOT EXISTS (
   SELECT 1
   FROM task_activities a
   WHERE a.task_id = NEW.id
     AND a.event = 'acceptance_pruned'
     AND length(trim(json_extract(a.changes_json, '$.reason'))) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER tr_tasks_acceptance_revision
BEFORE UPDATE OF acceptance_json ON tasks
WHEN NEW.acceptance_json IS NOT OLD.acceptance_json
 AND NEW.acceptance_revision IS NOT OLD.acceptance_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER tr_tasks_archive_terminal BEFORE UPDATE OF archived_at ON tasks
WHEN NEW.archived_at IS NOT NULL AND NEW.status NOT IN ('done','canceled')
BEGIN
  SELECT RAISE(ABORT, 'ARCHIVE_NOT_TERMINAL');
END;

CREATE TRIGGER tr_tasks_children_terminal
BEFORE UPDATE OF status ON tasks
WHEN NEW.status IN ('in_review', 'done')
 AND NEW.status <> OLD.status
 AND EXISTS (
   SELECT 1
     FROM task_relations r
     JOIN tasks child ON child.id = r.target_task_id
    WHERE r.relation_type = 'parent'
      AND r.source_task_id = NEW.id
      AND child.status NOT IN ('done', 'canceled')
 )
BEGIN
  SELECT RAISE(ABORT, 'CHILDREN_OPEN');
END;

CREATE TRIGGER tr_tasks_epic_rollup_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done'
 AND NEW.kind = 'epic'
 -- The legal done sources: the ordinary acceptance exit, or the `off` direct
 -- edge. Anything else is the transition trigger's refusal, not this one.
 AND (OLD.status = 'in_review'
      OR (OLD.status = 'in_progress' AND NEW.acceptance_mode = 'off'))
 AND NOT EXISTS (
   SELECT 1 FROM task_reports r
    WHERE r.task_id = NEW.id
      AND r.round = NEW.delivery_round
      AND r.is_rollup = 1
 )
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_REQUIRED');
END;

CREATE TRIGGER tr_tasks_kind_downgrade BEFORE UPDATE OF kind ON tasks
WHEN OLD.kind = 'epic'
 AND NEW.kind <> 'epic'
 AND EXISTS (
       SELECT 1 FROM task_relations
        WHERE relation_type = 'parent' AND source_task_id = OLD.id
     )
BEGIN
  SELECT RAISE(ABORT, 'an epic with children cannot be downgraded');
END;

CREATE TRIGGER tr_tasks_reopen_state BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status = 'todo'
 AND (NEW.archived_at IS NOT NULL OR NEW.idem IS NOT NULL)
BEGIN
  UPDATE tasks SET archived_at = NULL, idem = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER tr_tasks_review_card_not_required
BEFORE INSERT ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.review_required <> 0
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

CREATE TRIGGER tr_tasks_review_card_not_required_update
BEFORE UPDATE OF review_of_id, review_required ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.review_required <> 0
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

CREATE TRIGGER tr_tasks_review_marker_immutable
BEFORE UPDATE OF review_of_id, review_round ON tasks
WHEN OLD.review_of_id IS NOT NEW.review_of_id
  OR OLD.review_round IS NOT NEW.review_round
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_OF_IMMUTABLE');
END;

CREATE TRIGGER tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN (OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked'))
  OR (OLD.status IN ('done','canceled') AND NEW.status = 'todo')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER tr_tasks_terminal BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status <> OLD.status
 AND NEW.status <> 'todo'
BEGIN
  SELECT RAISE(ABORT, 'TERMINAL_STATE');
END;

CREATE TRIGGER tr_tasks_transition BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND OLD.status NOT IN ('done','canceled')
BEGIN
  SELECT CASE
    WHEN NOT (
         (OLD.status = 'backlog'     AND NEW.status IN ('todo','canceled'))
      OR (OLD.status = 'todo'        AND NEW.status IN ('backlog','in_progress','blocked','canceled'))
      -- 0024 · the epic overlay.
      OR (OLD.status = 'todo'        AND NEW.status = 'in_review' AND NEW.kind = 'epic')
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','canceled','awaiting'))
      -- 0038 · the off-mode direct path. `agent`/`human` are absent on purpose,
      -- and a review card is flow B: it must deliver its verdict through
      -- `in_review`, so it never gets the shortcut.
      OR (OLD.status = 'in_progress' AND NEW.status = 'done'
          AND NEW.acceptance_mode = 'off' AND NEW.review_of_id IS NULL)
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
      OR (OLD.status = 'awaiting'    AND NEW.status IN ('todo','in_progress','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;

-- ...and the parked external triggers, verbatim.
CREATE TRIGGER tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE claimed_by = OLD.id)
  OR EXISTS (SELECT 1 FROM comments WHERE author_id = OLD.id)
  OR EXISTS (SELECT 1 FROM task_reports WHERE author_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

CREATE TRIGGER tr_rel_block_chain BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'blocks'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    -- The blocker is on the blocked card's parent chain (it is its ancestor).
    WHEN EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.target_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.id = NEW.source_task_id
    -- …or the blocked card is on the blocker's (the edge is the other way up).
    ) OR EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.source_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.id = NEW.target_task_id
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    ELSE NULL
  END;
END;

CREATE TRIGGER tr_rel_block_cycle BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'blocks'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      WITH RECURSIVE downstream(id, depth) AS (
        SELECT NEW.target_task_id, 0
        UNION ALL
        SELECT r.target_task_id, downstream.depth + 1
          FROM task_relations r JOIN downstream ON r.source_task_id = downstream.id
         WHERE r.relation_type = 'blocks' AND downstream.depth < 64
      )
      SELECT 1 FROM downstream WHERE downstream.id = NEW.source_task_id
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    ELSE NULL
  END;
END;

CREATE TRIGGER tr_rel_cross_project BEFORE INSERT ON task_relations
WHEN (SELECT project_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS NOT (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION');
END;

CREATE TRIGGER tr_rel_parent_block_pair AFTER INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      WITH RECURSIVE
        -- The new parent and everything above it, nearest first.
        above(id, depth) AS (
          SELECT NEW.source_task_id, 0
          UNION ALL
          SELECT r.source_task_id, above.depth + 1
            FROM task_relations r JOIN above ON r.target_task_id = above.id
           WHERE r.relation_type = 'parent' AND above.depth < 64
        ),
        -- The new child and everything below it, nearest first.
        below(id, depth) AS (
          SELECT NEW.target_task_id, 0
          UNION ALL
          SELECT r.target_task_id, below.depth + 1
            FROM task_relations r JOIN below ON r.source_task_id = below.id
           WHERE r.relation_type = 'parent' AND below.depth < 64
        )
      SELECT 1
        FROM task_relations b
       WHERE b.relation_type = 'blocks'
         AND ((b.source_task_id IN (SELECT id FROM above)
               AND b.target_task_id IN (SELECT id FROM below))
           OR (b.target_task_id IN (SELECT id FROM above)
               AND b.source_task_id IN (SELECT id FROM below)))
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    ELSE NULL
  END;
END;

CREATE TRIGGER tr_rel_parent_epic BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
 AND (SELECT kind FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT kind FROM tasks WHERE id = NEW.source_task_id) IS NOT 'epic'
BEGIN
  SELECT RAISE(ABORT, 'only an epic can be a parent');
END;

CREATE TRIGGER tr_rel_parent_guard BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.source_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.id = NEW.target_task_id
    ) THEN RAISE(ABORT, 'RELATION_CYCLE')
    -- depth of the new child = max(anc.depth) + 2 (the child, plus the parent);
    -- the chain may not exceed 8 nodes.
    WHEN EXISTS (
      WITH RECURSIVE anc(id, depth) AS (
        SELECT NEW.source_task_id, 0
        UNION ALL
        SELECT r.source_task_id, anc.depth + 1
          FROM task_relations r JOIN anc ON r.target_task_id = anc.id
         WHERE r.relation_type = 'parent' AND anc.depth < 64
      )
      SELECT 1 FROM anc WHERE anc.depth > 6
    ) THEN RAISE(ABORT, 'CHAIN_TOO_LONG')
    WHEN (SELECT COUNT(*) FROM task_relations
           WHERE relation_type = 'parent' AND source_task_id = NEW.source_task_id) >= 8
    THEN RAISE(ABORT, 'FANIN_TOO_HIGH')
    ELSE NULL
  END;
END;

CREATE TRIGGER tr_reports_rollup_valid
BEFORE INSERT ON task_reports
WHEN NEW.is_rollup = 1
 AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND kind = 'epic')
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_INVALID');
END;
