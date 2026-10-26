#!/usr/bin/env node
/**
 * The `meerkat-loop` supervisor's **enable / disable / status** actions.
 *
 * `install.sh` writes the loop's scheduling units and, by default, stops there: it prints
 * the load command and never starts a daemon. This module is the one deliberate exception
 * — the opt-in path the contract fixes in `docs/scheduling.md` §"Enabling the supervisor
 * (opt-in)" — run by `scripts/install/_common.sh` for each loop agent kind when the user asked
 * for it (`--supervisor=enable|disable|status`, `MEERKAT_TASKPANEL_SUPERVISOR`, or a `y`
 * to the one-time TTY question, whose default is **N**).
 *
 * One mechanism per agent kind, chosen by `--scheduler` (default `auto`: launchd on macOS,
 * systemd `--user` on Linux, cron anywhere else). Every action is **idempotent**: a repeat
 * enable never loads a unit twice, and disabling something that is not loaded is a no-op.
 * Enabling a mechanism takes down any *other* one already loaded for the same agent kind first —
 * the contract's "never leave two loaded", which also means this module only ever touches
 * the units it names (its own labels, its own unit files, its own cron marker block).
 *
 * Each mechanism's commands are assembled as **data** (`supervisorPlan`) rather than run
 * inline, so both platforms' plans are readable against the docs and testable on either
 * platform with the service manager faked on PATH — the `taskd-guard.mjs` precedent, which
 * also supplies `runStep` (runs one step, reporting a missing binary as a plain failure)
 * and `systemdUserDir` (where a `systemd --user` unit must live; never restated here).
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runStep, systemdUserDir } from "./taskd-guard.mjs";
import { unitPath } from "./unit-path.mjs";

/** The three actions of the single entry point. */
export const ACTIONS = Object.freeze(["enable", "disable", "status"]);
/** The mechanisms `--scheduler` may name, plus `auto` (this platform's one). */
export const SCHEDULERS = Object.freeze(["auto", "launchd", "systemd", "cron"]);
/** The actor kinds that run the supervisor. OpenClaw is never among them (D8). */
export const LOOP_KINDS = Object.freeze(["claude", "codex", "pi"]);
/** Every systemd user unit the loop installs — copied before `daemon-reload`. */
export const SYSTEMD_UNITS = Object.freeze([
  "meerkat-taskpanel-ping.service",
  "meerkat-taskpanel-ping.timer",
  "meerkat-taskpanel-continue.service",
  "meerkat-taskpanel-continue.timer",
  "meerkat-taskpanel-subscribe.service",
  "meerkat-taskpanel-session.service",
]);
/** The timers `enable --now` / `disable --now` act on. */
export const SYSTEMD_TIMERS = Object.freeze([
  "meerkat-taskpanel-ping.timer",
  "meerkat-taskpanel-continue.timer",
]);
/**
 * The long-lived services beside the two timers: the resident session pool (the
 * dispatcher) and the optional event subscriber.
 */
export const SYSTEMD_SERVICES = Object.freeze([
  "meerkat-taskpanel-session.service",
  "meerkat-taskpanel-subscribe.service",
]);
/**
 * The loop's resident pool, its two clocks and the optional event daemon, in
 * write/bootstrap order. The pool comes first: the continue turn enqueues its
 * judgment turn for the pool, and a timer that fires before the pool exists
 * would fall back to "no resident — dispatch paused".
 */
export const KINDS = Object.freeze(["session", "ping", "continue", "subscribe"]);
/**
 * The topology this installer used to ship. `enable` takes these down before it
 * loads the new units, because a loaded launchd/systemd job does not notice its
 * plist/unit file changing — leaving them loaded would keep the old 60s poll
 * running beside the new continue turn.
 */
export const LEGACY_KINDS = Object.freeze(["poll", "patrol"]);
export const LEGACY_SYSTEMD_UNITS = Object.freeze([
  "meerkat-taskpanel-poll.service",
  "meerkat-taskpanel-poll.timer",
  "meerkat-taskpanel-patrol.service",
  "meerkat-taskpanel-patrol.timer",
]);
export const LEGACY_SYSTEMD_TIMERS = Object.freeze([
  "meerkat-taskpanel-poll.timer",
  "meerkat-taskpanel-patrol.timer",
]);

/** Is `pid` a live process? `EPERM` means it exists and belongs to someone else. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** One `KEY=value` from the agent config, or `null`. */
function agentConfigValue(path, key) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim();
    }
  } catch {
    // No config file yet.
  }
  return null;
}

/**
 * The resident pool's runtime state, for `--supervisor=status`. Best effort: a
 * missing or unreadable file reads as "not running", never as a failure.
 *
 * @param {string} stateDir the directory holding `sessions.state.json` etc.
 * @param {{isAlive?: (pid: number) => boolean, now?: () => number}} [options]
 * @returns {{live: boolean, pid: number|null, heartbeatAgeMs: number|null, liveSubagents: number,
 *            cardsQueued: number, continueQueued: boolean, reason: string}}
 */
export function poolReport(stateDir, options = {}) {
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(join(stateDir, name), "utf8"));
    } catch {
      return null;
    }
  };
  const sessions = readJson("sessions.state.json");
  const ledger = readJson("subagents.state.json");
  const cards = readJson("cards.pending.json");
  const pendingContinue = readJson("continue.pending.json");
  const liveSubagents = Array.isArray(ledger?.subagents)
    ? ledger.subagents.filter((row) => row?.status === "running" || row?.status === "spawned").length
    : 0;
  const cardsQueued = Array.isArray(cards?.cards)
    ? cards.cards.filter((row) => row?.status === "pending" || row?.status === "processing").length
    : 0;
  const continueQueued = pendingContinue !== null;
  const pid = Number.isInteger(sessions?.poolPid) ? sessions.poolPid : null;
  const beat = Date.parse(String(sessions?.heartbeatAt ?? ""));
  const heartbeatAgeMs = Number.isFinite(beat) ? Math.max(0, now() - beat) : null;
  if (pid === null || !isAlive(pid)) {
    return {
      live: false,
      pid,
      heartbeatAgeMs,
      liveSubagents,
      cardsQueued,
      continueQueued,
      reason: pid === null ? "no session state" : `pool pid ${pid} is gone`,
    };
  }
  return {
    live: true,
    pid,
    heartbeatAgeMs,
    liveSubagents,
    cardsQueued,
    continueQueued,
    reason: "",
  };
}

/**
 * The event subscriber's runtime state, for `--supervisor=status`. Best effort:
 * a missing or unreadable file reads as "not running", never as a failure.
 *
 * `unitLoaded` is the mechanism probe's answer; it distinguishes "the process
 * died" from "the unit was never loaded" in the printed verdict.
 *
 * @param {string} stateDir the directory holding `subscribe.state.json`
 * @param {{scheduler?: string, isAlive?: (pid: number) => boolean, now?: () => number,
 *          unitLoaded?: boolean|null}} [options]
 */
export function subscribeReport(stateDir, options = {}) {
  const scheduler = options.scheduler;
  if (scheduler === "cron") {
    return { state: "unavailable", reason: "scheduler=cron has no long-lived process" };
  }
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  const unitLoaded = options.unitLoaded;
  let file = null;
  try {
    file = JSON.parse(readFileSync(join(stateDir, "subscribe.state.json"), "utf8"));
  } catch {
    file = null;
  }
  if (!file || typeof file !== "object" || file.version !== 1) return { state: "missing", unitLoaded };
  const pid = Number.isInteger(file.pid) ? file.pid : null;
  if (pid === null || !isAlive(pid)) return { state: "dead", pid, unitLoaded };
  const dispatchEnabled = file.dispatchEnabled !== false;
  if (file.nextAttemptAt) {
    const next = Date.parse(String(file.nextAttemptAt));
    return {
      state: "reconnecting",
      pid,
      reconnects: Number.isInteger(file.reconnects) ? file.reconnects : 0,
      nextInMs: Number.isFinite(next) ? Math.max(0, next - now()) : null,
      lastError: typeof file.lastError === "string" ? file.lastError : null,
      lastErrorAt: typeof file.lastErrorAt === "string" ? file.lastErrorAt : null,
      dispatchEnabled,
    };
  }
  if (!file.connectedAt) return { state: "starting", pid, dispatchEnabled };
  return {
    state: "streaming",
    pid,
    connectedAt: file.connectedAt,
    lastEventAt: typeof file.lastEventAt === "string" ? file.lastEventAt : null,
    lastEventId: Number.isInteger(file.lastEventId) ? file.lastEventId : null,
    reconnects: Number.isInteger(file.reconnects) ? file.reconnects : 0,
    dispatchEnabled,
  };
}

/** The one-line verdict `--supervisor=status` prints for the subscriber. */
export function subscribeStatusLine(report, now = Date.now) {
  const at = typeof now === "function" ? now() : now;
  const prefix = "supervisor:   subscribe: ";
  const dispatch =
    report.dispatchEnabled === false
      ? "dispatch off (--continue=no or --event-continue=no)"
      : "dispatch on";
  const since = (iso) => {
    const at0 = Date.parse(String(iso ?? ""));
    if (!Number.isFinite(at0)) return null;
    const ms = Math.max(0, at - at0);
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
  };
  const unitNote = report.unitLoaded === false ? "; unit not loaded" : "";
  switch (report.state) {
    case "unavailable":
      return `${prefix}not available (${report.reason})`;
    case "missing":
      return `${prefix}not running (no subscribe state${unitNote})`;
    case "dead":
      return `${prefix}not running (pid ${report.pid} is gone${unitNote})`;
    case "starting":
      return `${prefix}running (starting; pid ${report.pid}, no connection yet, ${dispatch})`;
    case "reconnecting": {
      const parts = [`pid ${report.pid}`, `attempt ${report.reconnects}`];
      if (report.nextInMs !== null) parts.push(`next in ${Math.max(0, Math.round(report.nextInMs / 1000))}s`);
      if (report.lastError) {
        const ago = since(report.lastErrorAt);
        parts.push(`last error${ago === null ? "" : ` ${ago}`}: ${report.lastError}`);
      }
      return `${prefix}running (reconnecting; ${parts.join(", ")})`;
    }
    case "streaming": {
      const parts = [`pid ${report.pid}`, `connected ${since(report.connectedAt) ?? "unknown"}`];
      if (report.lastEventAt) parts.push(`last event ${since(report.lastEventAt)}`);
      if (report.lastEventId !== null) parts.push(`id ${report.lastEventId}`);
      parts.push(`reconnects ${report.reconnects}`, dispatch);
      return `${prefix}running (streaming; ${parts.join(", ")})`;
    }
    default:
      return `${prefix}unknown (${report.state})`;
  }
}

/**
 * The launchd label / systemd-name stem for one agent kind — `com.meerkat-taskpanel.<agent>.<actor-kind>`.
 *
 * @param {string} agent
 * @param {string} actorKind
 */
export function supervisorBase(agent, actorKind) {
  return `com.meerkat-taskpanel.${agent}.${actorKind}`;
}

/**
 * The launchd Label of one tick, exactly as the installer's unit template renders it
 * (`com.meerkat-taskpanel.{{AGENT}}.{{ACTOR_KIND}}.{{poll|patrol}}`).
 *
 * @param {string} agent
 * @param {string} actorKind
 * @param {string} unit
 */
export function supervisorLabel(agent, actorKind, unit) {
  return `${supervisorBase(agent, actorKind)}.${unit}`;
}

/**
 * `auto` means this platform's native mechanism; anything else is taken verbatim.
 *
 * @param {string} requested
 * @param {string} platform
 * @returns {string}
 */
export function resolveScheduler(requested, platform) {
  if (requested !== undefined && requested !== null && requested !== "" && requested !== "auto") {
    return requested;
  }
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "cron";
}

/**
 * Every path and name the action needs, from the agent kind's own directory (`<home>/<agent-dir>`,
 * e.g. `~/.claude`). Pure arithmetic — nothing is created here.
 *
 * @param {{agentBase: string, agent: string, actorKind: string, env?: NodeJS.ProcessEnv,
 *          home?: string}} options
 */
export function supervisorPaths(options) {
  const agentBase = resolve(options.agentBase);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  return {
    agentBase,
    agentDir: basename(agentBase),
    agent: options.agent,
    actorKind: options.actorKind,
    env,
    home,
    loopDir: join(agentBase, "meerkat-taskpanel"),
    supervisor: join(agentBase, "meerkat-taskpanel", "scripts", "supervisor.mjs"),
    log: join(agentBase, "meerkat-taskpanel", "supervisor.log"),
    state: join(agentBase, "meerkat-taskpanel", "supervisor.state.json"),
    config: join(agentBase, "meerkat-taskpanel.env"),
    launchd: KINDS.map((kind) => ({
      kind,
      label: supervisorLabel(options.agent, options.actorKind, kind),
      plist: join(agentBase, "scheduling", "launchd", `com.meerkat-taskpanel.${kind}.plist`),
    })),
    legacyLaunchd: LEGACY_KINDS.map((kind) => ({
      kind,
      label: supervisorLabel(options.agent, options.actorKind, kind),
      plist: join(agentBase, "scheduling", "launchd", `com.meerkat-taskpanel.${kind}.plist`),
    })),
    systemdSrcDir: join(agentBase, "scheduling", "systemd"),
    systemdUnitDir: systemdUserDir(env, home),
    cronFile: join(agentBase, "scheduling", "cron", "meerkat-taskpanel.cron"),
    // The marker key the docs name — `~/.claude`, the agent *directory*, so each agent kind gets
    // its own block and the three never collide.
    marker: `~/${basename(agentBase)}`,
  };
}

// ---------------------------------------------------------------------------
// The cron managed block — the idempotency key (cron has no other "enabled" state)
// ---------------------------------------------------------------------------

/** The begin/end marker pair for one agent kind's block. */
export function cronMarkers(marker) {
  return {
    begin: `# >>> meerkat-taskpanel (${marker}) >>>`,
    end: `# <<< meerkat-taskpanel (${marker}) <<<`,
  };
}

/**
 * Remove a marker block from crontab text. A half-written block (one marker missing)
 * is left **untouched** — swallowing the rest of a user's crontab would be worse than
 * not finding the block.
 *
 * @param {string} text
 * @param {string} begin
 * @param {string} end
 * @returns {{text: string, found: boolean}}
 */
export function stripBlock(text, begin, end) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === begin);
  const stop = lines.findIndex((line) => line.trim() === end);
  if (start === -1 || stop < start) return { text, found: false };
  return { text: [...lines.slice(0, start), ...lines.slice(stop + 1)].join("\n"), found: true };
}

/**
 * The cron lines the block carries: the *rendered* unit the installer wrote (so the
 * enable path and the manual `crontab <file>` path can never drift apart), else — in a
 * `--dry-run`, where nothing has been written yet — the same lines built from the paths
 * the units name.
 *
 * "The same lines" includes the `PATH=` setting line and the absolute interpreter
 * (T-20261014-020103-2): a preview that showed `/usr/bin/env node` would be advertising
 * the line the unit no longer carries. `install.sh` exports `TP_NODE` /
 * `TP_UNIT_PATH_CRON` before it calls this, so the preview and the written file are the
 * same bytes; the fallbacks below exist for a caller that has neither (a test).
 *
 * @param {ReturnType<typeof supervisorPaths>} paths
 * @returns {string[]}
 */
export function cronContentLines(paths) {
  if (existsSync(paths.cronFile)) {
    const lines = readFileSync(paths.cronFile, "utf8")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    if (lines.length > 0) return lines;
  }

  const env = paths.env ?? {};
  const node = env.TP_NODE || process.execPath;
  const cronPath = env.TP_UNIT_PATH_CRON || unitPath(dirname(node), { scheduler: "cron" });

  const line = (schedule, mode) =>
    [
      schedule,
      node,
      paths.supervisor,
      `--actor-kind ${paths.actorKind}`,
      `--agent ${paths.agent}`,
      mode,
      "--once",
      `--log ${paths.log}`,
      `--state ${paths.state}`,
      ">/dev/null 2>&1",
    ].join(" ");
  const pingCron = env.TP_PING_CRON || "* * * * *";
  const continueCron = env.TP_CONTINUE_CRON || "*/10 * * * *";
  return [`PATH=${cronPath}`, line(pingCron, "--ping-only"), line(continueCron, "--continue-only")];
}

/** The full cron block (markers + content lines). */
export function cronBlock(paths) {
  const { begin, end } = cronMarkers(paths.marker);
  return [begin, ...cronContentLines(paths), end].join("\n");
}

// ---------------------------------------------------------------------------
// The mechanisms — each one probes, enables and disables its own artefacts
// ---------------------------------------------------------------------------

/** First line of a command's stderr, for a one-line reason. */
function firstLine(text) {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

/** launchd's way of saying "it is already there": an *idempotent success*, not an error. */
function launchdAlready(stderr) {
  return /already (bootstrapped|loaded|running)/i.test(stderr);
}

/** launchd's "no Aqua session" refusal — reported, never papered over with a fallback. */
function launchdNoSession(text) {
  return /input\/output error/i.test(text);
}

/**
 * launchd (macOS).
 *
 * @param {{paths: ReturnType<typeof supervisorPaths>, uid: number|null, run: typeof spawnSync}} options
 */
export function launchdMechanism({ paths, uid, run }) {
  const domain = `gui/${uid}`;
  const jobId = (unit) => `${domain}/${unit.label}`;

  /**
   * Boot out a set of jobs. `Could not find service` (and a machine with no
   * launchctl at all) means the job was not loaded: the documented idempotent
   * no-op, not a failure.
   */
  const takeDown = (units) => {
    let removed = false;
    for (const unit of units) {
      const outcome = runStep({ command: "launchctl", args: ["bootout", jobId(unit)] }, run);
      if (outcome.ok) {
        removed = true;
        continue;
      }
      if (outcome.missing || /could not find service|not found|no such process/i.test(outcome.stderr)) continue;
      return { ok: false, reason: `launchctl exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
    }
    return { ok: true, already: !removed };
  };

  const probeUnits = (units) => {
    const states = units.map((unit) => ({
      unit: unit.label,
      loaded: runStep({ command: "launchctl", args: ["print", jobId(unit)] }, run).ok,
    }));
    return { loaded: states.every((state) => state.loaded), units: states };
  };

  return {
    name: "launchd",
    unitsReport: `${supervisorBase(paths.agent, paths.actorKind)}.session,.ping,.continue,.subscribe`,

    plan() {
      return [
        ...paths.legacyLaunchd.map((unit) => `launchctl bootout ${jobId(unit)}   # legacy poll/patrol`),
        ...paths.launchd.map((unit) => `launchctl bootstrap ${domain} ${unit.plist}`),
      ];
    },

    probe() {
      return probeUnits(paths.launchd);
    },

    legacyProbe() {
      return probeUnits(paths.legacyLaunchd);
    },

    enable() {
      // A loaded job does not notice its plist changing. Take the old topology
      // down first, or its 60s poll keeps running beside the new continue turn.
      const legacy = takeDown(paths.legacyLaunchd);
      if (!legacy.ok) return legacy;

      let allAlready = true;
      for (const unit of paths.launchd) {
        if (runStep({ command: "launchctl", args: ["print", jobId(unit)] }, run).ok) continue;
        allAlready = false;

        let outcome = runStep({ command: "launchctl", args: ["bootstrap", domain, unit.plist] }, run);
        // The fallback is for a `bootstrap` this macOS does not have — **not** for a
        // refusal. A no-GUI-session error is reported below, exactly as the docs say it
        // must be ("the enable must not claim success on this").
        if (!outcome.ok && !launchdAlready(outcome.stderr) && !launchdNoSession(outcome.stderr)) {
          outcome = runStep({ command: "launchctl", args: ["load", "-w", unit.plist] }, run);
        }
        if (outcome.ok || launchdAlready(outcome.stderr)) continue;

        if (outcome.missing) return { ok: false, reason: "launchctl is not available on this machine" };
        if (launchdNoSession(outcome.stderr)) {
          return {
            ok: false,
            reason:
              "no GUI login session (bootstrap failed: 5: Input/output error) — retry from a GUI " +
              "session, or load it with `launchctl load -w`",
          };
        }
        return { ok: false, reason: `launchctl exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
      }
      return { ok: true, already: allAlready };
    },

    disable() {
      return takeDown([...paths.legacyLaunchd, ...paths.launchd]);
    },
  };
}

/**
 * systemd `--user` (Linux). The units must be copied into the user unit directory **and**
 * reloaded before they can be enabled — the ordering the contract calls load-bearing.
 *
 * @param {{paths: ReturnType<typeof supervisorPaths>, run: typeof spawnSync}} options
 */
export function systemdMechanism({ paths, run }) {
  return {
    name: "systemd",
    unitsReport: [...SYSTEMD_TIMERS, ...SYSTEMD_SERVICES].join(","),

    plan() {
      return [
        `rm -f ${LEGACY_SYSTEMD_UNITS.map((name) => join(paths.systemdUnitDir, name)).join(" ")}`,
        `mkdir -p ${paths.systemdUnitDir}`,
        `cp ${paths.systemdSrcDir}/* ${paths.systemdUnitDir}/`,
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${[...SYSTEMD_TIMERS, ...SYSTEMD_SERVICES].join(" ")}`,
      ];
    },

    /** Copy the units where systemd reads them, then reload — nothing works before this. */
    install() {
      mkdirSync(paths.systemdUnitDir, { recursive: true });
      // The old files would be picked up by a later `enable --now` if they stayed.
      for (const name of LEGACY_SYSTEMD_UNITS) {
        try {
          rmSync(join(paths.systemdUnitDir, name), { force: true });
        } catch {
          // A unit directory we cannot fully clean is still worth copying into.
        }
      }
      for (const name of SYSTEMD_UNITS) {
        const source = join(paths.systemdSrcDir, name);
        if (existsSync(source)) copyFileSync(source, join(paths.systemdUnitDir, name));
      }
      return runStep({ command: "systemctl", args: ["--user", "daemon-reload"] }, run);
    },

    probe() {
      const states = [...SYSTEMD_TIMERS, ...SYSTEMD_SERVICES].map((unit) => ({
        unit,
        loaded: runStep({ command: "systemctl", args: ["--user", "is-enabled", unit] }, run).ok,
      }));
      return { loaded: states.every((state) => state.loaded), units: states };
    },

    legacyProbe() {
      const states = LEGACY_SYSTEMD_TIMERS.map((unit) => ({
        unit,
        loaded: runStep({ command: "systemctl", args: ["--user", "is-enabled", unit] }, run).ok,
      }));
      return { loaded: states.some((state) => state.loaded), units: states };
    },

    disableTimers(timers) {
      const outcome = runStep(
        { command: "systemctl", args: ["--user", "disable", "--now", ...timers] },
        run,
      );
      if (outcome.ok) return { ok: true };
      if (outcome.missing) return { ok: true, already: true };
      if (/not found|no such file|does not exist/i.test(outcome.stderr)) return { ok: true, already: true };
      return { ok: false, reason: `systemctl exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
    },

    enable() {
      // Take the old topology down before installing the new one: otherwise its
      // 60s poll keeps running beside the continue turn until the operator
      // notices. An absent legacy timer is a no-op.
      const legacy = this.disableTimers(LEGACY_SYSTEMD_TIMERS);
      if (!legacy.ok) return legacy;

      const prepared = this.install();
      if (prepared.missing) return { ok: false, reason: "systemctl is not available on this machine" };

      if (this.probe().loaded) return { ok: true, already: true };
      const outcome = runStep(
        { command: "systemctl", args: ["--user", "enable", "--now", ...SYSTEMD_TIMERS, ...SYSTEMD_SERVICES] },
        run,
      );
      if (outcome.ok) return { ok: true, already: false };

      if (/failed to connect to bus/i.test(outcome.stderr)) {
        return {
          ok: false,
          reason: "no user D-Bus session, so `systemd --user` is unavailable here — re-run with `--scheduler=cron`",
        };
      }
      if (outcome.missing) return { ok: false, reason: "systemctl is not available on this machine" };
      if (/not found|no such file|does not exist/i.test(outcome.stderr)) {
        return {
          ok: false,
          reason:
            `unit not found: copy it first — \`cp ${paths.systemdSrcDir}/* ` +
            `${paths.systemdUnitDir}/\` then \`systemctl --user daemon-reload\``,
        };
      }
      return { ok: false, reason: `systemctl exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
    },

    disable() {
      // `is-enabled` first: `systemctl disable` is happy to be told to disable something
      // that was never enabled, and calling that "disabled" would overstate what happened.
      const wasEnabled = this.probe().loaded || this.legacyProbe().loaded;
      const outcome = this.disableTimers([...SYSTEMD_TIMERS, ...SYSTEMD_SERVICES, ...LEGACY_SYSTEMD_TIMERS]);
      if (outcome.ok) return { ok: true, already: !wasEnabled };
      return outcome;
    },
  };
}

/**
 * cron (the portable fallback). The marker block **is** the enabled-state: there is no
 * other machine-readable flag, so enable replaces the block and disable strips it.
 *
 * @param {{paths: ReturnType<typeof supervisorPaths>, run: typeof spawnSync}} options
 */
export function cronMechanism({ paths, run }) {
  const { begin, end } = cronMarkers(paths.marker);

  const read = () => {
    const outcome = runStep({ command: "crontab", args: ["-l"] }, run);
    if (outcome.ok) return { ok: true, text: outcome.stdout };
    if (outcome.missing) return { ok: false, reason: "crontab is not available on this machine" };
    // `no crontab for <user>` is an empty crontab, not a failure (the documented case).
    if (/no crontab for/i.test(outcome.stderr)) return { ok: true, text: "" };
    return { ok: false, reason: `crontab -l exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
  };

  const write = (text) => runStep({ command: "crontab", args: ["-"], input: text }, run);

  return {
    name: "cron",
    unitsReport: `crontab block (${paths.marker})`,

    plan() {
      return ["crontab - (replace the managed block with:)", ...cronBlock(paths).split("\n").map((l) => `  ${l}`)];
    },

    probe() {
      const current = read();
      if (!current.ok) return { loaded: false, units: [{ unit: paths.marker, loaded: false }] };
      const loaded = current.text.includes(begin) && current.text.includes(end);
      return { loaded, units: [{ unit: paths.marker, loaded }] };
    },

    enable() {
      const current = read();
      if (!current.ok) return { ok: false, reason: current.reason };

      const stripped = stripBlock(current.text, begin, end);
      // Only the trailing run of blank lines the strip left behind is dropped: anything
      // *inside* the table is the user's, and rewriting their crontab to reflow it would
      // be a change nobody asked for.
      const lines = stripped.text.split("\n");
      while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
      const next = `${[...lines, cronBlock(paths), ""].join("\n")}`;
      // Re-enabling replaces the block, never duplicates it — and when nothing at all
      // changed, it does not write either (a no-op crontab rewrite would re-run every job).
      if (next === current.text) return { ok: true, already: true };

      const outcome = write(next);
      if (outcome.ok) return { ok: true, already: false };
      return { ok: false, reason: `crontab exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
    },

    disable() {
      const current = read();
      if (!current.ok) return { ok: false, reason: current.reason };
      const stripped = stripBlock(current.text, begin, end);
      if (!stripped.found) return { ok: true, already: true };
      const next = stripped.text === "" ? "" : `${stripped.text.replace(/\n+$/, "")}\n`;
      const outcome = write(next);
      if (outcome.ok) return { ok: true, already: false };
      return { ok: false, reason: `crontab exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
    },
  };
}

/** The mechanisms this module can act on, keyed by name (built fresh: they close over `run`). */
export function mechanisms(context) {
  return {
    launchd: launchdMechanism(context),
    systemd: systemdMechanism(context),
    cron: cronMechanism(context),
  };
}

/**
 * Is lingering on for this user? A `systemd --user` manager is torn down with the last
 * session, so without it the "enabled" units stop the moment the login session closes
 * (`docs/scheduling.md` §Linux — the headless caveat). `"unknown"` covers a machine with
 * no `loginctl` to ask.
 *
 * @param {{user?: string, run?: typeof spawnSync}} [options]
 */
export function lingerState(options = {}) {
  const run = options.run ?? spawnSync;
  const user = options.user ?? "";
  if (user === "") return "unknown";
  const outcome = runStep({ command: "loginctl", args: ["show-user", user, "--property", "Linger"] }, run);
  if (!outcome.ok) return "unknown";
  return /Linger=yes/.test(outcome.stdout) ? "on" : "off";
}

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

/**
 * The line that tells a user how to undo what this just did — the exact disable command,
 * carrying `--scheduler` only when the mechanism enabled is *not* what `auto` would pick
 * (without it, a `--scheduler=cron` enable on macOS would be undone on launchd).
 */
function disableHint(paths, chosen, platform) {
  const base = `install.sh --supervisor=disable --supervisor-actor-kinds ${paths.actorKind}`;
  return chosen === resolveScheduler("auto", platform) ? base : `${base} --scheduler=${chosen}`;
}

/**
 * Run one action for one agent kind. Everything is reported on `log`; the return value is the
 * process exit code (non-zero only when an `enable`/`disable` the user asked for could
 * not be performed — a failure is never dressed up as a success).
 *
 * @param {{action: string, scheduler?: string, paths: ReturnType<typeof supervisorPaths>,
 *          platform?: string, uid?: number|null, user?: string, run?: typeof spawnSync,
 *          dryRun?: boolean, log?: (line: string) => void}} options
 */
export function runSupervisorAction(options) {
  const { action, paths } = options;
  const run = options.run ?? spawnSync;
  const platform = options.platform ?? process.platform;
  const scheduler = options.scheduler ?? "auto";
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const requested = resolveScheduler(scheduler, platform);
  const withUnits = (mechanism) =>
    `kind=${paths.actorKind}, scheduler=${mechanism.name}, units=${mechanism.unitsReport}`;
  const all = mechanisms({ paths, uid: options.uid ?? process.getuid?.() ?? null, run });

  if (action === "status") {
    log(`supervisor: status (kind=${paths.actorKind})`);
    const names = scheduler === "auto" ? ["launchd", "systemd", "cron"] : [requested];
    let subscribeUnitLoaded = null;
    for (const name of names) {
      const probe = all[name].probe();
      if (name === requested) {
        const unit = probe.units.find((u) => /(^|[.-])subscribe(\.service)?$/.test(u.unit));
        subscribeUnitLoaded = unit === undefined ? null : unit.loaded;
      }
      const listed = probe.units.map((u) => `${u.unit}=${u.loaded ? "loaded" : "not loaded"}`).join(", ");
      log(`supervisor:   ${name}: ${probe.loaded ? "loaded" : "not loaded"} (${listed})`);
      const legacy = typeof all[name].legacyProbe === "function" ? all[name].legacyProbe() : null;
      if (legacy?.loaded) {
        const legacyListed = legacy.units.map((u) => `${u.unit}=${u.loaded ? "loaded" : "not loaded"}`).join(", ");
        log(
          `supervisor:   ${name}: legacy poll/patrol still loaded (${legacyListed}) — ` +
            "re-run --supervisor=enable to migrate to ping/continue",
        );
      }
    }
    // The resident pool is a *runtime* fact, not a load state: say whether it is
    // actually alive and what it is carrying.
    const pool = poolReport(dirname(paths.state), { now: options.now });
    const detail = pool.live
      ? `pid ${pool.pid}, ${pool.liveSubagents} live subagent(s), ${pool.cardsQueued} card(s) queued` +
        `${pool.continueQueued ? ", continue queued" : ""}` +
        `${pool.heartbeatAgeMs === null ? "" : `, heartbeat ${Math.round(pool.heartbeatAgeMs / 1000)}s`}`
      : pool.reason;
    log(`supervisor:   session: ${pool.live ? "running" : "not running"} (${detail})`);
    // The subscriber is a *runtime* fact too: loaded tells you the unit exists,
    // not whether it is streaming or stuck on the reconnect ladder.
    const subscriber = subscribeReport(dirname(paths.state), {
      scheduler: requested,
      now: options.now,
      isAlive: options.isAlive,
      unitLoaded: subscribeUnitLoaded,
    });
    log(subscribeStatusLine(subscriber, options.now ?? Date.now));
    // The full-access opt-in is an authorization, so status states it — and who
    // recorded it — rather than leaving a bypass invisible.
    const allowAll = String(agentConfigValue(paths.config, "MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS") ?? "").toLowerCase();
    if (allowAll === "yes" || allowAll === "true" || allowAll === "1") {
      const reason = agentConfigValue(paths.config, "MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON") ?? "unrecorded";
      log(`supervisor:   tools: all enabled (authorized by: ${reason}) — the project directory is not an isolation boundary`);
    } else {
      log("supervisor:   tools: role allowlists (full access is off)");
    }
    return 0;
  }

  const mechanism = all[requested];

  if (action === "disable") {
    if (options.dryRun) {
      log(`supervisor: dry-run — would disable (${withUnits(mechanism)})`);
      for (const line of mechanism.plan()) log(`supervisor: would run: ${line}`);
      return 0;
    }
    const outcome = mechanism.disable();
    if (!outcome.ok) {
      log(`supervisor: not disabled (${withUnits(mechanism)}) — ${outcome.reason}`);
      return 1;
    }
    const word = outcome.already ? "already disabled" : "disabled";
    log(`supervisor: ${word} (${withUnits(mechanism)})`);
    return 0;
  }

  // enable
  if (options.dryRun) {
    log(`supervisor: dry-run — would enable (${withUnits(mechanism)})`);
    for (const line of mechanism.plan()) log(`supervisor: would run: ${line}`);
    return 0;
  }

  // One mechanism per agent kind: take any *other* loaded one down first, so this can never
  // leave two racing for the same cards. Only this module's own labels / unit names /
  // marker block are touched, and a take-down that did not happen is said so — a silent
  // failure here would leave exactly the double-load this is meant to prevent.
  for (const name of ["launchd", "systemd", "cron"]) {
    if (name === requested) continue;
    const other = all[name];
    const legacyLoaded = typeof other.legacyProbe === "function" ? other.legacyProbe().loaded : false;
    if (!other.probe().loaded && !legacyLoaded) continue;
    const taken = other.disable();
    if (taken.ok) {
      log(`supervisor: disabled (kind=${paths.actorKind}, scheduler=${name}, units=${other.unitsReport}) — one mechanism per agent kind`);
    } else {
      log(
        `supervisor: warning — ${name} is also loaded (kind=${paths.actorKind}, units=${other.unitsReport}) and could not be ` +
          `taken down (${taken.reason}); two loaded units for one agent kind race for the same cards`,
      );
    }
  }

  const outcome = mechanism.enable();
  if (!outcome.ok) {
    log(`supervisor: not enabled (${withUnits(mechanism)}) — ${outcome.reason}`);
    log(`supervisor: enable it with:`);
    for (const line of mechanism.plan()) log(`supervisor:   ${line}`);
    return 1;
  }

  log(`supervisor: ${outcome.already ? "already enabled" : "enabled"} (${withUnits(mechanism)})`);
  if (requested === "systemd") {
    const linger = lingerState({ user: options.user ?? "", run });
    if (linger !== "on") {
      log(
        `supervisor: warning — lingering is ${linger === "off" ? "off" : "unknown"}, so the units stop when ` +
          `your last session ends; enable it with: loginctl enable-linger ${options.user ?? "$USER"}`,
      );
    }
  }
  log(`to disable:  ${disableHint(paths, requested, platform)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/install/lib/supervisor.mjs <enable|disable|status> --actor-kind <kind> \\
         --agent <name> --agent-base <dir> [--scheduler auto|launchd|systemd|cron] [--dry-run]

Loads, unloads or reports one loop agent kind's supervisor units — the opt-in path
docs/scheduling.md defines. Called by scripts/install/_common.sh; not meant to be
run by hand.
`;

function main(argv) {
  const [action, ...rest] = argv;
  if (action === undefined || action === "-h" || action === "--help") {
    process.stdout.write(USAGE);
    return action === undefined ? 2 : 0;
  }
  if (!ACTIONS.includes(action)) {
    process.stderr.write(`supervisor: unknown action: ${action} (expected ${ACTIONS.join("|")})\n`);
    return 2;
  }

  const opts = { dryRun: false, scheduler: "auto" };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => rest[++i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--actor-kind") opts.actorKind = value();
    else if (arg === "--agent") opts.agent = value();
    else if (arg === "--agent-base") opts.agentBase = value();
    else if (arg === "--scheduler") opts.scheduler = value();
    else {
      process.stderr.write(`supervisor: unknown option: ${arg}\n`);
      return 2;
    }
  }

  for (const required of ["actorKind", "agent", "agentBase"]) {
    if (opts[required] === undefined) {
      process.stderr.write(`supervisor: --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required\n`);
      return 2;
    }
  }
  if (!SCHEDULERS.includes(opts.scheduler)) {
    process.stderr.write(`supervisor: --scheduler must be ${SCHEDULERS.join("|")} (got '${opts.scheduler}')\n`);
    return 2;
  }

  const env = process.env;
  return runSupervisorAction({
    action,
    scheduler: opts.scheduler,
    paths: supervisorPaths({ agentBase: opts.agentBase, agent: opts.agent, actorKind: opts.actorKind, env }),
    user: env.USER ?? env.LOGNAME ?? "",
    dryRun: opts.dryRun,
  });
}

/** Canonical (symlink-free) path for the self-dispatch guard — the `taskd-guard.mjs` trap. */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
