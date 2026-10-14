#!/usr/bin/env node
/**
 * T-20261014-152924-2 acceptance ② — the error-envelope sweep.
 *
 * The card's predicate, character for character:
 *
 *   `/constraint failed|SQLITE|SqliteError/`
 *
 * must never match the `message` of an API error envelope, and the engine's own
 * words must survive **only** on `details.sqlite` (the server-side log surface).
 *
 * Two halves, because a predicate can be true for the wrong reason:
 *
 *   A. **Real failure paths** — the four families the card names (constraint /
 *      unique / not-found / version conflict) are *driven* through the shipped
 *      code: the real route handlers (`registerApiRoutes`), the real repository
 *      (`moveCas`'s mapper seam) and the real envelope (`errorResponse`), with a
 *      real SQLite database. What comes out is the object the server writes.
 *   B. **The whole vocabulary** — every `ERROR_CODES` entry fed engine text, and
 *      every SQLite errcode fed every engine message family, through the real
 *      `mapSqliteError` → `DomainError` → `toErrorPayload` chain.
 *
 *   node docs/verify/T-20261014-152924-2/scan-error-envelope.mjs \
 *     --root . --out docs/verify/T-20261014-152924-2/evidence/scan-error-envelope.json
 *
 * Exit 0 ⇔ zero hits on the predicate and every engine text preserved on
 * `details.sqlite`. `--root` re-points the script at another source tree (④).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const flag = name.startsWith("--") ? name : `--${name}`;
  const hit = process.argv.slice(2).find((a) => a === flag || a.startsWith(`${flag}=`));
  if (hit === undefined) return fallback;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const ROOT = resolve(String(arg("--root", resolve(HERE, "../../.."))));
const OUT = arg("--out", null);

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { openBoard } = await load("src/core/index.mjs");
const { createRouter, errorResponse } = await load("src/server/router.mjs");
const { registerApiRoutes } = await load("src/server/index.mjs");
const { ERROR_CODES, DomainError, toErrorPayload } = await load("src/shared/errors.mjs");
const { SQLITE_ERRCODE, mapSqliteError } = await load("src/core/storage/sqlite-errors.mjs");

/** The card's predicate, as the card spells it. */
const ENGINE_TEXT = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;
/** The same families the engine prints, one per shape (also fed to the sweep). */
const ENGINE_MESSAGES = [
  "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'",
  "CHECK constraint failed: source_task_id <> target_task_id",
  "UNIQUE constraint failed: tasks.project_id, tasks.identifier",
  "UNIQUE constraint failed: nope.a, nope.b",
  "NOT NULL constraint failed: tasks.title",
  "FOREIGN KEY constraint failed",
  'SQLITE_ERROR: near "x": syntax error',
  "SqliteError: SQLITE_MISUSE: bad parameter or other API misuse",
  "SQLITE_BUSY: database is locked",
];

// ---------------------------------------------------------------- harness

const dataDir = mkdtempSync(join(tmpdir(), "lane2-scan-"));
const board = await openBoard({ dataDir, env: {}, pointer: false });
const router = createRouter();
registerApiRoutes(router, { board, token: board.token });

const LINUS = { kind: "agent", id: "linus" };

async function call(method, path, body, actor = LINUS) {
  const url = new URL(`http://probe.test${path}`);
  const route = router.match(method, url.pathname);
  if (route === null) {
    return { status: 404, envelope: { ok: false, error: { code: "NOT_FOUND", message: `no route for ${method} ${url.pathname}` } } };
  }
  try {
    const data = await route.handler({ params: route.params, query: url.searchParams, body: body ?? {}, actor, session: null, seg: null, board, token: board.token });
    return { status: 200, envelope: { ok: true, data } };
  } catch (err) {
    const { status, payload } = errorResponse(err);
    return { status, envelope: payload };
  }
}

const dataOf = (result) => result.envelope.data;
const row = (id) => board.db.prepare("SELECT status, claimed_by FROM tasks WHERE id = ?").get(id);

const checks = [];
const rows = [];

function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail: detail ?? "" });
}

/** Record one envelope reading under the card's predicate. */
function record(family, label, status, error, expectCode) {
  const message = String(error.message ?? "");
  const hit = ENGINE_TEXT.test(message);
  const row = {
    family,
    case: label,
    http: status,
    code: error.code,
    message,
    message_has_engine_text: hit,
    details_sqlite_message: error.details?.sqlite?.message ?? null,
  };
  rows.push(row);
  check(`② ${family} · ${label}: message free of engine text`, hit === false, `code=${error.code} message=${JSON.stringify(message)}`);
  if (expectCode !== undefined) {
    check(`② ${family} · ${label}: code is ${expectCode}`, error.code === expectCode, `code=${error.code}`);
  }
  return row;
}

// ---- A. real failure paths -------------------------------------------------

const projectId = dataOf(await call("POST", "/api/v1/projects", { name: "Lane2 — envelope" })).project.id;
const seed = dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Seed" })).task;

// A1 — NOT_FOUND (未找到)
{
  const result = await call("GET", "/api/v1/tasks/NOPE-0001");
  record("not-found", "GET /api/v1/tasks/NOPE-0001", result.status, result.envelope.error, "NOT_FOUND");
}

// A2 — UNIQUE (唯一): a duplicate identifier, through the unique index
{
  const result = await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Dup", identifier: seed.identifier });
  const reading = record("unique", "create with a duplicate identifier", result.status, result.envelope.error, "IDENTIFIER_CONFLICT");
  check(
    "② unique · the engine text is preserved on details.sqlite",
    /UNIQUE constraint failed: tasks\.project_id, tasks\.identifier/.test(reading.details_sqlite_message ?? ""),
    `details.sqlite.message=${JSON.stringify(reading.details_sqlite_message)}`,
  );
}

// A3 — VERSION_CONFLICT (版本冲突)
{
  const result = await call("POST", `/api/v1/tasks/${seed.identifier}/move`, { to: "in_progress", if_version: 999 });
  record("version", "move with a stale if_version", result.status, result.envelope.error, "VERSION_CONFLICT");
}

// A4 — CHECK (约束): the `tasks` CHECK, reachable only by a foreign writer
{
  const card = dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Claimed" })).task;
  await call("POST", `/api/v1/tasks/${card.identifier}/move`, { to: "in_progress" });
  // The pre-fix stored state: a claimed card in `todo` (see repro-claim-release.mjs).
  board.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(card.id);
  const stale = row(card.id);
  check("② check · the pre-fix state was reconstructed (todo + claimed_by)", stale.status === "todo" && stale.claimed_by === "linus", `status=${stale.status} claimed_by=${stale.claimed_by}`);

  let envelope;
  let mapped;
  let status = 0;
  try {
    board.db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(card.id);
    envelope = { code: "—", message: "the write was accepted (unexpected)", details: {} };
  } catch (err) {
    mapped = mapSqliteError(err, { op: "tasks.moveCas", table: "tasks" });
    const shaped = errorResponse(mapped);
    status = shaped.status;
    envelope = shaped.payload.error;
  }
  const reading = record("constraint (CHECK)", "foreign writer: claimed row → backlog", status, envelope, "CLAIM_ON_BACKLOG");
  check(
    "② constraint · the engine text is preserved on details.sqlite",
    /CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'/.test(reading.details_sqlite_message ?? ""),
    `details.sqlite.message=${JSON.stringify(reading.details_sqlite_message)}`,
  );
}

// A5 — NOT NULL (约束 family): a raw insert with no title
{
  let envelope;
  let status = 0;
  try {
    board.db.prepare("INSERT INTO tasks (id, project_id, identifier, title, status, version, created_at, updated_at) VALUES (?, ?, ?, NULL, 'todo', 1, ?, ?)").run("probe-notnull", projectId, "PROBE-0001", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    envelope = { code: "—", message: "the insert was accepted (unexpected)", details: {} };
  } catch (err) {
    const mapped = mapSqliteError(err, { op: "tasks.insert", table: "tasks" });
    const shaped = errorResponse(mapped);
    status = shaped.status;
    envelope = shaped.payload.error;
  }
  const reading = record("constraint (NOT NULL)", "raw insert without a title", status, envelope, "VALIDATION_FAILED");
  check(
    "② constraint · the NOT NULL engine text is preserved on details.sqlite",
    /NOT NULL constraint failed/.test(reading.details_sqlite_message ?? ""),
    `details.sqlite.message=${JSON.stringify(reading.details_sqlite_message)}`,
  );
}

// A6 — RAISE(ABORT,'CODE') (the trigger family), if reachable with two cards
{
  const a = dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Rel A" })).task;
  const b = dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Rel B" })).task;
  const made = await call("POST", `/api/v1/tasks/${a.identifier}/relations`, { type: "blocks", target: b.identifier });
  if (made.status !== 200) {
    check("② trigger · relation created for the immutability probe", false, `http=${made.status} code=${made.envelope.error?.code}`);
  } else {
    let envelope;
    let status = 0;
    try {
      // `tr_rel_immutable` is a BEFORE UPDATE trigger (relations are add/remove
      // only): the raw edit below is what it refuses.
      board.db.prepare("UPDATE task_relations SET relation_type = 'related' WHERE source_task_id = ?").run(a.id);
      envelope = { code: "—", message: "the update was accepted (unexpected)", details: {} };
    } catch (err) {
      const shaped = errorResponse(mapSqliteError(err, { op: "relations.update", table: "task_relations" }));
      status = shaped.status;
      envelope = shaped.payload.error;
    }
    record("trigger (RAISE)", "raw edit of an immutable relation", status, envelope, "RELATION_IMMUTABLE");
  }
}

// ---- B. the whole vocabulary ------------------------------------------------

let codeProbes = 0;
let codeHits = 0;
for (const code of Object.keys(ERROR_CODES)) {
  for (const engine of ENGINE_MESSAGES) {
    const payload = toErrorPayload(new DomainError(code, { message: engine, details: { sqlite: { errcode: 275, message: engine } } }));
    codeProbes += 1;
    if (ENGINE_TEXT.test(String(payload.message))) {
      codeHits += 1;
      rows.push({ family: "sweep/code", case: code, message: payload.message, message_has_engine_text: true });
    }
  }
}
check(`② sweep · every ERROR_CODES entry (${Object.keys(ERROR_CODES).length}) × ${ENGINE_MESSAGES.length} engine messages`, codeHits === 0, `${codeHits}/${codeProbes} envelopes carry engine text`);

let errProbes = 0;
let errHits = 0;
let errPreserved = 0;
for (const errcode of Object.values(SQLITE_ERRCODE)) {
  for (const engine of ENGINE_MESSAGES) {
    const err = new Error(engine);
    err.errcode = errcode;
    err.code = "ERR_SQLITE_ERROR";
    const payload = toErrorPayload(mapSqliteError(err, { op: "tasks.probe" }));
    errProbes += 1;
    if (ENGINE_TEXT.test(String(payload.message))) {
      errHits += 1;
      rows.push({ family: "sweep/errcode", case: `errcode=${errcode}`, message: payload.message, message_has_engine_text: true });
    }
    if (payload.details?.sqlite?.message === engine) errPreserved += 1;
  }
}
check(`② sweep · every SQLITE_ERRCODE (${Object.values(SQLITE_ERRCODE).length}) × ${ENGINE_MESSAGES.length} engine messages`, errHits === 0, `${errHits}/${errProbes} envelopes carry engine text`);
check(
  "② sweep · the engine text itself survives on details.sqlite for every mapped failure",
  errPreserved === errProbes,
  `${errPreserved}/${errProbes} carried details.sqlite.message === the raw engine text`,
);

// ---------------------------------------------------------------- verdict

board.close();
rmSync(dataDir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const payload = {
  root: ROOT,
  ran_at: new Date().toISOString(),
  predicate: String(ENGINE_TEXT),
  real_paths: rows.filter((r) => !r.family.startsWith("sweep/")),
  sweep: { code_probes: codeProbes, code_hits: codeHits, errcode_probes: errProbes, errcode_hits: errHits, engine_text_preserved: errPreserved },
  checks,
  verdict: failed.length === 0 ? "PASS" : "FAIL",
};

for (const r of payload.real_paths) {
  console.log(
    `${r.family.padEnd(20)} http=${String(r.http).padEnd(3)} code=${String(r.code).padEnd(20)} engine_text_in_message=${r.message_has_engine_text} message=${JSON.stringify(r.message)}`,
  );
}
console.log(`\nsweep: codes ${codeHits}/${codeProbes} hits · errcodes ${errHits}/${errProbes} hits · engine text preserved on details.sqlite ${errPreserved}/${errProbes}`);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}  [${c.detail}]`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks pass — verdict ${payload.verdict}`);
if (OUT !== null && OUT !== true) {
  mkdirSync(dirname(resolve(String(OUT))), { recursive: true });
  writeFileSync(resolve(String(OUT)), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`readings → ${resolve(String(OUT))}`);
}
process.exit(failed.length === 0 ? 0 : 1);
