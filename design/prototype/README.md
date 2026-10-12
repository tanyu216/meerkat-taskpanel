# MeerkatTaskPanel — v1 high-fidelity prototype

A static, self-contained HTML prototype of the MeerkatTaskPanel board for an AI-agent
team. It is the executable design baseline: tokens, block structure and interaction
behaviour all come from `design-style-guide.md` + `design-spec.md` as amended by
`design-spec-addendum-v1.1.md` (access model, top bar, i18n),
`design-spec-addendum-v1.2.md` (sidebar-footer switches, access-model rewrite) and
`design-spec-v1.3.md` (footer split into three equal thirds; theme and language become
dialogs alongside settings), with
every disagreement between the sources recorded in
[DESIGN.md §9](../DESIGN.md#9-reconciliation--where-the-two-source-documents-disagree) and
every judgement call the addenda left open recorded in §14 (v1.1), §15 (v1.2) and
§16 (v1.3).

**Stack is closed: Tailwind CSS + daisyUI + jQuery (slim). No other CSS/UI/JS library,
no CDN, no webfont, no network call, no storage.**

---

## Open it

```sh
open design/prototype/index.html      # plain file:// — no server, no build step needed
```

`index.html` is complete without JavaScript: the top bar, sidebar, filters, all seven
columns, all eighteen cards, the legend and the **three footer rows** (theme · language ·
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
| `app.js` | the jQuery (slim) interaction layer — interactions I1–I12, plus R3's roster controls (I13) and Markdown editor (I14), R5's label control (I15), R9's light-dismiss rule (I16), R10's board empty state (I17) and drawer auto-save (I18), and R11's status filter (I19) and roster route (I20) |
| `favicon.svg` | the Sentinel Watch mark as the tab icon (renders `BRAND.md` §5; `prefers-color-scheme` pair) |
| `vendor/jquery.slim.min.js` | jQuery 3.7.1 **slim** build, vendored locally |
| `vendor/markdown-lite.js` | the Markdown → HTML renderer behind the editor's preview pane, vendored locally |
| `vendor/highlight-lite.js` | the source highlighter behind the editor's syntax colours, vendored locally |
| `../DESIGN.md` | the design specification: tokens, type, spacing, states, a11y, reconciliation, access model, i18n, R3, R4 |
| `../BLOCKS.md` | the block inventory B01–B25 with every `data-*` hook (B20 and B21 are the retired theme/language dialogs — see v1.4; B22 and B23 are R3's roster controls and Markdown editor; B24 is R4's Parent / Depends-on pair; B25 is R5's label control) |
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
`design/prototype/`** — install the toolchain in the temporary build directory instead and
expose it to Tailwind only for the duration of the build:

```sh
BUILD=/Users/tanyu/.openclaw/team/workspace/T-20261008-200429-taskboardproto/twbuild
PROTO=/Users/tanyu/Documents/meerkat-taskpanel/design/prototype

cd "$BUILD" && npm install            # tailwindcss, @tailwindcss/cli, daisyui, jquery

# Tailwind resolves `@import "tailwindcss"` relative to the input CSS file, so the
# toolchain is bridged with a transient symlink that is removed again right after.
ln -sfn "$BUILD/node_modules" "$PROTO/node_modules"
cd "$PROTO" && "$BUILD/node_modules/.bin/tailwindcss" -i src/input.css -o tw.css
rm -f "$PROTO/node_modules"
```

`design/prototype/package.json` also carries the canonical `npm run build:css` for a normal
checkout where `node_modules` is allowed to sit next to the sources.

Two `@source` directives limit class scanning to `index.html` and `app.js`
(`@import "tailwindcss" source(none)` disables auto-detection, so nothing else on
disk can leak classes into the bundle). Current output: **189 KB** (`tw.css` = 193372
bytes after the R12 rebuild; the figure this line carried before said 139 KB and had been
stale for some rounds — it is a measurement, so it is stated as one).

**The scan reads comments, not just markup.** A candidate is any token that *looks* like a
class name anywhere in those two files, prose and comments included — a bare `stack` in an
HTML comment is enough for the toolchain to emit daisyUI's whole `.stack` component
(measured: +2242 bytes, +49 selectors, no element to match). It is silent: the build
succeeds and the page is unchanged. So after editing `index.html` or `app.js` — comments
included — rebuild `tw.css` and **review the diff**, preferring prose ("stacked form") over
a bare component name.

**R10 measured two more of these, and both were caught by the diff review.** The round's
first draft of the comments contained the bare words `steps` (in "the board view steps
aside") and `blur` (describing the field's focus-loss trigger); the rebuild emitted
daisyUI's `.steps` component (~4.9 KB) and Tailwind's `.blur` utility for them. Rewording
both — "gives way", "focus loss" — took the bundle back down. Net for R10: **+631 bytes**,
and the only class selector the round adds is `.td-save-error`, which is a rule, not an
accident. The `blur` one is the sharper lesson: the *event name* is a legitimate token to
have in the code, so a round that binds a focus-loss handler has to expect the utility to
appear unless the binding uses the bubbling event's own name.

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
| I11 | Theme cycle — Light / Dark / Auto | **top footer row** — one press walks the three states, no dialog | `[data-theme-switch]` → `[data-theme-mode]` |
| I12 | Toast feedback | every mutation | `[data-toast-region]`, `[data-toast]` |
| — | Language switch | **middle footer row** — dropdown; `Esc` / a press outside closes it | `[data-lang-select]` → `[data-lang-menu]` → `[data-lang-option]` |
| — | States gallery | sidebar footer button, `Esc` / scrim / close to dismiss | `[data-states-open]` → `[data-states-panel]` |
| — | Error retry | `Retry` inside the error state | `[data-error-retry]` |
| — | Access & token settings | **B19** — bottom footer row, `Esc` / scrim / close to dismiss | `[data-access-open]` → `[data-access-panel]` |
| — | Token reveal / copy / reset | buttons in the token block | `[data-token-reveal]`, `[data-token-copy]`, `[data-token-reset]` |
| — | Label filter (R3) | the filter bar's dropdown; writes `data-filter-label-value`, restates the trigger (flat text, R9), re-filters | `[data-filter-label]` → `[data-filter-label-option]` → `[data-filter-label-summary]` |
| I16 | Light dismiss (R9) | a press outside a member, or `Esc`, closes it; opening one member closes the other | `[data-dismiss-on-outside]` — on `[data-project-switcher]` (B02) and `[data-filter-label]` (B04) |
| — | List load (R9) | opening the list view enters `loading`, then settles to `data` — one state on screen at a time | `[data-list]` → `data-list-state` → `[data-skeleton]` / `[data-list-rows]` |
| — | Allow-list switch (R3) | the access panel's toggle; states and dims, nothing else | `[data-cidr-switch]` → `[data-cidr-whitelist]` |
| I13 | Assignee / reporter (R3) | Roster autocomplete — fuzzy match on input, `↑↓`/`Enter`/`Esc`/`Tab`, free text upserts | `[data-assignee-input]` / `[data-reporter-input]` → `[data-assignee-menu]` / `[data-reporter-menu]` → `[data-assignee-option]` / `[data-reporter-option]` |
| I14 | Markdown editor (R3) | Mode tabs set `data-md-mode`; every keystroke repaints the highlight layer and the preview | `[data-md-editor]` → `[data-md-toggle]`, `[data-md-source]`, `[data-md-highlight]`, `[data-md-preview]` |
| I15 | Labels (R5) | The roster control used many times at once — fuzzy match, free text creates by use, case/whitespace-insensitive, removable chips. One control, two placements: the create dialog and the drawer's Labels row are both editable | `[data-label-input]` → `[data-label-menu]` → `[data-label-option]` · `[data-label-chips]` → `[data-label-chip]` → `[data-label-remove]` · `[data-detail-label-input]` → `[data-detail-label-menu]` → `[data-detail-label-option]` · `[data-detail-label-chips]` → `[data-detail-label-chip]` → `[data-detail-label-remove]` |
| I17 | Board empty state (R10) | the board view shows its empty state instead of bare columns whenever no card survives the filters — including a project that holds none at all | `[data-board-view]` → `data-board-state` → `[data-board]` / `[data-empty][data-empty-kind="no-results"]` |
| I18 | Drawer auto-save (R10) | the drawer's assignee, reporter and labels commit as they change — focus loss with a moved value, an accepted roster row, a label chip added or dropped — and report through one state region | `[data-detail-save]` → `data-save-state` · `[data-detail-save-error]` · `[data-detail-save-field]` on `[data-detail-assignee]` / `[data-detail-reporter]` / `[data-detail-labels]` |
| I19 | Status filter (R11) | the bar's second dropdown and its only multi-select: a press toggles one of the seven first-class statuses in or out of the set, `all` clears it, and the pass re-runs. The chosen set is OR inside the field, AND against the other filters | `[data-filter-status]` → `data-filter-status-value` → `[data-filter-status-summary]` / `[data-filter-status-text]` · `[data-filter-status-option]` → `data-status-value` |
| I20 | Roster route (R11) | a press on a name in Active agents switches to the list view and presets the status set to `in_progress,in_review`. It is a **route, not a filter on the name** — the assignee filter has no given name in its domain | `[data-agents-presence]` → `[data-agent-assignee]` → `setView("list")` + `data-filter-status-value` |

The footer's three rows act directly — none of them opens a dialog except the settings
gear, which opens B19. `Esc` closes whatever is open: the drawer, the states showcase, the
access panel, the card's "Move to" menu and the language menu. The two floating menus also
close on any press outside themselves and their trigger.

**R9 named that last rule and widened it.** The shell's `<details class="dropdown">` — the
top bar's project switcher, and the filters bar's label and status selectors — carry
`data-dismiss-on-outside`, and one document-level handler owns them: a press whose target
is not a descendant of a member closes every member that is open, `Esc` does the same, and
opening one closes the others so no two menus overlap. Membership is the attribute, never a
class name or a hook list (I16 above) — which is why R11's status dropdown joined by
carrying the attribute and adding no branch at all. The switcher had no outside-press rule
at all before R9, which is why it stayed open over the filters bar and swallowed presses
meant for the controls underneath. The roster menus and the card menus are not members: they
float from a trigger that is not a `<details>` and keep their own rules.

**The list view is a timeline (R9).** `[data-list]` carries `data-list-state="loading" |
"data"` and shows exactly one of two groups: the skeleton (`[data-skeleton]`) or the rows
(`[data-list-rows]`). The document ships in `data` — the skeleton is `hidden` — and opening
the list view enters `loading` and settles to `data` a beat later, so both states are
reachable by hand and the loading state is a real frame rather than a test hook. A
capture of the list view must therefore **wait out the settle** (the R9 probe waits
900ms); a shutter taken on the switch catches the skeletons, which is the point of the
state but not what `06-list-view` is a picture of.

**The board view is the same shape, one level up (R10, I17).** `[data-board-view]` carries
`data-board-state="data" | "empty"` and shows exactly one of its two children: the board
itself, or the board-level no-results block. The document ships in `data` — the empty block
is `hidden` — and the state flips to `empty` whenever no card survives the filters, which is
also what a project with no cards looks like. Two CSS rules read the attribute, so the pair
is mutually exclusive in the shipped markup with the script off, exactly as the list's pair
is. The column-level "No tasks" block is **not** a member: seven of them live inside the
seven columns and say only that a column is bare. Switching to the list hides the **state
root**, not the board child — otherwise the board's empty state would sit above the list.

**The drawer's three editable fields save as they change (R10, I18).** `[data-detail-save]`
carries `data-save-state="idle" | "saving" | "saved" | "error"`, and `[data-detail-save-error]`
(`role="alert"`) is its only visible half — hidden in every state but `error`. A field whose
value did not move when focus left it is not a write; one settle sequence serves all three,
so quick successive edits fold into one; opening a card resets the state to `idle` and
re-baselines the comparison. The prototype has no backend, so the failure path is the one it
can demonstrate deterministically: a single-valued field that is empty after trimming. The
alert's copy is inlined with no `data-i18n` hook — `test/web/i18n.catalogue.mjs` mirrors the
prototype's `MESSAGES` byte for byte and this round may not touch `test/**`; the implementing
card owns the translation.

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
without the banned identifiers so that a plain text scan of `design/prototype/**` comes back
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
| Dual id | human identifier on the card (mono, capped at eight characters + `…` with the full id on `title` — R8) + internal `td_…` id in the drawer (copyable) |
| Concurrency | `v3`-style version in the drawer + `rev 128` with a live pulse in the top bar |
| Relations | `↑` parent / `→|` blocks / `🔗`-shaped related counters on cards, spelled out in the drawer |
| Comments | human author, agent author and a `decision`-styled comment |
| Activity | 4+ entries per task (created / claimed / status change / commented) |
| Attachments | ≥2 per sampled task |
| Empty states | empty column + no-results — and since R10 the board-level no-results block is the board view's `empty` state, mutually exclusive with the board itself (a project with no cards shows it too) |
| Loading | 3 shimmer rows in the list view, in the list's `loading` state — mutually exclusive with the rows (R9) |
| Drawer saves | assignee / reporter / labels commit as they change; one `data-save-state` region and a `role="alert"` failure block (R10) |
| Drawer identifier | the detail drawer's head shows the card's **whole** id — no slice, no width limit — while the cards and the list rows keep eight characters plus an ellipsis (R12) |
| Status filter | the bar's Status control holds any subset of the seven first-class statuses at once (OR inside the field), and every Active-agents name routes to the list view with `in_progress,in_review` preset (R11) |
| Themes | three states cycled from the footer — **Light** (default) → **Dark** → **Auto** (follows `prefers-color-scheme`, CSS-only) → Light; no-record default is Light, not the system preference |
| Language | English (default) + Chinese via the language dropdown — 224 key pairs, mirrored |
| List columns | six labelled columns — ID · Title · Status · Assignee · Priority · Revision — with the header sharing the row's grid template; the middle three hide at ≤759px (R8) |
| Access model | B19 access & token panel: binds `0.0.0.0`, CIDR whitelist, token required from outside localhost; no user / account / sign-in element anywhere |
| Footer | one row of three equal thirds at ≥1024px, three stacked full-width rows at ≤1023px (R7, revised) — theme · language · settings — a three-state theme cycle, a dropdown and an icon-only button |
| Viewports | 1512 / 1240 / 980 / 760 / 500 — no page-level horizontal overflow |

The board is the only horizontal scroll container; `html`, `body` and `main` never
scroll sideways. Below 1023px the sidebar collapses to an icon rail — and there the footer
becomes a stack: the three cells drop their labels and sit one above the other as centred
icons — and below 760px the top bar wraps and the drawer goes full width. Between **760 and
779px** the top bar also wraps: that band was sized around a bar that still held the
language switch, and the wrap is now kept as reviewed rather than re-tuned (DESIGN.md
§14, §15).

**R8 — the dark dialog, the list header and the identifier's cap.** Three findings from
2026-10-12, all three **design changes** (the prototype had no rule for any of them),
all three now in the prototype. (1) In the dark the create-task dialog separates on
three layers at once: `--scrim` deepens to `rgba(0, 0, 0, 0.55)`, the panel's edge reads
`--color-td-line-strong`, and `--shadow-pop` is overridden to a black double shadow.
Light is untouched, and because `.td-modal-box` inherits `.modal-box` the
create-project dialog gets the same treatment from the same rules. (2) The list header
is a six-track grid sharing `.td-list-row`'s template, so all six columns are labelled
(ID · Title · Status · Assignee · Priority · Revision) and the header can never drift
from the rows it labels; the three middle columns hide at ≤759px on **both** sides.
(3) An identifier renders **at most eight characters plus `…`**, cut in the render layer
by `identifierText()`, with the full id on `title` — so a nine-character id like
`PROJ-0007` reads `PROJ-000…` while the DOM keeps the whole value on the attribute.
`design/fidelity-r8.md` is the contract; `DESIGN.md` §24 and `BLOCKS.md` B07/B08/B09/B10
carry the prose.

**R10 — the board's empty state, drawer saves and a description that fills.** Three more
from 2026-10-12, all three design changes the prototype had no rule for. (1) The board view
gained the list's two-state shape: `[data-board-view]` holds `data-board-state`, and only
one of its two children — the board or the no-results block — is ever on screen, including
when the project holds no cards at all. (2) The drawer's assignee, reporter and labels rows
commit as they change into one state region (`idle` / `saving` / `saved` / `error`), with a
`role="alert"` block as the only visible half. (3) The create dialog's description fills the
column it sits in: `align-items: stretch` on the two tracks, a column flex context on
`.td-field-grow`, and `.td-md-panes` grown from a fixed viewport `clamp` to `flex: 1 1 auto;
min-height: 200px`. `design/fidelity-r10.md` is the contract; `DESIGN.md` §26 and `BLOCKS.md`
B05/B09/B10/B12/B23 carry the prose.

**R11 — the status filter, and the roster names that route to it.** Two requests from
2026-10-13, both about reaching the work in flight. (1) The filters bar gained **Status** —
a `<details class="dropdown">` sibling of the label selector, and the bar's only
**multi-select**: the chosen set rides on `data-filter-status-value` as a comma-joined subset
of the seven first-class status keys (`all` = un-filtered), the trigger reads
`Status: All` / `Status: <Label>` / `Status: <first> +<n-1>`, and each menu row is the 8px
status dot plus the status label. Multiple choice is OR inside the field. (2) Every name in
**Active agents** is now its own `<button data-agent-assignee>`; a press switches to the list
view and presets the status set to `in_progress,in_review`. It is a **route, not a filter on
the name**: the assignee filter's domain is `all|me|human|agent` and holds no given name.
`design/fidelity-r11.md` is the contract; `DESIGN.md` §27 and `BLOCKS.md` B03/B04/B08 carry
the prose.

**R12 — the drawer's head shows the whole id, and nothing else moves.** One request:
the identifier in the detail drawer should read `TD-20261012-222353`, not `TD-20261…`. The
cap R8 put on identifiers has two halves — the render-layer slice (`identifierText()`) and
`.td-id`'s `max-width: 9ch` — and lifting only the slice leaves the *width* clipping the id,
so both are released on **one element**: `openDetail()` writes the card's `data-identifier`
verbatim, and the head span adds **`.td-id-full`** beside `.td-id` (`max-width: none;
overflow: visible; text-overflow: clip`) while `.td-id` keeps the single line. The cards
(B07) and the list rows (B08) keep R8 exactly as it was, `identifierText()` stays for those
two paths, and the drawer root's `data-identifier` — the only thing identity is read from —
is unchanged. Zero new hooks, zero new i18n keys, zero new tokens; the rebuilt `tw.css` gains
exactly one class selector. `design/fidelity-r12.md` is the contract; `DESIGN.md` §28 and
`BLOCKS.md` B07/B08/B09 carry the prose.

---

## Screenshots

| File | State |
|---|---|
| `01-board-1512.png` | default board (MeerkatTaskPanel project, 12 of 18 cards) |
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
| `15-no-javascript.png` | the same document with its `<script>` tags removed — proof that the core structure survives without JavaScript (all 18 cards visible, because the project filter is the only thing JS removes) |
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
| `43-detail-labels.png` | **R5** — the drawer's property grid: the Labels row carries the editable control, its chips filled from the task |
| `44-create-label-narrow-760.png` | **R5** — the same control at 760px, stacked, its menu flipping down over the fields below |
| `45-detail-label-dropdown.png` | **R5 fix** — the **drawer's** Labels row mid-type: fuzzy matches over the board's roster with the `· new` row |
| `46-detail-label-new-chip.png` | **R5 fix** — a name the drawer's roster does not hold accepted into a new chip |
| `47-detail-label-remove.png` | **R5 fix** — a chip's `×` pressed: the chip is gone, the row falls back to the remaining labels |
| `48-detail-label-narrow-760.png` | **R5 fix** — the same control with the drawer full-width at 760px: no overflow |

**V2 logo A recapture (face knockout):** the Sentinel Watch mark gained the candidate-A
«Pin · 克制» face — eyes and mouth cut as negative space by an inline `<mask>`, so the
silhouette does not move and no colour is added. The mark sits in the top bar of nearly
every frame, so **the whole set was recaptured** again; leaving a frame from before the
change would show a product that no longer exists. All **48** frames were re-shot at the
same geometry (device-scale-factor 2, viewports 1512×950 / 2600×1200 / 1240×900 / 980×900
/ 760×900 / 500×900), with transitions disabled and no transient toast, through the real
handlers, under the same frame names — **no frame was added or removed**. **33 frames
moved.** The **15** that come out byte-identical are exactly the ones that never frame the
top bar: the create-dialog clips (`10`, `23`, `26`, `39`–`42`, `44`), the drawer-label
clips (`43`, `45`–`48`), the projects-list clip (`31`) and the footer close-up (`38`).
Each moved frame differs inside the top-bar mark's own box and nowhere else — a 25 × 20
device-pixel patch at `(29,48)` at 980px and wider, at `(21,40)` at 760px and below —
with two explained exceptions: `09-no-results` also carries the 28px mark in the empty
state, and `18-access-token-revealed` shows a token generated from `Date.now()`, so that
one frame differs between any two runs. The face is sub-pixel at the favicon sizes, so
`favicon-16`/`favicon-32` stay the plain V2 silhouette — as declared in `BRAND.md` §5,
*Size behaviour*.

**R9 — the set is not yet recaptured, and these frames are the ones that show it.** R9
changed three things this set photographs: every frame that includes the filters bar now
shows the label trigger as plain text at the selects' metrics instead of a pill (that is
all of the full-board and full-list frames), `06-list-view` now shows the settled list
where the frame before it showed the skeleton *and* the rows at once, and no frame shows
the R9 dismiss behaviour, which is a timing rather than a still. The frames have
deliberately been left exactly as they are rather than half-refreshed: a partial pass
would leave the set claiming a build it no longer matches. The R9 interaction evidence
lives in `design/fidelity-r9.md` §6 (the card's workspace, not the repository), and a
recapture pass belongs with whoever next touches the filter bar — note that the list
frame *must* wait out the new load beat (see *The list view is a timeline*, above).

**R10 — the set is still not recaptured, and R10 widens the same gap.** Three more changes
are visible in frames that exist: every frame that shows the create dialog now shows the
description filling its column (the R4/R5 recaptures shot it stopping short), and the
drawer frames now carry the save-state region — which is `hidden` at rest, so `03-drawer-*`
are unaffected until a field is actually edited. No frame shows the board's empty state,
because no captured frame is of an empty board; the R10 contract's own frames
(`r10-*-board-empty-total0.png` etc.) live in the card's workspace, not here. Per the R9
paragraph above, the set is left whole rather than half-refreshed, and the recapture pass
belongs with whoever next touches either surface — the create-dialog frames have now been
stale through two rounds, which is the reason to fold them into the next pass rather than
defer again.

**R11 — the set is still not recaptured, and R11 adds one more surface to it.** Every frame
that shows the filters bar now shows a fourth control where there were three — the Status
dropdown between Priority and Label — which is the same set of full-board and full-list
frames R9 already flagged. The sidebar frames (`31` and the full-board frames) now show the
Active agents names as buttons, but the face is the text it replaced, so the stills are
unchanged to the eye; no frame shows the status menu open, the set preset to
`in_progress,in_review`, or the list a roster route lands on. Those four states are in
`design/fidelity-r11.md` §6 (the card's workspace, not the repository). The set is again
left whole rather than half-refreshed, and the filters bar has now been stale through three
rounds — the recapture belongs with whoever next touches it, and it can no longer be
deferred without the set claiming a bar the build does not have.

**R12 — the drawer frames are unaffected, and that is the measurement, not a hope.** Each of
the three drawer stills was inspected: `03-drawer-agent.png` and `20-drawer-zh.png` open on
`TD-131`, `04-drawer-human.png` on `TD-122` — all **six characters**, so the head reads the
same characters before and after, and the change is invisible at that length in either
build. What the set therefore *cannot* show is
the round's own subject: a head with an id longer than eight characters. That evidence is a
measurement rather than a still (an 18-character id renders 65.02px wide before and 127.89px
after, in `design/fidelity-r12.md` §5 A3′/B-7). The set is again left whole; the drawer
frames join the filters bar in the recapture that is already owed.

**Sentinel Watch recapture:** the whole set was re-shot onto the current build, because
two changes had landed after the last capture pass and the frames still showed the
product before them — the brand mark (the v2 **Sentinel Watch**, `BRAND.md` §5) and the
naming (`TaskPanel` → `MeerkatTaskPanel` on the top bar, the project switcher, the
sidebar, the drawer's Project row and the access panel's theme block). Frames that reach
the R4/R5 surfaces also pick up what those rounds added and the last pass left stale —
the create dialog's Labels field (`24`, `25`, `28`, `29`, `30`) and the `td-chip` fill
(`06`). All **48** frames were recaptured at **device-scale-factor 2** with transitions
disabled and no transient toast, through the real handlers; `22-lang-menu` is taken with
the dropdown open over the default English board, its current choice `English` marked.
Six frames (`38`–`42`, `44`) come out byte-identical — nothing they show had moved. The
four drawer-label frames (`45`–`48`) previously carried a doubled pixel density from the
older capture path; they are now at the set's own 2×.

**V2 mark recapture:** the Sentinel Watch mark moved to its V2 geometry — five parameters,
the ear radius / inset / height and the watch-dot radius / height (`BRAND.md` §5, §7) — and
the mark sits in the top bar of nearly every frame, so **the whole set was recaptured**;
leaving any frame from before the change would show a product that no longer exists. All
**48** frames were re-shot at the same geometry (device-scale-factor 2, viewports 1512×950 /
2600×1200 / 1240×900 / 980×900 / 760×900 / 500×900), with transitions disabled and no
transient toast, through the real handlers, under the same frame names — **no frame was added
or removed**. **33 frames moved.** The **15** that come out byte-identical are exactly the
ones that never frame the top bar: the create-dialog clips (`10`, `23`, `26`, `39`–`42`,
`44`), the drawer-label clips (`43`, `45`–`48`), the projects-list clip (`31`) and the footer
close-up (`38`).

**R5 recapture:** the right column gained one field, so `10-create-task-modal`,
`23-create-two-col` and `26-create-narrow-760` were re-shot, and six frames are new —
`39-create-label-dropdown`, `40-create-label-new-row`, `41-create-label-new-chip`,
`42-create-label-normalised`, `43-detail-labels` and `44-create-label-narrow-760`. The
board frames are untouched: the round adds a field to the dialog and a row to the
drawer, and no pixel of the board. There is no management entry in any frame, because there
is none in the prototype (DESIGN.md §22).

**R5 fix recapture:** the drawer's Labels row became the editable control, so
`43-detail-labels` was re-shot and four frames are new — `45-detail-label-dropdown`
(the drawer's label input mid-type), `46-detail-label-new-chip` (an unseen name accepted
into a chip), `47-detail-label-remove` (a chip removed) and `48-detail-label-narrow-760`
(the same control at 760px, no overflow). Only the drawer's Labels row changes, so no board
or dialog frame moves. There is still no management entry in any frame (DESIGN.md
§22.5–§22.6, §22.8).

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

Captured with headless Chrome at device-scale-factor 2 with transitions disabled so
the frames are deterministic; `index.html` itself is untouched.

The state shots are driven through the real handlers — the capture page appends a
line that triggers the same `data-*` hooks a click would, so what is captured is
what the prototype actually does, not a hand-styled mock. (Those one-line capture
scripts live in the temporary build directory, never in `design/prototype/`.)

**On the 430px case:** headless Chrome refuses a window narrower than ~500px, so the
narrowest capture is 500px. That is the same CSS path — everything below 559px
collapses the rail to 56px, keeps the board as the only horizontal scroller and makes
the drawer full width — and the assertion for the 430px column of the §7 matrix is
that no *page-level* horizontal overflow exists, which `hOverflow=false` confirms at
every width tested.

---

## Who is on the board

MeerkatTaskPanel is a board for an AI-agent team, so the assignee pool is the team
itself: six agent roles — `elon` (openclaw), `jobs` / `linus` / `simons` (claude),
`turing` (codex), `assistant` (pi) — plus the human owner `Terry`, who files every
task (`data-reporter="Terry"` on all 18 cards). Cards show the platform badge **and**
the role handle; the drawer separates Assignee from Reporter; comments and activity
use the same handles. See [DESIGN.md §10](../DESIGN.md#10-team--identity-model) and the
assignee table in [BLOCKS.md](../BLOCKS.md#assignee-model).

## Notes and known limits

- **Project scoping.** The switcher and the sidebar filter the board by
  `data-project`; MeerkatTaskPanel (12 cards) is the default, so the default board shows
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
