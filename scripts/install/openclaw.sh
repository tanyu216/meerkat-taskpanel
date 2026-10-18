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

# `export_tp_env` resolves the checkout, the agent's name and this host's label. It writes
# nothing — the values are only *used* by the two lines below, and the PATH warning it can
# record is emitted by `install_scheduling`, which OpenClaw never calls.
export_tp_env ".openclaw" "openclaw"

# The `taskctl` shim — the same one every host gets.
#
# It is **not** the supervisor and **not** a scheduling unit: it is twenty lines that
# pin the caller's identity (`--agent <name> --actor-kind <host>`) on every CLI call.
# Without it a write from this host carries a name and no kind, and the board reads a
# write with no kind as a **person's** — which is what puts it on the record as a
# decision (I5) and lets it resume an `awaiting` card. So it is installed here even
# though the rulings above keep the loop out: those are about an unattended daemon,
# and this is one wrapper around a command the agent already runs itself.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec

