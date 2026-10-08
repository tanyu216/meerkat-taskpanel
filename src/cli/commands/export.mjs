/**
 * `export md` — the board as markdown cards (A1).
 *
 * The **server renders, the CLI writes**: `POST /api/v1/export` returns
 * `{cards: [{identifier, markdown}]}` and this command decides where they land.
 * A board reachable over the network never writes into a directory a caller
 * named.
 *
 * `--check` is the `migrate-cli` convention reused: compare, write nothing, and
 * exit **3** when something differs. That is the only non-zero exit code that is
 * not an error, and it exists so a CI job can say "the cards are stale" without
 * pretending it crashed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CLI_EXIT } from "../../shared/constants.mjs";
import { fields } from "../output/human.mjs";

/** Where a card goes: `<out>/<IDENTIFIER>.md`. */
export const cardPath = (outDir, identifier) => join(outDir, `${identifier}.md`);

export const COMMANDS = [
  {
    name: "md",
    summary: "Export every task as a markdown card (one file per identifier).",
    usage: "export md [--out <dir>] [--check] [--md]",
    positionals: [],
    flags: [
      { flag: "out", key: "out", as: "string", value: "<dir>", summary: "Directory to write into (default: cwd)." },
      { flag: "project", key: "project", as: "string", value: "<id>", summary: "Limit the export to one project." },
      { flag: "check", key: "check", as: "boolean", summary: "Compare only; exit 3 when a card differs." },
      { flag: "md", key: "md", as: "boolean", summary: "Accepted as a no-op so `export --md` works." },
    ],
    async run(ctx) {
      const outDir = resolve(ctx.flags.out ?? ctx.cwd);
      const { cards } = await ctx.client.post("/api/v1/export", { project_id: ctx.flags.project });

      if (ctx.flags.check === true) {
        const differing = [];
        const missing = [];
        for (const card of cards) {
          const path = cardPath(outDir, card.identifier);
          if (!existsSync(path)) {
            missing.push(card.identifier);
            continue;
          }
          if (readFileSync(path, "utf8") !== card.markdown) differing.push(card.identifier);
        }
        const stale = [...missing, ...differing].sort();
        const human = stale.length === 0
          ? `all ${cards.length} cards match ${outDir}`
          : fields([
              ["cards", cards.length],
              ["missing", missing.length === 0 ? "none" : missing.join(", ")],
              ["differing", differing.length === 0 ? "none" : differing.join(", ")],
            ]);
        return {
          data: { cards: cards.length, missing, differing, up_to_date: stale.length === 0, out: outDir },
          human,
          warnings: stale.length === 0 ? [] : [`${stale.length} card(s) are not up to date; run \`taskctl export md --out ${outDir}\``],
          exit: stale.length === 0 ? CLI_EXIT.OK : CLI_EXIT.DIFFERENCES,
        };
      }

      mkdirSync(outDir, { recursive: true });
      for (const card of cards) writeFileSync(cardPath(outDir, card.identifier), card.markdown, "utf8");
      return {
        data: { cards: cards.length, out: outDir, identifiers: cards.map((card) => card.identifier) },
        human: `wrote ${cards.length} card(s) to ${outDir}`,
      };
    },
  },
];
