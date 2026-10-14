#!/usr/bin/env node
/**
 * The route-request lint: a route's **declared** request schema must equal what its
 * **handler actually reads**.
 *
 * The contract snapshot (`scripts/verify/contract.mjs`) freezes the declaration
 * (`routes[].request.{query, body}`) but not the claim that the declaration is *true*.
 * The declaration is the second description of a handler's request — written beside the
 * handler, from it, by hand — so the two can drift: a handler starts reading a field the
 * declaration never mentions, or a declared filter is dropped from the body and left in
 * the schema. The snapshot cannot see either: it freezes the declaration, and a
 * declaration does not change when the handler does.
 *
 * This lint closes that hole at the *mechanism* level rather than by re-auditing each
 * handler by hand. It reads every route's handler **source** (`Function.prototype.toString`,
 * so there is no second copy of the route list and no line-number table to maintain),
 * statically extracts the query fields (`query.get("x")` / `query.getAll("x")`) and body
 * fields (`body.x`, `body["x"]`, `body[x]` over a literal loop, `const { x } = body`) it
 * reads, and compares that set against the declared `properties` — in both directions:
 *
 *   * `undeclared_read`     — the handler reads a field the declaration omits;
 *   * `unread_declaration`  — the declaration names a field the handler never reads;
 *   * `unresolvable_read`   — a read the lint cannot resolve (`body[key]` with a
 *                             non-literal key, `{ ...body }`, `Object.keys(body)`,
 *                             passing `body` on as a whole value). This is a failure, not
 *                             a shrug: a read the lint cannot see is exactly the read that
 *                             could drift unnoticed, so the lint refuses to pass a route
 *                             it cannot prove;
 *   * `stale_refusal`       — a documented "read only in order to reject" entry that no
 *                             longer applies (see `REFUSED_READS`);
 *   * `uncovered_endpoint`  — an endpoint *outside* the JSON router that declares a
 *                             request schema the lint cannot reach (see `OUT_OF_LINT`).
 *
 * ## The second check: a command's input is declared once
 *
 * A task command's input is no longer written down three times. It is declared
 * once (`src/core/commands/tasks-input.mjs`) and projected into the route's
 * request shape and the CLI's flags and body. What the two projections cannot
 * prove on their own is that they are still talking about the *same command* —
 * nothing a compiler sees pairs `POST /api/v1/tasks/:ref/move` with `issue move`.
 * So each side names its op (`project(op)` returns it on the shape; the command
 * carries an `op` field) and `checkCommandInputs` holds the three sides
 * together, reporting `unpaired_op`, `duplicate_op`, `op_shape_mismatch` and
 * `unknown_op`. The last two are the ones that matter over time: they catch a
 * declaration quietly ceasing to be the source, which is what a hand-written
 * body or a hand-written `flags:` array coming back would look like.
 *
 * ## Why the two directions matter
 *
 * A handler reading an undeclared field is the obvious drift: a caller sends a field the
 * frozen contract does not admit. The reverse — a declared field nobody reads — is the
 * quieter one: the contract promises a filter, and a client wires it into a URL believing
 * it does something. Both are the same defect, so both are reported.
 *
 * ## The one honest hole: a field read only to be refused
 *
 * `PATCH /api/v1/tasks/:ref` reads `body.status` in order to throw `INVALID_TRANSITION`
 * ("use move or deliver"). The declaration deliberately omits it: a declared shape lists
 * what a route *accepts*, not what it recognises in order to reject. So the read is real
 * and the omission is correct, and a name-matching lint cannot tell them apart. That is
 * the whole of `REFUSED_READS`: an explicit, reasoned list — not a silent skip list, and
 * not a free pass. Every entry is itself checked, so it cannot rot:
 *
 *   * a refused field that is also declared is `stale_refusal` (the declaration now
 *     describes it, so it is no longer "refused");
 *   * a refused field the handler no longer reads is `stale_refusal`;
 *   * a refusal for a route that no longer exists is `stale_refusal`.
 *
 * ## Why source text, and what that costs
 *
 * Handlers are ordinary functions, and `handler.toString()` gives the exact source the
 * reader is looking at — no reparsing of files, no mapping a route back to a line, and it
 * survives a handler moving between modules. The cost is that this is a lexer plus a
 * read-pattern matcher, not a type-checker: it understands the forms above and *fails
 * loudly* on everything else instead of guessing. A new read form is therefore a red gate
 * and a two-line addition here, never a silent hole.
 *
 * Node builtins only; no network, no dependencies. Static: it never opens a database,
 * starts a server, or calls a handler.
 *
 *   node scripts/verify/route-request.mjs            # lint the live surface; 0 or 1
 *   node scripts/verify/route-request.mjs --print    # the declared-vs-read table, to stdout
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { OUT_OF_ROUTER_ENDPOINTS, registerApiRoutes } from "../../src/server/index.mjs";
import { createRouter } from "../../src/server/router.mjs";
import { inputOf, TASK_OPS } from "../../src/core/commands/tasks-input.mjs";
import { registry as cliRegistry } from "../../src/cli/commands/index.mjs";
import { projectFlags } from "../../src/cli/commands/task-input.mjs";

// ---------------------------------------------------------------------------
// Lexing: just enough JavaScript to find reads, and to not be fooled by prose
// ---------------------------------------------------------------------------

/**
 * Tokenise handler source.
 *
 * Comments are dropped and string literals become `{type: "string"}` tokens carrying
 * their value. That pair is what makes the analysis trustworthy: a `body` inside a
 * comment or a message cannot be mistaken for a read, while the field name in
 * `query.get("project_id")` — itself a string — is still available as a *value* and
 * never as an identifier.
 *
 * @param {string} source
 * @returns {{type: "ident"|"string"|"number"|"punct", value: string}[]}
 */
export function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "`") {
      // A template literal: the literal text is not a field name, but an interpolation
      // (`${body.title}`) is an *expression*, so it is lexed and spliced in rather than
      // swallowed — an interpolated read is a read.
      let j = i + 1;
      const interpolations = [];
      while (j < source.length && source[j] !== "`") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          let depth = 0;
          let k = j + 1;
          for (; k < source.length; k += 1) {
            if (source[k] === "{") depth += 1;
            else if (source[k] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          interpolations.push(...lex(source.slice(j + 2, k)));
          j = k + 1;
          continue;
        }
        j += 1;
      }
      tokens.push({ type: "string", value: "" });
      tokens.push(...interpolations);
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = "";
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      tokens.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      tokens.push({ type: "ident", value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9A-Fa-fxXoObBeE._]/.test(source[j])) j += 1;
      tokens.push({ type: "number", value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.slice(i, i + 3) === "...") {
      tokens.push({ type: "punct", value: "..." });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["=>", "===", "!==", "==", "!=", "??", "?.", "<=", ">=", "&&", "||", "**", "++", "--"].includes(two)) {
      tokens.push({ type: "punct", value: two });
      i += 2;
      continue;
    }
    tokens.push({ type: "punct", value: ch });
    i += 1;
  }
  return tokens;
}

/**
 * Split a handler's tokens into its parameter list and its body.
 *
 * An arrow's `=>` is the boundary; every handler in the route table is an arrow function
 * whose own parameters contain no arrow of their own, so the *first* `=>` is the handler's.
 * (A nested arrow — `.map((task) => …)` — is inside the body, on the far side.) The
 * `function (…) { … }` form is handled by balancing the first parenthesis group.
 *
 * @param {string} source
 */
function splitHandler(source) {
  const tokens = lex(source);
  const arrow = tokens.findIndex((token) => token.value === "=>");
  if (arrow !== -1) return { params: tokens.slice(0, arrow), body: tokens.slice(arrow + 1) };

  const open = tokens.findIndex((token) => token.value === "(");
  if (open === -1) return { params: [], body: tokens };
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i].value === "(") depth += 1;
    else if (tokens[i].value === ")") {
      depth -= 1;
      if (depth === 0) return { params: tokens.slice(open + 1, i), body: tokens.slice(i + 1) };
    }
  }
  return { params: tokens.slice(open + 1), body: [] };
}

/**
 * Token indices that *bind* an identifier rather than read one — an arrow's parameters.
 *
 * Without this, a handler that shadows the reader's own name (`query` or `body`) inside a
 * nested arrow would look like an unresolvable read of the outer value. A parameter is a
 * declaration, not a use, so it is skipped.
 *
 * @param {{type: string, value: string}[]} tokens
 * @returns {Set<number>}
 */
function parameterIndices(tokens) {
  const bindings = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].value !== "=>") continue;
    let j = i - 1;
    if (tokens[j]?.value === ")") {
      let depth = 0;
      for (; j >= 0; j -= 1) {
        if (tokens[j].value === ")") depth += 1;
        else if (tokens[j].value === "(") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      for (let k = j + 1; k < i; k += 1) if (tokens[k].type === "ident") bindings.add(k);
    } else if (tokens[j]?.type === "ident") {
      bindings.add(j);
    }
  }
  return bindings;
}

/**
 * `for (const field of ["a", "b"]) { … }` — the loop variable, mapped to its literals.
 *
 * The one computed access the surface uses today is `body[field]` over such a loop
 * (`PATCH /api/v1/tasks/:ref` walks its patchable fields). Resolving the variable back to
 * the literal list is what lets the lint see through it instead of calling it
 * unresolvable; a loop over anything but string literals simply does not resolve, and the
 * read is then reported.
 *
 * @param {{type: string, value: string}[]} tokens
 * @returns {Map<string, string[]>}
 */
function literalLoopVars(tokens) {
  const vars = new Map();
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (tokens[i].type !== "ident" || !["const", "let", "var"].includes(tokens[i].value)) continue;
    const name = tokens[i + 1];
    if (name?.type !== "ident" || tokens[i + 2]?.value !== "of" || tokens[i + 3]?.value !== "[") continue;

    const values = [];
    let j = i + 4;
    let ok = true;
    while (j < tokens.length && tokens[j].value !== "]") {
      const item = tokens[j];
      if (item.type === "string") values.push(item.value);
      else if (item.value !== ",") {
        ok = false;
        break;
      }
      j += 1;
    }
    if (ok && tokens[j]?.value === "]") vars.set(name.value, values);
  }
  return vars;
}

/** The `{` that opens the destructuring pattern an `=` at `from` closes, or `-1`. */
function patternOpen(tokens, from) {
  let depth = 0;
  for (let j = from; j >= 0; j -= 1) {
    const value = tokens[j]?.value;
    if (value === "}" || value === ")" || value === "]") depth += 1;
    else if (value === "{") {
      depth -= 1;
      if (depth <= 0) return j;
    } else if (value === "(" || value === "[") depth -= 1;
  }
  return -1;
}

/**
 * The *fields* a `{ … } = body` pattern reads off the body.
 *
 * The field a pattern reads is its **key**, not the local name it is bound to:
 * `const { title: renamed } = body` reads `body.title`, and `{ title = "x" }` reads
 * `body.title`. So `{ a, b: c, d = 1 }` reads `a`, `b` and `d`. A `...rest` reads
 * *everything not named*, which cannot be enumerated, so the pattern is reported rather
 * than half-read.
 *
 * @param {{type: string, value: string}[]} tokens
 * @param {number} open index of the opening `{`
 */
function patternNames(tokens, open) {
  const names = new Set();
  let rest = false;
  let depth = 0;
  for (let j = open; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (token.value === "{" || token.value === "[" || token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.value === "}" || token.value === "]" || token.value === ")") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (token.value === "...") {
      rest = true;
      j += 1; // the bound name of a rest element is not a field name
      continue;
    }
    if (token.type !== "ident" && token.type !== "string") continue;
    if (tokens[j + 1]?.value === ":") {
      names.add(token.value); // the key is the field; the local name is not
      const value = tokens[j + 2];
      if (value?.value === "{" || value?.value === "[") rest = true; // nested pattern
      else j += 2; // skip `:` and the local name
      continue;
    }
    names.add(token.value);
  }
  return { names: [...names], rest };
}

// ---------------------------------------------------------------------------
// Reading one identifier out of a handler
// ---------------------------------------------------------------------------

/** Skip a token that names a property (`body.body`) or an object key (`{ body: … }`). */
function isLabel(tokens, index) {
  const previous = tokens[index - 1];
  const next = tokens[index + 1];
  return previous?.value === "." || previous?.value === "?." || next?.value === ":";
}

/**
 * The query fields a handler reads: `query.get("x")` and `query.getAll("x")`.
 *
 * Those two are the whole query read. Any other use of `query` — iterating it, passing it
 * on, destructuring from it — is a shape the lint cannot see through, and is reported
 * rather than assumed harmless.
 *
 * @param {{type: string, value: string}[]} tokens
 * @returns {{fields: string[], unresolvable: string[]}}
 */
function readQueryFields(tokens) {
  const fields = new Set();
  const unresolvable = [];
  const bindings = parameterIndices(tokens);

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "ident" || tokens[i].value !== "query" || bindings.has(i)) continue;
    if (isLabel(tokens, i)) continue;

    const method = tokens[i + 2];
    const arg = tokens[i + 4];
    if (
      tokens[i + 1]?.value === "." &&
      method?.type === "ident" &&
      ["get", "getAll"].includes(method.value) &&
      tokens[i + 3]?.value === "(" &&
      arg?.type === "string" &&
      tokens[i + 5]?.value === ")"
    ) {
      fields.add(arg.value);
      continue;
    }
    unresolvable.push(`query is used in a way this lint cannot resolve (near "${tokens[i + 1]?.value ?? "end of body"}")`);
  }

  return { fields: [...fields].sort(), unresolvable };
}

/**
 * The body fields a handler reads.
 *
 * Understands `body.x`, `body["x"]`, `body[x]` over a literal loop, and `const { … } = body`.
 * Everything else that touches `body` as a whole is unresolvable by construction.
 *
 * @param {{type: string, value: string}[]} tokens
 * @returns {{fields: string[], unresolvable: string[]}}
 */
function readBodyFields(tokens) {
  const fields = new Set();
  const unresolvable = [];
  const bindings = parameterIndices(tokens);
  const loopVars = literalLoopVars(tokens);

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "ident" || tokens[i].value !== "body" || bindings.has(i)) continue;
    if (isLabel(tokens, i)) continue;

    // `{ ...body }` spreads the whole body; `{ ...body.meta }` spreads one declared field
    // and is read like any other `body.meta`.
    if (tokens[i - 1]?.value === "..." && tokens[i + 1]?.value !== "." && tokens[i + 1]?.value !== "[") {
      unresolvable.push("body is spread as a whole value (`{ ...body }`), so its reads cannot be enumerated");
      continue;
    }

    // `const { a } = body` — the `=` is preceded by the pattern's closing brace. An
    // assignment (`patch[field] = body[field]`) is preceded by its own left-hand side, and
    // is not a pattern.
    if (tokens[i - 1]?.value === "=" && tokens[i - 2]?.value === "}") {
      const open = patternOpen(tokens, i - 1);
      if (open === -1) {
        unresolvable.push("body is bound to a pattern this lint cannot read");
        continue;
      }
      const { names, rest } = patternNames(tokens, open);
      for (const name of names) fields.add(name);
      if (rest) unresolvable.push("body is destructured with a rest element, so the fields it reads cannot be enumerated");
      continue;
    }

    const name = tokens[i + 2];
    if (tokens[i + 1]?.value === "." && name?.type === "ident") {
      if (tokens[i + 3]?.value === "(") unresolvable.push(`body.${name.value}(…) is a call this lint cannot resolve`);
      else fields.add(name.value);
      continue;
    }
    if (tokens[i + 1]?.value === "[" && tokens[i + 3]?.value === "]") {
      if (name?.type === "string") {
        fields.add(name.value);
        continue;
      }
      if (name?.type === "ident" && loopVars.has(name.value)) {
        for (const value of loopVars.get(name.value)) fields.add(value);
        continue;
      }
      unresolvable.push(`body[${name?.value ?? "…"}] is a computed field this lint cannot resolve`);
      continue;
    }
    unresolvable.push(
      `body is used as a whole value (next token "${tokens[i + 1]?.value ?? "end of body"}"), so its reads cannot be enumerated`,
    );
  }

  return { fields: [...fields].sort(), unresolvable };
}

/**
 * What one handler reads, statically.
 *
 * The public unit the tests drive with synthetic handlers — the whole lint is this
 * function applied to every route in `liveRouterRoutes()`.
 *
 * @param {Function} handler
 * @returns {{query: string[], body: string[], unresolvable: string[]}}
 */
export function extractReads(handler) {
  const { body } = splitHandler(handler.toString());
  const query = readQueryFields(body);
  const json = readBodyFields(body);
  return {
    query: query.fields,
    body: json.fields,
    unresolvable: [...query.unresolvable, ...json.unresolvable],
  };
}

// ---------------------------------------------------------------------------
// The surface, enumerated from the same registration the server and the snapshot use
// ---------------------------------------------------------------------------

/** `POST /api/v1/tasks/:ref/move` — a route's identity, the key a finding names. */
export function routeKey(route) {
  return `${route.method} ${route.path ?? route.pattern}`;
}

/**
 * Every route `registerApiRoutes` registers, **with its handler**.
 *
 * The router is the second reader of this list (the snapshot is the third): registering
 * against a stub is what `createTaskd` does, minus a database, so a route can no more
 * escape this lint than it can escape the server.
 *
 * @returns {{method: string, pattern: string, handler: Function, request: object}[]}
 */
export function liveRouterRoutes() {
  const router = createRouter();
  registerApiRoutes(router, { board: { commands: {}, repos: {} }, token: null });
  return router.routes;
}

/** The declared `properties` of one request side, or `[]` when the side is `null`. */
export function declaredFields(request, side) {
  const fragment = request?.[side] ?? null;
  if (fragment === null || typeof fragment !== "object") return [];
  const properties = fragment.properties;
  if (properties === null || typeof properties !== "object") return [];
  return Object.keys(properties).sort();
}

// ---------------------------------------------------------------------------
// The two documented lists
// ---------------------------------------------------------------------------

/**
 * Reads that are real and deliberately undeclared: a field a handler touches only in
 * order to refuse it.
 *
 * A declared shape lists what a route *accepts*, so a field the route rejects does not
 * belong in it — and yet the handler does read the field. This is the only such case on
 * the surface, and it is spelled out here rather than pattern-matched away, because a
 * pattern matcher guessing on the handler's behalf is how a silent hole gets built.
 *
 * Every entry is *checked*, so the list cannot quietly rot: a refusal whose field is also
 * declared, whose handler no longer reads it, or whose route is gone is itself a finding.
 */
export const REFUSED_READS = Object.freeze([
  {
    route: "PATCH /api/v1/tasks/:ref",
    side: "body",
    field: "status",
    why:
      "the route refuses `status` with INVALID_TRANSITION (\"use move or deliver\") — a shape " +
      "declares what a route accepts, not what it recognises in order to reject",
  },
]);

/**
 * Endpoints served **outside** the JSON router, which therefore have no handler in the
 * route table for the lint to read. Each is acknowledged here with the reason, so the
 * boundary is a stated decision rather than an accident of where the code lives.
 *
 * `declares` says what the endpoint's frozen request schema is:
 *
 *   * `"none"` — the endpoint declares `null` on both sides (it reads no JSON request).
 *     If it ever grows a declaration, the acknowledgement no longer describes it and the
 *     endpoint is reported — a new request shape outside the router must be a decision,
 *     not a discovery.
 *   * `"unverifiable"` — the endpoint does declare a request schema, and its reader lives
 *     outside the router. The declaration is frozen by the contract snapshot; what cannot
 *     be proven from source is stated here.
 */
export const OUT_OF_LINT = Object.freeze([
  {
    route: "GET /health",
    declares: "none",
    why: "registered inside createTaskd rather than by registerApiRoutes, so the route table carries no handler; it declares no request field",
  },
  {
    route: "GET /meta",
    declares: "none",
    why: "same as /health — in createTaskd, and it reads no request field",
  },
  {
    route: "GET /api/v1/events",
    declares: "unverifiable",
    why: "the stream's reader is revisionFromRequest(url, req) in src/server/sse.mjs — the route registers no handler, so only its declaration is frozen",
  },
  {
    route: "GET /api/v1/attachments/:id/content",
    declares: "none",
    why: "bytes in / bytes out — handleAttachmentContent reads no JSON request",
  },
  {
    route: "PUT /api/v1/attachments/:id/content",
    declares: "none",
    why: "same as the GET — the bytes come from readRawBody, not from a JSON body",
  },
]);

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Does this endpoint's frozen declaration promise any request field? */
function declaresRequest(endpoint) {
  return endpoint.request?.query != null || endpoint.request?.body != null;
}

/**
 * Compare every route's declaration against what its handler reads.
 *
 * Pure: it takes the routes (and, for tests, the endpoints and the refusal list) as
 * arguments, touches nothing, and returns the same findings for the same input — so the
 * red→green proof can drive it with synthetic handlers and never edit `src/`.
 *
 * @param {{method: string, path?: string, pattern?: string, handler: Function, request: object}[]} routes
 * @param {{refused?: object[], endpoints?: object[], outOfLint?: object[]}} [options]
 * @returns {{ok: boolean, findings: {kind: string, route: string, side: string|null, detail: string}[]}}
 */
export function checkRouteRequests(routes, options = {}) {
  const refused = options.refused ?? REFUSED_READS;
  const endpoints = options.endpoints ?? OUT_OF_ROUTER_ENDPOINTS;
  const outOfLint = options.outOfLint ?? OUT_OF_LINT;

  const findings = [];
  const add = (kind, route, side, detail) => findings.push({ kind, route, side, detail });
  const usedRefusals = new Set();

  for (const route of routes) {
    const key = routeKey(route);
    const reads = extractReads(route.handler);
    for (const detail of reads.unresolvable) add("unresolvable_read", key, null, detail);

    for (const side of ["query", "body"]) {
      const declared = new Set(declaredFields(route.request, side));
      const read = new Set(reads[side]);
      const refusedFields = new Set(
        refused.filter((entry) => entry.route === key && entry.side === side).map((entry) => entry.field),
      );

      for (const field of read) {
        if (declared.has(field)) continue;
        if (refusedFields.has(field)) {
          usedRefusals.add(`${key}|${side}|${field}`);
          continue;
        }
        add("undeclared_read", key, side, `the handler reads "${field}" but the declaration omits it`);
      }
      for (const field of declared) {
        if (!read.has(field)) add("unread_declaration", key, side, `the declaration names "${field}" but the handler never reads it`);
      }
      for (const field of refusedFields) {
        usedRefusals.add(`${key}|${side}|${field}`);
        if (declared.has(field)) add("stale_refusal", key, side, `"${field}" is refused and also declared — the declaration now describes it`);
        if (!read.has(field)) add("stale_refusal", key, side, `"${field}" is refused but the handler never reads it`);
      }
    }
  }

  // A refusal that matched nothing is one of two mistakes: the entry names a route or
  // field that moved, or the handler stopped reading the field. Either way the list is
  // now describing something that is not there, which is the failure mode of every
  // hand-kept exemption list — so it is a finding, not a shrug.
  for (const entry of refused) {
    if (!usedRefusals.has(`${entry.route}|${entry.side}|${entry.field}`)) {
      add("stale_refusal", entry.route, entry.side, `no route reads "${entry.field}" any more — drop this refusal`);
    }
  }

  // The router handles everything it registers; an endpoint outside it needs saying so.
  const acknowledged = new Map(outOfLint.map((entry) => [entry.route, entry]));
  for (const endpoint of endpoints) {
    const key = routeKey(endpoint);
    const entry = acknowledged.get(key);
    if (entry === undefined) {
      add("uncovered_endpoint", key, null, "served outside the JSON router and not acknowledged — add it to OUT_OF_LINT with a reason");
      continue;
    }
    if (entry.declares === "none" && declaresRequest(endpoint)) {
      add("uncovered_endpoint", key, null, "now declares a request schema but is still served outside the JSON router");
    }
  }
  for (const entry of outOfLint) {
    if (!endpoints.some((endpoint) => routeKey(endpoint) === entry.route)) {
      add("stale_uncovered", entry.route, null, "no such out-of-router endpoint — drop this acknowledgement");
    }
  }

  findings.sort((a, b) =>
    `${a.route}|${a.side ?? ""}|${a.kind}|${a.detail}` < `${b.route}|${b.side ?? ""}|${b.kind}|${b.detail}` ? -1 : 1,
  );
  return { ok: findings.length === 0, findings };
}

/** One line per finding, the shape both the CLI and a failure message print. */
export function formatFinding(finding) {
  const at = finding.side === null ? finding.route : `${finding.route} (${finding.side})`;
  return `[${finding.kind}] ${at}: ${finding.detail}`;
}

// ---------------------------------------------------------------------------
// The command-input pairing
// ---------------------------------------------------------------------------

/**
 * One declaration, three consumers — and the pairing between them is proved here.
 *
 * A task command's input is declared once (`src/core/commands/tasks-input.mjs`)
 * and projected twice: the route builds its request shape from it, and the CLI
 * builds its flags and its body. What the projections cannot prove on their own
 * is that all three sides are still *talking about the same command*: the route
 * that projects `tasks.move` and the `issue move` command are paired by nothing
 * a compiler sees.
 *
 * So each side names its op — the route through the shape `project(op)` returns,
 * the command through its own `op` field — and this check holds them together:
 *
 *   * `unpaired_op`       — an op in `TASK_OPS` that one side no longer names, or
 *                           a side naming an op with no declaration (the two
 *                           directions of the same divorce);
 *   * `duplicate_op`      — two routes, or two commands, claiming one op;
 *   * `op_shape_mismatch` — a side whose projected surface is not what the
 *                           declaration says it should be: the route's body is
 *                           not exactly the non-`cli` fields, or the command's
 *                           flags are not what `projectFlags` produces. This is
 *                           the check that catches a declaration quietly ceasing
 *                           to be the source — a hand-written body or a
 *                           hand-written `flags:` array sneaking back in.
 *   * `unknown_op`        — a side naming something that is not in `TASK_OPS`.
 *                           A misspelt op would otherwise pair nothing and say
 *                           nothing, which is how a silent hole is built.
 *
 * @param {{method: string, pattern: string, handler: Function, request: object}[]} routes
 * @param {{groups: object[]}} [registry]
 */
export function checkCommandInputs(routes, registry = cliRegistry) {
  const findings = [];
  const known = new Set(Object.values(TASK_OPS));

  const byRoute = new Map();
  for (const route of routes) {
    const op = route.request?.body?.op;
    if (op === undefined) continue;
    const where = routeKey(route);
    if (byRoute.has(op)) {
      findings.push({ kind: "duplicate_op", route: where, side: "body", detail: `"${op}" is already projected by ${byRoute.get(op).where}` });
    } else {
      byRoute.set(op, { where, request: route.request });
    }
  }

  const byCommand = new Map();
  for (const group of registry.groups) {
    for (const command of group.commands) {
      if (command.op === undefined) continue;
      const where = `${registry.name ?? "taskctl"} ${group.name} ${command.name}`;
      if (byCommand.has(command.op)) {
        findings.push({ kind: "duplicate_op", route: where, side: null, detail: `"${command.op}" is already declared by ${byCommand.get(command.op).where}` });
      } else {
        byCommand.set(command.op, { where, command });
      }
    }
  }

  for (const op of known) {
    const route = byRoute.get(op);
    const cli = byCommand.get(op);
    if (route === undefined) {
      findings.push({ kind: "unpaired_op", route: op, side: "body", detail: `no route projects "${op}" — the declaration has a consumer that is gone` });
    }
    if (cli === undefined) {
      findings.push({ kind: "unpaired_op", route: op, side: null, detail: `no CLI command declares "${op}" — the declaration has a consumer that is gone` });
    }
    if (route === undefined || cli === undefined) continue;

    const expected = inputOf(op).fields.filter((field) => field.surface !== "cli").map((field) => field.key).sort();
    const declared = declaredFields(route.request, "body");
    if (expected.join(",") !== declared.join(",")) {
      findings.push({
        kind: "op_shape_mismatch",
        route: route.where,
        side: "body",
        detail: `"${op}" declares [${declared.join(", ")}] where its declaration's non-CLI fields are [${expected.join(", ")}]`,
      });
    }

    const projected = projectFlags(op).map((spec) => spec.flag);
    const declaredFlags = (cli.command.flags ?? []).map((spec) => spec.flag);
    if (projected.join(",") !== declaredFlags.join(",")) {
      findings.push({
        kind: "op_shape_mismatch",
        route: cli.where,
        side: null,
        detail: `"${op}" projects flags [${projected.join(", ")}] where the command declares [${declaredFlags.join(", ")}]`,
      });
    }
  }

  const named = new Set([...byRoute.keys(), ...byCommand.keys()]);
  for (const op of named) {
    if (known.has(op)) continue;
    findings.push({ kind: "unknown_op", route: op, side: null, detail: `"${op}" is not one of TASK_OPS — a misspelt op would otherwise pair nothing and say nothing` });
  }

  findings.sort((a, b) =>
    `${a.route}|${a.side ?? ""}|${a.kind}|${a.detail}` < `${b.route}|${b.side ?? ""}|${b.kind}|${b.detail}` ? -1 : 1,
  );
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The declared-vs-read table, for a human reading the gate's premise. */
function printTable(routes) {
  for (const route of routes) {
    const reads = extractReads(route.handler);
    const line = (side) => {
      const declared = declaredFields(route.request, side);
      const read = reads[side];
      const refused = REFUSED_READS.filter((entry) => entry.route === routeKey(route) && entry.side === side).map(
        (entry) => entry.field,
      );
      const mark = refused.map((field) => `${field} (refused)`);
      return `    ${side.padEnd(5)} declared [${declared.join(", ")}]  reads [${[...read, ...mark].join(", ")}]`;
    };
    process.stdout.write(`  ${routeKey(route)}\n${line("query")}\n${line("body")}\n`);
  }
}

/** Per op: the declaration, the route that projects it, and the command that sends to it. */
function printCommandInputs(routes, registry = cliRegistry) {
  const routeOf = new Map();
  for (const route of routes) {
    const op = route.request?.body?.op;
    if (op !== undefined) routeOf.set(op, routeKey(route));
  }
  const commandOf = new Map();
  for (const group of registry.groups) {
    for (const command of group.commands) {
      if (command.op !== undefined) commandOf.set(command.op, `${group.name} ${command.name}`);
    }
  }
  for (const op of Object.values(TASK_OPS)) {
    const fields = inputOf(op).fields.map((field) => `${field.key} (${field.surface})`).join(", ");
    process.stdout.write(`  ${op}\n    route    ${routeOf.get(op) ?? "—"}\n    command  ${commandOf.get(op) ?? "—"}\n    fields   [${fields}]\n`);
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { print: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/route-request.mjs [--print]\n\n" +
        "  --print   per route, the declared request fields and the fields its handler reads;\n" +
        "            then, per op, the declaration, its route and its CLI command\n\n" +
        "Exit: 0 the declarations match the handlers and the command inputs pair · 1 drift · 2 usage\n",
    );
    return 0;
  }

  const routes = liveRouterRoutes();
  if (values.print) {
    printTable(routes);
    printCommandInputs(routes);
    return 0;
  }

  const findings = [...checkRouteRequests(routes).findings, ...checkCommandInputs(routes).findings];
  findings.sort((a, b) =>
    `${a.route}|${a.side ?? ""}|${a.kind}|${a.detail}` < `${b.route}|${b.side ?? ""}|${b.kind}|${b.detail}` ? -1 : 1,
  );

  if (findings.length > 0) {
    process.stderr.write(`route-request: FAILED — ${findings.length} finding(s)\n`);
    for (const finding of findings) process.stderr.write(`  ${formatFinding(finding)}\n`);
    process.stderr.write(
      "route-request: a route's declared request schema and its handler must agree, and a command's\n" +
        "  input must be projected from its declaration on both surfaces.\n" +
        "  Fix the declaration beside the route, or — if the read is deliberate and the field is\n" +
        "  refused rather than accepted — add a reasoned entry to REFUSED_READS.\n",
    );
    return 1;
  }

  const ops = Object.values(TASK_OPS).length;
  process.stdout.write(
    `route-request: OK — ${routes.length} routes, declaration == handler reads, ${ops} command inputs paired ` +
      `(${OUT_OF_LINT.length} out-of-router endpoints acknowledged)\n`,
  );
  return 0;
}

// Guarded so the test suite can import the module without side effects.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
