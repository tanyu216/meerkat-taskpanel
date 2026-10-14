/**
 * R2 re-run — lock contention on the attachment content write is a **retryable
 * 503**, never a 500 (card T-20261012-234655, defect DEF-234655-R2).
 *
 * The audit and the first review pass both found the same shape: SQLITE_BUSY
 * escaping `mapSqliteError` and reaching the client as `500 VALIDATION_FAILED`.
 * The residual was `PUT /api/v1/attachments/:id/content`, whose `size` update
 * used to be a bare `.run()`. The claim under test is therefore threefold:
 *
 *   1. **>5s of contention** (the card's literal construction) ⇒ the request
 *      is answered with retryable semantics and never with
 *      `500/VALIDATION_FAILED`. Which of the two retryable answers it gets
 *      depends on the budget: inside it the retry *recovers* (`200`), past it
 *      the request is *refused as retryable* (`503` + `error.code=DB_BUSY` +
 *      `Retry-After`). Both are asserted separately;
 *   2. **within budget** ⇒ the write still lands (`200`) and the row matches
 *      the bytes on disk;
 *   3. a refused write leaves **nothing behind**: no staged bytes, `size`
 *      untouched.
 *
 * Requests go through the daemon's real request handler (see
 * `lib/inproc-http.mjs` — this sandbox cannot open a socket). The lock is held
 * by a *separate process* on the same database file, which is the real failure
 * mode: a second connection, a stalled disk, a `migrate` run.
 *
 * The retry budget is `DB_BUSY_MAX_ATTEMPTS` (`3`) outermost attempts, each
 * waiting the pinned 5000 ms `busy_timeout`, plus a 25/50 ms backoff — about
 * 15.1 s in total. The "budget exhausted" case below therefore dials the busy
 * timeout down to 1000 ms so the card's ">5 s of contention" is enough to
 * exhaust it; the pinned-value run shows the same contention being *absorbed*.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInProcessTaskd, sendInProcess } from "./lib/inproc-http.mjs";
import { ATTACHMENTS_DIRNAME } from "./lib/sut.mjs";

const tempDirs = [];
const children = new Set();
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-probe-"));
  tempDirs.push(dir);
  return dir;
};

/** Hold the database's write lock from another process, then let go. */
const HOLDER = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.PROBE_DB);
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
process.stdout.write("held\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.env.PROBE_HOLD_MS));
`;

function holdWriteLock(dbPath, holdMs) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", HOLDER], {
    env: { ...process.env, PROBE_DB: dbPath, PROBE_HOLD_MS: String(holdMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.includes("held")) resolve(child);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`holder: ${chunk}`));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`holder exited early (${code})`)));
  });
}

/** A board with one task and one (empty) attachment row, ready to receive bytes. */
async function freshBoard({ busyTimeoutMs }) {
  const taskd = await createInProcessTaskd({
    dataDir: tempDir(),
    env: {},
    gc: false,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  });
  const project = await sendInProcess(taskd, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "proj", name: "proj" }),
  });
  assert.equal(project.status, 200, "fixture: project");
  const task = await sendInProcess(taskd, {
    method: "POST",
    path: "/api/v1/tasks",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: "proj", title: "attachment task" }),
  });
  assert.equal(task.status, 200, "fixture: task");
  taskd.board.db
    .prepare(
      `INSERT INTO attachments(id, task_id, filename, size, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("att-1", task.json.data.task.id, "x.bin", 0, "attachment", new Date().toISOString());
  return taskd;
}

const bigPayload = Buffer.alloc(64 * 1024, 7);

function stagedFiles(taskd) {
  try {
    return readdirSync(join(taskd.board.dataDir, ATTACHMENTS_DIRNAME)).filter((name) => name.endsWith(".part"));
  } catch {
    return [];
  }
}

const evidence = [];

try {
  // --- (1a) >5s of contention against the pinned timeout: the retry absorbs it ---
  const longBoard = await freshBoard({});
  const longHolder = await holdWriteLock(longBoard.board.dbPath, 8_000);
  const startedAt = Date.now();
  const absorbed = await sendInProcess(longBoard, {
    method: "PUT",
    path: "/api/v1/attachments/att-1/content",
    headers: { "content-type": "application/octet-stream" },
    body: bigPayload,
  });
  const absorbedMs = Date.now() - startedAt;
  evidence.push({
    case: "held 8s vs pinned busy_timeout 5000ms x3 attempts",
    status: absorbed.status,
    body: absorbed.json,
    elapsedMs: absorbedMs,
    size: longBoard.board.repos.attachments.get("att-1").size,
  });
  assert.equal(absorbed.status, 200, "the bounded retry recovers once the holder lets go");
  assert.notEqual(absorbed.status, 500, "…and the request was never a 500");
  assert.equal(longBoard.board.repos.attachments.get("att-1").size, bigPayload.length);
  longHolder.kill("SIGKILL");

  // --- (1b) >5s of contention past the budget: a retryable refusal, not a 500 ---
  const exhaustedBoard = await freshBoard({ busyTimeoutMs: 1_000 });
  const exhaustedHolder = await holdWriteLock(exhaustedBoard.board.dbPath, 6_000);
  const exhaustStartedAt = Date.now();
  const refused = await sendInProcess(exhaustedBoard, {
    method: "PUT",
    path: "/api/v1/attachments/att-1/content",
    headers: { "content-type": "application/octet-stream" },
    body: bigPayload,
  });
  const elapsedMs = Date.now() - exhaustStartedAt;
  const sizeAfterRefusal = exhaustedBoard.board.repos.attachments.get("att-1").size;
  evidence.push({
    case: "held 6s vs busy_timeout 1000ms x3 attempts",
    status: refused.status,
    body: refused.json,
    retryAfter: refused.headers["retry-after"] ?? null,
    elapsedMs,
    sizeAfterRefusal,
    stagedLeftBehind: stagedFiles(exhaustedBoard),
  });
  assert.equal(refused.status, 503, "an exhausted budget is a retryable 503, not a 500");
  assert.equal(refused.json.error.code, "DB_BUSY");
  assert.equal(refused.json.error.http, 503);
  assert.notEqual(refused.json.error.code, "VALIDATION_FAILED", "the DEF-234655-R2 shape is gone");
  assert.equal(refused.headers["retry-after"], "1", "a 503 tells the client when to come back");
  assert.equal(sizeAfterRefusal, 0, "a refused write leaves the row alone");
  assert.deepEqual(stagedFiles(exhaustedBoard), [], "…and no staged bytes behind");
  exhaustedHolder.kill("SIGKILL");

  // --- (2) contention inside the budget: the bounded retry wins ---
  const shortBoard = await freshBoard({ busyTimeoutMs: 100 });
  const shortHolder = await holdWriteLock(shortBoard.board.dbPath, 250);
  const landed = await sendInProcess(shortBoard, {
    method: "PUT",
    path: "/api/v1/attachments/att-1/content",
    headers: { "content-type": "application/octet-stream" },
    body: bigPayload,
  });
  evidence.push({
    case: "contention inside the budget (busy_timeout 100ms, held 250ms)",
    status: landed.status,
    body: landed.json,
    size: shortBoard.board.repos.attachments.get("att-1").size,
  });
  assert.equal(landed.status, 200, "the retry recovers once the holder lets go");
  assert.equal(landed.json.data.stored, true);
  assert.equal(landed.json.data.size, bigPayload.length);
  assert.equal(
    shortBoard.board.repos.attachments.get("att-1").size,
    bigPayload.length,
    "the row's size matches the bytes that were stored",
  );
  const readBack = await sendInProcess(shortBoard, { method: "GET", path: "/api/v1/attachments/att-1/content" });
  evidence.push({ case: "read-back", status: readBack.status, bytes: readBack.body.length });
  assert.equal(readBack.status, 200);
  assert.equal(readBack.body.length, bigPayload.length, "GET serves exactly what PUT stored");
  shortHolder.kill("SIGKILL");

  console.log(JSON.stringify(evidence, null, 2));
  console.log("R2 PROBE PASS");
} finally {
  // On a failure the assertion is terse; the evidence is what a reader needs,
  // so it is printed on the way out either way.
  if (evidence.length > 0) console.error("EVIDENCE SO FAR:\n" + JSON.stringify(evidence, null, 2));
  for (const child of children) child.kill("SIGKILL");
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
