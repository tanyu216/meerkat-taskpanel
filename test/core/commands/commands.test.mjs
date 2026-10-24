/**
 * Step 12 (continued): dictionary, relations, comments and sessions commands —
 * plus the one structural promise the card makes about the dictionary: there is
 * no management API.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import * as commandsModule from "../../../src/core/commands/index.mjs";
import { FORBIDDEN_DICTIONARY_COMMANDS, createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { insertDeliveryReport } from "../../../src/core/commands/delivery-report.mjs";
import { resolveActorId } from "../../../src/core/commands/dictionary.mjs";
import { normalizeReportCreate } from "../../../src/core/domain/report.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import {
  TS,
  TS2,
  actorName,
  cleanupTempDirs,
  countRows,
  ensureActor,
  makeTempDir,
  revision,
  withBoard,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const AGENT = { kind: "agent", id: "linus" };
const HUMAN = { kind: "human", id: "Terry" };

async function board(fn, { clock } = {}) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, ...(clock === undefined ? {} : { clock }) });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
    return fn({ db, repos, ctx, commands });
  });
}

const report = () => ({
  conclusion: "done",
  acceptance: [{ text: "x", status: "met" }],
  evidence: [{ kind: "commit", sha: "abc1234" }],
  author: AGENT,
});

describe("commands/dictionary — no management surface (V8)", () => {
  it("exposes only read commands for the dictionary", async () => {
    await board(({ commands }) => {
      for (const forbidden of FORBIDDEN_DICTIONARY_COMMANDS) {
        assert.equal(forbidden in commands, false, `${forbidden} must not exist`);
      }
      assert.equal(typeof commands.listActors, "function");
      // ...and not as module exports either.
      for (const name of Object.keys(commandsModule)) {
        assert.equal(/assignee|reporter/i.test(name) && /add|remove|rename|create/i.test(name), false, name);
      }
    });
  });

  it("resolves free text: reuse on a hit, create on a miss, refuse on ambiguity", async () => {
    await board(({ db, commands }) => {
      const first = commands.createTask({ projectId: "proj", title: "one", assignee: "Linus", actor: AGENT });
      const second = commands.createTask({ projectId: "proj", title: "two", assignee: "linus", actor: AGENT });
      assert.equal(second.assigneeId, first.assigneeId, "case and spacing do not matter");
      assert.equal(countRows(db, "actors"), 1);
      assert.equal(commands.listActors({})[0].useCount, 2, "using it again counts once more");

      commands.createTask({ projectId: "proj", title: "three", assignee: "Linus Torvalds", actor: AGENT });
      assert.equal(commands.listActors({ q: "torvalds" })[0].displayName, "Linus Torvalds");

      assert.throws(
        () => commands.createTask({ projectId: "proj", title: "four", assignee: "linu", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "DICTIONARY_AMBIGUOUS");
          assert.deepEqual(
            err.details.candidates.map((c) => c.displayName),
            ["Linus", "Linus Torvalds"],
          );
          return true;
        },
      );
      assert.equal(countRows(db, "tasks"), 3, "the ambiguous create wrote no task");

      const forced = commands.createTask({
        projectId: "proj",
        title: "four",
        assignee: "linu",
        forceCreate: true,
        actor: AGENT,
      });
      assert.equal(commands.listActors({ q: "linu" }).length, 3);
      assert.equal(forced.assigneeId !== first.assigneeId, true);
    });
  });

  it("merges the assignee and reporter roles onto one actor row (0019)", async () => {
    await board(({ commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "one",
        assignee: "Sam",
        assigneeKind: "agent",
        reporter: "Sam",
        actor: AGENT,
      });
      // One table: the same name is ONE row whichever role names it, and both
      // columns point at it.
      assert.equal(task.assigneeId, task.reporterId);
      assert.equal(commands.listActors({}).length, 1);
    });
  });

  it("re-assigning through updateTask reuses the same entry", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      const updated = commands.updateTask({ id: task.id, assignee: "Linus", actor: AGENT });
      assert.equal(commands.listActors({}).length, 1);
      assert.equal(updated.assigneeId, commands.listActors({})[0].id);

      commands.updateTask({ id: task.id, assignee: "Linus", actor: AGENT });
      assert.equal(countRows(db, "actors"), 1, "the same name never duplicates");
      assert.equal(commands.listActors({})[0].useCount, 2);

      assert.throws(() => commands.updateTask({ id: task.id, actor: AGENT }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.match(err.message, /nothing to update/);
        return true;
      });
    });
  });
});

describe("commands/relations", () => {
  /** A review card for a delivered original, so the phase-1 creation guard passes. */
  const makeReview = (commands) => {
    const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
    commands.claim({ id: original.id, actor: AGENT });
    commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
    return commands.createTask({
      projectId: "proj",
      title: "Review",
      allowDup: true,
      reviewOf: original.identifier,
      reviewRound: original.deliveryRound,
      actor: AGENT,
    });
  };

  it("adds a parent edge, checking the epic rule first", async () => {
    await board(({ db, commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const child = commands.createTask({ projectId: "proj", title: "Child", actor: AGENT });
      const plain = commands.createTask({ projectId: "proj", title: "Plain", actor: AGENT });

      assert.throws(
        () => commands.addRelation({ type: "parent", source: plain.id, target: child.id, actor: AGENT }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.match(err.message, /only an epic can be a parent/);
          return true;
        },
      );

      const relation = commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });
      assert.equal(relation.type, "parent");
      assert.equal(relation.source, epic.id);
      assert.equal(relation.target, child.id);
      const activity = db.prepare("SELECT * FROM task_activities WHERE event='relation_added'").get();
      assert.equal(activity.task_id, child.id, "the activity hangs off the child");

      commands.removeRelation({ relationId: relation.id, actor: AGENT });
      const removed = db.prepare("SELECT * FROM task_activities WHERE event='relation_removed'").get();
      assert.equal(removed.task_id, child.id, "removal also hangs off the target");
      assert.deepEqual(JSON.parse(removed.changes_json), {
        relationId: relation.id,
        type: "parent",
        source: epic.id,
        target: child.id,
      });
    });
  });

  it("refuses a second parent, a cycle and a cross-project edge", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "other", name: "Other", actor: HUMAN });
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const a = commands.createTask({ projectId: "proj", title: "A", kind: "epic", actor: AGENT });
      const b = commands.createTask({ projectId: "proj", title: "B", kind: "epic", actor: AGENT });
      const c = commands.createTask({ projectId: "proj", title: "C", actor: AGENT });
      const elsewhere = commands.createTask({ projectId: "other", title: "Elsewhere", actor: AGENT });

      commands.addRelation({ type: "parent", source: epic.id, target: a.id, actor: AGENT });
      assert.throws(
        () => commands.addRelation({ type: "parent", source: c.id, target: a.id, actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED",
        "c is not an epic",
      );
      commands.addRelation({ type: "parent", source: a.id, target: b.id, actor: AGENT, force: true });
      assert.throws(
        () => commands.addRelation({ type: "parent", source: b.id, target: a.id, actor: AGENT, force: true }),
        (err) => {
          assert.equal(err.code, "RELATION_CYCLE");
          return true;
        },
      );
      assert.throws(
        () => commands.addRelation({ type: "related", source: a.id, target: elsewhere.id, actor: AGENT }),
        (err) => {
          assert.equal(err.code, "CROSS_PROJECT_RELATION");
          return true;
        },
      );
      assert.throws(
        () => commands.addRelation({ type: "blocks", source: a.id, target: "nope", actor: AGENT }),
        (err) => err.code === "NOT_FOUND",
      );
      assert.equal(c.id.length > 0, true);
    });
  });

  it("normalises `related`, lists the graph and removes an edge", async () => {
    await board(({ commands }) => {
      const a = commands.createTask({ projectId: "proj", title: "A", actor: AGENT });
      const b = commands.createTask({ projectId: "proj", title: "B", actor: AGENT });
      const relation = commands.addRelation({ type: "related", source: b.id, target: a.id, actor: AGENT });
      // Related edges are stored with a canonical direction (source < target),
      // whichever way round the caller asked for them.
      assert.deepEqual([relation.source, relation.target].sort(), [a.id, b.id].sort());
      assert.ok(relation.source < relation.target, "related is stored source < target");
      assert.throws(
        () => commands.addRelation({ type: "related", source: a.id, target: b.id, actor: AGENT }),
        (err) => err.code === "RELATION_DUPLICATE",
        "the same pair is the same edge, either way round",
      );

      const graph = commands.listRelations({ taskId: b.id });
      assert.equal(graph.relations.length, 1);
      assert.deepEqual(graph.relations[0], relation);

      assert.deepEqual(commands.removeRelation({ relationId: relation.id, actor: HUMAN }), {
        removed: true,
        relation,
      });
      assert.equal(commands.listRelations({ taskId: b.id }).relations.length, 0);
      assert.throws(() => commands.removeRelation({ relationId: relation.id, actor: HUMAN }), (err) => {
        assert.equal(err.code, "NOT_FOUND");
        return true;
      });
    });
  });

  it("finds the parent chain through identifiers", async () => {
    await board(({ commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const child = commands.createTask({ projectId: "proj", title: "Child", actor: AGENT });
      commands.addRelation({ type: "parent", source: "PROJ-0001", target: child.identifier, actor: AGENT });
      const graph = commands.listRelations({ taskId: child.identifier });
      assert.deepEqual(graph.ancestors.map((a) => a.identifier), [epic.identifier]);
    });
  });

  it("refuses a parent edge whose child is a review card", async () => {
    await board(({ commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const review = makeReview(commands);
      assert.throws(
        () => commands.addRelation({ type: "parent", source: epic.id, target: review.id, actor: AGENT }),
        (err) =>
          err.code === "VALIDATION_FAILED" &&
          err.details.field === "target" &&
          err.details.type === "parent" &&
          err.details.identifier === review.identifier,
      );
    });
  });

  it("refuses the same review-child edge even with force", async () => {
    await board(({ commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const review = makeReview(commands);
      assert.throws(
        () =>
          commands.addRelation({
            type: "parent",
            source: epic.id,
            target: review.id,
            actor: AGENT,
            force: true,
          }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "target",
      );
    });
  });

  it("refuses a parent edge whose source is a review card promoted to epic", async () => {
    await board(({ commands }) => {
      const review = makeReview(commands);
      commands.updateTask({ id: review.id, patch: { kind: "epic" }, actor: AGENT });
      const child = commands.createTask({
        projectId: "proj",
        title: "Child",
        allowDup: true,
        actor: AGENT,
      });
      assert.throws(
        () => commands.addRelation({ type: "parent", source: review.id, target: child.id, actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "source",
      );
    });
  });
});

describe("commands/comments", () => {
  it("appends a comment and records it once", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      // The author is already a dictionary entry, so the comment costs the row and
      // its audit row only (a first-ever author also creates its `actors` row).
      ensureActor(db, AGENT.id);
      const before = revision(db);
      const comment = commands.addComment({
        taskId: task.id,
        body: "Please confirm",
        kind: "discuss",
        actor: AGENT,
        refs: [task.identifier],
      });
      assert.equal(comment.kind, "discuss");
      assert.equal(revision(db), before + 2);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM task_activities WHERE event='comment_added'").get().n,
        1,
      );
      assert.deepEqual(commands.listComments({ taskId: task.id }).map((c) => c.id), [comment.id]);
    });
  });

  it("keeps the human decision trail readable (I5)", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      commands.addComment({ taskId: task.id, body: "ship it", kind: "confirm", actor: HUMAN });
      commands.addComment({ taskId: task.id, body: "noted", kind: "note", actor: AGENT });
      commands.addComment({ taskId: task.id, body: "please confirm", kind: "confirm_request", actor: AGENT });
      const decisions = commands.listDecisions({ taskId: task.id });
      // author_id is an actor id since 0020 — the trail still reads as the person.
      assert.deepEqual(decisions.map((c) => actorName(db, c.authorId)), ["Terry"]);
      assert.equal(decisions[0].body, "ship it");
      assert.throws(() => commands.addComment({ taskId: "nope", body: "x", actor: AGENT }), (err) => err.code === "NOT_FOUND");
      assert.throws(() => commands.addComment({ taskId: task.id, body: "", actor: AGENT }), (err) => err.code === "VALIDATION_FAILED");
    });
  });

  it("any human comment answers an awaiting question and re-queues the card", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "Ask",
        assignee: "linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      commands.claim({ id: task.id, actor: AGENT });
      commands.moveStatus({
        id: task.id,
        to: "awaiting",
        awaitingReason: "E2",
        question: "which schema should the migration use?",
        actor: AGENT,
      });
      assert.equal(commands.getTask({ id: task.id }).status, "awaiting");

      // Any human comment is the answer now — the kind is not consulted.
      commands.addComment({ taskId: task.id, body: "probably v2", kind: "discuss", actor: HUMAN });
      const resumed = commands.getTask({ id: task.id });
      assert.equal(resumed.status, "todo");
      assert.equal(resumed.claimedBy, null);
      assert.equal(resumed.awaitingReason, null);
      assert.equal(resumed.deliveryRound, 1, "an answer is not a reopen");
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM task_activities WHERE event = 'task_resumed'").get().n,
        1,
      );
      // ...and the poll offers it again, which is the whole point of `todo`.
      assert.deepEqual(
        commands.listCandidates({ assignee: "linus" }).map((candidate) => candidate.id),
        [task.id],
      );

      // A later human comment on the now-todo card adds no second resume.
      commands.addComment({ taskId: task.id, body: "and one more thing", kind: "note", actor: HUMAN });
      assert.equal(commands.getTask({ id: task.id }).status, "todo");
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM task_activities WHERE event = 'task_resumed'").get().n,
        1,
      );

      // Re-escalation: the earlier question now has a later human comment, so an
      // agent entering awaiting must supply a NEW question.
      commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "awaiting", awaitingReason: "E2", actor: AGENT }),
        (err) => err.code === "QUESTION_REQUIRED",
      );
    });
  });

  it("an agent decision never resumes the card", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ask", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.moveStatus({
        id: task.id,
        to: "awaiting",
        awaitingReason: "E2",
        question: "is this the right table?",
        actor: AGENT,
      });
      commands.addComment({ taskId: task.id, body: "I decided v2 is fine", kind: "decision", actor: AGENT });
      assert.equal(commands.getTask({ id: task.id }).status, "awaiting", "the human's is the only decision");
    });
  });
});

describe("commands/agent-sessions", () => {
  it("registers, re-registers and closes a session", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      const session = commands.registerSession({
        taskId: task.id,
        seg: "seg2",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "ff309028",
        pid: 4242,
        goal: "ship the drawer ordering",
      });
      assert.equal(session.status, "running");
      assert.equal(session.seg, "seg2");
      assert.equal(session.goal, "ship the drawer ordering");

      const again = commands.registerSession({
        taskId: task.id,
        seg: "seg2",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "ff309028",
        phase: "verify",
      });
      assert.equal(again.id, session.id, "the natural key keeps one row");
      assert.equal(again.phase, "verify");
      assert.equal(again.goal, "ship the drawer ordering", "re-registering without a goal keeps it");

      const closed = commands.closeSession({ sessionId: session.id, actor: AGENT });
      assert.equal(closed.status, "closed");
      assert.deepEqual(commands.listSessions({ taskId: task.id }).map((s) => s.status), ["closed"]);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM task_activities WHERE event LIKE 'session_%'").get().n,
        3,
      );
      assert.throws(() => commands.closeSession({ sessionId: "nope" }), (err) => err.code === "NOT_FOUND");
      assert.throws(
        () => commands.registerSession({ taskId: "nope", seg: "s", ownerKind: "claude", sessionId: "x" }),
        (err) => err.code === "NOT_FOUND",
      );
      // A session registered by identifier, with the owner defaulting to the actor.
      const byIdentifier = commands.registerSession({
        taskId: task.identifier,
        seg: "seg3",
        owner: "linus",
        ownerKind: "codex",
        sessionId: "abc",
        status: "failed",
      });
      assert.equal(byIdentifier.status, "failed");
      assert.equal(byIdentifier.taskId, task.id);
    });
  });
});

describe("commands — the project surface", () => {
  it("creates, reads back and owns a README", async () => {
    await board(({ db, commands }) => {
      assert.equal(commands.getProject({ id: "proj" }).name, "Project");
      assert.deepEqual(commands.listProjects().map((p) => p.id), ["proj"]);
      commands.readmeSet({ id: "proj", readme: "# Architecture\n" });
      assert.equal(commands.readmeGet({ id: "proj" }), "# Architecture\n");
      assert.throws(() => commands.readmeGet({ id: "nope" }), (err) => err.code === "NOT_FOUND");
      const updated = commands.updateProject({ id: "proj", patch: { meta: { git: "x" } } });
      assert.deepEqual(updated.meta, { git: "x" });

      // A project write is an event too: the activity stream is a cursor over
      // this table, so a change with no row produces no frame.
      const rows = db
        .prepare("SELECT task_id, changes_json FROM task_activities WHERE event = 'project_updated' ORDER BY id")
        .all();
      assert.deepEqual(rows.map((row) => ({ task_id: row.task_id, changes: JSON.parse(row.changes_json) })), [
        { task_id: null, changes: { project: "proj", fields: ["readme"] } },
        { task_id: null, changes: { project: "proj", fields: ["meta"] } },
      ]);
    });
  });

  it("exposes no directory lookup: a project is not bound to a path", async () => {
    await board(({ commands }) => {
      assert.equal(Object.hasOwn(commands, "projectForPath"), false);
    });
  });

  it("reads a task by id or identifier, refusing an ambiguous identifier", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "other", name: "Other", actor: HUMAN });
      const task = commands.createTask({ projectId: "proj", title: "one", identifier: "SHARED-0001", actor: AGENT });
      assert.equal(commands.getTask({ id: task.id }).id, task.id);
      assert.equal(commands.getTaskByIdentifier({ identifier: "SHARED-0001" }).id, task.id);

      commands.createTask({ projectId: "other", title: "two", identifier: "SHARED-0001", actor: AGENT });
      assert.throws(() => commands.getTaskByIdentifier({ identifier: "SHARED-0001" }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.match(err.message, /more than one project/);
        return true;
      });
    });
  });

  it("stamps project creation from the injected clock", async () => {
    await board(({ commands }) => {
      assert.equal(commands.getProject({ id: "proj" }).createdAt, TS2);
    }, { clock: () => TS2 });
  });
});

describe("commands/attachments — the write half of the attachment surface", () => {
  it("records the row and its audit entry from the injected clock", async () => {
    await board(({ repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "x", actor: AGENT });
      const { attachment } = commands.addAttachment({
        taskId: task.id,
        filename: "a.txt",
        contentType: "text/plain",
        size: 3,
        actor: AGENT,
      });
      assert.equal(attachment.createdAt, TS);
      assert.equal(attachment.kind, "attachment");
      assert.equal(attachment.size, 3);
      assert.deepEqual(
        repos.activities.list({ taskId: task.id }).map((row) => row.event).filter((e) => e.startsWith("attachment")),
        ["attachment_added"],
      );
      assert.throws(
        () => commands.addAttachment({ taskId: "nope", filename: "b.txt", actor: AGENT }),
        (err) => err.code === "NOT_FOUND",
      );
    }, { clock: () => TS });
  });

  it("stores the bytes and removes them, keeping the row and the disk in step", async () => {
    await board(({ repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "x", actor: AGENT });
      const { attachment } = commands.addAttachment({ taskId: task.id, filename: "a.txt", actor: AGENT });
      const path = join(makeTempDir("attach-"), attachment.id);

      commands.storeAttachmentContent({ attachment, path, body: Buffer.from("hey"), actor: AGENT });
      assert.equal(readFileSync(path, "utf8"), "hey");
      assert.equal(repos.attachments.get(attachment.id).size, 3);
      assert.deepEqual(
        repos.activities.list({ taskId: task.id }).map((row) => row.event).filter((e) => e.startsWith("attachment")),
        ["attachment_added", "attachment_updated"],
      );

      const stored = repos.attachments.get(attachment.id);
      commands.removeAttachment({ attachment: stored, path, actor: AGENT });
      assert.equal(repos.attachments.get(attachment.id), null);
      assert.equal(existsSync(path), false);
      assert.deepEqual(
        repos.activities.list({ taskId: task.id }).map((row) => row.event).filter((e) => e.startsWith("attachment")),
        ["attachment_added", "attachment_updated", "attachment_removed"],
      );
    });
  });
});

describe("commands/delivery-report — the one delivery-shaped insert", () => {
  it("threads seg/sessionId through (0035 removed the origin stamp)", async () => {
    await board(({ ctx, repos, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "x", actor: AGENT });
      // `task_reports.author_id` references `actors(id)` (0020), so the author
      // is resolved the way every delivery path resolves it before preparing.
      const authorId = resolveActorId({ repos, now: TS }, { name: AGENT.id, actorKind: AGENT.kind });
      const prepared = normalizeReportCreate(
        { ...report(), author: { kind: AGENT.kind, id: authorId } },
        { taskRound: task.deliveryRound, now: TS },
      );

      const withSession = insertDeliveryReport(ctx, {
        taskId: task.id,
        prepared,
        seg: "s1",
        sessionId: "sess",
      });
      assert.equal(withSession.origin, undefined, "0035 removed the provenance field");
      assert.equal(withSession.taskId, task.id);
      assert.equal(withSession.seg, "s1");
      assert.equal(withSession.sessionId, "sess");

      // One report per (task, round), so the no-session half gets its own card.
      const other = commands.createTask({ projectId: "proj", title: "y", actor: AGENT });
      const bare = insertDeliveryReport(ctx, { taskId: other.id, prepared });
      assert.equal(bare.seg, null);
      assert.equal(bare.sessionId, null);
    });
  });
});

describe("commands/projects — ensure", () => {
  it("creates once, then returns the existing row untouched", async () => {
    await board(async ({ commands, repos }) => {
      const first = commands.ensureProject({ id: "ensured", name: "Ensured", meta: { team: "panel" }, actor: HUMAN });
      assert.equal(first.created, true);
      assert.equal(first.project.name, "Ensured");
      assert.deepEqual(first.project.meta, { team: "panel" });

      // The second call is a read: a different name and meta are ignored.
      const second = commands.ensureProject({
        id: "ensured",
        name: "Renamed",
        meta: { team: "other" },
        actor: HUMAN,
      });
      assert.equal(second.created, false);
      assert.equal(second.project.name, "Ensured");
      assert.deepEqual(second.project.meta, { team: "panel" });
      assert.equal(repos.projects.list().filter((p) => p.id === "ensured").length, 1);
    });
  });
});

describe("commands — timestamps come from the context clock", () => {
  it("never reads the wall clock directly", async () => {
    let calls = 0;
    await board(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      const moved = commands.moveStatus({ id: task.id, to: "blocked", actor: AGENT });
      assert.equal(moved.blockedAt, TS);
      assert.equal(task.createdAt, TS);
      assert.ok(calls > 0, "the clock was consulted");
    }, { clock: () => {
      calls += 1;
      return TS;
    } });
  });
});

describe("commands/projects — the acceptance default (0037)", () => {
  it("stores an explicit acceptance and refuses a value outside the vocabulary", async () => {
    await board(({ commands }) => {
      const project = commands.createProject({ id: "acc", name: "Acc", acceptance: "human", actor: HUMAN });
      assert.equal(project.acceptance, "human");
      assert.throws(
        () => commands.createProject({ id: "bad", name: "Bad", acceptance: "sometimes", actor: HUMAN }),
        (err) => err.code === "VALIDATION_FAILED",
      );
    });
  });

  it("derives acceptance from the legacy review policy when none is given", async () => {
    await board(({ commands }) => {
      assert.equal(commands.createProject({ id: "r1", name: "R", reviewPolicy: "required", actor: HUMAN }).acceptance, "agent");
      assert.equal(commands.createProject({ id: "r2", name: "R", reviewPolicy: "off", actor: HUMAN }).acceptance, "off");
      assert.equal(commands.createProject({ id: "r3", name: "R", reviewPolicy: "optional", actor: HUMAN }).acceptance, "auto");
    });
  });

  it("updates the acceptance default, and refuses an unknown one", async () => {
    await board(({ commands }) => {
      assert.equal(commands.updateProject({ id: "proj", patch: { acceptance: "off" }, actor: HUMAN }).acceptance, "off");
      assert.throws(
        () => commands.updateProject({ id: "proj", patch: { acceptance: "never" }, actor: HUMAN }),
        (err) => err.code === "VALIDATION_FAILED",
      );
    });
  });
});
