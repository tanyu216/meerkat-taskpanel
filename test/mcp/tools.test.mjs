/**
 * The tool matrix: 18 tools, each with a success path and at least one failure
 * path (R4, plan §5.2).
 *
 * Every case here runs against a **real `taskd`** over loopback, with a real
 * `createBoardClient` in between — the same three processes production runs. That
 * is slower than mocking the HTTP layer and it is the entire point: a mock would
 * let a test pass while the tool's argument names and the route's body fields had
 * quietly drifted apart, which is the one failure a proxy this thin is actually
 * exposed to.
 *
 * The two boards are shared per `describe`, so the file costs two daemons rather
 * than twenty. Tests inside a `describe` run in order, which is why the "success"
 * board seeds once and then walks a plausible workflow through it.
 *
 * Every failure asserts an **exact code**. "It failed" is not a contract; the
 * code is what a caller branches on, and the code is what proves the failure
 * came from the service rather than from a local opinion.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { TOOL_NAMES } from "../../src/mcp/index.mjs";
import {
  baseEnv,
  cleanupTempDirs,
  closedPortUrl,
  createMcpSession,
  dataOf,
  makeTempDir,
  runCli,
  startTaskd,
} from "./helpers/mcp-harness.mjs";

after(cleanupTempDirs);

const REPORT = {
  conclusion: "M3: the MCP surface is a thin proxy and the gate survives it.",
  acceptance: [{ text: "mcp works", status: "met" }],
  evidence: [{ kind: "path", path: "src/mcp/server.mjs" }],
};

/**
 * A board plus an in-process MCP session bound to it, and the CLI bound to the
 * same board for seeding. Everything a `describe` needs to get going.
 */
async function openBoard() {
  const taskd = await startTaskd();
  const session = createMcpSession({ url: taskd.url, token: taskd.token, env: baseEnv() });
  return {
    taskd,
    session,
    run: (args, opts = {}) => runCli(args, { url: taskd.url, dataDir: taskd.dataDir, ...opts }),
    close: () => taskd.close(),
  };
}

/** The `--json` `data` half of a seeding command; throws when the command failed. */
function seed(run, args) {
  const result = run([...args, "--json"]);
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}`);
  return dataOf(result);
}

describe("mcp/tools — success matrix (18 tools)", () => {
  /** @type {Awaited<ReturnType<typeof openBoard>>} */
  let board;

  before(async () => {
    board = await openBoard();
    seed(board.run, ["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", board.taskd.dataDir]);
    seed(board.run, [
      "issue", "create",
      "--project", "demo",
      "--title", "Ship M3",
      "--acceptance", "mcp works",
      "--assignee", "linus",
      "--reporter", "elon",
      "--label", "bug",
    ]);
    seed(board.run, ["issue", "create", "--project", "demo", "--title", "Second card"]);
    // A `parent` edge must point at an epic (ARCHITECTURE §4.1), so the relation
    // cases need one — and it has to be an epic for a *real* reason, not a
    // workaround.
    seed(board.run, ["issue", "create", "--project", "demo", "--title", "Epic", "--kind", "epic"]);
  });

  after(async () => {
    if (board) await board.close();
  });

  it("project_list returns the projects a task can belong to", async () => {
    const result = await board.session.call("project_list", {});
    assert.equal(result.isError, false);
    const ids = result.payload.projects.map((project) => project.id);
    assert.ok(ids.includes("demo"), `expected demo in ${JSON.stringify(ids)}`);
  });

  it("task_get reads one task by its human identifier", async () => {
    const result = await board.session.call("task_get", { ref: "DEMO-0001" });
    assert.equal(result.isError, false);
    assert.equal(result.payload.task.identifier, "DEMO-0001");
    assert.equal(result.payload.task.status, "todo");
    assert.equal(result.payload.task.delivery_round, 1, "a fresh task is on round 1");
  });

  it("task_list filters by status and honours limit", async () => {
    const all = await board.session.call("task_list", { project_id: "demo" });
    assert.equal(all.payload.tasks.length, 3);

    const todos = await board.session.call("task_list", { status: ["todo"], project_id: "demo" });
    assert.equal(todos.payload.tasks.length, 3, "status accepts an array");

    const one = await board.session.call("task_list", { limit: 1, project_id: "demo" });
    assert.equal(one.payload.tasks.length, 1);
  });

  it("task_create makes a task and returns its generated identifier", async () => {
    const result = await board.session.call("task_create", {
      project_id: "demo",
      title: "Third",
      priority: "high",
      labels: ["bug"],
      acceptance: ["it exists"],
    });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.equal(result.payload.task.identifier, "DEMO-0004");
    assert.deepEqual(result.payload.task.meta.acceptance, ["it exists"], "acceptance folds into meta");
  });

  it("task_update patches fields and merges meta instead of replacing it", async () => {
    const result = await board.session.call("task_update", {
      ref: "DEMO-0004",
      priority: "urgent",
      meta: { team: "panel" },
    });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.equal(result.payload.task.priority, "urgent");
    assert.equal(result.payload.task.meta.team, "panel");
    assert.deepEqual(result.payload.task.meta.acceptance, ["it exists"], "the earlier meta survived the merge");
  });

  it("label_list returns labels with their colours", async () => {
    const result = await board.session.call("label_list", { project_id: "demo" });
    assert.equal(result.isError, false);
    const bug = result.payload.labels.find((label) => label.norm === "bug");
    assert.ok(bug, `expected the bug label in ${JSON.stringify(result.payload.labels.map((l) => l.norm))}`);
    assert.match(bug.color, /^#[0-9a-f]{6}$/i);
  });

  it("assignee_list and reporter_list return the dictionary", async () => {
    const assignees = await board.session.call("assignee_list", {});
    assert.equal(assignees.isError, false);
    assert.ok(assignees.payload.assignees.some((entry) => entry.display_name === "linus"));

    const reporters = await board.session.call("reporter_list", {});
    assert.equal(reporters.isError, false);
    assert.ok(reporters.payload.reporters.some((entry) => entry.display_name === "elon"));
  });

  it("task_comment_add appends, and task_comment_list reads it back", async () => {
    const added = await board.session.call("task_comment_add", {
      ref: "DEMO-0001",
      body: "starting the segment",
      kind: "note",
    });
    assert.equal(added.isError, false, JSON.stringify(added.payload));
    assert.equal(added.payload.comment.body, "starting the segment");

    const listed = await board.session.call("task_comment_list", { ref: "DEMO-0001" });
    assert.equal(listed.isError, false);
    assert.equal(listed.payload.comments.length, 1);
    assert.equal(listed.payload.comments[0].kind, "note");
  });

  it("task_relation_add relates two cards, and task_relation_list shows both directions", async () => {
    // `parent` reads source → target: ref is the *parent*, target the child.
    const added = await board.session.call("task_relation_add", {
      ref: "DEMO-0003",
      type: "parent",
      target: "DEMO-0002",
    });
    assert.equal(added.isError, false, JSON.stringify(added.payload));
    assert.equal(added.payload.relation.type, "parent");

    const childView = await board.session.call("task_relation_list", { ref: "DEMO-0002" });
    assert.equal(childView.payload.relations.length, 1);
    assert.equal(childView.payload.ancestors.length, 1, "DEMO-0002 has an ancestor");

    const parentView = await board.session.call("task_relation_list", { ref: "DEMO-0003" });
    assert.equal(parentView.payload.children.length, 1, "DEMO-0003 has a child");
  });

  it("task_relation_remove drops a relation by its id", async () => {
    const listed = await board.session.call("task_relation_list", { ref: "DEMO-0002" });
    const relationId = listed.payload.relations[0].id;

    const removed = await board.session.call("task_relation_remove", { ref: "DEMO-0002", relation_id: relationId });
    assert.equal(removed.isError, false, JSON.stringify(removed.payload));
    assert.equal(removed.payload.removed, true);

    const after_ = await board.session.call("task_relation_list", { ref: "DEMO-0002" });
    assert.equal(after_.payload.relations.length, 0);
  });

  it("session_set registers a session with a deterministic id", async () => {
    const first = await board.session.call("session_set", {
      ref: "DEMO-0001",
      seg: "seg1",
      backend: "claude",
      owner: "linus",
    });
    assert.equal(first.isError, false, JSON.stringify(first.payload));
    assert.equal(first.payload.session.status, "running");
    assert.equal(typeof first.payload.session.session_id, "string");

    // The natural key is (task, owner, seg): re-registering refreshes in place.
    const again = await board.session.call("session_set", {
      ref: "DEMO-0001",
      seg: "seg1",
      backend: "claude",
      owner: "linus",
      phase: "seg1-impl",
    });
    assert.equal(again.payload.session.id, first.payload.session.id, "one session per (task, owner, seg)");
    assert.equal(again.payload.session.phase, "seg1-impl");
  });

  it("session_list shows it, and session_close ends it", async () => {
    const listed = await board.session.call("session_list", { ref: "DEMO-0001" });
    assert.equal(listed.isError, false);
    assert.equal(listed.payload.sessions.length, 1);

    const closed = await board.session.call("session_close", {
      ref: "DEMO-0001",
      session_id: listed.payload.sessions[0].id,
    });
    assert.equal(closed.isError, false, JSON.stringify(closed.payload));
    assert.equal(closed.payload.session.status, "closed");
  });

  it("task_move walks an allowed transition", async () => {
    const result = await board.session.call("task_move", { ref: "DEMO-0001", to: "in_progress" });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.equal(result.payload.task.status, "in_progress");
  });

  it("task_deliver writes the report and enters review in one call", async () => {
    const result = await board.session.call("task_deliver", { ref: "DEMO-0001", report: REPORT });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.equal(result.payload.status, "in_review");
    assert.equal(result.payload.waived, false);
    assert.equal(typeof result.payload.report_id, "number");

    const read = await board.session.call("task_get", { ref: "DEMO-0001" });
    assert.equal(read.payload.task.status, "in_review");
    assert.equal(read.payload.task.report_latest_id, result.payload.report_id);
  });
});

describe("mcp/tools — failure matrix (every tool, and every stable code)", () => {
  /** @type {Awaited<ReturnType<typeof openBoard>>} */
  let board;

  before(async () => {
    board = await openBoard();
    // A workspace path is unique across projects, so the second one needs its own.
    seed(board.run, ["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", board.taskd.dataDir]);
    seed(board.run, ["project", "create", "--id", "other", "--name", "Other", "--workspace-path", join(board.taskd.dataDir, "other")]);
    seed(board.run, ["issue", "create", "--project", "demo", "--title", "Ship M3"]);
    seed(board.run, ["issue", "create", "--project", "demo", "--title", "Sibling"]);
    seed(board.run, ["issue", "create", "--project", "demo", "--title", "Epic", "--kind", "epic"]);
    seed(board.run, ["issue", "create", "--project", "other", "--title", "Elsewhere"]);
  });

  after(async () => {
    if (board) await board.close();
  });

  it("refuses an undeclared argument for all 18 tools, uniformly", async () => {
    // One schema rule, applied to the whole table: `additionalProperties: false`
    // is only worth publishing if it is enforced. This is the cheapest possible
    // "each tool has an error path" and it is a real one.
    const failures = [];
    for (const name of TOOL_NAMES) {
      const result = await board.session.call(name, { definitely_not_an_argument: 1 });
      if (result.kind !== "rpc" || result.rpc.code !== -32602) {
        failures.push(`${name} → ${JSON.stringify(result.rpc ?? result.payload)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("maps a missing required argument to -32602, without touching the board", async () => {
    const missingTitle = await board.session.call("task_create", { project_id: "demo" });
    assert.equal(missingTitle.kind, "rpc");
    assert.equal(missingTitle.rpc.code, -32602);
    assert.match(missingTitle.rpc.message, /title/);

    const missingBody = await board.session.call("task_comment_add", { ref: "DEMO-0001" });
    assert.equal(missingBody.rpc.code, -32602);

    const missingBackend = await board.session.call("session_set", { ref: "DEMO-0001", seg: "seg1" });
    assert.equal(missingBackend.rpc.code, -32602);
  });

  it("refuses the arguments the schemas deliberately do not have", async () => {
    // `status` is not patchable — the route answers INVALID_TRANSITION, so the
    // tool must not be able to express it at all.
    const patched = await board.session.call("task_update", { ref: "DEMO-0001", status: "done" });
    assert.equal(patched.kind, "rpc");
    assert.equal(patched.rpc.code, -32602);

    // And a status outside the seven is a schema error, not a board round trip.
    const bogus = await board.session.call("task_move", { ref: "DEMO-0001", to: "shipped" });
    assert.equal(bogus.rpc.code, -32602);
    assert.match(bogus.rpc.message, /must be one of/);
  });

  it("task_get on a task that does not exist is NOT_FOUND (404), not a protocol error", async () => {
    const result = await board.session.call("task_get", { ref: "NOPE-9999" });
    assert.equal(result.kind, "tool");
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "NOT_FOUND");
    assert.equal(result.payload.http, 404);
  });

  it("task_update with a stale if_version is VERSION_CONFLICT (409)", async () => {
    const result = await board.session.call("task_update", { ref: "DEMO-0001", title: "Rename", if_version: 99 });
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "VERSION_CONFLICT");
    assert.equal(result.payload.http, 409);
  });

  it("task_move with an illegal transition is INVALID_TRANSITION (409)", async () => {
    const result = await board.session.call("task_move", { ref: "DEMO-0001", to: "done" });
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "INVALID_TRANSITION");
    assert.equal(result.payload.http, 409);
  });

  it("task_relation_add refuses a self-reference and a cross-project relation", async () => {
    const self = await board.session.call("task_relation_add", {
      ref: "DEMO-0001",
      type: "parent",
      target: "DEMO-0001",
    });
    assert.equal(self.isError, true);
    assert.equal(self.payload.code, "SELF_REFERENCE");
    assert.equal(self.payload.http, 422);

    // The rule lives in a database trigger as well as in the domain; this is the
    // evidence that whichever one fires, the code survives the trip. DEMO-0003 is
    // the epic, so the epic rule passes and the project rule is the one that bites.
    const cross = await board.session.call("task_relation_add", {
      ref: "DEMO-0003",
      type: "parent",
      target: "OTHER-0001",
    });
    assert.equal(cross.isError, true);
    assert.equal(cross.payload.code, "CROSS_PROJECT_RELATION");
    assert.equal(cross.payload.http, 422);
  });

  it("task_relation_remove on an unknown id is NOT_FOUND", async () => {
    const result = await board.session.call("task_relation_remove", { ref: "DEMO-0001", relation_id: 987654 });
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "NOT_FOUND");
  });

  it("task_comment_add with a blank body is the service's VALIDATION_FAILED (400)", async () => {
    const result = await board.session.call("task_comment_add", { ref: "DEMO-0001", body: "   " });
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "VALIDATION_FAILED");
    assert.equal(result.payload.http, 400);
  });

  it("task_deliver refuses a missing report and a missing waiver locally (-32602)", async () => {
    const neither = await board.session.call("task_deliver", { ref: "DEMO-0001" });
    assert.equal(neither.kind, "rpc");
    assert.equal(neither.rpc.code, -32602);
    assert.match(neither.rpc.message, /report is required/);

    const both = await board.session.call("task_deliver", {
      ref: "DEMO-0001",
      report: REPORT,
      no_report: true,
      reason: "mutually exclusive",
    });
    assert.equal(both.kind, "rpc");
    assert.equal(both.rpc.code, -32602);
    assert.match(both.rpc.message, /mutually exclusive/);
  });

  it("keeps a tool-level failure from poisoning the session", async () => {
    const failed = await board.session.call("task_get", { ref: "NOPE-9999" });
    assert.equal(failed.isError, true);

    const after_ = await board.session.call("task_get", { ref: "DEMO-0001" });
    assert.equal(after_.isError, false, "the same session still works after a refusal");
    assert.equal(after_.payload.task.identifier, "DEMO-0001");
  });
});

describe("mcp/tools — no board", () => {
  it("reports CLI_IO as a tool result, and leaves the protocol healthy", async () => {
    const dir = makeTempDir("taskpanel-mcp-noboard-");
    const pointerPath = join(dir, "runtime.json");
    const deadUrl = await closedPortUrl();
    writeFileSync(pointerPath, JSON.stringify({ url: deadUrl, port: 0, pid: 999_999 }), "utf8");

    const session = createMcpSession({
      env: {
        ...baseEnv(),
        TASKD_RUNTIME_POINTER: pointerPath,
        TASKD_DATA_DIR: dir,
        TASKD_NO_AUTOSTART: "1",
      },
    });

    const result = await session.call("task_list", {});
    assert.equal(result.kind, "tool", "a missing board is not a JSON-RPC error");
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "CLI_IO");

    // The protocol itself never depended on the board, so it still works.
    const listed = await session.toolsList();
    assert.equal(listed.result.tools.length, 18);
  });
});
