/**
 * Steps 2/10: the Task DTO — creation, patching, row mapping, lifecycle.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  TASK_COLUMNS,
  UPDATABLE_TASK_FIELDS,
  assertIsoMillis,
  assertNonEmptyString,
  identifierFor,
  isArchivable,
  isClaimFresh,
  isIsoMillis,
  isValidIdentifier,
  normalizeActor,
  normalizeLabels,
  normalizeTaskCreate,
  normalizeTaskUpdate,
  normalizeWorkspacePath,
  taskFromRow,
  taskToRow,
  toIsoMillis,
} from "../../../src/core/domain/task.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

const NOW = "2026-10-08T00:00:00.000Z";
const create = (input = {}, context = {}) =>
  normalizeTaskCreate(
    { title: "Ship M1", ...input },
    { now: NOW, id: "task-1", identifier: "PROJ-0001", projectId: "proj", ...context },
  );

describe("domain/task — create", () => {
  it("fills every default a fresh task needs", () => {
    const task = create();
    assert.equal(task.status, "todo");
    assert.equal(task.priority, "medium");
    assert.equal(task.kind, "task");
    assert.equal(task.version, 1);
    assert.equal(task.deliveryRound, 1, "a new task is on its first delivery attempt");
    assert.equal(task.reportLatestId, null);
    assert.deepEqual(task.labels, []);
    assert.equal(task.blockedAt, null);
    assert.equal(task.statusChangedAt, NOW);
    assert.equal(task.createdAt, NOW);
    assert.equal(task.updatedAt, NOW);
  });

  it("stamps blocked_at when a task is created already blocked", () => {
    assert.equal(create({ status: "blocked" }).blockedAt, NOW);
  });

  it("keeps the fields a caller supplied", () => {
    const task = create({
      title: "  spaced  ",
      priority: "URGENT",
      kind: "epic",
      labels: ["a", "a", "b"],
      assigneeKind: "agent",
      assigneeId: "as1",
      creator: { kind: "human", id: "Terry" },
      sortOrder: 5,
      sourcePath: "cards/x.md",
      sourceHash: "abc",
    });
    assert.equal(task.title, "spaced", "title is trimmed");
    assert.equal(task.priority, "urgent");
    assert.equal(task.kind, "epic");
    assert.deepEqual(task.labels, ["a", "b"], "labels are de-duplicated in order");
    assert.equal(task.assigneeKind, "agent");
    assert.equal(task.creatorKind, "human");
    assert.equal(task.creatorId, "Terry");
    assert.equal(task.sortOrder, 5);
    assert.equal(task.sourcePath, "cards/x.md");
  });

  it("refuses the shapes that would corrupt the board", () => {
    assert.throws(() => create({ title: "" }), (e) => e.code === "VALIDATION_FAILED");
    assert.throws(() => create({ title: 42 }), (e) => e.details.field === "title");
    assert.throws(() => create({ status: "ready" }), (e) => {
      assert.equal(e.details.field, "status");
      assert.deepEqual(e.details.allowed, ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]);
      return true;
    });
    assert.throws(() => create({ kind: "story" }), (e) => e.details.field === "kind");
    assert.throws(() => create({ assigneeKind: "robot" }), (e) => e.details.field === "assigneeKind");
    assert.throws(() => create({ creator: { kind: "ghost", id: "x" } }), (e) => e.code === "VALIDATION_FAILED");
    assert.throws(() => create({ creator: { kind: "agent", id: "" } }), (e) => e.code === "VALIDATION_FAILED");
    assert.throws(() => create({}, { identifier: "has space" }), (e) => e.details.field === "identifier");
    assert.throws(() => create({}, { projectId: "" }), (e) => e.details.field === "projectId");
    assert.throws(() => create({}, { now: "yesterday" }), (e) => e.code === "VALIDATION_FAILED");
    assert.throws(() => normalizeTaskCreate(null, { now: NOW, id: "i", identifier: "X-1", projectId: "p" }), DomainError);
  });
});

describe("domain/task — labels, paths, identifiers, timestamps", () => {
  it("normalises labels from arrays, JSON and comma lists", () => {
    assert.deepEqual(normalizeLabels('["a","b"]'), ["a", "b"]);
    assert.deepEqual(normalizeLabels("a,b"), ["a", "b"]);
    assert.deepEqual(normalizeLabels([" a ", "", "b"]), ["a", "b"]);
    assert.deepEqual(normalizeLabels(null), []);
    assert.throws(() => normalizeLabels({ a: 1 }), (e) => e.details.field === "labels");
    assert.throws(() => normalizeLabels([1, "x".repeat(65)]), (e) => e.code === "VALIDATION_FAILED");
    assert.throws(() => normalizeLabels(Array.from({ length: 33 }, (_, i) => `l${i}`)), (e) => e.code === "VALIDATION_FAILED");
  });

  it("requires an absolute workspace path and strips trailing slashes", () => {
    assert.equal(normalizeWorkspacePath("/Users/x/repo/"), "/Users/x/repo");
    assert.equal(normalizeWorkspacePath("/"), "/");
    assert.throws(() => normalizeWorkspacePath("relative/path"), (e) => {
      assert.equal(e.code, "VALIDATION_FAILED");
      assert.equal(e.details.field, "workspacePath");
      return true;
    });
    assert.throws(() => normalizeWorkspacePath(""), DomainError);
  });

  it("builds and validates identifiers, keeping legacy ones importable", () => {
    assert.equal(identifierFor("proj", 7), "PROJ-0007");
    assert.equal(identifierFor("task panel!", 12), "TASK-PANEL-0012");
    assert.throws(() => identifierFor("###", 1), (e) => e.code === "VALIDATION_FAILED");
    assert.equal(isValidIdentifier("T-20261008-230500-taskpanel-m1"), true);
    assert.equal(isValidIdentifier("nope/slash"), false);
  });

  it("pins timestamps to fixed-width UTC milliseconds", () => {
    assert.equal(toIsoMillis("2026-10-08T08:00:00+08:00"), "2026-10-08T00:00:00.000Z");
    assert.equal(toIsoMillis(new Date(Date.UTC(2026, 9, 8))), NOW);
    assert.equal(isIsoMillis(NOW), true);
    assert.equal(isIsoMillis("2026-10-08T00:00:00Z"), false, "milliseconds are mandatory");
    assert.equal(isIsoMillis("2026-13-40T00:00:00.000Z"), false);
    assert.equal(assertIsoMillis(NOW, "now"), NOW);
    assert.throws(() => assertIsoMillis("nope", "createdAt"), (e) => e.details.field === "createdAt");
    assert.throws(() => toIsoMillis(null), DomainError);
    assert.throws(() => toIsoMillis(new Date("nope")), DomainError);
    assert.equal(assertNonEmptyString(" x ", "title"), " x ");
    assert.throws(() => assertNonEmptyString(7, "title"), DomainError);
    assert.deepEqual(normalizeActor({ kind: "human", id: "Terry" }, "creator"), { kind: "human", id: "Terry" });
    assert.equal(normalizeActor(null, "creator"), null);
  });
});

describe("domain/task — update", () => {
  it("accepts a partial patch and refuses status changes", () => {
    assert.deepEqual(normalizeTaskUpdate({ title: "new" }, { now: NOW }), { title: "new" });
    assert.deepEqual(normalizeTaskUpdate({ labels: "a,b", priority: "high" }, { now: NOW }), {
      labels: ["a", "b"],
      priority: "high",
    });
    assert.throws(() => normalizeTaskUpdate({ status: "done" }, { now: NOW }), (e) => {
      assert.equal(e.code, "INVALID_TRANSITION");
      assert.equal(e.http, 409);
      return true;
    });
    assert.throws(() => normalizeTaskUpdate({ nope: 1 }, { now: NOW }), (e) => {
      assert.equal(e.code, "VALIDATION_FAILED");
      assert.deepEqual(e.details.allowed, [...UPDATABLE_TASK_FIELDS]);
      return true;
    });
    assert.throws(() => normalizeTaskUpdate({}, { now: NOW }), (e) => /empty/.test(e.message));
    assert.throws(() => normalizeTaskUpdate(null, { now: NOW }), DomainError);
    assert.throws(() => normalizeTaskUpdate({ kind: "story" }, { now: NOW }), DomainError);
    assert.throws(() => normalizeTaskUpdate({ assigneeKind: "bot" }, { now: NOW }), DomainError);
  });
});

describe("domain/task — row mapping", () => {
  it("round-trips a DTO through the row shape", () => {
    const task = create({ labels: ["x"] });
    const row = taskToRow(task);
    assert.deepEqual(Object.keys(row).sort(), [...TASK_COLUMNS].sort(), "every column is mapped");
    assert.equal(row.labels, '["x"]');
    assert.equal(row.project_id, "proj");
    assert.deepEqual(taskFromRow(row), task);
  });

  it("maps a sparse row without inventing values, and refuses unknown fields", () => {
    const sparse = taskFromRow({ id: "t", identifier: "P-1", project_id: "p", title: "t", status: "todo", labels: null });
    assert.equal(sparse.priority, null);
    assert.deepEqual(sparse.labels, []);
    assert.equal(taskFromRow(null), null);
    assert.throws(() => taskToRow({}, ["nope"]), (e) => {
      assert.equal(e.code, "VALIDATION_FAILED");
      assert.equal(e.details.field, "nope");
      return true;
    });
  });
});

describe("domain/task — lifecycle predicates", () => {
  const doneTask = {
    id: "t",
    status: "done",
    statusChangedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
  };

  it("waits seven days after the terminal move before a task is archivable (I6)", () => {
    const early = isArchivable(doneTask, { now: "2026-10-07T23:00:00.000Z" });
    assert.equal(early.eligible, false);
    assert.equal(early.eligibleAt, "2026-10-08T00:00:00.000Z");
    assert.equal(early.days, 7);
    assert.equal(isArchivable(doneTask, { now: "2026-10-08T00:00:00.000Z" }).eligible, true);
    assert.equal(isArchivable(doneTask, { now: NOW, days: 1 }).eligible, true, "window is configurable");
  });

  it("refuses to archive anything unfinished or already archived", () => {
    assert.throws(() => isArchivable({ ...doneTask, status: "in_progress" }, { now: NOW }), (e) => {
      assert.equal(e.code, "ARCHIVE_NOT_TERMINAL");
      return true;
    });
    assert.throws(
      () => isArchivable({ ...doneTask, archivedAt: NOW }, { now: NOW }),
      (e) => e.code === "VALIDATION_FAILED",
    );
  });

  it("treats a claim as fresh only inside the heartbeat window (I2)", () => {
    const claimed = { heartbeatAt: "2026-10-08T00:00:00.000Z" };
    assert.equal(isClaimFresh(claimed, { now: "2026-10-08T00:09:59.999Z" }), true);
    assert.equal(isClaimFresh(claimed, { now: "2026-10-08T00:10:00.000Z" }), true);
    assert.equal(isClaimFresh(claimed, { now: "2026-10-08T00:10:00.001Z" }), false);
    assert.equal(isClaimFresh(claimed, { now: "2026-10-07T23:00:00.000Z" }), false, "clock skew is not fresh");
    assert.equal(isClaimFresh({ heartbeatAt: null }, { now: NOW }), false);
    assert.equal(isClaimFresh(claimed, { now: "2026-10-08T00:05:00.000Z", freshMs: 60_000 }), false);
  });
});
