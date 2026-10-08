/**
 * Bundle / marketplace inspection + the per-host profile bundle assertions.
 *
 * The container cannot run the four host CLIs (they are not in the image and there is
 * no network), so `scripts/verify/lib/bundle.mjs` reproduces the hosts' detection
 * contract offline. These tests pin that reproduction: the shipped bundles must be
 * detected with the format each host's profile declares, and the detector must follow
 * OpenClaw's documented precedence rather than accidentally matching the wrong format.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import {
  AGENT_BUNDLE_SCHEMA,
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  HOST_BUNDLES,
  NATIVE_MANIFEST,
  detectBundle,
  findSkills,
  inspectBundle,
  normalizePathList,
  parseMarketplace,
  resolveSkillRoots,
} from "../../scripts/verify/lib/bundle.mjs";
import { PROFILE_HOSTS, loadProfiles, runProfiles } from "../../scripts/verify/lib/profiles.mjs";
import { SKILL_NAME } from "../../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];

async function makeTempDir(prefix = "taskpanel-bundle-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

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
    for (const [host, meta] of Object.entries(HOST_BUNDLES)) {
      const info = detectBundle(join(ROOT, meta.dir));
      assert.equal(info.kind, meta.openclawKind, `${host}: kind`);
      assert.equal(info.format, meta.openclawFormat, `${host}: format`);
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
    await put(dir, "skills/task-panel/SKILL.md", skillMd());
    await put(dir, "extra/task-panel/SKILL.md", skillMd());

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

  it("resolves the shipped bundles to a loadable task-panel skill", () => {
    for (const [host, meta] of Object.entries(HOST_BUNDLES)) {
      const info = inspectBundle(join(ROOT, meta.dir));
      const skill = info.skills.find((s) => s.name === SKILL_NAME);
      assert.ok(skill, `${host}: expected a skill named ${SKILL_NAME} in ${meta.dir}`);
      assert.match(skill.entry, /SKILL\.md$/, `${host}: entry must be a SKILL.md`);
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
    assert.equal(market.name, "task-panel-marketplace");
    assert.ok(market.entries.length >= 1);

    for (const entry of market.entries) {
      assert.ok(entry.exists, `${entry.name}: source directory must exist`);
      assert.ok(entry.format, `${entry.name}: source must be a recognized bundle`);
      assert.ok(entry.skills >= 1, `${entry.name}: bundle must expose a skill`);
    }
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
  it("every shipped profile declares a bundle matching the host bundle table", async () => {
    const { profiles, errors } = await loadProfiles(join(ROOT, "docker", "profiles"));
    assert.deepEqual(errors, []);

    for (const host of PROFILE_HOSTS) {
      const profile = profiles[host];
      const meta = HOST_BUNDLES[host];
      assert.equal(profile.bundle, meta.dir, `${host}: bundle dir`);
      assert.equal(profile.bundle_format, meta.openclawFormat, `${host}: bundle format`);
      assert.equal(profile.bundle_kind, meta.openclawKind, `${host}: bundle kind`);
    }
  });

  it("runProfiles asserts the bundle for each host (not just the skill copy)", async () => {
    const home = await makeTempDir("taskpanel-home-");
    const result = await runProfiles({ home, quiet: true });

    assert.equal(result.ok, true, JSON.stringify(result.results.map((r) => r.error), null, 2));

    for (const entry of result.results) {
      const kinds = entry.steps.map((s) => s.name);
      assert.ok(
        kinds.some((n) => n.includes("bundle detected as")),
        `${entry.host}: expected a bundle-detection step`,
      );
      assert.ok(
        kinds.some((n) => n.includes("manifest parses")),
        `${entry.host}: expected a manifest-parse step`,
      );
    }

    assert.ok(
      result.results.find((r) => r.host === "claude").steps.some((s) => s.name.includes("marketplace.json")),
      "claude: expected the marketplace assertion",
    );
  });

  it("--host narrows the run to the selected hosts", async () => {
    const home = await makeTempDir("taskpanel-home-");
    const result = await runProfiles({ home, quiet: true, hosts: ["codex"] });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.results.map((r) => r.host),
      ["codex"],
    );
  });
});
