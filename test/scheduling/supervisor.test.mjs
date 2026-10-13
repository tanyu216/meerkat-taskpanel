/**
 * The host-external supervisor (T-20261010-013000).
 *
 * Two halves, deliberately:
 *
 *   * the **pure decision** — `planTick` / `planPatrol` / `parseHeartbeat` /
 *     `resolveClaimUnassigned` / `buildHandoff` / `wakeCommand` / `planWakeInvocation` —
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  DEFAULT_MAX_CONCURRENCY,
  buildHandoff,
  candidateArgs,
  parseEnvFile,
  parseHeartbeat,
  planPatrol,
  planTick,
  planWakeInvocation,
  pruneRegistry,
  resolveClaimUnassigned,
  wakeCommand,
} from "../../src/shared/scheduling.mjs";
import { emptySlaLedger, planSlaPatrol } from "../../src/shared/sla-patrol.mjs";
import {
  defaultRepo,
  loadSlaLedger,
  parseArgs,
  runPatrolTick,
  runPollTick,
  saveSlaLedger,
} from "../../scripts/supervisor.mjs";

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

  it("builds a codex exec wake, resuming a thread when a session id is known", () => {
    const fresh = wakeCommand({ host: "codex", prompt: "do T-1" });
    assert.equal(fresh.command, "codex");
    assert.deepEqual(fresh.args, ["exec", "do T-1"]);

    const resumed = wakeCommand({ host: "codex", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["exec", "resume", "sid-9", "do T-1"]);
  });

  it("builds a pi wake (--print, no `run`), resuming a session when an id is known", () => {
    const fresh = wakeCommand({ host: "pi", prompt: "do T-1" });
    assert.equal(fresh.command, "pi");
    assert.deepEqual(fresh.args, ["--print", "do T-1"]);
    assert.ok(!fresh.args.includes("run"), "pi has no `run` subcommand — headless is `--print`");

    const resumed = wakeCommand({ host: "pi", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["--print", "--session", "sid-9", "do T-1"]);
  });

  it("honours an explicit --wake-command override, with and without a session id", () => {
    const overridden = wakeCommand({ host: "claude", prompt: "do T-1", wakeCommand: "my-wake.sh" });
    assert.equal(overridden.command, "my-wake.sh");
    assert.deepEqual(overridden.args, ["do T-1"]);

    const resumed = wakeCommand({ host: "claude", prompt: "do T-1", resumeSid: "sid-9", wakeCommand: "my-wake.sh" });
    assert.deepEqual(resumed.args, ["do T-1", "--resume", "sid-9"]);
  });
});

// ---------------------------------------------------------------------------
// Pure: planWakeInvocation — the glue owns the working directory (R1)
// ---------------------------------------------------------------------------

describe("planWakeInvocation (pure)", () => {
  const GLUE = "/home/alice/.claude/bin/wake-claude.sh";
  const MAP = "/home/alice/.claude/skills/meerkat-taskpanel/projects.json";

  it("starts the host's wake glue when one is installed", () => {
    const plan = planWakeInvocation({
      host: "claude",
      prompt: "do T-1",
      gluePath: GLUE,
      glueInstalled: true,
      project: "TaskPanel",
      projectsJson: MAP,
      nodePath: "/usr/local/bin/node",
      cwd: "/repo",
    });
    assert.equal(plan.via, "glue");
    assert.equal(plan.command, "bash");
    assert.deepEqual(plan.args, [GLUE, "do T-1"]);
    // The glue gets everything it needs to resolve and run: the identity, the
    // map, and a node it can trust (cron/launchd PATH is minimal).
    assert.deepEqual(plan.env, {
      TP_PROJECT: "TaskPanel",
      TP_PROJECTS_JSON: MAP,
      TP_NODE: "/usr/local/bin/node",
    });
    assert.equal(plan.cwd, "/repo");
    assert.equal(plan.warning, undefined, "a glue means no warning");
  });

  it("passes a session id to the glue as its second argument", () => {
    const plan = planWakeInvocation({
      host: "codex",
      prompt: "do T-1",
      resumeSid: "sid-9",
      gluePath: "/home/alice/.codex/bin/wake-codex.sh",
      glueInstalled: true,
      project: "TaskPanel",
    });
    assert.deepEqual(plan.args, ["/home/alice/.codex/bin/wake-codex.sh", "do T-1", "sid-9"]);
  });

  it("falls back to the host CLI — with an explicit warning — when no glue is installed", () => {
    const plan = planWakeInvocation({
      host: "claude",
      prompt: "do T-1",
      gluePath: GLUE,
      glueInstalled: false,
      project: "TaskPanel",
      cwd: "/repo",
    });
    assert.equal(plan.via, "direct");
    assert.equal(plan.command, "claude");
    assert.deepEqual(plan.args, ["-p", "do T-1"]);
    // The fallback is pinned to a known directory and says so out loud: a silent
    // run in an arbitrary cwd is the bug this whole path exists to remove.
    assert.equal(plan.cwd, "/repo");
    assert.match(plan.warning, /no wake glue at .*wake-claude\.sh/);
    assert.match(plan.warning, /\/repo/);
    // The identity still travels, so a user-supplied glue can use it.
    assert.equal(plan.env.TP_PROJECT, "TaskPanel");
  });

  it("honours an explicit --wake-command over everything, without warning", () => {
    const plan = planWakeInvocation({
      host: "claude",
      prompt: "do T-1",
      wakeCommand: "my-wake.sh",
      // Even with a glue installed: an explicit choice is not overridden by a default.
      gluePath: GLUE,
      glueInstalled: true,
      project: "TaskPanel",
    });
    assert.equal(plan.via, "override");
    assert.equal(plan.command, "my-wake.sh");
    assert.deepEqual(plan.args, ["do T-1"]);
    assert.equal(plan.warning, undefined);
    // The identity still travels, so an operator's glue can resolve it too.
    assert.equal(plan.env.TP_PROJECT, "TaskPanel");
  });

  it("sends no project variables when the card carries no project identity", () => {
    const plan = planWakeInvocation({ host: "claude", prompt: "do T-1", gluePath: GLUE, glueInstalled: true });
    assert.deepEqual(plan.env, {});
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

  // The heartbeat row is the ONE `PROTOCOL §⑮` row the SLA pass deliberately
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
// parseArgs — the wake surface the glue decision is built from
// ---------------------------------------------------------------------------

describe("parseArgs — the wake surface", () => {
  const ENV = { HOME: "/home/alice" };

  it("defaults the glue and the project map under the host's dot-directory", () => {
    const opts = parseArgs(["--host", "codex", "--once"], ENV);
    assert.equal(opts.glue, "/home/alice/.codex/bin/wake-codex.sh");
    assert.equal(opts.projectsJson, "/home/alice/.codex/skills/meerkat-taskpanel/projects.json");
    assert.equal(opts.wakeCommand, null, "no override unless the operator asks for one");
  });

  it("accepts an explicit glue, map and wake command", () => {
    const opts = parseArgs(
      [
        "--host", "pi",
        "--glue", "/tmp/my-wake.sh",
        "--projects-json=/tmp/map.json",
        "--wake-command", "my-wake.sh",
      ],
      ENV,
    );
    assert.equal(opts.glue, "/tmp/my-wake.sh");
    assert.equal(opts.projectsJson, "/tmp/map.json");
    assert.equal(opts.wakeCommand, "my-wake.sh");
  });

  it("defaults the SLA ledger beside the state file, and follows a custom one", () => {
    assert.equal(parseArgs(["--host", "claude", "--once"], ENV).slaLedger, "/home/alice/.claude/meerkat-taskpanel/sla-ledger.json");
    const moved = parseArgs(["--host", "claude", "--once", "--state", "/tmp/state.json"], ENV);
    assert.equal(moved.slaLedger, "/tmp/sla-ledger.json", "one directory remembers everything");
    assert.equal(parseArgs(["--host", "claude", "--once", "--sla-ledger=/tmp/l.json"], ENV).slaLedger, "/tmp/l.json");
  });

  it("bounds the two reads the SLA pass makes", () => {
    const opts = parseArgs(["--host", "claude", "--once"], ENV);
    assert.ok(opts.boardLimit > 0);
    assert.ok(opts.trailLimit > 0);
    assert.equal(parseArgs(["--host", "claude", "--once", "--board-limit=10", "--trail-limit", "5"], ENV).boardLimit, 10);
    assert.equal(parseArgs(["--host", "claude", "--once", "--trail-limit", "5"], ENV).trailLimit, 5);
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
});

// ---------------------------------------------------------------------------
// defaultRepo — where a run that was not told finds the board it drives
// (T-20261012-163500-loopdecouple-c: the executor is also installed as a host copy)
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

  it("answers with the board beside the executor, and never reads the host config", () => {
    // The checkout's own supervisor is the documented dev run, so it stays hermetic:
    // a stale MEERKAT_TASKPANEL_REPO on the machine cannot redirect it.
    const config = join(tempDir("meerkat-defaultrepo-"), "meerkat-taskpanel.env");
    writeFileSync(config, "MEERKAT_TASKPANEL_REPO=/somewhere/else\n", "utf8");
    assert.equal(defaultRepo(config, REPO), REPO);
  });

  it("reads the recorded checkout for a host copy that has no board beside it", () => {
    // install.sh copies the loop body under <host-dir>/meerkat-taskpanel/, where
    // `src/cli/index.mjs` does not exist; the host config is then the only place the
    // copied executor can learn where the `taskctl` it drives lives.
    const dir = tempDir("meerkat-defaultrepo-host-");
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
    assert.equal(parseArgs(["--host", "codex", "--once"], { HOME: "/home/alice" }).repo, REPO);
    const opts = parseArgs(["--host", "codex", "--once", "--repo", "/tmp/board"], { HOME: "/home/alice" });
    assert.equal(opts.repo, "/tmp/board");
    assert.equal(opts.cli, "/tmp/board/src/cli/index.mjs");
  });
});

// ---------------------------------------------------------------------------
// Wiring sanity: the exported runner lives in the repo
// ---------------------------------------------------------------------------

describe("supervisor module", () => {
  // Resolved *relative to this test file*, never from a directory name — the
  // checkout is mounted at /app inside the container, so any assertion keyed on
  // the repo being named "meerkat-taskpanel" would hold on the host and fail there.
  const SUPERVISOR_URL = new URL("../../scripts/supervisor.mjs", import.meta.url);
  const SUPERVISOR_PATH = fileURLToPath(SUPERVISOR_URL);

  it("is a repo-relative ESM file that exists", () => {
    assert.ok(SUPERVISOR_PATH.endsWith(".mjs"), SUPERVISOR_PATH);
    assert.ok(existsSync(SUPERVISOR_PATH), SUPERVISOR_PATH);
  });

  it("imports from wherever the checkout lives and exposes the runner surface (container form)", async () => {
    // Container form: hold under an arbitrary ROOT (e.g. /app), where the parent
    // directory is *not* named "meerkat-taskpanel". Loading by URL proves the module is
    // importable in place; the export check proves it is the runner, not a stub.
    const mod = await import(SUPERVISOR_URL.href);
    for (const name of ["runPollTick", "runPatrolTick", "parseArgs", "loadRegistry", "saveRegistry", "planWakeInvocation"]) {
      assert.equal(typeof mod[name], "function", `missing export: ${name}`);
    }
  });
});
