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
| **C01–C10** (consistency items) | not page blocks. They live in `test/web/blocks.contract.mjs` (the DOM rules + source/manual layers) and run under `npm test` — a different instrument, deliberately not duplicated here |

## 3. Divergences the manifest cannot express (for the written record)

The implementation carries surfaces the prototype does not. They are **not** asserted
(asserting them would bless them; asserting their absence would be false), so they are
recorded here pending the written-deviation sign-off M0 asked for:

| Surface | Where | Status |
|---|---|---|
| `.td-error` panel, `.td-conflict` panel, the board `resync` button, `[data-connection]` on the live dot | `App.vue`, `TopBar.vue` — M6b SSE integration | M0 §1 flagged these as 自创 G1 requiring Elon's approval; still owed |
| the 「等你回复」view surface (B05/B09 adjacent: the view root, its rows, the payload block, the count pill) | `WaitingView.vue`, `Sidebar.vue` | already adjudicated — `blocks.contract.mjs:125-132`, "approved with B03's count together". The `waiting` *nav item* is no longer a divergence: the prototype carries it as of `T-20261012-041728-2` |
| No brand mark, text glyphs instead of the footer's three SVGs, no `.td-caret`, no `closing` state, attachment/activity placeholders | B02/B03/B09 | **closed** — M2 (`T-20261012-165126`) landed the mark, the three SVG glyphs, the caret and the `closing` state and flipped those four blocks in `board-m2.json`; the attachment/activity rows landed as driver-asserted rows (see §5). The M1 record `board.json` keeps them `pending` on purpose — it is the M1 snapshot, not a live ledger |
| A visible order-score span on every sidebar project row (`.td-order-score` / `[data-side-score]`) | `Sidebar.vue` | **removed** in M2b (`T-20261012-174913-2`, E2b): the score is the prototype's `data-order-score` **attribute** and is never painted. The desktop prefix monogram (`[data-side-icon]`) was hidden at the same time — BLOCKS.md B03 says "prefix monogram, **rail only**", and the extra cell was what ellipsised the project name |

## 4. Why `board.json` is not a gate

`board.json` above is the **M1 record** and stays as it was measured, including its four
`pending` blocks — they exist there to be *visible*, not to pass, and `--strict` against it
would be the wrong reading of a snapshot.

`board-m2.json` is the live manifest: no `pending` blocks, 0 failures under both the default
and `--strict` runs (§5). It is still **not** wired into `npm run check` / CI, for the reason
that has not changed:

- the check needs a **host browser**, and CI's authoritative job is the container one — the
  image carries no Chromium on purpose (`docs/docker.md` §"Host-allowed checks");
- the style leg remains non-blocking (`style.blocking: false`), so `--style-strict` is the
  second switch if the style leg should ever gate.

Wiring `--strict` into a host-run CI job is therefore a one-line change to the workflow, ready
whenever the owner wants a red/green gate rather than the current reported count.

## 5. The M2 manifest (`board-m2.json`) — added 2026-10-12

`board.json` above is the M1 record and is left exactly as it was. `board-m2.json` is the
**M2** manifest, frozen by the upstream contract card (`T-20261012-165120`,
`fidelity-contract.md` + `manifests/board-m2.json`, HEAD `ec97acde506c`) and copied in
byte-for-byte apart from the ten `status` flips noted below: same 8-block main path, plus
the target-state blocks M2 owes. Nothing of M1's check list was dropped — the M2 file is a
superset (`m2.derivedFrom`).

The ten blocks M2 closed are flipped `pending → delivered` in this copy (the tool's own
workflow: a `pending` block is SKIPped, so it would otherwise keep its assertions out of the
**default** run — flipping is what makes the default run guard them). The eleventh,
`B09-m2`, was flipped in M2b (see below) — **no block is `pending` any more**.

```bash
node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board-m2 --no-style           # rest state
node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board-m2 --strict --no-style  # M2 target state
```

**Where it stands after M2b** (`T-20261012-174913-2`, 2026-10-12):

| | |
|---|---|
| blocks | 19 — all `delivered`, none `pending` |
| assertions | 122 under both the default and `--strict` runs |
| failures | **0** in both |
| overflow / console | 0 failures at all five widths |

The count moved 124 → 122: **−3 +1**. `B09-m2`'s three data-driven row checks were removed
(see `drivenChecks` in the manifest and §5 of `T-20261012-174913`'s report), and
`B03-lang-menu` gained one (`[data-lang-menu] > ul.menu > li`).

**`B09-m2`: why the three came out.** `[data-detail-attachments] [data-attachment-row]`,
`[data-detail-activity] [data-activity-ts]` and `[data-detail-activity] [data-activity-row]`
exist only while a task is open, and this engine evaluates the rest state only: it cannot
click (its README §10 draws the same boundary), and the board's no-task drawer body
legitimately holds no rows. So they were **permanently red here** — the `rc=1` they forced
said "the tool cannot click", not "M2 did not land", which is the wrong thing for a gate to
say. Their instrument is the driven layer, and it already carries a stronger version of each:
`test/web/blocks.contract.mjs` B09's four `when: "drawer open"` rules (`[data-attachment-row]`,
`[data-activity-row]`, `[data-activity-ts]`, and the attachments placeholder `equals: 0`),
evaluated by `web/scripts/dom-smoke.mjs` between opening a card and closing the drawer, under
`npm test`. They were therefore moved out of `checks` and into the engine-ignored
`drivenChecks` array, so the gap stays countable without being reported as a failure. The
block's two remaining checks are statically decidable and the implementation meets both, so
the block flipped `pending → delivered` and `--strict` now reports the truth: 0.

## 6. The R6 additions — Terry's eight fidelity findings (`T-20261012-192813-2`, 2026-10-12)

Seven blocks (`B02-r6`, `B03-r6-nav`, `B03-r6-footer`, `B07-r6`, `B08-r6`, `B09-r6`,
`B19-r6`) and twelve `style.targets` entries were added, one per finding of the R6 contract
(`design/fidelity-r6.md`). The division of labour is the same the manifest has always had:

| which fact | instrument |
|---|---|
| class names, element counts, structure | **this manifest** (`[data-view-toggle].td-tabs`, `.td-list-head`, `[data-detail-status-chip].td-chip…`) |
| computed style (the accent pair on the pressed tab and the current nav row, the title's clamp, the list's row grid, the chip's own face) | **`style.targets`** — the two-sided leg, prototype as oracle |
| anything needing a click or an injected value (the visible theme glyph *versus* `data-theme-mode` across the three-state cycle, a long title's two-line geometry, the modal's translate matrix, the token mask's text) | **the driven layer** — `test/web/blocks.contract.mjs` rules with `when: "rail"` / `"panel open"` / `"drawer open"`, plus the `R6` section of `web/scripts/dom-smoke.mjs` |

Run (unchanged):

```bash
node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board-m2
```

**Where R6 stands** (`T-20261012-192813-2`, 2026-10-12):

| | |
|---|---|
| blocks | 26 — all `delivered`, none `pending` |
| assertions | 152 · failures **0** |
| overflow / console | 0 failures at all five widths |
| computed style | 64 of 558 compared properties differ (88.5%) — **non-blocking** (`style.blocking: false`) |

The twelve new targets are the R6 surfaces, and the two that matter most came out
**fully aligned, property for property**: `[data-view][aria-pressed="true"]` (accent copy on
the surface, 26px, 4px, 12px/500 — the pressed tab the implementation used to paint
identically to the unpressed one) and `[data-theme-switch]` / `[data-lang-select]` (the
28px single-row cells). `.td-list-head` also matches. The residual diffs on the new targets
are the board-wide ones the manifest already carried, not R6 regressions: the root
font-size (prototype `14px` vs implementation `16px`), and the card/list geometry that
follows from the two sides having different card widths. The chip target reports only
`width`/`minWidth` as different (`57.0625px` vs `fit-content`) — its height, padding, font,
colour, background, border and radius all agree, which is the R1 "measured pill" face
reproduced exactly.

The style leg is still **not** a gate (`--style-strict` is the switch), and the count moved
45/186 → 64/558 because twelve targets are newly *measured*, not because fidelity dropped.

## 7. The R10 additions — the board's own empty state, the drawer's saves, the fill
(`T-20261012-230448-2`, 2026-10-13)

Three blocks (`B05-r10`, `B09-r10`, `B10-r10`) and two `style.targets` entries were added, one
per item of the R10 contract (`design/fidelity-r10.md`). The division of labour is unchanged:

| which fact | instrument |
|---|---|
| structure and counts (the state root and its two members, the save region and its three field hooks, the stretched field) | **this manifest** |
| computed style (the wrapper as a pass-through, the danger-coloured alert block) | **`style.targets`** — the two-sided leg, prototype as oracle |
| which member is *painted* at one instant, that a real edit moves the save state (gates and back again, `assignee`/`reporter`/`labels`, the blank failure), and where the editor ends relative to its own row | **the driven layer** — `web/scripts/dom-smoke.mjs`'s R10 section, which opens a card, edits it and switches to a card-less project |

Three facts the contract rows name are deliberately **not** bilateral targets, and the manifest
records them instead: `[data-md-editor]` / `.td-md-panes` / `[data-md-source]`. The prototype
mounts its create dialog on daisyUI's `.modal`, which has neither `hidden` nor `open`, so at rest
the dialog is still **laid out** (`visibility: hidden`; measured `[data-md-editor]` = 616×514);
the implementation closes it with `hidden` (`display: none`), so every computed
`width`/`height`/`minWidth` inside it falls back to its declared value. Comparing those three
would mostly be comparing "laid out" with "not laid out" — 9 of the 4/3/8 diffs it produced. What
R10 ③ actually needs to lock is declarable and lives in the contract's `computed` rules
(`test/web/blocks.contract.mjs`), evaluated by the same harness.

**Where R10 stands** (`T-20261012-230448-2`, 2026-10-13):

| | |
|---|---|
| blocks | 32 — all `delivered`, none `pending` |
| assertions | 184 · failures **0** under `--strict` |
| overflow / console | 0 failures at all five widths |
| computed style | 47 of 775 compared properties differ (93.9%) — **non-blocking** |

**29 → 32 blocks / 168 → 184 assertions** (the R9 lane's reading → this one: the three R10 blocks
and their 16 checks). The style
count moved 43/713 → 47/775: `+62` comparisons from the two new targets, and the two diffs on
`r10-board-view` (the implementation's main area is 48px wider and its board 82px taller than the
prototype's at 1512×950 — the board-wide root-font-size difference the manifest has always
carried) plus one on `r10-detail-save-error` (the alert's soft half: the prototype names a flat
`--color-td-danger-soft`, the implementation uses the app's existing 12% error mix, per R10's
"no new token" rule).

## 8. The R12 additions — the bar's single line, and the seven-column equal-height chain
(`T-20261013-023722`, 2026-10-13)

Two blocks (`B04-r12`, `B05-r12`) and three `style.targets` entries (`r12-select`, `r12-count`,
`r12-column`), one per item of the R12 contract (`design/fidelity-r12-supplement.md`). The
division of labour is the contract's own R-6, and it is drawn by **what each instrument can
express**, not by subject (R-6a):

| which fact | instrument |
|---|---|
| the closed set of filter controls, each family member's count, and their relative order | **this manifest** — the six-word vocabulary (`selector`/`scope`/`count`/`min`/`max`/`nonEmpty`), with order written as a general-sibling `~` so a missing status control does not break it (R-3) |
| one element's declared values (`flexWrap: nowrap`, the bar's `overflow-x`/`min-width` and zero padding, the board's `alignItems: stretch`, the column's own `overflow-y`) | **`test/web/blocks.contract.mjs`** `computed` rules, evaluated by the same harness |
| computed style, both sides, prototype as oracle | **`style.targets`** — with the three new names (`flexWrap`, `overflowX`, `overflowY`) added to `.ui-align.json`'s `styleProps`, without which the R12 rows would compare nothing and say nothing (the contract's R-6b / U-3) |
| row count, visibility, the four field heights, the count's geometric right-edge pin, the bar's own scrollable slack at 430 — and **all** of the board geometry (spread, column-vs-content-box, viewport follow, natural content, scroller counts) | **the driven layer** — `web/scripts/dom-smoke.mjs`'s R12 section, the only leg that can compare two elements or read a line's centres |

`[data-filter-label] > summary` is **not** a new target: it is already `r9-label-trigger` (the same
element), and registering it twice would count one difference twice.

**Where R12 stands** (`T-20261013-023722`, 2026-10-13):

| | |
|---|---|
| blocks | 34 — all `delivered`, none `pending` |
| assertions | 200 · failures **0** under `--strict` |
| overflow / console | 0 failures at all five widths |
| computed style | 33 of 952 compared properties differ (96.5%) — **non-blocking** |

**32 → 34 blocks / 184 → 200 assertions** (this lane's base reading → this one: the two R12 blocks
and their 16 checks). The style count moved 18/775 → 33/952: `+16` comparisons from the three new
targets — whose 11 diffs are the ones the contract's §5.3 asks to put on screen (`.td-select`
30→32px and 109→91px, the count's 58→46px and its mono-face, the column's 758→756px) — `+3`
from the `wrap → nowrap` / `visible → auto` declarations the round itself makes on
`[data-filters]`, and `+1` from the `overflow` shorthand following them. **No existing target's
diff count changed** except `filters`, where the four new rows *are* the round's decision.

## 9. The R11/R13 additions — the status filter, the roster route and the named assignee
(`T-20261013-014701-3`, 2026-10-13)

Three blocks (`B03-r13`, `B04-r11`, `B04-r13`) and four `style.targets` entries
(`r11-status-trigger`, `r11-roster-name`, `r13-assignee-item`, `r13-assignee-clear`), one set per
item of the two contracts this round ports in one commit (`design/fidelity-r11.md` §2.1/§2.2 and
`design/fidelity-r13.md` §2.1/§2.4/§2.9). `styleProps` needed nothing new: every property the four
targets are read for is already in `.ui-align.json`'s list.

**One existing block was retargeted, not loosened.** `B04-r9`'s three class-scoped checks
(`.td-label-trigger` count, the `span` / `[data-filter-label-summary]` inside it, and
`.td-label-trigger > .td-icon-sm`) were written when exactly one control wore the family shell.
R11 ① §4.1 R4 puts the **status** control in the same `.td-label-trigger` shell — that shared
shell *is* how the bar's four field controls stay one height — so "the document has one
`.td-label-trigger`" stopped being true. The fact the three checks assert was never "one trigger in
the document"; it was "the label control's trigger wears the shell, carries the value as plain
text, and has its own caret". They are now stated over `[data-filter-label]`, the label control's
own hook, and each still counts exactly 1. The same retarget was applied to `dom-smoke.mjs`'s R9
probe for the same reason.

| which fact | instrument |
|---|---|
| the status control is in the bar, has 8 rows (`all` + the seven first-class statuses) with the seven value-qualified rows in board order, joins the light-dismiss membership, and carries its value on its own `data-filter-status-value` | **this manifest** — `B04-r11`, the six-word vocabulary |
| the roster's one-name-button-per-item structure, and that a roster item holds **no** second button (the `x` lives in the bar) | **this manifest** — `B03-r13`, plus `count … == 0` scoped to `[data-agents-presence]` for the `x` |
| the named option is generated **on demand** (0 at rest) and the one `[data-assignee-clear]` is the assignee control's **adjacent sibling**, `hidden` at rest | **this manifest** — `B04-r13` |
| the status domain equals the board's own (the seven columns' and the cards' `data-status` set), the named option's hook name is not B22's, the roster host clips nothing, one name button per item | **`test/web/blocks.contract.mjs`** — `order`/`domain` rules read off `DOMAINS.STATUS`, `computed` rules on `[data-agent-assignee]`/`[data-agent-text]`, evaluated by the same harness |
| computed style, both sides, prototype as oracle | **`style.targets`** — the four new names; the diffs they add are the round's own decisions (the trigger 30→32px, the roster button's 18→21px line, the capsule item's inline box) |
| the rest: the route's four steps and its AND semantics, the toggle-off, `x` clearing the assignee alone, the capsule's width neutrality (`clippedPx == 0` at every tier), the row-height delta, the U-6 correction (a first-in-row capsule bleeding 6px with its cap intact), and the eight status rows' OR | **the driven layer** — `web/scripts/dom-smoke.mjs`'s R11/R13 section, the only leg that can press a control and read the result |

**Where R11/R13 stand** (`T-20261013-014701-3`, 2026-10-13):

| | |
|---|---|
| blocks | 37 — all `delivered`, none `pending` |
| assertions | 221 · failures **0** |
| overflow / console | 0 failures at all five widths |
| computed style | 46 of 1088 compared properties differ (95.8%) — **non-blocking** |

**34 → 37 blocks / 200 → 221 assertions** (this lane's reading on the *unretargeted* manifest →
this one: the three new blocks and their 21 checks minus the one class-scoped row the retarget
replaced). The style count moved 32/952 → 46/1088: `+4` targets and `+14` diffs. **No existing
target's diff count changed**, and the three `B04-r9` failures the unretargeted manifest produced
against this round's code are gone.

The 14 new diffs, registered rather than fixed (the contracts' §5.2 asks for the registration, and
each is one of three known shapes):

* `r11-status-trigger` **2** — `height 30→32px` and the hairline's `borderColor`. The first is the
  **same approved deviation `r9-label-trigger` already carries** (the implementation's field family
  is 32px on the 4px grid, the prototype's 30px); R11 §2.1 asks for the status control to wear that
  family's shell, so it inherits the deviation by construction. The second is the R9 hairline
  (`--brand-border-strong` vs the prototype's lighter line), also shared with `r9-label-trigger`.
  **This is not `r9-label-trigger` counted twice**: that target is the *label* summary and this one
  is the *status* summary — two different elements of the bar (the R12 note's warning is against
  registering one element under two names, which this is not). The two readings coincide because
  the two controls are deliberately one component.
* `r11-roster-name` **7** and `r13-assignee-item` **5** — the roster row's **face**: `fontSize
  12→14px`, `lineHeight 18→21px`, `letterSpacing -0.12→normal`, the ink's `color`/`borderColor`,
  and the box those produce (`28×18 → 42×21`; the fixture's first roster name also differs —
  the prototype's row starts at `jobs`, the implementation's at `linus`). R11 §5 B-7 states the
  12px face, which the prototype gets from `.td-agent-row`; the implementation's roster row has
  carried the base 14px since M2 and this round does **not** change it — the round's own
  acceptance is the name's clickability, the capsule and the clipping, and the row's face is a
  B03 question the card does not open. The target exposes it; it does not create it.
* `r13-assignee-clear` **0** — the one target of the four that is fully aligned, because the `x`
  is a static 14px glyph with no colour of its own at rest.

The capsule itself has no target: at rest no `[data-assignee-item]` is active, and the width
neutrality, the 999px bed, the accent ink and the U-6 correction are all measured live in
`web/scripts/dom-smoke.mjs`'s R11/R13 section (where the capsule is actually on screen).

## 10. The R12 (identifier) additions — the drawer head shows the whole id
(`T-20261013-033933`, 2026-10-13)

**Three `style.targets` entries and one `styleProps` name.** The contract is
`design/fidelity-r12.md` (card `T-20261013-023310`, frozen at `7ac4d3a`; independent verification
`T-20261013-024952` PASS) and this card is its product implementation. Note the **number collision**:
the supplement's round (`design/fidelity-r12-supplement.md`, card `T-20261013-023722`) is also
called R12 — its §0 records that it took the *supplement* filename because `fidelity-r12.md` was
already held by the contract this card implements. The two rounds therefore share the `r12-` target
prefix; every target **name** is unique, so nothing is counted twice.

| which fact | instrument |
|---|---|
| the drawer head's width cap is withdrawn and the card's / list row's is not, read **bilaterally** (prototype as oracle) | **`style.targets`** — `r12-drawer-id-text` (`[data-detail-identifier]`) and the two reverse anchors `r12-card-id-clamp` (`[data-card-identifier]`) / `r12-list-id-clamp` (`[data-list-identifier]`) |
| the head's text is the **whole** id (`PROJ-0007`, not `PROJ-000…`), it wears `td-id` **and** `td-id-full`, and the variant does not spill onto a card or a row | **the driven layer** — `web/scripts/dom-smoke.mjs`'s `R12-id` section, which presses the over-cap card and reads the *same* task's two render points (a relation between two elements, which R-6a sends here) |
| one element wears `.td-id-full` (board view and list view), the drawer head keeps `.td-id`, and the open head's text carries no ellipsis whatever card is open | **`test/web/blocks.contract.mjs`** — a `classes` rule, two count-only `computed` probes and one `text` rule (`when: "drawer open"`); `blocks` in this manifest stays **empty** on purpose (one fact, one mechanism) |

**`styleProps` needed one new name: `textOverflow`.** All three targets are read for
`text-overflow` (the variant's third declaration), and without the name the property is silently not
compared — the same lesson R12-supplement wrote down as R-6b / U-3.

**Where it stands** (`T-20261013-033933`, 2026-10-13):

| | |
|---|---|
| blocks | 37 — unchanged, none pending |
| assertions | 221 · failures **0** under `--strict` |
| overflow / console | 0 failures at all five widths |
| computed style | **55 of 1190** compared properties differ (95.4%) — **non-blocking** |

**1088 → 1190 comparisons** (`+102`) and **46 → 55 diffs** (`+9`). The arithmetic is exact and worth
spelling out because it is the round's own claim to not having disturbed anything:

* `+70` comparisons and `+9` diffs come from the **two** new targets that resolve on both sides
  (`r12-drawer-id-text` 35 properties, 8 diffs; `r12-card-id-clamp` 35 properties, 1 diff). The
  third, `r12-list-id-clamp`, is **missing on the prototype side** ⇒ the tool's "no obligation"
  path: it is listed, skipped, and contributes **0 comparisons and 0 diffs** (`lib/style.mjs`).
* `+32` comparisons and **0** diffs come from `textOverflow`: one more compared property on each of
  the 32 pre-existing targets. **No existing target's diff count moved** — the 46 pre-existing diffs
  sum to exactly the 46 §9 recorded.

The nine new diffs, registered rather than fixed, are of two known shapes — and neither is this
round's to fix:

* `r12-drawer-id-text` **8** — `width`/`height`/`minWidth` (`43×18 → 0×0`) and
  `fontSize`/`lineHeight`/`letterSpacing`/`color`/`borderColor`. This is the **open-vs-closed**
  shape §7 already excluded `[data-md-editor]` for: the prototype's closed drawer is still *laid
  out* (its seed `TD-128` measures 43×18), while the implementation toggles the drawer with `hidden`
  (`display: none`, C06), so every layout and inherited-type property reads the declaration instead
  of the box. **The four properties R12 is about agree on both sides** — `maxWidth: none`,
  `overflow: visible`, `textOverflow: clip`, `whiteSpace: nowrap` appear in **no** diff row — which
  is why registering the element is still worth doing even though its box is not comparable. The
  type-face difference (`12px` vs the drawer's inherited `14px`) predates this round; R12 §8 R2
  forbids touching anything but the cap, so it is exposed, not created.
* `r12-card-id-clamp` **1** — `width` only (`59.59 → 26.5px`). Both sides clamp to a **finite px**
  value (the contract's C′1: `9ch` resolves to px, never the literal string); the widths differ
  because the prototype's first card carries a nine-character id and the implementation's fixture
  first card does not. This is the same board-wide content/size difference the manifest has always
  carried.

`r12-drawer-id-text`'s box being `0×0` is worth one more sentence, because it is the reason the
contract binds item ② to **both** instruments: a bilateral computed-style comparison cannot see the
drawer head's *text*, and a `0×0` box cannot see its *cap*. The cap's two halves are covered by the
properties that survive `display: none` (this target) and by the driven layer, which opens the
drawer for real and reads the head's `maxWidth`/`overflow`/`textOverflow` **and** its text off the
same live element.
