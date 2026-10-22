#!/usr/bin/env node
/**
 * `wake-cwd` — the directory a woken worker must run in.
 *
 * The board holds no project directory; the agent-local map (`projects.json`,
 * beside the installed skill) does. This helper answers with an absolute
 * directory for the glue to `cd` into, and fails loudly rather than guessing:
 * no directory on stdout, exit 3, the reason on stderr.
 *
 *   node scripts/wake-cwd.mjs --project <identity> [--projects-json <path>]
 *
 * Exit codes: 0 resolved · 2 bad command line · 3 nothing resolved (unmapped
 * project, an entry naming no directory, or a missing / relative / non-directory).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PROJECTS_JSON_ENV, checkTargetDirectory, parseProjectMap, resolveProjectDir } from "./foundation/project-dir.mjs";
import { repoRoot } from "./foundation/runtime-locator.mjs";
import { isEntryPoint } from "./foundation/entry-guard.mjs";

const USAGE = `Usage: node scripts/wake-cwd.mjs --project <identity> [--projects-json <path>]

Print the absolute directory a worker for a board project identity must run in,
resolved from the agent-local project map (projects.json): the entry's
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

  // `dir: null` is a complete answer for the map, not for a wake: a worker is
  // started somewhere. Reuse the validator's wording for the refusal.
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
