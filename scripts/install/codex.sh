#!/usr/bin/env bash
# Install the Task Panel skill for Codex: ~/.codex/skills/task-panel
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".codex" "codex"
