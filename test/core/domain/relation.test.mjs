/**
 * Step 9: relation direction and shape rules, before the database sees them.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { RELATION_CHAIN_MAX, RELATION_FANIN_MAX } from "../../../src/shared/constants.mjs";
import {
  ancestorsOf,
  assertParentEdgeAllowed,
  assertParentIsEpic,
  chainDepthOf,
  normalizeRelation,
  wouldCreateCycle,
} from "../../../src/core/domain/relation.mjs";

const PROJECTS = { a: "p1", b: "p1", c: "p1", d: "p1", e: "p1", z: "p2" };
const projectOf = (id) => PROJECTS[id];
const edge = (source, target) => ({ source, target });
const CONTEXT = (edges, parent) => ({ edges, projectOf, ...(parent === undefined ? {} : { parent }) });

describe("domain/relation — direction", () => {
  it("keeps parent/blocks direction and normalises related", () => {
    assert.deepEqual(normalizeRelation({ type: "parent", source: "a", target: "b" }), {
      type: "parent",
      source: "a",
      target: "b",
    });
    assert.deepEqual(normalizeRelation({ type: "blocks", source: "b", target: "a" }), {
      type: "blocks",
      source: "b",
      target: "a",
    });
    assert.deepEqual(normalizeRelation({ type: "related", source: "b", target: "a" }), {
      type: "related",
      source: "a",
      target: "b",
      // stored source < target so "a related b" and "b related a" cannot coexist
    });
  });

  it("refuses self-references and nonsense", () => {
    assert.throws(() => normalizeRelation({ type: "parent", source: "a", target: "a" }), (err) => {
      assert.equal(err.code, "SELF_REFERENCE");
      assert.equal(err.http, 422);
      return true;
    });
    assert.throws(() => normalizeRelation({ type: "depends_on", source: "a", target: "b" }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.deepEqual(err.details.allowed, ["parent", "blocks", "related"]);
      return true;
    });
    assert.throws(() => normalizeRelation({ type: "parent", source: "", target: "b" }), (err) => err.details.field === "source");
    assert.throws(() => normalizeRelation(null), (err) => err.code === "VALIDATION_FAILED");
  });
});

describe("domain/relation — graph walking", () => {
  const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

  it("walks ancestors nearest-first and stops on a loop", () => {
    assert.deepEqual(ancestorsOf(edges, "d"), ["c", "b", "a"]);
    assert.deepEqual(ancestorsOf(edges, "a"), []);
    assert.deepEqual(ancestorsOf([edge("a", "b"), edge("b", "a")], "b"), ["a"], "a malformed loop cannot hang the walk");
  });

  it("detects cycles through any chain length", () => {
    assert.equal(wouldCreateCycle(edges, "d", "a"), true, "4-node ring");
    assert.equal(wouldCreateCycle(edges, "c", "a"), true, "3-node ring");
    assert.equal(wouldCreateCycle([edge("a", "b")], "b", "a"), true, "2-node ring");
    assert.equal(wouldCreateCycle(edges, "a", "d"), false);
    assert.equal(wouldCreateCycle(edges, "a", "a"), true, "self is a cycle");
  });

  it("reports chain depth counting the task itself", () => {
    assert.equal(chainDepthOf(edges, "a"), 1);
    assert.equal(chainDepthOf(edges, "d"), 4);
  });
});

describe("domain/relation — shape rules", () => {
  const chain = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

  it("accepts an edge that breaks none of the rules", () => {
    assert.deepEqual(
      assertParentEdgeAllowed(edge("a", "e"), CONTEXT(chain, { id: "a", kind: "epic" })),
      edge("a", "e"),
    );
  });

  it("refuses a cycle, with the reason code the trigger uses", () => {
    assert.throws(() => assertParentEdgeAllowed(edge("d", "a"), CONTEXT(chain)), (err) => {
      assert.equal(err.code, "RELATION_CYCLE");
      assert.equal(err.http, 422);
      return true;
    });
  });

  it("refuses an edge that would exceed the chain cap", () => {
    // r→s→t→u→v→w→x→y is 7 edges, so y sits at depth 8 — exactly the cap.
    const ids = ["r", "s", "t", "u", "v", "w", "x", "y", "z"];
    const projects = Object.fromEntries(ids.map((id) => [id, "p1"]));
    const projectsOf = (id) => projects[id];
    const deep = [];
    for (let i = 0; i < ids.length - 2; i += 1) deep.push(edge(ids[i], ids[i + 1]));

    assert.equal(chainDepthOf(deep, "y"), 8);
    assert.equal(chainDepthOf(deep, "r"), 1, "a root is depth 1");

    assert.equal(assertParentEdgeAllowed(edge("w", "z"), { edges: deep, projectOf: projectsOf }).target, "z");

    assert.throws(
      () => assertParentEdgeAllowed(edge("y", "z"), { edges: deep, projectOf: projectsOf }),
      (err) => {
        assert.equal(err.code, "CHAIN_TOO_LONG");
        assert.equal(err.details.max, RELATION_CHAIN_MAX);
        assert.equal(err.details.chainLength, RELATION_CHAIN_MAX + 1);
        return true;
      },
    );
  });

  it("refuses a parent that is already full", () => {
    const full = Array.from({ length: RELATION_FANIN_MAX }, (_, i) => edge("a", `kid${i}`));
    assert.throws(
      () => assertParentEdgeAllowed(edge("a", "kid-new"), { edges: full, projectOf: () => "p1" }),
      (err) => {
        assert.equal(err.code, "FANIN_TOO_HIGH");
        assert.equal(err.details.children, RELATION_FANIN_MAX);
        return true;
      },
    );
  });

  it("refuses edges that cross projects, and edges to nowhere", () => {
    assert.throws(() => assertParentEdgeAllowed(edge("a", "z"), CONTEXT(chain)), (err) => {
      assert.equal(err.code, "CROSS_PROJECT_RELATION");
      assert.equal(err.details.sourceProject, "p1");
      assert.equal(err.details.targetProject, "p2");
      return true;
    });
    assert.throws(() => assertParentEdgeAllowed(edge("a", "ghost"), CONTEXT(chain)), (err) => {
      assert.equal(err.code, "NOT_FOUND");
      return true;
    });
  });

  it("only an epic may be a parent", () => {
    assert.equal(assertParentIsEpic({ id: "a", kind: "epic" }).id, "a");
    assert.throws(() => assertParentIsEpic({ id: "a", kind: "task", identifier: "PROJ-0001" }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.equal(err.http, 400);
      assert.match(err.message, /PROJ-0001/);
      return true;
    });
    assert.throws(() => assertParentIsEpic(null), (err) => err.code === "NOT_FOUND");
  });
});
