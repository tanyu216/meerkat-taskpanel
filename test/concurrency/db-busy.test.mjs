/**
 * R2 — lock contention is not a server error (card T-20261012-234647).
 *
 * The audit's finding: `SQLITE_BUSY` was not in the error map, so it fell
 * through to a generic `VALIDATION_FAILED` and reached the caller as **HTTP
 * 500** — "the server is broken" for what is really "try again in a moment" —
 * and nothing ever retried. Holding the write lock for 8s made every online
 * write request 500 after 5.3s.
 *
 * Three layers are asserted here, weakest to strongest:
 *
 *   1. the mapper: `SQLITE_BUSY`/`SQLITE_LOCKED` → `DB_BUSY` (503), never
 *      `VALIDATION_FAILED`;
 *   2. the retry: an outermost transaction attempts again within a bounded
 *      budget, and past the budget reports `DB_BUSY` — a nested savepoint is
 *      never retried;
 *   3. the wire: a real request against a real board whose write lock is held by
 *      another connection answers **503 + `Retry-After` + `DB_BUSY`**, and the
 *      same request succeeds once the holder lets go.
 *
 * The last one is the acceptance criterion — "锁超时端到端不再 500" — and it is
 * driven by a *separate process* holding the lock, which is the shape of the
 * real failure (a second connection, a stalled disk).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { openDatabase } from "../../src/core/storage/driver.mjs";
import { SQLITE_ERRCODE, mapSqliteError } from "../../src/core/storage/sqlite-errors.mjs";
import { transaction } from "../../src/core/storage/unit-of-work.mjs";
import { createTaskd } from "../../src/server/index.mjs";
import { attachmentContentPath } from "../../src/server/routes/attachments.mjs";
import { ATTACHMENTS_DIRNAME, DB_BUSY_MAX_ATTEMPTS } from "../../src/foundation/constants.mjs";
import { ERROR_CODES } from "../../src/foundation/errors.mjs";

const tempDirs = [];
const children = new Set();
after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-busy-"));
  tempDirs.push(dir);
  return dir;
};

/** A node:sqlite-shaped failure — same fields, no database needed. */
function sqliteFailure(errcode, message = "database is locked") {
  const err = new Error(message);
  err.errcode = errcode;
  err.code = "ERR_SQLITE_ERROR";
  return err;
}

/**
 * A `DatabaseSync` whose `BEGIN IMMEDIATE` fails with `SQLITE_BUSY` the first
 * `busyTimes` times. Deterministic where a real lock would be a race.
 */
function flakyLockDb(inner, busyTimes) {
  let failures = 0;
  return new Proxy(inner, {
    get(target, property) {
      if (property === "exec") {
        return (sql) => {
          if (sql === "BEGIN IMMEDIATE" && failures < busyTimes) {
            failures += 1;
            throw sqliteFailure(SQLITE_ERRCODE.BUSY);
          }
          return target.exec(sql);
        };
      }
      if (property === "beginFailures") return failures;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("concurrency/db-busy — the mapper", () => {
  it("maps lock contention to DB_BUSY (503), not to a generic 500", () => {
    for (const errcode of [SQLITE_ERRCODE.BUSY, SQLITE_ERRCODE.LOCKED]) {
      const mapped = mapSqliteError(sqliteFailure(errcode), { op: "test" });
      assert.equal(mapped.code, "DB_BUSY", `errcode ${errcode}`);
      assert.equal(mapped.http, 503);
      assert.equal(mapped.details.sqlite.errcode, errcode);
      // The hint is what the transport turns into `Retry-After`.
      assert.equal(mapped.hint.retryAfterSeconds > 0, true);
    }
  });

  it("leaves every other SQLite failure exactly where it was", () => {
    // A declared unique key still maps to its own code…
    assert.equal(mapSqliteError(sqliteFailure(SQLITE_ERRCODE.UNIQUE, "UNIQUE constraint failed: tasks.id")).code, "ID_CONFLICT");
    // …and anything unmapped is still the generic validation failure, not DB_BUSY.
    assert.equal(mapSqliteError(sqliteFailure(SQLITE_ERRCODE.UNIQUE, "UNIQUE constraint failed: t.a, t.b")).code, "VALIDATION_FAILED");
    assert.equal(mapSqliteError(sqliteFailure(1, 'near "x": syntax error')).code, "VALIDATION_FAILED");
  });

  it("declares the code once, with a 503 status and a retry hint", () => {
    assert.equal(ERROR_CODES.DB_BUSY.http, 503);
    assert.equal(ERROR_CODES.DB_BUSY.hint.retryAfterSeconds > 0, true);
  });
});

describe("concurrency/db-busy — the retry budget", () => {
  it("retries an outermost transaction and runs the body exactly once", async () => {
    const board = await openDatabase({ path: join(tempDir(), "board.sqlite") });
    try {
      let bodies = 0;
      const db = flakyLockDb(board, 2);
      const result = transaction(db, () => {
        bodies += 1;
        return "ok";
      });
      assert.equal(result, "ok");
      assert.equal(bodies, 1, "the body runs once — a lost BEGIN rolled nothing back");
      assert.equal(db.beginFailures, 2, "…after two contended attempts");
    } finally {
      board.close();
    }
  });

  it("gives up after the budget and says DB_BUSY", async () => {
    const board = await openDatabase({ path: join(tempDir(), "board.sqlite") });
    try {
      let bodies = 0;
      const db = flakyLockDb(board, DB_BUSY_MAX_ATTEMPTS + 5);
      assert.throws(
        () => transaction(db, () => { bodies += 1; return "ok"; }),
        (err) => {
          assert.equal(err.code, "DB_BUSY");
          assert.equal(err.http, 503);
          return true;
        },
      );
      assert.equal(bodies, 0, "a contended BEGIN never reached the body");
      assert.equal(db.beginFailures, DB_BUSY_MAX_ATTEMPTS, "the budget is bounded, not a loop");
    } finally {
      board.close();
    }
  });

  it("does not retry a nested savepoint — the write lock is already held", () => {
    // A handle that reports itself mid-transaction, so `transaction()` takes the
    // savepoint branch without cutting a real SAVEPOINT. The claim is about the
    // retry *policy*, so the handle only has to record what was issued.
    const issued = [];
    const db = { isTransaction: true, exec: (sql) => issued.push(sql) };
    let bodies = 0;

    assert.throws(
      () => transaction(db, () => { bodies += 1; throw sqliteFailure(SQLITE_ERRCODE.BUSY); }, { attempts: 5 }),
      (err) => err.code === "DB_BUSY",
    );

    assert.equal(bodies, 1, "a savepoint body is attempted once, never retried");
    assert.equal(issued.filter((sql) => sql.startsWith("SAVEPOINT")).length, 1);
    assert.equal(issued.filter((sql) => sql.startsWith("ROLLBACK TO")).length, 1);
    assert.equal(issued.filter((sql) => sql === "BEGIN IMMEDIATE").length, 0);
  });
});

// ---------------------------------------------------------------------------
// End to end: a real second process holds the write lock
// ---------------------------------------------------------------------------

/**
 * A child that opens `dbPath`, takes the write lock, tells us, holds it for
 * `holdMs`, then commits and exits.
 *
 * `--input-type=module` because the runtime is ESM; the database handle is a
 * *separate process's* connection, which is exactly how the audit reproduced the
 * failure (and how a second connection contends with a live daemon).
 */
const HOLDER_SOURCE = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.BUSY_PROBE_DB);
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
process.stdout.write("held\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.env.BUSY_PROBE_HOLD_MS));
`;

/** Spawn the holder and resolve once it actually holds the lock. */
function holdWriteLock(dbPath, holdMs) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", HOLDER_SOURCE], {
    env: { ...process.env, BUSY_PROBE_DB: dbPath, BUSY_PROBE_HOLD_MS: String(holdMs) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.includes("held")) resolve(child);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

/** A board whose lock wait is short, so a test does not sit out the pinned 5s. */
async function shortFuseBoard() {
  return createTaskd({
    dataDir: tempDir(),
    host: "127.0.0.1",
    port: 0,
    env: {},
    gc: false,
    busyTimeoutMs: 100,
  });
}

async function createProject(url, id) {
  return fetch(`${url}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name: id }),
  });
}

describe("concurrency/db-busy — end to end, a real held lock", () => {
  it("answers 503 + Retry-After + DB_BUSY while another writer holds the lock", async () => {
    const taskd = await shortFuseBoard();
    try {
      const holder = await holdWriteLock(taskd.board.dbPath, 3_000);
      const response = await createProject(taskd.url, "bkd");
      const body = await response.json();

      assert.equal(response.status, 503, "contention is a 503, not the old 500");
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "DB_BUSY");
      assert.equal(body.error.http, 503);
      assert.equal(response.headers.get("retry-after"), "1", "the client is told when to come back");
      // The audit's exact symptom, asserted absent: the degraded code.
      assert.notEqual(body.error.code, "VALIDATION_FAILED");

      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });

  it("recovers inside the retry budget when the holder lets go", async () => {
    const taskd = await shortFuseBoard();
    try {
      // Longer than one `busy_timeout` (100ms) plus the backoff, shorter than
      // the same again — so the first attempt loses and a later one wins.
      const holder = await holdWriteLock(taskd.board.dbPath, 250);
      const response = await createProject(taskd.url, "evt");
      assert.equal(response.status, 200, `expected the retry to win, got ${response.status}`);
      const body = await response.json();
      assert.equal(body.data.project.id, "evt");
      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });

  it("writes nothing when it gives up — contention is not a partial write", async () => {
    const taskd = await shortFuseBoard();
    try {
      const holder = await holdWriteLock(taskd.board.dbPath, 3_000);
      await createProject(taskd.url, "nvl");
      const row = taskd.board.db.prepare("SELECT id FROM projects WHERE id = ?").get("nvl");
      assert.equal(row, undefined, "the refused write left no row behind");
      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DEF-234655-R2 — the attachment write path had a bare `.run()`
// ---------------------------------------------------------------------------

/**
 * `PUT /api/v1/attachments/:id/content` is handled *outside* the router, so the
 * R2 mapping every other route inherited did not reach it: `SQLITE_BUSY` escaped
 * unmapped and this route's own catch rendered it as a **500
 * `VALIDATION_FAILED`** (the audit's residual). The write now takes the same
 * transaction boundary and repository map as every command, so contention is a
 * **503 `DB_BUSY` + `Retry-After`** like everywhere else.
 */
describe("concurrency/db-busy — the attachment content write (DEF-234655-R2)", () => {
  async function boardWithAttachment(taskd) {
    const actor = { kind: "agent", id: "linus" };
    const { commands, repos } = taskd.board;
    commands.createProject({ id: "proj", name: "P", actor });
    const task = commands.createTask({ projectId: "proj", title: "with a file", actor });
    return repos.attachments.insert({
      taskId: task.id,
      filename: "x.bin",
      contentType: "application/octet-stream",
      createdAt: new Date().toISOString(),
      kind: "attachment",
    });
  }

  const putBytes = (taskd, id) =>
    fetch(`${taskd.url}/api/v1/attachments/${id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "hello",
    });

  it("answers 503 + Retry-After + DB_BUSY, not the old 500 VALIDATION_FAILED", async () => {
    const taskd = await shortFuseBoard();
    try {
      const attachment = await boardWithAttachment(taskd);
      const holder = await holdWriteLock(taskd.board.dbPath, 3_000);

      const response = await putBytes(taskd, attachment.id);
      const body = await response.json();

      assert.equal(response.status, 503, "contention on this path is a 503 too");
      assert.equal(body.error.code, "DB_BUSY");
      assert.equal(body.error.http, 503);
      assert.equal(response.headers.get("retry-after"), "1");
      // The audit's exact symptom, asserted absent.
      assert.notEqual(body.error.code, "VALIDATION_FAILED");
      assert.notEqual(response.status, 500);

      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });

  it("lands the same write once the holder lets go", async () => {
    const taskd = await shortFuseBoard();
    try {
      const attachment = await boardWithAttachment(taskd);
      // Longer than one `busy_timeout` (100ms), shorter than the whole budget —
      // so an attempt loses and a later one wins.
      const holder = await holdWriteLock(taskd.board.dbPath, 250);
      const response = await putBytes(taskd, attachment.id);
      assert.equal(response.status, 200, `expected the retry to win, got ${response.status}`);
      assert.equal((await response.json()).data.size, 5);
      assert.equal(taskd.board.repos.attachments.get(attachment.id).size, 5, "the row's size kept up");
      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });

  /**
   * T-20261013-014304 — the write *order* on this path.
   *
   * A 503 was already the right answer here (R2); what was still wrong is what
   * the refused request left behind. The handler wrote the bytes first and only
   * then took the write lock, so contention past the retry budget answered 503
   * *after* the payload had already replaced the stored file — orphan bytes, and
   * a row whose `size` described a file that was no longer there. GET still
   * served the truth (`stat`, not the row), so the damage was quiet: disk growth
   * and a listing that lied.
   *
   * These two cases pin the invariant on both sides of the 503 — the disk and
   * the row. They are deliberately not satisfiable by relaxing an assertion:
   * the first requires the file to be *absent*, the second requires the old
   * bytes to be *present* and byte-identical.
   */
  it("leaves no orphan bytes when the lock is held — the refused PUT writes nothing", async () => {
    const taskd = await shortFuseBoard();
    try {
      const attachment = await boardWithAttachment(taskd);
      const path = attachmentContentPath(taskd.board.dataDir, attachment.id);
      const holder = await holdWriteLock(taskd.board.dbPath, 3_000);

      const response = await putBytes(taskd, attachment.id);
      assert.equal(response.status, 503, "contention is still a 503");

      assert.equal(statSync(path, { throwIfNoEntry: false }), undefined, "no bytes were stored");
      // Not even a staging file: a `.part` left behind would be the same leak
      // wearing a different name.
      assert.deepEqual(
        readdirSync(join(taskd.board.dataDir, ATTACHMENTS_DIRNAME)),
        [],
        "and nothing was staged",
      );
      assert.equal(taskd.board.repos.attachments.get(attachment.id).size, 0, "the row did not move");

      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });

  it("keeps the bytes already stored when a contended overwrite is refused", async () => {
    const taskd = await shortFuseBoard();
    try {
      const attachment = await boardWithAttachment(taskd);
      const path = attachmentContentPath(taskd.board.dataDir, attachment.id);

      const landed = await putBytes(taskd, attachment.id); // "hello" — 5 bytes
      assert.equal(landed.status, 200);
      assert.equal(readFileSync(path, "utf8"), "hello");

      const holder = await holdWriteLock(taskd.board.dbPath, 3_000);
      const refused = await fetch(`${taskd.url}/api/v1/attachments/${attachment.id}/content`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "a replacement that must never land",
      });
      assert.equal(refused.status, 503);

      // The refused overwrite is the case the old order got wrong: the file had
      // already been replaced when the lock was taken, so the stored bytes were
      // the *new* ones while the row still said 5.
      assert.equal(readFileSync(path, "utf8"), "hello", "the stored bytes survived verbatim");
      assert.equal(statSync(path).size, 5);
      assert.equal(taskd.board.repos.attachments.get(attachment.id).size, 5, "row and disk still agree");
      assert.deepEqual(
        readdirSync(join(taskd.board.dataDir, ATTACHMENTS_DIRNAME)),
        [attachment.id],
        "one file, no leftovers",
      );

      holder.kill("SIGKILL");
    } finally {
      await taskd.close();
    }
  });
});
