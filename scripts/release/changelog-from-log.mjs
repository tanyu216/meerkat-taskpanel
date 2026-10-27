#!/usr/bin/env node
/**
 * Fill a release's CHANGELOG section from the commits that make up the release.
 *
 * The release-prep workflow runs this after `bump --changelog` has inserted the
 * scaffold. It turns `git log --no-merges <from>..HEAD` into Keep-a-Changelog
 * groups, strips the identifiers the release notes must not carry (card ids, PR
 * numbers, commit hashes), and rewrites *only* that version's section.
 *
 *   node scripts/release/changelog-from-log.mjs <x.y.z> --from <ref> [--base <dir>] [--date YYYY-MM-DD]
 *
 * The output is a draft: the release PR's human editor owns the final wording.
 * A release with no surviving entries is an error, never `_Nothing yet._`.
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import { PLACEHOLDER_BULLET, parseVersionSection } from "../verify/changelog.mjs";

/** Repository root, resolved from this file (`scripts/release/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CHANGELOG_FILE = "CHANGELOG.md";

/** Conventional-commit type to Keep-a-Changelog group. */
const GROUP_BY_TYPE = Object.freeze({
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Removed",
});

/** Types whose commits are internal and never ship a user-visible note. */
const OMIT_TYPES = new Set(["docs", "chore", "test", "build", "ci", "style"]);

/** `type(scope)!: subject` (or a bare subject for a non-conventional commit). */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i;

/** Card / issue identifiers and PR references the notes must not carry. */
const CARD_ID = /\b[A-Z]{1,4}-\d{8}-\d{6}(?:-[A-Za-z0-9._-]+)?\b/g;
const PR_REF = /\(#\d+\)|#\d+/g;
const COMMIT_HASH = /\([0-9a-f]{7,40}\)/gi;

/**
 * Strip the machine identifiers from a subject, leaving the sentence a reader can use.
 * @param {string} subject
 * @returns {string}
 */
export function cleanSubject(subject) {
  return String(subject)
    .replace(CARD_ID, "")
    .replace(COMMIT_HASH, "")
    .replace(PR_REF, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
    .trim();
}

/**
 * Group raw git-log records into Keep-a-Changelog sections.
 *
 * A record is `<subject>\x1f<body>\x1e` (the format `git log --format=%s%x1f%b%x1e`
 * produces). Merge commits, internal types and duplicates are dropped; a `!` or a
 * `BREAKING CHANGE:` footer marks the bullet `**BREAKING**`.
 *
 * @param {string} raw
 * @returns {{Added: string[], Changed: string[], Removed: string[], Fixed: string[]}}
 */
export function groupCommits(raw) {
  const groups = { Added: [], Changed: [], Removed: [], Fixed: [] };
  const seen = new Set();

  for (const record of String(raw).split("\x1e")) {
    const [subjectLine = "", ...bodyParts] = record.split("\x1f");
    const subjectRaw = subjectLine.trim();
    if (subjectRaw === "" || /^merge\b/i.test(subjectRaw)) continue;

    const match = CONVENTIONAL.exec(subjectRaw);
    const type = match === null ? "" : match[1].toLowerCase();
    const scope = match === null ? "" : (match[2] ?? "").trim();
    const bang = match === null ? false : match[3] === "!";
    const subject = match === null ? subjectRaw : match[4];

    if (OMIT_TYPES.has(type)) continue;

    const body = bodyParts.join("\x1f");
    const breaking = bang || /^BREAKING[ -]CHANGE:/m.test(body);
    const group = GROUP_BY_TYPE[type] ?? "Changed";
    const cleaned = cleanSubject(subject);
    if (cleaned === "") continue;

    const bullet = `${breaking ? "**BREAKING** " : ""}${scope === "" ? "" : `**${scope}:** `}${cleaned}`;
    if (seen.has(bullet)) continue;
    seen.add(bullet);
    groups[group].push(bullet);
  }

  return groups;
}

/** Render the groups as Keep-a-Changelog subsections; empty groups are omitted. */
export function renderGroups(groups) {
  return ["Added", "Changed", "Removed", "Fixed"]
    .filter((name) => Array.isArray(groups[name]) && groups[name].length > 0)
    .map((name) => [`### ${name}`, "", ...groups[name].map((bullet) => `- ${bullet}`)].join("\n"))
    .join("\n\n");
}

/**
 * Replace one version's section body with the generated groups.
 *
 * The heading is preserved; a heading without a date gets one. The `[Unreleased]`
 * section is emptied — the release is the destination for those entries.
 *
 * @param {string} changelog
 * @param {string} version
 * @param {ReturnType<typeof groupCommits>} groups
 * @param {string} date `YYYY-MM-DD`
 * @returns {{ok: true, changelog: string, date: string}|{ok: false, code: string, error: string}}
 */
export function fillSection(changelog, version, groups, date) {
  const section = parseVersionSection(changelog, version);
  if (section === null) {
    return { ok: false, code: "section-missing", error: `CHANGELOG.md has no '## [${version}]' section` };
  }

  const body = renderGroups(groups);
  if (body === "") {
    return {
      ok: false,
      code: "empty-changelog",
      error: `no releasable commits for ${version} — widen the range or write the section by hand`,
    };
  }

  const heading = section.date === null ? `## [${version}] - ${date}` : section.heading;
  const lines = String(changelog).split("\n");
  let next = [
    ...lines.slice(0, section.line - 1),
    heading,
    "",
    ...body.split("\n"),
    "",
    ...lines.slice(section.endLine),
  ].join("\n");

  // `[Unreleased]` is a mailbox, not a second release: after the entries have
  // moved into their section, the box is empty.
  const unreleased = parseVersionSection(next, "Unreleased");
  if (unreleased !== null && unreleased.body.trim() !== "") {
    const nextLines = next.split("\n");
    next = [
      ...nextLines.slice(0, unreleased.line - 1),
      unreleased.heading,
      "",
      ...nextLines.slice(unreleased.endLine),
    ].join("\n");
  }

  return { ok: true, changelog: next, date: section.date ?? date };
}

/** Both sides of a date: the release heading's date, or today when it has none. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      base: { type: "string" },
      date: { type: "string" },
      "log-file": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/release/changelog-from-log.mjs <x.y.z> --from <ref> [--base <dir>] [--date YYYY-MM-DD]\n" +
        "       node scripts/release/changelog-from-log.mjs <x.y.z> --log-file <raw>\n\n" +
        "  <x.y.z>        the release whose section is filled\n" +
        "  --from <ref>   the previous release; logs <ref>..HEAD\n" +
        "  --log-file     read an already-produced git-log format file instead of running git\n" +
        "  --base <dir>   the tree (default: this checkout)\n" +
        "  --date         the heading date when the section has none (default: today)\n",
    );
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write("changelog-from-log: usage: changelog-from-log.mjs <x.y.z> --from <ref>\n");
    return 2;
  }

  const version = positionals[0];
  const base = values.base === undefined ? ROOT : resolve(values.base);
  const date = values.date ?? today();

  let raw;
  if (values["log-file"] !== undefined) {
    raw = await readFile(values["log-file"], "utf8");
  } else if (values.from !== undefined) {
    const result = spawnSync(
      "git",
      ["log", "--no-merges", "--format=%s%x1f%b%x1e", `${values.from}..HEAD`],
      { cwd: base, encoding: "utf8" },
    );
    if (result.error !== undefined && result.error !== null) {
      process.stderr.write(`changelog-from-log: git log failed: ${result.error.message}\n`);
      return 2;
    }
    if (result.status !== 0) {
      process.stderr.write(`changelog-from-log: git log failed: ${(result.stderr ?? "").trim()}\n`);
      return 2;
    }
    raw = result.stdout;
  } else {
    process.stderr.write("changelog-from-log: one of --from or --log-file is required\n");
    return 2;
  }

  const groups = groupCommits(raw);
  const file = join(base, CHANGELOG_FILE);
  const changelog = await readFile(file, "utf8");
  const filled = fillSection(changelog, version, groups, date);
  if (!filled.ok) {
    process.stderr.write(`changelog-from-log: FAILED — ${filled.error}\n`);
    return 1;
  }

  await writeFile(file, filled.changelog, "utf8");
  const count = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
  process.stdout.write(`changelog-from-log: OK — ${version}, ${count} entr${count === 1 ? "y" : "ies"} (${filled.date})\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
