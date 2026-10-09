/**
 * `stores/board.js` — the working set (M6b · S3/S4), browser-free.
 *
 * Two rules the store exists to enforce, and both are exercised here through the
 * **real call chain**: the store calls the real `services/api.js`, which calls a
 * fake `fetch`; and it calls the real `services/events.js` with an injected
 * `EventSource`. Nothing inside `web/src` is stubbed — only the two external
 * boundaries (`fetch`, `EventSource`) and Vue's reactivity primitives
 * (`./support/vue-loader.mjs` explains why the last one is necessary). The
 * integration cases are store → service, never stub-to-stub.
 *
 *   1. **An optimistic move rolls back visibly.** The card flips immediately;
 *      a `409 VERSION_CONFLICT` reverts it and raises the sticky conflict panel;
 *      the write is *never* retried with a bumped version and the local row is
 *      *never* silently overwritten with the server's newer version.
 *   2. **The live cursor is a max.** An event raises `board.revision` to the
 *      frame's revision (never lower), and its scope decides incremental vs.
 *      full refresh.
 *
 * `mock.timers` is enabled so the store's toast lifetimes are deterministic and
 * no real timer outlives the suite (agent-card §⑥.1 #9: no leaked test resources).
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// Vue is aliased to an in-repo shim (the container ships no node_modules).
// `register` first, so every dynamic import below resolves through the hook.
register("./support/vue-loader.mjs", import.meta.url);

const { ApiError } = await import("../../web/src/services/api.js");
const { toasts } = await import("../../web/src/stores/ui.js");

/* --------------------------------------------------------------- harness */

let bust = 0;
/** A fresh board module (fresh `board` state and a fresh stream singleton). */
async function freshBoard() {
  bust += 1;
  return import(`../../web/src/stores/board.js?fresh=${bust}`);
}

/** Install a fake `fetch` routed by `"METHOD /path"` (query stripped); records calls. */
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const call = { url, method, body: options.body === undefined ? undefined : JSON.parse(options.body) };
    calls.push(call);
    const handler = routes[`${method} ${url.split("?")[0]}`] ?? routes["*"];
    if (!handler) throw new Error(`unexpected request: ${method} ${url}`);
    return handler(call, calls.length);
  };
  return calls;
}

const json = (status, body) => ({ status, json: async () => body });
const ok = (data, status = 200) => json(status, { ok: true, data });
const failure = (status, code, message = code, details) =>
  json(status, { ok: false, error: { code, message, http: status, details: details ?? {} } });
const conflict = (details) => failure(409, "VERSION_CONFLICT", "stale version", details);

function seedTask(board, over = {}) {
  const task = { id: "td_1", identifier: "TD-1", status: "todo", version: 3, title: "wire it", labels: [], ...over };
  board.tasks = [task];
  return task;
}

/** A hand-driven `EventSource`; `instances` holds every socket opened. */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.({ type: "error" });
  }
  emit(id, activity) {
    this.onmessage?.({ lastEventId: String(id), data: JSON.stringify(activity) });
  }
}

/** Let the store's `void`ed event handlers (refreshTask/load*) settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  toasts.value = [];
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource;
});

afterEach(() => {
  mock.timers.reset();
  toasts.value = [];
  FakeEventSource.instances = [];
  delete globalThis.fetch;
  delete globalThis.EventSource;
});

/* ------------------------------------------------------- optimistic move */

describe("web/board — optimistic move", () => {
  it("flips the card locally before the request settles, then adopts the server row", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    let release;
    const calls = installFetch({ "POST /api/v1/tasks/TD-1/move": () => new Promise((r) => (release = r)) });

    const pending = moveTask(board.tasks[0], "done");
    // The optimistic flip is synchronous: no await has run yet.
    assert.equal(board.tasks[0].status, "done");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { to: "done", if_version: 3 });

    release(ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 4, title: "wire it" } }));
    await pending;
    assert.equal(board.tasks[0].status, "done");
    assert.equal(board.tasks[0].version, 4);
  });

  it("sends the pre-move version as if_version (the whole point of the check)", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board, { version: 11 });
    const calls = installFetch({ "POST /api/v1/tasks/TD-1/move": () => ok({ task: { ...board.tasks[0], version: 12 } }) });
    await moveTask(board.tasks[0], "in_progress");
    assert.equal(calls[0].url, "/api/v1/tasks/TD-1/move");
    assert.equal(calls[0].body.if_version, 11);
  });

  it("toasts a normal target as success and a cancel/block target as danger", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": (call) => ok({ task: { id: "td_1", identifier: "TD-1", status: call.body.to, version: 4 } }) });

    await moveTask(board.tasks[0], "done");
    assert.equal(toasts.value.at(-1).kind, "success");
    assert.match(toasts.value.at(-1).text, /TD-1/);

    await moveTask(board.tasks[0], "canceled");
    assert.equal(toasts.value.at(-1).kind, "danger");
  });

  it("an auto-dismissing toast clears after its lifetime (no leaked timer)", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 4 } }) });
    await moveTask(board.tasks[0], "done");
    assert.equal(toasts.value.length, 1);

    mock.timers.tick(2500); // leaving
    mock.timers.tick(200); // then removed
    assert.equal(toasts.value.length, 0);
  });
});

/* ------------------------------------------- 409 rollback + conflict panel */

describe("web/board — 409 rollback and the conflict panel", () => {
  it("rolls the card back and raises the panel on VERSION_CONFLICT", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => conflict({ currentVersion: 5, expectedVersion: 3 }) });

    await assert.rejects(() => moveTask(board.tasks[0], "done"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.isVersionConflict, true);
      return true;
    });

    assert.equal(board.tasks[0].status, "todo"); // reverted, visibly
    assert.deepEqual(board.conflict, {
      identifier: "TD-1",
      expectedVersion: 3,
      currentVersion: 5,
      message: "stale version",
    });
  });

  it("the rollback leaves the local version untouched — nothing is silently overwritten", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board, { version: 3 });
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => conflict({ currentVersion: 5, expectedVersion: 3 }) });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));

    // The server's newer row (v5) was NOT adopted, and the local row was NOT bumped.
    assert.equal(board.tasks[0].version, 3);
    assert.equal(board.tasks[0].status, "todo");
    assert.equal(board.revision, 0);
  });

  it("never auto-retries with a bumped version — exactly one write is attempted", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    const calls = installFetch({ "POST /api/v1/tasks/TD-1/move": () => conflict({ currentVersion: 5, expectedVersion: 3 }) });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { to: "done", if_version: 3 }); // original, not the server's 5
  });

  it("raises a sticky conflict toast that survives the toast lifetime", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => conflict() });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));

    assert.equal(toasts.value.length, 1);
    assert.equal(toasts.value[0].kind, "danger");
    mock.timers.tick(60_000);
    assert.equal(toasts.value.length, 1, "a conflict toast is never auto-dismissed");
    assert.ok(board.conflict, "and the panel stays up");
  });

  it("falls back to the base version when the server omits conflict details", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => failure(409, "VERSION_CONFLICT", "stale") });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));

    assert.equal(board.conflict.expectedVersion, 3);
    assert.equal(board.conflict.currentVersion, null);
  });

  it("reloadConflict clears the panel and re-reads the task — the only offered recovery", async () => {
    const { board, reloadConflict } = await freshBoard();
    seedTask(board);
    board.conflict = { identifier: "TD-1", expectedVersion: 3, currentVersion: 5, message: "stale" };
    installFetch({
      "GET /api/v1/tasks/TD-1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "in_progress", version: 5 } }),
    });

    await reloadConflict();
    assert.equal(board.conflict, null);
    assert.equal(board.tasks[0].version, 5);
    assert.equal(board.tasks[0].status, "in_progress");
  });

  it("reloadConflict with no panel open is a no-op (no request)", async () => {
    const { board, reloadConflict } = await freshBoard();
    seedTask(board);
    const calls = installFetch({});
    await reloadConflict();
    assert.equal(board.conflict, null);
    assert.equal(calls.length, 0);
  });

  it("a recovery move after a reload succeeds and clears the panel", async () => {
    const { board, reloadConflict, moveTask } = await freshBoard();
    seedTask(board);
    board.conflict = { identifier: "TD-1", expectedVersion: 3, currentVersion: 5, message: "stale" };
    installFetch({
      "GET /api/v1/tasks/TD-1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "todo", version: 5 } }),
      "POST /api/v1/tasks/TD-1/move": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 6 } }),
    });
    await reloadConflict();
    await moveTask(board.tasks[0], "done");
    assert.equal(board.conflict, null);
    assert.equal(board.tasks[0].version, 6);
  });
});

/* ------------------------------------------------------ other move errors */

describe("web/board — move failures other than a conflict", () => {
  it("REPORT_REQUIRED rolls back and explains the gate, without a conflict panel", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => failure(422, "REPORT_REQUIRED", "a report is required") });
    await assert.rejects(() => moveTask(board.tasks[0], "in_review"));

    assert.equal(board.tasks[0].status, "todo");
    assert.equal(board.conflict, null);
    assert.match(toasts.value.at(-1).text, /TD-1/);
    assert.equal(toasts.value.at(-1).kind, "danger");
  });

  it("INVALID_TRANSITION and TERMINAL_STATE roll back to the move-failed toast", async () => {
    for (const code of ["INVALID_TRANSITION", "TERMINAL_STATE"]) {
      const { board, moveTask } = await freshBoard();
      seedTask(board);
      toasts.value = [];
      installFetch({ "POST /api/v1/tasks/TD-1/move": () => failure(422, code) });
      await assert.rejects(() => moveTask(board.tasks[0], "done"));
      assert.equal(board.tasks[0].status, "todo");
      assert.equal(board.conflict, null);
      assert.equal(toasts.value.length, 1);
      assert.equal(toasts.value[0].kind, "danger");
    }
  });

  it("an unknown failure surfaces its own message and still rolls back", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => failure(500, "INTERNAL", "the disk is on fire") });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));
    assert.equal(board.tasks[0].status, "todo");
    assert.equal(toasts.value.at(-1).text, "the disk is on fire");
  });
});

/* ------------------------------------------------------------ move guards */

describe("web/board — move guards", () => {
  it("a move to the current status is a no-op with no request", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board, { status: "todo" });
    const calls = installFetch({});
    assert.equal(await moveTask(board.tasks[0], "todo"), undefined);
    assert.equal(calls.length, 0);
    assert.equal(board.tasks[0].status, "todo");
  });

  it("a target that is not one of the seven statuses is refused", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    const calls = installFetch({});
    await moveTask(board.tasks[0], "archived");
    assert.equal(calls.length, 0);
    assert.equal(board.tasks[0].status, "todo");
  });

  it("a move while the board is loading is refused, then allowed once loaded", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    const calls = installFetch({ "POST /api/v1/tasks/TD-1/move": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 4 } }) });

    board.loading = true;
    await moveTask(board.tasks[0], "done");
    assert.equal(calls.length, 0);
    assert.equal(board.tasks[0].status, "todo");

    board.loading = false;
    await moveTask(board.tasks[0], "done");
    assert.equal(calls.length, 1);
    assert.equal(board.tasks[0].status, "done");
  });
});

/* ------------------------------------------- events → store (global_revision) */

describe("web/board — the live stream drives the revision", () => {
  it("a task-scoped event refreshes just that task and raises the revision", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    const calls = installFetch({ "GET /api/v1/tasks/td_1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "todo", version: 9 } }) });

    startEvents();
    FakeEventSource.instances.at(-1).emit(12, { event: "task_updated", task_id: "td_1" });
    await settle();

    assert.equal(board.revision, 12);
    assert.equal(board.tasks[0].version, 9);
    // Incremental: one task read, no full board reload.
    assert.deepEqual(calls.map((c) => c.url), ["/api/v1/tasks/td_1"]);
  });

  it("a project-level event reloads projects and tasks (a full refresh)", async () => {
    const { board, startEvents } = await freshBoard();
    board.currentProjectId = "p1"; // a board that already has a project selected
    const calls = installFetch({
      "GET /api/v1/projects": () => ok({ projects: [{ id: "p1", name: "Proj" }], order_debug: [{ id: "p1", score: 7, rank: 1 }] }),
      "GET /api/v1/tasks": () => ok({ tasks: [{ id: "td_9", identifier: "TD-9", status: "todo", version: 1 }] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(13, { event: "project_updated", task_id: null });
    await settle();

    assert.equal(board.revision, 13);
    assert.ok(calls.some((c) => c.url.startsWith("/api/v1/projects")));
    assert.ok(calls.some((c) => c.url.startsWith("/api/v1/tasks?project_id=p1")));
    assert.equal(board.tasks[0].identifier, "TD-9");
  });

  it("a project-level event on a board with no project selected fetches no task list", async () => {
    const { board, startEvents } = await freshBoard();
    const calls = installFetch({ "GET /api/v1/projects": () => ok({ projects: [] }) });

    startEvents();
    FakeEventSource.instances.at(-1).emit(9, { event: "schema", task_id: null });
    await settle();
    // `loadTasks` short-circuits without a project id — the tasks request never fires.
    assert.ok(!calls.some((c) => c.url.startsWith("/api/v1/tasks?")));
    assert.equal(board.revision, 9);
  });

  it("the revision is a max — a stale replay never lowers it", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    installFetch({ "GET /api/v1/tasks/td_1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "todo", version: 4 } }) });
    board.revision = 20;

    startEvents();
    FakeEventSource.instances.at(-1).emit(7, { event: "task_updated", task_id: "td_1" });
    await settle();
    assert.equal(board.revision, 20);
  });

  it("an incoming event does not clear an open conflict panel", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    installFetch({ "GET /api/v1/tasks/td_1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 9 } }) });
    board.conflict = { identifier: "TD-1", expectedVersion: 3, currentVersion: 5, message: "stale" };

    startEvents();
    FakeEventSource.instances.at(-1).emit(21, { event: "task_updated", task_id: "td_1" });
    await settle();
    assert.ok(board.conflict, "a live event must not dismiss the conflict panel");
  });

  it("refreshes the open task's comments when that task changes", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    board.detail = { task: { id: "td_1", identifier: "TD-1" }, comments: [] };
    installFetch({
      "GET /api/v1/tasks/td_1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "todo", version: 9 } }),
      "GET /api/v1/tasks/TD-1/comments": () => ok({ comments: [{ id: "c1", body: "hi" }] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(14, { event: "task_updated", task_id: "td_1" });
    await settle();
    assert.equal(board.detail.comments.length, 1);
  });

  it("surfaces the connection status on the board", async () => {
    const { board, startEvents } = await freshBoard();
    installFetch({});
    startEvents();
    const socket = FakeEventSource.instances.at(-1);
    socket.open();
    assert.equal(board.connection, "open");
    socket.fail();
    assert.equal(board.connection, "connecting");
  });

  it("startEvents is idempotent — one socket, not a new one per call", async () => {
    const { startEvents } = await freshBoard();
    installFetch({});
    const first = startEvents();
    const second = startEvents();
    assert.equal(first, second);
    assert.equal(FakeEventSource.instances.length, 1);
  });

  it("resync without a client opens the stream and pushes no toast", async () => {
    const { board, resync } = await freshBoard();
    installFetch({});
    resync();
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(toasts.value.length, 0);
    assert.equal(board.connection, "connecting");
  });

  it("resync with a client reconnects from the cursor and confirms with a toast", async () => {
    const { resync, startEvents } = await freshBoard();
    installFetch({ "GET /api/v1/tasks/td_1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "todo", version: 2 } }) });
    startEvents();
    const first = FakeEventSource.instances.at(-1);
    first.emit(8, { event: "task_updated", task_id: "td_1" });
    await settle();

    resync();
    const second = FakeEventSource.instances.at(-1);
    assert.equal(first.closed, true);
    assert.equal(second.url, "/api/v1/events?after=8");
    assert.equal(toasts.value.at(-1).kind, "info");
    assert.equal(toasts.value.at(-1).text, "Board resynced");
  });
});

/* -------------------------------------------------------------------- loads */

describe("web/board — loads", () => {
  it("loadTasks with no current project clears the list and issues no request", async () => {
    const { board, loadTasks } = await freshBoard();
    board.currentProjectId = null;
    board.tasks = [{ id: "old" }];
    const calls = installFetch({});
    await loadTasks();
    assert.deepEqual(board.tasks, []);
    assert.equal(calls.length, 0);
  });

  it("loadProjects adopts the first project when the current one disappears, and keys orderDebug by id", async () => {
    const { board, loadProjects } = await freshBoard();
    board.currentProjectId = "gone";
    installFetch({
      "GET /api/v1/projects": () =>
        ok({ projects: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }], order_debug: [{ id: "p2", score: 3, rank: 1 }] }),
    });
    await loadProjects();
    assert.equal(board.currentProjectId, "p1");
    assert.equal(board.orderDebug.p2.score, 3);
  });

  it("loadProjects keeps the current project when it is still present", async () => {
    const { board, loadProjects } = await freshBoard();
    board.currentProjectId = "p2";
    installFetch({ "GET /api/v1/projects": () => ok({ projects: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }] }) });
    await loadProjects();
    assert.equal(board.currentProjectId, "p2");
  });

  it("loadBoard records and rethrows a load failure, and clears the loading flag", async () => {
    const { board, loadBoard } = await freshBoard();
    installFetch({ "GET /api/v1/projects": () => failure(500, "INTERNAL", "boom") });
    await assert.rejects(() => loadBoard(), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "INTERNAL");
      return true;
    });
    assert.ok(board.error instanceof ApiError, "board.error carries the failure for the shell to render");
    assert.equal(board.error.code, "INTERNAL");
    assert.equal(board.loading, false);
  });

  it("refreshTask swallows a task that vanished mid-flight", async () => {
    const { board, refreshTask } = await freshBoard();
    seedTask(board, { version: 3 });
    installFetch({ "GET /api/v1/tasks/TD-1": () => failure(404, "NOT_FOUND", "gone") });
    await refreshTask("TD-1"); // resolves, does not throw
    assert.equal(board.tasks[0].version, 3);
  });
});

/* ------------------------------------------------------------------ filters */

describe("web/board — filtered board (visible branches)", () => {
  const tasks = [
    { id: "1", identifier: "TD-1", title: "Wire the board", status: "todo", priority: "high", labels: ["UI"], assignee: { display_name: "Terry", kind: "human" } },
    { id: "2", identifier: "TD-2", title: "Ship it", status: "done", priority: "urgent", labels: ["infra"], assignee: { display_name: "elon", kind: "agent" } },
    { id: "3", identifier: "TD-3", title: "No priority", status: "todo", labels: [], assignee: null },
  ];

  it("filters by free-text over identifier, title and labels", async () => {
    const { board, visibleTasks } = await freshBoard();
    board.tasks = tasks;
    board.filters.search = "infra";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-2"]);
    board.filters.search = "TD-3";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-3"]);
    board.filters.search = "  ";
    assert.equal(visibleTasks.value.length, 3, "a blank search is no filter");
  });

  it("filters by assignee kind, including the human 'me' row", async () => {
    const { board, visibleTasks } = await freshBoard();
    board.tasks = tasks;
    board.filters.assignee = "me";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1"]);
    board.filters.assignee = "agent";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-2"]);
    board.filters.assignee = "human";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1"]);
  });

  it("treats a missing or unknown priority as 'none'", async () => {
    const { board, visibleTasks, priorityOf } = await freshBoard();
    board.tasks = tasks;
    assert.equal(priorityOf(tasks[2]), "none");
    assert.equal(priorityOf({ priority: "bogus" }), "none");
    board.filters.priority = "none";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-3"]);
  });

  it("matches labels case-insensitively and counts active filters", async () => {
    const { board, visibleTasks, activeFilterCount } = await freshBoard();
    board.tasks = tasks;
    board.filters.label = "ui";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1"]);
    assert.equal(activeFilterCount.value, 1);
    board.filters.priority = "high";
    assert.equal(activeFilterCount.value, 2);
    assert.equal(visibleTasks.value.length, 1);
  });

  it("groups the visible tasks into the seven board columns", async () => {
    const { board, columns } = await freshBoard();
    board.tasks = tasks;
    assert.equal(columns.value.length, 7);
    assert.deepEqual(columns.value.find((c) => c.status === "todo").tasks.map((t) => t.identifier), ["TD-1", "TD-3"]);
    assert.deepEqual(columns.value.find((c) => c.status === "done").tasks.map((t) => t.identifier), ["TD-2"]);
    assert.deepEqual(columns.value.find((c) => c.status === "blocked").tasks, []);
  });
});
