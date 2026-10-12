/**
 * The board's machine-checkable block contract.
 *
 * Transcribed **once, by hand** from `design/BLOCKS.md` (B01–B25 plus the ten
 * "consistency items" C01–C10). This file is the single source of assertion data for
 * the frontend; `design/BLOCKS.md` remains the design's prose authority, it is
 * never parsed, and `design/prototype/**` is never edited from here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS NEVER QUOTE THE PROSE COUNTS (the header-count discrepancy)
 * ---------------------------------------------------------------------------
 * The BLOCKS.md *header* is stale; the *body* is authoritative. Measured against
 * `design/prototype/index.html` and `design/prototype/app.js` (host-side static
 * counting — no browser, no network), re-measured 2026-10-12 after the prototype grew
 * its fourth nav item, the `nav.waiting` key and R8's six-column list header (five
 * `list.columns.*` keys, one `data-i18n` seat each):
 *
 *   header claims                             measured
 *   252 `data-i18n*` hooks in the document     612 (395 `data-i18n` + 144 `-arg`
 *                                                  + 47 `-aria-label` + 8 `-placeholder`
 *                                                  + 18 `-title`)
 *   198 catalogue keys                         en = 220, zh = 220 (exact parity;
 *                                              the body's "220 keys per language,
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
 * can prove none of them leaked into a rule — and re-measures every recorded number
 * against the two documents rather than against a copy of itself.
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
 *   status    `active` | `prototype-only` | `retired` — see below
 *   required  hooks the block owns; normally present in its markup. May be empty.
 *   states    hooks the block owns that are volatile (runtime-created or toggled), so
 *             they are part of the contract but may be absent at rest. May be empty.
 *   rules     the assertions, as data — see `RULE_KINDS` below. This is the ONLY
 *             place numbers live; nothing outside `rules` carries a count.
 *
 * ---------------------------------------------------------------------------
 * PROTOTYPE-ONLY BLOCKS (`prototype-only`)
 * ---------------------------------------------------------------------------
 * Three statuses, and the difference between the last two is the difference
 * between "the design shipped it and it left" and "the design showed it and the
 * product never wanted it":
 *
 *   active          part of the shipped implementation. Its hooks must exist in
 *                   the built app and its rules are evaluated against the page.
 *   prototype-only  transcribed from `design/BLOCKS.md` because the design
 *                   baseline still holds it, but deliberately **not** part of
 *                   the implementation. Its `root`/`required`/`states`/`rules`
 *                   stay declared — the transcription remains complete and
 *                   reviewable — but the implementation-side checks ignore the
 *                   block: `IMPLEMENTED_CONTRACT_ITEMS` and
 *                   `implementationSelectors()` are the views the trusted-bundle
 *                   literal scan (`blocks.bundle.test.mjs`) and the DOM harness
 *                   (`web/scripts/dom-smoke.mjs`) consume.
 *   retired         removed, and the contract asserts its *absence* (B20/B21).
 *
 * Today `prototype-only` is B15 (the sidebar legend) and B18 (the states
 * gallery): Terry's ruling of 2026-10-12 — both are product-design
 * demonstrations rather than functional requirements, so the shipped app renders
 * neither and `design/prototype/**` keeps both. B03's own surface drops the
 * `[data-states-open]` opener that belonged to B18, and B17 (the error state)
 * leaves B18 for the board's real error surface rather than being dropped.
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
export const CONTRACT_SOURCE = "design/BLOCKS.md";

/** Where a block lives. */
export const SCOPES = Object.freeze([
  "shell", // chrome that is always on screen: top bar, sidebar, toasts
  "board", // the kanban + list + their filters, empty/loading and error states
  "detail", // the task detail drawer
  "create", // the two creation dialogs and the controls they embed
  "review", // prototype review surfaces (states gallery, access panel)
  "global", // cross-cutting consistency items
  "retired", // removed blocks, kept in the inventory so their absence is asserted
]);

/**
 * A block that the design baseline keeps but the shipped implementation
 * deliberately does not render. Its metadata and rules stay declared (the
 * transcription of `design/BLOCKS.md` remains complete) while every
 * *implementation-side* check skips it — see the module header.
 */
export const PROTOTYPE_ONLY_STATUS = "prototype-only";

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
  /**
   * Sidebar navigation (B03). M1 appends `waiting` — the one deliberate
   * extension of this frozen baseline, approved with B03's count together
   * (design §10-C6): the 「等你回复」view needs a native, countable, non-column
   * entry point, and the nav item is the only one there is.
   */
  NAV: Object.freeze(["board", "list", "activity", "waiting"]),
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
  /**
   * The live stream's state on the top bar's dot (B02). **Impl-only**: the
   * attribute has no prototype counterpart (the prototype has no network), so
   * this is the one domain whose authority is `web/src/services/events.js`
   * rather than the design. Approved as a written deviation
   * (`surface-disposition.md` #4): an attribute-level addition to an element the
   * prototype already has, never a new node.
   */
  CONNECTION: Object.freeze(["connecting", "open", "closed"]),
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
 *   computed           `{probe, property?, comparators…, count?, visible?, when?}`
 *                      The **computed style** of what `probe` matches, read from a
 *                      live browser. This is the one kind whose selector is *not*
 *                      a contract hook — see `PROBE GRAMMAR` below — because a
 *                      computed value belongs to a rendered box (a chip's height,
 *                      a cell's row direction), and the design names some of
 *                      those boxes by class, not by attribute.
 *   classes            `{probe, includes, when?}`
 *                      Every match's class list contains all of `includes`.
 *   text               `{probe, equals|oneOf|matches, when?}`
 *                      Every match's trimmed text satisfies the comparator;
 *                      `oneOf` is a closed set (a label that may say one of N
 *                      things), `matches` is a RegExp source.
 *   source             `{check, scope?}`
 *                      A named stylesheet/artifact scan from `SOURCE_CHECKS`.
 *   manual             `{note}`
 *                      Recorded intent with no machine rule — see MANUAL_RULES.
 *
 * ---------------------------------------------------------------------------
 * PROBE GRAMMAR (the `probe` field only)
 * ---------------------------------------------------------------------------
 * A rule's `selector` is a **data-* hook** — that is the contract's whole point,
 * and `validateContract()` rejects anything else. The three browser-layer kinds
 * above take `probe` instead, and a probe may be:
 *
 *   * one hook selector (`[data-card-title]`),
 *   * a descendant chain of hook selectors (`[data-list-rows] [data-list-status]`),
 *   * or a class from the **design's own `td-` namespace** (`.td-list-group`,
 *     `.td-chip`), which `design/BLOCKS.md` uses for the sub-parts it does not
 *     give an attribute (the status dot, the list's group shell).
 *
 * A Tailwind utility is not expressible: the namespace is closed and the check
 * is mechanical. This keeps the hook discipline intact — `allSelectors()` and
 * the bundle's literal scan never see a probe, so nothing here widens the
 * declared hook surface.
 */
export const RULE_KINDS = Object.freeze({
  count: Object.freeze({ layer: "dom" }),
  computed: Object.freeze({ layer: "dom" }),
  classes: Object.freeze({ layer: "dom" }),
  text: Object.freeze({ layer: "dom" }),
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
      {
        kind: "manual",
        note:
          "M2 wrote down the four surfaces the app carries and the prototype does not " +
          "(`surface-disposition.md`, approved as written deviations): the load-failure panel " +
          "(B17, relocated from the prototype's states gallery to the board's real error " +
          "surface), the optimistic-write conflict prompt (no prototype counterpart — the " +
          "prototype has no concurrent writers — now carrying `data-conflict` so it is at least " +
          "machine-visible), the live stream's state on the revision dot (B02's " +
          "`data-connection`, an attribute-level addition to an element the prototype has), and " +
          "the manual `?after=` resync, which left the board's main path for the access panel " +
          "on the same ruling. None of the four is blessed as a block: they are recorded, not " +
          "asserted into existence.",
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
      // M2 · the live stream's state rides `data-connection` on the revision
      // cluster's dot. Impl-only (the prototype has no network), approved as a
      // written deviation — see DOMAINS.CONNECTION and `surface-disposition.md` #4.
      { kind: "domain", selector: "[data-connection]", attribute: "data-connection", subset: DOMAINS.CONNECTION },
      // R6 ① — the segmented Board/List control must *show* which side is on.
      // daisyUI's `tabs` paints nothing for `aria-pressed` (its vocabulary is
      // `.tab-active` / `[aria-selected]` / `[aria-current]`), so the selected
      // tab is the implementation's own rule, and these four probes are what
      // hold it: the well is the brand's sunken surface, the pressed tab is
      // accent-on-surface, and pressed is distinguishable from unpressed by
      // more than a font weight. Values are read from the tokens, never from a
      // hex literal, so the same rule holds in both themes.
      { kind: "computed", probe: "[data-view-toggle]", property: "backgroundColor", equalsVar: "--brand-sunken", when: "board view" },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "color",
        equalsVar: "--brand-accent",
        when: "board view",
      },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "backgroundColor",
        equalsVar: "--brand-surface",
        when: "board view",
      },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "color",
        differsFrom: '[data-view-toggle] [data-view][aria-pressed="false"]',
        when: "board view",
      },
      // Exactly one side is on, whichever view is up — so this one carries no
      // precondition.
      { kind: "count", selector: '[data-view][aria-pressed="true"]', within: "[data-view-toggle]", equals: 1 },
      {
        kind: "computed",
        probe: '[data-view-toggle] [data-view][aria-pressed="true"]',
        property: "height",
        equalsPx: 26,
        when: "board view",
      },
      { kind: "absent", selector: "[data-user]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      {
        kind: "manual",
        note:
          "The right cluster — Revision + primary action as one flex item, `margin-left:auto`, " +
          "flush to the header's right padding edge, never split across the folded rows — is " +
          "named in BLOCKS.md only by the class `.td-topbar-actions`. No `data-topbar-actions` " +
          "attribute exists in design/prototype/index.html, although the plan's geometry check assumes " +
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
      "[data-access-status]",
      "[data-access-cell]",
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
      // M1: 4 — `board | list | activity | waiting` (approved with DOMAINS.NAV).
      { kind: "count", selector: "[data-nav-item]", equals: 4 },
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
      // Every project row is filled: `[data-project-count]` is the project's task
      // count, served by `/projects` as `task_count` (BLOCKS.md §Projects), and
      // since R7 ② the hook names the **number** — the pill — rather than the row.
      // "Filled" is therefore no longer checkable as an empty-value `absent` (the
      // attribute is a count, never `""`); the invariant lives in the R7 ② group
      // below as "at most one pill per row" plus the probe rules, which fail if a
      // row's count does not render at all.
      { kind: "sequence", selector: "[data-order-rank]", attribute: "data-order-rank", from: 1, step: 1 },
      { kind: "monotonic", selector: "[data-order-score]", attribute: "data-order-score", direction: "non-increasing" },
      { kind: "absent", selector: "[data-user]" },
      { kind: "absent", selector: "[data-theme-toggle]" },
      { kind: "absent", selector: "[data-lang-toggle]" },
      { kind: "absent", selector: "[data-theme-modal]" },
      { kind: "absent", selector: "[data-lang-modal]" },
      // R6 ② — the selected nav row: accent copy on the accent's 10% tint, and
      // *not* the grey `.td-brand-active` the implementation used to paint. The
      // base metrics (32px row, 6px radius) come with it, because a selected row
      // that is 16px tall in a 13px design is a different component.
      { kind: "count", selector: '[data-nav-item][aria-current="page"]', equals: 1 },
      {
        kind: "computed",
        probe: '[data-nav-item][aria-current="page"]',
        property: "color",
        equalsVar: "--brand-accent",
      },
      {
        kind: "computed",
        probe: '[data-nav-item][aria-current="page"]',
        property: "backgroundColor",
        equalsVar: "--brand-accent-soft",
      },
      {
        kind: "computed",
        probe: '[data-nav-item][aria-current="page"]',
        property: "backgroundColor",
        notEqualsVar: "--brand-active",
      },
      { kind: "computed", probe: "[data-nav-item]", property: "height", equalsPx: 32 },
      { kind: "computed", probe: "[data-nav-item]", property: "borderRadius", equalsPx: 6 },
      // The project row is the same component (BLOCKS.md B03: the two share one
      // rule), so the same two values are asserted on it.
      {
        kind: "computed",
        probe: '[data-project][aria-current="page"]',
        property: "backgroundColor",
        equalsVar: "--brand-accent-soft",
      },
      {
        kind: "computed",
        probe: '[data-project][aria-current="page"]',
        property: "color",
        equalsVar: "--brand-accent",
      },
      // R6 ⑦ — the theme cell holds **three** glyphs and shows **exactly one**,
      // the one its own `data-theme-mode` names. The count is the fix's contract:
      // the glyph in force carries no `hidden` attribute at all, so a literal
      // `hidden="false"` is forbidden (a `hidden` attribute hides whatever its
      // value — the negative rule below pins that against regression).
      { kind: "count", selector: "svg[data-theme-icon]", within: "[data-theme-switch]", equals: 3 },
      { kind: "computed", probe: "[data-theme-switch] svg[data-theme-icon]", visible: true, count: 1 },
      {
        kind: "count",
        selector: 'svg[data-theme-icon][hidden="false"]',
        within: "[data-theme-switch]",
        equals: 0,
      },
      { kind: "count", selector: "svg[data-theme-icon][hidden]", within: "[data-theme-switch]", equals: 2 },
      // R6 ⑦⑧ — the three footer cells are one row each: icon, name and (for
      // the language trigger) the caret sit side by side in a 28px cell, and the
      // label ellipsises rather than wrapping. The rail below 1024px drops the
      // caret and tightens the cell to 24px — the prototype's own rail block.
      { kind: "computed", probe: "[data-theme-switch]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-theme-switch]", property: "gap", equalsPx: 6 },
      { kind: "computed", probe: "[data-theme-switch]", property: "height", equalsPx: 28 },
      { kind: "computed", probe: "[data-lang-select]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-lang-select]", property: "gap", equalsPx: 6 },
      { kind: "computed", probe: "[data-lang-select]", property: "height", equalsPx: 28 },
      {
        kind: "computed",
        probe: "[data-lang-select] span[data-lang-label]",
        property: "textOverflow",
        equals: "ellipsis",
      },
      { kind: "text", probe: "[data-theme-label]", oneOf: ["Light", "Dark", "Auto", "浅色", "深色", "自动"] },
      { kind: "text", probe: "[data-lang-label]", oneOf: ["EN", "中文"] },
      { kind: "computed", probe: "[data-theme-switch]", property: "height", equalsPx: 24, when: "rail" },
      { kind: "computed", probe: "[data-theme-switch]", property: "gap", equalsPx: 0, when: "rail" },
      { kind: "computed", probe: "[data-lang-select] svg.td-caret", property: "display", equals: "none", when: "rail" },
      // R6 ⑧ — the language menu marks the language in force the way the design
      // marks a chosen row: accent copy on the accent's tint.
      {
        kind: "computed",
        probe: '[data-lang-option][aria-pressed="true"]',
        property: "backgroundColor",
        equalsVar: "--brand-accent-soft",
      },
      {
        kind: "computed",
        probe: '[data-lang-option][aria-pressed="true"]',
        property: "color",
        equalsVar: "--brand-accent",
      },

      /* ---- R7 ① · the nav glyphs (`design/fidelity-r7.md` §2.1) ------------
         `svg.td-icon` is both the probe and the assertion: drop the class and
         the probe matches nothing, so the count and every computed rule fail
         together. The glyph carries **no `data-side-icon`** — that hook is the
         project monogram's, and the rail's chip rule matched the nav glyphs
         because they wore it (a 24px bordered grey tile where the prototype
         draws a bare 16px stroke). N1/N4. */
      // A `count … equals: 0`, not an `absent`: the hook is *scoped* out, not
      // retired — the project monogram still carries `data-side-icon` — and the
      // bundle's retired-hook scan reads a valueless `absent` selector as "this
      // attribute must be gone from the app entirely".
      { kind: "count", selector: "[data-side-icon]", within: "[data-nav]", equals: 0 },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", count: 4 },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "fill", equals: "none" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "strokeWidth", equals: "1.5px" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "strokeLinecap", equals: "round" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "strokeLinejoin", equals: "round" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "stroke", notEquals: "none" },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "width", equalsPx: 16 },
      { kind: "computed", probe: "[data-nav] [data-nav-item] svg.td-icon", property: "height", equalsPx: 16 },
      // N2/N3 — the rail's chip face must not reach the nav glyph.
      {
        kind: "computed",
        probe: "[data-nav] [data-nav-item] svg.td-icon",
        property: "borderTopWidth",
        equals: "0px",
        when: "rail",
      },
      {
        kind: "computed",
        probe: "[data-nav] [data-nav-item] svg.td-icon",
        property: "backgroundImage",
        equals: "none",
        when: "rail",
      },
      {
        kind: "computed",
        probe: "[data-nav] [data-nav-item] svg.td-icon",
        property: "backgroundColor",
        equals: "rgba(0, 0, 0, 0)",
        when: "rail",
      },

      /* ---- R7 ② · the project count pill (§2.2) ---------------------------
         The hook names the **number element**, not the row: it sits on the pill
         (N5/N6), the pill wears the brand's `.td-count` face (N7) and the
         element in the DOM is the span (the `span[data-project-count]` count
         plus the one-pill-per-row cap make "the hook is a span" checkable
         without a tagName probe). `width` is a *min*: the pill is
         `min-width:20px` and a two-digit count is legitimately wider. */
      // Scoped to `button[data-project]`, not `[data-project]`: a *card* carries
      // `data-project` too (B07's scalar), so the bare hook is not the row. The
      // row is the button (BLOCKS.md B03), and the pill sits inside it. `max` and
      // not `min`…`max`: the contract lets a row with an unknown count (`null`)
      // render **no** pill at all — "`0` renders, unknown does not" — so only the
      // upper bound is the row's to keep.
      { kind: "count", selector: "button[data-project-count]", within: "[data-project-list]", equals: 0 },
      { kind: "count", selector: "[data-project-count]", within: "button[data-project]", max: 1 },
      { kind: "count", selector: "span[data-project-count]", within: "[data-project-list]", min: 1 },
      { kind: "classes", probe: "[data-project] [data-project-count]", includes: ["badge", "badge-sm", "td-count"] },
      { kind: "text", probe: "[data-project] [data-project-count]", matches: "^\\d+$" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "minWidth", equalsPx: 20 },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "width", minPx: 20 },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "height", equalsPx: 18 },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "borderRadius", equals: "999px" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "fontSize", equals: "11px" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "fontFamily", contains: "mono" },
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "borderTopWidth", equals: "1px" },
      {
        kind: "computed",
        probe: "[data-project] [data-project-count]",
        property: "backgroundColor",
        equalsVar: "--brand-surface",
      },
      // N8 — the rail hides the count (the `.td-count` hide rule, kept).
      { kind: "computed", probe: "[data-project] [data-project-count]", property: "display", equals: "none", when: "rail" },

      /* ---- R7 ③ · the footer splits at 1024 (§2.3) ------------------------
         ≥1024: one row of three equal thirds (a grid with three tracks).
         ≤1023: three stacked rows — `display:flex` + `column`, so the
         *container* is what changes; the **cell** stays a single row (R6 ⑦⑧),
         which is why `flexDirection: row` is asserted on the cell in both
         bands. Per the contract, `grid-template-columns` is deliberately NOT
         asserted in the rail band (it returns the specified value on a
         non-grid box) — `display` and `flexDirection` are the signals. */
      { kind: "count", selector: "[data-access-status]", equals: 1 },
      { kind: "count", selector: "button[data-access-cell]", within: "[data-access-status]", equals: 3 },
      { kind: "count", selector: "[data-theme-switch]", within: "[data-access-status]", equals: 1 },
      { kind: "count", selector: "[data-lang-select]", within: "[data-access-status]", equals: 1 },
      { kind: "count", selector: "[data-access-open]", within: "[data-access-status]", equals: 1 },
      { kind: "computed", probe: "[data-access-status]", property: "display", equals: "grid" },
      { kind: "computed", probe: "[data-access-status]", property: "gridTemplateColumns", tokens: 3 },
      { kind: "computed", probe: "[data-access-status]", property: "alignItems", equals: "stretch" },
      { kind: "computed", probe: "[data-access-cell]", property: "flexDirection", equals: "row" },
      { kind: "computed", probe: "[data-access-cell]", property: "justifyContent", equals: "center" },
      { kind: "computed", probe: "[data-access-cell]", property: "gap", equalsPx: 6 },
      { kind: "computed", probe: "[data-access-cell]", property: "height", equalsPx: 28 },
      { kind: "computed", probe: "[data-access-cell]", property: "paddingLeft", equalsPx: 2 },
      { kind: "computed", probe: "[data-access-cell]", property: "textAlign", equals: "center" },
      // The separator: a vertical hairline at ≥1024 (the first cell drops it),
      // turning into a horizontal one on the 2nd/3rd rail rows (N11/N12/N12b).
      { kind: "computed", probe: "[data-theme-switch]", property: "borderInlineStartWidth", equals: "0px" },
      { kind: "computed", probe: "[data-lang-select]", property: "borderInlineStartWidth", equals: "1px" },
      { kind: "computed", probe: "[data-access-open]", property: "borderInlineStartWidth", equals: "1px" },
      { kind: "computed", probe: "[data-access-cell]", property: "borderBlockStartWidth", equals: "0px" },
      { kind: "computed", probe: "[data-access-status]", property: "display", equals: "flex", when: "rail" },
      { kind: "computed", probe: "[data-access-status]", property: "flexDirection", equals: "column", when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "flexDirection", equals: "row", when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "gap", equalsPx: 0, when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "height", equalsPx: 24, when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "paddingLeft", equalsPx: 0, when: "rail" },
      { kind: "computed", probe: "[data-access-cell]", property: "borderInlineStartWidth", equals: "0px", when: "rail" },
      { kind: "computed", probe: "[data-theme-switch]", property: "borderBlockStartWidth", equals: "0px", when: "rail" },
      { kind: "computed", probe: "[data-lang-select]", property: "borderBlockStartWidth", equals: "1px", when: "rail" },
      { kind: "computed", probe: "[data-access-open]", property: "borderBlockStartWidth", equals: "1px", when: "rail" },
      // N13/N13b — the caret is the first thing the rail drops, and it is on
      // screen at full width.
      { kind: "computed", probe: "[data-access-cell] svg.td-icon", property: "width", equalsPx: 14, visible: true },
      { kind: "computed", probe: "[data-access-cell] svg.td-icon", property: "height", equalsPx: 14, visible: true },
      { kind: "computed", probe: "[data-access-cell] svg.td-icon", property: "fill", equals: "none", visible: true },
      // The glyph is 14px in *both* bands — the rail's "24px" is its row height,
      // never the glyph.
      {
        kind: "computed",
        probe: "[data-access-cell] svg.td-icon",
        property: "width",
        equalsPx: 14,
        visible: true,
        when: "rail",
      },
      { kind: "computed", probe: "[data-lang-select] svg.td-caret", property: "display", notEquals: "none" },
      {
        kind: "manual",
        note:
          "Footer controls are three equal thirds at ≥1024px (`display:grid; " +
          "repeat(3, minmax(0,1fr))`) and three stacked rows at ≤1023px — each a " +
          "block button carrying the `[data-access-cell]` hook (R7 ③) and a " +
          "hairline that turns with the layout (inline start at full width, " +
          "block start on the 2nd/3rd rail rows); cells are keyboard reachable " +
          "with `:focus-visible` rings.",
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
      // R6 ④ — the title is capped at **two lines**. `-webkit-line-clamp` is the
      // only mechanism that both clamps and ellipsises, and `overflow:hidden` is
      // what it needs to bite. `display` is deliberately **not** asserted: the
      // declaration is `-webkit-box`, which Chromium serialises as `flow-root`
      // (R3), so a check on it would be checking the serialisation.
      { kind: "computed", probe: "[data-card-title]", property: "webkitLineClamp", equals: "2" },
      { kind: "computed", probe: "[data-card-title]", property: "overflow", equals: "hidden" },
      // R8 ③ — the card's identifier wears the single-line guard. The cap itself
      // is a render-layer character slice (`web/src/lib/identifier.js`), so what
      // is declarable here is the guard's class and its one-line behaviour; the
      // text/title pair is a relation and is measured in `dom-smoke.mjs`.
      { kind: "classes", probe: "[data-card-identifier]", includes: ["td-id"] },
      { kind: "computed", probe: "[data-card-identifier]", property: "whiteSpace", equals: "nowrap" },
      { kind: "computed", probe: "[data-card-title]", property: "marginTop", equalsPx: 2 },
      { kind: "computed", probe: "[data-card-title]", property: "fontSize", equalsPx: 14 },
      // R6 ④ — the done/canceled title variants (the prototype states both).
      {
        kind: "computed",
        probe: '[data-card][data-done="true"] [data-card-title]',
        property: "color",
        equalsVar: "--brand-text-3",
      },
      {
        kind: "computed",
        probe: '[data-card][data-canceled="true"] [data-card-title]',
        property: "textDecorationLine",
        contains: "line-through",
      },
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
      // M2 · `aria-selected` used to be the literal `false` on every card. It now
      // reports the board's own selection, which is only observable with a card
      // open — hence the driven precondition, alongside the row rules in B09.
      {
        kind: "count",
        selector: "[data-card][aria-selected=\"true\"]",
        equals: 1,
        when: "drawer open",
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
      // R6 ⑤ — the group shell, the head row and the six-track template. The
      // grid's **first and last** tracks are the ones the prototype pins (74px /
      // 72px) and the track count is six; the middle tracks are `minmax(0,1fr)`,
      // whose computed form is not a pixel value (R4), so only the ends and the
      // count are asserted. The head is the sundered 32px band with the uppercase
      // 11px label — the row the implementation used to be missing entirely.
      { kind: "computed", probe: ".td-list-group", property: "backgroundColor", equalsVar: "--brand-surface", when: "list view" },
      { kind: "computed", probe: ".td-list-group", property: "borderRadius", equalsPx: 8, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "height", equalsPx: 32, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "textTransform", equals: "uppercase", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "backgroundColor", equalsVar: "--brand-sunken", when: "list view" },
      // R8 ② — the head is the rows' template. It used to be a `flex` box with a
      // single label while the rows were a six-track grid, so five columns had no
      // heading and no width in the head could line up with a column. The head is
      // now a grid on the rows' own tracks (same ends, same track count, same
      // `gap`, same inline padding), and it names all six columns.
      //
      // Per the contract's own R8-1 correction, the template is never asserted as
      // the literal `74px minmax(0, 1fr) …`: the computed form resolves `minmax`
      // to pixels and moves with the viewport. The ends (74px / 72px), the track
      // count and `gap`/`padding` are what is checkable — and they are the same
      // three things the row's own rules above already pin, which is what makes
      // the two sides comparable.
      { kind: "computed", probe: ".td-list-head", property: "display", equals: "grid", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gridTemplateColumns", startsWith: "74px", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gridTemplateColumns", endsWith: "72px", when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gridTemplateColumns", tokens: 6, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "gap", equalsPx: 12, when: "list view" },
      { kind: "computed", probe: ".td-list-head", property: "paddingLeft", equalsPx: 12, when: "list view" },
      // A head per group — the resident skeleton group's and the data group's —
      // and exactly three of the six labels carry the hide class the row cells
      // carry, so the ≤759px rule reaches both sides of the same column.
      { kind: "computed", probe: ".td-list-head", count: 2, when: "list view" },
      { kind: "computed", probe: ".td-list-head .td-hide-sm", count: 3, when: "list view" },
      // The head's *text* is never its i18n key (the failure a "render the key"
      // regression would produce). Which key each of the six seats carries, in
      // order, and the loading caption's single span, are relations a probe
      // cannot index — `dom-smoke.mjs` reads them.
      { kind: "text", probe: ".td-list-head", matches: "^(?!list\\.)\\S", when: "list view" },
      // R8 ③ — the row's identifier wears the single-line guard too.
      { kind: "classes", probe: "[data-list-identifier]", includes: ["td-id"], when: "list view" },
      { kind: "computed", probe: "[data-list-identifier]", property: "whiteSpace", equals: "nowrap", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "display", equals: "grid", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "gridTemplateColumns", startsWith: "74px", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "gridTemplateColumns", endsWith: "72px", when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "gridTemplateColumns", tokens: 6, when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "minHeight", equalsPx: 40, when: "list view" },
      { kind: "computed", probe: "[data-list-row]", property: "paddingLeft", equalsPx: 12, when: "list view" },
      // The status cell is the same chip the drawer's head wears, and the
      // priority cell the same read-out the card wears — so a status and a
      // priority read identically in both views (R6 ⑤/⑥). The chip's dot is
      // 6px here, not the card dot's 8px.
      { kind: "classes", probe: "[data-list-status]", includes: ["badge-sm", "td-chip", "td-chip-status"], when: "list view" },
      { kind: "computed", probe: "[data-list-status] .td-status-dot", property: "width", equalsPx: 6, when: "list view" },
      { kind: "computed", probe: "[data-list-status] .td-status-dot", property: "height", equalsPx: 6, when: "list view" },
      { kind: "classes", probe: "[data-list-priority]", includes: ["td-pri"], when: "list view" },
      { kind: "computed", probe: "[data-list-priority]", property: "fontSize", equalsPx: 11, when: "list view" },
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
    states: [
      "[data-detail-drawer][data-state=\"open\"]",
      "[data-detail-drawer][data-state=\"closing\"]",
      // M2 · data-driven rows. They exist only while a task is open, so they are
      // asserted in the driven pass (`when: "drawer open"`) below.
      "[data-attachment-row]",
      "[data-attachment-name]",
      "[data-attachment-size]",
      "[data-activity-row]",
      "[data-activity-actor]",
      "[data-activity-ts]",
    ],
    rules: [
      { kind: "count", selector: "[data-detail-drawer]", equals: 1 },
      { kind: "count", selector: "[data-detail-overlay]", equals: 1 },
      // R8 ③ — the drawer's identifier wears the same single-line guard as the
      // card's and the list row's (the cap itself is the render-layer slice), and
      // the drawer **root** carries the full identifier. The root's attribute is
      // the only read-back of identity: the rendered text is a display value, so
      // nothing may resolve a task from it (`design/fidelity-r8.md` §9 R5).
      { kind: "classes", probe: "[data-detail-identifier]", includes: ["td-id"] },
      { kind: "computed", probe: "[data-detail-identifier]", property: "whiteSpace", equals: "nowrap" },
      // The root carries the attribute (the value it carries *is* the assertion,
      // and a value is a relation — `dom-smoke.mjs` compares it against the head's
      // `title` and against the card's own `data-identifier`).
      { kind: "count", selector: "[data-detail-drawer][data-identifier]", equals: 1 },
      { kind: "domain", selector: "[data-detail-drawer]", attribute: "data-state", subset: DOMAINS.DRAWER_STATE },
      { kind: "domain", selector: "[data-slot]", attribute: "data-slot", subset: DOMAINS.SLOT },
      // R6 ⑥ — the head's status chip. The class set is the prototype's own, the
      // 18px height is the box both of the prototype's `.td-chip` declarations
      // agree on, and the dot is 6px (the chip overrides the card dot's 8px).
      // The chip's **background and radius are deliberately not asserted**: the
      // prototype declares `.td-chip` twice in one layer and the two disagree
      // (`accent-soft`/999px vs `surface`/4px), so the value is parked on the
      // design owner's ruling (F6) — the assertion lands with the ruling.
      { kind: "classes", probe: "[data-detail-status-chip]", includes: ["badge-sm", "td-chip", "td-chip-status"] },
      { kind: "computed", probe: "[data-detail-status-chip]", property: "height", equalsPx: 18, when: "drawer open" },
      {
        kind: "computed",
        probe: "[data-detail-status-chip] .td-status-dot",
        property: "width",
        equalsPx: 6,
        when: "drawer open",
      },
      {
        kind: "computed",
        probe: "[data-detail-status-chip] .td-status-dot",
        property: "height",
        equalsPx: 6,
        when: "drawer open",
      },
      // M2 · the drawer's two data-driven streams, asserted where they exist: an
      // open drawer on a task with attachments and history. The rest state cannot
      // show them (the body is empty without a task), which is why these carry a
      // driven precondition rather than riding the default pass.
      {
        kind: "count",
        selector: "[data-attachment-row]",
        within: "[data-detail-attachments]",
        min: 1,
        when: "drawer open",
      },
      {
        kind: "count",
        selector: "[data-activity-row]",
        within: "[data-detail-activity]",
        min: 1,
        when: "drawer open",
      },
      {
        kind: "count",
        selector: "[data-activity-ts]",
        within: "[data-detail-activity]",
        min: 1,
        when: "drawer open",
      },
      {
        kind: "count",
        selector: "[data-i18n=\"attachments.none\"]",
        within: "[data-detail-attachments]",
        equals: 0,
        when: "drawer open",
      },
      {
        kind: "identical-hookset",
        selector: "[data-detail-for]",
        within: "[data-detail-templates]",
      },
      /* ---- R7 ④ · the close button lives in the head's top row (§2.4) -----
         The button shares its flex row with the identifier and the chip,
         levels with it and sits at that row's inline end. Its glyph is an
         `svg.td-icon` (✕), not a text character. The *relations* — same
         parent, centre lines level, flush with the row's right edge, above the
         title — need `parentElement`/`getBoundingClientRect` and are measured
         in `web/scripts/dom-smoke.mjs`; what is declarable here is the glyph
         and the pushed-right box. */
      { kind: "computed", probe: "[data-detail-close] svg.td-icon", count: 1, when: "drawer open" },
      {
        kind: "computed",
        probe: "[data-detail-close] svg.td-icon",
        property: "fill",
        equals: "none",
        when: "drawer open",
      },
      {
        kind: "computed",
        probe: "[data-detail-close] svg.td-icon",
        property: "strokeWidth",
        equals: "1.5px",
        when: "drawer open",
      },
      // `margin-inline-start` resolves `auto` to the used px value (R7-2), so
      // the declarable half of "pushed right" is "greater than zero".
      {
        kind: "computed",
        probe: "[data-detail-close]",
        property: "marginInlineStart",
        minPx: 1,
        when: "drawer open",
      },
      {
        kind: "manual",
        note:
          "[data-detail-close] shares its parent with [data-detail-identifier] " +
          "(same flex row, `flex-direction: row`), is level with it on the " +
          "centre line, sits flush with the row's inline end, and stands " +
          "**above** [data-detail-title] — the prototype's head order (R7 ④, " +
          "`design/fidelity-r7.md` §2.4).",
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
      // R8 ① — the panel has a hook of its own. Until this round the only way to
      // address it was a positional anchor (`[data-create-task] > div`), which the
      // contract's selector grammar forbids, so the dialog's edge, elevation and
      // surface could not be asserted at all (the contract's R8-3 correction).
      // Its dark edge (`--brand-border-strong`) and its scrim are measured in
      // `dom-smoke.mjs`, where the theme can actually be set.
      { kind: "count", selector: "[data-create-task-panel]", equals: 1 },
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
    rules: [
      { kind: "count", selector: "[data-create-project]", equals: 1 },
      // R8 ① — B11 rides B10's panel geometry, so it rides its hook too: the dark
      // edge rule in `app.css` names both panels, and the scrim token is shared.
      { kind: "count", selector: "[data-create-project-panel]", equals: 1 },
    ],
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
          "The large empty state is the class `.td-empty-lg` on " +
          "`[data-empty][data-empty-kind=\"no-results\"]` — there is no `data-empty-lg` " +
          "attribute, and a class cannot appear in this contract. The shipped markup is " +
          "`<div class=\"td-empty td-empty-lg\" data-empty data-empty-kind=\"no-results\" hidden>`. " +
          "(BLOCKS.md B12 used to write it as `[data-empty-lg]`; Elon's ruling ② held the doc " +
          "wrong rather than the DOM, and B12 was corrected to the markup above.)",
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
          "is asserted. The prototype's own states gallery carried a second, static copy of this " +
          "loading state ([data-loading-state]); that gallery is prototype-only and does not ship.",
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
          "`role=\"status\"` + `aria-live=\"polite\"` on the region; auto-dismiss after 2.5s. The " +
          "prototype's states gallery also rendered the three kinds statically with " +
          "`data-state=\"static\"`, so they were never auto-dismissed there; that gallery (B18) is " +
          "prototype-only and does not ship.",
      },
    ],
  },

  {
    id: "B15",
    title: "Legend",
    root: "[data-legend]",
    scope: "shell",
    status: "prototype-only",
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
          "screenshot. **Prototype-only**: Terry's 2026-10-12 ruling — the legend was a " +
          "product-design demonstration rather than a requirement, so the shipped sidebar " +
          "carries no legend and this block is not asserted against the app.",
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
    scope: "board",
    status: "active",
    required: ["[data-error-state]", "[data-error-retry]", "[data-i18n=\"error.title\"]", "[data-i18n=\"error.hint\"]"],
    states: [],
    rules: [
      { kind: "count", selector: "[data-error-state]", min: 1, max: 1 },
      {
        kind: "manual",
        note:
          "`role=\"alert\"`, hidden by default, on the `--color-td-danger-soft` surface the style " +
          "guide reserves for errors; Retry re-runs the real render pass. The prototype " +
          "demonstrated it inside B18 rather than on the board, because the board only raises it " +
          "when a load fails. **Relocated 2026-10-12** (the ruling that removed B15/B18): B18 was " +
          "only the demonstration and is prototype-only now, but this error state is a real state " +
          "of the board — so it moved to the board's own load-failure banner in " +
          "`web/src/App.vue`, rendered `hidden` at rest. The \"exactly one `[data-error-state]` " +
          "in the document\" invariant survives the gallery's removal rather than leaving with it.",
      },
    ],
  },

  {
    id: "B18",
    title: "States showcase",
    root: "[data-states-panel]",
    scope: "review",
    status: "prototype-only",
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
          "handlers. **Prototype-only** since Terry's 2026-10-12 ruling: a gallery of other " +
          "blocks' states is a design demonstration, not a functional requirement, so the " +
          "shipped app renders no gallery, no `[data-states-open]` opener in the sidebar and no " +
          "`[data-states-*]` hooks at all. The one thing inside it that *was* a requirement — " +
          "the error state (B17) — moved to the board's real surface instead of leaving with it.",
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
      // R6 ③ — the panel is the prototype's **centred modal** (ruling F1), not a
      // right-hand drawer: fixed, centred on both axes, capped at the measured
      // 480 × 720. `transform` is asserted as the matrix it computes to, in the
      // driven pass below — the declarative form of `translate(-50%,-50%)` is
      // two half-box translations, which is a geometry, not a string.
      { kind: "computed", probe: "[data-access-panel]", property: "position", equals: "fixed", when: "panel open" },
      // 480 / 720 are stated as computed strings rather than as `equalsPx`: they
      // are lengths, not structural counts, and the suite's stale-prose guard
      // (rightly) refuses any *number* in a rule that reaches the prose range.
      { kind: "computed", probe: "[data-access-panel]", property: "width", equals: "480px", when: "panel open" },
      { kind: "computed", probe: "[data-access-panel]", property: "maxHeight", equals: "720px", when: "panel open" },
      { kind: "computed", probe: "[data-access-panel]", property: "transform", notEquals: "none", when: "panel open" },
      // The token's mask is `td_` + twelve dots — the prefix stays readable and
      // the mask is the design's, not the credential's length (R6 ③).
      { kind: "text", probe: "[data-token-value]", matches: "^td_[•]+$" },
      { kind: "count", selector: "[data-cidr-row]", equals: 3 },
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
          "Every component reads a token (directly, or through `--status-color` / `--pri-color`), " +
          "takes its shell from daisyUI and its face from a token override. The app's token names " +
          "are the web layer's (`--brand-*` for the design's `--color-td-*` inks, lines and " +
          "surfaces; `--color-primary` for `--color-td-accent`), and the Sentinel Watch mark " +
          "spells that mapping out in its own two fills — no colour literal enters markup, and " +
          "the mark's own geometry carries none either.",
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
    measured: 612,
    detail: "395 `data-i18n` + 144 `-arg` + 47 `-aria-label` + 8 `-placeholder` + 18 `-title`",
    verdict: "stale",
  }),
  Object.freeze({
    claim: "198 catalogue keys",
    measured: 220,
    detail: "en = 220 and zh = 220, mirrored 1:1 — the prototype `MESSAGES` count the body states; the shipped extraction drops the 17 prototype-only keys, so it ships 203",
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

/**
 * Hooks outside the numbered blocks (BLOCKS.md's "Auxiliary hooks" table).
 *
 * A hook may carry `status: "prototype-only"` when it served a prototype-only
 * block alone; like the blocks, it stays transcribed here and is skipped by the
 * implementation-side checks.
 */
export const AUXILIARY_HOOKS = Object.freeze([
  Object.freeze({ selector: "[data-move-menu]", purpose: "the single shared \"Move to\" menu reused by every card (keyboard fallback for drag)" }),
  Object.freeze({ selector: "[data-move-to]", purpose: "one status row inside the move menu" }),
  Object.freeze({ selector: "[data-drop-placeholder]", purpose: "transient placeholder bar created during dragover" }),
  Object.freeze({
    selector: "[data-states-overlay]",
    purpose: "scrim behind B18",
    status: "prototype-only",
  }),
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

/**
 * The items the **shipped** implementation answers for: everything that is not
 * `prototype-only`. Retired blocks stay in (their absence is still asserted
 * against the app); prototype-only blocks do not, because the app is not
 * supposed to render them. This is the view the implementation-side checks use.
 */
export const IMPLEMENTED_CONTRACT_ITEMS = Object.freeze(
  ALL_CONTRACT_ITEMS.filter((item) => item.status !== PROTOTYPE_ONLY_STATUS),
);

const ATTRIBUTE_RE = /^\[([a-zA-Z][a-zA-Z0-9_-]*)(?:=("[^"]*"|'[^']*'|[^[\]]*))?\]$/;

/**
 * Parse a contract selector. Pure. Returns `null` for anything that is not an optional
 * bare tag followed by one or more attribute compounds — which is what makes
 * Tailwind classes (`.p-4`), ids (`#board`) and descendant combinators unrepresentable.
 * Quoted values may be empty (`[data-project-count=""]`), which asserts the attribute
 * is *present but valueless* — see the `quoted` branch below.
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
      const quoted = match[2].length >= 2 && (match[2][0] === "\"" || match[2][0] === "'");
      value = quoted ? match[2].slice(1, -1) : match[2];
      // An *unquoted* empty value (`[data-x=]`) stays a syntax error. A **quoted**
      // one (`[data-x=""]`) is legal, and deliberately so: it is the only way the
      // grammar can ask "does this element carry the attribute *empty*?" — which
      // is how a rule asserts a value is present on every element (B03's
      // `[data-project-count=""]`), since `[data-x]` alone also matches filled ones.
      if (!quoted && value.length === 0) return null;
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

/** One `td-` class from the design's own namespace (`.td-chip`, `.td-list-head`). */
const DESIGN_CLASS_RE = /^\.td-[a-z0-9-]+$/;

/** An optional bare tag followed by one or more `[attr]` / `.td-class` compounds. */
const PROBE_PART_RE = /^[a-z][a-z0-9-]*(?:\[[a-zA-Z][a-zA-Z0-9_-]*(?:="[^"]*")?\]|\.td-[a-z0-9-]+)+$/;

/** Does this probe part name a hook attribute or a design class (never a bare tag)? */
const PROBE_ANCHOR_RE = /\[data-[a-zA-Z]|\.td-[a-z0-9-]+/;

/** One whitespace-free probe part: a hook, a design class, or a tag+compounds of either. */
function isProbePart(part) {
  if (isHookSelector(part) || DESIGN_CLASS_RE.test(part)) return true;
  if (!PROBE_PART_RE.test(part) || !PROBE_ANCHOR_RE.test(part)) return false;
  return (part.match(/\[[^\]]*\]/g) ?? []).every((bracket) => parseHookSelector(bracket) !== null);
}

/**
 * A **probe** selector: what a computed-style / class / text rule is allowed to
 * name — see `PROBE GRAMMAR` in the module header. Module-private on purpose: a
 * probe is not part of the declared hook surface, so it is deliberately absent
 * from `allSelectors()`, `implementationSelectors()` and the bundle's literal
 * scan, and it is not exported either (the public-surface test pins the exports).
 */
function isProbeSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) return false;
  return selector
    .trim()
    .split(/\s+/)
    .every(isProbePart);
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

/**
 * The walk both selector surfaces share: every selector an item set declares,
 * plus the given auxiliary hooks, deduplicated and sorted.
 */
function selectorsOf(items, auxiliary) {
  const found = new Set();
  const add = (selector) => {
    if (typeof selector === "string" && selector.length > 0) found.add(selector);
  };

  for (const item of items) {
    add(item.root);
    for (const selector of [...item.required, ...item.states]) add(selector);
    for (const rule of item.rules) {
      add(rule.selector);
      add(rule.equalsSelector);
      add(rule.within);
    }
  }
  for (const hook of auxiliary) add(hook.selector);

  return Object.freeze([...found].sort());
}

/**
 * Every selector the contract declares, deduplicated and sorted. Pure.
 *
 * This is the *declared surface* — prototype-only blocks and hooks included, so
 * the transcription stays reviewable in one place. The selectors the shipped app
 * must actually carry are `implementationSelectors()` below.
 */
export function allSelectors() {
  return selectorsOf(ALL_CONTRACT_ITEMS, AUXILIARY_HOOKS);
}

/**
 * Every selector the **shipped** app answers for, deduplicated and sorted. Pure.
 *
 * The same walk over `IMPLEMENTED_CONTRACT_ITEMS` and over the auxiliary hooks
 * that are not prototype-only. Note this is a positive walk, not a subtraction:
 * a hook both a prototype-only block and a shipped one declare (the states
 * gallery and B17 both carried `[data-error-state]`) stays, because the shipped
 * block still asks for it.
 */
export function implementationSelectors() {
  return selectorsOf(
    IMPLEMENTED_CONTRACT_ITEMS,
    AUXILIARY_HOOKS.filter((hook) => hook.status !== PROTOTYPE_ONLY_STATUS),
  );
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
    if (!["active", PROTOTYPE_ONLY_STATUS, "retired"].includes(item.status)) {
      problems.push(`${at}: unknown status ${item.status}`);
    }

    if (item.root !== null && !isHookSelector(item.root)) {
      problems.push(`${at}: root is not a data-* hook selector: ${item.root}`);
    }
    if (item.root === null && item.status !== "retired" && item.scope !== "global") {
      problems.push(`${at}: a shipping or prototype-only non-global block must declare a root`);
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
      const requireProbe = () => {
        if (!isProbeSelector(rule.probe)) problems.push(`${where}.probe is not a legal probe selector: ${rule.probe}`);
      };

      switch (rule.kind) {
        case "computed": {
          requireProbe();
          const comparators = [
            "equals",
            "equalsVar",
            "equalsPx",
            "notEquals",
            "notEqualsVar",
            "contains",
            "startsWith",
            "endsWith",
            "tokens",
            "maxPx",
            "minPx",
            "differsFrom",
          ].filter((key) => rule[key] !== undefined);
          const shaped = rule.property !== undefined || rule.count !== undefined || rule.visible === true;
          if (!shaped) problems.push(`${where}: computed needs a property, a count or visible`);
          if (rule.property !== undefined) {
            if (typeof rule.property !== "string" || rule.property.length === 0) problems.push(`${where}.property must be a CSS property name`);
            if (comparators.length === 0) problems.push(`${where}: computed needs a comparator for ${rule.property}`);
          } else if (comparators.length > 0) {
            problems.push(`${where}: a comparator without a property has nothing to read`);
          }
          for (const key of ["equalsPx", "maxPx", "minPx"]) {
            if (rule[key] !== undefined && typeof rule[key] !== "number") problems.push(`${where}.${key} must be a number`);
          }
          if (rule.tokens !== undefined && (!Number.isInteger(rule.tokens) || rule.tokens < 1)) {
            problems.push(`${where}.tokens must be a positive integer`);
          }
          if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 0)) {
            problems.push(`${where}.count must be a non-negative integer`);
          }
          if (rule.visible !== undefined && typeof rule.visible !== "boolean") problems.push(`${where}.visible must be a boolean`);
          if (rule.differsFrom !== undefined && !isProbeSelector(rule.differsFrom)) {
            problems.push(`${where}.differsFrom is not a legal probe selector: ${rule.differsFrom}`);
          }
          break;
        }
        case "classes": {
          requireProbe();
          if (!Array.isArray(rule.includes) || rule.includes.length === 0) problems.push(`${where}.includes must be a non-empty array`);
          break;
        }
        case "text": {
          requireProbe();
          const modes = ["equals", "oneOf", "matches"].filter((key) => rule[key] !== undefined);
          if (modes.length !== 1) problems.push(`${where}: text needs exactly one of equals/oneOf/matches`);
          if (rule.oneOf !== undefined && (!Array.isArray(rule.oneOf) || rule.oneOf.length === 0)) {
            problems.push(`${where}.oneOf must be a non-empty array`);
          }
          break;
        }
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
