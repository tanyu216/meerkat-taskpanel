#!/usr/bin/env bash
# Install Meerkat TaskPanel for Pi / Agent Skills: ~/.agents/skills/{meerkat,meerkat-loop}
#
# Pi has no timer, so it also gets the external supervisor's scheduling
# units (~/.agents/scheduling) and the per-kind config
# (<program root>/.env.pi). Nothing is loaded automatically; the
# exact load command is printed. See docs/scheduling.md.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".agents" "pi"
install_loop_skill ".agents" "pi"

export_tp_env ".agents" "pi"

# The `taskctl` shim — the same one every agent kind gets.
#
# It is **not** the supervisor and **not** a scheduling unit: it is twenty lines that
# pin the caller's identity (`--agent <name> --actor-kind <kind>`) on every CLI call.
# Without it a write from this agent carries a name and no kind, and the board reads a
# write with no kind as a **person's** — which is what puts it on the record as a
# decision (I5) and lets it resume an `awaiting` card. So it is installed here even
# though the rulings above keep the loop out: those are about an unattended daemon,
# and this is one wrapper around a command the agent already runs itself.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec

install_scheduling
write_agent_config

# The loop dispatches one subagent per card. Pi has no native subagent mechanism, so a
# Pi host needs an extension for the project session to spawn worker/reviewer subagents.
# Check the recommended one and print the install command; install nothing: the installer
# is offline and a package install is the operator's decision.
pi_ext=""
for candidate in \
  "$(target_home)/.pi/agent/extensions/subagent" \
  "$(target_home)/.pi/agent/extensions/pi-subagents"; do
  if [ -d "$candidate" ]; then
    pi_ext="$candidate"
    break
  fi
done
if [ -n "$pi_ext" ]; then
  echo "pi: subagent extension found ($pi_ext)"
else
  echo "pi: no subagent extension found — the loop's project session cannot spawn" >&2
  echo "    worker/reviewer subagents. Install the recommended one:" >&2
  echo "      pi install npm:pi-subagents" >&2
fi
