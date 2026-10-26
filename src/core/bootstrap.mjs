/**
 * `openBoard()` — everything a surface needs to start working, in one call.
 *
 *   openBoard({dataDir}) → { db, repos, commands, ctx, token, pointer, schema, dbPath, close }
 *
 * The order is deliberate and short:
 *   1. resolve paths (env overrides included) and create the data dir 0700,
 *   2. open the connection (WAL, busy_timeout, foreign keys),
 *   3. migrate, then *assert* the schema is current — a board that is one
 *      migration behind must not serve,
 *   4. make sure a token exists (0600) and write the per-user pointer,
 *   5. hand back repositories and commands bound to a context.
 *
 * There is no HTTP here: `openBoard` is for the CLI, the server and the tests
 * alike, which is why it is the only place that knows all of the above.
 */

import { readConfigFileVars } from "../foundation/env-config.mjs";
import { DomainError } from "../foundation/errors.mjs";
import { readSlaConfig } from "../foundation/sla-config.mjs";
import { createCommands, createContext } from "./commands/index.mjs";
import { closeDatabase, openDatabase, sqliteVersion } from "./storage/driver.mjs";
import { applyMigrations, assertSchemaCurrent, listMigrations } from "./storage/migrations-runner.mjs";
import { ensureDir, resolveDataDir, resolveDbPath } from "./storage/paths.mjs";
import { createRepositories } from "./storage/repositories/index.mjs";
import { ensureToken } from "./storage/secrets/token-store.mjs";
import { readRuntimePointer, writeRuntimePointer } from "./storage/secrets/runtime-pointer.mjs";

/**
 * @param {{
 *   dataDir?: string|null,
 *   dbPath?: string|null,
 *   env?: NodeJS.ProcessEnv,
 *   clock?: () => Date|string,
 *   idFactory?: () => string,
 *   pointer?: boolean,
 *   pointerPath?: string,
 *   host?: string,
 *   port?: number,
 *   url?: string,
 *   readonly?: boolean,
 *   allowStale?: boolean,
 *   busyTimeoutMs?: number,
 *   envFile?: string|null,          // the config file path, for errors / the Access panel
 *   envVars?: Map<string,string>|Record<string,string>|null, // the parsed `.env` layer
 *   processEnv?: NodeJS.ProcessEnv|null, // the *unmerged* environment (source decisions)
 *   logger?: Function,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function openBoard(options = {}) {
  const {
    env = process.env,
    clock,
    idFactory,
    pointer: writePointer = true,
    pointerPath,
    host = env.TASKD_HOST ?? "0.0.0.0",
    port = Number(env.TASKD_PORT ?? 9527),
    url,
    readonly = false,
    allowStale = false,
    logger,
    envFile = null,
    envVars = null,
    processEnv = null,
  } = options;

  const dataDir = resolveDataDir({ dataDir: options.dataDir ?? null, env });
  const dbPath = resolveDbPath({ dataDir, dbPath: options.dbPath ?? null, env });
  ensureDir(dataDir);

  // 0038 — the board-level acceptance policy is gone (one project default plus a
  // per-card snapshot replaced it). A configured legacy value would silently not
  // apply, so the board **fails closed** and names the migration instead.
  assertNoLegacyAcceptancePolicy(env, envVars);

  // `busyTimeoutMs` is an *override* of the pinned 5000ms (§4.3), not a new
  // default: only a caller that says so gets a different lock wait. The tests
  // that exercise lock contention use it to keep a 5s wait out of the suite.
  let db;
  try {
    db = await openDatabase({
      path: dbPath,
      readonly,
      ...(Number.isFinite(options.busyTimeoutMs)
        ? { pragmas: { busy_timeout: Math.max(0, Math.trunc(options.busyTimeoutMs)) } }
        : {}),
    });
  } catch (err) {
    // `node:sqlite` missing, an unopenable file, a pragma refused — the driver
    // has no logger of its own, so its failure is named here.
    if (logger !== undefined) {
      logger({
        event: "board_open_failed",
        level: "error",
        db_path: dbPath,
        data_dir: dataDir,
        code: err?.code ?? null,
        message: err?.message ?? String(err),
      });
    }
    throw err;
  }

  let migration;
  let schema;
  try {
    if (readonly) {
      // A read-only open (an export, an inspection) must not migrate, and must
      // not quietly serve a stale schema either: being behind is only acceptable
      // when the caller says so, and then it is logged.
      migration = { applied: [], skipped: listMigrations().map((m) => m.version) };
      schema = assertSchemaCurrent(db, { allowStale });
      if (!schema.ok) {
        if (logger !== undefined) logger({ event: "schema_stale", missing: schema.missing });
      }
    } else {
      migration = applyMigrations(db, { logger });
      // Ask the database, not the runner: the runner only knows what it did
      // *this time*, and a stale board is exactly the case worth catching.
      schema = assertSchemaCurrent(db);
    }
  } catch (err) {
    closeDatabase(db);
    // The process edge records that start-up died (`startup_failed`); this
    // record names the step and the file behind it. A library caller that never
    // reaches that edge gets the specific failure here.
    if (logger !== undefined) {
      logger({
        event: "board_open_failed",
        level: "error",
        db_path: dbPath,
        data_dir: dataDir,
        code: err?.code ?? null,
        message: err?.message ?? String(err),
      });
    }
    throw err;
  }

  const token = readonly ? null : ensureToken(dataDir);
  if (token?.created === true && logger !== undefined) {
    logger({ event: "token_created", token_file: token.file, data_dir: dataDir });
  }
  const resolvedUrl = url ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

  let pointer = null;
  if (writePointer && !readonly) {
    const written = writeRuntimePointer(
      {
        url: resolvedUrl,
        host,
        port,
        dataDir,
        tokenFile: token.file,
        pid: process.pid,
      },
      pointerPath === undefined ? { env } : { env, path: pointerPath },
    );
    pointer = written.pointer;
  }

  // Repositories prepare their statements against the *current* shape, so a
  // stale schema would make them fail with a confusing SQL error somewhere far
  // from the cause. When the caller has explicitly accepted a stale schema, the
  // bag is a trap that names the real problem instead.
  const repos =
    schema.ok === false
      ? staleRepositoriesTrap(schema)
      : createRepositories(db);
  // The SLA table is board configuration. It is re-read per call, so a hand
  // edit (or a re-install) applies to the next `GET /api/v1/sla` without
  // restarting `taskd`. A named env file wins; an embedder that passes parsed
  // values instead gets those.
  const slaConfig = () =>
    readSlaConfig({
      env: processEnv ?? env,
      envVars: envFile ? readConfigFileVars(envFile) : (envVars ?? new Map()),
    });
  const ctx = createContext({
    db,
    repos,
    slaConfig,
    ...(clock === undefined ? {} : { clock }),
    ...(idFactory === undefined ? {} : { idFactory }),
    logger,
  });
  const commands = createCommands(ctx);

  return {
    db,
    dbPath,
    dataDir,
    envFile,
    repos,
    ctx,
    commands,
    token: token === null ? null : { file: token.file, created: token.created },
    pointer,
    pointerPath: pointerPath ?? null,
    migration,
    schema,
    version: sqliteVersion(db),
    close() {
      closeDatabase(db);
    },
  };
}

/**
 * A repository bag that refuses to be used.
 *
 * Only reachable through `readonly: true, allowStale: true`: the caller has
 * said "show me this database as it is", which is a job for raw SQL. Any
 * attempt to use the repositories is answered with the reason.
 *
 * @param {{missing: string[], unknownApplied: string[]}} schema
 */
function staleRepositoriesTrap(schema) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined; // not a thenable
        throw new DomainError("SCHEMA_MISMATCH", {
          message: `the database schema is stale (missing ${schema.missing.join(", ") || "—"}), so repositories are unavailable`,
          details: { missing: schema.missing, unknownApplied: schema.unknownApplied },
          hint: { fix: "open the board read-write so the migrations run, then try again" },
        });
      },
    },
  );
}

/** The env key the retired board-level acceptance policy lived under (0038). */
export const LEGACY_ACCEPTANCE_POLICY_ENV = "TASKD_ACCEPTANCE_POLICY";

/**
 * Refuse to start a board whose `.env` still configures the retired
 * board-level acceptance policy.
 *
 * Silently ignoring `human-only` would upgrade an operator into a different
 * closing rule than the one they asked for, so this is the one place old
 * configuration is an error. The replacement is board data, not configuration:
 * a project's `acceptance` default plus each card's snapshot.
 *
 * @param {NodeJS.ProcessEnv|null|undefined} env the merged environment
 * @param {Map<string,string>|Record<string,string>|null|undefined} envVars the parsed `.env`
 */
function assertNoLegacyAcceptancePolicy(env, envVars) {
  /** @param {unknown} value */
  const set = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  let value = null;
  if (env !== undefined && env !== null && set(env[LEGACY_ACCEPTANCE_POLICY_ENV])) {
    value = String(env[LEGACY_ACCEPTANCE_POLICY_ENV]);
  } else if (envVars instanceof Map && set(envVars.get(LEGACY_ACCEPTANCE_POLICY_ENV))) {
    value = String(envVars.get(LEGACY_ACCEPTANCE_POLICY_ENV));
  } else if (envVars !== null && typeof envVars === "object" && set(envVars[LEGACY_ACCEPTANCE_POLICY_ENV])) {
    value = String(envVars[LEGACY_ACCEPTANCE_POLICY_ENV]);
  }
  if (value === null) return;
  throw new DomainError("ACCESS_CONFIG_INVALID", {
    message:
      `${LEGACY_ACCEPTANCE_POLICY_ENV} is retired; card acceptance is now one project default ` +
      "plus a per-card acceptance mode (off | agent | human)",
    details: { key: LEGACY_ACCEPTANCE_POLICY_ENV, value },
    hint: {
      fix:
        `remove ${LEGACY_ACCEPTANCE_POLICY_ENV} from .env, then set the default with ` +
        "`taskctl project update <id> --acceptance human`",
    },
  });
}

/**
 * The pointer this machine would write, without writing it — how a client
 * discovers a *running* board.
 * @param {{env?: NodeJS.ProcessEnv, path?: string}} [options]
 */
export function readPointer(options = {}) {
  return readRuntimePointer(options);
}
