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
import { DatabaseSync } from "node:sqlite";

import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { applyMigrations } from "../../src/core/storage/migrations-runner.mjs";
import { ensureParentDir } from "../../src/core/storage/paths.mjs";
import { mapSqliteError } from "../../src/core/storage/sqlite-errors.mjs";
import { norm } from "../../src/shared/norm.mjs";

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

/**
 * Make sure an `actors` row exists for `value`, and return the id to reference it
 * by.
 *
 * `0020` made `tasks.claimed_by`, `comments.author_id` and
 * `task_reports.author_id` references to `actors(id)`, so a fixture that writes an
 * author or a claim must have an actor to point at. The row's **id is the given
 * value** — a fixture is synthetic, and this keeps a test's author assertion
 * reading the same string it passed in. A board without `actors` (pre-0019) is
 * left alone: those columns are free strings there and carry no foreign key.
 *
 * @param {any} db
 * @param {string|null|undefined} value
 * @param {string} [kind]
 * @returns {string|null|undefined}
 */
export function ensureActor(db, value, kind = "agent") {
  if (value === null || value === undefined || value === "") return value;
  const hasActors =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actors'").get() !== undefined;
  if (!hasActors) return value;
  let key;
  try {
    key = norm(String(value));
  } catch {
    return value; // a blank value can never be an actor; let the write fail loudly
  }
  db.prepare(
    `INSERT OR IGNORE INTO actors(id, kind, display_name, normalized_name, first_seen_at, last_seen_at, use_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(String(value), kind, String(value), key, TS, TS);
  return String(value);
}

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
  // Five columns come and go across the migration history, and a fixture must
  // not name a column the board it is building does not have:
  //
  //   * `awaiting_reason` arrives with 0013;
  //   * `blocked_reason` arrives with 0016;
  //   * `assignee_kind`, `creator_kind`, `creator_id` are **removed** by 0019
  //     (the kind moved onto the actor, and the creator IS the reporter).
  //
  // Asking the schema (rather than a flag the caller has to remember) is what
  // keeps one helper usable against a legacy board and against a 0019 board.
  const columns = new Set(
    db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name),
  );
  const pairs = [
    ["id", row.id],
    ["identifier", row.identifier],
    ["project_id", row.project_id],
    ["title", row.title],
    ["description", row.description ?? ""],
    ["status", row.status],
    ["priority", row.priority ?? "medium"],
    ["kind", row.kind ?? "task"],
    ["labels", row.labels ?? "[]"],
    ["sort_order", row.sort_order ?? 0],
    ["assignee_id", ensureActor(db, row.assignee_id ?? null)],
    ["reporter_id", ensureActor(db, row.reporter_id ?? null)],
    ["claimed_by", ensureActor(db, row.claimed_by ?? null)],
    ["claimed_at", row.claimed_at ?? null],
    ["heartbeat_at", row.heartbeat_at ?? null],
    ["blocked_at", row.blocked_at ?? null],
    ["status_changed_at", row.status_changed_at],
    ["archived_at", row.archived_at ?? null],
    ["source_path", row.source_path ?? null],
    ["source_hash", row.source_hash ?? null],
    ["version", row.version ?? 1],
    ["idem", row.idem ?? null],
    ["created_at", row.created_at],
    ["updated_at", row.updated_at],
  ];
  const optional = [
    ["assignee_kind", row.assignee_kind ?? null],
    ["creator_kind", row.creator_kind ?? null],
    ["creator_id", row.creator_id ?? null],
    ["awaiting_reason", row.awaiting_reason ?? null],
    ["blocked_reason", row.blocked_reason ?? null],
  ];
  for (const [column, value] of optional) {
    if (columns.has(column)) pairs.push([column, value]);
  }
  const baseColumns = pairs.map(([column]) => column);
  const values = pairs.map(([, value]) => value);
  db.prepare(
    `INSERT INTO tasks(${baseColumns.join(", ")}) VALUES (${baseColumns.map(() => "?").join(", ")})`,
  ).run(...values);
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
    ensureActor(db, row.author_id, row.author_kind),
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
      ensureActor(db, row.author_id, row.author_kind),
      row.created_at,
    );
  return Number(info.lastInsertRowid);
}

/** Current global revision. @param {any} db */
export function revision(db) {
  return Number(db.prepare("SELECT revision FROM global_revision WHERE singleton = 1").get().revision);
}

/**
 * An actor id → its name, read straight off a board **file**.
 *
 * For the wire-level suites (the CLI and the HTTP surface), where `author_id` /
 * `claimed_by` are actor ids since 0020 and — until Phase 7 puts an actor ref on
 * the wire — the displayed name lives only in the `actors` table. The board is
 * opened read-only, so this never runs a migration or takes a write lock on a
 * board a spawned `taskd` is serving.
 *
 * @param {string} dbPath
 * @param {string|null|undefined} id
 * @returns {string|null|undefined}
 */
export function actorNameOnBoard(dbPath, id) {
  if (id === null || id === undefined) return id;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT display_name FROM actors WHERE id = ?").get(id);
    return row === undefined ? id : row.display_name;
  } finally {
    db.close();
  }
}

/**
 * An actor id → the name it carries, so a test can assert "who claimed/wrote
 * this" without hard-coding the row's uuid. `0020` made the attribution columns
 * references, so the value a task/comment/report carries is an id; the *name* is
 * the fact the test means.
 *
 * @param {any} db
 * @param {string|null|undefined} id
 * @returns {string|null|undefined}
 */
export function actorName(db, id) {
  if (id === null || id === undefined) return id;
  const row = db.prepare("SELECT display_name FROM actors WHERE id = ?").get(id);
  return row === undefined ? id : row.display_name;
}

/** Row count of a table. @param {any} db @param {string} table */
export function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}
