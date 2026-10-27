#!/usr/bin/env node
/**
 * The tag ↔ carrier equality gate.
 *
 * A version tag names a release. The checked-out tree declares one in four carriers
 * (`scripts/verify/version.mjs`). If the two disagree, `v9.9.9` can pack and publish a
 * `0.1.0` tarball — a release that lies about itself. `version.mjs` proves the carriers
 * agree with each other; this proves the tag agrees with them.
 *
 *   node scripts/verify/tag-version.mjs v1.2.3 [--base <dir>] [--on-main]
 *
 * `--on-main` additionally asserts that `HEAD` is an ancestor of `origin/main` (the
 * tag-from-main rule). A tree without `.git` skips that half rather than failing: the
 * checker is also used on exported trees. A real repository without `origin/main`
 * fails with a fetch hint.
 *
 * Exit: 0 tag matches (or the ref is not a version tag) · 1 mismatch ·
 * 2 unreadable/drifted tree, `--on-main` failure, or usage.
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import { isReleaseTag, parseVersionTag } from "./changelog.mjs";
import { ROOT, currentVersion, validateVersions } from "./version.mjs";

/**
 * Check a tag against the tree's four version carriers.
 *
 * Never throws for a bad tree: an unreadable carrier, drifted carriers and a
 * malformed tag all come back as `{ok: false, code, error}` so the callers can
 * choose an exit code.
 *
 * @param {{tag: string, base?: string, onMain?: boolean}} options
 * @returns {Promise<{ok: boolean, skipped?: boolean, tag: string, version?: string,
 *   expected?: string, code?: "mismatch"|"unreadable"|"not-on-main"|"malformed", error?: string}>}
 */
export async function checkTagVersion({ tag, base = ROOT, onMain = false } = {}) {
  const version = parseVersionTag(tag);
  if (version === null) {
    // `v…` is the release namespace (the ruleset targets it, `release.yml` runs on
    // it). A ref that lives there but is not `vMAJOR.MINOR.PATCH` is a typo, not a
    // scratch tag, and must not slip through as "not a version tag".
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

  const checked = await validateVersions(base);
  if (!checked.ok) {
    return { ok: false, tag, version, code: "unreadable", error: checked.error };
  }

  const canonical = await currentVersion(base);
  if (canonical === null) {
    return {
      ok: false,
      tag,
      version,
      code: "unreadable",
      error: `cannot read the canonical version in ${base}`,
    };
  }

  if (canonical !== version) {
    return {
      ok: false,
      tag,
      version,
      expected: canonical,
      code: "mismatch",
      error: `tag ${tag} names ${version}, but the tree declares ${canonical}`,
    };
  }

  if (onMain) {
    const inRepo = git(["rev-parse", "--git-dir"], base);
    if (inRepo.status !== 0) {
      // An exported tree (npm tarball, CI archive) has no .git; the ancestry half
      // cannot be answered there, and refusing would make the checker unusable.
      return { ok: true, tag, version, expected: canonical, onMain: "skipped" };
    }

    const originMain = git(["rev-parse", "--verify", "--quiet", "origin/main"], base);
    if (originMain.status !== 0) {
      return {
        ok: false,
        tag,
        version,
        expected: canonical,
        code: "not-on-main",
        error: "cannot resolve origin/main — run `git fetch origin main` first",
      };
    }

    const ancestor = git(["merge-base", "--is-ancestor", "HEAD", "origin/main"], base);
    if (ancestor.status !== 0) {
      return {
        ok: false,
        tag,
        version,
        expected: canonical,
        code: "not-on-main",
        error: `${tag} is not on main: HEAD is not an ancestor of origin/main`,
      };
    }
  }

  return { ok: true, tag, version, expected: canonical };
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      "on-main": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/tag-version.mjs <vX.Y.Z> [--base <dir>] [--on-main]\n\n" +
        "  <vX.Y.Z>      the tag to check against the tree's version carriers\n" +
        "  --base <dir>  the tree to read (default: this checkout)\n" +
        "  --on-main     also require HEAD to be an ancestor of origin/main\n\n" +
        "Exit: 0 matches/skip · 1 mismatch or a malformed v* name · 2 unreadable, not-on-main, or usage\n",
    );
    return 0;
  }

  if (positionals.length !== 1) {
    process.stderr.write("tag-version: usage: node scripts/verify/tag-version.mjs <vX.Y.Z> [--base <dir>] [--on-main]\n");
    return 2;
  }

  const tag = positionals[0];
  const options = { tag, onMain: values["on-main"] };
  if (values.base !== undefined) options.base = resolve(values.base);

  const result = await checkTagVersion(options);

  if (result.skipped === true) {
    process.stdout.write(`tag-version: SKIP — ${tag} is not a version tag\n`);
    return 0;
  }
  if (result.ok) {
    process.stdout.write(
      `tag-version: OK — ${tag} matches ${result.expected}${result.onMain === "skipped" ? " (--on-main skipped: no .git)" : ""}\n`,
    );
    return 0;
  }
  if (result.code === "mismatch" || result.code === "malformed") {
    process.stderr.write(`tag-version: FAILED — ${result.error}\n`);
    return 1;
  }
  process.stderr.write(`tag-version: FAILED — ${result.error}\n`);
  return 2;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
