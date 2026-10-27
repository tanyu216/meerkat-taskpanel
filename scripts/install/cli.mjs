#!/usr/bin/env node
/**
 * `meerkat-taskpanel` — the npm/npx installer.
 *
 * This is a thin translation layer, not a second installer: it computes the
 * installed server root, points the agent installs at it, and runs the same
 * `install.sh` a source checkout uses. `server`, `taskctl` and the skills all
 * come from the package that was just downloaded.
 *
 *   npx meerkat-taskpanel                 # server + taskctl + every agent-kind skill
 *   npx meerkat-taskpanel install --target server
 *   npx meerkat-taskpanel install --target claude,server,pi
 *   npx meerkat-taskpanel install --no-server
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: meerkat-taskpanel [install] [options]

Installs the board server at <home>/.meerkat-taskpanel, the taskctl/taskd
launchers, and the agent-kind skills. Run through npx or a global npm install.

With no options on a terminal, an interactive wizard asks every setting.
Piped input, --dry-run and --yes never prompt and keep the defaults below.

Options:
  --target <list>     agent kinds to install (claude,openclaw,codex,pi),
                      "server", or "all" (default: every agent + the server)
  --no-server         install only the agent-kind skills
  --prefix <home>     install under <home> instead of $HOME
  -i, --interactive   ask every option in a wizard (works with piped answers)
  --yes, --non-interactive
                      accept every default; never prompt (the CI form)
  --force             refresh drifted managed files (never .env or .data)
  --dry-run           print every path; write nothing (never prompts)
  --skip-web-build    never try to build web/dist (API-only if absent)
  -h, --help          this page
`;

export function parse(argv) {
  const out = {
    command: null,
    targets: null,
    noServer: false,
    prefix: null,
    force: false,
    dryRun: false,
    skipWebBuild: false,
    interactive: false,
    yes: false,
    options: 0,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--target") {
      out.targets = argv[++i] ?? null;
      out.options += 1;
    } else if (arg.startsWith("--target=")) {
      out.targets = arg.slice(9);
      out.options += 1;
    } else if (arg === "--no-server") {
      out.noServer = true;
      out.options += 1;
    } else if (arg === "--prefix") {
      out.prefix = argv[++i] ?? null;
      out.options += 1;
    } else if (arg.startsWith("--prefix=")) {
      out.prefix = arg.slice(9);
      out.options += 1;
    } else if (arg === "-i" || arg === "--interactive") {
      out.interactive = true;
      out.options += 1;
    } else if (arg === "--yes" || arg === "--non-interactive") {
      out.yes = true;
      out.options += 1;
    } else if (arg === "--force") {
      out.force = true;
      out.options += 1;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
      out.options += 1;
    } else if (arg === "--skip-web-build") {
      out.skipWebBuild = true;
      out.options += 1;
    } else if (out.command === null) out.command = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

/** Split/normalise a comma target list, preserving order and dropping blanks. */
export function splitTargets(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The `--target` value the wrapper hands to install.sh.
 *
 * `all` means every agent **and** the server, so the default is just `all`. An
 * explicit list is literal: `--target claude,codex` installs those two agents and
 * no server, and `--target claude,server,pi` names all three targets. `--no-server`
 * drops the server from whatever the selection resolves to (it is forwarded to
 * install.sh, which owns the expansion). An explicit `server` is moved to the
 * front: the agent shims/config point at `<server_root>`, so the tree must exist
 * before the agent scripts run.
 *
 * @param {{targets?: string|null, noServer?: boolean}} options
 * @returns {{targets: string, server: boolean}}
 */
export function planTargets(options) {
  const explicit = options.targets !== null && options.targets !== undefined;
  const requested = explicit ? splitTargets(options.targets) : ["all"];
  if (requested.length === 0) throw new Error("no targets selected");
  const agents = requested.filter((entry) => entry !== "server");
  if (options.noServer && agents.length === 0) {
    throw new Error("no targets selected — --no-server leaves no agent to install");
  }
  const wantsServer = requested.includes("server") || requested.includes("all");
  const server = wantsServer && !options.noServer;
  const list = requested.includes("server") && !options.noServer ? ["server", ...agents] : requested;
  return { targets: list.join(","), server };
}

/**
 * The argv and environment to hand `install.sh`.
 *
 * When the wizard may run, the wrapper must **not** inject `--target` or
 * `--prefix`: `install.sh` decides "no arguments on a TTY" from `$#`, and it
 * needs to see only what the user actually typed. The resolved home still
 * travels in the environment so a relative override is normalised as before.
 * The server root is left to install.sh, which sets `MEERKAT_TASKPANEL_REPO` /
 * `ENV_FILE` once the wizard has picked the targets.
 *
 * @param {ReturnType<typeof parse>} args
 * @param {{targets: string, server: boolean}} plan
 * @param {string} home
 * @returns {{argv: string[], env: Record<string, string>, wizardMayRun: boolean}}
 */
export function buildInstallArgs(args, plan, home) {
  const env = { ...process.env };
  const wizardMayRun = !args.yes && !args.dryRun && (args.interactive || args.options === 0);

  if (wizardMayRun) {
    const argv = [join(ROOT, "install.sh")];
    if (args.interactive) argv.push("--interactive");
    if (args.targets !== null) argv.push("--target", args.targets);
    // Pass the resolved home, not the raw flag: a relative --prefix used to be
    // absolutized by the wrapper and must stay that way.
    if (args.prefix !== null) argv.push("--prefix", home);
    if (args.noServer) argv.push("--no-server");
    if (args.force) argv.push("--force");
    if (args.skipWebBuild) argv.push("--skip-web-build");
    env.MEERKAT_TASKPANEL_TARGET_HOME = home;
    return { argv, env, wizardMayRun };
  }

  const argv = [join(ROOT, "install.sh"), "--target", plan.targets, "--prefix", home];
  if (args.noServer) argv.push("--no-server");
  if (args.force) argv.push("--force");
  if (args.dryRun) argv.push("--dry-run");
  if (args.skipWebBuild) argv.push("--skip-web-build");
  if (args.yes) argv.push("--yes");
  if (args.interactive) argv.push("--interactive");

  if (plan.server) {
    // The program the agent-kind skills drive is the installed tree, not the npx
    // cache. One `.env` for the whole install; the tree owns `.data`.
    env.MEERKAT_TASKPANEL_REPO = join(home, ".meerkat-taskpanel");
    env.MEERKAT_TASKPANEL_ENV_FILE = join(home, ".meerkat-taskpanel", ".env");
  }
  return { argv, env, wizardMayRun };
}

async function main(argv) {
  const args = parse(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command !== null && args.command !== "install") {
    process.stderr.write(`meerkat-taskpanel: unknown command: ${args.command}\n`);
    return 2;
  }

  let plan;
  try {
    plan = planTargets(args);
  } catch (err) {
    process.stderr.write(`meerkat-taskpanel: ${err.message}\n`);
    return 2;
  }

  const home = resolve(args.prefix ?? process.env.MEERKAT_TASKPANEL_TARGET_HOME ?? homedir());
  const { argv: installArgs, env } = buildInstallArgs(args, plan, home);

  const run = spawnSync("bash", installArgs, { stdio: "inherit", env });
  if (run.error) {
    process.stderr.write(`meerkat-taskpanel: cannot run the installer: ${run.error.message}\n`);
    return 1;
  }
  if (run.status !== 0) return run.status ?? 1;
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
