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

`scripts/verify/version.mjs` checks that the six agree; it is wired into CI, so a drifting
version fails the build rather than shipping. Run it locally before tagging:

```bash
node scripts/verify/version.mjs
```

Bump all six to the same value **in one commit**, then let CI confirm.

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

## 3. Git tag + GitHub Release

The release pipeline is **tag-driven**: `.github/workflows/release.yml` runs on
`push` of a tag matching `v*`. It re-runs the checks, builds the release tree
(`node scripts/build.mjs`) and performs a packaging run. It does **not** publish anywhere
automatically — a release ends as a GitHub Release **draft** for a human to review and
publish.

The workflow file is authoritative for the exact steps and the Node version it pins; read
it before cutting a release rather than relying on this summary.

```bash
# Run by Elon — not part of the document
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
compares the live surface — routes, error codes, wire field names and types, and each
MCP tool's `inputSchema` (type/enum/items) — against
`test/fixtures/contract/api.snapshot.json`; a change to any of them without a
snapshot update is a non-zero exit. `version-gate.yml` runs it at tag time, and
`.github/workflows/contract-gate.yml` runs it on every branch push and pull request.
The full story, and the `--update` workflow, is in [contract.md](contract.md).

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
