/**
 * The board skill's scenario layout and token budget.
 *
 * `SKILL.md` is the universal core and a selector; each scenario page is the runbook for one
 * operation; the deep references are authorities reached only through a page's `read-next`
 * block. This test keeps that shape honest: every router row has a page, every `read-next`
 * target resolves, every flag a scenario names is still in the CLI index, and the common
 * path stays inside a stated token budget.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = join(ROOT, "skills/meerkat");
const SCENARIOS = join(SKILL, "references/scenarios");
const SKILL_MD = join(SKILL, "SKILL.md");
const CLI_MD = join(SKILL, "references/cli.md");
const NAMES = ["create", "edit", "execute", "epic", "review", "wait", "setup"];

const read = (path) => readFileSync(path, "utf8");
const tokens = (bytes) => Math.ceil(bytes / 4);
const size = (path) => statSync(path).size;

/** GitHub's heading slug, as the link resolver uses it. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

function headings(text) {
  const out = new Set();
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line);
    if (marker !== null) {
      fence = fence === null ? marker[1] : fence === marker[1] ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) out.add(slug(heading[1]));
  }
  return out;
}

function readNext(name) {
  const text = read(join(SCENARIOS, `${name}.md`));
  const begin = "<!-- read-next:begin -->";
  const end = "<!-- read-next:end -->";
  const start = text.indexOf(begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, `${name}.md has no read-next block`);
  const block = text.slice(start + begin.length, stop);
  return [...block.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("board skill: the scenario layout", () => {
  const skill = read(SKILL_MD);

  it("routes each operation to exactly one existing scenario page", () => {
    const start = skill.indexOf("## Start here");
    assert.ok(start >= 0, "SKILL.md has a ## Start here section");
    const end = skill.indexOf("\n## ", start + 1);
    const router = skill.slice(start, end === -1 ? skill.length : end);
    const linked = [...router.matchAll(/references\/scenarios\/([a-z]+)\.md/g)].map(
      (match) => match[1],
    );
    assert.deepEqual([...new Set(linked)].sort(), [...NAMES].sort());
    for (const name of NAMES) {
      assert.ok(statSync(join(SCENARIOS, `${name}.md`)).isFile(), `${name}.md exists`);
    }
  });

  it("keeps the universal headings in SKILL.md and the detail out", () => {
    for (const heading of [
      "## The language of a card",
      "## Stage markers",
      "### The acceptance list is the contract",
      "## Creating a card",
      "## Claim one card, deliver it, stop",
    ]) {
      assert.ok(skill.includes(heading), `SKILL.md keeps ${heading}`);
    }
    for (const heading of [
      "## A child is a deliverable, not a layer",
      "## Promote before delivery",
      "## The rollup",
    ]) {
      assert.equal(skill.includes(heading), false, `${heading} moved to epic.md`);
    }
  });

  it("resolves every read-next target and fragment", () => {
    for (const name of NAMES) {
      const page = join(SCENARIOS, `${name}.md`);
      const targets = readNext(name);
      assert.ok(targets.length > 0, `${name}.md has a read-next target`);
      for (const target of targets) {
        assert.ok(target.includes("#"), `${name}.md: ${target} names a section`);
        const [pathPart, fragment] = target.split("#");
        assert.ok(fragment.length > 0, `${name}.md: ${target} has a fragment`);
        const file = resolve(dirname(page), pathPart);
        assert.ok(statSync(file).isFile(), `${name}.md: ${target} resolves`);
        assert.ok(headings(read(file)).has(fragment), `${name}.md: ${target} is a heading`);
      }
    }
  });

  it("keeps the one home for the whitelist and the acceptance matrix", () => {
    const tree = markdownFiles(SKILL);
    const whitelist = tree.filter((file) => read(file).includes("<!-- status-whitelist:begin -->"));
    assert.deepEqual(
      whitelist.map((file) => relative(SKILL, file)),
      ["references/lifecycle/transitions.md"],
      "the status whitelist has exactly one home",
    );
    assert.equal(
      read(SKILL_MD).includes("<!-- status-whitelist:begin -->"),
      false,
      "SKILL.md carries no whitelist copy",
    );

    for (const file of [
      join(SKILL, "references/lifecycle/acceptance.md"),
      join(SKILL, "references/review-protocol.md"),
      join(ROOT, "docs/acceptance.md"),
    ]) {
      const text = read(file);
      assert.equal(
        text.split("<!-- acceptance-matrix:begin -->").length - 1,
        1,
        `${relative(ROOT, file)} carries exactly one matrix`,
      );
    }
  });

  it("names every deep-reference directory in the SKILL index", () => {
    const start = skill.indexOf("## Deep references");
    assert.ok(start >= 0, "SKILL.md has a ## Deep references section");
    const table = skill.slice(start);
    for (const dir of ["references/cli/", "references/lifecycle/", "references/schema/"]) {
      assert.ok(table.includes(dir), `the deep references table names ${dir}`);
    }
    for (const file of [
      "references/review-protocol.md",
      "references/projects-json.md",
      "references/capabilities.md",
    ]) {
      assert.ok(table.includes(file), `the deep references table names ${file}`);
    }
  });

  it("does not let a scenario invent a flag the CLI index does not carry", () => {
    const cli = read(CLI_MD);
    const misses = [];
    for (const name of NAMES) {
      // Strip whole markdown links: a heading fragment (`#the-blocked-state--what…`) is not a flag.
      const text = read(join(SCENARIOS, `${name}.md`)).replace(/\[[^\]]*\]\([^)]*\)/g, "");
      for (const match of text.matchAll(/--([a-z][a-z0-9-]*)/g)) {
        const flag = match[1];
        if (!new RegExp(`--${flag}(?![A-Za-z0-9_-])`).test(cli)) {
          misses.push(`${name}.md --${flag}`);
        }
      }
    }
    assert.deepEqual([...new Set(misses)], [], "a scenario names a flag cli.md does not");
  });

  it("holds the token budget", () => {
    assert.ok(size(SKILL_MD) <= 16_500, `SKILL.md is ${size(SKILL_MD)} B (≤ 16.5 KB)`);
    assert.ok(tokens(size(SKILL_MD)) <= 4_200, "SKILL.md stays under 4,200 tokens");
    assert.ok(tokens(size(CLI_MD)) <= 7_000, "cli.md stays under 7,000 tokens");

    for (const name of NAMES) {
      const page = join(SCENARIOS, `${name}.md`);
      assert.ok(tokens(size(page)) <= 2_800, `${name}.md stays under 2,800 tokens`);

      const targets = new Set(
        readNext(name).map((target) => resolve(dirname(page), target.split("#")[0])),
      );
      const cost =
        tokens(size(SKILL_MD)) +
        tokens(size(page)) +
        [...targets].reduce((sum, file) => sum + tokens(size(file)), 0);
      const bound = name === "review" ? 9_500 : 8_000;
      assert.ok(cost <= bound, `${name} loads ${cost} tokens (≤ ${bound})`);
    }

    const total = markdownFiles(SKILL).reduce((sum, file) => sum + size(file), 0);
    // Raised from 230 KB after two shipped features documented themselves in
    // the skill: TP-0033 added 456 B (taskctl loop fields) and TP-0125 947 B
    // (claim-cycle exits, the new transition edges). Raised again, 232 -> 233 KB,
    // after merge 5691d78a unioned its parents (1ea1d7b4 at 231,799 B and
    // 8b0405e8 at 231,807 B) into 232,046 B: neither parent crossed the cap, so
    // no single lane owned the overrun, and TP-0127 then added 9 B for the
    // blocked -> backlog whitelist row. The cap still bounds growth; it is not
    // a target.
    assert.ok(total <= 233_000, `the skill's markdown totals ${total} B (≤ 233 KB)`);
  });

  it("keeps the scenario pages self-contained for their operation", () => {
    const phrases = {
      create: [
        "--as-human",
        "attachment add",
        "plan.md",
        "docs/agents/create-card.md",
        "--status backlog",
        "--meta fixes",
      ],
      edit: ["--as-human", "--acceptance", "--description", "ACCEPTANCE_LOCKED", "issue assign"],
      execute: ["heartbeat", "--no-report", "depends_on", "evidence[n]"],
      epic: ["land on the base branch alone", "same card", "relation add --type parent"],
      review: ["review_of_id", "VERDICT: APPROVE", "move neither card"],
      wait: ["issue wait", "E1", "blocked"],
      setup: ["projects.json", "export watch", "session id"],
    };
    for (const [name, list] of Object.entries(phrases)) {
      const text = read(join(SCENARIOS, `${name}.md`));
      for (const phrase of list) {
        const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        assert.ok(pattern.test(text), `${name}.md covers ${phrase}`);
      }
    }
  });
});

describe("board skill: the split tree", () => {
  it("keeps the deep references under their own directories", () => {
    for (const dir of ["cli", "lifecycle", "schema", "scenarios"]) {
      const files = readdirSync(join(SKILL, "references", dir)).filter((name) =>
        name.endsWith(".md"),
      );
      assert.ok(files.length > 0, `references/${dir} carries pages`);
    }
    assert.equal(basename(SKILL_MD), "SKILL.md");
  });
});
