#!/usr/bin/env node
/**
 * Thin wrapper that runs the Meerkat TaskPanel CLI from the skill.
 *
 * A skill directory is distributed **on its own**: `install.sh` copies `SKILL.md`,
 * `references/` and `scripts/` into a host's skill directory, and nothing else — in
 * particular not the taskpanel checkout they were authored in. So the CLI this file
 * drives cannot be assumed to sit three levels up, and a wrapper that only knew how to
 * look there failed *outside* the checkout: from
 * `<home>/.claude/skills/meerkat-taskpanel/scripts/` the walk up lands on
 * `<home>/.claude`, and the spawn died with a module-not-found stack naming a path the
 * user never had (T-20261014-214002). The documented entry point in `SKILL.md` was
 * therefore broken in exactly the deployment the skill is built for.
 *
 * Resolution is a ladder, and **every rung is checked before it is used** — a rung that
 * is unset, stale or misspelt is skipped rather than tried, so it can never shadow a
 * rung that would have worked:
 *
 *   1. `$MEERKAT_TASKPANEL_ROOT`  — an explicit root, the user's own override
 *   2. `$MEERKAT_TASKPANEL_REPO`  — the key `install.sh` records in the host config, and
 *                                   the one the loop's `board-check.mjs` resolves through
 *                                   (same vocabulary, deliberately)
 *   3. this file's own checkout   — `here/../../..`, the rung that works in a checkout
 *   4. **the host's own shim**    — `<host>/bin/taskctl`, the `taskctl` wrapper
 *                                   `install.sh` writes beside this skill
 *   5. `taskctl` on `PATH`        — a CLI installed for the host, checkout or not
 *   6. none of the above          — a clear, actionable refusal (below), never a stack
 *
 * Rungs 1–3 are the checkout rungs, most explicit first. **Rung 4 is why this ladder has
 * six rungs**: the shim is the only `taskctl` that arrives with the caller's identity
 * already pinned (`--agent <name> --actor-kind <host>`), so it is preferred over a bare
 * `PATH` CLI — which is the only rung that cannot say *which* board engine it will find,
 * nor what kind the write will be recorded as. Rung 4 is checked *after* the checkout
 * rungs and not before them: an explicit root, and a checkout this file is lying in, are
 * both more specific than a wrapper written at install time.
 *
 * No business logic lives here: the CLI is spawned with the caller's arguments, stdio is
 * piped through, and the exit code is propagated.
 */

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The CLI, relative to a checkout root. Spelled once so the checks and the message agree. */
const CLI_REL = join("src", "cli", "index.mjs");
/** The installed CLI's command name, for the `PATH` rung and the refusal. */
const CLI_NAME = "taskctl";
/** How the wrapper names itself in a message it originates (the repo's script convention). */
const SELF = "meerkat-taskpanel";

/** True when `path` is an existing regular file. Any error (ENOENT, EACCES, ENOTDIR) is "no". */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` is an existing *executable* regular file — what `spawn` needs. */
function isExecutableFile(path) {
  if (!isFile(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A non-empty, trimmed string from the environment, or `""`. */
function envValue(env, key) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The checkout roots to try, in order, each tagged with where it came from so the refusal
 * can list them (a bare path list without provenance is what made the original failure
 * unreadable — the user could not tell which path was supposed to exist).
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Array<{origin: string, root: string}>}
 */
function checkoutRoots(env) {
  const roots = [];
  const explicit = envValue(env, "MEERKAT_TASKPANEL_ROOT");
  if (explicit) roots.push({ origin: "MEERKAT_TASKPANEL_ROOT", root: explicit });
  const recorded = envValue(env, "MEERKAT_TASKPANEL_REPO");
  if (recorded) roots.push({ origin: "MEERKAT_TASKPANEL_REPO", root: recorded });
  roots.push({ origin: "this skill's own location", root: resolve(here, "..", "..", "..") });
  return roots;
}

/**
 * The first executable `name` on `PATH`, or `null`. Scanned here rather than shelled out
 * to `which`, so the check is the same everywhere and the answer is an absolute path the
 * refusal can name.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @returns {string|null}
 */
function findOnPath(env, name) {
  const path = envValue(env, "PATH");
  if (!path) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The `taskctl` shim `install.sh` writes **beside this skill**, or `null`.
 *
 * A skill is installed at `<host>/skills/meerkat-taskpanel/`, and the shim at
 * `<host>/bin/taskctl` — the same `here/../../..` walk that lands on the host directory.
 * It is the one `taskctl` that carries the caller's identity, so the ladder prefers it
 * over a bare `PATH` CLI.
 *
 * `null` when there is no such file, or it is not executable: a shim `spawn` cannot
 * execute would be a rung that shadows the ones below it and then fails, which is the
 * opposite of what this ladder promises.
 *
 * @returns {string|null}
 */
function shimBesideSkill() {
  const candidate = join(resolve(here, "..", "..", ".."), "bin", CLI_NAME);
  return isExecutableFile(candidate) ? candidate : null;
}

/**
 * Resolve what to run.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{kind: "checkout", command: string, args: string[]}
 *          |{kind: "shim", command: string, args: string[]}
 *          |{kind: "path", command: string, args: string[]}
 *          |{kind: "missing", roots: Array<{origin: string, root: string}>}}
 */
function resolveTarget(env) {
  const roots = checkoutRoots(env);
  for (const { root } of roots) {
    const cli = join(root, CLI_REL);
    if (isFile(cli)) return { kind: "checkout", command: process.execPath, args: [cli] };
  }

  // The host's own shim — the rung that carries the identity. See the ladder above for
  // why it sits here and not above the checkout rungs.
  const shim = shimBesideSkill();
  if (shim !== null) return { kind: "shim", command: shim, args: [] };

  const onPath = findOnPath(env, CLI_NAME);
  if (onPath) return { kind: "path", command: onPath, args: [] };

  return { kind: "missing", roots };
}

/**
 * The refusal: what was looked for, where, and the three ways to make it work. Modelled on
 * `src/shared/transport/errors.mjs#renderErrorText` (`try:` / `  or:` / `note:`) so a
 * failure reads the same whether it came from the CLI or from the wrapper that starts it.
 *
 * @param {Array<{origin: string, root: string}>} roots
 * @returns {string}
 */
function refusal(roots) {
  return [
    `${SELF}: cannot find the board CLI to run (${CLI_NAME}).`,
    "This skill ships only SKILL.md, references/ and scripts/ — it does not carry the taskpanel source tree.",
    "looked for it at:",
    ...roots.map(({ origin, root }) => `  - ${origin}: ${join(root, CLI_REL)}`),
    `  - this host's shim: ${join(resolve(here, "..", "..", ".."), "bin", CLI_NAME)}`,
    `  - PATH: no executable \`${CLI_NAME}\` on it`,
    `try: install the CLI and put it on your PATH — bash <taskpanel-checkout>/install.sh --target <host>`,
    `  or: name the checkout here — MEERKAT_TASKPANEL_ROOT=<taskpanel-checkout> node ${join("scripts", "run.mjs")} …`,
    `  or: run the checkout's own copy — node <taskpanel-checkout>/${join("skills", "meerkat-taskpanel", "scripts", "run.mjs")} …`,
    "note: nothing else changes — whichever you pick makes this wrapper work as documented.",
  ].join("\n");
}

const target = resolveTarget(process.env);

if (target.kind === "missing") {
  process.stderr.write(`${refusal(target.roots)}\n`);
  process.exit(1);
}

const child = spawn(target.command, [...target.args, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  // Reached only when the rung that resolved has since gone (a race) or cannot be
  // executed; `target.command` is a path that was verified, so naming it is honest.
  process.stderr.write(`${SELF}: failed to run ${target.command}: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
