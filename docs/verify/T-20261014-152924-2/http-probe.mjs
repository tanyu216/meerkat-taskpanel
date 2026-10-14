#!/usr/bin/env node
/**
 * T-20261014-152924-2 (seg2) — the same two readings, **over a real socket**.
 *
 * seg1 could not bind (`listen(2)` = `EPERM` in that lane) and therefore drove
 * the route handlers in-process (`repro-claim-release.mjs`,
 * `scan-error-envelope.mjs`). The one thing that left unread was the
 * *transport*: the same assertions, judged on the JSON a client parses off the
 * wire, from a server that actually `listen(2)`ed. This lane runs host-side, so
 * this script closes exactly that gap and nothing else.
 *
 *   1. the shipped suite `test/server/error-envelope.test.mjs` — its two tests
 *      were the two EPERM reds (see `evidence/http-suite.txt`);
 *   2. `POST /api/v1/tasks/:ref/move` `{to:"backlog"}` after a claim and a
 *      release — the request Terry's drag sends — over HTTP, plus the *shape of
 *      the write* that released the claim (`board.db.prepare` is instrumented, so
 *      "the same UPDATE" is read, not taken on faith);
 *   3. the four-value lock set `{in_progress, awaiting, in_review, blocked}` over
 *      HTTP — the claim is retained while the card stays in the work cycle;
 *   4. six real failure families over HTTP, each envelope's `message` judged by
 *      the card's predicate `/constraint failed|SQLITE|SqliteError/`, with the
 *      engine's own words required to survive on `details.sqlite`;
 *   5. the full vocabulary — 56 `ERROR_CODES` × 9 engine messages (504) plus 8
 *      `SQLITE_ERRCODE` × 9 (72) = **576** envelopes — delivered over a real
 *      socket through the shipped `errorResponse` + `sendJson` seam, and read
 *      back off the wire.
 *
 *   node docs/verify/T-20261014-152924-2/http-probe.mjs --root . \
 *     --out docs/verify/T-20261014-152924-2/evidence/http-probe.json
 *
 * Exit 0 ⇔ every assertion holds. `--root` re-points the script at another
 * source tree.
 */

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const flag = name.startsWith("--") ? name : `--${name}`;
  const hit = process.argv.slice(2).find((a) => a === flag || a.startsWith(`${flag}=`));
  if (hit === undefined) return fallback;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const ROOT = resolve(String(arg("--root", resolve(HERE, "../../.."))));
const OUT = arg("--out", null);

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { createTaskd } = await load("src/server/index.mjs");
const { errorResponse, sendJson } = await load("src/server/router.mjs");
const { ERROR_CODES, DomainError, toErrorPayload } = await load("src/shared/errors.mjs");
const { SQLITE_ERRCODE, mapSqliteError } = await load("src/core/storage/sqlite-errors.mjs");
const { CLAIM_HOLDING_STATUSES, holdsClaim } = await load("src/core/domain/status.mjs");

/** The card's ② predicate, spelled exactly as the card spells it. */
const ENGINE_TEXT = /constraint failed|SQLITE|SqliteError/;
/** …and the wider spelling the shipped suite uses (`NOT NULL` / `UNIQUE`). */
const ENGINE_TEXT_WIDE = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;
/** The engine's own words, one per shape (also fed to the 576 sweep). */
const ENGINE_MESSAGES = [
  "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'",
  "CHECK constraint failed: source_task_id <> target_task_id",
  "UNIQUE constraint failed: tasks.project_id, tasks.identifier",
  "UNIQUE constraint failed: nope.a, nope.b",
  "NOT NULL constraint failed: tasks.title",
  "FOREIGN KEY constraint failed",
  'SQLITE_ERROR: near "x": syntax error',
  "SqliteError: SQLITE_MISUSE: bad parameter or other API misuse",
  "SQLITE_BUSY: database is locked",
];

const checks = [];
const readings = [];
let failed = 0;

function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail: detail ?? "" });
  if (ok !== true) failed += 1;
}

// ---------------------------------------------------------------- harness

const dataDir = mkdtempSync(join(tmpdir(), "lane2-http-"));
const taskd = await createTaskd({ dataDir, host: "127.0.0.1", port: 0, env: {} });
const base = taskd.url;
const db = taskd.board.db;
const bound = taskd.server.address();

check(
  "0 · the server bound a real TCP socket (listen(2) succeeded)",
  typeof bound === "object" && bound !== null && bound.port > 0 && base.startsWith("http://"),
  `url=${base} address=${JSON.stringify(bound)}`,
);
readings.push({ step: "bind", url: base, address: bound });

const LINUS = { kind: "agent", id: "linus" };
const asAgent = (id) => ({ "x-taskctl-actor": JSON.stringify({ kind: "agent", id }) });

/** One API call, over the wire. */
async function call(method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, envelope: text === "" ? null : JSON.parse(text) };
}

const dataOf = (result) => result.envelope.data;
const row = (taskId) =>
  db
    .prepare("SELECT status, claimed_by, claimed_at, heartbeat_at, awaiting_reason, blocked_reason FROM tasks WHERE id = ?")
    .get(taskId);

// The only instrumentation in this script: record every prepared statement so
// "the claim was released by the same UPDATE that left the cycle" is a reading
// (the SQL text) and not a restatement of the fix's comment. Repositories hold
// the same handle object, so patching the method is visible everywhere.
const sqlLog = [];
const realPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  sqlLog.push(String(sql));
  return realPrepare(sql);
};
const taskUpdates = (since) => sqlLog.slice(since).filter((sql) => /^\s*UPDATE\s+tasks\b/i.test(sql));

async function project(name) {
  const created = await call("POST", "/api/v1/projects", { name });
  if (created.status === 200) return dataOf(created).project.id;
  const list = dataOf(await call("GET", "/api/v1/projects")).projects;
  return list.find((p) => p.name === name).id;
}

/** One move over HTTP, recorded with the stored row and the SQL it wrote. */
async function move(task, to, body = {}, actor = LINUS) {
  const since = sqlLog.length;
  const from = row(task.id)?.status ?? task.status;
  const result = await call("POST", `/api/v1/tasks/${task.identifier}/move`, { to, ...body }, asAgent(actor.id));
  const stored = result.status === 200 ? row(task.id) : null;
  const updates = result.status === 200 ? taskUpdates(since) : [];
  const reading = {
    step: `${task.identifier}: ${from} → ${to}`,
    http: result.status,
    code: result.status === 200 ? null : (result.envelope?.error?.code ?? "—"),
    message: result.status === 200 ? null : (result.envelope?.error?.message ?? null),
    stored:
      stored === null
        ? null
        : {
            status: stored.status,
            claimed_by: stored.claimed_by,
            claimed_at: stored.claimed_at,
            heartbeat_at: stored.heartbeat_at,
            awaiting_reason: stored.awaiting_reason,
            blocked_reason: stored.blocked_reason,
          },
    updates_on_tasks: updates,
  };
  readings.push(reading);
  return { result, stored, updates };
}

const projectId = await project("Lane2 — real HTTP");

async function card(title, extra = {}) {
  const created = await call("POST", "/api/v1/tasks", { project_id: projectId, title, ...extra });
  if (created.status !== 200) throw new Error(`create failed: ${JSON.stringify(created.envelope)}`);
  return dataOf(created).task;
}

// ---- 1. Terry's drag, over HTTP: in_progress → todo → backlog --------------

const terry = await card("Terry's card");
check(
  "① new card starts in `todo` with no claim",
  terry.status === "todo" && terry.claimed_by === null,
  `status=${terry.status} claimed_by=${terry.claimed_by}`,
);

const claimed = await move(terry, "in_progress");
check(
  "① todo → in_progress takes the claim (heartbeat stamped)",
  claimed.result.status === 200 && claimed.stored.claimed_by === "linus" && typeof claimed.stored.heartbeat_at === "string",
  `http=${claimed.result.status} claimed_by=${claimed.stored?.claimed_by} heartbeat_at=${claimed.stored?.heartbeat_at}`,
);

const backToTodo = await move(terry, "todo");
check(
  "① in_progress → todo returns 200 and clears all three lock columns",
  backToTodo.result.status === 200 &&
    backToTodo.stored.claimed_by === null &&
    backToTodo.stored.claimed_at === null &&
    backToTodo.stored.heartbeat_at === null,
  `http=${backToTodo.result.status} claimed_by=${backToTodo.stored?.claimed_by} claimed_at=${backToTodo.stored?.claimed_at} heartbeat_at=${backToTodo.stored?.heartbeat_at}`,
);

// The *shape* of that write: one UPDATE on `tasks`, and it carries the release.
{
  const updates = backToTodo.updates;
  const sql = updates[0] ?? "";
  check(
    "① the release happened in the **same** UPDATE that left the cycle (one UPDATE on `tasks`)",
    updates.length === 1,
    `updates_on_tasks=${updates.length}`,
  );
  check(
    "① …and that statement sets claimed_by/claimed_at/heartbeat_at to NULL",
    /claimed_by = NULL/.test(sql) && /claimed_at = NULL/.test(sql) && /heartbeat_at = NULL/.test(sql),
    `sql=${JSON.stringify(sql)}`,
  );
}

const toBacklog = await move(terry, "backlog");
check(
  "① todo → backlog returns **200** (the old path was 275 `CHECK constraint failed`) and leaves `claimed_by` NULL",
  toBacklog.result.status === 200 && toBacklog.stored.status === "backlog" && toBacklog.stored.claimed_by === null,
  `http=${toBacklog.result.status} code=${toBacklog.result.status === 200 ? "—" : toBacklog.result.envelope?.error?.code} stored.status=${toBacklog.stored?.status} claimed_by=${toBacklog.stored?.claimed_by}`,
);

const reread = dataOf(await call("GET", `/api/v1/tasks/${terry.identifier}`)).task;
check(
  "① read-back over HTTP agrees: status=backlog, claimed_by=null",
  reread.status === "backlog" && reread.claimed_by === null,
  `status=${reread.status} claimed_by=${reread.claimed_by}`,
);

// ---- 2. the four-value lock set, over HTTP --------------------------------

check(
  "① CLAIM_HOLDING_STATUSES = {in_progress, awaiting, in_review, blocked}",
  JSON.stringify([...CLAIM_HOLDING_STATUSES].sort()) === JSON.stringify(["awaiting", "blocked", "in_progress", "in_review"]),
  JSON.stringify(CLAIM_HOLDING_STATUSES),
);
for (const status of ["awaiting", "blocked", "in_progress", "in_review"]) {
  check(`① holdsClaim(${status}) === true (inside the cycle keeps the lock)`, holdsClaim(status) === true, `holdsClaim=${holdsClaim(status)}`);
}
for (const status of ["backlog", "todo", "done", "canceled"]) {
  check(`① holdsClaim(${status}) === false (leaving the cycle releases)`, holdsClaim(status) === false, `holdsClaim=${holdsClaim(status)}`);
}

// in_progress ↔ awaiting
const paused = await card("Paused for a human");
await move(paused, "in_progress");
const awaiting = await move(paused, "awaiting", { awaiting_reason: "E1" });
check(
  "① in_progress → awaiting keeps the claim (and the write does not touch claimed_by)",
  awaiting.result.status === 200 &&
    awaiting.stored.claimed_by === "linus" &&
    awaiting.stored.awaiting_reason === "E1" &&
    awaiting.updates.every((sql) => !/claimed_by = NULL/.test(sql)),
  `http=${awaiting.result.status} claimed_by=${awaiting.stored?.claimed_by} awaiting_reason=${awaiting.stored?.awaiting_reason}`,
);
const resumed = await move(paused, "in_progress");
check(
  "① awaiting → in_progress keeps the same holder",
  resumed.result.status === 200 && resumed.stored.claimed_by === "linus" && resumed.stored.awaiting_reason === null,
  `http=${resumed.result.status} claimed_by=${resumed.stored?.claimed_by} awaiting_reason=${resumed.stored?.awaiting_reason}`,
);

// in_progress ↔ in_review
const reviewed = await move(paused, "in_review", { no_report: true, reason: "verification probe — a waiver stands in for the report" });
check(
  "① in_progress → in_review keeps the claim",
  reviewed.result.status === 200 && reviewed.stored.claimed_by === "linus",
  `http=${reviewed.result.status} code=${reviewed.result.status === 200 ? "—" : reviewed.result.envelope?.error?.code} claimed_by=${reviewed.stored?.claimed_by}`,
);
const rework = await move(paused, "in_progress");
check(
  "① in_review → in_progress (rework) keeps the same holder",
  rework.result.status === 200 && rework.stored.claimed_by === "linus",
  `http=${rework.result.status} claimed_by=${rework.stored?.claimed_by}`,
);

// in_progress ↔ blocked
const blocked = await move(paused, "blocked");
check(
  "① in_progress → blocked keeps the claim",
  blocked.result.status === 200 && blocked.stored.claimed_by === "linus",
  `http=${blocked.result.status} claimed_by=${blocked.stored?.claimed_by} blocked_reason=${String(blocked.stored?.blocked_reason)}`,
);
const unblocked = await move(paused, "in_progress");
check(
  "① blocked → in_progress (unblock) keeps the same holder",
  unblocked.result.status === 200 && unblocked.stored.claimed_by === "linus",
  `http=${unblocked.result.status} claimed_by=${unblocked.stored?.claimed_by}`,
);

// ---- 3. the six real failure families, over HTTP ---------------------------

const refused = [];
function judge(family, label, result, expectCode, expectEngineOn = null) {
  const error = result.envelope?.error ?? {};
  const message = String(error.message ?? "");
  const detailsSqlite = error.details?.sqlite?.message ?? null;
  const hit = ENGINE_TEXT.test(message);
  refused.push({
    family,
    case: label,
    http: result.status,
    code: error.code,
    message,
    message_has_engine_text: hit,
    details_sqlite_message: detailsSqlite,
  });
  check(`② ${family} · ${label}: refused over HTTP`, result.status >= 400, `http=${result.status}`);
  check(
    `② ${family} · ${label}: message (${error.code}) free of /constraint failed|SQLITE|SqliteError/`,
    hit === false,
    `message=${JSON.stringify(message)}`,
  );
  if (expectCode !== undefined) {
    check(`② ${family} · ${label}: code is ${expectCode}`, error.code === expectCode, `code=${error.code}`);
  }
  if (expectEngineOn !== null && expectEngineOn !== undefined) {
    check(
      `② ${family} · ${label}: the engine's own words survive on details.sqlite`,
      new RegExp(expectEngineOn).test(detailsSqlite ?? ""),
      `details.sqlite.message=${JSON.stringify(detailsSqlite)}`,
    );
  }
  return { error, detailsSqlite };
}

const seed = await card("Envelope seed");
const assigned = await card("For somebody else", { assignee: "linus" });

// (a) 未找到 — NOT_FOUND
judge("not-found", "GET /api/v1/tasks/NOPE-0001", await call("GET", "/api/v1/tasks/NOPE-0001"), "NOT_FOUND");
// (b) 未找到 — an unknown project id
judge("not-found", "create against an unknown project", await call("POST", "/api/v1/tasks", { project_id: "nope", title: "x" }));
// (c) 唯一 — UNIQUE, carrying the engine's own words on details.sqlite
judge(
  "unique",
  "create with a duplicate identifier",
  await call("POST", "/api/v1/tasks", { project_id: projectId, title: "Dup", identifier: seed.identifier }),
  "IDENTIFIER_CONFLICT",
  "UNIQUE constraint failed: tasks\\.project_id, tasks\\.identifier",
);
// (d) 版本冲突 — VERSION_CONFLICT
judge(
  "version",
  "move with a stale if_version",
  await call("POST", `/api/v1/tasks/${seed.identifier}/move`, { to: "in_progress", if_version: 999 }),
  "VERSION_CONFLICT",
);
// (e) 约束 — the CHECK family, refused by the *domain* before the engine (the
//     engine-text shape of the same CHECK is read through the mapper seam below)
judge(
  "constraint (SELF_REFERENCE)",
  "relate a task to itself",
  await call("POST", `/api/v1/tasks/${seed.identifier}/relations`, { type: "blocks", target: seed.identifier }),
  "SELF_REFERENCE",
);
// (f) 约束 — a foreign writer's CHECK violation, judged by the shipped mapper
{
  const foreign = await card("Foreign writer");
  await move(foreign, "in_progress");
  db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(foreign.id); // the pre-fix stored state
  let shaped;
  try {
    db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(foreign.id);
    shaped = { status: 0, payload: { ok: false, error: { code: "—", message: "the write was accepted (unexpected)" } } };
  } catch (err) {
    shaped = errorResponse(mapSqliteError(err, { op: "tasks.moveCas", table: "tasks" }));
  }
  judge("constraint (CHECK)", "foreign writer: a claimed row → backlog", { status: shaped.status, envelope: shaped.payload }, "CLAIM_ON_BACKLOG", "claimed_by IS NULL OR status <> 'backlog'");
}
// (g) routing lock — not_assignee
judge(
  "routing lock",
  "somebody else takes a claim",
  await call("POST", `/api/v1/tasks/${assigned.identifier}/move`, { to: "in_progress" }, asAgent("somebody-else")),
  "not_assignee",
);

// ---- 4. the whole vocabulary, delivered over a real socket -----------------

/**
 * The shipped server's error seam, verbatim — `createTaskd`'s own catch block is
 * `errorResponse(err)` → `sendJson(res, status, payload, headers)`. Serving the
 * synthetic vocabulary through the *same two exports* is what makes the sweep a
 * wire reading rather than an in-process one.
 */
const probes = [];
for (const code of Object.keys(ERROR_CODES)) {
  for (const engine of ENGINE_MESSAGES) {
    probes.push(new DomainError(code, { message: engine, details: { sqlite: { errcode: 275, message: engine } } }));
  }
}
const codeProbeCount = probes.length; // 56 × 9 = 504
for (const errcode of Object.values(SQLITE_ERRCODE)) {
  for (const engine of ENGINE_MESSAGES) {
    const err = new Error(engine);
    err.errcode = errcode;
    err.code = "ERR_SQLITE_ERROR";
    probes.push(mapSqliteError(err, { op: "tasks.probe" }));
  }
}
const errProbeCount = probes.length - codeProbeCount; // 8 × 9 = 72

const envelopeServer = createServer((req, res) => {
  const index = Number((req.url ?? "/").replace(/^\/+/, "").split("?")[0]);
  const err = Number.isInteger(index) && index >= 0 && index < probes.length ? probes[index] : new Error("out of range");
  const { status, payload, headers } = errorResponse(err);
  sendJson(res, status, payload, headers);
});
await new Promise((resolve_, reject) => {
  envelopeServer.once("error", reject);
  envelopeServer.listen(0, "127.0.0.1", () => {
    envelopeServer.removeListener("error", reject);
    resolve_(undefined);
  });
});
const envelopeBase = `http://127.0.0.1:${envelopeServer.address().port}`;

let wireProbes = 0;
let wireHits = 0;
let wireWideHits = 0;
let errPreserved = 0;
const wireHitsRows = [];
for (let i = 0; i < probes.length; i += 1) {
  const response = await fetch(`${envelopeBase}/${i}`);
  const text = await response.text();
  const body = JSON.parse(text);
  const message = String(body?.error?.message ?? "");
  wireProbes += 1;
  if (ENGINE_TEXT.test(message)) {
    wireHits += 1;
    wireHitsRows.push({ index: i, code: body?.error?.code, message });
  }
  if (ENGINE_TEXT_WIDE.test(message)) wireWideHits += 1;
  if (i >= codeProbeCount) {
    const engine = probes[i].details?.sqlite?.message;
    if (body?.error?.details?.sqlite?.message === engine) errPreserved += 1;
  }
}
check(
  `② sweep · ${Object.keys(ERROR_CODES).length} ERROR_CODES × ${ENGINE_MESSAGES.length} engine messages = ${codeProbeCount} envelopes, over a real socket`,
  wireHits === 0,
  `${wireHits}/${codeProbeCount} wire envelopes carry /constraint failed|SQLITE|SqliteError/ in message`,
);
check(
  `② sweep · ${Object.values(SQLITE_ERRCODE).length} SQLITE_ERRCODE × ${ENGINE_MESSAGES.length} = ${errProbeCount} envelopes, over a real socket`,
  wireHits === 0,
  `${wireHits}/${wireProbes} total wire envelopes carry the predicate`,
);
check(
  `② sweep · all ${wireProbes} wire envelopes also clear the wider /…|NOT NULL constraint|UNIQUE constraint/`,
  wireWideHits === 0,
  `${wireWideHits}/${wireProbes} hits on the wide predicate`,
);
check(
  "② sweep · the engine text itself survives on details.sqlite for every mapped errcode failure",
  errPreserved === errProbeCount,
  `${errPreserved}/${errProbeCount} carried details.sqlite.message === the raw engine text`,
);

await new Promise((resolve_) => envelopeServer.close(() => resolve_(undefined)));

// ---------------------------------------------------------------- verdict

await taskd.close();
rmSync(dataDir, { recursive: true, force: true });

const payload = {
  root: ROOT,
  ran_at: new Date().toISOString(),
  transport: "real TCP socket (createTaskd → listen(2)) + fetch() over the wire",
  base_url: base,
  bound_address: bound,
  predicate: String(ENGINE_TEXT),
  real_failure_paths: refused,
  lock_readings: readings.filter((r) => r.step?.includes("→")),
  sweep: {
    wire_probes: wireProbes,
    code_probes: codeProbeCount,
    errcode_probes: errProbeCount,
    hits_narrow: wireHits,
    hits_wide: wireWideHits,
    engine_text_preserved: errPreserved,
  },
  checks,
  failing_checks: checks.filter((c) => !c.ok),
  verdict: failed === 0 ? "PASS" : "FAIL",
};

for (const r of readings.filter((x) => x.step?.includes("→"))) {
  console.log(
    `${r.step.padEnd(34)} http=${String(r.http).padEnd(3)} code=${String(r.code ?? "—").padEnd(20)} claimed_by=${String(r.stored?.claimed_by).padEnd(6)} status=${String(r.stored?.status).padEnd(9)} updates_on_tasks=${r.updates_on_tasks.length}`,
  );
}
console.log("");
for (const r of refused) {
  console.log(
    `${r.family.padEnd(26)} http=${String(r.http).padEnd(3)} code=${String(r.code).padEnd(20)} engine_text_in_message=${r.message_has_engine_text} message=${JSON.stringify(r.message)}`,
  );
}
console.log(
  `\nsweep over the wire: ${wireProbes} envelopes · narrow hits ${wireHits} · wide hits ${wireWideHits} · engine text preserved ${errPreserved}/${errProbeCount}`,
);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}  [${c.detail}]`);
console.log(`\n${checks.length - failed}/${checks.length} checks pass — verdict ${payload.verdict}`);

if (OUT !== null && OUT !== true) {
  mkdirSync(dirname(resolve(String(OUT))), { recursive: true });
  writeFileSync(resolve(String(OUT)), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`readings → ${resolve(String(OUT))}`);
}
process.exit(failed === 0 ? 0 : 1);
