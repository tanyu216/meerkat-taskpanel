-- 0020_attribution_fk.sql — the three remaining attribution columns become
-- references to `actors(id)`, and every distinct value already in them is
-- back-filled into an actor row first.
--
-- ---------------------------------------------------------------------------
-- What is a reference, and what is deliberately not
-- ---------------------------------------------------------------------------
--
-- Five columns name a person. `0019` gave two of them (`tasks.assignee_id`,
-- `tasks.reporter_id`) a foreign key to the one actor table; the other three are
-- still free strings:
--
--   * `tasks.claimed_by`          — the execution lock's holder
--   * `comments.author_id`        — who wrote a comment
--   * `task_reports.author_id`    — who wrote a report
--
-- All three are **attribution**: a curated statement about a person the board
-- knows, and one the delete guard can and should protect. They become
-- `REFERENCES actors(id)` here, exactly like the assignee and the reporter.
--
-- Two other columns name an actor and are deliberately **left free strings**:
--
--   * `task_activities.actor_id` — an append-only **audit log**. A hard foreign
--     key would give the log a *deletion coupling* to the actor table: archiving
--     or clearing a person would make their history undeletable, and the log must
--     outlive the entities it names. Its companion `actor_kind` carries no CHECK
--     at all today, for the same reason — the log is deliberately the loosest
--     surface on the board.
--   * `agent_sessions.owner` — runtime telemetry (`pid`/`phase`/`status`), and
--     half of the natural key `UNIQUE(task_id, seg, owner)`. It records *what the
--     session named itself*, not a curated identity, so an actor row would be a
--     category error — and adding one would force a de-duplication pass over
--     sessions, the single step most likely to lose data here.
--
-- Both are pinned by `test/contract/attribution-boundary.test.mjs`: neither table
-- may acquire a foreign key to `actors`.
--
-- **Reserved names.** `taskd` and `md-import` are the synthetic actor ids the
-- board writes for its own housekeeping (`SYSTEM_ACTOR`, the md importer). They
-- are **names in the log namespace**, not people: this migration creates no actor
-- row for them, and both live only in the two log columns above. A board that
-- shows a "person" called `taskd` in its roster would be a category error, so the
-- boundary test asserts `actors` holds no such row.
--
-- ---------------------------------------------------------------------------
-- The back-fill: one value space, and where it comes from
-- ---------------------------------------------------------------------------
--
-- Every one of the three columns holds a **name**, not a uuid. The live path's
-- value is `resolveActor`'s id, whose name comes from
-- `--agent ?? $TASKCTL_AGENT ?? $USER ?? "local"` — a name; the md importer writes
-- the card's own text — a name too. So there is **one value space**: names,
-- inconsistently spelled (`"Terry"` vs `"terry"`). The back-fill is therefore
-- uniform and has no id/name fingerprinting step:
--
--     distinct value → canonicalise → the actor row with that key, or a new one
--                    → the column is set to that row's id
--
-- Two consequences the CHANGELOG's migration note records:
--
--   * a value may be `local` (the `resolveActor` fallback) or a caller's `$USER`;
--     neither need have an actor row yet, so the migration **creates** one rather
--     than dropping the value;
--   * canonicalisation **merges spellings** — `"Terry"` and `"terry"` are two
--     `author_id` values today and become **one person**. That is intended.
--
-- ---------------------------------------------------------------------------
-- The canonicalisation, and the one thing this migration cannot do
-- ---------------------------------------------------------------------------
--
-- `norm` (`src/shared/norm.mjs`) is NFKC → remove ALL whitespace → lowercase, and
-- it is **JavaScript**. A migration file is SQL, and SQLite's `lower()` is
-- ASCII-only and cannot reproduce NFKC or Unicode case folding — a fact this
-- repository has already legislated (`storage/repositories/labels.mjs`: the label
-- reference scan is done in JS for exactly this reason).
--
-- So the migration canonicalises with the closest SQL expression:
--
--     lower( strip ASCII whitespace (space, tab, LF, CR, NBSP) )
--
-- which is **exact for the values it actually sees** — every name in every board
-- censused for this card is ASCII or CJK, where `lower()` and `norm` agree. It is
-- *not* NFKC, and it does not fold non-ASCII case (`"Иван"` stays `"Иван"` where
-- `norm` would yield `"иван"`). A migrated row whose `normalized_name` differs
-- from `norm(display_name)` is harmless *at the identity layer*, because
-- resolution matches on the **display name** first
-- (`domain/dictionary.mjs#resolveDictionaryEntry`) and a reuse carries the stored
-- row's own `normalized_name` (`commands/dictionary.mjs#resolveOrCreate`), so the
-- next live write naming that person reuses the migrated row rather than creating
-- a twin. `test/core/storage/migrations-0020.test.mjs` asserts
-- `normalized_name = norm(display_name)` for the ASCII board it builds, and the
-- census is recorded on the card.
--
-- ---------------------------------------------------------------------------
-- How the rebuild is done, and why *this* order
-- ---------------------------------------------------------------------------
--
-- SQLite has no `ALTER TABLE … ADD CONSTRAINT` and no `MODIFY`, so a foreign key
-- is only ever added by rebuilding the table that carries it. Three tables are
-- rebuilt — `comments`, `task_reports` and `tasks` — following
-- `0015_deploy_kind.sql` / `0018_actor_kind_open.sql` / `0019_actors.sql`
-- exactly (`CREATE new → copy → DROP old → RENAME new`; `-- @foreign-keys: off`;
-- every index and every trigger re-created). Only what is specific to this
-- migration is repeated here.
--
-- The order is forced by two facts:
--
--   1. **The back-fill needs the old columns present.** The map is built from the
--      free strings before any table is rebuilt, so the copy can emit an id.
--   2. **Seven triggers live elsewhere and name a rebuilt table.**
--      `tr_rel_cross_project` / `tr_rel_parent_guard` / `tr_rel_parent_epic` /
--      `tr_rel_block_cycle` (on `task_relations`) and `tr_dict_actors_delete` (on
--      `actors`) all name `tasks`; `tr_latest_report_belongs` / `tr_deliver_gate`
--      (on `tasks`) name `task_reports`. They are dropped up front and re-created
--      **verbatim** at the end, because a trigger's body is re-validated on any
--      schema change and a body naming a momentarily-absent table is fatal.
--
-- `PRAGMA foreign_keys` is a no-op inside a transaction, so the request is made to
-- the runner — the marker line below — not issued here.
--
-- Append-only: 0001 … 0019 are never edited.

-- @foreign-keys: off

-- ---------------------------------------------------------------------------
-- 1 · Park the seven triggers that name a table this file rebuilds
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tr_rel_cross_project;       -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_guard;        -- 0002
DROP TRIGGER IF EXISTS tr_rel_parent_epic;         -- 0010
DROP TRIGGER IF EXISTS tr_rel_block_cycle;         -- 0017
DROP TRIGGER IF EXISTS tr_dict_actors_delete;      -- 0019
DROP TRIGGER IF EXISTS tr_latest_report_belongs;   -- 0003
DROP TRIGGER IF EXISTS tr_deliver_gate;            -- 0008

-- ---------------------------------------------------------------------------
-- 2 · `""` is "nobody", and the column is about to become a reference
-- ---------------------------------------------------------------------------

-- A card writes `claimed_by: ""` for "nobody" (`md/import.mjs`); the importer
-- already stores NULL, and the live path never writes `""`. A stray one would map
-- to no actor and violate the new foreign key, so it is normalised to NULL here —
-- which is also what the column means.
UPDATE tasks SET claimed_by = NULL WHERE claimed_by = '';

-- ---------------------------------------------------------------------------
-- 3 · The back-fill map: one row per distinct canonical value
-- ---------------------------------------------------------------------------

-- `_attr_backfill` is scratch. It is dropped at the end of this file, so neither a
-- fresh install nor the upgraded board ever carries it. `display` is the
-- lexicographically smallest spelling seen for the key (deterministic; the
-- spellings are the same key, so the choice is cosmetic). `human` is 1 when *any*
-- source says the author was a human — the only value the schema reserves meaning
-- for.
CREATE TABLE _attr_backfill (
  key      TEXT NOT NULL,
  display  TEXT NOT NULL,
  human    INTEGER NOT NULL,
  first_ts TEXT NOT NULL,
  last_ts  TEXT NOT NULL,
  actor_id TEXT
);

INSERT INTO _attr_backfill(key, display, human, first_ts, last_ts)
SELECT k, MIN(v), MAX(h), MIN(ts), MAX(ts)
FROM (
  SELECT lower(replace(replace(replace(replace(replace(claimed_by, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), '')) AS k,
         claimed_by AS v, 0 AS h, COALESCE(claimed_at, '') AS ts
    FROM tasks WHERE claimed_by IS NOT NULL
  UNION ALL
  SELECT lower(replace(replace(replace(replace(replace(author_id, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), '')),
         author_id, CASE WHEN author_kind = 'human' THEN 1 ELSE 0 END, created_at
    FROM comments
  UNION ALL
  SELECT lower(replace(replace(replace(replace(replace(author_id, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), '')),
         author_id, CASE WHEN author_kind = 'human' THEN 1 ELSE 0 END, created_at
    FROM task_reports
)
-- A blank key has no `norm` (`norm("")` is a `DICTIONARY_INVALID`), so it can
-- never be an actor row — and an actor named `""` would make every later
-- `resolveDictionaryEntry` throw on `norm("")`. A value that canonicalises to
-- nothing is therefore left out of the map rather than turned into one. The live
-- writers refuse a blank actor id outright (`normalizeCommentCreate`, `actorOf`),
-- so the only way to reach this is hand-written data: a blank `claimed_by` is
-- NULLed in step 2, and a blank `author_id` (a `NOT NULL` column) would fail the
-- copy loudly instead of being silently blanked.
WHERE k <> ''
GROUP BY k;

-- ---------------------------------------------------------------------------
-- 4 · Create the actors the board does not have yet
-- ---------------------------------------------------------------------------

-- A uuid v4, built the way `shared/ids.mjs#newId` builds one (`randomUUID`), so a
-- migrated row is indistinguishable from a row the live dictionary created. New
-- ids are fine here: nothing outside this table holds one yet.
INSERT INTO actors(id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
        || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2)
        || '-' || hex(randomblob(6))),
  CASE WHEN b.human = 1 THEN 'human' ELSE 'agent' END,
  b.display,
  b.key,
  b.first_ts,
  b.last_ts,
  1
FROM _attr_backfill b
WHERE NOT EXISTS (SELECT 1 FROM actors a WHERE a.normalized_name = b.key);

-- Resolve the map to ids. The `display_name` arm covers a row the *live* path
-- created whose `normalized_name` is the JS `norm` of its display name and so
-- differs from the SQL canonical key only where they disagree (non-ASCII case) —
-- matching it keeps the migration from failing on a person it already knows.
UPDATE _attr_backfill
SET actor_id = (
  SELECT a.id FROM actors a
  WHERE a.normalized_name = _attr_backfill.key OR a.display_name = _attr_backfill.display
  LIMIT 1
);

-- ---------------------------------------------------------------------------
-- 5 · `comments` — `author_id` becomes a reference
-- ---------------------------------------------------------------------------

-- 0018's table, byte for byte, with one edit: `author_id` gains
-- `REFERENCES actors(id)`. `NOT NULL` stays — every comment has an author.
CREATE TABLE comments_attrib_v2 (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('discuss','decision','confirm','change','note','defect')),
  author_kind    TEXT NOT NULL,
  author_id      TEXT NOT NULL REFERENCES actors(id),
  agent_session  TEXT,
  refs_json      TEXT NOT NULL DEFAULT '[]',
  source_seq     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL
) STRICT;

INSERT INTO comments_attrib_v2 (
  id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at
)
SELECT
  c.id, c.task_id, c.body, c.kind, c.author_kind, b.actor_id, c.agent_session, c.refs_json, c.source_seq, c.version, c.created_at
FROM comments c
LEFT JOIN _attr_backfill b ON b.key = lower(replace(replace(replace(replace(replace(c.author_id, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), ''));

DROP TABLE comments;
ALTER TABLE comments_attrib_v2 RENAME TO comments;

-- Indexes (0001) and the five triggers (0001 · revision cursor, 0002 · append-only).
DROP INDEX IF EXISTS ux_comments_source;
CREATE UNIQUE INDEX ux_comments_source ON comments(task_id, source_seq) WHERE source_seq IS NOT NULL;
DROP INDEX IF EXISTS ix_comments_task;
CREATE INDEX ix_comments_task ON comments(task_id, created_at);

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
-- 6 · `task_reports` — `author_id` becomes a reference
-- ---------------------------------------------------------------------------

-- 0018's table, byte for byte, with the same one edit (`origin` stays declared
-- here — it was born in an `ALTER TABLE`, and a rebuild has to declare it in
-- place).
CREATE TABLE task_reports_attrib_v2 (
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
  origin           TEXT NOT NULL DEFAULT 'delivery' CHECK (origin IN ('delivery','import')),
  UNIQUE (task_id, round)
) STRICT;

INSERT INTO task_reports_attrib_v2 (
  id, task_id, round, seg, session_id, conclusion, acceptance_json, evidence_json,
  leftovers, author_kind, author_id, source_seq, created_at, origin
)
SELECT
  r.id, r.task_id, r.round, r.seg, r.session_id, r.conclusion, r.acceptance_json, r.evidence_json,
  r.leftovers, r.author_kind, b.actor_id, r.source_seq, r.created_at, r.origin
FROM task_reports r
LEFT JOIN _attr_backfill b ON b.key = lower(replace(replace(replace(replace(replace(r.author_id, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), ''));

DROP TABLE task_reports;
ALTER TABLE task_reports_attrib_v2 RENAME TO task_reports;

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
-- 7 · `tasks` — `claimed_by` becomes a reference
-- ---------------------------------------------------------------------------

-- 0019's table, byte for byte, with one edit: `claimed_by` gains
-- `REFERENCES actors(id)`. `NULL` stays legal — an unclaimed card names nobody.
CREATE TABLE tasks_attrib_v2 (
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
  blocked_reason          TEXT CHECK (blocked_reason IN ('clarify','decision','dependency','out_of_bounds','defect','external','resource','unknown')),
  -- A backlog task is never claimed (0001's table CHECK, preserved verbatim).
  CHECK (claimed_by IS NULL OR status <> 'backlog')
) STRICT;

INSERT INTO tasks_attrib_v2 (
  id, identifier, project_id, title, description, status, priority, kind, labels,
  sort_order, assignee_id, reporter_id, agent_session, thread_id, thread_source,
  claimed_by, claimed_at, heartbeat_at, blocked_at, status_changed_at, archived_at,
  source_path, source_hash, version, created_at, updated_at, report_latest_id,
  delivery_round, meta_json, report_waiver_round, report_waiver_reason,
  report_waived_at, idem, awaiting_reason, blocked_reason
)
SELECT
  t.id, t.identifier, t.project_id, t.title, t.description, t.status, t.priority, t.kind, t.labels,
  t.sort_order, t.assignee_id, t.reporter_id, t.agent_session, t.thread_id, t.thread_source,
  b.actor_id, t.claimed_at, t.heartbeat_at, t.blocked_at, t.status_changed_at, t.archived_at,
  t.source_path, t.source_hash, t.version, t.created_at, t.updated_at, t.report_latest_id,
  t.delivery_round, t.meta_json, t.report_waiver_round, t.report_waiver_reason,
  t.report_waived_at, t.idem, t.awaiting_reason, t.blocked_reason
FROM tasks t
LEFT JOIN _attr_backfill b ON b.key = lower(replace(replace(replace(replace(replace(t.claimed_by, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), ''));

DROP TABLE tasks;
ALTER TABLE tasks_attrib_v2 RENAME TO tasks;

-- ---------------------------------------------------------------------------
-- 8 · `tasks` indexes — the complete set (0001 + 0005 + 0009), all seven
-- ---------------------------------------------------------------------------

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
-- 9 · Every trigger on `tasks`, re-created from 0019's text
-- ---------------------------------------------------------------------------

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

DROP TRIGGER IF EXISTS tr_tasks_terminal;
CREATE TRIGGER tr_tasks_terminal BEFORE UPDATE OF status ON tasks
WHEN OLD.status IN ('done','canceled') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'TERMINAL_STATE');
END;

DROP TRIGGER IF EXISTS tr_tasks_archive_terminal;
CREATE TRIGGER tr_tasks_archive_terminal BEFORE UPDATE OF archived_at ON tasks
WHEN NEW.archived_at IS NOT NULL AND NEW.status NOT IN ('done','canceled')
BEGIN
  SELECT RAISE(ABORT, 'ARCHIVE_NOT_TERMINAL');
END;

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

DROP TRIGGER IF EXISTS tr_latest_report_belongs;
CREATE TRIGGER tr_latest_report_belongs BEFORE UPDATE OF report_latest_id ON tasks
WHEN NEW.report_latest_id IS NOT NULL
 AND (SELECT task_id FROM task_reports WHERE id = NEW.report_latest_id) IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'REPORT_TASK_MISMATCH');
END;

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

DROP TRIGGER IF EXISTS tr_tasks_round_bump;
CREATE TRIGGER tr_tasks_round_bump AFTER UPDATE OF status ON tasks
WHEN OLD.status = 'in_review' AND NEW.status IN ('in_progress','blocked')
BEGIN
  UPDATE tasks SET delivery_round = delivery_round + 1 WHERE id = NEW.id;
END;

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
-- 10 · The seven parked guards come back verbatim, and the actor guard now also
--      answers the three new references
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

-- 0019's guard, with its scope widened from the two task roles to **every**
-- attribution reference. The three new columns carry a real foreign key, so a
-- direct `DELETE` of a referenced actor would already fail — but as a generic
-- `NOT_FOUND` (`sqlite-errors.mjs` maps `FOREIGNKEY` that way). Checking them here
-- too keeps one reason code, `DICTIONARY_ENTRY_IN_USE`, for "this person is still
-- named by the board", whatever column names them.
CREATE TRIGGER tr_dict_actors_delete BEFORE DELETE ON actors
WHEN EXISTS (SELECT 1 FROM tasks WHERE assignee_id = OLD.id OR reporter_id = OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE claimed_by = OLD.id)
  OR EXISTS (SELECT 1 FROM comments WHERE author_id = OLD.id)
  OR EXISTS (SELECT 1 FROM task_reports WHERE author_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_ENTRY_IN_USE');
END;

-- ---------------------------------------------------------------------------
-- 11 · Drop the scratch map
-- ---------------------------------------------------------------------------

DROP TABLE _attr_backfill;
