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
 * `docs/agents/`, `CLAUDE.md`, `AGENTS.md` and `GLOSSARY.md`.
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

/** Design-record pages that exist only in this repository, never in an install. */
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
  "ARCHITECTURE.md",
];

const SCANNED = new Set([".md", ".json", ".mjs", ".sh"]);

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
  it("does not cite a repository-only design page", () => {
    const hits = [];
    for (const file of filesUnder(SKILLS)) {
      const text = readFileSync(file, "utf8");
      for (const name of REPOSITORY_ONLY) {
        if (text.includes(name)) hits.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
    assert.deepEqual(
      hits,
      [],
      "an installed skill points at this repository's design record; " +
        "state the rule in the skill or point at an installed artifact instead",
    );
  });
});
