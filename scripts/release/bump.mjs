#!/usr/bin/env node
/**
 * One-shot release version bump.
 *
 * A release version lives in six manifests at once. The list is *not* redeclared
 * here: it is imported from `scripts/verify/version.mjs`, so the checker and the
 * bumper can never disagree about which files carry the version or where.
 * Bumping those six by hand is the long-term source of exactly the drift that
 * `version.mjs` exists to catch; this script makes the bump one command.
 *
 *   node scripts/release/bump.mjs 1.1.0                    # six manifests
 *   node scripts/release/bump.mjs 1.1.0 --changelog        # + a scaffold section
 *   node scripts/release/bump.mjs 1.1.0 --changelog --tag  # + an annotated ref
 *
 * What it guarantees:
 *
 *   * **Format preserved.** Each file is edited *in place*, by splicing the one
 *     version string token's byte span. Never a `JSON.parse` / `stringify` round
 *     trip, which would reorder keys and re-indent the whole document: key order,
 *     indentation, single-line arrays and the trailing newline all survive.
 *   * **Strict input.** The target must be valid semver and strictly greater than
 *     the version the root `package.json` currently declares; anything else is
 *     refused before a byte is written.
 *   * **Atomic.** Every new body is built in memory and staged to a temp file
 *     beside its target; only when *all* stages succeed are they renamed into
 *     place. A failure leaves the tree untouched — a staging failure writes
 *     nothing at all, and a rename failure restores the files already renamed
 *     from their in-memory originals.
 *   * **No push, no publish.** `--tag` creates `v<x.y.z>` and stops; it prints
 *     the `git push` command for a human to run. Nothing here publishes.
 *
 * `--changelog` inserts an *empty* Keep-a-Changelog scaffold (`### Added` /
 * `### Changed` / `### Fixed`, each a placeholder bullet) below `## [Unreleased]`
 * and above the newest released section, and keeps the foot-of-file link
 * references consistent. It never invents a change; a version that already has a
 * section is a refusal, not a duplicate.
 *
 * Exit codes: 0 ok · 1 refused (bad version, not greater, drifted tree,
 * changelog section already present) · 2 usage · 3 a write or tag failed.
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { findVersionEntry } from "../verify/changelog.mjs";
import { VERSION_SOURCES, validateVersions } from "../verify/version.mjs";

/** Repository root, resolved from this file (`scripts/release/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The changelog, relative to the tree root. */
export const CHANGELOG_FILE = "CHANGELOG.md";

/**
 * The six version carriers, derived from the checker's declaration so the two
 * agree by construction. `keys` is the JSON path to the version value, which is
 * how the in-place splice finds the one token to replace (the marketplace hides
 * its version under `metadata`).
 *
 * @type {ReadonlyArray<{label: string, path: string, keys: string[], canonical: boolean}>}
 */
export const SOURCES = Object.freeze(
  VERSION_SOURCES.map((source) =>
    Object.freeze({
      label: source.label,
      path: source.path,
      keys: Object.freeze(source.field.split(".")),
      canonical: source.canonical === true,
    }),
  ),
);

/**
 * Strict semver — the official grammar, so `1.2.3`, `1.2.3-rc.1` and
 * `1.2.3+build` are accepted and `v1.2.3`, `1.2`, `01.2.3` and `latest` are not.
 */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Parse a semver string.
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, prerelease: string[], raw: string}|null} `null` when not valid semver
 */
export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER_PATTERN.exec(value.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
    raw: value.trim(),
  };
}

/**
 * Semver §11 precedence, including prerelease ordering (`1.0.0-rc.1 < 1.0.0`).
 *
 * @param {ReturnType<typeof parseSemver>} a
 * @param {ReturnType<typeof parseSemver>} b
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }

  const left = a.prerelease;
  const right = b.prerelease;
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1; // a release outranks any prerelease
  if (right.length === 0) return -1;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (index >= left.length) return -1; // a shorter set of identifiers sorts first
    if (index >= right.length) return 1;
    const order = compareIdentifiers(left[index], right[index]);
    if (order !== 0) return order;
  }
  return 0;
}

/** Numeric identifiers compare numerically and sort below alphanumeric ones. */
function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Locate the string token a JSON path points at, without reformatting the
 * document.
 *
 * A minimal recursive-descent scanner: it walks the text once, tracking the
 * breadcrumb of keys it is inside, and returns the `[start, end)` byte offsets of
 * the target *including* the surrounding quotes. Everything outside that span is
 * left byte-for-byte alone, which is the whole point — a `JSON.parse` /
 * `JSON.stringify` round trip would not preserve key order or indentation.
 *
 * @param {string} raw a JSON document
 * @param {string[]} keys the key path, e.g. `["version"]` or `["metadata", "version"]`
 * @returns {{start: number, end: number, value: string}|null} the token span, or `null` when the path is absent
 * @throws {SyntaxError} when `raw` is not well-formed JSON
 */
export function findValueSpan(raw, keys) {
  let at = 0;
  const length = raw.length;
  let found = null;

  const fail = (message) => {
    throw new SyntaxError(`${message} (offset ${at})`);
  };
  const skipWhitespace = () => {
    while (at < length && (raw[at] === " " || raw[at] === "\t" || raw[at] === "\n" || raw[at] === "\r")) at += 1;
  };
  const parseString = () => {
    if (raw[at] !== '"') fail("expected a string");
    const start = at;
    at += 1;
    while (at < length) {
      const char = raw[at];
      if (char === "\\") {
        at += 2;
        continue;
      }
      if (char === '"') {
        at += 1;
        return { start, end: at, value: JSON.parse(raw.slice(start, at)) };
      }
      at += 1;
    }
    return fail("unterminated string");
  };
  const skipScalar = () => {
    while (at < length && !",}] \t\n\r".includes(raw[at])) at += 1;
  };
  const isTarget = (crumb) => crumb.length === keys.length && crumb.every((key, index) => key === keys[index]);

  const parseValue = (crumb) => {
    skipWhitespace();
    const char = raw[at];
    if (char === "{") return parseObject(crumb);
    if (char === "[") return parseArray(crumb);
    if (char === '"') {
      const token = parseString();
      if (found === null && isTarget(crumb)) found = token;
      return undefined;
    }
    return skipScalar();
  };

  const parseObject = (crumb) => {
    at += 1; // {
    skipWhitespace();
    if (raw[at] === "}") {
      at += 1;
      return;
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      skipWhitespace();
      if (raw[at] !== ":") fail("expected ':'");
      at += 1;
      parseValue([...crumb, key.value]);
      skipWhitespace();
      if (raw[at] === ",") {
        at += 1;
        continue;
      }
      if (raw[at] === "}") {
        at += 1;
        return;
      }
      return fail("expected ',' or '}'");
    }
  };

  const parseArray = (crumb) => {
    at += 1; // [
    skipWhitespace();
    if (raw[at] === "]") {
      at += 1;
      return;
    }
    let index = 0;
    for (;;) {
      parseValue([...crumb, String(index)]);
      index += 1;
      skipWhitespace();
      if (raw[at] === ",") {
        at += 1;
        continue;
      }
      if (raw[at] === "]") {
        at += 1;
        return;
      }
      return fail("expected ',' or ']'");
    }
  };

  parseValue([]);
  skipWhitespace();
  if (at !== length) fail("trailing content after the JSON document");
  return found;
}

// ---------------------------------------------------------------------------
// Planning — everything is decided in memory before a byte is written
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in local time (a release date is a human's, not UTC's). */
function localDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Read a tree and work out the six in-place edits that would move it to
 * `version`. Writes nothing; on any problem returns `{ok: false}` with a `code`
 * the CLI maps to an exit status.
 *
 * @param {{version: string, base?: string, sources?: typeof SOURCES}} options
 * @returns {Promise<
 *   | {ok: true, version: string, previous: string, entries: {path: string, label: string, absolute: string, before: string, after: string}[]}
 *   | {ok: false, code: string, error: string}
 * >}
 */
export async function planBump({ version, base = ROOT, sources = SOURCES }) {
  const target = parseSemver(version);
  if (target === null) {
    return {
      ok: false,
      code: "invalid-version",
      error: `'${version}' is not valid semver — expected MAJOR.MINOR.PATCH (e.g. 1.2.3, optionally -rc.1)`,
    };
  }

  // One read pass that both establishes the current version and proves the tree
  // is not already drifted: bumping six files onto a seventh value would quietly
  // bury the drift instead of resolving it.
  const checked = await validateVersions(base);
  if (!checked.ok) {
    return {
      ok: false,
      code: checked.kind === "read" ? "unreadable-tree" : "drift",
      error: `refusing to bump an inconsistent tree.\n${checked.error}`,
    };
  }

  const current = parseSemver(checked.version);
  if (current === null) {
    return { ok: false, code: "current-invalid", error: `the current version '${checked.version}' is not valid semver` };
  }
  if (compareSemver(target, current) <= 0) {
    return {
      ok: false,
      code: "not-greater",
      error: `${target.raw} is not greater than the current version ${current.raw} — a bump must move forward`,
    };
  }

  const entries = [];
  for (const source of sources) {
    const absolute = join(base, source.path);
    let before;
    try {
      before = await readFile(absolute, "utf8");
    } catch (error) {
      const why = error !== null && error.code === "ENOENT" ? "file not found" : error.message;
      return { ok: false, code: "unreadable-tree", error: `${source.path}: ${why}` };
    }

    let span;
    try {
      span = findValueSpan(before, source.keys);
    } catch (error) {
      return { ok: false, code: "unreadable-tree", error: `${source.path}: ${error.message}` };
    }
    if (span === null) {
      return { ok: false, code: "missing-field", error: `${source.path}: no \`${source.keys.join(".")}\` string to replace` };
    }
    if (span.value !== checked.version) {
      return {
        ok: false,
        code: "unexpected-value",
        error: `${source.path}: \`${source.keys.join(".")}\` is '${span.value}', expected '${checked.version}'`,
      };
    }

    // Splice the one token; every other byte, including the newline at EOF, is
    // the original.
    const after = `${before.slice(0, span.start)}${JSON.stringify(target.raw)}${before.slice(span.end)}`;
    entries.push({ path: source.path, label: source.label, absolute, before, after });
  }

  // Prove the result before it is ever written: it must still parse, and the
  // token must now read back as the target.
  for (const entry of entries) {
    try {
      const reparsed = findValueSpan(entry.after, sources.find((source) => source.path === entry.path).keys);
      if (reparsed === null || reparsed.value !== target.raw) {
        return { ok: false, code: "internal", error: `${entry.path}: the rewrite did not land (this is a bug in bump.mjs)` };
      }
    } catch (error) {
      return { ok: false, code: "internal", error: `${entry.path}: the rewrite produced invalid JSON — ${error.message}` };
    }
  }

  return { ok: true, version: target.raw, previous: current.raw, entries };
}

/**
 * Work out the changelog edit for `version`: an empty scaffold section below
 * `## [Unreleased]`, plus the matching link references at the foot of the file.
 *
 * The heading is written in the exact form the tag gate looks for
 * (`scripts/verify/changelog.mjs` `findVersionEntry`), and an existing section is
 * refused rather than duplicated.
 *
 * @param {{version: string, base?: string, date?: string, file?: string}} options
 * @returns {Promise<
 *   | {ok: true, entry: {path: string, label: string, absolute: string, before: string, after: string}}
 *   | {ok: false, code: string, error: string}
 * >}
 */
export async function planChangelog({ version, base = ROOT, date, file = CHANGELOG_FILE }) {
  const absolute = join(base, file);
  let before;
  try {
    before = await readFile(absolute, "utf8");
  } catch (error) {
    const why = error !== null && error.code === "ENOENT" ? "file not found" : error.message;
    return { ok: false, code: "changelog-unreadable", error: `${file}: ${why}` };
  }

  if (findVersionEntry(before, version) !== null) {
    return { ok: false, code: "changelog-exists", error: `${file} already documents ${version} — not inserting a second section` };
  }

  const day = date ?? localDate(new Date());
  const block = [
    `## [${version}] - ${day}`,
    "",
    "### Added",
    "",
    "- _Nothing yet._",
    "",
    "### Changed",
    "",
    "- _Nothing yet._",
    "",
    "### Fixed",
    "",
    "- _Nothing yet._",
    "",
  ];

  const lines = before.split("\n");
  const at = findInsertionPoint(lines);
  const inserted = [...lines.slice(0, at), ...block, ...lines.slice(at)];
  const after = updateLinkRefs(inserted, version);

  return { ok: true, entry: { path: file, label: "changelog", absolute, before, after }, date: day };
}

/**
 * The line a new released section goes above: the newest released `## [` heading,
 * so `## [Unreleased]` keeps the top. Falls back to the end of the Unreleased
 * block, then to just above the link references, then to EOF.
 */
function findInsertionPoint(lines) {
  const released = lines.findIndex((line) => /^##\s+\[/.test(line) && !/^##\s+\[Unreleased\]/.test(line));
  if (released !== -1) return released;

  const unreleased = lines.findIndex((line) => /^##\s+\[Unreleased\]/.test(line));
  if (unreleased !== -1) {
    for (let index = unreleased + 1; index < lines.length; index += 1) {
      if (/^##\s+\[/.test(lines[index]) || /^\[[^\]]+\]:/.test(lines[index])) return index;
    }
    return lines.length;
  }

  const reference = lines.findIndex((line) => /^\[[^\]]+\]:/.test(line));
  return reference === -1 ? lines.length : reference;
}

/**
 * Keep the `[Unreleased]` compare link and the new `[x.y.z]` release link
 * consistent. Strictly derived from what the file already says — the repository
 * URL is read off the existing `[Unreleased]:` line, never hard-coded — and a
 * file without a link-reference block is left as it is.
 */
function updateLinkRefs(lines, version) {
  const at = lines.findIndex((line) => /^\[Unreleased\]:\s*\S+/.test(line));
  if (at === -1) return lines.join("\n");

  const root = /^\[Unreleased\]:\s*(\S+?)\/compare\//.exec(lines[at]);
  if (root === null) return lines.join("\n");

  const updated = [...lines];
  updated[at] = updated[at].replace(/\/compare\/v\S+?\.\.\.HEAD/, `/compare/v${version}...HEAD`);
  if (!updated.some((line) => line.startsWith(`[${version}]:`))) {
    updated.splice(at, 0, `[${version}]: ${root[1]}/releases/tag/v${version}`);
  }
  return updated.join("\n");
}

// ---------------------------------------------------------------------------
// Applying — stage everything, then commit everything
// ---------------------------------------------------------------------------

/**
 * Write the planned entries atomically.
 *
 * Phase 1 stages every body to a temp file beside its target; a failure here
 * removes the temps and touches no real file. Phase 2 renames the temps into
 * place; a failure here puts the already-renamed files back from the in-memory
 * originals and removes any temp left over. Either way a non-zero result means
 * the tree is as it was.
 *
 * The `io` seam exists so the failure paths can be driven in a test; production
 * callers leave it alone.
 *
 * @param {{absolute: string, path: string, before: string, after: string}[]} entries
 * @param {{io?: {writeFile: typeof writeFile, rename: typeof rename, rm: typeof rm}}} [options]
 * @returns {Promise<{ok: true} | {ok: false, code: "stage-failed"|"commit-failed", error: string, rolledBack: boolean}>}
 */
export async function applyWrites(entries, { io } = {}) {
  const adapter = io ?? { writeFile, rename, rm };
  const tempFor = (entry) => `${entry.absolute}.bump-${process.pid}.tmp`;

  const cleanup = async (items) => {
    for (const item of items) {
      try {
        await adapter.rm(tempFor(item), { force: true });
      } catch {
        // A temp that cannot be removed is not worth masking the real error with;
        // the failure below already names what went wrong.
      }
    }
  };

  const staged = [];
  for (const entry of entries) {
    try {
      await adapter.writeFile(tempFor(entry), entry.after, "utf8");
    } catch (error) {
      await cleanup(staged);
      return {
        ok: false,
        code: "stage-failed",
        rolledBack: true,
        error: `staging ${entry.path} failed, nothing was written (${error.message})`,
      };
    }
    staged.push(entry);
  }

  const committed = [];
  for (const entry of staged) {
    try {
      await adapter.rename(tempFor(entry), entry.absolute);
    } catch (error) {
      const restoreFailures = [];
      for (const done of [...committed].reverse()) {
        try {
          await adapter.writeFile(done.absolute, done.before, "utf8");
        } catch (restoreError) {
          restoreFailures.push(`${done.path} (${restoreError.message})`);
        }
      }
      await cleanup(staged.filter((item) => !committed.includes(item)));
      const restored = restoreFailures.length === 0;
      return {
        ok: false,
        code: "commit-failed",
        rolledBack: restored,
        error:
          `writing ${entry.path} failed (${error.message}); ` +
          (restored
            ? `the ${committed.length} file(s) already written were restored`
            : `could NOT restore ${restoreFailures.join(", ")} — check the working tree by hand`),
      };
    }
    committed.push(entry);
  }

  return { ok: true };
}

/** Codes whose failure means the tree may need a manual look, not just a re-run. */
const WRITE_CODES = new Set(["stage-failed", "commit-failed", "tag-failed"]);

/**
 * Bump the six manifests — and optionally the changelog and a git tag — in one
 * call. Plan, then apply: no write happens until every write is known to be
 * possible.
 *
 * @param {{version: string, base?: string, changelog?: boolean, tag?: boolean, date?: string,
 *          io?: Parameters<typeof applyWrites>[1]["io"], run?: typeof spawnSync}} [options]
 * @returns {Promise<{ok: true, version: string, previous: string,
 *   entries: {path: string, label: string, absolute: string, before: string, after: string}[],
 *   changelog: {path: string, label: string, absolute: string, before: string, after: string}|null,
 *   tagged: string|null, date: string|null}
 *   | {ok: false, code: string, error: string, entries?: unknown[]}>}
 */
export async function runBump(options = {}) {
  const { version, base = ROOT, changelog = false, tag = false, date, io, run = spawnSync } = options;

  const planned = await planBump({ version, base });
  if (!planned.ok) return planned;

  const entries = [...planned.entries];
  let changelogEntry = null;
  let changelogDate = null;
  if (changelog) {
    const scaffold = await planChangelog({ version: planned.version, base, date });
    if (!scaffold.ok) return scaffold;
    changelogEntry = scaffold.entry;
    changelogDate = scaffold.date;
    entries.push(changelogEntry);
  }

  const applied = await applyWrites(entries, io === undefined ? undefined : { io });
  if (!applied.ok) return { ok: false, code: applied.code, error: applied.error, entries };

  let tagged = null;
  if (tag) {
    const name = `v${planned.version}`;
    const result = run("git", ["tag", name], { cwd: resolve(base), encoding: "utf8" });
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, code: "tag-failed", entries, error: `git tag ${name} failed: ${result.error.message} — the files were written` };
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim() || `exit ${result.status}`;
      return { ok: false, code: "tag-failed", entries, error: `git tag ${name} failed: ${detail} — the files were written` };
    }
    tagged = name;
  }

  return {
    ok: true,
    version: planned.version,
    previous: planned.previous,
    entries,
    changelog: changelogEntry,
    tagged,
    date: changelogDate,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/release/bump.mjs <x.y.z> [options]

  <x.y.z>        the new version (strict semver; must be greater than the current one)
  --changelog    also insert an empty Keep-a-Changelog scaffold section
  --tag          also create the git tag v<x.y.z> after the bump (never pushed)
  --base <dir>   bump a tree rooted at <dir> (default: this checkout)

Exit: 0 ok · 1 refused · 2 usage · 3 a write or tag failed
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      changelog: { type: "boolean", default: false },
      tag: { type: "boolean", default: false },
      base: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`bump: usage: node scripts/release/bump.mjs <x.y.z> [--changelog] [--tag] [--base <dir>]\n`);
    return 2;
  }

  const base = values.base === undefined ? ROOT : resolve(values.base);
  const result = await runBump({
    version: positionals[0],
    base,
    changelog: values.changelog,
    tag: values.tag,
  });

  if (!result.ok) {
    process.stderr.write(`bump: FAILED — ${result.error}\n`);
    if (WRITE_CODES.has(result.code)) {
      const paths = (result.entries ?? []).map((entry) => entry.path);
      if (paths.length > 0) {
        process.stderr.write(`bump: inspect with \`git status\`; to discard the tree, \`git checkout -- ${paths.join(" ")}\`\n`);
      }
    }
    return WRITE_CODES.has(result.code) ? 3 : 1;
  }

  process.stdout.write(`bump: ${result.previous} → ${result.version}\n`);
  for (const entry of result.entries) {
    if (entry.label === "changelog") continue;
    process.stdout.write(`  ${entry.path}\n`);
  }
  if (result.changelog !== null) {
    process.stdout.write(`changelog: inserted '## [${result.version}] - ${result.date}' into ${result.changelog.path}\n`);
  }
  if (result.tagged !== null) {
    process.stdout.write(`tag: created ${result.tagged} (not pushed)\n`);
    process.stdout.write(`push: git push origin ${result.tagged}\n`);
  }
  process.stdout.write(`bump: OK — ${result.entries.length - (result.changelog === null ? 0 : 1)} manifests now at ${result.version}\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
