#!/usr/bin/env bash
# Install the Meerkat TaskPanel skill for OpenClaw: ~/.openclaw/skills/meerkat-taskpanel
#
# OpenClaw deliberately gets **no** supervisor and **no** scheduling unit: the
# openclaw-team framework already ships `poll-<agent>` (every 1m + trigger) and
# `task-patrol` (every 5m), which are exactly this design. OpenClaw host users
# install that framework instead; see docs/scheduling.md and docs/install.md.
#
# That is why this script calls neither `install_loop_skill` nor `install_scheduling`:
# there is no `~/.openclaw/skills/meerkat-loop` and no `~/.openclaw/scheduling`, on
# purpose, permanently (ruling O3). Two supervisors on one board would only race each
# other for the same cards — the board's claim is atomic, so the race is bounded, but the
# second one is pure waste. `test/install/scheduling-units.test.mjs` asserts the absence.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".openclaw" "openclaw"
