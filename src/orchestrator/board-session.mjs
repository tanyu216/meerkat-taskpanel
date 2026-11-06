/**
 * The board-visible card session row.
 *
 * The drawer's Sessions tab is data-driven, so a running conversation is only
 * visible when somebody writes an `agent_sessions` row through `taskctl`. The
 * pool is that writer: one stable row per card per lane (segment `worker` or
 * `reviewer`), keyed by `(task, seg, owner)` so it survives round bumps, and
 * mirrored turn by turn (`running` while a turn is in flight, `closed` or
 * `failed` on every terminal branch).
 *
 * Every write is best-effort. A board that is down, a CLI that hangs or a row
 * that was never registered only logs — a card turn must never fail because
 * its provenance could not be recorded.
 *
 * Node builtins only; the only process boundary is the injected `runCli`.
 */

import { dirname, resolve } from "node:path";

import { BOARD_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";

import { isProcessAlive, runCli } from "./runtime.mjs";

/** One board write must never hold a turn longer than this. */
export const BOARD_SESSION_CLI_TIMEOUT_MS = 5_000;

/** The `meta.kind` marker that separates these rows from any other session. */
export const BOARD_SESSION_META_KIND = "card-session";

/** A stable segment: one row per card per lane across delivery rounds. */
export const BOARD_SESSION_SEGMENTS = Object.freeze(["worker", "reviewer"]);

/**
 * @param {{
 *   opts: object,
 *   log?: (line: string, meta?: object) => void,
 *   run?: Function,
 *   isAlive?: (pid: number) => boolean,
 * }} input
 * @returns {{
 *   loopId: string|null,
 *   register: (input: object) => object,
 *   close: (input: object) => object,
 *   reconcile: (input: object) => object,
 * }}
 */
export function createBoardSession(input = {}) {
  const opts = input.opts ?? {};
  const log = typeof input.log === "function" ? input.log : () => {};
  const run = typeof input.run === "function" ? input.run : runCli;
  const isAlive = typeof input.isAlive === "function" ? input.isAlive : isProcessAlive;
  // The state directory is unique per loop, so its absolute path is the loop's
  // identity for reconciliation; two boards on one machine must not close each
  // other's rows.
  const loopId = typeof opts.state === "string" && opts.state !== "" ? resolve(dirname(opts.state)) : null;
  const bounded = {
    ...opts,
    cliTimeoutMs: Math.min(
      Number(opts.cliTimeoutMs ?? BOARD_SESSION_CLI_TIMEOUT_MS),
      BOARD_SESSION_CLI_TIMEOUT_MS,
    ),
  };
  let warned = false;

  /**
   * @param {string[]} args
   * @param {{ignore?: string[]}} [options]
   */
  function call(args, options = {}) {
    if (opts.dryRun === true) return { ok: true, dryRun: true };
    const result = run(bounded, BOARD_ACTOR_ID, args, { actorKind: SYSTEM_KIND });
    if (result?.ok === true) return result;
    const ignored = Array.isArray(options.ignore) ? options.ignore : [];
    if (ignored.includes(result?.code)) return result;
    if (!warned) {
      warned = true;
      log(`board session: ${result?.error ?? "board write failed"} — continuing without a row`, {
        level: "warn",
      });
    }
    return result;
  }

  /**
   * Run one session row as `running` (or refresh it for the new round).
   *
   * @param {{card: string, seg: string, owner: string, ownerKind?: string|null, phase?: string|null, pid?: number|null, round?: number, generation?: number, planMode?: string|null, carry?: string|null}} input
   */
  function register(input = {}) {
    const card = String(input.card ?? "");
    const seg = String(input.seg ?? "");
    const owner = String(input.owner ?? "").trim();
    if (card === "" || seg === "" || owner === "") {
      return { ok: false, skipped: true, error: "a session row needs a card, a segment and an owner" };
    }
    const round = Number(input.round ?? 1);
    const generation = Number(input.generation ?? 1);
    const ownerKind = String(input.ownerKind ?? "").trim();
    const args = [
      "session",
      "set",
      card,
      "--seg",
      seg,
      "--owner",
      owner,
      "--owner-kind",
      ownerKind === "" ? "system" : ownerKind,
    ];
    if (typeof input.phase === "string" && input.phase !== "") args.push("--phase", input.phase);
    const pid = Number(input.pid);
    if (Number.isInteger(pid) && pid > 1) args.push("--pid", String(pid));
    // The goal is visible in the drawer without reading `meta`.
    args.push("--goal", `${seg} session for ${card} — round ${Number.isFinite(round) ? round : 1}`);
    args.push("--meta", `kind=${BOARD_SESSION_META_KIND}`);
    if (loopId !== null) args.push("--meta", `loop=${loopId}`);
    args.push("--meta", `round=${Number.isFinite(round) ? round : 1}`);
    args.push("--meta", `generation=${Number.isFinite(generation) ? generation : 1}`);
    if (typeof input.planMode === "string" && input.planMode !== "") {
      args.push("--meta", `plan_mode=${input.planMode}`);
    }
    if (typeof input.carry === "string" && input.carry !== "") {
      args.push("--meta", `carry=${input.carry}`);
    }
    return call(args);
  }

  /**
   * Close the row by its natural key. A row that was never registered (the
   * board was down at the start of the turn) answers `NOT_FOUND`; that is not a
   * failure worth a line.
   *
   * @param {{card: string, seg: string, owner: string, failed?: boolean}} input
   */
  function close(input = {}) {
    const card = String(input.card ?? "");
    const seg = String(input.seg ?? "");
    const owner = String(input.owner ?? "").trim();
    if (card === "" || seg === "" || owner === "") {
      return { ok: false, skipped: true, error: "a session row needs a card, a segment and an owner" };
    }
    const args = ["session", "close", card, "--seg", seg, "--owner", owner];
    if (input.failed === true) args.push("--failed");
    return call(args, { ignore: ["NOT_FOUND"] });
  }

  /**
   * Close the rows a dead pool left `running`.
   *
   * Four filters keep this from closing another loop's work: the row must name
   * this state directory, be a card-session row, not be in this pool's live
   * set, and have no live pid. A failed list closes nothing.
   *
   * @param {{liveKeys?: Set<string>, deadline?: number|null}} input
   */
  function reconcile(input = {}) {
    const listed = call(["session", "list", "--status", "running", "--limit", "1000"]);
    if (listed?.ok !== true) return { ok: false, closed: 0, skipped: 0, failed: 0, timedOut: false };
    const rows = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
    const liveKeys = input.liveKeys instanceof Set ? input.liveKeys : new Set();
    const deadline = Number.isFinite(input.deadline) ? Number(input.deadline) : null;
    let closed = 0;
    let skipped = 0;
    let failed = 0;
    let timedOut = false;
    for (const row of rows) {
      if (deadline !== null && Date.now() > deadline) {
        timedOut = true;
        break;
      }
      const meta = row?.meta !== null && typeof row?.meta === "object" ? row.meta : {};
      if (loopId !== null && String(meta.loop ?? "") !== loopId) {
        skipped += 1;
        continue;
      }
      if (String(meta.kind ?? "") !== BOARD_SESSION_META_KIND) {
        skipped += 1;
        continue;
      }
      const taskId = String(row?.task_id ?? "");
      if (taskId === "" || liveKeys.has(`${taskId}|${row?.seg}|${row?.owner}`)) {
        skipped += 1;
        continue;
      }
      const pid = Number(row?.pid);
      if (Number.isInteger(pid) && pid > 1 && isAlive(pid)) {
        skipped += 1;
        continue;
      }
      const result = close({
        card: taskId,
        seg: String(row?.seg ?? ""),
        owner: String(row?.owner ?? ""),
        failed: true,
      });
      if (result?.ok === true) closed += 1;
      else failed += 1;
    }
    return { ok: true, closed, skipped, failed, timedOut };
  }

  return { loopId, register, close, reconcile };
}
