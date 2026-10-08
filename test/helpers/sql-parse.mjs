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

/** All `CREATE TABLE` names, in file order. */
export function tableNames(sql) {
  const names = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of stripSqlComments(sql).matchAll(re)) names.push(m[1].toLowerCase());
  return names;
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
 * @returns {Map<string, string[]>}
 */
export function checkInSets(sql) {
  const out = new Map();
  for (const stmt of splitStatements(sql)) {
    const tableMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(stmt);
    if (tableMatch === null) continue;
    const table = tableMatch[1].toLowerCase();
    const re = /CHECK\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s+IN\s*\(([^)]*)\)\s*\)/gi;
    for (const m of stmt.matchAll(re)) {
      const column = m[1].toLowerCase().split(".").pop();
      const literals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      out.set(`${table}.${column}`, literals.sort());
    }
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
