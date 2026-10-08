#!/usr/bin/env bash
# Install the Task Panel skill for OpenClaw: ~/.openclaw/skills/task-panel
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".openclaw" "openclaw"
