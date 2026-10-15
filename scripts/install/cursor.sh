#!/usr/bin/env bash
# Install Meerkat TaskPanel for Cursor: ~/.cursor/skills/meerkat-taskpanel
#
# Cursor reads user skills from `~/.cursor/skills/<name>/SKILL.md` (and, from the same
# scan, `~/.agents/skills/` plus the Claude/Codex compatibility directories), so the
# board skill lands there and the host config records the checkout the skill's wrapper
# drives — rung two of the wrapper's resolution ladder, the one that survives the skill
# being copied away from the repository.
#
# Cursor deliberately gets **no** supervisor and **no** scheduling unit. The plugin
# (`.cursor-plugin/plugin.json` at the repository root) already hands Cursor the same
# skills read in place, and — the reason the loop stays out — Cursor's headless and
# resume forms are unverified here: `docs/scheduling.md` has no Cursor row at all, and
# the only invocation anyone records (`cursor-agent -p`) appears in a third-party
# experiment table, not in an install or reference document. The units start *the glue*,
# which is a headless call; pointing an unattended daemon at an unverified command is a
# different risk class from copying a skill. So there is no `~/.cursor/scheduling` and no
# `wake-cursor.sh`, and `--supervisor-hosts cursor` is rejected (exit 2).
#
# Rank of the evidence, stated rather than implied: `~/.cursor/skills/` comes from
# secondary sources (Cursor's help index and a third-party agent-skills guide agree), not
# from a document this repository can run. It is a skill *directory*, so a wrong guess
# leaves an inert folder; that is why the target ships while the daemon does not.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".cursor" "cursor"

export_tp_env ".cursor" "cursor"
write_host_config
