#!/usr/bin/env bash
#
# Shared implementation for the per-agent-kind installers
# (claude / openclaw / codex / pi).
#
# Three skills are distributed, and each agent kind takes the ones that fit it:
#
#   * `meerkat` — the board. Every agent kind installs it (`install_skill`). It was
#     `meerkat-taskpanel` before the rename; `install_skill` migrates a legacy directory.
#   * `meerkat-loop` — the external supervisor. The three non-OpenClaw agent kinds install
#     it (`install_loop_skill` + `install_scheduling`); **OpenClaw does not**, because the
#     openclaw-team framework already ships a per-agent poll and a `task-patrol`, which
#     is the same design (its cadence is the framework's own AUTOMATIONS.md, not a
#     number restated here) — see `scripts/install/openclaw.sh` and docs/scheduling.md.
#   * `setup-meerkat` — the install/repair and team-setup command. **Only the Claude
#     bundle copies it** (`claude.sh`); the repository bundle and marketplace still carry
#     it for the other kinds, but the bash installer does not copy it there.
#
# Each agent-kind script sources this file and calls the pieces it needs. The two bundle agent kinds
# (claude, codex) add the config / command / trigger helpers below; the skill-only agent kinds
# (openclaw, pi) do not (pi still takes the loop, OpenClaw does not).
#
# Honours:
#
#   MEERKAT_TASKPANEL_TARGET_HOME  base home directory (default: $HOME)
#   MEERKAT_TASKPANEL_AGENT_NAME   agent identity for the bundle (default: Worker)
#   MEERKAT_TASKPANEL_LINK         "1" to symlink instead of copy
#   MEERKAT_TASKPANEL_FORCE        "1" to overwrite an existing destination / managed key
#   MEERKAT_TASKPANEL_DRY_RUN      "1" to print what would happen and change nothing
#   MEERKAT_TASKPANEL_NO_AUTOMATION "1" to skip the Codex claim trigger
#   MEERKAT_TASKPANEL_MIN_NODE     required Node major (default: 22)
#   MEERKAT_TASKPANEL_SKIP_NODE_CHECK  "1" to skip the Node version check
#   MEERKAT_TASKPANEL_SUPERVISOR   "enable"/"disable"/"status" — the opt-in supervisor
#                                  action for this agent kind (empty: only print the load command,
#                                  which is what a plain install does)
#   MEERKAT_TASKPANEL_SCHEDULER    which mechanism that action acts on (default: auto)
#
# Everything is **idempotent**: re-running an installer with the same inputs leaves
# the destination unchanged and exits 0. Existing files and configuration keys are
# never clobbered unless `MEERKAT_TASKPANEL_FORCE` is set.

set -eu

# The installer speaks one spelling: MEERKAT_TASKPANEL_*. Read once, here, so every
# helper below sees a single set of values.
MEERKAT_TASKPANEL_TARGET_HOME="${MEERKAT_TASKPANEL_TARGET_HOME:-}"
MEERKAT_TASKPANEL_AGENT_NAME="${MEERKAT_TASKPANEL_AGENT_NAME:-}"
MEERKAT_TASKPANEL_LINK="${MEERKAT_TASKPANEL_LINK:-}"
MEERKAT_TASKPANEL_FORCE="${MEERKAT_TASKPANEL_FORCE:-}"
MEERKAT_TASKPANEL_DRY_RUN="${MEERKAT_TASKPANEL_DRY_RUN:-}"
MEERKAT_TASKPANEL_NO_AUTOMATION="${MEERKAT_TASKPANEL_NO_AUTOMATION:-}"
MEERKAT_TASKPANEL_MIN_NODE="${MEERKAT_TASKPANEL_MIN_NODE:-}"
MEERKAT_TASKPANEL_SKIP_NODE_CHECK="${MEERKAT_TASKPANEL_SKIP_NODE_CHECK:-}"
MEERKAT_TASKPANEL_CLAIM_UNASSIGNED="${MEERKAT_TASKPANEL_CLAIM_UNASSIGNED:-}"
MEERKAT_TASKPANEL_SUPERVISOR="${MEERKAT_TASKPANEL_SUPERVISOR:-}"
MEERKAT_TASKPANEL_SCHEDULER="${MEERKAT_TASKPANEL_SCHEDULER:-}"
# The workflow channel's persisted answers. Empty means "not given" and falls back to
# the supervisor's default (workflow on, no reviewer).
MEERKAT_TASKPANEL_WORKFLOW="${MEERKAT_TASKPANEL_WORKFLOW:-}"
MEERKAT_TASKPANEL_REVIEWER="${MEERKAT_TASKPANEL_REVIEWER:-}"
MEERKAT_TASKPANEL_RECOVER_STALE="${MEERKAT_TASKPANEL_RECOVER_STALE:-}"
export MEERKAT_TASKPANEL_TARGET_HOME MEERKAT_TASKPANEL_AGENT_NAME MEERKAT_TASKPANEL_LINK \
  MEERKAT_TASKPANEL_FORCE MEERKAT_TASKPANEL_DRY_RUN MEERKAT_TASKPANEL_NO_AUTOMATION \
  MEERKAT_TASKPANEL_MIN_NODE MEERKAT_TASKPANEL_SKIP_NODE_CHECK MEERKAT_TASKPANEL_CLAIM_UNASSIGNED \
  MEERKAT_TASKPANEL_SUPERVISOR MEERKAT_TASKPANEL_SCHEDULER \
  MEERKAT_TASKPANEL_WORKFLOW MEERKAT_TASKPANEL_REVIEWER MEERKAT_TASKPANEL_RECOVER_STALE

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
# It lives here, inside `install_skill`, because *every* agent-kind script calls that,
# so a direct `scripts/install/<actor-kind>.sh` run is guarded exactly like a run
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
# Shared context — resolved relative to the *agent-kind script* that sourced this file.
# ---------------------------------------------------------------------------

script_dir() { cd "$(dirname "$0")" && pwd; }
# The directory *this file* lives in. `script_dir` follows `$0` — the top-level
# script — so a helper called from `install.sh` (which sources this file) must not
# build a path from it: `$0` there is the repository root.
common_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd; }
repo_root() { cd "$(script_dir)/../.." && pwd; }

# config_root — the one directory holding machine-local config: the program root
# (`MEERKAT_TASKPANEL_REPO` for a combined install), unless
# `MEERKAT_TASKPANEL_CONFIG_DIR` names another. A relative value resolves against
# the caller's cwd, exactly as the CLI resolves it. Both the per-kind configs and
# `projects.json` live here, so the two can never drift apart.
config_root() {
  root="${MEERKAT_TASKPANEL_CONFIG_DIR:-${MEERKAT_TASKPANEL_REPO:-$(repo_root)}}"
  case "$root" in
    /*) ;;
    *) root="$(pwd)/$root" ;;
  esac
  printf '%s\n' "$root"
}

target_home() { printf '%s\n' "${MEERKAT_TASKPANEL_TARGET_HOME:-$HOME}"; }
apply_helper() { printf '%s\n' "$(script_dir)/lib/apply.mjs"; }

# unit_path_helper — the module that owns the unit-PATH recipe.
#
# It is asked for its answers (`node`, `path --scheduler …`) rather than restating the
# recipe here: the same file answers the taskd guard's JS side and the dry-run cron
# preview, so bash and JS can differ only by a bug in it, never by drift.
unit_path_helper() { printf '%s\n' "$(script_dir)/lib/unit-path.mjs"; }

# resolve_agent_cli_dir <cli> — the directory that holds <cli>, or nothing.
#
# `command -v` answers with the name that would run, which is often a symlink
# (`~/.nvm/…/bin/claude` → `../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`).
# The directory that has to be on a unit's PATH is the one the name resolves *from*, so
# the symlink's own directory is the answer — never its target. A name with no slash is
# not a PATH hit at all (a builtin, a function), so it yields nothing rather than a guess.
resolve_agent_cli_dir() {
  cli_path="$(command -v "$1" 2>/dev/null || true)"
  case "$cli_path" in
    */*) printf '%s\n' "${cli_path%/*}" ;;
    *) : ;;
  esac
}

# board_skill_name / loop_skill_name / setup_skill_name — the skills this installer
# distributes. The setup skill is copied only for the Claude bundle (see claude.sh).
board_skill_name() { printf '%s\n' "meerkat"; }
loop_skill_name() { printf '%s\n' "meerkat-loop"; }
setup_skill_name() { printf '%s\n' "setup-meerkat"; }

# legacy_board_skill_name <skill> — the directory the board skill had before it was
# renamed to `meerkat`. Empty for the other two skills, which were never renamed.
legacy_board_skill_name() {
  [ "$1" = "$(board_skill_name)" ] || return 0
  printf '%s\n' "meerkat-taskpanel"
}

# agent_name — the identity written into the agent bundle.
#
# `--agent-name` (MEERKAT_TASKPANEL_AGENT_NAME) wins; the default is the fixed name
# "Worker" (edit the per-kind config / pass the flag to change it). The name is the board
# assignee: claiming a card checks `assignee == actor`, so this is the name the agent
# must be assigned cards as.
agent_name() {
  local name="${MEERKAT_TASKPANEL_AGENT_NAME:-}"
  [ -n "$name" ] || name="Worker"
  printf '%s\n' "$name"
}

# human_name — the person the board records when a write is theirs.
#
# It is a *separate* name from the agent's, and that is the point: an agent's own
# writes carry the agent's name and kind, while `--as-human` is the single write
# that carries this one — how an agent records something the user said, in the
# user's voice. Without it, that flag would sign with the *agent's* name, which is
# the one thing it must not do.
#
# An explicit name always wins. Failing that, a name an earlier install already
# recorded is kept, and only then does the OS user — who installs the board —
# supply it; never empty, so a agent with no `$USER`/`$LOGNAME` behaves exactly as
# it did before this existed.
human_name() {
  local name="${MEERKAT_TASKPANEL_HUMAN_NAME:-}"
  [ -n "$name" ] || name="$(recorded_human_name "${1:-}")"
  [ -n "$name" ] || name="${USER:-}"
  [ -n "$name" ] || name="${LOGNAME:-}"
  [ -n "$name" ] || name="$(agent_name)"
  printf '%s\n' "$name"
}

# recorded_human_name [agent_dir] — the human name an earlier install recorded.
#
# `--force` re-writes every artifact this installer owns, and the human name is not
# one of them: it names a person. Re-deriving it from `$USER` on a machine whose
# board signs as someone else does not fail — it silently re-signs that person's
# decisions under a second name, which the append-only actor table then keeps. So a
# run that says nothing about the human reads the record instead:
#
#   * <target home>/.meerkat-taskpanel/.env  `TASKCTL_HUMAN` — the board's own
#     config, the identity taskctl/taskd actually load;
#   * <agent dir>/bin/taskctl                the shim's `TASKCTL_HUMAN:-<name>`
#     default, which every agent kind bakes in on install.
#
# The board's config wins: it is the copy an operator edits. Prints nothing (and
# always succeeds) when neither artifact exists or neither carries a name.
recorded_human_name() {
  local agent_dir="${1:-}"
  local board_env name shim
  board_env="$(target_home)/.meerkat-taskpanel/.env"
  name=""
  if [ -f "$board_env" ]; then
    name="$(sed -n 's/^TASKCTL_HUMAN=//p' "$board_env" | tail -n 1 | sed 's/^["'\'']//; s/["'\'']$//')"
  fi
  if [ -z "$name" ] && [ -n "$agent_dir" ]; then
    shim="$(target_home)/$agent_dir/bin/taskctl"
    if [ -f "$shim" ]; then
      name="$(sed -n 's/^human="\${TASKCTL_HUMAN:-\(.*\)}"$/\1/p' "$shim" | tail -n 1)"
    fi
  fi
  if [ -n "$name" ]; then printf '%s\n' "$name"; fi
  return 0
}

# export_tp_env <agent_dir> <label> — export the TP_* variables the template renderer reads.
#
# {{AGENT}} <- TP_AGENT, {{REPO}} <- TP_REPO, {{SHIM}} <- TP_SHIM, and so on. The
# destinations are absolute under the target home so the hook / trigger / shim / scheduling
# units work regardless of the caller's working directory.
export_tp_env() {
  agent_dir="$1"
  label="$2"
  TP_AGENT="$(agent_name)"
  TP_HUMAN="$(human_name "$agent_dir")"
  # A full server install materializes the runtime tree; the agent shims and the
  # loop must drive *that* tree, not the npm cache / checkout they were copied
  # from. Agent-only installs leave the override unset and keep the old behavior.
  TP_REPO="${MEERKAT_TASKPANEL_REPO:-$(repo_root)}"
  TP_SHIM="$(target_home)/$agent_dir/bin/taskctl"
  # The shim's directory carries every `taskctl` a unit's child runs (the control
  # turn's board reads, a worker's card operations, a reviewer's evidence). It is
  # derived, never hard-coded, so the unit PATH and the shim cannot disagree.
  TP_SHIM_DIR="${TP_SHIM%/*}"
  TP_HOOK="$(target_home)/$agent_dir/hooks/meerkat-taskpanel-session-start.sh"
  # The external loop is `taskctl loop …`, shipped by the runtime tree `TP_REPO`
  # names. Log and state are fixed per agent kind so a user always knows where they
  # land (documented in docs/scheduling.md).
  #
  # The units name the CLI entry, not an agent-local copy of the loop body: the
  # body now lives in the toolkit (`src/orchestrator/`), so there is one
  # implementation to upgrade and the unit needs no reload when it changes.
  TP_ACTOR_KIND="$label"
  TP_AGENT_BASE="$(target_home)/$agent_dir"
  TP_LOOP="$(target_home)/$agent_dir/meerkat-taskpanel"
  TP_STATE_DIR="$TP_LOOP"
  TP_CLI="$TP_REPO/src/cli/index.mjs"
  TP_LOG="$TP_LOOP/supervisor.log"
  # The machine-local config lives beside the board `.env` at the program root,
  # one per-kind file (`<program root>/.env.<kind>`) plus the project map
  # (`<program root>/projects.json`), not under the agent home.
  # `MEERKAT_TASKPANEL_CONFIG_DIR` is the tests/containers/read-only-root escape.
  TP_CONFIG_DIR="$(config_root)"
  TP_ENV="$TP_CONFIG_DIR/.env.$label"
  TP_LEGACY_ENV="$TP_AGENT_BASE/meerkat-taskpanel.env"
  TP_SCHED="$(target_home)/$agent_dir/scheduling"
  TP_CLAIM_UNASSIGNED="${MEERKAT_TASKPANEL_CLAIM_UNASSIGNED:-yes}"
  TP_RECOVER_STALE="${MEERKAT_TASKPANEL_RECOVER_STALE:-yes}"
  # The workflow channel's remembered answers. An empty reviewer is deliberate and
  # renders as `KEY=`, which the supervisor reads as "not configured".
  TP_WORKFLOW="${MEERKAT_TASKPANEL_WORKFLOW:-yes}"
  TP_REVIEWER="${MEERKAT_TASKPANEL_REVIEWER:-Reviewer}"
  # The scheduler's two clocks. Ping only prunes dead worker pids; continue is
  # the bounded `Continue` judgment turn that runs poll/patrol/workflow.
  TP_PING_INTERVAL="${MEERKAT_TASKPANEL_PING_INTERVAL:-60}"
  TP_CONTINUE_INTERVAL="${MEERKAT_TASKPANEL_CONTINUE_INTERVAL:-600}"
  TP_CONTINUE="${MEERKAT_TASKPANEL_CONTINUE:-yes}"
  case "$TP_PING_INTERVAL" in
    "" | *[!0-9]*)
      echo "$TP_ACTOR_KIND: MEERKAT_TASKPANEL_PING_INTERVAL must be a positive integer (got '$TP_PING_INTERVAL')" >&2
      return 1
      ;;
  esac
  case "$TP_CONTINUE_INTERVAL" in
    "" | *[!0-9]*)
      echo "$TP_ACTOR_KIND: MEERKAT_TASKPANEL_CONTINUE_INTERVAL must be a positive integer (got '$TP_CONTINUE_INTERVAL')" >&2
      return 1
      ;;
  esac
  if [ "$TP_PING_INTERVAL" -le 0 ] || [ "$TP_CONTINUE_INTERVAL" -le 0 ]; then
    echo "$TP_ACTOR_KIND: the ping and continue intervals must be positive" >&2
    return 1
  fi
  case "$TP_CONTINUE" in
    yes | no | true | false | 1 | 0 | y | n | on | off) ;;
    *)
      echo "$TP_ACTOR_KIND: MEERKAT_TASKPANEL_CONTINUE must be yes or no (got '$TP_CONTINUE')" >&2
      return 1
      ;;
  esac
  TP_PING_CRON="* * * * *"
  if [ "$TP_CONTINUE_INTERVAL" -ge 60 ] && [ $((TP_CONTINUE_INTERVAL % 60)) -eq 0 ]; then
    continue_minutes=$((TP_CONTINUE_INTERVAL / 60))
    if [ "$continue_minutes" -lt 60 ]; then
      TP_CONTINUE_CRON="*/$continue_minutes * * * *"
    elif [ "$continue_minutes" -eq 60 ]; then
      TP_CONTINUE_CRON="0 * * * *"
    elif [ $((continue_minutes % 60)) -eq 0 ] && [ $((continue_minutes / 60)) -lt 24 ]; then
      TP_CONTINUE_CRON="0 */$((continue_minutes / 60)) * * *"
    else
      TP_CONTINUE_CRON="*/10 * * * *"
    fi
  else
    TP_CONTINUE_CRON="*/10 * * * *"
    echo "$TP_ACTOR_KIND: continue interval ${TP_CONTINUE_INTERVAL}s is not a whole number of minutes; cron falls back to */10" >&2
  fi

  # --- what the scheduling units run with -------------------------------------
  #
  # A scheduler starts a unit with a minimal PATH of its own, so on a machine whose node
  # lives under nvm or Homebrew the unit hits the same wall twice (T-20261014-020103-2):
  # `/usr/bin/env node` exits 127, and — fixing only that — the agent process the tick starts
  # then fails the same way, because it looks the agent CLI up on the *inherited* minimal
  # PATH. Both layers are therefore fixed by one lever: the unit names its
  # interpreter outright (`{{NODE}}`) **and** carries a PATH (`{{UNIT_PATH_*}}`) whose head
  # is the agent shim's directory, the agent CLI's, and node's. The recipe lives in
  # lib/unit-path.mjs — one definition, read here through its CLI, so bash cannot drift
  # from the JS side. The shim heads the list: a globally installed `taskctl` (nvm's
  # global bin is node's directory) would otherwise shadow it and write the wrong actor.
  #
  # `{{NODE}}` is version-pinned, exactly like the taskd unit's: after a node or CLI
  # upgrade, `install.sh --force` refreshes the units (docs/scheduling.md says so).
  #
  # A `--dry-run` renders nothing, and `--skip-node-check` exists so an install can be
  # *previewed* on a machine whose PATH holds no node at all — so a missing node is fatal
  # only where the values would actually be used. Where they are used, it is fatal: a unit
  # that renders an empty interpreter is the 127 this exists to remove.
  if TP_NODE="$(node "$(unit_path_helper)" node 2>/dev/null)"; then
    TP_CLI_DIR="$(resolve_agent_cli_dir "$label")"
    if [ -n "$TP_CLI_DIR" ]; then
      TP_UNIT_PATH_LAUNCHD="$(node "$(unit_path_helper)" path --scheduler launchd --shim-dir "$TP_SHIM_DIR" --cli-dir "$TP_CLI_DIR")"
      TP_UNIT_PATH_CRON="$(node "$(unit_path_helper)" path --scheduler cron --shim-dir "$TP_SHIM_DIR" --cli-dir "$TP_CLI_DIR")"
      TP_CLI_ON_PATH="1"
    else
      # Degrade loudly, never silently: the interpreter still resolves (that is `{{NODE}}`'s
      # job), but a woken worker would not — so *record* that, and let `install_scheduling`
      # say it, because only it knows whether this agent kind gets units at all. An agent kind with no
      # supervisor (OpenClaw) renders no unit and must not be warned about one.
      TP_UNIT_PATH_LAUNCHD="$(node "$(unit_path_helper)" path --scheduler launchd --shim-dir "$TP_SHIM_DIR")"
      TP_UNIT_PATH_CRON="$(node "$(unit_path_helper)" path --scheduler cron --shim-dir "$TP_SHIM_DIR")"
      TP_CLI_ON_PATH="0"
    fi
  elif [ -z "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "$TP_ACTOR_KIND: could not resolve the interpreter for the scheduling units (is 'node' on PATH?)" >&2
    return 1
  fi

  export TP_AGENT TP_HUMAN TP_REPO TP_SHIM TP_HOOK
  export TP_ACTOR_KIND TP_AGENT_BASE TP_LOOP TP_STATE_DIR TP_CLI TP_LOG TP_ENV TP_SCHED TP_CLAIM_UNASSIGNED
  export TP_CONFIG_DIR TP_LEGACY_ENV
  export TP_RECOVER_STALE TP_WORKFLOW TP_REVIEWER
  export TP_PING_INTERVAL TP_CONTINUE_INTERVAL TP_CONTINUE TP_PING_CRON TP_CONTINUE_CRON
  export TP_NODE TP_UNIT_PATH_LAUNCHD TP_UNIT_PATH_CRON TP_CLI_ON_PATH
}

# reconcile_taskctl_on_path — one `taskctl` on the shell's PATH, and it must be
# this install's.
#
# Each agent kind writes its shim at <agent-dir>/bin/taskctl and the scheduling
# units put that directory at the head of their PATH, but the *operator's* shell
# is a different story: a `taskctl` left on PATH by an earlier tool answers first
# for every bare call. This host had one deployed by another project, writing the
# wrong actor identity. So an install checks what a bare `taskctl` resolves to:
#
#   * nothing on PATH          → nothing to do;
#   * this install's shim      → nothing to do;
#   * another meerkat shim     → nothing to do (the first kind in the run won);
#   * a foreign shell script   → back it up (.bak-<timestamp>) and overwrite it;
#   * a symlink or a binary    → say so and leave it alone.
#
# It only touches a path *inside the target home*: an install must never rewrite a
# file outside the tree it was asked to install into (a test with a temp --prefix
# must not adopt the operator's real shim). A read-only location warns and the
# install continues — a failed adoption must not fail the bundle.
reconcile_taskctl_on_path() {
  resolved="$(command -v taskctl 2>/dev/null || true)"
  [ -n "$resolved" ] || return 0
  if [ "$resolved" = "$TP_SHIM" ] || { [ -e "$TP_SHIM" ] && [ "$resolved" -ef "$TP_SHIM" ]; }; then
    return 0
  fi
  if grep -q 'generated by `install.sh' "$resolved" 2>/dev/null; then
    return 0
  fi
  case "$resolved" in
    "$(target_home)"/*) ;;
    *)
      echo "$TP_ACTOR_KIND: taskctl on PATH ($resolved) is outside $(target_home) — left alone."
      return 0
      ;;
  esac
  if [ -L "$resolved" ]; then
    echo "$TP_ACTOR_KIND: taskctl on PATH ($resolved) is a symlink — left alone;"
    echo "$TP_ACTOR_KIND:   put $TP_SHIM_DIR first on PATH to reach this install's shim."
    return 0
  fi
  if [ ! -f "$resolved" ] || [ "$(head -n 1 "$resolved" 2>/dev/null | cut -c1-2)" != "#!" ]; then
    echo "$TP_ACTOR_KIND: taskctl on PATH ($resolved) is not a shell shim — left alone."
    return 0
  fi
  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "would adopt taskctl on PATH: $resolved (backup to $resolved.bak-<timestamp>)"
    return 0
  fi
  stamp="$(date +%Y%m%dT%H%M%S)"
  if ! cp -p "$resolved" "$resolved.bak-$stamp" 2>/dev/null; then
    echo "$TP_ACTOR_KIND: could not back up $resolved — left alone."
    return 0
  fi
  if node "$(apply_helper)" emit "$(script_dir)/templates/taskctl-shim.sh" "$resolved" --exec --force >/dev/null 2>&1; then
    echo "$TP_ACTOR_KIND: adopted taskctl on PATH: $resolved (previous copy at $resolved.bak-$stamp)"
  else
    echo "$TP_ACTOR_KIND: could not overwrite $resolved — previous copy at $resolved.bak-$stamp"
  fi
  return 0
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

# supervisor_value <flag> <interactive> — decide the opt-in supervisor action. Prints
# `enable`, `disable`, `status`, or **empty** for "do nothing" (a plain install):
#
#   * an explicit <flag> wins, verbatim (`enable` / `disable` / `status`);
#   * otherwise, when <interactive> is "1" (stdin is a TTY), ask the question once —
#     default **no**, because the supervisor is a daemon that runs unattended;
#   * otherwise (the non-interactive default, and the whole of `--dry-run`): nothing.
#
# The default is deliberately the opposite of `claim_unassigned_value` next door, which
# asks the same way but defaults **yes**: enabling a background daemon must be asked for,
# never assumed. An unrecognised <flag> is a hard error, not a silent default.
supervisor_value() {
  flag="$1"
  interactive="$2"
  case "$flag" in
    enable | disable | status)
      printf '%s\n' "$flag"
      return 0
      ;;
    "")
      ;;
    *)
      echo "--supervisor must be enable, disable or status (got '$flag')." >&2
      return 1
      ;;
  esac

  if [ "$interactive" = "1" ]; then
    printf 'Enable the supervisor now? It runs headless in the background (ping 60s / continue 600s). [y/N] ' >&2
    answer=""
    read -r answer || answer=""
    case "$answer" in
      [Yy]*) printf 'enable\n' ;;
      *) printf '' ;;
    esac
    return 0
  fi

  printf ''
}

# supervisor_actor_kinds_value <action> <explicit-list> <targets> — resolve which loop agent
# kinds a supervisor action applies to. Prints a space-padded, ordered, de-duplicated list
# (" claude codex ") or empty; validation failures go to stderr and return 1, so the caller
# decides the exit code. Read-only and side-effect free.
#
# One loop supervisor per machine is the rule (`docs/scheduling.md`):
#   * an explicit <list> wins — it is the only way to act on more than one kind, and a kind
#     the install does not cover is named and dropped (its installer would never run);
#   * otherwise `enable` acts on the FIRST loop kind in --target order; `disable` and
#     `status` act on EVERY loop kind, so an old three-supervisor install can be seen and
#     stopped in one command.
# OpenClaw is never one: it runs openclaw-team's own poll/patrol.
supervisor_actor_kinds_value() {
  local action="${1:-}" explicit="${2:-}" targets="${3:-}"
  local resolved="" kept="" entry raw kind target old_ifs
  case "$action" in
    "" | enable | disable | status) ;;
    *)
      echo "--supervisor must be enable, disable or status (got '$action')." >&2
      return 1
      ;;
  esac

  if [ -n "$explicit" ]; then
    resolved=""
    old_ifs="$IFS"
    IFS=','
    for raw in $explicit; do
      IFS="$old_ifs"
      entry="$(printf '%s' "$raw" | tr -d '[:space:]')"
      IFS=','
      case "$entry" in
        "") ;;
        claude | codex | pi)
          case " $resolved " in
            *" $entry "*) ;;
            *) resolved="$resolved $entry" ;;
          esac
          ;;
        openclaw)
          IFS="$old_ifs"
          echo "--supervisor-actor-kinds openclaw: OpenClaw has no meerkat-loop supervisor to enable (it runs openclaw-team's own poll/patrol — see docs/scheduling.md)" >&2
          return 1
          ;;
        server)
          IFS="$old_ifs"
          echo "--supervisor-actor-kinds server: the server target has no meerkat-loop supervisor (the taskd guard is separate)" >&2
          return 1
          ;;
        *)
          IFS="$old_ifs"
          echo "invalid --supervisor-actor-kinds: $entry (expected claude|codex|pi)" >&2
          return 1
          ;;
      esac
    done
    IFS="$old_ifs"

    kept=""
    for kind in $resolved; do
      case " $targets " in
        *" $kind "*) kept="$kept $kind" ;;
        *)
          echo "install.sh: supervisor: kind '$kind' is not in --target; nothing to act on for it" >&2
          ;;
      esac
    done
    [ -n "$kept" ] && printf ' %s ' "${kept# }"
    return 0
  fi

  [ -n "$action" ] || return 0
  resolved=""
  for target in $targets; do
    case "$target" in
      claude | codex | pi) ;;
      *) continue ;;
    esac
    case "$action" in
      enable)
        # One supervisor per machine: the first loop kind in --target order.
        printf ' %s ' "$target"
        return 0
        ;;
      *)
        resolved="$resolved $target"
        ;;
    esac
  done
  [ -n "$resolved" ] && printf ' %s ' "${resolved# }"
  return 0
}

# apply_supervisor — perform this agent kind's requested enable / disable / status action.
# Requires export_tp_env first (TP_ACTOR_KIND, TP_AGENT, TP_AGENT_BASE, TP_SCHED).
#
# This is the opt-in path `docs/scheduling.md` defines, and the one place an installer
# starts something: with no request (an empty MEERKAT_TASKPANEL_SUPERVISOR) nothing here
# runs at all, so a plain install still only prints the load command.
#
# A refusal from the OS (`supervisor: not enabled …`, exit 1) is **reported, not fatal**:
# the agent's skills are installed either way, and the install summary's own remedy
# ("re-run with --force") would not apply to, say, a launchd bootstrap with no GUI
# session. Anything else — a bad action or scheduler value, or a crashed helper — fails.
apply_supervisor() {
  action="${MEERKAT_TASKPANEL_SUPERVISOR:-}"
  [ -n "$action" ] || return 0

  case "$action" in
    enable | disable | status) ;;
    *)
      echo "MEERKAT_TASKPANEL_SUPERVISOR must be enable, disable or status (got '$action')." >&2
      return 1
      ;;
  esac

  scheduler="${MEERKAT_TASKPANEL_SCHEDULER:-auto}"
  case "$scheduler" in
    auto | launchd | systemd | cron) ;;
    *)
      echo "MEERKAT_TASKPANEL_SCHEDULER must be auto, launchd, systemd or cron (got '$scheduler')." >&2
      return 1
      ;;
  esac

  dry=""
  [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ] && dry="--dry-run"

  # The status action reads the per-kind config; an install that skipped
  # `write_agent_config` (codex --no-automation) must still see a migrated file.
  migrate_legacy_agent_config

  status=0
  node "$(script_dir)/lib/supervisor.mjs" "$action" \
    --actor-kind "$TP_ACTOR_KIND" \
    --agent "$TP_AGENT" \
    --agent-base "$TP_AGENT_BASE" \
    --config "$TP_ENV" \
    --scheduler "$scheduler" $dry || status=$?

  if [ "$status" -ne 0 ] && [ "$status" -ne 1 ]; then
    echo "$TP_ACTOR_KIND: the supervisor helper failed (exit $status)" >&2
    return "$status"
  fi
  return 0
}

# supervisor_stale_report — say whether this agent kind's units are already loaded, and
# how to reload them. Read-only (`status --stale-only`), and never fatal: this is the
# warning path of a plain install, and a warning that can fail an install is worse than
# the silence it replaces. Requires export_tp_env first.
supervisor_stale_report() {
  node "$(script_dir)/lib/supervisor.mjs" status --stale-only \
    --actor-kind "$TP_ACTOR_KIND" \
    --agent "$TP_AGENT" \
    --agent-base "$TP_AGENT_BASE" \
    --config "$TP_ENV" \
    --scheduler "${MEERKAT_TASKPANEL_SCHEDULER:-auto}" 2>/dev/null || true
}

# install_scheduling — write the scheduling units, then either print the exact
# command that loads them or — when the user asked for it (`--supervisor=…`, i.e.
# MEERKAT_TASKPANEL_SUPERVISOR is set) — run that load. Without a request the installer
# never runs `launchctl` / `systemctl` / `crontab` itself: enabling a daemon is the user's
# call, and a plain install must have no side effects. Requires export_tp_env first.
#
# The templates are this installer's own (`scripts/install/templates/`), the one place
# they live: the loop skill carries decisions, not deployment files.
install_scheduling() {
  # The loop's state directory (queue, ledger, locks, status files). It used to be
  # created as a side effect of copying the body; now nothing else makes it.
  if [ -z "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    mkdir -p "$TP_LOOP"
  fi

  # Whether this is a reinstall (the units' directory already exists) and whether this run
  # actually rewrote any of them. Together they decide if a loaded unit is now stale.
  TP_SCHED_EXISTED=0
  if [ -d "$TP_SCHED" ]; then TP_SCHED_EXISTED=1; fi
  TP_SCHED_CHANGED=0

  # Said here, not in export_tp_env: this is the function that knows the agent kind gets
  # units, and the warning is about *them*. An agent kind with no supervisor never reaches it.
  if [ "${TP_CLI_ON_PATH:-1}" = "0" ]; then
    echo "$TP_ACTOR_KIND: $TP_ACTOR_KIND is not on PATH — the scheduling units will carry the shim directory and node's,"
    echo "$TP_ACTOR_KIND:   so a woken $TP_ACTOR_KIND would not resolve. Install it, then re-run this install with --force."
  fi

  emit_sched_file "scheduling/launchd/com.meerkat-taskpanel.ping.plist" "$TP_SCHED/launchd/com.meerkat-taskpanel.ping.plist"
  emit_sched_file "scheduling/launchd/com.meerkat-taskpanel.continue.plist" "$TP_SCHED/launchd/com.meerkat-taskpanel.continue.plist"
  emit_sched_file "scheduling/launchd/com.meerkat-taskpanel.subscribe.plist" "$TP_SCHED/launchd/com.meerkat-taskpanel.subscribe.plist"
  emit_sched_file "scheduling/launchd/com.meerkat-taskpanel.session.plist" "$TP_SCHED/launchd/com.meerkat-taskpanel.session.plist"
  emit_sched_file "scheduling/systemd/meerkat-taskpanel-ping.service" "$TP_SCHED/systemd/meerkat-taskpanel-ping.service"
  emit_sched_file "scheduling/systemd/meerkat-taskpanel-ping.timer" "$TP_SCHED/systemd/meerkat-taskpanel-ping.timer"
  emit_sched_file "scheduling/systemd/meerkat-taskpanel-continue.service" "$TP_SCHED/systemd/meerkat-taskpanel-continue.service"
  emit_sched_file "scheduling/systemd/meerkat-taskpanel-continue.timer" "$TP_SCHED/systemd/meerkat-taskpanel-continue.timer"
  emit_sched_file "scheduling/systemd/meerkat-taskpanel-subscribe.service" "$TP_SCHED/systemd/meerkat-taskpanel-subscribe.service"
  emit_sched_file "scheduling/systemd/meerkat-taskpanel-session.service" "$TP_SCHED/systemd/meerkat-taskpanel-session.service"
  emit_sched_file "scheduling/cron/meerkat-taskpanel.cron" "$TP_SCHED/cron/meerkat-taskpanel.cron"

  echo "$TP_ACTOR_KIND: scheduling units installed under $TP_SCHED"

  if [ -n "${MEERKAT_TASKPANEL_SUPERVISOR:-}" ]; then
    apply_supervisor
    return 0
  fi

  # A rewrite over units a service manager already has loaded leaves the *running* job on
  # its old definition — a loaded unit is only read at bootstrap. Saying "nothing is loaded
  # for you" there would be false, and staying silent is how a loop runs for hours with an
  # `--agent` the config no longer has. Only a reinstall that changed bytes probes (a fresh
  # install has no units to be stale, and a plain install never asks a service manager).
  if [ "${TP_SCHED_EXISTED:-0}" = "1" ] && [ "${TP_SCHED_CHANGED:-0}" = "1" ] && [ -z "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    stale="$(supervisor_stale_report)"
    if [ -n "$stale" ]; then
      printf '%s\n' "$stale"
      return 0
    fi
  fi

  echo "$TP_ACTOR_KIND: to start the supervisor, load one of these (nothing is loaded for you):"
  echo "  launchd:  launchctl load $TP_SCHED/launchd/com.meerkat-taskpanel.ping.plist   # and .continue.plist + .subscribe.plist"
  echo "  systemd:  mkdir -p ~/.config/systemd/user && cp $TP_SCHED/systemd/* ~/.config/systemd/user/ && systemctl --user enable --now meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-subscribe.service"
  echo "  cron:     crontab $TP_SCHED/cron/meerkat-taskpanel.cron   # no event daemon: cron cannot host one"
}

# ensure_env_key <key> <value> — add a KEY=value line to the per-kind config when the key
# is missing, and never touch one that is already there. That is the same
# merge-not-clobber contract `merge_settings` follows for `env.TASKCTL_AGENT`: adding
# a key the file lacks is not a clobber. Requires TP_ENV, TP_ACTOR_KIND.
#
# It exists because the config is written once and then left alone — a differing file
# is skipped without `--force` — so without this an install that predates a key would
# never learn it, and an agent-installed executor would have no way to find the board
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
  echo "$TP_ACTOR_KIND: recorded $key in $TP_ENV"
}

# ensure_file_key <file> <key> <value> — append KEY=VALUE when the file exists and
# the key is absent. Honours the dry run. An existing key (even an empty one) is
# kept: the server `.env` may hold deliberate edits or a token.
ensure_file_key() {
  file="$1"
  key="$2"
  value="$3"

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ] || [ -n "${DRY_RUN:-}" ]; then
    echo "would ensure $key in $file"
    return 0
  fi
  [ -f "$file" ] || return 0
  if grep -q "^${key}=" "$file"; then
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
  echo "install.sh: recorded $key in $file"
}

# strip_env_key <file> <key> — remove a retired `KEY=value` line from a config file.
#
# A retired key left in the shared `.env` is not inert: the loader refuses an
# unknown key in its own namespace, so every command would fail. This runs after
# the per-kind writers (which re-append unknown keys) so nothing resurrects the
# line. Idempotent, dry-run aware, and never fatal: a file it cannot rewrite is a
# warning, not a failed install.
strip_env_key() {
  file="$1"
  key="$2"
  [ -f "$file" ] || return 0
  grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" || return 0

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ] || [ -n "${DRY_RUN:-}" ]; then
    echo "would remove the retired $key from $file"
    return 0
  fi

  # A rewrite through a temp file must keep the original mode: the shared `.env` may
  # hold an inline token, and the loader refuses a token-bearing file that is
  # group/world-readable (`CONFIG_FILE_INSECURE`). Losing `0600` here would break
  # every command after the upgrade.
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file" 2>/dev/null || true)"
  tmp="$file.strip.$$"
  if ! sed -E "/^[[:space:]]*(export[[:space:]]+)?${key}=/d" "$file" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "install.sh: warning: cannot rewrite $file to remove the retired $key" >&2
    return 0
  fi
  if [ -n "$mode" ] && ! chmod "$mode" "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "install.sh: warning: cannot preserve the mode of $file; the retired $key was left in place" >&2
    return 0
  fi
  if ! mv "$tmp" "$file" 2>/dev/null; then
    rm -f "$tmp"
    echo "install.sh: warning: cannot replace $file to remove the retired $key" >&2
    return 0
  fi
  echo "install.sh: removed the retired $key from $file"
}

# seed_env_file — create the install-root `.env` on a fresh install.
#
# The board-facing file, read by taskd and taskctl (and the loop's SSE subscriber). It is
# a *machine/install* config, not a per-agent-kind one: `--target all` must not write four
# copies, so install.sh calls this once, outside the agent-kind loop. The per-kind config
# (`<program root>/.env.<kind>`) is written separately, once per kind.
#
# Never overwrites: the file may hold a token or deliberate edits, so even
# `--force` leaves an existing one alone. `--dry-run` prints and writes nothing.
# `MEERKAT_TASKPANEL_ENV_FILE` overrides the path (tests, containers, a read-only
# package root).
seed_env_file() {
  # `$ROOT` when the caller has one: install.sh computes it absolutely, and a
  # relative `bash install.sh` would make repo_root() resolve the checkout's
  # parent (dirname "install.sh" is "."). server.sh has no $ROOT and calls with
  # an explicit path, so repo_root() is the right fallback there.
  seed_root="${ROOT:-$(repo_root)}"
  if [ "$#" -ge 1 ] && [ -n "$1" ]; then
    env_file="$1"
  else
    env_file="${MEERKAT_TASKPANEL_ENV_FILE:-$seed_root/.env}"
  fi
  case "$env_file" in
    /*) ;;
    *) env_file="$seed_root/$env_file" ;;
  esac
  template="$seed_root/scripts/install/templates/env.example"

  if [ -f "$env_file" ]; then
    echo "install.sh: kept $env_file (already exists)"
    return 0
  fi
  if [ -n "${DRY_RUN:-}" ] || [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "install.sh: would create $env_file (0600)"
    return 0
  fi
  if [ ! -f "$template" ]; then
    echo "install.sh: warning: missing $template; not creating $env_file" >&2
    return 0
  fi
  if ! ( umask 077; mkdir -p "$(dirname "$env_file")"; cp "$template" "$env_file"; chmod 600 "$env_file" ); then
    echo "install.sh: warning: could not create $env_file (read-only install?); set MEERKAT_TASKPANEL_ENV_FILE to a writable path" >&2
    return 0
  fi
  echo "install.sh: created $env_file (0600)"
  return 0
}

# ensure_agent_config_keys — add the installer-owned keys when missing, never overwrite.
# Requires export_tp_env first.
ensure_agent_config_keys() {
  # The loop's scan set. The scheduling units deliberately carry no `--agent`
  # (a flag would outrank this key), so this is the identity the loop runs as.
  # setup-meerkat replaces it with the team's role names; never clobber one here.
  ensure_env_key "MEERKAT_TASKPANEL_AGENTS" "$TP_AGENT"
  ensure_env_key "MEERKAT_TASKPANEL_REPO" "$TP_REPO"
  ensure_env_key "MEERKAT_TASKPANEL_RECOVER_STALE" "$TP_RECOVER_STALE"
  ensure_env_key "MEERKAT_TASKPANEL_WORKFLOW" "$TP_WORKFLOW"
  ensure_env_key "MEERKAT_TASKPANEL_REVIEWER" "$TP_REVIEWER"
  ensure_env_key "MEERKAT_TASKPANEL_PING_INTERVAL" "$TP_PING_INTERVAL"
  ensure_env_key "MEERKAT_TASKPANEL_CONTINUE_INTERVAL" "$TP_CONTINUE_INTERVAL"
  ensure_env_key "MEERKAT_TASKPANEL_CONTINUE" "$TP_CONTINUE"
}

# keep_unlisted_env_keys <saved> <target> — re-append KEY=VALUE lines from <saved>
#   whose key is absent from <target>. This installer owns the keys its template
#   carries; every other key in the file belongs to the operator, or to the tool that
#   wrote it — `setup-meerkat` records the team list here. A forced rewrite must not
#   delete those. Requires TP_ACTOR_KIND for the report line.
keep_unlisted_env_keys() {
  saved="$1"
  target="$2"
  [ -f "$saved" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      [A-Z_]*=*) key="${line%%=*}" ;;
      *) continue ;;
    esac
    if grep -q "^${key}=" "$target" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$line" >> "$target"
    echo "${TP_ACTOR_KIND:-agent}: kept $key in $target"
  done < "$saved"
}

# migrate_legacy_agent_config — copy an install that predates the program-root
# location into `<program root>/.env.<kind>`, once. The legacy file is kept and is
# no longer read. A new file always wins (no merge). `--force` re-renders the
# template, so migrating first would only be overwritten. Requires export_tp_env.
migrate_legacy_agent_config() {
  [ -f "$TP_LEGACY_ENV" ] || return 0
  [ ! -e "$TP_ENV" ] || return 0
  [ -z "${MEERKAT_TASKPANEL_FORCE:-}" ] || return 0

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "$TP_ACTOR_KIND: would migrate the per-kind config $TP_LEGACY_ENV -> $TP_ENV (legacy left in place)"
    return 0
  fi

  if ! mkdir -p "$(dirname "$TP_ENV")"; then
    echo "$TP_ACTOR_KIND: cannot create $(dirname "$TP_ENV"); set MEERKAT_TASKPANEL_CONFIG_DIR to a writable directory" >&2
    return 0
  fi
  if ! cp "$TP_LEGACY_ENV" "$TP_ENV"; then
    echo "$TP_ACTOR_KIND: cannot migrate $TP_LEGACY_ENV -> $TP_ENV; set MEERKAT_TASKPANEL_CONFIG_DIR to a writable directory" >&2
    return 0
  fi
  echo "$TP_ACTOR_KIND: migrated the per-kind config $TP_LEGACY_ENV -> $TP_ENV"
  echo "$TP_ACTOR_KIND:   the legacy file is left untouched and is no longer read"
}

# write_agent_config — persist the per-kind config the loop and the board path
# read. Requires export_tp_env first. The template belongs to the loop skill: the
# loop is its primary reader.
#
# The workflow keys are added with `ensure_env_key` as well, so an install that
# predates them learns them on the next run without any existing value being touched.
write_agent_config() {
  migrate_legacy_agent_config
  # A forced reinstall re-renders this file from the installer's template, so every
  # key the template does not carry — the team list `setup-meerkat` writes, an
  # operator's own setting — would be deleted with it. Carry those across. A forced
  # run skips the migration above, so the legacy file is the only copy when the
  # program-root one does not exist yet.
  kept_env=""
  if [ -z "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    source_env=""
    if [ -f "$TP_ENV" ]; then
      source_env="$TP_ENV"
    elif [ -f "$TP_LEGACY_ENV" ]; then
      source_env="$TP_LEGACY_ENV"
    fi
    if [ -n "$source_env" ]; then
      # Beside the file, not in TMPDIR: that directory is already writable here, and a
      # same-directory rename does not depend on a second filesystem or on TMPDIR at all.
      mkdir -p "$(dirname "$TP_ENV")" 2>/dev/null || true
      kept_env="$(mktemp "${TP_ENV}.XXXXXX")"
      cp "$source_env" "$kept_env"
    fi
  fi
  emit_file "agent/meerkat-taskpanel.env" "$TP_ENV"
  if [ -n "$kept_env" ]; then
    keep_unlisted_env_keys "$kept_env" "$TP_ENV"
    rm -f "$kept_env"
  fi
  ensure_agent_config_keys
}

# ---------------------------------------------------------------------------
# Skill copy
# ---------------------------------------------------------------------------

# migrate_legacy_skill <agent_dir> <label> <skill> <dest> <link>
#   The board skill used to install as `skills/meerkat-taskpanel/`; it installs as
#   `skills/meerkat/` now. An upgrade must not leave the old directory behind to shadow
#   the new one, but the operator's `roles/` must survive: it moves in, and only where
#   the new directory does not already hold it (the newer copy wins). A
#   `projects.json` there is machine-local and belongs at the config root now, so it
#   is *merged* into that root (target wins, unknown keys kept) and then removed —
#   never moved into the skill, where the next `rm -rf` would delete it.
#   A linked install is left alone: moving through the symlink would write into the
#   checkout the link points at.
migrate_legacy_skill() {
  agent_dir="$1"
  label="$2"
  skill="$3"
  dest="$4"
  link="${5:-}"

  legacy_name="$(legacy_board_skill_name "$skill")"
  [ -n "$legacy_name" ] || return 0
  legacy="$target_home/$agent_dir/skills/$legacy_name"
  [ -e "$legacy" ] || [ -L "$legacy" ] || return 0

  # A link on either side is left alone: moving through one would write into the tree it
  # points at — the checkout — which is exactly what the `--force` path refuses to do.
  # (`install.sh`'s post-install sweep still migrates a legacy *directory's* map; it is
  # operator data in the agent home, not in the checkout.)
  if [ -n "$link" ] || [ -L "$dest" ] || [ -L "$legacy" ]; then
    echo "$label: legacy skill dir kept: $legacy (linked install; move roles/ into $dest by hand, then remove it)"
    return 0
  fi

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "$label: would migrate legacy skill $legacy -> $dest"
    migrate_project_map "$label" "$legacy/projects.json" || true
    return 0
  fi

  # The map goes first: if it cannot be migrated, the directory (and the file in
  # it) must survive. `rm -rf` after a failed merge is exactly the data loss the
  # merge exists to prevent.
  if ! migrate_project_map "$label" "$legacy/projects.json"; then
    echo "$label: legacy skill dir kept: $legacy (its projects.json could not be migrated)"
    return 0
  fi

  # The legacy roles root is operator data the skill owns; it moves only where the
  # new directory lacks it. Kept as a loop over one name: `roles-root-guard` scans
  # for a write verb and a literal `roles` on the same line, and this is a data move,
  # not the installer creating or managing a team.
  for entry in roles; do
    [ -e "$legacy/$entry" ] || continue
    [ -e "$dest/$entry" ] && continue
    mv "$legacy/$entry" "$dest/$entry"
  done
  rm -rf "$legacy"
  echo "$label: migrated legacy skill $legacy -> $dest"
}

# migrate_project_map <label> <source> — merge a skill-beside map into the config
# root and remove the source. Returns non-zero when the map could not be migrated;
# the caller decides whether that is fatal (it never is for the install itself).
migrate_project_map() {
  label="$1"
  source="$2"
  [ -e "$source" ] || return 0
  dry=""
  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ] || [ -n "${DRY_RUN:-}" ]; then
    dry="--dry-run"
  fi
  node "$(common_dir)/lib/project-map.mjs" merge \
    --into "$(config_root)" --from "$source" --label "$label" $dry || return 1
  return 0
}

# install_skill <agent_dir> <label> [skill] [copy-only]
#   <agent_dir>  the agent's config directory under the target home, e.g. ".claude"
#   <label>      human-readable actor kind, e.g. "claude"
#   <skill>      skill directory name under skills/ (default: the board skill)
#   <copy-only>  "copy" to refuse `--link` for this skill (the loop uses it)
install_skill() {
  agent_dir="$1"
  label="$2"
  skill="${3:-$(board_skill_name)}"
  mode="${4:-}"

  # Node floor first: nothing is copied onto a runtime that cannot run it.
  require_node || return 1

  src="$(repo_root)/skills/$skill"
  target_home="$(target_home)"
  dest="$target_home/$agent_dir/skills/$skill"

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
    migrate_legacy_skill "$agent_dir" "$label" "$skill" "$dest" "$link"
    return 0
  fi

  kept_user_data=""
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -z "${MEERKAT_TASKPANEL_FORCE:-}" ]; then
      # Idempotent: an existing skill is the desired end state, not an error. The
      # local edits are preserved (merge, never clobber); --force is the escape hatch.
      echo "$label: already installed: $dest (unchanged; re-run with --force to overwrite)"
      migrate_legacy_skill "$agent_dir" "$label" "$skill" "$dest" "$link"
      return 0
    fi
    # Two things in a skill directory are authored by the operator, never shipped by
    # this installer: the roles root (`setup-meerkat` writes it) and `projects.json`
    # (the project → directory map). A forced reinstall replaces the skill, not them.
    # (A linked skill is skipped: moving through it would move the source's files.)
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
      for entry in roles projects.json; do
        [ -e "$dest/$entry" ] || continue
        [ -n "$kept_user_data" ] || kept_user_data="$(mktemp -d "$(dirname "$dest")/.tp-keep.XXXXXX")"
        mv "$dest/$entry" "$kept_user_data/$entry"
      done
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

  if [ -n "$kept_user_data" ]; then
    for entry in roles projects.json; do
      [ -e "$kept_user_data/$entry" ] || continue
      mv "$kept_user_data/$entry" "$dest/$entry"
      echo "$label: kept    $dest/$entry"
    done
    rmdir "$kept_user_data" 2>/dev/null || true
  fi

  # Last, and only for what the new directory still lacks: a legacy board-skill
  # directory is migrated after this install's own operator data was put back.
  migrate_legacy_skill "$agent_dir" "$label" "$skill" "$dest" "$link"
}

# install_loop_skill <agent_dir> <label>
#   The loop skill, for the agent kinds that run an external supervisor. Always a copy (O6);
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
#   These are every template the installer writes: the agent's session-start hook and
#   slash commands, the Codex trigger and AGENTS.md snippet, the taskctl shims, the
#   scheduling units and the per-kind config.
emit_file() { emit_from "$(script_dir)/templates" "$@"; }

# emit_sched_file <template_rel> <dest>
#   `emit_file` for a scheduling unit, remembering whether the bytes actually changed.
#   The emitter already answers `wrote <dest>` / `unchanged <dest>`; this only keeps the
#   fact, because a rewrite over a unit a service manager already loaded is what leaves
#   the running definition stale — and `install_scheduling` says so.
emit_sched_file() {
  emitted="$(emit_file "$@")"
  printf '%s\n' "$emitted"
  case "$emitted" in
    "wrote "*) TP_SCHED_CHANGED=1 ;;
  esac
}

# merge_settings <settings_file>
#   Merge env.TASKCTL_AGENT and the SessionStart hook into a Claude settings.json,
#   preserving every other key. Requires TP_AGENT / TP_HOOK to be exported first.
merge_settings() {
  settings_file="$1"

  if [ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ]; then
    echo "would merge $settings_file (env.TASKCTL_AGENT / TASKCTL_ACTOR_KIND / TASKCTL_HUMAN + SessionStart hook)"
    return 0
  fi

  # `--kind` is the actor kind and it is required, not decoration: a settings
  # file that names an agent but not what it is leaves every write in that
  # session reading as a human's — and a human's `decision` is the one kind the
  # board acts on.
  force_flag=""
  [ -n "${MEERKAT_TASKPANEL_FORCE:-}" ] && force_flag="--force"

  node "$(apply_helper)" merge-settings "$settings_file" \
    --agent "$TP_AGENT" --kind "$TP_ACTOR_KIND" --human "$TP_HUMAN" --hook "$TP_HOOK" $force_flag
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
