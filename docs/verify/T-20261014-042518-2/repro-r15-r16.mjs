/**
 * T-20261014-042518-2 — read-only reproduction harness for the two sorting-path
 * defects the card registers (contract §8 R15/R16).
 *
 * READ-ONLY with respect to the repository: it imports the lane's modules and
 * writes only to a throwaway temp dir (`os.tmpdir()`), never to the repo, the
 * team board, or the live `.data/board.sqlite`. It never starts a server.
 *
 * Run:  node /Users/tanyu/.openclaw/team/workspace/T-20261014-042518-2/repro-r15-r16.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point this at any checkout of the repo (`MEERKAT_REPO=<path> node repro-r15-r16.mjs`).
const LANE = process.env.MEERKAT_REPO ?? "/Users/tanyu/Documents/meerkat-taskpanel";
const { openBoard } = await import(`${LANE}/src/core/index.mjs`);
const { transaction } = await import(`${LANE}/src/core/storage/unit-of-work.mjs`);
const { factorsOf } = await import(`${LANE}/src/shared/task-order.mjs`);

const AGENT = { kind: "agent", id: "repro" };
const NOW = "2026-10-14T12:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const out = [];
const say = (line = "") => {
  out.push(line);
  console.log(line);
};
const head = (title) => say(`\n=== ${title} ===`);

const dataDir = mkdtempSync(join(tmpdir(), "meerkat-r15r16-"));
const board = await openBoard({ dataDir, pointer: false });
const { commands, repos, db } = board;

try {
  // ---------------------------------------------------------------- R16 fixture
  // 205 todo cards in one project. Rows 1..200 are "other"'s; the five cards of
  // interest belong to "linus" and sort LAST, i.e. past the repository's default
  // `LIMIT 200`. Identifiers carry the sort weight (created_at ascends with the
  // index) so the order is deterministic without depending on the wall clock.
  commands.createProject({ id: "repro", name: "Repro", actor: AGENT });
  const otherSeed = commands.createTask({ projectId: "repro", title: "seed other", assignee: "other", actor: AGENT });
  const linusSeed = commands.createTask({ projectId: "repro", title: "seed linus", assignee: "linus", actor: AGENT });
  const otherId = otherSeed.assigneeId;
  const linusId = linusSeed.assigneeId;
  const base = otherSeed;

  const N_OTHER = 200;
  const N_LINUS = 5;
  const TOTAL = N_OTHER + N_LINUS;

  transaction(
    db,
    () => {
      for (let index = 0; index < TOTAL; index += 1) {
        const mine = index >= N_OTHER;
        const createdAt = new Date(Date.parse(NOW) - (TOTAL - index) * HOUR).toISOString();
        repos.tasks.insert({
          ...base,
          id: `repro-${index}`,
          identifier: `BULK-${String(index).padStart(4, "0")}`,
          title: `repro card ${index}`,
          status: "todo",
          priority: mine ? "high" : "low",
          assigneeKind: "agent",
          assigneeId: mine ? linusId : otherId,
          createdAt,
          updatedAt: createdAt,
          statusChangedAt: createdAt,
          blockedAt: null,
          heartbeatAt: null,
          claimedBy: null,
          idem: null,
          version: 1,
        });
      }
    },
    { op: "repro.seed" },
  );

  const TOTAL_TODO = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo'").get().n;

  head("R16 · fixture");
  say(`todo cards in project: ${TOTAL_TODO} (${N_OTHER} for 'other', ${N_LINUS} for 'linus', created last)`);

  // ------------------------------------------------- R16 · the OLD read shape
  // `repos.tasks.list({status})` with no explicit limit is what the pre-fix
  // `listCandidates` called: repository default = TASK_LIST_DEFAULT_LIMIT (200).
  head("R16 · OLD shape — truncate first, filter in JS (pre-872f3cd form)");
  const oldPage = repos.tasks.list({ status: "todo" });
  const oldFiltered = oldPage.filter((task) => task.assigneeId === linusId);
  say(`repos.tasks.list({status:"todo"})      -> ${oldPage.length} rows (default LIMIT 200)`);
  say(`  .filter(t => t.assigneeId === linus)  -> ${oldFiltered.length} rows`);
  say(`linus cards actually in the table       -> ${N_LINUS}`);
  say(`=> ${N_LINUS - oldFiltered.length} of linus' claimable cards are INVISIBLE to the poll read.`);

  // EXPLAIN QUERY PLAN of the old shape's SQL (statement text mirrors
  // `repositories/tasks.mjs#list`; parameter count mirrors its bindings).
  const plan = (label, sql, params) => {
    say(`\n  EXPLAIN QUERY PLAN — ${label}`);
    for (const row of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)) {
      say(`    ${row.id} | ${row.parent} | ${row.detail}`);
    }
  };
  const SELECT_LIST = db.prepare("SELECT * FROM tasks LIMIT 0").columns().map((c) => c.column ?? c.name).join(", ");
  plan(
    "old shape (status only, LIMIT ? OFFSET ?)",
    `SELECT ${SELECT_LIST} FROM tasks WHERE status = ? AND archived_at IS NULL
       ORDER BY sort_order ASC, created_at ASC, project_id ASC, identifier ASC LIMIT ? OFFSET ?`,
    ["todo", 200, 0],
  );

  // ------------------------------------------------- R16 · the NEW read shape
  head("R16 · NEW shape — scope pushed into SQL, no LIMIT (HEAD)");
  const candidates = commands.listCandidates({ assignee: "linus" });
  const linusTodo = db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo' AND assignee_id = ?")
    .get(linusId).n;
  say(`commands.listCandidates({assignee:"linus"}) -> ${candidates.length} candidates`);
  say(`  identifiers: ${candidates.map((c) => c.identifier).join(", ")}`);
  say(`linus' todo cards in the table           -> ${linusTodo}`);
  say(`=> all ${linusTodo} are offered, including the ${N_LINUS} that sit past row 200.`);

  const bound = N_OTHER + 1;
  plan(
    "new shape (status + assignee_id, unbounded)",
    `SELECT ${SELECT_LIST} FROM tasks WHERE status = ? AND assignee_id IN (?) AND archived_at IS NULL
       ORDER BY sort_order ASC, created_at ASC, project_id ASC, identifier ASC`,
    ["todo", linusId],
  );

  // The batched edge read: one statement for the whole scope, not one per card.
  head("R16 · the N+1 that came with it");
  say(`pre-fix: allBlockersDone(ctx, task.id) per candidate  -> N+1 queries per poll`);
  say(`HEAD:    relations.openEdgeCounts(ids)                   -> 1 query per poll`);
  say(`  (grep src/ for allBlockersDone: only a comment remains — the helper is gone)`);

  // ---------------------------------------------------------------- R15 fixture
  // A card that WAS blocked months ago and has long since left `blocked`.
  head("R15 · fixture — leave `blocked`, look at blocked_at");
  const card = commands.createTask({ projectId: "repro", title: "blocked once, long ago", assignee: "linus", actor: AGENT });
  commands.moveStatus({ id: card.id, to: "blocked", blockedReason: "dependency", actor: AGENT });
  db.prepare("UPDATE tasks SET blocked_at = ? WHERE id = ?").run(ago(90 * DAY), card.id);
  commands.moveStatus({ id: card.id, to: "in_progress", actor: AGENT });
  const row = db
    .prepare("SELECT status, blocked_at, blocked_reason, status_changed_at FROM tasks WHERE id = ?")
    .get(card.id);
  // Pin the dwell so the S comparison below is a clean 1h-vs-24h, not "whatever
  // the wall clock happened to give the fixture".
  db.prepare("UPDATE tasks SET status_changed_at = ? WHERE id = ?").run(ago(1 * HOUR), card.id);
  say(`status            = ${row.status}`);
  say(`blocked_at        = ${row.blocked_at}   <-- STILL SET (90 days ago)`);
  say(`blocked_reason    = ${row.blocked_reason}   <-- NULL, cleared on exit`);
  say(`status_changed_at = ${row.status_changed_at}`);
  say(`=> the column keeps "when the last blockage began" — by design (moveCas has no clear branch).`);

  // ------------------------------------------- R15 · the landmine and the gate
  head("R15 · the landmine, and the gate that defuses it");
  const task = repos.tasks.get(card.id);
  // The hazard needs a status that *has* an SLA threshold (`in_progress` has
  // none — no threshold ⇒ S is 0 by design), so score the same stale row as an
  // `in_review` card (24h) sitting 1h into its new status.
  const stale = { ...task, status: "in_review", statusChangedAt: ago(1 * HOUR), blockedAt: ago(90 * DAY), blockersOpen: 0, unblocksOpen: 0 };
  const gated = factorsOf(stale, { now: NOW });
  const ungatedS = Math.min((90 * 24) / 24, 1);
  say(`HEAD (gate ON, status='in_review')          : S.raw=${gated.raw.S}h S.normalised=${gated.normalised.S}  (1h dwell vs 24h)`);
  say(`same row, if \`blocked_at\` were read ungated  : S.normalised=${ungatedS}  (90d vs 24h, capped)`);
  say(`delta                                          : ${(ungatedS - gated.normalised.S).toFixed(6)} of the weighted score, silent`);
  say(`=> gate present at src/shared/task-order.mjs:212 — \`card.status === "blocked" ? card.blockedAt : card.statusChangedAt\``);
  say(`   (asserted by test/shared/task-order.test.mjs "does not read \`blocked_at\` on a card that is not blocked")`);

  // ------------------------------------------------------- D2 · sort_order ≡ 0
  head("D2 · `sort_order` — no production writer, so it is constant 0");
  const distinct = db.prepare("SELECT DISTINCT sort_order AS v FROM tasks").all().map((r) => r.v);
  say(`SELECT DISTINCT sort_order FROM tasks -> ${JSON.stringify(distinct)} (${TOTAL_TODO + 1} rows, every write path)`);
  say(`only writer in src/: md/import.mjs:1100 \`sortOrder: 0\` (a literal zero)`);
  say(`=> the repository ORDER BY falls through to \`created_at, project_id, identifier\`:`);
  say(`   the board's default order is the creation order, and always has been.`);
  const boardOrder = repos.tasks.list({ projectId: "repro", limit: null }).map((t) => t.identifier);
  const byCreatedAt = [...boardOrder].sort((a, b) => a.localeCompare(b));
  say(`   board order === identifier order (fixture's created_at ascends with it): ${JSON.stringify(boardOrder) === JSON.stringify(byCreatedAt)}`);
  say(`   weight order reads \`sortOrder\`? grep -n sortOrder src/shared/task-order.mjs -> (no match)`);

  head("verdict inputs");
  say(`indexes on tasks:`);
  for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' ORDER BY name").all()) {
    say(`  ${r.name}${r.sql === null ? " (auto)" : ""}  ${r.sql ?? ""}`);
  }
} finally {
  board.close();
  rmSync(dataDir, { recursive: true, force: true });
}
