#!/usr/bin/env bash
# Install Meerkat TaskPanel for Cursor: ~/.cursor/skills/meerkat-taskpanel
#
# Cursor reads user skills from `~/.cursor/skills/<name>/SKILL.md` (and, from the same
# scan, `~/.agents/skills/` plus the Claude/Codex compatibility directories), so the
# board skill lands there and the host config records the checkout the skill's wrapper
# drives — rung two of the wrapper's resolution ladder, the one that survives the skill
# being copied away from the repository.
#
# Cursor gets the host-external supervisor too: the loop skill, the loop body, the
# scheduling units and `wake-cursor.sh`. Its headless entry point is `cursor-agent -p`.
#
# Rank of the evidence, stated rather than implied: this whole host is secondary-sourced
# (Cursor's help index and a third-party agent-skills guide for `~/.cursor/skills/`; the
# fresh `cursor-agent -p` form from a third-party experiment table). The **resume** form
# (`-p --resume <sid>`) is unverified — there is no Cursor CLI on the machine this was
# built on — so the wake glue labels it, `--wake-command` stays the escape hatch, and
# docs/scheduling.md records the gap. `test/install/scheduling-units.test.mjs` asserts
# the installed glue's shape.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".cursor" "cursor"
install_loop_skill ".cursor" "cursor"

export_tp_env ".cursor" "cursor"

# The `taskctl` shim — the same one every host gets.
#
# It is **not** the supervisor and **not** a scheduling unit: it is twenty lines that
# pin the caller's identity (`--agent <name> --actor-kind <host>`) on every CLI call.
# Without it a write from this host carries a name and no kind, and the board reads a
# write with no kind as a **person's** — which is what puts it on the record as a
# decision (I5) and lets it resume an `awaiting` card.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec

install_scheduling
write_host_config
