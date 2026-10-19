/**
 * The request-schema vocabulary the route declarations are built from.
 *
 * A route registration carries a **declarative request schema** — the shape of
 * its `query` and its `body` — alongside its handler. It is JSON-Schema-shaped
 * on purpose: the contract snapshot canonicalises it down to `type` / `enum` /
 * `items` / `anyOf` / `properties` / `required` / `additionalProperties`
 * (`scripts/verify/contract.mjs`), so a route request is described in one
 * language and read the same way in a diff.
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
 *
 * A **task command's body** is no longer written out here by hand: it is
 * projected from the command's own input declaration
 * (`src/core/commands/tasks-input.mjs`) by `project` below, so the route's shape,
 * the CLI's flags and the CLI's body all come from one record. The query shapes
 * are still declared by hand — nothing else consumes them.
 */

import {
  COMMENT_KINDS,
  inputOf,
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
});

/** A field's schema: its vocabulary where the domain closes it, else its type. */
function leafFor(field) {
  if (field.vocab !== null) return oneOf(field.vocab);
  if (field.type === "integer") return int();
  if (field.type === "boolean") return bool();
  if (field.type === "object") {
    if (field.nested === null) return obj();
    const properties = {};
    for (const member of field.nested) properties[member.key] = schemaFor(member);
    return shape(properties);
  }
  return str();
}

/** A field's schema, wrapped in an array when the field repeats. */
function schemaFor(field) {
  const leaf = leafFor(field);
  return field.repeat ? arr(leaf) : leaf;
}

/**
 * A task command's request body, projected from its input declaration.
 *
 * The declaration is the record (`src/core/commands/tasks-input.mjs`); this is
 * how the wire side of it reads. A field the CLI alone carries is skipped — it
 * has no wire name, so the route does not accept it under one.
 *
 * @param {string} op one of `TASK_OPS`
 */
export function project(op) {
  const { fields, required } = inputOf(op);
  const properties = {};
  for (const field of fields) {
    if (field.surface === "cli") continue;
    properties[field.key] = schemaFor(field);
  }
  // `op` rides along as a key `canonicalSchema` does not whitelist, so the frozen
  // snapshot never sees it — while `scripts/verify/route-request.mjs` gets the
  // exact handle it needs to pair this route with the CLI command that sends to
  // it, and with the declaration both project.
  return { ...shape(properties, required), op };
}

// ---------------------------------------------------------------------------
// Reading a query string
//
// The vocabulary above declares what a route accepts; these coerce what the
// handler read. They live here rather than in a route module because five
// sibling routes use them — a feature route is not the request-utils module.
// ---------------------------------------------------------------------------

/** `?include_archived=1|true|yes` — query strings have no types, so be liberal. */
export function truthy(value) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** `?limit=50` — an integer, or undefined so the repository default applies. */
export function intOrUndefined(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}
