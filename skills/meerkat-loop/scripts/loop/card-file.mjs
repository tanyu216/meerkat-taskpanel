/**
 * The card brief on disk: `.meerkat/<identifier>/card.md`.
 *
 * A claimed card is exported **before the claim** (the admission gate) so a
 * failure defers the card unclaimed, then refreshed once after the claim so the
 * snapshot is not left at `todo`. The subscriber keeps active cards fresh in
 * batches from the event stream.
 *
 * Every write is the CLI's markdown, byte for byte: `taskctl export md <ref>
 * --out <tmp>.md`, then an atomic rename over `card.md`. The loop never edits
 * the file. Two consequences of the temp+rename discipline are deliberate:
 *
 *   * a reader never sees a half-written brief, and
 *   * `export md`'s 4× growth guard (`MD_GROWTH_GUARD`) only inspects an
 *     existing target. A machine-generated brief legitimately grows when
 *     comments or a report land, so the guard must not turn a refresh into a
 *     refusal. The unique temp path is always fresh.
 *
 * Node builtins only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { CARD_BRIEF_FILE, cardDirRel } from "../foundation/card-brief.mjs";
import { readCards } from "./queue.mjs";
import { runCli } from "./runtime.mjs";

/** Queue rows whose card may still be worked (and whose brief should follow). */
export const ACTIVE_CARD_STATUSES = Object.freeze(["pending", "processing"]);

/**
 * Export one card to `<targetDir>/.meerkat/<identifier>/card.md`.
 *
 * @param {{
 *   opts: object,
 *   agent: string,
 *   targetDir: string,
 *   identifier: string,
 *   run?: Function,
 *   log?: (line: string) => void,
 * }} input
 * @returns {{ok: boolean, path?: string, unchanged?: boolean, error?: string}}
 */
export function exportCardFile(input) {
  const { opts, agent, targetDir, identifier } = input;
  const run = input.run ?? runCli;
  const log = input.log ?? (() => {});
  const label = String(identifier ?? "");
  if (!isAbsolute(String(targetDir ?? ""))) {
    return { ok: false, error: `target directory is not absolute: ${targetDir}` };
  }

  const dir = join(targetDir, cardDirRel(label));
  const final = join(dir, CARD_BRIEF_FILE);
  const temp = join(
    dir,
    `card.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp.md`,
  );
  let renamed = false;

  try {
    mkdirSync(dir, { recursive: true });
    const exported = run(opts, agent, ["export", "md", label, "--out", temp]);
    if (exported?.ok !== true) {
      return { ok: false, error: exported?.error ?? "export md failed" };
    }
    if (!existsSync(temp)) {
      return { ok: false, error: "export md reported success but wrote no file" };
    }
    const next = readFileSync(temp, "utf8");
    if (next.length === 0) {
      return { ok: false, error: "export md wrote an empty brief" };
    }
    if (existsSync(final) && readFileSync(final, "utf8") === next) {
      return { ok: true, path: final, unchanged: true };
    }
    renameSync(temp, final);
    renamed = true;
    log(`card brief: wrote ${final}`);
    return { ok: true, path: final };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (!renamed) {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* best effort: a leftover temp is not the caller's problem */
      }
    }
  }
}

/**
 * The active cards in a queue snapshot, and the original each review audits.
 *
 * @param {object[]} rows
 * @returns {Array<{identifier: string, reviewOf: string|null}>}
 */
export function activeCards(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!ACTIVE_CARD_STATUSES.includes(row?.status)) continue;
    const identifier = typeof row?.card === "string" ? row.card.trim() : "";
    if (identifier === "") continue;
    const reviewOf = typeof row?.review_of === "string" && row.review_of.trim() !== ""
      ? row.review_of.trim()
      : null;
    out.push({ identifier, reviewOf });
  }
  return out;
}

/**
 * Which task identifiers an event refreshes: the card itself, plus the original
 * when the row is a review card. Events carry the card's UUID (`task_id`), not
 * its identifier; an unknown UUID refreshes nothing (never guess from prose).
 *
 * @param {{task_id?: unknown}} event
 * @param {object[]} rows
 * @returns {string[]}
 */
export function identifiersForEvent(event, rows) {
  const taskId = typeof event?.task_id === "string" ? event.task_id : "";
  if (taskId === "") return [];
  const found = new Set();
  for (const row of rows ?? []) {
    if (row?.task_id !== taskId) continue;
    if (!ACTIVE_CARD_STATUSES.includes(row?.status)) continue;
    const identifier = typeof row?.card === "string" ? row.card.trim() : "";
    if (identifier !== "") found.add(identifier);
    const reviewOf = typeof row?.review_of === "string" ? row.review_of.trim() : "";
    if (reviewOf !== "") found.add(reviewOf);
  }
  return [...found];
}

/**
 * Refresh the briefs of the active cards named by a batch of event UUIDs.
 *
 * Reads the queue fresh (a row may have completed since the event arrived),
 * de-duplicates identifiers, and never throws: one failed card is logged and
 * the previous brief stays in place.
 *
 * @param {{
 *   opts: object,
 *   stateDir: string|null|undefined,
 *   taskIds: Iterable<string>,
 *   run?: Function,
 *   log?: (line: string) => void,
 * }} input
 * @returns {{refreshed: number, failed: number}}
 */
export function refreshCardsForIds(input) {
  const { opts, stateDir } = input;
  const run = input.run ?? runCli;
  const log = input.log ?? (() => {});
  const wanted = new Set(
    [...(input.taskIds ?? [])].map((value) => String(value ?? "")).filter((value) => value !== ""),
  );
  if (stateDir === null || stateDir === undefined || stateDir === "" || wanted.size === 0) {
    return { refreshed: 0, failed: 0 };
  }

  const read = readCards(String(stateDir));
  if (read.error !== null) {
    log(`card refresh: cannot read the card queue: ${read.error}`);
    return { refreshed: 0, failed: 0 };
  }

  const targets = new Map();
  for (const row of read.value?.cards ?? []) {
    if (!ACTIVE_CARD_STATUSES.includes(row?.status)) continue;
    if (!wanted.has(String(row?.task_id ?? ""))) continue;
    const targetDir = String(row?.target_dir ?? "");
    if (!isAbsolute(targetDir)) continue;
    const agent = typeof row?.agent === "string" && row.agent !== "" ? row.agent : opts?.agents?.[0];
    for (const identifier of identifiersForEvent({ task_id: row.task_id }, [row])) {
      targets.set(identifier, { targetDir, agent });
    }
  }

  let refreshed = 0;
  let failed = 0;
  for (const [identifier, target] of targets) {
    const outcome = exportCardFile({
      opts,
      agent: target.agent,
      targetDir: target.targetDir,
      identifier,
      run,
      log,
    });
    if (outcome.ok) refreshed += 1;
    else {
      failed += 1;
      log(`card refresh: ${identifier}: ${outcome.error}`);
    }
  }
  return { refreshed, failed };
}
