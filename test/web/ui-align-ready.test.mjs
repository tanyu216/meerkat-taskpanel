/**
 * The `ui-align` manifests' per-navigation **readiness gate** (T-20261014-105807).
 *
 * `tools/ui-align/check.mjs`'s `goto()` is: navigate -> wait `Page.loadEventFired`
 * -> wait the manifest's ready selector -> `sleep(settleMs)` -> probe. The board
 * paints its shell (topbar, sidebar, the seven columns) at mount and fills the
 * **data-driven** half when its reads land, so a gate that is satisfied by the
 * shell is satisfied *before the board has anything in it*. On a host that stalls
 * the reads past `settleMs`, every data-driven row then reads 0 while the shell
 * rows read fine — the false red recorded in
 * `workspace/T-20261014-100326/evidence/uialign-m2-prosefix.json` (34 rows, all in
 * one band, `scope 未命中` / `count=0`, console 0).
 *
 * The engine's fallback when a manifest declares no gate is the first delivered
 * block's first check — `[data-app-shell]`, i.e. exactly the shell selector that
 * is true before the reads land. So a manifest that says nothing gets the gate it
 * must not have, and that is what these assertions are here to catch.
 *
 * They are a **drift guard, not the proof**: they read the manifests the way the
 * engine does, and they cannot observe a browser. The behavioural half — the same
 * tree, the same `web/dist`, the same stalled host, red before and green after —
 * lives in the card's report (§2/§3 of
 * `workspace/T-20261014-105807/report.md`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** Both board manifests are live: `ui-align board` and `ui-align board-m2` are separate gates. */
const MANIFESTS = ["board", "board-m2"];

const read = (page) => JSON.parse(readFileSync(resolve(ROOT, `web/manifests/${page}.json`), "utf8"));

/**
 * The engine's own fallback (`check.mjs` §5), reproduced here so the gate can be
 * compared against the value a silent manifest would get.
 */
function engineFallback(manifest) {
  if (manifest.readySelector) return manifest.readySelector;
  const first = (manifest.blocks ?? []).find((b) => (b.status ?? "delivered") === "delivered");
  return first?.checks?.[0]?.selector ?? null;
}

/** Every reason the declared gate is not a usable one. Empty = fine. */
function gateProblems(manifest) {
  const problems = [];
  const gate = manifest.readySelector;
  if (typeof gate !== "string" || gate.trim().length === 0) {
    problems.push("no readySelector — the engine falls back to the shell selector, which is true before the data reads land");
    return problems;
  }

  /* Bounded by an assertion. The gate must name something the manifest *already*
   * requires to be there: then a missing gate target is a missing asserted block
   * (a red), never a silent extra wait — the readiness gate may delay a verdict,
   * it may not soften one. */
  const asserted = (manifest.blocks ?? [])
    .flatMap((b) => b.checks ?? [])
    .filter((c) => c.selector === gate)
    .filter((c) => (typeof c.min === "number" && c.min >= 1) || (typeof c.count === "number" && c.count >= 1));
  if (asserted.length === 0) {
    problems.push(`readySelector ${gate} is not asserted by this manifest with a positive bound — the gate would wait on something no row checks`);
  }

  /* Not the fallback. The fallback is the shell root: satisfied at mount, so it
   * gates nothing. Declaring it explicitly would be indistinguishable from
   * declaring nothing, and would hide the race behind a key that looks fixed. */
  const fallback = engineFallback({ blocks: manifest.blocks });
  if (gate === fallback) {
    problems.push(`readySelector ${gate} is the engine's own fallback (the first delivered block's first check) — it is satisfied before the board's reads land`);
  }
  return problems;
}

describe("web/ui-align — the boards declare a readiness gate that outlives the shell", () => {
  for (const page of MANIFESTS) {
    it(`${page}.json declares a readySelector`, () => {
      const manifest = read(page);
      assert.equal(typeof manifest.readySelector, "string");
      assert.notEqual(manifest.readySelector.trim(), "");
    });

    it(`${page}.json's readySelector is asserted by the manifest itself`, () => {
      assert.deepEqual(gateProblems(read(page)), []);
    });

    it(`${page}.json's readySelector is not the engine fallback (the shell root)`, () => {
      const manifest = read(page);
      assert.notEqual(manifest.readySelector, engineFallback({ blocks: manifest.blocks }));
    });
  }

  it("the fallback the gate is measured against is really the shell root", () => {
    /* Non-vacuity: if `engineFallback` ever stopped returning the shell selector,
     * the assertion above would pass for the wrong reason. Pin what it is. */
    for (const page of MANIFESTS) {
      const manifest = read(page);
      assert.equal(engineFallback({ blocks: manifest.blocks }), "[data-app-shell]");
    }
  });

  it("the gate predicate rejects the pre-fix configuration", () => {
    /* The negative leg: run the same predicate over a manifest shaped like the
     * one this card fixed — a gate stripped out, and a gate spelled as the shell
     * root — and require it to complain about both. Without this, the suite above
     * could go green on a predicate that says nothing. */
    for (const page of MANIFESTS) {
      const manifest = read(page);
      const stripped = { ...manifest, readySelector: undefined };
      assert.notEqual(gateProblems(stripped).length, 0, `${page}: a manifest with no gate must be rejected`);

      const shellGated = { ...manifest, readySelector: "[data-app-shell]" };
      assert.notEqual(gateProblems(shellGated).length, 0, `${page}: the shell root must be rejected as a gate`);
    }
  });
});
