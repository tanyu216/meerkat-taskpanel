/**
 * The resident session pool: one control session, one project session per
 * target directory, card routing by cwd, concurrency, idle eviction, resume and
 * reattach.
 *
 * The host pool is a fake in-process seam; the real Claude adapter has its own
 * integration test.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { enqueueCard, enqueueContinue, readCards, readContinue } from "../../scripts/loop/queue.mjs";
import { upsertSubagent, writeLedger } from "../../scripts/loop/ledger.mjs";
import {
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
  buildProjectBatchPrompt,
  createSessionPool,
  poolStatus,
  runSession,
} from "../../scripts/loop/session.mjs";

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
    host: "claude",
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
          const result = behavior?.({ handle: this, prompt }) ?? {};
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
    const pool = createSessionPool({ opts: optsFor(f), log: (line) => lines.push(line), hostPool: fake });
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

  it("respects the global concurrency cap while subagents are live", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    // Background mode keeps the first subagent live, so the second project's
    // card must wait for a slot.
    const pool = createSessionPool({
      opts: optsFor(f, { maxConcurrency: 1, subagentBackground: true }),
      hostPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.api));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "dispatched").length, 1);
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 1);
    await pool.stop();
  });

  it("shares one budget between workers and reviewers", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    // Background mode keeps both subagents live, so the remaining cards have no slot.
    const pool = createSessionPool({
      opts: optsFor(f, { maxConcurrency: 2, subagentBackground: true }),
      hostPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "W-1", f.app, "worker"));
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    enqueueCard(join(f.dir), card(f, "W-2", f.api, "worker"));
    enqueueCard(join(f.dir), card(f, "R-2", f.api, "reviewer"));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    const dispatched = cards.filter((entry) => entry.status === "dispatched").map((entry) => entry.card);
    assert.deepEqual(dispatched.sort(), ["R-1", "W-1"], "workers and reviewers compete for the same slots");
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 2);
    await pool.stop();
  });

  it("lets reviewers consume the whole cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { maxConcurrency: 1, subagentBackground: true }),
      hostPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "dispatched").length, 1);
    await pool.stop();
  });

  it("respects the per-project concurrency cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { projectConcurrency: 1 }),
      hostPool: fake,
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
    const pool = createSessionPool({ opts: optsFor(f), hostPool: fake });
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
      hostPool: fake,
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
      hostPool: fake,
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
      host: "claude",
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
      hostPool: fake,
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
    const first = createSessionPool({ opts: optsFor(f), hostPool: fakePool() });
    const second = createSessionPool({ opts: optsFor(f), hostPool: fakePool() });
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
      { ...optsFor(f), home, host: "claude" },
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
      { ...optsFor(f), home, host: "claude" },
      { log: () => {}, hostPool: fakePool(), signal: controller.signal },
    );
    assert.equal(code, 0);
    assert.equal(existsSync(join(f.dir, "session.lock")), false, "the lock is released");
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
  });
});
