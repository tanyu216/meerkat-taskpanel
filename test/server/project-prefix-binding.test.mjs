/**
 * C-PREFIX-1 §9 C — the contract's container-run legs, over real HTTP.
 *
 * The unit level (`test/core/commands/project-prefix-binding.test.mjs`) pins the
 * use-case rules; this file pins the wire the UI and the CLI actually speak:
 * `POST /api/v1/projects` with `{ name, meta: { prefix } }` is the **only** body
 * `CreateProjectModal.vue` sends (no `id`), and the same route with an `id` and
 * no prefix is what `taskctl project create` sends. Both must end up numbering
 * cards the same way the contract's example table says, and the two refusal
 * paths — M4's unusable declared prefix and M5's taken one — must land as 400s
 * that leave no row behind.
 *
 * Every case gets its own temp board: C1 and C3 deliberately claim the *same*
 * prefix from the two different carriers, which is the whole point of M5, so
 * they cannot share one.
 *
 * Driven over real HTTP against a temp board, like the rest of `test/server/`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";
import { identifierPrefix } from "../../src/shared/ids.mjs";

const tempDirs = [];
const daemons = [];

after(async () => {
  for (const taskd of daemons) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway board plus the two calls every case needs, so a case reads as the
 * contract's example table rather than as harness plumbing.
 */
async function board(fn) {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-prefix-"));
  tempDirs.push(dir);
  const taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  daemons.push(taskd);

  const call = async (method, path, body) => {
    const response = await fetch(`${taskd.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  };

  const dataOf = (result) => {
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    return result.body.data;
  };

  /** Create a card and hand back its identifier (the wire's `identifier`). */
  const card = async (projectId, title) =>
    dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title })).task.identifier;

  /** The projects the board currently lists — what C6 checks absence against. */
  const listed = async () => dataOf(await call("GET", "/api/v1/projects")).projects;

  return fn({ call, dataOf, card, listed });
}

describe("C-PREFIX-1 §9 C — the prefix over the wire", () => {
  it("C1/C2 · a UI create (no id, meta.prefix) numbers its cards DEMO-0001…", async () => {
    await board(async ({ call, dataOf, card }) => {
      const created = await call("POST", "/api/v1/projects", { name: "Demo", meta: { prefix: "demo" } });
      assert.ok(created.status === 200 || created.status === 201, `status ${created.status}`);
      const project = dataOf(created).project;
      assert.equal(project.name, "Demo");
      assert.equal(project.meta.prefix, "DEMO", "the stored prefix is the normalized one");

      assert.equal(await card(project.id, "one"), "DEMO-0001");
      assert.equal(await card(project.id, "two"), "DEMO-0002");
    });
  });

  it("C3 · a project created with an id and no prefix still numbers DEMO-0001…", async () => {
    await board(async ({ call, dataOf, card }) => {
      // Exactly `taskctl project create --id demo --name Demo`: no meta at all.
      const project = dataOf(await call("POST", "/api/v1/projects", { id: "demo", name: "Demo" })).project;
      assert.equal(project.id, "demo");
      assert.equal(Object.hasOwn(project.meta, "prefix"), false, "nothing was declared, so nothing is stored");

      assert.equal(await card("demo", "one"), "DEMO-0001");
    });
  });

  it("C4 · the two carriers cannot both own DEMO", async () => {
    await board(async ({ call, dataOf, listed }) => {
      dataOf(await call("POST", "/api/v1/projects", { id: "demo", name: "From the CLI" }));

      const clash = await call("POST", "/api/v1/projects", { name: "From the UI", meta: { prefix: "demo" } });
      assert.equal(clash.status, 400);
      assert.equal(clash.body.error.code, "VALIDATION_FAILED");
      assert.equal(clash.body.error.details.prefix, "DEMO");
      assert.equal(clash.body.error.details.conflictProjectId, "demo");
      assert.equal(clash.body.error.details.field, "meta.prefix");

      assert.deepEqual((await listed()).map((p) => p.id), ["demo"], "a refused create lands no row");
    });
  });

  it("C5 · the same id twice is a 409, not a prefix refusal", async () => {
    await board(async ({ call, dataOf }) => {
      dataOf(await call("POST", "/api/v1/projects", { id: "demo", name: "First" }));
      const again = await call("POST", "/api/v1/projects", { id: "demo", name: "Second" });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "ID_CONFLICT");
    });
  });

  it("C6 · `####` is refused and the project is not in the list", async () => {
    await board(async ({ call, listed }) => {
      const refused = await call("POST", "/api/v1/projects", { name: "x", meta: { prefix: "####" } });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, "VALIDATION_FAILED");
      assert.equal(refused.body.error.details.field, "meta.prefix");

      assert.equal((await listed()).length, 0, "the zombie project never existed");
    });
  });

  it("C7 · a project that predates the slot keeps the identifier its UUID gives it", async () => {
    await board(async ({ call, dataOf, card }) => {
      const project = dataOf(await call("POST", "/api/v1/projects", { name: "Legacy" })).project;
      assert.equal(await card(project.id, "one"), `${identifierPrefix(project.id)}-0001`);
    });
  });

  it("C6′ · an update cannot put a prefix on a project that was created without one", async () => {
    await board(async ({ call, dataOf, card }) => {
      // M6 over the wire: `meta` merges, so the body cannot tell a delta from a
      // replacement — the stored slot has to win, and for a legacy project
      // there is no slot to win, so HIJACK must never become a prefix.
      const project = dataOf(await call("POST", "/api/v1/projects", { name: "Legacy" })).project;
      dataOf(await call("PATCH", `/api/v1/projects/${project.id}`, { meta: { prefix: "HIJACK" } }));

      assert.equal(await card(project.id, "one"), `${identifierPrefix(project.id)}-0001`);
    });
  });
});
