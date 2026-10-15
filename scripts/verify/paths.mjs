#!/usr/bin/env node
/**
 * A host-absolute path in a shared repository is a defect, and this is the gate that
 * says so.
 *
 * ---------------------------------------------------------------------------
 * Why this is a gate and not a convention
 * ---------------------------------------------------------------------------
 *
 * `/Users/<someone>/…` is a statement about **one machine**. In a checkout other people
 * read, that statement is either
 *
 *   * an *instruction* nobody else can follow — "run `node /Users/<someone>/…/probe.mjs`",
 *     which is a repro step that silently only works for its author; or
 *   * a *disclosure* — the repository carries its developer's home directory, and with
 *     it a username, a directory layout and, in the plan files that leaked here, the
 *     private workspace paths of an unrelated team tool.
 *
 * Neither is visible in review, because the path reads as ordinary prose. That is the
 * whole reason it needs a machine to notice it: the ones this gate was written for had
 * been sitting in the tree for several rounds, and cleaning them up by hand is what
 * `test/fixtures/host-paths-allowlist.json` now keeps from happening again.
 *
 * ---------------------------------------------------------------------------
 * What is *not* a defect
 * ---------------------------------------------------------------------------
 *
 * Two kinds of path are deliberately exempt, because neither names a real machine:
 *
 *   * **Placeholders** — `/Users/you`, `/home/you`. They appear in the skill references
 *     and in `docs/scheduling.md` as the thing the reader substitutes their own path
 *     into. That is the correct way to write such an instruction.
 *   * **Fixture names** — `/home/tester`, `/home/op`, `/home/team`, `/home/alice`. They
 *     are arguments to pure path-resolution functions under test, in the same spirit as
 *     `/tmp/…`; nothing is asserted about the machine they name.
 *
 * They are listed as `RESERVED_NAMES` below rather than inferred, so that adding a name
 * is a deliberate, reviewable act rather than something that happens by accident. If a
 * new placeholder or fixture needs a name that is not on the list, the failure message
 * says exactly what to do about it.
 *
 * ---------------------------------------------------------------------------
 * The allowlist can only shrink on its own
 * ---------------------------------------------------------------------------
 *
 * `test/fixtures/host-paths-allowlist.json` lists the files that are allowed to carry a
 * path, because they are *records* of verification runs that really did happen on one
 * machine — `docs/verify/<card>/…` evidence. Three assertions keep that list honest:
 *
 *   1. every offending file is on the list;
 *   2. every entry on the list still exists — so a deleted file's entry is a red, not
 *      dead weight;
 *   3. every entry on the list still offends — so fixing a file without removing its
 *      entry is a red rather than a quietly weakened gate.
 *
 * (2) and (3) together mean the list cannot grow without someone editing the JSON in the
 * same change, and cannot stay stale once a file is cleaned. There is deliberately no
 * `--update`: an allowlist that regenerates itself is not an allowlist.
 *
 * ---------------------------------------------------------------------------
 * Runs without git
 * ---------------------------------------------------------------------------
 *
 * The verification image does not carry `.git` (`.dockerignore` drops it), so the file
 * set cannot come from `git ls-files` alone. Git is used when it is available — it names
 * exactly the tracked set, which is what "the repository" means — and the walk below
 * stands in otherwise, skipping the directories `.gitignore` already excludes. Both
 * paths see the same set for a clean checkout.
 *
 * Usage: node scripts/verify/paths.mjs [--print] [--root <dir>]
 * Exit:  0 = no unlisted path · 1 = at least one finding · 2 = bad usage / unreadable
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "../../src/shared/entry-guard.mjs";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The committed allowlist of files that may carry a host path. */
export const ALLOWLIST_FILE = "test/fixtures/host-paths-allowlist.json";

/**
 * Names this repository uses for placeholder and fixture paths. A path under one of
 * these never names a real machine, so it is not the defect this gate is about.
 */
export const RESERVED_NAMES = Object.freeze(["you", "op", "alice", "tester", "team"]);

/**
 * Directories the walk skips. They mirror `.gitignore`, so the no-git file set matches
 * the tracked set rather than picking up build output and runtime state.
 */
const SKIP_DIRS = Object.freeze(new Set([".git", "node_modules", "dist", ".data", "coverage"]));

/** `[/Users|/home]/<name>` — the name is what decides whether it is a finding. */
const HOST_PATH = /\/(?:Users|home)\/([A-Za-z0-9_.-]+)/g;

/** The host paths in one file's text, as the names they name. */
export function hostNamesIn(text) {
  return [...String(text).matchAll(HOST_PATH)].map((match) => match[1]);
}

/** The names that make a file a finding — i.e. everything not reserved. */
export function offendingNamesIn(text) {
  return hostNamesIn(text).filter((name) => !RESERVED_NAMES.includes(name));
}

/** Tracked files, from git when there is a git checkout, else by walking. */
export function listFiles(root = ROOT) {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\0").filter((name) => name !== "");
    if (files.length > 0) return files;
  } catch {
    /* no git (the verification image drops .git) — fall through to the walk */
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        found.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** The findings for one root, as `{ file, names }`, sorted by file. */
export function scan(root = ROOT) {
  const findings = [];
  for (const file of listFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // unreadable or a dangling symlink: not a text file, not our business
    }
    const names = offendingNamesIn(text);
    if (names.length > 0) findings.push({ file, names: [...new Set(names)].sort() });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** @returns {{ok: boolean, findings: object[], problems: string[]}} */
export function analyze(root = ROOT) {
  const findings = scan(root);
  const offending = new Set(findings.map((f) => f.file));

  let entries = [];
  const problems = [];
  try {
    const doc = JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), "utf8"));
    if (!Array.isArray(doc.entries)) {
      problems.push(`${ALLOWLIST_FILE}: needs an \`entries\` array of repository-relative paths`);
    } else {
      entries = doc.entries;
    }
  } catch (err) {
    problems.push(`${ALLOWLIST_FILE}: ${err.message}`);
  }

  const allowed = new Set(entries);

  // 1 — nothing off the list.
  for (const finding of findings) {
    if (allowed.has(finding.file)) continue;
    problems.push(
      `${finding.file}: carries a host path (${finding.names.map((n) => `"${n}"`).join(", ")}). ` +
        `Point it at a relative path or a placeholder; if the name is a placeholder or a fixture, ` +
        `add it to RESERVED_NAMES in ${relative(root, fileURLToPath(import.meta.url))}.`,
    );
  }

  // 2 — nothing on the list has gone.
  const present = new Set();
  for (const entry of entries) {
    try {
      statSync(join(root, entry));
      present.add(entry);
    } catch {
      problems.push(`${ALLOWLIST_FILE}: "${entry}" no longer exists — remove its entry`);
    }
  }

  // 3 — nothing on the list has been cleaned up without its entry going too. Only for
  // entries that are still there: a missing file is already a problem above, and
  // reporting it twice under two different headings reads as two separate mistakes.
  for (const entry of entries) {
    if (!present.has(entry) || offending.has(entry)) continue;
    problems.push(
      `${ALLOWLIST_FILE}: "${entry}" is listed but no longer carries a host path — ` +
        `remove its entry, so the list keeps meaning "still to be cleaned"`,
    );
  }

  return { ok: problems.length === 0, findings, problems };
}

/** @param {string[]} args — the arguments after `node <file>`; see the guard at the end. */
function main(args) {
  const rootFlag = args.indexOf("--root");
  const root = rootFlag === -1 ? ROOT : resolve(args[rootFlag + 1] ?? "");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error("--root needs a directory");
    return 2;
  }
  if (args.some((arg) => arg.startsWith("-") && arg !== "--print" && arg !== "--root")) {
    console.error(`unknown option; usage: node scripts/verify/paths.mjs [--print] [--root <dir>]`);
    return 2;
  }

  let result;
  try {
    result = analyze(root);
  } catch (err) {
    console.error(`paths: ${err.message}`);
    return 2;
  }

  if (args.includes("--print")) {
    for (const finding of result.findings) console.log(`${finding.file}\t${finding.names.join(",")}`);
    console.log(`— ${result.findings.length} file(s) carry a host path`);
  }

  if (result.ok) {
    console.log(`paths: OK — no unlisted host path (${result.findings.length} allowlisted, all still pending)`);
    return 0;
  }
  for (const problem of result.problems) console.error(`  ✗ ${problem}`);
  console.error(`\npaths: ${result.problems.length} problem(s). A host path belongs to one machine; ` +
    `${ALLOWLIST_FILE} is for records of runs that already happened, and it shrinks.`);
  return 1;
}

// Guarded so the module can be imported by the test suite without side effects — and,
// more to the point here, so that importing it does not run the gate against whatever
// tree the importer happens to be in and `process.exit` on the result.
if (isEntryPoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
