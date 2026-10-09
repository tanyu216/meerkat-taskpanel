#!/usr/bin/env bash
#
# Shared implementation for the per-host installers (claude / openclaw / codex / pi).
#
# Each host script is a two-line stub that sources this file and calls `install_skill`
# with its host directory. Honours:
#
#   TASKPANEL_TARGET_HOME  base home directory (default: $HOME)
#   TASKPANEL_LINK         "1" to symlink instead of copy
#   TASKPANEL_FORCE        "1" to overwrite an existing destination
#   TASKPANEL_DRY_RUN      "1" to print what would happen and change nothing
#   TASKPANEL_MIN_NODE     required Node major (default: 22)
#   TASKPANEL_SKIP_NODE_CHECK  "1" to skip the Node version check

set -eu

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
  min="${TASKPANEL_MIN_NODE:-22}"

  if ! command -v node >/dev/null 2>&1; then
    echo "node: no 'node' on PATH." >&2
    echo "Task Panel needs Node >= $min (the engine uses the built-in node:sqlite module)." >&2
    echo "Install Node $min or newer, then re-run: https://nodejs.org/  (or 'nvm install $min')." >&2
    return 1
  fi

  version="$(node -v 2>/dev/null || true)"
  major="${version#v}"   # v22.11.0 -> 22.11.0
  major="${major%%.*}"   # 22.11.0  -> 22
  case "$major" in
    "" | *[!0-9]*)
      echo "node: could not read the version ('node -v' printed '${version:-<empty>}')." >&2
      echo "Task Panel needs Node >= $min." >&2
      return 1
      ;;
  esac

  if [ "$major" -lt "$min" ]; then
    echo "node: $version is too old — Task Panel needs Node >= $min." >&2
    echo "The engine uses the built-in node:sqlite module (Node $min+)." >&2
    echo "Upgrade Node, then re-run: https://nodejs.org/  (or 'nvm install $min')." >&2
    return 1
  fi
}

# install_skill <host_dir> <label>
#   <host_dir>  dot-directory under the target home, e.g. ".claude"
#   <label>     human-readable host name, e.g. "claude"
install_skill() {
  host_dir="$1"
  label="$2"

  # Node floor first: nothing is copied onto a runtime that cannot run it.
  require_node || return 1

  script_dir="$(cd "$(dirname "$0")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  src="$repo_root/skills/task-panel"

  target_home="${TASKPANEL_TARGET_HOME:-$HOME}"
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
      echo "$label: destination already exists: $dest" >&2
      echo "$label: re-run with --force to overwrite it." >&2
      return 1
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
