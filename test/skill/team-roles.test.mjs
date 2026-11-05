/**
 * The cross-file seams between the role skills.
 *
 * The ownership matrix that used to live in `docs/agents/team-roles.md` is
 * gone; these assertions keep the seams it pinned. Each role skill, the board
 * skill and the director policy must agree on who claims, who lands, and which
 * handoff markers exist.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("team roles: the cross-file seams", () => {
  it("makes the reviewer's claim rule conditional on dispatch", () => {
    assert.match(read("skills/meerkat/SKILL.md"), /already claimed by the loop/i);
    assert.match(
      read("skills/meerkat/references/review-protocol.md"),
      /the loop already claimed it/i,
    );
    assert.match(read("skills/reviewer/SKILL.md"), /heartbeat it; you claim only one you pick up/i);
    assert.match(read("skills/reviewer/SKILL.md"), /interactively from `issue candidates`/i);
  });

  it("keeps the producer/consumer handoff markers in one contract", () => {
    const meerkat = read("skills/meerkat/SKILL.md");
    assert.match(meerkat, /stage_handoff=required/);
    assert.match(meerkat, /meta\.review_gate/);
    assert.doesNotMatch(meerkat, /design_stage|product_change/, "the research markers left the generic layer");
    assert.match(read("skills/reviewer/SKILL.md"), /stage_handoff=required/);
  });

  it("leaves a card's classification to the project graph and the role", () => {
    for (const rel of [
      "skills/linus/SKILL.md",
      "skills/turing/SKILL.md",
      "skills/reviewer/SKILL.md",
    ]) {
      const text = read(rel);
      assert.match(text, /epic_graph|epic-graphs\.md/, `${rel}: the graph is the classification source`);
      assert.doesNotMatch(text, /unclassified/i, `${rel}: no generic unclassified verdict`);
    }
  });

  it("keeps the coverage floor at 80 or stricter in both roles", () => {
    assert.match(read("skills/turing/references/self-check.md"), /≥80%/);
    assert.match(read("skills/linus/references/self-check.md"), /≥80%/);
  });

  it("has no dangling shared-workflow reference", () => {
    for (const rel of [
      "skills/turing/references/test-design-workflow.md",
      "skills/turing/references/regression-workflow.md",
      "skills/turing/references/performance-workflow.md",
      "skills/linus/references/architecture-workflow.md",
    ]) {
      assert.doesNotMatch(read(rel), /`workflow\.md`/, `${rel}: no dangling workflow.md`);
    }
  });

  it("treats a missing plan.md as a fallback, not a REJECT", () => {
    assert.match(read("skills/reviewer/SKILL.md"), /missing `plan\.md` is not\s+itself a `REJECT`/i);
    assert.match(read("skills/reviewer/SKILL.md"), /falls back/i);
  });

  it("routes an out-of-scope defect to the director instead of fixing it unasked", () => {
    for (const role of ["jobs", "linus", "turing", "worker"]) {
      for (const rel of [`skills/${role}/SKILL.md`, `skills/${role}/role.json`]) {
        const text = read(rel);
        assert.match(text, /`kind=defect`/, `${rel}: names the defect comment kind`);
        assert.match(text, /question to the\s+director/i, `${rel}: asks the director`);
        assert.match(
          text,
          /fixes\s+it in passing/i,
          `${rel}: leaves the in-card fix to the director's disposition`,
        );
        assert.doesNotMatch(
          text,
          /director creates the fix card|do not widen this card to fix it/i,
          `${rel}: no blanket fix-card rule`,
        );
      }
    }

    const policy = read("skills/meerkat-director/references/decision-policy.md");
    assert.match(policy, /out-of-scope defect's\s+disposition/i);
    assert.match(policy, /acceptance unchanged/i);

    assert.match(
      read("skills/reviewer/SKILL.md"),
      /surface a real problem even outside the list/i,
      "the read-only reviewer surfaces, never suppresses, an out-of-scope defect",
    );
  });
});
