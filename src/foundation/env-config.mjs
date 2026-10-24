/**
 * The one client/server config file: `<program root>/.env`.
 *
 * Both `taskd` and `taskctl` read it, and the process environment wins key by
 * key. The loader is the *only* place that decides precedence; every existing
 * resolver keeps its own internal order (`--url` > `TASKD_URL` > pointer,
 * `--token` > `TASKD_TOKEN` > token file, …).
 *
 * Two rules keep a root `.env` safe to share with other tools:
 *
 *   - only {@link CLIENT_CONFIG_KEYS} are merged into the effective environment;
 *     `PATH`, `NODE_OPTIONS`, `VITE_*` and anything else stay where they were;
 *   - a key in one of *our* namespaces that we do not know is an error (a typo
 *     such as `TASKD_URLL` must not silently do nothing), while an external key
 *     is ignored.
 *
 * The parser is deliberately the simple `KEY=VALUE` subset of
 * `src/foundation/env-file.mjs`: no inline comments, interpolation, escapes or
 * multiline values. A comment line starts with `#`; matching quotes are
 * stripped; `export ` is accepted.
 *
 * Pure text parsing lives in `env-file.mjs`; this module is the only one that
 * touches the filesystem for configuration.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  CLIENT_CONFIG_KEYS,
  CONFIG_NAMESPACES,
  ENV_FILE_ENV,
  NO_AUTOSTART_ENV,
  PORT_ENV,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  URL_ENV,
} from "./constants.mjs";
import { parseEnvBool, parseEnvText } from "./env-file.mjs";
import { DomainError } from "./errors.mjs";
import { isSlaEnvKey, parseSlaEnvValue, readSlaConfig } from "./sla-config.mjs";
import { resolveEnvFilePath } from "./runtime-locator.mjs";
import { normalizeBoardUrl } from "./transport/board-url.mjs";
import { isTokenShape } from "./transport/token.mjs";

const ALLOWED = new Set(CLIENT_CONFIG_KEYS);

/** @param {string} message @param {object} [details] */
function configError(message, details = {}) {
  return new DomainError("CONFIG_FILE_INVALID", { message, details });
}

/** @param {string} key */
function inOurNamespace(key) {
  return CONFIG_NAMESPACES.some((prefix) => key.startsWith(prefix));
}

/** @param {string} key */
function unknownKeyMessage(key) {
  if (key === "TASKCTL_ACTOR_KIND" || key === "TASKCTL_SESSION_ID") {
    return `${key} is identity, not install-wide configuration: pass it per agent kind (the shim / harness settings) or per invocation`;
  }
  if (key === ENV_FILE_ENV) {
    return `${ENV_FILE_ENV} selects this file and cannot be set inside it`;
  }
  if (key.startsWith("MEERKAT_TASKPANEL_")) {
    return `${key} is loop policy and belongs in <agent-dir>/meerkat-taskpanel.env, not the shared .env`;
  }
  return `unknown configuration key "${key}"`;
}

/** @param {number} mode */
function octal(mode) {
  return mode.toString(8).padStart(4, "0");
}

/**
 * Parse the file's text, before key validation.
 *
 * `parseEnvText` alone is too lenient for this file (it would skip a stray
 * line), and its `strict` mode raises the server's `ACCESS_CONFIG_INVALID` and
 * can echo the raw line — which may be a token. This pre-scan reports only the
 * line number.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvConfig(text) {
  const clean = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) {
      throw configError(`the configuration file has a line that is not KEY=VALUE (line ${index + 1})`);
    }
    const key = line.slice(0, equals).trim().replace(/^export\s+/, "");
    if (key === "") {
      throw configError(`the configuration file has an empty key (line ${index + 1})`);
    }
    if (seen.has(key)) {
      throw configError(`the configuration file repeats "${key}" (line ${index + 1})`, { key });
    }
    seen.add(key);
  }
  return parseEnvText(clean, { quoteMinLength: 2 });
}

/**
 * Re-read one `KEY=VALUE` map from an env file, leniently.
 *
 * A per-request resolver (the SLA policy) needs the file's values *now* — a
 * hand edit must apply without restarting `taskd` — but must not repeat the
 * strict startup pre-scan on every request: a malformed line added by hand
 * costs that request, not the process. A missing file is an empty map; an
 * unreadable one is still an error.
 *
 * @param {string|null} envFile
 * @returns {Map<string,string>}
 */
export function readConfigFileVars(envFile) {
  if (typeof envFile !== "string" || envFile === "") return new Map();
  let text;
  try {
    text = readFileSync(envFile, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return new Map();
    throw configError(`cannot read the configuration file: ${err?.message ?? String(err)}`, {
      file: envFile,
    });
  }
  return parseEnvText(text, { quoteMinLength: 2 });
}

/** @param {string} key @param {string} value */
function validateValue(key, value) {
  // `TASKD_SLA_*` values are integers with per-key ranges; `sla-config.mjs`
  // owns the rules, and raises `CONFIG_FILE_INVALID` with the key in `details`.
  if (isSlaEnvKey(key)) return String(parseSlaEnvValue(key, value));
  switch (key) {
    case URL_ENV:
      return normalizeBoardUrl(value);
    case TOKEN_ENV: {
      const token = value.trim();
      if (!isTokenShape(token)) {
        throw configError(`${TOKEN_ENV} in the configuration file is not a td_… token`, { key });
      }
      return token;
    }
    case TOKEN_FILE_ENV: {
      const file = value.trim();
      if (file === "") throw configError(`${TOKEN_FILE_ENV} is empty`, { key });
      return file;
    }
    case NO_AUTOSTART_ENV:
      if (parseEnvBool(value) === null) {
        throw configError(`${NO_AUTOSTART_ENV} must be true or false`, { key });
      }
      return value;
    case PORT_ENV: {
      const text = value.trim();
      if (!/^\d+$/.test(text) || Number(text) > 65535) {
        throw configError(`${PORT_ENV} must be an integer 0–65535`, { key });
      }
      return text;
    }
    case "TASKD_ALLOW_CIDRS":
      // An explicit empty list is meaningful: enabled + empty = deny all.
      return value;
    case "TASKD_ALLOW_LIST_ENABLED":
      if (parseEnvBool(value) === null) {
        throw configError(`${key} must be true or false`, { key });
      }
      return value;
    case "TASKD_ACCEPTANCE_POLICY":
      // 0038 — retired. Acceptance is board data now (`projects.acceptance` and
      // each card's `acceptance_mode`); silently ignoring a configured rule
      // would upgrade an operator into a different closing rule than they asked
      // for, so the config file is refused with the migration to run.
      throw configError(
        `${key} is retired; set the project default instead ` +
          "(`taskctl project update <id> --acceptance human|agent|off|auto`)",
        { key },
      );
    default: {
      const text = value.trim();
      if (text === "") throw configError(`${key} is empty`, { key });
      return text;
    }
  }
}

/**
 * Drop external keys and validate ours.
 * @param {Map<string, string>} raw
 * @returns {Map<string, string>}
 */
function validateVars(raw) {
  const vars = new Map();
  for (const [key, value] of raw) {
    if (!ALLOWED.has(key)) {
      if (inOurNamespace(key)) throw configError(unknownKeyMessage(key), { key });
      continue;
    }
    vars.set(key, validateValue(key, value));
  }
  if (vars.has(TOKEN_ENV) && vars.has(TOKEN_FILE_ENV)) {
    throw configError(`the configuration file sets both ${TOKEN_ENV} and ${TOKEN_FILE_ENV}; keep exactly one`, {
      keys: [TOKEN_ENV, TOKEN_FILE_ENV],
    });
  }
  // Cross-field SLA rules (a further bound below its normal limit) need the
  // whole file at once; per-key range checks ran in `validateValue` above.
  readSlaConfig({ envVars: vars });
  return vars;
}

/**
 * A file that carries an inline token is a secret file.
 * @param {string} file @param {Function} statFile @param {string} platform
 */
function assertInlineTokenMode(file, statFile, platform) {
  if (platform === "win32") return; // POSIX mode bits are synthetic there.
  let mode;
  try {
    mode = statFile(file).mode & 0o777;
  } catch {
    return; // readFile succeeded above; a transient stat failure is not a reason to fail.
  }
  if ((mode & 0o077) !== 0) {
    throw new DomainError("CONFIG_FILE_INSECURE", {
      message: `the configuration file contains an inline token but is accessible by other users (mode ${octal(mode)})`,
      details: { file, mode: octal(mode), required: "0600" },
      hint: { fix: `chmod 600 ${file}` },
    });
  }
}

/**
 * Where the token file lives.
 *
 * The process environment's value wins over the file's (the same precedence as
 * every other key). A file-sourced relative path is resolved beside the config
 * file, so the pair is relocatable; an environment-sourced one against `cwd`,
 * exactly as the shell wrote it.
 *
 * @param {Map<string, string>} vars
 * @param {NodeJS.ProcessEnv} env
 * @param {string} file
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveTokenFile(vars, env, file, cwd) {
  const fromEnv = env[TOKEN_FILE_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(cwd, fromEnv.trim());
  if (vars.has(TOKEN_FILE_ENV)) return resolve(dirname(file), vars.get(TOKEN_FILE_ENV));
  return null;
}

/**
 * Merge the file under the process environment.
 *
 * A process value that is present but blank does not shadow a file value: every
 * resolver treats whitespace as absent, and an empty export in a shell should
 * not silently disable the file.
 *
 * @param {Map<string, string>} vars
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function mergeEnv(vars, env) {
  const out = { ...env };
  for (const [key, value] of vars) {
    const current = env[key];
    if (typeof current === "string" && current.trim() !== "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Load the config file and return the effective environment.
 *
 * @param {{
 *   flag?: string|null, root?: string, env?: NodeJS.ProcessEnv, cwd?: string,
 *   readFile?: (file: string) => string, statFile?: (file: string) => {mode: number},
 *   platform?: string,
 * }} [options]
 * @returns {{file: string, vars: Map<string, string>, env: NodeJS.ProcessEnv, source: "flag"|"env"|"default"|"none", present: boolean, tokenFile: string|null}}
 */
export function loadEnvFile(options = {}) {
  const {
    flag = null,
    root,
    env = process.env,
    cwd = process.cwd(),
    readFile = (file) => readFileSync(file, "utf8"),
    statFile = (file) => statSync(file),
    platform = process.platform,
  } = options;

  const namedByFlag = typeof flag === "string" && flag.trim() !== "";
  const namedByEnv = typeof env[ENV_FILE_ENV] === "string" && env[ENV_FILE_ENV].trim() !== "";
  const named = namedByFlag || namedByEnv;
  const source = namedByFlag ? "flag" : namedByEnv ? "env" : "default";
  const file = namedByFlag
    ? resolve(cwd, flag.trim())
    : resolveEnvFilePath({ root, env, cwd });

  let text;
  try {
    text = readFile(file);
  } catch (err) {
    // `--env-file` is an explicit instruction, so a missing file is an error. The
    // environment variable is a *location* a deployment names up front (a
    // container's data volume before the first save), so absence there is the
    // same "no configuration" as a missing default: the Access panel creates the
    // file when it first writes.
    if (err?.code === "ENOENT" && !namedByFlag) {
      return { file, vars: new Map(), env: { ...env }, source: "none", present: false, tokenFile: null };
    }
    throw configError(`cannot read the configuration file ${file}: ${err?.code ?? err?.message ?? String(err)}`, {
      file,
      ...(namedByFlag ? { source } : {}),
    });
  }

  const vars = validateVars(parseEnvConfig(text));
  if (vars.has(TOKEN_ENV)) assertInlineTokenMode(file, statFile, platform);

  const tokenFile = resolveTokenFile(vars, env, file, cwd);
  const effectiveEnv = mergeEnv(vars, env);
  if (tokenFile !== null) effectiveEnv[TOKEN_FILE_ENV] = tokenFile;

  return { file, vars, env: effectiveEnv, source, present: true, tokenFile };
}
