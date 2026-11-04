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
import { wakeHandoff } from "../../src/orchestrator/runners.mjs";

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
  shapes: ["product brief"],
  skillDir: "/roles/jobs",
  platform: "claude",
  installedOn: ["claude"],
  workflow: "/roles/jobs/SKILL.md",
  selfCheck: "/roles/jobs/references/self-check.md",
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
  shapes: ["independent review"],
  skillDir: "/roles/reviewer",
  platform: "claude",
  installedOn: ["claude"],
  workflow: "/roles/reviewer/SKILL.md",
  selfCheck: "/roles/reviewer/references/self-check.md",
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
    // question-first (the decision ladder), again when the pre-authorized
    // derivation record moved from `--kind change` to `--kind note` so a subagent
    // never writes a decision kind, again when any human comment began to
    // resume awaiting (the worker now judges the answer's content at re-claim),
    // and again when the handoff was told to read every human comment after the
    // last question rather than only the newest one. With no role input the role
    // renderer contributes nothing; this hash is the post-rewrite base.
    // Re-pinned when the question lane landed: the worker is told the loop
    // hands its question to the project session, and that the project session's
    // `decision:` note counts as an answer on re-claim.
    // Re-pinned again when review became mode-independent and every unresolved
    // card began to resolve `agent`: a card payload without a mode now names the
    // reviewed default, not the old human fallback.
    // Re-pinned when Step 0 began sizing by deliverable: the worker is told that
    // layers of one change are not several deliverables (TP-0002's split).
    // Re-pinned when the split question's command line interpolated the real
    // card ref instead of printing a literal `${ref}`.
    // Re-pinned for the director vocabulary, and again when the old subagent
    // variant was removed: a worker always runs in its own worker session now,
    // so this is the one worker-handoff shape.
    // Re-pinned for the bounded `issue wait` hold: a worker that asks now waits
    // for the answer in the same turn (and re-claims if the director released
    // the card) instead of ending the turn immediately.
    // Re-pinned for 0002: the card vocabulary is `off | auto | human`.
    assert.equal(
      hash(buildHandoff(WORKER_INPUT)),
      "2a6747c66416aca8f7b44faee07e5820c44b0c67fbe575c9eb8851a8999547e8",
    );
  });

  it("keeps the reviewer handoff unchanged", () => {
    // Re-pinned when the reviewer lane became a real tool boundary: a reviewer
    // subagent inherits a session with no Write, so the handoff no longer
    // promises a process directory or asks it to download attachments.
    // Re-pinned again for the delivered-commit check and the carried findings:
    // a reviewer that judges the live tree can pass code nobody delivered.
    // Re-pinned for the director vocabulary (no project session exists now).
    assert.equal(
      hash(buildReviewHandoff(REVIEW_INPUT)),
      "887ab86a4b4b377d9326bc62ff969073f335f651cadd3a4aaded9c33d349d894",
    );
  });
});

describe("worker handoff with a role", () => {
  const text = buildHandoff({
    ...WORKER_INPUT,
    role: JOBS,
    roleWorkflowPath: JOBS.workflow,
    selfCheckPath: JOBS.selfCheck,
    decisionPolicyPath: "/roles/decision-policy.md",
  });

  it("carries layer 1 — the role the supervisor selected", () => {
    assert.match(text, /## Team role/);
    assert.match(text, /Role: Jobs — Product design/);
    assert.match(text, /Write the product brief first/);
    assert.match(text, /Do not write production backend code/);
    assert.match(text, /selected this role from the card's assignee/);
    assert.match(text, /role skill below is authoritative/);
  });

  it("carries layer 2 — the role skill and self-check paths", () => {
    assert.match(text, /## Role skill/);
    assert.match(text, /\/roles\/jobs\/SKILL\.md/);
    assert.match(text, /## Role self-check/);
    assert.match(text, /\/roles\/jobs\/references\/self-check\.md/);
  });

  it("asks for the evidence row at the moment of observation", () => {
    assert.match(text, /Append an evidence row the moment you observe it/);
    assert.match(text, /project the table into the delivery report/);
    assert.match(text, /a row written at delivery is memory/);
  });

  it("adds the plan-file convention and the question-first rule", () => {
    assert.match(text, /\.meerkat\/T-1\/plan\.md/);
    assert.match(text, /Decision needed:/);
    assert.match(text, /agent question comment on this card/);
    assert.match(text, /keep the card in_progress/);
    assert.match(text, /taskctl issue wait/);
    assert.match(text, /hold for the answer/);
    assert.match(text, /re-claim if the card is `todo`/);
    assert.match(text, /Do not enter awaiting yourself/);
    assert.match(text, /\/roles\/decision-policy\.md/);
  });

  it("asks the whole frontier in one question comment", () => {
    // A round is one question string: several independent decisions go into ONE
    // agent question comment, each numbered with a recommendation, so the project
    // session (and the console) sees the whole frontier at once.
    assert.match(text, /whole frontier/);
    assert.match(text, /Q1\.\.Qn/);
    assert.match(text, /worded so "yes" accepts/);
    assert.match(text, /Facts are the asker's job/i);
    assert.match(text, /one round is one question comment/i);
    assert.match(text, /do not drip one comment per question/i);
    assert.match(text, /incomplete answer is not consent/i);
    assert.doesNotMatch(text, /\[truncated — see the role files\]/);
  });

  it("no longer tells the worker to split an epic or enter awaiting on its own", () => {
    assert.doesNotMatch(text, /Promote and split FIRST/);
    assert.doesNotMatch(text, /awaiting --awaiting-reason E2 --question/);
    assert.match(text, /The director decides/i);
  });
});

describe("reviewer handoff with a role", () => {
  const text = buildReviewHandoff({
    ...REVIEW_INPUT,
    role: REVIEWER,
    roleWorkflowPath: REVIEWER.workflow,
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

  it("pins the review to the delivered commit, not the live tree", () => {
    assert.match(text, /Verify what was delivered, not the live tree/);
    assert.match(text, /`commit` anchor/);
    assert.match(text, /git -C <project dir> show <sha>:<path>/);
    assert.match(text, /The original's baseline already carries every earlier round's findings/);
  });

  it("keeps the reviewer out of awaiting", () => {
    assert.match(text, /You cannot enter awaiting/);
    assert.doesNotMatch(text, /agent question comment/);
  });

  it("carries the role skill and decision policy", () => {
    assert.match(text, /## Role skill/);
    assert.match(text, /\/roles\/reviewer\/SKILL\.md/);
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
    routing: { source: "skills", text: "| Work shape | Accountable role |\n|---|---|\n| brief | Jobs |" },
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
    assert.equal(result.executorReady, true);
    assert.equal(result.role, "worker");
    assert.equal(result.agentRole, "Jobs");
    assert.match(result.handoff, /## Team role/);
    assert.match(result.handoff, /Role: Jobs/);
    assert.doesNotMatch(result.handoff, /Work routing/, "routing belongs to the project session");
    assert.deepEqual(result.roleWarnings, ["a role warning"]);
  });

  it("refuses a dispatch whose role is not the card's assignee (ADR 0015)", () => {
    // The board's route says Jobs; the caller wants to run Reviewer. That is a
    // wrong-lane execution, so the dispatch reports it instead of spawning.
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-2", agent: "Reviewer" },
      { identifier: "T-2", title: "x", project: "P1", assignee: "Jobs", assignee_kind: "agent" },
    );
    assert.equal(result.executorReady, false);
    assert.equal(result.actorKind, null);
    assert.match(result.assignmentMismatch, /assigned to Jobs/);
  });

  it("accepts the dispatch when the selected role is the assignee's role", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-3", agent: "Jobs" },
      { identifier: "T-3", title: "x", project: "P1", assignee: "Jobs", assignee_kind: "agent" },
    );
    assert.equal(result.executorReady, true);
    assert.equal(result.assignmentMismatch, null);
    assert.equal(result.agentRole, "Jobs");
  });

  it("lets the planned Worker fallback through: card.reassign.to outranks the old assignee", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-4", agent: "Jobs" },
      {
        identifier: "T-4",
        title: "x",
        project: "P1",
        assignee: "Linus",
        assignee_kind: "agent",
        reassign: { from: "Linus", to: "Jobs", reason: "stale reclaim: Linus is not installed" },
      },
    );
    assert.equal(result.executorReady, true);
    assert.equal(result.assignmentMismatch, null);
    assert.equal(result.agentRole, "Jobs");
  });

  it("exempts an unassigned or human card from the assignee-role check", () => {
    for (const card of [
      { identifier: "T-5", title: "x", project: "P1" },
      { identifier: "T-6", title: "x", project: "P1", assignee: "Terry", assignee_kind: "human" },
    ]) {
      const result = wakeHandoff(
        opts,
        {},
        { identifier: card.identifier, agent: "Jobs" },
        card,
      );
      assert.equal(result.executorReady, true, card.identifier);
      assert.equal(result.assignmentMismatch, null, card.identifier);
    }
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
      assert.equal(result.executorReady, true);
      assert.equal(result.role, "reviewer");
      assert.equal(result.agentRole, "Reviewer");
      assert.match(result.handoff, /## Reviewer protocol/);
      assert.match(result.handoff, /VERDICT first/);
      assert.match(result.handoff, /## Role skill/);
      assert.doesNotMatch(result.handoff, /Work routing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a review card whose assignee is not a reviewer-lane role", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "R-2", agent: "Jobs" },
      { identifier: "R-2", review_of: "T-1", review_round: 1, project: "P1" },
    );
    assert.equal(result.isReview, true);
    assert.equal(result.executorReady, false, "the assignee does not select a reviewer role");
    assert.equal(result.role, "reviewer", "the card still needs the review handoff");
    assert.equal(result.agentRole, null);
    assert.match(result.handoff, /^You are the reviewer/);
    assert.doesNotMatch(result.handoff, /## Role skill/);
  });

  it("uses a thin task envelope for a resident worker session", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-1", agent: "Jobs" },
      { identifier: "T-1", title: "Wire it", project: "P1" },
      true,
    );
    assert.match(result.handoff, /Brief: \.meerkat\/T-1\/card\.md/);
    assert.match(result.handoff, /Plan: \.meerkat\/T-1\/plan\.md/);
    assert.match(result.handoff, /Carry the session opener's Flags/);
    assert.match(result.handoff, /taskctl issue wait T-1 --question <id> <flags>/);
    assert.match(result.handoff, /rounds\.md/);
    assert.doesNotMatch(result.handoff, /## Team role/);
    assert.doesNotMatch(result.handoff, /## Role skill/);
    assert.doesNotMatch(result.handoff, /## Role self-check/);
    assert.doesNotMatch(result.handoff, /Decision policy:/);
    assert.doesNotMatch(result.handoff, /taskctl export/);
  });

  it("carries the Flags in a thin envelope when the adapter loads the skill inline", () => {
    const codexJobs = { ...JOBS, platform: "codex", installedOn: ["codex"] };
    const result = wakeHandoff(
      {
        home: "/tmp",
        actorKind: "codex",
        roles: {
          ...roleSet,
          roles: [codexJobs],
          byAgent: new Map([["jobs", codexJobs]]),
        },
      },
      {},
      { identifier: "T-1", agent: "Jobs" },
      { identifier: "T-1", title: "Wire it", project: "P1" },
      true,
    );
    assert.match(result.handoff, /Brief: \.meerkat\/T-1\/card\.md/);
    assert.match(result.handoff, /Flags: --agent Jobs --actor-kind=codex/);
    assert.match(result.handoff, /Carry these Flags/);
    assert.doesNotMatch(result.handoff, /session opener's Flags/);
    assert.doesNotMatch(result.handoff, /## Team role/);
    assert.doesNotMatch(result.handoff, /## Role skill/);
  });

  it("names the director skill's rounds.md when no policy path is installed", () => {
    const result = wakeHandoff(
      { ...opts, roles: { ...roleSet, decisionPolicy: { path: null } } },
      {},
      { identifier: "T-1", agent: "Jobs" },
      { identifier: "T-1", title: "Wire it", project: "P1" },
      true,
    );
    assert.match(result.handoff, /meerkat-director skill's rounds\.md/);
  });

  it("gives a resident review session the lean envelope, not the role layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-role-resident-"));
    try {
      const promptPath = join(dir, "reviewer-prompt.md");
      writeFileSync(promptPath, "# Reviewer protocol\nVERDICT first.\n", "utf8");
      const reviewer = { ...REVIEWER, reviewerPrompt: promptPath };
      const result = wakeHandoff(
        {
          ...opts,
          roles: { ...roleSet, roles: [JOBS, reviewer], defaultReviewer: reviewer },
        },
        { reviewer: "Reviewer", reviewers: ["Reviewer"], reviewerWorkers: [] },
        { identifier: "R-1", agent: "Reviewer" },
        { identifier: "R-1", review_of: "T-1", review_round: 1, project: "P1" },
        true,
      );
      assert.equal(result.isReview, true);
      assert.match(result.handoff, /You are the reviewer for the P1 project/);
      assert.match(result.handoff, /Review card: R-1/);
      assert.match(result.handoff, /Original brief: \.meerkat\/T-1\/card\.md/);
      assert.match(result.handoff, /Step 0 — the review_not_ready check/);
      assert.match(result.handoff, /VERDICT: APPROVE/);
      // The skill was loaded at open, so the envelope carries neither the role
      // layer nor the duplicate protocol text.
      assert.doesNotMatch(result.handoff, /## Role skill/);
      assert.doesNotMatch(result.handoff, /## Reviewer protocol/);
      assert.doesNotMatch(result.handoff, /VERDICT first/);
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

describe("wakeHandoff dispatches on the kind that carries the role", () => {
  // Turing is installed only on codex; Jobs is installed on claude and pi.
  const CODEX_TURING = {
    ...JOBS,
    id: "turing",
    agent: "Turing",
    nativeAgent: "turing",
    skillDir: "/roles/codex/turing",
    platform: "codex",
    installedOn: ["codex"],
    workflow: "/roles/codex/turing/SKILL.md",
    selfCheck: "/roles/codex/turing/references/self-check.md",
  };
  const DUAL_JOBS = {
    ...JOBS,
    installedOn: ["claude", "pi"],
    variants: {
      claude: { skillDir: "/roles/claude/jobs", workflow: "/roles/claude/jobs/SKILL.md" },
      pi: { skillDir: "/roles/pi/jobs", workflow: "/roles/pi/jobs/SKILL.md" },
    },
  };
  const roleSet = {
    roles: [DUAL_JOBS, CODEX_TURING],
    defaultReviewer: null,
    decisionPolicy: { path: null },
    routing: { source: "skills", text: "" },
    warnings: [],
  };
  const opts = { home: "/tmp", actorKind: "claude", roles: roleSet };

  it("carries the role's own kind, not the supervisor's primary kind", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-1", agent: "Turing" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.actorKind, "codex");
    assert.equal(result.platformFallback, null);
    assert.match(result.handoff, /\/roles\/codex\/turing\/SKILL\.md/);
  });

  it("points at the selected kind's copy when a role is installed twice", () => {
    const result = wakeHandoff(
      opts,
      {},
      { identifier: "T-1", agent: "Jobs" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.actorKind, "claude");
    assert.match(result.handoff, /\/roles\/claude\/jobs\/SKILL\.md/);
  });

  it("falls back to another kind that carries the role, and reports it", () => {
    const result = wakeHandoff(
      { ...opts, kindAvailable: (kind) => kind !== "claude" },
      {},
      { identifier: "T-1", agent: "Jobs" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.actorKind, "pi");
    assert.equal(result.platformFallback, "pi");
    assert.match(result.handoff, /\/roles\/pi\/jobs\/SKILL\.md/);
  });

  it("returns no kind when no platform carries the role — the caller must not dispatch", () => {
    const result = wakeHandoff(
      { ...opts, kindAvailable: () => false },
      {},
      { identifier: "T-1", agent: "Turing" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.actorKind, null);
  });

  it("keeps the supervisor's kind when there is no role at all", () => {
    const result = wakeHandoff(
      { ...opts, roles: { roles: [], defaultReviewer: null, decisionPolicy: { path: null }, warnings: [] } },
      {},
      { identifier: "T-1", agent: "alice" },
      { identifier: "T-1", title: "x", project: "P1" },
    );
    assert.equal(result.actorKind, "claude");
  });
});
