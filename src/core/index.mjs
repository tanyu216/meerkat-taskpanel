/**
 * Task Panel core.
 *
 * The engine of the board: the domain model, the SQLite storage layer, the
 * command surface and the bootstrap that wires them together. Surfaces (`cli/`,
 * `mcp/`, `server/`) are thin adapters over this module and import nothing else
 * from `src/core`.
 *
 * `STAGE` is kept from the M0 scaffold — `test/scaffold.test.mjs` asserts the
 * scaffold constants still exist, and removing it would break a surface that
 * this milestone does not own.
 */

export const STAGE = "core";

// Domain ------------------------------------------------------------------
export * from "./domain/index.mjs";

// Storage -----------------------------------------------------------------
export {
  applyMigrations,
  assertSchemaCurrent,
  checksumFor,
  defaultMigrationsDir,
  listMigrations,
  normalizeSql,
} from "./storage/migrations-runner.mjs";
export { closeDatabase, openDatabase, readPragmas, sqliteVersion } from "./storage/driver.mjs";
export { createRepositories } from "./storage/repositories/index.mjs";
export { currentRevision, recordActivity, transaction } from "./storage/unit-of-work.mjs";
export { mapSqliteError } from "./storage/sqlite-errors.mjs";
export { REVISION_TABLES, TABLES } from "./storage/schema.mjs";
export {
  ensureDir,
  resolveDataDir,
  resolveDbPath,
  resolveRuntimePointerPath,
  tokenPath,
} from "./storage/paths.mjs";
export { ensureToken, generateToken, isToken, readToken, rotateToken } from "./storage/secrets/token-store.mjs";
export {
  readRuntimePointer,
  writeRuntimePointer,
} from "./storage/secrets/runtime-pointer.mjs";
export { exportMd, renderCard } from "./storage/md/export.mjs";
export { importMd, parseCard } from "./storage/md/import.mjs";

// Commands ----------------------------------------------------------------
export { createCommands, createContext, actorOf, SYSTEM_ACTOR } from "./commands/index.mjs";

// Bootstrap ---------------------------------------------------------------
export { openBoard, readPointer } from "./bootstrap.mjs";
