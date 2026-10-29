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

/** The same project, plus CI files written at their repo-relative paths. */
function projectWithCi(t, files = {}, remote = null) {
  const dir = project(t, remote);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
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

describe("security-tools.mjs — CI coverage", () => {
  it("reports no pipeline and no gap when the project has none", (t) => {
    const bin = fakeBin(t, ALL_OK);

    const result = run(["--check", "--project", project(t)], { env: { PATH: bin } });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.body.ci.detected, false);
    assert.equal(result.body.ci.provider, "none");
    assert.deepEqual(result.body.ci.missing, []);
    assert.equal(result.body.ci.ok, true);
    for (const arm of Object.values(result.body.ci.arms)) assert.equal(arm.state, "absent");
  });

  it("marks every required arm missing in a pipeline that runs no scanner", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, {
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n",
    });

    const result = run(["--check", "--project", cwd], { env: { PATH: bin } });

    assert.equal(result.status, 0, "a CI gap does not fail the local-tool check");
    assert.equal(result.body.ci.provider, "github-actions");
    assert.equal(result.body.ci.writable, true);
    assert.deepEqual(result.body.ci.missing, ["dependency-audit", "secret-scan", "sast"]);
  });

  it("leaves a covered arm alone and records its evidence", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, {
      ".github/workflows/security.yml": [
        "jobs:",
        "  audit:",
        "    steps:",
        "      - uses: google/osv-scanner-action/osv-scanner-action@v2",
        "  secrets:",
        "    steps:",
        "      - run: gitleaks git --redact",
        "",
      ].join("\n"),
    });

    const result = run(["--check", "--project", cwd], { env: { PATH: bin } });

    assert.equal(result.body.ci.arms["dependency-audit"].state, "covered");
    assert.equal(result.body.ci.arms["secret-scan"].state, "covered");
    assert.deepEqual(result.body.ci.arms["secret-scan"].evidence, [
      { file: ".github/workflows/security.yml", line: 7 },
    ]);
    assert.deepEqual(result.body.ci.missing, ["sast"], "only the uncovered arm is missing");
  });

  it("shows the missing arms as new files under --ci-plan and writes nothing", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, {
      ".github/workflows/security.yml": "jobs:\n  secrets:\n    steps:\n      - run: gitleaks git --redact\n",
    });

    const result = run(["--ci-plan", "--project", cwd], { env: { PATH: bin } });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.body.ci.proposed.map((entry) => entry.target),
      [".github/workflows/security-dependency-audit.yml", ".github/workflows/security-sast.yml"],
    );
    for (const entry of result.body.ci.proposed) {
      assert.equal(entry.action, "create");
      assert.match(entry.diff, /^--- \/dev\/null$/m);
    }
    assert.equal(existsSync(join(cwd, ".github/workflows/security-sast.yml")), false);
  });

  it("writes a self-contained, pinned workflow for a named arm", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, {
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n",
    });

    const result = run(["--ci-write", "--ci-arm", "sast", "--project", cwd], { env: { PATH: bin } });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.body.ci.actions.map((entry) => entry.action), ["written"]);
    const text = readFileSync(join(cwd, ".github/workflows/security-sast.yml"), "utf8");
    assert.match(text, /^permissions:$/m);
    assert.match(text, /security-events: write/);
    assert.match(text, /github\/codeql-action\/init@[0-9a-f]{40} # v3/);
    assert.doesNotMatch(text, /pull_request_target/);
    assert.doesNotMatch(text, /scan-gate\.mjs/);
    assert.equal(
      existsSync(join(cwd, ".github/workflows/security-dependency-audit.yml")),
      false,
      "an unnamed arm is not written",
    );
  });

  it("refuses to overwrite a workflow that exists with different content", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const target = ".github/workflows/security-sast.yml";
    const cwd = projectWithCi(t, { [target]: "name: mine\n" });

    const result = run(["--ci-write", "--ci-arm", "sast", "--project", cwd], { env: { PATH: bin } });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /different content|conflict/i);
    assert.equal(readFileSync(join(cwd, target), "utf8"), "name: mine\n", "nothing was overwritten");
  });

  it("is idempotent: a second run writes nothing and leaves the file untouched", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, {
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n",
    });
    const first = run(["--ci-write", "--ci-arm", "sast", "--project", cwd], { env: { PATH: bin } });
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = readFileSync(join(cwd, ".github/workflows/security-sast.yml"), "utf8");

    const second = run(["--ci-write", "--ci-arm", "sast", "--project", cwd], { env: { PATH: bin } });

    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(second.body.ci.actions, [], "the arm is covered now, so nothing is proposed");
    assert.equal(second.body.ci.arms.sast.state, "covered");
    assert.equal(readFileSync(join(cwd, ".github/workflows/security-sast.yml"), "utf8"), afterFirst);
  });

  it("prints a snippet for a non-GitHub pipeline and refuses to write it", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, { ".gitlab-ci.yml": "test:\n  script: npm test\n" });

    const plan = run(["--ci-plan", "--project", cwd], { env: { PATH: bin } });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(plan.body.ci.provider, "gitlab");
    assert.equal(plan.body.ci.writable, false);
    assert.deepEqual(plan.body.ci.proposed, []);
    assert.match(plan.body.ci.snippets.find((entry) => entry.arm === "sast").command, /semgrep/);

    const write = run(["--ci-write", "--project", cwd], { env: { PATH: bin } });
    assert.equal(write.status, 1);
    assert.match(write.body.ci.error, /cannot write a gitlab pipeline/);
    assert.match(write.body.ci.error, /compose the addition/, "the skill composes it; the script does not");
    assert.equal(existsSync(join(cwd, ".github")), false, "no file is created for another provider");
  });

  it("reports an unrecognised pipeline as unknown instead of guessing", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, { ".cirrus.yml": "task:\n  script: npm test\n" });

    const result = run(["--check", "--project", cwd], { env: { PATH: bin } });

    assert.equal(result.status, 0);
    assert.equal(result.body.ci.provider, "unknown");
    assert.deepEqual(result.body.ci.missing, []);
    assert.ok(result.body.ci.unknown.includes(".cirrus.yml"));
    for (const arm of Object.values(result.body.ci.arms)) assert.equal(arm.state, "unknown");
  });

  it("keeps a CI gap out of the local-tool exit code", (t) => {
    const bin = fakeBin(t, ALL_OK);
    const cwd = projectWithCi(t, { ".github/workflows/ci.yml": "on: push\n" });
    assert.equal(run(["--check", "--project", cwd], { env: { PATH: bin } }).status, 0);

    const emptyBin = temp(t, "tp-empty-bin-");
    const failing = run(["--check", "--project", cwd], { env: { PATH: emptyBin } });
    assert.equal(failing.status, 1, "a missing local tool still fails the check");
    assert.equal(failing.body.ok, false);
  });

  it("rejects an arm the matrix does not define", (t) => {
    const result = run(["--ci-plan", "--ci-arm", "nope", "--project", project(t)], {
      env: { PATH: fakeBin(t, ALL_OK) },
    });
    assert.equal(result.status, 2);
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

  it("gives every arm CI tokens, a workflow asset, and every tool a CI command", () => {
    const matrix = JSON.parse(readFileSync(MATRIX, "utf8"));
    const dir = join(ROOT, "skills", "setup-meerkat", "assets", "security");
    for (const [arm, entry] of Object.entries(matrix.arms)) {
      assert.ok(
        Array.isArray(entry.ciMatch) && entry.ciMatch.length > 0,
        `${arm} names the tokens its CI coverage is judged by`,
      );
      assert.match(entry.ciAsset ?? "", /^github\//, `${arm} ships a GitHub workflow asset`);
      assert.ok(existsSync(join(dir, entry.ciAsset)), `${arm}'s asset ${entry.ciAsset} exists`);
    }
    for (const [id, tool] of Object.entries(matrix.tools)) {
      assert.ok(
        tool.ciCommand === null || typeof tool.ciCommand === "string",
        `${id} records its CI snippet command, or null when it has none`,
      );
    }
  });

  it("ships workflows pinned, least-privilege and free of repo-local scripts", () => {
    const dir = join(ROOT, "skills", "setup-meerkat", "assets", "security", "github");
    for (const name of ["dependency-audit.yml", "secret-scan.yml", "sast.yml", "sbom.yml"]) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.match(text, /^permissions:\n  contents: read$/m, `${name} is least privilege`);
      assert.match(text, /cron:/, `${name} runs on a schedule`);
      assert.doesNotMatch(text, /pull_request_target/, `${name} never uses pull_request_target`);
      assert.doesNotMatch(text, /scan-gate\.mjs/, `${name} depends on no repo-local script`);
      for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        assert.match(match[1], /@[0-9a-f]{40}$/, `${name}: ${match[1]} is pinned to a commit`);
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
