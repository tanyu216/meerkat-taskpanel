#!/usr/bin/env node
/**
 * One read-only console cycle for a live `/meerkat-loop` session.
 *
 * The live session is the control turn in manual mode. This entry gives it the
 * facts it needs between control turns: who is driving the loop, and which
 * questions are actually waiting for a human. It never claims, moves, comments
 * or writes — the control turn and the board own every write.
 *
 * The question ladder is the same one `buildContinuePrompt` carries:
 *   * `awaiting` cards — a human answer resumes them;
 *   * `in_progress` cards with an agent `question` and no later human comment.
 * `in_review` cards are listed as pending acceptance; the skill applies the
 * policy (the workflow applies it as taskd unless the policy is `human-only`).
 *
 * Node builtins only.
 */

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

import { parseArgs } from "./options.mjs";
import { runCli } from "./runtime.mjs";
import { probeSupervisor } from "./status.mjs";

const USAGE = `Usage: node scripts/loop/console.mjs [--json] [--agent <name>] [--actor-kind <kind>]
         [--state <path>] [--log <path>] [--config <path>]

One read-only cycle: supervisor status, questions waiting for a human, and
in_review cards pending acceptance. It never writes to the board.`;

const isHuman = (comment) =>
  String(comment?.author_kind ?? comment?.author?.kind ?? "").toLowerCase() === "human";

const isQuestion = (comment) => comment?.kind === "question";

/** Newest first (`comment list` is desc): the first question is the live one. */
function newestQuestion(comments) {
  for (const comment of comments ?? []) {
    if (isQuestion(comment)) return comment;
  }
  return null;
}

/**
 * A question is answered when a human comment is newer — i.e. appears before it
 * in the newest-first list.
 */
function answeredAfter(comments, question) {
  const list = comments ?? [];
  const index = list.indexOf(question);
  if (index <= 0) return false;
  return list.slice(0, index).some(isHuman);
}

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
  const supervisor = probeSupervisor(opts, deps);
  const errors = [];
  const questions = [];

  const awaiting = await tasksWithStatus(opts, agent, "awaiting");
  if (awaiting.error !== null) errors.push(`awaiting: ${awaiting.error}`);
  for (const task of awaiting.tasks) {
    const { comments, error } = await commentsFor(opts, agent, task.identifier);
    if (error !== null) errors.push(`${task.identifier} comments: ${error}`);
    const question = newestQuestion(comments);
    // A human answer in the **UI** resumes the card on the board. The next
    // `issue list` normally drops it from this set; if the snapshot is older
    // than the comment, do not ask again — the comment is already the answer.
    if (question !== null && answeredAfter(comments, question)) continue;
    questions.push({
      ref: task.identifier,
      title: task.title ?? null,
      status: "awaiting",
      awaiting_reason: task.awaiting_reason ?? null,
      question: question?.body ?? null,
      asked_at: question?.created_at ?? null,
      kind: "awaiting",
    });
  }

  const inProgress = await tasksWithStatus(opts, agent, "in_progress");
  if (inProgress.error !== null) errors.push(`in_progress: ${inProgress.error}`);
  for (const task of inProgress.tasks) {
    const { comments, error } = await commentsFor(opts, agent, task.identifier);
    if (error !== null) errors.push(`${task.identifier} comments: ${error}`);
    const question = newestQuestion(comments);
    if (question === null || answeredAfter(comments, question)) continue;
    questions.push({
      ref: task.identifier,
      title: task.title ?? null,
      status: "in_progress",
      question: question.body ?? null,
      asked_at: question.created_at ?? null,
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
        ? ` (pool pid ${result.supervisor.pool.poolPid}, control ${result.supervisor.pool.controlMode})`
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
export async function main(argv, env = process.env, deps = {}) {
  const json = argv.includes("--json");
  let opts;
  try {
    opts = parseArgs(
      argv.filter((arg) => arg !== "--json"),
      env,
    );
  } catch (err) {
    process.stderr.write(`console: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = await consoleCycle(opts, deps);
  process.stdout.write(`${json ? JSON.stringify(result, null, 2) : humanReport(result)}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
