/**
 * The resident session pool: one control session, one project session per
 * target directory, card routing by cwd, concurrency, idle eviction, resume and
 * reattach.
 *
 * The kind pool is a fake in-process seam; the real Claude adapter has its own
 * integration test.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { enqueueCard, enqueueContinue, readCards, readContinue } from "../../src/orchestrator/queue.mjs";
import { readLedger, upsertSubagent, writeLedger } from "../../src/orchestrator/ledger.mjs";
import {
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
  buildProjectBatchPrompt,
  createSessionPool,
  matchEventSession,
  poolStatus,
  runSession,
} from "../../src/orchestrator/session.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-session-pool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "app");
  const api = join(dir, "api");
  mkdirSync(app, { recursive: true });
  mkdirSync(api, { recursive: true });
  return { dir, app, api };
}

function optsFor(f, overrides = {}) {
  return {
    state: join(f.dir, "state.json"),
    log: join(f.dir, "log"),
    repo: join(f.dir, "repo"),
    home: f.dir,
    actorKind: "claude",
    agents: ["alice"],
    continueInterval: 600,
    maxConcurrency: 8,
    projectConcurrency: 8,
    sessionPoolMax: 8,
    projectIdleMs: 30 * 60 * 1000,
    sessionMaxAgeMs: 24 * 60 * 60 * 1000,
    sessionTurnTimeoutMs: 30_000,
    sessionPollMs: 50,
    cli: join(f.dir, "cli.mjs"),
    glue: join(f.dir, "glue.sh"),
    projectsJson: join(f.dir, "projects.json"),
    config: join(f.dir, "config.env"),
    ...overrides,
  };
}

function fakePool({ behavior } = {}) {
  const opened = [];
  let next = 1;
  return {
    opened,
    openSession({ cwd, sessionId, role }) {
      const handle = {
        cwd,
        role,
        sessionId: sessionId ?? `sid-${next++}`,
        closed: false,
        prompts: [],
        async send(prompt) {
          this.prompts.push(prompt);
          const result = (await behavior?.({ handle: this, prompt })) ?? {};
          if (result.ok === false) {
            return { ok: false, error: result.error ?? "fake failure", sessionId: this.sessionId, cwd };
          }
          const count = (prompt.match(/^\s+\d+\)/gm) ?? []).length;
          const ids =
            result.ids ??
            (prompt.startsWith("/meerkat-loop") ? [] : Array.from({ length: count }, (_, i) => `a-${next++}-${i}`));
          for (const subagentId of ids) {
            behavior?.onEvent?.({ type: "subagent", sessionId: this.sessionId, cwd, subagentId });
          }
          return { ok: true, result: "ok", sessionId: this.sessionId, cwd, ids };
        },
        async close() {
          this.closed = true;
        },
      };
      opened.push(handle);
      return handle;
    },
    async close() {
      for (const handle of opened) handle.closed = true;
    },
  };
}

const card = (f, ref, dir, role = "worker") => ({
  card: ref,
  role,
  agent: "alice",
  project: "P",
  target_dir: dir,
  handoff: `work ${ref}`,
});

/** Force a queue row's attempt counter (a retry of a previous turn). */
function setAttempts(dir, ref, attempts) {
  const file = join(dir, "cards.queue.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  const row = value.cards.find((entry) => entry.card === ref);
  row.attempts = attempts;
  writeFileSync(file, JSON.stringify(value), "utf8");
}

/** Seed one live ledger row, as a crashed turn would leave behind. */
function seedLive(f, { sessionKey, ref, role = "worker" }) {
  const now = new Date().toISOString();
  writeLedger(f.dir, {
    version: 1,
    subagents: [
      {
        sessionKey,
        actorKind: "claude",
        subagentId: `live-${ref}`,
        role,
        card: ref,
        status: "running",
        startedAt: now,
        lastSeenAt: now,
      },
    ],
  });
}

describe("session pool", () => {
  it("runs the control turn and opens a project session per target dir", async (t) => {
    const f = fixture(t);
    const lines = [];
    let events = null;
    const fake = fakePool({
      behavior: ({ handle, prompt }) => {
        if (!prompt.startsWith("/meerkat-loop")) return { ids: [`a-${handle.cwd}-${handle.prompts.length}`] };
        events = prompt;
        return { ids: [] };
      },
    });
    const pool = createSessionPool({ opts: optsFor(f), log: (line) => lines.push(line), kindPool: fake });
    t.after(() => pool.stop());
    assert.equal((await pool.start()).ok, true);
    enqueueContinue(join(f.dir), { reason: "timer" });
    await pool.tick();
    assert.match(events, /^\/meerkat-loop Continue/);
    assert.equal(readContinue(f.dir).processing, null, "the control turn completed");

    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.api));
    await pool.tick();
    const projectSessions = fake.opened.filter((handle) => handle.role === "project");
    assert.equal(projectSessions.length, 2);
    assert.deepEqual(projectSessions.map((handle) => handle.cwd).sort(), [f.app, f.api].sort());
    assert.ok(projectSessions.every((handle) => handle.prompts[0].includes("You are the project session")));
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "done").length, 2);
    assert.equal(pool.ledger.subagents.filter((entry) => entry.status === "completed").length, 2);
    await pool.stop();
  });

  it("external control opens no control session, skips continue, and still dispatches", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { control: "external" }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    assert.equal((await pool.start()).ok, true);
    assert.equal(
      fake.opened.filter((handle) => handle.role === "control").length,
      0,
      "the live session is the control; the pool opens none",
    );

    enqueueContinue(join(f.dir), { reason: "timer" });
    const tick = await pool.tick();
    assert.equal(tick.continue.skipped, "external control");
    assert.notEqual(readContinue(f.dir).pending, null, "the live session owns the pending turn");

    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.controlMode, "external");
    assert.equal(state.control, null);

    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    const projectSessions = fake.opened.filter((handle) => handle.role === "project");
    assert.equal(projectSessions.length, 1, "project sessions still dispatch the handoff");
    assert.equal(readCards(f.dir).value.cards.find((entry) => entry.card === "T-1").status, "done");
    await pool.stop();
  });

  it("counts a live subagent against the global concurrency cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    // A row that outlived a crashed turn still holds its slot until it is reaped.
    seedLive(f, { sessionKey: f.app, ref: "T-0", role: "worker" });
    const pool = createSessionPool({
      opts: optsFor(f, { maxConcurrency: 2 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.api));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "done").length, 1);
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 1);
    await pool.stop();
  });

  it("shares one budget between workers and reviewers", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    seedLive(f, { sessionKey: f.app, ref: "R-0", role: "reviewer" });
    const pool = createSessionPool({
      opts: optsFor(f, { maxConcurrency: 2 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "W-1", f.app, "worker"));
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    enqueueCard(join(f.dir), card(f, "W-2", f.api, "worker"));
    enqueueCard(join(f.dir), card(f, "R-2", f.api, "reviewer"));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(
      cards.filter((entry) => entry.status === "done").length,
      1,
      "one slot is taken, so workers and reviewers compete for the remaining one",
    );
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 3);
    await pool.stop();
  });

  it("lets a live reviewer consume the whole cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    seedLive(f, { sessionKey: f.app, ref: "R-0", role: "reviewer" });
    const pool = createSessionPool({
      opts: optsFor(f, { maxConcurrency: 1 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 1);
    await pool.stop();
  });

  it("completes every handoff row when the turn succeeds — never writes dispatched", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.find((entry) => entry.card === "T-1").status, "done");
    assert.equal(cards.filter((entry) => entry.status === "dispatched").length, 0);
    await pool.stop();
  });

  it("opens a separate reviewer session and gives it only review cards", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app, "worker"));
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    await pool.tick();

    const worker = fake.opened.find((handle) => handle.role === "project" && handle.cwd === f.app);
    const reviewer = fake.opened.find((handle) => handle.role === "reviewer" && handle.cwd === f.app);
    assert.ok(worker, "the worker lane keeps its project session");
    assert.ok(reviewer, "the review card gets its own reviewer conversation");
    assert.match(worker.prompts[0], /You are the project session/);
    assert.match(worker.prompts[0], /T-1 \(worker\) handoff/);
    assert.doesNotMatch(worker.prompts[0], /R-1 \(reviewer\) handoff/);
    assert.match(reviewer.prompts[0], /You are the reviewer session/);
    assert.match(reviewer.prompts[0], /R-1 \(reviewer\) handoff/);
    assert.doesNotMatch(reviewer.prompts[0], /T-1 \(worker\) handoff/);
    assert.doesNotMatch(reviewer.prompts[0], /Subagent questions/, "reviewers never answer questions");
    await pool.stop();
  });

  it("claims each directory's own rows, not the first rows in the queue", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "A-1", f.app));
    enqueueCard(join(f.dir), card(f, "B-1", f.api));
    enqueueCard(join(f.dir), card(f, "A-2", f.app));
    enqueueCard(join(f.dir), card(f, "B-2", f.api));
    await pool.tick();

    const appPrompt = fake.opened.find((handle) => handle.cwd === f.app).prompts[0];
    const apiPrompt = fake.opened.find((handle) => handle.cwd === f.api).prompts[0];
    assert.match(appPrompt, /A-1 \(worker\) handoff/);
    assert.match(appPrompt, /A-2 \(worker\) handoff/);
    assert.doesNotMatch(appPrompt, /B-1 \(worker\) handoff/);
    assert.match(apiPrompt, /B-1 \(worker\) handoff/);
    assert.match(apiPrompt, /B-2 \(worker\) handoff/);
    assert.doesNotMatch(apiPrompt, /A-1 \(worker\) handoff/);
    await pool.stop();
  });

  it("reattaches a legacy reviewer row to the reviewer lane", async (t) => {
    const f = fixture(t);
    const now = new Date().toISOString();
    writeLedger(f.dir, {
      version: 1,
      subagents: [
        {
          sessionKey: f.app,
          actorKind: "claude",
          subagentId: "rev-1",
          role: "reviewer",
          card: "R-1",
          status: "running",
          startedAt: now,
          lastSeenAt: now,
        },
      ],
    });
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();

    const reviewer = fake.opened.find((handle) => handle.role === "reviewer");
    assert.ok(reviewer, "a reviewer row resumes the reviewer lane, not the worker one");
    assert.equal(reviewer.cwd, f.app);
    assert.match(reviewer.prompts[0], /rev-1/);
    assert.match(reviewer.prompts[0], /You are the reviewer session/);
    await pool.stop();
  });

  it("answers a question in the worker lane even when the subagent budget is zero", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f, { maxConcurrency: 0 }), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "question:T-1:q-1",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      question_id: "q-1",
      question: "Which option?",
      asked_at: "2026-01-01T00:00:00Z",
    });
    await pool.tick();

    const project = fake.opened.find((handle) => handle.role === "project" && handle.cwd === f.app);
    assert.ok(project, "a question wakes the worker lane, not the reviewer lane");
    assert.match(project.prompts[0], /Which option\?/);
    assert.match(project.prompts[0], /do not spawn a subagent for this row/);
    assert.match(project.prompts[0], /--kind note/);
    assert.match(project.prompts[0], /issue move T-1 todo/);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");

    const ledgerFile = join(f.dir, "subagents.state.json");
    const ledger = existsSync(ledgerFile)
      ? JSON.parse(readFileSync(ledgerFile, "utf8"))
      : { subagents: [] };
    assert.deepEqual(ledger.subagents, [], "a question turn is not a subagent");
    await pool.stop();
  });

  it("completes a timed-out handoff when the card already moved", async (t) => {
    const f = fixture(t);
    const fake = fakePool({
      behavior: ({ prompt }) =>
        prompt.startsWith("/meerkat-loop")
          ? { ids: [] }
          : { ok: false, error: "turn timed out after 1ms" },
    });
    const checks = [];
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: ({ card: ref }) => {
        checks.push(ref);
        return { ok: true, status: "in_review", error: null };
      },
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "done", "a delivered card is not retried");
    assert.equal(row.lastError, "not re-dispatched: card is in_review");
    assert.deepEqual(checks, ["T-1"]);
    const handle = fake.opened.find((entry) => entry.role === "project");
    assert.equal(handle.closed, true, "a timed-out session is closed");
    await pool.stop();
  });

  it("checks a retried handoff against the board before dispatching it", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: () => ({ ok: true, status: "in_review", error: null }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    setAttempts(f.dir, "T-1", 1);
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "done");
    const project = fake.opened.find((entry) => entry.role === "project");
    assert.equal(
      project?.prompts.length ?? 0,
      0,
      "no project turn is sent for a delivered card",
    );
    await pool.stop();
  });

  it("re-dispatches a retried handoff only while the card is still claimable", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: () => ({ ok: true, status: "todo", error: null }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    setAttempts(f.dir, "T-1", 1);
    await pool.tick();

    const project = fake.opened.find((entry) => entry.role === "project");
    assert.ok(project, "a still-claimable card is retried");
    assert.match(project.prompts[0], /T-1 \(worker\) handoff/);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("requeues a retried handoff when the board check cannot be read", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: () => ({ ok: false, status: null, error: "down" }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    setAttempts(f.dir, "T-1", 1);
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "pending", "an unreadable check does not spawn a worker");
    assert.equal(row.attempts, 2);
    const project = fake.opened.find((entry) => entry.role === "project");
    assert.equal(project?.prompts.length ?? 0, 0, "no turn is sent on an unreadable check");
    await pool.stop();
  });

  it("warns once when the actor kind has no per-role allowlist", async (t) => {
    const f = fixture(t);
    const lines = [];
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { actorKind: "codex" }),
      kindPool: fake,
      log: (line) => lines.push(line),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    enqueueCard(join(f.dir), card(f, "R-2", f.api, "reviewer"));
    await pool.tick();

    const warnings = lines.filter((line) => /no per-role tool allowlist/.test(line));
    assert.equal(warnings.length, 1, "the missing boundary is reported once, not every batch");
    await pool.stop();
  });

  it("runs project turns concurrently instead of serializing directories", async (t) => {
    const f = fixture(t);
    let active = 0;
    let maxActive = 0;
    const fake = fakePool({
      behavior: async ({ prompt }) => {
        if (prompt.startsWith("/meerkat-loop")) return { ids: [] };
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return {};
      },
    });
    const pool = createSessionPool({ opts: optsFor(f, { maxConcurrency: 2 }), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "A-1", f.app));
    enqueueCard(join(f.dir), card(f, "B-1", f.api));
    await pool.tick();

    assert.equal(maxActive, 2, "both directories' turns were in flight at once");
    const cards = readCards(f.dir).value.cards;
    assert.deepEqual(cards.map((entry) => entry.status), ["done", "done"]);
    const ledger = readLedger(f.dir).value;
    assert.equal(ledger.subagents.length, 2, "both concurrent turns recorded their subagent");
    assert.deepEqual(ledger.subagents.map((entry) => entry.status), ["completed", "completed"]);
    assert.deepEqual(
      new Set(ledger.subagents.map((entry) => entry.card)),
      new Set(["A-1", "B-1"]),
    );
    await pool.stop();
  });

  it("respects the per-project concurrency cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { projectConcurrency: 1 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.app));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "done").length, 1);
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 1);
    await pool.stop();
  });

  it("requeues a failed batch and fails a card with no target directory", async (t) => {
    const f = fixture(t);
    let fail = true;
    const fake = fakePool({
      behavior: ({ prompt }) => (prompt.startsWith("/meerkat-loop") ? { ids: [] } : fail ? { ok: false, error: "boom" } : {}),
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), { ...card(f, "T-2", ""), target_dir: "" });
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    const failed = cards.find((entry) => entry.card === "T-2");
    const requeued = cards.find((entry) => entry.card === "T-1");
    assert.equal(failed.status, "failed");
    assert.equal(requeued.status, "pending");
    assert.equal(requeued.attempts, 1);
    assert.match(requeued.lastError, /boom/);
    fail = false;
    await pool.tick();
    assert.equal(readCards(f.dir).value.cards.find((entry) => entry.card === "T-1").status, "done");
    await pool.stop();
  });

  it("closes an idle project session but keeps its session id for resume", async (t) => {
    const f = fixture(t);
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { projectIdleMs: 1000 }),
      kindPool: fake,
      now: () => clock,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    const first = fake.opened.find((handle) => handle.cwd === f.app);
    assert.ok(first);
    clock += 2000;
    await pool.tick();
    assert.equal(first.closed, true, "the idle project session was closed");
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[f.app].sessionId, first.sessionId);
    enqueueCard(join(f.dir), card(f, "T-2", f.app));
    await pool.tick();
    const second = fake.opened.filter((handle) => handle.cwd === f.app).at(-1);
    assert.notEqual(second, first);
    assert.equal(second.sessionId, first.sessionId, "the reopened session resumed the stored id");
    await pool.stop();
  });

  it("starts a fresh session after max-age", async (t) => {
    const f = fixture(t);
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { sessionMaxAgeMs: 1000 }),
      kindPool: fake,
      now: () => clock,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    const first = fake.opened.find((handle) => handle.cwd === f.app);
    clock += 2000;
    await pool.tick();
    assert.equal(first.closed, true);
    enqueueCard(join(f.dir), card(f, "T-2", f.app));
    await pool.tick();
    const second = fake.opened.filter((handle) => handle.cwd === f.app).at(-1);
    assert.notEqual(second.sessionId, first.sessionId, "max-age forces a fresh conversation");
    await pool.stop();
  });

  it("sends a reattach prompt for unfinished subagents on start", async (t) => {
    const f = fixture(t);
    writeLedger(f.dir, upsertSubagent({ subagents: [] }, {
      sessionKey: f.app,
      actorKind: "claude",
      subagentId: "a-old",
      card: "T-9",
      role: "worker",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    }));
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      now: () => Date.parse("2026-01-01T00:01:00.000Z"),
    });
    t.after(() => pool.stop());
    await pool.start();
    const project = fake.opened.find((handle) => handle.cwd === f.app);
    assert.ok(project, "the project session was opened for reattach");
    assert.match(project.prompts[0], /a-old/);
    assert.match(project.prompts[0], /Reattach/);
    assert.match(project.prompts[0], /re-read \.meerkat\/T-9\/card\.md before continuing/);
    assert.match(project.prompts[0], /never edit it/);
    await pool.stop();
  });

  it("refuses a second pool on the same state directory", async (t) => {
    const f = fixture(t);
    const first = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    const second = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    t.after(async () => {
      await first.stop();
      await second.stop();
    });
    assert.equal((await first.start()).ok, true);
    const refused = await second.start();
    assert.equal(refused.ok, false);
    assert.match(refused.error, /already running/);
  });

  it("refuses to start the session service when either skill is not installed", async (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    mkdirSync(join(home, ".claude", "skills", "meerkat-loop"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "meerkat-loop", "SKILL.md"), "---\nname: x\n---\n");
    const lines = [];
    const code = await runSession(
      { ...optsFor(f), home, actorKind: "claude" },
      { log: (line) => lines.push(line) },
    );
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /missing skill/);
    assert.match(lines.join("\n"), /meerkat-taskpanel/);
  });

  it("starts and stops cleanly once both skills are present", async (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    for (const name of ["meerkat-loop", "meerkat-taskpanel"]) {
      const dir = join(home, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const controller = new AbortController();
    controller.abort();
    const code = await runSession(
      { ...optsFor(f), home, actorKind: "claude" },
      { log: () => {}, kindPool: fakePool(), signal: controller.signal },
    );
    assert.equal(code, 0);
    assert.equal(existsSync(join(f.dir, "session.lock")), false, "the lock is released");
  });

  it("keeps an external-control pool alive without a control session", async (t) => {
    // External control opens no control session, so the pool has no child
    // process holding the event loop. Its timers are the only handles: unref'd,
    // the process exits the moment it starts and `--take-over` never sees it.
    const f = fixture(t);
    const home = join(f.dir, "home");
    for (const name of ["meerkat-loop", "meerkat-taskpanel"]) {
      const dir = join(home, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const state = join(f.dir, "state.json");
    const logPath = join(f.dir, "supervisor.log");
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "../../src/orchestrator/supervisor.mjs"),
        "--session",
        "--control=external",
        "--actor-kind",
        "claude",
        "--agent",
        "alice",
        "--home",
        home,
        "--repo",
        join(import.meta.dirname, "../.."),
        "--state",
        state,
        "--log",
        logPath,
      ],
      { stdio: "ignore" },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });

    const sessionState = join(f.dir, "sessions.state.json");
    const deadline = Date.now() + 5_000;
    while (!existsSync(sessionState) && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(none)";
    assert.ok(existsSync(sessionState), `the pool wrote its state; log: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(child.exitCode, null, `the external-control pool exited (${child.exitCode}); log: ${log}`);

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });

  it("answers 'is the pool resident?' from the state file, pid and heartbeat", (t) => {
    const f = fixture(t);
    const opts = optsFor(f);
    const clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };
    const writeState = (value) =>
      writeFileSync(join(f.dir, "sessions.state.json"), JSON.stringify({ version: 1, control: null, projects: {}, ...value }));

    assert.equal(poolStatus({ opts, now: () => clock.now }).live, false, "no state file");

    writeState({ poolPid: 999_999, heartbeatAt: new Date(clock.now).toISOString() });
    const dead = poolStatus({ opts, now: () => clock.now, isAlive: () => false });
    assert.equal(dead.live, false);
    assert.match(dead.reason, /is gone/);

    writeState({ poolPid: process.pid, heartbeatAt: new Date(clock.now).toISOString() });
    const live = poolStatus({ opts, now: () => clock.now });
    assert.equal(live.live, true, JSON.stringify(live));
    assert.equal(live.poolPid, process.pid);

    clock.now += POOL_STALE_MS + POOL_HEARTBEAT_MS;
    const stale = poolStatus({ opts, now: () => clock.now });
    assert.equal(stale.live, false);
    assert.match(stale.reason, /heartbeat .* old/);

    // A deployment decision beats a live file.
    const disabled = poolStatus({ opts: { ...opts, resident: "no" }, now: () => clock.now });
    assert.equal(disabled.live, false);
    assert.equal(disabled.reason, "--resident=no");
  });

  it("builds the project batch prompt with every handoff", () => {
    const prompt = buildProjectBatchPrompt([
      { card: "T-1", role: "worker", project: "P", target_dir: "/work/app", handoff: "do one" },
      { card: "T-2", role: "reviewer", project: "P", target_dir: "/work/app", handoff: "review two" },
    ]);
    assert.match(prompt, /You are the project session for P at \/work\/app/);
    assert.match(prompt, /T-1 \(worker\) handoff/);
    assert.match(prompt, /do one/);
    assert.match(prompt, /T-2 \(reviewer\) handoff/);
    assert.match(prompt, /review two/);
    assert.match(prompt, /Do not work the cards yourself/);
    assert.match(prompt, /in the exact order listed/, "the id-to-card mapping is positional");
  });

  it("builds the reviewer batch without the question ladder", () => {
    const prompt = buildProjectBatchPrompt(
      [{ card: "R-1", role: "reviewer", project: "P", target_dir: "/work/app", handoff: "review it" }],
      null,
      { lane: "reviewer" },
    );
    assert.match(prompt, /You are the reviewer session for P at \/work\/app/);
    assert.match(prompt, /Review cards in this batch/);
    assert.doesNotMatch(prompt, /Subagent questions/);
    assert.match(prompt, /Do not answer questions/);
    assert.match(prompt, /does not move any card|do not move any card/);
  });

  it("routes an event by session id when two lanes share a cwd", () => {
    const worker = { key: "/work/app", cwd: "/work/app", handle: { sessionId: "w" } };
    const reviewer = { key: "/work/app#reviewer", cwd: "/work/app", handle: { sessionId: "r" } };
    const other = { key: "/work/api", cwd: "/work/api", handle: { sessionId: "a" } };

    assert.equal(
      matchEventSession([worker, reviewer, other], { sessionId: "r", cwd: "/work/app" }),
      reviewer,
      "the session id wins over the shared cwd",
    );
    assert.equal(matchEventSession([worker, reviewer], { sessionId: "w", cwd: "/work/app" }), worker);
    assert.equal(
      matchEventSession([worker, reviewer], { cwd: "/work/app" }),
      null,
      "an id-less event on a shared cwd is not guessed onto one lane",
    );
    assert.equal(matchEventSession([worker, other], { cwd: "/work/api" }), other);
  });

  it("names the selected role agents and carries the question-first rule", () => {
    const prompt = buildProjectBatchPrompt(
      [
        {
          card: "T-1",
          role: "worker",
          agent_role: "Jobs",
          project: "P",
          target_dir: "/work/app",
          handoff: "do one",
        },
      ],
      {
        roles: [
          {
            id: "jobs",
            agent: "Jobs",
            nativeAgent: "jobs",
            workflows: { worker: "/roles/jobs/workflow.md" },
          },
        ],
      },
    );
    assert.match(prompt, /Named role agents/);
    assert.match(prompt, /spawn as "jobs"/);
    assert.match(prompt, /T-1 \(worker\) role Jobs handoff/);
    assert.match(prompt, /Subagent questions/);
    assert.match(prompt, /escalate E1-E5/);
    assert.match(prompt, /never use --as-human/);
  });
});
