#!/usr/bin/env bash
#
# Full verification suite, run *inside* the container.
#
# This is the single source of truth for "is the repository healthy": both CI and
# `npm run verify:docker` invoke exactly this script, so a green local run and a green
# CI run mean the same thing.
#
#   docker run --rm task-panel:verify bash docker/verify-in-container.sh
#   npm run verify:docker:container        # when already inside the image
#
# Each step prints a `== ... ==` header. Any failure exits non-zero immediately.
# No step installs anything: the project is dependency-free and must run offline.

set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  echo
  echo "== $* =="
}

step "node --test"
node --test

step "npm run check"
npm run check

step "install.sh --target all --dry-run"
bash install.sh --target all --dry-run

step "skill install profiles (all four hosts, throwaway home)"
node scripts/verify/profiles.mjs

echo
echo "== all container checks passed =="
