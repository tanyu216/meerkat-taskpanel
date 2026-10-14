#!/usr/bin/env bash
#
# T-20261012-234655 — do the R1/R2/R3 assertions still have teeth?
#
# Each mutation is applied to a *pristine* `git archive HEAD` copy in the
# scratch directory (never to the lane worktree, which stays read-only), the
# matching check is re-run, and the failing-test set is compared with the
# baseline. A mutation "has teeth" when it makes at least one assertion that
# passed in the baseline fail — and the baseline environment reds (all of them
# `listen EPERM`) must stay exactly as they were, or the comparison is void.
#
# Usage: bash docs/verify/T-20261012-234655/evidence/mutations.sh

set -u

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
EVID="$ROOT/docs/verify/T-20261012-234655/evidence"
OUT="$EVID/mutations"
SCRATCH="/Users/tanyu/.openclaw/tmp"
mkdir -p "$OUT"

failures() { grep -h '^✖ ' "$1" | sed 's/ ([0-9.]*ms)$//' | sort -u; }

new_mutant() {
  local dir
  dir="$(mktemp -d "$SCRATCH/mutXXXXXX")"
  git archive HEAD | tar -x -C "$dir"
  printf '%s' "$dir"
}

echo "== baseline (unmutated) =="
( cd "$ROOT" && node --test test/concurrency/writer-guard.test.mjs ) > "$OUT/baseline-writer-guard.log" 2>&1
echo "baseline writer-guard exit=$?"
( cd "$ROOT" && node --test test/concurrency/db-busy.test.mjs ) > "$OUT/baseline-db-busy.log" 2>&1
echo "baseline db-busy exit=$?"
( cd "$ROOT" && node --test test/concurrency/repository-boundary.test.mjs ) > "$OUT/baseline-repository-boundary.log" 2>&1
echo "baseline repository-boundary exit=$?"
( cd "$ROOT" && node "$EVID/r2-wire-busy.mjs" ) > "$OUT/baseline-r2-probe.log" 2>&1
echo "baseline r2-probe exit=$?"
( cd "$ROOT" && node "$EVID/r3-bare-repo.mjs" ) > "$OUT/baseline-r3-probe.log" 2>&1
echo "baseline r3-probe exit=$?"

# ---------------------------------------------------------------------------
# Mutation A — R1: drop the runtime pointer's owner check.
# ---------------------------------------------------------------------------
echo
echo "== mutation A: runtime pointer loses its pid ownership check (R1) =="
A="$(new_mutant)"
perl -0pi -e 's/\n *if \(options\.pid !== undefined && current\.pid !== undefined && current\.pid !== options\.pid\) return false;//' \
  "$A/src/core/storage/secrets/runtime-pointer.mjs"
echo "ownership check still present? $(grep -c 'current.pid !== options.pid' "$A/src/core/storage/secrets/runtime-pointer.mjs") (expect 0)"
( cd "$A" && node --test test/concurrency/writer-guard.test.mjs ) > "$OUT/mutationA-writer-guard.log" 2>&1
echo "mutated writer-guard exit=$?"
echo "--- newly failing vs baseline:"
comm -13 <(failures "$OUT/baseline-writer-guard.log") <(failures "$OUT/mutationA-writer-guard.log")

# ---------------------------------------------------------------------------
# Mutation B — R2: the attachment write goes back to a bare `.run()`.
# ---------------------------------------------------------------------------
echo
echo "== mutation B: attachment content write reverts to a bare .run() (R2) =="
B="$(new_mutant)"
perl -0pi -e 's/    transaction\(\n      db,\n.*?\n    \);/    writeFileSync(staged, body);\n    db.prepare("UPDATE attachments SET size=? WHERE id=?").run(body.length, id);\n    renameSync(staged, path);/s' \
  "$B/src/server/routes/attachments.mjs"
echo "bare UPDATE byte-identical to the pre-fix shape? $(grep -c 'UPDATE attachments SET size=? WHERE id=?' "$B/src/server/routes/attachments.mjs") (expect 1)"
echo "transaction still used by storeContent? $(grep -c 'attachments.setSize' "$B/src/server/routes/attachments.mjs") (expect 0)"
( cd "$B" && node "$EVID/r2-wire-busy.mjs" ) > "$OUT/mutationB-r2-probe.log" 2>&1
echo "mutated r2-probe exit=$?"
grep -h -m3 -E 'AssertionError|status|DB_BUSY|VALIDATION_FAILED' "$OUT/mutationB-r2-probe.log" | head -5

# ---------------------------------------------------------------------------
# Mutation C — R2: the bounded retry collapses to a single attempt.
# ---------------------------------------------------------------------------
echo
echo "== mutation C: retry budget becomes 1 attempt (R2) =="
C="$(new_mutant)"
perl -0pi -e 's/const attempts = Math\.max\(1, options\.attempts \?\? DB_BUSY_MAX_ATTEMPTS\);/const attempts = 1;/' \
  "$C/src/core/storage/unit-of-work.mjs"
echo "budget line now: $(grep -n 'const attempts' "$C/src/core/storage/unit-of-work.mjs" | head -1)"
( cd "$C" && node --test test/concurrency/db-busy.test.mjs ) > "$OUT/mutationC-db-busy.log" 2>&1
echo "mutated db-busy exit=$?"
echo "--- newly failing vs baseline:"
comm -13 <(failures "$OUT/baseline-db-busy.log") <(failures "$OUT/mutationC-db-busy.log")

# ---------------------------------------------------------------------------
# Mutation D — R3: a bare CAS call smuggled outside the command layer.
# ---------------------------------------------------------------------------
echo
echo "== mutation D: a bare claimCas call outside src/core/commands (R3) =="
D="$(new_mutant)"
cat > "$D/src/server/rogue-writer.mjs" <<'ROGUE'
/** A deliberate boundary violation, to prove the scan notices one. */
export function rogueClaim(repos, id, now) {
  return repos.tasks.claimCas({ id, actor: "rogue", now });
}
ROGUE
echo "rogue file planted: $(test -f "$D/src/server/rogue-writer.mjs" && echo yes)"
( cd "$D" && node --test test/concurrency/repository-boundary.test.mjs ) > "$OUT/mutationD-repository-boundary.log" 2>&1
echo "mutated repository-boundary exit=$?"
echo "--- newly failing vs baseline:"
comm -13 <(failures "$OUT/baseline-repository-boundary.log") <(failures "$OUT/mutationD-repository-boundary.log")
( cd "$D" && node "$EVID/r3-bare-repo.mjs" ) > "$OUT/mutationD-r3-probe.log" 2>&1
echo "mutated r3-probe exit=$?"
grep -h -m2 -E 'AssertionError|rogue-writer' "$OUT/mutationD-r3-probe.log" | head -3

echo
echo "scratch copies left for inspection:"
printf '  A(R1) %s\n  B(R2) %s\n  C(retry) %s\n  D(R3) %s\n' "$A" "$B" "$C" "$D"
