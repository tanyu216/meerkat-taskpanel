/**
 * Role-aware handoffs.
 *
 * The role layer is optional: with no role input the two handoffs must stay
 * byte-for-byte what they were before this feature, because deployed loops and
 * their tests pin that text. With a role, the handoff gains the loop's routing
 * decision (layer 1), the role workflow path (layer 2), the plan-file
 * convention, and the question-first rule: a subagent never decides an
 * unauthorized question itself — it asks the project session, which decides or
 * escalates to the human.
 *
 * The reviewer is the one lane that cannot enter `awaiting`: it must end in a
 * verdict, so insufficient evidence is a REJECT, not a question.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildHandoff, buildReviewHandoff } from "../../src/foundation/scheduling.mjs";
import { wakeHandoff } from "../../scripts/loop/runners.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

const JOBS = {
  id: "jobs",
  agent: "Jobs",
  nativeAgent: "jobs",
  lanes: ["worker"],
  title: "Product design",
  summary: "Product planning and design",
  responsibilities: ["Write the product brief first", "Define acceptance criteria"],
  boundaries: ["Do not write production backend code"],
  workflows: { worker: "/roles/jobs/workflow.md", reviewer: null },
  selfCheck: "/roles/jobs/self-check.md",
  reviewerPrompt: null,
};

const REVIEWER = {
  id: "reviewer",
  agent: "Reviewer",
  nativeAgent: "reviewer",
  lanes: ["reviewer"],
  title: "Independent reviewer",
  summary: "Independent acceptance review",
  responsibilities: ["Verify every acceptance item"],
  boundaries: ["Move nothing"],
  workflows: { worker: null, reviewer: "/roles/reviewer/workflow.md" },
  selfCheck: null,
  reviewerPrompt: "# Reviewer protocol\nVERDICT first.\n",
};

const WORKER_INPUT = {
  card: { identifier: "T-1", title: "Wire it", project: "P1" },
  agent: "alice",
  actorKind: "claude",
};

const REVIEW_INPUT = {
  card: { identifier: "R-1", title: "Review it", project: "P1", review_of: "T-1", review_round: 2 },
  agent: "bob",
  actorKind: "claude",
};

describe("handoffs without a role stay byte-identical", () => {
  it("keeps the worker handoff unchanged by the role layer", () => {
    // Re-pinned when the worker's epic-split / acceptance / awaiting text became
    // question-first (the decision ladder). With no role input the role renderer
    // contributes nothing; this hash is the post-rewrite base.
    assert.equal(
      hash(buildHandoff(WORKER_INPUT)),
      "d848d1066c23fe236194b5e58a4c9d446b1526b6e6982a04f05b3b598870bf32",
    );
  });

  it("keeps the reviewer handoff unchanged", () => {
    assert.equal(
      hash(buildReviewHandoff(REVIEW_INPUT)),
      "88c2b7c3a17d3327f4a6d8ee903e4b6b8e2706ba1bd70cf89377cbd58ba63a33",
    );
  });
});

describe("worker handoff with a role", () => {
  const text = buildHandoff({
    ...WORKER_INPUT,
    role: JOBS,
    roleWorkflowPath: JOBS.workflows.worker,
    selfCheckPath: JOBS.selfCheck,
    decisionPolicyPath: "/roles/decision-policy.md",
  });

  it("carries layer 1 — the role the loop selected", () => {
    assert.match(text, /## Team role/);
    assert.match(text, /Role: Jobs — Product design/);
    assert.match(text, /Write the product brief first/);
    assert.match(text, /Do not write production backend code/);
    assert.match(text, /selected this role from the card's assignee \(Jobs\)/);
  });

  it("carries layer 2 — the role workflow and self-check paths", () => {
    assert.match(text, /## Role workflow/);
    assert.match(text, /\/roles\/jobs\/workflow\.md/);
    assert.match(text, /## Role self-check/);
    assert.match(text, /\/roles\/jobs\/self-check\.md/);
  });

  it("adds the plan-file convention and the question-first rule", () => {
    assert.match(text, /\.meerkat\/T-1\/plan\.md/);
    assert.match(text, /Decision needed:/);
    assert.match(text, /agent question comment on this card/);
    assert.match(text, /keep the card in_progress/);
    assert.match(text, /Do not enter awaiting yourself/);
    assert.match(text, /\/roles\/decision-policy\.md/);
  });

  it("no longer tells the worker to split an epic or enter awaiting on its own", () => {
    assert.doesNotMatch(text, /Promote and split FIRST/);
    assert.doesNotMatch(text, /awaiting --awaiting-reason E2 --question/);
    assert.match(text, /ask the project session/i);
  });
});

describe("reviewer handoff with a role", () => {
  const text = buildReviewHandoff({
    ...REVIEW_INPUT,
    role: REVIEWER,
    roleWorkflowPath: REVIEWER.workflows.reviewer,
    reviewerPrompt: REVIEWER.reviewerPrompt,
    reviewerPromptPath: "/roles/reviewer/reviewer-prompt.md",
    decisionPolicyPath: "/roles/decision-policy.md",
  });

  it("inlines the reviewer protocol before the Step 0 check", () => {
    assert.match(text, /## Reviewer protocol/);
    assert.match(text, /VERDICT first/);
    assert.ok(
      text.indexOf("## Reviewer protocol") < text.indexOf("Step 0"),
      "the reviewer prompt must be read before the validity check",
    );
  });

  it("names the original's plan, evidence and omission check", () => {
    assert.match(text, /\.meerkat\/T-1\/plan\.md/);
    assert.match(text, /notes, evidence, report drafts, attachments/);
    assert.match(text, /Omission check/);
    assert.match(text, /narrowed acceptance list/i);
    assert.match(text, /VERDICT: REJECT/);
  });

  it("keeps the reviewer out of awaiting", () => {
    assert.match(text, /You cannot enter awaiting/);
    assert.doesNotMatch(text, /agent question comment/);
  });

  it("carries the role workflow and decision policy", () => {
    assert.match(text, /## Role workflow/);
    assert.match(text, /\/roles\/reviewer\/workflow\.md/);
    assert.match(text, /\/roles\/decision-policy\.md/);
  });
});

describe("wakeHandoff selects the card's role", () => {
  const roleSet = {
    roles: [JOBS, REVIEWER],
    byAgent: new Map([
      ["jobs", JOBS],
      ["reviewer", REVIEWER],
    ]),
    defaultReviewer: REVIEWER,
    decisionPolicy: { path: "/roles/decision-policy.md" },
    warnings: ["a role warning"],
  };
  const opts = { home: "/tmp", actorKind: "claude", roles: roleSet };

  it("uses the worker role named by the assignee", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-1", agent: "Jobs" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.isReview, false);
    assert.equal(result.role, "worker");
    assert.equal(result.agentRole, "Jobs");
    assert.match(result.handoff, /## Team role/);
    assert.match(result.handoff, /Role: Jobs/);
    assert.deepEqual(result.roleWarnings, ["a role warning"]);
  });

  it("uses the reviewer role for a review card and carries its workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-role-prompt-"));
    try {
      const promptPath = join(dir, "reviewer-prompt.md");
      writeFileSync(promptPath, "# Reviewer protocol\nVERDICT first.\n", "utf8");
      const reviewer = { ...REVIEWER, reviewerPrompt: promptPath };
      const result = wakeHandoff(
        { ...opts, roles: { ...roleSet, roles: [JOBS, reviewer], defaultReviewer: reviewer } },
        { reviewer: "Reviewer", reviewers: ["Reviewer"], reviewerWorkers: [] },
        { identifier: "R-1", agent: "Reviewer" },
        { identifier: "R-1", review_of: "T-1", review_round: 1, project: "P1" },
      );
      assert.equal(result.isReview, true);
      assert.equal(result.role, "reviewer");
      assert.equal(result.agentRole, "Reviewer");
      assert.match(result.handoff, /## Reviewer protocol/);
      assert.match(result.handoff, /VERDICT first/);
      assert.match(result.handoff, /## Role workflow/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the no-role path when the role set is empty", () => {
    const result = wakeHandoff(
      { ...opts, roles: { roles: [], defaultReviewer: null, decisionPolicy: { path: null }, warnings: [] } },
      {},
      { identifier: "T-1", agent: "alice" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.agentRole, null);
    assert.doesNotMatch(result.handoff, /## Team role/);
  });
});
