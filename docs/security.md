# Security scanning

How the project watches its own supply chain and its own code: what is scanned, what
blocks, how an advisory is waived, and why an alert does not turn into a red build unless
someone asks for it.

The engine has **zero runtime dependencies** — `src/core`, `src/cli` and `src/server`
import Node builtins and nothing else. So the supply chain that matters here is
the **build chain**: the `web/` board frontend's build-time devDependencies, pinned by the
one committed lockfile, `web/package-lock.json`. That is what the dependency arm looks at,
and it is why it stays useful even though the shippable artefact has no dependencies at
all.

The scan has three arms plus an inventory: **dependency audit**, **secret scan** and
**SAST**, with the SBOM as the inventory every other answer is checked against. The
reviewer's manual checklist covers what no scanner can answer — see
`skills/setup-meerkat/assets/team/standard/reviewer/security-checklist.md`.

## The arms, and the one verdict

| Arm | Tool | Produces | Reads |
|---|---|---|---|
| Dependency audit | [`osv-scanner`](https://github.com/google/osv-scanner) | `osv-results.json` | every lockfile and SBOM in the tree (`--recursive`), or just the changed ones on the incremental run |
| Dependency audit | `npm audit --audit-level=high` | `npm-audit.json` | `web/package-lock.json` — npm's own advisory database, the view a `npm install` would complain with |
| Secret scan | [`gitleaks`](https://github.com/gitleaks/gitleaks) | `gitleaks-report.json` | the working tree **and the full history**; a secret deleted from HEAD is still leaked |
| SAST | [CodeQL](https://github.com/github/codeql-action) | code-scanning alerts | the JavaScript/TypeScript source, via `security-events` upload; `.vue` single-file components are **not** extracted |
| Inventory | [`syft`](https://github.com/anchore/syft) | `sbom.spdx.json` | the whole tree; the SBOM is the inventory every other answer is checked against |

[Semgrep CE](https://github.com/semgrep/semgrep) is the documented substitute for CodeQL
on a host other than GitHub, or when the analysis must run offline
(`semgrep scan --config <vendored rules> --sarif --metrics=off`). The action and the
scanner versions are pinned: `uses:` lines by full commit SHA (Dependabot keeps them
fresh), the gitleaks image by its version tag until a digest is recorded.

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
- **A committed secret is never waivable.** gitleaks findings are `critical` and the waiver
  ledger does not cover them: rotate the credential, purge it from the history, then record
  what happened. The parser drops the secret itself, so the report and the run summary name
  the rule and the location, never the credential.
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

# A secret report — the format is forced because an empty array is shapeless:
node scripts/security/scan-gate.mjs --input gitleaks-report.json --format gitleaks

# Evaluate waivers at a date other than today (UTC):
node scripts/security/scan-gate.mjs --input osv-results.json --now 2026-12-01
```

`--format auto|osv|npm|gitleaks` forces the parser when a report is ambiguous,
`--block-unknown` also blocks advisories whose severity could not be read, and `--help`
lists the rest.

The scanners themselves are **not** in the verify image — everything that runs is
containerised and offline, and a scanner would need network for its advisory database. The
reproducible local commands are the tools' own containers or binaries:

```bash
# Secret scan (tree and history):
gitleaks git --redact --report-format json --report-path gitleaks-report.json .

# SAST on a host other than GitHub, with vendored rules:
semgrep scan --config ./security-rules --sarif --metrics=off

# CodeQL locally, when the repository lives on GitHub:
gh extension install github/gh-codeql
```

The reviewer runs the project's declared gate, or reads the CI run for the delivered sha
and records it as read; a read report is corroboration, never a command anchor.

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

`syft` produces `sbom.spdx.json` in the `sbom` job of the security workflow on a `v*` tag
push, a scheduled run and a dispatch — not on a pull request, where the artefact would
describe a tree that is not a release. The `sbom` *job* still runs on every trigger so the
`security-success` aggregate always reports; only the generation step is skipped. The file
is uploaded as a workflow artifact, and on a tag push it is also attached to the release
draft, but only if that release already exists (the release pipeline creates it; this
workflow never blocks on it).

The dependency *scan* is the part that runs per pull request, and even there it is skipped
when no dependency input changed: the only lockfile is `web/package-lock.json`, and the
target gate still reports over an empty report rather than going missing.

The secret scan has no skip path — any diff can add a credential — and the SAST job always
runs so the `security-success` aggregate never sees a skipped job. A secret finding is
alert-only unless `SCAN_STRICT=1`, exactly like an advisory, except that it can never be
waivered.

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
- **CodeQL runs only on a public GitHub repository.** A private mirror needs GitHub Advanced
  Security, and a fork pull request has no `security-events` upload permission — the
  analysis steps skip with a notice while the job still reports. Do not enable GitHub's
  CodeQL *default setup* alongside this workflow; two configurations overwrite each other.
- **`.vue` single-file components are not extracted** by CodeQL's JavaScript/TypeScript
  extractor, and Semgrep does not support Vue either. Their template and `<script setup>`
  logic is covered by the reviewer's manual checklist, recorded as `n/a — no extractor`.
- **The scan tools are pinned.** Action `uses:` lines by full commit SHA (Dependabot keeps
  them fresh); the gitleaks image by its version tag until a digest is recorded. Bumping
  any of them is a deliberate change, like any other dependency.
