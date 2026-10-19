/**
 * The scheduler's continue turn — the pure half.
 *
 * The loop's deterministic entries (poll/patrol/workflow) are no longer their
 * own scheduling units. A low-frequency "继续" wake runs them instead, so the
 * prompt is load-bearing: it must name the entries by absolute path, run them
 * in the order that lets a fresh review card be claimed in the same turn, and
 * carry the board rules a headless host cannot infer.
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
} from "../../src/shared/scheduling.mjs";

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
  const scripts = {
    poll: "/opt/loop/scripts/loop/poll.mjs",
    patrol: "/opt/loop/scripts/loop/patrol.mjs",
    workflow: "/opt/loop/scripts/loop/workflow.mjs",
  };
  const prompt = buildContinuePrompt({
    host: "claude",
    agent: "alice",
    nodePath: "/opt/node/bin/node",
    scripts,
    commonArgs: ["--host", "claude", "--agent", "alice"],
    continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
  });

  it("starts with the continue cue", () => {
    assert.ok(prompt.startsWith("继续"), prompt.slice(0, 40));
  });

  it("names every deterministic entry by absolute path", () => {
    for (const script of Object.values(scripts)) {
      assert.ok(prompt.includes(script), `missing ${script}`);
    }
  });

  it("runs patrol, then workflow, then poll", () => {
    const patrol = prompt.indexOf(scripts.patrol);
    const workflow = prompt.indexOf(scripts.workflow);
    const poll = prompt.indexOf(scripts.poll);
    assert.ok(patrol !== -1 && workflow !== -1 && poll !== -1);
    assert.ok(patrol < workflow && workflow < poll, "a dispatched review must be claimable this turn");
  });

  it("names no card, no project and no session", () => {
    assert.doesNotMatch(prompt, /--project\b/);
    assert.doesNotMatch(prompt, /TP_PROJECT/);
    assert.doesNotMatch(prompt, /--resume\b/);
  });

  it("states the acceptance boundary and the claim permission", () => {
    assert.match(prompt, /Never move a card to done/);
    assert.match(prompt, /reviewer moves nothing/i);
    assert.match(prompt, /Stop work at in_review/);
    assert.match(prompt, /may claim a ready card yourself/);
  });

  it("stays bounded", () => {
    assert.ok(prompt.length < 6000, `prompt is ${prompt.length} chars`);
  });

  it("quotes an entry path that contains a space", () => {
    const spaced = buildContinuePrompt({
      ...{
        host: "claude",
        agent: "alice",
        nodePath: "/opt/node/bin/node",
        commonArgs: [],
        continueIntervalSeconds: DEFAULT_CONTINUE_SECONDS,
      },
      scripts: {
        poll: "/tmp/my loop/poll.mjs",
        patrol: "/tmp/my loop/patrol.mjs",
        workflow: "/tmp/my loop/workflow.mjs",
      },
    });
    assert.ok(spaced.includes("'/tmp/my loop/poll.mjs'"));
  });
});

describe("planContinueInvocation", () => {
  it("takes the host's built-in headless form, not the glue", () => {
    const plan = planContinueInvocation({ host: "claude", prompt: "继续", cwd: "/repo", nodePath: "/opt/node" });
    assert.deepEqual(plan, {
      command: "claude",
      args: ["-p", "继续"],
      env: { TP_NODE: "/opt/node" },
      cwd: "/repo",
      via: "direct",
    });
    assert.equal(plan.warning, undefined);
  });

  for (const [host, command, args] of [
    ["codex", "codex", ["exec", "继续"]],
    ["pi", "pi", ["--print", "继续"]],
  ]) {
    it(`uses ${command} for ${host}`, () => {
      const plan = planContinueInvocation({ host, prompt: "继续", cwd: "/repo" });
      assert.equal(plan.command, command);
      assert.deepEqual(plan.args, args);
      assert.deepEqual(plan.env, {});
    });
  }

  it("never carries a project identity", () => {
    const plan = planContinueInvocation({ host: "claude", prompt: "继续", cwd: "/repo" });
    assert.equal(plan.env.TP_PROJECT, undefined);
    assert.equal(plan.env.TP_PROJECTS_JSON, undefined);
  });

  it("rejects a host it does not wire", () => {
    assert.throws(() => planContinueInvocation({ host: "openclaw", prompt: "继续" }), /unknown host/);
  });
});

describe("cadence defaults", () => {
  it("pings every minute and continues every ten", () => {
    assert.equal(DEFAULT_PING_SECONDS, 60);
    assert.equal(DEFAULT_CONTINUE_SECONDS, 600);
  });
});
