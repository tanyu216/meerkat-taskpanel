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

`board.json` remains the M1 record — its four `pending` blocks and its measured values stand —
with **one exception among its live checks**: B04's clear-hook check now reads
`scope: [data-filters]`, because R15 ③ moved the Activity bar's clear control onto the same
`[data-filter-clear]` hook and the two bars are told apart by the bar they sit in
(`design/fidelity-r15.md` §4.2; see §12).

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

`board.json` above is the M1 record and stands as it was measured, with the one exception §4
names — B04's clear-hook check reads `scope: [data-filters]`, because R15 ③ moved the Activity
bar's clear control onto the same `[data-filter-clear]` hook (`design/fidelity-r15.md` §4.2;
see §4 and §12). `board-m2.json` is the
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

> **Partially superseded by §13** (R13 修订, `T-20261013-154954-2`). Everything below that
> describes the roster press as a *route* (view → `list`, status set → the two in-flight
> statuses, a toggle-off on the second press) and the `[data-assignee-clear]` `x` is **no
> longer the contract**. The three blocks and two of the four style targets this section
> added stay; `r13-assignee-clear` is withdrawn and the press is now assignee-only. §13
> carries the current readings.

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
| the roster's one-name-button-per-item structure, and that a roster item holds **no** second button (the `x` is withdrawn entirely) | **this manifest** — `B03-r13`, plus a document-wide `count … == 0` for the `x` *(superseded by §13: the global `count == 0` / `absent` form)* |
| the named option is generated **on demand** (0 at rest) and the one `[data-assignee-clear]` is the assignee control's **adjacent sibling**, `hidden` at rest | **this manifest** — `B04-r13` *(superseded by §13: the `x` is withdrawn, the control's own `Assignee: All` row is the removal path)* |
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
  is a static 14px glyph with no colour of its own at rest. *(Withdrawn by §13; it contributed 0
  comparisons anyway — the prototype side had already dropped the `x`, so the target skipped.)*

The capsule itself has no target: at rest no `[data-assignee-item]` is active, and the width
neutrality, the 999px bed, the accent ink and the U-6 correction are all measured live in
`web/scripts/dom-smoke.mjs`'s R11/R13 section (where the capsule is actually on screen).

## 10. The R12x additions — the Activity view and the Waiting queue
(`T-20261013-014701-7`, 2026-10-13)

Two blocks (`B26`, `B27`) and seven `style.targets` entries (`b26-activity-view`,
`b26-activity-title`, `b26-activity-filters`, `b26-activity-feed`, `b27-waiting-view`,
`b27-waiting-item`, `b27-waiting-item [data-waiting-reason]`). `styleProps` needed nothing new.

**Why the blocks assert the *rest* state only.** `board-m2` measures one page at rest and has no
way to press a control (the schema's six-word vocabulary has no step primitive — §4). The feed is
read when its view is entered, so at rest `[data-activity-view]` is `hidden` and holds **no rows**,
on the implementation side only: the prototype's baseline document ships its seventeen rows as
static markup (its no-script floor), while the shipped app derives them from the ledger it reads on
entry. `B26` therefore asserts what both sides hold at rest — the view root and its header, the
three-slot filter bar, the two **resident** empty states, `Load older`, the absence of a second
dictionary carrier, and the `activity` count pill — plus the one deliberate difference as a stated
fact rather than a gap: `count [data-activity-day] == 0` at rest. A block that demanded rows here
would be asserting the fixture, not the contract. `B27`'s queue *does* hold a row at rest (the
fixture's awaiting card is on the board from the first paint), so its checks state the **relation**
— one row, one of each of the six fields, no nested row — and never a row count.

**The reason chip is scoped, and that mattered.** The first `b27-waiting-reason` target was
`[data-waiting-reason]` — which the **board's badge** also carries (the awaiting badge wears
`data-waiting-reason="E1"`). The target therefore compared the prototype's queue chip against the
implementation's *badge*, and reported 13 property differences that were really one selector
problem. Scoped to `[data-waiting-item] [data-waiting-reason]` its 40 compared properties agree on
every one. The same lesson as `B04-r9`'s retarget in §9, one round on: a hook that names a fact
(here, "this card is awaiting *why*") is not automatically a unique element.

Everything that needs a view *open* is in the driven layer: `web/scripts/dom-smoke.mjs`'s
`R12x · B26` section (+31 contract rules under `when: "activity view"`) and its `M1 · B27` section
(+15 under `when: "waiting view"`) cover routing, the day groups and their newest-first order, the
six fields a row owes in both views, the burst's five-minute window, the three filters and the count
sentence, the single unread boundary and the pill, `Load older` and the day pages, `j`/`k`, both
views' drawers, the language switch, the queue's oldest-first order, and no sideways overflow at the
five review tiers.

**One implementation fix came out of the pairing.** The prototype stands the board's filter bar
down on the two destinations that are not the board area (`boardAreaShowsBar()`,
`design/DESIGN.md` §29.2); the shipped shell bound the bar to the filters toggle alone. The
activity pair's 430 shot reported `section[data-filters]` clipped on the implementation side only
— a bar that narrows *cards*, drawn above a feed it cannot narrow. `[data-filters]` now follows the
same `boardArea` derivation, and the divergence is gone on both the activity pair and the waiting
view.

**Where R12x stands** (`T-20261013-014701-7`, 2026-10-13):

| | |
|---|---|
| blocks | 39 — all `delivered`, none `pending` |
| assertions | 252 · failures **0** |
| overflow / console | 0 failures at all five widths |
| computed style | 46 of 1326 compared properties differ (96.5%) — **non-blocking** |

*(Both figures are this round's, read on its own branch. On the tree after §11 merges in the
composition is 39 blocks / 252 assertions / **55 of 1435** — §11 reconciles the arithmetic.)*

**37 → 39 blocks / 221 → 252 assertions** (two new blocks, 15 + 16 checks). The style count moved
46/1088 → 46/1326: **+7 targets, +238 compared properties, +0 diffs** — the seven new targets agree
on every property the list carries, because at rest both sides hide the same two views (`0×0` boxes
on both). `null`/`0` boxes are recorded rather than treated as a pass: the geometry those targets
would have with a view **open** is measured in `shot-compare.mjs`'s two pairs (all five widths,
both sides driven to the same view by the same press) and in the dom-smoke sections.

**`shot-compare.mjs` gained two combinations**: `light-en-activity` and `light-en-waiting` at the
same five widths, each driving *both* sides into its view (`setView(view)` on the prototype, the nav
press on the implementation) so the pair is one state. Their gating halves are green (topbar rows,
rail width, rail clipping), the layout-divergence probe reports `none`, and the only declared
deviation the matrix still carries is the board-view 430 rule the R12 pair already names
(`section[data-filters]` — the bar is one line with its own scroller, `T-20261013-023722`).
Console/page errors: 0 on both sides.


## 11. The R12 (identifier) additions — the drawer head shows the whole id
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

| | R12's own branch | the merged tree (§10 + §11) |
|---|---|---|
| blocks | 37 — unchanged, none pending | **39** (R12x's two) · none pending |
| assertions | 221 · failures **0** under `--strict` | **252** · failures **0** |
| overflow / console | 0 failures at all five widths | 0 failures at all five widths |
| computed style | **55 of 1190** compared properties differ (95.4%) — **non-blocking** | **55 of 1435** differ (96.2%) — **non-blocking** |

**The two rounds compose exactly, and this is the reconciled arithmetic** — §11 was cut from the
same `2204e83` as §10 and, like it, measured its delta on that shared base (`1088` comparisons,
`46` diffs, `32` targets). Merged, the targets union to `42` (`32 + 7 + 3`) and the comparisons
stack: R12's `+102` (`+70` from its two resolved targets — `r12-drawer-id-text` 35 properties,
`r12-card-id-clamp` 35 — and `+32` from `textOverflow` on the `32` targets then existing) lands on
§10's `1326`, *plus* the `+7` that `textOverflow` now also reaches the seven targets §10 added:
`1326 + 102 + 7 = 1435`. Diffs are not additive in that way — §10's seven new targets agreed on
every property at rest, so the merged total is §10's `46` plus R12's nine: `55`. The third target
R12 adds, `r12-list-id-clamp`, is **missing on the prototype side** ⇒ the tool's "no obligation"
path: it is listed, skipped, and contributes **0 comparisons and 0 diffs** (`lib/style.mjs`).
**No existing target's diff count moved** — the 46 pre-existing diffs sum to exactly the 46 §9
recorded, which is this round's own claim to not having disturbed anything.

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


## 12. The R15 additions — every filter control is one `dropdown` panel
(`T-20261013-165112-3`, 2026-10-13)

**Four `style.targets` entries, no new blocks.** The contract is `design/fidelity-r15.md` (口径 B;
card `T-20261013-165112-2`, source `b225dec`, merged as `49f6f77`) and this card is its product
implementation: the board bar's assignee and priority controls and the activity bar's three stop
being native `<select>`s and become the daisyUI `dropdown` panel the status and label controls
beside them already wore, the activity bar's clear control becomes B04's own
`[data-filter-clear]`, and the Waiting head grows the two-line text block B26's header carries.

| which fact | instrument |
|---|---|
| the seven filter controls are one component family — seven equal triggers, the caret centred on each, each trigger's box the width of the control it replaced | **`style.targets`** — `r15-assignee-trigger` (`[data-filter-assignee-summary]`), `r15-priority-trigger` (`[data-filter-priority-summary]`), `r15-activity-trigger` (`[data-activity-filter-summary]`), beside the pre-existing `r9-label-trigger` (`.td-label-trigger`) and `r11-status-trigger` |
| the Waiting description is B26's own sub-line, spelled in this view's family names | **`style.targets`** — `r15-waiting-sub` (`[data-waiting-head] > div > p`) |
| which hooks exist, and where: the value carriers (`-value`), the trigger seats (`-summary` / `-text`), the rows (`[data-assignee-filter-option]` × 4 · `[data-filter-priority-option]` × 6 · `[data-activity-filter-option]` + `data-activity-value`), one `aria-current` row per single-choice control, and one `[data-filter-clear]` **per bar** | **`blocks`** — the B04 / B04-r13 / B26 checks below |
| the panels really open, choose, restate and close; the two Clear controls split by the bar they sit in; `j`/`k`; the drawer | **the driven layer** — `web/scripts/dom-smoke.mjs`'s R11/R13 `R15 ②` block, its B26 `R15 ①/③` section and its M1·B27 `R15 ④` checks |

**Four structure reds had to be cleared, and all four were the round's own change surfacing:**
`[data-filter-clear]` is no longer the document's only clear control (two bars, one hook — the B04
check is now `scope: [data-filters]`, B26 states its own), `option` inside `[data-filter-assignee]`
was 0 hits (the four static rows are menu `button`s now), the assignee-row rule that froze
`[data-assignee-filter-option] == 0` read 4 (every row carries the hook with **its own value** —
R15 kept R13's hook and carrier and only moved the element), and `[data-activity-filter-reset]` —
retired by the round — read 0.

**Two denominator facts, recorded rather than smoothed:**

* `.td-select` (`r12-select`) is no longer in either filter bar: on the **implementation** side the
  first match is now the create dialog's field (`0×0`, `display:none`), while the prototype's is the
  same dialog's (`385×29`, still laid out). The target still resolves on both sides — the element it
  resolves to moved. This is the denominator shift the implementation card's ruling ⑨ names; it is
  not a new surface.
* `.td-label-trigger` (`r9-label-trigger`) now resolves to the **assignee** trigger on both sides
  (both bars are ordered assignee → priority → status → label), so the target's box is the converted
  control's on both sides alike — its two diffs are the same pair it already carried.

**Where it stands** (`T-20261013-165112-3`, 2026-10-13):

| | before this round (`49f6f77`) | after |
|---|---|---|
| blocks | 39 — unchanged, none pending | **39** — unchanged, none pending |
| assertions | 252 · failures **0** | **258** · failures **0** |
| overflow / console | 0 failures at all five widths | 0 failures at all five widths |
| computed style | 55 of 1435 differ (96.2%) — non-blocking | **62 of 1540** differ (96.0%) — **non-blocking** |

**The arithmetic, as measured.** `+105` comparisons are the three new trigger targets
(`3 × 35` properties); `r15-waiting-sub` agrees on every property it compares and contributes no
diff. `+7` diffs: two on each of the three new trigger targets (`height` `30px → 32px` — the
implementation's field family is 32px on the 4px grid, `design/fidelity-r9.md` §5 B3, the same
written deviation `r11-status-trigger` has always carried — and `borderColor`
`rgb(230,232,235) → rgb(207,213,217)`, `--brand-border-strong`), plus one on `r12-select`, whose
resolved element moved as described above. **The converted triggers are measured to be the same
component as the already-converted status trigger, diff for diff** — that is the round's own claim,
and it is the reason the three new targets are worth their 105 comparisons.

## 13. The R13 修订 — the roster press is a narrowing, and the `x` is withdrawn
(`T-20261013-154954-2`, 2026-10-13; re-landed on `main` after the R15/R17 rounds)

The design contract's third revision (`design/fidelity-r13.md` §10, Terry's 决定甲) landed on the
prototype side first (`T-20261013-154954`, merged as `1d2319f`). It does two things, and this round
ports both:

* **The roster press writes the assignee and nothing else.** No `setView("list")`, no
  `writeStatusFilter(["in_progress","in_review"])`, and **no toggle-off** — pressing the name
  already in force writes the same name again (§10.1 rows 1–2). The removal path is the control's
  own `Assignee: All` row.
* **The `[data-assignee-clear]` `x` is withdrawn** — markup, `app.css` rule and delegated handler,
  all three, on the prototype side and here (§10.1 row 4). Its `aria-label` was the only seat of
  the `assignee.clear` key; the two byte-locked catalogue copies had already shed that key (R17's
  re-pin, `T-20261013-184457`), and R15 ②'s `web/src/i18n/extra.mjs` copy of it — authored while the
  implementation still shipped the `x` — goes with the control.

**What moved in this manifest.** One block changed shape, one style target left.

| change | was | now |
|---|---|---|
| `B04-r13` · the `x` inside the bar | `count == 1` | `count == 0` |
| `B04-r13` · `[data-filter-assignee] + [data-assignee-clear]` | `count == 1` | **removed** — there is no sibling to be adjacent to |
| `B04-r13` · `[data-assignee-clear][hidden]` | `count == 1` | **removed** — the attribute is gone document-wide |
| `B04-r13` · the removal path | (implicit) | **added**: `[data-assignee-filter-option="all"]` inside `[data-filter-assignee]`, `count == 1` |
| `B03-r13` · the roster's `x` | `count == 0`, scoped to `[data-agents-presence]` | `count == 0`, **document-wide** |
| `style.targets` | `r13-assignee-clear` | **removed** |

Assertions move **258 → 257**: three checks became one (`B04-r13`'s `count == 1` → `count == 0`, and
the two existence checks that are now false by construction), plus the one added for the replacement
removal path. Nothing was loosened: the two deleted checks asserted the *presence* of a control the
contract retires, and the contract itself states the withdrawal as a document-wide `absent` rule
(`test/web/blocks.contract.mjs`, B04) rather than a scoped zero — which is also what makes
`web/blocks.bundle.test.mjs` require the attribute name to be gone from the built bundle (measured:
0 hits in `dist/assets/*.js` and `*.css`).

**`style.targets` 46 → 45, and the style leg does not move.** `r13-assignee-clear` is deleted, but it
was already contributing **0 comparisons**: the prototype side had dropped the `x`, so the tool's
"no obligation" path skipped it (§11's `r12-list-id-clamp` note is the same mechanism). The
denominator and the diff total are therefore unchanged — see the readings below.

**Where R13 修订 stands** (this lane, `board-m2 --strict`, `2dd7ba3` vs this commit):

| | base `2dd7ba3` | this round |
|---|---|---|
| blocks | 39 — all delivered, none pending | 39 — all delivered, none pending |
| assertions | 258 · failures **0** | **257** · failures **0** |
| overflow / console | 0 failures at all five widths | 0 failures at all five widths |
| computed style | 62 of 1540 compared properties differ (96.0%) — non-blocking | **62 of 1540** (96.0%) — identical |

The driven layer carries the behaviour the A-leg cannot state: `web/scripts/dom-smoke.mjs`'s
R11/R13 section now asserts the press writes the assignee **and moves neither half of the view
indicator nor `data-filter-status-value`**, that a second press on the same name is **idempotent**,
that the control's own `all` row resets the capsule and `aria-pressed`, and that
`[data-assignee-clear]` counts **0 at rest, while a name is in force, and after a twelve-selector
click sweep** (both roster names, the bar, the board, the four nav items, both view tabs, the filter
toggle and the body) — §10.3 C1–C4.

**The mirror side needed no edit here.** §10.4's "5 new reds" were measured against the prototype
change's own baseline (`02176bb`); the intervening R15/R17 rounds re-pinned the same records
(`design/prototype/app.js` 281 keys, `design/prototype/index.html` 819 hooks — 78 `-aria-label`),
and `test/web/i18n.catalogue.mjs` carries no `assignee.clear`. This round therefore ships **no**
catalogue or `STALE_PROSE_COUNTS` change, and `node --test "test/web/**/*.test.mjs"` reads
231 tests / 231 pass / **0 fail** / 0 skip on both `2dd7ba3` and this commit.

## 14. The B12 seat assertions — the two empty-state buttons get a contract
(`T-20261014-100326`, 2026-10-14)

**Two checks per seat, in both manifests, plus five resident rules in the DOM contract.**
The source is *observation Ⅱ* of two independent verification legs (`T-20261014-084751`
re-checking `081150-2` @ `be8b3c1`, and `T-20261014-100008` re-checking `084800` @ `eaef63f`)
— reported, not fixed: the board's two B12 empty-state buttons were the only copy in either
block **without** a `data-i18n` seat, and neither the contract's rule set nor the manifests
asserted the two seats that do exist. So removing one was silent: the contract evaluator's
`board-view` rules (370) and its whole B12 block (19) stayed green, and so did `npm test`. The
only instrument that reddened was the verification leg's own throwaway probe — which is exactly
the "probe-only window" this card closes.

**What the two seats are.** Every B12 state block puts a `data-i18n` seat on each copy line it
renders *except* its button:

| seat | block | element | design oracle |
|---|---|---|---|
| `noResults.clear` | `[data-empty][data-empty-kind="no-results"]` (the board-level state) | the block's one `<button>` | `design/prototype/index.html:722` — the live 7-column page. `:4253` is the states-gallery demo copy, not counted (see below) |
| `column.empty.add` | `[data-empty][data-empty-kind="column"]` ×7 (one per column) | each block's one `<button>` | `design/prototype/index.html:999/1263/1530/1794/1978/2243/2344`; `:4237` is the states-gallery demo copy, same three reasons |

**The two excluded copies are B18's, and three things — not a code fence — exclude them.** Each
seat appears one extra time in the prototype, inside B18's states showcase (`:4174`, *hidden by
default, opened from the sidebar*): `column.empty.add` at `:4237` sits in the
`<section class="td-state-card" data-empty-column>` at `:4230`, and `noResults.clear` at `:4253`
sits in the `<section class="td-state-card" data-empty-results>` at `:4243`. Each is (i) a
**prototype-only** block (`test/web/blocks.contract.mjs` B18, `status: "prototype-only"` — the
shipped app renders no states gallery at all), (ii) hooked `data-empty-column` /
`data-empty-results`, **not** `data-empty` + `data-empty-kind`, so the seat's own block selector
never reaches it, and (iii) **outside `[data-board]`**. That is why the oracle counts are 1 and 7
and not 2 and 8. (An earlier revision of this section said these two were `<pre><code>` document
fragments; that was wrong — the code fences the `[data-column]` rows are scoped against are at
`:2429`/`:3365` and are a different hook's problem entirely.)

The design's own buttons carry a second hook the implementation deliberately does **not**:
`noResults.clear`'s button has `data-filter-clear` (the implementation keeps `[data-filter-clear]`
as B04's own, scoped to `[data-filters]` — `081150-2`'s F2 record), and `column.empty.add`'s has
`data-column-add` (the implementation's `[data-column-add]` is the *header's*, one per column, and
B06 already counts exactly 7 — `084800`). Both new assertions therefore pin **tag + seat only**,
which is what stops them from silently re-importing a hook the design has and the product ruled out.

**Where the assertions live, and which instrument each one answers to.**

| assertion | file | instrument |
|---|---|---|
| seat count in the block, and the seat's landing site (on the `<button>`) | `board-m2.json` `B05-empty-lg` (no-results) / `B06` (column) — and the same two pairs in the M1 record `board.json` (`B05` / `B06`) | `ui-align` — `blocks[].checks`, evaluated against the **implementation page only** at all five widths |
| the same facts as rules, so `npm test` sees them too | `test/web/blocks.contract.mjs` B12 — one document-wide and one `within`-scoped `count` per seat, plus the button-scoped landing site | `web/scripts/dom-smoke.mjs` (`test/web/blocks.dom.test.mjs`), which also exports the `evaluateRules` walk the verification legs drive in-page |

The second row exists because the first is **not wired into CI** (§4: the check needs a host
browser) — a manifest-only fix would have left the `npm test` window open, which is the half the
observation complained about. The contract rules are the resident leg; the manifest checks are the
declarative record an implementer reads. Neither is a substitute for the other, and the counts they
state are domain-fixed, not fixture-derived (one board-level empty state; one column empty state per
column, 7 columns by B05).

**Negative proof.** Each mutation is the smallest edit that deletes one seat from the shipped
implementation; `web/dist` is rebuilt between every row (the manifests are evaluated against the
built page). Both `ui-align` commands and both contract legs are read per state.

| state | `ui-align board-m2 --no-style` | `ui-align board --no-style` | `node --test test/web/blocks.dom.test.mjs` |
|---|---|---|---|
| baseline (both seats present) | exit **0** · 261 assertions · 0 failures | exit **0** · 106 assertions · 0 failures | exit **0** · 1 pass / 0 fail |
| M1 — `data-i18n="noResults.clear"` removed from `Board.vue` | exit **1** · 2 failures | exit **1** · 2 failures | exit **1** · `B12 count [data-i18n="noResults.clear"] — count 0 != 1` (×2 rules) + the button-scoped rule |
| M2 — `data-i18n="column.empty.add"` removed from `Column.vue` | exit **1** · 2 failures | exit **1** · 2 failures | exit **1** · `B12 count [data-i18n="column.empty.add"] — count 0 != 7` and `… button[…] — count 0 != 1` |
| restored | exit **0** · 261 · 0 | exit **0** · 106 · 0 | exit **0** |

The failed rows are named in the JSON report (`blocks[].rows[].widths[].why`: `count=0，期望 1` /
`count=0，期望 7`), and each state's report is kept beside the card's evidence. Nothing was
loosened: every pre-existing check keeps its own value, no check gained a `pending` status, and the
counts moved **+4** in each manifest (M1 record 102 → 106 asserted; M2 live 257 → 261).

**One adjacent defect registered, not fixed.** `B05`'s board-level no-results check
(`scope: "[data-board]"`, `max: 1`) reads **0** at all five widths on the implementation, because
the state block is a *sibling* of `[data-board]` (both hang off `[data-board-view]`) — a `max` bound
that nothing can exceed is a vacuous pass. The correct statement is `B05-r10`'s, which scopes to
`[data-board-view]` and reads 1. The two new seat checks deliberately do **not** reuse the vacuous
scope: they scope to `[data-empty][data-empty-kind="no-results"]` itself. The stale bound is left as
the M1 record measured it and is now named in both blocks' `desc`; correcting it belongs to whoever
owns the M1 record, not to this card.

**Verification ran on the host, not in the container** — by design: this is a browser-rendered
frontend check (`docs/docker.md` §"Host-allowed checks"), and `design/` is `.dockerignore`d, so the
container gate is blind to the manifest half anyway. The host `npm test` reading on this change is
**2198 tests / 2197 pass / 0 fail / 1 skip** (the skip is `host-cli: absent CLIs are skipped, never
failed`, unrelated and pre-existing).
## 15. The readiness gate — the first band's false red (`T-20261014-105807`, 2026-10-14)

Both manifests now declare `"readySelector": "[data-card]"`. That is the one line that closes the
first-band false red recorded in `T-20261014-100326`'s report §9, and it is a **check-side** change:
no assertion was added, loosened or skipped, and nothing under `web/src/` moved.

### What the engine does without it

`~/.openclaw/team/tools/ui-align/check.mjs`'s `goto()` is: navigate → wait `Page.loadEventFired` →
wait the ready selector → `sleep(settleMs)` → probe. The ready selector it uses when the manifest
declares none is *the first delivered block's first check* — which, in both of these manifests, is
`[data-app-shell]`. The board paints its shell (topbar, sidebar, the seven columns) at mount and
fills the **data-driven** half — cards, the sidebar's presence rows, the waiting queue — when
`loadBoard()`'s reads land (`web/src/stores/board.js`: `loadProjects()`, then
`Promise.all([loadRosters(), loadTasks()])`). So the default gate is satisfied *before the board has
anything in it*, and the only thing standing between the probe and an empty board is a fixed
`sleep(600)`.

On a quiet host the reads land ~15–25 ms after the load event — a 25× margin, which is why the check
is normally green. On a host that stalls them past 600 ms the probe reads the intermediate state: the
shell rows all match and every data-driven row reads 0. That is not a selector error — the same
selectors match at the next band, and the probe reports `count=0` / `scope 未命中`, never
`选择器非法`.

### What the gate changes

The engine's ready poll runs **before** the settle sleep, so the gate turns "sleep 600 ms and hope"
into "wait until the board has cards in it, then settle". It is adaptive: it costs one poll interval
(≤120 ms) when the host is quiet, and it absorbs a stall instead of reporting from inside it. It does
**not** soften anything: `[data-card]` is already asserted by `B07` (`min: 1`) in both manifests, so a
card-less board is a red whichever way it is reached — the gate can only delay that verdict, never
change it. When the gate is never satisfied the engine waits its full 15 s per navigation and then
probes anyway; measured, that is ~45 s for a single band (see below), and the run still exits 1.

### Readings (`board-m2`, `web/dist` `index-Brs_pA8y.js` / `index-qF5G0B_N.css`, host Chrome)

The false red was reproduced deterministically by holding the second-wave reads back 1200 ms on the
**first** board load only (`workspace/T-20261014-105807/slow-fixture.mjs`, run with `--url` — the
repository and the tool are untouched):

| | gate absent | `"readySelector": "[data-card]"` |
|---|---|---|
| exit | **1** | **0** |
| assertions | 257 | **257** |
| failures | **34**, all in band `1512` | **0** |
| failing rows | `B03` 1, `B03-r13` 5, `B07` 13, `B07-identity` 3, `B07-r6` 3, `B27` 9 | — |

Those 34 rows are **row-for-row identical** to `T-20261014-100326`'s recorded failure — the same six
blocks, the same selectors, the same single band. The gate costs **+472 ms** on a full quiet-host run
(four paired runs: 5591 ms before, 6063 ms after, all eight green at 257/0).

Two negative legs hold the fix's feet to the fire. Remove the waiting card from the fixture and `B27`
still reds at **all five** bands (9 rows × 5, exit 1, 6.1 s — no timeout, because `[data-card]` is
still there). Empty `tasks` entirely and the gate times out and the run is still **exit 1**, 29 rows —
a gate that cannot be satisfied does not become a skip.

**Drift guard**: `test/web/ui-align-ready.test.mjs` pins both manifests against re-introducing the
defect — it recomputes the engine's fallback the way `check.mjs` does, requires the declared gate to
differ from it, and requires the gate to name something the manifest itself asserts with a positive
bound. It is browser-free, so it runs in the container; the behavioural half above does not
(`.dockerignore` drops `design/`, so no `ui-align` leg runs there — see §1 "Which host").
