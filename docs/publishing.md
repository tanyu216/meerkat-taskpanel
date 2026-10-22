# Publishing

How a Meerkat TaskPanel version is packaged and published across its distribution surfaces:
**npm**, **git + GitHub Release**, and the per-agent-kind bundles — Claude Code's marketplace,
OpenClaw, Codex, Pi, Cursor and OpenCode.

> **Scope.** This page documents the steps only. **The actual `push`, tag and release are
> performed by Elon** — nothing here is run as part of writing this document, and CI does
> not publish to npm. Treat the workflow files and manifests as the source of truth: this
> page explains the *shape* of a release, not a copy of their contents.

## 1. Version consistency

**Board** — four files, root `package.json` canonical:

| # | File | Field |
|---|---|---|
| 1 | `package.json` | `version` |
| 2 | `.claude-plugin/plugin.json` | `version` |
| 3 | `.cursor-plugin/plugin.json` | `version` |
| 4 | `.claude-plugin/marketplace.json` | `metadata.version` |

Three agent kinds are not carriers. Codex and OpenClaw install the same
`.claude-plugin/plugin.json` bundle through the repository-root marketplace, and Pi declares
itself in the canonical `package.json` itself (its `pi` field) — a row for any would only
restate one above.

There is **no loop version**. `meerkat-loop` is distributed by `install.sh` from
`skills/meerkat-loop/` rather than as a plugin, and it declares the *board interface
generation* it requires (`task-interface v1`, enforced by its own `board-check.mjs`) instead
of a version of its own. Its two former carriers were the `plugins/loop` manifests, which
this repository no longer ships — so ruling O4 (independent versions) is retired: the loop
moves with the board.

**Bump them with one command.** Editing these files by hand is exactly how drift starts;
`scripts/release/bump.mjs` moves the whole group at once:

```bash
node scripts/release/bump.mjs 1.1.0                    # or: npm run release:bump 1.1.0
node scripts/release/bump.mjs 1.1.0 --changelog        # + an empty CHANGELOG scaffold
node scripts/release/bump.mjs 1.1.0 --changelog --tag
```

`--group` still exists as a seam — `--group loop` is now an unknown group rather than a
silent no-op — so a second independently-versioned component could be added back without
re-deriving the bump or the check.

It edits each manifest **in place**: the one version string token is spliced, so key order,
indentation, inline objects and single-line arrays survive exactly as authored — no
`JSON.parse`/`stringify` round trip, which would reformat the whole file. The target must be
strict semver and strictly greater than the version the group's canonical manifest currently
declares, and the group's files are written **atomically**: every new body is staged to a temp
file beside its target and only all-successful staging is renamed into place, so a failure
leaves the tree byte-identical (nothing written, or everything already renamed restored).
The groups, the files and the JSON path to each version are imported from `version.mjs` — the
bumper and the checker cannot disagree about where a version lives. Bumping a group whose own
files have already drifted is refused rather than quietly papered over.

- `--changelog` inserts an **empty** Keep-a-Changelog scaffold (`### Added` / `### Changed` /
  `### Fixed`, one placeholder bullet each) directly below `## [Unreleased]` and above the
  newest release, and keeps the foot-of-file link references in step. It never invents an
  entry — a version that already has a section is a refusal, not a duplicate.
- `--tag` creates the local `v<x.y.z>` ref once the bump has landed and prints the exact
  `git push` command. It never pushes (§3); the push stays Elon's.

**Check it.** `scripts/verify/version.mjs` checks each group against its own canonical entry;
it is wired into CI, so a version drifting inside a group fails the build rather than
shipping. Run it before tagging — and after the bump, as the proof the bump was complete:

```bash
node scripts/verify/version.mjs                  # both groups
node scripts/verify/version.mjs --group loop     # narrow to one
node scripts/release/bump.mjs 1.1.0 && node scripts/verify/version.mjs   # bump, then prove it
```

Then commit the six files (and the scaffold, once filled in) **in one commit**, and let CI
confirm.

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

**Not yet a live surface.** What gates a publish is registry state, not the manifest: the
package **name** must be one you control and the **version** must not exist yet. The
unscoped name `meerkat-taskpanel` is this project's (the maintainer confirmed the
ownership), so a publish needs no name decision; it is still refused until the release
bump's version is free and the publishing machine is authenticated. `npx
meerkat-taskpanel` becomes usable only once that publish has happened.

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
(`node scripts/build.mjs`), copies the image's built `web/dist` into the packaging tree so the
tarball carries a runnable frontend, packages and verifies the npm tarball, generates the
SBOM, and opens a GitHub Release **draft** carrying both artifacts. It does **not** publish anywhere
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

`.claude-plugin/marketplace.json` (marketplace name `meerkat-taskpanel-marketplace`) lists
**one plugin**:

| Plugin | Source | Carries |
|---|---|---|
| `meerkat-taskpanel` | `./` | both skills — the repository's one `skills/` tree, read in place |

The loop used to be a second entry, sourced at a `plugins/loop` bundle that carried the loop
skill and nothing else so it could be installed alone. That bundle is gone: `meerkat-loop`
is installed by `install.sh --target claude|codex|pi|opencode|cursor`, and a marketplace install of the board
brings the loop with it (the shared tree is not filtered per entry).

```bash
# consumer: register this repository as the marketplace
claude plugin marketplace add <path-or-git-url>
claude plugin install meerkat-taskpanel@meerkat-taskpanel-marketplace -y

# verify
claude plugin list                  # → the plugin, enabled
claude plugin validate <path>       # validates the plugin + marketplace manifests
```

Nothing under `skills/` is a generated copy any more, so there is nothing for
`npm run check:skills` to compare against a plugin bundle. It still guards the loop skill's
**payload** (`skills/meerkat-loop/{manifest.txt,scripts,templates}`, with foundation inside `scripts/foundation/`), which is generated from
`scripts/supervisor.mjs`, `scripts/loop/`, `scripts/wake-cwd.mjs`, `src/foundation/` and
`scripts/install/templates/`; run `node scripts/sync-skills.mjs` after any edit there.

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

## 8. Cursor

`.cursor-plugin/plugin.json` declares `"skills": "./skills/"` — the repository's one
`skills/` tree, read in place. Cursor registers a *directory*, so nothing is copied and both
skills arrive together.

```bash
# consumer: in Cursor's agent chat
/add-plugin meerkat-taskpanel     # or find it in the plugin marketplace

# what this repository can verify without Cursor installed
node scripts/verify/manifests.mjs   # the .cursor-plugin manifest row
node scripts/verify/version.mjs     # the cursor row in the version-carrier table (§1)
```

Unlike Codex, Cursor **is** a version carrier: `.cursor-plugin/plugin.json` is a row in the
table in §1, and the release runs `scripts/verify/version.mjs` before `npm pack`.
`docker/profiles/cursor.yml` declares `bundle: .` / `bundle_kind: bundle` /
`bundle_format: cursor`, so `scripts/verify/profiles.mjs` also asserts the repository root is
detected as a cursor-format bundle exposing a loadable `meerkat-taskpanel` skill.

**No hooks are shipped, deliberately.** Cursor's hook contract is its own schema (a lowercase
`sessionStart` key, a relative `command`, `additional_context` rather than Claude Code's
`hookSpecificOutput.additionalContext`), and upstream documents no uninstall or update path
to follow — so rather than invent one, the plugin stays skills-only.

**Unverified, and flagged as such.** Cursor's CLI is not installed in this repository's
container or on the development host, so the *agent integration* above has never been run from
here; the in-chat gesture is transcribed from `obra/superpowers` rather than reproduced.

## 9. OpenCode

OpenCode is a *directory-granular* agent kind: it is handed a skills directory, not a list of skill
names, so `.opencode/plugins/meerkat-taskpanel.js` points it at the repository's own
`skills/` and both skills arrive together. Nothing is copied — the directory is resolved from
the plugin's own location, so it follows the package wherever OpenCode fetched it.

```jsonc
// opencode.json — consumer-side registration (V2 >= 2.0.4; V1 uses the singular `plugin` key)
{
  "plugin": ["meerkat-taskpanel@git+https://github.com/tanyu216/meerkat-taskpanel.git"]
}
```

The plugin is dual-compatible: on V1 the named export pushes the directory into
`config.skills.paths`; on V2 `default.setup(ctx)` registers one `Skill.Info` per
`skills/<name>/SKILL.md`, because V2 dropped the directory form and made `config.skills` a
flat array.

OpenCode is **not** a version carrier and ships no manifest of its own — like Codex, it
appears in neither the table in §1 nor a bundle directory of its own.
`package.json#files` must still name `.opencode`, or the plugin never reaches the tarball.

**Unverified, and flagged as such.** OpenCode's CLI is not installed in this repository's
container or on the development host, so the agent integration above has never been run from
here. What *is* covered is the plugin's own logic:
`test/install/opencode-plugin.test.mjs` drives it against a fake plugin context.

## 10. Skill wrappers ship with the bundle

Every manifest points at the repository's one `skills/` tree, so the npm whitelist ships the
skills directly and no bundle carries a generated copy of its own (see
[development.md](development.md#the-skill-is-generated-never-hand-edited)). A publish is
still only correct if `node scripts/sync-skills.mjs --check` is green: the loop skill's
generated payload (`manifest.txt` + `scripts/` + `src/` + `templates/`) must match the
repository modules it is generated from.

The `files` whitelist must also name each dot-directory the plugins live in
(`.claude-plugin`, `.cursor-plugin`, `.opencode`, `.pi`): npm does not include dot files by
default, so a manifest that is not listed never reaches the tarball, and
`node scripts/release/pack-manifest.mjs` fails the release on it.

## See also

- [install.md](install.md) — the per-agent-kind install and plugin-registration commands in full.
- [development.md](development.md) — the two build layers, the offline policy and the
  generated-skill rule.
- [`../README.md`](../README.md) / [`../README.zh-CN.md`](../README.zh-CN.md) — status and
  the six-agent-kind support matrix.
