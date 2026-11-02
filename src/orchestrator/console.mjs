#!/usr/bin/env node
/**
 * One read-only console cycle for a live `meerkat-chat` session.
 *
 * The live session is a manual operator view. This entry gives it the facts it
 * needs between ticks: who is driving the loop, and which
 * questions are actually waiting for a human. It never claims, moves, comments
 * or writes — the supervisor and the board own every write.
 *
 * The question ladder is the same one the director prompt carries:
 *   * `awaiting` cards — a human answer resumes them;
 *   * `in_progress` cards with an agent `question` that has not been **released**
 *     (a director `note` alone leaves the card open; a human answer is shown
 *     with `answered_pending_release`).
 * `in_review` cards are listed as pending acceptance. The card's own
 * `acceptance_mode` says who closes it — the loop for `off`/`auto`, a person
 * for `human` — so the list is a reading, not a claim about who owes the act.
 *
 * Node builtins only.
 */

import { installEntryCrashGuard } from "../foundation/crash-guard.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";

import { parseArgs } from "./options.mjs";
import { answeredByHuman, newestQuestion, questionOpen } from "./questions.mjs";
import { runCli } from "./runtime.mjs";
import { probeSupervisor } from "./status.mjs";

const USAGE = `Usage: taskctl loop console [--json] [--agent <name>] [--actor-kind <kind>]
         [--state <path>] [--log <path>] [--config <path>]

One read-only cycle: supervisor status, questions waiting for a human, and
in_review cards pending acceptance. It never writes to the board.`;

async function commentsFor(opts, agent, ref) {
  const read = runCli(opts, agent, ["comment", "list", ref, "--limit", "20"]);
  return read.ok ? { comments: read.data.comments ?? [], error: null } : { comments: [], error: read.error };
}

async function tasksWithStatus(opts, agent, status) {
  const read = runCli(opts, agent, [
    "issue",
    "list",
    "--status",
    status,
    "--limit",
    String(opts.boardLimit),
  ]);
  if (!read.ok) return { tasks: [], error: read.error };
  return { tasks: Array.isArray(read.data.tasks) ? read.data.tasks : [], error: null };
}

/**
 * One cycle. Exported so the skill's tests can drive it without a process.
 *
 * @param {object} opts
 * @param {{run?: Function, isAlive?: Function, now?: Function}} [deps]
 */
export async function consoleCycle(opts, deps = {}) {
  const agent =
    Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : "agent";
  const now = (deps.now ?? Date.now)();
  const supervisor = probeSupervisor(opts, deps);
  const errors = [];
  const questions = [];
  const ageMs = (askedAt) => {
    const at = typeof askedAt === "string" ? Date.parse(askedAt) : Number.NaN;
    return Number.isFinite(at) ? Math.max(0, now - at) : null;
  };

  const awaiting = await tasksWithStatus(opts, agent, "awaiting");
  if (awaiting.error !== null) errors.push(`awaiting: ${awaiting.error}`);
  for (const task of awaiting.tasks) {
    const { comments, error } = await commentsFor(opts, agent, task.identifier);
    if (error !== null) errors.push(`${task.identifier} comments: ${error}`);
    const question = newestQuestion(comments);
    // A human answer in the **UI** resumes the card on the board. The next
    // `issue list` normally drops it from this set; if the snapshot is older
    // than the comment, do not ask again — the comment is already the answer.
    if (question !== null && answeredByHuman(comments, question)) continue;
    questions.push({
      ref: task.identifier,
      title: task.title ?? null,
      status: "awaiting",
      awaiting_reason: task.awaiting_reason ?? null,
      question: question?.body ?? null,
      asked_at: question?.created_at ?? null,
      age_ms: ageMs(question?.created_at),
      answered_pending_release: false,
      kind: "awaiting",
    });
  }

  const inProgress = await tasksWithStatus(opts, agent, "in_progress");
  if (inProgress.error !== null) errors.push(`in_progress: ${inProgress.error}`);
  for (const task of inProgress.tasks) {
    const { comments, error } = await commentsFor(opts, agent, task.identifier);
    if (error !== null) errors.push(`${task.identifier} comments: ${error}`);
    const question = newestQuestion(comments);
    // The middle rung's question is open until the card is **released** — a
    // director `note` alone is not a settle. A human answer on an in-progress
    // card is shown, but flagged: the director still owes the release.
    if (!questionOpen(task, question)) continue;
    questions.push({
      ref: task.identifier,
      title: task.title ?? null,
      status: "in_progress",
      question: question.body ?? null,
      asked_at: question.created_at ?? null,
      age_ms: ageMs(question.created_at),
      answered_pending_release: answeredByHuman(comments, question),
      kind: "agent-question",
    });
  }

  const inReview = await tasksWithStatus(opts, agent, "in_review");
  if (inReview.error !== null) errors.push(`in_review: ${inReview.error}`);
  const pendingAcceptance = inReview.tasks.map((task) => ({
    ref: task.identifier,
    title: task.title ?? null,
    priority: task.priority ?? null,
  }));

  return {
    ok: errors.length === 0,
    supervisor,
    questions,
    pending_acceptance: pendingAcceptance,
    errors,
  };
}

function humanReport(result) {
  const lines = [
    `supervisor: ${result.supervisor.verdict}` +
      (result.supervisor.pool?.live
        ? ` (pool pid ${result.supervisor.pool.poolPid})`
        : ""),
    `questions: ${result.questions.length}`,
  ];
  for (const question of result.questions) {
    lines.push(`  ${question.ref} [${question.kind}] ${question.question ?? "(no question text)"}`);
  }
  lines.push(`pending acceptance: ${result.pending_acceptance.length}`);
  for (const card of result.pending_acceptance) {
    lines.push(`  ${card.ref} ${card.title ?? ""}`);
  }
  for (const error of result.errors) lines.push(`error: ${error}`);
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env, deps = {}, io = {}) {
  const writeOut = io.out ?? ((text) => process.stdout.write(text));
  const writeErr = io.err ?? ((text) => process.stderr.write(text));
  const json = argv.includes("--json");
  let opts;
  try {
    opts = parseArgs(
      argv.filter((arg) => arg !== "--json"),
      env,
    );
  } catch (error) {
    writeErr(`console: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    writeOut(`${USAGE}\n`);
    return 0;
  }
  const result = await consoleCycle(opts, deps);
  writeOut(`${json ? JSON.stringify(result, null, 2) : humanReport(result)}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  installEntryCrashGuard("console");
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
