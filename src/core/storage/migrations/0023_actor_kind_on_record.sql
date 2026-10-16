-- 0023_actor_kind_on_record.sql — the kind moves off the actor row and onto the
-- three references that record it.
--
-- ---------------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------------
--
-- `0019` put an actor's kind on the actor row, and dropped `tasks.assignee_kind`
-- and `tasks.creator_kind` with it. Its reason was right and worth restating:
-- **a copy of a mutable value goes stale.** The owner it picked is the wrong one.
--
-- `actors` is keyed `UNIQUE(normalized_name)` — **one row per person**, which is
-- the point of `0019` — and a kind is not a fact about a person. It is a fact
-- about the *act*: the same handle works from `claude` today and from `codex`
-- tomorrow, and one row cannot hold both. And the row keeps the **first** kind it
-- was ever given — `dictionary.upsert` touches `last_seen_at`/`use_count` on a
-- reuse and leaves `kind` alone — so the column is not merely lossy, it can be
-- **wrong**, with nothing able to tell.
--
-- So the kind goes back onto the reference. That is the shape
-- `comments.author_kind` and `task_reports.author_kind` have always had, and the
-- schema has kept those two open since `0018`: an actor's kind is an opaque
-- string whose only reserved value is `human`. Three references on `tasks` record
-- an act, and each gets its own:
--
--   * `assignee_id` → `assignee_kind`
--   * `reporter_id` → `reporter_kind`   (the card's one provenance key)
--   * `claimed_by`  → `claimed_kind`    (new — a claim recorded no kind at all)
--
-- ---------------------------------------------------------------------------
-- What this does not touch, and why that is the same ruling
-- ---------------------------------------------------------------------------
--
-- `task_activities.actor_id` and `agent_sessions.owner` stay free strings, which
-- is `0020`'s line and not an omission here. An audit log has to outlive the rows
-- it names, so a pointer into a mutable registry is the one thing it must not be;
-- and a session's owner is what the session *called itself* — telemetry, half of
-- `UNIQUE(task_id, seg, owner)` — not a curated identity. Both are pinned by
-- `test/contract/attribution-boundary.test.mjs`.
--
-- ---------------------------------------------------------------------------
-- How, and what it deliberately avoids
-- ---------------------------------------------------------------------------
--
-- Three `ALTER TABLE … ADD COLUMN` and one `DROP COLUMN`. **No table rebuild**:
-- SQLite can add a column in place (the route `0016` took for `blocked_reason`),
-- and it can drop one in place as long as no index, `CHECK`, trigger, view or
-- generated column names it — which is the case for `actors.kind`. That matters
-- because a rebuild of `tasks` would have to re-declare ten triggers on `tasks`
-- and the five on `task_relations` that reference it, which is the operation this
-- history has got wrong twice.
--
-- The three new columns are **not** added to `tr_rev_tasks_upd`'s `UPDATE OF`
-- list. That is `blocked_reason`'s precedent, and it carries the same narrow,
-- stated consequence: every write the board itself performs also sets `version`
-- and `updated_at`, which *are* in the list, so a service-level write always
-- bumps the cursor; a hand-written `UPDATE tasks SET assignee_kind = …` alone
-- does not. Adding them would mean re-declaring that trigger, and the one thing
-- this migration is built to avoid is re-declaring triggers.
--
-- `claimed_kind` is nullable with no default, and that is the honest value for a
-- claim made before this file: **"no kind was recorded" is a different statement
-- from "a person claimed it"**, and inventing `human` for every existing claim
-- would be a claim about who somebody is.
--
-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
--
--   * every `assignee_id` / `reporter_id` / `claimed_by` that resolved to an
--     actor row now has that row's kind beside it (a NULL id stays a NULL kind);
--   * `actors.kind` is gone, and nothing else in the schema named it;
--   * the table, index and trigger **names** are unchanged;
--   * every row, and every other column, survives.

-- ---------------------------------------------------------------------------
-- 1 · The three reference kinds
-- ---------------------------------------------------------------------------

-- Plain add-columns. No table, index or trigger name is created, and `tasks` is
-- not rebuilt — see the header.
ALTER TABLE tasks ADD COLUMN assignee_kind TEXT;
ALTER TABLE tasks ADD COLUMN reporter_kind TEXT;
ALTER TABLE tasks ADD COLUMN claimed_kind TEXT;

-- ---------------------------------------------------------------------------
-- 2 · Backfill from the column this migration is about to drop
-- ---------------------------------------------------------------------------

-- The kind the actor row holds is the best evidence there is for an act that was
-- recorded under that model; `0019`'s kinds were `agent` and `human`, so an
-- upgraded board's task links carry those words. A row with no reference keeps a
-- NULL kind, which is what "nothing was recorded here" means.
--
-- These `UPDATE`s fire `tr_rev_tasks_upd` once per row (the list names
-- `assignee_id`), so an upgrade moves the revision cursor. That is harmless — a
-- cursor is a cursor — and cheaper than a trigger re-declaration would be.
UPDATE tasks
   SET assignee_kind = (SELECT a.kind FROM actors a WHERE a.id = tasks.assignee_id)
 WHERE assignee_id IS NOT NULL
   AND assignee_kind IS NULL;

UPDATE tasks
   SET reporter_kind = (SELECT a.kind FROM actors a WHERE a.id = tasks.reporter_id)
 WHERE reporter_id IS NOT NULL
   AND reporter_kind IS NULL;

UPDATE tasks
   SET claimed_kind = (SELECT a.kind FROM actors a WHERE a.id = tasks.claimed_by)
 WHERE claimed_by IS NOT NULL
   AND claimed_kind IS NULL;

-- ---------------------------------------------------------------------------
-- 3 · The actor row stops carrying one
-- ---------------------------------------------------------------------------

-- Nothing names this column — no index, no `CHECK` (`0018` removed the
-- enumeration), no trigger body, no view — so SQLite drops it in place. The
-- `tr_dict_actors_delete` guard reads *other* tables' columns, and
-- `tr_rev_actors_upd` is `AFTER UPDATE ON actors` with no column list, so
-- neither is disturbed.
ALTER TABLE actors DROP COLUMN kind;
