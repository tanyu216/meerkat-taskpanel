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
 *
 * **2026-10-15 · C-RAIL-2 P5.** The chip also carries `title` = the full
 * effective prefix (the 24px box fits three characters, so an over-long prefix
 * can only be reached whole through a `title`). A7 is re-cut for it and A7b
 * pins the binding; the containment half of C-RAIL-2 (P1/P2) is a *paint* rule
 * and has no static face, so it lives in `web/scripts/rail-chip-overflow.mjs`
 * (browser, D1/D2).
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
    // C-RAIL-2 P5 re-pin (2026-10-15). The literal used to end at
    // `aria-hidden="true">`; the chip now also carries `:title="project.prefix"`,
    // so the assertion is re-cut to the hook's own three attributes and then
    // *allows* exactly that one supplement after them. This is the red
    // C-RAIL-2 §7 named in advance — not a regression — and the pin stays
    // strict: the class, the data hook and `aria-hidden` are still required,
    // in that order, with nothing else between them and the `title` binding.
    assert.match(
      sidebar,
      /<span class="td-mono" data-side-icon aria-hidden="true"(?:\s+:title="project\.prefix")?>/,
      "[data-side-icon] must keep `td-mono` + `aria-hidden` — the rail chip rule matches on the hook",
    );
    // The chip lives inside the project row, and the nav glyphs still do not
    // wear the hook (B03's count rule in blocks.contract.mjs rests on this).
    const row = sidebar.slice(sidebar.indexOf("data-project-list"));
    assert.ok(row.includes("data-side-icon"), "[data-side-icon] is no longer inside [data-project-list]");
  });

  it("A7b — the chip carries the full prefix in `title` (C-RAIL-2 P5)", () => {
    // The static face of P5. The behavioural face is D4 in
    // `web/scripts/rail-chip-overflow.mjs`, which reads the rendered attribute
    // off the built board; this leg only says the binding is written down, so a
    // `title` silently dropped in a later edit reds a suite that needs no
    // browser. C-RAIL-2 §3.1 P5 asks for `title` = the *complete effective
    // prefix* — i.e. the same binding as the visible text, not a copy of it, so
    // the assertion is that both read `project.prefix`.
    assert.match(
      sidebar,
      /<span class="td-mono" data-side-icon aria-hidden="true" :title="project\.prefix">\{\{\s*project\.prefix\s*\}\}<\/span>/,
      "the chip must bind `title` to the same `project.prefix` it draws (P5)",
    );
  });

  it("A8 — the row's own name source is the prototype's `title` (T-20261015-055434)", () => {
    // The rail hides *every* visible text node of the project row
    // (`[data-side-name]` and `[data-side-count]` are `display:none` at
    // ≤1023px), so name-from-contents yields nothing and the `<button>` is
    // announced unnamed — the chip cannot stand in, because it is `aria-hidden`
    // and its `title` is the *prefix* (A7b), which reaches a pointer and no
    // assistive technology.
    //
    // The prototype already answers this, on the row itself:
    // `design/prototype/index.html` gives every `button.td-side-item[data-project]`
    // a `title` equal to the project name (`title="Orchestrator"`), and `title`
    // is the name computation's **last resort** — so it fires in the rail, where
    // nothing else produces a name, and is outranked by the visible name at
    // ≥1024px, where the row already had one. M6b stage 3 dropped the attribute
    // while re-cutting the row; this pin is what keeps it from being dropped a
    // second time. It needs no browser, so it holds where `web/dist` cannot be
    // built.
    //
    // The behavioural half — the browser's own name computation, measured at
    // both sides of the breakpoint — is D8 in
    // `web/scripts/rail-chip-overflow.mjs`, which does need a build.
    assert.match(
      sidebar,
      /:title="project\.name"/,
      "the project row must carry the prototype's `title` = the project name — the rail's only name source",
    );
    // Deliberately **not** `aria-label`/`aria-labelledby`: either one outranks
    // the row's contents, so it would also rewrite the desktop reading
    // (`MeerkatTaskPanel 12` → `MeerkatTaskPanel`) — a change to a name that was
    // already correct, bought to fix one that was not. `title` fills the rail's
    // empty name and leaves ≥1024px byte-identical.
    const from = sidebar.indexOf("data-project-list");
    const row = sidebar.slice(from, sidebar.indexOf("data-side-icon", from));
    assert.ok(from > -1 && row.includes("data-project"), "the project row region could not be located");
    assert.doesNotMatch(
      row,
      /:aria-label=|aria-labelledby=/,
      "the row's accessible name must not be overridden by an ARIA naming attribute",
    );
  });
});
