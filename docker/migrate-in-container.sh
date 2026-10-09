#!/usr/bin/env bash
#
# M5 shadow-reconciliation drill, run *inside* the container.
#
# Reads a directory of markdown cards and a projects.json registry (both mounted
# **read-only**), runs scripts/migrate/reconcile.mjs into a throwaway workdir, and
# writes the JSON report to the mounted out dir. The report is statistics, hashes
# and identifiers only — never a card title or body — so it is safe to keep.
#
#   docker run --rm \
#     -v "$HOME/.openclaw/team/tasks:/cards:ro" \
#     -v "$HOME/.openclaw/team/projects.json:/projects.json:ro" \
#     -v "$PWD/.data/migrate-out:/out" \
#     meerkat-taskpanel:verify bash docker/migrate-in-container.sh
#
# Override the mount points (not the mounts themselves) with CARDS_DIR,
# PROJECTS_FILE, OUT_DIR. Exit code is reconcile's own: 0 no differences ·
# 3 differences · 2 bad usage · 1 the run failed.

set -uo pipefail

cd "$(dirname "$0")/.."

CARDS_DIR="${CARDS_DIR:-/cards}"
PROJECTS_FILE="${PROJECTS_FILE:-/projects.json}"
OUT_DIR="${OUT_DIR:-/out}"
REPORT="${OUT_DIR}/reconcile-report.json"

echo "== M5 migration drill (in-container) =="
echo "cards:    ${CARDS_DIR}  (read-only mount)"
echo "projects: ${PROJECTS_FILE}  (read-only mount)"
echo "report:   ${REPORT}"
echo

for path in "$CARDS_DIR" "$PROJECTS_FILE"; do
  if [ ! -e "$path" ]; then
    echo "error: ${path} is not mounted — bind-mount it read-only, there is nothing to reconcile" >&2
    exit 2
  fi
done

# The image runs as the unprivileged `node` user; the mounted out dir must accept
# a write from it (the host wrapper creates it 0777).
if ! mkdir -p "$OUT_DIR" 2>/dev/null || [ ! -w "$OUT_DIR" ]; then
  echo "error: ${OUT_DIR} is not writable by $(id -un) — mount a writable out dir" >&2
  exit 2
fi

node scripts/migrate/reconcile.mjs \
  --dir "$CARDS_DIR" \
  --projects "$PROJECTS_FILE" \
  --out "$REPORT"
code=$?

echo
echo "== drill complete =="
echo "reconcile exit code: ${code}  (0 = zero differences · 3 = differences · 1 = failed)"
echo "report: ${REPORT}"
exit "$code"
