/**
 * The intake routes over real HTTP (0007).
 *
 * `POST /intake` is the web composer's write; `GET /intake` is the supervisor's
 * pending scan (through `taskctl`); `GET /intake/:id` is the re-read every
 * consumer uses after a signal. `complete`/`fail` are the decision lane's two
 * answers, and the tests pin the shapes a retry meets: the same terminal state
 * returns the row, a contradiction names `INVALID_TRANSITION`.
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
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-intake-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;
  await call("POST", "/api/v1/projects", { id: "proj", name: "Project" });
  await call("POST", "/api/v1/projects", { id: "othr", name: "Other" });
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

const dataOf = (result) => {
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.data;
};

const errorOf = (result) => {
  assert.equal(result.body.ok, false, JSON.stringify(result.body));
  return result.body.error;
};

describe("server/routes.intake — submit and read", () => {
  it("creates a pending request, lists it, and reads it back by id", async () => {
    const created = await call("POST", "/api/v1/intake", {
      project_id: "proj",
      text: "Fix the blank first paint",
    });
    assert.equal(created.status, 200);
    const request = dataOf(created).request;
    assert.equal(request.status, "pending");
    assert.equal(request.project_id, "proj");
    assert.equal(request.text, "Fix the blank first paint");
    assert.equal(request.settled_at, null);
    assert.deepEqual(request.created_refs, []);

    const listed = dataOf(await call("GET", "/api/v1/intake?status=pending&project_id=proj"));
    assert.ok(listed.requests.some((row) => row.id === request.id));

    const read = dataOf(await call("GET", `/api/v1/intake/${request.id}`)).request;
    assert.equal(read.id, request.id);
  });

  it("returns the first request for a repeated idempotency key", async () => {
    const first = dataOf(
      await call("POST", "/api/v1/intake", { project_id: "proj", text: "a", idem: "click-1" }),
    ).request;
    const second = dataOf(
      await call("POST", "/api/v1/intake", { project_id: "proj", text: "b", idem: "click-1" }),
    ).request;
    assert.equal(second.id, first.id);
    assert.equal(second.text, "a");
  });

  it("refuses an empty description and an unknown project", async () => {
    const empty = await call("POST", "/api/v1/intake", { project_id: "proj", text: "  " });
    assert.equal(empty.status, 400);
    assert.equal(errorOf(empty).code, "VALIDATION_FAILED");

    const unknown = await call("POST", "/api/v1/intake", { project_id: "nope", text: "a" });
    assert.equal(unknown.status, 400);
    assert.equal(errorOf(unknown).code, "VALIDATION_FAILED");
  });

  it("an unknown id is INTAKE_NOT_FOUND", async () => {
    const missing = await call("GET", "/api/v1/intake/missing");
    assert.equal(missing.status, 404);
    assert.equal(errorOf(missing).code, "INTAKE_NOT_FOUND");
  });
});

describe("server/routes.intake — settlement", () => {
  it("complete records the refs; a repeat converges; fail afterwards is a conflict", async () => {
    const request = dataOf(
      await call("POST", "/api/v1/intake", { project_id: "proj", text: "a" }),
    ).request;

    const completed = dataOf(
      await call("POST", `/api/v1/intake/${request.id}/complete`, {
        created: ["TP-1", "TP-2"],
      }),
    ).request;
    assert.equal(completed.status, "consumed");
    assert.deepEqual(completed.created_refs, ["TP-1", "TP-2"]);
    assert.ok(completed.settled_at);

    const again = dataOf(
      await call("POST", `/api/v1/intake/${request.id}/complete`, { created: ["TP-9"] }),
    ).request;
    assert.deepEqual(again.created_refs, ["TP-1", "TP-2"]);

    const conflict = await call("POST", `/api/v1/intake/${request.id}/fail`, {
      reason: "too late",
    });
    assert.equal(conflict.status, 409);
    assert.equal(errorOf(conflict).code, "INVALID_TRANSITION");
  });

  it("fail records the reason and converges on repeat", async () => {
    const request = dataOf(
      await call("POST", "/api/v1/intake", { project_id: "proj", text: "a" }),
    ).request;
    const failed = dataOf(
      await call("POST", `/api/v1/intake/${request.id}/fail`, { reason: "not work" }),
    ).request;
    assert.equal(failed.status, "failed");
    assert.equal(failed.last_error, "not work");
    assert.equal(failed.created_refs.length, 0);

    const again = dataOf(
      await call("POST", `/api/v1/intake/${request.id}/fail`, { reason: "again" }),
    ).request;
    assert.equal(again.last_error, "not work");
  });

  it("complete refuses an empty created list", async () => {
    const request = dataOf(
      await call("POST", "/api/v1/intake", { project_id: "proj", text: "a" }),
    ).request;
    const result = await call("POST", `/api/v1/intake/${request.id}/complete`, { created: [] });
    assert.equal(result.status, 400);
    assert.equal(errorOf(result).code, "VALIDATION_FAILED");
  });
});
