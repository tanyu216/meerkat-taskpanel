/**
 * The project epic graph: one source, a generic recipe, and a decoupled layer.
 *
 * Three decisions are pinned here:
 *
 *   1. the generic layer carries no design/verification classification — the
 *      create manual, the board skill and `loop doctor` no longer demand it;
 *   2. a project's `docs/agents/epic-graphs.md` is the only content source, and it is
 *      absent by default — `setup-meerkat` installs a default only after a user says yes;
 *   3. the `meerkat` skill's epic page owns the mechanics: read the graph, create the
 *      epic, create `backlog` children with `--parent` + `--target`, add explicit edges,
 *      release to `todo`, then read the whole graph back.
 *
 * The recipe says no sentence verbatim; these assert the decisions.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const MEERKAT = read("skills/meerkat/SKILL.md");
const CREATE = read("skills/meerkat/references/scenarios/create.md");
const EPIC = read("skills/meerkat/references/scenarios/epic.md");
const DOC = read("docs/agents/epic-graphs.md");
const ASSET = read("skills/setup-meerkat/assets/epic-graphs.md");
const TRIAGE = read("skills/meerkat-director/references/triage.md");
const ADMIN = read("docs/agents/create-card.md");

describe("generic layer: no classification contract", () => {
  it("removes the stage marker from the create manual and the board skill", () => {
    assert.doesNotMatch(CREATE, /## Set the stage marker/);
    assert.doesNotMatch(CREATE, /design_stage|product_change/);
    assert.doesNotMatch(CREATE, /unclassified/i);
    assert.doesNotMatch(MEERKAT, /design_stage|product_change/);
    assert.match(MEERKAT, /stage_handoff=required/, "the handoff marker stays");
    assert.match(MEERKAT, /meta\.review_gate/, "the review gate stays");
  });

  it("removes the unclassified probe from doctor", () => {
    const doctor = read("src/orchestrator/doctor.mjs");
    assert.doesNotMatch(doctor, /unclassified/i);
    assert.doesNotMatch(doctor, /markerPresent/);
  });

  it("keeps create-card.md to scope and acceptance mode", () => {
    assert.doesNotMatch(ADMIN, /## When this project uses an epic/);
    assert.doesNotMatch(ADMIN, /epic-splitting boundary|epic patterns/i);
    for (const mode of ["off", "auto", "human"]) {
      assert.match(ADMIN, new RegExp("`" + mode + "`"), `the document still names ${mode}`);
    }
  });
});

describe("epic graph: one source, absent by default", () => {
  it("ships this project's graph and the setup default asset", () => {
    assert.ok(existsSync(join(ROOT, "docs/agents/epic-graphs.md")));
    assert.ok(existsSync(join(ROOT, "skills/setup-meerkat/assets/epic-graphs.md")));
    for (const graph of ["dev-verify", "requirement"]) {
      assert.match(DOC, new RegExp(`^## ${graph}$`, "m"));
      assert.match(ASSET, new RegExp(`^## ${graph}$`, "m"));
    }
  });

  it("maps graph B's stages to the right role and mode", () => {
    for (const row of [
      "| design | Jobs | human | — | none |",
      "| dev | Linus | auto | design | yes |",
      "| test-design | Turing | auto | design | yes |",
      "| test-exec | Turing | auto | dev, test-design | yes |",
      "| product-acceptance | Jobs | auto | test-exec | yes |",
    ]) {
      assert.ok(DOC.split("\n").includes(row), `the graph carries ${row}`);
    }
  });

  it("leaves the project column to the graph and the role skills", () => {
    assert.match(DOC, /project column/i);
    assert.match(DOC, /role skills interpret it/i);
    assert.match(EPIC, /Do not validate a project column/);
  });

  it("keeps the graph's content out of the meerkat skill", () => {
    assert.doesNotMatch(EPIC, /^## dev-verify$/m, "no graph is built into the recipe");
    assert.doesNotMatch(EPIC, /^## requirement$/m);
    assert.doesNotMatch(EPIC, /\| design \| Jobs \| human \|/);
  });
});

describe("epic graph recipe", () => {
  it("resolves the project, reads the graph and stops when it is missing", () => {
    assert.match(EPIC, /taskctl project dir <p> --json/);
    assert.match(EPIC, /docs\/agents\/epic-graphs\.md/);
    assert.match(EPIC, /File missing: \*\*stop\*\*/);
    assert.match(EPIC, /setup-meerkat/);
    assert.match(EPIC, /Never fall back to a built-in graph/);
  });

  it("validates the generic structure and reuses an existing instance", () => {
    assert.match(EPIC, /unique stage ids/);
    assert.match(EPIC, /at most 8 stages/);
    assert.match(EPIC, /acyclic/);
    assert.match(EPIC, /taskctl role list --json/);
    assert.match(EPIC, /epic_instance/);
    assert.match(EPIC, /never create a second epic/);
  });

  it("shows the whole graph and gets an explicit OK before writing", () => {
    assert.match(EPIC, /Show the whole graph/);
    assert.match(EPIC, /explicit OK/);
  });

  it("creates the epic first, then the children in backlog", () => {
    assert.ok(
      EPIC.indexOf("Create the epic") < EPIC.indexOf("Create the children"),
      "the epic is the container the children point at",
    );
    assert.match(EPIC, /--status backlog/);
    assert.match(EPIC, /--parent <epic-identifier> --target <stage-id>/);
    assert.match(EPIC, /`--parent` \*\*only fills the idempotency key's source slot/);
    assert.match(EPIC, /derives the key/);
  });

  it("builds the edges explicitly and releases only after they exist", () => {
    assert.match(EPIC, /relation add <epic-identifier> --type parent --target <child-identifier>/);
    assert.match(EPIC, /relation add <dependency-identifier> --type blocks --target <child-identifier>/);
    assert.match(EPIC, /\*\*source\*\* is the predecessor/);
    assert.match(EPIC, /Release to `todo` after every edge exists/);
    assert.match(EPIC, /taskctl(?: --as-human)? issue move <child-identifier> todo/);
  });

  it("reads the whole graph back and refuses to patch a mismatch by adding cards", () => {
    assert.match(EPIC, /Read back the whole graph/);
    assert.match(EPIC, /taskctl issue get <epic-identifier> --include relations --json/);
    assert.match(EPIC, /child count equals the\s+stage count/);
    assert.match(EPIC, /never "create one\s+more" to patch it/);
  });

  it("removes blocks edges before canceling a stage", () => {
    assert.match(
      EPIC,
      /Remove every `blocks` edge[\s\S]*?before[\s\S]*?canceled/,
      "a canceled predecessor withholds its dependents forever",
    );
  });
});

describe("director triage: the same convention", () => {
  it("reads the graph, adopts a delivered producer and only fills the missing stages", () => {
    assert.match(TRIAGE, /docs\/agents\/epic-graphs\.md/);
    assert.match(TRIAGE, /Adopt the delivered producer\s+as its matching stage/i);
    assert.match(TRIAGE, /fill only what is missing/i);
    assert.match(TRIAGE, /--parent <epic> --target <stage-id>/);
    assert.doesNotMatch(TRIAGE, /taskctl issue create/, "the generic create block stays in the prompt/recipe");
    assert.doesNotMatch(TRIAGE, /--idem/, "no second idempotency for a graph stage");
  });

  it("keeps the E1 check for a scope-expanding child", () => {
    assert.match(TRIAGE, /create it only if the map gives E1 to the[\s\S]*director/i);
  });
});
