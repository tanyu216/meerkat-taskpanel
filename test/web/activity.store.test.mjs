/**
 * `stores/activity.js` — the ledger's own read, browser-free.
 *
 * The view's skeleton reads `activity.loading`, so that flag has to mean "the
 * ledger's read is in flight" and nothing else: it may not be cleared by a read
 * the store has already left behind (a project switch starts a second read
 * while the first is still in flight), and `resetActivity()` must invalidate
 * whatever is in the air.
 *
 * The backfill is one board-wide `GET /activities`; the feed scopes the rows to
 * the board's own task set at derivation, not at the read.
 *
 * Same harness as `board.store.test.mjs`: Vue is the in-repo shim, `fetch` is the
 * only stubbed boundary, and the store/service chain is the real one.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

register("./support/vue-loader.mjs", import.meta.url);

const { activity, feed, loadActivities, loadTaskActivities, resetActivity, writeActivityFilter } =
  await import("../../web/src/stores/activity.js");
const { board } = await import("../../web/src/stores/board.js");

/* --------------------------------------------------------------- harness */

/** Install a fake `fetch` routed by `"METHOD /path"` (query stripped); records calls. */
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ url, method });
    const handler = routes[`${method} ${url.split("?")[0]}`] ?? routes["*"];
    if (!handler) throw new Error(`unexpected request: ${method} ${url}`);
    return handler({ url, method });
  };
  return calls;
}

const ok = (data) => ({ status: 200, json: async () => ({ ok: true, data }) });

const wireTask = (identifier, projectId) => ({
  id: `td_${identifier}`,
  identifier,
  project_id: projectId,
  status: "todo",
  version: 1,
  title: identifier,
  labels: [],
});

const wireActivity = (id, taskId) => ({
  id,
  task_id: taskId,
  event: "task_created",
  changes: {},
  revision: id,
  actor_kind: "agent",
  actor_id: "codex",
  created_at: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  resetActivity();
  board.currentProjectId = null;
  board.tasks = [];
  board.loading = false;
  board.loaded = false;
});

/* ------------------------------------------------------------------ reads */

describe("web/activity — the ledger's loading window", () => {
  it("holds loading while the board-wide read is in flight", async () => {
    board.currentProjectId = "p1";
    board.loaded = true;
    board.tasks = [wireTask("TD-1", "p1")];

    let release;
    const calls = installFetch({
      "GET /api/v1/activities": () => new Promise((resolve) => (release = resolve)),
    });

    const pending = loadActivities();
    assert.equal(activity.loading, true, "the view shows its skeleton while this is true");
    assert.equal(activity.projectId, "p1");
    assert.match(calls[0].url, /^\/api\/v1\/activities\?/);
    assert.match(calls[0].url, /limit=1000/);

    release(ok({ activities: [wireActivity(1, "td_TD-1")] }));
    await pending;
    assert.equal(activity.loading, false);
    assert.equal(activity.loaded, true);
    assert.deepEqual(activity.entries.map((entry) => entry.id), [1]);
  });

  it("does not let a read for a project already left write the new ledger", async () => {
    board.currentProjectId = "p1";
    board.loaded = true;
    board.tasks = [wireTask("TD-1", "p1")];

    let releaseOld;
    let call = 0;
    installFetch({
      "GET /api/v1/activities": () => {
        call += 1;
        if (call === 1) return new Promise((resolve) => (releaseOld = resolve));
        return ok({ activities: [wireActivity(2, "td_TD-2")] });
      },
    });

    const old = loadActivities();

    board.currentProjectId = "p2";
    board.tasks = [wireTask("TD-2", "p2")];
    await loadActivities();
    assert.equal(activity.projectId, "p2");
    assert.equal(activity.loading, false);
    assert.deepEqual(activity.entries.map((entry) => entry.id), [2]);

    releaseOld(ok({ activities: [wireActivity(1, "td_TD-1")] }));
    await old;

    assert.equal(activity.projectId, "p2", "the ledger is still the new project's");
    assert.deepEqual(activity.entries.map((entry) => entry.id), [2], "the late read is dropped");
    assert.equal(activity.loading, false, "and it does not clear a flag it no longer owns");
  });

  it("does not leave the skeleton up when a project switch's two triggers overlap", async () => {
    // The view watches `[currentProjectId, tasks]`, so a switch fires twice: the
    // id changes first, then the task list lands. The second call runs while the
    // first project's read is still in flight; it must neither mistake the old
    // project's `loaded` for the new one's nor cancel that read's `finally`.
    board.currentProjectId = "p1";
    board.loaded = true;
    board.tasks = [wireTask("TD-1", "p1")];
    installFetch({
      "GET /api/v1/activities": () => ok({ activities: [wireActivity(1, "td_TD-1")] }),
    });
    await loadActivities();
    assert.equal(activity.loaded, true);

    let release;
    let p2Reads = 0;
    installFetch({
      "GET /api/v1/activities": () => {
        p2Reads += 1;
        return new Promise((resolve) => (release = resolve));
      },
    });

    board.currentProjectId = "p2";
    board.tasks = [];
    board.loaded = false;
    board.loading = true;
    const first = loadActivities();

    board.tasks = [wireTask("TD-2", "p2")];
    board.loaded = true;
    board.loading = false;
    const second = loadActivities();

    release(ok({ activities: [wireActivity(2, "td_TD-2")] }));
    await Promise.all([first, second]);

    assert.equal(p2Reads, 1, "one read per project switch, not two");
    assert.equal(activity.loading, false, "the skeleton comes down");
    assert.equal(activity.projectId, "p2");
    assert.equal(activity.loaded, true);
  });

  it("invalidates an in-flight read on reset", async () => {
    board.currentProjectId = "p1";
    board.loaded = true;
    board.tasks = [wireTask("TD-1", "p1")];

    let release;
    installFetch({
      "GET /api/v1/activities": () => new Promise((resolve) => (release = resolve)),
    });

    const pending = loadActivities();
    assert.equal(activity.loading, true);

    resetActivity();
    assert.equal(activity.loading, false, "the skeleton comes down with the reset");
    assert.deepEqual(activity.entries, []);

    release(ok({ activities: [wireActivity(1, "td_TD-1")] }));
    await pending;

    assert.deepEqual(activity.entries, [], "the stale read writes nothing");
    assert.equal(activity.projectId, null);
    assert.equal(activity.loading, false);
  });
});

/* ------------------------------------------------------- the task backfill */

describe("web/activity — the selected task's own history", () => {
  it("reads the task with task_id and merges it only while that task is filtered", async () => {
    board.tasks = [wireTask("TD-1", "p1"), wireTask("TD-2", "p1")];
    const calls = installFetch({
      "GET /api/v1/activities": ({ url }) =>
        url.includes("task_id=")
          ? ok({ activities: [wireActivity(10, "td_TD-1")] })
          : ok({ activities: [wireActivity(1, "td_TD-1")] }),
    });

    assert.deepEqual(await loadTaskActivities("TD-1"), { ok: true });
    assert.match(calls[0].url, /task_id=td_TD-1/, "the request names the task's internal id");
    assert.match(calls[0].url, /limit=1000/);
    assert.match(calls[0].url, /order=desc/);
    assert.deepEqual(activity.taskEntries["TD-1"].map((entry) => entry.id), [10]);
    assert.equal(feed.value.items.length, 0, "not merged while the filter is All tasks");

    writeActivityFilter("task", "TD-1");
    assert.deepEqual(feed.value.items.map((entry) => entry.id), [10], "merged while the task is selected");

    writeActivityFilter("task", "all");
    assert.equal(feed.value.items.length, 0, "All tasks is still the one board-wide ledger");
    writeActivityFilter("task", "all");
  });

  it("memoises a loaded task and never issues the request twice", async () => {
    board.tasks = [wireTask("TD-1", "p1")];
    const calls = installFetch({
      "GET /api/v1/activities": () => ok({ activities: [wireActivity(10, "td_TD-1")] }),
    });

    await loadTaskActivities("TD-1");
    const afterFirst = calls.length;
    assert.deepEqual(await loadTaskActivities("TD-1"), { ok: true, cached: true });
    assert.equal(calls.length, afterFirst, "a second selection is the cache");
  });

  it("drops a response whose project (or cache generation) has moved on", async () => {
    board.tasks = [wireTask("TD-1", "p1")];
    let release;
    installFetch({
      "GET /api/v1/activities": () => new Promise((resolve) => (release = resolve)),
    });

    const pending = loadTaskActivities("TD-1");
    resetActivity();
    board.tasks = [wireTask("TD-1", "p1")];
    release(ok({ activities: [wireActivity(10, "td_TD-1")] }));

    assert.deepEqual(await pending, { ok: false, stale: true });
    assert.deepEqual(activity.taskEntries, {}, "a read the store has left behind writes nothing");
  });

  it("reports a failure without clearing the ledger or caching the failure", async () => {
    board.tasks = [wireTask("TD-1", "p1")];
    activity.entries = [wireActivity(1, "td_TD-1")];
    installFetch({
      "GET /api/v1/activities": () => {
        throw new Error("offline");
      },
    });

    const failed = await loadTaskActivities("TD-1");
    assert.equal(failed.ok, false);
    assert.ok(failed.error);
    assert.deepEqual(activity.entries.map((entry) => entry.id), [1], "the loaded ledger survives");
    assert.deepEqual(activity.taskEntries, {}, "nothing is cached");
    assert.equal(activity.error, null, "a backfill failure is a toast, not the page's error state");

    installFetch({
      "GET /api/v1/activities": () => ok({ activities: [wireActivity(10, "td_TD-1")] }),
    });
    assert.deepEqual(await loadTaskActivities("TD-1"), { ok: true }, "the failure did not poison the cache");
  });

  it("does nothing for `all` or a task the board list does not hold", async () => {
    board.tasks = [wireTask("TD-1", "p1")];
    const calls = installFetch({
      "GET /api/v1/activities": () => ok({ activities: [] }),
    });
    assert.deepEqual(await loadTaskActivities("all"), { ok: false });
    assert.deepEqual(await loadTaskActivities("TD-999"), { ok: false });
    assert.equal(calls.length, 0);
  });

  it("clears the task cache on reset", async () => {
    board.tasks = [wireTask("TD-1", "p1")];
    let calls = installFetch({
      "GET /api/v1/activities": () => ok({ activities: [wireActivity(10, "td_TD-1")] }),
    });
    await loadTaskActivities("TD-1");
    assert.deepEqual(activity.taskEntries["TD-1"].map((entry) => entry.id), [10]);

    resetActivity();
    assert.deepEqual(activity.taskEntries, {});
    board.tasks = [wireTask("TD-1", "p1")];
    calls = installFetch({
      "GET /api/v1/activities": () => ok({ activities: [wireActivity(10, "td_TD-1")] }),
    });
    assert.deepEqual(await loadTaskActivities("TD-1"), { ok: true }, "a reset forgets the memo");
    assert.equal(calls.length, 1);
  });
});
