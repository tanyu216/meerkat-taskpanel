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
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { SKILL_BUNDLES, SKILL_HOSTS, compareDirs, listFiles, resolveSkillSource, skillTargets, syncSkills } from "../scripts/sync-skills.mjs";
import { MANIFESTS, validateManifests } from "../scripts/verify/manifests.mjs";
import { validateSkill } from "../scripts/verify/skill.mjs";
import { VERSION } from "../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Temp dirs created by these tests, removed in the `after` hook. */
const tempDirs = [];

async function makeTempDir(prefix = "meerkat-taskpanel-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Every directory named `skills` under `rootDir`, repository-relative and sorted.
 * Skips the trees that are output rather than content (`dist/`, `node_modules/`, `.git/`).
 *
 * @param {string} dir
 * @param {string} [rel]
 * @returns {Promise<string[]>}
 */
async function skillDirsUnder(dir, rel = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.name === "skills") out.push(child);
    out.push(...(await skillDirsUnder(join(dir, entry.name), child)));
  }
  return out.sort();
}

describe("plugin manifests", () => {
  it("the board, Cursor, OpenClaw, Pi and the loop bundle manifests parse and carry required keys", async () => {
    // 4 board manifests (the repository-root board plugin, Cursor's marker, OpenClaw's
    // native manifest and the Pi package) + the loop skill's 2 (Claude-format plugin + Pi
    // package) + the marketplace. Codex has no manifest of its own: it installs the same
    // `./` bundle as Claude Code through the repository-root marketplace.
    assert.equal(MANIFESTS.length, 7);

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
    // Codex is absent on purpose: it ships no manifest, and installs the same
    // repository-root bundle as Claude Code (HOST_BUNDLES.codex names that manifest).
    // Pi's manifest is the repository's own `package.json`, whose `pi` field declares the
    // skills path — hence the `files`/`skills` fallback in the assertion below.
    const hosts = ["claude", "openclaw", "pi"];
    const paths = {
      claude: ".claude-plugin/plugin.json",
      openclaw: "plugins/openclaw/openclaw.plugin.json",
      pi: "package.json",
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
    assert.equal(source, join(ROOT, "skills", "meerkat-taskpanel"));

    const files = await listFiles(source);
    assert.ok(files.includes("SKILL.md"), "SKILL.md must be listed");
    assert.ok(files.includes("references/cli.md"), "references/cli.md must be listed");
    assert.ok(files.includes("scripts/run.mjs"), "scripts/run.mjs must be listed");

    const sorted = [...files].sort();
    assert.deepEqual(files, sorted, "listFiles output must be sorted");
  });

  it("syncSkills({check:true}) reports every generated copy in sync", async () => {
    const report = await syncSkills({ root: ROOT, check: true });

    for (const result of report.results) {
      assert.equal(
        result.equal,
        true,
        `plugins/${result.target}/skills/${result.skill} is out of sync — run \`node scripts/sync-skills.mjs\``,
      );
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.extra, []);
      assert.deepEqual(result.differing, []);
    }

    assert.equal(report.ok, true);
  });

  it("distributes the board only to OpenClaw, and the loop only as a marketplace bundle", () => {
    // The split's whole point: the distribution surface follows the responsibility.
    // OpenClaw runs the openclaw-team framework's own poll/patrol, so a second supervisor
    // there would only race the first for the same cards (ruling O3) — and it is the only
    // host left that needs a generated copy, because every other harness reads the
    // repository's own `skills/` tree through its manifest.
    assert.deepEqual(SKILL_HOSTS["meerkat-taskpanel"], ["openclaw"]);
    assert.deepEqual(SKILL_HOSTS["meerkat-loop"], []);
    assert.equal(SKILL_HOSTS["meerkat-loop"].includes("openclaw"), false);

    // A `bundle` target is not a host: it exists so the marketplace can list the loop as
    // its own plugin, sourced at a directory that exposes the loop skill and nothing else.
    assert.deepEqual(SKILL_BUNDLES["meerkat-loop"], ["loop"]);

    const rows = skillTargets();
    assert.deepEqual(
      rows.map((row) => `${row.skill}→${row.target}`),
      ["meerkat-taskpanel→openclaw", "meerkat-loop→loop"],
    );
  });

  it("keeps one skills tree: no harness gains a third copy", async () => {
    // The invariant the whole distribution change exists for, asserted against the
    // checkout rather than the table — a table can only describe the copies it knows
    // about. Only the two bundles that MUST carry a sibling `skills/` do; every other
    // harness reads the repository's own tree through its manifest. A new host that adds
    // a copy is exactly the regression this catches
    // (design/plugin-distribution-plan.md §3.1 and the §5.3 acceptance list).
    assert.deepEqual(await skillDirsUnder(ROOT), [
      "plugins/loop/skills",
      "plugins/openclaw/skills",
      "skills",
    ]);

    assert.deepEqual((await readdir(join(ROOT, "plugins"))).sort(), ["loop", "openclaw"]);

    // 1 OpenClaw manifest + 8 OpenClaw skill files + 2 loop manifests + 25 loop skill files.
    // The count is the floor the plan measured; it moves only deliberately.
    assert.equal((await listFiles(join(ROOT, "plugins"))).length, 36);
  });

  it("compareDirs detects changed, missing and extra files in a temp copy", async () => {
    const tmp = await makeTempDir();

    const source = join(tmp, "src", "meerkat-taskpanel");
    const dest = join(tmp, "dest", "meerkat-taskpanel");

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
  it("SKILL.md has frontmatter with name: meerkat-taskpanel and a real description", async () => {
    const result = await validateSkill(ROOT);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.name, "meerkat-taskpanel");
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

  it("exposes the CLI as a bin that is ready to run", async () => {
    // `taskctl` is a *program*, not just a library: a host config or an installer
    // has to be able to start it without knowing where it lives. So it is a bin,
    // and a bin has to actually be runnable — two separate facts, both of them
    // easy to lose and neither visible from here without being written down.
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

    const entry = join(ROOT, pkg.bin.taskctl);
    assert.ok(existsSync(entry), "bin target must exist");
    assert.match(readFileSync(entry, "utf8"), /^#!\/usr\/bin\/env node\n/, "a bin needs a shebang");
    assert.ok(
      (statSync(entry).mode & 0o111) !== 0,
      "a bin must be executable (`chmod +x`), or the launcher cannot run it",
    );
  });
});

describe("install.sh", () => {
  it("documents every --target value and supports --dry-run", async () => {
    const script = await readFile(join(ROOT, "install.sh"), "utf8");

    for (const target of ["claude", "openclaw", "codex", "pi", "opencode", "cursor", "all"]) {
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
      env: { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: fakeHome },
    });

    assert.equal(run.status, 0, run.stderr);
    for (const hostDir of [".claude", ".openclaw", ".codex", ".agents"]) {
      assert.ok(
        run.stdout.includes(join(fakeHome, hostDir, "skills", "meerkat-taskpanel")),
        `dry run must print the ${hostDir} destination path`,
      );
    }
    assert.equal(existsSync(join(fakeHome, ".claude")), false, "dry run must not write");
    assert.equal(existsSync(join(fakeHome, ".agents")), false, "dry run must not write");
  });

  it("installs into a temp home and re-installs idempotently", async () => {
    const fakeHome = await makeTempDir();
    const dest = join(fakeHome, ".claude", "skills", "meerkat-taskpanel");
    const env = { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: fakeHome };

    const first = spawnSync("bash", [join(ROOT, "scripts/install/claude.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(join(dest, "SKILL.md")), "SKILL.md must be installed");

    // Re-install without --force is now the desired end state, not an error: it keeps
    // the existing install and reports it (merge, never clobber).
    const second = spawnSync("bash", [join(ROOT, "scripts/install/claude.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already installed/);

    const forced = spawnSync("bash", [join(ROOT, "scripts/install/claude.sh")], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...env, MEERKAT_TASKPANEL_FORCE: "1" },
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

  it("ships the contribution contract: CONTRIBUTING, CODEOWNERS, PR and issue templates", () => {
    for (const file of [
      "CONTRIBUTING.md",
      join(".github", "CODEOWNERS"),
      join(".github", "PULL_REQUEST_TEMPLATE.md"),
      join(".github", "ISSUE_TEMPLATE", "bug_report.md"),
      join(".github", "ISSUE_TEMPLATE", "feature_request.md"),
      ".mailmap",
    ]) {
      assert.ok(existsSync(join(ROOT, file)), `${file} must exist`);
    }
  });

  it("CONTRIBUTING names the gate a contribution actually has to pass", async () => {
    /* Non-vacuity: a CONTRIBUTING.md that only says "be nice" would satisfy an
     * existence check. Pin the two facts a contributor cannot guess — the container
     * gate and the commit-before-you-run-it ordering — plus the generated-skills rule. */
    const text = await readFile(join(ROOT, "CONTRIBUTING.md"), "utf8");
    for (const needle of ["npm run verify:docker", "commit", "sync-skills", "contract"]) {
      assert.ok(text.includes(needle), `CONTRIBUTING.md must mention ${needle}`);
    }
  });

  it("CODEOWNERS routes the repository, not just some paths", async () => {
    /* A CODEOWNERS file with only narrow rules leaves everything else unreviewed, which
     * is the exact opposite of what the file is for. Require the catch-all rule. */
    const text = await readFile(join(ROOT, ".github", "CODEOWNERS"), "utf8");
    const rules = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(rules.length >= 1, "CODEOWNERS must carry at least one rule");
    assert.ok(
      rules.some((rule) => rule.startsWith("*")),
      "CODEOWNERS must have a catch-all rule so no path is left unowned",
    );
    for (const rule of rules) {
      assert.match(rule, /@[A-Za-z0-9-]+/, `every CODEOWNERS rule needs an owner: ${rule}`);
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
      [join(ROOT, "skills", "meerkat-taskpanel", "scripts", "run.mjs"), "--version"],
      { encoding: "utf8", cwd: tmpdir() },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
  });
});
