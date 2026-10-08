/**
 * Shared constants for Task Panel.
 *
 * These are the single source of truth for names used across the CLI, the skill,
 * the plugin manifests and the future MCP/HTTP surfaces. Keep them in sync with
 * `package.json` (name/version) and `skills/task-panel/SKILL.md` (skill name).
 *
 * `src/core/**` imports its tunables from here (never from `process.env` in
 * `domain/`, which must stay free of Node I/O) so a single edit moves the
 * runtime defaults. Path handling lives in `src/core/storage/paths.mjs`.
 */

export const CLI_NAME = "taskctl";
export const SKILL_NAME = "task-panel";
export const PACKAGE_NAME = "task-panel";
export const VERSION = "0.0.0";

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

/** Set to `1` to stop the CLI from spawning `taskd` (M2, §F-A1). */
export const NO_AUTOSTART_ENV = "TASKD_NO_AUTOSTART";

/** `<repo>/.data` — gitignored; overridden by `TASKD_DATA_DIR`. */
export const DEFAULT_DATA_DIR = ".data";
/** Board database file name (ARCHITECTURE §1: `.data/board.sqlite`). */
export const DB_FILENAME = "board.sqlite";
/** Access token file name inside the data directory. */
export const TOKEN_FILENAME = "token";
/** Log directory name inside the data directory. */
export const LOGS_DIRNAME = "logs";
/** Default HTTP port (D10 — 4 digits, avoids common dev ports). */
export const DEFAULT_PORT = 9527;
/** Default listen host (ARCHITECTURE §7: welcome LAN access). */
export const DEFAULT_HOST = "0.0.0.0";

/** Default host for a CLI-spawned `taskd`: a spawned daemon serves this machine. */
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
/** How long the CLI waits for a freshly spawned `taskd` to answer `/health`. */
export const AUTOSTART_TIMEOUT_MS = 5_000;
/** How often it retries while waiting. */
export const AUTOSTART_POLL_MS = 100;

// ---------------------------------------------------------------------------
// CLI exits (§F-C2: 0 ok | 1 runtime | 2 usage | 3 export --md --check differs)
// ---------------------------------------------------------------------------

/** Process exit codes. `3` is shared with `migrate-cli check` on purpose. */
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
// md migrator (plan §3.7)
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
