/**
 * `taskctl sla list|get` — the CLI face of the board's SLA read.
 *
 * The loop calls these with `--json`, so the two things worth pinning are the
 * flag→query projection and that the command is a thin client: the numbers it
 * prints are the board's, including an install's `TASKD_SLA_*` override.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, errorOf, makeTempDir, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** A `.env` that makes a just-blocked card alert immediately. */
function zeroBlockedLimitEnv() {
  const file = join(makeTempDir("meerkat-taskpanel-sla-env-"), ".env");
  writeFileSync(
    file,
    [
      "TASKD_SLA_BLOCKED_CLARIFICATION_LIMIT_MIN=0",
      "TASKD_SLA_BLOCKED_CLARIFICATION_FURTHER_MIN=0",
      "",
    ].join("\n"),
  );
  return file;
}

describe("cli/sla", () => {
  it("publishes the board's defaults on an idle board", async () => {
    await withCli(async ({ run }) => {
      const data = dataOf(run(["sla", "list", "--json"]));
      assert.deepEqual(data.alerts, []);
      assert.equal(data.config.period_seconds, 300);
      assert.equal(data.config.rows.blocked_clarification.limit_min, 120);
      assert.equal(data.config.version, 1);
    });
  });

  it("carries an install's TASKD_SLA_* override into the alert", async () => {
    const envFile = zeroBlockedLimitEnv();
    await withCli(
      async ({ run }) => {
        run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
        run(["issue", "create", "--project", "demo", "--title", "T", "--status", "blocked", "--json"]);

        const data = dataOf(run(["sla", "list", "--json"]));
        assert.equal(data.config.rows.blocked_clarification.limit_min, 0);
        const alert = data.alerts.find((entry) => entry.sla_row === "blocked_clarification");
        assert.ok(alert);
        assert.equal(alert.card_id, "DEMO-0001");
        assert.equal(alert.threshold_min, 0);
      },
      { env: { MEERKAT_TASKPANEL_ENV_FILE: envFile } },
    );
  });

  it("projects --period and --leader onto the request", async () => {
    await withCli(async ({ run }) => {
      const data = dataOf(run(["sla", "list", "--period", "600", "--leader", "local", "--json"]));
      assert.equal(data.config.period_seconds, 600);
    });
  });

  it("refuses an out-of-range period at the board, not silently", async () => {
    await withCli(async ({ run }) => {
      const error = errorOf(run(["sla", "list", "--period", "0", "--json"]));
      assert.equal(error.code, "VALIDATION_FAILED");
    });
  });

  it("sla get answers one card and omits the board-level row", async () => {
    const envFile = zeroBlockedLimitEnv();
    await withCli(
      async ({ run }) => {
        run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
        // A worker files the card: a human write would now carry the writer as
        // reporter, making the creation itself the board's newest leader event
        // and putting the stall inside its lead.
        run([
          "issue", "create", "--project", "demo", "--title", "T", "--status", "blocked",
          "--actor-kind", "claude", "--agent", "tester", "--json",
        ]);

        const full = dataOf(run(["sla", "list", "--json"]));
        assert.ok(full.alerts.some((alert) => alert.sla_row === "leader_stalled"));

        const one = dataOf(run(["sla", "get", "DEMO-0001", "--json"]));
        assert.ok(one.alerts.length > 0);
        assert.ok(one.alerts.every((alert) => alert.card_id === "DEMO-0001"));
        assert.equal(one.alerts.some((alert) => alert.sla_row === "leader_stalled"), false);
      },
      { env: { MEERKAT_TASKPANEL_ENV_FILE: envFile } },
    );
  });

  it("renders a table, and says so when there is nothing to report", async () => {
    await withCli(async ({ run }) => {
      assert.match(run(["sla", "list"]).stdout, /no SLA alerts/);
    });
  });
});
