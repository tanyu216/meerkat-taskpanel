#!/usr/bin/env bash
# Install the Meerkat TaskPanel bundle for Codex.
#
# Deploys the complete Codex bundle, not just the skill:
#   1. skill              → ~/.codex/skills/meerkat-taskpanel
#   2. claim-first snippet → merged into ~/.codex/AGENTS.md (identity + rules)
#   3. claim trigger      → ~/.codex/meerkat-taskpanel-claim.sh (schedulable; --no-automation skips)
#   4. scheduling         → ~/.codex/scheduling/{launchd,systemd,cron} + wake-codex.sh
#                           and the host config (~/.codex/meerkat-taskpanel.env)
# plus the taskctl shim that injects --agent <name>. `--no-automation` skips the
# claim trigger *and* the scheduling wiring — Codex has no hooks, so both are the
# automation, and the flag means "install none of it".
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".codex" "codex"

export_tp_env ".codex" "codex"

# The shim first (the snippet below points at it), then the AGENTS.md snippet.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec
append_snippet "$(target_home)/.codex/AGENTS.md" "codex/AGENTS.md.snippet" "meerkat-taskpanel"

# Claim trigger + scheduling — Codex has no hooks, so these are the automation.
if [ "${MEERKAT_TASKPANEL_NO_AUTOMATION:-}" = "1" ]; then
  echo "codex: --no-automation — skipping the claim trigger and scheduling units"
else
  emit_file "codex/trigger.sh" "$TP_TRIGGER" --exec
  echo "codex: legacy claim trigger written to $TP_TRIGGER (the supervisor supersedes it)"
  install_scheduling
  write_host_config
fi
