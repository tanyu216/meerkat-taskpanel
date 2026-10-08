-- 0001_core_tables.sql — the board's tables, in foreign-key dependency order.
--
-- Rules (plan §3.3): every table is STRICT; every DDL is `IF NOT EXISTS` so a
-- re-apply is a no-op; "append-only" is enforced by `schema_migrations`
-- checksums, not by making these statements conditional.
--
-- Time columns are TEXT, ISO-8601 UTC with fixed millisecond width
-- (`2026-10-08T15:31:25.161Z`) so lexicographic order is chronological order —
-- the report gate and the SSE cursor both depend on that.
--
-- `tasks.report_latest_id` and `tasks.delivery_round` are deliberately NOT
-- here: they arrive by ALTER in 0003_reports.sql, next to the reports table
-- they belong to.

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  workspace_path    TEXT NOT NULL CHECK (workspace_path LIKE '/%'),
  next_task_number  INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
  labels            TEXT NOT NULL DEFAULT '[]',
  meta_json         TEXT NOT NULL DEFAULT '{}',
  readme            TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_workspace ON projects(workspace_path);

-- Dictionary entities (§4.4): no management surface, grown by use. They are
-- created before `tasks` because tasks reference them.
CREATE TABLE IF NOT EXISTS assignees (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('agent','human')),
  display_name     TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  platform         TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  use_count        INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS reporters (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('agent','human')),
  display_name     TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  platform         TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  use_count        INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  identifier        TEXT NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','canceled')),
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  kind              TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','epic')),
  labels            TEXT NOT NULL DEFAULT '[]',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  assignee_kind     TEXT CHECK (assignee_kind IN ('agent','human')),
  assignee_id       TEXT REFERENCES assignees(id),
  reporter_id       TEXT REFERENCES reporters(id),
  creator_kind      TEXT CHECK (creator_kind IN ('agent','human','system')),
  creator_id        TEXT,
  agent_session     TEXT,
  thread_id         TEXT,
  thread_source     TEXT,
  claimed_by        TEXT,
  claimed_at        TEXT,
  heartbeat_at      TEXT,
  blocked_at        TEXT,
  status_changed_at TEXT NOT NULL DEFAULT '',
  archived_at       TEXT,
  source_path       TEXT,
  source_hash       TEXT,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- A backlog task is never claimed. `in_progress` without `claimed_by` is
  -- allowed on purpose: the service reports it as EXECUTION_STATE_CORRUPT (I2).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_identifier ON tasks(project_id, identifier);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tasks_board ON tasks(project_id, status, sort_order);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(project_id, assignee_id);
CREATE INDEX IF NOT EXISTS ix_tasks_heartbeat ON tasks(status, heartbeat_at);

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

-- At most one parent per child (I: single parent).
CREATE UNIQUE INDEX IF NOT EXISTS ux_relations_single_parent ON task_relations(target_task_id) WHERE relation_type = 'parent';
CREATE UNIQUE INDEX IF NOT EXISTS ux_relations_triple ON task_relations(relation_type, source_task_id, target_task_id);

CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('discuss','decision','confirm','change','note','defect')),
  author_kind    TEXT NOT NULL CHECK (author_kind IN ('agent','human','system')),
  author_id      TEXT NOT NULL,
  agent_session  TEXT,
  refs_json      TEXT NOT NULL DEFAULT '[]',
  source_seq     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL
) STRICT;

-- Import idempotency key: the Nth comment of a card is the same comment.
CREATE UNIQUE INDEX IF NOT EXISTS ux_comments_source ON comments(task_id, source_seq) WHERE source_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_comments_task ON comments(task_id, created_at);

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

CREATE INDEX IF NOT EXISTS ix_activities_task ON task_activities(task_id, id);

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
  backend     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  phase       TEXT,
  pid         INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','closed','failed')),
  ts          TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_natural ON agent_sessions(task_id, seg, owner);

-- SSE / incremental cursor. One row, forever.
CREATE TABLE IF NOT EXISTS global_revision (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision   INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT OR IGNORE INTO global_revision(singleton, revision) VALUES (1, 0);

-- The runner also bootstraps this before reading it; declared here so the
-- schema is self-describing.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- global_revision triggers (ARCHITECTURE §4.2, F10).
--
-- Any write to a board table bumps the cursor so one SSE cursor covers
-- everything. Heartbeats bump it too (they touch `version`/`updated_at`): a
-- heartbeat *is* a change worth pushing, and one cursor beats two.
--
-- `global_revision` and `schema_migrations` are excluded on purpose.
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS tr_rev_projects_ins AFTER INSERT ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
-- Column domain cropped on purpose: `next_task_number` is an implementation
-- counter, and ticking it is not a change a client needs pushed. Without this,
-- every task creation would cost two revisions (the counter, then the task).
CREATE TRIGGER IF NOT EXISTS tr_rev_projects_upd AFTER UPDATE OF
  name, workspace_path, labels, meta_json, readme, archived_at, updated_at ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_projects_del AFTER DELETE ON projects
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

-- The column domain matters: the round bump (0003) issues a nested
-- `UPDATE tasks SET delivery_round = delivery_round + 1`, and `delivery_round`
-- is deliberately absent here so one status move costs exactly one revision
-- (plan §3.3.6③). Do not add it.
CREATE TRIGGER IF NOT EXISTS tr_rev_tasks_ins AFTER INSERT ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_tasks_del AFTER DELETE ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_task_relations_ins AFTER INSERT ON task_relations
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_task_relations_upd AFTER UPDATE ON task_relations
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_task_relations_del AFTER DELETE ON task_relations
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

CREATE TRIGGER IF NOT EXISTS tr_rev_comments_ins AFTER INSERT ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_comments_upd AFTER UPDATE ON comments
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS tr_rev_comments_del AFTER DELETE ON comments
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
