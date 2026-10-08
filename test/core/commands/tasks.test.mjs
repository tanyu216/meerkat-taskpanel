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
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";
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

/** A board with repositories, commands and one project. */
async function board(fn, { clock } = {}) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos, ...(clock === undefined ? {} : { clock }) });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", workspacePath: "/tmp/ws", actor: HUMAN });
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

  it("resolves the assignee in the same transaction (event-driven dictionary)", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "Ship M1",
        assignee: "Linus",
        assigneeKind: "agent",
        actor: AGENT,
      });
      assert.equal(countRows(db, "assignees"), 1);
      const entry = commands.listAssignees({})[0];
      assert.equal(task.assigneeId, entry.id);
      assert.equal(task.assigneeKind, "agent");
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
      assert.equal(countRows(db, "assignees"), 2, "and no stray dictionary row");
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

describe("commands/tasks — claim and heartbeat", () => {
  it("claims, reuses and refuses exactly as the policy says", async () => {
    await board(async ({ db, commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      const before = revision(db);

      const claimed = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(claimed.reused, false);
      assert.equal(claimed.task.status, "in_progress");
      assert.equal(claimed.task.claimedBy, "linus");
      assert.equal(revision(db), before + 2, "claim + audit row");
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed"]);

      const again = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(again.reused, true, "the same actor keeps its claim");
      assert.equal(revision(db), before + 2, "reusing is not a write");
      assert.deepEqual(activitiesFor(db, task.id), ["task_created", "task_claimed"]);

      assert.throws(() => commands.claim({ id: task.id, actor: HUMAN }), (err) => {
        assert.equal(err.code, "EXECUTION_ACTIVE");
        assert.equal(err.http, 409);
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
      assert.equal(stolen.task.claimedBy, "Terry");

      const after = revision(db);
      const pulsed = commands.heartbeat({ id: task.id, actor: HUMAN });
      assert.equal(pulsed.heartbeatAt !== null, true);
      assert.equal(pulsed.status, "in_progress");
      assert.equal(revision(db), after + 2);

      assert.throws(() => commands.heartbeat({ id: task.id, actor: AGENT }), (err) => {
        assert.equal(err.code, "EXECUTION_ACTIVE");
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
      assert.equal(reworked.claimedBy, "linus", "a rework does not drop the claim");
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
    await board(async ({ commands }) => {
      const task = commands.createTask({ projectId: "proj", title: "Ship M1", actor: AGENT });
      const claimed = commands.claim({ id: task.id, actor: AGENT });
      assert.equal(claimed.task.claimedBy, "linus");
      assert.equal(claimed.task.createdAt, TS2, "the clock drives every timestamp");
    }, { clock: () => TS2 });
  });
});
