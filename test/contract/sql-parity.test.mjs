/**
 * Step 3 (turns green with the SQL in steps 5–6): the migration SQL and the JS
 * vocabulary must agree, in both directions.
 *
 * Read from the files — never from the runner — so this is a genuine second
 * opinion. If a table, an enum literal or a `RAISE` code lives on only one
 * side, the test names it.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { SQL_ENUM_SETS } from "../../src/core/domain/enums.mjs";
import { REVISION_TABLES, TABLES, revisionTriggerNames } from "../../src/core/storage/schema.mjs";
import { DB_RAISE_CODES, ERROR_CODES } from "../../src/shared/errors.mjs";
import {
  addedColumns,
  checkInSets,
  indexNames,
  raisedCodes,
  readMigrationFiles,
  tableNames,
  triggerNames,
} from "../helpers/sql-parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIR = resolve(ROOT, "src/core/storage/migrations");

const files = readMigrationFiles(MIGRATIONS_DIR);
const allSql = files.map((f) => f.sql).join("\n");

describe("contract/sql-parity — migration files", () => {
  it("finds the migration set and names every file NNNN_lower_snake.sql", () => {
    assert.ok(files.length >= 4, `expected at least 4 migrations, found ${files.length}`);
    for (const file of files) {
      assert.match(
        file.file,
        /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/,
        `${file.file} must be NNNN_lower_snake.sql`,
      );
    }
  });

  it("numbers migrations from 0001 with no gaps and no duplicates", () => {
    const versions = files.map((f) => f.version);
    assert.deepEqual(versions, versions.slice().sort(), "files must sort by version");
    assert.equal(new Set(versions).size, versions.length, "duplicate version number");
    assert.equal(versions[0], "0001");
    versions.forEach((version, i) => {
      assert.equal(version, String(i + 1).padStart(4, "0"), `gap before ${version}`);
    });
  });

  it("creates every declared table exactly once over the whole set", () => {
    const created = tableNames(allSql).sort();
    assert.deepEqual(
      [...new Set(created)].sort(),
      [...TABLES].sort(),
      "SQL tables must equal schema.mjs TABLES (both directions)",
    );
    assert.equal(created.length, new Set(created).size, "a table is created twice");
  });

  it("adds report_latest_id / delivery_round by ALTER, keeping migrations append-only", () => {
    const added = addedColumns(allSql).map((c) => `${c.table}.${c.column}`);
    assert.ok(added.includes("tasks.report_latest_id"), added.join(", "));
    assert.ok(added.includes("tasks.delivery_round"), added.join(", "));
  });

  it("wires a revision trigger for every write table", () => {
    const triggers = triggerNames(allSql);
    for (const name of revisionTriggerNames()) {
      assert.ok(triggers.includes(name), `missing ${name}`);
    }
    // and does not invent revision triggers for the two excluded tables
    for (const excluded of ["global_revision", "schema_migrations"]) {
      assert.equal(
        triggers.some((t) => t === `tr_rev_${excluded}_ins`),
        false,
        `revision trigger must not exist for ${excluded}`,
      );
    }
    assert.equal(REVISION_TABLES.length, 11);
  });
});

describe("contract/sql-parity — enums", () => {
  it("CHECK (... IN (...)) literal sets match domain/enums.mjs exactly", () => {
    const fromSql = checkInSets(allSql);
    const expected = new Map(
      Object.entries(SQL_ENUM_SETS).map(([key, values]) => [key, [...values].sort()]),
    );

    const missing = [...expected.keys()].filter((k) => !fromSql.has(k));
    const extra = [...fromSql.keys()].filter((k) => !expected.has(k));
    assert.deepEqual(missing, [], "declared in JS but no CHECK in SQL");
    assert.deepEqual(extra, [], "CHECK in SQL but not declared in domain/enums.mjs");

    for (const [key, literals] of expected) {
      assert.deepEqual(fromSql.get(key), literals, `enum drift at ${key}`);
    }
  });

  it("rejects any status literal in SQL that the state machine does not know", () => {
    const statusLiterals = new Set(checkInSets(allSql).get("tasks.status") ?? []);
    assert.deepEqual([...statusLiterals].sort(), [
      "backlog",
      "blocked",
      "canceled",
      "done",
      "in_progress",
      "in_review",
      "todo",
    ]);
  });
});

describe("contract/sql-parity — reason codes", () => {
  it("RAISE codes in SQL are exactly the DB_RAISE_CODES bucket", () => {
    const fromSql = [...new Set(raisedCodes(allSql))].sort();
    assert.deepEqual(fromSql, [...DB_RAISE_CODES].sort());
  });

  it("every raised code is a declared error code with an HTTP status", () => {
    for (const code of raisedCodes(allSql)) {
      assert.ok(Object.hasOwn(ERROR_CODES, code), `${code} raised by SQL but unknown to errors.mjs`);
      assert.equal(typeof ERROR_CODES[code].http, "number", code);
    }
  });

  it("names indexes with the ux_/ix_ prefixes the error mapper relies on", () => {
    const indexes = indexNames(allSql);
    assert.ok(indexes.length >= 8, `suspiciously few indexes: ${indexes.length}`);
    for (const name of indexes) {
      assert.match(name, /^(ux|ix)_[a-z0-9_]+$/, `${name} must be ux_*/ix_*`);
    }
  });
});
