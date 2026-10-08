#!/usr/bin/env bash
# Install the Task Dashboard skill for OpenClaw: ~/.openclaw/skills/task-dashboard
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".openclaw" "openclaw"
