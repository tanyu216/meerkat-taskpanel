/**
 * The scheduler's continue turn — the pure half.
 *
 * The loop's deterministic entries (poll/patrol/workflow) are no longer their
 * own scheduling units. A low-frequency "Continue" wake runs them instead, so the
 * prompt is load-bearing: it must name the entries by absolute path, run them
 * in the order that lets a fresh review card be claimed in the same turn, and
 * carry the board rules a headless agent kind cannot infer.
 *
 * These tests pin the prompt's contract and the invocation shape. The process
 * spawn, the lock and the registry pruning are covered by
 * `test/scheduling/loop-entries.test.mjs`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CONTINUE_SECONDS,
  DEFAULT_PING_SECONDS,
  buildContinuePrompt,
  planContinueInvocation,
  quoteArg,
  resolveContinueEnabled,
  resolveIntervalSeconds,
} from "../../src/foundation/scheduling.mjs";

describe("resolveContinueEnabled", () => {
  it("defaults to on", () => {
    assert.equal(resolveContinueEnabled({}), true);
  });

  it("takes flag > env > config > default", () => {
    assert.equal(resolveContinueEnabled({ flag: "no" }), false);
    assert.equal(resolveContinueEnabled({ flag: "yes", env: "no" }), true);
    assert.equal(
      resolveContinueEnabled({ env: "no", file: { MEERKAT_TASKPANEL_CONTINUE: "yes" } }),
      false,
    );
    assert.equal(
      resolveContinueEnabled({ file: { MEERKAT_TASKPANEL_CONTINUE: "no" } }),
      false,
    );
  });

  it("ignores an unrecognised word rather than flipping the default", () => {
    assert.equal(resolveContinueEnabled({ flag: "maybe" }), true);
    assert.equal(resolveContinueEnabled({ flag: "maybe", env: "no" }), false);
  });
});

describe("resolveIntervalSeconds", () => {
  it("takes the first positive integer and otherwise falls back", () => {
    assert.equal(resolveIntervalSeconds({ fallback: 60 }), 60);
    assert.equal(resolveIntervalSeconds({ flag: 90, fallback: 60 }), 90);
    assert.equal(resolveIntervalSeconds({ flag: "90", fallback: 60 }), 90);
    assert.equal(resolveIntervalSeconds({ flag: "nope", env: "120", fallback: 60 }), 120);
    assert.equal(resolveIntervalSeconds({ flag: "0", env: "-1", fallback: 60 }), 60);
    assert.equal(resolveIntervalSeconds({ file: "600", fallback: 60 }), 600);
    assert.equal(resolveIntervalSeconds({ file: "600", env: "120", fallback: 60 }), 120);
  });
});

describe("quoteArg", () => {
  it("leaves a plain path alone and single-quotes one with a space", () => {
    assert.equal(quoteArg("/tmp/loop/poll.mjs"), "/tmp/loop/poll.mjs");
    assert.equal(quoteArg("/tmp/my loop/poll.mjs"), "'/tmp/my loop/poll.mjs'");
    assert.equal(quoteArg("it's"), "'it'\\''s'");
  });
});

describe("buildContinuePrompt", () => {
  const passesScript = "/opt/loop/scripts/loop/passes.mjs";
  const prompt = buildContinuePrompt({
    actorKind: "claude",
    agent: "alice",
    nodePath: "/opt/node/bin/node",
    passesScript,
    commonArgs: ["--actor-kind", "claude", "--agent", "alice"],
    continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
  });

  it("starts with the command-only loop skill, then the continue cue", () => {
    assert.ok(prompt.startsWith("/meerkat-loop "), prompt.slice(0, 48));
    assert.match(prompt, /^\/meerkat-loop Continue\b/);
  });

  it("names every deterministic pass by absolute path", () => {
    for (const pass of ["patrol", "workflow", "poll"]) {
      assert.ok(prompt.includes(`${passesScript} ${pass}`), `missing ${pass}`);
    }
  });

  it("runs patrol, then workflow, then poll", () => {
    const patrol = prompt.indexOf(`${passesScript} patrol`);
    const workflow = prompt.indexOf(`${passesScript} workflow`);
    const poll = prompt.indexOf(`${passesScript} poll`);
    assert.ok(patrol !== -1 && workflow !== -1 && poll !== -1);
    assert.ok(patrol < workflow && workflow < poll, "a dispatched review must be claimable this turn");
  });

  it("names no card, no project and no session", () => {
    assert.doesNotMatch(prompt, /--project\b/);
    assert.doesNotMatch(prompt, /TP_PROJECT/);
    assert.doesNotMatch(prompt, /--resume\b/);
  });

  it("states the acceptance boundary and keeps poll to claim-and-enqueue", () => {
    assert.match(prompt, /Never move a card to done/);
    assert.match(prompt, /reviewer moves nothing/i);
    assert.match(prompt, /Stop work at in_review/);
    // The resident model: the control turn hands off; it never spawns or works.
    assert.match(prompt, /Poll only claims and enqueues/);
    assert.match(prompt, /never spawns a worker or reviewer/);
    assert.match(prompt, /spawns the subagent in the\s+project directory/);
    assert.doesNotMatch(prompt, /wake a worker/);
    assert.doesNotMatch(prompt, /claim a ready card yourself/);
  });

  it("carries the question channel, and escalates where the loop was opened (0034)", () => {
    // Both origins get the same mechanics: read awaiting cards, answer with a
    // note + explicit move, never write a human decision.
    for (const text of [prompt]) {
      assert.match(text, /Waiting questions/);
      assert.match(text, /issue list --status awaiting/);
      assert.match(text, /comment list <ref> --kind question/);
      assert.match(text, /comment add <ref> --kind note/);
      assert.match(text, /issue move <ref> todo/);
      assert.match(text, /note does NOT auto-resume/);
      assert.match(text, /Never write decision\/confirm\/change/);
      assert.match(text, /Any human comment after the question is an answer/);
    }
    // The default origin is a supervisor: an unanswerable question stays on the
    // board for a human's decision comment.
    assert.match(prompt, /leave the card awaiting/);
    assert.match(prompt, /board re-queues it automatically/);
    assert.doesNotMatch(prompt, /ask the human in this conversation/);

    const openedByHuman = buildContinuePrompt({
      host: "claude",
      agent: "alice",
      nodePath: "/opt/node/bin/node",
      passesScript,
      commonArgs: [],
      continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
      openedBy: "human",
    });
    assert.match(openedByHuman, /ask the human in this conversation/);
    assert.doesNotMatch(openedByHuman, /board re-queues it automatically/);
  });

  it("stays bounded", () => {
    assert.ok(prompt.length < 6000, `prompt is ${prompt.length} chars`);
  });

  it("quotes a passes path that contains a space", () => {
    const spaced = buildContinuePrompt({
      actorKind: "claude",
      agent: "alice",
      nodePath: "/opt/node/bin/node",
      commonArgs: [],
      continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
      passesScript: "/tmp/my loop/passes.mjs",
    });
    assert.ok(spaced.includes("'/tmp/my loop/passes.mjs' poll"));
  });

  it("omits poll entirely when no resident pool is running", () => {
    const fallback = buildContinuePrompt({
      actorKind: "claude",
      agent: "alice",
      nodePath: "/opt/node/bin/node",
      passesScript,
      commonArgs: [],
      continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
      includePoll: false,
    });
    assert.ok(fallback.startsWith("/meerkat-loop "), "the command prefix survives the fallback");
    // The fallback still runs the two passes it can run…
    assert.ok(fallback.includes(`${passesScript} patrol`));
    assert.ok(fallback.includes(`${passesScript} workflow`));
    // …and never names the poll entry.
    assert.ok(!fallback.includes(`${passesScript} poll`), "poll must not be named");
    assert.match(fallback, /claims no card/);
    assert.match(fallback, /dispatch is paused/);
    assert.match(fallback, /review cards accumulate/);
    assert.ok(fallback.length < prompt.length, "the fallback is the shorter turn");
  });

  it("carries the prefix into every agent kind's headless form", () => {
    for (const actorKind of ["claude", "codex", "pi", "opencode", "cursor"]) {
      const p = buildContinuePrompt({
        actorKind,
        agent: "alice",
        passesScript,
        commonArgs: [],
        continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
      });
      const plan = planContinueInvocation({ actorKind, prompt: p });
      assert.ok(
        String(plan.args.at(-1)).startsWith("/meerkat-loop "),
        `${actorKind}: ${plan.args.join(" ")}`,
      );
    }
  });
});

describe("planContinueInvocation", () => {
  it("takes the agent kind's built-in headless form, not the glue", () => {
    const plan = planContinueInvocation({ actorKind: "claude", prompt: "Continue", cwd: "/repo", nodePath: "/opt/node" });
    assert.deepEqual(plan, {
      command: "claude",
      args: ["-p", "Continue"],
      env: { TP_NODE: "/opt/node" },
      cwd: "/repo",
      via: "direct",
    });
    assert.equal(plan.warning, undefined);
  });

  for (const [actorKind, command, args] of [
    ["codex", "codex", ["exec", "Continue"]],
    ["pi", "pi", ["--print", "Continue"]],
    ["opencode", "opencode", ["run", "Continue"]],
    ["cursor", "cursor-agent", ["-p", "Continue"]],
  ]) {
    it(`uses ${command} for ${actorKind}`, () => {
      const plan = planContinueInvocation({ actorKind, prompt: "Continue", cwd: "/repo" });
      assert.equal(plan.command, command);
      assert.deepEqual(plan.args, args);
      assert.deepEqual(plan.env, {});
    });
  }

  it("never carries a project identity", () => {
    const plan = planContinueInvocation({ actorKind: "claude", prompt: "Continue", cwd: "/repo" });
    assert.equal(plan.env.TP_PROJECT, undefined);
    assert.equal(plan.env.TP_PROJECTS_JSON, undefined);
  });

  it("rejects an actor kind it does not wire", () => {
    assert.throws(() => planContinueInvocation({ actorKind: "openclaw", prompt: "Continue" }), /unknown agent kind/);
  });
});

describe("cadence defaults", () => {
  it("pings every minute and continues every ten", () => {
    assert.equal(DEFAULT_PING_SECONDS, 60);
    assert.equal(DEFAULT_CONTINUE_SECONDS, 600);
  });
});
