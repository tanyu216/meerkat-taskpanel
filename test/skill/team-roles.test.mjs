/**
 * The team's ownership matrix and the seams it pins.
 *
 * `docs/agents/team-roles.md` is the maintainer's single source for "one
 * accountable role per work shape". It is a repository document, not an
 * installed skill: the role skills must not link back to it, and the matrix
 * must stay in step with the role manifests and the lifecycle documents.
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
const roleJson = (role) => JSON.parse(read(`skills/${role}/role.json`));

const MATRIX = read("docs/agents/team-roles.md");
const ROLES = ["jobs", "linus", "turing", "reviewer", "worker"];

describe("team roles: the ownership matrix", () => {
  it("covers every discovered role by its board name", () => {
    for (const role of ROLES) {
      const { agent } = roleJson(role);
      assert.match(MATRIX, new RegExp(`\\b${agent}\\b`), `${role}: ${agent} is in the matrix`);
    }
  });

  it("states the four layers and the one-role-per-shape rule", () => {
    for (const layer of ["Human", "Director", "Supervisor", "Roles"]) {
      assert.match(MATRIX, new RegExp(`\\*\\*${layer}\\*\\*`), `${layer} is named`);
    }
    assert.match(MATRIX, /one accountable role\s+per work shape/i);
    assert.match(MATRIX, /a shape no role\s+describes goes to Worker/i);
  });

  it("leaves E1–E5 to the human", () => {
    assert.match(MATRIX, /E1–E5\s*\|\s*a human/i);
    assert.match(MATRIX, /E1–E5\s*→\s*human/i);
  });

  it("leaves landing and cleanup to the supervisor", () => {
    assert.match(MATRIX, /\|\s*landing \/ cleanup\s*\|\s*Supervisor\s*\|/i);
    assert.doesNotMatch(MATRIX, /landing and cleanup belong to the director/i);
  });

  it("names the markers each layer writes", () => {
    for (const key of [
      "stage_handoff",
      "design_stage",
      "product_change",
      "review_gate",
      "handoff_consumed_round",
      "handoff_declined_round",
    ]) {
      assert.match(MATRIX, new RegExp(key), `${key} is inventoried`);
    }
  });

  it("points at the live authorities rather than restating them", () => {
    for (const link of [
      "scheduling.md",
      "lifecycle.md",
      "skills/meerkat/SKILL.md",
    ]) {
      assert.match(MATRIX, new RegExp(link.replace(".", "\\.")), `${link} is linked`);
    }
    assert.doesNotMatch(MATRIX, /ARCHITECTURE\.md/, "no phantom ARCHITECTURE citation");
  });
});

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
