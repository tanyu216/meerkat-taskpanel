/**
 * The physical schema's inventory — table names and revision coverage.
 *
 * `test/contract/sql-parity.test.mjs` reads the migration `.sql` files and
 * compares what they actually create against these lists, both directions: a
 * table added in SQL but not here (or vice versa) is a red test. Migration
 * version numbering lives here too so the runner and the tests agree.
 *
 * No I/O: the runner reads the files.
 */

/** Where migration files live, relative to this module. */
export const MIGRATIONS_DIRNAME = "migrations";

/** Migration file shape: `NNNN_lower_snake_name.sql`. */
export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** Every table the board owns, in dependency order (FK targets first). */
export const TABLES = Object.freeze([
  "projects",
  "assignees",
  "reporters",
  "tasks",
  "task_relations",
  "comments",
  "task_activities",
  "attachments",
  "agent_sessions",
  "task_reports",
  "global_revision",
  "schema_migrations",
]);

/**
 * Tables whose writes bump `global_revision`.
 *
 * Deliberately excludes `global_revision` itself (self-reference) and
 * `schema_migrations` (M0-style bookkeeping, not board content).
 */
export const REVISION_TABLES = Object.freeze([
  "projects",
  "assignees",
  "reporters",
  "tasks",
  "task_relations",
  "comments",
  "task_activities",
  "attachments",
  "agent_sessions",
  "task_reports",
]);

/** Trigger-name suffixes for the three revision triggers per table. */
export const REVISION_EVENTS = Object.freeze(["ins", "upd", "del"]);

/**
 * `tr_rev_<table>_<ins|upd|del>`.
 * @param {string} table
 * @param {"ins"|"upd"|"del"} event
 */
export function revisionTriggerName(table, event) {
  return `tr_rev_${table}_${event}`;
}

/** Every revision trigger name, sorted. */
export function revisionTriggerNames() {
  return REVISION_TABLES.flatMap((table) => REVISION_EVENTS.map((e) => revisionTriggerName(table, e))).sort();
}

/** The singleton row id of the `global_revision` cursor. */
export const GLOBAL_REVISION_SINGLETON = 1;
