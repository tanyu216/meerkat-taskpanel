/**
 * Resolve the board's **acceptance policy** (`human-only` | `both` |
 * `agent-only`) from the same places every other piece of board configuration
 * comes from.
 *
 * The policy is server/board configuration, not board data, so — like
 * `TASKD_ALLOW_CIDRS` — it lives in `<dataDir>/taskd.env`. The panel/installer
 * writes it there; the command layer reads it **on each acceptance decision**
 * rather than caching it at start-up, which is what lets a re-install or a
 * hand-edit take effect without a `taskd` restart.
 *
 * Precedence, in order:
 *
 *   1. an explicit `openBoard({acceptancePolicy})` — the tests' and an
 *      embedding caller's override;
 *   2. the process environment (`TASKD_ACCEPTANCE_POLICY`) — an operator's
 *      override, and the value an installer forwards;
 *   3. `<dataDir>/taskd.env`;
 *   4. {@link DEFAULT_ACCEPTANCE_POLICY} (`both`).
 *
 * An **invalid** configured value is refused rather than ignored: a board whose
 * policy cannot be read must not quietly fall back to a different rule than the
 * one the operator asked for. `ACCESS_CONFIG_INVALID` is the same code the
 * access policy's own reader raises, because it is the same file.
 *
 * The module is core (not `src/server`) so the commands can use it without
 * inverting the layering (`server -> core -> shared`); it touches only `node:fs`
 * to read the one file.
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

import { SECRET_DIR_MODE, SECRET_FILE_MODE } from "../shared/constants.mjs";
import { mergeEnvText } from "../shared/env-file.mjs";
import { DomainError } from "../shared/errors.mjs";
import {
  ACCEPTANCE_POLICIES,
  DEFAULT_ACCEPTANCE_POLICY,
  normalizeAcceptancePolicy,
} from "./domain/status.mjs";

/** The env-file key the installer and the panel write. */
export const ACCEPTANCE_POLICY_ENV = "TASKD_ACCEPTANCE_POLICY";

/** The file name, beside the token and the database (`ACCESS_ENV_FILE`). */
export const ACCEPTANCE_ENV_FILE = "taskd.env";

/** @param {string} dataDir */
export function acceptanceEnvPath(dataDir) {
  return join(dataDir, ACCEPTANCE_ENV_FILE);
}

/**
 * Read one key from a `KEY=VALUE` file, leniently.
 *
 * The file is shared with the access policy, so a malformed *other* line is the
 * access reader's finding, not ours; only the key we are asked about matters.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
function readEnvKey(text, key) {
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const name = line.slice(0, equals).trim().replace(/^export\s+/, "");
    if (name !== key) continue;
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
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
 * @param {{dataDir?: string|null, env?: NodeJS.ProcessEnv, acceptancePolicy?: string|null}} input
 * @returns {{policy: string, source: "explicit"|"env"|"file"|"default"}}
 */
export function readAcceptancePolicy(input = {}) {
  const { dataDir = null, env = process.env, acceptancePolicy } = input;
  if (acceptancePolicy !== undefined && acceptancePolicy !== null && acceptancePolicy !== "") {
    return { policy: parse(acceptancePolicy, "explicit option"), source: "explicit" };
  }
  const fromEnv = env?.[ACCEPTANCE_POLICY_ENV];
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== "") {
    return { policy: parse(fromEnv, "process environment"), source: "env" };
  }
  if (dataDir === null) return { policy: DEFAULT_ACCEPTANCE_POLICY, source: "default" };
  const file = acceptanceEnvPath(dataDir);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { policy: DEFAULT_ACCEPTANCE_POLICY, source: "default" };
    throw new DomainError("ACCESS_CONFIG_INVALID", {
      message: `cannot read ${file}: ${err?.message ?? String(err)}`,
      details: { file },
      cause: err,
    });
  }
  const raw = readEnvKey(text, ACCEPTANCE_POLICY_ENV);
  if (raw === null || raw.trim() === "") return { policy: DEFAULT_ACCEPTANCE_POLICY, source: "default" };
  return { policy: parse(raw, file), source: "file" };
}

/**
 * A resolver bound to one board — the function `createContext` carries.
 *
 * @param {{dataDir?: string|null, env?: NodeJS.ProcessEnv, acceptancePolicy?: string|null}} [options]
 * @returns {() => string} the policy, re-read on each call
 */
export function createAcceptancePolicy(options = {}) {
  return () => readAcceptancePolicy(options).policy;
}

/**
 * Persist the policy into `<dataDir>/taskd.env`, **merging** with the access
 * policy's keys rather than rewriting the file.
 *
 * @param {{dataDir: string, policy: string}} input
 * @returns {{policy: string, file: string}}
 */
export function writeAcceptancePolicy(input) {
  const { dataDir } = input;
  const policy = normalizeAcceptancePolicy(input.policy);
  if (policy === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `acceptance policy must be one of ${ACCEPTANCE_POLICIES.join(" | ")} ` +
        `(got ${JSON.stringify(input.policy)})`,
      details: { field: "acceptance", received: input.policy, allowed: [...ACCEPTANCE_POLICIES] },
    });
  }

  const file = acceptanceEnvPath(dataDir);
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new DomainError("ACCESS_CONFIG_INVALID", {
        message: `cannot read ${file}: ${err?.message ?? String(err)}`,
        details: { file },
        cause: err,
      });
    }
  }
  const text = mergeEnvText(existing, { [ACCEPTANCE_POLICY_ENV]: policy });
  writeAtomic(file, text);
  return { policy, file };
}

/** Atomic 0600 write with a temporary file in the same directory. */
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
