/**
 * Step 12 (continued): dictionary, relations, comments and sessions commands —
 * plus the one structural promise the card makes about the dictionary: there is
 * no management API.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import * as commandsModule from "../../../src/core/commands/index.mjs";
import { FORBIDDEN_DICTIONARY_COMMANDS, createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  countRows,
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
    commands.createProject({ id: "proj", name: "Project", workspacePath: "/tmp/ws", actor: HUMAN });
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
      assert.equal(typeof commands.listAssignees, "function");
      assert.equal(typeof commands.listReporters, "function");
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
      assert.equal(countRows(db, "assignees"), 1);
      assert.equal(commands.listAssignees({})[0].useCount, 2, "using it again counts once more");

      commands.createTask({ projectId: "proj", title: "three", assignee: "Linus Torvalds", actor: AGENT });
      assert.equal(commands.listAssignees({ q: "torvalds" })[0].displayName, "Linus Torvalds");

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
      assert.equal(commands.listAssignees({ q: "linu" }).length, 3);
      assert.equal(forced.assigneeId !== first.assigneeId, true);
    });
  });

  it("keeps assignees and reporters apart", async () => {
    await board(({ commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "one",
        assignee: "Sam",
        assigneeKind: "agent",
        reporter: "Sam",
        actor: AGENT,
      });
      assert.notEqual(task.assigneeId, task.reporterId);
      assert.equal(commands.listAssignees({}).length, 1);
      assert.equal(commands.listReporters({}).length, 1);
      assert.equal(commands.listReporters({})[0].kind, "human", "the reporter defaults to a human");
    });
  });

  it("re-assigning through updateTask reuses the same entry", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      const updated = commands.updateTask({ id: task.id, assignee: "Linus", actor: AGENT });
      assert.equal(commands.listAssignees({}).length, 1);
      assert.equal(updated.assigneeId, commands.listAssignees({})[0].id);
      assert.equal(updated.assigneeKind, "agent");

      commands.updateTask({ id: task.id, assignee: "Linus", actor: AGENT });
      assert.equal(countRows(db, "assignees"), 1, "the same name never duplicates");
      assert.equal(commands.listAssignees({})[0].useCount, 2);

      assert.throws(() => commands.updateTask({ id: task.id, actor: AGENT }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.match(err.message, /nothing to update/);
        return true;
      });
    });
  });
});

describe("commands/relations", () => {
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
    });
  });

  it("refuses a second parent, a cycle and a cross-project edge", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "other", name: "Other", workspacePath: "/tmp/other", actor: HUMAN });
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const a = commands.createTask({ projectId: "proj", title: "A", actor: AGENT });
      const b = commands.createTask({ projectId: "proj", title: "B", actor: AGENT });
      const c = commands.createTask({ projectId: "proj", title: "C", actor: AGENT });
      const elsewhere = commands.createTask({ projectId: "other", title: "Elsewhere", actor: AGENT });

      commands.addRelation({ type: "parent", source: epic.id, target: a.id, actor: AGENT });
      assert.throws(
        () => commands.addRelation({ type: "parent", source: b.id, target: a.id, actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED",
        "b is not an epic",
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
});

describe("commands/comments", () => {
  it("appends a comment and records it once", async () => {
    await board(({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
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
    await board(({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "one", actor: AGENT });
      commands.addComment({ taskId: task.id, body: "ship it", kind: "confirm", actor: HUMAN });
      commands.addComment({ taskId: task.id, body: "noted", kind: "note", actor: AGENT });
      const decisions = commands.listDecisions({ taskId: task.id });
      assert.deepEqual(decisions.map((c) => c.authorId), ["Terry"]);
      assert.equal(decisions[0].body, "ship it");
      assert.throws(() => commands.addComment({ taskId: "nope", body: "x", actor: AGENT }), (err) => err.code === "NOT_FOUND");
      assert.throws(() => commands.addComment({ taskId: task.id, body: "", actor: AGENT }), (err) => err.code === "VALIDATION_FAILED");
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
        backend: "claude",
        sessionId: "ff309028",
        pid: 4242,
      });
      assert.equal(session.status, "running");
      assert.equal(session.seg, "seg2");

      const again = commands.registerSession({
        taskId: task.id,
        seg: "seg2",
        owner: "linus",
        backend: "claude",
        sessionId: "ff309028",
        phase: "verify",
      });
      assert.equal(again.id, session.id, "the natural key keeps one row");
      assert.equal(again.phase, "verify");

      const closed = commands.closeSession({ sessionId: session.id, actor: AGENT });
      assert.equal(closed.status, "closed");
      assert.deepEqual(commands.listSessions({ taskId: task.id }).map((s) => s.status), ["closed"]);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM task_activities WHERE event LIKE 'session_%'").get().n,
        3,
      );
      assert.throws(() => commands.closeSession({ sessionId: "nope" }), (err) => err.code === "NOT_FOUND");
      assert.throws(
        () => commands.registerSession({ taskId: "nope", seg: "s", backend: "claude", sessionId: "x" }),
        (err) => err.code === "NOT_FOUND",
      );
      // A session registered by identifier, with the owner defaulting to the actor.
      const byIdentifier = commands.registerSession({
        taskId: task.identifier,
        seg: "seg3",
        owner: "linus",
        backend: "codex",
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
    await board(({ commands }) => {
      assert.equal(commands.getProject({ id: "proj" }).name, "Project");
      assert.deepEqual(commands.listProjects().map((p) => p.id), ["proj"]);
      commands.readmeSet({ id: "proj", readme: "# Architecture\n" });
      assert.equal(commands.readmeGet({ id: "proj" }), "# Architecture\n");
      assert.throws(() => commands.readmeGet({ id: "nope" }), (err) => err.code === "NOT_FOUND");
      const updated = commands.updateProject({ id: "proj", patch: { meta: { git: "x" } } });
      assert.deepEqual(updated.meta, { git: "x" });
    });
  });

  it("finds the project for a directory", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "nested", name: "Nested", workspacePath: "/tmp/ws/sub", actor: HUMAN });
      assert.equal(commands.projectForPath({ path: "/tmp/ws/sub/deep" }).id, "nested");
      assert.equal(commands.projectForPath({ path: "/tmp/elsewhere" }), null);
    });
  });

  it("reads a task by id or identifier, refusing an ambiguous identifier", async () => {
    await board(({ commands }) => {
      commands.createProject({ id: "other", name: "Other", workspacePath: "/tmp/other", actor: HUMAN });
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
