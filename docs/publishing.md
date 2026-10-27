# Publishing

How a Meerkat TaskPanel version is packaged and published across its distribution surfaces:
**npm**, **git + GitHub Release**, and the per-agent-kind bundles — Claude Code's marketplace,
OpenClaw, Codex and Pi.

> **Scope.** A release is three dispatches and one human merge: `release-prep` proposes the
> tree and opens a pull request, a human merges it, `release-tag` cuts the annotated tag,
> and `release.yml` verifies, builds and **publishes to npm automatically** over OIDC
> trusted publishing, then opens the public GitHub Release. There is no registry token and
> no manual publish on the happy path. Treat the workflow files and manifests as the source
> of truth: this page explains the *shape* of a release, not a copy of their contents. The
> hand-run fallback, for the day Actions cannot publish, is §3.4.

## 1. Version consistency

**Board** — four carriers, root `package.json` canonical:

| # | File | Field |
|---|---|---|
| 1 | `package.json` | `version` |
| 2 | `.claude-plugin/plugin.json` | `version` |
| 3 | `.claude-plugin/marketplace.json` | `metadata.version` |
| 4 | `src/foundation/constants.mjs` | `export const VERSION` |

The fourth is not a manifest but it is the release the **running program** reports
(`taskctl --version`, `/health`, `/meta`, the daemon log and the writer-lock record). The
tools locate it as a single line, `export const VERSION = "x.y.z";`.

Three agent kinds are not carriers. Codex and OpenClaw install the same
`.claude-plugin/plugin.json` bundle through the repository-root marketplace, and Pi declares
itself in the canonical `package.json` itself (its `pi` field) — a row for any would only
restate one above.

There is **no loop version**. `meerkat-loop` is distributed by `install.sh` from
`skills/meerkat-loop/` rather than as a plugin, and it declares the *board interface
generation* it requires (`task-interface v1`, enforced by `taskctl loop compat`) instead
of a version of its own. Its two former carriers were the `plugins/loop` manifests, which
this repository no longer ships — so ruling O4 (independent versions) is retired: the loop
moves with the board.

**Bump them with one command.** Editing these files by hand is exactly how drift starts;
`scripts/release/bump.mjs` moves the whole group at once:

```bash
node scripts/release/bump.mjs 0.1.1                    # or: npm run release:bump 0.1.1
node scripts/release/bump.mjs 0.1.1 --changelog        # + an empty CHANGELOG scaffold
node scripts/release/bump.mjs 0.1.1 --changelog --tag
```

`--group` still exists as a seam — `--group loop` is now an unknown group rather than a
silent no-op — so a second independently-versioned component could be added back without
re-deriving the bump or the check.

It edits each carrier **in place**: the one version literal is spliced — a JSON string token,
or the module's `export const VERSION = "x.y.z";` declaration — so key order, indentation,
inline objects and single-line arrays survive exactly as authored; no `JSON.parse`/`stringify`
round trip, which would reformat the whole file. The target must be strict semver and strictly
greater than the version the group's canonical manifest currently declares, and the group's
files are written **atomically**: every new body is staged to a temp file beside its target
and only all-successful staging is renamed into place, so a failure leaves the tree
byte-identical (nothing written, or everything already renamed restored). The groups, the
files and the access path to each version are imported from `version.mjs` — the bumper and the
checker cannot disagree about where a version lives. Bumping a group whose own files have
already drifted is refused rather than quietly papered over.

- `--changelog` inserts an **empty** Keep-a-Changelog scaffold (`### Added` / `### Changed` /
  `### Fixed`, one placeholder bullet each) directly below `## [Unreleased]` and above the
  newest release, and keeps the foot-of-file link references in step. It never invents an
  entry — a version that already has a section is a refusal, not a duplicate.
- `--tag` creates the local `v<x.y.z>` ref once the bump has landed — after re-running the
  tag-version and strict-changelog gates, so a scaffold section refuses the tag — and
  prints the exact `git push` command. It never pushes. In the automated flow the tag is
  cut by `release-tag` (§3), not by this flag.

**Check it.** `scripts/verify/version.mjs` checks each group against its own canonical entry;
it is part of `npm run verify` and wired into CI, so a version drifting inside a group fails
the static gate rather than shipping. Run it before tagging — and after the bump, as the proof
the bump was complete:

```bash
node scripts/verify/version.mjs                  # the board group
node scripts/verify/version.mjs --group board    # narrow to it explicitly
node scripts/release/bump.mjs 0.1.1 && node scripts/verify/version.mjs   # bump, then prove it
```

Then commit the four carriers (and the changelog, once its section is filled) **in one
commit**, and let CI confirm. The release-prep workflow does exactly this, on a
`release/vX.Y.Z` branch (§3).

## 2. npm

The published tarball's contents are decided by the `files` whitelist in the root
`package.json` — `src/`, `skills/`, `scripts/`, `docs/`, `install.sh`, `web/dist`,
`CHANGELOG.md`, `LICENSE` and the two READMEs. `web/dist` (the **built** frontend, produced
by the image's `webbuild` stage) is included so the package is a runnable board; the rest of
`web/`, `dist/` and the test/CI directories are **not**. See
[development.md](development.md#two-build-layers-engine-and-web).

> **`web/dist` needs `web/.npmignore`.** npm's packlist reads `.npmignore` in a directory
> *instead of* `.gitignore`, and a `files` entry does not override either — verified against
> npm itself. `web/.gitignore` ignores `dist/` (it is build output), so `web/.npmignore` must
> stay present and must ignore nothing; without it `npm pack` silently ships no frontend and
> the package would install an API-only server while every whitelist check still passed.
> `test/verify/pack-manifest.test.mjs` pins both halves.

The package is the **distribution**, not only a source drop. It declares three bins —
`meerkat-taskpanel` (the installer), `taskctl` and `taskd` — so after a publish:

```bash
npx meerkat-taskpanel                      # install server + taskctl + every agent kind's skill
npm install -g meerkat-taskpanel           # taskctl / taskd / the installer on PATH
```

The installer materializes the runtime at `~/.meerkat-taskpanel` and never runs from inside
the npx cache; see [install.md § Install methods](install.md#install-methods). Because the
tarball carries `web/dist`, that install needs no build step and no network.

**Precondition — already enabled.** The root manifest is publishable: it carries no
`private` flag (the flag that makes `npm publish` refuse with `EPRIVATE`), and its
`publishConfig` declares `access: "public"`, so a move to a scoped name stays public by
default. A green `npm pack` is *not* evidence of this — `pack` never refuses a private
package, and it does run the `prepare` lifecycle script.

**What gates a publish is registry state, not the manifest**: the package **name** must be
one you control and the **version** must not exist yet. The unscoped name
`meerkat-taskpanel` is this project's; `0.1.0` and `0.1.1` are published. Everything after
that goes through `release.yml` (§3); a local `npm publish` is the fallback (§3.4).

Self-check — dry-run only; nothing below uploads anything:

```bash
npm pack --dry-run      # the exact file list, no tarball written
npm pack                # write meerkat-taskpanel-<version>.tgz
node scripts/release/pack-manifest.mjs meerkat-taskpanel-<version>.tgz   # ships the release, nothing else
npm publish --dry-run   # walks every publish gate, uploads nothing
```

`npm pack` needs no `npm install`: the engine is runtime zero-dependency and works offline.
The tarball is then *installed* and booted by the release pipeline before it is published
(`node scripts/verify/tarball-install.mjs`, also part of `npm run verify:docker`), because a
package that packs cleanly can still fail to start.

### 2.1 Provenance — produced by the release workflow

`release.yml` publishes with npm's provenance flag:

```bash
npm publish <tarball> --provenance --access public
```

The attestation is a property of *where* the publish runs. The `publish` job is the only
job with `id-token: write`, `actions/setup-node` selects Node 24 (npm ≥ 11.5.1, the floor
for trusted publishing), and the job **fails if a registry token is present** — a stored
token would silently change which identity publishes. The tarball is the artifact `build`
produced, uploaded once, so the attested bytes are the tested bytes.

**The one manual prerequisite** is on npm's side, and must exist before the first CI
publish or the job stops with a 403:

1. npmjs.com → the `meerkat-taskpanel` package → **Settings → Trusted Publishing**;
2. provider **GitHub Actions**, owner `tanyu216`, repository `meerkat-taskpanel`,
   workflow filename `release.yml`, environment **empty** (the workflow does not declare a
   GitHub environment; if you add one in npm, add the identical name to the `publish` job);
3. save. No token is created, and nothing is copied into GitHub secrets.

Rotating the old granular token is safe once this is in place: the workflow reads no token.
A manual publish from a maintainer's machine is unprovenanced by definition (§3.4).

## 3. The release pipeline

Four steps, three of them explicit dispatches. Each one is separately reviewable, and each
one can stop the next:

1. **`release-prep`** (`workflow_dispatch`, inputs `version`, `dry_run`) — checks out
   `dev`, refuses if the tree is dirty, if `origin/main` is not an ancestor, or if
   `v<version>` already exists; runs `scripts/release/prep.mjs`, which bumps the four
   carriers and fills the CHANGELOG section from the commits since the previous tag;
   commits exactly those five paths; pushes `release/vX.Y.Z`; opens (or refreshes) a pull
   request to `main`.

   ```bash
   gh workflow run release-prep.yml -f version=0.1.2 -f dry_run=true   # look first
   gh workflow run release-prep.yml -f version=0.1.2
   ```

   A PR created with `GITHUB_TOKEN` does **not** trigger `pull_request` workflows. The PR
   body says so: close and reopen it to start the checks. (A dedicated App/PAT token would
   close that gap; the pipeline deliberately does not require one.)

2. **A human merges the PR — with a merge commit, never a squash.** The release commit
   `chore(release): <version>` must stay in `main`'s history for the tag step to find it.

3. **`release-tag`** (`workflow_dispatch`, inputs `version`, `commit`, `dry_run` — default
   **true**) — resolves the version from `main`, resolves the release commit, checks it out
   detached, and runs the tag gate (tag-version, version, strict changelog, contract,
   route-request, paths, signposts). It then creates the annotated tag `v<version>`, pushes
   it, and dispatches `release.yml`. A tag that already exists is never moved: same commit
   is a re-dispatch, a different commit is a refusal.

   ```bash
   gh workflow run release-tag.yml -f dry_run=true     # then, once it looks right:
   gh workflow run release-tag.yml -f dry_run=false
   ```

4. **`release.yml`** runs on the tag (and on `workflow_dispatch` for a dry run):

   | Job | What it proves |
   |---|---|
   | `verify` | the tag gate **plus the full container suite** (`npm run verify:docker`) |
   | `build` | the frontend, the release tree, one tarball, its manifest check, an install-and-boot of that tarball, and the SBOM |
   | `publish` | `npm publish --provenance` over OIDC, then polls until the exact version and its attestation resolve |
   | `smoke` | installs the **published** version outside the repository and boots it (`scripts/verify/published-smoke.mjs`) |
   | `release` | a public GitHub Release with the tarball and the SBOM, and asserts `isDraft=false` |

   A red `verify` publishes nothing. A red `smoke` leaves npm published but no GitHub
   Release — fix forward with a patch; do not reuse the version.

The release's asset list is **closed and complete**: the npm tarball
(`meerkat-taskpanel-<version>.tgz`) and the SBOM (`sbom.spdx.json`, syft/SPDX JSON). The
SBOM is a required step — if it cannot be produced, the job fails before anything is
published — so "a release with no bill of materials" is not a state this pipeline can
reach. `security-scan.yml` also attaches an SBOM for the same tag, best-effort and after
the fact; both jobs run the same action over the same commit, and it is `release.yml`'s copy
whose presence the release depends on. The scanner, its threshold and the waiver ledger are
documented in [security.md](security.md).

Tags are cut from `main` — §3.3 states that policy and the repository settings that back it.

> Commits in this repository use explicit paths (`git commit -- <path>`), never a bare
> `git commit -a`. The workflows above use `git commit -- <five paths>` for the same reason.

### 3.1 The tag ↔ CHANGELOG gate

A version tag is only cut when `CHANGELOG.md` documents it **and the section is real**. The
*strict* form of the gate — used at tag time — requires:

- a heading `## [x.y.z] - YYYY-MM-DD` with a real date (not a placeholder);
- at least one top-level bullet in the section;
- no `- _Nothing yet._` scaffold bullet anywhere in the section;
- an `## [Unreleased]` section that carries no un-released entry.

The section is authored on the **release branch** (`release/vX.Y.Z`, the PR `release-prep`
opens), never on a feature branch and never on `dev`: `dev` stays a development log, and
`[Unreleased]` stays empty between releases. `release-prep` scaffolds the section and fills
it from the commit log:

```bash
node scripts/release/prep.mjs --version 1.2.3 --dry-run   # what it would write
node scripts/release/changelog-from-log.mjs 1.2.3 --from v1.2.2
```

The generated entries are a **draft**: conventional commits map to `Added` / `Changed` /
`Fixed` / `Removed`, card ids, PR refs and commit hashes are stripped, and the PR's human
editor owns the final wording. A range with no releasable commit is an error — the tool
never writes `_Nothing yet._` and calls it a release.

The rule lives in one reusable, offline checker — `scripts/verify/changelog.mjs`:

```bash
node scripts/verify/changelog.mjs v1.2.3              # exit 0 has an entry · 1 missing · 2 usage
node scripts/verify/changelog.mjs v1.2.3 --strict     # the tag-time form above
```

Local hooks (`git config core.hooksPath .githooks`, wired by the root `package.json`
`prepare` script — no `husky` dependency, see [`.githooks/README.md`](../.githooks/README.md)):

- **`.githooks/pre-tag v1.2.3`** — run it yourself *before* `git tag`. Git has no native
  `pre-tag` hook (a tag is a ref, not a commit), so this is invoked explicitly. It runs the
  contract, route-request, version, tag-version and strict-changelog gates.
- **`.githooks/pre-push`** — always runs the static gates including `version.mjs`; a
  `refs/tags/vX.Y.Z` also runs `tag-version.mjs` and `changelog.mjs --strict`, and a branch
  push ends with the container gate.
- **`.githooks/pre-commit`** — the append-only migration check (see
  [migration.md](migration.md#the-append-only-migration-gate)); unrelated to tagging but
  shipped in the same directory.

CI is the authority: **`.github/workflows/version-gate.yml`** runs on a `v*` tag push and
runs `tag-version.mjs "$GITHUB_REF_NAME" --on-main`, `version.mjs` and
`changelog.mjs "$GITHUB_REF_NAME" --strict`. It is a separate workflow on purpose —
`.github/workflows/check.yml` is owned by a concurrent change and is deliberately not
touched, so the release/version rule is carried by `version-gate.yml` instead.

### 3.2 The API contract gate

A tag must not freeze an API contract the committed snapshot does not describe. The
same two hooks (`pre-push`, `pre-tag`) also run `scripts/verify/contract.mjs`, which
compares the live surface — routes and their declared request shapes (type/enum/items),
error codes, and wire field names and types — against
`test/fixtures/contract/api.snapshot.json`; a change to any of them without a
snapshot update is a non-zero exit. Next to it, `scripts/verify/route-request.mjs`
proves the declaration the snapshot freezes is the one the handler honours: it reads
each route's handler source and compares the fields it reads against the declared
`{query, body}`. `version-gate.yml` runs the snapshot check at tag time, and
`.github/workflows/contract-gate.yml` runs both on every branch push and pull request.
The full story, and the `--update` workflow, is in [contract.md](contract.md).

### 3.3 Branch protection on `main`, and tags cut only from `main`

`release.yml` fingerprints whatever commit the tag points at, so the history *behind* the tag
is part of the release. Three rules keep that history reviewed. **None of them is code:** the
first two are repository settings, the third is tagging discipline, and no workflow here can
prove any of them (reading branch protection takes an API scope this repository deliberately
does not hand its workflows). They are stated as policy, with the human steps that apply them.

1. **`main` changes only through a pull request.** No direct pushes, no force pushes, no
   deletions: an unreviewed commit must not become reachable from `main`. The `pre-push` hook
   refuses a direct push to `main` locally ([.githooks/README.md](../.githooks/README.md)),
   which is a courtesy — the rule below is the enforcement.
2. **The required checks are green before the merge.** The checks are this repository's own
   workflows, so the list is short and closed — from `check.yml` the `check` job (both matrix
   legs) and the `docker` job, from `contract-gate.yml` the `contract` job, and from
   `security-scan.yml` the `Dependency scan (osv-scanner + npm audit)` and `SBOM (syft)`
   jobs. In the GitHub UI they appear under the names the jobs declare: `check (22)`,
   `check (24)`, `docker`, `contract`. Requiring the scan is safe by design — that job is
   alert-only (`SCAN_STRICT` off), so a known advisory does not red the build; requiring it
   makes the scan's *presence* non-optional, not its verdict.
3. **A version tag is cut only from a commit on `main`.** A tag is pushed, not merged, so
   the checks above ran on the pull request that produced its commit; §3.1's CHANGELOG rule
   still guards the version string itself.
4. **A release PR is merged with a merge commit, never a squash.** `release-tag` looks for
   the `chore(release): <version>` commit on `main`'s history; a squash rewrites the message
   and the commit, and the tag step then has no release commit to find (it falls back to
   `main`'s tip only when that tip already carries the version). The PR body repeats this.

`version-gate.yml` and `release.yml` are tag-triggered and never appear as PR checks — they
run *because* a tag was pushed, which is exactly why rule 3 matters.

**Applying them — the GitHub settings, by hand.** Two screens:

- **Branches.** Settings → Branches → **Add branch protection rule** for `main` (a ruleset
  under Settings → Rules is the newer equivalent), then:
  - **Require a pull request before merging** — at least one approval, and enable *Dismiss
    stale pull request approvals when new commits are pushed*. **Check the collaborator count
    first.** With no second contributor a required approval can never be satisfied (GitHub
    does not let you approve your own pull request), and pairing it with *Do not allow
    bypassing* below freezes `main` outright; a single-maintainer repository is better served
    by requiring the pull request and keeping the administrative bypass;
  - **Require status checks to pass before merging** — search for and add `check` (both
    matrix legs), `docker`, `contract`, `Dependency scan (osv-scanner + npm audit)` and
    `SBOM (syft)`, then tick *Require branches to be up to date before merging*;
  - **Require conversation resolution before merging**;
  - **Do not allow bypassing the above settings**, so administrators are covered too;
  - leave *Allow force pushes* and *Allow deletions* **unchecked**.
- **Tags.** Settings → Rules → **New tag ruleset** targeting `v*` (the older *Tag protection
  rules* are the equivalent), restricting **creations, updates and deletions** to the
  maintainers who cut releases — **and allowing the GitHub Actions app**, or listing it in
  the ruleset's bypass list. `release-tag` pushes the tag with `GITHUB_TOKEN`; without that
  entry the push is refused and the run fails at the "Push the tag" step, with a message
  naming this ruleset.

That second screen restricts *who* may create a `v*` tag; GitHub has no setting for *which
commit* a tag points at, so the tag-from-`main` half stays a human check — and it is
scriptable before the push:

```bash
git fetch origin main
git merge-base --is-ancestor "$(git rev-parse v1.2.3^{commit})" origin/main \
  && echo "v1.2.3 is on main" \
  || echo "REFUSE: v1.2.3 is not on main"
```

### 3.4 Manual fallback: publishing without Actions

Use this only when the OIDC path is unavailable (trusted publishing not yet configured, an
outage, or a release cut from a machine that has no Actions run). It produces an
**unprovenanced** release: `--provenance` outside a supported CI provider adds no
attestation, so leaving it off is honest.

1. **Publish from the tagged tree, not a branch.** `git checkout v<version>`, then build the
   frontend exactly as the pipeline does (`docker build --target webbuild`, extract
   `web/dist`) and `npm pack --silent --ignore-scripts`. Verify it:
   `node scripts/release/pack-manifest.mjs <tarball> --expected-version <version>`.
2. **Authenticate.** `npm login` works interactively, but a **web-login token cannot
   publish** (`E403`). For a non-interactive machine create a *granular access token* with
   **Read and write** on this package and **bypass 2FA** enabled; it lives only in
   `~/.npmrc` (`//registry.npmjs.org/:_authToken=…`). Never echo it, and rotate it when
   done. `npm token list` shows whether the token in use is the one you think.
3. **Publish, then wait.** `npm publish <tarball> --access public`. npm's staged publishing
   may answer with a placeholder (`0.0.0-stage`); the version is not resolvable until
   replication finishes. Poll `curl -fsS https://registry.npmjs.org/meerkat-taskpanel/<version>`
   until it returns 200, then compare `dist.integrity` against the tarball.
4. **Smoke it outside the repository.** `cd /tmp && npx -y meerkat-taskpanel@<version> --version`.
   Running `npx` inside the checkout resolves the *local* package and proves nothing.
5. **GitHub Release.** Reuse the pipeline's artifacts:
   `node scripts/release/release-notes.mjs v<version> > release-notes.md`, then
   `gh release create v<version> <tarball> sbom.spdx.json --title … --notes-file …`.

If `git push` fails because port 22 is blocked, push over 443 —
`GIT_SSH_COMMAND='ssh -p 443 -o HostName=ssh.github.com'` — after adding
`ssh.github.com:443` to `known_hosts` with `ssh-keyscan -p 443 -t ed25519 ssh.github.com`
and verifying the fingerprint against GitHub's published ED25519 key.

### 3.5 Aborting and rolling back

The pipeline is built so that the expensive, irreversible step is last:

| Where it stopped | What to do |
|---|---|
| `release-prep` failed | nothing was pushed; fix the tree and re-dispatch. |
| The release PR is wrong | close it and delete `release/vX.Y.Z`; re-dispatch `release-prep`. |
| `release-tag` dry run is wrong | nothing was created. Re-dispatch after fixing `main`. |
| Tagged, before `publish` | cancel the run, delete the local and remote tag. The version is still free. |
| Published, `smoke` or `release` failed | **the version is shipped.** Never reuse it. Fix forward: `npm deprecate meerkat-taskpanel@<version> "<why>"` if it is broken, then cut the next patch. Re-running the `release` job can repair the GitHub Release from the build artifacts. |

A published version cannot be unpublished for long (npm allows one unpublish inside 72 hours
only in narrow cases) and consumers may already hold it; `deprecate` plus a patch is the
supported answer.

## 4. Claude Code marketplace

`.claude-plugin/marketplace.json` (marketplace name `meerkat-taskpanel-marketplace`) lists
**one plugin**:

| Plugin | Source | Carries |
|---|---|---|
| `meerkat-taskpanel` | `./` | all three skills — the repository's one `skills/` tree, read in place |

The loop used to be a second entry, sourced at a `plugins/loop` bundle that carried the loop
skill and nothing else so it could be installed alone. That bundle is gone: `meerkat-loop`
is installed by `install.sh --target claude|codex|pi`, and a marketplace install of the board
brings the loop with it (the shared tree is not filtered per entry).

```bash
# consumer: register this repository as the marketplace
claude plugin marketplace add <path-or-git-url>
claude plugin install meerkat-taskpanel@meerkat-taskpanel-marketplace -y

# verify
claude plugin list                  # → the plugin, enabled
claude plugin validate <path>       # validates the plugin + marketplace manifests
```

Nothing under `skills/` is a generated copy, and there is no generated loop payload: the
loop is `src/orchestrator/` (reached through `taskctl loop …`) and the skills are source.
Editing a skill or the loop is an ordinary source edit.

## 5. OpenClaw

OpenClaw has one supported route. There is **no native manifest**: a *native* OpenClaw plugin
is an in-process runtime module that must additionally ship `package.json#openclaw.extensions`
and an entry point importing the OpenClaw plugin SDK — a real runtime dependency this
zero-dependency project deliberately does not take. Such a manifest could not be installed as
what it claimed to be, so the repository ships none (it did until `plugins/` was emptied).

- **Bundle (the supported skill-only route)** — OpenClaw consumes the Claude-format bundle:

```bash
openclaw plugins install <path> --force --accept-capabilities
openclaw plugins inspect meerkat-taskpanel    # Format: bundle / Bundle format: claude / skills
```

Equivalently, placing the skill in `~/.openclaw/skills/` (what `install.sh --target openclaw`
does) is enough for the skill to be found.

## 6. Codex

Codex reads the same repository-root marketplace manifest as Claude
(`.claude-plugin/marketplace.json`), and installs the same `./` bundle. It ships no manifest
of its own, which is why it appears in neither the version-carrier table nor any bundle
directory of its own.

```bash
codex plugin marketplace add <path-or-git-url>
codex plugin add meerkat-taskpanel@meerkat-taskpanel-marketplace

# verify
codex plugin list
```

## 7. Pi / Agent Skills

The board's Pi package **is the repository's own `package.json`**: its `pi` object declares
`skills` (the one tree) and `extensions` (the module in `.pi/extensions/` that re-registers
that directory at runtime). Pi reads `extensions`, `skills`, `prompts` and `themes` from a
package's `pi` object, so no separate Pi package or copy of the skill tree is published. The
loop reaches Pi through `install.sh --target pi` (`~/.agents/skills/meerkat-loop`), like on
claude and codex.

```bash
pi install <path>                   # the board

# verify
pi list
```

## 8. Skill wrappers ship with the bundle

Every manifest points at the repository's one `skills/` tree, so the npm whitelist ships the
skills directly and no bundle carries a generated copy of its own (see
[development.md](development.md#the-skills-are-authored-never-generated)). The loop needs no
payload step: it is `src/orchestrator/` inside the published tree, and the units run
`taskctl loop …`.

The `files` whitelist must also name each dot-directory the plugins live in
(`.claude-plugin`, `.pi`): npm does not include dot files by
default, so a manifest that is not listed never reaches the tarball, and
`node scripts/release/pack-manifest.mjs` fails the release on it.

## See also

- [install.md](install.md) — the per-agent-kind install and plugin-registration commands in full.
- [development.md](development.md) — the two build layers, the offline policy and the
  generated-skill rule.
- [`../README.md`](../README.md) / [`../README.zh-CN.md`](../README.zh-CN.md) — status and
  the four-agent-kind support matrix.
