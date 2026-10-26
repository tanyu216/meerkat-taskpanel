/**
 * The loop's hub registration, without a socket.
 *
 * The wire shape is the contract between `src/orchestrator/card-watch.mjs` and
 * `src/cli/hub/server.mjs#handleWatch`: per-card refs + exact files, `ttl_ms: 0`
 * (terminal, not a timer), detached. The hub's own multi-card protocol is
 * exercised in `test/hub/server.test.mjs`; these legs pin what the loop sends
 * and how it reads the answer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  briefCards,
  openCardWatch,
  registerCardWatch,
  stopCardWatch,
} from "../../src/orchestrator/card-watch.mjs";

const OPTS = {
  url: null,
  token: "td_token",
  envFile: "/tmp/agent.env",
  actorKind: "claude",
  agents: ["alice"],
  cli: "/runtime/src/cli/index.mjs",
};

const HUB = { pointer: { port: 4321, token: "hub-token" }, token: "hub-token", url: "http://127.0.0.1:9527" };

describe("orchestrator/card-watch — the request", () => {
  it("builds the card-and-original paths under one target directory", () => {
    assert.deepEqual(briefCards("/work", "PROJ-0002"), [
      { ref: "PROJ-0002", out: "/work/.meerkat/PROJ-0002/card.md" },
    ]);
    assert.deepEqual(briefCards("/work", "PROJ-0002", "PROJ-0001"), [
      { ref: "PROJ-0002", out: "/work/.meerkat/PROJ-0002/card.md" },
      { ref: "PROJ-0001", out: "/work/.meerkat/PROJ-0001/card.md" },
    ]);
  });

  it("registers per-card paths, detached and without a TTL", async () => {
    const calls = [];
    const answer = await registerCardWatch(
      OPTS,
      [
        { ref: "PROJ-0002", out: "/work/.meerkat/PROJ-0002/card.md" },
        { ref: "PROJ-0001", out: "/work/.meerkat/PROJ-0001/card.md" },
      ],
      {
        hub: HUB,
        owner: "claude:alice",
        hubCall: async (pointer, token, payload, options) => {
          calls.push({ pointer, token, payload, options });
          return {
            type: "registered",
            registration_id: "reg-1",
            running: true,
            cards: [
              { ref: "PROJ-0002", path: "/work/.meerkat/PROJ-0002/card.md" },
              { ref: "PROJ-0001", path: "/work/.meerkat/PROJ-0001/card.md" },
            ],
          };
        },
      },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].pointer, HUB.pointer);
    assert.equal(calls[0].token, "hub-token");
    assert.deepEqual(calls[0].payload, {
      op: "watch",
      cards: [
        { ref: "PROJ-0002", out: "/work/.meerkat/PROJ-0002/card.md" },
        { ref: "PROJ-0001", out: "/work/.meerkat/PROJ-0001/card.md" },
      ],
      ttl_ms: 0,
      detach: true,
      owner: "claude:alice",
    });
    assert.equal(typeof calls[0].options.match, "function");
    assert.deepEqual(answer, {
      ok: true,
      running: true,
      reason: null,
      registrationId: "reg-1",
      cards: [
        { ref: "PROJ-0002", path: "/work/.meerkat/PROJ-0002/card.md" },
        { ref: "PROJ-0001", path: "/work/.meerkat/PROJ-0001/card.md" },
      ],
    });
  });

  it("reports a terminal registration without pretending to be running", async () => {
    const answer = await registerCardWatch(OPTS, [{ ref: "PROJ-0003", out: "/work/x.md" }], {
      hub: HUB,
      hubCall: async () => ({
        type: "registered",
        registration_id: null,
        running: false,
        reason: "terminal",
        cards: [{ ref: "PROJ-0003", path: "/work/x.md" }],
      }),
    });
    assert.equal(answer.ok, true);
    assert.equal(answer.running, false);
    assert.equal(answer.reason, "terminal");
  });

  it("turns a hub error record and a thrown failure into ok:false, never a throw", async () => {
    const refused = await registerCardWatch(OPTS, [{ ref: "PROJ-0004", out: "/work/x.md" }], {
      hub: HUB,
      hubCall: async () => ({ op: "error", ok: false, error: { code: "CLI_IO", message: "no board" } }),
    });
    assert.deepEqual(refused, { ok: false, error: "no board" });

    const thrown = await registerCardWatch(OPTS, [{ ref: "PROJ-0004", out: "/work/x.md" }], {
      hub: HUB,
      hubCall: async () => {
        throw new Error("socket closed");
      },
    });
    assert.deepEqual(thrown, { ok: false, error: "socket closed" });

    assert.deepEqual(await registerCardWatch(OPTS, [], { hub: HUB }), {
      ok: false,
      error: "a watch needs at least one card",
    });
  });

  it("stops by one path and reports whether the registration was found", async () => {
    const calls = [];
    const answer = await stopCardWatch(OPTS, { ref: "PROJ-0002", out: "/work/x.md" }, {
      hub: HUB,
      hubCall: async (pointer, token, payload) => {
        calls.push(payload);
        return { op: "watch-stop", ok: true, stopped: true };
      },
    });
    assert.deepEqual(calls[0], { op: "watch-stop", ref: "PROJ-0002", out: "/work/x.md" });
    assert.deepEqual(answer, { ok: true, stopped: true });
  });
});

describe("orchestrator/card-watch — the hub context", () => {
  it("resolves the board through transport/session and starts the hub with the loop's CLI", async () => {
    const seen = {};
    const hub = await openCardWatch(OPTS, {
      env: { TASKD_URL: "http://127.0.0.1:1" },
      cwd: "/work",
      createSession: (input) => {
        seen.session = input;
        return { token: "resolved-token", env: {}, identity: { actor: { kind: "claude", id: "alice" } }, pointerOptions: {} };
      },
      connect: async (session, input) => {
        seen.connect = { session, input };
        return { url: "http://127.0.0.1:9527" };
      },
      ensure: async (input) => {
        seen.ensure = input;
        return { pointer: { port: 9, token: "hub-token" } };
      },
    });

    assert.equal(seen.session.flags.actorKind, "claude");
    assert.equal(seen.session.flags.agent, "alice");
    assert.equal(seen.connect.input.flags.url, null);
    assert.equal(seen.ensure.url, "http://127.0.0.1:9527");
    assert.equal(seen.ensure.token, "resolved-token");
    assert.equal(seen.ensure.entry, "/runtime/src/cli/index.mjs");
    assert.deepEqual(hub, { pointer: { port: 9, token: "hub-token" }, token: "hub-token", url: "http://127.0.0.1:9527" });
  });
});
