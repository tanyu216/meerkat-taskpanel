/**
 * The `meerkat-loop` skill (T-20261012-163500-loopdecouple-b).
 *
 * The loop used to be an implicit side effect of installing the board skill. It is now a
 * skill of its own, with a **generated** payload: the execution body and the installer
 * templates are produced from this repository's own `scripts/`, `src/foundation/` and
 * `scripts/install/templates/`, and guarded by `node scripts/sync-skills.mjs --check`.
 *
 * These tests hold the three things that make that split real rather than cosmetic:
 *
 *   1. the payload is in sync with its sources, and the body is **closed** under its own
 *      relative imports — a body missing a member loads in the repo and dies in an agent kind;
 *   2. the skill declares the board interface it needs, and its gate enforces it against
 *      a board's own `--version --json` answer;
 *   3. the board skill no longer points into the repository root — a distributed skill's
 *      links have to resolve where the skill is installed, not where it was authored.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { atLeastVersion, checkBoard, resolveBoardCommand } from "../../skills/meerkat-loop/scripts/board-check.mjs";
import {
  LOOP_BODY_ROOTS,
  LOOP_SKILL_NAME,
  LOOP_TEMPLATE_FILES,
  loopSource,
  relativeImports,
  syncLoop,
  transformBody,
} from "../../scripts/sync-loop.mjs";
import { resolveSkillSource } from "../../scripts/sync-skills.mjs";
import { readFrontmatterField } from "../../scripts/verify/lib/frontmatter.mjs";
import { LOOP_SKILL_COMMAND } from "../../src/foundation/scheduling.mjs";
import {
  ACCEPTANCE_POLICIES,
  ALLOWED_TRANSITIONS,
  EPIC_ONLY_TRANSITIONS,
  acceptanceAllows,
} from "../../src/core/domain/status.mjs";
import { STATUSES } from "../../src/core/domain/enums.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOOP_SKILL = resolveSkillSource(ROOT, LOOP_SKILL_NAME);
const GATE = join(LOOP_SKILL, "scripts", "board-check.mjs");

/** The body closure, read from the generated manifest the installer also reads. */
function bodyClosure() {
  return readFileSync(join(LOOP_SKILL, "manifest.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("loop skill: the generated payload", () => {
  it("is in sync with the sources it is generated from", async () => {
    const report = await syncLoop({ root: ROOT, check: true });
    assert.equal(report.ok, true, JSON.stringify(report.files.filter((f) => f.state !== "equal"), null, 2));
    assert.equal(report.manifest.state, "equal", "manifest.txt must match the computed closure");
  });

  it("generates the body as the closure of its entry points", async () => {
    const report = await syncLoop({ root: ROOT, check: true });

    for (const root of LOOP_BODY_ROOTS) {
      assert.ok(report.body.includes(root), `${root} must be in the closure`);
    }
    assert.deepEqual(report.body, [...report.body].sort(), "the closure is reported sorted");

    // The body's own imports all land inside the body: nothing it loads may be left
    // behind in the repository, or an agent copy would die at load with a relative import
    // that resolves to nothing.
    for (const rel of report.body) {
      const text = readFileSync(join(LOOP_SKILL, rel), "utf8");
      for (const specifier of relativeImports(text)) {
        const target = resolve(dirname(join(LOOP_SKILL, rel)), specifier);
        const targetRel = target.slice(LOOP_SKILL.length + 1);
        assert.ok(
          report.body.includes(targetRel),
          `${rel} imports ${specifier}, which is not in the closure (${targetRel})`,
        );
      }
    }
  });

  it("counts a bare side-effect import as a member of the closure", () => {
    // `import "./x.mjs"` carries neither `from` nor parentheses. Miss it here and the
    // closure ships one file short; the copy loads in this repository and dies in an agent.
    assert.deepEqual(relativeImports('import "./sibling.mjs";\n'), ["./sibling.mjs"]);
    assert.deepEqual(relativeImports('  import "./sibling.mjs"\n'), ["./sibling.mjs"]);
    assert.deepEqual(
      relativeImports('import x from "./a.mjs";\nimport "./b.mjs";\nimport("./c.mjs");\n').sort(),
      ["./a.mjs", "./b.mjs", "./c.mjs"],
    );
  });

  it("rewrites a side-effect import into the foundation as well", () => {
    // The same blind spot in the transform would leave a repository path in the shipped copy.
    assert.equal(
      transformBody('import "../src/foundation/errors.mjs";\n', "scripts/wake-cwd.mjs", ROOT),
      'import "./foundation/errors.mjs";\n',
    );
  });

  it("carries the foundation modules the supervisor and the wake resolver import", () => {
    // Named explicitly as well as derived: the closure is a computation, and a
    // computation with a bug would still look internally consistent.
    const body = bodyClosure();
    for (const rel of [
      "scripts/supervisor.mjs",
      "scripts/loop/options.mjs",
      "scripts/loop/runtime.mjs",
      "scripts/loop/runners.mjs",
      "scripts/loop/board.mjs",
      "scripts/loop/passes.mjs",
      "scripts/loop/subscribe.mjs",
      "scripts/loop/card-file.mjs",
      "scripts/wake-cwd.mjs",
      "scripts/foundation/card-brief.mjs",
      "scripts/foundation/scheduling.mjs",
      "scripts/foundation/sla-patrol.mjs",
      "scripts/foundation/sla-config.mjs",
      "scripts/foundation/constants.mjs",
      "scripts/foundation/errors.mjs",
      "scripts/foundation/redact.mjs",
      "scripts/foundation/project-dir.mjs",
      "scripts/foundation/runtime-locator.mjs",
      "scripts/foundation/entry-guard.mjs",
    ]) {
      assert.ok(body.includes(rel), `${rel} must be part of the loop body`);
    }
  });

  it("matches its sources: foundation byte for byte, entries after the documented rewrite", () => {
    for (const rel of bodyClosure()) {
      const sourceRel = loopSource(rel);
      const source = readFileSync(join(ROOT, sourceRel), "utf8");
      assert.equal(
        readFileSync(join(LOOP_SKILL, rel), "utf8"),
        transformBody(source, sourceRel, ROOT),
        `${rel} must match ${sourceRel} under the payload transform`,
      );
    }

    // The transform is a no-op inside the foundation subtree, so those copies are exact.
    for (const rel of bodyClosure().filter((item) => item.startsWith("scripts/foundation/"))) {
      assert.equal(
        readFileSync(join(LOOP_SKILL, rel), "utf8"),
        readFileSync(join(ROOT, loopSource(rel)), "utf8"),
        `${rel} must be an exact copy of its repository module`,
      );
    }

    // And no generated module still points at the repository layout.
    for (const rel of bodyClosure()) {
      const text = readFileSync(join(LOOP_SKILL, rel), "utf8");
      assert.equal(
        relativeImports(text).some((specifier) => specifier.includes("/src/foundation/")),
        false,
        `${rel} must not import through src/foundation`,
      );
    }
  });

  it("keeps the payload at the skill root, with no body/ or src/ wrapper", () => {
    assert.equal(
      existsSync(join(LOOP_SKILL, "body")),
      false,
      "the legacy body/ wrapper must be gone — the manifest and generated trees sit at the skill root",
    );
    assert.equal(
      existsSync(join(LOOP_SKILL, "src")),
      false,
      "foundation lives under scripts/foundation/; the skill has no src/ tree",
    );
    assert.ok(existsSync(join(LOOP_SKILL, "manifest.txt")), "the closure manifest sits at the skill root");
  });

  it("never treats the authored board gate as generated output", async () => {
    const report = await syncLoop({ root: ROOT, check: true });

    assert.ok(existsSync(GATE), "the authored gate must still exist");
    assert.equal(
      bodyClosure().includes("scripts/board-check.mjs"),
      false,
      "the hand-written gate is not part of the execution body",
    );
    assert.equal(
      report.files.some((file) => file.dest === GATE),
      false,
      "the generator must not write the authored gate",
    );
    assert.equal(
      report.files.some((file) => file.state === "extra" && file.dest === GATE),
      false,
      "the authored gate must not be reported as stale output",
    );
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

  it("is command-only: the model may not invoke it by description", () => {
    assert.equal(readFrontmatterField(text, "disable-model-invocation"), "true");
  });

  it("documents explicit invocation and takes no argument placeholder", () => {
    assert.match(text, /^#{2,3} Invocation$/m);
    assert.match(text, /\/meerkat-loop/);
    assert.equal(text.includes("$ARGUMENTS"), false);
  });

  it("points the continue prompt at this skill's command", () => {
    assert.equal(LOOP_SKILL_COMMAND, `/${LOOP_SKILL_NAME}`);
  });

  it("declares the board interface it requires", () => {
    assert.match(text, /task-interface v1/, "the required board interface generation must be stated");
    assert.match(text, /board release >= 1\.1\.0/, "…and the release floor a machine can check");
    assert.ok(text.includes("scripts/board-check.mjs"), "the gate must be named at the point of declaration");
  });

  it("says out loud that OpenClaw never gets the loop", () => {
    assert.match(text, /OpenClaw is deliberately excluded/);
    // No agent kind takes a generated copy of the loop: every harness reads the repository's own
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

  it("documents the workflow alert ledger flag", () => {
    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /--workflow-ledger/);
  });

  it("documents the task process directory and the read-only card brief", () => {
    assert.match(text, /\.meerkat\/<identifier>\//);
    assert.match(text, /authoritative brief/);
    assert.match(text, /never edit it/i);
    assert.match(text, /taskctl export md/);
    assert.match(text, /taskctl attachment download/);

    const operation = readFileSync(join(LOOP_SKILL, "references", "operation.md"), "utf8");
    assert.match(operation, /Export before claim/);
    assert.match(operation, /refreshes the briefs/);
    assert.match(operation, /deferred\s+\*\*unclaimed\*\*|deferred\nunclaimed|deferred/);
  });

  it("names the attachment download command in the board skill's CLI reference", () => {
    const cli = readFileSync(
      join(ROOT, "skills", "meerkat-taskpanel", "references", "cli.md"),
      "utf8",
    );
    assert.match(cli, /attachment download <attachment-id> --out <file>/);
    assert.match(cli, /--out \.meerkat\/PROJ-0007\/shot\.png/);
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
    assert.match(tooOld.message, /1\.1\.0/);
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
  const skillDir = join(ROOT, "skills/meerkat-taskpanel");
  const references = readdirSync(join(skillDir, "references"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `references/${name}`);
  const files = ["SKILL.md", ...references];
  const read = (rel) => readFileSync(join(skillDir, rel), "utf8");

  it("has no link that climbs out of the skill into the repository root", () => {
    // `../../../docs/…` resolves in this checkout and dangles everywhere the skill is
    // actually installed — the plugin bundles carry `skills/<name>/` and nothing above it.
    // A distributed skill links out by absolute URL or not at all.
    for (const file of files) {
      const text = read(file);
      const climbing = [...text.matchAll(/\]\((\.\.\/[^)]*)\)/g)]
        .map((match) => match[1])
        .filter((target) => target.startsWith("../.."));
      assert.deepEqual(climbing, [], `${file}: links must not climb out of the skill`);
    }
  });

  it("has a real target for every relative link", () => {
    for (const file of files) {
      const text = read(file);
      const targets = [...text.matchAll(/\]\(([^)]+)\)/g)]
        .map((match) => match[1])
        .filter((target) => !/^(https?:|mailto:|#)/.test(target))
        .map((target) => target.split("#")[0])
        .filter((target) => target !== "");
      for (const target of targets) {
        assert.ok(
          existsSync(join(dirname(join(skillDir, file)), target)),
          `${file}: ${target} does not resolve`,
        );
      }
    }
  });

  it("resolves every #fragment against the target file's headings", () => {
    // GitHub's slug rules, as far as these pages use them: strip backticks and stars, keep
    // letters, digits, spaces, underscores and hyphens, then turn each space into a hyphen.
    // A punctuation run leaves the double hyphen that `policy × scope` produces.
    const slug = (heading) =>
      heading
        .trim()
        .toLowerCase()
        .replace(/[`*]/g, "")
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/ /g, "-");

    const headings = (text) => {
      const slugs = new Map();
      let fence = null;
      for (const line of text.split("\n")) {
        const marker = /^\s*(```|~~~)/.exec(line);
        if (marker !== null) {
          fence = fence === null ? marker[1] : fence === marker[1] ? null : fence;
          continue;
        }
        if (fence !== null) continue;
        const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading === null) continue;
        const base = slug(heading[1]);
        const seen = slugs.get(base) ?? 0;
        slugs.set(base, seen + 1);
        if (seen > 0) slugs.set(`${base}-${seen}`, 1);
      }
      return slugs;
    };

    const cache = new Map();
    const slugsFor = (path) => {
      if (!cache.has(path)) cache.set(path, headings(readFileSync(path, "utf8")));
      return cache.get(path);
    };

    for (const file of files) {
      for (const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:)/.test(target) || !target.includes("#")) continue;
        const [pathPart, fragment] = target.split("#");
        if (fragment === "") continue;
        const targetFile =
          pathPart === "" ? join(skillDir, file) : join(dirname(join(skillDir, file)), pathPart);
        assert.ok(existsSync(targetFile), `${file}: ${target} does not resolve`);
        assert.ok(slugsFor(targetFile).has(fragment), `${file}: ${target} is not a heading anchor`);
      }
    }
  });

  it("points the loop ownership it describes at the loop skill", () => {
    const text = read("SKILL.md");
    assert.match(text, /meerkat-loop/);
    assert.equal(text.includes("scripts/supervisor.mjs]("), false, "no relative link to the executor");
  });

  it("teaches the review workflow in the main prompt, not only in a reference", () => {
    const text = read("SKILL.md");
    assert.match(text, /review_of_id/, "the structural review marker is named");
    assert.match(text, /VERDICT/, "the verdict line is named");
    assert.match(text, /flow B/i, "the flow vocabulary is present");
    assert.match(
      text,
      /references\/review-workflow\.md/,
      "the main prompt links the full protocol",
    );
  });
});

describe("board skill: the status whitelist matches the domain", () => {
  const files = ["SKILL.md", "references/status-lifecycle.md"];

  function block(text, file) {
    const begin = text.indexOf("<!-- status-whitelist:begin -->");
    const end = text.indexOf("<!-- status-whitelist:end -->");
    assert.ok(begin >= 0 && end > begin, `${file}: missing status-whitelist markers`);
    return text.slice(begin, end);
  }

  function parse(raw, file) {
    const table = {};
    const epic = [];
    for (const line of raw.split("\n")) {
      if (!line.includes("→")) continue;
      const arrow = line.indexOf("→");
      const from = line
        .slice(0, arrow)
        .replace(/`/g, "")
        .trim()
        .split(/\s+/)[0];
      let right = line.slice(arrow + 1);
      const epicMatch = right.match(/\(an epic also →\s*([^)]+)\)/);
      if (epicMatch !== null) {
        epic.push([from, epicMatch[1].replace(/`/g, "").trim()]);
        right = right.replace(epicMatch[0], "");
      }
      if (/\(terminal\)/.test(right)) {
        table[from] = [];
        continue;
      }
      table[from] = right
        .split(",")
        .map((target) => target.replace(/`/g, "").trim())
        .filter((target) => target !== "");
    }
    assert.ok(Object.keys(table).length > 0, `${file}: no rows parsed`);
    return { table, epic };
  }

  it("re-encodes ALLOWED_TRANSITIONS and the epic overlay", () => {
    const blocks = files.map((file) =>
      block(readFileSync(join(ROOT, "skills/meerkat-taskpanel", file), "utf8"), file),
    );
    assert.equal(
      blocks[0].replace(/\s+/g, " ").trim(),
      blocks[1].replace(/\s+/g, " ").trim(),
      "the SKILL.md and reference copies must agree",
    );

    const { table, epic } = parse(blocks[1], files[1]);
    for (const status of STATUSES) {
      assert.deepEqual(
        [...table[status]].sort(),
        [...ALLOWED_TRANSITIONS[status]].sort(),
        `${status} row`,
      );
    }
    assert.deepEqual(table.done, ["todo"]);
    assert.deepEqual(table.canceled, ["todo"]);
    assert.equal(epic.length, 1, "exactly one epic-only overlay");
    const [from, to] = epic[0];
    assert.ok(EPIC_ONLY_TRANSITIONS[from]?.includes(to), `epic overlay ${from} → ${to}`);
  });
});

describe("board and loop skills: the acceptance matrix agrees", () => {
  const BEGIN = "<!-- acceptance-matrix:begin -->";
  const END = "<!-- acceptance-matrix:end -->";
  const copies = [
    ["status-lifecycle.md", join(ROOT, "skills/meerkat-taskpanel/references/status-lifecycle.md")],
    ["review-workflow.md", join(ROOT, "skills/meerkat-taskpanel/references/review-workflow.md")],
    ["meerkat-loop/SKILL.md", join(LOOP_SKILL, "SKILL.md")],
  ];

  /** The raw block between the markers, asserting the markers appear exactly once. */
  function marked(path) {
    const text = readFileSync(path, "utf8");
    const begin = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    assert.ok(begin >= 0 && end > begin, `${path}: missing acceptance-matrix markers`);
    assert.equal(text.indexOf(BEGIN, begin + 1), -1, `${path}: more than one begin marker`);
    return text.slice(begin + BEGIN.length, end);
  }

  const cells = (line) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

  /** What a cell promises, reduced to the three kinds the board can allow. */
  function cellClass(text) {
    const value = text.replace(/`/g, "").toLowerCase();
    if (/human only/.test(value)) return "human";
    if (/human or taskd/.test(value)) return "human+taskd";
    if (/any non-human/.test(value)) return "non-human";
    return "unknown";
  }

  /** What `acceptanceAllows` says for the same policy/scope pair. */
  function expectedClass(policy, scope) {
    const human = acceptanceAllows("human", policy, scope);
    const taskd = acceptanceAllows("taskd", policy, scope);
    if (human && taskd) return "human+taskd";
    if (human) return "human";
    return taskd ? "non-human" : "none";
  }

  it("keeps the three copies byte-identical after whitespace normalisation", () => {
    const blocks = copies.map(([, path]) => marked(path));
    for (let i = 1; i < blocks.length; i += 1) {
      assert.equal(
        blocks[i].replace(/\s+/g, " ").trim(),
        blocks[0].replace(/\s+/g, " ").trim(),
        `${copies[i][0]} and ${copies[0][0]} must agree`,
      );
    }
  });

  it("re-encodes the board's policy × scope decisions", () => {
    const raw = marked(copies[0][1]);
    const rows = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|") && !/^\|[\s:|-]+\|$/.test(line))
      .map(cells);
    assert.equal(rows.length, 4, "one header plus the three scopes");

    const policies = rows[0].slice(1).map((cell) => cell.replace(/`/g, "").split(/\s+/)[0]);
    assert.deepEqual(policies, [...ACCEPTANCE_POLICIES]);
    const scopes = rows.slice(1).map((row) => row[0].replace(/`/g, "").split(/\s+/)[0]);
    assert.deepEqual(scopes, ["top_level", "review", "child"]);

    for (const row of rows.slice(1)) {
      const scope = row[0].replace(/`/g, "").split(/\s+/)[0];
      assert.equal(row.length, policies.length + 1, `${scope} must state every policy`);
      policies.forEach((policy, index) => {
        assert.equal(
          cellClass(row[index + 1]),
          expectedClass(policy, scope),
          `${policy} × ${scope}`,
        );
      });
    }
  });
});

describe("board skill: the acceptance list rule", () => {
  const text = readFileSync(join(ROOT, "skills/meerkat-taskpanel/SKILL.md"), "utf8");

  it("reads the card as JSON and derives only when the list is empty", () => {
    assert.match(text, /issue get <ref> --json/);
    assert.match(text, /acceptance_derived=yes/);
    assert.match(text, /1[–-]6/);
    assert.match(text, /frozen/);
    assert.match(text, /never replace or remove/i);
  });

  it("says an epic's acceptance is its children", () => {
    assert.match(text, /epic[^\n]*child/i);
    assert.match(text, /rollup/);
  });
});

describe("board skill: the container decision", () => {
  const skill = readFileSync(join(ROOT, "skills/meerkat-taskpanel/SKILL.md"), "utf8");
  const lifecycle = readFileSync(
    join(ROOT, "skills/meerkat-taskpanel/references/status-lifecycle.md"),
    "utf8",
  );

  it("does not promote a card that already delivered", () => {
    assert.match(skill, /current-round report/i);
    assert.match(skill, /do \*\*not\*\* promote/i);
    assert.match(lifecycle, /terminal container never rolls up/i);
  });

  it("takes rollup evidence from the children only", () => {
    assert.match(lifecycle, /children's, not the container's/i);
    assert.match(lifecycle, /delivery report/i);
  });

  it("names the shape limits", () => {
    assert.match(skill, /\*\*8\*\* direct\s+children/i);
    assert.match(skill, /\*\*8\*\* nodes on a parent chain/i);
  });
});
