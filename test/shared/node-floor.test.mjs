/**
 * The client entry points refuse a too-old runtime, before anything else runs.
 *
 * `src/cli/index.mjs` and `src/mcp/main.mjs` each run `isSupportedNode` as step
 * 0 and `process.exit(2)` with one stderr line when the runtime is below Node 22.
 * The trick is that the running process *is* the runtime, so the only honest way
 * to simulate an old Node is to spawn a real child and lie about
 * `process.versions.node` through a preload — mocking the process boundary, not
 * an internal function.
 *
 * Two invariants matter and are asserted here:
 *
 *   * the message names the right bin and the requirement (`taskctl` / `meerkat-taskpanel-mcp`);
 *   * stdout stays empty on the fatal path — for the MCP server stdout is the
 *     JSON-RPC channel, and a banner on it would wedge the host's session.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE = process.execPath;
const CLI_ENTRY = join(ROOT, "src/cli/index.mjs");
const MCP_ENTRY = join(ROOT, "src/mcp/main.mjs");

/** The version a too-old runtime reports. */
const LOW_NODE = "21.99.9";
const PRELOAD = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${LOW_NODE}"})`;

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** An environment with no board and no permission to start one. */
function boardlessEnv() {
  const dir = makeTempDir("meerkat-taskpanel-node-floor-");
  return {
    TASKD_DATA_DIR: dir,
    TASKD_RUNTIME_POINTER: join(dir, "runtime.json"),
    TASKD_PORT: "0",
    TASKD_NO_AUTOSTART: "1",
  };
}

function runLowNode(entry, args = []) {
  return spawnSync(NODE, ["--import", PRELOAD, entry, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input: "",
    env: { ...process.env, ...boardlessEnv() },
  });
}

describe("CLI entry — the runtime floor", () => {
  it("refuses a too-old Node on --version: exit 2, one stderr line, empty stdout", () => {
    const run = runLowNode(CLI_ENTRY, ["--version"]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /taskctl: Node 22 or newer/);
    assert.equal(run.stdout, "", "the floor message must never reach stdout");
  });

  it("prints the version on a supported Node", () => {
    const run = spawnSync(NODE, [CLI_ENTRY, "--version"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...boardlessEnv() },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "1.0.0\n");
  });
});

describe("MCP entry — the runtime floor", () => {
  it("refuses a too-old Node at stdin EOF: exit 2, empty JSON-RPC stdout", () => {
    const run = runLowNode(MCP_ENTRY, []);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /meerkat-taskpanel-mcp: Node 22 or newer/);
    assert.equal(run.stdout, "", "stdout is the JSON-RPC channel and must stay empty on a fatal start");
  });

  it("exits 0 at stdin EOF on a supported Node", () => {
    const run = spawnSync(NODE, [MCP_ENTRY], {
      cwd: ROOT,
      encoding: "utf8",
      input: "",
      env: { ...process.env, ...boardlessEnv() },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "", "no request, no response — a clean EOF is silent");
  });
});

test("the preload actually overrides the reported version (sanity)", () => {
  const run = spawnSync(NODE, ["--import", PRELOAD, "-e", "process.stdout.write(process.versions.node)"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, LOW_NODE);
});
