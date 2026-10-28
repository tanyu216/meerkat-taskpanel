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

/** A flag mention that cannot be satisfied by a longer flag (`--assignee` ≠ `--assignee-id`). */
function mentionsFlag(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`--${escaped}(?![A-Za-z0-9_-])`).test(text);
}

/** The text between `<!-- name:begin -->` and `<!-- name:end -->`, or `null`. */
function markedBlock(doc, name) {
  const begin = `<!-- ${name}:begin -->`;
  const start = doc.indexOf(begin);
  if (start === -1) return null;
  const bodyStart = start + begin.length;
  const stop = doc.indexOf(`<!-- ${name}:end -->`, bodyStart);
  if (stop === -1) return null;
  return doc.slice(bodyStart, stop);
}

/**
 * Where each command's **own** documentation lives.
 *
 * Only the `## Commands` region is read, so a later section that mentions a flag
 * (`## The awaiting state`, `## Editing a card`) cannot satisfy a gap in the
 * command reference. Inside it, a command's scope is its own table row and, when
 * it has one, its own `####` subsection — never a sibling row or the group's
 * prose. The one deliberate exception is the `loop` group, whose shared flags
 * are documented once: that block is marked in the page and added by the caller.
 *
 * @param {string} doc the markdown page
 * @param {Set<string>} commandPaths `project create`, `status`, …
 * @returns {Map<string, string[]>} command path → the lines that document it
 */
function commandScopes(doc, commandPaths) {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => /^## Commands\s*$/.test(line));
  assert.notEqual(start, -1, "cli.md must keep a '## Commands' section");
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const region = lines.slice(start + 1, next === -1 ? lines.length : next);

  // Longest first, so `issue list` is tried before a shorter path prefixes it.
  const paths = [...commandPaths].sort((a, b) => b.length - a.length);
  const scopes = new Map(paths.map((path) => [path, []]));
  let current = null;
  let fence = false;

  for (const line of region) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence) {
      const heading = line.match(/^(#{3,4})\s+(.*)$/);
      if (heading) {
        const named = [...heading[2].matchAll(/`([^`]+)`/g)]
          .flatMap((match) => match[1].split("/").map((part) => part.trim()))
          .filter((name) => commandPaths.has(name));
        // `### `project`` names a group (not a command path) and opens nothing;
        // `#### `issue create`` names exactly one command and opens it.
        current = named.length === 1 ? named[0] : null;
        if (current !== null) scopes.get(current)?.push(line);
        continue;
      }

      const cell = line.match(/^\|\s*`([^`]+)`/);
      if (cell !== null) {
        const path = paths.find((candidate) =>
          cell[1] === candidate
          || cell[1].startsWith(`${candidate} `)
          || cell[1].startsWith(`${candidate}[`));
        if (path !== undefined) scopes.get(path)?.push(line);
      }
    }
    if (current !== null) scopes.get(current)?.push(line);
  }
  return scopes;
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
  /** Every frozen command path, and the flags it declares. */
  function surface() {
    const snapshot = buildSnapshot();
    // An empty snapshot would satisfy every check below and prove nothing.
    assert.ok(snapshot.groups.length >= 10, `expected the command groups, found ${snapshot.groups.length}`);
    assert.ok(snapshot.globals.length >= 5, `expected the global flags, found ${snapshot.globals.length}`);

    const flagsByPath = new Map();
    for (const command of snapshot.top_level) flagsByPath.set(command.name, command.flags);
    for (const group of snapshot.groups) {
      for (const command of group.commands) flagsByPath.set(`${group.name} ${command.name}`, command.flags);
    }
    return { snapshot, flagsByPath };
  }

  it("cli.md names every command", () => {
    const { flagsByPath } = surface();
    const doc = readFileSync(CLI_DOC, "utf8");

    // A bare command is documented by its own name (`taskctl status`).
    const missing = [...flagsByPath.keys()].filter((path) => !doc.includes(path));
    assert.deepEqual(missing, [], "undocumented commands");
  });

  it("cli.md names each command's flags in that command's own section", () => {
    const { snapshot, flagsByPath } = surface();
    const doc = readFileSync(CLI_DOC, "utf8");
    const scopes = commandScopes(doc, new Set(flagsByPath.keys()));

    const shared = markedBlock(doc, "shared-flags:loop");
    assert.notEqual(
      shared,
      null,
      "cli.md must mark the loop verbs' shared flags with <!-- shared-flags:loop:begin/end -->",
    );

    const problems = [];
    for (const [path, flags] of flagsByPath) {
      const own = (scopes.get(path) ?? []).join("\n");
      // The loop documents its 48 common flags once, on purpose; every verb's
      // own row still has to carry the ones only that verb declares.
      const text = path.startsWith("loop ") ? `${own}\n${shared}` : own;
      for (const flag of flags) {
        if (!mentionsFlag(text, flag.flag)) problems.push(`${path} --${flag.flag}`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      `flag documented outside its own command's section:\n${problems.join("\n")}`,
    );

    // Non-vacuity: no scope is the whole page, every command with flags has one,
    // and a sibling's flag does not leak in.
    for (const [path, lines] of scopes) {
      assert.ok(lines.length < doc.split("\n").length, `${path}: scope is the whole page`);
      if (flagsByPath.get(path).length > 0) {
        assert.ok(lines.length > 0, `${path}: no documented section found`);
      }
    }
    assert.equal(
      mentionsFlag((scopes.get("comment add") ?? []).join("\n"), "review-round"),
      false,
      "a flag another command owns must not satisfy this one",
    );

    // The shared block is *exactly* the intersection: a verb-only flag cannot be
    // parked in it, and a common flag cannot be dropped from it.
    const loopFlags = [...flagsByPath]
      .filter(([path]) => path.startsWith("loop "))
      .map(([, flags]) => flags.map((flag) => flag.flag));
    const common = loopFlags[0].filter((flag) => loopFlags.every((list) => list.includes(flag)));
    const marked = [...new Set([...shared.matchAll(/--([a-z0-9][a-z0-9-]*)/g)].map((match) => match[1]))];
    assert.deepEqual(
      [...marked].sort(),
      [...common].sort(),
      "the marked shared block must be exactly the flags every loop verb declares",
    );

    assert.ok(snapshot.groups.length >= 10);
  });

  it("cli.md names every global flag in the global-options section", () => {
    const { snapshot } = surface();
    const doc = readFileSync(CLI_DOC, "utf8");
    const start = doc.indexOf("## Global options");
    assert.notEqual(start, -1, "cli.md must keep a '## Global options' section");
    const end = doc.indexOf("\n## ", start);
    const section = doc.slice(start, end === -1 ? doc.length : end);

    const missing = snapshot.globals
      .filter((flag) => !mentionsFlag(section, flag.flag))
      .map((flag) => `--${flag.flag}`);
    assert.deepEqual(missing, [], "global flags documented outside '## Global options'");
  });

  it("the scoped check notices a flag moved to a sibling command", () => {
    const doc = [
      "## Commands",
      "### `alpha`",
      "| `alpha one --x <v>` | one |",
      "| `alpha two --y <v>` | two |",
      "## Next",
      "",
    ].join("\n");
    const paths = new Set(["alpha one", "alpha two"]);

    const good = commandScopes(doc, paths);
    assert.equal(mentionsFlag(good.get("alpha two").join("\n"), "y"), true);

    const moved = doc
      .replace("| `alpha two --y <v>` | two |", "| `alpha two` | two |")
      .replace("| `alpha one --x <v>` | one |", "| `alpha one --x <v> --y <v>` | one |");
    const broken = commandScopes(moved, paths);
    assert.equal(
      mentionsFlag(broken.get("alpha two").join("\n"), "y"),
      false,
      "alpha two lost its flag",
    );
    assert.equal(
      mentionsFlag(broken.get("alpha one").join("\n"), "y"),
      true,
      "the flag now lives under alpha one, and must not count for alpha two",
    );
  });
});

