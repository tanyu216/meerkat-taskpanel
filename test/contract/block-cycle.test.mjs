/**
 * T-20261014-212017-4 — a `blocks` edge may not close a loop (`0017_block_cycle.sql`).
 *
 * A card's `depends_on` **is** a `blocks` edge with `source` = the prerequisite
 * (`src/core/storage/md/import.mjs`; `export.mjs` rebuilds it from
 * `listBlockerOf`). `README.md` §3 makes the dependency graph a DAG, and a cycle
 * in it is a deadlock: the poll refuses to offer a card whose blockers are
 * unfinished, so every card in the loop becomes permanently unclaimable with
 * nothing on the board saying why.
 *
 * Before this card only self-reference and cross-project were guarded for
 * `blocks` — the parent guards are `relation_type = 'parent'` — so `a blocks b`
 * plus `b blocks a` went in.
 *
 * Both halves are walked, and walked **against each other**, exactly as
 * `test/contract/invariants.test.mjs` walks the other machine guarantees:
 *
 *   * the trigger, driven by raw SQL that bypasses the service layer entirely —
 *     this is the guarantee;
 *   * the service layer, which repeats it only to phrase it (`RELATION_CYCLE`
 *     with a message about the chain it would create).
 *
 * The determinism rule (`0002_invariants.sql`) is asserted too: a row that is
 * both cross-project and a cycle reports **one** code, and it is
 * `CROSS_PROJECT_RELATION`, because the two triggers are conditionally disjoint.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { DomainError } from "../../src/foundation/errors.mjs";
import {
  assertBlockEdgeAllowed,
  blockedClosure,
  wouldCreateBlockCycle,
} from "../../src/core/domain/relation.mjs";
import { createContext } from "../../src/core/commands/index.mjs";
import { addRelation } from "../../src/core/commands/relations.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { insertProject, insertTask, reasonCode, cleanupTempDirs, createTempBoard, TS } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** The pure half. `edges` are `blocks` edges: source = blocker. */
describe("domain/relation — the blocks cycle rule", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ];

  it("walks forwards from a card to everything it blocks", () => {
    assert.deepEqual(blockedClosure(edges, "a").sort(), ["b", "c"]);
    assert.deepEqual(blockedClosure(edges, "c"), []);
  });

  it("refuses the edge that closes a loop — direct and transitive", () => {
    assert.equal(wouldCreateBlockCycle(edges, "b", "a"), true, "b blocks a closes a → b → a");
    assert.equal(wouldCreateBlockCycle(edges, "c", "a"), true, "c blocks a closes the same loop, one hop longer");
    assert.equal(wouldCreateBlockCycle(edges, "a", "c"), false, "a blocks c is the edge that is already implied");
  });

  it("refuses a card waiting on itself", () => {
    assert.equal(wouldCreateBlockCycle([], "a", "a"), true);
  });

  it("allows every edge a DAG has room for", () => {
    assert.equal(wouldCreateBlockCycle(edges, "a", "d"), false);
    assert.equal(wouldCreateBlockCycle(edges, "d", "a"), false);
    assert.doesNotThrow(() => assertBlockEdgeAllowed({ source: "a", target: "d" }, { edges }));
  });

  it("raises the same code the parent guard raises, with the dependency's own words", () => {
    try {
      assertBlockEdgeAllowed({ source: "c", target: "a" }, { edges });
      assert.fail("expected RELATION_CYCLE");
    } catch (err) {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "RELATION_CYCLE");
      assert.equal(err.details.type, "blocks");
      assert.equal(err.details.source, "c");
      assert.equal(err.details.target, "a");
    }
  });
});

/** The machine half: raw SQL, no service layer. */
describe("contract/invariants — tr_rel_block_cycle", () => {
  /** A board with three same-project cards and one in another project. */
  async function board() {
    const temp = await createTempBoard();
    insertProject(temp.db);
    insertProject(temp.db, { id: "other", name: "Other" });
    for (const id of ["a", "b", "c"]) insertTask(temp.db, { id, identifier: `PROJ-${id.toUpperCase()}`, status: "todo" });
    insertTask(temp.db, { id: "x", identifier: "OTHER-1", project_id: "other", status: "todo" });
    return temp;
  }

  // `id` is an INTEGER PRIMARY KEY: the row's identity is the engine's, so the
  // insert names only what the edge *is*.
  const insertBlock = (db, source, target) => () =>
    db
      .prepare("INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('blocks', ?, ?, ?)")
      .run(source, target, TS);

  it("refuses a two-card loop", async () => {
    const temp = await board();
    try {
      insertBlock(temp.db, "a", "b")();
      assert.equal(reasonCode(insertBlock(temp.db, "b", "a")), "RELATION_CYCLE");
    } finally {
      temp.close();
    }
  });

  it("refuses a longer loop, and the one that closes through a third card", async () => {
    const temp = await board();
    try {
      insertBlock(temp.db, "a", "b")();
      insertBlock(temp.db, "b", "c")();
      assert.equal(reasonCode(insertBlock(temp.db, "c", "a")), "RELATION_CYCLE");
    } finally {
      temp.close();
    }
  });

  it("still lets an edge that opens no loop through", async () => {
    const temp = await board();
    try {
      insertBlock(temp.db, "a", "b")();
      assert.equal(reasonCode(insertBlock(temp.db, "a", "c")), "NO_ERROR");
      assert.equal(reasonCode(insertBlock(temp.db, "c", "b")), "NO_ERROR", "a diamond is not a loop");
    } finally {
      temp.close();
    }
  });

  it("reports SELF_REFERENCE, not RELATION_CYCLE, for a card waiting on itself", async () => {
    const temp = await board();
    try {
      // The two triggers share this event, so which one fires is the
      // determinism rule's business: `tr_rel_self_ref` owns `source = target`
      // and the block guard's `source <> target` clause keeps it off that row.
      assert.equal(reasonCode(insertBlock(temp.db, "a", "a")), "SELF_REFERENCE");
    } finally {
      temp.close();
    }
  });

  it("keeps the two guards apart: a cross-project edge is the project's code, not the cycle's", async () => {
    const temp = await board();
    try {
      // The `blocks` graph cannot *hold* a cross-project cycle: the first edge
      // between two projects is already refused, so there is never a path for
      // the second to close. What this asserts is the determinism rule doing its
      // job — the row that could arguably be either is reported by exactly one
      // trigger, and it is `tr_rel_cross_project` (the block guard's `IS`
      // project clause keeps it off that row).
      assert.equal(reasonCode(insertBlock(temp.db, "x", "a")), "CROSS_PROJECT_RELATION");
      assert.equal(reasonCode(insertBlock(temp.db, "a", "x")), "CROSS_PROJECT_RELATION");
      assert.equal(
        temp.db.prepare("SELECT COUNT(*) AS n FROM task_relations WHERE relation_type = 'blocks'").get().n,
        0,
        "and neither attempt wrote a row",
      );
    } finally {
      temp.close();
    }
  });
});

/** The service half: the same code, raised before the transaction opens. */
describe("commands/relations — the blocks guard reaches the caller", () => {
  async function board() {
    const temp = await createTempBoard();
    insertProject(temp.db);
    for (const id of ["a", "b"]) insertTask(temp.db, { id, identifier: `PROJ-${id.toUpperCase()}`, status: "todo" });
    return temp;
  }

  const ctxOf = (board) => createContext({ db: board.db, repos: createRepositories(board.db), clock: () => TS });

  it("refuses the closing edge with RELATION_CYCLE", async () => {
    const temp = await board();
    try {
      addRelation(ctxOf(temp), { type: "blocks", source: "a", target: "b", actor: { kind: "agent", id: "linus" } });
      assert.throws(
        () => addRelation(ctxOf(temp), { type: "blocks", source: "b", target: "a", actor: { kind: "agent", id: "linus" } }),
        (err) => err.code === "RELATION_CYCLE",
      );
    } finally {
      temp.close();
    }
  });

  it("still lets a DAG edge through", async () => {
    const temp = await board();
    try {
      const edge = addRelation(ctxOf(temp), { type: "blocks", source: "a", target: "b", actor: { kind: "agent", id: "linus" } });
      assert.equal(edge.type, "blocks");
      assert.equal(edge.source, "a");
    } finally {
      temp.close();
    }
  });
});
