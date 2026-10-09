-- 0010_parent_epic.sql — a `parent` edge may only point at an epic (ARCHITECTURE §4.1).
--
-- 0002 owns the parent-shape guards (cycle / chain / fan-in / cross-project) but
-- never checked that the *parent* row is `kind = 'epic'`, so raw SQL could build
-- a task→task parent chain — a state the domain layer (`assertParentIsEpic` in
-- `domain/relation.mjs`) refuses but the schema allowed. That is the layering
-- hole this migration closes: the same rule now lives in the database too.
--
-- Determinism (same discipline 0002 documents): this guard is conditionally
-- disjoint from the other `BEFORE INSERT ON task_relations` triggers, so the
-- reason code never depends on trigger firing order:
--
--   * `source <> target`                 keeps self-references on `tr_rel_self_ref`
--                                        (SELF_REFERENCE);
--   * the same-project clause            keeps cross-project edges on
--                                        `tr_rel_cross_project`
--                                        (CROSS_PROJECT_RELATION);
--   * `kind IS NOT NULL`                 keeps a missing parent on the foreign key
--                                        (NOT_FOUND) rather than misreporting it as
--                                        a kind problem. A missing *target* is
--                                        already excluded by the same-project
--                                        clause (`NULL IS <project>` is false), but
--                                        a *pair* of missing ids would satisfy
--                                        `NULL IS NULL` — this clause is what
--                                        catches that too.
--
-- For the case this guard owns — a same-project parent edge whose parent exists
-- but is not an epic, and which trips none of 0002's cycle/chain/fan-in guards —
-- no other trigger raises, so the code is deterministic. The reason code matches
-- the domain: `assertParentIsEpic` raises `VALIDATION_FAILED`, and the message
-- below maps to the same code via `storage/sqlite-errors.mjs` (an unmapped
-- `RAISE(ABORT, …)` surfaces as `VALIDATION_FAILED`). The message is a string
-- literal because SQLite requires it for `RAISE`.
--
-- Append-only: this migration only adds a trigger; it never edits 0002.

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
