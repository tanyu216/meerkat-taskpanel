#!/usr/bin/env node
/**
 * Render and validate one role skill from a spec, into an installed agent kind's skills
 * tree. `/setup-meerkat` Step 6 owns the interview; this script owns the deterministic
 * part: the `meerkat-role` contract, the standard role prose, path safety and idempotence.
 *
 * The installed skill has no checkout, so the contract constants are duplicated here with
 * their source named. They are small and stable:
 *   src/foundation/roles.mjs — ROLE_SCHEMA, ROLE_ID_PATTERN, ROLE_LANES, ROLES_LIMITS.
 *
 * Node builtins only.
 *
 * Usage:
 *   node scaffold-role.mjs --spec <spec.json> --skills-dir <dir>
 *     [--dry-run] [--force] [--json]
 *
 * Exit: 0 written/unchanged, 3 conflict, 2 usage/spec error, 1 write error.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { writeAtomic } from "./lib/atomic.mjs";
import { isEntryPoint } from "./lib/entry-guard.mjs";

// Mirrors src/foundation/roles.mjs.
const ROLE_SCHEMA = "meerkat-role";
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLE_LANES = ["worker", "reviewer"];
const LIMITS = Object.freeze({ responsibilities: 16, boundaries: 16, shapes: 16, roleJsonBytes: 32 * 1024, workflowBytes: 64 * 1024, systemPromptBytes: 8 * 1024 });

// The static half of a card session's system prompt; the supervisor formats the
// runtime half (agent, card, plan, flags) at open time. Mirrors the worker-lane
// body in the five role skills.
const DEFAULT_SYSTEM_PROMPT = [
  "Read the task card first; it is authoritative for this card. Write and maintain the plan in the process directory.",
  "The supervisor owns card.md and refreshes it from the board.",
  "Carry the Flags above on every write.",
  "Board: heartbeat this card at least every 10 minutes and deliver at in_review with a report;",
  "the loop holds the claim and closes the card at done.",
  "  taskctl issue heartbeat <ref> <flags>",
  "  taskctl issue deliver <ref> --report-file - <flags>",
  "For a question, route it to the director: leave a `question` comment and hold the card with `issue wait`.",
  '  taskctl comment add <ref> --kind question --body "..." <flags>',
  "  taskctl issue wait <ref> --question <id> <flags>",
].join("\n");

const USAGE = `scaffold-role — render one role skill from a spec

  node scaffold-role.mjs --spec <spec.json> --skills-dir <dir>
                        [--dry-run] [--force] [--json]

Exit: 0 written/unchanged, 3 conflict, 2 usage/spec error, 1 write error.`;

class SpecError extends Error {}

function parse(argv) {
  const opts = { spec: null, skillsDir: null, dryRun: false, force: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--spec": opts.spec = resolve(take()); break;
      case "--skills-dir": opts.skillsDir = resolve(take()); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

const isString = (value) => typeof value === "string" && value.trim() !== "";
const isStringList = (value, allowEmpty = true) =>
  Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => isString(entry));

function validateSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SpecError("the spec must be a JSON object");
  const errors = [];
  if (!isString(raw.id)) errors.push("id is required");
  else if (!ROLE_ID_PATTERN.test(raw.id.trim())) errors.push(`id must match ${ROLE_ID_PATTERN}`);
  if (!isString(raw.agent)) errors.push("agent is required");
  if (raw.native_agent !== undefined && !isString(raw.native_agent)) errors.push("native_agent must be a non-empty string when set");
  if (!ROLE_LANES.includes(raw.lane)) errors.push(`lane must be one of ${ROLE_LANES.join(", ")}`);
  if (!isString(raw.title)) errors.push("title is required");
  if (!isString(raw.summary)) errors.push("summary is required");
  if (!isStringList(raw.shapes, false)) errors.push("shapes must be a non-empty array of strings");
  else if (raw.shapes.length > LIMITS.shapes) errors.push(`at most ${LIMITS.shapes} shapes`);
  if (!isStringList(raw.responsibilities)) errors.push("responsibilities must be an array of strings");
  else if (raw.responsibilities.length > LIMITS.responsibilities) errors.push(`at most ${LIMITS.responsibilities} responsibilities`);
  if (!isStringList(raw.boundaries)) errors.push("boundaries must be an array of strings");
  else if (raw.boundaries.length > LIMITS.boundaries) errors.push(`at most ${LIMITS.boundaries} boundaries`);
  if (raw.system_prompt !== undefined && !isString(raw.system_prompt)) errors.push("system_prompt must be a non-empty string when set");
  else if (isString(raw.system_prompt) && Buffer.byteLength(raw.system_prompt.trim(), "utf8") > LIMITS.systemPromptBytes) {
    errors.push(`system_prompt must stay under ${LIMITS.systemPromptBytes} bytes`);
  }
  if (!Array.isArray(raw.workflow) || raw.workflow.length === 0) errors.push("workflow must be a non-empty array");
  else {
    for (const [index, step] of raw.workflow.entries()) {
      if (!step || typeof step !== "object" || !isString(step.title) || !isString(step.body)) {
        errors.push(`workflow[${index}] needs a non-empty title and body`);
      }
    }
  }
  if (!isStringList(raw.self_check, false)) errors.push("self_check must be a non-empty array of strings");
  if (raw.default_reviewer !== undefined && typeof raw.default_reviewer !== "boolean") errors.push("default_reviewer must be a boolean");
  if (raw.default_reviewer === true && raw.lane !== "reviewer") errors.push("only a reviewer-lane role may be the default reviewer");
  if (errors.length > 0) throw new SpecError(errors.join("\n"));
  const lane = raw.lane;
  const line = (value) => String(value).replace(/\s+/g, " ").trim();
  return {
    id: raw.id.trim(),
    agent: line(raw.agent),
    native_agent: line(raw.native_agent ?? raw.id),
    lane,
    title: line(raw.title),
    summary: line(raw.summary),
    shapes: raw.shapes.map(line),
    responsibilities: raw.responsibilities.map(line),
    boundaries: raw.boundaries.map(line),
    system_prompt: isString(raw.system_prompt) ? raw.system_prompt.trim() : DEFAULT_SYSTEM_PROMPT,
    workflow: raw.workflow.map((step) => ({ title: line(step.title), body: String(step.body).trim() })),
    self_check: raw.self_check.map(line),
    default_reviewer: raw.default_reviewer === true,
    reviewer_prompt: lane === "reviewer" ? "references/reviewer-prompt.md" : null,
  };
}

const bullet = (lines) => lines.map((line) => `- ${line}`).join("\n");
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

function renderSkill(role) {
  const description = oneLine(
    `Meerkat TaskPanel role — ${role.agent} (${role.title}). Use when a card owns ${role.shapes.join("; ")}.`,
  ).replace(/[:#"]/g, " ").replace(/\s+/g, " ").trim();
  const reviewer = role.lane === "reviewer";
  const sections = [
    `---`,
    `name: ${role.id}`,
    `description: ${description}`,
    `---`,
    ``,
    `# ${role.agent} — ${role.title}`,
    ``,
    `You are **${role.agent}**. ${role.summary}`,
    ``,
    `Board operations are the \`meerkat\` skill's contract. Decisions are the`,
    `\`meerkat-director\`'s \`references/decision-policy.md\`; when a choice is not yours, write`,
    `an agent \`question\` comment and hold with \`issue wait\`. Never record a human decision`,
    `as your own.`,
    ``,
    `## Steps at a glance`,
    ``,
    `1. Read the card and its brief; the frozen acceptance is the contract.`,
    `2. Write or adopt \`.meerkat/<ref>/plan.md\`, then audit it against the acceptance.`,
    `3. Do the work in the branch the card names.`,
    `4. Run \`references/self-check.md\`.`,
    `5. Deliver at \`in_review\` with the commit anchor, the acceptance mapping and the evidence.`,
    ``,
    `## Your work`,
    ``,
    bullet(role.responsibilities),
    ``,
    `## Workflow`,
    ``,
    bullet(role.workflow.map((step) => `**${step.title}** — ${step.body}`)),
    ``,
    `The branches are in \`references/workflow.md\`.`,
    ``,
    `## Hard limits`,
    ``,
    bullet(role.boundaries),
    `- Stop at \`in_review\`; the card's \`acceptance_mode\` names the closer.`,
    `- Deliver the committed tree; the supervisor's acceptance pass lands it.`,
    ...(reviewer
      ? [
          `- Review cards only: ordinary cards belong to the worker roles.`,
          `- Stay in the review turn; insufficient evidence is a \`VERDICT: REJECT\`.`,
          ``,
          `Your review prompt is \`references/reviewer-prompt.md\`.`,
        ]
      : []),
    ``,
  ];
  return `${sections.join("\n")}\n`;
}

function renderRoleJson(role) {
  const json = {
    schema: ROLE_SCHEMA,
    id: role.id,
    agent: role.agent,
    native_agent: role.native_agent,
    lanes: [role.lane],
    title: role.title,
    summary: role.summary,
    shapes: role.shapes,
    responsibilities: role.responsibilities,
    boundaries: role.boundaries,
    system_prompt: role.system_prompt,
    self_check: "references/self-check.md",
    reviewer_prompt: role.reviewer_prompt,
  };
  if (role.default_reviewer) json.default_reviewer = true;
  return `${JSON.stringify(json, null, 2)}\n`;
}

function renderWorkflow(role) {
  const parts = [`# Workflow`, ``];
  for (const step of role.workflow) {
    parts.push(`## ${step.title}`, ``, step.body, ``);
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

function renderSelfCheck(role) {
  return `# Self-check\n\nBefore delivery, answer every item:\n\n${bullet(role.self_check)}\n`;
}

function renderReviewerPrompt(role) {
  return `# Reviewer prompt\n\nYou are **${role.agent}**. Review any delivered card dispatched for review, whatever its\ntarget type: walk the universal floor, then the shape refinements that match. A type no\nshape names still gets the floor and the project's own standards — never a skip.\n\nVerify the requirement ledger at the delivered commit, answer every baseline item with a\nfalsifiable evidence item, and return exactly one \`VERDICT: APPROVE\` or\n\`VERDICT: REJECT\` on the first line.\n`;
}

function filesFor(role) {
  const files = [
    ["SKILL.md", renderSkill(role)],
    ["role.json", renderRoleJson(role)],
    [join("references", "workflow.md"), renderWorkflow(role)],
    [join("references", "self-check.md"), renderSelfCheck(role)],
  ];
  if (role.lane === "reviewer") files.push([join("references", "reviewer-prompt.md"), renderReviewerPrompt(role)]);
  return files;
}

function assertInside(root, target) {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}${sep}`)) {
    throw new SpecError(`${target} escapes ${root}`);
  }
}

function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    process.stderr.write(`scaffold-role: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!opts.spec || !opts.skillsDir) {
    process.stderr.write(`scaffold-role: --spec and --skills-dir are required\n${USAGE}\n`);
    return 2;
  }
  if (!existsSync(opts.skillsDir)) {
    process.stderr.write(`scaffold-role: skills directory does not exist: ${opts.skillsDir}\n`);
    return 2;
  }

  let role;
  try {
    const raw = JSON.parse(readFileSync(opts.spec, "utf8"));
    role = validateSpec(raw);
  } catch (err) {
    process.stderr.write(`scaffold-role: ${err instanceof SpecError ? err.message : `cannot read spec: ${err.message}`}\n`);
    return 2;
  }

  let root;
  try {
    root = realpathSync(opts.skillsDir);
  } catch (err) {
    process.stderr.write(`scaffold-role: cannot resolve ${opts.skillsDir}: ${err.message}\n`);
    return 2;
  }
  const target = resolve(root, role.id);
  assertInside(root, target);

  const files = filesFor(role);
  const rendered = files.map(([rel, text]) => ({ path: join(target, rel), rel, text }));
  const totalJson = Buffer.byteLength(rendered.find((file) => file.rel === "role.json").text, "utf8");
  const totalWorkflow = Buffer.byteLength(rendered.find((file) => file.rel === join("references", "workflow.md")).text, "utf8");
  if (totalJson > LIMITS.roleJsonBytes) {
    process.stderr.write(`scaffold-role: role.json exceeds ${LIMITS.roleJsonBytes} bytes\n`);
    return 2;
  }
  if (totalWorkflow > LIMITS.workflowBytes) {
    process.stderr.write(`scaffold-role: references/workflow.md exceeds ${LIMITS.workflowBytes} bytes\n`);
    return 2;
  }

  const exists = existsSync(target);
  if (exists) {
    try {
      if (lstatSync(target).isSymbolicLink()) {
        process.stderr.write(`scaffold-role: ${target} is a symlink; refusing to write through it\n`);
        return 2;
      }
    } catch (err) {
      process.stderr.write(`scaffold-role: cannot inspect ${target}: ${err.message}\n`);
      return 1;
    }
    let same = true;
    for (const file of rendered) {
      try {
        if (readFileSync(file.path, "utf8") !== file.text) same = false;
      } catch {
        same = false;
      }
    }
    if (same) {
      report(opts, { status: "unchanged", id: role.id, dir: target, files: rendered.map((file) => ({ path: file.path, action: "unchanged" })) });
      return 0;
    }
    if (!opts.force) {
      report(opts, { status: "conflict", id: role.id, dir: target, files: rendered.map((file) => ({ path: file.path, action: "differs" })) });
      return 3;
    }
  }

  if (opts.dryRun) {
    report(opts, { status: "would-write", id: role.id, dir: target, files: rendered.map((file) => ({ path: file.path, action: "would-write" })) });
    return 0;
  }

  try {
    for (const file of rendered) writeAtomic(file.path, file.text);
  } catch (err) {
    process.stderr.write(`scaffold-role: write failed: ${err.message}\n`);
    return 1;
  }
  report(opts, { status: "written", id: role.id, dir: target, files: rendered.map((file) => ({ path: file.path, action: "written" })) });
  return 0;
}

function report(opts, result) {
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${result.status}: ${result.dir}\n`);
    for (const file of result.files) process.stdout.write(`  ${file.action}  ${file.path}\n`);
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
