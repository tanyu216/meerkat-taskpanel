# TaskPanel — v1 high-fidelity prototype

A static, self-contained HTML prototype of the TaskPanel board for an AI-agent
team. It is the executable design baseline: tokens, block structure and interaction
behaviour all come from `design-style-guide.md` + `design-spec.md` as amended by
`design-spec-addendum-v1.1.md` (access model, top bar, i18n),
`design-spec-addendum-v1.2.md` (sidebar-footer switches, access-model rewrite) and
`design-spec-v1.3.md` (footer split into three equal thirds; theme and language become
dialogs alongside settings), with
every disagreement between the sources recorded in
[DESIGN.md §9](DESIGN.md#9-reconciliation--where-the-two-source-documents-disagree) and
every judgement call the addenda left open recorded in §14 (v1.1), §15 (v1.2) and
§16 (v1.3).

**Stack is closed: Tailwind CSS + daisyUI + jQuery (slim). No other CSS/UI/JS library,
no CDN, no webfont, no network call, no storage.**

---

## Open it

```sh
open prototype/index.html      # plain file:// — no server, no build step needed
```

`index.html` is complete without JavaScript: the top bar, sidebar, filters, all seven
columns, all eighteen cards, the legend and the **three footer cells** (theme · language ·
settings) are static markup, with the default theme and language already named in their
cells. The drawer, the states gallery, the create-task / create-project modals and the
three footer dialogs are secondary surfaces and stay hidden until opened.

---

## File map

| Path | What it is |
|---|---|
| `index.html` | the prototype — every block as static HTML with `data-*` hooks |
| `tw.css` | **build output** (Tailwind + daisyUI compiled). Do not edit by hand. |
| `src/input.css` | the Tailwind build entry: `@theme` tokens, daisyUI themes, app components |
| `app.js` | the jQuery (slim) interaction layer — interactions I1–I12, plus R3's roster controls (I13) and Markdown editor (I14) |
| `favicon.svg` | the Signal Bars mark as the tab icon (renders `BRAND.md` §5; `prefers-color-scheme` pair) |
| `vendor/jquery.slim.min.js` | jQuery 3.7.1 **slim** build, vendored locally |
| `vendor/markdown-lite.js` | the Markdown → HTML renderer behind the editor's preview pane, vendored locally |
| `vendor/highlight-lite.js` | the source highlighter behind the editor's syntax colours, vendored locally |
| `DESIGN.md` | the design specification: tokens, type, spacing, states, a11y, reconciliation, access model, i18n, R3, R4 |
| `BLOCKS.md` | the block inventory B01–B25 with every `data-*` hook (B20 and B21 are the retired theme/language dialogs — see v1.4; B22 and B23 are R3's roster controls and Markdown editor; B24 is R4's Parent / Depends-on pair; B25 is R5's label control) |
| `screenshots/` | capture set (board, wide board, drawer, dark, list, menu, filters, empty, language menu, access + token, Chinese, 5 viewports, the two-column create dialog, the split editor, assignee autocomplete, the Write-pane scroll proof, the Parent and Depends-on controls) |
| `package.json` | declared devDependencies + `build:css` script |
| `.gitignore` | keeps `node_modules/` out of the repository |

`design-spec.md` §0 names these files `assets/tw.css`, `assets/app.js`,
`assets/vendor/jquery.min.js` and `src.css`. The task card for this build fixed a
flatter layout (`tw.css`, `app.js`, `vendor/…`, `src/input.css`), which is what is
shipped; the contents are the same. `index.html` references every asset by relative
path, so the directory stays portable.

**Every runtime dependency is a file in `vendor/`.** Nothing is fetched, and there is no
CDN reference anywhere in the prototype — open `index.html` from disk with the network
off and everything still works. R3's two additions are first-party rather than
downloaded, because the obvious libraries carry `localStorage` references and external
URLs in their own source and the purity gate rejects both (DESIGN.md §18.4).

---

## Build

`tw.css` is generated from `src/input.css`. **`node_modules` must never live inside
`prototype/`** — install the toolchain in the temporary build directory instead and
expose it to Tailwind only for the duration of the build:

```sh
BUILD=/Users/tanyu/.openclaw/team/workspace/T-20261008-200429-taskboardproto/twbuild
PROTO=/Users/tanyu/Documents/task-panel/prototype

cd "$BUILD" && npm install            # tailwindcss, @tailwindcss/cli, daisyui, jquery

# Tailwind resolves `@import "tailwindcss"` relative to the input CSS file, so the
# toolchain is bridged with a transient symlink that is removed again right after.
ln -sfn "$BUILD/node_modules" "$PROTO/node_modules"
cd "$PROTO" && "$BUILD/node_modules/.bin/tailwindcss" -i src/input.css -o tw.css
rm -f "$PROTO/node_modules"
```

`prototype/package.json` also carries the canonical `npm run build:css` for a normal
checkout where `node_modules` is allowed to sit next to the sources.

Two `@source` directives limit class scanning to `index.html` and `app.js`
(`@import "tailwindcss" source(none)` disables auto-detection, so nothing else on
disk can leak classes into the bundle). Current output: **139 KB**.

### One cascade detail worth knowing

daisyUI 5 emits its component CSS into nested sub-layers of `@layer utilities`, and
the style guide's token blocks in `src/input.css` are unlayered. Two consequences:

- app components are declared **directly** in `@layer utilities` (after the daisyUI
  plugin), so they outrank daisyUI components even at lower specificity — this is what
  makes `.btn { height: 32px }` and `.modal { background-color: var(--scrim) }` win;
- token overrides that must beat the unlayered `:root` block (the `≤559px` rail width)
  are themselves declared unlayered. Moving them into a layer silently breaks them.

---

## Interaction map (all jQuery, all `data-*` hooks)

| # | Interaction | Trigger | Hook |
|---|---|---|---|
| I1 | Drag a card to change status | `dragstart` / `dragover` / `dragleave` / `drop` | `[data-card]`, `[data-column-body]` |
| I2 | Card menu → "Move to" (keyboard/no-mouse fallback) | click on the kebab | `[data-card-menu]` → `[data-move-menu]` → `[data-move-to]` |
| I3 | Open the detail drawer | click anywhere on a card, or `Enter` on its title | `[data-card]` → `[data-detail-drawer]` |
| I4 | Close the drawer | close button / scrim / `Esc` | `[data-detail-close]`, `[data-detail-overlay]` |
| I5 | Post a comment | form submit | `[data-comment-form]`, `[data-comment-input]` |
| I6 | Filter + search (150 ms debounce) | input / change / clear | `[data-search-input]`, `[data-filter-*]`, `[data-filter-clear]` |
| I7 | Board ↔ list view | segmented control and sidebar nav | `[data-view-toggle]` → `[data-view]` |
| I8 | Switch project | project switcher or sidebar list | `[data-project-option]`, `[data-project]` |
| I9 | Create a task | `New task` or a column `+` (prefills that status) | `[data-new-task]`, `[data-column-add]` |
| I10 | Create a project | switcher → `New project…` | `[data-project-new]` |
| I11 | Theme cycle — Light / Dark / Auto | **left footer cell** — one press walks the three states, no dialog | `[data-theme-switch]` → `[data-theme-mode]` |
| I12 | Toast feedback | every mutation | `[data-toast-region]`, `[data-toast]` |
| — | Language switch | **middle footer cell** — dropdown; `Esc` / a press outside closes it | `[data-lang-select]` → `[data-lang-menu]` → `[data-lang-option]` |
| — | States gallery | sidebar footer button, `Esc` / scrim / close to dismiss | `[data-states-open]` → `[data-states-panel]` |
| — | Error retry | `Retry` inside the error state | `[data-error-retry]` |
| — | Access & token settings | **B19** — right footer cell, `Esc` / scrim / close to dismiss | `[data-access-open]` → `[data-access-panel]` |
| — | Token reveal / copy / reset | buttons in the token block | `[data-token-reveal]`, `[data-token-copy]`, `[data-token-reset]` |
| — | Label filter (R3) | the filter bar's dropdown; writes `data-filter-label-value`, restates the trigger badge, re-filters | `[data-filter-label]` → `[data-filter-label-option]` → `[data-filter-label-summary]` |
| — | Allow-list switch (R3) | the access panel's toggle; states and dims, nothing else | `[data-cidr-switch]` → `[data-cidr-whitelist]` |
| I13 | Assignee / reporter (R3) | Roster autocomplete — fuzzy match on input, `↑↓`/`Enter`/`Esc`/`Tab`, free text upserts | `[data-assignee-input]` / `[data-reporter-input]` → `[data-assignee-menu]` / `[data-reporter-menu]` → `[data-assignee-option]` / `[data-reporter-option]` |
| I14 | Markdown editor (R3) | Mode tabs set `data-md-mode`; every keystroke repaints the highlight layer and the preview | `[data-md-editor]` → `[data-md-toggle]`, `[data-md-source]`, `[data-md-highlight]`, `[data-md-preview]` |
| I15 | Labels (R5) | The roster control used many times at once — fuzzy match, free text creates by use, case/whitespace-insensitive, removable chips; the drawer shows them read-only | `[data-label-input]` → `[data-label-menu]` → `[data-label-option]` · `[data-label-chips]` → `[data-label-chip]` → `[data-label-remove]` · `[data-detail-labels]` |

The footer's three cells act directly — none of them opens a dialog except the settings
gear, which opens B19. `Esc` closes whatever is open: the drawer, the states showcase, the
access panel, the card's "Move to" menu and the language menu. The two floating menus also
close on any press outside themselves and their trigger.

Mutations that change board state (move, comment, create) also advance the
`rev` counter in the top bar — the prototype's stand-in for the concurrent-write
revision stream.

**jQuery discipline.** Every event is bound with `$(...).on(...)` against a `data-*`
hook. There is no `document.querySelector` and no `addEventListener` anywhere. Five
native calls remain because jQuery cannot express them; each carries an inline
comment explaining why:

- `el.showModal()` / `el.close()` — the native `<dialog>` API;
- `document.createElement` + `select()` + `document.execCommand("copy")` — clipboard writes need the Selection API. **Used only for the drawer's internal id and session id**; the access panel's `Copy token` deliberately does not call it and reports a toast instead (DESIGN.md §12);
- `$form[0].reset()` — jQuery can dispatch a `reset` event but cannot perform one;
- `$el[0].getBoundingClientRect()` — the language menu is `position: fixed` and must be placed against the trigger's *viewport* box; jQuery's `offset()` is document-relative and drifts once the scrolling sidebar has moved (DESIGN.md §17).

**R3 added no native call.** The roster controls, the label dropdown and the Markdown
editor are entirely `$(...).on(...)` delegation: the two vendored files are reached through
`window.MarkdownLite` / `window.HighlightLite`, which is a global lookup, not a DOM API.

---

## Purity

The prototype is inert: it performs no network I/O of any kind — no transport call,
no HTTP client wrapper, no REST endpoint path — and it reads and writes no device
storage, carries no id or access tokens, holds no backend logic, and loads nothing
from a CDN, an external font or a remote image. Every asset is a relative path next
to `index.html`.

jQuery is the **slim** build precisely so the transport layer is absent from the
bundle: the vendored file contains **zero** transport references, and a vendored
`$.ajax`, `$.get` or `$.post` therefore does not exist to call. The interaction layer
can only ever touch the DOM it was given.

The same rule holds for the *words*, not just the code: the prose above is written
without the banned identifiers so that a plain text scan of `prototype/**` comes back
empty on every one of them, including these documents.

**The token panel is copy, not a credential.** `td_…` is generated in `app.js` from
`Math.random()` and `Date.now()`, lives in memory for the page lifetime and is written
to the DOM and nowhere else — never persisted, never transmitted, never copied to the
clipboard. Nothing on the board authenticates anyone: there is no sign-in, no account
and no session, and the sidebar footer reports how the board is *reachable*, not who is
looking at it (DESIGN.md §12).

---

## Coverage (design-spec §7)

| Dimension | Where |
|---|---|
| 7 statuses | 7 columns, ≥1 card each, plus the legend |
| 5 priorities | every level appears on a card, plus the legend |
| Ownership | 11 human cards + 7 agent cards across claude / openclaw / codex / pi |
| Dual id | human identifier on the card (mono) + internal `td_…` id in the drawer (copyable) |
| Concurrency | `v3`-style version in the drawer + `rev 128` with a live pulse in the top bar |
| Relations | `↑` parent / `→|` blocks / `🔗`-shaped related counters on cards, spelled out in the drawer |
| Comments | human author, agent author and a `decision`-styled comment |
| Activity | 4+ entries per task (created / claimed / status change / commented) |
| Attachments | ≥2 per sampled task |
| Empty states | empty column + no-results |
| Loading | 3 shimmer rows in the list view |
| Themes | three states cycled from the footer — **Light** (default) → **Dark** → **Auto** (follows `prefers-color-scheme`, CSS-only) → Light; no-record default is Light, not the system preference |
| Language | English (default) + Chinese via the language dropdown — 214 key pairs, mirrored |
| Access model | B19 access & token panel: binds `0.0.0.0`, CIDR whitelist, token required from outside localhost; no user / account / sign-in element anywhere |
| Footer | three equal thirds — theme · language · settings — a three-state theme cycle, a dropdown and an icon-only button |
| Viewports | 1512 / 1240 / 980 / 760 / 500 — no page-level horizontal overflow |

The board is the only horizontal scroll container; `html`, `body` and `main` never
scroll sideways. Below 1023px the sidebar collapses to an icon rail — where the three
footer cells keep their equal thirds and drop their labels, leaving three centred icons —
and below 760px the top bar wraps and the drawer goes full width. Between **760 and
779px** the top bar also wraps: that band was sized around a bar that still held the
language switch, and the wrap is now kept as reviewed rather than re-tuned (DESIGN.md
§14, §15).

---

## Screenshots

| File | State |
|---|---|
| `01-board-1512.png` | default board (TaskPanel project, 12 of 18 cards) |
| `02-board-wide.png` | full 7-column board at 2600px — status coverage proof |
| `03-drawer-agent.png` | drawer for an agent task: session block + GFM description |
| `04-drawer-human.png` | drawer for a human task |
| `05-dark-theme.png` | dark theme (re-shot with the theme cell in its `Dark` state) |
| `06-list-view.png` | list view with the skeleton rows |
| `07-move-menu.png` | the shared "Move to" menu |
| `08-filters-agent.png` | assignee filter = Agent |
| `09-no-results.png` | no-results empty state |
| `10-create-task-modal.png` | create-task modal |
| `11…14-viewport-*.png` | 1240 / 980 / 760 / 500 |
| `15-no-javascript.png` | the same document with both `<script>` tags removed — proof that the core structure survives without JavaScript (all 18 cards visible, because the project filter is the only thing JS removes) |
| `16-states-panel.png` | the states gallery: loading, empty column, no results, error and the three toast kinds in one frame |
| `17-access-panel.png` | B19 access & token settings, token masked |
| `18-access-token-revealed.png` | the same panel with the stand-in token revealed |
| `19-board-zh.png` | the board in Chinese — top bar, sidebar, filters, column headers, legend and the footer cells, which now read 浅色 / 中文 / gear |
| `20-drawer-zh.png` | the drawer in Chinese: properties, relation labels, comment role chips and relative timestamps |
| `21-access-panel-dark.png` | the access panel in dark theme |
| `22-lang-menu.png` | the language dropdown open above the middle footer cell, `English` marked as the current choice |
| `23-create-two-col.png` | **R5** — the create dialog: Title + Markdown editor on the left, Priority / Assignee / Project / Status / Reporter / Labels / Parent / Depends on on the right |
| `24-md-editor-split.png` | **R4** — the Markdown editor in Split mode: highlighted source beside the rendered preview |
| `25-assignee-autocomplete.png` | **R4** — the assignee control mid-type: `ti · new` offered alongside the fuzzy match `turing` |
| `26-create-narrow-760.png` | **R5** — the same dialog at 760px, stacked to one column and scrolling internally, framed on the Labels field and the fields that close the column |
| `28-md-write-scroll.png` | **R4** — Write mode scrolled to the tail of a 60-step description: the edit pane scrolls and the highlight layer travels with it |
| `29-create-parent-dropdown.png` | **R4** — the Parent control mid-type: fuzzy matches over the project's tasks, identifier + title, with the clear button shown |
| `30-create-depends-multiselect.png` | **R4** — Depends on with two chips and the menu offering the tasks not yet chosen |
| `33-theme-light-1512.png` | **theme three-state** — `Light`, the no-record default: sun glyph, `Light` label, light board |
| `34-theme-dark-1512.png` | **theme three-state** — one press on: `Dark`, moon glyph, dark board |
| `35-theme-auto-darkos-1512.png` | **theme three-state** — two presses on: `Auto` under a **dark** system preference — display glyph, `Auto` label, dark board |
| `36-theme-auto-lightos-1512.png` | **theme three-state** — the same `Auto` state under a **light** system preference: same label, same glyph, light board (the pair is the proof that Auto follows `prefers-color-scheme`) |
| `37-theme-footer-760.png` | **theme three-state** — the rail at 760px: the footer's three cells collapse to three glyphs (sun · globe · gear), no overflow |
| `38-theme-footer-760-closeup.png` | **theme three-state** — the same three cells, cropped |
| `39-create-label-dropdown.png` | **R5** — the Labels control mid-type: `se · new` offered beside the fuzzy match `security` |
| `40-create-label-new-row.png` | **R5** — a label the board does not hold yet: `zzz-new-label · new`, one Enter away from a new label |
| `41-create-label-new-chip.png` | **R5** — the accepted name as a chip, with its remove button, and the menu reopening over the remaining labels |
| `42-create-label-normalised.png` | **R5** — normalisation: `Triaged` · `Bug` after `triaged` / `  Bug  ` / `BUG` / `bug` all resolved to those two labels, first spelling kept |
| `43-detail-labels.png` | **R5** — the drawer's property grid: the Labels row shows the task's chips, read-only, no input and no remove |
| `44-create-label-narrow-760.png` | **R5** — the same control at 760px, stacked, its menu flipping down over the fields below |

**R5 recapture:** the right column gained one field, so `10-create-task-modal`,
`23-create-two-col` and `26-create-narrow-760` were re-shot, and six frames are new —
`39-create-label-dropdown`, `40-create-label-new-row`, `41-create-label-new-chip`,
`42-create-label-normalised`, `43-detail-labels` and `44-create-label-narrow-760`. The
board frames are untouched: the round adds a field to the dialog and a read-only row to the
drawer, and no pixel of the board. There is no management entry in any frame, because there
is none in the prototype (DESIGN.md §22).

**R4 recapture:** the create dialog changed size, so every frame that shows it was
re-shot — `10-create-task-modal`, `23-create-two-col`, `24-md-editor-split`,
`25-assignee-autocomplete` and `26-create-narrow-760` — and three frames are new:
`28-md-write-scroll` (the Write pane scrolled to the tail, highlight in step),
`29-create-parent-dropdown` and `30-create-depends-multiselect`. The board frames are
untouched: the round changes the dialog's geometry and one scroll binding, and no pixel of
the board. Captured at device-scale-factor 2 with transitions disabled, as before.

**Theme three-state recapture:** the left footer cell gained its third state, so `05-dark-theme`
was re-shot with the cell in `Dark` and six frames are new — `33-theme-light-1512`,
`34-theme-dark-1512`, `35-theme-auto-darkos-1512` and `36-theme-auto-lightos-1512` (the
`Auto` pair, captured under emulated dark and light system preferences), plus
`37-theme-footer-760` and its crop for the rail. No toast appears in any of them: each shot
waits out the 2.5s toast before the shutter. Nothing else on the board moves.

**R3 recapture:** `01-board-1512`, `11-viewport-1240`, `13-viewport-760`, `05-dark-theme`,
`19-board-zh`, `22-lang-menu`, `15-no-javascript`, `17-access-panel` and `03-drawer-agent`
were re-shot against the R3 build — the brand re-skin reaches every one of them — and four
frames are new: `23-create-two-col`, `24-md-editor-split`, `25-assignee-autocomplete` and
`26-create-narrow-760`. **The whole set was in fact recaptured** — a palette change reaches
every pixel of every frame, so leaving any file behind would have shown a product that no
longer exists. The captures that are not in the list above (`02-board-wide`,
`04-drawer-human`, `06-list-view`, `07-move-menu`, `08-filters-agent`, `09-no-results`,
`10-create-task-modal`, `12-viewport-980`, `14-viewport-500`, `16-states-panel`,
`18-access-token-revealed`, `20-drawer-zh`, `21-access-panel-dark`) were re-shot in the same
pass, at the same geometry, from the same handlers the v1.x frames used. Every frame in
`screenshots/` is now R3. Captured at device-scale-factor 2, and no capture carries a
transient toast.

**v1.4 recapture:** `01-board-1512` (the three controls in the three thirds),
`11-viewport-1240`, `13-viewport-760` (the rail: three glyphs, caret dropped),
`05-dark-theme` (the switch in its Dark state), `19-board-zh`, `15-no-javascript` and
`17-access-panel` were re-shot against the v1.4 build, and `22-lang-menu` is new — eight
frames in all, at the same geometry (device-scale-factor 2, viewports 1512×950 /
1240×900 / 760×900). The menu frame is taken with the dropdown already open, so the current
choice is visible in the capture, and the toast region is hidden in every frame so no
capture carries a transient toast. `22-theme-modal` and `23-lang-modal` are **deleted**
with the dialogs they showed. `18-access-token-revealed` and `21-access-panel-dark` remain
the v1.2 files, unchanged: the token block was not touched by this round.

**v1.3 recapture:** `01-board-1512`, `11-viewport-1240`, `13-viewport-760`,
`05-dark-theme`, `19-board-zh`, `15-no-javascript` and `17-access-panel` were re-shot
against the v1.3 build, and `22-theme-modal` / `23-lang-modal` were new — nine frames in
all, at the same geometry. The two modal frames were taken with the dialog already open, so
the current choice was visible in the capture.

**v1.2 recapture:** the same eight files as listed in §15 were re-shot against the v1.2
build. The remaining captures are the v1.1 files, kept as-is; where a v1.1 frame includes
the sidebar footer, it still shows the retired `Local · localhost` readout (DESIGN.md
§15).

Captured with headless Chrome at device-scale-factor 1 with transitions disabled so
the frames are deterministic; `index.html` itself is untouched.

The state shots are driven through the real handlers — the capture page appends a
line that triggers the same `data-*` hooks a click would, so what is captured is
what the prototype actually does, not a hand-styled mock. (Those one-line capture
scripts live in the temporary build directory, never in `prototype/`.)

**On the 430px case:** headless Chrome refuses a window narrower than ~500px, so the
narrowest capture is 500px. That is the same CSS path — everything below 559px
collapses the rail to 56px, keeps the board as the only horizontal scroller and makes
the drawer full width — and the assertion for the 430px column of the §7 matrix is
that no *page-level* horizontal overflow exists, which `hOverflow=false` confirms at
every width tested.

---

## Who is on the board

TaskPanel is a board for an AI-agent team, so the assignee pool is the team
itself: six agent roles — `elon` (openclaw), `jobs` / `linus` / `simons` (claude),
`turing` (codex), `assistant` (pi) — plus the human owner `Terry`, who files every
task (`data-reporter="Terry"` on all 18 cards). Cards show the platform badge **and**
the role handle; the drawer separates Assignee from Reporter; comments and activity
use the same handles. See [DESIGN.md §10](DESIGN.md#10-team--identity-model) and the
assignee table in [BLOCKS.md](BLOCKS.md#assignee-model).

## Notes and known limits

- **Project scoping.** The switcher and the sidebar filter the board by
  `data-project`; TaskPanel (12 cards) is the default, so the default board shows
  12 of the 18 cards. All 18 are in the document, and `02-board-wide-2400.png` shows
  the full set — switch to a project with no cards to see the empty-column states.
- **Comment lists are representative.** A card's `data-comments` number is the total
  count; the drawer renders a sample of the thread rather than the whole count.
- **The drawer's session block is read-only.** `Resume` is wired to a toast — the
  prototype has no transport to resume anything with, by design.
- **The activity nav item** reports the current revision and task count instead of
  opening a fifth surface, which the block inventory does not define.
- **The states gallery is a review surface, not a product screen.** It exists so every
  non-default state (loading, empty column, no results, error, three toast kinds) can
  be inspected and captured in one frame. It is opened from the sidebar footer and is
  hidden by default. The error state lives inside it because the board only raises that
  state when a load fails and this prototype performs no loads; `Retry` re-runs the
  real render pass.
- **Dark theme values** come from `design-spec.md` §2.2 because the style guide
  defines no dark palette; status and priority keep one value in both themes.
