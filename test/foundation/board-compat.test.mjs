/**
 * The board-interface gate, as pure decisions.
 *
 * `taskctl loop compat` is the only implementation: the retired
 * `skills/meerkat-loop/scripts/board-check.mjs` was its private copy. The
 * process boundary (exit codes 0/2/3) is tested in `test/cli/loop.test.mjs`.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  REQUIRED_BOARD_INTERFACE,
  REQUIRED_BOARD_VERSION,
  atLeastVersion,
  checkBoard,
  parseVersion,
  resolveBoardCommand,
} from "../../src/foundation/board-compat.mjs";

/** A `run` that answers from a fixed table. */
const answering = ({ stdout = "", stderr = "", status = 0, error = null }) => () => ({
  status,
  stdout,
  stderr,
  error,
});

describe("board-compat — versions", () => {
  it("parses a plain and a prerelease version", () => {
    assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: false });
    assert.deepEqual(parseVersion("1.2.3-rc.1"), { major: 1, minor: 2, patch: 3, prerelease: true });
    assert.equal(parseVersion("nope"), null);
    assert.equal(parseVersion(undefined), null);
  });

  it("compares the numeric triple, and a prerelease never satisfies the floor", () => {
    assert.equal(atLeastVersion("0.1.0", "0.1.0"), true);
    assert.equal(atLeastVersion("0.1.1", "0.1.0"), true);
    assert.equal(atLeastVersion("2.0.0", "0.1.0"), true);
    assert.equal(atLeastVersion("0.0.9", "0.1.0"), false);
    assert.equal(atLeastVersion("0.1.0-rc.1", "0.1.0"), false);
    assert.equal(atLeastVersion("nope", "0.1.0"), false);
  });

  it("names the interface the loop drives, and the first board that shipped it", () => {
    assert.equal(REQUIRED_BOARD_INTERFACE, "task-interface v1");
    assert.equal(REQUIRED_BOARD_VERSION, "0.1.0");
  });
});

describe("board-compat — checkBoard", () => {
  const command = "/repo/src/cli/index.mjs";
  const args = ["--version", "--json"];

  it("accepts a board at or above the floor", () => {
    const result = checkBoard({
      command,
      args,
      run: answering({ stdout: JSON.stringify({ ok: true, data: { version: "0.1.0", schema_version: 1 } }) }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.version, "0.1.0");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.boardInterface, REQUIRED_BOARD_INTERFACE);
  });

  it("refuses an older board with the code the loop acts on", () => {
    const result = checkBoard({
      command,
      args,
      run: answering({ stdout: JSON.stringify({ ok: true, data: { version: "0.0.9" } }) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BOARD_TOO_OLD");
    assert.match(result.message, /0\.1\.0/);
  });

  it("reports an unreachable CLI, not a version verdict", () => {
    const result = checkBoard({
      command,
      args,
      run: answering({ error: new Error("ENOENT") }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BOARD_UNREACHABLE");
  });

  it("reports an unreadable answer for empty stdout, bad JSON and a missing data.version", () => {
    for (const stdout of ["", "{ not json", JSON.stringify({ ok: true, data: {} })]) {
      const result = checkBoard({ command, args, run: answering({ stdout }) });
      assert.equal(result.ok, false, stdout);
      assert.equal(result.code, "BOARD_UNREADABLE", stdout);
    }
  });
});

describe("board-compat — resolveBoardCommand", () => {
  it("honours --cli verbatim", () => {
    assert.deepEqual(resolveBoardCommand({ cli: "/bin/taskctl" }), {
      command: "/bin/taskctl",
      args: ["--version", "--json"],
    });
  });

  it("prefers --repo, then the env, and runs <root>/src/cli/index.mjs", () => {
    const flagged = resolveBoardCommand({ repo: "/repo", env: { MEERKAT_TASKPANEL_REPO: "/env" }, node: "/opt/node" });
    assert.deepEqual(flagged, {
      command: "/opt/node",
      args: [join("/repo", "src", "cli", "index.mjs"), "--version", "--json"],
    });
    const fromEnv = resolveBoardCommand({ env: { MEERKAT_TASKPANEL_REPO: "/env" }, node: "/opt/node" });
    assert.deepEqual(fromEnv.args, [join("/env", "src", "cli", "index.mjs"), "--version", "--json"]);
  });

  it("falls back to taskctl on PATH", () => {
    assert.deepEqual(resolveBoardCommand({ env: {} }), {
      command: "taskctl",
      args: ["--version", "--json"],
    });
  });
});
