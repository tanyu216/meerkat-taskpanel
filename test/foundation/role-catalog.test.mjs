/**
 * The local role catalog's pure half — validation, projection and the assignee
 * range. The file's I/O is `role-catalog-file.test.mjs`; the CLI is
 * `test/cli/role.test.mjs`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ROLE_CATALOG_SCHEMA,
  buildRoleCatalog,
  catalogAgentNames,
  catalogHasAssignee,
  normalizeRoleCatalog,
  projectRole,
  sameCatalog,
} from "../../src/foundation/role-catalog.mjs";

const role = (overrides = {}) => ({
  id: "jobs",
  agent: "Jobs",
  nativeAgent: "jobs",
  title: "Product design",
  summary: "Owns the product brief",
  lanes: ["worker"],
  shapes: ["product brief"],
  responsibilities: ["write the brief"],
  boundaries: ["no implementation"],
  installedOn: ["claude"],
  defaultReviewer: false,
  // Host-only fields the projection must drop.
  skillDir: "/home/tester/.claude/skills/jobs",
  workflow: "/home/tester/.claude/skills/jobs/SKILL.md",
  selfCheck: null,
  reviewerPrompt: null,
  variants: { claude: { skillDir: "/home/tester/.claude/skills/jobs" } },
  ...overrides,
});

const doc = (roles = [role()]) => ({
  schema: ROLE_CATALOG_SCHEMA,
  source: "skills",
  primary_kind: "claude",
  updated_at: "2026-01-01T00:00:00.000Z",
  roles: roles.map(projectRole),
});

describe("role-catalog — validation", () => {
  it("accepts a minimal well-formed document and fills the defaults", () => {
    const result = normalizeRoleCatalog({
      schema: ROLE_CATALOG_SCHEMA,
      source: "skills",
      primary_kind: "claude",
      updated_at: "2026-01-01T00:00:00.000Z",
      roles: [{ id: "worker", agent: "Worker" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.catalog.source, "skills");
    assert.equal(result.catalog.primary_kind, "claude");
    assert.deepEqual(result.catalog.roles, [
      {
        id: "worker",
        agent: "Worker",
        title: "",
        summary: "",
        lanes: [],
        shapes: [],
        responsibilities: [],
        boundaries: [],
        installed_on: [],
        default_reviewer: false,
      },
    ]);
  });

  it("an empty role list is a valid catalog", () => {
    const result = normalizeRoleCatalog({
      schema: ROLE_CATALOG_SCHEMA,
      source: null,
      primary_kind: null,
      updated_at: null,
      roles: [],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.catalog.roles, []);
  });

  it("rejects a wrong or newer schema marker", () => {
    for (const schema of [undefined, "meerkat-role-catalog/2", "meerkat-role"]) {
      const result = normalizeRoleCatalog({ schema, roles: [] });
      assert.equal(result.ok, false);
      assert.equal(result.code, "schema");
    }
  });

  it("rejects an invalid id, a duplicate id and a duplicate agent", () => {
    const badId = normalizeRoleCatalog(doc([role({ id: "../escape" })]));
    assert.equal(badId.ok, false);
    assert.match(badId.message, /not a valid role id/);

    const duplicateId = normalizeRoleCatalog(doc([role(), role({ agent: "Other" })]));
    assert.equal(duplicateId.ok, false);
    assert.match(duplicateId.message, /duplicate role id/);

    const duplicateAgent = normalizeRoleCatalog(doc([role(), role({ id: "jobs-2" })]));
    assert.equal(duplicateAgent.ok, false);
    assert.match(duplicateAgent.message, /duplicate role agent/);
  });

  it("rejects a bad lane, a bad installed kind and a bad boolean", () => {
    const raw = (overrides) => ({
      schema: ROLE_CATALOG_SCHEMA,
      source: "skills",
      primary_kind: "claude",
      updated_at: null,
      roles: [{ id: "jobs", agent: "Jobs", ...overrides }],
    });
    assert.equal(normalizeRoleCatalog(raw({ lanes: ["reviewer", "admin"] })).ok, false);
    assert.equal(normalizeRoleCatalog(raw({ installed_on: ["vim"] })).ok, false);
    assert.equal(normalizeRoleCatalog(raw({ default_reviewer: "yes" })).ok, false);
  });

  it("bounds the role count and the text lists", () => {
    const tooMany = normalizeRoleCatalog(
      doc(Array.from({ length: 33 }, (_, index) => role({ id: `r${index}`, agent: `R${index}` }))),
    );
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, "too_many");

    const tooManyShapes = normalizeRoleCatalog(
      doc([role({ shapes: Array.from({ length: 17 }, (_, index) => `shape ${index}`) })]),
    );
    assert.equal(tooManyShapes.ok, false);
    assert.match(tooManyShapes.message, /shapes carries more than 16/);

    const longSummary = normalizeRoleCatalog(doc([role({ summary: "x".repeat(2049) })]));
    assert.equal(longSummary.ok, false);
    assert.match(longSummary.message, /summary is longer than 2048/);
  });
});

describe("role-catalog — projection", () => {
  it("drops host paths and keeps only the declared fields", () => {
    const projected = projectRole(role());
    assert.deepEqual(Object.keys(projected), [
      "id",
      "agent",
      "native_agent",
      "title",
      "summary",
      "lanes",
      "shapes",
      "responsibilities",
      "boundaries",
      "installed_on",
      "default_reviewer",
    ]);
    assert.equal(projected.skill_dir, undefined);
    assert.equal(JSON.stringify(projected).includes("/home/tester"), false);
  });

  it("sorts roles by id when building a payload", () => {
    const built = buildRoleCatalog({
      roleSet: {
        source: "skills",
        primaryKind: "claude",
        roles: [role({ id: "worker", agent: "Worker" }), role({ id: "jobs", agent: "Jobs" })],
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.deepEqual(built.roles.map((entry) => entry.id), ["jobs", "worker"]);
    assert.equal(built.updated_at, "2026-01-01T00:00:00.000Z");
  });
});

describe("role-catalog — the assignee range", () => {
  it("matches an agent or a role id, case-insensitively", () => {
    const catalog = doc([role(), role({ id: "reviewer", agent: "Reviewer", lanes: ["reviewer"] })]);
    assert.equal(catalogHasAssignee(catalog, "Jobs"), true);
    assert.equal(catalogHasAssignee(catalog, "jobs"), true);
    assert.equal(catalogHasAssignee(catalog, "  reviewer  "), true);
    assert.equal(catalogHasAssignee(catalog, "Reviewer"), true);
    assert.equal(catalogHasAssignee(catalog, "Nobody"), false);
    assert.equal(catalogHasAssignee(catalog, ""), false);
    assert.equal(catalogHasAssignee(null, "Jobs"), false);
  });

  it("lists the agent names in catalog order", () => {
    const catalog = doc([role(), role({ id: "reviewer", agent: "Reviewer", lanes: ["reviewer"] })]);
    assert.deepEqual(catalogAgentNames(catalog), ["Jobs", "Reviewer"]);
    assert.deepEqual(catalogAgentNames(null), []);
  });
});

describe("role-catalog — idempotent comparison", () => {
  it("ignores updated_at and detects a changed role", () => {
    const first = doc();
    const later = { ...first, updated_at: "2026-02-02T00:00:00.000Z" };
    assert.equal(sameCatalog(first, later), true);

    const changed = doc([role({ title: "Renamed" })]);
    assert.equal(sameCatalog(first, changed), false);

    const added = doc([role(), role({ id: "worker", agent: "Worker", lanes: ["worker"] })]);
    assert.equal(sameCatalog(first, added), false);
    assert.equal(sameCatalog(null, null), true);
    assert.equal(sameCatalog(null, first), false);
  });
});
