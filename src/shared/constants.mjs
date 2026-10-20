/**
 * Shared constants for Meerkat TaskPanel.
 *
 * These are the single source of truth for names used across the CLI, the skill,
 * the plugin manifests and the HTTP surface. Keep them in sync with
 * `package.json` (name/version) and `skills/meerkat-taskpanel/SKILL.md` (skill name).
 *
 * `src/core/**` imports its tunables from here (never from `process.env` in
 * `domain/`, which must stay free of Node I/O) so a single edit moves the
 * runtime defaults. Path handling lives in `src/core/storage/paths.mjs`.
 */

export const CLI_NAME = "taskctl";
export const SKILL_NAME = "meerkat-taskpanel";
export const VERSION = "1.1.0";

/**
 * The board's **contract schema generation** — which generation of the API/wire
 * contract this provider speaks, independent of the release `VERSION` above.
 *
 * This is the single source of truth for the number a *client* binds to: the
 * contract snapshot freezes it as the committed snapshot's own `schema_version`
 * (`scripts/verify/contract.mjs` reads it, it is not a second copy), and
 * `taskctl --version --json` publishes it, so a consumer can read the provider's
 * declared number **at runtime** instead of hard-coding one that silently drifts.
 * Bump it when the snapshot's own layout changes shape — see `docs/contract.md`.
 */
export const CONTRACT_SCHEMA_VERSION = 4;

// ---------------------------------------------------------------------------
// Data directory & files (ARCHITECTURE §7.1, plan §2 F8)
// ---------------------------------------------------------------------------

/** Env override for the data directory. */
export const DATA_DIR_ENV = "TASKD_DATA_DIR";
/** Env override for the database file (absolute path wins over `DATA_DIR_ENV`). */
export const DB_PATH_ENV = "TASKD_DB";
/** Env override for the HTTP port (D10: default 9527). */
export const PORT_ENV = "TASKD_PORT";
/** Env override for the listen host. */
export const HOST_ENV = "TASKD_HOST";
/**
 * Env override for the runtime pointer *file* (M2).
 *
 * The pointer is normally per-user (§7.1). The override exists so the test suite
 * can run a board in a temp directory without touching the developer's own
 * pointer — see `test/cli/helpers/cli-harness.mjs`.
 */
export const RUNTIME_POINTER_ENV = "TASKD_RUNTIME_POINTER";

/** Env override for the access token (M2, §7.1: `--token` > this > token file). */
export const TOKEN_ENV = "TASKD_TOKEN";

/**
 * A token kept in a file, as an alternative to `TASKD_TOKEN`.
 *
 * `TASKD_TOKEN` outranks it: a shell can export the token for one command
 * without rewriting the config file. The file is read only when it is the
 * winning source.
 */
export const TOKEN_FILE_ENV = "TASKD_TOKEN_FILE";

/**
 * The preferred board address. Unlike `--url` it is not a pin: it is probed,
 * and a dead *loopback* address may still fall through to the machine's
 * running board or a lazy start. A dead non-loopback address is an error.
 */
export const URL_ENV = "TASKD_URL";

/** Set to `1` to stop the CLI from spawning `taskd` (M2, §F-A1). */
export const NO_AUTOSTART_ENV = "TASKD_NO_AUTOSTART";

/**
 * The one client/server config file, at the program install root.
 *
 * `MEERKAT_TASKPANEL_ENV_FILE` overrides the path (tests, containers, a
 * read-only package root). It is *not* a secret and is inherited by a spawned
 * `taskd`.
 */
export const ENV_FILE_ENV = "MEERKAT_TASKPANEL_ENV_FILE";
/** Default config file name at the program root. */
export const ENV_FILE_FILENAME = ".env";
/** The URL a fresh install seeds into `.env`; a default value, not a code fallback. */
export const DEFAULT_BOARD_URL = "http://localhost:9527";

/**
 * Keys `.env` may carry. Anything else in our namespaces is a typo; keys
 * outside them (Vite's `VITE_*`, `NODE_ENV`, …) are ignored and never merged.
 */
export const CLIENT_CONFIG_KEYS = Object.freeze([
  URL_ENV,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  NO_AUTOSTART_ENV,
  DATA_DIR_ENV,
  DB_PATH_ENV,
  RUNTIME_POINTER_ENV,
  HOST_ENV,
  PORT_ENV,
  "TASKD_ALLOW_CIDRS",
  "TASKD_ALLOW_LIST_ENABLED",
  "TASKD_ACCEPTANCE_POLICY",
  "TASKD_LABEL_GC",
  "TASKD_LABEL_TTL_DAYS",
  "TASKCTL_AGENT",
  "TASKCTL_HUMAN",
  "MEERKAT_TASKPANEL_PROJECTS_JSON",
]);

/** Namespaces that belong to this project; an unknown key in one is an error. */
export const CONFIG_NAMESPACES = Object.freeze(["TASKD_", "TASKCTL_", "MEERKAT_TASKPANEL_"]);

/**
 * Client-only keys stripped from a spawned `taskd`'s environment.
 *
 * `MEERKAT_TASKPANEL_ENV_FILE` is deliberately *not* here: the child must read
 * the same config file, including a test/container override.
 */
export const SPAWN_ENV_OMIT = Object.freeze([
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  URL_ENV,
  NO_AUTOSTART_ENV,
  "TASKCTL_AGENT",
  "TASKCTL_ACTOR_KIND",
  "TASKCTL_HUMAN",
  "TASKCTL_SESSION_ID",
  "TASKCTL_AGENT_PLATFORM",
]);

/** `<repo>/.data` — gitignored; overridden by `TASKD_DATA_DIR`. */
export const DEFAULT_DATA_DIR = ".data";
/** Board database file name (ARCHITECTURE §1: `.data/board.sqlite`). */
export const DB_FILENAME = "board.sqlite";
/** Access token file name inside the data directory. */
export const TOKEN_FILENAME = "token";
/** Log directory name inside the data directory. */
export const LOGS_DIRNAME = "logs";
/**
 * The daemon's log file name, inside the log directory.
 *
 * One name for one file: the CLI's lazy start writes it (`spawnTaskd`) and the
 * OS-level `taskd` keepalive unit appends to it, so a reader sees one history
 * whichever way the server was started. The installer renders the unit's log
 * path from this constant rather than restating the literal.
 */
export const LOG_FILENAME = "taskd.log";
/**
 * The single-writer lock's file name inside the data directory (R1).
 *
 * One `taskd` owns a data directory: the lock makes a second instance a
 * *refusal* rather than a race over the runtime pointer. See
 * `src/core/storage/writer-lock.mjs`.
 */
export const WRITER_LOCK_FILENAME = "writer.lock";
/**
 * A board's *own* address file, inside its data directory (§7.1).
 *
 * That is where the runtime pointer goes when the machine-wide one is held by
 * another live board — the same reasoning as the write lock beside it: a board
 * with this data directory and a board with another one are different boards,
 * and the second must not be able to unplug the first. See
 * `src/core/storage/secrets/runtime-pointer.mjs`.
 */
export const RUNTIME_FILENAME = "runtime.json";
/** Default HTTP port (D10 — 4 digits, avoids common dev ports). */
export const DEFAULT_PORT = 9527;
/** Default listen host (ARCHITECTURE §7: welcome LAN access). */
export const DEFAULT_HOST = "0.0.0.0";

/** How long the CLI waits for a freshly spawned `taskd` to answer `/health`. */
export const AUTOSTART_TIMEOUT_MS = 5_000;
/** How often it retries while waiting. */
export const AUTOSTART_POLL_MS = 100;

// ---------------------------------------------------------------------------
// Write-path resilience (R2: lock contention is not a server error)
// ---------------------------------------------------------------------------

/**
 * How many times an **outermost** transaction is attempted before lock
 * contention is reported (`DB_BUSY`, HTTP 503) instead of retried.
 *
 * `busy_timeout` already waits 5s inside SQLite; these attempts are the margin
 * past it, for the writer that holds the lock a little longer than that (a big
 * migration, a slow trigger, a stalled disk). Three attempts is bounded and
 * small: the worst case — every attempt waiting out the full `busy_timeout` —
 * is a ~15s synchronous wait, which is the honest price of a single-threaded
 * synchronous driver. A nested transaction is never retried: the connection
 * already holds the write lock, so a savepoint cannot hit `SQLITE_BUSY`.
 */
export const DB_BUSY_MAX_ATTEMPTS = 3;
/** Pause between attempts. Small: SQLite's own `busy_timeout` is the real wait. */
export const DB_BUSY_BACKOFF_MS = 25;

// ---------------------------------------------------------------------------
// CLI exits (§F-C2: 0 ok | 1 runtime | 2 usage | 3 export --md --check differs)
// ---------------------------------------------------------------------------

/** Process exit codes. `3` is `export md --check` finding stale cards. */
export const CLI_EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  DIFFERENCES: 3,
});

// ---------------------------------------------------------------------------
// Secrets (ARCHITECTURE §7.1)
// ---------------------------------------------------------------------------

/** Every access token starts with this. */
export const TOKEN_PREFIX = "td_";
/** 32 random bytes ⇒ 64 hex chars after the prefix. */
export const TOKEN_BYTES = 32;
/** Directory mode for the data dir / runtime-pointer dir. */
export const SECRET_DIR_MODE = 0o700;
/** File mode for the token / runtime pointer. */
export const SECRET_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Task lifecycle (plan §3.9, ARCHITECTURE §4.3)
// ---------------------------------------------------------------------------

/** A claim is "fresh" for 10 minutes; a fresher claim blocks other actors. */
export const HEARTBEAT_FRESH_MS = 600_000;
/**
 * Claim staleness thresholds — kept in lockstep with the openclaw-team
 * framework's `poll.mjs` (`CLAIM_STALE_SAME_MS` / `CLAIM_STALE_ANY_MS`) so the
 * candidate read returns the same recovery pool the poll would claim.
 */
/** A claim older than 30 minutes is stale for its own holder (re-claimable by the same assignee). */
export const CLAIM_STALE_SAME_MS = 30 * 60 * 1000;
/** Any claim older than 6 hours is stale for everyone (reclaimable by any assignee). */
export const CLAIM_STALE_ANY_MS = 6 * 60 * 60 * 1000;
/** Terminal tasks become archivable after 7 days (I6). */
export const ARCHIVE_AFTER_DAYS = 7;

// ---------------------------------------------------------------------------
// Labels (ARCHITECTURE §4.1 / §4.4, rulings F1/F2/F5)
// ---------------------------------------------------------------------------

/**
 * The label colour palette (F2-A): fixed, project-scoped, no user choice.
 *
 * A new label takes the first colour **not currently used by a non-archived
 * label in the same project**; once the palette is exhausted the least-used
 * colour wins (ties broken by palette order). A colour, once assigned, is never
 * recomputed — a label that is archived and later revives keeps the colour it
 * had.
 *
 * These are placeholders pending brand alignment (`design/` is out of scope for
 * this card); the palette lives here so the algorithm and the tones are one edit
 * apart.
 */
export const LABEL_PALETTE = Object.freeze([
  "#e5484d", // red
  "#f76b15", // orange
  "#f5a623", // amber
  "#eab308", // yellow
  "#46a758", // green
  "#12a594", // teal
  "#0091ff", // blue
  "#3e63dd", // indigo
  "#8e4ec6", // purple
  "#e93d82", // pink
  "#8b8d98", // slate
  "#ad7f58", // brown
]);

/** Default TTL: an unused label is collectable after this many days (30). */
export const LABEL_TTL_DAYS_DEFAULT = 30;
/** Env override for the TTL, in days. */
export const LABEL_TTL_DAYS_ENV = "TASKD_LABEL_TTL_DAYS";
/** Set to `off` to stop `taskd` from running the label GC at all. */
export const LABEL_GC_ENV = "TASKD_LABEL_GC";
/** `taskd`'s label-GC period (F1-C): once at startup, then every 24h. */
export const LABEL_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Maximum length of a label (display) name. */
export const LABEL_MAX_LEN = 64;

// ---------------------------------------------------------------------------
// Relations (ARCHITECTURE §4.2)
// ---------------------------------------------------------------------------

/** Maximum parent/child chain length, counting both endpoints. */
export const RELATION_CHAIN_MAX = 8;
/** Maximum number of children a single parent may have. */
export const RELATION_FANIN_MAX = 8;
/** Recursion guard for the ancestor CTE in SQL and in `domain/relation.mjs`. */
export const RELATION_ANCESTOR_CAP = 64;

// ---------------------------------------------------------------------------
// Reports (plan §3.5)
// ---------------------------------------------------------------------------

/** Maximum serialised size of `acceptance_json` + `evidence_json`. */
export const REPORT_MAX_BYTES = 64 * 1024;
/** Maximum number of acceptance items / evidence anchors per report. */
export const REPORT_MAX_ITEMS = 64;
/** Maximum length of a report conclusion (characters). */
export const REPORT_MAX_CONCLUSION_CHARS = 16_384;

// ---------------------------------------------------------------------------
// md export
// ---------------------------------------------------------------------------

/** Rewriting a card may not grow it beyond input × this factor. */
export const MD_GROWTH_FACTOR = 4;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/** UUIDv5 namespace for deterministic agent-session ids. */
export const SESSION_ID_NAMESPACE = "4f3d9c2a-1b77-5e0c-9a4d-8f6e2b1c0d5a";
/** Zero-padding for the numeric part of a generated task identifier. */
export const IDENTIFIER_PAD = 4;
/** Permissive identifier shape: legacy imported ids must keep working (F2). */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// Access control (ARCHITECTURE §7, M6a)
// ---------------------------------------------------------------------------

/**
 * Comma/space separated **CIDR allow-list** for non-loopback callers.
 *
 * Unset (the default) means "allow every address" — the board is local-first and
 * welcomes the LAN. Setting it *tightens* the board: once the variable is
 * present, only addresses inside one of its prefixes are served, and everything
 * else is answered `403`. Loopback is always allowed, so an over-tight list
 * cannot lock the owner out of their own machine.
 */
export const ALLOW_CIDRS_ENV = "TASKD_ALLOW_CIDRS";

// ---------------------------------------------------------------------------
// SSE event stream (ARCHITECTURE §4.3 / §5.4, M6a)
// ---------------------------------------------------------------------------

/** How often the stream sends a `: ping` comment so a dead peer is noticed. */
export const SSE_HEARTBEAT_MS = 15_000;
/** How often the stream polls `task_activities` for new increments. */
export const SSE_POLL_MS = 500;
/** The `retry:` hint an EventSource should honour after a dropped connection. */
export const SSE_RETRY_MS = 3_000;
/** At most this many activity rows are replayed for a `?after=<rev>` reconnect. */
export const SSE_REPLAY_LIMIT = 500;
/**
 * Activity events that carry no board state (§4.3: "排除纯心跳").
 *
 * A heartbeat touches `heartbeat_at` and bumps the revision, but nothing a board
 * renders changes, so it is filtered out of the stream. The row still exists in
 * `task_activities` — this is a *projection* rule, not a storage one.
 */
export const SSE_NOISE_EVENTS = Object.freeze(["task_heartbeat"]);

/**
 * How long the loop's SSE subscriber tolerates a silent stream before it
 * reconnects. Three missed 15 s heartbeats is a dead connection, not a quiet
 * board.
 */
export const SSE_SUBSCRIBE_IDLE_MS = 45_000;
/** Coalesce a burst of board events into one dispatch decision. */
export const EVENT_DEBOUNCE_MS = 300;
/** ...but never delay a dispatch longer than this, however busy the stream is. */
export const EVENT_DEBOUNCE_MAX_MS = 2_000;
/** At most one event-triggered continue turn per this interval. */
export const EVENT_CONTINUE_MIN_MS = 60_000;
/** How soon to retry a dispatch whose continue turn was already in flight. */
export const SUBSCRIBE_RETRY_MS = 5_000;
/** The reconnect ladder's ceiling, matching the web client's 30 s. */
export const SUBSCRIBE_BACKOFF_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// Static hosting (ARCHITECTURE §8, M6a)
// ---------------------------------------------------------------------------

/** Where a built frontend lives, relative to the repository root. Absent is fine. */
export const STATIC_DIR_REL = "web/dist";
/** `index.html` — the SPA shell a deep link falls back to. */
export const STATIC_INDEX = "index.html";

// ---------------------------------------------------------------------------
// Attachments (ARCHITECTURE §5.1 / §13, M6a)
// ---------------------------------------------------------------------------

/** Content bytes live here, under the data directory; the row stays metadata. */
export const ATTACHMENTS_DIRNAME = "attachments";
/** Upper bound on an uploaded attachment body (8 MiB). */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The `content_type` values an attachment row may declare (T-20261014-212017-4).
 *
 * Before this list existed `content_type` was whatever the caller sent and it was
 * echoed back verbatim on download, so a caller could store `text/html` and have
 * the board serve it from its own origin. The list is the **closed** set the
 * board will store, and the download path states `content-disposition:
 * attachment` + `X-Content-Type-Options: nosniff` beside it, so a stored type is
 * never a type the browser gets to *interpret* as same-origin active content.
 *
 * Two deliberate omissions: `text/html`/`application/xhtml+xml` (a stored page)
 * and `image/svg+xml` (an SVG is a script host). Both remain uploadable as
 * `application/octet-stream`, which is what "we do not know what this is"
 * already means on this board.
 *
 * A missing `content_type` is allowed and stored as `null`; the download path
 * then serves `application/octet-stream`.
 */
export const ATTACHMENT_CONTENT_TYPES = Object.freeze([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * The `content_type` an attachment is stored with when the caller names none,
 * and the type the download path serves for a row that has none.
 */
export const ATTACHMENT_DEFAULT_CONTENT_TYPE = "application/octet-stream";

// ---------------------------------------------------------------------------
// Project ordering (DESIGN.md §20, M6a)
// ---------------------------------------------------------------------------

/**
 * The PROJECTS list weight algorithm: recency-weighted activity plus age.
 * `A7` (7-day activity) 0.50 · `A30` (30-day) 0.30 · `C` (created) 0.20.
 */
export const PROJECT_ORDER_WEIGHTS = Object.freeze({ a7: 0.5, a30: 0.3, created: 0.2 });
/** The two activity windows, in days (DESIGN.md §20). */
export const PROJECT_ACTIVITY_WINDOW_DAYS = Object.freeze({ a7: 7, a30: 30 });

// ---------------------------------------------------------------------------
// Assignee task ordering (C-WEIGHT-1, `design/contracts/assignee-weight-order.md`)
// ---------------------------------------------------------------------------

/**
 * The signed-off **assignee task weight** vector (Terry, 2026-10-14; contract §5.1):
 * `P .30 / W .25 / S .20 / A .10 / B .10 / L .05`, and `Σ = 1.00`.
 *
 * `P` priority · `W` dwell in the current status · `S` SLA pressure · `A` age ·
 * `B` open downstream · `L` severity (`sev:` labels). Each factor is normalised
 * into `[0,1]` before it is weighted, so a weight reads directly as "this
 * factor's share of the ordering decision" — which is why the numbers are worth
 * signing rather than inferring.
 */
export const TASK_ORDER_WEIGHTS = Object.freeze({ P: 0.3, W: 0.25, S: 0.2, A: 0.1, B: 0.1, L: 0.05 });

/**
 * Is the optional severity factor `L` in play? **No** (contract §4.2 / R9).
 *
 * `sev:*` is a documented convention (`guides/task-interface.md` §15), not a
 * schema-checked column, so its weight is not spent until Terry rules otherwise
 * (contract §5.4 question 3). While it is off the *factor* is forced to `0` for
 * every card: the optional factor's share is left **unused, not redistributed**,
 * so the other five weights stay exactly the signed numbers and the contract's
 * §9.4 worked examples reproduce to the digit. `Σ` of the enabled weights is
 * therefore `0.95` — the honest number, and the one difference from the
 * contract's "Σ = 1.00" that disabling an optional factor necessarily makes.
 */
export const TASK_ORDER_SEVERITY_ENABLED = false;

/**
 * The **saturation points** of the three ratio-clamped factors (contract §6.2).
 *
 * Unlike `PROJECT_ORDER_WEIGHTS`' rank normalisation, every factor here is
 * `min(value / cap, 1)`: a card's score depends on that card alone, which is
 * what lets the order be paginated and keeps one card's arrival from re-scoring
 * everybody else. `dwell`/`age` are hours; `unblocks` is a count of open
 * downstream cards, capped at 3 because `0/1/2/3+` are the only meaningful
 * buckets (`PROTOCOL §①` limits fan-in and chain length to 8).
 */
export const TASK_ORDER_CAPS = Object.freeze({ dwellHours: 72, ageHours: 720, unblocks: 3 });

/**
 * SLA thresholds in **hours of wall clock**, by card status (contract §5.2 / R3).
 *
 * There is no product-side SLA constant anywhere else in the tree; these mirror
 * the rows of the team `PROTOCOL §⑮` that can be mapped onto a status. A status
 * **absent** from this table has no threshold and scores `S = 0` — not a skip,
 * not a `NaN` ("no definition" is reported, not faked). v1 measures wall clock;
 * `PROTOCOL §⑮`'s Asia/Shanghai working-hours calendar is a v2 extension Terry
 * still has to rule on (§5.4 question 2), and is the one place a strict reading
 * would add real engineering.
 */
export const TASK_ORDER_SLA_HOURS = Object.freeze({ blocked: 2, in_review: 24, awaiting: 24 });

/**
 * The board read's page size when a caller does not ask for one.
 *
 * Shared because two layers now page the same read: the repository puts it in
 * SQL's `LIMIT`, and the weight order — which has to see the whole scoped set
 * before it can order it — applies the same number when it slices the page in
 * JS. One constant, so the two cannot drift into "the default page is 200, and
 * sometimes 200 of something else".
 */
export const TASK_LIST_DEFAULT_LIMIT = 200;

/** The two `?order=` values (contract §7.1). `board` is the default; `weight` is opt-in. */
export const TASK_ORDER_MODES = Object.freeze(["board", "weight"]);
/**
 * The default `?order=` — the existing deterministic `sort_order, created_at,
 * project_id, identifier` order. The weight order is a **deliberate opt-in**: it
 * is clock-dependent (R5), and it is what `src/shared/scheduling.mjs#planTick`
 * dispatches on, so making it the default would silently change who works next
 * (§7.1/§7.4).
 */
export const TASK_ORDER_DEFAULT = "board";
/**
 * The capability bit a client probes instead of guessing (§7.1), published beside
 * `project_order` on `/meta`.
 */
export const TASK_ORDER_CAPABILITY = "weights-v1";

/**
 * The one reserved actor kind — the only value any decision turns on.
 *
 * An actor's kind is otherwise an opaque string: `human`, or the platform an
 * agent runs on (`claude`, `codex`, `pi`, …), or `taskd` for the board itself.
 * Everywhere the board asks "was this a person?" — a decision comment going on
 * the record (I5), an `awaiting` card resuming, the patrol counting the leader
 * as active — the test is `kind === HUMAN_KIND`. Everything else is an agent.
 *
 * It lives here, in `shared`, because the transport reads it too
 * (`shared/transport/actor.mjs`) and `shared` imports nothing from `src/`.
 * `src/core/domain/enums.mjs` re-exports it for the domain layer.
 */
export const HUMAN_KIND = "human";

/**
 * The board's own platform name.
 *
 * `taskd` is a concrete writer, not a role: it names the process that performs
 * the board's housekeeping (rollup, the label GC, the markdown importer) and
 * the automation that applies an acceptance verdict. It is the value
 * `HUMAN_KIND`'s documentation has always pointed at — "or `taskd` for the board
 * itself" — and the one the `system` placeholder in older rows is replaced by.
 *
 * The actor-kind column stays open; this constant exists so our own writes name
 * a platform instead of a vague role word.
 */
export const TASKD_KIND = "taskd";

/**
 * The board's acceptance policies — "who may move a card to `done`".
 *
 * Declared in `shared` because **both** sides of the board read the same
 * vocabulary: `src/core/domain/status.mjs` enforces it, and
 * `src/shared/scheduling.mjs` resolves the loop's copy from its host config
 * (which is what the loop believes before the board tells it otherwise).
 *
 *   * `human-only` — only a human accepts a top-level original;
 *   * `both` — a human or the board (`taskd`);
 *   * `agent-only` — any non-human writer.
 *
 * In every mode a human closes only **top-level** cards, and a review card is
 * closed by the human or the board (any non-human under `agent-only`).
 */
export const ACCEPTANCE_POLICIES = Object.freeze(["human-only", "both", "agent-only"]);

/** The policy used when none is configured (`both`, the historical rule). */
export const DEFAULT_ACCEPTANCE_POLICY = "both";

/**
 * The `meta.accepted_by` marker the workflow pass writes when the board's
 * automated acceptance (not a human) closes a card after a review verdict.
 * One source for the core decision, the SLA patrol and the loop's executor.
 */
export const LOOP_ACCEPTOR = "loop-review";

/**
 * Default cap on cards read in one pass — the loop's patrol/board read and the
 * board's workflow snapshot share it.
 *
 * It lives here rather than in `sla-patrol.mjs` because both sides read it: the
 * SLA pass caps its own read, and `workflowTick` caps the snapshot it plans
 * from. A loop-only module may not be imported by `src/core`; the shared SDK may.
 */
export const DEFAULT_BOARD_LIMIT = 500;

/** Default cap on writes one workflow pass may perform (board plan and loop). */
export const DEFAULT_WORKFLOW_MAX_ACTIONS = 20;

/**
 * How long a review card may sit without a readable verdict before the loop
 * says so.
 *
 * This is a real gap the SLA pass cannot cover: creating the review card
 * suppresses the original's `acceptance_card_creation` row, so a reviewer that
 * is never woken (or keeps failing to report) would otherwise be silent. The
 * default is generous: an hour of wall clock is well inside the `§⑮` day-long
 * acceptance limit, and a faster threshold would page on a normal queue.
 *
 * The board's planner and the loop's config resolver both read it — one number,
 * so a board that decides "aged" and a loop that decides "not yet" cannot
 * disagree.
 */
export const DEFAULT_REVIEW_AGING_MS = 60 * 60_000;
