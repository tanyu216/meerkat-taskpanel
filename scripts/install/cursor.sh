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

write_host_config
