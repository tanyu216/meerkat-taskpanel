# Git hooks

Local, **offline** gates for the release/version surface. They are plain POSIX
`sh` scripts and a thin wrapper over the reusable checkers, so the hook and
CI run the *same code*:

| Hook | Enforces | Checker |
|---|---|---|
| `pre-commit` | SQL migrations are append-only: contiguous from `0001`, unique, an already-committed file neither edited nor deleted | `scripts/verify/migrations.mjs` |
| `pre-push` | the API contract matches the committed snapshot (routes + error codes + wire field names **and types**, and each route's declared request schema); every route's declared request schema equals what its handler reads; no tracked file carries a host-absolute path; no tracked file carries a signpost out of the repository; every pushed `refs/tags/vX.Y.Z` has a `## [X.Y.Z]` section in `CHANGELOG.md`; and `main` is not pushed to directly | `scripts/verify/contract.mjs`, `scripts/verify/route-request.mjs`, `scripts/verify/paths.mjs`, `scripts/verify/signposts.mjs`, `scripts/verify/changelog.mjs` |
| `pre-tag` | the same API + tag rules as `pre-push` (no `main` rule — a tag is not a branch push), run by hand *before* `git tag` | `scripts/verify/contract.mjs`, `scripts/verify/route-request.mjs`, `scripts/verify/changelog.mjs` |

The four static gates run on **every** push, not only a tag. The two API gates:
the API ships in every commit, and a route or error-code change must be
accompanied by an explicit snapshot update (`node scripts/verify/contract.mjs
--update`); the request lint is the pairing half — it proves the declaration the
snapshot freezes is the one the handler honours (see
[`../docs/contract.md`](../docs/contract.md)). The two tree gates: a
host-absolute path is a statement about one machine, and a walkable reference
into an external framework's private store is an instruction to leave this
repository, which a session reading the tree will follow (see
[`../design/contracts/naming-boundary.md`](../design/contracts/naming-boundary.md)
and the header of each checker). Both are also enforced in CI — by
`paths-gate.yml` and `signposts-gate.yml`.

## `main` is not pushed to directly

`main` advances through a pull request, and `pre-push` refuses a direct push to
`refs/heads/main` (a deletion included) before anything leaves the machine:

```sh
ALLOW_PUSH_MAIN=1 git push origin main   # deliberate release push
```

The **real** enforcement is GitHub's branch-protection rule on `main`
([`../docs/publishing.md`](../docs/publishing.md) §3.3) — a hook is a courtesy and
`git push --no-verify` bypasses it, along with everything else here. This one
exists so that a mistaken `git push origin main` is a local error message rather
than a rejected round trip. `ALLOW_PUSH_MAIN=1` is the narrow escape hatch for a
maintainer's deliberate release push; it silences *only* this rule, and the two
API gates still run.

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
