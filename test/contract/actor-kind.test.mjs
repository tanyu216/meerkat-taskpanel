/**
 * The actor-kind rule: an actor's kind is `human`, the concrete platform a
 * writer runs on (`claude`, `codex`, `pi`, `openclaw`, …), or the board's own
 * kind `system`.
 *
 * What must not appear in our own writes is `taskd` — the retired name, which
 * put the service process on the record as if it were a writer — or `agent`, a
 * category ("not the human") rather than a writer. The schema keeps the column
 * open on purpose — an agent kind may call itself anything — so this is a
 * **repository** rule, enforced statically, not a runtime vocabulary.
 *
 * `system` is the one recording role rather than a platform, and the scan admits
 * it on purpose (2026-10-30): a user reads "system" where they could not read
 * "taskd". The cost that made the older rule ban it is paid elsewhere — no rule
 * trusts a kind any more, because acceptance is decided by the review evidence
 * (an independent current-round APPROVE, never by the actor who wrote it).
 *
 * Historical rows may still carry `taskd`/`system`/`agent`; they are facts about
 * the past and are never rewritten. The scan therefore covers source only, not
 * migrations or test fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { BOARD_ACTOR } from "../../src/core/commands/context.mjs";
import { acceptanceAllows } from "../../src/core/domain/acceptance-mode.mjs";
import {
  HUMAN_KIND,
  ORCHESTRATOR_ACTOR_ID,
  SLA_MECHANISM,
  SYSTEM_KIND,
} from "../../src/foundation/constants.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCAN_ROOTS = ["src", "scripts", "skills"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".worktrees"]);

/** Files this rule reads. Migrations are history, not a writer. */
const EXTENSIONS = new Set([".mjs", ".js", ".sh"]);

const BANNED = [
  {
    name: "the retired `taskd` kind",
    pattern: /\b(?:actorKind|kind|author_kind|actor_kind)\s*[:=]\s*["']taskd["']/,
  },
  {
    name: "a vague `agent` kind",
    pattern: /\b(?:actorKind|kind|author_kind|actor_kind)\s*[:=]\s*["']agent["']/,
  },
  { name: "`--actor-kind taskd`", pattern: /--actor-kind\s+taskd\b/ },
  { name: "`--actor-kind agent`", pattern: /--actor-kind\s+agent\b/ },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      // The migration history is the one place a past kind is allowed to stay.
      if (relative(ROOT, path) === "src/core/storage/migrations") continue;
      yield* walk(path);
    } else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      yield path;
    }
  }
}

describe("contract/actor-kind — concrete writers, not vague roles", () => {
  it("names the board's own kind `system`, and keeps the SLA label apart", () => {
    assert.equal(HUMAN_KIND, "human");
    assert.equal(SYSTEM_KIND, "system");
    assert.deepEqual({ ...BOARD_ACTOR }, { kind: "system", id: "system" });
    // The SLA mechanism is a *label*, not a kind: renaming the kind must not
    // silently re-key every outstanding alert.
    assert.equal(SLA_MECHANISM, "taskd");
    // A kind is no longer an acceptance allow-list: the evidence decides, and a
    // `human` card still admits exactly one kind.
    assert.equal(acceptanceAllows(HUMAN_KIND, "agent"), true);
    assert.equal(acceptanceAllows(SYSTEM_KIND, "human"), false);
    assert.equal(acceptanceAllows("", "agent"), false);
  });

  it("leaves no `taskd` or `agent` kind in a production write", () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      const dir = join(ROOT, root);
      let entries;
      try {
        entries = walk(dir);
      } catch {
        continue; // an optional root that does not exist in this checkout
      }
      for (const file of entries) {
        const text = readFileSync(file, "utf8");
        for (const rule of BANNED) {
          const match = rule.pattern.exec(text);
          if (match === null) continue;
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${relative(ROOT, file)}:${line} — ${rule.name}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `vague actor kinds remain:\n${offenders.join("\n")}`);
  });

  it("no longer exports the retired names", async () => {
    const context = await import("../../src/core/commands/context.mjs");
    const commands = await import("../../src/core/commands/index.mjs");
    const core = await import("../../src/core/index.mjs");
    const constants = await import("../../src/foundation/constants.mjs");
    assert.equal("SYSTEM_ACTOR" in context, false);
    assert.equal("SYSTEM_ACTOR" in commands, false);
    assert.equal("SYSTEM_ACTOR" in core, false);
    assert.equal("BOARD_ACTOR" in commands, true);
    assert.equal("BOARD_ACTOR" in core, true);
    // The retired name is gone rather than aliased: two spellings of one kind is
    // exactly the drift this rule exists to prevent.
    assert.equal("TASKD_KIND" in constants, false);
    assert.equal(ORCHESTRATOR_ACTOR_ID, "Orchestrator");
  });
});
