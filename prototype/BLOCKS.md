# TaskDashboard prototype — Block inventory

The structural contract of `index.html`. Selectors are **`data-*` semantic hooks**;
Tailwind class names are never part of the contract, and no anchor is positional.

Counts in the current build: **7 columns · 18 cards · 18 detail templates ·
15 agent-session blocks · 149 i18n hooks in the markup + 32 keys `app.js` resolves for
generated copy = 181 keys, mirrored in `en` and `zh`.**

---

## B01 · App shell

| | |
|---|---|
| Root | `[data-app-shell]` (`.td-shell`) |
| Attribute | theme is held on the document element: `html[data-theme="taskdash" \| "dark"]` |
| Layout | `grid-template-areas: "topbar topbar" / "sidebar main"` |

## B02 · Top bar

| | |
|---|---|
| Root | `header[data-topbar]` |
| Brand | `[data-brand]` |
| Project switcher | `[data-project-switcher]` (`<details class="dropdown">`) · `[data-project-current]` · `[data-project-option="…"]` · `[data-project-new]` · `[data-project-switcher-icon]` |
| Search | `[data-search]` → `[data-search-input]` |
| Filters toggle | `[data-filter-toggle]` (`aria-pressed`, `aria-controls="td-filters"`) |
| View toggle | `[data-view-toggle]` → `[data-view="board" \| "list"]` (`aria-pressed`) |
| Revision | `[data-revision]` → `[data-revision-label]`, `[data-revision-value]`, `.td-live-dot` |
| Primary action | `[data-new-task]` |

Right-end order is fixed: revision · primary action. There is **no user, account or
sign-in element** anywhere in the bar.

The theme and language controls **left the bar in review round v1.2** and became three
dialog entries in the sidebar footer in **v1.3** (B03 → B20/B21/B19). The bar holds no
display-mode control of any kind.

## B03 · Sidebar

| | |
|---|---|
| Root | `aside[data-sidebar]` |
| Nav | `[data-nav]` → `[data-nav-item="board" \| "list" \| "activity"]` (`aria-current="page"`) |
| Projects | `[data-project-list]` → `[data-project="…"]` (`aria-current="page"`) → `.td-side-icon` (prefix monogram, rail only) + `[data-project-count]` |
| Agents | `[data-agents-presence]` → **one row per platform**: `[data-agent-platform="claude\|openclaw\|codex\|pi"]` + `[data-presence="running\|idle"]` |
| States preview | `[data-states-open]` — sidebar footer control, opens **B18** |
| Footer entries | `[data-access-status]` — **three equal thirds** (`display: grid`, `repeat(3, minmax(0, 1fr))`), each cell a `.td-access-cell` block button with its icon and label centred, separated by a hairline on the inline start |

The three cells, left to right, and the dialog each one opens (**review round v1.3**):

| Cell | Hook | Label in the cell | Opens |
|---|---|---|---|
| Theme (left) | `[data-theme-open]` → `[data-theme-icon="light" \| "dark"]` + `[data-theme-label]` | the theme in force — `Light`/`Dark` (浅色/深色) | **B20** `[data-theme-modal]` |
| Language (middle) | `[data-lang-open]` + `[data-lang-label]` | the language in force — `EN`/`中文` | **B21** `[data-lang-modal]` |
| Settings (right) | `[data-access-open]` | `Settings`/`设置` | **B19** `[data-access-panel]` |

**The state is in the label.** `applyTheme()` writes `[data-theme-label]` and the sun/moon
`[data-theme-icon]`; `applyLanguageOptions()` writes `[data-lang-label]`. Both cells
therefore state the current mode without the dialog being opened, and both are rewritten
by the same functions the dialogs call, so cell and document cannot disagree. Each cell
also carries `aria-haspopup="dialog"` and a `data-i18n-aria-label` / `data-i18n-title`
key. Cells carry `:focus-visible` rings and are keyboard reachable; the theme and language
cells contain no inline switches any more — the v1.2 `[data-theme-toggle]` and
`[data-lang-toggle]` controls are **gone**.

The footer carries *dialog entries*, not *reachability*: the former `[data-user]` block
(avatar + name + role) was **removed** in review round v1.1, along with its `.td-user`,
`.td-user-text` and `.td-avatar-lg` styles, and the `Local · localhost` readout plus its
green status dot were **removed** in review round v1.2 (Terry, 2026-10-08 21:47) — no
bind-address status is shown anywhere in the chrome; the bind address is stated inside
B19 instead. The assignee model further down this file is a separate concern and is
unchanged.

At the ≤1023px rail the three thirds hold (the row is never allowed to wrap) and the
labels drop out with the rest of the sidebar text, so each cell is a centred 24px icon:
three 14px glyphs still fit the 64px rail (56px under 560px) without horizontal
overflow.

## B04 · Filters bar

| | |
|---|---|
| Root | `section#td-filters[data-filters]` |
| Controls | `[data-filter-assignee]` (all/me/human/agent) · `[data-filter-priority]` (all/urgent/high/medium/low/none) · `[data-filter-label]` (all + 17 labels) |
| Actions | `[data-filter-clear]` · `[data-filter-count]` (`aria-live="polite"`) |

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
| Hooks | `[data-column-header]` · `[data-column-dot]` · `[data-column-name]` · `[data-column-count]` · `[data-column-add]` · `[data-column-body]` |
| States | default · `data-drag-over="true"` · empty (`[data-empty]` inside the body) · live count badge |

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
| Properties | `[data-detail-props]` → status `[data-detail-status]` / `[data-detail-status-label]` · priority `[data-detail-priority]` / `[data-detail-priority-label]` · assignee `[data-detail-assignee]` / `[data-detail-assignee-avatar]` / `[data-detail-assignee-label]` / `[data-detail-assignee-platform]` (platform badge, hidden for the human owner) · **reporter** `[data-detail-reporter]` / `[data-detail-reporter-avatar]` / `[data-detail-reporter-label]` · project `[data-detail-project]` / `[data-detail-project-label]` · internal id `[data-detail-id]` + `[data-detail-id-copy]` (`data-copy-value`) · `[data-detail-version]` |
| Body | `[data-detail-description]` (rendered GFM) · `[data-detail-relations]` → `[data-relation-link]` · `[data-detail-agent-session]` → `[data-detail-agent-session-body]` → `[data-agent-session]` · `[data-detail-attachments]` · `[data-detail-comments]` · `[data-comment-form]` → `[data-comment-input]`, `[data-comment-submit]` · `[data-detail-activity]` |
| Source | `template[data-detail-for="TD-…"]` holds one `[data-slot="description \| relations \| agent-session \| attachments \| comments \| activity"]` per card, wrapped by `[data-detail-templates]` |

## B10 · Create-task modal

`dialog[data-create-task]` → `form[data-create-task-form]` →
`[data-create-task-title]` · `[data-create-task-description]` ·
`[data-create-task-status]` · `[data-create-task-priority]` ·
`[data-create-task-assignee]` (one `<option>` per team member, each carrying
`data-assignee-kind` and, for agents, `data-agent-platform`) ·
`[data-create-task-project]` · `[data-modal-close]`.

## B11 · Create-project modal

`dialog[data-create-project]` → `form[data-create-project-form]` →
`[data-create-project-name]` · `[data-create-project-prefix]` · `[data-modal-close]`.

## B12 · Empty states

`[data-empty]` with `data-empty-kind="column"` (one per column, revealed when the
column has no visible card) or `data-empty-kind="no-results"` (one per board,
revealed when a filter matches nothing).

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
| CIDR whitelist | `[data-cidr-whitelist]` → `[data-cidr-list]` → **n ×** `[data-cidr-row]` (`[data-cidr-value]` input + `[data-cidr-remove]`) · `[data-cidr-add]` |
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

`[data-token-value]` renders the stand-in masked as `td_••••••••••••` (the `td_` prefix
stays visible); `Reveal` toggles the mask only, `Copy` reports a toast and touches no
clipboard, `Reset` mints a new value in memory and shows it. The value is produced by
`Math.random()` + `Date.now()`, held in `state.token`, and written to the DOM and
nowhere else — **no storage, no transport, no credential, nothing persisted.** See
DESIGN.md §12.

## B20 · Theme dialog

| | |
|---|---|
| Root | `[data-theme-modal][data-state="closed\|open"]` (`role="dialog"`, `aria-modal="true"`, `aria-hidden`), **hidden by default** with the `hidden` attribute |
| Chrome | **the same modal as B19** — `.td-scrim` overlay + the same centred `.td-access-panel` card, `.td-access-head` header and `.td-access-body` body, so the three footer dialogs are one visual component |
| Opener | `[data-theme-open]` in the sidebar footer (left cell) |
| Dismiss | `[data-theme-close]` · `[data-theme-overlay]` · `Esc` — same `data-state` + `hidden` pattern as B19; focus returns to the opening cell |
| Title | `[data-i18n="access.theme.title"]` |
| Choices | `[data-theme-choice="light"]` (`Light`/`浅色`, sun glyph) · `[data-theme-choice="dark"]` (`Dark`/`深色`, moon glyph) — `.td-choice` rows, the active one carrying `aria-pressed="true"` plus the accent field and a tick |
| Group | `.td-choices` with `role="group"`, labelled by `[data-i18n-aria-label="access.theme.group"]` |

Choosing writes `html[data-theme]` **and** the footer cell's glyph and label through
`applyTheme()`, then closes and reports a toast. The dialog is a chooser, never a live
preview: nothing changes until a row is picked.

## B21 · Language dialog

| | |
|---|---|
| Root | `[data-lang-modal][data-state="closed\|open"]` (`role="dialog"`, `aria-modal="true"`, `aria-hidden`), **hidden by default** |
| Chrome | identical to **B19**/**B20** — same scrim, same `.td-access-panel` card |
| Opener | `[data-lang-open]` in the sidebar footer (middle cell) |
| Dismiss | `[data-lang-close]` · `[data-lang-overlay]` · `Esc`; focus returns to the opening cell |
| Title | `[data-i18n="access.lang.title"]` |
| Choices | `[data-lang-choice="en"]` (`EN`, `lang="en"`) · `[data-lang-choice="zh"]` (`中文`, `lang="zh-CN"`) — active row marked with `aria-pressed="true"` |
| Group | `.td-choices` with `role="group"`, labelled by `[data-i18n-aria-label="access.lang.group"]` |

**One dialog at a time.** `closeOtherDialogs()` runs before any of the three opens, so the
footer can never stack two surfaces; `Esc` and every scrim close all three, and each
dialog returns focus to the cell that opened it.

The theme and language dialogs take no new styling beyond the `.td-choices` / `.td-choice`
row: they reuse B19's panel, header and body rules verbatim (DESIGN.md §16).

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

---

## Auxiliary hooks (implementation detail, not part of §4)

| Hook | Purpose |
|---|---|
| `[data-move-menu]` → `[data-move-to="status"]` | the single shared "Move to" menu reused by every card (I2 fallback for drag) |
| `[data-drop-placeholder]` | transient placeholder bar created during `dragover` |
| `[data-states-overlay]` / `[data-access-overlay]` / `[data-theme-overlay]` / `[data-lang-overlay]` | scrims behind B18, B19, B20 and B21 |
| `template[data-toast-template]` / `template[data-list-row-template]` / `template[data-detail-for]` | inert markup sources for the interaction layer |
| `[data-detail-slot-source]` | transient wrapper jQuery builds while copying a template into the drawer |
| `[data-label="…"]` | one chip per card label |

---

## i18n hooks

English is the default language; the `中文` choice in **B21** switches to Chinese
(DESIGN.md §13). Five attributes carry the keys, on every piece of user-visible copy:

| Hook | Sets |
|---|---|
| `data-i18n` | the element's text |
| `data-i18n-placeholder` | `placeholder` |
| `data-i18n-aria-label` | `aria-label` |
| `data-i18n-title` | `title` |
| `data-i18n-arg` | the `%s` value for any of the four above; it is resolved as a key first, so `column.add` + `status.todo` reads `Add task to To Do` / `在待办中新建任务` |

The catalogue is the in-memory `MESSAGES` object at the top of `app.js` — **188 keys per
language, mirrored 1:1**, never an external file. Copy `app.js` composes at runtime
(toast sentences, list rows, card aria labels, the token mask) is keyed there too.

Every string the v1.3 footer and its three dialogs introduced is in that catalogue:

| Keys | Where |
|---|---|
| `access.theme.open` · `access.theme.title` · `access.theme.group` · `access.theme.close` | B20 — the theme cell's aria-label/title, the dialog title, its group label and its close button |
| `access.theme.light` · `access.theme.dark` | the two `[data-theme-choice]` rows **and** the current-value text in the theme cell (`applyTheme`) |
| `access.lang.open` · `access.lang.title` · `access.lang.group` · `access.lang.close` | B21 — the language cell's aria-label/title, the dialog title, its group label and its close button |
| `access.lang.en` · `access.lang.zh` | the two `[data-lang-choice]` rows **and** the current-value text in the language cell (`applyLanguageOptions`) |
| `access.settings` | the settings cell's label |

The rewritten B19 carries `access.model.bind` · `access.cidr.note` · `access.cidr.add` ·
`access.cidr.remove` · `access.cidr.value` · `access.model.token`. Rows the whitelist
adds at runtime are authored with the same `data-i18n-aria-label` / `data-i18n-title`
hooks, so the next language switch translates them like any seeded row.

The v1.2 keys the retired switches used (`access.theme` / `access.lang` as switch labels,
`access.lang.en` / `access.lang.zh` as segments, `theme.switchToDark` /
`theme.switchToLight`) are **gone from both dictionaries** — nothing references them.

`<html lang>` follows the switch (`en` / `zh-CN`), the `[data-lang-choice]` rows move
their `aria-pressed`, and the drawer body — which arrives from an inert `<template>` that
the document-wide pass cannot reach — is translated again when it lands. A language
switch also re-derives everything `app.js` owns, so an open drawer, the list view, the
footer cell and the result counter all change language in place.

Per-column empty-state hints and add-button labels share **one** key pair each and take
their status name through `data-i18n-arg` (`status.backlog`, …) rather than fourteen
separate keys.

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
