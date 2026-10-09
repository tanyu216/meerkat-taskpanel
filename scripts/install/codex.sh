#!/usr/bin/env bash
# Install the Task Panel bundle for Codex.
#
# Deploys the complete Codex bundle, not just the skill:
#   1. skill              → ~/.codex/skills/task-panel
#   2. MCP registration   → `codex mcp add taskpanel -- node <repo>/src/mcp/main.mjs`
#   3. claim-first snippet → merged into ~/.codex/AGENTS.md (identity + rules)
#   4. claim trigger      → ~/.codex/task-panel-claim.sh (schedulable; --no-automation skips)
# plus the taskctl shim that injects --agent <name>.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".codex" "codex"

export_tp_env ".codex"

# The shim first (the snippet below points at it), then the AGENTS.md snippet.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec
append_snippet "$(target_home)/.codex/AGENTS.md" "codex/AGENTS.md.snippet" "task-panel"

# Claim trigger — Codex has no hooks, so this is the schedulable auto-claim.
if [ "${TASKPANEL_NO_AUTOMATION:-}" = "1" ]; then
  echo "codex: --no-automation — skipping the claim trigger script"
else
  emit_file "codex/trigger.sh" "$TP_TRIGGER" --exec
  echo "codex: schedule the claim trigger, e.g.  */5 * * * * $TP_TRIGGER"
fi

# MCP registration last, so a fresh install has everything else in place first.
register_mcp "codex" "codex"
