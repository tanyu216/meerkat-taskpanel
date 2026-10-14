/**
 * T-20261014-125122 — the **negative** round: four targeted mutations of the two
 * faces under review, each built and re-measured, then the pristine tip rebuilt
 * and re-measured.
 *
 * A green harness proves nothing on its own — a check that cannot go red is not
 * a check. Each mutation below removes exactly one of the things the acceptance
 * names, and the run records which check ids flip:
 *
 *   M1 drop-related   the third kind's group is dropped from the row
 *   M2 drop-labels    the groups keep their links but lose the kind's own name
 *   M3 delete-beat    the drawer-open focus hand-off is deleted outright
 *   M4 zero-beat      the beat is kept but loses its wait (`FOCUS_BEAT_MS = 0`,
 *                     the pre-`ff552f9` shape the fix replaced)
 *
 * Nothing here touches the worktree's sources: every mutation is applied to a
 * **copy** under the sandbox's scratch dir and built there, and the final
 * "restore" step rebuilds `web/dist` from the untouched worktree.
 *
 * Usage: node mutations.mjs [--scratch <dir>] [--out <json>]
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const WEB = join(REPO, "web");
const HARNESS = join(HERE, "verify-integration.mjs");
const EVIDENCE = join(HERE, "evidence");

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const SCRATCH = resolve(argOf("scratch", "/tmp/taskpanel-t-20261014-125122"));
const OUT = argOf("out", join(EVIDENCE, "mutations.json"));

const log = (line) => process.stdout.write(`${line}\n`);

/** Copy `web/` (sources only) into `dest`, with the installed tree symlinked. */
function stage(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of ["src", "public", "index.html", "vite.config.js", "package.json"]) {
    const from = join(WEB, entry);
    if (existsSync(from)) cpSync(from, join(dest, entry), { recursive: true });
  }
  symlinkSync(join(WEB, "node_modules"), join(dest, "node_modules"), "dir");
  return dest;
}

/** Build `dest` (a staged `web/` copy) and return the dist dir it wrote. */
function build(dest) {
  const result = spawnSync(process.execPath, [join(dest, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: dest,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`build failed in ${dest} (exit ${result.status})\n${result.stdout}\n${result.stderr}`);
  return join(dest, "dist");
}

/** The four mutations: each is a plain string rewrite of one face. */
const MUTATIONS = [
  {
    name: "M1-drop-related",
    leg: "relations",
    describe: "the third kind's group is dropped from the row (the 154930-2 shape before 082552's third name was merged back)",
    patch(body) {
      const before = "return (rel.relations ?? []).map((row) => {";
      const after = "return (rel.relations ?? []).filter((row) => row.type !== \"related\").map((row) => {";
      if (!body.includes(before)) throw new Error("M1 anchor not found");
      return body.replace(before, after);
    },
    expectRed: ["R3", "R4", "R5", "R6"],
  },
  {
    name: "M2-drop-labels",
    leg: "relations",
    describe: "the groups keep their links but lose the kind's own catalogue name (R14-B23's '分组与标签座位丢失')",
    patch(body) {
      const before = '              <span class="text-xs text-(--brand-text-3)" :data-i18n="`relations.${group.type}`">{{ group.category }}</span>\n';
      if (!body.includes(before)) throw new Error("M2 anchor not found");
      return body.replace(before, "");
    },
    expectRed: ["R4", "R5"],
  },
  {
    name: "M3-delete-beat",
    leg: "focus",
    describe: "the drawer-open focus hand-off is deleted outright (no beat, no focus move)",
    patch(body) {
      const start = body.indexOf("watch(open, (isOpen) => {");
      const endMarker = "  }, FOCUS_BEAT_MS);\n});";
      const end = body.indexOf(endMarker, start);
      if (start === -1 || end === -1) throw new Error("M3 anchor not found");
      return `${body.slice(0, start)}/* MUTATION(M3): the focus hand-off is deleted */${body.slice(end + endMarker.length)}`;
    },
    expectRed: ["S2", "S4", "D3", "F4", "F6"],
  },
  {
    name: "M4-zero-beat",
    leg: "focus",
    describe: "the beat is kept but loses its wait (`FOCUS_BEAT_MS = 0`) — the pre-ff552f9 shape: focus lands in the still-hidden first frame",
    patch(body) {
      const before = "const FOCUS_BEAT_MS = 200;";
      if (!body.includes(before)) throw new Error("M4 anchor not found");
      return body.replace(before, "const FOCUS_BEAT_MS = 0;");
    },
    expectRed: ["S1", "D4", "F4", "F6"],
  },
];

/** Run the harness and return its parsed report. */
function runHarness(dist, { leg = null, label, src = null }) {
  const out = join(EVIDENCE, `${label}.json`);
  const argv = [HARNESS, "--dist", dist, "--label", label, "--out", out];
  if (src) argv.push("--src", src);
  if (leg) argv.push("--only", leg);
  const result = spawnSync(process.execPath, argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const report = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { status: result.status, report, out, stdout: result.stdout };
}

const record = { scratch: SCRATCH, steps: [], at: new Date().toISOString() };

/* 0. the pristine tip, as the "before" reading ------------------------------ */
log("== 0 · pristine tip (built from the untouched worktree) ==");
{
  const built = spawnSync("npm", ["run", "build:web"], { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (built.status !== 0) throw new Error(`pristine build failed\n${built.stdout}\n${built.stderr}`);
  const run = runHarness(join(WEB, "dist"), { label: "state-pristine-before" });
  record.steps.push({ name: "pristine-before", ...stepSummary(run, []) });
  log(`   exit ${run.status} · ${run.report?.passed}/${run.report?.total} pass · failed ${run.report?.failed}`);
  if (run.status !== 0) throw new Error("the pristine tip is not green — the negative round is meaningless");
}

/* 1..4 the mutations -------------------------------------------------------- */
for (const mutation of MUTATIONS) {
  log(`== ${mutation.name} ==`);
  const dest = stage(join(SCRATCH, mutation.name));
  const file = join(dest, "src/components/detail/DetailDrawer.vue");
  const patched = mutation.patch(readFileSync(file, "utf8"));
  writeFileSync(file, patched);
  const dist = build(dest);
  const run = runHarness(dist, { leg: mutation.leg, label: mutation.name, src: dest });
  const failedIds = (run.report?.results ?? []).filter((r) => !r.pass).map((r) => r.id);
  const summary = { ...stepSummary(run, failedIds), describe: mutation.describe, expectRed: mutation.expectRed };
  record.steps.push({ name: mutation.name, ...summary });
  log(`   exit ${run.status} (gating ${mutation.leg}) · red ${failedIds.join(",") || "none"} · expected ⊇ ${mutation.expectRed.join(",")}`);
  const missing = mutation.expectRed.filter((id) => !failedIds.includes(id));
  if (run.status === 0) throw new Error(`${mutation.name} stayed green — the check does not discriminate`);
  if (missing.length) throw new Error(`${mutation.name} did not flip ${missing.join(",")}`);
}

/* 5. restore: rebuild the pristine artefact and re-measure ------------------ */
log("== restore · pristine tip rebuilt ==");
{
  const built = spawnSync("npm", ["run", "build:web"], { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (built.status !== 0) throw new Error(`restore build failed\n${built.stdout}\n${built.stderr}`);
  const run = runHarness(join(WEB, "dist"), { label: "state-pristine-after" });
  record.steps.push({ name: "pristine-after", ...stepSummary(run, []) });
  log(`   exit ${run.status} · ${run.report?.passed}/${run.report?.total} pass · failed ${run.report?.failed}`);
  if (run.status !== 0) throw new Error("the restored tree is not green");
}

function stepSummary(run, failedIds) {
  return {
    exit: run.status,
    reportPath: run.out,
    total: run.report?.total ?? null,
    passed: run.report?.passed ?? null,
    failed: run.report?.failed ?? null,
    failedIds,
  };
}

record.verdict = "each mutation flipped at least its named check; the restored tip is green again";
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
log(`\nwrote ${OUT}`);
