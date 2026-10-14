#!/usr/bin/env node
/**
 * T-20261014-152924 acceptance ② — Terry's drag, replayed against the engine.
 *
 * Terry's report (2026-10-14): dragging a *claimed* card back to Backlog raised
 * `CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'` on the
 * board. The two legs of that drag are both legal transitions —
 * `in_progress → todo` and `todo → backlog` — so the transition table was never
 * the problem: the execution claim (`claimed_by`) was stamped on the way into
 * `in_progress` and never released on the way out, and the schema refuses a
 * claim on a backlog card.
 *
 * This script drives the same sequence through `openBoard()` — the same engine
 * the CLI and `taskd` use, in a throwaway data directory — and prints what the
 * board would have shown at each step. It then arms the *old* failure state
 * deliberately (a `todo` card carrying a stale claim, written straight to SQL)
 * to show that the move now repairs it, and finally writes the forbidden state
 * directly to prove the CHECK is still armed — answering with a reason code and
 * a sentence rather than the engine's.
 *
 *   node docs/verify/T-20261014-152924/repro-terry.mjs
 *
 * Exit 0 when every reading below is the expected one, 1 otherwise. Nothing in
 * `src/**` is touched: the script only reads and writes its own temp board.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openBoard } from "../../../src/core/bootstrap.mjs";
import { mapSqliteError } from "../../../src/core/storage/sqlite-errors.mjs";

const AGENT = { kind: "agent", id: "linus" };
const HUMAN = { kind: "human", id: "Terry" };

const readings = [];
let failures = 0;

/** Record one observation: what was asked, what came back, whether it is right. */
function read(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  readings.push({ label, actual, expected, ok });
  const shown = (value) => (typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value));
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${label}: ${shown(actual)}${ok ? "" : ` (expected ${shown(expected)})`}\n`);
}

/** The claim columns of one row, read straight out of the database. */
const rowOf = (db, id) =>
  db.prepare("SELECT status, claimed_by, claimed_at, heartbeat_at FROM tasks WHERE id = ?").get(id);

function banner(text) {
  process.stdout.write(`\n${text}\n`);
}

const dir = mkdtempSync(join(tmpdir(), "meerkat-repro-terry-"));
const board = await openBoard({ dataDir: join(dir, "data"), pointer: false });

try {
  const { db, commands } = board;
  commands.createProject({ id: "proj", name: "Project", actor: HUMAN });

  // ---------------------------------------------------------------- the drag
  banner("① the reported drag: claim → in_progress → todo → backlog");

  const card = commands.createTask({ projectId: "proj", title: "Terry's card", actor: HUMAN });
  read("created status", card.status, "todo");
  read("created claim", card.claimedBy, null);

  const claimed = commands.claim({ id: card.id, actor: AGENT }).task;
  read("after claim — status", claimed.status, "in_progress");
  read("after claim — claimed_by", claimed.claimedBy, "linus");
  read("after claim — heartbeat_at set", typeof claimed.heartbeatAt, "string");

  // Leg 1 — the one that used to leave the lock behind.
  const back = commands.moveStatus({ id: card.id, to: "todo", actor: AGENT });
  read("in_progress → todo — status", back.status, "todo");
  read("in_progress → todo — claimed_by released", back.claimedBy, null);
  read("in_progress → todo — claimed_at released", back.claimedAt, null);
  read("in_progress → todo — heartbeat_at released", back.heartbeatAt, null);

  // Leg 2 — the write that used to raise `CHECK constraint failed: …`.
  let moved = null;
  let raised = null;
  try {
    moved = commands.moveStatus({ id: card.id, to: "backlog", actor: HUMAN });
  } catch (err) {
    raised = { code: err.code, message: err.message };
  }
  read("todo → backlog — raised", raised, null);
  read("todo → backlog — status", moved?.status ?? null, "backlog");
  read("todo → backlog — claimed_by", moved?.claimedBy ?? null, null);
  read("row after the drag", rowOf(db, card.id), {
    status: "backlog",
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
  });

  // -------------------------------------------------- the lock the fix keeps
  banner("② the paths that must KEEP the lock (same executor resumes)");

  const running = commands.createTask({ projectId: "proj", title: "Reworked", actor: HUMAN });
  commands.claim({ id: running.id, actor: AGENT });
  const blocked = commands.moveStatus({ id: running.id, to: "blocked", actor: AGENT, blockedReason: "dependency" });
  read("in_progress → blocked — claimed_by kept", blocked.claimedBy, "linus");
  const unblocked = commands.moveStatus({ id: running.id, to: "in_progress", actor: AGENT });
  read("blocked → in_progress — claimed_by kept", unblocked.claimedBy, "linus");

  const waiting = commands.moveStatus({ id: running.id, to: "awaiting", awaitingReason: "E1", actor: AGENT });
  read("in_progress → awaiting — claimed_by kept", waiting.claimedBy, "linus");
  const resumed = commands.moveStatus({ id: running.id, to: "in_progress", actor: AGENT });
  read("awaiting → in_progress — claimed_by kept", resumed.claimedBy, "linus");

  // ------------------------------- a pre-existing stale claim is repaired too
  banner("③ an already-stale claim is repaired by the same move");

  const poisoned = commands.createTask({ projectId: "proj", title: "Stale claim", actor: HUMAN });
  // The exact state the old code left behind: a `todo` card still carrying the
  // claim of a card that was dragged out of `in_progress`. Written straight to
  // SQL, which is the only way to produce it now.
  db.prepare("UPDATE tasks SET claimed_by = 'linus', claimed_at = ?, heartbeat_at = ? WHERE id = ?").run(
    "2026-10-14T00:00:00.000Z",
    "2026-10-14T00:00:00.000Z",
    poisoned.id,
  );
  read("poisoned row — claimed_by", rowOf(db, poisoned.id).claimed_by, "linus");

  let repaired = null;
  let refused = null;
  try {
    repaired = commands.moveStatus({ id: poisoned.id, to: "backlog", actor: HUMAN });
  } catch (err) {
    refused = { code: err.code, message: err.message };
  }
  read("stale claim → backlog — raised", refused, null);
  read("stale claim → backlog — status", repaired?.status ?? null, "backlog");
  read("stale claim → backlog — row healed", rowOf(db, poisoned.id).claimed_by, null);

  // ------------------------------------------- the CHECK is still armed (③)
  banner("④ the CHECK is still armed — a foreign writer gets a code, not SQL");

  // The release cannot fire on a write that does not go through a move, and the
  // schema still refuses the state itself. This is the row the defensive mapping
  // in `CHECK_TEXT_TO_CODE` exists for.
  let engineHit = null;
  try {
    db.prepare("UPDATE tasks SET claimed_by = 'linus' WHERE id = ?").run(poisoned.id);
  } catch (err) {
    const mapped = mapSqliteError(err, { op: "repro.terry", table: "tasks" });
    engineHit = { code: mapped.code, message: mapped.message, engineText: mapped.details?.sqlite?.message ?? null };
  }
  read("raw write on a backlog card — code", engineHit?.code ?? null, "CLAIM_ON_BACKLOG");
  read("raw write on a backlog card — message is prose", engineHit?.message ?? null, "A backlog task cannot hold a claim.");
  read(
    "raw write on a backlog card — engine text kept on details only",
    /CHECK constraint failed/.test(engineHit?.engineText ?? ""),
    true,
  );
  read(
    "raw write on a backlog card — message carries no engine text",
    /constraint failed|SQLITE|SqliteError/.test(engineHit?.message ?? ""),
    false,
  );
} finally {
  board.close();
  rmSync(dir, { recursive: true, force: true });
}

banner(failures === 0 ? `PASS — ${readings.length} readings, 0 failures` : `FAIL — ${failures} of ${readings.length} readings`);
process.exit(failures === 0 ? 0 : 1);
