/**
 * Resolve the board's **acceptance policy** (`human-only` | `both` |
 * `agent-only`) from the same places every other piece of board configuration
 * comes from.
 *
 * The policy is server/board configuration, not board data, so — like
 * `TASKD_ALLOW_CIDRS` — it lives in the install-root `.env`. The panel and the
 * installer write it there; the command layer reads it **on each acceptance
 * decision** rather than caching it at start-up, which is what lets a re-install
 * or a hand-edit take effect without a `taskd` restart.
 *
 * Precedence, in order:
 *
 *   1. an explicit `openBoard({acceptancePolicy})` — the tests' and an
 *      embedding caller's override;
 *   2. the process environment (`TASKD_ACCEPTANCE_POLICY`) — an operator's
 *      override, and the value an installer forwards;
 *   3. the `.env` values, already parsed by `src/foundation/env-config.mjs`
 *      (`envVars`); `envFile` is only the origin named in an error;
 *   4. {@link DEFAULT_ACCEPTANCE_POLICY} (`both`).
 *
 * An **invalid** configured value is refused rather than ignored: a board whose
 * policy cannot be read must not quietly fall back to a different rule than the
 * one the operator asked for. `ACCESS_CONFIG_INVALID` is the same code the
 * access policy's own reader raises, because it is the same file.
 *
 * The module is core (not `src/server`) so the commands can use it without
 * inverting the layering (`server -> core -> foundation`); it touches only `node:fs`
 * to write the one file.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { SECRET_DIR_MODE, SECRET_FILE_MODE } from "../foundation/constants.mjs";
import { mergeEnvText, parseEnvText } from "../foundation/env-file.mjs";
import { DomainError } from "../foundation/errors.mjs";
import {
  ACCEPTANCE_POLICIES,
  DEFAULT_ACCEPTANCE_POLICY,
  normalizeAcceptancePolicy,
} from "./domain/status.mjs";

/** The config-file key the installer and the panel write. */
export const ACCEPTANCE_POLICY_ENV = "TASKD_ACCEPTANCE_POLICY";

/**
 * Read one key from the parsed `.env` values (a `Map`, or a plain object for
 * embedders). `undefined` means "not configured"; an explicit empty string is
 * still "configured but blank" and is treated as absent, as before.
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
 * Read one key from the file now.
 *
 * The acceptance policy is documented as applying "from the next write" after a
 * re-install or a hand edit, so the bound resolver must not freeze the parsed
 * values at start-up. This read is deliberately lenient about *other* lines
 * (they are the access reader's business); the key it returns is validated by
 * `parse`.
 *
 * @param {string|null} envFile
 * @param {string} key
 * @returns {string|undefined}
 */
function readFileKey(envFile, key) {
  if (typeof envFile !== "string" || envFile === "") return undefined;
  let text;
  try {
    text = readFileSync(envFile, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return undefined;
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `cannot read ${envFile}: ${err?.message ?? String(err)}`,
      details: { file: envFile },
      cause: err,
    });
  }
  return parseEnvText(text).get(key);
}

/** @param {string|null|undefined} raw @param {string} origin */
function parse(raw, origin) {
  const policy = normalizeAcceptancePolicy(raw);
  if (policy === null) {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message:
        `${ACCEPTANCE_POLICY_ENV} is ${JSON.stringify(raw)} (${origin}); ` +
        `expected one of ${ACCEPTANCE_POLICIES.join(" | ")}`,
      details: { key: ACCEPTANCE_POLICY_ENV, received: raw, allowed: [...ACCEPTANCE_POLICIES], origin },
    });
  }
  return policy;
}

/**
 * The policy in force for this board, as `{policy, source}`.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv, envFile?: string|null,
 *   envVars?: Map<string,string>|Record<string,string>|null,
 *   acceptancePolicy?: string|null,
 * }} input
 * @returns {{policy: string, source: "explicit"|"env"|"file"|"default"}}
 */
export function readAcceptancePolicy(input = {}) {
  const { env = process.env, envFile = null, envVars = null, acceptancePolicy } = input;
  if (acceptancePolicy !== undefined && acceptancePolicy !== null && acceptancePolicy !== "") {
    return { policy: parse(acceptancePolicy, "explicit option"), source: "explicit" };
  }
  const fromEnv = env?.[ACCEPTANCE_POLICY_ENV];
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== "") {
    return { policy: parse(fromEnv, "process environment"), source: "env" };
  }
  const raw =
    envVars === null || envVars === undefined
      ? readFileKey(envFile, ACCEPTANCE_POLICY_ENV)
      : readVar(envVars, ACCEPTANCE_POLICY_ENV);
  if (raw === undefined || String(raw).trim() === "") {
    return { policy: DEFAULT_ACCEPTANCE_POLICY, source: "default" };
  }
  return { policy: parse(raw, envFile ?? "configuration file"), source: "file" };
}

/**
 * A resolver bound to one board — the function `createContext` carries.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv, envFile?: string|null,
 *   envVars?: Map<string,string>|Record<string,string>|null,
 *   acceptancePolicy?: string|null,
 * }} [options]
 * @returns {() => string} the policy, re-read on each call
 */
export function createAcceptancePolicy(options = {}) {
  return () => readAcceptancePolicy(options).policy;
}

/**
 * Persist the policy into the install-root `.env`, **merging** with the access
 * policy's keys rather than rewriting the file.
 *
 * @param {{envFile: string, policy: string}} input
 * @returns {{policy: string, file: string}}
 */
export function writeAcceptancePolicy(input) {
  const { envFile } = input;
  if (typeof envFile !== "string" || envFile === "") {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: "no config file is configured for this board",
      details: { field: "envFile" },
    });
  }
  const policy = normalizeAcceptancePolicy(input.policy);
  if (policy === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `acceptance policy must be one of ${ACCEPTANCE_POLICIES.join(" | ")} ` +
        `(got ${JSON.stringify(input.policy)})`,
      details: { field: "acceptance", received: input.policy, allowed: [...ACCEPTANCE_POLICIES] },
    });
  }

  let existing = "";
  try {
    existing = readFileSync(envFile, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new DomainError("ACCESS_CONFIG_INVALID", {
        message: `cannot read ${envFile}: ${err?.message ?? String(err)}`,
        details: { file: envFile },
        cause: err,
      });
    }
  }
  const text = mergeEnvText(existing, { [ACCEPTANCE_POLICY_ENV]: policy });
  writeAtomic(envFile, text);
  return { policy, file: envFile };
}

/**
 * Atomic 0600 write with a temporary file in the same directory.
 *
 * `mkdirSync(..., { recursive: true })` creates a missing parent but does **not**
 * chmod an existing one: the install root is somebody's checkout, not a secrets
 * directory, and the old `ensureDir(dataDir, 0700)` would have made the whole
 * repository private.
 */
function writeAtomic(file, text) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: SECRET_DIR_MODE });
  } catch (err) {
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `cannot create ${dirname(file)}: ${err?.message ?? String(err)}`,
      details: { file },
      cause: err,
    });
  }
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
      message: `could not write ${file}: ${err?.message ?? String(err)}`,
      details: { file },
      cause: err,
    });
  }
}
