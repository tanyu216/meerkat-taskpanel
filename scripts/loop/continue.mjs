#!/usr/bin/env node
/**
 * The continue entry — the scheduler's periodic judgment turn.
 *
 * It builds a bounded prompt that begins with 继续 and starts the host's
 * headless agent directly. There is no card and no project directory: this is
 * not a worker wake, so it never goes through the wake glue (which refuses an
 * empty project rather than guessing a directory).
 *
 * The turn is where the deterministic loop work lives: the prompt tells the
 * agent to run `patrol.mjs`, then `workflow.mjs`, then `poll.mjs`. Poll is last
 * so a review card dispatched by the workflow pass can be claimed and woken in
 * the same turn.
 *
 * A lock makes the turn single-flight across processes. The scheduler process
 * writes it before spawning, then rewrites it with the child's pid; the next
 * tick sees the live child and skips rather than paying for a second LLM turn.
 *
 * Node builtins only; no network, no dependencies.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../../src/shared/entry-guard.mjs";
import { buildContinuePrompt, planContinueInvocation } from "../../src/shared/scheduling.mjs";

import { loopCommandArgs, parseArgs, resolveLoopConfig, USAGE } from "./options.mjs";
import { spawnContinueTurn } from "./runners.mjs";
import {
  acquireContinueLock,
  createLogger,
  isProcessAlive,
  recordContinuePid,
  releaseContinueLock,
} from "./runtime.mjs";

/**
 * Run one continue turn.
 *
 * @param {object} opts
 * @param {{
 *   log: (line: string) => void,
 *   continueEnabled?: boolean,
 *   spawn?: (opts: object, invocation: object, log: (line: string) => void) => Promise<{ok: boolean, pid?: number, error?: string}>,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function runContinue(opts, deps = {}) {
  const log = deps.log ?? createLogger(opts);
  const continueEnabled = deps.continueEnabled ?? true;
  const spawn = deps.spawn ?? spawnContinueTurn;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;

  if (!continueEnabled) {
    log("continue: disabled (--continue=no)");
    return 0;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const prompt = buildContinuePrompt({
    host: opts.host,
    agent: opts.agents[0],
    nodePath: process.execPath,
    scripts: {
      poll: join(here, "poll.mjs"),
      patrol: join(here, "patrol.mjs"),
      workflow: join(here, "workflow.mjs"),
    },
    commonArgs: loopCommandArgs(opts),
    continueIntervalSeconds: opts.continueInterval,
  });
  const invocation = planContinueInvocation({
    host: opts.host,
    prompt,
    cwd: opts.repo,
    nodePath: process.execPath,
  });

  if (opts.dryRun) {
    const shown = invocation.args.map((arg) => (arg === prompt ? "<continue prompt>" : arg));
    log(`continue: would run: ${invocation.command} ${shown.join(" ")} in ${invocation.cwd}`);
    log(prompt);
    return 0;
  }

  // A turn that hangs must not block the loop forever, but it does get much
  // longer than its cadence: the cap is two cadences or two hours, whichever is
  // larger.
  const maxAgeMs = Math.max(2 * opts.continueInterval * 1000, 2 * 60 * 60 * 1000);
  let lock;
  try {
    lock = acquireContinueLock(opts.continueState, { isAlive, now, maxAgeMs });
  } catch (err) {
    log(`continue: could not take the lock (${err.message}) — skipping`);
    return 1;
  }
  if (!lock.acquired) {
    const holder = lock.holder;
    const who = holder === null ? "another turn is starting" : `previous turn pid ${holder.pid} still running`;
    log(`continue: skipped — ${who}`);
    return 0;
  }

  try {
    const outcome = await spawn(opts, invocation, log);
    if (!outcome?.ok) {
      releaseContinueLock(opts.continueState);
      log(`continue: wake failed: ${outcome?.error ?? "unknown error"}`);
      return 1;
    }
    if (outcome.pid !== undefined && outcome.pid !== null) {
      try {
        recordContinuePid(
          opts.continueState,
          outcome.pid,
          lock.holder?.startedAt ?? new Date(now()).toISOString(),
        );
      } catch (err) {
        log(`continue: could not record the turn pid (${err.message}) — the lock will expire`);
      }
    }
    log(`continue: woke ${opts.host} pid ${outcome.pid ?? "(none)"}`);
    return 0;
  } catch (err) {
    releaseContinueLock(opts.continueState);
    log(`continue: wake failed: ${err.message}`);
    return 1;
  }
}

/**
 * One continue pass with the real host config and logger.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function runOnce(opts, env = process.env) {
  const log = createLogger(opts);
  const { continueEnabled } = resolveLoopConfig(opts, env);
  return runContinue(opts, { log, continueEnabled });
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`continue: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  return runOnce(opts, env);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
