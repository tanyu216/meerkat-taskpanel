/**
 * The browser layer (L2) of the block contract, behind a skip guard.
 *
 * The real work lives in three host-side legs, all kept out of `test/**` so
 * `node --test` never collects them as suites: `web/scripts/dom-smoke.mjs` (the
 * block contract's DOM rules), `web/scripts/combo-menu-geometry.mjs` (the
 * combobox popup's box and row metrics, C-COMBO-1) and
 * `web/scripts/dialog-track-parity.mjs` (the create dialog's box gutter and the
 * two tracks it feeds, prototype against implementation). This wrapper runs each
 * and:
 *
 *   * **skips** with a printed reason when a leg reports "cannot run" (exit 2)
 *     — no `web/dist`, no Playwright, no launchable Chromium, or (for the parity
 *     leg) no `design/prototype/index.html` to compare against. That is the
 *     container's normal state: the image carries no browser, and rendering is a
 *     host-allowed exception (plan §9.1 exception 4; `docs/docker.md`).
 *   * **fails** on any other non-zero exit — a contract rule, a console error, a
 *     page error, a viewport overflow, a broken interaction, or a geometry
 *     assertion that does not hold.
 *
 * **Why the legs share one file.** They are the only checks in the suite that
 * launch a browser, and they run one after the other here on purpose: a second
 * browser-spawning *file* would put two Chromiums on the machine at the same
 * time, and that was measured (2026-10-15, T-20261015-065331) to flake this very
 * file — the whole `test/web` subset failed its `[data-nav]` wait with a second
 * browser in the run, and passed with that leg moved out of `test/**`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SCRIPT = resolve(ROOT, "web/scripts/dom-smoke.mjs");
const COMBO_SCRIPT = resolve(ROOT, "web/scripts/combo-menu-geometry.mjs");
const TRACK_SCRIPT = resolve(ROOT, "web/scripts/dialog-track-parity.mjs");
const HAS_DIST = existsSync(resolve(ROOT, "web/dist/index.html"));

/** Run one host-side leg and translate its exit code into skip / fail / pass. */
function runLeg(t, script, label) {
  if (!existsSync(script)) return t.skip(`${script} is missing`);
  if (!HAS_DIST) return t.skip("web/dist is not built — run `npm -w web run build`");

  const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status === 2) {
    // The leg could not find a browser; that is a skip, not a failure.
    return t.skip(output.trim() || "browser unavailable");
  }
  t.diagnostic(output.trim());
  assert.equal(result.status, 0, `${label} failed:\n${output}`);
}

describe("web/blocks.dom — the browser layer", () => {
  it("passes every DOM rule, console/page error and viewport check", (t) => {
    runLeg(t, SCRIPT, "the DOM harness");
  });

  it("holds the combo popup's box and row metrics on both surfaces", (t) => {
    runLeg(t, COMBO_SCRIPT, "the combo-menu geometry leg");
  });

  it("holds the create dialog's track against the prototype at every two-column viewport", (t) => {
    runLeg(t, TRACK_SCRIPT, "the create-dialog track parity leg");
  });
});
