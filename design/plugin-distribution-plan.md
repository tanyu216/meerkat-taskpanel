# Plugin distribution plan — one skills tree, every harness

**Card:** `T-20261015-035514` (doc-only; no implementation in this card)
**Reference:** [`obra/superpowers`](https://github.com/obra/superpowers) @ `bb92a77741419a4ab5f06e711a283343f1ada0c3` (v7.0.0, shallow clone, 2026-10-15)
**Author:** linus · **Audience:** Elon (review) → operator (architecture sign-off) → implementation card

---

## 摘要（中文，结论先行）

1. **superpowers 不是靠符号链接**：整仓 **0 个符号链接**，只有 **1 个 `skills/` 目录**（74 文件 / 15 个 skill）。它靠的是「**每个 harness 的 manifest 都住在仓库根**，各自把 skills 指向同一个 `./skills/`」——Claude/Cursor/Codex 走 manifest 字段或被约定自动发现，opencode/pi 走**运行期注册**（插件代码里 `resolve(__dirname, '../../skills')` 把同一个目录注册给宿主）。它是 **plugin/package 分发**，不是 symlink/单目录挂载。
2. **它仍有的边界**（README 原文）：`README.md:54` — "Installation differs by harness. If you use more than one, install Superpowers separately for each one." 即**一份源码，但每个 harness 仍要各装一次**；且 Codex 一路甚至是 `scripts/sync-to-codex-plugin.sh` 往**另一个 fork 仓 rsync** 的镜像。"单一源"省掉的是**仓内的重复副本**，不是宿主侧的安装次数。
3. **本仓的重复面是 `plugins/*/skills/`**：6 个 `skills` 目录（superpowers 是 1），**128 个文件 / 1,436,708 字节**的已提交副本，而源只有 32 文件 / 359,177 字节（板卡 4×、loop 4×）。根因是「每个 host 一个 plugin 根」，`sync-skills.mjs` 存在的唯一作用就是给这 5 个 plugin 根填 `skills/`。
4. **`install.sh` 那一路本来就已经是单一源**（`src="$(repo_root)/skills/$skill"`），宿主侧 `~/.claude/skills` 等副本**不在本次可削减范围内**——superpowers 也做不到。
5. **目标方案**：把 claude/codex 的 plugin 根上提到仓库根（`plugins/claude/`、`plugins/codex/` 整体消亡），pi 走根 `package.json` 的 `pi` 字段，opencode/cursor 新增且**从第一天起零副本**。可削减 **128 → 32 文件**（−75%）；剩下 32 = openclaw 8 + loop bundle 24，是当前「marketplace 必须把 loop 单独列成一个插件」形状下的**地板**。
6. **需 Elon 裁定 4 项**（§7）：opencode/cursor 是否也拿 loop；loop 独立 marketplace 条目是否保留（值 24 文件）；pi 走根 package 还是保留 `plugins/pi`；以及是否承认宿主侧副本不在范围内。
7. 无与硬约束冲突处 ⇒ **未触发停手线**。

---

## ① How superpowers shares one skills tree across harnesses

### 1.1 The mechanism, stated precisely

It is **plugin / package distribution over one committed `skills/` tree at the repository
root**. It is *not* a symlink farm and *not* a single-directory mount. Two commands settle it:

```console
$ git -C <clone> rev-parse HEAD
bb92a77741419a4ab5f06e711a283343f1ada0c3

$ find <clone> -type l -not -path '*/.git/*' | wc -l
0                                  # ← zero symlinks, anywhere

$ find <clone> -type d -name skills -not -path '*/.git/*'
<clone>/skills                     # ← exactly one skills tree

$ find <clone>/skills -type f | wc -l
74
```

Every harness's entry point lives **at the repo root** (as a per-harness dot-directory or a
root manifest) and points *at that one tree*:

| Harness | Entry point (repo-root-relative) | How it reaches the one `skills/` | Evidence |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | no `skills` key at all — the harness auto-discovers `skills/` **at the plugin root**, and the plugin root is the repo root | `.claude-plugin/marketplace.json:13` → `"source": "./"`; porting doc `docs/porting-to-a-new-harness.md:238-241` |
| Cursor | `.cursor-plugin/plugin.json` | explicit `"skills": "./skills/"` (relative to the plugin root = repo root) | `.cursor-plugin/plugin.json:21` |
| Codex | `.codex-plugin/plugin.json` | explicit `"skills": "./skills/"` | `.codex-plugin/plugin.json:23` |
| pi | repo-root `package.json` | `pi.skills: ["./skills"]` (+ `pi.extensions`), declared in the **root package** | `package.json:15-22` |
| OpenCode | `.opencode/plugins/superpowers.js` | **runtime registration** — `const superpowersSkillsDir = path.resolve(__dirname, '../../skills')` = `<repo>/skills`; V1 pushes it into `config.skills.paths`, V2 registers each `skills/<name>/SKILL.md` via `ctx.skill.transform(draft => draft.add(...))` | `.opencode/plugins/superpowers.js:25`, `:223-232`, `:294-330` |
| pi (extension) | `.pi/extensions/superpowers.ts` | `const skillsDir = resolve(packageRoot, "skills")` then `pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }))` | `.pi/extensions/superpowers.ts:10-11`, `:19-21` |

**The load-bearing fact** is the marketplace source, `.claude-plugin/marketplace.json:13`:

```json
{ "name": "superpowers", "source": "./" }
```

The plugin root *is* the repository root. That is what removes the need for a per-harness
`skills/` directory: there is nothing to copy into, because every harness's manifest already
sits next to the one tree.

**The two mechanisms are different, and only the second is copy-free.** For Claude / Cursor /
Codex the harness's own installer reads `./skills/` **out of the plugin source** (git URL or
marketplace entry) and installs it into its own store. For OpenCode / pi the plugin is a
**code module** that resolves the skills directory *in place* at runtime — those two never
copy the tree at all (`.opencode/plugins/superpowers.js:25`,
`.pi/extensions/superpowers.ts:11`).

### 1.2 superpowers abandoned symlinks — on purpose

OpenCode's install doc keeps the migration as documentation
(`.opencode/INSTALL.md:44-57`):

> ## Migrating from the old symlink-based install
> If you previously installed superpowers using `git clone` and symlinks, remove the old setup:
> ```bash
> rm -f ~/.config/opencode/plugins/superpowers.js
> rm -rf ~/.config/opencode/skills/superpowers
> rm -rf ~/.config/opencode/superpowers
> # Remove skills.paths from opencode.json if you added one for superpowers
> ```

The porting guide keeps symlinks as a **last-resort staging trick only** — and warns that a
`skills` path field "is *not* portable", that a co-located `skills/` beside `plugin.json` may
be the *only* thing a harness scans, and that a symlinked staging dir must be **proved** to be
dereferenced by the installer (`docs/porting-to-a-new-harness.md:477-486`).

This matters here: **the recommended design below is not a symlink design.** It is the same
shape superpowers ships.

### 1.3 The boundary, in superpowers' own words

"One plugin, many harnesses" does **not** mean one installation. Quoted verbatim:

- `README.md:54` — *"Installation differs by harness. If you use more than one, install
  Superpowers separately for each one."*
- `.opencode/INSTALL.md:41-42` — *"OpenCode uses its own plugin install. If you also use
  Claude Code, Codex, or another harness, install Superpowers separately for each one."*
- `README.md:226-227` — *"OpenCode uses its own plugin install; install Superpowers separately
  even if you already use it in another harness."*
- `README.md:283` — *"…native Muse plugin — same repo, same skills, all harnesses."* (a
  statement about the **repo**, paired with "Install from a local checkout" right below).

And the distribution table (porting doc Part 6, `…:686-692`) shows the plumbing is still
per-channel — Claude Code via marketplace, Gemini/Kimi/OpenCode via git URL, pi via
package-manifest fields, Antigravity via `agy plugin install`. One channel is literally a
mirror: `scripts/sync-to-codex-plugin.sh:5-9` clones the fork
`prime-radiant-inc/openai-codex-plugins`, `rsync`s the tracked plugin content into
`plugins/superpowers`, and opens a PR.

**So the honest reading of Terry's request:** superpowers' win is *zero in-repo duplication*,
not *one installation per machine*. The per-harness install step is irreducible — every
harness has its own installer, and superpowers says so twice. What this plan can remove is
`plugins/*/skills/`.

---

## ② Current state: exactly how much is duplicated, and where

### 2.1 Committed, in-repo: five generated copies of two skills

`find . -type d -name skills` in this repo returns **six** directories — one source, five
generated:

```
./skills                     ← source of truth
./plugins/claude/skills      ← generated
./plugins/codex/skills       ← generated
./plugins/pi/skills          ← generated
./plugins/openclaw/skills    ← generated
./plugins/loop/skills        ← generated (the marketplace's loop-only bundle)
```

| Copy | Files | Bytes | Content | Source |
|---|---:|---:|---|---|
| `skills/` (source) | 32 | 359,177 | board (8 files / 129,007 B) + loop (24 files / 230,170 B) | — |
| `plugins/claude/skills` | 32 | 359,177 | board + loop | identical bytes |
| `plugins/codex/skills` | 32 | 359,177 | board + loop | identical bytes |
| `plugins/pi/skills` | 32 | 359,177 | board + loop | identical bytes |
| `plugins/openclaw/skills` | 8 | 129,007 | board only | identical bytes |
| `plugins/loop/skills` | 24 | 230,170 | loop only | identical bytes |

**Duplication cost: 128 files / 1,436,708 bytes of committed copies** for a 32-file /
359,177-byte source — 4.0× replication of the board skill and 4.0× of the loop skill
(4 copies each: claude, codex, pi, + openclaw/loop respectively). Verified equality is not
assumed; it is the `--check` contract (§2.2).

### 2.2 The generating mechanism — `scripts/sync-skills.mjs`

- Distribution table: `SKILL_HOSTS = { "meerkat-taskpanel": [claude, codex, openclaw, pi],
  "meerkat-loop": [claude, codex, pi] }` (`scripts/sync-skills.mjs:43-46`) and
  `SKILL_BUNDLES = { "meerkat-loop": ["loop"] }` (`:55-57`). OpenClaw is excluded from the
  loop on purpose (ruling O3 — it runs openclaw-team's own poll/patrol).
- Write path: `rm -rf dest` → `cp -R source dest` → re-compare (`:216-220`).
- Check path (`--check`): byte-compare via `compareDirs` — reports `missing` / `extra` /
  `differing` (`:135-159`, `:210-213`).
- It is **both** the generator and the verifier, wired to `npm run sync:skills` /
  `npm run check:skills` (`package.json:36-37`), and `npm run check` runs `check:skills`
  first (`package.json:43`).

Commands and current readings:

```console
$ node scripts/sync-skills.mjs --check    # exit 0
$ npm run check:skills                    # exit 0 — all five copies byte-identical
```

The loop payload has a **second** generation step in front of the same check:
`scripts/sync-loop.mjs` writes `skills/meerkat-loop/{body,templates}` *from* the repo's own
`scripts/supervisor.mjs`, `scripts/wake-cwd.mjs`, `src/shared/**` and
`scripts/install/templates/**`. So `--check` guards two different directions: generated
**into** the source tree (loop payload), and copied **out of** it (plugin copies).

### 2.3 A correction to the handoff's reading of `templates/{claude,codex,pi}`

The handoff (and the card's Background) names `skills/meerkat-loop/templates/{claude,codex,pi}`
as "即 Terry 所指的「重复 copy」面". **That is not duplication.** The three files are
*different* — one per host CLI — and they are themselves generated (from
`scripts/install/templates/`, by `sync-loop.mjs`):

```console
$ wc -c skills/meerkat-loop/templates/{claude/wake-claude.sh,codex/wake-codex.sh,pi/wake-pi.sh}
    2879 …/claude/wake-claude.sh
    2826 …/codex/wake-codex.sh
    2642 …/pi/wake-pi.sh
```

They differ where they must: `claude -p … [--resume <sid>]` vs `codex exec …` vs
`pi --print`. Three harnesses, three wake commands, three files — not one file copied three
times. The real duplication face is `plugins/*/skills/` (§2.1).

### 2.4 The host-side mechanism — `install.sh` (already single-source)

`install.sh` copies **from `skills/` directly**, never from `plugins/`:

```bash
src="$(repo_root)/skills/$skill"                     # scripts/install/_common.sh:572
dest="$target_home/$host_dir/skills/$skill"          # :574
… cp -R "$src" "$dest"   (or ln -s with --link)      # :608-613
```

| Host | `--target` | Board skill lands at | Loop skill lands at |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/meerkat-taskpanel` | `~/.claude/skills/meerkat-loop` |
| Codex | `codex` | `~/.codex/skills/meerkat-taskpanel` | `~/.codex/skills/meerkat-loop` |
| Pi / Agent Skills | `pi` | `~/.agents/skills/meerkat-taskpanel` | `~/.agents/skills/meerkat-loop` |
| OpenClaw | `openclaw` | `~/.openclaw/skills/meerkat-taskpanel` | **none**, permanently (O3) |

(`install.sh:112-124` usage text; `docs/install.md:53-58`.)

Behaviour worth noting for the plan:

- **Idempotent, never clobbering**: an existing destination is left alone and reported
  unchanged; `--force` is the only overwrite (`_common.sh:596-604`).
- **`--link` names the board skill only** (`_common.sh:576-580`): the loop is *always* a real
  copy, because a symlinked loop "would put the checkout back into the load path of the very
  thing the split exists to make independent of it."
- **`install.sh` is therefore unaffected by anything in §3** — it never reads `plugins/`.
  This is the single most important compatibility fact in this plan.

### 2.5 Drift risk, honestly scored

| Risk | Today | After §3 |
|---|---|---|
| A copy edited by hand instead of the source | caught, but only at `npm run check` / CI — **`pre-commit` runs only `scripts/verify/migrations.mjs`, not `check:skills`** (`.githooks/pre-commit`) | **eliminated** for the removed copies |
| `sync:skills` forgotten after editing `skills/**` | red CI, 5 dirs × N files of noise to re-review | smaller surface, then none |
| A copy diverges without anyone noticing | impossible — byte-compare is exact | n/a |
| Reviewers must read the same SKILL.md 4× in a diff | yes (1.44 MB of the tree) | −75% |
| The five copies are architecturally load-bearing | yes: each exists only to satisfy "a plugin root needs a sibling `skills/`" | removed for claude/codex/pi |

---

## ③ Target architecture

### 3.1 The principle, taken from superpowers

> **One committed `skills/` tree. Every harness manifest lives at the repository root and
> points at it. No committed per-harness `skills/` copy.**

The only thing standing between this repo and that shape is that `plugins/<host>/` is used as
the *plugin root*, so each one needs a `skills/` beside it. Move the plugin root up to the
repository root and the copies stop being necessary.

### 3.2 Target layout

```
                       BEFORE                                     AFTER
skills/            board + loop (source)                 skills/            board + loop (source)   ← unchanged, still THE source
.claude-plugin/    marketplace.json                      .claude-plugin/    marketplace.json  (source: "./" for the board)
                                                                           plugin.json       ← NEW: the board plugin, root = repo root
                                                       .codex-plugin/      plugin.json       ← NEW
                                                       .cursor-plugin/     plugin.json       ← NEW (§4)
                                                       .opencode/plugins/  meerkat-taskpanel.js ← NEW (§4)
plugins/claude/    .claude-plugin/plugin.json           ← DELETED (skills/ and manifest both go)
                 └─ skills/  (32 files)                  ← DELETED
plugins/codex/     .codex-plugin/plugin.json             ← DELETED
                 └─ skills/  (32 files)                  ← DELETED
plugins/pi/        package.json                          ← DELETED if root package.json carries `pi`
                 └─ skills/  (32 files)                  ← DELETED
plugins/openclaw/  openclaw.plugin.json                  ← KEPT (taskpanel-only harness; native manifest)
                 └─ skills/  (8 files)                   ← KEPT — floor
plugins/loop/      .claude-plugin/plugin.json            ← KEPT (marketplace needs loop standalone)
                 └─ skills/  (24 files)                  ← KEPT — floor
```

**Net: 128 committed copy-files → 32** (−75%, −1.08 MB). `install.sh` and every on-host
destination are untouched.

### 3.3 Why each residual copy is a floor, not laziness

- **`plugins/loop/skills/meerkat-loop` (24 files)** — the marketplace must be able to install
  the loop *alone*; a plugin's skills come from a directory under its own root, so the
  loop-only plugin needs the loop under its root. Installing the board plugin and getting the
  loop as a side-effect is exactly what `T-20261012-163500-loopdecouple-b` fixed. **Dropping
  the standalone `meerkat-loop` marketplace entry is the only way to zero** (§7 decision 2).
- **`plugins/openclaw/skills/meerkat-taskpanel` (8 files)** — OpenClaw is a taskpanel-only
  harness with no superpowers analogue. Note that today OpenClaw actually installs the
  **Claude-format bundle**: `openclaw plugins install "$PWD/plugins/claude"` (`docs/install.md:422`,
  `scripts/verify/host-cli.mjs:50`). Under §3.4 that call becomes
  `openclaw plugins install "$PWD"` — the root becomes a Claude-format bundle — which lets
  `plugins/claude/` disappear entirely. `plugins/openclaw/openclaw.plugin.json` stays because
  `scripts/verify/profiles.mjs`/`lib/bundle.mjs` assert its **native** classification
  (`HOST_BUNDLES.openclaw = { openclawKind: "native" }`, `scripts/verify/lib/bundle.mjs:80-85`).

### 3.4 Migration — staged, each stage independently revertible

Each stage is a separate commit. Each ends with a green gate and a working install path; no
stage leaves the repo in a half-moved state.

---

#### Stage 0 — baseline (no change)

```bash
git status --porcelain                 # judgement: empty
node scripts/sync-skills.mjs --check   # judgement: exit 0
npm run verify                         # judgement: exit 0
```

Record the numbers in §2.1 as the "before" reading for the final diff.

---

#### Stage 1 — the repository root becomes the Claude/Codex plugin root

*Removes 64 files / 718,354 bytes.*

**S1.1** Add `plugins/claude/.claude-plugin/plugin.json` → `.claude-plugin/plugin.json`
(content unchanged; the plugin root simply moves up one level).

```bash
git mv plugins/claude/.claude-plugin/plugin.json .claude-plugin/plugin.json
# judgement: node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json"))' → exit 0
```

**S1.2** Add `.codex-plugin/plugin.json` at the root, same content as the current
`plugins/codex/.codex-plugin/plugin.json`.

```bash
mkdir -p .codex-plugin && git mv plugins/codex/.codex-plugin/plugin.json .codex-plugin/plugin.json
```

**S1.3** Point the marketplace at the root:

```jsonc
// .claude-plugin/marketplace.json
"plugins": [
  { "name": "meerkat-taskpanel", "source": "./",  … },   // was "./plugins/claude"
  { "name": "meerkat-loop",      "source": "./plugins/loop", … }   // unchanged
]
```

```bash
node -e 'const m=require("./.claude-plugin/marketplace.json");console.log(m.plugins.map(p=>p.name+" -> "+p.source).join("\n"))'
# judgement: meerkat-taskpanel -> ./   /   meerkat-loop -> ./plugins/loop
```

**S1.4** Delete the two skill copies and the now-empty plugin dirs.

```bash
git rm -r plugins/claude plugins/codex
# judgement: find . -type d -name skills -not -path './.git/*' → 4 entries (root, openclaw, loop, …)
```

**S1.5** Re-point the OpenClaw bundle install at the root
(`docs/install.md:422`, `scripts/verify/host-cli.mjs:50`):

```
openclaw plugins install "$PWD" --force --accept-capabilities
openclaw plugins inspect meerkat-taskpanel
# judgement: stdout contains "Format: bundle" and "Bundle format: claude"
```

**S1.6** Update every gate that names the moved paths — see §3.6 for the full list. Minimum for
this stage: `scripts/verify/version.mjs:59-60`, `scripts/verify/manifests.mjs:29,44`,
`scripts/verify/lib/bundle.mjs:70-77`, `scripts/release/pack-manifest.mjs:41-42`,
`test/scaffold.test.mjs:62-63`, `docs/install.md`.

**Stage 1 judgement (all must hold):**

```bash
node scripts/verify/manifests.mjs        # exit 0
node scripts/verify/version.mjs          # exit 0 — 8 version carriers agree
npm run check                            # exit 0
claude plugin validate "$PWD"            # exit 0 (needs the claude CLI)
```

> **Not verified in this card**: whether Claude Code's plugin installer *copies* only
> recognized components (skills/hooks/commands/…) out of the repo root, or the whole tree.
> The porting guide asserts installers copy only components they know
> (`docs/porting-to-a-new-harness.md:695-699`), and superpowers' root carries `docs/`,
> `scripts/`, `tests/`, `assets/` without trouble — but this repo's root is much heavier
> (`src/`, `web/`, `docker/`, `test/`, `design/`, `monitoring/`). **This is the one real risk
> in Stage 1 and it is cheap to check first:** install the plugin into a scratch HOME and
> count what landed.
> ```bash
> HOME=$(mktemp -d) claude plugin marketplace add "$PWD" && HOME=$(mktemp -d) claude plugin install …
> ```
> If it copies the whole tree, fall back to **Stage 1′** (§3.7).

---

#### Stage 2 — pi via the root package manifest

*Removes a further 32 files / 359,177 bytes.*

superpowers declares pi entirely in the **root** `package.json` (`package.json:15-22`,
`pi.skills: ["./skills"]`) — no `plugins/pi` at all.

```jsonc
// package.json (root) — additive metadata only, no dependency
"pi": { "skills": ["./skills"] }
```

then `git rm -r plugins/pi` and drop `pi` from `scripts/verify/{manifests,version}.mjs` and
`scripts/verify/lib/bundle.mjs`.

**Judgement:**

```bash
pi install .            # judgement: `pi list` names the package and a skill resolves
```

**Trade-off to weigh (§7 decision 3):** the root package is the **taskctl CLI** npm package
(`bin`, `workspaces: ["web"]`, `files: [...]`, `engines`). Pointing pi at it conflates "the CLI
package" with "the pi plugin package". Today's `plugins/pi/package.json` is `private: true`
with `files: ["skills"]` — deliberately minimal. If pi's package resolution cannot be confined
to the skills field, **keep `plugins/pi` and accept its 32-file copy**; Stage 2 is optional and
Stage 1 + Stage 3 stand without it.

---

#### Stage 3 — confirm the floor

No code change. Assert the target state so it cannot silently regress:

```bash
find . -type d -name skills -not -path './.git/*' | sort
# judgement (post Stage 1+2, pre Stage 4):
#   ./plugins/loop/skills
#   ./plugins/openclaw/skills
#   ./skills
```

```bash
find plugins -type f | wc -l
# judgement: 35   (openclaw 1 manifest + 8 skill files;  loop 2 manifests + 24 skill files)
# before any stage: 134
```

---

#### Stage 4 — retire the generation of copies (sequencing note, not a step this plan performs)

`sync-skills.mjs` keeps two jobs: `SKILL_HOSTS`/`SKILL_BUNDLES` still describe the two floor
copies, and `SKILL_BUNDLES` is what makes the loop bundle exist. After Stage 1–3 the write
set shrinks to `plugins/loop/skills` and `plugins/openclaw/skills`, and `SKILL_HOSTS` becomes
a **manifest** table rather than a copy table. **No new abstraction should be invented**; the
existing table simply describes fewer rows. `scripts/build.mjs:23,49` (`syncSkills({ … baseDir: dist })`)
keeps working unchanged, because it syncs into `dist/`, which is gitignored — the release tree
still gets its copies.

### 3.5 Compatibility & rollback

| Concern | Answer |
|---|---|
| `install.sh` / host destinations | **Untouched.** `install.sh` reads `skills/` directly (`_common.sh:572`); it never looks at `plugins/`. Every `~/.claude/skills/…`, `~/.codex/skills/…`, `~/.agents/skills/…` path in `docs/install.md:53-58` is unchanged. |
| Already-installed users | Unaffected. A plugin already installed into `~/.claude/plugins/…` keeps its own copy; the repo move only changes *future* installs. |
| `--link` semantics / O6 | Untouched. The board-only-link / loop-always-copy rule (`_common.sh:576-580`) is orthogonal to where the plugin root lives. |
| `.claude-plugin/marketplace.json` consumers | Codex reads the same marketplace manifest (`docs/install.md:60-62`). Both `source` values are checked in Stage 1. |
| Old marketplace refs | A user who has `meerkat-taskpanel-marketplace` registered must re-run `claude plugin marketplace add "$PWD"` to pick up `source: "./"`. Document it in `docs/install.md`. |
| **Rollback** | Every stage is a commit of **tracked** paths only. `git revert <stage-sha>` restores the tree byte-for-byte, and `node scripts/sync-skills.mjs` regenerates the copies from the unchanged source. **No irreversible step exists in Stages 0–3.** The only irreversible action would be *publishing* a release on top of a stage and then having users install it — so **do not tag between stages**; land all stages, then release. |
| Windows / symlinks | Not used anywhere in this plan (§1.2). |

### 3.6 Gate impact — the full surface

Every one of these reads a path that Stage 1–2 moves. This list is the execution checklist for
whichever implementation card picks this up.

| File | What it asserts | Change |
|---|---|---|
| `scripts/sync-skills.mjs:43-57` | `SKILL_HOSTS`, `SKILL_BUNDLES` | shrink to the two floor rows; keep `DEFAULT_HOSTS` consumers happy |
| `scripts/build.mjs:23,49,59` | syncs copies into `dist/plugins/<target>/skills/<skill>` | works unchanged; re-verify the summary line |
| `scripts/verify/manifests.mjs:26-104` | 6 manifest specs w/ required keys | claude/codex paths → `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` at root; delete the pi spec if Stage 2 |
| `scripts/verify/version.mjs:58-73` | **8 version carriers** must agree | re-path claude/codex; drop pi if Stage 2. **A carrier that is not re-pathed silently ships a stale version** |
| `scripts/verify/lib/bundle.mjs:69-92` | `HOST_BUNDLES[*].dir` + `openclawKind`/`openclawFormat` | `claude.dir`/`codex.dir` → `.`; `pi` row drops if Stage 2; **`openclaw` stays `native`** |
| `scripts/verify/host-cli.mjs:50,89-92` | openclaw installs `plugins/claude`; pi installs `plugins/pi` | openclaw → `$ROOT`; pi probe drops if Stage 2 |
| `scripts/verify/profiles.mjs` | per-host bundle recognizability | follows `bundle.mjs` |
| `scripts/release/pack-manifest.mjs:31-44` | npm tarball must contain the host manifests | re-path; drop `plugins/pi/package.json` if Stage 2 |
| `test/scaffold.test.mjs:62-65,116-124` | manifest paths, `SKILL_HOSTS`, `SKILL_BUNDLES`, `skillTargets()` order | update the expected rows |
| `test/skill/loop.test.mjs:150` | `SKILL_HOSTS[meerkat-loop] === ["claude","codex","pi"]` | follows the new table |
| `.githooks/pre-commit` | migrations only | **no change** — note it never ran `check:skills`, so a mid-migration red lands at `npm run check`/CI, not at commit time |
| `docs/install.md:53-58,384-460` | destination table + per-host install/uninstall blocks | re-path the plugin source; add the marketplace re-add note |
| `CLAUDE.md` (Repository layout) | describes `plugins/<host>/` | update after the plan lands |

### 3.7 Fallback: Stage 1′ (if a root plugin root copies the whole tree)

If the scratch-HOME check in Stage 1 shows Claude Code copying the entire repository, keep the
plugin roots where they are and use superpowers' own **generated-staging** shape instead: build
`plugins/claude/` at release time into `dist/` (gitignored) rather than committing it, the way
`scripts/build.mjs:49` already does for the npm tree. The committed repo then has **zero**
`plugins/claude` copy, and the marketplace source becomes the published artifact. Cost: the
marketplace can no longer be registered from a bare git checkout. **Prefer Stage 1; take 1′
only on evidence.**

---

## ④ New support: OpenCode and Cursor

**Both are added with zero committed copies**, per the rule that a new harness must not add a
new `skills/` directory. Both take superpowers' shape directly.

### 4.1 OpenCode

**Convention.** OpenCode has **no manifest field that names a skills directory**. Skills are
registered either by the in-process plugin API or by `opencode.json`'s own `skills.paths`.
superpowers registers at runtime (`.opencode/plugins/superpowers.js`):

| Version | Registration | Hook for the bootstrap |
|---|---|---|
| V1 (`opencode` 1.x) | `config` hook → `config.skills.paths.push(<abs dir>)` (`.opencode/plugins/superpowers.js:223-232`) | `experimental.chat.messages.transform` |
| V2 (`opencode` ≥ 2.0.4) | `setup(ctx)` → `ctx.skill.transform(draft => draft.add({id, name, description, path, content}))`, one `add` per `skills/<name>/SKILL.md` (`:286-330`) | `ctx.session.hook("context")` |

**Our entry point:** `.opencode/plugins/meerkat-taskpanel.js` at the repo root, resolving
`resolve(__dirname, "../../skills")` — **the same `skills/` tree, read in place, nothing
copied.**

**Install / uninstall / update:**

```bash
# install — V1
#   opencode.json: { "plugin":  ["meerkat-taskpanel@git+https://github.com/tanyu216/meerkat-taskpanel.git"] }
# install — V2 (>= 2.0.4)
#   opencode.json: { "plugins": ["meerkat-taskpanel@git+https://github.com/tanyu216/meerkat-taskpanel.git"] }

opencode run --standalone --print-logs "hello" 2>&1 | grep -i meerkat   # judgement: plugin lines present
# uninstall: remove the entry from opencode.json
# update:    restart opencode; if the resolved git dep is pinned in a lockfile/cache, clear
#            the cache (or pin explicitly with #vX.Y.Z)
```

**Risks (all with a superpowers precedent):**

1. **V1 registration is directory-granular.** `config.skills.paths` takes a *parent* directory
   and registers every `<name>/SKILL.md` under it — so pointing at `<repo>/skills` registers
   **both** the board and the loop. V1 cannot express "board only". V2's per-skill `draft.add()`
   can. **Decision needed (§7.1): does OpenCode get the loop?**
2. **Lockfile / cache pinning.** `.opencode/INSTALL.md:70-75` — "Some OpenCode and Bun versions
   pin that resolved git dependency in a lockfile or cache, so a restart may not pick up the
   newest Superpowers commit." A stale skills tree is a silent failure; the mitigation is a
   documented cache-clear, or an explicit `#vX.Y.Z` pin.
3. **V2 rejects a direct JavaScript-file path** (`.opencode/INSTALL.md:31-33`) — only a
   directory or a package spec installs cleanly; discovered plugin symlinks remain supported.
4. **Windows installer issues** with `git+https` specs (`.opencode/INSTALL.md:99-129`). Our
   project's support bar should be stated explicitly rather than inherited by accident.

### 4.2 Cursor

**Convention.** Cursor uses a plugin directory at the plugin root, `.cursor-plugin/plugin.json`,
with a manifest-declared `skills` path and a **shell-hook** bootstrap. superpowers is the
reference (porting doc routing table, `docs/porting-to-a-new-harness.md:288-295`):

```jsonc
// .cursor-plugin/plugin.json (superpowers)
{ "name": "superpowers", "displayName": "Superpowers",
  "version": "7.0.0", "author": {…}, "homepage": …, "repository": …, "license": "MIT",
  "keywords": [...],
  "skills": "./skills/",                       // ← the one tree
  "hooks": "./hooks/hooks-cursor.json" }
```

Cursor's hook contract is **its own schema**, not Claude Code's
(`hooks/hooks-cursor.json:1-10`):

```json
{ "version": 1,
  "hooks": { "sessionStart": [ { "command": "./hooks/run-hook.cmd session-start" } ] } }
```

— lowercase `sessionStart` key, relative command, no `matcher`/`type`/`async`, no
`${..._PLUGIN_ROOT}` interpolation. The harness identifies itself via `CURSOR_PLUGIN_ROOT`, and
the JSON field Cursor reads is **`additional_context`** (snake_case), distinct from Claude
Code's `hookSpecificOutput.additionalContext` (`hooks/session-start:44-47,71-73`). Getting the
field wrong means the bootstrap silently never injects.

**Our entry point:** `.cursor-plugin/plugin.json` at the repo root with `"skills": "./skills/"`,
plus a `hooks/hooks-cursor.json` and a session-start script. **Zero copies.**

**Install / uninstall / update:**

```text
install   — in Cursor Agent chat:  /add-plugin meerkat-taskpanel
            or search the plugin marketplace
uninstall — ???  NOT DOCUMENTED in the superpowers reference
update    — ???  NOT DOCUMENTED in the superpowers reference
```

> **Unverified, and flagged as such.** superpowers' README documents only the install gesture
> for Cursor (`README.md:122-130`) and its porting appendix marks Cursor's distribution as
> "hand-authored". The uninstall/update path, and whether Cursor can install from a **local
> checkout** (needed for development), must be established empirically before the
> implementation card commits to a design — the porting guide's own method
> (`docs/porting-to-a-new-harness.md:191-206`): find an existing third-party Cursor plugin,
> read it; if still unclear, register a throwaway hook emitting a unique marker and prove the
> marker reaches the model without a tool call.

**Risks:**

1. **Same directory-granularity question as OpenCode** — `"skills": "./skills/"` exposes both
   skills.
2. **No hook exists in this repo for Cursor yet.** Claude's session-start injector is written
   by `install.sh` (`scripts/install/templates/claude/session-start.sh`, merged into
   `settings.json`). A Cursor port needs the analogue, as an install-shipped file — the
   porting guide forbids hand-editing the user's config
   (`docs/porting-to-a-new-harness.md:65-77`).
3. **The symlink fallback, if Cursor's plugin mechanism cannot be driven.** Adding
   `~/.cursor/.../skills -> <checkout>/skills` is the obvious fallback and the card asks for
   it. **Recommend against it**, on superpowers' own evidence (`.opencode/INSTALL.md:44-57`,
   §1.2) and on this repo's ruling O6 (`_common.sh:576-580`): a symlink puts the checkout back
   into the load path the loop/skill split exists to break, and it breaks on Windows and under
   any installer that does not dereference. If the fallback is needed, it must be
   **explicitly opt-in, documented as a development-only mode, and verified to dereference**
   (`docs/porting-to-a-new-harness.md:483-486`).

### 4.3 New-harness gate surface (for the implementation card)

Adding a harness touches, at minimum: `scripts/verify/manifests.mjs` (new manifest spec),
`scripts/verify/version.mjs` (**new version carrier** — a manifest not registered there ships
a stale version, per the porting guide Part 6), `scripts/verify/lib/bundle.mjs`
(`HOST_BUNDLES`), `scripts/verify/profiles.mjs`, `scripts/release/pack-manifest.mjs`,
`install.sh` `--target` parsing (`install.sh:346-361`) + a new `scripts/install/<host>.sh`,
`docs/install.md`, and `CLAUDE.md`. **`SKILL_HOSTS` gains no row** — that is the whole point.

---

## ⑤ Plan quality

### 5.1 Every step has a command and a judgement

§3.4 and §4.1/§4.2 carry them inline. Summary of the judgement commands:

| Step | Command | Judgement |
|---|---|---|
| Stage 0 | `node scripts/sync-skills.mjs --check` | exit 0 |
| S1.1/S1.2 | `node -e 'JSON.parse(require("fs").readFileSync(<p>))'` | exit 0 |
| S1.3 | print `name -> source` pairs | `meerkat-taskpanel -> ./` |
| S1.4 | `find . -type d -name skills -not -path './.git/*'` | 4 entries |
| S1.5 | `openclaw plugins inspect meerkat-taskpanel` | `Format: bundle`, `Bundle format: claude` |
| Stage 1 | `node scripts/verify/manifests.mjs` · `node scripts/verify/version.mjs` · `npm run check` · `claude plugin validate "$PWD"` | all exit 0 |
| Stage 2 | `pi install .` then `pi list` | skill resolves |
| Stage 3 | `find . -type d -name skills …` · `find plugins -type f \| wc -l` | 3 dirs · 41 |
| OpenCode | `opencode run --standalone --print-logs "hello" 2>&1 \| grep -i meerkat` | plugin lines present |
| Cursor | unique-marker test (porting doc `…:191-206`) | marker reaches the model with no tool call |

**Runs in the container.** Per `CLAUDE.md`, anything that *runs* goes through
`npm run verify:docker`; the static `node -e` / `find` judgements may run on the host.

### 5.2 Irreversible points and risks

| # | Item | Reversible? |
|---|---|---|
| R1 | Any stage's file moves | **Yes** — tracked paths, `git revert` |
| R2 | Publishing a tag on top of a stage | **No** — users install it. *Mitigation: land all stages, then release.* |
| R3 | Claude Code copying the whole repo root as the plugin source (§3.4) | Yes, but design-visible → **check with a scratch HOME before Stage 1** |
| R4 | A version carrier missed in `scripts/verify/version.mjs` | Yes, but **silent** — ships a stale version. Mitigated by the gate itself, if the carrier is re-pathed |
| R5 | OpenCode V1 registering both skills (no per-skill selection) | Yes, but a scope decision — §7.1 |
| R6 | Cursor install/uninstall/update path undocumented upstream | Yes — resolve **before** the implementation card, not during |
| R7 | pi conflating the CLI package with the plugin package | Yes — Stage 2 is optional (§7.3) |
| R8 | `pre-commit` does not run `check:skills` | Pre-existing; unchanged by this plan |

### 5.3 Acceptance checklist — "this plan has been implemented"

- [ ] `find . -type d -name skills -not -path './.git/*'` returns exactly **3**: `./skills`,
      `./plugins/loop/skills`, `./plugins/openclaw/skills`
- [ ] `find plugins -type f | wc -l` returns 35 (3 manifests + 32 copy files), down from 134
- [ ] `node scripts/sync-skills.mjs --check` → exit 0
- [ ] `npm run check` → exit 0
- [ ] `node scripts/verify/version.mjs` → exit 0, and the carrier list no longer names a
      deleted path
- [ ] `node scripts/verify/manifests.mjs` → exit 0
- [ ] `claude plugin validate "$PWD"` → exit 0
- [ ] `bash install.sh --target all --prefix <scratch> --dry-run` prints the **same**
      destination list as before the change (`install.sh` must be untouched)
- [ ] `openclaw plugins inspect meerkat-taskpanel` → `Format: bundle` / `Bundle format: claude`
- [ ] OpenCode: a session lists `meerkat-taskpanel` as a skill, and **no** `skills/` directory
      was created anywhere under the checkout
- [ ] Cursor: the bootstrap reaches the model with no tool call, proven by unique-marker
- [ ] `git log --oneline` shows one commit per stage, no tag between them

### 5.4 Plan-quality self-check (`guides/plan-quality.md`)

- **① Logical completeness** — each stage's inputs exist before it runs (S1.3 depends on
  S1.1/S1.2; the gates in S1.6 depend on S1.4 being complete). No step depends on a later step.
- **② Omission check** — each Acceptance line ①–⑧ maps to a section: ①→§1, ②→§2, ③→§3,
  ④→§4, ⑤→§5, ⑥→this card is doc-only (no file outside `design/**` is written), ⑦→§3.5 +
  the card's git rules, ⑧→the card's Report. §3.6 is the integration path for every moved
  artifact — no dead rows.
- **③ Quality** — reuse before inventing: the plan *deletes* code (`sync-skills` rows,
  two plugin dirs) and invents nothing. The one rejected alternative (symlinks) is rejected
  with upstream evidence (§1.2). A simpler option that was considered and **rejected**:
  leaving everything and only adding opencode/cursor — rejected because it would add two more
  `skills/` rows and grow the duplication that is the point of the card.
- **④ End-to-end path** — the vertical path here is
  `source skills/ → plugin manifest → harness installer → host store → model`. §3.4 states the
  upstream/downstream impact at every hop, and §3.6 enumerates every consumer of a moved path.
  `install.sh`'s hop is shown to be *unchanged* (§2.4), which is the side-effect check.
- **⑤ Test coverage** — the gates in §3.6 are the unit-level coverage; the scratch-HOME /
  scratch-prefix install exercises the integration path; §5.3 is the end-to-end checklist.
  The real branch/error path that must be covered is "a version carrier re-pathed but not the
  others" — `scripts/verify/version.mjs` fails on exactly that.
- **⑥ Todo check** — stage markers are consistent with the file lists: `[ADD]` S1.1/S1.2 +
  §4 manifests, `[MODIFY]` S1.3/S1.5/S1.6, `[DELETE]` S1.4/S2, no `[integration]` step
  depends on an unlisted file.

---

## ⑥ Boundary compliance (doc-only)

This card writes **one file**: `design/plugin-distribution-plan.md`. It does not modify
`install.sh`, `scripts/sync-skills.mjs`, `skills/**`, `install.sh`, `dist/**`, `team/**`, or
anything under `prototype/**`. Every command in this document that mutates the repository is
written for a **future implementation card**, and is marked as such by being inside §3/§4's
"the implementation card does" framing — none of them were run here.

Read-only research performed: a shallow clone of `obra/superpowers` to
`~/.openclaw/team/workspace/T-20261015-035514/superpowers-src` (outside the repository), and
reads of this repository. No agent CLI config directory was installed into or modified.

---

## ⑦ Decisions for Elon (before the implementation card is opened)

1. **Do OpenCode and Cursor get the loop skill?** Their plugin mechanisms take a *directory*,
   so `./skills/` hands them both skills. Yes ⇒ zero extra work. No ⇒ V2-style per-skill
   registration and a hook that filters (OpenCode V2 only; V1 cannot). Default recommendation:
   **yes** — the loop is host-external and both harnesses can be woken by the same scheduler,
   but this is a scope call, and OpenClaw's O3 exclusion shows this team does make such calls
   deliberately.
2. **Keep the standalone `meerkat-loop` marketplace entry?** It is the entire remaining 24-file
   copy. Keep ⇒ floor is 32 files. Drop ⇒ **0 committed copies**, but the loop can only be
   installed by `install.sh`, not by a marketplace install. Default recommendation: **keep** —
   the marketplace entry is how a Claude user gets the supervisor.
3. **Stage 2 (pi via root `package.json`)?** It works and removes 32 files, at the cost of
   conflating the CLI package with the pi plugin. Default recommendation: **attempt it and
   fall back to `plugins/pi` if pi's resolution is not isolatable** — it is independently
   revertible either way.
4. **Confirm the host-side copies are out of scope.** `~/.claude/skills/…` etc. stay. No
   harness lets a plugin install *not* land a copy in the host's store, and superpowers says so
   twice (§1.3). If Terry's expectation was "install once, used everywhere", this is the item
   where that expectation has to be re-set — the reachable win is the **repo**, not the host.

---

## ⑧ Evidence index

All superpowers citations are against `bb92a77741419a4ab5f06e711a283343f1ada0c3` (v7.0.0), a
shallow clone kept outside this repository.

**superpowers — mechanism (①):** `README.md:54`, `:122-130`, `:224-235`, `:283`, `:378`;
`.claude-plugin/plugin.json`; `.claude-plugin/marketplace.json:13`; `.cursor-plugin/plugin.json:21-22`;
`.codex-plugin/plugin.json:23-24`; `package.json:15-22`; `.opencode/plugins/superpowers.js:25,223-232,286-330`;
`.pi/extensions/superpowers.ts:10-11,19-21`; `hooks/hooks.json`; `hooks/hooks-cursor.json:1-10`;
`hooks/session-start:44-47,71-73`; `docs/porting-to-a-new-harness.md:36-55`, `:65-77`,
`:186-206`, `:236-241`, `:288-295`, `:477-486`, `:686-692`, `:695-699`;
`scripts/sync-to-codex-plugin.sh:5-9`; `.opencode/INSTALL.md:9-42`, `:44-57`, `:70-75`,
`:99-129`; `docs/README.opencode.md:1-54`.

**superpowers — measured:** `git rev-parse HEAD`; `find -type l | wc -l` → 0;
`find -type d -name skills` → 1; `find skills -type f | wc -l` → 74.

**this repository — current state (②):** `install.sh:112-124`, `:126-127`, `:346-361`;
`scripts/install/_common.sh:563-623`; `scripts/install/{claude,codex,pi,openclaw}.sh`;
`scripts/sync-skills.mjs:43-57`, `:101-159`, `:181-224`; `scripts/sync-loop.mjs:36-75`;
`scripts/build.mjs:23,49,59`; `package.json:19-30,36-47`; `.claude-plugin/marketplace.json`;
`plugins/{claude,codex,pi,openclaw,loop}/*`; `docs/install.md:53-58`, `:384-460`;
`.githooks/pre-commit`; `.githooks/pre-push`.

**this repository — gate surface (③):** `scripts/verify/manifests.mjs:26-104`;
`scripts/verify/version.mjs:58-73`; `scripts/verify/lib/bundle.mjs:69-92`;
`scripts/verify/host-cli.mjs:50,89-92`; `scripts/release/pack-manifest.mjs:31-44`;
`test/scaffold.test.mjs:62-65,95-124`; `test/skill/loop.test.mjs:150`.

**measured in this repository:** `find -type d -name skills` → 6; `find -type l | wc -l` → 0;
per-directory file counts and byte totals as tabulated in §2.1; `wc -c` on the three
`wake-*.sh` templates (§2.3).
