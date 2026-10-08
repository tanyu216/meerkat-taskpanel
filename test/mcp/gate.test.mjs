/**
 * The delivery gate over MCP (R3 — the milestone's centre of gravity).
 *
 * The claim under test is *equivalence*, so the test does not take MCP's word for
 * anything. The baseline is the **raw 422 body `taskd` sends** — fetched with
 * `fetch`, before any client has touched it — and the assertion is that the
 * document an MCP caller receives is that same document, field for field. A
 * second assertion puts the CLI's `--json` error beside it and allows exactly one
 * difference (`details.token_source`, which the CLI adds and which is a fact
 * about the CLI's own startup, not about the refusal).
 *
 * Equivalence is worth testing this hard because it is the thing that would
 * decay silently. Nobody notices a repair hint that drifts; they notice a gate
 * that can be walked past. And the reason this holds is structural — one
 * `DomainError` object, rebuilt by one function, serialised into two containers —
 * so the way to keep it true is to make any drift a red test.
 *
 * The second half of the file is about the *waiver*. `task_move` cannot express
 * it (the schema has no `no_report`/`reason` and `additionalProperties: false`),
 * so `task_move → in_review` is a single-branch refusal, and the audited escape
 * hatch lives only in `task_deliver` — which is what the card means by
 * "`task_deliver` is the only tool that may reach `in_review`".
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { TOOLS } from "../../src/mcp/index.mjs";
import { cleanupTempDirs, errorOf, withMcp } from "./helpers/mcp-harness.mjs";

after(cleanupTempDirs);

const REPORT = {
  conclusion: "M3: the gate survives the MCP surface.",
  acceptance: [{ text: "gate holds", status: "met" }],
  evidence: [{ kind: "path", path: "src/mcp/result.mjs" }],
};

/** A board with one task in `in_progress`, ready for the gate to bite. */
async function readyBoard(fn) {
  return withMcp(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Ship M3", "--json"]);
    ctx.run(["issue", "move", "DEMO-0001", "in_progress", "--json"]);
    return fn(ctx);
  });
}

/**
 * The refusal as the *service* wrote it — one raw HTTP call, no client in between.
 * This is the baseline every equivalence assertion measures against.
 */
async function rawMove(ctx, ref, body) {
  const response = await fetch(`${ctx.url}/api/v1/tasks/${encodeURIComponent(ref)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, error: payload.error ?? null };
}

describe("mcp/gate — the refusal is the service's own document", () => {
  it("returns the raw 422 error body, field for field", async () => {
    await readyBoard(async (ctx) => {
      const raw = await rawMove(ctx, "DEMO-0001", { to: "in_review" });
      assert.equal(raw.status, 422, "the baseline is a real refusal");
      assert.equal(raw.error.code, "REPORT_REQUIRED");

      const result = await ctx.call("task_move", { ref: "DEMO-0001", to: "in_review" });
      assert.equal(result.kind, "tool", "a refused move is a tool result, not a JSON-RPC error");
      assert.equal(result.isError, true);

      // The five fields, deep-equal — including the repair hint, verbatim.
      assert.deepEqual(result.payload, raw.error);
      assert.equal(result.payload.http, 422);
      assert.equal(result.payload.message, raw.error.message);
      assert.deepEqual(result.payload.hint, raw.error.hint);
    });
  });

  it("says the same thing the CLI says (modulo `token_source`)", async () => {
    await readyBoard(async (ctx) => {
      const viaMcp = await ctx.call("task_move", { ref: "DEMO-0001", to: "in_review" });

      const cli = ctx.run(["issue", "move", "DEMO-0001", "in_review", "--json"]);
      assert.equal(cli.status, 1);
      const viaCli = errorOf(cli);

      assert.equal(viaCli.code, viaMcp.payload.code);
      assert.equal(viaCli.message, viaMcp.payload.message);
      assert.deepEqual(viaCli.hint, viaMcp.payload.hint);
      assert.equal(viaCli.http, viaMcp.payload.http);

      // The one permitted difference, and it is a *CLI* fact: which of the four
      // token sources won. Strip it, then the `details` halves must be equal.
      assert.ok(Object.hasOwn(viaCli.details, "token_source"), "the CLI adds token_source; MCP has no such notion");
      const { token_source, ...cliDetails } = viaCli.details;
      assert.deepEqual(cliDetails, viaMcp.payload.details);
    });
  });

  it("carries the round, the rounds on file, and the unrewritten repair command", async () => {
    await readyBoard(async (ctx) => {
      const result = await ctx.call("task_move", { ref: "DEMO-0001", to: "in_review" });

      assert.equal(result.payload.details.round, 1);
      assert.deepEqual(result.payload.details.existingRounds, []);
      assert.equal(result.payload.details.identifier, "DEMO-0001");
      // Byte-for-byte what `deliverCommandHint` produces: MCP advice goes in a
      // *second* content block, never into `hint`.
      assert.equal(result.payload.hint.command, "taskctl issue deliver DEMO-0001 --report-file -");
      assert.match(result.payload.hint.alternative, /taskctl issue move DEMO-0001 in_review --no-report --reason/);
    });
  });

  it("adds an actionable prose block for the caller, without touching the payload", async () => {
    await readyBoard(async (ctx) => {
      const baseline = await rawMove(ctx, "DEMO-0001", { to: "in_review" });
      const result = await ctx.call("task_move", { ref: "DEMO-0001", to: "in_review" });

      assert.equal(result.content.length, 2, "a second text block carries the MCP-specific advice");
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[1].text, /task_deliver/, "the advice names the tool this caller actually has");
      assert.deepEqual(JSON.parse(result.content[0].text), baseline.error, "and the structured half is untouched");
    });
  });
});

describe("mcp/gate — task_move cannot reach in_review", () => {
  it("has no way to express the waiver", () => {
    const move = TOOLS.find((tool) => tool.name === "task_move");
    assert.equal(Object.hasOwn(move.inputSchema.properties, "no_report"), false);
    assert.equal(Object.hasOwn(move.inputSchema.properties, "reason"), false);
    assert.equal(move.inputSchema.additionalProperties, false);
  });

  it("refuses every parameter combination that might smuggle one through", async () => {
    await readyBoard(async (ctx) => {
      const attempts = [
        { ref: "DEMO-0001", to: "in_review" },
        { ref: "DEMO-0001", to: "in_review", no_report: true },
        { ref: "DEMO-0001", to: "in_review", reason: "hotfix: report follows" },
        { ref: "DEMO-0001", to: "in_review", no_report: true, reason: "hotfix: report follows" },
        { ref: "DEMO-0001", to: "in_review", no_report: true, reason: "hotfix: report follows", if_version: 1 },
      ];

      for (const args of attempts) {
        const result = await ctx.call("task_move", args);
        const refused = result.kind === "rpc" || result.isError === true;
        assert.equal(refused, true, `task_move ${JSON.stringify(args)} must not succeed`);
        if (result.kind === "rpc") assert.equal(result.rpc.code, -32602);
      }

      // …and the card really is still where it was.
      const read = await ctx.call("task_get", { ref: "DEMO-0001" });
      assert.equal(read.payload.task.status, "in_progress");
      assert.equal(read.payload.task.report_latest_id, null);
    });
  });
});

describe("mcp/gate — task_deliver is atomic, and is the compliant path", () => {
  it("writes the report and the status change in one call", async () => {
    await readyBoard(async (ctx) => {
      const delivered = await ctx.call("task_deliver", { ref: "DEMO-0001", report: REPORT });
      assert.equal(delivered.isError, false, JSON.stringify(delivered.payload));
      assert.equal(delivered.payload.status, "in_review");
      assert.equal(delivered.payload.round, 1);
      assert.equal(delivered.payload.waived, false);
      assert.equal(typeof delivered.payload.report_id, "number");

      // Both halves are visible in a *separate* read, which is what "one
      // transaction" means to a caller: there is no moment where one landed and
      // the other did not.
      const read = await ctx.call("task_get", { ref: "DEMO-0001" });
      assert.equal(read.payload.task.status, "in_review");
      assert.equal(read.payload.task.report_latest_id, delivered.payload.report_id);
      assert.equal(read.payload.task.delivery_round, 1);
    });
  });

  it("warns about a template that is still full of TODOs, in the result and in prose", async () => {
    await readyBoard(async (ctx) => {
      const delivered = await ctx.call("task_deliver", {
        ref: "DEMO-0001",
        report: { ...REPORT, leftovers: "TODO: say what is left" },
      });
      assert.equal(delivered.isError, false, JSON.stringify(delivered.payload));
      assert.ok(Array.isArray(delivered.payload.warnings), "warnings ride in the structured payload (G4)");
      assert.match(delivered.payload.warnings.join("\n"), /TODO/);
      assert.equal(delivered.content.length, 2);
      assert.match(delivered.content[1].text, /TODO/);
    });
  });
});

describe("mcp/gate — rounds", () => {
  it("does not accept round 1's report as evidence for round 2", async () => {
    await readyBoard(async (ctx) => {
      await ctx.call("task_deliver", { ref: "DEMO-0001", report: REPORT });

      // Leaving in_review for rework starts a new round: the previous conclusion
      // is history, not evidence.
      const back = await ctx.call("task_move", { ref: "DEMO-0001", to: "in_progress" });
      assert.equal(back.isError, false, JSON.stringify(back.payload));

      const refused = await ctx.call("task_move", { ref: "DEMO-0001", to: "in_review" });
      assert.equal(refused.isError, true);
      assert.equal(refused.payload.code, "REPORT_REQUIRED");
      assert.equal(refused.payload.details.round, 2);
      assert.deepEqual(refused.payload.details.existingRounds, [1]);
    });
  });

  it("refuses a report that declares the wrong round", async () => {
    await readyBoard(async (ctx) => {
      await ctx.call("task_deliver", { ref: "DEMO-0001", report: REPORT });
      await ctx.call("task_move", { ref: "DEMO-0001", to: "in_progress" });

      const result = await ctx.call("task_deliver", { ref: "DEMO-0001", report: { ...REPORT, round: 1 } });
      assert.equal(result.isError, true);
      assert.equal(result.payload.code, "REPORT_ROUND_MISMATCH");
      assert.equal(result.payload.http, 409);
    });
  });

  it("refuses an invalid report with its issues, and writes nothing", async () => {
    await readyBoard(async (ctx) => {
      const before = (await ctx.call("task_get", { ref: "DEMO-0001" })).payload.task;

      const result = await ctx.call("task_deliver", {
        ref: "DEMO-0001",
        report: { evidence: [{ kind: "path", path: "x" }] },
      });
      assert.equal(result.isError, true);
      assert.equal(result.payload.code, "REPORT_INVALID");
      assert.equal(result.payload.http, 422);
      assert.ok(Array.isArray(result.payload.details.issues));
      const paths = result.payload.details.issues.map((issue) => issue.path);
      assert.ok(paths.includes("conclusion"), `expected a conclusion issue in ${JSON.stringify(paths)}`);
      assert.ok(paths.includes("acceptance"), `expected an acceptance issue in ${JSON.stringify(paths)}`);

      const after_ = (await ctx.call("task_get", { ref: "DEMO-0001" })).payload.task;
      assert.equal(after_.version, before.version, "a refused delivery is not a write");
      assert.equal(after_.status, "in_progress");
      assert.equal(after_.report_latest_id, null);
    });
  });
});

describe("mcp/gate — task_create cannot enter a delivery state (M3fix D1)", () => {
  /** The create refusal as the *service* wrote it — one raw HTTP call. */
  async function rawCreate(ctx, body) {
    const response = await fetch(`${ctx.url}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, error: (await response.json()).error ?? null };
  }

  /** A board that exists but holds nothing — its own project, so counters are clean. */
  async function emptyBoard(fn) {
    return withMcp(async (ctx) => {
      ctx.run(["project", "create", "--id", "cg", "--name", "Create Gate", "--workspace-path", ctx.dataDir, "--json"]);
      return fn(ctx);
    });
  }

  it("refuses `task_create {status:'in_review'}` with the reportless move's own document", async () => {
    await emptyBoard(async (ctx) => {
      const raw = await rawCreate(ctx, { project_id: "cg", title: "Skip review", status: "in_review" });
      assert.equal(raw.status, 422, "the baseline is a real refusal");
      assert.equal(raw.error.code, "REPORT_REQUIRED");

      const result = await ctx.call("task_create", { project_id: "cg", title: "Skip review", status: "in_review" });
      assert.equal(result.kind, "tool", "the tool ran and the board refused");
      assert.equal(result.isError, true);
      // Field for field against the service's own document. `details.taskId` is
      // the one field that cannot match: each refused create mints a new uuid
      // before the gate refuses it, so the raw call and the MCP call name
      // different ids. Everything else is identical.
      assert.equal(result.payload.code, raw.error.code);
      assert.equal(result.payload.http, raw.error.http);
      assert.equal(result.payload.message, raw.error.message);
      assert.deepEqual(result.payload.hint, raw.error.hint);
      assert.deepEqual({ ...result.payload.details, taskId: null }, { ...raw.error.details, taskId: null });
      assert.equal(result.payload.details.round, 1);
      assert.deepEqual(result.payload.details.existingRounds, []);
      assert.equal(result.payload.hint.command, "taskctl issue deliver CG-0001 --report-file -");

      // `done` is the other state a new card may not start in — reachable only
      // through `in_review`, so it presupposes the same report.
      const done = await ctx.call("task_create", { project_id: "cg", title: "Already done", status: "done" });
      assert.equal(done.isError, true);
      assert.equal(done.payload.code, "REPORT_REQUIRED");

      // Neither attempt wrote anything, and the serial is intact for the next create.
      const listed = await ctx.call("task_list", { project_id: "cg" });
      assert.deepEqual(listed.payload.tasks, []);
    });
  });

  it("refuses the same create through the CLI face", async () => {
    await emptyBoard(async (ctx) => {
      const cli = ctx.run(["issue", "create", "--project", "cg", "--title", "Skip review", "--status", "in_review", "--json"]);
      assert.equal(cli.status, 1);
      assert.equal(errorOf(cli).code, "REPORT_REQUIRED");
    });
  });

  it("still creates a card that starts in todo or backlog", async () => {
    await emptyBoard(async (ctx) => {
      const todo = await ctx.call("task_create", { project_id: "cg", title: "Fine", status: "todo" });
      assert.equal(todo.isError, false, JSON.stringify(todo.payload));
      assert.equal(todo.payload.task.status, "todo");
      assert.equal(todo.payload.task.identifier, "CG-0001");

      const backlog = await ctx.call("task_create", { project_id: "cg", title: "Later", status: "backlog" });
      assert.equal(backlog.isError, false, JSON.stringify(backlog.payload));
      assert.equal(backlog.payload.task.status, "backlog");
    });
  });
});

describe("mcp/gate — the audited waiver, in the one tool that has it", () => {
  it("delivers without a report when the reason is a real one", async () => {
    await readyBoard(async (ctx) => {
      const result = await ctx.call("task_deliver", {
        ref: "DEMO-0001",
        no_report: true,
        reason: "hotfix: report follows in the change comment",
      });
      assert.equal(result.isError, false, JSON.stringify(result.payload));
      assert.equal(result.payload.waived, true);
      assert.equal(result.payload.status, "in_review");
      assert.equal(result.payload.round, 1, "a waiver names its round");
      assert.equal(result.payload.report_id, null);
      assert.match(result.payload.warnings.join("\n"), /report_waived/);
    });
  });

  it("refuses a reason too short to be a reason — with the service's own code", async () => {
    await readyBoard(async (ctx) => {
      const result = await ctx.call("task_deliver", { ref: "DEMO-0001", no_report: true, reason: "short" });
      assert.equal(result.isError, true);
      assert.equal(result.payload.code, "VALIDATION_FAILED");
      assert.equal(result.payload.http, 400);

      const read = await ctx.call("task_get", { ref: "DEMO-0001" });
      assert.equal(read.payload.task.status, "in_progress");
    });
  });
});
