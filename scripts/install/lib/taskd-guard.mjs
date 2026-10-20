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
 * **The unit must not depend on the host's `PATH`** (T-20261014-052428). launchd
 * runs a job with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so a `/usr/bin/env node`
 * unit on a machine whose node lives only under nvm or Homebrew exits 127 in a
 * restart loop, forever. The rendered unit therefore names **`process.execPath`
 * — the absolute node that rendered it** — and the plist additionally prepends
 * node's directory to that same default `PATH`, so a child that looks `node` up
 * by name finds it too. The trade-off is honest and documented: the path is
 * version-pinned (`~/.nvm/versions/node/vX/bin/node`), and after a node upgrade a
 * re-install reports the drifted unit and asks for `--force` rather than silently
 * loading one that can no longer start.
 *
 * **The unit also carries the operator's data directory** when they set one:
 * `TASKD_DATA_DIR` / `TASKD_RUNTIME_POINTER` are rendered into the unit's own
 * environment, because the contract requires the guard and the CLI to resolve the
 * *same* board (`docs/scheduling.md § Coexisting with taskctl's lazy start`), and
 * an operator who exported them for one install would otherwise get a guard
 * serving a different directory than the one they installed.
 *
 * **A loaded unit is not a working board.** `launchctl print` answering a pid says
 * the job was spawned — the 127 case above has a pid for a fraction of a second —
 * so the guard reports `enabled` only after the board itself answers `/health`,
 * exactly the readiness test the CLI applies. A unit that is loaded but not
 * serving reports `loaded … /health did not answer` instead, with the log to read.
 *
 * **The guard is one per machine, so a second install may have to refuse**
 * (`docs/scheduling.md § One guard per machine`). Because the label and the unit name
 * carry no board segment, the machine has exactly one guard job, and on Linux the file
 * systemd reads (`~/.config/systemd/user/<TASKD_UNIT>`) *is* that guard's definition:
 * copying this run's unit over it while a first board's guard is loaded re-points the
 * machine's only guard at a second board — silently, and only at the next reload, which
 * is what made it invisible (T-20261014-063205 §2.2). So the loaded probe is asked
 * **before** anything is installed into that directory, the board the loaded guard
 * serves is read from the unit systemd would read (or, when there is no such file, from
 * the board's own runtime pointer carrying this guard's pid), and a guard that is
 * already loaded **for another board** is a refusal — named, left untouched, exit 3 —
 * not a clobber. `--force` remains the one way to re-point it deliberately.
 *
 * Subcommand:
 *   install --prefix <dir> [--force]   render + write both units, then load this
 *                                      platform's one; prints a `taskd guard:` report
 *                                      (exit 3 when it refused to re-point the machine's
 *                                      guard at this board)
 *
 * Node builtins only; no network beyond the loopback `/health` probe; no dependencies.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { render, writeFileIdempotent } from "./apply.mjs";
import { unitPath } from "./unit-path.mjs";
import {
  AUTOSTART_POLL_MS,
  DATA_DIR_ENV,
  LOG_FILENAME,
  LOGS_DIRNAME,
  RUNTIME_FILENAME,
  RUNTIME_POINTER_ENV,
} from "../../../src/foundation/constants.mjs";
import { resolveDataDir, resolveRuntimePointerPath } from "../../../src/foundation/runtime-locator.mjs";
import { probeHealth, readPointer } from "../../../src/foundation/transport/runtime.mjs";

/**
 * The exit code a finished `install` leaves: **3** when it refused to re-point the
 * machine's already-loaded guard at this board (`report.state === "occupied"`), else 0.
 *
 * 3 is this repository's "ran, found a difference, declined" code — `export --check`
 * and `wake-cwd.mjs` use it the same way. Every other outcome of an install is 0 on
 * purpose: a unit that cannot be loaded is *reported*, not failed (the host install is
 * unaffected either way), so the one non-zero exit is the one deliberate refusal.
 *
 * @param {object} report the `installGuard` report
 */
export function exitCode(report) {
  return report.state === "occupied" ? 3 : 0;
}

/** The launchd Label. One per machine: no agent or host segment (unlike the loop's). */
export const TASKD_LABEL = "com.meerkat-taskpanel.taskd";
/** The systemd user unit name. Likewise machine-wide. */
export const TASKD_UNIT = "meerkat-taskpanel-taskd.service";

/** The unit templates to render, relative to `scripts/install/templates/`. */
export const TASKD_TEMPLATE_FILES = Object.freeze({
  launchd: "taskd/launchd/com.meerkat-taskpanel.taskd.plist",
  systemd: "taskd/systemd/meerkat-taskpanel-taskd.service",
});

/**
 * How long the install waits for the newly loaded board to answer `/health`.
 *
 * **Twice** the CLI's `AUTOSTART_TIMEOUT_MS`, on purpose. That constant bounds a *call*
 * — a client that waits longer than five seconds has failed its caller. This one bounds
 * the last step of an *install*, where the only costs are bounded patience and a louder
 * message, and the two failures are not symmetric: a board that is merely slow would be
 * reported `loaded … /health did not answer`, which reads exactly like the crash loop
 * this gate exists to expose. That is not hypothetical — during this card's own
 * real-machine run (T-20261014-052428) a first spawn after `launchctl bootstrap` took
 * ~5.5s under host load, while every isolated measurement of the same start is ~140ms.
 * A false alarm on a healthy install is the worse outcome, so the budget is the one that
 * tolerates it and the honest report survives for boards that are really dead.
 */
export const READY_TIMEOUT_MS = 10_000;

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
 * `node` is the interpreter the unit will name: **absolute**, and by default the
 * one running this file (`process.execPath`), so the unit runs the same node the
 * install did and never has to look one up on the host's `PATH`.
 *
 * @param {{prefix?: string, repoRoot?: string, env?: NodeJS.ProcessEnv, node?: string}} [options]
 */
export function guardPaths(options = {}) {
  const prefix = resolve(options.prefix ?? homedir());
  const root = options.repoRoot ?? repoRoot();
  const env = options.env ?? process.env;
  const dataDir = resolveDataDir({ env });
  const node = resolve(options.node ?? process.execPath);

  return {
    prefix,
    root,
    env,
    dataDir,
    node,
    nodeDir: dirname(node),
    serverEntry: join(root, "src", "server", "main.mjs"),
    logFile: join(dataDir, LOGS_DIRNAME, LOG_FILENAME),
    launchdUnit: join(prefix, "taskpanel", "scheduling", "launchd", `${TASKD_LABEL}.plist`),
    systemdUnit: join(prefix, "taskpanel", "scheduling", "systemd", TASKD_UNIT),
    pointerFile: resolveRuntimePointerPath({ env }),
  };
}

/**
 * The `PATH` the launchd job runs with: node's own directory, then launchd's
 * documented default.
 *
 * The default alone is the bug: it has no nvm/Homebrew directory, so `/usr/bin/env
 * node` cannot resolve. Prepending node's directory keeps the rest identical to
 * what launchd would have given the job, so nothing else changes for a child
 * process.
 *
 * The recipe itself lives in `unit-path.mjs`, shared with the loop's units — which
 * prepend one more directory, the host CLI's, because they derive a wakeable
 * executable this guard never does. The taskd unit's own `{{PATH}}` is deliberately
 * unchanged by that sharing: called with node's directory alone, `unitPath()` still
 * renders exactly the string it always did.
 *
 * @param {string} nodeDir
 */
export { unitPath };

/**
 * The `TASKD_*` variables the unit must carry to resolve the same board the
 * install did — **only** the ones the operator actually set.
 *
 * Both are documented as the unit's responsibility (`docs/scheduling.md §
 * Coexisting with taskctl's lazy start`), and both are absolute by the time they
 * get here, so the unit never re-resolves them at start-up. `TASKD_PORT` /
 * `TASKD_HOST` are deliberately **not** propagated: the unit is the long-running
 * owner of a stable address, and `TASKD_NO_AUTOSTART` is a client policy — see
 * the contract.
 *
 * @param {{env?: NodeJS.ProcessEnv, dataDir?: string, pointerFile?: string}} [options]
 * @returns {Array<[string, string]>} name/value pairs, in a stable order
 */
export function unitEnv(options = {}) {
  const env = options.env ?? process.env;
  const entries = [];

  const dataDir = env[DATA_DIR_ENV];
  if (typeof dataDir === "string" && dataDir.trim() !== "") {
    entries.push([DATA_DIR_ENV, resolve(options.dataDir ?? resolveDataDir({ env }))]);
  }
  const pointer = env[RUNTIME_POINTER_ENV];
  if (typeof pointer === "string" && pointer.trim() !== "") {
    entries.push([RUNTIME_POINTER_ENV, resolve(options.pointerFile ?? resolveRuntimePointerPath({ env }))]);
  }
  return entries;
}

/** Escape the five characters XML gives meaning to. Paths may legitimately hold `&`. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The unit's extra environment as **plist markup** — the `<key>`/`<string>` pairs
 * that sit inside `<key>EnvironmentVariables</key><dict>`. Empty when the
 * operator set neither variable, which leaves one blank line inside the dict.
 *
 * @param {Array<[string, string]>} entries
 */
export function plistEnvBlock(entries) {
  return entries.map(([name, value]) => `    <key>${xmlEscape(name)}</key>\n    <string>${xmlEscape(value)}</string>`).join("\n");
}

/**
 * Every `{{TOKEN}}` the two unit templates use. Exported so a test can render a
 * template without running an install — and so the map has exactly one definition.
 *
 * @param {ReturnType<typeof guardPaths>} paths
 * @returns {Record<string, string>}
 */
export function unitVars(paths) {
  const injected = unitEnv({ env: paths.env, dataDir: paths.dataDir, pointerFile: paths.pointerFile });
  return {
    NODE: paths.node,
    SERVER_ENTRY: paths.serverEntry,
    LOG: paths.logFile,
    PATH: unitPath(paths.nodeDir),
    ENV_PLIST: plistEnvBlock(injected),
    ENV_SYSTEMD: systemdEnvBlock(injected),
  };
}

/**
 * The same environment as **systemd directives** (one `Environment=` line each).
 *
 * Quoted when the value is not a bare word: systemd splits unquoted values on
 * whitespace, so a path with a space would otherwise become a directive systemd
 * rejects.
 *
 * @param {Array<[string, string]>} entries
 */
export function systemdEnvBlock(entries) {
  return entries
    .map(([name, value]) => `Environment=${name}=${/^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value)}`)
    .join("\n");
}

/** Invert `xmlEscape` — in the order that cannot double-unescape an escaped `&`. */
function xmlUnescape(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * The board a **rendered unit** pins: its `TASKD_DATA_DIR`, or `null` when it pins none.
 *
 * This is how "which board does that guard serve?" is answered without starting
 * anything (`installGuard` below). Both file formats are read because both are written
 * here: systemd puts the value in one `Environment=` line (`systemdEnvBlock` quotes a
 * value that is not a bare word, hence the JSON branch), a plist in a
 * `<key>`/`<string>` pair.
 *
 * `null` is not "no board" — it is the **unpinned** board, the one `resolveDataDir`
 * resolves at the unit's own start. Two units that both pin nothing serve the same
 * board by construction (they name the same checkout), which is what makes comparing
 * two of these values the whole test.
 *
 * @param {string} text a rendered unit file (systemd or launchd)
 * @returns {string|null}
 */
export function unitBoard(text) {
  const plist = /<key>TASKD_DATA_DIR<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  if (plist !== null) return xmlUnescape(plist[1]);

  // Anchored at the start of a line, so a mention of the name inside a comment or
  // another directive cannot be mistaken for the value systemd would read.
  const systemd = /^Environment=TASKD_DATA_DIR=(.*)$/m.exec(text);
  if (systemd === null) return null;
  const value = systemd[1].trim();
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Two `unitBoard` answers name the same board. Absolute both ways: one side is a render. */
function sameBoard(a, b) {
  return (a === null ? null : resolve(a)) === (b === null ? null : resolve(b));
}

/** The board as it reads in a report line. `null` is the unpinned (default) board. */
function boardLabel(dataDir) {
  return dataDir === null ? "the default board" : dataDir;
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
 * `enabled` is reserved for a board that **answers `/health`**: the supervisor's
 * own pid is not readiness (see the header). A unit that is loaded but not
 * serving is reported as `loaded`, with the pid, the wait and the log to read —
 * which is what turns a silent 127 crash loop into a line an operator can act on.
 *
 * Asynchronous because the readiness probe is: `/health` is read over loopback
 * with the same `probeHealth` the CLI uses, and that is a `fetch`.
 *
 * @param {{prefix?: string, repoRoot?: string, env?: NodeJS.ProcessEnv, platform?: string,
 *          uid?: number|null, home?: string, force?: boolean, runner?: typeof spawnSync,
 *          log?: (line: string) => void, pidWaitMs?: number, node?: string,
 *          healthWaitMs?: number, healthPollMs?: number, healthProbe?: Function,
 *          readPointerFn?: Function, sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<object>} the report (see `report` below)
 */
export async function installGuard(options = {}) {
  const paths = guardPaths(options);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const force = Boolean(options.force);
  const run = options.runner ?? spawnSync;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));

  const report = { units: [], state: "manual", reason: null, pid: null, ready: false, url: null, stop: [], platform };

  // The lazy-start path creates this directory too, and launchd will not create a
  // missing StandardOutPath directory: without it the job starts and cannot log.
  mkdirSync(dirname(paths.logFile), { recursive: true });

  const vars = unitVars(paths);
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

  const pidWaitMs = options.pidWaitMs ?? 1_000;

  // Ask the supervisor what it already holds **before** anything is installed into the
  // place it reads. The machine has exactly one guard (`TASKD_UNIT`, no host segment),
  // so on Linux the copy below *is* that guard: taken while a first board's guard is
  // loaded, it re-points it at this board — visible only at the next reload, and
  // reported as `already loaded (no change)` while the unit on disk had just changed
  // (T-20261014-063205 §2.2). Hence the order: probe, identify the board, then write.
  const already = runStep(plan.loadedProbe, run);
  if (already.ok) report.pid = waitForPid(plan, run, pidWaitMs);

  // The board this run would install, read back from the file that would be copied —
  // what actually lands, not a re-derivation of it.
  const mine = unitBoard(readFileSync(kind === "launchd" ? paths.launchdUnit : paths.systemdUnit, "utf8"));
  const served = already.ok
    ? servedBoard({
        unitFile: plan.unitDir === undefined ? null : join(plan.unitDir, TASKD_UNIT),
        pointers: [...new Set([paths.pointerFile, join(paths.dataDir, RUNTIME_FILENAME)])],
        pid: report.pid,
        readPointerFn: options.readPointerFn ?? readPointer,
      })
    : null;

  // A guard loaded for **another** board is a refusal, not a clobber: the machine's one
  // guard belongs to whoever installed first, and re-pointing it is a deliberate act
  // (`--force`), not a side effect of installing a second board. An unreadable board is
  // *not* a refusal — that would block a re-install on no evidence — it is reported.
  if (already.ok && plan.unitDir !== undefined && !force && served !== null && !sameBoard(served.dataDir, mine)) {
    report.state = "occupied";
    report.reason = `${join(plan.unitDir, TASKD_UNIT)} is loaded for another board (${boardLabel(served.dataDir)})`;
    log(`taskd guard: refused — ${TASKD_LABEL} is already loaded and serves another board (${boardLabel(served.dataDir)});`);
    log(`  ${join(plan.unitDir, TASKD_UNIT)} was left unchanged, and this board (${boardLabel(mine)}) is not guarded by it`);
    log(`taskd guard: this machine runs one guarded board — re-run with --force to point it at ${boardLabel(mine)}`);
    return report;
  }

  // systemd only reads its own user unit directory, so the unit is copied there
  // before it can be enabled — the same two steps docs/scheduling.md prints.
  if (plan.unitDir !== undefined) {
    const installed = join(plan.unitDir, TASKD_UNIT);
    mkdirSync(plan.unitDir, { recursive: true });
    copyFileSync(paths.systemdUnit, installed);
  }

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

  // `already loaded (no change)` describes the *job*, and on its own was read as "your
  // board is guarded" even when the loaded guard served a different one — the second
  // half of the F2 defect. The board is named whenever it could be read, and the
  // unreadable case says so rather than passing as a plain no-change.
  if (state === "already") {
    const other = served !== null && !sameBoard(served.dataDir, mine);
    // Reached with `other` only through `--force` (the gate above returns otherwise), and
    // then only on a platform that writes the machine's unit. The live job keeps the board
    // it started with until the supervisor reloads it, so that is what the line says.
    const repointed = other && plan.unitDir !== undefined;
    const clause =
      served === null
        ? " — which board it serves could not be read here"
        : !other
          ? ` — the machine's guard serves this board (${boardLabel(mine)})`
          : repointed
            ? ` — the live guard still serves ${boardLabel(served.dataDir)} until it is reloaded; its unit now names ${boardLabel(mine)}`
            : ` — the machine's guard serves another board (${boardLabel(served.dataDir)}); this board (${boardLabel(mine)}) is not the one it keeps alive`;
    log(`taskd guard: already loaded (no change)${clause}`);
  }
  if (report.pid === null) report.pid = waitForPid(plan, run, pidWaitMs);

  // The supervisor says the job *exists*. Whether the board it owns is *serving*
  // is a second question, and the one an operator actually cares about — so it is
  // asked, over the same `/health` the CLI trusts, before anything is called
  // enabled.
  const healthWaitMs = options.healthWaitMs ?? READY_TIMEOUT_MS;
  const readiness = await waitForHealth({
    // Two candidates, because a board has two addresses and either can be its own:
    // the pointer this install resolved (the operator's `TASKD_RUNTIME_POINTER` when
    // set, else the machine-wide one), and the file beside its data directory — where
    // a board is addressed when another live board already holds the machine-wide slot
    // (`runtime-pointer.mjs`). Asking only the first would call a healthy second board
    // unready.
    pointers: [paths.pointerFile, join(paths.dataDir, RUNTIME_FILENAME)],
    dataDir: paths.dataDir,
    pid: report.pid,
    timeoutMs: healthWaitMs,
    pollMs: options.healthPollMs ?? AUTOSTART_POLL_MS,
    probe: options.healthProbe ?? probeHealth,
    readPointerFn: options.readPointerFn ?? readPointer,
    sleep: options.sleep,
  });
  report.ready = readiness.ready;
  report.url = readiness.url;

  if (readiness.ready) {
    log(`taskd guard: enabled (${TASKD_LABEL}, pid ${report.pid ?? "unknown"})`);
  } else {
    // Loaded, and the supervisor will keep restarting it — but it is not serving
    // yet. Saying `enabled` here is exactly the lie the exit-127 crash loop used
    // to get: a pid, a cheerful line, and no board.
    report.state = "unready";
    log(
      `taskd guard: loaded (${TASKD_LABEL}, pid ${report.pid ?? "unknown"}); ` +
        `/health did not answer within ${healthWaitMs}ms — read ${paths.logFile}`,
    );
  }
  log("taskd guard: to stop and remove it:");
  for (const line of report.stop) log(`  ${line}`);
  return report;
}

/** A unit file's text, or `null` when there is no file to read. */
function readUnitText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Which board the machine's **already-loaded** guard serves, as far as this run can tell.
 *
 * Two sources, most authoritative first, because neither covers every platform:
 *
 *   1. **The unit the supervisor reads.** On Linux that is
 *      `~/.config/systemd/user/<TASKD_UNIT>` — the very file a second install used to
 *      rewrite, and the definition of the board the guard owns. It answers whether or
 *      not any board is running, which is the case that matters: the F1 defect rewrote
 *      the file and left the *loaded* job alone, so the damage only showed at the next
 *      reload.
 *   2. **The board's own runtime pointer, when it carries this guard's pid.** A board
 *      writes its address and pid on the way up (`runtime-pointer.mjs`), so a pointer
 *      naming *this* pid is that board's own statement of who serves it. This is what
 *      covers macOS, where no unit file is written for the machine: `launchctl` is given
 *      this run's plist path and the loaded job's own path is not readable through the
 *      seam this installer has. Only the machine-wide slot can name a board other than
 *      this run's, and the pointer beside *this* data directory can only ever confirm it.
 *
 * `null` is the honest third answer — **neither source could tell** — and callers report
 * it as such rather than smoothing it into "no change" (F2, T-20261014-063205).
 *
 * @param {{unitFile?: string|null, pointers?: string[], pid?: number|null,
 *          readUnitFn?: (path: string) => string|null, readPointerFn?: Function}} [options]
 * @returns {{dataDir: string|null, source: "unit"|"pointer"}|null}
 */
export function servedBoard(options = {}) {
  const { unitFile = null, pointers = [], pid = null, readUnitFn = readUnitText, readPointerFn = readPointer } = options;

  if (unitFile !== null) {
    const text = readUnitFn(unitFile);
    if (text !== null) return { dataDir: unitBoard(text), source: "unit" };
  }

  // No readable unit, so the pid is all that is left to attribute a pointer with. A
  // pointer whose pid is *not* the guard's belongs to some other process and says
  // nothing about this guard.
  if (pid === null) return null;
  for (const path of pointers) {
    const pointer = readPointerFn({ path });
    if (pointer === null || typeof pointer !== "object") continue;
    if (pointer.pid !== pid) continue;
    if (typeof pointer.dataDir !== "string" || pointer.dataDir === "") continue;
    return { dataDir: pointer.dataDir, source: "pointer" };
  }
  return null;
}

/**
 * Is this runtime pointer *the board this unit started*?
 *
 * Three conditions, each with a failure it prevents: a `url` to knock on; a `pid`
 * that matches the one the supervisor gave us (a stale pointer, or a different
 * board's, is not readiness); and — when both sides name one — the same data
 * directory, which is how a board is identified (`runtime-pointer.mjs`). An
 * absent `pid`/`dataDir` is not a mismatch: a pointer that names no owner
 * protects nobody, and the `/health` knock is what decides.
 *
 * @param {object|null} pointer
 * @param {{dataDir?: string|null, pid?: number|null}} [options]
 */
export function isOurBoard(pointer, options = {}) {
  if (pointer === null || typeof pointer !== "object") return false;
  if (typeof pointer.url !== "string" || pointer.url === "") return false;

  const { dataDir = null, pid = null } = options;
  if (pid !== null && pointer.pid !== undefined && pointer.pid !== pid) return false;
  if (dataDir !== null && pointer.dataDir !== undefined && resolve(pointer.dataDir) !== resolve(dataDir)) return false;
  return true;
}

/**
 * Block until the unit's board answers `/health`, or the budget runs out.
 *
 * The pointer is re-read every pass: it is written by the server *after* `listen`,
 * so a board that is still starting is a file that is absent or still names the
 * previous pid — and the answer to "is it up yet?" is a fresh read, not a sleep.
 * Never throws: a board that never arrives is `{ready: false}`, which the caller
 * reports.
 *
 * @param {{pointers: string[], dataDir?: string|null, pid?: number|null, timeoutMs?: number,
 *          pollMs?: number, probe?: Function, readPointerFn?: Function,
 *          now?: () => number, sleep?: (ms: number) => Promise<void>}} options
 * @returns {Promise<{ready: boolean, url: string|null, pid: number|null, path: string|null}>}
 */
export async function waitForHealth(options) {
  const {
    pointers,
    dataDir = null,
    pid = null,
    timeoutMs = READY_TIMEOUT_MS,
    pollMs = AUTOSTART_POLL_MS,
    probe = probeHealth,
    readPointerFn = readPointer,
    now = () => Date.now(),
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = options;

  const deadline = now() + timeoutMs;
  let seen = { url: null, pid: null, path: null };

  for (;;) {
    for (const path of pointers) {
      const pointer = readPointerFn({ path });
      if (!isOurBoard(pointer, { dataDir, pid })) continue;
      seen = { url: pointer.url, pid: pointer.pid ?? null, path };
      // A probe that throws is a board that is not answering, not a broken install:
      // `probeHealth` swallows its own socket errors, and a caller's replacement must
      // not be able to take the install down with it.
      let alive = false;
      try {
        alive = await probe(pointer.url);
      } catch {
        alive = false;
      }
      if (alive) return { ready: true, ...seen };
    }
    if (now() >= deadline) return { ready: false, ...seen };
    await sleep(pollMs);
  }
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
<dir>/taskpanel/scheduling/, then loads this platform's one, waits for its
board to answer /health, and reports what happened.
Called by install.sh; not meant to be run by hand.

Exit 0 even when the unit could not be loaded (the report says so, and the
host install is unaffected). Exit 3 when it refused to re-point the machine's
already-loaded guard at this board — that guard is one per machine, and it
belongs to the board installed first; --force re-points it deliberately.
`;

async function main() {
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

  // A refusal is not a success — the machine's one guard still serves whoever installed
  // first — so it leaves the subcommand with a code of its own (`exitCode`). `install.sh`
  // already treats a non-zero guard step as non-fatal (it prints the line above and
  // carries on, `install.sh:488-495`), which keeps this out of the install's own status.
  return exitCode(await installGuard({ prefix, force }));
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
//
// `process.exit` (rather than an exit code left to drain) is deliberate: the
// readiness probe is a `fetch`, and undici keeps its sockets pooled, which would
// otherwise hold the loop open for a few seconds after a report that is already
// complete and printed.
if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
