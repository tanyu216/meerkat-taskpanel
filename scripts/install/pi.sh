#!/usr/bin/env bash
# Install the Meerkat TaskPanel skill for Pi / Agent Skills: ~/.agents/skills/meerkat-taskpanel
#
# Pi has no timer, so it also gets the host-external supervisor's scheduling
# units and wake glue (~/.agents/scheduling, ~/.agents/bin/wake-pi.sh) and the
# host config (~/.agents/meerkat-taskpanel.env). Nothing is loaded automatically; the
# exact load command is printed. See docs/scheduling.md.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".agents" "pi"

export_tp_env ".agents" "pi"

install_scheduling
write_host_config
