/**
 * Step 20: `openBoard` end to end (A13, V13).
 *
 * A temp data directory in, a usable board out: migrated schema, a 0600 token,
 * a token-free runtime pointer, working commands — and idempotent on a second
 * call, because every daemon start does this again.
 */

import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { openBoard, readPointer } from "../../src/core/bootstrap.mjs";
import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { applyMigrations } from "../../src/core/storage/migrations-runner.mjs";
import { TOKEN_FORMAT } from "../../src/core/storage/secrets/token-store.mjs";
import { ensureParentDir } from "../../src/core/storage/paths.mjs";
import { cleanupTempDirs, makeTempDir, TS } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** A temp data dir + temp pointer path; nothing touches the real ones. */
function scratch() {
  const base = makeTempDir("bootstrap-");
  const dataDir = join(base, "data");
  const pointerPath = join(base, "state", "runtime.json");
  mkdirSync(dataDir, { recursive: true });
  return { base, dataDir, pointerPath };
}

const mode = (path) => statSync(path).mode & 0o777;

describe("core/bootstrap — openBoard", () => {
  it("migrates, makes a token, writes a pointer and hands back commands", async () => {
    const { dataDir, pointerPath } = scratch();
    const board = await openBoard({
      dataDir,
      pointerPath,
      env: {},
      clock: () => TS,
      pointerUrl: undefined,
    });
    try {
      assert.deepEqual(board.migration.applied.map((m) => m.version), ["0001", "0002", "0003", "0004", "0005", "0006"]);
      assert.equal(board.schema.ok, true);
      assert.match(board.version, /^\d+\.\d+\.\d+$/);
      assert.equal(board.dbPath, join(dataDir, "board.sqlite"));
      assert.equal(existsSync(board.dbPath), true);

      const tokenFile = join(dataDir, "token");
      assert.match(readFileSync(tokenFile, "utf8").trim(), TOKEN_FORMAT);
      assert.equal(mode(tokenFile), 0o600);
      assert.equal(mode(dataDir), 0o700);
      assert.equal(board.token.file, tokenFile);
      assert.equal(board.token.created, true);

      // The pointer is the only thing outside the data dir, and it is a path,
      // not a secret.
      assert.equal(mode(pointerPath), 0o600);
      const pointerText = readFileSync(pointerPath, "utf8");
      assert.equal(/td_[0-9a-f]{64}/.test(pointerText), false);
      const pointer = JSON.parse(pointerText);
      assert.deepEqual(Object.keys(pointer).sort(), [
        "dataDir",
        "host",
        "pid",
        "port",
        "tokenFile",
        "updatedAt",
        "url",
        "version",
      ]);
      assert.equal(pointer.dataDir, dataDir);
      assert.equal(pointer.port, 9527);
      assert.equal(pointer.url, "http://127.0.0.1:9527");
      assert.deepEqual(readPointer({ path: pointerPath }), pointer);

      // And it is a working board.
      const project = board.commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws" });
      assert.equal(project.id, "proj");
      const task = board.commands.createTask({ projectId: "proj", title: "One", actor: { kind: "agent", id: "linus" } });
      assert.equal(task.identifier, "PROJ-0001");
      assert.equal(task.createdAt, TS, "the injected clock reached the command layer");
      assert.equal(board.repos.tasks.get(task.id).title, "One");
    } finally {
      board.close();
    }
  });

  it("is idempotent: a second open reuses the token and applies nothing", async () => {
    const { dataDir, pointerPath } = scratch();
    const first = await openBoard({ dataDir, pointerPath, env: {} });
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    first.close();

    const second = await openBoard({ dataDir, pointerPath, env: {} });
    try {
      assert.deepEqual(second.migration.applied, []);
      assert.deepEqual(second.migration.skipped, ["0001", "0002", "0003", "0004", "0005", "0006"]);
      assert.equal(second.token.created, false);
      assert.equal(readFileSync(join(dataDir, "token"), "utf8").trim(), token, "the token survives a restart");
      assert.equal(second.schema.ok, true);
      assert.deepEqual(
        readdirSync(dataDir).filter((name) => name.includes(".tmp-")),
        [],
        "no temporary files",
      );
    } finally {
      second.close();
    }
  });

  it("refuses to serve a database that is behind the code", async () => {
    const { dataDir, pointerPath } = scratch();
    const dbPath = join(dataDir, "board.sqlite");

    // A database an older build created: four migrations, not five.
    const older = makeTempDir("bootstrap-old-");
    const sources = join(dirname(fileURLToPath(import.meta.url)), "../../src/core/storage/migrations");
    for (const name of readdirSync(sources).filter((n) => n.endsWith(".sql") && !n.startsWith("0005"))) {
      copyFileSync(join(sources, name), join(older, name));
    }
    const db = await openDatabase({ path: dbPath });
    applyMigrations(db, { dir: older });
    closeDatabase(db);

    // A read-only open must not migrate, and must not pretend all is well.
    await assert.rejects(() => openBoard({ dataDir, pointerPath, env: {}, readonly: true }), (err) => {
      assert.equal(err.code, "SCHEMA_MISMATCH");
      return true;
    });
    const stale = await openBoard({ dataDir, pointerPath, env: {}, readonly: true, allowStale: true });
    try {
      assert.equal(stale.schema.ok, false);
      assert.deepEqual(stale.schema.missing, ["0005"]);
      assert.equal(stale.migration.applied.length, 0, "a read-only open never migrates");
      // The repositories would build statements against columns that do not
      // exist yet, so they name the real problem instead.
      assert.throws(() => stale.repos.tasks, (err) => {
        assert.equal(err.code, "SCHEMA_MISMATCH");
        assert.match(err.message, /0005/);
        return true;
      });
      assert.throws(() => stale.commands.listTasks(), (err) => err.code === "SCHEMA_MISMATCH");
      assert.equal(typeof stale.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, "number", "raw SQL still works");
    } finally {
      stale.close();
    }

    // A normal open is what brings a board up to date — the card's "启动校验并
    // apply" — and says exactly which file it applied.
    const upgraded = await openBoard({ dataDir, pointerPath, env: {} });
    try {
      assert.deepEqual(upgraded.migration.applied.map((m) => m.version), ["0005"]);
      assert.equal(upgraded.schema.ok, true);
    } finally {
      upgraded.close();
    }

    // And a tampered checksum is refused outright, even by a read-only open.
    const tampered = await openDatabase({ path: dbPath });
    tampered.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'").run();
    closeDatabase(tampered);
    await assert.rejects(() => openBoard({ dataDir, pointerPath, env: {} }), (err) => {
      assert.equal(err.code, "MIGRATION_CHECKSUM_MISMATCH");
      assert.equal(err.details.version, "0001");
      return true;
    });
  });

  it("honours TASKD_DATA_DIR / TASKD_DB and the host/port env vars", async () => {
    const { base } = scratch();
    const envDataDir = join(base, "from-env");
    const board = await openBoard({
      env: { TASKD_DATA_DIR: envDataDir, TASKD_HOST: "127.0.0.1", TASKD_PORT: "9530" },
      pointerPath: join(base, "state", "runtime.json"),
    });
    try {
      assert.equal(board.dataDir, envDataDir);
      assert.equal(board.dbPath, join(envDataDir, "board.sqlite"));
      assert.equal(board.pointer.url, "http://127.0.0.1:9530");
      assert.equal(board.pointer.port, 9530);
    } finally {
      board.close();
    }
  });

  it("can skip the pointer and can run read-only", async () => {
    const { dataDir, pointerPath } = scratch();
    const quiet = await openBoard({ dataDir, pointerPath, env: {}, pointer: false });
    try {
      assert.equal(quiet.pointer, null);
      assert.equal(existsSync(pointerPath), false);
    } finally {
      quiet.close();
    }

    const writer = await openBoard({ dataDir, pointerPath, env: {} });
    writer.commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws" });
    writer.close();

    const reader = await openBoard({ dataDir, pointerPath, env: {}, readonly: true });
    try {
      assert.equal(reader.token, null);
      assert.equal(reader.repos.projects.get("proj").name, "P");
      assert.throws(() => reader.repos.projects.create({ id: "x", name: "X", workspacePath: "/tmp/x", now: TS }));
    } finally {
      reader.close();
    }
  });

  it("tightens permissions on a data directory that was left open", async () => {
    const { dataDir, pointerPath } = scratch();
    chmodSync(dataDir, 0o777);
    const board = await openBoard({ dataDir, pointerPath, env: {} });
    try {
      assert.equal(mode(dataDir), 0o700);
    } finally {
      board.close();
    }
  });

  it("reports a data directory it cannot create instead of a partial board", async () => {
    const { base } = scratch();
    const blocked = join(base, "blocked");
    ensureParentDir(join(blocked, "x"));
    // A file where a directory is needed.
    const filePath = join(base, "afile");
    writeFileSync(filePath, "x");
    await assert.rejects(() => openBoard({ dataDir: join(filePath, "sub"), env: {}, pointer: false }));
  });
});
