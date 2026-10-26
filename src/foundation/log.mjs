/**
 * The one logging facility.
 *
 * The rest of the tree already speaks one convention — `logger({ event, ... })`
 * on an injected function — because `openBoard`, `acquireWriterLock`, the
 * migration runner and the command context all accept a `logger`. What was
 * missing was an *implementation*: `taskd` never passed one, so every event was
 * dropped. This module is that implementation, and it keeps the convention:
 *
 *   - the value returned by {@link createLogger} is **callable** with a record
 *     (`{ event, level?, ...fields }`) or with a free-form string, so it can be
 *     handed to any seam that expects a plain `Function`;
 *   - it also carries `.debug/.info/.warn/.error`, `.child()`, `.isLevelEnabled()`
 *     and `.close()`, for new code that should say its severity out loud.
 *
 * Two rules are load-bearing:
 *
 *   1. **Formatting happens only where a logger is constructed.** `createTaskd`,
 *      `openBoard` and `createContext` stay pass-through: they forward whatever
 *      function they were given, which is what keeps a test's
 *      `(event) => logs.push(event)` collecting raw objects.
 *   2. **Logging never fails the caller.** Every sink call is wrapped; a broken
 *      sink, a full disk or a redaction surprise cannot turn a request into a 500.
 *
 * The line is **logfmt** — the conventional `key=value` text format, so a generic
 * logfmt reader parses it and no bespoke grammar has to be learned:
 *
 *   time=2026-10-27T12:34:56.789Z level=info event=request method=GET status=200
 *   time=2026-10-27T12:34:56.790Z level=info component=supervisor msg="/meerkat-loop Continue"
 *
 * `run_id`/`request_id` correlation comes from {@link withLogContext}
 * (`AsyncLocalStorage`), so a command logged deep inside the server automatically
 * carries the request it belongs to.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { LOG_LEVEL_ENV } from "./constants.mjs";
import { redactDeep, redactText } from "./redact.mjs";

/** Rank per level. `off` outranks everything, so nothing is emitted at it. */
export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
});

const LEVEL_NAMES = Object.freeze(["debug", "info", "warn", "error", "off"]);
const ALIASES = Object.freeze({
  warning: "warn",
  none: "off",
  silent: "off",
  quiet: "off",
});

/**
 * The severity of the events the tree already emits.
 *
 * Explicit rather than inferred: `*_failed` is not a rule (a recovery such as
 * `writer_lock_stale` is a warning, not a failure). An event absent here is
 * `info`, so a new call site does not need to touch this table unless it is
 * louder than ordinary progress.
 */
export const EVENT_LEVELS = Object.freeze({
  // Ordinary progress.
  migration_applied: "info",
  container_sweep: "info",
  label_gc: "info",
  label_gc_scheduled: "info",
  label_gc_disabled: "info",
  startup: "info",
  shutdown_signal: "info",
  shutdown_complete: "info",
  board_opened: "info",
  request: "info",
  task_created: "info",
  task_claimed: "info",
  task_moved: "info",
  task_archived: "info",
  report_written: "info",
  task_delivered: "info",
  task_reopened: "info",
  token_created: "info",
  token_rotated: "info",
  // Recovered or suspicious, but the process carries on.
  schema_stale: "warn",
  writer_lock_stale: "warn",
  writer_lock_release_failed: "warn",
  label_gc_mismatch: "warn",
  allow_list_invalid: "warn",
  sla_config_invalid: "warn",
  log_level_invalid: "warn",
  // Exception boundaries.
  sse_stream_failed: "error",
  container_sweep_failed: "error",
  label_gc_failed: "error",
  startup_failed: "error",
  shutdown_failed: "error",
  request_failed: "error",
  board_open_failed: "error",
  migration_failed: "error",
  // Diagnostic detail, silent at the default level.
  command: "debug",
  sse_stream_opened: "debug",
  sse_stream_closed: "debug",
  migrations_skipped: "debug",
  cli_command: "debug",
  cli_failure: "debug",
});

/** `warning`/`none`/`silent` are accepted so a config file never has to guess. */
export function parseLogLevel(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "") return null;
  const level = Object.hasOwn(ALIASES, key) ? ALIASES[key] : key;
  return LEVEL_NAMES.includes(level) ? level : null;
}

/**
 * The level an environment selects, plus whether it was usable.
 *
 * An invalid value does not throw here: the caller decides whether to refuse the
 * whole startup (the `.env` validator does that) or to carry on at the fallback
 * and say so (`log_level_invalid`). Both paths need the fallback.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [fallback]
 */
export function levelFromEnv(env = {}, fallback = "info") {
  const raw = env?.[LOG_LEVEL_ENV];
  if (raw === undefined || raw === "") return { level: fallback, raw: null, valid: true };
  const parsed = parseLogLevel(raw);
  return parsed === null ? { level: fallback, raw, valid: false } : { level: parsed, raw, valid: true };
}

/** Canonical level name; anything unrecognised is `info`. */
function normalizeLevel(value) {
  return parseLogLevel(value) ?? "info";
}

// ---------------------------------------------------------------------------
// Context — the correlation id, without threading a parameter everywhere
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `context` merged into every record logged inside it.
 *
 * The server wraps one request handler in this, so a command logged three
 * layers down carries `request_id` without any handler knowing about logging.
 *
 * @template T
 * @param {object} context
 * @param {() => T} fn
 * @returns {T}
 */
export function withLogContext(context, fn) {
  return storage.run({ ...context }, fn);
}

/** The ambient context, or `null` outside one. */
export function currentLogContext() {
  return storage.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * logfmt: a value needs no quotes when it has no whitespace, `=` or `"`.
 *
 * This is the de-facto text convention (Heroku, Go's `slog`, Prometheus
 * exporters): every token is `key=value`, so a line is parseable by a generic
 * logfmt reader or a single split — no format-specific grammar to learn.
 */
const BARE_VALUE = /^[^\s="]+$/;
const ELLIPSIS = "…";

function truncate(text, maxChars) {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${ELLIPSIS}`;
}

/** Double-quote with logfmt's escapes (the same ones JSON uses). */
function quoteValue(text) {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

function formatValue(value, maxChars) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    const text = truncate(value, maxChars);
    return text !== "" && BARE_VALUE.test(text) ? text : quoteValue(text);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json === undefined ? "null" : quoteValue(truncate(json, maxChars));
}

/** camelCase / kebab-case keys become the snake_case log pipelines expect. */
function snakeKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}

/** `{ name, code?, message }`, plus the stack when debug output is on. */
function errorValue(error, includeStack) {
  if (error instanceof Error) {
    const out = { name: error.name };
    if (typeof error.code === "string") out.code = error.code;
    out.message = redactText(error.message);
    if (includeStack && typeof error.stack === "string") out.stack = redactText(error.stack);
    return out;
  }
  if (error && typeof error === "object") return error;
  return { message: String(error) };
}

function timestampOf(explicit, clock) {
  if (typeof explicit === "string") return explicit;
  const value = typeof clock === "function" ? clock() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const RESERVED = new Set(["ts", "time", "level", "event", "message", "msg", "error"]);

/**
 * Render one record as a single logfmt line.
 *
 * The prefix is fixed and conventional — `time`, `level`, then the optional
 * `component` — followed by `event`, the prose in `msg`, and every other field.
 * `msg` is a field like any other, so a free-form line and an event line are the
 * same grammar; nothing is positional and no value is ever bare prose.
 *
 *   time=2026-10-27T12:34:56.789Z level=info event=request method=GET status=200
 *   time=2026-10-27T12:34:56.790Z level=info component=supervisor msg="/meerkat-loop Continue"
 *
 * @param {object} record
 * @param {{component?: string|null, maxValueChars?: number, includeStack?: boolean, clock?: Function}} [options]
 */
export function formatLogRecord(record, options = {}) {
  const { component = null, maxValueChars = 2048, includeStack = false } = options;
  const level = normalizeLevel(record.level);
  const timestamp = timestampOf(record.ts, options.clock);

  /** @type {[string, unknown][]} */
  const entries = [
    ["time", timestamp],
    ["level", level],
  ];
  if (typeof component === "string" && component !== "") entries.push(["component", component]);
  if (record.event !== undefined) entries.push(["event", record.event]);
  if (record.message !== undefined) entries.push(["msg", record.message]);
  if (record.error !== undefined) entries.push(["error", errorValue(record.error, includeStack)]);
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED.has(key)) entries.push([snakeKey(key), value]);
  }

  // One `redactDeep` pass over the ordered record does two jobs: a secret-named
  // key (`token`) is blanked outright, and a token-shaped value is replaced
  // wherever it sits. Order is preserved.
  const safe = redactDeep(Object.fromEntries(entries));

  return redactText(
    Object.entries(safe)
      .map(([key, value]) => `${key}=${formatValue(value, maxValueChars)}`)
      .join(" "),
  );
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/** The default: one line on stderr, where the service manager already looks. */
export function stderrSink(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * A size-rotated, append-only file.
 *
 * The returned value is itself a sink (`write(line)`), with `rotate()`,
 * `close()` and `.path` attached — so it can sit in the same array as
 * {@link stderrSink} and still be driven by hand in a test.
 *
 * Every filesystem error is swallowed on purpose: a logger that throws while
 * reporting a failure hides the failure.
 *
 * @param {{path: string, maxBytes?: number, keep?: number, mode?: number, dirMode?: number}} options
 */
export function createFileSink(options = {}) {
  const {
    path,
    maxBytes = 10 * 1024 * 1024,
    keep = 5,
    mode = 0o600,
    dirMode = 0o700,
  } = options;
  if (typeof path !== "string" || path === "") {
    throw new TypeError("createFileSink: path is required");
  }

  const size = () => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };

  function rotate() {
    try {
      if (keep <= 0) {
        try {
          unlinkSync(path);
        } catch {
          /* nothing to drop */
        }
        return;
      }
      // Oldest first: `.N-1 → .N`, … then `path → .1`. Renaming over an existing
      // file is what drops the oldest generation.
      for (let i = keep - 1; i >= 1; i -= 1) {
        try {
          renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        } catch {
          /* that generation never existed */
        }
      }
      try {
        renameSync(path, `${path}.1`);
      } catch {
        /* the live file never existed */
      }
    } catch {
      /* rotation is best-effort */
    }
  }

  function write(line) {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = Buffer.byteLength(text);
    try {
      const current = size();
      if (maxBytes > 0 && current > 0 && current + bytes > maxBytes) rotate();
      mkdirSync(dirname(path), { recursive: true, mode: dirMode });
      appendFileSync(path, text, { mode });
    } catch {
      /* a logger that throws hides the failure it was reporting */
    }
  }

  write.write = write;
  write.rotate = rotate;
  write.close = () => {};
  write.path = path;
  return write;
}

// ---------------------------------------------------------------------------
// The logger
// ---------------------------------------------------------------------------

function normalizeRecord(input) {
  if (typeof input === "string") return { level: "info", message: input };
  if (input instanceof Error) return { level: "error", error: input };
  if (input !== null && typeof input === "object") {
    const level = typeof input.level === "string"
      ? normalizeLevel(input.level)
      : (EVENT_LEVELS[input.event] ?? "info");
    return { ...input, level };
  }
  return { level: "info", message: String(input) };
}

/**
 * Build a logger.
 *
 * @param {{
 *   level?: string,              // debug|info|warn|error|off (default info)
 *   component?: string|null,     // emitted as `component=<name>` on every line
 *   sinks?: Function|Function[], // (line) => void; a thrown error is swallowed
 *   clock?: () => Date|string,
 *   meta?: object,               // merged into every record (service, pid, …)
 *   maxValueChars?: number,
 *   useContext?: boolean,        // merge `withLogContext` (default true)
 * }} [options]
 */
export function createLogger(options = {}) {
  const {
    level = "info",
    component = null,
    sinks = [stderrSink],
    clock = () => new Date(),
    meta = {},
    maxValueChars = 2048,
    useContext = true,
  } = options;

  const threshold = normalizeLevel(level);
  const sinkList = (Array.isArray(sinks) ? sinks : [sinks]).filter(
    (sink) => typeof sink === "function",
  );
  const includeStack = LOG_LEVELS[threshold] <= LOG_LEVELS.debug;

  function emit(input) {
    const record = normalizeRecord(input);
    if (LOG_LEVELS[record.level] < LOG_LEVELS[threshold]) return;

    const context = useContext ? currentLogContext() : null;
    const merged = {
      ...meta,
      ...(context ?? {}),
      ...record,
      ts: typeof record.ts === "string" ? record.ts : timestampOf(undefined, clock),
    };
    const line = formatLogRecord(merged, { component, maxValueChars, includeStack });
    for (const sink of sinkList) {
      try {
        sink(line);
      } catch {
        /* see above: logging must not fail the caller */
      }
    }
  }

  /**
   * The canonical call: `log(recordOrMessage, fields?)`. A second argument's
   * `level` wins, which is how the orchestrator's line logger marks a failure
   * without the call sites changing shape.
   */
  const log = (input, fields) => {
    const merged = { ...normalizeRecord(input), ...(fields ?? {}) };
    if (fields !== undefined && fields !== null && typeof fields === "object") {
      merged.level = normalizeLevel(fields.level ?? merged.level);
    }
    emit(merged);
  };

  for (const name of /** @type {const} */ (["debug", "info", "warn", "error"])) {
    log[name] = (input, fields) =>
      emit({ ...normalizeRecord(input), ...(fields ?? {}), level: name });
  }

  log.level = threshold;
  log.isLevelEnabled = (value) => LOG_LEVELS[normalizeLevel(value)] >= LOG_LEVELS[threshold];
  log.child = (extraMeta = {}) => createLogger({ ...options, meta: { ...meta, ...extraMeta } });
  log.close = () => {
    for (const sink of sinkList) {
      if (typeof sink.close !== "function") continue;
      try {
        sink.close();
      } catch {
        /* closing is best-effort too */
      }
    }
  };
  log.sinks = sinkList;

  return log;
}
