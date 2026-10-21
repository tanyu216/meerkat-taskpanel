#!/usr/bin/env node
/**
 * Generate the **loop payload** carried by `skills/meerkat-loop/`.
 *
 * The loop is a deployment, not a library: what a host needs to run it is
 *
 *   * the **execution body** — `scripts/supervisor.mjs` (the tick), `scripts/wake-cwd.mjs`
 *     (the wake glue's directory resolver) and the `src/foundation/` modules those two import;
 *   * the **templates** the installer renders — the launchd / systemd / cron units, the
 *     three `wake-<host>.sh` glues, and the host config.
 *
 * Both are *generated* here, from the single sources this repository already keeps
 * (`scripts/`, `src/foundation/`, `scripts/install/templates/`), into
 *
 *   skills/meerkat-loop/scripts/**   + manifest.txt
 *   skills/meerkat-loop/templates/**
 *
 * Foundation travels under `scripts/foundation/` (not `src/foundation/`), so the loop's
 * `scripts/` tree is self-contained. That remap means the entry scripts cannot be literal
 * copies: their foundation specifiers are rewritten (`../src/foundation/x` →
 * `./foundation/x`), and only those specifiers. Foundation files keep their internal
 * relative shape, so their copies stay byte-for-byte identical. `--check` compares every
 * generated file against this transform and reports drift; it is wired into
 * `npm run check:skills` / CI — so editing `scripts/supervisor.mjs` without re-running
 * this script is a red build, not a silent divergence.
 *
 * `scripts/board-check.mjs` is the one exception inside a generated root: it is authored,
 * ships as-is, and is on `LOOP_AUTHORED_PATHS`, so neither `--check` nor the write-mode
 * prune ever touches it. Any other file under `scripts/` and `templates/` is generated
 * output.
 *
 * The `src/foundation/` tree is copied **only as a closure of the two roots above**: the
 * foundation modules the whole CLI depends on stay in place at the repository root and are
 * never moved — this script reads them and writes copies; it owns nothing upstream.
 *
 * `manifest.txt` is the closure itself, one **destination-relative** path per line
 * (`scripts/...`). It is generated, so the loop's *consumers* —
 * `scripts/install/_common.sh` (which copies the body into the host) and
 * `test/install/scheduling-units.test.mjs` (which proves the copy is closed under its own
 * imports) — read one file instead of each restating the list.
 *
 * Node builtins only; no network, no dependencies.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "../src/foundation/entry-guard.mjs";

/** Directory name of the loop skill, inside `skills/` and each host's `skills/`. */
export const LOOP_SKILL_NAME = "meerkat-loop";

/**
 * Roots this generator owns, relative to the loop skill root. Everything under them is
 * generated output — except the authored paths below.
 */
export const LOOP_GENERATED_ROOTS = Object.freeze(["scripts", "templates"]);

/** Repository-relative directory of the foundation layer. */
export const LOOP_FOUNDATION_REPO = "src/foundation";

/** Destination-relative directory the loop carries foundation under. */
export const LOOP_FOUNDATION_SKILL = "scripts/foundation";

/**
 * Hand-written files that live inside a generated root. `scripts/board-check.mjs` is the
 * skill's interface gate: authored, shipped as-is, never written over, reported as stale,
 * or pruned.
 */
export const LOOP_AUTHORED_PATHS = Object.freeze(["scripts/board-check.mjs"]);

/** The execution-body closure, written at the skill root. */
export const LOOP_MANIFEST = "manifest.txt";

/**
 * The entry points whose transitive relative imports make up the loop body.
 *
 * `supervisor.mjs` is the scheduler; `wake-cwd.mjs` is what the generated wake glue
 * calls to answer "which directory does this card's project live in?"; and
 * `scripts/loop/*.mjs` are the deterministic entries the continue turn invokes.
 * Every root must travel with the body, or an installed unit names a file the host
 * does not have. Listing the foundation modules explicitly is harmless (the closure
 * dedupes) and protects the shipped tree from a future computed import.
 */
export const LOOP_BODY_ROOTS = Object.freeze([
  "scripts/supervisor.mjs",
  "scripts/loop/options.mjs",
  "scripts/loop/runtime.mjs",
  "scripts/loop/runners.mjs",
  "scripts/loop/board.mjs",
  "scripts/loop/poll.mjs",
  "scripts/loop/patrol.mjs",
  "scripts/loop/workflow.mjs",
  "scripts/loop/continue.mjs",
  "scripts/loop/subscribe.mjs",
  "scripts/wake-cwd.mjs",
]);

/**
 * The installer templates the loop owns, as repository-relative paths under
 * `scripts/install/templates/`. Keys are the destination-relative paths under
 * `skills/meerkat-loop/templates/` — identical, so `emit_loop_file` renders the same
 * `scheduling/…`, `claude/wake-claude.sh`, `host/meerkat-taskpanel.env` names either way.
 *
 * The board-side templates (the Claude session-start hook and slash commands, the Codex
 * trigger and `AGENTS.md` snippet, the `taskctl` shims) are deliberately **not** here:
 * they wire a board into a host, which is the board skill's job.
 */
export const LOOP_TEMPLATE_FILES = Object.freeze([
  "scheduling/launchd/com.meerkat-taskpanel.ping.plist",
  "scheduling/launchd/com.meerkat-taskpanel.continue.plist",
  "scheduling/launchd/com.meerkat-taskpanel.subscribe.plist",
  "scheduling/systemd/meerkat-taskpanel-ping.service",
  "scheduling/systemd/meerkat-taskpanel-ping.timer",
  "scheduling/systemd/meerkat-taskpanel-continue.service",
  "scheduling/systemd/meerkat-taskpanel-continue.timer",
  "scheduling/systemd/meerkat-taskpanel-subscribe.service",
  "scheduling/cron/meerkat-taskpanel.cron",
  "claude/wake-claude.sh",
  "codex/wake-codex.sh",
  "pi/wake-pi.sh",
  "opencode/wake-opencode.sh",
  "cursor/wake-cursor.sh",
  "host/meerkat-taskpanel.env",
]);

/** Repository root implied by this file's location (`scripts/` → up one level). */
function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Absolute path of the loop skill source. */
export function resolveLoopSource(root) {
  return join(resolve(root), "skills", LOOP_SKILL_NAME);
}

/** Recursive file listing, relative to `dir`, sorted, `/`-separated. Missing dir → `[]`. */
async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(relative(dir, abs).split(sep).join("/"));
    }
  }
  await walk(resolve(dir));
  return out.sort();
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Every relative module specifier a source text imports (`import`/`export … from`, and a
 * dynamic `import()`).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function relativeImports(text) {
  const out = [];
  for (const re of [/from\s+["'](\.[^"']+)["']/g, /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g]) {
    for (const match of text.matchAll(re)) out.push(match[1]);
  }
  return out;
}

/** Map a repository-relative body path to its skill/host-relative destination. */
export function loopDest(rel) {
  const prefix = `${LOOP_FOUNDATION_REPO}/`;
  return rel.startsWith(prefix) ? `${LOOP_FOUNDATION_SKILL}/${rel.slice(prefix.length)}` : rel;
}

/** Map a destination-relative body path back to its repository source. */
export function loopSource(dest) {
  const prefix = `${LOOP_FOUNDATION_SKILL}/`;
  return dest.startsWith(prefix) ? `${LOOP_FOUNDATION_REPO}/${dest.slice(prefix.length)}` : dest;
}

/**
 * Rewrite only those relative specifiers that resolve into the foundation layer, so a
 * copied entry script points at the skill's own `scripts/foundation/` instead of the
 * repository's `src/foundation/`. Everything else — including quote style and spacing — is
 * preserved; foundation modules resolve to their own subtree and come out unchanged.
 *
 * This is the one documented transform between a source and its generated copy.
 *
 * @param {string} text source text
 * @param {string} sourceRel repository-relative path of the source file
 * @param {string} [root] repository root
 * @returns {string}
 */
export function transformBody(text, sourceRel, root = defaultRoot()) {
  const repo = resolve(root);
  const sourceAbs = join(repo, sourceRel);
  const destDir = dirname(loopDest(sourceRel));
  const prefix = `${LOOP_FOUNDATION_REPO}/`;

  const rewrite = (specifier) => {
    const target = resolve(dirname(sourceAbs), specifier);
    const targetRel = relative(repo, target).split(sep).join("/");
    if (!targetRel.startsWith(prefix)) return specifier;
    const destTarget = `${LOOP_FOUNDATION_SKILL}/${targetRel.slice(prefix.length)}`;
    const next = relative(destDir, destTarget).split(sep).join("/");
    return next.startsWith(".") ? next : `./${next}`;
  };

  return text
    .replace(/(from\s+)(["'])(\.[^"']+)\2/g, (match, before, quote, specifier) =>
      `${before}${quote}${rewrite(specifier)}${quote}`,
    )
    .replace(/(import\s*\(\s*)(["'])(\.[^"']+)\2(\s*\))/g, (match, before, quote, specifier, after) =>
      `${before}${quote}${rewrite(specifier)}${quote}${after}`,
    );
}

/**
 * The transitive closure of `LOOP_BODY_ROOTS` over relative imports, as
 * repository-relative paths, sorted.
 *
 * A specifier only resolves to a file (`./x.mjs`); anything that does not land on one is a
 * hard error rather than a silently shorter list — a body missing a member dies at load
 * time in the host, which is the failure this closure exists to prevent.
 *
 * @param {string} root repository root
 * @returns {Promise<string[]>}
 */
export async function loopBodyClosure(root = defaultRoot()) {
  const seen = new Set();
  const queue = [...LOOP_BODY_ROOTS];

  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;

    const abs = join(root, rel);
    if (!(await isFile(abs))) {
      throw new Error(`loop body member not found: ${rel} (from ${root})`);
    }
    seen.add(rel);

    const text = await readFile(abs, "utf8");
    for (const specifier of relativeImports(text)) {
      const target = resolve(dirname(abs), specifier);
      const targetRel = relative(root, target).split(sep).join("/");
      if (targetRel.startsWith("..")) {
        throw new Error(`${rel} imports ${specifier}, which leaves the repository (${target})`);
      }
      queue.push(targetRel);
    }
  }

  return [...seen].sort();
}

/** Absolute authored paths for one loop skill root. */
function authoredPaths(skill) {
  return new Set(LOOP_AUTHORED_PATHS.map((rel) => join(skill, rel)));
}

/** Refuse to generate over a hand-written file. */
function assertNoAuthoredCollision(skill, files) {
  const authored = authoredPaths(skill);
  for (const file of files) {
    if (!authored.has(file.dest)) continue;
    throw new Error(
      `sync-loop: generated ${file.rel} would overwrite authored ${relative(skill, file.dest)} — ` +
        "remove it from the body closure, or from LOOP_AUTHORED_PATHS if it is generated",
    );
  }
}

/** One generated file: where it comes from, where it goes. */
function loopFiles(root, bodyClosure) {
  const skill = resolveLoopSource(root);
  const out = [];
  for (const rel of bodyClosure) {
    const destRel = loopDest(rel);
    out.push({
      kind: "body",
      source: join(root, rel),
      sourceRel: rel,
      dest: join(skill, destRel),
      rel: destRel,
    });
  }
  for (const rel of LOOP_TEMPLATE_FILES) {
    out.push({
      kind: "template",
      source: join(root, "scripts", "install", "templates", rel),
      dest: join(skill, "templates", rel),
      rel,
    });
  }
  return out;
}

/** Every file this generator owns under the loop skill, sorted. */
function ownedPaths(root, bodyClosure) {
  const skill = resolveLoopSource(root);
  return [
    join(skill, LOOP_MANIFEST),
    ...loopFiles(root, bodyClosure).map((file) => file.dest),
  ].sort();
}

/**
 * Generate (or, with `check`, verify) the loop payload inside `skills/meerkat-loop/`.
 *
 * `check` never writes: it compares every generated path byte-for-byte and reports
 * missing / extra / differing files. A file this generator does not own — `SKILL.md`,
 * `references/`, the gate script under `scripts/` — is never touched or removed.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root
 * @param {boolean} [options.check] compare only — never write
 * @returns {Promise<{ok: boolean, check: boolean, skill: string, body: string[], files: Array<object>}>}
 */
export async function syncLoop({ root = defaultRoot(), check = false } = {}) {
  const base = resolve(root);
  const skill = resolveLoopSource(base);
  const bodyClosure = await loopBodyClosure(base);
  const body = [...new Set(bodyClosure.map(loopDest))].sort();
  const manifestText = `${body.join("\n")}\n`;
  const manifestDest = join(skill, LOOP_MANIFEST);

  const files = loopFiles(base, bodyClosure);
  assertNoAuthoredCollision(skill, files);
  const results = [];

  /**
   * Bring one generated path in line with its source (or, in `check` mode, say how far
   * out of line it is). `equal` and `written` are the two success states; `missing` and
   * `differing` are the two failures `--check` can report.
   */
  const reconcile = async (dest, text) => {
    let current = null;
    try {
      current = await readFile(dest, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (current === text) return "equal";
    if (check) return current === null ? "missing" : "differing";
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, text);
    return "written";
  };

  for (const file of files) {
    const source = await readFile(file.source, "utf8");
    const text = file.kind === "body" ? transformBody(source, file.sourceRel, base) : source;
    const state = await reconcile(file.dest, text);
    results.push({ ...file, state });
  }

  const manifestState = await reconcile(manifestDest, manifestText);

  if (check) {
    // Anything under a generated root that is neither owned above nor authored is stale
    // output from an older run — a renamed template, a dropped import. `--check` reports
    // it; a write drops it, so neither can leave a copy behind that nothing regenerates.
    const owned = new Set(ownedPaths(base, bodyClosure));
    const authored = authoredPaths(skill);
    const found = [];
    for (const sub of LOOP_GENERATED_ROOTS) {
      const dir = join(skill, sub);
      for (const rel of await listFiles(dir)) {
        const abs = join(dir, rel);
        if (!owned.has(abs) && !authored.has(abs)) found.push(abs);
      }
    }
    for (const path of found.sort()) {
      results.push({ kind: "extra", source: null, dest: path, rel: relative(skill, path), state: "extra" });
    }
  } else {
    await pruneUnowned(skill, new Set(ownedPaths(base, bodyClosure)));
  }

  const states = [manifestState, ...results.map((file) => file.state)];
  return {
    ok: states.every((state) => state === "equal" || state === "written"),
    check,
    skill,
    body,
    manifest: { dest: manifestDest, state: manifestState },
    files: results,
  };
}

/**
 * Remove files under the generated roots that this generator does not own.
 *
 * `scripts/` and `templates/` are generated wholesale (except the authored paths, which
 * are spared), so a file left there by a previous run — a renamed template, a dropped
 * import — is stale output, not user content. `SKILL.md` and `references/` live outside
 * those roots and are never touched.
 *
 * @param {string} skill loop skill root
 * @param {Set<string>} owned absolute paths to keep
 */
async function pruneUnowned(skill, owned) {
  const authored = authoredPaths(skill);
  for (const sub of LOOP_GENERATED_ROOTS) {
    const dir = join(skill, sub);
    for (const rel of await listFiles(dir)) {
      const abs = join(dir, rel);
      if (owned.has(abs) || authored.has(abs)) continue;
      await rm(abs, { force: true });
    }
  }
}

/** Human-readable report for one generated file, relative to the skill root. */
function formatFile(file, skill) {
  const rel = relative(skill, file.dest);
  if (file.state === "equal" || file.state === "written") {
    return `  ${file.state === "equal" ? "OK      " : "written "} ${rel}`;
  }
  return `  ${file.state.toUpperCase().padEnd(8)} ${rel}`;
}

const USAGE = `Usage: node scripts/sync-loop.mjs [--check] [--root <dir>]

Generates the loop payload (execution body + installer templates) inside
skills/${LOOP_SKILL_NAME}/: manifest.txt, and the generated scripts/ and templates/
trees, from this repository's own scripts/, src/foundation/ and
scripts/install/templates/. Foundation is carried under scripts/foundation/, so the
entry scripts' foundation specifiers are rewritten while every other byte is kept.
scripts/board-check.mjs is authored and is never written, reported as extra, or
pruned. Run through scripts/sync-skills.mjs — that is the entry point CI uses.

Options:
  --check        Only verify the generated payload is in sync; do not write.
  --root <dir>   Repository root (default: this repository).
  -h, --help     Show this help.`;

function parseArgs(argv) {
  const opts = { check: false, root: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--root") opts.root = argv[++i];
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else {
      process.stderr.write(`sync-loop: unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const report = await syncLoop({ root: opts.root, check: opts.check });

  console.log(
    report.check
      ? `Checking the loop payload (source: ${report.skill})`
      : `Generating the loop payload (source: ${report.skill})`,
  );
  console.log(
    `  ${report.manifest.state === "equal" ? "OK      " : report.manifest.state.padEnd(8)} manifest.txt (${report.body.length} file${report.body.length === 1 ? "" : "s"})`,
  );
  for (const file of report.files) console.log(formatFile(file, report.skill));

  if (report.ok) {
    console.log(report.check ? "loop payload: OK" : "loop payload: OK (written)");
    return 0;
  }

  console.error(
    report.check
      ? "\nloop payload: OUT OF DATE — run `node scripts/sync-skills.mjs` and commit the result."
      : "\nloop payload: FAILED — the generated payload does not match its sources.",
  );
  return 1;
}

// Only run when executed directly, so the sync entry point can import the functions above.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}

export { main as run };
