#!/usr/bin/env bash
#
# Interactive installer questions (`install.sh -i`, or no arguments on a TTY).
#
# Sourced by install.sh; never executed. Every prompt, menu and warning goes to
# **stderr**; every resolved value goes to **stdout**, so callers use command
# substitution — the same contract as `claim_unassigned_value` in _common.sh.
#
# Cancellation is status 2 everywhere (`q`/`quit`/`cancel`, or EOF). EOF must
# never loop: a closed stdin cancels the install before anything is written.
#
# No top-level side effects, so test/install/wizard.test.mjs can source this
# file and call one helper at a time. `run_wizard` needs `agent_name()` from
# _common.sh, which install.sh sources first.

# wizard_should_run <interactive> <yes> <dry-run> <no-args> <stdin-tty>
#
# The single trigger decision. --dry-run never prompts; --yes wins over
# --interactive; otherwise -i forces the wizard and an argument-free TTY run
# starts it. A flagged invocation without -i keeps the legacy path.
wizard_should_run() {
  [ "${3:-}" = "1" ] && return 1
  [ "${2:-}" = "1" ] && return 1
  [ "${1:-}" = "1" ] && return 0
  [ "${4:-}" = "1" ] && [ "${5:-}" = "1" ] && return 0
  return 1
}

# _wizard_trim <text> — strip leading and trailing whitespace, builtins only.
_wizard_trim() {
  local text="${1:-}"
  text="${text#"${text%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"
  printf '%s' "$text"
}

# _wizard_read <prompt> — print the prompt to stderr, read one line.
# Prints the answer to stdout; returns 2 on EOF (never loops).
_wizard_read() {
  local answer
  printf '%s' "${1:-}" >&2
  if ! IFS= read -r answer; then
    printf '\n' >&2
    return 2
  fi
  printf '%s\n' "$answer"
}

# wizard_yesno <prompt> <yes|no> — prints "yes" or "no"; 2 = cancel.
wizard_yesno() {
  local prompt="${1}" default="${2}" hint answer
  if [ "$default" = "no" ]; then hint="[y/N]"; else hint="[Y/n]"; fi
  while :; do
    answer="$(_wizard_read "$prompt $hint ")" || return 2
    answer="$(_wizard_trim "$answer")"
    case "$answer" in
      "") printf '%s\n' "$default"; return 0 ;;
      [Yy] | [Yy][Ee][Ss] | 1) printf 'yes\n'; return 0 ;;
      [Nn] | [Nn][Oo] | 0) printf 'no\n'; return 0 ;;
      [Qq] | [Qq][Uu][Ii][Tt] | [Cc][Aa][Nn][Cc][Ee][Ll]) return 2 ;;
      *) printf '  Please answer y or n.\n' >&2 ;;
    esac
  done
}

# wizard_int <prompt> <default> <min> — prints a positive whole number.
wizard_int() {
  local prompt="${1}" default="${2}" minimum="${3}" answer digits
  while :; do
    answer="$(_wizard_read "$prompt [$default] ")" || return 2
    answer="$(_wizard_trim "$answer")"
    case "$answer" in
      [Qq] | [Qq][Uu][Ii][Tt] | [Cc][Aa][Nn][Cc][Ee][Ll]) return 2 ;;
      "") answer="$default" ;;
    esac
    case "$answer" in
      "" | *[!0-9]*)
        printf '  Please enter a whole number.\n' >&2
        continue
        ;;
    esac
    digits="${answer#"${answer%%[!0]*}"}"
    [ -n "$digits" ] || digits="0"
    # Compare length before arithmetic so a huge paste cannot overflow.
    if [ "${#digits}" -gt 9 ] || [ "$digits" -lt "$minimum" ]; then
      printf '  Please enter a number >= %s.\n' "$minimum" >&2
      continue
    fi
    printf '%s\n' "$digits"
    return 0
  done
}

# wizard_text <prompt> <default> <plain|path|name|reviewer>
#
# Blank accepts the default. `path` expands only a leading ~ or ~/. `name`
# treats q literally. `reviewer` accepts none or - to clear the value.
wizard_text() {
  local prompt="${1}" default="${2}" kind="${3}" display answer
  display="$prompt"
  [ -n "$default" ] && display="$prompt [$default]"
  answer="$(_wizard_read "$display ")" || return 2
  answer="$(_wizard_trim "$answer")"

  if [ "$kind" != "name" ]; then
    case "$answer" in
      [Qq] | [Qq][Uu][Ii][Tt] | [Cc][Aa][Nn][Cc][Ee][Ll]) return 2 ;;
    esac
  fi

  if [ "$kind" = "reviewer" ]; then
    case "$answer" in
      none | -) printf '\n'; return 0 ;;
    esac
  fi

  [ -n "$answer" ] || answer="$default"

  if [ "$kind" = "path" ]; then
    case "$answer" in
      "~") answer="${HOME:-}" ;;
      "~/"*) answer="${HOME:-}/${answer#"~/"}" ;;
    esac
  fi

  printf '%s\n' "$answer"
}

# wizard_menu <default-key> <key=label>... — prints one key; 2 = cancel.
wizard_menu() {
  local default="${1}"
  shift
  local -a keys
  local spec key index answer candidate
  keys=()
  index=1
  for spec in "$@"; do
    key="${spec%%=*}"
    keys+=("$key")
    printf '  %s) %s\n' "$index" "${spec#*=}" >&2
    index=$((index + 1))
  done

  while :; do
    answer="$(_wizard_read "Select [$default]: ")" || return 2
    answer="$(_wizard_trim "$answer")"
    [ -n "$answer" ] || { printf '%s\n' "$default"; return 0; }
    case "$answer" in
      [Qq] | [Qq][Uu][Ii][Tt] | [Cc][Aa][Nn][Cc][Ee][Ll]) return 2 ;;
    esac
    case "$answer" in
      '' | *[!0-9]*) ;;
      *)
        if [ "${#answer}" -le 3 ] && [ "$answer" -ge 1 ] && [ "$answer" -le "${#keys[@]}" ]; then
          printf '%s\n' "${keys[$((answer - 1))]}"
          return 0
        fi
        ;;
    esac
    for candidate in "${keys[@]}"; do
      if [ "$answer" = "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
    printf '  Please choose 1-%s.\n' "${#keys[@]}" >&2
  done
}

# wizard_multi <default> <key=label>... — prints comma-separated keys in menu
# order. An invalid token rejects the whole line (no partial application).
wizard_multi() {
  local default="${1}"
  shift
  local -a keys tokens
  local spec key index answer selected wanted invalid candidate output
  keys=()
  index=1
  for spec in "$@"; do
    key="${spec%%=*}"
    keys+=("$key")
    printf '  %s) %s\n' "$index" "${spec#*=}" >&2
    index=$((index + 1))
  done

  while :; do
    answer="$(_wizard_read "Select one or more (comma-separated) [$default]: ")" || return 2
    answer="$(_wizard_trim "$answer")"
    [ -n "$answer" ] || answer="$default"
    case "$answer" in
      [Qq] | [Qq][Uu][Ii][Tt] | [Cc][Aa][Nn][Cc][Ee][Ll]) return 2 ;;
    esac

    # `read -a` splits on commas/spaces without pathname expansion, so a
    # literal `*` stays `*` instead of being globbed against the cwd.
    tokens=()
    IFS=' ,' read -r -a tokens <<< "$answer"
    selected=" "
    invalid=""
    for token in "${tokens[@]}"; do
      case "$token" in
        all | '*')
          for candidate in "${keys[@]}"; do selected="$selected$candidate "; done
          continue
          ;;
      esac
      wanted=""
      case "$token" in
        '' | *[!0-9]*) ;;
        *)
          if [ "${#token}" -le 3 ] && [ "$token" -ge 1 ] && [ "$token" -le "${#keys[@]}" ]; then
            wanted="${keys[$((token - 1))]}"
          fi
          ;;
      esac
      if [ -z "$wanted" ]; then
        for candidate in "${keys[@]}"; do
          if [ "$token" = "$candidate" ]; then wanted="$candidate"; break; fi
        done
      fi
      if [ -z "$wanted" ]; then
        invalid="$token"
        break
      fi
      case "$selected" in
        *" $wanted "*) ;;
        *) selected="$selected$wanted " ;;
      esac
    done

    if [ -n "$invalid" ]; then
      printf '  Unknown choice: %s. Please choose 1-%s or a name.\n' "$invalid" "${#keys[@]}" >&2
      continue
    fi
    case "$selected" in
      " " | "") printf '  Select at least one.\n' >&2; continue ;;
    esac

    output=""
    for candidate in "${keys[@]}"; do
      case "$selected" in
        *" $candidate "*) output="${output:+$output,}$candidate" ;;
      esac
    done
    printf '%s\n' "$output"
    return 0
  done
}

# wizard_targets <default-mode> <default-agents> <no-server> <prefix>
#
# Two steps: the install shape, then (unless server-only) the agent kinds.
# Prints the comma-separated target list install.sh expects.
wizard_targets() {
  local default_mode="${1}" default_agents="${2}" no_server="${3}" prefix="${4}"
  local mode agents

  if [ -n "$no_server" ]; then
    mode="skills"
    printf '\n--no-server: agent skills only (no local server tree).\n' >&2
  else
    printf '\nInstall mode — what this run installs\n' >&2
    mode="$(wizard_menu "$default_mode" \
      'full=full install — the runtime tree (taskd + taskctl) and the selected agent skills' \
      'skills=skills only — the selected agent skills, no local server' \
      'server=server only — the runtime tree and taskctl, no agent skills')" || return 2
  fi

  if [ "$mode" = "server" ]; then
    printf 'server\n'
    return 0
  fi

  printf '\nAgent kinds — each gets the board skill; claude/codex/pi also get the loop\n' >&2
  agents="$(wizard_multi "$default_agents" \
    "claude=claude     ${prefix}/.claude/skills/meerkat-taskpanel (board + loop + setup)" \
    "openclaw=openclaw   ${prefix}/.openclaw/skills/meerkat-taskpanel (board only; no loop or supervisor)" \
    "codex=codex      ${prefix}/.codex/skills/meerkat-taskpanel (board + loop, claim trigger)" \
    "pi=pi         ${prefix}/.agents/skills/meerkat-taskpanel (board + loop)")" || return 2

  if [ "$mode" = "full" ]; then
    printf 'server,%s\n' "$agents"
  else
    printf '%s\n' "$agents"
  fi
}

# The built-in defaults, kept in step with claim_unassigned_value /
# supervisor_value in _common.sh.
_wizard_default_yes() {
  case "${1:-}" in
    no) printf 'no' ;;
    *) printf 'yes' ;;
  esac
}

_wizard_supervisor_default() {
  case "${1:-}" in
    enable | disable | status) printf '%s' "$1" ;;
    *) printf 'none' ;;
  esac
}

# run_wizard — ask every question and write the answers into install.sh's
# globals (and the matching MEERKAT_TASKPANEL_* fallbacks, so an empty answer
# cannot be resurrected from the environment). 0 = answered; 2 = cancelled.
#
# Agent name, reviewer and the two intervals are deliberately NOT asked: they
# are config-file edits (`<program root>/.env.<actor-kind>`, or `TASKCTL_AGENT`
# in the agent settings).
run_wizard() {
  local prefix targets answer target raw entry saved_ifs
  local has_agent has_loop has_server saw_server
  local default_prefix default_agents default_mode

  # install.sh initialises all of these; default them here too so run_wizard is
  # usable on its own (the tests call it directly) under `set -u`.
  CLAIM_UNASSIGNED_FLAG="${CLAIM_UNASSIGNED_FLAG:-}"
  RECOVER_STALE_FLAG="${RECOVER_STALE_FLAG:-}"
  WORKFLOW_FLAG="${WORKFLOW_FLAG:-}"
  CONTINUE_FLAG="${CONTINUE_FLAG:-}"
  SUPERVISOR_FLAG="${SUPERVISOR_FLAG:-}"
  SCHEDULER_FLAG="${SCHEDULER_FLAG:-}"
  LINK="${LINK:-}"
  SKIP_WEB_BUILD="${SKIP_WEB_BUILD:-}"

  default_prefix="${PREFIX_HOME:-${MEERKAT_TASKPANEL_TARGET_HOME:-${HOME:-}}}"

  # Derive the mode/agent prefills from --target / --no-server.
  default_agents=""
  default_mode="skills"
  saw_server=""
  saved_ifs="$IFS"
  IFS=','
  for raw in ${TARGET:-all}; do
    IFS="$saved_ifs"
    entry="$(printf '%s' "$raw" | tr -d '[:space:]')"
    IFS=','
    case "$entry" in
      "")
        ;;
      all)
        default_agents="claude,openclaw,codex,pi"
        saw_server="1"
        ;;
      server)
        saw_server="1"
        ;;
      *)
        default_agents="${default_agents:+$default_agents,}$entry"
        ;;
    esac
  done
  IFS="$saved_ifs"
  if [ -n "$saw_server" ]; then
    default_mode="full"
  fi
  if [ -z "$default_agents" ] && [ -n "$saw_server" ]; then
    default_mode="server"
  fi
  if [ -z "$default_agents" ] && [ -z "$saw_server" ]; then
    default_agents="claude,openclaw,codex,pi"
  fi
  if [ -n "${NO_SERVER:-}" ]; then
    default_mode="skills"
    [ -n "$default_agents" ] || default_agents="claude,openclaw,codex,pi"
  fi

  printf '\nMeerkat TaskPanel installer — interactive setup\n' >&2
  printf 'Press Enter to accept a default; q cancels.\n\n' >&2

  prefix="$(wizard_text 'Install root (the server tree and agent skills live under it)' "$default_prefix" path)" || return 2
  PREFIX_HOME="$prefix"

  targets="$(wizard_targets "$default_mode" "$default_agents" "${NO_SERVER:-}" "$prefix")" || return 2
  TARGET="$targets"

  has_agent=0
  has_loop=0
  has_server=0
  saved_ifs="$IFS"
  IFS=','
  for target in $targets; do
    case "$target" in
      claude | codex | pi) has_agent=1; has_loop=1 ;;
      openclaw) has_agent=1 ;;
      server) has_server=1 ;;
    esac
  done
  IFS="$saved_ifs"

  # Always asked: the human name is used by the agent shims AND recorded as
  # TASKCTL_HUMAN in the server tree's `.env` (the UI/CLI actor identity).
  MEERKAT_TASKPANEL_HUMAN_NAME="$(wizard_text 'Your name on the board (the human these writes are attributed to)' "$(human_name)" plain)" || return 2
  export MEERKAT_TASKPANEL_HUMAN_NAME

  if [ "$has_agent" = "1" ]; then
    printf '\nBoard skill install style\n' >&2
    answer="$(wizard_menu "$([ -n "${LINK:-}" ] && printf link || printf copy)" \
      'copy=copy — a stable snapshot (recommended)' \
      'link=symlink — live edits from this checkout (development)')" || return 2
    if [ "$answer" = "link" ]; then LINK="1"; else LINK=""; fi
  fi

  if [ "$has_server" = "1" ]; then
    answer="$(wizard_yesno 'Build the board UI (web/dist) if it is missing? (no = API-only server)' \
      "$([ -n "${SKIP_WEB_BUILD:-}" ] && printf no || printf yes)")" || return 2
    if [ "$answer" = "no" ]; then SKIP_WEB_BUILD="1"; else SKIP_WEB_BUILD=""; fi
  fi

  if [ "$has_loop" = "1" ]; then
    CLAIM_UNASSIGNED_FLAG="$(wizard_yesno 'Allow claiming unassigned cards from the public pool? (no = only cards assigned to this agent)' \
      "$(_wizard_default_yes "${CLAIM_UNASSIGNED_FLAG:-${MEERKAT_TASKPANEL_CLAIM_UNASSIGNED:-}}")")" || return 2

    RECOVER_STALE_FLAG="$(wizard_yesno 'Automatically recover stale in_progress cards? (no = SLA alert only)' \
      "$(_wizard_default_yes "${RECOVER_STALE_FLAG:-${MEERKAT_TASKPANEL_RECOVER_STALE:-}}")")" || return 2

    WORKFLOW_FLAG="$(wizard_yesno 'Run the supervisor workflow pass? (no = no reconcile, review dispatch or verdicts)' \
      "$(_wizard_default_yes "${WORKFLOW_FLAG:-${MEERKAT_TASKPANEL_WORKFLOW:-}}")")" || return 2

    CONTINUE_FLAG="$(wizard_yesno 'Enable the continue turn? (no = only the ping clock runs)' \
      "$(_wizard_default_yes "${CONTINUE_FLAG:-${MEERKAT_TASKPANEL_CONTINUE:-}}")")" || return 2

    printf '\nSupervisor daemon\n' >&2
    answer="$(wizard_menu "$(_wizard_supervisor_default "${SUPERVISOR_FLAG:-${MEERKAT_TASKPANEL_SUPERVISOR:-}}")" \
      'none=leave it alone — write the units and print the load command' \
      'enable=enable now — load the daemon and its clocks' \
      'disable=disable now — unload and remove the units' \
      'status=report status — change nothing')" || return 2
    if [ "$answer" = "none" ]; then SUPERVISOR_FLAG=""; else SUPERVISOR_FLAG="$answer"; fi

    if [ -n "$SUPERVISOR_FLAG" ]; then
      printf '\nScheduler for the supervisor\n' >&2
      SCHEDULER_FLAG="$(wizard_menu "${SCHEDULER_FLAG:-${MEERKAT_TASKPANEL_SCHEDULER:-auto}}" \
        'auto=auto-detect (launchd on macOS, systemd on Linux, cron elsewhere)' \
        'launchd=launchd (macOS)' \
        'systemd=systemd --user (Linux)' \
        'cron=cron (other systems)')" || return 2
    fi
  fi

  # Mirror the answers into the environment fallbacks. Agent name, reviewer and
  # the two intervals stay untouched so an inherited or config-file value wins.
  MEERKAT_TASKPANEL_CLAIM_UNASSIGNED="$CLAIM_UNASSIGNED_FLAG"
  MEERKAT_TASKPANEL_RECOVER_STALE="$RECOVER_STALE_FLAG"
  MEERKAT_TASKPANEL_WORKFLOW="$WORKFLOW_FLAG"
  MEERKAT_TASKPANEL_CONTINUE="$CONTINUE_FLAG"
  MEERKAT_TASKPANEL_SUPERVISOR="$SUPERVISOR_FLAG"
  MEERKAT_TASKPANEL_SCHEDULER="$SCHEDULER_FLAG"
  MEERKAT_TASKPANEL_LINK="$LINK"
  MEERKAT_TASKPANEL_SKIP_WEB_BUILD="$SKIP_WEB_BUILD"
  export MEERKAT_TASKPANEL_CLAIM_UNASSIGNED MEERKAT_TASKPANEL_RECOVER_STALE \
    MEERKAT_TASKPANEL_WORKFLOW MEERKAT_TASKPANEL_CONTINUE MEERKAT_TASKPANEL_SUPERVISOR \
    MEERKAT_TASKPANEL_SCHEDULER MEERKAT_TASKPANEL_LINK MEERKAT_TASKPANEL_SKIP_WEB_BUILD

  printf '\ninstall.sh: targets %s; prefix %s\n' "$TARGET" "$PREFIX_HOME" >&2
  printf 'install.sh: human %s\n' "${MEERKAT_TASKPANEL_HUMAN_NAME:-$(human_name)}" >&2
  printf 'install.sh: claim %s; recover %s; workflow %s\n' \
    "$CLAIM_UNASSIGNED_FLAG" "$RECOVER_STALE_FLAG" "$WORKFLOW_FLAG" >&2
  printf 'install.sh: continue %s; supervisor %s; scheduler %s\n\n' \
    "$CONTINUE_FLAG" "${SUPERVISOR_FLAG:-none}" "${SCHEDULER_FLAG:-auto}" >&2
  return 0
}
