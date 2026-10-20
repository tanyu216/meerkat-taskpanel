/**
 * Token redaction — pure string helpers, no Node I/O.
 *
 * Every outward-facing error message, log field and hint in `src/core` funnels
 * through here so an access token can never leak into a response body, a log
 * line or an `Error.stack`. The two call sites that "close the gate" are
 * `storage/sqlite-errors.mjs` and `bootstrap.mjs`.
 */

/** The canonical, fully-formed access token shape (`td_` + 32 random bytes as hex). */
export const TOKEN_PATTERN = /\btd_[0-9a-fA-F]{64}\b/g;

/** Anything that merely looks like a token — keeps near-misses from leaking too. */
export const TOKEN_LIKE_PATTERN = /\btd_[A-Za-z0-9_-]{16,}\b/g;

/** `Authorization: Bearer <anything>` → `Authorization: Bearer td_****`. */
const BEARER_PATTERN = /\b(Bearer\s+)[^\s"',;]+/gi;

/** What a redacted token looks like. Stable — tests and docs assert on it. */
export const REDACTED_TOKEN = "td_****";

/**
 * Keys whose **value** is a secret and must be blanked outright.
 *
 * The pattern matches a key that *ends* in the secret word (`token`,
 * `api_token`, `client_secret`), not one that merely mentions it. That
 * distinction is load-bearing in M2: `token_source` names *where* a token came
 * from (`flag`/`env`/`file`/`none`) and `token_file` is a path — redacting
 * either would turn a diagnostic into `td_****`, which is worse than useless
 * when the whole point is to say "I did not leak the token, and here is which
 * of the four it used".
 */
const SECRET_KEY = /(^|_)(token|secret|password|passwd|authorization|api_key)$/i;

/**
 * Redact every token-shaped substring in `text`.
 *
 * @param {unknown} text
 * @returns {unknown} the redacted string, or `text` unchanged when it is not a string
 */
export function redactText(text) {
  if (typeof text !== "string") return text;
  let out = text.replace(BEARER_PATTERN, `$1${REDACTED_TOKEN}`);
  out = out.replace(TOKEN_PATTERN, REDACTED_TOKEN);
  out = out.replace(TOKEN_LIKE_PATTERN, REDACTED_TOKEN);
  return out;
}

/**
 * Redact a single value that is expected to be a token.
 *
 * Returns non-string values untouched so it can be used as a field mapper
 * (`{"token": redactToken}`) without losing numbers/booleans.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactToken(value) {
  if (typeof value !== "string") return value;
  return redactText(value);
}

/**
 * Deep-redact a JSON-ish value: strings are passed through `redactText`, keys
 * whose name suggests a secret are replaced outright, plain objects and arrays
 * are walked. Cycles are tolerated; `Date` and other objects become strings.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactDeep(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object") return value;
  if (depth > 16) return "[truncated]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactText(value.message);

  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));

  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[String(k)] = redactDeep(v, depth + 1);
    return out;
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    // An absent secret stays absent: `{token: null}` means "there is no token",
    // and rewriting it to `td_****` would be a lie a caller could act on. Only a
    // value that is actually there gets blanked.
    out[key] = SECRET_KEY.test(key) && val !== null && val !== undefined
      ? REDACTED_TOKEN
      : redactDeep(val, depth + 1);
  }
  return out;
}
