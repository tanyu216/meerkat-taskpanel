/**
 * Tests for `scripts/verify/contract.mjs` — the API contract snapshot.
 *
 * Two questions, and the suite is split along them:
 *
 *   1. **Does the committed snapshot still describe this tree?** That is the
 *      guard itself: `buildSnapshot()` reads the real server router, the real
 *      `ERROR_CODES`, the real wire projections and the real MCP tool table, and
 *      the first describe block fails the moment any of them moves without the
 *      snapshot being regenerated.
 *
 *   2. **Would it actually catch a change?** A guard that never went red proves
 *      nothing, so the second block feeds `diffSnapshots` / `checkContract`
 *      *mutated* snapshots — a route added, an error status changed, a wire field
 *      dropped or **retyped**, an MCP argument's **type or enum** moved, a file
 *      re-ordered — and asserts the drift is reported. This is the red→green
 *      contract of the card, and it runs without editing `src/`.
 *
 * The committed snapshot is read from a temp tree in the drift cases, so the
 * suite never writes to the checkout.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import { TOOLS } from "../../src/mcp/registry.mjs";
import { registerApiRoutes } from "../../src/server/index.mjs";
import { createRouter } from "../../src/server/router.mjs";
import { ERROR_CODES } from "../../src/shared/errors.mjs";
import {
  ROOT,
  SCHEMA_VERSION,
  SNAPSHOT_FILE,
  buildSnapshot,
  canonicalSchema,
  checkContract,
  collectMcpTools,
  collectRoutes,
  collectWire,
  diffSnapshots,
  readSnapshot,
  serializeSnapshot,
  updateContract,
} from "../../scripts/verify/contract.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "contract.mjs");
const COMMITTED = join(ROOT, SNAPSHOT_FILE);
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "taskpanel-contract-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a snapshot tree at the checker's conventional path. */
async function writeSnapshot(dir, text) {
  const file = join(dir, SNAPSHOT_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

/** Run the CLI and return {status, stdout, stderr}. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A structured clone of `snapshot`, mutated by `fn` — the "what changed" input. */
function mutate(snapshot, fn) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  fn(copy);
  return copy;
}

describe("contract.mjs — the committed snapshot describes this tree", () => {
  it("matches the live surface", async () => {
    const result = await checkContract({ base: ROOT });
    assert.equal(result.ok, true, JSON.stringify(result.changes, null, 2));
    assert.equal(result.kind, "match");
  });

  it("is byte-identical to what the generator prints", async () => {
    const printed = runCli(["--print"]);
    assert.equal(printed.status, 0, printed.stderr);
    const committed = await readFile(COMMITTED, "utf8");
    assert.equal(printed.stdout, committed, "the committed file is the canonical serialisation");
  });

  it("is deterministic across builds (sorted keys, stable order)", () => {
    const first = serializeSnapshot(buildSnapshot());
    const second = serializeSnapshot(buildSnapshot());
    assert.equal(first, second);

    const parsed = JSON.parse(first);
    const topLevel = Object.keys(parsed);
    assert.deepEqual(topLevel, [...topLevel].sort(), "top-level keys are sorted");
  });

  it("carries the current schema version and one section per contract", () => {
    const snapshot = buildSnapshot();
    assert.equal(snapshot.schema_version, SCHEMA_VERSION);
    assert.ok(snapshot.routes.length > 0);
    assert.equal(snapshot.errors.length, Object.keys(ERROR_CODES).length);
    assert.equal(snapshot.mcp_tools.length, TOOLS.length);
    assert.ok(snapshot.wire.length > 0);
  });

  it("lists the endpoints served outside the JSON router as well", () => {
    const routes = collectRoutes().map((route) => `${route.method} ${route.path}`);
    for (const path of ["GET /health", "GET /meta", "GET /api/v1/events"]) {
      assert.ok(routes.includes(path), `${path} is in the snapshot`);
    }
  });

  it("freezes a type for every wire field, not just its name", () => {
    const task = collectWire().find((entry) => entry.shape === "task");
    assert.equal(task.fields.title, "string");
    assert.equal(task.fields.version, "number");
    assert.equal(task.fields.labels, "array");
    assert.equal(task.fields.meta, "object");
    // Every field carries a type from the JSON alphabet — no `undefined` slips in.
    const alphabet = new Set(["string", "number", "boolean", "object", "array", "null"]);
    for (const entry of collectWire()) {
      for (const [field, type] of Object.entries(entry.fields)) {
        assert.ok(alphabet.has(type), `${entry.shape}.${field} has a type (${type})`);
      }
    }
  });

  it("freezes each MCP tool's schema down to type/enum/items, never its prose", () => {
    const create = collectMcpTools().find((tool) => tool.name === "task_create");
    assert.equal(create.schema.type, "object");
    assert.equal(create.schema.additionalProperties, false);
    assert.equal(create.schema.properties.title.type, "string");
    assert.deepEqual(create.schema.properties.priority.enum, ["high", "low", "medium", "urgent"]);
    assert.deepEqual(create.schema.properties.labels.items, { type: "string" });
    assert.ok(!("description" in create.schema.properties.title), "descriptions are prose — dropped");

    // The union on `task_list.status` survives, enums and all.
    const list = collectMcpTools().find((tool) => tool.name === "task_list");
    assert.equal(list.schema.properties.status.anyOf.length, 2);
    assert.equal(list.schema.properties.status.anyOf[1].type, "array");
    assert.ok(list.schema.properties.status.anyOf[1].items.enum.includes("in_review"));

    // The canonical form is deterministic: same input, same bytes.
    assert.deepEqual(collectMcpTools(), collectMcpTools());
  });

  it("sorts enums and keys, so a reordered source is not a contract change", () => {
    const frozen = canonicalSchema({
      type: "object",
      properties: { z: { type: "string", enum: ["b", "a"], description: "prose" }, a: { type: "integer" } },
      required: ["z", "a"],
    });
    assert.deepEqual(Object.keys(frozen.properties), ["a", "z"]);
    assert.deepEqual(frozen.properties.z.enum, ["a", "b"]);
    assert.deepEqual(frozen.required, ["a", "z"]);
    assert.equal(frozen.properties.z.description, undefined);
  });

  it("has no route request schema to freeze — the premise the snapshot rests on", () => {
    // The card asks for route `query`/`body` shapes frozen *if there is a schema
    // source*. There is none: the router records `{method, pattern, handler}` and
    // handlers read `query.get(...)` / `body.…` ad hoc. This test pins that fact —
    // the day a route grows a declared request schema, it fails and the snapshot
    // must start reading it.
    const router = createRouter();
    registerApiRoutes(router, { board: { commands: {}, repos: {} }, token: null });
    assert.ok(router.routes.length > 0);
    for (const route of router.routes) {
      assert.deepEqual(
        Object.keys(route).sort(),
        ["handler", "method", "pattern", "segments"],
        `${route.method} ${route.pattern} declares only a method, a path and a handler`,
      );
    }
  });
});

describe("contract.mjs — drift is caught (red → green)", () => {
  it("reports a route that was added without a snapshot update", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.routes.push({ method: "POST", path: "/api/v1/tasks/:ref/split" });
      snapshot.routes.sort((a, b) => (a.path < b.path ? -1 : 1));
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "drift");
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ["route_added POST /api/v1/tasks/:ref/split"],
    );
  });

  it("reports a route that was renamed (removed from the live surface)", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.routes = snapshot.routes.filter((route) => route.path !== "/api/v1/tasks/:ref/deliver");
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.ok(
      result.changes.some((change) => change.kind === "route_removed" && change.detail === "POST /api/v1/tasks/:ref/deliver"),
      JSON.stringify(result.changes),
    );
  });

  it("reports an error code whose HTTP status moved", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.errors.find((error) => error.code === "REPORT_REQUIRED").http = 409;
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.ok(result.changes.some((c) => c.kind === "error_added" && c.detail === "REPORT_REQUIRED (HTTP 409)"));
    assert.ok(result.changes.some((c) => c.kind === "error_removed" && c.detail === "REPORT_REQUIRED (HTTP 422)"));
  });

  it("reports a wire field dropped from a projection", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      const task = snapshot.wire.find((entry) => entry.shape === "task");
      delete task.fields.identifier;
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ["wire_field_removed task.identifier = string"],
    );
  });

  it("reports a wire field whose type changed", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.wire.find((entry) => entry.shape === "task").fields.version = "string";
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ["wire_type_changed task.version: number -> string"],
    );
  });

  it("reports an MCP tool whose schema gained an argument", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      const tool = snapshot.mcp_tools.find((entry) => entry.name === "task_get");
      tool.schema.properties.include_archived = { type: "boolean" };
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ['mcp_schema_added task_get.include_archived.type = "boolean"'],
    );

    const green = await checkContract({ base: dir, snapshot: buildSnapshot() });
    assert.equal(green.ok, true, JSON.stringify(green.changes));
  });

  it("reports an MCP argument whose type changed", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.mcp_tools.find((entry) => entry.name === "task_get").schema.properties.ref.type = "number";
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ['mcp_schema_changed task_get.ref.type: "string" -> "number"'],
    );
  });

  it("reports an MCP argument whose enum changed", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      // The literal card scenario: a status vocabulary gains a member.
      snapshot.mcp_tools.find((entry) => entry.name === "task_move").schema.properties.to.enum.push("shipped");
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].kind, "mcp_schema_changed");
    assert.match(result.changes[0].detail, /^task_move\.to\.enum: \[.*\] -> \[.*"shipped".*\]$/);
  });

  it("reports an MCP tool that was added or removed as one line, not one per facet", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.mcp_tools.push({ name: "task_split", schema: { type: "object", properties: { ref: { type: "string" } } } });
      snapshot.mcp_tools.sort((a, b) => (a.name < b.name ? -1 : 1));
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ["mcp_tool_added task_split"],
    );
  });

  it("flags a semantically-equal file that is not in canonical form", async () => {
    const dir = await makeTree();
    const snapshot = buildSnapshot();
    // Same data, wrong order: every key reversed, and a 4-space indent.
    const reversed = Object.fromEntries(Object.entries(snapshot).reverse());
    await writeSnapshot(dir, `${JSON.stringify(reversed, null, 4)}\n`);

    const result = await checkContract({ base: dir, snapshot });
    assert.equal(result.ok, false);
    assert.ok(
      result.changes.some((change) => change.kind === "format"),
      JSON.stringify(result.changes),
    );
  });

  it("fails against the repository's own snapshot when a route appears", async () => {
    // The literal card scenario: the API gains a route and the committed snapshot
    // is *not* updated. No temp file — this is the real one under version control.
    const live = mutate(buildSnapshot(), (snapshot) => {
      snapshot.routes.push({ method: "POST", path: "/api/v1/tasks/:ref/split" });
      snapshot.routes.sort((a, b) => (a.path < b.path ? -1 : 1));
    });

    const result = await checkContract({ base: ROOT, snapshot: live });
    assert.equal(result.ok, false, "the guard must go red");
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ["route_added POST /api/v1/tasks/:ref/split"],
    );
  });

  it("diffSnapshots is a pure verdict — equal input is ok, no changes", () => {
    const snapshot = buildSnapshot();
    assert.deepEqual(diffSnapshots(snapshot, snapshot), { ok: true, changes: [] });
  });
});

describe("contract.mjs — the CLI", () => {
  it("exits 0 when a tree matches", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /contract: OK —/);
  });

  it("exits 1 and names the drift against a stale snapshot", async () => {
    const dir = await makeTree();
    const stale = mutate(buildSnapshot(), (snapshot) => {
      snapshot.routes.push({ method: "GET", path: "/api/v1/experimental" });
    });
    await writeSnapshot(dir, serializeSnapshot(stale));

    const result = runCli(["--base", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[route_removed\] GET \/api\/v1\/experimental/);
    assert.match(result.stderr, /--update/);
  });

  it("--update writes the live snapshot, creating its directory", async () => {
    const dir = await makeTree();
    const result = runCli(["--base", dir, "--update"]);
    assert.equal(result.status, 0, result.stderr);

    const written = await readFile(join(dir, SNAPSHOT_FILE), "utf8");
    assert.equal(written, serializeSnapshot(buildSnapshot()));

    // And the freshly written tree now passes.
    assert.equal(runCli(["--base", dir]).status, 0);
  });

  it("exits 1 when an MCP argument's type moved under the snapshot", async () => {
    const dir = await makeTree();
    const stale = mutate(buildSnapshot(), (snapshot) => {
      snapshot.mcp_tools.find((entry) => entry.name === "task_get").schema.properties.ref.type = "number";
    });
    await writeSnapshot(dir, serializeSnapshot(stale));

    const result = runCli(["--base", dir]);
    assert.equal(result.status, 1, "a type change must fail the gate");
    assert.match(result.stderr, /\[mcp_schema_changed\] task_get\.ref\.type: "number" -> "string"/);
  });

  it("exits 1 when an MCP argument's enum moved under the snapshot", async () => {
    const dir = await makeTree();
    const stale = mutate(buildSnapshot(), (snapshot) => {
      snapshot.mcp_tools.find((entry) => entry.name === "task_move").schema.properties.to.enum.push("shipped");
    });
    await writeSnapshot(dir, serializeSnapshot(stale));

    const result = runCli(["--base", dir]);
    assert.equal(result.status, 1, "an enum change must fail the gate");
    assert.match(result.stderr, /\[mcp_schema_changed\] task_move\.to\.enum:/);
  });

  it("exits 2 when the snapshot is missing", async () => {
    const dir = await makeTree();
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /file not found/);
  });

  it("exits 2 when the snapshot is not valid JSON", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, "{ not json");
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid JSON/);
  });
});

describe("contract.mjs — file reading", () => {
  it("readSnapshot reports a missing file without throwing", async () => {
    const dir = await makeTree();
    const result = await readSnapshot(dir, SNAPSHOT_FILE);
    assert.equal(result.ok, false);
    assert.match(result.error, /file not found/);
  });

  it("readSnapshot rejects a JSON array", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, "[]\n");
    const result = await readSnapshot(dir, SNAPSHOT_FILE);
    assert.equal(result.ok, false);
    assert.match(result.error, /expected a JSON object/);
  });

  it("updateContract returns the exact bytes it wrote", async () => {
    const dir = await makeTree();
    const result = await updateContract({ base: dir });
    assert.equal(await readFile(result.path, "utf8"), result.text);
  });
});
