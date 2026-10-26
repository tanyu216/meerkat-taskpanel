#!/usr/bin/env bash
#
# server — materialize the whole runtime at <target_home>/.meerkat-taskpanel.
#
# This is not an agent bundle: no skill, no loop units. It is the
# board program itself (src/** + the built frontend) plus the taskd/taskctl
# launchers, and it is the same materializer the npm/npx installer drives.
#
# The tree is self-locating: `.env`, `.data` and `web/dist` resolve from the
# copied `src/` with no environment variables.
set -eu

. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

require_node

# The version floor can be skipped, but the materializer is a Node program: without
# any node there is nothing to run it with. Say that plainly instead of letting the
# shell print "node: command not found".
if ! command -v node >/dev/null 2>&1; then
  echo "server: the server target needs node on PATH (--skip-node-check skips only the version floor)" >&2
  exit 1
fi

SERVER_ROOT="$(target_home)/.meerkat-taskpanel"

if [ -n "${MEERKAT_TASKPANEL_LINK:-}" ]; then
  echo "server: --link does not apply to the server target — the runtime tree is always copied" >&2
fi

args=(install --root "$(repo_root)" --dest "$SERVER_ROOT")
[ -n "${MEERKAT_TASKPANEL_FORCE:-}" ] && args+=(--force)
[ -n "${MEERKAT_TASKPANEL_DRY_RUN:-}" ] && args+=(--dry-run)
[ -n "${MEERKAT_TASKPANEL_SKIP_WEB_BUILD:-}" ] && args+=(--skip-web-build)

node "$(script_dir)/lib/server-install.mjs" "${args[@]}"

# The tree's one config file. Never overwrites an existing one (it may hold a
# token); `MEERKAT_TASKPANEL_ENV_FILE` is deliberately ignored here so the
# installed tree always owns its config.
seed_env_file "$SERVER_ROOT/.env"
