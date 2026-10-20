/**
 * The session-start issue-tracker check, shared by the in-process host routes.
 *
 * `setup-matt-pocock-skills` writes its configuration **per repository** —
 * `docs/agents/issue-tracker.md` plus the `## Agent skills` block in `CLAUDE.md`
 * or `AGENTS.md` — and it is installed globally. So the integration cannot be a
 * one-time install step: each host session has to look at the repository it is
 * in, and configure that repository when the file is missing.
 *
 * The instruction itself is authored once, in the board skill
 * (`skills/meerkat-taskpanel/references/issue-tracker-check.md`), and every host
 * surface carries the same text: the Claude hook prints it, the Codex
 * `AGENTS.md` block inlines it, and the Pi extension / OpenCode plugin inject it
 * here. One marker, so a session that somehow sees two routes still gets one
 * copy.
 *
 * Pure Node builtins; no host dependency. The hosts' own APIs are read
 * defensively by the callers, never here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The stable first line of the shared instruction; the dedupe key. */
export const CHECK_MARKER = "<!-- meerkat-taskpanel:issue-tracker-check -->";

/** Where the board skill keeps the instruction, relative to a package root. */
const CHECK_PATH = join("skills", "meerkat-taskpanel", "references", "issue-tracker-check.md");

/**
 * Read the shared instruction from a package root.
 *
 * A package without the file (an older copy, a host bundle that ships only the
 * skill entry) is not an error: the caller simply has nothing to inject.
 *
 * @param {string} packageRoot
 * @returns {string} the instruction, trimmed; `""` when absent or unreadable
 */
export function readIssueTrackerCheck(packageRoot) {
  try {
    return readFileSync(join(packageRoot, CHECK_PATH), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Does any of these message strings already carry the check?
 *
 * Hosts hand messages in different shapes; callers extract the text parts and
 * ask this one question, so "inject once" is decided in one place.
 *
 * @param {Array<unknown>} texts
 * @returns {boolean}
 */
export function hasCheck(texts) {
  if (!Array.isArray(texts)) return false;
  return texts.some((text) => typeof text === "string" && text.includes(CHECK_MARKER));
}
