/**
 * Step 12: the command context — the clock, the id source and the actor rules.
 *
 * Small, but every command depends on it: an unguarded context would let a write
 * happen with nobody's name on it, which is exactly what the audit trail exists
 * to prevent.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { SYSTEM_ACTOR, actorOf, createContext } from "../../../src/core/commands/context.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";
import { TS, cleanupTempDirs, createTempBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

describe("commands/context", () => {
  it("refuses to build a context without a database or repositories", () => {
    assert.throws(() => createContext({}), (err) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.deepEqual(err.details, { hasDb: false, hasRepos: false });
      return true;
    });
    assert.throws(() => createContext({ db: {} }), (err) => err.details.hasRepos === false);
  });

  it("stamps from the injected clock and falls back to the wall clock", async () => {
    const board = await createTempBoard();
    try {
      const repos = createRepositories(board.db);
      assert.equal(createContext({ db: board.db, repos, clock: () => TS }).now(), TS);
      assert.equal(
        createContext({ db: board.db, repos, clock: () => new Date("2026-10-08T08:00:00+08:00") }).now(),
        TS,
        "a Date is normalised to UTC milliseconds",
      );
      assert.match(createContext({ db: board.db, repos }).now(), /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
      assert.throws(
        () => createContext({ db: board.db, repos, clock: () => "not a date" }).now(),
        (err) => err.code === "VALIDATION_FAILED",
      );
    } finally {
      board.close();
    }
  });

  it("mints ids from the factory it was given", async () => {
    const board = await createTempBoard();
    try {
      const repos = createRepositories(board.db);
      let n = 0;
      const ctx = createContext({ db: board.db, repos, idFactory: () => `id-${(n += 1)}` });
      assert.equal(ctx.newId(), "id-1");
      assert.equal(ctx.newId(), "id-2");
      assert.match(createContext({ db: board.db, repos }).newId(), /^[0-9a-f-]{36}$/);
    } finally {
      board.close();
    }
  });

  it("normalises actors, and refuses a write with nobody behind it", () => {
    assert.deepEqual(actorOf({ kind: "human", id: "Terry" }), { kind: "human", id: "Terry" });
    assert.deepEqual(actorOf({ id: "linus" }), { kind: "agent", id: "linus" }, "agents are the default");
    assert.deepEqual(actorOf("linus"), { kind: "agent", id: "linus" }, "a bare string is an actor id");
    assert.deepEqual(actorOf("linus", { defaultKind: "human" }), { kind: "human", id: "linus" });
    assert.deepEqual(actorOf({ kind: "system", id: "taskd" }), SYSTEM_ACTOR);

    for (const bad of [null, undefined]) {
      assert.throws(() => actorOf(bad), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.details.field, "actor");
        return true;
      });
    }
    assert.throws(() => actorOf({ kind: "agent" }), (err) => err.details.field === "actor.id");
    assert.throws(() => actorOf({ kind: "agent", id: "  " }), (err) => err.details.field === "actor.id");
    assert.throws(() => actorOf({ kind: "ghost", id: "x" }), (err) => {
      assert.equal(err.details.field, "actor.kind");
      assert.deepEqual(err.details.allowed, ["agent", "human", "system"]);
      return true;
    });
  });
});
