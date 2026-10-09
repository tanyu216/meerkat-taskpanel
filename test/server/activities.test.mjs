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
  commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/p", actor: AGENT });
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

  it("404s an unknown task reference", async () => {
    const response = await fetch(`${base}/api/v1/tasks/PROJ-9999/activities`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
  });
});
