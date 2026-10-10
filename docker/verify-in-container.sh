#!/usr/bin/env bash
#
# Full verification suite, run *inside* the container.
#
# This is the single source of truth for "is the repository healthy": both CI and
# `npm run verify:docker` invoke exactly this script, so a green local run and a green
# CI run mean the same thing.
#
#   docker run --rm meerkat-taskpanel:verify bash docker/verify-in-container.sh
#   npm run verify:docker:container        # when already inside the image
#
# Each step prints a `== ... ==` header. Any failure exits non-zero immediately.
# Nothing here reaches the network: the project is dependency-free. Two steps install
# into throwaway homes — the four-host skill profiles, and the install + first-run
# end-to-end, which additionally drives the real `taskctl` against a real `taskd`.

set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  echo
  echo "== $* =="
}

step "node --test"
node --test

step "npm run test:coverage (src/core + src/shared >= 80% line/branch/function)"
npm run test:coverage

step "npm run check"
npm run check

step "API contract snapshot (routes + route request shapes + error codes + wire fields)"
node scripts/verify/contract.mjs

step "install.sh --target all --dry-run"
bash install.sh --target all --dry-run

step "skill install profiles (all four hosts, throwaway home)"
node scripts/verify/profiles.mjs

step "host runtime claim path (offline mock harness: hook / trigger / wake scripts)"
node scripts/verify/host-runtime.mjs

# The deepest step: a fresh machine's first run — install the skill for all four hosts
# with a throwaway HOME, then drive the real `taskctl` against a real `taskd`. It lives
# here, and not only in CI, so `npm run verify:docker` and the CI `docker` job cover
# exactly the same ground: a green local run means a green CI run.
step "install + first-run end-to-end (throwaway HOME)"
bash scripts/verify/install-e2e.sh

echo
echo "== all container checks passed =="
