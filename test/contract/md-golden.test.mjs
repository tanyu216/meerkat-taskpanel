/**
 * Step 17: the golden contract (card A10, V9).
 *
 *   fixture → import → export          = golden, byte for byte
 *   fixture → import → export → import = the same rows as the first import
 *   a second import of the same dir    = skipped, not duplicated
 *
 * The two round-trip properties are different questions. Byte equality says the
 * projection is faithful; row-set equality says the *inverse* is faithful — that
 * re-reading an exported card rebuilds the same board rather than a plausible
 * approximation of it.
 *
 * Fixtures are synthetic (F9: this repository is public — no real team cards).
 * A optional real-card smoke run is available via `M1_MD_DIR=<path>`; it asserts
 * only "parses, imports, exports, stays idempotent" and never stores content.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { exportMd } from "../../src/core/storage/md/export.mjs";
import { importMd } from "../../src/core/storage/md/import.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir, reasonCode } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "test/fixtures/md");
const GOLDEN = join(FIXTURES, "golden");
const FIXTURE_FILES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".md"))
  .sort();

/** Import a directory into a fresh board. */
async function importFixtures(dir = FIXTURES) {
  const board = await createTempBoard();
  const repos = createRepositories(board.db);
  const stats = importMd({ db: board.db, repos, dir, now: TS });
  return { ...board, repos, stats };
}

/**
 * A board snapshot that is comparable across two imports.
 *
 * Two imports of the same cards are *not* identical at the row level: task ids
 * are fresh UUIDs and `source_path` names the directory the card came from.
 * Everything else must match, so the snapshot replaces ids with the
 * human-readable identifier and drops the source columns.
 */
function snapshot(db) {
  const identifierOf = new Map(
    db.prepare("SELECT id, identifier FROM tasks").all().map((row) => [row.id, row.identifier]),
  );
  const byIdentifier = (id) => identifierOf.get(id) ?? `<missing:${id}>`;
  const rows = (sql) => db.prepare(sql).all().map((row) => ({ ...row }));
  // Dictionary rows also carry fresh UUIDs; the *name* is what must match.
  const dictionaryNames = new Map(
    rows("SELECT id, display_name FROM assignees")
      .concat(rows("SELECT id, display_name FROM reporters"))
      .map((entry) => [entry.id, entry.display_name]),
  );
  const byName = (id) => (id === null ? null : (dictionaryNames.get(id) ?? `<missing:${id}>`));

  /** Sort by a stable key: SQL cannot order by the human identifier without a join. */
  const sorted = (collection, key) =>
    collection.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  return {
    projects: rows("SELECT id, name, workspace_path, next_task_number, labels, meta_json FROM projects ORDER BY id"),
    tasks: rows("SELECT * FROM tasks ORDER BY identifier").map((task) => {
      const { id, source_path, source_hash, assignee_id, reporter_id, ...rest } = task;
      return { ...rest, assignee: byName(assignee_id), reporter: byName(reporter_id) };
    }),
    task_relations: sorted(rows("SELECT * FROM task_relations ORDER BY id").map((relation) => ({
      type: relation.relation_type,
      source: byIdentifier(relation.source_task_id),
      target: byIdentifier(relation.target_task_id),
      origin: relation.origin,
      created_at: relation.created_at,
    })), (r) => `${r.source}|${r.type}|${r.target}`),
    comments: sorted(rows("SELECT * FROM comments ORDER BY task_id, created_at").map((comment) => ({
      task: byIdentifier(comment.task_id),
      body: comment.body,
      kind: comment.kind,
      author_kind: comment.author_kind,
      author_id: comment.author_id,
      refs_json: comment.refs_json,
      source_seq: comment.source_seq,
      created_at: comment.created_at,
    })), (c) => `${c.task}|${c.created_at}`),
    task_reports: sorted(rows("SELECT * FROM task_reports ORDER BY task_id, round").map((report) => ({
      task: byIdentifier(report.task_id),
      round: report.round,
      conclusion: report.conclusion,
      acceptance_json: report.acceptance_json,
      evidence_json: report.evidence_json,
      leftovers: report.leftovers,
      author_kind: report.author_kind,
      author_id: report.author_id,
      created_at: report.created_at,
    })), (r) => `${r.task}|${r.round}`),
    agent_sessions: sorted(rows("SELECT * FROM agent_sessions ORDER BY task_id, seg").map((session) => ({
      task: byIdentifier(session.task_id),
      seg: session.seg,
      owner: session.owner,
      backend: session.backend,
      session_id: session.session_id,
      phase: session.phase,
      pid: session.pid,
      status: session.status,
      ts: session.ts,
    })), (s) => `${s.task}|${s.seg}`),
    task_activities: rows("SELECT * FROM task_activities ORDER BY id").map((activity) => ({
      task: activity.task_id === null ? null : byIdentifier(activity.task_id),
      event: activity.event,
      changes_json: activity.changes_json,
      created_at: activity.created_at,
    })),
    dictionary: rows("SELECT kind, display_name, normalized_name, use_count FROM assignees ORDER BY normalized_name")
      .map((entry) => ({ table: "assignees", ...entry }))
      .concat(
        rows("SELECT kind, display_name, normalized_name, use_count FROM reporters ORDER BY normalized_name").map(
          (entry) => ({ table: "reporters", ...entry }),
        ),
      ),
  };
}

describe("contract/md-golden — the fixture set", () => {
  it("ships synthetic cards with no real team content", () => {
    assert.ok(FIXTURE_FILES.length >= 6, `expected at least 6 fixtures, found ${FIXTURE_FILES.length}`);
    for (const name of FIXTURE_FILES) {
      assert.match(name, /^[A-Z0-9-]+\.md$/, name);
      const text = readFileSync(join(FIXTURES, name), "utf8");
      assert.equal(text.includes("openclaw"), false, `${name} must not reference the team workspace`);
      assert.equal(/\/Users\//.test(text.replace("/tmp/task-panel-fixture", "")), false, name);
      // No real-person identifiers in fixture data: the synthetic actors are
      // `elon` (human), `linus`/`turing` (agents). `Terry`/`tanyu` are real and
      // must never appear in a public-repo card fixture.
      assert.equal(/\b(Terry|tanyu|tanyu216)\b/i.test(text), false, `${name} carries a real-person identifier`);
      assert.ok(existsSync(join(GOLDEN, name)), `${name} has no golden`);
    }

    // The goldens are committed too, so the guard must cover them: a real name
    // that only ever reached a golden (never the source fixture) would still
    // ship. Scan every golden file, not just the ones matching a fixture name.
    const goldens = readdirSync(GOLDEN).filter((name) => name.endsWith(".md")).sort();
    assert.ok(goldens.length >= FIXTURE_FILES.length, `expected goldens for every fixture, found ${goldens.length}`);
    for (const name of goldens) {
      const text = readFileSync(join(GOLDEN, name), "utf8");
      assert.equal(/\b(Terry|tanyu|tanyu216)\b/i.test(text), false, `golden/${name} carries a real-person identifier`);
    }
  });

  it("covers the cases the plan called out", () => {
    const all = FIXTURE_FILES.map((name) => readFileSync(join(FIXTURES, name), "utf8")).join("\n");
    assert.match(all, /status: ready/, "the v1 alias `ready` must appear");
    assert.match(all, /status: failed/, "the v1 alias `failed` must appear");
    assert.match(all, /git_rules: \|/, "a literal block scalar must appear");
    assert.match(all, /review_notes: >/, "a folded block scalar must appear");
    assert.match(all, /depends_on: \[/, "an inline array must appear");
    assert.match(all, /「/, "non-ASCII text must appear");
    for (const kind of ["discuss", "decision", "confirm", "change", "note", "defect"]) {
      assert.match(all, new RegExp(`· ${kind} ·`), `comment kind ${kind} must appear`);
    }
    assert.match(all, /### R2 ·/, "a second delivery round must appear");
  });
});

describe("contract/md-golden — import → export is byte-stable (V9)", () => {
  it("reproduces every golden file exactly", async () => {
    const board = await importFixtures();
    try {
      const out = join(makeTempDir("md-out-"), "cards");
      const result = exportMd({ repos: board.repos, outDir: out, now: TS });
      assert.equal(result.count, FIXTURE_FILES.length);

      const mismatches = [];
      for (const name of FIXTURE_FILES) {
        const produced = readFileSync(join(out, name), "utf8");
        const expected = readFileSync(join(GOLDEN, name), "utf8");
        if (produced !== expected) {
          const at = firstDifference(produced, expected);
          mismatches.push(`${name}:\n  exported: ${JSON.stringify(produced.split("\n")[at])}\n  golden  : ${JSON.stringify(expected.split("\n")[at])}`);
        }
      }
      assert.deepEqual(mismatches, [], "export and golden must agree byte for byte");
    } finally {
      board.close();
    }
  });

  it("canonicalises the two deliberately non-canonical fixtures, and nothing else", async () => {
    // Two fixtures are deliberately *not* canonical: one uses a folded block
    // scalar, one scrambles the key order. Their goldens show the canonical
    // form — and nothing else may differ.
    const folded = readFileSync(join(FIXTURES, "PROJ-0004.md"), "utf8");
    const foldedGolden = readFileSync(join(GOLDEN, "PROJ-0004.md"), "utf8");
    assert.match(folded, /review_notes: >/);
    assert.match(foldedGolden, /review_notes: \|/);
    assert.match(foldedGolden, /elon asked for the redaction to cover error stacks too, which the shared helper now does\./);

    const scrambled = readFileSync(join(FIXTURES, "PROJ-0006.md"), "utf8");
    const scrambledGolden = readFileSync(join(GOLDEN, "PROJ-0006.md"), "utf8");
    assert.match(scrambledGolden, /^---\nid: PROJ-0006\ntitle: Second delivery round\nassignee: linus\nstatus: in_review/);
    assert.notEqual(scrambled, scrambledGolden);

    // Canonicalisation touches the frontmatter only — the body is untouched.
    assert.equal(bodyOf(scrambled), bodyOf(scrambledGolden));
    assert.equal(bodyOf(folded), bodyOf(foldedGolden));
  });
});

describe("contract/md-golden — export → import rebuilds the same board", () => {
  it("reaches the same rows, twice over", async () => {
    const first = await importFixtures();
    let second;
    try {
      const out = join(makeTempDir("md-out-"), "cards");
      exportMd({ repos: first.repos, outDir: out, now: TS });

      second = await importFixtures(out);
      assert.deepEqual(snapshot(second.db), snapshot(first.db), "a re-import must reproduce the board exactly");

      // Idempotency: a third pass over the same directory changes nothing.
      const third = { db: second.db, repos: second.repos };
      const again = importMd({ db: third.db, repos: third.repos, dir: out, now: TS });
      assert.equal(again.skipped, FIXTURE_FILES.length, "every card is recognised");
      assert.equal(again.tasks, 0);
      assert.equal(again.comments, 0);
      assert.equal(again.reports, 0);
    } finally {
      first.close();
      second?.close();
    }
  });

  it("imports the same fixtures twice into one board without duplicating anything", async () => {
    const board = await importFixtures();
    try {
      const before = snapshot(board.db);
      const again = importMd({ db: board.db, repos: board.repos, dir: FIXTURES, now: TS });
      assert.equal(again.skipped, FIXTURE_FILES.length);
      assert.deepEqual(snapshot(board.db), before, "the second import is a no-op");
    } finally {
      board.close();
    }
  });
});

describe("contract/md-golden — the data that must survive", () => {
  it("restores the legacy status words and keeps the report rounds", async () => {
    const board = await importFixtures();
    try {
      const ready = board.repos.tasks.getByIdentifier("proj", "PROJ-0002");
      assert.equal(ready.status, "todo", "`ready` is stored as todo (F2)");
      assert.equal(ready.meta.legacy_status, "ready");
      const readyCard = readFileSync(join(GOLDEN, "PROJ-0002.md"), "utf8");
      assert.match(readyCard, /^status: ready$/m);

      const failed = board.repos.tasks.getByIdentifier("proj", "PROJ-0003");
      assert.equal(failed.status, "canceled");
      assert.equal(failed.meta.legacy_status, "failed");
      assert.match(readFileSync(join(GOLDEN, "PROJ-0003.md"), "utf8"), /^status: failed$/m);

      const twoRounds = board.repos.tasks.getByIdentifier("proj", "PROJ-0006");
      const reports = board.repos.reports.listByTask(twoRounds.id);
      assert.deepEqual(reports.map((r) => r.round), [1, 2]);
      assert.equal(twoRounds.deliveryRound, 1, "the delivery round is not the report round");
      assert.equal(twoRounds.status, "in_review");
      assert.equal(twoRounds.reportLatestId, reports[1].id);
      assert.equal(reports[0].leftovers, "needs a second pass");
      assert.deepEqual(reports[1].evidence.items[1], {
        kind: "command",
        exit_code: 1,
        cmd: "node --test test/core/domain",
      });
    } finally {
      board.close();
    }
  });

  it("keeps unknown frontmatter keys verbatim and never loses the acceptance checkboxes", async () => {
    const board = await importFixtures();
    try {
      const epic = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.equal(epic.meta.legacy.git_rules, "branch: feat/m1-core\ncommit: explicit paths only\nreview: elon\n");
      assert.equal(epic.meta.notify_leader, "yes");
      assert.deepEqual(epic.meta.acceptance_legacy, [
        { text: "domain has no Node I/O", checked: true },
        { text: "storage uses node:sqlite only", checked: false },
        { text: "migrations are append-only", checked: false },
      ]);
      assert.equal(epic.description.includes("「棋盘」"), true, "non-ASCII survives");
      assert.equal(epic.description.includes("a colon:"), true);
    } finally {
      board.close();
    }
  });

  it("rebuilds relations, comments and sessions", async () => {
    const board = await importFixtures();
    try {
      const epic = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      const child = board.repos.tasks.getByIdentifier("proj", "PROJ-0002");
      assert.equal(board.repos.relations.getParent(child.id).source, epic.id);
      assert.deepEqual(board.repos.relations.listBlockerOf(child.id).map((r) => r.source), [epic.id]);

      const comments = board.repos.comments.list({ taskId: epic.id });
      assert.deepEqual(comments.map((c) => c.kind), ["discuss", "decision", "confirm"]);
      assert.equal(comments[1].body.includes("\n"), true, "a \\n escape becomes a real newline");
      assert.equal(comments[1].body.split("\n").length, 3);
      assert.equal(board.repos.comments.listDecisions(epic.id).length, 2, "two human decisions (I5)");

      const sessions = board.repos.sessions.listByTask(epic.id);
      assert.deepEqual(sessions.map((s) => [s.seg, s.status, s.pid]), [
        ["seg1", "closed", null],
        ["seg2", "running", 4242],
      ]);
      assert.equal(board.repos.activities.list({ taskId: epic.id }).filter((a) => a.event === "progress").length, 2);
      assert.equal(
        board.repos.tasks.getByIdentifier("proj", "PROJ-0002").meta.import_warnings,
        undefined,
        "a todo card needs no report, so there is nothing to warn about",
      );
    } finally {
      board.close();
    }
  });
});

describe("contract/md-golden — notify_leader, and the read-only notify_elon alias", () => {
  it("round-trips the renamed key: import keeps it, export emits it and nothing else", async () => {
    const board = await importFixtures();
    try {
      const epic = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.equal(epic.meta.notify_leader, "yes", "the new key is the persisted one");
      assert.equal(epic.meta.notify_elon, undefined, "the old key is never written");

      const out = join(makeTempDir("md-notify-"), "cards");
      exportMd({ repos: board.repos, outDir: out, now: TS });
      const card = readFileSync(join(out, "PROJ-0001.md"), "utf8");
      assert.match(card, /^notify_leader: yes$/m);
      assert.equal(card.includes("notify_elon"), false, "the old key must not reappear");
      assert.equal(card, readFileSync(join(GOLDEN, "PROJ-0001.md"), "utf8"), "and the card is byte-stable");
    } finally {
      board.close();
    }
  });

  it("reads the legacy notify_elon as an alias — mapped to notify_leader, never left in legacy", async () => {
    // A card written by the team before the rename: `notify_elon`, no `notify_leader`.
    const legacyCard = readFileSync(join(FIXTURES, "PROJ-0001.md"), "utf8").replace("notify_leader: yes", "notify_elon: yes");
    assert.match(legacyCard, /^notify_elon: yes$/m);

    const dir = join(makeTempDir("md-alias-"), "cards");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PROJ-0001.md"), legacyCard, "utf8");

    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      importMd({ db: board.db, repos, dir, now: TS });
      const epic = repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.equal(epic.meta.notify_leader, "yes", "the alias value lands on the canonical key");
      assert.equal(epic.meta.notify_elon, undefined);
      assert.equal(epic.meta.legacy?.notify_elon, undefined, "the alias is recognised, so it is not 'unrecognised'");

      const out = join(makeTempDir("md-alias-out-"), "cards");
      exportMd({ repos, outDir: out, now: TS });
      const card = readFileSync(join(out, "PROJ-0001.md"), "utf8");
      assert.match(card, /^notify_leader: yes$/m);
      assert.equal(card.includes("notify_elon"), false, "the export speaks only the new name");
    } finally {
      board.close();
    }
  });

  it("prefers the new key when a card carries both", async () => {
    const both = readFileSync(join(FIXTURES, "PROJ-0001.md"), "utf8").replace("notify_leader: yes", "notify_elon: no\nnotify_leader: yes");
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    const dir = join(makeTempDir("md-both-"), "cards");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PROJ-0001.md"), both, "utf8");
      importMd({ db: board.db, repos, dir, now: TS });
      const epic = repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.equal(epic.meta.notify_leader, "yes");
      assert.equal(epic.meta.notify_elon, undefined);
      assert.equal(epic.meta.legacy?.notify_elon, undefined);
    } finally {
      board.close();
    }
  });
});

describe("contract/md-golden — source changes are not silently swallowed", () => {
  it("refuses a changed card unless --resume is given", async () => {
    const dir = join(makeTempDir("md-src-"), "cards");
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      mkdirSync(dir, { recursive: true });
      const source = readFileSync(join(FIXTURES, "PROJ-0003.md"), "utf8");
      writeFileSync(join(dir, "PROJ-0003.md"), source, "utf8");
      importMd({ db: board.db, repos, dir, now: TS });

      writeFileSync(join(dir, "PROJ-0003.md"), source.replace("md migrator", "md migrator (revised)"), "utf8");
      assert.equal(reasonCode(() => importMd({ db: board.db, repos, dir, now: TS })), "SOURCE_CHANGED");

      const resumed = importMd({ db: board.db, repos, dir, now: TS, resume: true });
      assert.equal(resumed.updated, 1);
      assert.equal(repos.tasks.getByIdentifier("proj", "PROJ-0003").title, "md migrator (revised)");
    } finally {
      board.close();
    }
  });

  it("refuses to rewrite a card that would grow beyond the guard", async () => {
    const board = await importFixtures();
    try {
      const out = join(makeTempDir("md-grow-"), "cards");
      exportMd({ repos: board.repos, outDir: out, now: TS });
      const target = join(out, "PROJ-0003.md");
      // A stub so small that any real card exceeds 4× it.
      writeFileSync(target, "x", "utf8");
      assert.equal(
        reasonCode(() => exportMd({ repos: board.repos, outDir: out, now: TS })),
        "MD_GROWTH_GUARD",
      );
      assert.equal(readFileSync(target, "utf8"), "x", "the guard refuses before writing");
    } finally {
      board.close();
    }
  });
});

describe("contract/md-golden — optional real-card smoke (never asserts content)", () => {
  const realDir = process.env.M1_MD_DIR;

  it("parses, imports, exports and stays idempotent", { skip: realDir === undefined ? "M1_MD_DIR is not set" : false }, async () => {
    const dir = realDir;
    const board = await createTempBoard();
    try {
      const first = importMd({ db: board.db, repos: board.repos, dir, now: TS });
      assert.ok(first.cards > 0, "expected at least one card");
      const out = join(mkdtempSync(join(tmpdir(), "md-real-")), "cards");
      exportMd({ repos: board.repos, outDir: out, now: TS });
      const second = importMd({ db: board.db, repos: board.repos, dir, now: TS });
      assert.equal(second.skipped, first.cards, "the second pass recognises every card");
    } finally {
      board.close();
    }
  });
});

/** Everything after the frontmatter fence. */
function bodyOf(card) {
  return card.slice(card.indexOf("\n---\n") + 5);
}

/** Index of the first differing line, for a readable failure. */
function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return i;
  }
  return 0;
}
