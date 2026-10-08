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
import { RELATION_TYPES, RELATION_TYPE, TASK_KINDS } from "./enums.mjs";

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
  if (parentTask.kind !== TASK_KINDS[1]) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `task ${parentTask.identifier ?? parentTask.id} is a ${parentTask.kind}; only an epic can be a parent`,
      details: { field: "kind", taskId: parentTask.id, kind: parentTask.kind },
    });
  }
  return parentTask;
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
