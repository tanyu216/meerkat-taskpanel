/**
 * `taskd` — the local API server (§5.1).
 *
 * One process owns the SQLite file (single-writer), and every surface talks to
 * it over loopback HTTP. Since M6 the whole §5.1 table is here — the command
 * surface, `/health` and `/meta`, plus the three things only a *board* needs:
 *
 *   * **`/api/v1/events`** — SSE over `global_revision` (`sse.mjs`);
 *   * **static hosting** of `web/dist` when the frontend has been built
 *     (`static.mjs`); absence is normal and must not be an error;
 *   * **the board projection** — `/projects` ordered by the DESIGN.md §20 weight
 *     algorithm server-side, so clients consume an order they did not compute.
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CARD_ACCEPTANCE_MODES,
  DEFAULT_PROJECT_ACCEPTANCE,
  PROJECT_ACCEPTANCES,
  currentRevision,
  openBoard,
  readToken,
} from "../core/index.mjs";
import {
  LABEL_GC_ENV,
  HUMAN_KIND,
  LABEL_GC_INTERVAL_MS,
  LABEL_TTL_DAYS_DEFAULT,
  LABEL_TTL_DAYS_ENV,
  SSE_HEARTBEAT_MS,
  SSE_POLL_MS,
  STATIC_DIR_REL,
  TASK_ORDER_CAPABILITY,
  VERSION,
} from "../foundation/constants.mjs";
import { slaConfigToWire } from "../foundation/wire.mjs";
import { allowListFrom, readAccessConfig } from "./access-config.mjs";
import { authorize } from "./auth.mjs";
import { shape, str } from "./requests.mjs";
import { createRouter, errorResponse, readJsonBody, sendJson } from "./router.mjs";
import { registerAccessRoutes } from "./routes/access.mjs";
import { registerActivityRoutes } from "./routes/activities.mjs";
import { handleAttachmentContent, registerAttachmentRoutes } from "./routes/attachments.mjs";
import { registerCommentRoutes } from "./routes/comments.mjs";
import { registerDictionaryRoutes } from "./routes/dictionary.mjs";
import { registerExportRoutes } from "./routes/export.mjs";
import { registerLabelRoutes } from "./routes/labels.mjs";
import { registerProjectRoutes } from "./routes/projects.mjs";
import { registerRelationRoutes } from "./routes/relations.mjs";
import { registerSessionRoutes } from "./routes/sessions.mjs";
import { registerSlaRoutes } from "./routes/sla.mjs";
import { registerTaskRoutes } from "./routes/tasks.mjs";
import { registerTokenRoutes } from "./routes/token.mjs";
import { openEventStream, revisionFromRequest } from "./sse.mjs";
import { createStaticHost } from "./static.mjs";

/** `/api/v1/attachments/<id>/content` — handled outside the JSON router. */
const ATTACHMENT_CONTENT_PATH = /^\/api\/v1\/attachments\/([^/]+)\/content$/;
/** The repository root, so a checkout serves its own `web/dist` without config. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Kept for the M0 scaffold contract test; the surface is real now. */
export const STAGE = "taskd";

/**
 * Endpoints the daemon answers **outside** the JSON router.
 *
 * Three things cannot wear the `{ok, data}` envelope: `/health` is a bare
 * liveness probe the CLI's autostart polls before a token exists, `events` is an
 * SSE stream that owns its response for as long as the client stays connected,
 * and attachment content is raw bytes in and out. They are declared here, in the
 * place that registers the rest of the surface, so the contract snapshot
 * (`scripts/verify/contract.mjs`) sees them too rather than carrying its own
 * copy of the list.
 */
export const OUT_OF_ROUTER_ENDPOINTS = Object.freeze([
  { method: "GET", path: "/health", request: { query: null, body: null } },
  { method: "GET", path: "/meta", request: { query: null, body: null } },
  // `?after=<revision>` replays from a revision; the header `Last-Event-ID` is the
  // same request fact (see `sse.mjs`), so it is named in prose, not in the schema.
  { method: "GET", path: "/api/v1/events", request: { query: shape({ after: str() }), body: null } },
  // Bytes in, bytes out: the content endpoints take no JSON request at all, which
  // is exactly what a `null` schema says.
  { method: "GET", path: "/api/v1/attachments/:id/content", request: { query: null, body: null } },
  { method: "PUT", path: "/api/v1/attachments/:id/content", request: { query: null, body: null } },
]);

/**
 * The JSON route table, registered in one place.
 *
 * `createTaskd` calls this with the live surface; the contract snapshot calls it
 * with a stub to *enumerate* the routes (nothing runs the handlers at
 * registration time). Both read the same list, so a route can never be added to
 * the server without appearing in the snapshot — the drift guard is the shared
 * function, not a convention.
 *
 * @param {ReturnType<typeof createRouter>} router
 * @param {{board: object, token: string|null}} surface
 */
export function registerApiRoutes(router, surface) {
  registerTokenRoutes(router, surface);
  registerAccessRoutes(router, surface);
  registerProjectRoutes(router, surface);
  registerTaskRoutes(router, surface);
  registerActivityRoutes(router, surface);
  registerCommentRoutes(router, surface);
  registerRelationRoutes(router, surface);
  registerSessionRoutes(router, surface);
  registerSlaRoutes(router, surface);
  registerDictionaryRoutes(router, surface);
  registerLabelRoutes(router, surface);
  registerExportRoutes(router, surface);
  // The attachment **metadata** routes are JSON like every other route; the byte
  // pair next to them is not, and is matched before dispatch (`handle` below).
  registerAttachmentRoutes(router, surface);
}

/**
 * Who is calling. The CLI sends `X-Taskctl-Actor: {"kind":"claude","id":"linus"}`;
 * anything else is an anonymous local human, which is what `curl` is.
 *
 * **The kind is passed through.** It used to be narrowed to
 * `agent|human|system`, with anything else rewritten to `human` — which, now
 * that a kind is the platform an agent runs on, would silently turn every
 * agent's write into a person's. That matters downstream in one direction only:
 * the board reads `kind === human` to decide whether a comment goes on the
 * record as a decision (I5), whether an `awaiting` card resumes, and whether the
 * patrol counts the leader as acting. A rewrite here forges all three.
 *
 * What is refused is a *blank* kind, and the id being anything but a string —
 * those are malformed, not merely unfamiliar.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function actorFromRequest(req) {
  const raw = req.headers["x-taskctl-actor"];
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.id === "string") {
        // A missing or blank kind defaults; an unfamiliar one is the caller's to
        // name, and this end has no business editing it.
        const kind = typeof parsed.kind === "string" && parsed.kind.trim() !== "" ? parsed.kind : HUMAN_KIND;
        return { kind, id: parsed.id };
      }
    } catch {
      /* A malformed header is not worth failing a request over; fall through. */
    }
  }
  return { kind: HUMAN_KIND, id: "local" };
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
 *   containerSweep?: boolean,// false = no startup container reconcile
 *   authorize?: Function,    // override for tests; defaults to the real check
 *   allowCidrs?: string,     // §7 allow-list; overrides TASKD_ALLOW_CIDRS
 *   staticDir?: string|null, // where `web/dist` lives; null = repo default, false = off
 *   eventsPollMs?: number,   // SSE poll period (tests shrink it)
 *   eventsHeartbeatMs?: number,
 *   busyTimeoutMs?: number,  // override the pinned 5000ms lock wait (tests)
 *   processEnv?: NodeJS.ProcessEnv|null, // the unmerged environment (source decisions)
 *   envFile?: string|null,   // the config file path (Access panel / errors)
 *   envVars?: Map<string,string>|Record<string,string>|null, // the parsed `.env` layer
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
    processEnv = null,
    envFile = null,
    envVars = null,
  } = options;

  // The pointer is *never* written here: it must carry the port the OS actually
  // assigned, which is only known after `listen`.
  const board = await openBoard({
    dataDir: options.dataDir ?? null,
    dbPath: options.dbPath ?? null,
    env,
    pointer: false,
    envFile,
    envVars,
    processEnv,
    ...(logger === undefined ? {} : { logger }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });

  // §7 / the Access panel: the allow-list is *optional*. It comes from the
  // process environment when an operator set one, else from the install-root
  // `.env`, else the safe defaults (off + two private ranges). The policy is
  // mutable because a loopback save applies without a restart; `allowList` is
  // the parsed projection `auth.mjs` reads on every request.
  let access = readAccessConfig({
    env: processEnv ?? env,
    envFile,
    envVars,
    ...(options.allowCidrs === undefined ? {} : { allowCidrs: options.allowCidrs }),
  });
  let allowList = allowListFrom(access);
  if (access.invalid?.length > 0 && typeof logger === "function") {
    logger({ event: "allow_list_invalid", entries: access.invalid });
  }
  const accessState = {
    get: () => access,
    set: (next) => {
      access = next;
      allowList = allowListFrom(next);
    },
  };

  // The label GC (F1-C): one sweep now, then on a timer. `taskd` is the single
  // writer, so it is the one process that may prune the registry.
  const labelGc = startLabelGc({ board, env, logger, options });

  // The container reconciler: one sweep at startup. The event hook closes an
  // epic in the same transaction as its last child's move, so this is the
  // *backstop* — it repairs a container whose children were finished by a
  // writer that bypassed the service layer, and a child attached after the
  // fact (relations added later fire no status transition). The manual path is
  // `POST /api/v1/tasks/reconcile` (`taskctl issue reconcile`).
  const containerSweep = startContainerSweep({ board, logger, options });

  const token = board.token === null ? null : readToken(board.dataDir);
  const startedAt = Date.now();
  const router = createRouter();
  const surface = { board, token, logger, access: accessState };
  const staticHost = createStaticHost({
    root: options.staticDir === undefined || options.staticDir === null
      ? resolve(REPO_ROOT, STATIC_DIR_REL)
      : options.staticDir,
  });
  const events = {
    pollMs: options.eventsPollMs ?? SSE_POLL_MS,
    heartbeatMs: options.eventsHeartbeatMs ?? SSE_HEARTBEAT_MS,
  };
  /**
   * The SSE streams that are open right now.
   *
   * They are held here because shutdown has to end them *itself*: a stream is an
   * **active** request, so `server.close()` waits on it for as long as the
   * client cares to stay connected, and `closeIdleConnections()` will not touch
   * it. Without this set a signal was answered with a hang
   * (T-20261014-213238).
   */
  const streams = new Set();

  router.get("/health", () => ({
    status: "ok",
    stage: STAGE,
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
    revision: currentRevision(board.db),
  }));

  router.get("/meta", async () => ({
    version: VERSION,
    stage: STAGE,
    dbPath: board.dbPath,
    dataDir: board.dataDir,
    revision: currentRevision(board.db),
    migration: board.migration,
    schema: board.schema,
    // "能力" (§5.1): what this board can do, so a client can feature-detect
    // instead of probing.
    capabilities: {
      sse: true,
      events: "/api/v1/events",
      static_hosting: await staticHost.probe(),
      project_order: "weights-v1",
      // C-WEIGHT-1: the assignee task weight order exists on `/tasks` and
      // `/tasks/candidates` (`?order=weight`). A client probes this rather than
      // guessing whether the query parameter does anything.
      task_order: TASK_ORDER_CAPABILITY,
      // G7 (T-20261014-212017-2/4): the attachment write surface — create, list
      // and remove — so a client feature-detects it instead of probing for a
      // 404. The bytes pair (`GET|PUT /attachments/:id/content`) predates it and
      // is what this capability's `upload_url` points at.
      attachments: true,
      allow_list: allowList.configured,
      // 0038 — the acceptance vocabulary, stated once: a project default
      // (`auto` included) and a card snapshot (never `auto`). A client
      // feature-detects the fields instead of assuming them.
      acceptance: ACCEPTANCE_CAPABILITY,
      // The effective SLA table (`GET /api/v1/sla` publishes the same values
      // with the alerts). A client feature-detects the configured thresholds
      // instead of assuming the defaults; an unreadable table reports `error`
      // here while the SLA read itself fails closed.
      sla: slaCapability(board),
    },
  }));

  registerApiRoutes(router, surface);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // A static asset or an SSE stream may already have written its head; an
      // error envelope cannot follow it, so end the response instead of throwing
      // a second time from inside the error path.
      if (res.headersSent || res.writableEnded) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
        return;
      }
      const { status, payload, headers } = errorResponse(err);
      sendJson(res, status, payload, headers);
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

    const decision = authorizeRequest({
      req,
      url,
      // Read the **live** copy: a loopback rotate/save replaces `surface.token`
      // and this same process must accept the new credential immediately.
      token: surface.token,
      rotate: pathname === "/api/v1/token",
      // Both access verbs read or replace the bearer credential's policy, so
      // they are the owner's console, exactly like `token rotate`.
      loopbackOnly: pathname === "/api/v1/token" || pathname === "/api/v1/access",
      allowList,
    });
    if (!decision.ok) {
      sendJson(res, decision.status, decision.payload);
      return;
    }

    // Bytes in / bytes out: an attachment's content endpoint cannot use the JSON
    // envelope, so it is matched and handled before the router (see the module).
    const attachment = ATTACHMENT_CONTENT_PATH.exec(pathname);
    if (attachment !== null && (req.method === "GET" || req.method === "PUT")) {
      await handleAttachmentContent(req, res, board, safeDecode(attachment[1]), actorFromRequest(req));
      return;
    }

    // The SSE stream owns its response for as long as the client stays connected;
    // it never returns a value for the envelope to wrap.
    if (pathname === "/api/v1/events" && req.method === "GET") {
      const stream = openEventStream({
        res,
        board,
        after: revisionFromRequest(url, req),
        pollMs: events.pollMs,
        heartbeatMs: events.heartbeatMs,
        // Registered so `close()` can end it deliberately; forgotten by the
        // stream itself, whichever side ends it.
        onClose: () => streams.delete(stream),
      });
      streams.add(stream);
      // The response may have ended between `openEventStream` and this line (a
      // client that hung up at exactly the wrong moment); `close` is idempotent
      // and this is what keeps the set free of dead entries.
      if (res.writableEnded || res.destroyed) stream.close();
      return;
    }

    const route = router.match(req.method ?? "GET", pathname);
    if (route === null) {
      // Not an API route: it may be a static asset or an SPA deep link. Absence
      // of a build is normal — `serve` answers false and we fall through to 404.
      if ((req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/")) {
        const served = await staticHost.serve(res, pathname, req.method);
        if (served) return;
      }
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
      token: surface.token,
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
    /** The live token: a rotate through either owner verb is visible here at once. */
    get token() {
      return surface.token;
    },
    /** The label GC, exposed so a test can trigger a sweep without waiting out the timer. */
    labelGc,
    /** The startup container reconcile, exposed so a test can read what it did. */
    containerSweep,
    /**
     * Stop the board.
     *
     * The order is the fix for T-20261014-213238. An SSE stream is an *active*
     * request: `server.close()` stops accepting new connections, but it settles
     * only when every socket is gone, and a stream has no reason to ever go —
     * so it is ended here, deliberately, before the server is asked to close.
     * The client is told why (`SSE_SHUTDOWN_EVENT`), which is what lets it
     * reconnect on a defined schedule rather than in a loop.
     *
     * The database is released last: a connection that was still in flight
     * during the close must not write to a closed board.
     */
    async close() {
      labelGc.stop();
      for (const stream of streams) stream.close("server_shutdown");
      streams.clear();
      await closeServer(server);
      board.close();
    },
  };
}

/**
 * How long `close()` waits for connections that are still *doing* something
 * before it destroys them. Well inside the 5 s a deploy allows a graceful stop.
 */
export const SHUTDOWN_GRACE_MS = 1_000;

/**
 * Close an HTTP server **with a bound**.
 *
 * Extracted from `createTaskd` because the rule is worth stating once: a signal
 * must never be answerable with a hang. `server.close()` stops *accepting* and
 * resolves once every socket is gone — but two kinds of socket never go on their
 * own, and neither is exotic:
 *
 *   * an **idle keep-alive** connection, which the peer sees no reason to end
 *     (`closeIdleConnections` retires it, once the responses just ended have
 *     been counted as idle rather than active);
 *   * an **in-flight response that is deliberately long-lived**, which is the
 *     SSE stream before the caller ended it — and any client that is simply
 *     slow.
 *
 * The second kind gets `graceMs` and is then destroyed (`closeAllConnections`),
 * so this promise always settles. A caller holding connections it wants ended
 * *gracefully* must end them before calling: this function's job is the bound,
 * not the courtesy.
 *
 * Timers are cleared on the way out whichever way the race went, so a fast close
 * leaves no handle behind to hold a process (or a test runner) open.
 *
 * @param {import('node:http').Server} server
 * @param {number} [graceMs]
 */
export async function closeServer(server, graceMs = SHUTDOWN_GRACE_MS) {
  let settled = false;
  const closed = new Promise((resolve) => {
    server.close(() => {
      settled = true;
      resolve();
    });
  });

  const timers = [];
  const wait = (ms) => new Promise((resolve) => { timers.push(setTimeout(resolve, ms)); });
  const bounded = (async () => {
    // A turn, so the responses the caller just ended are seen as idle.
    await wait(0);
    server.closeIdleConnections?.();
    if (settled) return;
    await wait(graceMs);
    if (settled) return;
    // Still connected after the grace: a client that will not hang up.
    server.closeAllConnections?.();
  })();

  try {
    await Promise.race([closed, bounded]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

/**
 * Percent-decode a path segment, tolerating a malformed escape.
 *
 * `decodeURIComponent` throws on `%zz`; a URL a client mangled is a 404, not a
 * 500, so the raw text is returned and fails the id lookup instead.
 */
/**
 * The `/meta` view of the acceptance vocabulary (0038).
 *
 * It is a constant: there is no board-level policy to read, and the project
 * default is board data (`projects.acceptance`) rather than configuration.
 */
const ACCEPTANCE_CAPABILITY = Object.freeze({
  modes: [...CARD_ACCEPTANCE_MODES],
  project_modes: [...PROJECT_ACCEPTANCES],
  default: DEFAULT_PROJECT_ACCEPTANCE,
  card_field: "acceptance_mode",
  project_field: "acceptance",
});

/**
 * The `/meta` view of the SLA table.
 *
 * Read through the board's own resolver, so `/meta` reports exactly the table
 * `GET /api/v1/sla` would compute with (process env → install-root `.env` →
 * defaults), re-read per request. A malformed value reports `error` here
 * instead of failing the whole meta read; the SLA read is where it fails
 * closed.
 */
function slaCapability(board) {
  try {
    return slaConfigToWire(board.ctx.slaConfig());
  } catch (err) {
    return {
      version: 1,
      error: err?.code ?? "CONFIG_FILE_INVALID",
      message: err?.message ?? "invalid SLA configuration",
    };
  }
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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
 * Run the container reconciler once, before the daemon starts serving.
 *
 * This is the backstop, not the trigger: the event hook in
 * `commands/rollup.mjs` drives both transitions. A sweep here is what makes a
 * missed event self-healing on restart (the profile the label GC established).
 * Like the GC, a failure is **logged, never fatal** — housekeeping must not
 * take the board down — and a sweep that finds nothing writes nothing.
 *
 * @param {{board: object, logger?: Function, options: object}} input
 * @returns {{ran: boolean, last: object|null}}
 */
export function startContainerSweep(input) {
  const { board, logger, options } = input;
  const enabled = options.containerSweep === undefined ? true : options.containerSweep !== false;
  const state = { ran: false, last: null };
  if (!enabled) return state;

  try {
    state.last = board.commands.reconcileContainers({});
    state.ran = true;
    const started = state.last.actions.filter((entry) => entry.action === "start").length;
    const closed = state.last.actions.filter((entry) => entry.action === "close").length;
    if ((started > 0 || closed > 0) && typeof logger === "function") {
      logger({ event: "container_sweep", scanned: state.last.scanned, started, closed });
    }
  } catch (err) {
    if (typeof logger === "function") {
      logger({
        event: "container_sweep_failed",
        code: err?.code ?? null,
        message: err?.message ?? String(err),
      });
    }
    state.last = { dryRun: false, scanned: 0, actions: [], failed: true };
  }
  return state;
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
