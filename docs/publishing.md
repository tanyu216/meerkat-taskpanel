# Publishing

How a Meerkat TaskPanel version is packaged and published across the five distribution
surfaces: **npm**, **git + GitHub Release**, and the four host bundles (Claude Code
marketplace, OpenClaw, Codex, Pi).

> **Scope.** This page documents the steps only. **The actual `push`, tag and release are
> performed by Elon** — nothing here is run as part of writing this document, and CI does
> not publish to npm. Treat the workflow files and manifests as the source of truth: this
> page explains the *shape* of a release, not a copy of their contents.

## 1. Version consistency

A release version lives in **six files**, and all six must carry the same value:

| # | File | Field |
|---|---|---|
| 1 | `package.json` | `version` |
| 2 | `plugins/pi/package.json` | `version` |
| 3 | `plugins/claude/.claude-plugin/plugin.json` | `version` |
| 4 | `plugins/codex/.codex-plugin/plugin.json` | `version` |
| 5 | `plugins/openclaw/openclaw.plugin.json` | `version` |
| 6 | `.claude-plugin/marketplace.json` | `metadata.version` |

**Bump them with one command.** Editing six files by hand is exactly how drift starts;
`scripts/release/bump.mjs` moves all six at once:

```bash
node scripts/release/bump.mjs 1.1.0                    # or: npm run release:bump 1.1.0
node scripts/release/bump.mjs 1.1.0 --changelog        # + an empty CHANGELOG scaffold
node scripts/release/bump.mjs 1.1.0 --changelog --tag
```

It edits each manifest **in place**: the one version string token is spliced, so key order,
indentation, inline objects and single-line arrays survive exactly as authored — no
`JSON.parse`/`stringify` round trip, which would reformat the whole file. The target must be
strict semver and strictly greater than the version the root `package.json` currently
declares, and the six files are written **atomically**: every new body is staged to a temp
file beside its target and only all-successful staging is renamed into place, so a failure
leaves the tree byte-identical (nothing written, or everything already renamed restored).
The list of six, and the JSON path to each version, is imported from `version.mjs` — the
bumper and the checker cannot disagree about where the version lives. Bumping a tree that has
already drifted is refused rather than quietly papered over.

- `--changelog` inserts an **empty** Keep-a-Changelog scaffold (`### Added` / `### Changed` /
  `### Fixed`, one placeholder bullet each) directly below `## [Unreleased]` and above the
  newest release, and keeps the foot-of-file link references in step. It never invents an
  entry — a version that already has a section is a refusal, not a duplicate.
- `--tag` creates the local `v<x.y.z>` ref once the bump has landed and prints the exact
  `git push` command. It never pushes (§3); the push stays Elon's.

**Check it.** `scripts/verify/version.mjs` checks that the six agree; it is wired into CI, so
a drifting version fails the build rather than shipping. Run it before tagging — and after
the bump, as the proof the bump was complete:

```bash
node scripts/verify/version.mjs
node scripts/release/bump.mjs 1.1.0 && node scripts/verify/version.mjs   # bump, then prove it
```

Then commit the six files (and the scaffold, once filled in) **in one commit**, and let CI
confirm.

## 2. npm

The published tarball's contents are decided by the `files` whitelist in the root
`package.json` — `src/`, `skills/`, `plugins/`, `scripts/`, `docs/`, `install.sh`,
`CHANGELOG.md`, `LICENSE` and the two READMEs. `web/`, `dist/` and the test/CI directories
are **not** in it (the hosted board is a separate build; see
[development.md](development.md#two-build-layers-engine-and-web)).

**Precondition — already enabled.** The root manifest is publishable: it carries no
`private` flag (the flag that makes `npm publish` refuse with `EPRIVATE`), and its
`publishConfig` declares `access: "public"`, so a move to a scoped name stays public by
default. A green `npm pack` is *not* evidence of this — `pack` never refuses a private
package, and it does run the `prepare` lifecycle script.

**Not yet a live surface.** What gates a publish is registry state, not the manifest: the
package **name** must be one you control and the **version** must not exist yet. The
unscoped name `meerkat-taskpanel` is already taken on the public registry by an unrelated
package, so a real `npm publish` is refused today and a release needs a name decision
first — most likely a scope, which the `publishConfig.access` above already covers.

Self-check — dry-run only; nothing below uploads anything:

```bash
npm pack --dry-run      # the exact file list, no tarball written
npm pack                # write meerkat-taskpanel-<version>.tgz
node scripts/release/pack-manifest.mjs meerkat-taskpanel-<version>.tgz   # ships the release, nothing else
npm publish --dry-run   # walks every publish gate, uploads nothing
npm publish             # the real publish (Elon) — a release, not a check
```

`npm pack` needs no `npm install`: the engine is runtime zero-dependency and works offline.

### 2.1 Provenance — prepared, not yet produced

The publish command is documented with npm's provenance flag already on it, so moving to
attested releases is a change to *where* a publish runs, not a flag somebody has to discover
later:

```bash
npm publish --provenance
```

Read that as a **target**, not a description of today's state, for two reasons:

- npm attaches a provenance statement only when it can obtain an OIDC token from a supported
  CI/CD provider (GitHub Actions with `id-token: write`, or GitLab CI/CD). Invoked outside
  one, the flag produces no attestation — provenance is a property of *where* the publish
  runs, not of the command line.
- That publish path does not exist yet, by decision (D2=A). `.github/workflows/release.yml`
  holds no `NPM_TOKEN`, has no `npm publish` step, and never publishes to a registry or a
  marketplace — it ends at the draft release. A human promotes the draft, and that human's
  machine is not a supported provenance provider.

So every release cut under the current pipeline is **unprovenanced**, and this subsection
exists to say so out loud: the flag is prepared for the day publishing moves behind CI OIDC,
and it is not evidence about any release published before then.

## 3. Git tag + GitHub Release

The release pipeline is **tag-driven**: `.github/workflows/release.yml` runs on
`push` of a tag matching `v*`. It re-runs the checks, builds the release tree
(`node scripts/build.mjs`), packages and verifies the npm tarball, generates the SBOM, and
opens a GitHub Release **draft** carrying both artifacts. It does **not** publish anywhere
automatically — the draft is for a human to review and publish, and the workflow holds no
credential that could publish.

The workflow file is authoritative for the exact steps and the Node version it pins; read
it before cutting a release rather than relying on this summary.

The draft's asset list is **closed and complete**: the npm tarball
(`meerkat-taskpanel-<version>.tgz`) and the SBOM (`sbom.spdx.json`, syft/SPDX JSON). The
SBOM is generated by the release job itself and is a required step — if it cannot be
produced, the job fails before the draft is created — so "a draft release with no bill of
materials" is not a state the pipeline can reach. `security-scan.yml` also attaches an SBOM
to the draft for the same tag, best-effort and after the fact; both jobs run the same action
over the same commit, so the two files describe the same tree, and it is `release.yml`'s copy
whose presence the draft depends on. The scanner, its threshold and the waiver ledger are
documented in [security.md](security.md).

Tags are cut from `main` — §3.3 states that policy and the repository settings that back it.

```bash
# Run by Elon — not part of the document. Cut from a commit on `main`: see §3.3.
git tag v<version>          # must match the six version fields above
git push origin v<version>  # triggers .github/workflows/release.yml
```

> Commits in this repository use explicit paths (`git commit -- <path>`), never a bare
> `git commit -a`. Tags and pushes are destructive-ish and are Elon's to make.

### 3.1 The tag ↔ CHANGELOG gate

A version tag is only cut when `CHANGELOG.md` documents it. The rule lives in one
reusable, offline checker — `scripts/verify/changelog.mjs` — and every door calls it:

```bash
node scripts/verify/changelog.mjs v1.2.3     # exit 0 has an entry · 1 missing · 2 usage
```

Local hooks (`git config core.hooksPath .githooks`, wired by the root `package.json`
`prepare` script — no `husky` dependency, see [`.githooks/README.md`](../.githooks/README.md)):

- **`.githooks/pre-tag v1.2.3`** — run it yourself *before* `git tag`. Git has no native
  `pre-tag` hook (a tag is a ref, not a commit), so this is invoked explicitly.
- **`.githooks/pre-push`** — refuses a `refs/tags/vX.Y.Z` on its way out when the version
  is missing from the changelog.
- **`.githooks/pre-commit`** — the append-only migration check (see
  [migration.md](migration.md#the-append-only-migration-gate)); unrelated to tagging but
  shipped in the same directory.

CI is the authority: **`.github/workflows/version-gate.yml`** runs on a `v*` tag push and
runs the same checker against `${GITHUB_REF_NAME}`. It is a separate workflow on purpose —
`.github/workflows/check.yml` is owned by a concurrent change and is deliberately not
touched, so the release/version rule is carried by `version-gate.yml` instead.

### 3.2 The API contract gate

A tag must not freeze an API contract the committed snapshot does not describe. The
same two hooks (`pre-push`, `pre-tag`) also run `scripts/verify/contract.mjs`, which
compares the live surface — routes and their declared request shapes, error codes, wire
field names and types, and each MCP tool's `inputSchema` (type/enum/items) — against
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
   deletions: an unreviewed commit must not become reachable from `main`.
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

`version-gate.yml` and `release.yml` are tag-triggered and never appear as PR checks — they
run *because* a tag was pushed, which is exactly why rule 3 matters.

**Applying them — the GitHub settings, by hand.** Two screens:

- **Branches.** Settings → Branches → **Add branch protection rule** for `main` (a ruleset
  under Settings → Rules is the newer equivalent), then:
  - **Require a pull request before merging** — at least one approval, and enable *Dismiss
    stale pull request approvals when new commits are pushed*;
  - **Require status checks to pass before merging** — search for and add `check` (both
    matrix legs), `docker`, `contract`, `Dependency scan (osv-scanner + npm audit)` and
    `SBOM (syft)`, then tick *Require branches to be up to date before merging*;
  - **Require conversation resolution before merging**;
  - **Do not allow bypassing the above settings**, so administrators are covered too;
  - leave *Allow force pushes* and *Allow deletions* **unchecked**.
- **Tags.** Settings → Rules → **New tag ruleset** targeting `v*` (the older *Tag protection
  rules* are the equivalent), restricting **creations, updates and deletions** to the
  maintainers who cut releases.

That second screen restricts *who* may create a `v*` tag; GitHub has no setting for *which
commit* a tag points at, so the tag-from-`main` half stays a human check — and it is
scriptable before the push:

```bash
git fetch origin main
git merge-base --is-ancestor "$(git rev-parse v1.2.3^{commit})" origin/main \
  && echo "v1.2.3 is on main" \
  || echo "REFUSE: v1.2.3 is not on main"
```

## 4. Claude Code marketplace

`.claude-plugin/marketplace.json` (marketplace name `meerkat-taskpanel-marketplace`) points its
single plugin `meerkat-taskpanel` at `./plugins/claude`, whose `.claude-plugin/plugin.json`
declares `"skills": "./skills"`.

```bash
# consumer: register this repository as the marketplace, then install the plugin
claude plugin marketplace add <path-or-git-url>
claude plugin install meerkat-taskpanel@meerkat-taskpanel-marketplace -y

# verify
claude plugin list                  # → meerkat-taskpanel@meerkat-taskpanel-marketplace, enabled
claude plugin validate <path>       # validates the plugin + marketplace manifests
```

The generated `plugins/claude/skills/` copy must match `skills/` — `npm run check:skills`
fails CI on drift, so run `node scripts/sync-skills.mjs` after any skill edit.

## 5. OpenClaw

OpenClaw has two routes, and they are not interchangeable:

- **Native manifest** — `plugins/openclaw/openclaw.plugin.json`. A *native* OpenClaw plugin
  is an in-process runtime module: it must additionally ship `package.json#openclaw.extensions`
  and an entry point that imports the OpenClaw plugin SDK. That SDK is a real runtime
  dependency this zero-dependency project deliberately does not take, so `plugins/openclaw`
  is a manifest only — OpenClaw's detector still classifies it as native, which is why the
  repository verifies the *bundle* contract against `plugins/claude` instead.
- **Bundle (the supported skill-only route)** — OpenClaw consumes the Claude-format bundle:

```bash
openclaw plugins install <path>/plugins/claude --force --accept-capabilities
openclaw plugins inspect meerkat-taskpanel    # Format: bundle / Bundle format: claude / skills
```

Equivalently, placing the skill in `~/.openclaw/skills/` (what `install.sh --target openclaw`
does) is enough for the skill to be found.

## 6. Codex

Codex reads the same repository-root marketplace manifest as Claude
(`.claude-plugin/marketplace.json`) and the `plugins/codex/.codex-plugin/plugin.json`
bundle.

```bash
codex plugin marketplace add <path-or-git-url>
codex plugin add meerkat-taskpanel@meerkat-taskpanel-marketplace

# verify
codex plugin list
```

## 7. Pi / Agent Skills

`plugins/pi/package.json` is the Pi package (`"files": ["skills"]`), and `plugins/pi/skills/`
is the generated skill copy.

```bash
pi install <path>/plugins/pi

# verify
pi list
```

## 8. Skill wrappers ship with the bundle

Every host bundle carries its own generated `skills/` copy (see
[development.md](development.md#the-skill-is-generated-never-hand-edited)). A publish is
only correct if `node scripts/sync-skills.mjs --check` is green — the generated copies and
`skills/meerkat-taskpanel/` must be identical. Both are in the npm whitelist, so the tarball ships
the source skill *and* the per-host copies.

## See also

- [install.md](install.md) — the per-host install and plugin-registration commands in full.
- [development.md](development.md) — the two build layers, the offline policy and the
  generated-skill rule.
- [`../README.md`](../README.md) / [`../README.zh-CN.md`](../README.zh-CN.md) — status and
  the four-host support matrix.
