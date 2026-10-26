#!/usr/bin/env node
/**
 * Generate and guard the **loop payload** — the CLI entry point for CI and developers.
 * `--check` verifies the payload is current without writing anything, and is wired into
 * CI (`npm run check:loop`). The generator itself lives in `scripts/loop-payload.mjs`.
 *
 * There are **no committed copies of a skill anywhere** in this repository. Each harness
 * resolves the one `skills/` tree through its own manifest, all of which live at the
 * repository root (the root *is* the board's plugin root):
 *
 *   * `.claude-plugin/plugin.json` — claude, and codex (the same `./` marketplace bundle);
 *   * the root `package.json`'s `pi` field — Pi.
 *
 * OpenClaw reads that same root bundle too. It receives the board skill only, **never**
 * `meerkat-loop` — it already runs an equivalent supervisor in the openclaw-team
 * framework, and installing both would be two supervisors racing one board; that ruling
 * (O3) is enforced by `install.sh --target openclaw`, which copies just the board skill
 * (the split is T-20261012-163500-loopdecouple-b).
 *
 * What is left to generate is the loop's own payload: its execution body and its installer
 * templates are *generated into* `skills/meerkat-loop/` from this repository's own
 * `scripts/`, `src/foundation/` and `scripts/install/templates/`, by
 * `scripts/loop-payload.mjs`. This script is the entry point for that, and `--check`
 * guards it.
 *
 * The earlier shape of this tool also synced per-agent-kind copies into `plugins/<target>/`;
 * those are gone, and `test/scaffold.test.mjs` now carries the "exactly one skills tree"
 * invariant instead — see the 2026-10-17 decision note in
 * `design/plugin-distribution-plan.md`.
 *
 * No dependencies; Node builtins only.
 */

import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { syncLoop } from "./loop-payload.mjs";
import { isEntryPoint } from "../src/foundation/entry-guard.mjs";

/** The board skill — the default for every function that takes a skill name. */
export const DEFAULT_SKILL = "meerkat-taskpanel";

/**
 * Absolute path to a skill source of truth.
 * @param {string} root repository root
 * @param {string} [skill] skill directory name
 * @returns {string}
 */
export function resolveSkillSource(root, skill = DEFAULT_SKILL) {
  return join(resolve(root), "skills", skill);
}

/**
 * Recursive file listing, as paths relative to `dir`, sorted, using `/` separators.
 * Returns an empty array if `dir` does not exist.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir) {
  const out = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(dir, abs).split(sep).join("/"));
      }
    }
  }

  await walk(resolve(dir));
  return out.sort();
}

/** Repository root implied by this file's location (scripts/ → up one level). */
function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseArgs(argv) {
  const opts = { check: false, root: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--root") opts.root = argv[++i];
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else {
      process.stderr.write(`sync-loop: unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

const USAGE = `Usage: node scripts/sync-loop.mjs [--check] [--root <dir>]

Generates the loop payload (execution body + installer templates) inside
skills/meerkat-loop/, from scripts/, src/foundation/ and scripts/install/templates/.
The generator itself is scripts/loop-payload.mjs.

There are no committed skill copies to sync: every harness reads the repository's own
skills/ tree through a manifest at the repository root. See the file header for the
per-harness list.

Options:
  --check        Only verify the payload is in sync; do not write.
  --root <dir>   Repository root (default: this repository).
  -h, --help     Show this help.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const root = opts.root ?? defaultRoot();

  const loop = await syncLoop({ root, check: opts.check });
  console.log(`${opts.check ? "Checking" : "Generating"} the loop payload (source: ${loop.skill})`);
  for (const file of loop.files) {
    const label = file.state === "equal" ? "OK" : file.state;
    console.log(`  ${label.padEnd(8)} ${relative(loop.skill, file.dest)}`);
  }
  console.log(
    `  ${(loop.manifest.state === "equal" ? "OK" : loop.manifest.state).padEnd(8)} manifest.txt (${loop.body.length} files)`,
  );

  if (loop.ok) {
    console.log(opts.check ? "loop payload: OK" : "loop payload: OK (the files written)");
    return 0;
  }

  console.error(
    opts.check
      ? "\nloop payload: OUT OF DATE — run `node scripts/sync-loop.mjs` and commit the result."
      : "\nloop payload: FAILED — the generated loop payload does not match its sources.",
  );
  return 1;
}

// Only run when executed directly, so tests can import the functions above.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}

export { main as run };
