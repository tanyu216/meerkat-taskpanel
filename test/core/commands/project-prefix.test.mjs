/**
 * T-20261012-235125 — the identifier prefix is part of a project's identity.
 *
 * `identifierPrefix` collapses a project id to the token its tasks are numbered
 * with: `openclaw-team`, `openclaw_team` and `openclaw.team` all become
 * `OPENCLAW-TEAM`, so two such projects both hand out `OPENCLAW-TEAM-0007` and
 * nothing on a card says which board it came from. Project ids are distinct
 * (they are the primary key), but the *prefix* was not checked across projects.
 *
 * These tests pin the new rule and, just as importantly, the two things it must
 * **not** do: it must not resurrect an empty-prefix project (that guard lives in
 * `identifierFor`, unchanged), and it must not refuse to read a board that
 * already contains colliding history.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { identifierPrefix } from "../../../src/shared/ids.mjs";
import { TS, cleanupTempDirs, countRows, withBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const HUMAN = { kind: "human", id: "Terry" };

async function board(fn) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, clock: () => TS });
    const commands = createCommands(ctx);
    return fn({ db, repos, commands });
  });
}

/** Create a project and return it, so a test can assert the happy path inline. */
function create(commands, id, name = id) {
  return commands.createProject({ id, name, actor: HUMAN });
}

describe("commands/project prefix uniqueness", () => {
  it("refuses ids that normalize to the same prefix (openclaw-team/_/. )", async () => {
    await board(({ db, commands }) => {
      assert.equal(identifierPrefix("openclaw-team"), "OPENCLAW-TEAM");
      assert.equal(identifierPrefix("openclaw_team"), "OPENCLAW-TEAM");
      assert.equal(identifierPrefix("openclaw.team"), "OPENCLAW-TEAM");

      assert.equal(create(commands, "openclaw-team").id, "openclaw-team");

      for (const clash of ["openclaw_team", "openclaw.team"]) {
        assert.throws(
          () => create(commands, clash),
          (err) => {
            assert.equal(err.code, "VALIDATION_FAILED");
            assert.equal(err.http, 400);
            assert.equal(err.details.field, "id");
            assert.equal(err.details.prefix, "OPENCLAW-TEAM");
            assert.equal(err.details.conflictProjectId, "openclaw-team");
            // The acceptance is explicit: the conflicting project id is *in the message*.
            assert.match(err.message, /openclaw-team/);
            return true;
          },
          clash,
        );
      }

      assert.equal(countRows(db, "projects"), 1, "a refused create writes no row");
      assert.equal(commands.getProject({ id: "openclaw_team" }), null);
      assert.equal(commands.listProjects().length, 1);
    });
  });

  it("treats a case difference as a collision", async () => {
    await board(({ db, commands }) => {
      create(commands, "Demo");
      for (const clash of ["demo", "DEMO", "dEmO"]) {
        assert.throws(
          () => create(commands, clash),
          (err) => err.code === "VALIDATION_FAILED" && err.details.conflictProjectId === "Demo",
          clash,
        );
      }
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("normalizes non-alphanumerics into one '-'-joined prefix (demo_x → DEMO-X)", async () => {
    await board(({ db, commands }) => {
      assert.equal(identifierPrefix("demo_x"), "DEMO-X");
      assert.equal(identifierPrefix("demo-x"), "DEMO-X");
      assert.equal(identifierPrefix("demo.x"), "DEMO-X");

      create(commands, "demo-x");
      // The project's own tasks are numbered with the normalized prefix.
      const task = commands.createTask({ projectId: "demo-x", title: "one", actor: HUMAN });
      assert.equal(task.identifier, "DEMO-X-0001");

      for (const clash of ["demo_x", "demo.x", "demo--x"]) {
        assert.throws(
          () => create(commands, clash),
          (err) => err.code === "VALIDATION_FAILED" && err.details.prefix === "DEMO-X",
          clash,
        );
      }
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("leaves the empty-prefix refusal on its existing path (not reimplemented here)", async () => {
    await board(({ db, commands }) => {
      // `###` has no usable prefix. Creating the project is allowed — that has
      // always been true — and the refusal still comes from `identifierFor`,
      // when the first identifier would be minted.
      create(commands, "###", "No prefix");
      assert.throws(
        () => commands.createTask({ projectId: "###", title: "nope", actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.match(err.message, /no usable identifier prefix/);
          return true;
        },
      );
      assert.equal(countRows(db, "tasks"), 0, "the refusal happens before any insert");

      // Two prefixless projects are not a "collision" — the emptiness guard is
      // the one that answers, and it answers it for each of them independently.
      create(commands, "***", "Also no prefix");
      assert.equal(commands.listProjects().length, 2);
    });
  });

  it("is deterministic: the same clash refuses with the same message every time", async () => {
    await board(({ commands }) => {
      create(commands, "alpha-beta");
      const first = capture(() => create(commands, "alpha_beta"));
      const second = capture(() => create(commands, "alpha_beta"));
      assert.equal(first.code, "VALIDATION_FAILED");
      assert.equal(first.details.conflictProjectId, "alpha-beta");
      assert.equal(second.message, first.message);
      assert.equal(second.details.conflictProjectId, first.details.conflictProjectId);
    });
  });

  it("still reserves the prefix of an archived project", async () => {
    await board(({ db, commands }) => {
      create(commands, "keep-me");
      db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(TS, "keep-me");
      assert.equal(commands.listProjects().length, 0, "archived, so absent from the default list");
      assert.throws(
        () => create(commands, "keep_me"),
        (err) => err.code === "VALIDATION_FAILED" && err.details.conflictProjectId === "keep-me",
      );
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("exactly one of two colliding creates lands (single writer + BEGIN IMMEDIATE)", async () => {
    await board(({ db, commands }) => {
      const outcomes = ["x-y", "x_y"].map((id) => {
        try {
          create(commands, id);
          return "created";
        } catch (err) {
          assert.equal(err.code, "VALIDATION_FAILED");
          return "refused";
        }
      });
      assert.deepEqual(outcomes, ["created", "refused"]);
      assert.equal(countRows(db, "projects"), 1);
    });
  });
});

describe("commands/project prefix — historical data", () => {
  it("reads a board whose projects already collide, and names one on a new clash", async () => {
    await board(({ db, repos, commands }) => {
      // History the board never rejected: write straight through the repository,
      // exactly as an import would have.
      repos.projects.create({ id: "legacy_team", name: "Legacy team", now: TS });
      repos.projects.create({ id: "legacy-team", name: "Legacy team (dash)", now: TS });

      // Reading is unaffected — nothing is renamed, nothing fails.
      const listed = commands.listProjects();
      assert.deepEqual(listed.map((p) => p.id).sort(), ["legacy-team", "legacy_team"]);
      assert.equal(commands.getProject({ id: "legacy_team" }).name, "Legacy team");

      // A third id with the same prefix is refused, deterministically naming the
      // lowest-sorted of the two existing owners.
      assert.throws(
        () => create(commands, "legacy.team"),
        (err) =>
          err.code === "VALIDATION_FAILED" &&
          err.details.prefix === "LEGACY-TEAM" &&
          err.details.conflictProjectId === "legacy-team",
      );

      // A distinct prefix is still creatable on the same board.
      assert.equal(create(commands, "other").id, "other");
      assert.equal(countRows(db, "projects"), 3);
    });
  });
});

/** Run `fn`, require it to throw, and return the thrown error. */
function capture(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: "expected fn to throw" });
}
