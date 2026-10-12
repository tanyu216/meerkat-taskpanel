#!/usr/bin/env bash
# Install the Meerkat TaskPanel skill for OpenClaw: ~/.openclaw/skills/meerkat-taskpanel
#
# OpenClaw deliberately gets **no** supervisor and **no** scheduling unit: the
# openclaw-team framework already ships a per-agent poll and a `task-patrol`, which
# are exactly this design. Its cadence is deliberately not repeated here: the
# framework's own AUTOMATIONS.md is the single source of truth for it, and a number
# copied into this file is a number that drifts. OpenClaw host users install that
# framework instead; see docs/scheduling.md and docs/install.md.
#
# That is why this script calls neither `install_loop_skill` nor `install_scheduling`:
# there is no `~/.openclaw/skills/meerkat-loop` and no `~/.openclaw/scheduling`, on
# purpose, permanently (ruling O3). Two supervisors on one board would only race each
# other for the same cards — the board's claim is atomic, so the race is bounded, but the
# second one is pure waste. `test/install/scheduling-units.test.mjs` asserts the absence.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"
install_skill ".openclaw" "openclaw"
