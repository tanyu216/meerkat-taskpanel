/**
 * The local role catalog's file — path, bounded read, atomic write.
 *
 * The catalog is host-local state (`/roles.json`, gitignored and dockerignored).
 * A missing file is the bootstrap state; a malformed or oversized one is
 * reported and treated as absent by every caller. The writer replaces the whole
 * document atomically, so a reader never sees half a range.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ROLE_CATALOG_SCHEMA } from "../../src/foundation/role-catalog.mjs";
import {
  defaultRoleCatalogPath,
  readRoleCatalog,
  writeRoleCatalog,
} from "../../src/foundation/role-catalog-file.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-role-catalog-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const catalog = {
  schema: ROLE_CATALOG_SCHEMA,
  source: "skills",
  primary_kind: "claude",
  updated_at: "2026-01-01T00:00:00.000Z",
  roles: [
    {
      id: "jobs",
      agent: "Jobs",
      title: "Product design",
      summary: "",
      lanes: ["worker"],
      shapes: ["product brief"],
      installed_on: ["claude"],
      default_reviewer: false,
    },
  ],
};

describe("role-catalog-file — path", () => {
  it("lives at roles.json under MEERKAT_TASKPANEL_CONFIG_DIR", () => {
    const dir = tempDir();
    assert.equal(
      defaultRoleCatalogPath({ MEERKAT_TASKPANEL_CONFIG_DIR: dir }),
      join(dir, "roles.json"),
    );
  });
});

describe("role-catalog-file — read", () => {
  it("reports an absent file as the bootstrap state, not a failure", () => {
    const file = join(tempDir(), "roles.json");
    for (const read of [
      readRoleCatalog(file),
      // An injected `stat` that models ENOENT must agree with the real one.
      readRoleCatalog(file, { stat: () => { const err = new Error("gone"); err.code = "ENOENT"; throw err; } }),
    ]) {
      assert.deepEqual(read, { ok: true, present: false, catalog: null, file });
    }
  });

  it("round-trips a written catalog", () => {
    const dir = tempDir();
    const file = join(dir, "roles.json");
    const written = writeRoleCatalog(file, catalog);
    assert.equal(written.ok, true);
    assert.equal(written.bytes > 0, true);

    const read = readRoleCatalog(file);
    assert.equal(read.ok, true);
    assert.equal(read.present, true);
    assert.deepEqual(read.catalog, catalog);
  });

  it("reports malformed JSON and a newer schema as unusable, never half-read", () => {
    const dir = tempDir();
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{not json", "utf8");
    const bad = readRoleCatalog(malformed);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "malformed");

    const newer = join(dir, "newer.json");
    writeFileSync(newer, JSON.stringify({ schema: "meerkat-role-catalog/2", roles: [] }), "utf8");
    const drifted = readRoleCatalog(newer);
    assert.equal(drifted.ok, false);
    assert.equal(drifted.code, "schema");
  });

  it("refuses an oversized file before reading it", () => {
    const dir = tempDir();
    const file = join(dir, "huge.json");
    writeFileSync(file, JSON.stringify(catalog), "utf8");
    const read = readRoleCatalog(file, {
      maxBytes: 8,
      readFile: () => {
        throw new Error("must not read an oversized file");
      },
    });
    assert.equal(read.ok, false);
    assert.equal(read.code, "too_large");
  });

  it("reports an unreadable file as an error, distinct from absent", () => {
    const file = join(tempDir(), "roles.json");
    const read = readRoleCatalog(file, {
      stat: () => ({ size: 10 }),
      readFile: () => {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      },
    });
    assert.equal(read.ok, false);
    assert.equal(read.code, "unreadable");
  });
});

describe("role-catalog-file — write", () => {
  it("is atomic: a failed rename leaves the previous document untouched", () => {
    const dir = tempDir();
    const file = join(dir, "roles.json");
    assert.equal(writeRoleCatalog(file, catalog).ok, true);
    const before = readFileSync(file, "utf8");

    const failed = writeRoleCatalog(
      file,
      { ...catalog, roles: [] },
      {
        deps: {
          renameSync: () => {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          },
        },
      },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "CLI_IO");
    assert.equal(readFileSync(file, "utf8"), before, "the previous catalog survives");
  });

  it("creates the config root when it does not exist", () => {
    const dir = tempDir();
    const file = join(dir, "nested", "config", "roles.json");
    mkdirSync(join(dir, "nested"), { recursive: true });
    assert.equal(writeRoleCatalog(file, catalog).ok, true);
    assert.equal(readRoleCatalog(file).ok, true);
  });
});
