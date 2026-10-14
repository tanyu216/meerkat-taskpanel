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
integration and end-to-end tests, starting or serving the app, the CLI, host skill installs,
migration rehearsals — runs in the container:

```sh
npm run verify:docker          # build the image + run the whole suite + tear down
```

Only pure static checks may run on the host: `node --check`, `node --test`, the
`scripts/verify/*` checkers, `git`, and prototype screenshots. The full list is under
"Host-allowed checks" in [docs/docker.md](docs/docker.md).

## Before you open a pull request

```sh
npm run check                  # check:skills + verify + test  (host-static, fast)
npm run verify:docker          # the authoritative gate — commit first, then run it
```

The container gate bakes the tree it finds at build time, so **commit your work before
running it** — an uncommitted tree is not what CI will see.

## Pull requests

`main` is protected. The flow is:

1. Branch off `main`.
2. Push the branch and **open a pull request**.
3. Wait for CI. Three workflows already run on `pull_request`: `check.yml`,
   `contract-gate.yml` and `security-scan.yml`. Green CI is the entry bar.
4. Merge.

> **Repository settings this depends on** (GitHub-side; not enforceable from the tree):
> on `main`, enable *Require a pull request before merging* and require the `check`,
> `contract` and `security` status checks. Nothing in the tree can enforce a PR on its own:
> the `pre-push` hook runs the contract and changelog gates, but a hook is a courtesy —
> `git push --no-verify` bypasses it. The branch protection rule is the actual enforcement.

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
| **The skills are generated.** Author only under `skills/meerkat-taskpanel/` and the loop's hand-written surface; then run `node scripts/sync-skills.mjs`. `plugins/*/skills/` are generated copies | `npm run check:skills` |
| **Migrations are append-only.** Never edit or delete a committed `src/core/storage/migrations/*.sql`; add a new numbered file. The runner refuses a database whose applied file has changed | `migrations-runner.mjs`, `.githooks/pre-commit` |
| **A version tag needs a `## [X.Y.Z]` CHANGELOG section** | `version-gate.yml`, `.githooks/pre-push` |
| **Every failure is a domain error with a code** — never a bare `Error` | review |
| **Layering:** `cli\|server -> core -> shared`. `src/core/domain/` imports no Node builtins | review |

## Reporting a bug or proposing a change

Use the issue templates. For anything security-sensitive, please open a private advisory
rather than a public issue.

## License

Contributions are accepted under the project's MIT license — see [LICENSE](LICENSE).
