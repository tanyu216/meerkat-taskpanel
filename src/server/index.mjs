/**
 * `taskd` — the local API server (M2's minimal slice of §5.1).
 *
 * One process owns the SQLite file (single-writer), and every surface talks to
 * it over loopback HTTP. M2 implements exactly the routes the CLI needs: the
 * command surface plus `/health` and `/meta`. **Not** here, on purpose: SSE,
 * static hosting and the board projection — those are M6.
 *
 * `createTaskd` is library-shaped so the tests can start a board *in-process* on
 * an ephemeral port with no runtime pointer and no ports left open
 * (`test/cli/helpers/cli-harness.mjs`). `main.mjs` is the executable that adds
 * the missing pieces a real daemon needs: the pointer, signals and logging.
 *
 * Nothing here writes a runtime pointer — the pointer has to name the *actual*
 * bound port, and only the caller knows that after `listen`.
 *
 * Besides the routes, the daemon owns the **label GC** (ruling F1-C): one sweep at
 * startup and then on a 24h `unref()`ed timer. It lives here rather than in a
 * route because `taskd` is the single writer — the one process that may prune the
 * registry. See `startLabelGc` below.
 */

import { createServer } from "node:http";

import { currentRevision, openBoard, readToken } from "../core/index.mjs";
import {
  LABEL_GC_ENV,
  LABEL_GC_INTERVAL_MS,
  LABEL_TTL_DAYS_DEFAULT,
  LABEL_TTL_DAYS_ENV,
  VERSION,
} from "../shared/constants.mjs";
import { authorize } from "./auth.mjs";
import { createRouter, errorResponse, readJsonBody, sendJson } from "./router.mjs";
import { registerCommentRoutes } from "./routes/comments.mjs";
import { registerDictionaryRoutes } from "./routes/dictionary.mjs";
import { registerExportRoutes } from "./routes/export.mjs";
import { registerLabelRoutes } from "./routes/labels.mjs";
import { registerProjectRoutes } from "./routes/projects.mjs";
import { registerRelationRoutes } from "./routes/relations.mjs";
import { registerSessionRoutes } from "./routes/sessions.mjs";
import { registerTaskRoutes } from "./routes/tasks.mjs";
import { registerTokenRoutes } from "./routes/token.mjs";

/** Kept for the M0 scaffold contract test; the surface is real now. */
export const STAGE = "taskd";

/**
 * Who is calling. The CLI sends `X-Taskctl-Actor: {"kind":"agent","id":"linus"}`;
 * anything else is an anonymous local human, which is what `curl` is.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function actorFromRequest(req) {
  const raw = req.headers["x-taskctl-actor"];
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.id === "string") {
        return { kind: ["agent", "human", "system"].includes(parsed.kind) ? parsed.kind : "human", id: parsed.id };
      }
    } catch {
      /* A malformed header is not worth failing a request over; fall through. */
    }
  }
  return { kind: "human", id: "local" };
}

/** @param {import('node:http').IncomingMessage} req @param {string} name */
function headerOf(req, name) {
  const value = req.headers[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Start the board service.
 *
 * @param {{
 *   dataDir?: string|null, dbPath?: string|null, host?: string, port?: number,
 *   env?: NodeJS.ProcessEnv, logger?: Function,
 *   clock?: () => Date|string, idFactory?: () => string,
 *   gcIntervalMs?: number,   // label GC period; 0 = startup sweep only (F1-C)
 *   gcTtlDays?: number,      // label GC TTL in days
 *   gc?: boolean,            // false = no label GC at all
 *   authorize?: Function,  // override for tests; defaults to the real check
 * }} [options]
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number, host: string, board: object, token: string, close: () => Promise<void>}>}
 */
export async function createTaskd(options = {}) {
  const {
    host = "127.0.0.1",
    port = 0,
    env = process.env,
    logger,
    // Injectable so the *rejection* path can be exercised over a real socket:
    // a test process cannot genuinely arrive from a non-loopback address
    // (test/server/auth.test.mjs says the same thing in prose).
    authorize: authorizeRequest = authorize,
  } = options;

  // The pointer is *never* written here: it must carry the port the OS actually
  // assigned, which is only known after `listen`.
  const board = await openBoard({
    dataDir: options.dataDir ?? null,
    dbPath: options.dbPath ?? null,
    env,
    pointer: false,
    ...(logger === undefined ? {} : { logger }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  });

  // The label GC (F1-C): one sweep now, then on a timer. `taskd` is the single
  // writer, so it is the one process that may prune the registry.
  const labelGc = startLabelGc({ board, env, logger, options });

  const token = board.token === null ? null : readTokenFile(board.dataDir);
  const startedAt = Date.now();
  const router = createRouter();
  const surface = { board, token, logger };

  router.get("/health", () => ({
    status: "ok",
    stage: STAGE,
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
    revision: currentRevision(board.db),
  }));

  router.get("/meta", () => ({
    version: VERSION,
    stage: STAGE,
    dbPath: board.dbPath,
    dataDir: board.dataDir,
    revision: currentRevision(board.db),
    migration: board.migration,
    schema: board.schema,
  }));

  registerTokenRoutes(router, surface);
  registerProjectRoutes(router, surface);
  registerTaskRoutes(router, surface);
  registerCommentRoutes(router, surface);
  registerRelationRoutes(router, surface);
  registerSessionRoutes(router, surface);
  registerDictionaryRoutes(router, surface);
  registerLabelRoutes(router, surface);
  registerExportRoutes(router, surface);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const { status, payload } = errorResponse(err);
      sendJson(res, status, payload);
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}`}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // `/health` is deliberately unauthenticated: it is the liveness probe the
    // CLI's autostart polls, and it exposes nothing but "I am here".
    if (pathname === "/health") {
      sendJson(res, 200, { ok: true, data: router.match("GET", "/health").handler({}) });
      return;
    }

    const decision = authorizeRequest({ req, url, token, rotate: pathname === "/api/v1/token" });
    if (!decision.ok) {
      sendJson(res, decision.status, decision.payload);
      return;
    }

    const route = router.match(req.method ?? "GET", pathname);
    if (route === null) {
      sendJson(res, 404, {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `no route for ${req.method} ${pathname}`,
          http: 404,
          details: { method: req.method, path: pathname },
          hint: null,
        },
      });
      return;
    }

    const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method ?? "")
      ? await readJsonBody(req)
      : {};

    const data = await route.handler({
      params: route.params,
      query: url.searchParams,
      body,
      actor: actorFromRequest(req),
      session: headerOf(req, "x-taskctl-session"),
      seg: headerOf(req, "x-taskctl-seg"),
      board,
      token,
    });
    sendJson(res, 200, { ok: true, data: data === undefined ? null : data });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = boardUrl(host, boundPort);

  return {
    server,
    board,
    host,
    port: boundPort,
    url,
    token,
    /** The label GC, exposed so a test can trigger a sweep without waiting out the timer. */
    labelGc,
    async close() {
      labelGc.stop();
      await new Promise((resolve) => server.close(resolve));
      board.close();
    },
  };
}

/** The GC period in ms: `0` disables it. `TASKD_LABEL_GC=off` is the env switch. */
export function labelGcIntervalMs(env, override) {
  if (Number.isFinite(override)) return Math.max(0, override);
  if (env[LABEL_GC_ENV] === "off") return 0;
  return LABEL_GC_INTERVAL_MS;
}

/** The TTL in days; `TASKD_LABEL_TTL_DAYS` overrides the default (F1-C / §4.4). */
export function labelGcTtlDays(env, override) {
  if (Number.isFinite(override)) return override;
  const raw = env[LABEL_TTL_DAYS_ENV];
  if (raw === undefined || raw === "") return LABEL_TTL_DAYS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : LABEL_TTL_DAYS_DEFAULT;
}

/**
 * Run the label GC at startup and on a timer (ruling F1-C: default 24h, enabled
 * by default, timer `unref()`ed so it never holds the process open, interval
 * injectable so a test can disable or shorten it).
 *
 * The sweep is wrapped so a GC failure is **logged, never fatal**: housekeeping
 * must not take the board down. A sweep that collects nothing writes nothing, so
 * a fresh board costs one query and leaves no trace.
 *
 * @param {{board: object, env: NodeJS.ProcessEnv, logger?: Function, options: object}} input
 */
export function startLabelGc(input) {
  const { board, env, logger, options } = input;
  // On by default (F1-C). `TASKD_LABEL_GC=off` — or an explicit `gc: false` —
  // turns off *both* the startup sweep and the timer; `gcIntervalMs: 0` only
  // silences the timer while keeping the startup sweep.
  const enabled = options.gc === undefined ? env[LABEL_GC_ENV] !== "off" : options.gc !== false;
  const intervalMs = enabled ? labelGcIntervalMs(env, options.gcIntervalMs) : 0;
  const ttlDays = labelGcTtlDays(env, options.gcTtlDays);
  const state = { intervalMs, ttlDays, last: null, timer: null };

  const run = () => {
    let result;
    try {
      result = board.commands.collectUnusedLabels({ ttlDays });
      if ((result.archived.length > 0 || result.mismatched.length > 0) && typeof logger === "function") {
        logger({
          event: "label_gc",
          archived: result.archived.length,
          kept: result.kept,
          mismatched: result.mismatched.length,
        });
      }
    } catch (err) {
      // Never let the GC break the daemon (§4.4: "GC 失败绝不允许阻断").
      if (typeof logger === "function") {
        logger({ event: "label_gc_failed", code: err?.code ?? null, message: err?.message ?? String(err) });
      }
      result = { archived: [], kept: 0, mismatched: [], failed: true };
    }
    state.last = result;
    return result;
  };

  if (enabled) run();
  if (enabled && intervalMs > 0) {
    state.timer = setInterval(run, intervalMs);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  return {
    enabled,
    intervalMs,
    ttlDays,
    run,
    get last() {
      return state.last;
    },
    stop() {
      if (state.timer !== null) {
        clearInterval(state.timer);
        state.timer = null;
      }
    },
  };
}

/**
 * The URL a client should use for a board listening on `host`.
 *
 * A wildcard bind is not an address anybody can dial, so it is reported as
 * loopback; an IPv6 literal needs brackets or the port reads as part of it.
 * Pure, and exported because both rules are worth a test each.
 *
 * @param {string} host @param {number} port
 */
export function boardUrl(host, port) {
  const dialable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${dialable.includes(":") ? `[${dialable}]` : dialable}:${port}`;
}

/** Read the token core generated at `openBoard` time (never echoed in a response). */
function readTokenFile(dataDir) {
  return readToken(dataDir);
}
