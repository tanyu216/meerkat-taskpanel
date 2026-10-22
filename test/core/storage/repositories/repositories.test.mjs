/**
 * Steps 8/9: the repositories.
 *
 * These tests are about the layer's own promises: CAS semantics (and that a
 * failed CAS writes *nothing*), identifier allocation under contention,
 * append-only reads, the recursive ancestor walk, and the dictionary's
 * upsert-is-idempotent rule.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { normalizeTaskCreate } from "../../../../src/core/domain/task.mjs";
import { normalizeCommentCreate } from "../../../../src/core/domain/comment.mjs";
import { normalizeReportCreate } from "../../../../src/core/domain/report.mjs";
import { createRepositories } from "../../../../src/core/storage/repositories/index.mjs";
import { DomainError } from "../../../../src/foundation/errors.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  countRows,
  ensureActor,
  insertComment,
  revision,
  withBoard,
} from "../../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/**
 * R3: an hour and a minute before `TS2` — inside the "rotted" band (>10 min)
 * but not past the six-hour one, which is where a holder-reclaim lives.
 */
const STALE_CLAIM_AT = "2026-10-07T23:00:00.000Z";

/** A board with one project and one todo task, plus the repositories. */
/** A report payload ready for `reports.insert`, for the given round. */
function prepared(taskId, round, overrides = {}) {
  return {
    taskId,
    ...normalizeReportCreate(
      {
        conclusion: "done",
        acceptance: [{ text: "x", status: "met" }],
        evidence: [{ kind: "commit", sha: "abc1234" }],
        author: { kind: "agent", id: "linus" },
        ...overrides,
      },
      { taskRound: round, now: TS },
    ),
  };
}

async function board(fn) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ id: "proj", name: "Project", now: TS });
    return fn({ db, repos, project });
  });
}

/** Create a task through the repository, the way a command would. */
function makeTask(repos, overrides = {}) {
  const { identifier } = repos.projects.allocateIdentifier("proj");
  const task = normalizeTaskCreate(
    { title: "A task", ...overrides },
    { now: TS, id: overrides.id ?? `task-${identifier}`, identifier, projectId: "proj" },
  );
  return repos.tasks.insert(task);
}

/**
 * A review card. `normalizeTaskCreate` does not carry the structural marker
 * (it is resolved by the service layer), so the normalized DTO is stamped
 * before insert — which is exactly the shape 0025 stores.
 */
function makeReview(repos, { id, status, reviewOfId, reviewRound } = {}) {
  const { identifier } = repos.projects.allocateIdentifier("proj");
  const task = normalizeTaskCreate(
    { title: "A review", ...(status === undefined ? {} : { status }) },
    { now: TS, id: id ?? `task-${identifier}`, identifier, projectId: "proj" },
  );
  return repos.tasks.insert({ ...task, reviewOfId, reviewRound });
}

describe("repositories/projects", () => {
  it("creates, reads and patches a project", async () => {
    await board(({ repos, project }) => {
      assert.equal(project.id, "proj");
      assert.equal(project.nextTaskNumber, 1);
      assert.deepEqual(project.meta, {});
      assert.equal(repos.projects.get("proj").name, "Project");
      assert.deepEqual(repos.projects.list().map((p) => p.id), ["proj"]);

      const updated = repos.projects.update("proj", { name: "Renamed", meta: { git: "x" }, now: TS2 });
      assert.equal(updated.name, "Renamed");
      assert.deepEqual(updated.meta, { git: "x" });
      assert.equal(updated.updatedAt, TS2);
    });
  });

  it("refuses a duplicate id and an empty name", async () => {
    await board(({ repos }) => {
      assert.throws(
        () => repos.projects.create({ id: "proj", name: "X", now: TS }),
        (err) => err.code === "ID_CONFLICT",
      );
      assert.throws(() => repos.projects.create({ id: "p4", name: "   ", now: TS }), DomainError);
      assert.throws(() => repos.projects.update("nope", { name: "x", now: TS }), (err) => err.code === "NOT_FOUND");
      assert.throws(() => repos.projects.update("proj", { now: TS }), (err) => /empty/.test(err.message));
    });
  });

  it("allocates identifiers without repeating them", async () => {
    await board(({ repos }) => {
      assert.deepEqual(repos.projects.allocateIdentifier("proj"), { serial: 1, identifier: "PROJ-0001" });
      assert.deepEqual(repos.projects.allocateIdentifier("proj"), { serial: 2, identifier: "PROJ-0002" });
      assert.equal(repos.projects.get("proj").nextTaskNumber, 3);
      assert.throws(() => repos.projects.allocateIdentifier("nope"), (err) => err.code === "NOT_FOUND");
    });
  });

  it("stores no directory: the project row has no path-shaped field", async () => {
    await board(({ db, project }) => {
      assert.equal(Object.hasOwn(project, "workspacePath"), false);
      const columns = db.prepare("SELECT name FROM pragma_table_info('projects')").all().map((r) => r.name);
      assert.equal(columns.includes("workspace_path"), false, columns.join(","));
    });
  });

  it("counts tasks per status", async () => {
    await board(({ repos }) => {
      makeTask(repos, { title: "one" });
      makeTask(repos, { title: "two", id: "t2" });
      assert.deepEqual(repos.projects.countByStatus("proj"), { todo: 2 });
    });
  });

  it("aggregates task counts and trailing-window activity per project", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos, { title: "one" });
      makeTask(repos, { title: "two", id: "t2" });
      repos.activities.append({ taskId: task.id, event: "task_updated", createdAt: TS });
      // A pure heartbeat bumps the revision but changes no board state, so it is
      // not "activity" for the window.
      repos.activities.append({ taskId: task.id, event: "task_heartbeat", createdAt: TS });

      assert.deepEqual(repos.projects.taskCountByProject(), new Map([["proj", 2]]));
      assert.deepEqual(repos.projects.taskCountByProject("proj"), new Map([["proj", 2]]));
      assert.deepEqual(repos.projects.taskCountByProject("other"), new Map());

      const activity = repos.projects.activityByProject({ now: new Date(TS) });
      assert.deepEqual(activity.get("proj"), { a7: 1, a30: 1, lastActivityAt: TS });
    });
  });
});

describe("repositories/tasks", () => {
  it("inserts and reads by id and by identifier", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos, { labels: ["m1"] });
      assert.equal(task.identifier, "PROJ-0001");
      assert.equal(task.version, 1);
      assert.equal(task.deliveryRound, 1);
      assert.deepEqual(task.labels, ["m1"]);
      assert.deepEqual(repos.tasks.get(task.id), task);
      assert.deepEqual(repos.tasks.getByIdentifier("proj", "PROJ-0001"), task);
      assert.deepEqual(repos.tasks.resolve("proj", "PROJ-0001"), task);
      assert.equal(repos.tasks.get("nope"), null);
    });
  });

  it("resolves a reference as an id or an identifier, and refuses a miss uniformly", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      assert.deepEqual(repos.tasks.getByAnyRef(task.id), task);
      assert.deepEqual(repos.tasks.getByAnyRef(task.identifier), task);
      assert.equal(repos.tasks.getByAnyRef("NOPE-9999"), null);
      assert.throws(
        () => repos.tasks.requireAnyRef("NOPE-9999"),
        (err) => {
          assert.equal(err.code, "NOT_FOUND");
          assert.equal(err.details.taskRef, "NOPE-9999");
          return true;
        },
      );
    });
  });

  it("refuses a duplicate identifier in the same project", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      assert.throws(() => repos.tasks.insert({ ...task, id: "other" }), (err) => {
        assert.equal(err.code, "IDENTIFIER_CONFLICT");
        return true;
      });
    });
  });

  it("patches with a version check and writes nothing when it loses", async () => {
    await board(({ db, repos }) => {
      const task = makeTask(repos);
      const revisionBefore = revision(db);

      const updated = repos.tasks.updateCas({
        id: task.id,
        ifVersion: 1,
        patch: { title: "Renamed", labels: ["a"] },
        now: TS2,
      });
      assert.equal(updated.title, "Renamed");
      assert.deepEqual(updated.labels, ["a"]);
      assert.equal(updated.version, 2);
      assert.equal(updated.updatedAt, TS2);
      assert.equal(revision(db), revisionBefore + 1, "one patch = one revision");

      const afterGood = revision(db);
      assert.throws(
        () => repos.tasks.updateCas({ id: task.id, ifVersion: 1, patch: { title: "Stale" }, now: TS2 }),
        (err) => {
          assert.equal(err.code, "VERSION_CONFLICT");
          assert.equal(err.details.currentVersion, 2);
          assert.equal(err.details.expectedVersion, 1);
          return true;
        },
      );
      assert.equal(repos.tasks.get(task.id).title, "Renamed", "no partial write");
      assert.equal(revision(db), afterGood, "a failed CAS does not bump the revision");
      assert.equal(countRows(db, "task_activities"), 0);
    });
  });

  it("refuses to patch a column that is not patchable", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      assert.throws(
        () => repos.tasks.updateCas({ id: task.id, patch: { status: "done" }, now: TS2 }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.deepEqual(err.details.fields, ["status"]);
          return true;
        },
      );
    });
  });

  it("claims with a CAS and reports the loss rather than throwing", async () => {
    await board(({ db, repos }) => {
      // `claimed_by` is a reference since 0020 — the actor names here must exist.
      ensureActor(db, "linus");
      ensureActor(db, "elon");
      const task = makeTask(repos);
      const first = repos.tasks.claimCas({ id: task.id, ifVersion: 1, actor: "linus", now: TS2 });
      assert.equal(first.claimed, true);
      assert.equal(first.task.status, "in_progress");
      assert.equal(first.task.claimedBy, "linus");
      assert.equal(first.task.heartbeatAt, TS2);
      assert.equal(first.task.version, 2);

      const second = repos.tasks.claimCas({ id: task.id, ifVersion: 2, actor: "elon", now: TS2 });
      assert.equal(second.claimed, false);
      assert.equal(second.task.claimedBy, "linus", "the current row is returned so the caller can explain");

      const missing = repos.tasks.claimCas({ id: "nope", actor: "x", now: TS2 });
      assert.equal(missing.claimed, false);
      assert.equal(missing.task, null);
    });
  });

  it("moves status, marking blocked_at only on the way in", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      const blocked = repos.tasks.moveCas({ id: task.id, ifVersion: 1, to: "blocked", now: TS2 });
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.blockedAt, TS2);
      assert.equal(blocked.statusChangedAt, TS2);

      const back = repos.tasks.moveCas({ id: task.id, ifVersion: 2, to: "todo", now: TS });
      assert.equal(back.status, "todo");
      assert.equal(back.blockedAt, TS2, "history of the last blockage is kept");
    });
  });

  it("refuses a move the state machine does not allow", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      assert.throws(
        () => repos.tasks.moveCas({ id: task.id, to: "done", now: TS2 }),
        (err) => {
          assert.equal(err.code, "INVALID_TRANSITION");
          return true;
        },
      );
    });
  });

  it("takes over a stale claim and pulses a heartbeat only for the holder", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "linus");
      ensureActor(db, "elon");
      const task = makeTask(repos);
      // The claim's heartbeat has to be genuinely stale for a steal to be
      // allowed at all (R3): the repository refuses to take a claim whose
      // heartbeat is inside the fresh window, however the caller phrases the
      // bound. `STALE_CLAIM_AT` is over an hour before TS2 — past the fresh
      // window (10 min), inside the rotted one (6 h).
      repos.tasks.claimCas({ id: task.id, actor: "linus", now: STALE_CLAIM_AT });
      const stolen = repos.tasks.stealStaleClaim({ id: task.id, actor: "elon", now: TS2, staleBefore: TS2 });
      assert.equal(stolen.claimedBy, "elon");

      const pulsed = repos.tasks.setHeartbeat({ id: task.id, actor: "elon", now: TS2 });
      assert.equal(pulsed.heartbeatAt, TS2);
      assert.equal(pulsed.status, "in_progress", "a heartbeat never changes status");

      // No resolver: the raw holder value stands in (the domain-only fallback).
      assert.throws(
        () => repos.tasks.setHeartbeat({ id: task.id, actor: "linus", now: TS2 }),
        (err) => {
          assert.equal(err.code, "EXECUTION_ACTIVE");
          assert.match(err.message, /held by elon/);
          return true;
        },
      );

      // Phase 7 — an injected `describeHolder` names the holder, and the raw
      // value does *not* also appear: a name-only message, not name-and-id.
      assert.throws(
        () =>
          repos.tasks.setHeartbeat({
            id: task.id,
            actor: "linus",
            now: TS2,
            describeHolder: (id) => (id === "elon" ? "Elon Musk" : null),
          }),
        (err) => {
          assert.equal(err.code, "EXECUTION_ACTIVE");
          assert.match(err.message, /held by Elon Musk/);
          assert.ok(!err.message.includes("elon"), `message must not carry the raw value: ${err.message}`);
          return true;
        },
      );

      repos.tasks.moveCas({ id: task.id, to: "todo", now: TS2 });
      assert.throws(
        () => repos.tasks.setHeartbeat({ id: task.id, actor: "elon", now: TS2 }),
        (err) => err.code === "INVALID_TRANSITION",
      );
      assert.throws(() => repos.tasks.setHeartbeat({ id: "nope", actor: "elon", now: TS2 }), (err) => err.code === "NOT_FOUND");

      // T-20261014-152924 — the third way a pulse can match nothing. A card that
      // is `in_progress` with nobody holding it is the corrupt state I2 names,
      // and it used to be reported as `EXECUTION_ACTIVE` "held by null" — a
      // claim conflict that does not exist, naming a holder that does not exist.
      db.prepare("UPDATE tasks SET status = 'in_progress', claimed_by = NULL WHERE id = ?").run(task.id);
      assert.throws(
        () => repos.tasks.setHeartbeat({ id: task.id, actor: "elon", now: TS2 }),
        (err) => err.code === "EXECUTION_STATE_CORRUPT",
      );

      // T-20261018-060214 — the same row shape on an epic is *designed*: the
      // container auto-start (`commands/rollup.mjs#startContainer`) moves an
      // epic into `in_progress` with nobody holding it. The zero-row explainer
      // must not call that I2 corruption.
      const epic = makeTask(repos, { kind: "epic" });
      db.prepare("UPDATE tasks SET status = 'in_progress', claimed_by = NULL WHERE id = ?").run(epic.id);
      assert.throws(
        () => repos.tasks.setHeartbeat({ id: epic.id, actor: "elon", now: TS2 }),
        (err) => {
          assert.equal(err.code, "INVALID_TRANSITION", "a container carries no claim — nothing to pulse");
          return true;
        },
      );
    });
  });

  it("points report_latest_id at a report and refuses one from another task", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "linus");
      const task = makeTask(repos);
      const other = makeTask(repos, { id: "other" });
      const report = repos.reports.insert(prepared(task.id, task.deliveryRound));

      assert.throws(
        () => repos.tasks.setReportLatest({ id: other.id, reportId: report.id, now: TS2 }),
        (err) => {
          assert.equal(err.code, "REPORT_TASK_MISMATCH");
          return true;
        },
      );
      const updated = repos.tasks.setReportLatest({ id: task.id, reportId: report.id, now: TS2 });
      assert.equal(updated.reportLatestId, report.id);
      assert.throws(
        () => repos.tasks.setReportLatest({ id: "nope", reportId: report.id, now: TS2 }),
        (err) => err.code === "NOT_FOUND",
      );
    });
  });

  it("archives only a terminal task and never changes its status (I6)", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      assert.throws(
        () => repos.tasks.archive({ id: task.id, now: TS2 }),
        (err) => {
          assert.equal(err.code, "ARCHIVE_NOT_TERMINAL");
          return true;
        },
      );

      repos.tasks.moveCas({ id: task.id, to: "in_progress", now: TS2 });
      assert.throws(
        () => repos.tasks.archive({ id: task.id, now: TS2 }),
        (err) => err.code === "REPORT_REQUIRED" || err.code === "ARCHIVE_NOT_TERMINAL",
      );
    });
  });

  it("lists with filters and hides archived tasks by default", async () => {
    await board(({ repos }) => {
      makeTask(repos, { title: "one" });
      const two = makeTask(repos, { title: "two", id: "t2", status: "done" });
      repos.tasks.archive({ id: two.id, now: TS2 });

      assert.deepEqual(repos.tasks.list().map((t) => t.title), ["one"]);
      assert.deepEqual(repos.tasks.list({ includeArchived: true }).map((t) => t.title).sort(), ["one", "two"]);
      assert.deepEqual(repos.tasks.list({ status: "done", includeArchived: true }).map((t) => t.title), ["two"]);
      assert.deepEqual(repos.tasks.list({ status: ["done", "todo"], includeArchived: true }).map((t) => t.title).sort(), ["one", "two"]);
      assert.deepEqual(repos.tasks.list({ limit: 1 }).length, 1);
      assert.deepEqual(repos.tasks.list({ projectId: "nope" }), []);
    });
  });

  it("filters the board read by the card being reviewed", async () => {
    await board(({ repos }) => {
      const original = makeTask(repos, { id: "original", title: "Original" });
      const other = makeTask(repos, { id: "other", title: "Other" });

      const live = makeReview(repos, { id: "review-live", reviewOfId: original.id, reviewRound: 1 });
      const archived = makeReview(repos, {
        id: "review-archived",
        status: "done",
        reviewOfId: original.id,
        reviewRound: 2,
      });
      makeReview(repos, { id: "review-other", reviewOfId: other.id, reviewRound: 1 });
      repos.tasks.archive({ id: archived.id, now: TS2 });

      assert.deepEqual(repos.tasks.list({ reviewOfId: original.id }).map((task) => task.id), [live.id]);
      assert.deepEqual(
        repos.tasks.list({ reviewOfId: original.id, includeArchived: true }).map((task) => task.id).sort(),
        [archived.id, live.id].sort(),
      );
      assert.deepEqual(repos.tasks.list({ reviewOfId: original.id, status: "todo" }).map((task) => task.id), [live.id]);
      assert.deepEqual(repos.tasks.list({ reviewOfId: original.id, limit: 0 }), []);
      assert.deepEqual(repos.tasks.list({ reviewOfId: "nope" }), []);
    });
  });
});

describe("repositories/relations", () => {
  it("adds edges with a normalised direction, and never lists a duplicate", async () => {
    await board(({ repos }) => {
      const a = makeTask(repos, { id: "a" });
      const b = makeTask(repos, { id: "b" });
      const related = repos.relations.insert({ type: "related", source: b.id, target: a.id, now: TS });
      assert.equal(related.source, "a");
      assert.equal(related.target, "b");
      assert.deepEqual(repos.relations.find({ type: "related", source: "b", target: "a" }), related);
      assert.throws(
        () => repos.relations.insert({ type: "related", source: "b", target: "a", now: TS }),
        (err) => err.code === "RELATION_DUPLICATE",
      );
      assert.equal(repos.relations.remove(related.id), true);
      assert.equal(repos.relations.remove(related.id), false);
    });
  });

  it("walks ancestors through a chain and reports parents and children", async () => {
    await board(({ repos }) => {
      const epic = makeTask(repos, { id: "epic", kind: "epic" });
      const mid = makeTask(repos, { id: "mid", kind: "epic" });
      const leaf = makeTask(repos, { id: "leaf" });
      repos.relations.insert({ type: "parent", source: epic.id, target: mid.id, now: TS });
      repos.relations.insert({ type: "parent", source: mid.id, target: leaf.id, now: TS });

      assert.deepEqual(repos.relations.listChildren(epic.id).map((r) => r.target), ["mid"]);
      assert.equal(repos.relations.getParent(leaf.id).source, "mid");
      assert.deepEqual(repos.relations.listAncestors(leaf.id).map((t) => t.id), ["mid", "epic"]);
      assert.deepEqual(repos.relations.listAncestors(epic.id), []);
      assert.deepEqual(repos.relations.listParentEdges("proj"), [
        { source: "epic", target: "mid" },
        { source: "mid", target: "leaf" },
      ]);
      assert.deepEqual(repos.relations.countByTask(epic.id), { children: 1, blockers: 0 });
    });
  });

  it("reads blockers and everything a task can touch", async () => {
    await board(({ repos }) => {
      const a = makeTask(repos, { id: "a" });
      const b = makeTask(repos, { id: "b" });
      repos.relations.insert({ type: "blocks", source: a.id, target: b.id, now: TS });
      assert.deepEqual(repos.relations.listBlockerOf(b.id).map((r) => r.source), ["a"]);
      assert.deepEqual(repos.relations.listBlockedBy(a.id).map((r) => r.target), ["b"]);
      assert.equal(repos.relations.listByTask(a.id).length, 1);
      assert.deepEqual(repos.relations.countByTask(b.id), { children: 0, blockers: 1 });
      assert.equal(repos.relations.get(999), null);
    });
  });
});

describe("repositories/comments", () => {
  it("appends, reads and finds by import sequence", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "linus");
      const task = makeTask(repos);
      const comment = repos.comments.append(
        normalizeCommentCreate(
          { body: "noted", kind: "note", author: { kind: "agent", id: "linus" }, refs: ["PROJ-0001"] },
          { now: TS, id: "c1", taskId: task.id, sourceSeq: 1 },
        ),
      );
      assert.equal(comment.body, "noted");
      assert.deepEqual(comment.refs, ["PROJ-0001"]);
      assert.deepEqual(repos.comments.list({ taskId: task.id }).map((c) => c.id), ["c1"]);
      assert.equal(repos.comments.getBySourceSeq(task.id, 1).id, "c1");
      assert.equal(repos.comments.getBySourceSeq(task.id, 2), null);
      assert.equal(repos.comments.count(task.id), 1);

      assert.throws(
        () =>
          repos.comments.append(
            normalizeCommentCreate(
              { body: "again", kind: "note", author: { kind: "agent", id: "linus" } },
              { now: TS, id: "c2", taskId: task.id, sourceSeq: 1 },
            ),
          ),
        (err) => {
          assert.equal(err.code, "COMMENT_DUPLICATE");
          return true;
        },
      );
    });
  });

  it("finds the human decisions on a task (I5)", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "Terry");
      ensureActor(db, "linus");
      const task = makeTask(repos);
      repos.comments.append(
        normalizeCommentCreate(
          { body: "go", kind: "confirm", author: { kind: "human", id: "Terry" } },
          { now: TS, id: "c1", taskId: task.id },
        ),
      );
      repos.comments.append(
        normalizeCommentCreate(
          { body: "ok", kind: "note", author: { kind: "agent", id: "linus" } },
          { now: TS2, id: "c2", taskId: task.id },
        ),
      );
      assert.deepEqual(repos.comments.listDecisions(task.id).map((c) => c.authorId), ["Terry"]);
      assert.deepEqual(repos.comments.list({ taskId: task.id, kind: "note" }).map((c) => c.id), ["c2"]);
      assert.deepEqual(repos.comments.list({ taskId: task.id, limit: 1 }).map((c) => c.id), ["c1"]);
      // The presentation read: newest first, and `limit` takes the newest N.
      assert.deepEqual(repos.comments.list({ taskId: task.id, order: "desc" }).map((c) => c.id), ["c2", "c1"]);
      assert.deepEqual(
        repos.comments.list({ taskId: task.id, order: "desc", limit: 1 }).map((c) => c.id),
        ["c2"],
      );
    });
  });
});

describe("repositories/reports", () => {
  it("stores rounds in order and answers the gate's question", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "linus");
      const task = makeTask(repos);
      const r1 = repos.reports.insert(prepared(task.id, 1));
      assert.equal(r1.round, 1);
      assert.equal(r1.taskId, task.id);
      assert.deepEqual(r1.evidence.items, [{ kind: "commit", sha: "abc1234" }]);
      assert.equal(repos.reports.get(r1.id).conclusion, "done");
      assert.deepEqual(repos.reports.listRounds(task.id), [1]);
      assert.equal(repos.reports.latestForRound(task.id, 1).id, r1.id);
      assert.equal(repos.reports.latestForRound(task.id, 2), null);
      assert.equal(repos.reports.latestRound(task.id), 1);
      assert.equal(repos.reports.count(task.id), 1);

      repos.reports.insert(prepared(task.id, 2));
      assert.deepEqual(repos.reports.listRounds(task.id), [1, 2]);
      assert.deepEqual(repos.reports.listByTask(task.id).map((r) => r.round), [1, 2]);
      assert.equal(repos.reports.latestRound(task.id), 2);
      assert.equal(repos.reports.latestForRound(task.id, 1).createdAt, TS, "round 1 is still there");
    });
  });

  it("keeps history: a second report for the same round is refused", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "linus");
      const task = makeTask(repos);
      repos.reports.insert(prepared(task.id, 1));
      assert.throws(() => repos.reports.insert(prepared(task.id, 1)), (err) => {
        assert.equal(err.code, "REPORT_ROUND_MISMATCH");
        assert.equal(err.http, 409);
        return true;
      });
      assert.equal(countRows(db, "task_reports"), 1);
    });
  });

  it("persists the rollup marker and exposes it to the gate (0033)", async () => {
    await board(({ db, repos }) => {
      ensureActor(db, "linus");
      const epic = makeTask(repos, { title: "Container", kind: "epic" });
      const rollup = repos.reports.insert({ ...prepared(epic.id, 1), isRollup: true });
      assert.equal(rollup.isRollup, true, "the DTO reads the integer back as a boolean");
      assert.equal(repos.reports.get(rollup.id).isRollup, true);
      assert.deepEqual(repos.reports.listGateReports(epic.id), [
        { round: 1, origin: "delivery", isRollup: true },
      ]);

      // A plain card's report is never a rollup, and the DB refuses a forged
      // marker even when the repository is bypassed in spirit.
      const task = makeTask(repos, { title: "Plain" });
      const plain = repos.reports.insert(prepared(task.id, 1));
      assert.equal(plain.isRollup, false);
      assert.throws(
        () => repos.reports.insert({ ...prepared(task.id, 2), isRollup: true }),
        (err) => String(err.message).includes("ROLLUP_INVALID"),
      );
      assert.equal(countRows(db, "task_reports"), 2);
    });
  });
});

describe("repositories/dictionary", () => {
  it("upserts by normalised name: the same name never becomes two rows", async () => {
    await board(({ db, repos }) => {
      const first = repos.dictionary.upsert({
        kind: "assignee",
        actorKind: "agent",
        normalizedName: "linus",
        displayName: "Linus",
        now: TS,
      });
      assert.equal(first.action, "created");
      assert.equal(first.entry.useCount, 1);

      const second = repos.dictionary.upsert({
        kind: "assignee",
        actorKind: "agent",
        normalizedName: "linus",
        displayName: "linus", // a sloppier spelling must not overwrite the dictionary's
        now: TS2,
      });
      assert.equal(second.action, "reused");
      assert.equal(second.entry.id, first.entry.id);
      assert.equal(second.entry.displayName, "Linus");
      assert.equal(second.entry.useCount, 2);
      assert.equal(second.entry.firstSeenAt, TS);
      assert.equal(second.entry.lastSeenAt, TS2);
      assert.equal(countRows(db, "actors"), 1);
    });
  });

  it("collapses one name onto one row, whatever the role (0019)", async () => {
    await board(({ repos }) => {
      const first = repos.dictionary.upsert({ kind: "assignee", normalizedName: "sam", displayName: "Sam", now: TS });
      const second = repos.dictionary.upsert({ kind: "assignee", normalizedName: "sam", displayName: "Sam", now: TS });
      const reporter = repos.dictionary.upsert({ kind: "reporter", normalizedName: "sam", displayName: "Sam", now: TS });
      // One name ⇒ one row: neither the role nor — since `0023` — a kind splits
      // it, because the row no longer has one (there is nothing left to disagree).
      assert.equal(second.entry.id, first.entry.id);
      assert.equal(reporter.entry.id, first.entry.id);
      assert.equal(reporter.action, "reused");
      assert.equal("kind" in first.entry && first.entry.kind !== null, false, "the row holds no actor kind");
      assert.equal(repos.dictionary.list("assignee").length, 1);
      assert.equal(repos.dictionary.list("reporter").length, 1);
    });
  });

  it("reports an actor's kind by aggregating the references that recorded one (0023)", async () => {
    // The row holds no kind, so the *registry read* derives one: the most recent
    // kind recorded on any reference naming the actor. That is what answers "is
    // this a person" for the roster, the sidebar and the assignee pickers.
    await board(({ db, repos }) => {
      const task = makeTask(repos);
      const linus = repos.dictionary.upsert({ kind: "assignee", normalizedName: "linus", displayName: "Linus", now: TS });
      const terry = repos.dictionary.upsert({ kind: "assignee", normalizedName: "terry", displayName: "Terry", now: TS });
      repos.dictionary.upsert({ kind: "assignee", normalizedName: "spare", displayName: "Spare", now: TS });

      repos.tasks.claimCas({ id: task.id, actor: linus.entry.id, claimedKind: "claude", now: TS });
      insertComment(db, { id: "c-1", task_id: task.id, author_id: terry.entry.id, author_kind: "human", created_at: TS });

      const kindOf = () =>
        Object.fromEntries(repos.dictionary.search("actor", {}).map((entry) => [entry.displayName, entry.kind]));
      assert.equal(kindOf().Linus, "claude", "the platform that took the claim");
      assert.equal(kindOf().Terry, "human", "a comment a person wrote");
      assert.equal(kindOf().Spare, null, "an actor nothing has named has no kind — not a fabricated `human`");

      // The **latest** wins, so a person who later works from a platform reads as
      // that platform — the fact the row's first-write-wins column could not hold.
      insertComment(db, { id: "c-2", task_id: task.id, author_id: terry.entry.id, author_kind: "codex", created_at: TS2 });
      assert.equal(kindOf().Terry, "codex", "the newest reference decides");
      assert.equal(kindOf().Linus, "claude", "and the others are untouched");
    });
  });

  it("searches for autocomplete and counts references", async () => {
    await board(({ repos }) => {
      const linus = repos.dictionary.upsert({ kind: "assignee", normalizedName: "linus", displayName: "Linus", now: TS });
      repos.dictionary.upsert({ kind: "assignee", normalizedName: "terry", displayName: "Terry", now: TS });
      assert.deepEqual(repos.dictionary.search("assignee", { q: "lin" }).map((e) => e.displayName), ["Linus"]);
      assert.deepEqual(repos.dictionary.search("assignee", { q: "LIN" }).map((e) => e.displayName), ["Linus"]);
      assert.equal(repos.dictionary.search("assignee", {}).length, 2);
      assert.equal(repos.dictionary.search("assignee", { limit: 1 }).length, 1);
      assert.equal(repos.dictionary.search("assignee", { q: "nobody" }).length, 0);

      const task = makeTask(repos, { assigneeId: linus.entry.id });
      assert.equal(repos.dictionary.refCount("assignee", linus.entry.id), 1);
      assert.equal(repos.dictionary.getById("assignee", linus.entry.id).displayName, "Linus");

      assert.throws(() => repos.dictionary.remove("assignee", linus.entry.id), (err) => {
        assert.equal(err.code, "DICTIONARY_ENTRY_IN_USE");
        return true;
      });
      assert.equal(repos.tasks.get(task.id).assigneeId, linus.entry.id, "the task is untouched");

      const spare = repos.dictionary.upsert({ kind: "assignee", normalizedName: "spare", displayName: "Spare", now: TS });
      assert.equal(repos.dictionary.remove("assignee", spare.entry.id), true);
      // An unknown **role** is still refused — there is no table for it.
      assert.throws(() => repos.dictionary.upsert({ kind: "nope", normalizedName: "x", displayName: "X", now: TS }), (err) => err.code === "VALIDATION_FAILED");
      // An `actorKind` is no longer an input at all: the row holds no kind, so
      // what a caller used to name here is now the kind it records on its own
      // reference. Passing the old option changes nothing.
      const withStaleOption = repos.dictionary.upsert({ kind: "assignee", actorKind: "robot", normalizedName: "x", displayName: "X", now: TS });
      assert.equal(withStaleOption.action, "created");
    });
  });
});

describe("repositories/sessions and attachments and activities", () => {
  it("upserts a session on its natural key and closes it", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      const session = repos.sessions.upsertByNaturalKey({
        taskId: task.id,
        seg: "seg2",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "ff309028",
        pid: 42,
        goal: "ship the drawer ordering",
        ts: TS,
      });
      assert.equal(session.status, "running");
      assert.equal(session.goal, "ship the drawer ordering");
      const same = repos.sessions.upsertByNaturalKey({
        taskId: task.id,
        seg: "seg2",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "ff309028",
        phase: "verify",
        status: "running",
        ts: TS2,
      });
      assert.equal(same.id, session.id, "the natural key keeps one row");
      assert.equal(same.phase, "verify");
      assert.equal(same.goal, "ship the drawer ordering", "an omitted goal keeps the registered one");
      const regraded = repos.sessions.upsertByNaturalKey({
        taskId: task.id,
        seg: "seg2",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "ff309028",
        goal: "  verify the upgrade  ",
        ts: TS2,
      });
      assert.equal(regraded.id, session.id);
      assert.equal(regraded.goal, "verify the upgrade", "a new goal is trimmed and replaces the old one");
      assert.deepEqual(repos.sessions.listByTask(task.id).length, 1);
      assert.equal(repos.sessions.find(task.id, "seg2", "linus").id, session.id);
      assert.equal(repos.sessions.get(session.id).pid, 42, "an unspecified pid is not clobbered to null");
      assert.equal(repos.sessions.close(session.id, { ts: TS2 }).status, "closed");
      assert.throws(() => repos.sessions.close("nope", { ts: TS2 }), (err) => err.code === "NOT_FOUND");
      assert.throws(
        () => repos.sessions.upsertByNaturalKey({ taskId: task.id, seg: "", owner: "x", ownerKind: "claude", sessionId: "s", ts: TS }),
        (err) => err.code === "VALIDATION_FAILED",
      );
    });
  });

  it("stores attachment metadata and refuses nonsense", async () => {
    await board(({ repos }) => {
      const task = makeTask(repos);
      const attachment = repos.attachments.insert({
        taskId: task.id,
        filename: "shot.png",
        contentType: "image/png",
        size: 1234,
        kind: "inline",
        createdAt: TS,
      });
      assert.equal(attachment.filename, "shot.png");
      assert.equal(repos.attachments.listByTask(task.id).length, 1);
      assert.equal(repos.attachments.get(attachment.id).size, 1234);
      // The content endpoint's one write: `size` stays honest, and a nonsense
      // size is refused before it reaches SQL.
      repos.attachments.setSize(attachment.id, 42);
      assert.equal(repos.attachments.get(attachment.id).size, 42);
      for (const size of [-1, 1.5, "42", null]) {
        assert.throws(() => repos.attachments.setSize(attachment.id, size), (err) => err.code === "VALIDATION_FAILED", String(size));
      }
      assert.equal(repos.attachments.get(attachment.id).size, 42, "a refused size changed nothing");
      assert.throws(() => repos.attachments.insert({ taskId: task.id, filename: "", createdAt: TS }), (err) => err.code === "VALIDATION_FAILED");
      assert.throws(() => repos.attachments.insert({ taskId: task.id, filename: "x", kind: "embed", createdAt: TS }), (err) => err.code === "VALIDATION_FAILED");
      assert.throws(() => repos.attachments.insert({ taskId: task.id, filename: "x", size: -1, createdAt: TS }), (err) => err.code === "VALIDATION_FAILED");
      assert.throws(() => repos.attachments.insert({ taskId: "nope", filename: "x", createdAt: TS }), (err) => err.code === "NOT_FOUND");
    });
  });

  it("appends and reads activities by cursor", async () => {
    await board(({ db, repos }) => {
      const task = makeTask(repos);
      const first = repos.activities.append({ taskId: task.id, actorKind: "agent", actorId: "linus", event: "task_created", changes: { a: 1 }, createdAt: TS });
      assert.equal(first.event, "task_created");
      assert.deepEqual(first.changes, { a: 1 });
      assert.equal(first.revision, revision(db) - 1, "the revision recorded is the one the change produced");

      repos.activities.append({ taskId: task.id, event: "task_updated", createdAt: TS2 });
      assert.deepEqual(repos.activities.list({ taskId: task.id }).map((a) => a.event), ["task_created", "task_updated"]);
      assert.deepEqual(
        repos.activities.list({ taskId: task.id, order: "desc" }).map((a) => a.event),
        ["task_updated", "task_created"],
        "order:desc reads newest first",
      );
      assert.deepEqual(
        repos.activities.list({ taskId: task.id, order: "bogus" }).map((a) => a.event),
        ["task_created", "task_updated"],
        "an unknown order is defensively ASC",
      );
      assert.deepEqual(repos.activities.list({ taskId: task.id, afterId: first.id }).map((a) => a.event), ["task_updated"]);
      assert.deepEqual(repos.activities.list({ afterRevision: 10_000 }), []);
      assert.equal(repos.activities.count(task.id), 2);
      assert.equal(repos.activities.count(), 2);
      assert.throws(() => repos.activities.append({ event: "", createdAt: TS }), (err) => err.code === "VALIDATION_FAILED");

      // A row someone wrote by hand with unreadable JSON: reading it must not
      // throw, because an audit trail that cannot be read is worse than one
      // with a raw string in it.
      db.prepare(
        "INSERT INTO task_activities(task_id, event, changes_json, created_at) VALUES (?,'handwritten','not json',?)",
      ).run(task.id, TS);
      const handwritten = repos.activities.list({ taskId: task.id }).at(-1);
      assert.deepEqual(handwritten.changes, { raw: "not json" });
    });
  });
});
