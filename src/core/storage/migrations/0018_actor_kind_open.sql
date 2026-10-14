-- 0018_actor_kind_open.sql — an actor's `kind` stops being a closed vocabulary.
--
-- ---------------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------------
--
-- `0001` and `0003` pin the two *actor* kind columns to `('agent','human','system')`.
-- That set says something the project no longer believes: that "not a human" is one
-- thing. It is not. A card written by Claude and a card written by Codex are
-- different facts, and the column that is supposed to carry "who or what wrote
-- this" is the one that currently erases the difference. The value that *does*
-- carry meaning is `human` — everything else is "not the human", and the platform
-- name is data, not a vocabulary the schema should adjudicate.
--
-- So the two columns stop being enumerated. `kind` becomes an opaque, non-empty
-- string whose only reserved value is `human`.
--
-- ---------------------------------------------------------------------------
-- Scope: two tables, and only two
-- ---------------------------------------------------------------------------
--
-- Four other columns carry the same CHECK and are deliberately **not** touched here,
-- because each of them is going away with the column it sits on:
--
--   * `tasks.assignee_kind`, `tasks.creator_kind`, `tasks.creator_id` — the plan for
--     the identity model removes the denormalised kind copies entirely (the kind
--     belongs to the actor, and a copy of a mutable value goes stale). Their CHECKs
--     disappear when the columns do.
--   * `assignees.kind`, `reporters.kind` — the two dictionary tables are replaced by
--     a single `actors` table with the open column from birth. Rebuilding them here
--     so their CHECK can be dropped a migration later would be work done twice, on
--     the two tables that carry inbound foreign keys from `tasks`.
--
-- What is left, and what this migration does, is open the two columns that are
-- **not** scheduled to move: `comments.author_kind` and `task_reports.author_kind`.
-- The interim state is consistent — nothing writes a platform name into any of the
-- four untouched columns before their own migration lands.
--
-- There is **no data step**. `agent`, `human` and `system` remain legal values of an
-- open string, so every existing row is already valid and every row is copied
-- unchanged. Widening a CHECK cannot invalidate data; that is the whole reason this
-- migration can be verified on its own, with no accompanying code change.
--
-- ---------------------------------------------------------------------------
-- How the rebuild is done, and why *this* order
-- ---------------------------------------------------------------------------
--
-- SQLite has no `ALTER TABLE … DROP CONSTRAINT`, so removing a CHECK means rebuilding
-- the table. This file follows `0013_awaiting_status.sql` / `0015_deploy_kind.sql`
-- exactly; that file's header carries the full reasoning, and this one repeats only
-- what is specific to these two tables.
--
-- `CREATE new → copy → DROP old → RENAME new` — the order SQLite's own ALTER TABLE
-- documentation prescribes. The tempting reverse (rename the old table aside first)
-- is silently wrong since 3.25: `ALTER TABLE … RENAME TO` rewrites *references to the
-- renamed table in other tables*, so renaming `comments` aside would repoint
-- `attachments.comment_id` at the scratch name, and dropping the scratch table would
-- leave `attachments` naming a parent that does not exist. In the order used here the
-- only name that ever moves is the scratch one, and nothing references the scratch
-- name, so no reference is rewritten.
--
-- Two things have to be parked for the duration, and both because they name a table
-- that is momentarily absent:
--
--   * `attachments.comment_id REFERENCES comments(id)` — an inbound foreign key. It is
--     handled by taking enforcement off for the length of this file; between
--     `DROP TABLE comments` and the rename, that child names a parent that does not
--     resolve, which under enforcement reports `no such table` the instant the parent
--     is missing (measured in `0013`; `PRAGMA defer_foreign_keys` is not enough).
--
--   * `tr_latest_report_belongs` and `tr_deliver_gate`, both **on `tasks`**, both with
--     `task_reports` in their bodies. They are dropped before the `task_reports`
--     rebuild and recreated verbatim after it. Leaving them in place would let the
--     `task_reports` drop delete nothing (they live on `tasks`) but would arm a
--     trigger whose body resolves against a table that is absent for one statement.
--
-- `PRAGMA foreign_keys` is a documented no-op inside a transaction and a migration
-- always runs in one, which is why the request is made to the runner — the marker
-- line below — rather than issued here. The runner restores it afterwards whatever
-- happens, so no later migration inherits a relaxed connection.
--
-- ---------------------------------------------------------------------------
-- Verified after
-- ---------------------------------------------------------------------------
--
--   * `PRAGMA foreign_key_check` and `PRAGMA integrity_check` are clean;
--   * each rebuilt table has the same row count as before, and the rows are equal;
--   * `author_kind` accepts a value the old CHECK refused, and still refuses NULL
--     (`NOT NULL` is kept — only the enumeration goes);
--   * the index set and the **text** of every trigger are unchanged (that is what
--     `test/core/storage/migrations-0018.test.mjs` compares, deliberately by full SQL
--     rather than by name: a trigger recreated with a mistyped condition would
--     otherwise pass);
--   * no scratch table survives, and foreign key enforcement is back on.
--
-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- 1 · Park the two triggers on `tasks` whose bodies name `task_reports`
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_latest_report_belongs;   -- 0003
DROP TRIGGER IF EXISTS tr_deliver_gate;            -- 0008

-- ---------------------------------------------------------------------------
-- 2 · `comments.author_kind` — the enumeration goes, `NOT NULL` stays
-- ---------------------------------------------------------------------------

CREATE TABLE comments_kind_v2 (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('discuss','decision','confirm','change','note','defect')),
  author_kind    TEXT NOT NULL,
  author_id      TEXT NOT NULL,
  agent_session  TEXT,
  refs_json      TEXT NOT NULL DEFAULT '[]',
  source_seq     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL
) STRICT;

INSERT INTO comments_kind_v2 (
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
)
SELECT
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
FROM comments;

DROP TABLE comments;
ALTER TABLE comments_kind_v2 RENAME TO comments;

-- Dropping the old table took its indexes with it. Both come back verbatim (0001).
DROP INDEX IF EXISTS ux_comments_source;
CREATE UNIQUE INDEX ux_comments_source ON comments(task_id, source_seq) WHERE source_seq IS NOT NULL;
DROP INDEX IF EXISTS ix_comments_task;
CREATE INDEX ix_comments_task ON comments(task_id, created_at);

-- …and so did its triggers. All five come back verbatim (0001 · the revision cursor,
-- 0002 · append-only). Dropping the table is a DELETE on it, which is exactly what
-- `tr_comments_no_delete` forbids — so that trigger has to be gone before the drop,
-- which it is: it went with the table.
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
-- 3 · `task_reports.author_kind` — same change, and `origin` is now declared here
-- ---------------------------------------------------------------------------

-- `origin` was added by `0008` with `ALTER TABLE … ADD COLUMN`, so it sits last in
-- the live column order. A rebuild has to declare it in place rather than re-add it,
-- or the copy below would put it somewhere it never was.
CREATE TABLE task_reports_kind_v2 (
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
  author_id        TEXT NOT NULL,
  source_seq       INTEGER,
  created_at       TEXT NOT NULL,
  origin           TEXT NOT NULL DEFAULT 'delivery' CHECK (origin IN ('delivery','import')),
  UNIQUE (task_id, round)
) STRICT;

INSERT INTO task_reports_kind_v2 (
  id, task_id, round, seg, session_id, conclusion, acceptance_json, evidence_json,
  leftovers, author_kind, author_id, source_seq, created_at, origin
)
SELECT
  id, task_id, round, seg, session_id, conclusion, acceptance_json, evidence_json,
  leftovers, author_kind, author_id, source_seq, created_at, origin
FROM task_reports;

DROP TABLE task_reports;
ALTER TABLE task_reports_kind_v2 RENAME TO task_reports;

-- `task_reports` declares no index of its own: `UNIQUE (task_id, round)` creates one
-- implicitly, and the rebuild declares it again above. `EXPLAIN QUERY PLAN` still
-- uses it (test/contract/invariants.test.mjs).

-- Its five triggers come back verbatim (0003 · append-only and the revision cursor).
DROP TRIGGER IF EXISTS tr_reports_no_update;
CREATE TRIGGER tr_reports_no_update BEFORE UPDATE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS tr_reports_no_delete;
CREATE TRIGGER tr_reports_no_delete BEFORE DELETE ON task_reports
BEGIN
  SELECT RAISE(ABORT, 'REPORT_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS tr_rev_task_reports_ins;
CREATE TRIGGER tr_rev_task_reports_ins AFTER INSERT ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_task_reports_upd;
CREATE TRIGGER tr_rev_task_reports_upd AFTER UPDATE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

DROP TRIGGER IF EXISTS tr_rev_task_reports_del;
CREATE TRIGGER tr_rev_task_reports_del AFTER DELETE ON task_reports
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;

-- ---------------------------------------------------------------------------
-- 4 · Un-park the two guards on `tasks`, verbatim from 0015
-- ---------------------------------------------------------------------------

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
