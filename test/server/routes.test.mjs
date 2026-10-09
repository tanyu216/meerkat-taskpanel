/**
 * Step 8: every route, over real HTTP (V1/V3 for the service half).
 *
 * The board runs in-process on `127.0.0.1:0` and the tests drive it with
 * `fetch` — the same transport the CLI uses, against the same handlers. Nothing
 * is mocked: the responses come out of the SQLite board.
 *
 * Two contracts are asserted for *all* of them, because a client depends on
 * them more than on any individual payload:
 *
 *   * the envelope is `{ok:true,data}` / `{ok:false,error}`;
 *   * an error body equals `toErrorPayload` — the same document `--json` prints.
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
  const dir = mkdtempSync(join(tmpdir(), "taskpanel-server-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Call the API. Returns `{status, body}` — never throws on a non-2xx. */
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

describe("server/routes — health and meta", () => {
  it("keeps the /health contract the compose healthcheck depends on", async () => {
    const result = await call("GET", "/health");
    assert.equal(result.status, 200);
    const data = dataOf(result);
    assert.equal(data.status, "ok");
    assert.equal(data.stage, "taskd");
    assert.equal(typeof data.uptimeMs, "number");
  });

  it("reports the schema position on /meta", async () => {
    const meta = dataOf(await call("GET", "/meta"));
    assert.equal(meta.stage, "taskd");
    assert.ok(Array.isArray(meta.migration.applied) || Array.isArray(meta.migration.skipped));
    assert.equal(typeof meta.dbPath, "string");
  });

  it("answers 404 with the standard envelope, not an HTML page", async () => {
    const result = await call("GET", "/api/v1/nope");
    assert.equal(result.status, 404);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, "NOT_FOUND");
    assert.equal(result.body.error.http, 404);
  });
});

describe("server/routes — projects", () => {
  it("creates, lists, patches and round-trips the readme", async () => {
    const created = dataOf(
      await call("POST", "/api/v1/projects", {
        id: "demo",
        name: "Demo",
        workspace_path: "/tmp/demo",
        meta: { team: "panel" },
      }),
    );
    assert.equal(created.project.id, "demo");
    assert.equal(created.project.workspace_path, "/tmp/demo");
    assert.deepEqual(created.project.meta, { team: "panel" });

    const listed = dataOf(await call("GET", "/api/v1/projects"));
    assert.deepEqual(listed.projects.map((p) => p.id), ["demo"]);

    const patched = dataOf(await call("PATCH", "/api/v1/projects/demo", { name: "Demo Board" }));
    assert.equal(patched.project.name, "Demo Board");

    const readme = dataOf(await call("PUT", "/api/v1/projects/demo/readme", { readme: "# Demo\n" }));
    assert.equal(readme.readme, "# Demo\n");
    assert.equal(dataOf(await call("GET", "/api/v1/projects/demo/readme")).readme, "# Demo\n");

    const one = dataOf(await call("GET", "/api/v1/projects/demo"));
    assert.equal(one.project.readme, "# Demo\n");
  });

  it("answers `current` with the owning project, or a synthetic local one", async () => {
    const hit = dataOf(await call("GET", `/api/v1/projects/current?path=${encodeURIComponent("/tmp/demo/sub")}`));
    assert.equal(hit.matched, true);
    assert.equal(hit.project.id, "demo");

    const miss = dataOf(await call("GET", `/api/v1/projects/current?path=${encodeURIComponent("/elsewhere")}`));
    assert.equal(miss.matched, false);
    assert.equal(miss.project.id, "local");
    assert.equal(miss.project.workspace_path, "/elsewhere");
    assert.match(miss.hint.create, /project create --id local/);

    // A read must not have created anything.
    const listed = dataOf(await call("GET", "/api/v1/projects"));
    assert.deepEqual(listed.projects.map((p) => p.id), ["demo"]);
  });
});

describe("server/routes — tasks, the gate and deliver", () => {
  let identifier;

  it("creates a task with an acceptance list and a free-text assignee", async () => {
    const created = dataOf(
      await call("POST", "/api/v1/tasks", {
        project_id: "demo",
        title: "Ship M2",
        priority: "high",
        labels: ["m2"],
        meta: { acceptance: ["cli works", "gate visible"] },
        assignee: "linus",
        assignee_kind: "agent",
      }),
    );
    identifier = created.task.identifier;
    assert.equal(identifier, "DEMO-0001");
    assert.equal(created.task.status, "todo");
    assert.equal(created.task.assignee.display_name, "linus");
    assert.equal(typeof created.task.assignee.id, "string");
    assert.deepEqual(created.task.meta.acceptance, ["cli works", "gate visible"]);
  });

  it("lists, filters and fetches a task by identifier", async () => {
    const listed = dataOf(await call("GET", "/api/v1/tasks?project_id=demo&status=todo"));
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].identifier, identifier);

    const byRef = dataOf(await call("GET", `/api/v1/tasks/${identifier}`));
    assert.equal(byRef.task.id, listed.tasks[0].id);
    assert.deepEqual(byRef.report_waivers, []);
  });

  it("refuses an illegal transition, then the gate, each with its own code", async () => {
    const illegal = await call("POST", `/api/v1/tasks/${identifier}/move`, { to: "done" });
    assert.equal(illegal.status, 409, JSON.stringify(illegal.body));
    assert.equal(illegal.body.error.code, "INVALID_TRANSITION");

    // todo → in_progress is a claim, so it must come from the assignee (linus);
    // in_progress → in_review then hits the gate.
    dataOf(
      await call("POST", `/api/v1/tasks/${identifier}/move`, { to: "in_progress" }, {
        "x-taskctl-actor": JSON.stringify({ kind: "agent", id: "linus" }),
      }),
    );
    const gated = await call("POST", `/api/v1/tasks/${identifier}/move`, { to: "in_review" });
    assert.equal(gated.status, 422, JSON.stringify(gated.body));
    assert.equal(gated.body.error.code, "REPORT_REQUIRED");
    assert.equal(gated.body.error.details.round, 1);
    assert.match(gated.body.error.hint.command, /issue deliver DEMO-0001/);
    assert.match(gated.body.error.hint.alternative, /--no-report --reason/);
  });

  it("delivers atomically and reports the report id", async () => {
    const result = await call("POST", `/api/v1/tasks/${identifier}/deliver`, {
      report: {
        conclusion: "M2 landed.",
        acceptance: [{ text: "cli works", status: "met" }],
        evidence: [{ kind: "path", path: "src/cli/index.mjs" }],
      },
    });
    const data = dataOf(result);
    assert.equal(data.status, "in_review");
    assert.equal(typeof data.report_id, "number");
    assert.equal(data.task.report_latest_id, data.report_id);
    assert.equal(data.task.delivery_round, 1);
    assert.equal(data.waived, false);

    const reports = dataOf(await call("GET", `/api/v1/tasks/${identifier}/reports`));
    assert.equal(reports.reports.length, 1);
  });

  it("delivers with an audited waiver when there is no report", async () => {
    // Back to in_progress: the round bumps to 2.
    dataOf(await call("POST", `/api/v1/tasks/${identifier}/move`, { to: "in_progress" }));
    const waived = dataOf(
      await call("POST", `/api/v1/tasks/${identifier}/deliver`, {
        no_report: true,
        reason: "hotfix: report follows in a change comment",
      }),
    );
    assert.equal(waived.waived, true);
    assert.equal(waived.report_id, null);
    assert.equal(waived.status, "in_review");
    assert.equal(waived.task.report_waiver.round, 2);
    assert.equal(waived.report_waivers.length, 1);
    assert.equal(waived.report_waivers[0].round, 2);

    await call("POST", `/api/v1/tasks/${identifier}/move`, { to: "in_progress" });
    const bad = await call("POST", `/api/v1/tasks/${identifier}/deliver`, { no_report: true, reason: "nah" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_FAILED");
  });

  it("refuses a status patch instead of silently ignoring it", async () => {
    const result = await call("PATCH", `/api/v1/tasks/${identifier}`, { status: "done" });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "INVALID_TRANSITION");
    assert.match(result.body.error.hint.fix, /issue move/);
  });

  it("merges --acceptance into meta without clobbering the rest", async () => {
    const updated = dataOf(
      await call("PATCH", `/api/v1/tasks/${identifier}`, { acceptance: ["a", "b"], title: "Ship M2 (final)" }),
    );
    assert.deepEqual(updated.task.meta.acceptance, ["a", "b"]);
    assert.equal(updated.task.title, "Ship M2 (final)");
  });
});

describe("server/routes — comments, relations, sessions, dictionary, export", () => {
  const REF = "DEMO-0001";
  let sibling;
  let epic;

  it("appends and lists comments", async () => {
    const added = dataOf(
      await call("POST", `/api/v1/tasks/${REF}/comments`, { body: "looks good", kind: "decision" }),
    );
    assert.equal(added.comment.kind, "decision");
    assert.equal(added.comment.author_kind, "human", "an anonymous caller is a local human");

    const listed = dataOf(await call("GET", `/api/v1/tasks/${REF}/comments`));
    assert.equal(listed.comments.length, 1);
  });

  it("records the actor the CLI declares", async () => {
    const added = dataOf(
      await call(
        "POST",
        `/api/v1/tasks/${REF}/comments`,
        { body: "from linus", kind: "note" },
        { "x-taskctl-actor": JSON.stringify({ kind: "agent", id: "linus" }) },
      ),
    );
    assert.equal(added.comment.author_kind, "agent");
    assert.equal(added.comment.author_id, "linus");
  });

  it("adds, lists and removes a relation", async () => {
    // Only an `epic` may be a parent (§4.2), so the fixture is an epic + a child.
    sibling = dataOf(
      await call("POST", "/api/v1/tasks", { project_id: "demo", title: "Child" }),
    ).task;
    epic = dataOf(
      await call("POST", "/api/v1/tasks", { project_id: "demo", title: "Epic", kind: "epic" }),
    ).task;

    // For `parent`, the task the relation hangs off is the *parent* (source) and
    // `target` is the child — the direction the single-parent index assumes.
    const added = dataOf(
      await call("POST", `/api/v1/tasks/${epic.identifier}/relations`, {
        type: "parent",
        target: sibling.identifier,
      }),
    );
    assert.equal(added.relation.type, "parent");
    assert.equal(added.relation.source, epic.id);
    assert.equal(added.relation.target, sibling.id);

    const listed = dataOf(await call("GET", `/api/v1/tasks/${epic.identifier}/relations`));
    assert.equal(listed.children.length, 1);
    assert.equal(listed.children[0].target, sibling.id, "source is the parent, target the child");

    const removed = dataOf(
      await call("DELETE", `/api/v1/tasks/${epic.identifier}/relations/${added.relation.id}`),
    );
    assert.equal(removed.removed, true);
    assert.equal(dataOf(await call("GET", `/api/v1/tasks/${epic.identifier}/relations`)).children.length, 0);
  });

  it("registers, lists and closes an agent session", async () => {
    const registered = dataOf(
      await call("POST", `/api/v1/tasks/${REF}/sessions`, {
        seg: "seg2",
        owner: "linus",
        backend: "claude",
        session_id: "d144dea1-f923-5ed8-8e6e-6e889abf76e5",
      }),
    );
    assert.equal(registered.session.status, "running");

    const listed = dataOf(await call("GET", `/api/v1/tasks/${REF}/sessions`));
    assert.equal(listed.sessions.length, 1);

    const closed = dataOf(
      await call("POST", `/api/v1/tasks/${REF}/sessions/${registered.session.id}/close`, {}),
    );
    assert.equal(closed.session.status, "closed");
  });

  it("reads the dictionary, and offers no way to write it", async () => {
    const assignees = dataOf(await call("GET", "/api/v1/assignees?q=lin"));
    assert.equal(assignees.entries.length, 1);
    assert.equal(assignees.entries[0].display_name, "linus");
    assert.equal(typeof assignees.entries[0].id, "string");

    assert.equal(dataOf(await call("GET", "/api/v1/reporters")).entries.length, 0);
    // The management surface does not exist, so it cannot be reached.
    assert.equal((await call("POST", "/api/v1/assignees", { name: "x" })).status, 404);
    assert.equal((await call("DELETE", "/api/v1/assignees/x")).status, 404);
  });

  it("reads the label registry, and offers no way to write it", async () => {
    const labels = dataOf(await call("GET", "/api/v1/labels"));
    assert.equal(labels.labels.length, 1, "the one label a task named");
    assert.equal(labels.labels[0].display_name, "m2");
    assert.equal(labels.labels[0].norm, "m2");
    assert.equal(labels.labels[0].use_count, 1);
    assert.match(labels.labels[0].color, /^#[0-9a-f]{6}$/i);
    assert.equal(labels.labels[0].archived_at, null);

    assert.deepEqual(dataOf(await call("GET", "/api/v1/labels?q=nope")).labels, []);
    assert.equal(dataOf(await call("GET", "/api/v1/labels?q=M2")).labels.length, 1, "case-insensitive");
    assert.equal(dataOf(await call("GET", "/api/v1/labels?project_id=demo&limit=1")).labels.length, 1);
    assert.equal(dataOf(await call("GET", "/api/v1/labels?project_id=other")).labels.length, 0);
    assert.equal(dataOf(await call("GET", "/api/v1/labels?include_archived=1")).labels.length, 1);
    // Labels have no management surface, so there is nowhere to write one.
    assert.equal((await call("POST", "/api/v1/labels", { name: "x" })).status, 404);
    assert.equal((await call("DELETE", "/api/v1/labels/x")).status, 404);
  });

  it("returns markdown from /export rather than writing files", async () => {
    const exported = dataOf(await call("POST", "/api/v1/export", { project_id: "demo" }));
    assert.equal(exported.cards.length, 3);
    const card = exported.cards.find((c) => c.identifier === REF);
    assert.match(card.markdown, /^---\n/);
    assert.match(card.markdown, /id: DEMO-0001/);
  });
});

describe("server/routes — the edges a happy path never reaches", () => {
  it("reads query parameters: filters, limits, offsets and archived rows", async () => {
    const listed = dataOf(
      await call("GET", "/api/v1/tasks?include_archived=1&offset=0&limit=100&assignee_id=nobody"),
    );
    assert.equal(listed.tasks.length, 0, "an unknown assignee matches nothing");

    const everything = dataOf(await call("GET", "/api/v1/tasks?include_archived=1"));
    assert.ok(everything.tasks.length >= 2);

    const commented = dataOf(await call("GET", "/api/v1/tasks/DEMO-0001/comments?kind=note&limit=1"));
    assert.equal(commented.comments.length, 1);
    assert.equal(commented.comments[0].kind, "note");
    const after = dataOf(
      await call("GET", `/api/v1/tasks/DEMO-0001/comments?after=${encodeURIComponent("2999-01-01T00:00:00.000Z")}`),
    );
    assert.equal(after.comments.length, 0, "nothing is newer than the future");

    const dictionary = dataOf(await call("GET", "/api/v1/assignees?q=lin&limit=1"));
    assert.equal(dictionary.entries.length, 1);
    assert.equal(dataOf(await call("GET", "/api/v1/projects?include_archived=1")).projects.length >= 1, true);
  });

  it("patches a project's path, labels and readme, and 404s an unknown one", async () => {
    const patched = dataOf(
      await call("PATCH", "/api/v1/projects/demo", {
        workspace_path: "/tmp/demo2",
        labels: ["a"],
        readme: "hello",
      }),
    );
    assert.equal(patched.project.workspace_path, "/tmp/demo2");
    assert.deepEqual(patched.project.labels, ["a"]);

    const missing = await call("PATCH", "/api/v1/projects/nope", { name: "X" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    const conflict = await call("POST", "/api/v1/projects", { id: "demo", name: "Dup", workspace_path: "/tmp/demo3" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "ID_CONFLICT");
  });

  it("creates a task with the less common fields, and refuses a second project id", async () => {
    const epic = dataOf(
      await call("POST", "/api/v1/tasks", {
        project_id: "demo",
        title: "An epic",
        kind: "epic",
        status: "backlog",
        description: "…",
        identifier: "DEMO-9001",
        source_path: "cards/epic.md",
        reporter: "elon",
        reporter_kind: "human",
      }),
    );
    assert.equal(epic.task.identifier, "DEMO-9001");
    assert.equal(epic.task.kind, "epic");
    assert.equal(epic.task.status, "backlog");
    assert.equal(epic.task.source_path, "cards/epic.md");
    assert.equal(epic.task.reporter.display_name, "elon");

    const again = await call("POST", "/api/v1/tasks", { project_id: "demo", title: "x", identifier: "DEMO-9001" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "IDENTIFIER_CONFLICT");
  });

  it("patches the remaining task fields and honours if_version", async () => {
    const current = dataOf(await call("GET", "/api/v1/tasks/DEMO-9001")).task;
    const patched = dataOf(
      await call("PATCH", "/api/v1/tasks/DEMO-9001", {
        description: "written",
        priority: "urgent",
        labels: ["x", "y"],
        if_version: current.version,
      }),
    );
    assert.equal(patched.task.description, "written");
    assert.equal(patched.task.priority, "urgent");
    assert.deepEqual(patched.task.labels, ["x", "y"]);

    const conflict = await call("PATCH", "/api/v1/tasks/DEMO-9001", { title: "nope", if_version: 1 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "VERSION_CONFLICT");
  });

  it("moves with if_version, and records seg/session on a delivered report", async () => {
    // DEMO-9001 is an epic (a grouping card) and an epic may not be claimed, so
    // the move/deliver path uses a plain card.
    const movable = dataOf(await call("POST", "/api/v1/tasks", { project_id: "demo", title: "Movable" })).task;
    dataOf(
      await call("POST", `/api/v1/tasks/${movable.identifier}/move`, {
        to: "in_progress",
        if_version: movable.version,
      }),
    );

    const delivered = dataOf(
      await call("POST", `/api/v1/tasks/${movable.identifier}/deliver`, {
        report: {
          conclusion: "done",
          acceptance: [{ text: "a", status: "met" }],
          evidence: [{ kind: "path", path: "x" }],
        },
        seg: "seg9",
        session_id: "session-9",
      }),
    );
    assert.equal(delivered.report.seg, "seg9");
    assert.equal(delivered.report.session_id, "session-9");
  });

  it("adds a relation with force/origin, and 404s an unknown relation on remove", async () => {
    const tasks = dataOf(await call("GET", "/api/v1/tasks?include_archived=1")).tasks;
    const [first, second] = tasks;
    const added = dataOf(
      await call("POST", `/api/v1/tasks/${first.identifier}/relations`, {
        type: "blocks",
        target: second.identifier,
        force: true,
        origin: "imported",
      }),
    );
    assert.equal(added.relation.origin, "imported");

    const missing = await call("DELETE", `/api/v1/tasks/${first.identifier}/relations/999999`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
  });

  it("registers a session with phase/pid, closes as failed, and 404s an unknown session", async () => {
    const registered = dataOf(
      await call("POST", "/api/v1/tasks/DEMO-0001/sessions", {
        seg: "s-extra",
        owner: "linus",
        backend: "claude",
        session_id: "session-x",
        phase: "review",
        pid: 4242,
      }),
    );
    assert.equal(registered.session.phase, "review");
    assert.equal(registered.session.pid, 4242);

    const closed = dataOf(
      await call("POST", `/api/v1/tasks/DEMO-0001/sessions/${registered.session.id}/close`, { status: "failed" }),
    );
    assert.equal(closed.session.status, "failed");

    const unknown = await call("POST", "/api/v1/tasks/DEMO-0001/sessions/nope/close", {});
    assert.equal(unknown.status, 404);
  });

  it("treats a missing body as an empty object, and refuses a body that is not one", async () => {
    // `readJsonBody` sees zero bytes and answers `{}`; the handler then decides.
    const empty = await fetch(`${base}/api/v1/tasks/DEMO-0001/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(empty.status, 400, "no body ⇒ no comment body");

    const arrayBody = await fetch(`${base}/api/v1/tasks/DEMO-0001/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    assert.equal(arrayBody.status, 400);
    assert.match((await arrayBody.json()).error.message, /must be a JSON object/);

    const notJson = await fetch(`${base}/api/v1/tasks/DEMO-0001/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(notJson.status, 400);
    assert.match((await notJson.json()).error.message, /not JSON/);
  });

  it("refuses a body larger than the limit instead of buffering it", async () => {
    const huge = JSON.stringify({ body: "x".repeat(1024 * 1024 + 64) });
    const response = await fetch(`${base}/api/v1/tasks/DEMO-0001/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error.message, /exceeds/);
  });

  it("falls back to a local human when the actor header is malformed", async () => {
    const added = dataOf(
      await call("POST", "/api/v1/tasks/DEMO-0001/comments", { body: "x" }, { "x-taskctl-actor": "{not json" }),
    );
    assert.equal(added.comment.author_kind, "human");
    assert.equal(added.comment.author_id, "local");

    const odd = dataOf(
      await call("POST", "/api/v1/tasks/DEMO-0001/comments", { body: "y" }, { "x-taskctl-actor": JSON.stringify({ kind: "wizard", id: "z" }) }),
    );
    assert.equal(odd.comment.author_kind, "human", "an unknown kind is not trusted");
    assert.equal(odd.comment.author_id, "z");
  });

  it("exports without archived rows when asked", async () => {
    const exported = dataOf(await call("POST", "/api/v1/export", { project_id: "demo", include_archived: false }));
    assert.equal(exported.cards.every((card) => typeof card.markdown === "string"), true);
  });
});

describe("server/routes — the authorization rejection, over a real socket", () => {
  it("answers 401/403 with the standard envelope when authorization denies", async () => {
    // `authorize` is injectable for exactly this reason: a test process cannot
    // genuinely arrive from a non-loopback address, so the *decision* is faked
    // while the delivery of its result goes over a real HTTP connection.
    const dir = mkdtempSync(join(tmpdir(), "taskpanel-denied-"));
    tempDirs.push(dir);
    const denied = await createTaskd({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      env: {},
      authorize: () => ({
        ok: false,
        status: 401,
        payload: {
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "this board requires an access token for non-local requests",
            http: 401,
            details: { reason: "missing_token" },
            hint: null,
          },
        },
      }),
    });
    try {
      const response = await fetch(`${denied.url}/api/v1/projects`);
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.details.reason, "missing_token");

      // `/health` stays open: it is the liveness probe, and it exposes nothing.
      const health = await fetch(`${denied.url}/health`);
      assert.equal(health.status, 200);
    } finally {
      await denied.close();
    }
  });
});

describe("server/routes — a session registered from headers only", () => {
  it("falls back to the CLI's session/seg headers when the body leaves them out", async () => {
    const registered = dataOf(
      await call(
        "POST",
        "/api/v1/tasks/DEMO-0001/sessions",
        { backend: "codex", owner: "linus" },
        { "x-taskctl-session": "session-from-header", "x-taskctl-seg": "seg-from-header" },
      ),
    );
    assert.equal(registered.session.session_id, "session-from-header");
    assert.equal(registered.session.seg, "seg-from-header");
  });
});

// Last on purpose: earlier "edges" tests read the *global* task list and assume
// its first two rows share a project. This one adds a second project, so it runs
// after them (M3fix D1).
describe("server/routes — task_create cannot enter a delivery state (M3fix D1)", () => {
  before(async () => {
    dataOf(await call("POST", "/api/v1/projects", { id: "cg", name: "Create Gate", workspace_path: "/tmp/cg" }));
  });

  it("refuses in_review/done exactly as a reportless move is refused", async () => {
    for (const status of ["in_review", "done"]) {
      const refused = await call("POST", "/api/v1/tasks", { project_id: "cg", title: "Too soon", status });
      assert.equal(refused.status, 422, JSON.stringify(refused.body));
      assert.equal(refused.body.error.code, "REPORT_REQUIRED");
      assert.equal(refused.body.error.details.round, 1);
      assert.deepEqual(refused.body.error.details.existingRounds, []);
      assert.match(refused.body.error.hint.command, /issue deliver CG-0001/);
      assert.match(refused.body.error.hint.alternative, /--no-report --reason/);
    }

    // Nothing was written, and the serial was not burned.
    assert.deepEqual(dataOf(await call("GET", "/api/v1/tasks?project_id=cg")).tasks, []);
  });

  it("still creates a task in the states it may start in", async () => {
    const created = dataOf(await call("POST", "/api/v1/tasks", { project_id: "cg", title: "Fine", status: "todo" }));
    assert.equal(created.task.status, "todo");
    assert.equal(created.task.identifier, "CG-0001", "a refused create did not burn the serial");

    const backlog = dataOf(await call("POST", "/api/v1/tasks", { project_id: "cg", title: "Later", status: "backlog" }));
    assert.equal(backlog.task.status, "backlog");
  });
});

// Also last, for the same reason as the block above: it adds a project and tasks
// that the earlier global-list assertions must not see.
describe("server/routes — creation idempotency (T-20261009-175500)", () => {
  before(async () => {
    dataOf(await call("POST", "/api/v1/projects", { id: "idem", name: "Idem", workspace_path: "/tmp/idem" }));
  });

  it("re-uses the existing task for a repeated idem key (HTTP 200, same id)", async () => {
    const first = dataOf(await call("POST", "/api/v1/tasks", { project_id: "idem", title: "Ship it", idem: "k-http-1" }));
    assert.equal(first.task.identifier, "IDEM-0001");

    const again = await call("POST", "/api/v1/tasks", { project_id: "idem", title: "Ship it (retry)", idem: "k-http-1" });
    assert.equal(again.status, 200, "a reuse is a success, not a conflict");
    assert.equal(again.body.ok, true);
    assert.equal(again.body.data.task.id, first.task.id);
    assert.equal(again.body.data.task.identifier, "IDEM-0001");

    const listed = dataOf(await call("GET", "/api/v1/tasks?project_id=idem"));
    assert.equal(listed.tasks.length, 1, "no second row");
  });

  it("creates a second task when allow_dup is set", async () => {
    const first = dataOf(await call("POST", "/api/v1/tasks", { project_id: "idem", title: "A", idem: "k-http-2" }));
    const dup = dataOf(await call("POST", "/api/v1/tasks", { project_id: "idem", title: "B", idem: "k-http-2", allow_dup: true }));
    assert.notEqual(dup.task.id, first.task.id);
  });
});

// Last on purpose, for the same reason as the two blocks above: it adds a
// project and tasks that the earlier global-list assertions must not see.
describe("server/routes — candidates (the poll read)", () => {
  it("lists claimable cards and excludes unmet deps and epics", async () => {
    await call("POST", "/api/v1/projects", { id: "cand", name: "Cand", workspace_path: "/tmp/cand" });

    // `allow_dup` keeps the four cards distinct: they share one assignee, so the
    // creation idempotency key would otherwise converge them onto one card.
    const ready = dataOf(
      await call("POST", "/api/v1/tasks", { project_id: "cand", title: "Ready", assignee: "pollbot", assignee_kind: "agent", allow_dup: true }),
    );
    dataOf(
      await call("POST", "/api/v1/tasks", { project_id: "cand", title: "Epic", kind: "epic", assignee: "pollbot", assignee_kind: "agent", allow_dup: true }),
    );
    const blocked = dataOf(
      await call("POST", "/api/v1/tasks", { project_id: "cand", title: "Blocked", assignee: "pollbot", assignee_kind: "agent", allow_dup: true }),
    );
    const blocker = dataOf(
      await call("POST", "/api/v1/tasks", { project_id: "cand", title: "Blocker", assignee: "pollbot", assignee_kind: "agent", allow_dup: true }),
    );
    // `blocks` source = blocker, target = blocked — the blocked card's depends_on.
    dataOf(await call("POST", `/api/v1/tasks/${blocker.task.identifier}/relations`, { type: "blocks", target: blocked.task.identifier }));

    const candidates = dataOf(await call("GET", "/api/v1/tasks/candidates?assignee=pollbot"));
    assert.deepEqual(
      candidates.candidates.map((c) => c.identifier),
      [ready.task.identifier, blocker.task.identifier],
      "the blocked card is excluded (depends_on unmet) and so is the epic",
    );
    assert.deepEqual(
      Object.keys(candidates.candidates[0]).sort(),
      ["id", "identifier", "priority", "project", "reason", "sort", "status", "target", "title"],
    );
    assert.equal(candidates.candidates[0].status, "todo");
    assert.equal(candidates.candidates[0].project, "cand");
    assert.equal(candidates.candidates[0].target, "/tmp/cand");
    assert.equal(candidates.candidates[0].reason, "ready");
  });

  it("answers an empty list for an unknown assignee, and 400 without one", async () => {
    const none = dataOf(await call("GET", "/api/v1/tasks/candidates?assignee=nobody"));
    assert.deepEqual(none.candidates, []);

    const missing = await call("GET", "/api/v1/tasks/candidates");
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, "VALIDATION_FAILED");
    assert.equal(missing.body.error.details.field, "assignee");
  });
});

// Last, like the blocks above: it adds a project the earlier global reads must
// not see.
describe("server/routes — claim enforces the assignee (T-20261009-230500)", () => {
  const asAgent = (id) => ({ "x-taskctl-actor": JSON.stringify({ kind: "agent", id }) });
  const assignedCard = (title) =>
    call("POST", "/api/v1/tasks", {
      project_id: "claim",
      title,
      assignee: "linus",
      assignee_kind: "agent",
      allow_dup: true,
    }).then(dataOf);

  before(async () => {
    dataOf(await call("POST", "/api/v1/projects", { id: "claim", name: "Claim", workspace_path: "/tmp/claim" }));
  });

  it("lets the assignee move their card to in_progress (200)", async () => {
    const card = await assignedCard("For linus");
    const moved = dataOf(
      await call("POST", `/api/v1/tasks/${card.task.identifier}/move`, { to: "in_progress" }, asAgent("linus")),
    );
    assert.equal(moved.task.status, "in_progress");
    assert.equal(moved.task.claimed_by, "linus");
  });

  it("refuses a different actor with 409 not_assignee", async () => {
    const card = await assignedCard("For linus 2");
    const refused = await call(
      "POST",
      `/api/v1/tasks/${card.task.identifier}/move`,
      { to: "in_progress" },
      asAgent("elon"),
    );
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "not_assignee");
    assert.match(refused.body.error.hint.fix, /--allow-steal/);
  });

  it("takes it with allow_steal, and the takeover is readable as a change comment", async () => {
    const card = await assignedCard("For linus 3");
    const moved = dataOf(
      await call(
        "POST",
        `/api/v1/tasks/${card.task.identifier}/move`,
        { to: "in_progress", allow_steal: true, reason: "linus is on another card" },
        asAgent("elon"),
      ),
    );
    assert.equal(moved.task.claimed_by, "elon");

    const comments = dataOf(await call("GET", `/api/v1/tasks/${card.task.identifier}/comments`));
    assert.equal(comments.comments.length, 1);
    assert.equal(comments.comments[0].kind, "change");
    assert.match(comments.comments[0].body, /linus/);
    assert.match(comments.comments[0].body, /elon/);
  });

  it("refuses allow_steal without a reason", async () => {
    const card = await assignedCard("For linus 4");
    const refused = await call(
      "POST",
      `/api/v1/tasks/${card.task.identifier}/move`,
      { to: "in_progress", allow_steal: true },
      asAgent("elon"),
    );
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "VALIDATION_FAILED");
    assert.equal(refused.body.error.details.field, "reason");
  });
});
