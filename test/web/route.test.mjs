/**
 * R16 · the address layer — the route table, the feed's query, and the router's
 * two writers and one reader.
 *
 * Browser-free on purpose. `web/src/lib/route.js` is pure string work (no
 * `location` anywhere in it), so the table and the payload's four rules are
 * asserted as values; `web/src/stores/route.js` takes its `location` and its
 * `history` as arguments, so the reader and writer A are driven with a recording
 * double rather than a real window. What is *not* here is what only a browser
 * can answer — a real deep link, a real back press, the sidebar's highlight
 * following the route: that is `web/scripts/dom-smoke.mjs`'s half, and the
 * independent probe is `T-20261013-183505-4`.
 *
 * Authority: `design/fidelity-r16.md` §6 (B1–B8, and the C-leg cases that are
 * really about a resolved address) · `design/DESIGN.md` §32.
 *
 * Vue is aliased to the in-repo shim before any store is imported (the container
 * ships no `node_modules`); the pure module needs no such thing.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

import {
  ACTIVITY_SLOTS,
  activityQuery,
  legacyActivityQuery,
  pathFor,
  readActivityQuery,
  routeFor,
} from "../../web/src/lib/route.js";

register("./support/vue-loader.mjs", import.meta.url);

/** A recording double for the one browser surface the router touches. */
function address(pathname = "/", search = "", hash = "") {
  const writes = { push: [], replace: [] };
  const location = { pathname, search, hash };
  const history = {
    pushState: (...args) => writes.push.push(args),
    replaceState: (...args) => writes.replace.push(args),
  };
  return { location, history, writes };
}

const view = async () => (await import("../../web/src/stores/ui.js")).view.value;
const router = () => import("../../web/src/stores/route.js");
const activity = () => import("../../web/src/stores/activity.js");

describe("R16 · the route table (B1/B2)", () => {
  it("gives every view its own canonical path", () => {
    assert.equal(pathFor("board"), "/board");
    assert.equal(pathFor("list"), "/list");
    assert.equal(pathFor("activity"), "/activity");
    assert.equal(pathFor("waiting"), "/waiting");
  });

  it("resolves the five addresses, and normalises everything else to the board", () => {
    // The five rows of §3's table, each spelling exactly as it is written.
    for (const [pathname, expected] of [
      ["/board", "board"],
      ["/list", "list"],
      ["/activity", "activity"],
      ["/waiting", "waiting"],
    ]) {
      assert.deepEqual(routeFor(pathname), { view: expected, canonical: null, alias: false }, pathname);
    }
    // The bare entry point and Vite's entry file are aliases of the board, and
    // both are rewritten — that rewrite *is* "the default entry lands on board".
    assert.deepEqual(routeFor("/"), { view: "board", canonical: "/board", alias: true });
    assert.deepEqual(routeFor("/index.html"), { view: "board", canonical: "/board", alias: true });
    assert.deepEqual(routeFor(""), { view: "board", canonical: "/board", alias: true }, "an empty pathname is the entry point");
    // A matched route the browser shows with a trailing slash is normalised; the
    // server strips it before dispatch, so this is the frontend's job (§2, note 3).
    assert.deepEqual(routeFor("/board/"), { view: "board", canonical: "/board", alias: false });
    assert.deepEqual(routeFor("/activity//"), { view: "activity", canonical: "/activity", alias: false });
    // Unknown paths land on the board, case-sensitively: `/Board` is a typo.
    for (const pathname of ["/nope", "/borad", "/Board", "/board/PROJ-0001"]) {
      assert.deepEqual(routeFor(pathname), { view: "board", canonical: "/board", alias: false }, pathname);
    }
  });
});

describe("R16 · the feed's query (B3/B4/B7/B8)", () => {
  it("writes only the narrowing slots, in slot order", () => {
    assert.deepEqual([...ACTIVITY_SLOTS], ["actor", "event", "task"]);
    assert.equal(activityQuery({ actor: "all", event: "all", task: "all" }), "");
    assert.equal(activityQuery({ actor: "agent", event: "all", task: "all" }), "?actor=agent");
    assert.equal(activityQuery({ actor: "all", event: "delivery", task: "TD-6" }), "?event=delivery&task=TD-6");
    assert.equal(
      activityQuery({ actor: "agent", event: "status", task: "TD-1" }),
      "?actor=agent&event=status&task=TD-1",
    );
    assert.equal(activityQuery({}), "", "an absent slot is `all`");
  });

  it("reads an address back into the complete filter set, refusing what it cannot use", () => {
    assert.deepEqual(readActivityQuery("?actor=agent&event=status&task=TD-1"), {
      filters: { actor: "agent", event: "status", task: "TD-1" },
      applied: true,
    });
    // An out-of-domain value is "no condition in this slot", not a refusal of the
    // whole address — and not a value the writer would ever produce.
    assert.deepEqual(readActivityQuery("?actor=nonsense"), {
      filters: { actor: "all", event: "all", task: "all" },
      applied: false,
    });
    // The drawer's own fragment is not the feed's payload.
    assert.equal(readActivityQuery("#/task/TD-1").applied, false);
    assert.deepEqual(readActivityQuery("#/task/TD-1").filters, { actor: "all", event: "all", task: "all" });
    // Repeated slots apply in order, so the last accepted value wins.
    assert.deepEqual(readActivityQuery("?actor=agent&actor=all").filters.actor, "all");
    // Unknown slots are ignored, never applied.
    assert.equal(readActivityQuery("?theme=dark").applied, false);
  });

  it("identifies the old feed address, and only it", () => {
    assert.equal(
      legacyActivityQuery("#/activity?actor=agent&event=status&task=TD-128"),
      "?actor=agent&event=status&task=TD-128",
    );
    assert.equal(legacyActivityQuery("#/activity"), "");
    assert.equal(legacyActivityQuery("#/task/TD-1"), null);
    assert.equal(legacyActivityQuery(""), null);
    assert.equal(legacyActivityQuery("?actor=agent"), null);
  });

  it("gives the old carrier no rules of its own (B8)", () => {
    // The same payload, read through the same parser, lands the same three
    // filters — and a slot the old form cannot name is `all`, exactly as in the
    // query form. This is "one parser, two carriers", asserted rather than said.
    const payload = legacyActivityQuery("#/activity?actor=nonsense&event=delivery&task=");
    assert.equal(payload, "?actor=nonsense&event=delivery&task=");
    const fromLegacy = readActivityQuery(payload).filters;
    assert.deepEqual(fromLegacy, { actor: "all", event: "delivery", task: "all" });
    assert.equal(activityQuery(fromLegacy), activityQuery(readActivityQuery("?actor=nonsense&event=delivery&task=").filters));
  });
});

describe("R16 · the reader (applyLocation)", () => {
  beforeEach(async () => {
    (await activity()).resetActivityFilters();
  });

  it("lands the four routes on their views", async () => {
    const { applyLocation } = await router();
    for (const [pathname, expected] of [
      ["/board", "board"],
      ["/list", "list"],
      ["/activity", "activity"],
      ["/waiting", "waiting"],
    ]) {
      const { location, history, writes } = address(pathname);
      applyLocation(location, history);
      assert.equal(await view(), expected, pathname);
      assert.deepEqual(writes.replace, [], `${pathname} is already canonical`);
      assert.deepEqual(writes.push, [], "the reader never writes history");
    }
  });

  it("normalises the bare entry point to the board, without a history entry", async () => {
    const { applyLocation } = await router();
    for (const pathname of ["/", "/index.html"]) {
      const { location, history, writes } = address(pathname);
      applyLocation(location, history);
      assert.equal(await view(), "board", pathname);
      assert.deepEqual(writes.replace, [[null, "", "/board"]], pathname);
      assert.deepEqual(writes.push, []);
    }
  });

  it("sends an unknown path to the board and rewrites the address", async () => {
    const { applyLocation } = await router();
    for (const pathname of ["/nope", "/borad", "/board/PROJ-0001"]) {
      const { location, history, writes } = address(pathname);
      applyLocation(location, history);
      assert.equal(await view(), "board", pathname);
      assert.deepEqual(writes.replace, [[null, "", "/board"]], pathname);
    }
  });

  it("drops the trailing slash the server already strips", async () => {
    const { applyLocation } = await router();
    const { location, history, writes } = address("/waiting/");
    applyLocation(location, history);
    assert.equal(await view(), "waiting");
    assert.deepEqual(writes.replace, [[null, "", "/waiting"]]);
  });

  it("keeps the drawer's fragment when it normalises the path (C13)", async () => {
    const { applyLocation } = await router();
    const { location, history, writes } = address("/", "", "#/task/TD-1");
    applyLocation(location, history);
    assert.equal(await view(), "board");
    assert.deepEqual(writes.replace, [[null, "", "/board#/task/TD-1"]], "the fragment is the drawer's, and stays");
  });

  it("reads an old share link, enters the feed and consumes the fragment (C12)", async () => {
    const { applyLocation } = await router();
    const first = address("/", "", "#/activity?actor=agent&event=status&task=TD-128");
    applyLocation(first.location, first.history);
    assert.equal(await view(), "activity", "an old feed link is a link *into* the feed");
    assert.deepEqual({ ...(await activity()).activity.filters }, { actor: "agent", event: "status", task: "TD-128" });
    assert.deepEqual(first.writes.replace, [[null, "", "/activity?actor=agent&event=status&task=TD-128"]]);
    assert.deepEqual(first.writes.push, []);

    // …and the bare form, which names no condition, redirects the same way.
    const second = address("/index.html", "", "#/activity");
    applyLocation(second.location, second.history);
    assert.equal(await view(), "activity");
    assert.deepEqual({ ...(await activity()).activity.filters }, { actor: "all", event: "all", task: "all" });
    assert.deepEqual(second.writes.replace, [[null, "", "/activity"]]);
  });

  it("does not read the feed's fragment on a path that is a route", async () => {
    const { applyLocation } = await router();
    const { location, history, writes } = address("/board", "", "#/activity?actor=agent");
    applyLocation(location, history);
    assert.equal(await view(), "board", "the path wins; the fragment may be the drawer's");
    assert.deepEqual(writes.replace, []);
  });

  it("states the feed's filters completely from the address, and never writes (C4/C6)", async () => {
    const { applyLocation } = await router();
    const store = await activity();
    store.writeActivityFilter("actor", "agent");
    const { location, history, writes } = address("/activity", "");
    applyLocation(location, history);
    assert.equal(await view(), "activity");
    assert.deepEqual(
      { ...store.activity.filters },
      { actor: "all", event: "all", task: "all" },
      "a slot the address does not name is `all` — not the session's residue",
    );

    const deep = address("/activity", "?actor=agent&event=status&task=TD-128");
    applyLocation(deep.location, deep.history);
    assert.deepEqual({ ...store.activity.filters }, { actor: "agent", event: "status", task: "TD-128" });
    assert.deepEqual(deep.writes.replace, [], "a canonical address is left exactly as it is");
    assert.deepEqual(deep.writes.push, []);
    store.resetActivityFilters();
  });
});

describe("R16 · writer A (navigate)", () => {
  beforeEach(async () => {
    (await activity()).resetActivityFilters();
  });

  it("pushes the view's canonical address and moves the mirror", async () => {
    const { navigate } = await router();
    const { location, history, writes } = address("/board");
    navigate("list", location, history);
    assert.deepEqual(writes.push, [[null, "", "/list"]]);
    assert.deepEqual(writes.replace, []);
    assert.equal(await view(), "list");
  });

  it("carries the feed's filters into the address it writes", async () => {
    const { navigate } = await router();
    const store = await activity();
    store.writeActivityFilter("actor", "agent");
    const { location, history, writes } = address("/board");
    navigate("activity", location, history);
    assert.deepEqual(writes.push, [[null, "", "/activity?actor=agent"]]);
    store.resetActivityFilters();
  });

  it("writes nothing when the target address is already the current one", async () => {
    const { navigate } = await router();
    const { location, history, writes } = address("/waiting");
    navigate("waiting", location, history);
    assert.deepEqual(writes.push, [], "a re-press of the view in force leaves no history entry");
    assert.equal(await view(), "waiting");
  });

  it("ignores a name that is not a view", async () => {
    const { navigate } = await router();
    const { location, history, writes } = address("/board");
    const before = await view();
    navigate("states", location, history);
    assert.deepEqual(writes.push, []);
    assert.deepEqual(writes.replace, []);
    assert.equal(await view(), before, "an unknown name leaves both the view and the address alone");
  });
});
