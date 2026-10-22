#!/usr/bin/env bash
#
# Meerkat TaskPanel installer.
#
# Thin dispatcher: it parses the shared flags once and then runs
# scripts/install/<actor-kind>.sh for each requested target, forwarding the options
# through MEERKAT_TASKPANEL_* environment variables.
#
# Usage:
#   install.sh [--target claude|openclaw|codex|pi|opencode|cursor|server|all] [--prefix <home>]
#              [--agent-name <name>] [--no-automation]
#              [--claim-unassigned=yes|no] [--assignee-only]
#              [--supervisor=enable|disable|status] [--supervisor-actor-kinds <list>]
#              [--scheduler auto|launchd|systemd|cron]
#              [--link] [--force] [--dry-run] [--skip-node-check] [--skip-web-build] [-h|--help]
#
# `--target` also accepts a comma-separated list (e.g. `--target claude,codex`).
# Default target is "all": the six agents plus the server runtime tree at
# <home>/.meerkat-taskpanel. `--no-server` leaves the server out.
#
# It also asks (when stdin is a TTY and no flag was given) whether the supervisor
# may claim **unassigned** cards, and persists the answer as
# `<agent-dir>/meerkat-taskpanel.env` for the bundle agent kinds. Non-interactive runs
# default to yes; `--claim-unassigned=no` / `--assignee-only` opt out.
#
# The supervisor itself is **opt-in** and never a silent default: `--supervisor=enable`
# (or MEERKAT_TASKPANEL_SUPERVISOR, or answering **yes** to its TTY question, default
# **N**) runs the per-OS load of the units the install wrote; `disable` / `status` are
# the same entry point. Without a request the installer still only prints the load
# command. See docs/scheduling.md §Enabling the supervisor (opt-in).
#
# Before dispatching, it checks the runtime: Node >= 22 is required (the engine
# uses the built-in `node:sqlite` module), and a missing or older `node` is a hard
# error — so a machine that cannot run the board never gets a "successful" install.
# The check lives in scripts/install/_common.sh so a direct per-agent-kind run is guarded
# too; `--skip-node-check` bypasses it.
#
# The installer is deterministic and offline: it writes the skill into each agent's
# skill directory. For the two bundle agent kinds (claude, codex) it also deploys the rest of
# the bundle — agent configuration, slash commands (Claude) and the claim trigger
# (Codex) — merge-style and idempotently. It needs no agent CLI to do so, so it behaves
# the same on a bare machine and inside the verification container.
#
# Two skills are distributed, and they do not go to the same agent kinds:
#
#   meerkat-taskpanel  the board                    → all six agent kinds
#   meerkat-loop       the external supervisor  → claude, codex, pi, opencode, cursor
#                                                     (never openclaw)
#
# OpenClaw is excluded from the loop on purpose: the openclaw-team framework already
# ships an equivalent `poll` / `task-patrol`, so a second supervisor would only race the
# first for the same cards. See scripts/install/openclaw.sh and docs/scheduling.md.

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"

TARGET=""
PREFIX_HOME=""
AGENT_NAME=""
NO_AUTOMATION=""
CLAIM_UNASSIGNED_FLAG=""
RECOVER_STALE_FLAG=""
WORKFLOW_FLAG=""
AUTO_ACCEPT_REVIEWS_FLAG=""
REVIEWER_FLAG=""
ACCEPTANCE_FLAG=""
PING_INTERVAL_FLAG=""
CONTINUE_INTERVAL_FLAG=""
CONTINUE_FLAG=""
SUPERVISOR_FLAG=""
SUPERVISOR_ACTOR_KINDS_FLAG=""
SCHEDULER_FLAG=""
LINK=""
FORCE=""
DRY_RUN=""
SKIP_NODE_CHECK=""
SKIP_WEB_BUILD=""
NO_SERVER=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the Meerkat TaskPanel skills into one or more agent kinds, and
the server runtime tree.

Options:
  --target <agent>  claude | openclaw | codex | pi | opencode | cursor | server | all
                    (default: all — every agent above plus the server)
                    A comma-separated list is also accepted (claude,codex).
                    `server` materializes the runtime at <home>/.meerkat-taskpanel
                    and provides bin/taskd + bin/taskctl.
  --no-server       Install the agent skills only, leaving the server out
  --prefix <home>   Install relative to <home> instead of $HOME
  --agent-name <n>  Agent identity written into the agent bundle (default: $USER)
  --no-automation   Skip the Codex claim trigger and scheduling units
  --claim-unassigned=yes|no
                    May the supervisor claim unassigned cards? Persisted to the
                    agent config; also asked interactively on a TTY (default yes).
  --assignee-only   Alias for --claim-unassigned=no (claim only my own cards)
  --recover-stale=yes|no
                    Recover stale in_progress claims (same holder after 30 min,
                    any agent after 6 hours). Persisted to the agent config;
                    default yes.
  --workflow=yes|no Run the supervisor's workflow sub-pass (reconcile, review
                    dispatch, applying verdicts). Persisted to the agent config;
                    default yes.
  --reviewer <agent>
                    The independent reviewer that audits delivered cards. Unset
                    (the default) leaves deliveries for a human to accept.
  --auto-accept-reviews=yes|no
                    Let the loop close a review card after applying its verdict.
                    Persisted to the agent config; default yes. `no` leaves the
                    review card for a human.
  --acceptance=human-only|both|agent-only
                    Who may close a task. `human-only` accepts only a human on a
                    top-level card; `both` (the default) a human or the loop;
                    `agent-only` any non-human writer. Written to
                    install-root .env (the board is authoritative) and to the
                    agent config the loop reads. Asked interactively on a TTY.
                    Alias: --acceptance-policy.
  --ping-interval <sec>
                    The liveness clock (default 60). It only prunes dead worker
                    pids from the registry: no board read, no LLM.
  --continue-interval <sec>
                    The judgment clock (default 600 = 10 minutes). It hands the
                    resident control session a bounded "/meerkat-loop Continue"
                    prompt (or runs it one-shot when no pool is live); that turn
                    runs the poll, patrol and workflow entries.
  --continue=yes|no
                    Enable the continue turn (default yes). Persisted to the
                    agent config; `no` keeps the ping clock but discovers no work
                    until a human runs the poll entry.
  --supervisor=enable|disable|status
                    Opt in to the supervisor daemon: load / unload / report the
                    loop units the install just wrote — the resident session pool
                    (the dispatcher), the ping and continue clocks, and the event
                    subscriber. There is no silent default — a plain install still
                    only prints the load command — and on a TTY with no flag the
                    one-time question defaults to NO. Without the session unit the
                    loop runs patrol + workflow only and dispatches no worker.
                    Aliases: --enable-supervisor, --disable-supervisor,
                    --supervisor-status.
  --supervisor-actor-kinds <list>
                    Which loop actor kinds the action applies to: claude, codex, pi,
                    opencode or cursor (default: the loop actor kinds in --target).
                    'openclaw' is rejected (exit 2) — it runs openclaw-team's own
                    poll/patrol. The values are actor kinds — the same vocabulary
                    scripts/supervisor.mjs takes on --actor-kind.
  --scheduler <m>   auto | launchd | systemd | cron   (default: auto — launchd on
                    macOS, systemd --user on Linux, cron elsewhere). Only one
                    mechanism may be loaded per machine.
  --link            Symlink the skill instead of copying it (board skill only)
  --force           Overwrite an existing installation (never .env or .data)
  --dry-run         Print the destination paths and change nothing
  --skip-web-build  Never try to build web/dist; a server install is API-only if absent
  --skip-node-check Do not require Node (bypass the >= 22 runtime check)
  -h, --help        Show this help

Requires Node >= 22 (the engine uses the built-in node:sqlite module).
The check runs before anything is installed; a missing or older `node` is an
error. Pass --skip-node-check to bypass it.

Destinations:
  claude     <home>/.claude/skills/meerkat-taskpanel
  openclaw   <home>/.openclaw/skills/meerkat-taskpanel
  codex      <home>/.codex/skills/meerkat-taskpanel
  pi         <home>/.agents/skills/meerkat-taskpanel
  opencode   <home>/.config/opencode/skills/meerkat-taskpanel
  cursor     <home>/.cursor/skills/meerkat-taskpanel

Two skills, two distribution surfaces. The **board** skill goes to all six agent kinds. The
**loop** skill (the external supervisor) goes to the five non-OpenClaw agent kinds:

  claude     <home>/.claude/skills/meerkat-loop
  codex      <home>/.codex/skills/meerkat-loop
  pi         <home>/.agents/skills/meerkat-loop
  opencode   <home>/.config/opencode/skills/meerkat-loop
  cursor     <home>/.cursor/skills/meerkat-loop
  openclaw   — none, on purpose: the openclaw-team framework's poll / task-patrol
              automations already are this design (see docs/scheduling.md).

The loop is always **copied**, never symlinked: --link names the board skill only, or a
symlinked loop would put the checkout back into the load path the split removes.

The claim policy is written to <home>/<agent-dir>/meerkat-taskpanel.env for the agent kinds that
build a supervisor (claude, codex, pi, opencode, cursor); OpenClaw installs
openclaw-team instead.

The supervisor stays opt-in (--supervisor, above): without it, and without the
MEERKAT_TASKPANEL_SUPERVISOR below, a plain install only prints the load command.

Environment (set for each agent-kind installer):
  MEERKAT_TASKPANEL_TARGET_HOME  overrides $HOME
  MEERKAT_TASKPANEL_AGENT_NAME   agent identity (default: $USER)
  MEERKAT_TASKPANEL_NO_AUTOMATION "1" to skip the Codex claim trigger + scheduling
  MEERKAT_TASKPANEL_CLAIM_UNASSIGNED  "yes"/"no" default for the claim policy
  MEERKAT_TASKPANEL_PING_INTERVAL      liveness clock, seconds (default 60)
  MEERKAT_TASKPANEL_CONTINUE_INTERVAL  judgment clock, seconds (default 600)
  MEERKAT_TASKPANEL_CONTINUE           "yes"/"no" (default yes)
  MEERKAT_TASKPANEL_SUPERVISOR   "enable"/"disable"/"status" — the non-interactive
                                 form of --supervisor (an explicit flag wins)
  MEERKAT_TASKPANEL_SCHEDULER    "auto"/"launchd"/"systemd"/"cron" (default auto)
  MEERKAT_TASKPANEL_LINK         symlink instead of copy
  MEERKAT_TASKPANEL_FORCE        overwrite an existing destination
  MEERKAT_TASKPANEL_DRY_RUN      print only, change nothing
  MEERKAT_TASKPANEL_MIN_NODE     required Node major (default 22)
  MEERKAT_TASKPANEL_SKIP_NODE_CHECK  "1" to skip the Node version check
  MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE  "1" to skip the taskd keepalive guard
                                 (internal — for tests, not a user option)

The taskd keepalive guard is written and loaded on every install (one unit per
machine, at <prefix>/taskpanel/scheduling/) — see docs/scheduling.md. It has no
user flag and no prompt; the bypasses are --no-automation, --dry-run, and the
test-only MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE above.
EOF
}

die() {
  echo "install.sh: $*" >&2
  exit 2
}

# install_taskd_guard — write the `taskd` keepalive unit and load it (docs/scheduling.md).
#
# One unit per **machine**, not per agent kind: it is written once here, to the neutral
# `<prefix>/taskpanel/scheduling/` directory, and never touched by an agent kind's own
# scheduling install. It is also the one unit this installer *loads* rather than
# only printing a command for — a deliberate, narrow exception to "write the unit,
# never start a daemon for you". The loop supervisor's units keep that rule.
#
# Reporting is the point: the guard's whole job is a server that comes back after
# it dies, so an install says what it did (`enabled`, or `installed … not loaded`
# with the command that would) and how to stop it. A machine with no user service
# manager — a container, say — reports the second form instead of failing the
# install: the agent skills are installed either way, and the operator gets the one
# command that finishes the job. Never fatal, so it cannot mask an agent-kind failure.
install_taskd_guard() {
  # Automation off means this guard is off too, whichever way it was said. `NO_AUTOMATION`
  # is already normalised from the flag or `MEERKAT_TASKPANEL_NO_AUTOMATION` above, so one
  # test covers both spellings of the documented bypass; `TASKPANEL_NO_AUTOMATION` is the
  # pre-rename alias `_common.sh` still honours for the agent kinds. `=1` is the same test
  # `codex.sh` uses — a value that is not `1` is not a bypass.
  if [ "${NO_AUTOMATION:-}" = "1" ] || [ "${TASKPANEL_NO_AUTOMATION:-}" = "1" ]; then
    echo "taskd guard: skipped (--no-automation)"
    return 0
  fi
  if [ -n "$DRY_RUN" ]; then
    echo "taskd guard: skipped (dry-run)"
    return 0
  fi
  if [ "${MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE:-}" = "1" ]; then
    echo "taskd guard: skipped (MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1 — tests only)"
    return 0
  fi

  force_flag=""
  [ -n "$FORCE" ] && force_flag="--force"
  if [ "$SERVER_INSTALLED" = "1" ]; then
    # The keepalive runs the installed tree, and pins its data dir so the
    # one-guard-per-machine comparison sees a distinct board.
    node "$ROOT/scripts/install/lib/taskd-guard.mjs" install --prefix "$TARGET_HOME" \
      --root "$SERVER_ROOT" --data-dir "$SERVER_ROOT/.data" $force_flag
  else
    node "$ROOT/scripts/install/lib/taskd-guard.mjs" install --prefix "$TARGET_HOME" $force_flag
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || die "--target requires a value"
      TARGET="${TARGET:+$TARGET,}$2"   # repeatable; values accumulate
      shift 2
      ;;
    --target=*)
      TARGET="${TARGET:+$TARGET,}${1#*=}"
      shift
      ;;
    --prefix)
      [ "$#" -ge 2 ] || die "--prefix requires a value"
      PREFIX_HOME="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX_HOME="${1#*=}"
      shift
      ;;
    --agent-name)
      [ "$#" -ge 2 ] || die "--agent-name requires a value"
      AGENT_NAME="$2"
      shift 2
      ;;
    --agent-name=*)
      AGENT_NAME="${1#*=}"
      shift
      ;;
    --no-automation)
      NO_AUTOMATION="1"
      shift
      ;;
    --claim-unassigned)
      [ "$#" -ge 2 ] || die "--claim-unassigned requires a value (yes|no)"
      CLAIM_UNASSIGNED_FLAG="$2"
      shift 2
      ;;
    --claim-unassigned=*)
      CLAIM_UNASSIGNED_FLAG="${1#*=}"
      shift
      ;;
    --assignee-only)
      CLAIM_UNASSIGNED_FLAG="no"
      shift
      ;;
    --recover-stale)
      [ "$#" -ge 2 ] || die "--recover-stale requires a value (yes|no)"
      RECOVER_STALE_FLAG="$2"
      shift 2
      ;;
    --recover-stale=*)
      RECOVER_STALE_FLAG="${1#*=}"
      shift
      ;;
    --workflow)
      [ "$#" -ge 2 ] || die "--workflow requires a value (yes|no)"
      WORKFLOW_FLAG="$2"
      shift 2
      ;;
    --workflow=*)
      WORKFLOW_FLAG="${1#*=}"
      shift
      ;;
    --reviewer)
      [ "$#" -ge 2 ] || die "--reviewer requires an agent name"
      REVIEWER_FLAG="$2"
      shift 2
      ;;
    --reviewer=*)
      REVIEWER_FLAG="${1#*=}"
      shift
      ;;
    --auto-accept-reviews)
      [ "$#" -ge 2 ] || die "--auto-accept-reviews requires a value (yes|no)"
      AUTO_ACCEPT_REVIEWS_FLAG="$2"
      shift 2
      ;;
    --auto-accept-reviews=*)
      AUTO_ACCEPT_REVIEWS_FLAG="${1#*=}"
      shift
      ;;
    --acceptance)
      [ "$#" -ge 2 ] || die "--acceptance requires a value (human-only|both|agent-only)"
      ACCEPTANCE_FLAG="$2"
      shift 2
      ;;
    --acceptance=*)
      ACCEPTANCE_FLAG="${1#*=}"
      shift
      ;;
    --acceptance-policy)
      [ "$#" -ge 2 ] || die "--acceptance-policy requires a value (human-only|both|agent-only)"
      ACCEPTANCE_FLAG="$2"
      shift 2
      ;;
    --acceptance-policy=*)
      ACCEPTANCE_FLAG="${1#*=}"
      shift
      ;;
    --ping-interval)
      [ "$#" -ge 2 ] || die "--ping-interval requires a number of seconds"
      PING_INTERVAL_FLAG="$2"
      shift 2
      ;;
    --ping-interval=*)
      PING_INTERVAL_FLAG="${1#*=}"
      shift
      ;;
    --continue-interval)
      [ "$#" -ge 2 ] || die "--continue-interval requires a number of seconds"
      CONTINUE_INTERVAL_FLAG="$2"
      shift 2
      ;;
    --continue-interval=*)
      CONTINUE_INTERVAL_FLAG="${1#*=}"
      shift
      ;;
    --continue)
      [ "$#" -ge 2 ] || die "--continue requires a value (yes|no)"
      CONTINUE_FLAG="$2"
      shift 2
      ;;
    --continue=*)
      CONTINUE_FLAG="${1#*=}"
      shift
      ;;
    --supervisor)
      [ "$#" -ge 2 ] || die "--supervisor requires a value (enable|disable|status)"
      SUPERVISOR_FLAG="$2"
      shift 2
      ;;
    --supervisor=*)
      SUPERVISOR_FLAG="${1#*=}"
      shift
      ;;
    --enable-supervisor)
      SUPERVISOR_FLAG="enable"
      shift
      ;;
    --disable-supervisor)
      SUPERVISOR_FLAG="disable"
      shift
      ;;
    --supervisor-status)
      SUPERVISOR_FLAG="status"
      shift
      ;;
    --supervisor-actor-kinds)
      [ "$#" -ge 2 ] || die "--supervisor-actor-kinds requires a value (claude,codex,pi,opencode,cursor)"
      SUPERVISOR_ACTOR_KINDS_FLAG="$2"
      shift 2
      ;;
    --supervisor-actor-kinds=*)
      SUPERVISOR_ACTOR_KINDS_FLAG="${1#*=}"
      shift
      ;;
    --scheduler)
      [ "$#" -ge 2 ] || die "--scheduler requires a value (auto|launchd|systemd|cron)"
      SCHEDULER_FLAG="$2"
      shift 2
      ;;
    --scheduler=*)
      SCHEDULER_FLAG="${1#*=}"
      shift
      ;;
    --link)
      LINK="1"
      shift
      ;;
    --force)
      FORCE="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --skip-node-check)
      SKIP_NODE_CHECK="1"
      shift
      ;;
    --skip-web-build)
      SKIP_WEB_BUILD="1"
      shift
      ;;
    --no-server)
      NO_SERVER="1"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Runtime floor, before anything is dispatched. The same check the per-agent-kind scripts
# run (from scripts/install/_common.sh); doing it here first means one message appears
# before any "install.sh: <target>" line, and --skip-node-check resolves in one place.
# Only builtins are used, so a PATH with no node still reaches a clear message.
# legacy-name-compat: honour the pre-rename TASKPANEL_SKIP_NODE_CHECK too (this
# read runs before scripts/install/_common.sh, which normalises the rest).
SKIP_NODE_CHECK="${SKIP_NODE_CHECK:-${MEERKAT_TASKPANEL_SKIP_NODE_CHECK:-${TASKPANEL_SKIP_NODE_CHECK:-}}}"
[ -f "$ROOT/scripts/install/_common.sh" ] || die "missing installer helper: $ROOT/scripts/install/_common.sh"
. "$ROOT/scripts/install/_common.sh"
if [ "$SKIP_NODE_CHECK" = "1" ]; then
  echo "install.sh: --skip-node-check — not checking the Node version"
elif ! require_node; then
  echo "install.sh: aborting (re-run with --skip-node-check to bypass this check)." >&2
  exit 2
fi

# Normalize: split the target list on commas, drop blanks, keep first occurrences.
[ -n "$TARGET" ] || TARGET="all"
TARGETS=""
add_target() {
  # `--no-server` drops the server from whichever selection contributed it (`all`
  # includes it), leaving the agent skills — the source form of the npm flag.
  if [ "$1" = "server" ] && [ -n "$NO_SERVER" ]; then return 0; fi
  case "$TARGETS" in
    *" $1 "*) return 0 ;;
  esac
  TARGETS="$TARGETS $1 "
}

OLD_IFS="$IFS"
IFS=','
for raw in $TARGET; do
  IFS="$OLD_IFS"
  entry="$(echo "$raw" | tr -d '[:space:]')"
  IFS=','
  case "$entry" in
    "") ;;
    all)
      add_target claude
      add_target openclaw
      add_target codex
      add_target pi
      add_target opencode
      add_target cursor
      add_target server
      ;;
    claude | openclaw | codex | pi | opencode | cursor | server)
      add_target "$entry"
      ;;
    *)
      die "invalid --target: $entry (expected claude|openclaw|codex|pi|opencode|cursor|server|all)"
      ;;
  esac
done
IFS="$OLD_IFS"

if [ -z "$(echo "$TARGETS" | tr -d ' ')" ]; then
  if [ -n "$NO_SERVER" ]; then
    die "no targets selected — --no-server leaves no agent to install"
  fi
  die "no targets selected"
fi

# --prefix wins; otherwise honour an inherited MEERKAT_TASKPANEL_TARGET_HOME; else $HOME.
TARGET_HOME="${PREFIX_HOME:-${MEERKAT_TASKPANEL_TARGET_HOME:-$HOME}}"
DRY_RUN="${DRY_RUN:-${MEERKAT_TASKPANEL_DRY_RUN:-}}"
# Same for --no-automation: the flag, else the inherited environment. Without this the
# forwarding below would hand each agent-kind installer an *empty* MEERKAT_TASKPANEL_NO_AUTOMATION
# and silently overwrite the one the caller set, so the documented environment form of the
# bypass would skip nothing. (The pre-rename TASKPANEL_NO_AUTOMATION needs no line here:
# `_common.sh` still normalises it inside each agent-kind installer.)
NO_AUTOMATION="${NO_AUTOMATION:-${MEERKAT_TASKPANEL_NO_AUTOMATION:-}}"
SKIP_WEB_BUILD="${SKIP_WEB_BUILD:-${MEERKAT_TASKPANEL_SKIP_WEB_BUILD:-}}"

# The server target is the runtime tree at <home>/.meerkat-taskpanel. When it is
# selected, the agent skills must drive *that* tree, not the checkout/package they
# were copied from; agent-only installs leave both defaults alone.
SERVER_ROOT="$TARGET_HOME/.meerkat-taskpanel"
HAS_KIND_TARGET=0
SERVER_SELECTED=0
SERVER_INSTALLED=""
for target in $TARGETS; do
  if [ "$target" = "server" ]; then
    SERVER_SELECTED=1
  else
    HAS_KIND_TARGET=1
  fi
done

if [ "$SERVER_SELECTED" = "1" ]; then
  # server first: the agent shims and loop config name the tree, so it must exist
  # before any agent installer writes them.
  OLD_TARGETS="$TARGETS"
  TARGETS=" server "
  for target in $OLD_TARGETS; do
    [ "$target" = "server" ] || TARGETS="$TARGETS$target "
  done
  export MEERKAT_TASKPANEL_REPO="$SERVER_ROOT"
  export MEERKAT_TASKPANEL_ENV_FILE="$SERVER_ROOT/.env"
fi

# Resolve the "allow claiming unassigned tasks?" policy (per-agent-kind config default).
# An explicit flag wins; else the environment; else ask on a TTY (default yes) —
# and a dry run never blocks on a prompt. A bad value is a hard error, before any
# agent kind is dispatched, so a misspelt policy installs nothing.
CLAIM_FLAG="${CLAIM_UNASSIGNED_FLAG:-${MEERKAT_TASKPANEL_CLAIM_UNASSIGNED:-}}"
TTY=""
if [ -z "$DRY_RUN" ] && [ -t 0 ]; then
  TTY="1"
fi
if ! CLAIM_UNASSIGNED="$(claim_unassigned_value "$CLAIM_FLAG" "$TTY")"; then
  exit 2
fi
echo "install.sh: claim unassigned tasks: $CLAIM_UNASSIGNED"

# The workflow channel's three answers. Like the claim policy, an explicit flag wins,
# then the environment, then the default. A bad yes/no value is a hard error before
# any agent kind is dispatched — a misspelt policy must install nothing.
RECOVER_STALE="${RECOVER_STALE_FLAG:-${MEERKAT_TASKPANEL_RECOVER_STALE:-yes}}"
WORKFLOW="${WORKFLOW_FLAG:-${MEERKAT_TASKPANEL_WORKFLOW:-yes}}"
AUTO_ACCEPT_REVIEWS="${AUTO_ACCEPT_REVIEWS_FLAG:-${MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS:-yes}}"
REVIEWER="${REVIEWER_FLAG:-${MEERKAT_TASKPANEL_REVIEWER:-}}"
case "$RECOVER_STALE" in
  yes | no) ;;
  *) die "--recover-stale must be yes or no (got '$RECOVER_STALE')" ;;
esac
case "$WORKFLOW" in
  yes | no) ;;
  *) die "--workflow must be yes or no (got '$WORKFLOW')" ;;
esac
case "$AUTO_ACCEPT_REVIEWS" in
  yes | no) ;;
  *) die "--auto-accept-reviews must be yes or no (got '$AUTO_ACCEPT_REVIEWS')" ;;
esac
echo "install.sh: recover stale claims: $RECOVER_STALE"

# Who may close a task. The board's own copy is written after the agent kinds, below;
# this is the value every agent kind's config records for the loop.
ACC_SAID="${ACCEPTANCE_FLAG:-${MEERKAT_TASKPANEL_ACCEPTANCE_POLICY:-}}"
if ! ACCEPTANCE="$(acceptance_policy_value "$ACC_SAID" "$TTY")"; then
  exit 2
fi
echo "install.sh: acceptance policy: $ACCEPTANCE"
echo "install.sh: workflow: $WORKFLOW; reviewer: ${REVIEWER:-none}; auto-accept reviews: $AUTO_ACCEPT_REVIEWS"

# The scheduler's two clocks. The interval is rendered into the units, so it must
# be known here; the continue switch is persisted and read by the entry itself.
PING_INTERVAL="${PING_INTERVAL_FLAG:-${MEERKAT_TASKPANEL_PING_INTERVAL:-60}}"
CONTINUE_INTERVAL="${CONTINUE_INTERVAL_FLAG:-${MEERKAT_TASKPANEL_CONTINUE_INTERVAL:-600}}"
CONTINUE="${CONTINUE_FLAG:-${MEERKAT_TASKPANEL_CONTINUE:-yes}}"
case "$PING_INTERVAL" in "" | *[!0-9]*) die "--ping-interval must be a positive integer (got '$PING_INTERVAL')" ;; esac
case "$CONTINUE_INTERVAL" in "" | *[!0-9]*) die "--continue-interval must be a positive integer (got '$CONTINUE_INTERVAL')" ;; esac
[ "$PING_INTERVAL" -gt 0 ] || die "--ping-interval must be positive"
[ "$CONTINUE_INTERVAL" -gt 0 ] || die "--continue-interval must be positive"
case "$CONTINUE" in
  yes | no) ;;
  *) die "--continue must be yes or no (got '$CONTINUE')" ;;
esac
echo "install.sh: ping every ${PING_INTERVAL}s; continue every ${CONTINUE_INTERVAL}s ($CONTINUE)"

# Resolve the supervisor request (per-agent-kind, opt-in). An explicit flag wins; else the
# environment; else ask on a TTY — where the default is **no**, the opposite of the
# claim question above, because the supervisor is a daemon that runs unattended. An
# empty result is the plain install: units are written and the load command is printed.
SUPERVISOR_FLAG="${SUPERVISOR_FLAG:-${MEERKAT_TASKPANEL_SUPERVISOR:-}}"
if ! SUPERVISOR="$(supervisor_value "$SUPERVISOR_FLAG" "$TTY")"; then
  exit 2
fi
SCHEDULER="${SCHEDULER_FLAG:-${MEERKAT_TASKPANEL_SCHEDULER:-auto}}"
case "$SCHEDULER" in
  auto | launchd | systemd | cron) ;;
  *) die "invalid --scheduler: $SCHEDULER (expected auto|launchd|systemd|cron)" ;;
esac

# Which loop actor kinds the action applies to: --supervisor-actor-kinds, else the loop actor kinds this
# install covers. OpenClaw is never among them, and is rejected explicitly when named —
# it runs openclaw-team's own poll/patrol, so there is no meerkat-loop supervisor to
# enable (docs/scheduling.md §OpenClaw: do not build a supervisor).
if [ -n "$SUPERVISOR_ACTOR_KINDS_FLAG" ]; then
  SUPERVISOR_ACTOR_KINDS=""
  OLD_IFS="$IFS"
  IFS=','
  for raw in $SUPERVISOR_ACTOR_KINDS_FLAG; do
    IFS="$OLD_IFS"
    entry="$(echo "$raw" | tr -d '[:space:]')"
    IFS=','
    case "$entry" in
      "") ;;
      claude | codex | pi | opencode | cursor) SUPERVISOR_ACTOR_KINDS="$SUPERVISOR_ACTOR_KINDS $entry " ;;
      openclaw)
        die "--supervisor-actor-kinds openclaw: OpenClaw has no meerkat-loop supervisor to enable (it runs openclaw-team's own poll/patrol — see docs/scheduling.md)"
        ;;
      server)
        die "--supervisor-actor-kinds server: the server target has no meerkat-loop supervisor (the taskd guard is separate)"
        ;;
      *) die "invalid --supervisor-actor-kinds: $entry (expected claude|codex|pi|opencode|cursor)" ;;
    esac
  done
  IFS="$OLD_IFS"
else
  SUPERVISOR_ACTOR_KINDS=""
  for target in $TARGETS; do
    case "$target" in
      claude | codex | pi | opencode | cursor) SUPERVISOR_ACTOR_KINDS="$SUPERVISOR_ACTOR_KINDS $target " ;;
    esac
  done
fi

if [ -n "$SUPERVISOR" ] && [ -n "$(echo "$SUPERVISOR_ACTOR_KINDS" | tr -d ' ')" ]; then
  echo "install.sh: supervisor: $SUPERVISOR (kinds:$(echo "$SUPERVISOR_ACTOR_KINDS" | sed 's/ $//'), scheduler: $SCHEDULER)"
elif [ -n "$SUPERVISOR" ]; then
  echo "install.sh: supervisor: $SUPERVISOR — no loop actor kind to act on (OpenClaw runs openclaw-team's own poll/patrol)"
fi

if [ -n "$DRY_RUN" ]; then
  echo "install.sh: dry run — no files will be changed"
fi

# One config file for the agent kinds. Called once, not per agent kind; never overwrites an
# existing file (it may hold a token). A server-only install lets server.sh seed
# the tree's own `.env`; a full install seeds that same path via the exported
# MEERKAT_TASKPANEL_ENV_FILE above.
if [ "$HAS_KIND_TARGET" = "1" ]; then
  seed_env_file
fi

status=0
summary=""

for target in $TARGETS; do
  installer="$ROOT/scripts/install/$target.sh"
  if [ ! -f "$installer" ]; then
    echo "install.sh: missing installer for target '$target': $installer" >&2
    summary="$summary
FAIL $target — installer not found"
    status=1
    continue
  fi

  echo "install.sh: $target"

  # The supervisor action is per agent kind: one outside --supervisor-actor-kinds is handed an
  # empty request, so it installs exactly as it always did (write the units, print the
  # load command) and `_common.sh` never starts anything for it.
  kind_supervisor=""
  case " $SUPERVISOR_ACTOR_KINDS " in
    *" $target "*) kind_supervisor="$SUPERVISOR" ;;
  esac

  if MEERKAT_TASKPANEL_TARGET_HOME="$TARGET_HOME" \
      MEERKAT_TASKPANEL_AGENT_NAME="$AGENT_NAME" \
      MEERKAT_TASKPANEL_NO_AUTOMATION="$NO_AUTOMATION" \
      MEERKAT_TASKPANEL_CLAIM_UNASSIGNED="$CLAIM_UNASSIGNED" \
      MEERKAT_TASKPANEL_RECOVER_STALE="$RECOVER_STALE" \
      MEERKAT_TASKPANEL_WORKFLOW="$WORKFLOW" \
      MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS="$AUTO_ACCEPT_REVIEWS" \
      MEERKAT_TASKPANEL_REVIEWER="$REVIEWER" \
      MEERKAT_TASKPANEL_ACCEPTANCE_POLICY="$ACCEPTANCE" \
      MEERKAT_TASKPANEL_PING_INTERVAL="$PING_INTERVAL" \
      MEERKAT_TASKPANEL_CONTINUE_INTERVAL="$CONTINUE_INTERVAL" \
      MEERKAT_TASKPANEL_CONTINUE="$CONTINUE" \
      MEERKAT_TASKPANEL_SUPERVISOR="$kind_supervisor" \
      MEERKAT_TASKPANEL_SCHEDULER="$SCHEDULER" \
      MEERKAT_TASKPANEL_LINK="$LINK" \
      MEERKAT_TASKPANEL_FORCE="$FORCE" \
      MEERKAT_TASKPANEL_DRY_RUN="$DRY_RUN" \
      MEERKAT_TASKPANEL_SKIP_NODE_CHECK="1" \
      MEERKAT_TASKPANEL_SKIP_WEB_BUILD="$SKIP_WEB_BUILD" \
      bash "$installer"; then
    if [ "$target" = "server" ]; then
      SERVER_INSTALLED=1
      summary="$summary
OK   server — $SERVER_ROOT"
    else
      summary="$summary
OK   $target — $TARGET_HOME"
    fi
  else
    summary="$summary
FAIL $target — see the message above (re-run with --force to overwrite an existing install)"
    status=1
  fi
done

# The taskd keepalive guard, once for the machine rather than once per agent kind, and
# after the agent kinds so its report closes the install's own work (see the function
# above). Non-fatal by design: a failed agent kind is already reported, and letting the
# guard step abort the run would leave its message as the only explanation.
echo
if ! install_taskd_guard; then
  echo "install.sh: the taskd guard step failed (see the message above)" >&2
fi

# The board's own copy of the policy. The agent config above is what the loop
# *believes*; the install-root `.env` is what the board enforces, and it is the
# same file the Access panel writes (the writer merges, never rewrites).
if [ "$ACCEPTANCE" = "agent-only" ]; then
  # Warnings, not refusals: *which* agent closes a card is the deployment's
  # business, but each of these leaves the board with no automated closer at all.
  if [ "$WORKFLOW" != "yes" ]; then
    echo "install.sh: warning: agent-only with --workflow=no — nothing will close a delivered card" >&2
  fi
  if [ "$AUTO_ACCEPT_REVIEWS" != "yes" ]; then
    echo "install.sh: warning: agent-only with --auto-accept-reviews=no — review cards will pile up for a human who may not close them" >&2
  fi
  if [ -z "$REVIEWER" ]; then
    echo "install.sh: warning: agent-only with no --reviewer — deliveries will not be reviewed automatically" >&2
  fi
  if [ -n "$NO_AUTOMATION" ]; then
    echo "install.sh: warning: agent-only with --no-automation — only an external agent can close a card" >&2
  fi
  loop_kind=""
  for candidate in $TARGETS; do
    case "$candidate" in
      claude | codex | pi) loop_kind="1" ;;
    esac
  done
  if [ -z "$loop_kind" ]; then
    echo "install.sh: warning: agent-only with no loop agent kind installed — only an external agent can close a card" >&2
  fi
fi

acceptance_env=()
if [ -n "${MEERKAT_TASKPANEL_ENV_FILE:-}" ]; then
  acceptance_env=(--env-file "$MEERKAT_TASKPANEL_ENV_FILE")
fi
if [ -n "$DRY_RUN" ]; then
  echo "install.sh: would write TASKD_ACCEPTANCE_POLICY=$ACCEPTANCE to ${MEERKAT_TASKPANEL_ENV_FILE:-the install-root .env}"
else
  if ! node "$ROOT/scripts/install/lib/acceptance.mjs" write --policy "$ACCEPTANCE" ${acceptance_env[@]+"${acceptance_env[@]}"}; then
    echo "install.sh: could not write the board's acceptance policy (see above)" >&2
    status=1
  fi
fi

echo
echo "== install summary =="
echo "$summary" | sed '/^$/d'

if [ "$status" -ne 0 ]; then
  echo
  echo "install.sh: one or more agent kinds failed (exit $status)" >&2
else
  echo
  if [ -n "$DRY_RUN" ]; then
    echo "install.sh: dry run complete — nothing was changed"
  else
    echo "install.sh: done. Next step: register the agent's plugin/bundle (see docs/install.md),"
    echo "             or point the agent at the installed skill directory."
  fi
fi

exit "$status"
