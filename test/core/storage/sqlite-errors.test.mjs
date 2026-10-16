/**
 * Step 7: every way SQLite can refuse a write must come back as a reason code.
 *
 * The mapper is the seam between "the database is the machine guarantee" and
 * "the caller gets a `DomainError`". If a code is unmapped it degrades to
 * `VALIDATION_FAILED`, which is a silent loss of information — so this test
 * enumerates the whole map rather than sampling it.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import {
  SQLITE_ERRCODE,
  UNIQUE_COLUMNS_TO_CODE,
  UNIQUE_KEY_CODES,
  checkTextFrom,
  isSqliteError,
  mapSqliteError,
  notNullColumnsFrom,
  uniqueColumnsFrom,
  uniqueKey,
} from "../../../src/core/storage/sqlite-errors.mjs";
import {
  DB_RAISE_CODES,
  DomainError,
  ERROR_CODES,
  SQL_CONSTRAINT_CODES,
  TECHNICAL_ERROR_TEXT,
  toErrorPayload,
} from "../../../src/shared/errors.mjs";
import { cleanupTempDirs, ensureActor, insertProject, insertTask, reasonCode, withBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** A stand-in for a node:sqlite failure — same shape, no database needed. */
function sqliteFailure(errcode, message) {
  const err = new Error(message);
  err.errcode = errcode;
  err.code = "ERR_SQLITE_ERROR";
  err.errstr = "constraint failed";
  return err;
}

describe("storage/sqlite-errors — parsing", () => {
  it("reads columns out of a UNIQUE message regardless of the order SQLite prints them", () => {
    assert.deepEqual(uniqueColumnsFrom("UNIQUE constraint failed: tasks.project_id, tasks.identifier"), [
      "tasks.identifier",
      "tasks.project_id",
    ]);
    assert.deepEqual(uniqueColumnsFrom("UNIQUE constraint failed: rel.target_task_id"), [
      "rel.target_task_id",
    ]);
    assert.deepEqual(uniqueColumnsFrom("not a unique failure"), []);
    assert.equal(uniqueKey(["b.b", "a.a"]), "a.a, b.b");
  });

  it("reads CHECK and NOT NULL messages", () => {
    assert.equal(
      checkTextFrom("CHECK constraint failed: source_task_id <> target_task_id"),
      "source_task_id <> target_task_id",
    );
    assert.equal(checkTextFrom("something else"), "");
    assert.deepEqual(notNullColumnsFrom("NOT NULL constraint failed: tasks.title"), ["tasks.title"]);
    assert.deepEqual(notNullColumnsFrom("nope"), []);
  });

  it("recognises a sqlite-shaped error", () => {
    assert.equal(isSqliteError(sqliteFailure(SQLITE_ERRCODE.UNIQUE, "x")), true);
    assert.equal(isSqliteError(new TypeError("boom")), false);
    assert.equal(isSqliteError(null), false);
    assert.equal(isSqliteError("nope"), false);
  });
});

describe("storage/sqlite-errors — RAISE(ABORT,'CODE')", () => {
  it("passes through every code the migrations raise", () => {
    for (const code of DB_RAISE_CODES) {
      const mapped = mapSqliteError(sqliteFailure(SQLITE_ERRCODE.TRIGGER, code), { op: "test" });
      assert.ok(mapped instanceof DomainError, code);
      assert.equal(mapped.code, code, `${code} must survive the mapping`);
      assert.equal(mapped.http, ERROR_CODES[code].http, code);
      assert.match(mapped.message, /database rejected the write/);
      assert.equal(mapped.details.op, "test");
      assert.equal(mapped.cause.errcode, SQLITE_ERRCODE.TRIGGER);
    }
  });

  it("does not invent a code for a trigger that raises something unknown", () => {
    const mapped = mapSqliteError(sqliteFailure(SQLITE_ERRCODE.TRIGGER, "WHATEVER"));
    assert.equal(mapped.code, "VALIDATION_FAILED");
    assert.equal(mapped.details.unmappedRaise, "WHATEVER");
  });
});

describe("storage/sqlite-errors — constraint failures", () => {
  it("maps every declared unique key (100% of the table)", () => {
    for (const entry of UNIQUE_KEY_CODES) {
      const message = `UNIQUE constraint failed: ${entry.columns.join(", ")}`;
      for (const errcode of [SQLITE_ERRCODE.UNIQUE, SQLITE_ERRCODE.PRIMARYKEY]) {
        const mapped = mapSqliteError(sqliteFailure(errcode, message));
        assert.equal(
          mapped.code,
          entry.code,
          `${entry.columns.join(" + ")} (errcode ${errcode}) → ${mapped.code}`,
        );
      }
    }
    assert.equal(UNIQUE_KEY_CODES.length, Object.keys(UNIQUE_COLUMNS_TO_CODE).length);
  });

  it("reports an unknown unique key instead of guessing", () => {
    const mapped = mapSqliteError(sqliteFailure(SQLITE_ERRCODE.UNIQUE, "UNIQUE constraint failed: t.a, t.b"));
    assert.equal(mapped.code, "VALIDATION_FAILED");
    assert.equal(mapped.details.unmappedUnique, true);
    assert.deepEqual(mapped.details.columns, ["t.a", "t.b"]);
  });

  it("maps the CHECK texts that express an invariant", () => {
    const self = mapSqliteError(
      sqliteFailure(SQLITE_ERRCODE.CHECK, "CHECK constraint failed: source_task_id <> target_task_id"),
    );
    assert.equal(self.code, "SELF_REFERENCE");
    const direction = mapSqliteError(
      sqliteFailure(
        SQLITE_ERRCODE.CHECK,
        "CHECK constraint failed: relation_type <> 'related' OR source_task_id < target_task_id",
      ),
    );
    assert.equal(direction.code, "RELATION_DIRECTION_INVALID");
    // T-20261014-152924 — the tasks-table CHECK the board used to show verbatim.
    const backlog = mapSqliteError(
      sqliteFailure(SQLITE_ERRCODE.CHECK, "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'"),
    );
    assert.equal(backlog.code, "CLAIM_ON_BACKLOG");
    assert.equal(backlog.message, "A backlog task cannot hold a claim.");
    assert.equal(backlog.details.check, "claimed_by IS NULL OR status <> 'backlog'");
    assert.match(backlog.details.sqlite.message, /CHECK constraint failed/);

    const other = mapSqliteError(sqliteFailure(SQLITE_ERRCODE.CHECK, "CHECK constraint failed: version >= 1"));
    assert.equal(other.code, "VALIDATION_FAILED");
    assert.equal(other.details.check, "version >= 1");
    // An unmapped CHECK no longer echoes the expression either — it is a schema
    // detail, and it stays on `details.check` / `details.sqlite` instead.
    assert.equal(other.message, "Input failed validation.");
    assert.equal(other.message.includes("constraint failed"), false);
  });

  it("never lets engine text reach the message of any mapped failure", () => {
    // The acceptance-③ predicate, applied to every errcode the mapper knows:
    // the raw SQLite sentence may live on `details`, never on `message`.
    const forbidden = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;
    const samples = [
      [SQLITE_ERRCODE.CHECK, "CHECK constraint failed: version >= 1"],
      [SQLITE_ERRCODE.CHECK, "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'"],
      [SQLITE_ERRCODE.UNIQUE, "UNIQUE constraint failed: tasks.title, tasks.kind"],
      [SQLITE_ERRCODE.PRIMARYKEY, "UNIQUE constraint failed: nope.id"],
      [SQLITE_ERRCODE.NOTNULL, "NOT NULL constraint failed: tasks.title"],
      [SQLITE_ERRCODE.FOREIGNKEY, "FOREIGN KEY constraint failed"],
      [SQLITE_ERRCODE.TRIGGER, "NO_SUCH_RAISED_CODE"],
      [SQLITE_ERRCODE.CHECK, "CHECK constraint failed: source_task_id <> target_task_id"],
      [1, "SQLITE_ERROR: near \"x\": syntax error"],
      [SQLITE_ERRCODE.BUSY, "database is locked"],
    ];
    for (const [errcode, message] of samples) {
      const mapped = mapSqliteError(sqliteFailure(errcode, message));
      assert.equal(
        forbidden.test(mapped.message),
        false,
        `errcode ${errcode}: message echoed engine text — ${mapped.message}`,
      );
      assert.equal(forbidden.test(JSON.stringify(mapped.toJSON().message)), false);
    }
    for (const code of DB_RAISE_CODES) {
      const mapped = mapSqliteError(sqliteFailure(SQLITE_ERRCODE.TRIGGER, code));
      assert.equal(forbidden.test(mapped.message), false, code);
    }
  });

  it("maps missing rows to NOT_FOUND and missing values to VALIDATION_FAILED", () => {
    const fk = mapSqliteError(sqliteFailure(SQLITE_ERRCODE.FOREIGNKEY, "FOREIGN KEY constraint failed"));
    assert.equal(fk.code, "NOT_FOUND");
    assert.equal(fk.http, 404);
    assert.equal(fk.details.sqlite.errcode, SQLITE_ERRCODE.FOREIGNKEY);

    const notNull = mapSqliteError(
      sqliteFailure(SQLITE_ERRCODE.NOTNULL, "NOT NULL constraint failed: tasks.title"),
    );
    assert.equal(notNull.code, "VALIDATION_FAILED");
    assert.deepEqual(notNull.details.columns, ["tasks.title"]);
  });

  it("leaves a DomainError alone and wraps anything else", () => {
    const original = new DomainError("NOT_FOUND", { details: { a: 1 } });
    assert.equal(mapSqliteError(original), original);
    const wrapped = mapSqliteError(new TypeError("boom"));
    assert.equal(wrapped.code, "VALIDATION_FAILED");
    assert.equal(wrapped.message, "boom");
    assert.equal(mapSqliteError("just a string").code, "VALIDATION_FAILED");
  });

  it("redacts tokens that ride out on a database error", () => {
    const token = `td_${"ab12cd34".repeat(8)}`;
    const mapped = mapSqliteError(sqliteFailure(1, `near "x": syntax error while opening ${token}`));
    // T-20261014-152924 — the engine's sentence no longer reaches the message at
    // all (the code's own sentence is there instead), and the redaction still
    // holds on the surface that *does* carry it: `details.sqlite.message`.
    assert.equal(mapped.message.includes(token), false);
    assert.equal(JSON.stringify(mapped.details).includes(token), false);
    assert.match(mapped.details.sqlite.message, /td_\*\*\*\*/);
  });

  it("carries engine text on no code's envelope, mapped or hand-built", () => {
    // Acceptance ③ as a sweep over the *whole* vocabulary, not a sample: every
    // declared code (built by hand with a raw engine message — the case the
    // mapper is not the only producer of) and every errcode the mapper knows,
    // through `toErrorPayload` — the document `server/router.mjs` serialises.
    // The standalone reading of the same predicate is
    // `T-20261014-152924/scan-error-envelope.mjs`.
    for (const code of Object.keys(ERROR_CODES)) {
      const payload = toErrorPayload(new DomainError(code, { message: "CHECK constraint failed: x" }));
      assert.equal(TECHNICAL_ERROR_TEXT.test(payload.message), false, `${code}: ${payload.message}`);
    }
    for (const errcode of Object.values(SQLITE_ERRCODE)) {
      const payload = toErrorPayload(
        mapSqliteError(sqliteFailure(errcode, "UNIQUE constraint failed: tasks.id"), { op: "sweep" }),
      );
      assert.equal(TECHNICAL_ERROR_TEXT.test(payload.message), false, `errcode ${errcode}: ${payload.message}`);
    }
    // A non-DomainError throw is normalised the same way.
    const wrapped = toErrorPayload(sqliteFailure(SQLITE_ERRCODE.CHECK, "NOT NULL constraint failed: tasks.title"));
    assert.equal(TECHNICAL_ERROR_TEXT.test(wrapped.message), false, wrapped.message);
  });

  it("covers every SQL_CONSTRAINT_CODES bucket member with a reachable input", () => {
    const reachable = new Set(
      UNIQUE_KEY_CODES.map((entry) => entry.code).concat([
        "SELF_REFERENCE",
        "RELATION_DIRECTION_INVALID",
        // T-20261014-152924 — the `tasks` CHECK that forbids a claim on a
        // backlog card; mapped, and reachable straight from SQL (see
        // `test/contract/invariants.test.mjs`, "refuses a backlog task that
        // claims to be claimed").
        "CLAIM_ON_BACKLOG",
        "VALIDATION_FAILED",
        "NOT_FOUND",
        // R2: not a constraint, but the same mapper — a raw `SQLITE_BUSY` from
        // either the lock or the commit lands here.
        "DB_BUSY",
      ]),
    );
    const unreachable = SQL_CONSTRAINT_CODES.filter((code) => !reachable.has(code));
    assert.deepEqual(unreachable, [], `declared but never produced: ${unreachable.join(", ")}`);
  });
});

describe("storage/sqlite-errors — against a real database", () => {
  it("reaches the same codes through actual SQLite failures", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001" });
      insertTask(db, { id: "u", identifier: "PROJ-0002" });

      assert.equal(
        reasonCode(() =>
          db
            .prepare(
              "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('parent','t','t','x')",
            )
            .run(),
        ),
        "SELF_REFERENCE",
      );
      ensureActor(db, "a"); // comments.author_id is a reference since 0020
      db.prepare(
        "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, created_at) VALUES ('c','t','b','note','agent','a','x')",
      ).run();
      assert.equal(
        reasonCode(() => db.prepare("UPDATE comments SET body = 'x' WHERE id = 'c'").run()),
        "COMMENT_APPEND_ONLY",
      );
      assert.equal(
        reasonCode(() => db.prepare("INSERT INTO tasks(id,identifier,project_id,title,status,created_at,updated_at) VALUES('t2','PROJ-0001','proj','x','todo','x','x')").run()),
        "IDENTIFIER_CONFLICT",
      );
      assert.equal(
        reasonCode(() => db.prepare("INSERT INTO tasks(id,identifier,project_id,title,status,created_at,updated_at) VALUES('t3','PROJ-0003','nope','x','todo','x','x')").run()),
        "NOT_FOUND",
      );
      assert.equal(
        reasonCode(() => db.prepare("INSERT INTO tasks(id,identifier,project_id,title,status,created_at,updated_at) VALUES('t4','PROJ-0004','proj',NULL,'todo','x','x')").run()),
        "VALIDATION_FAILED",
      );
    });
  });
});
