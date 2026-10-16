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

# The frontend coverage verdict, *before* the suite that depends on it. `node --test` holds
# two legs behind `web/dist` (`blocks.bundle`, `blocks.dom`) and reports `fail 0` when they
# skip — so a webbuild stage that silently emitted an empty `web/dist` would show up only as
# two quiet skips. The image's `webbuild` stage builds `web/dist` itself, so here the bundle
# leg is *required* to be covered, and this step fails closed (exit 3) if it is not. The DOM
# leg is structurally uncovered in the image — no Chromium, the documented §9.1 exception —
# and the step prints that rather than letting it pass as coverage.
step "frontend coverage (web/dist built by the webbuild stage; bundle leg required)"
node scripts/verify/web-dist.mjs --require=bundle

step "node --test"
node --test

step "npm run test:coverage (src/core + src/shared >= 80% line/branch/function)"
npm run test:coverage

step "npm run check"
npm run check

step "API contract snapshot (routes + route request shapes + error codes + wire fields)"
node scripts/verify/contract.mjs

step "route request lint (declared schema vs what the handler reads)"
node scripts/verify/route-request.mjs

step "install.sh --target all --dry-run"
bash install.sh --target all --dry-run

step "skill install profiles (all six hosts, throwaway home)"
node scripts/verify/profiles.mjs

step "host runtime claim path (offline mock harness: hook / trigger / wake scripts)"
node scripts/verify/host-runtime.mjs

# The deepest step: a fresh machine's first run — install the skill for all six hosts
# with a throwaway HOME, then drive the real `taskctl` against a real `taskd`. It lives
# here, and not only in CI, so `npm run verify:docker` and the CI `docker` job cover
# exactly the same ground: a green local run means a green CI run.
step "install + first-run end-to-end (throwaway HOME)"
bash scripts/verify/install-e2e.sh

echo
echo "== all container checks passed =="
