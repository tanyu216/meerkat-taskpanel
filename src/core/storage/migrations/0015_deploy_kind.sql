-- 0015_deploy_kind.sql — `deploy` becomes a task kind: the deployment marker.
--
-- The ruling this implements (T-20261013-232004, 谭玉 2026-10-13): a **deployment
-- card** — work that runs against a live instance (rebuilding `dist`, restarting
-- `taskd`, a full `install.sh` run) — must not be picked up by a poll. The lesson
-- behind it: `T-20261013-161055`, a deployment-drift card that `linus-poll`
-- claimed automatically, turned out not to be executable by the agent that
-- picked it up, and had to be pushed back to `blocked`.
--
-- The marker is a `kind`, mirroring `kind: epic` — the existing precedent for "a
-- card the automatic read must not offer" — rather than a label or a flag, so it
-- is checkable at the same three layers `epic` is: the SQL `CHECK`, the JS
-- vocabulary (`domain/enums.mjs`), and the enum-parity contract
-- (`test/contract/sql-parity.test.mjs`, both directions).
--
-- What 0015 does **not** do is as load-bearing as what it does. `epic` is
-- excluded from the candidate read *and* refused at the claim gate
-- (`not_claimable`), i.e. never claimable by anybody. `deploy` is excluded from
-- the candidate read **only** — the read a poll performs — because a deployment
-- card still has to be run: Elon assigns it and `issue move <ref> in_progress`
-- takes it. A `not_claimable` gate would lock the work out entirely instead of
-- keeping the poll off it. So the asymmetry is deliberate, and it is implemented
-- outside SQL: `domain/claim.mjs#AUTO_CLAIM_EXCLUDED_KINDS` is the read rule that
-- `commands/tasks.mjs#listCandidates` applies, and `decideClaim` refuses `epic`
-- while letting `deploy` through.
--
-- ---------------------------------------------------------------------------
-- Why this is a table rebuild
-- ---------------------------------------------------------------------------
--
-- `tasks.kind` carries a `CHECK (kind IN ('task','epic'))` — 0001's, carried
-- forward verbatim by 0013's rebuild. SQLite has no `ALTER TABLE … MODIFY`, and a
-- `CHECK` constraint cannot be dropped or widened in place, so until that CHECK
-- names `deploy` **every write of the new kind is refused by the table
-- constraint** and the vocabulary would be a lie. The rebuild is therefore the
-- mechanical consequence of the ruling, not a second design decision — exactly
-- the argument 0013 makes for `awaiting`, and the same procedure is used.
--
-- 0013's header carries the full rationale for the order
-- (`CREATE new → copy → DROP old → RENAME new`), for the `-- @foreign-keys: off`
-- request the runner honours, and for parking the five triggers that merely
-- *name* `tasks` from other tables. It is not repeated here; this file follows it
-- and changes **one token** of the schema it re-creates: the `kind` CHECK.
--
--   * every row survives, every column survives, every value survives —
--     `awaiting_reason` (0013) and `idem` (0009) included;
--   * **all seven** indexes on `tasks` are re-created, not six: 0013's rebuild
--     lost 0005's `ix_tasks_source` and 0014 had to put it back (0014's header
--     tells that story). A rebuild shipped *after* 0014 owes the full set, so
--     this file names 0005's index itself and owes no erratum;
--   * the 10 triggers attached to `tasks` and the 5 parked guards are re-created
--     verbatim (0013's text), so the transition whitelist, the delivery gate,
--     the terminal guard, the kind-downgrade guard and the revision cursor are
--     unbroken before and after;
--   * `PRAGMA foreign_key_check` and `PRAGMA integrity_check` are clean after.
--
-- `test/core/storage/migrations-0015.test.mjs` proves the upgrade across a
-- populated board; `test/core/storage/migrations-0013.test.mjs` independently
-- holds the "an upgrade and a fresh install land on the same index set" property,
-- and so catches a rebuild of *any* vintage that drops an index.
--
-- ---------------------------------------------------------------------------
-- The state machine and the kind-downgrade guard are untouched
-- ---------------------------------------------------------------------------
--
-- A new `kind` value is not a new status: `tr_tasks_transition` is re-created with
-- 0013's body verbatim. Nor does it move the parent rule: `tr_rel_parent_epic`
-- demands `kind = 'epic'` of a parent, so a `deploy` card can no more be a parent
-- than a `task` card can — no new guard is needed, and `assertParentIsEpic`
-- (`domain/relation.mjs`) refuses the same case at the service layer.
--
-- (`tr_tasks_kind_downgrade`, 0011, is re-created verbatim too. It fires on an
-- epic *leaving* `epic`, which is unchanged: a `deploy → task` downgrade is not an
-- epic downgrade and has no children to orphan.)
--
-- Append-only: 0001 … 0014 are never edited.

-- The request the runner reads (see `wantsForeignKeysOff`): `DROP TABLE tasks`
-- runs an implicit DELETE while five child tables reference it, and between that
-- drop and the rename those children name a parent that is momentarily absent.
-- It has to be a line of its own, and it is a comment to SQLite like any other.

-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- The five triggers *outside* `tasks` that name it in their body
-- ---------------------------------------------------------------------------
--
-- Parked, not edited — verbatim from 0013 (which took them from 0004/0002/0010).
-- SQLite re-reads and validates every object's text when a schema change forces a
-- reparse, and a trigger whose body says `SELECT project_id FROM tasks …` is fatal
-- the moment `tasks` is absent.

DROP TRIGGER IF EXISTS tr_dict_assignees_delete;   -- 0004
DROP TRIGGER IF EXISTS tr_dict_reporters_delete;   -- 0004
DROP TRIGGER IF EXISTS tr_rel_cross_project;       -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_guard;        -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_epic;         -- 0010

-- The replacement table: 0013's, byte for byte, except the `kind` CHECK. The
-- scratch name is short-lived — the rename at the end of the block is what makes
-- it `tasks`, and it is the only name this file ever moves.
CREATE TABLE tasks_deploy_v2 (
  id                      TEXT PRIMARY KEY,
  identifier              TEXT NOT NULL,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','canceled','awaiting')),
  priority                TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  -- The one changed token: `deploy` joins the vocabulary. `domain/enums.mjs`
  -- TASK_KINDS is the JS side; the parity test compares them in both directions.
  kind                    TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','epic','deploy')),
  labels                  TEXT NOT NULL DEFAULT '[]',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  assignee_kind           TEXT CHECK (assignee_kind IN ('agent','human')),
  assignee_id             TEXT REFERENCES assignees(id),
  reporter_id             TEXT REFERENCES reporters(id),
  creator_kind            TEXT CHECK (creator_kind IN ('agent','human','system')),
  creator_id              TEXT,
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
  -- A backlog task is never claimed (0001's table CHECK, preserved verbatim).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

-- Every column, `awaiting_reason` included: 0013's INSERT omitted it because the
-- column was *born* in that migration and every row's value is NULL. By 0015 the
-- column carries data — a card paused on a human — so it is copied like any other.
INSERT INTO tasks_deploy_v2 (
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at, heartbeat_at,
  blocked_at, status_changed_at, archived_at, source_path, source_hash, version,
  created_at, updated_at, report_latest_id, delivery_round, meta_json,
  report_waiver_round, report_waiver_reason, report_waived_at, idem, awaiting_reason
)
SELECT
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at, heartbeat_at,
  blocked_at, status_changed_at, archived_at, source_path, source_hash, version,
  created_at, updated_at, report_latest_id, delivery_round, meta_json,
  report_waiver_round, report_waiver_reason, report_waived_at, idem, awaiting_reason
FROM tasks;

-- The old table goes with its indexes and triggers; `tasks` comes back with the
-- same rows and the widened CHECK.
DROP TABLE tasks;
ALTER TABLE tasks_deploy_v2 RENAME TO tasks;

-- ---------------------------------------------------------------------------
-- Indexes — the complete set (0001 + 0005 + 0009), all **seven**
-- ---------------------------------------------------------------------------
--
-- `DROP … IF EXISTS` before each `CREATE` for the reason 0013 gives: a surviving
-- index left pointing at a table that no longer exists is a silent trap.
--
-- `ix_tasks_source` is the one 0013 forgot. It is named here because a board at
-- 0014 carries it, and a rebuild that did not re-create it would drop it again —
-- an upgrade and a fresh install would then disagree on the physical schema while
-- claiming the same migration set.

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
-- Every trigger on `tasks`, re-created verbatim from 0013
-- ---------------------------------------------------------------------------
--
-- Dropping `tasks` took them with it; a trigger left out would be a silently
-- missing invariant. Not one body changes in this migration — 0015 widens a
-- CHECK, it does not move a rule.

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

-- 0001 + 0006 + 0013 · the revision cursor, 0013's column domain verbatim.
DROP TRIGGER IF EXISTS tr_rev_tasks_ins;
CREATE TRIGGER tr_rev_tasks_ins AFTER INSERT ON tasks
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
DROP TRIGGER IF EXISTS tr_rev_tasks_upd;
CREATE TRIGGER tr_rev_tasks_upd AFTER UPDATE OF
  status, version, title, description, priority, kind, labels, sort_order,
  assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
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
-- ...and the five parked guards, put back verbatim
-- ---------------------------------------------------------------------------

CREATE TRIGGER tr_dict_assignees_delete BEFORE DELETE ON assignees
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

CREATE TRIGGER tr_dict_reporters_delete BEFORE DELETE ON reporters
WHEN EXISTS (SELECT 1 FROM tasks WHERE reporter_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

CREATE TRIGGER tr_rel_cross_project BEFORE INSERT ON task_relations
WHEN (SELECT project_id FROM tasks WHERE id = NEW.source_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.target_task_id) IS NOT NULL
 AND (SELECT project_id FROM tasks WHERE id = NEW.source_task_id)
     IS NOT (SELECT project_id FROM tasks WHERE id = NEW.target_task_id)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION');
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
