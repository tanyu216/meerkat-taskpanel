#!/usr/bin/env node
/**
 * Materialize the server runtime tree.
 *
 * This is the one copy implementation, shared by the source installer
 * (`scripts/install/server.sh` from a checkout) and the npm/npx installer
 * (`scripts/install/cli.mjs` from the published package). The only difference
 * is the source root.
 *
 * The installed tree is self-locating: both the server and the CLI derive their
 * program root from their own module path (`src/foundation/runtime-locator.mjs`),
 * so `.env`, `.data` and `web/dist` resolve inside the tree with no environment.
 *
 * Managed bytes (`src/**`, package metadata, `web/dist`, the launchers) are
 * refreshed on every run. The two durable pieces — `.env` and `.data` — are
 * never written here except for creating `.data` when it is absent.
 *
 * Node builtins only.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, cpSync, readFileSync, readdirSync, rmSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { isEntryPoint } from "../../../src/foundation/entry-guard.mjs";
import { render, writeFileIdempotent } from "./apply.mjs";

/** Files copied beside `src/` for metadata and licenses. */
export const META_FILES = Object.freeze(["package.json", "README.md", "README.zh-CN.md", "LICENSE"]);

/** The launchers rendered into `<tree>/bin/`. */
export const LAUNCHERS = Object.freeze([
  { name: "taskd", entry: "src/server/main.mjs" },
  { name: "taskctl", entry: "src/cli/index.mjs" },
]);

/**
 * Where the digest of the last copied `src/` is recorded. At the tree root, so a
 * `--force` (which prunes `src/`) cannot delete it, and distinct from `.env` /
 * `.data` (the operator's) and `web/` (derived).
 */
export const INSTALL_STATE_FILE = ".install-state.json";

/**
 * A content digest of `src/**`.
 *
 * The install copies bytes unconditionally and `cpSync` rewrites mtimes, so
 * neither mtime nor "the copy ran" says whether anything actually changed. A
 * digest says it exactly, and it works the same for a checkout and for an
 * installed npm package (git is not available in the latter).
 *
 * @param {string} dir the `src/` directory
 * @returns {string} `sha256:<hex>`
 */
export function srcDigest(dir) {
  const hash = createHash("sha256");
  const walk = (base, rel) => {
    const entries = readdirSync(join(base, rel), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(base, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(join(base, childRel));
      hash.update(childRel);
      hash.update("\0");
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
    }
  };
  walk(dir, "");
  return `sha256:${hash.digest("hex")}`;
}

/** @param {string} tree @returns {{srcDigest?: string}|null} */
export function readInstallState(tree) {
  try {
    return JSON.parse(readFileSync(join(tree, INSTALL_STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

function writeInstallState(tree, value) {
  writeFileSync(join(tree, INSTALL_STATE_FILE), `${JSON.stringify(value, null, 2)}\n`);
}

const WEB_ONLY_WARNING =
  "web/dist is absent and web/node_modules is not installed — installing API-only; " +
  "the UI will 404. Build it with 'npm --prefix web ci --offline && npm --prefix web run build' " +
  "and re-run, or use the container image / the published package.";

/**
 * What to do about the frontend, as data.
 *
 * `distDir` is `<root>/web/dist`; `nodeModulesDir` is `<root>/web/node_modules`.
 * The build branch never installs anything: it only runs when the modules are
 * already present, so it stays offline.
 *
 * @param {{distDir: string, nodeModulesDir: string, skipBuild?: boolean}} input
 * @returns {{action: "copy", source: string} | {action: "build", cwd: string} | {action: "warn", reason: string}}
 */
export function planWebInstall(input) {
  const { distDir, nodeModulesDir, skipBuild = false } = input;
  if (existsSync(join(distDir, "index.html"))) return { action: "copy", source: distDir };
  if (skipBuild) {
    return { action: "warn", reason: "web/dist is absent and --skip-web-build was set — installing API-only" };
  }
  if (existsSync(nodeModulesDir)) return { action: "build", cwd: dirname(distDir) };
  return { action: "warn", reason: WEB_ONLY_WARNING };
}

/** @param {string} path */
function isDirectory(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory();
}

/**
 * Copy the managed bytes into `<dest>`, then report the frontend plan.
 *
 * @param {{
 *   root: string,
 *   dest: string,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   skipWebBuild?: boolean,
 *   node?: string,
 *   log?: (line: string) => void,
 * }} input
 * @returns {{ok: boolean, warnings: string[], web: object, error?: string}}
 */
export function installServer(input) {
  const {
    root,
    dest,
    force = false,
    dryRun = false,
    skipWebBuild = false,
    node = process.execPath,
  } = input;
  const log = input.log ?? ((line) => process.stdout.write(`${line}\n`));
  const warnings = [];

  const srcRoot = resolve(root);
  const tree = resolve(dest);
  const source = {
    src: join(srcRoot, "src"),
    webDist: join(srcRoot, "web", "dist"),
    webModules: join(srcRoot, "web", "node_modules"),
  };

  if (!isDirectory(source.src)) {
    return { ok: false, warnings, web: { action: "none" }, error: `${source.src} is missing` };
  }

  // What is about to run, versus what ran last time. The copy is unconditional,
  // so only the digest can answer "did the code change?" — and that answer is
  // what decides whether a live board and a live pool must be restarted.
  const srcDigestNext = srcDigest(source.src);
  const previousSrcDigest = readInstallState(tree)?.srcDigest ?? null;
  const changed = previousSrcDigest !== srcDigestNext;

  if (dryRun) {
    log(`would copy ${source.src} -> ${join(tree, "src")}`);
    for (const name of META_FILES) {
      if (existsSync(join(srcRoot, name))) log(`would copy ${join(srcRoot, name)} -> ${join(tree, name)}`);
    }
    log(`would create ${join(tree, ".data")} (if absent; 0700)`);
    for (const launcher of LAUNCHERS) {
      log(`would write ${join(tree, "bin", launcher.name)} (0755)`);
    }
    const web = planWebInstall({
      distDir: source.webDist,
      nodeModulesDir: source.webModules,
      skipBuild: skipWebBuild,
    });
    log(web.action === "copy"
      ? `would copy ${web.source} -> ${join(tree, "web", "dist")}`
      : web.action === "build"
        ? `would run npm run build in ${web.cwd}`
        : `would install API-only: ${web.reason}`);
    log(`would ${changed ? "record a changed" : "record an unchanged"} src digest (${srcDigestNext})`);
    return { ok: true, changed, srcDigest: srcDigestNext, previousSrcDigest, warnings, web };
  }

  try {
    if (force) rmSync(join(tree, "src"), { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    cpSync(source.src, join(tree, "src"), { recursive: true, force: true });
    log(`copied ${source.src} -> ${join(tree, "src")}`);

    for (const name of META_FILES) {
      const file = join(srcRoot, name);
      if (!existsSync(file)) continue;
      cpSync(file, join(tree, name), { force: true });
      log(`copied ${file} -> ${join(tree, name)}`);
    }

    // `.data` is the durable half: create it once, never chmod an existing one.
    const dataDir = join(tree, ".data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
      log(`created ${dataDir} (0700)`);
    }

    let web = planWebInstall({
      distDir: source.webDist,
      nodeModulesDir: source.webModules,
      skipBuild: skipWebBuild,
    });
    if (web.action === "build") {
      log(`building web/dist in ${web.cwd}`);
      const built = spawnSync("npm", ["run", "build"], {
        cwd: web.cwd,
        encoding: "utf8",
        env: process.env,
      });
      if (built.status === 0 && existsSync(join(source.webDist, "index.html"))) {
        web = { action: "copy", source: source.webDist };
      } else {
        const detail = (built.stderr ?? "").trim().split("\n").at(-1) ?? `exit ${built.status}`;
        web = { action: "warn", reason: `web build failed (${detail}) — installing API-only` };
      }
    }
    if (web.action === "copy") {
      const target = join(tree, "web", "dist");
      rmSync(target, { recursive: true, force: true });
      cpSync(web.source, target, { recursive: true, force: true });
      log(`copied ${web.source} -> ${target}`);
    } else {
      warnings.push(web.reason);
      log(`warning: ${web.reason}`);
    }

    for (const launcher of LAUNCHERS) {
      const template = join(srcRoot, "scripts", "install", "templates", "server", launcher.name);
      // The template lives beside this installer in the package/checkout, so a
      // published package and a checkout render the same bytes.
      const content = render(readFileSync(template, "utf8"), {
        NODE: node,
        NAME: launcher.name,
        ENTRY: launcher.entry,
      });
      const written = writeFileIdempotent(join(tree, "bin", launcher.name), content, {
        force,
        executable: true,
      });
      log(`${written.status} ${join(tree, "bin", launcher.name)}`);
    }

    // Recorded only after a successful copy, so a failed run leaves the previous
    // digest in place and the next run still sees the change.
    writeInstallState(tree, {
      srcDigest: srcDigestNext,
      installedAt: new Date().toISOString(),
    });

    return { ok: true, changed, srcDigest: srcDigestNext, previousSrcDigest, warnings, web };
  } catch (err) {
    return {
      ok: false,
      warnings,
      web: { action: "none" },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// CLI (called by server.sh; not a public bin)
// ---------------------------------------------------------------------------

function parse(argv) {
  const out = { command: null, root: null, dest: null, force: false, dryRun: false, skipWebBuild: false, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--root") out.root = argv[++i] ?? null;
    else if (arg === "--dest") out.dest = argv[++i] ?? null;
    else if (arg === "--report") out.report = argv[++i] ?? null;
    else if (arg === "--force") out.force = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--skip-web-build") out.skipWebBuild = true;
    else if (out.command === null) out.command = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

const USAGE = `Usage: node scripts/install/lib/server-install.mjs install --root <source> --dest <tree> [--force] [--dry-run] [--skip-web-build] [--report <file>]

Materializes the runtime tree used by --target server. Called by server.sh;
not meant to be run by hand.

\`--report\` writes {ok, changed, srcDigest, previousSrcDigest} so the caller can
decide whether a running board and pool are now executing the previous code.
`;

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command !== "install") {
    process.stderr.write(`server-install: unknown subcommand: ${args.command ?? "(none)"}\n`);
    return 2;
  }
  if (args.root === null || args.dest === null) {
    process.stderr.write("server-install: --root and --dest are required\n");
    return 2;
  }
  const report = installServer({
    root: args.root,
    dest: args.dest,
    force: args.force,
    dryRun: args.dryRun,
    skipWebBuild: args.skipWebBuild,
    ...(process.env.MEERKAT_TASKPANEL_SKIP_WEB_BUILD === "1" ? { skipWebBuild: true } : {}),
  });

  // The caller cannot read a child's variables, so "did the code change?" is
  // handed over as a file. Written on failure too: `changed` then stays the
  // previous run's answer, and the caller must not treat it as fresh.
  // A dry run changes nothing — not even this one-line report.
  const reportFile = args.dryRun === true
    ? null
    : args.report ?? process.env.MEERKAT_TASKPANEL_SERVER_REPORT ?? null;
  if (reportFile !== null && reportFile !== "") {
    // One line on purpose: the shell reads it back with `read`, a builtin, so
    // the installer stays runnable under a PATH without coreutils.
    writeFileSync(
      reportFile,
      `${JSON.stringify({
        ok: report.ok === true,
        changed: report.changed === true,
        srcDigest: report.srcDigest ?? null,
        previousSrcDigest: report.previousSrcDigest ?? null,
      })}\n`,
    );
  }

  if (!report.ok) {
    process.stderr.write(`server-install: ${report.error}\n`);
    return 1;
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => process.exit(code));
}
