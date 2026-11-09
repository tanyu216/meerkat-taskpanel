/**
 * The loop soak's final status judgement (TP-0151).
 *
 * `poolVerdict` (`src/foundation/loop-state.mjs`) already says which kind of
 * live the pool is. The soak only has to decide whether that kind is a pass:
 *
 *   * `running` — idle and heartbeat-fresh;
 *   * `busy` — a tick is in flight and the pid matches. This is the healthy
 *     norm on a soak, not a failure: TP-0034's 40 s and 60 s runs ended `busy`
 *     with a live pid and the old exact-`running` gate reported them as
 *     failures.
 *
 * Everything else fails, including the kinds that still carry a live pid:
 * `wedged` (past its deadline), `unresponsive` (stale heartbeat) and `starting`
 * (the caller's wait should have resolved it). A dead or missing pid is `gone`.
 *
 * Pure: it reads the `probeSupervisor` report shape and decides, nothing else.
 *
 * @param {{verdict?: unknown, pool?: {live?: unknown, poolPid?: unknown, reason?: unknown}}|null} status
 * @returns {{ok: boolean, detail: string}}
 */
export function healthyStatusVerdict(status) {
  const verdict =
    typeof status?.verdict === "string" ? status.verdict : "missing";
  const pool = status?.pool ?? {};
  const poolPid =
    Number.isInteger(pool.poolPid) && pool.poolPid > 0 ? pool.poolPid : null;
  const where = poolPid === null ? "no pool pid" : `pid ${poolPid}`;
  const reason =
    typeof pool.reason === "string" && pool.reason !== "" ? `: ${pool.reason}` : "";

  // Liveness is the pid and its start token, never the heartbeat or the phase.
  // A busy or running verdict without a live pid is a malformed report, not a
  // pass.
  if (pool.live !== true) {
    return { ok: false, detail: `verdict ${verdict} (${where})${reason}` };
  }
  if (verdict === "running" || verdict === "busy") {
    return { ok: true, detail: `verdict ${verdict} with live ${where}` };
  }
  return { ok: false, detail: `verdict ${verdict} with live ${where}${reason}` };
}
