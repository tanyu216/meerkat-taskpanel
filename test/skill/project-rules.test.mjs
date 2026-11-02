/**
 * Project-level card rules live at fixed paths under `docs/agents/`.
 *
 * The installed board skill resolves the project directory once and then checks a named
 * file — not a directory scan, not a manifest. This repository ships two of those files:
 * the card's acceptance-mode selection guidance and its epic sizing guidance. The legacy
 * top-level `docs/acceptance-mode.md` is gone; a shipped skill that still names it would
 * point a target project at a path that no longer exists.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = join(ROOT, "skills");
const SCANNED = new Set([".md", ".json", ".mjs", ".sh", ".yml", ".yaml"]);

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (SCANNED.has(path.slice(path.lastIndexOf(".")))) out.push(path);
  }
  return out;
}

describe("project card rules: the docs/agents discovery surface", () => {
  it("ships both card-rule files and removes the legacy top-level path", () => {
    assert.ok(
      existsSync(join(ROOT, "docs/agents/acceptance-mode.md")),
      "docs/agents/acceptance-mode.md must exist",
    );
    assert.ok(
      existsSync(join(ROOT, "docs/agents/epic-cards.md")),
      "docs/agents/epic-cards.md must exist",
    );
    assert.equal(
      existsSync(join(ROOT, "docs/acceptance-mode.md")),
      false,
      "the legacy top-level path is gone",
    );
  });

  it("names the fixed discovery set in the contract", () => {
    const doc = read("docs/agents/README.md");
    for (const name of [
      "acceptance-mode.md",
      "epic-cards.md",
      "decision-policy.md",
      "issue-tracker.md",
      "domain.md",
      "triage-labels.md",
    ]) {
      assert.ok(doc.includes(name), `docs/agents/README.md names ${name}`);
    }
    assert.match(doc, /fixed paths/i, "discovery is by fixed paths");
    assert.match(doc, /taskctl project dir/, "the project directory is resolved first");
    assert.match(doc, /not a\s+directory scan/i, "a scan is explicitly rejected");
  });

  it("leaves no shipped skill pointing at the legacy path", () => {
    const hits = [];
    for (const file of filesUnder(SKILLS)) {
      if (readFileSync(file, "utf8").includes("docs/acceptance-mode.md")) {
        hits.push(relative(ROOT, file));
      }
    }
    assert.deepEqual(hits, [], "a shipped skill names the removed top-level path");
  });

  it("makes the create and epic scenarios discover the project files", () => {
    const create = read("skills/meerkat/references/scenarios/create.md");
    assert.match(create, /docs\/agents\/acceptance-mode\.md/, "create names acceptance-mode");
    assert.match(create, /docs\/agents\/epic-cards\.md/, "create names epic-cards");
    assert.match(create, /taskctl project dir <id> --json/, "the project dir is resolved first");
    assert.match(create, /never invent a project default/i, "absent means the skill default");

    const epic = read("skills/meerkat/references/scenarios/epic.md");
    assert.match(epic, /docs\/agents\/epic-cards\.md/, "epic names epic-cards");
  });

  it("keeps the acceptance guidance self-contained and the epic guidance project-specific", () => {
    const mode = read("docs/agents/acceptance-mode.md");
    assert.match(mode, /docs\/agents\/acceptance-mode\.md/, "the discovery path is named");
    for (const word of ["off", "auto", "human"]) {
      assert.match(mode, new RegExp("`" + word + "`"), `the document names ${word}`);
    }
    assert.doesNotMatch(
      mode,
      /\]\(acceptance\.md\)/,
      "a project-level page must not link the repository-only acceptance design page",
    );

    const epic = read("docs/agents/epic-cards.md");
    assert.match(
      epic,
      /scenarios\/epic\.md/,
      "the general sizing rule is a textual pointer to the installed skill",
    );
    assert.match(epic, /land on `dev` alone/i, "this project's concrete test is stated");
  });
});
