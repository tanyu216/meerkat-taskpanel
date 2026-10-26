-- Meerkat TaskPanel 0.1.0 baseline.
-- Squashed from the pre-release 0001..0042 history. Append-only from here:
-- add the next NNNN_*.sql instead of editing this file.

CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       checksum   TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  next_task_number  INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
  labels            TEXT NOT NULL DEFAULT '[]',
  meta_json         TEXT NOT NULL DEFAULT '{}',
  readme            TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
, reviewer TEXT, acceptance TEXT NOT NULL DEFAULT 'auto'
  CHECK (acceptance IN ('auto','off','agent','human'))) STRICT;

CREATE TABLE IF NOT EXISTS actors (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1)
) STRICT;

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

CREATE TABLE IF NOT EXISTS "tasks" (
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
  blocked_reason          TEXT CHECK (blocked_reason IN ('clarify','decision','dependency','out_of_bounds','defect','external','resource','unknown')), assignee_kind TEXT, reporter_kind TEXT, claimed_kind TEXT, review_of_id TEXT REFERENCES tasks(id), review_round INTEGER CHECK (review_round IS NULL OR review_round > 0), acceptance_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(acceptance_json) AND json_type(acceptance_json) = 'array'), acceptance_revision INTEGER NOT NULL DEFAULT 0
  CHECK (acceptance_revision >= 0), acceptance_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (acceptance_mode IN ('off','agent','human')),
  -- A backlog task is never claimed (0001's table CHECK, preserved verbatim).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

CREATE TABLE IF NOT EXISTS task_relations (
  id              INTEGER PRIMARY KEY,
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('parent','blocks','related')),
  source_task_id  TEXT NOT NULL REFERENCES tasks(id),
  target_task_id  TEXT NOT NULL REFERENCES tasks(id),
  origin          TEXT,
  created_at      TEXT NOT NULL,
  CHECK (source_task_id <> target_task_id),
  -- `related` is stored with a canonical direction: source < target.
  CHECK (relation_type <> 'related' OR source_task_id < target_task_id)
) STRICT;

CREATE TABLE IF NOT EXISTS "comments" (
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

CREATE TABLE IF NOT EXISTS task_activities (
  id            INTEGER PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id),
  actor_kind    TEXT,
  actor_id      TEXT,
  event         TEXT NOT NULL,
  changes_json  TEXT NOT NULL DEFAULT '{}',
  revision      INTEGER,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  comment_id    TEXT REFERENCES comments(id),
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size          INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('inline','attachment')),
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  seg         TEXT NOT NULL,
  owner       TEXT NOT NULL,
  owner_kind     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  phase       TEXT,
  pid         INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','closed','failed')),
  ts          TEXT NOT NULL
, goal TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}') STRICT;

CREATE TABLE IF NOT EXISTS "task_reports" (
  id               INTEGER PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  round            INTEGER NOT NULL CHECK (round >= 1),
  seg              TEXT,
  session_id       TEXT,
  conclusion       TEXT NOT NULL CHECK (length(trim(conclusion)) > 0),
  acceptance_json  TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  leftovers        TEXT,
  author_kind      TEXT NOT NULL,
  author_id        TEXT NOT NULL REFERENCES actors(id),
  source_seq       INTEGER,
  created_at       TEXT NOT NULL,
  is_rollup        INTEGER NOT NULL DEFAULT 0 CHECK (is_rollup IN (0, 1)),
  UNIQUE (task_id, round)
) STRICT;

CREATE TABLE IF NOT EXISTS global_revision (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision   INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT OR IGNORE INTO global_revision(singleton, revision) VALUES (1, 0);

CREATE UNIQUE INDEX IF NOT EXISTS ux_relations_single_parent ON task_relations(target_task_id) WHERE relation_type = 'parent';

CREATE UNIQUE INDEX IF NOT EXISTS ux_relations_triple ON task_relations(relation_type, source_task_id, target_task_id);

CREATE INDEX IF NOT EXISTS ix_activities_task ON task_activities(task_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_natural ON agent_sessions(task_id, seg, owner);

CREATE UNIQUE INDEX IF NOT EXISTS ux_labels_project_norm ON labels(project_id, norm);

CREATE INDEX IF NOT EXISTS ix_labels_project_archived ON labels(project_id, archived_at);

CREATE INDEX IF NOT EXISTS ix_labels_project_color ON labels(project_id, color);

CREATE UNIQUE INDEX IF NOT EXISTS ux_actors_norm ON actors(normalized_name);

CREATE UNIQUE INDEX IF NOT EXISTS ux_comments_source ON comments(task_id, source_seq) WHERE source_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_comments_task ON comments(task_id, created_at);

CREATE INDEX IF NOT EXISTS ix_activities_revision ON task_activities(revision);

CREATE INDEX IF NOT EXISTS ix_activities_created ON task_activities(created_at);

CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(project_id, assignee_id);

CREATE INDEX IF NOT EXISTS ix_tasks_board ON tasks(project_id, status, sort_order);

CREATE INDEX IF NOT EXISTS ix_tasks_heartbeat ON tasks(status, heartbeat_at);

CREATE INDEX IF NOT EXISTS ix_tasks_review_of ON tasks(review_of_id) WHERE review_of_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_idem_active
  ON tasks(idem)
  WHERE idem IS NOT NULL AND status NOT IN ('done','canceled');

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_identifier ON tasks(project_id, identifier);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_ins AFTER INSERT ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_del AFTER DELETE ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_relations_ins AFTER INSERT ON task_relations
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_relations_upd AFTER UPDATE ON task_relations
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_relations_del AFTER DELETE ON task_relations
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_activities_ins AFTER INSERT ON task_activities
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_activities_upd AFTER UPDATE ON task_activities
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_activities_del AFTER DELETE ON task_activities
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_attachments_ins AFTER INSERT ON attachments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_attachments_upd AFTER UPDATE ON attachments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_attachments_del AFTER DELETE ON attachments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_agent_sessions_ins AFTER INSERT ON agent_sessions
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_agent_sessions_upd AFTER UPDATE ON agent_sessions
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_agent_sessions_del AFTER DELETE ON agent_sessions
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rel_self_ref BEFORE INSERT ON task_relations
WHEN NEW.source_task_id = NEW.target_task_id
BEGIN
  SELECT RAISE(ABORT, 'SELF_REFERENCE');
END;

CREATE TRIGGER IF NOT EXISTS tr_rel_immutable BEFORE UPDATE ON task_relations
BEGIN
  SELECT RAISE(ABORT, 'RELATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS tr_rev_labels_ins AFTER INSERT ON labels
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_labels_upd AFTER UPDATE ON labels
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_labels_del AFTER DELETE ON labels
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_actors_ins AFTER INSERT ON actors
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_actors_upd AFTER UPDATE ON actors
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_actors_del AFTER DELETE ON actors
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_comments_no_update BEFORE UPDATE ON comments
BEGIN
  SELECT RAISE(ABORT, 'COMMENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_comments_no_delete BEFORE DELETE ON comments
BEGIN
  SELECT RAISE(ABORT, 'COMMENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_rev_comments_ins AFTER INSERT ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_comments_upd AFTER UPDATE ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_comments_del AFTER DELETE ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_reports_no_update BEFORE UPDATE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_reports_no_delete BEFORE DELETE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_reports_ins AFTER INSERT ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_reports_upd AFTER UPDATE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_reports_del AFTER DELETE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_reports_not_applicable_note
BEFORE INSERT ON task_reports
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.acceptance_json)
  WHERE json_extract(value, '$.status') = 'not_applicable'
    AND (
      json_extract(value, '$.note') IS NULL
      OR length(trim(json_extract(value, '$.note'))) = 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'REPORT_NOT_APPLICABLE_NOTE');
END;

CREATE TRIGGER IF NOT EXISTS tr_deliver_gate BEFORE UPDATE OF status ON tasks
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

CREATE TRIGGER IF NOT EXISTS tr_deliver_gate_done BEFORE UPDATE OF status ON tasks
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

CREATE TRIGGER IF NOT EXISTS tr_latest_report_belongs BEFORE UPDATE OF report_latest_id ON tasks
WHEN NEW.report_latest_id IS NOT NULL
 AND (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'REPORT_TASK_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS tr_rev_tasks_del AFTER DELETE ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_tasks_ins AFTER INSERT ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_acceptance_agent_done
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

CREATE TRIGGER IF NOT EXISTS tr_tasks_acceptance_prune_audited
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

CREATE TRIGGER IF NOT EXISTS tr_tasks_acceptance_revision
BEFORE UPDATE OF acceptance_json ON tasks
WHEN NEW.acceptance_json IS NOT OLD.acceptance_json
 AND NEW.acceptance_revision IS NOT OLD.acceptance_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_archive_terminal BEFORE UPDATE OF archived_at ON tasks
WHEN NEW.archived_at IS NOT NULL AND NEW.status NOT IN ('done','canceled')
BEGIN
  SELECT RAISE(ABORT, 'ARCHIVE_NOT_TERMINAL');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_children_terminal
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

CREATE TRIGGER IF NOT EXISTS tr_tasks_epic_rollup_done
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

CREATE TRIGGER IF NOT EXISTS tr_tasks_kind_downgrade BEFORE UPDATE OF kind ON tasks
WHEN OLD.kind = 'epic'
 AND NEW.kind <> 'epic'
 AND EXISTS (
       SELECT 1 FROM task_relations
        WHERE relation_type = 'parent' AND source_task_id = OLD.id
     )
BEGIN
  SELECT RAISE(ABORT, 'an epic with children cannot be downgraded');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_reopen_state BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status = 'todo'
 AND (NEW.archived_at IS NOT NULL OR NEW.idem IS NOT NULL)
BEGIN
  UPDATE tasks SET archived_at = NULL, idem = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_review_marker_immutable
BEFORE UPDATE OF review_of_id, review_round ON tasks
WHEN OLD.review_of_id IS NOT NEW.review_of_id
  OR OLD.review_round IS NOT NEW.review_round
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_OF_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN (OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked'))
  OR (OLD.status IN ('done','canceled') AND NEW.status = 'todo')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_terminal BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status <> OLD.status
 AND NEW.status <> 'todo'
BEGIN
  SELECT RAISE(ABORT, 'TERMINAL_STATE');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_transition BEFORE UPDATE OF status ON tasks
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

CREATE TRIGGER IF NOT EXISTS tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE claimed_by = OLD.id)
  OR EXISTS (SELECT 1 FROM comments WHERE author_id = OLD.id)
  OR EXISTS (SELECT 1 FROM task_reports WHERE author_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

CREATE TRIGGER IF NOT EXISTS tr_rel_block_chain BEFORE INSERT ON task_relations
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

CREATE TRIGGER IF NOT EXISTS tr_rel_block_cycle BEFORE INSERT ON task_relations
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

CREATE TRIGGER IF NOT EXISTS tr_rel_cross_project BEFORE INSERT ON task_relations
WHEN (SELECT project_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS NOT (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION');
END;

CREATE TRIGGER IF NOT EXISTS tr_rel_parent_block_pair AFTER INSERT ON task_relations
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

CREATE TRIGGER IF NOT EXISTS tr_rel_parent_epic BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND NEW.source_task_id <> NEW.target_task_id
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
 AND (SELECT kind FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT kind FROM tasks WHERE id = NEW.source_task_id) IS NOT 'epic'
BEGIN
  SELECT RAISE(ABORT, 'only an epic can be a parent');
END;

CREATE TRIGGER IF NOT EXISTS tr_rel_parent_guard BEFORE INSERT ON task_relations
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

CREATE TRIGGER IF NOT EXISTS tr_reports_rollup_valid
BEFORE INSERT ON task_reports
WHEN NEW.is_rollup = 1
 AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND kind = 'epic')
BEGIN
  SELECT RAISE(ABORT, 'ROLLUP_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_acceptance_mode_ins BEFORE INSERT ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.acceptance_mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_acceptance_mode_upd
BEFORE UPDATE OF acceptance_mode, review_of_id ON tasks
WHEN NEW.review_of_id IS NOT NULL AND NEW.acceptance_mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CARD_MARKER_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_id, reporter_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at,
  report_waiver_round, report_waiver_reason, report_waived_at,
  awaiting_reason, acceptance_mode ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_upd AFTER UPDATE OF
  name, labels, meta_json, readme, archived_at, updated_at,
  reviewer, acceptance ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_review_no_reopen BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled')
 AND NEW.status = 'todo'
 AND NEW.review_of_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'INVALID_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS tr_rel_review_no_parent BEFORE INSERT ON task_relations
WHEN NEW.relation_type = 'parent'
 AND (
   (SELECT review_of_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
   OR (SELECT review_of_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'a review card cannot be a parent or a child');
END;

CREATE TRIGGER IF NOT EXISTS tr_tasks_review_not_review BEFORE INSERT ON tasks
WHEN NEW.review_of_id IS NOT NULL
 AND NEW.acceptance_mode = 'off'
 AND (SELECT review_of_id FROM tasks WHERE id = NEW.review_of_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a review cannot itself be reviewed');
END;

CREATE TRIGGER IF NOT EXISTS tr_activities_no_update BEFORE UPDATE ON task_activities
BEGIN
  SELECT RAISE(ABORT, 'ACTIVITY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS tr_activities_no_delete BEFORE DELETE ON task_activities
BEGIN
  SELECT RAISE(ABORT, 'ACTIVITY_APPEND_ONLY');
END;
