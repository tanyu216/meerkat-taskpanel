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
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { listFiles, resolveSkillSource } from "../scripts/sync-skills.mjs";
import { MANIFESTS, validateManifests } from "../scripts/verify/manifests.mjs";
import { validateSkills } from "../scripts/verify/skill.mjs";
import { VERSION } from "../src/foundation/constants.mjs";

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
    // `.worktrees/` holds parallel-task checkouts *inside* this checkout (CLAUDE.md
    // Branch & worktree workflow). It is gitignored, so nothing under it can be a
    // committed skill copy — but the walk would otherwise find
    // `.worktrees/<lane>/skills` and read it as one, reding this gate for as long as
    // any lane is running.
    if (
      entry.name === ".git" ||
      entry.name === ".worktrees" ||
      entry.name === "node_modules" ||
      entry.name === "dist"
    ) {
      continue;
    }
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.name === "skills") out.push(child);
    out.push(...(await skillDirsUnder(join(dir, entry.name), child)));
  }
  return out.sort();
}

describe("plugin manifests", () => {
  it("the board, Pi and marketplace manifests parse and carry required keys", async () => {
    // Two board manifests (the repository-root board plugin and the Pi package) + the
    // marketplace. Codex has no manifest of its own: it installs the same `./` bundle as
    // Claude Code through the repository-root marketplace. OpenClaw has none either — it
    // reads that same root bundle, so it ships no native manifest to keep in sync (it did
    // until the `plugins/` directory was emptied).
    assert.equal(MANIFESTS.length, 3);

    const report = await validateManifests(ROOT);
    const failures = report.results.filter((r) => !r.ok);
    assert.deepEqual(
      failures.map((f) => `${f.label}: ${f.error}`),
      [],
      "every manifest must be valid JSON with its required keys",
    );
    assert.equal(report.ok, true);
  });

  it("every agent-kind manifest points its skills field at ./skills (or [./skills])", async () => {
    // Codex is absent on purpose: it ships no manifest, and installs the same
    // repository-root bundle as Claude Code (KIND_BUNDLES.codex names that manifest).
    // Pi's manifest is the repository's own `package.json`, whose `pi` field declares the
    // skills path — hence the `files`/`skills` fallback in the assertion below.
    const kinds = ["claude", "pi"];
    const paths = {
      claude: ".claude-plugin/plugin.json",
      pi: "package.json",
    };

    for (const kind of kinds) {
      const data = JSON.parse(await readFile(join(ROOT, paths[kind]), "utf8"));
      // Claude declares `skills`; Pi's carrier is the root package's `files`.
      const value = data.skills ?? data.files;
      assert.ok(
        JSON.stringify(value).includes("./skills") ||
          JSON.stringify(value).includes("skills"),
        `${kind} manifest should reference its skills directory`,
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

  it("keeps exactly one skills tree: nothing is distributed as a copy", async () => {
    // The invariant the whole distribution story exists for, asserted against the
    // checkout rather than a table — a table can only describe the copies it knows about.
    // Every harness (claude, codex, pi, openclaw) reads the repository's
    // own `skills/` tree through its own manifest, so there is no generated copy anywhere.
    //
    // This is now the *only* guard: with no copy targets left, `sync-skills.mjs --check`
    // has nothing to compare and cannot notice an orphan `plugins/` tree. A harness that
    // reintroduces one is exactly the regression this catches
    // (design/plugin-distribution-plan.md §3.1 / §5.3, reversed for the floor by
    // design/plugin-distribution-plan.md's 2026-10-17 decision note).
    assert.deepEqual(await skillDirsUnder(ROOT), ["skills"]);

    assert.equal(
      existsSync(join(ROOT, "plugins")),
      false,
      "plugins/ must not exist — no skill may be distributed as a committed copy",
    );
  });
});

describe("skill definitions", () => {
  it("every SKILL.md names its directory and carries a real description", async () => {
    const { ok, results } = await validateSkills(ROOT);
    assert.equal(ok, true, results.filter((result) => !result.ok).map((result) => result.error).join("\n"));
    assert.deepEqual(
      results.map((result) => result.name).sort(),
      ["meerkat-loop", "meerkat-taskpanel", "setup-meerkat"],
    );
    for (const result of results) {
      assert.ok(
        typeof result.description === "string" && result.description.length >= 20,
        `${result.skill}: description must be non-empty and at least 20 characters`,
      );
    }
  });
});

describe("package manifest", () => {
  it("exposes the installer, taskctl and taskd as bins, and ships web/dist", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

    assert.equal(pkg.type, "module");
    assert.ok(pkg.bin, "package.json must declare a bin");
    for (const [name, target] of [
      ["meerkat-taskpanel", "./scripts/install/cli.mjs"],
      ["taskctl", "./src/cli/index.mjs"],
      ["taskd", "./src/server/main.mjs"],
    ]) {
      assert.equal(pkg.bin[name], target, `bin.${name}`);
      const entry = join(ROOT, target);
      assert.ok(existsSync(entry), `bin.${name} target must exist`);
      assert.match(readFileSync(entry, "utf8"), /^#!\/usr\/bin\/env node\n/, `bin.${name} needs a shebang`);
      assert.ok(
        (statSync(entry).mode & 0o111) !== 0,
        `bin.${name} must be executable (\`chmod +x\`)`,
      );
    }
    assert.ok(pkg.files.includes("web/dist"), "the packaged server needs the built frontend");

    const range = String(pkg.engines?.node ?? "");
    const major = Number(range.match(/\d+/)?.[0]);
    assert.ok(Number.isFinite(major), `cannot parse node engines range: ${range}`);
    assert.ok(major >= 22, `engines.node must be >= 22, got ${range}`);
  });

  it("exposes the CLI as a bin that is ready to run", async () => {
    // `taskctl` is a *program*, not just a library: a agent config or an installer
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

    for (const target of ["claude", "openclaw", "codex", "pi", "server", "all"]) {
      assert.ok(script.includes(target), `install.sh must mention target "${target}"`);
    }

    assert.match(script, /--target/, "install.sh must accept --target");
    assert.match(script, /--dry-run/, "install.sh must accept --dry-run");
    assert.match(script, /--prefix/, "install.sh must accept --prefix");
    assert.match(script, /--link/, "install.sh must accept --link");
    assert.match(script, /--force/, "install.sh must accept --force");

    // It is a dispatcher: it must delegate to the per-agent-kind installers.
    assert.match(script, /scripts\/install\/\$target\.sh/);
  });

  it("--dry-run prints destinations and creates nothing", async () => {
    const fakeHome = await makeTempDir();

    const run = spawnSync("bash", [join(ROOT, "install.sh"), "--target", "all", "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: fakeHome },
    });

    assert.equal(run.status, 0, run.stderr);
    for (const agentDir of [".claude", ".openclaw", ".codex", ".agents"]) {
      assert.ok(
        run.stdout.includes(join(fakeHome, agentDir, "skills", "meerkat-taskpanel")),
        `dry run must print the ${agentDir} destination path`,
      );
    }
    assert.equal(existsSync(join(fakeHome, ".claude")), false, "dry run must not write");
    assert.equal(existsSync(join(fakeHome, ".agents")), false, "dry run must not write");
  });

  it("--target server --dry-run prints the runtime tree and creates nothing", async () => {
    const fakeHome = await makeTempDir();
    const run = spawnSync(
      "bash",
      [join(ROOT, "install.sh"), "--target", "server", "--dry-run", "--skip-node-check", "--skip-web-build"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          MEERKAT_TASKPANEL_TARGET_HOME: fakeHome,
          MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const tree = join(fakeHome, ".meerkat-taskpanel");
    assert.ok(run.stdout.includes(tree), "dry run must print the server root");
    assert.ok(run.stdout.includes(join(tree, "bin", "taskd")), "dry run must print the launchers");
    assert.equal(existsSync(tree), false, "dry run must not write the tree");
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
  it(".gitignore covers build output, runtime data, nested worktrees, the config file and OS noise", async () => {
    const ignore = await readFile(join(ROOT, ".gitignore"), "utf8");
    const entries = ignore.split("\n").map((line) => line.trim());
    for (const entry of ["node_modules/", "dist/", ".data/", ".worktrees/", ".DS_Store", ".env"]) {
      assert.ok(entries.includes(entry), `.gitignore must contain ${entry}`);
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
