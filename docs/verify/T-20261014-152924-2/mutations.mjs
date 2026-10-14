#!/usr/bin/env node
/**
 * T-20261014-152924-2 acceptance ④ — the negative controls.
 *
 * A green suite proves nothing until it can be made red. Each mutant here is a
 * **verbatim revert of the fix under test** (or of the guard the fix relies on),
 * applied to a throwaway copy of the tree — `git archive HEAD` into
 * `/tmp`, one textual edit, one probe run. The verified worktree is never
 * touched (⑤).
 *
 *   M1  claim release reverted    → ① red (`in_progress → todo` keeps the lock,
 *                                    `todo → backlog` trips the CHECK again)
 *   M2  `not_assignee`'s i18n entry removed
 *                                 → ③ red (that code falls back to
 *                                    `error.generic` instead of its sentence)
 *   M3  `safeMessage`'s engine-text guard removed
 *                                 → ② red (the raw `CHECK constraint failed: …`
 *                                    rides out on `message`)
 *   M4  the toast renders the wire's `message` again
 *                                 → ③ red (the raw SQL is on screen)
 *
 * Then the same probes are re-run against the pristine tree: **restore → green**.
 *
 *   node …/mutations.mjs --worktree . --base /tmp/T-20261014-152924-2.XXXX
 */

import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const flag = name.startsWith("--") ? name : `--${name}`;
  const hit = process.argv.slice(2).find((a) => a === flag || a.startsWith(`${flag}=`));
  if (hit === undefined) return fallback;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const WORKTREE = resolve(String(arg("--worktree", resolve(HERE, "../../.."))));
const BASE = resolve(String(arg("--base", "/tmp/T-20261014-152924-2-mutants")));
// Every run gets its own directory: a mutant tree is only ever *unpacked,
// patched and read*, and a stale tree from a previous run would make `edit`'s
// one-occurrence guard fail (or, worse, silently measure the wrong thing).
const RUN = join(BASE, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(RUN, { recursive: true });

const PROBES = {
  one: join(HERE, "repro-claim-release.mjs"),
  two: join(HERE, "scan-error-envelope.mjs"),
  three: join(HERE, "check-ui-fallback.mjs"),
};

/** Unpack `git archive HEAD` of the verified tree into `dir`. */
function unpack(dir) {
  mkdirSync(dir, { recursive: true });
  const archive = spawnSync("git", ["-C", WORKTREE, "archive", "HEAD"], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const tar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout, maxBuffer: 512 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
}

/** Apply one textual edit, refusing a silent no-op. */
function edit(dir, relPath, from, to) {
  const file = join(dir, relPath);
  const before = readFileSync(file, "utf8");
  const count = before.split(from).length - 1;
  if (count !== 1) throw new Error(`edit ${relPath}: expected exactly 1 occurrence, found ${count}`);
  writeFileSync(file, before.replace(from, to));
}

/** Build `web/dist` for a tree (needed by the UI probe). */
function buildWeb(dir, outDir) {
  const nodeModules = join(RUN, "sut/web/node_modules");
  const target = join(dir, "web/node_modules");
  if (!existsSync(target)) symlinkSync(nodeModules, target, "dir");
  const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: join(dir, "web"),
    encoding: "utf8",
    timeout: 300000,
  });
  if (result.status !== 0) throw new Error(`vite build failed: ${result.stderr || result.stdout}`);
  return outDir;
}

/** Run one probe against one tree; return `{exit, failed, labels, stdout}`. */
function runProbe(probe, dir, extraArgs = []) {
  const out = join(RUN, `evidence-${probe.split("/").pop().replace(".mjs", "")}-${dir.split("/").pop()}.json`);
  const result = spawnSync(process.execPath, [probe, "--root", dir, "--out", out, ...extraArgs], {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    /* the probe threw before writing — the exit code and stdout still count */
  }
  const failedChecks = json === null ? [] : json.checks.filter((c) => !c.ok).map((c) => c.label);
  return {
    exit: result.status,
    failed: failedChecks.length,
    labels: failedChecks,
    verdict: json === null ? "no-json" : json.verdict,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").filter((line) => line.startsWith("FAIL") || line.includes("verdict")).join("\n"),
  };
}

// ------------------------------------------------------------ the pristine base

const SUT = join(RUN, "sut");
if (!existsSync(join(SUT, "src/core/index.mjs"))) unpack(SUT);
if (!existsSync(join(SUT, "web/node_modules/vite/package.json"))) {
  // The build toolchain is not part of the git archive; borrow the installed
  // one (read-only) so the UI mutants can be built offline.
  const installed = "/Users/tanyu/Documents/meerkat-taskpanel/web/node_modules";
  cpSync(installed, join(SUT, "web/node_modules"), { recursive: true });
}
const SUT_DIST = join(RUN, "dist-pristine");
if (!existsSync(join(SUT_DIST, "index.html"))) buildWeb(SUT, SUT_DIST);

// ------------------------------------------------------------ the mutant table

const MUTANTS = [
  {
    id: "M1",
    name: "claim release reverted (the pre-291bcd3 shape)",
    probe: "one",
    expectedRed: ["in_progress → todo **releases** the claim in the same write", "todo → backlog is accepted (no CHECK violation) and leaves claimed_by NULL"],
    patch: {
      rel: "src/core/storage/repositories/tasks.mjs",
      from: `          if (!holdsClaim(to)) {
            sets.push("claimed_by = NULL", "claimed_at = NULL", "heartbeat_at = NULL");
          }`,
      to: "          // M1 (mutant): the claim-release block is removed — the pre-fix shape.",
    },
  },
  {
    id: "M2",
    name: "i18n entry for `not_assignee` removed",
    probe: "three",
    expectedRed: ["page · mapped-notAssignee-en: the toast is the localized sentence for the code"],
    patch: { rel: "web/src/i18n/messages.mjs", from: `  not_assignee: "error.notAssignee",\n`, to: "" },
  },
  {
    id: "M3",
    name: "`safeMessage` engine-text guard removed",
    probe: "two",
    expectedRed: ["② sweep · every ERROR_CODES entry"],
    patch: {
      rel: "src/shared/errors.mjs",
      from: "  return TECHNICAL_ERROR_TEXT.test(message) ? entry.message : message;",
      to: "  return message; // M3 (mutant): the guard is removed",
    },
  },
  {
    id: "M4",
    name: "the toast renders the wire's `message` again",
    probe: "three",
    expectedRed: ["page · unknown-en: the wire's message is never rendered"],
    patch: {
      rel: "web/src/stores/board.js",
      from: "    const text = t(errorTextKey(err), task.identifier);",
      to: "    const text = err.message ?? t(errorTextKey(err), task.identifier); // M4 (mutant)",
    },
  },
];

const results = [];

for (const mutant of MUTANTS) {
  const dir = join(RUN, `mutant-${mutant.id}`);
  if (!existsSync(join(dir, "src/core/index.mjs"))) unpack(dir);
  edit(dir, mutant.patch.rel, mutant.patch.from, mutant.patch.to);

  const extra = [];
  if (mutant.probe === "three") {
    const dist = join(RUN, `dist-mutant-${mutant.id}`);
    if (!existsSync(join(dist, "index.html"))) buildWeb(dir, dist);
    extra.push("--dist", dist, "--label", mutant.id);
  }
  // A single-process Chromium occasionally dies mid-run in this sandbox
  // (exit 13 = the probe exited with a pending top-level await, and therefore
  // wrote no reading). That is a transport flake, not a result: retry once.
  let run = runProbe(PROBES[mutant.probe], dir, extra);
  if (run.verdict === "no-json") {
    console.log(`\n${mutant.id}: no reading the first time (exit ${run.exit}) — retrying once`);
    run = runProbe(PROBES[mutant.probe], dir, extra);
  }
  const hit = mutant.expectedRed.some((label) => run.labels.some((actual) => actual.startsWith(label) || actual.includes(label)));
  results.push({
    id: mutant.id,
    name: mutant.name,
    probe: mutant.probe,
    tree: dir,
    exit: run.exit,
    failed_checks: run.failed,
    expected_red_hit: hit,
    failed_labels: run.labels,
    summary: run.stdout,
  });
  console.log(`\n${mutant.id} — ${mutant.name}\n  tree=${dir} probe=${mutant.probe} exit=${run.exit} failed=${run.failed} expected_red_hit=${hit}`);
  for (const label of run.labels) console.log(`  RED  ${label}`);
  if (!hit) console.log(`  !! expected one of ${JSON.stringify(mutant.expectedRed)} to go red`);
}

// ------------------------------------------------------------ restore → green

const PRESTINE = {};
for (const [key, probe] of Object.entries(PROBES)) {
  const args = key === "three" ? ["--dist", SUT_DIST, "--label", "restored"] : [];
  let run = runProbe(probe, SUT, args);
  if (run.verdict === "no-json") run = runProbe(probe, SUT, args);
  PRESTINE[key] = { exit: run.exit, failed: run.failed, verdict: run.verdict };
  console.log(`\nrestore — probe ${key} on the pristine tree: exit=${run.exit} failed=${run.failed} verdict=${run.verdict}`);
}

const ok = results.every((r) => r.exit !== 0 && r.expected_red_hit) && Object.values(PRESTINE).every((r) => r.exit === 0);
const payload = { worktree: WORKTREE, base: BASE, mutants: results, pristine: PRESTINE, verdict: ok ? "PASS" : "FAIL" };
const out = join(HERE, "evidence/mutations.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\n${ok ? "PASS" : "FAIL"} — every mutant went red on the named assertion and the pristine tree stayed green`);
console.log(`readings → ${out}`);
process.exit(ok ? 0 : 1);
