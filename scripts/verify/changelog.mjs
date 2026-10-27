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
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

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
 * Is this ref in the reserved release namespace (`v…`)?
 *
 * `v` is not a free prefix: the release rulesets target it and `release.yml` runs on
 * it, so a `v`-prefixed ref that is not `vMAJOR.MINOR.PATCH` is a mistake, not a
 * scratch tag. Callers skip a non-version tag (a `docs/experiment` ref is none of
 * this gate's business) but **fail** a reserved-but-malformed one.
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isReleaseTag(tag) {
  return typeof tag === "string" && /^v/i.test(tag.trim());
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

/** A section heading: `## [x]` with an optional ` - YYYY-MM-DD` suffix. */
const SECTION_HEADING = /^##\s+\[([^\]]+)\](.*)$/;
/** A link-reference line (`[1.2.3]: https://…`) — a section body stops above it. */
const LINK_REFERENCE = /^\[[^\]]+\]:\s/;
/** A top-level bullet in a section. */
const SECTION_BULLET = /^-\s+/;
/** The scaffold's placeholder; a strict gate must never accept it. */
export const PLACEHOLDER_BULLET = "_Nothing yet._";

/**
 * Is `value` a real calendar date in `YYYY-MM-DD` form?
 *
 * The regex alone accepts `2026-02-30`; `Date` normalizes it to March 2, so the
 * round-trip is what rejects an impossible day.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Parse one full changelog section: its heading, date, body and top-level bullets.
 *
 * A section runs from its `## [version]` heading to the next `## [...]` heading or
 * the foot-of-file link-reference block. Sub-headings (`### Added`, …) stay inside
 * the body, which is why the caller can look for a placeholder anywhere in it.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {{heading: string, line: number, endLine: number, date: string|null, body: string, bullets: string[]}|null}
 */
export function parseVersionSection(changelog, version) {
  const lines = String(changelog).split("\n");
  const start = lines.findIndex((line) => {
    const match = SECTION_HEADING.exec(line);
    return match !== null && match[1].trim() === version;
  });
  if (start === -1) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SECTION_HEADING.test(lines[index]) || LINK_REFERENCE.test(lines[index])) {
      end = index;
      break;
    }
  }

  const heading = lines[start];
  const suffix = SECTION_HEADING.exec(heading)?.[2]?.trim() ?? "";
  const dateMatch = /^-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(suffix);
  const bodyLines = lines.slice(start + 1, end);

  return {
    heading,
    line: start + 1,
    endLine: end,
    date: dateMatch === null ? null : dateMatch[1],
    body: bodyLines.join("\n"),
    bullets: bodyLines.filter((line) => SECTION_BULLET.test(line)),
  };
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
  const { tag, base = ROOT, file = CHANGELOG_FILE, strict = false } = options;

  const version = parseVersionTag(tag);
  if (version === null) {
    if (isReleaseTag(tag)) {
      return {
        ok: false,
        tag,
        code: "malformed",
        error: `'${tag}' is a release tag, but its name must be vMAJOR.MINOR.PATCH (e.g. v1.2.3)`,
      };
    }
    return { ok: true, skipped: true, tag };
  }

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

  if (strict) {
    const section = parseVersionSection(raw, version);
    if (section === null) {
      return { ok: false, tag, version, error: `tag ${tag} has no '## [${version}]' section in ${file}` };
    }
    if (section.date === null || !isRealDate(section.date)) {
      return {
        ok: false,
        tag,
        version,
        code: "strict-date",
        error: `tag ${tag}: '## [${version}]' needs a real ' - YYYY-MM-DD' date`,
      };
    }
    if (section.body.includes(PLACEHOLDER_BULLET)) {
      return {
        ok: false,
        tag,
        version,
        code: "strict-placeholder",
        error: `tag ${tag}: '## [${version}]' still contains the '${PLACEHOLDER_BULLET}' scaffold`,
      };
    }
    const entries = section.bullets.filter((bullet) => bullet.replace(SECTION_BULLET, "").trim() !== "");
    if (entries.length === 0) {
      return {
        ok: false,
        tag,
        version,
        code: "strict-empty",
        error: `tag ${tag}: '## [${version}]' has no entries`,
      };
    }

    const unreleased = parseVersionSection(raw, "Unreleased");
    if (unreleased !== null) {
      const dirty = unreleased.bullets.filter((bullet) => !bullet.includes(PLACEHOLDER_BULLET));
      if (dirty.length > 0) {
        return {
          ok: false,
          tag,
          version,
          code: "unreleased-dirty",
          error: `'## [Unreleased]' still has ${dirty.length} entr${dirty.length === 1 ? "y" : "ies"} — move them into the release section`,
        };
      }
    }
  }

  return { ok: true, tag, version, line: found.line };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      file: { type: "string" },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/changelog.mjs <vX.Y.Z> [--base <dir>] [--file <name>] [--strict]\n\n" +
        "  <vX.Y.Z>       the tag to check against the changelog\n" +
        "  --base <dir>   the tree to read from (default: this checkout)\n" +
        "  --file <name>  the changelog file (default: CHANGELOG.md)\n" +
        "  --strict       require a real date, real entries, and an empty [Unreleased]\n\n" +
        "Exit: 0 has an entry / not a version tag · 1 missing, insufficient or malformed · 2 usage or unreadable file\n",
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
  if (values.strict) options.strict = true;

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
    if (result.code === "malformed") {
      // No section hint: the tag itself is the problem, not the changelog.
      return 1;
    }
    if (values.strict) {
      process.stderr.write(
        "changelog: fill the release section before tagging — no placeholders, a real date, and an empty [Unreleased].\n",
      );
    } else {
      process.stderr.write(
        "changelog: add a '## [" + result.version + "]' section to CHANGELOG.md before tagging.\n",
      );
    }
    return 1;
  }

  process.stdout.write(`changelog: OK — ${tag} has a '## [${result.version}]' section (line ${result.line})\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
