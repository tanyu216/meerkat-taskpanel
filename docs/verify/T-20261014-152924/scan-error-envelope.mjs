#!/usr/bin/env node
/**
 * T-20261014-152924 acceptance ③ — the sweep, as a command.
 *
 * The rule: **no API error envelope's `message` may contain storage-engine
 * text** — `/constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE
 * constraint/`. The engine's own words are allowed on `details.sqlite` (the
 * server-side log surface), never in the sentence a client renders.
 *
 * This script feeds *every* code the surface can emit a raw engine message —
 * the shapes SQLite prints for `CHECK` / `UNIQUE` / `NOT NULL` / `FOREIGN KEY`
 * failures, a `RAISE(ABORT,…)` trigger, and a plain engine error — through the
 * real mapper (`mapSqliteError` → `DomainError`) and the real envelope
 * (`toErrorPayload`, which is what `server/router.mjs#errorResponse` serialises),
 * then counts the hits.
 *
 *   node docs/verify/T-20261014-152924/scan-error-envelope.mjs
 *
 * Exit 0 when the hit count is zero, 1 otherwise. The same predicate is
 * asserted inside the suite (`test/core/storage/sqlite-errors.test.mjs`,
 * `test/web/error-text.test.mjs`) and over real HTTP
 * (`test/server/error-envelope.test.mjs`); this is the standalone reading.
 */

import { ERROR_CODES, DomainError, toErrorPayload } from "../../../src/shared/errors.mjs";
import { SQLITE_ERRCODE, mapSqliteError } from "../../../src/core/storage/sqlite-errors.mjs";

/** The acceptance predicate, character for character as the card states it. */
const ENGINE_TEXT = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;

/** A stand-in for a `node:sqlite` failure — the same shape, no database needed. */
function sqliteFailure(errcode, message) {
  const err = new Error(message);
  err.errcode = errcode;
  err.code = "ERR_SQLITE_ERROR";
  err.errstr = "constraint failed";
  return err;
}

/** Raw sentences a refused write can carry, one per family SQLite prints. */
const ENGINE_MESSAGES = [
  "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'",
  "CHECK constraint failed: source_task_id <> target_task_id",
  "CHECK constraint failed: relation_type <> 'related' OR source_task_id < target_task_id",
  "CHECK constraint failed: version >= 1",
  "UNIQUE constraint failed: tasks.project_id, tasks.identifier",
  "UNIQUE constraint failed: nope.a, nope.b",
  "NOT NULL constraint failed: tasks.title",
  "FOREIGN KEY constraint failed",
  "SqliteError: SQLITE_MISUSE: bad parameter or other API misuse",
  "SQLITE_ERROR: near \"x\": syntax error",
  "database is locked",
];

let scanned = 0;
let hits = 0;
const rows = [];

/** Record one envelope reading under the acceptance predicate. */
function probe(label, err) {
  const payload = toErrorPayload(err);
  scanned += 1;
  const hit = ENGINE_TEXT.test(payload.message);
  if (hit) hits += 1;
  rows.push({ label, code: payload.code, message: payload.message, hit });
}

// 1. Every errcode the mapper knows, against every engine message shape.
const errcodes = [
  SQLITE_ERRCODE.CHECK,
  SQLITE_ERRCODE.UNIQUE,
  SQLITE_ERRCODE.PRIMARYKEY,
  SQLITE_ERRCODE.NOTNULL,
  SQLITE_ERRCODE.FOREIGNKEY,
  SQLITE_ERRCODE.TRIGGER,
  SQLITE_ERRCODE.BUSY,
  SQLITE_ERRCODE.LOCKED,
  1,
];
for (const errcode of errcodes) {
  for (const message of ENGINE_MESSAGES) {
    probe(`mapSqliteError(errcode ${errcode}, ${message.slice(0, 24)}…)`, mapSqliteError(sqliteFailure(errcode, message), { op: "scan", table: "tasks" }));
  }
}

// 2. Every declared code, built by hand with an engine message — the case a
//    caller other than the mapper can produce, and the one the constructor and
//    the envelope both have to catch.
for (const code of Object.keys(ERROR_CODES)) {
  probe(`new DomainError(${code})`, new DomainError(code, { message: ENGINE_MESSAGES[0] }));
}

// 3. Things that are not `DomainError`s at all.
for (const thrown of [sqliteFailure(SQLITE_ERRCODE.CHECK, ENGINE_MESSAGES[0]), new Error(ENGINE_MESSAGES[4]), "UNIQUE constraint failed: x.y"]) {
  probe("toErrorPayload(non-domain throw)", thrown);
}

process.stdout.write(`scan: ${scanned} error envelopes, predicate ${ENGINE_TEXT}\n`);
for (const row of rows.filter((entry) => entry.hit)) {
  process.stdout.write(`  HIT  ${row.label} → ${row.code}: ${row.message}\n`);
}
process.stdout.write(
  hits === 0
    ? `scan: PASS — 0 of ${scanned} messages carry engine text\n`
    : `scan: FAIL — ${hits} of ${scanned} messages carry engine text\n`,
);
process.exit(hits === 0 ? 0 : 1);
