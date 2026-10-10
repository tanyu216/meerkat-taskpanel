/**
 * The request-schema vocabulary the route declarations are built from.
 *
 * A route registration carries a **declarative request schema** — the shape of
 * its `query` and its `body` — alongside its handler. It is JSON-Schema-shaped
 * on purpose: the contract snapshot already canonicalises every MCP tool's
 * `inputSchema` down to `type` / `enum` / `items` / `anyOf` / `properties` /
 * `required` / `additionalProperties` (`scripts/verify/contract.mjs`), so a route
 * request and a tool argument are described in one language and read the same way
 * in a diff.
 *
 * ## What this is, and what it deliberately is not
 *
 *   * **Declared, not enforced.** The schema says what the route *accepts*; it is
 *     not a validator. Handlers keep reading `query.get(...)` / `body.…` exactly
 *     as before and the reader keeps ignoring fields it does not know, so adding
 *     a declaration changes nothing a caller can observe. That is why
 *     `additionalProperties` is `true` throughout: an unknown field is *tolerated*,
 *     and the schema says so rather than claiming a strictness the code does not
 *     have. Enforcement is a behavioural change and belongs in a card that says so.
 *   * **A shape, not a validator's copy.** The closed value sets come from
 *     `src/core/domain/enums.mjs` (via `core/index.mjs`) — the same literals the
 *     SQL `CHECK (... IN (...))` clauses guard and the domain validates. A status
 *     added to `STATUSES` therefore widens the declared request shape too, and the
 *     contract gate reports it rather than letting the two drift.
 *   * **Query values are strings.** `?limit=50` reaches a handler as the string
 *     `"50"`, and `?status=a&status=b` as an array — so a query schema declares a
 *     string (or an array of them) where the handler will parse an integer, and
 *     the *parse* is the handler's business, not the transport's. Declaring
 *     `number` here would describe a value the route is never handed.
 */

import {
  COMMENT_KINDS,
  DICT_KINDS,
  PRIORITIES,
  RELATION_TYPES,
  SESSION_STATUSES,
  STATUSES,
  TASK_KINDS,
} from "../core/index.mjs";

/** A JSON string. */
export const str = () => ({ type: "string" });

/** A JSON integer. */
export const int = () => ({ type: "integer" });

/** A JSON boolean. */
export const bool = () => ({ type: "boolean" });

/** A JSON object (shape not further declared here). */
export const obj = () => ({ type: "object" });

/** A JSON array of `items`. */
export const arr = (items) => ({ type: "array", items });

/**
 * A string drawn from a closed set. The set is the domain's — never a literal
 * written out a second time — so it moves with `enums.mjs`.
 *
 * @param {readonly string[]} values
 */
export const oneOf = (values) => ({ type: "string", enum: [...values] });

/**
 * A request object: named properties, the ones a caller must send, and the
 * honest statement that anything else is ignored rather than refused.
 *
 * @param {Record<string, object>} properties
 * @param {string[]} [required]
 */
export function shape(properties, required = []) {
  return { type: "object", properties, required: [...required], additionalProperties: true };
}

/**
 * The request schemas the routes share, named once.
 *
 * These are the fragments more than one route reads the same way — a status
 * vocabulary, a caller kind — so a route declaration says *which* shape it takes
 * instead of spelling the vocabulary out again.
 */
export const REQUEST = Object.freeze({
  status: oneOf(STATUSES),
  statuses: arr(oneOf(STATUSES)),
  priority: oneOf(PRIORITIES),
  taskKind: oneOf(TASK_KINDS),
  relationType: oneOf(RELATION_TYPES),
  commentKind: oneOf(COMMENT_KINDS),
  sessionStatus: oneOf(SESSION_STATUSES),
  dictKind: oneOf(DICT_KINDS),
});
