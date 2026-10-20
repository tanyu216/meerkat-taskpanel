/**
 * The testable half of the Pi extension.
 *
 * Pi runs the TypeScript entry point as written and supplies `ExtensionAPI` at
 * load time, so `.ts` cannot be imported by `node --test`. This plain-JS core
 * holds the logic; the `.ts` file is the thin host entry point.
 *
 * Two jobs:
 *
 *   1. `resources_discover` — register the repository's own `skills/` tree, in
 *      place, exactly as before.
 *   2. the per-repo issue-tracker check — inject the shared instruction into
 *      the session's context once it starts (and again after a compaction), and
 *      stand down at `agent_end`. The instruction carries its own marker, which
 *      is the dedupe key.
 *
 * Node builtins only; no host dependency, no network.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasCheck, readIssueTrackerCheck } from "../../src/foundation/session-check.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillsDir = resolve(packageRoot, "skills");

/** The text parts of one Pi message (`{ role, content: [{ type, text }] }`). */
function partTexts(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map((part) => part?.text);
}

/**
 * Register the extension's handlers.
 *
 * @param {{on: (name: string, fn: Function) => void}} pi the host API
 */
export function register(pi) {
  const check = readIssueTrackerCheck(packageRoot);
  let inject = false;

  pi.on("resources_discover", async () => ({ skillPaths: [skillsDir] }));

  // Pi starts a context window at session start and after a compaction; both are
  // moments where the model may not have the instruction yet.
  pi.on("session_start", async () => {
    inject = true;
  });
  pi.on("session_compact", async () => {
    inject = true;
  });
  pi.on("agent_end", async () => {
    inject = false;
  });

  pi.on("context", async (event) => {
    try {
      if (!inject || !check) return;
      const messages = Array.isArray(event?.messages) ? event.messages : null;
      if (!messages) return;
      if (hasCheck(messages.flatMap(partTexts))) return;

      return {
        messages: [
          { role: "user", content: [{ type: "text", text: check }], timestamp: Date.now() },
          ...messages,
        ],
      };
    } catch (err) {
      console.error("[meerkat-taskpanel] issue-tracker check skipped:", err);
      return;
    }
  });
}
