# TaskPanel prototype — Block inventory

The structural contract of `index.html`. Selectors are **`data-*` semantic hooks**;
Tailwind class names are never part of the contract, and no anchor is positional.

Counts in the current build, measured in the live DOM: **7 columns · 18 cards ·
18 detail templates** (`[data-slot]`: 18 description · 18 activity · 16 comments ·
15 agent-session · 11 attachments · 9 relations) · **252 `data-i18n*` hooks** in the
shipped document · **198 catalogue keys, `en` and `zh` in exact parity.**

---

## B01 · App shell

| | |
|---|---|
| Root | `[data-app-shell]` (`.td-shell`) |
| Attribute | theme is held on the document element: `html[data-theme="taskpanel" \| "dark"]` |
| Layout | `grid-template-areas: "topbar topbar" / "sidebar main"` |

## B02 · Top bar

| | |
|---|---|
| Root | `header[data-topbar]` |
| Brand | `[data-brand]` → `.td-logo` (**Signal Bars**, `BRAND.md` §5) + `[data-i18n="app.brand"]` + `[data-i18n="app.tagline"]` |
| Project switcher | `[data-project-switcher]` (`<details class="dropdown">`) · `[data-project-current]` · `[data-project-option="…"]` · `[data-project-new]` · `[data-project-switcher-icon]` |
| Search | `[data-search]` → `[data-search-input]` |
| Filters toggle | `[data-filter-toggle]` (`aria-pressed`, `aria-controls="td-filters"`) |
| View toggle | `[data-view-toggle]` → `[data-view="board" \| "list"]` (`aria-pressed`) |
| Revision | `[data-revision]` → `[data-revision-label]`, `[data-revision-value]`, `.td-live-dot` |
| Primary action | `[data-new-task]` |
| Right cluster | `.td-topbar-actions` — wraps Revision + Primary action; `margin-left: auto` pushes it to the header's right padding edge |

Right-end order is fixed: revision · primary action, grouped as one `.td-topbar-actions`
cluster. The cluster is **right-aligned — flush to the header's right padding edge** (R5):
the search grows to its 340px cap, then `margin-left: auto` on the cluster absorbs the rest,
so `[data-new-task]` hugs the right edge at 1512 / 1240 / 980 / 500 with no trailing gap.
The cluster is a single flex item, so the revision readout and the button never split across
the two rows the bar folds into at 760–779px — there the button sits flush right on its own
row. The `[data-new-task]` hook and its interaction are unchanged: a click still opens the
create dialog (**B10**). There is **no user, account or sign-in element** anywhere
in the bar.

The theme and language controls **left the bar in review round v1.2** and became three
direct controls in the sidebar footer in **v1.4** (B03 · theme switch / language menu /
B19). The bar holds no display-mode control of any kind — restated and re-checked in **R3**,
which changed the brand mark in this bar but touched no control in it.

**The brand glyph is the Signal Bars mark** (R3), not a generic icon: three capsules
bottom-aligned at `y = 27` with a delivered node above the tallest. It is drawn inline at
18px, `aria-hidden`, on a `0 0 32 32` viewBox, and its two fills are
`var(--color-td-ink)` and `var(--color-td-accent)` — so one element serves both themes.
`favicon.svg` is the same geometry with a `prefers-color-scheme` pair.

## B03 · Sidebar

| | |
|---|---|
| Root | `aside[data-sidebar]` |
| Nav | `[data-nav]` → `[data-nav-item="board" \| "list" \| "activity"]` (`aria-current="page"`) |
| Projects | `[data-project-list]` → `[data-project="…"]` (`aria-current="page"`) → `.td-side-icon` (prefix monogram, rail only) + `[data-project-count]`; each item carries `[data-order-score]` + `[data-order-rank]` (see below) |
| Agents | `[data-agents-presence]` → **one row per platform**: `[data-agent-platform="claude\|openclaw\|codex\|pi"]` + `[data-presence="running\|idle"]` |
| States preview | `[data-states-open]` — sidebar footer control, opens **B18** |
| Footer controls | `[data-access-status]` — **three equal thirds** (`display: grid`, `repeat(3, minmax(0, 1fr))`), each cell a `.td-access-cell` block button with its icon and label centred, separated by a hairline on the inline start |

The three cells, left to right, and what each one does (**review round v1.4**):

| Cell | Hook | What the cell shows | Affordance |
|---|---|---|---|
| Theme (left) | `[data-theme-switch]` → `[data-theme-icon="light" \| "dark"]` + `[data-theme-label]` | the theme in force — `Light`/`Dark` (浅色/深色) | **inline switch** — one press flips light ↔ dark, no dialog |
| Language (middle) | `[data-lang-select]` + `[data-lang-label]` + `.td-caret` | the language in force — `EN`/`中文` | **dropdown menu** → `[data-lang-menu]` → `[data-lang-option="en" \| "zh"]` |
| Settings (right) | `[data-access-open]` | nothing but the gear glyph | opens **B19** `[data-access-panel]` |

**The state is in the label.** `applyTheme()` writes `html[data-theme]`, the sun/moon
`[data-theme-icon]`, `[data-theme-label]` and the switch's `aria-pressed` +
`aria-label` (which names both the state in force and the state one press reaches);
`applyLanguageOptions()` writes `[data-lang-label]` and the `aria-pressed` of both
`[data-lang-option]` rows. The theme cell and the language trigger therefore state the
current mode without anything being opened, and both are rewritten by the same functions
the press and the pick call, so cell and document cannot disagree. The settings cell
carries no visible text at all: the gear is named by `data-i18n-aria-label="access.open"`
alone. Cells carry `:focus-visible` rings and are keyboard reachable. The v1.2
`[data-theme-toggle]` / `[data-lang-toggle]` controls stay **gone**, and the v1.3 dialogs
are gone with them — see "Retired" below.

**The language menu is a floating menu, not a panel.** Trigger and menu are two elements:
the cell in the footer, and `[data-lang-menu]` at the end of the document next to the
card's "Move to" list. The menu is positioned `position: fixed` above the cell
(`openLangMenu()`), because the sidebar is a scroll container and an absolutely positioned
menu would be clipped by it. Choosing an option switches the document
(`applyLang` → `setLang`) and closes the menu; `Esc` and a press outside both close it
too. The current language is marked with `aria-pressed="true"`, accent copy **and** a
tick. The list is data: a third language is one `<li>` plus its dictionary keys.

The footer carries *controls*, not *reachability*: the former `[data-user]` block
(avatar + name + role) was **removed** in review round v1.1, along with its `.td-user`,
`.td-user-text` and `.td-avatar-lg` styles, and the `Local · localhost` readout plus its
green status dot were **removed** in review round v1.2 (Terry, 2026-10-08 21:47) — no
bind-address status is shown anywhere in the chrome; the bind address is stated inside
B19 instead. The assignee model further down this file is a separate concern and is
unchanged.

At the ≤1023px rail the three thirds hold (the row is never allowed to wrap) and the
labels drop out with the rest of the sidebar text, so each cell is a centred 24px icon:
three 14px glyphs still fit the 64px rail (56px under 560px) without horizontal overflow.
The `.td-caret` goes with the labels — a third of the rail cannot hold a globe and a
disclosure arrow side by side — and the language menu still opens from the remaining
globe, floating over the board rather than inside the 64px column.

**The `PROJECTS` list is ordered by activity, not alphabetically or by creation.** Items
render in the order the **server** computed — a weighted rank over 7-day and 30-day
activity plus creation recency (`ARCHITECTURE §4.6`; full rule in `DESIGN.md` §20), with
tie-breaks and archived-project exclusion applied there. The frontend **consumes the order
only** and does no computation. Each item exposes the decision for machine checks:
`[data-order-score]` (the composite, e.g. `0.867`) and `[data-order-rank]` (`1`…`N`). The
demo order is **Orchestrator → TaskPanel → Site Refresh** (scores 0.867 / 0.667 / 0.467),
deliberately different from creation order so the weighting is visible. Consistency: ranks
are contiguous from `1` and scores are non-increasing down the list; `[data-project-count]`
(12 / 4 / 2) is independent of the ordering and unchanged.

## B04 · Filters bar

| | |
|---|---|
| Root | `section#td-filters[data-filters]` |
| Controls | `[data-filter-assignee]` (all/me/human/agent) · `[data-filter-priority]` (all/urgent/high/medium/low/none) · `[data-filter-label]` (all + 16 labels) |
| Label selector | `[data-filter-label]` on a `<details class="dropdown">`; the chosen value lives on `data-filter-label-value`, the trigger states it via `[data-filter-label-summary]`, and the menu holds `[data-filter-label-option]` × 17, each with `data-label-value` and `aria-current` on the chosen one |
| Actions | `[data-filter-clear]` · `[data-filter-count]` (`aria-live="polite"`) |

**The label selector is a dropdown, not a `<select>`** (R3). Its hook name did not move:
`[data-filter-label]` is still the element the interaction layer reads, but it now reads
an attribute rather than a form value, because the addendum names this control
specifically — it is the one filter with seventeen choices and it has to show which one is
in force without being opened.

## B05 · Board

| | |
|---|---|
| Root | `div[data-board]` |
| Children | exactly 7 × `[data-column]`, in the fixed order `backlog, todo, in_progress, in_review, blocked, done, canceled` |
| Scroll | the only horizontal scroll container in the document |

## B06 · Column

| | |
|---|---|
| Root | `section.td-col[data-column][data-status]` |
| Hooks | `[data-column-header]` · `[data-column-dot]` · `[data-column-name]` · `[data-column-count]` · `[data-column-add]` · `[data-column-body]` · `[data-column-progress]` |
| States | default · `data-drag-over="true"` · empty (`[data-empty]` inside the body) · live count badge |

`[data-column-progress]` (R3) is a daisyUI `progress` sitting directly under the header.
Its `value` is the column's visible count and its `max` is the board's total visible count,
so it reads that column's **share of the board** — the shape of the work before any card is
read. `refreshColumns()` is the only writer, and it never emits `max="0"`, since a progress
element with a zero maximum is a dividing error.

## B07 · Card — 18 instances

| | |
|---|---|
| Root | `article.td-card[data-card]`, `draggable="true"` |
| Scalars | `data-identifier` `data-id` `data-status` `data-priority` `data-project` `data-assignee` (role handle) `data-assignee-kind` (`human\|agent`) `data-reporter` `data-labels` `data-version` `data-comments` `data-attachments` `data-relations-parent` `data-relations-blocks` `data-relations-related` `data-done` `data-canceled` |
| Parts | `[data-card-stripe]` · `[data-card-identifier]` · `[data-card-title]` (a real `<button>`) · `[data-card-labels]` → `[data-label]` · `[data-card-priority]` · `[data-card-assignee]` (monogram avatar) · `[data-card-agent-badge]` (`data-agent-platform`) · `[data-card-agent-role]` · `[data-card-comment-count]` · `[data-card-attachment-count]` · `[data-card-relations]` → `[data-relation-parent \| blocks \| related]` · `[data-card-menu]` |
| Identity slot | human card → monogram avatar visible, badge and role empty+hidden. Agent card → avatar hidden but still carrying the monogram, `[data-card-agent-badge]` **and** `[data-card-agent-role]` visible, so every card states both the platform and the role name. |
| States | default · `:hover` · `:focus-within` · `aria-selected="true"` · `data-dragging="true"` · `data-done="true"` · `data-canceled="true"` |

## B08 · List view

| | |
|---|---|
| Root | `section[data-list]` — mutually exclusive with `[data-board]` |
| Hooks | `[data-list-rows]` (host) · `[data-list-row]` (`data-identifier`) |
| Row parts | `[data-list-identifier]` · `[data-list-title]` · `[data-list-status]` → `[data-list-status-label]` · `[data-list-assignee]` (role handle) · `[data-list-priority]` → `[data-list-priority-label]` · `[data-list-revision]` |
| Template | `template[data-list-row-template]` |

Rows are projected from the cards that survive the active filters, so board and
list can never disagree.

## B09 · Task detail drawer

| | |
|---|---|
| Root | `aside[data-detail-drawer][data-state="closed\|open\|closing"]` (`role="dialog"`, `aria-modal="true"`) |
| Scrim | `[data-detail-overlay][data-state]` |
| Head | `[data-detail-identifier]` · `[data-detail-title]` · `[data-detail-status-chip]` → `[data-detail-status-chip-label]` · `[data-detail-close]` |
| Properties | `[data-detail-props]` → status `[data-detail-status]` / `[data-detail-status-label]` · priority `[data-detail-priority]` / `[data-detail-priority-label]` · assignee `[data-detail-assignee]` / `[data-detail-assignee-avatar]` / `[data-detail-assignee-label]` (**an input**, see B22) / `[data-detail-assignee-platform]` (platform badge, hidden for the human owner) · **reporter** `[data-detail-reporter]` / `[data-detail-reporter-avatar]` / `[data-detail-reporter-label]` (an editable control — see B22) · project `[data-detail-project]` / `[data-detail-project-label]` · internal id `[data-detail-id]` + `[data-detail-id-copy]` (`data-copy-value`) · `[data-detail-version]` |
| Body | `[data-detail-description]` (rendered GFM) · `[data-detail-relations]` → `[data-relation-link]` · `[data-detail-agent-session]` → `[data-detail-agent-session-body]` → `[data-agent-session]` · `[data-detail-attachments]` · `[data-detail-comments]` · `[data-comment-form]` → `[data-comment-input]`, `[data-comment-submit]` · `[data-detail-activity]` |
| Source | `template[data-detail-for="TD-…"]` holds one `[data-slot="description \| relations \| agent-session \| attachments \| comments \| activity"]` per card, wrapped by `[data-detail-templates]` |

## B10 · Create-task modal — two columns

`dialog[data-create-task]` → `.td-modal-box` → `form[data-create-task-form]` →
`[data-create-two-col]`, which holds exactly two tracks:

| Column | Hook | Fields |
|---|---|---|
| Left — the work | `[data-create-left]` | `[data-create-task-title]` (+ hint) · `[data-create-task-description]`, which is `[data-md-source]` inside **B23** |
| Right — its routing | `[data-create-right]` | `[data-create-task-priority]` · **assignee** (**B22**) · `[data-create-task-project]` · `[data-create-task-status]` · **reporter** (**B22**) · **parent** (**B24**) · **depends-on** (**B24**) |

**R4 — the dialog grew and the left column leads.** `.td-modal-box` is
`min(1120px, 100vw − 32px)` tall to `100vh − 48px` with its own scroller (R3: 880px
wide, sized to its content). The two tracks are `minmax(0, 1.6fr)` / `minmax(0, 1fr)`,
so the description editor holds the wider and much taller pane the work deserves while the
routing column keeps a compact one. Both tracks stay `minmax(0, …)`, so neither a long
title nor the editor can push the dialog wider than its own box — no horizontal overflow
at 1512 / 1240 / 980 / 760 / 430.

At ≤760px the tracks stack (`.td-two-col` collapses to one column) and the dialog scrolls
internally, so every field stays reachable on a phone-width window.

`[data-modal-close]` closes it, and `resetCreateTask()` is the single writer of its opening
state — it also serves as the reset after a submit, so a second task starts exactly where
the first one did. R4 taught it two more things to clear: the relation controls' inputs,
and the depends-on chips, which a native form reset cannot reach.

Labels are not a field: the create form never had one, and the addendum lists them as
optional. The assignee is no longer a `<select>`; see B22. The two relation controls
are marked **Optional** and leave the task creatable when empty; see B24.

## B11 · Create-project modal

`dialog[data-create-project]` → `form[data-create-project-form]` →
`[data-create-project-name]` · `[data-create-project-prefix]` · `[data-modal-close]`.

## B12 · Empty states

`[data-empty]` with `data-empty-kind="column"` (one per column, revealed when the
column has no visible card) or `data-empty-kind="no-results"` (one per board,
revealed when a filter matches nothing).

**The large empty state carries the brand mark** (R3): `[data-empty-lg]` with
`data-empty-kind="no-results"` opens on a 28px Signal Bars mark, which replaced the
generic no-results glyph. Its two lead bars are `--color-td-ink-3` rather than
`--color-td-ink`, so on an empty board the accent node is still the only lit element on
the surface.

## B13 · Loading state

`[data-skeleton]` — three shimmer rows at the top of the list view. (The showcase in
B18 has its own `[data-loading-state]` demo.)

## B14 · Toast region

`div[data-toast-region]` (`role="status" aria-live="polite"`) plus
`template[data-toast-template]` → `[data-toast][data-toast-kind="info\|success\|danger"]`
→ `[data-toast-text]`. Auto-dismiss after 2.5s. The three kinds are also rendered
statically inside B18 (`data-state="static"`, never auto-dismissed).

## B15 · Legend

`div[data-legend]` → `[data-legend-status]` (7 status chips) ·
`[data-legend-priority]` (5 priority chips). Sits at the bottom of the sidebar so
every status and priority is visible in one screenshot.

## B16 · Agent session provenance

`[data-agent-session]` — rendered inside `[data-detail-agent-session]` from the
card's template, with `[data-agent-platform]`, `[data-agent-platform-value]`
(`--agent-platform claude`), `[data-agent-session-id]` and `[data-agent-resume]`.
All **15 agent cards** carry a session block whose platform matches the card's
`data-agent-platform` and whose session id is prefixed with that platform; the three
human cards carry none and the drawer hides the section for them.

## B17 · Error state

| | |
|---|---|
| Root | `[data-error-state]` (`role="alert"`), hidden by default |
| Parts | danger-coloured icon · `[data-i18n="error.title"]` · `[data-i18n="error.hint"]` · `[data-error-retry]` |
| Surface | `--color-td-danger-soft` background — the token the style guide reserves for error surfaces |
| Wiring | `Retry` re-runs the real render pass (`applyFilters`) and confirms with a success toast |

B17 is demonstrated inside the B18 gallery rather than on the board, because the board
only raises it when a load fails and this prototype performs no loads. It is therefore
hidden by default for the same reason the panel is, and it is reachable in one click
from the sidebar.

## B18 · States showcase

| | |
|---|---|
| Root | `[data-states-panel][data-state="closed\|open"]` (`role="dialog"`, `aria-modal="true"`, `aria-hidden`), hidden by default |
| Opener | `[data-states-open]` in the sidebar footer |
| Dismiss | `[data-states-close]` · `[data-states-overlay]` · `Esc` — same `data-state` + `hidden` pattern as the detail drawer |
| Demos | `[data-loading-state]` (skeleton cards) · `[data-empty-column]` · `[data-empty-results]` · **B17** `[data-error-state]` · `[data-toast-states]` → the three `[data-toast]` kinds |

The gallery is a prototype review surface: it puts every non-default state in one
frame so coverage can be checked in a single screenshot. It adds no framework — a
scrim, a panel and two jQuery handlers.

## B19 · Access & token settings

| | |
|---|---|
| Root | `[data-access-panel][data-state="closed\|open"]` (`role="dialog"`, `aria-modal="true"`, `aria-hidden`), **hidden by default** with the `hidden` attribute |
| Opener | `[data-access-open]` in the sidebar footer |
| Dismiss | `[data-access-close]` · `[data-access-overlay]` · `Esc` — same `data-state` + `hidden` pattern as the drawer and the states showcase; focus returns to the opener |
| Bind copy | `[data-i18n="access.model.bind"]` |
| CIDR whitelist | `[data-cidr-whitelist]` (`data-cidr-enabled="true\|false"`) → `[data-cidr-list]` → **n ×** `[data-cidr-row]` (`[data-cidr-value]` input + `[data-cidr-remove]`) · `[data-cidr-add]` |
| Allow-list switch | `[data-cidr-switch]` — a daisyUI `toggle` stating whether the list above is in force |
| CIDR copy | `[data-i18n="access.cidr.note"]` · `[data-i18n="access.cidr.add"]` · `[data-i18n="access.cidr.remove"]` · `[data-i18n="access.cidr.value"]` |
| Token rule | `[data-i18n="access.model.token"]` |
| Token block | `[data-token-block]` (`data-token-revealed="true\|false"`) → `[data-token-value]` · `[data-token-reveal]` (icons `[data-token-icon="hidden"\|"shown"]`) · `[data-token-copy]` · `[data-token-reset]` |
| Captions | `[data-i18n="access.token.generated"]` · `[data-i18n="access.token.private"]` |

The panel states the v1.2 access model: the board **binds to `0.0.0.0`** and is reachable
from other devices on the network; a **CIDR whitelist** restricts which source ranges may
reach it (`192.168.0.0/16`, `10.0.0.0/8`, `203.0.113.0/24` ship seeded, and rows can be
added or removed); and **requests from outside localhost must present the token**. The
v1.1 copy (`Local only by default — … listens on localhost.` / `Remote (public) access
requires a token.`) and the two Local/Remote scope rows it headed are gone.

The whitelist is a **front-end placeholder**: `[data-cidr-add]` appends one empty row and
focuses its input, `[data-cidr-list]` delegates every `[data-cidr-remove]` to its own
`[data-cidr-row]`. Rows live in the DOM only — nothing is validated, compared, stored or
sent.

**The allow-list switch (R3)** is a daisyUI `toggle`, and it is display only: the switch
moves, `[data-cidr-whitelist]` carries the state as `data-cidr-enabled`, the list dims to
45% when it is off, and a toast says which way it went. Nothing is written, sent or
enforced. Note the two names are deliberately different — `[data-cidr-switch]` is the
input, `data-cidr-enabled` is the section's state — because a hook and the state it
writes must not share one attribute name.

`[data-token-value]` renders the stand-in masked as `td_••••••••••••` (the `td_` prefix
stays visible); `Reveal` toggles the mask only, `Copy` reports a toast and touches no
clipboard, `Reset` mints a new value in memory and shows it. The value is produced by
`Math.random()` + `Date.now()`, held in `state.token`, and written to the DOM and
nowhere else — **no storage, no transport, no credential, nothing persisted.** See
DESIGN.md §12.

## B20 · Theme switch — retired in v1.4

**Removed, not hidden.** The v1.3 theme dialog (`[data-theme-modal]`,
`[data-theme-choice]`, `[data-theme-close]`, `[data-theme-overlay]`), its
`.td-choices` / `.td-choice` rows and its catalogue keys (`access.theme.open`,
`access.theme.title`, `access.theme.group`, `access.theme.close`) are **deleted** from
`index.html`, `app.js`, `src/input.css` and the built `tw.css` — no selector reaches them
and no `B20` hook exists in the document. What the left footer cell does now is the
**inline switch** in B03 above. The one part that survives is the vocabulary: the cell
still names the theme in force through `access.theme.light` / `access.theme.dark`.

## B21 · Language menu — replaced in v1.4

**Removed, not hidden.** The v1.3 language dialog (`[data-lang-modal]`,
`[data-lang-choice]`, `[data-lang-close]`, `[data-lang-overlay]`), the same
`.td-choices` / `.td-choice` rows and the keys `access.lang.title` / `access.lang.close`
are **deleted**. The middle footer cell now opens the **dropdown menu** in B03 above, which
takes a new number: `[data-lang-option="en" | "zh"]` replaced `[data-lang-choice]`, and
`access.lang.en` / `access.lang.zh` now name the *options* (`English` / `中文`) while
`access.lang.short.en` / `access.lang.short.zh` name the *trigger* (`EN` / `中文`).

**Only one dialog is left.** B19 is the document's only `role="dialog"` panel; the theme
and language surfaces never had one and no longer have one. `Esc` still closes whatever is
open — the drawer, the states showcase, the access panel and now both floating menus.

---

## B22 · Assignee / Reporter control (R3)

One control, two rosters, four placements.

| | |
|---|---|
| Hooks | `[data-assignee-input]` · `[data-assignee-menu]` · `[data-assignee-option]` (`data-assignee-value`, `data-assignee-kind`, `data-agent-platform`) · `[data-reporter-input]` · `[data-reporter-menu]` · `[data-reporter-option]` (`data-reporter-value`) |
| Shell | `.td-combo` (positioned) → `input.input` + `ul.menu.td-combo-menu` (daisyUI `menu`) |
| Placements | create dialog — assignee and reporter (B10) · detail drawer — `[data-detail-assignee-label]` and `[data-detail-reporter-label]` are the inputs, inside `.td-prop-combo` |
| Options | generated from the roster on every keystroke; the static seven on the assignee menu and the one on the reporter menu are the no-JS floor |
| Keyboard | `↑`/`↓` move `aria-selected`, `Enter` accepts, `Esc` dismisses (`stopPropagation`, because the drawer also listens), `Tab` closes |
| **No management entry** | there is no control anywhere that adds, renames or removes a roster entry — the list grows only by being used |

The two rosters (DESIGN.md §18.3):

| roster | seeded from | grows when |
|---|---|---|
| assignee | the seven handles the board names, each with its kind and platform | a task is created or re-assigned with a name the roster does not hold |
| reporter | `data-reporter` across the 18 cards, read at first pass | a task is created with a new reporter |

Matching is a case-insensitive substring, ranked prefix → contains → subsequence; the
subsequence pass runs only when nothing contains the query. A name that is not in the
roster is offered as a `· new` row while you type and is added the moment it is used. An
unknown assignee defaults to `human`, because a handle the board has never seen carries no
platform to claim. Both rosters live in memory and are written to nothing.

## B23 · Markdown editor (R3)

| | |
|---|---|
| Root | `[data-md-editor]` |
| Mode | `[data-md-toggle="write \| preview \| split"]` (`aria-pressed`) sets `data-md-mode` on `.td-md-panes`; `setMarkdownMode()` is the only writer |
| Source | `[data-md-source]` — a `<textarea>`, also `[data-create-task-description]` |
| Highlight layer | `[data-md-highlight]` — a `<pre>` painted behind the textarea, `aria-hidden`, scrolled from it |
| Preview | `[data-md-preview]` — rendered HTML inside `.td-gfm` |
| Vendored | `vendor/markdown-lite.js` (`MarkdownLite.render`) · `vendor/highlight-lite.js` (`HighlightLite.markdown`, `HighlightLite.code`) |

The source pane is a **transparent textarea stacked on a highlighted `<pre>`**; both carry
`.td-md-text`, which owns every property that can move a glyph, so the painted layer and the
real input break lines in the same place. The `pre` and the textarea are the *only* two
elements in the editor whose geometry must agree — everything else follows from them.

**R4 — both panes scroll, and the highlight layer follows.** The edit side `.td-md-source`
carries an explicit `height: 100%` beside `overflow-y: auto`, so overflowing source scrolls
the way the preview always did; with scripting off the textarea keeps that native scroller
and the layout is unchanged. `.td-md-panes` is `clamp(280px, 46vh, 520px)` — a markedly
taller editing area than R3's fixed 230px, still bounded so the dialog scrolls rather than
runs off the screen.

The scroll binding is **direct**, not delegated: `scroll` does not bubble, so R3's
`$(editor).on("scroll", "[data-md-source]", …)` never fired and the highlight `<pre>` stayed
put while the text scrolled under it — the "Write mode will not scroll" report. Binding the
handler to each source (`.on("scroll")` on the element, keyed off the same
`[data-md-source]` hook) puts the two back on one `scrollTop`.

Both vendored files are loaded with a plain `<script>` tag from `prototype/vendor/`, make
no network request, read no storage, and are first-party rather than downloaded (DESIGN.md
§18.4). Nothing is submitted, fetched or stored: the editor renders what is typed, in the
page.

---

## B24 · Parent / Depends-on control (R4)

Two optional relation fields in B10's right column. They are B22's control pointed at a
different source: the **current project's cards**, not a people roster.

| | Parent | Depends on |
|---|---|---|
| Root | `[data-create-task-parent]` (`.td-combo`) | `[data-create-task-depends]` (`.td-combo`) |
| Input | `[data-parent-input]` | `[data-depends-input]` |
| Menu | `[data-parent-menu]` → `[data-parent-option]` (`data-parent-value`) | `[data-depends-menu]` → `[data-depends-option]` (`data-depends-value`) |
| Selection | single — the input states the identifier, `[data-parent-clear]` empties it | multi — one `[data-depends-chips]` chip per task (`[data-depends-chip]`, each with `[data-depends-remove]`) |
| Semantics | `task_relations.type='parent'`, **one** parent | prerequisite DAG (no cycles) |

Both are labelled **Optional** and both leave the task creatable when empty.

| | |
|---|---|
| Options | read from `[data-card]` filtered to the project selected in `[data-create-task-project]` (default: the working project), as **identifier + title** — `identifier` is the value, the title is the row's trailing text and the chip's tooltip |
| Ranking | the same substring ranking as B22 (prefix → contains → subsequence), over identifier and title together |
| Free text | **off** (`freeText: false`): a relation can only point at a task that already exists, so there is no `· new` row and nothing is added to any roster |
| Dedupe | a chosen chip is dropped from the menu on the next render; choosing it twice is a no-op |
| Markup | the menus ship a 12-row inert seed (the working project's tasks) as the no-JS floor, redrawn from the live board the moment the control is focused |
| Keyboard | `↑`/`↓` move, `Enter` accepts (opens the menu when it is closed, so it can never submit the form from these inputs), `Esc` dismisses, `Tab` closes — the B22 loop, keyed off these hooks |

**Menus never tear the dialog.** `.td-combo-menu` is `flex-wrap: nowrap` with `flex: none`
rows, because daisyUI's `menu` is `column wrap` and turned a twelve-task list into two
narrow columns. Inside the dialog the menu is clipped by `.td-modal-box`'s own scroller, so
`positionComboMenu()` measures the row and flips the menu above its control (CSS
`.td-combo[data-drop="up"]`) when there is not room below — the depends-on field, last in
the column, opens upward.

**UI only.** No relation is written anywhere: no graph is built, no cycle is checked, and
the chips reach neither the created card nor any store. The plan's ≤8 chain length and ≤8
fan-in are noted in the spec, not enforced here.

---

## Assignee model

The board belongs to an AI-agent team, so the assignee pool is the six agent roles
plus the human owner. Nothing else appears as an assignee, comment author or activity
actor.

| Member | Kind | Platform | Cards |
|---|---|---|---|
| `elon` | agent | `openclaw` | TD-131, TD-124, TD-118 |
| `jobs` | agent | `claude` | TD-125, TD-121 |
| `linus` | agent | `claude` | TD-128, TD-123, TD-115 |
| `turing` | agent | `codex` | TD-129, TD-134, TD-127 |
| `simons` | agent | `claude` | TD-130, TD-117 |
| `assistant` | agent | `pi` | TD-133, TD-119 |
| `Terry` | human | — | TD-126, TD-112, TD-122 (owner, reporter of all 18) |

Every card carries `data-reporter="Terry"`: the owner files the task, an agent works
it. The drawer shows Assignee (with the platform badge for agents) and Reporter as
separate properties, and the lifecycle shows up again in the activity feed
(`Terry created this task`, `<role> claimed the task`).

**Since R3 this table is also the assignee roster's seed** (B22): the seven handles above
are what the autocomplete offers, with the same kinds and platforms. The reporter roster is
not declared — it is read off the cards' `data-reporter` at first pass, which today yields
`Terry` alone. Neither roster is editable from the interface; both grow by being used.

---

## Auxiliary hooks (implementation detail, not part of §4)

| Hook | Purpose |
|---|---|
| `[data-move-menu]` → `[data-move-to="status"]` | the single shared "Move to" menu reused by every card (I2 fallback for drag) |
| `[data-lang-menu]` → `[data-lang-option="en" \| "zh"]` | the language dropdown, floating at the end of the document for the same reason (the sidebar clips absolute children) |
| `[data-drop-placeholder]` | transient placeholder bar created during `dragover` |
| `[data-states-overlay]` / `[data-access-overlay]` | scrims behind B18 and B19 — the only two surfaces left that have one |
| `template[data-toast-template]` / `template[data-list-row-template]` / `template[data-detail-for]` | inert markup sources for the interaction layer |
| `[data-detail-slot-source]` | transient wrapper jQuery builds while copying a template into the drawer |
| `[data-label="…"]` | one chip per card label |
| `[data-filter-label-summary]` | the badge on the label dropdown's trigger, restated from `data-filter-label-value` |
| `[data-column-progress]` | the occupancy bar under each column head |
| `[data-cidr-enabled]` | the allow-list section's on/off state, written by `[data-cidr-switch]` |
| `data-assignee-value` / `data-reporter-value` | the name a roster option carries, read by `comboAccept()` |
| `[data-combo-new]` | marks the generated row that offers a name the roster does not hold yet |

---

## i18n hooks

English is the default language; the `中文` option in the **language menu** switches to
Chinese (DESIGN.md §13). Five attributes carry the keys, on every piece of user-visible
copy:

| Hook | Sets |
|---|---|
| `data-i18n` | the element's text |
| `data-i18n-placeholder` | `placeholder` |
| `data-i18n-aria-label` | `aria-label` |
| `data-i18n-title` | `title` |
| `data-i18n-arg` | the `%s` value for any of the four above; it is resolved as a key first, so `column.add` + `status.todo` reads `Add task to To Do` / `在待办中新建任务` |

The catalogue is the in-memory `MESSAGES` object at the top of `app.js` — **198 keys per
language, mirrored 1:1** (verified by set equality, not by eye), never an external file.
Copy `app.js` composes at runtime (toast sentences, list rows, card aria labels, the token
mask) is keyed there too.

Every string the v1.4 footer introduces is in that catalogue:

| Keys | Where |
|---|---|
| `access.theme.switch.dark` · `access.theme.switch.light` | the theme switch's `aria-label` / `title`, which name the state one press reaches (`applyTheme`) |
| `access.theme.light` · `access.theme.dark` | the current-value text in the theme cell (`applyTheme`) |
| `access.lang.open` · `access.lang.group` | the trigger's `aria-label` / `title` and the menu's own label |
| `access.lang.en` · `access.lang.zh` | the two `[data-lang-option]` rows — each language names itself (`English` / `中文`) in both catalogues |
| `access.lang.short.en` · `access.lang.short.zh` | the current-value text in the language trigger (`applyLanguageOptions`) — `EN` / `中文` |
| `toast.themeDark` · `toast.themeLight` · `toast.langEn` · `toast.langZh` | what the switch and the menu report when they act |

The settings cell needs no key for a label: it has none. Its accessible name is
`access.open`, the same key the panel's own opener always used.

The rewritten B19 carries `access.model.bind` · `access.cidr.note` · `access.cidr.add` ·
`access.cidr.remove` · `access.cidr.value` · `access.model.token`, and since R3 also
`access.cidr.enabled` / `access.cidr.disabled` for the allow-list switch. Rows the whitelist
adds at runtime are authored with the same `data-i18n-aria-label` / `data-i18n-title`
hooks, so the next language switch translates them like any seeded row.

The v1.2 keys the retired switches used (`access.theme` / `access.lang` as switch labels,
`access.lang.en` / `access.lang.zh` as segments, `theme.switchToDark` /
`theme.switchToLight`) are **gone from both dictionaries**, as are the v1.3 dialog keys
(`access.theme.open` · `access.theme.title` · `access.theme.group` · `access.theme.close` ·
`access.lang.title` · `access.lang.close` · `access.settings`) — nothing references any of
them, so the catalogue carries no copy for a surface that no longer exists.

`<html lang>` follows the pick (`en` / `zh-CN`), the `[data-lang-option]` rows move
their `aria-pressed`, and the drawer body — which arrives from an inert `<template>` that
the document-wide pass cannot reach — is translated again when it lands. A language
switch also re-derives everything `app.js` owns, so an open drawer, the list view, the
footer cell and the result counter all change language in place.

Per-column empty-state hints and add-button labels share **one** key pair each and take
their status name through `data-i18n-arg` (`status.backlog`, …) rather than fourteen
separate keys.

**R3 adds thirteen keys**, all mirrored:

| Keys | Where |
|---|---|
| `createTask.field.reporter` | the Reporter field label in B10 |
| `combo.assigneePlaceholder` · `combo.reporterPlaceholder` · `combo.hint` | the two roster controls' placeholder and `title` (B22) |
| `combo.empty` · `combo.new` | what the roster menu says when nothing matches, and the `· new` marker on a name the roster does not hold |
| `md.label` · `md.write` · `md.preview` · `md.split` · `md.hint` | the Markdown editor's mode tabs and its hint (B23) |
| `access.cidr.enabled` · `access.cidr.disabled` | the allow-list switch's two toasts (B19) |

**R4 adds nine keys**, all mirrored:

| Keys | Where |
|---|---|
| `createTask.field.parent` · `createTask.field.parentHint` | the Parent field's label and hint (B24) |
| `createTask.field.depends` · `createTask.field.dependsHint` | the Depends-on field's label and hint (B24) |
| `createTask.optional` | the `Optional` chip beside both relation labels (B10 / B24) |
| `combo.parentPlaceholder` · `combo.dependsPlaceholder` | the two relation inputs' placeholders (B24) |
| `combo.taskHint` · `combo.clear` | the relation inputs' `title`, and the parent clear button's label (B24) |
| `combo.noTasks` | what a relation menu says when the project has no matching task (B24) |

---

## Consistency items ("一致项")

1. **Every card** carries the identical hook set — a filter, drag or drawer code
   path never needs to special-case a card.
2. **Every column** carries the identical hook set and the identical empty-state block.
3. **Colour is never inline**: components read `--status-color` / `--pri-color`,
   which are set by `[data-status]` / `[data-priority]` attribute rules in
   `src/input.css`. Moving a card updates one attribute and the stripe, the dot and
   the chips follow.
4. **Mono discipline**: every identifier, internal id, session id, version, count,
   timestamp and agent role handle uses `.td-mono` with tabular numerals.
5. **Ids in the document** are unique and only used for `label[for]` /
   `aria-labelledby` / `aria-controls` — never as a styling hook.
6. **No block is hidden by the stylesheet**: `board ↔ list`, drawer, modals, the
   states gallery and the access panel are toggled by the `hidden` attribute or
   `data-state`, so the static document is readable with JavaScript disabled.
7. **One identity model** everywhere: `data-assignee` is always a role handle from
   the table above, `data-assignee-kind` always separates agent from human, and
   `data-agent-platform` always names one of claude / openclaw / codex / pi.
8. **No brand value is hard-coded.** Every component reads `--color-td-*` through
   `--status-color` / `--pri-color`, or takes its shell from daisyUI and its face
   from a token override. A scan for six-digit hex in `src/input.css` returns the
   token block and nothing else, and the only literals left in the markup are the
   two `--color-td-*` references inside the Signal Bars mark and its favicon.
9. **Every daisyUI component keeps its hook name.** An element may gain
   `badge` / `avatar` / `tabs` / `progress` / `toggle` / `select` classes, but the
   `data-*` attribute it answers to never moves — which is what let R3 re-shell
   eight components without touching one line of the interaction layer's bindings.
