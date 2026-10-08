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

import { DomainError } from "../shared/errors.mjs";
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
  } = options;

  const dataDir = resolveDataDir({ dataDir: options.dataDir ?? null, env });
  const dbPath = resolveDbPath({ dataDir, dbPath: options.dbPath ?? null, env });
  ensureDir(dataDir);

  const db = await openDatabase({ path: dbPath, readonly });

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
    if (err instanceof DomainError) throw err;
    throw err;
  }

  const token = readonly ? null : ensureToken(dataDir);
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
  const ctx = createContext({ db, repos, ...(clock === undefined ? {} : { clock }), ...(idFactory === undefined ? {} : { idFactory }), logger });
  const commands = createCommands(ctx);

  return {
    db,
    dbPath,
    dataDir,
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

/**
 * The pointer this machine would write, without writing it — how a client
 * discovers a *running* board.
 * @param {{env?: NodeJS.ProcessEnv, path?: string}} [options]
 */
export function readPointer(options = {}) {
  return readRuntimePointer(options);
}
