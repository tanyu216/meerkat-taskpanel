# Security tools — the free defaults, and how to check them

The team's security scan is three arms: **dependency audit**, **secret scan** and
**SAST**. Every default below is free to use. This page is the explanation; the
machine-readable twin is `assets/security/toolchain.json`, which
`scripts/security-tools.mjs` reads.

The check never installs and never reaches the network. `--install` and `--upgrade` are
explicit, name the tools they act on, and print the command when this host has no
supported package manager.

## The matrix

| Tool | Official source | License | Free tier | Version floor | Install | CI wiring | Offline |
|---|---|---|---|---|---|---|---|
| `osv-scanner` | https://github.com/google/osv-scanner | Apache-2.0 | free, no account | 2.0.0 (recommended 2.7.0) | `brew install osv-scanner`; `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.7.0`; the release binaries | GitHub Action or direct CLI | `--offline` with a downloaded database |
| `gitleaks` | https://github.com/gitleaks/gitleaks | MIT (CLI) | free; the *action* needs a free license key on organization accounts, so run the CLI | 8.18.0 (recommended 8.30.1) | `brew install gitleaks`; `go install github.com/gitleaks/gitleaks/v8@v8.30.1`; image `ghcr.io/gitleaks/gitleaks:v8.30.1` | CLI in CI | offline after install |
| `semgrep` | https://github.com/semgrep/semgrep | LGPL-2.1 engine; rules under the Semgrep Rules License (free, not OSI) | free CE, local, no account | 1.100.0 (recommended 1.182.0) | `brew install semgrep`; `pipx install semgrep==1.182.0`; image `semgrep/semgrep` | `semgrep scan --config <dir> --sarif --metrics=off` | offline when the rules are vendored |
| `codeql` | https://github.com/github/codeql-action · https://github.com/github/codeql | MIT action; the CLI runs under GitHub's CodeQL Terms | free on **public** GitHub repositories; private needs GitHub Advanced Security | action v3 | the action in CI; locally `gh extension install github/gh-codeql` | GitHub Actions, `security-events: write` | needs GitHub-hosted runners |
| `trivy` | https://github.com/aquasecurity/trivy | Apache-2.0 | free | 0.50.0 (recommended 0.76.1) | `brew install trivy` | one-tool alternative for the dependency and secret arms | `--skip-db-update` with a local database |
| `syft` | https://github.com/anchore/syft | Apache-2.0 | free | 1.0.0 (recommended 1.55.0) | `brew install syft` | SBOM generation | works from the local tree |

Rejected candidates, so the next reader does not re-open them: TruffleHog (AGPL-3.0),
`gitleaks-action` (a license key is required for organizations), `semgrep-action`
(archived), OWASP Dependency-Check (JVM plus an NVD download; slow).

## Which tool an arm gets

| Arm | Default | Substitute |
|---|---|---|
| Dependency audit | `osv-scanner` | `trivy`, or `npm audit --audit-level=high` when the only input is a JS lockfile |
| Secret scan | `gitleaks` | `trivy --scanners secret` |
| SAST | `codeql` on a public GitHub repository | `semgrep` on any other host, or when the scan must run offline |
| SBOM | `syft` | optional; it is inventory, not a verdict |

A secret is **not** waivable the way an advisory is: rotate the credential, purge it from
the history, then record what happened. A waiver ledger covers CVEs, not leaked keys.

## The Vue gap

Neither default SAST tool extracts `.vue` single-file components (Semgrep's language table
has no Vue; CodeQL's JavaScript/TypeScript extractor reads `.js`/`.jsx`/`.ts`/`.tsx`). The
project records those files `n/a — no extractor` and the reviewer's
`security-checklist.md` covers their `<template>` and `<script setup>` logic by hand:
`v-html`, dynamic bindings, template expressions and exposed props.

## Standards are not tools

OWASP Top 10 (https://owasp.org/Top10/2025/ — the 2025 edition; official documents at
https://github.com/OWASP/Top10), OWASP ASVS
(https://owasp.org/www-project-application-security-verification-standard/) and CWE Top 25
(https://cwe.mitre.org/top25/) are review vocabularies. A scanner feeds them — its findings
carry a rule id or a CWE id — but nothing here installs them, and a green scan is not
coverage of them. The reviewer walks the checklist.

## Checking and installing

```bash
# Detect only: PATH, version against the floor, the command that would fix it.
node <skill-dir>/scripts/security-tools.mjs --check --json --project <dir>

# Show the commands for whatever is missing or behind.
node <skill-dir>/scripts/security-tools.mjs --print --project <dir>

# Act — only on request, only on the named tools.
node <skill-dir>/scripts/security-tools.mjs --install --tool gitleaks --project <dir>
node <skill-dir>/scripts/security-tools.mjs --upgrade --json --project <dir>
```

Exit codes: `0` the check ran (or the requested actions succeeded), `1` a required tool is
missing, behind, or its version could not be read, `2` usage, `3` an action was requested
and this host has no supported package manager. The host (`github` or `other`) comes from
`<dir>/.git/config`; `--host` overrides it.

`codeql` is reported as `ci` on purpose: on a public GitHub repository the analysis runs in
the workflow, not on the developer's machine.
