/**
 * Tiny, dependency-free SQL text reader for the contract tests.
 *
 * It does not try to be a SQL parser — it recognises the handful of shapes the
 * migration files are allowed to use (CREATE TABLE / CREATE INDEX / CREATE
 * TRIGGER / RAISE(ABORT,'CODE') / `CHECK (col IN (...))`) and fails loudly on
 * anything it cannot read. The point is to keep the SQL and the JS constants
 * honest in both directions.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Remove `-- line` and `/* block *\/` comments. */
export function stripSqlComments(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl - 1;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    out += sql[i];
  }
  return out;
}

/** Split into statements on `;` (no statement body contains a top-level `;`). */
export function splitStatements(sql) {
  return stripSqlComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const CREATE_TABLE_RE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i;
const DROP_TABLE_RE = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i;
const RENAME_RE = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)/i;

/**
 * One pass over the statements, following **drops and renames**, so the reader
 * sees the schema this history *ends* with rather than a transcript of every
 * statement in it.
 *
 * Both are load-bearing for a rebuild, which is how SQLite widens a `CHECK`
 * (there is no `ALTER TABLE … MODIFY`):
 *
 *   * create scratch + `ALTER TABLE scratch RENAME TO real` — one table, and it
 *     is called `real`. Reading the scratch name as a second table would report
 *     a schema change that never happened;
 *   * `DROP TABLE old` before that rename — without following the drop, the
 *     superseded table would still be counted, and `tasks` would look like it
 *     had been created twice.
 *
 * @returns {{created: {name: string, dropped: boolean}[], checks: {entry: {name: string, dropped: boolean}, column: string, literals: string[]}[]}}
 */
function readSchema(sql) {
  /** @type {{name: string, dropped: boolean}[]} */
  const created = [];
  /** @type {Map<string, {name: string, dropped: boolean}>} */
  const byName = new Map();
  /** @type {{entry: object, column: string, literals: string[]}[]} */
  const checks = [];

  for (const stmt of splitStatements(sql)) {
    const create = CREATE_TABLE_RE.exec(stmt);
    if (create !== null) {
      const entry = { name: create[1].toLowerCase(), dropped: false };
      created.push(entry);
      byName.set(entry.name, entry);
      // A fresh regex per statement: `lastIndex` is state, and this reader must
      // not depend on the previous statement having exhausted it.
      const re = /CHECK\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s+IN\s*\(([^)]*)\)\s*\)/gi;
      for (const m of stmt.matchAll(re)) {
        checks.push({
          entry,
          column: m[1].toLowerCase().split(".").pop(),
          literals: m[2]
            .split(",")
            .map((token) => token.trim())
            .filter((token) => token !== "")
            .map((token) => {
              if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
              // 0033/0035 — `is_rollup IN (0, 1)` is a numeric storage flag, not
              // a word vocabulary. Reading it keeps the parity check honest,
              // instead of silently treating the set as empty.
              const numeric = Number(token);
              if (!Number.isFinite(numeric)) {
                throw new Error(`sql-parse: cannot read the IN literal ${JSON.stringify(token)}`);
              }
              return numeric;
            }),
        });
      }
      continue;
    }

    const dropped = DROP_TABLE_RE.exec(stmt);
    if (dropped !== null) {
      const name = dropped[1].toLowerCase();
      const entry = byName.get(name);
      if (entry !== undefined) {
        entry.dropped = true;
        byName.delete(name);
      }
      continue;
    }

    const renamed = RENAME_RE.exec(stmt);
    if (renamed !== null) {
      const entry = byName.get(renamed[1].toLowerCase());
      if (entry !== undefined) {
        byName.delete(entry.name);
        entry.name = renamed[2].toLowerCase();
        byName.set(entry.name, entry);
      }
    }
  }

  return { created, checks };
}

/**
 * All `CREATE TABLE` names, in file order, each reported under the name it ends
 * up with — and a table the history later drops is not reported at all.
 */
export function tableNames(sql) {
  return readSchema(sql)
    .created.filter((entry) => !entry.dropped)
    .map((entry) => entry.name);
}

/** All `CREATE [UNIQUE] INDEX` names. */
export function indexNames(sql) {
  const names = [];
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of stripSqlComments(sql).matchAll(re)) names.push(m[1].toLowerCase());
  return names;
}

/** All `CREATE TRIGGER` names. */
export function triggerNames(sql) {
  const names = [];
  const re = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of stripSqlComments(sql).matchAll(re)) names.push(m[1].toLowerCase());
  return names;
}

/** All `ALTER TABLE <t> ADD COLUMN <c>` pairs. */
export function addedColumns(sql) {
  const out = [];
  const re =
    /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of stripSqlComments(sql).matchAll(re)) {
    out.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return out;
}

/** Every `RAISE(ABORT, 'CODE')` (or ROLLBACK/FAIL) reason code, in file order. */
export function raisedCodes(sql) {
  const codes = [];
  const re = /RAISE\s*\(\s*(?:ABORT|ROLLBACK|FAIL)\s*,\s*'([A-Z0-9_]+)'\s*\)/gi;
  for (const m of stripSqlComments(sql).matchAll(re)) codes.push(m[1]);
  return codes;
}

/**
 * `"table.column"` → sorted literals, for every `CHECK (<col> IN (...))`.
 *
 * Renames are followed, so a table rebuilt under a scratch name is reported
 * under the name it ends up with — and its CHECK is the one that survives. That
 * is the whole point: after a `CHECK`-widening rebuild, `tasks.status` must read
 * as the widened set, not as 0001's original.
 *
 * @returns {Map<string, string[]>}
 */
export function checkInSets(sql) {
  const out = new Map();
  // Applied in statement order, so a later file's re-declaration still wins —
  // which is what makes a widened CHECK in a rebuild the one that counts.
  for (const { entry, column, literals } of readSchema(sql).checks) {
    if (entry.dropped) continue;
    out.set(`${entry.name}.${column}`, literals.sort());
  }
  return out;
}

/** Statement text for every `CREATE TRIGGER <name>` (up to its `END;`). */
export function triggerBodies(sql) {
  const out = new Map();
  const re = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)([\s\S]*?)END\s*;/gi;
  for (const m of stripSqlComments(sql).matchAll(re)) {
    out.set(m[1].toLowerCase(), `${m[1]}${m[2]}END;`);
  }
  return out;
}

/**
 * Read every `NNNN_*.sql` in `dir`, sorted by version.
 *
 * @param {string} dir
 * @returns {{version: string, name: string, file: string, sql: string}[]}
 */
export function readMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const version = file.slice(0, 4);
      return { version, name: file.slice(5, -4), file, sql: readFileSync(join(dir, file), "utf8") };
    });
}

/** Concatenated text of all migrations in `dir` (for whole-schema assertions). */
export function readAllMigrations(dir) {
  return readMigrationFiles(dir)
    .map((m) => m.sql)
    .join("\n");
}
