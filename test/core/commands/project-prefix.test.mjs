/**
 * T-20261012-235125 + M8 (2026-10-28) — the identifier prefix is part of a
 * project's identity, and creation now demands a 1-4 character `[A-Z0-9]` token.
 *
 * `identifierPrefix` collapses a project id to the token its tasks are numbered
 * with: `openclaw-team`, `openclaw_team` and `openclaw.team` all become
 * `OPENCLAW-TEAM`. Such a token is no longer a **creation** outcome (M8), but
 * rows that carry one already — imports, seeds, every board that predates the
 * rule — must keep reading and minting exactly as before.
 *
 * Two layers:
 *   - the create rule: uniqueness still refuses a case-only collision between
 *     two projects, now among the only prefixes creation can produce;
 *   - seeded legacy history: long and hyphenated prefixes arrive through
 *     `repos.projects.create` (the import/seed seam) and are read and allocated
 *     unchanged; the command still refuses to add to that history.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { identifierPrefix } from "../../../src/foundation/ids.mjs";
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

describe("project prefix · the create rule (M8)", () => {
  it("treats a case difference as a collision", async () => {
    await board(({ db, commands }) => {
      create(commands, "ab");
      for (const clash of ["AB", "aB", "Ab"]) {
        assert.throws(
          () => create(commands, clash),
          (err) =>
            err.code === "VALIDATION_FAILED" &&
            err.details.prefix === "AB" &&
            err.details.conflictProjectId === "ab",
          clash,
        );
      }
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("is deterministic: the same clash refuses with the same message every time", async () => {
    await board(({ commands }) => {
      create(commands, "ab");
      const first = capture(() => create(commands, "AB"));
      const second = capture(() => create(commands, "AB"));
      assert.equal(first.code, "VALIDATION_FAILED");
      assert.equal(first.details.conflictProjectId, "ab");
      assert.equal(second.message, first.message);
      assert.equal(second.details.conflictProjectId, first.details.conflictProjectId);
    });
  });

  it("still reserves the prefix of an archived project", async () => {
    await board(({ db, commands }) => {
      create(commands, "km");
      db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(TS, "km");
      assert.equal(commands.listProjects().length, 0, "archived, so absent from the default list");
      assert.throws(
        () => create(commands, "KM"),
        (err) => err.code === "VALIDATION_FAILED" && err.details.conflictProjectId === "km",
      );
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("exactly one of two colliding creates lands (single writer + BEGIN IMMEDIATE)", async () => {
    await board(({ db, commands }) => {
      const outcomes = ["xy", "XY"].map((id) => {
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

  it("still lets two distinct prefixes coexist and number their cards", async () => {
    await board(({ db, commands }) => {
      create(commands, "aa");
      create(commands, "bb");
      assert.equal(commands.createTask({ projectId: "aa", title: "one", actor: HUMAN }).identifier, "AA-0001");
      assert.equal(commands.createTask({ projectId: "bb", title: "one", actor: HUMAN }).identifier, "BB-0001");
      assert.equal(countRows(db, "projects"), 2);
    });
  });

  it("refuses an id outside the rule before any uniqueness question", async () => {
    await board(({ db, commands }) => {
      // The old normalizing examples are creation refusals now — the shape check
      // runs before `assertPrefixAvailable`, so none reaches the collision logic.
      for (const id of ["other", "demo-x", "###"]) {
        assert.throws(
          () => create(commands, id),
          (err) =>
            err.code === "VALIDATION_FAILED" &&
            err.details.field === "id" &&
            err.details.max === 4,
          id,
        );
      }
      assert.equal(countRows(db, "projects"), 0);
    });
  });
});

describe("project prefix · seeded legacy history (the repository seam)", () => {
  it("reads a board whose projects already collide, and mints each off its own id", async () => {
    await board(({ db, repos, commands }) => {
      // History the board never rejected: write straight through the repository,
      // exactly as an import would have.
      repos.projects.create({ id: "legacy_team", name: "Legacy team", now: TS });
      repos.projects.create({ id: "legacy-team", name: "Legacy team (dash)", now: TS });

      // Reading is unaffected — nothing is renamed, nothing fails.
      const listed = commands.listProjects();
      assert.deepEqual(listed.map((p) => p.id).sort(), ["legacy-team", "legacy_team"]);
      assert.equal(commands.getProject({ id: "legacy_team" }).name, "Legacy team");

      // Both keep minting the token their ids normalize to.
      assert.equal(identifierPrefix("legacy_team"), "LEGACY-TEAM", "the normalization itself is unchanged");
      assert.equal(
        commands.createTask({ projectId: "legacy_team", title: "one", actor: HUMAN }).identifier,
        "LEGACY-TEAM-0001",
      );
      assert.equal(
        commands.createTask({ projectId: "legacy-team", title: "one", actor: HUMAN }).identifier,
        "LEGACY-TEAM-0001",
      );

      // A distinct, in-rule project is still creatable on the same board.
      assert.equal(create(commands, "zz").id, "zz");
      assert.equal(commands.createTask({ projectId: "zz", title: "one", actor: HUMAN }).identifier, "ZZ-0001");
      assert.equal(countRows(db, "projects"), 3);
    });
  });

  it("keeps a repository-seeded MEERKAT-TASKPANEL row reading and minting", async () => {
    await board(({ repos, commands }) => {
      repos.projects.create({ id: "meerkat-taskpanel", name: "Meerkat TaskPanel", now: TS });

      assert.equal(commands.getProject({ id: "meerkat-taskpanel" }).name, "Meerkat TaskPanel");
      assert.equal(
        commands.createTask({ projectId: "meerkat-taskpanel", title: "one", actor: HUMAN }).identifier,
        "MEERKAT-TASKPANEL-0001",
      );
      assert.equal(
        commands.createTask({ projectId: "meerkat-taskpanel", title: "two", actor: HUMAN }).identifier,
        "MEERKAT-TASKPANEL-0002",
      );
    });
  });

  it("leaves the empty-prefix minting refusal on its existing path", async () => {
    await board(({ db, repos, commands }) => {
      // `###` can no longer be *created*, but a row that predates the rule still
      // reads; the refusal still comes from `identifierFor`, at the first card.
      repos.projects.create({ id: "###", name: "No prefix", now: TS });
      repos.projects.create({ id: "***", name: "Also no prefix", now: TS });
      assert.equal(commands.listProjects().length, 2);

      assert.throws(
        () => commands.createTask({ projectId: "###", title: "nope", actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.match(err.message, /no usable identifier prefix/);
          return true;
        },
      );
      assert.equal(countRows(db, "tasks"), 0, "the refusal happens before any insert");
    });
  });

  it("names one deterministic owner when legacy rows already collide", async () => {
    await board(({ db, repos, commands }) => {
      repos.projects.create({ id: "ab", name: "Legacy ab", now: TS });
      repos.projects.create({ id: "AB", name: "Legacy AB", now: TS });
      assert.equal(commands.listProjects().length, 2, "reading is unaffected");

      // "AB" sorts before "ab", so a third claimant is told about "AB" every time.
      assert.throws(
        () => create(commands, "Ab"),
        (err) =>
          err.code === "VALIDATION_FAILED" &&
          err.details.prefix === "AB" &&
          err.details.conflictProjectId === "AB",
      );
      assert.equal(countRows(db, "projects"), 2);
    });
  });

  it("refuses a new id outside the rule by shape, not by the seeded collision", async () => {
    await board(({ db, repos, commands }) => {
      repos.projects.create({ id: "legacy_team", name: "Legacy team", now: TS });
      repos.projects.create({ id: "legacy-team", name: "Legacy team (dash)", now: TS });

      // The old assertion here was a collision against the seeded pair. M8 runs
      // first now: the id's own token is outside the rule, so no prefix is
      // compared and no owner is named.
      assert.throws(
        () => create(commands, "legacy.team"),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.equal(err.details.field, "id");
          assert.equal(err.details.projectId, "legacy.team");
          assert.equal(err.details.prefix, "LEGACY-TEAM");
          assert.equal(err.details.max, 4);
          assert.equal(err.details.conflictProjectId, undefined);
          return true;
        },
      );
      assert.equal(countRows(db, "projects"), 2);
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
