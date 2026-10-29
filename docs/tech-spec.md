# Technical specification — this repository's standard

The normative rules a change here must satisfy. It is a map, not a manual: each section
names the canonical artifact and points at it; the only thing written out in full is the
security toolchain and its decision policy, which has no other home.

Authority: this file governs a code change; wording, scope and acceptance are the card's;
architecture direction is an ADR or the human's decision. The review gate that enforces
these rules runs in CI — see [Security toolchain](#security-toolchain-and-decision-policy)
and [docs/agents/development.md](agents/development.md).

| Section | Canonical artifact |
|---|---|
| Tech stack | `package.json` (engines, scripts), `web/package.json`, `docker/Dockerfile` |
| Structure and dependencies | [CLAUDE.md](../CLAUDE.md) — layout, the one-way import rule, the loop's boundary |
| Naming | [CONTRIBUTING.md](../CONTRIBUTING.md) and [CLAUDE.md](../CLAUDE.md) |
| Errors and contract | [docs/agents/contract.md](agents/contract.md) |
| Configuration | [docs/ops/install.md](ops/install.md) |
| Logging and observability | [docs/ops/observability.md](ops/observability.md) |
| Tests and gates | [CLAUDE.md](../CLAUDE.md) (commands), `package.json` scripts, [docs/agents/docker.md](agents/docker.md) (verification runs in the container) |
| Server operations | [docs/agents/development.md](agents/development.md) — the two build layers, one writer per data directory, the bounded stop, lock contention |
| Security toolchain and decision policy | this file, below |
| Release and delivery | [docs/ops/publishing.md](ops/publishing.md) |

## Security toolchain and decision policy

The scan has three arms plus an inventory, and one verdict. The verdict is
[`scripts/security/scan-gate.mjs`](../scripts/security/scan-gate.mjs); the CI wiring is
[`.github/workflows/security-scan.yml`](../.github/workflows/security-scan.yml).

| Arm | Tool | Report | CI job |
|---|---|---|---|
| Dependency audit | [`osv-scanner`](https://github.com/google/osv-scanner) | `osv-results.json` | `Dependency scan (osv-scanner + npm audit)` |
| Dependency audit | `npm audit --audit-level=high` | `npm-audit.json` | same job |
| Secret scan | [`gitleaks`](https://github.com/gitleaks/gitleaks) | `gitleaks-report.json` | `Secret scan (gitleaks)` |
| SAST | [CodeQL](https://github.com/github/codeql-action) | code-scanning alerts | `SAST (CodeQL)` |
| Inventory | [`syft`](https://github.com/anchore/syft) | `sbom.spdx.json` | `SBOM (syft)` |

`security-success` aggregates the four jobs into the one required status check. A job that
is renamed, removed or silently skipped fails the aggregate rather than leaving branch
protection waiting.

**The policy**

- **CVSS >= 7.0 blocks.** A High or Critical advisory needs a waiver or a fix. Scores come
  from the CVSS v3 vector (v3.0 and v3.1 share the formula); a numeric CVSS v2 score is
  taken as-is; a label-only advisory (`database_specific.severity` for osv-scanner,
  `severity` for `npm audit`) is banded from that label.
- **A committed secret is never waivable.** gitleaks findings are `critical`; the parser
  drops the secret itself, so the report names the rule and the location. Rotate the
  credential and purge it from the history.
- **Waivers expire, and they are capped.** At most **90 days**, or **30 days** for a
  Critical advisory; the expiry date is inclusive. An id matches the advisory's id or any
  alias, case-insensitively. The `reason` is at least 8 characters. An expired, malformed,
  future-dated or over-cap waiver is refused loudly — the advisory blocks again and the
  summary shows the refusal. The ledger is
  [`scripts/security/waivers.json`](../scripts/security/waivers.json); its `_note` restates
  these rules.
- **An alert is not a failure.** Scanner steps run `continue-on-error`; the gate exits 0
  with findings on it. Set `SCAN_STRICT=1` (repository variable, or dispatch
  `strict: true`) and the same run exits non-zero on an unwaived block.
- **A scan that did not happen is not a pass.** If no report could be read at all, the gate
  exits 2 even in alert-only mode. A report missing alongside a readable one is a warning.

| Exit | Meaning |
|---|---|
| 0 | The gate ran; nothing unwaived is blocking (findings may still be listed). |
| 1 | Strict mode, and at least one unwaived High/Critical advisory or committed secret. |
| 2 | Usage error, or no scanner report could be read at all. |

**Running it**

```bash
node scripts/security/scan-gate.mjs \
  --input osv-results.json --input npm-audit.json \
  --waivers scripts/security/waivers.json

node scripts/security/scan-gate.mjs --input gitleaks-report.json --format gitleaks
SCAN_STRICT=1 node scripts/security/scan-gate.mjs --input osv-results.json
```

`--format auto|osv|npm|gitleaks` forces the parser; `--block-unknown` also blocks an
advisory whose severity cannot be read; `--summary <file>` writes the run summary.

The scanners themselves are **not** in the verify image (it is offline and installs
nothing). The reviewer runs the project's declared gate, or reads the CI run for the
delivered sha and records it as read.

**The SBOM**

`syft` writes `sbom.spdx.json` on a `v*` tag push, a schedule and a dispatch — not on a
pull request, where the artifact would describe a tree that is not a release. The job
always runs so the aggregate always reports; on a tag push the file is attached to an
existing release draft, best effort.

**What this does not cover**

- CVSS v4 vectors are unscored (a v4-only advisory falls back to its label, or `unknown`
  and only blocks under `--block-unknown`); temporal and environmental metrics are ignored.
- `web/` is the only lockfile; a second one would need its own audit step.
- CI never installs dependencies: the scans read lockfiles and the tree.
- CodeQL is free on public GitHub repositories; a private mirror needs GitHub Advanced
  Security, and a fork pull request cannot upload code-scanning results (the analysis steps
  skip with a notice while the job reports). The job needs `security-events: write`.
  GitHub's CodeQL default setup must stay off while this workflow exists.
- `.vue` single-file components have no extractor in CodeQL's JavaScript/TypeScript
  analysis; their template and `<script setup>` logic is reviewed by hand.
- Action `uses:` lines are pinned by full commit SHA (Dependabot keeps them fresh); the
  gitleaks image is pinned by version tag until a digest is recorded.
