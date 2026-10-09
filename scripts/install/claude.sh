#!/usr/bin/env bash
# Install the Meerkat TaskPanel bundle for Claude Code.
#
# Deploys the complete Claude bundle, not just the skill:
#   1. skill            → ~/.claude/skills/meerkat-taskpanel
#   2. MCP registration → `claude mcp add meerkat-taskpanel -- node <repo>/src/mcp/main.mjs`
#                         (runs the CLI when present; otherwise prints the command)
#   3. settings.json    → merged: env.TASKCTL_AGENT + a SessionStart hook, preserving
#                         every other key and hook
#   4. slash commands   → ~/.claude/commands/{board,claim,deliver}.md
#   5. scheduling       → ~/.claude/scheduling/{launchd,systemd,cron} + wake-claude.sh
#                         and the host config (~/.claude/meerkat-taskpanel.env)
# plus the reproducible hook script and the taskctl shim that injects --agent <name>.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".claude" "claude"

export_tp_env ".claude" "claude"

# Hook script first (the settings entry points at it), then the settings merge.
emit_file "claude/session-start.sh" "$TP_HOOK" --exec
merge_settings "$(target_home)/.claude/settings.json"

# The shim — every CLI call from a hook/command is attributed to this agent.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec

# Slash commands.
emit_file "claude/commands/board.md"   "$(target_home)/.claude/commands/board.md"
emit_file "claude/commands/claim.md"   "$(target_home)/.claude/commands/claim.md"
emit_file "claude/commands/deliver.md" "$(target_home)/.claude/commands/deliver.md"

# Host-external supervisor: units + wake glue + the persisted claim policy. Claude
# Code has no timers, so the loop lives outside it (see docs/scheduling.md).
install_scheduling
write_host_config

# MCP registration last, so a fresh install has everything else in place first.
register_mcp "claude" "claude"
