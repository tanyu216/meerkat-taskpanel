/**
 * `sla list|get` — the board's SLA read over the CLI.
 *
 * Thin by construction: the board computes the rows (`GET /api/v1/sla`) and
 * this surface only projects the query and renders a table. The loop's patrol
 * calls `sla list` / `sla get <ref>` through `--json`, so this is also the
 * supervisor's transport — not a second implementation.
 *
 * `sla get <ref>` is the pre-emit re-read: the loop asks one card's rows
 * immediately before notifying and drops a row it no longer finds.
 */

import { table } from "../output/human.mjs";

const ALERT_COLUMNS = ["identifier", "sla_row", "severity", "elapsed", "threshold"];

/** @param {object[]} alerts */
function humanTable(alerts) {
  if (alerts.length === 0) return "no SLA alerts";
  return table(
    ALERT_COLUMNS,
    alerts.map((alert) => [
      alert.card_id,
      alert.sla_row,
      alert.severity,
      alert.elapsed_working_min === null ? "-" : `${alert.elapsed_working_min}m`,
      alert.threshold_min === null ? "-" : `${alert.threshold_min}m`,
    ]),
  );
}

const SLA_FLAGS = [
  {
    flag: "period",
    key: "period",
    as: "number",
    value: "<sec>",
    summary: "The mechanism's measurement period (`warn = L − P`); the board's configured value by default.",
  },
  {
    flag: "leader",
    key: "leader",
    as: "string",
    value: "<id>",
    summary: "The actor id the leader writes under (default: the board's human decision authority).",
  },
];

export const COMMANDS = [
  {
    name: "list",
    summary: "The board's SLA rows: every open wait, its tier and its threshold.",
    usage: "sla list [--period <sec>] [--leader <id>] [--limit <n>] [--trail-limit <n>]",
    positionals: [],
    flags: [
      ...SLA_FLAGS,
      { flag: "limit", key: "limit", as: "number", value: "<n>", summary: "The board snapshot cap." },
      {
        flag: "trail-limit",
        key: "trailLimit",
        as: "number",
        value: "<n>",
        summary: "How many cards' comment trails the pass may read.",
      },
    ],
    async run(ctx) {
      const data = await ctx.client.get("/api/v1/sla", {
        query: {
          period: ctx.flags.period,
          leader: ctx.flags.leader,
          limit: ctx.flags.limit,
          trail_limit: ctx.flags.trailLimit,
        },
      });
      return { data, human: humanTable(data.alerts ?? []) };
    },
  },
  {
    name: "get",
    summary: "One card's SLA rows — the loop's pre-emit re-read.",
    usage: "sla get <id|identifier> [--period <sec>] [--leader <id>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: SLA_FLAGS,
    async run(ctx) {
      const data = await ctx.client.get("/api/v1/sla", {
        query: {
          card: ctx.args.ref,
          period: ctx.flags.period,
          leader: ctx.flags.leader,
        },
      });
      return { data, human: humanTable(data.alerts ?? []) };
    },
  },
];
