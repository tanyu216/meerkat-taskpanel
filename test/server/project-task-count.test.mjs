/**
 * The sidebar badge's data source: `task_count` on `/projects`.
 *
 * The badge is the project's **total** task count (`design/BLOCKS.md` §Projects,
 * `design/DESIGN.md` §20.1): every status, archived included, and independent of
 * the §4.6 ordering. It is emphatically *not* the activity count the same route
 * exposes under `?order_debug=1` — that one counts `task_activities` rows in a
 * trailing window, so one create + one move + one archive make it three while the
 * project still owns a single task.
 *
 * Driven over real HTTP against a temp board, like the rest of `test/server/`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";

const tempDirs = [];
let taskd;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-task-count-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;

  dataOf(await call("POST", "/api/v1/projects", { id: "busy", name: "Busy" }));
  dataOf(await call("POST", "/api/v1/projects", { id: "quiet", name: "Quiet" }));

  dataOf(await call("POST", "/api/v1/tasks", { project_id: "busy", title: "Live one" }));
  dataOf(await call("POST", "/api/v1/tasks", { project_id: "busy", title: "Live two" }));
  const third = dataOf(await call("POST", "/api/v1/tasks", { project_id: "busy", title: "Retired" }));

  // Retire the third card so the count has a row the default task list hides:
  // `canceled` is terminal, and `days: 0` skips the archive window — the same
  // path `test/cli/issue.test.mjs` walks for `issue archive`.
  dataOf(await call("POST", `/api/v1/tasks/${third.task.identifier}/move`, { to: "canceled" }));
  dataOf(await call("POST", `/api/v1/tasks/${third.task.identifier}/archive`, { days: 0 }));
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Call the API. Returns `{status, body}` — never throws on a non-2xx. */
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

const dataOf = (result) => {
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.data;
};

const projectBy = (data, id) => data.projects.find((project) => project.id === id);

describe("server/routes — the sidebar task count", () => {
  it("serves a numeric task_count per project, archived rows included", async () => {
    const data = dataOf(await call("GET", "/api/v1/projects"));
    assert.deepEqual(data.projects.map((project) => project.id).sort(), ["busy", "quiet"]);

    for (const project of data.projects) {
      assert.equal(typeof project.task_count, "number", `${project.id} must carry a number`);
      assert.ok(Number.isInteger(project.task_count), `${project.id}: ${project.task_count}`);
    }

    // Three created, one archived ⇒ three owned. The badge is "how many tasks does
    // this project have", not "how many the board is currently showing".
    assert.equal(projectBy(data, "busy").task_count, 3);

    // A project with no tasks reports 0 — never an absent field, which is what
    // would leave the row's badge empty.
    assert.equal(projectBy(data, "quiet").task_count, 0);
  });

  it("counts what the default task list hides", async () => {
    const listed = dataOf(await call("GET", "/api/v1/tasks?project_id=busy"));
    assert.equal(listed.tasks.length, 2, "the archived card is hidden from the list by default");

    const withArchived = dataOf(await call("GET", "/api/v1/tasks?project_id=busy&include_archived=1"));
    assert.equal(withArchived.tasks.length, 3);

    const projects = dataOf(await call("GET", "/api/v1/projects"));
    assert.equal(projectBy(projects, "busy").task_count, withArchived.tasks.length, "the count is the archived-inclusive one");
  });

  it("carries the same number on the single-project route", async () => {
    const one = dataOf(await call("GET", "/api/v1/projects/busy"));
    assert.equal(one.project.task_count, 3);

    // The read of an unknown project is still a `null` projection, not a stray
    // `task_count` — the early return must not change that (O3's shape).
    const missing = dataOf(await call("GET", "/api/v1/projects/nope"));
    assert.equal(missing.project, null);
  });

  it("is the project's own row count, not its activity or its rank", async () => {
    const data = dataOf(await call("GET", "/api/v1/projects?order_debug=1"));
    const debug = Object.fromEntries(data.order_debug.map((entry) => [entry.id, entry]));

    // The activity factor counts *events*: three creates plus the retire pair make
    // `a30` larger than the three tasks that exist — the two numbers are different
    // questions, and only `task_count` is the badge.
    assert.ok(debug.busy.factors.a30.raw > projectBy(data, "busy").task_count);

    // Every ranked entry carries its own count, whatever its position: the badge
    // is independent of the ordering, so the last row is as filled as the first.
    for (const project of data.projects) {
      assert.equal(typeof project.task_count, "number", `${project.id} (rank ${debug[project.id]?.order})`);
    }
    assert.equal(projectBy(data, "quiet").task_count, 0);
  });
});
