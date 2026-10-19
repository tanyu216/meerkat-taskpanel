/**
 * The shapes a "widening" migration test compares before and after.
 *
 * Four migration suites (`0013`, `0015`, `0018`, `0019`) each carried their own
 * copy of the same three things: a temp directory holding the migrations
 * *before* theirs, a named-index snapshot (name, uniqueness, partiality,
 * columns), and a whitespace-normalised trigger snapshot. The bodies had
 * drifted by a filter or a sort — never by meaning — so they live here with
 * those differences as arguments.
 *
 * This is test infrastructure, not production code: it reads the shipped
 * migration directory and copies files, exactly as the suites did.
 */

import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { defaultMigrationsDir } from "../../src/core/storage/migrations-runner.mjs";
import { makeTempDir } from "./sqlite-fixture.mjs";

/**
 * A temp migrations directory holding every shipped file **before** `version`.
 *
 * Selected by version prefix, not by name order: `!n.startsWith("0013")` would
 * keep 0014, which runs *after* 0013 and cannot belong to a board the previous
 * build left behind.
 *
 * Returns a thunk so a suite keeps its `before0013()`-style call sites.
 *
 * @param {string} version e.g. `"0015"`
 * @param {{prefix?: string}} [options]
 * @returns {() => string}
 */
export function migrationsBefore(version, { prefix = `meerkat-taskpanel-pre${version}-` } = {}) {
  return () => copyUpTo(version, { prefix, inclusive: false });
}

/**
 * A temp migrations directory holding every shipped file **through** `version`.
 *
 * Same rule as {@link migrationsBefore}, for a suite whose assertion is the
 * state its own migration produced and nothing later.
 *
 * @param {string} version e.g. `"0022"`
 * @param {{prefix?: string}} [options]
 * @returns {() => string}
 */
export function migrationsThrough(version, { prefix = `meerkat-taskpanel-through${version}-` } = {}) {
  return () => copyUpTo(version, { prefix, inclusive: true });
}

function copyUpTo(version, { prefix, inclusive }) {
  const dir = makeTempDir(prefix);
  const files = readdirSync(defaultMigrationsDir()).filter((name) => {
    if (!name.endsWith(".sql")) return false;
    const stamped = name.slice(0, 4);
    return inclusive ? stamped <= version : stamped < version;
  });
  for (const name of files) copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  return dir;
}

/**
 * The **named** indexes on one table, each with the shape that makes it itself.
 *
 * `pragma_index_list` also reports SQLite's own implicit index for a `TEXT`
 * primary key; it exists before and after a rebuild, is not ours to create, and
 * would only make the comparison look like drift.
 *
 * `exclude` names an index a *later* migration adds deliberately — the snapshot
 * is about the rebuilt table keeping the indexes it had, so a later migration's
 * own new index is named rather than the rule being loosened.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {{exclude?: string[]}} [options]
 */
export function indexShapesOf(db, table, { exclude = [] } = {}) {
  return db
    .prepare('SELECT name, "unique" AS uniq, partial AS part FROM pragma_index_list(?)')
    .all(table)
    .filter((row) => !row.name.startsWith("sqlite_autoindex") && !exclude.includes(row.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((row) => ({
      name: row.name,
      unique: Number(row.uniq),
      partial: Number(row.part),
      columns: db.prepare("SELECT name FROM pragma_index_info(?)").all(row.name).map((c) => c.name),
    }));
}

/** Every trigger's text, whitespace-normalised (whitespace is not meaning). */
export function triggersOf(db) {
  return Object.fromEntries(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => [
        r.name,
        String(r.sql)
          .replace(/\s+/g, " ")
          .replace(/CREATE TRIGGER IF NOT EXISTS /i, "CREATE TRIGGER ")
          .trim(),
      ]),
  );
}
