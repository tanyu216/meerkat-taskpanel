#!/usr/bin/env node
/**
 * T-20261014-152924-2 acceptance ① — the claim-release chain, independently.
 *
 * The report claims: `moveCas` releases `claimed_by/claimed_at/heartbeat_at` in
 * the *same* UPDATE that leaves the work cycle, so
 *
 *   in_progress → todo → backlog
 *
 * (Terry's drag) can no longer trip
 * `CHECK (claimed_by IS NULL OR status <> 'backlog')`, and the card that lands
 * in `backlog` carries `claimed_by IS NULL`. It also claims the **opposite**
 * direction: while the card stays inside the work cycle
 * (`{in_progress, awaiting, in_review, blocked}` — the four-value reading the
 * card's 裁定 批过) the lock is *retained*, so a rework/unblock comes back to
 * the same executor.
 *
 * How this lane can read it: `listen(2)` is denied in this sandbox
 * (`EPERM`, `evidence/env-no-listen.txt`), so `createTaskd` cannot bind. This
 * script therefore drives the **real route handlers** — `registerApiRoutes` on
 * a real router, the same function `src/server/index.mjs#handle` calls — and
 * builds every failure envelope with the **same `errorResponse`** the server
 * writes. Everything below the socket is the shipped code path; the only thing
 * missing is the transport.
 *
 *   node docs/verify/T-20261014-152924-2/repro-claim-release.mjs \
 *     --root . --out docs/verify/T-20261014-152924-2/evidence/repro-claim-release.json
 *
 * Exit 0 ⇔ every assertion holds. `--root` points the script at another source
 * tree (used by `mutations.mjs` for the adversarial replay in ④).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `--flag value` / `--flag=value` / `--bool`. */
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
const { openBoard } = await load("src/core/index.mjs");
const { createRouter, errorResponse } = await load("src/server/router.mjs");
const { registerApiRoutes } = await load("src/server/index.mjs");
const { CLAIM_HOLDING_STATUSES, holdsClaim, ALLOWED_TRANSITIONS } = await load("src/core/domain/status.mjs");
const { mapSqliteError } = await load("src/core/storage/sqlite-errors.mjs");

// ---------------------------------------------------------------- harness

const dataDir = mkdtempSync(join(tmpdir(), "lane2-claim-"));
const board = await openBoard({ dataDir, env: {}, pointer: false });
const router = createRouter();
registerApiRoutes(router, { board, token: board.token });

const LINUS = { kind: "agent", id: "linus" };

/**
 * One API call, in-process. Mirrors `src/server/index.mjs#handle` for JSON
 * routes: match → handler(params/query/body/actor/board) → `errorResponse` on
 * throw. `readJsonBody` is skipped because the body is already an object.
 */
async function call(method, path, body, actor = LINUS) {
  const url = new URL(`http://probe.test${path}`);
  const route = router.match(method, url.pathname);
  if (route === null) {
    return { status: 404, envelope: { ok: false, error: { code: "NOT_FOUND", message: `no route for ${method} ${url.pathname}` } } };
  }
  try {
    const data = await route.handler({
      params: route.params,
      query: url.searchParams,
      body: body ?? {},
      actor,
      session: null,
      seg: null,
      board,
      token: board.token,
    });
    return { status: 200, envelope: { ok: true, data } };
  } catch (err) {
    const { status, payload } = errorResponse(err);
    return { status, envelope: payload };
  }
}

const dataOf = (result) => result.envelope.data;

/** The row as the database actually stores it (not the wire projection). */
const row = (taskId) =>
  board.db
    .prepare("SELECT status, claimed_by, claimed_at, heartbeat_at, version, awaiting_reason, blocked_reason FROM tasks WHERE id = ?")
    .get(taskId);

// ---------------------------------------------------------------- readings

const checks = [];
const readings = [];

function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail: detail ?? "" });
}

async function project(name) {
  const created = await call("POST", "/api/v1/projects", { name });
  if (created.status === 200) return dataOf(created).project.id;
  const list = dataOf(await call("GET", "/api/v1/projects")).projects;
  return list.find((p) => p.name === name).id;
}

const projectId = await project("Lane2 — claim release");

async function card(title, extra = {}) {
  const created = await call("POST", "/api/v1/tasks", { project_id: projectId, title, ...extra });
  if (created.status !== 200) throw new Error(`create failed: ${JSON.stringify(created.envelope)}`);
  return dataOf(created).task;
}

/** One move, recorded: request → envelope → the stored row. */
async function move(task, to, body = {}, actor = LINUS) {
  const result = await call("POST", `/api/v1/tasks/${task.identifier}/move`, { to, ...body }, actor);
  const stored = result.status === 200 ? row(task.id) : null;
  readings.push({
    step: `${task.identifier}: ${task.status} → ${to}`,
    http: result.status,
    code: result.status === 200 ? null : result.envelope.error.code,
    message: result.status === 200 ? null : result.envelope.error.message,
    stored: stored === null ? null : { status: stored.status, claimed_by: stored.claimed_by },
  });
  return { result, stored };
}

// ---- 1. Terry's drag: in_progress → todo → backlog -------------------------

const terry = await card("Terry's card");
check("new card starts in `todo` with no claim", terry.status === "todo" && terry.claimed_by === null, `status=${terry.status} claimed_by=${terry.claimed_by}`);

const claimed = await move(terry, "in_progress");
check(
  "todo → in_progress takes the claim (heartbeat stamped)",
  claimed.result.status === 200 && claimed.stored.claimed_by === "linus" && typeof claimed.stored.heartbeat_at === "string",
  `http=${claimed.result.status} claimed_by=${claimed.stored?.claimed_by} heartbeat_at=${claimed.stored?.heartbeat_at}`,
);

const backToTodo = await move(terry, "todo", {}, LINUS);
check(
  "in_progress → todo **releases** the claim in the same write",
  backToTodo.result.status === 200 &&
    backToTodo.stored.claimed_by === null &&
    backToTodo.stored.claimed_at === null &&
    backToTodo.stored.heartbeat_at === null,
  `http=${backToTodo.result.status} claimed_by=${backToTodo.stored?.claimed_by} claimed_at=${backToTodo.stored?.claimed_at} heartbeat_at=${backToTodo.stored?.heartbeat_at}`,
);

const toBacklog = await move(terry, "backlog");
check(
  "todo → backlog is accepted (no CHECK violation) and leaves claimed_by NULL",
  toBacklog.result.status === 200 && toBacklog.stored.status === "backlog" && toBacklog.stored.claimed_by === null,
  `http=${toBacklog.result.status} code=${toBacklog.result.status === 200 ? "—" : toBacklog.result.envelope.error.code} stored.status=${toBacklog.stored?.status} claimed_by=${toBacklog.stored?.claimed_by}`,
);

// The row the service reads back must agree with the row it returned.
const reread = (await call("GET", `/api/v1/tasks/${terry.identifier}`)).envelope.data.task;
check("read-back agrees: status=backlog, claimed_by=null", reread.status === "backlog" && reread.claimed_by === null, `status=${reread.status} claimed_by=${reread.claimed_by}`);

// ---- 2. the four-value lock set, read from the domain module ---------------

check(
  "CLAIM_HOLDING_STATUSES = {in_progress, awaiting, in_review, blocked}",
  JSON.stringify([...CLAIM_HOLDING_STATUSES].sort()) === JSON.stringify(["awaiting", "blocked", "in_progress", "in_review"]),
  JSON.stringify(CLAIM_HOLDING_STATUSES),
);
for (const status of ["backlog", "todo", "done", "canceled"]) {
  check(`holdsClaim(${status}) === false (leaving the cycle releases)`, holdsClaim(status) === false, `holdsClaim=${holdsClaim(status)}`);
}
for (const status of ["in_progress", "awaiting", "in_review", "blocked"]) {
  check(`holdsClaim(${status}) === true (inside the cycle keeps the lock)`, holdsClaim(status) === true, `holdsClaim=${holdsClaim(status)}`);
}

// ---- 3. in_progress ↔ awaiting: the lock stays -----------------------------

const paused = await card("Paused for a human");
await move(paused, "in_progress");
const awaiting = await move(paused, "awaiting", { awaiting_reason: "E1" });
check(
  "in_progress → awaiting keeps the claim",
  awaiting.result.status === 200 && awaiting.stored.claimed_by === "linus" && awaiting.stored.awaiting_reason === "E1",
  `http=${awaiting.result.status} claimed_by=${awaiting.stored?.claimed_by} awaiting_reason=${awaiting.stored?.awaiting_reason}`,
);
const resumed = await move(paused, "in_progress");
check(
  "awaiting → in_progress keeps the same holder (no re-check of the routing lock)",
  resumed.result.status === 200 && resumed.stored.claimed_by === "linus" && resumed.stored.awaiting_reason === null,
  `http=${resumed.result.status} claimed_by=${resumed.stored?.claimed_by} awaiting_reason=${resumed.stored?.awaiting_reason}`,
);

// ---- 4. in_review / blocked: also inside the cycle -------------------------

const reviewed = await move(paused, "in_review", { no_report: true, reason: "verification probe — the report is not what this card reads for" });
check(
  "in_progress → in_review keeps the claim",
  reviewed.result.status === 200 && reviewed.stored.claimed_by === "linus",
  `http=${reviewed.result.status} code=${reviewed.result.status === 200 ? "—" : reviewed.result.envelope.error.code} claimed_by=${reviewed.stored?.claimed_by}`,
);
const rework = await move(paused, "in_progress");
check("in_review → in_progress (rework) keeps the same holder", rework.result.status === 200 && rework.stored.claimed_by === "linus", `claimed_by=${rework.stored?.claimed_by}`);

const blocked = await move(paused, "blocked");
// NOTE (observed while writing this probe, *not* part of this card): the HTTP
// move route declares no `blocked_reason` field and `registerTaskRoutes` never
// forwards one, so `blocked_reason` is unreachable from this surface even
// though `commands.moveStatus` accepts it (`src/core/domain/enums.mjs`
// `BLOCKED_REASONS`). Registered as an adjacent, unverified observation in the
// report; the claim reading below is what this card is about.
check(
  "in_progress → blocked keeps the claim",
  blocked.result.status === 200 && blocked.stored.claimed_by === "linus",
  `http=${blocked.result.status} claimed_by=${blocked.stored?.claimed_by} blocked_reason=${String(blocked.stored?.blocked_reason)}`,
);
const unblocked = await move(paused, "in_progress");
check("blocked → in_progress (unblock) keeps the same holder", unblocked.result.status === 200 && unblocked.stored.claimed_by === "linus", `claimed_by=${unblocked.stored?.claimed_by}`);

// ---- 5. the exits out of the cycle release it ------------------------------

const canceled = await move(paused, "canceled");
check("in_progress → canceled releases the claim", canceled.result.status === 200 && canceled.stored.claimed_by === null, `claimed_by=${canceled.stored?.claimed_by}`);

const shipped = await card("Shipped card");
await move(shipped, "in_progress");
await move(shipped, "in_review", { no_report: true, reason: "verification probe — waiver stands in for the report" });
const done = await move(shipped, "done");
check(
  "in_review → done releases the claim",
  done.result.status === 200 && done.stored.status === "done" && done.stored.claimed_by === null,
  `http=${done.result.status} status=${done.stored?.status} claimed_by=${done.stored?.claimed_by}`,
);

// ---- 6. the CHECK is still live (only a foreign writer can reach it) -------

const foreign = await card("Foreign writer");
await move(foreign, "in_progress");
// Reconstruct the **pre-fix stored state** with a foreign writer (raw SQL, the
// shape a hand-written row or an md import has): a claimed card sitting in
// `todo`. `in_progress → todo` is whitelisted, so the state machine trigger
// lets the first write through and the claim rides along — exactly what
// `moveCas` used to do on its own.
board.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(foreign.id);
const stale = row(foreign.id);
check(
  "a foreign writer can still leave a claimed card in `todo` (the pre-fix state)",
  stale.status === "todo" && stale.claimed_by === "linus",
  `status=${stale.status} claimed_by=${stale.claimed_by}`,
);

let foreignReading;
try {
  board.db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(foreign.id);
  foreignReading = { threw: false };
} catch (err) {
  const mapped = mapSqliteError(err, { op: "tasks.moveCas", table: "tasks" });
  foreignReading = {
    threw: true,
    errcode: err.errcode,
    sqliteMessage: err.message,
    code: mapped.code,
    message: mapped.message,
    detailsSqlite: mapped.details.sqlite?.message ?? null,
  };
}
check(
  "the schema CHECK is still enforced (a foreign writer is refused)",
  foreignReading.threw === true && foreignReading.errcode === 275 && foreignReading.code === "CLAIM_ON_BACKLOG",
  `errcode=${foreignReading.errcode} code=${foreignReading.code}`,
);
check(
  "…and the engine text stays on details.sqlite, not on the message",
  /claimed_by IS NULL OR status <> 'backlog'/.test(foreignReading.detailsSqlite ?? "") &&
    /constraint failed/.test(foreignReading.message ?? "") === false,
  `message=${JSON.stringify(foreignReading.message)} details.sqlite.message=${JSON.stringify(foreignReading.detailsSqlite)}`,
);

// ---- 7. the transition table the drags ride on -----------------------------

check(
  "in_progress → todo and todo → backlog are both whitelisted",
  ALLOWED_TRANSITIONS.in_progress.includes("todo") && ALLOWED_TRANSITIONS.todo.includes("backlog"),
  `in_progress→[${ALLOWED_TRANSITIONS.in_progress}] todo→[${ALLOWED_TRANSITIONS.todo}]`,
);

// ---------------------------------------------------------------- verdict

board.close();
rmSync(dataDir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const payload = {
  root: ROOT,
  head: null,
  ran_at: new Date().toISOString(),
  transport: "in-process route handlers + errorResponse (no socket; listen(2) is EPERM in this sandbox)",
  checks,
  readings,
  failed: failed.length,
  verdict: failed.length === 0 ? "PASS" : "FAIL",
};

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}  [${c.detail}]`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks pass — verdict ${payload.verdict}`);
if (OUT !== null && OUT !== true) {
  mkdirSync(dirname(resolve(String(OUT))), { recursive: true });
  writeFileSync(resolve(String(OUT)), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`readings → ${resolve(String(OUT))}`);
}
process.exit(failed.length === 0 ? 0 : 1);
