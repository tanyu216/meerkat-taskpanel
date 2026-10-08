/**
 * Step 7: label registration and the GC, against a real board (§4.4, F1/F2/F3/F5).
 *
 * The registry's whole contract lives here: `norm` identity with first-seen
 * display names, a `use_count` that tracks *non-archived* references, colours
 * unique inside a project, and a GC that collects only what nothing live names —
 * and refuses to collect when its counter disagrees with a live scan.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { FORBIDDEN_LABEL_COMMANDS, createCommands, createContext } from "../../../src/core/commands/index.mjs";
import * as commandsModule from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { LABEL_PALETTE } from "../../../src/shared/constants.mjs";
import { cleanupTempDirs, countRows, revision, withBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const AGENT = { kind: "agent", id: "linus" };
const HUMAN = { kind: "human", id: "Terry" };
const T0 = "2026-10-01T00:00:00.000Z";
const T0_LATER = "2026-10-02T00:00:00.000Z";
/** 40 days after T0 — past a 30-day TTL but not a 90-day one. */
const TTL_EXPIRED = "2026-11-10T00:00:00.000Z";

/** A board with a mutable clock, so time is never the wall clock. */
async function board(fn) {
  return withBoard(({ db }) => {
    let now = T0;
    const logs = [];
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, clock: () => now, logger: (event) => logs.push(event) });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", workspacePath: "/tmp/ws", actor: HUMAN });
    return fn({ db, repos, ctx, commands, logs, at: (stamp) => { now = stamp; } });
  });
}

/** Name a label on a throwaway task, then drop it — leaving an unused label. */
function leaveUnused(commands, name) {
  const task = commands.createTask({ projectId: "proj", title: `uses ${name}`, labels: [name], actor: AGENT });
  commands.updateTask({ id: task.id, patch: { labels: [] }, actor: AGENT });
  return task;
}

const gcRows = (db) =>
  db.prepare("SELECT * FROM task_activities WHERE event = 'label_gc' ORDER BY id").all();

describe("commands/labels — registration (F3-B / F5-B)", () => {
  it("registers one label per norm and keeps the first spelling", async () => {
    await board(({ db, repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Bug", "bug", "BUG"], actor: AGENT });
      assert.deepEqual(task.labels, ["Bug"], "the task stores the registry's display name");
      assert.equal(countRows(db, "labels"), 1);

      const label = repos.labels.getByNorm("proj", "bug");
      assert.equal(label.displayName, "Bug");
      assert.equal(label.norm, "bug");
      assert.equal(label.useCount, 1);
      assert.equal(label.firstSeenAt, T0);
      assert.equal(label.lastSeenAt, T0);
      assert.ok(LABEL_PALETTE.includes(label.color), label.color);

      // The write recorded the label audit inside its own activity row.
      const activity = db.prepare("SELECT * FROM task_activities WHERE event = 'task_created'").get();
      const audit = JSON.parse(activity.changes_json).labels;
      assert.deepEqual(audit.map((entry) => [entry.displayName, entry.action]), [["Bug", "created"]]);
    });
  });

  it("counts one use per non-archived task, and only for newly-added labels", async () => {
    await board(({ repos, commands }) => {
      const a = commands.createTask({ projectId: "proj", title: "a", labels: ["Bug"], actor: AGENT });
      commands.createTask({ projectId: "proj", title: "b", labels: ["bug"], actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "bug").useCount, 2, "two live tasks");

      commands.updateTask({ id: a.id, patch: { labels: ["Bug", "ui"] }, actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "bug").useCount, 2, "Bug was already named");
      assert.equal(repos.labels.getByNorm("proj", "ui").useCount, 1);

      commands.updateTask({ id: a.id, patch: { labels: ["Bug"] }, actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "ui").useCount, 0, "the use is released");
      assert.equal(repos.labels.getByNorm("proj", "ui").archivedAt, null, "releasing a use does not archive");
    });
  });

  it("is idempotent: the same labels never duplicate a row or churn last_seen_at", async () => {
    await board(({ db, repos, commands, at }) => {
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Bug"], actor: AGENT });
      at(T0_LATER);
      commands.updateTask({ id: task.id, patch: { labels: ["bug"] }, actor: AGENT });
      assert.equal(countRows(db, "labels"), 1);
      assert.equal(repos.labels.getByNorm("proj", "bug").useCount, 1, "not double-counted");
      assert.equal(repos.labels.getByNorm("proj", "bug").lastSeenAt, T0, "a re-submit is not a new sighting");
    });
  });

  it("keeps one row no matter how many tasks name the same norm", async () => {
    await board(({ db, repos, commands }) => {
      for (let i = 0; i < 5; i += 1) {
        commands.createTask({ projectId: "proj", title: `t${i}`, labels: ["bug"], actor: AGENT });
      }
      assert.equal(countRows(db, "labels"), 1, "the (project_id, norm) key holds under repetition");
      assert.equal(repos.labels.getByNorm("proj", "bug").useCount, 5, "and every naming is counted once");
    });
  });

  it("archiving a task releases the labels it carried", async () => {
    await board(({ repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Bug", "ui"], actor: AGENT });
      commands.moveStatus({ id: task.id, to: "canceled", actor: AGENT });
      commands.archive({ id: task.id, days: 0, actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "bug").useCount, 0);
      assert.equal(repos.labels.getByNorm("proj", "ui").useCount, 0);
      assert.equal(repos.labels.getByNorm("proj", "bug").archivedAt, null, "still a live registry row");
    });
  });

  it("assigns colours that do not repeat inside a project, but may across projects", async () => {
    await board(({ repos, commands }) => {
      commands.createProject({ id: "other", name: "Other", workspacePath: "/tmp/other", actor: HUMAN });
      commands.createTask({ projectId: "proj", title: "a", labels: ["one"], actor: AGENT });
      commands.createTask({ projectId: "proj", title: "b", labels: ["two"], actor: AGENT });
      commands.createTask({ projectId: "other", title: "c", labels: ["one"], actor: AGENT });

      const one = repos.labels.getByNorm("proj", "one").color;
      const two = repos.labels.getByNorm("proj", "two").color;
      assert.notEqual(one, two, "unique inside the project");
      assert.equal(one, LABEL_PALETTE[0]);
      assert.equal(repos.labels.getByNorm("other", "one").color, one, "a new project starts over");
    });
  });

  it("revives an archived label with its original id, colour and spelling", async () => {
    await board(({ db, repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Temp"], actor: AGENT });
      const before = repos.labels.getByNorm("proj", "temp");
      commands.updateTask({ id: task.id, patch: { labels: [] }, actor: AGENT });
      assert.equal(commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 }).archived.length, 1);
      assert.notEqual(repos.labels.getByNorm("proj", "temp").archivedAt, null);

      commands.createTask({ projectId: "proj", title: "again", labels: ["temp"], actor: AGENT });
      const after = repos.labels.getByNorm("proj", "temp");
      assert.equal(after.id, before.id, "same row, not a second one");
      assert.equal(after.color, before.color);
      assert.equal(after.displayName, "Temp", "first-seen spelling survives the round trip");
      assert.equal(after.archivedAt, null);
      assert.equal(after.useCount, 1);
      assert.equal(countRows(db, "labels"), 1);
    });
  });

  it("exposes no label management surface", () => {
    for (const forbidden of FORBIDDEN_LABEL_COMMANDS) {
      assert.equal(/Label/.test(forbidden), true);
    }
    for (const name of Object.keys(commandsModule)) {
      assert.equal(
        /^(add|remove|rename|create|delete|archive|set)(Label)/.test(name),
        false,
        `${name} must not exist`,
      );
    }
  });
});

describe("commands/labels — the GC (F1 / F3 / F5)", () => {
  it("never touches a label a live task still names", async () => {
    await board(({ db, repos, commands }) => {
      commands.createTask({ projectId: "proj", title: "a", labels: ["keep"], actor: AGENT });
      const result = commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 });
      assert.deepEqual(result.archived, []);
      assert.equal(repos.labels.getByNorm("proj", "keep").archivedAt, null);
      assert.equal(countRows(db, "labels"), 1, "a referenced label is never removed");
      assert.deepEqual(gcRows(db), []);
    });
  });

  it("waits out the TTL before collecting an unused label", async () => {
    await board(({ commands }) => {
      leaveUnused(commands, "fresh");
      assert.deepEqual(commands.collectUnusedLabels({ now: T0, ttlDays: 30 }).archived, [], "same instant");
      assert.equal(commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 }).archived.length, 1);
    });
  });

  it("soft-deletes an unused, expired label and writes exactly one label_gc row", async () => {
    await board(({ db, repos, commands }) => {
      leaveUnused(commands, "dead");
      const result = commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 });
      assert.deepEqual(result.archived.map((label) => label.displayName), ["dead"]);
      assert.notEqual(repos.labels.getByNorm("proj", "dead").archivedAt, null);

      const rows = gcRows(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].task_id, null, "the sweep hangs off no task");
      assert.equal(rows[0].event, "label_gc");
      const changes = JSON.parse(rows[0].changes_json);
      assert.equal(changes.reason, "ttl");
      assert.equal(changes.ttlDays, 30);
      assert.deepEqual(changes.archived.map((label) => label.norm), ["dead"]);
      assert.equal(countRows(db, "labels"), 1, "soft delete, never a physical one");
    });
  });

  it("collects a label only an archived task still names", async () => {
    await board(({ repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["orphan"], actor: AGENT });
      commands.moveStatus({ id: task.id, to: "canceled", actor: AGENT });
      commands.archive({ id: task.id, days: 0, actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "orphan").useCount, 0);
      assert.equal(commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 }).archived.length, 1);
    });
  });

  it("does not reprocess an already-archived label", async () => {
    await board(({ db, commands }) => {
      leaveUnused(commands, "once");
      assert.equal(commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 }).archived.length, 1);
      assert.deepEqual(commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 }).archived, []);
      assert.equal(gcRows(db).length, 1, "one sweeping row, not two");
    });
  });

  it("skips the archive and warns when use_count disagrees with the live scan (F3-B)", async () => {
    await board(({ db, repos, commands, logs }) => {
      commands.createTask({ projectId: "proj", title: "a", labels: ["ghost"], actor: AGENT });
      // Simulate counter drift: the row claims nobody uses it, a live scan says one.
      db.prepare("UPDATE labels SET use_count = 0 WHERE norm = 'ghost'").run();

      const result = commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 });
      assert.deepEqual(result.archived, [], "a referenced label is never archived, even on drift");
      assert.equal(result.mismatched.length, 1);
      assert.equal(result.mismatched[0].scanned, 1);
      assert.equal(result.mismatched[0].useCount, 0);
      assert.equal(repos.labels.getByNorm("proj", "ghost").archivedAt, null);
      assert.equal(logs.filter((entry) => entry.event === "label_gc_mismatch").length, 1, "and it is warned about");
      assert.deepEqual(gcRows(db), []);
    });
  });

  it("writes nothing at all when there is nothing to collect (zero disturbance)", async () => {
    await board(({ db, commands }) => {
      commands.createTask({ projectId: "proj", title: "plain", actor: AGENT });
      const before = revision(db);
      const result = commands.collectUnusedLabels({ now: TTL_EXPIRED, ttlDays: 30 });
      assert.deepEqual(result.archived, []);
      assert.equal(revision(db), before, "no revision bump");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_activities WHERE event = 'label_gc'").get().n, 0);
    });
  });

  it("lists labels by use count, project and query", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "other", name: "Other", workspacePath: "/tmp/other", actor: HUMAN });
      commands.createTask({ projectId: "proj", title: "a", labels: ["alpha", "beta"], actor: AGENT });
      commands.createTask({ projectId: "proj", title: "b", labels: ["alpha"], actor: AGENT });
      commands.createTask({ projectId: "other", title: "c", labels: ["gamma"], actor: AGENT });

      assert.deepEqual(commands.listLabels({ projectId: "proj" }).map((l) => l.displayName), ["alpha", "beta"]);
      assert.deepEqual(commands.listLabels({}).map((l) => l.displayName).sort(), ["alpha", "beta", "gamma"]);
      assert.deepEqual(commands.listLabels({ q: "al" }).map((l) => l.displayName), ["alpha"]);
      assert.equal(commands.listLabels({ projectId: "proj" })[0].useCount, 2);
    });
  });
});
