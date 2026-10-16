#!/usr/bin/env node
/**
 * `wake-cwd` — *where* a woken worker must run, decided locally (R1).
 *
 * The supervisor knows a card's board project identity; it knows nothing about
 * directories, and it must not: the board holds none (O3). The mapping from a
 * project to a local directory belongs to the host, in the `projects.json` that
 * sits beside the installed skill
 * (`skills/meerkat-taskpanel/references/projects-json.md`).
 *
 * So the wake glue — the one piece of the chain that *is* host-local — asks this
 * helper, and this helper answers with the one thing the glue needs: an absolute
 * directory to `cd` into. When it cannot answer, it **fails loudly**: no
 * directory is printed, a non-zero status is returned, and the reason goes to
 * stderr. A worker that runs in the wrong directory is worse than a worker that
 * never started, so there is deliberately no fallback and no default — an entry
 * that names no directory at all is one of the ways to have no answer here, even
 * though the map itself treats it as the complete answer "this project has no
 * local directory".
 *
 *   node scripts/wake-cwd.mjs --project <identity> [--projects-json <path>]
 *
 * Exit codes: 0 resolved (the directory is the only thing on stdout),
 *             2 the command line is wrong,
 *             3 nothing could be resolved (unmapped project; an entry that names
 *               no directory; or a directory that is missing / relative / not a
 *               directory).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PROJECTS_JSON_ENV, checkTargetDirectory, parseProjectMap, resolveProjectDir } from "../src/shared/project-dir.mjs";
import { repoRoot } from "../src/shared/runtime-locator.mjs";
import { isEntryPoint } from "../src/shared/entry-guard.mjs";

const USAGE = `Usage: node scripts/wake-cwd.mjs --project <identity> [--projects-json <path>]

Print the absolute directory a worker for a board project identity must run in,
resolved from the host-local project map (projects.json): the entry's
\`local_path\`, or its \`run_dir\` launch pad when it has no directory of its own.
Exits 3 — printing why — rather than guessing a directory when the project is
not mapped, or when its entry names no directory at all (a worker needs a cwd).
`;

/** The map beside the skill, unless a flag or the environment names another. */
export function defaultProjectsJson(env = process.env) {
  const fromEnv = env[PROJECTS_JSON_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return resolve(repoRoot(), "skills", "meerkat-taskpanel", "projects.json");
}

/** @param {string[]} argv @param {object} env */
export function parseArgs(argv, env = process.env) {
  const opts = { project: null, projectsJson: defaultProjectsJson(env), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = (flag) => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (arg === "--project") opts.project = take("--project");
    else if (arg.startsWith("--project=")) opts.project = arg.slice(10);
    else if (arg === "--projects-json") opts.projectsJson = resolve(take("--projects-json"));
    else if (arg.startsWith("--projects-json=")) opts.projectsJson = resolve(arg.slice(16));
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

/**
 * Resolve, or explain why not. `ok` always carries a *directory* — the map's
 * `dir: null` (an entry that names none) is refused here, not passed on.
 *
 * @param {{project?: string|null, projectsJson: string}} opts
 * @returns {{ok: true, dir: string} | {ok: false, code: string, message: string}}
 */
export function resolveWakeDir(opts) {
  let text;
  try {
    text = readFileSync(opts.projectsJson, "utf8");
  } catch (err) {
    return {
      ok: false,
      code: "PROJECT_MAP_UNREADABLE",
      message:
        `cannot read the project map at ${opts.projectsJson} (${err?.code ?? err?.message ?? "unknown error"}).\n` +
        `Create it beside the installed skill — see references/projects-json.md — or point ` +
        `${PROJECTS_JSON_ENV} / --projects-json at it.`,
    };
  }

  const map = parseProjectMap(text, { file: opts.projectsJson });
  if (!map.ok) return { ok: false, code: map.code, message: map.message };

  const resolved = resolveProjectDir({ entries: map.entries, project: opts.project, file: opts.projectsJson });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };

  // An entry that names no directory is a legitimate answer for the map (`dir:
  // null`), but not for a *wake*: a worker is started somewhere, so this one
  // needs a directory the entry does not have. The refusal is the validator's
  // own — asked here about the value that is missing — so there is one wording
  // for "no usable directory", not two.
  if (resolved.dir === null) {
    const required = checkTargetDirectory(undefined, { project: opts.project, file: opts.projectsJson });
    return { ok: false, code: required.code, message: required.message };
  }

  return { ok: true, dir: resolved.dir };
}

export function main(argv, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), env: process.env }) {
  let opts;
  try {
    opts = parseArgs(argv, io.env ?? process.env);
  } catch (err) {
    io.err(`wake-cwd: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    io.out(USAGE);
    return 0;
  }
  if (opts.project === null || opts.project.trim() === "") {
    io.err(`wake-cwd: --project is required (the card's board project identity)\n${USAGE}`);
    return 2;
  }

  const result = resolveWakeDir(opts);
  if (!result.ok) {
    // Loud, and on the error stream: the glue turns this into a refused wake.
    io.err(`wake-cwd: ${result.code}: ${result.message}\n`);
    return 3;
  }
  io.out(`${result.dir}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
