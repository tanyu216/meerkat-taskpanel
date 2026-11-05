/**
 * The external supervisor (T-20261010-013000).
 *
 * Two halves, deliberately:
 *
 *   * the **pure decision** — `planTick` / `planPatrol` / `parseHeartbeat` /
 *     `resolveClaimUnassigned` / `buildHandoff` / `wakeCommand` —
 *     is asserted directly. No process, no clock, no filesystem.
 *   * the **tick runner** — `runPollTick` / `runPatrolTick` — is driven with fully
 *     injected dependencies (candidate read, claim, worker spawn, clock, log), so the
 *     test can be a counter-proof rather than a smoke test: an *empty scan must call the
 *     worker spawn exactly zero times*, and patrol must never start an LLM by default.
 *
 * Mocking is limited to external I/O (the CLI read, the claim, the worker spawn, the
 * clock); no internal function is stubbed.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { repoRoot } from "../../src/foundation/runtime-locator.mjs";

import {
  DEFAULT_MAX_CONCURRENCY,
  buildHandoff,
  buildQuestionPrompt,
  buildReviewHandoff,
  candidateArgs,
  parseEnvFile,
  parseHeartbeat,
  planClaimIdentity,
  planPatrol,
  planPatrolClaim,
  planStrandedTodoAlerts,
  planTick,
  pruneRegistry,
  resolveClaimUnassigned,
  resolveRecoverStale,
  wakeCommand,
} from "../../src/foundation/scheduling.mjs";
import { emptySlaLedger, planSlaPatrol } from "../../src/foundation/sla-patrol.mjs";
import { processStartToken } from "../../src/foundation/daemon-state.mjs";
import { POOL_KILL_GRACE_MS, sendDeadlineMs } from "../../src/foundation/loop-state.mjs";
import { main as supervisorMain, runDaemon } from "../../src/orchestrator/supervisor.mjs";
import { agentPaths, defaultRepo, parseArgs, selectMode } from "../../src/orchestrator/options.mjs";
import { loadSlaLedger, readPeerLastOk, readPeerMarker, saveLastOk, saveSlaLedger } from "../../src/orchestrator/runtime.mjs";
import { notifyReal, runPatrolTick, runPollTick, runWorkflowTick } from "../../src/orchestrator/runners.mjs";
import { cliInvocation } from "../../src/orchestrator/runtime.mjs";
import { resolveWakeDir } from "../../src/foundation/project-dir.mjs";
import { PROJECT_DIR_CODES } from "../../src/foundation/project-dir.mjs";
import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { workflowToWire } from "../../src/foundation/wire.mjs";
import { cleanupTempDirs, withBoard } from "../helpers/sqlite-fixture.mjs";

/** A tiny collector standing in for a "spy" — records every call. */
function spy(impl = () => undefined) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  fn.count = () => calls.length;
  return fn;
}

const BASE_CONFIG = { maxConcurrency: DEFAULT_MAX_CONCURRENCY, claimUnassigned: true, actorKind: "claude" };

function candidate(identifier, agent = "alice", reason = "ready") {
  return { identifier, agent, reason, title: `work on ${identifier}`, project: "P1", target: "/repo" };
}

const EMPTY_REGISTRY = () => ({ version: 1, running: {} });

// ---------------------------------------------------------------------------
// Pure: planTick
// ---------------------------------------------------------------------------

describe("planTick (pure)", () => {
  it("returns no actions for an empty candidate list", () => {
    assert.deepEqual(planTick({ candidates: [], registry: EMPTY_REGISTRY(), config: BASE_CONFIG }), []);
  });

  it("orders a wake per candidate, tagged with the agent and reason", () => {
    const actions = planTick({
      candidates: [candidate("T-1"), candidate("T-2", "bob", "unassigned")],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
    });
    assert.equal(actions.length, 2);
    assert.deepEqual(actions[0], { type: "wake", identifier: "T-1", agent: "alice", reason: "ready" });
    assert.deepEqual(actions[1], { type: "wake", identifier: "T-2", agent: "bob", reason: "unassigned" });
  });

  it("caps new wakes at maxConcurrency minus running", () => {
    const registry = {
      version: 1,
      running: { "T-9": { agent: "alice", pid: 1 } },
    };
    const config = { ...BASE_CONFIG, maxConcurrency: 2 };
    const actions = planTick({
      candidates: [candidate("T-1"), candidate("T-2"), candidate("T-3")],
      registry,
      config,
    });
    const wakes = actions.filter((a) => a.type === "wake");
    assert.equal(wakes.length, 1, "one free slot (2 - 1 running)");
    assert.equal(wakes[0].identifier, "T-1");
    assert.equal(actions.filter((a) => a.type === "skip" && a.why === "cap").length, 2);
  });

  it("never re-wakes a card already in the registry (idempotent de-dup)", () => {
    const registry = { version: 1, running: { "T-1": { agent: "alice", pid: 42 } } };
    const actions = planTick({ candidates: [candidate("T-1")], registry, config: BASE_CONFIG });
    assert.deepEqual(actions, [{ type: "skip", identifier: "T-1", agent: "alice", why: "running" }]);
  });

  it("de-dups the same card offered to two agents within one tick (the public pool)", () => {
    const actions = planTick({
      candidates: [candidate("T-1", "alice", "unassigned"), candidate("T-1", "bob", "unassigned")],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
    });
    assert.equal(actions.filter((a) => a.type === "wake").length, 1);
    assert.deepEqual(actions[1], { type: "skip", identifier: "T-1", agent: "bob", why: "duplicate" });
  });

  it("wakes nothing when the cap is already saturated", () => {
    const registry = { version: 1, running: { "T-1": { agent: "alice", pid: 1 } } };
    const actions = planTick({
      candidates: [candidate("T-2")],
      registry,
      config: { ...BASE_CONFIG, maxConcurrency: 1 },
    });
    assert.equal(actions.filter((a) => a.type === "wake").length, 0);
    assert.equal(actions[0].why, "cap");
  });
});

// ---------------------------------------------------------------------------
// Pure: the claim identity (ADR 0015)
// ---------------------------------------------------------------------------

describe("planClaimIdentity (pure)", () => {
  const role = (id, agent, lanes, installedOn = ["claude"]) => ({ id, agent, lanes, installedOn });
  const LINUS = role("linus", "Linus", ["worker"]);
  const JOBS = role("jobs", "Jobs", ["worker"]);
  const WORKER = role("worker", "Worker", ["worker"]);
  const REVIEWER = role("reviewer", "Reviewer", ["reviewer"]);
  const roleSet = { roles: [LINUS, JOBS, WORKER, REVIEWER] };
  const ctx = {
    roleSet,
    primaryKind: "claude",
    kindOrder: ["claude", "codex", "pi"],
    kindAvailable: () => true,
    defaultAgent: "Worker",
  };
  const card = (overrides = {}) => ({
    identifier: "T-1",
    reason: "stale_any",
    assignee: "Linus",
    assignee_id: "a-linus",
    assignee_kind: "agent",
    ...overrides,
  });

  it("claims a stale card as its assignee, whoever scanned it", () => {
    assert.deepEqual(planClaimIdentity(card(), { ...ctx, scanAgent: "Jobs" }), {
      kind: "claim",
      agent: "Linus",
    });
  });

  it("keeps the old scan identity for a projection without the assignee field", () => {
    const plan = planClaimIdentity(
      { identifier: "T-1", reason: "ready", agent: "Jobs" },
      { ...ctx, scanAgent: "Turing" },
    );
    assert.deepEqual(plan, { kind: "claim", agent: "Jobs" });
  });

  it("claims an unassigned card as the explicit default agent", () => {
    const plan = planClaimIdentity(
      card({ assignee: null, assignee_id: null, assignee_kind: null, reason: "unassigned" }),
      { ...ctx, scanAgent: "Jobs" },
    );
    assert.deepEqual(plan, { kind: "claim", agent: "Worker" });
  });

  it("defers a card assigned to a human", () => {
    const plan = planClaimIdentity(card({ assignee: "Terry", assignee_kind: "human" }), ctx);
    assert.equal(plan.kind, "defer");
    assert.match(plan.why, /human/);
  });

  it("defers an unassigned review card and a review card on a worker-lane role", () => {
    const open = planClaimIdentity(card({ assignee: null, assignee_kind: null, review_of: "T-9" }), ctx);
    assert.equal(open.kind, "defer");
    const misrouted = planClaimIdentity(card({ review_of: "T-9" }), ctx);
    assert.equal(misrouted.kind, "defer");
    assert.match(misrouted.why, /reviewer/);
  });

  it("claims a review card with its reviewer-lane assignee", () => {
    const plan = planClaimIdentity(
      card({ assignee: "Reviewer", assignee_id: "a-rev", review_of: "T-9" }),
      ctx,
    );
    assert.deepEqual(plan, { kind: "claim", agent: "Reviewer" });
  });

  it("falls back to Worker only for a rotted stale work card with no installed assignee role", () => {
    const plan = planClaimIdentity(card({ assignee: "Ghost", assignee_id: "a-ghost" }), ctx);
    assert.equal(plan.kind, "claim");
    assert.equal(plan.agent, "Worker");
    assert.equal(plan.reassign.from, "Ghost");
    assert.equal(plan.reassign.to, "Worker");
    assert.match(plan.reassign.reason, /not installed/);
    assert.match(plan.reassign.reason, /reassigned to Worker/);
  });

  it("falls back when the assignee role is installed on no available kind", () => {
    const onlyCodex = { ...LINUS, installedOn: ["codex"] };
    const plan = planClaimIdentity(card(), {
      ...ctx,
      roleSet: { roles: [onlyCodex, WORKER, REVIEWER] },
      kindAvailable: (kind) => kind === "claude",
    });
    assert.equal(plan.kind, "claim");
    assert.equal(plan.agent, "Worker");
    assert.match(plan.reassign.reason, /installed on no available kind/);
  });

  it("never falls back for ready or stale_same cards, and never for a review card", () => {
    for (const reason of ["ready", "stale_same"]) {
      const plan = planClaimIdentity(card({ assignee: "Ghost", reason }), ctx);
      assert.equal(plan.kind, "defer", reason);
    }
    const review = planClaimIdentity(
      card({ assignee: "Ghost", review_of: "T-9" }),
      ctx,
    );
    assert.equal(review.kind, "defer");
  });

  it("re-claims a stale_same card when the scanning holder is its assignee", () => {
    // The candidate read offers `stale_same` only to the holder's own scan, so
    // this is the normal case: the holder re-claims its own route.
    const plan = planClaimIdentity(card({ reason: "stale_same" }), { ...ctx, scanAgent: "Linus" });
    assert.deepEqual(plan, { kind: "claim", agent: "Linus" });
  });

  it("defers a stale_same card whose route moved off the holder", () => {
    // The board lets only the holder re-claim inside the six-hour window. After
    // an audited override (or an `issue assign` of an in_progress card) the
    // holder and the assignee differ, so claiming as the assignee is refused
    // with EXECUTION_ACTIVE on every tick. The planner defers explicitly and
    // the six-hour bound hands the card to its route instead.
    const plan = planClaimIdentity(card({ reason: "stale_same" }), { ...ctx, scanAgent: "Jobs" });
    assert.equal(plan.kind, "defer");
    assert.match(plan.why, /stale_same/);
    assert.match(plan.why, /Jobs/);
  });

  it("applies the holder-only stale_same rule without a role layer too", () => {
    const moved = planClaimIdentity(card({ reason: "stale_same" }), {
      ...ctx,
      roleSet: null,
      scanAgent: "Jobs",
    });
    assert.equal(moved.kind, "defer");
    const own = planClaimIdentity(card({ reason: "stale_same" }), {
      ...ctx,
      roleSet: null,
      scanAgent: "Linus",
    });
    assert.deepEqual(own, { kind: "claim", agent: "Linus" });
  });

  it("uses the assignee name when no role layer is loaded", () => {
    const plan = planClaimIdentity(card(), { ...ctx, roleSet: null });
    assert.deepEqual(plan, { kind: "claim", agent: "Linus" });
  });

  it("defers an unassigned stale_same card when the pool's agent is not the holder", () => {
    // An unassigned in_progress card is the public pool, but inside the
    // 10min–6h window the board admits only its holder. The pool claims as
    // `defaultAgent` (Worker); if the holder that scanned it is somebody else,
    // that claim is refused with EXECUTION_ACTIVE on every tick. Defer until
    // six hours pass and `stale_any` frees the card — don't make the scan order
    // the executor by claiming as the holder.
    const plan = planClaimIdentity(
      card({ assignee: null, assignee_id: null, assignee_kind: null, reason: "stale_same" }),
      { ...ctx, scanAgent: "Jobs" },
    );
    assert.equal(plan.kind, "defer");
    assert.match(plan.why, /stale_same/);
    assert.match(plan.why, /Jobs/);
  });

  it("claims an unassigned stale_same card when the scanning holder is the pool's agent", () => {
    const plan = planClaimIdentity(
      card({ assignee: null, assignee_id: null, assignee_kind: null, reason: "stale_same" }),
      { ...ctx, defaultAgent: "Jobs", scanAgent: "Jobs" },
    );
    assert.deepEqual(plan, { kind: "claim", agent: "Jobs" });
  });
});

describe("planPatrolClaim (wire task → ADR 0015 identity)", () => {
  // The patrol reads `issue list`, whose Task DTO carries the assignee as an
  // actor-ref **object**, not the candidate projection's string. The patrol used
  // to claim as the holder (`alert.agent`) and dispatch with that identity; these
  // cases pin the decision to the same `planClaimIdentity` the poll uses.
  const role = (id, agent, lanes, installedOn = ["claude"]) => ({ id, agent, lanes, installedOn });
  const LINUS = role("linus", "Linus", ["worker"]);
  const JOBS = role("jobs", "Jobs", ["worker"]);
  const WORKER = role("worker", "Worker", ["worker"]);
  const REVIEWER = role("reviewer", "Reviewer", ["reviewer"]);
  const roleSet = { roles: [LINUS, JOBS, WORKER, REVIEWER] };
  const ctx = {
    roleSet,
    primaryKind: "claude",
    kindOrder: ["claude", "codex", "pi"],
    kindAvailable: () => true,
    defaultAgent: "Worker",
    scanAgent: "Jobs",
  };
  const MIN = 60_000;
  const ROTTED = 6 * 60 * MIN + MIN;
  const task = (overrides = {}) => ({
    identifier: "TP-1",
    project_id: "P",
    kind: "task",
    status: "in_progress",
    claimed_by: "a-jobs",
    claimed_by_actor: { id: "a-jobs", display_name: "Jobs", kind: "claude" },
    assignee_id: "a-linus",
    assignee_kind: "agent",
    assignee: { id: "a-linus", display_name: "Linus", kind: "agent" },
    ...overrides,
  });

  it("defers an in-window stale_same card whose route moved off the holder", () => {
    const plan = planPatrolClaim(task(), { ...ctx, ageMs: 45 * MIN });
    assert.equal(plan.kind, "defer");
    assert.match(plan.why, /stale_same/);
    assert.match(plan.why, /Jobs/);
  });

  it("claims a rotted stale card as its assignee, not the holder", () => {
    assert.deepEqual(planPatrolClaim(task(), { ...ctx, ageMs: ROTTED }), {
      kind: "claim",
      agent: "Linus",
    });
  });

  it("keeps the holder's own in-window claim", () => {
    const own = task({
      assignee_id: "a-jobs",
      assignee: { id: "a-jobs", display_name: "Jobs", kind: "agent" },
    });
    assert.deepEqual(planPatrolClaim(own, { ...ctx, ageMs: 45 * MIN }), {
      kind: "claim",
      agent: "Jobs",
    });
  });

  it("reads the actor-ref kind: a human assignee is deferred", () => {
    const human = task({
      assignee_id: "a-terry",
      assignee_kind: "human",
      assignee: { id: "a-terry", display_name: "Terry", kind: "human" },
    });
    const plan = planPatrolClaim(human, { ...ctx, ageMs: ROTTED });
    assert.equal(plan.kind, "defer");
    assert.match(plan.why, /human/);
  });

  it("plans the formal Worker reassignment for a rotted card with no assignee role", () => {
    const ghost = task({
      assignee_id: "a-ghost",
      assignee: { id: "a-ghost", display_name: "Ghost", kind: "agent" },
    });
    const plan = planPatrolClaim(ghost, { ...ctx, ageMs: ROTTED });
    assert.equal(plan.kind, "claim");
    assert.equal(plan.agent, "Worker");
    assert.equal(plan.reassign.from, "Ghost");
    assert.equal(plan.reassign.to, "Worker");
    assert.match(plan.reassign.reason, /not installed/);
  });

  it("defers an unassigned in-window card held by someone other than the pool agent", () => {
    const open = task({ assignee_id: null, assignee_kind: null, assignee: null });
    const plan = planPatrolClaim(open, { ...ctx, ageMs: 45 * MIN });
    assert.equal(plan.kind, "defer");
    assert.match(plan.why, /stale_same/);
  });

  it("defers rather than guesses when the heartbeat age is unreadable", () => {
    const plan = planPatrolClaim(task(), { ...ctx, ageMs: Number.NaN });
    assert.equal(plan.kind, "defer");
  });
});

// ---------------------------------------------------------------------------
// Pure: stranded todo cards
// ---------------------------------------------------------------------------

describe("planStrandedTodoAlerts (pure)", () => {
  const NOW = Date.parse("2026-10-30T12:00:00.000Z");
  const OLD = "2026-10-30T09:00:00.000Z"; // 3 h
  const FRESH = "2026-10-30T11:50:00.000Z"; // 10 min
  const AGING = 30 * 60 * 1000;
  const card = (identifier, over = {}) => ({
    identifier,
    kind: "task",
    status: "todo",
    status_changed_at: OLD,
    assignee: null,
    ...over,
  });

  it("flags an agent-assigned card whose name nobody scans, whatever the pool policy", () => {
    const alerts = planStrandedTodoAlerts({
      todoTasks: [card("PROJ-1", { assignee: { display_name: "Worker", kind: "claude" } })],
      agents: ["Jobs", "Linus", "Turing"],
      reviewer: "Reviewer",
      claimUnassigned: true,
      now: NOW,
      agingMs: AGING,
    });
    assert.deepEqual(
      alerts.map((a) => [a.type, a.reason, a.original]),
      [["unowned_todo", "assignee_not_scanned", "PROJ-1"]],
    );
  });

  it("does not flag a scanned role, the reviewer, a human owner, or an epic", () => {
    const alerts = planStrandedTodoAlerts({
      todoTasks: [
        card("PROJ-2", { assignee: { display_name: "linus", kind: "claude" } }),
        card("PROJ-3", { assignee: { display_name: "Reviewer", kind: "claude" } }),
        card("PROJ-4", { assignee: { display_name: "Terry", kind: "human" } }),
        card("PROJ-5", { kind: "epic", assignee: { display_name: "Worker", kind: "claude" } }),
      ],
      agents: ["Jobs", "Linus", "Turing"],
      reviewer: "Reviewer",
      claimUnassigned: true,
      now: NOW,
      agingMs: AGING,
    });
    assert.deepEqual(alerts, []);
  });

  it("flags a todo assigned only to a reviewer-only name when the worker set is known", () => {
    const alerts = planStrandedTodoAlerts({
      todoTasks: [card("PROJ-3", { assignee: { display_name: "Reviewer", kind: "claude" } })],
      workers: ["Jobs", "Linus", "Turing"],
      agents: ["Jobs", "Linus", "Turing", "Reviewer"],
      reviewer: "Reviewer",
      claimUnassigned: true,
      now: NOW,
      agingMs: AGING,
    });
    assert.deepEqual(
      alerts.map((a) => [a.type, a.reason, a.original]),
      [["unowned_todo", "assignee_not_scanned", "PROJ-3"]],
    );
  });

  it("never flags a review card, even when its reviewer is not a worker", () => {
    const alerts = planStrandedTodoAlerts({
      todoTasks: [
        card("PROJ-8", {
          assignee: { display_name: "Reviewer", kind: "claude" },
          review_of_id: "orig-1",
        }),
      ],
      workers: ["Jobs"],
      agents: ["Jobs", "Reviewer"],
      reviewer: "Reviewer",
      claimUnassigned: true,
      now: NOW,
      agingMs: AGING,
    });
    assert.deepEqual(alerts, []);
  });

  it("flags an unassigned claimable card only when the loop will not take the pool", () => {
    const pool = [{ identifier: "PROJ-6", reason: "unassigned", created_at: OLD }];
    const on = planStrandedTodoAlerts({
      unassignedPool: pool, agents: ["Jobs"], claimUnassigned: true, now: NOW, agingMs: AGING,
    });
    assert.deepEqual(on, [], "the pool is the normal path when claim_unassigned is on");
    const off = planStrandedTodoAlerts({
      unassignedPool: pool, agents: ["Jobs"], claimUnassigned: false, now: NOW, agingMs: AGING,
    });
    assert.deepEqual(
      off.map((a) => [a.type, a.reason, a.original]),
      [["unowned_todo", "unassigned", "PROJ-6"]],
    );
  });

  it("ignores a card younger than the aging window", () => {
    const alerts = planStrandedTodoAlerts({
      todoTasks: [card("PROJ-7", { status_changed_at: FRESH, assignee: { display_name: "Worker", kind: "claude" } })],
      agents: ["Jobs"],
      claimUnassigned: true,
      now: NOW,
      agingMs: AGING,
    });
    assert.deepEqual(alerts, []);
  });
});

// ---------------------------------------------------------------------------
// Pure: heartbeat classification + patrol
// ---------------------------------------------------------------------------

describe("parseHeartbeat (pure)", () => {
  it("reports a missing heartbeat rather than treating it as fresh", () => {
    assert.deepEqual(parseHeartbeat(null), { ok: false, reason: "missing" });
    assert.deepEqual(parseHeartbeat(undefined), { ok: false, reason: "missing" });
    assert.deepEqual(parseHeartbeat(""), { ok: false, reason: "missing" });
  });

  it("reports an unparsable heartbeat instead of silently dropping it", () => {
    const bad = parseHeartbeat("last tuesday-ish");
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "unreadable");
    assert.equal(bad.value, "last tuesday-ish");
    assert.equal(parseHeartbeat(12345).ok, false);
  });

  it("parses an ISO timestamp", () => {
    const parsed = parseHeartbeat("2026-10-09T12:00:00.000Z");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.at, Date.parse("2026-10-09T12:00:00.000Z"));
  });
});

describe("planPatrol (pure)", () => {
  const now = "2026-10-10T00:00:00.000Z";
  const ago = (minutes) => new Date(Date.parse(now) - minutes * 60_000).toISOString();

  it("flags a stale in_progress card (heartbeat older than 30 minutes)", () => {
    const alerts = planPatrol({
      tasks: [{
        identifier: "T-1",
        status: "in_progress",
        // `claimed_by` is an actor id since 0020; the readable holder rides the
        // `claimed_by_actor` ref, which is what the alert names.
        claimed_by: "a-1",
        claimed_by_actor: { id: "a-1", display_name: "alice", kind: "agent" },
        heartbeat_at: ago(31),
      }],
      now,
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "stale");
    assert.equal(alerts[0].identifier, "T-1");
    assert.equal(alerts[0].agent, "alice");
    assert.ok(alerts[0].ageMs >= 30 * 60_000);
  });

  it("stays silent for a fresh heartbeat (fresh ⇒ no-op)", () => {
    const alerts = planPatrol({
      tasks: [{ identifier: "T-1", status: "in_progress", heartbeat_at: ago(5) }],
      now,
    });
    assert.deepEqual(alerts, []);
  });

  it("raises a heartbeat-unreadable alert for a corrupt timestamp", () => {
    const alerts = planPatrol({
      tasks: [{ identifier: "T-2", status: "in_progress", heartbeat_at: "not-a-date" }],
      now,
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "heartbeat-unreadable");
    assert.equal(alerts[0].identifier, "T-2");
    assert.equal(alerts[0].value, "not-a-date");
  });

  it("raises the same fail-safe alert when the heartbeat is missing entirely", () => {
    const alerts = planPatrol({
      tasks: [{ identifier: "T-3", status: "in_progress", heartbeat_at: null }],
      now,
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "heartbeat-unreadable");
    assert.equal(alerts[0].reason, "missing");
  });

  it("ignores tasks that are not in_progress", () => {
    const alerts = planPatrol({
      tasks: [{ identifier: "T-4", status: "todo", heartbeat_at: null }],
      now,
    });
    assert.deepEqual(alerts, []);
  });

  // A container (`epic`) auto-started into in_progress is never claimed and
  // never pulses — that is the board's designed container state, not a stale
  // worker. Reporting it every pass is an observation bug, not a finding.
  it("never reports an epic container as a stale worker", () => {
    for (const heartbeat of [ago(31), null, "not-a-date"]) {
      const alerts = planPatrol({
        tasks: [{ identifier: "E-1", kind: "epic", status: "in_progress", heartbeat_at: heartbeat }],
        now,
      });
      assert.deepEqual(alerts, [], `epic with heartbeat_at=${String(heartbeat)}`);
    }
  });

  it("still reports a work card with the same shape", () => {
    const alerts = planPatrol({
      tasks: [{ identifier: "T-9", kind: "task", status: "in_progress", heartbeat_at: null }],
      now,
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "heartbeat-unreadable");
  });

  // M1 · A1 — an `awaiting` card has **no live session**, so its heartbeat is
  // necessarily stale. Patrol must read "is a human payload outstanding?", never
  // "how old is the heartbeat": escalating a card that is deliberately parked on
  // a person would page somebody about a card that is working exactly as meant.
  // The guard is structural — `planPatrol` only ever looks at `in_progress` — so
  // this is a lock-in assertion, and the point of writing it down is that a
  // future refactor which widens the status filter fails here.
  describe("`awaiting` is decoupled from heartbeat freshness (M1 · A1)", () => {
    const awaiting = (identifier, heartbeat_at) => ({ identifier, status: "awaiting", claimed_by: "linus", heartbeat_at });

    it("never raises a stale alert for an awaiting card, however old the heartbeat", () => {
      assert.deepEqual(planPatrol({ tasks: [awaiting("T-A", ago(31))], now }), []);
      assert.deepEqual(planPatrol({ tasks: [awaiting("T-A", ago(60 * 24))], now }), [], "a day-old heartbeat is still not news");
    });

    it("never raises a heartbeat-unreadable alert either — the missing-heartbeat case", () => {
      assert.deepEqual(planPatrol({ tasks: [awaiting("T-A", null)], now }), []);
      assert.deepEqual(planPatrol({ tasks: [awaiting("T-A", "not-a-date")], now }), []);
    });

    it("leaves an awaiting card unescalated while an identical in_progress card *is* escalated", () => {
      // The contrast is the assertion: same holder, same stale heartbeat, and the
      // status is the only difference. This is what "awaiting + old heartbeat is
      // not taken over; in_progress + old heartbeat is" means in the planner.
      const stale = ago(31);
      const alerts = planPatrol({
        tasks: [
          { identifier: "T-RUN", status: "in_progress", claimed_by: "linus", heartbeat_at: stale },
          { identifier: "T-WAIT", status: "awaiting", claimed_by: "linus", heartbeat_at: stale },
        ],
        now,
      });
      assert.deepEqual(alerts.map((a) => a.identifier), ["T-RUN"]);
      assert.equal(alerts[0].type, "stale");
    });

    it("keeps the awaiting card out of the dispatch pool as well as the alert list", () => {
      // `planTick`'s candidates come from `issue candidates`, whose recovery pool
      // is `status = in_progress` (commands/tasks.mjs) — so an awaiting card is
      // never offered, and the runner's `issue move <id> in_progress` claim never
      // fires for it. Asserted here as the tick's own property: an identifier the
      // board does not offer cannot be woken, and offering one twice is a skip.
      const actions = planTick({ candidates: [{ identifier: "T-RUN", agent: "linus" }], registry: EMPTY_REGISTRY(), config: BASE_CONFIG });
      assert.deepEqual(actions.map((a) => a.identifier), ["T-RUN"], "only the running card is a candidate");
    });
  });
});

// ---------------------------------------------------------------------------
// Pure: config resolution
// ---------------------------------------------------------------------------

describe("resolveClaimUnassigned (pure)", () => {
  it("defaults to on (yes) when nothing says otherwise", () => {
    assert.equal(resolveClaimUnassigned({}), true);
  });

  it("follows flag > env > file, and accepts yes/no spellings", () => {
    assert.equal(resolveClaimUnassigned({ flag: "no" }), false);
    assert.equal(resolveClaimUnassigned({ flag: "yes", env: "no" }), true);
    assert.equal(resolveClaimUnassigned({ env: "no", file: { MEERKAT_TASKPANEL_CLAIM_UNASSIGNED: "yes" } }), false);
    assert.equal(resolveClaimUnassigned({ file: { MEERKAT_TASKPANEL_CLAIM_UNASSIGNED: "no" } }), false);
    assert.equal(resolveClaimUnassigned({ flag: "false" }), false);
    assert.equal(resolveClaimUnassigned({ flag: "true" }), true);
    assert.equal(resolveClaimUnassigned({ flag: "1" }), true);
    assert.equal(resolveClaimUnassigned({ flag: "0" }), false);
    assert.equal(resolveClaimUnassigned({ flag: "y" }), true);
    assert.equal(resolveClaimUnassigned({ flag: "n" }), false);
  });

  it("ignores an unknown value and falls back to the next source", () => {
    assert.equal(resolveClaimUnassigned({ flag: "maybe", env: "no" }), false);
  });
});

describe("parseEnvFile (pure)", () => {
  it("reads KEY=value lines, ignoring blanks and comments", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no", 'OTHER="quoted value"', "export THIRD=1"].join("\n"),
    );
    assert.equal(parsed.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED, "no");
    assert.equal(parsed.OTHER, "quoted value");
    assert.equal(parsed.THIRD, "1");
  });
});

describe("candidateArgs (pure)", () => {
  it("adds --include-unassigned only when the pool is enabled", () => {
    assert.deepEqual(candidateArgs("alice", true), [
      "issue",
      "candidates",
      "--assignee",
      "alice",
      "--include-unassigned",
    ]);
    assert.deepEqual(candidateArgs("alice", false), ["issue", "candidates", "--assignee", "alice"]);
  });

  it("adds --stale only for the recovery policy", () => {
    assert.deepEqual(candidateArgs("alice", false, true), [
      "issue",
      "candidates",
      "--assignee",
      "alice",
      "--stale",
    ]);
    assert.deepEqual(candidateArgs("alice", true, true), [
      "issue",
      "candidates",
      "--assignee",
      "alice",
      "--include-unassigned",
      "--stale",
    ]);
  });
});

describe("resolveRecoverStale (pure)", () => {
  it("prefers flag > environment > agent config, and defaults to on", () => {
    assert.equal(resolveRecoverStale(), true);
    assert.equal(resolveRecoverStale({ file: { MEERKAT_TASKPANEL_RECOVER_STALE: "no" } }), false);
    assert.equal(
      resolveRecoverStale({
        env: "yes",
        file: { MEERKAT_TASKPANEL_RECOVER_STALE: "no" },
      }),
      true,
    );
    assert.equal(
      resolveRecoverStale({
        flag: "no",
        env: "yes",
        file: { MEERKAT_TASKPANEL_RECOVER_STALE: "yes" },
      }),
      false,
    );
    assert.equal(resolveRecoverStale({ flag: "maybe", env: "nonsense" }), true, "unreadable values are ignored");
  });
});

// ---------------------------------------------------------------------------
// Pure: wake command + handoff
// ---------------------------------------------------------------------------

describe("wakeCommand (pure)", () => {
  it("builds a headless claude wake, resuming a session when one is known", () => {
    const fresh = wakeCommand({ actorKind: "claude", prompt: "do T-1" });
    assert.equal(fresh.command, "claude");
    assert.deepEqual(fresh.args, ["-p", "do T-1"]);

    const resumed = wakeCommand({ actorKind: "claude", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["-p", "do T-1", "--resume", "sid-9"]);
  });

  it("builds a codex exec wake, resuming a thread when a session id is known", () => {
    const fresh = wakeCommand({ actorKind: "codex", prompt: "do T-1" });
    assert.equal(fresh.command, "codex");
    assert.deepEqual(fresh.args, ["exec", "do T-1"]);

    const resumed = wakeCommand({ actorKind: "codex", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["exec", "resume", "sid-9", "do T-1"]);
  });

  it("builds a pi wake (--print, no `run`), resuming a session when an id is known", () => {
    const fresh = wakeCommand({ actorKind: "pi", prompt: "do T-1" });
    assert.equal(fresh.command, "pi");
    assert.deepEqual(fresh.args, ["--print", "do T-1"]);
    assert.ok(!fresh.args.includes("run"), "pi has no `run` subcommand — headless is `--print`");

    const resumed = wakeCommand({ actorKind: "pi", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["--print", "--session", "sid-9", "do T-1"]);
  });

});


describe("buildQuestionPrompt (pure)", () => {
  const text = buildQuestionPrompt(
    [
      {
        card: "T-1",
        project: "P",
        target_dir: "/work/app",
        agent: "alice",
        question_id: "q-1",
        question: "Which option?",
        asked_at: "2026-01-01T00:00:00Z",
      },
    ],
    { actorKind: "claude", decisionPolicyPath: "/roles/decision-policy.md" },
  );

  it("checks the card is still in progress before writing anything", () => {
    assert.match(text, /taskctl issue get T-1 --json/);
    assert.match(text, /status is not `in_progress`/);
    assert.match(text, /do nothing/);
  });

  it("carries the answer-or-escalate protocol and the lane's prohibitions", () => {
    assert.match(text, /never spawn a subagent/);
    assert.match(text, /--kind note/);
    assert.match(text, /issue move T-1 todo/);
    assert.match(text, /awaiting --awaiting-reason/);
    assert.match(text, /never use --as-human/);
    assert.match(text, /Never move a card to done/);
    assert.match(text, /Decision policy: \/roles\/decision-policy\.md/);
  });

  it("signs every row as the Director, not the asking worker", () => {
    assert.match(text, /You are the Director for P at \/work\/app\./);
    assert.match(text, /--agent Director --actor-kind claude/);
    assert.doesNotMatch(text, /--agent alice/);
  });

  it("names the kind that actually runs the lane", () => {
    const codex = buildQuestionPrompt(
      [{
        card: "T-3",
        project: "P",
        target_dir: "/work/app",
        agent: "alice",
        question_id: "q-3",
        question: "Which option?",
      }],
      { actorKind: "codex" },
    );
    assert.match(codex, /--agent Director --actor-kind codex/);
    assert.doesNotMatch(codex, /--actor-kind claude/);
  });

  it("points a triage row at the project graph before the per-deliverable fallback", () => {
    const triage = buildQuestionPrompt(
      [{ triage: true, card: "P-1", project: "P", round: 1, title: "design" }],
      { actorKind: "claude" },
    );
    assert.match(triage, /docs\/agents\/epic-graphs\.md/);
    assert.match(triage, /taskctl project dir P --json/);
    assert.match(triage, /--parent <epic> --target <stage-id>/);
    assert.match(triage, /Epic mode/, "the graph's epic mode is honored");
    assert.match(triage, /When no graph\s+matches/);
  });

  it("signs a route row as the Director too", () => {
    const route = buildQuestionPrompt(
      [{ card: "T-4", project: "P", target_dir: "/work/app", agent: "alice", route: true, title: "wire it" }],
      { actorKind: "claude" },
    );
    assert.match(route, /--agent Director --actor-kind claude/);
    assert.doesNotMatch(route, /--agent alice/);
  });

  it("releases an already-answered card instead of re-answering it", () => {
    // A retry after a note-only turn must converge: the note is the answer, the
    // release is what the worker waits for.
    assert.match(text, /If a later comment already answers it and the card is still `in_progress`/);
    assert.match(text, /do NOT answer again — release the card/);
    assert.match(text, /the release is what the worker waits for/);
  });

  it("bounds a huge question body", () => {
    const huge = buildQuestionPrompt(
      [{
        card: "T-2",
        project: "P",
        target_dir: "/work/app",
        agent: "alice",
        question_id: "q-2",
        question: `${"Q".repeat(2000)}TAILMARKER`,
      }],
      { actorKind: "claude" },
    );
    assert.match(huge, /\[truncated\]/);
    assert.equal(huge.includes("TAILMARKER"), false, "the over-limit body does not reach the prompt");
  });
});

describe("buildHandoff (pure)", () => {
  it("carries the card, the attribution flags and the claim-first rules, bounded", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1", target: "/repo" },
      agent: "alice",
      actorKind: "claude",
      sessionId: "sid-9",
    });
    assert.match(text, /T-1/);
    assert.match(text, /Wire the supervisor/);
    assert.match(text, /--agent alice/);
    assert.match(text, /--actor-kind claude/);
    assert.match(text, /--session-id sid-9/);
    assert.match(text, /report/i);
    assert.ok(text.length < 3600, "the handoff must be bounded");
  });

  it("places the worker in the project and says the claim is already taken", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(text, /^You are the worker for the P1 project/);
    assert.match(text, /working directory is this card's workspace/);
    assert.match(text, /other projects' paths stay untouched/);
    assert.match(text, /already claimed this card for you: keep the claim with a heartbeat/);
  });

  it("points the worker at the authoritative card brief and the process directory", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(text, /Task brief: \.meerkat\/T-1\/card\.md/);
    assert.match(text, /read it first, it is authoritative/);
    assert.match(text, /Read \.meerkat\/T-1\/card\.md as the loop's export/);
    assert.match(text, /Put your process files[^\n]*\.meerkat\/T-1\//);
    assert.match(text, /taskctl attachment download <attachment-id> --out \.meerkat\/T-1\//);
    assert.match(text, /On resume, re-read \.meerkat\/T-1\/card\.md/);
    assert.match(text, /issue get T-1 --json/, "the live read stays as the version/status source");
  });

  it("truncates an absurdly long title so the handoff stays bounded", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "x".repeat(5000), project: "P1", target: "/repo" },
      agent: "alice",
      actorKind: "codex",
    });
    assert.ok(text.length < 3900, `the handoff must be bounded (was ${text.length})`);
  });

  it("asks the director before splitting an epic, rather than promoting it", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(text, /Step 0/);
    // The decision ladder: a subagent does not decide a split (or a scope
    // expansion) itself; it asks the director, which may escalate E1.
    assert.match(text, /Let the director promote or split/);
    assert.match(text, /add an agent question/);
    assert.match(text, /keep the card in_progress/);
    assert.match(text, /scope expansion is E1/);
    assert.match(text, /meta\.epic_triage=off/);
    // Sizing is by deliverable, not by layer: the worker must be told that a
    // slice of one change is not one of "several deliverables".
    assert.match(text, /or layers of one change\?/, "a layer of one change is not a split");
    assert.doesNotMatch(text, /--kind epic/);
    assert.doesNotMatch(text, /relation add T-1 --type parent/);
    assert.match(
      text,
      /stop at in_review — the loop dispatches an independent reviewer; after APPROVE it closes the card/,
      "the default mode is auto: an undeclared card is reviewed",
    );
  });

  it("tells a human-mode worker its review still runs — the mode selects only the closer", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1", acceptance_mode: "human" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(
      text,
      /the loop dispatches an independent reviewer; a human accepts after APPROVE/,
      "human is reviewed; only the close is the person's",
    );
  });

  it("sets the acceptance list before work and escalates questions to the director", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
      sessionId: "sid-9",
    });
    assert.match(text, /Step 1/);
    assert.match(text, /issue get T-1 --json/);
    assert.match(text, /comment list/);
    assert.match(text, /--limit 200/);
    // 0032 — the card's `acceptance` snapshot is the baseline; meta is its seed.
    assert.match(text, /FROZEN baseline/);
    assert.match(text, /meta\.acceptance is only/);
    assert.match(text, /append new items; keep the existing ones/i);
    assert.match(text, /acceptance_derived=yes/);
    // The worker no longer enters awaiting itself: it asks the director,
    // which answers or escalates E1-E5 to the human.
    assert.match(text, /add an agent question comment/);
    assert.match(text, /Route it to the director/);
    assert.match(text, /E1-E5/);
    assert.doesNotMatch(text, /--awaiting-reason/);
  });

  it("stays bounded with a maximum title and a UUID session id", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "x".repeat(300), project: "P1" },
      agent: "alice",
      actorKind: "claude",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    assert.ok(text.length < 3900, `the handoff must be bounded (was ${text.length})`);
  });

  it("points the worker at the reviewer when one is configured", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
      review: true,
    });
    assert.match(text, /the loop dispatches an independent reviewer/);
    assert.match(text, /after APPROVE it closes the card/);
  });

  it("reads the closing rule from the card's acceptance mode", () => {
    const text = (acceptance_mode) =>
      buildHandoff({
        card: { identifier: "T-1", title: "Wire the supervisor", project: "P1", acceptance_mode },
        agent: "alice",
        actorKind: "claude",
      });
    assert.match(text("off"), /the loop auto-accepts an off card/);
    assert.match(text("agent"), /the loop dispatches an independent reviewer/);
    assert.match(text("human"), /a human accepts after APPROVE/);
    // The card's own mode wins over the identity hint: a reviewer agent working
    // an `off` card is not told the loop will dispatch a reviewer for it.
    assert.match(
      buildHandoff({
        card: { identifier: "T-1", title: "x", project: "P1", acceptance_mode: "off" },
        agent: "rev",
        actorKind: "claude",
        review: true,
      }),
      /the loop auto-accepts an off card/,
    );
  });

  it("does not carry the continue command prefix", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "x", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.equal(text.includes("/meerkat-loop"), false);
  });
});

describe("buildReviewHandoff (pure)", () => {
  const text = buildReviewHandoff({
    card: { identifier: "T-2", review_of: "T-1", review_round: 3 },
    agent: "jobs",
    actorKind: "claude",
  });

  it("names both cards, the round and the attribution flags, bounded", () => {
    assert.match(text, /Review card: T-2/);
    assert.match(text, /Card under review: T-1 \(round 3\)/);
    assert.match(text, /--agent jobs/);
    assert.match(text, /--actor-kind claude/);
    assert.ok(text.length < 3600, "the handoff must be bounded");
  });

  it("points the reviewer at both briefs and the never-edit rule", () => {
    assert.match(text, /Review brief: \.meerkat\/T-2\/card\.md/);
    assert.match(text, /Original brief: \.meerkat\/T-1\/card\.md/);
    assert.match(text, /Read a card\.md as the loop's export/);
    assert.match(text, /This lane is read-only/);
    assert.doesNotMatch(text, /Put your process files|attachment download/);
    assert.match(text, /On resume, re-read \.meerkat\/T-2\/card\.md/);
  });

  it("is the reviewer for the project, with the claim already taken", () => {
    assert.match(text, /^You are the reviewer for the <project id> project/);
    assert.match(text, /already claimed this review card for you: keep the claim with a heartbeat/);
    assert.match(text, /heartbeat only this review card/);
  });

  it("checks review_not_ready before reading anything else", () => {
    assert.match(text, /review_not_ready/);
    assert.match(text, /taskctl issue get T-1 --json/);
    assert.match(text, /no longer in_review \/ the round changed/);
    assert.match(text, /stop before a verdict/);
  });

  it("audits a worker-derived acceptance list for coverage", () => {
    assert.match(text, /acceptance_derived/);
    assert.match(text, /covers every requirement/);
    assert.match(text, /narrows/);
    assert.match(text, /VERDICT: REJECT/);
  });

  it("reads the delivery report and the trail, and names the verdict protocol", () => {
    assert.match(text, /taskctl report list T-1/);
    assert.match(text, /comment list T-1 --limit 200/);
    assert.match(text, /relation list T-1/);
    assert.match(text, /VERDICT: APPROVE/);
    assert.match(text, /VERDICT: REJECT/);
    assert.match(text, /issue deliver T-2 --report-file -/);
  });

  it("moves nothing — the loop is the acceptor", () => {
    assert.match(text, /Leave both cards where they are/);
    assert.match(text, /the loop applies the verdict and closes this card/);
  });

  it("does not carry the continue command prefix", () => {
    assert.equal(text.includes("/meerkat-loop"), false);
  });
});

// ---------------------------------------------------------------------------
// Tick runner: poll
// ---------------------------------------------------------------------------

describe("runPollTick (injected deps)", () => {
  it("empty candidate scan ⇒ zero worker spawns (counter-proof)", async () => {
    const spawnWorker = spy(async () => ({ ok: true, pid: 1 }));
    const claim = spy(async () => ({ ok: true }));
    const readCandidates = spy(async () => []);

    const result = await runPollTick({
      agents: ["alice"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      readCandidates,
      claim,
      spawnWorker,
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });

    assert.equal(readCandidates.count(), 1, "the scan still happened once per agent");
    assert.equal(spawnWorker.count(), 0, "no candidate ⇒ no worker process");
    assert.equal(claim.count(), 0);
    assert.equal(result.spawned, 0);
  });

  it("claims before it wakes, and records the running card", async () => {
    const order = [];
    const registry = EMPTY_REGISTRY();
    const claim = spy(async (identifier) => {
      order.push(`claim:${identifier}`);
      return { ok: true };
    });
    const spawnWorker = spy(async (action) => {
      order.push(`spawn:${action.identifier}`);
      return { ok: true, pid: 4242 };
    });

    const result = await runPollTick({
      agents: ["alice"],
      registry,
      config: BASE_CONFIG,
      readCandidates: async () => [candidate("T-1")],
      claim,
      spawnWorker,
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });

    assert.deepEqual(order, ["claim:T-1", "spawn:T-1"]);
    assert.equal(result.spawned, 1);
    assert.equal(registry.running["T-1"].pid, 4242);
    assert.equal(registry.running["T-1"].agent, "alice");
  });

  it("claims as the supervisor's kind while the worker row carries its role's kind", () => {
    // The claim is the supervisor's act; the session that follows runs as the
    // role's own platform. `actorKind` is passed explicitly at the claim site.
    const { argv } = cliInvocation(
      { cli: "taskctl", actorKind: "claude" },
      "Turing",
      ["issue", "claim", "T-1"],
      { actorKind: "claude" },
    );
    assert.equal(argv[argv.indexOf("--agent") + 1], "Turing");
    assert.equal(argv[argv.indexOf("--actor-kind") + 1], "claude");
  });

  it("does not claim a card whose role no available platform carries", async () => {
    let claims = 0;
    const result = await runPollTick({
      agents: ["Turing"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      readCandidates: async () => [candidate("T-1", "Turing")],
      authorize: () => ({ ok: false, why: "no available platform carries role Turing" }),
      claim: async () => {
        claims += 1;
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(claims, 0, "the card stays todo, never claimed on a dead platform");
    assert.equal(result.deferred, 1);
    assert.equal(result.spawned, 0);
  });

  it("claims an unassigned card as the explicit default agent, not the first scan agent", async () => {
    const claims = [];
    const registry = EMPTY_REGISTRY();
    const result = await runPollTick({
      agents: ["Jobs", "Turing", "Worker"],
      registry,
      config: { ...BASE_CONFIG, claimUnassigned: true },
      // The pool lists the same unassigned card for every scanner.
      readCandidates: async (_agent) => [
        { identifier: "T-1", agent: null, reason: "unassigned", project: "P1" },
      ],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      defaultAgent: "Worker",
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, [["T-1", "Worker"]], "one claim, made as Worker");
    assert.equal(result.spawned, 1);
    assert.equal(registry.running["T-1"].agent, "Worker");
  });

  it("claims an assigned card as the scan agent when the board row carries no agent field", async () => {
    const claims = [];
    const registry = EMPTY_REGISTRY();
    const result = await runPollTick({
      agents: ["Jobs", "Linus"],
      registry,
      config: { ...BASE_CONFIG, claimUnassigned: true },
      // The board scopes a candidate to the asking agent and does not put an
      // `agent` field on the row: only `reason: "unassigned"` marks the public
      // pool. A missing field must not turn an assigned card into a default-agent
      // claim (the board refuses that as `not_assignee`).
      readCandidates: async (agent) =>
        agent === "Linus" ? [{ identifier: "T-1", reason: "ready", project: "P1" }] : [],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      defaultAgent: "Worker",
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, [["T-1", "Linus"]], "the scan agent that saw the card is its assignee");
    assert.equal(result.spawned, 1);
    assert.equal(registry.running["T-1"].agent, "Linus");
  });

  it("claims and dispatches as the card's assignee even when another agent scans it first", async () => {
    // The regression this pins (TP-0077): a stale card assigned to Linus was
    // taken by Jobs, the first scanner, and run as /jobs. The route decides.
    const claims = [];
    const roleSet = {
      roles: [
        { id: "jobs", agent: "Jobs", lanes: ["worker"], installedOn: ["claude"] },
        { id: "linus", agent: "Linus", lanes: ["worker"], installedOn: ["claude"] },
        { id: "worker", agent: "Worker", lanes: ["worker"], installedOn: ["claude"] },
      ],
    };
    const registry = EMPTY_REGISTRY();
    const result = await runPollTick({
      agents: ["Jobs", "Linus"],
      registry,
      config: { ...BASE_CONFIG, claimUnassigned: true },
      roleSet,
      // The stale-recovery pool is not scoped to the asker: Jobs sees it first
      // and Linus never does.
      readCandidates: async (agent) =>
        agent === "Jobs"
          ? [
              {
                identifier: "T-1",
                reason: "stale_any",
                project: "P1",
                assignee: "Linus",
                assignee_id: "a-linus",
                assignee_kind: "agent",
                version: 1,
              },
            ]
          : [],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      defaultAgent: "Worker",
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, [["T-1", "Linus"]], "the assignee claims its own card");
    assert.equal(result.spawned, 1);
    assert.equal(registry.running["T-1"].agent, "Linus", "and the session runs as the assignee");
  });

  it("defers a stale_same claim whose route moved, instead of claiming the assignee", async () => {
    // The holder (Jobs) still holds the live claim, but the card is routed to
    // Linus. The board allows only the holder to re-claim inside the six-hour
    // window; claiming as Linus would be refused as EXECUTION_ACTIVE on every
    // tick, so the tick defers and leaves the card to its route.
    const claims = [];
    const logged = [];
    const roleSet = {
      roles: [
        { id: "jobs", agent: "Jobs", lanes: ["worker"], installedOn: ["claude"] },
        { id: "linus", agent: "Linus", lanes: ["worker"], installedOn: ["claude"] },
      ],
    };
    const result = await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      roleSet,
      readCandidates: async () => [
        {
          identifier: "T-1",
          reason: "stale_same",
          project: "P1",
          assignee: "Linus",
          assignee_id: "a-linus",
          assignee_kind: "agent",
          version: 1,
        },
      ],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: (line) => logged.push(line),
    });
    assert.deepEqual(claims, [], "never claim a holder-only window as the assignee");
    assert.equal(result.deferred, 1);
    assert.equal(result.spawned, 0);
    assert.match(logged.join("\n"), /defer T-1 .*stale_same/);
  });

  it("defers an unassigned stale_same claim when the pool's agent is not the holder", async () => {
    // Inside the six-hour window the board admits only the holder, even for an
    // unassigned card. The public pool claims as `defaultAgent`; when the holder
    // that scanned it is someone else, every tick would get EXECUTION_ACTIVE, so
    // the tick defers until `stale_any` frees the card.
    const claims = [];
    const logged = [];
    const result = await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      roleSet: {
        roles: [{ id: "worker", agent: "Worker", lanes: ["worker"], installedOn: ["claude"] }],
      },
      readCandidates: async () => [
        {
          identifier: "T-1",
          reason: "stale_same",
          project: "P1",
          assignee: null,
          assignee_id: null,
          assignee_kind: null,
          version: 1,
        },
      ],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      defaultAgent: "Worker",
      now: () => "2026-10-10T00:00:00.000Z",
      log: (line) => logged.push(line),
    });
    assert.deepEqual(claims, [], "never claim the holder-only window as Worker");
    assert.equal(result.deferred, 1);
    assert.equal(result.spawned, 0);
    assert.match(logged.join("\n"), /defer T-1 .*stale_same/);
  });

  it("reassigns to Worker before claiming a stale card whose assignee role is not installed", async () => {
    const order = [];
    const roleSet = {
      roles: [{ id: "worker", agent: "Worker", lanes: ["worker"], installedOn: ["claude"] }],
    };
    await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      roleSet,
      readCandidates: async () => [
        {
          identifier: "T-1",
          reason: "stale_any",
          project: "P1",
          assignee: "Ghost",
          assignee_id: "a-ghost",
          assignee_kind: "agent",
          version: 9,
        },
      ],
      reassign: async (identifier, agent, options) => {
        order.push(`reassign:${identifier}:${agent}:${options.ifVersion}`);
        assert.match(options.reason, /not installed/);
        return { ok: true, version: 10 };
      },
      claim: async (identifier, agent, options) => {
        order.push(`claim:${identifier}:${agent}:${options.ifVersion}`);
        return { ok: true };
      },
      spawnWorker: async () => {
        order.push("dispatch");
        return { ok: true, pid: 1 };
      },
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(order, [
      "reassign:T-1:Worker:9",
      "claim:T-1:Worker:10",
      "dispatch",
    ], "the route changes before the claim, and the claim uses the new version");
  });

  it("defers instead of claiming when the Worker fallback cannot be written", async () => {
    const claims = [];
    const released = [];
    const roleSet = {
      roles: [{ id: "worker", agent: "Worker", lanes: ["worker"], installedOn: ["claude"] }],
    };
    const result = await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      roleSet,
      readCandidates: async () => [
        {
          identifier: "T-1",
          reason: "stale_any",
          project: "P1",
          assignee: "Ghost",
          assignee_kind: "agent",
          version: 9,
        },
      ],
      reassign: async () => ({ ok: false, error: "VERSION_CONFLICT" }),
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      release: async (identifier) => {
        released.push(identifier);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, [], "nothing is claimed under the wrong route");
    assert.deepEqual(released, ["T-1"], "the admission reservation is given back");
    assert.equal(result.deferred, 1);
  });

  it("defers the Worker fallback when the reassign dependency is absent", async () => {
    const claims = [];
    const roleSet = {
      roles: [{ id: "worker", agent: "Worker", lanes: ["worker"], installedOn: ["claude"] }],
    };
    const result = await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      roleSet,
      readCandidates: async () => [
        {
          identifier: "T-1",
          reason: "stale_any",
          project: "P1",
          assignee: "Ghost",
          assignee_kind: "agent",
          version: 9,
        },
      ],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, []);
    assert.equal(result.deferred, 1);
  });

  it("never claims a human-owned card", async () => {
    const claims = [];
    const result = await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      readCandidates: async () => [
        {
          identifier: "T-1",
          reason: "stale_any",
          project: "P1",
          assignee: "Terry",
          assignee_kind: "human",
          version: 1,
        },
      ],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, []);
    assert.equal(result.deferred, 1);
  });

  it("falls back to the scan agent when no Worker role is installed", async () => {
    const claims = [];
    await runPollTick({
      agents: ["Jobs"],
      registry: EMPTY_REGISTRY(),
      config: { ...BASE_CONFIG, claimUnassigned: true },
      readCandidates: async () => [
        { identifier: "T-2", agent: null, reason: "unassigned", project: "P1" },
      ],
      claim: async (identifier, agent) => {
        claims.push([identifier, agent]);
        return { ok: true };
      },
      spawnWorker: async () => ({ ok: true, pid: 1 }),
      defaultAgent: null,
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(claims, [["T-2", "Jobs"]], "the documented fallback is the scan agent");
  });

  it("does not spawn when the atomic claim is refused (claim is the only dispatch)", async () => {
    const spawnWorker = spy(async () => ({ ok: true, pid: 1 }));
    const registry = EMPTY_REGISTRY();
    const result = await runPollTick({
      agents: ["alice"],
      registry,
      config: BASE_CONFIG,
      readCandidates: async () => [candidate("T-1")],
      claim: async () => ({ ok: false, error: "CLAIM_CONFLICT" }),
      spawnWorker,
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });

    assert.equal(spawnWorker.count(), 0);
    assert.equal(result.claimed, 0);
    assert.equal(registry.running["T-1"], undefined);
  });

  it("never claims success on a failed spawn", async () => {
    const registry = EMPTY_REGISTRY();
    const result = await runPollTick({
      agents: ["alice"],
      registry,
      config: BASE_CONFIG,
      readCandidates: async () => [candidate("T-1")],
      claim: async () => ({ ok: true }),
      spawnWorker: async () => ({ ok: false, error: "ENOENT claude" }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });

    assert.equal(result.spawned, 0);
    assert.equal(result.failed, 1);
    assert.equal(registry.running["T-1"], undefined, "a failed wake is not recorded as running");
  });

  it("does not re-wake a card already running", async () => {
    const spawnWorker = spy(async () => ({ ok: true, pid: 2 }));
    const registry = { version: 1, running: { "T-1": { agent: "alice", pid: 1 } } };
    await runPollTick({
      agents: ["alice"],
      registry,
      config: BASE_CONFIG,
      readCandidates: async () => [candidate("T-1")],
      claim: async () => ({ ok: true }),
      spawnWorker,
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(spawnWorker.count(), 0);
  });

  it("respects the concurrency cap across agents", async () => {
    const spawnWorker = spy(async () => ({ ok: true, pid: 3 }));
    const registry = { version: 1, running: { "T-8": { agent: "alice", pid: 1 } } };
    const result = await runPollTick({
      agents: ["alice", "bob"],
      registry,
      config: { ...BASE_CONFIG, maxConcurrency: 2 },
      readCandidates: async (agent) => [candidate(`${agent === "alice" ? "T-1" : "T-2"}`, agent)],
      claim: async () => ({ ok: true }),
      spawnWorker,
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(result.spawned, 1, "2 - 1 running = 1 slot");
  });

  it("tells the reader whether the public pool is enabled", async () => {
    const readCandidates = spy(async () => []);
    await runPollTick({
      agents: ["alice"],
      registry: EMPTY_REGISTRY(),
      config: { ...BASE_CONFIG, claimUnassigned: false },
      readCandidates,
      claim: async () => ({ ok: true }),
      spawnWorker: async () => ({ ok: true }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(readCandidates.calls[0], ["alice", { claimUnassigned: false }]);
  });

  it("reads candidates for every agent", async () => {
    const readCandidates = spy(async () => []);
    await runPollTick({
      agents: ["alice", "bob"],
      registry: EMPTY_REGISTRY(),
      config: BASE_CONFIG,
      readCandidates,
      claim: async () => ({ ok: true }),
      spawnWorker: async () => ({ ok: true }),
      now: () => "2026-10-10T00:00:00.000Z",
      log: () => {},
    });
    assert.deepEqual(
      readCandidates.calls.map(([agent]) => agent),
      ["alice", "bob"],
    );
  });
});

// ---------------------------------------------------------------------------
// Tick runner: patrol
// ---------------------------------------------------------------------------

describe("runPatrolTick (injected deps)", () => {
  const now = "2026-10-10T00:00:00.000Z";
  const ago = (minutes) => new Date(Date.parse(now) - minutes * 60_000).toISOString();

  it("flags stale cards and starts no LLM by default", async () => {
    const spawnPatrol = spy(async () => ({ ok: true }));
    const alerts = spy();
    const result = await runPatrolTick({
      tasks: [{ identifier: "T-1", status: "in_progress", heartbeat_at: ago(45) }],
      config: { patrolLlm: false },
      spawnPatrol,
      notify: alerts,
      now: () => now,
      log: () => {},
    });

    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].type, "stale");
    assert.equal(spawnPatrol.count(), 0, "patrol must not start an LLM by default");
    assert.equal(alerts.count(), 1, "the escalation is still reported");
  });

  it("reports an unparsable heartbeat instead of going silent", async () => {
    const notify = spy();
    const result = await runPatrolTick({
      tasks: [{ identifier: "T-2", status: "in_progress", heartbeat_at: "garbage" }],
      config: { patrolLlm: false },
      spawnPatrol: async () => ({ ok: true }),
      notify,
      now: () => now,
      log: () => {},
    });
    assert.equal(result.alerts[0].type, "heartbeat-unreadable");
    assert.equal(notify.count(), 1);
  });

  it("opt-in patrol LLM wakes a worker only when explicitly enabled", async () => {
    const spawnPatrol = spy(async () => ({ ok: true }));
    await runPatrolTick({
      tasks: [{ identifier: "T-1", status: "in_progress", heartbeat_at: ago(45) }],
      config: { patrolLlm: true, actorKind: "claude", agent: "alice" },
      spawnPatrol,
      notify: () => {},
      now: () => now,
      log: () => {},
    });
    assert.equal(spawnPatrol.count(), 1);
  });

  // The heartbeat row is the ONE contract row the SLA pass deliberately
  // does not re-emit (`SLA_ROWS.heartbeat_stale.coveredBy`): the legacy alert
  // below is a published consumer contract, and a second notification for the
  // same condition would be a regression dressed up as coverage.
  it("emits exactly one notification per stale heartbeat — the legacy alert, not a tuple too", async () => {
    const legacyNotify = spy();
    const patrol = await runPatrolTick({
      tasks: [{ identifier: "T-1", status: "in_progress", heartbeat_at: ago(45) }],
      config: { patrolLlm: false },
      spawnPatrol: async () => ({ ok: true }),
      notify: legacyNotify,
      now: () => now,
      log: () => {},
    });
    assert.equal(patrol.alerts.length, 1);
    assert.equal(legacyNotify.count(), 1);

    // …and the SLA planner, given the same card, plans nothing for it.
    const sla = planSlaPatrol({ cards: [{ identifier: "T-1", status: "in_progress", heartbeat_at: ago(45), created_at: now, status_changed_at: now }], now });
    assert.deepEqual(sla.alerts, []);
  });
});

// ---------------------------------------------------------------------------
// Tick runner: workflow
// ---------------------------------------------------------------------------

describe("runWorkflowTick (injected deps)", () => {
  const WORKFLOW_CONFIG = { workflow: true };

  function baseDeps(overrides = {}) {
    return {
      plan: { alerts: [], actions: [], changes: [], summary: { actions: 0, alerts: 0 } },
      config: WORKFLOW_CONFIG,
      dryRun: false,
      createReview: async () => ({ ok: true, ref: "T-9" }),
      createFixChild: async () => ({ ok: true, ref: "T-8" }),
      linkFixChild: async () => ({ ok: true }),
      move: async () => ({ ok: true }),
      comment: async () => ({ ok: true }),
      setMeta: async () => ({ ok: true }),
      notify: () => {},
      log: () => {},
      ...overrides,
    };
  }

  const approve = (overrides = {}) => ({
    type: "approve",
    review_status: "in_review",
    review_ref: "T-2",
    original_ref: "T-1",
    round: 1,
    close_review: true,
    accepted_by: "loop-review",
    ...overrides,
  });

  it("does nothing when the workflow channel is off", async () => {
    const createReview = spy(async () => ({ ok: true, ref: "T-9" }));
    const result = await runWorkflowTick(
      baseDeps({
        config: { workflow: false },
        plan: { actions: [{ type: "create_review" }], alerts: [], changes: [], summary: {} },
        createReview,
      }),
    );
    assert.deepEqual(result.actions, []);
    assert.equal(createReview.count(), 0);
  });

  it("logs would-do and writes nothing in dry-run", async () => {
    const createReview = spy(async () => ({ ok: true }));
    const move = spy(async () => ({ ok: true }));
    const logs = [];
    const result = await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          changes: [],
          summary: { actions: 1 },
          actions: [{ type: "create_review", original_ref: "T-1", idem: "loop-review|T-1|r1" }],
        },
        dryRun: true,
        createReview,
        move,
        log: (line) => logs.push(line),
      }),
    );
    assert.equal(createReview.count(), 0);
    assert.equal(move.count(), 0);
    assert.equal(result.executed, 0);
    assert.equal(result.actions.length, 1);
    assert.ok(logs.some((line) => /would create review loop-review\|T-1\|r1/.test(line)));
  });

  it("approves the original, marks the action's acceptedBy, and closes the review card last", async () => {
    const order = [];
    const result = await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], summary: { approved: 1 }, actions: [approve()] },
        comment: async (ref, input) => (order.push(`comment:${ref}:${input.kind}`), { ok: true }),
        setMeta: async (ref, meta) => (order.push(`meta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
      }),
    );
    assert.deepEqual(order, [
      'meta:T-1:{"accepted_by":"loop-review","accepted_round":"1"}',
      "comment:T-1:note",
      "move:T-1:done",
      "comment:T-2:note",
      "move:T-2:done",
    ]);
    assert.equal(result.executed, 1);
    assert.equal(result.failed, 0);
  });

  it("skips the acceptance note and marker when the plan is already held", async () => {
    const order = [];
    const result = await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], summary: {}, actions: [approve({ held: true })] },
        comment: async (ref) => (order.push(`comment:${ref}`), { ok: true }),
        setMeta: async (ref) => (order.push(`meta:${ref}`), { ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
      }),
    );
    assert.deepEqual(
      order,
      ["move:T-1:done", "comment:T-2", "move:T-2:done"],
      "a recovery pass finishes the move and the close only",
    );
    assert.equal(result.executed, 1);
    assert.equal(result.failed, 0);
  });

  it("applies an approve and closes the review card last", async () => {
    const order = [];
    await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], summary: {}, actions: [approve()] },
        comment: async (ref) => (order.push(`comment:${ref}`), { ok: true }),
        setMeta: async (ref, meta) => (order.push(`meta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
      }),
    );
    assert.deepEqual(order, [
      'meta:T-1:{"accepted_by":"loop-review","accepted_round":"1"}',
      "comment:T-1",
      "move:T-1:done",
      "comment:T-2",
      "move:T-2:done",
    ]);
  });

  it("rejects a task through in_progress → todo and records the rework round", async () => {
    const order = [];
    const result = await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          changes: [],
          summary: {},
          actions: [
            {
              type: "reject_task",
              review_status: "in_review",
              review_ref: "T-2",
              original_ref: "T-1",
              round: 1,
              rework_round: 2,
              findings: "the gate is untested",
              close_review: true,
            },
          ],
        },
        comment: async (ref, input) => (order.push(`comment:${ref}:${input.kind}`), { ok: true }),
        setMeta: async (ref, meta) => (order.push(`meta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
      }),
    );
    assert.deepEqual(order, [
      'meta:T-1:{"rework_round":"2"}',
      "comment:T-1:change",
      "move:T-1:in_progress",
      "move:T-1:todo",
      "comment:T-2:note",
      "move:T-2:done",
    ]);
    assert.equal(result.executed, 1);
  });

  it("rejects an epic by creating and linking the fix child before reopening it", async () => {
    const order = [];
    const result = await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          changes: [],
          summary: {},
          actions: [
            {
              type: "reject_epic",
              review_status: "in_review",
              review_ref: "T-2",
              original_ref: "E-1",
              round: 1,
              rework_round: 2,
              project_id: "proj",
              assignee_id: "agent-1",
              original_title: "Epic",
              findings: "",
              close_review: true,
            },
          ],
        },
        createFixChild: async () => (order.push("create_fix"), { ok: true, ref: "E-2" }),
        linkFixChild: async (epic, child) => (order.push(`link:${epic}:${child}`), { ok: true }),
        comment: async (ref) => (order.push(`comment:${ref}`), { ok: true }),
        setMeta: async (ref) => (order.push(`meta:${ref}`), { ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
      }),
    );
    assert.deepEqual(order, [
      "create_fix",
      "link:E-1:E-2",
      "meta:E-1",
      "comment:E-1",
      "move:E-1:in_progress",
      "comment:T-2",
      "move:T-2:done",
    ]);
    assert.equal(result.executed, 1);
  });

  it("ignores a legacy closeReview:false and still closes the review card", async () => {
    const move = spy(async () => ({ ok: true }));
    const result = await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], summary: {}, actions: [approve({ close_review: false })] },
        move,
      }),
    );
    assert.deepEqual(move.calls.map(([ref, to]) => `${ref}:${to}`), ["T-1:done", "T-2:done"]);
    assert.equal(result.executed, 1);
  });

  it("keeps going after one action fails, and notifies the operator", async () => {
    const notify = spy();
    const createReview = spy(async () => ({ ok: false, error: "board busy" }));
    const result = await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          changes: [],
          summary: {},
          actions: [
            { type: "create_review", original_ref: "T-1" },
            { type: "create_review", original_ref: "T-3" },
          ],
        },
        createReview,
        notify,
      }),
    );
    assert.equal(result.failed, 2);
    assert.equal(result.executed, 0);
    assert.deepEqual(
      notify.calls.map(([alert]) => alert.type),
      ["workflow_action_failed", "workflow_action_failed"],
    );
  });

  it("closes a review card by status: done from in_review, canceled from todo, nothing from done", async () => {
    const move = spy(async () => ({ ok: true }));
    await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          changes: [],
          summary: {},
          actions: [
            { type: "close_review", review_status: "in_review", review_ref: "T-2", reason: "x", close_review: true },
            { type: "cancel_review", review_status: "todo", review_ref: "T-3", reason: "y", close_review: true },
            { type: "close_review", review_status: "done", review_ref: "T-4", reason: "z", close_review: true },
          ],
        },
        comment: async () => ({ ok: true }),
        move,
      }),
    );
    assert.deepEqual(move.calls.map(([ref, to]) => `${ref}:${to}`), ["T-2:done", "T-3:canceled"]);
  });

  it("cancels a review card in one move and interrupts its turn, never done", async () => {
    const order = [];
    await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          changes: [],
          summary: {},
          actions: [
            { type: "cancel_review", review_status: "in_review", review_ref: "T-3", reason: "original_canceled", close_review: true },
            { type: "cancel_review", review_status: "in_progress", review_ref: "T-4", reason: "original_canceled", close_review: true },
          ],
        },
        comment: async (ref, input) => (order.push(`comment:${ref}:${input.kind}`), { ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
        requestInterrupt: (request) => {
          order.push(`interrupt:${request.card}:${request.from}:${request.to}`);
          return { ok: true };
        },
      }),
    );
    // TP-0125 — `in_review → canceled` is one hop; the marker is written after
    // the move so the pool can stop a reviewer turn that is still running.
    assert.deepEqual(order, [
      "comment:T-3:note",
      "move:T-3:canceled",
      "interrupt:T-3:in_review:canceled",
      "comment:T-4:note",
      "move:T-4:canceled",
      "interrupt:T-4:in_progress:canceled",
    ]);
    assert.equal(order.includes("move:T-3:done"), false, "a canceled review is never recorded as accepted");
  });

  it("notifies only findings, not standing-state alerts", async () => {
    const notify = spy();
    const logs = [];
    const result = await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [
            { type: "verdict_unreadable", review: "T-2" },
            { type: "review_awaiting_human_acceptance", review: "T-2" },
          ],
          changes: [],
          summary: { alerts: 2 },
          actions: [],
        },
        notify,
        log: (line) => logs.push(line),
      }),
    );
    assert.deepEqual(notify.calls.map(([alert]) => alert.type), ["verdict_unreadable"]);
    assert.equal(result.alerts.length, 2);
    assert.ok(logs.some((line) => /review_awaiting_human_acceptance/.test(line)));
  });

  it("logs reconcile changes", async () => {
    const logs = [];
    await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [],
          actions: [],
          summary: {},
          changes: [{ action: "close", epic: "E-1", reason: "all_children_terminal" }],
        },
        log: (line) => logs.push(line),
      }),
    );
    assert.ok(logs.some((line) => /reconcile close E-1/.test(line)));
  });

  it("fails an approve action that carries no acceptedBy", async () => {
    const notify = spy();
    const result = await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], summary: {}, actions: [{ ...approve(), accepted_by: undefined }] },
        notify,
      }),
    );
    assert.equal(result.failed, 1);
    assert.equal(notify.calls[0][0].error, "approve action is missing accepted_by");
  });

  describe("auto_accept — a card whose review_required snapshot is 0", () => {
    const autoAccept = (overrides = {}) => ({
      type: "auto_accept",
      original_ref: "T-3",
      round: 2,
      accepted_by: "loop-auto",
      held: false,
      ...overrides,
    });

    it("marks the acceptor, comments, then moves the original to done", async () => {
      const order = [];
      const result = await runWorkflowTick(
        baseDeps({
          plan: { alerts: [], changes: [], summary: { auto_accepted: 1 }, actions: [autoAccept()] },
          setMeta: async (ref, meta) => (order.push(`meta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
          comment: async (ref, input) => (order.push(`comment:${ref}:${input.kind}`), { ok: true }),
          move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
        }),
      );
      assert.deepEqual(order, [
        'meta:T-3:{"accepted_by":"loop-auto","accepted_round":"2","auto_accepted":"1"}',
        "comment:T-3:note",
        "move:T-3:done",
      ]);
      assert.equal(result.executed, 1);
      assert.equal(result.failed, 0);
    });

    it("skips the marker and the comment when the board says the card is already held", async () => {
      const order = [];
      await runWorkflowTick(
        baseDeps({
          plan: { alerts: [], changes: [], summary: {}, actions: [autoAccept({ held: true })] },
          setMeta: async (ref) => (order.push(`meta:${ref}`), { ok: true }),
          comment: async (ref) => (order.push(`comment:${ref}`), { ok: true }),
          move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
        }),
      );
      assert.deepEqual(order, ["move:T-3:done"], "a recovery pass finishes the move only");
    });

    it("fails the action — and moves nothing — when accepted_by is missing", async () => {
      const notify = spy();
      const move = spy(async () => ({ ok: true }));
      const result = await runWorkflowTick(
        baseDeps({
          plan: { alerts: [], changes: [], summary: {}, actions: [autoAccept({ accepted_by: undefined })] },
          notify,
          move,
        }),
      );
      assert.equal(result.failed, 1);
      assert.equal(move.count(), 0);
      assert.equal(notify.calls[0][0].error, "auto_accept action is missing accepted_by");
    });
  });

  it("notifies a workflow alert once per state, not once per pass", async () => {
    const notify = spy();
    const plan = {
      alerts: [
        {
          type: "verdict_unreadable",
          review: "T-2",
          original: "T-1",
          reason: "no_report",
          dedup_key: "verdict_unreadable|T-2|no_report",
        },
      ],
      changes: [],
      actions: [],
      summary: {},
    };
    const first = await runWorkflowTick(
      baseDeps({ plan, notify, ledger: emptySlaLedger(), now: () => "2026-10-22T10:00:00.000Z" }),
    );
    assert.deepEqual(notify.calls.map(([alert]) => alert.type), ["verdict_unreadable"]);

    await runWorkflowTick(
      baseDeps({ plan, notify, ledger: first.ledger, now: () => "2026-10-22T10:10:00.000Z" }),
    );
    assert.equal(notify.count(), 1, "the same state is suppressed on the next pass");
    assert.equal(Object.keys(first.ledger.seen).length, 1);
  });

  it("re-notifies when the alert's state changes", async () => {
    const notify = spy();
    const alert = (reason) => ({
      type: "verdict_unreadable",
      review: "T-2",
      original: "T-1",
      reason,
      dedup_key: `verdict_unreadable|T-2|${reason}`,
    });
    const first = await runWorkflowTick(
      baseDeps({
        plan: { alerts: [alert("no_report")], changes: [], actions: [], summary: {} },
        notify,
        ledger: emptySlaLedger(),
        now: () => "2026-10-22T10:00:00.000Z",
      }),
    );
    await runWorkflowTick(
      baseDeps({
        plan: { alerts: [alert("no_verdict")], changes: [], actions: [], summary: {} },
        notify,
        ledger: first.ledger,
        now: () => "2026-10-22T10:10:00.000Z",
      }),
    );
    assert.equal(notify.count(), 2);
  });

  it("notifies actions_capped once per cap", async () => {
    const notify = spy();
    const plan = {
      alerts: [
        {
          type: "actions_capped",
          cap: 2,
          dropped: 1,
          outcomes: 1,
          dispatch: 2,
          dedup_key: "actions_capped|2",
        },
      ],
      changes: [],
      actions: [],
      summary: {},
    };
    const first = await runWorkflowTick(
      baseDeps({ plan, notify, ledger: emptySlaLedger(), now: () => "2026-10-22T10:00:00.000Z" }),
    );
    await runWorkflowTick(
      baseDeps({ plan, notify, ledger: first.ledger, now: () => "2026-10-22T10:10:00.000Z" }),
    );
    assert.equal(notify.count(), 1);
  });

  it("dedupes workflow_action_failed by action, ref and error", async () => {
    const notify = spy();
    const failing = { type: "create_review", original_ref: "T-1" };
    const createReview = async () => ({ ok: false, error: "board busy" });
    const first = await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], actions: [failing], summary: {} },
        createReview,
        notify,
        ledger: emptySlaLedger(),
        now: () => "2026-10-22T10:00:00.000Z",
      }),
    );
    await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], actions: [failing], summary: {} },
        createReview,
        notify,
        ledger: first.ledger,
        now: () => "2026-10-22T10:10:00.000Z",
      }),
    );
    assert.equal(notify.count(), 1, "the same failure is not repeated");
  });

  // A refusal that repeats every pass is a standing alarm: without an
  // escalation it is notified once and then only logged, so a card can sit
  // failed-to-approve for days with nothing reaching a human (TP-0009: 36h).
  it("escalates a standing action failure once per 24h bucket", async () => {
    const notify = spy();
    const failing = { type: "create_review", original_ref: "T-1" };
    const createReview = async () => ({ ok: false, error: "board busy" });
    let ledger = emptySlaLedger();
    const run = async (now) => {
      const result = await runWorkflowTick(
        baseDeps({
          plan: { alerts: [], changes: [], actions: [failing], summary: {} },
          createReview,
          notify,
          ledger,
          now: () => now,
        }),
      );
      ledger = result.ledger;
    };

    await run("2026-10-22T10:00:00.000Z");
    assert.equal(notify.count(), 1);
    await run("2026-10-22T10:10:00.000Z");
    assert.equal(notify.count(), 1, "inside the window nothing is repeated");

    await run("2026-10-23T11:00:00.000Z"); // +25h
    assert.equal(notify.count(), 2, "after a day the operator hears about it again");
    assert.equal(notify.calls.at(-1)[0].type, "workflow_action_failed_escalated");
    assert.match(
      notify.calls.at(-1)[0].dedupKey,
      /^workflow_action_failed_escalated\|create_review\|T-1\|b1$/,
    );

    await run("2026-10-23T11:10:00.000Z");
    assert.equal(notify.count(), 2, "the same bucket does not repeat");

    await run("2026-10-24T11:00:00.000Z"); // +49h
    assert.equal(notify.count(), 3);
    assert.match(
      notify.calls.at(-1)[0].dedupKey,
      /^workflow_action_failed_escalated\|create_review\|T-1\|b2$/,
    );
  });

  it("skips escalation when the ledger's first_seen cannot be read", async () => {
    const notify = spy();
    const failing = { type: "create_review", original_ref: "T-1" };
    const baseKey = "workflow_action_failed|create_review|T-1|board busy";
    const ledger = {
      version: 1,
      seen: {
        [baseKey]: {
          first_seen: "not-a-date",
          last_seen: "2026-10-22T10:00:00.000Z",
          observed_by: ["workflow"],
        },
      },
    };
    await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], actions: [failing], summary: {} },
        createReview: async () => ({ ok: false, error: "board busy" }),
        notify,
        ledger,
        now: () => "2026-10-25T10:00:00.000Z",
      }),
    );
    assert.equal(notify.count(), 0, "a corrupt first_seen is not a reason to page");
  });

  it("starts a new age when the error message changes", async () => {
    const notify = spy();
    const failing = { type: "create_review", original_ref: "T-1" };
    const oldKey = "workflow_action_failed|create_review|T-1|old refus";
    const ledger = {
      version: 1,
      seen: {
        [oldKey]: {
          first_seen: "2026-10-01T00:00:00.000Z",
          last_seen: "2026-10-22T10:00:00.000Z",
          observed_by: ["workflow"],
        },
      },
    };
    await runWorkflowTick(
      baseDeps({
        plan: { alerts: [], changes: [], actions: [failing], summary: {} },
        createReview: async () => ({ ok: false, error: "new refus" }),
        notify,
        ledger,
        now: () => "2026-10-22T10:00:00.000Z",
      }),
    );
    assert.deepEqual(
      notify.calls.map(([alert]) => alert.type),
      ["workflow_action_failed"],
      "a different refusal is a new finding, not an old standing one",
    );
  });

  it("fails open when the ledger is unreadable", async () => {
    const notify = spy();
    await runWorkflowTick(
      baseDeps({
        plan: {
          alerts: [
            { type: "verdict_unreadable", review: "T-2", dedup_key: "verdict_unreadable|T-2|no_report" },
          ],
          changes: [],
          actions: [],
          summary: {},
        },
        notify,
        ledger: { version: 1, seen: null },
      }),
    );
    assert.equal(notify.count(), 1);
  });
});

// ---------------------------------------------------------------------------
// Pure: crash recovery
// ---------------------------------------------------------------------------

describe("pruneRegistry (pure)", () => {
  it("drops entries whose pid is dead, keeping live ones", () => {
    const registry = {
      version: 1,
      running: {
        "T-1": { agent: "alice", pid: 100 },
        "T-2": { agent: "alice", pid: 200 },
      },
    };
    const pruned = pruneRegistry(registry, (pid) => pid === 100);
    assert.deepEqual(Object.keys(pruned.running), ["T-1"]);
  });

  it("keeps an entry with no pid (a legacy/hand-written record)", () => {
    const pruned = pruneRegistry({ version: 1, running: { "T-1": { agent: "alice" } } }, () => false);
    assert.deepEqual(Object.keys(pruned.running), ["T-1"]);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — the project map the poll pass resolves from
// ---------------------------------------------------------------------------

describe("parseArgs — the project map", () => {
  const ENV = { HOME: "/home/alice" };

  it("defaults the map to the config root, and follows MEERKAT_TASKPANEL_CONFIG_DIR", () => {
    const opts = parseArgs(["--actor-kind", "codex", "--once"], {
      ...ENV,
      MEERKAT_TASKPANEL_CONFIG_DIR: "/maps",
    });
    assert.equal(opts.projectsJson, join("/maps", "projects.json"));

    const plain = parseArgs(["--actor-kind", "pi", "--once"], ENV);
    assert.equal(plain.projectsJson, join(repoRoot(), "projects.json"));
  });

  it("no longer accepts --projects-json: the map has one location", () => {
    assert.throws(
      () => parseArgs(["--actor-kind", "pi", "--projects-json=/tmp/map.json"], ENV),
      /unknown option/,
    );
  });

  it("defaults the SLA ledger beside the state file, and follows a custom one", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--once"], ENV).slaLedger, "/home/alice/.claude/meerkat-taskpanel/sla-ledger.json");
    const moved = parseArgs(["--actor-kind", "claude", "--once", "--state", "/tmp/state.json"], ENV);
    assert.equal(moved.slaLedger, "/tmp/sla-ledger.json", "one directory remembers everything");
    assert.equal(parseArgs(["--actor-kind", "claude", "--once", "--sla-ledger=/tmp/l.json"], ENV).slaLedger, "/tmp/l.json");
  });

  it("defaults the workflow ledger beside the state file, and follows a custom one", () => {
    assert.equal(
      parseArgs(["--actor-kind", "claude", "--once"], ENV).workflowLedger,
      "/home/alice/.claude/meerkat-taskpanel/workflow-ledger.json",
    );
    const moved = parseArgs(["--actor-kind", "claude", "--once", "--state", "/tmp/state.json"], ENV);
    assert.equal(moved.workflowLedger, "/tmp/workflow-ledger.json");
    assert.equal(
      parseArgs(["--actor-kind", "claude", "--once", "--workflow-ledger=/tmp/w.json"], ENV).workflowLedger,
      "/tmp/w.json",
    );
  });

  it("bounds the two reads the SLA pass makes", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--once"], ENV);
    assert.ok(opts.boardLimit > 0);
    assert.ok(opts.trailLimit > 0);
    assert.equal(parseArgs(["--actor-kind", "claude", "--once", "--board-limit=10", "--trail-limit", "5"], ENV).boardLimit, 10);
    assert.equal(parseArgs(["--actor-kind", "claude", "--once", "--trail-limit", "5"], ENV).trailLimit, 5);
  });
});

describe("parseArgs — the workspace mode", () => {
  const ENV = { HOME: "/home/alice" };

  it("defaults to worktree, accepts the flag, and refuses anything else", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--once"], ENV).workspace, "worktree");
    assert.equal(
      parseArgs(["--actor-kind", "claude", "--once", "--workspace", "shared"], ENV).workspace,
      "shared",
    );
    assert.throws(
      () => parseArgs(["--actor-kind", "claude", "--once", "--workspace", "sandbox"], ENV),
      /worktree or shared/,
    );
  });

  it("reads the workspace mode from the environment", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--once"], {
      ...ENV,
      MEERKAT_TASKPANEL_WORKSPACE: "shared",
    });
    assert.equal(opts.workspace, "shared");
  });
});

// ---------------------------------------------------------------------------
// The SLA ledger on disk (fail-soft by construction)
// ---------------------------------------------------------------------------

describe("the SLA ledger file", () => {
  const tempDirs = [];
  function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through a file", () => {
    const path = join(tempDir("meerkat-ledger-"), "sla-ledger.json");
    const ledger = { version: 1, seen: { key: { first_seen: "2026-10-14T10:00:00.000Z", last_seen: "2026-10-14T10:00:00.000Z", observed_by: ["loop-patrol"] } } };
    saveSlaLedger(path, ledger);
    assert.deepEqual(loadSlaLedger(path), ledger);
  });

  it("reads a missing or corrupt ledger as empty — a duplicate is admissible, a lost alert is not", () => {
    assert.deepEqual(loadSlaLedger(join(tempDir("meerkat-ledger-"), "nope.json")), emptySlaLedger());
    const corrupt = join(tempDir("meerkat-ledger-"), "sla-ledger.json");
    writeFileSync(corrupt, "{not json", "utf8");
    assert.deepEqual(loadSlaLedger(corrupt), emptySlaLedger());
    const shapeless = join(tempDir("meerkat-ledger-"), "sla-ledger.json");
    writeFileSync(shapeless, JSON.stringify({ version: 1 }), "utf8");
    assert.deepEqual(loadSlaLedger(shapeless), emptySlaLedger());
  });

  it("publishes a last-ok marker the peer can read, atomically (§8.4)", () => {
    const dir = tempDir("meerkat-lastok-");
    const path = join(dir, "loop-patrol-last-ok.json");
    saveLastOk(path, { mechanism: "loop-patrol", at: "2026-10-14T10:00:00.000Z", actor: "claude/linus", periodSeconds: 300 });
    assert.equal(readPeerLastOk(path), "2026-10-14T10:00:00.000Z");
    // The marker names its own mechanism and cadence, so the peer's watchdog
    // computes the derived bound from *this* side's declared period.
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.mechanism, "loop-patrol");
    assert.equal(written.cadence_period_min, 5);
    assert.equal(existsSync(`${path}.${process.pid}.tmp`), false, "the temp file is renamed, never left behind");
  });

  it("reads an absent, corrupt or shapeless peer marker as 'not published'", () => {
    const dir = tempDir("meerkat-peer-");
    assert.equal(readPeerLastOk(join(dir, "nope.json")), null);
    assert.equal(readPeerLastOk(null), null, "no configured peer is not a marker");
    const corrupt = join(dir, "peer.json");
    writeFileSync(corrupt, "{not json", "utf8");
    assert.equal(readPeerLastOk(corrupt), null);
    const shapeless = join(dir, "peer2.json");
    writeFileSync(shapeless, JSON.stringify({ mechanism: "openclaw-cron" }), "utf8");
    assert.equal(readPeerLastOk(shapeless), null);
  });

  it("reads the peer's declared cadence with its last-ok, and falls back when absent", () => {
    const dir = tempDir("meerkat-peer-cadence-");
    const path = join(dir, "peer.json");
    writeFileSync(path, JSON.stringify({
      mechanism: "openclaw-cron",
      last_ok: "2026-10-14T10:00:00.000Z",
      cadence_period_min: 30,
    }), "utf8");
    assert.deepEqual(readPeerMarker(path), { lastOk: "2026-10-14T10:00:00.000Z", periodMinutes: 30 });

    writeFileSync(path, JSON.stringify({ last_ok: "2026-10-14T10:00:00.000Z" }), "utf8");
    assert.deepEqual(readPeerMarker(path), { lastOk: "2026-10-14T10:00:00.000Z", periodMinutes: null });

    writeFileSync(path, JSON.stringify({ last_ok: "2026-10-14T10:00:00.000Z", cadence_period_min: 0 }), "utf8");
    assert.equal(readPeerMarker(path).periodMinutes, null, "zero is not a cadence");

    assert.equal(readPeerMarker(join(dir, "nope.json")), null);
    assert.equal(readPeerMarker(null), null);
  });

  it("kills a hung notify command and keeps the pass alive", () => {
    const lines = [];
    const started = Date.now();
    notifyReal(
      { notify: `${process.execPath} -e "setTimeout(() => {}, 5000)"` },
      (line) => lines.push(line),
      { timeoutMs: 50 },
    )({ alert_id: "T-1#blocked_clarification#warn@2026-10-14T10:00:00.000Z" });
    assert.ok(Date.now() - started < 2000, "a hung notifier must not block the pass");
    assert.ok(lines.some((line) => line.includes("notify timed out")), lines.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// The liveness/marker arguments — the surface a deployment configures
// ---------------------------------------------------------------------------

describe("parseArgs — the SLA attribution and liveness surface", () => {
  it("defaults the marker beside the state file and leaves the leader unset", () => {
    const opts = parseArgs(["--home", "/tmp/home"], {});
    assert.equal(opts.slaLeader, null, "no person is hard-coded (contract §3)");
    assert.equal(opts.slaPeer, null, "an unwired peer is a registered dependency, not an alarm");
    assert.equal(opts.slaLastOk, join(dirname(opts.state), "loop-patrol-last-ok.json"));
  });

  it("takes the leader identity and the peer's marker from flags", () => {
    const opts = parseArgs(["--home", "/tmp/home", "--sla-leader", "elon", "--sla-peer", "/team/.sla-scan-state.json"], {});
    assert.equal(opts.slaLeader, "elon");
    assert.equal(opts.slaPeer, "/team/.sla-scan-state.json");
  });

  it("takes them from the environment too, so a unit file need not restate them", () => {
    const opts = parseArgs(["--home", "/tmp/home"], {
      MEERKAT_TASKPANEL_SLA_LEADER: "elon",
      MEERKAT_TASKPANEL_SLA_PEER: "/team/.sla-scan-state.json",
    });
    assert.equal(opts.slaLeader, "elon");
    assert.equal(opts.slaPeer, "/team/.sla-scan-state.json");
  });

  it("remembers that --patrol-interval was explicit, even at the default", () => {
    // The default is 300 too; without the marker a supervisor invoked with
    // `--patrol-interval 300` could not override a board configured with 600,
    // and the serialized child argv would drop the flag.
    const implicit = parseArgs(["--home", "/tmp/home"], {});
    assert.equal(implicit.patrolInterval, 300);
    assert.equal(implicit.patrolIntervalExplicit, false);

    const explicit = parseArgs(["--home", "/tmp/home", "--patrol-interval", "300"], {});
    assert.equal(explicit.patrolIntervalExplicit, true);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — the workflow surface
// ---------------------------------------------------------------------------

describe("parseArgs — the workflow surface", () => {
  const ENV = { HOME: "/home/alice" };

  it("leaves the settings unresolved, so the agent config can decide them", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--once"], ENV);
    assert.equal(opts.workflow, undefined);
    assert.equal(opts.reviewerDeprecated, undefined);
    assert.equal(opts.workflowMaxActions, undefined);
    assert.equal(opts.recoverStale, undefined);
  });

  it("takes --recover-stale in both spellings", () => {
    assert.equal(parseArgs(["--recover-stale", "no", "--once"], ENV).recoverStale, "no");
    assert.equal(parseArgs(["--recover-stale=yes", "--once"], ENV).recoverStale, "yes");
  });

  it("takes every workflow flag in both spellings", () => {
    const spaced = parseArgs(
      ["--workflow", "no", "--workflow-max-actions", "5"],
      ENV,
    );
    assert.equal(spaced.workflow, "no");
    assert.equal(spaced.workflowMaxActions, "5");

    const joined = parseArgs(["--workflow=yes", "--workflow-max-actions=9"], ENV);
    assert.equal(joined.workflow, "yes");
    assert.equal(joined.workflowMaxActions, "9");
  });

  it("keeps --reviewer as a deprecated no-op", () => {
    const opts = parseArgs(["--reviewer", "jobs", "--once"], ENV);
    assert.equal(opts.reviewerDeprecated, "jobs");
  });
});

// ---------------------------------------------------------------------------
// defaultRepo — where a run that was not told finds the board it drives
// (T-20261012-163500-loopdecouple-c: the executor is also installed as an agent copy)
// ---------------------------------------------------------------------------

describe("defaultRepo — the board a supervisor drives", () => {
  const tempDirs = [];
  function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it("answers with the board beside the executor, and never reads the agent config", () => {
    // The checkout's own supervisor is the documented dev run, so it stays hermetic:
    // a stale MEERKAT_TASKPANEL_REPO on the machine cannot redirect it.
    const config = join(tempDir("meerkat-defaultrepo-"), "meerkat-taskpanel.env");
    writeFileSync(config, "MEERKAT_TASKPANEL_REPO=/somewhere/else\n", "utf8");
    assert.equal(defaultRepo(config, REPO), REPO);
  });

  it("reads the recorded checkout for an agent copy that has no board beside it", () => {
    // install.sh copies the loop body under <agent-dir>/meerkat-taskpanel/, where
    // `src/cli/index.mjs` does not exist; the agent config is then the only place the
    // copied executor can learn where the `taskctl` it drives lives.
    const dir = tempDir("meerkat-defaultrepo-agent-");
    const config = join(dir, "meerkat-taskpanel.env");
    writeFileSync(config, "MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no\nMEERKAT_TASKPANEL_REPO=/checkout/board\n", "utf8");
    assert.equal(defaultRepo(config, join(dir, "meerkat-taskpanel")), "/checkout/board");
  });

  it("falls back to the executor's own directory when nothing is recorded", () => {
    // A copy written by an installer that predates the key: the tick still resolves a
    // directory rather than throwing, and re-running install.sh records the path.
    const beside = join(tempDir("meerkat-defaultrepo-bare-"), "meerkat-taskpanel");
    assert.equal(defaultRepo(join(beside, "no-such.env"), beside), beside);
  });

  it("lets --repo override both, with --cli following it", () => {
    assert.equal(parseArgs(["--actor-kind", "codex", "--once"], { HOME: "/home/alice" }).repo, REPO);
    const opts = parseArgs(["--actor-kind", "codex", "--once", "--repo", "/tmp/board"], { HOME: "/home/alice" });
    assert.equal(opts.repo, "/tmp/board");
    assert.equal(opts.cli, "/tmp/board/src/cli/index.mjs");
  });
});

// ---------------------------------------------------------------------------
// The poll pass's directory resolver: `wake-cwd.mjs`
//
// The map has three answers and *dispatch* can only use two of them: a project
// absent from `projects.json` is unmapped (ask the user), and an entry that
// exists but names no directory is a complete answer for the map — a project may
// legitimately keep nothing on disk — but it is still no answer for a worker,
// which has to be started somewhere. Both refuse dispatch, and they refuse it
// with their own reason rather than one generic message.
// ---------------------------------------------------------------------------

describe("wake-cwd — the directory a woken worker runs in", () => {
  const tempDirs = [];
  function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A map file (in a fresh temp dir) holding the given entries. */
  function writeMap(entries) {
    const dir = tempDir("meerkat-wake-cwd-");
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ projects: entries }, null, 2), "utf8");
    return file;
  }

  it("resolves `run_dir` — the launch pad of a project with no local directory", () => {
    const launch = tempDir("meerkat-wake-launch-");
    const projectsJson = writeMap([{ project: "Ops", run_dir: launch }]);

    const result = resolveWakeDir({ project: "Ops", projectsJson });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.dir, launch);
  });

  it("refuses the wake when the entry names no directory, even though the map allows it", () => {
    const projectsJson = writeMap([{ project: "Ops", kind: "ops" }]);

    const result = resolveWakeDir({ project: "Ops", projectsJson });
    assert.equal(result.ok, false, "a worker needs a cwd; ‘no directory’ is not one");
    assert.equal(result.code, PROJECT_DIR_CODES.REQUIRED);
    assert.match(result.message, /no usable directory for project Ops/);
    assert.match(result.message, /`local_path`/);
  });

  it("keeps ‘no entry’ and ‘no directory’ as two different refusals", () => {
    const projectsJson = writeMap([{ project: "Ops", kind: "ops" }]);

    const unmapped = resolveWakeDir({ project: "Ghost", projectsJson });
    assert.equal(unmapped.ok, false);
    assert.equal(unmapped.code, PROJECT_DIR_CODES.UNMAPPED);
    assert.match(unmapped.message, /no local directory is registered for project Ghost/);

    const directoryless = resolveWakeDir({ project: "Ops", projectsJson });
    assert.equal(directoryless.code, PROJECT_DIR_CODES.REQUIRED, "the two must not collapse");
  });
});

describe("supervisor module", () => {
  // Resolved *relative to this test file*, never from a directory name — the
  // checkout is mounted at /app inside the container, so any assertion keyed on
  // the repo being named "meerkat-taskpanel" would hold on the host and fail there.
  const SUPERVISOR_URL = new URL("../../src/orchestrator/supervisor.mjs", import.meta.url);
  const SUPERVISOR_PATH = fileURLToPath(SUPERVISOR_URL);

  it("is a repo-relative ESM file that exists", () => {
    assert.ok(SUPERVISOR_PATH.endsWith(".mjs"), SUPERVISOR_PATH);
    assert.ok(existsSync(SUPERVISOR_PATH), SUPERVISOR_PATH);
  });

  it("imports from wherever the checkout lives, and every module keeps its own surface (container form)", async () => {
    // Container form: hold under an arbitrary ROOT (e.g. /app), where the parent
    // directory is *not* named "meerkat-taskpanel". Loading by URL proves each module
    // is importable in place; the export check proves the modules are real, not stubs.
    const modules = [
      [SUPERVISOR_URL, ["main"]],
      [new URL("../../src/orchestrator/options.mjs", import.meta.url), ["parseArgs", "selectMode"]],
      [new URL("../../src/orchestrator/runtime.mjs", import.meta.url), ["loadRegistry", "saveRegistry", "runPingTick", "subscribeStatePath", "loadSubscribeState", "saveSubscribeState"]],
      [new URL("../../src/orchestrator/runners.mjs", import.meta.url), ["runPollTick", "runPatrolTick"]],
      [new URL("../../src/orchestrator/subscribe.mjs", import.meta.url), ["runSubscribe", "createDispatchScheduler"]],
      [new URL("../../src/orchestrator/status.mjs", import.meta.url), ["probeSupervisor", "probeUnits", "takeOver", "stopSupervisor"]],
      [new URL("../../src/orchestrator/console.mjs", import.meta.url), ["consoleCycle"]],
      [new URL("../../src/orchestrator/doctor.mjs", import.meta.url), ["doctorReport"]],
      [new URL("../../src/foundation/scheduling.mjs", import.meta.url), ["buildHandoff", "buildQuestionPrompt", "planTick"]],
    ];
    for (const [url, names] of modules) {
      const mod = await import(url.href);
      for (const name of names) {
        assert.equal(typeof mod[name], "function", `missing export: ${name} (${url.pathname})`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The scheduler's two clocks
// ---------------------------------------------------------------------------

describe("the scheduler's two clocks", () => {
  const ENV = { HOME: "/home/alice" };

  it("selects ping / continue / patrol / the legacy poll / daemon", () => {
    assert.equal(selectMode(parseArgs(["--actor-kind", "claude", "--ping-only", "--once"], ENV)), "ping");
    assert.equal(selectMode(parseArgs(["--actor-kind", "claude", "--continue-only", "--once"], ENV)), "continue");
    assert.equal(selectMode(parseArgs(["--actor-kind", "claude", "--patrol-only", "--once"], ENV)), "patrol");
    assert.equal(selectMode(parseArgs(["--actor-kind", "claude", "--once"], ENV)), "poll");
    assert.equal(selectMode(parseArgs(["--actor-kind", "claude", "--subscribe"], ENV)), "subscribe");
    assert.equal(selectMode(parseArgs(["--actor-kind", "claude"], ENV)), null);
  });

  it("defaults to a 60s ping and a 600s continue", () => {
    const opts = parseArgs(["--actor-kind", "claude"], ENV);
    assert.equal(opts.pingInterval, 60);
    assert.equal(opts.continueInterval, 600);
    assert.equal(opts.patrolInterval, 300, "the SLA measurement period did not move");
    // The event subscriber's own defaults.
    assert.equal(opts.sseIdleMs, 45_000);
    assert.equal(opts.eventDebounceMs, 300);
    assert.equal(opts.eventDebounceMaxMs, 2_000);
    assert.equal(opts.eventContinueMinMs, 60_000);
  });

  it("takes the cadences from flags, environment and the agent config", () => {
    const flagged = parseArgs(["--actor-kind", "claude", "--ping-interval", "30", "--continue-interval", "900"], ENV);
    assert.equal(flagged.pingInterval, 30);
    assert.equal(flagged.continueInterval, 900);

    const fromEnv = parseArgs(["--actor-kind", "claude"], {
      ...ENV,
      MEERKAT_TASKPANEL_PING_INTERVAL: "45",
      MEERKAT_TASKPANEL_CONTINUE_INTERVAL: "120",
    });
    assert.equal(fromEnv.pingInterval, 45);
    assert.equal(fromEnv.continueInterval, 120);

    const dir = mkdtempSync(join(tmpdir(), "tp-clocks-"));
    try {
      const config = join(dir, "meerkat-taskpanel.env");
      writeFileSync(config, "MEERKAT_TASKPANEL_CONTINUE_INTERVAL=240\nMEERKAT_TASKPANEL_PING_INTERVAL=90\n");
      const opts = parseArgs(["--actor-kind", "claude", "--config", config], ENV);
      assert.equal(opts.continueInterval, 240);
      assert.equal(opts.pingInterval, 90);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries --continue=no as the raw flag the policy resolver reads", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--continue=no"], ENV).continue, "no");
  });

  it("rejects a selector without --once, and two selectors", () => {
    assert.throws(
      () => selectMode(parseArgs(["--actor-kind", "claude", "--ping-only"], ENV)),
      /requires --once/,
    );
    assert.throws(
      () => selectMode(parseArgs(["--actor-kind", "claude", "--ping-only", "--continue-only", "--once"], ENV)),
      /choose one of/,
    );
    assert.throws(
      () => selectMode(parseArgs(["--actor-kind", "claude", "--subscribe", "--once"], ENV)),
      /daemon mode/,
    );
    assert.throws(
      () => selectMode(parseArgs(["--actor-kind", "claude", "--subscribe", "--dry-run"], ENV)),
      /dry-run/,
    );
  });

  it("places the continue lock beside the state file, never inside it", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--state", "/tmp/state.json"], ENV);
    assert.equal(opts.continueState, "/tmp/continue.state.json");
    assert.notEqual(opts.continueState, opts.state);
  });
});

/** `kill(pid, 0)`, the liveness probe the ping itself uses. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a predicate; the SIGKILL is delivered asynchronously. */
async function waitUntil(predicate, ms = 3_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("the ping is the pool's single kill authority", () => {
  it("SIGTERMs once, then SIGKILLs a pool that survives, and acts no further", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-ping-kill-"));
    // A SIGTERM-trapping pool: the blocked-pool case the second signal exists for.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: "ignore" },
    );
    try {
      const statePath = join(dir, "supervisor.state.json");
      const sessionPath = join(dir, "sessions.state.json");
      const logPath = join(dir, "supervisor.log");
      const markerPath = join(dir, "pool-wedge.json");
      writeFileSync(statePath, `${JSON.stringify({ version: 1, running: {} })}\n`);
      const turn = 30 * 60 * 1_000;
      writeFileSync(
        sessionPath,
        JSON.stringify({
          version: 3,
          poolPid: child.pid,
          poolPidStart: processStartToken(child.pid),
          phase: "running",
          tickStartedAt: new Date(
            Date.now() - (sendDeadlineMs(turn) + POOL_KILL_GRACE_MS + 5_000),
          ).toISOString(),
          heartbeatAt: new Date().toISOString(),
          turnTimeoutMs: turn,
          projects: {},
        }),
      );
      const argv = [
        "--ping-only",
        "--once",
        "--actor-kind",
        "claude",
        "--agent",
        "alice",
        "--state",
        statePath,
        "--session-state",
        sessionPath,
        "--log",
        logPath,
      ];
      const env = { ...process.env, HOME: dir };
      const io = { out: () => {}, err: () => {} };

      assert.equal(await supervisorMain(argv, env, io), 0);
      const first = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.ok(Number.isFinite(Date.parse(first.wedgedKillAt)), "the SIGTERM is recorded");
      assert.equal(alive(child.pid), true, "the trapped SIGTERM does not stop the pool");

      assert.equal(await supervisorMain(argv, env, io), 0);
      assert.ok(await waitUntil(() => !alive(child.pid)), "the later ping escalates to SIGKILL");
      const second = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(second.wedgedKillAt, first.wedgedKillAt, "one SIGTERM per wedge");
      assert.ok(Number.isFinite(Date.parse(second.wedgedSigkillAt)), "the escalation is recorded");

      // A third pass finds a gone pid: the marker must not move.
      const before = readFileSync(markerPath, "utf8");
      assert.equal(await supervisorMain(argv, env, io), 0);
      assert.equal(readFileSync(markerPath, "utf8"), before);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The resident session pool surface
// ---------------------------------------------------------------------------

describe("the resident session pool surface", () => {
  const ENV = { HOME: "/home/alice" };

  it("selects session mode, and refuses a one-shot selector beside it", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--session"], ENV);
    assert.equal(selectMode(opts), "session");
    for (const extra of [["--once"], ["--dry-run"], ["--subscribe"], ["--ping-only", "--once"]]) {
      assert.throws(
        () => selectMode(parseArgs(["--actor-kind", "claude", "--session", ...extra], ENV)),
        /daemon mode/,
        `--session beside ${extra.join(" ")} was accepted`,
      );
    }
  });

  it("takes --control=external only with --session", () => {
    const external = parseArgs(["--actor-kind", "claude", "--session", "--control=external"], ENV);
    assert.equal(external.control, "external");
    assert.equal(parseArgs(["--actor-kind", "claude", "--session"], ENV).control, "internal");
    assert.throws(
      () => parseArgs(["--actor-kind", "claude", "--control=external"], ENV),
      /requires --session/,
    );
    assert.throws(
      () => parseArgs(["--actor-kind", "claude", "--session", "--control=other"], ENV),
      /internal or external/,
    );
  });

  it("defaults the pool to the documented capacities and windows", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--session"], ENV);
    assert.equal(opts.resident, "auto");
    assert.equal(opts.sessionMaxAgeMs, 24 * 60 * 60 * 1000);
    assert.equal(opts.sessionTurnTimeoutMs, 60 * 60 * 1000);
    assert.equal(opts.sessionPollMs, 1_000);
    assert.equal(opts.sessionPoolMax, 8);
    assert.equal(opts.projectIdleMs, 30 * 60 * 1000);
    assert.equal(opts.projectConcurrency, opts.maxConcurrency, "a project is not capped below the pool by default");
    assert.equal(opts.sessionState, join(dirname(opts.state), "sessions.state.json"));
    assert.equal(opts.allowAllTools, false, "full tool access is opt-in");
    assert.equal(opts.subagentBackground, undefined, "background subagents are retired");
  });

  it("takes the pool knobs from flags, environment and the agent config", () => {
    const flagged = parseArgs(
      [
        "--actor-kind", "claude", "--session",
        "--session-state", "/tmp/sessions.json",
        "--session-max-age", "3600",
        "--session-turn-timeout", "2400",
        "--session-poll-ms", "250",
        "--session-pool-max", "3",
        "--project-concurrency", "2",
        "--project-idle-ms", "60000",
      ],
      ENV,
    );
    assert.equal(flagged.sessionState, "/tmp/sessions.json");
    assert.equal(flagged.sessionMaxAgeMs, 3_600_000);
    assert.equal(flagged.sessionTurnTimeoutMs, 2_400_000);
    assert.equal(flagged.sessionPollMs, 250);
    assert.equal(flagged.sessionPoolMax, 3);
    assert.equal(flagged.projectConcurrency, 2);
    assert.equal(flagged.projectIdleMs, 60_000);

    const fromEnv = parseArgs(["--actor-kind", "claude", "--session"], {
      ...ENV,
      MEERKAT_TASKPANEL_SESSION_MAX_AGE: "120",
      MEERKAT_TASKPANEL_SESSION_POOL_MAX: "4",
      MEERKAT_TASKPANEL_PROJECT_IDLE_MS: "5000",
    });
    assert.equal(fromEnv.sessionMaxAgeMs, 120_000);
    assert.equal(fromEnv.sessionPoolMax, 4);
    assert.equal(fromEnv.projectIdleMs, 5_000);

    const dir = mkdtempSync(join(tmpdir(), "tp-session-opts-"));
    try {
      const config = join(dir, "meerkat-taskpanel.env");
      writeFileSync(config, "MEERKAT_TASKPANEL_SESSION_TURN_TIMEOUT=1800\nMEERKAT_TASKPANEL_PROJECT_CONCURRENCY=2\n");
      const opts = parseArgs(["--actor-kind", "claude", "--session", "--config", config], ENV);
      assert.equal(opts.sessionTurnTimeoutMs, 1_800_000);
      assert.equal(opts.projectConcurrency, 2);
      // A flag still beats the agent config.
      const overriding = parseArgs(
        ["--actor-kind", "claude", "--session", "--config", config, "--session-turn-timeout", "3600"],
        ENV,
      );
      assert.equal(overriding.sessionTurnTimeoutMs, 3_600_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds the turn between 2x the heartbeat window and the ledger reap (0034)", () => {
    // The defaults pass; the boundaries are exact (1200 accepted, 7200 refused).
    assert.equal(
      parseArgs(["--actor-kind", "claude", "--session", "--session-turn-timeout", "1200"], ENV).sessionTurnTimeoutMs,
      1_200_000,
    );
    assert.equal(
      parseArgs(["--actor-kind", "claude", "--session", "--session-turn-timeout", "7199"], ENV).sessionTurnTimeoutMs,
      7_199_000,
    );
    for (const bad of ["900", "1199", "7200", "36000"]) {
      assert.throws(
        () => parseArgs(["--actor-kind", "claude", "--session", "--session-turn-timeout", bad], ENV),
        /must be between 1200 and 7199/,
        bad,
      );
    }
    // Every source goes through the same guard.
    assert.throws(
      () => parseArgs(["--actor-kind", "claude", "--session"], { ...ENV, MEERKAT_TASKPANEL_SESSION_TURN_TIMEOUT: "60" }),
      /must be between 1200 and 7199/,
    );
    const dir = mkdtempSync(join(tmpdir(), "tp-turn-bound-"));
    try {
      const config = join(dir, "meerkat-taskpanel.env");
      writeFileSync(config, "MEERKAT_TASKPANEL_SESSION_TURN_TIMEOUT=7200\n");
      assert.throws(
        () => parseArgs(["--actor-kind", "claude", "--session", "--config", config], ENV),
        /must be between 1200 and 7199/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a zero max-age as the documented 'never'", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--session", "--session-max-age", "0"], ENV).sessionMaxAgeMs, 0);
  });

  it("accepts --resident=auto|no and rejects anything else", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--resident=no"], ENV).resident, "no");
    assert.equal(parseArgs(["--actor-kind", "claude", "--resident=auto"], ENV).resident, "auto");
    assert.throws(() => parseArgs(["--actor-kind", "claude", "--resident=maybe"], ENV), /auto or no/);
  });

  it("requires a recorded authorization for full tool access", () => {
    assert.throws(
      () => parseArgs(["--actor-kind", "claude", "--session", "--allow-all-tools"], ENV),
      /--allow-all-tools-reason/,
    );
    const authorized = parseArgs(
      ["--actor-kind", "claude", "--session", "--allow-all-tools", "--allow-all-tools-reason", "operator authorized unattended runs"],
      ENV,
    );
    assert.equal(authorized.allowAllTools, true);
    assert.equal(authorized.allowAllToolsReason, "operator authorized unattended runs");

    const fromEnv = parseArgs(["--actor-kind", "claude"], {
      ...ENV,
      MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS: "yes",
      MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON: "fleet policy",
    });
    assert.equal(fromEnv.allowAllTools, true);
    assert.equal(fromEnv.allowAllToolsReason, "fleet policy");
  });

  it("retires background subagents", () => {
    // No adapter reports a per-subagent completion, so the switch can only leak
    // slots. An explicit "yes" fails loudly; "no" (the shipped config) is inert.
    for (const argv of [["--subagent-background"], ["--subagent-background=yes"]]) {
      assert.throws(
        () => parseArgs(["--actor-kind", "claude", ...argv], ENV),
        /background subagents are retired/,
      );
    }
    assert.throws(
      () => parseArgs(["--actor-kind", "claude"], { ...ENV, MEERKAT_TASKPANEL_SUBAGENT_BACKGROUND: "yes" }),
      /background subagents are retired/,
    );
    assert.equal(
      parseArgs(["--actor-kind", "claude", "--subagent-background=no"], ENV).subagentBackground,
      false,
    );
    assert.equal(
      parseArgs(["--actor-kind", "claude"], { ...ENV, MEERKAT_TASKPANEL_SUBAGENT_BACKGROUND: "no" }).subagentBackground,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The concurrency cap: one total, shared by workers and reviewers
// ---------------------------------------------------------------------------

describe("the concurrency cap", () => {
  const ENV = { HOME: "/home/alice" };

  it("defaults to the documented total, with no per-role split", () => {
    const opts = parseArgs(["--actor-kind", "claude"], ENV);
    assert.equal(opts.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    assert.equal(opts.projectConcurrency, DEFAULT_MAX_CONCURRENCY);
    assert.equal(opts.maxWorkers, undefined, "there is no per-role cap");
    assert.equal(opts.maxReviewers, undefined, "there is no per-role cap");
  });

  it("takes the cap from flag > environment > agent config, then the default", () => {
    const fromEnv = parseArgs(["--actor-kind", "claude"], {
      ...ENV,
      MEERKAT_TASKPANEL_MAX_CONCURRENCY: "5",
    });
    assert.equal(fromEnv.maxConcurrency, 5);
    assert.equal(fromEnv.projectConcurrency, 5, "a project is not capped below the resolved total");

    const dir = mkdtempSync(join(tmpdir(), "tp-concurrency-"));
    try {
      writeFileSync(join(dir, ".env.claude"), "MEERKAT_TASKPANEL_MAX_CONCURRENCY=4\n");
      const fromFile = parseArgs(["--actor-kind", "claude", "--home", dir], {
        MEERKAT_TASKPANEL_CONFIG_DIR: dir,
      });
      assert.equal(fromFile.maxConcurrency, 4);

      const envWins = parseArgs(["--actor-kind", "claude", "--home", dir], {
        MEERKAT_TASKPANEL_CONFIG_DIR: dir,
        MEERKAT_TASKPANEL_MAX_CONCURRENCY: "5",
      });
      assert.equal(envWins.maxConcurrency, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const flagged = parseArgs(["--actor-kind", "claude", "--max-concurrency", "2"], {
      ...ENV,
      MEERKAT_TASKPANEL_MAX_CONCURRENCY: "5",
    });
    assert.equal(flagged.maxConcurrency, 2);
  });

  it("reads the per-kind config from the program root, selected by kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-kind-config-"));
    try {
      writeFileSync(join(dir, ".env.claude"), "MEERKAT_TASKPANEL_MAX_CONCURRENCY=3\n");
      writeFileSync(join(dir, ".env.codex"), "MEERKAT_TASKPANEL_MAX_CONCURRENCY=4\n");
      const env = { MEERKAT_TASKPANEL_CONFIG_DIR: dir };

      const claude = parseArgs(["--actor-kind", "claude"], env);
      const codex = parseArgs(["--actor-kind", "codex"], env);
      assert.equal(claude.config, join(dir, ".env.claude"));
      assert.equal(claude.maxConcurrency, 3);
      assert.equal(codex.config, join(dir, ".env.codex"));
      assert.equal(codex.maxConcurrency, 4);

      // `--home` no longer chooses the config file.
      const moved = parseArgs(["--actor-kind", "claude", "--home", "/tmp/elsewhere"], env);
      assert.equal(moved.config, join(dir, ".env.claude"));

      // `--config` is an explicit override and still wins.
      writeFileSync(join(dir, "explicit.env"), "MEERKAT_TASKPANEL_MAX_CONCURRENCY=9\n");
      const explicit = parseArgs(["--actor-kind", "claude", "--config", join(dir, "explicit.env")], env);
      assert.equal(explicit.maxConcurrency, 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a legacy <agent-dir>/meerkat-taskpanel.env", () => {
    const home = mkdtempSync(join(tmpdir(), "tp-legacy-config-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "meerkat-taskpanel.env"), "MEERKAT_TASKPANEL_MAX_CONCURRENCY=4\n");
      const opts = parseArgs(["--actor-kind", "claude", "--home", home], {
        MEERKAT_TASKPANEL_CONFIG_DIR: join(home, "no-kind-config"),
      });
      assert.equal(opts.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("forwards --config only when it differs from the per-kind default", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-kind-forward-"));
    try {
      const env = { MEERKAT_TASKPANEL_CONFIG_DIR: dir };
      const byDefault = parseArgs(["--actor-kind", "claude"], env);
      assert.equal(byDefault.config, join(dir, ".env.claude"), "the per-kind default is resolved");
      const explicit = parseArgs(["--actor-kind", "claude", "--config", join(dir, "explicit.env")], env);
      assert.equal(explicit.config, join(dir, "explicit.env"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps zero as 'claim nothing'", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--max-concurrency", "0"], ENV).maxConcurrency, 0);
  });
});

// ---------------------------------------------------------------------------
// The plan → wire → runner seam
// ---------------------------------------------------------------------------

describe("the workflow plan survives the wire and executes", () => {
  after(cleanupTempDirs);

  const HUMAN = { kind: "human", id: "Terry" };
  const WORKER = { kind: "agent", id: "linus" };
  const REVIEWER = { kind: "agent", id: "jobs" };

  const DELIVERY = {
    conclusion: "The thing is done.",
    acceptance: [{ text: "the thing works", status: "met", note: "the commit — evidence[1]" }],
    evidence: [{ kind: "commit", sha: "abc1234" }],
  };
  const VERDICT = {
    conclusion: "VERDICT: APPROVE",
    acceptance: [{ text: "the evidence matches", status: "met", note: "evidence[2] — the run" }],
    evidence: [
      { kind: "path", path: "src/thing.mjs" },
      { kind: "command", cmd: "node --test test/thing.test.mjs", exit_code: 0 },
    ],
  };

  it("carries a board plan through the wire and executes the approve", async () => {
    await withBoard(async ({ db }) => {
      const repos = createRepositories(db);
      const ctx = createContext({ db, repos });
      const commands = createCommands(ctx);

      commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
      const original = commands.createTask({
        projectId: "proj",
        title: "Do the thing",
        assignee: "linus",
        acceptanceMode: "auto",
        actor: HUMAN,
      });
      commands.moveStatus({ id: original.id, to: "in_progress", actor: WORKER });
      commands.deliver({ taskId: original.id, report: DELIVERY, actor: WORKER });

      const review = commands.createTask({
        projectId: "proj",
        title: "Review Do the thing",
        assignee: "jobs",
        reviewOf: original.identifier,
        reviewRound: 1,
        meta: { flow: "B" },
        actor: HUMAN,
      });
      commands.moveStatus({ id: review.id, to: "in_progress", actor: REVIEWER });
      commands.deliver({ taskId: review.id, report: VERDICT, actor: REVIEWER });

      const plan = workflowToWire(commands.workflowTick({ reviewer: "jobs" }).workflow);
      assert.equal(plan.actions[0]?.original_ref, original.identifier);
      assert.equal(plan.actions[0]?.review_ref, review.identifier);

      const order = [];
      const result = await runWorkflowTick({
        plan,
        config: { workflow: true },
        createReview: async () => ({ ok: true }),
        createFixChild: async () => ({ ok: true }),
        linkFixChild: async () => ({ ok: true }),
        move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
        comment: async (ref, input) => (order.push(`comment:${ref}:${input.kind}`), { ok: true }),
        setMeta: async (ref) => (order.push(`meta:${ref}`), { ok: true }),
        notify: () => {},
        log: () => {},
      });

      assert.deepEqual(order, [
        `meta:${original.identifier}`,
        `comment:${original.identifier}:note`,
        `move:${original.identifier}:done`,
        `comment:${review.identifier}:note`,
        `move:${review.identifier}:done`,
      ]);
      assert.equal(result.executed, 1);
      assert.equal(result.failed, 0);
    });
  });
});

describe("parseArgs — the writer identity and roles root", () => {
  it("takes the writer identity from TASKCTL_AGENT, never from a scan list", () => {
    const opts = parseArgs(
      ["--actor-kind", "claude", "--home", "/tmp/tp-team-home"],
      {
        HOME: "/tmp/tp-team-home",
        TASKCTL_AGENT: "alice",
        // The retired key is inert: the claimable set is discovered, not configured.
        MEERKAT_TASKPANEL_AGENTS: "Jobs, Linus turing",
      },
    );
    assert.deepEqual(opts.agents, ["alice"]);
  });

  it("keeps explicit --agent flags above TASKCTL_AGENT", () => {
    const opts = parseArgs(
      ["--actor-kind", "claude", "--home", "/h", "--agent", "alice"],
      { TASKCTL_AGENT: "shim", MEERKAT_TASKPANEL_AGENTS: "Jobs,Linus" },
    );
    assert.deepEqual(opts.agents, ["alice"]);
  });

  it("falls back to one default writer identity when nothing names one", () => {
    // setup-meerkat is optional: without TASKCTL_AGENT the loop still needs one
    // identity to write as. The empty config path is the point of the temp home —
    // a developer's installed agent config must not leak in. The config root is
    // *not* `--home`: unset, it falls back to the program root, so pin it.
    const dir = mkdtempSync(join(tmpdir(), "tp-team-unset-"));
    try {
      const agentsFor = (env) =>
        parseArgs(["--actor-kind", "claude", "--home", dir], {
          ...env,
          MEERKAT_TASKPANEL_CONFIG_DIR: dir,
        }).agents;
      assert.deepEqual(agentsFor({}), ["agent"], "no identity at all");
      assert.deepEqual(agentsFor({ LOGNAME: "logname" }), ["logname"]);
      assert.deepEqual(agentsFor({ USER: "user", LOGNAME: "logname" }), ["user"]);
      assert.deepEqual(agentsFor({ TASKCTL_AGENT: "task", USER: "user" }), ["task"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves --roles-dir and MEERKAT_TASKPANEL_ROLES_DIR", () => {
    const flag = parseArgs(
      ["--actor-kind", "claude", "--home", "/h", "--roles-dir", "/team"],
      {},
    );
    assert.equal(flag.rolesDir, "/team");
    const env = parseArgs(
      ["--actor-kind", "claude", "--home", "/h"],
      { MEERKAT_TASKPANEL_ROLES_DIR: "/env-team" },
    );
    assert.equal(env.rolesDir, "/env-team");
  });

  it("exposes the director skill path for every actor kind", () => {
    const paths = agentPaths("/home/alice", "pi");
    assert.equal(paths.directorSkill, "/home/alice/.agents/skills/meerkat-director");
    assert.equal(Object.hasOwn(paths, "loopRoles"), false, "roles no longer live in the skill tree");
  });
});

describe("daemon shutdown — the in-flight continue is drained, never abandoned", () => {
  function daemonOpts(dir) {
    return {
      continueInterval: 1,
      pingInterval: 600,
      state: join(dir, "state.json"),
      dryRun: true,
      configFile: {},
      actorKind: "claude",
      agents: ["alice"],
    };
  }

  it("waits out the in-flight continue up to the bound, then exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-daemon-drain-"));
    try {
      const controller = new AbortController();
      let markStarted;
      const started = new Promise((resolveStarted) => {
        markStarted = resolveStarted;
      });
      let exited = null;
      const begin = Date.now();
      // Abort only once a continue is genuinely in flight, so the drain has
      // something to wait for.
      void started.then(() => controller.abort());
      const code = await runDaemon(
        daemonOpts(dir),
        { MEERKAT_TASKPANEL_CONTINUE: "1" },
        () => {},
        {
          signal: controller.signal,
          exit: (value) => {
            exited = value;
          },
          drainMs: 60,
          runContinue: () => {
            markStarted();
            return new Promise(() => {});
          },
        },
      );
      const elapsed = Date.now() - begin;
      assert.equal(code, 0);
      assert.equal(exited, 0, "SIGTERM exits 0 even when a continue never finishes");
      assert.ok(elapsed >= 50, `it waits for the drain bound, not less (${elapsed}ms)`);
      assert.ok(elapsed < 3000, `the drain is bounded (${elapsed}ms)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 immediately when no continue is in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-daemon-idle-"));
    try {
      const controller = new AbortController();
      controller.abort();
      let exited = null;
      const begin = Date.now();
      const code = await runDaemon(
        daemonOpts(dir),
        { MEERKAT_TASKPANEL_CONTINUE: "1" },
        () => {},
        {
          signal: controller.signal,
          exit: (value) => {
            exited = value;
          },
          drainMs: 10_000,
          runContinue: () => new Promise(() => {}),
        },
      );
      assert.equal(code, 0);
      assert.equal(exited, 0);
      assert.ok(Date.now() - begin < 1000, "an empty drain does not wait out the bound");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
