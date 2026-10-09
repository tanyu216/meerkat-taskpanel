/**
 * One place that decides what the terminal sees.
 *
 * The routing rules (§F-C2), in full:
 *
 *   --json + success → stdout: `{"ok":true,"data":…}`
 *   --json + failure → stdout: `{"ok":false,"error":…}`   (stderr stays quiet)
 *   human  + success → stdout: whatever the command built
 *   human  + failure → stderr: `CODE: message` + the command that fixes it
 *
 * Warnings always go to stderr: they must not corrupt a `--json` document, and a
 * human still has to see them. Every string written passes through `redactText`.
 *
 * `render` takes a writer pair rather than touching `process` directly, so the
 * routing itself is unit-testable.
 */

import { redactText } from "../../shared/redact.mjs";
import { renderErrorText } from "../../shared/transport/errors.mjs";
import { errorEnvelope, serialize, successEnvelope } from "./json.mjs";

/**
 * A command's result: the machine payload, the human text, and anything the
 * caller should know about but that did not stop the command.
 *
 * @typedef {{data: unknown, human: string, warnings?: string[], exit?: number, allowSecrets?: boolean}} CommandResult
 */

/**
 * @param {CommandResult} result
 * @param {{json?: boolean, out: (text: string) => void, err: (text: string) => void}} io
 */
export function renderResult(result, io) {
  const warnings = result.warnings ?? [];
  for (const warning of warnings) io.err(`${redactText(`warning: ${warning}`)}\n`);

  if (io.json === true) {
    io.out(serialize(successEnvelope(result.data), { redact: result.allowSecrets !== true }));
    return;
  }
  const human = result.human ?? "";
  if (human !== "") {
    const text = human.endsWith("\n") ? human : `${human}\n`;
    // `token rotate --show` is the only command that means to print a secret; it
    // says so explicitly, and this is where that promise is either honoured or
    // quietly broken.
    io.out(result.allowSecrets === true ? text : redactText(text));
  }
}

/**
 * @param {unknown} err
 * @param {{json?: boolean, out: (text: string) => void, err: (text: string) => void}} io
 */
export function renderFailure(err, io) {
  if (io.json === true) {
    io.out(serialize(errorEnvelope(err)));
    return;
  }
  io.err(`${renderErrorText(err)}\n`);
}
