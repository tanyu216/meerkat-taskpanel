/**
 * Tool outcome → `{content, isError}` (plan §3.1, F-C1, G4).
 *
 * This file is the milestone's acceptance criterion #3 in miniature. The gate
 * ("no report for this round ⇒ refused, with the command that fixes it") is
 * decided *by the service*, travels over HTTP as `{ok:false, error:{…}}`, and is
 * rebuilt into a `DomainError` by `domainErrorFromPayload` — the same function
 * the CLI uses. MCP's only job is to change the container it is serialised into.
 *
 * So `failed()` does **not** assemble a document. It round-trips the error
 * through the shared mapper and emits `toJSON()`, which is why a caller of
 * `tools/call` and a caller of `taskctl --json` see the same `code`, the same
 * `message` and the same `hint` — byte for byte, from one object, with no second
 * implementation that could drift.
 *
 * The one thing MCP *does* add is prose (G4). A model reading the result has no
 * terminal and no `--help`, so a failure that only said
 * `taskctl issue deliver … --report-file -` would be advice it cannot act on.
 * The fix is an extra `content` block, never an edit to `hint`: changing `hint`
 * would break the equality the acceptance criterion is about.
 */

import { DomainError, toErrorPayload } from "../shared/errors.mjs";
import { redactDeep } from "../shared/redact.mjs";
import { domainErrorFromPayload } from "../cli/client/http.mjs";

/** @param {string} text */
function textBlock(text) {
  return { type: "text", text };
}

/**
 * The `error` half of the wire, as the service defined it.
 *
 * `toErrorPayload` normalises anything throwable into the five-field shape;
 * `domainErrorFromPayload` rebuilds the `DomainError` (the CLI's own path, so
 * the `http` status the service chose is authoritative); `toJSON()` serialises
 * it. Three steps, one meaning — and none of them hand-writes a field.
 *
 * @param {unknown} err
 */
export function errorPayloadOf(err) {
  const rebuilt = domainErrorFromPayload(toErrorPayload(err));
  const payload = typeof rebuilt.toJSON === "function" ? rebuilt.toJSON() : toErrorPayload(rebuilt);
  return redactDeep(payload);
}

/**
 * MCP-side advice for the model, or `null` when the structured payload is
 * already actionable on its own.
 *
 * @param {object} payload
 */
function recoveryProse(payload) {
  if (payload.code === "REPORT_REQUIRED") {
    const ref = payload.details?.identifier ?? payload.details?.taskId ?? "<ref>";
    return (
      `this caller has no terminal: to satisfy the gate, call the task_deliver tool with ` +
      `${JSON.stringify({ ref, report: { conclusion: "<what was done>", acceptance: [{ text: "<criterion>", status: "met" }], evidence: [{ kind: "path", path: "<file>" }] } })} ` +
      `(or the task_deliver tool's no_report + reason waiver).`
    );
  }
  if (payload.code === "CLI_IO") {
    return "the board could not be reached: start one (`node src/server/main.mjs`) or launch this server with --url <url>.";
  }
  return null;
}

/**
 * A tool that ran and succeeded.
 *
 * `payload` is the `data` half of the taskd envelope, verbatim. Warnings are
 * merged in as a structured `warnings` array *and* echoed as a second text
 * block, because a model reading prose benefits from the sentence while a
 * program reading JSON benefits from the array — and neither is worth a
 * stderr channel this transport does not have.
 *
 * @param {{payload?: object, warnings?: string[]}|object} outcome
 */
export function ok(outcome) {
  const source = outcome === null || typeof outcome !== "object" ? {} : outcome;
  const payload = source.payload !== undefined ? source.payload : source;
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter((w) => typeof w === "string" && w !== "") : [];

  const document = warnings.length === 0 ? payload : { ...(payload ?? {}), warnings };
  const content = [textBlock(JSON.stringify(document))];
  if (warnings.length > 0) content.push(textBlock(warnings.join("\n")));

  return { content, isError: false };
}

/**
 * A tool that ran and was refused.
 *
 * Note the shape: this is a **successful** JSON-RPC result whose content says
 * the call failed. That separation is the whole point — a caller can tell "this
 * server does not have that tool" (`-32602`, from `server.mjs`) from "that tool
 * ran and the board said no" (`isError: true`, here).
 *
 * @param {unknown} err
 */
export function failed(err) {
  const payload = errorPayloadOf(err);
  const content = [textBlock(JSON.stringify(payload))];
  const prose = recoveryProse(payload);
  if (prose !== null) content.push(textBlock(prose));
  return { content, isError: true };
}

/**
 * A usage refusal raised *here*, before any HTTP call — the MCP spelling of a
 * `CLI_USAGE`. It is turned into `-32602` by `server.mjs`, never into an
 * `isError` result: nothing ran, so nothing failed.
 *
 * @param {string} message
 * @param {{details?: object, hint?: object}} [options]
 */
export function invalidParams(message, options = {}) {
  return new DomainError("CLI_USAGE", { message, ...options });
}
