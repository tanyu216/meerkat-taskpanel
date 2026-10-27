#!/usr/bin/env node
/**
 * Every shipped bundle declares the version of the thing it ships, and the bundles of a
 * component must agree with each other.
 *
 *   board (canonical: the root `package.json`)
 *   1. package.json                                    (the source of truth — and Pi's
 *                                                       carrier too: its manifest IS the
 *                                                       root package's `pi` field)
 *   2. .claude-plugin/plugin.json                      (the board plugin — claude,
 *                                                       and codex via the marketplace)
 *   3. .claude-plugin/marketplace.json  → metadata.version
 *   4. src/foundation/constants.mjs     → export const VERSION
 *
 * The fourth is not a manifest but it is a carrier all the same: it is the release the
 * running program reports (`taskctl --version`, `/health`, `/meta`, the daemon log and the
 * writer-lock record), so a bump that leaves it behind ships a board that calls itself the
 * old version.
 *
 * Every agent kind reads its own manifest to decide what version it installed, so a drift
 * within the group ships a release that calls itself two different things. This script
 * reads every carrier, checks the group against its canonical entry, prints any offending
 * file and exits non-zero on drift — part of `npm run verify` and wired into CI, so the
 * mistake is caught at pull-request time rather than at tag time.
 *
 * The loop is **not** a version carrier: it is distributed by `install.sh` from
 * `skills/meerkat-loop/`, declares the *board* interface it requires rather than a
 * version of its own, and its two former carriers were the `plugins/loop` manifests that
 * this repository no longer ships (ruling O4 is thereby retired — see the 2026-10-17
 * decision note in `design/plugin-distribution-plan.md`).
 *
 *   node scripts/verify/version.mjs                # check the group
 *   node scripts/verify/version.mjs --print        # print the board version
 *   node scripts/verify/version.mjs --base <dir>   # check a tree rooted at <dir>
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

/**
 * The one shape the module carrier may take. Deliberately narrow: a checker and a bumper
 * that both need a byte span should agree on exactly one line, not on a JavaScript parser.
 * A trailing `// comment` is tolerated; anything else (indentation, single quotes, a
 * multi-line literal) is "no declaration" rather than a guess.
 */
const MODULE_VERSION_SOURCE =
  String.raw`^export const VERSION[ \t]*=[ \t]*(?<literal>"[^"\r\n]+")[ \t]*;[ \t]*(?:\/\/[^\r\n]*)?[ \t\r]*$`;

/**
 * Locate the `export const VERSION = "x.y.z";` literal in a module carrier.
 *
 * Returns the `[start, end)` span of the quoted literal (quotes included), matching
 * `findValueSpan`'s shape so the bumper can splice either kind with one code path. A fresh
 * RegExp per call keeps the function stateless — a shared `/g` pattern carries `lastIndex`
 * between callers, which would silently skip a later file's first match.
 *
 * @param {string} raw
 * @returns {{start: number, end: number, value: string}|null} the literal span, or `null` when there is no declaration
 * @throws {SyntaxError} when more than one declaration makes the target ambiguous
 */
export function findModuleVersionSpan(raw) {
  const matches = [...raw.matchAll(new RegExp(MODULE_VERSION_SOURCE, "gmd"))];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new SyntaxError(`more than one \`export const VERSION\` declaration (${matches.length})`);
  }
  const [start, end] = matches[0].indices.groups.literal;
  return { start, end, value: raw.slice(start + 1, end - 1).trim() };
}

/**
 * The board's four carriers, in reporting order. The first entry is the canonical one:
 * every other entry in the group must equal it.
 *
 * `kind` selects how the value is read: `"json"` parses the file and applies `field` as a
 * dotted path with `pick`; `"module"` locates the single `export const VERSION = "x.y.z";`
 * declaration. `field` names what carries the version either way, so a diagnostic can say
 * where to look (the marketplace hides its version under `metadata`).
 *
 * Three agent kinds are not carriers: Codex and OpenClaw install the same
 * `.claude-plugin/plugin.json` bundle through the repository marketplace, and Pi declares
 * itself in the canonical `package.json` itself. A row for any would only restate one
 * already above.
 *
 * @type {ReadonlyArray<{label: string, path: string, field: string, kind: "json"|"module", canonical?: boolean, pick?: (doc: object) => unknown}>}
 */
export const VERSION_SOURCES = Object.freeze([
  { label: "package.json", path: "package.json", field: "version", kind: "json", canonical: true, pick: (doc) => doc.version },
  { label: "claude", path: ".claude-plugin/plugin.json", field: "version", kind: "json", pick: (doc) => doc.version },
  { label: "marketplace", path: ".claude-plugin/marketplace.json", field: "metadata.version", kind: "json", pick: (doc) => doc.metadata?.version },
  { label: "constants", path: "src/foundation/constants.mjs", field: "VERSION", kind: "module" },
]);

/**
 * The version groups, in reporting order. There is one: the loop stopped carrying a
 * version of its own when its only two carriers (the `plugins/loop` manifests) were
 * removed. `--print` and the release tooling read the board's version.
 *
 * @type {ReadonlyArray<{name: string, sources: typeof VERSION_SOURCES}>}
 */
export const VERSION_GROUPS = Object.freeze([
  { name: "board", sources: VERSION_SOURCES },
]);

/** The group a bare invocation or a bare `--print` refers to. */
export const DEFAULT_GROUP = "board";

/**
 * Look up a group by name.
 * @param {string} name
 * @returns {{name: string, sources: typeof VERSION_SOURCES}|null}
 */
export function versionGroup(name = DEFAULT_GROUP) {
  return VERSION_GROUPS.find((group) => group.name === name) ?? null;
}

/**
 * Read one carrier and pull its version out.
 *
 * @param {{path: string, field: string, kind: "json"|"module", pick?: (doc: object) => unknown}} source
 * @param {string} base repository root
 * @returns {Promise<{ok: true, version: string} | {ok: false, error: string}>}
 */
async function readSource(source, base) {
  const file = join(base, source.path);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const why = err !== null && err.code === "ENOENT" ? "file not found" : err.message;
    return { ok: false, error: `${source.path}: ${why}` };
  }

  if (source.kind === "module") {
    let span;
    try {
      span = findModuleVersionSpan(raw);
    } catch (err) {
      return { ok: false, error: `${source.path}: ${err.message}` };
    }
    if (span === null || span.value === "") {
      return {
        ok: false,
        error: `${source.path}: no \`export const ${source.field} = "x.y.z";\` declaration`,
      };
    }
    return { ok: true, version: span.value };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${source.path}: not valid JSON (${err.message})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: `${source.path}: expected a JSON object` };
  }

  const version = source.pick(doc);
  if (typeof version !== "string" || version.trim() === "") {
    return { ok: false, error: `${source.path}: missing a non-empty string \`${source.field}\`` };
  }
  return { ok: true, version: version.trim() };
}

/**
 * Validate that every carrier of one version group carries the same version as that
 * group's canonical entry.
 *
 * Never throws for a bad tree: a missing file, a malformed carrier or a missing field
 * all come back as `{ok: false, error}` so the test suite can construct broken
 * trees and assert on them.
 *
 * @param {string} [base] repository root (defaults to this checkout)
 * @param {typeof VERSION_SOURCES} [sources] the group to check (defaults to the board's)
 * @returns {Promise<{ok: boolean, kind?: "drift"|"read", version?: string, sources?: {label: string, path: string, version: string}[], error?: string}>}
 */
export async function validateVersions(base = ROOT, sources = VERSION_SOURCES) {
  /** @type {{label: string, path: string, version: string}[]} */
  const found = [];
  for (const source of sources) {
    const result = await readSource(source, base);
    if (!result.ok) return { ok: false, kind: "read", sources: found, error: result.error };
    found.push({ label: source.label, path: source.path, version: result.version });
  }

  const canonical = found[0].version;
  const drifted = found.filter((entry) => entry.version !== canonical);
  if (drifted.length > 0) {
    const lines = drifted.map((entry) => `  ${entry.path} (${entry.label}) is ${entry.version}, expected ${canonical}`);
    return {
      ok: false,
      kind: "drift",
      version: canonical,
      sources: found,
      error: `version drift against ${sources[0].path} (${canonical}):\n${lines.join("\n")}`,
    };
  }

  return { ok: true, version: canonical, sources: found };
}

/**
 * Validate every version group. Each group stands alone — a group's manifests are compared
 * only with that group's canonical entry, never with another group's numbers. (There is one
 * group left, the board; the seam is kept so a second component can be added back without
 * re-deriving the check.)
 *
 * @param {string} [base]
 * @param {typeof VERSION_GROUPS} [groups]
 * @returns {Promise<{ok: boolean, results: Array<{name: string, sources: typeof VERSION_SOURCES, result: Awaited<ReturnType<typeof validateVersions>>}>}>}
 */
export async function validateVersionGroups(base = ROOT, groups = VERSION_GROUPS) {
  const results = [];
  for (const group of groups) {
    results.push({ name: group.name, sources: group.sources, result: await validateVersions(base, group.sources) });
  }
  return { ok: results.every((entry) => entry.result.ok), results };
}

/**
 * The canonical version of a group, read from that group's canonical manifest alone.
 *
 * @param {string} [base]
 * @param {typeof VERSION_SOURCES} [sources]
 * @returns {Promise<string|null>} `null` when the canonical manifest is unreadable
 */
export async function currentVersion(base = ROOT, sources = VERSION_SOURCES) {
  const result = await readSource(sources[0], base);
  return result.ok ? result.version : null;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: "boolean", default: false },
      base: { type: "string" },
      group: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  const groupNames = VERSION_GROUPS.map((group) => group.name);

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/version.mjs [--print] [--group <name>] [--base <dir>]\n\n" +
        "  --print        print a group's canonical version and exit (default: board)\n" +
        `  --group <name> check one group only (${groupNames.join(", ")}; default: all)\n` +
        "  --base <dir>   check a tree rooted at <dir> (default: this checkout)\n\n" +
        "There is one version group, the board; its canonical carrier is the root\n" +
        "package.json. The loop carries no version of its own — it is part of the toolkit\n" +
        "and declares the board interface it needs.\n",
    );
    return 0;
  }

  const base = values.base === undefined ? ROOT : resolve(values.base);

  let groups = VERSION_GROUPS;
  if (values.group !== undefined) {
    const selected = versionGroup(values.group);
    if (selected === null) {
      process.stderr.write(`version: unknown --group '${values.group}' (expected ${groupNames.join(", ")})\n`);
      return 2;
    }
    groups = [selected];
  }

  if (values.print) {
    const sources = groups[0].sources;
    const version = await currentVersion(base, sources);
    if (version === null) {
      process.stderr.write(`version: cannot read ${join(base, sources[0].path)}\n`);
      return 2;
    }
    process.stdout.write(`${version}\n`);
    return 0;
  }

  let status = 0;
  for (const { name, result } of (await validateVersionGroups(base, groups)).results) {
    if (!result.ok) {
      process.stderr.write(`version: FAILED (${name}) — ${result.error}\n`);
      // A missing/malformed carrier (2) reads differently from drift (1): the
      // first is a broken tree, the second a version that was not kept in sync.
      if (result.kind === "read") status = 2;
      else if (status === 0) status = 1;
      continue;
    }
    for (const entry of result.sources) {
      process.stdout.write(`  ${entry.version}  ${entry.path}  (${entry.label})\n`);
    }
    process.stdout.write(
      `version: OK — all ${result.sources.length} ${name} version carriers agree on ${result.version}\n`,
    );
  }

  return status;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
