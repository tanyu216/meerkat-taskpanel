#!/usr/bin/env bash
#
# Install + first-run end-to-end, run *inside* the container.
#
# Where `docker/verify-in-container.sh` proves the repository is healthy, this
# script proves a *fresh machine* can use it: it installs the skill into all four
# hosts with a throwaway HOME, then drives the real `taskctl` through its real
# `taskd` — create a project, create a card, get refused by the delivery gate,
# satisfy the gate with a report, and read the dictionaries back.
#
#   docker run --rm meerkat-taskpanel:verify bash scripts/verify/install-e2e.sh
#
# Isolation: `HOME` for the install is a fresh `mktemp -d`, and the board's data
# directory is another one — nothing here can touch `./.data`, `~/.claude`, or a
# developer's running board. `TASKD_PORT=0` lets the OS pick a port, so a
# developer's own taskd on 9527 is never in the way.
#
# Each step prints a `== ... ==` header. Any failure exits non-zero immediately;
# the throwaway directories (and the taskd the CLI started) are cleaned up on the
# way out.

set -euo pipefail

cd "$(dirname "$0")/../.."

step() {
  echo
  echo "== $* =="
}

CLI="$(pwd)/src/cli/index.mjs"

THROWAWAY_HOME="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"
POINTER="$DATA_DIR/runtime.json"
REPORT_FILE="$DATA_DIR/report.json"

cleanup() {
  # Stop the taskd the CLI autostarted (if it did), then drop the throwaways.
  if [ -f "$POINTER" ]; then
    pid="$(node -e 'try{process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).pid||""))}catch{}' "$POINTER" 2>/dev/null || true)"
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  fi
  rm -rf "$THROWAWAY_HOME" "$DATA_DIR"
}
trap cleanup EXIT

# A board in the throwaway data dir, on an OS-assigned port. Autostart is left
# ON: starting taskd from the CLI *is* the path under test.
export TASKD_DATA_DIR="$DATA_DIR"
export TASKD_RUNTIME_POINTER="$POINTER"
export TASKD_PORT=0
export TASKD_HOST=127.0.0.1
export TASKCTL_AGENT="install-e2e"
unset TASKD_NO_AUTOSTART

step "install.sh --target all --prefix <throwaway home>"
bash install.sh --target all --prefix "$THROWAWAY_HOME"

for host_dir in .claude .openclaw .codex .agents; do
  target="$THROWAWAY_HOME/$host_dir/skills/meerkat-taskpanel/SKILL.md"
  if [ ! -f "$target" ]; then
    echo "FAIL: install did not write $target" >&2
    exit 1
  fi
  echo "  OK  $host_dir/skills/meerkat-taskpanel/SKILL.md"
done

step "taskctl project create"
node "$CLI" project create --id demo --name "E2E Demo" --workspace-path "$(pwd)"

step "taskctl issue create"
CREATE_JSON="$(node "$CLI" --json issue create \
  --project demo \
  --title "Install e2e card" \
  --acceptance "the delivery gate refuses an empty report" \
  --label e2e \
  --assignee install-e2e-bot)"
echo "$CREATE_JSON"
ID="$(printf '%s' "$CREATE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.task.identifier))')"
echo "  task identifier: $ID"

step "taskctl issue move $ID in_progress"
node "$CLI" issue move "$ID" in_progress

step "taskctl issue move $ID in_review  (NEGATIVE: no report — must be refused)"
set +e
NEGATIVE="$(node "$CLI" --json issue move "$ID" in_review 2>&1)"
STATUS=$?
set -e
echo "$NEGATIVE"
if [ "$STATUS" -eq 0 ]; then
  echo "FAIL: moving to in_review without a report succeeded (exit 0); the gate is open" >&2
  exit 1
fi
case "$NEGATIVE" in
  *REPORT_REQUIRED*) ;;
  *)
    echo "FAIL: expected the refusal to name REPORT_REQUIRED (exit was $STATUS)" >&2
    exit 1
    ;;
esac
echo "  OK  refused with exit $STATUS and error code REPORT_REQUIRED"

step "taskctl report template $ID > report.json"
node "$CLI" report template "$ID" > "$REPORT_FILE"
echo "  wrote a report template to $REPORT_FILE"

step "taskctl issue deliver $ID --report-file report.json  (POSITIVE)"
node "$CLI" issue deliver "$ID" --report-file "$REPORT_FILE"

step "taskctl labels list"
node "$CLI" labels list

step "taskctl assignees list"
node "$CLI" assignees list

echo
echo "== all install e2e checks passed =="
