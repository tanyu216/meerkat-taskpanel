/**
 * Bundle / marketplace inspection + the per-agent-kind profile bundle assertions.
 *
 * The container cannot run the four agent CLIs (they are not in the image and there is
 * no network), so `scripts/verify/lib/bundle.mjs` reproduces the agent kinds' detection
 * contract offline. These tests pin that reproduction: the shipped bundles must be
 * detected with the format each agent kind's profile declares, and the detector must follow
 * OpenClaw's documented precedence rather than accidentally matching the wrong format.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

import { AGENT_BUNDLE_SCHEMA, CLAUDE_MANIFEST, CODEX_MANIFEST, KIND_BUNDLES, NATIVE_MANIFEST, detectBundle, findSkills, inspectBundle, normalizePathList, parseMarketplace, resolveSkillRoots } from "../../scripts/verify/lib/bundle.mjs";
import { PROFILE_KINDS, loadProfiles, runProfiles } from "../../scripts/verify/lib/profiles.mjs";
import { SKILLS } from "../../scripts/verify/skill.mjs";
import { SKILL_NAME } from "../../src/foundation/constants.mjs";

const { makeTempDir, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-bundle-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Write a file into `dir`, creating parent directories. */
async function put(dir, rel, contents) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf8");
}

/** A minimal valid SKILL.md. */
function skillMd(name = SKILL_NAME) {
  return `---\nname: ${name}\ndescription: a test skill with a long enough description\n---\n\n# ${name}\n`;
}

after(cleanup);

// ---------------------------------------------------------------------------
// normalizePathList
// ---------------------------------------------------------------------------

describe("bundle: normalizePathList", () => {
  it("accepts a string or a list, strips a leading ./ and trailing slashes", () => {
    assert.deepEqual(normalizePathList("./skills"), ["skills"]);
    assert.deepEqual(normalizePathList("./skills/"), ["skills"]);
    assert.deepEqual(normalizePathList(["skills", "commands/", "./agents"]), ["skills", "commands", "agents"]);
  });

  it("drops blanks, non-strings and duplicates", () => {
    assert.deepEqual(normalizePathList(["skills", "skills", "", "  ", 42, null]), ["skills"]);
    assert.deepEqual(normalizePathList(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// detectBundle — mirrors OpenClaw's detection precedence
// ---------------------------------------------------------------------------

describe("bundle: detectBundle", () => {
  it("detects each shipped bundle with the format its profile declares", () => {
    for (const [kind, meta] of Object.entries(KIND_BUNDLES)) {
      const info = detectBundle(join(ROOT, meta.dir));
      assert.equal(info.kind, meta.openclawKind, `${kind}: kind`);
      assert.equal(info.format, meta.openclawFormat, `${kind}: format`);
    }
  });

  it("prefers the codex marker when a directory carries several", async () => {
    const dir = await makeTempDir();
    await put(dir, CODEX_MANIFEST, "{}\n");
    await put(dir, CLAUDE_MANIFEST, "{}\n");
    assert.equal(detectBundle(dir).format, "codex");
  });

  it("reads a root plugin.json as an Agent bundle only with the standard $schema", async () => {
    const withSchema = await makeTempDir();
    await put(withSchema, "plugin.json", JSON.stringify({ name: "x", $schema: AGENT_BUNDLE_SCHEMA }));
    assert.deepEqual(
      { kind: detectBundle(withSchema).kind, format: detectBundle(withSchema).format },
      { kind: "bundle", format: "agent" },
    );

    const withoutSchema = await makeTempDir();
    await put(withoutSchema, "plugin.json", JSON.stringify({ name: "x" }));
    assert.equal(detectBundle(withoutSchema).format, null);
  });

  it("treats a bare skills/ tree as a manifestless Claude bundle", async () => {
    const dir = await makeTempDir();
    await put(dir, `skills/${SKILL_NAME}/SKILL.md`, skillMd());
    const info = detectBundle(dir);
    assert.deepEqual({ kind: info.kind, format: info.format }, { kind: "bundle", format: "claude" });
  });

  it("treats a native manifest as a native plugin, not a bundle", async () => {
    const dir = await makeTempDir();
    await put(dir, NATIVE_MANIFEST, JSON.stringify({ id: "x", configSchema: {} }));
    const info = detectBundle(dir);
    assert.deepEqual({ kind: info.kind, format: info.format }, { kind: "native", format: "native" });
  });

  it("reports a package.json-only directory as a package and an empty one as unknown", async () => {
    const pkg = await makeTempDir();
    await put(pkg, "package.json", JSON.stringify({ name: "x", version: "0.0.0" }));
    assert.equal(detectBundle(pkg).kind, "package");

    const empty = await makeTempDir();
    assert.equal(detectBundle(empty).kind, "unknown");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillRoots / findSkills
// ---------------------------------------------------------------------------

describe("bundle: skill resolution", () => {
  it("adds declared roots to the format defaults, keeping only existing directories", async () => {
    const dir = await makeTempDir();
    await put(dir, "skills/meerkat/SKILL.md", skillMd());
    await put(dir, "extra/meerkat/SKILL.md", skillMd());

    assert.deepEqual(resolveSkillRoots(dir, "claude", {}), ["skills"]);
    assert.deepEqual(resolveSkillRoots(dir, "claude", { skills: ["./skills", "extra"] }), ["skills", "extra"]);
  });

  it("finds a SKILL.md directly in the root or one per child directory", async () => {
    const direct = await makeTempDir();
    await put(direct, "skills/SKILL.md", skillMd());
    assert.deepEqual(
      findSkills(direct, "skills").map((s) => s.dir),
      ["skills"],
    );

    const children = await makeTempDir();
    await put(children, "skills/one/SKILL.md", skillMd("one"));
    await put(children, "skills/two/SKILL.md", skillMd("two"));
    await put(children, "skills/ignored/README.md", "# no skill here\n");
    assert.deepEqual(
      findSkills(children, "skills").map((s) => s.name),
      ["one", "two"],
    );

    assert.deepEqual(findSkills(children, "nope"), []);
  });

  it("resolves the shipped bundles to a loadable meerkat skill", () => {
    for (const [kind, meta] of Object.entries(KIND_BUNDLES)) {
      const info = inspectBundle(join(ROOT, meta.dir));
      const skill = info.skills.find((s) => s.name === SKILL_NAME);
      assert.ok(skill, `${kind}: expected a skill named ${SKILL_NAME} in ${meta.dir}`);
      assert.match(skill.entry, /SKILL\.md$/, `${kind}: entry must be a SKILL.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// parseMarketplace
// ---------------------------------------------------------------------------

describe("bundle: parseMarketplace", () => {
  it("parses the shipped marketplace and resolves every entry to a bundle with a skill", () => {
    const market = parseMarketplace(ROOT);
    assert.equal(market.ok, true, market.error);
    assert.equal(market.name, "meerkat-taskpanel-marketplace");
    assert.ok(market.entries.length >= 1);

    for (const entry of market.entries) {
      assert.ok(entry.exists, `${entry.name}: source directory must exist`);
      assert.ok(entry.format, `${entry.name}: source must be a recognized bundle`);
      assert.ok(entry.skills >= 1, `${entry.name}: bundle must expose a skill`);
    }
  });

  it("lists the board, sourced at the repository root, and nothing else", async () => {
    // The marketplace used to list two plugins — the board and the loop, the latter sourced
    // at a `plugins/loop` bundle that carried the loop skill and nothing else, so that
    // installing `meerkat-loop` alone could not quietly bring the board with it. The loop's
    // bundle is gone: `meerkat-loop` is installed by `install.sh --target claude|codex|pi`
    // only, and the marketplace now has a single entry.
    const market = parseMarketplace(ROOT);
    assert.equal(market.ok, true, market.error);

    // `source: "./"` — the board's plugin root IS the repository root, which is what lets
    // claude / codex / pi / openclaw share the one `skills/` tree. It is the
    // shared tree, so it exposes all three skills; that is not a second marketplace plugin.
    //
    // The entry is the plugin's name, not a skill's: the board skill has been renamed
    // (`meerkat-taskpanel` → `meerkat`) while the published plugin keeps its identity, so
    // the two must not be tied together.
    const plugin = JSON.parse(await readFile(join(ROOT, CLAUDE_MANIFEST), "utf8"));
    assert.deepEqual(market.entries.map((entry) => entry.name), [plugin.name]);
    assert.equal(market.entries[0].dir, "", "the board's source directory");

    const names = inspectBundle(ROOT).skills.map((skill) => skill.name);
    assert.ok(names.includes(SKILL_NAME), `./ must expose ${SKILL_NAME}`);
    assert.deepEqual(
      [...names].sort(),
      [...SKILLS].sort(),
      "the root bundle is the shared tree and carries all three skills",
    );

    // No entry may be sourced at a bundle directory: with `plugins/` gone, a second entry
    // could only point at a directory that does not exist.
    assert.equal(
      market.entries.some((entry) => entry.dir !== ""),
      false,
      "every marketplace entry must resolve to the repository root",
    );
  });

  it("fails when a source directory is missing", async () => {
    const dir = await makeTempDir();
    await put(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({ name: "m", owner: { name: "x" }, metadata: {}, plugins: [{ name: "p", source: "./gone" }] }),
    );
    const market = parseMarketplace(dir);
    assert.equal(market.ok, false);
    assert.match(market.entries[0].error, /not found/);
  });

  it("fails when a source is not a relative path", async () => {
    const dir = await makeTempDir();
    await put(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({ name: "m", owner: { name: "x" }, metadata: {}, plugins: [{ name: "p", source: "/abs" }] }),
    );
    const market = parseMarketplace(dir);
    assert.equal(market.ok, false);
    assert.match(market.entries[0].error, /relative path/);
  });

  it("reports a missing or unparseable marketplace at the top level", async () => {
    const empty = await makeTempDir();
    assert.match(parseMarketplace(empty).error, /not found/);

    const bad = await makeTempDir();
    await put(bad, ".claude-plugin/marketplace.json", "{ not json\n");
    assert.match(parseMarketplace(bad).error, /invalid JSON/);
  });

  it("rejects a marketplace whose source exists but is not a bundle", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "plugins/not-a-bundle"), { recursive: true });
    await put(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "m",
        owner: { name: "x" },
        metadata: {},
        plugins: [{ name: "p", source: "./plugins/not-a-bundle" }],
      }),
    );
    const market = parseMarketplace(dir);
    assert.equal(market.ok, false);
    assert.match(market.entries[0].error, /not a recognized bundle/);
  });
});

// ---------------------------------------------------------------------------
// profiles carry the bundle expectation, and the runner asserts it
// ---------------------------------------------------------------------------

describe("profiles: bundle expectations", () => {
  it("every shipped profile declares a bundle matching the agent bundle table", async () => {
    const { profiles, errors } = await loadProfiles(join(ROOT, "docker", "profiles"));
    assert.deepEqual(errors, []);

    for (const kind of PROFILE_KINDS) {
      const profile = profiles[kind];
      const meta = KIND_BUNDLES[kind];

      // Every profiled agent kind installs the repository-root bundle, so each must
      // declare the bundle fields the detector checks.
      assert.ok(meta, `${kind}: must have a bundle row`);
      assert.equal(profile.bundle, meta.dir, `${kind}: bundle dir`);
      assert.equal(profile.bundle_format, meta.openclawFormat, `${kind}: bundle format`);
      assert.equal(profile.bundle_kind, meta.openclawKind, `${kind}: bundle kind`);
    }
  });

  it("runProfiles asserts the bundle for each agent kind (not just the skill copy)", async () => {
    const home = await makeTempDir("meerkat-taskpanel-home-");
    const result = await runProfiles({ home, quiet: true });

    assert.equal(result.ok, true, JSON.stringify(result.results.map((r) => r.error), null, 2));

    for (const entry of result.results) {
      const kinds = entry.steps.map((s) => s.name);

      // Every profiled agent kind installs the repository-root bundle, so both
      // assertions must be present for each of them.
      assert.ok(
        kinds.some((n) => n.includes("bundle detected as")),
        `${entry.kind}: bundle-detection step presence`,
      );
      assert.ok(
        kinds.some((n) => n.includes("manifest parses")),
        `${entry.kind}: manifest-parse step presence`,
      );
    }

    assert.ok(
      result.results.find((r) => r.kind === "claude").steps.some((s) => s.name.includes("marketplace.json")),
      "claude: expected the marketplace assertion",
    );
  });

  it("--actor-kind narrows the run to the selected agent kinds", async () => {
    const home = await makeTempDir("meerkat-taskpanel-home-");
    const result = await runProfiles({ home, quiet: true, kinds: ["codex"] });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.results.map((r) => r.kind),
      ["codex"],
    );
  });
});
