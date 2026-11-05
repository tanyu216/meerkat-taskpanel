/**
 * Turn-timeout classification: a timeout is a transient failure, not a card
 * failure. The predicate is the only thing that decides; the queue, the pool and
 * the hold path all read it.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTurnTimeoutError } from "../../src/orchestrator/turn-errors.mjs";

describe("turn errors — transient or real", () => {
  it("recognises a turn timeout, bare or wrapped", () => {
    assert.equal(isTurnTimeoutError("turn timed out after 1800000ms"), true);
    assert.equal(isTurnTimeoutError("turn timed out after 60000ms"), true);
    assert.equal(
      isTurnTimeoutError("review session resume/replay failed: turn timed out after 60000ms"),
      true,
      "the pool wraps the adapter's text; the predicate reads the substring",
    );
    assert.equal(
      isTurnTimeoutError(new Error("worker session resume/replay failed: turn timed out after 60000ms")),
      true,
      "an Error is stringified before matching",
    );
  });

  it("recognises the clean exit an interrupted turn leaves behind", () => {
    assert.equal(isTurnTimeoutError("claude exited (code=0, signal=null)"), true);
    assert.equal(isTurnTimeoutError("codex app-server exited (code=0, signal=null)"), true);
    assert.equal(isTurnTimeoutError("pi exited (code=0, signal=null)"), true);
    assert.equal(
      isTurnTimeoutError("session: card T-1 failed: claude exited (code=0, signal=null)"),
      true,
      "the phrase may be embedded in a larger message",
    );
  });

  it("never classifies a real failure as transient", () => {
    for (const value of [
      "code=1",
      "boom",
      "spawn error: ENOENT",
      "claude exited (code=1, signal=null)",
      "pi exited (code=0, signal=SIGKILL)",
      "session is closed",
      "a turn is already in flight",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(isTurnTimeoutError(value), false, `${JSON.stringify(value)} is a real failure`);
    }
  });
});
