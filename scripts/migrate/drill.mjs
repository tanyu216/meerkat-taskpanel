#!/usr/bin/env node
/**
 * Host wrapper for the M5 in-container migration drill.
 *
 * Per ARCHITECTURE §9.1 nothing that "runs" happens on the host: this script
 * only builds the verify image (if it is missing) and then hands the real work
 * to `docker run`, which executes `docker/migrate-in-container.sh`. The team's
 * cards and `projects.json` are bind-mounted **read-only**; the only thing
 * written back to the host is the JSON report (statistics, hashes, identifiers).
 *
 *   node scripts/migrate/drill.mjs \
 *     --cards ~/.openclaw/team/tasks \
 *     --projects ~/.openclaw/team/projects.json \
 *     --out .data/migrate-out
 *
 *   npm run verify:migrate:container
 *
 * Exit code is the container's: 0 no differences · 3 differences · 2 bad usage ·
 * 1 the run failed. `--print-only` prints the `docker run` line and exits 0
 * without touching anything.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { buildArgs, imageTag } from "../verify/lib/docker-plan.mjs";

const USAGE = `Usage: node scripts/migrate/drill.mjs [options]

Runs the M5 md→SQLite shadow drill inside the container image.

Options:
  --cards <dir>       markdown cards directory   (default: ~/.openclaw/team/tasks)
  --projects <file>   projects.json registry     (default: ~/.openclaw/team/projects.json)
  --out <dir>         host dir for the report    (default: <repo>/.data/migrate-out)
  --image <tag>       image tag                  (default: the verify image)
  --rebuild           build the image even if it already exists
  --no-build          never build; fail if the image is missing
  --print-only        print the docker command and exit without running it
  -h, --help          this text`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = { build: true, rebuild: false, printOnly: false };
  const takesValue = new Set(["--cards", "--projects", "--out", "--image"]);
  const flagOnly = new Set(["--rebuild", "--no-build", "--print-only", "--help", "-h"]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (flagOnly.has(arg)) {
      if (arg === "--no-build") options.build = false;
      else if (arg === "--rebuild") options.rebuild = true;
      else if (arg === "--print-only") options.printOnly = true;
      else options.help = true;
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/**
 * Build the exact `docker run` argument array. Paths are made absolute; the
 * cards dir and registry are `:ro`, the report dir is a normal (writable) mount.
 *
 * @param {{cards: string, projects: string, out: string, image: string}} plan
 * @returns {string[]}
 */
export function dockerRunArgs({ cards, projects, out, image }) {
  return [
    "run",
    "--rm",
    "-v",
    `${cards}:/cards:ro`,
    "-v",
    `${projects}:/projects.json:ro`,
    "-v",
    `${out}:/out`,
    "-e",
    "CARDS_DIR=/cards",
    "-e",
    "PROJECTS_FILE=/projects.json",
    "-e",
    "OUT_DIR=/out",
    image,
    "bash",
    "docker/migrate-in-container.sh",
  ];
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** The `docker …` line a human can copy/paste. */
export function shellLine(args) {
  const quote = (value) => (/[\s"$`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  return `docker ${args.map(quote).join(" ")}`;
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const home = homedir();
  const cards = resolve(options.cards ?? `${home}/.openclaw/team/tasks`);
  const projects = resolve(options.projects ?? `${home}/.openclaw/team/projects.json`);
  const out = resolve(options.out ?? ".data/migrate-out");
  const image = options.image ?? imageTag();

  const runArgs = dockerRunArgs({ cards, projects, out, image });

  if (options.printOnly) {
    process.stdout.write(`${shellLine(runArgs)}\n`);
    return 0;
  }

  const haveImage = run("docker", ["image", "inspect", image]).status === 0;
  const wantBuild = options.build && (!haveImage || options.rebuild === true);
  if (!haveImage && !options.build) {
    process.stderr.write(`image ${image} is missing and --no-build was given\n`);
    return 1;
  }
  if (wantBuild) {
    process.stdout.write(`== docker build -t ${image} ==\n`);
    const build = run("docker", buildArgs("."));
    process.stdout.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    if (build.status !== 0) {
      process.stderr.write(`image build failed — nothing was reconciled\n`);
      return 1;
    }
  }

  // The mounted out dir must accept a write from the container's unprivileged
  // `node` user; group/other-writable is the portable way to say that.
  mkdirSync(out, { recursive: true, mode: 0o777 });

  process.stdout.write(`== ${shellLine(runArgs)} ==\n\n`);
  const result = run("docker", runArgs);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.error) {
    process.stderr.write(`could not run docker: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}

export { USAGE };
