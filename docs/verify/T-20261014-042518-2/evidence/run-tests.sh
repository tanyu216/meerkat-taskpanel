#!/bin/sh
# T-20261014-042518-2 — host test evidence collector.
#
# `node --test` on the host is explicitly allowed (docs/docker.md §Host-allowed
# checks: "`node --test` and `node --check` (parsing and unit tests)"). Nothing
# here installs, serves or deploys, so no container is involved.
#
#   sh docs/verify/T-20261014-042518-2/evidence/run-tests.sh
#
set -u
echo "# T-20261014-042518-2 — host test evidence"
echo "# lane HEAD: $(git rev-parse HEAD)"
echo

for f in \
  test/shared/task-order.test.mjs \
  test/server/task-order.test.mjs \
  test/core/commands/task-order-scale.test.mjs \
  test/core/commands/tasks.test.mjs \
  test/contract/md-blocked-reason.test.mjs \
  test/contract/state-machine.test.mjs
do
  echo "### node --test $f"
  node --test "$f" 2>&1 | grep -E '^ℹ (tests|pass|fail)|^✖|assertion 10|does not read|without truncating|marking blocked_at|leaves blocked_at'
  echo
done

echo '### node --test "test/core/storage/repositories/**/*.test.mjs"'
node --test "test/core/storage/repositories/**/*.test.mjs" 2>&1 | grep -E '^ℹ (tests|pass|fail)|marking blocked_at'
