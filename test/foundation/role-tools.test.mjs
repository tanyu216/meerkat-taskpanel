/**
 * The lane → tool surface: one source for the session adapters and the installer.
 *
 * Only the reviewer lane is restricted: it may not write. Worker and director
 * lanes pass no tool list at all.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REVIEWER_DENIED_TOOLS,
  nativeAgentToolLines,
  reviewerDeniedTools,
} from "../../src/foundation/role-tools.mjs";

describe("lane tool surface", () => {
  it("pins the reviewer's denied tools per kind", () => {
    assert.deepEqual(REVIEWER_DENIED_TOOLS, {
      claude: "Edit,Write,NotebookEdit",
      pi: "edit,write",
    });
    assert.equal(reviewerDeniedTools("claude"), "Edit,Write,NotebookEdit");
    assert.equal(reviewerDeniedTools("pi"), "edit,write");
    assert.equal(reviewerDeniedTools(), null, "no kind means no restriction to carry");
  });

  it("carries no restriction for the full lanes", () => {
    for (const lane of ["director", "worker", "mystery", undefined]) {
      assert.deepEqual(nativeAgentToolLines(lane, "claude"), []);
      assert.deepEqual(nativeAgentToolLines(lane, "pi"), []);
    }
  });

  it("renders the reviewer's native frontmatter line per kind", () => {
    assert.deepEqual(nativeAgentToolLines("reviewer", "claude"), [
      "disallowedTools: Edit,Write,NotebookEdit",
    ]);
    assert.deepEqual(nativeAgentToolLines("reviewer", "pi"), ["excludeTools: edit,write"]);
  });

  it("returns nothing for a kind with no native tool surface", () => {
    assert.deepEqual(nativeAgentToolLines("reviewer", "codex"), []);
    assert.equal(reviewerDeniedTools("codex"), null);
  });
});
