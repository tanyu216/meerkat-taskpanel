#!/usr/bin/env bash
# Install the Task Dashboard skill for Claude Code: ~/.claude/skills/task-dashboard
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".claude" "claude"
