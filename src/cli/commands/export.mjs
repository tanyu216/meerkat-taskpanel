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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TERMINAL_CARD_STATUSES } from "../../foundation/card-brief.mjs";
import {
  CLI_EXIT,
  MD_GROWTH_FACTOR,
  SSE_SUBSCRIBE_IDLE_MS,
} from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { errorPayload, usageError } from "../../foundation/transport/errors.mjs";
import { activityFrames, streamFailure } from "../activity-stream.mjs";
import { hubAnswer, hubError, hubRecords } from "../hub/client.mjs";
import { ensureHub, hubHealthy, hubPaths, readJsonFile } from "../hub/runtime.mjs";
import {
  CARD_WATCH_TTL_MS,
  WATCH_LINE,
  createWatchScheduler,
  watchPath,
  writeCardFile,
} from "../watch-core.mjs";
import { fields } from "../output/human.mjs";

/** The CLI entry a detached hub re-executes. */
const CLI_ENTRY = fileURLToPath(new URL("../index.mjs", import.meta.url));

/**
 * The watch vocabulary and writer live in `../watch-core.mjs`, shared with the
 * event hub. Re-exported here because this module was their original home and
 * the CLI test suite imports them from it.
 */
export { CARD_WATCH_TTL_MS, WATCH_LINE, createWatchScheduler, watchPath, writeCardFile };

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

/* --------------------------------------------------------------- export watch */

/** `--after` and `--idle` are counts; a float or a negative is a usage mistake. */
function nonNegativeInteger(flags, key, flag) {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(`--${flag} expects a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/* ------------------------------------------------------- export watch via hub */

/** The hub child records who asked; reads do not need it to be a write identity. */
function watchOwner(ctx) {
  return { kind: ctx.identity.actor.kind, id: ctx.identity.actor.id };
}

function requireBoard(ctx, command) {
  if (ctx.board === null || typeof ctx.board?.url !== "string") {
    throw new DomainError("CLI_IO", {
      message: `${command}: the board coordinates are not resolved`,
    });
  }
  return ctx.board;
}

/** Find or start the hub for this board. */
async function ensureWatchHub(ctx) {
  const board = requireBoard(ctx, "export watch");
  const human = ctx.identity.actor.kind === "human";
  return ensureHub({
    url: board.url,
    token: board.token,
    actorKind: human ? "claude" : ctx.identity.actor.kind,
    asHuman: human,
    agent: ctx.identity.actor.id,
    envFile: typeof ctx.flags.envFile === "string" ? ctx.flags.envFile : null,
    entry: CLI_ENTRY,
    env: ctx.env,
  });
}

/**
 * `--watch-status` is read-only: starting a hub just to ask it would make the answer
 * untrue. A missing or dead pointer means no registration is being served.
 */
async function watchStatus(ctx, refs, target) {
  const board = requireBoard(ctx, "export watch");
  const where = target.out ?? target.dir;
  const paths = hubPaths(board.url, board.token, ctx.env);
  const pointer = readJsonFile(paths.pointer);
  if (pointer === null || !(await hubHealthy(pointer))) {
    return {
      data: { running: false, reason: "no-hub", ref: refs[0], dir: target.dir, out: target.out },
      human: `no local event hub is running for ${refs[0]}`,
    };
  }
  const answer = await hubAnswer(
    pointer,
    { op: "watch-status", ref: refs[0], dir: target.dir, out: target.out },
    (record) => record?.op === "watch-status",
  );
  const running = answer.running === true;
  return {
    data: {
      running,
      registration_id: answer.registration_id ?? null,
      cards: answer.cards ?? [],
      expires_at: answer.expires_at ?? null,
      last_refresh: answer.last_refresh ?? null,
      dir: target.dir,
      out: target.out,
    },
    human: running
      ? `watching ${refs[0]} in ${where}`
      : `not watching ${refs[0]} in ${where} (${answer.reason ?? "not found"})`,
  };
}

/** `--stop` may start the hub: a persisted registration would otherwise resume. */
async function watchStop(ctx, refs, target) {
  const where = target.out ?? target.dir;
  const { pointer } = await ensureWatchHub(ctx);
  const answer = await hubAnswer(
    pointer,
    { op: "watch-stop", ref: refs[0], dir: target.dir, out: target.out },
    (record) => record?.op === "watch-stop",
  );
  const stopped = answer.stopped === true;
  return {
    data: {
      stopped,
      registration_id: answer.registration_id ?? null,
      reason: answer.reason ?? null,
      ref: refs[0],
      dir: target.dir,
      out: target.out,
    },
    human: stopped ? `stopped watching ${refs[0]}` : `no registration for ${refs[0]} in ${where}`,
  };
}

/** `--detach`: register, return the handle, leave no client process behind. */
async function watchDetach(ctx, refs, target, ttlMs) {
  const { pointer } = await ensureWatchHub(ctx);
  const where = target.out ?? target.dir;
  let answer = null;
  for await (const record of hubRecords(pointer, {
    op: "watch",
    refs,
    dir: target.dir,
    out: target.out,
    ttl_ms: ttlMs,
    detach: true,
    owner: watchOwner(ctx),
  })) {
    if (record?.type === "heartbeat") continue;
    if (record?.type === "registered") {
      answer = record;
      break;
    }
    if (record?.type === WATCH_LINE.ERROR) throw hubError(record.data);
    if (record?.op === "error" && record.ok === false) throw hubError(record.error);
  }
  if (answer === null) {
    throw new DomainError("CLI_IO", {
      message: "export watch: the local hub closed before registering the watcher",
    });
  }
  const running = answer.running !== false;
  return {
    data: {
      running,
      registration_id: answer.registration_id ?? null,
      reused: answer.reused === true,
      reason: answer.reason ?? null,
      cards: answer.cards ?? [],
      expires_at: answer.expires_at ?? null,
      dir: target.dir,
      out: target.out,
    },
    human: running
      ? `watching ${refs.join(", ")} in ${where} (registration ${answer.registration_id})`
      : `wrote the final brief for ${refs.join(", ")} (${answer.reason ?? "done"}); nothing left to watch`,
  };
}

/** Foreground watcher served by the hub: the same NDJSON lines as before. */
async function watchViaHub(ctx, refs, target, ttlMs) {
  const { pointer } = await ensureWatchHub(ctx);
  let opened = false;
  try {
    for await (const record of hubRecords(pointer, {
      op: "watch",
      refs,
      dir: target.dir,
      out: target.out,
      ttl_ms: ttlMs,
      detach: false,
      owner: watchOwner(ctx),
    })) {
      if (record?.type === "heartbeat") continue;
      if (record?.type === WATCH_LINE.OPEN) {
        opened = true;
        ctx.emit({ type: WATCH_LINE.OPEN });
        continue;
      }
      if (record?.type === WATCH_LINE.REFRESH) {
        ctx.emit(record);
        continue;
      }
      if (
        record?.type === WATCH_LINE.DONE ||
        record?.type === WATCH_LINE.TTL ||
        record?.type === WATCH_LINE.IDLE ||
        record?.type === WATCH_LINE.SHUTDOWN
      ) {
        ctx.emit(record);
        return { streamed: true, exit: CLI_EXIT.OK };
      }
      if (record?.type === WATCH_LINE.ERROR) {
        if (!opened) throw hubError(record.data);
        ctx.emit(record);
        return { streamed: true, exit: CLI_EXIT.ERROR };
      }
    }
  } catch (err) {
    if (!opened) throw err;
    ctx.emit({ type: WATCH_LINE.ERROR, data: errorPayload(err) });
    return { streamed: true, exit: CLI_EXIT.ERROR };
  }
  if (!opened) {
    throw new DomainError("CLI_IO", {
      message: "export watch: the local hub closed before opening the stream",
    });
  }
  ctx.emit({ type: WATCH_LINE.EOF });
  return { streamed: true, exit: CLI_EXIT.OK };
}

export const COMMANDS = [
  {
    name: "md",
    summary: "Export cards as markdown (all tasks, or one).",
    usage: "export md [<ref>] [--out <dir|file.md>] [--project <id>] [--check] [--md] [--watch]",
    positionals: [{ name: "ref", required: false, summary: "Export only this task (id or identifier)." }],
    flags: [
      { flag: "out", key: "out", as: "string", value: "<dir|file.md>", summary: "Directory to write into (default: cwd); with a card ref, a path ending in .md is the file itself." },
      { flag: "project", key: "project", as: "string", value: "<id>", summary: "Limit the export to one project." },
      { flag: "check", key: "check", as: "boolean", summary: "Compare only; exit 3 when a card differs." },
      { flag: "md", key: "md", as: "boolean", summary: "Accepted as a no-op so `export --md` works." },
      {
        flag: "watch",
        key: "watch",
        as: "boolean",
        summary: "Register a detached brief watch (single ref + --out <file.md>); the hub keeps it fresh until done/canceled.",
      },
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

      // The long-lived spelling: register the same watch `export watch --detach`
      // registers. The hub writes the first snapshot before it answers, so the
      // caller still has a brief on return. No TTL: the registration ends when
      // the card reaches a terminal status.
      if (ctx.flags.watch === true) {
        if (ref === undefined) {
          throw usageError("export md: --watch needs one card ref", {
            fix: "name the card: `export md <ref> --out <file.md> --watch`",
          });
        }
        if (ctx.flags.check === true) {
          throw usageError("export md: --watch cannot be combined with --check");
        }
        if (ctx.flags.project !== undefined) {
          throw usageError("export md: --watch cannot be combined with --project");
        }
        if (!fileMode) {
          throw usageError("export md: --watch needs --out <file.md>", {
            fix: "give the file to keep fresh; the hub creates its parent directory",
          });
        }
        return watchDetach(ctx, [ref], { dir: null, out }, 0);
      }

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
  {
    name: "watch",
    summary: "Keep .meerkat/<identifier>/card.md fresh from the event stream.",
    usage: "export watch [<ref>] [--ref <ref>]… [--dir <dir>|--out <file>] [--after <rev>] [--idle <ms>] [--ttl <ms>] [--once] [--detach] [--watch-status] [--stop] [--standalone]",
    positionals: [
      {
        name: "ref",
        required: false,
        summary: "Watch this card (id or identifier); at least one ref in total is required.",
      },
    ],
    flags: [
      {
        flag: "ref",
        key: "refs",
        as: "string",
        value: "<ref>",
        repeat: true,
        summary: "Watch this card (repeatable).",
      },
      {
        flag: "dir",
        key: "dir",
        as: "string",
        value: "<dir>",
        summary: "Project working directory holding .meerkat/ (default: cwd).",
      },
      {
        flag: "out",
        key: "out",
        as: "string",
        value: "<file>",
        summary:
          "Write the brief to this exact file (one ref; the hub creates its parent). Mutually exclusive with --dir.",
      },
      {
        flag: "after",
        key: "after",
        as: "number",
        value: "<rev>",
        summary: "Replay activities newer than this board revision, then stream.",
      },
      {
        flag: "idle",
        key: "idle",
        as: "number",
        value: "<ms>",
        summary: `End after this long with no bytes (0 disables; default ${SSE_SUBSCRIBE_IDLE_MS}).`,
      },
      {
        flag: "ttl",
        key: "ttl",
        as: "number",
        value: "<ms>",
        summary: "Stop after this long in total (0 disables; default 120 minutes).",
      },
      {
        flag: "once",
        key: "once",
        as: "boolean",
        summary: "Export once and exit; do not stream.",
      },
      {
        flag: "detach",
        key: "detach",
        as: "boolean",
        summary: "Register with the local event hub and return; the hub keeps the brief fresh.",
      },
      {
        flag: "watch-status",
        key: "watchStatus",
        as: "boolean",
        summary: "Report whether this card's registration is running.",
      },
      {
        flag: "stop",
        key: "stop",
        as: "boolean",
        summary: "Stop this card's registration.",
      },
      {
        flag: "standalone",
        key: "standalone",
        as: "boolean",
        summary: "Use the direct SSE implementation instead of the local hub (fallback).",
      },
    ],
    async run(ctx) {
      const refs = [];
      if (typeof ctx.args.ref === "string" && ctx.args.ref !== "") refs.push(ctx.args.ref);
      for (const ref of ctx.flags.refs ?? []) {
        if (typeof ref === "string" && ref !== "") refs.push(ref);
      }
      const uniqueRefs = [...new Set(refs)];
      if (uniqueRefs.length === 0) {
        throw usageError("export watch: at least one card ref is required", {
          fix: "pass a positional <ref> or one or more --ref <ref>",
        });
      }

      const once = ctx.flags.once === true;
      const detach = ctx.flags.detach === true;
      const statusMode = ctx.flags.watchStatus === true;
      const stopMode = ctx.flags.stop === true;
      const standalone = ctx.flags.standalone === true;

      const modes = [once, detach, statusMode, stopMode].filter(Boolean).length;
      if (modes > 1) {
        throw usageError("export watch: --once, --detach, --watch-status and --stop are mutually exclusive", {
          fix: "pick one mode; a foreground watcher is the default",
        });
      }
      if (standalone && (detach || statusMode || stopMode)) {
        throw usageError("export watch: --standalone applies to a foreground watcher, not --detach/--watch-status/--stop");
      }

      const afterFlag = nonNegativeInteger(ctx.flags, "after", "after");
      const idleMs = nonNegativeInteger(ctx.flags, "idle", "idle") ?? SSE_SUBSCRIBE_IDLE_MS;
      const ttlMs = nonNegativeInteger(ctx.flags, "ttl", "ttl") ?? CARD_WATCH_TTL_MS;

      const out = ctx.flags.out === undefined ? null : resolve(ctx.cwd, ctx.flags.out);
      const dirFlag = ctx.flags.dir === undefined ? null : resolve(ctx.cwd, ctx.flags.dir);
      if (out !== null && dirFlag !== null) {
        throw usageError("export watch: --out and --dir are mutually exclusive", {
          fix: "name one target: --out <file> for one card, or --dir <dir> for the .meerkat subtree",
        });
      }
      if (out !== null && uniqueRefs.length !== 1) {
        throw usageError("export watch: --out takes exactly one card ref", {
          fix: "pass one ref, or use --dir for several cards",
        });
      }
      if (out !== null) {
        const targetStat = statSync(out, { throwIfNoEntry: false });
        if (targetStat !== undefined && targetStat.isDirectory()) {
          throw usageError(`export watch: --out ${out} is a directory`, {
            fix: "name the file to keep fresh, or use --dir",
          });
        }
      }
      const baseDir = out === null ? (dirFlag ?? resolve(ctx.cwd)) : null;
      if (baseDir !== null) {
        const dirStat = statSync(baseDir, { throwIfNoEntry: false });
        if (dirStat === undefined || !dirStat.isDirectory()) {
          throw usageError(`export watch: --dir ${baseDir} is not an existing directory`, {
            fix: "create the project working directory first (the .meerkat/ subtree is created for you)",
          });
        }
      }
      const target = { dir: baseDir, out };

      // The hub is the default: one board connection for every local consumer.
      // `--standalone` (and `--once`, which never streams) keep the direct-SSE
      // implementation available for sandboxes and for differential tests.
      if (statusMode) return watchStatus(ctx, uniqueRefs, target);
      if (stopMode) return watchStop(ctx, uniqueRefs, target);
      if (detach) return watchDetach(ctx, uniqueRefs, target, ttlMs);
      if (!once && !standalone) return watchViaHub(ctx, uniqueRefs, target, ttlMs);

      // Seed the cursor before the initial export, so a write that lands between
      // the export and the stream opening is replayed rather than lost. `/meta`
      // is best-effort: a board that cannot answer it still gets a live stream.
      let after = afterFlag;
      if (!once && after === undefined) {
        try {
          const meta = await ctx.client.get("/meta");
          const revision = Number(meta?.revision);
          if (Number.isInteger(revision) && revision >= 0) after = revision;
        } catch {
          /* live from the stream's current revision */
        }
      }

      // Collect every render before writing anything: a bad ref must not leave
      // half a card set behind (`open` has not been written yet either).
      const initial = [];
      for (const ref of uniqueRefs) {
        const { cards } = await ctx.client.post("/api/v1/export", { ref });
        if (!Array.isArray(cards) || cards.length !== 1) {
          throw new DomainError("CLI_IO", {
            message: `export watch: expected exactly one card for ${ref}, got ${cards?.length ?? 0}`,
            details: { ref, cards: cards?.length ?? 0 },
          });
        }
        const card = cards[0];
        if (
          typeof card?.identifier !== "string" ||
          card.identifier === "" ||
          typeof card?.task_id !== "string" ||
          card.task_id === ""
        ) {
          throw new DomainError("CLI_IO", {
            message: `export watch: the board's export for ${ref} carried no task_id/identifier`,
            details: { ref },
          });
        }
        initial.push(card);
      }

      // Write the first snapshot before opening the stream. A failure here is
      // still a clean error envelope, because nothing has been emitted yet.
      const targetPath = (card) => (out !== null ? out : watchPath(baseDir, card.identifier));
      const watched = new Map();
      const firstPass = [];
      for (const card of initial) {
        const path = targetPath(card);
        // A terminal card gets its final brief, but is not watched further.
        if (!TERMINAL_CARD_STATUSES.includes(card.status ?? "")) {
          watched.set(card.task_id, { identifier: card.identifier, path });
        }
        firstPass.push({
          card,
          outcome: writeCardFile(path, card.markdown),
        });
      }

      const emitFirstPass = () => {
        ctx.emit({ type: WATCH_LINE.OPEN });
        for (const { card, outcome } of firstPass) {
          ctx.emit({
            type: WATCH_LINE.REFRESH,
            task_id: card.task_id,
            identifier: card.identifier,
            path: outcome.path,
            changed: outcome.changed,
            ...(card.status === undefined ? {} : { status: card.status }),
          });
        }
      };

      if (once) {
        emitFirstPass();
        ctx.emit({ type: WATCH_LINE.EOF });
        return { streamed: true, exit: CLI_EXIT.OK };
      }
      if (watched.size === 0) {
        // Nothing left to follow: every named card is already done.
        emitFirstPass();
        ctx.emit({ type: WATCH_LINE.DONE });
        return { streamed: true, exit: CLI_EXIT.OK };
      }

      const controller = new AbortController();
      const stream = await ctx.client.stream("/api/v1/events", {
        query: { after },
        idleMs,
        signal: controller.signal,
      });
      let completed = false;
      // A hard lifetime bound. The session that started the watcher may be
      // gone without killing it, and a card that never reaches `done` would
      // otherwise keep this connection open forever.
      let ttlExpired = false;
      const ttlTimer = ttlMs > 0
        ? setTimeout(() => {
            ttlExpired = true;
            controller.abort();
          }, ttlMs)
        : null;
      if (typeof ttlTimer?.unref === "function") ttlTimer.unref();
      emitFirstPass();

      const refresh = async ({ taskIds, all, revision }) => {
        const ids = all ? [...watched.keys()] : taskIds;
        for (const taskId of ids) {
          const known = watched.get(taskId);
          if (known === undefined) continue;
          const { identifier, path } = known;
          try {
            const { cards } = await ctx.client.post("/api/v1/export", { ref: taskId });
            const card = Array.isArray(cards) && cards.length === 1 ? cards[0] : null;
            if (
              card === null ||
              typeof card.markdown !== "string" ||
              card.markdown === "" ||
              typeof card.identifier !== "string" ||
              card.identifier === ""
            ) {
              throw new DomainError("CLI_IO", {
                message: `export watch: refresh for ${identifier} returned no usable card`,
                details: { task_id: taskId },
              });
            }
            const status = typeof card.status === "string" ? card.status : null;
            const outcome = writeCardFile(path, card.markdown);
            // A terminal card has no further changes to follow.
            if (status !== null && TERMINAL_CARD_STATUSES.includes(status)) watched.delete(taskId);
            else watched.set(taskId, { identifier: card.identifier, path });
            ctx.emit({
              type: WATCH_LINE.REFRESH,
              task_id: taskId,
              identifier: card.identifier,
              path: outcome.path,
              changed: outcome.changed,
              ...(status === null ? {} : { status }),
              ...(revision === null ? {} : { revision }),
            });
          } catch (err) {
            // One unreadable card must not end the watch: keep the old file and
            // report it in the stream, exactly like the loop's refresher.
            ctx.emit({
              type: WATCH_LINE.REFRESH,
              task_id: taskId,
              identifier,
              path,
              changed: false,
              error: errorPayload(err),
            });
          }
        }
        // Every card reached a terminal status: no work remains, so close the
        // stream now rather than holding a connection forever.
        if (!completed && watched.size === 0) {
          completed = true;
          controller.abort();
        }
      };
      const scheduler = createWatchScheduler({ refresh });

      let terminal = null;
      let emitTerminal = true;
      let exit = CLI_EXIT.OK;
      try {
        for await (const frame of activityFrames(stream)) {
          if (frame.type === "shutdown") {
            terminal = frame.data === null
              ? { type: WATCH_LINE.SHUTDOWN }
              : { type: WATCH_LINE.SHUTDOWN, data: frame.data };
            exit = CLI_EXIT.OK;
            break;
          }
          if (frame.type === "eof") break;

          const taskId = typeof frame.data.task_id === "string" && frame.data.task_id !== ""
            ? frame.data.task_id
            : null;
          if (taskId === null) scheduler.notify(null, frame.revision);
          else if (watched.has(taskId)) scheduler.notify(taskId, frame.revision);
        }
      } catch (err) {
        // Never throw past `open`: the dispatcher's catch would print an
        // envelope into the middle of the NDJSON stream.
        const reason = streamFailure(err);
        if (reason === "aborted") {
          if (completed) {
            // The watcher closed the stream itself: every card is done.
            terminal = { type: WATCH_LINE.DONE };
            exit = CLI_EXIT.OK;
          } else if (ttlExpired) {
            // The hard lifetime bound fired.
            terminal = { type: WATCH_LINE.TTL, data: { ttl_ms: ttlMs } };
            exit = CLI_EXIT.OK;
          } else {
            // A caller abort is not an outcome of the stream; like `events
            // tail`, leave the NDJSON without a terminal line.
            emitTerminal = false;
            exit = CLI_EXIT.OK;
          }
        } else if (reason === "idle") {
          terminal = { type: WATCH_LINE.IDLE, data: { idle_ms: idleMs } };
          exit = CLI_EXIT.OK;
        } else {
          terminal = { type: WATCH_LINE.ERROR, data: errorPayload(err) };
          exit = CLI_EXIT.ERROR;
        }
      }

      if (ttlTimer !== null) clearTimeout(ttlTimer);

      // Drain before the terminal line, so a `refresh` never follows it.
      await scheduler.stop();
      if (completed && terminal === null) terminal = { type: WATCH_LINE.DONE };
      else if (ttlExpired && terminal === null) {
        terminal = { type: WATCH_LINE.TTL, data: { ttl_ms: ttlMs } };
      }
      if (emitTerminal) ctx.emit(terminal ?? { type: WATCH_LINE.EOF });
      return { streamed: true, exit };
    },
  },
];
