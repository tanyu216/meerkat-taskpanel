/**
 * Step 14: the delivery gate and `issue deliver` (A2/A3, V2–V5).
 *
 * This is the milestone's centre of gravity, so it is tested as a *user* meets
 * it — a real CLI process, a real board — and not through the service API:
 *
 *   1. `issue move <id> in_review` with no report fails, non-zero, and prints
 *      the command that fixes it;
 *   2. `issue deliver <id> --report-file -` succeeds and returns a report id,
 *      with the report row and the status change in one transaction;
 *   3. a report from an earlier round does not satisfy the current one;
 *   4. an invalid report is refused with its issues listed, and nothing is
 *      written;
 *   5. the audited waiver (`--no-report --reason`) works, and only with a real
 *      reason, and never together with a report.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

const REPORT = {
  conclusion: "M2 landed: the CLI is a client and the gate is visible.",
  acceptance: [{ text: "cli works", status: "met" }],
  evidence: [{ kind: "commit", sha: "dcd7d15" }],
};

/** A board with a project and one task sitting in `in_progress`, ready to deliver. */
async function readyBoard(fn, { identifier = null } = {}) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Ship M2", "--acceptance", "cli works", "--json"]);
    const ref = identifier ?? "DEMO-0001";
    ctx.run(["issue", "move", ref, "in_progress", "--json"]);
    return fn({ ...ctx, ref });
  });
}

describe("cli/deliver — the gate is visible (case 1)", () => {
  it("refuses the move, exits 1, and prints the exact command that fixes it", async () => {
    await readyBoard(async ({ run }) => {
      const result = run(["issue", "move", "DEMO-0001", "in_review"]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "", "human errors go to stderr");
      assert.match(result.stderr, /^REPORT_REQUIRED: cannot move DEMO-0001 to in_review/);
      assert.match(result.stderr, /round 1/);
      assert.match(result.stderr, /rounds on file: none/);
      assert.match(result.stderr, /try: taskctl issue deliver DEMO-0001 --report-file -/);
      assert.match(result.stderr, /or: taskctl issue move DEMO-0001 in_review --no-report --reason/);
    });
  });

  it("says the same thing in --json, as a stable error code", async () => {
    await readyBoard(async ({ run }) => {
      const result = run(["issue", "move", "DEMO-0001", "in_review", "--json"]);
      assert.equal(result.status, 1);
      const error = errorOf(result);
      assert.equal(error.code, "REPORT_REQUIRED");
      assert.equal(error.http, 422);
      assert.equal(error.details.round, 1);
      assert.deepEqual(error.details.existingRounds, []);
      assert.equal(error.hint.command, "taskctl issue deliver DEMO-0001 --report-file -");
    });
  });

  it("writes nothing when it refuses: no report row, no revision bump", async () => {
    await readyBoard(async ({ run }) => {
      const before = dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.version;
      run(["issue", "move", "DEMO-0001", "in_review", "--json"]);

      const after_ = dataOf(run(["issue", "get", "DEMO-0001", "--json"]));
      assert.equal(after_.task.status, "in_progress");
      assert.equal(after_.task.version, before, "a refused move is not a write");
      assert.equal(after_.task.report_latest_id, null);
      const reports = dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.report_latest_id;
      assert.equal(reports, null);
    });
  });
});

describe("cli/deliver — the compliant path (case 2)", () => {
  it("delivers from stdin, atomically, and returns the report id", async () => {
    await readyBoard(async ({ run }) => {
      const result = run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], {
        input: JSON.stringify(REPORT),
      });
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.status, "in_review");
      assert.equal(typeof data.report_id, "number");
      assert.equal(data.task.status, "in_review");
      assert.equal(data.task.report_latest_id, data.report_id);
      assert.equal(data.task.delivery_round, 1, "delivering does not start a new round");
      assert.equal(data.waived, false);

      const report = dataOf(run(["issue", "get", "DEMO-0001", "--json"]));
      assert.equal(report.task.status, "in_review");
      assert.equal(report.report_waivers.length, 0);
    });
  });

  it("reads the report from a file too, and prints a one-line confirmation", async () => {
    await readyBoard(async ({ run, dataDir }) => {
      const fs = await import("node:fs");
      const file = `${dataDir}/report.json`;
      fs.writeFileSync(file, JSON.stringify(REPORT));
      const human = run(["issue", "deliver", "DEMO-0001", "--report-file", file]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /delivered DEMO-0001 → in_review \(report #\d+, round 1\)/);
    });
  });

  it("accepts what `report template` produces, warning about the TODOs", async () => {
    await readyBoard(async ({ run }) => {
      const template = dataOf(run(["report", "template", "DEMO-0001", "--commit", "dcd7d15", "--json"]));
      const delivered = run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], {
        input: JSON.stringify(template.report),
      });
      assert.equal(delivered.status, 0, delivered.stderr);
      assert.match(delivered.stderr, /warning: delivering a template that still contains TODO placeholders/);
    });
  });
});

describe("cli/deliver — rounds do not leak (case 3)", () => {
  it("refuses a stale round and accepts a fresh report", async () => {
    await readyBoard(async ({ run }) => {
      // Round 1: deliver, then send it back for rework — which starts round 2.
      const first = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], { input: JSON.stringify(REPORT) }),
      );
      assert.equal(first.round, 1);

      const rework = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      assert.equal(rework.task.delivery_round, 2);

      // Round 1's report is history now, and the gate says so.
      const stale = run(["issue", "move", "DEMO-0001", "in_review", "--json"]);
      assert.equal(stale.status, 1);
      const error = errorOf(stale);
      assert.equal(error.code, "REPORT_REQUIRED");
      assert.equal(error.details.round, 2);
      assert.deepEqual(error.details.existingRounds, [1], "round 1 is on file, and does not count");

      // A report that *claims* round 1 is refused by name.
      const wrong = run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], {
        input: JSON.stringify({ ...REPORT, round: 1 }),
      });
      assert.equal(wrong.status, 1);
      assert.equal(errorOf(wrong).code, "REPORT_ROUND_MISMATCH");

      // A fresh report for round 2 delivers.
      const second = dataOf(
        run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], { input: JSON.stringify(REPORT) }),
      );
      assert.equal(second.round, 2);
      assert.equal(second.status, "in_review");
    });
  });
});

describe("cli/deliver — a bad report costs nothing (case 4)", () => {
  it("lists every issue and leaves the task untouched", async () => {
    await readyBoard(async ({ run }) => {
      const before = dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.version;

      const bad = run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], {
        input: JSON.stringify({ conclusion: "", acceptance: [], evidence: [] }),
      });
      assert.equal(bad.status, 1);
      const error = errorOf(bad);
      assert.equal(error.code, "REPORT_INVALID");
      assert.ok(Array.isArray(error.details.issues));
      assert.ok(error.details.issues.length >= 3, JSON.stringify(error.details.issues));

      const human = run(["issue", "deliver", "DEMO-0001", "--report-file", "-"], {
        input: JSON.stringify({ conclusion: "", acceptance: [], evidence: [] }),
      });
      assert.match(human.stderr, /REPORT_INVALID: /);
      for (const issue of error.details.issues) {
        assert.match(human.stderr, new RegExp(issue.path.replace(/[[\]]/g, "\\$&").replace(/\./g, "\\.")));
      }

      const after_ = dataOf(run(["issue", "get", "DEMO-0001", "--json"]));
      assert.equal(after_.task.status, "in_progress");
      assert.equal(after_.task.version, before, "nothing was written, so nothing bumped");
      assert.equal(after_.task.report_latest_id, null);
    });
  });

  it("names a report file that is not JSON, and does not contact the board", async () => {
    await readyBoard(async ({ run }) => {
      const result = run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], {
        input: "{not json",
      });
      assert.equal(result.status, 1);
      assert.equal(errorOf(result).code, "CLI_IO");
      assert.match(errorOf(result).message, /not valid JSON/);
    });
  });
});

describe("cli/deliver — the audited waiver (case 5, F-B1)", () => {
  const REASON = "hotfix: report follows in a change comment";

  it("delivers without a report, records report_waived, and warns on stderr", async () => {
    await readyBoard(async ({ run }) => {
      const result = run(["issue", "move", "DEMO-0001", "in_review", "--no-report", "--reason", REASON, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /warning: delivered without a report; recorded as report_waived round 1/);

      const data = dataOf(result);
      assert.equal(data.task.status, "in_review");
      assert.equal(data.task.report_latest_id, null, "a waiver writes no report");
      assert.deepEqual(data.task.report_waiver, { round: 1, reason: REASON, waived_at: data.task.report_waiver.waived_at });
      assert.equal(data.report_waivers.length, 1);
      assert.equal(data.report_waivers[0].round, 1);
      assert.equal(data.report_waivers[0].reason, REASON);

      // And it is visible afterwards, which is the whole point of auditing it.
      const later = dataOf(run(["issue", "get", "DEMO-0001", "--json"]));
      assert.equal(later.report_waivers.length, 1);
      assert.match(run(["issue", "get", "DEMO-0001"]).stdout, /waiver\s+round 1: hotfix/);
    });
  });

  it("works through deliver --no-report too", async () => {
    await readyBoard(async ({ run }) => {
      const result = run(["issue", "deliver", "DEMO-0001", "--no-report", "--reason", REASON, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.waived, true);
      assert.equal(data.report_id, null);
      assert.equal(data.round, 1);
    });
  });

  it("refuses a missing or too-short reason, writing nothing", async () => {
    await readyBoard(async ({ run }) => {
      const before = dataOf(run(["issue", "get", "DEMO-0001", "--json"])).task.version;

      for (const extra of [[], ["--reason", ""], ["--reason", "short"], ["--reason", "1234567"]]) {
        const result = run(["issue", "move", "DEMO-0001", "in_review", "--no-report", ...extra, "--json"]);
        assert.equal(result.status, 1, JSON.stringify(extra));
        const error = errorOf(result);
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.equal(error.details.field, "reason");
      }

      const after_ = dataOf(run(["issue", "get", "DEMO-0001", "--json"]));
      assert.equal(after_.task.status, "in_progress");
      assert.equal(after_.task.version, before);
    });
  });

  it("refuses a waiver alongside a report, and a waiver on any other move", async () => {
    await readyBoard(async ({ run }) => {
      const both = run(["issue", "deliver", "DEMO-0001", "--no-report", "--reason", REASON, "--report-file", "-", "--json"], {
        input: JSON.stringify(REPORT),
      });
      assert.equal(both.status, 2, "a mutually exclusive pair is a usage error");
      assert.equal(errorOf(both).code, "CLI_USAGE");
      assert.match(errorOf(both).message, /mutually exclusive/);

      const elsewhere = run(["issue", "move", "DEMO-0001", "blocked", "--no-report", "--reason", REASON, "--json"]);
      assert.equal(elsewhere.status, 1);
      assert.equal(errorOf(elsewhere).code, "VALIDATION_FAILED");

      const neither = run(["issue", "deliver", "DEMO-0001", "--json"]);
      assert.equal(neither.status, 2);
      assert.match(errorOf(neither).message, /--report-file .* is required/);
    });
  });

  it("is spent when the round moves on — exactly like a report", async () => {
    await readyBoard(async ({ run }) => {
      run(["issue", "move", "DEMO-0001", "in_review", "--no-report", "--reason", REASON, "--json"]);
      const rework = dataOf(run(["issue", "move", "DEMO-0001", "in_progress", "--json"]));
      assert.equal(rework.task.delivery_round, 2);

      const stale = run(["issue", "move", "DEMO-0001", "in_review", "--json"]);
      assert.equal(stale.status, 1);
      assert.equal(errorOf(stale).details.round, 2);

      const fresh = run(["issue", "move", "DEMO-0001", "in_review", "--no-report", "--reason", REASON, "--json"]);
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.equal(dataOf(fresh).task.report_waiver.round, 2);
    });
  });
});
