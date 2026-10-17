/**
 * Step 12: task commands, the delivery gate and `deliver` (card A7, V6).
 *
 * The eight gate scenarios from the plan's §5 "报告门禁专项用例" live here,
 * driven through the *service* layer, while `test/contract/state-machine.test.mjs`
 * drives the same rules straight into SQL. Both must agree.
 *
 * Accounting convention asserted below: a write command costs one revision for
 * the row it changed plus one for the audit row it appended. What must never
 * happen is a *third* bump from the nested round update — that is the
 * regression this file guards (plan §3.3.6③).
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { advanceContainer } from "../../../src/core/commands/rollup.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";
import {
  TS,
  TS2,
  actorName,
  cleanupTempDirs,
  countRows,
  ensureActor,
  revision,
  withBoard,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const AGENT = { kind: "agent", id: "linus" };
const HUMAN = { kind: "human", id: "Terry" };

/** A board with repositories, commands and one project. */
async function board(fn, { clock } = {}) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, ...(clock === undefined ? {} : { clock }) });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
    return fn({ db, repos, ctx, commands });
  });
}

/** Activity events recorded against one task (the project row is not ours). */
const activitiesFor = (db, taskId) =>
  db
    .prepare("SELECT event FROM task_activities WHERE task_id = ? ORDER BY id")
    .all(taskId)
    .map((row) => row.event);

const report = (overrides = {}) => ({
  conclusion: "M1 core is done.",
  acceptance: [{ text: "domain has no Node I/O", status: "met" }],
  evidence: [{ kind: "commit", sha: "dcd7d15" }],
  author: AGENT,
  ...overrides,
});

describe("commands/tasks — create and update", () => {
  it("creates a task, allocates its identifier and writes exactly one activity", async () => {
    await board(async ({ db, commands }) => {
      const before = revision(db);
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });

      assert.equal(task.identifier, "PROJ-0001");
      assert.equal(task.status, "todo");
      assert.equal(task.deliveryRound, 1);
      assert.equal(countRows(db, "tasks"), 1);
      assert.deepEqual(activitiesFor(db, task.id), ["task_created"]);
      const activity = db.prepare("SELECT * FROM task_activities WHERE task_id = ?").get(task.id);
      assert.equal(activity.actor_id, "linus");
      assert.equal(revision(db), before + 2, "one bump for the task, one for the audit row");

      commands.createTask({ projectId: "proj", title: "Second", actor: AGENT });
      assert.equal(commands.listTasks()[0].identifier, "PROJ-0001", "identifiers do not repeat");
      assert.equal(commands.listTasks()[1].identifier, "PROJ-0002");
    });
  });

  it("refuses an unknown project and a bad payload, writing nothing", async () => {
    await board(async ({ db, commands }) => {
      const before = revision(db);
      assert.throws(() => commands.createTask({ projectId: "nope", title: "x", actor: AGENT }), (err) => {
        assert.equal(err.code, "NOT_FOUND");
        return true;
      });
      assert.throws(() => commands.createTask({ projectId: "proj", title: "", actor: AGENT }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        return true;
      });
      assert.throws(() => commands.createTask({ projectId: "proj", title: "x" }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.details.field, "actor");
        return true;
      });
      assert.equal(countRows(db, "tasks"), 0);
      assert.equal(revision(db), before, "a refused command changes nothing");
      assert.equal(commands.getProject({ id: "proj" }).nextTaskNumber, 1, "the serial was not burned");
    });
  });

  it("refuses to create a task directly in a delivery state (M3fix D1)", async () => {
    await board(async ({ db, commands }) => {
      const before = revision(db);

      // `in_review`/`done` presuppose a delivery a new task has not made, so a
      // create there is refused exactly like a reportless move: REPORT_REQUIRED,
      // the same details and the same repair hint.
      for (const status of ["in_review", "done"]) {
        assert.throws(
          () => commands.createTask({ projectId: "proj", title: "Too soon", status, actor: AGENT }),
          (err) => {
            assert.equal(err.code, "REPORT_REQUIRED", `status=${status}`);
            assert.equal(err.details.round, 1);
            assert.deepEqual(err.details.existingRounds, []);
            assert.match(err.hint.command, /issue deliver PROJ-0001/);
            return true;
          },
        );
      }

      assert.equal(countRows(db, "tasks"), 0, "nothing was written");
      assert.equal(revision(db), before, "a refused create changes nothing");
      assert.equal(commands.getProject({ id: "proj" }).nextTaskNumber, 1, "the serial was not burned");

      // The states a task *may* start in still work.
      for (const status of ["todo", "backlog", "blocked"]) {
        assert.equal(
          commands.createTask({ projectId: "proj", title: `Starts in ${status}`, status, actor: AGENT }).status,
          status,
        );
      }
    });
  });

  it("resolves the assignee in the same transaction (event-driven dictionary)", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "Ship M1",
        assignee: "Linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      assert.equal(countRows(db, "actors"), 1);
      const entry = commands.listActors({})[0];
      assert.equal(task.assigneeId, entry.id);
      assert.equal(entry.kind, "agent", "the actor's kind lives on the actor row");
      assert.equal(entry.displayName, "Linus");
      assert.equal(entry.useCount, 1);

      const activity = db.prepare("SELECT changes_json FROM task_activities WHERE event='task_created'").get();
      assert.deepEqual(JSON.parse(activity.changes_json).dictionaries, [
        { dictionary: "assignee", id: entry.id, displayName: "Linus", action: "created" },
      ]);
    });
  });

  it("rolls the dictionary back with the task when the create fails", async () => {
    await board(async ({ db, commands, repos }) => {
      // A name that only fails later: an ambiguous one.
      commands.createTask({ projectId: "proj", title: "one", assignee: "Linus Torvalds", actor: AGENT });
      repos.dictionary.upsert({
        kind: "assignee",
        actorKind: "agent",
        normalizedName: "linus",
        displayName: "Linus",
        now: TS,
      });

      assert.throws(
        () => commands.createTask({ projectId: "proj", title: "two", assignee: "lin", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "DICTIONARY_AMBIGUOUS");
          assert.equal(err.details.candidates.length, 2);
          return true;
        },
      );
      assert.equal(countRows(db, "tasks"), 1, "the failed create left no task");
      assert.equal(countRows(db, "actors"), 2, "and no stray dictionary row");
    });
  });

  it("patches with a version check and records one activity", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      const before = revision(db);
      const updated = commands.updateTask({
        id: task.id,
        ifVersion: 1,
        patch: { title: "Ship M1 (renamed)", priority: "high" },
        actor: AGENT,
      });
      assert.equal(updated.title, "Ship M1 (renamed)");
      assert.equal(updated.priority, "high");
      assert.equal(updated.version, 2);
      assert.equal(revision(db), before + 2);
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_updated"]);

      const after = revision(db);
      assert.throws(
        () => commands.updateTask({ id: task.id, ifVersion: 1, patch: { title: "stale" }, actor: AGENT }),
        (err) => err.code === "VERSION_CONFLICT",
      );
      assert.equal(revision(db), after, "a lost CAS changes nothing");
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_updated"]);
    });
  });
});

describe("commands/tasks — an epic with children cannot be downgraded", () => {
  it("refuses the downgrade through the service and writes nothing", async () => {
    await board(async ({ db, commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: AGENT });
      const child = commands.createTask({ projectId: "proj", title: "Child", actor: AGENT });
      commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });

      const before = revision(db);
      assert.throws(() => commands.updateTask({ id: epic.id, patch: { kind: "task" }, actor: AGENT }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.http, 400);
        assert.equal(err.details.field, "kind");
        assert.equal(err.details.children, 1);
        assert.match(err.message, /children/);
        return true;
      });
      assert.equal(revision(db), before, "a refused downgrade changes nothing");
      assert.equal(commands.getTask({ id: epic.id }).kind, "epic");
    });
  });

  it("still lets a task upgrade to epic, and a childless epic downgrade", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Task", actor: AGENT });
      const upgraded = commands.updateTask({ id: task.id, patch: { kind: "epic" }, actor: AGENT });
      assert.equal(upgraded.kind, "epic");

      const downgraded = commands.updateTask({ id: task.id, patch: { kind: "task" }, actor: AGENT });
      assert.equal(downgraded.kind, "task", "no children, so the downgrade is free");
    });
  });
});

describe("commands/tasks — promoting a card into an epic (the container protocol)", () => {
  // The board skill teaches this order for a card that turns out to hold several
  // deliverables: promote it, split it into children, close it with a rollup
  // report. Since 0024 the container needs no parking move to be closable — an
  // epic's `todo` row carries `in_review`, the one pair in
  // `EPIC_ONLY_TRANSITIONS` — so what is asserted here is the *new* set of
  // refusals: the container is still never claimed, and a `task` in `todo` still
  // cannot skip the work cycle into review. Widening the machine again (or
  // narrowing it) means coming back here and re-teaching the skill.
  const linusTask = (commands, extra = {}) =>
    commands.createTask({ projectId: "proj", title: "For linus", assignee: "linus", assigneeKind: "agent", actor: AGENT, ...extra });

  it("promotes in place: the kind changes and nothing else does", async () => {
    await board(async ({ db, commands }) => {
      const task = linusTask(commands);
      const claimed = commands.claim({ id: task.id, actor: AGENT }).task;
      assert.match(task.idem, /^task \| linus/, "the key's first slot is the kind at create time");

      const promoted = commands.updateTask({ id: task.id, patch: { kind: "epic" }, actor: AGENT });

      assert.equal(promoted.kind, "epic");
      assert.equal(promoted.status, "in_progress", "a patch is not a move");
      assert.equal(promoted.claimedBy, claimed.claimedBy, "the execution claim rides along");
      assert.equal(promoted.deliveryRound, claimed.deliveryRound, "no delivery-round bump");
      assert.equal(promoted.idem, task.idem, "frozen at create; a promotion does not rewrite it");
      assert.equal(promoted.version, claimed.version + 1);
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed", "task_updated"]);
      const last = db
        .prepare("SELECT changes_json FROM task_activities WHERE task_id = ? ORDER BY id DESC LIMIT 1")
        .get(task.id);
      assert.deepEqual(JSON.parse(last.changes_json).fields, ["kind"], "a promotion carries no prose");
    });
  });

  it("has no exit from todo other than the epic's own — and the claim gate still holds", async () => {
    await board(async ({ commands }) => {
      const epic = linusTask(commands, { kind: "epic" });

      // The half that is product semantics and must not have moved: an epic is a
      // container, so it is never claimed and never offered by the poll.
      assert.throws(
        () => commands.moveStatus({ id: epic.id, to: "in_progress", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "not_claimable");
          assert.equal(err.http, 409);
          return true;
        },
      );
      assert.deepEqual(commands.listCandidates({ assignee: "linus" }), [], "the poll never offers a container");

      // The half that was the dead end: the row is `todo`'s plus `in_review`.
      assert.throws(
        () => commands.moveStatus({ id: epic.id, to: "done", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "INVALID_TRANSITION");
          assert.deepEqual(err.details.allowed, ["backlog", "in_progress", "blocked", "canceled", "in_review"]);
          return true;
        },
        "the overlay adds a delivery, not a shortcut to done",
      );
      assert.equal(commands.canMove({ taskId: epic.id, to: "in_review" }).reason, "REPORT_REQUIRED", "and not without a report");
      assert.equal(commands.canMove({ taskId: epic.id, to: "backlog" }).ok, true);
    });
  });

  it("delivers a `todo` epic to in_review with its rollup report — the dead end, closed", async () => {
    await board(async ({ db, commands }) => {
      const epic = linusTask(commands, { kind: "epic" });
      assert.equal(epic.status, "todo", "which is where `issue create --kind epic` puts a container");

      const delivered = commands.deliver({ taskId: epic.id, report: report(), actor: AGENT });

      assert.equal(delivered.task.status, "in_review");
      assert.equal(delivered.report.origin, "delivery", "the gate's own row, not history");
      assert.equal(delivered.report.round, 1);
      assert.equal(delivered.task.deliveryRound, 1, "delivering from todo is not a rework");
      assert.deepEqual(activitiesFor(db, epic.id), ["task_created", "task_delivered"]);
      // ...and review is still the only way on: `done` is one move away, from
      // `in_review`, exactly as it is for a task.
      assert.equal(commands.moveStatus({ id: epic.id, to: "done", actor: AGENT }).status, "done");
    });
  });

  it("refuses the same move for a `task`, and for an epic with no report", async () => {
    await board(async ({ commands }) => {
      const task = linusTask(commands);
      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "INVALID_TRANSITION");
          assert.deepEqual(err.details.allowed, ["backlog", "in_progress", "blocked", "canceled"]);
          return true;
        },
        "a task still cannot reach review without being worked",
      );

      // The kind dimension is not the gate: an epic that owes a report is refused
      // for the report, and told how to write it.
      const epic = linusTask(commands, { kind: "epic", allowDup: true });
      assert.throws(
        () => commands.moveStatus({ id: epic.id, to: "in_review", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "REPORT_REQUIRED");
          assert.match(err.hint?.command ?? "", /^taskctl issue deliver /);
          assert.deepEqual(err.details.allowed, undefined, "a gate refusal is not a whitelist refusal");
          return true;
        },
      );
      // ...and the audited waiver is still the one way past it, from `todo` too.
      const waived = commands.moveStatus({ id: epic.id, to: "in_review", actor: AGENT, noReport: true, reason: "rollup in the children" });
      assert.equal(waived.status, "in_review");
    });
  });

  it("keeps the old `blocked/dependency` parking legal — a container may still wait", async () => {
    await board(async ({ commands }) => {
      const epic = linusTask(commands, { kind: "epic" });
      const parked = commands.moveStatus({ id: epic.id, to: "blocked", blockedReason: "dependency", actor: AGENT });
      assert.equal(parked.status, "blocked");
      assert.equal(parked.blockedReason, "dependency");
    });
  });

  it("lets an epic parent children — but not a card still typed `task`", async () => {
    await board(async ({ repos, commands }) => {
      const container = linusTask(commands, { title: "Container to be" });
      const child = linusTask(commands, { title: "Child", allowDup: true });

      assert.throws(
        () => commands.addRelation({ type: "parent", source: container.id, target: child.id, actor: AGENT }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.equal(err.details.field, "kind");
          return true;
        },
        "promote first: only an epic may be a parent",
      );

      commands.updateTask({ id: container.id, patch: { kind: "epic" }, actor: AGENT });
      commands.addRelation({ type: "parent", source: container.id, target: child.id, actor: AGENT });
      assert.deepEqual(repos.relations.listChildren(container.id).map((edge) => edge.target), [child.id]);
    });
  });

  it("closes the container from its park, with a rollup report", async () => {
    await board(async ({ db, commands }) => {
      const container = linusTask(commands);
      commands.updateTask({ id: container.id, patch: { kind: "epic" }, actor: AGENT });
      commands.moveStatus({ id: container.id, to: "blocked", blockedReason: "dependency", actor: AGENT });

      const delivered = commands.deliver({ taskId: container.id, report: report(), actor: AGENT });

      assert.equal(delivered.task.status, "in_review");
      assert.equal(delivered.task.deliveryRound, 1);
      const stored = db.prepare("SELECT round, origin FROM task_reports WHERE task_id = ?").get(container.id);
      assert.equal(stored.origin, "delivery", "the gate is kind-agnostic: a container delivers like a leaf");
      assert.equal(stored.round, 1);
      assert.deepEqual(activitiesFor(db, container.id), ["task_created", "task_updated", "task_moved", "task_delivered"]);
    });
  });
});

describe("commands/tasks — the container rollup (a container closes itself)", () => {
  // The board closes an epic when its **last** child reaches `done`: one
  // transaction, a system-authored rollup report, and the container lands in
  // `in_review` for a human to accept. `done` stays a human's, so acceptance
  // gates the tree from the bottom up.
  const linusTask = (commands, extra = {}) =>
    commands.createTask({ projectId: "proj", title: "Child", assignee: "linus", assigneeKind: "agent", actor: AGENT, ...extra });

  const epicWith = (commands, children) => {
    const epic = commands.createTask({ projectId: "proj", title: "Container", kind: "epic", actor: AGENT });
    for (const child of children) {
      commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });
    }
    return epic;
  };

  /** Walk a child to `done` the way the board allows: claim, deliver, accept. */
  const finish = (commands, task, sha) => {
    commands.claim({ id: task.id, actor: AGENT });
    commands.deliver({ taskId: task.id, report: report({ evidence: [{ kind: "commit", sha }] }), actor: AGENT });
    return commands.moveStatus({ id: task.id, to: "done", actor: AGENT });
  };

  it("closes the container on the last child, with a system rollup report", async () => {
    await board(async ({ db, commands }) => {
      const one = linusTask(commands, { title: "One" });
      const two = linusTask(commands, { title: "Two", allowDup: true });
      const epic = epicWith(commands, [one, two]);

      finish(commands, one, "abc1234");
      assert.equal(
        commands.getTask({ id: epic.id }).status,
        "in_progress",
        "one child is not the whole set — but the container has started",
      );

      finish(commands, two, "def5678");
      const closed = commands.getTask({ id: epic.id });
      assert.equal(closed.status, "in_review");
      assert.equal(closed.deliveryRound, 1, "a first delivery, not a rework");

      const reports = db
        .prepare("SELECT round, origin, author_kind, acceptance_json, evidence_json FROM task_reports WHERE task_id = ?")
        .all(epic.id);
      assert.equal(reports.length, 1, "the board wrote exactly one rollup report");
      assert.equal(reports[0].origin, "delivery");
      assert.equal(reports[0].author_kind, "system", "the board wrote it, not the last agent");
      assert.equal(reports[0].round, 1);
      assert.equal(JSON.parse(reports[0].acceptance_json).length, 2, "one criterion per child");
      // The children's evidence, unioned and de-duplicated: the work happened
      // there, not in the container.
      assert.equal(JSON.parse(reports[0].evidence_json).length, 2);
      assert.deepEqual(activitiesFor(db, epic.id), [
        "task_created",
        "epic_auto_start",
        "comment_added",
        "task_delivered",
        "comment_added",
      ]);
      // The two comments are the container's own account: start (event) and
      // rollup (event), both authored by the board.
      // `rowid`, not `id`: comment ids are UUIDs, so the primary key is not
      // insertion order (the activity trail is what says what happened, but the
      // two notes are also read in the order the board wrote them).
      const notes = db
        .prepare("SELECT kind, author_kind, body FROM comments WHERE task_id = ? ORDER BY rowid")
        .all(epic.id);
      assert.equal(notes.length, 2);
      assert.deepEqual(
        notes.map((note) => note.kind),
        ["note", "note"],
      );
      assert.deepEqual(
        notes.map((note) => note.author_kind),
        ["system", "system"],
      );
      assert.match(notes[0].body, /^Auto-start \(event\): child PROJ-\d+ is in progress/);
      assert.match(notes[1].body, /^Auto-rollup \(event\): 2\/2 child card\(s\) done \(PROJ-\d+, PROJ-\d+\)/);
      assert.match(notes[1].body, /awaiting human acceptance/);
    });
  });

  it("waits while any child is unfinished", async () => {
    await board(async ({ db, commands }) => {
      const one = linusTask(commands, { title: "One" });
      const two = linusTask(commands, { title: "Two", allowDup: true });
      const epic = epicWith(commands, [one, two]);

      finish(commands, one, "abc1234");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 0);
    });
  });

  it("waits while a child is canceled — that call is a human's", async () => {
    await board(async ({ commands }) => {
      const done = linusTask(commands, { title: "Done" });
      const canceled = linusTask(commands, { title: "Canceled", allowDup: true });
      const epic = epicWith(commands, [done, canceled]);
      commands.moveStatus({ id: canceled.id, to: "canceled", actor: AGENT });

      finish(commands, done, "abc1234");
      assert.equal(
        commands.getTask({ id: epic.id }).status,
        "in_progress",
        "a canceled child is not a delivered one — the container stays open",
      );
    });
  });

  it("leaves a card with no parent untouched", async () => {
    await board(async ({ db, commands }) => {
      const solo = linusTask(commands, { title: "Solo" });
      finish(commands, solo, "abc1234");

      assert.deepEqual(activitiesFor(db, solo.id), ["task_created", "task_claimed", "task_delivered", "task_moved"]);
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports").get().c, 1, "its own report, and nothing else");
    });
  });

  it("waits for a nested container to be accepted, then closes its parent", async () => {
    await board(async ({ commands }) => {
      const grand = linusTask(commands, { title: "Grandchild" });
      const inner = commands.createTask({ projectId: "proj", title: "Inner", kind: "epic", actor: AGENT });
      commands.addRelation({ type: "parent", source: inner.id, target: grand.id, actor: AGENT });
      const outer = commands.createTask({ projectId: "proj", title: "Outer", kind: "epic", actor: AGENT });
      commands.addRelation({ type: "parent", source: outer.id, target: inner.id, actor: AGENT });

      finish(commands, grand, "abc1234");
      assert.equal(commands.getTask({ id: inner.id }).status, "in_review", "the inner container rolls up");
      assert.equal(
        commands.getTask({ id: outer.id }).status,
        "in_progress",
        "the outer container started when its child did, but a human has not accepted the inner one",
      );

      // The human accepts the inner container: only then is the outer one whole.
      commands.moveStatus({ id: inner.id, to: "done", actor: AGENT });
      assert.equal(commands.getTask({ id: outer.id }).status, "in_review");
    });
  });

  it("does not close a container whose children were all waived", async () => {
    await board(async ({ commands }) => {
      const one = linusTask(commands, { title: "One" });
      const two = linusTask(commands, { title: "Two", allowDup: true });
      const epic = epicWith(commands, [one, two]);
      for (const child of [one, two]) {
        commands.claim({ id: child.id, actor: AGENT });
        commands.moveStatus({
          id: child.id,
          to: "in_review",
          noReport: true,
          reason: "delivered under an audited waiver",
          actor: AGENT,
        });
        commands.moveStatus({ id: child.id, to: "done", actor: AGENT });
      }

      // No report of theirs to stand on: the container is left for a human
      // (started, because its children were worked, but not delivered).
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");
      const manual = commands.deliver({ taskId: epic.id, report: report(), actor: AGENT });
      assert.equal(manual.task.status, "in_review", "the manual path still works");
    });
  });

  it("is idempotent: a closed container is not delivered twice", async () => {
    await board(async ({ db, commands, ctx, repos }) => {
      const child = linusTask(commands, { title: "Only" });
      const epic = epicWith(commands, [child]);
      finish(commands, child, "abc1234");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");

      const before = db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c;
      assert.equal(advanceContainer(ctx, epic.id, ctx.now()), null, "already closed: nothing to do");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, before);
      assert.equal(repos.relations.listChildren(epic.id).length, 1);
    });
  });

  it("re-checks when the last unfinished child is detached", async () => {
    await board(async ({ repos, commands }) => {
      const done = linusTask(commands, { title: "Done" });
      const pending = linusTask(commands, { title: "Pending", allowDup: true });
      const epic = epicWith(commands, [done, pending]);
      finish(commands, done, "abc1234");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");

      const edge = repos.relations.listChildren(epic.id).find((relation) => relation.target === pending.id);
      commands.removeRelation({ relationId: edge.id, actor: AGENT });
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review", "the remaining children are all done");
    });
  });
});

describe("commands/tasks — the container lifecycle (system start, notes, reconcile)", () => {
  // The A′ lifecycle: a child entering the work starts its container
  // (`todo → in_progress`, a *system* move — no claim), and the last child's
  // acceptance delivers it (`→ in_review`). Both transitions leave a system
  // note naming their source; `reconcileContainers` replays the rules for a
  // write that bypassed the hooks.
  const linusTask = (commands, extra = {}) =>
    commands.createTask({ projectId: "proj", title: "Child", assignee: "linus", assigneeKind: "agent", actor: AGENT, ...extra });

  const epicWith = (commands, children) => {
    const epic = commands.createTask({ projectId: "proj", title: "Container", kind: "epic", actor: AGENT });
    for (const child of children) {
      commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });
    }
    return epic;
  };

  const finish = (commands, task, sha) => {
    commands.claim({ id: task.id, actor: AGENT });
    commands.deliver({ taskId: task.id, report: report({ evidence: [{ kind: "commit", sha }] }), actor: AGENT });
    return commands.moveStatus({ id: task.id, to: "done", actor: AGENT });
  };

  const notesFor = (db, taskId) =>
    db.prepare("SELECT body, kind, author_kind FROM comments WHERE task_id = ? ORDER BY rowid").all(taskId);

  it("starts the container when its first child enters the work — a system move, not a claim", async () => {
    await board(async ({ db, commands }) => {
      const child = linusTask(commands);
      const epic = epicWith(commands, [child]);
      assert.equal(epic.status, "todo");

      commands.claim({ id: child.id, actor: AGENT });

      const started = commands.getTask({ id: epic.id });
      assert.equal(started.status, "in_progress", "the container is live while a child works");
      assert.equal(started.claimedBy, null, "an epic is nobody's work card");
      assert.equal(started.claimedAt, null);
      assert.deepEqual(activitiesFor(db, epic.id), ["task_created", "epic_auto_start", "comment_added"]);

      const [note] = notesFor(db, epic.id);
      assert.equal(note.kind, "note");
      assert.equal(note.author_kind, "system", "the board wrote it");
      assert.match(note.body, /^Auto-start \(event\): child PROJ-\d+ is in progress; epic moved todo → in_progress at /);
    });
  });

  it("starts it once: a second child's claim writes no second note", async () => {
    await board(async ({ db, commands }) => {
      const one = linusTask(commands, { title: "One" });
      const two = linusTask(commands, { title: "Two", allowDup: true });
      const epic = epicWith(commands, [one, two]);

      commands.claim({ id: one.id, actor: AGENT });
      commands.claim({ id: two.id, actor: AGENT });

      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");
      assert.equal(notesFor(db, epic.id).length, 1, "the start is recorded once");
      assert.deepEqual(activitiesFor(db, epic.id), ["task_created", "epic_auto_start", "comment_added"]);
    });
  });

  it("starts the container on a rework back into the work, not only on a claim", async () => {
    await board(async ({ commands }) => {
      const child = linusTask(commands);
      const epic = epicWith(commands, [child]);
      // `todo → blocked` proves no work happened, so it does not start the epic.
      commands.moveStatus({ id: child.id, to: "blocked", actor: AGENT });
      assert.equal(commands.getTask({ id: epic.id }).status, "todo");

      commands.moveStatus({ id: child.id, to: "in_progress", actor: AGENT });
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");
    });
  });

  it("reconciles a child attached after it finished — dry run writes nothing, the sweep closes once", async () => {
    await board(async ({ db, commands }) => {
      const child = linusTask(commands);
      finish(commands, child, "abc1234");
      const epic = epicWith(commands, [child]); // attached after the fact: addRelation fires no hook
      assert.equal(commands.getTask({ id: epic.id }).status, "todo");

      const plan = commands.reconcileContainers({ dryRun: true });
      const planned = plan.actions.find((entry) => entry.epic === epic.identifier);
      assert.deepEqual({ action: planned.action, reason: planned.reason }, {
        action: "close",
        reason: "all_children_done",
      });
      assert.equal(commands.getTask({ id: epic.id }).status, "todo", "a dry run writes nothing");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 0);
      assert.equal(notesFor(db, epic.id).length, 0);
      assert.deepEqual(activitiesFor(db, epic.id), ["task_created"]);

      const applied = commands.reconcileContainers({});
      assert.equal(applied.actions.find((entry) => entry.epic === epic.identifier).action, "close");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");
      const [note] = notesFor(db, epic.id);
      assert.match(note.body, /^Auto-rollup \(sweep\): 1\/1 child card\(s\) done /);

      const again = commands.reconcileContainers({});
      assert.equal(again.actions.find((entry) => entry.epic === epic.identifier).action, "none");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 1);
      assert.equal(notesFor(db, epic.id).length, 1, "a second sweep writes no duplicate note");
    });
  });

  it("reconciles a child attached after it started — the sweep starts the container", async () => {
    await board(async ({ db, commands }) => {
      const child = linusTask(commands);
      commands.claim({ id: child.id, actor: AGENT });
      const epic = epicWith(commands, [child]);
      assert.equal(commands.getTask({ id: epic.id }).status, "todo");

      const plan = commands.reconcileContainers({ dryRun: true });
      assert.equal(plan.actions.find((entry) => entry.epic === epic.identifier).action, "start");
      assert.equal(commands.getTask({ id: epic.id }).status, "todo");

      commands.reconcileContainers({});
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");
      assert.equal(commands.getTask({ id: epic.id }).claimedBy, null);
      const [note] = notesFor(db, epic.id);
      assert.match(note.body, /^Auto-start \(sweep\): child PROJ-\d+ is in progress; epic moved todo → in_progress at /);
    });
  });

  it("never closes an empty epic on its own", async () => {
    await board(async ({ commands, ctx }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Empty container", kind: "epic", actor: AGENT });
      assert.equal(advanceContainer(ctx, epic.id, ctx.now()), null, "an empty epic has no basis for a rollup");

      const plan = commands.reconcileContainers({ dryRun: true });
      const entry = plan.actions.find((candidate) => candidate.epic === epic.identifier);
      assert.deepEqual({ action: entry.action, reason: entry.reason }, {
        action: "none",
        reason: "empty_epic",
      });
      commands.reconcileContainers({});
      assert.equal(commands.getTask({ id: epic.id }).status, "todo", "the sweep leaves it exactly where it was");
    });
  });

  it("does not start a container for a child that only went blocked", async () => {
    await board(async ({ commands }) => {
      const child = linusTask(commands);
      const epic = epicWith(commands, [child]);
      commands.moveStatus({ id: child.id, to: "blocked", actor: AGENT });

      const plan = commands.reconcileContainers({ dryRun: true });
      const entry = plan.actions.find((candidate) => candidate.epic === epic.identifier);
      assert.deepEqual({ action: entry.action, reason: entry.reason }, {
        action: "none",
        reason: "no_child_started",
      });
    });
  });

  it("closes once when the last child is written twice — the second write loses on the terminal guard", async () => {
    await board(async ({ db, commands }) => {
      const one = linusTask(commands, { title: "One" });
      const two = linusTask(commands, { title: "Two", allowDup: true });
      const epic = epicWith(commands, [one, two]);
      for (const child of [one, two]) {
        commands.claim({ id: child.id, actor: AGENT });
        commands.deliver({ taskId: child.id, report: report(), actor: AGENT });
      }

      commands.moveStatus({ id: one.id, to: "done", actor: AGENT });
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress", "one of two is not the set");

      commands.moveStatus({ id: two.id, to: "done", actor: AGENT });
      // The racing second write targets a card the first one already finished.
      assert.throws(
        () => commands.moveStatus({ id: two.id, to: "done", actor: AGENT }),
        (err) => err.code === "TERMINAL_STATE",
      );

      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 1, "exactly one rollup");
      const notes = notesFor(db, epic.id);
      assert.equal(notes.length, 2, "one start note and one closure note");
      assert.match(notes[1].body, /^Auto-rollup \(event\): 2\/2 child card\(s\) done/);
    });
  });
});

describe("commands/tasks — the creation gate (S3)", () => {
  it("refuses creating any card in_progress", async () => {
    await board(async ({ commands }) => {
      assert.throws(
        () => commands.createTask({ projectId: "proj", title: "Born working", status: "in_progress", actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "status",
      );
    });
  });

  it("refuses creating an epic outside backlog/todo", async () => {
    await board(async ({ commands }) => {
      for (const status of ["in_progress", "in_review", "done", "canceled", "blocked"]) {
        assert.throws(
          () => commands.createTask({ projectId: "proj", title: `Born ${status}`, kind: "epic", status, actor: AGENT }),
          (err) => err.code === "VALIDATION_FAILED" && err.details.field === "status",
          status,
        );
      }
      const backlog = commands.createTask({ projectId: "proj", title: "Born backlog", kind: "epic", status: "backlog", actor: AGENT });
      const todo = commands.createTask({ projectId: "proj", title: "Born todo", kind: "epic", actor: AGENT });
      assert.deepEqual([backlog.status, todo.status], ["backlog", "todo"]);
    });
  });
});

describe("commands/tasks — claim and heartbeat", () => {
  it("claims, reuses and refuses exactly as the policy says", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      // The claimant is already a dictionary entry, so the claim below costs the
      // task and its audit row and nothing else. (A claim by a *new* actor also
      // creates its `actors` row — one more revision — which 0020's own test pins.)
      ensureActor(db, "linus");
      const before = revision(db);

      const claimed = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(claimed.reused, false);
      assert.equal(claimed.task.status, "in_progress");
      assert.equal(actorName(db, claimed.task.claimedBy), "linus");
      assert.equal(revision(db), before + 2, "claim + audit row");
      // (No third bump: the claim resolves the already-known actor read-only.)
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed"]);

      const again = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(again.reused, true, "the same actor keeps its claim");
      assert.equal(revision(db), before + 2, "reusing is not a write");
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed"]);

      assert.throws(() => commands.claim({ id: task.id, actor: HUMAN }), (err) => {
        assert.equal(err.code, "EXECUTION_ACTIVE");
        assert.equal(err.http, 409);
        // Phase 7 — the refusal names the holder, not their actor id.
        assert.match(err.message, /linus/);
        assert.doesNotMatch(err.message, /[0-9a-f]{8}-[0-9a-f]{4}/, "…and not the holder's uuid");
        return true;
      });
      assert.throws(() => commands.claim({ id: "nope", actor: AGENT }), (err) => err.code === "NOT_FOUND");
      assert.equal(revision(db), before + 2);
    });
  });

  it("takes over a stale claim and only the holder may pulse it", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });

      // Rewind the heartbeat by hand — the clock is the only thing that ages it.
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", task.id);

      const stolen = commands.claim({ id: task.id, actor: HUMAN });
      assert.equal(stolen.stole, true);
      assert.equal(actorName(db, stolen.task.claimedBy), "Terry");

      const after = revision(db);
      const pulsed = commands.heartbeat({ id: task.id, actor: HUMAN });
      assert.equal(pulsed.heartbeatAt !== null, true);
      assert.equal(pulsed.status, "in_progress");
      assert.equal(revision(db), after + 2);

      assert.throws(() => commands.heartbeat({ id: task.id, actor: AGENT }), (err) => {
        assert.equal(err.code, "EXECUTION_ACTIVE");
        // Phase 7 — the refusal names the holder ("Terry"), and does *not* also
        // print their actor id: the message went through `describeHolder`.
        assert.match(err.message, /Terry/);
        const holderId = db.prepare("SELECT claimed_by FROM tasks WHERE id = ?").get(task.id).claimed_by;
        assert.ok(!err.message.includes(holderId), `message must not carry the id: ${err.message}`);
        return true;
      });
    });
  });

  it("reports a corrupt execution state instead of guesswork (I2)", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      db.prepare("UPDATE tasks SET claimed_by = NULL WHERE id = ?").run(task.id);

      assert.throws(() => commands.heartbeat({ id: task.id, actor: AGENT }), (err) => {
        assert.equal(err.code, "EXECUTION_STATE_CORRUPT");
        assert.equal(err.http, 500);
        return true;
      });
      assert.throws(
        () => commands.claim({ id: task.id, actor: AGENT }),
        (err) => err.code === "EXECUTION_STATE_CORRUPT",
      );
    });
  });
});

describe("commands/tasks — the delivery gate (A7/V6)", () => {
  /** A task sitting in `in_progress`, ready to deliver. */
  async function inProgress(commands) {
    const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
    commands.claim({ id: task.id, actor: AGENT });
    return task;
  }

  it("1. refuses in_progress → in_review with no report at all", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);

      assert.throws(() => commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT }), (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "REPORT_REQUIRED");
        assert.equal(err.http, 422);
        assert.equal(err.details.round, 1);
        assert.deepEqual(err.details.existingRounds, []);
        assert.equal(err.hint.command, `taskctl issue deliver ${task.identifier} --report-file -`);
        return true;
      });
      assert.equal(revision(db), before, "a refused delivery writes nothing");
      assert.equal(commands.getTask({ id: task.id }).status, "in_progress");
      assert.equal(countRows(db, "task_reports"), 0);
    });
  });

  it("2. passes once the current round has a report, and records the round", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const { report: written } = commands.writeReport({ taskId: task.id, report: report(), actor: AGENT });

      const moved = commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT });
      assert.equal(moved.status, "in_review");
      assert.equal(moved.deliveryRound, 1, "review does not move the round");
      assert.equal(moved.reportLatestId, written.id);
      assert.equal(countRows(db, "task_reports"), 1);
    });
  });

  it("3. refuses a report from a previous round (F3)", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      commands.writeReport({ taskId: task.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT });
      const rework = commands.moveStatus({ id: task.id, to: "in_progress", actor: HUMAN });
      assert.equal(rework.deliveryRound, 2, "rework starts the second delivery attempt");

      assert.throws(() => commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT }), (err) => {
        assert.equal(err.code, "REPORT_REQUIRED");
        assert.equal(err.details.round, 2);
        assert.deepEqual(err.details.existingRounds, [1]);
        return true;
      });
      assert.equal(countRows(db, "task_reports"), 1);
    });
  });

  it("4. accepts round 2 once it has its own report, keeping round 1", async () => {
    await board(async ({ commands }) => {
      const task = await inProgress(commands);
      commands.writeReport({ taskId: task.id, report: report({ conclusion: "R1" }), actor: AGENT });
      commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT });
      commands.moveStatus({ id: task.id, to: "in_progress", actor: HUMAN });

      commands.writeReport({ taskId: task.id, report: report({ conclusion: "R2" }), actor: AGENT });
      const moved = commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT });
      assert.equal(moved.deliveryRound, 2);

      const reports = commands.listReports({ taskId: task.id });
      assert.deepEqual(reports.map((r) => [r.round, r.conclusion]), [
        [1, "R1"],
        [2, "R2"],
      ]);
      assert.equal(moved.reportLatestId, reports[1].id);
    });
  });

  it("5. refuses a report with the wrong shape, with precise issue paths", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);

      assert.throws(
        () =>
          commands.writeReport({
            taskId: task.id,
            report: { conclusion: "  ", acceptance: [], evidence: [], author: AGENT },
            actor: AGENT,
          }),
        (err) => {
          assert.equal(err.code, "REPORT_INVALID");
          assert.equal(err.http, 422);
          assert.deepEqual(
            err.details.issues.map((issue) => issue.path),
            ["conclusion", "acceptance", "evidence"],
          );
          return true;
        },
      );
      assert.throws(
        () =>
          commands.writeReport({
            taskId: task.id,
            report: report({ acceptance: [{ text: "x", status: "partial" }] }),
            actor: AGENT,
          }),
        (err) => err.details.issues[0].path === "leftovers",
      );
      assert.throws(
        () =>
          commands.writeReport({
            taskId: task.id,
            report: report({ evidence: [{ kind: "command", cmd: "node --test" }] }),
            actor: AGENT,
          }),
        (err) => err.details.issues[0].path === "evidence[0].exit_code",
      );
      assert.throws(
        () => commands.writeReport({ taskId: task.id, report: report({ round: 2 }), actor: AGENT }),
        (err) => err.code === "REPORT_ROUND_MISMATCH",
      );

      assert.equal(countRows(db, "task_reports"), 0);
      assert.equal(revision(db), before, "a refused report writes nothing");
    });
  });

  it("6. refuses a report for somebody else's task", async () => {
    await board(async ({ commands }) => {
      const task = await inProgress(commands);
      const other = commands.createTask({ projectId: "proj", title: "Other", actor: AGENT });
      const { report: written } = commands.writeReport({ taskId: task.id, report: report(), actor: AGENT });

      assert.throws(
        () => commands.updateTask({ id: other.id, patch: { reportLatestId: written.id }, actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED",
        "report_latest_id is not a patchable field at all",
      );
    });
  });

  it("7. keeps reports append-only through the service", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      commands.writeReport({ taskId: task.id, report: report(), actor: AGENT });
      assert.throws(() => db.prepare("UPDATE task_reports SET conclusion = 'rewritten'").run(), (err) => {
        assert.equal(err.errcode, 1811);
        return true;
      });
      assert.throws(() => db.prepare("DELETE FROM task_reports").run(), (err) => err.errcode === 1811);
      assert.equal(commands.listReports({ taskId: task.id }).length, 1);
    });
  });

  it("8. deliver is atomic: a rejected report leaves the task untouched", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);

      assert.throws(
        () => commands.deliver({ taskId: task.id, report: { conclusion: "" }, actor: AGENT }),
        (err) => {
          assert.equal(err.code, "REPORT_INVALID");
          return true;
        },
      );
      assert.equal(commands.getTask({ id: task.id }).status, "in_progress");
      assert.equal(countRows(db, "task_reports"), 0);
      assert.equal(revision(db), before, "nothing was written, so nothing bumped");

      const delivered = commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
      assert.equal(delivered.task.status, "in_review");
      assert.equal(delivered.task.reportLatestId, delivered.report.id);
      assert.equal(delivered.task.deliveryRound, 1);
      assert.equal(countRows(db, "task_reports"), 1);
      assert.equal(activitiesFor(db, task.id).filter((e) => e === "task_delivered").length, 1);
    });
  });

  it("deliver refuses a task that could not reach in_review anyway", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      assert.throws(() => commands.deliver({ taskId: task.id, report: report(), actor: AGENT }), (err) => {
        assert.equal(err.code, "INVALID_TRANSITION");
        assert.equal(err.details.from, "todo");
        return true;
      });
    });
  });

  it("answers `canMove` without writing, for the UI", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);
      const verdict = commands.canMove({ taskId: task.id, to: "in_review" });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "REPORT_REQUIRED");
      assert.equal(verdict.hint.command.includes(task.identifier), true);

      assert.equal(commands.canMove({ taskId: task.id, to: "done" }).reason, "INVALID_TRANSITION");
      assert.equal(commands.canMove({ taskId: task.id, to: "blocked" }).ok, true);
      assert.equal(revision(db), before, "asking is free");
    });
  });
});

describe("commands/tasks — one move, one revision", () => {
  it("costs two bumps for a rework, not three (the nested round update is excluded)", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({ taskId: task.id, report: report(), actor: AGENT });

      const before = revision(db);
      const reworked = commands.moveStatus({ id: task.id, to: "in_progress", actor: HUMAN });
      assert.equal(reworked.deliveryRound, 2);
      assert.equal(
        revision(db) - before,
        2,
        "the status move and its audit row — the nested delivery_round update must not bump",
      );
      assert.equal(reworked.status, "in_progress");
      assert.equal(actorName(db, reworked.claimedBy), "linus", "a rework does not drop the claim");
    });
  });
});

describe("commands/tasks — archive (I6)", () => {
  it("refuses before the window and archives after it without touching status", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: task.id, to: "done", actor: HUMAN });

      assert.throws(() => commands.archive({ id: task.id, actor: HUMAN }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.match(err.message, /can be archived from/);
        return true;
      });

      // Seven days later, on a clock we control.
      const later = "2026-10-16T00:00:00.000Z";
      db.prepare("UPDATE tasks SET status_changed_at = ? WHERE id = ?").run("2026-10-08T00:00:00.000Z", task.id);
      const ctx = createContext({ db, repos: createRepositories(db), clock: () => later });
      const commands2 = createCommands(ctx);
      const archived = commands2.archive({ id: task.id, actor: HUMAN });
      assert.equal(archived.archivedAt, later);
      assert.equal(archived.status, "done", "archiving never changes status");
      assert.deepEqual(commands2.listTasks().map((t) => t.id), [], "archived tasks leave the default list");
      assert.equal(commands2.listTasks({ includeArchived: true }).length, 1);
    });
  });

  it("refuses to archive unfinished work", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      assert.throws(
        () => commands.archive({ id: task.id, actor: HUMAN, days: 0 }),
        (err) => err.code === "ARCHIVE_NOT_TERMINAL",
      );
    });
  });
});

describe("commands/tasks — terminal states", () => {
  it("cannot leave done, even through the service", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: task.id, to: "done", actor: HUMAN });

      const before = revision(db);
      assert.throws(() => commands.moveStatus({ id: task.id, to: "todo", actor: HUMAN }), (err) => {
        assert.equal(err.code, "TERMINAL_STATE");
        assert.equal(err.http, 409);
        return true;
      });
      assert.equal(revision(db), before);
      assert.equal(commands.getTask({ id: task.id }).status, "done");
    });
  });
});

describe("commands/tasks — claim accounting", () => {
  it("records who claimed it and when, from the injected clock", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      const claimed = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(actorName(db, claimed.task.claimedBy), "linus");
      assert.equal(claimed.task.createdAt, TS2, "the clock drives every timestamp");
    }, { clock: () => TS2 });
  });
});

describe("commands/tasks — the audited waiver (M2 F-B1)", () => {
  const REASON = "hotfix: report follows in a change comment";

  /** A task sitting in `in_progress`, ready to deliver. */
  async function inProgress(commands) {
    const task = commands.createTask({ projectId: "proj", title: "Ship M2", actor: AGENT });
    commands.claim({ id: task.id, actor: AGENT });
    return task;
  }

  it("moves to in_review with no report, stamps the row and audits report_waived", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);

      const moved = commands.moveStatus({
        id: task.id,
        to: "in_review",
        actor: AGENT,
        noReport: true,
        reason: REASON,
      });

      assert.equal(moved.status, "in_review");
      assert.equal(moved.reportLatestId, null, "no report was written");
      assert.equal(moved.reportWaiverRound, 1);
      assert.equal(moved.reportWaiverReason, REASON);
      assert.match(moved.reportWaivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(countRows(db, "task_reports"), 0);
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed", "report_waived"]);
      const activity = db
        .prepare("SELECT changes_json FROM task_activities WHERE event = 'report_waived'")
        .get();
      assert.deepEqual(JSON.parse(activity.changes_json), {
        from: "in_progress",
        to: "in_review",
        round: 1,
        reason: REASON,
        deliveryRound: 1,
      });
      // One UPDATE (status + the three waiver columns) and one audit row.
      assert.equal(revision(db), before + 2, "the waiver columns must not cost a second bump");
    });
  });

  it("refuses a missing, blank or too-short reason, writing nothing", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);

      for (const reason of [undefined, "", "   ", "short", "1234567"]) {
        assert.throws(
          () => commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT, noReport: true, reason }),
          (err) => {
            assert.equal(err.code, "VALIDATION_FAILED", JSON.stringify(reason));
            assert.equal(err.details.field, "reason");
            return true;
          },
        );
      }
      assert.equal(commands.getTask({ id: task.id }).status, "in_progress");
      assert.equal(countRows(db, "task_reports"), 0);
      assert.equal(revision(db), before, "a refused waiver changes nothing");
    });
  });

  it("is only valid on a move to in_review", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);
      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "blocked", actor: AGENT, noReport: true, reason: REASON }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.deepEqual(err.details.allowed, ["in_review"]);
          return true;
        },
      );
      assert.equal(commands.getTask({ id: task.id }).status, "in_progress");
      assert.equal(revision(db), before);
    });
  });

  it("is spent when the round moves on — like a report", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT, noReport: true, reason: REASON });

      // Rework: in_review → in_progress bumps the round to 2 and clears nothing.
      const rework = commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.equal(rework.deliveryRound, 2);

      // A plain move still needs a report for round 2: the round-1 waiver is dead.
      assert.throws(() => commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT }), (err) => {
        assert.equal(err.code, "REPORT_REQUIRED");
        assert.equal(err.details.round, 2);
        assert.deepEqual(err.details.existingRounds, []);
        return true;
      });
      assert.equal(countRows(db, "task_reports"), 0);

      // A fresh waiver for round 2 works.
      const moved = commands.moveStatus({ id: task.id, to: "in_review", actor: AGENT, noReport: true, reason: REASON });
      assert.equal(moved.reportWaiverRound, 2);
    });
  });

  it("deliver --no-report is the same thing, atomically, and refuses a report at the same time", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const before = revision(db);

      const result = commands.deliver({ taskId: task.id, actor: AGENT, noReport: true, reason: REASON });
      assert.equal(result.waived, true);
      assert.equal(result.report, null);
      assert.equal(result.task.status, "in_review");
      assert.equal(result.task.reportWaiverRound, 1);
      assert.equal(countRows(db, "task_reports"), 0);
      assert.equal(revision(db), before + 2);

      // Both at once is a usage error, not a silently picked winner.
      const other = await inProgress(commands);
      assert.throws(
        () => commands.deliver({ taskId: other.id, actor: AGENT, report: report(), noReport: true, reason: REASON }),
        (err) => {
          assert.equal(err.code, "VALIDATION_FAILED");
          assert.deepEqual(err.details.fields, ["noReport", "report"]);
          return true;
        },
      );
      // And deliver with neither is a usage error too.
      assert.throws(() => commands.deliver({ taskId: other.id, actor: AGENT }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        return true;
      });
    });
  });

  it("still prefers a report when one is available", async () => {
    await board(async ({ db, commands }) => {
      const task = await inProgress(commands);
      const delivered = commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
      assert.equal(delivered.waived, false);
      assert.equal(delivered.task.reportWaiverRound, null, "the normal path is not marked waived");
      assert.equal(countRows(db, "task_reports"), 1);
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed", "task_delivered"]);
    });
  });
});

describe("commands/tasks — listCandidates (poll read)", () => {
  /** A todo card assigned to linus, the poll's assignee. */
  const linusTodo = (commands, extra = {}) =>
    commands.createTask({ projectId: "proj", title: "For linus", assignee: "linus", assigneeKind: "agent", actor: AGENT, ...extra });

  it("returns ready candidates with the card's projection, and is read-only", async () => {
    await board(async ({ db, commands }) => {
      const candidate = linusTodo(commands, { title: "Candidate" });
      // Same assignee but already claimed → not a ready candidate.
      const claimed = linusTodo(commands, { title: "Claimed", allowDup: true });
      commands.claim({ id: claimed.id, actor: AGENT });
      // A different assignee's ready card must not leak across.
      commands.createTask({ projectId: "proj", title: "For Terry", assignee: "terry", assigneeKind: "agent", actor: AGENT });

      const before = revision(db);
      const candidates = commands.listCandidates({ assignee: "linus" });

      assert.deepEqual(candidates.map((c) => c.identifier), [candidate.identifier]);
      assert.deepEqual(
        Object.keys(candidates[0]).sort(),
        ["id", "identifier", "priority", "project", "reason", "sort", "status", "title"],
        "exactly the card's fields plus reason — no `target`, the board owns no directory (O3)",
      );
      assert.equal(candidates[0].status, "todo", "the canonical status, never the ready alias");
      assert.equal(candidates[0].priority, "medium");
      assert.equal(candidates[0].project, "proj");
      assert.equal(candidates[0].sort, 0);
      assert.equal(candidates[0].reason, "ready");
      assert.equal(revision(db), before, "the poll read writes nothing");
    });
  });

  it("excludes a task whose depends_on is not done, and admits it once done", async () => {
    await board(async ({ db, commands }) => {
      const blocker = linusTodo(commands, { title: "Blocker", allowDup: true });
      const candidate = linusTodo(commands, { title: "Blocked", allowDup: true });
      commands.addRelation({ type: "blocks", source: blocker.id, target: candidate.id, actor: AGENT });

      // The blocker is still todo → the candidate's depends_on is unmet, and the
      // blocker itself (deps-free) is the only ready card.
      let candidates = commands.listCandidates({ assignee: "linus" });
      assert.deepEqual(candidates.map((c) => c.identifier), [blocker.identifier]);

      // Finish the blocker: claim, deliver with a report, review, done.
      commands.claim({ id: blocker.id, actor: AGENT });
      commands.deliver({ taskId: blocker.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: blocker.id, to: "done", actor: HUMAN });

      candidates = commands.listCandidates({ assignee: "linus" });
      assert.deepEqual(
        candidates.map((c) => c.identifier),
        [candidate.identifier],
        "the blocked card becomes claimable exactly when every depends_on is done",
      );
    });
  });

  it("excludes epics and every non-todo status", async () => {
    await board(async ({ db, commands }) => {
      linusTodo(commands, { title: "An epic", kind: "epic" });
      const blocked = linusTodo(commands, { title: "Blocked card" });
      commands.moveStatus({ id: blocked.id, to: "blocked", actor: AGENT });

      assert.deepEqual(commands.listCandidates({ assignee: "linus" }), [], "epic and blocked are never claimable");
    });
  });

  it("excludes deployment cards from every pool — but an explicit dispatch still claims one", async () => {
    // T-20261013-232004: a `kind: deploy` card runs against a live instance, so
    // the poll's read must never offer one. The marker is a *read* exclusion, not
    // a claim gate: Elon still dispatches the card, and the move takes it.
    await board(async ({ db, commands }) => {
      const deploy = commands.createTask({ projectId: "proj", title: "Rebuild dist", kind: "deploy", assignee: "linus", assigneeKind: "agent", actor: AGENT });
      const plain = linusTodo(commands, { title: "Ordinary card", allowDup: true });
      // ...and a deployment card in the *pool* and in the *recovery* pool too:
      // the exclusion has to hold in all three arms, not only the ready one.
      const pooledDeploy = commands.createTask({ projectId: "proj", title: "Pooled deploy", kind: "deploy", actor: AGENT });
      const recoveredDeploy = commands.createTask({ projectId: "proj", title: "Running deploy", kind: "deploy", assignee: "linus", assigneeKind: "agent", actor: AGENT, allowDup: true });
      commands.claim({ id: recoveredDeploy.id, actor: AGENT });
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", recoveredDeploy.id);
      // The control: the same rotted-claim state on an ordinary card, which the
      // recovery pool *must* still offer. Without it, a `staleReason` that
      // happened to return null would make the deploy assertion above pass for
      // the wrong reason.
      const recoveredPlain = linusTodo(commands, { title: "Running card", allowDup: true });
      commands.claim({ id: recoveredPlain.id, actor: AGENT });
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", recoveredPlain.id);

      const read = commands.listCandidates({ assignee: "linus", stale: true, includeUnassigned: true });
      assert.deepEqual(
        read.map((c) => c.identifier),
        [plain.identifier, recoveredPlain.identifier],
        "the poll's read offers the ordinary cards and neither deployment card",
      );
      assert.equal(read.some((c) => c.identifier === deploy.identifier), false, "ready deploy stays out");
      assert.equal(read.some((c) => c.identifier === pooledDeploy.identifier), false, "pooled deploy stays out");
      assert.equal(read.some((c) => c.identifier === recoveredDeploy.identifier), false, "recovery deploy stays out");

      // ③ — the explicit path: the assignee claims it and the card really moves.
      const claimed = commands.moveStatus({ id: deploy.id, to: "in_progress", actor: AGENT });
      assert.equal(claimed.status, "in_progress");
      assert.equal(actorName(db, claimed.claimedBy), AGENT.id);
      assert.equal(claimed.kind, "deploy", "the marker survives the claim");
    });
  });

  it("resolves the assignee by display name or normalised name", async () => {
    await board(async ({ db, commands }) => {
      const byName = commands.createTask({ projectId: "proj", title: "One", assignee: "Linus", assigneeKind: "agent", actor: AGENT });
      // A second spelling normalises to the same dictionary entry (F7: whitespace
      // and case are removed), so `linus` must find both.
      const byNorm = commands.createTask({ projectId: "proj", title: "Two", assignee: " l i n u s ", assigneeKind: "agent", actor: AGENT });

      const candidates = commands.listCandidates({ assignee: "linus" });
      assert.deepEqual(
        candidates.map((c) => c.id).sort(),
        [byName.id, byNorm.id].sort(),
        "id, display_name and normalized_name all resolve to the same entry",
      );
    });
  });

  it("with stale: true, adds in_progress tasks whose heartbeat expired (poll parity)", async () => {
    const NOW = "2026-10-08T00:00:00.000Z";
    const ago = (ms) => new Date(new Date(NOW).getTime() + ms).toISOString();
    const clock = () => NOW;

    await board(async ({ db, commands }) => {
      const staleSame = linusTodo(commands, { title: "Stale, same holder", allowDup: true });
      commands.claim({ id: staleSame.id, actor: AGENT });
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run(ago(-31 * 60 * 1000), staleSame.id);

      // Stale for anyone (>6h) and held by someone else — the recovery pool's
      // other arm. The card is still *assigned* to linus, but a stale takeover
      // (only possible for an unassigned card via `claim`, so simulated here by
      // rewriting the holder) left it with a different executor.
      const staleAny = linusTodo(commands, { title: "Stale, any holder", allowDup: true });
      commands.claim({ id: staleAny.id, actor: AGENT });
      ensureActor(db, "Terry");
      db.prepare("UPDATE tasks SET claimed_by = 'Terry', heartbeat_at = ? WHERE id = ?").run(
        ago(-7 * 60 * 60 * 1000),
        staleAny.id,
      );

      // A fresh heartbeat is not a candidate, even with stale: true.
      const fresh = linusTodo(commands, { title: "Fresh", allowDup: true });
      commands.claim({ id: fresh.id, actor: AGENT });

      assert.deepEqual(commands.listCandidates({ assignee: "linus" }), [], "no todo cards remain, and stale is off");

      const withStale = commands.listCandidates({ assignee: "linus", stale: true });
      assert.deepEqual(
        withStale.map((c) => [c.identifier, c.reason]),
        [
          [staleSame.identifier, "stale_same"],
          [staleAny.identifier, "stale_any"],
        ],
      );
      assert.ok(withStale.every((c) => c.status === "in_progress"), "recovery candidates report in_progress");
    }, { clock });
  });

  it("includeUnassigned adds the unassigned public pool, after assigned cards", async () => {
    await board(async ({ commands }) => {
      const assigned = linusTodo(commands, { title: "Assigned" });
      // The public pool: a claimable card nobody is routed to yet.
      const pool = commands.createTask({ projectId: "proj", title: "Public pool", actor: AGENT });
      commands.createTask({ projectId: "proj", title: "Pool epic", kind: "epic", actor: AGENT });
      const blockedPool = commands.createTask({ projectId: "proj", title: "Blocked pool", actor: AGENT });
      const poolBlocker = commands.createTask({ projectId: "proj", title: "Pool blocker", actor: AGENT });
      commands.addRelation({ type: "blocks", source: poolBlocker.id, target: blockedPool.id, actor: AGENT });
      commands.createTask({ projectId: "proj", title: "Someone else", assignee: "terry", assigneeKind: "agent", actor: AGENT });

      // Without the flag the read is unchanged: exactly the assigned ready card.
      assert.deepEqual(
        commands.listCandidates({ assignee: "linus" }).map((c) => c.identifier),
        [assigned.identifier],
      );

      const pooled = commands.listCandidates({ assignee: "linus", includeUnassigned: true });
      assert.deepEqual(
        pooled.map((c) => c.identifier),
        [assigned.identifier, pool.identifier, poolBlocker.identifier],
        "assigned first, then the pool; epic, blocked and another assignee's cards stay out",
      );
      assert.equal(pooled[1].reason, "unassigned");
      assert.equal(pooled[1].status, "todo");

      // The pool is offered even to a name with no dictionary entry — the read
      // must not early-return just because the assignee resolves to nothing.
      assert.deepEqual(
        commands.listCandidates({ assignee: "ghost", includeUnassigned: true }).map((c) => c.identifier).sort(),
        [pool.identifier, poolBlocker.identifier].sort(),
      );
    });
  });
});

describe("commands/tasks — claim requires the actor to be the assignee (T-20261009-230500)", () => {
  const assignedTo = (commands, name, extra = {}) =>
    commands.createTask({
      projectId: "proj",
      title: `For ${name}`,
      assignee: name,
      assigneeKind: "agent",
      actor: AGENT,
      ...extra,
    });

  it("lets the assignee claim their own card (normalised: actor linus == assignee Linus)", async () => {
    await board(async ({ db, commands }) => {
      const task = assignedTo(commands, "Linus");
      const claimed = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(claimed.stole, false);
      assert.equal(claimed.task.status, "in_progress");
      // The actor row `createTask` made for the assignee `Linus` — `norm` folds the
      // case, so the claimant `linus` is that same person, and the stored spelling wins.
      assert.equal(actorName(db, claimed.task.claimedBy), "Linus");
    });
  });

  it("refuses a different actor with not_assignee (409) and writes nothing", async () => {
    await board(async ({ db, commands }) => {
      const task = assignedTo(commands, "Linus");
      const before = revision(db);
      assert.throws(() => commands.claim({ id: task.id, actor: HUMAN }), (err) => {
        assert.equal(err.code, "not_assignee");
        assert.equal(err.http, 409);
        assert.match(err.hint.fix, /--allow-steal/);
        return true;
      });
      assert.equal(revision(db), before, "a refused claim changes nothing");
      assert.equal(commands.getTask({ id: task.id }).status, "todo");
    });
  });

  it("takes somebody else's card with allowSteal, leaving a readable change comment", async () => {
    await board(async ({ db, commands }) => {
      const task = assignedTo(commands, "Linus");
      const claimed = commands.claim({
        id: task.id,
        actor: HUMAN,
        allowSteal: true,
        reason: "linus is unavailable, taking the card over",
      });
      assert.equal(claimed.stole, true);
      assert.equal(actorName(db, claimed.task.claimedBy), "Terry");

      const comments = commands.listComments({ taskId: task.id });
      assert.equal(comments.length, 1);
      assert.equal(comments[0].kind, "change");
      assert.match(comments[0].body, /Linus/, "names the original assignee");
      assert.match(comments[0].body, /Terry/, "names the new claimer");
      assert.match(comments[0].body, /unavailable/, "carries the reason");
    });
  });

  it("refuses allowSteal without a real reason, writing nothing", async () => {
    await board(async ({ db, commands }) => {
      const task = assignedTo(commands, "Linus");
      const before = revision(db);
      for (const reason of [undefined, "", "short"]) {
        assert.throws(
          () => commands.claim({ id: task.id, actor: HUMAN, allowSteal: true, reason }),
          (err) => {
            assert.equal(err.code, "VALIDATION_FAILED", JSON.stringify(reason));
            assert.equal(err.details.field, "reason");
            return true;
          },
        );
      }
      assert.equal(commands.getTask({ id: task.id }).status, "todo");
      assert.equal(revision(db), before, "a refused steal changes nothing");
    });
  });

  it("refuses an epic and a backlog card", async () => {
    await board(async ({ commands }) => {
      const epic = commands.createTask({
        projectId: "proj",
        title: "An epic",
        kind: "epic",
        assignee: "linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      assert.throws(
        () => commands.claim({ id: epic.id, actor: AGENT }),
        (err) => err.code === "not_claimable" && err.http === 409,
      );

      const backlog = commands.createTask({ projectId: "proj", title: "Later", status: "backlog", actor: AGENT });
      assert.throws(
        () => commands.claim({ id: backlog.id, actor: AGENT }),
        (err) => err.code === "INVALID_TRANSITION",
      );
    });
  });

  it("only the holder may re-claim between 10 minutes and 6 hours", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });

      const fresh = (ms) => new Date(Date.now() - ms).toISOString();
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run(fresh(70 * 60 * 1000), task.id);

      const again = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(again.reused, false, "a stale-for-holder claim is re-taken, not reused");
      assert.equal(again.stole, false, "the holder keeps the lock, so it is not an audited steal");

      // Rewind again and let somebody else try — inside the window they may not.
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run(fresh(70 * 60 * 1000), task.id);
      assert.throws(() => commands.claim({ id: task.id, actor: HUMAN }), (err) => err.code === "EXECUTION_ACTIVE");
    });
  });

  it("anybody may take a claim older than six hours, and it is audited", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run(
        new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        task.id,
      );

      const stolen = commands.claim({ id: task.id, actor: HUMAN });
      assert.equal(stolen.stole, true);
      assert.equal(actorName(db, stolen.task.claimedBy), "Terry");

      const comments = commands.listComments({ taskId: task.id });
      assert.equal(comments.length, 1, "the >6h takeover leaves a change comment");
      assert.equal(comments[0].kind, "change");
      assert.match(comments[0].body, /linus/, "names the previous holder");
    });
  });
});

describe("commands/tasks — move to in_progress is the claim path", () => {
  it("stamps the claim and logs task_claimed for a todo card", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship", actor: AGENT });
      const moved = commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.equal(moved.status, "in_progress");
      assert.equal(actorName(db, moved.claimedBy), "linus");
      assert.match(moved.claimedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(moved.heartbeatAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed"]);
    });
  });

  it("refuses moving somebody else's card to in_progress (not_assignee)", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "For Linus",
        assignee: "Linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      assert.throws(() => commands.moveStatus({ id: task.id, to: "in_progress", actor: HUMAN }), (err) => {
        assert.equal(err.code, "not_assignee");
        assert.equal(err.http, 409);
        return true;
      });
    });
  });

  it("honours allowSteal on the move and leaves a change comment", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "For Linus",
        assignee: "Linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      const moved = commands.moveStatus({
        id: task.id,
        to: "in_progress",
        actor: HUMAN,
        allowSteal: true,
        reason: "linus is on another card, taking this over",
      });
      assert.equal(actorName(db, moved.claimedBy), "Terry");
      assert.equal(commands.listComments({ taskId: task.id }).length, 1);
    });
  });

  it("leaves a rework untouched: in_review -> in_progress never re-checks the assignee", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "For Linus",
        assignee: "Linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      commands.deliver({ taskId: task.id, report: report(), actor: AGENT });

      // A different actor sends it back for rework — the non-claim path keeps
      // the existing execution lock and does not re-check the assignee.
      const rework = commands.moveStatus({ id: task.id, to: "in_progress", actor: HUMAN });
      assert.equal(rework.status, "in_progress");
      // The lock is the actor row the assignee `Linus` named, so the display
      // spelling is `Linus` — `norm` folded the claimant's case onto that row.
      assert.equal(actorName(db, rework.claimedBy), "Linus", "a rework never drops the executor's lock");
      assert.deepEqual(activitiesFor(db, task.id), [
        "task_created",
        "task_claimed",
        "task_delivered",
        "task_moved",
      ]);
    });
  });
});

/**
 * T-20261014-152924 ① — the execution claim never outlives the card's work cycle.
 *
 * Terry's report, as a sequence: a card that is claimed (`in_progress`) is
 * dragged back to `todo` and then to `backlog`. Both legs are legal transitions;
 * the claim was the thing that was not released, so the second leg tripped the
 * schema's own `CHECK (claimed_by IS NULL OR status <> 'backlog')` and the board
 * showed the raw SQLite sentence. The fix belongs to the *first* leg — the move
 * that takes a card out of the work cycle drops the claim in the same write —
 * which is what these cases pin down, together with the two paths that must
 * **keep** the lock so the same executor can resume.
 */
describe("commands/tasks — the execution claim follows the work cycle (T-20261014-152924)", () => {
  async function claimed(commands, actor = AGENT) {
    const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor });
    // `claim` returns the *updated* DTO; the one `createTask` handed back is the
    // pre-claim revision and reads `claimedBy === null`.
    return commands.claim({ id: task.id, actor }).task;
  }

  it("walks Terry's drag — in_progress → todo → backlog — and never reaches the CHECK", async () => {
    await board(async ({ db, commands }) => {
      const task = await claimed(commands);
      assert.equal(actorName(db, task.claimedBy), "linus");

      const todo = commands.moveStatus({ id: task.id, to: "todo", actor: AGENT });
      assert.equal(todo.claimedBy, null, "leaving the work cycle releases the lock");
      assert.equal(todo.claimedAt, null, "and its two timestamps with it");
      assert.equal(todo.heartbeatAt, null);

      // The leg that used to fail with `CHECK constraint failed: …`.
      const backlog = commands.moveStatus({ id: task.id, to: "backlog", actor: HUMAN });
      assert.equal(backlog.status, "backlog");
      assert.equal(backlog.claimedBy, null);
      assert.equal(
        db.prepare("SELECT claimed_by FROM tasks WHERE id = ?").get(task.id).claimed_by,
        null,
        "the row itself carries no claim, not merely the DTO",
      );
      assert.deepEqual(activitiesFor(db, task.id), [
        "task_created",
        "task_claimed",
        "task_moved",
        "task_moved",
      ]);
    });
  });

  it("releases the lock for the terminal pair too, so a finished card is nobody's", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: task.id, actor: AGENT });
      const canceled = commands.moveStatus({ id: task.id, to: "canceled", actor: HUMAN });
      assert.equal(canceled.claimedBy, null);
      assert.equal(db.prepare("SELECT claimed_by FROM tasks WHERE id = ?").get(task.id).claimed_by, null);
    });
  });

  it("keeps the lock on in_progress ↔ awaiting — the same attempt, paused", async () => {
    await board(async ({ db, commands }) => {
      const task = await claimed(commands);
      const waiting = commands.moveStatus({
        id: task.id,
        to: "awaiting",
        awaitingReason: "E1",
        actor: AGENT,
      });
      assert.equal(actorName(db, waiting.claimedBy), "linus", "asking a human does not hand the card over");
      const resumed = commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.equal(actorName(db, resumed.claimedBy), "linus");
      assert.equal(resumed.heartbeatAt, task.heartbeatAt, "resuming does not re-stamp the attempt");
    });
  });

  it("keeps the lock across a block and a rework, so the executor can resume", async () => {
    await board(async ({ db, commands }) => {
      const task = await claimed(commands);
      const blocked = commands.moveStatus({ id: task.id, to: "blocked", actor: AGENT, blockedReason: "dependency" });
      assert.equal(actorName(db, blocked.claimedBy), "linus", "a stopped card is still the same executor's card");
      const unblocked = commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.equal(actorName(db, unblocked.claimedBy), "linus");
    });
  });
});
