/**
 * 0007 — the intake request's state machine, against a real board.
 *
 * The command layer owns the rules a second writer cannot skip: the text bound,
 * the project reference, the idempotent submit, and the two terminal
 * transitions with their compare-and-set and their contradiction. Each write
 * lands beside its `task_activities` row in one transaction, so every test that
 * reads state also asserts the signal that told the world.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { INTAKE_TEXT_MAX } from "../../../src/foundation/constants.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { cleanupTempDirs, countRows, withBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const HUMAN = { kind: "human", id: "Terry" };
const DIRECTOR = { kind: "claude", id: "Director" };
const BOARD = { kind: "system", id: "Board" };
const T0 = "2026-11-11T00:00:00.000Z";

/** A board with a fixed clock and the human's project. */
async function board(fn) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, clock: () => T0 });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
    return fn({ db, repos, ctx, commands });
  });
}

const activities = (db, event) =>
  db.prepare("SELECT * FROM task_activities WHERE event = ? ORDER BY id").all(event);

describe("commands/intake — submit", () => {
  it("writes one pending request and its intake_requested signal", async () => {
    await board(({ db, commands }) => {
      const request = commands.createIntake({
        projectId: "proj",
        text: "  Fix the board's blank first paint  ",
        actor: HUMAN,
      });
      assert.equal(request.status, "pending");
      assert.equal(request.text, "Fix the board's blank first paint", "the stored text is trimmed");
      assert.equal(request.projectId, "proj");
      assert.equal(request.createdBy, "Terry");
      assert.equal(request.createdKind, "human");
      assert.equal(request.settledAt, null);
      assert.deepEqual(request.createdRefs, []);
      assert.equal(countRows(db, "intake_requests"), 1);

      const rows = activities(db, "intake_requested");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].task_id, null, "an intake request is not a card");
      assert.equal(rows[0].actor_id, "Terry");
      assert.deepEqual(JSON.parse(rows[0].changes_json), {
        intake_id: request.id,
        project_id: "proj",
      });
    });
  });

  it("refuses an unknown project, empty text, and text past the bound", async () => {
    await board(({ db, commands }) => {
      assert.throws(
        () => commands.createIntake({ projectId: "nope", text: "x", actor: HUMAN }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "project_id",
      );
      assert.throws(
        () => commands.createIntake({ projectId: "proj", text: "   ", actor: HUMAN }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "text",
      );
      assert.throws(
        () =>
          commands.createIntake({
            projectId: "proj",
            text: "x".repeat(INTAKE_TEXT_MAX + 1),
            actor: HUMAN,
          }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "text",
      );
      assert.equal(countRows(db, "intake_requests"), 0);
      assert.equal(activities(db, "intake_requested").length, 0);
    });
  });

  it("a repeated idempotency key returns the first request", async () => {
    await board(({ db, commands }) => {
      const first = commands.createIntake({
        projectId: "proj",
        text: "One description",
        idem: "click-1",
        actor: HUMAN,
      });
      const second = commands.createIntake({
        projectId: "proj",
        text: "One description, corrected",
        idem: "click-1",
        actor: HUMAN,
      });
      assert.equal(second.id, first.id, "the retried submit is the same request");
      assert.equal(second.text, "One description");
      assert.equal(countRows(db, "intake_requests"), 1);
      assert.equal(activities(db, "intake_requested").length, 1);
    });
  });

  it("the same key in another project is another request", async () => {
    await board(({ db, commands }) => {
      commands.createProject({ id: "othr", name: "Other", actor: HUMAN });
      const one = commands.createIntake({ projectId: "proj", text: "a", idem: "k", actor: HUMAN });
      const two = commands.createIntake({ projectId: "othr", text: "a", idem: "k", actor: HUMAN });
      assert.notEqual(two.id, one.id);
      assert.equal(countRows(db, "intake_requests"), 2);
    });
  });
});

describe("commands/intake — reads", () => {
  it("lists oldest first and filters by status and project", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "othr", name: "Other", actor: HUMAN });
      const a = commands.createIntake({ projectId: "proj", text: "a", actor: HUMAN });
      const b = commands.createIntake({ projectId: "othr", text: "b", actor: HUMAN });
      commands.completeIntake({ id: a.id, refs: ["TP-1"], actor: DIRECTOR });

      assert.deepEqual(
        commands.listIntake({}).map((row) => row.id),
        [a.id, b.id],
      );
      assert.deepEqual(
        commands.listIntake({ status: "pending" }).map((row) => row.id),
        [b.id],
      );
      assert.deepEqual(
        commands.listIntake({ projectId: "proj" }).map((row) => row.id),
        [a.id],
      );
      assert.equal(commands.listIntake({ limit: 1 }).length, 1);
    });
  });

  it("an unknown id is INTAKE_NOT_FOUND", async () => {
    await board(({ commands }) => {
      assert.throws(
        () => commands.getIntake({ id: "missing" }),
        (err) => err.code === "INTAKE_NOT_FOUND" && err.http === 404,
      );
    });
  });
});

describe("commands/intake — settlement", () => {
  it("complete records the refs and the decision lane's signature", async () => {
    await board(({ db, commands }) => {
      const request = commands.createIntake({ projectId: "proj", text: "a", actor: HUMAN });
      const settled = commands.completeIntake({
        id: request.id,
        refs: ["TP-1", " TP-2 ", "TP-1"],
        actor: DIRECTOR,
      });
      assert.equal(settled.status, "consumed");
      assert.deepEqual(settled.createdRefs, ["TP-1", "TP-2"], "trimmed and de-duplicated");
      assert.equal(settled.settledAt, T0);
      assert.equal(settled.settledBy, "Director");
      assert.equal(settled.settledByKind, "claude");

      const rows = activities(db, "intake_consumed");
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0].changes_json), {
        intake_id: request.id,
        refs: ["TP-1", "TP-2"],
      });

      // A second complete converges instead of appending a second decision.
      const again = commands.completeIntake({ id: request.id, refs: ["TP-3"], actor: DIRECTOR });
      assert.equal(again.status, "consumed");
      assert.deepEqual(again.createdRefs, ["TP-1", "TP-2"]);
      assert.equal(activities(db, "intake_consumed").length, 1);
    });
  });

  it("complete refuses a request that was failed", async () => {
    await board(({ db, commands }) => {
      const request = commands.createIntake({ projectId: "proj", text: "a", actor: HUMAN });
      commands.failIntake({ id: request.id, reason: "not work", actor: DIRECTOR });
      assert.throws(
        () => commands.completeIntake({ id: request.id, refs: ["TP-1"], actor: DIRECTOR }),
        (err) => err.code === "INVALID_TRANSITION" && err.http === 409,
      );
      assert.equal(countRows(db, "intake_requests"), 1);
      assert.equal(activities(db, "intake_consumed").length, 0);
    });
  });

  it("complete refuses an empty ref list", async () => {
    await board(({ commands }) => {
      const request = commands.createIntake({ projectId: "proj", text: "a", actor: HUMAN });
      assert.throws(
        () => commands.completeIntake({ id: request.id, refs: [], actor: DIRECTOR }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "created",
      );
    });
  });

  it("fail records the reason, converges on repeat, and refuses after consumed", async () => {
    await board(({ db, commands }) => {
      const request = commands.createIntake({ projectId: "proj", text: "a", actor: HUMAN });
      const failed = commands.failIntake({
        id: request.id,
        reason: "  the description names no outcome  ",
        actor: BOARD,
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, "the description names no outcome");
      assert.equal(failed.settledBy, "Board");
      assert.equal(failed.settledByKind, "system");
      assert.equal(activities(db, "intake_failed").length, 1);

      const again = commands.failIntake({ id: request.id, reason: "again", actor: BOARD });
      assert.equal(again.status, "failed");
      assert.equal(again.lastError, "the description names no outcome");
      assert.equal(activities(db, "intake_failed").length, 1);
    });
  });

  it("fail refuses a consumed request and an empty reason", async () => {
    await board(({ commands }) => {
      const request = commands.createIntake({ projectId: "proj", text: "a", actor: HUMAN });
      assert.throws(
        () => commands.failIntake({ id: request.id, reason: " ", actor: DIRECTOR }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "reason",
      );
      commands.completeIntake({ id: request.id, refs: ["TP-1"], actor: DIRECTOR });
      assert.throws(
        () => commands.failIntake({ id: request.id, reason: "too late", actor: DIRECTOR }),
        (err) => err.code === "INVALID_TRANSITION",
      );
    });
  });
});
