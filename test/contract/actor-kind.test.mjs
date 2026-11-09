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
 * the past and are never rewritten by a code path. The source scan therefore
 * covers source only, not migrations or test fixtures.
 *
 * Live prose is the third scan. A `dev` commit can introduce a new sentence
 * naming a retired identity after the code already changed, and a textually
 * clean merge carries it in without a conflict (TP-0129 r3). `docs/**`,
 * `GLOSSARY.md` and `skills/**` are instruction-bearing; `docs/adr` is history
 * and `design/` names a demo project, so both sit outside the scan. The one
 * legitimate live mention — a sentence that records the retirement — is listed
 * in `test/fixtures/actor-kind-doc-allowlist.json`, one file and one rule at a
 * time.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

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

/** Instruction-bearing prose. History (docs/adr) and the demo (design/) stay out. */
const DOC_ROOTS = ["docs", "skills"];
const DOC_ROOT_FILES = ["GLOSSARY.md"];
const DOC_SKIP_SUBTREES = new Set(["docs/adr"]);
const DOC_ALLOWLIST = "test/fixtures/actor-kind-doc-allowlist.json";

/**
 * The identity rule in prose. A bare `Orchestrator` is clean outside the ADR
 * history and the demo project, so the simplest form is enough; `system` is only
 * banned in an identity position, because it is the kind those writes carry.
 */
const DOC_IDENTITY_BANNED = [
  { name: "the retired `Orchestrator` identity", pattern: /\bOrchestrator\b/ },
  { name: "the retired `ORCHESTRATOR_ACTOR_ID`", pattern: /\bORCHESTRATOR_ACTOR_ID\b/ },
  {
    name: "an identity-position `system`",
    pattern: /\b(?:actor\s+id|--agent|signed\s+(?:as|by)|signs?\s+as)\s+`?system\b/i,
  },
];

function* walkDocs(root, dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (DOC_SKIP_SUBTREES.has(relative(root, path))) continue;
      yield* walkDocs(root, path);
    } else if (entry.endsWith(".md")) {
      yield path;
    }
  }
}

/** Every Markdown file the live-prose scan reads, under `root`. */
function docFiles(root) {
  const files = [];
  for (const rel of DOC_ROOTS) {
    const dir = join(root, rel);
    try {
      files.push(...walkDocs(root, dir));
    } catch {
      // an optional root that does not exist in this checkout
    }
  }
  for (const rel of DOC_ROOT_FILES) {
    const file = join(root, rel);
    try {
      if (statSync(file).isFile()) files.push(file);
    } catch {
      // absent in a crafted fixture
    }
  }
  return files;
}

/** Every document offender: `{file, line, rule}`. One row per file and rule. */
function docFindings(root, rules = DOC_IDENTITY_BANNED) {
  const findings = [];
  for (const file of docFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const rule of rules) {
      const match = rule.pattern.exec(text);
      if (match === null) continue;
      findings.push({
        file: relative(root, file),
        line: text.slice(0, match.index).split("\n").length,
        rule: rule.name,
      });
    }
  }
  return findings;
}

/** The committed allowlist: one `{file, rule, reason}` per surviving mention. */
function readDocAllowlist(root = ROOT) {
  const parsed = JSON.parse(readFileSync(join(root, DOC_ALLOWLIST), "utf8"));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

const tempRoots = [];
function tempRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "tp-actor-docs-"));
  tempRoots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("contract/actor-kind — live prose", () => {
  it("flags a retired identity in a live document", () => {
    const root = tempRoot({ "docs/a.md": "The verdict is signed as Orchestrator.\n" });
    assert.deepEqual(docFindings(root).map((finding) => finding.file), ["docs/a.md"]);
  });

  it("flags an identity-position `system`, and leaves the kind alone", () => {
    const flagged = tempRoot({ "docs/a.md": "The actor id `system` writes it.\n" });
    assert.equal(docFindings(flagged).length, 1);
    const kind = tempRoot({ "docs/a.md": "The write carries kind `system`.\n" });
    assert.deepEqual(docFindings(kind), []);
  });

  it("skips the ADR history and the demo project", () => {
    const root = tempRoot({
      "docs/adr/0004.md": "signed as Orchestrator\n",
      "design/prototype/x.md": "signed as Orchestrator\n",
    });
    assert.deepEqual(docFindings(root), []);
  });

  it("scans GLOSSARY.md and the skill references", () => {
    const root = tempRoot({
      "GLOSSARY.md": "the actor id Orchestrator\n",
      "skills/x/references/y.md": "signed as Orchestrator\n",
    });
    assert.deepEqual(
      docFindings(root).map((finding) => finding.file).sort(),
      ["GLOSSARY.md", "skills/x/references/y.md"],
    );
  });

  it("accounts for every live-doc finding through the allowlist", () => {
    const entries = readDocAllowlist();
    const findings = docFindings(ROOT);
    const listed = new Set(entries.map((entry) => `${entry.file}|${entry.rule}`));
    const unlisted = findings.filter((finding) => !listed.has(`${finding.file}|${finding.rule}`));
    assert.deepEqual(
      unlisted,
      [],
      `live prose names a retired identity:\n${unlisted
        .map((finding) => `${finding.file}:${finding.line} — ${finding.rule}`)
        .join("\n")}`,
    );

    const known = new Set(DOC_IDENTITY_BANNED.map((rule) => rule.name));
    for (const entry of entries) {
      assert.ok(existsSync(join(ROOT, entry.file)), `allowlist entry file is gone: ${entry.file}`);
      assert.ok(known.has(entry.rule), `allowlist entry names an unknown rule: ${entry.rule}`);
      assert.ok(
        findings.some((finding) => finding.file === entry.file && finding.rule === entry.rule),
        `allowlist entry no longer offends: ${entry.file} / ${entry.rule}`,
      );
      assert.equal(typeof entry.reason, "string", `allowlist entry needs a reason: ${entry.file}`);
      assert.notEqual(entry.reason.trim(), "", `allowlist entry needs a reason: ${entry.file}`);
    }
  });

  it("keeps exactly the one historical sentence in the real docs", () => {
    assert.deepEqual(
      docFindings(ROOT).map((finding) => ({ file: finding.file, rule: finding.rule })),
      [{ file: "docs/events.md", rule: "the retired `Orchestrator` identity" }],
    );
  });
});

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
