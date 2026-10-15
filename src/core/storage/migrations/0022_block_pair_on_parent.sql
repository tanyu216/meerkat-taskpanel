-- 0022_block_pair_on_parent.sql — the ancestor/descendant vs `blocks` guard,
-- asked at the *parent* insert point, so the verdict stops depending on which
-- edge arrived first.
--
-- ---------------------------------------------------------------------------
-- The gap this closes
-- ---------------------------------------------------------------------------
--
-- `0019_block_chain.sql` refuses a `blocks` edge that joins an ancestor and a
-- descendant. It is the right rule at the wrong end: it reads the parent chain
-- of the row being inserted, and at the moment a `blocks` row lands the parent
-- chain may simply not be there yet. With the `blocks` edge already down, the
-- *parent* edge that puts the two cards on one chain went in unchallenged —
-- `tr_rel_parent_guard` (0002) never reads the `blocks` graph, and `0019` is not
-- on this event at all:
--
--   order 1  parent A → B   accepted
--   order 1  blocks B → A   REFUSED  RELATION_CYCLE      (0019)
--
--   order 2  blocks B → A   accepted
--   order 2  parent A → B   accepted   ← the hole
--
-- Order 2 is not hypothetical: `storage/md/import.mjs` writes `depends_on`
-- (→ `blocks`) before `parent` for every card it loads, so an import could land
-- a pair the board refuses to build by hand (T-20261015-063755 A6①, closed by
-- T-20261015-075826). The rule this file makes true is the one the ruling
-- already meant: **a `blocks` edge may never join two cards on one parent
-- chain, whichever edge the writer happened to insert first.**
--
-- ---------------------------------------------------------------------------
-- Why the walk is a closure, not the pair
-- ---------------------------------------------------------------------------
--
-- A new parent edge `P → C` makes *everything above `P`* an ancestor of
-- *everything below `C`*. So the offending `blocks` edge need not touch either
-- end of the new edge: with `X → P` (X the parent of P) and `C → Y` (C the
-- parent of Y) already in place, adding `P → C` strands a pre-existing
-- `X blocks Y` on one chain two generations away from the edge that was just
-- inserted. The two recursive walks below are therefore the full ancestor
-- closure of `P` and the full descendant closure of `C`, seeded with `P` and
-- `C` themselves; checking only `(P, C)` would leave that case open.
--
-- Siblings stay legal — they are on no shared chain, so neither closure reaches
-- the other — and so does any edge with only one end inside the two closures.
-- The `blocks`-side half of the same rule is `tr_rel_block_chain` (0019); this
-- file is its mirror, not a second spelling of it.
--
-- ---------------------------------------------------------------------------
-- `AFTER INSERT`, and why that is the whole precedence ruling (0002's rule)
-- ---------------------------------------------------------------------------
--
-- SQLite fires every matching trigger for an event in no guaranteed order, so
-- 0002 requires the guards on one row to be *conditionally disjoint*, or — if
-- they can overlap — to raise the **same** code. This guard is the first on
-- `task_relations` that cannot honour the first half, because `0020` is a new
-- migration and may not rewrite `tr_rel_parent_guard` (0002) to fold into it:
-- a later migration that quietly rewrites a shipped guard is exactly the loss
-- three rebuild suites (`migrations-0013/0015/0018.test.mjs`) assert against.
-- The row where the two overlap is a new parent edge that is *both* a chain
-- overflow (`CHAIN_TOO_LONG`) or a fan-in overflow (`FANIN_TOO_HIGH`) **and**
-- the ancestor/descendant join this file refuses — reachable, so it needs a
-- ruling rather than a hope.
--
-- The ruling is structural: this trigger is `AFTER INSERT`, so it runs only
-- once every `BEFORE` guard on the row has stayed silent. A row the shape caps
-- already refuse never reaches it and reports the cap's code; a row they admit
-- is then judged on the `blocks` graph and reports `RELATION_CYCLE`. One row,
-- one code, whichever order SQLite fires the triggers in — and *no* predicate
-- is restated here to get it: the alternative, an `INSERT`-time `WHEN` clause
-- that re-derives the chain-depth and fan-in arithmetic to stay out of their
-- way, would put those limits in two places and let them drift.
--
-- `RAISE(ABORT)` in an `AFTER` trigger backs the insert out with the statement
-- (measured: the row is gone and the caller sees the same reason code a
-- `BEFORE` abort produces), so the caller cannot tell which side of the insert
-- the ruling was made on.
--
-- The `WHEN` clause is `tr_rel_parent_guard`'s, clause for clause — same event,
-- same type, same `source <> target` and same-project test — so `SELF_REFERENCE`
-- and `CROSS_PROJECT_RELATION` keep their own rows here too.

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
