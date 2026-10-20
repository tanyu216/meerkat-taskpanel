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
// The one vocabulary a refusal is rendered through (T-20261014-152924 ④); pure,
// so the expected sentence is read from it rather than typed out twice.
const { GENERIC_ERROR_KEY, errorText, errorTextKey, resolveText } = await import("../../web/src/i18n/messages.mjs");

/** What an unmapped code shows, in the default language. */
const GENERIC_ERROR_SENTENCE = resolveText("en", GENERIC_ERROR_KEY);

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
    // T-20261014-152924 ④ — the panel carries the two versions and the ref. It
    // used to also carry the wire's `message`; a reader gets the board's own
    // sentence instead (`conflict.hint`), so the server's prose is not copied
    // into component state at all.
    assert.deepEqual(board.conflict, {
      identifier: "TD-1",
      expectedVersion: 3,
      currentVersion: 5,
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
    board.conflict = { identifier: "TD-1", expectedVersion: 3, currentVersion: 5 };
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
    board.conflict = { identifier: "TD-1", expectedVersion: 3, currentVersion: 5 };
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

  it("an unmapped code falls back to the generic sentence, never to the wire's message", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    const wire = "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'";
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => failure(500, "INTERNAL", wire) });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));
    assert.equal(board.tasks[0].status, "todo");
    const text = toasts.value.at(-1).text;
    assert.equal(text, GENERIC_ERROR_SENTENCE);
    assert.equal(text.includes("constraint"), false, "the storage engine's words are not shown");
    assert.equal(text.includes(wire), false);
  });

  it("renders a known code as the board's own sentence, in the active language", async () => {
    const { board, moveTask } = await freshBoard();
    seedTask(board);
    installFetch({ "POST /api/v1/tasks/TD-1/move": () => failure(409, "not_assignee", "task is assigned to somebody else") });
    await assert.rejects(() => moveTask(board.tasks[0], "done"));
    assert.equal(toasts.value.at(-1).text, errorText("en", { code: "not_assignee" }, ["TD-1"]));
    // ...and the sentence is bilingual: the same code in zh is the zh string,
    // which is the half a reader of the board actually needs.
    assert.equal(errorText("zh", { code: "not_assignee" }, ["TD-1"]), `TD-1 已指派给他人。`);
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
    mock.timers.tick(100);
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
      "GET /api/v1/actors": () => ok({ entries: [] }),
      "GET /api/v1/labels": () => ok({ labels: [] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(13, { event: "project_updated", task_id: null });
    mock.timers.tick(250);
    await settle();

    assert.equal(board.revision, 13);
    assert.ok(calls.some((c) => c.url.startsWith("/api/v1/projects")));
    assert.ok(calls.some((c) => c.url.startsWith("/api/v1/tasks?project_id=p1")));
    assert.equal(board.tasks[0].identifier, "TD-9");
  });

  it("a project-level event on a board with no project selected fetches no task list", async () => {
    const { board, startEvents } = await freshBoard();
    const calls = installFetch({
      "GET /api/v1/projects": () => ok({ projects: [] }),
      "GET /api/v1/actors": () => ok({ entries: [] }),
      "GET /api/v1/labels": () => ok({ labels: [] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(9, { event: "schema", task_id: null });
    mock.timers.tick(250);
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
    mock.timers.tick(100);
    await settle();
    assert.equal(board.revision, 20);
  });

  it("an incoming event does not clear an open conflict panel", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    installFetch({ "GET /api/v1/tasks/td_1": () => ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 9 } }) });
    board.conflict = { identifier: "TD-1", expectedVersion: 3, currentVersion: 5 };

    startEvents();
    FakeEventSource.instances.at(-1).emit(21, { event: "task_updated", task_id: "td_1" });
    mock.timers.tick(100);
    await settle();
    assert.ok(board.conflict, "a live event must not dismiss the conflict panel");
  });

  it("refreshes the open task's comments when that task changes", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    board.detail = { task: { id: "td_1", identifier: "TD-1" }, comments: [] };
    installFetch({
      "GET /api/v1/tasks/TD-1/comments": () => ok({ comments: [{ id: "c1", body: "hi" }] }),
      "GET /api/v1/tasks/TD-1/activities": () => ok({ activities: [] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(14, { event: "comment_added", task_id: "td_1" });
    mock.timers.tick(100);
    await settle();
    assert.equal(board.detail.comments.length, 1);
  });

  it("invalidates and re-reads a waiting payload when the card's question can change", async () => {
    const { board, startEvents } = await freshBoard();
    board.tasks = [{ id: "td_1", identifier: "TD-1", status: "awaiting", version: 1, title: "waiting", labels: [] }];
    board.waitingPayload = { td_1: { body: "old question" } };
    const calls = installFetch({
      "GET /api/v1/tasks/TD-1/comments": () => ok({ comments: [{ id: "c1", body: "new question", author_kind: "human" }] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(15, { event: "comment_added", task_id: "td_1" });
    await settle();

    assert.equal(calls.filter((call) => call.url.includes("/comments")).length, 1, "one re-read, not none");
    assert.equal(board.waitingPayload.td_1.body, "new question");
  });

  it("removes an archived card from the board", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    installFetch({
      "GET /api/v1/tasks/td_1": () =>
        ok({ task: { id: "td_1", identifier: "TD-1", status: "done", version: 10, archived_at: "2026-10-19T00:00:00.000Z" } }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(16, { event: "task_archived", task_id: "td_1" });
    mock.timers.tick(100);
    await settle();

    assert.deepEqual(board.tasks, [], "an archived card is not a board card");
  });

  it("refreshes an open drawer's relations when a relation changes", async () => {
    const { board, startEvents } = await freshBoard();
    seedTask(board);
    board.detail = {
      task: { id: "td_1", identifier: "TD-1" },
      relations: { parent_chain: [] },
      activities: [],
    };
    installFetch({
      "GET /api/v1/tasks/TD-1/relations": () => ok({ parent_chain: ["TD-2"] }),
      "GET /api/v1/tasks/TD-1/activities": () => ok({ activities: [] }),
    });

    startEvents();
    FakeEventSource.instances.at(-1).emit(17, {
      event: "relation_added",
      task_id: "td_1",
      changes: { source: "td_2", target: "td_1" },
    });
    mock.timers.tick(100);
    await settle();

    assert.deepEqual(board.detail.relations.parent_chain, ["TD-2"]);
  });

  it("seeds the first stream from /meta.revision instead of replaying from zero", async () => {
    const { board, initBoard } = await freshBoard();
    installFetch({
      "GET /meta": () => ok({ revision: 42 }),
      "GET /api/v1/projects": () => ok({ projects: [{ id: "p1", name: "P" }] }),
      "GET /api/v1/tasks": () => ok({ tasks: [] }),
      "GET /api/v1/actors": () => ok({ entries: [] }),
      "GET /api/v1/labels": () => ok({ labels: [] }),
    });

    await initBoard();
    await settle();

    assert.equal(board.revision, 42);
    assert.equal(FakeEventSource.instances.at(-1).url, "/api/v1/events?after=42");
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
    mock.timers.tick(100);
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

  /**
   * R10 ① / T-20261013-160505 — "no card is visible" and "this board is empty" are
   * two different statements, and only the second one may show the view's
   * no-results block. Before the fix the board view read the count alone, so
   * **every cold paint** announced "No tasks match your filters" — with a
   * Clear-filters button — until the cards arrived.
   */
  it("does not call a board empty before it has read one, and withdraws the reading on a project switch", async () => {
    const { board, boardEmpty, loadTasks, selectProject } = await freshBoard();
    board.currentProjectId = "p1";

    assert.equal(board.loaded, false, "nothing has been read");
    assert.equal(boardEmpty.value, false, "0 visible cards is not yet a finding");

    // A read that lands with nothing in it is the finding.
    const calls = installFetch({ "GET /api/v1/tasks": () => ok({ tasks: [] }) });
    await loadTasks();
    assert.equal(calls.length, 1);
    assert.equal(board.loaded, true);
    assert.equal(boardEmpty.value, true);

    // …and a switch to another project withdraws it until *that* project's read
    // lands: one project's reading never describes another.
    await selectProject("p2");
    assert.equal(board.loaded, true, "the second project's read landed too");
    assert.equal(boardEmpty.value, true, "it is empty because it was read, not because nothing was");

    // A failed read is not a reading: the error surface speaks, the board does not
    // claim emptiness on top of it.
    board.loaded = false;
    installFetch({ "GET /api/v1/tasks": () => failure(500, "INTERNAL", "boom") });
    await assert.rejects(() => loadTasks());
    assert.equal(board.loaded, false);
    assert.equal(boardEmpty.value, false);
  });
});

/* ------------------------------------------------------- loading the board */
/*
 * The skeleton screens read one signal: "the current project's read is in
 * flight". These cases pin the signal and the concurrency rules it needs to be
 * honest — a stale response from a project already left must never repaint the
 * new project or clear its loading flag.
 */
describe("web/board — the loading window", () => {
  it("reports projectLoading while a switched project's read is in flight", async () => {
    const { board, projectLoading, selectProject } = await freshBoard();
    board.currentProjectId = "p1";
    board.tasks = [{ id: "old", project_id: "p1" }];
    board.loaded = true;

    let release;
    const calls = installFetch({
      "GET /api/v1/tasks": () => new Promise((resolve) => (release = resolve)),
    });

    const pending = selectProject("p2");
    assert.equal(board.currentProjectId, "p2");
    assert.equal(board.loaded, false, "the previous reading was withdrawn");
    assert.deepEqual(board.tasks, [], "the previous project's cards are gone at once");
    assert.equal(board.loading, true);
    assert.equal(projectLoading.value, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /project_id=p2/);

    release(ok({ tasks: [{ id: "t2", project_id: "p2" }] }));
    await pending;
    assert.equal(board.loading, false);
    assert.equal(board.loaded, true);
    assert.equal(projectLoading.value, false);
    assert.deepEqual(board.tasks.map((task) => task.id), ["t2"]);
  });

  it("treats a press on the project already in force as a no-op", async () => {
    const { board, projectLoading, selectProject } = await freshBoard();
    board.currentProjectId = "p1";
    board.tasks = [{ id: "keep", project_id: "p1" }];
    board.loaded = true;
    const calls = installFetch({});

    await selectProject("p1");
    assert.equal(calls.length, 0, "no read is issued");
    assert.deepEqual(board.tasks.map((task) => task.id), ["keep"]);
    assert.equal(board.loaded, true);
    assert.equal(projectLoading.value, false);
  });

  it("ignores a late response for a project the board has already left", async () => {
    const { board, projectLoading, selectProject } = await freshBoard();
    board.currentProjectId = "p1";
    board.loaded = true;

    const releases = {};
    installFetch({
      "GET /api/v1/tasks": (call) =>
        new Promise((resolve) => {
          // `call.url` is the app's own relative URL (`/api/v1/tasks?project_id=…`).
          releases[new URL(call.url, "http://board.test").searchParams.get("project_id")] = resolve;
        }),
    });

    const toP2 = selectProject("p2");
    const toP3 = selectProject("p3");

    // p3 lands first: it is the current project, so it owns the board.
    releases.p3(ok({ tasks: [{ id: "t3", project_id: "p3" }] }));
    await toP3;
    assert.equal(board.loaded, true);
    assert.equal(board.loading, false);
    assert.equal(projectLoading.value, false);

    // …and p2's stale response arrives afterwards: it must change nothing.
    releases.p2(ok({ tasks: [{ id: "t2", project_id: "p2" }] }));
    await toP2;
    assert.deepEqual(board.tasks.map((task) => task.id), ["t3"]);
    assert.equal(board.loaded, true);
    assert.equal(board.loading, false);
    assert.equal(projectLoading.value, false);
  });

  it("leaves no previous project's cards behind when a switch read fails", async () => {
    const { board, projectLoading, selectProject } = await freshBoard();
    board.currentProjectId = "p1";
    board.tasks = [{ id: "old", project_id: "p1" }];
    board.loaded = true;
    installFetch({ "GET /api/v1/tasks": () => failure(500, "INTERNAL", "boom") });

    await assert.rejects(() => selectProject("p2"));
    assert.deepEqual(board.tasks, [], "the failed switch does not resurrect the old cards");
    assert.equal(board.loaded, false);
    assert.equal(board.loading, false);
    assert.equal(projectLoading.value, false);
    assert.ok(board.error instanceof ApiError, "the shell's B17 surface carries the failure");
  });

  it("counts the comments read a waiting row is missing", async () => {
    const { board, loadWaitingPayloads } = await freshBoard();
    seedTask(board, { status: "awaiting", awaiting_reason: "E1" });

    let release;
    installFetch({
      "GET /api/v1/tasks/TD-1/comments": () => new Promise((resolve) => (release = resolve)),
    });

    const pending = loadWaitingPayloads();
    assert.equal(board.waitingPending, 1);
    release(ok({ comments: [{ author_kind: "human", body: "?", created_at: "2026-01-01T00:00:00Z" }] }));
    await pending;
    assert.equal(board.waitingPending, 0);
  });
});

/* --------------------------------------------------------- the open drawer */

/** Every read `openDetail()` fans out, happy-path. */
function detailRoutes(ref, task) {
  return {
    [`GET /api/v1/tasks/${ref}`]: () => ok({ task }),
    [`GET /api/v1/tasks/${ref}/relations`]: () => ok({ relations: [] }),
    [`GET /api/v1/tasks/${ref}/activities`]: () => ok({ activities: [] }),
    [`GET /api/v1/tasks/${ref}/sessions`]: () => ok({ sessions: [] }),
    [`GET /api/v1/tasks/${ref}/reports`]: () => ok({ reports: [] }),
    [`GET /api/v1/tasks/${ref}/comments`]: () => ok({ comments: [] }),
    [`GET /api/v1/tasks/${ref}/attachments`]: () => ok({ attachments: [] }),
  };
}

const wireTask = (identifier, over = {}) => ({
  id: `td_${identifier}`,
  identifier,
  project_id: "p1",
  status: "todo",
  version: 1,
  title: identifier,
  labels: [],
  ...over,
});

describe("web/board — opening the detail drawer", () => {
  it("opens the panel before the card's read lands", async () => {
    const { board, openDetail } = await freshBoard();
    board.currentProjectId = "p1";

    let release;
    installFetch({
      ...detailRoutes("TD-1", wireTask("TD-1")),
      "GET /api/v1/tasks/TD-1": () => new Promise((resolve) => (release = resolve)),
    });

    const pending = openDetail("TD-1");
    assert.equal(board.drawerState, "open", "the panel slides in immediately");
    assert.equal(board.detail, null, "…with no content yet — the view shows its skeleton");
    assert.equal(board.selectedRef, "TD-1");

    release(ok({ task: wireTask("TD-1") }));
    await pending;
    assert.equal(board.detail.task.identifier, "TD-1");
  });

  it("does not let a late card read replace the card opened after it", async () => {
    const { board, openDetail } = await freshBoard();
    board.currentProjectId = "p1";

    let releaseOne;
    installFetch({
      ...detailRoutes("TD-1", wireTask("TD-1")),
      ...detailRoutes("TD-2", wireTask("TD-2")),
      "GET /api/v1/tasks/TD-1": () => new Promise((resolve) => (releaseOne = resolve)),
    });

    const first = openDetail("TD-1");
    await openDetail("TD-2");
    assert.equal(board.detail.task.identifier, "TD-2");

    releaseOne(ok({ task: wireTask("TD-1") }));
    await first;

    assert.equal(board.selectedRef, "TD-2", "the reader is still on the second card");
    assert.equal(board.detail.task.identifier, "TD-2", "the late read is dropped");
  });
});

/* ------------------------------------------------ the drawer's prerequisite list */

/**
 * T-20261015-104813 / T-20261015-132952 — the `depends_on` picker must not offer
 * the open card's own parent chain, nor the open card itself.
 *
 * The board refuses a prerequisite two ways: an ancestor↔descendant edge is
 * `RELATION_CYCLE` (`0019_block_chain.sql`), and a self-edge is `SELF_REFERENCE`
 * (`domain/relation.mjs#normalizeRelation`). Both reach the drawer's write path,
 * so neither may be offered. These readings are the store half: the chain comes
 * off the card's own relations read (`parent_chain`, the board's answer), the
 * self half is the id the drawer is open on, and the roster it filters is keyed
 * by task id — so an id/identifier mismatch would show up here as a chain that
 * filters nothing.
 */
describe("web/board — the drawer's prerequisite candidates", () => {
  const tasks = [
    { id: "id-epic", identifier: "TD-E", title: "Epic", status: "todo", labels: [] },
    { id: "id-child", identifier: "TD-C", title: "Child", status: "todo", labels: [] },
    { id: "id-grand", identifier: "TD-G", title: "Grandchild", status: "todo", labels: [] },
    { id: "id-sib", identifier: "TD-S", title: "Sibling", status: "todo", labels: [] },
    { id: "id-stranger", identifier: "TD-X", title: "Stranger", status: "todo", labels: [] },
  ];

  it("leaves out the ancestors and the descendants, and keeps the rest", async () => {
    const { board, dependsCandidates } = await freshBoard();
    board.tasks = tasks;
    // The child's chain: its parent above it, its own child below it. Its own row
    // is gone too — `SELF_REFERENCE`, not `RELATION_CYCLE`, but the same answer.
    board.detail = { task: tasks[1], relations: { parent_chain: ["id-epic", "id-grand"] } };
    assert.deepEqual(dependsCandidates.value.map((entry) => entry.identifier), ["TD-S", "TD-X"]);
  });

  it("leaves the open card out even when it has no chain at all", async () => {
    const { board, dependsCandidates } = await freshBoard();
    board.tasks = tasks;
    // The common case: a fresh card with no relations reads an empty chain, so
    // the chain half subtracts nothing and only the self half can bite. Before
    // T-20261015-132952 the card's own row was offered here.
    board.detail = { task: tasks[0], relations: { parent_chain: [] } };
    assert.deepEqual(dependsCandidates.value.map((entry) => entry.identifier), ["TD-C", "TD-G", "TD-S", "TD-X"]);
    // No `parent_chain` at all — a board that predates the field — subtracts the
    // same one row.
    board.detail = { task: tasks[0], relations: {} };
    assert.deepEqual(dependsCandidates.value.map((entry) => entry.identifier), ["TD-C", "TD-G", "TD-S", "TD-X"]);
  });

  it("offers the whole roster when there is no card open to subtract", async () => {
    const { board, dependsCandidates } = await freshBoard();
    board.tasks = tasks;
    // Nothing open, nothing to subtract: the filter is a subtraction, so
    // "nothing to subtract" is the old behaviour.
    board.detail = null;
    assert.equal(dependsCandidates.value.length, 5);
  });

  it("keeps the roster's own shape — identifier, title, and the id the chain is keyed by", async () => {
    const { board, dependsCandidates } = await freshBoard();
    board.tasks = tasks;
    const entry = dependsCandidates.value.find((row) => row.identifier === "TD-X");
    assert.deepEqual(entry, { id: "id-stranger", name: "TD-X", identifier: "TD-X", title: "Stranger", keys: ["TD-X", "Stranger"] });
  });
});

/* ------------------------------------------------------------------ filters */

/* ------------------------------- the refusal's shape survives to the sentence */

/**
 * T-20261015-175921 — the `depends_on` write, from the board's own refusal to the
 * sentence the drawer shows.
 *
 * The server refuses an ancestor↔descendant edge with `RELATION_CYCLE` **and**
 * `details.chain = "ancestor"` (`domain/relation.mjs#assertBlockEdgeAllowed`), and
 * `errorTextKey` reads that field before the flat code table. The body below is a
 * wire body copied verbatim from a live `POST /api/v1/tasks/:ref/relations`.
 *
 * What this pins is the seam the drawer's call sites stand on: the store hands
 * `runCommit` the error `services/api.js` built, and that error still carries the
 * envelope's own `details` — so the shape reaches the sentence without any call
 * site knowing about it. Also the non-regression: the same code *without* the
 * field is still the loop's sentence, which is what a board that predates the
 * field answers.
 */
describe("web/board — a refusal's shape reaches the sentence", () => {
  const REFUSAL = {
    ok: false,
    error: {
      code: "RELATION_CYCLE",
      message: "an ancestor and a descendant cannot depend on each other: PROJ-0002 and PROJ-0001 are on one parent chain",
      http: 422,
      details: { source: "id-child", target: "id-epic", type: "blocks", chain: "ancestor" },
      hint: null,
    },
  };

  /** The drawer's own write, with the board answering the way it really does. */
  async function refuseAddDepends() {
    const { board, addDepends } = await freshBoard();
    board.tasks = [{ id: "id-epic", identifier: "TD-E", title: "Epic", status: "todo", labels: [] }];
    board.detail = { task: { id: "id-child", identifier: "TD-C" }, relations: { parent_chain: [] } };
    installFetch({ "POST /api/v1/tasks/id-epic/relations": () => json(422, REFUSAL) });
    let thrown;
    try {
      await addDepends("TD-E");
      assert.fail("expected the board to refuse the edge");
    } catch (err) {
      thrown = err;
    }
    return thrown;
  }

  it("keeps the shape on the error the drawer catches", async () => {
    const err = await refuseAddDepends();
    assert.ok(err instanceof ApiError);
    assert.equal(err.details.chain, "ancestor", "the refusal's shape is not lost on the way out of the service");
  });

  it("renders the ancestor join as itself, not as the loop it is not", async () => {
    const err = await refuseAddDepends();
    assert.equal(errorTextKey(err), "error.relationAncestor");
    const sentence = errorText("en", err);
    assert.match(sentence, /ancestor and a descendant/);
    // The sentence the reader used to get for this refusal — still right for the
    // shapes that *are* loops, and still what a shape-less `RELATION_CYCLE` gets.
    assert.notEqual(sentence, errorText("en", { code: "RELATION_CYCLE" }));
    assert.equal(errorText("en", { code: "RELATION_CYCLE" }), resolveText("en", "error.relationCycle"));
  });
});

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

  it("filters by a given assignee name, and only that name", async () => {
    // R13 — the defect Terry reported: before the named branch existed, handing
    // the control a name matched nothing in the if-chain, so *every* row came
    // through. `me` / `human` / `agent` are unchanged; the fourth arm is the
    // name, compared against the card's own `data-assignee`.
    const { board, visibleTasks } = await freshBoard();
    board.tasks = tasks;
    board.filters.assignee = "elon";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-2"]);
    board.filters.assignee = "Terry";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1"]);
    board.filters.assignee = "nobody";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), []);
    board.filters.assignee = "all";
    assert.equal(visibleTasks.value.length, 3);
  });

  it("filters by a status set, OR within the set and AND with the rest", async () => {
    // R11 ① — multiple choice is OR; the set is ANDed with the other clauses.
    const { board, visibleTasks, statusFilterValues, writeStatusFilter } = await freshBoard();
    board.tasks = tasks;
    writeStatusFilter(["todo"]);
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1", "TD-3"]);
    writeStatusFilter(["todo", "done"]);
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1", "TD-2", "TD-3"]);
    board.filters.search = "infra";
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-2"]);
    // …and the written value is the selection, restated in board order.
    writeStatusFilter(["done", "todo"]);
    assert.equal(board.filters.status, "todo,done");
    assert.deepEqual(statusFilterValues(), ["todo", "done"]);
    writeStatusFilter([]);
    assert.equal(board.filters.status, "all");
    assert.deepEqual(statusFilterValues(), []);
  });

  it("reads a card's stage for the status clause, so an awaiting card is in flight", async () => {
    // M1 — `awaiting` is an overlay on `in_progress`, so the filter compares the
    // card's own stage (what `[data-card][data-status]` carries), not the raw
    // state, and the list shows the same cards the board's in-progress column
    // does.
    const { board, visibleTasks, writeStatusFilter } = await freshBoard();
    board.tasks = [
      { id: "1", identifier: "TD-1", title: "Parked", status: "awaiting", priority: "high", labels: [], assignee: { display_name: "linus", kind: "agent" } },
      { id: "2", identifier: "TD-2", title: "Todo", status: "todo", priority: "high", labels: [], assignee: { display_name: "linus", kind: "agent" } },
    ];
    writeStatusFilter(["in_progress", "in_review"]);
    assert.deepEqual(visibleTasks.value.map((t) => t.identifier), ["TD-1"]);
  });

  it("counts the status set as one active filter and clears it with the rest", async () => {
    const { board, activeFilterCount, writeStatusFilter } = await freshBoard();
    assert.equal(activeFilterCount.value, 0);
    writeStatusFilter(["in_progress", "in_review"]);
    assert.equal(activeFilterCount.value, 1);
    board.filters.assignee = "jobs";
    assert.equal(activeFilterCount.value, 2);
  });

  it("reads a named assignee off the control's value, and only a name", async () => {
    // R13 §2.8 — the one reading that drives both the generated option and the
    // bar's `x`: the four static values are `null`, anything else is the name.
    const { board, namedAssignee, writeAssigneeFilter, assigneeFilterValue } = await freshBoard();
    assert.equal(namedAssignee.value, null);
    assert.equal(assigneeFilterValue(), "all");
    writeAssigneeFilter("jobs");
    assert.equal(namedAssignee.value, "jobs");
    assert.equal(assigneeFilterValue(), "jobs");
    writeAssigneeFilter("agent");
    assert.equal(namedAssignee.value, null);
    writeAssigneeFilter("");
    assert.equal(assigneeFilterValue(), "all");
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

/* ------------------------------------------------- waiting: acceptance */

describe("board store — the acceptance half of the waiting queue", () => {
  const original = (over = {}) => ({
    id: "o1",
    identifier: "TD-1",
    title: "Delivered",
    status: "in_review",
    delivery_round: 1,
    parent_id: null,
    review_of_id: null,
    review_round: null,
    version: 1,
    labels: [],
    ...over,
  });
  const review = (status, over = {}) => ({
    id: "r1",
    identifier: "TD-R",
    title: "Review TD-1",
    status,
    delivery_round: 1,
    parent_id: null,
    review_of_id: "o1",
    review_round: 1,
    version: 1,
    labels: [],
    ...over,
  });

  it("derives from the whole board reading, and the count adds both halves", async () => {
    const mod = await freshBoard();
    mod.board.currentProjectId = "p1";
    mod.board.loaded = true;
    mod.board.tasks = [original()];
    mod.board.acceptancePolicy = "both";
    assert.deepEqual(mod.acceptanceTasks.value.map((task) => task.id), ["o1"]);
    assert.equal(mod.waitingCount.value, 1);

    // The status filter hides the card from the board but not from the queue.
    mod.writeStatusFilter(["todo"]);
    assert.equal(mod.visibleTasks.value.length, 0);
    assert.deepEqual(mod.acceptanceTasks.value.map((task) => task.id), ["o1"]);

    mod.board.acceptancePolicy = "agent-only";
    assert.deepEqual(mod.acceptanceTasks.value, [], "an agent-only board asks the human for nothing");
    assert.equal(mod.waitingCount.value, 0);
    mod.writeStatusFilter(["all"]);
  });

  it("holds the card while its review is open, and updates when the review's own event arrives", async () => {
    const mod = await freshBoard();
    mod.board.currentProjectId = "p1";
    mod.board.loaded = true;
    mod.board.acceptancePolicy = "both";
    mod.board.tasks = [original(), review("todo")];
    assert.deepEqual(mod.acceptanceTasks.value, [], "a todo review holds it");

    // Only the review card is re-read — the original's row must appear anyway.
    const calls = installFetch({
      "GET /api/v1/tasks/TD-R": () => ok({ task: review("done"), report_waivers: [] }),
    });
    await mod.refreshTask(review("done").identifier);
    assert.equal(calls.length, 1, "one card re-read, not a whole-board reload");
    assert.equal(mod.board.tasks.find((task) => task.id === "r1").status, "done");
    assert.deepEqual(mod.acceptanceTasks.value.map((task) => task.id), ["o1"]);
  });

  it("waits for children, and a child's own event releases it", async () => {
    const mod = await freshBoard();
    mod.board.currentProjectId = "p1";
    mod.board.loaded = true;
    mod.board.acceptancePolicy = "both";
    const child = { ...original({ id: "c1", identifier: "TD-C", status: "todo", parent_id: "o1" }) };
    mod.board.tasks = [original(), child];
    assert.deepEqual(mod.acceptanceTasks.value, [], "an open child holds the container");

    installFetch({
      "GET /api/v1/tasks/TD-C": () => ok({ task: { ...child, status: "canceled" }, report_waivers: [] }),
    });
    await mod.refreshTask("TD-C");
    assert.deepEqual(mod.acceptanceTasks.value.map((task) => task.id), ["o1"]);
  });

  it("the sidebar assignee narrowing reaches the acceptance half and the pill", async () => {
    const mod = await freshBoard();
    mod.board.currentProjectId = "p1";
    mod.board.loaded = true;
    mod.board.acceptancePolicy = "both";
    mod.board.tasks = [original({ assignee: { display_name: "elon", kind: "claude" } })];

    assert.deepEqual(mod.visibleAcceptanceTasks.value.map((task) => task.id), ["o1"]);
    assert.equal(mod.waitingCount.value, 1);

    mod.writeAssigneeFilter("elon");
    assert.deepEqual(mod.visibleAcceptanceTasks.value.map((task) => task.id), ["o1"]);
    assert.equal(mod.waitingCount.value, 1);

    mod.writeAssigneeFilter("jobs");
    assert.deepEqual(mod.visibleAcceptanceTasks.value, [], "another agent's name leaves no acceptance row");
    assert.equal(mod.waitingCount.value, 0);

    mod.writeAssigneeFilter("agent");
    assert.equal(mod.visibleAcceptanceTasks.value.length, 1, "a platform kind is an agent");
    mod.writeAssigneeFilter("human");
    assert.deepEqual(mod.visibleAcceptanceTasks.value, [], "the delivering agent is not the human");
    mod.writeAssigneeFilter("me");
    assert.deepEqual(mod.visibleAcceptanceTasks.value, [], "me is the human, not the assignee");

    mod.writeAssigneeFilter("all");
    assert.deepEqual(mod.visibleAcceptanceTasks.value.map((task) => task.id), ["o1"]);
  });

  it("narrows the acceptance result, never its input", async () => {
    const mod = await freshBoard();
    mod.board.currentProjectId = "p1";
    mod.board.loaded = true;
    mod.board.acceptancePolicy = "both";
    const child = original({
      id: "c1",
      identifier: "TD-C",
      status: "todo",
      parent_id: "o1",
      assignee: { display_name: "jobs", kind: "claude" },
    });
    mod.board.tasks = [original({ assignee: { display_name: "elon", kind: "claude" } }), child];

    // The parent is held by an open child assigned to another agent. A
    // narrowing applied *before* the acceptance derivation would drop that
    // child and wrongly release the parent.
    mod.writeAssigneeFilter("elon");
    assert.deepEqual(mod.acceptanceTasks.value, [], "the whole reading still sees the child");
    assert.deepEqual(mod.visibleAcceptanceTasks.value, []);
    assert.equal(mod.waitingCount.value, 0);
  });
});
