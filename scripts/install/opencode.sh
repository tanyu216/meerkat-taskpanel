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
write_host_config
