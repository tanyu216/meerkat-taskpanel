/**
 * Post-import DB-invariant validation (M5, card Comments ②).
 *
 * The database triggers are the machine guarantee (§4.2) and abort a bad edge
 * *at insert time*. But an import must not depend on the trigger to notice a
 * violation for two reasons:
 *
 *   1. a `RAISE(ABORT)` inside a batch can be caught per-statement, yet a rule
 *      that only the trigger knows about would then vanish into a warning with
 *      no independent record — so we re-derive the rules here and record them;
 *   2. the drill needs a *report*: "which cards violated what", not a stack
 *      trace from the middle of a transaction.
 *
 * Same rules, same reason codes as `0002_invariants.sql` and
 * `domain/relation.mjs`: single parent, no self reference, no cycles, chain
 * length ≤ 8, fan-in ≤ 8, and no cross-project edges. Pure — no `node:`.
 */

import { RELATION_CHAIN_MAX, RELATION_FANIN_MAX } from "../../../shared/constants.mjs";

/**
 * @typedef {object} TaskRef
 * @property {string} id
 * @property {string} identifier
 * @property {string} projectId
 * @property {string} kind
 *
 * @typedef {object} Edge
 * @property {string} type
 * @property {string} source
 * @property {string} target
 *
 * @typedef {object} Violation
 * @property {string} reason one of the six reason codes
 * @property {string} invariant the plain-language rule that was broken
 * @property {string} source
 * @property {string} target
 * @property {string|null} identifier the task the report should name (child, for `parent`)
 * @property {string} detail
 */

/**
 * Check every relation invariant over a whole board.
 *
 * @param {{tasks: TaskRef[], relations: Edge[]}} input
 * @returns {{violations: Violation[], checked: {tasks: number, relations: number}}}
 */
export function checkRelationInvariants({ tasks, relations }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const violations = [];
  const label = (id) => byId.get(id)?.identifier ?? id;

  const seen = new Set();
  for (const edge of relations) {
    const key = `${edge.type}\u0000${edge.source}\u0000${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (edge.source === edge.target) {
      violations.push({
        reason: "SELF_REFERENCE",
        invariant: "a task cannot be related to itself",
        source: edge.source,
        target: edge.target,
        identifier: label(edge.source),
        detail: `self ${edge.type} edge on ${label(edge.source)}`,
      });
      continue;
    }

    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) {
      violations.push({
        reason: "NOT_FOUND",
        invariant: "both ends of a relation must exist",
        source: edge.source,
        target: edge.target,
        identifier: label(edge.target),
        detail: `dangling ${edge.type} edge ${label(edge.source)} → ${label(edge.target)}`,
      });
      continue;
    }
    if (source.projectId !== target.projectId) {
      violations.push({
        reason: "CROSS_PROJECT_RELATION",
        invariant: "relations must not cross projects",
        source: edge.source,
        target: edge.target,
        identifier: label(edge.target),
        detail: `${label(edge.source)} (${source.projectId}) → ${label(edge.target)} (${target.projectId})`,
      });
    }
  }

  // Parent-shape rules only look at `parent` edges; `blocks`/`related` are
  // exempt from chain/fan-in/depth by design (§4.2). A self-edge is already
  // SELF_REFERENCE above — counting it again as a one-node cycle would report
  // one bad edge twice, which the DB trigger (disjoint guards) never does.
  const parentEdges = [...new Map(
    relations
      .filter((edge) => edge.type === "parent" && edge.source !== edge.target)
      .map((edge) => [`${edge.source}\u0000${edge.target}`, { source: edge.source, target: edge.target }]),
  ).values()];

  /** @type {Map<string, string[]>} child id → parent ids (should be ≤1) */
  const parentsOf = new Map();
  /** @type {Map<string, string[]>} parent id → child ids */
  const childrenOf = new Map();
  for (const edge of parentEdges) {
    if (!parentsOf.has(edge.target)) parentsOf.set(edge.target, []);
    parentsOf.get(edge.target).push(edge.source);
    if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, []);
    childrenOf.get(edge.source).push(edge.target);
  }

  for (const [child, parents] of parentsOf) {
    if (parents.length > 1) {
      violations.push({
        reason: "SINGLE_PARENT_VIOLATION",
        invariant: "a task may have at most one parent",
        source: parents[0],
        target: child,
        identifier: label(child),
        detail: `${label(child)} has ${parents.length} parents (${parents.map(label).join(", ")})`,
      });
    }
  }

  for (const [parent, children] of childrenOf) {
    if (children.length > RELATION_FANIN_MAX) {
      violations.push({
        reason: "FANIN_TOO_HIGH",
        invariant: `a parent may have at most ${RELATION_FANIN_MAX} children`,
        source: parent,
        target: children[0],
        identifier: label(parent),
        detail: `${label(parent)} has ${children.length} children`,
      });
    }
  }

  for (const cycle of findParentCycles(parentEdges)) {
    violations.push({
      reason: "RELATION_CYCLE",
      invariant: "parent edges must form a DAG",
      source: cycle[0],
      target: cycle[cycle.length - 1],
      identifier: label(cycle[0]),
      detail: `cycle: ${cycle.map(label).join(" → ")}`,
    });
  }

  for (const [child, depth] of chainDepths(parentEdges)) {
    if (depth > RELATION_CHAIN_MAX) {
      violations.push({
        reason: "CHAIN_TOO_LONG",
        invariant: `a parent chain may not exceed ${RELATION_CHAIN_MAX} nodes`,
        source: parentsOf.get(child)?.[0] ?? child,
        target: child,
        identifier: label(child),
        detail: `${label(child)} sits ${depth} nodes deep`,
      });
    }
  }

  return { violations, checked: { tasks: tasks.length, relations: relations.length } };
}

/**
 * Every parent cycle, as one node list each. Iterative colour DFS, so a deep
 * chain cannot blow the stack.
 *
 * @param {{source: string, target: string}[]} parentEdges source = parent
 * @returns {string[][]}
 */
export function findParentCycles(parentEdges) {
  /** @type {Map<string, string>} child → parent */
  const parentOf = new Map();
  for (const edge of parentEdges) if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source);

  const state = new Map(); // 0 = unvisited, 1 = on stack, 2 = done
  const cycles = [];
  const seenCycles = new Set();

  for (const start of parentOf.keys()) {
    if (state.get(start) === 2) continue;
    const path = [];
    let node = start;
    while (node !== undefined && state.get(node) !== 2) {
      if (state.get(node) === 1) {
        const at = path.indexOf(node);
        const cycle = path.slice(at);
        const key = canonicalCycle(cycle);
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
        }
        break;
      }
      state.set(node, 1);
      path.push(node);
      node = parentOf.get(node);
    }
    for (const visited of path) state.set(visited, 2);
  }
  return cycles;
}

/** Rotation-invariant key for a cycle, so the same loop is reported once. */
function canonicalCycle(cycle) {
  if (cycle.length === 0) return "";
  let best = 0;
  for (let i = 1; i < cycle.length; i += 1) if (cycle[i] < cycle[best]) best = i;
  return [...cycle.slice(best), ...cycle.slice(0, best)].join("→");
}

/**
 * Depth of every node in a parent chain (1 = root), computed with a walking
 * DFS and a visited guard so a cycle terminates instead of looping forever.
 *
 * @param {{source: string, target: string}[]} parentEdges source = parent
 * @returns {Map<string, number>}
 */
export function chainDepths(parentEdges) {
  /** @type {Map<string, string>} child → parent */
  const parentOf = new Map();
  const nodes = new Set();
  for (const edge of parentEdges) {
    if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source);
    nodes.add(edge.source);
    nodes.add(edge.target);
  }

  const depth = new Map();
  for (const start of nodes) {
    if (depth.has(start)) continue;
    const path = [];
    const onPath = new Set();
    let node = start;
    while (node !== undefined && !depth.has(node) && !onPath.has(node)) {
      onPath.add(node);
      path.push(node);
      node = parentOf.get(node);
    }
    const base = node !== undefined && depth.has(node) ? depth.get(node) : 0;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      depth.set(path[i], base + (path.length - 1 - i) + 1);
    }
  }
  return depth;
}
