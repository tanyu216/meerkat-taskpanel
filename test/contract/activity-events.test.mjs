/**
 * The activity vocabulary is a two-way contract:
 *
 *   * every event a command appends belongs to `ACTIVITY_EVENTS`;
 *   * every declared event has at least one writer, so the enum never grows a
 *     dead word (the two names that had none are removed by this round).
 *
 * The scan reads `activities.append({ … event: "…" … })` call sites. Logger
 * events (`schema_stale`, `label_gc_failed`, `container_sweep`, …) are not
 * activities and are not in scope.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { ACTIVITY_EVENTS } from "../../src/core/domain/enums.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", "migrations"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".mjs")) yield path;
  }
}

/** `event name -> file:line` for every `activities.append({… event: "…" …})`. */
function producers() {
  const found = new Map();
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes("activities.append(")) continue;
      const limit = Math.min(lines.length, i + 40);
      for (let j = i; j < limit; j += 1) {
        const at = lines[j].indexOf("event:");
        if (at !== -1) {
          // One `event:` expression can name more than one literal
          // (`cond ? "report_waived" : "task_moved"`); all of them are writers.
          for (const match of lines[j].slice(at + "event:".length).matchAll(/["']([a-z_]+)["']/g)) {
            found.set(match[1], `${relative(ROOT, file)}:${j + 1}`);
          }
          break;
        }
        if (j > i && /^\s*\}\);?\s*$/.test(lines[j])) break;
      }
    }
  }
  return found;
}

describe("contract/activity-events — the catalogue and its writers agree", () => {
  it("declares the events this round adds", () => {
    for (const name of [
      "project_updated",
      "attachment_added",
      "attachment_updated",
      "attachment_removed",
      "import_completed",
    ]) {
      assert.ok(ACTIVITY_EVENTS.includes(name), `${name} is declared`);
    }
  });

  it("drops the two names no writer ever produced", () => {
    assert.equal(ACTIVITY_EVENTS.includes("dictionary_upsert"), false);
    assert.equal(ACTIVITY_EVENTS.includes("anomaly"), false);
  });

  it("has exactly one vocabulary: no undeclared writer, no unwritten word", () => {
    // `progress` and `import_completed` were written by the markdown importer. That
    // importer is gone; the names stay declared so activity rows it already wrote
    // remain readable, and this list is what keeps a second writer from appearing.
    const historical = new Set(["progress", "import_completed"]);
    const found = producers();
    const declared = new Set(ACTIVITY_EVENTS);
    const undeclared = [...found].filter(([name]) => !declared.has(name)).map(([name, at]) => `${name} at ${at}`);
    const unwritten = ACTIVITY_EVENTS.filter((name) => !found.has(name) && !historical.has(name));
    const resurrected = [...found].filter(([name]) => historical.has(name)).map(([name, at]) => `${name} at ${at}`);
    assert.deepEqual(undeclared, [], `writers outside ACTIVITY_EVENTS:\n${undeclared.join("\n")}`);
    assert.deepEqual(unwritten, [], `declared events with no writer: ${unwritten.join(", ")}`);
    assert.deepEqual(resurrected, [], `historical events must stay writerless:\n${resurrected.join("\n")}`);
  });
});
