#!/usr/bin/env node
/**
 * The `taskd` OS-level keepalive unit — "the guard" (`docs/scheduling.md`).
 *
 * `install.sh` calls this once per install, because the guard is **one per
 * machine**, not one per host: it writes both unit templates into a neutral
 * `<prefix>/taskpanel/scheduling/` directory (deliberately *not* the loop units'
 * `<host-dir>/scheduling/`, so re-installing a host never touches it) and then
 * loads the one for this platform. It is the single **explicit exception** to
 * the installer's rule that it writes a unit and prints the load command but
 * never starts a daemon — the loop supervisor's units still keep that rule.
 *
 * Why a keepalive at all: `taskctl` lazy-starts `taskd` only when a CLI call
 * needs it, so a board whose server dies while nobody is calling it would stay
 * down until the next call. The unit closes that gap with the supervisor's own
 * `KeepAlive` / `Restart=always` — the contract adds **no retry script**, and no
 * log rotator: back-off and rotation belong to launchd / systemd.
 *
 * The unit is *not* a scheduled tick (no `StartInterval`, no `.timer`). It is the
 * single long-running owner of the data directory's write lock (R1), which is why
 * it must not set `TASKD_NO_AUTOSTART` (a *client* policy) or `TASKD_PORT=0` (a
 * long-running guard needs a stable port other clients can find again).
 *
 * The log is the **same file** the lazy-start path writes (`<dataDir>/logs/taskd.log`,
 * both in append mode), so one history exists whichever way the server started.
 * The data directory is resolved through `resolveDataDir`, the single source of
 * truth — never restated here.
 *
 * Subcommand:
 *   install --prefix <dir> [--force]   render + write both units, then load this
 *                                      platform's one; prints a `taskd guard:` report
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { render, writeFileIdempotent } from "./apply.mjs";
import { LOG_FILENAME, LOGS_DIRNAME } from "../../../src/shared/constants.mjs";
import { resolveDataDir } from "../../../src/shared/runtime-locator.mjs";

/** The launchd Label. One per machine: no agent or host segment (unlike the loop's). */
export const TASKD_LABEL = "com.meerkat-taskpanel.taskd";
/** The systemd user unit name. Likewise machine-wide. */
export const TASKD_UNIT = "meerkat-taskpanel-taskd.service";

/** The unit templates to render, relative to `scripts/install/templates/`. */
export const TASKD_TEMPLATE_FILES = Object.freeze({
  launchd: "taskd/launchd/com.meerkat-taskpanel.taskd.plist",
  systemd: "taskd/systemd/meerkat-taskpanel-taskd.service",
});

/** This checkout's root, from `<root>/scripts/install/lib/`. */
function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** The installer's own template root: `<root>/scripts/install/templates/`. */
function templatesRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

/**
 * Every path the guard needs. Pure arithmetic — nothing is created here.
 *
 * @param {{prefix?: string, repoRoot?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function guardPaths(options = {}) {
  const prefix = resolve(options.prefix ?? homedir());
  const root = options.repoRoot ?? repoRoot();
  const env = options.env ?? process.env;
  const dataDir = resolveDataDir({ env });

  return {
    prefix,
    root,
    env,
    dataDir,
    serverEntry: join(root, "src", "server", "main.mjs"),
    logFile: join(dataDir, LOGS_DIRNAME, LOG_FILENAME),
    launchdUnit: join(prefix, "taskpanel", "scheduling", "launchd", `${TASKD_LABEL}.plist`),
    systemdUnit: join(prefix, "taskpanel", "scheduling", "systemd", TASKD_UNIT),
  };
}

/**
 * Where a `systemd --user` unit must live for systemd to find it.
 *
 * `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. Not derived from
 * `--prefix`: systemd reads the *user's* configuration directory and nothing else,
 * so a unit parked under a custom prefix would never be found. (`install.sh --prefix`
 * chooses where the installer writes its own copy of the unit, not where systemd
 * looks for it.)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 */
export function systemdUserDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = typeof xdg === "string" && isAbsolute(xdg) ? resolve(xdg) : join(home, ".config");
  return join(base, "systemd", "user");
}

/**
 * What makes the unit live, as **data** — so both platforms' plans are readable
 * against `docs/scheduling.md`, and testable on either platform.
 *
 * @param {{platform: string, uid?: number|null, home?: string, env?: NodeJS.ProcessEnv,
 *          launchdUnit: string, systemdUnit: string}} options
 * @returns {{manager: string, commands: Array<{command: string, args: string[]}>,
 *            fallback?: {command: string, args: string[]},
 *            loadedProbe: {command: string, args: string[]},
 *            pidProbe: {command: string, args: string[]},
 *            stop: string[]} | null}
 */
export function enablePlan(options) {
  const { platform, uid, launchdUnit, systemdUnit } = options;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  if (platform === "darwin") {
    const domain = `gui/${uid}`;
    const job = `${domain}/${TASKD_LABEL}`;
    return {
      manager: "launchctl",
      commands: [{ command: "launchctl", args: ["bootstrap", domain, launchdUnit] }],
      // Older systems spell loading as `load -w`; the docs give both.
      fallback: { command: "launchctl", args: ["load", "-w", launchdUnit] },
      loadedProbe: { command: "launchctl", args: ["print", job] },
      pidProbe: { command: "launchctl", args: ["print", job] },
      stop: [`launchctl bootout ${job}`, `rm ${launchdUnit}`],
    };
  }

  if (platform === "linux") {
    const unitDir = systemdUserDir(env, home);
    return {
      manager: "systemctl",
      commands: [{ command: "systemctl", args: ["--user", "enable", "--now", TASKD_UNIT] }],
      loadedProbe: { command: "systemctl", args: ["--user", "is-active", TASKD_UNIT] },
      pidProbe: { command: "systemctl", args: ["--user", "show", "--property", "MainPID", "--value", TASKD_UNIT] },
      stop: [`systemctl --user disable --now ${TASKD_UNIT}`, `rm ${join(unitDir, TASKD_UNIT)}`],
      systemdUnit,
      unitDir,
    };
  }

  return null;
}

/**
 * Run one command, reporting a missing binary the same way as a non-zero exit
 * (both mean "this environment cannot load the unit"), never as a throw.
 *
 * `step.input` (optional) is fed to the command's stdin — `crontab -`, in
 * `supervisor.mjs` next door, reads its new table that way. Shared from here so
 * there is one implementation of "run a step and report what happened".
 *
 * @param {{command: string, args: string[], input?: string}} step
 * @param {typeof spawnSync} [runner]
 */
export function runStep(step, runner = spawnSync) {
  const options = { encoding: "utf8" };
  if (step.input !== undefined) options.input = step.input;
  const result = runner(step.command, step.args, options);
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? null,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "") || (result.error ? result.error.message : ""),
    missing: result.error?.code === "ENOENT",
  };
}

/** The supervisor's own pid for the unit, or `null` when it does not answer one. */
export function parsePid(plan, output) {
  if (plan.manager === "launchctl") {
    const match = /^\s*pid = (\d+)\s*$/m.exec(output);
    return match ? Number(match[1]) : null;
  }
  const value = output.trim();
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

/**
 * Write both units and load this platform's one.
 *
 * Every step is reported: a write says `wrote` / `kept`, and the load says
 * `enabled (…, pid …)` — the line `docs/install.md` documents — or, when this
 * machine has no way to load it, `installed … not loaded` plus the command that
 * would. A load that cannot happen is **not** a failed install: the host skills
 * are installed either way, and the honest report plus the printed command is
 * what lets an operator finish the job.
 *
 * @param {{prefix?: string, repoRoot?: string, env?: NodeJS.ProcessEnv, platform?: string,
 *          uid?: number|null, home?: string, force?: boolean, runner?: typeof spawnSync,
 *          log?: (line: string) => void, pidWaitMs?: number}} [options]
 */
export function installGuard(options = {}) {
  const paths = guardPaths(options);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const force = Boolean(options.force);
  const run = options.runner ?? spawnSync;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));

  const report = { units: [], state: "manual", reason: null, pid: null, stop: [], platform };

  // The lazy-start path creates this directory too, and launchd will not create a
  // missing StandardOutPath directory: without it the job starts and cannot log.
  mkdirSync(dirname(paths.logFile), { recursive: true });

  const vars = { SERVER_ENTRY: paths.serverEntry, LOG: paths.logFile };
  const units = [
    ["launchd", paths.launchdUnit, join(templatesRoot(), TASKD_TEMPLATE_FILES.launchd)],
    ["systemd", paths.systemdUnit, join(templatesRoot(), TASKD_TEMPLATE_FILES.systemd)],
  ];
  for (const [kind, dest, source] of units) {
    const written = writeFileIdempotent(dest, render(readFileSync(source, "utf8"), vars), { force });
    report.units.push({ kind, dest, status: written.status });
    if (written.status === "written") log(`taskd guard: wrote ${dest}`);
    else if (written.status === "unchanged") log(`taskd guard: kept ${dest} (already current)`);
    else log(`taskd guard: kept ${dest} (differs from the template — re-run with --force to refresh)`);
  }

  const plan = enablePlan({
    platform,
    uid: options.uid ?? process.getuid?.() ?? null,
    home,
    env,
    launchdUnit: paths.launchdUnit,
    systemdUnit: paths.systemdUnit,
  });

  // A unit that exists and differs was *not* written by this run (the merge contract:
  // never clobber without --force). Loading it would load something nobody here wrote —
  // typically a unit a previous install left pointing at a checkout that has since
  // moved — so the honest move is to say so and leave the operator the one escape hatch.
  const kind = platform === "darwin" ? "launchd" : "systemd";
  const stale = report.units.find((unit) => unit.kind === kind && unit.status === "skipped");
  if (stale !== undefined) {
    report.state = "stale";
    report.reason = `${stale.dest} was not refreshed`;
    log(`taskd guard: not loaded — ${report.reason} (re-run with --force to overwrite it)`);
    return report;
  }

  if (plan === null) {
    report.reason = `no user service manager is defined for platform "${platform}"`;
    log(`taskd guard: installed (${TASKD_LABEL}); not loaded — ${report.reason}`);
    return report;
  }
  report.stop = plan.stop;

  // systemd only reads its own user unit directory, so the unit is copied there
  // before it can be enabled — the same two steps docs/scheduling.md prints.
  if (plan.unitDir !== undefined) {
    const installed = join(plan.unitDir, TASKD_UNIT);
    mkdirSync(plan.unitDir, { recursive: true });
    copyFileSync(paths.systemdUnit, installed);
  }

  const already = runStep(plan.loadedProbe, run);
  let state = "manual";
  let reason = null;

  if (already.ok) {
    state = "already";
  } else {
    let outcome = runStep(plan.commands[0], run);
    if (!outcome.ok && plan.fallback) outcome = runStep(plan.fallback, run);
    if (outcome.ok) {
      state = "enabled";
    } else if (outcome.missing) {
      reason = `${plan.manager} is not available on this machine`;
    } else {
      reason = `${plan.manager} exited ${outcome.status}${outcome.stderr ? `: ${outcome.stderr.trim().split("\n")[0]}` : ""}`;
    }
  }

  report.state = state;
  report.reason = reason;

  if (reason !== null) {
    log(`taskd guard: installed (${TASKD_LABEL}); not loaded — ${reason}`);
    const [first] = plan.commands;
    log(`taskd guard: load it with: ${[first.command, ...first.args].join(" ")}`);
    return report;
  }

  if (state === "already") log("taskd guard: already loaded (no change)");
  report.pid = waitForPid(plan, run, options.pidWaitMs ?? 1_000);
  log(`taskd guard: enabled (${TASKD_LABEL}, pid ${report.pid ?? "unknown"})`);
  log("taskd guard: to stop and remove it:");
  for (const line of report.stop) log(`  ${line}`);
  return report;
}

/** Poll for the supervisor's pid: the job is spawned asynchronously, so it may not be there yet. */
function waitForPid(plan, run, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const probe = runStep(plan.pidProbe, run);
    const pid = probe.ok ? parsePid(plan, probe.stdout) : null;
    if (pid !== null || Date.now() >= deadline) return pid;
    try {
      // A short, bounded sleep: `Atomics.wait` on a throwaway buffer keeps this
      // synchronous, which is what the CLI-shaped entry point wants.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } catch {
      return pid;
    }
  }
}

const USAGE = `Usage: node scripts/install/lib/taskd-guard.mjs install --prefix <dir> [--force]

Writes the taskd keepalive unit (launchd + systemd) under
<dir>/taskpanel/scheduling/, then loads this platform's one and reports it.
Called by install.sh; not meant to be run by hand.
`;

function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (subcommand !== "install") {
    process.stderr.write(`taskd-guard: unknown subcommand: ${subcommand}\n`);
    return 2;
  }

  let prefix = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prefix") {
      prefix = argv[++i];
      if (prefix === undefined) {
        process.stderr.write("taskd-guard: --prefix requires a value\n");
        return 2;
      }
    } else if (argv[i] === "--force") {
      force = true;
    } else {
      process.stderr.write(`taskd-guard: unknown option: ${argv[i]}\n`);
      return 2;
    }
  }
  if (prefix === null) {
    process.stderr.write("taskd-guard: --prefix <dir> is required\n");
    return 2;
  }

  installGuard({ prefix, force });
  return 0;
}

/**
 * Canonical (symlink-free) path, for the self-dispatch guard below.
 *
 * Both sides must be in the *same* form: bash's `script_dir()` prints the logical path
 * (`cd … && pwd`), and on macOS `/tmp` is a symlink to `/private/tmp`, so comparing the
 * invoked path against the module URL directly is false whenever this file is reached
 * through a symlink — `main()` never runs and every subcommand becomes a no-op that
 * still exits 0. `apply.mjs` next door documents the same trap (T-20261012-175712).
 *
 * @param {string} path
 */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Only run when executed directly, so tests can import the pure parts above.
if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
