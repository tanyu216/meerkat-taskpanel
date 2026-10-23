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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  CARD_REFRESH_MIN_MS,
  CLI_EXIT,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  EVENT_STREAM_LINE,
  MD_GROWTH_FACTOR,
  SSE_SHUTDOWN_EVENT,
  SSE_SUBSCRIBE_IDLE_MS,
} from "../../foundation/constants.mjs";
import { CARD_BRIEF_FILE, cardDirRel } from "../../foundation/card-brief.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { createSseParser } from "../../foundation/sse-parse.mjs";
import { errorPayload, usageError } from "../../foundation/transport/errors.mjs";
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

/* --------------------------------------------------------------- export watch */

/**
 * NDJSON line types for `export watch`: the shared stream spellings plus the one
 * record this command adds. Kept local (rather than in `foundation/constants`)
 * so the loop's generated payload does not change for a CLI-only vocabulary.
 */
export const WATCH_LINE = Object.freeze({
  OPEN: EVENT_STREAM_LINE.OPEN,
  REFRESH: "refresh",
  IDLE: EVENT_STREAM_LINE.IDLE,
  SHUTDOWN: EVENT_STREAM_LINE.SHUTDOWN,
  EOF: EVENT_STREAM_LINE.EOF,
  ERROR: EVENT_STREAM_LINE.ERROR,
  /** Every watched card reached `done`; the watcher stopped itself. */
  DONE: "done",
  /** The `--ttl` bound expired; the watcher stopped itself. */
  TTL: "ttl",
});

/** The brief `export watch` keeps fresh: `<dir>/.meerkat/<identifier>/card.md`. */
export function watchPath(dir, identifier) {
  return join(dir, cardDirRel(identifier), CARD_BRIEF_FILE);
}

/**
 * Write the server's markdown over a card brief, atomically.
 *
 * **No `assertGrowthGuard` here, deliberately.** A machine-generated brief
 * legitimately grows when comments or a report land; the loop's refresher has
 * the same exemption (`scripts/loop/card-file.mjs`), and the unique temp path is
 * always fresh anyway. A byte-identical file is left untouched so mtime does not
 * churn on every unrelated event.
 *
 * @param {string} file
 * @param {string} markdown
 * @returns {{path: string, changed: boolean}}
 */
export function writeCardFile(file, markdown) {
  if (typeof markdown !== "string" || markdown === "") {
    throw new DomainError("CLI_IO", {
      message: `export watch: the board rendered no card for ${basename(file)}`,
      details: { path: file },
    });
  }
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === markdown) {
    return { path: file, changed: false };
  }

  const temp = join(
    dir,
    `card.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp.md`,
  );
  try {
    writeFileSync(temp, markdown, "utf8");
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* best effort: a leftover temp is not the caller's problem */
      }
    }
  }
  return { path: file, changed: true };
}

/**
 * Coalescing, strictly serial refresh queue for `export watch`.
 *
 * The timing mirrors the loop's subscriber (300 ms debounce, 2 s max wait,
 * `CARD_REFRESH_MIN_MS` floor), but the payload is the set of task ids that
 * changed. `notify()` never starts work synchronously; at most one `refresh()`
 * is in flight; `stop()` clears the timer, waits for the in-flight batch, then
 * force-drains whatever was pending (so an event seen just before EOF is not
 * lost).
 *
 * @param {{
 *   refresh: (batch: {taskIds: string[], all: boolean, revision: number|null}) => Promise<void>|void,
 *   now?: () => number,
 *   setTimer?: Function,
 *   clearTimer?: Function,
 *   debounceMs?: number,
 *   maxWaitMs?: number,
 *   minIntervalMs?: number,
 * }} input
 */
export function createWatchScheduler(input = {}) {
  const {
    refresh,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    debounceMs = EVENT_DEBOUNCE_MS,
    maxWaitMs = EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs = CARD_REFRESH_MIN_MS,
  } = input;

  const pending = new Set();
  let all = false;
  let revision = null;
  let timer = null;
  let firstPendingAt = null;
  let lastRunAt = null;
  let running = null;
  let stopped = false;
  let stopping = null;

  const hasPending = () => all || pending.size > 0;
  const clear = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const take = () => {
    const batch = { taskIds: [...pending], all, revision };
    pending.clear();
    all = false;
    revision = null;
    firstPendingAt = null;
    return batch;
  };
  const execute = async () => {
    const batch = take();
    try {
      await refresh(batch);
    } catch {
      // refresh() reports per card; this is a belt-and-braces backstop.
    } finally {
      lastRunAt = now();
    }
  };
  const arm = (delay) => {
    clear();
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, Math.max(0, delay));
    if (typeof timer?.unref === "function") timer.unref();
  };
  const schedule = () => {
    if (stopped || !hasPending()) return;
    const at = now();
    if (firstPendingAt === null) firstPendingAt = at;
    let delay = Math.min(debounceMs, firstPendingAt + maxWaitMs - at);
    if (lastRunAt !== null) delay = Math.max(delay, lastRunAt + minIntervalMs - at);
    arm(delay);
  };
  async function pump() {
    if (running !== null) return; // the in-flight finally reschedules
    if (!hasPending()) return;
    if (lastRunAt !== null && now() < lastRunAt + minIntervalMs) {
      schedule();
      return;
    }
    running = execute().finally(() => {
      running = null;
      if (!stopped && hasPending()) schedule();
    });
    await running;
  }

  return {
    /** `taskId === null` means a task-less event: refresh every watched card. */
    notify(taskId, atRevision = null) {
      if (stopped) return;
      if (taskId === null || taskId === undefined) all = true;
      else pending.add(String(taskId));
      if (Number.isInteger(atRevision)) {
        revision = revision === null ? atRevision : Math.max(revision, atRevision);
      }
      schedule();
    },
    async stop() {
      if (stopping !== null) return stopping;
      stopped = true;
      clear();
      stopping = (async () => {
        if (running !== null) await running.catch(() => {});
        if (hasPending()) await execute();
      })();
      return stopping;
    },
    get pending() {
      return hasPending();
    },
    get running() {
      return running !== null;
    },
  };
}

/** `--after` and `--idle` are counts; a float or a negative is a usage mistake. */
function nonNegativeInteger(flags, key, flag) {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(`--${flag} expects a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
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
  {
    name: "watch",
    summary: "Keep .meerkat/<identifier>/card.md fresh from the event stream.",
    usage: "export watch [<ref>] [--ref <ref>]… [--dir <dir>] [--after <rev>] [--idle <ms>] [--ttl <ms>] [--once]",
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
        summary: "Stop after this long in total (0 disables; default 0).",
      },
      {
        flag: "once",
        key: "once",
        as: "boolean",
        summary: "Export once and exit; do not stream.",
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
      const afterFlag = nonNegativeInteger(ctx.flags, "after", "after");
      const idleMs = nonNegativeInteger(ctx.flags, "idle", "idle") ?? SSE_SUBSCRIBE_IDLE_MS;
      const ttlMs = nonNegativeInteger(ctx.flags, "ttl", "ttl") ?? 0;

      const baseDir = ctx.flags.dir === undefined
        ? resolve(ctx.cwd)
        : resolve(ctx.cwd, ctx.flags.dir);
      const dirStat = statSync(baseDir, { throwIfNoEntry: false });
      if (dirStat === undefined || !dirStat.isDirectory()) {
        throw usageError(`export watch: --dir ${baseDir} is not an existing directory`, {
          fix: "create the project working directory first (the .meerkat/ subtree is created for you)",
        });
      }

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
      const watched = new Map();
      const firstPass = [];
      for (const card of initial) {
        // `done` is terminal: write its final brief, but do not keep watching it.
        if (card.status !== "done") watched.set(card.task_id, card.identifier);
        firstPass.push({
          card,
          outcome: writeCardFile(watchPath(baseDir, card.identifier), card.markdown),
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
          const identifier = watched.get(taskId);
          if (identifier === undefined) continue;
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
            const outcome = writeCardFile(watchPath(baseDir, card.identifier), card.markdown);
            // A done card has no further changes to follow; stop tracking it.
            if (status === "done") watched.delete(taskId);
            else watched.set(taskId, card.identifier);
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
              path: watchPath(baseDir, identifier),
              changed: false,
              error: errorPayload(err),
            });
          }
        }
        // Every card reached `done`: no work remains, so close the stream now
        // rather than holding a connection forever.
        if (!completed && watched.size === 0) {
          completed = true;
          controller.abort();
        }
      };
      const scheduler = createWatchScheduler({ refresh });

      const parser = createSseParser();
      let terminal = null;
      let emitTerminal = true;
      let exit = CLI_EXIT.OK;
      try {
        for await (const chunk of stream) {
          for (const frame of parser.push(chunk)) {
            if (frame.event === SSE_SHUTDOWN_EVENT) {
              let data = null;
              try {
                data = JSON.parse(frame.data);
              } catch {
                // A malformed shutdown frame still means the server is leaving.
              }
              terminal = data === null
                ? { type: WATCH_LINE.SHUTDOWN }
                : { type: WATCH_LINE.SHUTDOWN, data };
              exit = CLI_EXIT.OK;
              break;
            }

            let data;
            try {
              data = JSON.parse(frame.data);
            } catch {
              continue; // a frame that is not JSON cannot name a board event
            }
            const rawId = frame.id === null ? null : Number.parseInt(frame.id, 10);
            const revision = Number.isFinite(rawId)
              ? rawId
              : (Number.isInteger(data?.revision) ? data.revision : null);
            const taskId = typeof data?.task_id === "string" && data.task_id !== ""
              ? data.task_id
              : null;
            if (taskId === null) scheduler.notify(null, revision);
            else if (watched.has(taskId)) scheduler.notify(taskId, revision);
          }
          if (terminal !== null) break;
        }
      } catch (err) {
        // Never throw past `open`: the dispatcher's catch would print an
        // envelope into the middle of the NDJSON stream.
        if (err?.details?.reason === "aborted") {
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
        } else if (err?.details?.reason === "idle") {
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
