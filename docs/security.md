# Dependency security

How the project watches its own supply chain: what is scanned, what blocks, how an
advisory is waived, and why an alert does not turn into a red build unless someone asks
for it.

The engine has **zero runtime dependencies** — `src/core`, `src/cli`, `src/server` and
`src/mcp` import Node builtins and nothing else. So the supply chain that matters here is
the **build chain**: the `web/` board frontend's build-time devDependencies, pinned by the
one committed lockfile, `web/package-lock.json`. That is what these scans look at, and it
is why they stay useful even though the shippable artefact has no dependencies at all.

## The three sources, and the one verdict

| Source | Produces | Reads |
|---|---|---|
| [`osv-scanner`](https://github.com/google/osv-scanner) | `osv-results.json` | every lockfile and SBOM in the tree (`--recursive`), or just the changed ones on the incremental run |
| `npm audit --audit-level=high` | `npm-audit.json` | `web/package-lock.json` — npm's own advisory database, the view a `npm install` would complain with |
| [`syft`](https://github.com/anchore/syft) | `sbom.spdx.json` | the whole tree; the SBOM is the inventory every other answer is checked against |

Those are evidence. The decision is [`scripts/security/scan-gate.mjs`](../scripts/security/scan-gate.mjs),
a zero-dependency script that reads the reports, normalises them into one finding shape and
applies the policy below. It is pure and clock-injected, so the whole rule set — scores,
waiver windows, strict behaviour — is covered by `node --test` with no network and no
scanner installed.

## The policy

- **CVSS >= 7.0 blocks.** A finding at High or Critical severity is a *block*: it needs a
  waiver, or it needs fixing. Scores are computed from the CVSS v3 vector (v3.0 and v3.1
  share the formula) with the vector's own round-up rule; a plain numeric score
  (CVSS v2) is taken as-is; an advisory that carries only a severity label
  (`database_specific.severity` for osv-scanner, `severity` for `npm audit`) is banded from
  that label.
- **Waivers expire, and they are capped.** A waiver may be granted for at most **90 days**
  — or **30 days** when the advisory is **Critical**. The expiry date itself is covered;
  the next day the advisory blocks again. The cap is what stops "waived" from quietly
  becoming "permanently ignored".
- **An alert is not a failure.** The scanners run `continue-on-error`, and the gate exits 0
  with findings on it. Set `SCAN_STRICT=1` (repository variable `SCAN_STRICT=1`, or dispatch
  with `strict: true`) and the same run exits non-zero on an unwaived block.
- **A scan that did not happen is not a pass.** If *no* report could be read at all, the
  gate exits 2 even in the default alert-only mode — there is no evidence to gate on, and
  reporting "clean" would be the wrong answer. A report that is merely missing *alongside*
  a readable one is a warning, not a failure.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | The gate ran. Nothing unwaived is blocking — findings may still be listed. |
| 1 | Strict mode, and at least one unwaived High/Critical advisory. |
| 2 | Usage error, or no scanner report could be read at all. |

## Running it

The gate is offline and dependency-free, so it runs anywhere Node >= 22 does:

```bash
# Only the gate, against reports you already have:
node scripts/security/scan-gate.mjs \
  --input osv-results.json \
  --input npm-audit.json \
  --waivers scripts/security/waivers.json

# Same, but fail on a block:
SCAN_STRICT=1 node scripts/security/scan-gate.mjs --input osv-results.json

# Machine-readable, and for the CI summary:
node scripts/security/scan-gate.mjs --input osv-results.json --json
node scripts/security/scan-gate.mjs --input osv-results.json --summary "$GITHUB_STEP_SUMMARY"

# Evaluate waivers at a date other than today (UTC):
node scripts/security/scan-gate.mjs --input osv-results.json --now 2026-12-01
```

`--format auto|osv|npm` forces the parser when a report is ambiguous, `--block-unknown`
also blocks advisories whose severity could not be read, and `--help` lists the rest.

## Waivers

`scripts/security/waivers.json` is the ledger. It ships empty, and it is deliberately not a
folder of ignore-rules: every entry has to say why, and has to expire.

```json
{
  "waivers": [
    {
      "id": "GHSA-xxxx-yyyy-zzzz",
      "package": "left-pad",
      "reason": "only reachable from the dev server; tracked in #123",
      "granted": "2026-10-01",
      "expires": "2026-10-30"
    }
  ]
}
```

- `id` matches the advisory's id **or any of its aliases**, case-insensitively — so a waiver
  may be written with the `CVE-` id or the `GHSA-` id, whichever the reviewer had to hand.
- `package` is optional. Omit it to cover the advisory in every package.
- `reason` must be at least 8 characters. A waiver without a reason is not a waiver.
- `granted` / `expires` are `YYYY-MM-DD`.

A waiver that is expired, malformed, dated in the future, or granted for longer than the
cap for the severity it covers is **refused, loudly**: the advisory blocks again and the
summary shows the refusal next to it. A broken entry is never silently dropped, because a
waiver that quietly disappears is worse than one that visibly fails — the first hides the
re-blocked advisory, the second points at it.

## The SBOM

`syft` produces `sbom.spdx.json` in the `sbom` job of the security workflow, on **every**
trigger — push, pull request, the schedule, and a `v*` tag push. It is uploaded as a
workflow artifact, and on a tag push it is also attached to the release draft, but only if
that release already exists (the release pipeline creates it; this workflow never blocks on
it).

This is a deliberate departure from "hook the SBOM into the release pipeline": the release
and check workflows are owned by other changes in flight and are not modified here, so this
workflow produces its own artefact instead. The SBOM is therefore always available for the
tree as it was scanned, whether or not a release is being cut.

## What this does not cover

Named rather than hidden:

- **CVSS v4 vectors are not scored.** A v4 base score needs the v4 macro-vector tables; an
  advisory that offers only a v4 vector falls back to its severity label, and an advisory
  with neither is reported as `unknown` — listed, never silently dropped, and only blocking
  under `--block-unknown`.
- **Temporal and environmental metrics are ignored.** The gate blocks on the base score.
- **`web/` is the only lockfile.** npm audit runs against `web/package-lock.json`; if a
  second lockfile ever lands in the tree, its audit step belongs here too.
- **No dependency installation happens in CI.** The scans read lockfiles and the tree, so
  the workflow stays consistent with the project's no-install rule.
- **The scanners are pinned by tag** (`google/osv-scanner-action`, `anchore/sbom-action`).
  Bumping them is a deliberate change, like any other dependency.
