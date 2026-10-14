#!/usr/bin/env node
/**
 * The gate's **frontend coverage** verdict: does `node --test` actually run the two
 * browser-side legs, or only look like it does?
 *
 * Two of the suites are held behind a `web/dist` guard:
 *
 *   * `test/web/blocks.bundle.test.mjs` — the hook surface survived the build;
 *   * `test/web/blocks.dom.test.mjs`    — the browser layer, via `web/scripts/dom-smoke.mjs`.
 *
 * Both **skip with a printed reason** when there is no build, which is the right call for
 * an absent tool (`scripts/verify/host-cli.mjs` set the precedent) — but it also means
 * `node --test`'s `fail 0` is true of a gate that never exercised them. A lane worktree has
 * no `web/dist` (it is a gitignored build product), so every lane reports `0 fail / 2 skip`
 * and reads the same as a run that covered both legs. The container adds a second blind
 * spot of its own: even with a build it ships no Chromium, so the DOM leg skips there too.
 *
 * This script turns that into a **verdict anyone can read**: it classifies the on-disk
 * build (`unbuilt` / `stale` / `fresh`), names each leg COVERED or UNCOVERED, and — when a
 * frontend toolchain is present — repairs a missing or stale build first, so the legs that
 * follow genuinely run. It never *silently* passes: an UNCOVERED leg is always printed, and
 * `--require` turns it into a non-zero exit for a gate that must not ship without it.
 *
 * **Stale is a false red, not a red.** A build older than `web/src` fails the bundle check
 * with "these hooks are absent from the bundle" and the DOM leg with a rule failure — both
 * of which read like contract violations and are really one stale artefact. Naming the
 * build state before the suites run is what makes that legible (the `--build` repair is
 * what makes it go away).
 *
 *   node scripts/verify/web-dist.mjs                    # report only (exit 0)
 *   node scripts/verify/web-dist.mjs --build            # repair first, then report
 *   node scripts/verify/web-dist.mjs --require=bundle   # fail (exit 3) if the bundle leg is blind
 *   node scripts/verify/web-dist.mjs --require=all      # fail if either leg is blind
 *   node scripts/verify/web-dist.mjs --json
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the built frontend lives, and the file whose absence means "not built". */
export const DIST_REL = "web/dist";
export const ENTRY_REL = "web/dist/index.html";

/**
 * What the build reads. A build is stale when any of these is **newer** than the artefact.
 *
 * Deliberately not `web/` as a whole: `web/scripts/` is the host harness, `web/manifests/`
 * is the ui-align manifest set, and `web/dist/` is the artefact itself — none of them is an
 * input to Vite, and folding them in would call a fresh build stale after any harness edit.
 */
const SOURCE_DIRS = ["web/src", "web/public"];
const SOURCE_FILES = ["web/index.html", "web/vite.config.js", "web/package.json", "web/package-lock.json"];

/** Where a frontend toolchain would land: the workspace root, or the package's own tree. */
const TOOLCHAIN_DIRS = ["node_modules", "web/node_modules"];

/** The build this script repairs with, unless `--build-cmd` says otherwise. */
const DEFAULT_BUILD_CMD = ["npm", "-w", "web", "run", "build"];

/* -------------------------------------------------------------- dist state */

function newestUnder(root, rel) {
  const start = join(root, rel);
  if (!existsSync(start)) return null;
  let newest = null;
  const visit = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const mtimeMs = statSync(child).mtimeMs;
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: relative(root, child), mtimeMs };
      }
    }
  };
  visit(start);
  return newest;
}

/** The newest build input, or null when the tree carries none of them. */
export function newestSource(root) {
  const candidates = [];
  for (const rel of SOURCE_DIRS) {
    const hit = newestUnder(root, rel);
    if (hit) candidates.push(hit);
  }
  for (const rel of SOURCE_FILES) {
    const abs = join(root, rel);
    if (existsSync(abs) && statSync(abs).isFile()) candidates.push({ path: rel, mtimeMs: statSync(abs).mtimeMs });
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

/**
 * Classify the on-disk build.
 *
 *   * `unbuilt` — no `web/dist/index.html`. The legs skip. An *empty* `web/dist` (the
 *     container's `mkdir -p` when `web/package.json` is absent) is the same state, and is
 *     reported as such rather than as a stale build of nothing.
 *   * `stale`   — built, but older than a source it was built from.
 *   * `fresh`   — built, and newer than every source.
 *
 * @returns {{state: "unbuilt"|"stale"|"fresh", entry: string, builtAt: number|null,
 *            distDirExists: boolean, newestSource: {path: string, mtimeMs: number}|null,
 *            reason: string}}
 */
export function classifyDist(root) {
  const entry = join(root, ENTRY_REL);
  const distDirExists = existsSync(join(root, DIST_REL));
  const source = newestSource(root);
  if (!existsSync(entry)) {
    return {
      state: "unbuilt",
      entry: ENTRY_REL,
      builtAt: null,
      distDirExists,
      newestSource: source,
      reason: distDirExists
        ? `${DIST_REL} exists but carries no index.html — the build has not run`
        : `${DIST_REL} is not built`,
    };
  }
  const built = newestUnder(root, DIST_REL);
  const builtAt = built?.mtimeMs ?? statSync(entry).mtimeMs;
  if (source && source.mtimeMs > builtAt) {
    return {
      state: "stale",
      entry: ENTRY_REL,
      builtAt,
      builtAtISO: iso(builtAt),
      distDirExists,
      newestSource: source,
      newestSourceISO: iso(source.mtimeMs),
      reason: `the build predates ${source.path} (built ${iso(builtAt)} · source ${iso(source.mtimeMs)})`,
    };
  }
  return {
    state: "fresh",
    entry: ENTRY_REL,
    builtAt,
    builtAtISO: iso(builtAt),
    distDirExists,
    newestSource: source,
    newestSourceISO: source ? iso(source.mtimeMs) : null,
    reason: "newer than every build input",
  };
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* ---------------------------------------------------------- leg coverage */

/**
 * Per-leg coverage from the two inputs that decide it: the build state, and whether a
 * browser is reachable.
 *
 * `browser` is `{ok: true}` / `{ok: false, reason}`. When it is `null` the browser question
 * was not asked (`--browser-probe=off`) — and because "not asked" must never read as
 * "covered", the DOM leg is then reported UNCOVERED.
 */
export function legs(dist, browser) {
  const buildOk = dist.state === "fresh";
  const bundle = {
    covered: buildOk,
    reason: buildOk ? "the build is on disk and newer than every source" : dist.reason,
  };
  let dom;
  if (!buildOk) dom = { covered: false, reason: dist.reason };
  else if (browser === null) dom = { covered: false, reason: "the browser probe was off — coverage not established" };
  else if (!browser.ok) dom = { covered: false, reason: `no browser: ${browser.reason}` };
  else dom = { covered: true, reason: "Playwright resolves and Chromium launches on this host" };
  return { bundle, dom };
}

/* ------------------------------------------------------------- the repair */

/** The team's build-write lock, when the checkout sits beside one. */
export function resolveBuildGuard(root) {
  const candidates = [
    process.env.OPENCLAW_TEAM_BUILD_GUARD,
    join(process.env.OPENCLAW_TEAM_ROOT ?? join(homedir(), ".openclaw", "team"), "scripts", "build-guard.mjs"),
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Is there a frontend toolchain in this tree to build with? */
export function hasToolchain(root) {
  return TOOLCHAIN_DIRS.some((rel) => existsSync(join(root, rel)));
}

/**
 * Run the build. Through `build-guard.mjs run` when it is present, so a whole-tree build
 * never races another lane's write; otherwise directly, and the caller is told which.
 * `guard === "off"` always runs directly — the container (no team tree) and the tests use it.
 *
 * @returns {{ok: boolean, rc: number|null, via: "build-guard"|"direct", cmd: string[], tail: string, cause?: string, error?: string}}
 */
export function runBuild(root, cmd = DEFAULT_BUILD_CMD, guardMode = "auto") {
  const guard = guardMode === "off" ? null : resolveBuildGuard(root);
  const argv = guard ? [process.execPath, guard, "run", "--name", "web-dist", "--", ...cmd] : cmd;
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: "utf8", timeout: 600_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const lines = output.trim().split("\n");
  const tail = lines.slice(-6).join("\n");
  // npm's last lines are its own summary; the *cause* is the first error line above them
  // (the missing native binding, say), so it is reported separately rather than buried.
  const cause = lines.slice(-60).find((line) => /error/i.test(line) && !tail.includes(line))?.trim();
  // build-guard's `run` exits 1 **without running the command** when the lock is held, and
  // says so only in its JSON envelope (`ok` there means "no error", not "acquired"). Read
  // that as a skip: reporting it as a failed build would blame the build for a lock.
  const lockBusy = guard !== null && /"reason"\s*:\s*"busy"/.test(output);
  return {
    ok: result.status === 0,
    rc: result.status,
    via: guard ? "build-guard" : "direct",
    lockBusy,
    reason: lockBusy ? "another lane holds the build lock — the rebuild was not attempted" : undefined,
    cmd: argv,
    tail,
    cause,
    error: result.error ? String(result.error.message) : undefined,
  };
}

/* --------------------------------------------------------------- browser */

/**
 * Is the DOM leg actually runnable here?
 *
 * Asked by *doing*: `dom-smoke.mjs` exports the resolver it uses, and a resolver that
 * returns a module is not the same as a browser that launches (the npm package can be
 * installed with its browser download skipped) — so the probe launches and closes one.
 * A `web/dist` guard sits in front of both, so the answer is only meaningful for a build
 * that exists; `legs()` never consults it otherwise.
 */
export async function probeBrowser(root) {
  const smoke = join(root, "web/scripts/dom-smoke.mjs");
  if (!existsSync(smoke)) return { ok: false, reason: "web/scripts/dom-smoke.mjs is missing" };
  let resolvePlaywright;
  try {
    ({ resolvePlaywright } = await import(pathToFileURL(smoke).href));
  } catch (err) {
    return { ok: false, reason: `web/scripts/dom-smoke.mjs could not be loaded: ${err.message}` };
  }
  const playwright = resolvePlaywright();
  if (!playwright) return { ok: false, reason: "Playwright is not installed on this host" };
  try {
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close();
  } catch (err) {
    return { ok: false, reason: `could not launch Chromium: ${err.message}` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ main */

const USAGE = [
  "Usage: node scripts/verify/web-dist.mjs [options]",
  "",
  "  --require=<none|bundle|all>  which legs the caller insists on   (default none)",
  "  --build                      rebuild web/dist first when it is missing or stale",
  "  --build-cmd=<command>        build command to run (split on whitespace; default `npm -w web run build`)",
  "  --build-guard=<auto|off>     auto ⇒ serialize through the team's build-guard lock (default auto)",
  "  --browser-probe=<auto|off>   off ⇒ never claim the DOM leg is covered (default auto)",
  "  --root=<dir>                 tree to inspect                    (default the repository root)",
  "  --json                       machine-readable verdict",
  "  -h, --help",
  "",
  "Exit: 0 the required legs are covered · 3 a required leg is UNCOVERED · 2 usage/IO error.",
].join("\n");

function render(verdict, out) {
  const { dist, coverage, required, uncovered } = verdict;
  out.write(`—— web coverage — ${DIST_REL}: ${dist.state.toUpperCase()} (${dist.reason})\n`);
  for (const [name, leg] of Object.entries(coverage)) {
    out.write(`     blocks.${name.padEnd(7)} ${(leg.covered ? "COVERED  " : "UNCOVERED")}  ${leg.reason}\n`);
  }
  out.write(`     required: ${required}\n`);
  if (verdict.build?.lockBusy) {
    out.write(`     build: SKIPPED — ${verdict.build.reason}\n`);
  } else if (verdict.build?.attempted) {
    out.write(`     build: ${verdict.build.ok ? "ok" : "FAILED"} via ${verdict.build.via} (${verdict.build.cmd.join(" ")})\n`);
    if (!verdict.build.ok && verdict.build.cause) out.write(`       cause: ${verdict.build.cause}\n`);
    if (!verdict.build.ok && verdict.build.tail) out.write(`${verdict.build.tail.replace(/^/gm, "       | ")}\n`);
  }
  if (uncovered.length > 0) {
    out.write(
      `     NOT A PASS for: ${uncovered.join(", ")} — a green suite means only that the legs that ran\n` +
        `     were green. Fail closed with \`node scripts/verify/web-dist.mjs --require=all\`.\n`,
    );
  }
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  const { values } = parseArgs({
    args: argv,
    options: {
      require: { type: "string", default: "none" },
      build: { type: "boolean", default: false },
      "build-cmd": { type: "string" },
      "build-guard": { type: "string", default: "auto" },
      "browser-probe": { type: "string", default: "auto" },
      root: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  const required = values.require;
  if (!["none", "bundle", "all"].includes(required)) {
    out.write(`unknown --require: ${required} (expected none|bundle|all)\n`);
    return 2;
  }
  if (!["auto", "off"].includes(values["browser-probe"])) {
    out.write(`unknown --browser-probe: ${values["browser-probe"]} (expected auto|off)\n`);
    return 2;
  }
  if (!["auto", "off"].includes(values["build-guard"])) {
    out.write(`unknown --build-guard: ${values["build-guard"]} (expected auto|off)\n`);
    return 2;
  }
  const root = values.root ? resolve(values.root) : ROOT;

  let build = { attempted: false, ok: null, via: null, cmd: [], tail: "" };
  let dist = classifyDist(root);
  if (values.build && dist.state !== "fresh") {
    if (!hasToolchain(root)) {
      build = { ...build, attempted: false, reason: `no frontend toolchain in ${root} (${TOOLCHAIN_DIRS.join(" / ")} absent)` };
    } else {
      const cmd = values["build-cmd"] ? values["build-cmd"].split(/\s+/).filter(Boolean) : DEFAULT_BUILD_CMD;
      build = { attempted: true, ...runBuild(root, cmd, values["build-guard"]) };
      dist = classifyDist(root);
    }
  }

  const buildOk = dist.state === "fresh";
  const browser = !buildOk || values["browser-probe"] === "off" ? null : await probeBrowser(root);
  const coverage = legs(dist, browser);
  const uncovered = Object.entries(coverage).filter(([, leg]) => !leg.covered).map(([name]) => name);
  const needed = required === "none" ? [] : required === "bundle" ? ["bundle"] : ["bundle", "dom"];
  const missing = needed.filter((name) => uncovered.includes(name));
  const allCovered = uncovered.length === 0;
  const verdict = {
    // `ok` is the *exit* question (may this caller proceed?), `allCovered` the coverage one.
    // They differ under the default `--require=none`: an unbuilt tree is reported honestly
    // and still exits 0, because a lane worktree cannot be made to build one.
    ok: missing.length === 0,
    allCovered,
    uncovered,
    dist,
    coverage,
    required,
    requiredMissing: missing,
    build,
  };

  if (values.json) out.write(`${JSON.stringify(verdict, null, 2)}\n`);
  else render(verdict, out);
  return missing.length === 0 ? 0 : 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
