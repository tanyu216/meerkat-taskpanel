/**
 * Step 4: the `labels` repository directly — upsert lifecycle, the reference
 * scan and the error mapping, without the command layer in the way.
 *
 * The interesting assertions here are the ones a use-case cannot easily reach:
 * the unique-index conflict mapping, the malformed-JSON tolerance of the scan,
 * and the defensive NOT_FOUND paths.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createLabelsRepository } from "../../../../src/core/storage/repositories/labels.mjs";
import { TS, TS2, cleanupTempDirs, insertProject, insertTask, reasonCode, withBoard } from "../../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const LABEL = { projectId: "proj", norm: "bug", displayName: "Bug", color: "#e5484d", now: TS };

/** Every column, for the raw inserts that prove the schema's own guarantees. */
function rawInsertLabel(db, id, norm) {
  db.prepare(
    `INSERT INTO labels(id, project_id, norm, display_name, color, use_count, first_seen_at, last_seen_at, archived_at)
     VALUES (?, 'proj', ?, 'Bug', '#fff', 0, ?, ?, NULL)`,
  ).run(id, norm, TS, TS);
}

describe("storage/repositories/labels — upsert lifecycle", () => {
  it("creates, reuses (first-seen wins) and resurrects the same row", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const labels = createLabelsRepository(db);

      const created = labels.upsert(LABEL);
      assert.equal(created.action, "created");
      assert.equal(created.entry.useCount, 0, "a fresh label has no uses yet");
      assert.equal(created.entry.firstSeenAt, TS);
      assert.equal(created.entry.archivedAt, null);

      const reused = labels.upsert({ ...LABEL, displayName: "BUG", color: "#000000", now: TS2 });
      assert.equal(reused.action, "reused");
      assert.equal(reused.entry.id, created.entry.id);
      assert.equal(reused.entry.displayName, "Bug", "the first spelling wins");
      assert.equal(reused.entry.color, "#e5484d", "and the colour is never recomputed");
      assert.equal(reused.entry.lastSeenAt, TS, "a reuse is not a sighting");

      assert.equal(labels.getById(created.entry.id).id, created.entry.id);
      assert.equal(labels.getByNorm("proj", "bug").id, created.entry.id);
      assert.equal(labels.getById("nope"), null);
      assert.equal(labels.getByNorm("proj", "nope"), null);

      labels.archive(created.entry.id, TS2);
      const revived = labels.upsert(LABEL);
      assert.equal(revived.action, "resurrected");
      assert.equal(revived.entry.id, created.entry.id, "same row, not a second one");
      assert.equal(revived.entry.archivedAt, null);
    });
  });

  it("maps a failed insert onto a reason code instead of leaking SQL", async () => {
    await withBoard(({ db }) => {
      const labels = createLabelsRepository(db);
      // The project does not exist and `project_id` is NOT NULL: the write cannot
      // land, and the reason has to be a DomainError, not a raw SQLite message.
      assert.throws(() => labels.upsert({ ...LABEL, projectId: null }), (err) => {
        assert.equal(err.name, "DomainError");
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.details.op, "labels.upsert");
        return true;
      });
    });
  });

  it("maps the unique index to LABEL_CONFLICT (the schema's own guarantee)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      rawInsertLabel(db, "l1", "bug");
      assert.equal(reasonCode(() => rawInsertLabel(db, "l2", "bug")), "LABEL_CONFLICT");
    });
  });
});

describe("storage/repositories/labels — reads", () => {
  it("lists by project, query and archived state, and reports used colours", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const labels = createLabelsRepository(db);
      labels.upsert({ ...LABEL, norm: "alpha", displayName: "Alpha", color: "#111111" });
      labels.upsert({ ...LABEL, norm: "beta", displayName: "Beta", color: "#222222" });
      const gone = labels.upsert({ ...LABEL, norm: "gamma", displayName: "Gamma", color: "#333333" }).entry;
      labels.archive(gone.id, TS2);

      assert.deepEqual(labels.usedColors("proj").sort(), ["#111111", "#222222"]);
      assert.deepEqual(labels.usedColors("empty"), []);
      assert.deepEqual(labels.list({ projectId: "proj" }).map((l) => l.norm), ["alpha", "beta"]);
      assert.deepEqual(
        labels.list({ projectId: "proj", includeArchived: true }).map((l) => l.norm).sort(),
        ["alpha", "beta", "gamma"],
      );
      assert.deepEqual(labels.list({ q: "BETA" }).map((l) => l.norm), ["beta"]);
      assert.equal(labels.list({ limit: 1 }).length, 1);
      assert.equal(labels.list().length, 2, "no project filter still hides archived rows");
    });
  });

  it("counts only non-archived tasks, compares by norm, and tolerates junk", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const labels = createLabelsRepository(db);
      insertTask(db, { id: "t1", identifier: "PROJ-0001", labels: JSON.stringify(["Bug"]) });
      insertTask(db, { id: "t2", identifier: "PROJ-0002", labels: JSON.stringify(["B u g"]) }); // same norm
      insertTask(db, { id: "t3", identifier: "PROJ-0003", labels: JSON.stringify(["other"]) });
      insertTask(db, { id: "t4", identifier: "PROJ-0004", labels: JSON.stringify(["Bug"]), archived_at: TS2 });
      insertTask(db, { id: "t5", identifier: "PROJ-0005", labels: "not json at all" });

      assert.equal(labels.referenceCount("proj", "bug"), 2, "archived tasks and junk do not count");
      assert.equal(labels.referenceCount("proj", "other"), 1);
      assert.equal(labels.referenceCount("proj", "nope"), 0);
      assert.equal(labels.referenceCount("missing", "bug"), 0);
    });
  });
});

describe("storage/repositories/labels — use counting", () => {
  it("adds and removes uses, floors at zero, and refreshes last_seen_at only on add", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const labels = createLabelsRepository(db);
      const label = labels.upsert(LABEL).entry;

      labels.addUse(label.id, TS2);
      assert.equal(labels.getById(label.id).useCount, 1);
      assert.equal(labels.getById(label.id).lastSeenAt, TS2);

      labels.removeUse(label.id);
      labels.removeUse(label.id);
      assert.equal(labels.getById(label.id).useCount, 0, "never negative");
      assert.equal(labels.getById(label.id).lastSeenAt, TS2, "removing a use does not extend its life");

      assert.throws(() => labels.addUse("nope", TS2), (err) => err.code === "NOT_FOUND");
      assert.throws(() => labels.removeUse("nope"), (err) => err.code === "NOT_FOUND");
    });
  });

  it("archives once, and lists the unused-active candidates for the GC", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const labels = createLabelsRepository(db);
      const unused = labels.upsert({ ...LABEL, norm: "unused", displayName: "Unused" }).entry;
      const used = labels.upsert({ ...LABEL, norm: "used", displayName: "Used" }).entry;
      labels.addUse(used.id, TS);

      assert.deepEqual(labels.listUnusedActive().map((l) => l.norm), ["unused"]);
      assert.equal(labels.archive(unused.id, TS2), true);
      assert.equal(labels.archive(unused.id, TS), false, "already archived — a no-op, not an error");
      assert.deepEqual(labels.listUnusedActive(), []);
    });
  });
});
