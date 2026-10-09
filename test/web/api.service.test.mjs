/**
 * `services/api.js` — the HTTP client contract (M6a), browser-free.
 *
 * The module is the *only* place in the app that touches `fetch`, and it owns
 * two rules: the `{ok:true,data:…}` envelope is unwrapped to its `data` half,
 * and a failure rejects with a structured `ApiError` carrying the machine code
 * the UI branches on. `fetch` is the external boundary, so the tests inject a
 * fake one and assert the *real* module behaviour: URL building, query
 * serialisation, body/header shaping, and the error mapping (409 / 422 /
 * network / non-JSON), plus the `if_version` propagation the move path relies on.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ApiError, api, health, patch, post, request } from "../../web/src/services/api.js";

/** Install a fake `fetch`; returns the recorded calls (url + raw options). */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return handler({ url, options }, calls.length);
  };
  return calls;
}

const jsonResponse = (status, body) => ({ status, json: async () => body });
const okEnvelope = (data, status = 200) => jsonResponse(status, { ok: true, data });
const errorEnvelope = (status, error) => jsonResponse(status, { ok: false, error });

afterEach(() => {
  delete globalThis.fetch;
});

describe("web/api — request shaping", () => {
  it("issues a relative GET under /api/v1 with no body and no content-type", async () => {
    const calls = installFetch(() => okEnvelope({ ok: 1 }));
    const data = await request("GET", "/meta");
    assert.deepEqual(data, { ok: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/v1/meta");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
    assert.deepEqual(calls[0].options.headers, {});
  });

  it("serialises a JSON body and sets content-type on a write", async () => {
    const calls = installFetch(() => okEnvelope({ id: "td_1" }));
    await post("/tasks", { title: "wire it" });
    assert.equal(calls[0].url, "/api/v1/tasks");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(calls[0].options.headers, { "content-type": "application/json" });
    assert.equal(calls[0].options.body, '{"title":"wire it"}');
  });

  it("PATCH is a real verb with a body (not a GET in disguise)", async () => {
    const calls = installFetch(() => okEnvelope({}));
    await patch("/tasks/TD-1", { title: "renamed" });
    assert.equal(calls[0].options.method, "PATCH");
    assert.equal(calls[0].url, "/api/v1/tasks/TD-1");
  });

  it("omits empty query values but keeps a falsy zero", async () => {
    const calls = installFetch(() => okEnvelope({}));
    await api.tasks({ project_id: "p1", include_archived: 0, q: "", skip: null, missing: undefined });
    assert.equal(calls[0].url, "/api/v1/tasks?project_id=p1&include_archived=0");
  });

  it("repeats a key for an array query value", async () => {
    const calls = installFetch(() => okEnvelope({}));
    await request("GET", "/tasks", { query: { tag: ["a", "b"], limit: 5 } });
    assert.equal(calls[0].url, "/api/v1/tasks?tag=a&tag=b&limit=5");
  });

  it("carries order_debug=1 on the projects request (O4: the order is consumed)", async () => {
    const calls = installFetch(() => okEnvelope({ projects: [] }));
    await api.projects({ order_debug: 1, include_archived: 1 });
    assert.equal(calls[0].url, "/api/v1/projects?order_debug=1&include_archived=1");
  });

  it("URL-encodes a ref that needs escaping", async () => {
    const calls = installFetch(() => okEnvelope({}));
    await api.task("TD 1/2");
    assert.equal(calls[0].url, "/api/v1/tasks/TD%201%2F2");
  });

  it("health() bypasses the envelope and the /api/v1 prefix", async () => {
    const calls = installFetch(() => jsonResponse(200, { ok: true, revision: 12 }));
    const data = await health();
    assert.deepEqual(data, { ok: true, revision: 12 });
    assert.equal(calls[0].url, "/health");
  });
});

describe("web/api — if_version propagation (the move path)", () => {
  it("posts moveTask with to + if_version verbatim", async () => {
    const calls = installFetch(() => okEnvelope({ task: { identifier: "TD-1", version: 8 } }));
    await api.moveTask("TD-1", { to: "done", if_version: 7 });
    assert.equal(calls[0].url, "/api/v1/tasks/TD-1/move");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body, '{"to":"done","if_version":7}');
  });
});

describe("web/api — error mapping", () => {
  it("maps a 409 VERSION_CONFLICT to a structured ApiError", async () => {
    installFetch(() =>
      errorEnvelope(409, {
        code: "VERSION_CONFLICT",
        message: "stale version",
        http: 409,
        details: { currentVersion: 5, expectedVersion: 3 },
        hint: { fix: "reload and retry" },
      }),
    );
    await assert.rejects(
      () => api.moveTask("TD-1", { to: "done", if_version: 3 }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.name, "ApiError");
        assert.equal(err.code, "VERSION_CONFLICT");
        assert.equal(err.http, 409);
        assert.equal(err.message, "stale version");
        assert.deepEqual(err.details, { currentVersion: 5, expectedVersion: 3 });
        assert.deepEqual(err.hint, { fix: "reload and retry" });
        assert.equal(err.isVersionConflict, true);
        return true;
      },
    );
  });

  it("keeps a 422 validation failure distinct from a version conflict", async () => {
    installFetch(() => errorEnvelope(422, { code: "INVALID_TRANSITION", message: "no", http: 422 }));
    await assert.rejects(
      () => api.moveTask("TD-1", { to: "done", if_version: 3 }),
      (err) => {
        assert.equal(err.code, "INVALID_TRANSITION");
        assert.equal(err.http, 422);
        assert.equal(err.isVersionConflict, false);
        assert.deepEqual(err.details, {});
        assert.equal(err.hint, null);
        return true;
      },
    );
  });

  it("falls back to INTERNAL for an error response with no error payload", async () => {
    installFetch(() => jsonResponse(500, { ok: false }));
    await assert.rejects(
      () => api.meta(),
      (err) => {
        assert.equal(err.code, "INTERNAL");
        assert.equal(err.http, 500);
        assert.equal(err.message, "unexpected response (500)");
        return true;
      },
    );
  });

  it("falls back to INTERNAL for a non-JSON body", async () => {
    installFetch(() => ({
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    await assert.rejects(
      () => api.meta(),
      (err) => {
        assert.equal(err.code, "INTERNAL");
        assert.equal(err.http, 502);
        assert.match(err.message, /502/);
        return true;
      },
    );
  });

  it("maps a transport failure to a NETWORK ApiError with the cause attached", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(
      () => api.meta(),
      (err) => {
        assert.equal(err.code, "NETWORK");
        assert.equal(err.http, 0);
        assert.match(err.details.cause, /Failed to fetch/);
        return true;
      },
    );
  });

  it("rethrows an AbortError untouched (it is not a server failure)", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    globalThis.fetch = async () => {
      throw abort;
    };
    await assert.rejects(
      () => request("GET", "/meta", { signal: new AbortController().signal }),
      (err) => {
        assert.equal(err, abort);
        assert.equal(err instanceof ApiError, false);
        return true;
      },
    );
  });
});

describe("web/api — ApiError defaults", () => {
  it("defaults code/http/message/details when the payload is empty", () => {
    const err = new ApiError({});
    assert.equal(err.code, "INTERNAL");
    assert.equal(err.http, 0);
    assert.equal(err.message, "request failed");
    assert.deepEqual(err.details, {});
    assert.equal(err.hint, null);
  });

  it("takes the HTTP status from the argument when the payload omits it", () => {
    assert.equal(new ApiError({ code: "NOT_FOUND" }, 404).http, 404);
  });
});
