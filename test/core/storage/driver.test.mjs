/**
 * Step 4: connection semantics and the `node:sqlite` failure path.
 *
 * Every case works in a throwaway temp directory — the real `.data/` is never
 * touched (plan §5, fixture discipline).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  MIN_SQLITE_VERSION,
  REQUIRED_PRAGMAS,
  closeDatabase,
  compareVersions,
  openDatabase,
  readPragmas,
  sqliteVersion,
  sqliteUnavailableError,
} from "../../../src/core/storage/driver.mjs";
import {
  ensureDir,
  isAbsolutePath,
  resolveDataDir,
  resolveDbPath,
  repoRoot,
  resolveRuntimePointerPath,
  tokenPath,
} from "../../../src/core/storage/paths.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

const tempDirs = [];
function tempDir(prefix = "taskpanel-driver-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("storage/driver — pragmas", () => {
  it("pins WAL / busy_timeout / foreign_keys / synchronous / recursive_triggers", async () => {
    const db = await openDatabase({ path: join(tempDir(), "board.sqlite") });
    try {
      const pragmas = readPragmas(db);
      assert.equal(pragmas.journal_mode, "wal");
      assert.equal(pragmas.busy_timeout, REQUIRED_PRAGMAS.busy_timeout);
      assert.equal(pragmas.foreign_keys, 1);
      assert.equal(pragmas.synchronous, 1, "NORMAL");
      assert.equal(pragmas.recursive_triggers, 0, "nested DML behaviour must be explicit");
    } finally {
      closeDatabase(db);
    }
  });

  it("actually enforces foreign keys", async () => {
    const db = await openDatabase({ path: join(tempDir(), "fk.sqlite") });
    try {
      db.exec("CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT");
      db.exec("CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id)) STRICT");
      assert.throws(() => db.prepare("INSERT INTO child VALUES('c','nope')").run());
      db.prepare("INSERT INTO parent VALUES('p')").run();
      db.prepare("INSERT INTO child VALUES('c','p')").run();
    } finally {
      closeDatabase(db);
    }
  });

  it("keeps data across a close/reopen (a real file, not a scratch connection)", async () => {
    const path = join(tempDir(), "persist.sqlite");
    const first = await openDatabase({ path });
    first.exec("CREATE TABLE t(v TEXT NOT NULL) STRICT");
    first.prepare("INSERT INTO t VALUES('kept')").run();
    closeDatabase(first);

    const second = await openDatabase({ path });
    try {
      assert.equal(second.prepare("SELECT v FROM t").get().v, "kept");
      assert.equal(readPragmas(second).journal_mode, "wal");
    } finally {
      closeDatabase(second);
    }
  });

  it("explains :memory: rather than pretending it is WAL", async () => {
    const db = await openDatabase({ path: ":memory:" });
    try {
      const pragmas = readPragmas(db);
      assert.equal(pragmas.journal_mode, "memory");
      assert.equal(pragmas.busy_timeout, REQUIRED_PRAGMAS.busy_timeout);
      assert.equal(pragmas.foreign_keys, 1);
    } finally {
      closeDatabase(db);
    }
  });

  it("reports the SQLite version and requires >= 3.37 for STRICT tables", async () => {
    const db = await openDatabase({ path: ":memory:" });
    try {
      const version = sqliteVersion(db);
      assert.match(version, /^\d+\.\d+\.\d+$/);
      assert.ok(compareVersions(version, MIN_SQLITE_VERSION) >= 0, version);
    } finally {
      closeDatabase(db);
    }
  });

  it("refuses a database that is too old, naming both versions", async () => {
    await assert.rejects(
      () => openDatabase({ path: ":memory:", minVersion: "99.0.0" }),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "SQLITE_UNAVAILABLE");
        assert.equal(err.http, 500);
        assert.equal(err.details.required, "99.0.0");
        assert.match(err.message, /STRICT/);
        return true;
      },
    );
  });

  it("turns a missing node:sqlite into an actionable error", async () => {
    await assert.rejects(
      () =>
        openDatabase({
          path: ":memory:",
          loadModule: () => {
            throw new Error("Cannot find module 'node:sqlite'");
          },
        }),
      (err) => {
        assert.equal(err.code, "SQLITE_UNAVAILABLE");
        assert.match(err.hint.flags, /--experimental-sqlite/);
        assert.equal(err.cause instanceof Error, true);
        return true;
      },
    );

    await assert.rejects(
      () => openDatabase({ path: ":memory:", loadModule: async () => ({}) }),
      (err) => err.code === "SQLITE_UNAVAILABLE",
    );

    const synthesized = sqliteUnavailableError();
    assert.match(synthesized.hint.example, /experimental-sqlite/);
  });

  it("rejects a missing path and closes quietly twice", async () => {
    await assert.rejects(() => openDatabase({ path: "  " }), (err) => err.code === "VALIDATION_FAILED");
    const db = await openDatabase({ path: ":memory:" });
    closeDatabase(db);
    assert.doesNotThrow(() => closeDatabase(db));
    assert.doesNotThrow(() => closeDatabase(null));
  });

  it("opens read-only without trying to write the journal mode", async () => {
    const path = join(tempDir(), "ro.sqlite");
    const rw = await openDatabase({ path });
    rw.exec("CREATE TABLE t(v TEXT NOT NULL) STRICT");
    rw.prepare("INSERT INTO t VALUES('x')").run();
    closeDatabase(rw);

    const ro = await openDatabase({ path, readonly: true });
    try {
      assert.equal(ro.prepare("SELECT v FROM t").get().v, "x");
      assert.equal(readPragmas(ro).foreign_keys, 1);
      assert.throws(() => ro.prepare("INSERT INTO t VALUES('y')").run());
    } finally {
      closeDatabase(ro);
    }
  });
});

describe("storage/driver — version comparison", () => {
  it("compares dotted versions numerically, not lexically", () => {
    assert.ok(compareVersions("3.37.0", "3.37.0") === 0);
    assert.ok(compareVersions("3.9.0", "3.37.0") < 0, "9 < 37 numerically");
    assert.ok(compareVersions("3.53.4", "3.37.0") > 0);
    assert.ok(compareVersions("4.0", "3.99.99") > 0);
    assert.ok(compareVersions("3.37", "3.37.1") < 0);
  });
});

describe("storage/paths", () => {
  it("resolves the data dir: explicit > env > <repo>/.data", () => {
    const repo = repoRoot();
    assert.equal(resolveDataDir({ env: {} }), join(repo, ".data"));
    assert.equal(resolveDataDir({ env: { TASKD_DATA_DIR: "/tmp/x" } }), "/tmp/x");
    assert.equal(resolveDataDir({ dataDir: "/tmp/y", env: { TASKD_DATA_DIR: "/tmp/x" } }), "/tmp/y");
    assert.equal(resolveDataDir({ dataDir: "rel", env: {} }), join(repo, "rel"), "made absolute");
  });

  it("resolves the database file: explicit > TASKD_DB > <dataDir>/board.sqlite", () => {
    assert.equal(resolveDbPath({ env: {} }), join(repoRoot(), ".data", "board.sqlite"));
    assert.equal(
      resolveDbPath({ env: { TASKD_DB: "/tmp/b.sqlite" } }),
      "/tmp/b.sqlite",
      "absolute TASKD_DB wins",
    );
    assert.equal(
      resolveDbPath({ env: { TASKD_DB: "other.sqlite" }, dataDir: "/tmp/d" }),
      "/tmp/d/other.sqlite",
      "bare TASKD_DB is relative to the data dir",
    );
    assert.equal(
      resolveDbPath({ dbPath: "/tmp/explicit.sqlite", env: { TASKD_DB: "/tmp/b.sqlite" } }),
      "/tmp/explicit.sqlite",
    );
  });

  it("places the token beside the database and knows absolute paths", () => {
    assert.equal(tokenPath("/tmp/d"), "/tmp/d/token");
    assert.equal(isAbsolutePath("/tmp/x"), true);
    assert.equal(isAbsolutePath("x/y"), false);
    assert.equal(isAbsolutePath(""), false);
    assert.equal(isAbsolutePath(null), false);
  });

  it("creates directories with 0700 even under a permissive umask", () => {
    const base = tempDir();
    const nested = join(base, "a", "b");
    ensureDir(nested);
    const mode = statSync(nested).mode & 0o777;
    assert.equal(mode, 0o700, "directory mode must be 0700");
    assert.equal(existsSync(nested), true);
    assert.doesNotThrow(() => ensureDir(nested), "idempotent");
  });

  it("picks the per-user runtime pointer per platform", () => {
    const home = "/home/tester";
    assert.equal(
      resolveRuntimePointerPath({ platform: "darwin", home, env: {} }),
      "/home/tester/Library/Application Support/TaskPanel/runtime.json",
    );
    assert.equal(
      resolveRuntimePointerPath({ platform: "linux", home, env: {} }),
      "/home/tester/.local/state/task-panel/runtime.json",
    );
    assert.equal(
      resolveRuntimePointerPath({ platform: "linux", home, env: { XDG_STATE_HOME: "/xdg" } }),
      "/xdg/task-panel/runtime.json",
    );
  });
});
