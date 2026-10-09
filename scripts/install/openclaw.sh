#!/usr/bin/env bash
# Install the Task Panel skill for OpenClaw: ~/.openclaw/skills/task-panel
#
# OpenClaw deliberately gets **no** supervisor and **no** scheduling unit: the
# openclaw-team framework already ships `poll-<agent>` (every 1m + trigger) and
# `task-patrol` (every 5m), which are exactly this design. OpenClaw host users
# install that framework instead; see docs/scheduling.md and docs/install.md.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".openclaw" "openclaw"
