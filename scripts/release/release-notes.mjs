#!/usr/bin/env node
/**
 * Extract the GitHub Release notes for one version from CHANGELOG.md.
 *
 * The release workflow used to slice the file with `awk`; this is the same cut,
 * with the checks the tag gate already made: the section must exist, be dated, and
 * carry real entries (never the bump scaffold).
 *
 *   node scripts/release/release-notes.mjs <vX.Y.Z> [--file CHANGELOG.md]
 *
 * Prints the section body (without the `## [x]` heading) on stdout. Exit 1 when the
 * section is missing, empty or still a scaffold; 2 on usage/unreadable file.
 *
 * Node builtins only; no network, no dependencies.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import { PLACEHOLDER_BULLET, isRealDate, parseVersionSection, parseVersionTag } from "../verify/changelog.mjs";

/** Repository root, resolved from this file (`scripts/release/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The release-notes body for `version`.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {{ok: true, notes: string, date: string}|{ok: false, code: string, error: string}}
 */
export function releaseNotes(changelog, version) {
  const section = parseVersionSection(changelog, version);
  if (section === null) {
    return { ok: false, code: "missing", error: `CHANGELOG.md has no '## [${version}]' section` };
  }
  if (section.date === null || !isRealDate(section.date)) {
    return { ok: false, code: "undated", error: `'## [${version}]' needs a real ' - YYYY-MM-DD' date` };
  }
  const body = section.body.trim();
  if (body === "") {
    return { ok: false, code: "empty", error: `'## [${version}]' has no entries` };
  }
  if (body.includes(PLACEHOLDER_BULLET)) {
    return { ok: false, code: "placeholder", error: `'## [${version}]' still contains the '${PLACEHOLDER_BULLET}' scaffold` };
  }
  return { ok: true, notes: body, date: section.date };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/release/release-notes.mjs <vX.Y.Z> [--file CHANGELOG.md]\n\n" +
        "Prints the filled section body for the release; exits 1 when it is missing or a scaffold.\n",
    );
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write("release-notes: usage: release-notes.mjs <vX.Y.Z> [--file CHANGELOG.md]\n");
    return 2;
  }

  const version = parseVersionTag(positionals[0]);
  if (version === null) {
    process.stderr.write(`release-notes: '${positionals[0]}' is not a version tag\n`);
    return 2;
  }

  const file = values.file === undefined ? join(ROOT, "CHANGELOG.md") : resolve(values.file);
  let changelog;
  try {
    changelog = await readFile(file, "utf8");
  } catch (err) {
    process.stderr.write(`release-notes: cannot read ${file}: ${err.message}\n`);
    return 2;
  }

  const result = releaseNotes(changelog, version);
  if (!result.ok) {
    process.stderr.write(`release-notes: FAILED — ${result.error}\n`);
    return 1;
  }

  process.stdout.write(`${result.notes}\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
