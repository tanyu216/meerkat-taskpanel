# Contributing

Thanks for looking. This file is the short version of "how work lands here"; the prose
sources of truth are [docs/development.md](docs/development.md) (layout and commands) and
[docs/docker.md](docs/docker.md) (why verification is containerised).

## Requirements

- **Node >= 22** — the project targets the `node:sqlite` era and uses modern ESM.
- **Docker** — for the authoritative gate. Nothing else; the engine has no dependencies and
  there is no root lockfile.

## The one rule that shapes everything else

**Verification runs inside Docker, not on your host.** Everything that *runs* — unit,
integration and end-to-end tests, starting or serving the app, the CLI, agent skill installs,
migration rehearsals — runs in the container:

```sh
npm run verify:docker          # build the image + run the whole suite + tear down
```

Only pure static checks may run on the host: `node --check`, `node --test`, the
`scripts/verify/*` checkers, `git`, and prototype screenshots. The full list is under
"Host-allowed checks" in [docs/docker.md](docs/docker.md).

## Before you open a pull request

```sh
npm run check                  # verify + test  (host-static, fast)
```

The authoritative gate is `npm run verify:docker`, and you do not have to run it by hand:
`.githooks/pre-push` runs it on every branch push (and CI runs it again).
`SKIP_CONTAINER_VERIFY=1 git push …` opts out for one push.

The container gate bakes the **working tree** it finds at build time, so **commit your work
before pushing** — uncommitted tracked changes would be verified instead of the commit CI
will see.

## Pull requests

`main` is protected and is the **release line**; `dev` is the only development branch and
branches come off it. The flow is:

1. Branch off `dev` (a parallel task gets a worktree: `git worktree add .worktrees/<slug>
   -b <branch> dev`).
2. Push the branch and **open a pull request into `dev`**.
3. Wait for CI. `pull_request` runs `check.yml`, `contract-gate.yml`, `paths-gate.yml`,
   `signposts-gate.yml` and `security-scan.yml`. Green CI is the entry bar.
4. Merge. `main` advances only when `dev` is merged into it as a release (below).

> **Repository settings this depends on** (GitHub-side; the tree cannot switch them on):
> on `main`, enable *Require a pull request before merging* and require the `check`,
> `docker`, `contract` and `security` status checks. The rule is the actual enforcement; the
> `pre-push` hook refuses a direct push to `main` and runs the container gate as the local
> half, but it is still a courtesy — `git push --no-verify` bypasses it, and a fresh clone has
> no hooks at all until you install them (below).

### Install the local hooks

A fresh clone has **no** hooks until you ask for them. `npm install` would wire them up via
the root `prepare` script, but this project asks you *not* to run that (the engine has no
dependencies and no lockfile). Use the manual form instead:

```sh
git config core.hooksPath .githooks
```

See [.githooks/README.md](.githooks/README.md) for what each hook enforces.

## Conventions the gates enforce

These are checked, not merely preferred. Skipping one turns CI red.

| Convention | Enforced by |
|---|---|
| **Commit with explicit paths** (`git commit -- <path>`), never a blanket `git commit -a` | review |
| **The API contract snapshot is explicit.** A route, error code or wire-field change must update `test/fixtures/contract/api.snapshot.json` via `node scripts/verify/contract.mjs --update` — never let it drift silently | `contract-gate.yml`, `.githooks/pre-push` |
| **A route's *declared* request shape must equal what its handler reads** | `scripts/verify/route-request.mjs` |
| **The skills are source.** Author them in `skills/`; nothing is generated, and no skill is distributed as a committed copy — `skills/` is the only `skills` tree in the repository. The loop runs as `taskctl loop …` (`src/orchestrator/`) | `test/scaffold.test.mjs`, `test/skill/loop.test.mjs` |
| **Migrations are append-only.** Never edit or delete a committed `src/core/storage/migrations/*.sql`; add a new numbered file. The runner refuses a database whose applied file has changed | `migrations-runner.mjs`, `.githooks/pre-commit` |
| **The container gate runs before a branch push leaves the machine** (`SKIP_CONTAINER_VERIFY=1` opts out for one push) | `.githooks/pre-push` |
| **A version tag needs a filled `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG section** (real date, at least one entry, no `_Nothing yet._`, empty `[Unreleased]`) | `version-gate.yml`, `.githooks/pre-push`, `.githooks/pre-tag` |
| **CHANGELOG entries are written on the release branch** (`release/vX.Y.Z`, the PR `release-prep` opens), never on a feature branch and never on `dev`; `[Unreleased]` stays empty between releases | review + `CLAUDE.md` (the tag gate enforces that the section is real) |
| **Every failure is a domain error with a code** — never a bare `Error` | review |
| **Layering:** `cli\|server -> core -> foundation`. `src/core/domain/` imports no Node builtins | review |

## Releasing

Releases are three dispatches and one human merge — see
[docs/publishing.md §3](docs/publishing.md) for the full shape:

1. `gh workflow run release-prep.yml -f version=X.Y.Z` — opens `release/vX.Y.Z` with the
   bumped carriers and a CHANGELOG section drafted from the commit log. **Edit the section**
   so it reads as release notes, then close/reopen the PR once to start its checks (a
   `GITHUB_TOKEN` PR does not trigger them).
2. **Merge the PR with a merge commit — never squash.** `release-tag` looks for the
   `chore(release): X.Y.Z` commit on `main`'s history.
3. `gh workflow run release-tag.yml -f dry_run=true`, then again with `-f dry_run=false`.
   It cuts the annotated tag and starts `release.yml`, which verifies (the full container
   suite), builds, publishes to npm over OIDC, smoke-tests the published package, and
   publishes the GitHub Release.

Publishing needs no secret. The one npm-side prerequisite — npm's Trusted Publishing entry
for `tanyu216/meerkat-taskpanel`, workflow `release.yml` — is written down in
[docs/publishing.md §2.1](docs/publishing.md). If Actions cannot publish, the manual
fallback is §3.4, and it is unprovenanced.

## Reporting a bug or proposing a change

Use the issue templates. For anything security-sensitive, please open a private advisory
rather than a public issue.

## License

Contributions are accepted under the project's MIT license — see [LICENSE](LICENSE).
