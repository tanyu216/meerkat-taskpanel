/**
 * Tests for `scripts/release/bump.mjs` — the one-shot, four-carrier version bump.
 *
 * Every case builds a real tree on disk (a temp dir) with the *hand-written
 * bytes* of the four carriers, then calls the real planning/apply functions; the
 * CLI cases spawn the real script. Nothing is mocked, because the property under
 * test is precisely "what bytes land on disk": a stub would prove nothing.
 *
 * The red→green pair is `describe("red→green …")`: it first demonstrates that the
 * obvious implementation — `JSON.parse` then `JSON.stringify` — *does* reformat a
 * hand-formatted manifest (the hazard), then shows the in-place splice does not.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  BUMP_GROUPS,
  CHANGELOG_FILE,
  ROOT,
  SOURCES,
  applyWrites,
  compareSemver,
  findValueSpan,
  parseSemver,
  planBump,
  planChangelog,
  runBump,
} from "../../scripts/release/bump.mjs";

const BUMP = join(ROOT, "scripts", "release", "bump.mjs");
const VERSION_CHECK = join(ROOT, "scripts", "verify", "version.mjs");
const CHANGELOG_CHECK = join(ROOT, "scripts", "verify", "changelog.mjs");

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir, removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-bump-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * The four carriers as literal text, in the *mixed* formatting the real files
 * use: 2-space indent, inline objects (`{ "name": "tanyu216" }`), and arrays on
 * one line. That formatting is the thing a JSON round trip destroys, so it is
 * spelled out byte for byte rather than produced by `stringify`. The module
 * carrier is last, matching its position in `VERSION_SOURCES`.
 *
 * @param {string} version
 * @returns {Record<string, string>}
 */
function manifests(version) {
  return {
    "package.json": `{
  "name": "meerkat-taskpanel",
  "version": "${version}",
  "type": "module",
  "files": ["src", "skills"],
  "engines": { "node": ">=22" }
}
`,
    ".claude-plugin/plugin.json": `{
  "name": "meerkat-taskpanel",
  "version": "${version}",
  "author": { "name": "tanyu216" },
  "keywords": ["task-management", "ai-agent", "kanban"]
}
`,
    ".claude-plugin/marketplace.json": `{
  "name": "meerkat-taskpanel-marketplace",
  "metadata": {
    "description": "Task management board for AI Agent teams.",
    "version": "${version}"
  },
  "plugins": [{ "name": "meerkat-taskpanel", "source": "./" }]
}
`,
    "src/foundation/constants.mjs": `/**
 * Shared constants.
 */

export const CLI_NAME = "taskctl";
export const VERSION = "${version}";
`,
  };
}

/** Every board manifest path, in reporting order. */
const PATHS = Object.keys(manifests("0.0.0"));

/**
 * A tree carrying every version carrier, which is what `node scripts/verify/version.mjs`
 * requires to go green: the group is checked against its canonical entry, so a tree
 * missing one of its carriers is a broken tree (exit 2), not a passing one.
 *
 * @param {string} version the board version
 * @returns {Record<string, string>}
 */
function fullTree(version) {
  return manifests(version);
}

/** A changelog with a real, filled section for `version` — the `--tag` gate requires it. */
function documentedChangelog(version = "1.1.0", date = "2026-10-10") {
  return `# Changelog\n\n## [Unreleased]\n\n## [${version}] - ${date}\n\n### Fixed\n\n- A real change.\n`;
}

/** Write a `path → bytes` map into `dir`. */
async function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  }
}

/** Read every manifest in `dir` back as `path → bytes`. */
async function snapshot(dir, paths = PATHS) {
  const out = {};
  for (const rel of paths) out[rel] = await readFile(join(dir, rel), "utf8");
  return out;
}

/** Every `*.tmp` left anywhere under `dir`, to prove staging cleans up after itself. */
async function leftoverTemps(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".tmp")) found.push(full);
    }
  }
  await walk(dir);
  return found;
}

/** Run a script and return `{status, stdout, stderr}`. */
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------

describe("bump.mjs — declarations", () => {
  it("carries the same four carriers as version.mjs, package.json canonical", () => {
    assert.equal(SOURCES.length, 4);
    assert.equal(SOURCES[0].path, "package.json");
    assert.equal(SOURCES[0].canonical, true);
    assert.equal(SOURCES.filter((source) => source.canonical).length, 1);
    assert.deepEqual(
      SOURCES.map((source) => source.path),
      PATHS,
      "the declared paths are the four files the fixture writes",
    );
  });

  it("carries the module carrier without a JSON key path", () => {
    const constants = SOURCES.find((source) => source.path === "src/foundation/constants.mjs");
    assert.equal(constants.kind, "module");
    assert.deepEqual([...constants.keys], []);
  });

  it("names the JSON path for the nested marketplace version", () => {
    const marketplace = SOURCES.find((source) => source.path === ".claude-plugin/marketplace.json");
    assert.deepEqual([...marketplace.keys], ["metadata", "version"]);
  });

  it("declares one group, the board's", () => {
    // Both halves of the group come from one declaration, so a group can never be bumped
    // against a different set of files than it is validated against. The loop used to be a
    // second group; it stopped being a version carrier when the `plugins/loop` manifests
    // were removed, and `--group loop` is now an unknown group rather than a silent no-op.
    assert.deepEqual(Object.keys(BUMP_GROUPS), ["board"]);
    assert.equal(BUMP_GROUPS.board.sources, SOURCES);
    assert.equal(BUMP_GROUPS.board.checkers.length, 4);
    assert.ok(
      BUMP_GROUPS.board.checkers
        .filter((source) => source.kind === "json")
        .every((source) => typeof source.pick === "function"),
      "every JSON carrier has a picker",
    );
    const constants = BUMP_GROUPS.board.checkers.find((source) => source.kind === "module");
    assert.equal(constants.pick, undefined, "the module carrier is located, not picked");
  });
});

// ---------------------------------------------------------------------------
// The retired loop group
// ---------------------------------------------------------------------------

describe("bump.mjs — the retired loop group", () => {
  it("refuses --group loop instead of bumping nothing", async () => {
    // The loop's two carriers were the `plugins/loop` manifests. With them gone, a bump
    // aimed at the loop must be an unknown group: an empty source list would report a
    // successful bump that wrote no file.
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));

    const refused = await runBump({ version: "1.1.0", base: dir, group: "loop" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "unknown-group");
  });

  it("refuses an unknown group outright", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));

    const unknown = await runBump({ version: "1.1.0", base: dir, group: "nope" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "unknown-group");
  });

  it("exits 2 from the CLI on --group loop and on an unknown group", async () => {
    const loop = run(BUMP, ["1.1.0", "--group", "loop"]);
    assert.equal(loop.status, 2, loop.stderr);
    assert.match(loop.stderr, /unknown --group 'loop'/);

    const unknown = run(BUMP, ["1.1.0", "--group", "nope"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown --group 'nope'/);
  });
});

describe("bump.mjs — semver", () => {
  it("accepts strict semver, with an optional prerelease/build", () => {
    for (const good of ["1.0.0", "0.0.0", "10.20.30", "1.2.3-rc.1", "1.2.3+build.5", "1.2.3-rc.1+build.5"]) {
      assert.notEqual(parseSemver(good), null, `${good} should parse`);
    }
  });

  it("rejects anything that is not strict semver", () => {
    for (const bad of ["v1.2.3", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "latest", "", "1.2.x", "  "]) {
      assert.equal(parseSemver(bad), null, `${JSON.stringify(bad)} should be refused`);
    }
  });

  it("orders by major/minor/patch, then by prerelease", () => {
    const order = ["0.9.9", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    for (let index = 1; index < order.length; index += 1) {
      const lower = parseSemver(order[index - 1]);
      const higher = parseSemver(order[index]);
      assert.equal(compareSemver(lower, higher), -1, `${order[index - 1]} < ${order[index]}`);
      assert.equal(compareSemver(higher, lower), 1, `${order[index]} > ${order[index - 1]}`);
    }
    assert.equal(compareSemver(parseSemver("1.2.3"), parseSemver("1.2.3")), 0);
  });
});

describe("bump.mjs — findValueSpan", () => {
  it("returns the quoted token span for a top-level and a nested path", () => {
    const raw = `{\n  "name": "x",\n  "version": "1.0.0"\n}\n`;
    const span = findValueSpan(raw, ["version"]);
    assert.deepEqual(span, { start: 30, end: 37, value: "1.0.0" });
    assert.equal(raw.slice(span.start, span.end), '"1.0.0"');

    const nested = `{\n  "metadata": {\n    "version": "2.3.4"\n  }\n}\n`;
    const inner = findValueSpan(nested, ["metadata", "version"]);
    assert.equal(inner.value, "2.3.4");
    assert.equal(nested.slice(inner.start, inner.end), '"2.3.4"');
  });

  it("returns null when the path is absent", () => {
    assert.equal(findValueSpan(`{ "name": "x" }`, ["version"]), null);
    assert.equal(findValueSpan(`{ "metadata": { "version": "1.0.0" } }`, ["version"]), null, "top-level only");
  });

  it("ignores a same-named key inside an array element", () => {
    const raw = `{ "plugins": [{ "version": "0.0.1" }], "version": "1.0.0" }`;
    assert.equal(findValueSpan(raw, ["version"]).value, "1.0.0");
  });

  it("throws on malformed JSON rather than silently matching", () => {
    assert.throws(() => findValueSpan(`{ "version": "1.0.0" `, ["version"]), SyntaxError);
    assert.throws(() => findValueSpan(`{ "version": 1.0.0 }`, ["version"]).value, TypeError);
  });
});

describe("red→green — the naive round trip reformats, the splice does not", () => {
  it("red: JSON.parse → JSON.stringify does not round-trip these bytes", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    await writeTree(dir, files);

    // The obvious implementation, and the reason this script exists: it loses the
    // inline objects, the single-line arrays, the key order it was never asked to
    // change — and, with a different indent argument, the indentation too.
    const naive = `${JSON.stringify(JSON.parse(files[".claude-plugin/plugin.json"]), null, 2)}\n`;
    assert.notEqual(
      naive,
      files[".claude-plugin/plugin.json"],
      "a round trip must actually reformat here, or this test proves nothing",
    );
    assert.ok(naive.includes('"author": {\n    "name": "tanyu216"\n  }'), "the inline author was exploded");
    assert.ok(naive.includes('"keywords": [\n    "task-management",'), "the keyword array was expanded");

    // green: the bytes that land are the old bytes with *only* the version
    // literal swapped — which is the same statement as "key order, indentation,
    // inline objects and one-line arrays all survived".
    const planned = await planBump({ version: "2.0.0", base: dir });
    assert.equal(planned.ok, true, planned.error);
    for (const entry of planned.entries) {
      assert.equal(
        entry.after,
        entry.before.replace('"1.0.0"', '"2.0.0"'),
        `${entry.path}: every other byte is unchanged`,
      );
      assert.equal(entry.after.includes('"1.0.0"'), false, `${entry.path}: no stale version survives`);
      if (entry.path.endsWith(".json")) {
        assert.deepEqual(
          Object.keys(JSON.parse(entry.after)),
          Object.keys(JSON.parse(entry.before)),
          `${entry.path}: key order is preserved`,
        );
      }
    }
  });
});

describe("bump.mjs — planBump", () => {
  it("plans all four edits against a consistent tree", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));

    const planned = await planBump({ version: "1.1.0", base: dir });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.previous, "1.0.0");
    assert.equal(planned.version, "1.1.0");
    assert.equal(planned.entries.length, 4);
  });

  it("refuses a non-semver target", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    for (const bad of ["v1.1.0", "1.1", "01.1.0", "next"]) {
      const planned = await planBump({ version: bad, base: dir });
      assert.equal(planned.ok, false);
      assert.equal(planned.code, "invalid-version");
      assert.match(planned.error, /not valid semver/);
    }
  });

  it("refuses a target that is not greater than the current version", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    for (const [bad, why] of [
      ["1.0.0", /not greater/],
      ["0.9.9", /not greater/],
      ["1.0.0-rc.1", /not greater/],
    ]) {
      const planned = await planBump({ version: bad, base: dir });
      assert.equal(planned.ok, false, `${bad} must be refused`);
      assert.equal(planned.code, "not-greater");
      assert.match(planned.error, why);
    }
  });

  it("refuses to bump a tree that has already drifted", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/plugin.json"] = files[".claude-plugin/plugin.json"].replace('"1.0.0"', '"0.9.9"');
    await writeTree(dir, files);

    const planned = await planBump({ version: "2.0.0", base: dir });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, "drift");
    assert.match(planned.error, /\.claude-plugin\/plugin\.json/);
  });

  it("refuses a tree with a missing manifest", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    delete files[".claude-plugin/marketplace.json"];
    await writeTree(dir, files);

    const planned = await planBump({ version: "2.0.0", base: dir });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, "unreadable-tree");
    assert.match(planned.error, /marketplace\.json/);
  });

  it("refuses when the version field itself is gone", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/plugin.json"] = `{\n  "name": "meerkat-taskpanel"\n}\n`;
    await writeTree(dir, files);

    const planned = await planBump({ version: "2.0.0", base: dir });
    assert.equal(planned.ok, false, "a missing field must not be 'fixed' silently");
    assert.equal(planned.code, "unreadable-tree");
  });

  it("refuses to bump a tree whose module carrier has drifted", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files["src/foundation/constants.mjs"] = files["src/foundation/constants.mjs"].replace('"1.0.0"', '"0.9.9"');
    await writeTree(dir, files);

    const planned = await planBump({ version: "2.0.0", base: dir });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, "drift");
    assert.match(planned.error, /src\/foundation\/constants\.mjs/);
  });

  it("refuses a module carrier with no declaration, or more than one", async () => {
    for (const body of ['export const VERSION = 1;\n', 'export const VERSION = "1.0.0";\nexport const VERSION = "1.0.0";\n']) {
      const dir = await makeTree();
      const files = manifests("1.0.0");
      files["src/foundation/constants.mjs"] = body;
      await writeTree(dir, files);

      const planned = await planBump({ version: "2.0.0", base: dir });
      assert.equal(planned.ok, false);
      assert.equal(planned.code, "unreadable-tree");
      assert.match(planned.error, /src\/foundation\/constants\.mjs/);
    }
  });

  it("splices only the module's version literal", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));

    const planned = await planBump({ version: "2.0.0", base: dir });
    const constants = planned.entries.find((entry) => entry.path === "src/foundation/constants.mjs");
    assert.equal(constants.after, constants.before.replace('"1.0.0"', '"2.0.0"'));
    assert.ok(constants.after.includes('export const VERSION = "2.0.0";'));
    assert.ok(constants.after.includes("export const CLI_NAME = \"taskctl\";"), "the rest of the module survives");
  });
});

describe("bump.mjs — planChangelog", () => {
  /** A changelog with the shape the real one has: Unreleased, a release, link refs. */
  const CHANGELOG = `# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

## [Unreleased]

### Added

- Something unreleased.

## [1.0.0] - 2026-10-09

### Added

- The first release.

[Unreleased]: https://github.com/tanyu216/meerkat-taskpanel/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v1.0.0
`;

  it("inserts an empty scaffold below Unreleased and above the newest release", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, CHANGELOG_FILE), CHANGELOG, "utf8");

    const planned = await planChangelog({ version: "1.1.0", base: dir, date: "2026-10-10" });
    assert.equal(planned.ok, true, planned.error);
    const after = planned.entry.after;

    const unreleased = after.indexOf("## [Unreleased]");
    const fresh = after.indexOf("## [1.1.0] - 2026-10-10");
    const previous = after.indexOf("## [1.0.0] - 2026-10-09");
    assert.ok(unreleased < fresh, "Unreleased still leads");
    assert.ok(fresh < previous, "the new release sits above the previous one");

    // Nothing invented: three headings, three placeholders, and the Unreleased
    // body carried through untouched.
    const section = after.slice(fresh, previous);
    assert.equal(section.match(/^### (Added|Changed|Fixed)$/gm).length, 3);
    assert.equal(section.match(/^- _Nothing yet\._$/gm).length, 3);
    assert.equal(section.match(/^- /gm).length, 3, "no other bullet is fabricated");
    assert.ok(after.includes("- Something unreleased."), "the Unreleased body is not moved or edited");
  });

  it("keeps the foot-of-file link references consistent", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, CHANGELOG_FILE), CHANGELOG, "utf8");

    const planned = await planChangelog({ version: "1.1.0", base: dir, date: "2026-10-10" });
    const after = planned.entry.after;
    assert.ok(after.includes("[1.1.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v1.1.0"));
    assert.ok(after.includes("[Unreleased]: https://github.com/tanyu216/meerkat-taskpanel/compare/v1.1.0...HEAD"));
    assert.ok(after.includes("[1.0.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v1.0.0"), "history intact");
  });

  it("leaves a changelog with no link-reference block alone", async () => {
    const dir = await makeTree();
    const bare = `# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-09\n\n- first.\n`;
    await writeFile(join(dir, CHANGELOG_FILE), bare, "utf8");

    const planned = await planChangelog({ version: "1.1.0", base: dir, date: "2026-10-10" });
    assert.equal(planned.ok, true, planned.error);
    assert.ok(planned.entry.after.includes("## [1.1.0] - 2026-10-10"));
    assert.equal(planned.entry.after.includes("releases/tag"), false, "no reference block is invented");
  });

  it("refuses to duplicate a version that already has a section", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, CHANGELOG_FILE), CHANGELOG, "utf8");

    const planned = await planChangelog({ version: "1.0.0", base: dir, date: "2026-10-10" });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, "changelog-exists");
  });

  it("refuses a missing changelog", async () => {
    const dir = await makeTree();
    const planned = await planChangelog({ version: "1.1.0", base: dir, date: "2026-10-10" });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, "changelog-unreadable");
  });

  it("writes the heading the tag gate looks for", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, CHANGELOG_FILE), CHANGELOG, "utf8");
    const planned = await planChangelog({ version: "1.1.0", base: dir, date: "2026-10-10" });
    await writeFile(join(dir, CHANGELOG_FILE), planned.entry.after, "utf8");

    const checked = run(CHANGELOG_CHECK, ["v1.1.0", "--base", dir]);
    assert.equal(checked.status, 0, checked.stderr);
  });
});

describe("bump.mjs — atomicity", () => {
  it("injects a staging failure and writes nothing at all", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    const before = await snapshot(dir);

    const planned = await planBump({ version: "2.0.0", base: dir });
    assert.equal(planned.ok, true, planned.error);

    // Fail the last (fourth) stage. The first three temp files were already created,
    // so a leak or a partial write would show up below.
    let calls = 0;
    const io = {
      writeFile: async (...args) => {
        calls += 1;
        if (calls === 4) throw new Error("injected staging failure");
        return writeFile(...args);
      },
      rename,
      rm,
    };

    const applied = await applyWrites(planned.entries, { io });
    assert.equal(applied.ok, false);
    assert.equal(applied.code, "stage-failed");
    assert.equal(applied.rolledBack, true);

    assert.deepEqual(await snapshot(dir), before, "zero writes: every manifest still has its original bytes");
    assert.deepEqual(await leftoverTemps(dir), [], "no temp file is left behind");
  });

  it("injects a rename failure and restores the files already renamed", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    const before = await snapshot(dir);

    const planned = await planBump({ version: "2.0.0", base: dir });
    let renames = 0;
    const io = {
      writeFile,
      rename: async (...args) => {
        renames += 1;
        if (renames === 3) throw new Error("injected rename failure");
        return rename(...args);
      },
      rm,
    };

    const applied = await applyWrites(planned.entries, { io });
    assert.equal(applied.ok, false);
    assert.equal(applied.code, "commit-failed");
    assert.equal(applied.rolledBack, true, "the file replaced by the first rename is put back");

    assert.deepEqual(await snapshot(dir), before, "the tree is byte-identical to before the attempt");
    assert.deepEqual(await leftoverTemps(dir), []);
  });

  it("leaves nothing behind on the happy path", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    const planned = await planBump({ version: "2.0.0", base: dir });

    const applied = await applyWrites(planned.entries);
    assert.equal(applied.ok, true, applied.error);
    assert.deepEqual(await leftoverTemps(dir), []);
  });
});

describe("bump.mjs — runBump", () => {
  it("bumps the four carriers and satisfies version.mjs afterwards", async () => {
    const dir = await makeTree();
    await writeTree(dir, fullTree("1.0.0"));

    const result = await runBump({ version: "1.1.0", base: dir });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.previous, "1.0.0");
    assert.equal(result.version, "1.1.0");
    assert.equal(result.entries.length, 4);

    // "串联绿": the checker the repo trusts now passes on the bumped tree — the group at
    // the new version, internally consistent.
    const checked = run(VERSION_CHECK, ["--base", dir]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /all 4 board version carriers agree on 1\.1\.0/);
  });

  it("bumps this repository's own manifests, byte for byte", async () => {
    // The fixtures above are hand-written in the same style; this case copies the
    // real files, so the tool is exercised against the exact bytes that ship —
    // including the inline `{ "name": … }` objects and one-line arrays the real
    // manifests use.
    const dir = await makeTree();
    const files = {};
    for (const rel of [...PATHS, CHANGELOG_FILE]) files[rel] = await readFile(join(ROOT, rel), "utf8");
    await writeTree(dir, files);

    const current = parseSemver(JSON.parse(files["package.json"]).version);
    const target = `${current.major + 1}.0.0`;

    const result = await runBump({ version: target, base: dir, changelog: true, date: "2026-10-10" });
    assert.equal(result.ok, true, result.error);
    for (const entry of result.entries) {
      if (entry.label === "changelog") continue;
      assert.equal(
        entry.after,
        entry.before.replace(`"${current.raw}"`, `"${target}"`),
        `${entry.path}: only the version literal moved`,
      );
    }

    const checked = run(VERSION_CHECK, ["--base", dir]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, new RegExp(`all 4 board version carriers agree on ${target.replace(/\./g, "\\.")}`));
    assert.equal(run(CHANGELOG_CHECK, [`v${target}`, "--base", dir]).status, 0);
  });

  it("takes a prerelease target when it is a real step forward", async () => {
    const dir = await makeTree();
    await writeTree(dir, fullTree("1.0.0"));
    const result = await runBump({ version: "1.1.0-rc.1", base: dir });
    assert.equal(result.ok, true, result.error);
    const checked = run(VERSION_CHECK, ["--base", dir]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /agree on 1\.1\.0-rc\.1/);
  });

  it("adds the changelog scaffold in the same atomic step", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    await writeFile(join(dir, CHANGELOG_FILE), "# Changelog\n\n## [1.0.0] - 2026-10-09\n\n- first.\n", "utf8");

    const result = await runBump({ version: "1.1.0", base: dir, changelog: true, date: "2026-10-10" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.entries.length, 5, "four carriers + the changelog");
    assert.equal(result.changelog.path, CHANGELOG_FILE);

    const body = await readFile(join(dir, CHANGELOG_FILE), "utf8");
    assert.ok(body.includes("## [1.1.0] - 2026-10-10"));
    assert.equal(run(CHANGELOG_CHECK, ["v1.1.0", "--base", dir]).status, 0);
  });

  it("writes nothing when the changelog already has the section", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    const changelog = "# Changelog\n\n## [2.0.0] - 2026-09-01\n\n- already there.\n";
    await writeFile(join(dir, CHANGELOG_FILE), changelog, "utf8");
    const before = await snapshot(dir);

    const result = await runBump({ version: "2.0.0", base: dir, changelog: true, date: "2026-10-10" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "changelog-exists");
    assert.deepEqual(await snapshot(dir), before, "the refusal precedes every write");
    assert.equal(await readFile(join(dir, CHANGELOG_FILE), "utf8"), changelog);
  });

  it("tags an annotated v<x.y.z> after a successful bump, and never pushes", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    await writeFile(join(dir, CHANGELOG_FILE), documentedChangelog(), "utf8");

    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = await runBump({ version: "1.1.0", base: dir, tag: true, run });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.tagged, "v1.1.0");
    assert.deepEqual(
      calls,
      [{ command: "git", args: ["tag", "-a", "v1.1.0", "-m", "Meerkat TaskPanel v1.1.0"], cwd: dir }],
      "exactly one git call: an annotated tag",
    );
    assert.equal(
      calls.some((call) => call.args.includes("push")),
      false,
      "push is the human's, never this script's",
    );
  });

  it("reports a failed tag without pretending the bump did not happen", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    await writeFile(join(dir, CHANGELOG_FILE), documentedChangelog(), "utf8");

    const result = await runBump({
      version: "1.1.0",
      base: dir,
      tag: true,
      run: () => ({ status: 128, stdout: "", stderr: "fatal: tag already exists" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "tag-failed");
    assert.match(result.error, /tag already exists/);
    assert.match(result.error, /the files were written/);
    assert.equal((await readFile(join(dir, "package.json"), "utf8")).includes('"1.1.0"'), true, "the bump stands");
  });

  it("refuses to tag a scaffold changelog, and does not call git", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    await writeFile(
      join(dir, CHANGELOG_FILE),
      "# Changelog\n\n## [1.1.0] - 2026-10-10\n\n### Added\n\n- _Nothing yet._\n",
      "utf8",
    );

    let called = false;
    const result = await runBump({
      version: "1.1.0",
      base: dir,
      tag: true,
      run: () => {
        called = true;
        return { status: 0 };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "gate-failed");
    assert.equal(called, false, "the changelog gate runs before git");
    assert.match(result.error, /the files were written/);
    assert.equal((await readFile(join(dir, "package.json"), "utf8")).includes('"1.1.0"'), true);
  });

  it("refuses to tag without a changelog section", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));

    const result = await runBump({
      version: "1.1.0",
      base: dir,
      tag: true,
      run: () => ({ status: 0 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "gate-failed");
  });

  it("does not call git at all without --tag", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    let called = false;
    await runBump({
      version: "1.1.0",
      base: dir,
      run: () => {
        called = true;
        return { status: 0 };
      },
    });
    assert.equal(called, false);
  });
});

describe("bump.mjs — the CLI", () => {
  it("bumps a tree and prints the new version", async () => {
    const dir = await makeTree();
    await writeTree(dir, fullTree("1.0.0"));

    const result = run(BUMP, ["1.1.0", "--base", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bump: 1\.0\.0 → 1\.1\.0 \(board\)/);
    assert.match(result.stdout, /4 board carriers now at 1\.1\.0/);
    assert.equal(run(VERSION_CHECK, ["--base", dir]).status, 0);
  });

  it("exits 2 on usage errors", () => {
    assert.equal(run(BUMP, []).status, 2);
    assert.equal(run(BUMP, ["1.1.0", "1.2.0"]).status, 2);
    assert.equal(run(BUMP, ["--help"]).status, 0);
  });

  it("exits 1 on a refused input, having written nothing", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.0.0"));
    const before = await snapshot(dir);

    const same = run(BUMP, ["1.0.0", "--base", dir]);
    assert.equal(same.status, 1);
    assert.match(same.stderr, /not greater/);

    const bad = run(BUMP, ["v2.0.0", "--base", dir]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not valid semver/);

    assert.deepEqual(await snapshot(dir), before);
  });

  it("exits 3 when the tag fails, after the bump has landed", async () => {
    const dir = await makeTree();
    await writeTree(dir, fullTree("1.0.0"));
    await writeFile(join(dir, CHANGELOG_FILE), documentedChangelog(), "utf8");

    // The temp tree is not a git repository (and the verify image has no git), so
    // the tag step cannot succeed — the point is the exit code and that the files
    // were still written.
    const result = run(BUMP, ["1.1.0", "--base", dir, "--tag"]);
    assert.equal(result.status, 3, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /git tag v1\.1\.0 failed/);
    assert.match(result.stderr, /git checkout --/);
    assert.equal(run(VERSION_CHECK, ["--base", dir]).status, 0, "the four board files were written");
  });
});
