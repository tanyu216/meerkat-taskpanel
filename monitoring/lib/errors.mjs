/**
 * Error vocabulary for the monitoring sidecar.
 *
 * The engine's rule is that every failure carries a machine-readable code rather than a
 * bare `Error` message (`src/core` raises `DomainError`). `monitoring/` is a separate,
 * dependency-free surface — it never imports `src/core` — so it carries its own, much
 * smaller vocabulary here. The codes double as the `error` field of an HTTP response
 * body, so a caller can branch without parsing prose.
 *
 * Nothing in this module reads the environment, the clock or the filesystem.
 */

/** Every code `MonitoringError` may carry, with the fixed message it defaults to. */
export const MONITORING_ERROR_CODES = Object.freeze({
  // ---- metrics model -------------------------------------------------------
  INVALID_METRIC_NAME: "A metric name must match [a-zA-Z_:][a-zA-Z0-9_:]*.",
  INVALID_LABEL_NAME: "A label name must match [a-zA-Z_][a-zA-Z0-9_]*.",
  INVALID_LABEL_VALUE: "A label value must be a string, number or boolean.",
  LABEL_SET_MISMATCH: "The label set does not match the registered label names.",
  DUPLICATE_METRIC: "A metric with this name is already registered.",
  TYPE_CONFLICT: "A metric with this name is already registered under another type.",
  INVALID_BUCKETS: "Histogram buckets must be a non-empty list of ascending finite numbers.",
  INVALID_OBSERVATION: "The observation is not a valid HTTP observation.",
  INVALID_ARGUMENT: "The argument is not valid.",

  // ---- declarative artefacts ----------------------------------------------
  YAML_PARSE_ERROR: "The document is not valid YAML for this reader.",
  UNSUPPORTED_YAML: "The document uses a YAML feature this reader does not implement.",
  RULES_INVALID: "The alerting rules do not match the pinned SLO thresholds.",

  // ---- OTLP ----------------------------------------------------------------
  OTLP_EXPORT_FAILED: "The OTLP push could not be delivered.",
  OTLP_REJECTED: "The OTLP receiver rejected the payload.",

  // ---- HTTP surface --------------------------------------------------------
  NOT_FOUND: "Not found.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  PAYLOAD_TOO_LARGE: "The request body is too large.",
});

/**
 * A monitoring failure with a `code`, optional `details` and (for YAML) a 1-based `line`.
 */
export class MonitoringError extends Error {
  /**
   * @param {keyof typeof MONITORING_ERROR_CODES} code
   * @param {{message?: string, details?: object, line?: number, cause?: unknown}} [options]
   */
  constructor(code, options = {}) {
    const known = Object.hasOwn(MONITORING_ERROR_CODES, code);
    super(options.message ?? (known ? MONITORING_ERROR_CODES[code] : code));
    this.name = "MonitoringError";
    this.code = code;
    this.details = options.details ?? {};
    if (options.line !== undefined) this.line = options.line;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** JSON-safe projection, used as the body of an HTTP error response. */
  toJSON() {
    const payload = { error: this.code, message: this.message, details: this.details };
    if (this.line !== undefined) payload.line = this.line;
    return payload;
  }
}

/**
 * Is `value` one of ours? Cross-realm safe enough (marker + recognised code).
 * @param {unknown} value
 */
export function isMonitoringError(value) {
  return (
    value instanceof MonitoringError ||
    (typeof value === "object" &&
      value !== null &&
      value.name === "MonitoringError" &&
      typeof value.code === "string" &&
      Object.hasOwn(MONITORING_ERROR_CODES, value.code))
  );
}
