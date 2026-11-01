/**
 * Pure prompt fragments for the optional team-role layer.
 *
 * `scheduling.mjs` is a pure decision module; keeping these renderers here (and
 * importing no filesystem) means the handoff builders stay testable without a
 * roles root. The loader (`roles.mjs`) owns reading and validating the files;
 * this module only turns a normalized role into bounded text.
 *
 * Bounds matter: a handoff is pasted into a child conversation, and a careless
 * roles file must not be able to crowd out the card's own instructions.
 */

const ROLE_PROMPT_LIMITS = Object.freeze({
  layerOne: 1400,
  // The decision layer now carries the bounded `issue wait` hold; the extra
  // headroom keeps the whole frontier + the policy pointer from truncating.
  decision: 1700,
  reviewer: 2400,
});

/** @param {string} text @param {number} max */
function clamp(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const newline = cut.lastIndexOf("\n");
  return `${newline > 0 ? cut.slice(0, newline) : cut}\n[truncated — see the role files]`;
}

/** @param {string} title @param {string[]} values */
function bullets(title, values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return [title, ...values.map((value) => `- ${value}`)];
}

/**
 * The decision-round principles. Both runtime prompts — the worker handoff and
 * the tick — render this same text, so they cannot drift.
 *
 * A round changes *how* a question is asked, never *who* decides: the ladder
 * (worker → director → human) still binds, and only a human comment
 * resumes an `awaiting` card.
 */
const DECISION_ROUND_PRINCIPLES = Object.freeze([
  "A round settles the whole frontier: every decision whose prerequisites are settled. Ask",
  "them in one round; a decision that depends on another open one waits for the next round.",
  'Number the items Q1..Qn, each with a recommendation, worded so "yes" accepts it.',
  "Facts are the asker's job: look them up (code, docs, a probe); never ask for a fact the",
  "tools can establish. A lookup still running blocks only its downstream questions.",
  "Answers reshape the tree: recompute and ask the next round; close it only when the",
  "frontier is empty. Do not build while any frontier item is open.",
]);

/**
 * @returns {string[]}
 */
function renderDecisionRoundPrinciples() {
  return [...DECISION_ROUND_PRINCIPLES];
}

/**
 * Layer 1 — the supervisor's routing decision: which role, and what it owns. This
 * is deliberately short; the full workflow is layer 2.
 *
 * @param {object} role
 * @returns {string[]}
 */
export function renderRoleLayerOne(role) {
  const lines = [
    "## Team role",
    `Role: ${role.agent} — ${role.title}.`,
    ...(role.summary ? [role.summary] : []),
    ...bullets("Responsibilities:", role.responsibilities),
    ...bullets("Boundaries:", role.boundaries),
    "The supervisor selected this role from the card's assignee. This is routing guidance;",
    "the role skill below is authoritative for how the role works.",
  ];
  return [clamp(lines.join("\n"), ROLE_PROMPT_LIMITS.layerOne)];
}

/**
 * Layer 2 — a path, not the text. The spawned subagent reads the workflow itself.
 *
 * @param {object} role
 * @param {string} path
 * @returns {string[]}
 */
export function renderRoleWorkflow(role, path) {
  return [
    "## Role skill",
    `Read this skill before acting — it is the authoritative procedure for the ${role.agent} role:`,
    `  ${path}`,
    "The handoff above remains authoritative for this card's identifier and taskctl commands.",
  ];
}

/**
 * @param {object} role
 * @param {string} path
 * @returns {string[]}
 */
export function renderRoleSelfCheck(role, path) {
  return [
    "## Role self-check",
    `Before delivery, read and run the ${role.agent} self-check:`,
    `  ${path}`,
  ];
}

/**
 * The question-first rule. A worker never decides an unauthorized question
 * itself: it records an agent `question` comment and holds with `issue wait`, so
 * the director can answer or escalate; the release, not a note, ends the hold.
 * The board's human-only `awaiting` exit is not the worker's channel.
 *
 * @param {object} role
 * @param {string|null} policyPath
 * @returns {string[]}
 */
export function renderRoleDecision(role, policyPath) {
  const lines = [
    "## Decisions",
    "Do not decide an unauthorized question yourself. The director decides what it",
    "can; the human decides E1-E5 (scope, acceptance, design direction, security/data,",
    "architecture). If a choice is not explicitly authorized by the handoff, plan or",
    "acceptance, add an agent question comment on this card, keep the card in_progress,",
    "and hold: taskctl issue wait <ref> --question <comment-id>.",
    "`answered`: continue (re-claim if the card is `todo`); any other outcome:",
    "stop — the loop resumes this session. A non-zero exit is a result: read `outcome`.",
    "Settle the whole frontier, not one item at a time:",
    ...renderDecisionRoundPrinciples(),
    "One round is ONE question comment: Q1..Qn in one string; do not drip one comment per question.",
    "An incomplete answer is not consent: ask the next round as one new string.",
    "Use this format for each item:",
    "  Decision needed: ...",
    "  Options: A) ...; B) ...",
    "  Recommendation: ...",
    "  Impact if deferred: ...",
    "  Verified already: ...",
    "Do not enter awaiting yourself and do not write decision/confirm/change.",
  ];
  if (typeof policyPath === "string" && policyPath !== "") {
    lines.push(`Decision policy: ${policyPath}`);
  }
  return [clamp(lines.join("\n"), ROLE_PROMPT_LIMITS.decision)];
}

/**
 * The reviewer prompt inlined at the start of a reviewer handoff. A reviewer
 * must have it in the first context even on a host that cannot read the file.
 *
 * @param {string|null} text
 * @param {string|null} path
 * @returns {string[]}
 */
export function renderReviewerProtocol(text, path) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const body = text.trim();
  const bounded = body.length <= ROLE_PROMPT_LIMITS.reviewer
    ? body
    : `${body.slice(0, ROLE_PROMPT_LIMITS.reviewer)}\n[truncated — read the full file at ${path ?? "the reviewer prompt"}]`;
  return ["## Reviewer protocol", bounded];
}

