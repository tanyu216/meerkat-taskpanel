/**
 * C-PREFIX-1 — the create-project `prefix` field is bound to the project's card
 * prefix (`design/contracts/project-prefix-binding.md`).
 *
 * A project's cards are numbered with a **prefix**, and that prefix has two
 * sources: the project's own, declared at creation as `meta.prefix` (the UI's
 * only prefix input) and normalized once on the way in, or — when none was
 * declared — the project's id, normalized, which is how every project that
 * predates the slot already behaves. These tests pin the binding, both refusal
 * paths that keep a project from becoming a "zombie" that can never mint a card
 * (M4: a declared prefix that normalizes to nothing) or from stealing an
 * existing project's numbers (M5), and the two things the slot must **not** do:
 * change the numbers of cards already on the board, and be writable after
 * creation (M6).
 *
 * `assertPrefixAvailable`'s collision side is pinned separately in
 * `project-prefix.test.mjs`, which also fixes the one case that must stay
 * allowed here: an **undeclared** prefix that normalizes to nothing (`--id ###`)
 * is refused by `identifierForPrefix` when the first identifier is minted, not
 * at creation.
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
    return fn({ db, repos, commands: createCommands(ctx) });
  });
}

/** Mint one card in `projectId` and hand back its identifier. */
function card(commands, projectId, title = "one") {
  return commands.createTask({ projectId, title, actor: HUMAN }).identifier;
}

/** The project's own stored prefix, or `undefined` when the slot is absent. */
function storedPrefix(commands, id) {
  return commands.getProject({ id }).meta.prefix;
}

describe("C-PREFIX-1 · a declared prefix numbers the project's cards", () => {
  it("binds a UI-shaped create (no id, meta.prefix) to the card prefix", async () => {
    await board(({ commands }) => {
      // Exactly what `CreateProjectModal.vue` posts: a name and a meta prefix,
      // no id — the project gets a freshly minted UUID.
      const project = commands.createProject({ name: "Demo", meta: { prefix: "demo" }, actor: HUMAN });
      assert.equal(project.id.startsWith("demo"), false, "the id stays opaque; it is not the prefix");
      assert.equal(project.meta.prefix, "DEMO", "stored normalized, once, at the boundary");

      assert.equal(card(commands, project.id), "DEMO-0001");
      assert.equal(card(commands, project.id), "DEMO-0002");
      for (let n = 3; n <= 10; n += 1) card(commands, project.id);
      assert.equal(card(commands, project.id), "DEMO-0011", "the counter keeps running past 10");
    });
  });

  it("normalizes with `identifierPrefix` — the fold, not just upper-casing", async () => {
    await board(({ commands }) => {
      // `or c` and `demo_x` are the contract's own examples; the second is only
      // reachable from the API/CLI, since the UI field caps at 4 characters.
      const spaced = commands.createProject({ name: "Orch", meta: { prefix: "or c" }, actor: HUMAN });
      assert.equal(spaced.meta.prefix, "OR-C");
      assert.equal(card(commands, spaced.id), "OR-C-0001");

      const underscored = commands.createProject({ name: "Demo X", meta: { prefix: "demo_x" }, actor: HUMAN });
      assert.equal(underscored.meta.prefix, "DEMO-X");
      assert.equal(card(commands, underscored.id), "DEMO-X-0001");
      assert.equal(card(commands, underscored.id), "DEMO-X-0002");
    });
  });

  it("takes the declared prefix over the id when both are given", async () => {
    await board(({ commands }) => {
      // The API takes an id *and* a meta.prefix; the slot wins, because it is
      // the one the allocator reads (M3).
      const project = commands.createProject({
        id: "some-id",
        name: "Both",
        meta: { prefix: "CHOSEN" },
        actor: HUMAN,
      });
      assert.equal(project.id, "some-id");
      assert.equal(card(commands, "some-id"), "CHOSEN-0001");
    });
  });

  it("keeps other meta keys alongside the reserved one", async () => {
    await board(({ commands }) => {
      const project = commands.createProject({
        name: "Mixed",
        meta: { prefix: "mix", owner: "linus" },
        actor: HUMAN,
      });
      assert.deepEqual(project.meta, { prefix: "MIX", owner: "linus" });
    });
  });
});

describe("C-PREFIX-1 · the undeclared path is unchanged (legacy)", () => {
  it("numbers off the id, and writes no prefix slot at all", async () => {
    await board(({ commands }) => {
      // The CLI shape (`project create --id demo`) and every row that predates
      // the slot: no meta.prefix, so nothing is stored and the id still decides.
      const project = commands.createProject({ id: "demo", name: "Demo", actor: HUMAN });
      assert.equal(storedPrefix(commands, "demo"), undefined, "an absent key is what keeps the fallback reachable");
      assert.equal(card(commands, "demo"), "DEMO-0001");
      assert.equal(card(commands, "demo"), "DEMO-0002");
    });
  });

  it("numbers a UUID-id project the way it always did", async () => {
    await board(({ commands }) => {
      const project = commands.createProject({ name: "Legacy", actor: HUMAN });
      assert.equal(card(commands, project.id), `${identifierPrefix(project.id)}-0001`);
    });
  });

  it("still refuses an undeclared prefix that normalizes to nothing — at the first card", async () => {
    await board(({ db, commands }) => {
      // M4 is about a *declared* prefix. `--id ###` declared none, so creation
      // is allowed (it always was) and `identifierForPrefix` answers instead.
      commands.createProject({ id: "###", name: "No prefix", actor: HUMAN });
      assert.throws(
        () => card(commands, "###"),
        (err) => err.code === "VALIDATION_FAILED" && /no usable identifier prefix/.test(err.message),
      );
      assert.equal(countRows(db, "tasks"), 0);
    });
  });
});

describe("C-PREFIX-1 · M4 — a declared prefix that normalizes to nothing is refused", () => {
  it("refuses `####`, leaves no row, and names the field", async () => {
    await board(({ db, commands }) => {
      assert.equal(identifierPrefix("####"), "", "the case M4 exists for");

      assert.throws(
        () => commands.createProject({ name: "Zombie", meta: { prefix: "####" }, actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.equal(err.http, 400);
          assert.equal(err.details.field, "meta.prefix");
          assert.equal(err.details.received, "####");
          return true;
        },
      );

      assert.equal(countRows(db, "projects"), 0, "the refusal happens before the insert");
      assert.equal(commands.listProjects().length, 0);
      assert.equal(commands.getProject({ id: "####" }), null);
    });
  });

  it("refuses whitespace and separator-only prefixes the same way", async () => {
    await board(({ db, commands }) => {
      for (const prefix of ["   ", "---", "___", "_ -", "###"]) {
        assert.throws(
          () => commands.createProject({ name: "Zombie", meta: { prefix }, actor: HUMAN }),
          (err) => err.code === "VALIDATION_FAILED" && err.details.field === "meta.prefix",
          JSON.stringify(prefix),
        );
      }
      assert.equal(countRows(db, "projects"), 0);
    });
  });

  it("refuses a declared non-string rather than minting the prefix `NULL`", async () => {
    await board(({ db, commands }) => {
      // `identifierPrefix(null)` is `"NULL"` — a usable-looking prefix from a
      // value that carried nothing. Refuse instead of inventing one.
      assert.equal(identifierPrefix(null), "NULL");
      for (const prefix of [null, 42, { a: 1 }]) {
        assert.throws(
          () => commands.createProject({ name: "Zombie", meta: { prefix }, actor: HUMAN }),
          (err) => err.code === "VALIDATION_FAILED" && err.details.field === "meta.prefix",
          JSON.stringify(prefix),
        );
      }
      assert.equal(countRows(db, "projects"), 0);
    });
  });

  it("does not refuse a project that simply has no meta, or an empty meta", async () => {
    await board(({ db, commands }) => {
      commands.createProject({ name: "No meta", actor: HUMAN });
      commands.createProject({ name: "Empty meta", meta: {}, actor: HUMAN });
      assert.equal(countRows(db, "projects"), 2, "an absent key is not an unusable prefix");
    });
  });
});

describe("C-PREFIX-1 · M5 — one prefix, two carriers, one owner", () => {
  it("refuses a declared prefix an id-based project already owns", async () => {
    await board(({ db, commands }) => {
      commands.createProject({ id: "demo", name: "CLI demo", actor: HUMAN });
      assert.throws(
        () => commands.createProject({ name: "UI demo", meta: { prefix: "demo" }, actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.equal(err.http, 400);
          assert.equal(err.details.prefix, "DEMO");
          assert.equal(err.details.conflictProjectId, "demo");
          assert.equal(err.details.field, "meta.prefix");
          return true;
        },
      );
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("refuses an id-based project a declared prefix already owns (the mirror)", async () => {
    await board(({ db, commands }) => {
      commands.createProject({ name: "UI demo", meta: { prefix: "demo" }, actor: HUMAN });
      assert.throws(
        () => commands.createProject({ id: "demo", name: "CLI demo", actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.equal(err.details.field, "id", "the collision is reported against the field that was sent");
          assert.equal(err.details.conflictProjectId, commands.listProjects()[0].id);
          return true;
        },
      );
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("compares normalized prefixes, not the raw strings", async () => {
    await board(({ db, commands }) => {
      commands.createProject({ id: "demo-x", name: "Dashed", actor: HUMAN });
      for (const prefix of ["demo_x", "demo.x", "Demo-X", "DEMO X"]) {
        assert.throws(
          () => commands.createProject({ name: "Clash", meta: { prefix }, actor: HUMAN }),
          (err) => err.code === "VALIDATION_FAILED" && err.details.prefix === "DEMO-X",
          JSON.stringify(prefix),
        );
      }
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("still lets two projects with different prefixes coexist", async () => {
    await board(({ db, commands }) => {
      const a = commands.createProject({ name: "A", meta: { prefix: "aa" }, actor: HUMAN });
      const b = commands.createProject({ name: "B", meta: { prefix: "bb" }, actor: HUMAN });
      assert.equal(card(commands, a.id), "AA-0001");
      assert.equal(card(commands, b.id), "BB-0001");
      assert.equal(countRows(db, "projects"), 2);
    });
  });

  it("keeps the two rejections distinct: same id is ID_CONFLICT (409), same prefix is not", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "demo", name: "First", actor: HUMAN });
      assert.throws(
        () => commands.createProject({ id: "demo", name: "Second", actor: HUMAN }),
        (err) => err.code === "ID_CONFLICT" && err.http === 409,
      );
    });
  });
});

describe("C-PREFIX-1 · M6 — the prefix is fixed at creation", () => {
  it("ignores a meta.prefix in an update, keeping the stored one", async () => {
    await board(({ commands }) => {
      const project = commands.createProject({ name: "Demo", meta: { prefix: "demo" }, actor: HUMAN });
      const updated = commands.updateProject({
        id: project.id,
        patch: { name: "Renamed", meta: { prefix: "other", owner: "linus" } },
      });
      assert.equal(updated.name, "Renamed", "the rest of the patch still lands");
      assert.equal(updated.meta.prefix, "DEMO", "the prefix is not the client's to change");
      assert.equal(updated.meta.owner, "linus");
      assert.equal(card(commands, project.id), "DEMO-0001", "numbers issued keep their prefix");
    });
  });

  it("survives the HTTP layer's merged meta (a PATCH body carries the whole meta)", async () => {
    await board(({ commands }) => {
      const project = commands.createProject({ name: "Demo", meta: { prefix: "demo" }, actor: HUMAN });
      // What `PATCH /api/v1/projects/:id` actually hands the use-case: the
      // current meta merged with the body. The slot must come out unchanged.
      const merged = { ...commands.getProject({ id: project.id }).meta, prefix: "hijacked", note: "hi" };
      const updated = commands.updateProject({ id: project.id, patch: { meta: merged } });
      assert.equal(updated.meta.prefix, "DEMO");
      assert.equal(updated.meta.note, "hi");
    });
  });

  it("does not let an update introduce a prefix on a legacy project", async () => {
    await board(({ commands }) => {
      // A legacy project keeps numbering off its id; a later PATCH cannot
      // silently re-point the counter and make its old cards look wrong.
      commands.createProject({ id: "legacy", name: "Legacy", actor: HUMAN });
      const updated = commands.updateProject({ id: "legacy", patch: { meta: { prefix: "new" } } });
      assert.equal(updated.meta.prefix, undefined);
      assert.equal(card(commands, "legacy"), "LEGACY-0001");
    });
  });

  it("leaves an update that touches no meta alone", async () => {
    await board(({ commands }) => {
      const project = commands.createProject({ name: "Demo", meta: { prefix: "demo" }, actor: HUMAN });
      const updated = commands.updateProject({ id: project.id, patch: { name: "Only the name" } });
      assert.equal(updated.meta.prefix, "DEMO");
    });
  });
});
