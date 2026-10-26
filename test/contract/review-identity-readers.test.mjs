/**
 * The review-identity reader is the only production reader of the legacy meta
 * mirror.
 *
 * The columns (`review_of_id` / `review_round`, 0025) are authoritative. The
 * `meta.review_of` / `meta.review_round` keys are a readable mirror kept for
 * export, legacy rows, and the creation path — if a new module reads them
 * directly, the four-way disagreement this repository just closed comes back.
 * This test is the guard: a new reader must call `reviewIdentityOf` (or be an
 * explicit creation/export exception).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Files allowed to name `meta.review_of` directly:
 *   - the reader itself (the one precedence);
 *   - the creation path, which accepts a legacy `meta.review_of` as an input
 *     and canonicalizes it into the column.
 */
const ALLOW = new Set(["src/foundation/review-identity.mjs", "src/core/commands/tasks.mjs"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (entry.endsWith(".mjs")) out.push(path);
  }
  return out;
}

describe("review identity readers", () => {
  it("only the reader (and the creation/export exceptions) reads meta.review_of", () => {
    const offenders = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (ALLOW.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const code = line.split("//")[0];
        if (code.trim().startsWith("*")) continue; // a block-comment continuation
        if (/\bmeta(?:\?)?\.review_of\b/.test(code)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a review identity read must go through foundation/review-identity.mjs",
    );
  });
});
