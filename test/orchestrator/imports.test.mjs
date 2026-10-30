/**
 * The moved loop body loads as one graph.
 *
 * This is the cheap first guard for the migration: a bad relative import or a
 * missing moved module fails here, before any behavior test runs.
 */

import assert from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { importedSpecifiers, listModuleFiles, readSource } from "../helpers/source-scan.mjs";
import * as consoleEntry from "../../src/orchestrator/console.mjs";
import * as doctorEntry from "../../src/orchestrator/doctor.mjs";
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
      doctorEntry,
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
    assert.equal(typeof doctorEntry.doctorReport, "function");
    assert.equal(typeof subscribe.runSubscribe, "function");
    assert.equal(typeof session.runSession, "function");
    assert.equal(typeof options.parseArgs, "function");
  });

  it("the loop imports only src/foundation — it speaks to the board through taskctl", () => {
    /* The architectural rule, machine-checked: `src/orchestrator/**` must not reach
     * into `core`, `cli` or `server`. Board discovery, the token and the HTTP surface
     * belong to the `taskctl` process the loop spawns; an import here would quietly
     * give the loop a second way to talk to the board. */
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const ORCHESTRATOR = join(ROOT, "src", "orchestrator");
    const forbidden = ["core", "cli", "server"].map((name) => join(ROOT, "src", name));

    const offenders = [];
    for (const file of listModuleFiles(ORCHESTRATOR)) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        for (const surface of forbidden) {
          if (target === surface || target.startsWith(`${surface}/`)) {
            offenders.push(`${relative(ROOT, file)} → ${specifier}`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [], "the loop must not import a board surface");
  });
});
