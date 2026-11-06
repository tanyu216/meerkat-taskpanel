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
 * A kind is not an identity. Since ADR 0018 the board's one automation identity
 * is the actor id `Board`; `system` is only the kind those writes carry, and the
 * loop no longer signs `Orchestrator`. The second scan here is the grep guard for
 * that rule: a write path may not name either retired id.
 *
 * Historical rows may still carry `taskd`/`system`/`agent`; they are facts about
 * the past and are never rewritten by a code path. The scan therefore covers
 * source only, not migrations or test fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { BOARD_ACTOR } from "../../src/core/commands/context.mjs";
import { acceptanceAllows } from "../../src/core/domain/acceptance-mode.mjs";
import {
  BOARD_ACTOR_ID,
  DIRECTOR_ACTOR_ID,
  HUMAN_KIND,
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

/**
 * The identity rule (ADR 0018): `system` is a kind, never an actor id, and the
 * loop no longer signs `Orchestrator`. Each pattern is an identity position a
 * writer actually uses — a CLI argv, a JS actor object, or the retired constant —
 * so prose and the one-off repair script may still name the old rows.
 */
const IDENTITY_BANNED = [
  { name: "`--agent system`", pattern: /--agent\s+["']?system\b/ },
  { name: "`--agent Orchestrator`", pattern: /--agent\s+["']?Orchestrator\b/ },
  {
    name: "an actor id literal `system`",
    pattern: /\b(?:actorId|actor_id|authorId|author_id|id)\s*:\s*["']system["']/,
  },
  {
    name: "an actor id literal `Orchestrator`",
    pattern: /\b(?:actorId|actor_id|authorId|author_id|id)\s*:\s*["']Orchestrator["']/,
  },
  { name: "an actor id built from the `system` kind", pattern: /\b(?:actorId|id)\s*:\s*SYSTEM_KIND\b/ },
  { name: "the retired `ORCHESTRATOR_ACTOR_ID`", pattern: /\bORCHESTRATOR_ACTOR_ID\b/ },
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

/** Every source offender for a rule set, as `path:line — rule`. */
function scanSources(rules) {
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
      for (const rule of rules) {
        const match = rule.pattern.exec(text);
        if (match === null) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(ROOT, file)}:${line} — ${rule.name}`);
      }
    }
  }
  return offenders;
}

describe("contract/actor-kind — concrete writers, not vague roles", () => {
  it("names the board's own kind `system`, and keeps the SLA label apart", () => {
    assert.equal(HUMAN_KIND, "human");
    assert.equal(SYSTEM_KIND, "system");
    assert.deepEqual({ ...BOARD_ACTOR }, { kind: "system", id: "Board" });
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
    const offenders = scanSources(BANNED);
    assert.deepEqual(offenders, [], `vague actor kinds remain:\n${offenders.join("\n")}`);
  });

  it("writes the one automation identity `Board`, never actor id `system` or `Orchestrator`", () => {
    assert.equal(BOARD_ACTOR_ID, "Board");
    assert.notEqual(BOARD_ACTOR_ID, SYSTEM_KIND, "the identity is not the kind");
    const offenders = scanSources(IDENTITY_BANNED);
    assert.deepEqual(offenders, [], `retired automation identities remain:\n${offenders.join("\n")}`);
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
    // The identity is one name: the loop's old id is gone, not aliased.
    assert.equal("ORCHESTRATOR_ACTOR_ID" in constants, false);
    assert.equal(BOARD_ACTOR_ID, "Board");
    assert.equal(DIRECTOR_ACTOR_ID, "Director");
  });
});
