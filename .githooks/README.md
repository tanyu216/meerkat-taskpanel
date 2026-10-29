# Git hooks

Local gates: static checks for the release/version surface, then the container
suite. They are plain POSIX `sh` scripts and a thin wrapper over the reusable
checkers, so the hook and CI run the *same code*:

| Hook | Enforces | Checker |
|---|---|---|
| `pre-commit` | SQL migrations are append-only: contiguous from `0001`, unique, an already-committed file neither edited nor deleted | `scripts/verify/migrations.mjs` |
| `pre-push` | the API contract matches the committed snapshot (routes + error codes + wire field names **and types**, and each route's declared request schema); every route's declared request schema equals what its handler reads; no tracked file carries a host-absolute path; no tracked file carries a signpost out of the repository; the four version carriers agree; every pushed `refs/tags/vX.Y.Z` names that version, is on `main`, and has a **filled** `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`; `main` is not pushed to directly; **and the container suite passes on a branch push** | `scripts/verify/contract.mjs`, `scripts/verify/route-request.mjs`, `scripts/verify/paths.mjs`, `scripts/verify/signposts.mjs`, `scripts/verify/version.mjs`, `scripts/verify/tag-version.mjs`, `scripts/verify/changelog.mjs --strict`, `npm run verify:docker` |
| `pre-tag` | the same API + tag rules as `pre-push` (no `main` rule — a tag is not a branch push), run by hand *before* `git tag`: contract, route-request, version carriers, tag ↔ version, and the strict changelog section | `scripts/verify/contract.mjs`, `scripts/verify/route-request.mjs`, `scripts/verify/version.mjs`, `scripts/verify/tag-version.mjs`, `scripts/verify/changelog.mjs --strict` |

Writing timing is a workflow rule, not a hook: the changelog section is authored on the
release branch (`release/vX.Y.Z`, the PR `release-prep` opens), never on `dev`; the hook
checks that a tag's section is **filled** — a real date, at least one entry, no
`_Nothing yet._` scaffold — not merely present.

The four static gates run on **every** push, not only a tag. The two API gates:
the API ships in every commit, and a route or error-code change must be
accompanied by an explicit snapshot update (`node scripts/verify/contract.mjs
--update`); the request lint is the pairing half — it proves the declaration the
snapshot freezes is the one the handler honours (see
[`../docs/agents/contract.md`](../docs/agents/contract.md)). The two tree gates: a
host-absolute path is a statement about one machine, and a walkable reference
into an external framework's private store is an instruction to leave this
repository, which a session reading the tree will follow (see
[`../design/contracts/naming-boundary.md`](../design/contracts/naming-boundary.md)
and the header of each checker). Both are also enforced in CI — by the `paths`
and `signposts` jobs in `check.yml`.

## The container gate runs at `pre-push`

The authoritative suite is `npm run verify:docker` — it builds the image and runs
everything that *runs* ([`../docs/agents/docker.md`](../docs/agents/docker.md)). It is the last
gate in `pre-push`, after the static ones:

- it runs only when a **branch commit** is moving. A tag-only push and a branch
  deletion change no tree, so they skip it — the commit behind a release tag was
  already gated when its branch was pushed;
- it runs only after the static gates are green, so a cheap failure does not
  start a multi-minute image build;
- the image bakes the **working tree** at build start, so commit before pushing.
  Uncommitted tracked changes are announced on stderr; untracked files are not
  announced (and are not part of the image unless the build context includes them).

Because the gate lives here, merging into `dev` no longer ends with a separate
container run: the merge is followed by `npm run check` (host-static), and the
container suite runs on the push itself — and again in CI's `docker` job. Needs a
Docker daemon; without one the push is refused with `verify:docker`'s own message.
Skip it for one push with:

```sh
SKIP_CONTAINER_VERIFY=1 git push ...
```

`git push --no-verify` bypasses the whole hook, as it always did.

## `main` is not pushed to directly

`main` advances through a pull request, and `pre-push` refuses a direct push to
`refs/heads/main` (a deletion included) before anything leaves the machine:

```sh
ALLOW_PUSH_MAIN=1 git push origin main   # deliberate release push
```

The **real** enforcement is GitHub's branch-protection rule on `main`
([`../docs/ops/publishing.md`](../docs/ops/publishing.md) §3.3) — a hook is a courtesy and
`git push --no-verify` bypasses it, along with everything else here. This one
exists so that a mistaken `git push origin main` is a local error message rather
than a rejected round trip. `ALLOW_PUSH_MAIN=1` is the narrow escape hatch for a
maintainer's deliberate release push; it silences *only* this rule — the static
gates and the container gate still run.

## Install

`npm install` wires this directory up via the root `package.json` `prepare`
script (`git config core.hooksPath .githooks`). To do it manually:

```sh
git config core.hooksPath .githooks
```

No `husky` dependency: the project is zero-runtime-dependency, and git's own
`core.hooksPath` is enough. The static gates touch no network. The container gate
runs the build offline from the local image store; the only network it can reach
is `verify:docker`'s single explicit base-image pull, and only when that image is
not cached (`MEERKAT_TASKPANEL_OFFLINE=1` forbids even that).

## Why a `pre-tag` script and not a `pre-tag` hook

Git has no native `pre-tag` hook — a tag is a ref, not a commit, and ref updates
are not hooked the way commits are. The rule is therefore enforced at the
earliest points git *does* offer:

1. `.githooks/pre-tag vX.Y.Z` — run it yourself before tagging (documented in
   [`../docs/ops/publishing.md`](../docs/ops/publishing.md));
2. `.githooks/pre-push` — refuses a version tag on its way out;
3. `.github/workflows/version-gate.yml` — the authoritative check on tag push;
4. `.github/workflows/release-tag.yml` — runs the same gate on the exact commit it is
   about to tag, and `.github/workflows/release.yml` re-runs it before building.

`.github/workflows/check.yml` is deliberately left untouched; the migration check
and the changelog gate live in `scripts/verify/` and run here and in
`version-gate.yml`.
