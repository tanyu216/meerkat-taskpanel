# UI alignment — the machine check (M1 · `ui-align` wiring)

Turns "the board looks like the prototype" into a runnable, countable assertion set.
The engine lives **outside this repository** (`~/.openclaw/team/tools/ui-align/`); this
directory plus `../.ui-align.json` is the project side — per that tool's README §7, a new
project is wired by writing exactly two things and changing no tool line.

| File | Role |
|---|---|
| `../.ui-align.json` | the project config — prototype root, dev server, the bilateral theme/locale agreement |
| `board.json` | the page manifest — the board main path, **full block list** (unimplemented blocks carried as `pending`) |
| `board-m2.json` | the M2 manifest — the same main path plus M2's target-state blocks; see §5 |
| `../scripts/ui-align-serve.mjs` | the implementation leg: the fixture harness on a port the engine names |

## 1. Run it

```bash
node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board
```

- `--json` for CI-shaped output; `--strict` promotes `pending` blocks from SKIP to failure
  (the flip switch for the day M2 lands the outstanding blocks).
- Exit codes: `0` all asserted checks green · `1` an assertion/overflow/console failure ·
  `2` environment or config (no browser, server won't start, manifest invalid).

**Which host.** This is a *browser-rendered frontend check*, so it runs on the host, not in
the container — `docs/docker.md` §"Host-allowed checks" ("browser-rendered frontend checks —
the DOM/selector contract assertions and the prototype-vs-implementation screenshots for
`web/`"): the image deliberately carries no Chromium because installing one needs an apt
mirror at build time. The engine finds the host Chrome by itself. Everything the check
*serves* is local and offline; nothing here installs, deploys or reaches the network.

### Baseline (2026-10-12, `main` @ `2aed9d8` + this card)

```
区块 12（断言 8 ｜ 待实现 4）· 断言 102 条 · 失败 0
溢出档位失败 0 ｜ console 失败档位 0            （1512 / 1240 / 980 / 760 / 430）
computed style 差异 51 / 断言 186（一致率 72.6%）← 非阻塞
待实现（SKIP，不计入失败）：B02-mark、B03-icons、B03-footer-text、B07-identity
```

The `72.6%` is the honest size of the M2 backlog, not a pass mark: the style leg is
non-blocking on purpose (`style.blocking: false`), the same call the tool ships with, so
that the check could be wired *before* the fidelity work rather than after it.

### How the two sides are booted

- **Prototype**: the engine's own static server over `prototypeRoot`. The prototype is a
  static page that boots at light/en from its own markup and switches by *click* — the
  engine cannot click, so the pinned pair is the one both sides already agree on.
- **Implementation**: `devServer` → `node scripts/ui-align-serve.mjs --port {port}`. That
  script is the **fixture harness** (`dom-smoke.mjs`: fixture API + `web/dist`) — the same
  data the DOM contract test drives. It is deliberately *not* Vite: Vite proxies `/api` at
  the real `taskd` on `:9527`, which would make the check depend on a second process and on
  whatever is in that board's database, and the tool wants the **offline state** (its README
  §3, last note). The fixture also means no build step and no database: the check is
  reproducible. `startServer()` grew an optional `{ port }` for this (default `0`, i.e. the
  previous behaviour, so the smoke and `shot-compare.mjs` are untouched).

### The bilateral theme/locale agreement (A1)

The two sides reach the same declared state by *different* mechanisms, so the config pins
both ends of the agreement:

| Side | Mechanism | Pinned to |
|---|---|---|
| Prototype | markup default; switches only by click | `data-theme="meerkat-taskpanel"`, `data-theme-mode="light"`, `lang="en"` |
| Implementation | `localStorage` read before first paint (`stores/prefs.js`) | `meerkat-taskpanel.theme=light`, `meerkat-taskpanel.lang=en` |

`theme: light` / `locale: en` / `localeTag: en` drive the engine's `prefers-color-scheme`
emulation and the seeded `localStorage`; `apply.htmlAttributes` carries **only `lang`**.
That is deliberate: the two codebases share the *word* `data-theme` but not its
**vocabulary** — the prototype/implementation write `meerkat-taskpanel` for light and `dark`
for dark, so a `data-theme="{theme}"` injection would put the prototype in an invalid state
in light mode. The run prints the measured pair for both sides
(`同 theme=meerkat-taskpanel / lang=en`); the engine warns loudly if they ever diverge.

> Non-default pairs (dark, zh) are **not** reachable through this config. The prototype's
> switch is click-only, and static attribute injection cannot express `light →
> "meerkat-taskpanel"`. Use `web/scripts/shot-compare.mjs`, which drives the prototype by
> click, for those pairs.

### Coupling to the `design/` migration

`prototypeRoot` points at **`../design/prototype`** — the path the repository already
declares at HEAD: `web/scripts/shot-compare.mjs:66` resolves
`resolve(WEB, "../design/prototype/index.html")` and `web/README.md:60` names the same
directory as the read-only baseline. The files themselves were still under `prototype/`
until the `design/` migration (`T-20261012-015317-3`) staged the rename
(`prototype/*` → `design/prototype/*`) mid-card; this config follows the declared
destination, so the check resolves both when the rename commits and where the rest of
`web/` already points. If that migration is reverted, this is the one line to change back
(`"prototypeRoot": "../prototype"`) — the manifest's `evidence` strings name the same file
under its post-migration path for the same reason. The M0 gap matrix and its
`proto-positions.txt` cite the **pre-migration** path `prototype/index.html` against frozen
blob `97918198ca57…` — the same file, renamed without content change.

## 2. Reconciliation with the M0 gap matrix (A4)

M0 (`T-20261012-015317`) produced the 8-block matrix, the prototype freeze and a **draft**
manifest (12 blocks / 108 checks). This manifest is that draft, **re-measured against the
tree it now runs on** — M0's implementation positions were taken at HEAD `176a777`, and the
web lane has since landed `5c420b7`, `956fe33`, `2aed9d8`.

Block count agrees 1:1 (8 contract blocks + the 4 pending blocks M0 derived from its own
"缺/简化/自创" rows). Check-level deltas — **2 semantic changes**, both forced by in-repo
decisions that landed after M0 measured:

| # | Block | Check | M0 draft | Here | Why |
|---|---|---|---|---|---|
| 1 | B03 | `[data-nav-item]` | `count 3` | `count 4` | M1 appended `waiting` (the 「等你回复」view). Adjudicated in-repo: `test/web/blocks.contract.mjs:125-132` (`DOMAINS.NAV`) and `:390` — "*M1 appends `waiting` — the one deliberate extension of this frozen baseline, approved with B03's count together (design §10-C6)*". The prototype side now has 4 too: `T-20261012-041728-2` added the 4th item to `design/prototype/index.html` plus its `nav.waiting` key (the card's ①). The two sides agree again. |
| 2 | B03 | `[data-states-open]` | `count 1` | `count 0` (reverse) | B18 (states gallery) is `prototype-only` by Terry's 2026-10-12 ruling (`blocks.contract.mjs:74-80`, B18 manual rule `:960-968`): the shipped app renders no gallery and no `[data-states-open]` opener. `2aed9d8` removed it. Asserting the absence pins the ruling against regression. |

Plus non-semantic edits: evidence paths re-pointed at `design/prototype/…`; `desc` strings
extended where a check deliberately asserts **presence only** while a glyph/geometry gap
stays open (B02 switcher icon, B03 theme icons, B09 attachments/activity, B07 identity);
the `[data-access-open]` wording finalized per Elon's ruling ③ (see §5).

`[data-empty-lg]` is **absent from this manifest on purpose** (Elon's ruling ②: the doc is
wrong, not the DOM — `design/prototype/index.html:503` has the *class* `td-empty-lg`, and
neither side has the attribute). The surface it stands for is asserted instead as
`[data-empty][data-empty-kind="no-results"]` in B05 — a real hook, not a documented one.

### Rows with no machine check (nothing silent)

M0's matrix has 82 rows; the six-word check vocabulary (`selector` / `scope` / `min|max|count`
/ `nonEmpty` / `desc`) cannot express all of them. Every uncovered row was *placed*, not
dropped:

| Reason | Rows | Where they are covered |
|---|---|---|
| **视觉/几何** — the hook is asserted present, the *shape* differs (SVG → glyph, `h2` → `span`, `dl` vs `div`, `hidden` wrapping, `aria-selected`) | B02 switcher icon · B06 progress `aria-hidden` · B06 column-name level · B07 agent avatar `hidden` · B07 `aria-selected` · B09 `[data-detail-props]` | `shot-compare.mjs` + human review (O7: structure + geometry, no pixel diff) — M2 |
| **交互态** — only exists after a click (drawer `closing`, language menu open, aria-expanded) | B09 `closing` · B03 `[data-lang-menu]` structure & clipping risk | `shot-compare.mjs`, which drives the prototype and the app |
| **数据驱动态** — needs a board state the fixture does not carry | B12 big empty state (Sentinel Watch mark) · B03 `[data-project-count]` on non-current rows · B09 attachment list & localized activity text | M2, with a fixture that renders the state; B12 is also out of Terry's ① scope |
| **文档口径** — the row was a documentation defect, not a DOM fact | `[data-empty-lg]` (Elon ②), `BLOCKS.md`'s stale header counts (`blocks.contract.mjs` `STALE_PROSE_COUNTS`) | `[data-empty-lg]` doc fix landed in `T-20261012-041728-2` (BLOCKS.md B12 now describes the shipped markup); the `BLOCKS.md` header counts stay tracked on the M0 card |
| **已登记为 `pending` 块** | B02 mark · B03 icon geometry · B03 footer visible text · B07 identity slot | the 4 `pending` blocks in `board.json` — SKIPped and printed by name |
| **原型-实现有意分歧（已裁定）** | B03 nav `waiting` · B03 `[data-states-open]` | asserted here (reality), rationale in the two deltas above |

### Scope ledger — every block of `BLOCKS.md`

Terry's ruling ① scoped the alignment to the board main path. Nothing else is silently
absent; it is recorded here instead:

| Blocks | Disposition |
|---|---|
| **B01 · B02 · B03 · B04 · B05 · B06 · B07 · B09** | **in this manifest** — 8 blocks, 102 checks |
| B08 (list view) | out of scope (①); a `[data-view]` toggle exists in B02, the view itself is a later card |
| B12 (empty states) · B13 (loading) · B14 (toasts) · B17 (error) | out of scope (①); B12's two board-hosted rows are ledgered above |
| B15 (legend) · B18 (states gallery) | **prototype-only** by Terry's 2026-10-12 ruling — the app renders neither |
| B20 · B21 | **retired** in v1.4 — the contract asserts their absence; B02's reverse assertions cover the toggles |
| B10 · B11 · B16 · B19 · B22 · B23 · B24 · B25 | out of scope (①); B16/B22/B25 surfaces are reached through the drawer, and B09 asserts the drawer's own hooks |
| **C01–C10** (consistency items) | not page blocks. They live in `test/web/blocks.contract.mjs` (99 DOM rules + source/manual layers) and run under `npm test` — a different instrument, deliberately not duplicated here |

## 3. Divergences the manifest cannot express (for the written record)

The implementation carries surfaces the prototype does not. They are **not** asserted
(asserting them would bless them; asserting their absence would be false), so they are
recorded here pending the written-deviation sign-off M0 asked for:

| Surface | Where | Status |
|---|---|---|
| `.td-error` panel, `.td-conflict` panel, the board `resync` button, `[data-connection]` on the live dot | `App.vue`, `TopBar.vue` — M6b SSE integration | M0 §1 flagged these as 自创 G1 requiring Elon's approval; still owed |
| the 「等你回复」view surface (B05/B09 adjacent: the view root, its rows, the payload block, the count pill) | `WaitingView.vue`, `Sidebar.vue` | already adjudicated — `blocks.contract.mjs:125-132`, "approved with B03's count together". The `waiting` *nav item* is no longer a divergence: the prototype carries it as of `T-20261012-041728-2` |
| No brand mark, text glyphs instead of the footer's three SVGs, no `.td-caret`, no `closing` state, attachment/activity placeholders | B02/B03/B09 | already ledgered as 4 `pending` blocks; M2's work list |

## 4. Why this is not (yet) a gate

`--strict` is deliberately **not** wired into `npm run check` / CI in this card:

- 4 blocks are `pending` by construction — they exist to be *visible*, not to pass;
- the style leg is non-blocking, and 51 of 186 style assertions currently differ;
- the check needs a host browser, and CI's authoritative job is the container one.

The flip is one flag (`--strict`) plus, if the style leg should gate, `--style-strict`. Both
become meaningful when M2 closes the pending blocks. Until then this manifest's job is to
make every block *countable*: 12 blocks, 8 asserted, 4 named at every run.

## 5. The M2 manifest (`board-m2.json`) — added 2026-10-12

`board.json` above is the M1 record and is left exactly as it was. `board-m2.json` is the
**M2** manifest, frozen by the upstream contract card (`T-20261012-165120`,
`fidelity-contract.md` + `manifests/board-m2.json`, HEAD `ec97acde506c`) and copied in
byte-for-byte apart from the ten `status` flips noted below: same 8-block main path, plus
the target-state blocks M2 owes. Nothing of M1's check list was dropped — the M2 file is a
superset (`m2.derivedFrom`).

The ten blocks M2 closed are flipped `pending → delivered` in this copy (the tool's own
workflow: a `pending` block is SKIPped, so it would otherwise keep its assertions out of the
**default** run — flipping is what makes the default run guard them). Only `B09-m2` is still
`pending`; see the table below.

```bash
node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board-m2 --no-style           # rest state
node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board-m2 --strict --no-style  # M2 target state
```

**Where it stands after M2** (`T-20261012-165126`):

| | |
|---|---|
| blocks | 19 — 8 delivered plus M2's 11 target blocks |
| assertions under `--strict` | 124 |
| failures | **3**, all in `B09-m2` |
| overflow / console | 0 failures at all five widths |

The three remaining failures are the drawer's **data-driven rows** —
`[data-detail-attachments] .td-file`, `[data-detail-activity] .td-activity`, `.td-activity-ts`.
They exist only while a task is open, and this engine evaluates the rest state only: it
cannot click (its README §10 draws the same boundary), and the board's no-task drawer body
legitimately holds no rows. They are therefore asserted where they *are* observable — the
driven browser pass in `test/web/blocks.contract.mjs` (`when: "drawer open"`, evaluated by
`web/scripts/dom-smoke.mjs` between opening a card and closing the drawer, under `npm test`),
with the corresponding hooks (`[data-attachment-row]`, `[data-activity-row]`,
`[data-activity-ts]`) declared in B09. Recording them here rather than deleting them keeps
the gap countable: `--strict` names them at every run.
