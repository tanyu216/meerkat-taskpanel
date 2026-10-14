/**
 * The two halves of T-20261014-152924, over the **real HTTP surface**.
 *
 * This is the layer the board actually talks to (`web/src/services/api.js` →
 * `POST /api/v1/tasks/:ref/move`), so it is the layer where the report has to
 * hold: a drag that used to end in a raw SQLite sentence must end in a 200 with
 * a released claim, and every refusal that *does* come back must carry a message
 * a reader can act on.
 *
 *   ③ — no error envelope's `message` contains storage-engine text
 *        (`/constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE
 *        constraint/`). The engine's own words stay on `details.sqlite` and the
 *        server log.
 *   ② — the reported sequence (`in_progress → todo → backlog`) completes, and
 *        the card that lands in `backlog` carries `claimed_by: null`.
 *
 * The failures driven below are the ones real routes can produce — the mapper's
 * branches are enumerated directly in
 * `test/core/storage/sqlite-errors.test.mjs`, and the state that would reach the
 * backlog CHECK is reachable only by a foreign writer
 * (`test/contract/invariants.test.mjs`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";

/** The acceptance-③ predicate, spelled exactly as the card spells it. */
const ENGINE_TEXT = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;

const tempDirs = [];
let taskd;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-envelope-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const asAgent = (id) => ({ "x-taskctl-actor": JSON.stringify({ kind: "agent", id }) });

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

/** A project to hang the cards on (created once, reused by every case). */
async function project(name) {
  const created = await call("POST", "/api/v1/projects", { name });
  if (created.body.ok) return dataOf(created).project.id;
  // Already there (a second run in the same process) — read it back.
  const list = dataOf(await call("GET", "/api/v1/projects"));
  return list.projects.find((entry) => entry.name === name).id;
}

describe("server/error-envelope — ③ engine text never reaches a message", () => {
  it("answers every refusing route with a readable sentence", async () => {
    const projectId = await project("Envelope");
    const card = dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Seed" })).task;
    // The routing lock only exists on an *assigned* card: an unassigned one is
    // an open pool (domain/claim.mjs#isAssignee).
    const assigned = dataOf(
      await call("POST", "/api/v1/tasks", { project_id: projectId, title: "For linus", assignee: "linus" }),
    ).task;

    /** `[label, method, path, body, headers]` — one real refusal per family. */
    const refusals = [
      // NOT_FOUND: a card that does not exist.
      ["unknown card", "GET", "/api/v1/tasks/NOPE-0001", undefined, {}],
      ["unknown project task", "POST", "/api/v1/tasks", { project_id: "nope", title: "x" }, {}],
      // INVALID_TRANSITION: the whitelist, in words.
      ["illegal move", "POST", `/api/v1/tasks/${card.identifier}/move`, { to: "done" }, {}],
      // REPORT_REQUIRED: the delivery gate.
      ["delivery gate", "POST", `/api/v1/tasks/${card.identifier}/move`, { to: "in_review" }, {}],
      // IDENTIFIER_CONFLICT: a duplicate identifier, through the unique index.
      [
        "duplicate identifier",
        "POST",
        "/api/v1/tasks",
        { project_id: projectId, title: "Dup", identifier: card.identifier },
        {},
      ],
      // VALIDATION_FAILED from a body the router refuses before any handler.
      ["malformed body", "POST", "/api/v1/tasks", { project_id: projectId }, { "content-type": "application/json" }],
      // not_assignee: the routing lock.
      [
        "routing lock",
        "POST",
        `/api/v1/tasks/${assigned.identifier}/move`,
        { to: "in_progress" },
        asAgent("somebody-else"),
      ],
    ];

    for (const [label, method, path, body, headers] of refusals) {
      // A malformed body is sent as text so the router's own reader refuses it.
      const result =
        label === "malformed body"
          ? await fetch(`${base}${path}`, { method, headers, body: "{not json" }).then(async (r) => ({
              status: r.status,
              body: JSON.parse(await r.text()),
            }))
          : await call(method, path, body, headers);

      assert.ok(result.status >= 400, `${label}: expected a refusal, got ${result.status}`);
      assert.equal(result.body.ok, false, label);
      const { message, code } = result.body.error;
      assert.equal(typeof message, "string", label);
      assert.equal(ENGINE_TEXT.test(message), false, `${label} (${code}): ${message}`);
      assert.notEqual(message.trim(), "", label);
    }
  });
});

describe("server/error-envelope — ② Terry's drag, end to end", () => {
  it("moves a claimed card back to Backlog and leaves no claim behind", async () => {
    const projectId = await project("Terry");
    const card = dataOf(await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Claimed work" })).task;
    assert.equal(card.status, "todo");
    assert.equal(card.claimed_by, null);

    // 1. Claim it — the same request a `todo → in_progress` drag sends.
    const claimed = dataOf(
      await call("POST", `/api/v1/tasks/${card.identifier}/move`, { to: "in_progress" }, asAgent("linus")),
    ).task;
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.claimed_by, "linus");
    assert.equal(typeof claimed.heartbeat_at, "string");

    // 2. Drag it back to Todo. This is the leg that used to leave the lock.
    const todo = dataOf(await call("POST", `/api/v1/tasks/${card.identifier}/move`, { to: "todo" }, asAgent("linus"))).task;
    assert.equal(todo.status, "todo");
    assert.equal(todo.claimed_by, null);
    assert.equal(todo.claimed_at, null);
    assert.equal(todo.heartbeat_at, null);

    // 3. Drag it to Backlog — legal from `todo`, and the write the CHECK used to
    //    refuse with `CHECK constraint failed: claimed_by IS NULL OR status <>
    //    'backlog'`.
    const backlog = await call("POST", `/api/v1/tasks/${card.identifier}/move`, { to: "backlog" }, asAgent("linus"));
    assert.equal(backlog.status, 200, JSON.stringify(backlog.body));
    const stored = dataOf(backlog).task;
    assert.equal(stored.status, "backlog");
    assert.equal(stored.claimed_by, null);

    // ...and the row the service reads back agrees with the row it returned.
    const reread = dataOf(await call("GET", `/api/v1/tasks/${card.identifier}`)).task;
    assert.equal(reread.status, "backlog");
    assert.equal(reread.claimed_by, null);
  });
});
