/**
 * M5: the reconciliation harness end-to-end (synthetic fixtures only).
 *
 * It runs the whole shadow drill — import → export → re-import → second import —
 * and asserts the report's contract, its exit codes, and that a report which
 * travels through the public repo can never carry a card's title or body.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { FIELD_SPECS, main } from "../../scripts/migrate/reconcile.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const HERE = import.meta.dirname;
const CLEAN = join(HERE, "fixtures/clean");
const DIFF = join(HERE, "fixtures/diff");
const REGISTRY = join(HERE, "fixtures/registry/projects.json");

/** Run the harness, returning its exit code, stdout and the parsed report. */
async function run(args) {
  let out = "";
  let err = "";
  const code = await main(args, { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  let report = null;
  try {
    report = JSON.parse(out);
  } catch {
    /* a usage/error path prints prose, not JSON */
  }
  return { code, out, err, report };
}

/** The report written to disk, parsed. */
function readOut(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("migrate/reconcile — a clean directory reconciles with zero differences", () => {
  it("exits 0, writes the report, and reports full parity", async () => {
    const outPath = join(makeTempDir("reconcile-out-"), "report.json");
    const { code, report } = await run([
      "--dir",
      CLEAN,
      "--projects",
      REGISTRY,
      "--out",
      outPath,
      "--now",
      "2026-01-10T00:00:00.000Z",
      "--json",
    ]);

    assert.equal(code, 0);
    assert.deepEqual(report.differences, []);
    assert.equal(report.total, 4);
    assert.equal(report.counts.imported, 4);
    assert.equal(report.counts.reimported, 4);
    assert.equal(report.counts.exported, 4);
    assert.equal(report.idempotent, true);
    assert.equal(report.roundtripEquivalent, true);

    // every §4.8 field is accounted for, and every one survived
    assert.equal(report.perField.length, FIELD_SPECS.length);
    for (const row of report.perField) assert.equal(row.changed, 0, `${row.field} drifted`);

    // sections, relations and labels all match
    for (const row of Object.values(report.sections)) assert.equal(row.mismatching, 0);
    assert.equal(report.content.background.mismatching, 0);
    assert.equal(report.relations.parent.mismatching, 0);
    assert.equal(report.relations.dependsOn.mismatching, 0);
    assert.equal(report.labels.mismatching, 0);

    // project-level diff: the registry root is the workspace path
    assert.equal(report.projects.length, 1);
    assert.equal(report.projects[0].id, "demo");
    assert.equal(report.projects[0].matches, true);
    assert.equal(report.projects[0].gitRules.registryDefault, "present");

    // hashes: one per card, plus a stable aggregate
    assert.equal(report.hashes.cards.length, 4);
    assert.match(report.hashes.aggregate, /^[0-9a-f]{64}$/);

    // warnings are allowed (DEMO-0004 has no ## Report) and do not fail the run
    assert.ok(report.warnings.some((warning) => /no ## Report/.test(warning)));

    const onDisk = readOut(outPath);
    assert.deepEqual(onDisk.differences, report.differences);
    assert.equal(onDisk.hashes.aggregate, report.hashes.aggregate);
  });

  it("also reconciles without a registry (legacy id = name)", async () => {
    const { code, report } = await run(["--dir", CLEAN, "--now", "2026-01-10T00:00:00.000Z", "--json"]);
    assert.equal(code, 0, JSON.stringify(report?.differences));
    assert.equal(report.source.registryEntries, 0);
    assert.equal(report.projects[0].registryRoot, null);
  });
});

describe("migrate/reconcile — a lossy directory reports differences", () => {
  it("exits 3 and lists the unmappable / semantic-change items with identifiers", async () => {
    const { code, report } = await run(["--dir", DIFF, "--projects", REGISTRY, "--now", "2026-01-10T00:00:00.000Z", "--json"]);
    assert.equal(code, 3);
    assert.ok(report.differences.length > 0);
    assert.equal(report.roundtripEquivalent, false);
    assert.equal(report.idempotent, true, "the diff fixture still imports idempotently");

    const kinds = new Set(report.unmappable.map((item) => item.kind));
    for (const kind of ["project-unresolved", "non-epic-parent", "missing-report", "status-alias", "field-drift", "unresolved-depends-on"]) {
      assert.ok(kinds.has(kind), `expected an unmappable item of kind ${kind}`);
    }
    const unresolved = report.unmappable.find((item) => item.kind === "project-unresolved");
    assert.equal(unresolved.value, "Missing");
    assert.equal(unresolved.card, "DIFF-0005");
    assert.ok(report.warnings.some((warning) => /two different targets/.test(warning)));

    // the skipped project never became a row
    assert.equal(report.counts.skippedProjects, 1);
    assert.equal(report.projects.length, 1);
  });

  it("--create-project lets the unregistered card import", async () => {
    const { code, report } = await run([
      "--dir",
      DIFF,
      "--projects",
      REGISTRY,
      "--create-project",
      "--now",
      "2026-01-10T00:00:00.000Z",
      "--json",
    ]);
    assert.equal(code, 3, "still lossy, but no longer for a skipped project");
    assert.equal(report.counts.imported, 6);
    assert.equal(report.counts.skippedProjects, 0);
    assert.equal(report.unmappable.some((item) => item.kind === "project-unresolved"), false);
  });
});

describe("migrate/reconcile — privacy: the report never carries card text", () => {
  it("contains identifiers and hashes, but no title or body", async () => {
    const { out } = await run(["--dir", CLEAN, "--projects", REGISTRY, "--now", "2026-01-10T00:00:00.000Z", "--json"]);

    assert.match(out, /DEMO-0001/, "identifiers are allowed");
    for (const secret of [
      "Demo epic",
      "Demo child task",
      "Synthetic epic for the M5 migration drill",
      "ship the synthetic demo",
      "Synthetic project used by the migration drill.",
    ]) {
      assert.equal(out.includes(secret), false, `the report leaked: ${secret}`);
    }
  });
});

describe("migrate/reconcile — usage and failure exit codes", () => {
  it("is 2 for a usage error and 1 for a run that cannot start", async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(["--dir", CLEAN, "--nope"])).code, 2);
    assert.equal((await run(["--dir"])).code, 2);

    const missing = await run(["--dir", join(makeTempDir("reconcile-missing-"), "nope")]);
    assert.equal(missing.code, 1);

    const badRegistry = await run(["--dir", CLEAN, "--projects", join(makeTempDir("reconcile-reg-"), "none.json")]);
    assert.equal(badRegistry.code, 1);
  });

  it("prints a human summary without --json", async () => {
    const { code, out } = await run(["--dir", CLEAN, "--projects", REGISTRY, "--now", "2026-01-10T00:00:00.000Z"]);
    assert.equal(code, 0);
    assert.match(out, /per-field: all \d+ fields survived the round trip/);
    assert.match(out, /idempotent: true · roundtripEquivalent: true/);
  });
});
