/**
 * The delivery gate (F4: HARD — there is no escape hatch).
 *
 * Moving a task to `in_review` requires a report **for the current delivery
 * round**. A report from an earlier round is not a report: if work came back
 * for rework, the previous conclusion is history, not evidence.
 *
 * The same rule is a trigger in `0003_reports.sql`, so it holds for a writer
 * that bypasses this module. Two implementations, one meaning —
 * `test/contract/state-machine.test.mjs` and `test/core/commands/tasks.test.mjs`
 * check they agree.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { deliverCommandHint } from "../../shared/deliver-hint.mjs";
import { requiresReport } from "./status.mjs";

/**
 * Decide whether a move may proceed.
 *
 * @param {{task: {id: string, identifier?: string, deliveryRound: number}, reports: {round: number}[], to: string}} input
 * @returns {{ok: true}|{ok: false, reason: "REPORT_REQUIRED", round: number, existingRounds: number[], hint: object}}
 */
export function checkDeliveryGate(input) {
  const { task, reports, to } = input;

  if (!requiresReport(to)) return { ok: true };

  const round = task.deliveryRound;
  const rounds = (Array.isArray(reports) ? reports : []).map((report) => report.round);
  if (rounds.includes(round)) return { ok: true };

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
