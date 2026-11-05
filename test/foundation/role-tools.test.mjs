/**
 * The lane → tools table: one source for the session adapters and the installer.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LANE_TOOLS,
  TOOL_LANES,
  claudeAllowedTools,
  nativeAgentTools,
  piAllowedTools,
} from "../../src/foundation/role-tools.mjs";

describe("lane tools", () => {
  it("pins the lanes and their exact strings per kind", () => {
    assert.deepEqual(TOOL_LANES, ["director", "reviewer", "worker"]);

    assert.equal(
      claudeAllowedTools("director"),
      "Read,Grep,Glob,Bash(taskctl *),Bash(node *)",
    );
    assert.equal(
      claudeAllowedTools("reviewer"),
      "Read,Grep,Glob,Bash(taskctl *),Bash(git *),Bash(npm run *),Bash(node *),Bash(bash *)",
    );
    assert.equal(
      claudeAllowedTools("worker"),
      "Read,Edit,Write,Grep,Glob,Bash(taskctl *),Bash(node *),Bash(git *)",
    );

    assert.equal(piAllowedTools("director"), "read,bash");
    assert.equal(piAllowedTools("reviewer"), "read,bash");
    assert.equal(piAllowedTools("worker"), "read,bash,edit,write");
  });

  it("renders a native agent's tools by kind", () => {
    assert.equal(nativeAgentTools("worker", "claude"), LANE_TOOLS.worker.claude);
    assert.equal(nativeAgentTools("worker", "pi"), LANE_TOOLS.worker.pi);
    assert.equal(nativeAgentTools("reviewer", "claude"), LANE_TOOLS.reviewer.claude);
    assert.equal(nativeAgentTools("director", "pi"), LANE_TOOLS.director.pi);
  });

  it("returns nothing for a kind the table does not carry", () => {
    assert.equal(nativeAgentTools("worker", "codex"), null);
    assert.equal(nativeAgentTools("worker", "unknown"), null);
  });

  it("falls back to the worker lane for an unknown lane", () => {
    assert.equal(claudeAllowedTools("mystery"), LANE_TOOLS.worker.claude);
    assert.equal(claudeAllowedTools(), LANE_TOOLS.worker.claude);
    assert.equal(piAllowedTools("mystery"), LANE_TOOLS.worker.pi);
    assert.equal(nativeAgentTools("mystery", "claude"), null, "a lane renders only when it exists");
  });
});
