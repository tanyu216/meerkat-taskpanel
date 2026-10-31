/**
 * Native agent definitions are derived from `role.json`.
 *
 * The installer used to copy static templates; a role edit could leave a stale
 * definition behind. These tests pin the derivation, the per-kind format and the
 * idempotence contract: a re-run changes nothing, and a hand-written file
 * without the generated marker is reported instead of being clobbered.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { writeNativeAgents } from "../../scripts/install/lib/native-agents.mjs";

const dirs = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tp-native-agents-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const role = join(repo, "skills", "jobs");
  mkdirSync(role, { recursive: true });
  writeFileSync(join(role, "SKILL.md"), "---\nname: jobs\n---\n");
  writeFileSync(
    join(role, "role.json"),
    JSON.stringify({
      schema: "meerkat-role",
      id: "jobs",
      agent: "Jobs",
      native_agent: "jobs",
      lanes: ["worker"],
      summary: "Product design",
      description: "Product design and the brief.",
    }),
  );
  return { dir, repo, home: join(dir, "home") };
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("native agent definitions", () => {
  it("writes a Claude markdown definition from role.json", () => {
    const f = fixture();
    const result = writeNativeAgents({ kind: "claude", home: f.home, repo: f.repo });
    assert.equal(result.written.length, 1);
    const text = readFileSync(join(f.home, ".claude", "agents", "jobs.md"), "utf8");
    assert.match(text, /^---\nname: jobs\n/);
    assert.match(text, /tools: Read, Edit, Write, Grep, Glob, Bash/);
    assert.match(text, /skills\/jobs\/SKILL\.md/);
  });

  it("gives a reviewer-lane role a read-only tool set", () => {
    const f = fixture();
    const role = join(f.repo, "skills", "reviewer");
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, "SKILL.md"), "---\nname: reviewer\n---\n");
    writeFileSync(
      join(role, "role.json"),
      JSON.stringify({
        schema: "meerkat-role",
        id: "reviewer",
        agent: "Reviewer",
        native_agent: "reviewer",
        lanes: ["reviewer"],
        description: "Independent review",
      }),
    );
    writeNativeAgents({ kind: "claude", home: f.home, repo: f.repo });
    const text = readFileSync(join(f.home, ".claude", "agents", "reviewer.md"), "utf8");
    assert.match(text, /tools: Read, Grep, Glob, Bash/);
    assert.doesNotMatch(text, /tools:.*Write/);
  });

  it("writes TOML for codex and markdown under .pi for pi", () => {
    const f = fixture();
    writeNativeAgents({ kind: "codex", home: f.home, repo: f.repo });
    writeNativeAgents({ kind: "pi", home: f.home, repo: f.repo });
    assert.match(readFileSync(join(f.home, ".codex", "agents", "jobs.toml"), "utf8"), /name = "jobs"/);
    assert.match(
      readFileSync(join(f.home, ".pi", "agent", "agents", "jobs.md"), "utf8"),
      /^---\nname: jobs\n/,
    );
  });

  it("is idempotent: a second run rewrites nothing", () => {
    const f = fixture();
    writeNativeAgents({ kind: "claude", home: f.home, repo: f.repo });
    const result = writeNativeAgents({ kind: "claude", home: f.home, repo: f.repo });
    assert.equal(result.written.length, 0);
    assert.equal(result.unchanged.length, 1);
  });

  it("reports a file it did not generate instead of overwriting it", () => {
    const f = fixture();
    const dir = join(f.home, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jobs.md"), "hand-written\n");
    const result = writeNativeAgents({ kind: "claude", home: f.home, repo: f.repo });
    assert.deepEqual(result.conflicts, [join(dir, "jobs.md")]);
    assert.equal(readFileSync(join(dir, "jobs.md"), "utf8"), "hand-written\n");
  });

  it("reports a kind with no native format instead of failing", () => {
    const f = fixture();
    const result = writeNativeAgents({ kind: "openclaw", home: f.home, repo: f.repo });
    assert.equal(result.written.length, 0);
    assert.match(result.skipped[0], /no native agent format/);
  });
});
