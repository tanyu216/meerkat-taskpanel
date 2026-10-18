#!/usr/bin/env node
/**
 * A signpost out of this repository is a defect, and this is the gate that says so.
 *
 * ---------------------------------------------------------------------------
 * What a signpost is
 * ---------------------------------------------------------------------------
 *
 * This project interoperates with an external, third-party development framework. That
 * framework keeps its own task store in a private directory under the user's home, and
 * drives it with a small set of internal scripts. None of that is this product's
 * business — but a *literate* repository is greppable, and a document that names one of
 * those internals in a walkable form is an instruction to go there.
 *
 * That is not hypothetical. It happened: a session working in this checkout ran a search
 * for the framework's card-closing implementation by name, landed on a design contract
 * that spelled its absolute path in order to declare the word forbidden, followed the
 * path out of the repository, and created task cards in the external store. The sentence
 * banning the word was the signpost.
 *
 * So the rule this gate enforces is narrow, and deliberately narrower than "do not
 * mention the framework":
 *
 *   1. `store-root` — the framework's **home-relative private store root** must not be
 *      spelled anywhere in tracked text. Two subpaths beneath it are carved out because
 *      they are a documented integration surface of a shipped feature (the card
 *      directory and the project registry file the migration reads): the carve-out is
 *      *structural*, written into the rule rather than parked on the allowlist, so it
 *      cannot go stale. A home prefix is required to match — code that assembles the
 *      same directory from parts (`join(homedir(), …)`) is reaching an integration
 *      point, not pointing a reader at one.
 *   2. `mechanism-word` — the framework's **internal mechanism names** must not appear.
 *      Five of them: its card-writer, its lane launcher, its lane reaper, its session
 *      registry file, and its governance file.
 *
 * ---------------------------------------------------------------------------
 * What is *not* a signpost — and why each exclusion is hard-won
 * ---------------------------------------------------------------------------
 *
 * The obvious "just ban every framework word" version of this gate is wrong, and would
 * have been wrong on the day it was written:
 *
 *   * The framework's **protocol document name and its section anchors** are *published
 *     data*: the SLA patrol emits them as a wire field (`threshold_ref`) and the test
 *     suite asserts the shape. Banning the string would red shipped code and a test.
 *   * The framework's **project name** and its **interface generation codename** are
 *     sanctioned cross-repository references — the first is a pointer that must carry
 *     its URL, the second is the loop's declaration of which interface generation it
 *     drives. The naming-boundary contract keeps both, and says why.
 *   * The framework's interface guide is a **provenance citation** in source comments.
 *
 * Those are the same distinction the design contract draws: a word may name somebody
 * else's thing as long as it is attributed and is not used as *our* name. This gate
 * enforces only the part that is unambiguously a defect — the walkable path and the
 * internals — and leaves the judgement calls to the contract. Narrow and enforced beats
 * broad and ignored: the contract this gate backs sat unexecuted for months precisely
 * because nothing ran it.
 *
 * ---------------------------------------------------------------------------
 * The allowlist is the ban's own wording, and nothing else
 * ---------------------------------------------------------------------------
 *
 * `test/fixtures/framework-signposts-allowlist.json` exists for exactly one reason: the
 * contract that *bans* these terms has to be able to write them. Its entries are
 * **`{file, rule}` pairs, not files**, so that exempting a document for naming a
 * mechanism word does not also let a walkable path hide inside it. The three assertions
 * are the same three the host-path gate uses, and they mean the same thing:
 *
 *   1. every (file, rule) finding is on the list;
 *   2. every entry's file still exists;
 *   3. every entry still offends *under its own rule*.
 *
 * There is deliberately no `--update`. An allowlist that regenerates itself is not an
 * allowlist.
 *
 * ---------------------------------------------------------------------------
 * Runs without git
 * ---------------------------------------------------------------------------
 *
 * The verification image drops `.git`, and it also drops `design/` — so in the container
 * this gate sees a **partial** view of the tree, and the design documents it exists to
 * police are absent. That is acceptable because the container is not the only place it
 * runs (the host `npm run verify` and CI both see the full checkout), but a partial view
 * has to be handled rather than merely noted: the one allowlist entry lives under
 * `design/`, and assertion 2 would otherwise read "this view does not carry that subtree"
 * as "the file was deleted", reddening the container on a tree that is in fact clean.
 *
 * So an entry whose top-level subtree is **absent from the root entirely** is skipped, in
 * both directions, and reported as skipped when `--print` is passed. A missing file inside
 * a subtree this view *does* carry is still a problem — which is the case the assertion
 * exists for. Git is used when available, else the walk, with the same `SKIP_DIRS` as its
 * sibling gate.
 *
 * Usage: node scripts/verify/signposts.mjs [--print] [--root <dir>]
 * Exit:  0 = no unlisted signpost · 1 = at least one finding · 2 = bad usage / unreadable
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "../../src/shared/entry-guard.mjs";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The committed allowlist of (file, rule) pairs that may carry a signpost. */
export const ALLOWLIST_FILE = "test/fixtures/framework-signposts-allowlist.json";

/** The two rule ids, in report order. */
export const RULE_IDS = Object.freeze(["store-root", "mechanism-word"]);

/**
 * Directories the walk skips. They mirror `.gitignore`, so the no-git file set matches
 * the tracked set rather than picking up build output and runtime state.
 */
const SKIP_DIRS = Object.freeze(new Set([".git", "node_modules", "dist", ".data", "coverage", ".worktrees"]));

// The terms are assembled from fragments on purpose: this file is itself tracked text
// under this gate, so spelling them here would make the gate its own first finding.
const VENDOR_DIR = ".open" + "claw"; // the vendor whose *skills* dir is a legitimate install target
const STORE_DIR = VENDOR_DIR + "/" + "team"; // ...but whose private store root is a signpost
const HOME_PREFIX = String.raw`(?:~|\$HOME|\$\{HOME\}|\$home|\$\{home\})`;
const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The framework's private store root, reached through a home-relative prefix. The card
 * directory and the project registry file beneath it are carved out: they are the
 * documented integration surface of a shipped feature, and writing the carve-out into
 * the rule keeps it from rotting on an allowlist.
 *
 * Not global: `.test()` on a global regex carries `lastIndex` between calls.
 */
const STORE_ROOT = new RegExp(`${HOME_PREFIX}/${escape(STORE_DIR)}(?!/(?:tasks|projects\\.json)\\b)`);

/** The framework's internal mechanism names, each matched as a literal. */
const MECHANISM_WORDS = Object.freeze([
  "task-" + "ops",
  "spawn-" + "lane",
  "lane-" + "reaper",
  "claude-sessions" + ".json",
  "redlines" + ".core.md",
]);
const MECHANISM_PATTERNS = MECHANISM_WORDS.map((word) => new RegExp(escape(word)));

/** The rule ids one file's text offends, sorted. */
export function signpostsIn(text) {
  const body = String(text);
  const rules = [];
  if (STORE_ROOT.test(body)) rules.push("store-root");
  if (MECHANISM_PATTERNS.some((pattern) => pattern.test(body))) rules.push("mechanism-word");
  return rules.sort();
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

/** The findings for one root, as `{ file, rules }`, sorted by file. */
export function scan(root = ROOT) {
  const findings = [];
  for (const file of listFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // unreadable or a dangling symlink: not a text file, not our business
    }
    const rules = signpostsIn(text);
    if (rules.length > 0) findings.push({ file, rules });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The `file\u0000rule` key an entry and a finding are joined on. */
const pairKey = (file, rule) => `${file}\0${rule}`;

/**
 * The top-level names of one root. An allowlist entry that lives under a subtree this view
 * does not carry **at all** cannot be judged here, and must not be reported as a deleted
 * file: the verification image drops `design/`, and the one exemption this gate needs lives
 * in there.
 *
 * `null` means the root itself could not be listed, in which case nothing is out of view —
 * an unreadable root is a problem, not a reason to excuse entries.
 */
function topLevelNames(root) {
  try {
    return new Set(readdirSync(root));
  } catch {
    return null;
  }
}

/** @returns {{ok: boolean, findings: object[], problems: string[], skipped: string[]}} */
export function analyze(root = ROOT) {
  const findings = scan(root);
  const offending = new Set();
  for (const finding of findings) {
    for (const rule of finding.rules) offending.add(pairKey(finding.file, rule));
  }

  const topLevel = topLevelNames(root);
  const outOfView = (file) => topLevel !== null && !topLevel.has(String(file).split("/")[0]);
  const skipped = [];

  let entries = [];
  const problems = [];
  try {
    const doc = JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), "utf8"));
    if (!Array.isArray(doc.entries)) {
      problems.push(`${ALLOWLIST_FILE}: needs an \`entries\` array of \`{file, rule, reason}\` objects`);
    } else {
      entries = doc.entries;
    }
  } catch (err) {
    problems.push(`${ALLOWLIST_FILE}: ${err.message}`);
  }

  const allowed = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.file !== "string" || typeof entry.rule !== "string") {
      problems.push(`${ALLOWLIST_FILE}: every entry needs \`file\` and \`rule\` (one entry = one file AND one rule)`);
      continue;
    }
    if (!RULE_IDS.includes(entry.rule)) {
      problems.push(`${ALLOWLIST_FILE}: "${entry.file}" names rule "${entry.rule}", which is not one of ${RULE_IDS.join(", ")}`);
      continue;
    }
    allowed.add(pairKey(entry.file, entry.rule));
  }

  // 1 — nothing off the list.
  for (const finding of findings) {
    for (const rule of finding.rules) {
      if (allowed.has(pairKey(finding.file, rule))) continue;
      problems.push(
        `${finding.file}: carries a ${rule} signpost. There is no supported reason for a tracked file to ` +
          `point at the framework's own store or internals — describe the location instead of naming it. If ` +
          `this file is the contract that bans the terms, add exactly this {file, rule} pair to ${ALLOWLIST_FILE}.`,
      );
    }
  }

  // 2 — nothing on the list has gone.
  const present = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.file !== "string") continue;
    if (outOfView(entry.file)) {
      // The subtree is not in this view at all, so "gone" cannot be told from "not carried
      // here". Skipping is the honest answer; a full checkout (CI, `npm run verify`) is
      // where a deleted entry is caught.
      skipped.push(entry.file);
      continue;
    }
    try {
      statSync(join(root, entry.file));
      present.add(entry.file);
    } catch {
      problems.push(`${ALLOWLIST_FILE}: "${entry.file}" no longer exists — remove its entry`);
    }
  }

  // 3 — nothing on the list has been cleaned up without its entry going too. Only for
  // files that are still there: a missing file is already a problem above, and reporting
  // it twice under two headings reads as two separate mistakes.
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.file !== "string" || typeof entry.rule !== "string") continue;
    if (!present.has(entry.file) || !RULE_IDS.includes(entry.rule)) continue;
    if (offending.has(pairKey(entry.file, entry.rule))) continue;
    problems.push(
      `${ALLOWLIST_FILE}: "${entry.file}" is listed for rule "${entry.rule}" but no longer offends it — ` +
        `remove that entry, so the list keeps meaning "still pending"`,
    );
  }

  return { ok: problems.length === 0, findings, problems, skipped };
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
    console.error("unknown option; usage: node scripts/verify/signposts.mjs [--print] [--root <dir>]");
    return 2;
  }

  let result;
  try {
    result = analyze(root);
  } catch (err) {
    console.error(`signposts: ${err.message}`);
    return 2;
  }

  if (args.includes("--print")) {
    for (const finding of result.findings) console.log(`${finding.file}\t${finding.rules.join(",")}`);
    console.log(`— ${result.findings.length} file(s) carry a signpost`);
    for (const file of result.skipped) console.log(`${file}\t(skipped — this view does not carry that subtree)`);
  }

  if (result.ok) {
    const partial = result.skipped.length > 0
      ? ` (partial view: ${result.skipped.length} allowlisted file(s) not carried here — a full checkout is what judges them)`
      : "";
    console.log(`signposts: OK — nothing in the tree points at the external framework's store or internals${partial}`);
    return 0;
  }
  for (const problem of result.problems) console.error(`  ✗ ${problem}`);
  console.error(`\nsignposts: ${result.problems.length} problem(s). A signpost is a path out of this ` +
    `repository; ${ALLOWLIST_FILE} is for the contract that has to name what it bans, and it is keyed by rule.`);
  return 1;
}

// Guarded so the module can be imported by the test suite without side effects — and,
// more to the point here, so that importing it does not run the gate against whatever
// tree the importer happens to be in and `process.exit` on the result.
if (isEntryPoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
