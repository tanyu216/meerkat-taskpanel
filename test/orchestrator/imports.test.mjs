/**
 * The moved loop body loads as one graph.
 *
 * This is the cheap first guard for the migration: a bad relative import or a
 * missing moved module fails here, before any behavior test runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as consoleEntry from "../../src/orchestrator/console.mjs";
import * as options from "../../src/orchestrator/options.mjs";
import * as passes from "../../src/orchestrator/passes.mjs";
import * as session from "../../src/orchestrator/session.mjs";
import * as status from "../../src/orchestrator/status.mjs";
import * as subscribe from "../../src/orchestrator/subscribe.mjs";
import * as supervisor from "../../src/orchestrator/supervisor.mjs";

describe("orchestrator — the moved loop body", () => {
  it("exports the entries the CLI and the installer call", () => {
    for (const [name, module] of Object.entries({
      passes,
      supervisor,
      status,
      consoleEntry,
      subscribe,
    })) {
      assert.equal(typeof module.main, "function", `${name}.main`);
    }
    assert.equal(typeof passes.runPollOnce, "function");
    assert.equal(typeof passes.runPatrolOnce, "function");
    assert.equal(typeof passes.runWorkflowOnce, "function");
    assert.equal(typeof status.probeSupervisor, "function");
    assert.equal(typeof status.takeOver, "function");
    assert.equal(typeof consoleEntry.consoleCycle, "function");
    assert.equal(typeof subscribe.runSubscribe, "function");
    assert.equal(typeof session.runSession, "function");
    assert.equal(typeof options.parseArgs, "function");
  });
});
