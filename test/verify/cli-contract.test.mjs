/**
 * Tests for `scripts/verify/cli-contract.mjs` — the CLI contract snapshot.
 *
 * Two questions:
 *
 *   1. **Does the committed snapshot still describe this tree?** `buildSnapshot()`
 *      walks the real command registry and the real envelope helpers, so a verb,
 *      flag or envelope key that moves without the snapshot being regenerated
 *      fails here.
 *   2. **Would it catch a change?** A guard that never went red proves nothing:
 *      the drift cases feed a mutated snapshot to `checkContract` and to the CLI
 *      (exit 1), then prove `--update` restores it.
 *
 * One more leg is the point of the card: `references/cli.md` must document every
 * frozen command and flag. A declared-but-undocumented flag is exactly how the
 * `--review-of` / `--review-round` gap survived, and this test is the tripwire.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  ROOT,
  SNAPSHOT_FILE,
  buildSnapshot,
  checkContract,
  diffSnapshots,
  serializeSnapshot,
  updateContract,
} from "../../scripts/verify/cli-contract.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "cli-contract.mjs");
const COMMITTED = join(ROOT, SNAPSHOT_FILE);
const CLI_DOC = join(ROOT, "skills/meerkat/references/cli.md");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeFile(text) {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-cli-contract-"));
  tempDirs.push(dir);
  const file = join(dir, "cli.snapshot.json");
  await writeFile(file, text, "utf8");
  return file;
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A deep copy of the live snapshot, mutated in place. */
function mutated(fn) {
  const copy = JSON.parse(JSON.stringify(buildSnapshot()));
  fn(copy);
  return copy;
}

describe("cli-contract — the committed snapshot describes this tree", () => {
  it("matches the live CLI surface", () => {
    const result = checkContract();
    assert.notEqual(result.kind, "read", JSON.stringify(result));
    assert.deepEqual(result.changes, []);
    assert.equal(result.ok, true);
  });

  it("is byte-stable across builds", () => {
    assert.equal(serializeSnapshot(buildSnapshot()), serializeSnapshot(buildSnapshot()));
    assert.equal(serializeSnapshot(buildSnapshot()), readFileSync(COMMITTED, "utf8"));
  });

  it("freezes keys, never the release number", () => {
    const snapshot = buildSnapshot();
    const release = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    assert.deepEqual(snapshot.envelope.version_data, ["schema_version", "version"]);
    assert.deepEqual(snapshot.envelope.status_data, ["runtime", "schema_version", "version"]);
    assert.deepEqual(snapshot.envelope.status_runtime, ["data_dir", "note", "pid", "pointer", "running", "url"]);
    assert.equal(serializeSnapshot(snapshot).includes(`"${release}"`), false);
  });

  it("freezes the bare commands beside the groups", () => {
    const snapshot = buildSnapshot();
    assert.deepEqual(snapshot.top_level.map((command) => command.name), ["status"]);
    assert.equal(snapshot.schema, 2);
  });
});

describe("cli-contract — it catches a change", () => {
  it("reports a dropped command flag", () => {
    const snapshot = mutated((copy) => {
      const create = copy.groups.find((group) => group.name === "issue").commands.find((c) => c.name === "create");
      create.flags = create.flags.filter((flag) => flag.flag !== "title");
    });
    const changes = diffSnapshots(snapshot, buildSnapshot());
    assert.ok(
      changes.some((change) => change.kind === "changed" && change.detail.includes("length")),
      JSON.stringify(changes),
    );
  });

  it("exits 1 when the file drifts, and --update restores it", async () => {
    const drifted = serializeSnapshot(
      mutated((copy) => {
        const list = copy.groups.find((group) => group.name === "issue").commands.find((c) => c.name === "list");
        list.flags = list.flags.filter((flag) => flag.flag !== "limit");
      }),
    );
    const file = await makeFile(drifted);

    const failed = run(["--file", file]);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /cli-contract: FAILED/);

    const updated = run(["--update", "--file", file]);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(await readFile(file, "utf8"), serializeSnapshot(buildSnapshot()));

    assert.equal(run(["--file", file]).status, 0);
  });

  it("exits 2 for a missing file or a bad argument", async () => {
    assert.equal(run(["--file", join(ROOT, "no-such-snapshot.json")]).status, 2);
    assert.equal(run(["--nope"]).status, 2);
  });
});

describe("cli-contract — the skill documents what it freezes", () => {
  it("cli.md names every command and every flag", () => {
    const snapshot = buildSnapshot();
    // An empty snapshot would satisfy every loop below and prove nothing.
    assert.ok(snapshot.groups.length >= 10, `expected the command groups, found ${snapshot.groups.length}`);
    assert.ok(snapshot.globals.length >= 5, `expected the global flags, found ${snapshot.globals.length}`);
    const doc = readFileSync(CLI_DOC, "utf8");

    const missingCommands = [];
    for (const group of snapshot.groups) {
      for (const command of group.commands) {
        if (!doc.includes(`${group.name} ${command.name}`)) {
          missingCommands.push(`${group.name} ${command.name}`);
        }
      }
    }
    // A bare command is documented by its own name (`taskctl status`).
    for (const command of snapshot.top_level) {
      if (!doc.includes(command.name)) missingCommands.push(command.name);
    }
    assert.deepEqual(missingCommands, [], "undocumented commands");

    const missingFlags = new Set();
    const collect = (flags) => {
      for (const flag of flags) if (!doc.includes(`--${flag.flag}`)) missingFlags.add(`--${flag.flag}`);
    };
    collect(snapshot.globals);
    for (const group of snapshot.groups) for (const command of group.commands) collect(command.flags);
    for (const command of snapshot.top_level) collect(command.flags);
    assert.deepEqual([...missingFlags], [], "undocumented flags");
  });
});

