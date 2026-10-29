# Technical specification — this repository's standard

The normative rules a change here must satisfy. It is a map, not a manual: each section names
the one artifact that owns a design area and records only the rules a reviewer could otherwise
have to invent. The system those rules describe is [`docs/architecture.md`](architecture.md).

A rule is one line. It is numbered so a card, a review or a commit can cite it, and it names the
**enforcement** that catches a violation — a test, a checker, a gate, or `review` when only a
person can catch it. A rule with no enforcement point is not a wish here: it is either removed or
recorded as `review` with its reason.

## Authority and change

| Rule | Statement | Enforcement |
|---|---|---|
| TS-01 | A rule changes through an ADR under [`docs/adr/`](adr/) plus the human's decision; never a silent edit. The change names the rule it replaces and why. | review |
| TS-02 | A published rule is not weakened quietly: a change that removes an enforcement point states what replaces it. | review |
| TS-03 | This file governs a code change. Wording, scope and acceptance belong to the card; the architecture direction belongs to an ADR or the human. | review |

The design principles behind these rules live in [`docs/architecture.md`](architecture.md) and in
`CLAUDE.md`; this file does not restate them.

## Tech stack

One bundle, inherited from [`docs/adr/0002-stack-bundle.md`](adr/0002-stack-bundle.md). **This
table is the stack's only record** — implementation cards inherit it and may not substitute a row
silently.

| Layer | Record |
|---|---|
| Frontend | Vue **3.5** + Vite **8**, Tailwind CSS **4** + daisyUI **5**, built only; no router or state library — a hand-rolled store (`web/src/stores/`) and a hand-rolled route (`web/src/lib/route.js`) |
| Backend | Node **>= 22** (`package.json` `engines`), ESM, **zero runtime dependencies**, npm; two processes — `taskd` (long-running) and `taskctl` (one shot, starts `taskd` on demand) |
| Persistence | SQLite through `node:sqlite`, no ORM and no migration tool; append-only SQL under `src/core/storage/migrations/`, applied at startup; data directory `.data/` (override `TASKD_DATA_DIR`), backup by copying the database file while the writer is stopped |
| Container / build | `node:22-bookworm-slim`, multi-stage (`webbuild` → runtime), non-root `node`, no network at build (offline `npm ci` from `web/.vendor/npm-cache`), compose at `docker/docker-compose.yml` with the healthcheck; **no image `HEALTHCHECK`** — the image's default command is the one-shot CLI, so a probe there would report red on a healthy tree; the service probe belongs to compose |
| Contracts | Code-first snapshots (`test/fixtures/contract/api.snapshot.json`, `cli.snapshot.json`); `/api/v1` path versioning; no OpenAPI document; environment surface inventoried in `.env.example` |

| Rule | Statement | Enforcement |
|---|---|---|
| TS-04 | Every Node base image in `docker/Dockerfile` satisfies the `engines` floor (22 today). | `test/docker.test.mjs` |
| TS-05 | A new runtime dependency, a new engine, or a version outside this table is a recorded decision (ADR + the human), not a substitution. | review |
| TS-06 | Lint, format check and type check are **not** in the stack: there is no compiler and no toolchain, so `n/a — zero-dependency ESM with no build step`. The static gate is `scripts/verify/*` plus `node --check`. Adding a toolchain is TS-05. | n/a — recorded here |
| TS-07 | There is no `migrate` script — migrations apply at startup, so the rehearsal is `npm run verify:migrations` (`n/a — no separate migrate step`). | `scripts/verify/migrations.mjs` |

## Structure and dependencies

| Rule | Statement | Enforcement |
|---|---|---|
| TS-08 | Dependency direction is `cli \| server -> core -> foundation`. Nothing under `foundation` imports a surface; `core` never imports `cli` or `server`. | `test/foundation/transport-imports.test.mjs` |
| TS-09 | `src/core/domain/**` imports **no Node builtin** and nothing outside `domain/` and `src/foundation/`. | `test/core/domain/purity.test.mjs` |
| TS-10 | `src/orchestrator/**` imports only `src/foundation/**` — the loop speaks to the board through `taskctl`, never through the HTTP API or a board module. | `test/orchestrator/imports.test.mjs` |
| TS-11 | A literal a second module needs is a named constant in `src/foundation/constants.mjs`; a value that differs per deployment is a configuration key, never a literal. | review |
| TS-12 | A closed enumeration has **one definition** — `src/core/domain/enums.mjs` (plus `priority.mjs`, `acceptance-mode.mjs`, `blocked-reason.mjs`) — carrying its wire form and unknown-value policy. The database constraint, the contract and the browser's label map are checked against it. The browser cannot import `src/`, so its copy is `web/src/lib/board-enums.js`. | `test/contract/sql-parity.test.mjs`, `test/web/enums.drift.test.mjs` |
| TS-13 | An unknown value arriving from outside is refused or mapped to a documented fallback — never accepted silently. | `src/core/domain/*` validators, `test/contract/**` |
| TS-14 | Module boundaries and the directory tree are [`docs/architecture.md`](architecture.md); a new top-level directory is a recorded decision. | review |
| TS-15 | Add a decision-bearing rule as a test in the directory that owns the behaviour (`test/contract/**` for invariants, `test/core/**`, `test/server/**`, `test/web/**`, `test/install/**`), not as a parallel file. For the browser/DOM layer, add a leg to `test/web/blocks.dom.test.mjs`. | review |

## Naming

| Rule | Statement | Enforcement |
|---|---|---|
| TS-16 | Files and modules are lower-kebab-case `.mjs` under `src/`; a test mirrors its subject's path under `test/`. A migration is `NNNN_lower_snake.sql`. | review |
| TS-17 | HTTP routes are `/api/v1/<plural-resource>`; the CLI groups are the nouns in `test/fixtures/contract/cli.snapshot.json`; CLI flags are `--lower-kebab`. | `scripts/verify/contract.mjs`, `scripts/verify/cli-contract.mjs` |
| TS-18 | An environment key carries one of the `CONFIG_NAMESPACES` prefixes (`TASKD_`, `TASKCTL_`, `MEERKAT_TASKPANEL_`); anything else in the config file is a typo and is refused. | `src/foundation/env-config.mjs`, `test/contract/config-keys.test.mjs` |
| TS-19 | Domain error codes are `SCREAMING_SNAKE` and stable; database objects are lower_snake. | `src/foundation/errors.mjs`, `test/contract/sql-parity.test.mjs` |

## Errors and contract

The canonical artifacts are [`docs/agents/contract.md`](agents/contract.md) and the two snapshots
under `test/fixtures/contract/`. There is no OpenAPI document, by decision.

| Rule | Statement | Enforcement |
|---|---|---|
| TS-20 | One serializer produces the envelope: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","http","details","hint"}}`. A bare array, a bare scalar or a second envelope is a contract bug. `/health`, `/meta` and the SSE stream are the recorded exceptions. | `src/server/router.mjs`, `test/server/**` |
| TS-21 | The application `code` is stable and independent of the HTTP status; a client switches on the code, never on the message. A new code touches `ERROR_CODES`, its bucket and the snapshot. | `scripts/verify/contract.mjs` |
| TS-22 | Every failure is a `DomainError` with a registered code — never a bare `Error` — and a validation failure carries the offending `field`. | review + `test/contract/**` |
| TS-23 | A route's **declared** request shape equals what its handler actually reads. The declaration is not a validator; domain validation is what refuses a bad body. This deviation from "one schema validator at the boundary" is recorded, and changing it is a contract change. | `scripts/verify/route-request.mjs` |
| TS-24 | A route, error code or wire-field change updates `api.snapshot.json`; a command, positional or flag change updates `cli.snapshot.json` and is named in `skills/meerkat/references/cli.md`. | `scripts/verify/contract.mjs`, `scripts/verify/cli-contract.mjs` |
| TS-25 | Pagination has two recorded shapes and no third: offset (`limit` / `offset`) for card lists, cursor (`after` = the activity revision) for activities, comments, sessions and the SSE stream. An invalid page or cursor is a validation error, not an empty list. | `test/server/**`, `docs/agents/contract.md` |

## Configuration

The canonical inventory is [`.env.example`](../.env.example) at the root; the prose topology is
[`docs/ops/install.md`](ops/install.md). Two files are written by an install — the shared
`<install root>/.env` and the per-kind `<program root>/.env.<actor-kind>` — and both are subsets of
the inventory.

| Rule | Statement | Enforcement |
|---|---|---|
| TS-26 | A key the application reads but the inventory omits is a defect; a key the inventory lists that nothing reads is dead configuration. | `test/contract/config-keys.test.mjs` |
| TS-27 | One loader (`src/foundation/env-config.mjs`) and one load order: flag → process environment → per-kind file → shared `.env` → built-in default. A module that reads the environment directly is a second source of truth. | review + `test/install/env-seed.test.mjs` |
| TS-28 | Startup validates the resolved values and fails loudly on an unknown or malformed key; no required key falls back silently. | `src/foundation/env-config.mjs`, `test/**` |
| TS-29 | Hot reload is a policy, not a side effect: only the SLA table and the access policy are re-read while the process runs; every other key is restart-required. There is no `LOG_FORMAT` key — the format is fixed logfmt. | review |
| TS-30 | The env file is gitignored; a token file is `0600`; a real secret never appears in `.env.example`, a log or a response. | `test/scaffold.test.mjs`, review |

## Logging

One logger, `src/foundation/log.mjs`; the operator's contract is
[`docs/ops/observability.md`](ops/observability.md).

| Rule | Statement | Enforcement |
|---|---|---|
| TS-31 | Application code gets a logger from the one factory and never writes to `console` directly. | review |
| TS-32 | A key flow emits one `info` line; a caught exception emits exactly one `error` line, at the boundary that decides its fate, carrying its code and correlation id. Nothing is logged twice for one incident. | `test/foundation/log.test.mjs` |
| TS-33 | Secrets and personal data are redacted at the logger boundary, not at each call site. | `src/foundation/redact.mjs`, `test/foundation/**` |

## Tests and gates

| Rule | Statement | Enforcement |
|---|---|---|
| TS-34 | The authoritative gate is `npm run verify:docker`, run by `.githooks/pre-push` on every branch push and by CI. The host-static loop is `npm run check`. A red gate blocks delivery — it is never a leftover. | `.githooks/pre-push`, `.github/workflows/check.yml` |
| TS-35 | Coverage floors are 80 % line, branch and function over `src/core/**`, `src/foundation/**`, `src/cli/**`, `src/server/**`. The numbers live once, in `package.json`'s `test:coverage` script. `web/` and `scripts/` are excluded by that decision, not by accident. | `npm run test:coverage` |
| TS-36 | Mocks sit only at an external boundary (HTTP, the database, a spawned process) — never at an internal module. | review |
| TS-37 | Migrations are append-only: never edit or delete a committed file, add a new number. | `scripts/verify/migrations.mjs` |
| TS-38 | A verification that only runs on the host is not the gate: `design/` is dropped from the image, so design-derived tests self-skip in the container and that skip is not a pass. | review + `docs/agents/docker.md` |

## Security toolchain

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

| Rule | Statement |
|---|---|
| TS-39 | **CVSS >= 7.0 blocks.** A High or Critical advisory needs a waiver or a fix. Scores come from the CVSS v3 vector (v3.0 and v3.1 share the formula); a numeric CVSS v2 score is taken as-is; a label-only advisory (`database_specific.severity` for osv-scanner, `severity` for `npm audit`) is banded from that label. |
| TS-40 | **A committed secret is never waivable.** gitleaks findings are `critical`; the parser drops the secret itself, so the report names the rule and the location. Rotate the credential and purge it from the history. |
| TS-41 | **Waivers expire, and they are capped.** At most **90 days**, or **30 days** for a Critical advisory; the expiry date is inclusive. An id matches the advisory's id or any alias, case-insensitively. The `reason` is at least 8 characters. An expired, malformed, future-dated or over-cap waiver is refused loudly — the advisory blocks again and the summary shows the refusal. The ledger is [`scripts/security/waivers.json`](../scripts/security/waivers.json); its `_note` restates these rules. |
| TS-42 | **An alert is not a failure.** Scanner steps run `continue-on-error`; the gate exits 0 with findings on it. Set `SCAN_STRICT=1` (repository variable, or dispatch `strict: true`) and the same run exits non-zero on an unwaived block. |
| TS-43 | **A scan that did not happen is not a pass.** If no report could be read at all, the gate exits 2 even in alert-only mode. A report missing alongside a readable one is a warning. |

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
  analysis; their template and `<script setup>` logic is reviewed by hand. This is the
  recorded `n/a — no extractor` for those files.
- Action `uses:` lines are pinned by full commit SHA (Dependabot keeps them fresh); the
  gitleaks image is pinned by version tag until a digest is recorded.

## Release and delivery

Release **publishes** a version; deploy **runs** it. The shape is
[`docs/ops/publishing.md`](ops/publishing.md); the compose path is the only deploy this
repository ships.

| Rule | Statement | Enforcement |
|---|---|---|
| TS-44 | The release builds the artifact once and publishes the bytes that passed CI. A published version is immutable: a defect is fixed forward under a new version, never by republishing. | `.github/workflows/release.yml` |
| TS-45 | A tag is cut only from `main`, only when the four version carriers and the CHANGELOG section agree. | `scripts/verify/version.mjs`, `scripts/verify/tag-version.mjs`, `scripts/verify/changelog.mjs` |
| TS-46 | `CHANGELOG.md` is written only on the release branch, at the `dev` → `main` merge; `[Unreleased]` stays empty between releases. | `.githooks/pre-push`, review |
| TS-47 | The deploy path promotes the release tag (or the mainline) and has a healthcheck against the real entry point — `src/server/main.mjs`. A liveness-only placeholder is `not a gate`. | `docker/docker-compose.yml`, `test/docker.test.mjs` |
| TS-48 | Rollback names its trigger, its decider and the previous artifact. A rollback of the artifact is not a rollback of the data: a release that changes stored data records its own recovery step. | review |

## Project documents

| Document | Owns | Gate |
|---|---|---|
| [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) | what the project is, install, roadmap | `test/scaffold.test.mjs` |
| [`GLOSSARY.md`](../GLOSSARY.md) | the canonical vocabulary | review |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | how a change lands: isolation, the gate, the PR flow, cleanup | `test/scaffold.test.mjs` |
| [`CHANGELOG.md`](../CHANGELOG.md) | the release record | `scripts/verify/changelog.mjs` |
| [`docs/architecture.md`](architecture.md) | the system design and the directory tree | `test/scaffold.test.mjs` |
| [`docs/adr/`](adr/) | durable decisions | `test/scaffold.test.mjs` |
| [`docs/README.md`](README.md) | the index: which document owns which area | review |

The project is a **community open-source project** (MIT, published on npm, a private-advisory
disclosure path), so the community group is real files, not an `n/a`:

| Document | Owns |
|---|---|
| [`SECURITY.md`](../SECURITY.md) | the vulnerability-disclosure path and supported versions |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | the contribution conduct and how to report a problem |
| [`LICENSE`](../LICENSE) | MIT, © the maintainer |
| [`.github/CODEOWNERS`](../.github/CODEOWNERS) | the ownership map |
| [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) and [`PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) | the report and contribution forms |

| Rule | Statement | Enforcement |
|---|---|---|
| TS-49 | Each document has one owner and one canonical location; a rule that appears twice is a pointer, not a copy. | review |
| TS-50 | The core set and the community group exist as files, not as an `n/a`. | `test/scaffold.test.mjs` |
| TS-51 | The glossary carries a `## Product language` pointer and does not copy the product's terms. | `test/scaffold.test.mjs` |
