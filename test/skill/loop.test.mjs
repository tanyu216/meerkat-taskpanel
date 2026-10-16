/**
 * The `meerkat-loop` skill (T-20261012-163500-loopdecouple-b).
 *
 * The loop used to be an implicit side effect of installing the board skill. It is now a
 * skill of its own, with a **generated** payload: the execution body and the installer
 * templates are produced from this repository's own `scripts/`, `src/shared/` and
 * `scripts/install/templates/`, and guarded by `node scripts/sync-skills.mjs --check`.
 *
 * These tests hold the three things that make that split real rather than cosmetic:
 *
 *   1. the payload is in sync with its sources, and the body is **closed** under its own
 *      relative imports — a body missing a member loads in the repo and dies in a host;
 *   2. the skill declares the board interface it needs, and its gate enforces it against
 *      a board's own `--version --json` answer;
 *   3. the board skill no longer points into the repository root — a distributed skill's
 *      links have to resolve where the skill is installed, not where it was authored.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { atLeastVersion, checkBoard, resolveBoardCommand } from "../../skills/meerkat-loop/scripts/board-check.mjs";
import { LOOP_BODY_ROOTS, LOOP_SKILL_NAME, LOOP_TEMPLATE_FILES, relativeImports, syncLoop } from "../../scripts/sync-loop.mjs";
import { resolveSkillSource } from "../../scripts/sync-skills.mjs";
import { readFrontmatterField } from "../../scripts/verify/lib/frontmatter.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOOP_SKILL = resolveSkillSource(ROOT, LOOP_SKILL_NAME);
const GATE = join(LOOP_SKILL, "scripts", "board-check.mjs");

/** The body closure, read from the generated manifest the installer also reads. */
function bodyClosure() {
  return readFileSync(join(LOOP_SKILL, "body", "manifest.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("loop skill: the generated payload", () => {
  it("is in sync with the sources it is generated from", async () => {
    const report = await syncLoop({ root: ROOT, check: true });
    assert.equal(report.ok, true, JSON.stringify(report.files.filter((f) => f.state !== "equal"), null, 2));
    assert.equal(report.manifest.state, "equal", "body/manifest.txt must match the computed closure");
  });

  it("generates the body as the closure of its two entry points", async () => {
    const report = await syncLoop({ root: ROOT, check: true });

    for (const root of LOOP_BODY_ROOTS) {
      assert.ok(report.body.includes(root), `${root} must be in the closure`);
    }
    assert.deepEqual(report.body, [...report.body].sort(), "the closure is reported sorted");

    // The body's own imports all land inside the body: nothing it loads may be left
    // behind in the repository, or a host copy would die at load with a relative import
    // that resolves to nothing.
    for (const rel of report.body) {
      const text = readFileSync(join(LOOP_SKILL, "body", rel), "utf8");
      for (const specifier of relativeImports(text)) {
        const target = resolve(dirname(join(LOOP_SKILL, "body", rel)), specifier);
        const targetRel = target.slice(join(LOOP_SKILL, "body").length + 1);
        assert.ok(
          report.body.includes(targetRel),
          `${rel} imports ${specifier}, which is not in the closure (${targetRel})`,
        );
      }
    }
  });

  it("carries the shared modules the supervisor and the wake resolver import", () => {
    // Named explicitly as well as derived: the closure is a computation, and a
    // computation with a bug would still look internally consistent.
    const body = bodyClosure();
    for (const rel of [
      "scripts/supervisor.mjs",
      "scripts/wake-cwd.mjs",
      "src/shared/scheduling.mjs",
      "src/shared/sla-patrol.mjs",
      "src/shared/constants.mjs",
      "src/shared/errors.mjs",
      "src/shared/redact.mjs",
      "src/shared/project-dir.mjs",
      "src/shared/runtime-locator.mjs",
      "src/shared/entry-guard.mjs",
    ]) {
      assert.ok(body.includes(rel), `${rel} must be part of the loop body`);
    }
  });

  it("copies the body byte for byte from the repository's own modules", () => {
    for (const rel of bodyClosure()) {
      assert.equal(
        readFileSync(join(LOOP_SKILL, "body", rel), "utf8"),
        readFileSync(join(ROOT, rel), "utf8"),
        `${rel} must be an exact copy of the repository's module`,
      );
    }
  });

  it("carries the loop's installer templates, and only the loop's", () => {
    for (const rel of LOOP_TEMPLATE_FILES) {
      assert.equal(
        readFileSync(join(LOOP_SKILL, "templates", rel), "utf8"),
        readFileSync(join(ROOT, "scripts", "install", "templates", rel), "utf8"),
        `templates/${rel} must be an exact copy`,
      );
    }

    // The board-side templates stay with the installer that renders them for a board.
    for (const boardOnly of ["claude/session-start.sh", "codex/trigger.sh", "taskctl-shim.sh"]) {
      assert.equal(
        existsSync(join(LOOP_SKILL, "templates", boardOnly)),
        false,
        `${boardOnly} is board-side and must not be in the loop's payload`,
      );
    }
  });

  it("names no checkout path: the wake glues resolve through {{LOOP}}", () => {
    for (const rel of ["claude/wake-claude.sh", "codex/wake-codex.sh", "pi/wake-pi.sh"]) {
      const text = readFileSync(join(LOOP_SKILL, "templates", rel), "utf8");
      assert.ok(text.includes("{{LOOP}}/scripts/wake-cwd.mjs"), `${rel} must resolve via {{LOOP}}`);
      assert.equal(text.includes("{{REPO}}"), false, `${rel} must not name the board checkout`);
    }
  });
});

describe("loop skill: SKILL.md", () => {
  const text = readFileSync(join(LOOP_SKILL, "SKILL.md"), "utf8");

  it("has frontmatter naming the skill with a real description", () => {
    assert.equal(readFrontmatterField(text, "name"), LOOP_SKILL_NAME);
    const description = readFrontmatterField(text, "description");
    assert.ok(typeof description === "string" && description.length >= 20, "description must be substantial");
  });

  it("declares the board interface it requires", () => {
    assert.match(text, /task-interface v1/, "the required board interface generation must be stated");
    assert.match(text, /board release >= 1\.0\.0/, "…and the release floor a machine can check");
    assert.ok(text.includes("scripts/board-check.mjs"), "the gate must be named at the point of declaration");
  });

  it("says out loud that OpenClaw never gets the loop", () => {
    assert.match(text, /OpenClaw is deliberately excluded/);
    // No host takes a generated copy of the loop: every harness reads the repository's own
    // skills/ tree, and OpenClaw is excluded by ruling. `install.sh` is the loop's only
    // distribution path — there is no loop bundle in the marketplace any more, and no
    // `plugins/` tree for one to live in (asserted against the checkout in
    // test/scaffold.test.mjs, which is where the "exactly one skills tree" invariant lives).
    assert.equal(
      existsSync(join(ROOT, "plugins")),
      false,
      "the loop ships through install.sh only — no committed bundle may carry it",
    );
  });

  it("records what the loop still needs from a checkout, rather than implying it needs none", () => {
    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /MEERKAT_TASKPANEL_REPO/);
    assert.match(operation, /remaining checkout dependency/);
  });
});

describe("loop skill: the board gate", () => {
  it("accepts a board at or above the floor, and reports what it saw", () => {
    const ok = checkBoard({
      command: "taskctl",
      args: ["--version", "--json"],
      run: () => ({ status: 0, stdout: '{"ok":true,"data":{"version":"1.4.2","schema_version":7}}', stderr: "" }),
    });
    assert.deepEqual(ok, {
      ok: true,
      version: "1.4.2",
      schemaVersion: 7,
      boardInterface: "task-interface v1",
    });
  });

  it("refuses a board older than the floor, naming both numbers", () => {
    const tooOld = checkBoard({
      command: "taskctl",
      args: [],
      run: () => ({ status: 0, stdout: '{"ok":true,"data":{"version":"0.9.0"}}', stderr: "" }),
    });
    assert.equal(tooOld.ok, false);
    assert.equal(tooOld.code, "BOARD_TOO_OLD");
    assert.match(tooOld.message, /0\.9\.0/);
    assert.match(tooOld.message, /1\.0\.0/);
  });

  it("does not count a prerelease as satisfying the floor", () => {
    assert.equal(atLeastVersion("1.0.0", "1.0.0"), true);
    assert.equal(atLeastVersion("1.0.0-rc.1", "1.0.0"), false);
    assert.equal(atLeastVersion("2.0.0-rc.1", "1.0.0"), true);
    assert.equal(atLeastVersion("not-a-version", "1.0.0"), false);
    assert.equal(atLeastVersion(undefined, "1.0.0"), false);
  });

  it("reports an unreachable or unreadable board as no verdict, never as a pass", () => {
    const unreachable = checkBoard({
      command: "taskctl",
      args: [],
      run: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
    });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.code, "BOARD_UNREACHABLE");

    const garbage = checkBoard({
      command: "taskctl",
      args: [],
      run: () => ({ status: 0, stdout: "not json at all", stderr: "" }),
    });
    assert.equal(garbage.ok, false);
    assert.equal(garbage.code, "BOARD_UNREADABLE");

    const shapeless = checkBoard({
      command: "taskctl",
      args: [],
      run: () => ({ status: 0, stdout: '{"ok":true,"data":{}}', stderr: "" }),
    });
    assert.equal(shapeless.code, "BOARD_UNREADABLE");
  });

  it("resolves the board from --repo / MEERKAT_TASKPANEL_REPO before falling back to PATH", () => {
    assert.deepEqual(resolveBoardCommand({ cli: "/x/taskctl" }), {
      command: "/x/taskctl",
      args: ["--version", "--json"],
    });

    const viaRepo = resolveBoardCommand({ repo: "/checkout", node: "/node" });
    assert.equal(viaRepo.command, "/node");
    assert.deepEqual(viaRepo.args, ["/checkout/src/cli/index.mjs", "--version", "--json"]);

    const viaEnv = resolveBoardCommand({
      env: { MEERKAT_TASKPANEL_REPO: "/from-env" },
      node: "/node",
    });
    assert.deepEqual(viaEnv.args, ["/from-env/src/cli/index.mjs", "--version", "--json"]);

    assert.deepEqual(resolveBoardCommand({ env: {}, node: "/node" }), {
      command: "taskctl",
      args: ["--version", "--json"],
    });
  });

  it("exits 3 — not 0 — when no board answers", () => {
    // `--repo` names a checkout whose CLI is not there: node runs, the module does not
    // load, nothing reaches stdout. The gate must call that "no verdict" (3), never a pass.
    const run = spawnSync(process.execPath, [GATE, "--repo", "/definitely/not/a/board"], { encoding: "utf8" });
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /board-check: BOARD_UNREADABLE/);

    const missingCli = spawnSync(process.execPath, [GATE, "--cli", "/definitely/not/a/cli"], { encoding: "utf8" });
    assert.equal(missingCli.status, 2, "a --cli typo is a usage error, not a verdict");
  });

  it("exits 0 against this repository's own board", () => {
    const run = spawnSync(process.execPath, [GATE, "--repo", ROOT, "--quiet"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
  });
});

describe("board skill: references resolve where the skill is installed", () => {
  const files = [
    "skills/meerkat-taskpanel/references/practice-guides.md",
    "skills/meerkat-taskpanel/references/projects-json.md",
  ];

  it("has no link that climbs out of the skill into the repository root", () => {
    // `../../../docs/…` resolves in this checkout and dangles everywhere the skill is
    // actually installed — the plugin bundles carry `skills/<name>/` and nothing above it.
    // A distributed skill links out by absolute URL or not at all.
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const climbing = [...text.matchAll(/\]\((\.\.\/[^)]*)\)/g)]
        .map((match) => match[1])
        .filter((target) => target.startsWith("../.."));
      assert.deepEqual(climbing, [], `${file}: links must not climb out of the skill`);
    }
  });

  it("points the loop ownership it describes at the loop skill", () => {
    const text = readFileSync(join(ROOT, files[0]), "utf8");
    assert.match(text, /meerkat-loop/);
    assert.equal(text.includes("scripts/supervisor.mjs]("), false, "no relative link to the executor");
  });
});
