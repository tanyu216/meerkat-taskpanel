#!/usr/bin/env bash
# Cursor SessionStart hook — emits the per-repo issue-tracker check.
#
# Cursor's hook contract is its own: a lowercase `sessionStart` key and a single
# `additional_context` string (not Claude Code's `hookSpecificOutput`). This
# script always prints valid JSON and exits 0 — a missing instruction must never
# block the session.
set -u

root="${CURSOR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
check="$root/skills/meerkat-taskpanel/references/issue-tracker-check.md"

text=""
if [ -r "$check" ] && [ ! -f "docs/agents/issue-tracker.md" ]; then
  text="$(cat "$check")"
fi

# JSON-escape the text with parameter expansion (bash 3.2 compatible).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

printf '{"additional_context":"%s"}\n' "$(json_escape "$text")"
