/**
 * Relations: direction normalisation and the shape rules.
 *
 * Direction convention (the whole codebase depends on this):
 *
 *   parent   source = **parent**, target = **child**   (≤1 parent per child)
 *   blocks   source = **blocker**, target = **blocked**
 *   related  stored with source < target, always
 *
 * The database re-checks every one of these (`0002_invariants.sql`), including
 * the recursive-CTE cycle test. This module exists so a caller gets a precise
 * error *before* a transaction is opened, and so the rules are unit-testable
 * without a database.
 *
 * Pure: no `node:` specifiers.
 */

import { RELATION_ANCESTOR_CAP, RELATION_CHAIN_MAX, RELATION_FANIN_MAX } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { RELATION_TYPES, RELATION_TYPE, TASK_KIND } from "./enums.mjs";

/**
 * Normalise an edge so storage never has to think about direction.
 *
 * @param {{type: string, source: string, target: string}} edge
 * @returns {{type: string, source: string, target: string}}
 */
export function normalizeRelation(edge) {
  if (edge === null || typeof edge !== "object") {
    throw new DomainError("VALIDATION_FAILED", { message: "relation must be an object" });
  }
  const { type, source, target } = edge;
  if (!RELATION_TYPES.includes(type)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown relation type ${JSON.stringify(type)}`,
      details: { field: "type", received: type, allowed: RELATION_TYPES },
    });
  }
  assertTaskRef(source, "source");
  assertTaskRef(target, "target");

  if (source === target) {
    throw new DomainError("SELF_REFERENCE", {
      message: "a task cannot be related to itself",
      details: { taskId: source, type },
    });
  }
  if (type === RELATION_TYPE.RELATED && source > target) {
    return { type, source: target, target: source };
  }
  return { type, source, target };
}

function assertTaskRef(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field} must be a task id`,
      details: { field, received: value },
    });
  }
}

/** `parent` edges must point at an epic (ARCHITECTURE §4.1). */
export function assertParentIsEpic(parentTask) {
  if (parentTask === null || parentTask === undefined) {
    throw new DomainError("NOT_FOUND", { message: "parent task does not exist", details: { field: "source" } });
  }
  if (parentTask.kind !== TASK_KIND.EPIC) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `task ${parentTask.identifier ?? parentTask.id} is a ${parentTask.kind}; only an epic can be a parent`,
      details: { field: "kind", taskId: parentTask.id, kind: parentTask.kind },
    });
  }
  return parentTask;
}

/**
 * Downgrading an epic that still has children would re-create the `task → task`
 * parent edge `tr_rel_parent_epic` (0010) refuses to *insert*: the edge stays,
 * only its source stops being an epic (D-DB-1). This is the service-level half
 * of `tr_tasks_kind_downgrade` (0011) — the command reads the children (a
 * repository concern) and hands them here so the decision stays a pure rule
 * that raises the same `VALIDATION_FAILED` code the trigger does.
 *
 * @param {object} current a Task DTO
 * @param {string} nextKind the patched kind
 * @param {{id: number}[]} children `parent` edges with `source === current.id`
 */
export function assertEpicDowngradeAllowed(current, nextKind, children) {
  if (current.kind !== TASK_KIND.EPIC) return; // task → anything: no parent edge to orphan
  if (nextKind === TASK_KIND.EPIC) return; // epic → epic: a no-op, not a downgrade
  if (children.length > 0) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `task ${current.identifier ?? current.id} still has ${children.length} child card(s); an epic with children cannot be downgraded to ${nextKind}`,
      details: { field: "kind", taskId: current.id, kind: nextKind, children: children.length },
    });
  }
}

/**
 * Ancestor ids of `taskId`, nearest first. Mirrors the recursive CTE the
 * database uses; `edges` is a list of `{source, target}` parent edges.
 *
 * @param {{source: string, target: string}[]} edges
 * @param {string} taskId
 * @returns {string[]}
 */
export function ancestorsOf(edges, taskId) {
  const byChild = new Map();
  for (const edge of edges) {
    if (!byChild.has(edge.target)) byChild.set(edge.target, edge.source);
  }
  const out = [];
  const seen = new Set([taskId]);
  let current = taskId;
  while (out.length <= RELATION_ANCESTOR_CAP) {
    const parent = byChild.get(current);
    if (parent === undefined || seen.has(parent)) break;
    out.push(parent);
    seen.add(parent);
    current = parent;
  }
  return out;
}

/** Would adding this parent edge close a loop? */
export function wouldCreateCycle(edges, parent, child) {
  if (parent === child) return true;
  return ancestorsOf(edges, parent).includes(child);
}

/**
 * The whole shape rule set, as pure predicates over the current parent edges.
 * `context` carries what the rules need beyond the edge list.
 *
 * @param {{source: string, target: string}} edge a normalised `parent` edge
 * @param {{edges: {source: string, target: string}[], projectOf: (id: string) => string|undefined, parent?: object}} context
 * @throws {DomainError} with the same reason code the DB trigger raises
 */
export function assertParentEdgeAllowed(edge, context) {
  const { edges, projectOf, parent } = context;

  if (parent !== undefined) assertParentIsEpic(parent);

  if (wouldCreateCycle(edges, edge.source, edge.target)) {
    throw new DomainError("RELATION_CYCLE", {
      message: `that parent would create a cycle (${edge.source} is already a descendant of ${edge.target})`,
      details: { source: edge.source, target: edge.target },
    });
  }

  const ancestors = ancestorsOf(edges, edge.source);
  const chainLength = ancestors.length + 2; // the parent, the child, and everything above the parent
  if (chainLength > RELATION_CHAIN_MAX) {
    throw new DomainError("CHAIN_TOO_LONG", {
      message: `that parent would make the chain ${chainLength} deep (maximum ${RELATION_CHAIN_MAX})`,
      details: { source: edge.source, target: edge.target, chainLength, max: RELATION_CHAIN_MAX },
    });
  }

  const children = edges.filter((other) => other.source === edge.source).length;
  if (children >= RELATION_FANIN_MAX) {
    throw new DomainError("FANIN_TOO_HIGH", {
      message: `parent already has ${children} children (maximum ${RELATION_FANIN_MAX})`,
      details: { source: edge.source, children, max: RELATION_FANIN_MAX },
    });
  }

  const sourceProject = projectOf(edge.source);
  const targetProject = projectOf(edge.target);
  if (sourceProject === undefined || targetProject === undefined) {
    throw new DomainError("NOT_FOUND", {
      message: "both ends of a relation must exist",
      details: { source: edge.source, target: edge.target },
    });
  }
  if (sourceProject !== targetProject) {
    throw new DomainError("CROSS_PROJECT_RELATION", {
      message: "relations must not cross projects",
      details: { source: edge.source, target: edge.target, sourceProject, targetProject },
    });
  }

  return edge;
}

/** Depth of a task in its parent chain (1 for a root). */
export function chainDepthOf(edges, taskId) {
  return ancestorsOf(edges, taskId).length + 1;
}

/**
 * Everything reachable from `start` by following `blocks` edges forwards
 * (source = blocker, target = blocked). Bounded by `RELATION_ANCESTOR_CAP` for
 * the same reason the parent walk is: a malformed graph must not spin.
 *
 * @param {{source: string, target: string}[]} edges `blocks` edges
 * @param {string} start
 * @returns {string[]}
 */
export function blockedClosure(edges, start) {
  const bySource = new Map();
  for (const edge of edges) {
    if (!bySource.has(edge.source)) bySource.set(edge.source, []);
    bySource.get(edge.source).push(edge.target);
  }
  const out = [];
  const seen = new Set([start]);
  let frontier = [start];
  while (frontier.length > 0 && out.length <= RELATION_ANCESTOR_CAP) {
    const next = [];
    for (const node of frontier) {
      for (const target of bySource.get(node) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        out.push(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Would `blocker` blocking `blocked` close a loop in the dependency graph?
 *
 * It would exactly when `blocked` can already reach `blocker` by following
 * `blocks` edges forwards — i.e. when `blocker` is *already*, transitively,
 * waiting on `blocked`. `depends_on` is the DAG of `README.md` §3, so this is
 * the mirror of `wouldCreateCycle` for the parent chain: same shape, the other
 * relation kind.
 *
 * @param {{source: string, target: string}[]} edges `blocks` edges
 * @param {string} blocker
 * @param {string} blocked
 */
export function wouldCreateBlockCycle(edges, blocker, blocked) {
  if (blocker === blocked) return true;
  return blockedClosure(edges, blocked).includes(blocker);
}

/**
 * Are `a` and `b` on one parent chain — the same card, or one the other's
 * ancestor?
 *
 * `parentEdges` are `parent` edges (`{source: parent, target: child}`), the list
 * `ancestorsOf` walks. **Siblings are not on one chain**: two children of the
 * same epic share a parent but neither reaches the other, which is why this is
 * a two-way ancestry test and not "do they share an ancestor?" — a card and its
 * sibling depending on each other in sequence is an ordinary, wanted edge.
 *
 * @param {{source: string, target: string}[]} parentEdges
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isOnSameParentChain(parentEdges, a, b) {
  if (a === b) return true;
  return ancestorsOf(parentEdges, a).includes(b) || ancestorsOf(parentEdges, b).includes(a);
}

/**
 * The `blocks` shape rule, checked before a transaction is opened so a caller
 * gets `RELATION_CYCLE` (the same code the opposite direction of the parent
 * guard raises) rather than a raw trigger message.
 *
 * Two things are refused, and both are deadlocks rather than shapes nobody
 * minds — the poll holds back a card whose blockers are unfinished, so a card
 * waiting on its way round the dependency graph, or on a card it already
 * contains, is never offered again:
 *
 *   * an edge that closes a loop in the `blocks` graph (`0017_block_cycle.sql`);
 *   * an edge joining an ancestor and a descendant of the **parent** chain
 *     (`0019_block_chain.sql`) — `D depends_on E` where `E` is `D`'s parent, or
 *     `E depends_on D` where `D` is `E`'s child. Reading 乙 of the "ancestor"
 *     ruling (T-20261014-212017): neither direction is allowed. Siblings are not
 *     on one chain and stay legal.
 *
 * The database re-checks both (`0017`, `0019`), and
 * `test/contract/invariants.test.mjs` walks both paths — the service layer
 * repeats a machine guarantee only to phrase it, never to be the guarantee.
 *
 * @param {{source: string, target: string}} edge a normalised `blocks` edge
 * @param {{edges: {source: string, target: string}[], parentEdges?: {source: string, target: string}[]}} context
 *        `edges` are `blocks` edges; `parentEdges` are `parent` edges, optional
 *        so a caller with no parent chain to offer (an empty board reads as one)
 *        still gets the cycle rule rather than a crash.
 * @throws {DomainError} `RELATION_CYCLE`
 */
export function assertBlockEdgeAllowed(edge, context) {
  if (wouldCreateBlockCycle(context.edges, edge.source, edge.target)) {
    throw new DomainError("RELATION_CYCLE", {
      message: `that would make ${edge.source} depend on itself (it is already blocked by ${edge.target})`,
      details: { source: edge.source, target: edge.target, type: "blocks" },
    });
  }

  if (isOnSameParentChain(context.parentEdges ?? [], edge.source, edge.target)) {
    throw new DomainError("RELATION_CYCLE", {
      message: `an ancestor and a descendant cannot depend on each other: ${edge.source} and ${edge.target} are on one parent chain`,
      details: { source: edge.source, target: edge.target, type: "blocks", chain: "ancestor" },
    });
  }

  return edge;
}
