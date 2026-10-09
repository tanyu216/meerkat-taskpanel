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
 *      dropped, a file re-ordered — and asserts the drift is reported. This is
 *      the red→green contract of the card, and it runs without editing `src/`.
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
import { ERROR_CODES } from "../../src/shared/errors.mjs";
import {
  ROOT,
  SCHEMA_VERSION,
  SNAPSHOT_FILE,
  buildSnapshot,
  checkContract,
  collectRoutes,
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
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-contract-"));
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
      task.fields = task.fields.filter((field) => field !== "identifier");
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.changes.map((change) => `${change.kind} ${change.detail}`),
      ["wire_field_removed task.identifier"],
    );
  });

  it("reports an MCP tool whose arguments changed", async () => {
    const dir = await makeTree();
    await writeSnapshot(dir, serializeSnapshot(buildSnapshot()));

    const live = mutate(buildSnapshot(), (snapshot) => {
      const tool = snapshot.mcp_tools.find((entry) => entry.name === "task_get");
      tool.arguments.push("include_archived");
    });

    const result = await checkContract({ base: dir, snapshot: live });
    assert.equal(result.ok, false);
    assert.ok(result.changes.some((change) => change.kind === "mcp_tool_removed"));

    const green = await checkContract({ base: dir, snapshot: buildSnapshot() });
    assert.equal(green.ok, true, JSON.stringify(green.changes));
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
