-- 0019_actors.sql — the two dictionary tables become one actor table, deduplicated,
-- and `tasks` stops carrying its own copy of the assignee's kind.
--
-- ---------------------------------------------------------------------------
-- Why: one person, one row
-- ---------------------------------------------------------------------------
--
-- `0001` made two tables, `assignees` and `reporters`, each with its own identity
-- rule `UNIQUE(normalized_name, kind)` (0004). Between them they say the same
-- person twice: a card's `created_by` and a card's `assignee` can be the same
-- human, and the board has always stored that as two rows in two tables that do
-- not know about each other. The normalisation is already single-source
-- (`src/shared/norm.mjs`), so the *key* agrees while the *storage* does not —
-- which is the whole defect. Two copies of "Terry" can drift, and nothing keeps
-- them in step.
--
-- This migration makes one table, `actors`, keyed by `UNIQUE(normalized_name)`,
-- and **roles become columns**: `tasks.assignee_id` and `tasks.reporter_id` are
-- the two roles, and there is no role table. `assignee`/`reporter` survive only
-- as the name of the column a task uses.
--
-- The two columns that were a *copy* of an actor fact are removed from `tasks`:
--
--   * `tasks.assignee_kind` and `tasks.creator_kind` restated the kind that now
--     lives on the actor row. A copy of a mutable value goes stale, and the wire
--     already carries the kind on the `actorRef` it builds from the dictionary
--     row — so the copy is dead weight the moment `actors` exists;
--   * `tasks.creator_id` is removed because **the creator is the reporter**.
--     `created_by` in a card has always been written to `tasks.reporter_id` as
--     well; keeping a second column for the same fact is the same mistake one
--     level down.
--
-- `tasks.claimed_by` is **deliberately untouched** — it stays a free string here.
-- Live `claim` writes an actor *id* into it (`commands/tasks.mjs#claimCas`) while
-- the markdown importer writes a card's *name*, so the column carries two value
-- spaces that meet in one comparison (`tasks.mjs#staleReason`). Turning it into a
-- foreign key needs a pre-flight analysis of which values are which, and that is
-- a later migration of its own. This file neither back-fills nor constrains it.
--
-- ---------------------------------------------------------------------------
-- This is the irreversible one
-- ---------------------------------------------------------------------------
--
-- Every other migration in the set can be reasoned about by reading it. This one
-- **destroys rows**: two rows with one `normalized_name` become one, and the
-- loser is not archived. The merge rule is therefore stated exactly and tested
-- against a board that actually contains duplicates
-- (`test/core/storage/migrations-0019.test.mjs`), because a board with nothing to
-- collide proves nothing:
--
--   * a **group** is one `normalized_name`, spanning both tables;
--   * the **survivor** is the group's earliest row (`first_seen_at`, then `id` as
--     a stable tie-break), so it keeps its `id` and the tasks that pointed at it
--     keep pointing at it;
--   * `use_count` = SUM over the group; `first_seen_at` = MIN; `last_seen_at` =
--     MAX; `display_name` = the survivor's (the earliest spelling wins — the same
--     "the dictionary's spelling wins on reuse" rule the live path already uses);
--   * `kind` = the survivor's.
--
-- Every task reference is then repointed from a loser id to its group's
-- survivor id, in **both** columns — the same survivor can be the assignee of one
-- card and the reporter of another.
--
-- ---------------------------------------------------------------------------
-- How the rebuild is done, and why *this* order
-- ---------------------------------------------------------------------------
--
-- SQLite has no `ALTER TABLE … DROP COLUMN` for a column a trigger names, and no
-- `ALTER TABLE … MODIFY` at all, so `tasks` is rebuilt — the third time in this
-- set (0013, 0015, and here), following `0015_deploy_kind.sql` exactly. That
-- file's header carries the full rationale for `CREATE new → copy → DROP old →
-- RENAME new`, for the `-- @foreign-keys: off` request below, and for parking the
-- guards that merely *name* `tasks` from other tables. Only what is specific to
-- this migration is repeated here.
--
-- The order is forced by two facts:
--
--   1. **The repoint needs the old tables present.** A loser id is mapped to its
--      group's survivor through `assignees.normalized_name` (resp.
--      `reporters.normalized_name`), so the repoint runs *before* the two tables
--      are dropped.
--   2. **The children need the parent renamed before it is dropped.** `tasks` is
--      rebuilt (its FK moves from `assignees`/`reporters` to `actors`) and only
--      then are the two old tables dropped; between the two the child no longer
--      references either.
--
-- Six triggers are parked or dropped for the duration, because they name a table
-- that is momentarily absent and a trigger body is re-validated on a schema
-- change:
--
--   * `tr_dict_assignees_delete` / `tr_dict_reporters_delete` — **dropped**, not
--     parked: their function moves to a single guard on `actors` (below), and the
--     tables they live on are about to go;
--   * `tr_rel_cross_project`, `tr_rel_parent_guard`, `tr_rel_parent_epic`,
--     `tr_rel_block_cycle` — **parked and re-created verbatim** after the rename
--     (0015 parked the first three; `tr_rel_block_cycle` arrived with 0017, after
--     0015, and joins the parked set now).
--
-- `PRAGMA foreign_keys` is a no-op inside a transaction, so the request is made to
-- the runner — the marker line below — rather than issued here.
--
-- ---------------------------------------------------------------------------
-- The delete guard is now role-aware, not table-aware
-- ---------------------------------------------------------------------------
--
-- 0004 armed one guard per table, each checking the one column that table
-- answered (`assignees` → `assignee_id`, `reporters` → `reporter_id`). With one
-- table answering **both** columns, a single guard on `actors` refuses a delete
-- while *either* column references the row. The reason code is unchanged
-- (`DICTIONARY_ENTRY_IN_USE`), so the SQL⇄JS raise-code contract does not move.
--
-- Append-only: 0001 … 0018 are never edited.

-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- 1 · The two dictionary guards go (their job moves to `actors`), the four
--     relation guards are parked
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_dict_assignees_delete;   -- 0004
DROP TRIGGER IF EXISTS tr_dict_reporters_delete;   -- 0004
DROP TRIGGER IF EXISTS tr_rel_cross_project;       -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_guard;        -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_epic;         -- 0010
DROP TRIGGER IF EXISTS tr_rel_block_cycle;         -- 0017

-- ---------------------------------------------------------------------------
-- 2 · The one actor table
-- ---------------------------------------------------------------------------

-- `kind` is an open, non-empty string with no `CHECK` — 0018 opened the two
-- columns that carried the enumeration, and this table is born open for the same
-- reason: `human` is the only value the schema reserves meaning for. `platform`
-- is deliberately absent: it was a third axis that never carried a value (the
-- only writer passed `null`), and the kind is what identifies "which agent".
CREATE TABLE actors (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1)
) STRICT;

-- One row per person, across both old tables. This is the index that makes the
-- merge's uniqueness a fact rather than a hope.
CREATE UNIQUE INDEX ux_actors_norm ON actors(normalized_name);

-- ---------------------------------------------------------------------------
-- 3 · Merge + deduplicate, in one statement
-- ---------------------------------------------------------------------------

-- `merged` is both tables stacked; `grouped` collapses them by `normalized_name`.
-- The survivor — the group's earliest row, `id` breaking a tie — supplies id,
-- kind and display_name, so the id that stays is a real one a task already holds.
-- `use_count` sums, `first_seen_at` takes the min, `last_seen_at` the max.
--
-- Written as one INSERT so the dedup is atomic with the table's first population;
-- there is no window in which `actors` holds half a group.
WITH merged(id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count) AS (
  SELECT id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count FROM assignees
  UNION ALL
  SELECT id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count FROM reporters
),
grouped AS (
  SELECT
    normalized_name,
    MIN(first_seen_at) AS first_seen_at,
    MAX(last_seen_at)  AS last_seen_at,
    SUM(use_count)     AS use_count
  FROM merged
  GROUP BY normalized_name
)
INSERT INTO actors(id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count)
SELECT
  (SELECT m.id           FROM merged m WHERE m.normalized_name = g.normalized_name ORDER BY m.first_seen_at ASC, m.id ASC LIMIT 1),
  (SELECT m.kind         FROM merged m WHERE m.normalized_name = g.normalized_name ORDER BY m.first_seen_at ASC, m.id ASC LIMIT 1),
  (SELECT m.display_name FROM merged m WHERE m.normalized_name = g.normalized_name ORDER BY m.first_seen_at ASC, m.id ASC LIMIT 1),
  g.normalized_name,
  g.first_seen_at,
  g.last_seen_at,
  g.use_count
FROM grouped g;

-- ---------------------------------------------------------------------------
-- 4 · Repoint every task reference from a loser id to its group's survivor
-- ---------------------------------------------------------------------------

-- A loser's `normalized_name` is read from the table it lived in, and the group's
-- survivor id is read back from `actors`. Both columns are repointed, because a
-- person can be the assignee of one card and the reporter of another — and the
-- two must land on the same actor row.
--
-- The `WHERE … IS NOT NULL` guard keeps the statement off rows that name nobody;
-- `NULL` has no group and must stay `NULL`.
UPDATE tasks
SET assignee_id = (
  SELECT a.id FROM actors a
  WHERE a.normalized_name = (SELECT na.normalized_name FROM assignees na WHERE na.id = tasks.assignee_id)
)
WHERE assignee_id IS NOT NULL;

UPDATE tasks
SET reporter_id = (
  SELECT a.id FROM actors a
  WHERE a.normalized_name = (SELECT nr.normalized_name FROM reporters nr WHERE nr.id = tasks.reporter_id)
)
WHERE reporter_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5 · `tasks` — the rebuild: two FK targets become one, three columns go
-- ---------------------------------------------------------------------------

-- 0015's table, byte for byte, with three edits and nothing else:
--   * `assignee_id` / `reporter_id` reference `actors(id)` instead of the two old
--     tables;
--   * `assignee_kind`, `creator_kind`, `creator_id` are gone (see the header);
--   * `blocked_reason` (0016, an `ALTER … ADD COLUMN`) is declared in place, last,
--     because a rebuild has to declare it where it sits rather than re-add it.
CREATE TABLE tasks_actors_v2 (
  id                      TEXT PRIMARY KEY,
  identifier              TEXT NOT NULL,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','canceled','awaiting')),
  priority                TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  kind                    TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','epic','deploy')),
  labels                  TEXT NOT NULL DEFAULT '[]',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  assignee_id             TEXT REFERENCES actors(id),
  reporter_id             TEXT REFERENCES actors(id),
  agent_session           TEXT,
  thread_id               TEXT,
  thread_source           TEXT,
  claimed_by              TEXT,
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
  blocked_reason          TEXT CHECK (blocked_reason IN ('clarify','decision','dependency','out_of_bounds','defect','external','resource','unknown')),
  -- A backlog task is never claimed (0001's table CHECK, preserved verbatim).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

-- Every surviving column, in 0015's order minus the three dropped ones.
INSERT INTO tasks_actors_v2 (
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_id, reporter_id, agent_session, thread_id, thread_source,
  claimed_by, claimed_at, heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, version, created_at, updated_at, report_latest_id,
  delivery_round, meta_json, report_waiver_round, report_waiver_reason,
  report_waived_at, idem, awaiting_reason, blocked_reason
)
SELECT
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_id, reporter_id, agent_session, thread_id, thread_source,
  claimed_by, claimed_at, heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, version, created_at, updated_at, report_latest_id,
  delivery_round, meta_json, report_waiver_round, report_waiver_reason,
  report_waived_at, idem, awaiting_reason, blocked_reason
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_actors_v2 RENAME TO tasks;

-- The two old dictionary tables. Their six revision triggers and their CHECKs go
-- with them; `tasks` no longer references either.
DROP TABLE assignees;
DROP TABLE reporters;

-- ---------------------------------------------------------------------------
-- 6 · `tasks` indexes — the complete set (0001 + 0005 + 0009), all seven
-- ---------------------------------------------------------------------------

-- `DROP … IF EXISTS` before each `CREATE` for the reason 0013 gives: a surviving
-- index left pointing at a table that no longer exists is a silent trap.
DROP INDEX IF EXISTS ux_tasks_identifier;
DROP INDEX IF EXISTS ux_tasks_source;
DROP INDEX IF EXISTS ix_tasks_board;
DROP INDEX IF EXISTS ix_tasks_assignee;
DROP INDEX IF EXISTS ix_tasks_heartbeat;
DROP INDEX IF EXISTS ix_tasks_source;
DROP INDEX IF EXISTS ux_tasks_idem_active;

CREATE UNIQUE INDEX ux_tasks_identifier ON tasks(project_id, identifier);
CREATE UNIQUE INDEX ux_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;
CREATE INDEX ix_tasks_board ON tasks(project_id, status, sort_order);
CREATE INDEX ix_tasks_assignee ON tasks(project_id, assignee_id);
CREATE INDEX ix_tasks_heartbeat ON tasks(status, heartbeat_at);
CREATE INDEX ix_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;
CREATE UNIQUE INDEX ux_tasks_idem_active
  ON tasks(idem)
  WHERE idem IS NOT NULL AND status NOT IN ('done','canceled');

-- ---------------------------------------------------------------------------
-- 7 · Every trigger on `tasks`, re-created from 0015's text
-- ---------------------------------------------------------------------------

-- Nine of the ten are 0015's verbatim; one moves, and it has to. `tr_rev_tasks_upd`
-- fires `AFTER UPDATE OF <column list>`, and the list named `assignee_kind`,
-- `creator_kind` and `creator_id` — columns this migration removes. A trigger may
-- not name a column that does not exist, so its domain follows the columns, exactly
-- as 0013's rebuild moved the same trigger's domain when 0013 changed the table.
-- No *rule* moves: the trigger still bumps the revision on every write the board
-- makes, and still does not name `blocked_reason` (0016's deliberate hole, pinned
-- by `test/contract/md-blocked-reason.test.mjs`).

-- 0002/0013 · the transition whitelist, same table as domain/status.mjs.
DROP TRIGGER IF EXISTS tr_tasks_transition;
CREATE TRIGGER tr_tasks_transition BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND OLD.status NOT IN ('done','canceled')
BEGIN
  SELECT CASE
    WHEN NOT (
         (OLD.status = 'backlog'     AND NEW.status IN ('todo','canceled'))
      OR (OLD.status = 'todo'        AND NEW.status IN ('backlog','in_progress','blocked','canceled'))
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_review','blocked','todo','canceled','awaiting'))
      OR (OLD.status = 'in_review'   AND NEW.status IN ('done','in_progress','blocked'))
      OR (OLD.status = 'blocked'     AND NEW.status IN ('todo','in_progress','in_review','canceled'))
      OR (OLD.status = 'awaiting'    AND NEW.status IN ('in_progress','canceled'))
    ) THEN RAISE(ABORT, 'INVALID_TRANSITION')
    ELSE NULL
  END;
END;

-- 0002 · terminal statuses are forever (I3).
DROP TRIGGER IF EXISTS tr_tasks_terminal;
CREATE TRIGGER tr_tasks_terminal BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'TERMINAL_STATE');
END;

-- 0002 · archiving is for finished work only (I6).
DROP TRIGGER IF EXISTS tr_tasks_archive_terminal;
CREATE TRIGGER tr_tasks_archive_terminal BEFORE UPDATE OF archived_at ON tasks
WHEN NEW.archived_at IS NOT NULL AND NEW.status NOT IN ('done','canceled')
BEGIN
  SELECT RAISE(ABORT, 'ARCHIVE_NOT_TERMINAL');
END;

-- 0011 · an epic with children may not be downgraded (ARCHITECTURE §4.1).
DROP TRIGGER IF EXISTS tr_tasks_kind_downgrade;
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

-- 0003 · report_latest_id must belong to this task.
DROP TRIGGER IF EXISTS tr_latest_report_belongs;
CREATE TRIGGER tr_latest_report_belongs BEFORE UPDATE OF report_latest_id ON tasks
WHEN NEW.report_latest_id IS NOT NULL
 AND (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'REPORT_TASK_MISMATCH');
END;

-- 0008 · THE GATE — no delivery report for the current round ⇒ no in_review.
DROP TRIGGER IF EXISTS tr_deliver_gate;
CREATE TRIGGER tr_deliver_gate BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'in_review'
 AND OLD.status IN ('in_progress','blocked')
 AND (NEW.report_latest_id IS NULL
      OR (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NEW.id)
 AND NOT EXISTS (
   SELECT 1 FROM task_reports
   WHERE task_id = NEW.id AND round = NEW.delivery_round AND origin = 'delivery'
 )
 AND NOT (
   NEW.report_waiver_round IS NEW.delivery_round
   AND NEW.report_waiver_reason IS NOT NULL
   AND length(trim(NEW.report_waiver_reason)) >= 8
 )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_REQUIRED');
END;

-- 0003 · round bump (F3), keyed on OLD.status = 'in_review'.
DROP TRIGGER IF EXISTS tr_tasks_round_bump;
CREATE TRIGGER tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;

-- 0001 + 0006 + 0013 · the revision cursor. The column domain loses the three
-- dropped columns and is otherwise 0015's.
DROP TRIGGER IF EXISTS tr_rev_tasks_ins;
CREATE TRIGGER tr_rev_tasks_ins AFTER INSERT ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
DROP TRIGGER IF EXISTS tr_rev_tasks_upd;
CREATE TRIGGER tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_id, reporter_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at,
  heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, report_latest_id, updated_at,
  report_waiver_round, report_waiver_reason, report_waived_at,
  awaiting_reason ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
DROP TRIGGER IF EXISTS tr_rev_tasks_del;
CREATE TRIGGER tr_rev_tasks_del AFTER DELETE ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

-- ---------------------------------------------------------------------------
-- 8 · The parked relation guards come back verbatim, and the actor delete guard
--     lands
-- ---------------------------------------------------------------------------

-- 0002 · a relation may not cross projects.
CREATE TRIGGER tr_rel_cross_project BEFORE INSERT ON task_relations
WHEN (SELECT project_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS NOT (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION');
END;

-- 0002 · a parent edge: no cycle, chain ≤ 8, fan-in ≤ 8.
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

-- 0010 · only an epic can be a parent.
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

-- 0017 · a `blocks` edge may not close a loop (source is the blocker).
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

-- 0004's two guards, fused into one on `actors`: a row referenced by *either* role
-- may not be deleted. Defence in depth for the §4.4 invariant — the service layer
-- has no delete command, so this only fires against a direct DELETE.
CREATE TRIGGER tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

-- ---------------------------------------------------------------------------
-- 9 · `actors` joins the revision cursor
-- ---------------------------------------------------------------------------

-- The two old tables each carried a revision trigger per event (0004); one table
-- carries the same three.
CREATE TRIGGER tr_rev_actors_ins AFTER INSERT ON actors
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER tr_rev_actors_upd AFTER UPDATE ON actors
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER tr_rev_actors_del AFTER DELETE ON actors
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
