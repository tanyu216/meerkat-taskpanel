/**
 * The browser layer (L2) of the block contract, behind a skip guard.
 *
 * The real work lives in `web/scripts/dom-smoke.mjs` (kept out of `test/**` so
 * `node --test` never collects it as a suite). This wrapper runs it and:
 *
 *   * **skips** with a printed reason when the harness reports "no browser"
 *     (exit 2) — no `web/dist`, no Playwright, or no launchable Chromium. That is
 *     the container's normal state: the image carries no browser, and rendering
 *     is a host-allowed exception (plan §9.1 exception 4; `docs/docker.md`).
 *   * **fails** on any other non-zero exit — a contract rule, a console error, a
 *     page error, a viewport overflow or a broken interaction.
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
const HAS_DIST = existsSync(resolve(ROOT, "web/dist/index.html"));

describe("web/blocks.dom — the browser layer", () => {
  it("passes every DOM rule, console/page error and viewport check", (t) => {
    if (!existsSync(SCRIPT)) return t.skip("web/scripts/dom-smoke.mjs is missing");
    if (!HAS_DIST) return t.skip("web/dist is not built — run `npm -w web run build`");

    const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    if (result.status === 2) {
      // The harness could not find a browser; that is a skip, not a failure.
      return t.skip(output.trim() || "browser unavailable");
    }
    t.diagnostic(output.trim());
    assert.equal(result.status, 0, `the DOM harness failed:\n${output}`);
  });
});
