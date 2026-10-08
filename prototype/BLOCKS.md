# TaskDashboard prototype — Block inventory

The structural contract of `index.html`. Selectors are **`data-*` semantic hooks**;
Tailwind class names are never part of the contract, and no anchor is positional.

Counts in the current build: **7 columns · 18 cards · 18 detail templates ·
109 distinct i18n keys over 162 `data-i18n*` attributes** (plus 13 keys for copy that
`app.js` generates).

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
| Project switcher | `[data-project-switcher]` (`<details class="dropdown">`) · `[data-project-current]` · `[data-project-option="…"]` · `[data-project-new]` |
| Search | `[data-search]` → `[data-search-input]` |
| Filters toggle | `[data-filter-toggle]` (`aria-pressed`, `aria-controls="td-filters"`) |
| View toggle | `[data-view-toggle]` → `[data-view="board" \| "list"]` (`aria-pressed`) |
| Theme toggle | `[data-theme-toggle]` → `[data-theme-icon="light" \| "dark"]` |
| Revision | `[data-revision]` → `[data-revision-value]`, `.td-live-dot` |
| Primary action | `[data-new-task]` |

## B03 · Sidebar

| | |
|---|---|
| Root | `aside[data-sidebar]` |
| Nav | `[data-nav]` → `[data-nav-item="board" \| "list" \| "activity"]` (`aria-current="page"`) |
| Projects | `[data-project-list]` → `[data-project="…"]` (`aria-current="page"`) → `[data-project-count]` |
| Agents | `[data-agents-presence]` → `[data-agent-platform="claude\|openclaw\|codex\|pi"]` + `[data-presence="running\|idle"]` |
| Identity | `[data-user]` (`.td-avatar` + name + role) |

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
| Scalars | `data-identifier` `data-id` `data-status` `data-priority` `data-project` `data-assignee` `data-assignee-kind` (`human\|agent`) `data-labels` `data-version` `data-comments` `data-attachments` `data-relations-parent` `data-relations-blocks` `data-relations-related` `data-done` `data-canceled` |
| Parts | `[data-card-stripe]` · `[data-card-identifier]` · `[data-card-title]` (a real `<button>`) · `[data-card-labels]` → `[data-label]` · `[data-card-priority]` · `[data-card-assignee]` · `[data-card-agent-badge]` (`data-agent-platform`) · `[data-card-comment-count]` · `[data-card-attachment-count]` · `[data-card-relations]` → `[data-relation-parent \| blocks \| related]` · `[data-card-menu]` |
| States | default · `:hover` · `:focus-within` · `aria-selected="true"` · `data-dragging="true"` · `data-done="true"` · `data-canceled="true"` |

## B08 · List view

| | |
|---|---|
| Root | `section[data-list]` — mutually exclusive with `[data-board]` |
| Hooks | `[data-list-rows]` (host) · `[data-list-row]` (`data-identifier`) |
| Row parts | `[data-list-identifier]` · `[data-list-title]` · `[data-list-status]` → `[data-list-status-label]` · `[data-list-assignee]` · `[data-list-priority]` · `[data-list-revision]` |
| Template | `template[data-list-row-template]` |

Rows are projected from the cards that survive the active filters, so board and
list can never disagree.

## B09 · Task detail drawer

| | |
|---|---|
| Root | `aside[data-detail-drawer][data-state="closed\|open\|closing"]` (`role="dialog"`, `aria-modal="true"`) |
| Scrim | `[data-detail-overlay][data-state]` |
| Head | `[data-detail-identifier]` · `[data-detail-title]` · `[data-detail-status-chip]` → `[data-detail-status-chip-label]` · `[data-detail-close]` |
| Properties | `[data-detail-props]` → status `[data-detail-status]` / `[data-detail-status-label]` · priority `[data-detail-priority]` / `[data-detail-priority-label]` · assignee `[data-detail-assignee]` / `[data-detail-assignee-avatar]` / `[data-detail-assignee-label]` · project `[data-detail-project]` / `[data-detail-project-label]` · internal id `[data-detail-id]` + `[data-detail-id-copy]` (`data-copy-value`) · `[data-detail-version]` |
| Body | `[data-detail-description]` (rendered GFM) · `[data-detail-relations]` → `[data-relation-link]` · `[data-detail-agent-session]` → `[data-detail-agent-session-body]` → `[data-agent-session]` · `[data-detail-attachments]` · `[data-detail-comments]` · `[data-comment-form]` → `[data-comment-input]`, `[data-comment-submit]` · `[data-detail-activity]` |
| Source | `template[data-detail-for="TD-…"]` holds one `[data-slot="description \| relations \| agent-session \| attachments \| comments \| activity"]` per card, wrapped by `[data-detail-templates]` |

## B10 · Create-task modal

`dialog[data-create-task]` → `form[data-create-task-form]` →
`[data-create-task-title]` · `[data-create-task-description]` ·
`[data-create-task-status]` · `[data-create-task-priority]` ·
`[data-create-task-assignee]` (options carry `data-assignee-kind`) ·
`[data-create-task-project]` · `[data-modal-close]`.

## B11 · Create-project modal

`dialog[data-create-project]` → `form[data-create-project-form]` →
`[data-create-project-name]` · `[data-create-project-prefix]` · `[data-modal-close]`.

## B12 · Empty states

`[data-empty]` with `data-empty-kind="column"` (one per column, revealed when the
column has no visible card) or `data-empty-kind="no-results"` (one per board,
revealed when a filter matches nothing).

## B13 · Loading state

`[data-skeleton]` — three shimmer rows at the top of the list view.

## B14 · Toast region

`div[data-toast-region]` (`role="status" aria-live="polite"`) plus
`template[data-toast-template]` → `[data-toast][data-toast-kind="info\|success\|danger"]`
→ `[data-toast-text]`. Auto-dismiss after 2.5s.

## B15 · Legend

`div[data-legend]` → `[data-legend-status]` (7 status chips) ·
`[data-legend-priority]` (5 priority chips). Sits at the bottom of the sidebar so
every status and priority is visible in one screenshot.

## B16 · Agent session provenance

`[data-agent-session]` — rendered inside `[data-detail-agent-session]` from the
card's template, with `[data-agent-platform]`, `[data-agent-platform-value]`
(`--agent-platform claude`), `[data-agent-session-id]` and `[data-agent-resume]`.
The same card exposes `[data-card-agent-badge]` + `data-agent-platform`.

---

## Auxiliary hooks (implementation detail, not part of §4)

| Hook | Purpose |
|---|---|
| `[data-move-menu]` → `[data-move-to="status"]` | the single shared "Move to" menu reused by every card (I2 fallback for drag) |
| `[data-drop-placeholder]` | transient placeholder bar created during `dragover` |
| `template[data-toast-template]` / `template[data-list-row-template]` / `template[data-detail-for]` | inert markup sources for the interaction layer |
| `[data-detail-slot-source]` | transient wrapper jQuery builds while copying a template into the drawer |
| `[data-label="…"]` | one chip per card label |

`data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label` and `data-i18n-title`
carry translation keys on every piece of user-visible copy. Copy generated by
`app.js` (toast sentences, empty-row text) is keyed in the `I18N` map at the top
of the file using the same namespace.

---

## Consistency items ("一致项")

1. **Every card** carries the identical hook set — a filter, drag or drawer code
   path never needs to special-case a card.
2. **Every column** carries the identical hook set and the identical empty-state block.
3. **Colour is never inline**: components read `--status-color` / `--pri-color`,
   which are set by `[data-status]` / `[data-priority]` attribute rules in
   `src/input.css`. Moving a card updates one attribute and the stripe, the dot and
   the chips follow.
4. **Mono discipline**: every identifier, internal id, session id, version, count and
   timestamp uses `.td-mono` with tabular numerals.
5. **Ids in the document** are unique and only used for `label[for]` /
   `aria-labelledby` / `aria-controls` — never as a styling hook.
6. **No block is hidden by the stylesheet**: `board ↔ list`, drawer and modals are
   toggled by the `hidden` attribute or `data-state`, so the static document is
   readable with JavaScript disabled.
