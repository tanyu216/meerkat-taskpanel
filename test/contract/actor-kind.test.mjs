/**
 * The actor-kind rule: an actor's kind is `human`, or the concrete platform a
 * writer runs on (`claude`, `codex`, `pi`, `opencode`, `openclaw`, `cursor`, …),
 * or the board's own platform name `taskd`.
 *
 * What must not appear in our own writes is a vague role word. `system` names no
 * platform, and `agent` names a category ("not the human") rather than a
 * writer. The schema keeps the column open on purpose — a host may call itself
 * anything — so this is a **repository** rule, enforced statically, not a
 * runtime vocabulary.
 *
 * Historical rows may still carry `system`/`agent`; they are facts about the
 * past and are never rewritten. The scan therefore covers source only, not
 * migrations or test fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { BOARD_ACTOR } from "../../src/core/commands/context.mjs";
import { ACCEPTANCE_ACTOR_KINDS } from "../../src/core/domain/status.mjs";
import { HUMAN_KIND, TASKD_KIND } from "../../src/foundation/constants.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCAN_ROOTS = ["src", "scripts", "skills/meerkat-loop/scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".worktrees"]);

/** Files this rule reads. Migrations are history, not a writer. */
const EXTENSIONS = new Set([".mjs", ".js", ".sh"]);

const BANNED = [
  {
    name: "a vague `system` kind",
    pattern: /\b(?:actorKind|kind|author_kind|actor_kind)\s*[:=]\s*["']system["']/,
  },
  {
    name: "a vague `agent` kind",
    pattern: /\b(?:actorKind|kind|author_kind|actor_kind)\s*[:=]\s*["']agent["']/,
  },
  { name: "`--actor-kind system`", pattern: /--actor-kind\s+system\b/ },
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
  it("names the board with the concrete platform `taskd`", () => {
    assert.equal(HUMAN_KIND, "human");
    assert.equal(TASKD_KIND, "taskd");
    assert.deepEqual({ ...BOARD_ACTOR }, { kind: "taskd", id: "taskd" });
    assert.deepEqual(ACCEPTANCE_ACTOR_KINDS, ["human", "taskd"]);
  });

  it("leaves no `system` or `agent` kind in a production write", () => {
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

  it("no longer exports the old SYSTEM_ACTOR name", async () => {
    const context = await import("../../src/core/commands/context.mjs");
    const commands = await import("../../src/core/commands/index.mjs");
    const core = await import("../../src/core/index.mjs");
    assert.equal("SYSTEM_ACTOR" in context, false);
    assert.equal("SYSTEM_ACTOR" in commands, false);
    assert.equal("SYSTEM_ACTOR" in core, false);
    assert.equal("BOARD_ACTOR" in commands, true);
    assert.equal("BOARD_ACTOR" in core, true);
  });
});
