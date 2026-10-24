/**
 * The board's **access policy**, persisted in the install-root `.env`.
 *
 * Why a file and not a table: the policy is server configuration, not board
 * data. `taskd` needs it before it serves a request (and before the first
 * remote caller is judged), exactly like `TASKD_ALLOW_CIDRS`. Saving through the
 * Access panel therefore writes the shared config file, never a database row —
 * and that file is also where the client's board URL, token and the acceptance
 * policy live.
 *
 * The file format is the simple `KEY=VALUE` subset documented in
 * `src/foundation/env-config.mjs`:
 *
 *   TASKD_ALLOW_LIST_ENABLED=false
 *   TASKD_ALLOW_CIDRS=192.168.0.0/16,10.0.0.0/8
 *
 * Precedence, in order:
 *
 *   1. an explicit `options.allowCidrs` (tests) or the process environment
 *      (`TASKD_ALLOW_CIDRS` / `TASKD_ALLOW_LIST_ENABLED`) — an operator's
 *      override. `source: "env"`; the panel is read-only, because a save would
 *      be silently undone by the next process start.
 *   2. the `.env` values, already parsed by `src/foundation/env-config.mjs`
 *      (`envVars`) — `source: "file"`.
 *   3. the defaults — allow-list **off**, seeded with the two private ranges
 *      (`source: "default"`). Off is deliberately the safe upgrade: an existing
 *      board keeps serving its LAN until someone turns the list on.
 *
 * The CIDR syntax is the server's own (`cidr.mjs`), so the panel cannot write a
 * range the request path would parse differently.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { mergeEnvText, parseEnvBool } from "../foundation/env-file.mjs";
import { ALLOW_CIDRS_ENV, SECRET_DIR_MODE, SECRET_FILE_MODE } from "../foundation/constants.mjs";
import { DomainError } from "../foundation/errors.mjs";
import { redactText } from "../foundation/redact.mjs";
import { parseAllowList, parseCidr } from "./cidr.mjs";

/** The env-file key for the allow-list master switch. */
export const ALLOW_LIST_ENABLED_ENV = "TASKD_ALLOW_LIST_ENABLED";

/** The two ranges the panel seeds when no policy has been saved. */
export const DEFAULT_ALLOW_CIDRS = Object.freeze(["192.168.0.0/16", "10.0.0.0/8"]);

/** At most this many entries may be saved (a hand-typed list, not a firewall). */
export const MAX_ALLOW_CIDRS = 64;
/** One entry's maximum length; a CIDR is never near this. */
const MAX_CIDR_LENGTH = 64;

/** @param {string} value @param {string} key */
function parseBoolean(value, key) {
  const parsed = parseEnvBool(value);
  if (parsed === null) {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `${key} must be true or false, not ${JSON.stringify(value)}`,
    });
  }
  return parsed;
}

/** Split a comma/space/semicolon separated CIDR list. @param {string} value */
function splitCidrs(value) {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Read one key from the parsed `.env` values (a `Map`, or a plain object for
 * embedders). `undefined` means "not configured"; an explicit empty string is
 * still "configured" (`TASKD_ALLOW_CIDRS=` is the deny-all spelling).
 *
 * @param {Map<string,string>|Record<string,string>|null|undefined} vars
 * @param {string} key
 * @returns {string|undefined}
 */
function readVar(vars, key) {
  if (vars === null || vars === undefined) return undefined;
  if (typeof vars.get === "function") return vars.has(key) ? vars.get(key) : undefined;
  return Object.hasOwn(vars, key) ? vars[key] : undefined;
}

/**
 * Validate and normalise a list the panel is about to save.
 *
 * An invalid entry is refused rather than dropped: a typo in an allow-list is
 * the one mistake that can silently widen access.
 *
 * @param {unknown} value
 * @returns {string[]} trimmed, de-duplicated, order preserved
 */
export function validateCidrs(value) {
  if (!Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "allow_list.cidrs must be an array of CIDR strings",
      details: { field: "allow_list.cidrs" },
    });
  }
  if (value.length > MAX_ALLOW_CIDRS) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `an allow-list may hold at most ${MAX_ALLOW_CIDRS} ranges`,
      details: { field: "allow_list.cidrs", limit: MAX_ALLOW_CIDRS },
    });
  }
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new DomainError("VALIDATION_FAILED", {
        message: "every allow-list entry must be a string",
        details: { field: "allow_list.cidrs" },
      });
    }
    const text = entry.trim();
    if (text === "") {
      throw new DomainError("VALIDATION_FAILED", {
        message: "an allow-list entry is empty",
        details: { field: "allow_list.cidrs" },
      });
    }
    if (text.length > MAX_CIDR_LENGTH || parseCidr(text) === null) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `${JSON.stringify(text)} is not a valid CIDR range`,
        details: { field: "allow_list.cidrs", entry: text },
      });
    }
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/**
 * Read the policy in force.
 *
 * `env` is the **process** environment, not the merged one: a value from
 * `.env` must stay distinguishable so the panel can edit it. `envVars` is the
 * parsed `.env` map; `envFile` is only the path reported in `config_file`.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv, envFile?: string|null,
 *   envVars?: Map<string,string>|Record<string,string>|null,
 *   allowCidrs?: string,
 * }} input
 * @returns {{enabled: boolean, cidrs: string[], source: "env"|"file"|"default", file: string|null, invalid?: string[]}}
 */
export function readAccessConfig(input = {}) {
  const { env = process.env, envFile = null, envVars = null, allowCidrs } = input;
  const envCidrs = allowCidrs !== undefined ? allowCidrs : env[ALLOW_CIDRS_ENV];
  const envEnabled = env[ALLOW_LIST_ENABLED_ENV];

  if (allowCidrs !== undefined || envCidrs !== undefined || envEnabled !== undefined) {
    const parsed = parseAllowList(envCidrs ?? "");
    const enabled = envEnabled !== undefined ? parseBoolean(envEnabled, ALLOW_LIST_ENABLED_ENV) : parsed.configured;
    // An explicitly enabled list with no ranges is a real (and dangerous)
    // setting — deny every remote caller — so it is not replaced by defaults.
    const cidrs = parsed.configured ? parsed.rules.map((rule) => rule.raw) : envCidrs === undefined ? [...DEFAULT_ALLOW_CIDRS] : [];
    return { enabled, cidrs, source: "env", file: null, invalid: parsed.invalid };
  }

  const rawCidrs = readVar(envVars, ALLOW_CIDRS_ENV);
  const rawEnabled = readVar(envVars, ALLOW_LIST_ENABLED_ENV);
  if (rawCidrs === undefined && rawEnabled === undefined) {
    return { enabled: false, cidrs: [...DEFAULT_ALLOW_CIDRS], source: "default", file: envFile };
  }

  const entries = rawCidrs === undefined ? [] : splitCidrs(rawCidrs);
  const cidrs = [];
  for (const entry of entries) {
    if (entry.length > MAX_CIDR_LENGTH || parseCidr(entry) === null) {
      throw new DomainError("ACCESS_CONFIG_INVALID", {
        message: `${JSON.stringify(entry)} in ${envFile ?? "the configuration file"} is not a valid CIDR range`,
        details: { file: envFile, entry },
      });
    }
    if (!cidrs.includes(entry)) cidrs.push(entry);
  }
  // The master switch is explicit in files this panel writes. A hand-written
  // file that only names ranges keeps the historic meaning: a list present ⇒
  // the list is in force.
  const enabled = rawEnabled !== undefined ? parseBoolean(rawEnabled, ALLOW_LIST_ENABLED_ENV) : entries.length > 0;

  if (cidrs.length > MAX_ALLOW_CIDRS) {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `${envFile ?? "the configuration file"} holds more than ${MAX_ALLOW_CIDRS} ranges`,
      details: { file: envFile },
    });
  }
  return { enabled, cidrs, source: "file", file: envFile };
}

/**
 * Derive the parsed policy `auth.mjs` consumes.
 *
 * `enabled: false` means "no list" ⇒ every address is allowed, which is the
 * only honest way to say the switch is off.
 *
 * @param {{enabled: boolean, cidrs: string[]}} config
 * @returns {{configured: boolean, rules: object[], invalid: string[]}}
 */
export function allowListFrom(config) {
  if (!config.enabled) return parseAllowList("");
  // An **enabled list with no ranges** is a deliberate, narrow setting: deny
  // every remote caller. `parseAllowList("")` would say "no list was given" and
  // allow everyone, so the configured-empty form is stated explicitly.
  if (config.cidrs.length === 0) return { configured: true, rules: [], invalid: [] };
  return parseAllowList(config.cidrs.join(","));
}

/**
 * Persist a validated policy into the install-root `.env`, atomically.
 *
 * @param {{envFile: string, enabled: boolean, cidrs: string[]}} input
 * @returns {{enabled: boolean, cidrs: string[], source: "file", file: string}}
 */
export function writeAccessConfig(input) {
  const { envFile, enabled, cidrs } = input;
  if (typeof envFile !== "string" || envFile === "") {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: "no config file is configured for this board",
      details: { field: "envFile" },
    });
  }
  if (typeof enabled !== "boolean") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "allow_list.enabled must be a boolean",
      details: { field: "allow_list.enabled" },
    });
  }
  const ranges = validateCidrs(cidrs);
  const file = writeEnvKeys(envFile, {
    [ALLOW_LIST_ENABLED_ENV]: enabled ? "true" : "false",
    [ALLOW_CIDRS_ENV]: ranges.join(","),
  });
  return { enabled, cidrs: ranges, source: "file", file };
}

/**
 * Persist one or more keys into the install-root `.env`, **merging** with what
 * is already there.
 *
 * The file is shared by independent settings — the access policy
 * (`TASKD_ALLOW_CIDRS`) and the client's board URL/token — so a whole-file
 * rewrite by one writer would
 * silently erase the others. Unknown lines (including an operator's comments)
 * are preserved; a key in `patch` is replaced in place and new keys are
 * appended.
 *
 * The parent directory is created only when missing and is **never** chmodded:
 * it is the install root, not a secrets directory.
 *
 * @param {string} envFile
 * @param {Record<string, string>} patch
 * @returns {string} the file written
 */
export function writeEnvKeys(envFile, patch) {
  if (typeof envFile !== "string" || envFile === "") {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: "no config file is configured for this board",
      details: { field: "envFile" },
    });
  }
  if (patch === null || typeof patch !== "object") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "config file patch must be an object of KEY=VALUE strings",
      details: { field: "patch" },
    });
  }
  try {
    mkdirSync(dirname(envFile), { recursive: true, mode: SECRET_DIR_MODE });
  } catch (err) {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `cannot create ${dirname(envFile)}: ${redactText(err.message)}`,
      details: { file: envFile },
      cause: err,
    });
  }

  let existing = "";
  try {
    existing = readFileSync(envFile, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new DomainError("ACCESS_CONFIG_INVALID", {
        message: `cannot read the configuration: ${redactText(err.message)}`,
        details: { file: envFile },
        cause: err,
      });
    }
  }

  // A file created for the first time gets the panel's header, so a reader knows
  // who writes it. A pre-existing hand-written file keeps its own lines
  // (comments included) and only gains the new key.
  const header =
    existing === ""
      ? "# Meerkat TaskPanel configuration — written by the Access panel and install.sh.\n" +
        "# Read by taskd and taskctl; the process environment wins key by key.\n"
      : "";
  writeAtomic(envFile, header + mergeEnvText(existing, patch));
  return envFile;
}

/** @param {string} file @param {string} text */
function writeAtomic(file, text) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w", SECRET_FILE_MODE);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, SECRET_FILE_MODE);
    renameSync(tmp, file);
    if ((statSync(file).mode & 0o777) !== SECRET_FILE_MODE) chmodSync(file, SECRET_FILE_MODE);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `could not write the configuration: ${redactText(err.message)}`,
      details: { file },
      cause: err,
    });
  }
}
