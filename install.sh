#!/usr/bin/env bash
#
# Task Panel installer.
#
# Thin dispatcher: it parses the shared flags once and then runs
# scripts/install/<host>.sh for each requested host, forwarding the options
# through TASKPANEL_* environment variables.
#
# Usage:
#   install.sh [--target claude|openclaw|codex|pi|all] [--prefix <home>]
#              [--link] [--force] [--dry-run] [-h|--help]
#
# `--target` also accepts a comma-separated list (e.g. `--target claude,codex`).
# Default target is "all".
#
# The installer is deterministic and offline: it writes the skill into each host's
# skill directory and nothing else. It never starts a host CLI, so it behaves the same
# on a bare machine and inside the verification container. The per-host plugin/bundle
# registration commands (which do need the host CLI) are listed in docs/install.md and
# `install.sh` prints the relevant one as a next step.

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"

TARGET=""
PREFIX_HOME=""
LINK=""
FORCE=""
DRY_RUN=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the Task Panel skill into one or more agent hosts.

Options:
  --target <host>   claude | openclaw | codex | pi | all   (default: all)
                    A comma-separated list is also accepted (claude,codex).
  --prefix <home>   Install relative to <home> instead of $HOME
  --link            Symlink the skill instead of copying it
  --force           Overwrite an existing installation
  --dry-run         Print the destination paths and change nothing
  -h, --help        Show this help

Destinations:
  claude     <home>/.claude/skills/task-panel
  openclaw   <home>/.openclaw/skills/task-panel
  codex      <home>/.codex/skills/task-panel
  pi         <home>/.agents/skills/task-panel

Environment (set for each host installer):
  TASKPANEL_TARGET_HOME  overrides $HOME
  TASKPANEL_LINK         symlink instead of copy
  TASKPANEL_FORCE        overwrite an existing destination
  TASKPANEL_DRY_RUN      print only, change nothing
EOF
}

die() {
  echo "install.sh: $*" >&2
  exit 2
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

# Normalize: split the target list on commas, drop blanks, keep first occurrences.
[ -n "$TARGET" ] || TARGET="all"
HOSTS=""
add_host() {
  case "$HOSTS" in
    *" $1 "*) return 0 ;;
  esac
  HOSTS="$HOSTS $1 "
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
      add_host claude
      add_host openclaw
      add_host codex
      add_host pi
      ;;
    claude | openclaw | codex | pi)
      add_host "$entry"
      ;;
    *)
      die "invalid --target: $entry (expected claude|openclaw|codex|pi|all)"
      ;;
  esac
done
IFS="$OLD_IFS"

[ -n "$(echo "$HOSTS" | tr -d ' ')" ] || die "no targets selected"

# --prefix wins; otherwise honour an inherited TASKPANEL_TARGET_HOME; else $HOME.
TARGET_HOME="${PREFIX_HOME:-${TASKPANEL_TARGET_HOME:-$HOME}}"
DRY_RUN="${DRY_RUN:-${TASKPANEL_DRY_RUN:-}}"

if [ -n "$DRY_RUN" ]; then
  echo "install.sh: dry run — no files will be changed"
fi

status=0
summary=""

for host in $HOSTS; do
  installer="$ROOT/scripts/install/$host.sh"
  if [ ! -f "$installer" ]; then
    echo "install.sh: missing installer for host '$host': $installer" >&2
    summary="$summary
FAIL $host — installer not found"
    status=1
    continue
  fi

  echo "install.sh: $host"
  if TASKPANEL_TARGET_HOME="$TARGET_HOME" \
      TASKPANEL_LINK="$LINK" \
      TASKPANEL_FORCE="$FORCE" \
      TASKPANEL_DRY_RUN="$DRY_RUN" \
      bash "$installer"; then
    summary="$summary
OK   $host — $TARGET_HOME"
  else
    summary="$summary
FAIL $host — see the message above (re-run with --force to overwrite an existing install)"
    status=1
  fi
done

echo
echo "== install summary =="
echo "$summary" | sed '/^$/d'

if [ "$status" -ne 0 ]; then
  echo
  echo "install.sh: one or more hosts failed (exit $status)" >&2
else
  echo
  if [ -n "$DRY_RUN" ]; then
    echo "install.sh: dry run complete — nothing was changed"
  else
    echo "install.sh: done. Next step: register the host plugin/bundle (see docs/install.md),"
    echo "             or point the host at the installed skill directory."
  fi
fi

exit "$status"
