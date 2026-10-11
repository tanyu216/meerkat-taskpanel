-- 0013_awaiting_status.sql — M1: `awaiting` becomes a first-class task status.
--
-- The ruling this implements (Terry 2026-10-12, M1 · design §2/§6): a card that
-- is *running but waiting on a human* is a real, stored state — not a comment,
-- not a flag. `domain/status.mjs#ALLOWED_TRANSITIONS` is the fact source; this
-- file re-encodes the same table as a trigger, exactly as 0002 did.
--
-- ---------------------------------------------------------------------------
-- What this migration has to do, and the one thing the card did not name
-- ---------------------------------------------------------------------------
--
-- The card asked for the trigger rebuild: `DROP TRIGGER tr_tasks_transition`
-- and re-create it with `awaiting` in the `WHEN` clause. That is here
-- (see "the transition whitelist" below). But the trigger is **not** the only
-- guard that has to move, and the second one cannot be altered at all:
--
--   `tasks.status` carries a `CHECK (status IN (…7 words…))` from 0001. SQLite
--   has no `ALTER TABLE … MODIFY`, and a `CHECK` constraint cannot be dropped or
--   widened in place. Until that CHECK names `awaiting`, **every write of the
--   new status is refused by the table constraint**, so the trigger would be
--   dead code behind a stricter gate. The rebuild below is therefore not a
--   stylistic choice — it is the only supported way to widen a `CHECK`, and it
--   is the mechanical consequence of the frozen design (`awaiting` is a stored
--   status), not a new design decision.
--
-- It is also the **first** rebuild in this history, so the pattern is written
-- out in full and the invariants it must preserve are named:
--
--   * every row survives, every column survives, every value survives;
--   * the table's own 6 indexes are re-created (they go with the old table);
--   * the 10 triggers attached to `tasks` are re-created — renames/drops take
--     triggers with their table, so leaving them out would silently delete the
--     delivery gate, the terminal guard and the revision cursor;
--   * `PRAGMA foreign_key_check` and `PRAGMA integrity_check` are clean after.
--
-- ---------------------------------------------------------------------------
-- How the rebuild is done, and why *this* order
-- ---------------------------------------------------------------------------
--
-- `CREATE new → copy → DROP old → RENAME new to `tasks`` — the order SQLite's
-- own ALTER TABLE documentation prescribes, and the only one that survives
-- SQLite ≥ 3.25's rename semantics.
--
-- The tempting alternative — rename `tasks` out of the way first, then create
-- the new table under the final name — is **wrong here**, and wrong silently:
-- since 3.25, `ALTER TABLE … RENAME TO` rewrites *references to the renamed
-- table in other tables*. `task_relations`, `comments`, `attachments`,
-- `agent_sessions` and `task_reports` all carry `REFERENCES tasks(id)`, so that
-- rename would repoint every one of them at the scratch name, and dropping the
-- scratch table would leave five tables whose parent does not exist. (Measured
-- on this tree: the old order produced `no such table:
-- main.tasks_awaiting_pre_0013` on the first write after migrating. That is why
-- the order below is what it is.)
--
-- In this order the *only* name that ever moves is the scratch one, and nothing
-- references the scratch name — so no reference is rewritten and no child ends
-- up pointing at a table that is about to disappear.
--
-- The order also needs foreign key enforcement **off** for its duration, which is
-- what the marker line below asks the runner for: `DROP TABLE tasks` runs an
-- implicit `DELETE` while five child tables reference it, and between that drop
-- and the rename those children name a parent that is momentarily absent.
-- `PRAGMA defer_foreign_keys` is *not* enough for that — it postpones
-- enforcement, but the failure here is resolution, which reports `no such table`
-- the instant the parent is missing, however brief the window (measured: an
-- immediate `defer_foreign_keys`-only attempt failed with exactly that error).
-- `PRAGMA foreign_keys` is a documented no-op inside a transaction, and a
-- migration file always runs in one, which is why the request has to be made to
-- the runner instead of issued here. It is put back whatever happens, so no later
-- migration inherits a relaxed connection.
--
-- (The request itself is the single line immediately below this paragraph — it
-- has to be a line of its own, and it is a comment to SQLite like any other.)
--
-- @foreign-keys: off
--
-- Dropping the old table takes `tasks`'s indexes and triggers with it, so both
-- are re-created below: the 6 indexes verbatim, and the 10 triggers from their
-- **last** shipped definitions (0001's revision pair, 0002's status guards,
-- 0003's gate and round bump, 0006's waiver columns, 0008's
-- `origin = 'delivery'`, 0011's kind downgrade) — verbatim bodies, so nothing
-- about them moves by accident.
--
-- `test/helpers/sql-parse.mjs` follows the rename when it reads this file, so
-- the contract tests see the *effective* schema: the widened `tasks.status`
-- CHECK and `tasks.awaiting_reason`, not a scratch table that no longer exists.
--
-- ---------------------------------------------------------------------------
-- What changes in the state machine
-- ---------------------------------------------------------------------------
--
-- Two words move and one entry is added to the reconstructed table:
--
--   * `in_progress` may now go to `awaiting` — **the only entry**;
--   * `awaiting` may go to `in_progress` (**the only way back into the work**)
--     or to `canceled` (the human cancels);
--   * `awaiting → blocked` and `awaiting → in_review | done` stay **absent**.
--     The last two are a delivery-gate bypass: `in_review` is what the gate
--     guards, so reaching it from `awaiting` would skip the report for the
--     current round. `domain/status.mjs` refuses the same pairs, and
--     `test/contract/state-machine.test.mjs` walks all 64 pairs down both paths.
--
--   * `awaiting` is **not** terminal, and `awaiting → in_progress` does **not**
--     start a new delivery round: 0003's `tr_tasks_round_bump` fires only when
--     `OLD.status = 'in_review'`, and the card never left `in_progress`. It is
--     re-created below with that clause unchanged.
--
-- `awaiting_reason` (design §2.1: the entry category is an enumeration,
-- `E1..E5`, never free text) is added to the re-created table. It is nullable
-- on purpose — a card that is not `awaiting` carries NULL, and the table CHECK
-- is satisfied by NULL exactly as `tasks.assignee_kind`'s is.
--
-- Append-only: 0001/0002/0003/0006/0008/0011 are never edited.

-- ---------------------------------------------------------------------------
-- The five triggers *outside* `tasks` that name it in their body
-- ---------------------------------------------------------------------------
--
-- Dropping a table takes its own triggers with it, but it does nothing about the
-- objects on **other** tables whose SQL mentions it — and SQLite re-reads and
-- validates every object's text whenever it reparses the schema, which the
-- rename below forces. A trigger on `task_relations` whose body says
-- `SELECT project_id FROM tasks …` is therefore fatal the instant `tasks` is
-- momentarily absent:
--
--   `error in trigger tr_rel_cross_project: no such table: main.tasks`
--
-- (Measured on this tree — the first version of this migration did not park
-- them, and every board in the suite failed to migrate.)
--
-- These are the complete set: a trigger is either *on* `tasks` (and so goes with
-- its table, re-created later in this file) or references `tasks` from one of
-- the three clauses below. They are parked — not edited — and put back verbatim
-- at the end of the file, so the guards they enforce are unbroken before and
-- after; `test/core/storage/migrations-0013.test.mjs` exercises each one.

DROP TRIGGER IF EXISTS tr_dict_assignees_delete;   -- 0004
DROP TRIGGER IF EXISTS tr_dict_reporters_delete;   -- 0004
DROP TRIGGER IF EXISTS tr_rel_cross_project;       -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_guard;        -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_epic;         -- 0010

-- The replacement table. Its scratch name is deliberate and short-lived: the
-- rename at the end of the block below is what makes it `tasks`, and it is the
-- only name this file ever moves.
CREATE TABLE tasks_awaiting_v2 (
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
  -- M1 · design §2.1 — why the card needed a human. NULL when the card is not
  -- `awaiting`. The CHECK passes on NULL (SQLite treats a NULL or true CHECK as
  -- satisfied), which is what makes the column optional without a second
  -- `IS NULL OR` branch — the same shape as `assignee_kind` above.
  awaiting_reason         TEXT CHECK (awaiting_reason IN ('E1','E2','E3','E4','E5')),
  -- A backlog task is never claimed (0001's table CHECK, preserved verbatim).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

INSERT INTO tasks_awaiting_v2 (
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at, heartbeat_at,
  blocked_at, status_changed_at, archived_at, source_path, source_hash, version,
  created_at, updated_at, report_latest_id, delivery_round, meta_json,
  report_waiver_round, report_waiver_reason, report_waived_at, idem
)
SELECT
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
  agent_session, thread_id, thread_source, claimed_by, claimed_at, heartbeat_at,
  blocked_at, status_changed_at, archived_at, source_path, source_hash, version,
  created_at, updated_at, report_latest_id, delivery_round, meta_json,
  report_waiver_round, report_waiver_reason, report_waived_at, idem
FROM tasks;

-- The old table goes with its indexes and triggers; `tasks` comes back with the
-- same rows and the widened CHECK.
DROP TABLE tasks;
ALTER TABLE tasks_awaiting_v2 RENAME TO tasks;

-- ---------------------------------------------------------------------------
-- Indexes (0001 + 0005 + 0009, verbatim names and shapes)
-- ---------------------------------------------------------------------------
--
-- `DROP … IF EXISTS` before each `CREATE`, rather than `CREATE … IF NOT
-- EXISTS`: when a table is dropped its indexes normally go with it, so the
-- CREATE alone would do — but "normally" is doing work in that sentence, and a
-- surviving index left pointing at a table that no longer exists is a silent
-- trap. Naming the drop makes the file correct whatever the rename did with
-- them.

DROP INDEX IF EXISTS ux_tasks_identifier;
DROP INDEX IF EXISTS ux_tasks_source;
DROP INDEX IF EXISTS ix_tasks_board;
DROP INDEX IF EXISTS ix_tasks_assignee;
DROP INDEX IF EXISTS ix_tasks_heartbeat;
DROP INDEX IF EXISTS ux_tasks_idem_active;

CREATE UNIQUE INDEX ux_tasks_identifier ON tasks(project_id, identifier);
CREATE UNIQUE INDEX ux_tasks_source ON tasks(project_id, source_path) WHERE source_path IS NOT NULL;
CREATE INDEX ix_tasks_board ON tasks(project_id, status, sort_order);
CREATE INDEX ix_tasks_assignee ON tasks(project_id, assignee_id);
CREATE INDEX ix_tasks_heartbeat ON tasks(status, heartbeat_at);
CREATE UNIQUE INDEX ux_tasks_idem_active
  ON tasks(idem)
  WHERE idem IS NOT NULL AND status NOT IN ('done','canceled');

-- ---------------------------------------------------------------------------
-- The transition whitelist — same table as domain/status.mjs#ALLOWED_TRANSITIONS
-- ---------------------------------------------------------------------------
--
-- 0002's body, verbatim, with two words moved and one entry added. A change to
-- this CASE without a matching change to `ALLOWED_TRANSITIONS` is caught by
-- `test/contract/state-machine.test.mjs`, which walks all 64 ordered pairs down
-- both paths. The `WHEN` guard is unchanged: the trigger only speaks when the
-- value actually changes and the old status is not terminal.

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

-- ---------------------------------------------------------------------------
-- Every other trigger on `tasks`, re-created verbatim
-- ---------------------------------------------------------------------------
--
-- Each body is copied from its last shipped definition and is unchanged by M1.
-- They are here because the rebuild removed them with the old table; a trigger
-- left out would be a silently missing invariant.

-- 0002 · terminal statuses are forever (I3). Disjoint from tr_tasks_transition
-- on OLD.status: this one speaks only when OLD.status is terminal.
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
-- `OLD.status IN ('in_progress','blocked')` is what keeps it disjoint from the
-- two status guards above, and it is also why an `awaiting` card can never slip
-- into review: `awaiting → in_review` is not on the whitelist at all, so this
-- trigger is never even asked. The clause is left exactly as shipped.
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

-- 0003 · round bump (F3). Keyed on OLD.status = 'in_review', so `awaiting` is
-- untouched by it: entering `awaiting` from `in_progress` and resuming back to
-- `in_progress` both leave `delivery_round` alone.
DROP TRIGGER IF EXISTS tr_tasks_round_bump;
CREATE TRIGGER tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;

-- 0001 + 0006 · the revision cursor. The column domain is 0006's, with M1's
-- `awaiting_reason` joined to it: it is a genuine content change a watching
-- client has to see, and one UPDATE fires this trigger once however many of its
-- columns it touches — so a move into `awaiting` still costs exactly one
-- revision.
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
--
-- Each body is the one its own migration last shipped: 0004's dictionary
-- in-use guards and 0002's/0010's relation guards. Nothing about them changes
-- here — `tasks` simply exists again, which is all they needed.

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
