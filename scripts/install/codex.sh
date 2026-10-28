#!/usr/bin/env bash
# Install the Meerkat TaskPanel bundle for Codex.
#
# Deploys the complete Codex bundle, not just the board skill:
#   1. board skill        → ~/.codex/skills/meerkat
#   2. loop skill         → ~/.codex/skills/meerkat-loop (always a copy; --link is board-only)
#   3. claim-first snippet → merged into ~/.codex/AGENTS.md (identity + rules)
#   4. scheduling         → ~/.codex/scheduling/{launchd,systemd,cron}, the loop state
#                           directory (~/.codex/meerkat-taskpanel/) and the per-kind config
#                           (<program root>/.env.codex)
# plus the taskctl shim that injects --agent <name>. `--no-automation` skips the
# scheduling wiring (and, in install.sh, the taskd keepalive guard) — Codex has no
# hooks, so the scheduling units are the automation. The loop *skill* is not
# automation: it is the decision layer those units load, and it is always installed.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

install_skill ".codex" "codex"
install_loop_skill ".codex" "codex"

export_tp_env ".codex" "codex"

# The shim first (the snippet below points at it), then the AGENTS.md snippet.
emit_file "taskctl-shim.sh" "$TP_SHIM" --exec
reconcile_taskctl_on_path
append_snippet "$(target_home)/.codex/AGENTS.md" "codex/AGENTS.md.snippet" "meerkat-taskpanel"

# Scheduling is the automation — Codex has no hooks.
if [ "${MEERKAT_TASKPANEL_NO_AUTOMATION:-}" = "1" ]; then
  echo "codex: --no-automation — skipping the scheduling units"
  # A requested disable/status still applies: it acts on whatever an *earlier* install
  # wrote, and skipping it would leave a loaded unit nobody can stop from here.
  apply_supervisor
else
  install_scheduling
  write_agent_config
fi
