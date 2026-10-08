/**
 * Step 21: the coverage gate, self-hosted (F7 option A).
 *
 * `node --test`'s own thresholds are per-run, and this suite has several
 * modules with different shapes. What the card asks for is "core modules ≥ 80%
 * each", so this test runs the coverage tool over *explicit* paths and reads
 * the per-module numbers out of its report — the file list excludes this file,
 * so the run cannot recurse.
 *
 * The gate is deliberately a *test* rather than a flag on the main run: a
 * failure here names the module and the missing lines, in the same output as
 * everything else.
 *
 * Two kinds of floor are checked. Every gate asserts its **total**; a gate marked
 * `perModule` also asserts **each of its modules**, because a total hides a
 * module — 98% overall is reachable with one file at 40%. M3's `src/mcp` tree is
 * the only one opted in for the stricter reading (the reasons the others are not
 * are recorded next to the flag).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Modules the card names, and the suites that exercise them. */
const GATES = [
  {
    label: "src/core/domain",
    include: "src/core/domain/**",
    tests: [
      "test/core/domain/",
    ],
  },
  {
    label: "src/core/storage",
    include: "src/core/storage/**",
    tests: [
      "test/core/storage/",
      "test/contract/",
    ],
  },
  {
    label: "src/core/commands",
    include: "src/core/commands/**",
    tests: [
      "test/core/commands/",
      "test/concurrency/",
    ],
  },
  // M2's two new trees. `src/server` is exercised from both of its own suites
  // and from the CLI ones — the CLI is how a user reaches every route, so a
  // route test that only speaks HTTP would miss half the calls.
  {
    label: "src/cli",
    include: "src/cli/**",
    tests: [
      "test/cli/",
    ],
  },
  {
    label: "src/server",
    include: "src/server/**",
    tests: [
      "test/server/",
      "test/cli/",
    ],
  },
  // M3's stdio server: the AI-facing surface, held to the same 80% floor as the
  // two above — and, unlike them, per module (see `perModule` below). Its suites
  // drive real child processes, and `node --test` hands `NODE_V8_COVERAGE` down
  // to them, so these numbers include `main.mjs`'s pump actually running, not
  // merely the library it imports.
  {
    label: "src/mcp",
    include: "src/mcp/**",
    tests: [
      "test/mcp/",
    ],
    perModule: true,
  },
];

const THRESHOLD = 80;

/** Every `.test.mjs` under the given directories (explicit paths, no globs). */
function testFiles(dirs) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = resolve(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".test.mjs")) out.push(abs);
    }
  };
  for (const dir of dirs) {
    const abs = resolve(ROOT, dir);
    if (existsSync(abs)) walk(abs);
  }
  return out.sort();
}

/**
 * Node's test reporter prefixes every line of captured output with `ℹ ` (or a
 * `# ` comment marker). The coverage table has to be read through that.
 * @param {string} line
 */
export function stripReporterMarker(line) {
  return line.replace(/^\s*(?:[ℹ✔✖﹣│]+|#)\s?/, "");
}

/**
 * The environment for the nested run.
 *
 * A `node --test` started from inside a `node --test` is refused outright
 * ("run() is being called recursively"), so the marker variables that identify
 * this process as a test child are removed: the nested run is a normal run.
 */
export function childEnv(env = process.env) {
  const copy = { ...env };
  for (const key of ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "NODE_V8_COVERAGE"]) delete copy[key];
  return copy;
}

/** Run one coverage pass and return its parsed summary. */
function measure(gate, threshold = THRESHOLD) {
  const files = testFiles(gate.tests).filter((file) => !file.endsWith("coverage-gate.test.mjs"));
  assert.ok(files.length > 0, `no tests selected for ${gate.label}`);

  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--experimental-test-coverage",
      `--test-coverage-include=${gate.include}`,
      `--test-coverage-lines=${threshold}`,
      `--test-coverage-branches=${threshold}`,
      `--test-coverage-functions=${threshold}`,
      ...files,
    ],
    { cwd: ROOT, encoding: "utf8", env: childEnv() },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status, output, summary: parseSummary(output) };
}

/**
 * Read the `all files` line of the coverage table.
 *
 * The report is markdown-ish, so the columns are found by header position
 * rather than by a fixed split — a change of column width must not silently
 * turn 79% into 179%.
 */
export function parseSummary(output) {
  const lines = output.split("\n").map(stripReporterMarker);
  const headerAt = lines.findIndex((line) => /^\s*file\s*\|/.test(line));
  if (headerAt === -1) return null;
  const header = lines[headerAt].split("|").map((cell) => cell.trim());

  const totals = lines.find((line) => /^all files\s*\|/.test(line));
  if (totals === undefined) return null;
  const cells = totals.split("|").map((cell) => cell.trim());

  const pick = (name) => {
    const index = header.indexOf(name);
    return index === -1 ? null : Number.parseFloat(cells[index]);
  };
  return {
    lines: pick("line %"),
    branches: pick("branch %"),
    functions: pick("funcs %"),
    raw: totals,
  };
}

/** The `Missing` list for the modules that fall short. */
export function worstModules(output, threshold = THRESHOLD) {
  const rows = output
    .split("\n")
    .map(stripReporterMarker)
    .filter((line) => /\|\s*\d+(\.\d+)?\s*\|/.test(line) && !/^all files/.test(line) && !/^\s*file/.test(line))
    .map((line) => line.trim());
  return rows.filter((row) => {
    // Columns are `file | line % | branch % | funcs % | uncovered lines`; the
    // last one holds line numbers, which are not percentages.
    const percentages = row.split("|").slice(1, 4).map((cell) => Number.parseFloat(cell));
    return percentages.some((value) => Number.isFinite(value) && value < threshold);
  });
}

describe("coverage gate (A11 / V11)", () => {
  it("parses a coverage table the way the report writes one", () => {
    const sample = [
      "start of coverage report",
      "------------------------------------------------------------------",
      "file      | line % | branch % | funcs % | uncovered lines",
      "------------------------------------------------------------------",
      "a.mjs     |  91.30 |   80.00  |  100.00 | 12-13",
      "b.mjs     |  79.00 |   70.00  |   50.00 | 4-9",
      "------------------------------------------------------------------",
      "all files |  88.10 |   78.20  |   95.00 |",
      "------------------------------------------------------------------",
    ].join("\n");
    assert.deepEqual(parseSummary(sample), {
      lines: 88.1,
      branches: 78.2,
      functions: 95,
      raw: "all files |  88.10 |   78.20  |   95.00 |",
    });
    assert.equal(parseSummary("no table here"), null);
    // The reporter prefixes captured output; the parser must see through it.
    assert.deepEqual(
      parseSummary(sample.split("\n").map((line) => `ℹ ${line}`).join("\n")).lines,
      88.1,
    );
    assert.deepEqual(worstModules(sample), ["b.mjs     |  79.00 |   70.00  |   50.00 | 4-9"]);
    assert.deepEqual(stripReporterMarker("ℹ all files | 88.10"), "all files | 88.10");
  });

  it("holds every module of an opted-in tree to the threshold, not just its total", () => {
    // `perModule` exists because a total hides a module: 98% overall is
    // reachable with one file at 40%. `src/mcp` is the only tree opted in, and
    // it was opted in *after* being measured — every module in it clears the
    // floor on all three axes.
    //
    // The others are not, and the reason is measured rather than assumed:
    //   * `src/cli` cannot be opted in today — `src/cli/errors.mjs` reports
    //     branch 78.95% in this tree's own scoped run (lines 75-76, the
    //     `renderErrorText` arms nothing exercises). Fixing it means editing
    //     `src/cli/**`, which this card may not do; lowering the number to make
    //     it pass would be the wrong fix.
    //   * `src/server` does clear the floor per module, but it is not this
    //     card's business to tighten a gate over a tree it did not touch.
    //   * the three `src/core` gates stay on the total for the same reason as
    //     `src/cli`: `src/core/storage/unit-of-work.mjs` (branch 68.00%) and
    //     `src/core/storage/runtime-pointer.mjs` (branch 75.00%) are below it.
    // Each of those is a card of its own. What matters here is that MCP's floor
    // is enforced per module rather than trusted.
    assert.deepEqual(
      GATES.filter((gate) => gate.perModule === true).map((gate) => gate.label),
      ["src/mcp"],
    );
  });

  it("is not vacuous: raising the floor above src/mcp's real coverage turns the gate red", () => {
    // A gate that cannot fail is not a gate. Run the *same* `src/mcp` gate with
    // the floor at 100% and require two independent signs of failure: `node
    // --test` exits non-zero on its own thresholds, and the per-module shortfall
    // list is non-empty. If the 80% floor above were pinned to a number nothing
    // could miss, this is the test that would catch it.
    const gate = GATES.find((entry) => entry.label === "src/mcp");
    const raised = measure(gate, 100);

    assert.notEqual(raised.status, 0, "node --test must exit non-zero under a 100% floor");
    const shortfall = worstModules(raised.output, 100);
    assert.ok(shortfall.length > 0, `no src/mcp module fell under 100%:\n${raised.output.slice(-2000)}`);
  });

  for (const gate of GATES) {
    it(`${gate.label} stays at or above ${THRESHOLD}% line / branch / function`, () => {
      const { status, output, summary } = measure(gate);

      assert.notEqual(summary, null, `no coverage summary for ${gate.label}:\n${output.slice(-4000)}`);
      const below = [
        ["lines", summary.lines],
        ["branches", summary.branches],
        ["functions", summary.functions],
      ].filter(([, value]) => !(value >= THRESHOLD));

      const shortfall = worstModules(output);
      if (gate.perModule === true) {
        assert.deepEqual(
          shortfall,
          [],
          `${gate.label} has modules below ${THRESHOLD}%:\n${shortfall.join("\n")}`,
        );
      }
      assert.deepEqual(
        below.map(([name, value]) => `${gate.label} ${name}=${value}`),
        [],
        `${gate.label} is below ${THRESHOLD}%:\n${shortfall.join("\n") || output.slice(-2000)}`,
      );
      assert.equal(status, 0, `${gate.label}: node --test exited ${status} (its own thresholds)\n${output.slice(-2000)}`);
    });
  }
});
