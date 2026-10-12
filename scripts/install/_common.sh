#!/usr/bin/env bash
#
# Shared implementation for the per-host installers (claude / openclaw / codex / pi).
#
# Two skills are distributed, and each host takes the ones that fit it:
#
#   * `meerkat-taskpanel` — the board. Every host installs it (`install_skill`).
#   * `meerkat-loop` — the host-external supervisor. claude, codex and pi install it
#     (`install_loop_skill` + `install_scheduling`); **OpenClaw does not**, because the
#     openclaw-team framework already ships `poll-<agent>` / `task-patrol`, which is the
#     same design — see `scripts/install/openclaw.sh` and docs/scheduling.md.
#
# Each host script sources this file and calls the pieces it needs. The two bundle hosts
# (claude, codex) add the config / command / trigger helpers below; the two skill-only
# hosts (openclaw, pi) do not (pi still takes the loop, OpenClaw takes neither).
#
# Honours:
#
#   MEERKAT_TASKPANEL_TARGET_HOME  base home directory (default: $HOME)
#   MEERKAT_TASKPANEL_AGENT_NAME   agent identity for the bundle (default: $USER)
#   MEERKAT_TASKPANEL_LINK         "1" to symlink instead of copy
#   MEERKAT_TASKPANEL_FORCE        "1" to overwrite an existing destination / managed key
#   MEERKAT_TASKPANEL_DRY_RUN      "1" to print what would happen and change nothing
#   MEERKAT_TASKPANEL_NO_AUTOMATION "1" to skip the Codex claim trigger
#   MEERKAT_TASKPANEL_MIN_NODE     required Node major (default: 22)
#   MEERKAT_TASKPANEL_SKIP_NODE_CHECK  "1" to skip the Node version check
#
# Everything is **idempotent**: re-running an installer with the same inputs leaves
# the destination unchanged and exits 0. Existing files and configuration keys are
# never clobbered unless `MEERKAT_TASKPANEL_FORCE` is set.

set -eu

# legacy-name-compat: the pre-rename TASKPANEL_* variables are still honoured —
# the rename to MEERKAT_TASKPANEL_* is a migration, and an existing profile or
# wrapper script must keep working. The new name wins when both are set. Read
# once, here, so every helper below sees a single spelling.
MEERKAT_TASKPANEL_TARGET_HOME="${MEERKAT_TASKPANEL_TARGET_HOME:-${TASKPANEL_TARGET_HOME:-}}"
MEERKAT_TASKPANEL_AGENT_NAME="${MEERKAT_TASKPANEL_AGENT_NAME:-${TASKPANEL_AGENT_NAME:-}}"
MEERKAT_TASKPANEL_LINK="${MEERKAT_TASKPANEL_LINK:-${TASKPANEL_LINK:-}}"
MEERKAT_TASKPANEL_FORCE="${MEERKAT_TASKPANEL_FORCE:-${TASKPANEL_FORCE:-}}"
MEERKAT_TASKPANEL_DRY_RUN="${MEERKAT_TASKPANEL_DRY_RUN:-${TASKPANEL_DRY_RUN:-}}"
MEERKAT_TASKPANEL_NO_AUTOMATION="${MEERKAT_TASKPANEL_NO_AUTOMATION:-${TASKPANEL_NO_AUTOMATION:-}}"
MEERKAT_TASKPANEL_MIN_NODE="${MEERKAT_TASKPANEL_MIN_NODE:-${TASKPANEL_MIN_NODE:-}}"
MEERKAT_TASKPANEL_SKIP_NODE_CHECK="${MEERKAT_TASKPANEL_SKIP_NODE_CHECK:-${TASKPANEL_SKIP_NODE_CHECK:-}}"
MEERKAT_TASKPANEL_CLAIM_UNASSIGNED="${MEERKAT_TASKPANEL_CLAIM_UNASSIGNED:-${TASKPANEL_CLAIM_UNASSIGNED:-}}"
export MEERKAT_TASKPANEL_TARGET_HOME MEERKAT_TASKPANEL_AGENT_NAME MEERKAT_TASKPANEL_LINK \
  MEERKAT_TASKPANEL_FORCE MEERKAT_TASKPANEL_DRY_RUN MEERKAT_TASKPANEL_NO_AUTOMATION \
  MEERKAT_TASKPANEL_MIN_NODE MEERKAT_TASKPANEL_SKIP_NODE_CHECK MEERKAT_TASKPANEL_CLAIM_UNASSIGNED

# is_int64 <value> — 0 when <value> is a non-negative integer that fits in a
# signed 64-bit integer (the width bash's `[ … -lt … ]` test arithmetic uses),
# 1 otherwise. Leading zeros are accepted ("007" is 7, "000" is 0). Both
# MEERKAT_TASKPANEL_MIN_NODE and the `node -v` major are checked through here so the
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
  [ "${MEERKAT_TASKPANEL_SKIP_NODE_CHECK:-}" = "1" ] && return 0
  # D-R1: `:-` treats an *empty* MEERKAT_TASKPANEL_MIN_NODE exactly like an unset one —
  # both fall back to the default 22 (shell convention; an empty env var is a
  # normal way to say "default"). Use `${MEERKAT_TASKPANEL_MIN_NODE-22}` plus a separate
  # empty check if a set-but-empty value ever needs distinct handling.
  min="${MEERKAT_TASKPANEL_MIN_NODE:-22}"

  # D1a: the floor must be a non-negative integer that fits the comparison
  # width (64-bit). A bad value here — non-numeric, empty, or overflowing —
  # would make `[ "$major" -lt "$min" ]` below error inside the `if`, which
  # takes the false branch and lets a too-old Node through: a silent fail-open.
  # Validate it up front so a misspelt or overflowing env is a hard failure,
  # never a pass.
  if ! is_int64 "$min"; then
    echo "MEERKAT_TASKPANEL_MIN_NODE must be a non-negative integer up to 9223372036854775807 (got '${min:-<empty>}')." >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "node: no 'node' on PATH." >&2
    echo "Meerkat TaskPanel needs Node >= $min (the engine uses the built-in node:sqlite module)." >&2
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
    echo "Meerkat TaskPanel needs Node >= $min." >&2
    return 1
  fi

  if [ "$major" -lt "$min" ]; then
    echo "node: $version is too old — Meerkat TaskPanel needs Node >= $min." >&2
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
target_home() { printf '%s\n' "${MEERKAT_TASKPANEL_TARGET_HOME:-$HOME}"; }
apply_helper() { printf '%s\n' "$(script_dir)/lib/apply.mjs"; }

# loop_src — the loop skill's source, which owns the loop body and the loop's templates.
#
# The loop is a skill of its own (skills/meerkat-loop/): its execution body and the units /
# wake / config templates it is deployed with are *generated* into it from this repository's
# scripts/, src/shared/ and scripts/install/templates/, and guarded by
# `node scripts/sync-skills.mjs --check`. The installer reads them from there rather than
# from this repository's own scripts/ — so what is deployed is exactly what was distributed
# and verified, not a second reading of the same inputs.
loop_src() { printf '%s\n' "$(repo_root)/skills/meerkat-loop"; }

# board_skill_name / loop_skill_name — the two skills this installer distributes.
board_skill_name() { printf '%s\n' "meerkat-taskpanel"; }
loop_skill_name() { printf '%s\n' "meerkat-loop"; }

# agent_name — the identity written into the host bundle.
#
# `--agent-name` (MEERKAT_TASKPANEL_AGENT_NAME) wins; the default is $USER, then $LOGNAME,
# then a stable "agent" placeholder. The name is the board assignee: claiming a card
# checks `assignee == actor`, so this is the name the agent must be assigned cards as.
agent_name() {
  local name="${MEERKAT_TASKPANEL_AGENT_NAME:-}"
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
  TP_HOOK="$(target_home)/$host_dir/hooks/meerkat-taskpanel-session-start.sh"
  TP_TRIGGER="$(target_home)/$host_dir/meerkat-taskpanel-claim.sh"
  # The host-external supervisor: the scheduling units run it, and it reads the config
  # file written below. Log and state are fixed per host so a user always knows where
  # they land (documented in docs/scheduling.md).
  #
  # The executor the units name is a **host-local copy**, not this checkout's own file:
  # `install_scheduling` copies the loop body into `$TP_LOOP` (see `install_loop_body`),
  # so a unit a user has already loaded keeps working after the checkout is moved,
  # renamed or removed — and never has to be reloaded for that.
  TP_HOST="$label"
  TP_LOOP="$(target_home)/$host_dir/meerkat-taskpanel"
  TP_SUPERVISOR="$TP_LOOP/scripts/supervisor.mjs"
  TP_LOG="$TP_LOOP/supervisor.log"
  TP_STATE="$TP_LOOP/supervisor.state.json"
  TP_ENV="$(target_home)/$host_dir/meerkat-taskpanel.env"
  TP_SCHED="$(target_home)/$host_dir/scheduling"
  TP_WAKE="$(target_home)/$host_dir/bin/wake-$label.sh"
  TP_CLAIM_UNASSIGNED="${MEERKAT_TASKPANEL_CLAIM_UNASSIGNED:-yes}"
  export TP_AGENT TP_REPO TP_SHIM TP_HOOK TP_TRIGGER
  export TP_HOST TP_LOOP TP_SUPERVISOR TP_LOG TP_STATE TP_ENV TP_SCHED TP_WAKE TP_CLAIM_UNASSIGNED
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

# install_loop_body — copy the loop execution body into the host. Requires
# export_tp_env first (TP_LOOP, TP_HOST).
#
# The scheduling units run whatever path `TP_SUPERVISOR` names. When that path was
# this checkout's own `scripts/supervisor.mjs`, moving, renaming or deleting the
# checkout left every loaded unit pointing at a file that was gone: the loop died
# with the directory, and reviving it meant reinstalling *and* reloading the unit.
# The body now lives in the host, and the units name that copy:
#
#   <home>/<host-dir>/meerkat-taskpanel/scripts/supervisor.mjs   the executor
#   <home>/<host-dir>/meerkat-taskpanel/scripts/wake-cwd.mjs     the glue's resolver
#   <home>/<host-dir>/meerkat-taskpanel/src/shared/*.mjs         their imports
#
# The `scripts/` + `src/shared/` shape is load-bearing, not decoration: the body's
# modules import each other relatively (`../src/shared/scheduling.mjs`), so a copy of
# one file would resolve a relative import to nothing and the unit would die at load.
# The set to copy is **not** restated here — it is read from the loop skill's generated
# `body/manifest.txt`, which is the closure itself (computed from the two entry points'
# imports by `scripts/sync-loop.mjs` and guarded by `--check`). One source, so a new
# import in the body cannot leave bash — or the test that proves the copy is closed —
# silently behind.
#
# The board engine the executor drives (`taskctl`) still lives in the checkout: the
# host config records where, so a host-installed executor still finds it. Moving the
# checkout is then a re-run of `install.sh` away — no unit reload, because the unit
# never named the checkout in the first place.
#
# Merge-never-clobber like every other installed artefact: a member whose content
# already matches is left untouched; a differing one is left alone without `--force`.
# `--dry-run` says which of the two it would be, so drift is reportable without writing.
install_loop_body() {
  manifest="$(loop_src)/body/manifest.txt"
  if [ ! -f "$manifest" ]; then
    echo "$TP_HOST: loop body manifest not found: $manifest" >&2
    echo "$TP_HOST: run 'node scripts/sync-skills.mjs' in the checkout and retry." >&2
    return 1
  fi

  while read -r rel; do
    [ -n "$rel" ] || continue
    src="$(loop_src)/body/$rel"
    dest="$TP_LOOP/$rel"

    if [ ! -f "$src" ]; then
      echo "$TP_HOST: loop source not found: $src" >&2
      return 1
    fi

    if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
      if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
        echo "would keep  $dest (already current)"
      fi
      continue
    fi

    if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
      if [ -f "$dest" ]; then
        echo "would refresh $dest (differs from the loop skill — --force applies it)"
      else
        echo "would copy  $src -> $dest"
      fi
      continue
    fi

    if [ -f "$dest" ] && [ -z "${MEERKAT_TASKPANEL_FORCE:-}" ]; then
      echo "$TP_HOST: loop body kept: $dest (differs from the loop skill — re-run with --force to refresh)"
      continue
    fi

    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "$TP_HOST: copied  $dest"
  done < "$manifest"
}

# install_scheduling — drop the loop body, the poll/patrol units and the per-host wake
# glue, then print the exact command that loads them. The installer never runs
# `launchctl` / `systemctl` / `crontab` itself: enabling a daemon is the user's call,
# and a test or `--dry-run` must have no side effects. Requires export_tp_env first.
#
# Every template here comes from the **loop** skill (`emit_loop_file`), not from this
# installer's own templates: the units, the wake glues and the host config are the loop's
# payload, and deploying the copy the loop skill distributes is what keeps "what shipped"
# and "what was verified" the same bytes.
install_scheduling() {
  install_loop_body

  emit_loop_file "scheduling/launchd/com.meerkat-taskpanel.poll.plist" "$TP_SCHED/launchd/com.meerkat-taskpanel.poll.plist"
  emit_loop_file "scheduling/launchd/com.meerkat-taskpanel.patrol.plist" "$TP_SCHED/launchd/com.meerkat-taskpanel.patrol.plist"
  emit_loop_file "scheduling/systemd/meerkat-taskpanel-poll.service" "$TP_SCHED/systemd/meerkat-taskpanel-poll.service"
  emit_loop_file "scheduling/systemd/meerkat-taskpanel-poll.timer" "$TP_SCHED/systemd/meerkat-taskpanel-poll.timer"
  emit_loop_file "scheduling/systemd/meerkat-taskpanel-patrol.service" "$TP_SCHED/systemd/meerkat-taskpanel-patrol.service"
  emit_loop_file "scheduling/systemd/meerkat-taskpanel-patrol.timer" "$TP_SCHED/systemd/meerkat-taskpanel-patrol.timer"
  emit_loop_file "scheduling/cron/meerkat-taskpanel.cron" "$TP_SCHED/cron/meerkat-taskpanel.cron"
  emit_loop_file "$TP_HOST/wake-$TP_HOST.sh" "$TP_WAKE" --exec

  echo "$TP_HOST: scheduling units installed under $TP_SCHED"
  echo "$TP_HOST: to start the supervisor, load one of these (nothing is loaded for you):"
  echo "  launchd:  launchctl load $TP_SCHED/launchd/com.meerkat-taskpanel.poll.plist   # and .patrol.plist"
  echo "  systemd:  mkdir -p ~/.config/systemd/user && cp $TP_SCHED/systemd/* ~/.config/systemd/user/ && systemctl --user enable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer"
  echo "  cron:     crontab $TP_SCHED/cron/meerkat-taskpanel.cron"
}

# ensure_env_key <key> <value> — add a KEY=value line to the host config when the key
# is missing, and never touch one that is already there. That is the same
# merge-not-clobber contract `merge_settings` follows for `env.TASKCTL_AGENT`: adding
# a key the file lacks is not a clobber. Requires TP_ENV, TP_HOST.
#
# It exists because the config is written once and then left alone — a differing file
# is skipped without `--force` — so without this an install that predates a key would
# never learn it, and a host-installed executor would have no way to find the board
# engine it drives.
ensure_env_key() {
  key="$1"
  value="$2"

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "would ensure $key in $TP_ENV"
    return 0
  fi

  if [ -f "$TP_ENV" ] && grep -q "^${key}=" "$TP_ENV"; then
    return 0
  fi

  printf '%s=%s\n' "$key" "$value" >> "$TP_ENV"
  echo "$TP_HOST: recorded $key in $TP_ENV"
}

# write_host_config — persist the claim policy the supervisor reads by default, and the
# location of the board engine a host-installed executor drives. Requires export_tp_env
# first (TP_ENV, TP_CLAIM_UNASSIGNED, TP_REPO). The template belongs to the loop skill:
# the supervisor is what reads it.
write_host_config() {
  emit_loop_file "host/meerkat-taskpanel.env" "$TP_ENV"
  ensure_env_key "MEERKAT_TASKPANEL_REPO" "$TP_REPO"
}

# ---------------------------------------------------------------------------
# Skill copy
# ---------------------------------------------------------------------------

# install_skill <host_dir> <label> [skill] [copy-only]
#   <host_dir>   dot-directory under the target home, e.g. ".claude"
#   <label>      human-readable host name, e.g. "claude"
#   <skill>      skill directory name under skills/ (default: the board skill)
#   <copy-only>  "copy" to refuse `--link` for this skill (the loop uses it)
install_skill() {
  host_dir="$1"
  label="$2"
  skill="${3:-$(board_skill_name)}"
  mode="${4:-}"

  # Node floor first: nothing is copied onto a runtime that cannot run it.
  require_node || return 1

  src="$(repo_root)/skills/$skill"
  target_home="$(target_home)"
  dest="$target_home/$host_dir/skills/$skill"

  # `--link` names the **board** skill only (O6). The loop must always be a real copy:
  # a symlinked loop would put the checkout back in the load path of the very thing the
  # split exists to make independent of it.
  link="${MEERKAT_TASKPANEL_LINK:-}"
  [ "$mode" = "copy" ] && link=""

  if [ ! -d "$src" ]; then
    echo "$label: skill source not found: $src" >&2
    return 1
  fi

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    if [ -n "$link" ]; then
      echo "would link  $src -> $dest"
    else
      echo "would copy  $src -> $dest"
    fi
    return 0
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -z "${MEERKAT_TASKPANEL_FORCE:-}" ]; then
      # Idempotent: an existing skill is the desired end state, not an error. The
      # local edits are preserved (merge, never clobber); --force is the escape hatch.
      echo "$label: already installed: $dest (unchanged; re-run with --force to overwrite)"
      return 0
    fi
    rm -rf "$dest"
  fi

  mkdir -p "$(dirname "$dest")"

  if [ -n "$link" ]; then
    ln -s "$src" "$dest"
    echo "$label: linked  $dest"
  else
    cp -R "$src" "$dest"
    echo "$label: copied  $dest"
  fi
}

# install_loop_skill <host_dir> <label>
#   The loop skill, for the hosts that run an external supervisor. Always a copy (O6);
#   OpenClaw never calls this — its framework already ships an equivalent supervisor, so
#   a second one would only race the first for the same cards.
install_loop_skill() {
  install_skill "$1" "$2" "$(loop_skill_name)" copy
}

# ---------------------------------------------------------------------------
# Bundle writing — templates, config merge
# ---------------------------------------------------------------------------

# emit_from <templates_root> <template_rel> <dest> [--exec]
#   Render <templates_root>/<template_rel> into <dest>. Idempotent.
emit_from() {
  templates_root="$1"
  template_rel="$2"
  dest="$3"
  exec_flag="${4:-}"

  template="$templates_root/$template_rel"
  [ -f "$template" ] || { echo "install: template not found: $template" >&2; return 1; }

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "would write $dest"
    return 0
  fi

  # --force is the documented "overwrite an existing installation" escape hatch: it
  # must reach the emitted files too, or a changed --agent-name would silently no-op.
  force_flag=""
  [ -n "${MEERKAT_TASKPANEL_FORCE:-}" ] && force_flag="--force"

  if [ -n "$exec_flag" ]; then
    node "$(apply_helper)" emit "$template" "$dest" --exec $force_flag
  else
    node "$(apply_helper)" emit "$template" "$dest" $force_flag
  fi
}

# emit_file <template_rel> <dest> [--exec]
#   Render this installer's own template (scripts/install/templates/<rel>) into <dest>.
#   These are the **board** templates: the host's session-start hook and slash commands,
#   the Codex trigger and AGENTS.md snippet, the taskctl shims.
emit_file() { emit_from "$(script_dir)/templates" "$@"; }

# emit_loop_file <template_rel> <dest> [--exec]
#   Render the **loop** skill's template (skills/meerkat-loop/templates/<rel>) into <dest>:
#   the scheduling units, the wake glues and the host config. Same relative layout as the
#   installer's own (host/wake-claude.sh, scheduling/cron/…), so a call site reads the same
#   either way — the difference is which skill owns the file.
emit_loop_file() { emit_from "$(loop_src)/templates" "$@"; }

# merge_settings <settings_file>
#   Merge env.TASKCTL_AGENT and the SessionStart hook into a Claude settings.json,
#   preserving every other key. Requires TP_AGENT / TP_HOOK to be exported first.
merge_settings() {
  settings_file="$1"

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "would merge $settings_file (env.TASKCTL_AGENT + SessionStart hook)"
    return 0
  fi

  if [ -n "${MEERKAT_TASKPANEL_FORCE:-}" ]; then
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

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "would update $file (append/replace $marker block)"
    return 0
  fi

  if [ -n "${MEERKAT_TASKPANEL_FORCE:-}" ]; then
    node "$(apply_helper)" snippet "$file" "$template" --marker "$marker" --force
  else
    node "$(apply_helper)" snippet "$file" "$template" --marker "$marker"
  fi
}
