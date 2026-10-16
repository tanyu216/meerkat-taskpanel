#!/usr/bin/env bash
# Install Meerkat TaskPanel for OpenCode: ~/.config/opencode/skills/meerkat-taskpanel
#
# OpenCode reads user skills from `~/.config/opencode/skills/<name>/SKILL.md` (the
# convention superpowers' own install doc states and uses), so the board skill lands
# there and the host config records the checkout the skill's wrapper drives. The wrapper
# resolves the CLI by a ladder — `$MEERKAT_TASKPANEL_ROOT`, then the
# `MEERKAT_TASKPANEL_REPO` this file writes, then a checkout beside the skill, then
# `taskctl` on PATH — and rung two is the one that survives the skill being copied away
# from the repository, so the env file is what makes this target more than a file copy.
#
# OpenCode deliberately gets **no** supervisor and **no** scheduling unit. Its skills are
# already delivered in place by the plugin (`.opencode/plugins/meerkat-taskpanel.js`
# registers the repository's own `skills/` tree), so this target exists for a host that
# also wants the skill on disk with a resolvable CLI — not to duplicate the plugin. And
# the supervisor's glue is a *headless* invocation, while OpenCode's headless and resume
# forms are unverified here: `docs/scheduling.md` says exactly that ("opencode is not a
# supported `--host`; its headless and resume forms were **not verified** — its CLI was
# not installed"). Pointing an unattended daemon at an unverified command is a different
# risk class from copying a skill, so the loop stays out until someone can probe those
# forms on a machine that has the CLI. There is no `~/.config/opencode/scheduling` and no
# `wake-opencode.sh`; `test/install/scheduling-units.test.mjs` asserts the absence.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".config/opencode" "opencode"

export_tp_env ".config/opencode" "opencode"

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
