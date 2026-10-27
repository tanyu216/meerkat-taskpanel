#!/usr/bin/env node
/**
 * Prepare a release tree: bump the four carriers, scaffold the CHANGELOG, and
 * draft its entries from the commits since the previous release.
 *
 * This is the tree half of the release-prep workflow: it decides and writes the
 * files a release branch carries, and prints the metadata (previous version,
 * range, entry count) that the pull request body is built from. It never tags,
 * commits, pushes, or opens a PR — the workflow does those so the branch, the
 * PR and the tag all remain reviewable git operations.
 *
 *   node scripts/release/prep.mjs --version 0.1.2 [--base <dir>] [--from v0.1.1] [--dry-run] [--json]
 *
 * Preconditions, all refused before a byte is written:
 *
 *   * the target is valid semver and greater than the canonical carrier;
 *   * the working tree is clean (a dirty tree makes the generated commit a lie);
 *   * `origin/main` is an ancestor of HEAD when that ref exists (a release branch
 *     cut from an unsynced `dev` would drop the previous release from `main`);
 *   * `v<version>` does not already exist;
 *   * the range holds at least one commit that produces a changelog entry.
 *
 * A re-run on a branch that already carries the target version is supported
 * (`resume`): the carriers are left alone and a scaffold section is filled, while
 * a section a human has already edited is preserved.
 *
 * Exit codes: 0 ok · 1 refused · 2 usage · 3 a write failed.
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
import { currentVersion, validateVersions } from "../verify/version.mjs";
import { CHANGELOG_FILE, compareSemver, parseSemver, runBump } from "./bump.mjs";
import { fillSection, groupCommits, today } from "./changelog-from-log.mjs";

/** Repository root, resolved from this file (`scripts/release/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The `git log` record format both the CLI and `groupCommits` understand. */
const LOG_FORMAT = "--format=%s%x1f%b%x1e";

/** A write adapter that does nothing, so a dry run plans without touching disk. */
const NOOP_IO = Object.freeze({
  writeFile: async () => {},
  rename: async () => {},
  rm: async () => {},
});

/** Run one git command and normalise the spawn result. */
function git(run, base, args) {
  const result = run("git", args, { cwd: base, encoding: "utf8" });
  return {
    status: result.error !== undefined && result.error !== null ? 1 : (result.status ?? 1),
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ?? null,
  };
}

/** The previous release tag reachable from HEAD, or `null` when there is none. */
function lastReleaseTag(run, base) {
  const result = git(run, base, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"]);
  return result.status === 0 && result.stdout !== "" ? result.stdout : null;
}

/**
 * Prepare a release tree for `version`.
 *
 * @param {{version: string, base?: string, date?: string, from?: string|null,
 *          dryRun?: boolean, run?: typeof spawnSync, io?: object}} options
 * @returns {Promise<
 *   | {ok: true, version: string, previous: string, from: string|null, resume: boolean,
 *      dryRun: boolean, commits: number, entryCount: number,
 *      entries: string[], changelog: {path: string, filled: boolean, body: string},
 *      changed: boolean}
 *   | {ok: false, code: string, error: string, entries?: string[]}
 * >}
 */
export async function prepareRelease(options = {}) {
  const { version, base = ROOT, date = today(), dryRun = false, run = spawnSync, io } = options;

  const target = parseSemver(version);
  if (target === null) {
    return { ok: false, code: "invalid-version", error: `'${version}' is not valid semver — expected MAJOR.MINOR.PATCH` };
  }

  // A drift here would leave one carrier behind; refuse rather than splice onto a
  // tree that already disagrees with itself. (The bump repeats this check.)
  const checked = await validateVersions(base);
  if (!checked.ok) {
    return { ok: false, code: checked.kind === "read" ? "unreadable-tree" : "drift", error: checked.error };
  }
  const previous = checked.version;
  const resume = previous === target.raw;
  if (!resume && compareSemver(target, parseSemver(previous)) <= 0) {
    return {
      ok: false,
      code: "not-greater",
      error: `${target.raw} is not greater than the current version ${previous} — a release must move forward`,
    };
  }

  // Git-level preconditions. Each is skipped in a tree without `.git` (the pure
  // fixture trees the tests build), because there is nothing to be consistent with.
  const inside = git(run, base, ["rev-parse", "--is-inside-work-tree"]);
  const hasGit = inside.status === 0 && inside.stdout === "true";
  if (hasGit) {
    const dirty = git(run, base, ["status", "--porcelain"]);
    if (dirty.status !== 0) {
      return { ok: false, code: "git-unavailable", error: `git status failed: ${dirty.stderr || dirty.error?.message || "unknown error"}` };
    }
    if (dirty.stdout !== "") {
      return {
        ok: false,
        code: "dirty-tree",
        error: `the working tree has uncommitted changes:\n${dirty.stdout
          .split("\n")
          .slice(0, 10)
          .join("\n")}`,
      };
    }

    const main = git(run, base, ["rev-parse", "--verify", "--quiet", "origin/main"]);
    if (main.status === 0) {
      const ancestor = git(run, base, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
      if (ancestor.status !== 0) {
        return {
          ok: false,
          code: "main-not-merged",
          error: "origin/main is not an ancestor of HEAD — merge main into dev before cutting a release branch",
        };
      }
    }

    const tag = git(run, base, ["rev-parse", "--verify", "--quiet", `refs/tags/v${target.raw}`]);
    if (tag.status === 0) {
      return { ok: false, code: "tag-exists", error: `v${target.raw} already exists — choose a higher version` };
    }
  }

  // The commit range. An explicit `--from` wins; otherwise the previous release
  // tag. No tag at all means the whole history, which is the first release.
  const from = options.from === undefined ? (hasGit ? lastReleaseTag(run, base) : null) : options.from;
  let logArgs;
  if (hasGit) {
    logArgs = ["log", "--no-merges", LOG_FORMAT, from === null ? "HEAD" : `${from}..HEAD`];
  } else {
    logArgs = null;
  }

  let raw = "";
  if (logArgs !== null) {
    const log = git(run, base, logArgs);
    if (log.status !== 0) {
      return { ok: false, code: "log-failed", error: `git log failed: ${log.stderr || log.error?.message || "unknown error"}` };
    }
    raw = `${log.stdout}\n`;
  }

  const groups = groupCommits(raw);
  const entryCount = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
  if (entryCount === 0) {
    return {
      ok: false,
      code: "empty-changelog",
      error: `no releasable commits between ${from ?? "the first commit"} and HEAD — a release needs at least one user-visible change`,
    };
  }

  // Bump (or, on a re-run, read the tree as it stands). Dry runs stage through a
  // no-op adapter: every refusal still fires, no byte lands.
  let changelogText;
  const writtenPaths = [];
  if (resume) {
    const file = join(base, CHANGELOG_FILE);
    try {
      changelogText = await readFile(file, "utf8");
    } catch (error) {
      return { ok: false, code: "changelog-unreadable", error: `${CHANGELOG_FILE}: ${error.message}` };
    }
  } else {
    const bumped = await runBump({
      version: target.raw,
      base,
      changelog: true,
      date,
      io: dryRun ? NOOP_IO : io,
    });
    if (!bumped.ok) {
      const written = Array.isArray(bumped.entries) ? bumped.entries.map((entry) => entry.path) : [];
      return { ok: false, code: bumped.code, error: bumped.error, entries: written };
    }
    writtenPaths.push(...bumped.entries.map((entry) => entry.path).filter((path) => path !== CHANGELOG_FILE));
    changelogText = bumped.changelog.after;
  }

  const section = parseVersionSection(changelogText, target.raw);
  if (section === null) {
    return {
      ok: false,
      code: "section-missing",
      error: `${CHANGELOG_FILE} has no '## [${target.raw}]' section — run bump --changelog first`,
      entries: writtenPaths,
    };
  }

  // A human-edited section is the release note; only a scaffold (or an empty
  // section) is filled from the log. This is what makes a re-run safe.
  const scaffold =
    section.body.trim() === "" || section.body.includes(PLACEHOLDER_BULLET);
  let filled;
  if (scaffold) {
    filled = fillSection(changelogText, target.raw, groups, date);
    if (!filled.ok) {
      return { ok: false, code: filled.code, error: filled.error, entries: writtenPaths };
    }
  } else {
    filled = { ok: true, changelog: changelogText, date: section.date ?? date };
  }

  const changed = !resume || scaffold;
  // `runBump` already wrote the carriers; the changelog is the one file whose final
  // body only exists after the fill, so write it here.
  if (scaffold && !dryRun) {
    const file = join(base, CHANGELOG_FILE);
    try {
      await (io?.writeFile ?? writeFile)(file, filled.changelog, "utf8");
    } catch (error) {
      return {
        ok: false,
        code: "write-failed",
        error: `${CHANGELOG_FILE}: ${error.message}`,
        entries: writtenPaths,
      };
    }
  }
  if (scaffold) writtenPaths.push(CHANGELOG_FILE);

  const body = parseVersionSection(filled.changelog, target.raw)?.body.trim() ?? "";

  return {
    ok: true,
    version: target.raw,
    previous,
    from,
    resume,
    dryRun,
    commits: raw === "" ? 0 : raw.split("\x1e").filter((record) => record.trim() !== "").length,
    entryCount,
    entries: writtenPaths,
    changelog: { path: CHANGELOG_FILE, filled: scaffold, body },
    changed,
  };
}

const USAGE = `Usage: node scripts/release/prep.mjs --version <x.y.z> [options]

  --version <x.y.z>  the release to prepare (strict semver, greater than the current one)
  --base <dir>       prepare a tree rooted at <dir> (default: this checkout)
  --from <ref>       the previous release (default: the last v* tag reachable from HEAD)
  --date <date>      the changelog date (default: today)
  --dry-run          run every check and plan the writes without touching disk
  --json             print the metadata object instead of the human summary

Exit: 0 ok · 1 refused · 2 usage · 3 a write failed
`;

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      base: { type: "string" },
      from: { type: "string" },
      date: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version === undefined) {
    process.stderr.write("prep: --version <x.y.z> is required\n");
    return 2;
  }

  const result = await prepareRelease({
    version: values.version,
    base: values.base === undefined ? ROOT : resolve(values.base),
    from: values.from,
    date: values.date,
    dryRun: values["dry-run"],
  });

  if (!result.ok) {
    process.stderr.write(`prep: FAILED — ${result.error}\n`);
    if ((result.entries ?? []).length > 0) {
      process.stderr.write(`prep: written before the failure: ${result.entries.join(" ")}\n`);
    }
    return result.code === "write-failed" ? 3 : 1;
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `prep: ${result.resume ? "refresh" : `${result.previous} → ${result.version}`}` +
      `${result.dryRun ? " (dry run)" : ""}\n`,
  );
  process.stdout.write(`  range: ${result.from ?? "first commit"}..HEAD, ${result.commits} commit(s)\n`);
  process.stdout.write(`  changelog: ${result.changelog.filled ? "filled" : "kept"} (${result.entryCount} entr${result.entryCount === 1 ? "y" : "ies"})\n`);
  for (const path of result.entries) process.stdout.write(`  ${path}\n`);
  process.stdout.write(`prep: OK — ${result.entries.length} file(s) ${result.dryRun ? "would be" : "were"} written\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
