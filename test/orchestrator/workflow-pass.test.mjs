/**
 * `runWorkflowPass` — the board-level glue the executor never sees.
 *
 * The planner and the runner are covered elsewhere; what only this file can
 * assert is the seam `board.mjs` builds around them: which `taskctl` calls the
 * pass makes, and what it says when a card it is accepting has no lane record.
 *
 * The board is a sentinel CLI (no database): every call answers from an argv
 * match, so the assertions are about what the loop did with the answer.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { runWorkflowPass } from "../../src/orchestrator/board.mjs";
import { parseArgs } from "../../src/orchestrator/options.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-workflow-pass-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** An `approve` action, exactly as `workflowToWire` emits it. */
const APPROVE = {
  type: "approve",
  review_status: "in_review",
  review_ref: "PROJ-0002",
  original_ref: "PROJ-0001",
  round: 1,
  close_review: true,
  accepted_by: "loop-review",
};

/** The board answers the reconcile with that one action, and every write with ok. */
function sentinel(dir) {
  const script = join(dir, "sentinel-cli.mjs");
  writeFileSync(
    script,
    [
      "const argv = process.argv.slice(2);",
      `const plan = ${JSON.stringify({
        scanned: 0,
        actions: [],
        workflow: { actions: [APPROVE], alerts: [], changes: [], summary: { actions: 1, alerts: 0 } },
      })};`,
      'if (argv.includes("reconcile")) process.stdout.write(JSON.stringify({ ok: true, data: plan }));',
      'else if (argv.includes("list")) process.stdout.write(JSON.stringify({ ok: true, data: { tasks: [] } }));',
      'else process.stdout.write(JSON.stringify({ ok: true, data: {} }));',
    ].join("\n"),
  );
  return script;
}

function optsFor(dir, script, workspace) {
  return parseArgs(
    [
      "--state", join(dir, "state.json"),
      "--log", join(dir, "supervisor.log"),
      "--config", join(dir, "config.env"),
      "--cli", script,
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
      "--workspace", workspace,
    ],
    { HOME: dir },
  );
}

const CONFIG = {
  workflow: true,
  reviewer: null,
  reviewAgingMs: 60 * 60_000,
  maxActions: 20,
  claimUnassigned: false,
};

async function run(dir, workspace) {
  const logs = [];
  const result = await runWorkflowPass(optsFor(dir, sentinel(dir), workspace), CONFIG, (line) =>
    logs.push(String(line)),
  );
  return { result, logs };
}

describe("runWorkflowPass — an acceptance with no lane record", () => {
  it("says so, and still accepts: the record is evidence, not a gate", async () => {
    const { result, logs } = await run(tempDir(), "worktree");

    assert.equal(result.executed, 1, "the acceptance still runs");
    assert.equal(result.failed, 0);
    assert.ok(
      logs.some((line) => /PROJ-0001 has no lane record/.test(line)),
      `the missing record is announced: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((line) => /done does not imply the branch was merged/.test(line)),
      "the log says what the reader should not conclude",
    );
  });

  it("stays quiet in shared mode, where no lane is expected", async () => {
    const { result, logs } = await run(tempDir(), "shared");

    assert.equal(result.executed, 1);
    assert.equal(
      logs.some((line) => /has no lane record/.test(line)),
      false,
      `shared mode never had a lane to land: ${JSON.stringify(logs)}`,
    );
  });
});
