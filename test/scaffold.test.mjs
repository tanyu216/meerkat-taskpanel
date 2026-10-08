/**
 * M0 scaffold smoke / contract tests.
 *
 * These assert the engineering scaffold is real and importable: manifests parse, the
 * skill is a single source of truth kept in sync, the CLI stub behaves, and the
 * repository-level guard files are present. No business logic is exercised — there is
 * none yet.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { compareDirs, listFiles, resolveSkillSource, syncSkills } from "../scripts/sync-skills.mjs";
import { MANIFESTS, validateManifests } from "../scripts/verify/manifests.mjs";
import { validateSkill } from "../scripts/verify/skill.mjs";
import { VERSION } from "../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Temp dirs created by these tests, removed in the `after` hook. */
const tempDirs = [];

async function makeTempDir(prefix = "taskpanel-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("plugin manifests", () => {
  it("all four host manifests + the marketplace manifest parse and carry required keys", async () => {
    assert.equal(MANIFESTS.length, 5);

    const report = await validateManifests(ROOT);
    const failures = report.results.filter((r) => !r.ok);
    assert.deepEqual(
      failures.map((f) => `${f.label}: ${f.error}`),
      [],
      "every manifest must be valid JSON with its required keys",
    );
    assert.equal(report.ok, true);
  });

  it("every host manifest points its skills field at ./skills (or [./skills])", async () => {
    const hosts = ["claude", "codex", "openclaw", "pi"];
    const paths = {
      claude: "plugins/claude/.claude-plugin/plugin.json",
      codex: "plugins/codex/.codex-plugin/plugin.json",
      openclaw: "plugins/openclaw/openclaw.plugin.json",
      pi: "plugins/pi/package.json",
    };

    for (const host of hosts) {
      const data = JSON.parse(await readFile(join(ROOT, paths[host]), "utf8"));
      // Codex/Claude use `skills`; OpenClaw uses an array; Pi uses `files`.
      const value = data.skills ?? data.files;
      assert.ok(
        JSON.stringify(value).includes("./skills") ||
          JSON.stringify(value).includes("skills"),
        `${host} manifest should reference its skills directory`,
      );
    }
  });
});

describe("skill sync", () => {
  it("resolveSkillSource / listFiles return what the sync expects", async () => {
    const source = resolveSkillSource(ROOT);
    assert.equal(source, join(ROOT, "skills", "task-panel"));

    const files = await listFiles(source);
    assert.ok(files.includes("SKILL.md"), "SKILL.md must be listed");
    assert.ok(files.includes("references/cli.md"), "references/cli.md must be listed");
    assert.ok(files.includes("scripts/run.mjs"), "scripts/run.mjs must be listed");

    const sorted = [...files].sort();
    assert.deepEqual(files, sorted, "listFiles output must be sorted");
  });

  it("syncSkills({check:true}) reports every host in sync", async () => {
    const report = await syncSkills({ root: ROOT, check: true });

    for (const host of report.hosts) {
      assert.equal(
        host.equal,
        true,
        `plugins/${host.host}/skills is out of sync — run \`node scripts/sync-skills.mjs\``,
      );
      assert.deepEqual(host.missing, []);
      assert.deepEqual(host.extra, []);
      assert.deepEqual(host.differing, []);
    }

    assert.equal(report.ok, true);
  });

  it("compareDirs detects changed, missing and extra files in a temp copy", async () => {
    const tmp = await makeTempDir();

    const source = join(tmp, "src", "task-panel");
    const dest = join(tmp, "dest", "task-panel");

    // Real skill source, copied twice — first as an identical mirror.
    await cp(resolveSkillSource(ROOT), source, { recursive: true });
    await cp(source, dest, { recursive: true });

    const same = await compareDirs(source, dest);
    assert.equal(same.equal, true, "identical trees must compare equal");
    assert.deepEqual(same.differing, []);

    // 1. Corrupt one file → reported as differing.
    const docPath = join(dest, "references", "cli.md");
    await writeFile(docPath, "corrupted\n", "utf8");
    const corrupted = await compareDirs(source, dest);
    assert.equal(corrupted.equal, false);
    assert.deepEqual(corrupted.differing, ["references/cli.md"]);
    assert.deepEqual(corrupted.missing, []);
    assert.deepEqual(corrupted.extra, []);

    // 2. Delete a file → reported as missing from the destination.
    await cp(join(source, "references", "cli.md"), docPath);
    await rm(join(dest, "scripts", "run.mjs"));
    const missing = await compareDirs(source, dest);
    assert.equal(missing.equal, false);
    assert.deepEqual(missing.missing, ["scripts/run.mjs"]);

    // 3. Add a stray file → reported as extra.
    await cp(join(source, "scripts", "run.mjs"), join(dest, "scripts", "run.mjs"));
    await writeFile(join(dest, "stray.md"), "stray\n", "utf8");
    const extra = await compareDirs(source, dest);
    assert.equal(extra.equal, false);
    assert.deepEqual(extra.extra, ["stray.md"]);
  });

  it("compareDirs treats a wholly absent destination as all-missing", async () => {
    const tmp = await makeTempDir();
    const source = resolveSkillSource(ROOT);
    const absent = join(tmp, "nope");

    const diff = await compareDirs(source, absent);
    assert.equal(diff.equal, false);
    assert.ok(diff.missing.length > 0);
    assert.deepEqual(diff.extra, []);
    assert.deepEqual(diff.differing, []);
  });
});

describe("skill definition", () => {
  it("SKILL.md has frontmatter with name: task-panel and a real description", async () => {
    const result = await validateSkill(ROOT);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.name, "task-panel");
    assert.ok(
      typeof result.description === "string" && result.description.length >= 20,
      "description must be non-empty and at least 20 characters",
    );
  });
});

describe("package manifest", () => {
  it("exposes bin.taskctl and engines.node >= 22", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

    assert.equal(pkg.type, "module");
    assert.ok(pkg.bin, "package.json must declare a bin");
    assert.equal(pkg.bin.taskctl, "./src/cli/index.mjs");
    assert.ok(existsSync(join(ROOT, pkg.bin.taskctl)), "bin target must exist");

    const range = String(pkg.engines?.node ?? "");
    const major = Number(range.match(/\d+/)?.[0]);
    assert.ok(Number.isFinite(major), `cannot parse node engines range: ${range}`);
    assert.ok(major >= 22, `engines.node must be >= 22, got ${range}`);
  });
});

describe("install.sh", () => {
  it("documents every --target value and supports --dry-run", async () => {
    const script = await readFile(join(ROOT, "install.sh"), "utf8");

    for (const target of ["claude", "openclaw", "codex", "pi", "all"]) {
      assert.ok(script.includes(target), `install.sh must mention target "${target}"`);
    }

    assert.match(script, /--target/, "install.sh must accept --target");
    assert.match(script, /--dry-run/, "install.sh must accept --dry-run");
    assert.match(script, /--prefix/, "install.sh must accept --prefix");
    assert.match(script, /--link/, "install.sh must accept --link");
    assert.match(script, /--force/, "install.sh must accept --force");

    // It is a dispatcher: it must delegate to the per-host installers.
    assert.match(script, /scripts\/install\/?\$?\{?host\}?\.sh|scripts\/install\//);
  });

  it("--dry-run prints destinations and creates nothing", async () => {
    const fakeHome = await makeTempDir();

    const run = spawnSync("bash", [join(ROOT, "install.sh"), "--target", "all", "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TASKPANEL_TARGET_HOME: fakeHome },
    });

    assert.equal(run.status, 0, run.stderr);
    for (const hostDir of [".claude", ".openclaw", ".codex", ".agents"]) {
      assert.ok(
        run.stdout.includes(join(fakeHome, hostDir, "skills", "task-panel")),
        `dry run must print the ${hostDir} destination path`,
      );
    }
    assert.equal(existsSync(join(fakeHome, ".claude")), false, "dry run must not write");
    assert.equal(existsSync(join(fakeHome, ".agents")), false, "dry run must not write");
  });

  it("installs into a temp home and refuses to clobber an existing install", async () => {
    const fakeHome = await makeTempDir();
    const dest = join(fakeHome, ".claude", "skills", "task-panel");
    const env = { ...process.env, TASKPANEL_TARGET_HOME: fakeHome };

    const first = spawnSync("bash", [join(ROOT, "scripts/install/claude.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(join(dest, "SKILL.md")), "SKILL.md must be installed");

    const second = spawnSync("bash", [join(ROOT, "scripts/install/claude.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(second.status, 1, "re-install without --force must fail");
    assert.match(second.stderr, /already exists/);

    const forced = spawnSync("bash", [join(ROOT, "scripts/install/claude.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...env, TASKPANEL_FORCE: "1" },
    });
    assert.equal(forced.status, 0, forced.stderr);
  });
});

describe("repository guard files", () => {
  it(".gitignore covers build output, runtime data and OS noise", async () => {
    const ignore = await readFile(join(ROOT, ".gitignore"), "utf8");
    for (const entry of ["node_modules/", "dist/", ".data/", ".DS_Store"]) {
      assert.ok(ignore.includes(entry), `.gitignore must contain ${entry}`);
    }
  });

  it("LICENSE is MIT with the expected copyright line", async () => {
    const license = await readFile(join(ROOT, "LICENSE"), "utf8");
    assert.match(license, /^MIT License/m);
    assert.ok(license.includes("Copyright (c) 2026 tanyu216"));
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  });

  it("ships English and Chinese READMEs plus a privacy note", async () => {
    for (const file of ["README.md", "README.zh-CN.md", "PRIVACY.md"]) {
      assert.ok(existsSync(join(ROOT, file)), `${file} must exist`);
    }
  });
});

describe("taskctl CLI", () => {
  const cli = join(ROOT, "src", "cli", "index.mjs");

  it("--version exits 0 and prints the shared VERSION", () => {
    const run = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
  });

  it("--help and no arguments exit 0 with usage", () => {
    for (const args of [["--help"], []]) {
      const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Usage:/);
    }
  });

  // M2 replaced the M0 stub: a command that does not exist is now a *usage*
  // error (exit 2) against the real registry, not a "not implemented" notice.
  // The full command surface is exercised in `test/cli/**`; this case only pins
  // that the entry point still refuses nonsense the same way.
  it("an unknown command exits 2 with a usage error on stderr", () => {
    const run = spawnSync(process.execPath, [cli, "claim", "T-1"], { encoding: "utf8" });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /CLI_USAGE/);
    assert.match(run.stderr, /unknown command "claim"/);
  });

  it("the skill wrapper forwards to the same CLI", () => {
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "skills", "task-panel", "scripts", "run.mjs"), "--version"],
      { encoding: "utf8", cwd: tmpdir() },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
  });
});
