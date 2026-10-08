/**
 * Step 20: the public surface, and the module inventory behind it.
 *
 * A missing module is the sort of thing that only shows up when somebody
 * imports it from `src/cli` in the next milestone, so the planned file list is
 * asserted here rather than assumed.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import * as core from "../../src/core/index.mjs";
import { listModuleFiles } from "../helpers/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every module the M1 plan calls for, relative to `src/core`. */
const PLANNED = [
  "index.mjs",
  "bootstrap.mjs",
  "domain/enums.mjs",
  "domain/status.mjs",
  "domain/priority.mjs",
  "domain/task.mjs",
  "domain/comment.mjs",
  "domain/relation.mjs",
  "domain/report.mjs",
  "domain/delivery-gate.mjs",
  "domain/dictionary.mjs",
  "domain/claim.mjs",
  "domain/invariants.mjs",
  "domain/index.mjs",
  "storage/paths.mjs",
  "storage/driver.mjs",
  "storage/schema.mjs",
  "storage/sqlite-errors.mjs",
  "storage/unit-of-work.mjs",
  "storage/migrations-runner.mjs",
  "storage/repositories/projects.mjs",
  "storage/repositories/tasks.mjs",
  "storage/repositories/relations.mjs",
  "storage/repositories/comments.mjs",
  "storage/repositories/reports.mjs",
  "storage/repositories/dictionary.mjs",
  "storage/repositories/agent-sessions.mjs",
  "storage/repositories/attachments.mjs",
  "storage/repositories/activities.mjs",
  "storage/repositories/index.mjs",
  "storage/md/frontmatter.mjs",
  "storage/md/sections.mjs",
  "storage/md/legacy-status.mjs",
  "storage/md/import.mjs",
  "storage/md/export.mjs",
  "storage/md/migrate-cli.mjs",
  "storage/secrets/token-store.mjs",
  "storage/secrets/runtime-pointer.mjs",
  "commands/context.mjs",
  "commands/projects.mjs",
  "commands/tasks.mjs",
  "commands/reports.mjs",
  "commands/comments.mjs",
  "commands/relations.mjs",
  "commands/dictionary.mjs",
  "commands/agent-sessions.mjs",
  "commands/index.mjs",
];

describe("core/index — the surface", () => {
  it("ships every planned module", () => {
    const missing = PLANNED.filter((rel) => !existsSync(join(ROOT, "src/core", rel)));
    assert.deepEqual(missing, []);
  });

  it("exports the public surface a surface layer needs", () => {
    const expected = [
      "STAGE",
      "openBoard",
      "createCommands",
      "createContext",
      "createRepositories",
      "openDatabase",
      "applyMigrations",
      "assertSchemaCurrent",
      "ensureToken",
      "importMd",
      "exportMd",
      // domain, re-exported wholesale
      "ALLOWED_TRANSITIONS",
      "assertTransition",
      "checkDeliveryGate",
      "assertDeliveryGate",
      "normalizeTaskCreate",
      "validateReport",
      "normalizeReportCreate",
      "resolveDictionaryEntry",
      "decideClaim",
      "INVARIANTS",
      "STATUSES",
      "TABLES",
    ];
    const missing = expected.filter((name) => !(name in core));
    assert.deepEqual(missing, [], `missing exports: ${missing.join(", ")}`);
    assert.ok(Object.keys(core).length > 100, `suspiciously few exports: ${Object.keys(core).length}`);
  });

  it("does not leak the dictionary management surface", () => {
    for (const name of Object.keys(core)) {
      assert.equal(
        /^(add|remove|rename|create)(Assignee|Reporter)/.test(name),
        false,
        `${name} must not exist`,
      );
    }
  });

  it("keeps `STAGE` so the M0 scaffold tests stay meaningful", () => {
    assert.equal(core.STAGE, "core");
  });

  it("has no stray modules beyond the planned set", () => {
    const found = listModuleFiles(join(ROOT, "src/core"))
      .map((file) => file.slice(join(ROOT, "src/core").length + 1))
      .sort();
    const unplanned = found.filter((rel) => !PLANNED.includes(rel));
    assert.deepEqual(unplanned, [], "a module exists that nobody planned or documented");
  });
});
