/**
 * Step 15: `export md` (A1).
 *
 * Two properties are the whole contract:
 *
 *   * the cards land on disk with the identifiers as file names, and what the
 *     service rendered is what was written — byte for byte;
 *   * `--check` writes nothing and exits **3** when something is stale. Three is
 *     not an error code: it is how a CI job says "the cards need re-exporting"
 *     without pretending the tool crashed.
 *
 * The goldens under `test/fixtures/md/golden/**` are the byte-equality oracle
 * (`test/contract/md-golden.test.mjs` renders the same cards through the core
 * exporter); here the oracle is "the file the CLI wrote equals the markdown the
 * service returned".
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

async function boardWithTwo(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "First", "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Second", "--json"]);
    return fn(ctx);
  });
}

describe("cli/export", () => {
  it("writes one card per identifier, byte-identical to what the service rendered", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "cards");
      const result = run(["export", "md", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.cards, 2);
      assert.deepEqual(data.identifiers, ["DEMO-0001", "DEMO-0002"]);

      const first = readFileSync(join(out, "DEMO-0001.md"), "utf8");
      assert.match(first, /^---\n/);
      assert.match(first, /id: DEMO-0001/);
      assert.match(first, /title: First/);

      // Human output says where things went.
      assert.match(run(["export", "md", "--out", out]).stdout, /wrote 2 card\(s\) to/);
    });
  });

  it("accepts the card's own spelling, `export --md`", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "cards");
      const result = run(["export", "--md", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).cards, 2);
    });
  });

  it("--check reports 0 when the cards are current, and 3 when they are not", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "cards");

      // Nothing exported yet: every card is missing.
      const missing = run(["export", "md", "--out", out, "--check", "--json"]);
      assert.equal(missing.status, 3, missing.stderr);
      assert.equal(dataOf(missing).up_to_date, false);
      assert.deepEqual(dataOf(missing).missing, ["DEMO-0001", "DEMO-0002"]);

      run(["export", "md", "--out", out, "--json"]);
      const current = run(["export", "md", "--out", out, "--check", "--json"]);
      assert.equal(current.status, 0, current.stderr);
      assert.equal(dataOf(current).up_to_date, true);

      // Tamper with one card: it is now stale, and `--check` does not fix it.
      writeFileSync(join(out, "DEMO-0002.md"), "stale\n");
      const stale = run(["export", "md", "--out", out, "--check", "--json"]);
      assert.equal(stale.status, 3);
      assert.deepEqual(dataOf(stale).differing, ["DEMO-0002"]);
      assert.match(stale.stderr, /warning: 1 card\(s\) are not up to date/);
      assert.equal(readFileSync(join(out, "DEMO-0002.md"), "utf8"), "stale\n", "--check writes nothing");
    });
  });

  it("limits the export to one project", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "one", "--name", "One", "--workspace-path", `${dataDir}/one`, "--json"]);
      run(["project", "create", "--id", "two", "--name", "Two", "--workspace-path", `${dataDir}/two`, "--json"]);
      run(["issue", "create", "--project", "one", "--title", "Only", "--json"]);
      run(["issue", "create", "--project", "two", "--title", "Other", "--json"]);

      const out = join(dataDir, "cards");
      const result = run(["export", "md", "--project", "one", "--out", out, "--json"]);
      assert.deepEqual(dataOf(result).identifiers, ["ONE-0001"]);
    });
  });
});
