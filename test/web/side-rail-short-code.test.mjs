/**
 * C-RAIL-1 — the sidebar rail's project short code (`.td-side-icon`) is the
 * project's **effective prefix**, read off the wire and rendered verbatim.
 *
 * This file replaces `test/web/monogram.test.mjs`. That one pinned
 * `initialsOf` — the name-derived monogram — and it was the *only* place in the
 * tree that wrote "the chip comes from the name" down as a contract; with the
 * ruling that reading is retired, so is the function and its test
 * (C-RAIL-1 §6.2/§6.4). What the chip is made of now is a **wire fact**, pinned
 * where the wire is projected (`test/cli/output.test.mjs`, `projectToWire`) —
 * and the rules below are the half that is a property of the *web source*:
 *
 *   * nothing in `web/src/**` derives the chip (no name, no case transform);
 *   * the derivation function has exactly one definition, server-side;
 *   * the rail hook's shape did not move (C-RAIL-1 §8 A1/A2/A3/A7).
 *
 * **Scope note (§6.7).** "No case transform in `web/src`" is deliberately
 * *not* a repo-wide ban on `.toUpperCase()`: the card and drawer still uppercase
 * the first character of an **assignee's name** for the avatar monogram
 * (`components/board/Card.vue`, `components/detail/DetailDrawer.vue`), and
 * C-RAIL-1 §6.7 rules that out of scope — a person's initial and a project's
 * prefix are two objects with two rules. The rule here is the one C-PREFIX-1
 * §9 A3/A5 states: no *second* derivation or normalization of a **project
 * prefix** in the browser.
 *
 * Static text reading only — no browser, no build, so it runs anywhere.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SRC = resolve(ROOT, "web/src");
const SIDEBAR = resolve(SRC, "components/shell/Sidebar.vue");

/** Every `.vue` / `.js` file under `web/src`, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".vue") || name.endsWith(".js")) out.push(path);
  }
  return out;
}

/** @type {string} */
const sidebar = readFileSync(SIDEBAR, "utf8");

describe("web · C-RAIL-1 — the rail chip is the project's effective prefix", () => {
  it("A1 — the project row takes the chip from `project.prefix`, never from the name", () => {
    assert.match(
      sidebar,
      /prefix:\s*project\.prefix\b/,
      "Sidebar.vue must read the chip off the wire (`prefix: project.prefix`)",
    );
    assert.match(
      sidebar,
      /\{\{\s*project\.prefix\s*\}\}/,
      "the [data-side-icon] span must interpolate project.prefix verbatim",
    );
    assert.doesNotMatch(
      sidebar,
      /initialsOf/,
      "the name-derived monogram must not be reachable from the sidebar",
    );
    // The name is still rendered — as the row's *label*, in its own span. The
    // rule is that it does not feed the chip, so the two hooks must not be the
    // same element and the chip must not mention `.name`.
    const chip = sidebar.match(/<span[^>]*data-side-icon[^>]*>([\s\S]*?)<\/span>/);
    assert.ok(chip, "the project row no longer carries a [data-side-icon] span");
    assert.doesNotMatch(chip[1], /\.name/, "the chip must not render the project name");
  });

  it("A2 — the name-derived monogram is gone, and nothing else consumed it", () => {
    assert.equal(
      existsSync(resolve(SRC, "lib/monogram.js")),
      false,
      "web/src/lib/monogram.js should be deleted, not kept as a way back",
    );

    const consumers = [];
    for (const path of sourceFiles(SRC)) {
      if (/\binitialsOf\b/.test(readFileSync(path, "utf8"))) consumers.push(relative(ROOT, path));
    }
    assert.deepEqual(consumers, [], "`initialsOf` still has a consumer under web/src");
  });

  it("A3 — no case transform and no folding regex anywhere on the chip's path", () => {
    assert.doesNotMatch(
      sidebar,
      /toUpperCase|toLowerCase|\.replace\(/,
      "the chip is rendered verbatim; the sidebar must not transform the value",
    );
    // C-PREFIX-1 §9 A5, restated: the browser holds no second copy of
    // `identifierPrefix`'s folding step.
    const folders = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      // A character-class negation followed by a quantifier — the shape every
      // copy of "fold the non-alphanumerics" takes (`/[^A-Za-z0-9]+/g`).
      if (/\/\[\^[A-Za-z0-9-]+\]\s*\+?\s*\/[a-z]*/.test(text)) folders.push(relative(ROOT, path));
    }
    assert.deepEqual(folders, [], "web/src must not fold non-alphanumerics (one normalization, server-side)");
  });

  it("A7 — the rail hook kept its shape (one element, two faces)", () => {
    assert.match(
      sidebar,
      /<span class="td-mono" data-side-icon aria-hidden="true">/,
      "[data-side-icon] must keep `td-mono` + `aria-hidden` — the rail chip rule matches on the hook",
    );
    // The chip lives inside the project row, and the nav glyphs still do not
    // wear the hook (B03's count rule in blocks.contract.mjs rests on this).
    const row = sidebar.slice(sidebar.indexOf("data-project-list"));
    assert.ok(row.includes("data-side-icon"), "[data-side-icon] is no longer inside [data-project-list]");
  });
});
