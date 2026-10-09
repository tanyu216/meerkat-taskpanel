#!/usr/bin/env node
/**
 * The tag ↔ CHANGELOG contract.
 *
 * A release tag `vX.Y.Z` is only meaningful if `CHANGELOG.md` says what shipped:
 * without a `## [X.Y.Z]` section the GitHub Release draft is empty and the
 * version is undocumented. This script is the one implementation of that rule;
 * it is shared by
 *
 *   * the local `pre-tag` / `pre-push` hooks (`.husky/`), and
 *   * the CI `version-gate` workflow (`.github/workflows/version-gate.yml`).
 *
 *   node scripts/verify/changelog.mjs v1.2.3          # check the tag
 *   node scripts/verify/changelog.mjs v1.2.3 --base <dir>
 *
 * Exit codes: 0 the version has an entry (or the ref is not a version tag, so
 * there is nothing to gate); 1 the version is missing from the changelog; 2 bad
 * usage, or the changelog file is unreadable.
 *
 * Node builtins only; no network, no dependencies.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The changelog, relative to the tree root. */
export const CHANGELOG_FILE = "CHANGELOG.md";

/** `vX.Y.Z`, `X.Y.Z`, with an optional `-prerelease` / `+build` suffix. */
export const VERSION_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * The version a tag names, or `null` when the ref is not a version tag.
 *
 * Non-version tags (a scratch `docs/experiment`, a `release-candidate` branch
 * ref) are not the gate's business: the caller skips rather than fails.
 *
 * @param {string} tag
 * @returns {string|null}
 */
export function parseVersionTag(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!VERSION_TAG_PATTERN.test(trimmed)) return null;
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/**
 * Find the `## [version]` heading in a changelog body.
 *
 * Matches a Keep-a-Changelog heading (`## [1.2.3] - 2026-10-10`) by comparing the
 * *captured* version string, so a version containing regex metacharacters cannot
 * turn into a pattern. Link-reference lines at the foot of the file (`[1.2.3]: …`)
 * have no `##` and never match; neither does `## [Unreleased]`.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {{line: number, text: string}|null} 1-based line number, or null
 */
export function findVersionEntry(changelog, version) {
  const lines = String(changelog).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+\[([^\]]+)\]/.exec(lines[index]);
    if (match !== null && match[1].trim() === version) {
      return { line: index + 1, text: lines[index] };
    }
  }
  return null;
}

/**
 * Check that a tag has a changelog entry. Never throws for a bad tree: a missing
 * file and a missing entry come back as `{ok: false, …}` so the callers can pick
 * an exit code.
 *
 * @param {{tag: string, base?: string, file?: string}} options
 * @returns {Promise<{ok: boolean, skipped?: boolean, unreadable?: boolean, tag?: string, version?: string, line?: number, error?: string}>}
 */
export async function checkChangelog(options) {
  const { tag, base = ROOT, file = CHANGELOG_FILE } = options;

  const version = parseVersionTag(tag);
  if (version === null) return { ok: true, skipped: true, tag };

  const path = join(base, file);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const why = err !== null && err.code === "ENOENT" ? "file not found" : err.message;
    return { ok: false, unreadable: true, tag, version, error: `${file}: ${why}` };
  }

  const found = findVersionEntry(raw, version);
  if (found === null) {
    return {
      ok: false,
      tag,
      version,
      error: `tag ${tag} has no '## [${version}]' section in ${file}`,
    };
  }

  return { ok: true, tag, version, line: found.line };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/changelog.mjs <vX.Y.Z> [--base <dir>] [--file <name>]\n\n" +
        "  <vX.Y.Z>       the tag to check against the changelog\n" +
        "  --base <dir>   the tree to read from (default: this checkout)\n" +
        "  --file <name>  the changelog file (default: CHANGELOG.md)\n\n" +
        "Exit: 0 has an entry / not a version tag · 1 missing entry · 2 usage or unreadable file\n",
    );
    return 0;
  }

  if (positionals.length !== 1) {
    process.stderr.write("changelog: usage: node scripts/verify/changelog.mjs <vX.Y.Z> [--base <dir>]\n");
    return 2;
  }

  const tag = positionals[0];
  const options = { tag };
  if (values.base !== undefined) options.base = resolve(values.base);
  if (values.file !== undefined) options.file = values.file;

  const result = await checkChangelog(options);

  if (result.skipped === true) {
    process.stdout.write(`changelog: SKIP — ${tag} is not a version tag\n`);
    return 0;
  }
  if (result.unreadable === true) {
    process.stderr.write(`changelog: FAILED — ${result.error}\n`);
    return 2;
  }
  if (!result.ok) {
    process.stderr.write(`changelog: FAILED — ${result.error}\n`);
    process.stderr.write(
      "changelog: add a '## [" + result.version + "]' section to CHANGELOG.md before tagging.\n",
    );
    return 1;
  }

  process.stdout.write(`changelog: OK — ${tag} has a '## [${result.version}]' section (line ${result.line})\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
