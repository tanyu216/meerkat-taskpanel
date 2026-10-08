#!/usr/bin/env bash
# Install the Task Dashboard skill for Pi / Agent Skills: ~/.agents/skills/task-dashboard
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".agents" "pi"
