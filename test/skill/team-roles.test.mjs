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
      read("skills/meerkat/references/review-workflow.md"),
      /the loop already claimed it/i,
    );
    assert.match(read("skills/reviewer/SKILL.md"), /do not re-claim/i);
    assert.match(read("skills/reviewer/SKILL.md"), /interactively from `issue candidates`/i);
  });

  it("keeps the producer/consumer handoff markers in one contract", () => {
    const meerkat = read("skills/meerkat/SKILL.md");
    assert.match(meerkat, /stage_handoff=required/);
    assert.match(meerkat, /meta\.design_stage=yes/);
    assert.match(meerkat, /meta\.product_change=none/);
    assert.match(meerkat, /meta\.review_gate/);
    assert.match(read("skills/reviewer/references/audit-playbook.md"), /stage_handoff=required/);
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
    assert.match(read("skills/reviewer/references/audit-playbook.md"), /falls back/i);
  });
});
