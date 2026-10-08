#!/usr/bin/env bash
#
# Shared implementation for the per-host installers (claude / openclaw / codex / pi).
#
# Each host script is a two-line stub that sources this file and calls `install_skill`
# with its host directory. Honours:
#
#   TASKDASH_TARGET_HOME  base home directory (default: $HOME)
#   TASKDASH_LINK         "1" to symlink instead of copy
#   TASKDASH_FORCE        "1" to overwrite an existing destination
#   TASKDASH_DRY_RUN      "1" to print what would happen and change nothing

set -eu

# install_skill <host_dir> <label>
#   <host_dir>  dot-directory under the target home, e.g. ".claude"
#   <label>     human-readable host name, e.g. "claude"
install_skill() {
  host_dir="$1"
  label="$2"

  script_dir="$(cd "$(dirname "$0")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  src="$repo_root/skills/task-dashboard"

  target_home="${TASKDASH_TARGET_HOME:-$HOME}"
  dest="$target_home/$host_dir/skills/task-dashboard"

  if [ ! -d "$src" ]; then
    echo "$label: skill source not found: $src" >&2
    return 1
  fi

  if [ -n "${TASKDASH_DRY_RUN:-}" ]; then
    if [ -n "${TASKDASH_LINK:-}" ]; then
      echo "would link  $src -> $dest"
    else
      echo "would copy  $src -> $dest"
    fi
    return 0
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -z "${TASKDASH_FORCE:-}" ]; then
      echo "$label: destination already exists: $dest" >&2
      echo "$label: re-run with --force to overwrite it." >&2
      return 1
    fi
    rm -rf "$dest"
  fi

  mkdir -p "$(dirname "$dest")"

  if [ -n "${TASKDASH_LINK:-}" ]; then
    ln -s "$src" "$dest"
    echo "$label: linked  $dest"
  else
    cp -R "$src" "$dest"
    echo "$label: copied  $dest"
  fi
}
