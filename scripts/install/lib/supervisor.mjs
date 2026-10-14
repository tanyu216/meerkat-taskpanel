#!/usr/bin/env node
/**
 * The `meerkat-loop` supervisor's **enable / disable / status** actions.
 *
 * `install.sh` writes the loop's scheduling units and, by default, stops there: it prints
 * the load command and never starts a daemon. This module is the one deliberate exception
 * — the opt-in path the contract fixes in `docs/scheduling.md` §"Enabling the supervisor
 * (opt-in)" — run by `scripts/install/_common.sh` for each loop host when the user asked
 * for it (`--supervisor=enable|disable|status`, `MEERKAT_TASKPANEL_SUPERVISOR`, or a `y`
 * to the one-time TTY question, whose default is **N**).
 *
 * One mechanism per host, chosen by `--scheduler` (default `auto`: launchd on macOS,
 * systemd `--user` on Linux, cron anywhere else). Every action is **idempotent**: a repeat
 * enable never loads a unit twice, and disabling something that is not loaded is a no-op.
 * Enabling a mechanism takes down any *other* one already loaded for the same host first —
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runStep, systemdUserDir } from "./taskd-guard.mjs";
import { unitPath } from "./unit-path.mjs";

/** The three actions of the single entry point. */
export const ACTIONS = Object.freeze(["enable", "disable", "status"]);
/** The mechanisms `--scheduler` may name, plus `auto` (this platform's one). */
export const SCHEDULERS = Object.freeze(["auto", "launchd", "systemd", "cron"]);
/** The hosts that run the supervisor. OpenClaw is never among them (D8). */
export const LOOP_HOSTS = Object.freeze(["claude", "codex", "pi"]);
/** Every systemd user unit the loop installs — copied before `daemon-reload`. */
export const SYSTEMD_UNITS = Object.freeze([
  "meerkat-taskpanel-poll.service",
  "meerkat-taskpanel-poll.timer",
  "meerkat-taskpanel-patrol.service",
  "meerkat-taskpanel-patrol.timer",
]);
/** The timers `enable --now` / `disable --now` act on. */
export const SYSTEMD_TIMERS = Object.freeze([
  "meerkat-taskpanel-poll.timer",
  "meerkat-taskpanel-patrol.timer",
]);
/** The loop's two tick kinds, in the order the units are written. */
export const KINDS = Object.freeze(["poll", "patrol"]);

/**
 * The launchd label / systemd-name stem for one host — `com.meerkat-taskpanel.<agent>.<host>`.
 *
 * @param {string} agent
 * @param {string} host
 */
export function supervisorBase(agent, host) {
  return `com.meerkat-taskpanel.${agent}.${host}`;
}

/**
 * The launchd Label of one tick, exactly as the installer's unit template renders it
 * (`com.meerkat-taskpanel.{{AGENT}}.{{HOST}}.{{poll|patrol}}`).
 *
 * @param {string} agent
 * @param {string} host
 * @param {string} kind
 */
export function supervisorLabel(agent, host, kind) {
  return `${supervisorBase(agent, host)}.${kind}`;
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
 * Every path and name the action needs, from the host's own directory (`<home>/<host-dir>`,
 * e.g. `~/.claude`). Pure arithmetic — nothing is created here.
 *
 * @param {{hostBase: string, agent: string, host: string, env?: NodeJS.ProcessEnv,
 *          home?: string}} options
 */
export function supervisorPaths(options) {
  const hostBase = resolve(options.hostBase);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  return {
    hostBase,
    hostDir: basename(hostBase),
    agent: options.agent,
    host: options.host,
    env,
    home,
    loopDir: join(hostBase, "meerkat-taskpanel"),
    supervisor: join(hostBase, "meerkat-taskpanel", "scripts", "supervisor.mjs"),
    log: join(hostBase, "meerkat-taskpanel", "supervisor.log"),
    state: join(hostBase, "meerkat-taskpanel", "supervisor.state.json"),
    launchd: KINDS.map((kind) => ({
      kind,
      label: supervisorLabel(options.agent, options.host, kind),
      plist: join(hostBase, "scheduling", "launchd", `com.meerkat-taskpanel.${kind}.plist`),
    })),
    systemdSrcDir: join(hostBase, "scheduling", "systemd"),
    systemdUnitDir: systemdUserDir(env, home),
    cronFile: join(hostBase, "scheduling", "cron", "meerkat-taskpanel.cron"),
    // The marker key the docs name — `~/.claude`, the host *directory*, so each host gets
    // its own block and the three never collide.
    marker: `~/${basename(hostBase)}`,
  };
}

// ---------------------------------------------------------------------------
// The cron managed block — the idempotency key (cron has no other "enabled" state)
// ---------------------------------------------------------------------------

/** The begin/end marker pair for one host's block. */
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

  const line = (schedule, patrol) =>
    [
      schedule,
      node,
      paths.supervisor,
      `--host ${paths.host}`,
      `--agent ${paths.agent}`,
      patrol ? "--patrol-only" : null,
      "--once",
      `--log ${paths.log}`,
      `--state ${paths.state}`,
      ">/dev/null 2>&1",
    ]
      .filter((part) => part !== null)
      .join(" ");
  return [`PATH=${cronPath}`, line("* * * * *", false), line("*/5 * * * *", true)];
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

  return {
    name: "launchd",
    unitsReport: `${supervisorBase(paths.agent, paths.host)}.poll,.patrol`,

    plan() {
      return paths.launchd.map((unit) => `launchctl bootstrap ${domain} ${unit.plist}`);
    },

    probe() {
      const states = paths.launchd.map((unit) => ({
        unit: unit.label,
        loaded: runStep({ command: "launchctl", args: ["print", jobId(unit)] }, run).ok,
      }));
      return { loaded: states.every((state) => state.loaded), units: states };
    },

    enable() {
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
      let removed = false;
      for (const unit of paths.launchd) {
        const outcome = runStep({ command: "launchctl", args: ["bootout", jobId(unit)] }, run);
        if (outcome.ok) {
          removed = true;
          continue;
        }
        // `Could not find service` (and a machine with no launchctl at all) mean the job
        // was not loaded: the documented idempotent no-op, not a failure.
        if (outcome.missing || /could not find service|not found|no such process/i.test(outcome.stderr)) continue;
        return { ok: false, reason: `launchctl exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
      }
      return { ok: true, already: !removed };
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
    unitsReport: SYSTEMD_TIMERS.join(","),

    plan() {
      return [
        `mkdir -p ${paths.systemdUnitDir}`,
        `cp ${paths.systemdSrcDir}/* ${paths.systemdUnitDir}/`,
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${SYSTEMD_TIMERS.join(" ")}`,
      ];
    },

    /** Copy the units where systemd reads them, then reload — nothing works before this. */
    install() {
      mkdirSync(paths.systemdUnitDir, { recursive: true });
      for (const name of SYSTEMD_UNITS) {
        const source = join(paths.systemdSrcDir, name);
        if (existsSync(source)) copyFileSync(source, join(paths.systemdUnitDir, name));
      }
      return runStep({ command: "systemctl", args: ["--user", "daemon-reload"] }, run);
    },

    probe() {
      const states = SYSTEMD_TIMERS.map((unit) => ({
        unit,
        loaded: runStep({ command: "systemctl", args: ["--user", "is-enabled", unit] }, run).ok,
      }));
      return { loaded: states.every((state) => state.loaded), units: states };
    },

    enable() {
      const prepared = this.install();
      if (prepared.missing) return { ok: false, reason: "systemctl is not available on this machine" };

      if (this.probe().loaded) return { ok: true, already: true };
      const outcome = runStep(
        { command: "systemctl", args: ["--user", "enable", "--now", ...SYSTEMD_TIMERS] },
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
      const wasEnabled = this.probe().loaded;
      const outcome = runStep(
        { command: "systemctl", args: ["--user", "disable", "--now", ...SYSTEMD_TIMERS] },
        run,
      );
      if (outcome.ok) return { ok: true, already: !wasEnabled };
      if (outcome.missing) return { ok: true, already: true };
      if (/not found|no such file|does not exist/i.test(outcome.stderr)) return { ok: true, already: true };
      return { ok: false, reason: `systemctl exited ${outcome.status}: ${firstLine(outcome.stderr)}` };
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
  const base = `install.sh --supervisor=disable --supervisor-hosts ${paths.host}`;
  return chosen === resolveScheduler("auto", platform) ? base : `${base} --scheduler=${chosen}`;
}

/**
 * Run one action for one host. Everything is reported on `log`; the return value is the
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
    `host=${paths.host}, scheduler=${mechanism.name}, units=${mechanism.unitsReport}`;
  const all = mechanisms({ paths, uid: options.uid ?? process.getuid?.() ?? null, run });

  if (action === "status") {
    log(`supervisor: status (host=${paths.host})`);
    const names = scheduler === "auto" ? ["launchd", "systemd", "cron"] : [requested];
    for (const name of names) {
      const probe = all[name].probe();
      const listed = probe.units.map((u) => `${u.unit}=${u.loaded ? "loaded" : "not loaded"}`).join(", ");
      log(`supervisor:   ${name}: ${probe.loaded ? "loaded" : "not loaded"} (${listed})`);
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

  // One mechanism per host: take any *other* loaded one down first, so this can never
  // leave two racing for the same cards. Only this module's own labels / unit names /
  // marker block are touched, and a take-down that did not happen is said so — a silent
  // failure here would leave exactly the double-load this is meant to prevent.
  for (const name of ["launchd", "systemd", "cron"]) {
    if (name === requested) continue;
    const other = all[name];
    if (!other.probe().loaded) continue;
    const taken = other.disable();
    if (taken.ok) {
      log(`supervisor: disabled (host=${paths.host}, scheduler=${name}, units=${other.unitsReport}) — one mechanism per host`);
    } else {
      log(
        `supervisor: warning — ${name} is also loaded (host=${paths.host}, units=${other.unitsReport}) and could not be ` +
          `taken down (${taken.reason}); two loaded units for one host race for the same cards`,
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

const USAGE = `Usage: node scripts/install/lib/supervisor.mjs <enable|disable|status> --host <host> \\
         --agent <name> --host-base <dir> [--scheduler auto|launchd|systemd|cron] [--dry-run]

Loads, unloads or reports one loop host's supervisor units — the opt-in path
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
    else if (arg === "--host") opts.host = value();
    else if (arg === "--agent") opts.agent = value();
    else if (arg === "--host-base") opts.hostBase = value();
    else if (arg === "--scheduler") opts.scheduler = value();
    else {
      process.stderr.write(`supervisor: unknown option: ${arg}\n`);
      return 2;
    }
  }

  for (const required of ["host", "agent", "hostBase"]) {
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
    paths: supervisorPaths({ hostBase: opts.hostBase, agent: opts.agent, host: opts.host, env }),
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
