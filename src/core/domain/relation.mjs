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

import { RELATION_ANCESTOR_CAP, RELATION_CHAIN_MAX, RELATION_FANIN_MAX } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
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

/**
 * Descendant ids of `taskId`, nearest first — the mirror of `ancestorsOf` over
 * the same `parent` edges, and bounded the same way so a malformed graph cannot
 * spin.
 *
 * A card may have many children where it has at most one parent, so the walk is
 * a breadth-first frontier rather than the single `byChild` lookup above. Both
 * walks exist because both directions are refused: `isOnSameParentChain` tests
 * `ancestorsOf(a).includes(b) || ancestorsOf(b).includes(a)`, and the board's
 * read of that set (`commands/relations.mjs#listRelations#parentChain`) hands
 * the same union to the drawer's prerequisite picker.
 *
 * @param {{source: string, target: string}[]} edges `parent` edges (source = parent)
 * @param {string} taskId
 * @returns {string[]}
 */
export function descendantsOf(edges, taskId) {
  const byParent = new Map();
  for (const edge of edges) {
    if (!byParent.has(edge.source)) byParent.set(edge.source, []);
    byParent.get(edge.source).push(edge.target);
  }
  const out = [];
  const seen = new Set([taskId]);
  let frontier = [taskId];
  while (frontier.length > 0 && out.length <= RELATION_ANCESTOR_CAP) {
    const next = [];
    for (const node of frontier) {
      for (const child of byParent.get(node) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        next.push(child);
      }
    }
    frontier = next;
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
 * The rules are ordered, and the order is the ruling on a row two of them could
 * both refuse: the local shape limits first (cycle, chain depth, fan-in), then
 * project, then the reciprocal `blocks`/parent-chain conflict last. The trigger
 * that backs the last one is `AFTER INSERT` (`0020`), so the database and this
 * function report the same code for the same row.
 *
 * @param {{source: string, target: string}} edge a normalised `parent` edge
 * @param {{edges: {source: string, target: string}[], projectOf: (id: string) => string|undefined, parent?: object, blockEdges?: {source: string, target: string}[]}} context
 *        `blockEdges` are `blocks` edges, optional so a caller with no
 *        dependency graph to offer (an empty board reads as one) still gets
 *        every rule above rather than a crash — the same convention
 *        `assertBlockEdgeAllowed` uses for `parentEdges`.
 * @throws {DomainError} with the same reason code the DB trigger raises
 */
/**
 * A review card is a loop artefact, not a work item. A `parent` edge on either
 * end silently changes what the card means: the child scope outranks the review
 * marker for acceptance, the card starts blocking container close, and its
 * verdict can enter the rollup as child evidence. Refuse the edge outright.
 *
 * Pure: takes the two Task DTOs, not a repository.
 *
 * @param {{source: object, target: object}} input
 * @returns {true}
 * @throws {DomainError} VALIDATION_FAILED with `details.field = "source"|"target"`
 */
export function assertParentEdgeHasNoReviewCard({ source, target }) {
  for (const [task, field] of [[source, "source"], [target, "target"]]) {
    const structural = task?.reviewOfId !== null && task?.reviewOfId !== undefined;
    const legacy = typeof task?.meta?.review_of === "string" && task.meta.review_of.trim() !== "";
    if (!structural && !legacy) continue;
    throw new DomainError("VALIDATION_FAILED", {
      message: `a review card cannot be a parent or a child (${task.identifier ?? task.id})`,
      details: {
        field,
        type: "parent",
        taskId: task.id,
        identifier: task.identifier,
        reviewOf: task.reviewOfId ?? task.meta?.review_of ?? null,
      },
      hint: { fix: "attach the parent edge to the original work card, not to its review card" },
    });
  }
  return true;
}

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

  // Last, and deliberately so. This is the *reciprocal* of the `blocks` rule —
  // the same defect, asked at the other insert point — and the local shape rules
  // above must keep owning the rows they already own, with the codes they
  // already raise. `0020`'s trigger is `AFTER INSERT` for exactly this reason:
  // it speaks only once every `BEFORE` guard on the row has stayed silent, so
  // the two layers agree on which of two applicable reasons a row reports.
  const pair = blockedPairOnChain(edges, context.blockEdges ?? [], edge.source, edge.target);
  if (pair !== null) {
    throw new DomainError("RELATION_CYCLE", {
      message: `an ancestor and a descendant cannot depend on each other: ${pair.source} depends on, or is depended on by, ${pair.target}, and this parent would put them on one chain`,
      details: {
        source: edge.source,
        target: edge.target,
        type: "parent",
        chain: "ancestor",
        blocks: { source: pair.source, target: pair.target },
      },
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
 * Every card on `taskId`'s own parent chain, either direction — the ancestors
 * then the descendants, nearest first within each half.
 *
 * This is the board's answer to "which cards may this one not depend on?", and
 * it is deliberately the *same* pair of walks the write guard uses rather than a
 * second spelling of the rule: the drawer's prerequisite picker asks here, the
 * `blocks` guard refuses there, and the two cannot drift because they read one
 * function.
 *
 * The card itself is **not** in the set, even though asking
 * `isOnSameParentChain` about the card and itself answers true: a self-edge is a
 * different defect with its own code (`SELF_REFERENCE`), and this set is only
 * the ancestor/descendant half of the shape rule.
 *
 * @param {{source: string, target: string}[]} parentEdges `parent` edges
 * @param {string} taskId
 * @returns {string[]}
 */
export function parentChainOf(parentEdges, taskId) {
  return [...ancestorsOf(parentEdges, taskId), ...descendantsOf(parentEdges, taskId)];
}

/**
 * The `blocks` edge that a prospective `parent` edge would strand on one parent
 * chain — the reciprocal of `isOnSameParentChain`, asked at the *other* insert
 * point.
 *
 * `parent edges` and `blocks` edges are guarded by two separate rules and each
 * rule used to read only its own graph. That made the verdict depend on arrival
 * order: with the `blocks` edge already down, adding the `parent` edge that puts
 * the two cards on one chain went in unchallenged (`0019` only ever saw the
 * `blocks` insert). The order is not exotic — `storage/md/import.mjs` writes
 * `depends_on` before `parent` for every card it loads, so a real import could
 * land a pair the board refuses to build by hand.
 *
 * The predicate is the **closure**, not the pair: a new `parent` edge `P → C`
 * puts *everything above `P`* above *everything below `C`*, so a `blocks` edge
 * already sitting between an ancestor of `P` and a descendant of `C` becomes an
 * ancestor/descendant join the moment the edge lands, however far either side
 * of the new edge it is. Testing only `(P, C)` would leave that case open.
 *
 * Siblings are still legal, and so is any edge with only one end in the two
 * closures: neither walks the other's side.
 *
 * @param {{source: string, target: string}[]} parentEdges `parent` edges
 * @param {{source: string, target: string}[]} blockEdges `blocks` edges
 * @param {string} parent the prospective parent (source of the new edge)
 * @param {string} child the prospective child (target of the new edge)
 * @returns {{source: string, target: string}|null} the offending edge, if any
 */
export function blockedPairOnChain(parentEdges, blockEdges, parent, child) {
  const above = new Set([parent, ...ancestorsOf(parentEdges, parent)]);
  const below = new Set([child, ...descendantsOf(parentEdges, child)]);
  for (const edge of blockEdges) {
    if (above.has(edge.source) && below.has(edge.target)) return edge;
    if (above.has(edge.target) && below.has(edge.source)) return edge;
  }
  return null;
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
