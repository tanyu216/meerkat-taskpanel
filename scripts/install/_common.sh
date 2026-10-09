#!/usr/bin/env bash
#
# Shared implementation for the per-host installers (claude / openclaw / codex / pi).
#
# Each host script sources this file and calls the pieces it needs. The two bundle
# hosts (claude, codex) call `install_skill` plus the MCP / config / command / trigger
# helpers below; the two skill-only hosts (openclaw, pi) call just `install_skill`.
#
# Honours:
#
#   TASKPANEL_TARGET_HOME  base home directory (default: $HOME)
#   TASKPANEL_AGENT_NAME   agent identity for the bundle (default: $USER)
#   TASKPANEL_LINK         "1" to symlink instead of copy
#   TASKPANEL_FORCE        "1" to overwrite an existing destination / managed key
#   TASKPANEL_DRY_RUN      "1" to print what would happen and change nothing
#   TASKPANEL_NO_AUTOMATION "1" to skip the Codex claim trigger
#   TASKPANEL_MIN_NODE     required Node major (default: 22)
#   TASKPANEL_SKIP_NODE_CHECK  "1" to skip the Node version check
#
# Everything is **idempotent**: re-running an installer with the same inputs leaves
# the destination unchanged and exits 0. Existing files and configuration keys are
# never clobbered unless `TASKPANEL_FORCE` is set.

set -eu

# is_int64 <value> — 0 when <value> is a non-negative integer that fits in a
# signed 64-bit integer (the width bash's `[ … -lt … ]` test arithmetic uses),
# 1 otherwise. Leading zeros are accepted ("007" is 7, "000" is 0). Both
# TASKPANEL_MIN_NODE and the `node -v` major are checked through here so the
# `-lt` comparison below can never overflow — an overflowed comparison errors
# inside the `if`, reads as "false", and lets a too-old Node through.
is_int64() {
  value="$1"
  case "$value" in
    "" | *[!0-9]*) return 1 ;;
  esac
  case "$value" in
    *[1-9]*) value="${value#"${value%%[!0]*}"}" ;;   # strip leading zeros
    *) return 0 ;;                                     # all zeros -> 0, in range
  esac
  len="${#value}"
  [ "$len" -lt 19 ] && return 0
  [ "$len" -gt 19 ] && return 1
  # Exactly 19 digits: at most INT64_MAX (9223372036854775807). Both operands
  # are 19 characters of digits, so lexical order equals numeric order.
  [ "$value" \> "9223372036854775807" ] && return 1
  return 0
}

# require_node — refuse to install onto a runtime the engine cannot use.
#
# The engine stores to SQLite through the built-in `node:sqlite` module, which
# the 22.x line is the first to ship. Without this check a machine below 22 —
# or with no Node at all — "installs" the skill and then fails on first use.
# It lives here, inside `install_skill`, because *every* host script calls that,
# so a direct `scripts/install/<host>.sh` run is guarded exactly like a run
# through the `install.sh` dispatcher (which also calls it, once, up front).
#
# Uses only shell builtins and `command`, so it behaves the same on a bare PATH.
# Returns 1 (0 when node is present and new enough, or the check is skipped).
require_node() {
  [ "${TASKPANEL_SKIP_NODE_CHECK:-}" = "1" ] && return 0
  # D-R1: `:-` treats an *empty* TASKPANEL_MIN_NODE exactly like an unset one —
  # both fall back to the default 22 (shell convention; an empty env var is a
  # normal way to say "default"). Use `${TASKPANEL_MIN_NODE-22}` plus a separate
  # empty check if a set-but-empty value ever needs distinct handling.
  min="${TASKPANEL_MIN_NODE:-22}"

  # D1a: the floor must be a non-negative integer that fits the comparison
  # width (64-bit). A bad value here — non-numeric, empty, or overflowing —
  # would make `[ "$major" -lt "$min" ]` below error inside the `if`, which
  # takes the false branch and lets a too-old Node through: a silent fail-open.
  # Validate it up front so a misspelt or overflowing env is a hard failure,
  # never a pass.
  if ! is_int64 "$min"; then
    echo "TASKPANEL_MIN_NODE must be a non-negative integer up to 9223372036854775807 (got '${min:-<empty>}')." >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "node: no 'node' on PATH." >&2
    echo "Task Panel needs Node >= $min (the engine uses the built-in node:sqlite module)." >&2
    echo "Install Node $min or newer, then re-run: https://nodejs.org/  (or 'nvm install $min')." >&2
    return 1
  fi

  version="$(node -v 2>/dev/null || true)"
  # D1b: a shim's `node -v` may pad its output. Strip leading/trailing
  # whitespace (POSIX parameter expansion only — this function is builtin-only)
  # so "  v22.0.0" parses instead of "could not read the version".
  version="${version#"${version%%[![:space:]]*}"}"   # strip leading whitespace
  version="${version%"${version##*[![:space:]]}"}"   # strip trailing whitespace
  major="${version#v}"   # v22.11.0 -> 22.11.0
  major="${major%%.*}"   # 22.11.0  -> 22
  # D1a (second face): the parsed major must itself be a readable, in-range
  # integer. A huge/odd `node -v` (e.g. a shim printing `v999…`) would otherwise
  # overflow the comparison and fail open exactly like a bad floor would.
  if ! is_int64 "$major"; then
    echo "node: could not read the version ('node -v' printed '${version:-<empty>}')." >&2
    echo "Task Panel needs Node >= $min." >&2
    return 1
  fi

  if [ "$major" -lt "$min" ]; then
    echo "node: $version is too old — Task Panel needs Node >= $min." >&2
    echo "The engine uses the built-in node:sqlite module (Node $min+)." >&2
    echo "Upgrade Node, then re-run: https://nodejs.org/  (or 'nvm install $min')." >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Shared context — resolved relative to the *host script* that sourced this file.
# ---------------------------------------------------------------------------

script_dir() { cd "$(dirname "$0")" && pwd; }
repo_root() { cd "$(script_dir)/../.." && pwd; }
target_home() { printf '%s\n' "${TASKPANEL_TARGET_HOME:-$HOME}"; }
apply_helper() { printf '%s\n' "$(script_dir)/lib/apply.mjs"; }

# agent_name — the identity written into the host bundle.
#
# `--agent-name` (TASKPANEL_AGENT_NAME) wins; the default is $USER, then $LOGNAME,
# then a stable "agent" placeholder. The name is the board assignee: claiming a card
# checks `assignee == actor`, so this is the name the agent must be assigned cards as.
agent_name() {
  local name="${TASKPANEL_AGENT_NAME:-}"
  [ -n "$name" ] || name="${USER:-}"
  [ -n "$name" ] || name="${LOGNAME:-}"
  [ -n "$name" ] || name="agent"
  printf '%s\n' "$name"
}

# export_tp_env <host_dir> <label> — export the TP_* variables the template renderer reads.
#
# {{AGENT}} <- TP_AGENT, {{REPO}} <- TP_REPO, {{SHIM}} <- TP_SHIM, and so on. The
# destinations are absolute under the target home so the hook / trigger / shim / scheduling
# units work regardless of the caller's working directory.
export_tp_env() {
  host_dir="$1"
  label="$2"
  TP_AGENT="$(agent_name)"
  TP_REPO="$(repo_root)"
  TP_SHIM="$(target_home)/$host_dir/bin/taskctl"
  TP_HOOK="$(target_home)/$host_dir/hooks/task-panel-session-start.sh"
  TP_TRIGGER="$(target_home)/$host_dir/task-panel-claim.sh"
  # The host-external supervisor: the scheduling units run it, and it reads the config
  # file written below. Log and state are fixed per host so a user always knows where
  # they land (documented in docs/scheduling.md).
  TP_HOST="$label"
  TP_SUPERVISOR="$(repo_root)/scripts/supervisor.mjs"
  TP_LOG="$(target_home)/$host_dir/task-panel/supervisor.log"
  TP_STATE="$(target_home)/$host_dir/task-panel/supervisor.state.json"
  TP_ENV="$(target_home)/$host_dir/task-panel.env"
  TP_SCHED="$(target_home)/$host_dir/scheduling"
  TP_WAKE="$(target_home)/$host_dir/bin/wake-$label.sh"
  TP_CLAIM_UNASSIGNED="${TASKPANEL_CLAIM_UNASSIGNED:-yes}"
  export TP_AGENT TP_REPO TP_SHIM TP_HOOK TP_TRIGGER
  export TP_HOST TP_SUPERVISOR TP_LOG TP_STATE TP_ENV TP_SCHED TP_WAKE TP_CLAIM_UNASSIGNED
}

# claim_unassigned_value <flag> <interactive> — decide the "allow claiming unassigned
# tasks?" policy. Prints `yes` or `no`:
#
#   * an explicit <flag> (yes/no) wins, verbatim;
#   * otherwise, when <interactive> is "1" (stdin is a TTY), ask the question —
#     default yes on a blank answer;
#   * otherwise default yes.
#
# An unrecognised <flag> is a hard error, not a silent default: a misspelt policy must
# never quietly install the opposite of what was asked for.
claim_unassigned_value() {
  flag="$1"
  interactive="$2"
  case "$flag" in
    yes | no)
      printf '%s\n' "$flag"
      return 0
      ;;
    "")
      ;;
    *)
      echo "--claim-unassigned must be yes or no (got '$flag')." >&2
      return 1
      ;;
  esac

  if [ "$interactive" = "1" ]; then
    printf 'Allow claiming unassigned tasks? [Y/n] ' >&2
    answer=""
    read -r answer || answer=""
    case "$answer" in
      "" | [Yy]*) printf 'yes\n' ;;
      *) printf 'no\n' ;;
    esac
    return 0
  fi

  printf 'yes\n'
}

# install_scheduling — drop the poll/patrol units and the per-host wake glue, then
# print the exact command that loads them. The installer never runs `launchctl` /
# `systemctl` / `crontab` itself: enabling a daemon is the user's call, and a test or
# `--dry-run` must have no side effects. Requires export_tp_env first.
install_scheduling() {
  emit_file "scheduling/launchd/com.taskpanel.poll.plist" "$TP_SCHED/launchd/com.taskpanel.poll.plist"
  emit_file "scheduling/launchd/com.taskpanel.patrol.plist" "$TP_SCHED/launchd/com.taskpanel.patrol.plist"
  emit_file "scheduling/systemd/taskpanel-poll.service" "$TP_SCHED/systemd/taskpanel-poll.service"
  emit_file "scheduling/systemd/taskpanel-poll.timer" "$TP_SCHED/systemd/taskpanel-poll.timer"
  emit_file "scheduling/systemd/taskpanel-patrol.service" "$TP_SCHED/systemd/taskpanel-patrol.service"
  emit_file "scheduling/systemd/taskpanel-patrol.timer" "$TP_SCHED/systemd/taskpanel-patrol.timer"
  emit_file "scheduling/cron/taskpanel.cron" "$TP_SCHED/cron/taskpanel.cron"
  emit_file "$TP_HOST/wake-$TP_HOST.sh" "$TP_WAKE" --exec

  echo "$TP_HOST: scheduling units installed under $TP_SCHED"
  echo "$TP_HOST: to start the supervisor, load one of these (nothing is loaded for you):"
  echo "  launchd:  launchctl load $TP_SCHED/launchd/com.taskpanel.poll.plist   # and .patrol.plist"
  echo "  systemd:  mkdir -p ~/.config/systemd/user && cp $TP_SCHED/systemd/* ~/.config/systemd/user/ && systemctl --user enable --now taskpanel-poll.timer taskpanel-patrol.timer"
  echo "  cron:     crontab $TP_SCHED/cron/taskpanel.cron"
}

# write_host_config — persist the claim policy the supervisor reads by default.
# Requires export_tp_env first (TP_ENV, TP_CLAIM_UNASSIGNED).
write_host_config() {
  emit_file "host/task-panel.env" "$TP_ENV"
}

# ---------------------------------------------------------------------------
# Skill copy
# ---------------------------------------------------------------------------

# install_skill <host_dir> <label>
#   <host_dir>  dot-directory under the target home, e.g. ".claude"
#   <label>     human-readable host name, e.g. "claude"
install_skill() {
  host_dir="$1"
  label="$2"

  # Node floor first: nothing is copied onto a runtime that cannot run it.
  require_node || return 1

  src="$(repo_root)/skills/task-panel"
  target_home="$(target_home)"
  dest="$target_home/$host_dir/skills/task-panel"

  if [ ! -d "$src" ]; then
    echo "$label: skill source not found: $src" >&2
    return 1
  fi

  if [ -n "${TASKPANEL_DRY_RUN:-}" ]; then
    if [ -n "${TASKPANEL_LINK:-}" ]; then
      echo "would link  $src -> $dest"
    else
      echo "would copy  $src -> $dest"
    fi
    return 0
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -z "${TASKPANEL_FORCE:-}" ]; then
      # Idempotent: an existing skill is the desired end state, not an error. The
      # local edits are preserved (merge, never clobber); --force is the escape hatch.
      echo "$label: already installed: $dest (unchanged; re-run with --force to overwrite)"
      return 0
    fi
    rm -rf "$dest"
  fi

  mkdir -p "$(dirname "$dest")"

  if [ -n "${TASKPANEL_LINK:-}" ]; then
    ln -s "$src" "$dest"
    echo "$label: linked  $dest"
  else
    cp -R "$src" "$dest"
    echo "$label: copied  $dest"
  fi
}

# ---------------------------------------------------------------------------
# Bundle writing — templates, config merge, MCP registration
# ---------------------------------------------------------------------------

# emit_file <template_rel> <dest> [--exec]
#   Render scripts/install/templates/<template_rel> into <dest>. Idempotent.
emit_file() {
  template_rel="$1"
  dest="$2"
  exec_flag="${3:-}"

  template="$(script_dir)/templates/$template_rel"
  [ -f "$template" ] || { echo "install: template not found: $template" >&2; return 1; }

  if [ -n "${TASKPANEL_DRY_RUN:-}" ]; then
    echo "would write $dest"
    return 0
  fi

  # --force is the documented "overwrite an existing installation" escape hatch: it
  # must reach the emitted files too, or a changed --agent-name would silently no-op.
  force_flag=""
  [ -n "${TASKPANEL_FORCE:-}" ] && force_flag="--force"

  if [ -n "$exec_flag" ]; then
    node "$(apply_helper)" emit "$template" "$dest" --exec $force_flag
  else
    node "$(apply_helper)" emit "$template" "$dest" $force_flag
  fi
}

# merge_settings <settings_file>
#   Merge env.TASKCTL_AGENT and the SessionStart hook into a Claude settings.json,
#   preserving every other key. Requires TP_AGENT / TP_HOOK to be exported first.
merge_settings() {
  settings_file="$1"

  if [ -n "${TASKPANEL_DRY_RUN:-}" ]; then
    echo "would merge $settings_file (env.TASKCTL_AGENT + SessionStart hook)"
    return 0
  fi

  if [ -n "${TASKPANEL_FORCE:-}" ]; then
    node "$(apply_helper)" merge-settings "$settings_file" --agent "$TP_AGENT" --hook "$TP_HOOK" --force
  else
    node "$(apply_helper)" merge-settings "$settings_file" --agent "$TP_AGENT" --hook "$TP_HOOK"
  fi
}

# append_snippet <file> <template_rel> <marker>
#   Append a <!-- marker:begin -->…<!-- marker:end --> block (rendered) to <file>.
append_snippet() {
  file="$1"
  template_rel="$2"
  marker="$3"

  template="$(script_dir)/templates/$template_rel"
  [ -f "$template" ] || { echo "install: template not found: $template" >&2; return 1; }

  if [ -n "${TASKPANEL_DRY_RUN:-}" ]; then
    echo "would update $file (append/replace $marker block)"
    return 0
  fi

  if [ -n "${TASKPANEL_FORCE:-}" ]; then
    node "$(apply_helper)" snippet "$file" "$template" --marker "$marker" --force
  else
    node "$(apply_helper)" snippet "$file" "$template" --marker "$marker"
  fi
}

# register_mcp <cli> <label>
#   Register the stdio MCP server with the host CLI (`<cli> mcp add taskpanel -- node
#   <repo>/src/mcp/main.mjs`). Runs the CLI when it is on PATH; otherwise prints the
#   exact command. The CLI is run with HOME (and, for codex, CODEX_HOME) pointed at the
#   target home, so an isolated `--prefix` / `TASKPANEL_TARGET_HOME` install never
#   touches the real host config. An "already exists" reply is success (idempotent).
register_mcp() {
  cli="$1"
  label="$2"

  repo="$(repo_root)"
  home="$(target_home)"
  display="$cli mcp add taskpanel -- node $repo/src/mcp/main.mjs"

  if [ -n "${TASKPANEL_DRY_RUN:-}" ]; then
    echo "would run  $display"
    return 0
  fi

  if ! command -v "$cli" >/dev/null 2>&1; then
    echo "$label: '$cli' not on PATH — register MCP manually with:"
    echo "  $display"
    return 0
  fi

  out=""
  status=0
  set +e
  if [ "$cli" = "codex" ]; then
    mkdir -p "$home/.codex"
    out="$(HOME="$home" CODEX_HOME="$home/.codex" "$cli" mcp add taskpanel -- node "$repo/src/mcp/main.mjs" 2>&1)"
    status=$?
  else
    out="$(HOME="$home" "$cli" mcp add taskpanel -- node "$repo/src/mcp/main.mjs" 2>&1)"
    status=$?
  fi
  set -e

  if [ "$status" -eq 0 ]; then
    echo "$label: registered MCP server 'taskpanel'"
    return 0
  fi

  if printf '%s' "$out" | grep -qi "already exists"; then
    echo "$label: MCP server 'taskpanel' already registered"
    return 0
  fi

  # The CLI ran but did not register — report it honestly and give the manual command.
  echo "$label: MCP registration did not complete; run it manually:" >&2
  echo "  $display" >&2
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | sed 's/^/    /' >&2
  fi
  return 0
}
