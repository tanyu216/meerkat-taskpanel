/**
 * The delivery gate: a report for the **current round**, or an audited waiver.
 *
 * Moving a task to `in_review` requires a report for the current delivery round.
 * A report from an earlier round is not a report: if work came back for rework,
 * the previous conclusion is history, not evidence.
 *
 * There is one other way through, added in M2 (F-B1) and deliberately narrow: a
 * waiver that names its round *and* carries a reason of at least
 * `WAIVER_MIN_REASON_CHARS` characters. It is not a bypass — the delivery is
 * stamped on the task row and audited as a `report_waived` activity, so a
 * reviewer sees it. `--no-report --reason "<why>"` is the command.
 *
 * The same rules are a trigger in `0006_report_waiver.sql`, so they hold for a
 * writer that bypasses this module. Two implementations, one meaning —
 * `test/contract/state-machine.test.mjs` and the command tests check they agree.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { deliverCommandHint } from "../../shared/deliver-hint.mjs";
import { requiresReport } from "./status.mjs";

/** Shortest reason that counts as a reason (`--no-report --reason <why>`). */
export const WAIVER_MIN_REASON_CHARS = 8;

/**
 * Does this waiver cover this round?
 *
 * Kept separate (and exported) because the SQL trigger repeats it, the commands
 * validate it before writing, and the tests pin all three to the same answer.
 *
 * @param {{round?: unknown, reason?: unknown}|null|undefined} waiver
 * @param {number} round the task's current delivery round
 */
export function waiverCovers(waiver, round) {
  if (waiver === null || waiver === undefined) return false;
  if (Number(waiver.round) !== Number(round)) return false;
  return typeof waiver.reason === "string" && waiver.reason.trim().length >= WAIVER_MIN_REASON_CHARS;
}

/**
 * Validate the *shape* of a requested waiver, before anything is written.
 *
 * @param {{noReport?: boolean, reason?: unknown, to?: string, hasReport?: boolean}} input
 * @throws {DomainError} VALIDATION_FAILED
 */
export function assertWaiverRequest(input) {
  if (input.to !== undefined && input.to !== "in_review") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `--no-report is only meaningful when moving to in_review (got ${JSON.stringify(input.to)})`,
      details: { field: "to", received: input.to, allowed: ["in_review"] },
      hint: { fix: "drop --no-report for any other transition" },
    });
  }
  if (input.hasReport === true) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "--no-report and --report-file are mutually exclusive",
      details: { fields: ["noReport", "report"] },
      hint: { fix: "send a report, or waive it with a reason — not both" },
    });
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < WAIVER_MIN_REASON_CHARS) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `--no-report needs --reason with at least ${WAIVER_MIN_REASON_CHARS} characters (a waiver is audited, so it has to say why)`,
      details: {
        field: "reason",
        received: typeof input.reason === "string" ? input.reason : null,
        minLength: WAIVER_MIN_REASON_CHARS,
      },
      hint: { fix: 'e.g. --reason "hotfix: report follows in the change comment"' },
    });
  }
  return reason;
}

/**
 * Decide whether a move may proceed.
 *
 * @param {{task: {id: string, identifier?: string, deliveryRound: number}, reports: {round: number}[], to: string, waiver?: {round: number, reason: string}|null}} input
 * @returns {{ok: true, waived?: boolean}|{ok: false, reason: "REPORT_REQUIRED", round: number, existingRounds: number[], hint: object}}
 */
export function checkDeliveryGate(input) {
  const { task, reports, to } = input;

  if (!requiresReport(to)) return { ok: true };

  const round = task.deliveryRound;
  const rounds = (Array.isArray(reports) ? reports : []).map((report) => report.round);
  if (rounds.includes(round)) return { ok: true };
  if (waiverCovers(input.waiver, round)) return { ok: true, waived: true };

  const existingRounds = [...new Set(rounds)].sort((a, b) => a - b);
  return {
    ok: false,
    reason: "REPORT_REQUIRED",
    round,
    existingRounds,
    hint: deliverCommandHint(task.identifier ?? task.id),
  };
}

/**
 * `checkDeliveryGate`, as a throw.
 *
 * @param {Parameters<typeof checkDeliveryGate>[0]} input
 * @throws {DomainError} REPORT_REQUIRED with the round, the rounds on file and
 *   the exact command that fixes it
 */
export function assertDeliveryGate(input) {
  const verdict = checkDeliveryGate(input);
  if (verdict.ok) return true;

  const rounds = verdict.existingRounds.length === 0 ? "none" : verdict.existingRounds.join(", ");
  throw new DomainError("REPORT_REQUIRED", {
    message:
      `cannot move ${input.task.identifier ?? input.task.id} to ${input.to}: ` +
      `no report for delivery round ${verdict.round} (rounds on file: ${rounds})`,
    details: {
      taskId: input.task.id,
      identifier: input.task.identifier ?? null,
      round: verdict.round,
      existingRounds: verdict.existingRounds,
    },
    hint: verdict.hint,
  });
}
