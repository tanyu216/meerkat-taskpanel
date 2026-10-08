#!/usr/bin/env bash
# Install the Task Panel skill for Claude Code: ~/.claude/skills/task-panel
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".claude" "claude"
