/**
 * Host profile loading and verification.
 *
 * Every supported agent host gets a flat profile file in `docker/profiles/<host>.yml`.
 * Loading and asserting are split on purpose:
 *
 *   loadProfiles()  reads + validates the profile files        (I/O, thin)
 *   buildChecks()   derives the destination paths + assertions  (pure, fully testable)
 *   runProfiles()   installs into a throwaway home and asserts  (I/O)
 *
 * Installation always happens under `TASKPANEL_TARGET_HOME`, never a real host home —
 * the container/CI run must not touch `$HOME`.
 *
 * Installs use `--link` (`TASKPANEL_LINK=1`). The skill's wrapper resolves the CLI by
 * walking up from its own location, so only a symlinked skill points back at the
 * checkout; a copied skill has no `src/` beside it. Verification therefore mirrors
 * `install.sh --link`, which is also the mode the docs recommend for a checkout.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_NAME, VERSION } from "../../../src/shared/constants.mjs";
import { MiniYamlError, parseMiniYaml } from "./mini-yaml.mjs";

/** Hosts that must each ship a profile. */
export const PROFILE_HOSTS = ["claude", "openclaw", "codex", "pi"];

/** Required keys of the flat profile schema. */
export const REQUIRED_PROFILE_FIELDS = ["host", "label", "installer", "target_dir", "skill_entry", "wrapper"];

/** Repository root, derived from this file's location (scripts/verify/lib/ → up 3). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Default throwaway home when the caller does not inject one. */
export function defaultHome() {
  return join(tmpdir(), `taskpanel-profiles-${process.pid}`);
}

/**
 * Read the leading `---` frontmatter block of a markdown file and return one field's
 * value, or `null` when the block or the field is absent.
 *
 * @param {string} text
 * @param {string} field
 * @returns {string|null}
 */
export function readFrontmatterField(text, field) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!match) return null;

  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim() === field) {
      let value = line.slice(colon + 1).trim();
      const first = value[0];
      if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }

  return null;
}

/**
 * Load and validate every profile in `profilesDir`.
 *
 * Never throws for bad input: problems are collected into `errors` so the CLI can print
 * them all at once instead of dying on the first one.
 *
 * @param {string} profilesDir
 * @returns {Promise<{hosts: string[], profiles: Record<string, Record<string, string>>, errors: string[]}>}
 */
export async function loadProfiles(profilesDir) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, Record<string, string>>} */
  const profiles = {};

  let entries = [];
  try {
    entries = await readdir(profilesDir);
  } catch (err) {
    return { hosts: [], profiles, errors: [`profiles directory not readable: ${profilesDir} (${err.code ?? err.message})`] };
  }

  const present = new Set(entries.filter((name) => name.endsWith(".yml")).map((name) => name.slice(0, -4)));

  for (const name of present) {
    if (!PROFILE_HOSTS.includes(name)) {
      errors.push(`unknown profile: ${name}.yml (expected one of ${PROFILE_HOSTS.join(", ")})`);
    }
  }

  for (const host of PROFILE_HOSTS) {
    if (!present.has(host)) {
      errors.push(`${host}: missing profile file ${join(profilesDir, `${host}.yml`)}`);
      continue;
    }

    const file = join(profilesDir, `${host}.yml`);
    let parsed;
    try {
      parsed = parseMiniYaml(await readFile(file, "utf8"));
    } catch (err) {
      if (err instanceof MiniYamlError) {
        errors.push(`${host}: invalid profile: ${err.message}`);
      } else {
        errors.push(`${host}: unreadable profile: ${err.message}`);
      }
      continue;
    }

    let ok = true;

    for (const field of REQUIRED_PROFILE_FIELDS) {
      if (typeof parsed[field] !== "string" || parsed[field] === "") {
        errors.push(`${host}: missing required field "${field}"`);
        ok = false;
      }
    }

    if (typeof parsed.host === "string" && parsed.host !== "" && parsed.host !== host) {
      errors.push(`${host}: host field is "${parsed.host}" but the file is ${host}.yml`);
      ok = false;
    }

    if (ok) profiles[host] = parsed;
  }

  return { hosts: PROFILE_HOSTS.filter((host) => host in profiles), profiles, errors };
}

/**
 * Derive the install command and the assertion list for one profile.
 *
 * Pure: no filesystem or process access, so it can be unit tested and reused by both
 * the host CLI and the in-container CLI.
 *
 * @param {Record<string, string>} profile
 * @param {{home?: string, root?: string}} [opts]
 */
export function buildChecks(profile, opts = {}) {
  const home = opts.home ?? defaultHome();
  const root = opts.root ?? REPO_ROOT;
  const host = profile.host;

  const dest = join(home, profile.target_dir);
  const entryPath = join(dest, profile.skill_entry);
  const skillMdPath = join(dest, "SKILL.md");
  const wrapperPath = join(dest, profile.wrapper);
  const installerPath = join(root, profile.installer);

  const installEnv = {
    TASKPANEL_TARGET_HOME: home,
    // Link, not copy: the skill wrapper resolves the CLI relative to itself.
    TASKPANEL_LINK: "1",
    TASKPANEL_FORCE: "1",
  };

  return {
    host,
    home,
    root,
    dest,
    entryPath,
    skillMdPath,
    wrapperPath,
    installerPath,
    install: {
      command: "bash",
      args: [installerPath],
      env: installEnv,
    },
    assertions: [
      {
        kind: "pathExists",
        name: `${host}: ${profile.skill_entry} installed`,
        path: entryPath,
      },
      {
        kind: "skillFrontmatter",
        name: `${host}: SKILL.md frontmatter name: ${SKILL_NAME}`,
        path: skillMdPath,
        field: "name",
        value: SKILL_NAME,
      },
      {
        kind: "wrapperVersion",
        name: `${host}: ${profile.wrapper} --version == ${VERSION}`,
        command: process.execPath,
        args: [wrapperPath, "--version"],
        env: installEnv,
        expectedStdout: VERSION,
      },
    ],
  };
}

/**
 * Run the install command for one profile.
 *
 * @param {ReturnType<typeof buildChecks>} checks
 */
function install(checks) {
  return spawnSync(checks.install.command, checks.install.args, {
    encoding: "utf8",
    env: { ...process.env, ...checks.install.env },
  });
}

/**
 * Evaluate one assertion. Returns `{ok, detail}`.
 *
 * @param {object} assertion
 */
async function evaluate(assertion) {
  switch (assertion.kind) {
    case "pathExists": {
      const ok = existsSync(assertion.path);
      return { ok, detail: ok ? assertion.path : `not found: ${assertion.path}` };
    }
    case "skillFrontmatter": {
      let text;
      try {
        text = await readFile(assertion.path, "utf8");
      } catch (err) {
        return { ok: false, detail: `unreadable: ${err.message}` };
      }
      const actual = readFrontmatterField(text, assertion.field);
      const ok = actual === assertion.value;
      return { ok, detail: `${assertion.field}: ${actual ?? "<missing>"}` };
    }
    case "wrapperVersion": {
      const res = spawnSync(assertion.command, assertion.args, {
        encoding: "utf8",
        env: { ...process.env, ...assertion.env },
      });
      if (res.error) return { ok: false, detail: `spawn failed: ${res.error.message}` };
      const actual = (res.stdout ?? "").trim();
      const ok = res.status === 0 && actual === assertion.expectedStdout;
      return { ok, detail: `exit ${res.status}, stdout ${JSON.stringify(actual)}` };
    }
    default:
      return { ok: false, detail: `unknown assertion kind: ${assertion.kind}` };
  }
}

/**
 * Install every profile into `home` and verify the result.
 *
 * @param {{home?: string, profilesDir?: string, root?: string, quiet?: boolean, log?: (line: string) => void}} [opts]
 * @returns {Promise<{ok: boolean, home: string, profilesDir: string, errors: string[], results: Array<object>}>}
 */
export async function runProfiles(opts = {}) {
  const home = opts.home ?? defaultHome();
  const profilesDir = opts.profilesDir ?? join(REPO_ROOT, "docker", "profiles");
  const root = opts.root ?? REPO_ROOT;
  const log = opts.quiet ? () => {} : opts.log ?? ((line) => process.stdout.write(`${line}\n`));

  const { profiles, errors } = await loadProfiles(profilesDir);
  const results = [];

  if (errors.length > 0) {
    for (const error of errors) log(`profiles: ${error}`);
    return { ok: false, home, profilesDir, errors, results };
  }

  await mkdir(home, { recursive: true });

  for (const host of PROFILE_HOSTS) {
    const checks = buildChecks(profiles[host], { home, root });
    const steps = [];

    const installed = install(checks);
    const installOk = !installed.error && installed.status === 0;
    steps.push({
      name: `${host}: install`,
      ok: installOk,
      detail: installOk
        ? (installed.stdout ?? "").trim() || "installed"
        : installed.error?.message || (installed.stderr ?? "").trim() || `exit ${installed.status}`,
    });

    if (installOk) {
      for (const assertion of checks.assertions) {
        const { ok, detail } = await evaluate(assertion);
        steps.push({ name: assertion.name, ok, detail });
      }
    }

    const ok = steps.every((step) => step.ok);
    results.push({
      host,
      profile: profiles[host],
      dest: checks.dest,
      home,
      ok,
      error: ok ? null : (steps.find((step) => !step.ok)?.detail ?? "failed"),
      steps,
    });

    for (const step of steps) {
      log(`${step.ok ? "ok  " : "FAIL"} ${step.name}${step.ok ? "" : ` — ${step.detail}`}`);
    }
  }

  return { ok: results.every((r) => r.ok), home, profilesDir, errors, results };
}
