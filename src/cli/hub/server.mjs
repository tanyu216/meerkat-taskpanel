/**
 * The local event hub.
 *
 * One authenticated TCP socket on `127.0.0.1` carries a line-delimited JSON
 * protocol; one board SSE connection feeds it. Two kinds of local consumer use
 * it:
 *
 *   * **follow** — a live NDJSON stream of board events, the same records
 *     `taskctl events tail` writes. The loop's subscriber is one of these.
 *   * **watch** — a registration that keeps `.meerkat/<id>/card.md` fresh for
 *     one or more named cards. `export watch --detach` is the session-free
 *     form: it registers, returns, and the hub keeps refreshing until the card
 *     reaches `done`, the TTL expires, or `--stop` removes it.
 *
 * The hub does not decide workflow: it never moves a card and never wakes an
 * agent. It only fans events out and writes files, exactly like the standalone
 * watcher it replaces — with one connection instead of one per consumer.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";

import { DomainError } from "../../foundation/errors.mjs";
import { errorPayload } from "../../foundation/transport/errors.mjs";
import {
  CARD_WATCH_TTL_MS,
  WATCH_LINE,
  createWatchScheduler,
  watchPath,
  writeCardFile,
} from "../watch-core.mjs";
import {
  HUB_IDLE_MS,
  HUB_PROTOCOL,
  acquireLock,
  ensureHubDir,
  pidAlive,
  readJsonFile,
  removeFile,
  writeJsonFile,
} from "./runtime.mjs";
import { createBoardStream } from "./stream.mjs";

const MAX_LINE_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const IDLE_CHECK_MS = 30_000;

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * @param {{
 *   client: {get: Function, post: Function, stream: Function},
 *   paths: {dir: string, key: string, pointer: string, owner: string, log: string, state: string},
 *   token: string,
 *   log?: (line: string) => void,
 *   hubIdleMs?: number,
 *   heartbeatMs?: number,
 *   now?: () => number,
 * }} input
 */
export function createHubServer(input) {
  const {
    client,
    paths,
    token,
    log = () => {},
    hubIdleMs = HUB_IDLE_MS,
    heartbeatMs = HEARTBEAT_MS,
    authTimeoutMs = 10_000,
    now = Date.now,
  } = input;

  /** @type {Set<object>} */
  const sessions = new Set();
  /** @type {Map<string, object>} */
  const registrations = new Map();
  /** card path -> registration id */
  const cardIndex = new Map();
  /**
   * Persisted registrations whose resume failed transiently (board restart,
   * network, local write). They are written back on every persist and retried
   * on the next hub start; a permanent failure is dropped instead.
   */
  const deferredRegistrations = new Map();
  let lastActive = now();
  let server = null;
  let port = null;
  let stopping = null;
  let heartbeatTimer = null;
  let idleTimer = null;
  let ownsPointer = false;
  let ownsOwner = false;
  /**
   * Registrations resolve refs with board reads, so two concurrent `watch`
   * requests could both pass the duplicate check before either indexes. One
   * promise chain makes registration atomic without blocking the event stream.
   */
  let registrationTail = Promise.resolve();
  /** Resolved when `stop()` finishes; the foreground `events hub` command awaits it. */
  let resolveDone = null;
  const done = new Promise((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  const board = createBoardStream({
    client,
    log,
    onEvent: (event) => handleEvent(event),
    onState: (state) => {
      if (state.state === "error") log(`hub: board stream error: ${state.error?.message ?? state.error}`);
      else log(`hub: board stream ${state.state}`);
      // A reconnect may have missed events while the stream was down. One
      // export per registration covers the gap; the files are the recovery.
      if (state.state === "open") {
        for (const reg of registrations.values()) reg.scheduler?.notify(null);
      }
    },
  });

  /* ------------------------------------------------------------------ sockets */

  const send = (session, record) => {
    if (session.closed) return;
    try {
      session.socket.write(`${JSON.stringify(record)}\n`);
      if (record.type === "heartbeat") session.lastWrite = now();
      resetIdle(session);
    } catch {
      closeSession(session);
    }
  };

  const sendError = (session, err) => {
    send(session, { type: WATCH_LINE.ERROR, data: errorPayload(err) });
  };

  const resetIdle = (session) => {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    const idleMs = session.followIdleMs;
    if (!Number.isInteger(idleMs) || idleMs <= 0) return;
    session.idleTimer = setTimeout(() => {
      send(session, { type: WATCH_LINE.IDLE, data: { idle_ms: idleMs } });
      session.socket.end();
    }, idleMs);
    if (typeof session.idleTimer.unref === "function") session.idleTimer.unref();
  };

  const closeSession = (session) => {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    if (session.authTimer !== null) clearTimeout(session.authTimer);
    session.authTimer = null;
    sessions.delete(session);
    try {
      session.socket.destroy();
    } catch {
      /* already gone */
    }
    if (session.viewerOf !== null) {
      const viewerReg = registrations.get(session.viewerOf);
      if (viewerReg !== undefined) viewerReg.viewers.delete(session);
      session.viewerOf = null;
    }
    if (session.registrationId !== null) {
      const reg = registrations.get(session.registrationId);
      if (reg !== undefined && reg.session === session) finishRegistration(reg, "client_closed");
    }
    lastActive = now();
  };

  /* ------------------------------------------------------------- event fan-out */

  function handleEvent(event) {
    lastActive = now();
    for (const session of sessions) {
      if (session.kind === "follow") send(session, { type: "event", id: event.id, data: event.data });
    }
    const taskId = typeof event.data?.task_id === "string" && event.data.task_id !== ""
      ? event.data.task_id
      : null;
    for (const reg of [...registrations.values()]) {
      if (reg.finished) continue;
      if (taskId === null) reg.scheduler.notify(null, event.id);
      else if (reg.watched.has(taskId)) reg.scheduler.notify(taskId, event.id);
    }
  }

  /* ------------------------------------------------------------- registrations */

  const registrationCards = (reg) => [...reg.cards.values()].map((card) => ({
    ref: card.ref,
    identifier: card.identifier,
    task_id: card.task_id,
    status: card.status,
    path: card.path,
  }));

  /**
   * The owner is the foreground session that created the registration; viewers
   * are extra foreground clients that asked for a card that was already
   * registered. Only the owner's disconnect ends a foreground watcher; a viewer
   * may come and go, and a detached registration has no owner at all.
   */
  function emit(reg, record) {
    if (reg.session !== null) send(reg.session, record);
    for (const viewer of reg.viewers) send(viewer, record);
  }

  function serializeRegistration(fn) {
    const result = registrationTail.then(fn, fn);
    registrationTail = result.then(() => {}, () => {});
    return result;
  }

  function indexRegistration(reg) {
    registrations.set(reg.id, reg);
    for (const card of reg.cards.values()) cardIndex.set(card.path, reg.id);
  }

  function unindexRegistration(reg) {
    registrations.delete(reg.id);
    for (const card of reg.cards.values()) {
      if (cardIndex.get(card.path) === reg.id) cardIndex.delete(card.path);
    }
  }

  function persist() {
    if (paths.state === null) return;
    const entries = [...registrations.values()]
      .filter((reg) => reg.detached && !reg.finished)
      .map((reg) => ({
        id: reg.id,
        refs: [...reg.refs],
        dir: reg.dir,
        ttl_ms: reg.ttlMs,
        created_at: reg.createdAt,
        expires_at: reg.expiresAt,
        cards: registrationCards(reg),
      }));
    const activeIds = new Set(entries.map((entry) => entry.id));
    for (const entry of deferredRegistrations.values()) {
      if (!activeIds.has(entry.id)) entries.push({ ...entry });
    }
    try {
      if (entries.length === 0) removeFile(paths.state);
      else writeJsonFile(paths.state, { version: 1, registrations: entries });
    } catch (err) {
      log(`hub: could not persist registrations: ${err?.message ?? err}`);
    }
  }

  async function exportCard(ref) {
    const { cards } = await client.post("/api/v1/export", { ref });
    if (!Array.isArray(cards) || cards.length !== 1) {
      throw new DomainError("CLI_IO", {
        message: `events hub: expected exactly one card for ${ref}, got ${cards?.length ?? 0}`,
        details: { ref, cards: cards?.length ?? 0 },
      });
    }
    const card = cards[0];
    if (
      !isNonEmptyString(card?.identifier) ||
      !isNonEmptyString(card?.task_id) ||
      typeof card?.markdown !== "string" ||
      card.markdown === ""
    ) {
      throw new DomainError("CLI_IO", {
        message: `events watch: the board's export for ${ref} carried no task_id/identifier/markdown`,
        details: { ref },
      });
    }
    return card;
  }

  async function refreshRegistration(reg, batch) {
    if (reg.finished) return;
    const ids = batch.all
      ? [...reg.watched.keys()]
      : batch.taskIds.filter((taskId) => reg.watched.has(taskId));
    for (const taskId of ids) {
      if (reg.finished) return;
      const known = reg.watched.get(taskId);
      if (known === undefined) continue;
      try {
        const card = await exportCard(taskId);
        // A done/TTL/stop may have landed while the export was in flight. The
        // terminal line must stay terminal, so do not emit after it.
        if (reg.finished) return;
        const outcome = writeCardFile(watchPath(reg.dir, card.identifier), card.markdown);
        const status = typeof card.status === "string" ? card.status : null;
        if (status === "done") reg.watched.delete(taskId);
        else reg.watched.set(taskId, card.identifier);
        const stored = [...reg.cards.values()].find((entry) => entry.task_id === taskId);
        if (stored !== undefined) {
          stored.identifier = card.identifier;
          stored.task_id = card.task_id;
          stored.status = status;
          stored.path = outcome.path;
        }
        reg.lastRefreshAt = now();
        emit(reg, {
          type: WATCH_LINE.REFRESH,
          task_id: taskId,
          identifier: card.identifier,
          path: outcome.path,
          changed: outcome.changed,
          ...(status === null ? {} : { status }),
          ...(batch.revision === null ? {} : { revision: batch.revision }),
        });
      } catch (err) {
        emit(reg, {
          type: WATCH_LINE.REFRESH,
          task_id: taskId,
          identifier: known,
          path: watchPath(reg.dir, known),
          changed: false,
          error: errorPayload(err),
        });
        log(`hub: refresh for ${known} failed: ${err?.message ?? err}`);
      }
    }
    if (!reg.finished && reg.watched.size === 0) finishRegistration(reg, "done");
    else if (reg.detached) persist();
  }

  function clearRegistration(reg) {
    if (reg.ttlTimer !== null) {
      clearTimeout(reg.ttlTimer);
      reg.ttlTimer = null;
    }
    // `stop()` may be called from inside the refresh batch itself; it must not
    // be awaited there. The batch checks `reg.finished` before every write.
    void reg.scheduler?.stop();
    unindexRegistration(reg);
  }

  function finishRegistration(reg, reason) {
    if (reg.finished) return;
    reg.finished = true;
    clearRegistration(reg);
    persist();
    const listeners = [reg.session, ...reg.viewers].filter((entry) => entry !== null);
    reg.session = null;
    reg.viewers.clear();
    for (const listener of listeners) {
      listener.registrationId = null;
      listener.viewerOf = null;
      if (reason === "done") {
        send(listener, { type: WATCH_LINE.DONE });
        listener.socket.end();
      } else if (reason === "ttl") {
        send(listener, { type: WATCH_LINE.TTL, data: { ttl_ms: reg.ttlMs } });
        listener.socket.end();
      } else if (reason === "stop" || reason === "shutdown" || reason === "client_closed") {
        // A viewer whose owner went away must not hang on a watcher that no
        // longer exists.
        send(listener, { type: WATCH_LINE.SHUTDOWN, data: { reason } });
        listener.socket.end();
      }
    }
    log(`hub: registration ${reg.id} finished (${reason})`);
  }

  async function startRegistration({ refs, dir, ttlMs, detached, session, owner, id, createdAt }) {
    const cards = [];
    const inRequest = new Map();
    for (const ref of refs) {
      const card = await exportCard(ref);
      const path = watchPath(dir, card.identifier);
      if (inRequest.has(path)) {
        throw new DomainError("CLI_USAGE", {
          message: `export watch: ${ref} and ${inRequest.get(path)} name the same card (${card.identifier})`,
          details: { ref, identifier: card.identifier, dir },
        });
      }
      inRequest.set(path, ref);
      const previous = cardIndex.get(path);
      if (previous !== undefined) {
        const existing = registrations.get(previous);
        if (
          existing !== undefined &&
          existing.dir === dir &&
          [...existing.refs].length === refs.length &&
          refs.every((value) => existing.refs.has(value))
        ) {
          return { registration: existing, cards: [...existing.cards.values()], reused: true };
        }
        throw new DomainError("CLI_IO", {
          message: `export watch: ${card.identifier} is already watched in ${dir}`,
          details: { identifier: card.identifier, dir, registration_id: previous },
          hint: { fix: "stop the existing watcher first, or watch it from that registration" },
        });
      }
      cards.push({ ref, ...card, path });
    }

    // Write the first snapshot before `open`; a write failure must be a clean
    // error, not a half-open stream.
    const firstPass = cards.map((card) => ({
      card,
      outcome: writeCardFile(card.path, card.markdown),
    }));

    const watched = new Map();
    for (const card of cards) {
      if (card.status !== "done") watched.set(card.task_id, card.identifier);
    }

    const registrationId = id ?? randomUUID();
    const reg = {
      id: registrationId,
      refs: new Set(refs),
      dir,
      ttlMs,
      detached,
      owner: owner ?? null,
      session,
      cards: new Map(cards.map((card) => [card.ref, {
        ref: card.ref,
        identifier: card.identifier,
        task_id: card.task_id,
        status: card.status,
        path: card.path,
      }])),
      watched,
      createdAt: createdAt ?? now(),
      expiresAt: ttlMs > 0 ? now() + ttlMs : null,
      lastRefreshAt: null,
      ttlTimer: null,
      scheduler: null,
      viewers: new Set(),
      finished: false,
    };

    if (watched.size > 0) {
      reg.scheduler = createWatchScheduler({
        refresh: (batch) => refreshRegistration(reg, batch),
      });
      if (ttlMs > 0) {
        reg.ttlTimer = setTimeout(() => finishRegistration(reg, "ttl"), ttlMs);
        if (typeof reg.ttlTimer.unref === "function") reg.ttlTimer.unref();
      }
      indexRegistration(reg);
      // Close the registration gap: an event that landed while the initial
      // export was in flight was not yet matched to this registration. One
      // scheduled all-refresh makes the first file state authoritative.
      reg.scheduler.notify(null);
      if (detached) persist();
    }

    return { registration: reg, cards, firstPass, reused: false };
  }

  function emitFirstPass(reg, firstPass) {
    emit(reg, { type: WATCH_LINE.OPEN });
    for (const { card, outcome } of firstPass) {
      emit(reg, {
        type: WATCH_LINE.REFRESH,
        task_id: card.task_id,
        identifier: card.identifier,
        path: outcome.path,
        changed: outcome.changed,
        ...(card.status === undefined ? {} : { status: card.status }),
      });
    }
  }

  async function handleWatch(session, record) {
    const refs = Array.isArray(record.refs)
      ? [...new Set(record.refs.filter((ref) => isNonEmptyString(ref)).map((ref) => String(ref).trim()))]
      : [];
    if (refs.length === 0) throw new DomainError("CLI_USAGE", { message: "export watch: at least one card ref is required" });
    if (
      !isNonEmptyString(record.dir) ||
      !isAbsolute(record.dir) ||
      statSync(record.dir, { throwIfNoEntry: false })?.isDirectory() !== true
    ) {
      throw new DomainError("CLI_USAGE", {
        message: `export watch: --dir ${record.dir} is not an existing absolute directory`,
        hint: { fix: "create the project working directory first" },
      });
    }
    const ttlMs = nonNegativeInteger(record.ttl_ms) ? record.ttl_ms : CARD_WATCH_TTL_MS;
    const detached = record.detach === true;

    const result = await startRegistration({
      refs,
      dir: record.dir,
      ttlMs,
      detached,
      session: detached ? null : session,
      owner: record.owner ?? null,
    });

    if (result.reused) {
      const existing = result.registration;
      if (detached) {
        // A detach can arrive while a foreground client owns the same card.
        // Promote the registration rather than handing back a "persistent"
        // handle that the owner's disconnect would retire; the former owner
        // becomes a viewer and keeps receiving refresh lines.
        if (!existing.detached) {
          existing.detached = true;
          if (existing.session !== null) {
            const owner = existing.session;
            existing.session = null;
            owner.registrationId = null;
            owner.viewerOf = existing.id;
            existing.viewers.add(owner);
          }
          persist();
        }
        send(session, {
          type: "registered",
          registration_id: existing.id,
          reused: true,
          running: !existing.finished && existing.watched.size > 0,
          cards: registrationCards(existing),
          expires_at: existing.expiresAt,
        });
      } else {
        // A second foreground client for the same card becomes a **viewer** of
        // the existing registration. It never owns it, so closing this client
        // cannot retire a watcher (least of all a detached one).
        existing.viewers.add(session);
        session.viewerOf = existing.id;
        send(session, { type: WATCH_LINE.OPEN });
        for (const card of existing.cards.values()) {
          send(session, {
            type: WATCH_LINE.REFRESH,
            task_id: card.task_id,
            identifier: card.identifier,
            path: card.path,
            changed: false,
            ...(card.status === undefined ? {} : { status: card.status }),
          });
        }
      }
      return;
    }

    const reg = result.registration;
    const firstPass = result.firstPass;
    if (reg.watched.size === 0) {
      // Every named card is already done: write the final briefs and stop.
      if (detached) {
        send(session, {
          type: "registered",
          registration_id: null,
          running: false,
          reason: "done",
          cards: registrationCards(reg),
          expires_at: null,
        });
      } else {
        emitFirstPass(reg, firstPass);
        emit(reg, { type: WATCH_LINE.DONE });
        session.socket.end();
      }
      return;
    }

    if (detached) {
      send(session, {
        type: "registered",
        registration_id: reg.id,
        running: true,
        cards: registrationCards(reg),
        expires_at: reg.expiresAt,
      });
      return;
    }

    session.registrationId = reg.id;
    emitFirstPass(reg, firstPass);
  }

  function findRegistration(record) {
    if (isNonEmptyString(record.registration_id)) {
      return registrations.get(record.registration_id) ?? null;
    }
    const ref = isNonEmptyString(record.ref) ? record.ref : null;
    const dir = isNonEmptyString(record.dir) ? record.dir : null;
    if (ref === null) return null;
    for (const reg of registrations.values()) {
      if (dir !== null && reg.dir !== dir) continue;
      if (reg.refs.has(ref)) return reg;
      for (const card of reg.cards.values()) {
        if (card.identifier === ref || card.task_id === ref) return reg;
      }
    }
    return null;
  }

  function handleStatus(session, record) {
    const reg = findRegistration(record);
    if (reg === null) {
      send(session, { op: "watch-status", ok: true, running: false, reason: "not-found" });
      return;
    }
    send(session, {
      op: "watch-status",
      ok: true,
      running: !reg.finished && reg.watched.size > 0,
      registration_id: reg.id,
      dir: reg.dir,
      cards: registrationCards(reg),
      expires_at: reg.expiresAt,
      last_refresh: reg.lastRefreshAt,
    });
  }

  function handleStop(session, record) {
    const reg = findRegistration(record);
    if (reg === null) {
      send(session, { op: "watch-stop", ok: true, stopped: false, reason: "not-found" });
      return;
    }
    const id = reg.id;
    finishRegistration(reg, "stop");
    send(session, { op: "watch-stop", ok: true, stopped: true, registration_id: id });
  }

  /* ---------------------------------------------------------------- protocol */

  function handleLine(session, line) {
    if (line.trim() === "") return;
    if (session.bufferBytes > MAX_LINE_BYTES) {
      closeSession(session);
      return;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      closeSession(session);
      return;
    }

    if (!session.authed) {
      if (record?.op !== "hello" || record?.protocol !== HUB_PROTOCOL || record.token !== token) {
        try {
          session.socket.write(`${JSON.stringify({ op: "hello", ok: false, error: "unauthorized" })}\n`);
        } catch {
          /* closing anyway */
        }
        closeSession(session);
        return;
      }
      session.authed = true;
      session.lastActive = now();
      if (session.authTimer !== null) clearTimeout(session.authTimer);
      session.authTimer = null;
      send(session, { op: "hello", ok: true, hub: { key: paths.key, pid: process.pid, port } });
      return;
    }

    lastActive = now();
    if (record?.op === "ping") {
      send(session, { op: "ping", ok: true, pid: process.pid, port });
      return;
    }
    if (record?.op === "follow") {
      session.kind = "follow";
      session.followIdleMs = nonNegativeInteger(record.idle_ms) ? record.idle_ms : 0;
      send(session, { type: WATCH_LINE.OPEN });
      const replay = board.since(record.after);
      if (replay.gap) log("hub: follow cursor fell out of the replay ring; starting live");
      for (const event of replay.events) send(session, { type: "event", id: event.id, data: event.data });
      return;
    }
    if (record?.op === "watch") {
      void serializeRegistration(() => handleWatch(session, record)).catch((err) => {
        log(`hub: watch refused: ${err?.message ?? err}`);
        sendError(session, err);
      });
      return;
    }
    if (record?.op === "watch-status") {
      handleStatus(session, record);
      return;
    }
    if (record?.op === "watch-stop") {
      handleStop(session, record);
      return;
    }
    send(session, { op: "error", ok: false, error: { code: "CLI_USAGE", message: "unknown hub operation" } });
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * A resume failure that will not heal by retrying: the card no longer
   * exists, or the persisted entry is unusable. Everything else (network,
   * 5xx, a local write failure) is deferred to the next hub start.
   */
  function isPermanentResumeFailure(err) {
    return (
      err instanceof DomainError &&
      (err.code === "NOT_FOUND" || err.code === "CLI_USAGE" || err.code === "VALIDATION_FAILED")
    );
  }

  async function rehydrate() {
    if (paths.state === null) return;
    const state = readJsonFile(paths.state);
    if (state === null || !Array.isArray(state.registrations)) return;
    for (const entry of state.registrations) {
      if (!Number.isInteger(entry?.ttl_ms) || !isNonEmptyString(entry?.dir)) continue;
      if (Number.isInteger(entry.expires_at) && entry.expires_at <= now()) continue;
      try {
        const refs = Array.isArray(entry.refs) ? entry.refs.filter(isNonEmptyString) : [];
        if (refs.length === 0) continue;
        const ttlMs = entry.expires_at !== null && entry.expires_at !== undefined
          ? Math.max(0, entry.expires_at - now())
          : entry.ttl_ms;
        const result = await serializeRegistration(() => startRegistration({
          refs,
          dir: entry.dir,
          ttlMs,
          detached: true,
          session: null,
          id: entry.id,
          createdAt: entry.created_at,
        }));
        deferredRegistrations.delete(result.registration.id);
        if (result.registration.watched.size === 0) {
          finishRegistration(result.registration, "done");
        } else {
          log(`hub: resumed registration ${result.registration.id}`);
        }
      } catch (err) {
        if (isPermanentResumeFailure(err)) {
          log(`hub: dropped ${entry?.id ?? "a registration"}: ${err?.message ?? err}`);
        } else {
          const id = isNonEmptyString(entry?.id) ? entry.id : randomUUID();
          deferredRegistrations.set(id, { ...entry, id });
          log(`hub: deferred ${id}: ${err?.message ?? err}; will retry on the next hub start`);
        }
      }
    }
    persist();
  }

  function checkIdle() {
    if (sessions.size === 0 && registrations.size === 0 && now() - lastActive >= hubIdleMs) {
      log("hub: idle; stopping");
      void stop();
    }
  }

  async function start() {
    if (server !== null) return { port };
    ensureHubDir(paths.dir);
    const claimed = acquireLock(paths.owner);
    if (!claimed.ok) {
      const lock = readJsonFile(paths.owner);
      if (lock !== null && pidAlive(lock.pid)) {
        throw new DomainError("CLI_IO", {
          message: "events hub: another hub owns this board",
          details: { pid: lock.pid, owner: paths.owner },
          hint: { fix: "use the running hub, or stop that process first" },
        });
      }
      removeFile(paths.owner);
      if (!acquireLock(paths.owner).ok) {
        throw new DomainError("CLI_IO", { message: "events hub: could not claim the hub owner lock" });
      }
    }
    ownsOwner = true;

    server = createServer((socket) => {
      const session = {
        socket,
        buffer: "",
        bufferBytes: 0,
        authed: false,
        kind: null,
        followIdleMs: 0,
        idleTimer: null,
        registrationId: null,
        viewerOf: null,
        authTimer: null,
        closed: false,
        lastWrite: now(),
      };
      // A client that never says hello must not pin an idle hub forever.
      session.authTimer = setTimeout(() => {
        if (!session.authed) closeSession(session);
      }, authTimeoutMs);
      if (typeof session.authTimer.unref === "function") session.authTimer.unref();
      sessions.add(session);
      lastActive = now();
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        session.buffer += chunk;
        session.bufferBytes = session.buffer.length;
        if (session.bufferBytes > MAX_LINE_BYTES) {
          closeSession(session);
          return;
        }
        let index;
        while ((index = session.buffer.indexOf("\n")) >= 0) {
          const line = session.buffer.slice(0, index);
          session.buffer = session.buffer.slice(index + 1);
          session.bufferBytes = session.buffer.length;
          handleLine(session, line);
          if (session.closed) return;
        }
      });
      socket.on("error", () => closeSession(session));
      socket.on("close", () => closeSession(session));
    });

    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        port = server.address().port;
        resolvePromise();
      });
    });

    writeJsonFile(paths.pointer, {
      version: 1,
      protocol: HUB_PROTOCOL,
      key: paths.key,
      pid: process.pid,
      port,
      token,
      log: paths.log,
      startedAt: now(),
    });
    ownsPointer = true;

    board.start();
    heartbeatTimer = setInterval(() => {
      for (const session of sessions) {
        if (session.authed) send(session, { type: "heartbeat" });
      }
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
    idleTimer = setInterval(checkIdle, Math.min(IDLE_CHECK_MS, Math.max(1_000, hubIdleMs)));
    if (typeof idleTimer.unref === "function") idleTimer.unref();

    await rehydrate();
    log(`hub: listening on 127.0.0.1:${port} (key ${paths.key})`);
    return { port };
  }

  async function stop() {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      if (idleTimer !== null) clearInterval(idleTimer);
      heartbeatTimer = null;
      idleTimer = null;

      for (const reg of [...registrations.values()]) {
        if (reg.detached) {
          // Detached registrations outlive this process: stop the timers but
          // leave the registration in the state file for the next hub.
          if (reg.ttlTimer !== null) clearTimeout(reg.ttlTimer);
          reg.ttlTimer = null;
          void reg.scheduler?.stop();
          continue;
        }
        finishRegistration(reg, "shutdown");
      }
      // Foreground registrations are gone; detached ones are preserved.
      persist();
      // Followers have no registration to finish. Write the terminal frame and
      // half-close so it flushes; `destroy()` here would race the write.
      for (const session of [...sessions]) {
        try {
          session.socket.write(`${JSON.stringify({ type: WATCH_LINE.SHUTDOWN, data: { reason: "hub_stopping" } })}\n`);
          session.socket.end();
        } catch {
          /* already gone */
        }
        session.closed = true;
        if (session.idleTimer !== null) clearTimeout(session.idleTimer);
        session.idleTimer = null;
        sessions.delete(session);
      }

      await board.stop();

      if (server !== null) {
        await new Promise((resolvePromise) => server.close(() => resolvePromise()));
        server = null;
      }
      if (ownsPointer) {
        // Only remove the pointer this process published; a newer hub may have
        // replaced it while we were stopping.
        const pointer = readJsonFile(paths.pointer);
        if (pointer === null || pointer.pid === process.pid) removeFile(paths.pointer);
        ownsPointer = false;
      }
      if (ownsOwner) {
        removeFile(paths.owner);
        ownsOwner = false;
      }
      log("hub: stopped");
    })().finally(() => {
      resolveDone?.();
    });
    return stopping;
  }

  return {
    start,
    stop,
    /** Resolves when the server has stopped (idle exit or an explicit stop). */
    wait: () => done,
    get port() {
      return port;
    },
    get pid() {
      return process.pid;
    },
    get registrations() {
      return registrations.size;
    },
  };
}
