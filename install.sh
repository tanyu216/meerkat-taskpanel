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
# Default target is "all".

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"

TARGET="all"
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

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || { echo "install.sh: --target requires a value" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --target=*)
      TARGET="${1#*=}"
      shift
      ;;
    --prefix)
      [ "$#" -ge 2 ] || { echo "install.sh: --prefix requires a value" >&2; exit 2; }
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

case "$TARGET" in
  claude | openclaw | codex | pi)
    HOSTS="$TARGET"
    ;;
  all)
    HOSTS="claude openclaw codex pi"
    ;;
  *)
    echo "install.sh: invalid --target: $TARGET (expected claude|openclaw|codex|pi|all)" >&2
    exit 2
    ;;
esac

# --prefix wins; otherwise honour an inherited TASKPANEL_TARGET_HOME; else $HOME.
TARGET_HOME="${PREFIX_HOME:-${TASKPANEL_TARGET_HOME:-$HOME}}"
DRY_RUN="${DRY_RUN:-${TASKPANEL_DRY_RUN:-}}"

status=0

for host in $HOSTS; do
  installer="$ROOT/scripts/install/$host.sh"
  if [ ! -f "$installer" ]; then
    echo "install.sh: missing installer for host '$host': $installer" >&2
    status=1
    continue
  fi

  TASKPANEL_TARGET_HOME="$TARGET_HOME" \
    TASKPANEL_LINK="$LINK" \
    TASKPANEL_FORCE="$FORCE" \
    TASKPANEL_DRY_RUN="$DRY_RUN" \
    bash "$installer" || status=1
done

exit "$status"
