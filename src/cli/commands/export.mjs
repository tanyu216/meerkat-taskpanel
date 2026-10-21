/**
 * `export md` — the board as markdown cards (A1).
 *
 * The **server renders, the CLI writes**: `POST /api/v1/export` returns
 * `{cards: [{identifier, markdown}]}` and this command decides where they land.
 * A board reachable over the network never writes into a directory a caller
 * named.
 *
 * With no positional, every card is exported: one `<IDENTIFIER>.md` per card
 * under `--out`. With `<ref>`, only that card is exported — into `--out` as a
 * directory, or, when `--out` names a `.md` path, into that one file. Either
 * way the markdown is the server's, byte for byte.
 *
 * `--check` compares, writes nothing, and exits **3** when something differs.
 * That is the only non-zero exit code that is not an error, and it exists so a
 * CI job can say "the cards are stale" without pretending it crashed.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CLI_EXIT, MD_GROWTH_FACTOR } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { usageError } from "../../foundation/transport/errors.mjs";
import { fields } from "../output/human.mjs";

/** Where a card goes: `<out>/<IDENTIFIER>.md`. */
export const cardPath = (outDir, identifier) => join(outDir, `${identifier}.md`);

/**
 * The file each card is written to (or compared against), as a pure plan.
 *
 * `fileMode` is the single-card, single-file shape: the caller named one file,
 * so exactly one card may claim it. A board that answered with more is a
 * protocol failure — overwriting the same path with several cards would leave
 * one arbitrary card behind and report success.
 *
 * @param {Array<{identifier: string, markdown: string}>} cards
 * @param {{fileMode: boolean, out: string}} options `out` is a directory unless `fileMode`
 * @returns {Array<{card: object, path: string}>}
 */
export function planTargets(cards, { fileMode, out }) {
  if (!fileMode) return cards.map((card) => ({ card, path: cardPath(out, card.identifier) }));
  if (cards.length !== 1) {
    throw new DomainError("CLI_IO", {
      message: `export md: a single-file target needs exactly one card, got ${cards.length}`,
      details: { cards: cards.length },
    });
  }
  return [{ card: cards[0], path: out }];
}

/**
 * The same rewrite guard `core/storage/md/export.mjs#exportMd` applies.
 *
 * The CLI path used to skip it (the core exporter has no production caller).
 * It now runs before every overwrite, for the whole-board and single-card
 * shapes alike: a card that grew past `MD_GROWTH_FACTOR` times its previous
 * file is refused rather than silently overwritten. `--check` never writes, so
 * it never reaches this.
 *
 * @param {string} path
 * @param {string} content
 */
export function assertGrowthGuard(path, content) {
  if (!existsSync(path)) return;
  const previous = readFileSync(path, "utf8");
  if (previous.length === 0) return;
  if (content.length <= previous.length * MD_GROWTH_FACTOR) return;
  throw new DomainError("MD_GROWTH_GUARD", {
    message: `${basename(path)}: rewriting this card would grow it ${(content.length / previous.length).toFixed(1)}× (limit ${MD_GROWTH_FACTOR}×)`,
    details: { path, before: previous.length, after: content.length },
    hint: {
      fix: "inspect the target file before overwriting it; remove or rename it to accept the rewrite",
    },
  });
}

/** @param {string} path */
function isDirectory(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory();
}

/**
 * A file target must already have a usable parent. The directory shape creates
 * its tree (`mkdirSync({recursive:true})`); a named file does not, so a typo
 * cannot quietly invent a directory.
 *
 * @param {string} path
 */
function requireParentDirectory(path) {
  const parent = statSync(dirname(path), { throwIfNoEntry: false });
  if (parent === undefined || !parent.isDirectory()) {
    throw usageError(`export md: the parent directory of ${path} does not exist`, {
      fix: "create it first, or pass --out <dir> to write <dir>/<ID>.md",
    });
  }
}

export const COMMANDS = [
  {
    name: "md",
    summary: "Export cards as markdown (all tasks, or one).",
    usage: "export md [<ref>] [--out <dir|file.md>] [--project <id>] [--check] [--md]",
    positionals: [{ name: "ref", required: false, summary: "Export only this task (id or identifier)." }],
    flags: [
      { flag: "out", key: "out", as: "string", value: "<dir|file.md>", summary: "Directory to write into (default: cwd); with a card ref, a path ending in .md is the file itself." },
      { flag: "project", key: "project", as: "string", value: "<id>", summary: "Limit the export to one project." },
      { flag: "check", key: "check", as: "boolean", summary: "Compare only; exit 3 when a card differs." },
      { flag: "md", key: "md", as: "boolean", summary: "Accepted as a no-op so `export --md` works." },
    ],
    async run(ctx) {
      const ref = ctx.args.ref;
      if (ref !== undefined && ctx.flags.project !== undefined) {
        throw usageError("export md: --project cannot be combined with a card ref", {
          fix: "drop --project, or run `export md --project <id>` without a card ref",
        });
      }

      const out = resolve(ctx.flags.out ?? ctx.cwd);
      // With a ref, a `.md` path is the file itself — unless it is already a
      // directory (a real `cards.md/` wins over the suffix). Without a ref the
      // export is a set of cards, so `--out` is always a directory.
      const fileMode =
        ref !== undefined &&
        ctx.flags.out !== undefined &&
        out.toLowerCase().endsWith(".md") &&
        !isDirectory(out);
      if (fileMode) requireParentDirectory(out);

      const { cards } = await ctx.client.post(
        "/api/v1/export",
        ref === undefined ? { project_id: ctx.flags.project } : { ref },
      );
      const targets = planTargets(cards, { fileMode, out });

      if (ctx.flags.check === true) {
        const differing = [];
        const missing = [];
        for (const { card, path } of targets) {
          if (!existsSync(path)) {
            missing.push(card.identifier);
            continue;
          }
          if (readFileSync(path, "utf8") !== card.markdown) differing.push(card.identifier);
        }
        const stale = [...missing, ...differing].sort();
        const human = stale.length === 0
          ? (fileMode ? `${cards[0].identifier} matches ${out}` : `all ${cards.length} cards match ${out}`)
          : fields([
              ["cards", cards.length],
              ["missing", missing.length === 0 ? "none" : missing.join(", ")],
              ["differing", differing.length === 0 ? "none" : differing.join(", ")],
            ]);
        const rerun = fileMode ? `taskctl export md ${ref} --out ${out}` : `taskctl export md --out ${out}`;
        return {
          data: { cards: cards.length, missing, differing, up_to_date: stale.length === 0, out },
          human,
          warnings: stale.length === 0 ? [] : [`${stale.length} card(s) are not up to date; run \`${rerun}\``],
          exit: stale.length === 0 ? CLI_EXIT.OK : CLI_EXIT.DIFFERENCES,
        };
      }

      if (!fileMode) mkdirSync(out, { recursive: true });
      for (const { card, path } of targets) {
        assertGrowthGuard(path, card.markdown);
        writeFileSync(path, card.markdown, "utf8");
      }
      return {
        data: { cards: cards.length, out, identifiers: cards.map((card) => card.identifier) },
        human: fileMode
          ? `wrote ${cards[0].identifier} to ${out}`
          : `wrote ${cards.length} card(s) to ${out}`,
      };
    },
  },
];
