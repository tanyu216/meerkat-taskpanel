#!/usr/bin/env bash
# Install the Meerkat TaskPanel bundle for Codex.
#
# Deploys the complete Codex bundle, not just the board skill:
#   1. board skill        → ~/.codex/skills/meerkat-taskpanel
#   2. loop skill         → ~/.codex/skills/meerkat-loop (always a copy; --link is board-only)
#   3. claim-first snippet → merged into ~/.codex/AGENTS.md (identity + rules)
#   4. claim trigger      → ~/.codex/meerkat-taskpanel-claim.sh (schedulable; --no-automation skips)
#   5. scheduling         → ~/.codex/scheduling/{launchd,systemd,cron}, the loop body in
#                           ~/.codex/meerkat-taskpanel/ and the agent config
#                           (~/.codex/meerkat-taskpanel.env)
# plus the taskctl shim that injects --agent <name>. `--no-automation` skips the
# claim trigger *and* the scheduling wiring — Codex has no hooks, so both are the
# automation, and the flag means "install none of it". The loop *skill* is not
# automation: it is the payload those units run, and it is always installed.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".codex" "codex"
install_loop_skill ".codex" "codex"

export_tp_env ".codex" "codex"

# The shim first (the snippet below points at it), then the AGENTS.md snippet.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec
append_snippet "$(target_home)/.codex/AGENTS.md" "codex/AGENTS.md.snippet" "meerkat-taskpanel"

# Claim trigger + scheduling — Codex has no hooks, so these are the automation.
if [ "${MEERKAT_TASKPANEL_NO_AUTOMATION:-}" = "1" ]; then
  echo "codex: --no-automation — skipping the claim trigger and scheduling units"
  # A requested disable/status still applies: it acts on whatever an *earlier* install
  # wrote, and skipping it would leave a loaded unit nobody can stop from here.
  apply_supervisor
else
  emit_file "codex/trigger.sh" "$TP_TRIGGER" --exec
  echo "codex: legacy claim trigger written to $TP_TRIGGER (the supervisor supersedes it)"
  install_scheduling
  write_agent_config
fi
