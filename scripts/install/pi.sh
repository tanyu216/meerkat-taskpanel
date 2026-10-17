#!/usr/bin/env bash
# Install Meerkat TaskPanel for Pi / Agent Skills: ~/.agents/skills/{meerkat-taskpanel,meerkat-loop}
#
# Pi has no timer, so it also gets the host-external supervisor's scheduling
# units and wake glue (~/.agents/scheduling, ~/.agents/bin/wake-pi.sh) and the
# host config (~/.agents/meerkat-taskpanel.env). Nothing is loaded automatically; the
# exact load command is printed. See docs/scheduling.md.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".agents" "pi"
install_loop_skill ".agents" "pi"

export_tp_env ".agents" "pi"

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

install_scheduling
write_host_config
