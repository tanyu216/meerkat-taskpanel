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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { assertGrowthGuard, planTargets } from "../../src/cli/commands/export.mjs";
import { cleanupTempDirs, dataOf, errorOf, makeTempDir, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

async function boardWithTwo(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
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
      run(["project", "create", "--id", "one", "--name", "One", "--json"]);
      run(["project", "create", "--id", "two", "--name", "Two", "--json"]);
      run(["issue", "create", "--project", "one", "--title", "Only", "--json"]);
      run(["issue", "create", "--project", "two", "--title", "Other", "--json"]);

      const out = join(dataDir, "cards");
      const result = run(["export", "md", "--project", "one", "--out", out, "--json"]);
      assert.deepEqual(dataOf(result).identifiers, ["ONE-0001"]);
    });
  });
});

describe("cli/export — one card, one file", () => {
  it("writes only the named card into a directory", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "single");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).cards, 1);
      assert.deepEqual(dataOf(result).identifiers, ["DEMO-0002"]);
      assert.equal(existsSync(join(out, "DEMO-0002.md")), true);
      assert.equal(existsSync(join(out, "DEMO-0001.md")), false);
      assert.match(run(["export", "md", "DEMO-0002", "--out", out]).stdout, /wrote 1 card\(s\) to/);
    });
  });

  it("writes one file when --out names a .md path", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "one.md");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(dataOf(result).identifiers, ["DEMO-0002"]);
      assert.equal(dataOf(result).out, out);
      assert.match(readFileSync(out, "utf8"), /id: DEMO-0002/);
      assert.equal(existsSync(join(dataDir, "DEMO-0002.md")), false);
      assert.match(run(["export", "md", "DEMO-0002", "--out", out]).stdout, /wrote DEMO-0002 to/);
    });
  });

  it("treats an existing .md directory as a directory, and a .MD path as a file", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const asDir = join(dataDir, "cards.md");
      mkdirSync(asDir, { recursive: true });
      assert.equal(run(["export", "md", "DEMO-0002", "--out", asDir, "--json"]).status, 0);
      assert.equal(existsSync(join(asDir, "DEMO-0002.md")), true);

      const asFile = join(dataDir, "UPPER.MD");
      assert.equal(run(["export", "md", "DEMO-0002", "--out", asFile, "--json"]).status, 0);
      assert.match(readFileSync(asFile, "utf8"), /id: DEMO-0002/);
    });
  });

  it("treats --out .md as a directory when no card is named", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "bundle.md");
      const result = run(["export", "md", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).cards, 2);
      assert.equal(statSync(out).isDirectory(), true);
      assert.equal(existsSync(join(out, "DEMO-0001.md")), true);
      assert.equal(existsSync(join(out, "DEMO-0002.md")), true);
    });
  });

  it("refuses --project with a card ref before touching the board", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "never");
      const result = run(["export", "md", "DEMO-0001", "--project", "demo", "--out", out, "--json"]);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(errorOf(result).code, "CLI_USAGE");
      assert.equal(existsSync(out), false);
    });
  });

  it("checks only the named card", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "check-one");
      const missing = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(missing.status, 3);
      assert.deepEqual(dataOf(missing).missing, ["DEMO-0002"]);

      run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]).status, 0);

      writeFileSync(join(out, "DEMO-0002.md"), "stale\n");
      const stale = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(stale.status, 3);
      assert.deepEqual(dataOf(stale).differing, ["DEMO-0002"]);
      assert.equal(readFileSync(join(out, "DEMO-0002.md"), "utf8"), "stale\n");
      assert.equal(existsSync(join(out, "DEMO-0001.md")), false, "the other card is not checked or written");
    });
  });

  it("checks a single-file target", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "check-one.md");
      assert.equal(run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]).status, 3);
      run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]).status, 0);

      writeFileSync(out, "stale\n");
      const stale = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(stale.status, 3);
      assert.deepEqual(dataOf(stale).differing, ["DEMO-0002"]);
      assert.equal(readFileSync(out, "utf8"), "stale\n");
    });
  });

  it("refuses a single-file target whose parent is missing, for write and check", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "missing", "one.md");
      for (const extra of [[], ["--check"]]) {
        const result = run(["export", "md", "DEMO-0002", "--out", out, ...extra, "--json"]);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(errorOf(result).code, "CLI_USAGE");
      }
      assert.equal(existsSync(join(dataDir, "missing")), false);
    });
  });

  it("keeps the dir-mode --check missing-directory behaviour at exit 3", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "absent");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(result.status, 3);
      assert.deepEqual(dataOf(result).missing, ["DEMO-0002"]);
      assert.equal(existsSync(out), false);
    });
  });

  it("guards an existing file against a >4x rewrite, in both target shapes", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const file = join(dataDir, "guarded.md");
      writeFileSync(file, "x");
      const fileResult = run(["export", "md", "DEMO-0001", "--out", file, "--json"]);
      assert.equal(fileResult.status, 1, fileResult.stderr);
      assert.equal(errorOf(fileResult).code, "MD_GROWTH_GUARD");
      assert.equal(readFileSync(file, "utf8"), "x");

      const dir = join(dataDir, "guarded-dir");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "DEMO-0001.md"), "x");
      const dirResult = run(["export", "md", "DEMO-0001", "--out", dir, "--json"]);
      assert.equal(dirResult.status, 1);
      assert.equal(errorOf(dirResult).code, "MD_GROWTH_GUARD");
      assert.equal(readFileSync(join(dir, "DEMO-0001.md"), "utf8"), "x");
    });
  });

  it("guards the whole-board export too", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "guarded-all");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "DEMO-0001.md"), "x");
      const result = run(["export", "md", "--out", out, "--json"]);
      assert.equal(result.status, 1);
      assert.equal(errorOf(result).code, "MD_GROWTH_GUARD");
      assert.equal(readFileSync(join(out, "DEMO-0001.md"), "utf8"), "x");
    });
  });

  it("exports an archived card by ref", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      run(["issue", "move", "DEMO-0002", "canceled", "--json"]);
      run(["issue", "archive", "DEMO-0002", "--days", "0", "--json"]);
      const out = join(dataDir, "archived");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(out, "DEMO-0002.md"), "utf8"), /id: DEMO-0002/);
    });
  });

  it("plans targets as a pure function, refusing a multi-card file target", () => {
    const card = { identifier: "DEMO-0001", markdown: "x" };
    assert.deepEqual(planTargets([card], { fileMode: true, out: "one.md" }), [
      { card, path: "one.md" },
    ]);
    assert.deepEqual(planTargets([card], { fileMode: false, out: "cards" }), [
      { card, path: join("cards", "DEMO-0001.md") },
    ]);
    assert.throws(
      () => planTargets([card, card], { fileMode: true, out: "one.md" }),
      (err) => err.code === "CLI_IO",
    );
  });

  it("guard helper: exactly 4x passes, above it refuses, an empty file passes", () => {
    const dir = makeTempDir();
    const file = join(dir, "card.md");
    writeFileSync(file, "a".repeat(10));
    assert.doesNotThrow(() => assertGrowthGuard(file, "b".repeat(40)));
    assert.throws(() => assertGrowthGuard(file, "b".repeat(41)), (err) => err.code === "MD_GROWTH_GUARD");
    writeFileSync(file, "");
    assert.doesNotThrow(() => assertGrowthGuard(file, "b".repeat(1000)));
    assert.doesNotThrow(() => assertGrowthGuard(join(dir, "absent.md"), "b".repeat(1000)));
  });
});
