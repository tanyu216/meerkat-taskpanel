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
import { DomainError } from "../../../src/foundation/errors.mjs";
import {
  TS,
  TS2,
  actorName,
  cleanupTempDirs,
  countRows,
  ensureActor,
  insertTask,
  revision,
  withBoard,
} from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const AGENT = { kind: "agent", id: "linus" };
const HUMAN = { kind: "human", id: "Terry" };

/** A board with repositories, commands and one project. */
async function board(fn, { clock, policy } = {}) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({
      db,
      repos,
      ...(clock === undefined ? {} : { clock }),
      ...(policy === undefined ? {} : { acceptancePolicy: policy }),
    });
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

  it("canonicalizes the review marker from the immutable columns on update", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      commands.claim({ id: original.id, actor: AGENT });
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 1,
        actor: AGENT,
      });

      const updated = commands.updateTask({
        id: review.id,
        patch: { meta: { ...review.meta, review_of: "PROJ-9999", review_round: 9, team: "panel" } },
        actor: AGENT,
      });

      assert.equal(updated.meta.review_of, original.identifier, "the column wins");
      assert.equal(updated.meta.review_round, 1);
      assert.equal(updated.meta.team, "panel", "other keys are untouched");
      assert.equal(updated.reviewOfId, original.id, "the column never moves");
    });
  });

  it("strips a meta marker from a card with no structural marker, and keeps rework_round", async () => {
    await board(async ({ commands }) => {
      const card = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      const updated = commands.updateTask({
        id: card.id,
        patch: { meta: { ...card.meta, review_of: "PROJ-9999", review_round: 4, rework_round: "2" } },
        actor: AGENT,
      });

      assert.equal(Object.hasOwn(updated.meta, "review_of"), false);
      assert.equal(Object.hasOwn(updated.meta, "review_round"), false);
      assert.equal(updated.meta.rework_round, "2", "the loop's write survives");
    });
  });

  it("lists the cards that review one card, through both order modes", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      commands.claim({ id: original.id, actor: AGENT });
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 1,
        actor: AGENT,
      });
      commands.createTask({ projectId: "proj", title: "Unrelated", actor: AGENT });

      assert.deepEqual(
        commands.listTasks({ reviewOfId: original.id }).map((task) => task.id),
        [review.id],
      );

      const ordered = commands.listOrderedTasks({ reviewOfId: original.id, order: "weight" });
      assert.deepEqual(ordered.tasks.map((task) => task.id), [review.id]);
      assert.deepEqual(ordered.orderDebug.map((entry) => entry.id), [review.id]);
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
      assert.equal(commands.canMove({ taskId: epic.id, to: "in_review" }).reason, "ROLLUP_REQUIRED", "and not without a rollup");
      assert.equal(commands.canMove({ taskId: epic.id, to: "backlog" }).ok, true);
    });
  });

  it("refuses to deliver an empty epic — there is nothing to roll up", async () => {
    await board(async ({ db, commands }) => {
      const epic = linusTask(commands, { kind: "epic" });
      assert.equal(epic.status, "todo", "which is where `issue create --kind epic` puts a container");

      // 0033 — a container's delivery evidence is its children. An empty one has
      // no children to stand a rollup on, so it is refused like `assessClose`'s
      // `empty_epic`: cancel it or give it work.
      assert.throws(
        () => commands.deliver({ taskId: epic.id, report: report(), actor: AGENT }),
        (err) => {
          assert.equal(err.code, "ROLLUP_STALE");
          assert.equal(err.details.childCount, 0);
          return true;
        },
      );
      assert.equal(commands.getTask({ id: epic.id }).status, "todo", "a refused delivery writes nothing");
      assert.deepEqual(activitiesFor(db, epic.id), ["task_created"]);
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

      // 0033 — the kind dimension *is* the gate now: an epic owes a rollup, and
      // is told how to write one (the template lists the children).
      const epic = linusTask(commands, { kind: "epic", allowDup: true });
      assert.throws(
        () => commands.moveStatus({ id: epic.id, to: "in_review", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "ROLLUP_REQUIRED");
          assert.match(err.hint?.command ?? "", /^taskctl report template /);
          assert.deepEqual(err.details.allowed, undefined, "a gate refusal is not a whitelist refusal");
          return true;
        },
      );
      // ...and a waiver cannot stand in for a container's evidence.
      assert.throws(
        () =>
          commands.moveStatus({
            id: epic.id,
            to: "in_review",
            actor: AGENT,
            noReport: true,
            reason: "rollup in the children",
          }),
        (err) => err.code === "ROLLUP_REQUIRED",
      );
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

  it("refuses a promoted-but-childless container from its park, too", async () => {
    await board(async ({ db, commands }) => {
      const container = linusTask(commands);
      commands.updateTask({ id: container.id, patch: { kind: "epic" }, actor: AGENT });
      commands.moveStatus({ id: container.id, to: "blocked", blockedReason: "dependency", actor: AGENT });

      // 0033 — the blocked → in_review repair edge still exists, but a container
      // without children has no rollup to deliver; the refusal is the same one
      // an empty epic gets from `todo`.
      assert.throws(
        () => commands.deliver({ taskId: container.id, report: report(), actor: AGENT }),
        (err) => err.code === "ROLLUP_STALE",
      );
      assert.equal(commands.getTask({ id: container.id }).status, "blocked");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(container.id).c, 0);
      assert.deepEqual(activitiesFor(db, container.id), ["task_created", "task_updated", "task_moved"]);
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

  /**
   * Walk a child to `done` the way the board allows: claim, deliver, accept.
   *
   * A child card is accepted by a **non-human** writer under every policy —
   * humans close top-level originals only — so the acceptance step is the agent
   * that did the work, not the human who later accepts the container.
   */
  const finish = (commands, task, sha, acceptActor = AGENT) => {
    commands.claim({ id: task.id, actor: AGENT });
    commands.deliver({ taskId: task.id, report: report({ evidence: [{ kind: "commit", sha }] }), actor: AGENT });
    return commands.moveStatus({ id: task.id, to: "done", actor: acceptActor });
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
        .prepare(
          "SELECT round, origin, is_rollup, author_kind, acceptance_json, evidence_json FROM task_reports WHERE task_id = ?",
        )
        .all(epic.id);
      assert.equal(reports.length, 1, "the board wrote exactly one rollup report");
      assert.equal(reports[0].origin, "delivery");
      assert.equal(reports[0].is_rollup, 1, "0033 — the board's report is the rollup");
      assert.equal(reports[0].author_kind, "taskd", "the board wrote it, not the last agent");
      assert.equal(reports[0].round, 1);
      const items = JSON.parse(reports[0].acceptance_json);
      assert.equal(items.length, 2, "one criterion per child");
      assert.deepEqual(
        items.map((item) => item.ref).sort(),
        [one.identifier, two.identifier].sort(),
        "each item names its child — the rollup gate joins on `ref`",
      );
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
        ["taskd", "taskd"],
      );
      assert.match(notes[0].body, /^Auto-start \(event\): child PROJ-\d+ is in progress/);
      assert.match(
        notes[1].body,
        /^Auto-rollup \(event\): 2\/2 child card\(s\) terminal — 2 done \(PROJ-\d+, PROJ-\d+\), 0 canceled \(none\)/,
      );
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

  it("closes with a canceled child and lists it — with its reason — in the rollup report", async () => {
    await board(async ({ db, commands }) => {
      const done = linusTask(commands, { title: "Done" });
      const canceled = linusTask(commands, { title: "Dropped", allowDup: true });
      const quiet = linusTask(commands, { title: "Silent drop", allowDup: true });
      const epic = epicWith(commands, [done, canceled, quiet]);
      for (const child of [canceled, quiet]) {
        commands.moveStatus({ id: child.id, to: "canceled", actor: AGENT });
      }
      commands.addComment({
        taskId: canceled.id,
        body: "Scope dropped by the operator; the third-party API was withdrawn.",
        kind: "change",
        actor: HUMAN,
      });

      finish(commands, done, "abc1234");
      assert.equal(
        commands.getTask({ id: epic.id }).status,
        "in_review",
        "canceled is terminal, so it does not hold the container open",
      );

      const stored = db
        .prepare("SELECT acceptance_json, evidence_json FROM task_reports WHERE task_id = ?")
        .get(epic.id);
      const acceptance = JSON.parse(stored.acceptance_json);
      assert.equal(acceptance.length, 3, "one criterion per child, every canceled child included");
      const doneLine = acceptance.find((item) => item.text.includes("Done"));
      const canceledLine = acceptance.find((item) => item.text.includes("Dropped"));
      const quietLine = acceptance.find((item) => item.text.includes("Silent drop"));
      assert.equal(doneLine.status, "met");
      assert.equal(canceledLine.status, "not_applicable", "a canceled child is not a met criterion");
      assert.match(
        canceledLine.note,
        /Scope dropped by the operator; the third-party API was withdrawn\./,
        "the cancellation reason comes from the card's own trail",
      );
      assert.equal(
        quietLine.note,
        "canceled: no reason recorded on the card",
        "a card with no comments says so instead of inventing a reason",
      );
      assert.equal(
        JSON.parse(stored.evidence_json).length,
        1,
        "the delivered child's evidence still stands the report up",
      );

      const [rollup] = db
        .prepare("SELECT body FROM comments WHERE task_id = ? AND body LIKE 'Auto-rollup%'")
        .all(epic.id);
      assert.match(rollup.body, /3\/3 child card\(s\) terminal — 1 done \(PROJ-\d+\), 2 canceled \(PROJ-\d+, PROJ-\d+\)/);
    });
  });

  it("closes when the last unfinished child is canceled — cancellation ends the set", async () => {
    await board(async ({ db, commands }) => {
      const done = linusTask(commands, { title: "Done" });
      const pending = linusTask(commands, { title: "Pending", allowDup: true });
      const epic = epicWith(commands, [done, pending]);

      finish(commands, done, "abc1234");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");

      commands.moveStatus({ id: pending.id, to: "canceled", actor: AGENT });
      assert.equal(
        commands.getTask({ id: epic.id }).status,
        "in_review",
        "a canceled child is terminal: with the done child, the set is complete",
      );
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 1);
    });
  });

  it("refuses an epic whose current round has only an unmarked report", async () => {
    await board(async ({ db, commands }) => {
      // A board that predates 0033: the child is done, the container is live,
      // and the round has a delivery report nobody marked as a rollup. Raw
      // inserts set the state the hooks would otherwise write for us.
      const child = insertTask(db, {
        id: "child-1",
        identifier: "PROJ-0098",
        title: "Child",
        status: "done",
      });
      const epic = insertTask(db, {
        id: "epic-1",
        identifier: "PROJ-0099",
        title: "Container",
        kind: "epic",
        status: "in_progress",
      });
      commands.addRelation({ type: "parent", source: epic, target: child, actor: AGENT });
      db.prepare(
        `INSERT INTO task_reports(task_id, round, conclusion, acceptance_json, evidence_json,
                                  author_kind, author_id, created_at, origin, is_rollup)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'delivery', 0)`,
      ).run(
        epic,
        "rollup",
        JSON.stringify([{ text: "child done", status: "met", ref: "PROJ-0098" }]),
        JSON.stringify([{ kind: "path", path: "x" }]),
        "system",
        ensureActor(db, "taskd", "system"),
        TS,
      );

      // The content even looks right; the *marker* is what the gate reads.
      assert.throws(
        () => commands.moveStatus({ id: epic, to: "in_review", actor: AGENT }),
        (err) => err.code === "ROLLUP_REQUIRED",
      );
    });
  });

  it("flags a stale rollup after a child is attached, without moving the epic", async () => {
    await board(async ({ commands }) => {
      const child = linusTask(commands, { title: "Child" });
      const epic = epicWith(commands, [child]);
      finish(commands, child, "abc1234");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");

      const late = linusTask(commands, { title: "Late", allowDup: true });
      commands.addRelation({ type: "parent", source: epic.id, target: late.id, actor: AGENT });
      commands.moveStatus({ id: late.id, to: "canceled", actor: AGENT });

      // The sweep is read-only on an in_review epic: it names the gap and lets a
      // human (or a rework) decide.
      const plan = commands.reconcileContainers({ dryRun: true });
      const entry = plan.actions.find((candidate) => candidate.epic === epic.identifier);
      assert.deepEqual(
        { action: entry.action, reason: entry.reason },
        { action: "none", reason: "rollup_stale" },
      );
      assert.deepEqual(entry.blocking, [{ identifier: late.identifier, status: "missing" }]);
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");

      assert.throws(
        () => commands.moveStatus({ id: epic.id, to: "done", actor: HUMAN }),
        (err) => {
          assert.equal(err.code, "ROLLUP_STALE");
          assert.deepEqual(err.details.missingChildren, [late.identifier]);
          return true;
        },
      );
    });
  });

  it("does not close a container whose children were all canceled — nothing was delivered", async () => {
    await board(async ({ db, commands }) => {
      const one = linusTask(commands, { title: "One" });
      const two = linusTask(commands, { title: "Two", allowDup: true });
      const epic = epicWith(commands, [one, two]);
      for (const child of [one, two]) {
        commands.moveStatus({ id: child.id, to: "canceled", actor: AGENT });
      }

      assert.equal(commands.getTask({ id: epic.id }).status, "todo", "an empty delivery is not a delivery");

      const plan = commands.reconcileContainers({ dryRun: true });
      const entry = plan.actions.find((candidate) => candidate.epic === epic.identifier);
      assert.deepEqual(
        { action: entry.action, reason: entry.reason },
        { action: "none", reason: "no_child_done" },
      );
      assert.deepEqual(
        entry.blocking.map((child) => child.status),
        ["canceled", "canceled"],
        "the refusal names the children, not just 'not closeable'",
      );
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 0);
    });
  });

  it("names the unfinished child in the sweep report", async () => {
    await board(async ({ commands }) => {
      const done = linusTask(commands, { title: "Done" });
      const pending = linusTask(commands, { title: "Pending", allowDup: true });
      const epic = epicWith(commands, [done, pending]);
      finish(commands, done, "abc1234");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_progress");

      const plan = commands.reconcileContainers({ dryRun: true });
      const entry = plan.actions.find((candidate) => candidate.epic === epic.identifier);
      assert.deepEqual(
        { action: entry.action, reason: entry.reason },
        { action: "none", reason: "children_unfinished" },
      );
      assert.deepEqual(entry.blocking, [{ identifier: pending.identifier, status: "todo" }]);
    });
  });

  it("leaves a card with no parent untouched", async () => {
    await board(async ({ db, commands }) => {
      const solo = linusTask(commands, { title: "Solo" });
      // A top-level card is the human's to accept (the child rule does not
      // apply); that is exactly what this case pins.
      finish(commands, solo, "abc1234", HUMAN);

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
        "the outer container started when its child did, but the inner one is not accepted",
      );

      // The inner container is a **child** of the outer one, so a non-human
      // accepts it — a human closes only the top-level card. Only then is the
      // outer one whole.
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
      // 0033 — the manual rollup must name every child; the children's own
      // waiver says nothing about the container.
      const manual = commands.deliver({
        taskId: epic.id,
        report: report({
          acceptance: [one, two].map((child) => ({
            text: `${child.identifier} done`,
            status: "met",
            ref: child.identifier,
          })),
        }),
        actor: AGENT,
      });
      assert.equal(manual.task.status, "in_review", "the manual path still works");
      assert.equal(manual.report.isRollup, true, "a report on an epic is its rollup");
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
    return commands.moveStatus({ id: task.id, to: "done", actor: HUMAN });
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
      assert.equal(note.author_kind, "taskd", "the board wrote it");
      assert.match(note.body, /^Auto-start \(event\): child PROJ-\d+ is in progress; epic moved todo → in_progress at /);
    });
  });

  it("reads the auto-started epic as a designed state, never as I2 corruption", async () => {
    // T-20261018-060214. The container's `in_progress` has `claimed_by = NULL`
    // by design (`startContainer`): an epic is nobody's work card. The I2
    // corrupt-state report is about *work* cards that lost their holder, so a
    // container must not be reported as corrupt by any of the three readers:
    // the read itself, the heartbeat, and the claim decision.
    await board(async ({ commands }) => {
      const child = linusTask(commands);
      const epic = epicWith(commands, [child]);
      commands.claim({ id: child.id, actor: AGENT });

      const started = commands.getTask({ id: epic.id });
      assert.equal(started.status, "in_progress");
      assert.equal(started.claimedBy, null);
      assert.equal(started.kind, "epic");

      assert.throws(
        () => commands.heartbeat({ id: epic.id, actor: AGENT }),
        (err) => {
          assert.notEqual(err.code, "EXECUTION_STATE_CORRUPT", "an unowned epic is designed, not corrupt");
          assert.equal(err.code, "INVALID_TRANSITION", "there is no claim to pulse");
          return true;
        },
      );

      assert.throws(
        () => commands.claim({ id: epic.id, actor: AGENT }),
        (err) => {
          assert.notEqual(err.code, "EXECUTION_STATE_CORRUPT", "an unowned epic is designed, not corrupt");
          assert.equal(err.code, "not_claimable", "the epic refusal is the same in every status");
          return true;
        },
      );
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
        reason: "all_children_terminal",
      });
      assert.equal(commands.getTask({ id: epic.id }).status, "todo", "a dry run writes nothing");
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 0);
      assert.equal(notesFor(db, epic.id).length, 0);
      assert.deepEqual(activitiesFor(db, epic.id), ["task_created"]);

      const applied = commands.reconcileContainers({});
      assert.equal(applied.actions.find((entry) => entry.epic === epic.identifier).action, "close");
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");
      const [note] = notesFor(db, epic.id);
      assert.match(note.body, /^Auto-rollup \(sweep\): 1\/1 child card\(s\) terminal — 1 done \(PROJ-\d+\), 0 canceled \(none\)/);

      const roundAfterClose = commands.getTask({ id: epic.id }).deliveryRound;
      const again = commands.reconcileContainers({});
      const againEntry = again.actions.find((entry) => entry.epic === epic.identifier);
      assert.deepEqual({ action: againEntry.action, reason: againEntry.reason }, {
        action: "none",
        reason: "awaiting_acceptance",
      });
      assert.equal(db.prepare("SELECT count(*) AS c FROM task_reports WHERE task_id = ?").get(epic.id).c, 1);
      assert.equal(
        commands.getTask({ id: epic.id }).deliveryRound,
        roundAfterClose,
        "a container already in_review is a no-op: no second round",
      );
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
      assert.match(notes[1].body, /^Auto-rollup \(event\): 2\/2 child card\(s\) terminal/);
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

  it("costs two bumps for a reopen, not three (the bookkeeping is one UPDATE)", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT, idem: "reopen-rev" });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: task.id, to: "done", actor: HUMAN });

      const before = revision(db);
      const reopened = commands.reopenStatus({ id: task.id, actor: HUMAN, reason: "rework requested" });
      assert.equal(reopened.deliveryRound, 2);
      assert.equal(
        revision(db) - before,
        2,
        "the status move and its audit row — clearing idem/archived_at must not add a revision",
      );
      assert.equal(reopened.status, "todo");
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
      const row = db.prepare("SELECT changes_json FROM task_activities WHERE event = 'task_archived'").get();
      assert.equal(JSON.parse(row.changes_json).from, "done", "the trail names the status it left");
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
  /** A card delivered and accepted the normal way. */
  function doneTask(commands, overrides = {}) {
    const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT, ...overrides });
    commands.claim({ id: task.id, actor: AGENT });
    commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
    commands.moveStatus({ id: task.id, to: "done", actor: HUMAN });
    return task;
  }

  it("reopens done to todo with an audited reason, and starts a new round", async () => {
    await board(async ({ db, commands }) => {
      const task = doneTask(commands, { idem: "reopen-me" });
      assert.equal(commands.getTask({ id: task.id }).status, "done");
      commands.archive({ id: task.id, actor: HUMAN, days: 0 });
      assert.notEqual(commands.getTask({ id: task.id }).archivedAt, null, "precondition: archived");

      // No reason: refused before any write.
      const before = revision(db);
      assert.throws(() => commands.reopenStatus({ id: task.id, actor: HUMAN }), (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        return true;
      });
      assert.equal(revision(db), before, "a refused reopen writes nothing");
      assert.equal(commands.getTask({ id: task.id }).status, "done");

      const reopened = commands.reopenStatus({
        id: task.id,
        actor: HUMAN,
        reason: "customer found a regression",
      });
      assert.equal(reopened.status, "todo");
      assert.equal(reopened.deliveryRound, 2, "a reopen starts a new delivery round");
      assert.equal(reopened.archivedAt, null, "the card returns to the board");
      assert.equal(reopened.idem, null, "the finished card's idempotency key is released");
      assert.deepEqual(activitiesFor(db, task.id).slice(-1), ["task_reopened"]);
      const row = db
        .prepare("SELECT changes_json FROM task_activities WHERE task_id = ? ORDER BY id DESC LIMIT 1")
        .get(task.id);
      const changes = JSON.parse(row.changes_json);
      assert.equal(changes.from, "done");
      assert.equal(changes.to, "todo");
      assert.equal(changes.reason, "customer found a regression");
      assert.equal(changes.deliveryRound, 2);
    });
  });

  it("reopens a canceled card the same way", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Abandoned", actor: AGENT });
      commands.moveStatus({ id: task.id, to: "canceled", actor: AGENT });
      const reopened = commands.reopenStatus({
        id: task.id,
        actor: AGENT,
        reason: "the customer changed their mind",
      });
      assert.equal(reopened.status, "todo");
      assert.equal(reopened.deliveryRound, 2);
    });
  });

  it("refuses to reopen a card that is not terminal", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Still open", actor: AGENT });
      assert.throws(
        () => commands.reopenStatus({ id: task.id, actor: HUMAN, reason: "not done yet" }),
        (err) => err.code === "INVALID_TRANSITION",
      );
    });
  });

  it("refuses to reopen a review card", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      commands.claim({ id: original.id, actor: AGENT });
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
      const review = commands.createTask({
        projectId: "proj",
        title: "Review it",
        actor: HUMAN,
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
      });
      commands.claim({ id: review.id, actor: AGENT });
      commands.deliver({ taskId: review.id, report: report(), actor: AGENT });
      commands.moveStatus({ id: review.id, to: "done", actor: HUMAN });
      assert.throws(
        () => commands.reopenStatus({ id: review.id, actor: HUMAN, reason: "I want to reopen the review" }),
        (err) => err.code === "INVALID_TRANSITION",
      );
    });
  });

  it("does not let deliver become a reasonless reopen", async () => {
    await board(async ({ commands }) => {
      const task = doneTask(commands);
      assert.throws(
        () => commands.deliver({ taskId: task.id, report: report(), to: "todo", actor: AGENT }),
        (err) => err.code === "TERMINAL_STATE",
      );
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

describe("commands/tasks — acceptance authority (done is human/system only)", () => {
  /** A card delivered to `in_review` by its worker — one move from acceptance. */
  const delivered = (commands) => {
    const task = commands.createTask({
      projectId: "proj",
      title: "Work",
      assignee: "linus",
      assigneeKind: "agent",
      actor: AGENT,
    });
    commands.claim({ id: task.id, actor: AGENT });
    commands.deliver({ taskId: task.id, report: report(), actor: AGENT });
    return task;
  };

  it("refuses an agent accepting its own delivery, and says which kinds may", async () => {
    await board(async ({ commands }) => {
      const task = delivered(commands);
      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "done", actor: AGENT }),
        (err) => {
          assert.equal(err.code, "ACCEPTANCE_FORBIDDEN");
          assert.equal(err.http, 409);
          assert.deepEqual(err.details.allowed, ["human", "taskd"]);
          assert.equal(err.details.actorKind, "agent");
          assert.match(err.hint.fix, /in_review/);
          return true;
        },
      );
      assert.equal(commands.getTask({ id: task.id }).status, "in_review", "the refusal moves nothing");
    });
  });

  it("lets a human accept, and lets the board itself accept (the loop's path)", async () => {
    await board(async ({ commands }) => {
      const byHuman = delivered(commands);
      assert.equal(commands.moveStatus({ id: byHuman.id, to: "done", actor: HUMAN }).status, "done");

      const bySystem = commands.createTask({
        projectId: "proj",
        title: "Loop-accepted",
        assignee: "linus",
        assigneeKind: "agent",
        actor: AGENT,
        allowDup: true,
      });
      commands.claim({ id: bySystem.id, actor: AGENT });
      commands.deliver({ taskId: bySystem.id, report: report(), actor: AGENT });
      assert.equal(
        commands.moveStatus({ id: bySystem.id, to: "done", actor: { kind: "taskd", id: "taskd" } }).status,
        "done",
      );
    });
  });

  it("applies the same rule to `deliver --to done` (the wire-only shortcut)", async () => {
    await board(async ({ commands }) => {
      // A waived delivery leaves round 1 with no report, so the round's one
      // report can still be written by the `deliver --to done` call.
      const task = commands.createTask({
        projectId: "proj",
        title: "Waived, then accepted",
        assignee: "linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      commands.claim({ id: task.id, actor: AGENT });
      commands.moveStatus({
        id: task.id,
        to: "in_review",
        noReport: true,
        reason: "audited waiver, no commit",
        actor: AGENT,
      });

      assert.throws(
        () => commands.deliver({ taskId: task.id, to: "done", report: report(), actor: AGENT }),
        (err) => err.code === "ACCEPTANCE_FORBIDDEN",
      );
      assert.equal(commands.getTask({ id: task.id }).status, "in_review");
      assert.equal(
        commands.deliver({ taskId: task.id, to: "done", report: report(), actor: HUMAN }).task.status,
        "done",
      );
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
        [
          "id",
          "identifier",
          "priority",
          "project",
          "reason",
          "review_of",
          "review_round",
          "sort",
          "status",
          "title",
        ],
        "exactly the card's fields plus reason — no `target`, the board owns no directory (O3)",
      );
      assert.equal(candidates[0].review_of, null, "a normal card carries no review target");
      assert.equal(candidates[0].review_round, null);
      assert.equal(candidates[0].status, "todo", "the canonical status, never the ready alias");
      assert.equal(candidates[0].priority, "medium");
      assert.equal(candidates[0].project, "proj");
      assert.equal(candidates[0].sort, 0);
      assert.equal(candidates[0].reason, "ready");
      assert.equal(revision(db), before, "the poll read writes nothing");
    });
  });

  it("projects a review card's target and audited round", async () => {
    await board(async ({ commands }) => {
      const original = linusTodo(commands, { title: "Audit me", allowDup: true });
      commands.claim({ id: original.id, actor: AGENT });
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
      const review = linusTodo(commands, {
        title: "Review it",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: "1", flow: "B" },
      });

      const candidates = commands.listCandidates({ assignee: "linus" });
      const projected = candidates.find((c) => c.identifier === review.identifier);
      assert.ok(projected, "the review card is a normal todo candidate for its reviewer");
      assert.equal(projected.review_of, original.identifier);
      assert.equal(projected.review_round, 1, "a string meta value is coerced to an integer");
      assert.equal(projected.status, "todo", "the review card runs through the normal claim→wake path");

      // A malformed round is refused at creation (0025): a marker describes a
      // real audit, so an unreadable round may not be stored as "any round".
      assert.throws(
        () =>
          linusTodo(commands, {
            title: "Review it badly",
            allowDup: true,
            meta: { review_of: original.identifier, review_round: "round-two" },
          }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "review_round",
      );
      // The structural marker is the id, not the identifier the meta carries.
      assert.equal(review.reviewOfId, original.id);
      assert.equal(review.reviewRound, 1);
    });
  });

  it("projects a review card created through the top-level review_of field", async () => {
    await board(async ({ commands }) => {
      const original = linusTodo(commands, { title: "Audit me", allowDup: true });
      commands.claim({ id: original.id, actor: AGENT });
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
      const review = linusTodo(commands, {
        title: "Review it",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 1,
      });

      const projected = commands
        .listCandidates({ assignee: "linus" })
        .find((candidate) => candidate.identifier === review.identifier);
      assert.ok(projected, "the review card is a normal todo candidate for its reviewer");
      assert.equal(projected.review_of, original.identifier);
      assert.equal(projected.review_round, 1);
    });
  });

  it("never offers an awaiting card, even as a stale claim (0034)", async () => {
    await board(async ({ db, commands }) => {
      const task = linusTodo(commands, { title: "Waiting", allowDup: true });
      commands.claim({ id: task.id, actor: AGENT });
      commands.moveStatus({
        id: task.id,
        to: "awaiting",
        awaitingReason: "E2",
        question: "which schema?",
        actor: AGENT,
      });
      // Age the dormant claim far past every window; `awaiting` is still excluded
      // because the poll only ever offers `in_progress` recoveries.
      db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", task.id);
      assert.equal(
        commands.listCandidates({ assignee: "linus", stale: true }).some((candidate) => candidate.id === task.id),
        false,
      );

      // The human's decision re-queues it; then it is a normal todo candidate.
      commands.addComment({ taskId: task.id, body: "v2", kind: "confirm", actor: HUMAN });
      assert.deepEqual(
        commands.listCandidates({ assignee: "linus" }).map((candidate) => candidate.id),
        [task.id],
      );
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

      // The recovery pool is not scoped to the asker's own cards: past six hours
      // any agent may take the claim over, so a third agent must be able to
      // discover it. The 30-minute window stays holder-only.
      ensureActor(db, "jobs");
      const thirdParty = commands.listCandidates({ assignee: "jobs", stale: true });
      assert.deepEqual(
        thirdParty.map((c) => [c.identifier, c.reason]),
        [[staleAny.identifier, "stale_any"]],
        "another agent sees only the six-hour takeover, never the holder's 30-minute window",
      );

      // …and a name that resolves to no dictionary entry still gets the takeover
      // pool: the six-hour rule does not depend on who is asking.
      assert.deepEqual(
        commands.listCandidates({ assignee: "ghost", stale: true }).map((c) => [c.identifier, c.reason]),
        [[staleAny.identifier, "stale_any"]],
      );
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
        question: "is this the intended scope?",
        actor: AGENT,
      });
      assert.equal(actorName(db, waiting.claimedBy), "linus", "asking a human does not hand the card over");
      const resumed = commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.equal(actorName(db, resumed.claimedBy), "linus");
      assert.equal(resumed.heartbeatAt, task.heartbeatAt, "resuming does not re-stamp the attempt");
    });
  });

  it("an agent must ask a question to enter awaiting; a human may park silently (0034)", async () => {
    await board(async ({ db, commands }) => {
      const task = await claimed(commands);
      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "awaiting", awaitingReason: "E2", actor: AGENT }),
        (err) => err.code === "QUESTION_REQUIRED" && err.http === 422,
      );
      assert.equal(commands.getTask({ id: task.id }).status, "in_progress", "a refusal writes nothing");

      const waiting = commands.moveStatus({
        id: task.id,
        to: "awaiting",
        awaitingReason: "E2",
        question: "which schema?",
        actor: AGENT,
      });
      assert.equal(waiting.status, "awaiting");
      const [question] = commands
        .listComments({ taskId: task.id })
        .filter((comment) => comment.kind === "question");
      assert.equal(question.body, "which schema?");
      const moved = db
        .prepare(
          "SELECT changes_json FROM task_activities WHERE task_id = ? AND event = 'task_moved' ORDER BY id DESC LIMIT 1",
        )
        .get(task.id);
      assert.equal(JSON.parse(moved.changes_json).questionCommentId, question.id);

      // Back into the work and out again: the still-unanswered question is
      // reused, so the worker does not have to repeat it.
      commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      assert.equal(
        commands.moveStatus({ id: task.id, to: "awaiting", awaitingReason: "E2", actor: AGENT }).status,
        "awaiting",
      );

      // A human parks a card without inventing a question.
      const parked = commands.createTask({
        projectId: "proj",
        title: "Parked",
        allowDup: true,
        actor: AGENT,
      });
      commands.claim({ id: parked.id, actor: AGENT });
      assert.equal(
        commands.moveStatus({ id: parked.id, to: "awaiting", awaitingReason: "E1", actor: HUMAN }).status,
        "awaiting",
      );
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

describe("commands/tasks — acceptance policy and the two terminality gates", () => {
  const TASKD = { kind: "taskd", id: "taskd" };

  /** Put a card in `in_review` the legal way (claim, then deliver). */
  const deliverCard = (commands, task, actor = AGENT) => {
    commands.claim({ id: task.id, actor });
    return commands.deliver({ taskId: task.id, report: report(), actor });
  };

  /** Put a top-level epic in `in_review` (it cannot be claimed). */
  const deliverEpic = (commands, epic) =>
    commands.deliver({ taskId: epic.id, report: report(), actor: AGENT });

  /** Is the acceptance of this card refused, and with which code? */
  const refusal = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      assert.ok(err instanceof DomainError, err?.stack ?? String(err));
      return err.code;
    }
  };

  /* -------------------------------------------------------------- policy */

  it("both (the default) accepts from a human or the board, never from an agent", async () => {
    for (const actor of [HUMAN, TASKD]) {
      await board(async ({ commands }) => {
        const task = commands.createTask({ projectId: "proj", title: "Top", actor: AGENT });
        deliverCard(commands, task);
        assert.equal(commands.moveStatus({ id: task.id, to: "done", actor }).status, "done");
      });
    }
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Top", actor: AGENT });
      deliverCard(commands, task);
      assert.equal(refusal(() => commands.moveStatus({ id: task.id, to: "done", actor: AGENT })), "ACCEPTANCE_FORBIDDEN");
    });
  });

  it("human-only accepts only from a human on a top-level original", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Top", actor: AGENT });
      deliverCard(commands, task);
      assert.equal(refusal(() => commands.moveStatus({ id: task.id, to: "done", actor: TASKD })), "ACCEPTANCE_FORBIDDEN");
      assert.equal(commands.moveStatus({ id: task.id, to: "done", actor: HUMAN }).status, "done");
    }, { policy: () => "human-only" });
  });

  it("agent-only accepts from any non-human, and refuses the human", async () => {
    for (const actor of [TASKD, { kind: "claude", id: "claude" }, AGENT]) {
      await board(async ({ commands }) => {
        const task = commands.createTask({ projectId: "proj", title: "Top", actor: AGENT });
        deliverCard(commands, task);
        assert.equal(commands.moveStatus({ id: task.id, to: "done", actor }).status, "done");
      }, { policy: () => "agent-only" });
    }
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Top", actor: AGENT });
      deliverCard(commands, task);
      assert.equal(refusal(() => commands.moveStatus({ id: task.id, to: "done", actor: HUMAN })), "ACCEPTANCE_FORBIDDEN");
    }, { policy: () => "agent-only" });
  });

  it("a human may never accept a child card — under any policy", async () => {
    for (const policy of ["human-only", "both", "agent-only"]) {
      await board(async ({ commands }) => {
        const epic = commands.createTask({ projectId: "proj", title: "Container", kind: "epic", actor: AGENT });
        const child = commands.createTask({ projectId: "proj", title: "Child", allowDup: true, actor: AGENT });
        commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });
        deliverCard(commands, child);
        assert.equal(
          refusal(() => commands.moveStatus({ id: child.id, to: "done", actor: HUMAN })),
          "ACCEPTANCE_FORBIDDEN",
          policy,
        );
        assert.equal(commands.moveStatus({ id: child.id, to: "done", actor: AGENT }).status, "done", policy);
      }, { policy: () => policy });
    }
  });

  it("a review card is closed by the human or the board, and by any non-human under agent-only", async () => {
    const makeReview = (commands) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: 1 },
        actor: AGENT,
      });
      deliverCard(commands, review);
      return review;
    };

    for (const actor of [HUMAN, TASKD]) {
      await board(async ({ commands }) => {
        const review = makeReview(commands);
        assert.equal(commands.moveStatus({ id: review.id, to: "done", actor }).status, "done");
      });
    }
    await board(async ({ commands }) => {
      const review = makeReview(commands);
      assert.equal(refusal(() => commands.moveStatus({ id: review.id, to: "done", actor: AGENT })), "ACCEPTANCE_FORBIDDEN");
    });
    await board(async ({ commands }) => {
      const review = makeReview(commands);
      assert.equal(commands.moveStatus({ id: review.id, to: "done", actor: AGENT }).status, "done");
    }, { policy: () => "agent-only" });
    await board(async ({ commands }) => {
      const review = makeReview(commands);
      assert.equal(refusal(() => commands.moveStatus({ id: review.id, to: "done", actor: HUMAN })), "ACCEPTANCE_FORBIDDEN");
    }, { policy: () => "agent-only" });
  });

  it("authority is decided before the review/children gates", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: 1 },
        actor: AGENT,
      });
      // An agent is refused as an acceptor before the pending review is read.
      assert.equal(refusal(() => commands.moveStatus({ id: original.id, to: "done", actor: AGENT })), "ACCEPTANCE_FORBIDDEN");
    });
  });

  /* --------------------------------------------------------- review-ready */

  it("a human closing a top-level card needs the current round's reviews resolved", async () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked", "awaiting"]) {
      await board(async ({ commands }) => {
        const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
        deliverCard(commands, original);
        const review = commands.createTask({
          projectId: "proj",
          title: "Review",
          allowDup: true,
          meta: { review_of: original.identifier, review_round: 1 },
          actor: AGENT,
        });
        if (status !== "todo") {
          // `in_review`/`blocked` are reached through the work; the other
          // statuses directly from `todo`.
          if (status === "awaiting" || status === "in_review" || status === "in_progress") {
            commands.claim({ id: review.id, actor: AGENT });
            if (status === "awaiting") {
              commands.moveStatus({
                id: review.id,
                to: "awaiting",
                awaitingReason: "E1",
                question: "what is the review waiting on?",
                actor: AGENT,
              });
            } else if (status === "in_review") {
              commands.deliver({ taskId: review.id, report: report(), actor: AGENT });
            }
          } else {
            commands.moveStatus({ id: review.id, to: "blocked", actor: AGENT });
          }
        }
        assert.equal(commands.getTask({ id: review.id }).status, status);
        assert.equal(
          refusal(() => commands.moveStatus({ id: original.id, to: "done", actor: HUMAN })),
          "REVIEW_PENDING",
          `a ${status} review holds the original open`,
        );
      });
    }
  });

  it("a done or canceled review releases the original; an old round does not hold it", async () => {
    for (const resolved of ["done", "canceled"]) {
      await board(async ({ commands }) => {
        const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
        deliverCard(commands, original);
        const review = commands.createTask({
          projectId: "proj",
          title: "Review",
          allowDup: true,
          meta: { review_of: original.identifier, review_round: 1 },
          actor: AGENT,
        });
        if (resolved === "done") {
          deliverCard(commands, review);
          commands.moveStatus({ id: review.id, to: "done", actor: HUMAN });
        } else {
          commands.moveStatus({ id: review.id, to: "canceled", actor: AGENT });
        }
        assert.equal(commands.moveStatus({ id: original.id, to: "done", actor: HUMAN }).status, "done");
      });
    }

    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      // A review for round 1 is valid while the card is on round 1. The card
      // then moves to round 2; the old review is history, not a hold.
      commands.createTask({
        projectId: "proj",
        title: "Old review",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: 1 },
        actor: AGENT,
      });
      commands.moveStatus({ id: original.id, to: "in_progress", actor: AGENT });
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT });
      assert.equal(commands.moveStatus({ id: original.id, to: "done", actor: HUMAN }).status, "done");
    });
  });

  it("a NULL-round review covers every round (the conservative reading)", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      commands.createTask({
        projectId: "proj",
        title: "Review without a round",
        allowDup: true,
        meta: { review_of: original.identifier },
        actor: AGENT,
      });
      assert.equal(refusal(() => commands.moveStatus({ id: original.id, to: "done", actor: HUMAN })), "REVIEW_PENDING");
    });
  });

  it("deliver(to: done) applies the same review-ready gate", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: 1 },
        actor: AGENT,
      });
      assert.equal(
        refusal(() => commands.deliver({ taskId: original.id, to: "done", report: report(), actor: HUMAN })),
        "REVIEW_PENDING",
      );
    });
  });

  it("a system/agent acceptance is not held by a pending review (the loop's write order)", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: 1 },
        actor: AGENT,
      });
      assert.equal(commands.moveStatus({ id: original.id, to: "done", actor: TASKD }).status, "done");
    });
  });

  /* ------------------------------------------------- children-terminal gate */

  it("refuses in_review and done while a child is non-terminal", async () => {
    await board(async ({ commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Container", kind: "epic", actor: AGENT });
      const child = commands.createTask({ projectId: "proj", title: "Child", allowDup: true, actor: AGENT });
      commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });

      assert.equal(refusal(() => deliverEpic(commands, epic)), "CHILDREN_OPEN");
      // `done` is only reachable from in_review; start the epic there directly
      // through the legal delivery once the child is finished below.
      assert.equal(commands.getTask({ id: epic.id }).status, "todo", "a refused delivery writes nothing");
    });
  });

  it("passes once every child is terminal, and re-opens when a child is added", async () => {
    await board(async ({ commands }) => {
      const epic = commands.createTask({ projectId: "proj", title: "Container", kind: "epic", actor: AGENT });
      const child = commands.createTask({ projectId: "proj", title: "Child", allowDup: true, actor: AGENT });
      commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: AGENT });

      deliverCard(commands, child);
      commands.moveStatus({ id: child.id, to: "done", actor: AGENT });
      // The last child landing closes the container automatically; if it did
      // not, the manual delivery must pass.
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");

      const late = commands.createTask({ projectId: "proj", title: "Late", allowDup: true, actor: AGENT });
      commands.addRelation({ type: "parent", source: epic.id, target: late.id, actor: AGENT });
      assert.equal(refusal(() => commands.moveStatus({ id: epic.id, to: "done", actor: HUMAN })), "CHILDREN_OPEN");

      commands.moveStatus({ id: late.id, to: "canceled", actor: AGENT });
      // 0033 — the round-1 rollup predates `late`, so it cannot accept the epic.
      // Rework bumps the round; the sweep then writes a fresh rollup.
      assert.equal(refusal(() => commands.moveStatus({ id: epic.id, to: "done", actor: HUMAN })), "ROLLUP_STALE");
      commands.moveStatus({ id: epic.id, to: "in_progress", actor: HUMAN });
      commands.reconcileContainers();
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review", "a new round, a new rollup");
      assert.equal(commands.moveStatus({ id: epic.id, to: "done", actor: HUMAN }).status, "done");
    });
  });

  it("a leaf card is unaffected; an empty epic has nothing to roll up", async () => {
    await board(async ({ commands }) => {
      const leaf = commands.createTask({ projectId: "proj", title: "Leaf", actor: AGENT });
      deliverCard(commands, leaf);
      assert.equal(commands.moveStatus({ id: leaf.id, to: "done", actor: HUMAN }).status, "done");

      const empty = commands.createTask({ projectId: "proj", title: "Empty", kind: "epic", allowDup: true, actor: AGENT });
      assert.equal(refusal(() => deliverEpic(commands, empty)), "ROLLUP_STALE", "no children, no rollup");
    });
  });

  /* --------------------------------------------------- creation + marker */

  it("a card cannot be created awaiting, and a review marker must resolve", async () => {
    await board(async ({ commands }) => {
      assert.equal(
        refusal(() => commands.createTask({ projectId: "proj", title: "Awaiting", status: "awaiting", actor: AGENT })),
        "VALIDATION_FAILED",
      );
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        meta: { review_of: original.identifier, review_round: "1" },
        actor: AGENT,
      });
      assert.equal(review.reviewOfId, original.id);
      assert.equal(review.reviewRound, 1);
      assert.equal(
        refusal(() =>
          commands.createTask({
            projectId: "proj",
            title: "Dangling",
            allowDup: true,
            reviewOf: "PROJ-9999",
            actor: AGENT,
          }),
        ),
        "VALIDATION_FAILED",
      );
    });
  });

  it("stamps the resolved marker into meta without mutating the caller's meta", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);

      const callerMeta = { flow: "B" };
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 1,
        meta: callerMeta,
        actor: AGENT,
      });
      assert.equal(review.meta.review_of, original.identifier, "the identifier, not the id");
      assert.equal(review.meta.review_round, 1, "an integer, not the caller's spelling");
      assert.equal(review.meta.flow, "B", "other meta keys survive");
      assert.deepEqual(callerMeta, { flow: "B" }, "the caller's object is never mutated");
      assert.equal(review.reviewOfId, original.id, "the column still holds the internal id");
      assert.equal(review.reviewRound, 1);

      // The meta path is normalized rather than trusted: an id and a string
      // round become the identifier and an integer.
      const metaInput = { review_of: original.id, review_round: "1" };
      const viaMeta = commands.createTask({
        projectId: "proj",
        title: "Review via meta",
        allowDup: true,
        meta: metaInput,
        actor: AGENT,
      });
      assert.equal(viaMeta.meta.review_of, original.identifier);
      assert.equal(viaMeta.meta.review_round, 1);
      assert.deepEqual(metaInput, { review_of: original.id, review_round: "1" });

      // No round: omit the key rather than write null/"".
      const noRound = commands.createTask({
        projectId: "proj",
        title: "Roundless review",
        allowDup: true,
        reviewOf: original.identifier,
        actor: AGENT,
      });
      assert.equal(Object.hasOwn(noRound.meta, "review_round"), false);
      assert.equal(noRound.reviewRound, null);
    });
  });

  it("refuses a review_of that names another review card", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 1,
        actor: AGENT,
      });

      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "Review of a review",
            allowDup: true,
            reviewOf: review.identifier,
            reviewRound: 1,
            actor: AGENT,
          }),
        (err) =>
          err.code === "VALIDATION_FAILED" &&
          err.details.field === "review_of" &&
          /cannot itself be reviewed/.test(err.message),
      );
    });
  });

  it("refuses a legacy meta.review_of that names another review card", async () => {
    await board(async ({ db, commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      const plain = commands.createTask({ projectId: "proj", title: "Plain", allowDup: true, actor: AGENT });
      // The immutability trigger covers the structural columns only; a legacy
      // row can still carry the marker in meta. The guard must fail closed.
      db.prepare("UPDATE tasks SET meta_json = ? WHERE id = ?").run(
        JSON.stringify({ review_of: original.identifier }),
        plain.id,
      );

      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "Review of a legacy review",
            allowDup: true,
            reviewOf: plain.identifier,
            reviewRound: 1,
            actor: AGENT,
          }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "review_of",
      );
    });
  });

  it("requires review_round to equal the original's current delivery round", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original); // round 1, in_review
      commands.moveStatus({ id: original.id, to: "in_progress", actor: AGENT }); // round bumps to 2
      commands.deliver({ taskId: original.id, report: report(), actor: AGENT }); // round 2, in_review

      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "Stale review",
            allowDup: true,
            reviewOf: original.identifier,
            reviewRound: 1,
            actor: AGENT,
          }),
        (err) =>
          err.code === "VALIDATION_FAILED" &&
          err.details.field === "review_round" &&
          err.details.expected === 2,
      );

      const current = commands.createTask({
        projectId: "proj",
        title: "Current review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 2,
        actor: AGENT,
      });
      assert.equal(current.reviewRound, 2);

      // Omitted still means "covers every round" for legacy callers.
      const agnostic = commands.createTask({
        projectId: "proj",
        title: "Round-agnostic review",
        allowDup: true,
        reviewOf: original.identifier,
        actor: AGENT,
      });
      assert.equal(agnostic.reviewRound, null);
    });
  });

  it("requires a review card to be kind=task", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "Epic review",
            kind: "epic",
            allowDup: true,
            reviewOf: original.identifier,
            reviewRound: 1,
            actor: AGENT,
          }),
        (err) => err.code === "VALIDATION_FAILED" && err.details.field === "kind",
      );
    });
  });

  it("requires the original to be in_review", async () => {
    for (const setup of ["todo", "in_progress", "done", "canceled"]) {
      await board(async ({ commands }) => {
        const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
        if (setup === "in_progress") commands.claim({ id: original.id, actor: AGENT });
        if (setup === "done") {
          deliverCard(commands, original);
          commands.moveStatus({ id: original.id, to: "done", actor: HUMAN });
        }
        if (setup === "canceled") commands.moveStatus({ id: original.id, to: "canceled", actor: AGENT });

        assert.throws(
          () =>
            commands.createTask({
              projectId: "proj",
              title: "Review",
              allowDup: true,
              reviewOf: original.identifier,
              reviewRound: original.deliveryRound,
              actor: AGENT,
            }),
          (err) =>
            err.code === "VALIDATION_FAILED" &&
            err.details.field === "review_of" &&
            err.details.status === setup &&
            err.details.expected === "in_review" &&
            err.details.deliveryRound === original.deliveryRound &&
            /deliver/.test(err.hint?.fix ?? ""),
          `${setup} must be refused`,
        );
      });
    }

    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
        actor: AGENT,
      });
      assert.equal(review.reviewOfId, original.id, "in_review is the control case");
    });
  });

  it("reports review-of-review before original-status", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
        actor: AGENT,
      });

      // The review card itself is `todo`, so a status-first guard would report
      // "not in_review"; the marker guard must win.
      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "Review of a review",
            allowDup: true,
            reviewOf: review.identifier,
            reviewRound: review.deliveryRound,
            actor: AGENT,
          }),
        (err) =>
          err.code === "VALIDATION_FAILED" &&
          err.details.field === "review_of" &&
          /cannot itself be reviewed/.test(err.message),
      );
    });
  });

  it("returns the existing review card on a retried create after the original leaves in_review", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({ projectId: "proj", title: "Original", actor: AGENT });
      deliverCard(commands, original);
      const idem = `loop-review|${original.identifier}|r${original.deliveryRound}`;
      const review = commands.createTask({
        projectId: "proj",
        title: "Review",
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
        idem,
        actor: AGENT,
      });

      // The original moves on; a crashed loop retries the same idempotent
      // create. The short-circuit must return the existing row before the
      // marker guard re-checks the original's status/round.
      commands.moveStatus({ id: original.id, to: "in_progress", actor: AGENT });
      const retried = commands.createTask({
        projectId: "proj",
        title: "Review",
        reviewOf: original.identifier,
        reviewRound: 1,
        idem,
        actor: AGENT,
      });
      assert.equal(retried.id, review.id);
    });
  });
});

// ---------------------------------------------------------------------------
// 0031 — the per-card review decision
// ---------------------------------------------------------------------------

describe("commands/tasks — review decision (0031)", () => {
  const TASKD = { kind: "taskd", id: "board" };

  /** Create, claim and deliver a card; returns the delivered in_review row. */
  function deliverOne(commands, projectId, title, actor = AGENT) {
    const task = commands.createTask({ projectId, title, actor });
    commands.claim({ id: task.id, actor });
    return commands.deliver({ taskId: task.id, report: report(), actor }).task;
  }

  it("resolves required / optional / off at creation", async () => {
    await board(async ({ commands }) => {
      commands.createProject({ id: "req", name: "Required", reviewPolicy: "required", actor: HUMAN });
      commands.createProject({ id: "off", name: "Off", reviewPolicy: "off", actor: HUMAN });

      assert.equal(commands.createTask({ projectId: "req", title: "r", actor: AGENT }).reviewRequired, 1);
      assert.equal(commands.createTask({ projectId: "off", title: "o", actor: AGENT }).reviewRequired, 0);
      assert.equal(commands.createTask({ projectId: "proj", title: "d", actor: AGENT }).reviewRequired, 0);
      assert.equal(
        commands.createTask({ projectId: "proj", title: "y", actor: AGENT, reviewRequired: true }).reviewRequired,
        1,
      );
      assert.throws(
        () => commands.createTask({ projectId: "req", title: "no", actor: AGENT, reviewRequired: false }),
        (err) => err.code === "VALIDATION_FAILED",
      );
      assert.throws(
        () => commands.createTask({ projectId: "off", title: "yes", actor: AGENT, reviewRequired: true }),
        (err) => err.code === "VALIDATION_FAILED",
      );
    });
  });

  it("refuses an agent's omission in an optional project", async () => {
    await board(async ({ commands }) => {
      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "decide",
            actor: AGENT,
            requireReviewDecision: true,
          }),
        (err) => err.code === "VALIDATION_FAILED" && err.details?.field === "review_required",
      );
      // A human/UI caller may omit it and gets the default.
      assert.equal(
        commands.createTask({ projectId: "proj", title: "human", actor: HUMAN, requireReviewDecision: false })
          .reviewRequired,
        0,
      );
    });
  });

  it("forces a review card to 0 and refuses an opt-in", async () => {
    await board(async ({ commands }) => {
      const original = deliverOne(commands, "proj", "original");
      const review = commands.createTask({
        projectId: "proj",
        title: "review",
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
        actor: AGENT,
      });
      assert.equal(review.reviewRequired, 0);
      assert.throws(
        () =>
          commands.createTask({
            projectId: "proj",
            title: "review two",
            reviewOf: original.identifier,
            reviewRound: original.deliveryRound,
            actor: AGENT,
            reviewRequired: true,
            // Bypass the creation idempotency guard (the first review card is
            // non-terminal and already holds the derived key) so the resolver
            // is the thing that refuses.
            allowDup: true,
          }),
        (err) => err.code === "VALIDATION_FAILED",
      );
    });
  });

  it("requires an approved current-round review before done", async () => {
    await board(async ({ commands }) => {
      commands.createProject({ id: "req", name: "Required", reviewPolicy: "required", actor: HUMAN });
      const original = deliverOne(commands, "req", "original");
      assert.equal(original.reviewRequired, 1);

      assert.throws(
        () => commands.moveStatus({ id: original.id, to: "done", actor: TASKD }),
        (err) => err.code === "REVIEW_REQUIRED",
      );

      const review = commands.createTask({
        projectId: "req",
        title: "review",
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
        actor: AGENT,
      });
      assert.equal(review.reviewRequired, 0, "a review card never requires its own review");
      commands.claim({ id: review.id, actor: AGENT });
      commands.deliver({
        taskId: review.id,
        report: report({ conclusion: "VERDICT: APPROVE\nlooks good" }),
        actor: AGENT,
      });

      const done = commands.moveStatus({ id: original.id, to: "done", actor: TASKD });
      assert.equal(done.status, "done");
    });
  });

  it("lets a human waive with a reason, and refuses an agent", async () => {
    await board(async ({ db, commands }) => {
      commands.createProject({ id: "req", name: "Required", reviewPolicy: "required", actor: HUMAN });
      const original = deliverOne(commands, "req", "original");

      assert.throws(
        () =>
          commands.updateTask({
            id: original.id,
            reviewRequired: false,
            reason: "documentation only",
            actor: AGENT,
          }),
        (err) => err.code === "ACCEPTANCE_FORBIDDEN",
      );
      assert.throws(
        () => commands.updateTask({ id: original.id, reviewRequired: false, actor: HUMAN }),
        (err) => err.code === "VALIDATION_FAILED",
      );

      const waived = commands.updateTask({
        id: original.id,
        reviewRequired: false,
        reason: "documentation only",
        actor: HUMAN,
      });
      assert.equal(waived.reviewRequired, 0);
      assert.ok(activitiesFor(db, original.id).includes("review_override"));
      assert.equal(commands.moveStatus({ id: original.id, to: "done", actor: HUMAN }).status, "done");
    });
  });

  it("refuses a waiver while a current-round review is open", async () => {
    await board(async ({ commands }) => {
      commands.createProject({ id: "req", name: "Required", reviewPolicy: "required", actor: HUMAN });
      const original = deliverOne(commands, "req", "original");
      commands.createTask({
        projectId: "req",
        title: "review",
        reviewOf: original.identifier,
        reviewRound: original.deliveryRound,
        actor: AGENT,
      });
      assert.throws(
        () =>
          commands.updateTask({
            id: original.id,
            reviewRequired: false,
            reason: "please skip",
            actor: HUMAN,
          }),
        (err) => err.code === "REVIEW_PENDING",
      );
    });
  });

  it("lets an agent escalate and refuses an escalation in an off project", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "escalate", actor: AGENT });
      assert.equal(task.reviewRequired, 0);
      assert.equal(
        commands.updateTask({ id: task.id, reviewRequired: true, actor: AGENT }).reviewRequired,
        1,
      );

      commands.createProject({ id: "off", name: "Off", reviewPolicy: "off", actor: HUMAN });
      const off = commands.createTask({ projectId: "off", title: "off", actor: AGENT });
      assert.throws(
        () => commands.updateTask({ id: off.id, reviewRequired: true, actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED",
      );
    });
  });
});

describe("commands/tasks — acceptance snapshot (0032)", () => {
  it("seeds the frozen baseline from meta.acceptance, legacy text, and the 60-item cap", async () => {
    await board(async ({ commands }) => {
      const modern = commands.createTask({
        projectId: "proj",
        title: "modern",
        meta: { acceptance: [" a ", "b", "A", ""] },
        actor: AGENT,
      });
      assert.deepEqual(modern.acceptance, ["a", "b"]);
      assert.equal(modern.acceptanceRevision, 1);

      const legacy = commands.createTask({
        projectId: "proj",
        title: "legacy",
        meta: {
          acceptance_legacy: [
            { text: "old one", checked: true },
            { text: "old two", checked: false },
          ],
        },
        actor: AGENT,
      });
      assert.deepEqual(legacy.acceptance, ["old one", "old two"]);
      assert.equal(legacy.acceptanceRevision, 1);

      const capped = commands.createTask({
        projectId: "proj",
        title: "capped",
        meta: { acceptance: Array.from({ length: 70 }, (_, i) => `item ${i}`) },
        actor: AGENT,
      });
      assert.equal(capped.acceptance.length, 60);

      const plain = commands.createTask({ projectId: "proj", title: "plain", actor: AGENT });
      assert.deepEqual(plain.acceptance, []);
      assert.equal(plain.acceptanceRevision, 0);
    });
  });

  it("seeds an empty snapshot at claim from a meta value written outside the command", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "derived at claim", actor: AGENT });
      db.prepare("UPDATE tasks SET meta_json = ? WHERE id = ?").run(
        JSON.stringify({ acceptance: ["derived one", "derived two"] }),
        task.id,
      );
      const claimed = commands.claim({ id: task.id, actor: AGENT }).task;
      assert.deepEqual(claimed.acceptance, ["derived one", "derived two"]);
      assert.equal(claimed.acceptanceRevision, 1);
    });
  });

  it("appends idempotently, and lets only a human prune with a reason and the current revision", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "baseline",
        meta: { acceptance: ["a"] },
        actor: AGENT,
      });
      const appended = commands.updateTask({ id: task.id, acceptance: ["a", "b"], actor: AGENT });
      assert.deepEqual(appended.acceptance, ["a", "b"]);
      assert.equal(appended.acceptanceRevision, 2);
      assert.ok(activitiesFor(db, task.id).includes("acceptance_changed"));

      assert.throws(
        () => commands.updateTask({ id: task.id, acceptance: ["b"], actor: AGENT }),
        (err) => err.code === "VALIDATION_FAILED",
        "a no-op append is not a write",
      );

      assert.throws(
        () =>
          commands.updateTask({
            id: task.id,
            acceptanceDrop: ["a"],
            reason: "the operator narrowed the scope",
            actor: AGENT,
          }),
        (err) => err.code === "ACCEPTANCE_PRUNE_FORBIDDEN",
      );

      assert.throws(
        () =>
          commands.updateTask({
            id: task.id,
            acceptanceDrop: ["a"],
            reason: "short",
            actor: HUMAN,
          }),
        (err) => err.code === "VALIDATION_FAILED",
      );

      const pruned = commands.updateTask({
        id: task.id,
        acceptanceDrop: ["a"],
        reason: "the operator narrowed the scope",
        acceptanceRevision: appended.acceptanceRevision,
        actor: HUMAN,
      });
      assert.deepEqual(pruned.acceptance, ["b"]);
      assert.equal(pruned.acceptanceRevision, 3);
      assert.ok(activitiesFor(db, task.id).includes("acceptance_pruned"));

      assert.throws(
        () =>
          commands.updateTask({
            id: task.id,
            acceptanceDrop: ["b"],
            reason: "the operator narrowed the scope",
            acceptanceRevision: 1,
            actor: HUMAN,
          }),
        (err) => err.code === "ACCEPTANCE_STALE_REVISION",
      );

      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({
        taskId: task.id,
        report: report({ acceptance: [{ text: "b", status: "met" }] }),
        actor: AGENT,
      });
      assert.throws(
        () => commands.updateTask({ id: task.id, acceptance: ["c"], actor: AGENT }),
        (err) => err.code === "ACCEPTANCE_LOCKED",
      );
    });
  });

  it("refuses done until the current-round report covers the baseline", async () => {
    await board(async ({ commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "gate",
        meta: { acceptance: ["a", "b"] },
        actor: AGENT,
      });
      commands.claim({ id: task.id, actor: AGENT });
      commands.deliver({
        taskId: task.id,
        report: report({ acceptance: [{ text: "a", status: "met" }] }),
        actor: AGENT,
      });

      assert.throws(
        () => commands.moveStatus({ id: task.id, to: "done", actor: HUMAN }),
        (err) => err.code === "ACCEPTANCE_INCOMPLETE" && err.details.missing[0].text === "b",
      );
      const preflight = commands.canMove({ taskId: task.id, to: "done" });
      assert.equal(preflight.ok, false);
      assert.equal(preflight.reason, "ACCEPTANCE_INCOMPLETE");

      // A rework starts a new round, so a complete report can be written.
      commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
      commands.deliver({
        taskId: task.id,
        report: report({
          acceptance: [
            { text: "a", status: "met" },
            { text: "b", status: "met" },
          ],
        }),
        actor: AGENT,
      });
      commands.moveStatus({ id: task.id, to: "done", actor: HUMAN });
      assert.equal(commands.getTask({ id: task.id }).status, "done");
    });
  });

  it("blocks partial/not_met, accepts a noted not_applicable, and refuses a bare one at delivery", async () => {
    await board(async ({ commands }) => {
      const partial = commands.createTask({
        projectId: "proj",
        title: "partial",
        meta: { acceptance: ["a"] },
        actor: AGENT,
      });
      commands.claim({ id: partial.id, actor: AGENT });
      commands.deliver({
        taskId: partial.id,
        report: report({
          acceptance: [{ text: "a", status: "partial" }],
          leftovers: "the remaining part is scheduled next round",
        }),
        actor: AGENT,
      });
      assert.throws(
        () => commands.moveStatus({ id: partial.id, to: "done", actor: HUMAN }),
        (err) => err.code === "ACCEPTANCE_INCOMPLETE" && err.details.blocking[0].status === "partial",
      );

      const notApplicable = commands.createTask({
        projectId: "proj",
        title: "not applicable",
        meta: { acceptance: ["a"] },
        actor: AGENT,
      });
      commands.claim({ id: notApplicable.id, actor: AGENT });
      assert.throws(
        () =>
          commands.deliver({
            taskId: notApplicable.id,
            report: report({ acceptance: [{ text: "a", status: "not_applicable" }] }),
            actor: AGENT,
          }),
        (err) => err.code === "REPORT_NOT_APPLICABLE_NOTE",
      );
      commands.deliver({
        taskId: notApplicable.id,
        report: report({
          acceptance: [{ text: "a", status: "not_applicable", note: "canceled by the operator" }],
        }),
        actor: AGENT,
      });
      commands.moveStatus({ id: notApplicable.id, to: "done", actor: HUMAN });
      assert.equal(commands.getTask({ id: notApplicable.id }).status, "done");
    });
  });

  it("keeps an empty baseline vacuous, but a waiver does not satisfy a non-empty one", async () => {
    await board(async ({ commands }) => {
      const empty = commands.createTask({ projectId: "proj", title: "empty", actor: AGENT });
      commands.claim({ id: empty.id, actor: AGENT });
      commands.moveStatus({
        id: empty.id,
        to: "in_review",
        noReport: true,
        reason: "delivered under an audited waiver",
        actor: AGENT,
      });
      commands.moveStatus({ id: empty.id, to: "done", actor: HUMAN });
      assert.equal(commands.getTask({ id: empty.id }).status, "done");

      const waived = commands.createTask({
        projectId: "proj",
        title: "waived",
        meta: { acceptance: ["a"] },
        actor: AGENT,
      });
      commands.claim({ id: waived.id, actor: AGENT });
      commands.moveStatus({
        id: waived.id,
        to: "in_review",
        noReport: true,
        reason: "delivered under an audited waiver",
        actor: AGENT,
      });
      assert.throws(
        () => commands.moveStatus({ id: waived.id, to: "done", actor: HUMAN }),
        (err) => err.code === "ACCEPTANCE_UNVERIFIED" && err.details.waived === true,
      );

      // The repair is a current-round report in the same round.
      commands.writeReport({
        taskId: waived.id,
        report: report({ acceptance: [{ text: "a", status: "met" }] }),
        actor: AGENT,
      });
      commands.moveStatus({ id: waived.id, to: "done", actor: HUMAN });
      assert.equal(commands.getTask({ id: waived.id }).status, "done");
    });
  });

  it("requires an APPROVE report to cover the original's baseline", async () => {
    await board(async ({ commands }) => {
      const original = commands.createTask({
        projectId: "proj",
        title: "reviewed",
        meta: { acceptance: ["a", "b"] },
        reviewRequired: true,
        actor: AGENT,
      });
      commands.claim({ id: original.id, actor: AGENT });
      commands.deliver({
        taskId: original.id,
        report: report({
          acceptance: [
            { text: "a", status: "met" },
            { text: "b", status: "met" },
          ],
        }),
        actor: AGENT,
      });

      const review = commands.createTask({
        projectId: "proj",
        title: "review",
        reviewOf: original.identifier,
        reviewRound: 1,
        actor: AGENT,
      });
      assert.deepEqual(review.acceptance, [], "this fixture's review card has no copied baseline");
      commands.claim({ id: review.id, actor: AGENT });
      commands.deliver({
        taskId: review.id,
        report: report({
          conclusion: "VERDICT: APPROVE\n\nEverything checked; b has no evidence.",
          acceptance: [{ text: "a", status: "met" }],
        }),
        actor: AGENT,
      });
      commands.moveStatus({ id: review.id, to: "done", actor: HUMAN });

      assert.throws(
        () => commands.moveStatus({ id: original.id, to: "done", actor: HUMAN }),
        (err) => err.code === "ACCEPTANCE_INCOMPLETE" && err.details.source === "review",
      );
    });
  });
});
