/**
 * Containerized verify/deploy skeleton tests.
 *
 * Three layers of coverage:
 *   1. pure logic in `scripts/verify/lib/**` (mini-yaml, profiles, docker-plan)
 *   2. an end-to-end run of `runProfiles` against a throwaway `MEERKAT_TASKPANEL_TARGET_HOME`
 *   3. static assertions on the container artifacts (Dockerfile, compose, profiles,
 *      .dockerignore, CI workflow)
 *
 * Deliberately does NOT bind `docker/serve-skeleton.mjs` to a port — that would leak a
 * listening socket into the test run. The server is covered by syntax + static checks.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { MiniYamlError, parseMiniYaml } from "../scripts/verify/lib/mini-yaml.mjs";
import {
  PROFILE_HOSTS,
  REQUIRED_PROFILE_FIELDS,
  buildChecks,
  loadProfiles,
  readFrontmatterField,
  runProfiles,
} from "../scripts/verify/lib/profiles.mjs";
import {
  buildArgs,
  composeDownArgs,
  composeFile,
  composeProjectName,
  composePsArgs,
  composeUpArgs,
  healthInspectArgs,
  imageTag,
  runVerifyInContainerArgs,
} from "../scripts/verify/lib/docker-plan.mjs";
import { parseBaseImages, pullFlagFor, resolvePullFlag } from "../scripts/verify/lib/base-image.mjs";
import { SKILL_NAME, VERSION } from "../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Temp dirs created by these tests, removed in the `after` hook. */
const tempDirs = [];

async function makeTempDir(prefix = "meerkat-taskpanel-docker-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function read(relPath) {
  return readFile(join(ROOT, relPath), "utf8");
}

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mini-yaml
// ---------------------------------------------------------------------------

describe("mini-yaml", () => {
  it("returns an empty object for empty text", () => {
    assert.deepEqual(parseMiniYaml(""), {});
    assert.deepEqual(parseMiniYaml("\n\n  \n"), {});
  });

  it("skips blank lines and # comments", () => {
    const doc = ["# profile for claude", "", "host: claude", "   # indented comment", "label: Claude Code", ""].join("\n");
    assert.deepEqual(parseMiniYaml(doc), { host: "claude", label: "Claude Code" });
  });

  it("trims whitespace around key and value", () => {
    assert.deepEqual(parseMiniYaml("   host   :    claude   "), { host: "claude" });
    assert.deepEqual(parseMiniYaml("key:value"), { key: "value" });
  });

  it("strips single and double quotes", () => {
    assert.deepEqual(parseMiniYaml(`a: "quoted value"\nb: 'other value'`), {
      a: "quoted value",
      b: "other value",
    });
  });

  it("keeps a lone quote character as a literal value", () => {
    assert.deepEqual(parseMiniYaml(`a: "unterminated`), { a: `"unterminated` });
  });

  it("lets a later duplicate key override an earlier one", () => {
    assert.deepEqual(parseMiniYaml("host: claude\nhost: openclaw"), { host: "openclaw" });
  });

  it("keeps colons that appear inside a value", () => {
    assert.deepEqual(parseMiniYaml("url: http://127.0.0.1:9527/health"), {
      url: "http://127.0.0.1:9527/health",
    });
  });

  it("throws a MiniYamlError carrying the line number for an illegal line", () => {
    assert.throws(
      () => parseMiniYaml("host: claude\nnot a mapping\n"),
      (err) => {
        assert.ok(err instanceof MiniYamlError, "expected a MiniYamlError");
        assert.equal(err.line, 2);
        assert.match(err.message, /line 2/);
        return true;
      },
    );
  });

  it("throws on a line that is only a colon-comment or an empty key", () => {
    assert.throws(() => parseMiniYaml("  : value"), MiniYamlError);
  });
});

// ---------------------------------------------------------------------------
// profiles — loading and validation
// ---------------------------------------------------------------------------

describe("profiles: loadProfiles", () => {
  it("parses every shipped profile with the expected fields", async () => {
    const { hosts, profiles, errors } = await loadProfiles(join(ROOT, "docker", "profiles"));

    assert.deepEqual(errors, []);
    assert.deepEqual(hosts.slice().sort(), [...PROFILE_HOSTS].sort());

    const expected = {
      claude: { dir: ".claude/skills/meerkat-taskpanel", installer: "scripts/install/claude.sh" },
      openclaw: { dir: ".openclaw/skills/meerkat-taskpanel", installer: "scripts/install/openclaw.sh" },
      codex: { dir: ".codex/skills/meerkat-taskpanel", installer: "scripts/install/codex.sh" },
      pi: { dir: ".agents/skills/meerkat-taskpanel", installer: "scripts/install/pi.sh" },
      opencode: { dir: ".config/opencode/skills/meerkat-taskpanel", installer: "scripts/install/opencode.sh" },
      cursor: { dir: ".cursor/skills/meerkat-taskpanel", installer: "scripts/install/cursor.sh" },
    };

    for (const host of PROFILE_HOSTS) {
      const profile = profiles[host];
      assert.ok(profile, `missing profile for ${host}`);
      assert.equal(profile.host, host, `${host}: host must match the file name`);
      assert.equal(profile.target_dir, expected[host].dir, `${host}: target_dir`);
      assert.equal(profile.installer, expected[host].installer, `${host}: installer`);
      assert.equal(profile.skill_entry, "SKILL.md", `${host}: skill_entry`);
      assert.equal(profile.wrapper, "scripts/run.mjs", `${host}: wrapper`);
      assert.ok(profile.label.length > 0, `${host}: label must be non-empty`);
    }
  });

  it("reports missing profile files in errors", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "claude.yml"),
      "host: claude\nlabel: Claude Code\ninstaller: scripts/install/claude.sh\ntarget_dir: .claude/skills/meerkat-taskpanel\nskill_entry: SKILL.md\nwrapper: scripts/run.mjs\n",
    );

    const { errors } = await loadProfiles(dir);
    assert.ok(errors.length > 0, "expected errors for the three missing profiles");
    assert.ok(
      errors.some((e) => e.includes("openclaw")),
      `expected an error naming openclaw, got: ${errors.join(" | ")}`,
    );
  });

  it("reports a host/file name mismatch and missing fields", async () => {
    const dir = await makeTempDir();
    const base = "label: X\ninstaller: scripts/install/claude.sh\ntarget_dir: .claude/skills/meerkat-taskpanel\nskill_entry: SKILL.md\nwrapper: scripts/run.mjs\n";
    await writeFile(join(dir, "claude.yml"), `host: openclaw\n${base}`);
    await writeFile(join(dir, "openclaw.yml"), "host: openclaw\nlabel: OpenClaw\n");
    await writeFile(join(dir, "codex.yml"), `host: codex\n${base}`);
    await writeFile(join(dir, "pi.yml"), `host: pi\n${base}`);

    const { errors } = await loadProfiles(dir);
    assert.ok(errors.some((e) => /claude/.test(e) && /host/.test(e)), `expected host mismatch error: ${errors.join(" | ")}`);
    assert.ok(errors.some((e) => /openclaw/.test(e) && /wrapper/.test(e)), `expected missing field error: ${errors.join(" | ")}`);
  });

  it("surfaces a YAML syntax error instead of throwing", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "claude.yml"), "host claude\n");
    const { errors } = await loadProfiles(dir);
    assert.ok(errors.some((e) => /line 1/.test(e)), `expected a line-numbered parse error: ${errors.join(" | ")}`);
  });

  it("rejects a profile file for an unknown host", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "emacs.yml"), "host: emacs\n");
    const { errors } = await loadProfiles(dir);
    assert.ok(errors.some((e) => e.includes("unknown profile: emacs")), `expected an unknown-profile error: ${errors.join(" | ")}`);
  });

  it("reports an unreadable profiles directory instead of throwing", async () => {
    const { profiles, hosts, errors } = await loadProfiles(join(ROOT, "docker", "profiles", "does-not-exist"));
    assert.deepEqual(profiles, {});
    assert.deepEqual(hosts, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not readable/);
  });
});

describe("profiles: readFrontmatterField", () => {
  it("reads a field from a leading frontmatter block, stripping quotes", () => {
    assert.equal(readFrontmatterField("---\nname: meerkat-taskpanel\n---\n\n# Body\n", "name"), "meerkat-taskpanel");
    assert.equal(readFrontmatterField('---\nname: "meerkat-taskpanel"\n---\n', "name"), "meerkat-taskpanel");
  });

  it("returns null for a missing block, a missing field, or a non-mapping line", () => {
    assert.equal(readFrontmatterField("# no frontmatter\nname: meerkat-taskpanel\n", "name"), null);
    assert.equal(readFrontmatterField("---\nother: x\n---\n", "name"), null);
    assert.equal(readFrontmatterField("---\njust a heading\nname: meerkat-taskpanel\n---\n", "name"), "meerkat-taskpanel");
  });
});

describe("profiles: buildChecks", () => {
  it("derives the destination paths and installer command from an injected home", async () => {
    const { profiles } = await loadProfiles(join(ROOT, "docker", "profiles"));
    const checks = buildChecks(profiles.claude, { home: "/tmp/meerkat-taskpanel-home", root: "/repo" });

    assert.equal(checks.dest, join("/tmp/meerkat-taskpanel-home", ".claude/skills/meerkat-taskpanel"));
    assert.equal(checks.entryPath, join(checks.dest, "SKILL.md"));
    assert.equal(checks.skillMdPath, join(checks.dest, "SKILL.md"));
    assert.equal(checks.wrapperPath, join(checks.dest, "scripts/run.mjs"));

    assert.equal(checks.install.command, "bash");
    assert.equal(checks.install.args[0], join("/repo", "scripts/install/claude.sh"));
    assert.equal(checks.install.env.MEERKAT_TASKPANEL_TARGET_HOME, "/tmp/meerkat-taskpanel-home");
  });

  it("emits the required assertions", async () => {
    const { profiles } = await loadProfiles(join(ROOT, "docker", "profiles"));
    for (const host of PROFILE_HOSTS) {
      const checks = buildChecks(profiles[host], { home: "/tmp/h", root: "/repo" });
      const kinds = checks.assertions.map((a) => a.kind);
      assert.ok(kinds.includes("pathExists"), `${host}: pathExists`);
      assert.ok(kinds.includes("skillFrontmatter"), `${host}: skillFrontmatter`);
      assert.ok(kinds.includes("wrapperVersion"), `${host}: wrapperVersion`);

      const frontmatter = checks.assertions.find((a) => a.kind === "skillFrontmatter");
      assert.equal(frontmatter.field, "name");
      assert.equal(frontmatter.value, SKILL_NAME);

      const version = checks.assertions.find((a) => a.kind === "wrapperVersion");
      assert.equal(version.command, process.execPath);
      assert.deepEqual(version.args, [checks.wrapperPath, "--version"]);
      assert.equal(version.expectedStdout, VERSION);
    }
  });

  it("defaults root and home without touching the filesystem", async () => {
    const { profiles } = await loadProfiles(join(ROOT, "docker", "profiles"));
    const checks = buildChecks(profiles.pi);
    assert.ok(checks.dest.startsWith(tmpdir()), `expected a tmp home, got ${checks.dest}`);
    assert.equal(checks.install.args[0], join(ROOT, "scripts/install/pi.sh"));
  });

  it("is pure: repeated calls with the same input are deep-equal", async () => {
    const { profiles } = await loadProfiles(join(ROOT, "docker", "profiles"));
    const opts = { home: "/tmp/pure", root: "/repo" };
    assert.deepEqual(buildChecks(profiles.codex, opts), buildChecks(profiles.codex, opts));
  });
});

describe("profiles: runProfiles", () => {
  it("installs every host into a throwaway home and verifies it", async () => {
    const home = await makeTempDir("meerkat-taskpanel-home-");
    const result = await runProfiles({
      home,
      profilesDir: join(ROOT, "docker", "profiles"),
      root: ROOT,
      quiet: true,
    });

    assert.equal(result.ok, true, `runProfiles failed: ${JSON.stringify(result.results, null, 2)}`);
    assert.equal(result.results.length, PROFILE_HOSTS.length);

    for (const entry of result.results) {
      assert.equal(entry.ok, true, `${entry.host} failed: ${entry.error ?? ""}`);
      assert.ok(existsSync(join(home, entry.profile.target_dir, "SKILL.md")), `${entry.host}: SKILL.md installed`);
    }

    // Every install was confined to the injected home.
    for (const entry of result.results) {
      assert.equal(entry.home, home);
      assert.ok(entry.dest.startsWith(home), `${entry.host}: dest escaped the injected home`);
    }
  });

  it("reports failure when a profile points at a missing installer", async () => {
    const home = await makeTempDir("meerkat-taskpanel-home-");
    const dir = await makeTempDir();
    const base = "target_dir: .claude/skills/meerkat-taskpanel\nskill_entry: SKILL.md\nwrapper: scripts/run.mjs\n";
    await writeFile(join(dir, "claude.yml"), `host: claude\nlabel: Claude Code\ninstaller: scripts/install/does-not-exist.sh\n${base}`);
    await writeFile(join(dir, "openclaw.yml"), `host: openclaw\nlabel: OpenClaw\ninstaller: scripts/install/does-not-exist.sh\n${base}`);
    await writeFile(join(dir, "codex.yml"), `host: codex\nlabel: Codex\ninstaller: scripts/install/does-not-exist.sh\n${base}`);
    await writeFile(join(dir, "pi.yml"), `host: pi\nlabel: Pi\ninstaller: scripts/install/does-not-exist.sh\n${base}`);
    await writeFile(join(dir, "opencode.yml"), `host: opencode\nlabel: OpenCode\ninstaller: scripts/install/does-not-exist.sh\n${base}`);
    await writeFile(join(dir, "cursor.yml"), `host: cursor\nlabel: Cursor\ninstaller: scripts/install/does-not-exist.sh\n${base}`);

    const result = await runProfiles({ home, profilesDir: dir, root: ROOT, quiet: true });
    assert.equal(result.ok, false);
    assert.ok(result.results.some((r) => r.ok === false));
  });
});

// ---------------------------------------------------------------------------
// base image preflight — cached first, explicit pull only when absent
//
// The base image (`node:22-bookworm-slim`) is the *only* external artefact the
// image build needs. A build that silently re-pulls it burns network and time on
// every verification run, and on a host whose daemon proxy is broken it turns a
// green gate into a network failure. The policy is therefore:
//
//   1. inspect the local image store — present means no network is touched;
//   2. missing means exactly one explicit `docker pull`, never an implicit one;
//   3. `MEERKAT_TASKPANEL_OFFLINE=1` refuses even that one pull;
//   4. the build itself carries the builder's no-pull flag.
// ---------------------------------------------------------------------------

describe("base-image: parseBaseImages", () => {
  it("returns the external FROM refs, deduped, in file order", () => {
    const text = [
      "# a comment",
      "FROM node:22-bookworm-slim AS webbuild",
      "RUN echo hi",
      "FROM node:22-bookworm-slim",
    ].join("\n");
    assert.deepEqual(parseBaseImages(text), ["node:22-bookworm-slim"]);
  });

  it("strips --platform flags and ignores a stage alias as a source", () => {
    const text = [
      "FROM --platform=linux/amd64 node:22-bookworm-slim AS base",
      "FROM base AS built",
      "FROM --platform=$BUILDPLATFORM scratch",
    ].join("\n");
    assert.deepEqual(parseBaseImages(text), ["node:22-bookworm-slim"]);
  });

  it("ignores blank lines, comments and a trailing comment", () => {
    const text = ["", "  # FROM debian:12", "FROM node:22-bookworm-slim # pin later", ""].join("\n");
    assert.deepEqual(parseBaseImages(text), ["node:22-bookworm-slim"]);
  });

  it("is case-insensitive on the FROM keyword", () => {
    assert.deepEqual(parseBaseImages("from node:22-bookworm-slim"), ["node:22-bookworm-slim"]);
  });

  it("returns an empty list when the file has no FROM", () => {
    assert.deepEqual(parseBaseImages("# empty\n"), []);
  });
});

describe("base-image: pullFlagFor", () => {
  it("uses --pull=false on the legacy builder (boolean flag)", () => {
    const help = "      --pull                    Always attempt to pull a newer version of\n                                the image\n";
    assert.equal(pullFlagFor(help), "--pull=false");
  });

  it("uses --pull=never on BuildKit (policy-string flag)", () => {
    const help = '      --pull string             Pull image before building (default "missing")\n';
    assert.equal(pullFlagFor(help), "--pull=never");
  });

  it("defaults to the legacy form when the help text is unrecognised", () => {
    assert.equal(pullFlagFor(""), "--pull=false");
  });
});

describe("base-image: resolvePullFlag", () => {
  it("probes `docker build --help` and maps the flag form", () => {
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '      --pull string             Pull image before building (default "missing")\n', stderr: "" };
    };
    assert.equal(resolvePullFlag({ run }), "--pull=never");
    assert.deepEqual(calls, [["docker", "build", "--help"]]);
  });

  it("omits the flag when the probe fails (the preflight is still the guarantee)", () => {
    const run = () => ({ status: 1, stdout: "", stderr: "boom", error: new Error("boom") });
    assert.equal(resolvePullFlag({ run }), null);
  });
});

// ---------------------------------------------------------------------------
// docker-plan — pure argument builders
// ---------------------------------------------------------------------------

describe("docker-plan", () => {
  it("uses the documented image tag", () => {
    assert.equal(imageTag(), "meerkat-taskpanel:verify");
  });

  it("builds a docker build command pinned to docker/Dockerfile", () => {
    const args = buildArgs(".");
    assert.equal(args[0], "build");
    const fileIndex = args.indexOf("-f");
    assert.ok(fileIndex !== -1, "expected -f");
    assert.equal(args[fileIndex + 1], "docker/Dockerfile");
    assert.ok(args.includes(imageTag()), "expected the image tag");
    assert.equal(args.at(-1), ".", "build context must be the repo root");
  });

  it("carries the builder's no-pull flag when one is resolved", () => {
    const args = buildArgs(".", { pullFlag: "--pull=never" });
    assert.ok(args.includes("--pull=never"), "the build must never pull a base image implicitly");
    assert.equal(args.at(-1), ".", "the context stays last");

    // Absent a resolved flag (probe failed), the argument shape is unchanged — the
    // preflight is still what keeps the build off the network.
    assert.ok(!buildArgs(".").some((a) => a.startsWith("--pull")));
  });

  it("builds a docker run command that is removed afterwards and runs the in-container script", () => {
    const args = runVerifyInContainerArgs();
    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"), "expected --rm");
    assert.ok(args.includes(imageTag()), "expected the image tag");
    assert.deepEqual(args.slice(-2), ["bash", "docker/verify-in-container.sh"]);
  });

  it("builds compose up/down commands against docker/docker-compose.yml", () => {
    assert.equal(composeFile(), "docker/docker-compose.yml");
    const project = composeProjectName("/somewhere/meerkat-taskpanel");

    const up = composeUpArgs(project);
    assert.equal(up[0], "compose");
    assert.deepEqual(up.slice(1, 3), ["-p", project], "the project is named, not derived from the directory");
    assert.ok(up.includes("-f"));
    assert.ok(up.includes(composeFile()));
    assert.ok(up.includes("up"));
    assert.ok(up.includes("-d"));

    const down = composeDownArgs(project);
    assert.equal(down[0], "compose");
    assert.deepEqual(down.slice(1, 3), ["-p", project]);
    assert.ok(down.includes(composeFile()));
    assert.ok(down.includes("down"));
    assert.ok(down.includes("-v"), "teardown must remove volumes");
  });

  it("names the compose project per checkout, so two worktrees cannot collide", () => {
    // `docker compose` derives the project from the **directory** when it is not
    // given, and every worktree has a directory called `docker/` — so two lanes
    // verifying at once shared the container name `docker-taskd-1`, and the second
    // one to start failed with "already in use" while the two teardowns fought over
    // it. The name is therefore derived from the checkout's absolute path.
    const a = composeProjectName("/Users/you/meerkat-taskpanel");
    const b = composeProjectName("/Users/you/meerkat-taskpanel-wt-other-lane");
    assert.notEqual(a, b, "two worktrees must not share a project");

    // ...and it is *stable* for one checkout, which is what makes an `up` and the
    // `down` that follows it agree — including when one of them is reached through
    // a path that is merely spelled differently.
    assert.equal(composeProjectName("/Users/you/meerkat-taskpanel"), a);
    assert.equal(composeProjectName("/Users/you/./meerkat-taskpanel"), a, "resolved first");

    // A compose project name must match `[a-z0-9][a-z0-9_-]*`, and a path does not.
    assert.match(a, /^[a-z0-9][a-z0-9_-]*$/);
    assert.ok(a.startsWith("meerkat-taskpanel-"), a);
  });

  it("names the project on `ps` too — the one whose omission would be silent", () => {
    // The healthcheck discovers the container through `compose ps -q <service>`
    // rather than by name. Against the wrong project that prints *nothing*, and the
    // gate would report "no container found for service" — a failure that looks
    // like a broken deploy and is really a naming slip.
    const project = composeProjectName("/somewhere/meerkat-taskpanel");
    const ps = composePsArgs(project, "taskd");
    assert.deepEqual(ps, ["compose", "-p", project, "-f", "docker/docker-compose.yml", "ps", "-q", "taskd"]);
  });

  it("refuses to build a compose command with no project", () => {
    // A default here would silently restore the collision the day a fourth caller
    // appears, so there is none.
    for (const build of [composeUpArgs, composeDownArgs]) {
      assert.throws(() => build(undefined), /compose project name is required/);
      assert.throws(() => build(""), /compose project name is required/);
    }
  });

  it("builds a health inspect command for a named container", () => {
    const args = healthInspectArgs("meerkat-taskpanel-taskd-1");
    assert.deepEqual(args.slice(0, 1), ["inspect"]);
    assert.ok(args.includes("meerkat-taskpanel-taskd-1"));
    assert.ok(args.some((a) => a.includes("Health.Status")), "expected a health status format");
  });

  it("returns fresh arrays so callers cannot mutate shared state", () => {
    assert.notEqual(buildArgs(), buildArgs());
  });
});

// ---------------------------------------------------------------------------
// scripts/verify/docker.mjs — orchestration error paths
//
// These drive the real orchestrator with a stubbed `docker` on PATH, so no Docker
// daemon is involved and no image is ever built or pulled.
// ---------------------------------------------------------------------------

/** Create a temp dir holding an executable `docker` stub; return a PATH with it first. */
async function stubDocker(script) {
  const dir = await makeTempDir("meerkat-taskpanel-stub-");
  const bin = join(dir, "docker");
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  const { chmod } = await import("node:fs/promises");
  await chmod(bin, 0o755);
  return { dir, path: `${dir}:${process.env.PATH}` };
}

function runOrchestrator(path, env = {}) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", "verify", "docker.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PATH: path, ...env },
    timeout: 60_000,
  });
}

describe("verify/docker.mjs (stubbed docker)", () => {
  it("exits 1 with a clear message when no daemon is reachable", async () => {
    const { path } = await stubDocker('echo "Cannot connect to the Docker daemon" >&2; exit 1');
    const res = runOrchestrator(path);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /cannot reach the Docker daemon/);
    assert.match(res.stderr, /Nothing was changed/);
    // It must not have tried to build anything.
    assert.doesNotMatch(res.stdout, /== docker build/);
  });

  it("reuses a cached base image and never pulls it", async () => {
    const { path } = await stubDocker(
      [
        'case "$1" in',
        '  version) echo "20.10.14"; exit 0;;',
        '  image) echo "sha256:deadbeef"; exit 0;;',
        '  build)',
        '    for a in "$@"; do',
        `      if [ "$a" = "--help" ]; then echo '      --pull string  Pull image before building (default "missing")'; exit 0; fi`,
        '    done',
        '    echo "build args: $*"; exit 1;;',
        'esac',
        'exit 1',
      ].join("\n"),
    );
    const res = runOrchestrator(path);

    assert.match(res.stdout, /PASS {2}base image preflight/);
    assert.match(res.stdout, /cached\s+node:22-bookworm-slim/);
    // The local store answered: no pull, and the build is told not to pull either.
    assert.doesNotMatch(res.stdout, /== docker pull/);
    assert.match(res.stdout, /--pull=never/, "BuildKit help must map to --pull=never");
    assert.match(res.stdout, /== docker build/);
  });

  it("pulls a missing base image exactly once, then builds", async () => {
    const { path } = await stubDocker(
      [
        'case "$1" in',
        '  version) echo "20.10.14"; exit 0;;',
        '  image) exit 1;;',
        '  pull)',
        '    [ "$2" = "node:22-bookworm-slim" ] || { echo "wrong ref: $2" >&2; exit 2; }',
        '    echo "pulled"; exit 0;;',
        '  build) echo "build args: $*"; exit 1;;',
        'esac',
        'exit 1',
      ].join("\n"),
    );
    const res = runOrchestrator(path);

    assert.match(res.stdout, /missing\s+node:22-bookworm-slim/);
    assert.match(res.stdout, /pulling once/);
    assert.match(res.stdout, /PASS {2}base image preflight/);
    // The preflight announces the pull once, and its success line proves the stub was
    // invoked with the Dockerfile's ref (the stub rejects any other).
    const pulls = res.stdout.match(/pulling once/g) ?? [];
    assert.equal(pulls.length, 1, "the network is touched at most once");
    assert.match(res.stdout, /pulled\s+node:22-bookworm-slim/);
    assert.match(res.stdout, /== docker build/);
  });

  it("refuses the one-time pull when MEERKAT_TASKPANEL_OFFLINE=1", async () => {
    const { path } = await stubDocker(
      [
        'case "$1" in',
        '  version) echo "20.10.14"; exit 0;;',
        '  image) exit 1;;',
        '  pull) echo "should not pull"; exit 0;;',
        '  build) echo "should not build"; exit 0;;',
        'esac',
        'exit 1',
      ].join("\n"),
    );
    const res = runOrchestrator(path, { MEERKAT_TASKPANEL_OFFLINE: "1" });

    assert.equal(res.status, 1);
    assert.match(res.stdout, /FAIL {2}base image preflight/);
    assert.match(res.stdout, /MEERKAT_TASKPANEL_OFFLINE=1/);
    assert.match(res.stdout, /docker load/);
    assert.doesNotMatch(res.stdout, /== docker pull/);
    assert.doesNotMatch(res.stdout, /== docker build/);
  });

  it("aborts after a failed build, skips compose, and reports a SUMMARY", async () => {
    const { path } = await stubDocker(
      [
        'case "$1" in',
        '  version) echo "20.10.14"; exit 0;;',
        '  image) echo "sha256:deadbeef"; exit 0;;',
        '  build) echo "stub build failed" >&2; exit 1;;',
        'esac',
        'exit 1',
      ].join("\n"),
    );
    const res = runOrchestrator(path);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /== SUMMARY ==/);
    assert.match(res.stdout, /FAIL {2}docker build/);
    // A failed build means the compose smoke test is never attempted.
    assert.doesNotMatch(res.stdout, /docker compose up/);
    assert.doesNotMatch(res.stdout, /docker compose .*down/);
  });

  it("fails the smoke test when the healthcheck never turns healthy, and still tears down", async () => {
    const { path } = await stubDocker(
      [
        'case "$1" in',
        '  version) echo "20.10.14"; exit 0;;',
        '  image) echo "sha256:deadbeef"; exit 0;;',
        '  build) echo "built"; exit 0;;',
        '  run) echo "suite ok"; exit 0;;',
        '  compose)',
        '    for a in "$@"; do',
        '      if [ "$a" = "ps" ]; then echo "abc123"; exit 0; fi',
        '      if [ "$a" = "down" ]; then echo "torn down"; exit 0; fi',
        '    done',
        '    echo "up ok"; exit 0;;',
        '  inspect) echo "starting"; exit 0;;',
        '  sleep) exit 0;;',
        'esac',
        'exit 1',
      ].join("\n"),
    );
    // The health budget is normally 60s; shrink it so the timeout path is fast.
    const res = spawnSync(process.execPath, [join(ROOT, "scripts", "verify", "docker.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: path, MEERKAT_TASKPANEL_HEALTH_TIMEOUT_MS: "400" },
      timeout: 60_000,
    });

    assert.equal(res.status, 1);
    assert.match(res.stdout, /healthcheck/);
    assert.match(res.stdout, /FAIL {2}healthcheck/);
    assert.match(res.stdout, /compose .*down -v/, "teardown must still run");
  });
});

// ---------------------------------------------------------------------------
// Static assertions on the container artifacts
// ---------------------------------------------------------------------------

describe("static: Dockerfile", () => {
  it("is based on node:22, pins TZ, runs as non-root and exposes 9527", async () => {
    const text = await read("docker/Dockerfile");
    assert.match(text, /^FROM node:22/m);
    assert.match(text, /ENV TZ=Asia\/Shanghai/);
    assert.match(text, /ENV TASKD_HOST=0\.0\.0\.0/);
    assert.match(text, /ENV TASKD_PORT=9527/);
    assert.match(text, /WORKDIR \/app/);
    assert.match(text, /COPY \. \./);
    assert.match(text, /^USER node$/m);
    assert.match(text, /mkdir -p \/app\/\.data/);
    assert.match(text, /chown -R node:node/);
    assert.match(text, /EXPOSE 9527/);
    assert.match(text, /CMD \["node","src\/cli\/index\.mjs","--help"\]/);
  });

  it("keeps the runtime stage install-free and the committed cache path offline", async () => {
    const text = await read("docker/Dockerfile");

    // The runtime stage (stage 2) installs nothing from a package manager. The
    // offline-assembly constraint governs what the image *runs*, not the image's
    // frontend build stage.
    const runtimeStart = text.indexOf("# ── Stage 2: runtime");
    assert.notEqual(runtimeStart, -1, "expected a stage-2 runtime header");
    const runtimeStage = text.slice(runtimeStart);
    assert.doesNotMatch(
      runtimeStage,
      /apt-get|apt install|yum|apk add|npm (install|ci)\b/,
      "the runtime stage must install nothing from a package manager",
    );

    // F1-c (ruling O1, 2026-10-09): the repo COMMITS the offline npm cache, so a clean
    // checkout's `webbuild` stage always takes the offline path — the image builds with
    // NO network (`docker build --network=none` succeeds). If this ever goes missing the
    // guarantee is gone, so assert the cache is actually present.
    assert.ok(
      existsSync(join(ROOT, "web", ".vendor", "npm-cache")),
      "web/.vendor/npm-cache must be committed (F1-c: it is what makes the image build offline)",
    );

    const webbuildStage = text.slice(0, runtimeStart);

    // The guard keys on the committed cache directory and installs `--offline` from it —
    // `--offline` hard-fails rather than silently reaching the registry.
    assert.match(
      webbuildStage,
      /\[ -d web\/\.vendor\/npm-cache \]/,
      "the guard must test for the committed cache directory",
    );
    const offlineLine = webbuildStage.match(/npm ci --offline --cache \/app\/web\/\.vendor\/npm-cache[^\n]*/);
    assert.ok(offlineLine, "the cache-present branch must run `npm ci --offline` reading the committed cache");

    // Any *other* `npm ci` is the no-cache fallback, which is networked — it can only run
    // in a stripped checkout that deleted the committed cache. The Dockerfile comment must
    // say so: the offline branch is the committed configuration, and the fallback is not.
    const npmCiLines = webbuildStage.match(/npm ci[^\n]*/g) ?? [];
    if (npmCiLines.some((line) => !line.includes("--offline"))) {
      assert.match(
        text,
        /network/i,
        "a networked npm ci fallback (no --offline) must be documented in the Dockerfile comment",
      );
      assert.match(
        text,
        /stripped checkout/i,
        "the Dockerfile comment must state the networked fallback is not the committed configuration",
      );
    }
  });

  it("the committed npm cache covers every architecture the image is built on, not only its own", async () => {
    // F1-c makes the image build offline from the committed cache. That cache is produced
    // *inside a container*, so by construction it holds the architecture of whichever
    // container produced it — and the two places the image gets built disagree:
    // `check.yml`'s `docker` job runs on `ubuntu-latest` (x86_64) with no exemption, while
    // a developer on Apple Silicon builds linux/arm64.
    //
    // The shortfall does not announce itself as an install failure, which is what makes it
    // worth a test. `npm ci --offline` **succeeds** on the uncovered architecture: the
    // platform binaries are `optionalDependencies` and npm tolerates their absence. It
    // surfaces one step later, in `vite build`, where rolldown cannot load a native
    // binding and falls back to `@rolldown/binding-wasm32-wasi` — which a single-arch cache
    // does not hold either. The build then dies with "Cannot find native binding"
    // (measured on this tree), so the job that is meant to be the authoritative one fails
    // for a reason that has nothing to do with the change under test.
    //
    // Static read of the cacache index — no docker, no network, so this is a host-allowed
    // check that runs everywhere the suite runs.
    const indexRoot = join(ROOT, "web", ".vendor", "npm-cache", "_cacache", "index-v5");
    const entries = await readdir(indexRoot, { recursive: true, withFileTypes: true });
    const indexText = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          // `parentPath` is Node >= 22.12; `path` is what earlier 22.x carries.
          .map((entry) => readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8")),
      )
    ).join("\n");

    const required = [
      "@rolldown/binding-linux-arm64-gnu",
      "@rolldown/binding-linux-x64-gnu",
      "lightningcss-linux-arm64-gnu",
      "lightningcss-linux-x64-gnu",
      "@tailwindcss/oxide-linux-arm64-gnu",
      "@tailwindcss/oxide-linux-x64-gnu",
    ];
    for (const pkg of required) {
      assert.ok(
        indexText.includes(pkg),
        `the committed npm cache must carry ${pkg} — the image is built on linux/arm64 and linux/x64 alike`,
      );
    }

    // Non-vacuity: the reader that just proved six packages present must also be able to
    // report one absent, or it would pass on an empty cache.
    assert.equal(
      indexText.includes("@rolldown/binding-win32-x64-msvc"),
      false,
      "the cache holds only what the linux images need",
    );
  });
});

describe("static: .dockerignore", () => {
  it("exists and trims the build context", async () => {
    const text = await read(".dockerignore");
    for (const entry of [".git", "node_modules", "dist", "web/dist", ".data", "coverage", "*.tgz", "design", ".worktrees", ".DS_Store", ".env"]) {
      assert.ok(
        text.split("\n").map((l) => l.trim()).includes(entry),
        `.dockerignore should contain ${entry}`,
      );
    }
  });
});

describe("static: docker-compose.yml", () => {
  it("defines the taskd service, port, volume, command and /health healthcheck", async () => {
    const text = await read("docker/docker-compose.yml");
    assert.match(text, /taskd:/);
    assert.match(text, /image: meerkat-taskpanel:local/);
    assert.match(text, /dockerfile: docker\/Dockerfile/);
    assert.match(text, /TASKD_HOST[:=]\s*"?0\.0\.0\.0"?/);
    assert.match(text, /TASKD_PORT[:=]\s*"?9527"?/);
    assert.match(text, /9527:9527/);
    assert.match(text, /\.\.\/\.data:\/app\/\.data/);
    assert.match(text, /docker\/serve-skeleton\.mjs/);
    assert.match(text, /healthcheck:/);
    assert.match(text, /\/health/);
    assert.match(text, /interval:\s*5s/);
    assert.match(text, /timeout:\s*3s/);
    assert.match(text, /retries:\s*12/);
    assert.match(text, /start_period:\s*5s/);
    // Compose v2.4 compatibility: no top-level `version:` key.
    assert.doesNotMatch(text, /^version:/m);
  });
});

describe("static: the dev / manual-preview environment", () => {
  it("builds the Dockerfile's dev target and publishes Vite on 19527", async () => {
    const text = await read("docker/docker-compose.dev.yml");
    assert.match(text, /target:\s*dev/);
    assert.match(text, /19527:5173/);
    assert.match(text, /\.\.\/src:\/app\/src/, "backend sources are mounted for taskd's --watch");
    assert.match(text, /\.\.\/web\/src:\/app\/web\/src/);
    assert.match(text, /VITE_USE_POLLING/);
    assert.match(text, /TASKD_DATA_DIR/);
    // Compose v2.4 compatibility: no top-level `version:` key.
    assert.doesNotMatch(text, /^version:/m);
  });

  it("keeps the dev stage before the runtime stage, so a plain build still ships the runtime image", async () => {
    const text = await read("docker/Dockerfile");
    const dev = text.indexOf("FROM webbuild AS dev");
    const runtime = text.indexOf("# ── Stage 2: runtime");
    assert.notEqual(dev, -1, "expected a `FROM webbuild AS dev` stage");
    assert.notEqual(runtime, -1, "expected the stage-2 runtime marker");
    assert.ok(dev < runtime, "the dev stage must precede the runtime stage");
    // The shipping image's own CMD still ends the file.
    assert.match(text.slice(runtime), /CMD \["node","src\/cli\/index\.mjs","--help"\]/);
  });

  it("keeps the dev entry parseable and free of an install step", async () => {
    const path = join(ROOT, "docker", "dev-entry.mjs");
    assert.ok(existsSync(path), "docker/dev-entry.mjs must exist");
    const syntax = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `node --check failed: ${syntax.stderr}`);
    const text = await read("docker/dev-entry.mjs");
    assert.match(text, /src\/server\/main\.mjs/);
    assert.match(text, /--watch/, "the dev entry restarts taskd on backend changes");
    assert.match(text, /npm/, "the dev entry starts Vite through npm");
    assert.doesNotMatch(text, /npm ci|npm install/, "the dev entry must not install anything");
  });
});

describe("static: serve-skeleton", () => {
  it("exists, parses, and only serves /health", async () => {
    const path = join(ROOT, "docker", "serve-skeleton.mjs");
    assert.ok(existsSync(path), "docker/serve-skeleton.mjs must exist");

    const syntax = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `node --check failed: ${syntax.stderr}`);

    const text = await read("docker/serve-skeleton.mjs");
    assert.match(text, /\/health/);
    assert.match(text, /not_found/);
    assert.match(text, /"scaffold"/);
    assert.match(text, /TASKD_HOST/);
    assert.match(text, /TASKD_PORT/);
    assert.match(text, /SIGTERM/);
    assert.match(text, /node:http/);
    // It must declare itself a skeleton, not the M6 server.
    assert.match(text, /M0/);
    assert.match(text, /M6/);
  });
});

describe("static: verify-in-container.sh", () => {
  it("is valid bash and runs the full verification step list", async () => {
    const path = join(ROOT, "docker", "verify-in-container.sh");
    assert.ok(existsSync(path), "docker/verify-in-container.sh must exist");

    const syntax = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);

    const text = await read("docker/verify-in-container.sh");
    assert.match(text, /set -euo pipefail/);
    assert.match(text, /node --test/);
    assert.match(text, /npm run check/);
    assert.match(text, /install\.sh --target all --dry-run/);
    assert.match(text, /scripts\/verify\/profiles\.mjs/);
  });

  it("runs the install + first-run end-to-end, so local and CI cover the same ground", async () => {
    // The e2e used to be a separate `docker run` in CI only, which let
    // `npm run verify:docker` be green while CI was red. It belongs to this script, on a
    // line of its own (anchored, so a commented-out call does not satisfy the assertion).
    const text = await read("docker/verify-in-container.sh");
    assert.match(text, /^bash scripts\/verify\/install-e2e\.sh$/m);

    // ...and the CI job must not duplicate it as a second command either.
    const ci = await read(".github/workflows/check.yml");
    assert.doesNotMatch(
      ci,
      /run: docker run --rm meerkat-taskpanel:verify bash scripts\/verify\/install-e2e\.sh/,
      "the e2e must run via verify-in-container.sh, not as a separate CI step",
    );
  });
});

// ---------------------------------------------------------------------------
// static: install-e2e.sh identity
//
// The script used to act as one agent and assign the card to another, which the
// claim policy (`src/core/domain/claim.mjs`) refuses with `not_assignee` — the
// 061638 regression. One `AGENT_ID` must feed *both* the acting identity
// (`TASKCTL_AGENT`) and the card's `--assignee`, so the two can never drift.
// Every predicate is anchored to a whole, comment-free line, so neither a
// commented-out nor a partial edit can satisfy or trip it.
// ---------------------------------------------------------------------------

/** Problem list for install-e2e.sh's identity wiring; `[]` means same-source. */
function installE2eIdentityProblems(text) {
  // A line whose first non-whitespace character is `#` is a comment: it can
  // neither define nor use the identity, so drop it before matching.
  const active = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const problems = [];

  const defs = active.filter((line) => line.startsWith("AGENT_ID="));
  if (defs.length !== 1) {
    problems.push(`expected exactly one AGENT_ID definition, found ${defs.length}`);
  } else if (!/^AGENT_ID="[^"$]+"$/.test(defs[0])) {
    problems.push(`AGENT_ID must be one literal, not a reference: ${defs[0]}`);
  }

  const exports = active.filter((line) => line.startsWith("export TASKCTL_AGENT="));
  if (exports.length !== 1) {
    problems.push(`expected exactly one TASKCTL_AGENT export, found ${exports.length}`);
  } else if (exports[0] !== 'export TASKCTL_AGENT="$AGENT_ID"') {
    problems.push(`TASKCTL_AGENT must come from $AGENT_ID: ${exports[0]}`);
  }

  // The card's assignee must be the *same* source, so a divergent hardcoded
  // literal (`--assignee install-e2e`) is caught here — the mutation C case.
  const assignees = active.filter((line) => /(^|\s)--assignee\b/.test(line));
  if (assignees.length !== 1) {
    problems.push(`expected exactly one --assignee, found ${assignees.length}`);
  }
  for (const line of assignees) {
    if (!/^--assignee\s+"\$AGENT_ID"\)?"$/.test(line)) {
      problems.push(`--assignee must take $AGENT_ID, got: ${line}`);
    }
  }

  return problems;
}

describe("static: install-e2e.sh identity", () => {
  it("acts as the same agent it assigns the card to (one AGENT_ID source)", async () => {
    const text = await read("scripts/verify/install-e2e.sh");
    assert.deepEqual(installE2eIdentityProblems(text), []);
  });

  it("ignores commented-out lines when judging same-source", () => {
    const text = [
      '# --assignee "install-e2e"',
      "# export TASKCTL_AGENT=whatever",
      'AGENT_ID="bot"',
      'export TASKCTL_AGENT="$AGENT_ID"',
      '--assignee "$AGENT_ID")"',
    ].join("\n");
    assert.deepEqual(installE2eIdentityProblems(text), []);
  });

  it("goes red when the assignee drifts back to its own literal (mutation C)", async () => {
    const text = await read("scripts/verify/install-e2e.sh");
    // If the script is already mutated on disk the replace is a no-op and the
    // guard flags the file as-is — either way it must report the drift.
    const mutated = text.replace(/--assignee\s+"\$AGENT_ID"\)?"/, '--assignee "install-e2e"');

    const problems = installE2eIdentityProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes("--assignee")),
      `the guard must flag the divergent assignee, got: ${JSON.stringify(problems)}`,
    );
  });

  it("goes red when the actor stops coming from AGENT_ID", async () => {
    const text = await read("scripts/verify/install-e2e.sh");
    const mutated = text.replace('export TASKCTL_AGENT="$AGENT_ID"', 'export TASKCTL_AGENT="install-e2e"');

    const problems = installE2eIdentityProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes("TASKCTL_AGENT")),
      `the guard must flag the divergent actor, got: ${JSON.stringify(problems)}`,
    );
  });
});

describe("static: profiles and docs", () => {
  it("ships one profile per host", () => {
    for (const host of PROFILE_HOSTS) {
      assert.ok(existsSync(join(ROOT, "docker", "profiles", `${host}.yml`)), `docker/profiles/${host}.yml must exist`);
    }
  });

  it("documents the docker workflow", async () => {
    const text = await read("docs/docker.md");
    assert.ok(text.length > 500, "docs/docker.md looks empty");
    for (const needle of [
      "npm run verify:docker",
      "docker compose",
      "MEERKAT_TASKPANEL_TARGET_HOME",
      "/health",
      "Troubleshooting",
    ]) {
      assert.ok(text.includes(needle), `docs/docker.md should mention ${needle}`);
    }
  });

  it("declares the verify scripts in package.json", async () => {
    const pkg = JSON.parse(await read("package.json"));
    assert.equal(pkg.scripts["verify:docker"], "node scripts/verify/docker.mjs");
    assert.equal(pkg.scripts["verify:docker:container"], "bash docker/verify-in-container.sh");
    assert.ok(Array.isArray(pkg.dependencies) === false || Object.keys(pkg.dependencies ?? {}).length === 0);
    assert.ok(Object.keys(pkg.devDependencies ?? {}).length === 0, "no devDependencies allowed");
  });
});

describe("static: CI workflow", () => {
  it("adds a docker job that mirrors the local build + in-container run", async () => {
    const text = await read(".github/workflows/check.yml");
    assert.match(text, /^  docker:/m, "expected a docker job");
    assert.match(text, /docker build -f docker\/Dockerfile -t meerkat-taskpanel:verify \./);
    assert.match(text, /docker run --rm meerkat-taskpanel:verify bash docker\/verify-in-container\.sh/);
    // No shell step may install dependencies (comments may still mention the rule).
    assert.doesNotMatch(text, /^\s*(-\s*)?run:.*npm (install|ci)/m, "CI must not install dependencies");
    // The original job is preserved.
    assert.match(text, /^  check:$/m);
  });
});

describe("static: REQUIRED_PROFILE_FIELDS", () => {
  it("lists the flat profile schema", () => {
    assert.deepEqual(REQUIRED_PROFILE_FIELDS, ["host", "label", "installer", "target_dir", "skill_entry", "wrapper"]);
  });
});
