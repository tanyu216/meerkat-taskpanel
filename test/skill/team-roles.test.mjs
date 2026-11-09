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

  it("separates the downstream handoff from a filed defect follow-up", () => {
    const workerCheck = read("skills/worker/references/self-check.md");
    assert.match(workerCheck, /backlog/i);
    assert.match(workerCheck, /`kind=defect`/);
    assert.match(workerCheck, /meta\.fixes/i);
    assert.match(workerCheck, /why no card is needed/i, "a non-defect leftover can stay cardless");
    const linus = read("skills/linus/SKILL.md");
    assert.match(linus, /downstream follow-up/i);
    assert.match(linus, /defect follow-up/i);
    const meerkat = read("skills/meerkat/SKILL.md");
    assert.match(meerkat, /defect follow-up[\s\S]{0,140}stands on its own/i);
    const implementation = read("skills/linus/references/implementation-workflow.md");
    assert.match(implementation, /downstream follow-up/i);
    assert.match(implementation, /defect follow-up/i);
    for (const role of ["linus", "turing"]) {
      const check = read(`skills/${role}/references/self-check.md`);
      assert.match(check, /defect is filed\s+by its finder in `backlog`/i);
    }
  });

  it("treats a missing plan.md as a fallback, not a REJECT", () => {
    const protocol = read("skills/reviewer/references/review-protocol.md");
    assert.match(protocol, /missing `plan\.md` is not\s+itself a `REJECT`/i);
    assert.match(protocol, /falls back/i);
  });

  it("files a non-blocking out-of-scope defect and asks the director for the exception", () => {
    for (const role of ["jobs", "linus", "turing", "worker"]) {
      for (const rel of [`skills/${role}/SKILL.md`, `skills/${role}/role.json`]) {
        const text = read(rel);
        assert.match(text, /`kind=defect`/, `${rel}: names the defect comment kind`);
        assert.match(text, /backlog/i, `${rel}: the default follow-up is a backlog card`);
        assert.match(text, /meta\.fixes/i, `${rel}: the follow-up references the source card`);
        assert.match(text, /bug[- ]label|bug-labelled/i, `${rel}: the follow-up is bug-labelled`);
        assert.match(text, /card continues/i, `${rel}: the finder continues without a hold`);
        assert.match(text, /question to the\s+director/i, `${rel}: the exception asks the director`);
        assert.match(
          text,
          /fixes\s+it in passing/i,
          `${rel}: leaves the in-card fix to the director's disposition`,
        );
        assert.doesNotMatch(
          text,
          /reported and left to the director|director creates the fix card|do not widen this card to fix it/i,
          `${rel}: no blanket director round and no blanket fix-card rule`,
        );
      }
    }

    const policy = read("skills/meerkat-director/references/decision-policy.md");
    assert.match(policy, /out-of-scope defect's\s+disposition/i);
    assert.match(policy, /acceptance unchanged/i);
    assert.match(policy, /backlog/i);
    assert.match(policy, /meta\.fixes/i);
    assert.match(policy, /finder/i);
    assert.match(policy, /downstream card/i);
    assert.match(policy, /follows the decision map/i, "the scope-changing case leaves the director");
    assert.match(
      policy,
      /the human\s+decides it unless the project delegates/i,
      "the director is not the decider of E1-E5",
    );

    assert.match(
      read("skills/reviewer/SKILL.md"),
      /surface a real problem even outside the list/i,
      "the read-only reviewer surfaces, never suppresses, an out-of-scope defect",
    );
    const audit = read("skills/reviewer/references/scenarios/development.md");
    assert.match(audit, /downstream follow-up/i);
    assert.match(audit, /defect follow-up[\s\S]{0,160}identifier/i);
    const product = read("skills/reviewer/references/scenarios/product-plan.md");
    assert.match(product, /defect follow-up[\s\S]{0,160}identifier/i);
    const protocol = read("skills/reviewer/references/review-protocol.md");
    assert.match(protocol, /entry is resolved by a recorded decision/i);
    assert.match(read("skills/reviewer/SKILL.md"), /acceptance pass or the director's triage/i);
  });
});
