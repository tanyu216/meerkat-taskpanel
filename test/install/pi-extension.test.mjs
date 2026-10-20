/**
 * The Pi extension's session-start check.
 *
 * Pi is not installed here, so the host integration cannot be run. The
 * extension's own logic is plain JavaScript with no host dependency, so this
 * drives it against a fake `pi` and pins the callback surface: skill discovery
 * still works, and the per-repo issue-tracker check is injected once per
 * session (and again after a compaction), never twice.
 *
 * Run with: `node --test`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { register } from "../../.pi/extensions/meerkat-taskpanel-core.mjs";
import { CHECK_MARKER } from "../../src/foundation/session-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A fake `pi` that records every registered handler. */
function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on: (name, fn) => handlers.set(name, fn),
  };
}

function hasMarker(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((part) => typeof part?.text === "string" && part.text.includes(CHECK_MARKER));
}

describe("pi extension — discovery", () => {
  it("still registers the repository's skills directory", async () => {
    const pi = fakePi();
    register(pi);

    const result = await pi.handlers.get("resources_discover")();
    assert.deepEqual(result, { skillPaths: [join(ROOT, "skills")] });
  });
});

describe("pi extension — the issue-tracker check", () => {
  it("injects the shared instruction once a session has started", async () => {
    const pi = fakePi();
    register(pi);

    await pi.handlers.get("session_start")();
    const result = await pi.handlers.get("context")({ messages: [] });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, "user");
    assert.ok(hasMarker(result.messages[0]), JSON.stringify(result.messages));
  });

  it("does nothing before a session starts", async () => {
    const pi = fakePi();
    register(pi);

    const result = await pi.handlers.get("context")({ messages: [] });
    assert.equal(result, undefined);
  });

  it("does not inject a second copy when the session already carries the marker", async () => {
    const pi = fakePi();
    register(pi);

    await pi.handlers.get("session_start")();
    const result = await pi.handlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: `${CHECK_MARKER}\nbody` }] }],
    });
    assert.equal(result, undefined);
  });

  it("injects again after a compaction, but never twice in one pass", async () => {
    const pi = fakePi();
    register(pi);

    await pi.handlers.get("session_start")();
    await pi.handlers.get("session_compact")();

    const once = await pi.handlers.get("context")({ messages: [] });
    const twice = await pi.handlers.get("context")({ messages: once.messages });
    assert.ok(hasMarker(once.messages[0]));
    assert.equal(twice, undefined, "the marker is the dedupe key");
  });

  it("stops injecting after the agent ends", async () => {
    const pi = fakePi();
    register(pi);

    await pi.handlers.get("session_start")();
    await pi.handlers.get("agent_end")();
    assert.equal(await pi.handlers.get("context")({ messages: [] }), undefined);
  });

  it("never lets a malformed event throw", async () => {
    const pi = fakePi();
    register(pi);
    await pi.handlers.get("session_start")();

    await pi.handlers.get("context")(undefined);
    await pi.handlers.get("context")({ messages: "nope" });
    assert.ok(true, "the hook must stay contained");
  });
});

describe("pi extension — the entry point", () => {
  it("delegates to the testable core", () => {
    const entry = readFileSync(join(ROOT, ".pi", "extensions", "meerkat-taskpanel.ts"), "utf8");
    assert.match(entry, /meerkat-taskpanel-core\.mjs/, "the .ts must import the core");
    assert.match(entry, /register\(pi\)/, "the .ts must call register");
  });
});
