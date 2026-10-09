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
 *                       `/meta`, the SSE stream, attachment bytes);
 *   * **errors**      — every `ERROR_CODES` code with the HTTP status it carries;
 *   * **wire**        — the field names every `*ToWire` projection emits;
 *   * **mcp_tools**   — the MCP tool names with their argument names.
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
 * error codes come from `ERROR_CODES`, the wire fields from the projections
 * themselves, the tools from `TOOLS`. Nothing is a second copy of a list.
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

/** Bumped only when the snapshot's own *schema* changes shape. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Collecting the live surface
// ---------------------------------------------------------------------------

/** Ascending by `path`, then `method` — the snapshot's one route order. */
function compareRoute(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.method < b.method ? -1 : 1;
}

/**
 * Every `METHOD /path` the daemon answers.
 *
 * The router routes are *enumerated* by registering them against a stub: the
 * `register*Routes` functions only push `{method, pattern, handler}` onto the
 * router, so nothing touches a database or a handler. The out-of-router
 * endpoints are declared next to that router in `src/server/index.mjs`.
 *
 * @returns {{method: string, path: string}[]}
 */
export function collectRoutes() {
  const router = createRouter();
  registerApiRoutes(router, { board: { commands: {}, repos: {} }, token: null });

  const rows = router.routes.map((route) => ({ method: route.method, path: route.pattern }));
  for (const endpoint of OUT_OF_ROUTER_ENDPOINTS) {
    rows.push({ method: endpoint.method, path: endpoint.path });
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
 * A task with the two optional object fields populated, so projecting it emits
 * the nested shapes (`assignee`, `reporter`, `report_waiver`) as well as the
 * flat fields. Without these, the nested keys would come back `null` and their
 * field names would be missing from the snapshot.
 */
const PROBE_TASK = Object.freeze({
  assigneeId: "probe-assignee",
  reporterId: "probe-reporter",
  reportWaiverRound: 1,
  reportWaiverReason: "probe",
  reportWaivedAt: "probe-at",
});

/** Sorted own keys of a projected value. */
function fieldsOf(value) {
  return Object.keys(value ?? {}).sort();
}

/**
 * The field names every wire projection emits, one entry per shape.
 *
 * Each projection is called with an empty (or probe) subject: a `*ToWire`
 * function always writes every field, using `null`/`[]` for what the subject
 * lacks, so the *keys* are the contract even when the values are placeholders.
 *
 * @returns {{shape: string, fields: string[]}[]}
 */
export function collectWire() {
  const task = taskToWire(PROBE_TASK, { lookup: PROBE_ACTOR_LOOKUP });
  const shapes = {
    activity: activityToWire({}),
    comment: commentToWire({}),
    dictionary_entry: dictionaryEntryToWire({}),
    label: labelToWire({}),
    project: projectToWire({}),
    relation: relationToWire({}),
    report: reportToWire({}),
    session: sessionToWire({}),
    task,
  };

  const out = [];
  for (const [shape, value] of Object.entries(shapes)) out.push({ shape, fields: fieldsOf(value) });
  // The nested shapes are part of the same contract: a client reads
  // `assignee.display_name`, so that field is as frozen as `task.title`.
  out.push({ shape: "task.assignee", fields: fieldsOf(task.assignee) });
  out.push({ shape: "task.reporter", fields: fieldsOf(task.reporter) });
  out.push({ shape: "task.report_waiver", fields: fieldsOf(task.report_waiver) });

  return out.sort((a, b) => (a.shape < b.shape ? -1 : 1));
}

/**
 * The MCP tool surface: each tool's name, its argument names and which of them
 * are required. Descriptions and schemas are prose — excluded for the same
 * reason the error messages are.
 *
 * @returns {{name: string, arguments: string[], required: string[]}[]}
 */
export function collectMcpTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    arguments: Object.keys(tool.inputSchema?.properties ?? {}).sort(),
    required: [...(tool.inputSchema?.required ?? [])].sort(),
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
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

/** Flatten `wire` to `shape.field` keys — a field is the unit a diff reports. */
function wireKeys(wire) {
  const keys = new Set();
  for (const entry of wire ?? []) {
    for (const field of entry.fields ?? []) keys.add(`${entry.shape}.${field}`);
  }
  return keys;
}

/** One line per MCP tool: the tool and its argument list. */
function toolKeys(tools) {
  return new Set(
    (tools ?? []).map(
      (tool) =>
        `${tool.name}(${(tool.arguments ?? []).join(", ")}) required[${(tool.required ?? []).join(", ")}]`,
    ),
  );
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

  const errorKey = (error) => `${error.code} (HTTP ${error.http})`;
  const expectedErrors = new Set((expected?.errors ?? []).map(errorKey));
  const actualErrors = new Set((actual?.errors ?? []).map(errorKey));
  for (const key of onlyIn(actualErrors, expectedErrors)) add("error_added", key);
  for (const key of onlyIn(expectedErrors, actualErrors)) add("error_removed", key);

  const expectedWire = wireKeys(expected?.wire);
  const actualWire = wireKeys(actual?.wire);
  for (const key of onlyIn(actualWire, expectedWire)) add("wire_field_added", key);
  for (const key of onlyIn(expectedWire, actualWire)) add("wire_field_removed", key);

  const expectedTools = toolKeys(expected?.mcp_tools);
  const actualTools = toolKeys(actual?.mcp_tools);
  for (const key of onlyIn(actualTools, expectedTools)) add("mcp_tool_added", key);
  for (const key of onlyIn(expectedTools, actualTools)) add("mcp_tool_removed", key);

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
  const wireFields = (snapshot.wire ?? []).reduce((total, entry) => total + (entry.fields ?? []).length, 0);
  return (
    `${(snapshot.routes ?? []).length} routes, ` +
    `${(snapshot.errors ?? []).length} error codes, ` +
    `${wireFields} wire fields, ` +
    `${(snapshot.mcp_tools ?? []).length} MCP tools`
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
