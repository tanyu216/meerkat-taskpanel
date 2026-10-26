/**
 * The external supervisor (T-20261010-013000).
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
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  DEFAULT_MAX_CONCURRENCY,
  buildHandoff,
  buildQuestionPrompt,
  buildReviewHandoff,
  candidateArgs,
  parseEnvFile,
  parseHeartbeat,
  planPatrol,
  planTick,
  planWakeInvocation,
  pruneRegistry,
  resolveClaimUnassigned,
  resolveRecoverStale,
  wakeCommand,
} from "../../src/foundation/scheduling.mjs";
import { emptySlaLedger, planSlaPatrol } from "../../src/foundation/sla-patrol.mjs";
import { agentPaths, defaultRepo, loopCommandArgs, parseArgs, selectMode } from "../../scripts/loop/options.mjs";
import { loadSlaLedger, readPeerLastOk, readPeerMarker, saveLastOk, saveSlaLedger } from "../../scripts/loop/runtime.mjs";
import { notifyReal, runPatrolTick, runPollTick, runWorkflowTick, spawnWorkerReal } from "../../scripts/loop/runners.mjs";
import { resolveWakeDir } from "../../scripts/wake-cwd.mjs";
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

  it("builds an opencode run wake, resuming a session when an id is known", () => {
    const fresh = wakeCommand({ actorKind: "opencode", prompt: "do T-1" });
    assert.equal(fresh.command, "opencode");
    assert.deepEqual(fresh.args, ["run", "do T-1"]);

    const resumed = wakeCommand({ actorKind: "opencode", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["run", "--session", "sid-9", "do T-1"]);
  });

  it("builds a cursor-agent -p wake, resuming a session when an id is known", () => {
    // Cursor's headless form is the documented `cursor-agent -p`; the resume flag
    // is the unverified half (there is no Cursor CLI here), kept behind the same
    // `--wake-command` escape hatch as every other agent kind.
    const fresh = wakeCommand({ actorKind: "cursor", prompt: "do T-1" });
    assert.equal(fresh.command, "cursor-agent");
    assert.deepEqual(fresh.args, ["-p", "do T-1"]);

    const resumed = wakeCommand({ actorKind: "cursor", prompt: "do T-1", resumeSid: "sid-9" });
    assert.deepEqual(resumed.args, ["-p", "--resume", "sid-9", "do T-1"]);
  });

  it("honours an explicit --wake-command override, with and without a session id", () => {
    const overridden = wakeCommand({ actorKind: "claude", prompt: "do T-1", wakeCommand: "my-wake.sh" });
    assert.equal(overridden.command, "my-wake.sh");
    assert.deepEqual(overridden.args, ["do T-1"]);

    const resumed = wakeCommand({ actorKind: "claude", prompt: "do T-1", resumeSid: "sid-9", wakeCommand: "my-wake.sh" });
    assert.deepEqual(resumed.args, ["do T-1", "--resume", "sid-9"]);
  });
});

// ---------------------------------------------------------------------------
// Pure: planWakeInvocation — the glue owns the working directory (R1)
// ---------------------------------------------------------------------------

describe("planWakeInvocation (pure)", () => {
  const GLUE = "/home/alice/.claude/bin/wake-claude.sh";
  const MAP = "/home/alice/.claude/skills/meerkat-taskpanel/projects.json";

  it("starts the agent kind's wake glue when one is installed", () => {
    const plan = planWakeInvocation({
      actorKind: "claude",
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
      actorKind: "codex",
      prompt: "do T-1",
      resumeSid: "sid-9",
      gluePath: "/home/alice/.codex/bin/wake-codex.sh",
      glueInstalled: true,
      project: "TaskPanel",
    });
    assert.deepEqual(plan.args, ["/home/alice/.codex/bin/wake-codex.sh", "do T-1", "sid-9"]);
  });

  it("falls back to the agent CLI — with an explicit warning — when no glue is installed", () => {
    const plan = planWakeInvocation({
      actorKind: "claude",
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
      actorKind: "claude",
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
    const plan = planWakeInvocation({ actorKind: "claude", prompt: "do T-1", gluePath: GLUE, glueInstalled: true });
    assert.deepEqual(plan.env, {});
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
    assert.match(text, /do not spawn a subagent for this row/);
    assert.match(text, /--kind note/);
    assert.match(text, /issue move T-1 todo/);
    assert.match(text, /awaiting --awaiting-reason/);
    assert.match(text, /never use --as-human/);
    assert.match(text, /Never move a card to done/);
    assert.match(text, /Decision policy: \/roles\/decision-policy\.md/);
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

  it("places the worker in the project session and says the claim is already taken", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(text, /^You are a worker subagent of the P1 project session/);
    assert.match(text, /working directory is this project's directory/);
    assert.match(text, /never touch another project's paths/);
    assert.match(text, /already claimed this card for you: do not claim it again/);
  });

  it("points the worker at the authoritative card brief and the process directory", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(text, /Task brief: \.meerkat\/T-1\/card\.md/);
    assert.match(text, /read it first, it is authoritative/);
    assert.match(text, /Never edit \.meerkat\/T-1\/card\.md/);
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

  it("asks the project session before splitting an epic, rather than promoting it", () => {
    const text = buildHandoff({
      card: { identifier: "T-1", title: "Wire the supervisor", project: "P1" },
      agent: "alice",
      actorKind: "claude",
    });
    assert.match(text, /Step 0/);
    // The decision ladder: a subagent does not decide a split (or a scope
    // expansion) itself; it asks the project session, which may escalate E1.
    assert.match(text, /Do not promote or split yourself/);
    assert.match(text, /add an agent question/);
    assert.match(text, /keep the card in_progress/);
    assert.match(text, /scope expansion is E1/);
    assert.match(text, /meta\.epic_triage=off/);
    assert.doesNotMatch(text, /--kind epic/);
    assert.doesNotMatch(text, /relation add T-1 --type parent/);
    assert.match(text, /stop at in_review — a human accepts to done/, "the default has no reviewer");
  });

  it("sets the acceptance list before work and escalates questions to the project session", () => {
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
    assert.match(text, /append, never replace or remove/i);
    assert.match(text, /acceptance_derived=yes/);
    // The worker no longer enters awaiting itself: it asks the project session,
    // which answers or escalates E1-E5 to the human.
    assert.match(text, /add an agent question comment/);
    assert.match(text, /Do not enter awaiting/);
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
    assert.match(text, /do not move it to done yourself/);
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
    assert.match(text("human"), /a human accepts to done/);
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
    assert.match(text, /Never edit a card\.md/);
    assert.match(text, /This lane has no Write/);
    assert.doesNotMatch(text, /Put your process files|attachment download/);
    assert.match(text, /On resume, re-read \.meerkat\/T-2\/card\.md/);
  });

  it("is a reviewer subagent in the project session, with the claim already taken", () => {
    assert.match(text, /^You are a reviewer subagent of the <project id> project session/);
    assert.match(text, /already claimed this review card for you: do not claim it again/);
    assert.match(text, /heartbeat only this review card/);
  });

  it("checks review_not_ready before reading anything else", () => {
    assert.match(text, /review_not_ready/);
    assert.match(text, /taskctl issue get T-1 --json/);
    assert.match(text, /no longer in_review \/ the round changed/);
    assert.match(text, /Do not deliver a verdict/);
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
    assert.match(text, /Do not move\s+the card under review and do not move this review card/);
    assert.match(text, /the loop applies the verdict and\s+closes this card/);
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
      "comment:T-1:note",
      'meta:T-1:{"accepted_by":"loop-review","accepted_round":"1"}',
      "move:T-1:done",
      "comment:T-2:note",
      "move:T-2:done",
    ]);
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
      "comment:T-1",
      'meta:T-1:{"accepted_by":"loop-review","accepted_round":"1"}',
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
      "comment:T-1:change",
      'meta:T-1:{"rework_round":"2"}',
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
      "comment:E-1",
      "meta:E-1",
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

  it("cancels an in-review review card through in_progress, never done", async () => {
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
      }),
    );
    assert.deepEqual(order, [
      "comment:T-3:note",
      "move:T-3:in_progress",
      "move:T-3:canceled",
      "comment:T-4:note",
      "move:T-4:canceled",
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
// parseArgs — the wake surface the glue decision is built from
// ---------------------------------------------------------------------------

describe("parseArgs — the wake surface", () => {
  const ENV = { HOME: "/home/alice" };

  it("defaults the glue and the project map under the agent's dot-directory", () => {
    const opts = parseArgs(["--actor-kind", "codex", "--once"], ENV);
    assert.equal(opts.glue, "/home/alice/.codex/bin/wake-codex.sh");
    assert.equal(opts.projectsJson, "/home/alice/.codex/skills/meerkat-taskpanel/projects.json");
    assert.equal(opts.wakeCommand, null, "no override unless the operator asks for one");
  });

  it("accepts an explicit glue, map and wake command", () => {
    const opts = parseArgs(
      [
        "--actor-kind", "pi",
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
    assert.equal(loopCommandArgs(implicit).includes("--patrol-interval"), false);

    const explicit = parseArgs(["--home", "/tmp/home", "--patrol-interval", "300"], {});
    assert.equal(explicit.patrolIntervalExplicit, true);
    const args = loopCommandArgs(explicit);
    assert.ok(args.includes("--patrol-interval"), args.join(" "));
    assert.equal(args[args.indexOf("--patrol-interval") + 1], "300");
  });

  it("carries the resident settings the child passes re-read", () => {
    // The control turn's `passes.mjs poll` asks `poolStatus()` about the same
    // state file, so a moved one or `--resident=no` must travel in the prompt.
    const plain = loopCommandArgs(parseArgs(["--home", "/tmp/home"], {}));
    assert.equal(plain.includes("--resident"), false, "auto is the default");
    assert.equal(plain.includes("--session-state"), false, "the default path is derived");

    const noResident = loopCommandArgs(parseArgs(["--home", "/tmp/home", "--resident=no"], {}));
    assert.equal(noResident[noResident.indexOf("--resident") + 1], "no");

    const moved = loopCommandArgs(
      parseArgs(["--home", "/tmp/home", "--state", "/tmp/s.json", "--session-state", "/tmp/x/sessions.json"], {}),
    );
    assert.equal(moved[moved.indexOf("--session-state") + 1], "/tmp/x/sessions.json");

    const perProject = loopCommandArgs(
      parseArgs(["--home", "/tmp/home", "--max-concurrency", "8", "--project-concurrency", "3"], {}),
    );
    assert.equal(perProject[perProject.indexOf("--project-concurrency") + 1], "3");
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
    assert.equal(opts.reviewer, undefined);
    assert.equal(opts.workflowMaxActions, undefined);
    assert.equal(opts.recoverStale, undefined);
  });

  it("takes --recover-stale in both spellings", () => {
    assert.equal(parseArgs(["--recover-stale", "no", "--once"], ENV).recoverStale, "no");
    assert.equal(parseArgs(["--recover-stale=yes", "--once"], ENV).recoverStale, "yes");
  });

  it("takes every workflow flag in both spellings", () => {
    const spaced = parseArgs(
      ["--workflow", "no", "--reviewer", "jobs", "--workflow-max-actions", "5"],
      ENV,
    );
    assert.equal(spaced.workflow, "no");
    assert.equal(spaced.reviewer, "jobs");
    assert.equal(spaced.workflowMaxActions, "5");

    const joined = parseArgs(["--workflow=yes", "--reviewer=jobs", "--workflow-max-actions=9"], ENV);
    assert.equal(joined.workflow, "yes");
    assert.equal(joined.reviewer, "jobs");
    assert.equal(joined.workflowMaxActions, "9");
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
// Wiring sanity: the exported runner lives in the repo
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The wake wiring: the *resolved* glue is what a wake uses (R1, T-20261014-010025)
//
// `planWakeInvocation` is pure and is covered above — but every one of those cases
// *hands it* a `gluePath`. The defect lived one level out, in the I/O half that builds
// that argument: `spawnWorkerReal` read `opts.gluePath`, a field `parseArgs` never
// assigns (`opts.glue` is the resolved one), so the planner was handed `undefined`,
// `existsSync(undefined)` (DEP0187) returned false, and `glueInstalled` was always
// false. The glue was installed, named in the tick line, and still never used: R1's
// "the worker runs in the card's project target directory" had silently stopped
// happening. Both cases below fail on the pre-fix file and pass on the fixed one.
// ---------------------------------------------------------------------------

describe("spawnWorkerReal — the wake goes through the resolved glue (R1)", () => {
  const tempDirs = [];
  function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const RUNNERS_URL = new URL("../../scripts/loop/runners.mjs", import.meta.url);

  /** Write an executable stub script: shebang, `set -eu`, the given body, `exit 0`. */
  function stub(dir, name, body) {
    const path = join(dir, name);
    writeFileSync(path, ["#!/usr/bin/env bash", "set -eu", ...body, "exit 0", ""].join("\n"), "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  async function waitFor(predicate, ms = 5000) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() >= deadline) return predicate();
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** A marker's text so far — empty while it does not exist yet. */
  function readMarker(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }

  it("runs the installed glue — not the direct fallback — and hands it the project identity", async () => {
    const dir = tempDir("meerkat-wake-glue-");
    // Two mutually exclusive stubs, so the case reports *which* branch ran rather than
    // merely that something did. The `claude` stub goes first on PATH for the duration
    // of the call: the direct fallback must resolve to it, never to a real agent CLI.
    const glueMarker = join(dir, "glue.txt");
    const directMarker = join(dir, "direct.txt");
    const glue = stub(dir, "wake-claude.sh", [
      `printf 'argv=%s\\n' "$*" > "${glueMarker}"`,
      `printf 'project=%s\\n' "\${TP_PROJECT:-}" >> "${glueMarker}"`,
    ]);
    const bin = tempDir("meerkat-wake-bin-");
    stub(bin, "claude", [`printf 'direct\\n' > "${directMarker}"`]);

    const logs = [];
    const spawnWorker = spawnWorkerReal(
      { actorKind: "claude", repo: dir, glue, projectsJson: join(dir, "projects.json"), log: join(dir, "supervisor.log") },
      { wakeCommand: null },
      (line) => logs.push(line),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    let result;
    try {
      result = await spawnWorker(
        { identifier: "T-1", agent: "alice" },
        { identifier: "T-1", title: "wire the glue", project: "TaskPanel" },
      );
      // Wait for the *complete* record, not merely for the file to appear. The stub
      // writes `argv=` and `project=` as two separate opens, so a poll can land between
      // them and the reads below would see a half-written file — `existsSync` is true
      // from the first line on, which is exactly the race that made this case red under
      // load. The glue's last line is the completion signal.
      assert.ok(
        await waitFor(() => /^project=TaskPanel$/m.test(readMarker(glueMarker))),
        "the installed glue never ran to completion",
      );
    } finally {
      process.env.PATH = originalPath;
    }

    assert.equal(result.ok, true, result.error);
    assert.equal(existsSync(directMarker), false, "the direct fallback ran despite an installed glue");
    const recorded = readFileSync(glueMarker, "utf8");
    assert.match(recorded, /T-1/, "the glue is handed the handoff that names the card");
    assert.match(recorded, /^project=TaskPanel$/m, "the identity the glue resolves the directory from must ride along");
    // The silent half of the defect: the fallback announces itself, so a glue that
    // exists and is still not used must never look like an ordinary wake.
    assert.deepEqual(logs.filter((line) => /no wake glue/.test(line)), []);
  });

  it("hands a review card the reviewer handoff, not the worker handoff", async () => {
    const dir = tempDir("meerkat-wake-review-");
    const marker = join(dir, "prompt.txt");
    const glue = stub(dir, "wake-claude.sh", [`printf '%s' "$*" > "${marker}"`]);
    const spawnWorker = spawnWorkerReal(
      { actorKind: "claude", repo: dir, glue, projectsJson: join(dir, "projects.json"), log: join(dir, "supervisor.log") },
      { wakeCommand: null, reviewer: "jobs", reviewerIsWorker: false },
      () => {},
    );

    const originalPath = process.env.PATH;
    // An empty PATH would make a regression to the direct branch fail loudly rather
    // than reach a real agent CLI; the glue path is absolute, so it still runs.
    process.env.PATH = `${tempDir("meerkat-wake-review-bin-")}:${originalPath}`;
    let result;
    try {
      result = await spawnWorker(
        { identifier: "T-2", agent: "jobs" },
        { identifier: "T-2", review_of: "T-1", review_round: 1, project: "P1" },
      );
      assert.ok(await waitFor(() => readMarker(marker).includes("review_not_ready")));
    } finally {
      process.env.PATH = originalPath;
    }

    assert.equal(result.ok, true, result.error);
    const recorded = readFileSync(marker, "utf8");
    assert.match(recorded, /Card under review: T-1 \(round 1\)/);
    assert.doesNotMatch(recorded, /Step 0 — before working/, "a reviewer is not told to split the card");
  });

  it("names the configured glue, and probes no undefined path (DEP0187)", () => {
    // In a child process: a deprecation warning is emitted once per process, so a fresh
    // one is what turns its absence into a fact instead of a leftover. PATH is emptied
    // so a regression to the direct branch cannot reach a real agent CLI — this case
    // only observes what the glue decision was handed.
    const dir = tempDir("meerkat-wake-probe-");
    const missing = join(dir, "definitely-not-installed.sh");
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      [
        `import { spawnWorkerReal } from ${JSON.stringify(RUNNERS_URL.href)};`,
        "const logs = [];",
        "const spawnWorker = spawnWorkerReal(",
        `  { actorKind: "claude", repo: ${JSON.stringify(dir)}, glue: ${JSON.stringify(missing)}, projectsJson: ${JSON.stringify(join(dir, "map.json"))}, log: ${JSON.stringify(join(dir, "supervisor.log"))} },`,
        "  { wakeCommand: null },",
        "  (line) => logs.push(line),",
        ");",
        'spawnWorker({ identifier: "T-9", agent: "alice" }, { identifier: "T-9", project: "P1" }).then((result) => {',
        '  process.stdout.write(JSON.stringify({ ok: result.ok, logs }) + "\\n");',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const emptyBin = tempDir("meerkat-wake-emptybin-");
    const run = spawnSync(process.execPath, [probe], { encoding: "utf8", env: { ...process.env, PATH: emptyBin } });

    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /DEP0187/, "must not probe existsSync() with a non-path");
    const { logs } = JSON.parse(run.stdout.trim().split("\n").pop());
    const warning = logs.find((line) => /no wake glue/.test(line));
    assert.ok(warning, "a missing glue must still be announced");
    assert.ok(warning.includes(missing), `the warning must name the configured glue, got: ${warning}`);
    assert.ok(!warning.includes("(unset)"), "an unassigned opts field made the warning name '(unset)' instead");
  });
});

// ---------------------------------------------------------------------------
// The glue's directory resolver: `wake-cwd.mjs`
//
// The map has three answers and the *wake* can only use two of them: a project
// absent from `projects.json` is unmapped (ask the user), and an entry that
// exists but names no directory is a complete answer for the map — a project may
// legitimately keep nothing on disk — but it is still no answer for a worker,
// which has to be started somewhere. Both refuse the wake, and they refuse it
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
  const SUPERVISOR_URL = new URL("../../scripts/supervisor.mjs", import.meta.url);
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
      [new URL("../../scripts/loop/options.mjs", import.meta.url), ["parseArgs", "selectMode"]],
      [new URL("../../scripts/loop/runtime.mjs", import.meta.url), ["loadRegistry", "saveRegistry", "runPingTick", "subscribeStatePath", "loadSubscribeState", "saveSubscribeState"]],
      [new URL("../../scripts/loop/runners.mjs", import.meta.url), ["runPollTick", "runPatrolTick", "spawnWorkerReal"]],
      [new URL("../../scripts/loop/subscribe.mjs", import.meta.url), ["runSubscribe", "createDispatchScheduler"]],
      [new URL("../../scripts/loop/status.mjs", import.meta.url), ["probeSupervisor", "probeUnits", "takeOver", "stopSupervisor"]],
      [new URL("../../scripts/loop/console.mjs", import.meta.url), ["consoleCycle"]],
      [new URL("../../src/foundation/scheduling.mjs", import.meta.url), ["buildContinuePrompt", "planContinueInvocation", "planWakeInvocation"]],
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

  it("maps the deprecated --poll-interval onto the ping clock", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--poll-interval", "45"], ENV);
    assert.equal(opts.pingInterval, 45);
    assert.equal(opts.legacyPollInterval, true);
  });

  it("places the continue lock beside the state file, never inside it", () => {
    const opts = parseArgs(["--actor-kind", "claude", "--state", "/tmp/state.json"], ENV);
    assert.equal(opts.continueState, "/tmp/continue.state.json");
    assert.notEqual(opts.continueState, opts.state);
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
    assert.equal(opts.sessionTurnTimeoutMs, 30 * 60 * 1000);
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
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "meerkat-taskpanel.env"), "MEERKAT_TASKPANEL_MAX_CONCURRENCY=4\n");
      const fromFile = parseArgs(["--actor-kind", "claude", "--home", dir], {});
      assert.equal(fromFile.maxConcurrency, 4);

      const envWins = parseArgs(["--actor-kind", "claude", "--home", dir], {
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

  it("keeps zero as 'claim nothing'", () => {
    assert.equal(parseArgs(["--actor-kind", "claude", "--max-concurrency", "0"], ENV).maxConcurrency, 0);
  });

  it("carries the resolved cap into the child poll even when it equals the default", () => {
    // The parent resolved 8 (the flag beats the env); the child must be told 8
    // rather than re-reading the environment and resolving 5.
    const args = loopCommandArgs(
      parseArgs(["--actor-kind", "claude", "--max-concurrency", "8"], {
        ...ENV,
        MEERKAT_TASKPANEL_MAX_CONCURRENCY: "5",
      }),
    );
    assert.equal(args[args.indexOf("--max-concurrency") + 1], "8");

    const fromEnv = loopCommandArgs(
      parseArgs(["--actor-kind", "claude"], { ...ENV, MEERKAT_TASKPANEL_MAX_CONCURRENCY: "5" }),
    );
    assert.equal(fromEnv[fromEnv.indexOf("--max-concurrency") + 1], "5");
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
    acceptance: [{ text: "the thing works", status: "met" }],
    evidence: [{ kind: "commit", sha: "abc1234" }],
  };
  const VERDICT = {
    conclusion: "VERDICT: APPROVE",
    acceptance: [{ text: "the evidence matches", status: "met" }],
    evidence: [{ kind: "path", path: "src/thing.mjs" }],
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
        acceptanceMode: "agent",
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
        `comment:${original.identifier}:note`,
        `meta:${original.identifier}`,
        `move:${original.identifier}:done`,
        `comment:${review.identifier}:note`,
        `move:${review.identifier}:done`,
      ]);
      assert.equal(result.executed, 1);
      assert.equal(result.failed, 0);
    });
  });
});

describe("parseArgs — the team scan set and roles root", () => {
  it("takes MEERKAT_TASKPANEL_AGENTS from the environment", () => {
    const opts = parseArgs(
      ["--actor-kind", "claude", "--home", "/tmp/tp-team-home"],
      { HOME: "/tmp/tp-team-home", MEERKAT_TASKPANEL_AGENTS: "Jobs, Linus turing" },
    );
    assert.deepEqual(opts.agents, ["Jobs", "Linus", "turing"]);
  });

  it("takes the list from the agent config, and the environment still wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-team-"));
    try {
      const config = join(dir, "meerkat-taskpanel.env");
      writeFileSync(config, "MEERKAT_TASKPANEL_AGENTS=Jobs,Linus\n", "utf8");
      const fromFile = parseArgs(
        ["--actor-kind", "claude", "--home", dir, "--config", config],
        { HOME: dir },
      );
      assert.deepEqual(fromFile.agents, ["Jobs", "Linus"]);
      const fromEnv = parseArgs(
        ["--actor-kind", "claude", "--home", dir, "--config", config],
        { HOME: dir, MEERKAT_TASKPANEL_AGENTS: "Turing" },
      );
      assert.deepEqual(fromEnv.agents, ["Turing"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps explicit --agent flags above the configured list", () => {
    const opts = parseArgs(
      ["--actor-kind", "claude", "--home", "/h", "--agent", "alice"],
      { MEERKAT_TASKPANEL_AGENTS: "Jobs,Linus" },
    );
    assert.deepEqual(opts.agents, ["alice"]);
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

  it("exposes the loop-skill and body roles paths for every actor kind", () => {
    const paths = agentPaths("/home/alice", "pi");
    assert.equal(paths.loopRoles, "/home/alice/.agents/skills/meerkat-loop/roles");
    assert.equal(paths.bodyRoles, "/home/alice/.agents/meerkat-taskpanel/roles");
    assert.equal(agentPaths("/home/alice", "opencode").loopRoles, "/home/alice/.config/opencode/skills/meerkat-loop/roles");
  });
});
