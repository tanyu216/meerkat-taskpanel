/**
 * `taskctl loop compat` — the board-interface gate.
 *
 * The decision is `foundation/board-compat.mjs`; this module owns only the
 * process boundary (`--cli`/`--repo` may name a foreign tree) and the output.
 * Exit codes: 0 compatible · 2 usage · 3 no verdict (unreachable, or a
 * board below the floor).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { checkBoard, resolveBoardCommand } from "../foundation/board-compat.mjs";

/** @param {string} command @param {string[]} args */
function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * @param {object} ctx the CLI context (`flags`, `env`, `out`, `err`)
 * @param {{cli?: string|null, repo?: string|null}} [options]
 * @returns {Promise<{streamed: true, exit: number}>}
 */
export async function runCompat(ctx, options = {}) {
  const out = ctx.out ?? ((text) => process.stdout.write(text));
  const err = ctx.err ?? ((text) => process.stderr.write(text));
  const cli = options.cli ?? ctx.flags?.cli ?? null;
  const repo = options.repo ?? ctx.flags?.repo ?? null;

  // A path the caller named explicitly and that is not there is a typo, not a
  // verdict — the same rule the retired script used.
  if (cli && !existsSync(cli)) {
    err(`loop compat: --cli not found: ${cli}\n`);
    return { streamed: true, exit: 2 };
  }

  const { command, args } = resolveBoardCommand({ cli, repo, env: ctx.env });
  const result = checkBoard({ command, args, run: defaultRun });

  if (ctx.flags?.json === true) {
    out(`${JSON.stringify(result, null, 2)}\n`);
    return { streamed: true, exit: result.ok ? 0 : 3 };
  }

  if (result.ok) {
    if (ctx.flags?.quiet !== true) {
      out(
        `loop compat: OK — board ${result.version} ` +
          `(contract schema_version ${result.schemaVersion ?? "?"}) satisfies ${result.boardInterface}\n`,
      );
    }
    return { streamed: true, exit: 0 };
  }

  err(`loop compat: ${result.code}: ${result.message}\n`);
  return { streamed: true, exit: 3 };
}
