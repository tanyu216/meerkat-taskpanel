#!/usr/bin/env bash
# Install the Task Panel skill for Pi / Agent Skills: ~/.agents/skills/task-panel
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".agents" "pi"
