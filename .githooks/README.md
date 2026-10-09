# Git hooks

Local, **offline** gates for the release/version surface. They are plain POSIX
`sh` scripts and a thin wrapper over the two reusable checkers, so the hook and
CI run the *same code*:

| Hook | Enforces | Checker |
|---|---|---|
| `pre-commit` | SQL migrations are append-only: contiguous from `0001`, unique, an already-committed file neither edited nor deleted | `scripts/verify/migrations.mjs` |
| `pre-push` | the API contract matches the committed snapshot (routes + error codes + wire fields); and every pushed `refs/tags/vX.Y.Z` has a `## [X.Y.Z]` section in `CHANGELOG.md` | `scripts/verify/contract.mjs`, `scripts/verify/changelog.mjs` |
| `pre-tag` | the same two rules as `pre-push`, run by hand *before* `git tag` | `scripts/verify/contract.mjs`, `scripts/verify/changelog.mjs` |

The contract gate runs on **every** push, not only a tag: the API ships in every
commit, and a route or error-code change must be accompanied by an explicit
snapshot update (`node scripts/verify/contract.mjs --update`). See
[`../docs/contract.md`](../docs/contract.md).

## Install

`npm install` wires this directory up via the root `package.json` `prepare`
script (`git config core.hooksPath .githooks`). To do it manually:

```sh
git config core.hooksPath .githooks
```

No `husky` dependency: the project is zero-runtime-dependency and works offline,
and git's own `core.hooksPath` is enough. Nothing here touches the network.

## Why a `pre-tag` script and not a `pre-tag` hook

Git has no native `pre-tag` hook — a tag is a ref, not a commit, and ref updates
are not hooked the way commits are. The rule is therefore enforced at the
earliest points git *does* offer:

1. `.githooks/pre-tag vX.Y.Z` — run it yourself before tagging (documented in
   [`../docs/publishing.md`](../docs/publishing.md));
2. `.githooks/pre-push` — refuses a version tag on its way out;
3. `.github/workflows/version-gate.yml` — the authoritative check on tag push.

`.github/workflows/check.yml` is deliberately left untouched; the migration check
and the changelog gate live in `scripts/verify/` and run here and in
`version-gate.yml`.
