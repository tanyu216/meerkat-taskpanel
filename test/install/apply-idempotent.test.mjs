/**
 * `apply.mjs` snippet `--force` re-render is byte-idempotent (T-20261010-001800 D3).
 *
 * A `--force` re-render of a file that already contains the rendered block must
 * leave the file byte-identical. Before the fix, the snippet branch built
 * `next = head + block + "\n" + tail` where `block` already ends in `\n`, so the
 * first forced re-render added a trailing blank line (sha256 changed) and only
 * the second forced re-render was stable. The fix drops the extra `"\n"` so one
 * render is already the canonical form.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cmdSnippet } from "../../scripts/install/lib/apply.mjs";

const tempDirs = [];

function makeTempDir(prefix = "taskpanel-apply-idem-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** sha256 of a string, hex — the byte-identity oracle for this suite. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Render a {{TOKEN}}-free snippet template so `cmdSnippet` needs no TP_* env. */
function writeTemplate(dir) {
  const template = join(dir, "AGENTS.md.snippet");
  writeFileSync(template, "You are agent **bob** on the shared Task Panel board.\n", "utf8");
  return template;
}

/** Run `apply.mjs snippet` against a temp file, optionally with --force. */
function renderSnippet(file, template, { force = false } = {}) {
  const argv = [file, template, "--marker", "task-panel"];
  if (force) argv.push("--force");
  return cmdSnippet(argv);
}

describe("apply snippet --force is byte-idempotent (D3)", () => {
  it("a --force re-render of an appended block leaves the file byte-identical", () => {
    const dir = makeTempDir();
    const file = join(dir, "AGENTS.md");
    const template = writeTemplate(dir);

    // Pre-existing content ending in a single newline — the normal Codex case.
    writeFileSync(file, "# My rules\n\nAlways be kind.\n", "utf8");

    renderSnippet(file, template);
    const appended = readFileSync(file, "utf8");
    assert.ok(appended.startsWith("# My rules\n\nAlways be kind.\n"), appended);
    const hAppend = sha256(appended);

    renderSnippet(file, template, { force: true });
    const forcedOnce = readFileSync(file, "utf8");
    const hOnce = sha256(forcedOnce);

    renderSnippet(file, template, { force: true });
    const forcedTwice = readFileSync(file, "utf8");
    const hTwice = sha256(forcedTwice);

    assert.equal(
      hOnce,
      hAppend,
      `--force must not change a correctly rendered file\nappended:\n${appended}\nforced:\n${forcedOnce}`,
    );
    assert.equal(hTwice, hOnce, "a second --force must be byte-stable");
  });

  it("a --force re-render of a freshly appended block (no prior file) is byte-identical", () => {
    const dir = makeTempDir();
    const file = join(dir, "AGENTS.md");
    const template = writeTemplate(dir);

    renderSnippet(file, template);
    const hAppend = sha256(readFileSync(file, "utf8"));

    renderSnippet(file, template, { force: true });
    const hOnce = sha256(readFileSync(file, "utf8"));

    renderSnippet(file, template, { force: true });
    const hTwice = sha256(readFileSync(file, "utf8"));

    assert.equal(hOnce, hAppend, "--force must be a byte no-op on a fresh render");
    assert.equal(hTwice, hOnce, "a second --force must be byte-stable");
  });

  it("--force replaces the block and keeps a following tail with a single separator newline", () => {
    const dir = makeTempDir();
    const file = join(dir, "AGENTS.md");
    const template = writeTemplate(dir);

    writeFileSync(file, "# Top\n<!-- task-panel:begin -->\nold body\n<!-- task-panel:end -->\n# Tail\n", "utf8");

    renderSnippet(file, template, { force: true });
    const out = readFileSync(file, "utf8");

    assert.ok(out.startsWith("# Top\n"), out);
    assert.ok(out.endsWith("<!-- task-panel:end -->\n# Tail\n"), out);
    assert.equal((out.match(/<!-- task-panel:begin -->/g) ?? []).length, 1, "exactly one begin marker");
    assert.equal((out.match(/<!-- task-panel:end -->/g) ?? []).length, 1, "exactly one end marker");
    assert.ok(!out.includes("old body"), "the old block body must be replaced");

    const hOnce = sha256(out);
    renderSnippet(file, template, { force: true });
    assert.equal(sha256(readFileSync(file, "utf8")), hOnce, "re-render must be byte-stable");
  });
});
