/**
 * M6a — `GET /api/v1/tasks/:ref/activities` (§5.1).
 *
 * The audit trail as a read: every write command leaves exactly one row, so the
 * sequence a task's activities return *is* the history of the card — including
 * the `report_waived` event a reviewer looks for. That the same rows are what
 * the SSE stream pushes is the point: this route is the cursor read for a client
 * that was not connected.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";

const AGENT = { kind: "agent", id: "linus" };
const tempDirs = [];
let taskd;
let base;
let identifier;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-activities-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;

  const { commands } = taskd.board;
  commands.createProject({ id: "proj", name: "P", actor: AGENT });
  const task = commands.createTask({ projectId: "proj", title: "audited", actor: AGENT });
  identifier = task.identifier;
  commands.addComment({ taskId: task.id, body: "first note", actor: AGENT });
  commands.moveStatus({ id: task.id, to: "in_progress", actor: AGENT });
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const get = async (query = "") => (await (await fetch(`${base}/api/v1/tasks/${identifier}/activities${query}`)).json());
const boardGet = async (query = "") => (await (await fetch(`${base}/api/v1/activities${query}`)).json());

describe("server/routes — a task's audit trail", () => {
  it("returns the history in order, with the actor and the revision", async () => {
    const body = await get();
    assert.equal(body.ok, true);
    const events = body.data.activities;
    assert.deepEqual(events.map((entry) => entry.event), ["task_created", "comment_added", "task_claimed"]);
    assert.equal(body.data.task_id, taskd.board.repos.tasks.findByIdentifierAnyProject(identifier).id);

    const created = events[0];
    assert.equal(created.actor_id, "linus");
    assert.equal(created.actor_kind, "agent");
    assert.deepEqual(created.changes.identifier, identifier);
    assert.equal(typeof created.revision, "number");
    assert.equal(typeof created.created_at, "string");
  });

  it("honours ?limit and ?after as a cursor", async () => {
    const limited = (await get("?limit=1")).data.activities;
    assert.equal(limited.length, 1);
    assert.equal(limited[0].event, "task_created");

    const after = (await get(`?after=${limited[0].revision}`)).data.activities;
    assert.equal(after.some((entry) => entry.event === "task_created"), false);
    assert.deepEqual(after.map((entry) => entry.event), ["comment_added", "task_claimed"]);
  });

  it("returns the newest first when ?order=desc is asked for", async () => {
    const body = await get("?order=desc");
    assert.deepEqual(
      body.data.activities.map((entry) => entry.event),
      ["task_claimed", "comment_added", "task_created"],
    );

    // The drawer's contract: the 50 newest rows, newest first — not the oldest 50.
    const newest = (await get("?limit=1&order=desc")).data.activities;
    assert.deepEqual(newest.map((entry) => entry.event), ["task_claimed"]);

    // `order` is validated like `GET /tasks?order=`, not silently ignored.
    const response = await fetch(`${base}/api/v1/tasks/${identifier}/activities?order=bogus`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  });

  it("refuses an unparseable or out-of-range cursor instead of guessing", async () => {
    // A silently ignored `after` would replay the whole trail; `limit=-1`
    // reaches SQLite as an unbounded LIMIT.
    for (const query of ["?after=nope", "?after=-1", "?limit=nope", "?limit=0", "?limit=1001"]) {
      const response = await fetch(`${base}/api/v1/tasks/${identifier}/activities${query}`);
      assert.equal(response.status, 400, query);
      const body = await response.json();
      assert.equal(body.error.code, "VALIDATION_FAILED", query);
      assert.ok(["after", "limit"].includes(body.error.details.field), query);
    }
    assert.equal((await get("?after=0&limit=1")).data.activities.length, 1);
  });

  it("404s an unknown task reference", async () => {
    const response = await fetch(`${base}/api/v1/tasks/PROJ-9999/activities`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
  });
});

describe("server/routes — the board-wide activity trail", () => {
  it("returns every row, including a task-less project event", async () => {
    const body = await boardGet("?order=asc");
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.activities.map((entry) => entry.event), [
      "project_created",
      "task_created",
      "comment_added",
      "task_claimed",
    ]);
    assert.equal(body.data.activities[0].task_id, null, "a project row has no task");
    assert.equal(
      body.data.activities[1].task_id,
      taskd.board.repos.tasks.findByIdentifierAnyProject(identifier).id,
    );
  });

  it("honours the revision cursor and the newest-first read", async () => {
    const newest = (await boardGet("?limit=1&order=desc")).data.activities;
    assert.deepEqual(newest.map((entry) => entry.event), ["task_claimed"]);
    assert.deepEqual((await boardGet(`?after=${newest[0].revision}&order=asc`)).data.activities, []);

    const first = (await boardGet("?limit=1&order=asc")).data.activities;
    assert.deepEqual(
      (await boardGet(`?after=${first[0].revision}&order=asc`)).data.activities.map((entry) => entry.event),
      ["task_created", "comment_added", "task_claimed"],
    );
  });

  it("refuses an unparseable or out-of-range cursor", async () => {
    for (const query of ["?after=nope", "?limit=0", "?limit=1001"]) {
      const response = await fetch(`${base}/api/v1/activities${query}`);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, "VALIDATION_FAILED", query);
    }
  });
});
