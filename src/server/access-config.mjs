/**
 * The board's **access policy**, persisted beside the token (`taskd.env`).
 *
 * Why a file and not a table: the policy is server configuration, not board
 * data. `taskd` needs it before it serves a request (and before the first
 * remote caller is judged), exactly like `TASKD_ALLOW_CIDRS`; the token already
 * lives in the same directory under the same 0600 rule. Saving through the
 * Access panel therefore writes an env file, never a database row.
 *
 * The file is the panel's own format — `KEY=VALUE`, one pair per line:
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
 *   2. `<dataDir>/taskd.env` — `source: "file"`.
 *   3. the defaults — allow-list **off**, seeded with the two private ranges
 *      (`source: "default"`). Off is deliberately the safe upgrade: an existing
 *      board keeps serving its LAN until someone turns the list on.
 *
 * The CIDR syntax is the server's own (`cidr.mjs`), so the panel cannot write a
 * range the request path would parse differently.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ensureDir } from "../core/index.mjs";
import { mergeEnvText, parseEnvBool, parseEnvText } from "../shared/env-file.mjs";
import { ALLOW_CIDRS_ENV, SECRET_DIR_MODE, SECRET_FILE_MODE } from "../shared/constants.mjs";
import { DomainError } from "../shared/errors.mjs";
import { redactText } from "../shared/redact.mjs";
import { parseAllowList, parseCidr } from "./cidr.mjs";

/** The env-file key for the allow-list master switch. */
export const ALLOW_LIST_ENABLED_ENV = "TASKD_ALLOW_LIST_ENABLED";

/** The file name beside `token` and the database. */
export const ACCESS_ENV_FILE = "taskd.env";

/** The two ranges the panel seeds when no policy has been saved. */
export const DEFAULT_ALLOW_CIDRS = Object.freeze(["192.168.0.0/16", "10.0.0.0/8"]);

/** At most this many entries may be saved (a hand-typed list, not a firewall). */
export const MAX_ALLOW_CIDRS = 64;
/** One entry's maximum length; a CIDR is never near this. */
const MAX_CIDR_LENGTH = 64;

/** @param {string} dataDir */
export function accessEnvPath(dataDir) {
  return join(dataDir, ACCESS_ENV_FILE);
}

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
 * @param {{dataDir: string, env?: NodeJS.ProcessEnv, allowCidrs?: string}} input
 * @returns {{enabled: boolean, cidrs: string[], source: "env"|"file"|"default", file: string|null, invalid?: string[]}}
 */
export function readAccessConfig(input) {
  const { dataDir, env = process.env, allowCidrs } = input;
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

  const file = accessEnvPath(dataDir);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { enabled: false, cidrs: [...DEFAULT_ALLOW_CIDRS], source: "default", file };
    }
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `cannot read the access configuration: ${redactText(err.message)}`,
      details: { file },
      cause: err,
    });
  }

  const values = parseEnvText(text, { strict: true });
  const rawCidrs = values.get(ALLOW_CIDRS_ENV);
  const entries = rawCidrs === undefined ? [] : splitCidrs(rawCidrs);
  const cidrs = [];
  for (const entry of entries) {
    if (entry.length > MAX_CIDR_LENGTH || parseCidr(entry) === null) {
      throw new DomainError("ACCESS_CONFIG_INVALID", {
        message: `${JSON.stringify(entry)} in ${file} is not a valid CIDR range`,
        details: { file, entry },
      });
    }
    if (!cidrs.includes(entry)) cidrs.push(entry);
  }
  // The master switch is explicit in files this panel writes. A hand-written
  // file that only names ranges keeps the historic meaning: a list present ⇒
  // the list is in force.
  const enabled = values.has(ALLOW_LIST_ENABLED_ENV)
    ? parseBoolean(values.get(ALLOW_LIST_ENABLED_ENV), ALLOW_LIST_ENABLED_ENV)
    : entries.length > 0;

  if (cidrs.length > MAX_ALLOW_CIDRS) {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `${file} holds more than ${MAX_ALLOW_CIDRS} ranges`,
      details: { file },
    });
  }
  return { enabled, cidrs, source: "file", file };
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
 * Persist a validated policy to `<dataDir>/taskd.env`, atomically.
 *
 * @param {{dataDir: string, enabled: boolean, cidrs: string[]}} input
 * @returns {{enabled: boolean, cidrs: string[], source: "file", file: string}}
 */
export function writeAccessConfig(input) {
  const { dataDir, enabled, cidrs } = input;
  if (typeof enabled !== "boolean") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "allow_list.enabled must be a boolean",
      details: { field: "allow_list.enabled" },
    });
  }
  const ranges = validateCidrs(cidrs);
  const file = writeEnvKeys(dataDir, {
    [ALLOW_LIST_ENABLED_ENV]: enabled ? "true" : "false",
    [ALLOW_CIDRS_ENV]: ranges.join(","),
  });
  return { enabled, cidrs: ranges, source: "file", file };
}

/**
 * Persist one or more keys into `<dataDir>/taskd.env`, **merging** with what is
 * already there.
 *
 * The file is shared by independent settings — the access policy
 * (`TASKD_ALLOW_CIDRS`) and the acceptance policy
 * (`TASKD_ACCEPTANCE_POLICY`) — so a whole-file rewrite by one writer would
 * silently erase the other's answer. Unknown lines (including an operator's
 * comments) are preserved; a key in `patch` is replaced in place (the last
 * occurrence wins, and earlier duplicates are dropped), and new keys are
 * appended.
 *
 * @param {string} dataDir
 * @param {Record<string, string>} patch
 * @returns {string} the file written
 */
export function writeEnvKeys(dataDir, patch) {
  if (patch === null || typeof patch !== "object") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "taskd.env patch must be an object of KEY=VALUE strings",
      details: { field: "patch" },
    });
  }
  ensureDir(dataDir, { mode: SECRET_DIR_MODE });
  const file = accessEnvPath(dataDir);

  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new DomainError("ACCESS_CONFIG_INVALID", {
        message: `cannot read the access configuration: ${redactText(err.message)}`,
        details: { file },
        cause: err,
      });
    }
  }

  // A file created for the first time gets the panel's header, so a reader knows
  // who writes it. A pre-existing hand-written file keeps its own lines
  // (comments included) and only gains the new key.
  const header =
    existing === ""
      ? "# Meerkat TaskPanel board configuration — written by the Access panel and install.sh.\n" +
        "# taskd reads this file; the acceptance policy is re-read on every decision.\n"
      : "";
  writeAtomic(file, header + mergeEnvText(existing, patch));
  return file;
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
      message: `could not write the access configuration: ${redactText(err.message)}`,
      details: { file },
      cause: err,
    });
  }
}
