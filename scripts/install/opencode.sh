#!/usr/bin/env bash
# Install Meerkat TaskPanel for OpenCode: ~/.config/opencode/skills/meerkat-taskpanel
#
# OpenCode reads user skills from `~/.config/opencode/skills/<name>/SKILL.md` (the
# convention superpowers' own install doc states and uses), so the board skill lands
# there and the agent config records the checkout the skill's wrapper drives. The wrapper
# resolves the CLI by a ladder — `$MEERKAT_TASKPANEL_ROOT`, then the
# `MEERKAT_TASKPANEL_REPO` this file writes, then a checkout beside the skill, then
# `taskctl` on PATH — and rung two is the one that survives the skill being copied away
# from the repository, so the env file is what makes this target more than a file copy.
#
# OpenCode gets the external supervisor too: the loop skill, the loop body, the
# scheduling units and `wake-opencode.sh`. Its headless form is `opencode run <prompt>`
# (and `opencode run --session <sid> <prompt>` to resume) — the shape recorded in
# `scripts/verify/kind-resume-matrix.mjs`. That matrix is the evidence, not a run on
# this machine: the CLI is absent here, so the resume form is flagged in
# `docs/scheduling.md` and `--wake-command` remains the escape hatch.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".config/opencode" "opencode"
install_loop_skill ".config/opencode" "opencode"

export_tp_env ".config/opencode" "opencode"

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
