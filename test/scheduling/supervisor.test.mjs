/**
 * The host-external supervisor (T-20261010-013000).
 *
 * Two halves, deliberately:
 *
 *   * the **pure decision** — `planTick` / `planPatrol` / `parseHeartbeat` /
 *     `resolveClaimUnassigned` / `buildHandoff` / `wakeCommand` — is asserted directly.
 *     No process, no clock, no filesystem.
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_CONCURRENCY,
  buildHandoff,
  candidateArgs,
  parseEnvFile,
  parseHeartbeat,
  planPatrol,
  planTick,
  pruneRegistry,
  resolveClaimUnassigned,
  wakeCommand,
} from "../../src/shared/scheduling.mjs";
import { runPatrolTick, runPollTick } from "../../scripts/supervisor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

const BASE_CONFIG = { maxConcurrency: DEFAULT_MAX_CONCURRENCY, claimUnassigned: true, host: "claude" };

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
      tasks: [{ identifier: "T-1", status: "in_progress", claimed_by: "alice", heartbeat_at: ago(31) }],
      now,
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "stale");
    assert.equal(alerts[0].identifier, "T-1");
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
    assert.equal(resolveClaimUnassigned({ env: "no", file: { TASKPANEL_CLAIM_UNASSIGNED: "yes" } }), false);
    assert.equal(resolveClaimUnassigned({ file: { TASKPANEL_CLAIM_UNASSIGNED: "no" } }), false);
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
      ["# a comment", "", "TASKPANEL_CLAIM_UNASSIGNED=no", 'OTHER="quoted value"', "export THIRD=1"].join("\n"),
    );
    assert.equal(parsed.TASKPANEL_CLAIM_UNASSIGNED, "no");
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
});

// ---------------------------------------------------------------------------
// Pure: wake command + handoff
// ---------------------------------------------------------------------------

describe("wakeCommand (pure)", () => {
  it("builds a headless claude wake, resuming a session when one is known", () => {
    const fresh = wakeCommand({ host: "claude", prompt: "do T-1" });
    assert.equal(fresh.command, "claude");
    assert.deepEqual(fresh.args, ["-p", "do T-1"]);

    const resumed = wakeCommand({ host: "claude", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["-p", "do T-1", "--resume", "sid-9"]);
  });

  it("builds a codex exec wake", () => {
    const cmd = wakeCommand({ host: "codex", prompt: "do T-1" });
    assert.equal(cmd.command, "codex");
    assert.deepEqual(cmd.args, ["exec", "do T-1"]);
  });

  it("builds a pi wake and honours an explicit --wake-command override", () => {
    assert.equal(wakeCommand({ host: "pi", prompt: "do T-1" }).command, "pi");
    const overridden = wakeCommand({ host: "claude", prompt: "do T-1", wakeCommand: "my-wake.sh" });
    assert.equal(overridden.command, "my-wake.sh");
  });
});

describe("buildHandoff (pure)", () => {
  it("carries the card, the attribution flags and the claim-first rules, bounded", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1", target: "/repo" },
      agent: "alice",
      host: "claude",
      sessionId: "sid-9",
    });
    assert.match(text, /T-1/);
    assert.match(text, /Wire the supervisor/);
    assert.match(text, /--agent alice/);
    assert.match(text, /--agent-platform claude/);
    assert.match(text, /--session-id sid-9/);
    assert.match(text, /report/i);
    assert.ok(text.length < 2000, "the handoff must be bounded");
  });

  it("truncates an absurdly long title so the handoff stays bounded", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "x".repeat(5000), project: "P1", target: "/repo" },
      agent: "alice",
      host: "codex",
    });
    assert.ok(text.length < 2000);
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
      config: { patrolLlm: true, host: "claude", agent: "alice" },
      spawnPatrol,
      notify: () => {},
      now: () => now,
      log: () => {},
    });
    assert.equal(spawnPatrol.count(), 1);
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
// Wiring sanity: the exported runner lives in the repo
// ---------------------------------------------------------------------------

describe("supervisor module", () => {
  it("is a repo-relative ESM module", () => {
    assert.ok(ROOT.endsWith("task-panel"), ROOT);
  });
});
