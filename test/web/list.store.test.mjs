/**
 * `stores/list.js` — the list view's own server-paged data plane (TP-0094).
 *
 * The list is not `board.tasks`: it pages the **server-filtered** set with
 * `limit=200&offset=N`, so paging never changes what the waiting queue or the
 * activity feed read. This suite exercises the store through the real call
 * chain — `services/api.js` over a fake `fetch`, never a stubbed store — and
 * covers the rules the card freezes:
 *
 *   - every `board.filters` value maps to the right server query;
 *   - `offset` advances by the rows the page actually returned, and the display
 *     list dedupes by id;
 *   - `more` is `offset < total`, and the empty state is `total === 0`;
 *   - the search debounce is 250 ms; other filters reset at once;
 *   - a project switch discards a late response;
 *   - a failed read writes `list.error`, never `board.error`;
 *   - `priority=none` (the priority control's display band, which no stored card
 *     can carry) is an empty result with no server request.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

register("./support/vue-loader.mjs", import.meta.url);

const boardModule = await import("../../web/src/stores/board.js");
const uiModule = await import("../../web/src/stores/ui.js");

let bust = 0;
/** A fresh list module (fresh state, token and debounce timer). */
async function freshList() {
  bust += 1;
  return import(`../../web/src/stores/list.js?fresh=${bust}`);
}

/** Install a fake `fetch` routed by `"METHOD /path"` (query included in the record). */
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ url, method, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    const entry = routes[`${method} ${url.split("?")[0]}`] ?? routes["*"];
    if (!entry) throw new Error(`unexpected request: ${method} ${url}`);
    return typeof entry === "function" ? entry({ url, method }, calls.length) : entry;
  };
  return calls;
}

const ok = (data) => ({ status: 200, json: async () => ({ ok: true, data }) });
const failure = (status, code) => ({
  status,
  json: async () => ({ ok: false, error: { code, message: code, http: status, details: {} } }),
});

/** Let promise continuations settle (real `setImmediate`; timers are mocked). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The query a recorded call carried. */
function queryOf(call) {
  return Object.fromEntries(new URL(call.url, "http://127.0.0.1").searchParams);
}

/** A page of `count` cards starting at `from`. */
function page(from, count, prefix = "td") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${from + index}`,
    identifier: `P-${String(from + index).padStart(4, "0")}`,
    status: "todo",
  }));
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  boardModule.board.currentProjectId = "p1";
  boardModule.board.tasks = [];
  boardModule.board.error = null;
  boardModule.board.filters.search = "";
  boardModule.board.filters.assignee = "all";
  boardModule.board.filters.priority = "all";
  boardModule.board.filters.status = "all";
  boardModule.board.filters.label = "all";
  boardModule.board.showReviews = false;
  uiModule.view.value = "list";
});

afterEach(() => {
  mock.timers.reset();
  delete globalThis.fetch;
  uiModule.view.value = "board";
});

describe("web/list — filter → server query", () => {
  it("maps every board filter to the server's spelling", async () => {
    const list = await freshList();
    boardModule.board.filters.search = "  Alpha  ";
    boardModule.board.filters.priority = "high";
    boardModule.board.filters.label = "ops";
    boardModule.board.filters.status = "in_progress,todo";
    boardModule.board.filters.assignee = "agent";

    const query = list.queryFor();
    assert.equal(query.q, "Alpha", "search is trimmed into `q`");
    assert.equal(query.priority, "high");
    assert.equal(query.label, "ops");
    assert.equal(query.include_archived, 0);
    assert.deepEqual([...query.status].sort(), ["awaiting", "in_progress", "todo"]);
    assert.equal(query.assignee_kind, "agent");
    assert.equal(query.assignee, undefined, "one spelling only");
  });

  it("maps `me` to the human name and a given name to `assignee`", async () => {
    const list = await freshList();

    boardModule.board.filters.assignee = "me";
    assert.equal(list.queryFor().assignee, boardModule.ME);

    boardModule.board.filters.assignee = "human";
    assert.equal(list.queryFor().assignee_kind, "human");

    boardModule.board.filters.assignee = "linus";
    assert.equal(list.queryFor().assignee, "linus");
    assert.equal(list.queryFor().assignee_kind, undefined);
  });

  it("omits `all` and leaves other statuses alone", async () => {
    const list = await freshList();
    boardModule.board.filters.status = "done,canceled";
    assert.deepEqual(list.queryFor().status, ["done", "canceled"]);
    boardModule.board.filters.priority = "all";
    boardModule.board.filters.assignee = "all";
    assert.equal(list.queryFor().priority, undefined);
    assert.equal(list.queryFor().assignee, undefined);
  });
});

describe("web/list — the first page", () => {
  it("asks for limit=200&offset=0 with the filter query and records total", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({
      "GET /api/v1/tasks": ok({ tasks: page(0, 3), total: 250 }),
    });

    await list.loadFirst();

    assert.equal(calls.length, 1);
    const query = queryOf(calls[0]);
    assert.equal(query.project_id, "p1");
    assert.equal(query.limit, "200");
    assert.equal(query.offset, "0");
    assert.equal(query.include_archived, "0");
    assert.equal(list.list.tasks.length, 3);
    assert.equal(list.list.total, 250);
    assert.equal(list.list.offset, 3, "the cursor advances by the raw page length");
    assert.equal(list.list.loaded, true);
    assert.equal(list.list.loading, false);
    assert.equal(list.more.value, true);
  });

  it("is complete when the page carries the whole set", async () => {
    const list = await freshList();
    installFetch({ "GET /api/v1/tasks": ok({ tasks: page(0, 2), total: 2 }) });
    await list.loadFirst();
    assert.equal(list.more.value, false);
  });
});

describe("web/list — load more", () => {
  it("advances by the raw page length and appends", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({
      "GET /api/v1/tasks": (_req, call) =>
        ok(
          call === 1
            ? { tasks: page(0, 200), total: 250 }
            : { tasks: page(200, 50), total: 250 },
        ),
    });

    await list.loadFirst();
    await list.loadMore();

    assert.equal(calls.length, 2);
    assert.equal(queryOf(calls[1]).offset, "200");
    assert.equal(list.list.tasks.length, 250);
    assert.equal(list.list.offset, 250);
    assert.equal(list.more.value, false);
  });

  it("dedupes by id but still advances the cursor by the rows the page returned", async () => {
    const list = await freshList();
    let calls = [];
    // Page 2 repeats `td_199` (offset drift) and carries one new card.
    calls = installFetch({
      "GET /api/v1/tasks": (_req, call) =>
        ok(
          call === 1
            ? { tasks: page(0, 200), total: 201 }
            : { tasks: [{ ...page(199, 1)[0] }, ...page(200, 1)], total: 201 },
        ),
    });

    await list.loadFirst();
    await list.loadMore();

    assert.equal(calls.length, 2);
    assert.equal(queryOf(calls[1]).offset, "200");
    assert.equal(list.list.tasks.length, 201, "the duplicate is dropped from the display list");
    assert.equal(list.list.offset, 202, "but the cursor counts the two returned rows");
    assert.equal(list.more.value, false, "offset 202 >= total 201");
  });

  it("does nothing when the cursor already reached the total", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({ "GET /api/v1/tasks": ok({ tasks: page(0, 2), total: 2 }) });
    await list.loadFirst();
    await list.loadMore();
    assert.equal(calls.length, 1);
  });
});

describe("web/list — reset and debounce", () => {
  it("a non-search filter resets immediately", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({ "GET /api/v1/tasks": ok({ tasks: page(0, 1), total: 1 }) });
    await list.loadFirst();
    assert.equal(calls.length, 1);

    boardModule.board.filters.priority = "high";
    list.reset();
    await list.loadFirst();
    assert.equal(calls.length, 2);
    assert.equal(queryOf(calls[1]).offset, "0");
    assert.equal(queryOf(calls[1]).priority, "high");
  });

  it("debounces the search by 250 ms", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({ "GET /api/v1/tasks": ok({ tasks: page(0, 1), total: 1 }) });

    boardModule.board.filters.search = "alpha";
    list.scheduleSearchLoad();
    assert.equal(calls.length, 0, "nothing before the debounce fires");

    mock.timers.tick(249);
    await settle();
    assert.equal(calls.length, 0, "still nothing at 249 ms");

    mock.timers.tick(1);
    await settle();
    assert.equal(calls.length, 1, "the read starts at 250 ms");
  });

  it("a second keystroke restarts the debounce", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({ "GET /api/v1/tasks": ok({ tasks: page(0, 1), total: 1 }) });

    list.scheduleSearchLoad();
    mock.timers.tick(200);
    list.scheduleSearchLoad();
    mock.timers.tick(249);
    await settle();
    assert.equal(calls.length, 0);
    mock.timers.tick(1);
    await settle();
    assert.equal(calls.length, 1);
  });

  it("does not schedule outside the list view", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({ "GET /api/v1/tasks": ok({ tasks: [], total: 0 }) });
    uiModule.view.value = "board";
    list.scheduleSearchLoad();
    mock.timers.tick(500);
    await settle();
    assert.equal(calls.length, 0);
  });
});

describe("web/list — switching project", () => {
  it("discards a late response from the project the reader left", async () => {
    const list = await freshList();
    let resolveFirst;
    let calls = 0;
    installFetch({
      "GET /api/v1/tasks": () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveFirst = () => resolve(ok({ tasks: page(0, 1, "old"), total: 1 }));
          });
        }
        return Promise.resolve(ok({ tasks: page(0, 1, "new"), total: 1 }));
      },
    });

    const first = list.loadFirst();
    boardModule.board.currentProjectId = "p2";
    await list.loadFirst();
    assert.equal(list.list.tasks[0].id, "new_0");

    resolveFirst();
    await first;
    assert.equal(list.list.tasks[0].id, "new_0", "the old project's page never paints");
  });
});

describe("web/list — failure isolation", () => {
  it("writes list.error, never board.error", async () => {
    const list = await freshList();
    installFetch({ "GET /api/v1/tasks": failure(500, "INTERNAL") });

    await assert.rejects(() => list.loadFirst());
    assert.equal(list.list.error.code, "INTERNAL");
    assert.equal(boardModule.board.error, null);
    assert.equal(list.list.loading, false);
  });
});

describe("web/list — ADR 0014 review kind", () => {
  it("hides review rows by default and shows them with the switch", async () => {
    const list = await freshList();
    installFetch({
      "GET /api/v1/tasks": ok({
        tasks: [
          { id: "td_1", identifier: "P-1", status: "todo", kind: "task" },
          { id: "td_2", identifier: "P-2", status: "done", kind: "review" },
        ],
        total: 2,
      }),
    });

    await list.loadFirst();
    assert.deepEqual(
      list.visibleListTasks.value.map((task) => task.id),
      ["td_1"],
      "a review card is not rendered while the switch is off",
    );
    assert.equal(list.list.tasks.length, 2, "the raw page keeps the cursor honest");
    assert.equal(list.listTotal.value, 1, "the count denominator drops the hidden row");

    boardModule.board.showReviews = true;
    assert.deepEqual(
      list.visibleListTasks.value.map((task) => task.id),
      ["td_1", "td_2"],
    );
    assert.equal(list.listTotal.value, 2);
  });
});

describe("web/list — priority=none", () => {
  it("short-circuits to an empty result without a server request", async () => {
    const list = await freshList();
    let calls = [];
    calls = installFetch({ "GET /api/v1/tasks": ok({ tasks: page(0, 1), total: 1 }) });
    boardModule.board.filters.priority = "none";

    await list.loadFirst();

    assert.equal(calls.length, 0, "`none` is not a server value");
    assert.deepEqual(list.list.tasks, []);
    assert.equal(list.list.total, 0);
    assert.equal(list.list.loaded, true);
    assert.equal(list.more.value, false);
  });
});
