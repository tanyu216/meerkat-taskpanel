#!/usr/bin/env bash
# Install Meerkat TaskPanel for Cursor: ~/.cursor/skills/meerkat-taskpanel
#
# Cursor reads user skills from `~/.cursor/skills/<name>/SKILL.md` (and, from the same
# scan, `~/.agents/skills/` plus the Claude/Codex compatibility directories), so the
# board skill lands there and the agent config records the checkout the skill's wrapper
# drives — rung two of the wrapper's resolution ladder, the one that survives the skill
# being copied away from the repository.
#
# Cursor gets the external supervisor too: the loop skill, the loop body, the
# scheduling units and `wake-cursor.sh`. Its headless entry point is `cursor-agent -p`.
#
# Rank of the evidence, stated rather than implied: `~/.cursor/skills/` is
# secondary-sourced (Cursor's help index and a third-party agent-skills guide). The
# headless forms (`-p/--print`, `--resume [chatId]`, `--continue`) are Cursor's
# documented CLI surface, and `scripts/verify/kind-resume-matrix.mjs --actor-kind cursor`
# probes those flags against the real binary when it is installed; `--e2e` adds a real
# `-p` call when `CURSOR_API_KEY` is present. The glue is asserted by
# `test/install/scheduling-units.test.mjs`.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".cursor" "cursor"
install_loop_skill ".cursor" "cursor"

export_tp_env ".cursor" "cursor"

# The `taskctl` shim — the same one every agent kind gets.
#
# It is **not** the supervisor and **not** a scheduling unit: it is twenty lines that
# pin the caller's identity (`--agent <name> --actor-kind <kind>`) on every CLI call.
# Without it a write from this agent carries a name and no kind, and the board reads a
# write with no kind as a **person's** — which is what puts it on the record as a
# decision (I5) and lets it resume an `awaiting` card.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec

install_scheduling
write_agent_config
