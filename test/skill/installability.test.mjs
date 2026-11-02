/**
 * Installed skills must stay self-contained.
 *
 * A skill is copied into an agent home; this repository's design record is not.
 * A reference from a skill to a repository-only design page therefore dangles
 * after installation, and a skill that treats that page as its authority breaks
 * the documentation layers in `docs/README.md`.
 *
 * Target-project documents are allowed: every project a role runs in supplies
 * its own `docs/tech-spec.md`, `docs/architecture.md`, `docs/adr/`,
 * `docs/agents/`, `docs/ops/`, `CLAUDE.md`, `AGENTS.md` and `GLOSSARY.md`.
 *
 * `docs/agents/` and `docs/ops/` are project-discovery surfaces, not denied
 * prefixes. This repository's maintainer-only files inside them are denied by
 * exact filename.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = join(ROOT, "skills");

/**
 * Pages and project docs that exist only in the Meerkat source repository,
 * never in a target project's install. `docs/agents/` and `docs/ops/` are
 * project-discovery surfaces; `docs/maintenance/` is entirely repository-only,
 * so it is denied as a prefix.
 */
const REPOSITORY_ONLY = [
  "docs/scheduling.md",
  "docs/lifecycle.md",
  "docs/acceptance.md",
  "docs/sla.md",
  "docs/projects.md",
  "docs/access.md",
  "docs/events.md",
  "docs/im-integration.md",
  "docs/README.md",
  "docs/maintenance/",
  "docs/ops/install.md",
  "docs/ops/observability.md",
  "docs/ops/publishing.md",
  "ARCHITECTURE.md",
];

const SCANNED = new Set([".md", ".json", ".mjs", ".sh", ".yml", ".yaml"]);

function findRepositoryOnlyRefs(text) {
  return REPOSITORY_ONLY.filter((name) => text.includes(name));
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (SCANNED.has(path.slice(path.lastIndexOf(".")))) out.push(path);
  }
  return out;
}

describe("installed skills: self-contained references", () => {
  it("does not cite a page only the Meerkat source repository has", () => {
    const hits = [];
    for (const file of filesUnder(SKILLS)) {
      const text = readFileSync(file, "utf8");
      for (const name of findRepositoryOnlyRefs(text)) {
        hits.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
    assert.deepEqual(
      hits,
      [],
      "an installed skill points at a page only the Meerkat source repository has; " +
        "state the rule in the skill or point at an installed artifact instead",
    );
  });

  it("separates project documents from repository-only pages", () => {
    for (const allowed of [
      "docs/agents/issue-tracker.md",
      "docs/agents/issue-tracer.md",
      "docs/agents/domain.md",
      "docs/agents/triage-labels.md",
      "docs/tech-spec.md",
      "docs/architecture.md",
      "docs/adr/0001-architecture-style.md",
      "docs/agents/decision-policy.md",
      "Discover docs/agents/ and docs/ops/",
    ]) {
      assert.deepEqual(findRepositoryOnlyRefs(allowed), [], `${allowed} is a project document`);
    }

    assert.deepEqual(findRepositoryOnlyRefs("docs/maintenance/development.md"), [
      "docs/maintenance/",
    ]);
    assert.deepEqual(findRepositoryOnlyRefs("docs/scheduling.md"), ["docs/scheduling.md"]);
    assert.deepEqual(findRepositoryOnlyRefs("docs/ops/install.md"), ["docs/ops/install.md"]);
  });

  it("uses the runtime-neutral call form for the meerkat board skill", () => {
    // Codex, pi and OpenClaw have no `Skill` tool: their skills are reached by
    // `$name`, `/skill:name` or a read, and the Claude worker/reviewer lanes do
    // not carry the tool either. The shared call is therefore "Call the
    // `meerkat` board skill …", never a Claude mechanism name.
    const old = [];
    const claudeOnly = [];
    let canonical = 0;
    for (const file of filesUnder(SKILLS)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      if (/through the `meerkat` board skill/i.test(text)) old.push(rel);
      if (/\bLoad it before the first write\b/i.test(text)) old.push(rel);
      if (/Skill tool/.test(text)) claudeOnly.push(rel);
      canonical += (text.match(/call the `meerkat` board skill/gi) ?? []).length;
    }
    assert.deepEqual(old, [], "the old call-through wording is gone");
    assert.deepEqual(claudeOnly, [], "a shipped skill names a Claude-only tool");
    assert.ok(canonical >= 19, "the canonical call form is used across the shipped skills");
  });

  it("scans YAML assets as well as prose and code", () => {
    assert.ok(SCANNED.has(".yml"));
    assert.ok(SCANNED.has(".yaml"));
    const scanned = filesUnder(SKILLS).map((file) => relative(ROOT, file));
    assert.ok(scanned.includes("skills/linus/assets/security/github/sbom.yml"));
  });
});
