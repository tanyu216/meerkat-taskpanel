/**
 * Tests for `scripts/verify/migrations.mjs` — the append-only migration gate.
 *
 * The rule the pre-commit hook enforces: the SQL migrations under
 * `src/core/storage/migrations/` are numbered contiguously from `0001`, are
 * unique, and an already-committed file may never change. A gap, a duplicate, a
 * silently edited migration or a deleted one is refused before it is committed.
 *
 * `analyzeMigrations` is pure and is exercised directly with in-memory file
 * lists and a fake baseline map — that is the whole point of keeping the git
 * read outside it. The CLI cases run against the real checkout and a temp tree.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  DEFAULT_MIGRATIONS_DIR,
  ROOT,
  analyzeMigrations,
  listMigrationFiles,
} from "../../scripts/verify/migrations.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "migrations.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "taskpanel-migrations-"));
  tempDirs.push(dir);
  return dir;
}

/** `path → sql` written under a temp dir; the path is relative to the dir. */
async function writeMigrations(dir, files) {
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql, "utf8");
  }
}

/** Run the CLI and return {status, stdout, stderr}. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("migrations.mjs — analyzeMigrations (pure)", () => {
  it("passes a contiguous, unique, unmodified set", () => {
    const files = [
      { name: "0001_core.sql", content: "SELECT 1;\n" },
      { name: "0002_more.sql", content: "SELECT 2;\n" },
    ];
    const baseline = new Map([["0001_core.sql", "SELECT 1;\n"]]);
    const result = analyzeMigrations({ files, baseline });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.versions, ["0001", "0002"]);
  });

  it("passes a brand-new migration (not in the baseline)", () => {
    const files = [
      { name: "0001_core.sql", content: "SELECT 1;\n" },
      { name: "0002_new.sql", content: "SELECT 2;\n" },
    ];
    const result = analyzeMigrations({ files, baseline: new Map([["0001_core.sql", "SELECT 1;\n"]]) });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("rejects a sequence gap (0001 then 0003)", () => {
    const files = [
      { name: "0001_core.sql", content: "SELECT 1;\n" },
      { name: "0003_skip.sql", content: "SELECT 3;\n" },
    ];
    const result = analyzeMigrations({ files, baseline: null });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.code === "SEQUENCE_GAP" && e.missing.includes("0002")),
      JSON.stringify(result.errors),
    );
  });

  it("rejects a duplicate version number", () => {
    const files = [
      { name: "0001_core.sql", content: "SELECT 1;\n" },
      { name: "0001_dup.sql", content: "SELECT 1;\n" },
    ];
    const result = analyzeMigrations({ files, baseline: null });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.code === "DUPLICATE_VERSION" && e.version === "0001"),
      JSON.stringify(result.errors),
    );
  });

  it("rejects a set that does not start at 0001", () => {
    const files = [{ name: "0002_second.sql", content: "SELECT 2;\n" }];
    const result = analyzeMigrations({ files, baseline: null });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "SEQUENCE_GAP"));
  });

  it("rejects a migration file whose name does not match NNNN_lower_snake.sql", () => {
    const files = [{ name: "1_bad.sql", content: "SELECT 1;\n" }];
    const result = analyzeMigrations({ files, baseline: null });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "BAD_NAME"), JSON.stringify(result.errors));
  });

  it("rejects an edited already-committed migration (checksum drift)", () => {
    const files = [{ name: "0001_core.sql", content: "SELECT 1; -- edited\n" }];
    const baseline = new Map([["0001_core.sql", "SELECT 1;\n"]]);
    const result = analyzeMigrations({ files, baseline });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.code === "CHECKSUM_DRIFT" && e.name === "0001_core.sql"),
      JSON.stringify(result.errors),
    );
  });

  it("ignores a line-ending-only difference (CRLF vs LF)", () => {
    const files = [{ name: "0001_core.sql", content: "SELECT 1;\r\nSELECT 2;\r\n" }];
    const baseline = new Map([["0001_core.sql", "SELECT 1;\nSELECT 2;\n"]]);
    const result = analyzeMigrations({ files, baseline });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("rejects a deleted already-committed migration", () => {
    const files = [{ name: "0002_more.sql", content: "SELECT 2;\n" }];
    const baseline = new Map([
      ["0001_core.sql", "SELECT 1;\n"],
      ["0002_more.sql", "SELECT 2;\n"],
    ]);
    const result = analyzeMigrations({ files, baseline });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.code === "DELETED" && e.name === "0001_core.sql"),
      JSON.stringify(result.errors),
    );
  });

  it("rejects an empty set", () => {
    const result = analyzeMigrations({ files: [], baseline: null });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "NO_MIGRATIONS"));
  });

  it("skips the baseline checks entirely when baseline is null", () => {
    const files = [{ name: "0001_core.sql", content: "SELECT 1;\n" }];
    const result = analyzeMigrations({ files, baseline: null });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

describe("migrations.mjs — the shipped migrations", () => {
  it("are contiguous, unique and match the committed baseline", async () => {
    const files = await listMigrationFiles(join(ROOT, DEFAULT_MIGRATIONS_DIR));
    assert.ok(files.length > 0);
    const result = analyzeMigrations({ files, baseline: null });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.versions[0], "0001");
    assert.equal(result.versions.at(-1), String(files.length).padStart(4, "0"));
  });

  it("the CLI exits 0 against this checkout", () => {
    const result = runCli([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /migrations: OK/);
  });
});

describe("migrations.mjs — the CLI on a broken tree", () => {
  it("exits 1 and names the missing version on a gap", async () => {
    const dir = await makeTree();
    await writeMigrations(dir, { "0001_a.sql": "SELECT 1;\n", "0003_c.sql": "SELECT 3;\n" });
    const result = runCli(["--dir", dir, "--no-git"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /0002/);
  });

  it("exits 1 on a duplicate", async () => {
    const dir = await makeTree();
    await writeMigrations(dir, { "0001_a.sql": "SELECT 1;\n", "0001_b.sql": "SELECT 1;\n" });
    const result = runCli(["--dir", dir, "--no-git"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /0001/);
  });

  it("exits 2 when the directory does not exist", async () => {
    const dir = await makeTree();
    const result = runCli(["--dir", join(dir, "nope"), "--no-git"]);
    assert.equal(result.status, 2);
  });
});
