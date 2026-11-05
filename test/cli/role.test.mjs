/**
 * `taskctl role list|sync` — the local role catalog's command surface.
 *
 * Both verbs are local by construction: no board, no token, no identity. `sync`
 * is the supervisor's writer (stdin, full replacement, idempotent by content);
 * `list` is the reader the `meerkat` skill uses as the assignee range.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ROLE_CATALOG_SCHEMA } from "../../src/foundation/role-catalog.mjs";
import { cleanupTempDirs, dataOf, runCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

const dirs = [];
function configDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-role-cli-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const role = (id, agent, extra = {}) => ({
  id,
  agent,
  title: `${agent} role`,
  summary: "",
  lanes: ["worker"],
  shapes: [],
  installed_on: ["claude"],
  default_reviewer: false,
  ...extra,
});

const payload = (roles) => ({
  schema: ROLE_CATALOG_SCHEMA,
  source: "skills",
  primary_kind: "claude",
  updated_at: "2026-01-01T00:00:00.000Z",
  roles,
});

const run = (dir, args, options = {}) =>
  runCli(args, {
    noIdentity: true,
    noUrl: true,
    env: { MEERKAT_TASKPANEL_CONFIG_DIR: dir, ...(options.env ?? {}) },
    ...options,
  });

describe("cli/role — list", () => {
  it("answers 'no roles' before the first sync, exit 0", () => {
    const dir = configDir();
    const asJson = run(dir, ["role", "list", "--json"]);
    assert.equal(asJson.status, 0, asJson.stderr);
    const data = dataOf(asJson);
    assert.equal(data.present, false);
    assert.equal(data.source, null);
    assert.deepEqual(data.roles, []);
    assert.equal(data.file, join(dir, "roles.json"));

    const human = run(dir, ["role", "list"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^no roles in .*roles\.json$/m);
  });

  it("prints a table with the agent, id, title, lanes and installed kinds", () => {
    const dir = configDir();
    writeFileSync(
      join(dir, "roles.json"),
      JSON.stringify(payload([role("jobs", "Jobs", { title: "Product design" })])),
      "utf8",
    );
    const human = run(dir, ["role", "list"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /role catalog: .*roles\.json \(source: skills/);
    assert.match(human.stdout, /^agent +id +title +lanes +installed_on$/m);
    assert.match(human.stdout, /^Jobs +jobs +Product design +worker +claude$/m);
  });

  it("projects a legacy catalog on read and never rewrites the file", () => {
    const dir = configDir();
    const file = join(dir, "roles.json");
    // A file written before the projection shrank: it still carries the prose.
    const body = JSON.stringify(payload([{
      ...role("jobs", "Jobs", { title: "Product design" }),
      responsibilities: ["write the product brief"],
      boundaries: ["no implementation"],
    }]));
    writeFileSync(file, body, "utf8");

    const listed = run(dir, ["role", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const data = dataOf(listed);
    assert.deepEqual(data.roles.map((entry) => entry.id), ["jobs"]);
    assert.equal(Object.hasOwn(data.roles[0], "responsibilities"), false);
    assert.equal(Object.hasOwn(data.roles[0], "boundaries"), false);
    assert.equal(JSON.stringify(data).includes("write the product brief"), false);

    // Confirmed decision: a legacy file is projected on read, never healed in place.
    assert.equal(readFileSync(file, "utf8"), body, "an unchanged catalog is not rewritten");
  });

  it("shows its help", () => {
    const result = run(configDir(), ["role", "list", "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: taskctl role list /m);
  });
});

describe("cli/role — sync", () => {
  it("reads stdin and writes the full replacement", () => {
    const dir = configDir();
    const result = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify(payload([role("jobs", "Jobs"), role("turing", "Turing")])),
    });
    assert.equal(result.status, 0, result.stderr);
    const data = dataOf(result);
    assert.equal(data.changed, true);
    assert.equal(data.roles, 2);

    const listed = dataOf(run(dir, ["role", "list", "--json"]));
    assert.equal(listed.present, true);
    assert.deepEqual(listed.roles.map((entry) => entry.id), ["jobs", "turing"]);
  });

  it("is idempotent by content: an identical sync leaves updated_at alone", () => {
    const dir = configDir();
    const body = JSON.stringify(payload([role("jobs", "Jobs")]));
    assert.equal(run(dir, ["role", "sync", "--file", "-"], { input: body }).status, 0);
    const first = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));

    const again = run(dir, ["role", "sync", "--file", "-", "--json"], { input: body });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(dataOf(again).changed, false);
    const second = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
    assert.equal(second.updated_at, first.updated_at);

    const changed = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify(payload([role("jobs", "Jobs", { title: "Renamed" })])),
    });
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(dataOf(changed).changed, true);
    assert.notEqual(
      JSON.parse(readFileSync(join(dir, "roles.json"), "utf8")).updated_at,
      first.updated_at,
    );
  });

  it("replaces the previous catalog: a removed role disappears", () => {
    const dir = configDir();
    run(dir, ["role", "sync", "--file", "-"], {
      input: JSON.stringify(payload([role("jobs", "Jobs"), role("turing", "Turing")])),
    });
    const shrunk = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify(payload([role("worker", "Worker")])),
    });
    assert.equal(shrunk.status, 0, shrunk.stderr);
    assert.deepEqual(dataOf(run(dir, ["role", "list", "--json"])).roles.map((r) => r.id), ["worker"]);
  });

  it("stores only the projection when the payload carries the long-form text", () => {
    const dir = configDir();
    const result = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify(payload([{
        ...role("jobs", "Jobs"),
        responsibilities: ["write the product brief", "define acceptance"],
        boundaries: ["no implementation"],
      }])),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).changed, true);

    const stored = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
    assert.equal(stored.roles.length, 1);
    assert.equal(Object.hasOwn(stored.roles[0], "responsibilities"), false);
    assert.equal(Object.hasOwn(stored.roles[0], "boundaries"), false);
    assert.equal(readFileSync(join(dir, "roles.json"), "utf8").includes("write the product brief"), false);
  });

  it("leaves a legacy file byte-identical when its content has not changed", () => {
    const dir = configDir();
    const file = join(dir, "roles.json");
    const body = JSON.stringify(payload([{
      ...role("jobs", "Jobs"),
      responsibilities: ["write the product brief"],
      boundaries: ["no implementation"],
    }]));
    writeFileSync(file, body, "utf8");

    const same = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify(payload([role("jobs", "Jobs")])),
    });
    assert.equal(same.status, 0, same.stderr);
    assert.equal(dataOf(same).changed, false, "the dropped prose is not a content change");
    assert.equal(readFileSync(file, "utf8"), body, "the legacy file is not healed in place");
  });

  it("reads a file path as well as stdin", () => {
    const dir = configDir();
    const source = join(dir, "payload.json");
    writeFileSync(source, JSON.stringify(payload([role("jobs", "Jobs")])), "utf8");
    const result = run(dir, ["role", "sync", "--file", source, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dataOf(result).roles, 1);
  });

  it("heals a malformed catalog on the next sync", () => {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "roles.json"), "{broken", "utf8");
    const listed = run(dir, ["role", "list", "--json"]);
    assert.equal(listed.status, 0);
    assert.equal(dataOf(listed).present, true);
    assert.deepEqual(dataOf(listed).roles, [], "a malformed file is not half-read");

    const synced = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify(payload([role("jobs", "Jobs")])),
    });
    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(dataOf(synced).changed, true);
    assert.deepEqual(dataOf(run(dir, ["role", "list", "--json"])).roles.map((r) => r.id), ["jobs"]);
  });

  it("refuses missing --file and invalid payloads with coded errors", () => {
    const dir = configDir();
    const codeOf = (result) => JSON.parse(result.stdout).error?.code ?? null;

    const missing = run(dir, ["role", "sync", "--json"]);
    assert.equal(missing.status, 2, missing.stderr);
    assert.equal(codeOf(missing), "CLI_USAGE");
    assert.match(missing.stdout, /--file/);

    const notJson = run(dir, ["role", "sync", "--file", "-", "--json"], { input: "{nope" });
    assert.equal(notJson.status, 1, notJson.stderr);
    assert.equal(codeOf(notJson), "CLI_IO");

    const unreadable = run(dir, ["role", "sync", "--file", join(dir, "missing.json"), "--json"]);
    assert.equal(unreadable.status, 1, unreadable.stderr);
    assert.equal(codeOf(unreadable), "CLI_IO");

    const wrongSchema = run(dir, ["role", "sync", "--file", "-", "--json"], {
      input: JSON.stringify({ schema: "meerkat-role-catalog/2", roles: [] }),
    });
    assert.equal(wrongSchema.status, 2, wrongSchema.stderr);
    assert.equal(codeOf(wrongSchema), "CLI_USAGE");
  });
});
