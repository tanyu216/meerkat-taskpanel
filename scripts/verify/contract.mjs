#!/usr/bin/env node
/**
 * The API contract, frozen as a machine-checked snapshot.
 *
 * `test/contract/` proves the *behaviour* of the API. What it cannot prove is
 * that the *shape* of the surface has not moved: a route silently renamed, an
 * error code's HTTP status changed, a wire field dropped from a projection, a
 * tool argument added. Those are exactly the changes a client breaks on, and
 * none of them fails a behavioural test that was written to the old shape.
 *
 * This script reads the live surface and writes it down as JSON:
 *
 *   * **routes**      — every `METHOD /path` the daemon answers, the JSON router
 *                       *and* the endpoints it serves outside it (`/health`,
 *                       `/meta`, the SSE stream, attachment bytes), each with its
 *                       **declared request schema** (`{query, body}`) frozen down
 *                       to the same facets as a tool argument;
 *   * **errors**      — every `ERROR_CODES` code with the HTTP status it carries;
 *   * **wire**        — the name **and JSON type** of every field each `*ToWire`
 *                       projection emits;
 *   * **mcp_tools**   — every MCP tool's name and its `inputSchema` frozen down
 *                       to the facets a caller binds to — `type`, `enum`, `items`,
 *                       `anyOf`, `properties` and `required`, recursively.
 *
 * The snapshot is **deterministic**: keys are sorted at every level and every
 * list has an explicit sort order, so two runs on the same tree are byte-identical
 * and a diff means a contract change, never a reordering. It is regenerated with
 * `--update` and compared by `check`
 *
 *   node scripts/verify/contract.mjs             # compare live vs committed; 0 or 1
 *   node scripts/verify/contract.mjs --update    # rewrite the committed snapshot
 *   node scripts/verify/contract.mjs --print     # the live snapshot, to stdout
 *   node scripts/verify/contract.mjs --base <dir>  # compare against another tree
 *
 * The routes come from `registerApiRoutes` — the same function `createTaskd`
 * calls — so a route cannot be added to the server without appearing here. The
 * error codes come from `ERROR_CODES`, the wire field names *and types* from the
 * projections themselves, the tools and their schemas from `TOOLS`, and a route's
 * request shape from the declaration the registration itself carries
 * (`src/server/requests.mjs`). Nothing is a second copy of a list.
 *
 * A route's request schema is **declared, not enforced** — the handlers still read
 * `query.get(...)` / `body.…` and unknown fields are still ignored, which is why
 * the declared objects are `additionalProperties: true`. What the snapshot freezes
 * is the shape the route *promises*, so a field renamed in a declaration, a status
 * vocabulary that moved, or a query filter that appeared shows up as drift the
 * moment the source changes. `test/verify/contract.test.mjs` pins the premise that
 * every route carries such a declaration, and the drift tests prove a changed
 * field turns the gate red.
 *
 * Deliberately **not** in the snapshot: error *messages* and *hints*, route
 * handler internals, and JSON-schema descriptions. Those are prose — they are
 * expected to change, and freezing them would turn every wording edit into a
 * snapshot chore. Only what a client binds to is frozen.
 *
 * Exit codes: 0 the tree matches the snapshot (or `--print` / `--update` ran);
 * 1 drift — the API moved and the snapshot was not updated; 2 bad usage, or the
 * snapshot file is missing / unreadable / not valid JSON.
 *
 * Node builtins only; no network, no dependencies.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { TOOLS } from "../../src/mcp/registry.mjs";
import { OUT_OF_ROUTER_ENDPOINTS, registerApiRoutes } from "../../src/server/index.mjs";
import { createRouter } from "../../src/server/router.mjs";
import { ERROR_CODES } from "../../src/shared/errors.mjs";
import {
  activityToWire,
  commentToWire,
  dictionaryEntryToWire,
  labelToWire,
  projectToWire,
  relationToWire,
  reportToWire,
  sessionToWire,
  taskToWire,
} from "../../src/shared/wire.mjs";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The committed snapshot, relative to the tree root. */
export const SNAPSHOT_FILE = "test/fixtures/contract/api.snapshot.json";

/**
 * Bumped only when the snapshot's own *schema* changes shape. (3 added each
 * route's declared request `{query, body}`; 2 added the wire field types and the
 * recursive MCP `inputSchema` facts.)
 */
export const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Collecting the live surface
// ---------------------------------------------------------------------------

/** Ascending by `path`, then `method` — the snapshot's one route order. */
function compareRoute(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.method < b.method ? -1 : 1;
}

/**
 * One route's declared request, canonicalised the way a tool's `inputSchema` is.
 *
 * A `null` side (no query, no body) survives as `null` — "this route declares no
 * schema for that part" is a fact worth freezing too, not an absence to erase.
 *
 * @param {{query?: object|null, body?: object|null}|undefined} request
 */
function canonicalRequest(request) {
  return { query: canonicalSchema(request?.query), body: canonicalSchema(request?.body) };
}

/**
 * Every `METHOD /path` the daemon answers, with its declared request schema.
 *
 * The router routes are *enumerated* by registering them against a stub: the
 * `register*Routes` functions only push `{method, pattern, handler, request}` onto
 * the router, so nothing touches a database or a handler — the registration is
 * the single source of the route *and* of its request shape. The out-of-router
 * endpoints are declared next to that router in `src/server/index.mjs` and carry
 * a request declaration of their own.
 *
 * @returns {{method: string, path: string, request: {query: object|null, body: object|null}}[]}
 */
export function collectRoutes() {
  const router = createRouter();
  registerApiRoutes(router, { board: { commands: {}, repos: {} }, token: null });

  const rows = router.routes.map((route) => ({
    method: route.method,
    path: route.pattern,
    request: canonicalRequest(route.request),
  }));
  for (const endpoint of OUT_OF_ROUTER_ENDPOINTS) {
    rows.push({ method: endpoint.method, path: endpoint.path, request: canonicalRequest(endpoint.request) });
  }
  return rows.sort(compareRoute);
}

/**
 * Every error code and the HTTP status it carries. The message and the hint are
 * prose, not contract, and are left out on purpose.
 *
 * @returns {{code: string, http: number}[]}
 */
export function collectErrors() {
  return Object.entries(ERROR_CODES)
    .map(([code, spec]) => ({ code, http: spec.http }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** A lookup that answers every actor, so the probe task yields a populated ref. */
const PROBE_ACTOR_LOOKUP = () => ({ displayName: "probe", kind: "agent" });

/**
 * The wire probes: one subject per projection, with **every** field the
 * projection reads populated with a value of the type that field carries.
 *
 * This is what makes a field's *type* observable. Each projection is called
 * with one of these instead of `{}`: a `*ToWire` function always writes every
 * field (using `null`/`[]` for what the subject lacks), so the *names* are the
 * same either way — but an empty subject would make every value `null`, and a
 * snapshot of "everything is null" freezes nothing. Populated, the emitted type
 * is the one a client actually receives: `task.version` is a number,
 * `task.labels` is an array, `task.title` is a string.
 *
 * If a projection starts reading a field the probe does not supply, that field
 * reads back `null` in the snapshot — visible, which is the point.
 */
const PROBE_ACTIVITY = {
  id: "probe",
  taskId: "probe",
  actorKind: "probe",
  actorId: "probe",
  event: "probe",
  changes: { probe: true },
  revision: 1,
  createdAt: "probe",
};

const PROBE_COMMENT = {
  id: "probe",
  taskId: "probe",
  body: "probe",
  kind: "probe",
  authorKind: "probe",
  authorId: "probe",
  agentSession: "probe",
  refs: ["probe"],
  version: 1,
  createdAt: "probe",
};

const PROBE_DICTIONARY_ENTRY = {
  id: "probe",
  kind: "probe",
  displayName: "probe",
  normalizedName: "probe",
  platform: "probe",
  firstSeenAt: "probe",
  lastSeenAt: "probe",
  useCount: 1,
};

const PROBE_LABEL = {
  id: "probe",
  projectId: "probe",
  norm: "probe",
  displayName: "probe",
  color: "probe",
  useCount: 1,
  firstSeenAt: "probe",
  lastSeenAt: "probe",
  archivedAt: "probe",
};

const PROBE_PROJECT = {
  id: "probe",
  name: "probe",
  workspacePath: "probe",
  labels: ["probe"],
  meta: { probe: true },
  readme: "probe",
  archivedAt: "probe",
  createdAt: "probe",
  updatedAt: "probe",
};

const PROBE_RELATION = {
  id: "probe",
  type: "probe",
  source: "probe",
  target: "probe",
  origin: "probe",
  createdAt: "probe",
};

const PROBE_REPORT = {
  id: "probe",
  taskId: "probe",
  round: 1,
  seg: "probe",
  sessionId: "probe",
  conclusion: "probe",
  acceptance: ["probe"],
  evidence: ["probe"],
  leftovers: "probe",
  authorKind: "probe",
  authorId: "probe",
  createdAt: "probe",
};

const PROBE_SESSION = {
  id: "probe",
  taskId: "probe",
  seg: "probe",
  owner: "probe",
  backend: "probe",
  sessionId: "probe",
  phase: "probe",
  pid: 1,
  status: "probe",
  ts: "probe",
};

/**
 * A task with every copy field populated — including the two optional object
 * fields, so projecting it emits the nested shapes (`assignee`, `reporter`,
 * `report_waiver`) as well as the flat ones. Without those, the nested shapes
 * would come back `null` and their field names *and types* would be missing
 * from the snapshot.
 */
const PROBE_TASK = Object.freeze({
  id: "probe",
  identifier: "probe",
  projectId: "probe",
  title: "probe",
  description: "probe",
  status: "probe",
  priority: "probe",
  kind: "probe",
  sortOrder: 1,
  assigneeId: "probe-assignee",
  reporterId: "probe-reporter",
  creatorKind: "probe",
  creatorId: "probe",
  agentSession: "probe",
  threadId: "probe",
  threadSource: "probe",
  claimedBy: "probe",
  claimedAt: "probe",
  heartbeatAt: "probe",
  blockedAt: "probe",
  statusChangedAt: "probe",
  archivedAt: "probe",
  sourcePath: "probe",
  reportLatestId: "probe",
  deliveryRound: 1,
  version: 1,
  createdAt: "probe",
  updatedAt: "probe",
  labels: ["probe"],
  meta: { probe: true },
  reportWaiverRound: 1,
  reportWaiverReason: "probe",
  reportWaivedAt: "probe",
});

/** The JSON type of an emitted value — the alphabet a wire field type is drawn from. */
function wireType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `{field: type}` for one projected object, keys sorted. */
function fieldTypes(value) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of Object.keys(value ?? {}).sort()) out[key] = wireType(value[key]);
  return out;
}

/**
 * The field names *and types* every wire projection emits, one entry per shape.
 *
 * The type is read off a probe projection (see `PROBE_*` above): it is the type
 * the field carries when the field is populated, so a projection that starts
 * emitting a string where it emitted a number — or wraps a value in `String()`
 * — moves the snapshot instead of slipping through.
 *
 * @returns {{shape: string, fields: Record<string, string>}[]}
 */
export function collectWire() {
  const task = taskToWire(PROBE_TASK, { lookup: PROBE_ACTOR_LOOKUP });
  const shapes = {
    activity: activityToWire(PROBE_ACTIVITY),
    comment: commentToWire(PROBE_COMMENT),
    dictionary_entry: dictionaryEntryToWire(PROBE_DICTIONARY_ENTRY),
    label: labelToWire(PROBE_LABEL),
    project: projectToWire(PROBE_PROJECT),
    relation: relationToWire(PROBE_RELATION),
    report: reportToWire(PROBE_REPORT),
    session: sessionToWire(PROBE_SESSION),
    task,
  };

  const out = [];
  for (const [shape, value] of Object.entries(shapes)) out.push({ shape, fields: fieldTypes(value) });
  // The nested shapes are part of the same contract: a client reads
  // `assignee.display_name`, so that field is as frozen as `task.title`.
  out.push({ shape: "task.assignee", fields: fieldTypes(task.assignee) });
  out.push({ shape: "task.reporter", fields: fieldTypes(task.reporter) });
  out.push({ shape: "task.report_waiver", fields: fieldTypes(task.report_waiver) });

  return out.sort((a, b) => (a.shape < b.shape ? -1 : 1));
}

/**
 * The contract facets of one JSON-Schema fragment, recursively: `type`,
 * `enum`, `items`, `anyOf`, `properties` and `required` (plus
 * `additionalProperties`, which says whether an object is closed).
 *
 * Every list is sorted — `enum` and `required` alphabetically, `properties` by
 * key, `anyOf` branches keep their declaration order (the order is stable in
 * source and the branches are positional) — so two runs are byte-identical.
 *
 * `description` and every other prose key are dropped for the same reason the
 * error messages are: they are wording, and freezing wording turns a copy edit
 * into a snapshot chore. What a caller binds to — *is it a string, which values
 * does it accept, is it an array and of what* — is what survives.
 *
 * @param {object|null|undefined} fragment
 * @returns {object|null}
 */
export function canonicalSchema(fragment) {
  if (fragment === null || typeof fragment !== "object") return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  if (fragment.type !== undefined) out.type = fragment.type;
  if (fragment.additionalProperties !== undefined) out.additionalProperties = fragment.additionalProperties;
  if (Array.isArray(fragment.enum)) out.enum = [...fragment.enum].sort();
  if (fragment.items !== undefined) out.items = canonicalSchema(fragment.items);
  if (Array.isArray(fragment.anyOf)) out.anyOf = fragment.anyOf.map(canonicalSchema);
  if (fragment.properties !== undefined) {
    /** @type {Record<string, unknown>} */
    const properties = {};
    for (const key of Object.keys(fragment.properties).sort()) {
      properties[key] = canonicalSchema(fragment.properties[key]);
    }
    out.properties = properties;
  }
  if (Array.isArray(fragment.required)) out.required = [...fragment.required].sort();
  return out;
}

/**
 * The MCP tool surface: each tool's name and its frozen `inputSchema`.
 *
 * The schema is the whole contract of a tool call — not just *which* arguments
 * exist but their `type`, the `enum` of values each accepts, and the `items` of
 * an array — captured recursively by `canonicalSchema`. That subsumes the
 * argument names and the required list the older snapshot kept separately, so
 * there is one description of a tool's request, not three.
 *
 * @returns {{name: string, schema: object|null}[]}
 */
export function collectMcpTools() {
  return TOOLS.map((tool) => ({ name: tool.name, schema: canonicalSchema(tool.inputSchema) })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
}

/**
 * The whole live contract, in the snapshot's shape.
 *
 * @returns {{schema_version: number, routes: object[], errors: object[], wire: object[], mcp_tools: object[]}}
 */
export function buildSnapshot() {
  return {
    schema_version: SCHEMA_VERSION,
    routes: collectRoutes(),
    errors: collectErrors(),
    wire: collectWire(),
    mcp_tools: collectMcpTools(),
  };
}

// ---------------------------------------------------------------------------
// Deterministic serialisation
// ---------------------------------------------------------------------------

/** Rebuild a value with every object's keys sorted, recursively. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * The snapshot as text: sorted keys at every level, two-space indent, one
 * trailing newline. Deterministic by construction — the same live surface always
 * serialises to the same bytes.
 *
 * @param {object} snapshot
 * @returns {string}
 */
export function serializeSnapshot(snapshot) {
  return `${JSON.stringify(sortKeysDeep(snapshot), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** Keys present in `a` but not in `b`, ascending. */
function onlyIn(a, b) {
  return [...a].filter((key) => !b.has(key)).sort();
}

/** Flatten `wire` to `shape.field -> type` — a field is the unit a diff reports. */
function wireFacets(wire) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const entry of wire ?? []) {
    for (const [field, type] of Object.entries(entry.fields ?? {})) {
      out.set(`${entry.shape}.${field}`, type);
    }
  }
  return out;
}

/**
 * Flatten one frozen schema to `path -> <json>` leaves, so a diff can name the
 * exact facet that moved: `task_move.to.type`, `task_move.to.enum`,
 * `task_list.status.anyOf[0].type`, `task_list.status.anyOf[1].items.type`.
 *
 * `properties` and `anyOf` are descended into (their names are part of the path);
 * every other value is a leaf, serialised so an enum reads as `["a","b"]`.
 */
function flattenSchema(prefix, fragment, out) {
  if (fragment === null || typeof fragment !== "object") {
    out.set(prefix, JSON.stringify(fragment));
    return;
  }
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [property, sub] of Object.entries(value)) flattenSchema(`${prefix}.${property}`, sub, out);
    } else if (key === "anyOf" && Array.isArray(value)) {
      value.forEach((branch, index) => flattenSchema(`${prefix}[${index}]`, branch, out));
    } else if (key === "items") {
      flattenSchema(`${prefix}.items`, value, out);
    } else {
      out.set(`${prefix}.${key}`, JSON.stringify(value));
    }
  }
}

/**
 * Every frozen facet of every tool, keyed `tool.path`. The tool name is part of
 * the key so a facet is attributable without a second lookup.
 */
function schemaFacets(tools) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const tool of tools ?? []) {
    /** @type {Map<string, string>} */
    const flat = new Map();
    flattenSchema(tool.name, tool.schema ?? {}, flat);
    for (const [key, value] of flat) out.set(key, value);
  }
  return out;
}

/**
 * Every frozen facet of every route's declared request, keyed
 * `METHOD /path.query.…` / `METHOD /path.body.…`. The route is part of the key so
 * a facet is attributable without a second lookup, and the `query`/`body` split is
 * in the path so a field that moves between them is a change, not a coincidence.
 *
 * A route with no declaration on a side contributes nothing — the route's
 * appearance or disappearance is already reported as one `route_*` line, and the
 * facets are diffed only for routes present on both sides.
 */
function routeRequestFacets(routes) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const route of routes ?? []) {
    const prefix = `${route.method} ${route.path}`;
    /** @type {Map<string, string>} */
    const flat = new Map();
    if (route.request?.query !== null && route.request?.query !== undefined) {
      flattenSchema(`${prefix}.query`, route.request.query, flat);
    }
    if (route.request?.body !== null && route.request?.body !== undefined) {
      flattenSchema(`${prefix}.body`, route.request.body, flat);
    }
    for (const [key, value] of flat) out.set(key, value);
  }
  return out;
}

/**
 * Compare two facet maps and report every added, removed or changed leaf. A
 * changed value (a type that moved, an enum that gained a value) is reported
 * once as `changed`, not as an add plus a remove.
 */
function diffFacets(add, kinds, actual, expected) {
  for (const key of [...new Set([...actual.keys(), ...expected.keys()])].sort()) {
    const now = actual.get(key);
    const before = expected.get(key);
    if (now === undefined) add(kinds.removed, `${key} = ${before}`);
    else if (before === undefined) add(kinds.added, `${key} = ${now}`);
    else if (now !== before) add(kinds.changed, `${key}: ${before} -> ${now}`);
  }
}

/**
 * Every way `actual` (the live surface) differs from `expected` (the committed
 * snapshot). Pure, so the red→green test can drive it without touching `src/`.
 *
 * @param {object} actual
 * @param {object} expected
 * @returns {{ok: boolean, changes: {kind: string, detail: string}[]}}
 */
export function diffSnapshots(actual, expected) {
  /** @type {{kind: string, detail: string}[]} */
  const changes = [];
  const add = (kind, detail) => changes.push({ kind, detail });

  if (actual?.schema_version !== expected?.schema_version) {
    add("schema_version", `${expected?.schema_version ?? "?"} -> ${actual?.schema_version ?? "?"}`);
  }

  const routeKey = (route) => `${route.method} ${route.path}`;
  const expectedRoutes = new Set((expected?.routes ?? []).map(routeKey));
  const actualRoutes = new Set((actual?.routes ?? []).map(routeKey));
  for (const key of onlyIn(actualRoutes, expectedRoutes)) add("route_added", key);
  for (const key of onlyIn(expectedRoutes, actualRoutes)) add("route_removed", key);

  // Then the request shape of the routes present on *both* sides — the same
  // reasoning as the MCP tools below: a new route reports one line, not one line
  // per facet it happens to declare.
  const sharedRoutes = new Set([...actualRoutes].filter((key) => expectedRoutes.has(key)));
  const keepSharedRoutes = (routes) => (routes ?? []).filter((route) => sharedRoutes.has(routeKey(route)));
  diffFacets(
    add,
    { added: "route_request_added", removed: "route_request_removed", changed: "route_request_changed" },
    routeRequestFacets(keepSharedRoutes(actual?.routes)),
    routeRequestFacets(keepSharedRoutes(expected?.routes)),
  );

  const errorKey = (error) => `${error.code} (HTTP ${error.http})`;
  const expectedErrors = new Set((expected?.errors ?? []).map(errorKey));
  const actualErrors = new Set((actual?.errors ?? []).map(errorKey));
  for (const key of onlyIn(actualErrors, expectedErrors)) add("error_added", key);
  for (const key of onlyIn(expectedErrors, actualErrors)) add("error_removed", key);

  diffFacets(
    add,
    { added: "wire_field_added", removed: "wire_field_removed", changed: "wire_type_changed" },
    wireFacets(actual?.wire),
    wireFacets(expected?.wire),
  );

  // Tools first, by name: a tool appearing or disappearing is one line. Then the
  // schema facets of the tools present on *both* sides — otherwise a new tool
  // would report every one of its facets as an addition on top of the one line.
  const expectedNames = new Set((expected?.mcp_tools ?? []).map((tool) => tool.name));
  const actualNames = new Set((actual?.mcp_tools ?? []).map((tool) => tool.name));
  for (const name of onlyIn(actualNames, expectedNames)) add("mcp_tool_added", name);
  for (const name of onlyIn(expectedNames, actualNames)) add("mcp_tool_removed", name);

  const shared = new Set([...actualNames].filter((name) => expectedNames.has(name)));
  const keepShared = (tools) => (tools ?? []).filter((tool) => shared.has(tool.name));
  diffFacets(
    add,
    { added: "mcp_schema_added", removed: "mcp_schema_removed", changed: "mcp_schema_changed" },
    schemaFacets(keepShared(actual?.mcp_tools)),
    schemaFacets(keepShared(expected?.mcp_tools)),
  );

  return { ok: changes.length === 0, changes };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Read the committed snapshot. Never throws for a bad file: a missing,
 * unparseable or non-object snapshot comes back `{ok: false}` so the caller can
 * pick an exit code.
 *
 * @param {string} [base] tree root
 * @param {string} [file] snapshot path, relative to `base`
 * @returns {Promise<{ok: true, path: string, snapshot: object, text: string} | {ok: false, path: string, error: string}>}
 */
export async function readSnapshot(base = ROOT, file = SNAPSHOT_FILE) {
  const path = join(base, file);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const why = err !== null && err.code === "ENOENT" ? "file not found" : err.message;
    return { ok: false, path, error: `${file}: ${why}` };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    return { ok: false, path, error: `${file}: not valid JSON (${err.message})` };
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, path, error: `${file}: expected a JSON object` };
  }
  return { ok: true, path, snapshot, text: raw };
}

/**
 * Compare the live surface against the committed snapshot.
 *
 * @param {{base?: string, file?: string, snapshot?: object}} [options] `snapshot`
 *   overrides the live build (the tests pass a mutated one to simulate a change).
 * @returns {Promise<{ok: boolean, kind: "match"|"drift"|"read", path: string, error?: string, changes?: object[], snapshot?: object}>}
 */
export async function checkContract(options = {}) {
  const { base = ROOT, file = SNAPSHOT_FILE, snapshot = buildSnapshot() } = options;

  const read = await readSnapshot(base, file);
  if (!read.ok) return { ok: false, kind: "read", path: read.path, error: read.error };

  const diff = diffSnapshots(snapshot, read.snapshot);
  const changes = [...diff.changes];
  // Determinism, enforced rather than assumed: a semantically-equal file that
  // was re-ordered or re-indented by hand is still a snapshot nobody can diff,
  // so it counts as drift until it is regenerated. Checked only when the shapes
  // already agree — otherwise every field would be reported twice.
  if (diff.ok && serializeSnapshot(read.snapshot) !== read.text) {
    changes.push({
      kind: "format",
      detail: "not in canonical form (unsorted keys, changed whitespace or a missing final newline)",
    });
  }

  return {
    ok: changes.length === 0,
    kind: changes.length === 0 ? "match" : "drift",
    path: read.path,
    changes,
    snapshot,
  };
}

/**
 * Write the live surface to the snapshot path, creating its directory.
 *
 * @param {{base?: string, file?: string, snapshot?: object}} [options]
 * @returns {Promise<{path: string, snapshot: object, text: string}>}
 */
export async function updateContract(options = {}) {
  const { base = ROOT, file = SNAPSHOT_FILE, snapshot = buildSnapshot() } = options;
  const path = join(base, file);
  const text = serializeSnapshot(snapshot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  return { path, snapshot, text };
}

/** A one-line summary of a snapshot's size, for the CLI's success output. */
function describe(snapshot) {
  const wireFields = (snapshot.wire ?? []).reduce(
    (total, entry) => total + Object.keys(entry.fields ?? {}).length,
    0,
  );
  return (
    `${(snapshot.routes ?? []).length} routes ` +
    `(${routeRequestFacets(snapshot.routes).size} request facets), ` +
    `${(snapshot.errors ?? []).length} error codes, ` +
    `${wireFields} wire fields, ` +
    `${(snapshot.mcp_tools ?? []).length} MCP tools ` +
    `(${schemaFacets(snapshot.mcp_tools).size} schema facets)`
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      file: { type: "string" },
      update: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/contract.mjs [--update | --print] [--base <dir>] [--file <name>]\n\n" +
        "  --update       rewrite the committed snapshot from the live surface\n" +
        "  --print        print the live snapshot to stdout (nothing is written)\n" +
        "  --base <dir>   the tree to compare against (default: this checkout)\n" +
        "  --file <name>  the snapshot path (default: test/fixtures/contract/api.snapshot.json)\n\n" +
        "Exit: 0 matches · 1 drift (the API changed; run --update if intended) · 2 usage or unreadable snapshot\n",
    );
    return 0;
  }

  const base = values.base === undefined ? ROOT : resolve(values.base);
  const options = values.file === undefined ? { base } : { base, file: values.file };

  if (values.print) {
    process.stdout.write(serializeSnapshot(buildSnapshot()));
    return 0;
  }

  if (values.update) {
    const result = await updateContract(options);
    process.stdout.write(`contract: UPDATED — ${describe(result.snapshot)} → ${result.path}\n`);
    return 0;
  }

  const result = await checkContract(options);

  if (result.kind === "read") {
    process.stderr.write(`contract: FAILED — ${result.error}\n`);
    process.stderr.write("contract: write the snapshot with: node scripts/verify/contract.mjs --update\n");
    return 2;
  }

  if (!result.ok) {
    process.stderr.write(`contract: FAILED — ${result.changes.length} change(s) vs ${result.path}\n`);
    for (const change of result.changes) process.stderr.write(`  [${change.kind}] ${change.detail}\n`);
    process.stderr.write(
      "contract: the API moved. If that is intended, refresh the snapshot and commit it:\n" +
        "  node scripts/verify/contract.mjs --update\n",
    );
    return 1;
  }

  process.stdout.write(`contract: OK — ${describe(result.snapshot)} (${result.path})\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
