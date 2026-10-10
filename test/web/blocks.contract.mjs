/**
 * The board's machine-checkable block contract.
 *
 * Transcribed **once, by hand** from `prototype/BLOCKS.md` (B01–B25 plus the ten
 * "consistency items" C01–C10). This file is the single source of assertion data for
 * the frontend; `prototype/BLOCKS.md` remains the design's prose authority, it is
 * never parsed, and `prototype/**` is never edited from here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS NEVER QUOTE THE PROSE COUNTS (the header-count discrepancy)
 * ---------------------------------------------------------------------------
 * The BLOCKS.md *header* is stale; the *body* is authoritative. Measured against
 * `prototype/index.html` and `prototype/app.js` on 2026-10-09 (host-side static
 * counting — no browser, no network):
 *
 *   header claims                             measured
 *   252 `data-i18n*` hooks in the document     606 (389 `data-i18n` + 144 `-arg`
 *                                                  + 47 `-aria-label` + 8 `-placeholder`
 *                                                  + 18 `-title`)
 *   198 catalogue keys                         en = 214, zh = 214 (exact parity;
 *                                              the body's "214 keys per language,
 *                                              mirrored 1:1" is the correct number)
 *   7 columns · 18 cards · 18 templates        7 / 18 / 18 — the one header line that
 *                                              does agree with the DOM
 *
 * So a rule that quoted "198" or "252" would be wrong on day one, and a rule that
 * quoted "18 cards" would encode a demo fixture as a contract. Every count/order in
 * this file is therefore either (a) a **domain-fixed multiplicity** that any correct
 * implementation has (7 statuses ⇒ 7 columns, 3 nav items, 2 views, 2 languages,
 * 3 editor modes), (b) a **relation between counts** captured by the rule kind itself
 * (never restated as a number here), or (c) deliberately **not asserted** and recorded
 * as a `manual` note. Fixture-derived multiplicities (how many cards, projects,
 * roster rows or inert seed rows the demo happens to ship) are never assertions.
 *
 * The stale claims are also exported as data (`STALE_PROSE_COUNTS`) so the test suite
 * can prove none of them leaked into a rule.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 * ---------------------------------------------------------------------------
 * Every block is `{ id, root, scope, status, required, states, rules }`:
 *
 *   id        `B01`…`B25`, `C01`…`C10` (unique, continuous within each series)
 *   root      the block's anchoring `data-*` hook selector, or `null` when the block
 *             has no element of its own (the retired B20/B21, and the C-items)
 *   scope     one of `SCOPES` — where the block lives
 *   status    `active` | `retired` (B20/B21 were removed, not hidden)
 *   required  hooks the block owns; normally present in its markup. May be empty.
 *   states    hooks the block owns that are volatile (runtime-created or toggled), so
 *             they are part of the contract but may be absent at rest. May be empty.
 *   rules     the assertions, as data — see `RULE_KINDS` below. This is the ONLY
 *             place numbers live; nothing outside `rules` carries a count.
 *
 * Selectors are **semantic `data-*` hooks, never Tailwind classes and never
 * positional anchors** — BLOCKS.md's own rule. `parseHookSelector()` enforces the
 * grammar: an optional bare tag followed by one or more `[attr]` / `[attr="value"]`
 * compounds, at least one of which is `data-*`. Class (`.`), id (`#`) and descendant
 * combinators therefore cannot be expressed at all. Containment is expressed with a
 * rule's `within` field (an ancestor hook) rather than a descendant combinator.
 *
 * This module is pure data + pure functions: no I/O, no DOM, no browser, no globals,
 * and importing it must print nothing (the suite checks that in a child process).
 * The DOM layer is a *separate* export — see `BROWSER_LAYER_RULES`.
 */

/** Provenance, for reports. */
export const CONTRACT_SOURCE = "prototype/BLOCKS.md";

/** Where a block lives. */
export const SCOPES = Object.freeze([
  "shell", // chrome that is always on screen: top bar, sidebar, legend, toasts
  "board", // the kanban + list + their filters and empty/loading states
  "detail", // the task detail drawer
  "create", // the two creation dialogs and the controls they embed
  "review", // prototype review surfaces (states gallery, access panel, error state)
  "global", // cross-cutting consistency items
  "retired", // removed blocks, kept in the inventory so their absence is asserted
]);

/** Enumerated value domains. Attribute values only — never multiplicities. */
export const DOMAINS = Object.freeze({
  /** The seven board statuses, in board order (B05). */
  STATUS: Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]),
  /** The five priorities (B04/B07). */
  PRIORITY: Object.freeze(["urgent", "high", "medium", "low", "none"]),
  /** Card identity model (B07/C07). */
  ASSIGNEE_KIND: Object.freeze(["human", "agent"]),
  /** The four agent platforms (B03/B07/B16/B22/C07). */
  PLATFORM: Object.freeze(["claude", "openclaw", "codex", "pi"]),
  /** Sidebar navigation (B03). */
  NAV: Object.freeze(["board", "list", "activity"]),
  /** Board / list view toggle (B02). */
  VIEW: Object.freeze(["board", "list"]),
  /** Language menu options (B03/B21). */
  LANG: Object.freeze(["en", "zh"]),
  /** `html[data-theme-mode]` and the theme cell's mirrored state (B01/B03). */
  THEME_MODE: Object.freeze(["light", "dark", "auto"]),
  /** `html[data-theme]` — what the stylesheet reads. Note the different vocabulary. */
  THEME_DOC: Object.freeze(["meerkat-taskpanel", "dark", "auto"]),
  /** Toast kinds (B14). */
  TOAST_KIND: Object.freeze(["info", "success", "danger"]),
  /** Detail template slots (B09). */
  SLOT: Object.freeze(["description", "relations", "agent-session", "attachments", "comments", "activity"]),
  /** Markdown editor modes (B23). */
  MD_MODE: Object.freeze(["write", "preview", "split"]),
  /** Agent presence rows (B03). */
  PRESENCE: Object.freeze(["running", "idle"]),
  /** Empty-state kinds (B12). */
  EMPTY_KIND: Object.freeze(["column", "no-results"]),
  /** Detail drawer states (B09). */
  DRAWER_STATE: Object.freeze(["closed", "open", "closing"]),
  /** Overlay panel states (B18/B19). */
  PANEL_STATE: Object.freeze(["closed", "open"]),
  /** Token reveal icons (B19). */
  TOKEN_ICON: Object.freeze(["hidden", "shown"]),
  /** Boolean-valued state attributes (B19). */
  BOOLEAN: Object.freeze(["true", "false"]),
});

/**
 * The rule vocabulary. `layer` decides where the rule can be evaluated:
 *
 *   "dom"    needs a live DOM (browser layer — a Chromium-driven suite)
 *   "source" needs only the built artifacts / stylesheets (browser-free, in the container)
 *   "manual" is recorded for completeness and is human-reviewed — it is *not*
 *            machine-checked anywhere (the Jobs/UI review pass owns it)
 *
 * Payload semantics (the contract the DOM layer must implement):
 *
 *   count              `{selector, within?, when?, equals|min|max}`
 *                      Number of elements matching `selector`. With `within`, the
 *                      bound applies **per element matching `within`** (so
 *                      `{selector:"[data-empty]", within:"[data-column-body]", max:1}`
 *                      means "each column body holds at most one empty state").
 *   order              `{selector, attribute, equals, when?}`
 *                      The `attribute` values of the matches, in document order,
 *                      equal `equals` exactly.
 *   identical-hookset  `{selector, within?, when?}`
 *                      Every match carries the identical set of `data-*` attributes
 *                      (the filter/drag/drawer paths must never special-case one).
 *   domain             `{selector, attribute, subset, when?}`
 *                      Every match's `attribute` value is in `subset`.
 *   absent             `{selector, within?, when?}`
 *                      No match exists (retired hooks, forbidden controls).
 *   sequence           `{selector, attribute, from, step, when?}`
 *                      The numeric `attribute` values, in document order, are the
 *                      contiguous run `from, from+step, …`.
 *   monotonic          `{selector, attribute, direction, when?}`
 *                      The numeric values do not increase (`non-increasing`) /
 *                      decrease (`non-decreasing`) down the document.
 *   source             `{check, scope?}`
 *                      A named stylesheet/artifact scan from `SOURCE_CHECKS`.
 *   manual             `{note}`
 *                      Recorded intent with no machine rule — see MANUAL_RULES.
 */
export const RULE_KINDS = Object.freeze({
  count: Object.freeze({ layer: "dom" }),
  order: Object.freeze({ layer: "dom" }),
  "identical-hookset": Object.freeze({ layer: "dom" }),
  domain: Object.freeze({ layer: "dom" }),
  absent: Object.freeze({ layer: "dom" }),
  sequence: Object.freeze({ layer: "dom" }),
  monotonic: Object.freeze({ layer: "dom" }),
  source: Object.freeze({ layer: "source" }),
  manual: Object.freeze({ layer: "manual" }),
});

/**
 * Named browser-free scans. Each is implemented by the L1 suite against the built
 * artifacts (they do not exist yet — `web/` is the next stage); the contract only
 * declares which invariants must be checked and over what.
 */
export const SOURCE_CHECKS = Object.freeze({
  "css-status-priority-color-map": Object.freeze({
    intent:
      "The stylesheet maps [data-status] to --status-color (all of DOMAINS.STATUS) and " +
      "[data-priority] to --pri-color (all of DOMAINS.PRIORITY). C03: moving a card " +
      "updates one attribute and the stripe, dot and chips follow.",
  }),
  "css-mono-tabular-numerals": Object.freeze({
    intent: "`.td-mono` declares `font-variant-numeric: tabular-nums`. C04.",
  }),
  "css-no-id-selectors": Object.freeze({
    intent:
      "No stylesheet rule selects by `#id`. C05: ids exist only for label[for] / " +
      "aria-labelledby / aria-controls, never as a styling hook.",
  }),
  "css-no-hex-outside-tokens": Object.freeze({
    intent:
      "A six-digit hex scan of the stylesheet returns the token block and nothing " +
      "else. C08: no brand value is hard-coded outside the token definitions.",
  }),
  "selector-literal-present": Object.freeze({
    intent:
      "Every selector declared by this contract appears as a literal in the built " +
      "bundle (`web/dist/assets/*.js`), so the hook surface survives the framework " +
      "compile.",
  }),
});

/** The ten consistency items' invariants, reused where several blocks share one. */
const REQUIRED_BY_EVERY_CARD = Object.freeze([
  "[data-identifier]",
  "[data-id]",
  "[data-status]",
  "[data-priority]",
  "[data-project]",
  "[data-assignee]",
  "[data-assignee-kind]",
  "[data-reporter]",
  "[data-labels]",
  "[data-version]",
  "[data-comments]",
  "[data-attachments]",
  "[data-relations-parent]",
  "[data-relations-blocks]",
  "[data-relations-related]",
  "[data-done]",
  "[data-canceled]",
  "[data-card-stripe]",
  "[data-card-identifier]",
  "[data-card-title]",
  "[data-card-labels]",
  "[data-label]",
  "[data-card-priority]",
  "[data-card-assignee]",
  "[data-card-agent-badge]",
  "[data-card-agent-role]",
  "[data-card-comment-count]",
  "[data-card-attachment-count]",
  "[data-card-relations]",
  "[data-relation-parent]",
  "[data-relation-blocks]",
  "[data-relation-related]",
  "[data-card-menu]",
]);

/**
 * B01–B25, in order. Every entry is transcribed from the eponymous BLOCKS.md section.
 */
const BLOCKS = [
  {
    id: "B01",
    title: "App shell",
    root: "[data-app-shell]",
    scope: "shell",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "count", selector: "[data-app-shell]", equals: 1 },
      { kind: "count", selector: "html[data-theme]", equals: 1 },
      { kind: "count", selector: "html[data-theme-mode]", equals: 1 },
      { kind: "domain", selector: "html[data-theme]", attribute: "data-theme", subset: DOMAINS.THEME_DOC },
      { kind: "domain", selector: "html[data-theme-mode]", attribute: "data-theme-mode", subset: DOMAINS.THEME_MODE },
      {
        kind: "manual",
        note:
          "`.td-shell` layout is `grid-template-areas: \"topbar topbar\" / \"sidebar main\"` — " +
          "CSS geometry on a class, not a hook.",
      },
    ],
  },

  {
    id: "B02",
    title: "Top bar",
    root: "[data-topbar]",
    scope: "shell",
    status: "active",
    required: [
      "[data-brand]",
      "[data-project-switcher]",
      "[data-project-current]",
      "[data-project-option]",
      "[data-project-new]",
      "[data-project-switcher-icon]",
      "[data-search]",
      "[data-search-input]",
      "[data-filter-toggle]",
      "[data-view-toggle]",
      "[data-view]",
      "[data-revision]",
      "[data-revision-label]",
      "[data-revision-value]",
      "[data-new-task]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-topbar]", equals: 1 },
      { kind: "count", selector: "[data-new-task]", equals: 1 },
      { kind: "count", selector: "[data-view]", equals: 2 },
      { kind: "domain", selector: "[data-view]", attribute: "data-view", subset: DOMAINS.VIEW },
      { kind: "absent", selector: "[data-user]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      {
        kind: "manual",
        note:
          "The right cluster — Revision + primary action as one flex item, `margin-left:auto`, " +
          "flush to the header's right padding edge, never split across the folded rows — is " +
          "named in BLOCKS.md only by the class `.td-topbar-actions`. No `data-topbar-actions` " +
          "attribute exists in prototype/index.html, although the plan's geometry check assumes " +
          "one; the flush-right check is therefore a geometry assertion, not a hook assertion.",
      },
      {
        kind: "manual",
        note:
          "ARIA, which is not a `data-*` hook surface: [data-filter-toggle] carries " +
          "`aria-pressed` + `aria-controls=\"td-filters\"`, and [data-view] carries `aria-pressed`.",
      },
      {
        kind: "manual",
        note: "No user, account or sign-in element anywhere in the bar.",
      },
    ],
  },

  {
    id: "B03",
    title: "Sidebar",
    root: "[data-sidebar]",
    scope: "shell",
    status: "active",
    required: [
      "[data-nav]",
      "[data-nav-item]",
      "[data-project-list]",
      "[data-project]",
      "[data-project-count]",
      "[data-order-score]",
      "[data-order-rank]",
      "[data-agents-presence]",
      "[data-agent-platform]",
      "[data-presence]",
      "[data-states-open]",
      "[data-access-status]",
      "[data-theme-switch]",
      "[data-theme-icon]",
      "[data-theme-label]",
      "[data-lang-select]",
      "[data-lang-label]",
      "[data-lang-menu]",
      "[data-lang-option]",
      "[data-access-open]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-sidebar]", equals: 1 },
      { kind: "count", selector: "[data-nav-item]", equals: 3 },
      { kind: "count", selector: "[data-lang-option]", equals: 2 },
      { kind: "domain", selector: "[data-nav-item]", attribute: "data-nav-item", subset: DOMAINS.NAV },
      { kind: "domain", selector: "[data-presence]", attribute: "data-presence", subset: DOMAINS.PRESENCE },
      { kind: "domain", selector: "[data-theme-icon]", attribute: "data-theme-icon", subset: DOMAINS.THEME_MODE },
      { kind: "domain", selector: "[data-lang-option]", attribute: "data-lang-option", subset: DOMAINS.LANG },
      {
        kind: "identical-hookset",
        selector: "[data-project]",
        within: "[data-project-list]",
      },
      { kind: "sequence", selector: "[data-order-rank]", attribute: "data-order-rank", from: 1, step: 1 },
      { kind: "monotonic", selector: "[data-order-score]", attribute: "data-order-score", direction: "non-increasing" },
      { kind: "absent", selector: "[data-user]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      { kind: "absent", selector: "[data-theme-modal]" },
      { kind: "absent", selector: "[data-lang-modal]" },
      {
        kind: "manual",
        note:
          "Footer controls are three equal thirds (`display:grid; repeat(3, minmax(0,1fr))`), " +
          "each a block button with `.td-access-cell` (a class, not a hook) and a hairline on " +
          "the inline start; cells are keyboard reachable with `:focus-visible` rings.",
      },
      {
        kind: "manual",
        note:
          "The theme cell is a three-state cycle, not a toggle: it states the mode in force " +
          "without being opened and therefore carries **no** `aria-pressed`; the state rides on " +
          "`data-theme-mode`, mirrored from <html> by the same writer.",
      },
      {
        kind: "manual",
        note:
          "[data-lang-menu] is `position:fixed` and sits at the end of the document rather than " +
          "inside the sidebar, because the sidebar is a scroll container and would clip it.",
      },
      {
        kind: "manual",
        note:
          "At the ≤1023px rail the row never wraps; labels (including `.td-caret`) drop out and " +
          "each cell becomes a centred 24px icon — three glyphs still fit the 64px (56px under " +
          "560px) rail with no horizontal overflow.",
      },
      {
        kind: "manual",
        note:
          "The project list renders the order the **server** computed and does no computation " +
          "itself. `[data-order-score]` is a diagnostic field the server only returns under " +
          "`?order_debug=1` (plan D4), so it is absent from a default `/projects` response.",
      },
    ],
  },

  {
    id: "B04",
    title: "Filters bar",
    root: "[data-filters]",
    scope: "board",
    status: "active",
    required: [
      "[data-filter-assignee]",
      "[data-filter-priority]",
      "[data-filter-label]",
      "[data-filter-label-value]",
      "[data-filter-label-summary]",
      "[data-filter-label-option]",
      "[data-filter-clear]",
      "[data-filter-count]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-filters]", equals: 1 },
      { kind: "count", selector: "[data-filter-clear]", min: 1, max: 1 },
      { kind: "identical-hookset", selector: "[data-filter-label-option]" },
      {
        kind: "manual",
        note:
          "The label selector is a `<details>` dropdown, not a `<select>`: the chosen value " +
          "lives on `data-filter-label-value` and is restated on [data-filter-label-summary]. " +
          "Its option count is roster-derived (every label plus one \"all\" row) and is not asserted.",
      },
      {
        kind: "manual",
        note:
          "Assignee and priority are native selects whose option value domains live on the form " +
          "value, not on a `data-*` attribute, so they cannot be asserted as a hook domain. " +
          "[data-filter-count] carries `aria-live=\"polite\"`.",
      },
    ],
  },

  {
    id: "B05",
    title: "Board",
    root: "[data-board]",
    scope: "board",
    status: "active",
    required: ["[data-column]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-board]", equals: 1, when: "board view" },
      { kind: "count", selector: "[data-column]", equals: 7, when: "board view" },
      {
        kind: "order",
        selector: "[data-column][data-status]",
        attribute: "data-status",
        equals: DOMAINS.STATUS,
        when: "board view",
      },
      {
        kind: "manual",
        note: "[data-board] is the document's only horizontal scroll container (CSS, not a hook).",
      },
    ],
  },

  {
    id: "B06",
    title: "Column",
    root: "[data-column]",
    scope: "board",
    status: "active",
    required: [
      "[data-column-header]",
      "[data-column-dot]",
      "[data-column-name]",
      "[data-column-count]",
      "[data-column-add]",
      "[data-column-body]",
      "[data-column-progress]",
    ],
    states: ["[data-drag-over=\"true\"]"],
    rules: [
      { kind: "identical-hookset", selector: "[data-column]", when: "board view" },
      {
        kind: "manual",
        note:
          "[data-column-progress] is a daisyUI progress element directly under the header: " +
          "`value` is the column's visible count and `max` is the board's total visible count, " +
          "so it reads that column's share of the board. The single writer never emits `max=\"0\"`.",
      },
    ],
  },

  {
    id: "B07",
    title: "Card",
    root: "[data-card]",
    scope: "board",
    status: "active",
    required: [...REQUIRED_BY_EVERY_CARD],
    states: ["[data-dragging=\"true\"]", "[data-done=\"true\"]", "[data-canceled=\"true\"]"],
    rules: [
      { kind: "identical-hookset", selector: "[data-card]", when: "board view" },
      { kind: "domain", selector: "[data-card]", attribute: "data-status", subset: DOMAINS.STATUS },
      { kind: "domain", selector: "[data-card]", attribute: "data-priority", subset: DOMAINS.PRIORITY },
      { kind: "domain", selector: "[data-card]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      { kind: "domain", selector: "[data-card-agent-badge]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "Identity slot: a human card shows the monogram avatar with the agent badge and role " +
          "empty and hidden; an agent card hides the avatar (which still carries the monogram) " +
          "and shows both [data-card-agent-badge] and [data-card-agent-role], so every card " +
          "states the platform *and* the role name. Visibility is CSS, hence manual.",
      },
      {
        kind: "manual",
        note:
          "Card count is fixture data (how many tasks exist), never asserted. States `:hover`, " +
          "`:focus-within` and `aria-selected=\"true\"` are ARIA/CSS, not hooks. The root carries " +
          "the HTML attribute `draggable=\"true\"`.",
      },
      {
        kind: "manual",
        note:
          "Hook-name overlap to keep in mind when writing selectors: `data-project` names both a " +
          "card scalar (here) and a sidebar project row (B03, scoped by `within:[data-project-list]`); " +
          "`data-agent-platform` names a card badge, a roster option and a session block. " +
          "Rules that would be ambiguous qualify with `within` or a compound selector.",
      },
    ],
  },

  {
    id: "B08",
    title: "List view",
    root: "[data-list]",
    scope: "board",
    status: "active",
    required: [
      "[data-list-rows]",
      "[data-list-row]",
      "[data-list-identifier]",
      "[data-list-title]",
      "[data-list-status]",
      "[data-list-status-label]",
      "[data-list-assignee]",
      "[data-list-priority]",
      "[data-list-priority-label]",
      "[data-list-revision]",
      "[data-list-row-template]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-list]", equals: 1, when: "list view" },
      { kind: "identical-hookset", selector: "[data-list-row]", within: "[data-list-rows]", when: "list view" },
      {
        kind: "absent",
        selector: "[data-list][hidden]",
        when: "list view",
      },
      {
        kind: "manual",
        note:
          "[data-list] is mutually exclusive with [data-board] (toggled by the `hidden` " +
          "attribute), so the two can never be shown at once.",
      },
      {
        kind: "manual",
        note:
          "Rows are projected from the cards that survive the active filters, so board and list " +
          "can never disagree. This is a behavioural relation between two live counts — the " +
          "browser layer checks it with the list view active; no fixture count is asserted.",
      },
    ],
  },

  {
    id: "B09",
    title: "Task detail drawer",
    root: "[data-detail-drawer]",
    scope: "detail",
    status: "active",
    required: [
      "[data-detail-overlay]",
      "[data-detail-identifier]",
      "[data-detail-title]",
      "[data-detail-status-chip]",
      "[data-detail-status-chip-label]",
      "[data-detail-close]",
      "[data-detail-props]",
      "[data-detail-status]",
      "[data-detail-status-label]",
      "[data-detail-priority]",
      "[data-detail-priority-label]",
      "[data-detail-assignee]",
      "[data-detail-assignee-avatar]",
      "[data-detail-assignee-label]",
      "[data-detail-assignee-platform]",
      "[data-detail-reporter]",
      "[data-detail-reporter-avatar]",
      "[data-detail-reporter-label]",
      "[data-detail-project]",
      "[data-detail-project-label]",
      "[data-detail-labels]",
      "[data-detail-id]",
      "[data-detail-id-copy]",
      "[data-detail-version]",
      "[data-detail-description]",
      "[data-detail-relations]",
      "[data-relation-link]",
      "[data-detail-agent-session]",
      "[data-detail-agent-session-body]",
      "[data-agent-session]",
      "[data-detail-attachments]",
      "[data-detail-comments]",
      "[data-comment-form]",
      "[data-comment-input]",
      "[data-comment-submit]",
      "[data-detail-activity]",
      "[data-detail-templates]",
      "[data-detail-for]",
      "[data-slot]",
    ],
    states: ["[data-detail-drawer][data-state=\"open\"]", "[data-detail-drawer][data-state=\"closing\"]"],
    rules: [
      { kind: "count", selector: "[data-detail-drawer]", equals: 1 },
      { kind: "count", selector: "[data-detail-overlay]", equals: 1 },
      { kind: "domain", selector: "[data-detail-drawer]", attribute: "data-state", subset: DOMAINS.DRAWER_STATE },
      { kind: "domain", selector: "[data-slot]", attribute: "data-slot", subset: DOMAINS.SLOT },
      {
        kind: "identical-hookset",
        selector: "[data-detail-for]",
        within: "[data-detail-templates]",
      },
      {
        kind: "manual",
        note:
          "`template[data-detail-for=\"TD-…\"]` holding one [data-slot] per card is the " +
          "prototype's jQuery mechanism (measure it per card: 18 templates, 18 description and " +
          "18 activity slots, 16 comments, 15 agent-session, 11 attachments, 9 relations). " +
          "A component-based implementation renders one drawer instead; the **hooks** are the " +
          "contract, the template multiplicity is not.",
      },
      {
        kind: "manual",
        note:
          "The root is `role=\"dialog\"` + `aria-modal=\"true\"`; [data-detail-id-copy] carries " +
          "`data-copy-value` and writes to the clipboard (a browser API); [data-detail-description] " +
          "renders sanitised GFM.",
      },
    ],
  },

  {
    id: "B10",
    title: "Create-task modal",
    root: "[data-create-task]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-task-form]",
      "[data-create-two-col]",
      "[data-create-left]",
      "[data-create-right]",
      "[data-create-task-title]",
      "[data-create-task-description]",
      "[data-create-task-priority]",
      "[data-create-task-project]",
      "[data-create-task-status]",
      "[data-modal-close]",
    ],
    states: [],
    rules: [
      { kind: "count", selector: "[data-create-task]", equals: 1 },
      { kind: "count", selector: "[data-create-two-col]", equals: 1 },
      { kind: "count", selector: "[data-create-left]", equals: 1 },
      { kind: "count", selector: "[data-create-right]", equals: 1 },
      {
        kind: "manual",
        note:
          "[data-create-two-col] holds exactly two tracks, `minmax(0,1.6fr)` / `minmax(0,1fr)`, " +
          "so neither a long title nor the editor can overflow the dialog; at ≤760px the tracks " +
          "stack and the dialog scrolls internally. The routing column carries the eight field " +
          "groups: priority, assignee (B22), project, status, reporter (B22), labels (B25), " +
          "parent (B24), depends-on (B24).",
      },
      {
        kind: "manual",
        note:
          "[data-modal-close] dismisses; the single writer also serves as the post-submit reset, " +
          "and must additionally clear the relation inputs, the depends-on chips and the label " +
          "control's input/chips/menu — none of which a native form reset reaches.",
      },
      {
        kind: "manual",
        note: "The two relation fields are marked Optional; both leave the task creatable when empty.",
      },
    ],
  },

  {
    id: "B11",
    title: "Create-project modal",
    root: "[data-create-project]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-project-form]",
      "[data-create-project-name]",
      "[data-create-project-prefix]",
      "[data-modal-close]",
    ],
    states: [],
    rules: [{ kind: "count", selector: "[data-create-project]", equals: 1 }],
  },

  {
    id: "B12",
    title: "Empty states",
    root: "[data-empty]",
    scope: "board",
    status: "active",
    required: ["[data-empty]", "[data-empty-kind]", "[data-empty-kind=\"column\"]", "[data-empty-kind=\"no-results\"]"],
    states: [],
    rules: [
      { kind: "domain", selector: "[data-empty]", attribute: "data-empty-kind", subset: DOMAINS.EMPTY_KIND },
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"column\"]",
        within: "[data-column-body]",
        max: 1,
        when: "board view",
      },
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"no-results\"]",
        max: 1,
        when: "board view",
      },
      {
        kind: "manual",
        note:
          "Documentation discrepancy: BLOCKS.md B12 writes the large empty state as " +
          "`[data-empty-lg]`, but no such attribute exists — the shipped markup is " +
          "`<div class=\"td-empty td-empty-lg\" data-empty data-empty-kind=\"no-results\" hidden>`. " +
          "The hook that names it is [data-empty][data-empty-kind=\"no-results\"]; `.td-empty-lg` " +
          "is a class and therefore cannot appear in this contract.",
      },
      {
        kind: "manual",
        note:
          "The large empty state opens on a 28px Sentinel Watch mark whose two lead meerkats read " +
          "`--color-td-ink-3`, so on an empty board the on-duty sentinel is the only lit element.",
      },
    ],
  },

  {
    id: "B13",
    title: "Loading state",
    root: "[data-skeleton]",
    scope: "board",
    status: "active",
    required: [],
    states: ["[data-skeleton]"],
    rules: [
      {
        kind: "manual",
        note:
          "Three shimmer rows at the top of the list view. The rows themselves carry no hooks, " +
          "and the skeleton only exists while loading, so neither its presence nor its row count " +
          "is asserted. The B18 showcase has its own [data-loading-state] demo.",
      },
    ],
  },

  {
    id: "B14",
    title: "Toast region",
    root: "[data-toast-region]",
    scope: "shell",
    status: "active",
    required: [
      "[data-toast-region]",
      "[data-toast-template]",
      "[data-toast]",
      "[data-toast-text]",
      "[data-toast-kind]",
    ],
    states: ["[data-toast]"],
    rules: [
      { kind: "count", selector: "[data-toast-region]", equals: 1 },
      { kind: "count", selector: "[data-toast-template]", equals: 1 },
      { kind: "domain", selector: "[data-toast]", attribute: "data-toast-kind", subset: DOMAINS.TOAST_KIND },
      {
        kind: "manual",
        note:
          "`role=\"status\"` + `aria-live=\"polite\"` on the region; auto-dismiss after 2.5s; the " +
          "three kinds are also rendered statically inside B18 with `data-state=\"static\"`, so " +
          "they are never auto-dismissed there.",
      },
    ],
  },

  {
    id: "B15",
    title: "Legend",
    root: "[data-legend]",
    scope: "shell",
    status: "active",
    required: ["[data-legend]", "[data-legend-status]", "[data-legend-priority]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-legend]", equals: 1 },
      {
        kind: "manual",
        note:
          "The legend shows one chip per status (7, i.e. every DOMAINS.STATUS value) and one per " +
          "priority (5, i.e. every DOMAINS.PRIORITY value). The chips carry no hooks — each " +
          "selector is a single host element — so this is a domain statement, not a countable " +
          "one. It sits at the bottom of the sidebar so every status and priority fits one " +
          "screenshot.",
      },
    ],
  },

  {
    id: "B16",
    title: "Agent session provenance",
    root: "[data-agent-session]",
    scope: "detail",
    status: "active",
    required: [
      "[data-detail-agent-session]",
      "[data-detail-agent-session-body]",
      "[data-agent-session]",
      "[data-agent-platform]",
      "[data-agent-platform-value]",
      "[data-agent-session-id]",
      "[data-agent-resume]",
    ],
    states: [],
    rules: [
      { kind: "domain", selector: "[data-agent-platform]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "Every agent card carries a session block whose platform matches the card's own " +
          "`data-agent-platform` and whose session id is prefixed with that platform; human " +
          "cards carry none and the drawer hides the section for them. How many cards are agent " +
          "cards is fixture data. [data-agent-platform-value] also sets the `--agent-platform` " +
          "custom property.",
      },
    ],
  },

  {
    id: "B17",
    title: "Error state",
    root: "[data-error-state]",
    scope: "review",
    status: "active",
    required: ["[data-error-state]", "[data-error-retry]", "[data-i18n=\"error.title\"]", "[data-i18n=\"error.hint\"]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-error-state]", min: 1, max: 1 },
      {
        kind: "manual",
        note:
          "`role=\"alert\"`, hidden by default, on the `--color-td-danger-soft` surface the style " +
          "guide reserves for errors; Retry re-runs the real render pass and confirms with a " +
          "success toast. It is demonstrated inside B18 rather than on the board, because the " +
          "board only raises it when a load fails.",
      },
    ],
  },

  {
    id: "B18",
    title: "States showcase",
    root: "[data-states-panel]",
    scope: "review",
    status: "active",
    required: [
      "[data-states-panel]",
      "[data-states-open]",
      "[data-states-close]",
      "[data-states-overlay]",
      "[data-loading-state]",
      "[data-empty-column]",
      "[data-empty-results]",
      "[data-error-state]",
      "[data-toast-states]",
      "[data-toast]",
    ],
    states: ["[data-states-panel][data-state=\"open\"]"],
    rules: [
      { kind: "count", selector: "[data-states-panel]", equals: 1 },
      { kind: "count", selector: "[data-toast-states]", equals: 1 },
      { kind: "domain", selector: "[data-states-panel]", attribute: "data-state", subset: DOMAINS.PANEL_STATE },
      {
        kind: "count",
        selector: "[data-toast][data-state=\"static\"]",
        within: "[data-toast-states]",
        min: 0,
        when: "states showcase open",
      },
      {
        kind: "manual",
        note:
          "The gallery is a **prototype review surface** (Jobs' UI/UX pass): it puts every " +
          "non-default state in one frame. It adds no framework — a scrim, a panel and two " +
          "handlers.",
      },
      {
        kind: "manual",
        note:
          "Discrepancy inside BLOCKS.md: B18 declares `[data-states-panel]` as " +
          "`role=\"dialog\"` + `aria-modal=\"true\"` + `aria-hidden`, while B21 states that B19 " +
          "is the document's *only* `role=\"dialog\"` panel. Both cannot hold; the drawer (B09) " +
          "also declares the role. Nothing here depends on which wording wins.",
      },
    ],
  },

  {
    id: "B19",
    title: "Access & token settings",
    root: "[data-access-panel]",
    scope: "review",
    status: "active",
    required: [
      "[data-access-panel]",
      "[data-access-open]",
      "[data-access-close]",
      "[data-access-overlay]",
      "[data-cidr-whitelist]",
      "[data-cidr-list]",
      "[data-cidr-row]",
      "[data-cidr-value]",
      "[data-cidr-remove]",
      "[data-cidr-add]",
      "[data-cidr-switch]",
      "[data-token-block]",
      "[data-token-value]",
      "[data-token-reveal]",
      "[data-token-icon]",
      "[data-token-copy]",
      "[data-token-reset]",
      "[data-i18n=\"access.model.bind\"]",
      "[data-i18n=\"access.model.token\"]",
      "[data-i18n=\"access.cidr.note\"]",
      "[data-i18n=\"access.cidr.add\"]",
      "[data-i18n=\"access.cidr.remove\"]",
      "[data-i18n=\"access.cidr.value\"]",
      "[data-i18n=\"access.token.generated\"]",
      "[data-i18n=\"access.token.private\"]",
    ],
    states: ["[data-access-panel][data-state=\"open\"]"],
    rules: [
      { kind: "count", selector: "[data-access-panel]", equals: 1 },
      { kind: "domain", selector: "[data-access-panel]", attribute: "data-state", subset: DOMAINS.PANEL_STATE },
      { kind: "domain", selector: "[data-cidr-whitelist]", attribute: "data-cidr-enabled", subset: DOMAINS.BOOLEAN },
      { kind: "domain", selector: "[data-token-block]", attribute: "data-token-revealed", subset: DOMAINS.BOOLEAN },
      { kind: "domain", selector: "[data-token-icon]", attribute: "data-token-icon", subset: DOMAINS.TOKEN_ICON },
      {
        kind: "manual",
        note:
          "BLOCKS.md documents the CIDR whitelist as a front-end placeholder (rows live in the " +
          "DOM only) and the switch as display-only. Open decision D5: §5.1 of the plan defines " +
          "no CIDR read/write route and `/meta` exposes only `capabilities.allow_list` as a " +
          "boolean, so in the real implementation this block renders **read-only** with a note.",
      },
      {
        kind: "manual",
        note:
          "[data-cidr-switch] is the input and `data-cidr-enabled` is the section's state — the " +
          "two names are deliberately different, because a hook and the state it writes must not " +
          "share one attribute name.",
      },
      {
        kind: "manual",
        note:
          "The token is a stand-in (`td_` + mask) produced in memory and written to the DOM " +
          "nowhere else: no storage, no transport, no credential. Reveal toggles the mask only; " +
          "Copy reports a toast without touching the clipboard.",
      },
      {
        kind: "manual",
        note:
          "Hidden by default with the `hidden` attribute and dismissed by [data-access-close], " +
          "[data-access-overlay] or Esc, with focus returning to the opener.",
      },
    ],
  },

  {
    id: "B20",
    title: "Theme switch (retired)",
    root: null,
    scope: "retired",
    status: "retired",
    required: [],
    states: [],
    rules: [
      { kind: "absent", selector: "[data-theme-modal]" },
      { kind: "absent", selector: "[data-theme-choice]" },
      { kind: "absent", selector: "[data-theme-close]" },
      { kind: "absent", selector: "[data-theme-overlay]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      {
        kind: "manual",
        note:
          "Removed, not hidden: the v1.3 theme dialog, its `.td-choices`/`.td-choice` rows and its " +
          "catalogue keys are deleted from index.html, app.js, src/input.css and the built " +
          "tw.css. What survives is the vocabulary (access.theme.light|dark|auto), now used by " +
          "the B03 three-state cycle.",
      },
    ],
  },

  {
    id: "B21",
    title: "Language menu (replaced)",
    root: null,
    scope: "retired",
    status: "retired",
    required: [],
    states: [],
    rules: [
      { kind: "absent", selector: "[data-lang-modal]" },
      { kind: "absent", selector: "[data-lang-choice]" },
      { kind: "absent", selector: "[data-lang-close]" },
      { kind: "absent", selector: "[data-lang-overlay]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      {
        kind: "manual",
        note:
          "Removed, not hidden: the v1.3 language dialog and the keys access.lang.title / " +
          "access.lang.close are deleted. [data-lang-option=\"en\"|\"zh\"] replaced " +
          "[data-lang-choice]; access.lang.en|zh name the options while " +
          "access.lang.short.en|zh name the trigger.",
      },
    ],
  },

  {
    id: "B22",
    title: "Assignee / Reporter control",
    root: "[data-assignee-input]",
    scope: "create",
    status: "active",
    required: [
      "[data-assignee-input]",
      "[data-assignee-menu]",
      "[data-assignee-option]",
      "[data-reporter-input]",
      "[data-reporter-menu]",
      "[data-reporter-option]",
      "[data-detail-assignee-label]",
      "[data-detail-reporter-label]",
      "[data-assignee-value]",
      "[data-reporter-value]",
    ],
    states: ["[data-combo-new]"],
    rules: [
      { kind: "domain", selector: "[data-assignee-option]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      { kind: "domain", selector: "[data-assignee-option]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "One control, two rosters, four placements: the create dialog's assignee and reporter, " +
          "and the drawer's [data-detail-assignee-label] / [data-detail-reporter-label] (which the " +
          "shipped markup also marks with [data-assignee-input] / [data-reporter-input], so the " +
          "two hook families meet on one element).",
      },
      {
        kind: "manual",
        note:
          "Matching is a case-insensitive substring ranked prefix → contains → subsequence; a " +
          "name the roster does not hold is offered as a `· new` row ([data-combo-new]) and is " +
          "added the moment it is used; an unknown assignee defaults to `human` because a handle " +
          "the board has never seen carries no platform. Both rosters live in memory only.",
      },
      {
        kind: "manual",
        note:
          "**No management entry** — no control anywhere adds, renames or removes a roster " +
          "entry; the list grows only by being used. The absence has no hook to select (the " +
          "forbidden controls were never named), so it is a review item, not a selector.",
      },
      {
        kind: "manual",
        note: "Keyboard: ↑/↓ move, Enter accepts, Esc dismisses (stopPropagation — the drawer also listens), Tab closes.",
      },
    ],
  },

  {
    id: "B23",
    title: "Markdown editor",
    root: "[data-md-editor]",
    scope: "create",
    status: "active",
    required: ["[data-md-editor]", "[data-md-toggle]", "[data-md-source]", "[data-md-highlight]", "[data-md-preview]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-md-editor]", equals: 1 },
      { kind: "count", selector: "[data-md-toggle]", equals: 3 },
      { kind: "domain", selector: "[data-md-toggle]", attribute: "data-md-toggle", subset: DOMAINS.MD_MODE },
      {
        kind: "manual",
        note:
          "The mode in force is written as `data-md-mode` on the panes container, which BLOCKS.md " +
          "names only by the class `.td-md-panes` — there is no hook for it. [data-md-toggle] " +
          "carries `aria-pressed`.",
      },
      {
        kind: "manual",
        note:
          "[data-md-highlight] is a `<pre>` painted behind the textarea and `aria-hidden`; the two " +
          "carry the same `.td-md-text` (class) metrics so they break lines identically, and the " +
          "scroll binding is direct (a `scroll` event does not bubble). [data-md-source] is a " +
          "`<textarea>` and is also [data-create-task-description] (B10).",
      },
      {
        kind: "manual",
        note: "The two vendored renderers are first-party, load from a plain script tag, make no network request and read no storage.",
      },
    ],
  },

  {
    id: "B24",
    title: "Parent / Depends-on control",
    root: "[data-create-task-parent]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-task-parent]",
      "[data-parent-input]",
      "[data-parent-menu]",
      "[data-parent-option]",
      "[data-parent-clear]",
      "[data-create-task-depends]",
      "[data-depends-input]",
      "[data-depends-menu]",
      "[data-depends-option]",
      "[data-depends-chips]",
      "[data-depends-chip]",
    ],
    states: ["[data-depends-remove]", "[data-drop=\"up\"]"],
    rules: [
      { kind: "count", selector: "[data-create-task-parent]", equals: 1 },
      { kind: "count", selector: "[data-create-task-depends]", equals: 1 },
      { kind: "count", selector: "[data-parent-clear]", equals: 1 },
      {
        kind: "manual",
        note:
          "Two optional fields: parent is single-selection (`[data-parent-clear]` empties it); " +
          "depends-on is multi, one [data-depends-chip] per task with its own [data-depends-remove] " +
          "(generated with the chip, so it is a runtime hook — hence under `states`, like B25's " +
          "[data-label-remove]). Both are B22's control pointed at the current project's cards " +
          "(identifier + title) rather than a people roster.",
      },
      {
        kind: "manual",
        note:
          "Free text is **off** (`freeText:false`): a relation can only point at an existing " +
          "task, so there is no `· new` row and nothing joins a roster. A chosen chip is dropped " +
          "from the menu on the next render; choosing it twice is a no-op. The menus ship an " +
          "inert seed as the no-JS floor, redrawn from the live board on focus — the seed's row " +
          "count is fixture data and is not asserted.",
      },
      {
        kind: "manual",
        note:
          "Inside the dialog the menu is clipped by the modal's own scroller, so it flips above " +
          "the control (`.td-combo[data-drop=\"up\"]`) when there is no room below; the depends-on " +
          "field, last in its column, opens upward.",
      },
      {
        kind: "manual",
        note:
          "UI only: no relation is written anywhere — no graph is built, no cycle is checked, " +
          "and the chips reach neither the created card nor any store.",
      },
    ],
  },

  {
    id: "B25",
    title: "Label control",
    root: "[data-create-task-labels]",
    scope: "create",
    status: "active",
    required: [
      "[data-create-task-labels]",
      "[data-label-chips]",
      "[data-label-input]",
      "[data-label-menu]",
      "[data-label-option]",
      "[data-label-value]",
      "[data-detail-labels]",
      "[data-detail-label-chips]",
      "[data-detail-label-chip]",
      "[data-detail-label-remove]",
      "[data-detail-label-input]",
      "[data-detail-label-menu]",
      "[data-detail-label-option]",
      "[data-detail-label-value]",
    ],
    states: ["[data-label-chip]", "[data-label-remove]", "[data-combo-new]"],
    rules: [
      { kind: "count", selector: "[data-create-task-labels]", equals: 1 },
      { kind: "count", selector: "[data-detail-labels]", equals: 1 },
      {
        kind: "manual",
        note:
          "Two hook families for one control: `data-label-*` in the create dialog and " +
          "`data-detail-label-*` in the drawer, so their delegated selectors never collide in a " +
          "single document. The create dialog ships no chips at rest — [data-label-chip] and " +
          "[data-label-remove] are generated on selection (hence under `states`), while the " +
          "drawer ships its chips in the markup.",
      },
      {
        kind: "manual",
        note:
          "Normalisation is case- and whitespace-insensitive (`bug` / `Bug` / `bug ` are one " +
          "label); the entry keeps the first spelling and that is what every surface shows. " +
          "freeText and multi are both on; the menu drops what is already chosen.",
      },
      {
        kind: "manual",
        note:
          "**No management entry** — the hard constraint shared with B22. No \"manage labels\", " +
          "\"label library\", \"delete label\" or \"edit labels\" control exists anywhere, and no " +
          "button adds, renames, merges or expires a label. Auto-cleanup is a backend concern. " +
          "As in B22 this absence has no hook to select, so it stays a review item.",
      },
      {
        kind: "manual",
        note:
          "The roster is read off the board's cards' `data-labels` at first pass — no preset " +
          "list, no enum — and the menu ships an inert seed as the no-JS floor.",
      },
    ],
  },
];

/**
 * The ten consistency items. They have no element of their own (`root: null`), so they
 * carry `scope: "global"`. Rules that repeat a per-block invariant are deliberately
 * restated here: the C-items are the cross-cutting statement, and the block-level rule
 * is the local one.
 */
const CONSISTENCY_ITEMS = [
  {
    id: "C01",
    title: "Every card carries the identical hook set",
    root: null,
    scope: "global",
    status: "active",
    required: [...REQUIRED_BY_EVERY_CARD],
    states: [],
    rules: [
      { kind: "identical-hookset", selector: "[data-card]", when: "board view" },
      {
        kind: "manual",
        note: "A filter, drag or drawer code path never needs to special-case a card.",
      },
    ],
  },

  {
    id: "C02",
    title: "Every column carries the identical hook set and empty-state block",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "identical-hookset", selector: "[data-column]", when: "board view" },
      {
        kind: "count",
        selector: "[data-empty][data-empty-kind=\"column\"]",
        within: "[data-column-body]",
        max: 1,
        when: "board view",
      },
    ],
  },

  {
    id: "C03",
    title: "Colour is never inline",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-status-priority-color-map" },
      {
        kind: "manual",
        note:
          "Components read `--status-color` / `--pri-color`, which are set by `[data-status]` / " +
          "`[data-priority]` attribute rules. Moving a card updates one attribute and the stripe, " +
          "the dot and the chips all follow.",
      },
    ],
  },

  {
    id: "C04",
    title: "Mono discipline",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-mono-tabular-numerals" },
      {
        kind: "manual",
        note:
          "Every identifier, internal id, session id, version, count, timestamp and agent role " +
          "handle uses `.td-mono` with tabular numerals. Which element is \"an identifier\" is a " +
          "reading of the design, not a hook pattern, so only the class's own definition is " +
          "machine-checked.",
      },
    ],
  },

  {
    id: "C05",
    title: "Ids are unique and never a styling hook",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-no-id-selectors" },
      {
        kind: "manual",
        note:
          "Ids in the document are unique and used only for `label[for]` / `aria-labelledby` / " +
          "`aria-controls`. Uniqueness is an attribute invariant (`id`, not a `data-*` hook), so " +
          "the uniqueness half is a review/DOM-check item rather than a selector rule.",
      },
    ],
  },

  {
    id: "C06",
    title: "No block is hidden by the stylesheet",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      {
        kind: "manual",
        note:
          "board ↔ list, the drawer, the modals, the states gallery and the access panel are " +
          "toggled by the `hidden` attribute or `data-state`, never by a `display:none` rule, so " +
          "the static document is readable with JavaScript disabled. **Structural caveat (plan " +
          "D6):** a Vue SPA has no SSR, so with JS off only an empty shell remains. The " +
          "invariant is recorded, and the no-JS difference is a written deviation, not a rule " +
          "this contract can hold the implementation to.",
      },
    ],
  },

  {
    id: "C07",
    title: "One identity model",
    root: null,
    scope: "global",
    status: "active",
    required: ["[data-assignee]", "[data-assignee-kind]", "[data-agent-platform]"],
    states: [],
    rules: [
      { kind: "domain", selector: "[data-assignee-kind]", attribute: "data-assignee-kind", subset: DOMAINS.ASSIGNEE_KIND },
      { kind: "domain", selector: "[data-agent-platform]", attribute: "data-agent-platform", subset: DOMAINS.PLATFORM },
      {
        kind: "manual",
        note:
          "`data-assignee` is always a role handle from the board's roster (six agent roles plus " +
          "the human owner) and never appears as a comment author or activity actor that is not " +
          "one of them. The roster membership itself is fixture data.",
      },
    ],
  },

  {
    id: "C08",
    title: "No brand value is hard-coded",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "source", check: "css-no-hex-outside-tokens" },
      {
        kind: "manual",
        note:
          "Every component reads `--color-td-*` (directly, or through `--status-color` / " +
          "`--pri-color`), takes its shell from daisyUI and its face from a token override. The " +
          "only literals left in markup are the two `--color-td-*` references inside the Sentinel " +
          "Watch mark and its favicon.",
      },
    ],
  },

  {
    id: "C09",
    title: "Every daisyUI component keeps its hook name",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      {
        kind: "manual",
        note:
          "An element may gain `badge` / `avatar` / `tabs` / `progress` / `toggle` / `select` " +
          "classes, but the `data-*` attribute it answers to never moves — the property that let " +
          "the design re-shell eight components without touching a single interaction binding. " +
          "This is a change-detection invariant across revisions, not a check any single snapshot " +
          "can make.",
      },
    ],
  },

  {
    id: "C10",
    title: "The label control is the roster control",
    root: null,
    scope: "global",
    status: "active",
    required: [],
    states: [],
    rules: [
      { kind: "absent", selector: "[data-label-manage]" },
      { kind: "absent", selector: "[data-label-library]" },
      { kind: "absent", selector: "[data-label-edit]" },
      { kind: "absent", selector: "[data-roster-manage]" },
      {
        kind: "manual",
        note:
          "It shares the roster control's accept/upsert code, so the `· new` row, the " +
          "upsert-on-use behaviour and the case-insensitive normalisation are the same code — " +
          "its hooks are its own (`data-label-*`, one set, no reuse of the assignee or relation " +
          "hooks) and its roster is read off the cards, so it cannot drift from what the board " +
          "carries. The four `absent` selectors above are forbidden *names*; the stronger claim — " +
          "that no unnamed control anywhere offers to manage a label — is a review item.",
      },
    ],
  },
];

/**
 * BLOCKS.md's own header counts, with what the DOM actually holds. Kept as data so the
 * suite can prove none of these numbers reached a rule.
 */
export const STALE_PROSE_COUNTS = Object.freeze([
  Object.freeze({
    claim: "252 `data-i18n*` hooks",
    measured: 606,
    detail: "389 `data-i18n` + 144 `-arg` + 47 `-aria-label` + 8 `-placeholder` + 18 `-title`",
    verdict: "stale",
  }),
  Object.freeze({
    claim: "198 catalogue keys",
    measured: 214,
    detail: "en = 214 and zh = 214, mirrored 1:1 (the body's number is the correct one)",
    verdict: "stale",
  }),
  Object.freeze({
    claim: "7 columns · 18 cards · 18 detail templates",
    measured: 7,
    detail: "columns = 7, cards = 18 (live DOM) and templates = 18 — the one header line that agrees",
    verdict: "confirmed-but-unasserted",
  }),
  Object.freeze({
    claim: "[data-slot]: 18 description · 18 activity · 16 comments · 15 agent-session · 11 attachments · 9 relations",
    measured: 87,
    detail: "87 slots total; individual multiplicities are per-card fixture data",
    verdict: "confirmed-but-unasserted",
  }),
]);

/** Hooks outside the numbered blocks (BLOCKS.md's "Auxiliary hooks" table). */
export const AUXILIARY_HOOKS = Object.freeze([
  Object.freeze({ selector: "[data-move-menu]", purpose: "the single shared \"Move to\" menu reused by every card (keyboard fallback for drag)" }),
  Object.freeze({ selector: "[data-move-to]", purpose: "one status row inside the move menu" }),
  Object.freeze({ selector: "[data-drop-placeholder]", purpose: "transient placeholder bar created during dragover" }),
  Object.freeze({ selector: "[data-states-overlay]", purpose: "scrim behind B18" }),
  Object.freeze({ selector: "[data-access-overlay]", purpose: "scrim behind B19" }),
  Object.freeze({ selector: "[data-detail-slot-source]", purpose: "transient wrapper built while copying a detail template into the drawer" }),
  Object.freeze({ selector: "[data-label]", purpose: "one chip per card label" }),
  Object.freeze({ selector: "[data-assignee-value]", purpose: "the name an assignee roster option carries" }),
  Object.freeze({ selector: "[data-reporter-value]", purpose: "the name a reporter roster option carries" }),
  Object.freeze({ selector: "[data-label-value]", purpose: "the name a label option and a label chip carry (dialog family)" }),
  Object.freeze({ selector: "[data-detail-label-value]", purpose: "the name a label option and a label chip carry (drawer family)" }),
  Object.freeze({ selector: "[data-combo-new]", purpose: "marks the generated row offering a name the roster does not hold yet" }),
]);

/** Deep-freeze helper. Pure; runs once at module load on module-local data only. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

deepFreeze(BLOCKS);
deepFreeze(CONSISTENCY_ITEMS);

/** The numbered blocks, in order. */
export const BLOCK_CONTRACT = Object.freeze(BLOCKS);

/** The consistency items, in order. */
export const CONSISTENCY_CONTRACT = Object.freeze(CONSISTENCY_ITEMS);

/** Everything the contract asserts, numbered blocks first. */
export const ALL_CONTRACT_ITEMS = Object.freeze([...BLOCKS, ...CONSISTENCY_ITEMS]);

const ATTRIBUTE_RE = /^\[([a-zA-Z][a-zA-Z0-9_-]*)(?:=("[^"]*"|'[^']*'|[^[\]]*))?\]$/;

/**
 * Parse a contract selector. Pure. Returns `null` for anything that is not an optional
 * bare tag followed by one or more attribute compounds — which is what makes
 * Tailwind classes (`.p-4`), ids (`#board`) and descendant combinators unrepresentable.
 *
 * @param {string} selector
 * @returns {{selector: string, tag: string|null, attributes: {name: string, value: string|null}[], dataAttributes: string[], hasDataHook: boolean}|null}
 */
export function parseHookSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) return null;

  let rest = selector;
  let tag = null;
  const tagMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
  if (tagMatch && rest.length > tagMatch[1].length && rest[tagMatch[1].length] === "[") {
    tag = tagMatch[1];
    rest = rest.slice(tag.length);
  }

  const attributes = [];
  while (rest.length > 0) {
    const end = rest.indexOf("]");
    if (rest[0] !== "[" || end === -1) return null;
    const body = rest.slice(0, end + 1);
    const match = ATTRIBUTE_RE.exec(body);
    if (!match) return null;
    let value = null;
    if (match[2] !== undefined) {
      value = match[2].length >= 2 && (match[2][0] === "\"" || match[2][0] === "'")
        ? match[2].slice(1, -1)
        : match[2];
      if (value.length === 0) return null;
    }
    attributes.push({ name: match[1], value });
    rest = rest.slice(end + 1);
  }

  if (attributes.length === 0) return null;
  const dataAttributes = attributes.filter((a) => a.name.startsWith("data-")).map((a) => a.name);
  return {
    selector,
    tag,
    attributes,
    dataAttributes,
    hasDataHook: dataAttributes.length > 0,
  };
}

/** A selector is a legal contract hook when it parses and names at least one `data-*` attribute. */
export function isHookSelector(selector) {
  const parsed = parseHookSelector(selector);
  return parsed !== null && parsed.hasDataHook;
}

const DOM_LAYER = new Set(["dom"]);
const SOURCE_LAYER = new Set(["source"]);
const MANUAL_LAYER = new Set(["manual"]);

function collectRules(items, layers) {
  const out = [];
  for (const item of items) {
    item.rules.forEach((rule, index) => {
      if (layers.has(RULE_KINDS[rule.kind]?.layer)) {
        out.push(Object.freeze({ block: item.id, index, rule }));
      }
    });
  }
  return Object.freeze(out);
}

/** Rules evaluated against a live DOM (browser layer). */
export const BROWSER_LAYER_RULES = collectRules(ALL_CONTRACT_ITEMS, DOM_LAYER);

/** Rules evaluated browser-free against the built artifacts / stylesheets. */
export const SOURCE_LAYER_RULES = collectRules(ALL_CONTRACT_ITEMS, SOURCE_LAYER);

/** Rules recorded for the human review pass; never machine-checked. */
export const MANUAL_RULES = collectRules(ALL_CONTRACT_ITEMS, MANUAL_LAYER);

/** Every selector the contract declares, deduplicated and sorted. Pure. */
export function allSelectors() {
  const found = new Set();
  const add = (selector) => {
    if (typeof selector === "string" && selector.length > 0) found.add(selector);
  };

  for (const item of ALL_CONTRACT_ITEMS) {
    add(item.root);
    for (const selector of [...item.required, ...item.states]) add(selector);
    for (const rule of item.rules) {
      add(rule.selector);
      add(rule.equalsSelector);
      add(rule.within);
    }
  }
  for (const hook of AUXILIARY_HOOKS) add(hook.selector);

  return Object.freeze([...found].sort());
}

/**
 * Validate the contract against its own schema. Pure; returns a list of human-readable
 * problems (empty when the contract is well formed). The suite asserts this is empty,
 * and the browser layer may re-run it before trusting a rule.
 *
 * @returns {string[]}
 */
export function validateContract() {
  const problems = [];

  const ids = ALL_CONTRACT_ITEMS.map((item) => item.id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate block ids");

  const bIds = ids.filter((id) => id.startsWith("B"));
  bIds.forEach((id, i) => {
    const expected = `B${String(i + 1).padStart(2, "0")}`;
    if (id !== expected) problems.push(`B-series not continuous: expected ${expected}, found ${id}`);
  });
  const cIds = ids.filter((id) => id.startsWith("C"));
  cIds.forEach((id, i) => {
    const expected = `C${String(i + 1).padStart(2, "0")}`;
    if (id !== expected) problems.push(`C-series not continuous: expected ${expected}, found ${id}`);
  });

  for (const item of ALL_CONTRACT_ITEMS) {
    const at = item.id;
    if (!SCOPES.includes(item.scope)) problems.push(`${at}: unknown scope ${item.scope}`);
    if (item.status !== "active" && item.status !== "retired") problems.push(`${at}: unknown status ${item.status}`);

    if (item.root !== null && !isHookSelector(item.root)) {
      problems.push(`${at}: root is not a data-* hook selector: ${item.root}`);
    }
    if (item.root === null && item.status === "active" && item.scope !== "global") {
      problems.push(`${at}: an active non-global block must declare a root`);
    }
    if (item.status === "retired" && item.root !== null) {
      problems.push(`${at}: a retired block must not declare a root`);
    }

    for (const selector of item.required) {
      if (!isHookSelector(selector)) problems.push(`${at}: required selector is not a data-* hook: ${selector}`);
    }
    for (const selector of item.states) {
      if (!isHookSelector(selector)) problems.push(`${at}: state selector is not a data-* hook: ${selector}`);
    }

    item.rules.forEach((rule, index) => {
      const where = `${at}.rules[${index}]`;
      const kind = RULE_KINDS[rule.kind];
      if (!kind) {
        problems.push(`${where}: unknown rule kind ${rule.kind}`);
        return;
      }
      const requireHook = (value, field) => {
        if (!isHookSelector(value)) problems.push(`${where}.${field} is not a data-* hook: ${value}`);
      };
      const requireDataAttribute = (field) => {
        if (typeof rule[field] !== "string" || !rule[field].startsWith("data-")) {
          problems.push(`${where}.${field} must name a data-* attribute: ${rule[field]}`);
        }
      };

      switch (rule.kind) {
        case "count": {
          requireHook(rule.selector, "selector");
          if (rule.within !== undefined) requireHook(rule.within, "within");
          const bounds = ["equals", "min", "max"].filter((key) => rule[key] !== undefined);
          if (bounds.length === 0) problems.push(`${where}: count needs one of equals/min/max`);
          for (const key of bounds) {
            if (!Number.isInteger(rule[key]) || rule[key] < 0) problems.push(`${where}.${key} must be a non-negative integer`);
          }
          break;
        }
        case "order": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (!Array.isArray(rule.equals) || rule.equals.length === 0) problems.push(`${where}.equals must be a non-empty array`);
          break;
        }
        case "identical-hookset": {
          requireHook(rule.selector, "selector");
          if (rule.within !== undefined) requireHook(rule.within, "within");
          break;
        }
        case "domain": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (!Array.isArray(rule.subset) && !Array.isArray(rule.equals)) {
            problems.push(`${where}: domain needs an array subset or equals`);
          }
          break;
        }
        case "absent": {
          requireHook(rule.selector, "selector");
          if (rule.within !== undefined) requireHook(rule.within, "within");
          break;
        }
        case "sequence": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (!Number.isInteger(rule.from)) problems.push(`${where}.from must be an integer`);
          if (!Number.isInteger(rule.step) || rule.step <= 0) problems.push(`${where}.step must be a positive integer`);
          break;
        }
        case "monotonic": {
          requireHook(rule.selector, "selector");
          requireDataAttribute("attribute");
          if (rule.direction !== "non-increasing" && rule.direction !== "non-decreasing") {
            problems.push(`${where}.direction must be non-increasing or non-decreasing`);
          }
          break;
        }
        case "source": {
          if (!Object.prototype.hasOwnProperty.call(SOURCE_CHECKS, rule.check)) {
            problems.push(`${where}.check is not a registered source check: ${rule.check}`);
          }
          break;
        }
        case "manual": {
          if (typeof rule.note !== "string" || rule.note.length === 0) problems.push(`${where}: manual needs a note`);
          break;
        }
        default:
          problems.push(`${where}: unhandled rule kind ${rule.kind}`);
      }
    });
  }

  return problems;
}
