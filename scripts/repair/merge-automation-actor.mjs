#!/usr/bin/env node
/**
 * One-off repair: merge the two historical automation actors into `Board`.
 *
 * Why this exists
 * ---------------
 * Until ADR 0018 the board's automated writes used two actor ids: `system` for
 * core board events (rollup, the label GC, agent sessions) and `Orchestrator`
 * for the loop's workflow pass. Both recorded kind `system`, so the roster and
 * the comment/report trail showed two automation authors. The identity is now
 * one — `Board`, kind `system` — and this script moves the historical rows onto
 * it, then deletes the two dead dictionary entries.
 *
 * This is a **recorded exception** to the append-only comment/report tables
 * (`tr_comments_no_update`, `tr_comments_no_delete`, `tr_reports_no_update`,
 * `tr_reports_no_delete`) and to the actor dictionary's no-delete rule
 * (`tr_dict_actors_delete`). It is safe because it is:
 *   - narrow: only `comments.author_id` and `task_reports.author_id`, and only
 *     the two known legacy actors;
 *   - transactional: the five triggers are captured from `sqlite_master` and
 *     recreated byte-for-byte inside one `BEGIN IMMEDIATE`;
 *   - backed up: `VACUUM INTO` writes a copy before anything changes;
 *   - checked: the plan refuses when another column references a legacy actor or
 *     a comment/report has no actor, and the post-state is asserted before
 *     `COMMIT` (`foreign_key_check` included);
 *   - auditable: every merged id and count is listed in a JSON repair record.
 *
 * `task_activities` is history and is not rewritten: the frozen acceptance names
 * comments and reports, and the audit log's append-only triggers are not touched.
 *
 * Usage (the board must be stopped; one writer per data directory):
 *   node scripts/repair/merge-automation-actor.mjs \
 *     --data-dir ~/.meerkat-taskpanel/.data            # dry run
 *   node scripts/repair/merge-automation-actor.mjs \
 *     --data-dir ~/.meerkat-taskpanel/.data --apply
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import { newId } from "../../src/foundation/ids.mjs";
import { norm } from "../../src/foundation/norm.mjs";

import { assertBoardStopped, backupBoard } from "./dedupe-loop-acceptance-comments.mjs";

/** The retired automation ids, as the dictionary stores them (normalised). */
export const LEGACY_ACTOR_NAMES = Object.freeze(["system", "orchestrator"]);
/** The one surviving automation identity. */
export const BOARD_ACTOR = Object.freeze({ displayName: "Board", normalizedName: norm("Board") });
/** The append-only guards the repair must step around, restored verbatim. */
export const ATOMICITY_TRIGGERS = Object.freeze([
  "tr_comments_no_update",
  "tr_comments_no_delete",
  "tr_reports_no_update",
  "tr_reports_no_delete",
  "tr_dict_actors_delete",
]);

/**
 * Open the board file. Foreign keys must be enforced: the whole plan depends on
 * a reference to an actor being an actual reference.
 *
 * @param {string} dbPath
 */
export function openBoard(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * Read the merge: the two legacy rows, what they authored, whether anything
 * else blocks the delete, and the `Board` row (existing or planned).
 *
 * @param {DatabaseSync} db
 * @param {{now?: string, idFactory?: () => string}} [options]
 */
export function planMerge(db, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory ?? newId;

  const legacy = db
    .prepare(
      `SELECT id, display_name, first_seen_at, last_seen_at, use_count
         FROM actors
        WHERE normalized_name IN (${placeholders(LEGACY_ACTOR_NAMES.length)})
        ORDER BY normalized_name`,
    )
    .all(...LEGACY_ACTOR_NAMES);
  const legacyIds = legacy.map((row) => row.id);

  const countsBy = (table, ids) => {
    if (ids.length === 0) return new Map();
    const rows = db
      .prepare(`SELECT author_id AS id, COUNT(*) AS n FROM ${table} WHERE author_id IN (${placeholders(ids.length)}) GROUP BY author_id`)
      .all(...ids);
    return new Map(rows.map((row) => [row.id, Number(row.n)]));
  };
  const comments = countsBy("comments", legacyIds);
  const reports = countsBy("task_reports", legacyIds);

  const board = db
    .prepare("SELECT id, first_seen_at, last_seen_at, use_count FROM actors WHERE normalized_name = ?")
    .get(BOARD_ACTOR.normalizedName);

  const merged = { comments: 0, reports: 0, useCount: 0, firstSeenAt: null, lastSeenAt: null };
  for (const row of legacy) {
    merged.comments += comments.get(row.id) ?? 0;
    merged.reports += reports.get(row.id) ?? 0;
    merged.useCount += Number(row.use_count);
    if (merged.firstSeenAt === null || row.first_seen_at < merged.firstSeenAt) merged.firstSeenAt = row.first_seen_at;
    if (merged.lastSeenAt === null || row.last_seen_at > merged.lastSeenAt) merged.lastSeenAt = row.last_seen_at;
  }

  // Anything outside comments/reports would be a reference this repair does not
  // own. Refuse rather than strand it (the dict-delete guard exists for this).
  const taskRefs =
    legacyIds.length === 0
      ? []
      : db
          .prepare(
            `SELECT id, identifier FROM tasks
              WHERE assignee_id IN (${placeholders(legacyIds.length)})
                 OR reporter_id IN (${placeholders(legacyIds.length)})
                 OR claimed_by IN (${placeholders(legacyIds.length)})`,
          )
          .all(...legacyIds, ...legacyIds, ...legacyIds);
  const orphans = {
    comments: Number(
      db.prepare("SELECT COUNT(*) AS n FROM comments c LEFT JOIN actors a ON a.id = c.author_id WHERE a.id IS NULL").get().n,
    ),
    reports: Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM task_reports r LEFT JOIN actors a ON a.id = r.author_id WHERE a.id IS NULL")
        .get().n,
    ),
  };

  const boardComments = board
    ? Number(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE author_id = ?").get(board.id).n)
    : 0;
  const boardReports = board
    ? Number(db.prepare("SELECT COUNT(*) AS n FROM task_reports WHERE author_id = ?").get(board.id).n)
    : 0;

  return {
    now,
    legacy: legacy.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      useCount: Number(row.use_count),
      comments: comments.get(row.id) ?? 0,
      reports: reports.get(row.id) ?? 0,
    })),
    merged,
    board: {
      id: board?.id ?? idFactory(),
      create: board === undefined,
      displayName: BOARD_ACTOR.displayName,
      normalizedName: BOARD_ACTOR.normalizedName,
      firstSeenAt: [board?.first_seen_at, merged.firstSeenAt].filter(Boolean).sort()[0] ?? now,
      lastSeenAt: [board?.last_seen_at, merged.lastSeenAt].filter(Boolean).sort().at(-1) ?? now,
      // A merged count never double-counts: the legacy rows are deleted, so a
      // second plan finds them gone and proposes no further change.
      useCount: board ? Math.max(1, Number(board.use_count) + merged.useCount) : Math.max(1, merged.useCount),
      update: board !== undefined && merged.useCount > 0,
    },
    counts: { boardComments, boardReports },
    blocked: { tasks: taskRefs, orphans },
  };
}

/** A human-readable dry-run table. */
export function formatPlan(plan) {
  const lines = ["legacy actor        id                                    comments  reports  use_count"];
  for (const row of plan.legacy) {
    lines.push(
      `${row.displayName.padEnd(19)} ${row.id.padEnd(36)}  ${String(row.comments).padStart(8)}  ${String(row.reports).padStart(7)}  ${String(row.useCount).padStart(9)}`,
    );
  }
  lines.push(
    `${"MERGE → " + plan.board.displayName}`.padEnd(56) +
      `  ${String(plan.merged.comments).padStart(8)}  ${String(plan.merged.reports).padStart(7)}  ${String(plan.board.useCount).padStart(9)}`,
  );
  if (plan.board.create) lines.push(`Board actor: create ${plan.board.id}`);
  const { tasks, orphans } = plan.blocked;
  if (tasks.length > 0) {
    lines.push(`BLOCKED: ${tasks.length} task(s) still reference a legacy actor: ${tasks.map((t) => t.identifier).join(", ")}`);
  }
  if (orphans.comments > 0 || orphans.reports > 0) {
    lines.push(`BLOCKED: ${orphans.comments} comment(s) / ${orphans.reports} report(s) have no actor row`);
  }
  return lines.join("\n");
}

function triggerSql(db) {
  const map = new Map();
  for (const name of ATOMICITY_TRIGGERS) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
    if (row?.sql) map.set(name, row.sql);
    else throw new Error(`trigger ${name} is missing; refusing to touch an unknown schema`);
  }
  return map;
}

/**
 * Apply the merge in one transaction, with the append-only triggers dropped and
 * recreated around it, and every post-state asserted before `COMMIT`.
 *
 * @param {DatabaseSync} db
 * @param {ReturnType<typeof planMerge>} plan
 */
export function applyMerge(db, plan) {
  if (plan.legacy.length === 0) {
    return { mergedComments: 0, mergedReports: 0, deletedActors: 0, boardId: plan.board.id };
  }
  if (plan.blocked.tasks.length > 0) {
    throw new Error(
      `refusing: ${plan.blocked.tasks.length} task(s) still reference a legacy actor (${plan.blocked.tasks
        .map((t) => t.identifier)
        .join(", ")}); this repair owns comments and reports only`,
    );
  }
  if (plan.blocked.orphans.comments > 0 || plan.blocked.orphans.reports > 0) {
    throw new Error("refusing: a comment or report has no actor row; the board is not in a known state");
  }
  if (Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys) !== 1) {
    throw new Error("foreign keys are disabled; refusing to merge references");
  }

  const sql = triggerSql(db);
  const legacyIds = plan.legacy.map((row) => row.id);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of ATOMICITY_TRIGGERS) db.exec(`DROP TRIGGER ${name}`);

    if (plan.board.create) {
      db.prepare(
        `INSERT INTO actors (id, display_name, normalized_name, first_seen_at, last_seen_at, use_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        plan.board.id,
        plan.board.displayName,
        plan.board.normalizedName,
        plan.board.firstSeenAt,
        plan.board.lastSeenAt,
        plan.board.useCount,
      );
    } else if (plan.board.update) {
      db.prepare("UPDATE actors SET first_seen_at = ?, last_seen_at = ?, use_count = ? WHERE id = ?").run(
        plan.board.firstSeenAt,
        plan.board.lastSeenAt,
        plan.board.useCount,
        plan.board.id,
      );
    }

    const marks = placeholders(legacyIds.length);
    const movedComments = Number(
      db.prepare(`UPDATE comments SET author_id = ? WHERE author_id IN (${marks})`).run(plan.board.id, ...legacyIds).changes ?? 0,
    );
    const movedReports = Number(
      db.prepare(`UPDATE task_reports SET author_id = ? WHERE author_id IN (${marks})`).run(plan.board.id, ...legacyIds).changes ?? 0,
    );
    const deletedActors = Number(
      db.prepare(`DELETE FROM actors WHERE id IN (${marks})`).run(...legacyIds).changes ?? 0,
    );

    for (const name of ATOMICITY_TRIGGERS) db.exec(sql.get(name));

    // Post-state, before COMMIT.
    if (movedComments !== plan.merged.comments || movedReports !== plan.merged.reports) {
      throw new Error(
        `post-state mismatch: moved ${movedComments}/${plan.merged.comments} comments, ${movedReports}/${plan.merged.reports} reports`,
      );
    }
    if (deletedActors !== legacyIds.length) {
      throw new Error(`post-state mismatch: deleted ${deletedActors} of ${legacyIds.length} legacy actors`);
    }
    const stillLegacy = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM actors WHERE normalized_name IN (${placeholders(LEGACY_ACTOR_NAMES.length)})`)
        .get(...LEGACY_ACTOR_NAMES).n,
    );
    if (stillLegacy !== 0) throw new Error("post-state mismatch: a legacy actor row survived");
    const afterComments = Number(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE author_id = ?").get(plan.board.id).n);
    const afterReports = Number(db.prepare("SELECT COUNT(*) AS n FROM task_reports WHERE author_id = ?").get(plan.board.id).n);
    if (afterComments !== plan.counts.boardComments + plan.merged.comments) {
      throw new Error(`post-state mismatch: Board has ${afterComments} comments, expected ${plan.counts.boardComments + plan.merged.comments}`);
    }
    if (afterReports !== plan.counts.boardReports + plan.merged.reports) {
      throw new Error(`post-state mismatch: Board has ${afterReports} reports, expected ${plan.counts.boardReports + plan.merged.reports}`);
    }
    const fkCheck = db.prepare("PRAGMA foreign_key_check").all();
    if (fkCheck.length > 0) throw new Error(`foreign_key_check reports ${fkCheck.length} violation(s)`);

    db.exec("COMMIT");
    return { mergedComments: movedComments, mergedReports: movedReports, deletedActors, boardId: plan.board.id };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Write the repair record next to the board's other logs. */
export function writeRepairRecord(dataDir, plan, result, backupPath) {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `repair-merge-automation-actor-${stamp()}.json`);
  const record = {
    at: new Date().toISOString(),
    backup: backupPath,
    board: { id: result.boardId, displayName: plan.board.displayName, kind: "system" },
    mergedComments: result.mergedComments,
    mergedReports: result.mergedReports,
    deletedActors: result.deletedActors,
    legacy: plan.legacy,
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function parseArgs(argv) {
  const args = { apply: false, force: false, db: null, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--db") args.db = argv[++i];
    else if (arg === "--data-dir") args.dataDir = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (args.db === null && args.dataDir === null)) {
    console.log(
      "usage: merge-automation-actor.mjs (--db <board.sqlite> | --data-dir <dir>) [--apply] [--force]",
    );
    return args.help ? 0 : 2;
  }

  const dbPath = args.db ?? join(args.dataDir, "board.sqlite");
  if (!existsSync(dbPath)) throw new Error(`no board at ${dbPath}`);

  const db = openBoard(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const plan = planMerge(db);
    console.log(formatPlan(plan));
    if (!args.apply) {
      console.log("\ndry run — nothing written. Re-run with --apply to merge the rows.");
      return 0;
    }
    if (plan.legacy.length === 0) {
      console.log("nothing to merge.");
      return 0;
    }
    if (args.dataDir !== null) assertBoardStopped(args.dataDir, { force: args.force });

    const dataDir = args.dataDir ?? dirname(dbPath);
    const backupPath = join(dataDir, "backups", `board.pre-automation-merge-${stamp()}.sqlite`);
    backupBoard(db, backupPath);
    const result = applyMerge(db, plan);
    const record = writeRepairRecord(dataDir, plan, result, backupPath);
    console.log(
      `\nmerged ${result.mergedComments} comment(s) and ${result.mergedReports} report(s) into ${plan.board.displayName}; deleted ${result.deletedActors} legacy actor(s).`,
    );
    console.log(`backup: ${backupPath}`);
    console.log(`record: ${record}`);
    return 0;
  } finally {
    db.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`repair failed: ${error.message}`);
    process.exitCode = 1;
  }
}
