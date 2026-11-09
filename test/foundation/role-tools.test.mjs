/**
 * The lane → tool surface: one source for the session adapters and the installer.
 *
 * The director and reviewer lanes may not write. Every other lane passes no tool
 * list at all.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  READ_ONLY_DENIED_TOOLS,
  READ_ONLY_LANES,
  isReadOnlyLane,
  nativeAgentToolLines,
  readOnlyDeniedTools,
} from "../../src/foundation/role-tools.mjs";

describe("lane tool surface", () => {
  it("pins the read-only lanes and their denied tools per kind", () => {
    assert.deepEqual(READ_ONLY_LANES, ["director", "reviewer"]);
    assert.deepEqual(READ_ONLY_DENIED_TOOLS, {
      claude: "Edit,Write,NotebookEdit",
      pi: "edit,write",
    });

    for (const lane of ["director", "reviewer"]) {
      assert.equal(isReadOnlyLane(lane), true);
      assert.equal(readOnlyDeniedTools(lane, "claude"), "Edit,Write,NotebookEdit");
      assert.equal(readOnlyDeniedTools(lane, "pi"), "edit,write");
    }
  });

  it("carries no restriction for the full lanes", () => {
    for (const lane of ["worker", "mystery", undefined]) {
      assert.equal(isReadOnlyLane(lane), false);
      assert.equal(readOnlyDeniedTools(lane, "claude"), null);
      assert.deepEqual(nativeAgentToolLines(lane, "claude"), []);
      assert.deepEqual(nativeAgentToolLines(lane, "pi"), []);
    }
  });

  it("renders a read-only lane's native frontmatter line per kind", () => {
    for (const lane of ["director", "reviewer"]) {
      assert.deepEqual(nativeAgentToolLines(lane, "claude"), [
        "disallowedTools: Edit,Write,NotebookEdit",
      ]);
      assert.deepEqual(nativeAgentToolLines(lane, "pi"), ["excludeTools: edit,write"]);
    }
  });

  it("returns nothing for a kind with no native tool surface", () => {
    assert.deepEqual(nativeAgentToolLines("reviewer", "codex"), []);
    assert.deepEqual(nativeAgentToolLines("director", "codex"), []);
    assert.equal(readOnlyDeniedTools("director", "codex"), null);
  });
});
