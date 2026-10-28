#!/usr/bin/env bash
# Install the Meerkat TaskPanel bundle for Claude Code.
#
# Deploys the complete Claude bundle, not just the board skill:
#   1. board skill      → ~/.claude/skills/meerkat
#   2. loop skill       → ~/.claude/skills/meerkat-loop (always a copy; --link is board-only)
#   3. setup skill      → ~/.claude/skills/setup-meerkat (Claude-only; /setup-meerkat)
#   4. settings.json    → merged: env.TASKCTL_AGENT + a SessionStart hook, preserving
#                         every other key and hook
#   5. slash commands   → ~/.claude/commands/{board,claim,deliver}.md
#   6. scheduling       → ~/.claude/scheduling/{launchd,systemd,cron}, the loop state
#                         directory (~/.claude/meerkat-taskpanel/) and the per-kind config
#                         (<program root>/.env.claude)
# plus the reproducible hook script and the taskctl shim that injects --agent <name>.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".claude" "claude"
install_loop_skill ".claude" "claude"
install_skill ".claude" "claude" "$(setup_skill_name)" copy

export_tp_env ".claude" "claude"

# Hook script first (the settings entry points at it), then the settings merge.
emit_file "claude/session-start.sh" "$TP_HOOK" --exec
merge_settings "$(target_home)/.claude/settings.json"

# The shim — every CLI call from a hook/command is attributed to this agent.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec
reconcile_taskctl_on_path

# Slash commands.
emit_file "claude/commands/board.md"   "$(target_home)/.claude/commands/board.md"
emit_file "claude/commands/claim.md"   "$(target_home)/.claude/commands/claim.md"
emit_file "claude/commands/deliver.md" "$(target_home)/.claude/commands/deliver.md"

# External supervisor: units + the persisted claim policy. Claude
# Code has no timers, so the loop lives outside it (see docs/scheduling.md).
install_scheduling
write_agent_config
