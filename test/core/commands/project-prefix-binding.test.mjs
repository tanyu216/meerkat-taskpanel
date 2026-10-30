/**
 * C-PREFIX-1 — the create-project `prefix` field is bound to the project's card
 * prefix (`design/contracts/project-prefix-binding.md`).
 *
 * A project's cards are numbered with a **prefix**, and that prefix has two
 * sources: the project's own, declared at creation as `meta.prefix` (the UI's
 * only prefix input) and normalized once on the way in, or — when none was
 * declared — the project's id, normalized, which is how every project that
 * predates the slot already behaves. These tests pin the binding, the two
 * refusal paths that keep a project from becoming a "zombie" that can never
 * mint a card (M4: a declared prefix that normalizes to nothing; M8: a prefix
 * outside 1-4 `[A-Z0-9]`), the two things the slot must **not** do — change the
 * numbers of cards already on the board, and be writable after creation (M6) —
 * and the new create rule: every path must resolve a 1-4 character `[A-Z0-9]`
 * token before the row is written.
 *
 * `assertPrefixAvailable`'s collision side is pinned separately in
 * `project-prefix.test.mjs`. Legacy rows — long or hyphenated prefixes seeded
 * through the repository — keep reading and minting there; creation no longer
 * produces them.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import {
  PROJECT_PREFIX_MAX,
  identifierPrefix,
  isValidProjectPrefix,
} from "../../../src/foundation/ids.mjs";
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

describe("C-PREFIX-1 · M8 — every create path resolves a 1-4 character [A-Z0-9] prefix", () => {
  it("accepts TP, TD, A, ABCD and an id-derived DEMO", async () => {
    await board(({ db, commands }) => {
      const tp = commands.createProject({ name: "Meerkat TaskPanel", meta: { prefix: "tp" }, actor: HUMAN });
      assert.equal(tp.meta.prefix, "TP");
      assert.equal(card(commands, tp.id), "TP-0001");

      const td = commands.createProject({ name: "Taskd", meta: { prefix: "TD" }, actor: HUMAN });
      assert.equal(td.meta.prefix, "TD");
      assert.equal(card(commands, td.id), "TD-0001");

      const one = commands.createProject({ name: "One letter", meta: { prefix: "a" }, actor: HUMAN });
      assert.equal(one.meta.prefix, "A");
      assert.equal(card(commands, one.id), "A-0001");

      const four = commands.createProject({ name: "Four letters", meta: { prefix: "ABCD" }, actor: HUMAN });
      assert.equal(four.meta.prefix, "ABCD");
      assert.equal(card(commands, four.id), "ABCD-0001");

      const demo = commands.createProject({ id: "demo", name: "Demo", actor: HUMAN });
      assert.equal(storedPrefix(commands, "demo"), undefined, "an id-derived prefix is not stored");
      assert.equal(card(commands, "demo"), "DEMO-0001");

      assert.equal(countRows(db, "projects"), 5);
    });
  });

  it("refuses every declared prefix outside the rule and writes no row", async () => {
    await board(({ db, commands }) => {
      for (const [value, normalized] of [
        ["abcde", "ABCDE"],
        ["or c", "OR-C"],
        ["demo_x", "DEMO-X"],
      ]) {
        assert.throws(
          () => commands.createProject({ name: "Bad", meta: { prefix: value }, actor: HUMAN }),
          (err) => {
            assert.equal(err.code, "VALIDATION_FAILED", JSON.stringify(value));
            assert.equal(err.http, 400);
            assert.equal(err.details.field, "meta.prefix");
            assert.equal(err.details.received, value);
            assert.equal(err.details.prefix, normalized);
            assert.equal(err.details.max, PROJECT_PREFIX_MAX);
            return true;
          },
          JSON.stringify(value),
        );
      }
      assert.equal(countRows(db, "projects"), 0, "a refused create writes no row");
    });
  });

  it("refuses an id-derived prefix outside the rule, naming the id and the fix", async () => {
    await board(({ db, commands }) => {
      for (const [id, normalized] of [
        ["other", "OTHER"],
        ["demo-x", "DEMO-X"],
        ["###", ""],
      ]) {
        assert.throws(
          () => commands.createProject({ id, name: "Bad", actor: HUMAN }),
          (err) => {
            assert.equal(err.code, "VALIDATION_FAILED", id);
            assert.equal(err.http, 400);
            assert.equal(err.details.field, "id");
            assert.equal(err.details.projectId, id);
            assert.equal(err.details.prefix, normalized);
            assert.equal(err.details.max, PROJECT_PREFIX_MAX);
            assert.ok(err.hint !== null && /taskctl project create --prefix/.test(err.hint.fix));
            return true;
          },
          id,
        );
      }
      assert.equal(countRows(db, "projects"), 0, "the refusal happens before the insert");
      assert.equal(commands.listProjects().length, 0);
    });
  });

  it("refuses a create with neither an id nor a declared prefix", async () => {
    await board(({ db, commands }) => {
      // `id: null` is the same branch as an absent id: the repository would mint
      // a UUID for a nullish value, so creation refuses rather than validating a
      // token for an id the row will not carry.
      for (const input of [{ name: "No id" }, { name: "Empty meta", meta: {} }, { name: "Null id", id: null }]) {
        assert.throws(
          () => commands.createProject({ ...input, actor: HUMAN }),
          (err) => {
            assert.equal(err.code, "VALIDATION_FAILED");
            assert.equal(err.http, 400);
            assert.deepEqual(err.details, { field: "meta.prefix", max: PROJECT_PREFIX_MAX });
            assert.ok(err.hint !== null && /taskctl project create --prefix/.test(err.hint.fix));
            return true;
          },
          JSON.stringify(input),
        );
      }
      assert.equal(countRows(db, "projects"), 0);
    });
  });

  it("checks the shape before the collision it would otherwise cause", async () => {
    await board(({ db, repos, commands }) => {
      // Only the repository seam can put a prefix outside the creation rule on
      // a board. A declared value normalizing to the same token must be refused
      // for its shape — not reported as colliding with the legacy row.
      repos.projects.create({ id: "abcde", name: "Legacy long", meta: { prefix: "ABCDE" }, now: TS });
      assert.throws(
        () => commands.createProject({ name: "Bad", meta: { prefix: "abcde" }, actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.equal(err.details.field, "meta.prefix");
          assert.equal(err.details.max, PROJECT_PREFIX_MAX);
          assert.equal(err.details.conflictProjectId, undefined);
          return true;
        },
      );
      assert.equal(countRows(db, "projects"), 1);
    });
  });

  it("ensure refuses an absent project but leaves an existing legacy row untouched", async () => {
    await board(({ repos, commands }) => {
      assert.throws(
        () => commands.ensureProject({ id: "meerkat-taskpanel", name: "MTP", actor: HUMAN }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "id",
      );

      // The id would be refused for a new project, but ensure on an existing row
      // is a read: a legacy board keeps working through the CLI's ensure.
      repos.projects.create({ id: "meerkat-taskpanel", name: "MTP", now: TS });
      const { project, created } = commands.ensureProject({
        id: "meerkat-taskpanel",
        name: "Different",
        actor: HUMAN,
      });
      assert.equal(created, false);
      assert.equal(project.name, "MTP", "an existing project is not updated by ensure");
    });
  });

  it("exposes the shared rule the create use-case and the tests agree on", () => {
    assert.equal(PROJECT_PREFIX_MAX, 4);
    for (const ok of ["A", "TP", "TD", "ABCD", "0", "A0B9"]) {
      assert.equal(isValidProjectPrefix(ok), true, ok);
    }
    for (const bad of ["", "abcde", "AB-CD", "AB_CD", "ab", "A B", "ABCDE", null, 42, undefined]) {
      assert.equal(isValidProjectPrefix(bad), false, String(bad));
    }
  });
});

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

  it("takes the declared prefix over the id when both are given", async () => {
    await board(({ commands }) => {
      // The API takes an id *and* a meta.prefix; the slot wins, because it is
      // the one the allocator reads (M3). The id is opaque — a long id is not
      // revalidated once a usable prefix is declared.
      const project = commands.createProject({
        id: "some-long-id",
        name: "Both",
        meta: { prefix: "ch" },
        actor: HUMAN,
      });
      assert.equal(project.id, "some-long-id");
      assert.equal(project.meta.prefix, "CH");
      assert.equal(card(commands, "some-long-id"), "CH-0001");
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

describe("C-PREFIX-1 · the id path is unchanged for prefixes the rule allows", () => {
  it("numbers off the id, and writes no prefix slot at all", async () => {
    await board(({ commands }) => {
      // The CLI shape (`project create --id demo`) and rows seeded before the
      // slot existed: no meta.prefix, so nothing is stored and the id decides.
      const project = commands.createProject({ id: "demo", name: "Demo", actor: HUMAN });
      assert.equal(storedPrefix(commands, "demo"), undefined, "an absent key is what keeps the fallback reachable");
      assert.equal(card(commands, "demo"), "DEMO-0001");
      assert.equal(card(commands, "demo"), "DEMO-0002");
    });
  });

  it("numbers a repository-seeded UUID row the way it always did", async () => {
    await board(({ repos, commands }) => {
      // A UUID id is no longer a creation path (M8), but a row the import seam
      // wrote keeps numbering off it — the read path is not narrowed.
      const id = "9f1d2c3b-4a5e-4f60-8b71-2c3d4e5f6a7b";
      repos.projects.create({ id, name: "Legacy", now: TS });
      assert.equal(card(commands, id), `${identifierPrefix(id)}-0001`);
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
          assert.equal(err.details.max, undefined, "the empty refusal keeps its pre-M8 shape");
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
      commands.createProject({ id: "aa", name: "No meta", actor: HUMAN });
      commands.createProject({ id: "bb", name: "Empty meta", meta: {}, actor: HUMAN });
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
      commands.createProject({ id: "ab", name: "Lower", actor: HUMAN });
      for (const prefix of ["AB", "aB", "Ab"]) {
        assert.throws(
          () => commands.createProject({ name: "Clash", meta: { prefix }, actor: HUMAN }),
          (err) => err.code === "VALIDATION_FAILED" && err.details.prefix === "AB",
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
      commands.createProject({ id: "lg", name: "Legacy", actor: HUMAN });
      const updated = commands.updateProject({ id: "lg", patch: { meta: { prefix: "new" } } });
      assert.equal(updated.meta.prefix, undefined);
      assert.equal(card(commands, "lg"), "LG-0001");
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
