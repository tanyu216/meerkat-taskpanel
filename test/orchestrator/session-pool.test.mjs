/**
 * The resident session pool: a worker session per card, a reviewer lane and a
 * director lane per directory, card routing by cwd, concurrency, idle eviction,
 * resume and reattach.
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

import { processStartToken } from "../../src/foundation/daemon-state.mjs";
import {
  claimCards,
  enqueueCard,
  readCards,
} from "../../src/orchestrator/queue.mjs";
import { readLedger, upsertSubagent, writeLedger } from "../../src/orchestrator/ledger.mjs";
import { workerKey } from "../../src/orchestrator/worker-session.mjs";
import {
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
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

function fakePool({ behavior, idPrefix = "sid" } = {}) {
  const opened = [];
  let next = 1;
  return {
    opened,
    openSession({ cwd, sessionId, role, skillPath }) {
      const handle = {
        cwd,
        role,
        skillPath: skillPath ?? null,
        sessionId: sessionId ?? `${idPrefix}-${next++}`,
        closed: false,
        prompts: [],
        async send(prompt) {
          this.prompts.push(prompt);
          const result = (await behavior?.({ handle: this, prompt })) ?? {};
          if (result.ok === false) {
            return {
              ok: false,
              error: result.error ?? "fake failure",
              ...(result.resumeFailed === true ? { resumeFailed: true } : {}),
              sessionId: this.sessionId,
              cwd,
            };
          }
          const count = (prompt.match(/^\s+\d+\)/gm) ?? []).length;
          const ids =
            result.ids ?? Array.from({ length: count }, (_, i) => `a-${next++}-${i}`);
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

/** Install one minimal role skill under the fixture's primary-kind home. */
function installRole(dir, { id, agent, lanes, kind = "claude" }) {
  const skill = join(dir, `.${kind}`, "skills", id);
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(
    join(skill, "role.json"),
    JSON.stringify({
      schema: "meerkat-role",
      id,
      agent,
      native_agent: id,
      lanes,
      title: agent,
      summary: `${agent} role.`,
      shapes: ["work"],
      responsibilities: [],
      boundaries: [],
      self_check: "references/self-check.md",
      reviewer_prompt: null,
    }),
    "utf8",
  );
  writeFileSync(
    join(skill, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${agent} role.\n---\n\n# ${agent}\n`,
    "utf8",
  );
  writeFileSync(join(skill, "references", "self-check.md"), `# ${agent} self-check\n`, "utf8");
}

/** Force a queue row's attempt counter (a retry of a previous turn). */
function setAttempts(dir, ref, attempts) {
  const file = join(dir, "cards.queue.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  const row = value.cards.find((entry) => entry.card === ref);
  row.attempts = attempts;
  writeFileSync(file, JSON.stringify(value), "utf8");
}

/**
 * Put one enqueued row in `processing`, as another pool's in-flight turn would.
 * A card session holds its concurrency slot through its queue row.
 */
function holdRow(f, ref, role = "worker") {
  enqueueCard(join(f.dir), card(f, ref, f.app, role));
  const row = readCards(f.dir).value.cards.find((entry) => entry.card === ref);
  const claimed = claimCards(join(f.dir), {
    claimedBy: "other-pool",
    // A live owner: the recovery pass only requeues a row whose pool is gone.
    pid: process.pid,
    limit: 1,
    ids: [row.id],
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.cards.length, 1);
}

describe("session pool", () => {
  it("dispatches a worker per target dir and opens no control session", async (t) => {
    const f = fixture(t);
    const lines = [];
    const fake = fakePool({
      behavior: ({ handle }) => ({ ids: [`a-${handle.cwd}-${handle.prompts.length}`] }),
    });
    const pool = createSessionPool({ opts: optsFor(f), log: (line) => lines.push(line), kindPool: fake });
    t.after(() => pool.stop());
    assert.equal((await pool.start()).ok, true);
    assert.equal(
      fake.opened.filter((handle) => handle.role === "control").length,
      0,
      "the supervisor runs the tick; the pool opens no control session",
    );

    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.api));
    await pool.tick();
    const workerSessions = fake.opened.filter((handle) => handle.role === "worker");
    assert.equal(workerSessions.length, 2);
    assert.deepEqual(workerSessions.map((handle) => handle.cwd).sort(), [f.app, f.api].sort());
    assert.ok(workerSessions.every((handle) => /^work T-/.test(handle.prompts[0])));
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "done").length, 2);
    assert.equal(pool.ledger.subagents.filter((entry) => entry.status === "completed").length, 2);
    await pool.stop();
  });

  it("lets exactly one of two concurrent starts own the pool lock", async (t) => {
    const f = fixture(t);
    const first = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    const second = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    t.after(async () => {
      await first.stop();
      await second.stop();
    });

    // Two units start in the same moment — the case the old read-check-write
    // lock let both win. `O_EXCL` admits one owner and refuses the other.
    const results = await Promise.all([first.start(), second.start()]);
    assert.equal(results.filter((result) => result.ok === true).length, 1, "exactly one start wins");
    assert.equal(results.filter((result) => result.ok === false).length, 1, "the other is refused");
    assert.match(
      results.find((result) => result.ok !== true).error,
      /already running/,
      "the refusal names the live pool",
    );
  });

  // Dispatch parity only; the process-lifetime parity is pinned by the real-child
  // "keeps an idle pool resident in every control mode" test below.
  it("--control changes neither dispatch nor lifetime", async (t) => {
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
      "no control session in either mode",
    );

    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    assert.equal(fake.opened.filter((handle) => handle.role === "worker").length, 1);
    assert.equal(readCards(f.dir).value.cards.find((entry) => entry.card === "T-1").status, "done");
    await pool.stop();
  });

  it("counts an in-flight card session against the global concurrency cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    // An in-flight turn holds its slot through its processing queue row.
    holdRow(f, "T-0", "reviewer");
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
    assert.equal(cards.filter((entry) => entry.status === "processing").length, 1);
    assert.equal(cards.filter((entry) => entry.status === "done").length, 1);
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 1);
    await pool.stop();
  });

  it("shares one budget between worker and review card sessions", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    holdRow(f, "R-0", "reviewer");
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
      "one slot is taken, so worker and review sessions compete for the remaining one",
    );
    assert.equal(cards.filter((entry) => entry.status === "pending").length, 3);
    await pool.stop();
  });

  it("lets an in-flight review session consume the whole cap", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    holdRow(f, "R-0", "reviewer");
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

    const worker = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    const reviewer = fake.opened.find((handle) => handle.role === "reviewer" && handle.cwd === f.app);
    assert.ok(worker, "a worker card gets its own worker session");
    assert.ok(reviewer, "the review card gets its own reviewer conversation");
    assert.match(worker.prompts[0], /work T-1/);
    assert.doesNotMatch(worker.prompts[0], /work R-1/);
    assert.equal(reviewer.prompts[0], "work R-1", "the review session gets only its own card");
    assert.equal(reviewer.role, "reviewer", "the review session carries the reviewer tool surface");
    assert.doesNotMatch(reviewer.prompts[0], /spawn/i, "a review card session spawns nothing");
    await pool.stop();
  });

  it("gives each worker its own session in its own directory", async (t) => {
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

    const workers = fake.opened.filter((handle) => handle.role === "worker");
    assert.equal(workers.length, 4);
    for (const [ref, dir] of [
      ["A-1", f.app],
      ["A-2", f.app],
      ["B-1", f.api],
      ["B-2", f.api],
    ]) {
      const handle = workers.find((entry) => entry.prompts[0].includes(`work ${ref}`));
      assert.ok(handle, `${ref} has a worker session`);
      assert.equal(handle.cwd, dir);
      for (const other of ["A-1", "A-2", "B-1", "B-2"]) {
        if (other !== ref) assert.doesNotMatch(handle.prompts[0], new RegExp(`work ${other}`));
      }
    }
    await pool.stop();
  });

  it("opens a fresh worker and reviewer session by loading the role skill first", async (t) => {
    const f = fixture(t);
    installRole(f.dir, { id: "jobs", agent: "Jobs", lanes: ["worker"] });
    installRole(f.dir, { id: "reviewer", agent: "Reviewer", lanes: ["reviewer"] });
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), { ...card(f, "T-1", f.app, "worker"), agent: "Jobs" });
    enqueueCard(join(f.dir), { ...card(f, "R-1", f.app, "reviewer"), agent: "Reviewer" });
    await pool.tick();

    const worker = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    const reviewer = fake.opened.find((handle) => handle.role === "reviewer" && handle.cwd === f.app);
    assert.ok(worker, "the worker session opens");
    assert.ok(reviewer, "the reviewer session opens");
    assert.equal(
      worker.prompts[0],
      "/jobs\nFlags: --agent Jobs --actor-kind=claude",
      "the worker session opens by loading its role skill with the card's attribution",
    );
    assert.equal(
      reviewer.prompts[0],
      "/reviewer\nFlags: --agent Reviewer --actor-kind=claude",
      "the reviewer session opens by loading its role skill",
    );
    assert.match(worker.prompts[1], /work T-1/);
    assert.equal(reviewer.prompts[1], "work R-1");
    await pool.stop();
  });

  it("loads an inline host's skill at session open, with no opener message", async (t) => {
    const f = fixture(t);
    installRole(f.dir, { id: "jobs", agent: "Jobs", lanes: ["worker"], kind: "codex" });
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app, "worker"),
      agent: "Jobs",
      actor_kind: "codex",
    });
    await pool.tick();
    const worker = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    assert.ok(worker, "the codex worker session opens");
    assert.equal(worker.skillPath, join(f.dir, ".codex", "skills", "jobs", "SKILL.md"));
    assert.equal(worker.prompts.length, 1, "the skill is loaded at open, not by an extra turn");
    assert.doesNotMatch(worker.prompts[0], /^\/jobs/, "no opener message on an inline host");
    assert.match(worker.prompts[0], /work T-1/);
    await pool.stop();
  });

  it("uses the selected kind's skill copy when a role is installed on several kinds", async (t) => {
    const f = fixture(t);
    installRole(f.dir, { id: "jobs", agent: "Jobs", lanes: ["worker"], kind: "claude" });
    installRole(f.dir, { id: "jobs", agent: "Jobs", lanes: ["worker"], kind: "codex" });
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app, "worker"),
      agent: "Jobs",
      actor_kind: "codex",
    });
    await pool.tick();
    const worker = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    assert.ok(worker, "the codex worker session opens");
    assert.equal(
      worker.skillPath,
      join(f.dir, ".codex", "skills", "jobs", "SKILL.md"),
      "the fallback kind's copy is the one loaded, not the primary kind's",
    );
    await pool.stop();
  });

  it("does not reopen an inline card session merely because its skill was loaded at open", async (t) => {
    const f = fixture(t);
    installRole(f.dir, { id: "reviewer", agent: "Reviewer", lanes: ["reviewer"], kind: "codex" });
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    const enqueueReview = (ref) =>
      enqueueCard(join(f.dir), {
        ...card(f, ref, f.app, "reviewer"),
        agent: "Reviewer",
        actor_kind: "codex",
      });
    await pool.start();
    enqueueReview("R-1");
    await pool.tick();
    // A second handoff for the same card (a retry) resumes the card's own
    // session; the inline skill was loaded at open and needs no extra turn.
    enqueueReview("R-1");
    await pool.tick();
    const reviewers = fake.opened.filter(
      (handle) => handle.role === "reviewer" && handle.cwd === f.app,
    );
    assert.equal(reviewers.length, 1, "the card keeps its session while the skill is unchanged");
    assert.equal(reviewers[0].prompts.length, 2, "two turns, no opener turn");

    writeFileSync(
      join(f.dir, ".codex", "skills", "reviewer", "SKILL.md"),
      "---\nname: reviewer\ndescription: changed\n---\n\n# Reviewer changed\n",
      "utf8",
    );
    enqueueReview("R-1");
    await pool.tick();
    const reopened = fake.opened.filter(
      (handle) => handle.role === "reviewer" && handle.cwd === f.app,
    );
    assert.equal(reopened.length, 2, "a changed skill reopens the card session");
    assert.equal(reopened[1].skillPath, join(f.dir, ".codex", "skills", "reviewer", "SKILL.md"));
    await pool.stop();
  });

  it("falls back to the role skill path when the opener fails", async (t) => {
    const f = fixture(t);
    installRole(f.dir, { id: "jobs", agent: "Jobs", lanes: ["worker"] });
    const fake = fakePool({
      behavior: ({ prompt }) => (prompt.startsWith("/jobs") ? { ok: false, error: "no such skill" } : {}),
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), { ...card(f, "T-1", f.app, "worker"), agent: "Jobs" });
    await pool.tick();
    const worker = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    assert.ok(worker, "the worker session opens even without the opener");
    assert.equal(worker.prompts[0], "/jobs\nFlags: --agent Jobs --actor-kind=claude");
    assert.match(worker.prompts[1], /Role skill: .*\/jobs\/SKILL\.md/);
    assert.match(worker.prompts[1], /work T-1/);
    await pool.stop();
  });

  it("reopens a lane session when its installed skill changes", async (t) => {
    const f = fixture(t);
    installRole(f.dir, { id: "reviewer", agent: "Reviewer", lanes: ["reviewer"] });
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), { ...card(f, "R-1", f.app, "reviewer"), agent: "Reviewer" });
    await pool.tick();
    const first = fake.opened.find((handle) => handle.role === "reviewer" && handle.cwd === f.app);
    assert.ok(first, "the reviewer lane opens");
    assert.equal(first.prompts[0], "/reviewer\nFlags: --agent Reviewer --actor-kind=claude");

    writeFileSync(
      join(f.dir, ".claude", "skills", "reviewer", "SKILL.md"),
      "---\nname: reviewer\ndescription: changed\n---\n\n# Reviewer changed\n",
      "utf8",
    );
    enqueueCard(join(f.dir), { ...card(f, "R-2", f.app, "reviewer"), agent: "Reviewer" });
    await pool.tick();
    const reviewers = fake.opened.filter(
      (handle) => handle.role === "reviewer" && handle.cwd === f.app,
    );
    assert.equal(reviewers.length, 2, "a changed skill reopens the lane");
    assert.equal(
      reviewers[1].prompts[0],
      "/reviewer\nFlags: --agent Reviewer --actor-kind=claude",
      "the new session loads the skill again",
    );
    assert.match(reviewers[1].prompts[1], /R-2/);
    await pool.stop();
  });

  it("opens nothing for a legacy reviewer ledger row — there is no lane to reattach", async (t) => {
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

    assert.equal(fake.opened.length, 0, "a review card is dispatched only through its own queue row");
    await pool.stop();
  });

  it("answers a question in the director lane even when the subagent budget is zero", async (t) => {
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
    await pool.routeQuestionsNow();

    const director = fake.opened.find((handle) => handle.role === "director" && handle.cwd === f.app);
    assert.ok(director, "a question wakes the director lane, not the reviewer lane");
    assert.equal(
      director.prompts[0],
      "/meerkat-director\nFlags: --agent Director --actor-kind=claude",
      "a fresh director session opens by loading its skill with the lane's own attribution",
    );
    assert.match(director.prompts[1], /You are the Director/);
    assert.match(director.prompts[1], /--agent Director --actor-kind claude/);
    assert.doesNotMatch(director.prompts[1], /--agent alice/);
    assert.match(director.prompts[1], /Which option\?/);
    assert.match(director.prompts[1], /never spawn a subagent/);
    assert.match(director.prompts[1], /--kind note/);
    assert.match(director.prompts[1], /issue move T-1 todo/);
    assert.doesNotMatch(director.prompts[1], /Decision policy:/);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
  });

  it("loads the director skill inline when the kind has no message opener", async (t) => {
    const f = fixture(t);
    const skillDir = join(f.dir, ".codex", "skills", "meerkat-director");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: meerkat-director\n---\n", "utf8");
    writeFileSync(join(skillDir, "references", "decision-policy.md"), "# policy\n", "utf8");
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { actorKind: "codex", maxConcurrency: 0 }),
      kindPool: fake,
    });
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
    await pool.routeQuestionsNow();

    const director = fake.opened.find((handle) => handle.role === "director" && handle.cwd === f.app);
    assert.ok(director, "the codex director lane opens");
    assert.equal(director.skillPath, join(skillDir, "SKILL.md"));
    assert.equal(director.prompts.length, 1, "the skill is loaded at open, not by an extra turn");
    assert.doesNotMatch(director.prompts[0], /^\/meerkat-director/);
    assert.match(director.prompts[0], /You are the Director/);
    assert.match(director.prompts[0], /--agent Director --actor-kind codex/);
    assert.doesNotMatch(director.prompts[0], /Decision policy:/);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");

    const ledgerFile = join(f.dir, "subagents.state.json");
    const ledger = existsSync(ledgerFile)
      ? JSON.parse(readFileSync(ledgerFile, "utf8"))
      : { subagents: [] };
    assert.deepEqual(ledger.subagents, [], "a question turn is not a subagent");
    await pool.stop();
  });

  it("opens the director lane on the kind that carries the director skill", async (t) => {
    // Installation location is the routing: the supervisor runs as claude, but the
    // director skill is installed under codex, so the director conversation must be
    // a codex session (inline skill, not Claude's /meerkat-director opener).
    const f = fixture(t);
    const board = join(f.dir, ".claude", "skills", "meerkat");
    mkdirSync(board, { recursive: true });
    writeFileSync(join(board, "SKILL.md"), "---\nname: meerkat\n---\n", "utf8");
    const skillDir = join(f.dir, ".codex", "skills", "meerkat-director");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: meerkat-director\n---\n", "utf8");
    writeFileSync(join(skillDir, "references", "decision-policy.md"), "# policy\n", "utf8");

    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { actorKind: "claude", maxConcurrency: 0 }),
      kindPool: fake,
    });
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
    await pool.routeQuestionsNow();

    const director = fake.opened.find((handle) => handle.role === "director" && handle.cwd === f.app);
    assert.ok(director, "the director lane opens");
    assert.equal(director.skillPath, join(skillDir, "SKILL.md"), "the codex skill is loaded at open");
    assert.doesNotMatch(director.prompts[0], /^\/meerkat-director/, "not the Claude opener");
    assert.match(director.prompts[0], /You are the Director/);
    assert.match(director.prompts[0], /--agent Director --actor-kind codex/);
    assert.doesNotMatch(director.prompts[0], /--actor-kind claude/);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("leaves a handoff pending while the worker's turn is still in flight", async (t) => {
    const f = fixture(t);
    let releaseFirst;
    const firstTurn = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let sends = 0;
    const fake = fakePool({
      behavior: async () => {
        sends += 1;
        if (sends === 1) await firstTurn;
        return {};
      },
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    const running = pool.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A second pending row for the same worker key, as a director release +
    // poll re-claim could leave behind. It must not be sent into the busy turn.
    const file = join(f.dir, "cards.queue.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.cards.push({
      version: 1,
      id: "T-1-worker-second",
      queue_kind: "handoff",
      role: "worker",
      card: "T-1",
      agent: "alice",
      project: "P",
      target_dir: f.app,
      round: 1,
      worker_key: "worker:T-1:r1",
      handoff: "work T-1",
      status: "pending",
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    });
    writeFileSync(file, JSON.stringify(value), "utf8");

    await pool.tick();
    assert.equal(sends, 1, "no second prompt is sent into the running session");
    assert.equal(
      readCards(f.dir).value.cards.find((entry) => entry.id === "T-1-worker-second").status,
      "pending",
    );

    releaseFirst();
    await running;
    await pool.stop();
  });

  it("routes a question while another worker's turn is still in flight", async (t) => {
    const f = fixture(t);
    let releaseWorker;
    const workerTurn = new Promise((resolve) => {
      releaseWorker = resolve;
    });
    const fake = fakePool({
      behavior: async ({ handle }) => {
        if (handle.role === "worker") await workerTurn;
        return {};
      },
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), {
      id: "question:T-2:q-1",
      queue_kind: "question",
      role: "question",
      card: "T-2",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      question_id: "q-1",
      question: "Which option?",
    });

    const running = pool.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The dispatch tick is blocked on T-1's worker turn. The official question
    // clock must still reach the director, or the worker's in-turn wait can only
    // time out.
    await pool.routeQuestionsNow();

    assert.ok(
      fake.opened.some((handle) => handle.role === "director"),
      "the director is routed while the worker holds",
    );
    assert.equal(
      readCards(f.dir).value.cards.find((entry) => entry.id === "question:T-2:q-1").status,
      "done",
    );

    releaseWorker();
    await running;
    await pool.stop();
  });

  it("requeues a question row when the director's note did not release the card", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const seen = [];
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      readQuestionOutcome: async (input) => {
        seen.push(input);
        return { ok: true, settled: false, status: "in_progress" };
      },
    });
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
    await pool.routeQuestionsNow();

    assert.deepEqual(seen.map((input) => [input.card, input.questionId]), [["T-1", "q-1"]]);
    const row = readCards(f.dir).value.cards.find((card) => card.id === "question:T-1:q-1");
    assert.equal(row.status, "pending", "the row is retried, not abandoned");
    assert.equal(row.attempts, 1);
    assert.match(row.lastError, /did not settle/);
    assert.ok(Date.parse(row.retry_at) > Date.now(), "the retry waits out the backoff");
    await pool.stop();
  });

  it("backs off a failed question turn instead of spinning", async (t) => {
    const f = fixture(t);
    const fake = fakePool({ behavior: async () => ({ ok: false, error: "spawn error" }) });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "question:T-1:q-8",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      question_id: "q-8",
      question: "Which option?",
    });
    await pool.routeQuestionsNow();

    const row = readCards(f.dir).value.cards.find((card) => card.id === "question:T-1:q-8");
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.ok(Date.parse(row.retry_at) > Date.now(), "the one-second interval must not retry at once");
    await pool.stop();
  });

  it("fails a question row after two unsettled turns", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      readQuestionOutcome: async () => ({ ok: true, settled: false, status: "in_progress" }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "question:T-1:q-9",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      question_id: "q-9",
      question: "Which option?",
    });
    await pool.routeQuestionsNow();
    // The retry is due after the backoff; drive it directly instead of sleeping.
    const file = join(f.dir, "cards.queue.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.cards.find((card) => card.id === "question:T-1:q-9").retry_at = null;
    writeFileSync(file, JSON.stringify(value), "utf8");
    await pool.routeQuestionsNow();

    const row = readCards(f.dir).value.cards.find((card) => card.id === "question:T-1:q-9");
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 2);
    await pool.stop();
  });

  it("completes a question row when the card was released or escalated", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      readQuestionOutcome: async () => ({ ok: true, settled: true, status: "todo" }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "question:T-1:q-2",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      question_id: "q-2",
      question: "Which option?",
    });
    await pool.routeQuestionsNow();
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("does not verify a route row (it assigns, it does not answer)", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const seen = [];
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      readQuestionOutcome: async (input) => {
        seen.push(input);
        return { ok: true, settled: false };
      },
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "route:T-7",
      queue_kind: "question",
      role: "question",
      card: "T-7",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      route: true,
      title: "Wire the widget",
    });
    await pool.routeQuestionsNow();
    assert.deepEqual(seen, []);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("completes the row fail-soft when the outcome read is unreadable", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      readQuestionOutcome: async () => ({ ok: false, error: "down" }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "question:T-1:q-3",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      question_id: "q-3",
      question: "Which option?",
    });
    await pool.routeQuestionsNow();
    // The next poll re-enqueues it if the question is still open; a failed read
    // itself is not proof that the director failed.
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("routes an unowned card in the director lane", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "route:T-7",
      queue_kind: "question",
      role: "question",
      card: "T-7",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      route: true,
      title: "Wire the widget",
      updated_at: "2026-01-01T00:00:00Z",
    });
    await pool.routeQuestionsNow();
    const director = fake.opened.find((handle) => handle.role === "director" && handle.cwd === f.app);
    assert.ok(director, "a route row wakes the director");
    assert.equal(director.prompts[0], "/meerkat-director\nFlags: --agent Director --actor-kind=claude");
    assert.match(director.prompts[1], /unowned todo/);
    assert.match(director.prompts[1], /--agent Director --actor-kind claude/);
    assert.match(director.prompts[1], /issue assign T-7 --assignee <role>/);
    assert.match(director.prompts[1], /goes to the Worker role/);
    enqueueCard(join(f.dir), {
      id: "route:T-8",
      queue_kind: "question",
      role: "question",
      card: "T-8",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      route: true,
      title: "Wire the second widget",
    });
    await pool.routeQuestionsNow();
    assert.equal(
      director.prompts.filter((prompt) => prompt.startsWith("/meerkat-director")).length,
      1,
      "the resident director session loads its skill once",
    );
    assert.match(director.prompts[2], /unowned todo/);
    assert.match(director.prompts[2], /--agent Director --actor-kind claude/);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("completes a timed-out handoff when the card already moved", async (t) => {
    const f = fixture(t);
    const fake = fakePool({
      behavior: () => ({ ok: false, error: "turn timed out after 1ms" }),
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
    const handle = fake.opened.find((entry) => entry.role === "worker");
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
    const worker = fake.opened.find((entry) => entry.role === "worker");
    assert.equal(
      worker?.prompts.length ?? 0,
      0,
      "no worker turn is sent for a delivered card",
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

    const worker = fake.opened.find((entry) => entry.role === "worker");
    assert.ok(worker, "a still-claimable card is retried");
    assert.match(worker.prompts[0], /work T-1/);
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
    const worker = fake.opened.find((entry) => entry.role === "worker");
    assert.equal(worker?.prompts.length ?? 0, 0, "no turn is sent on an unreadable check");
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
      behavior: async () => {
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

  it("counts a project's worktrees as one project", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { projectConcurrency: 1 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    // Two worktrees of one project: different directories, one project slot.
    const one = join(f.app, ".worktrees", "T-1");
    const two = join(f.app, ".worktrees", "T-2");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    enqueueCard(join(f.dir), { ...card(f, "T-1", one), project_dir: f.app });
    enqueueCard(join(f.dir), { ...card(f, "T-2", two), project_dir: f.app });
    await pool.tick();
    const cards = readCards(f.dir).value.cards;
    assert.equal(cards.filter((entry) => entry.status === "done").length, 1);
    assert.equal(
      cards.filter((entry) => entry.status === "pending").length,
      1,
      "the second worktree waits on the project cap, not on a directory",
    );
    await pool.stop();
  });

  it("requeues a failed batch and fails a card with no target directory", async (t) => {
    const f = fixture(t);
    let fail = true;
    const fake = fakePool({
      behavior: () => (fail ? { ok: false, error: "boom" } : {}),
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

  it("completes a successful worker turn without a separate subagent id", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const checks = [];
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: ({ card: ref }) => {
        checks.push(ref);
        return { ok: true, status: "in_progress", error: null };
      },
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "done");
    assert.equal(row.lastError, null);
    assert.equal(row.attempts, 0);
    assert.deepEqual(checks, [], "a worker turn is its own completion signal");
    await pool.stop();
  });

  it("requeues a failed worker turn when the board still calls the card todo", async (t) => {
    const f = fixture(t);
    const fake = fakePool({ behavior: () => ({ ok: false, error: "boom" }) });
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: () => ({ ok: true, status: "todo", error: null }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.match(row.lastError, /boom/);
    await pool.stop();
  });

  it("requeues a failed worker turn when the board check cannot be read", async (t) => {
    const f = fixture(t);
    const fake = fakePool({ behavior: () => ({ ok: false, error: "boom" }) });
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      revalidateCard: () => ({ ok: false, status: null, error: "down" }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "pending", "an unreadable check is not proof the handoff landed");
    assert.equal(row.attempts, 1);
    await pool.stop();
  });

  it("runs each review card in its own session and completes both", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      // A successful review delivers: the review card leaves in_progress.
      revalidateCard: () => ({ ok: true, status: "in_review", error: null }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    enqueueCard(join(f.dir), card(f, "R-2", f.app, "reviewer"));
    await pool.tick();

    const rows = readCards(f.dir).value.cards;
    assert.deepEqual(rows.map((row) => row.status), ["done", "done"]);
    assert.deepEqual(rows.map((row) => row.lastError), [null, null]);
    const reviewers = fake.opened.filter(
      (handle) => handle.role === "reviewer" && handle.cwd === f.app,
    );
    assert.equal(reviewers.length, 2, "one top-level session per review card");
    assert.deepEqual(
      reviewers.map((handle) => handle.prompts[0]).sort(),
      ["work R-1", "work R-2"],
      "no card's handoff crosses into another's session",
    );
    await pool.stop();
  });

  it("requeues a review turn that ended without a verdict", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fake,
      // The reviewer spoke, but the card is still in_progress: no delivery.
      revalidateCard: () => ({ ok: true, status: "in_progress", error: null }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "R-1", f.app, "reviewer"));
    await pool.tick();

    const [row] = readCards(f.dir).value.cards;
    assert.equal(row.status, "pending", "the handoff stays open for another turn");
    assert.equal(row.attempts, 1);
    assert.match(row.lastError, /without delivering a verdict/);
    await pool.stop();
  });

  it("closes an idle worker session but keeps its session id for resume", async (t) => {
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
    const key = workerKey("T-1", 1);
    const first = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    assert.ok(first);
    clock += 2000;
    await pool.tick();
    assert.equal(first.closed, true, "the idle worker session was closed");
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[key].sessionId, first.sessionId);
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    const second = fake.opened
      .filter((handle) => handle.role === "worker" && handle.cwd === f.app)
      .at(-1);
    assert.notEqual(second, first);
    assert.equal(second.sessionId, first.sessionId, "the reopened worker resumed the stored id");
    await pool.stop();
  });

  it("runs two actor kinds in one pool, dispatching each row on its own kind", async (t) => {
    const f = fixture(t);
    const claudePool = fakePool();
    const codexPool = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPools: new Map([
        ["claude", claudePool],
        ["codex", codexPool],
      ]),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), { ...card(f, "T-1", f.app), actor_kind: "claude" });
    enqueueCard(join(f.dir), { ...card(f, "T-2", f.api), actor_kind: "codex" });
    await pool.tick();
    assert.deepEqual(
      claudePool.opened.map((handle) => handle.cwd),
      [f.app],
      "the claude worker runs on claude",
    );
    assert.deepEqual(
      codexPool.opened.map((handle) => handle.cwd),
      [f.api],
      "the codex worker runs on codex",
    );
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[workerKey("T-1", 1)].actorKind, "claude");
    assert.equal(state.projects[workerKey("T-2", 1)].actorKind, "codex");
    await pool.stop();
  });

  it("runs a reviewer on its own kind while the worker runs on another", async (t) => {
    const f = fixture(t);
    const claudePool = fakePool();
    const codexPool = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPools: new Map([
        ["claude", claudePool],
        ["codex", codexPool],
      ]),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), { ...card(f, "W-1", f.app, "worker"), actor_kind: "claude" });
    enqueueCard(join(f.dir), { ...card(f, "R-1", f.app, "reviewer"), actor_kind: "codex" });
    await pool.tick();
    assert.deepEqual(
      claudePool.opened.map((handle) => handle.role),
      ["worker"],
      "the worker session stays on claude",
    );
    assert.deepEqual(
      codexPool.opened.map((handle) => handle.role),
      ["reviewer"],
      "the reviewer session runs on the kind carrying the reviewer role",
    );
    await pool.stop();
  });

  it("never resumes a role's old native session after it moves to another kind", async (t) => {
    const f = fixture(t);
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const claudePool = fakePool({ idPrefix: "claude" });
    const codexPool = fakePool({ idPrefix: "codex" });
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPools: new Map([
        ["claude", claudePool],
        ["codex", codexPool],
      ]),
      now: () => clock,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), { ...card(f, "T-1", f.app), actor_kind: "claude" });
    await pool.tick();
    const before = claudePool.opened.find((handle) => handle.role === "worker");
    assert.ok(before);

    // The role is migrated to codex; the same card is dispatched again.
    clock += 1000;
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      actor_kind: "codex",
      handoff: "work T-1",
    });
    await pool.tick();
    const after = codexPool.opened.find((handle) => handle.role === "worker");
    assert.ok(after, "the migrated role starts on its new kind");
    assert.equal(before.closed, true, "the old kind's conversation is closed, not reused");
    assert.notEqual(after.sessionId, before.sessionId, "the old kind's native id is never resumed");
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[workerKey("T-1", 1)].actorKind, "codex");
    await pool.stop();
  });

  it("replays with a fresh session after max-age", async (t) => {
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
    const first = fake.opened.find((handle) => handle.role === "worker" && handle.cwd === f.app);
    clock += 2000;
    await pool.tick();
    assert.equal(first.closed, true);
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();
    const second = fake.opened
      .filter((handle) => handle.role === "worker" && handle.cwd === f.app)
      .at(-1);
    assert.notEqual(second.sessionId, first.sessionId, "max-age forces a replay (new session)");
    assert.match(second.prompts[0], /could not be resumed/i, "the replay prompt carries the reason");
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
    mkdirSync(join(home, ".claude", "skills", "meerkat-director"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "meerkat-director", "SKILL.md"), "---\nname: x\n---\n");
    const lines = [];
    const code = await runSession(
      { ...optsFor(f), home, actorKind: "claude" },
      { log: (line) => lines.push(line) },
    );
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /missing skill/);
    assert.match(lines.join("\n"), /meerkat/);
  });

  it("returns 2 with a pool_start_failed record when start() throws", async (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    for (const name of ["meerkat", "meerkat-director"]) {
      const dir = join(home, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    // `start()` now only takes the lock and persists the starting phase, so the
    // throwing seam is the clock its first state write reads. A throw there used
    // to escape as an unhandled rejection and kill the pool with no record.
    let clockCalls = 0;
    const lines = [];
    const code = await runSession(
      { ...optsFor(f), home, actorKind: "claude" },
      {
        kindPool: {
          openSession() {
            throw new Error("spawn refused");
          },
          async close() {},
        },
        now: () => {
          clockCalls += 1;
          if (clockCalls === 1) throw new Error("spawn refused");
          return Date.parse("2026-01-01T00:00:00.000Z");
        },
        log: (line, meta) => lines.push({ line, meta }),
      },
    );

    assert.equal(code, 2, "a thrown start is the cannot-run code, not an escaped rejection");
    const record = lines.find((entry) => entry.meta?.event === "pool_start_failed");
    assert.ok(record, `no pool_start_failed record:\n${JSON.stringify(lines, null, 2)}`);
    assert.equal(record.meta.level, "error");
    assert.match(record.line, /spawn refused/);
    assert.equal(existsSync(join(f.dir, "session.lock")), false, "the failed start left no lock behind");
  });

  it("starts and stops cleanly once both skills are present", async (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    for (const name of ["meerkat", "meerkat-director"]) {
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

  it("starts when the director skill lives on another kind", async (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    const board = join(home, ".claude", "skills", "meerkat");
    mkdirSync(board, { recursive: true });
    writeFileSync(join(board, "SKILL.md"), "---\nname: meerkat\n---\n");
    const director = join(home, ".codex", "skills", "meerkat-director");
    mkdirSync(join(director, "references"), { recursive: true });
    writeFileSync(join(director, "SKILL.md"), "---\nname: meerkat-director\n---\n");
    writeFileSync(join(director, "references", "decision-policy.md"), "# policy\n");

    const controller = new AbortController();
    controller.abort();
    const lines = [];
    const code = await runSession(
      { ...optsFor(f), home, actorKind: "claude" },
      { log: (line) => lines.push(line), kindPool: fakePool(), signal: controller.signal },
    );
    assert.equal(code, 0, lines.join("\n"));
    assert.doesNotMatch(lines.join("\n"), /missing skill/);
    assert.equal(existsSync(join(f.dir, "session.lock")), false, "the lock is released");
  });

  const THROTTLE_MS = 10_000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Resolve on exit, or `{code:null, signal:null}` after `timeoutMs`; never hangs. */
  function waitExit(child, timeoutMs = 10_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal });
      };
      const timer = setTimeout(() => finish(null, null), timeoutMs);
      timer.unref?.();
      child.once("exit", finish);
    });
  }

  /** Last-resort cleanup: SIGKILL and wait, so a failed assertion cannot leak a child. */
  async function reap(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = waitExit(child, 2_000);
    child.kill("SIGKILL");
    await exited;
  }

  /**
   * Spawn `supervisor.mjs --session` with its own fixture and state dir (two pools
   * on one dir are refused by `session.lock`). No cards are seeded, so no kind
   * pool exists and no agent child holds the event loop.
   */
  async function startSessionChild(t, { control } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "tp-session-pool-child-"));
    const home = join(dir, "home");
    for (const name of ["meerkat", "meerkat-director"]) {
      const skillDir = join(home, ".claude", "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const logPath = join(dir, "supervisor.log");
    const args = [
      join(import.meta.dirname, "../../src/orchestrator/supervisor.mjs"),
      "--session",
      "--actor-kind", "claude",
      "--agent", "alice",
      "--home", home,
      "--repo", join(import.meta.dirname, "../.."),
      "--state", join(dir, "state.json"),
      "--log", logPath,
    ];
    if (control !== undefined) args.push(`--control=${control}`);
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    t.after(async () => {
      await reap(child);
      rmSync(dir, { recursive: true, force: true });
    });

    const sessionState = join(dir, "sessions.state.json");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (existsSync(sessionState)) {
        let state = null;
        try {
          state = JSON.parse(readFileSync(sessionState, "utf8"));
        } catch {
          /* a read that races the write is retried on the next beat */
        }
        if (state?.poolPid === child.pid && state?.phase === "running") break;
      }
      await sleep(25);
    }
    return { child, sessionState, logPath };
  }

  it(
    "keeps an idle pool resident in every control mode past the restart throttle",
    { timeout: 45_000 },
    async (t) => {
      const internal = await startSessionChild(t);
      const external = await startSessionChild(t, { control: "external" });
      const pools = [
        ["default/internal", internal],
        ["external", external],
      ];
      for (const [label, pool] of pools) {
        const log = existsSync(pool.logPath) ? readFileSync(pool.logPath, "utf8") : "(none)";
        assert.ok(existsSync(pool.sessionState), `${label}: the pool wrote its state; log: ${log}`);
      }

      // launchd's ThrottleInterval is 10s. Before the fix the internal pool exits
      // as soon as the event loop drains (Node's unsettled top-level await),
      // well inside this window.
      await sleep(THROTTLE_MS + 500);

      for (const [label, pool] of pools) {
        const log = existsSync(pool.logPath) ? readFileSync(pool.logPath, "utf8") : "(none)";
        assert.equal(
          pool.child.exitCode,
          null,
          `the ${label} pool exited while idle (code ${pool.child.exitCode}); log: ${log}`,
        );
        assert.equal(pool.child.signalCode, null, `${label}: the pool was not killed; log: ${log}`);
        assert.equal(
          JSON.parse(readFileSync(pool.sessionState, "utf8")).poolPid,
          pool.child.pid,
          `${label}: the state file names the live manager`,
        );

        // Attach the listener before the signal: a pool that exits between `kill`
        // and `once` would otherwise leave the await pending for ever.
        const exited = waitExit(pool.child, 10_000);
        pool.child.kill("SIGTERM");
        const outcome = await exited;
        assert.equal(outcome.signal, null, `${label}: SIGTERM shut it down without SIGKILL`);
        assert.equal(outcome.code, 0, `${label}: a clean shutdown; log: ${log}`);
      }
    },
  );

  it("answers 'is the pool resident?' from the state file, pid and heartbeat", (t) => {
    const f = fixture(t);
    const opts = optsFor(f);
    const clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };
    const writeState = (value) =>
      writeFileSync(join(f.dir, "sessions.state.json"), JSON.stringify({ version: 1, projects: {}, ...value }));

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
    assert.equal(
      stale.live,
      true,
      "a fresh pid is a live pool even when its heartbeat is stale (blocked, not absent)",
    );
    assert.equal(stale.verdict, "unresponsive", "the heartbeat distinguishes unresponsive from running");
    assert.match(stale.reason, /heartbeat .* old/);

    // A deployment decision beats a live file.
    const disabled = poolStatus({ opts: { ...opts, resident: "no" }, now: () => clock.now });
    assert.equal(disabled.live, false);
    assert.equal(disabled.reason, "--resident=no");
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

});

describe("worker session resume", () => {
  it("resumes an open same-round worker session with the answer", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();
    const first = fake.opened.find((handle) => handle.role === "worker");
    assert.ok(first);

    enqueueCard(join(f.dir), {
      id: "T-1-worker-resume",
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();

    const workers = fake.opened.filter((handle) => handle.role === "worker");
    assert.equal(workers.length, 1, "the same handle is reused");
    assert.equal(first.prompts.length, 2);
    assert.match(first.prompts[1], /same-round resume/i);
    assert.match(first.prompts[1], /work T-1/);
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[workerKey("T-1", 1)].resumeState, "resumed");
  });

  it("replays into a fresh session when the native resume fails", async (t) => {
    const f = fixture(t);
    let calls = 0;
    const fake = fakePool({
      behavior: () => {
        calls += 1;
        if (calls === 1) return {};
        if (calls === 2) return { ok: false, resumeFailed: true, error: "session not found" };
        return {};
      },
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();
    enqueueCard(join(f.dir), {
      id: "T-1-worker-resume",
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();

    const workers = fake.opened.filter((handle) => handle.role === "worker");
    assert.equal(workers.length, 2, "a new handle was opened for the replay");
    assert.match(workers[1].prompts[0], /could not be resumed/i);
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[workerKey("T-1", 1)].resumeState, "resumed_by_replay");
    const row = readCards(f.dir).value.cards.find((entry) => entry.id === "T-1-worker-resume");
    assert.equal(row.status, "done");
  });

  it("blocks the card when both resume and replay fail", async (t) => {
    const f = fixture(t);
    let calls = 0;
    const fake = fakePool({
      behavior: () => {
        calls += 1;
        if (calls === 1) return {};
        return { ok: false, resumeFailed: calls === 2, error: "cannot resume" };
      },
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();
    enqueueCard(join(f.dir), {
      id: "T-1-worker-resume",
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();

    assert.equal(
      fake.opened.filter((handle) => handle.role === "worker").length,
      2,
      "exactly one replay attempt",
    );
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    const record = state.projects[workerKey("T-1", 1)];
    assert.equal(record.blocked, true);
    assert.equal(record.status, "stale");
    const row = readCards(f.dir).value.cards.find((entry) => entry.id === "T-1-worker-resume");
    assert.equal(row.status, "failed");
    assert.match(row.lastError, /resume\/replay failed/);
  });

  it("recovers a processing worker row and resumes its stored session", async (t) => {
    const f = fixture(t);
    const key = workerKey("T-1", 1);
    writeFileSync(
      join(f.dir, "sessions.state.json"),
      JSON.stringify({
        version: 3,
            projects: {
          [key]: {
            kind: "worker-session",
            card: "T-1",
            round: 1,
            worktree: f.app,
            cwd: f.app,
            sessionId: "sid-old",
            status: "running",
            startedAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: key,
    });
    claimCards(join(f.dir), { claimedBy: f.app, pid: 999999, limit: 1 });
    assert.equal((await pool.start()).ok, true);
    // Recovery is the background reattach pass now, not part of start(); the
    // runSession entry runs it after the tick and heartbeat start.
    await pool.reattachOnStart();
    await pool.tick();

    const handle = fake.opened.find((entry) => entry.role === "worker");
    assert.ok(handle);
    assert.equal(handle.sessionId, "sid-old");
    assert.match(handle.prompts[0], /same-round resume/i);
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
  });

  it("starts a fresh generation on a round bump and closes the old one", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();
    const first = fake.opened.find((handle) => handle.role === "worker");
    enqueueCard(join(f.dir), {
      id: "T-1-r2",
      ...card(f, "T-1", f.app),
      round: 2,
      worker_key: workerKey("T-1", 2),
    });
    await pool.tick();

    const workers = fake.opened.filter((handle) => handle.role === "worker");
    assert.equal(workers.length, 2);
    assert.equal(first.closed, true, "the old generation is closed");
    assert.notEqual(workers[1].sessionId, first.sessionId);
    assert.doesNotMatch(workers[1].prompts[0], /same-round resume/i);
    const state = JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));
    assert.equal(state.projects[workerKey("T-1", 1)], undefined, "the old record retired");
    assert.ok(state.projects[workerKey("T-1", 2)]);
  });

  it("waits for the question lane before dispatching a worker handoff", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
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
      question: "Which?",
      asked_at: "2026-01-01T00:00:00Z",
    });
    enqueueCard(join(f.dir), {
      ...card(f, "T-1", f.app),
      round: 1,
      worker_key: workerKey("T-1", 1),
    });
    await pool.tick();
    assert.equal(
      fake.opened.filter((handle) => handle.role === "worker").length,
      0,
      "the worker waits while its question is open",
    );
    const workerRow = readCards(f.dir).value.cards.find((entry) => entry.id === "T-1-worker");
    assert.equal(workerRow.status, "pending");
    await pool.routeQuestionsNow();
    await pool.tick();
    assert.equal(
      fake.opened.filter((handle) => handle.role === "worker").length,
      1,
      "the worker runs after the question",
    );
  });

  it("does not let worker sessions consume the lane pool", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { sessionPoolMax: 1 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.api));
    await pool.tick();
    assert.equal(
      fake.opened.filter((handle) => handle.role === "worker").length,
      2,
      "workers are bounded by max-concurrency, not by sessionPoolMax",
    );
  });

  it("does not count resident worker sessions against the lane pool", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { sessionPoolMax: 1 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    enqueueCard(join(f.dir), card(f, "T-2", f.api));
    await pool.tick();
    assert.equal(
      fake.opened.filter((handle) => handle.role === "worker").length,
      2,
      "two resident worker sessions",
    );

    const third = join(f.dir, "third");
    mkdirSync(third, { recursive: true });
    enqueueCard(join(f.dir), {
      id: "question:T-3:q-1",
      queue_kind: "question",
      role: "question",
      card: "T-3",
      project: "P",
      agent: "alice",
      target_dir: third,
      question_id: "q-1",
      question: "Which option?",
      asked_at: "2026-01-01T00:00:00Z",
    });
    await pool.routeQuestionsNow();
    assert.ok(
      fake.opened.some((handle) => handle.role === "director" && handle.cwd === third),
      "resident worker sessions do not consume the non-worker lane pool",
    );
  });

  it("still bounds the non-worker lanes by the lane pool", async (t) => {
    const f = fixture(t);
    const fake = fakePool();
    const pool = createSessionPool({
      opts: optsFor(f, { sessionPoolMax: 1 }),
      kindPool: fake,
    });
    t.after(() => pool.stop());
    await pool.start();
    for (const [ref, dir] of [["T-1", f.app], ["T-2", f.api]]) {
      enqueueCard(join(f.dir), {
        id: `question:${ref}:q-1`,
        queue_kind: "question",
        role: "question",
        card: ref,
        project: "P",
        agent: "alice",
        target_dir: dir,
        question_id: "q-1",
        question: "Which option?",
        asked_at: "2026-01-01T00:00:00Z",
      });
    }
    await pool.routeQuestionsNow();
    assert.equal(
      fake.opened.filter((handle) => handle.role === "director").length,
      1,
      "one resident lane fills the pool",
    );
    assert.equal(
      readCards(f.dir).value.cards.filter((row) => row.status === "pending").length,
      1,
      "the second decision row waits for a free lane",
    );
  });
});

describe("worker session resume — handoff triage verification", () => {
  it("completes a triage row only on its marker, never on the done card's status", async (t) => {
    const f = fixture(t);
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fakePool(),
      triageOutcome: async () => ({ ok: true, settled: true, stale: false }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "triage:T-1:r2",
      queue_kind: "question",
      role: "triage",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      triage: true,
      round: 2,
      question_id: "triage:T-1:r2",
      dispatch_key: "triage:T-1:r2",
    });
    await pool.routeQuestionsNow();
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    await pool.stop();
  });

  it("completes a stale triage row without writing to the done card", async (t) => {
    const f = fixture(t);
    const calls = join(f.dir, "calls.jsonl");
    writeFileSync(
      join(f.dir, "cli.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'process.stdout.write(JSON.stringify({ ok: true, data: {} }));',
      ].join("\n"),
    );
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fakePool(),
      triageOutcome: async () => ({ ok: true, settled: false, stale: true }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "triage:T-2:r1",
      queue_kind: "question",
      role: "triage",
      card: "T-2",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      triage: true,
      round: 1,
      question_id: "triage:T-2:r1",
      dispatch_key: "triage:T-2:r1",
    });
    await pool.routeQuestionsNow();
    assert.equal(readCards(f.dir).value.cards[0].status, "done");
    const recorded = existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.equal(
      recorded.some((argv) => argv.includes("move")),
      false,
      "a stale triage never moves the done producer",
    );
    await pool.stop();
  });

  it("fails the row with a note, never a park, after two unsettled triage turns", async (t) => {
    const f = fixture(t);
    const calls = join(f.dir, "calls.jsonl");
    writeFileSync(
      join(f.dir, "cli.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'process.stdout.write(JSON.stringify({ ok: true, data: {} }));',
      ].join("\n"),
    );
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fakePool(),
      triageOutcome: async () => ({ ok: true, settled: false, stale: false }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "triage:T-3:r1",
      queue_kind: "question",
      role: "triage",
      card: "T-3",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      triage: true,
      round: 1,
      question_id: "triage:T-3:r1",
      dispatch_key: "triage:T-3:r1",
    });
    await pool.routeQuestionsNow();
    const queueFile = join(f.dir, "cards.queue.json");
    const raw = JSON.parse(readFileSync(queueFile, "utf8"));
    raw.cards[0].retry_at = null;
    writeFileSync(queueFile, `${JSON.stringify(raw, null, 2)}\n`);
    await pool.routeQuestionsNow();

    const row = readCards(f.dir).value.cards.find((card) => card.id === "triage:T-3:r1");
    assert.equal(row.status, "failed");
    const recorded = existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.equal(
      recorded.some((argv) => argv.includes("move") && argv.includes("blocked")),
      false,
      "a done producer is never parked",
    );
    assert.ok(
      recorded.some((argv) => argv.includes("comment") && argv.includes("add") && argv.includes("note")),
      "the failure is recorded as a note",
    );
    await pool.stop();
  });
});

describe("worker session resume — route verification", () => {
  it("retries a route turn, then parks an unowned card when the board never assigns it", async (t) => {
    const f = fixture(t);
    const calls = join(f.dir, "calls.jsonl");
    writeFileSync(
      join(f.dir, "cli.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'process.stdout.write(JSON.stringify({ ok: true, data: {} }));',
      ].join("\n"),
    );
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fakePool(),
      routeOutcome: async () => ({ ok: true, settled: false, status: "todo", assigned: null }),
    });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), {
      id: "route:T-1",
      queue_kind: "question",
      role: "question",
      card: "T-1",
      project: "P",
      agent: "alice",
      target_dir: f.app,
      route: true,
      question_id: "route:T-1",
      dispatch_key: "route:T-1",
      title: "unowned",
    });

    await pool.routeQuestionsNow();
    let row = readCards(f.dir).value.cards.find((card) => card.id === "route:T-1");
    assert.equal(row.status, "pending", "an unassigned card is retried, not treated as settled");
    assert.equal(row.attempts, 1);

    // The retry waits out the 30 s backoff; make the second turn due.
    const queueFile = join(f.dir, "cards.queue.json");
    const raw = JSON.parse(readFileSync(queueFile, "utf8"));
    raw.cards[0].retry_at = null;
    writeFileSync(queueFile, `${JSON.stringify(raw, null, 2)}\n`);

    await pool.routeQuestionsNow();
    row = readCards(f.dir).value.cards.find((card) => card.id === "route:T-1");
    assert.equal(row.status, "failed", "the second unsettled turn ends the automatic path");

    const recorded = existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
    assert.ok(
      recorded.some((argv) => argv.includes("issue") && argv.includes("move") && argv.includes("blocked") && argv.includes("decision")),
      `the card is parked for a human; calls: ${JSON.stringify(recorded)}`,
    );
    await pool.stop();
  });
});

describe("pool liveness — state facts and a non-blocking startup", () => {
  const readState = (f) => JSON.parse(readFileSync(join(f.dir, "sessions.state.json"), "utf8"));

  /** Put one processing row in the queue and one durable worker record for it. */
  function processingWorkerRow(f, ref) {
    const key = workerKey(ref, 1);
    const record = {
      kind: "worker-session",
      card: ref,
      round: 1,
      worktree: f.app,
      cwd: f.app,
      sessionId: `sid-${ref}`,
      status: "running",
      startedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    const file = join(f.dir, "sessions.state.json");
    const state = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { version: 3, projects: {} };
    state.projects = { ...(state.projects ?? {}), [key]: record };
    writeFileSync(file, JSON.stringify(state));
    enqueueCard(join(f.dir), {
      ...card(f, ref, f.app),
      round: 1,
      worker_key: key,
    });
    return key;
  }

  it("announces phase:starting before start(), then flips to running", async (t) => {
    const f = fixture(t);
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    t.after(() => pool.stop());

    const announced = pool.announceStarting();
    assert.equal(announced.ok, true);
    const starting = readState(f);
    assert.equal(starting.phase, "starting", "the startup window is published before start()");
    assert.ok(Date.parse(starting.startStartedAt) > 0, "the start began at a recorded instant");
    assert.equal(starting.poolPid, process.pid);
    assert.ok("poolPidStart" in starting, "the pool records its own start token");
    assert.ok("previousPoolPid" in starting, "the previous incarnation is named");
    assert.equal(starting.tickStartedAt, null);
    assert.ok("lastTickOkAt" in starting);
    assert.equal(starting.turnTimeoutMs, optsFor(f).sessionTurnTimeoutMs);

    assert.equal((await pool.start()).ok, true);
    assert.equal(readState(f).phase, "running", "start() flips the phase once the lock is held");
  });

  it("runSession publishes phase:starting before pool.start() can be refused", async (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    for (const name of ["meerkat", "meerkat-director"]) {
      const dir = join(home, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    // A live lock makes start() refuse before it writes any state. Only an
    // announce that ran before start() can have published the starting phase.
    writeFileSync(
      join(f.dir, "session.lock"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        pidStart: processStartToken(process.pid),
        startedAt: Date.now(),
        token: "other-holder",
      }),
    );
    const code = await runSession(
      { ...optsFor(f), home, actorKind: "claude" },
      { log: () => {}, kindPool: fakePool() },
    );
    assert.equal(code, 1, "a refused start is a runnable-but-not-owned exit");
    assert.equal(readState(f).phase, "starting");
  });

  it("records a tick in flight, then clears it and marks the last successful tick", async (t) => {
    const f = fixture(t);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fake = fakePool({
      behavior: async () => {
        await gate;
        return {};
      },
    });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));

    const tick = pool.tick();
    const during = readState(f);
    assert.equal(typeof during.tickStartedAt, "string", "a tick in flight is written before it awaits");

    release();
    await tick;
    const after = readState(f);
    assert.equal(after.tickStartedAt, null, "a finished tick leaves no in-flight marker");
    assert.ok(Date.parse(after.lastTickOkAt) > 0, "the finished tick is the last successful one");
  });

  it("writes a pidStart beside every open session", async (t) => {
    const f = fixture(t);
    const fake = {
      opened: [],
      openSession({ cwd, role, sessionId }) {
        const handle = {
          cwd,
          role,
          sessionId: sessionId ?? "sid-1",
          pid: process.pid,
          closed: false,
          prompts: [],
          async send() {
            return { ok: true, result: "ok" };
          },
          async close() {
            this.closed = true;
          },
        };
        this.opened.push(handle);
        return handle;
      },
      async close() {},
    };
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fake });
    t.after(() => pool.stop());
    await pool.start();
    enqueueCard(join(f.dir), card(f, "T-1", f.app));
    await pool.tick();

    const record = Object.entries(readState(f).projects).find(([key]) =>
      key.startsWith("worker:"),
    )?.[1];
    assert.ok(record, "the open worker session is persisted");
    assert.equal(record.pid, process.pid);
    assert.ok("pidStart" in record, "each session pid carries its start token");
    const token = processStartToken(process.pid);
    if (token !== null) assert.equal(record.pidStart, token);
  });

  it("does not reattach inside start(), only when the background pass runs", async (t) => {
    const f = fixture(t);
    processingWorkerRow(f, "T-1");
    claimCards(join(f.dir), { claimedBy: f.app, pid: 999_999, limit: 1 });
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    t.after(() => pool.stop());

    await pool.start();
    assert.equal(
      readCards(f.dir).value.cards[0].status,
      "processing",
      "start() returns without waiting on reattach; the tick and heartbeat own liveness",
    );
    await pool.reattachOnStart();
    assert.equal(readCards(f.dir).value.cards[0].status, "pending", "the background pass resumes it");
  });

  it("bounds reattach per group and records reattach_timeout", async (t) => {
    const f = fixture(t);
    const first = processingWorkerRow(f, "T-1");
    const second = processingWorkerRow(f, "T-2");
    claimCards(join(f.dir), { claimedBy: f.app, pid: 999_999, limit: 2 });

    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const logs = [];
    const pool = createSessionPool({
      opts: optsFor(f),
      kindPool: fakePool(),
      now: () => clock,
      log: (line, meta) => logs.push({ line, meta }),
      revalidateCard: async () => {
        // The first group's board read is slower than the whole reattach budget.
        clock += optsFor(f).sessionTurnTimeoutMs + 1_000;
        return { ok: true, status: "in_progress" };
      },
    });
    t.after(() => pool.stop());
    await pool.start();
    const result = await pool.reattachOnStart();

    const rows = readCards(f.dir).value.cards;
    assert.equal(rows.find((row) => row.card === "T-1").status, "pending", "the first group resumed");
    assert.equal(rows.find((row) => row.card === "T-2").status, "processing", "the deadline stops the pass");
    assert.equal(result.timedOut, 1);
    assert.ok(
      logs.some((entry) => entry.meta?.event === "reattach_timeout" && entry.meta.level === "warn"),
      `a timed-out group leaves one warn record: ${JSON.stringify(logs)}`,
    );
    assert.deepEqual(
      logs.find((entry) => entry.meta?.event === "reattach_timeout").meta.cards,
      ["T-2"],
    );
    assert.ok(first !== second);
  });

  it("never clobbers a live pool's state when announcing", (t) => {
    const f = fixture(t);
    const live = {
      version: 3,
      poolPid: process.pid,
      phase: "running",
      heartbeatAt: new Date().toISOString(),
      projects: {},
    };
    writeFileSync(join(f.dir, "sessions.state.json"), JSON.stringify(live));
    const pool = createSessionPool({ opts: optsFor(f), kindPool: fakePool() });
    t.after(() => pool.stop());

    const result = pool.announceStarting();
    assert.equal(result.ok, false, "a live pool is not ours to announce");
    assert.deepEqual(readState(f), live, "the live pool's file is untouched");
  });
});
