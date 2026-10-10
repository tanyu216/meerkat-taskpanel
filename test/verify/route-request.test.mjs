/**
 * Tests for `scripts/verify/route-request.mjs` — the route-request lint.
 *
 * The lint closes the gap the contract snapshot leaves open: the snapshot freezes a
 * route's **declared** request schema, but nothing so far proved the declaration equals
 * what the handler actually reads. This suite answers the two questions that make such a
 * lint worth having, and it is split along them:
 *
 *   1. **Does the live surface pass?** Every route `registerApiRoutes` registers is read
 *      from source and compared against the declaration the same registration carries.
 *      The block also pins the two things that could turn the lint into a no-op: that it
 *      really reads fields (not an empty set that matches every declaration), and that the
 *      *only* exemption on the whole surface is the documented one — proved by running the
 *      lint with the refusal list emptied and asserting the single finding that appears.
 *
 *   2. **Would it actually catch drift?** A lint that never went red proves nothing, so
 *      the second block drives `checkRouteRequests` with **synthetic handlers** — a read
 *      the declaration omits, a declaration nobody reads, a computed read it cannot
 *      resolve, a destructured read, a literal-loop read — asserting red, then the
 *      matching green. This is the card's red→green proof, and it never edits `src/`.
 *
 * The suite writes nothing and starts nothing: every case is a pure function call over
 * handler source.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

import { OUT_OF_ROUTER_ENDPOINTS } from "../../src/server/index.mjs";
import { arr, bool, int, obj, REQUEST, shape, str } from "../../src/server/requests.mjs";
import {
  OUT_OF_LINT,
  REFUSED_READS,
  checkRouteRequests,
  declaredFields,
  extractReads,
  liveRouterRoutes,
  routeKey,
} from "../../scripts/verify/route-request.mjs";
import { ROOT, collectRoutes } from "../../scripts/verify/contract.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "route-request.mjs");

/** Run the CLI and return `{status, stdout, stderr}`. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** One synthetic route, in the shape `liveRouterRoutes()` produces. */
function route(method, path, handler, request) {
  return { method, path, pattern: path, handler, request };
}

/**
 * The lint over synthetic routes only.
 *
 * The out-of-router surface and the refusal list are empty by default: a case about a
 * *handler* should not also be asserting things about `/health` or about the surface's
 * own exemption, and both of those are pinned separately, against the real thing.
 */
function check(routes, options = {}) {
  return checkRouteRequests(routes, { refused: [], endpoints: [], outOfLint: [], ...options });
}

/** Every finding, flattened to one comparable string. */
function lines(result) {
  return result.findings.map((finding) => `${finding.kind} ${finding.route} ${finding.side} ${finding.detail}`);
}

describe("route-request.mjs — the live surface", () => {
  it("passes: every declaration equals what its handler reads", () => {
    const result = checkRouteRequests(liveRouterRoutes());
    assert.equal(result.ok, true, lines(result).join("\n"));
    assert.deepEqual(result.findings, []);
  });

  it("reads the real surface, not an empty set", () => {
    // A lint whose extractor returned `[]` for everything would pass every route that
    // declares nothing and fail every route that declares something — so counting the
    // other way round is the honest check: the reads are non-trivial and match.
    const routes = liveRouterRoutes();
    const byKey = new Map(routes.map((entry) => [routeKey(entry), entry]));

    const create = extractReads(byKey.get("POST /api/v1/tasks").handler);
    assert.ok(create.body.length >= 20, JSON.stringify(create));
    assert.deepEqual(create.body, declaredFields(byKey.get("POST /api/v1/tasks").request, "body"));

    const list = extractReads(byKey.get("GET /api/v1/tasks").handler);
    assert.deepEqual(list.query, ["assignee_id", "include_archived", "limit", "offset", "project_id", "status"]);

    // The query/body split is real: nothing reads a body on a GET, and the one route that
    // reads a body by computed key (`body[field]`) resolves through its literal loop.
    const patch = extractReads(byKey.get("PATCH /api/v1/tasks/:ref").handler);
    assert.ok(patch.body.includes("title"), "the literal-loop read resolved");

    let readsSomething = 0;
    let declaresNothing = 0;
    let silent = 0;
    for (const entry of routes) {
      const reads = extractReads(entry.handler);
      const readsAny = reads.query.length + reads.body.length > 0;
      const declaresAny = declaredFields(entry.request, "query").length + declaredFields(entry.request, "body").length > 0;
      if (readsAny) readsSomething += 1;
      if (!declaresAny) declaresNothing += 1;
      if (!readsAny) silent += 1;
    }
    // A route that declares nothing must read nothing, and a route that declares
    // something must read something — otherwise the lint itself would be reporting
    // `unread_declaration` on the live surface.
    assert.equal(silent, declaresNothing, "silent routes are exactly the ones declaring no request");
    assert.ok(readsSomething >= 20, `${readsSomething} of ${routes.length} routes read a request field`);
  });

  it("covers exactly the routes the contract snapshot freezes, handler and all", () => {
    // Same registration as the server, one extra reader — so a route cannot be added to
    // the API without being linted. The out-of-router endpoints are the difference, and
    // they are the reason `OUT_OF_LINT` exists.
    const lintKeys = liveRouterRoutes().map(routeKey).sort();
    const snapshotKeys = collectRoutes().map((entry) => `${entry.method} ${entry.path}`).sort();
    const outKeys = OUT_OF_ROUTER_ENDPOINTS.map(routeKey);
    for (const key of lintKeys) assert.ok(snapshotKeys.includes(key), `${key} is in the snapshot`);

    const routable = snapshotKeys.filter((key) => !outKeys.includes(key));
    assert.deepEqual(lintKeys, routable, "the lint analyses every routable snapshot route");
    for (const entry of liveRouterRoutes()) {
      assert.equal(typeof entry.handler, "function", `${routeKey(entry)} has a handler to read`);
      assert.deepEqual(Object.keys(entry.request).sort(), ["body", "query"]);
    }
  });

  it("has exactly one exemption, and it is load-bearing", () => {
    // The card's premise: the declaration is a second description of the handler, so the
    // two can drift. One read on the surface cannot be reconciled by matching names — a
    // field the handler reads only in order to refuse it. Emptying the refusal list must
    // therefore produce exactly that one finding and nothing else: if this list ever grows
    // silently, or the exemption stops being needed, this assertion is where it shows.
    assert.deepEqual(
      REFUSED_READS.map((entry) => `${entry.route} ${entry.side} ${entry.field}`),
      ["PATCH /api/v1/tasks/:ref body status"],
    );
    for (const entry of REFUSED_READS) assert.ok(entry.why.length > 40, `${entry.field} carries a reason`);

    const withoutRefusals = checkRouteRequests(liveRouterRoutes(), { refused: [] });
    assert.equal(withoutRefusals.ok, false);
    assert.deepEqual(lines(withoutRefusals), [
      'undeclared_read PATCH /api/v1/tasks/:ref body the handler reads "status" but the declaration omits it',
    ]);

    // And the handler really does read it — the refusal is not masking a dead field.
    const patch = liveRouterRoutes().find((entry) => routeKey(entry) === "PATCH /api/v1/tasks/:ref");
    assert.ok(extractReads(patch.handler).body.includes("status"));
  });

  it("acknowledges exactly the endpoints that cannot carry a handler", () => {
    assert.deepEqual(
      OUT_OF_LINT.map((entry) => entry.route).sort(),
      OUT_OF_ROUTER_ENDPOINTS.map(routeKey).sort(),
      "every out-of-router endpoint is accounted for, with a reason",
    );
    // The one that declares a request schema says so; the rest declare nothing.
    const events = OUT_OF_LINT.find((entry) => entry.route === "GET /api/v1/events");
    assert.equal(events.declares, "unverifiable");
    for (const entry of OUT_OF_LINT) assert.ok(entry.why.length > 20, `${entry.route} carries a reason`);
  });

  it("is deterministic — same surface, same verdict", () => {
    assert.deepEqual(checkRouteRequests(liveRouterRoutes()), checkRouteRequests(liveRouterRoutes()));
  });
});

describe("route-request.mjs — drift is caught (red → green)", () => {
  it("reports a body field the handler reads but the declaration omits", () => {
    const handler = ({ body }) => body.title + body.ghost;
    const red = check([route("POST", "/api/v1/demo", handler, { query: null, body: shape({ title: str() }) })]);
    assert.equal(red.ok, false);
    assert.deepEqual(lines(red), ['undeclared_read POST /api/v1/demo body the handler reads "ghost" but the declaration omits it']);

    const green = check([route("POST", "/api/v1/demo", handler, { query: null, body: shape({ title: str(), ghost: str() }) })]);
    assert.equal(green.ok, true, lines(green).join("\n"));
  });

  it("reports a query filter the handler reads but the declaration omits", () => {
    const handler = ({ query }) => query.get("status");
    const red = check([route("GET", "/api/v1/demo", handler, { query: shape({ limit: str() }), body: null })]);
    assert.deepEqual(lines(red), [
      'undeclared_read GET /api/v1/demo query the handler reads "status" but the declaration omits it',
      'unread_declaration GET /api/v1/demo query the declaration names "limit" but the handler never reads it',
    ]);

    const green = check([route("GET", "/api/v1/demo", handler, { query: shape({ status: str() }), body: null })]);
    assert.equal(green.ok, true);
  });

  it("reports a declared field the handler never reads", () => {
    const handler = ({ body }) => body.title;
    const red = check([route("POST", "/api/v1/demo", handler, { query: null, body: shape({ title: str(), ghost: str() }) })]);
    assert.deepEqual(lines(red), ['unread_declaration POST /api/v1/demo body the declaration names "ghost" but the handler never reads it']);

    const green = check([route("POST", "/api/v1/demo", handler, { query: null, body: shape({ title: str() }) })]);
    assert.equal(green.ok, true);
  });

  it("reports a handler that reads a body where nothing is declared", () => {
    const red = check([route("POST", "/api/v1/demo", ({ body }) => body.title, { query: null, body: null })]);
    assert.deepEqual(lines(red), ['undeclared_read POST /api/v1/demo body the handler reads "title" but the declaration omits it']);
  });

  it("refuses to pass a read it cannot resolve — there is no silent hole", () => {
    const cases = [
      { handler: ({ body }) => body[key], needle: "body[key] is a computed field" },
      { handler: ({ body }) => ({ ...body }), needle: "spread as a whole value" },
      { handler: ({ body }) => Object.keys(body).length, needle: "body is used as a whole value" },
      { handler: ({ body }) => body.hasOwnProperty("title"), needle: "is a call this lint cannot resolve" },
      { handler: ({ body }) => id(body), needle: "body is used as a whole value" },
      { handler: ({ body }) => { const { title, ...rest } = body; return title + rest; }, needle: "rest element" },
      { handler: ({ query }) => [...query].length, needle: "query is used in a way this lint cannot resolve" },
      { handler: ({ query }) => query.has("q"), needle: "query is used in a way this lint cannot resolve" },
      { handler: ({ query }) => f({ query }), needle: "query is used in a way this lint cannot resolve" },
    ];
    for (const { handler, needle } of cases) {
      const result = check([route("POST", "/api/v1/demo", handler, { query: shape({ q: str() }), body: shape({ title: str() }) })]);
      assert.equal(result.ok, false, `expected a finding for: ${needle}`);
      assert.ok(
        result.findings.some((finding) => finding.kind === "unresolvable_read" && finding.detail.includes(needle)),
        `${needle} — got ${lines(result).join(" | ")}`,
      );
    }
  });

  it("sees through the read forms a handler may legitimately use", () => {
    // The mirror of the case above: a form the lint *does* understand must not be
    // reported, or the gate would be noise and get suppressed.
    const cases = [
      { handler: ({ body }) => body.title, declared: { title: str() } }, // dot access
      { handler: ({ body }) => body["title"], declared: { title: str() } }, // literal bracket
      { handler: ({ body }) => { const { title } = body; return title; }, declared: { title: str() } }, // destructuring
      { handler: ({ body }) => { const { title: renamed } = body; return renamed; }, declared: { title: str() } }, // alias
      {
        handler: ({ body }) => {
          for (const field of ["title", "meta"]) if (body[field] !== undefined) return body[field];
          return null;
        },
        declared: { title: str(), meta: obj() },
      }, // literal loop
    ];
    for (const { handler, declared } of cases) {
      const result = check([route("POST", "/api/v1/demo", handler, { query: null, body: shape(declared) })]);
      assert.equal(result.ok, true, lines(result).join("\n"));
    }
  });

  it("is not fooled by prose — a comment or a string is not a read", () => {
    const handler = ({ body }) => {
      // body.ghost is mentioned here and nowhere else: it is not read.
      const note = "body.ghost";
      return body.title + note;
    };
    const result = check([route("POST", "/api/v1/demo", handler, { query: null, body: shape({ title: str() }) })]);
    assert.equal(result.ok, true, lines(result).join("\n"));
  });

  it("does not mistake a shadowing parameter for a read of the reader", () => {
    // `query` here is the nested arrow's own parameter, a binding rather than a use.
    const handler = ({ query }) => [1].map((query) => 1).length + query.get("q").length;
    const result = check([route("GET", "/api/v1/demo", handler, { query: shape({ q: str() }), body: null })]);
    assert.equal(result.ok, true, lines(result).join("\n"));
  });

  it("reads an interpolated expression, because it is an expression", () => {
    const red = check([route("POST", "/api/v1/demo", ({ body }) => `${body.ghost}`, { query: null, body: shape({}) })]);
    assert.deepEqual(lines(red), ['undeclared_read POST /api/v1/demo body the handler reads "ghost" but the declaration omits it']);
  });

  it("reports a refusal entry that no longer applies", () => {
    const refused = [{ route: "POST /api/v1/demo", side: "body", field: "status", why: "test" }];
    const declares = { query: null, body: shape({ status: REQUEST.status }) };
    const handler = ({ body }) => body.status;

    // A refused field that is also declared is no longer "refused".
    const declaredToo = check([route("POST", "/api/v1/demo", handler, declares)], { refused });
    assert.ok(lines(declaredToo).some((line) => line.includes("stale_refusal") && line.includes("also declared")));

    // A refused field the handler stopped reading.
    const notRead = check([route("POST", "/api/v1/demo", () => null, { query: null, body: shape({}) })], { refused });
    assert.ok(lines(notRead).some((line) => line.includes("stale_refusal") && line.includes("never reads it")));

    // A refusal for a route that is gone.
    const gone = check([], { refused });
    assert.deepEqual(lines(gone), ['stale_refusal POST /api/v1/demo body no route reads "status" any more — drop this refusal']);
  });

  it("keeps a deliberate refusal green while it still applies", () => {
    const refused = [{ route: "POST /api/v1/demo", side: "body", field: "status", why: "the route refuses it" }];
    const result = check(
      [route("POST", "/api/v1/demo", ({ body }) => body.status, { query: null, body: shape({ title: str() }) })],
      { refused },
    );
    assert.deepEqual(lines(result), ['unread_declaration POST /api/v1/demo body the declaration names "title" but the handler never reads it']);
  });

  it("will not let a request schema outside the router go unacknowledged", () => {
    const endpoints = [{ method: "GET", path: "/api/v1/extra", request: { query: shape({ q: str() }), body: null } }];

    const red = check([], { endpoints });
    assert.deepEqual(lines(red), [
      "uncovered_endpoint GET /api/v1/extra null served outside the JSON router and not acknowledged — add it to OUT_OF_LINT with a reason",
    ]);

    const green = check([], {
      endpoints,
      outOfLint: [{ route: "GET /api/v1/extra", declares: "unverifiable", why: "read by a helper outside the router" }],
    });
    assert.equal(green.ok, true, lines(green).join("\n"));

    // An acknowledgement that claims "reads nothing" does not cover a declaration.
    const mismatched = check([], {
      endpoints,
      outOfLint: [{ route: "GET /api/v1/extra", declares: "none", why: "used to read nothing" }],
    });
    assert.deepEqual(lines(mismatched), [
      "uncovered_endpoint GET /api/v1/extra null now declares a request schema but is still served outside the JSON router",
    ]);

    // And an acknowledgement of an endpoint that is gone is itself drift.
    const stale = check([], { outOfLint: [{ route: "GET /api/v1/extra", declares: "none", why: "gone" }] });
    assert.deepEqual(lines(stale), [
      "stale_uncovered GET /api/v1/extra null no such out-of-router endpoint — drop this acknowledgement",
    ]);
  });

  it("passes every route of the real surface with the declared vocabulary intact", () => {
    // A last green: the lint agrees with the declarations the snapshot freezes, including
    // the ones built from the domain's closed value sets.
    const result = checkRouteRequests(liveRouterRoutes());
    const move = liveRouterRoutes().find((entry) => routeKey(entry) === "POST /api/v1/tasks/:ref/move");
    assert.deepEqual(declaredFields(move.request, "body"), ["allow_steal", "if_version", "no_report", "reason", "to"]);
    assert.ok(move.request.body.properties.to.enum.length > 0);
    assert.equal(result.ok, true);
    assert.deepEqual(extractReads(move.handler).body, ["allow_steal", "if_version", "no_report", "reason", "to"]);
  });
});

describe("route-request.mjs — extractReads, the unit", () => {
  it("returns sorted reads with nothing to report", () => {
    const reads = extractReads(({ query, body }) => [query.get("b"), query.get("a")].length + body.z + body.y);
    assert.deepEqual(reads, { query: ["a", "b"], body: ["y", "z"], unresolvable: [] });
  });

  it("treats `getAll` as the same read as `get`", () => {
    assert.deepEqual(extractReads(({ query }) => query.getAll("status")).query, ["status"]);
  });

  it("understands bool/int/obj/arr vocabularies without special-casing them", () => {
    const request = { query: null, body: shape({ flag: bool(), n: int(), o: obj(), list: arr(str()) }) };
    assert.deepEqual(declaredFields(request, "body"), ["flag", "list", "n", "o"]);
    const reads = extractReads(({ body }) => [body.flag, body.n, body.o, body.list].length);
    assert.deepEqual(reads.body, ["flag", "list", "n", "o"]);
  });
});

describe("route-request.mjs — the CLI", () => {
  it("exits 0 on the live surface and names the coverage", () => {
    const result = runCli([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /route-request: OK — 31 routes/);
    assert.match(result.stdout, /5 out-of-router endpoints acknowledged/);
  });

  it("prints the declared-vs-read table with --print", () => {
    const result = runCli(["--print"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /POST \/api\/v1\/tasks\/:ref\/move/);
    assert.match(result.stdout, /declared \[allow_steal, if_version, no_report, reason, to\]/);
    // The exemption is visible in the table, not hidden by it.
    assert.match(result.stdout, /status \(refused\)/);
  });

  it("prints its usage with --help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: node scripts\/verify\/route-request\.mjs/);
  });
});
