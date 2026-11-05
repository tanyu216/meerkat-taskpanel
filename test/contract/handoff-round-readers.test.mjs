/**
 * The handoff-round marker has one reader.
 *
 * Three layers ask "did the director settle this producer's round?": the triage
 * lane (`board.mjs`), the triage completion check (`runtime.mjs`) and the doctor
 * (`doctor.mjs`). Each used to run `Number(meta.handoff_consumed_round)`, which
 * silently disagreed with the loop's own prompt (`record the created refs in the
 * value`): an annotated marker read as NaN, so a consumed handoff was proposed
 * again. The precedence now lives in `foundation/handoff-round.mjs`; this test
 * is the guard against a fourth spelling reappearing.
 *
 * The writer side is exempt on purpose: `scheduling.mjs` builds the prompt text
 * that tells the director which key to write — it reads no marker.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The reader itself — the one place the precedence is written down. */
const ALLOW = new Set(["src/foundation/handoff-round.mjs"]);

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

/** The two shapes that interpreted the marker before the reader existed. */
const INTERPRETATIONS = [
  /\bNumber\(\s*meta\??\.(?:handoff_consumed_round|handoff_declined_round)\b/,
  /\bmeta\??\.(?:handoff_consumed_round|handoff_declined_round)\b\s*(?:===|!==|==|!=)/,
];

describe("handoff round readers", () => {
  it("only the reader interprets meta.handoff_consumed_round / handoff_declined_round", () => {
    const offenders = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (ALLOW.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const code = line.split("//")[0];
        if (code.trim().startsWith("*")) continue; // a block-comment continuation
        if (INTERPRETATIONS.some((pattern) => pattern.test(code))) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a handoff round read must go through foundation/handoff-round.mjs",
    );
  });
});
