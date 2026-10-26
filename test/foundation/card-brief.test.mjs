/**
 * The loop's `.meerkat/<identifier>/` path convention.
 *
 * Pure names, one source: the handoff builders and the on-disk exporter both
 * import these, so a subagent is never told to read a path the loop does not
 * write.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  CARD_BRIEF_FILE,
  MEERKAT_PROCESS_DIR,
  TERMINAL_CARD_STATUSES,
  cardDirRel,
  cardFileRel,
  taskDirName,
} from "../../src/foundation/card-brief.mjs";
import { TERMINAL_STATUSES } from "../../src/core/domain/status.mjs";

describe("card-brief — the per-task process directory", () => {
  it("names the brief under the project working directory", () => {
    assert.equal(MEERKAT_PROCESS_DIR, ".meerkat");
    assert.equal(CARD_BRIEF_FILE, "card.md");
    assert.equal(cardDirRel("PROJ-0007"), ".meerkat/PROJ-0007");
    assert.equal(cardFileRel("PROJ-0007"), ".meerkat/PROJ-0007/card.md");
  });

  it("keeps a board identifier exactly as issued", () => {
    assert.equal(taskDirName("PROJ-0007"), "PROJ-0007");
    assert.equal(taskDirName("T-20261014-212017-4"), "T-20261014-212017-4");
    assert.equal(taskDirName("a.b_c-1"), "a.b_c-1");
  });

  it("never lets an identifier escape its directory", () => {
    assert.equal(cardDirRel("A/B"), ".meerkat/A_B");
    assert.equal(cardDirRel(".."), ".meerkat/_");
    assert.equal(cardDirRel("."), ".meerkat/_");
    assert.equal(cardDirRel(""), ".meerkat/_");
    assert.equal(cardDirRel("   "), ".meerkat/_");
    assert.equal(cardDirRel("../etc"), ".meerkat/.._etc");
    assert.equal(cardDirRel("a\\b"), ".meerkat/a_b");
  });

  it("trims surrounding whitespace before sanitizing", () => {
    assert.equal(taskDirName("  PROJ-1  "), "PROJ-1");
  });

  it("mirrors the board's terminal status set", () => {
    // The foundation layer may not import `src/core`, so the set is a mirror.
    // A card brief watch ends at these statuses; a drift would leave a watch
    // alive forever or stop one early.
    assert.deepEqual([...TERMINAL_CARD_STATUSES], [...TERMINAL_STATUSES]);
    assert.deepEqual([...TERMINAL_CARD_STATUSES], ["done", "canceled"]);
  });
});
