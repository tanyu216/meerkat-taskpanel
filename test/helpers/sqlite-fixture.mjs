/**
 * Throwaway boards for the storage/commands tests.
 *
 * Every board is a fresh temp directory — `.data/` is never touched, and the
 * card-shaped markdown in `~/.openclaw/team/tasks` is never read (F9). Call
 * `cleanupTempDirs()` from an `after` hook.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { applyMigrations } from "../../src/core/storage/migrations-runner.mjs";
import { ensureParentDir } from "../../src/core/storage/paths.mjs";
import { mapSqliteError } from "../../src/core/storage/sqlite-errors.mjs";

/** A fixed, millisecond-width UTC stamp — tests never depend on the wall clock. */
export const TS = "2026-10-08T00:00:00.000Z";
/** A second stamp, one minute later, for "after" assertions. */
export const TS2 = "2026-10-08T00:01:00.000Z";
/** Seven days + a minute after TS — the archive window (I6). */
export const TS_AFTER_ARCHIVE_WINDOW = "2026-10-15T00:01:00.000Z";

const tempDirs = [];

/** @param {string} [prefix] */
export function makeTempDir(prefix = "meerkat-taskpanel-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remove every temp dir created by this helper. */
export function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — a leftover temp dir must not fail a test run */
    }
  }
}

/** A clock that returns fixed (or sequential) stamps. */
export function fixedClock(...stamps) {
  let index = 0;
  const values = stamps.length > 0 ? stamps : [TS];
  return () => values[Math.min(index++, values.length - 1)];
}

/**
 * Open a migrated board in a temp directory.
 *
 * @param {{migrate?: boolean, prefix?: string}} [options]
 * @returns {Promise<{db: any, dir: string, dbPath: string, dataDir: string, close: () => void}>}
 */
export async function createTempBoard(options = {}) {
  const { migrate = true, prefix = "meerkat-taskpanel-board-" } = options;
  const dir = makeTempDir(prefix);
  const dataDir = join(dir, "data");
  const dbPath = join(dataDir, "board.sqlite");
  ensureParentDir(dbPath); // SQLite will not create the directory for us
  const db = await openDatabase({ path: dbPath });
  if (migrate) applyMigrations(db);
  return {
    db,
    dir,
    dbPath,
    dataDir,
    close() {
      closeDatabase(db);
    },
  };
}

/**
 * Run `fn` against a fresh board and always close it.
 * @template T
 * @param {(board: Awaited<ReturnType<typeof createTempBoard>>) => T|Promise<T>} fn
 * @param {{migrate?: boolean}} [options]
 */
export async function withBoard(fn, options = {}) {
  const board = await createTempBoard(options);
  try {
    return await fn(board);
  } finally {
    board.close();
  }
}

/**
 * Run a write and report the reason code it produced.
 *
 * This is how the contract tests talk to the database *directly* — no service
 * layer — so they prove the invariants live in the schema, not in a code path
 * someone might bypass.
 *
 * @param {() => unknown} fn
 * @returns {string} a reason code, or `"NO_ERROR"`
 */
export function reasonCode(fn) {
  try {
    fn();
    return "NO_ERROR";
  } catch (err) {
    return mapSqliteError(err).code;
  }
}

// ---------------------------------------------------------------------------
// Raw row builders (direct SQL on purpose — repositories are under test too)
// ---------------------------------------------------------------------------

/** @param {any} db */
export function insertProject(db, overrides = {}) {
  const row = {
    id: "proj",
    name: "Project",
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
  // Idempotent: most tests want "the project exists", not "create it exactly once".
  db.prepare(
    `INSERT OR IGNORE INTO projects(id, name, next_task_number, labels, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.next_task_number ?? 1,
    row.labels ?? "[]",
    row.meta_json ?? "{}",
    row.created_at,
    row.updated_at,
  );
  return row.id;
}

/** @param {any} db */
export function insertTask(db, overrides = {}) {
  const row = {
    id: "task-1",
    identifier: "PROJ-0001",
    project_id: "proj",
    title: "A task",
    status: "todo",
    created_at: TS,
    updated_at: TS,
    status_changed_at: TS,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks(id, identifier, project_id, title, description, status, priority, kind,
                       labels, sort_order, assignee_kind, assignee_id, reporter_id, creator_kind, creator_id,
                       claimed_by, claimed_at, heartbeat_at, blocked_at, status_changed_at,
                       archived_at, source_path, source_hash, version, idem, created_at, updated_at,
                       awaiting_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.identifier,
    row.project_id,
    row.title,
    row.description ?? "",
    row.status,
    row.priority ?? "medium",
    row.kind ?? "task",
    row.labels ?? "[]",
    row.sort_order ?? 0,
    row.assignee_kind ?? null,
    row.assignee_id ?? null,
    row.reporter_id ?? null,
    row.creator_kind ?? null,
    row.creator_id ?? null,
    row.claimed_by ?? null,
    row.claimed_at ?? null,
    row.heartbeat_at ?? null,
    row.blocked_at ?? null,
    row.status_changed_at,
    row.archived_at ?? null,
    row.source_path ?? null,
    row.source_hash ?? null,
    row.version ?? 1,
    row.idem ?? null,
    row.created_at,
    row.updated_at,
    row.awaiting_reason ?? null,
  );
  return row.id;
}

/**
 * Append a comment. `author_kind` is the field M1's resume rule reads, so it is
 * a first-class override rather than something a test has to smuggle through
 * `refs`.
 *
 * @param {any} db
 * @param {{id?: string, task_id?: string, body?: string, kind?: string, author_kind?: string, author_id?: string, created_at?: string}} [overrides]
 */
export function insertComment(db, overrides = {}) {
  const row = {
    id: "c-1",
    task_id: "task-1",
    body: "a comment",
    kind: "discuss",
    author_kind: "agent",
    author_id: "linus",
    created_at: TS,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, agent_session, refs_json, source_seq, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.task_id,
    row.body,
    row.kind,
    row.author_kind,
    row.author_id,
    row.agent_session ?? null,
    row.refs_json ?? "[]",
    row.source_seq ?? null,
    row.version ?? 1,
    row.created_at,
  );
  return row.id;
}

/** @param {any} db */
export function insertReport(db, overrides = {}) {
  const row = {
    task_id: "task-1",
    round: 1,
    conclusion: "done",
    acceptance_json: "[]",
    evidence_json: "[]",
    author_kind: "agent",
    author_id: "linus",
    created_at: TS,
    ...overrides,
  };
  const info = db
    .prepare(
      `INSERT INTO task_reports(task_id, round, seg, session_id, conclusion, acceptance_json,
                                evidence_json, leftovers, author_kind, author_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.task_id,
      row.round,
      row.seg ?? null,
      row.session_id ?? null,
      row.conclusion,
      row.acceptance_json,
      row.evidence_json,
      row.leftovers ?? null,
      row.author_kind,
      row.author_id,
      row.created_at,
    );
  return Number(info.lastInsertRowid);
}

/** Current global revision. @param {any} db */
export function revision(db) {
  return Number(db.prepare("SELECT revision FROM global_revision WHERE singleton = 1").get().revision);
}

/** Row count of a table. @param {any} db @param {string} table */
export function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}
