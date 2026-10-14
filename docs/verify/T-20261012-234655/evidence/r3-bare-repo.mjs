/**
 * R3 re-run — the repository API cannot be driven around the command layer.
 *
 * The audit's counterexample was two bare repository calls —
 * `claimCas` then `stealStaleClaim` — writing the same row twice. The fix has
 * two halves, and both are re-proved here against the SUT at `process.cwd()`:
 *
 *   1. **the predicate lives in the write.** `stealStaleClaim` demands a
 *      `staleBefore` bound and clamps it to its own freshness floor, so a claim
 *      taken a moment ago is not stealable however generous the caller's bound
 *      is — while a genuinely rotted claim is still stealable by the command
 *      layer's stricter bound;
 *   2. **the boundary is machine-checked.** No `src/cli`/`src/server` module
 *      imports a repository, and the `*Cas` writes are called only from
 *      `src/core/commands/**`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = process.cwd();
const CORE = `file://${REPO}/src/core`;
const { openDatabase, applyMigrations, createRepositories, normalizeTaskCreate, ensureParentDir } = {
  ...(await import(`${CORE}/storage/driver.mjs`)),
  ...(await import(`${CORE}/storage/migrations-runner.mjs`)),
  ...(await import(`${CORE}/storage/repositories/index.mjs`)),
  ...(await import(`${CORE}/domain/task.mjs`)),
  ...(await import(`${CORE}/storage/paths.mjs`)),
};
const { importedSpecifiers, listModuleFiles, readSource, stripComments } = await import(
  `file://${REPO}/test/helpers/source-scan.mjs`
);

const NOW = "2026-10-08T00:00:00.000Z";
const ROTTED_AT = "2026-10-07T00:00:00.000Z";
const dir = mkdtempSync(join(tmpdir(), "r3-probe-"));
const log = [];

function seededRepos(db) {
  const repos = createRepositories(db);
  repos.projects.create({ id: "proj", name: "Project", now: NOW });
  const insert = (now) => {
    const { identifier } = repos.projects.allocateIdentifier("proj");
    return repos.tasks.insert(
      normalizeTaskCreate({ title: "A task" }, { now, id: `task-${identifier}`, identifier, projectId: "proj" }),
    );
  };
  return { repos, insert };
}

try {
  const dbPath = join(dir, "data", "board.sqlite");
  ensureParentDir(dbPath);
  const db = await openDatabase({ path: dbPath });
  applyMigrations(db);
  const { repos, insert } = seededRepos(db);
  const task = insert(NOW);

  // The double write the audit found: claim, then steal with no regard for how
  // fresh the claim is.
  const claim = repos.tasks.claimCas({ id: task.id, actor: "linus", now: NOW });
  log.push({ step: "claimCas", claimed: claim.claimed, version: claim.task.version, claimedBy: claim.task.claimedBy });
  assert.equal(claim.claimed, true);

  for (const [label, staleBefore] of [
    ["same-instant", NOW],
    ["loose-bound (tomorrow)", new Date(new Date(NOW).getTime() + 24 * 60 * 60 * 1000).toISOString()],
    ["bound omitted", undefined],
  ]) {
    let outcome;
    try {
      repos.tasks.stealStaleClaim({
        id: task.id,
        actor: "elon",
        now: NOW,
        ...(staleBefore === undefined ? {} : { staleBefore }),
      });
      outcome = { code: "NO_ERROR" };
    } catch (err) {
      outcome = { code: err.code, http: err.http, field: err.details?.field };
    }
    const after = repos.tasks.get(task.id);
    log.push({ step: `bareSteal(${label})`, outcome, afterClaimedBy: after.claimedBy, afterVersion: after.version });
    assert.notEqual(outcome.code, "NO_ERROR", `${label}: a fresh claim is not stealable`);
    assert.equal(after.claimedBy, "linus", `${label}: the row did not move`);
    assert.equal(after.version, claim.task.version, `${label}: no second write`);
  }

  // A truly rotted claim is still stealable — the gate is staleness, not refusal.
  const rotten = insert(ROTTED_AT);
  repos.tasks.claimCas({ id: rotten.id, actor: "linus", now: ROTTED_AT });
  const strictBound = new Date(new Date(NOW).getTime() - 6 * 60 * 60 * 1000).toISOString();
  const stolen = repos.tasks.stealStaleClaim({ id: rotten.id, actor: "elon", now: NOW, staleBefore: strictBound });
  log.push({ step: "steal(rotted, strict bound)", claimedBy: stolen.claimedBy, bound: strictBound });
  assert.equal(stolen.claimedBy, "elon", "the steal the command layer means still works");

  // --- genuinely concurrent bare calls, from two real processes ---
  // Sequential calls can hide a double write behind "the second one happens to
  // lose". Two processes starting on the same instant is the audit's shape.
  const RACER = `
const [{ openDatabase }, { createRepositories }] = await Promise.all([
  import(process.env.PROBE_DRIVER),
  import(process.env.PROBE_REPOS),
]);
const db = await openDatabase({ path: process.env.PROBE_DB });
const repos = createRepositories(db);
while (Date.now() < Number(process.env.PROBE_START_AT)) {}
let payload;
try {
  const result =
    process.env.PROBE_OP === "claim"
      ? repos.tasks.claimCas({ id: process.env.PROBE_TASK, actor: process.env.PROBE_ACTOR, now: process.env.PROBE_NOW })
      : repos.tasks.stealStaleClaim({
          id: process.env.PROBE_TASK,
          actor: process.env.PROBE_ACTOR,
          now: process.env.PROBE_NOW,
          staleBefore: process.env.PROBE_BOUND,
        });
  payload = { ok: true, claimed: result.claimed ?? null, version: result.task?.version ?? null, claimedBy: result.task?.claimedBy ?? result.claimedBy ?? null };
} catch (err) {
  payload = { ok: false, code: err.code ?? null, http: err.http ?? null };
}
process.stdout.write("RESULT " + JSON.stringify(payload) + "\\n");
db.close();
`;

  function race(op, taskId, actor, bound) {
    const startAt = Date.now() + 500;
    const spawnOne = (oneActor) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", RACER], {
          env: {
            ...process.env,
            PROBE_DRIVER: `${CORE}/storage/driver.mjs`,
            PROBE_REPOS: `${CORE}/storage/repositories/index.mjs`,
            PROBE_DB: dbPath,
            PROBE_TASK: taskId,
            PROBE_ACTOR: oneActor,
            PROBE_NOW: NOW,
            PROBE_OP: op,
            PROBE_BOUND: bound ?? "",
            PROBE_START_AT: String(startAt),
          },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.once("error", reject);
        child.once("exit", (code) => {
          const match = out.match(/RESULT (\{.*\})/);
          if (match === null) reject(new Error(`racer ${oneActor} produced nothing (exit ${code}): ${err}`));
          else resolve(JSON.parse(match[1]));
        });
      });
    return Promise.all([spawnOne("racer-a"), spawnOne("racer-b")]);
  }

  const claimRace = insert(NOW);
  const claimResults = await race("claim", claimRace.id, "racer", null);
  const claimAfter = repos.tasks.get(claimRace.id);
  log.push({ step: "race: two processes bare claimCas", claimResults, afterVersion: claimAfter.version, claimedBy: claimAfter.claimedBy });
  assert.equal(claimResults.filter((result) => result.claimed === true).length, 1, "exactly one bare claim wins");
  assert.equal(claimAfter.version, claimRace.version + 1, "the row moved exactly once — no double write");

  const stealRace = insert(ROTTED_AT);
  repos.tasks.claimCas({ id: stealRace.id, actor: "linus", now: ROTTED_AT });
  const beforeSteal = repos.tasks.get(stealRace.id);
  const stealResults = await race("steal", stealRace.id, "racer", strictBound);
  const stealAfter = repos.tasks.get(stealRace.id);
  log.push({
    step: "race: two processes bare stealStaleClaim on the same rotted claim",
    stealResults,
    beforeVersion: beforeSteal.version,
    afterVersion: stealAfter.version,
    claimedBy: stealAfter.claimedBy,
  });
  assert.equal(
    stealResults.filter((result) => result.ok).length,
    1,
    "exactly one bare steal wins; the loser is told it lost",
  );
  assert.equal(stealAfter.version, beforeSteal.version + 1, "the steal wrote once, not twice");

  db.close();

  // --- the machine-checked boundary (the repo's own scanner, same helpers) ---
  const CAS_NAMES = ["claimCas", "stealStaleClaim", "moveCas"];
  const casCallers = [];
  for (const file of listModuleFiles(join(REPO, "src"))) {
    const source = stripComments(readSource(file));
    const relative = file.slice(REPO.length + 1);
    if (relative.startsWith("src/core/storage/")) continue; // the declarations themselves
    for (const name of CAS_NAMES) {
      // A *call* on a repository handle, not the declaration or a mention.
      if (new RegExp(`\\.${name}\\s*\\(`).test(source)) casCallers.push(`${relative}: ${name}`);
    }
  }
  const outsiderCalls = casCallers.filter((entry) => !entry.startsWith("src/core/commands/"));
  const surfaceImports = [];
  for (const dir of ["src/cli", "src/server"]) {
    for (const file of listModuleFiles(join(REPO, dir))) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (/repositories\//.test(specifier)) surfaceImports.push(`${file.slice(REPO.length + 1)} -> ${specifier}`);
      }
    }
  }
  log.push({
    step: "source scan",
    scannedFiles: listModuleFiles(join(REPO, "src")).length,
    casCallSites: casCallers,
    outsideCommandLayer: outsiderCalls,
    repositoryImportsFromSurfaces: surfaceImports,
  });
  assert.ok(casCallers.length > 0, "the scan actually found the call sites (a scan that finds nothing proves nothing)");
  assert.deepEqual(outsiderCalls, [], "the *Cas writes are called only from the command layer");
  assert.deepEqual(surfaceImports, [], "no CLI/HTTP module reaches a repository directly");

  console.log(JSON.stringify(log, null, 2));
  console.log("R3 PROBE PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
