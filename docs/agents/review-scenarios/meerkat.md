# Scenario — Meerkat TaskPanel repository

**Applies to:** every card reviewed in this repository.

This is this project's scenario under `docs/agents/review-scenarios/`. It adds to the
reviewer's built-in floors; it never weakens them. A different project supplies its own
equivalent. New or changed scenario files are written through the installed `setup-meerkat`
skill's Step 4, never by a role or a card by hand.

## Checks

- **Contracts.** `node scripts/verify/contract.mjs` verifies the HTTP surface,
  `node scripts/verify/route-request.mjs` compares the declared request schema with what the
  handler reads, and `node scripts/verify/cli-contract.mjs` freezes the CLI. A new route, error
  code or wire field updates `test/fixtures/contract/api.snapshot.json`; an error code also
  touches `ERROR_CODES` and its bucket. `skills/meerkat/references/cli.md` names every frozen
  command and flag.
- **Data.** Migrations are append-only (`node scripts/verify/migrations.mjs`); a DB-first
  invariant is a trigger/CHECK mirrored by a domain check and tested under `test/contract/**`.
- **Design.** `design/BLOCKS.md` owns the `data-*` hooks (not classes or positions);
  `design/DESIGN.md` owns states, tokens, accessibility and themes; `data-theme-mode`, i18n
  parity and the `design/contracts/*` legs apply. The container build context drops `design/`,
  so those tests self-skip there; a skip is not a pass — find the host or CI run at the sha.
- **Security.** `node scripts/security/scan-gate.mjs --input <report.json> --waivers
  scripts/security/waivers.json` (no input exits 2); the thresholds live in
  `docs/tech-spec.md` § Security toolchain and the reviewer's `security-checklist.md`.
- **Evidence.** `git -C <targetDir> show <sha>:<path>`, `git diff <sha>^ <sha>` and
  `node --test` are the read-only lane. Say which actually ran: a host-static check is
  corroboration, not the pre-push container gate.
- **Coverage.** The floor is 80 % line/branch/function over `src/core`, `src/foundation`,
  `src/cli` and `src/server`; the number must come from a reproducible report.
- **Release.** `CHANGELOG.md` is written only on `release/vX.Y.Z`; a development-branch delivery
  leaves it untouched. The version carriers agree.
- A cited document absent from the tree at the delivered sha is a finding; cite the live records
  this project actually has (`docs/architecture.md`, never the phantom `ARCHITECTURE.md`).

## Blocks APPROVE

- A surface change with no contract-snapshot update, or an error code missing its bucket.
- An edited or deleted migration file.
- A design-derived test treated as green because it self-skipped in the container.
- A scan result recorded as run when only its report was read.
- A coverage or performance number with no reproducible source.
