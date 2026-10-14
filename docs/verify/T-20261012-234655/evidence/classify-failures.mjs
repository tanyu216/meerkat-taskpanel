/**
 * Split a `node --test` spec-reporter log into failing tests and classify each
 * by cause, so the report can say exactly how much of the red is the sandbox
 * and how much (if any) is the diff under review.
 *
 * Usage: node classify-failures.mjs <log-file>
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: node classify-failures.mjs <log-file>");
  process.exit(2);
}

const lines = readFileSync(path, "utf8").split("\n");
const start = lines.findIndex((line) => /^✖ failing tests:/.test(line));
const report = start === -1 ? lines : lines.slice(start);

const blocks = [];
let current = null;
for (const line of report) {
  if (/^test at /.test(line)) {
    current = { at: line.trim(), name: null, body: [] };
    blocks.push(current);
    continue;
  }
  if (current === null) continue;
  if (current.name === null && /^✖ /.test(line)) {
    current.name = line.replace(/^✖ /, "").replace(/ \([0-9.]+ms\)$/, "").trim();
    continue;
  }
  current.body.push(line);
}

function classify(block) {
  const text = block.body.join("\n");
  // This sandbox denies bind(2) outright, so a daemon/test fixture that needs a
  // socket dies at `listen`. Downstream, that shows up in several disguises.
  if (/listen EPERM|EPERM/.test(text)) return "sandbox: bind/listen EPERM";
  if (/did not come up|never answered \/health|exited early \(1\)/.test(text)) {
    return "sandbox: fixture never listened (bind EPERM)";
  }
  if (/the first daemon wrote its pointer/.test(text)) return "sandbox: fixture never listened (bind EPERM)";
  if (/is below 80%|node --test exited 1 \(its own thresholds\)/.test(text)) {
    return "cascade: coverage gate starved by unrunnable transport tests";
  }
  if (/did not finish before its parent and was cancelled/.test(text)) return "cascade: parent aborted";
  if (/AssertionError/.test(text)) return "ASSERTION FAILURE — inspect";
  return "other — inspect";
}

const buckets = new Map();
const interesting = [];
for (const block of blocks) {
  const kind = classify(block);
  buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
  if (kind.includes("inspect")) interesting.push({ ...block, kind });
}

console.log(`failing-test blocks: ${blocks.length}`);
for (const [kind, count] of [...buckets].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${kind}`);
}
if (interesting.length > 0) {
  console.log("\nNot explained by the sandbox:");
  for (const block of interesting) {
    console.log(`  [${block.kind}] ${block.name ?? "(unnamed)"}\n     ${block.at}`);
  }
}
