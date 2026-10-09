/**
 * M5: the post-import invariant validator (card Comments ②).
 *
 * The rules must match `0002_invariants.sql` / `domain/relation.mjs`, so a
 * violation that the trigger would abort is also one this reports — and a
 * violation the trigger *cannot* see (because it never reached the DB) is still
 * named. Pure: no database here.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  chainDepths,
  checkRelationInvariants,
  findParentCycles,
} from "../../src/core/storage/md/invariants-check.mjs";

/** @param {string} id @param {object} [overrides] */
const task = (id, overrides = {}) => ({ id, identifier: id.toUpperCase(), projectId: "p", kind: "task", ...overrides });
const edge = (type, source, target) => ({ type, source, target });

/** @param {object[]} tasks @param {object[]} relations */
const reasons = (tasks, relations) => checkRelationInvariants({ tasks, relations }).violations.map((v) => v.reason);

describe("md/invariants-check — the six rules", () => {
  it("is quiet on a well-formed board", () => {
    const tasks = [task("e", { kind: "epic" }), task("a"), task("b")];
    const relations = [edge("parent", "e", "a"), edge("parent", "e", "b"), edge("blocks", "a", "b")];
    assert.deepEqual(reasons(tasks, relations), []);
  });

  it("flags a self reference", () => {
    assert.deepEqual(reasons([task("a", { kind: "epic" })], [edge("parent", "a", "a")]), ["SELF_REFERENCE"]);
  });

  it("flags a cross-project relation", () => {
    const tasks = [task("a", { projectId: "p1" }), task("b", { projectId: "p2" })];
    assert.deepEqual(reasons(tasks, [edge("blocks", "a", "b")]), ["CROSS_PROJECT_RELATION"]);
  });

  it("flags a second parent", () => {
    const tasks = [task("e1", { kind: "epic" }), task("e2", { kind: "epic" }), task("c")];
    const violations = checkRelationInvariants({
      tasks,
      relations: [edge("parent", "e1", "c"), edge("parent", "e2", "c")],
    }).violations;
    assert.equal(violations.filter((v) => v.reason === "SINGLE_PARENT_VIOLATION").length, 1);
    assert.equal(violations[0].identifier, "C");
  });

  it("flags a parent cycle once, not once per traversal", () => {
    const tasks = [task("a", { kind: "epic" }), task("b", { kind: "epic" })];
    const violations = reasons(tasks, [edge("parent", "a", "b"), edge("parent", "b", "a")]);
    assert.deepEqual(violations, ["RELATION_CYCLE"]);
  });

  it("flags a chain deeper than 8 and a fan-in above 8", () => {
    const chain = [];
    for (let i = 0; i < 10; i += 1) chain.push(task(`n${i}`, { kind: "epic" }));
    const chainEdges = chain.slice(1).map((node, index) => edge("parent", chain[index].id, node.id));
    assert.ok(reasons(chain, chainEdges).includes("CHAIN_TOO_LONG"));

    const parent = task("root", { kind: "epic" });
    const children = Array.from({ length: 9 }, (_, i) => task(`c${i}`));
    const fanEdges = children.map((child) => edge("parent", "root", child.id));
    assert.ok(reasons([parent, ...children], fanEdges).includes("FANIN_TOO_HIGH"));
  });

  it("flags a dangling edge rather than ignoring it", () => {
    assert.deepEqual(reasons([task("a")], [edge("blocks", "ghost", "a")]), ["NOT_FOUND"]);
  });

  it("de-duplicates identical edges", () => {
    const tasks = [task("a"), task("b")];
    assert.deepEqual(reasons(tasks, [edge("blocks", "a", "b"), edge("blocks", "a", "b")]), []);
  });
});

describe("md/invariants-check — graph helpers", () => {
  it("computes chain depths with 1 for a root", () => {
    const depths = chainDepths([edge("parent", "root", "a"), edge("parent", "a", "b")]);
    assert.equal(depths.get("root"), 1);
    assert.equal(depths.get("a"), 2);
    assert.equal(depths.get("b"), 3);
  });

  it("terminates on a cycle instead of looping", () => {
    const depths = chainDepths([edge("parent", "a", "b"), edge("parent", "b", "a")]);
    assert.equal(depths.size, 2);
  });

  it("finds each cycle exactly once, rotation-invariantly", () => {
    const cycles = findParentCycles([edge("parent", "a", "b"), edge("parent", "b", "a"), edge("parent", "c", "b")]);
    assert.equal(cycles.length, 1);
    assert.deepEqual([...cycles[0]].sort(), ["a", "b"]);
  });
});
