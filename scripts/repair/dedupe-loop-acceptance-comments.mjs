#!/usr/bin/env node
/**
 * One-off repair: collapse repeated "Loop acceptance after review …" notes.
 *
 * Why this exists
 * ---------------
 * The workflow `approve` action used to post its note before the acceptance
 * marker and before the move to `done`. When the board refused the move (for
 * example `ACCEPTANCE_INCOMPLETE`), every later pass re-planned the same
 * approve and appended the identical note again — 124 times on one live card.
 * The executor is fixed; this script removes the rows the old one left behind.
 *
 * This is a **recorded exception** to the append-only comment/activity tables
 * (`tr_comments_no_delete`, `tr_activities_no_delete`, see docs/events.md).
 * It is safe because it is:
 *   - narrow: only `taskd` notes whose body matches the loop's acceptance line,
 *     grouped by `(task_id, body)`, keeping the earliest `--keep` rows;
 *   - transactional: the two no-delete triggers are dropped and recreated
 *     byte-for-byte from `sqlite_master` inside one `BEGIN IMMEDIATE`;
 *   - backed up: `VACUUM INTO` writes a copy before anything is deleted;
 *   - auditable: every deleted comment id is listed in a JSON repair record.
 *
 * Trade-off: the deleted rows really were written, so the audit trail loses
 * them. The alternative — a presentation-only collapse in the web UI — leaves
 * `card.md` bloated; the board's owner chose the controlled cleanup.
 *
 * Usage (the board must be stopped; one writer per data directory):
 *   node scripts/repair/dedupe-loop-acceptance-comments.mjs \
 *     --data-dir ~/.meerkat-taskpanel/.data            # dry run
 *   node scripts/repair/dedupe-loop-acceptance-comments.mjs \
 *     --data-dir ~/.meerkat-taskpanel/.data --apply
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const BODY_LIKE = "Loop acceptance after review %: VERDICT: APPROVE.";
const NO_DELETE_TRIGGERS = ["tr_comments_no_delete", "tr_activities_no_delete"];
const CHUNK = 400;

/** @param {string} dbPath */
export function openBoard(dbPath) {
  return new DatabaseSync(dbPath);
}

/**
 * The redundant rows, grouped by `(task_id, body)`. The earliest `keep` rows of
 * each group survive; everything after them is redundant.
 *
 * @param {DatabaseSync} db
 * @param {{keep?: number}} [options]
 */
export function planDuplicates(db, options = {}) {
  const keep = Math.max(0, Number(options.keep ?? 1));
  const rows = db
    .prepare(
      `SELECT c.id, c.task_id, c.body, c.created_at, c.author_kind, t.identifier
         FROM comments c
         LEFT JOIN tasks t ON t.id = c.task_id
        WHERE c.author_kind = 'taskd' AND c.body LIKE ?
        ORDER BY c.task_id, c.body, c.created_at, c.id`,
    )
    .all(BODY_LIKE);

  const groups = new Map();
  for (const row of rows) {
    const key = `${row.task_id}\u0000${row.body}`;
    const group = groups.get(key) ?? { ...row, total: 0, kept: 0, delete: [] };
    group.total += 1;
    if (group.kept < keep) group.kept += 1;
    else group.delete.push(row.id);
    groups.set(key, group);
  }
  const list = [...groups.values()].map((group) => ({
    taskId: group.task_id,
    identifier: group.identifier ?? group.task_id,
    body: group.body,
    total: group.total,
    keep: group.kept,
    delete: group.delete,
  }));
  const total = list.reduce((sum, group) => sum + group.total, 0);
  const keeping = list.reduce((sum, group) => sum + group.keep, 0);
  return { groups: list, total, keeping, deleting: total - keeping };
}

/** A human-readable dry-run table. */
export function formatPlan(plan) {
  const lines = ["identifier                        total  keep  delete"];
  for (const group of plan.groups) {
    lines.push(
      `${group.identifier.padEnd(32)}  ${String(group.total).padStart(5)}  ${String(
        group.keep,
      ).padStart(4)}  ${String(group.delete.length).padStart(6)}`,
    );
  }
  lines.push(
    `${"TOTAL".padEnd(32)}  ${String(plan.total).padStart(5)}  ${String(
      plan.keeping,
    ).padStart(4)}  ${String(plan.deleting).padStart(6)}`,
  );
  return lines.join("\n");
}

/** The board's `writer.lock` names the live taskd; refuse while it answers. */
export function assertBoardStopped(dataDir, { force = false } = {}) {
  const lockPath = join(dataDir, "writer.lock");
  if (!existsSync(lockPath)) return;
  let pid = null;
  try {
    pid = Number(JSON.parse(readFileSync(lockPath, "utf8")).pid);
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch {
    return; // the process is gone; the lock is stale
  }
  if (!force) {
    throw new Error(
      `taskd is still running (pid ${pid}). Stop it first (one writer per data directory), ` +
        "or pass --force if you know this lock is stale.",
    );
  }
}

function chunked(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * Delete the planned rows in one transaction, with the no-delete triggers
 * dropped and restored around the deletes.
 *
 * @param {DatabaseSync} db
 * @param {ReturnType<typeof planDuplicates>} plan
 */
export function applyRepair(db, plan) {
  const deleteIds = plan.groups.flatMap((group) => group.delete);
  if (deleteIds.length === 0) return { deletedComments: 0, deletedActivities: 0 };

  const triggerSql = new Map();
  for (const name of NO_DELETE_TRIGGERS) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?").get(name);
    if (row?.sql) triggerSql.set(name, row.sql);
    else throw new Error(`trigger ${name} is missing; refusing to touch an unknown schema`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of NO_DELETE_TRIGGERS) db.exec(`DROP TRIGGER ${name}`);

    let deletedComments = 0;
    let deletedActivities = 0;
    for (const ids of chunked(deleteIds)) {
      const marks = placeholders(ids.length);
      deletedComments += Number(
        db.prepare(`DELETE FROM comments WHERE id IN (${marks})`).run(...ids).changes ?? 0,
      );
      deletedActivities += Number(
        db
          .prepare(
            `DELETE FROM task_activities
              WHERE event = 'comment_added'
                AND json_extract(changes_json, '$.commentId') IN (${marks})`,
          )
          .run(...ids).changes ?? 0,
      );
    }

    for (const name of NO_DELETE_TRIGGERS) db.exec(triggerSql.get(name));

    // Post-state: every group keeps exactly the rows the plan kept.
    for (const group of plan.groups) {
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ? AND body = ?")
        .get(group.taskId, group.body);
      if (Number(n) !== group.keep) {
        throw new Error(
          `post-state mismatch for ${group.identifier}: expected ${group.keep}, found ${n}`,
        );
      }
    }

    db.exec("COMMIT");
    return { deletedComments, deletedActivities };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** `VACUUM INTO` a sibling backup — outside any transaction. */
export function backupBoard(db, backupPath) {
  mkdirSync(dirname(backupPath), { recursive: true });
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  return backupPath;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Write the repair record next to the board's other logs. */
export function writeRepairRecord(dataDir, plan, result, backupPath) {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `repair-loop-acceptance-${stamp()}.json`);
  const record = {
    at: new Date().toISOString(),
    backup: backupPath,
    deletedComments: result.deletedComments,
    deletedActivities: result.deletedActivities,
    groups: plan.groups.map((group) => ({
      identifier: group.identifier,
      body: group.body,
      total: group.total,
      kept: group.keep,
      deletedIds: group.delete,
    })),
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function parseArgs(argv) {
  const args = { apply: false, force: false, keep: 1, db: null, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--db") args.db = argv[++i];
    else if (arg === "--data-dir") args.dataDir = argv[++i];
    else if (arg === "--keep") args.keep = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (args.db === null && args.dataDir === null)) {
    console.log(
      "usage: dedupe-loop-acceptance-comments.mjs (--db <board.sqlite> | --data-dir <dir>)\n" +
        "         [--keep <n>] [--apply] [--force]",
    );
    return args.help ? 0 : 2;
  }
  if (!Number.isInteger(args.keep) || args.keep < 0) throw new Error("--keep must be a non-negative integer");

  const dbPath = args.db ?? join(args.dataDir, "board.sqlite");
  if (!existsSync(dbPath)) throw new Error(`no board at ${dbPath}`);

  const db = openBoard(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const plan = planDuplicates(db, { keep: args.keep });
    console.log(formatPlan(plan));
    if (!args.apply) {
      console.log("\ndry run — nothing written. Re-run with --apply to delete the redundant rows.");
      return 0;
    }
    if (plan.deleting === 0) {
      console.log("nothing to delete.");
      return 0;
    }
    if (args.dataDir !== null) assertBoardStopped(args.dataDir, { force: args.force });

    const dataDir = args.dataDir ?? dirname(dbPath);
    const backupPath = join(dataDir, "backups", `board.pre-comment-repair-${stamp()}.sqlite`);
    backupBoard(db, backupPath);
    const result = applyRepair(db, plan);
    const record = writeRepairRecord(dataDir, plan, result, backupPath);
    console.log(
      `\ndeleted ${result.deletedComments} comment(s) and ${result.deletedActivities} activity row(s).`,
    );
    console.log(`backup: ${backupPath}`);
    console.log(`record: ${record}`);
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`repair failed: ${error.message}`);
    process.exitCode = 1;
  }
}
