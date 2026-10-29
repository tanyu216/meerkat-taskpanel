/**
 * Tests for `skills/setup-meerkat/scripts/security-tools.mjs` — the security toolchain
 * preflight.
 *
 * The script must be usable offline: it finds tools on PATH, reads their `--version`,
 * compares against the recorded matrix, and only installs or upgrades when the caller
 * names the action. Every case runs against a throwaway PATH, so no real scanner, package
 * manager or network is involved.
 *
 * Run with: node --test test/skill/security-tools.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { baseEnv } from "../helpers/base-env.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "skills", "setup-meerkat", "scripts", "security-tools.mjs");
const MATRIX = join(ROOT, "skills", "setup-meerkat", "assets", "security", "toolchain.json");
const REFERENCE = join(ROOT, "skills", "setup-meerkat", "references", "security-tools.md");

function temp(t, prefix = "tp-security-tools-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A PATH directory holding executable stubs that print a version. */
function fakeBin(t, tools = {}) {
  const dir = temp(t, "tp-fakebin-");
  for (const [name, output] of Object.entries(tools)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** A stub package manager that records its argv in $MARKER instead of acting. */
function fakeManager(t, dir, name = "brew") {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MARKER"\n');
  chmodSync(path, 0o755);
  return path;
}

function project(t, remote = null) {
  const dir = temp(t, "tp-project-");
  mkdirSync(join(dir, ".git"), { recursive: true });
  const config = remote === null ? "" : `[remote "origin"]\n\turl = ${remote}\n`;
  writeFileSync(join(dir, ".git", "config"), config);
  return dir;
}

function run(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, "--json"], {
    encoding: "utf8",
    env: baseEnv(env),
  });
  let body = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = null;
  }
  return { ...result, body };
}

const ALL_OK = {
  "osv-scanner": "osv-scanner version: 2.7.0",
  gitleaks: "8.30.1",
  semgrep: "1.182.0",
  syft: "1.55.0",
};

describe("security-tools.mjs — detection", () => {
  it("checks every arm's tool without writing or spawning an installer", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const marker = join(temp(t), "marker");
    const cwd = project(t);

    const result = run(["--check", "--project", cwd], {
      env: { PATH: bin, MARKER: marker },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.body, "a JSON report on stdout");
    assert.equal(result.body.ok, true);
    for (const arm of ["dependency-audit", "secret-scan", "sast"]) {
      assert.ok(
        result.body.tools.some((tool) => tool.arm === arm),
        `the report covers the ${arm} arm`,
      );
    }
    assert.equal(existsSync(marker), false, "a check never runs a package manager");
  });

  it("reports a missing tool with its install command and installs nothing", (t) => {
    const bin = temp(t, "tp-empty-bin-");
    const marker = join(temp(t), "marker");
    const cwd = project(t);

    const result = run(["--check", "--project", cwd], {
      env: { PATH: bin, MARKER: marker },
    });

    assert.equal(result.status, 1, "a missing required tool is a failed check");
    const gitleaks = result.body.tools.find((tool) => tool.id === "gitleaks");
    assert.equal(gitleaks.state, "missing");
    assert.match(gitleaks.install ?? "", /install gitleaks/);
    assert.equal(existsSync(marker), false);
  });

  it("reports an outdated tool against its floor with the upgrade command", (t) => {
    const bin = fakeBin(t, { ...ALL_OK, gitleaks: "8.20.0" });

    const result = run(["--check", "--project", project(t)], {
      env: { PATH: bin, MARKER: join(temp(t), "marker") },
    });

    assert.equal(result.status, 1, "an installed-but-old tool is surfaced");
    const gitleaks = result.body.tools.find((tool) => tool.id === "gitleaks");
    assert.equal(gitleaks.state, "update-available");
    assert.equal(gitleaks.version, "8.20.0");
    assert.match(gitleaks.upgrade ?? "", /upgrade gitleaks/);
  });

  it("reads PATH directly, so a bin-only PATH still works", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const result = run(["--check", "--project", project(t)], {
      env: { PATH: bin },
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it("selects CodeQL for a GitHub project and Semgrep otherwise", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const github = project(t, "https://github.com/acme/repo.git");
    const other = project(t, "https://gitlab.com/acme/repo.git");

    const gh = run(["--check", "--project", github], { env: { PATH: bin } });
    const gl = run(["--check", "--project", other], { env: { PATH: bin } });

    assert.equal(gh.body.host.github, true);
    assert.ok(gh.body.tools.some((tool) => tool.arm === "sast" && tool.id === "codeql"));
    assert.equal(gl.body.host.github, false);
    assert.ok(gl.body.tools.some((tool) => tool.arm === "sast" && tool.id === "semgrep"));
  });

  it("lets --host override what the remote says", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const result = run(["--check", "--host", "other", "--project", project(t, "https://github.com/acme/repo.git")], {
      env: { PATH: bin },
    });
    assert.ok(result.body.tools.some((tool) => tool.arm === "sast" && tool.id === "semgrep"));
  });
});

describe("security-tools.mjs — actions", () => {
  it("prints what it would do under --dry-run and executes nothing", (t) => {
    const bin = fakeBin(t, {});
    fakeManager(t, bin);
    const marker = join(temp(t), "marker");

    const result = run(["--install", "--dry-run", "--project", project(t)], {
      env: { PATH: bin, MARKER: marker },
    });

    assert.equal(result.status, 0, "a dry run reports its plan without failing");
    assert.ok(result.body.actions.length > 0);
    for (const action of result.body.actions) {
      assert.match(action.action, /^would-/);
      assert.equal(action.executed, false);
    }
    assert.equal(existsSync(marker), false, "a dry run executes nothing");
  });

  it("installs only the named tool, only with --install", (t) => {
    const bin = fakeBin(t, { ...ALL_OK, gitleaks: "" });
    rmSync(join(bin, "gitleaks"));
    fakeManager(t, bin);
    const marker = join(temp(t), "marker");

    const result = run(["--install", "--tool", "gitleaks", "--project", project(t)], {
      env: { PATH: bin, MARKER: marker },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
    assert.deepEqual(calls, ["install gitleaks"]);
  });

  it("exits 3 when an action is needed and no supported manager exists", (t) => {
    const bin = fakeBin(t, {});

    const result = run(["--install", "--project", project(t)], { env: { PATH: bin } });

    assert.equal(result.status, 3);
    assert.match(result.stderr, /github\.com|no supported package manager/i);
  });
});

describe("security-tools.mjs — the matrix stays honest", () => {
  it("ships free tools with a documented floor and a matching reference", () => {
    const matrix = JSON.parse(readFileSync(MATRIX, "utf8"));
    const reference = readFileSync(REFERENCE, "utf8");

    assert.equal(matrix.version, 1);
    for (const [id, tool] of Object.entries(matrix.tools)) {
      assert.match(tool.repo, /^https:\/\/github\.com\//, `${id} names its GitHub source`);
      assert.ok(tool.license, `${id} names its license`);
      assert.equal(tool.free, true, `${id} must be free to use`);
      assert.match(tool.minVersion, /^\d+\.\d+\.\d+$/, `${id} records a version floor`);
      assert.ok(reference.includes(tool.repo), `${id}'s repo is documented in the reference`);
    }
    for (const [arm, entry] of Object.entries(matrix.arms)) {
      for (const id of [entry.default, entry.github, entry.other].filter(Boolean)) {
        assert.ok(matrix.tools[id], `${arm} names a tool the matrix defines (${id})`);
      }
    }
  });

  it("never invokes a shell", () => {
    const source = readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(source, /\bexecSync\b|\bexecFileSync\b/);
    assert.doesNotMatch(source, /shell:\s*true/);
    assert.doesNotMatch(source, /\bnpx\b/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  });
});
