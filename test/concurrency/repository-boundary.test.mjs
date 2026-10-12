/**
 * R3 — the repository API is an internal contract, and it defends itself
 * (card T-20261012-234647).
 *
 * The audit's source-level counterexample: bypassing the command layer, two
 * direct calls — `claimCas` (todo → in_progress) and then `stealStaleClaim` —
 * wrote the same row twice; two `stealStaleClaim` calls stole from each other in
 * sequence. Neither is reachable from the CLI or the HTTP surface, but the only
 * thing standing in the way was that every *current* caller happened to be
 * polite.
 *
 * Two answers, both asserted here:
 *
 *   1. **The predicate moved into the writer.** `stealStaleClaim` now requires a
 *      `staleBefore` bound and clamps it to its own fresh-window floor, so a
 *      claim taken a moment ago cannot be stolen by anyone, whatever bound the
 *      caller states. The suite below reproduces the audit's double write and
 *      shows it is now refused, with the row untouched.
 *   2. **The boundary is machine-checked.** Nothing outside `src/core` imports a
 *      repository, and the `*Cas` writes are called only from
 *      `src/core/commands/**` — the layer that wraps each of them in one
 *      transaction with its domain checks and its audit row. The scan reads the
 *      source text, so a violation fails even in a file nothing imports yet.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { normalizeTaskCreate } from "../../src/core/domain/task.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { cleanupTempDirs, withBoard } from "../helpers/sqlite-fixture.mjs";
import { importedSpecifiers, listModuleFiles, readSource, stripComments } from "../helpers/source-scan.mjs";

after(cleanupTempDirs);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A stamp a full day before `NOW` — a claim that has rotted past six hours. */
const ROTTED_AT = "2026-10-07T00:00:00.000Z";
/** "Now" for every assertion here: the fixture's canonical stamp. */
const NOW = "2026-10-08T00:00:00.000Z";

async function board(fn) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    repos.projects.create({ id: "proj", name: "Project", now: NOW });
    const { identifier } = repos.projects.allocateIdentifier("proj");
    const task = repos.tasks.insert(
      normalizeTaskCreate(
        { title: "A task" },
        { now: NOW, id: `task-${identifier}`, identifier, projectId: "proj" },
      ),
    );
    return fn({ db, repos, task });
  });
}

describe("concurrency/repository-boundary — the source scan", () => {
  it("no surface imports a repository directly", () => {
    const violations = [];
    for (const dir of ["src/cli", "src/server"]) {
      for (const file of listModuleFiles(resolve(ROOT, dir))) {
        for (const specifier of importedSpecifiers(readSource(file))) {
          if (/repositories\//.test(specifier)) {
            violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
          }
        }
      }
    }
    assert.deepEqual(violations, [], "writes reach the store through board.commands, never through a repository");
  });

  it("the claim and state-change CAS writes are called only from the command layer", () => {
    const files = listModuleFiles(resolve(ROOT, "src"));
    assert.ok(files.length > 50, `expected to scan the whole source tree, found ${files.length} files`);

    // *Calls* (`repos.tasks.moveCas(`), not the declarations in the store — and
    // only the three names the audit's finding is about. `archive` is left out
    // on purpose: `commands.archive(` is a command, not a CAS, and matching it
    // would make this scan cry wolf.
    const found = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const source = stripComments(readSource(file));
      for (const match of source.matchAll(/\.(claimCas|stealStaleClaim|moveCas)\(/g)) {
        found.push({ rel, name: match[1] });
      }
    }

    assert.ok(found.length > 0, "the scan matched nothing — the pattern is wrong, not the tree");
    const strays = found.filter((hit) => !hit.rel.startsWith("src/core/commands/"));
    assert.deepEqual(
      strays.map((hit) => `${hit.rel} → ${hit.name}`),
      [],
      "a bare claim/move CAS outside src/core/commands is a double write waiting to happen",
    );
  });

  it("names the one sanctioned exception instead of letting it hide", () => {
    // `updateCas` has a second caller: the md importer, which writes history
    // directly and deliberately (it is not a use-case — see `core/README.md`).
    // It is listed here so that *any other* new caller — including one in a
    // surface — is a failure rather than a silent pass.
    const allowed = new Set(["src/core/storage/md/import.mjs"]);
    const files = listModuleFiles(resolve(ROOT, "src"));
    const callers = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      if (/\.updateCas\(/.test(stripComments(readSource(file)))) callers.push(rel);
    }
    const unauthorised = callers.filter(
      (rel) => !rel.startsWith("src/core/commands/") && !allowed.has(rel),
    );
    assert.deepEqual(unauthorised, [], "only the command layer and the documented importer may patch a task");
    assert.deepEqual(callers.filter((rel) => allowed.has(rel)), [...allowed], "the exception is still real");
  });
});

describe("concurrency/repository-boundary — the double write the audit found", () => {
  it("refuses a steal of a claim that was just taken", async () => {
    await board(({ repos, task }) => {
      const claimed = repos.tasks.claimCas({ id: task.id, actor: "linus", now: NOW });
      assert.equal(claimed.claimed, true);
      assert.equal(claimed.task.version, 2);

      // The audit's sequence: `claimCas` then a bare `stealStaleClaim`. The
      // claim's heartbeat is `NOW` — fresh — so no bound the caller can state
      // makes it stealable.
      assert.throws(
        () => repos.tasks.stealStaleClaim({ id: task.id, actor: "elon", now: NOW, staleBefore: NOW }),
        (err) => err.code === "VALIDATION_FAILED",
        "the CAS matched no row, so the caller is told it lost",
      );

      const after = repos.tasks.get(task.id);
      assert.equal(after.claimedBy, "linus", "the first claim is still the claim");
      assert.equal(after.version, 2, "and the version moved exactly once — no double write");
    });
  });

  it("refuses a steal even when the caller asks for an absurdly loose bound", async () => {
    await board(({ repos, task }) => {
      repos.tasks.claimCas({ id: task.id, actor: "linus", now: NOW });
      const tomorrow = new Date(new Date(NOW).getTime() + 24 * 60 * 60 * 1000).toISOString();
      assert.throws(
        () => repos.tasks.stealStaleClaim({ id: task.id, actor: "elon", now: NOW, staleBefore: tomorrow }),
        (err) => err.code === "VALIDATION_FAILED",
        "the fresh-window floor clamps the stated bound — it cannot be loosened away",
      );
      assert.equal(repos.tasks.get(task.id).claimedBy, "linus");
    });
  });

  it("refuses the second of two bare steals of the same stale claim", async () => {
    await board(({ repos, task }) => {
      // A claim that really has rotted (a day old), taken by linus.
      repos.tasks.claimCas({ id: task.id, actor: "linus", now: ROTTED_AT });
      const first = repos.tasks.stealStaleClaim({ id: task.id, actor: "elon", now: NOW, staleBefore: NOW });
      assert.equal(first.claimedBy, "elon");
      assert.equal(first.version, 3);

      // The audit's second counterexample: two bare steals. The first refreshed
      // the heartbeat to `NOW`, so the second has nothing stale to take.
      assert.throws(
        () => repos.tasks.stealStaleClaim({ id: task.id, actor: "third", now: NOW, staleBefore: NOW }),
        (err) => err.code === "VALIDATION_FAILED",
      );
      const after = repos.tasks.get(task.id);
      assert.equal(after.claimedBy, "elon", "one winner, as the command layer always produced");
      assert.equal(after.version, 3, "one write");
    });
  });

  it("demands the staleness bound rather than defaulting to 'anything goes'", async () => {
    await board(({ repos, task }) => {
      repos.tasks.claimCas({ id: task.id, actor: "linus", now: ROTTED_AT });
      for (const staleBefore of [undefined, "", "   ", 42]) {
        assert.throws(
          () => repos.tasks.stealStaleClaim({ id: task.id, actor: "elon", now: NOW, staleBefore }),
          (err) => err.code === "VALIDATION_FAILED" && err.details.field === "staleBefore",
          `staleBefore=${JSON.stringify(staleBefore)}`,
        );
      }
      assert.equal(repos.tasks.get(task.id).claimedBy, "linus", "nothing was written");
    });
  });

  it("still allows the steal the command layer actually means", async () => {
    await board(({ repos, task }) => {
      repos.tasks.claimCas({ id: task.id, actor: "linus", now: ROTTED_AT });
      // `now − 6h` is what `performClaim` passes for a rotted claim, and it is
      // stricter than the floor, so the repository honours it.
      const bound = new Date(new Date(NOW).getTime() - 6 * 60 * 60 * 1000).toISOString();
      const stolen = repos.tasks.stealStaleClaim({ id: task.id, actor: "elon", now: NOW, staleBefore: bound });
      assert.equal(stolen.claimedBy, "elon");
      assert.equal(stolen.heartbeatAt, NOW, "a takeover refreshes the lock");
    });
  });
});
