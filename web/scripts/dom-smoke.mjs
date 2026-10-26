/**
 * Host-only DOM smoke + block-contract runner (M6b · F2 L2).
 *
 * The **browser layer**: it serves the built app (`web/dist`) against a small
 * fixture API, opens it in a headless Chromium, and reports
 *
 *   * every **console error** and **page error** (the acceptance bar is zero), and
 *   * the result of each dom-layer assertion from `test/web/blocks.contract.mjs`
 *     (`EVALUATED_RULES`), evaluated against the live DOM.
 *
 * Playwright is a **host tool only** — it is deliberately NOT in `web/package.json`
 * (that would put it in the offline cache and the container image, and the image
 * carries no browser). It is resolved from an already-installed location (a
 * global npm root, `PLAYWRIGHT_ROOT`, or the current tree); when it is absent the
 * script exits **2** ("skip"), following the "absent tool ⇒ SKIP, never FAIL"
 * precedent. Rendering is a host-allowed exception (`docs/docker.md`;
 * plan §9.1 exception 4).
 *
 * Deliberately under `web/scripts/`, not `test/`, so `node --test` never collects
 * it. `test/web/blocks.dom.test.mjs` runs it and turns exit 2 into a `skip`.
 *
 * Usage: node web/scripts/dom-smoke.mjs [--json]
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSER_LAYER_RULES, IMPLEMENTED_CONTRACT_ITEMS } from "../../test/web/blocks.contract.mjs";
import { applyPxVerdicts } from "./px-assert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
export const DIST = resolve(WEB, "dist");

/**
 * The DOM rules the **shipped** app is held to.
 *
 * `BROWSER_LAYER_RULES` is every dom-layer rule the contract declares, including
 * the prototype-only blocks (B15 the legend, B18 the states gallery) — whose
 * elements the app is not supposed to render, so asserting them against the page
 * would contradict the contract. This is the filtered set this harness runs, and
 * the set `web/scripts/shot-compare.mjs` reports as the expected rule count.
 */
export const EVALUATED_RULES = Object.freeze(
  (() => {
    const implemented = new Set(IMPLEMENTED_CONTRACT_ITEMS.map((item) => item.id));
    return BROWSER_LAYER_RULES.filter((entry) => implemented.has(entry.block));
  })(),
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/* ------------------------------------------------------------- fixture API */

function fixture(projectId, status, overrides = {}) {
  return {
    // The internal id is derived from the **identifier**, not from project+status:
    // two cards share a status, and an id they also shared would make every
    // `task_id` lookup in the fixture ambiguous (the activity ledger resolves each
    // row's task through that id, so a collision silently mislabels rows).
    id: overrides.id ?? `td_${(overrides.identifier ?? "TD-1").replace(/[^A-Za-z0-9]/g, "_")}`,
    identifier: overrides.identifier ?? "TD-1",
    project_id: projectId,
    title: overrides.title ?? `Task in ${status}`,
    description: overrides.description ?? "# Heading\n\nSome **bold** text and `code`.",
    status,
    priority: overrides.priority ?? "medium",
    kind: "task",
    labels: overrides.labels ?? ["bug"],
    // M1 — the `awaiting` entry category (`null` on every other card).
    awaiting_reason: overrides.awaiting_reason ?? null,
    // 0038 — the acceptance decision. The fixture is a wire reading, so the
    // field has to be present: the waiting queue derives "a human still owes
    // this" from `acceptance_mode === "human"`, and an absent field would read
    // as `off` and silently empty the queue.
    acceptance_mode: overrides.acceptance_mode ?? "off",
    meta: overrides.meta ?? {},
    assignee: overrides.assignee ?? { id: "a1", display_name: "linus", kind: "agent" },
    reporter: { id: "h1", display_name: "Terry", kind: "human" },
    version: 1,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

/** The agents/humans a card can be assigned to, with their platform dictionary. */
const AGENT = {
  claude: { id: "a1", display_name: "linus", kind: "agent" },
  codex: { id: "a2", display_name: "jobs", kind: "agent" },
  openclaw: { id: "a3", display_name: "elon", kind: "agent" },
  pi: { id: "a4", display_name: "assistant", kind: "agent" },
  human: { id: "h1", display_name: "Terry", kind: "human" },
};

/**
 * A one-page PDF with a correct cross-reference table, so the drawer's preview
 * leg hands Chromium a document its viewer actually opens. Built here rather than
 * pasted as a base64 blob so the offsets cannot drift from the objects.
 *
 * @returns {Buffer}
 */
function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

/**
 * Fixture data for the demo board.
 *
 * The board is a kanban over seven statuses, so the sample must put a card in
 * **every** column — otherwise a column's visual (its dot, count, stripe) has no
 * render to compare. Beyond that it deliberately covers the contract's
 * dimensions: a human card beside the agent cards (B07 identity), all four agent
 * platforms (B03 presence / B07 badge), five labels and five priorities. Counts
 * here are fixture data, never asserted — the browser-layer rules assert
 * structure, not how many rows this function returns.
 */
export function fixtureApi() {
  // `task_count` is the sidebar badge's wire field (`/projects` → `projectToWire`).
  // It is fixture data and deliberately **not** derived from the `tasks` array
  // below — those all belong to p1, which is exactly the condition the old client
  // bug needed: a row's count must come from the project, not from whichever task
  // list the client happens to be holding. p2 and p3 own no fixture task at all
  // and still print 4 and 2.
  const mk = (id, name, taskCount, prefix) => ({
    id,
    name,
    // C-RAIL-1 — the rail chip's wire field. `/projects` serves the project's
    // **effective prefix** (`projectToWire`), and the sidebar renders it
    // verbatim; the three values below are the prototype's own seed chips
    // (ORC / TD / SR, `design/prototype/app.js` `PROJECT_PREFIX`), which is what
    // the server would serve for these three projects. Without the field the
    // chip renders empty — the fixture has to carry it, exactly as the real
    // route does.
    prefix,
    workspace_path: `/w/${id}`,
    labels: [],
    meta: {},
    readme: null,
    task_count: taskCount,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  // The prototype sidebar's three rows and their counts (12 / 4 / 2) — three, so
  // the "every row is filled" rule has the prototype's own 3/3 shape to assert.
  const projects = [
    mk("p1", "MeerkatTaskPanel", 12, "TD"),
    mk("p2", "Orchestrator", 4, "ORC"),
    mk("p3", "Site Refresh", 2, "SR"),
  ];
  const orderDebug = [
    { id: "p1", name: "MeerkatTaskPanel", order: 1, total: 0.9, archived: false },
    { id: "p2", name: "Orchestrator", order: 2, total: 0.4, archived: false },
    { id: "p3", name: "Site Refresh", order: 3, total: 0.2, archived: false },
  ];
  // 12 cards, all in the default project (p1), covering the seven statuses.
  const tasks = [
    // TD-1 is the card the drawer opens on in the interaction pass, so it is the
    // one that carries attachments — one row per preview family plus a zip the
    // drawer must not offer to open. `meta.attachment_count` states the same
    // number the list shows, so the card badge and the drawer cannot disagree.
    fixture("p1", "backlog", {
      identifier: "TD-1",
      title: "Draft the onboarding copy",
      priority: "low",
      labels: ["design"],
      assignee: AGENT.pi,
      meta: {
        attachment_count: 5,
        attachments: [
          { filename: "board-keyboard-spec.md", size: 12 * 1024 },
          { filename: "focus-order-record.png", size: 248 * 1024 },
          { filename: "layout-drawing.pdf", size: 64 * 1024 },
          { filename: "walkthrough.mp4", size: 2 * 1024 * 1024 },
          { filename: "build-bundle.zip", size: 1024 },
        ],
      },
    }),
    // R12 — the one **over-cap** identifier. Eight is the render layer's slice
    // threshold (`web/src/lib/identifier.js`), so a nine-character id is the
    // smallest sample that exercises it: the card and the list row still show
    // `PROJ-000…`, and the drawer head is the render point that must show
    // `PROJ-0007` whole (`design/fidelity-r12.md` §5 A1/A4). The value is the
    // contract's own anchor sample, so the driven assertions and the contract's
    // table name the same string.
    fixture("p1", "backlog", { identifier: "PROJ-0007", title: "Collect the install survey", priority: "none", labels: [], assignee: AGENT.human }),
    fixture("p1", "todo", { identifier: "TD-3", title: "Wire the board", priority: "high", labels: ["bug"], assignee: AGENT.claude }),
    fixture("p1", "todo", { identifier: "TD-4", title: "Polish the empty states", priority: "medium", labels: ["ui"], assignee: AGENT.codex }),
    fixture("p1", "in_progress", { identifier: "TD-5", title: "Fix the renderer", priority: "urgent", labels: ["bug", "ui"], assignee: AGENT.codex }),
    fixture("p1", "in_progress", { identifier: "TD-6", title: "Profile the board scroll", priority: "high", labels: ["perf"], assignee: AGENT.claude }),
    fixture("p1", "in_review", { identifier: "TD-7", title: "Audit the token store", priority: "medium", labels: ["security"], assignee: AGENT.openclaw, acceptance_mode: "human" }),
    fixture("p1", "in_review", { identifier: "TD-8", title: "Redesign the sidebar rail", priority: "low", labels: ["design", "ui"], assignee: AGENT.pi, acceptance_mode: "human" }),
    fixture("p1", "blocked", { identifier: "TD-9", title: "Waiting on review", priority: "high", labels: ["bug"], assignee: AGENT.claude }),
    // M1 · the 「等你回复」card. Its status is the overlay, so it is *listed* under
    // in_progress (the seventh column count does not change) and it wears the
    // badge; `awaiting_reason` is the entry category the badge carries.
    fixture("p1", "awaiting", { identifier: "TD-13", title: "Confirm the release scope before the cut", priority: "urgent", labels: ["design"], assignee: AGENT.claude, awaiting_reason: "E1" }),
    fixture("p1", "done", { identifier: "TD-10", title: "Ship the CLI", priority: "low", labels: [], assignee: AGENT.human }),
    fixture("p1", "canceled", { identifier: "TD-11", title: "Drop the legacy importer", priority: "none", labels: ["perf"], assignee: AGENT.openclaw }),
    fixture("p1", "done", { identifier: "TD-12", title: "Lock down the webhooks", priority: "medium", labels: ["security", "design"], assignee: AGENT.pi }),
  ];
  // The actor dictionary (0019): one table, no `platform` column. `kind` is the
  // actor's kind — `agent`/`human` today, which name no platform, so the badges
  // stay absent exactly as they were while `platform` was never written.
  const entries = [
    { id: "a1", kind: "agent", display_name: "linus", normalized_name: "linus" },
    { id: "a2", kind: "agent", display_name: "jobs", normalized_name: "jobs" },
    { id: "a3", kind: "agent", display_name: "elon", normalized_name: "elon" },
    { id: "a4", kind: "agent", display_name: "assistant", normalized_name: "assistant" },
    { id: "h1", kind: "human", display_name: "Terry", normalized_name: "terry" },
  ];
  const labels = [
    { id: "l1", project_id: "p1", norm: "bug", display_name: "bug", color: null },
    { id: "l2", project_id: "p1", norm: "ui", display_name: "ui", color: null },
    { id: "l3", project_id: "p1", norm: "design", display_name: "design", color: null },
    { id: "l4", project_id: "p1", norm: "perf", display_name: "perf", color: null },
    { id: "l5", project_id: "p1", norm: "security", display_name: "security", color: null },
  ];
  // M1 — the payload is the *human* comment that triggered the entry, read from
  // the card's own history (design §2.2). Keyed by identifier; the visible card
  // history is what the waiting view renders, so the fixture must serve it.
  const comments = {
    // TD-1 · the drawer's comment list (B09), served **oldest-first** on
    // purpose: the route's `order` parameter is not honoured by this fixture, so
    // the drawer's own newest-first ordering is what the interaction pass reads.
    "TD-1": [
      { id: "cm-4", task_id: "td_TD_1", kind: "note", author_kind: "agent", author_id: "jobs", body: "先起草第一段。", refs: [], created_at: "2026-10-12T00:03:00Z" },
      { id: "cm-5", task_id: "td_TD_1", kind: "note", author_kind: "human", author_id: "Terry", body: "补上第二段，再走一遍。", refs: [], created_at: "2026-10-12T00:04:00Z" },
    ],
    "TD-13": [
      { id: "cm-1", task_id: "TD-13", kind: "note", author_kind: "agent", author_id: "linus", body: "我先把迁移写完了。", refs: [], created_at: "2026-10-12T00:01:00Z" },
      { id: "cm-2", task_id: "TD-13", kind: "decision", author_kind: "human", author_id: "Terry", body: "范围确认：这一版不做第 8 列。后面还有一句不该出现在摘要里。", refs: [], created_at: "2026-10-12T00:02:00Z" },
    ],
  };
  // M2 — the audit trail the drawer's activity stream renders (B09): one row per
  // sentence the catalogue names plus the move's own `from → to` line, so both
  // rungs of the relative-time ladder (`…h ago` and `…d ago`) are exercised.
  //
  // R12x · B26 — the same array is the Activity feed's raw material, so it also
  // covers what that view's rules need: several calendar days, both actor kinds,
  // one burst (three field edits by one actor on one card inside five minutes),
  // two rows of pure noise that must **not** be admitted, and a fifth day beyond
  // the first page of day groups so `Load older` has something to unfold.
  //
  // Stamps are relative to the run's own clock, not fixed: the feed groups by
  // *local calendar day* and heads those days `Today` / `Yesterday`, so a fixture
  // pinned to a date would silently change meaning tomorrow.
  const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString();
  /**
   * A stamp that is always on **today's** local calendar day.
   *
   * The feed groups by local day and the zh copy leg names the first group
   * `今天`. Relative stamps alone make that assertion false for the first
   * minutes after local midnight (the newest rows are still `minutes(12)` /
   * `minutes(25)` old, i.e. yesterday). Clamping to one minute past midnight
   * keeps the intended "today" row at every hour; outside that window the
   * ordinary relative stamp is unchanged.
   */
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = (n) => new Date(Math.max(Date.now() - n * 60_000, midnight.getTime() + 60_000)).toISOString();
  const activities = [
    // TD-1 · the drawer's stream (B09) — untouched, one row per sentence.
    { id: "act-1", task_id: "td_TD_1", actor_kind: "human", actor_id: "Terry", event: "task_created", changes: { identifier: "TD-1", status: "backlog" }, revision: 1, created_at: minutes(30 * 60) },
    { id: "act-2", task_id: "td_TD_1", actor_kind: "agent", actor_id: "jobs", event: "task_claimed", changes: { from: "backlog", to: "backlog" }, revision: 2, created_at: minutes(26 * 60) },
    { id: "act-3", task_id: "td_TD_1", actor_kind: "human", actor_id: "Terry", event: "task_moved", changes: { from: "backlog", to: "todo" }, revision: 3, created_at: minutes(8 * 60) },
    { id: "act-4", task_id: "td_TD_1", actor_kind: "agent", actor_id: "jobs", event: "comment_added", changes: { commentId: "cm-1", kind: "discuss" }, revision: 4, created_at: minutes(4 * 60) },
    // Today — one row per admitted family, plus the burst and the two noise rows.
    { id: "act-5", task_id: "td_TD_7", actor_kind: "human", actor_id: "Terry", event: "comment_added", changes: { commentId: "cm-2", kind: "decision" }, revision: 5, created_at: today(12) },
    { id: "act-6", task_id: "td_TD_13", actor_kind: "human", actor_id: "Terry", event: "comment_added", changes: { commentId: "cm-3", kind: "decision" }, revision: 6, created_at: minutes(25) },
    { id: "act-7", task_id: "td_TD_5", actor_kind: "agent", actor_id: "jobs", event: "task_delivered", changes: { from: "in_progress", to: "in_review", round: 2, reportId: "rp-2", deliveryRound: 2 }, revision: 7, created_at: minutes(40) },
    { id: "act-8", task_id: "td_TD_3", actor_kind: "agent", actor_id: "linus", event: "task_moved", changes: { from: "todo", to: "in_progress", deliveryRound: 1 }, revision: 8, created_at: minutes(90) },
    // The burst: one actor, one card, three field edits inside five minutes.
    { id: "act-9", task_id: "td_TD_6", actor_kind: "agent", actor_id: "jobs", event: "task_updated", changes: { fields: ["assignee"], dictionaries: [{ dictionary: "assignee", id: "a2", displayName: "jobs", action: "existing" }] }, revision: 9, created_at: minutes(200) },
    { id: "act-10", task_id: "td_TD_6", actor_kind: "agent", actor_id: "jobs", event: "task_updated", changes: { fields: ["labels"], labels: [{ norm: "perf", displayName: "perf", color: null, action: "existing" }] }, revision: 10, created_at: minutes(202) },
    { id: "act-11", task_id: "td_TD_6", actor_kind: "agent", actor_id: "jobs", event: "task_updated", changes: { fields: ["priority"] }, revision: 11, created_at: minutes(203) },
    // Noise: a heartbeat and a session registration. Neither may reach the feed.
    { id: "act-noise-1", task_id: "td_TD_5", actor_kind: "agent", actor_id: "jobs", event: "task_heartbeat", changes: {}, revision: 12, created_at: minutes(5) },
    { id: "act-noise-2", task_id: "td_TD_5", actor_kind: "agent", actor_id: "jobs", event: "session_registered", changes: { sessionId: "s-1" }, revision: 13, created_at: minutes(6) },
    // Yesterday and older — the feed's other day groups.
    { id: "act-12", task_id: "td_TD_8", actor_kind: "agent", actor_id: "elon", event: "task_created", changes: { identifier: "TD-8", status: "in_review" }, revision: 14, created_at: minutes(25 * 60) },
    { id: "act-13", task_id: "td_TD_9", actor_kind: "agent", actor_id: "elon", event: "relation_added", changes: { relationId: "rel-1", type: "depends_on", source: "td_TD_9", target: "td_TD_8" }, revision: 15, created_at: minutes(27 * 60) },
    { id: "act-14", task_id: "td_TD_11", actor_kind: "human", actor_id: "Terry", event: "task_moved", changes: { from: "done", to: "canceled" }, revision: 16, created_at: minutes(30 * 60) },
    { id: "act-15", task_id: "td_TD_4", actor_kind: "agent", actor_id: "linus", event: "task_claimed", changes: { from: "todo", to: "in_progress" }, revision: 17, created_at: minutes(52 * 60) },
    { id: "act-16", task_id: "td_TD_12", actor_kind: "human", actor_id: "Terry", event: "report_waived", changes: { from: "in_review", to: "done", round: 1, reason: "evidence attached to the card" }, revision: 18, created_at: minutes(56 * 60) },
    { id: "act-17", task_id: "td_TD_2", actor_kind: "agent", actor_id: "jobs", event: "task_updated", changes: { fields: ["title"] }, revision: 19, created_at: minutes(58 * 60) },
    // Beyond the first page of day groups (three days), so `Load older` unfolds.
    { id: "act-18", task_id: "td_TD_10", actor_kind: "human", actor_id: "Terry", event: "task_created", changes: { identifier: "TD-10", status: "done" }, revision: 20, created_at: minutes(120 * 60) },
  ];
  // R14 ① — the drawer's relation rows. Keyed by the task's internal id, the way
  // the real route scopes them, and TD-1 is the card the interaction pass opens,
  // so it is the one that carries **all three** kinds: `parent`, `blocks` and
  // `related` is the domain's whole vocabulary (`RELATION_TYPES`,
  // `src/core/domain/enums.mjs`), which is what lets the drawer's three category
  // words be measured on one screen. The refs are the fixture's own ids — they
  // are derived from the *identifier* (`fixture()` above), so PROJ-0007 is
  // `td_PROJ_0007`, not `td_TD_2`.
  const relations = {
    td_TD_1: [
      { id: "rel-parent", type: "parent", source: "td_PROJ_0007", target: "td_TD_1", origin: null, created_at: minutes(46 * 60) },
      { id: "rel-blocks", type: "blocks", source: "td_TD_1", target: "td_TD_3", origin: null, created_at: minutes(45 * 60) },
      { id: "rel-related", type: "related", source: "td_TD_1", target: "td_TD_4", origin: null, created_at: minutes(44 * 60) },
      // T-20261014-212017-4 — the **incoming** `blocks` edge, which is what a
      // card's `depends_on` actually is (the wire's `blocked_by`; the other
      // direction, `rel-blocks` above, is a card *blocking* somebody). TD-5
      // blocks TD-1, so TD-1 waits on TD-5 and its drawer must say so. (TD-5 is
      // a real fixture card on purpose: the chips resolve an id to the
      // identifier the board knows, and an id with no card behind it would test
      // the fallback rather than the resolution.)
      { id: "rel-blocked-by", type: "blocks", source: "td_TD_5", target: "td_TD_1", origin: null, created_at: minutes(43 * 60) },
    ],
  };
  // R14 ① / the preview leg — the drawer's attachment rows, keyed by the card's
  // internal id the way the route scopes them. TD-1 is the card the interaction
  // pass opens, so it is the one with files: one row per preview family, plus a
  // row the drawer must NOT offer to open (a zip). `meta.attachment_count` on the
  // card states the same number, so the badge and the list cannot disagree.
  const attachments = {
    td_TD_1: [
      { id: "att-1", task_id: "td_TD_1", comment_id: null, filename: "board-keyboard-spec.md", content_type: "text/markdown", size: 12 * 1024, kind: "attachment", created_at: minutes(47 * 60) },
      { id: "att-2", task_id: "td_TD_1", comment_id: null, filename: "focus-order-record.png", content_type: "image/png", size: 248 * 1024, kind: "attachment", created_at: minutes(46 * 60) },
      { id: "att-3", task_id: "td_TD_1", comment_id: null, filename: "layout-drawing.pdf", content_type: "application/pdf", size: 64 * 1024, kind: "attachment", created_at: minutes(45 * 60) },
      { id: "att-4", task_id: "td_TD_1", comment_id: null, filename: "walkthrough.mp4", content_type: "video/mp4", size: 2 * 1024 * 1024, kind: "attachment", created_at: minutes(44 * 60) },
      { id: "att-5", task_id: "td_TD_1", comment_id: null, filename: "build-bundle.zip", content_type: "application/zip", size: 1024, kind: "attachment", created_at: minutes(43 * 60) },
    ],
  };
  // The bytes the content endpoint serves for those rows. The image and the PDF
  // are real (a 1×1 PNG and a one-page PDF with a correct xref) so Chromium
  // renders them rather than reporting a decode failure as a console error; the
  // video is a few bytes of opaque data — the leg asserts the `<video>` element
  // and its blob source, not playback.
  const attachmentBytes = {
    "att-1": Buffer.from("# Keyboard spec\n\n## Focus order\n\nSome **markdown**.\n", "utf8"),
    "att-2": Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0xkAAAAASUVORK5CYII=",
      "base64",
    ),
    "att-3": minimalPdf(),
    "att-4": Buffer.from("not a real video, but the drawer only reads its blob source\n", "utf8"),
  };
  // v4 — TD-1 is the card the interaction pass opens, so it carries the session
  // trail (one running, one closed) and the report family (two rounds; the
  // latest closes both criteria). The server routes are scoped by the task's
  // internal id, exactly as `agent-sessions.mjs` / `reports.mjs` list them.
  const sessions = {
    td_TD_1: [
      { id: "sess-2", task_id: "td_TD_1", seg: "3", owner: "turing", owner_kind: "pi", session_id: "sess_pi_01HQ8ZM4K2", phase: "implement", pid: 4242, status: "running", goal: "implement the session goal field", ts: minutes(4) },
      { id: "sess-1", task_id: "td_TD_1", seg: "2", owner: "linus", owner_kind: "claude", session_id: "sess_claude_01HQ18W7T4M2", phase: "review", pid: null, status: "closed", goal: "review the drawer ordering", ts: minutes(60) },
    ],
  };
  const reports = {
    td_TD_1: [
      {
        id: "rp-1",
        task_id: "td_TD_1",
        round: 1,
        seg: "1",
        session_id: "sess-1",
        conclusion: "First round shipped.",
        acceptance: [{ text: "Criterion one", status: "met" }, { text: "Criterion two", status: "partial" }],
        evidence: [],
        evidence_truncated: false,
        leftovers: "Finish the second criterion.",
        author_kind: "agent",
        author_id: "a1",
        author: { id: "a1", display_name: "linus", kind: "agent" },
        created_at: minutes(120),
      },
      {
        id: "rp-2",
        task_id: "td_TD_1",
        round: 2,
        seg: "3",
        session_id: "sess-2",
        conclusion: "Second round closed the gap.",
        acceptance: [{ text: "Criterion one", status: "met" }, { text: "Criterion two", status: "met" }],
        evidence: [],
        evidence_truncated: false,
        leftovers: null,
        author_kind: "agent",
        author_id: "a2",
        author: { id: "a2", display_name: "jobs", kind: "agent" },
        created_at: minutes(30),
      },
    ],
  };
  return {
    projects,
    orderDebug,
    tasks,
    entries,
    labels,
    comments,
    activities,
    relations,
    attachments,
    attachmentBytes,
    sessions,
    reports,
    // B19 — the access policy the fixture API serves and `PUT` mutates. The
    // token is a well-formed 64-hex credential so the panel's copy/reveal and
    // rotation paths exercise the real shapes.
    access: {
      token: `td_${"0123456789abcdef".repeat(4)}`,
      rotations: 0,
      allow_list: { enabled: false, cidrs: ["192.168.0.0/16", "10.0.0.0/8"] },
      source: "file",
    },
  };
}

/**
 * The ids on `taskId`'s parent chain, either direction — the fixture's answer to
 * the route's `parent_chain`.
 *
 * The fixture keys rows by the card that *has* them, so the walk first collects
 * every `parent` row it holds (deduped by id) and then runs the same two walks
 * `src/core/domain/relation.mjs#parentChainOf` runs over the real table: up
 * through `source → target` (source = parent), down breadth-first through the
 * children. The fixture's graph is one hop deep, which makes the walks short —
 * not different.
 *
 * T-20261015-104813 — the drawer's prerequisite picker filters its roster by
 * this set, so a fixture that answered without it would hand the drawer a shape
 * the route does not have.
 *
 * @param {string} taskId
 * @param {{[taskId: string]: object[]}} byTask
 * @returns {string[]}
 */
function parentChainOf(taskId, byTask) {
  const edges = new Map();
  for (const rows of Object.values(byTask)) {
    for (const row of rows) if (row.type === "parent") edges.set(row.id, row);
  }
  const parentEdges = [...edges.values()];
  const out = [];
  const add = (id) => {
    if (id !== taskId && !out.includes(id)) out.push(id);
  };

  const seenUp = new Set([taskId]);
  let up = taskId;
  for (;;) {
    const edge = parentEdges.find((row) => row.target === up);
    if (edge === undefined || seenUp.has(edge.source)) break;
    seenUp.add(edge.source);
    add(edge.source);
    up = edge.source;
  }

  const seenDown = new Set([taskId]);
  let frontier = [taskId];
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      for (const edge of parentEdges.filter((row) => row.source === node)) {
        if (seenDown.has(edge.target)) continue;
        seenDown.add(edge.target);
        add(edge.target);
        next.push(edge.target);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Boot the fixture API + static `web/dist` server.
 *
 * `port` defaults to 0 (an ephemeral port), and every caller today wants exactly
 * that: the smoke itself, `shot-compare.mjs` and `rail-chip-overflow.mjs` all take
 * the bound port back off the return value. The option to *name* the port used to
 * exist for one caller that had to be told where to look first; with that caller
 * gone there is no such case left, so the parameter is gone with it.
 */
export function startServer() {
  const data = fixtureApi();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const ok = (d) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, data: d }));
    };

    if (path === "/health") return ok({ status: "ok", revision: 5 });
    // The real board's root route (not `/api/v1/meta`). `initBoard` reads the
    // revision from it, so a fixture without it would 404 on every page load.
    if (path === "/meta") return ok({ version: "0.0.0-fixture", revision: 5, capabilities: { sse: true } });
    if (path === "/api/v1/events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 3000\n\n: connected\n\n");
      return; // keep the stream open
    }
    if (path === "/api/v1/projects") return ok({ projects: data.projects, order_debug: data.orderDebug });
    if (path === "/api/v1/tasks") {
      const projectId = url.searchParams.get("project_id");
      return ok({ tasks: data.tasks.filter((t) => !projectId || t.project_id === projectId) });
    }
    const commentsFor = /^\/api\/v1\/tasks\/([^/]+)\/comments$/.exec(path);
    if (commentsFor) return ok({ comments: data.comments[decodeURIComponent(commentsFor[1])] ?? [] });
    const activitiesFor = /^\/api\/v1\/tasks\/([^/]+)\/activities$/.exec(path);
    if (activitiesFor) {
      // Scoped to the card, like the real route: the Activity view reads one card
      // at a time and merges, so a fixture that answered every request with the
      // whole trail would make the ledger look right for the wrong reason.
      const ref = decodeURIComponent(activitiesFor[1]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref);
      return ok({
        task_id: task?.id ?? ref,
        activities: data.activities.filter((activity) => activity.task_id === task?.id),
      });
    }
    // The board-wide trail (`GET /api/v1/activities`): the Activity view's
    // backfill reads one newest-first page and scopes it to the board's own
    // task set. Without this route the fixture's fallback answers `{}` and the
    // ledger looks legitimately empty.
    if (path === "/api/v1/activities") {
      const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const after = Number.parseInt(url.searchParams.get("after") ?? "", 10);
      let rows = data.activities.filter(
        (activity) => !Number.isFinite(after) || activity.revision > after,
      );
      rows = [...rows].sort((a, b) =>
        order === "asc" ? a.revision - b.revision : b.revision - a.revision,
      );
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
      return ok({ activities: rows });
    }
    // R14 ① — the real route's shape (`src/server/routes/relations.mjs` →
    // `{ relations: [...] }`, each row `relationToWire`: id/type/source/target).
    // Scoped to the card asked for, like `/activities`: the drawer renders the
    // rows a card *has*, so a fixture answering every ref with the whole table
    // would let the wrong card's edges look right.
    const relationsFor = /^\/api\/v1\/tasks\/([^/]+)\/relations$/.exec(path);
    if (relationsFor) {
      const ref = decodeURIComponent(relationsFor[1]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref);
      const all = data.relations[task?.id] ?? [];
      // The real route's six keys, not just `relations`
      // (T-20261014-212017-4). The drawer's `depends_on` chips read
      // **`blocked_by`** — the edges pointing *at* this card, which is what the
      // card-schema `depends_on` means — so a fixture that answered only
      // `relations` would leave the control empty for the wrong reason. The
      // split is the route's own (`src/server/routes/relations.mjs` →
      // `commands.listRelations`).
      return ok({
        task_id: task?.id ?? ref,
        relations: all,
        children: all.filter((row) => row.type === "parent" && row.source === task?.id),
        ancestors: all.filter((row) => row.type === "parent" && row.target === task?.id),
        blocked_by: all.filter((row) => row.type === "blocks" && row.target === task?.id),
        blocks: all.filter((row) => row.type === "blocks" && row.source === task?.id),
        // T-20261015-104813 — the ids on this card's parent chain, either
        // direction. The drawer's prerequisite picker filters its roster by this
        // set, so the fixture answers it the way the route does: the transitive
        // walk over the `parent` edges this fixture already holds, not just the
        // one hop. Absent, the picker would still work (it offers everything,
        // which is what it did before this field existed) — but a fixture that
        // silently omits a field the route sends is the drift this harness is
        // here to catch.
        parent_chain: parentChainOf(task?.id ?? ref, data.relations),
      });
    }
    // The preview reads the same bytes endpoint a download does. Served outside
    // the JSON envelope, exactly like the real route (bytes in, bytes out), with
    // the row's own stored type as `content-type`.
    const contentFor = /^\/api\/v1\/attachments\/([^/]+)\/content$/.exec(path);
    if (contentFor) {
      const id = decodeURIComponent(contentFor[1]);
      const row = Object.values(data.attachments).flat().find((entry) => entry.id === id);
      const bytes = data.attachmentBytes[id];
      if (!row || !bytes) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", http: 404, message: "no stored content" } }));
        return;
      }
      res.writeHead(200, { "content-type": row.content_type, "content-length": bytes.length, "cache-control": "no-store" });
      res.end(bytes);
      return;
    }
    // T-20261014-212017-4 / G2 — the drawer's file list reads the `attachments`
    // **table** (`GET /api/v1/tasks/:ref/attachments`), never `task.meta`. The
    // fixture answers the same shape the route does, scoped to the card asked
    // for, so a card with no files is an empty list rather than a wrong one.
    const attachmentsFor = /^\/api\/v1\/tasks\/([^/]+)\/attachments$/.exec(path);
    if (attachmentsFor) {
      const ref = decodeURIComponent(attachmentsFor[1]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref);
      return ok({ task_id: task?.id ?? ref, attachments: data.attachments[task?.id] ?? [] });
    }
    // v4 — the drawer's session trail and report family. Both are scoped to the
    // card asked for; a card with none answers `[]`, which is the empty state.
    const sessionsFor = /^\/api\/v1\/tasks\/([^/]+)\/sessions$/.exec(path);
    if (sessionsFor) {
      const ref = decodeURIComponent(sessionsFor[1]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref);
      return ok({ sessions: data.sessions[task?.id] ?? [] });
    }
    const reportsFor = /^\/api\/v1\/tasks\/([^/]+)\/reports$/.exec(path);
    if (reportsFor) {
      const ref = decodeURIComponent(reportsFor[1]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref);
      return ok({ reports: data.reports[task?.id] ?? [] });
    }
    // Resolve the task the caller actually asked for (by identifier or by id)
    // rather than always the first one. Answering every ref with the first
    // fixture card made the drawer *look* right while naming the wrong task —
    // the Activity view's rows land on this surface, so the ref has to resolve
    // for "the row opened the card it names" to mean anything — and the R12
    // drawer head has to be compared against the card that was pressed
    // (`design/fidelity-r12.md` §5 C-1): "one id renders whole in the drawer and
    // clamped on the card" is a relation between the *same* task's two render
    // points, which needs both ends to resolve to it. The `/comments` and
    // `/activities` sub-paths are matched above and never reach here; a sub-path
    // that does keeps the old shape.
    // The reopen verb the terminal drawer posts. It mutates the fixture row so
    // the returned record and the board agree; the suite's zero-console-error
    // rule means it must not fall through to the `ok({})` catch-all below.
    if (req.method === "POST" && /^\/api\/v1\/tasks\/[^/]+\/reopen$/.test(path)) {
      const ref = decodeURIComponent(path.slice("/api/v1/tasks/".length).split("/")[0]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref) ?? data.tasks[0];
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        // The probe always sends a reason; parsing keeps the handler shaped
        // like the real one rather than pretending the body is absent.
        try {
          JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          // A malformed body is refused by the real route; the probe never sends one.
        }
        if (task) {
          task.status = "todo";
          task.version = (task.version ?? 1) + 1;
          task.archived_at = null;
          task.delivery_round = (task.delivery_round ?? 1) + 1;
        }
        ok({ task, status: "todo" });
      });
      return;
    }
    if (path.startsWith("/api/v1/tasks/")) {
      const ref = decodeURIComponent(path.slice("/api/v1/tasks/".length).split("/")[0]);
      const task = data.tasks.find((entry) => entry.identifier === ref || entry.id === ref) ?? data.tasks[0];
      return ok({ task, report_waivers: [] });
    }
    // One dictionary read since 0019: `assignees`/`reporters` merged into
    // `actors` (`src/core/storage/migrations/0019_actors.sql`), and the route
    // with them. The browser leg reads exactly this path in
    // `web/src/services/api.js` — answering it with the pre-merge paths would
    // fall through to the empty-envelope fallback below and render an empty
    // roster.
    if (path === "/api/v1/actors") return ok({ entries: data.entries });
    if (path === "/api/v1/labels") return ok({ labels: data.labels });
    if (path === "/api/v1/access") {
      const snapshot = () => ({
        token: data.access.token,
        token_file: "/fixture/token",
        config_file: "/fixture/.env",
        allow_list: { enabled: data.access.allow_list.enabled, cidrs: [...data.access.allow_list.cidrs] },
        source: data.access.source,
      });
      if (req.method === "GET") return ok(snapshot());
      if (req.method === "PUT") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ ok: false, error: { code: "VALIDATION_FAILED", http: 400 } }));
          }
          const list = body.allow_list ?? {};
          data.access.allow_list = {
            enabled: list.enabled === true,
            cidrs: Array.isArray(list.cidrs) ? list.cidrs.map((entry) => String(entry).trim()) : [],
          };
          let rotated = false;
          if (body.rotate_token === true) {
            data.access.rotations += 1;
            data.access.token = `td_${String(data.access.rotations).padStart(64, "0")}`;
            rotated = true;
          }
          ok({ ...snapshot(), rotated });
        });
        return;
      }
    }
    if (path.startsWith("/api/v1/")) return ok({});

    const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel === "/" ? "index.html" : rel);
    if (!existsSync(file) || statSync(file).isDirectory() || !extname(file)) file = join(DIST, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({ server, port: server.address().port, data }));
  });
}

/* ----------------------------------------------------------- playwright */

/** Resolve an already-installed Playwright, or null. Never installs anything. */
export function resolvePlaywright() {
  const roots = [process.env.PLAYWRIGHT_ROOT, join(WEB, "node_modules"), process.cwd()].filter(Boolean);
  // Glob the nvm + standard global roots so the common host layouts are covered.
  for (const base of ["/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules"]) roots.push(base);
  try {
    const nvm = join(process.env.HOME ?? "", ".nvm/versions/node");
    if (existsSync(nvm)) for (const v of readdirSync(nvm)) roots.push(join(nvm, v, "lib/node_modules"));
  } catch {
    /* best-effort */
  }
  try {
    const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    if (root.status === 0) roots.push(root.stdout.trim());
  } catch {
    /* npm absent — fine */
  }

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      const require = createRequire(join(root, "noop.js"));
      return require("playwright");
    } catch {
      /* try the next root */
    }
  }
  return null;
}

/* ------------------------------------------------------ in-page evaluator */

/**
 * The DOM-layer evaluation, run inside the page. Mirrors `RULE_KINDS` in
 * `blocks.contract.mjs`. A `domain` rule skips an element that does not carry
 * the attribute at all — the contract's own data requires it (a human card's
 * hidden agent badge, a human roster option carry no `data-agent-platform`).
 */
export function evaluateRules(rules) {
  const doc = document;
  const withinAll = (within) => (within ? Array.from(doc.querySelectorAll(within)) : [doc]);
  /**
   * Resolve a custom property to a concrete value by letting the browser do it:
   * a colour probe painted with `var(--x)` reads back as the same string the
   * comparison side computes to, so a token check never compares a hex against
   * an `rgb()` (the trick the M1 checks below use for the accent).
   */
  const resolveVar = (name) => {
    const probe = doc.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;";
    probe.style.color = `var(${name})`;
    doc.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  /**
   * Count the tracks of a computed `grid-template-columns`. Splitting on
   * whitespace is wrong: a track may be `minmax(0px, 1fr)`, which contains a
   * space of its own. Only top-level separators count.
   */
  const trackCount = (value) => {
    let depth = 0;
    let count = 0;
    let inToken = false;
    for (const char of value.trim()) {
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      if (/\s/.test(char) && depth === 0) {
        if (inToken) count += 1;
        inToken = false;
      } else inToken = true;
    }
    return inToken ? count + 1 : count;
  };
  const out = [];
  for (let index = 0; index < rules.length; index++) {
    const { block, rule } = rules[index];
    const record = { index, block, kind: rule.kind, selector: rule.selector ?? null, probe: rule.probe ?? null, within: rule.within ?? null, ok: true, detail: "" };
    try {
      switch (rule.kind) {
        case "count": {
          for (const scope of withinAll(rule.within)) {
            const n = scope.querySelectorAll(rule.selector).length;
            if (rule.equals !== undefined && n !== rule.equals) { record.ok = false; record.detail = `count ${n} != ${rule.equals}`; break; }
            if (rule.min !== undefined && n < rule.min) { record.ok = false; record.detail = `count ${n} < ${rule.min}`; break; }
            if (rule.max !== undefined && n > rule.max) { record.ok = false; record.detail = `count ${n} > ${rule.max}`; break; }
          }
          break;
        }
        case "order": {
          const values = Array.from(doc.querySelectorAll(rule.selector)).map((el) => el.getAttribute(rule.attribute));
          if (JSON.stringify(values) !== JSON.stringify(rule.equals)) { record.ok = false; record.detail = JSON.stringify(values); }
          break;
        }
        case "sequence": {
          const values = Array.from(doc.querySelectorAll(rule.selector)).map((el) => Number(el.getAttribute(rule.attribute)));
          for (let i = 0; i < values.length; i++) {
            if (values[i] !== rule.from + i * rule.step) { record.ok = false; record.detail = `index ${i} = ${values[i]}`; break; }
          }
          break;
        }
        case "monotonic": {
          const values = Array.from(doc.querySelectorAll(rule.selector)).map((el) => Number(el.getAttribute(rule.attribute)));
          for (let i = 1; i < values.length; i++) {
            const bad = rule.direction === "non-increasing" ? values[i] > values[i - 1] : values[i] < values[i - 1];
            if (bad) { record.ok = false; record.detail = values.join(","); break; }
          }
          break;
        }
        case "domain": {
          const subset = rule.subset ?? rule.equals;
          const bad = Array.from(doc.querySelectorAll(rule.selector))
            .map((el) => el.getAttribute(rule.attribute))
            .filter((value) => value !== null && !subset.includes(value));
          if (bad.length) { record.ok = false; record.detail = `out-of-domain: ${[...new Set(bad)].join(",")}`; }
          break;
        }
        case "identical-hookset": {
          outer: for (const scope of withinAll(rule.within)) {
            const nodes = Array.from(scope.querySelectorAll(rule.selector));
            if (nodes.length === 0) continue;
            const sets = nodes.map((el) =>
              Array.from(el.attributes)
                .map((a) => a.name)
                .filter((n) => n.startsWith("data-"))
                .sort()
                .join("|"),
            );
            if (sets.some((s) => s !== sets[0])) { record.ok = false; record.detail = "hook sets differ"; break outer; }
          }
          break;
        }
        case "absent": {
          for (const scope of withinAll(rule.within)) {
            if (scope.querySelector(rule.selector)) { record.ok = false; record.detail = "present"; break; }
          }
          break;
        }
        // The browser layer's three probe kinds (see `PROBE GRAMMAR` in
        // blocks.contract.mjs): a computed value, a class set and a text value,
        // each read off whatever `rule.probe` matches.
        case "computed": {
          let nodes = Array.from(doc.querySelectorAll(rule.probe));
          if (rule.visible === true) nodes = nodes.filter((el) => getComputedStyle(el).display !== "none");
          if (nodes.length === 0) { record.ok = false; record.detail = `nothing matches ${rule.probe}`; break; }
          if (rule.count !== undefined && nodes.length !== rule.count) {
            record.ok = false;
            record.detail = `count ${nodes.length} != ${rule.count}`;
            break;
          }
          if (rule.property === undefined) break;
          const expected = rule.equalsVar !== undefined ? resolveVar(rule.equalsVar)
            : rule.notEqualsVar !== undefined ? resolveVar(rule.notEqualsVar)
            : undefined;
          // The px comparators are settled in Node (`px-assert.mjs`): the page
          // reports each matched node's raw computed value and whether it has a
          // layout box. `parseFloat` in here cannot tell `"auto"` (NaN ⇒ every
          // comparison false ⇒ silent pass) from a real length, nor `"100%"` (a
          // fake `100`) — T-20261016-130046-3.
          const pxComparators = rule.equalsPx !== undefined || rule.minPx !== undefined || rule.maxPx !== undefined;
          const pxReadings = [];
          for (const node of nodes) {
            const actual = getComputedStyle(node)[rule.property];
            const fail = (why) => { record.ok = false; record.detail = `${rule.property} = ${actual} ${why}`; };
            if (pxComparators) pxReadings.push({ value: actual, hasBox: node.isConnected && node.getClientRects().length > 0 });
            if (rule.equals !== undefined && actual !== rule.equals) { fail(`!= ${rule.equals}`); break; }
            if (rule.equalsVar !== undefined && actual !== expected) { fail(`!= var(${rule.equalsVar}) = ${expected}`); break; }
            if (rule.notEquals !== undefined && actual === rule.notEquals) { fail(`== ${rule.notEquals}`); break; }
            if (rule.notEqualsVar !== undefined && actual === expected) { fail(`== var(${rule.notEqualsVar}) = ${expected}`); break; }
            if (rule.contains !== undefined && !actual.includes(rule.contains)) { fail(`does not contain ${rule.contains}`); break; }
            if (rule.startsWith !== undefined && !actual.startsWith(rule.startsWith)) { fail(`does not start with ${rule.startsWith}`); break; }
            if (rule.endsWith !== undefined && !actual.endsWith(rule.endsWith)) { fail(`does not end with ${rule.endsWith}`); break; }
            if (rule.tokens !== undefined && trackCount(actual) !== rule.tokens) { fail(`is not ${rule.tokens} tracks`); break; }
            if (rule.differsFrom !== undefined) {
              const other = doc.querySelector(rule.differsFrom);
              if (!other || getComputedStyle(other)[rule.property] === actual) { fail(`is not distinguishable from ${rule.differsFrom}`); break; }
            }
          }
          if (pxReadings.length > 0) record.px = pxReadings;
          break;
        }
        case "classes": {
          const nodes = Array.from(doc.querySelectorAll(rule.probe));
          if (nodes.length === 0) { record.ok = false; record.detail = `nothing matches ${rule.probe}`; break; }
          const missing = new Set();
          for (const node of nodes) for (const name of rule.includes) if (!node.classList.contains(name)) missing.add(name);
          if (missing.size > 0) { record.ok = false; record.detail = `class list is missing ${[...missing].join(", ")}`; }
          break;
        }
        case "text": {
          const nodes = Array.from(doc.querySelectorAll(rule.probe));
          if (nodes.length === 0) { record.ok = false; record.detail = `nothing matches ${rule.probe}`; break; }
          for (const node of nodes) {
            const value = (node.textContent ?? "").trim();
            if (rule.equals !== undefined && value !== rule.equals) { record.ok = false; record.detail = `${JSON.stringify(value)} != ${JSON.stringify(rule.equals)}`; break; }
            if (rule.oneOf !== undefined && !rule.oneOf.includes(value)) { record.ok = false; record.detail = `${JSON.stringify(value)} is not one of ${rule.oneOf.join(" | ")}`; break; }
            if (rule.matches !== undefined && !new RegExp(rule.matches).test(value)) { record.ok = false; record.detail = `${JSON.stringify(value)} does not match /${rule.matches}/`; break; }
          }
          break;
        }
        default:
          record.detail = "not a dom rule";
      }
    } catch (err) {
      record.ok = false;
      record.detail = String(err);
    }
    out.push(record);
  }
  return out;
}

/* ------------------------------------------------------------------- main */

export async function run() {
  if (!existsSync(join(DIST, "index.html"))) throw Object.assign(new Error("web/dist is not built — run `npm -w web run build`"), { code: "SKIP" });
  const playwright = resolvePlaywright();
  if (!playwright) throw Object.assign(new Error("Playwright is not installed on this host"), { code: "SKIP" });

  const { server, port, data } = await startServer();
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    server.close();
    throw Object.assign(new Error(`could not launch Chromium: ${err.message}`), { code: "SKIP" });
  }

  try {
    // B19's Copy writes the real persisted token: grant the clipboard to the
    // harness so the assertion reads what the reader would paste.
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();

    /**
     * Run the in-page evaluator, then settle every px comparator in Node. The
     * page cannot judge them safely — see `web/scripts/px-assert.mjs` — so it
     * reports `record.px` readings and this folds them back into the records.
     */
    const evaluateRuleSet = async (rules) => applyPxVerdicts(await page.evaluate(evaluateRules, rules), rules);

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    /**
     * R9 ③ — the harness, not the app, is what lingers on a list read.
     *
     * The two list states are exclusive at every instant, which is only
     * observable *while* the read is in flight. The fixture API answers in a
     * couple of milliseconds, so the harness holds the request open with its own
     * route handler and samples inside the window. Nothing in `web/src` is slowed
     * down for the check, and the contract fixes the two states, never their
     * duration (`design/fidelity-r9.md` §5 C′5).
     */
    let tasksDelayMs = 0;
    await page.route("**/api/v1/tasks*", async (route) => {
      if (tasksDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, tasksDelayMs));
      await route.continue();
    });
    // The skeleton legs need the *other* two reads held open as well. Playwright's
    // `*` does not cross a `/`, so the task-list pattern above matches neither
    // the board-wide activity read nor the card read (only the list request, whose
    // `?project_id=` follows the path directly). The ledger backfills through
    // `GET /activities`; the drawer still reads per-card `/tasks/:ref/activities`.
    // Three knobs, four patterns.
    let activitiesDelayMs = 0;
    const holdActivities = async (route) => {
      if (activitiesDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, activitiesDelayMs));
      await route.continue();
    };
    await page.route("**/api/v1/activities*", holdActivities);
    await page.route("**/api/v1/tasks/*/activities*", holdActivities);
    let detailDelayMs = 0;
    await page.route("**/api/v1/tasks/*", async (route) => {
      if (detailDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, detailDelayMs));
      await route.continue();
    });

    /**
     * Enter the list view and wait for its read to land. Every `when: "list
     * view"` rule is about the `data` state — a sampling that landed inside the
     * `loading` window would read "nothing matches" for the row rules, which
     * says nothing about the app (R9 ③).
     */
    const waitForListSettled = () =>
      page.waitForFunction(
        () => document.querySelector("[data-list]")?.getAttribute("data-list-state") === "data",
        null,
        { timeout: 10_000 },
      );

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-column]", { timeout: 8000 });
    await page.waitForTimeout(600);

    const boardRules = EVALUATED_RULES.filter((e) => !e.rule.when || e.rule.when === "board view").map((e) => ({ block: e.block, rule: e.rule }));
    const listRules = EVALUATED_RULES.filter((e) => e.rule.when === "list view").map((e) => ({ block: e.block, rule: e.rule }));
    const railRules = EVALUATED_RULES.filter((e) => e.rule.when === "rail").map((e) => ({ block: e.block, rule: e.rule }));
    const panelRules = EVALUATED_RULES.filter((e) => e.rule.when === "panel open").map((e) => ({ block: e.block, rule: e.rule }));
    // The `loading` half of R9 ③ — evaluated in its own section below, with the
    // read held open.
    const listLoadingRules = EVALUATED_RULES.filter((e) => e.rule.when === "list loading").map((e) => ({ block: e.block, rule: e.rule }));
    // R12x · B26 — the feed's rules are evaluated with the view **open**, in that
    // section below: at rest the ledger has not been read yet, so a row count
    // taken here would measure an empty feed rather than the contract.
    const activityRules = EVALUATED_RULES.filter((e) => e.rule.when === "activity view").map((e) => ({ block: e.block, rule: e.rule }));
    // R12x · B27 — the queue's rules are read with *that* view open, in the M1
    // section below (the two views are mutually exclusive, so it cannot be both).
    const waitingRules = EVALUATED_RULES.filter((e) => e.rule.when === "waiting view").map((e) => ({ block: e.block, rule: e.rule }));

    const boardResults = await evaluateRuleSet(boardRules);
    await page.click('[data-view="list"]');
    await waitForListSettled();
    await page.waitForTimeout(120);
    const listResults = await evaluateRuleSet(listRules);
    // The list's own geometry that a per-element rule cannot state: one dot per
    // status chip, and a rule *between* rows (the first draws no top edge).
    const listDetail = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-list-rows] [data-list-row]")];
      const topBorders = rows.map((row) => parseFloat(getComputedStyle(row).borderTopWidth));
      return {
        rows: rows.length,
        dotsPerChip: [...document.querySelectorAll("[data-list-status]")].map((cell) => cell.querySelectorAll(".td-status-dot").length),
        firstTopBorder: topBorders.at(0) ?? null,
        laterTopBorder: topBorders.at(1) ?? null,
      };
    });

    const geometry = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        columns: document.querySelectorAll("[data-column]").length,
        cards: document.querySelectorAll("[data-card]").length,
        noHorizontalOverflow: de.scrollWidth <= de.clientWidth + 1,
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
      };
    });

    // --- interaction smoke: drawer, theme cycle, language switch ---------------
    await page.click('[data-view="board"]');
    await page.waitForTimeout(120);
    await page.click("[data-card]");
    await page.waitForTimeout(250);
    const drawerOpen = await page.evaluate(() => {
      const drawer = document.querySelector("[data-detail-drawer]");
      const title = document.querySelector("[data-detail-title]")?.textContent?.trim() ?? "";
      const session = document.querySelector("[data-detail-agent-session]");
      // R7 ④ — the close button's *relations*: same flex row as the identifier,
      // level with it on the centre line, flush with that row's inline end and
      // above the title. `getComputedStyle().marginInlineStart` cannot be
      // asserted as `auto` (the browser resolves it to the used px value,
      // R7-2), so the "pushed right" half is measured as geometry.
      const close = document.querySelector("[data-detail-close]");
      const identifier = document.querySelector("[data-detail-identifier]");
      const titleEl = document.querySelector("[data-detail-title]");
      const row = close?.parentElement ?? null;
      const closeRect = close?.getBoundingClientRect() ?? null;
      const identRect = identifier?.getBoundingClientRect() ?? null;
      const rowRect = row?.getBoundingClientRect() ?? null;
      const centreY = (rect) => (rect.top + rect.bottom) / 2;
      const glyph = close?.querySelector("svg.td-icon") ?? null;
      return {
        // R14 §2.1 / §8 U4 — `data-state` is the drawer's *only* state source.
        // The probe used to also report `hasAttribute("hidden")`; that attribute
        // is gone from the `aside` (the closed face is `translateX(100%)` +
        // `visibility: hidden`, the prototype's own pair), so the reading could
        // only ever have been `false` and distinguished nothing. The scrim keeps
        // its `hidden`, and the closed/open relation is read off `data-state`
        // here and off the scrim's own attribute where that half is asserted.
        state: drawer?.getAttribute("data-state") ?? null,
        title,
        agentSessionHook: session !== null,
        r7: {
          sameParent: close !== null && identifier !== null && close.parentElement === identifier.parentElement,
          rowDirection: row ? getComputedStyle(row).flexDirection : null,
          rowDisplay: row ? getComputedStyle(row).display : null,
          centerDelta: closeRect && identRect ? Math.abs(centreY(closeRect) - centreY(identRect)) : null,
          rightDelta: closeRect && rowRect ? Math.abs(rowRect.right - closeRect.right) : null,
          closeTop: closeRect?.top ?? null,
          titleTop: titleEl?.getBoundingClientRect().top ?? null,
          path: glyph?.querySelector("path")?.getAttribute("d") ?? null,
          glyphWidth: glyph ? glyph.getBoundingClientRect().width : null,
        },
      };
    });

    /* ---- v4 — the drawer's six tabs and the session trail -----------------
       Measured on the open drawer (TD-1), then returned to Details so every
       rule below sees the face it was written against. The fixture's TD-1 is an
       agent card with two sessions and two reports, so the Sessions tab is
       visible and its trail has real rows. */
    const drawerTabsFailures = [];
    const drawerTabsCheck = (ok, message) => { if (!ok) drawerTabsFailures.push(message); };

    /* The drawer's compact buttons are the prototype's 22px `.btn-xs` and the
       32px `.td-iconbtn` — daisyUI's own `.btn-xs` is 24px, and the 2px gap was
       the reported misalignment on the Description Save/Cancel pair and the
       Attachments Upload button. Measured in the open drawer, before the tab
       probes move focus. */
    const compactButtons = await page.evaluate(() => {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          height: c.height,
          minHeight: c.minHeight,
          font: c.fontSize,
          weight: c.fontWeight,
          bg: c.backgroundColor,
          borderColor: c.borderTopColor,
        };
      };
      const readGlyph = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        upload: read("[data-attachment-upload]"),
        edit: read("[data-detail-description-edit]"),
        editGlyph: readGlyph("[data-detail-description-edit] svg"),
      };
    });
    drawerTabsCheck(
      compactButtons.upload?.height === "22px" && compactButtons.upload?.minHeight === "22px" &&
        compactButtons.upload?.font === "11px" && compactButtons.upload?.weight === "500" &&
        compactButtons.upload?.bg === "rgb(255, 255, 255)" &&
        compactButtons.upload?.borderColor === "rgb(207, 213, 217)",
      `Upload is ${compactButtons.upload?.height}/${compactButtons.upload?.minHeight} at ${compactButtons.upload?.font}/${compactButtons.upload?.weight}, ` +
        `bg ${compactButtons.upload?.bg}, border ${compactButtons.upload?.borderColor}; expected the design's 22px surface outline`,
    );
    drawerTabsCheck(
      compactButtons.edit?.w === 32 && compactButtons.edit?.h === 32,
      `the Description edit control is ${compactButtons.edit?.w}×${compactButtons.edit?.h}, expected 32×32`,
    );
    /* The prototype's `.td-icon` is 16×16 (`design/prototype/src/input.css`);
       without a size utility the SVG takes its 300px intrinsic width and flex-
       shrinks to ~30px inside the 32px box, which is what read as "too big". */
    drawerTabsCheck(
      compactButtons.editGlyph?.w === 16 && compactButtons.editGlyph?.h === 16,
      `the Description edit glyph is ${compactButtons.editGlyph?.w}×${compactButtons.editGlyph?.h}, expected 16×16`,
    );
    await page.click("[data-detail-description-edit]");
    await page.waitForTimeout(200);
    const descActions = await page.evaluate(() => {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        return {
          h: Math.round(r.height),
          height: c.height,
          minHeight: c.minHeight,
          font: c.fontSize,
          weight: c.fontWeight,
          bg: c.backgroundColor,
          borderColor: c.borderTopColor,
        };
      };
      return { row: read(".td-desc-actions"), save: read("[data-detail-description-save]"), cancel: read("[data-detail-description-cancel]") };
    });
    drawerTabsCheck(
      descActions.save?.height === "22px" && descActions.cancel?.height === "22px" &&
        descActions.save?.font === "11px" && descActions.row?.h === 39,
      `Save/Cancel are ${descActions.save?.height}/${descActions.cancel?.height} in a ${descActions.row?.h}px row, expected 22px each in 39px`,
    );
    drawerTabsCheck(
      descActions.save?.weight === "500" && descActions.save?.bg === "rgb(245, 246, 247)",
      `Save is ${descActions.save?.weight}/${descActions.save?.bg}, expected the design's 500-weight base button`,
    );
    drawerTabsCheck(
      descActions.cancel?.weight === "500" && descActions.cancel?.bg === "rgb(255, 255, 255)" &&
        descActions.cancel?.borderColor === "rgb(207, 213, 217)",
      `Cancel is ${descActions.cancel?.weight}/${descActions.cancel?.bg}/${descActions.cancel?.borderColor}, expected the design's surface outline`,
    );
    await page.click("[data-detail-description-cancel]");
    await page.waitForTimeout(150);

    const tabsRead = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll("[data-detail-tab]")];
      const sessionsTab = document.querySelector('[data-detail-tab="sessions"]');
      const sessionsPanel = document.querySelector('[data-detail-panel="sessions"]');
      const detailsPanel = document.querySelector('[data-detail-panel="details"]');
      return {
        count: tabs.length,
        order: tabs.map((t) => t.getAttribute("data-detail-tab")),
        selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.getAttribute("data-detail-tab")),
        sessionsShown: sessionsTab ? !sessionsTab.hidden && getComputedStyle(sessionsTab).display !== "none" : false,
        sessionsInDetails: !!detailsPanel?.querySelector("[data-detail-agent-session]"),
        sessionsInSessions: !!sessionsPanel?.querySelector("[data-detail-agent-session]"),
      };
    });
    drawerTabsCheck(tabsRead.count === 6, `six tabs expected, read ${tabsRead.count}`);
    drawerTabsCheck(
      tabsRead.order.join(",") === "details,activity,reports,acceptance,leftovers,sessions",
      `tab order is ${tabsRead.order.join("/")}`,
    );
    drawerTabsCheck(tabsRead.selected.join(",") === "details", `the drawer opens on ${tabsRead.selected.join("/")}, expected details`);
    drawerTabsCheck(tabsRead.sessionsShown, "the Sessions tab is hidden on a card that carries sessions");
    drawerTabsCheck(
      !tabsRead.sessionsInDetails && tabsRead.sessionsInSessions,
      `the session section is in Details=${tabsRead.sessionsInDetails} and Sessions=${tabsRead.sessionsInSessions}`,
    );

    await page.click('[data-detail-tab="sessions"]');
    await page.waitForTimeout(120);
    const trailRead = await page.evaluate(() => ({
      selected: [...document.querySelectorAll("[data-detail-tab]")].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.getAttribute("data-detail-tab")),
      visiblePanels: [...document.querySelectorAll("[data-detail-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-detail-panel")),
      ids: [...document.querySelectorAll("[data-detail-agent-session-body] [data-agent-session-id]")].map((e) => e.textContent.trim()),
      statuses: [...document.querySelectorAll("[data-detail-agent-session-body] [data-session-status]")].map((e) => e.getAttribute("data-session-status")),
      goals: [...document.querySelectorAll("[data-detail-agent-session-body] [data-session-goal]")].map((e) => e.textContent.trim()),
      resumes: document.querySelectorAll("[data-detail-agent-session-body] [data-agent-resume]").length,
    }));
    drawerTabsCheck(
      trailRead.selected.join(",") === "sessions" && trailRead.visiblePanels.join(",") === "sessions",
      `opening Sessions selected ${trailRead.selected.join("/")} and showed ${trailRead.visiblePanels.join("/")}`,
    );
    drawerTabsCheck(
      trailRead.ids.length === 2 && trailRead.statuses.join(",") === "running,closed",
      `trail rows ${trailRead.ids.length} / ${trailRead.statuses.join("/")}`,
    );
    drawerTabsCheck(trailRead.resumes === 1, `Resume count is ${trailRead.resumes}, expected 1 (running only)`);
    drawerTabsCheck(
      trailRead.goals.join("|") === "implement the session goal field|review the drawer ordering",
      `session goals read ${JSON.stringify(trailRead.goals)}`,
    );

    await page.click('[data-detail-tab="reports"]');
    await page.waitForTimeout(120);
    const reportsRead = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-detail-panel="reports"] [data-dv-round]').length,
      text: document.querySelector('[data-detail-panel="reports"]')?.textContent ?? "",
    }));
    drawerTabsCheck(reportsRead.rows === 2, `Reports rows ${reportsRead.rows}, expected 2`);
    drawerTabsCheck(reportsRead.text.includes("Second round closed the gap."), "the latest report's conclusion is missing from Reports");

    await page.click('[data-detail-tab="acceptance"]');
    await page.waitForTimeout(120);
    const acceptanceRead = await page.evaluate(() => ({
      items: document.querySelectorAll('[data-detail-panel="acceptance"] .td-dv-item').length,
      statuses: [...document.querySelectorAll('[data-detail-panel="acceptance"] [data-acceptance-status]')].map((e) => e.getAttribute("data-acceptance-status")),
    }));
    drawerTabsCheck(
      acceptanceRead.items === 2 && acceptanceRead.statuses.join(",") === "met,met",
      `Acceptance read ${acceptanceRead.items} item(s) / ${acceptanceRead.statuses.join("/")}`,
    );

    await page.click('[data-detail-tab="leftovers"]');
    await page.waitForTimeout(120);
    const leftoversRead = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-detail-panel="leftovers"] .td-dv-item').length,
      empty: document.querySelectorAll('[data-detail-panel="leftovers"] [data-dv-leftover-empty="true"]').length,
    }));
    drawerTabsCheck(
      leftoversRead.rows === 2 && leftoversRead.empty === 1,
      `Leftovers read ${leftoversRead.rows} row(s), ${leftoversRead.empty} empty round(s)`,
    );

    /* Data-driven visibility, the other half: a card with no session rows has
       five tabs, no Sessions tab, a hidden section, and the empty report
       family. PROJ-0007 is such a card in the fixture; return to TD-1 after. */
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("[data-card]")].find(
        (el) => (el.querySelector("[data-card-identifier]")?.textContent ?? "").trim() === "PROJ-0007",
      );
      card?.click();
    });
    await page.waitForTimeout(300);
    const noSessionsRead = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll("[data-detail-tab]")];
      const sessionsTab = document.querySelector('[data-detail-tab="sessions"]');
      return {
        visibleTabs: tabs
          .filter((tab) => !tab.hidden && getComputedStyle(tab).display !== "none")
          .map((tab) => tab.getAttribute("data-detail-tab")),
        sessionsHidden: sessionsTab
          ? sessionsTab.hidden || getComputedStyle(sessionsTab).display === "none"
          : true,
        sectionHidden: document.querySelector("[data-detail-agent-session]")?.hidden ?? null,
        selected: tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").map((tab) => tab.getAttribute("data-detail-tab")),
        reports: document.querySelector('[data-detail-panel="reports"]')?.textContent ?? "",
      };
    });
    drawerTabsCheck(
      noSessionsRead.visibleTabs.length === 5 && !noSessionsRead.visibleTabs.includes("sessions"),
      `a card with no sessions shows ${noSessionsRead.visibleTabs.join("/")}`,
    );
    drawerTabsCheck(
      noSessionsRead.sessionsHidden === true && noSessionsRead.sectionHidden === true,
      `a card with no sessions: tab hidden=${noSessionsRead.sessionsHidden}, section hidden=${noSessionsRead.sectionHidden}`,
    );
    drawerTabsCheck(
      noSessionsRead.selected.join(",") === "details",
      `opening a card with no sessions selected ${noSessionsRead.selected.join("/")}`,
    );
    drawerTabsCheck(
      noSessionsRead.reports.includes("No reports yet."),
      "a card with no reports does not say so in the Reports panel",
    );

    await page.evaluate(() => {
      const card = [...document.querySelectorAll("[data-card]")].find(
        (el) => (el.querySelector("[data-card-identifier]")?.textContent ?? "").trim() === "TD-1",
      );
      card?.click();
    });
    await page.waitForTimeout(300);

    /* The drawer's two chronological lists read **newest-first** whichever
       order the read answered. The fixture serves the comments and the activity
       trail in ascending order (its `/comments` route ignores `order`), so an
       unsorted drawer would put the oldest line on top — the reported defect.
       The absolute stamp in each row's `title` is `YYYY-MM-DD HH:mm`, so a
       lexicographic comparison is a chronological one. */
    await page.click('[data-detail-tab="activity"]');
    await page.waitForTimeout(150);
    const chronoRead = await page.evaluate(() => {
      const stamps = (selector) =>
        [...document.querySelectorAll(selector)].map((el) => el.getAttribute("title") ?? "").filter(Boolean);
      const descending = (values) => values.every((value, index) => index === 0 || values[index - 1] >= value);
      const comments = stamps("[data-detail-comments] .td-comment .td-comment-meta [title]");
      const activities = stamps("[data-detail-activity] [data-activity-row] [data-activity-ts]");
      return { comments, activities, commentsDesc: descending(comments), activitiesDesc: descending(activities) };
    });
    drawerTabsCheck(chronoRead.comments.length === 2, `drawer comments ${chronoRead.comments.length}, expected 2`);
    drawerTabsCheck(chronoRead.commentsDesc, `drawer comments are not newest-first: ${chronoRead.comments.join(" | ")}`);
    drawerTabsCheck(chronoRead.activities.length === 4, `drawer activity rows ${chronoRead.activities.length}, expected 4`);
    drawerTabsCheck(chronoRead.activitiesDesc, `drawer activity rows are not newest-first: ${chronoRead.activities.join(" | ")}`);

    await page.click('[data-detail-tab="details"]');
    await page.waitForTimeout(120);
    /* These tab interactions are a browser focus model of their own: clicking a
       tab moves focus to that tab. The R14 check below reads the drawer's
       OPENING hand-off, which this block necessarily displaced, so hand the
       focus back to the panel before it runs. */
    await page.evaluate(() => document.querySelector("[data-detail-drawer]")?.focus());
    await page.waitForTimeout(60);

    // The contract rules whose precondition is the *open drawer* — its attachment
    // and activity rows are projected from the task on screen, so they exist here
    // and nowhere else. Evaluated between the open and the Escape.
    const drawerRules = EVALUATED_RULES.filter((entry) => entry.rule.when === "drawer open").map((entry) => ({
      block: entry.block,
      rule: entry.rule,
    }));
    const drawerResults = await evaluateRuleSet(drawerRules);

    /* ---- R14 ①② — the drawer's focus hand-off and its category words --------
       Both leftovers live on the drawer that is open right here (TD-1), so both
       are measured on the same screen, between the open and the Escape.

       ② C2 — the keyboard enters the panel the moment it is up, but the product
       override puts the default seat on the drawer root (`tabindex="-1"`), NOT
       on `[data-detail-close]` — the prototype's
       `focusWhenOpen($("[data-detail-close]"), $panel)` would put it on the ✕.
       `document.activeElement` is the only reader of that: a static probe reads
       a document, it cannot open a drawer, so the contract's declarable half
       stops at the hook and the *move* is measured here.

       ① (the R14 leftover of the same number) — the relation row's category word
       is the catalogue's, not the wire's enum. The fixture's TD-1 carries one
       edge of each of the three kinds, so all three keys are consumed on one
       screen — including `relations.related`, whose capital R is what tells a
       real catalogue hit apart from the unknown-kind fallback (that one prints
       the bare lowercase enum word). */
    const r14Failures = [];
    const r14Check = (ok, message) => { if (!ok) r14Failures.push(message); };

    const r14Focus = await page.evaluate(() => {
      const drawer = document.querySelector("[data-detail-drawer]");
      const close = document.querySelector("[data-detail-close]");
      const active = document.activeElement;
      const name = (el) =>
        el === null
          ? "null"
          : el === document.body
            ? "body"
            : `<${el.tagName.toLowerCase()}${el.hasAttribute("data-detail-close") ? " data-detail-close" : ""}${el.hasAttribute("data-detail-drawer") ? " data-detail-drawer" : ""}>`;
      return {
        state: drawer?.getAttribute("data-state") ?? null,
        hidden: drawer?.hasAttribute("hidden") ?? true,
        isClose: close !== null && active === close,
        isDrawer: drawer !== null && active === drawer,
        active: name(active),
      };
    });
    // A focus probe measured against a closed (or still-`hidden`) panel would be
    // vacuously true, so the precondition is asserted too rather than assumed.
    r14Check(
      r14Focus.state === "open" && !r14Focus.hidden,
      `the focus probe needs the drawer open: data-state=${JSON.stringify(r14Focus.state)}${r14Focus.hidden ? ", still hidden" : ""}`,
    );
    r14Check(
      !r14Focus.isClose && r14Focus.isDrawer,
      `document.activeElement after the drawer opened is ${r14Focus.active}, expected the drawer panel (never [data-detail-close])`,
    );

    /* ---- ① I-1 (T-20261014-154730) — the close button's box ---------------
       Read as **computed long-hand**, not as a hook count and not as a rect
       alone. Both of those passed on the 16×16 button: the hook was present, in
       the right row, and the glyph was the right glyph — which is exactly why
       R14-B08's selector-level verdict read "匹配·无需改" while the box was half
       the size the design states. A rect cannot tell a 32×32 content-box from a
       30×30 box with 1px borders, and neither `border-radius` nor the ink colour
       has a rect at all, so the pair is read together and asserted together.

       The head's own height rides here because a taller button is the only thing
       that moves it: `T-20261014-150729` measured prototype 32×32 ·
       head 78.59 against implementation 16×16 · head 67, and the probe next door
       (`T-20261014-154730/probe-close-focus.mjs`) re-measures both
       sides' head down to its two children. */
    const r14Close = await page.evaluate(() => {
      const close = document.querySelector("[data-detail-close]");
      const head =
        document.querySelector("[data-detail-drawer] .td-drawer-head") ?? document.querySelector(".td-drawer-head");
      if (!close) return { present: false };
      const cs = getComputedStyle(close);
      const r = close.getBoundingClientRect();
      const glyph = close.querySelector("svg.td-icon");
      const gr = glyph?.getBoundingClientRect() ?? null;
      return {
        present: true,
        width: cs.width,
        height: cs.height,
        rectWidth: r.width,
        rectHeight: r.height,
        display: cs.display,
        alignItems: cs.alignItems,
        justifyContent: cs.justifyContent,
        borderTopWidth: cs.borderTopWidth,
        borderTopStyle: cs.borderTopStyle,
        borderTopColor: cs.borderTopColor,
        borderRadius: cs.borderRadius,
        color: cs.color,
        glyphWidth: gr?.width ?? null,
        glyphHeight: gr?.height ?? null,
        headHeight: head?.getBoundingClientRect().height ?? null,
      };
    });
    r14Check(r14Close.present, "the drawer has no [data-detail-close] to measure");
    r14Check(
      r14Close.width === "32px" && r14Close.height === "32px",
      `[data-detail-close] computes ${r14Close.width}×${r14Close.height}, expected 32px×32px — the design's .td-iconbtn box (R14 §3)`,
    );
    r14Check(
      r14Close.rectWidth === 32 && r14Close.rectHeight === 32,
      `[data-detail-close] measures ${r14Close.rectWidth}×${r14Close.rectHeight}, expected 32×32 — the computed pair and the rect must agree`,
    );
    r14Check(
      r14Close.display === "flex" && r14Close.alignItems === "center" && r14Close.justifyContent === "center",
      `[data-detail-close] is ${r14Close.display}/${r14Close.alignItems}/${r14Close.justifyContent}, expected flex/center/center (.td-iconbtn centres its glyph)`,
    );
    r14Check(
      r14Close.borderTopWidth === "1px" &&
        r14Close.borderTopStyle === "solid" &&
        r14Close.borderTopColor === "rgba(0, 0, 0, 0)",
      `[data-detail-close]'s edge is ${r14Close.borderTopWidth} ${r14Close.borderTopStyle} ${r14Close.borderTopColor}, expected a transparent 1px solid (.td-iconbtn)`,
    );
    r14Check(
      r14Close.borderRadius === "6px",
      `[data-detail-close]'s radius is ${r14Close.borderRadius}, expected 6px (--radius-field, the design's --r-md)`,
    );
    r14Check(
      r14Close.glyphWidth === 16 && r14Close.glyphHeight === 16,
      `the close glyph is ${r14Close.glyphWidth}×${r14Close.glyphHeight}, expected 16×16 — the box grew, the glyph did not`,
    );
    r14Check(
      r14Close.headHeight !== null && Math.abs(r14Close.headHeight - 78.59) <= 1,
      `the drawer head is ${r14Close.headHeight}px tall, expected the prototype's 78.59px ±1`,
    );

    // The three rows in render order, word · identifier — the words are the
    // catalogue's (`relations.parent|blocks|related`), the identifiers the
    // resolved refs (PROJ-0007 for the parent edge, which is the fixture's own
    // id derivation, not a typo).
    //
    // The reader walks the row's **groups**, not the bare links (R14 D37 /
    // BLOCKS.md §R14: `[data-detail-relations]` groups its `[data-relation-link]`s
    // by kind, each group led by that kind's own name — the structure 154930-2
    // shipped). One `.td-rel-item` therefore reads `word · ref…`, which keeps
    // the expected values below the words the catalogue names: the capital `R`
    // of `Related` still tells a real catalogue hit from the unknown-kind
    // fallback (that one prints the bare lowercase enum word).
    // T-20261014-212017-3 §4.4 — `Blocks` is no longer one of these rows. The
    // card's `depends_on` is an editable chip control of its own (the `blocks`
    // edge), and the read-only row was withdrawn so the same fact
    // has one source. `parent` and `related` stay read-only, which is what this
    // reader still walks.
    const R14_RELATION_ROWS = ["Parent · PROJ-0007", "Related · TD-4"];
    const r14Relations = await page.evaluate(() =>
      [...document.querySelectorAll("[data-detail-relations] .td-rel-item")].map((item) => {
        const word = item.querySelector("span[data-i18n]")?.textContent.trim() ?? "";
        const refs = [...item.querySelectorAll("[data-relation-link]")].map((button) => button.textContent.trim());
        return [word, ...refs].join(" · ");
      }),
    );
    r14Check(
      r14Relations.join("|") === R14_RELATION_ROWS.join("|"),
      `the drawer's relation rows read ${JSON.stringify(r14Relations)}, expected ${JSON.stringify(R14_RELATION_ROWS)}`,
    );

    // …and the withdrawn row reappears as the card's `depends_on` chips: one
    // chip per `blocks` edge pointing *at* this card, carrying the prerequisite's
    // identifier. A chip is the same fact the row used to state, now editable.
    const r14DependsChips = await page.evaluate(() =>
      [...document.querySelectorAll("[data-detail-depends-chips] [data-detail-depends-chip]")].map((chip) =>
        (chip.getAttribute("data-detail-depends-value") ?? "").trim(),
      ),
    );
    r14Check(
      r14DependsChips.join("|") === "TD-5",
      `the drawer's depends_on chips read ${JSON.stringify(r14DependsChips)}, expected ["TD-5"] (the one blocks edge pointing *into* this card)`,
    );

    /* ---- ② I-2 (T-20261014-154730) — the focus ring ----------------------
       The design states the ring **globally**, in its own base layer
       (`design/prototype/tw.css`, `@layer base`): the accent at 2px with a 2px
       offset, plus the 35%-accent halo. The implementation carried no rule at
       all, so the UA's own blue `1px auto` ring showed through — the visual leg
       measured prototype `2px solid rgb(15, 122, 115)` · halo set against
       implementation `1px auto rgb(0, 95, 204)` · halo none.

       **Modality is established on purpose.** The drawer above was opened by a
       real *pointer* click, and after a pointer interaction Chromium rightly
       stops matching `:focus-visible` on a script-focused button — the ring the
       design draws is the keyboard one. So a `Tab` is pressed and the button is
       focused again, and `matches(":focus-visible")` is asserted as the
       precondition: without it a run could read the UA's ring off a
       non-matching face and report it as the design's. */
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const r14Ring = await page.evaluate(() => {
      const close = document.querySelector("[data-detail-close]");
      close.focus();
      const fv = close.matches(":focus-visible");
      const cs = getComputedStyle(close);
      return {
        focusVisible: fv,
        width: fv ? cs.outlineWidth : null,
        style: fv ? cs.outlineStyle : null,
        color: fv ? cs.outlineColor : null,
        offset: fv ? cs.outlineOffset : null,
        boxShadow: fv ? cs.boxShadow : null,
      };
    });
    r14Check(
      r14Ring.focusVisible === true,
      "the focus probe needs [data-detail-close] on its :focus-visible face — the ring the design draws is the keyboard one",
    );
    r14Check(
      r14Ring.width === "2px" && r14Ring.style === "solid" && r14Ring.color === "rgb(15, 122, 115)",
      `[data-detail-close]'s focus outline is ${r14Ring.width} ${r14Ring.style} ${r14Ring.color}, expected 2px solid rgb(15, 122, 115) — the design's accent, not the UA's ring`,
    );
    r14Check(r14Ring.offset === "2px", `[data-detail-close]'s outline offset is ${r14Ring.offset}, expected 2px`);
    r14Check(
      r14Ring.boxShadow === "rgba(15, 122, 115, 0.35) 0px 0px 0px 4px",
      `[data-detail-close]'s focus halo is ${r14Ring.boxShadow}, expected rgba(15, 122, 115, 0.35) 0px 0px 0px 4px (--brand-focus-ring at 4px)`,
    );

    /* ---- the attachment preview -------------------------------------------
       A row whose stored type the drawer can render opens its bytes in a
       **full-screen dialog** (implementation-only; the prototype has no preview
       arithmetic, so this interaction is measured rather than declared in the
       contract — the contract's rule kinds read a document, they cannot press a
       button).

       One row per family is opened in turn. The assertions that matter: the
       overlay covers the viewport and is teleported out of the drawer (whose
       transform would otherwise become its containing block), the source is a
       *blob* URL (the content route keeps saying `attachment`, so it must never
       be a direct navigation), focus lands on the close button, ✕ closes the
       dialog without closing the drawer and hands focus back to the row, and
       Escape does the same. The zip row is the negative: a type the drawer
       cannot render must not offer to open. */
    const previewFailures = [];
    const previewCheck = (ok, message) => { if (!ok) previewFailures.push(message); };
    const readPreview = () =>
      page.evaluate(() => {
        const overlay = document.querySelector("[data-attachment-preview]");
        const rect = overlay?.getBoundingClientRect() ?? null;
        return {
          viewport: { width: innerWidth, height: innerHeight },
          rows: [...document.querySelectorAll("[data-attachment-row]")].map((row) => ({
            name: row.querySelector("[data-attachment-name]")?.textContent?.trim() ?? "",
            nameTag: row.querySelector("[data-attachment-name]")?.tagName?.toLowerCase() ?? null,
            open: row.querySelector("[data-attachment-open]") !== null,
            popup: row.querySelector("[data-attachment-open]")?.getAttribute("aria-haspopup") ?? null,
            // The action cluster's order, read from the DOM rather than assumed:
            // the eye is the **view** affordance and sits before download.
            actions: [...row.querySelectorAll("[data-attachment-open], [data-attachment-download], [data-attachment-remove]")]
              .filter((element) => element.closest(".td-file-actions") !== null)
              .map((element) =>
                element.hasAttribute("data-attachment-open")
                  ? "open"
                  : element.hasAttribute("data-attachment-download")
                    ? "download"
                    : "remove",
              ),
          })),
          overlays: overlay
            ? [
                {
                  kind: overlay.getAttribute("data-attachment-preview-kind"),
                  role: overlay.getAttribute("role"),
                  modal: overlay.getAttribute("aria-modal"),
                  inDrawer: overlay.closest("[data-detail-drawer]") !== null,
                  rect: rect && { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
                  image: overlay.querySelector("img")?.getAttribute("src") ?? null,
                  video: overlay.querySelector("video")?.getAttribute("src") ?? null,
                  pdf: overlay.querySelector("iframe")?.getAttribute("src") ?? null,
                  markdown: overlay.querySelector(".td-gfm")?.innerHTML ?? null,
                  close: overlay.querySelector("[data-attachment-preview-close]") !== null,
                  error: overlay.querySelector("[data-attachment-preview-error]") !== null,
                },
              ]
            : [],
          focus: document.activeElement?.hasAttribute?.("data-attachment-preview-close")
            ? "close"
            : document.activeElement?.hasAttribute?.("data-attachment-open")
              ? "row"
              : document.activeElement?.tagName?.toLowerCase() ?? null,
          drawerState: document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") ?? null,
        };
      });
    const pressAttachment = (name) =>
      page.evaluate((wanted) => {
        const row = [...document.querySelectorAll("[data-attachment-row]")].find(
          (entry) => entry.querySelector("[data-attachment-name]")?.textContent?.trim() === wanted,
        );
        row?.querySelector("[data-attachment-open]")?.click();
      }, name);
    const pressSelector = (selector) => page.evaluate((wanted) => document.querySelector(wanted)?.click(), selector);

    const previewRest = await readPreview();
    previewCheck(previewRest.rows.length === 5, `expected 5 attachment rows, read ${previewRest.rows.length}`);
    previewCheck(
      previewRest.rows.filter((row) => row.open).length === 4,
      `expected 4 previewable rows (md/png/pdf/mp4), read ${JSON.stringify(previewRest.rows)}`,
    );
    previewCheck(
      previewRest.rows.find((row) => row.name === "build-bundle.zip")?.open === false,
      "the zip row carries an open affordance; a type the drawer cannot render must not",
    );
    previewCheck(
      previewRest.rows.filter((row) => row.open).every((row) => row.popup === "dialog"),
      `a previewable row's button does not announce a dialog: ${JSON.stringify(previewRest.rows)}`,
    );
    previewCheck(previewRest.overlays.length === 0, "a preview overlay is present before anything was pressed");
    for (const row of previewRest.rows) {
      const expected = row.open ? "open,download,remove" : "download,remove";
      previewCheck(
        row.actions.join(",") === expected,
        `${row.name}: the action cluster reads ${row.actions.join(",") || "(none)"}, expected ${expected}`,
      );
      previewCheck(
        row.nameTag === "span",
        `${row.name}: the filename is a <${row.nameTag}>, expected a plain span — the eye button is the affordance`,
      );
    }

    for (const [name, kind, reader] of [
      ["focus-order-record.png", "image", "image"],
      ["layout-drawing.pdf", "pdf", "pdf"],
      ["walkthrough.mp4", "video", "video"],
      ["board-keyboard-spec.md", "markdown", "markdown"],
    ]) {
      await pressAttachment(name);
      await page.waitForTimeout(150);
      const read = await readPreview();
      const overlay = read.overlays[0];
      previewCheck(read.overlays.length === 1, `${name}: expected exactly one preview dialog, read ${read.overlays.length}`);
      previewCheck(overlay?.kind === kind, `${name}: preview kind ${JSON.stringify(overlay?.kind)}, expected ${kind}`);
      previewCheck(overlay?.role === "dialog" && overlay?.modal === "true", `${name}: the overlay is not a modal dialog`);
      previewCheck(overlay?.inDrawer === false, `${name}: the dialog renders inside the drawer; it must be teleported to the body`);
      previewCheck(
        overlay?.rect?.top === 0 &&
          overlay?.rect?.left === 0 &&
          Math.abs((overlay?.rect?.width ?? 0) - read.viewport.width) <= 1 &&
          Math.abs((overlay?.rect?.height ?? 0) - read.viewport.height) <= 1,
        `${name}: the dialog is ${JSON.stringify(overlay?.rect)} in a ${JSON.stringify(read.viewport)} viewport, expected to cover it`,
      );
      const source = overlay?.[reader] ?? null;
      previewCheck(typeof source === "string" && source.length > 0, `${name}: the ${kind} renderer received no source`);
      if (reader !== "markdown") {
        previewCheck(
          typeof source === "string" && source.startsWith("blob:"),
          `${name}: the ${kind} source is ${JSON.stringify(source)}, expected a blob: URL (never the content route directly)`,
        );
      }
      previewCheck(overlay?.close === true, `${name}: the dialog has no [data-attachment-preview-close]`);
      previewCheck(read.focus === "close", `${name}: focus after opening is ${read.focus}, expected the close button`);
    }

    await pressSelector("[data-attachment-preview-close]");
    await page.waitForTimeout(150);
    const previewClosed = await readPreview();
    previewCheck(previewClosed.overlays.length === 0, "✕ did not close the preview dialog");
    previewCheck(previewClosed.drawerState === "open", "closing the preview also closed the drawer");
    previewCheck(previewClosed.focus === "row", `focus after closing is ${previewClosed.focus}, expected the row's open button`);

    await pressAttachment("board-keyboard-spec.md");
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const previewEscaped = await readPreview();
    previewCheck(previewEscaped.overlays.length === 0, "Escape did not close the preview dialog");
    previewCheck(previewEscaped.drawerState === "open", "Escape closed the drawer as well as the preview dialog");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const drawerClosed = await page.evaluate(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state"));

    // The shared "Move to" menu: opened from a card's kebab. Since M1 it offers
    // the moves the state machine *allows* from that card's status — not the
    // whole vocabulary — so the expected row count is read off the card the menu
    // was opened on. (The table mirrors `web/src/stores/board.js`
    // `ALLOWED_TRANSITIONS`, the way the counts above mirror the fixture.)
    const MOVE_ROWS = { backlog: 2, todo: 4, in_progress: 5, awaiting: 2, in_review: 3, blocked: 4, done: 0, canceled: 0 };
    const moveMenu = await page.evaluate(() => {
      const kebab = document.querySelector("[data-card-menu]");
      const card = kebab?.closest("[data-card]");
      kebab?.click();
      return { cardStatus: card?.getAttribute("data-status") ?? null };
    });
    await page.waitForTimeout(120);
    moveMenu.open = await page.evaluate(() => !!document.querySelector("[data-move-menu]"));
    moveMenu.rows = await page.evaluate(() => document.querySelectorAll("[data-move-to]").length);
    moveMenu.expected = MOVE_ROWS[moveMenu.cardStatus];
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);

    // Theme is a three-state cycle: three presses return to where it started.
    const themeStart = await page.evaluate(() => document.documentElement.getAttribute("data-theme-mode"));
    const themeRun = [];
    for (let i = 0; i < 3; i++) {
      await page.click("[data-theme-switch]");
      await page.waitForTimeout(80);
      themeRun.push(await page.evaluate(() => document.documentElement.getAttribute("data-theme-mode")));
    }
    const themeEnd = themeRun.at(-1);

    // Language: switch to zh, assert <html lang>, then back to en. The options
    // live inside a floating menu (M2: a `div[data-lang-menu]`, teleported out of
    // the sidebar's scroll container) that would otherwise have to be opened for
    // a hit-test, so the handler is invoked directly (the binding is the same).
    await page.evaluate(() => document.querySelector('[data-lang-option="zh"]')?.click());
    await page.waitForTimeout(150);
    const langAfterZh = await page.evaluate(() => document.documentElement.getAttribute("lang"));
    await page.evaluate(() => document.querySelector('[data-lang-option="en"]')?.click());
    await page.waitForTimeout(150);
    const langAfterEn = await page.evaluate(() => document.documentElement.getAttribute("lang"));

    // P1 — a card that stopped for a human opens where the question and the
    // comment box are. The composer sits above the newest-first list, and the
    // hint states what submitting does on this card.
    await page.click('[data-card][data-identifier="TD-13"] [data-card-title]');
    await page.waitForTimeout(200);
    const awaitingDrawer = await page.evaluate(() => ({
      selected: [...document.querySelectorAll("[data-detail-tab]")]
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
        .map((tab) => tab.getAttribute("data-detail-tab")),
      formFirst: document.querySelector("[data-detail-comments]")?.firstElementChild?.matches("[data-comment-form]") ?? false,
      hint: document.querySelector("[data-detail-comments] [data-i18n='drawer.commentHintAwaiting']")?.textContent?.trim() ?? "",
    }));
    drawerTabsCheck(
      awaitingDrawer.selected.join(",") === "activity",
      `an awaiting card opens on ${awaitingDrawer.selected.join("/")}, expected activity`,
    );
    drawerTabsCheck(awaitingDrawer.formFirst, "the comment form must sit above the comment list");
    drawerTabsCheck(/Submitting answers/.test(awaitingDrawer.hint), `awaiting hint ${JSON.stringify(awaitingDrawer.hint)}`);
    await page.click("[data-detail-close]");
    await page.waitForTimeout(150);

    // ---- R6 · the eight findings, checked in the browser ---------------------
    //
    // Three of the contract's checks are relations rather than values — which
    // glyph is visible *versus which mode the cell names*, whether the panel's
    // transform actually centres it, and whether a long title really stops at
    // two lines. They are measured here, in the live page, next to the
    // declarative rules above.
    const r6Failures = [];
    const r6Check = (ok, message) => { if (!ok) r6Failures.push(message); };

    // ⑦ — sweep the three-state cycle: the visible glyph must be the one the
    // cell's own `data-theme-mode` names, at every stop.
    const themeSweep = [];
    for (let i = 0; i < 3; i++) {
      await page.click("[data-theme-switch]");
      await page.waitForTimeout(80);
      themeSweep.push(await page.evaluate(() => {
        const cell = document.querySelector("[data-theme-switch]");
        const icons = [...cell.querySelectorAll("svg[data-theme-icon]")];
        const visible = icons.filter((el) => getComputedStyle(el).display !== "none");
        return {
          mode: cell.getAttribute("data-theme-mode"),
          icons: icons.length,
          visible: visible.map((el) => el.getAttribute("data-theme-icon")),
          visibleWidth: visible[0] ? visible[0].getBoundingClientRect().width : 0,
          literalFalse: cell.querySelectorAll('svg[data-theme-icon][hidden="false"]').length,
        };
      }));
    }
    for (const stop of themeSweep) {
      r6Check(stop.icons === 3, `theme cell holds ${stop.icons} glyphs, expected 3`);
      r6Check(stop.visible.length === 1, `mode ${stop.mode}: ${stop.visible.length} glyphs visible, expected 1`);
      r6Check(stop.visible[0] === stop.mode, `mode ${stop.mode}: the visible glyph is ${stop.visible.join(",")}`);
      r6Check(stop.visibleWidth > 0, `mode ${stop.mode}: the visible glyph has no width`);
      r6Check(stop.literalFalse === 0, `mode ${stop.mode}: ${stop.literalFalse} glyph(s) carry a literal hidden="false"`);
    }

    // ④ — a title longer than two lines is clipped to exactly two, and the
    // button fills the card's content box (the design's `width:100%`).
    const titleGeometry = await page.evaluate(() => {
      const title = document.querySelector("[data-card-title]");
      const card = title.closest("[data-card]");
      const original = title.textContent;
      title.textContent = "A deliberately long card title that has to wrap ".repeat(6).trim();
      const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
      const cardStyle = getComputedStyle(card);
      const contentWidth = card.getBoundingClientRect().width
        - Number.parseFloat(cardStyle.paddingLeft) - Number.parseFloat(cardStyle.paddingRight)
        - Number.parseFloat(cardStyle.borderLeftWidth) - Number.parseFloat(cardStyle.borderRightWidth);
      const measured = {
        clientHeight: title.clientHeight,
        scrollHeight: title.scrollHeight,
        lineHeight,
        width: title.getBoundingClientRect().width,
        contentWidth,
      };
      title.textContent = original;
      return measured;
    });
    r6Check(titleGeometry.scrollHeight > titleGeometry.clientHeight, "a long title is not clipped vertically");
    r6Check(
      Math.abs(titleGeometry.clientHeight - 2 * titleGeometry.lineHeight) <= 1,
      `a long title is ${titleGeometry.clientHeight}px tall, expected two lines (${2 * titleGeometry.lineHeight}px)`,
    );
    r6Check(
      Math.abs(titleGeometry.width - titleGeometry.contentWidth) <= 1,
      `the title is ${titleGeometry.width}px wide, the card's content box is ${titleGeometry.contentWidth}px`,
    );

    // ⑦⑧ — the rail (≤1023px): the declarative rules above carry the cell's own
    // metrics; this is where they are evaluated.
    await page.setViewportSize({ width: 980, height: 900 });
    await page.waitForTimeout(150);
    const railResults = await evaluateRuleSet(railRules);
    const rail = await page.evaluate(() => {
      const caret = document.querySelector("[data-lang-select] svg.td-caret");
      return {
        caretDisplay: caret ? getComputedStyle(caret).display : null,
        labelDisplay: (() => {
          const label = document.querySelector("[data-lang-label]");
          return label ? getComputedStyle(label).display : null;
        })(),
      };
    });
    r6Check(rail.caretDisplay === "none", `at 980px the caret's display is ${rail.caretDisplay}, expected none`);
    r6Check(rail.labelDisplay === "none", `at 980px the footer label's display is ${rail.labelDisplay}, expected none`);

    // C-RAIL-1 — the rail chip is the project's **effective prefix**, and this is
    // the one viewport where it is visible, so the ruling's core assertion (D1)
    // is measured here: the chip of the project the board is showing must be the
    // token its cards are numbered with. Everything below is read off the live
    // DOM and compared **relationally** — no fixture chip value is written down
    // as an expectation, because the chip's source is the wire, not this file.
    const railChips = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-project-list] [data-project]")];
      return {
        rows: rows.map((row) => {
          const chip = row.querySelector("[data-side-icon]");
          return {
            project: row.getAttribute("data-project"),
            current: row.getAttribute("aria-current") === "page",
            chip: chip ? chip.textContent : null,
            display: chip ? getComputedStyle(chip).display : null,
          };
        }),
        // The board shows the *current* project's cards, so their identifiers
        // carry that project's prefix — which is what the rail chip must repeat.
        // An identifier is `<PREFIX>-<serial>`, and a prefix may itself contain
        // `-`, so the serial is the last segment.
        identifiers: [...document.querySelectorAll("[data-card]")]
          .map((card) => card.getAttribute("data-identifier"))
          .filter(Boolean),
      };
    });
    const chipRows = railChips.rows;
    r6Check(chipRows.length > 0, "the rail lists no project rows");
    r6Check(
      chipRows.every((row) => row.chip !== null),
      `a project row carries no [data-side-icon] chip (${chipRows.map((r) => r.project).join(", ")})`,
    );
    r6Check(
      chipRows.every((row) => (row.chip ?? "").length > 0),
      `a rail chip is empty (${chipRows.map((r) => `${r.project}=${JSON.stringify(r.chip)}`).join(", ")})`,
    );
    r6Check(
      chipRows.every((row) => row.display !== "none"),
      `a rail chip is hidden at 980px: ${chipRows.map((r) => `${r.project}=${r.display}`).join(", ")}`,
    );
    const currentRow = chipRows.find((row) => row.current);
    r6Check(currentRow !== undefined, "no project row is marked aria-current=page");
    // D1 — the chip must be the token the current project's cards are **numbered
    // with**. Anchored on the card the interaction pass opens (`TD-1`) rather
    // than on "every card agrees": the fixture deliberately keeps one off-prefix
    // card in the same project (`PROJ-0007`, the R12 long-identifier anchor) and
    // its identifiers are hand-written, so unanimity is not a property of this
    // data — the *link* between chip and identifier is what C-RAIL-1 rules on.
    const anchorIdentifier = "TD-1";
    const anchor = railChips.identifiers.find((identifier) => identifier === anchorIdentifier);
    const seenPrefixes = [...new Set(railChips.identifiers.map((id) => id.slice(0, id.lastIndexOf("-"))))];
    r6Check(anchor !== undefined, `the fixture's anchor card ${anchorIdentifier} is not on the board`);
    r6Check(
      anchor !== undefined && currentRow !== undefined && anchor.startsWith(`${currentRow.chip}-`),
      `the current project's rail chip is ${JSON.stringify(currentRow?.chip)} but its anchor card is numbered ${anchor} (board prefixes: ${seenPrefixes.join(", ")}) — C-RAIL-1 D1`,
    );

    // B03 "prefix monogram, **rail only**": the same span is hidden again at full
    // width, where the name identifies the row (C-RAIL-1 §8 D3).
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.waitForTimeout(150);
    const wideChipDisplay = await page.evaluate(() =>
      [...document.querySelectorAll("[data-project-list] [data-side-icon]")].map((el) => getComputedStyle(el).display),
    );
    r6Check(
      wideChipDisplay.length > 0 && wideChipDisplay.every((display) => display === "none"),
      `at 1512px the rail chips are ${wideChipDisplay.join(",")}, expected none (B03: rail only)`,
    );
    await page.setViewportSize({ width: 980, height: 900 });
    await page.waitForTimeout(150);

    // ③ — the settings dialog is the prototype's centred modal: open it at the
    // measured viewport and check the geometry, then close it again.
    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);
    await page.click("[data-access-open]");
    // The panel is persistent now: wait for `GET /api/v1/access` to fill the
    // draft before measuring anything that depends on it (rows, switch, Save).
    await page.waitForFunction(
      () => document.querySelector("[data-access-panel]")?.getAttribute("data-access-loaded") === "true",
      { timeout: 5_000 },
    );
    await page.waitForTimeout(200);
    const panelResults = await evaluateRuleSet(panelRules);
    const panelGeometry = await page.evaluate(() => {
      const panel = document.querySelector("[data-access-panel]");
      const box = panel.getBoundingClientRect();
      const labelledby = panel.getAttribute("aria-labelledby");
      return {
        transform: getComputedStyle(panel).transform,
        box: { width: box.width, height: box.height, left: box.left, top: box.top },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        labelledby,
        labelledbyTarget: labelledby !== null && document.getElementById(labelledby) !== null,
        state: panel.getAttribute("data-state"),
        cidrRows: document.querySelectorAll("[data-cidr-row]").length,
        tokenMask: (document.querySelector("[data-token-value]")?.textContent ?? "").trim(),
        tokenIconsVisible: [...document.querySelectorAll("svg[data-token-icon]")]
          .filter((el) => getComputedStyle(el).display !== "none")
          .map((el) => el.getAttribute("data-token-icon")),
      };
    });
    const matrix = /matrix\(([^)]+)\)/.exec(panelGeometry.transform);
    const shift = matrix ? matrix[1].split(",").map((n) => Number.parseFloat(n.trim())) : null;
    r6Check(panelGeometry.state === "open", `the settings panel opened with data-state=${panelGeometry.state}`);
    r6Check(shift !== null, `the settings panel's transform is ${panelGeometry.transform}, not a matrix`);
    if (shift !== null) {
      r6Check(
        Math.abs(shift[4] + panelGeometry.box.width / 2) <= 1,
        `the settings panel is not centred horizontally (translateX ${shift[4]} for width ${panelGeometry.box.width})`,
      );
      r6Check(
        Math.abs(shift[5] + panelGeometry.box.height / 2) <= 1,
        `the settings panel is not centred vertically (translateY ${shift[5]} for height ${panelGeometry.box.height})`,
      );
    }
    r6Check(panelGeometry.labelledbyTarget, `the panel's aria-labelledby="${panelGeometry.labelledby}" has no target`);
    r6Check(panelGeometry.cidrRows === 2, `the CIDR list has ${panelGeometry.cidrRows} rows, expected 2`);
    r6Check(/^td_•+$/.test(panelGeometry.tokenMask), `the token mask is ${JSON.stringify(panelGeometry.tokenMask)}`);
    r6Check(
      panelGeometry.tokenIconsVisible.length === 1,
      `${panelGeometry.tokenIconsVisible.length} token glyphs visible, expected 1`,
    );

    // ③ continued — B19's **internal** layout is the prototype's own. The R6
    // round restored the panel's outer form only; the body order, the
    // allow-list / token boxes and the icon controls were left to arbitrary
    // utilities. `design/prototype/index.html` B19 (measured at 1512×950 on
    // 2026-10-19) is the oracle for every value below.
    const b19 = await page.evaluate(() => {
      const panel = document.querySelector("[data-access-panel]");
      const body = panel?.querySelector(".td-access-body");
      const kids = body ? [...body.children] : [];
      const indexOf = (selector) => kids.findIndex((el) => el.matches(selector));
      const css = (el, props) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return Object.fromEntries(props.map((prop) => [prop, style[prop]]));
      };
      const q = (selector) => panel?.querySelector(selector) ?? null;
      const scrimProbe = document.createElement("div");
      scrimProbe.style.backgroundColor = "var(--brand-scrim)";
      document.body.append(scrimProbe);
      const expectedScrim = getComputedStyle(scrimProbe).backgroundColor;
      scrimProbe.remove();
      const overlay = document.querySelector("[data-access-overlay]");
      return {
        order: {
          bind: indexOf('[data-i18n="access.model.bind"]'),
          cidr: indexOf("[data-cidr-whitelist]"),
          tokenLead: indexOf('[data-i18n="access.model.token"]'),
          token: indexOf("[data-token-block]"),
        },
        title: css(q("#td-access-title"), ["fontSize", "fontWeight"]),
        lead: css(q('[data-i18n="access.model.bind"]'), ["fontSize", "lineHeight", "color"]),
        close: { cls: q("[data-access-close]")?.className ?? null, svg: Boolean(q("[data-access-close] svg")) },
        reveal: { cls: q("[data-token-reveal]")?.className ?? null },
        copy: {
          cls: q("[data-token-copy]")?.className ?? null,
          text: q("[data-token-copy]")?.textContent.trim() ?? null,
          svg: Boolean(q("[data-token-copy] svg")),
        },
        reset: {
          cls: q("[data-token-reset]")?.className ?? null,
          text: q("[data-token-reset]")?.textContent.trim() ?? null,
          svg: Boolean(q("[data-token-reset] svg")),
        },
        token: css(q("[data-token-block]"), ["marginTop", "padding", "backgroundColor", "borderTopWidth", "borderTopColor", "borderRadius"]),
        tokenTitle: css(q(".td-token-title"), ["fontSize", "fontWeight", "color"]),
        tokenValue: css(q("[data-token-value]"), ["height", "fontSize", "color", "backgroundColor", "borderTopWidth", "borderRadius", "padding"]),
        notes: {
          count: panel?.querySelectorAll(".td-token-notes").length ?? 0,
          font: css(q(".td-token-notes"), ["fontSize", "color"]),
          spans: [...(panel?.querySelectorAll(".td-token-notes > span") ?? [])].map((span) => getComputedStyle(span).display),
        },
        cidrList: css(q(".td-cidr-list"), ["borderTopWidth", "borderRadius"]),
        cidrRow: css(q("[data-cidr-row]"), ["padding", "gap"]),
        cidrRow2: css(panel?.querySelectorAll("[data-cidr-row]")[1], ["borderTopWidth"]),
        switch: { disabled: q("[data-cidr-switch]")?.disabled ?? null, cls: q("[data-cidr-switch]")?.className ?? null },
        overlay: {
          state: overlay?.getAttribute("data-state") ?? null,
          background: overlay ? getComputedStyle(overlay).backgroundColor : null,
          expectedScrim,
        },
        ariaHidden: panel?.getAttribute("aria-hidden") ?? null,
        focusClose: document.activeElement === q("[data-access-close]"),
        foot: css(q(".td-access-foot"), ["justifyContent", "paddingRight"]),
        // The Save is the only child of a clean footer; its right edge must sit
        // on the footer's content edge, not the panel's left.
        saveOffset: (() => {
          const foot = q(".td-access-foot");
          const save = q("[data-access-save]");
          if (!foot || !save) return null;
          const paddingRight = Number.parseFloat(getComputedStyle(foot).paddingRight);
          return Math.round(foot.getBoundingClientRect().right - paddingRight - save.getBoundingClientRect().right);
        })(),
      };
    });
    r6Check(
      b19.order.bind === 0 &&
        b19.order.bind < b19.order.cidr &&
        b19.order.cidr < b19.order.tokenLead &&
        b19.order.tokenLead < b19.order.token,
      `B19 body order is bind=${b19.order.bind}, cidr=${b19.order.cidr}, token-lead=${b19.order.tokenLead}, token=${b19.order.token}; expected bind → cidr → token-lead → token`,
    );
    r6Check(
      b19.title?.fontSize === "16px" && b19.title?.fontWeight === "600",
      `the panel title is ${b19.title?.fontSize}/${b19.title?.fontWeight}, expected the prototype's 16px/600`,
    );
    r6Check(
      b19.lead?.fontSize === "13px" && b19.lead?.color === "rgb(74, 85, 94)",
      `the bind lead is ${b19.lead?.fontSize}/${b19.lead?.color}, expected the prototype's 13px/rgb(74, 85, 94)`,
    );
    r6Check(
      /td-iconbtn/.test(b19.close.cls ?? "") && b19.close.svg,
      `the close control is ${b19.close.cls}${b19.close.svg ? "" : " without a glyph"}, expected an icon-only .td-iconbtn`,
    );
    r6Check(/td-iconbtn/.test(b19.reveal.cls ?? ""), `the reveal control is ${b19.reveal.cls}, expected .td-iconbtn`);
    for (const [name, control] of [["copy", b19.copy], ["reset", b19.reset]]) {
      r6Check(
        /td-iconbtn/.test(control.cls ?? "") && control.svg && control.text === "",
        `the ${name} control is ${control.cls} with text ${JSON.stringify(control.text)}; expected an icon-only .td-iconbtn`,
      );
    }
    r6Check(
      b19.token?.backgroundColor === "rgb(245, 246, 247)" &&
        b19.token?.padding === "12px" &&
        b19.token?.borderTopWidth === "1px" &&
        b19.token?.borderRadius === "8px",
      `the token block is ${b19.token?.backgroundColor}, ${b19.token?.padding}, ${b19.token?.borderTopWidth}/${b19.token?.borderRadius}; expected the prototype's sunken 12px box`,
    );
    r6Check(
      b19.tokenTitle?.fontSize === "12px" && b19.tokenTitle?.fontWeight === "600",
      `the token title is ${b19.tokenTitle?.fontSize}/${b19.tokenTitle?.fontWeight}, expected 12px/600`,
    );
    r6Check(
      b19.tokenValue?.height === "32px" &&
        b19.tokenValue?.borderTopWidth === "1px" &&
        b19.tokenValue?.borderRadius === "6px",
      `the token value is ${b19.tokenValue?.height} high, border ${b19.tokenValue?.borderTopWidth}/${b19.tokenValue?.borderRadius}; expected the prototype's 32px field`,
    );
    r6Check(
      b19.notes.count === 1 && b19.notes.font?.fontSize === "11px" && b19.notes.spans.join(",") === "block,block",
      `the token notes are ${b19.notes.count} block(s) at ${b19.notes.font?.fontSize} with spans ${b19.notes.spans.join(",")}; expected one .td-token-notes holding two block spans at 11px`,
    );
    r6Check(
      b19.cidrList?.borderTopWidth === "1px" && b19.cidrList?.borderRadius === "6px",
      `the allow-list box has border ${b19.cidrList?.borderTopWidth}/${b19.cidrList?.borderRadius}, expected 1px/6px`,
    );
    r6Check(
      b19.cidrRow?.padding === "6px 8px" && b19.cidrRow2?.borderTopWidth === "1px",
      `the allow-list row padding is ${b19.cidrRow?.padding} and the second row's rule is ${b19.cidrRow2?.borderTopWidth}; expected 6px 8px and 1px`,
    );
    r6Check(
      b19.switch.disabled === false && /td-toggle/.test(b19.switch.cls ?? ""),
      `the allow-list switch is ${b19.switch.disabled ? "disabled" : "enabled"} with class ${b19.switch.cls}; expected the prototype's movable .td-toggle`,
    );
    r6Check(
      b19.overlay.state === "open" && b19.overlay.background === b19.overlay.expectedScrim,
      `the scrim is data-state=${b19.overlay.state} at ${b19.overlay.background}, expected open and --brand-scrim (${b19.overlay.expectedScrim})`,
    );
    r6Check(b19.ariaHidden === "false", `the open panel carries aria-hidden=${b19.ariaHidden}, expected false`);
    r6Check(b19.focusClose, "opening the settings panel did not move focus to its close control");
    r6Check(
      b19.foot?.justifyContent === "flex-end" && b19.saveOffset === 0,
      `the Save footer is ${b19.foot?.justifyContent} with the button ${b19.saveOffset}px from the content edge; expected flex-end and 0`,
    );

    // The panel is persistent: the draft starts clean, the token is the saved
    // credential, Copy copies it, and one Save writes the switch, the ranges
    // and a staged rotation together.
    const loadedDraft = await page.evaluate(() => ({
      values: [...document.querySelectorAll("[data-cidr-value]")].map((el) => el.value),
      checked: document.querySelector("[data-cidr-switch]").checked,
      saveDisabled: document.querySelector("[data-access-save]").disabled,
    }));
    r6Check(
      loadedDraft.values.join(",") === "192.168.0.0/16,10.0.0.0/8",
      `the loaded ranges are ${loadedDraft.values.join(",")}, expected the two defaults`,
    );
    r6Check(loadedDraft.checked === false, "the default allow-list switch loaded checked; it starts off");
    r6Check(loadedDraft.saveDisabled === true, "Save is enabled on a clean draft");

    await page.evaluate(() => document.querySelector("[data-token-reveal]").click());
    await page.waitForTimeout(60);
    const revealedToken = await page.evaluate(() => document.querySelector("[data-token-value]").textContent.trim());
    r6Check(
      revealedToken === data.access.token,
      `Reveal shows ${JSON.stringify(revealedToken)}, expected the persisted fixture token`,
    );

    await page.evaluate(() => document.querySelector("[data-token-copy]").click());
    await page.waitForTimeout(60);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    r6Check(copied === data.access.token, `Copy put ${JSON.stringify(copied)} on the clipboard, expected the token`);
    await page.evaluate(() => document.querySelector("[data-token-reveal]").click());

    // The switch is a draft: it moves and dims the list, but nothing is
    // persisted until Save.
    await page.evaluate(() => document.querySelector("[data-cidr-switch]").click());
    await page.waitForTimeout(120);
    const cidrOn = await page.evaluate(() => ({
      enabled: document.querySelector("[data-cidr-whitelist]").getAttribute("data-cidr-enabled"),
      listOpacity: getComputedStyle(document.querySelector("[data-cidr-list]")).opacity,
      saveDisabled: document.querySelector("[data-access-save]").disabled,
    }));
    r6Check(
      cidrOn.enabled === "true" && cidrOn.listOpacity === "1",
      `the allow-list switch left data-cidr-enabled=${cidrOn.enabled} and the list at opacity ${cidrOn.listOpacity}; expected true/1`,
    );
    r6Check(cidrOn.saveDisabled === false, "toggling the switch did not dirty the draft");
    r6Check(data.access.allow_list.enabled === false, "the switch persisted before Save");

    // Remove the second row, add a new one and fill it.
    await page.evaluate(() => document.querySelectorAll("[data-cidr-remove]")[1].click());
    await page.waitForTimeout(60);
    r6Check(
      (await page.evaluate(() => document.querySelectorAll("[data-cidr-row]").length)) === 1,
      "removing a range did not drop its row",
    );
    await page.evaluate(() => document.querySelector("[data-cidr-add]").click());
    await page.waitForTimeout(60);
    await page.fill("[data-cidr-row]:last-child [data-cidr-value]", "172.16.0.0/12");
    await page.waitForTimeout(60);
    const editedDraft = await page.evaluate(() => ({
      values: [...document.querySelectorAll("[data-cidr-value]")].map((el) => el.value),
      saveDisabled: document.querySelector("[data-access-save]").disabled,
    }));
    r6Check(
      editedDraft.values.join(",") === "192.168.0.0/16,172.16.0.0/12",
      `the edited draft is ${editedDraft.values.join(",")}`,
    );
    r6Check(editedDraft.saveDisabled === false, "a filled, dirty draft still has Save disabled");

    // A Reset clears the field and shows the "generated on save" placeholder;
    // it must not touch the credential before Save.
    await page.evaluate(() => document.querySelector("[data-token-reset]").click());
    await page.waitForTimeout(60);
    const stagedReset = await page.evaluate(() => ({
      revealed: document.querySelector("[data-token-block]").getAttribute("data-token-revealed"),
      placeholder: Boolean(document.querySelector("[data-token-placeholder]")),
      token: document.querySelector("[data-token-value]").textContent.trim(),
      revealDisabled: document.querySelector("[data-token-reveal]").disabled,
      copyDisabled: document.querySelector("[data-token-copy]").disabled,
    }));
    r6Check(stagedReset.revealed === "false", "a staged Reset revealed a token that does not exist yet");
    r6Check(stagedReset.placeholder, "Reset did not clear the field and show its placeholder");
    r6Check(
      stagedReset.token !== "" && stagedReset.token !== "td_••••••••••••" && !stagedReset.token.startsWith("td_"),
      `a staged Reset left ${JSON.stringify(stagedReset.token)} in the field, expected only the placeholder`,
    );
    r6Check(stagedReset.revealDisabled && stagedReset.copyDisabled, "a staged Reset left Reveal/Copy active on an empty field");
    r6Check(data.access.rotations === 0, "Reset rotated the token before Save");

    // One Save commits the switch, every range and the rotation, then closes.
    await page.evaluate(() => document.querySelector("[data-access-save]").click());
    await page.waitForTimeout(300);
    const savedDraft = await page.evaluate(() => ({
      state: document.querySelector("[data-access-panel]")?.getAttribute("data-state"),
      hidden: document.querySelector("[data-access-panel]")?.hasAttribute("hidden"),
      overlayState: document.querySelector("[data-access-overlay]")?.getAttribute("data-state"),
      overlayHidden: document.querySelector("[data-access-overlay]")?.hasAttribute("hidden"),
      focusOpener: document.activeElement?.hasAttribute("data-access-open") ?? false,
      rows: [...document.querySelectorAll("[data-cidr-value]")].map((el) => el.value),
      enabled: document.querySelector("[data-cidr-whitelist]").getAttribute("data-cidr-enabled"),
      token: document.querySelector("[data-token-value]").textContent.trim(),
    }));
    r6Check(savedDraft.state === "closed" && savedDraft.hidden === true, "Save did not close the settings panel");
    r6Check(
      savedDraft.overlayState === "closed" && savedDraft.overlayHidden === true,
      `Save left the scrim at ${savedDraft.overlayState}, hidden=${savedDraft.overlayHidden}`,
    );
    r6Check(savedDraft.focusOpener, "Save did not return focus to [data-access-open]");
    r6Check(savedDraft.rows.join(",") === "192.168.0.0/16,172.16.0.0/12", `Save left the rows as ${savedDraft.rows.join(",")}`);
    r6Check(savedDraft.enabled === "true", `Save left the switch at ${savedDraft.enabled}`);
    r6Check(savedDraft.token === data.access.token, `Save left ${JSON.stringify(savedDraft.token)} in the field, expected the new token`);
    r6Check(
      data.access.allow_list.enabled === true && data.access.allow_list.cidrs.join(",") === "192.168.0.0/16,172.16.0.0/12",
      `the fixture received ${JSON.stringify(data.access.allow_list)}`,
    );
    r6Check(data.access.rotations === 1, `the fixture saw ${data.access.rotations} rotations, expected 1`);

    // Persistence across a close/reopen (the same code path a refresh takes):
    // the saved policy and the rotated token are read back, and the draft is
    // clean again.
    await page.click("[data-access-open]");
    await page.waitForFunction(
      () => document.querySelector("[data-access-panel]")?.getAttribute("data-access-loaded") === "true",
      { timeout: 5_000 },
    );
    await page.waitForTimeout(120);
    const accessReopened = await page.evaluate(() => ({
      values: [...document.querySelectorAll("[data-cidr-value]")].map((el) => el.value),
      enabled: document.querySelector("[data-cidr-whitelist]").getAttribute("data-cidr-enabled"),
      masked: document.querySelector("[data-token-value]").textContent.trim(),
      saveDisabled: document.querySelector("[data-access-save]").disabled,
    }));
    r6Check(
      accessReopened.values.join(",") === "192.168.0.0/16,172.16.0.0/12",
      `a reopened panel shows ${accessReopened.values.join(",")}, expected the saved ranges`,
    );
    r6Check(accessReopened.enabled === "true", `a reopened panel shows the switch at ${accessReopened.enabled}, expected true`);
    r6Check(accessReopened.masked === "td_••••••••••••", `a reopened panel did not re-mask: ${JSON.stringify(accessReopened.masked)}`);
    r6Check(accessReopened.saveDisabled === true, "a reopened panel is dirty without an edit");

    await page.evaluate(() => document.querySelector("[data-token-reveal]").click());
    await page.waitForTimeout(60);
    const accessReopenedToken = await page.evaluate(() => document.querySelector("[data-token-value]").textContent.trim());
    r6Check(
      accessReopenedToken === data.access.token,
      `a reopened panel shows ${JSON.stringify(accessReopenedToken)}, expected the persisted token`,
    );
    await page.click("[data-access-close]");
    await page.waitForTimeout(200);

    // ⑤ — the list's own relations: one dot per status chip, and a rule that runs
    // *between* rows (the first row draws no top edge).
    for (const dots of listDetail.dotsPerChip) r6Check(dots === 1, `a list status chip holds ${dots} status dots, expected 1`);
    r6Check(listDetail.firstTopBorder === 0, `the first list row draws a ${listDetail.firstTopBorder}px top border, expected none`);
    r6Check(listDetail.laterTopBorder === 1, `the second list row draws a ${listDetail.laterTopBorder}px top border, expected 1`);

    // ---- R7 · the footer's breakpoint split and the drawer's head -----------
    //
    // ③'s contract is a *relation between cells* — three tops that coincide at
    // ≥1024 and march down 24px at a time below it, three lefts that spread or
    // stack, three widths that are equal thirds or the container's own width.
    // A per-element rule cannot state any of those, so they are measured here,
    // at both bands, exactly as the contract's §7 B-table describes them
    // (R7 ③; the ③ revision of 2026-10-12 21:19 made the split a breakpoint
    // one — the wide band keeps the single row, the rail stacks).
    const r7Failures = [];
    const r7Check = (ok, message) => { if (!ok) r7Failures.push(message); };
    const nearlyEqual = (values, tolerance = 1) => Math.max(...values) - Math.min(...values) <= tolerance;
    const strictlyIncreasing = (values, step = null) =>
      values.every((value, i) => i === 0 || (step === null ? value > values[i - 1] : Math.abs(value - values[i - 1] - step) <= 1));

    const measureFooter = async (width) => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      return page.evaluate(() => {
        const box = document.querySelector("[data-access-status]");
        const cells = [...document.querySelectorAll("[data-access-status] [data-access-cell]")];
        const rects = cells.map((el) => el.getBoundingClientRect());
        const round = (n) => Math.round(n * 100) / 100;
        const style = getComputedStyle(box);
        const boxRect = box.getBoundingClientRect();
        return {
          band: window.innerWidth >= 1024 ? "wide" : "rail",
          display: style.display,
          flexDirection: style.flexDirection,
          height: round(boxRect.height),
          contentWidth: round(
            boxRect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
              - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth),
          ),
          // The DOM order the contract fixes: theme → language → settings, read
          // left-to-right at full width and top-to-bottom in the rail.
          order: cells.map((el) => (el.hasAttribute("data-theme-switch") ? "theme"
            : el.hasAttribute("data-lang-select") ? "language" : "settings")),
          cellDirection: cells.map((el) => getComputedStyle(el).flexDirection),
          tops: rects.map((r) => round(r.top)),
          lefts: rects.map((r) => round(r.left)),
          widths: rects.map((r) => round(r.width)),
        };
      });
    };

    const wide = await measureFooter(1512);
    const railBand = await measureFooter(980);

    r7Check(wide.order.join(",") === "theme,language,settings", `wide footer order ${wide.order.join(",")}`);
    r7Check(railBand.order.join(",") === "theme,language,settings", `rail footer order ${railBand.order.join(",")}`);
    r7Check(wide.display === "grid", `wide footer display ${wide.display}, expected grid`);
    r7Check(new Set(wide.tops).size === 1, `wide footer cells' tops ${wide.tops.join(",")} are not all equal`);
    r7Check(strictlyIncreasing(wide.lefts), `wide footer cells' lefts ${wide.lefts.join(",")} do not increase`);
    r7Check(nearlyEqual(wide.widths), `wide footer cell widths ${wide.widths.join(",")} are not equal thirds`);
    r7Check(Math.abs(wide.height - 37) <= 1, `wide footer height ${wide.height}, expected 37`);
    r7Check(wide.cellDirection.every((d) => d === "row"), `wide footer cells are not single rows: ${wide.cellDirection.join(",")}`);
    r7Check(railBand.display === "flex" && railBand.flexDirection === "column", `rail footer is ${railBand.display}/${railBand.flexDirection}, expected flex/column`);
    r7Check(new Set(railBand.tops).size === 3, `rail footer cells' tops ${railBand.tops.join(",")} are not three distinct rows`);
    r7Check(strictlyIncreasing(railBand.tops, 24), `rail footer rows ${railBand.tops.join(",")} are not 24px apart`);
    r7Check(nearlyEqual(railBand.lefts), `rail footer cells' lefts ${railBand.lefts.join(",")} are not equal`);
    r7Check(
      railBand.widths.every((w) => Math.abs(w - railBand.contentWidth) <= 1),
      `rail footer cell widths ${railBand.widths.join(",")} != the container's content width ${railBand.contentWidth}`,
    );
    r7Check(Math.abs(railBand.height - 81) <= 1, `rail footer height ${railBand.height}, expected 81`);
    r7Check(railBand.cellDirection.every((d) => d === "row"), `rail footer cells are not single rows: ${railBand.cellDirection.join(",")}`);

    // ④ — the relations the declarable probe vocabulary cannot express.
    const closeR7 = drawerOpen.r7;
    r7Check(closeR7.sameParent === true, "the close button is not in the identifier's row");
    r7Check(closeR7.rowDirection === "row", `the close button's row is ${closeR7.rowDirection}, expected row`);
    r7Check(closeR7.centerDelta !== null && closeR7.centerDelta <= 2, `the close button is ${closeR7.centerDelta}px off the identifier's centre line`);
    r7Check(closeR7.rightDelta !== null && closeR7.rightDelta <= 2, `the close button is ${closeR7.rightDelta}px off its row's right edge`);
    r7Check(closeR7.closeTop !== null && closeR7.titleTop !== null && closeR7.closeTop < closeR7.titleTop, "the close button is not above the title");
    r7Check(closeR7.path === "M6 6l12 12M18 6 6 18", `the close glyph's path is ${JSON.stringify(closeR7.path)}`);

    // ---- R8 · the list's head, the dark dialog and the identifier's cap -----
    //
    // Three of R8's facts cannot be stated as per-element rules at all: the six
    // head labels are an *ordered list of keys* (a probe cannot index), the
    // head's template is only meaningful **compared with the row's** (R8-1: the
    // computed form resolves `minmax` to pixels and moves with the viewport, so
    // only the two strings' equality is checkable), and the whole of ① lives in
    // the dark, which a rule cannot switch to. They are measured here, next to
    // the declarable rules the contract now carries for the rest.
    const r8Failures = [];
    const r8Check = (ok, message) => { if (!ok) r8Failures.push(message); };
    const within = (values, tolerance = 1) => Math.max(...values) - Math.min(...values) <= tolerance;

    /** The `data-theme-switch` cell is the only theme writer; drive it to `target`. */
    const setThemeMode = async (target) => {
      for (let i = 0; i < 4; i++) {
        const mode = await page.evaluate(() => document.documentElement.getAttribute("data-theme-mode"));
        if (mode === target) return mode;
        await page.click("[data-theme-switch]");
        await page.waitForTimeout(90);
      }
      return page.evaluate(() => document.documentElement.getAttribute("data-theme-mode"));
    };

    /** The head's own measurements, plus the row's for the comparisons. */
    const measureListHead = () =>
      page.evaluate(() => {
        const heads = [...document.querySelectorAll(".td-list-head")];
        const real = heads.find((head) => head.closest("[data-skeleton]") === null) ?? null;
        const skeleton = heads.find((head) => head.closest("[data-skeleton]") !== null) ?? null;
        const row = document.querySelector("[data-list-rows] .td-list-row");
        const visible = (el) => getComputedStyle(el).display !== "none";
        const cells = real ? [...real.children] : [];
        const cs = (el, property) => (el ? getComputedStyle(el)[property] : null);
        // Only the cells the current breakpoint shows: a `display: none` cell has
        // no box, and its 0 left would be compared against a real one.
        const lefts = (el) => (el ? [...el.children].filter(visible).map((cell) => Math.round(cell.getBoundingClientRect().left * 100) / 100) : null);
        return {
          heads: heads.length,
          cells: cells.length,
          i18n: cells.map((cell) => cell.getAttribute("data-i18n")),
          text: cells.map((cell) => (cell.textContent ?? "").trim()),
          hideSm: cells.map((cell) => cell.classList.contains("td-hide-sm")),
          visibleCells: cells.filter(visible).length,
          justify: cells.map((cell) => getComputedStyle(cell).justifySelf),
          headLefts: lefts(real),
          rowLefts: lefts(row),
          skeletonCells: skeleton ? skeleton.children.length : null,
          skeletonColumn: skeleton?.firstElementChild ? getComputedStyle(skeleton.firstElementChild).gridColumn : null,
          head: {
            template: cs(real, "gridTemplateColumns"),
            gap: cs(real, "gap"),
            padding: cs(real, "paddingLeft"),
          },
          row: {
            template: cs(row, "gridTemplateColumns"),
            gap: cs(row, "gap"),
            padding: cs(row, "paddingLeft"),
            visibleCells: row ? [...row.children].filter(visible).length : null,
          },
        };
      });

    // ③ — every identifier render point, with the root that carries the full
    // value. The list is read through the contract's own selector for that render
    // point (`[data-list-rows] [data-list-identifier]`): the row **template** in
    // the document carries the same hook and no value, by design.
    const readIdentifiers = () =>
      page.evaluate(() => {
        const roots = {
          "[data-card-identifier]": "[data-card]",
          "[data-list-rows] [data-list-identifier]": "[data-list-row]",
          "[data-detail-identifier]": "[data-detail-drawer]",
        };
        const out = {};
        for (const [selector, rootSelector] of Object.entries(roots)) {
          out[selector] = [...document.querySelectorAll(selector)].map((el) => ({
            text: (el.textContent ?? "").trim(),
            title: el.getAttribute("title"),
            whiteSpace: getComputedStyle(el).whiteSpace,
            hasIdClass: el.classList.contains("td-id"),
            root: el.closest(rootSelector)?.getAttribute("data-identifier") ?? null,
          }));
        }
        return out;
      });

    // ① — the three separation layers, read in whichever theme is in force, with
    // the two token references resolved live so nothing is compared against a
    // literal the stylesheet could legitimately change. The veils' relative
    // luminance is composited over each theme's own canvas in a 1×1 canvas, so a
    // serialization the harness cannot parse (`oklab(…)`, say) is still compared
    // as a colour: "does it dim?" is a question about pixels, not about strings.
    const readDialog = () =>
      page.evaluate(() => {
        const dialog = document.querySelector("[data-create-task]");
        const panel = document.querySelector("[data-create-task-panel]");
        const overlay = document.querySelector("[data-detail-overlay]");
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;";
        document.body.appendChild(probe);
        probe.style.backgroundColor = "color-mix(in oklab, var(--color-neutral) 32%, transparent)";
        const neutralMix = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = "";
        probe.style.color = "var(--brand-border)";
        const borderToken = getComputedStyle(probe).color;
        probe.style.color = "";
        probe.style.backgroundColor = "var(--brand-bg)";
        const canvasColor = getComputedStyle(probe).backgroundColor;
        probe.remove();

        /** WCAG relative luminance of `veil` composited over `backdrop`. */
        const luminanceOver = (veil, backdrop) => {
          const ctx = document.createElement("canvas").getContext("2d");
          ctx.canvas.width = 1;
          ctx.canvas.height = 1;
          ctx.fillStyle = backdrop;
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = veil;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          const lin = (channel) => {
            const s = channel / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        };

        const scrim = getComputedStyle(dialog).backgroundColor;
        return {
          themeMode: document.documentElement.getAttribute("data-theme-mode"),
          themeAttr: document.documentElement.getAttribute("data-theme"),
          scrim,
          neutralMix,
          overlay: getComputedStyle(overlay).backgroundColor,
          panelBorder: getComputedStyle(panel).borderTopColor,
          borderToken,
          panelShadow: getComputedStyle(panel).boxShadow,
          panelBackground: getComputedStyle(panel).backgroundColor,
          // What the veil does where it is actually painted: over this theme's
          // canvas ...
          veiledCanvasLuminance: luminanceOver(scrim, canvasColor),
          bareCanvasLuminance: luminanceOver(canvasColor, canvasColor),
          // ... and the veil's own lightness, taken over a constant backdrop so
          // the two themes' veils can be compared with each other (N4).
          veilLuminance: luminanceOver(scrim, "#ffffff"),
        };
      });

    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);
    await page.click('[data-view="list"]');
    await waitForListSettled();
    await page.waitForTimeout(120);
    const headWide = await measureListHead();

    const R8_COLUMNS = [
      "list.columns.identifier",
      "list.columns.title",
      "list.columns.status",
      "list.columns.assignee",
      "list.columns.priority",
      "list.columns.revision",
    ];
    r8Check(headWide.heads === 2, `${headWide.heads} list heads, expected 2 (the resident skeleton group's and the data group's)`);
    r8Check(headWide.cells === 6, `the head holds ${headWide.cells} cells, expected 6`);
    r8Check(
      JSON.stringify(headWide.i18n) === JSON.stringify(R8_COLUMNS),
      `the head's i18n seats are ${JSON.stringify(headWide.i18n)}, expected ${JSON.stringify(R8_COLUMNS)}`,
    );
    // N2 — a seat renders its label, never the key it resolves through.
    for (const [index, text] of headWide.text.entries()) {
      r8Check(text.length > 0 && !text.startsWith("list."), `head cell ${index + 1} renders ${JSON.stringify(text)}`);
    }
    // A3/A4 — the hide class is on the middle three and only the middle three,
    // and it is the same class the row's cells carry, so one ≤759px rule reaches
    // both sides of the column.
    r8Check(
      JSON.stringify(headWide.hideSm) === JSON.stringify([false, false, true, true, true, false]),
      `the head's hide classes are ${JSON.stringify(headWide.hideSm)}`,
    );
    r8Check(headWide.skeletonCells === 1, `the loading head holds ${headWide.skeletonCells} span(s), expected 1`);
    r8Check(
      headWide.skeletonColumn === "1 / -1",
      `the loading caption's grid-column is ${headWide.skeletonColumn}, expected 1 / -1`,
    );
    // N3 — every cell starts at its track's start, as the row's cells do.
    r8Check(
      headWide.justify.every((value) => value === "start"),
      `the head's cells are not all start-aligned: ${headWide.justify.join(",")}`,
    );
    // R8-1 — the head and the row share one template, asserted as the two
    // strings' equality, never as the literal `74px minmax(0, 1fr) …` the
    // computed form resolves away.
    r8Check(
      headWide.head.template === headWide.row.template && headWide.head.template !== null,
      `the head's template ${headWide.head.template} != the row's ${headWide.row.template}`,
    );
    r8Check(headWide.head.gap === headWide.row.gap, `the head's gap ${headWide.head.gap} != the row's ${headWide.row.gap}`);
    r8Check(headWide.head.padding === headWide.row.padding, `the head's padding ${headWide.head.padding} != the row's ${headWide.row.padding}`);
    r8Check(headWide.visibleCells === 6, `${headWide.visibleCells} head cells visible at 1512px, expected 6`);
    // The template being *the same declaration* is not the same as the columns
    // landing in the same place: a row whose own box is narrower than the group's
    // resolves its `1fr` against its own width and drifts, with equal templates
    // throughout. Compare the columns' edges.
    r8Check(
      headWide.headLefts !== null &&
        headWide.rowLefts !== null &&
        headWide.headLefts.length === headWide.rowLefts.length &&
        headWide.headLefts.every((left, index) => Math.abs(left - headWide.rowLefts[index]) <= 1),
      `the head's columns start at ${JSON.stringify(headWide.headLefts)} but the row's at ${JSON.stringify(headWide.rowLefts)}`,
    );

    // The same three relations one breakpoint down: the heads narrow with the
    // rows instead of keeping six tracks over three-track rows.
    await page.setViewportSize({ width: 430, height: 950 });
    await page.waitForTimeout(200);
    const headNarrow = await measureListHead();
    r8Check(headNarrow.head.template === headNarrow.row.template, `at 430px the head's template ${headNarrow.head.template} != the row's ${headNarrow.row.template}`);
    r8Check(headNarrow.visibleCells === 3, `${headNarrow.visibleCells} head cells visible at 430px, expected 3`);
    r8Check(
      headNarrow.visibleCells === headNarrow.row.visibleCells,
      `at 430px the head shows ${headNarrow.visibleCells} cells and the row ${headNarrow.row.visibleCells} — they must match`,
    );
    // N5 — and the columns the breakpoint keeps land on the same edges there too.
    r8Check(
      headNarrow.headLefts !== null &&
        headNarrow.rowLefts !== null &&
        headNarrow.headLefts.length === headNarrow.rowLefts.length &&
        headNarrow.headLefts.every((left, index) => Math.abs(left - headNarrow.rowLefts[index]) <= 1),
      `at 430px the visible columns start at ${JSON.stringify(headNarrow.headLefts)} (head) / ${JSON.stringify(headNarrow.rowLefts)} (row)`,
    );

    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);

    // ③ — the cap, the full value beside it, and the roots that carry it.
    const identifiers = await readIdentifiers();
    for (const [selector, entries] of Object.entries(identifiers)) {
      r8Check(entries.length > 0, `${selector} matched nothing`);
      for (const entry of entries) {
        const expected = (entry.title ?? "").length > 10 ? `${(entry.title ?? "").slice(0, 10)}…` : entry.title;
        r8Check(entry.hasIdClass, `${selector} ${JSON.stringify(entry.title)} does not wear .td-id`);
        r8Check(entry.whiteSpace === "nowrap", `${selector} white-space is ${entry.whiteSpace}, expected nowrap`);
        r8Check(typeof entry.title === "string" && entry.title.length > 0, `${selector} carries no title`);
        r8Check(entry.text === expected, `${selector} renders ${JSON.stringify(entry.text)}, expected ${JSON.stringify(expected)}`);
        r8Check(entry.text.length <= 11, `${selector} renders ${entry.text.length} characters`);
        // N4/B21-B23 — the root keeps the whole value, and the rendered text may
        // never be the thing read back (it is the truncated form whenever the id
        // is long enough to be truncated at all).
        r8Check(entry.root === entry.title, `${selector}: the root's data-identifier ${JSON.stringify(entry.root)} != the title ${JSON.stringify(entry.title)}`);
      }
    }
    // The fixture's ids are all short — its longest is nine (`PROJ-0007`) — so
    // every one of them is a below-the-cap sample under the **ten**-character cap
    // (it was eight until T-20261014-001418, which is what made `PROJ-0007` the
    // over-cap sample this section used to lean on). None may be altered: a row
    // that still sliced at eight would fail here. Truncation *arithmetic* is
    // covered by `test/web/identifier.test.mjs`, which can construct an over-cap
    // id without touching the shared fixture.
    for (const entry of identifiers["[data-card-identifier]"]) {
      r8Check(entry.text === entry.title, `a ${entry.title.length}-character id was altered: ${JSON.stringify(entry.text)}`);
    }

    // The drawer's root is the one all three readings above could not reach while
    // it was shut: open it and compare the head's pair against the root's value.
    await page.click('[data-view="board"]');
    await page.waitForTimeout(120);
    await page.click("[data-card]");
    await page.waitForTimeout(250);
    const drawerIdentifier = await page.evaluate(() => {
      const el = document.querySelector("[data-detail-identifier]");
      const root = document.querySelector("[data-detail-drawer]");
      const card = document.querySelector(`[data-card][data-identifier="${root?.getAttribute("data-identifier")}"]`);
      return {
        text: (el?.textContent ?? "").trim(),
        title: el?.getAttribute("title") ?? null,
        root: root?.getAttribute("data-identifier") ?? null,
        rootFindsTheCard: card !== null && card !== undefined,
      };
    });
    r8Check(drawerIdentifier.root === drawerIdentifier.title, `the drawer root's identifier ${JSON.stringify(drawerIdentifier.root)} != the head's title ${JSON.stringify(drawerIdentifier.title)}`);
    r8Check(drawerIdentifier.root !== null && drawerIdentifier.root.length > 0, "the drawer root carries no data-identifier");
    r8Check(drawerIdentifier.rootFindsTheCard, `[data-card][data-identifier="${drawerIdentifier.root}"] matches no card`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ---- R12 · the drawer's head shows the whole identifier ------------------
    // The contract's §5 A1–A3′ / A4–A6″ and C-1–C-4, driven through real events.
    // `PROJ-0007` is the fixture's **longest** id (nine characters). Under the
    // eight-character cap it used to be the fixture's one over-cap sample, and
    // "the head shows it whole while its own card shows `PROJ-000…`" was the
    // relation that told the two render points apart. The cap is **ten** since
    // T-20261014-001418, so nine is now *below* it: both sides render the id
    // whole and that disagreement is no longer constructible from the fixture.
    // What still separates them — and what this section therefore turns on — is
    // the width cap: the drawer's head carries `.td-id-full` and the card and
    // list row must not, and their `max-width` must stay a finite px value. The
    // truncated string itself is covered by `test/web/identifier.test.mjs` (the
    // arithmetic) and by the combo section below (an option row that caps).
    const r12IdFailures = [];
    const r12IdCheck = (ok, message) => { if (!ok) r12IdFailures.push(message); };
    const LONG_ID = "PROJ-0007";
    /** The card's and the list row's text for `LONG_ID` — whole, since 10 ≥ 9. */
    const CLAMPED = "PROJ-0007";

    /** Open `identifier`'s card by a real press, then read the head whole. */
    const openCardAndReadHead = async (identifier) => {
      await page.click(`[data-card][data-identifier="${identifier}"]`);
      await page.waitForTimeout(250);
      return page.evaluate(() => {
        const head = document.querySelector("[data-detail-identifier]");
        const root = document.querySelector("[data-detail-drawer]");
        const cs = head ? getComputedStyle(head) : null;
        return {
          state: root?.getAttribute("data-state") ?? null,
          text: (head?.textContent ?? "").trim(),
          title: head?.getAttribute("title") ?? null,
          rootIdentifier: root?.getAttribute("data-identifier") ?? null,
          classes: head ? [...head.classList] : [],
          maxWidth: cs?.maxWidth ?? null,
          overflow: cs?.overflow ?? null,
          textOverflow: cs?.textOverflow ?? null,
          whiteSpace: cs?.whiteSpace ?? null,
        };
      });
    };

    // C-1 / A1 — a real press on the over-cap card, and the head renders it whole.
    const longHead = await openCardAndReadHead(LONG_ID);
    r12IdCheck(longHead.state === "open", `the drawer's data-state is ${JSON.stringify(longHead.state)}, expected "open"`);
    r12IdCheck(longHead.text === LONG_ID, `the head renders ${JSON.stringify(longHead.text)}, expected the whole id ${JSON.stringify(LONG_ID)}`);
    r12IdCheck(!longHead.text.includes("…"), `the head still renders an ellipsis: ${JSON.stringify(longHead.text)}`);
    r12IdCheck(longHead.text.length === LONG_ID.length, `the head renders ${longHead.text.length} characters, expected ${LONG_ID.length} (no slice)`);
    // A4′ — the attribute pair was already the full id; R12 must not have moved it.
    r12IdCheck(longHead.title === LONG_ID, `the head's title is ${JSON.stringify(longHead.title)}, expected ${JSON.stringify(LONG_ID)}`);
    r12IdCheck(longHead.rootIdentifier === LONG_ID, `the drawer root's data-identifier is ${JSON.stringify(longHead.rootIdentifier)}, expected ${JSON.stringify(LONG_ID)}`);
    // A6 — the variant is an **addition**: both classes ride the one element.
    r12IdCheck(longHead.classes.includes("td-id"), `the head's class list ${JSON.stringify(longHead.classes)} lost .td-id`);
    r12IdCheck(longHead.classes.includes("td-id-full"), `the head's class list ${JSON.stringify(longHead.classes)} is missing .td-id-full`);
    // A2 — the cap is withdrawn, and only the cap (the single-line guard stays).
    r12IdCheck(longHead.maxWidth === "none", `the head's max-width is ${longHead.maxWidth}, expected none`);
    r12IdCheck(longHead.overflow === "visible", `the head's overflow is ${longHead.overflow}, expected visible`);
    r12IdCheck(longHead.textOverflow === "clip", `the head's text-overflow is ${longHead.textOverflow}, expected clip`);
    r12IdCheck(longHead.whiteSpace === "nowrap", `the head's white-space is ${longHead.whiteSpace}, expected nowrap`);

    // A3′ / C-4 — the length diagnostic: Terry's own length (18 characters) must
    // not be clipped either. Swapped in at runtime so the fixture needs no such
    // card, measured on the instant, then restored before the next assertion.
    const longDiagnostic = await page.evaluate(() => {
      const head = document.querySelector("[data-detail-identifier]");
      const original = head.textContent;
      head.textContent = "TD-20261012-222353";
      const read = { scrollWidth: head.scrollWidth, clientWidth: head.clientWidth };
      head.textContent = original;
      return { ...read, restored: (head.textContent ?? "").trim() };
    });
    r12IdCheck(
      longDiagnostic.scrollWidth <= longDiagnostic.clientWidth + 1,
      `an 18-character id is still clipped: scrollWidth ${longDiagnostic.scrollWidth} > clientWidth ${longDiagnostic.clientWidth}`,
    );
    r12IdCheck(longDiagnostic.restored === LONG_ID, `the length diagnostic did not restore the head: ${JSON.stringify(longDiagnostic.restored)}`);

    // A6′ — the variant does not spill, read while the drawer is open (the one
    // moment it is on screen): no card and no list row may wear it.
    const spill = await page.evaluate(() => {
      const cardEl = document.querySelector('[data-card][data-identifier="PROJ-0007"] [data-card-identifier]');
      return {
        cards: document.querySelectorAll("[data-card-identifier].td-id-full").length,
        rows: document.querySelectorAll("[data-list-rows] [data-list-identifier].td-id-full").length,
        fullClass: document.querySelectorAll(".td-id-full").length,
        cardText: cardEl ? (cardEl.textContent ?? "").trim() : null,
        cardMax: cardEl ? getComputedStyle(cardEl).maxWidth : null,
      };
    });
    r12IdCheck(spill.cards === 0, `${spill.cards} card identifiers wear .td-id-full, expected 0`);
    r12IdCheck(spill.rows === 0, `${spill.rows} list identifiers wear .td-id-full, expected 0`);
    r12IdCheck(spill.fullClass === 1, `${spill.fullClass} elements wear .td-id-full, expected exactly the drawer head`);
    // A4 — the card renders the same id whole (nine is inside the ten-character
    // cap; under the old cap this was `PROJ-000…`) and still carries a finite
    // width cap (`9ch` resolves to px — C′1: never assert the string `9ch`).
    r12IdCheck(spill.cardText === CLAMPED, `the card for ${LONG_ID} renders ${JSON.stringify(spill.cardText)}, expected ${JSON.stringify(CLAMPED)}`);
    r12IdCheck(!spill.cardText.includes("…"), `the card gained an ellipsis under the widened cap: ${JSON.stringify(spill.cardText)}`);
    r12IdCheck(
      spill.cardMax !== null && spill.cardMax !== "none" && /px$/.test(spill.cardMax),
      `the card identifier's max-width is ${spill.cardMax}, expected a finite px value`,
    );

    // A6″ / C-2 — a short id is not a regression: six characters, below the cap,
    // render verbatim and gain no ellipsis.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const shortHead = await openCardAndReadHead("TD-1");
    r12IdCheck(shortHead.state === "open", `the drawer's data-state is ${JSON.stringify(shortHead.state)} for the short-id card`);
    r12IdCheck(shortHead.text === "TD-1", `a short id renders ${JSON.stringify(shortHead.text)}, expected "TD-1"`);
    r12IdCheck(!shortHead.text.includes("…"), `a short id gained an ellipsis: ${JSON.stringify(shortHead.text)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // C-3 — the list row is the reverse anchor in the other view too.
    await page.click('[data-view="list"]');
    await page.waitForTimeout(200);
    const listRead = await page.evaluate(() => {
      const row = document.querySelector('[data-list-rows] [data-list-row][data-identifier="PROJ-0007"]');
      const el = row ? row.querySelector("[data-list-identifier]") : null;
      return {
        found: row !== null,
        text: el ? (el.textContent ?? "").trim() : null,
        hasFull: el ? el.classList.contains("td-id-full") : null,
        max: el ? getComputedStyle(el).maxWidth : null,
      };
    });
    r12IdCheck(listRead.found, `the card for ${LONG_ID} has no list row to reverse-assert against`);
    r12IdCheck(listRead.text === CLAMPED, `the list row for ${LONG_ID} renders ${JSON.stringify(listRead.text)}, expected ${JSON.stringify(CLAMPED)}`);
    r12IdCheck(listRead.hasFull === false, "a list row wears .td-id-full");
    r12IdCheck(
      listRead.max !== null && listRead.max !== "none" && /px$/.test(listRead.max),
      `the list identifier's max-width is ${listRead.max}, expected a finite px value`,
    );
    await page.click('[data-view="board"]');
    await page.waitForTimeout(150);

    // ① — the dark. The switch is the only writer, so the section drives it to
    // `dark`, measures, then drives it back to `light` for the regression half.
    const reachedDark = await setThemeMode("dark");
    r8Check(reachedDark === "dark", `the theme switch reached ${reachedDark}, expected dark`);
    await page.click("[data-new-task]");
    await page.waitForTimeout(250);
    const dark = await readDialog();
    r8Check(dark.themeAttr === "dark", `the document's data-theme is ${dark.themeAttr} in the dark stop`);
    // B1/B8 — the veil, and the shared token behind it.
    r8Check(dark.scrim === "rgba(0, 0, 0, 0.55)", `the dark scrim is ${dark.scrim}, expected rgba(0, 0, 0, 0.55)`);
    r8Check(dark.overlay === dark.scrim, `the drawer's veil ${dark.overlay} != the dialog's scrim ${dark.scrim} — they share one token`);
    // B3 — the panel's edge is the strong hairline in the dark.
    r8Check(dark.panelBorder === "rgb(49, 59, 65)", `the dark panel's border is ${dark.panelBorder}, expected rgb(49, 59, 65)`);
    // B5 — the elevation is visible, i.e. black rather than canvas-tinted.
    r8Check(dark.panelShadow.includes("rgba(0, 0, 0, 0.6)"), `the dark panel's shadow is ${dark.panelShadow}, expected it to contain rgba(0, 0, 0, 0.6)`);
    // B7/N3 — the *surface* is not what changed.
    r8Check(dark.panelBackground === "rgb(22, 27, 30)", `the dark panel's surface is ${dark.panelBackground}, expected rgb(22, 27, 30)`);
    // N4 — the dark veil **dims** where the light one **lifts**: each is
    // composited over its own theme's canvas and compared. This is the machine
    // form of Terry's finding — before the round the two veils were byte-equal,
    // so the dark one could only lift (its `--color-neutral` is lighter than the
    // dark canvas).
    r8Check(
      dark.veiledCanvasLuminance < dark.bareCanvasLuminance,
      `the dark veil lifts its canvas (${dark.veiledCanvasLuminance} vs ${dark.bareCanvasLuminance})`,
    );

    await page.click("[data-create-task] [data-modal-close]");
    await page.waitForTimeout(200);
    const reachedLight = await setThemeMode("light");
    r8Check(reachedLight === "light", `the theme switch reached ${reachedLight}, expected light`);
    await page.click("[data-new-task]");
    await page.waitForTimeout(250);
    const light = await readDialog();
    r8Check(light.themeAttr === "meerkat-taskpanel", `the document's data-theme is ${light.themeAttr} in the light stop`);
    // B2/C4 — the light veil is byte-identical to the one the dialogs carried
    // before the round (`bg-neutral/32`, i.e. `--color-neutral` at 32%). It is
    // deliberately **not** compared against the prototype's `rgba(15, 20, 23,
    // 0.32)`: the two sides differ there and this round does not change it.
    r8Check(light.scrim === light.neutralMix, `the light scrim ${light.scrim} != the pre-round bg-neutral/32 value ${light.neutralMix}`);
    // B4 — the light edge is still the ordinary hairline, not the strong one.
    r8Check(light.panelBorder === light.borderToken, `the light panel's border ${light.panelBorder} != var(--brand-border) ${light.borderToken}`);
    // B6 — and the elevation is the light one.
    r8Check(!light.panelShadow.includes("rgba(0, 0, 0, 0.6)"), `the light panel's shadow carries the dark value: ${light.panelShadow}`);
    // N4 — the two veils are no longer the same colour: before the round they
    // were byte-equal, which is why the dark one could only lift its canvas.
    r8Check(
      dark.veilLuminance < light.veilLuminance,
      `the dark veil's luminance ${dark.veilLuminance} is not below the light veil's ${light.veilLuminance}`,
    );
    await page.click("[data-create-task] [data-modal-close]");
    await page.waitForTimeout(200);

    // ---- R9 · one dismiss rule, one filter control, two list states ----------
    //
    // The three facts the declarable vocabulary cannot state: *which half of the
    // list is on screen at one instant* (a relation between two elements), *three
    // controls' heights against each other* (again a relation), and *where a
    // floating control went after a real pointer click* (a sequence). Everything
    // else this round adds is a rule the contract now carries.
    const r9Failures = [];
    const r9Check = (ok, message) => { if (!ok) r9Failures.push(message); };

    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);

    /** Both dismiss members, read as one record. */
    const readDismiss = () =>
      page.evaluate(() => {
        const members = [...document.querySelectorAll("[data-dismiss-on-outside]")];
        return {
          members: members.length,
          allDropdowns: members.every((el) => el.tagName === "DETAILS" && el.classList.contains("dropdown")),
          named: members.filter((el) => el.hasAttribute("data-project-switcher") || el.hasAttribute("data-filter-label")).length,
          open: document.querySelectorAll("[data-dismiss-on-outside][open]").length,
          switcherOpen: document.querySelector("[data-project-switcher]")?.hasAttribute("open") ?? null,
          labelOpen: document.querySelector("[data-filter-label]")?.hasAttribute("open") ?? null,
        };
      });

    /** Open a member by its own trigger and report the whole register. */
    const openMember = async (trigger) => {
      await page.click(trigger);
      await page.waitForTimeout(90);
      return readDismiss();
    };

    /** A click the page cannot intercept — the contract's `synthetic` (§1 R3). */
    const clickSynthetic = async (selector) => {
      await page.evaluate((sel) => document.querySelector(sel)?.dispatchEvent(new MouseEvent("click", { bubbles: true })), selector);
      await page.waitForTimeout(80);
    };

    // A1/A3 — the register: both members are daisyUI dropdowns, and membership is
    // the attribute itself, so the count is a floor rather than "exactly two".
    const register = await readDismiss();
    r9Check(register.members >= 2, `${register.members} dismiss member(s), expected at least 2`);
    r9Check(register.allDropdowns, "a [data-dismiss-on-outside] is not a `details.dropdown`");
    r9Check(register.named === 2, `the register no longer holds both named members (${register.named})`);

    // ①-1/C1 — the switcher opens from its own `<summary>`.
    const switcherOpened = await openMember("[data-project-switcher] > summary");
    r9Check(switcherOpened.switcherOpen === true, "the project switcher did not open");

    // ①-1/C2 — a click elsewhere closes it (dispatched, so the panel's own
    // coverage of the bar cannot decide the outcome — the handler is what is
    // under test here).
    await clickSynthetic("[data-filter-count]");
    r9Check((await readDismiss()).open === 0, "the switcher stayed open after a synthetic outside click");

    // ①-2/C3 — and a *real* pointer click on an inert point closes it. This is
    // the half the panel used to swallow.
    //
    // Every probe below asserts that its own "open" step actually opened: a
    // member left open by the *previous* failing check would let the next
    // assertion pass for the wrong reason — the toggle would close it and the
    // probe would read "closed" without the rule under test doing anything (the
    // mutation proof's M1 caught exactly that).
    const reopenedForReal = await openMember("[data-project-switcher] > summary");
    r9Check(reopenedForReal.switcherOpen === true, "the switcher did not open again for the real-pointer probe");
    await page.mouse.click(4, 4);
    await page.waitForTimeout(80);
    r9Check((await readDismiss()).open === 0, "the switcher stayed open after a real pointer click outside");

    // ①-3/C6 — Escape closes it.
    const reopenedForEscape = await openMember("[data-project-switcher] > summary");
    r9Check(reopenedForEscape.switcherOpen === true, "the switcher did not open again for the Escape probe");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    r9Check((await readDismiss()).open === 0, "Escape left the switcher open");

    // ②-1/②-2/C4 — the label filter answers the *same* rule: it is the second
    // member, not a second implementation.
    const labelOpened = await openMember("[data-filter-label] > summary");
    r9Check(labelOpened.labelOpen === true, "the label filter did not open");
    await clickSynthetic("[data-filter-count]");
    r9Check((await readDismiss()).open === 0, "the label filter stayed open after a synthetic outside click");
    const labelAgain = await openMember("[data-filter-label] > summary");
    r9Check(labelAgain.labelOpen === true, "the label filter did not open again for the Escape probe");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    r9Check((await readDismiss()).open === 0, "Escape left the label filter open");

    // ①-4/②-3/C5 — one at a time. The second trigger's click is dispatched for
    // the same reason as above: the first member's own panel covers the bar
    // while it is open (that coverage is exactly what Terry hit in the *unfixed*
    // state, and the fix is the dismissal, not the geometry).
    await openMember("[data-project-switcher] > summary");
    await clickSynthetic("[data-filter-label] > summary");
    const both = await readDismiss();
    r9Check(both.open <= 1, `${both.open} dismiss members are open at once`);
    r9Check(both.labelOpen === true && both.switcherOpen === false, "opening the label filter did not take the switcher down");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);

    // The dismissal's other half, which the contract's five assertions do not
    // name but the prototype's own option handlers do: choosing is what the panel
    // was open for, so the panel closes with the choice (`design/prototype/app.js`
    // — the project option clears `open`, the label option calls
    // `closeLabelMenu()`). Both clicks land on the *first* option, which is the
    // state the fixture is already in, so the board is left as it was found.
    await openMember("[data-filter-label] > summary");
    await page.click("[data-filter-label-option]");
    await page.waitForTimeout(90);
    r9Check((await readDismiss()).labelOpen === false, "choosing a label left the menu open");
    await openMember("[data-project-switcher] > summary");
    await page.click('[data-project-option="MeerkatTaskPanel"]');
    await page.waitForTimeout(120);
    r9Check((await readDismiss()).switcherOpen === false, "choosing a project left the switcher open");

    // §5 B3 — the relation the round is about: the field family's controls, one
    // height. An absolute figure is the prototype's platform value; *equal* is
    // the fact Terry read as "not the same component" when it was 30 / 30 / 28.
    // B11 — the caret lives in the room the right padding reserves: 14px, 6px
    // from the trigger's padding box (7px from its border box, §1 R9-1), centred
    // on the trigger's own centre line.
    //
    // R11 ① — the status control is the fourth member of that family and wears
    // the same `.td-label-trigger` shell, so this probe is stated over the
    // **label control's own hook** rather than over the class: a class-scoped
    // caret count now sees two, and the fact R9 asserted was always "the label
    // trigger has one caret", not "the document has one trigger". The family's
    // heights gain the status member, which is what R11's §5 A3 asks for.
    const controls = await page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      };
      const round = (n) => Math.round(n * 100) / 100;
      const height = (selector) => {
        const rect = box(selector);
        return rect ? round(rect.height) : null;
      };
      const trigger = document.querySelector("[data-filter-label] > summary");
      const triggerRect = box("[data-filter-label] > summary");
      const caretRect = box("[data-filter-label] .td-icon-sm");
      const assigneeRect = box("[data-filter-assignee]");
      return {
        assignee: height("[data-filter-assignee]"),
        priority: height("[data-filter-priority]"),
        status: height("[data-filter-status] > summary"),
        label: height("[data-filter-label] > summary"),
        // How far the label control is off the selects' own line — the second
        // half of "排版未对齐": the two selects' wrappers used to carry a stray
        // bottom margin that floated them 6px above the row's centre.
        lineOffset: triggerRect && assigneeRect ? round(Math.abs(triggerRect.top - assigneeRect.top)) : null,
        carets: document.querySelectorAll("[data-filter-label] .td-icon-sm").length,
        caret: caretRect && triggerRect ? {
          width: round(caretRect.width),
          height: round(caretRect.height),
          fromPaddingBoxRight: round(triggerRect.right - Number.parseFloat(getComputedStyle(trigger).borderRightWidth) - caretRect.right),
          fromBorderBoxRight: round(triggerRect.right - caretRect.right),
          centreDelta: round(Math.abs((caretRect.top + caretRect.bottom) / 2 - (triggerRect.top + triggerRect.bottom) / 2)),
        } : null,
      };
    });
    r9Check(
      controls.assignee !== null &&
        controls.assignee === controls.priority &&
        controls.assignee === controls.status &&
        controls.assignee === controls.label,
      `the four filter controls are ${controls.assignee}/${controls.priority}/${controls.status}/${controls.label}px tall — they must be equal`,
    );
    r9Check(controls.lineOffset !== null && controls.lineOffset <= 1, `the label control is ${controls.lineOffset}px off the selects' line`);
    r9Check(controls.carets === 1, `${controls.carets} carets inside the trigger, expected 1`);
    r9Check(controls.caret !== null && controls.caret.width === 14 && controls.caret.height === 14, `the caret is ${controls.caret?.width}×${controls.caret?.height}, expected 14×14`);
    r9Check(controls.caret?.fromPaddingBoxRight === 6, `the caret sits ${controls.caret?.fromPaddingBoxRight}px from the padding box, expected 6`);
    r9Check(controls.caret?.fromBorderBoxRight === 7, `the caret sits ${controls.caret?.fromBorderBoxRight}px from the border box, expected 7`);
    r9Check(controls.caret?.centreDelta <= 1, `the caret is ${controls.caret?.centreDelta}px off the trigger's centre line`);

    // ③ — the two states, sampled from inside the read. `[data-skeleton]` and
    // `[data-list-rows]` are counted *as the pair they are*: at every instant
    // exactly one of them is on screen (B9, contract C′4 — the state and the
    // skeleton's `hidden` are one write, so they are read as one).
    const readListPair = () =>
      page.evaluate(() => {
        const list = document.querySelector("[data-list]");
        const skeleton = document.querySelector("[data-skeleton]");
        const rows = document.querySelector("[data-list-rows]");
        const display = (el) => (el ? getComputedStyle(el).display : null);
        return {
          state: list?.getAttribute("data-list-state") ?? null,
          skeletonHidden: skeleton?.hasAttribute("hidden") ?? null,
          skeletonDisplay: display(skeleton),
          rowsDisplay: display(rows),
          rowChildren: rows ? rows.children.length : null,
          visiblePair: [skeleton, rows].filter((el) => el && getComputedStyle(el).display !== "none").length,
        };
      });

    await page.click('[data-view="board"]');
    await page.waitForTimeout(120);

    const runListStates = async (label) => {
      tasksDelayMs = 1200;
      await page.click('[data-view="list"]');
      await page.waitForTimeout(180);
      const loading = await readListPair();
      const loadingResults = await evaluateRuleSet(listLoadingRules);
      tasksDelayMs = 0;
      await waitForListSettled();
      await page.waitForTimeout(120);
      const settled = await readListPair();
      return { label, loading, loadingResults, settled };
    };

    const listEn = await runListStates("en");
    r9Check(listEn.loading.state === "loading", `in flight: data-list-state is ${listEn.loading.state}`);
    r9Check(listEn.loading.skeletonHidden === false && listEn.loading.skeletonDisplay === "block", "in flight: the skeleton is not the visible half");
    r9Check(listEn.loading.rowsDisplay === "none", `in flight: the rows' host is ${listEn.loading.rowsDisplay}`);
    r9Check(listEn.loading.rowChildren === 0, `in flight: the rows' host holds ${listEn.loading.rowChildren} child(ren), expected none`);
    r9Check(listEn.loading.visiblePair === 1, `in flight: ${listEn.loading.visiblePair} halves are visible, expected 1`);
    r9Check(listEn.settled.state === "data", `settled: data-list-state is ${listEn.settled.state}`);
    r9Check(listEn.settled.skeletonHidden === true && listEn.settled.skeletonDisplay === "none", "settled: the skeleton is not the hidden half");
    r9Check(listEn.settled.rowsDisplay === "block", `settled: the rows' host is ${listEn.settled.rowsDisplay}`);
    r9Check(listEn.settled.rowChildren >= 1, `settled: the rows' host holds ${listEn.settled.rowChildren} child(ren), expected at least one`);
    r9Check(listEn.settled.visiblePair === 1, `settled: ${listEn.settled.visiblePair} halves are visible, expected 1`);

    // C9 — the copy changes with the language; the state machine does not.
    await page.evaluate(() => document.querySelector('[data-lang-option="zh"]')?.click());
    await page.waitForTimeout(150);
    await page.click('[data-view="board"]');
    await page.waitForTimeout(120);
    const listZh = await runListStates("zh");
    r9Check(listZh.loading.state === "loading" && listZh.loading.visiblePair === 1, "zh: the in-flight state is not the loading half alone");
    r9Check(listZh.settled.state === "data" && listZh.settled.visiblePair === 1, "zh: the settled state is not the data half alone");
    r9Check(listZh.settled.rowChildren >= 1, "zh: the settled list has no rows");
    // …and the contract's own `when: "list loading"` rules. The English run's
    // records join `results` below, so they are counted and gated with every
    // other rule; the Chinese run's are checked here, where the second window
    // lives.
    for (const failure of listZh.loadingResults.filter((record) => !record.ok)) {
      r9Check(false, `zh · loading rule ${failure.block} ${failure.kind} ${failure.selector ?? failure.probe} — ${failure.detail}`);
    }
    await page.evaluate(() => document.querySelector('[data-lang-option="en"]')?.click());
    await page.waitForTimeout(150);
    await page.click('[data-view="board"]');
    await page.waitForTimeout(120);

    // ---- R10 · the board's own empty state, the drawer's saves, the fill -----
    //
    // Three of the round's facts a document probe cannot state: which of the two
    // board members is *painted* at one instant (a relation between two elements,
    // and one a parent's `display: none` does not change — contract §1 rule 4),
    // that a live edit moves the drawer's save state (an event), and where the
    // description's editor actually ends (geometry against its own row). They are
    // measured here, next to the declarable rules the contract now carries.
    const r10Failures = [];
    const r10Check = (ok, message) => { if (!ok) r10Failures.push(message); };

    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);

    /** The board view: its state, its two members, and what is drawn. */
    const readBoardView = () =>
      page.evaluate(() => {
        const view = document.querySelector("[data-board-view]");
        const board = document.querySelector("[data-board]");
        const empty = document.querySelector('[data-empty][data-empty-kind="no-results"]');
        const round = (n) => Math.round(n * 100) / 100;
        const rect = (el) => (el ? el.getBoundingClientRect() : null);
        const display = (el) => (el ? getComputedStyle(el).display : null);
        const painted = (el) => (el ? el.getClientRects().length > 0 : false);
        return {
          state: view?.getAttribute("data-board-state") ?? null,
          bothAreChildren: !!view && !!board && !!empty && board.parentElement === view && empty.parentElement === view,
          emptyParentIsColumn: empty?.closest("[data-column-body]") !== null,
          // `computed display` is the right instrument only for the two elements
          // the state rule writes directly …
          visibleMembers: [board, empty].filter((el) => el && getComputedStyle(el).display !== "none").length,
          boardDisplay: display(board),
          emptyDisplay: display(empty),
          // … and for their descendants the drawn-box count is the only one that
          // means anything (contract C′1).
          paintedColumns: [...document.querySelectorAll("[data-board] [data-column]")].filter(painted).length,
          viewHeight: round(rect(view)?.height ?? 0),
          boardHeight: round(rect(board)?.height ?? 0),
          mainHeight: round(rect(document.querySelector("main"))?.height ?? 0),
          // T-20261013-015627 — the height `main` actually leaves for the view.
          // `main` now carries the design's own content inset (DESIGN §4
          // "Content padding 20px 24px"), so the view fills main's **content
          // box minus the filter row and the row gap**, not main's border box.
          mainInner: (() => {
            const m = document.querySelector("main");
            if (!m) return 0;
            const cs = getComputedStyle(m);
            const f = document.querySelector("[data-filters]");
            const filtersH = f && getComputedStyle(f).display !== "none" ? rect(f).height : 0;
            const gap = filtersH > 0 ? parseFloat(cs.rowGap) || 0 : 0;
            return round(m.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - filtersH - gap);
          })(),
          mainScrollH: (() => { const m = document.querySelector("main"); return m ? m.scrollHeight : 0; })(),
          firstColumnHeight: round(rect(document.querySelector("[data-column]"))?.height ?? 0),
          cards: document.querySelectorAll("[data-board] [data-card]").length,
        };
      });

    const boardRest = await readBoardView();
    r10Check(boardRest.state === "data", `at rest the board view is in state ${boardRest.state}`);
    r10Check(boardRest.bothAreChildren, "the board and the no-results block must both be children of the view root");
    r10Check(boardRest.emptyParentIsColumn === false, "the board-level no-results block sits inside a column body");
    r10Check(boardRest.visibleMembers === 1, `at rest ${boardRest.visibleMembers} board members are visible, expected 1`);
    r10Check(boardRest.boardDisplay === "flex" && boardRest.emptyDisplay === "none", `at rest the members are ${boardRest.boardDisplay}/${boardRest.emptyDisplay}`);
    r10Check(boardRest.paintedColumns === 7, `at rest ${boardRest.paintedColumns} columns are drawn, expected 7`);
    // The wrapper is a pass-through, not a box of its own height: the board
    // fills the view and the view takes the space `main` leaves for it. A block
    // container here hands the board its content height instead — measured at
    // 331.56px on the prototype, which is what the contract's R4 forbids (itself
    // a regression, since the columns' own scrollers go with it).
    //
    // T-20261013-015627 — the second clause used to read `board ≈ main`, which
    // held only because `main` had **no** content inset and the board therefore
    // overflowed it by the filter row's height (the board's bottom 49px hung
    // below main's box at rest, and `main` scrolled). `main` now states the
    // design's own `20px 24px` (DESIGN §4), so the box that the view fills is
    // main's content box **less the filter row and the row gap** — the same
    // relation stated against the layout that now exists.
    r10Check(
      Math.abs(boardRest.boardHeight - boardRest.viewHeight) <= 1 && Math.abs(boardRest.viewHeight - boardRest.mainInner) <= 1,
      `the view is ${boardRest.viewHeight}px and the board ${boardRest.boardHeight}px, filling the ${boardRest.mainInner}px the ${boardRest.mainHeight}px main leaves`,
    );
    // …and the column of blocks fits: main must not scroll at rest. Before the
    // inset moved to main the board's own bottom sat below main's box, so main
    // was a scroller whose last 49px were only reachable by scrolling.
    r10Check(
      boardRest.mainScrollH <= boardRest.mainHeight + 1,
      `main scrolls at rest: content ${boardRest.mainScrollH}px in a ${boardRest.mainHeight}px box`,
    );
    r10Check(
      boardRest.boardHeight > boardRest.firstColumnHeight + 1,
      `the board is ${boardRest.boardHeight}px and a column ${boardRest.firstColumnHeight}px — the board has collapsed to its content`,
    );

    // C-2/C-3 — a filter that matches nothing, then cleared. The state, the two
    // members' visibility and the drawn columns are read as one record, because
    // they are written as one.
    await page.fill("[data-search-input]", "zzz-no-such-card");
    await page.waitForTimeout(200);
    const filteredOut = await readBoardView();
    r10Check(filteredOut.state === "empty", `filtered to nothing: the state is ${filteredOut.state}`);
    r10Check(filteredOut.visibleMembers === 1, `filtered to nothing: ${filteredOut.visibleMembers} members visible, expected 1`);
    r10Check(filteredOut.boardDisplay === "none" && filteredOut.emptyDisplay === "flex", `filtered to nothing: the members are ${filteredOut.boardDisplay}/${filteredOut.emptyDisplay}`);
    r10Check(filteredOut.paintedColumns === 0, `filtered to nothing: ${filteredOut.paintedColumns} columns are still drawn`);

    await page.fill("[data-search-input]", "");
    await page.waitForTimeout(200);
    const cleared = await readBoardView();
    r10Check(cleared.state === "data" && cleared.paintedColumns === 7 && cleared.visibleMembers === 1, `after clearing: ${cleared.state}/${cleared.paintedColumns}/${cleared.visibleMembers}`);

    // Terry's own case: a project with **no cards at all**. The fixture's second
    // project owns none, so this is the `total === 0` path the old condition
    // missed — the seven bare columns with "No tasks" in each and the board-level
    // empty state hidden behind them.
    await page.click("[data-project-switcher] > summary");
    await page.waitForTimeout(150);
    await page.click('[data-project-option="Orchestrator"]');
    await page.waitForTimeout(500);
    const trulyEmpty = await readBoardView();
    r10Check(trulyEmpty.cards === 0, `the empty project still draws ${trulyEmpty.cards} cards`);
    r10Check(trulyEmpty.state === "empty", `an empty project leaves the board view in state ${trulyEmpty.state}`);
    r10Check(trulyEmpty.visibleMembers === 1 && trulyEmpty.emptyDisplay === "flex", `an empty project shows ${trulyEmpty.visibleMembers} members (${trulyEmpty.emptyDisplay})`);
    r10Check(trulyEmpty.paintedColumns === 0, `an empty project draws ${trulyEmpty.paintedColumns} columns`);

    // …and back, so every check after this one runs on the populated board.
    await page.click("[data-project-switcher] > summary");
    await page.waitForTimeout(150);
    await page.click('[data-project-option="MeerkatTaskPanel"]');
    await page.waitForTimeout(500);
    const restored = await readBoardView();
    r10Check(restored.state === "data" && restored.paintedColumns === 7, `back on the populated project: ${restored.state}/${restored.paintedColumns}`);

    // ② — the drawer's three editable fields commit as they change, through the
    // contract's own C-table. Each step reads the state *and* the alert, because
    // the two are one write and a check on either alone would miss a divergence
    // (contract §8 R5).
    const readSave = () =>
      page.evaluate(() => {
        const save = document.querySelector("[data-detail-save]");
        const alert = document.querySelector("[data-detail-save-error]");
        return {
          state: save?.getAttribute("data-save-state") ?? null,
          alertHidden: alert?.hasAttribute("hidden") ?? null,
          alertDisplay: alert ? getComputedStyle(alert).display : null,
          assigneeText: document.querySelector("[data-detail-assignee-label]")?.value ?? null,
          chips: document.querySelectorAll("[data-detail-label-chip]").length,
        };
      });
    /** The state after a commit: `saving` and `saved` both count as "left `idle`". */
    const movedOffIdle = (save) => save.state === "saving" || save.state === "saved";
    /** …and the alert is off in every state but `error`. */
    const alertAgrees = (save) => (save.state === "error" ? save.alertHidden === false : save.alertHidden === true);

    await page.click("[data-card]");
    await page.waitForTimeout(300);
    const drawerRest = await readSave();
    r10Check(drawerRest.state === "idle", `opening a card leaves the save state at ${drawerRest.state}`);
    r10Check(alertAgrees(drawerRest), `the alert is ${drawerRest.alertHidden} in state ${drawerRest.state}`);
    r10Check(drawerRest.assigneeText !== "", "the assignee field does not show the card's assignee");

    // C-14 — typing alone is not a commit: there is no focus loss and no choice.
    await page.click("[data-detail-assignee-label]");
    await page.fill("[data-detail-assignee-label]", "linus");
    await page.waitForTimeout(150);
    const typed = await readSave();
    r10Check(typed.state === "idle", `typing into a field moved the save state to ${typed.state}`);

    // C-6/C-7 — focus loss commits, and one settle returns it to `idle`.
    await page.evaluate(() => document.querySelector("[data-detail-assignee-label]").blur());
    await page.waitForTimeout(120);
    const blurred = await readSave();
    r10Check(movedOffIdle(blurred), `leaving an edited field left the save state at ${blurred.state}`);
    r10Check(alertAgrees(blurred), `the alert is ${blurred.alertHidden} in state ${blurred.state}`);
    await page.waitForTimeout(700);
    const settled = await readSave();
    r10Check(settled.state === "idle", `after one settle the save state is ${settled.state}`);
    r10Check(alertAgrees(settled), `after one settle the alert is ${settled.alertHidden}`);

    // C-8 — accepting a roster row is the other half of the single-valued commit.
    // The option is addressed inside the drawer's own control: the create dialog
    // ships the same `data-assignee-*` family (B22), so an unscoped lookup would
    // be reading two controls.
    await page.click("[data-detail-assignee-label]");
    await page.fill("[data-detail-assignee-label]", "jobs");
    await page.waitForTimeout(150);
    await page.click('[data-detail-assignee] [data-assignee-option][data-assignee-value="jobs"]');
    await page.waitForTimeout(120);
    const accepted = await readSave();
    r10Check(movedOffIdle(accepted), `accepting a roster row left the save state at ${accepted.state}`);
    await page.waitForTimeout(700);

    // C-9/C-10 — the label set commits on a chip arriving and on one leaving.
    const chipsBefore = (await readSave()).chips;
    await page.click("[data-detail-label-remove]");
    await page.waitForTimeout(120);
    const removed = await readSave();
    r10Check(removed.chips === chipsBefore - 1, `removing a chip left ${removed.chips} of ${chipsBefore}`);
    r10Check(movedOffIdle(removed), `removing a chip left the save state at ${removed.state}`);
    await page.waitForTimeout(700);
    await page.click("[data-detail-label-input]");
    await page.fill("[data-detail-label-input]", "urgent-ux");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
    const added = await readSave();
    r10Check(added.chips === chipsBefore, `adding a chip left ${added.chips} of ${chipsBefore}`);
    r10Check(movedOffIdle(added), `adding a chip left the save state at ${added.state}`);
    await page.waitForTimeout(700);

    // C-11/C-12 — the blank failure, and the recovery from it. An empty value is
    // the one failure the drawer decides on its own, with no server in the path;
    // it is held until the next commit, so the reader can see why the field did
    // not take.
    await page.click("[data-detail-assignee-label]");
    await page.fill("[data-detail-assignee-label]", "   ");
    await page.evaluate(() => document.querySelector("[data-detail-assignee-label]").blur());
    await page.waitForTimeout(250);
    const failed = await readSave();
    r10Check(failed.state === "error", `a blanked field left the save state at ${failed.state}`);
    r10Check(failed.alertHidden === false && failed.alertDisplay === "block", `the alert is ${failed.alertDisplay} in the error state`);
    await page.waitForTimeout(500);
    const stillFailed = await readSave();
    r10Check(stillFailed.state === "error", `the error state did not hold until the next commit (${stillFailed.state})`);

    await page.click("[data-detail-assignee-label]");
    await page.fill("[data-detail-assignee-label]", "linus");
    await page.evaluate(() => document.querySelector("[data-detail-assignee-label]").blur());
    await page.waitForTimeout(120);
    const recovered = await readSave();
    r10Check(movedOffIdle(recovered) && recovered.alertHidden === true, `recovering left ${recovered.state}/${recovered.alertHidden}`);
    await page.waitForTimeout(700);

    // C-13 — the next card starts clean: the state is reset by the open, not
    // carried over from the last edit.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const otherCard = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-card]")];
      const target = cards.find((card) => card.getAttribute("data-identifier") !== "TD-1") ?? cards[0];
      target.querySelector("[data-card-title]").click();
      return target.getAttribute("data-identifier");
    });
    await page.waitForTimeout(400);
    const reopened = await readSave();
    r10Check(reopened.state === "idle" && reopened.alertHidden === true, `reopening on ${otherCard} left ${reopened.state}/${reopened.alertHidden}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    // ③ — the description fills the column, measured as the relation it is. The
    // editor's bottom lands exactly on the left column's content edge; the only
    // space under it is the dialog's own padding. A fixed-height panes box put
    // 240px between the two.
    //
    // The probes below are scoped to `[data-create-task]` on purpose
    // (T-20261014-212017-4). There are **two** `[data-md-editor]`s in the
    // document since the drawer's Description section grew one, and the drawer
    // renders *before* the dialog in `App.vue`, so a bare `document.querySelector`
    // would measure the drawer's — which is `hidden` at rest and 0px tall.
    await page.click("[data-new-task]");
    await page.waitForTimeout(300);
    const fill = await page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const row = rect("[data-create-two-col]");
      const left = rect("[data-create-left]");
      const editor = rect("[data-create-task] [data-md-editor]");
      const panes = rect("[data-create-task] .td-md-panes");
      const source = rect("[data-create-task] [data-md-source]");
      const rowStyle = row ? getComputedStyle(document.querySelector("[data-create-two-col]")) : null;
      return {
        rowBottom: round(row?.bottom ?? 0),
        rowPaddingBottom: round(Number.parseFloat(rowStyle?.paddingBottom ?? "0")),
        leftBottom: round(left?.bottom ?? 0),
        editorBottom: round(editor?.bottom ?? 0),
        editorHeight: round(editor?.height ?? 0),
        panesHeight: round(panes?.height ?? 0),
        sourceHeight: round(source?.height ?? 0),
        sourceScrolls: (() => {
          const el = document.querySelector("[data-create-task] [data-md-source]");
          return el ? getComputedStyle(el).overflowY : null;
        })(),
      };
    });
    r10Check(
      Math.abs(fill.editorBottom - fill.leftBottom) <= 1,
      `the editor ends at ${fill.editorBottom}px and its column's content at ${fill.leftBottom}px`,
    );
    r10Check(
      Math.abs(fill.rowBottom - fill.editorBottom - fill.rowPaddingBottom) <= 1,
      `the only space under the editor is the dialog's ${fill.rowPaddingBottom}px padding, measured ${Math.round((fill.rowBottom - fill.editorBottom) * 100) / 100}px`,
    );
    // The panes used to be a fixed `clamp(280px, 46vh, 520px)` — 225px as built.
    // Growing past 280 is what says the height now follows the row rather than
    // the viewport; the floor keeps a single-column dialog usable.
    r10Check(fill.panesHeight > 280, `the panes are ${fill.panesHeight}px tall, which the old viewport rule allowed them to exceed anyway`);
    r10Check(Math.abs(fill.sourceHeight - fill.panesHeight) <= 1, `the write side is ${fill.sourceHeight}px inside ${fill.panesHeight}px panes`);
    r10Check(fill.sourceScrolls === "auto", `the write side scrolls as ${fill.sourceScrolls}`);

    // R4 · the containing box, and the **field track** it feeds
    // (T-20261015-215028). The routing column's width *is* the track every
    // combobox menu sizes against (`.td-combo-menu { width: max(100%, 220px) }`
    // resolves `100%` against it), and it is arithmetic, not taste:
    // `(1120 − 2 hairline − 2×20 gutter − 24 gap) / 2.6 = 405.3846`, which the
    // browser snaps to 405.391 on both sides. 1120/20/24 are the prototype's own
    // R4 geometry (`design/prototype/src/input.css`: `.td-modal-box`,
    // `.td-two-col`); `T-20261015-215028` ① measured the track *ratio* identical
    // on the two sides and the box the only difference.
    //
    // This is a **pin, not a description**: the implementation shipped
    // 960/16/16 for several rounds, which put this column at 350px and was
    // invisible to every gate — nothing asserted the box, so nothing reddened
    // when it stopped matching the prototype. Same family as the two relations
    // above: a number the contract states, measured where it can be measured.
    const track = await page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const width = (selector) => round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
      const grid = document.querySelector("[data-create-two-col]");
      const style = grid ? getComputedStyle(grid) : null;
      return {
        panel: width("[data-create-task-panel]"),
        left: width("[data-create-left]"),
        right: width("[data-create-right]"),
        gutter: round(Number.parseFloat(style?.paddingRight ?? "0")),
        gap: round(Number.parseFloat(style?.columnGap ?? "0")),
      };
    });
    r10Check(
      Math.abs(track.right - 405.391) <= 0.5,
      `the routing column is ${track.right}px; the prototype's field track is 405.391px ` +
        `(panel ${track.panel}, gutter ${track.gutter}, column gap ${track.gap})`,
    );
    r10Check(
      Math.abs(track.left / track.right - 1.6) <= 0.005,
      `the create dialog's two tracks are ${track.left}/${track.right}, not the prototype's 1.6 : 1`,
    );

    // …and the same chain one breakpoint down, where there is no neighbour to
    // stretch to: the panes' floor is what keeps the editor usable.
    await page.setViewportSize({ width: 500, height: 900 });
    await page.waitForTimeout(250);
    const narrowFill = await page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const editor = document.querySelector("[data-create-task] [data-md-editor]")?.getBoundingClientRect();
      const panes = document.querySelector("[data-create-task] .td-md-panes")?.getBoundingClientRect();
      const source = document.querySelector("[data-create-task] [data-md-source]")?.getBoundingClientRect();
      const de = document.documentElement;
      return {
        editorHeight: round(editor?.height ?? 0),
        panesHeight: round(panes?.height ?? 0),
        sourceHeight: round(source?.height ?? 0),
        overflow: de.scrollWidth > de.clientWidth + 1,
      };
    });
    r10Check(narrowFill.panesHeight >= 200, `the single-column panes fell to ${narrowFill.panesHeight}px`);
    r10Check(narrowFill.sourceHeight <= narrowFill.panesHeight + 1, `the write side (${narrowFill.sourceHeight}px) overflows its ${narrowFill.panesHeight}px pane`);
    r10Check(narrowFill.overflow === false, "the single-column dialog overflows horizontally");
    await page.click("[data-create-task] [data-modal-close]");
    await page.waitForTimeout(250);
    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);

    // --- B24 · the relation rows and the chips they accept --------------------
    //
    // T-20261014-001418. The design source froze two display rules for the
    // create dialog's Parent / Depends-on fields (`design/prototype/app.js`
    // `comboOptionMarkup` / `addComboChip`, the one `identifierText` cap), and
    // this is the impl-side drive of both:
    //
    //   ① an **option row** names its task as identifier-then-title, the
    //      identifier under the board's single cap and the title on one line,
    //      ellipsised when it does not fit;
    //   ② the accepted value stays **visible in the field** — one chip for the
    //      single-valued parent, one per task for the multi-valued depends-on,
    //      both reading like the row they came from, and the field's clear ✕
    //      still empties the chip and the box together.
    //
    // The menu rows are activated with the event the control listens for
    // (`mousedown`) rather than `page.click`: a row can sit under the dialog's
    // own scroller, and an actionability wait there costs 30s of a harness that
    // has a spawn timeout over it (the same reason the B26 sweep clicks in page).
    const r8cFailures = [];
    const r8cCheck = (ok, message) => { if (!ok) r8cFailures.push(message); };

    // The viewport where the right-hand column is narrow enough that the
    // fixture's 40-character title cannot fit its row.
    //
    // It used to be 980, and — this is the part that changed — that number was
    // never really about the viewport. The popup took its width from its
    // positioning ancestor, which was the *shrink-wrapped* control (172px), so
    // `.td-combo-menu` resolved `max(100%, 220px)` to **220px at every width**:
    // the same row was clipped at 1512 as at 980, and the design lane's 980 was
    // one reading of a viewport-independent fact.
    //
    // T-20261016-113131 puts the control on its track, so the popup now *is* the
    // track (`max(100%, 220px)` with 100% = the control = the field's column) and
    // the clipping is genuinely viewport-dependent: the track is
    // `(width − 98) / 2.6` above 760 (98 = the 2px hairline + 2×20 gutter + 24 gap
    // + the overlay's 2×16 gutter — 114 until T-20261016-130046-2 widened the
    // dialog to the prototype's own box, which moved 980 to 339.23 and 900 to
    // 308.47). At 980 the title fits (0 of 13 rows clipped); at 900 it does not
    // (1 of 13 — the 40-character row needs 248px of a 238px box, so 10px of
    // overflow, measured on the widened track). The assertion below is the design
    // criterion — "a title that does not fit is ellipsised, not wrapped and not
    // lost" — so its breakpoint follows the reading down one rung rather than the
    // assertion being dropped: **980 → 900**.
    // (T-20261015-233122 A6 #5 anticipated exactly this flip and forbade deleting
    // the assertion; the numbers above are the re-derivation it asked for.)
    await page.setViewportSize({ width: 900, height: 900 });
    await page.click("[data-new-task]");
    await page.waitForTimeout(300);

    const chipsAtRest = await page.evaluate(() => {
      const parent = document.querySelector("[data-create-task-parent] [data-parent-chips]");
      return {
        parentContainer: parent !== null,
        parentChips: document.querySelectorAll("[data-parent-chip]").length,
        dependsContainer: document.querySelector("[data-create-task-depends] [data-depends-chips]") !== null,
      };
    });
    r8cCheck(chipsAtRest.parentContainer, "[data-parent-chips] is not in the parent field");
    r8cCheck(chipsAtRest.dependsContainer, "[data-depends-chips] is not in the depends-on field");
    r8cCheck(chipsAtRest.parentChips === 0, `the dialog opens with ${chipsAtRest.parentChips} parent chips, expected 0`);

    await page.click("[data-parent-input]");
    await page.waitForTimeout(250);
    const optionRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-parent-option]")];
      return rows.map((row) => {
        const id = row.querySelector(".td-combo-id");
        const title = row.querySelector(".td-combo-title");
        const cs = title ? getComputedStyle(title) : null;
        return {
          value: row.getAttribute("data-parent-value"),
          idText: id ? (id.textContent ?? "").trim() : null,
          titleText: title ? (title.textContent ?? "").trim() : null,
          titleAttr: row.getAttribute("title"),
          whiteSpace: cs?.whiteSpace ?? null,
          overflow: cs?.overflow ?? null,
          textOverflow: cs?.textOverflow ?? null,
          clipped: title ? title.scrollWidth > title.clientWidth : null,
        };
      });
    });
    r8cCheck(optionRows.length > 0, "the parent menu offers no rows to read");
    for (const row of optionRows) {
      // The fixture's ids are all ≤ 9 characters, so each is below the ten-
      // character cap: the row shows the whole value and gains no ellipsis. A
      // row that still sliced at eight would render `PROJ-000…` and fail here.
      r8cCheck(row.idText === row.value, `the row for ${JSON.stringify(row.value)} renders ${JSON.stringify(row.idText)}`);
      r8cCheck(!(row.idText ?? "").includes("…"), `a ${row.value.length}-character id was truncated: ${JSON.stringify(row.idText)}`);
      r8cCheck(row.titleText === row.titleAttr, `the row for ${JSON.stringify(row.value)} renders ${JSON.stringify(row.titleText)}, its title is ${JSON.stringify(row.titleAttr)}`);
      r8cCheck(row.whiteSpace === "nowrap", `a row's title is ${row.whiteSpace}, expected nowrap`);
      r8cCheck(row.overflow === "hidden", `a row's title overflow is ${row.overflow}, expected hidden`);
      r8cCheck(row.textOverflow === "ellipsis", `a row's title text-overflow is ${row.textOverflow}, expected ellipsis`);
    }
    r8cCheck(
      optionRows.some((row) => row.clipped === true),
      "no option row is actually clipped at 900px — the ellipsis has nothing to fire on",
    );

    // ② — accepting a row puts the task in the field as a chip: identifier (same
    // cap) then title, with a way out of it, and the box hands the display over.
    const chosen = optionRows.find((row) => (row.titleText ?? "").length > 20) ?? optionRows[0];
    await page.evaluate((value) => {
      const row = document.querySelector(`[data-parent-option][data-parent-value="${value}"]`);
      row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }, chosen.value);
    await page.waitForTimeout(200);
    const parentPicked = await page.evaluate(() => {
      const container = document.querySelector("[data-create-task-parent] [data-parent-chips]");
      const chip = container?.querySelector("[data-parent-chip]") ?? null;
      const menu = document.querySelector("[data-parent-menu]");
      return {
        count: container ? container.querySelectorAll("[data-parent-chip]").length : 0,
        mono: chip?.querySelector(".td-mono")?.textContent?.trim() ?? null,
        title: chip?.querySelector(".td-combo-title")?.textContent?.trim() ?? null,
        chipTitle: chip?.getAttribute("title") ?? null,
        value: chip?.getAttribute("data-parent-value") ?? null,
        remove: chip ? chip.querySelector("[data-parent-remove]") !== null : false,
        input: document.querySelector("[data-parent-input]")?.value ?? null,
        menuDisplay: menu ? getComputedStyle(menu).display : null,
      };
    });
    r8cCheck(parentPicked.count === 1, `selecting a parent left ${parentPicked.count} chips, expected exactly 1`);
    r8cCheck(parentPicked.value === chosen.value, `the chip carries ${JSON.stringify(parentPicked.value)}, expected ${JSON.stringify(chosen.value)}`);
    r8cCheck(parentPicked.mono === chosen.value, `the chip's identifier is ${JSON.stringify(parentPicked.mono)}, expected ${JSON.stringify(chosen.value)}`);
    r8cCheck(parentPicked.title === chosen.titleText, `the chip's title is ${JSON.stringify(parentPicked.title)}, expected ${JSON.stringify(chosen.titleText)}`);
    r8cCheck(parentPicked.chipTitle === chosen.titleText, `the chip's title attribute is ${JSON.stringify(parentPicked.chipTitle)}, expected the whole title`);
    r8cCheck(parentPicked.remove, "the parent chip carries no [data-parent-remove]");
    r8cCheck(parentPicked.input === "", `the chip did not take over the display — the box still holds ${JSON.stringify(parentPicked.input)}`);
    r8cCheck(parentPicked.menuDisplay === "none", `the menu is still shown (display: ${parentPicked.menuDisplay}) after a single-valued accept`);

    // The chip's ✕ empties the field on its own, and so does the field's clear
    // control — both leave the container empty and the box empty.
    await page.evaluate(() => {
      document.querySelector("[data-parent-chip] [data-parent-remove]")?.click();
    });
    await page.waitForTimeout(150);
    const afterChipRemove = await page.evaluate(() => ({
      chips: document.querySelectorAll("[data-parent-chip]").length,
      input: document.querySelector("[data-parent-input]")?.value ?? null,
    }));
    r8cCheck(afterChipRemove.chips === 0, `the chip's own ✕ left ${afterChipRemove.chips} chips`);

    await page.evaluate((value) => {
      const row = document.querySelector(`[data-parent-option][data-parent-value="${value}"]`);
      row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }, chosen.value);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const input = document.querySelector("[data-parent-input]");
      input.value = "td";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.click("[data-parent-clear]");
    await page.waitForTimeout(150);
    const afterClear = await page.evaluate(() => {
      const menu = document.querySelector("[data-parent-menu]");
      return {
        chips: document.querySelectorAll("[data-parent-chip]").length,
        input: document.querySelector("[data-parent-input]")?.value ?? null,
        menuDisplay: menu ? getComputedStyle(menu).display : null,
      };
    });
    r8cCheck(afterClear.chips === 0, `[data-parent-clear] left ${afterClear.chips} parent chips`);
    r8cCheck(afterClear.input === "", `[data-parent-clear] left the box holding ${JSON.stringify(afterClear.input)}`);
    r8cCheck(afterClear.menuDisplay === "none", `[data-parent-clear] re-opened the menu (display: ${afterClear.menuDisplay})`);

    // Depends-on is the same reading, many times over: two accepted tasks are
    // two chips, each with the identifier and the title, each removable.
    await page.click("[data-depends-input]");
    await page.waitForTimeout(250);
    const dependsValues = await page.evaluate(() => [...document.querySelectorAll("[data-depends-option]")].map((row) => row.getAttribute("data-depends-value")));
    r8cCheck(dependsValues.length >= 2, `the depends-on menu offers ${dependsValues.length} rows, expected at least 2`);
    for (const value of dependsValues.slice(0, 2)) {
      await page.evaluate((v) => {
        const row = document.querySelector(`[data-depends-option][data-depends-value="${v}"]`);
        row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      }, value);
      await page.waitForTimeout(150);
    }
    const dependsChips = await page.evaluate(() => {
      const container = document.querySelector("[data-create-task-depends] [data-depends-chips]");
      const chips = [...(container?.querySelectorAll("[data-depends-chip]") ?? [])];
      return chips.map((chip) => ({
        mono: chip.querySelector(".td-mono")?.textContent?.trim() ?? null,
        title: chip.querySelector(".td-combo-title")?.textContent?.trim() ?? null,
        value: chip.getAttribute("data-depends-value"),
        chipTitle: chip.getAttribute("title"),
        remove: chip.querySelector("[data-depends-remove]") !== null,
      }));
    });
    r8cCheck(dependsChips.length === 2, `accepting two depends-on tasks left ${dependsChips.length} chips`);
    for (const chip of dependsChips) {
      r8cCheck(chip.mono === chip.value, `a depends-on chip's identifier is ${JSON.stringify(chip.mono)}, expected ${JSON.stringify(chip.value)}`);
      r8cCheck(!(chip.mono ?? "").includes("…"), `a ${chip.value?.length}-character id was truncated in a chip: ${JSON.stringify(chip.mono)}`);
      r8cCheck(typeof chip.title === "string" && chip.title.length > 0, `a depends-on chip carries no title: ${JSON.stringify(chip)}`);
      r8cCheck(chip.chipTitle === chip.title, `a depends-on chip's title attribute is ${JSON.stringify(chip.chipTitle)}, expected the whole title`);
      r8cCheck(chip.remove, "a depends-on chip carries no [data-depends-remove]");
    }
    await page.evaluate(() => {
      document.querySelector("[data-depends-chip] [data-depends-remove]")?.click();
    });
    await page.waitForTimeout(150);
    const dependsLeft = await page.evaluate(() => document.querySelectorAll("[data-depends-chip]").length);
    r8cCheck(dependsLeft === 1, `removing one depends-on chip left ${dependsLeft}`);

    await page.click("[data-create-task] [data-modal-close]");
    await page.waitForTimeout(250);
    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);

    // --- B24 · the parent control on its field's whole track --------------------
    //
    // T-20261016-113131. The **geometry** half of the seven structural rules the
    // contract states for this control (B24), read at the two viewports the
    // design lane measured the defect at (T-20261015-233122 §①).
    //
    // Everything here is written against `track` — the width of the field group
    // itself — and never against a literal 405.391. That is not tidiness: the
    // track is the one reading the prototype and the implementation already
    // agree on, so a constant would make the identity below true by
    // construction and hide the very defect the leg exists to catch. The defect
    // was never the track; it was that the control inside it ignored it.
    //
    // Why not in the contract layer: B24's rules carry no `when`, so they
    // evaluate in the **board** state, where the create dialog is `hidden` and
    // every `getBoundingClientRect` reads 0 — a box rule there would fail on
    // `0 != 405.391` for reasons that have nothing to do with the layout. And a
    // *computed-width* rule is worse than useless here: before this change the
    // box computes to `flex: 1 1 auto`, i.e. `width: auto`, `parseFloat → NaN`,
    // and `Math.abs(NaN − 405.391) > 0.5` is **false** — the rule passes
    // silently, which is exactly how the bug survived (T-20261015-233122 §③.4).
    const round2 = (n) => Math.round(n * 100) / 100;
    const near = (a, b) => Math.abs(a - b) <= 0.5;

    /** Open a fresh dialog at a viewport and read the parent field twice. */
    const parentTrackAt = async (width, height) => {
      await page.setViewportSize({ width, height });
      await page.click("[data-new-task]");
      await page.waitForTimeout(300);
      const read = () =>
        page.evaluate(() => {
          const r = (n) => Math.round(n * 100) / 100;
          const group = document.querySelector("[data-create-task-parent]");
          const row = document.querySelector(".td-combo-field");
          const input = document.querySelector("[data-parent-input]");
          const clear = document.querySelector("[data-parent-clear]");
          const menu = document.querySelector("[data-parent-menu]");
          const track = group.getBoundingClientRect();
          const box = input.getBoundingClientRect();
          const cross = clear.getBoundingClientRect();
          return {
            track: r(track.width),
            trackRight: r(track.right),
            gap: row ? Number.parseFloat(getComputedStyle(row).columnGap) : null,
            input: r(box.width),
            clearDisplay: getComputedStyle(clear).display,
            clearWidth: r(cross.width),
            clearHeight: r(cross.height),
            clearRight: r(cross.right),
            menuDisplay: getComputedStyle(menu).display,
            menuWidth: r(menu.getBoundingClientRect().width),
          };
        });
      // A true rest: the dialog's `reset()` clears the form, but the box's own
      // query lives in the control, which is never unmounted (the dialog is
      // toggled by `hidden`) — so a query left behind by an earlier pass
      // survives the reopen and the field is not empty. Empty it by hand rather
      // than assert on whatever the previous leg typed.
      await page.evaluate(() => {
        const input = document.querySelector("[data-parent-input]");
        input.focus(); // a `blur()` on an unfocused input fires nothing, and the menu would stay open
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.blur();
      });
      await page.waitForTimeout(150);
      const rest = await read();
      // Type into the box. The field now carries a value, so the ✕ is drawn —
      // and the menu is open, which is the only state its width can be read in.
      await page.evaluate(() => {
        const input = document.querySelector("[data-parent-input]");
        input.focus();
        input.value = "td";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(200);
      const valued = await read();
      await page.click("[data-create-task] [data-modal-close]");
      await page.waitForTimeout(250);
      return { rest, valued };
    };

    const parentTrackReadings = {};
    for (const [label, width, height] of [["1512×950", 1512, 950], ["980×900", 980, 900]]) {
      const { rest, valued } = await parentTrackAt(width, height);
      parentTrackReadings[label] = { rest, valued };
      r8cCheck(rest.track > 0, `at ${label} the parent field group measures ${rest.track}px — the dialog did not lay out`);
      // Rest: the box takes the whole track, and an empty field draws no ✕.
      r8cCheck(near(rest.input, rest.track), `at ${label} the empty box is ${rest.input}px inside a ${rest.track}px track`);
      r8cCheck(rest.clearDisplay === "none", `at ${label} the ✕ is drawn (display: ${rest.clearDisplay}) on an empty field`);
      // The identity — the arithmetic the prototype's own numbers satisfy.
      r8cCheck(rest.gap === 4, `at ${label} the field row's gap is ${rest.gap}px, expected 4`);
      r8cCheck(
        near(valued.input + valued.gap + valued.clearWidth, valued.track),
        `at ${label} the valued field is ${valued.input} + ${valued.gap} + ${valued.clearWidth} = ${round2(valued.input + valued.gap + valued.clearWidth)}px against a ${valued.track}px track`,
      );
      r8cCheck(valued.clearDisplay !== "none", `at ${label} the ✕ is not drawn (display: ${valued.clearDisplay}) on a field that carries a value`);
      // The ✕ itself: the 20×20 box, its right edge on the track's right edge.
      r8cCheck(near(valued.clearWidth, 20) && near(valued.clearHeight, 20), `at ${label} the ✕ box is ${valued.clearWidth}×${valued.clearHeight}, expected 20×20`);
      r8cCheck(near(valued.clearRight, valued.trackRight), `at ${label} the ✕'s right edge is at ${valued.clearRight}, the track's at ${valued.trackRight}`);
      // The popup: positioned from the control, so it is as wide as the track.
      r8cCheck(valued.menuDisplay !== "none", `at ${label} the parent menu is not open (display: ${valued.menuDisplay})`);
      r8cCheck(near(valued.menuWidth, valued.track), `at ${label} the menu is ${valued.menuWidth}px wide against a ${valued.track}px track`);
    }

    // --- R12 · the filters bar's one line, and the board's equal-height chain ---
    //
    // `design/fidelity-r12-supplement.md` §5.4 hands this leg the assertions the
    // other three cannot state. The A leg (the manifest) has the six-word
    // vocabulary and no visibility, row-count or geometry predicate, the B leg
    // reads one element's computed style at a time, and the C leg only lights
    // differences up — so "how many rows", "is this control drawn", "are these
    // four boxes the same height", "does the count end on the bar's content
    // edge", "did the row move with the viewport" and every board-side geometry
    // (B2/B3/B4/B8/B9/B10) are decided here or nowhere. Ruling R-6a is the
    // reason the split is drawn this way rather than by subject.
    //
    // Every check names its contract id, so the mapping from §5 to this section
    // is one line per assertion. `ALL_TIERS` is the contract's own five at 900,
    // extended with the §5.0 target viewport `ELON_WIDE` (1512×950) so the
    // "≥1512×950" relation is a routine machine check rather than a hand
    // measurement (U-4 / D-7); B4 adds the 1512×700 adapt tier.
    const r12Failures = [];
    const r12Check = (ok, message) => { if (!ok) r12Failures.push(message); };

    /** One tier's raw readings. Judgements stay in Node so each one can speak. */
    const measureR12 = () => page.evaluate(() => {
      const r2 = (n) => Math.round(n * 100) / 100;
      const painted = (el) => !!el && el.getClientRects().length > 0;
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      const round = (rect) => (rect ? { left: r2(rect.left), right: r2(rect.right), top: r2(rect.top), height: r2(rect.height) } : null);

      /** The bar's **closed set** (contract §2.1 / A1 / A10). */
      const FAMILY = [
        "[data-filter-assignee]",
        "[data-filter-priority]",
        "[data-filter-status]",
        "[data-filter-label]",
        "[data-filter-clear]",
        "[data-filter-count]",
      ];
      /**
       * What counts as a *control* for the closed-set check (A1/A10).
       *
       * Not "every painted child of the bar", and not "every painted element in
       * it": a filter control is not always one element. The label filter is a
       * `<details>` carrying its own `<summary>` trigger *and* a menu of option
       * buttons — all of them controls, none of them a new filter — so a naive
       * count reads five extra families into any bar that has a dropdown. A
       * control is a form/interactive element, and it is inside the closed set
       * when it wears a family hook itself **or** sits inside one; a fifth
       * control, anywhere in the bar, has no family ancestor and is reported.
       */
      const CONTROL = "select, button, input, textarea, a, details, summary, "
        + '[role="button"], [role="listbox"], [role="combobox"], [role="menu"], [role="switch"]';

      const bar = document.querySelector("[data-filters]");
      const withinBar = (el) => el.closest("[data-filters]") === bar;
      const out = { docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      if (bar) {
        const bcs = getComputedStyle(bar);
        const barRect = bar.getBoundingClientRect();
        // "Visible child" = painted **and** not `.td-sr` (contract §1.2 rule 6):
        // the visually-hidden label is a 1×1 clipped box whose getClientRects()
        // is *not* empty, so a pure painted-count would read it as a control.
        const kids = [...bar.children].filter((el) => painted(el) && !el.classList.contains("td-sr"));
        // Row count = the distinct **line centres** of the controls, not their
        // `top`s (contract §1.2 rule 7): under `align-items: center` one line's
        // controls share a centre while their tops differ by the height gap
        // (32px select vs 28px `btn-sm`).
        const centers = kids
          .map((el) => { const r = el.getBoundingClientRect(); return r2(r.top + r.height / 2); })
          .sort((a, b) => a - b);
        const rows = centers.filter((c, i) => i === 0 || c - centers[i - 1] > 1).length;
        // The family's control boxes, in **document** order (the gap check is
        // between neighbours, so the order has to be the document's, not the
        // list's). A `<details>` control is measured at its `<summary>`.
        const familyBoxes = FAMILY
          .flatMap((sel) => [...bar.querySelectorAll(sel)])
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .map((el) => {
            const control = el.tagName === "DETAILS" ? (el.querySelector("summary") ?? el) : el;
            const hook = FAMILY.find((sel) => el.matches(sel));
            return { hook, painted: painted(el), rect: round(box(control)) };
          });
        // Adjacent same-line box gaps (contract §2.2 间距). The pair that *ends*
        // at the count is deliberately skipped: its left margin is `auto` by
        // contract §2.1, which is A7's business and not an 8px rhythm.
        const gaps = [];
        for (let i = 1; i < familyBoxes.length; i++) {
          const a = familyBoxes[i - 1];
          const b = familyBoxes[i];
          if (!a.painted || !b.painted || !a.rect || !b.rect) continue;
          const sameLine = Math.abs((a.rect.top + a.rect.height / 2) - (b.rect.top + b.rect.height / 2)) <= 1;
          gaps.push({ pair: `${a.hook} -> ${b.hook}`, gap: r2(b.rect.left - a.rect.right), sameLine, endsAtCount: b.hook === "[data-filter-count]" });
        }
        const count = bar.querySelector("[data-filter-count]");
        out.filters = {
          flexWrap: bcs.flexWrap,
          flexDirection: bcs.flexDirection,
          alignItems: bcs.alignItems,
          gap: bcs.gap,
          overflowX: bcs.overflowX,
          overflowY: bcs.overflowY,
          minWidth: bcs.minWidth,
          padding: [bcs.paddingTop, bcs.paddingRight, bcs.paddingBottom, bcs.paddingLeft],
          scrollWidth: bar.scrollWidth,
          clientWidth: bar.clientWidth,
          scrolls: bar.scrollWidth > bar.clientWidth,
          rows,
          centers,
          gaps,
          // The count's geometric right-edge pin (§1.2 rule 5 — `margin-left:
          // auto` reads back as a *used* px value, so only the geometry judges).
          contentRight: r2(barRect.right - parseFloat(bcs.paddingRight)),
          countRight: count ? r2(count.getBoundingClientRect().right) : null,
          countPainted: painted(count),
          clearPainted: painted(bar.querySelector("[data-filter-clear]")),
          // A5 — the field family's heights (status is in the roster but may be
          // absent until E1-2 lands, so the *present* members are compared).
          familyHeights: ["[data-filter-assignee]", "[data-filter-priority]", "[data-filter-status] > summary", "[data-filter-label] > summary"]
            .map((sel) => bar.querySelector(sel))
            .filter(Boolean)
            .map((el) => r2(el.getBoundingClientRect().height)),
          // A1/A10 — the closed set: a painted control inside the bar that is
          // neither a family member nor inside one.
          strays: [...bar.querySelectorAll(CONTROL)].filter(
            (el) => withinBar(el) && painted(el) && !FAMILY.some((sel) => el.matches(sel)) && !FAMILY.some((sel) => el.closest(sel)),
          ).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/)[0]}` : ""}`),
        };
      }

      const board = document.querySelector("[data-board]");
      if (board) {
        const bcs = getComputedStyle(board);
        const boardRect = board.getBoundingClientRect();
        // The board's **content box** height: what an `align-items: stretch` line
        // hands its items (flex stretch resolves against the content box, so the
        // board's own 4px bottom padding is *not* part of the columns' height).
        const contentH = r2(boardRect.height - parseFloat(bcs.paddingTop) - parseFloat(bcs.paddingBottom));
        const cols = [...board.querySelectorAll("[data-column]")];
        const parts = cols.map((col) => {
          const body = col.querySelector("[data-column-body]");
          const header = col.querySelector("[data-column-header]");
          const progress = col.querySelector("[data-column-progress]");
          const h = (el) => (el ? el.getBoundingClientRect().height : 0);
          return {
            height: r2(col.getBoundingClientRect().height),
            bodyHeight: r2(h(body)),
            // B8's natural content height: header + progress + the body's own
            // scroll extent. Every column's box height must exceed it — that is
            // what says the equal heights came from stretching and not from
            // "every column collapsed to its own content".
            natural: r2(h(header) + h(progress) + (body ? body.scrollHeight : 0)),
            cards: [...col.querySelectorAll("[data-card]")].filter(painted).length,
            // B9 counts the column's *own* vertical scrollers: exactly one, and
            // it must be the body.
            scrollers: [...col.querySelectorAll("*")].filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY)).length,
            overflowY: getComputedStyle(col).overflowY,
            bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
          };
        });
        out.board = {
          alignItems: bcs.alignItems,
          contentH,
          columns: parts,
          heights: parts.map((p) => p.height),
          spread: r2(Math.max(...parts.map((p) => p.height)) - Math.min(...parts.map((p) => p.height))),
          offContent: r2(Math.max(...parts.map((p) => Math.abs(p.height - contentH)))),
        };
      }
      return out;
    });

    /**
     * The contract's `ALL_TIERS` (all five, each at 900) **plus** the §5.0 target
     * viewport `ELON_WIDE` (1512×950) — every tier carries its own height, so the
     * 950 stop is judged by the same relational assertions (§3.2) as the 900 ones.
     * `WIDE_TIERS` (no bar overflow ⇒ A7 applies) is still the three widths with
     * free room for the count's `margin-left: auto`; the 1512×950 tier is wide, so
     * it is covered too.
     */
    const R12_TIERS = [
      { width: 1512, height: 900 },
      { width: 1240, height: 900 },
      { width: 980, height: 900 },
      { width: 760, height: 900 },
      { width: 430, height: 900 },
      { width: 1512, height: 950 },
    ];
    const R12_WIDE = [1512, 1240, 980];
    const r12Heights = {};
    /** Each tier's own readings, keyed `WxH`, kept as the ② evidence trail. */
    const r12Tiers = {};
    for (const { width, height } of R12_TIERS) {
      const tier = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(140);
      const m = await measureR12();
      const f = m.filters;
      const b = m.board;

      // A2 / A9 — the bar is one flex line, at every tier including 430. The
      // prototype wraps at 430; that wrap is the defect Terry reported and the
      // one direction this round overrides (Elon ②, R-2).
      r12Check(f.rows === 1, `A2/A9 @${tier}: the filters bar draws ${f.rows} rows, expected 1 (centres ${f.centers.join(", ")})`);
      // A3 — the direction the wrap rule reads (the values are also declared as
      // computed rules; this is the same three read in the round's own pass).
      r12Check(f.flexWrap === "nowrap" && f.flexDirection === "row" && f.alignItems === "center", `A3 @${tier}: the bar is ${f.flexWrap}/${f.flexDirection}/${f.alignItems}`);
      // A4 — the overflow policy is in place…
      r12Check(["auto", "scroll"].includes(f.overflowX) && f.minWidth === "0px", `A4 @${tier}: the bar's overflow policy is ${f.overflowX}/${f.minWidth}`);
      // …and at 430 it is actually doing something: the row has slack to scroll
      // *inside the bar*, while the document still has none (A8/B7 — the two
      // inequalities are the pair that rules out alternative (d)).
      if (width === 430) {
        r12Check(f.scrolls, `A4 @${tier}: the bar has no scrollable slack (scrollWidth ${f.scrollWidth} = clientWidth ${f.clientWidth})`);
      }
      r12Check(m.docOverflow <= 0, `A8/B7 @${tier}: the document overflows horizontally by ${m.docOverflow}px`);
      // A5 — one height across the field family. The absolute is per side (the
      // prototype's 30px, this build's 32px on the 4px grid, R9 ②); the relation
      // is what ports, and it is measured over the members that are present.
      r12Check(new Set(f.familyHeights).size === 1, `A5 @${tier}: the field family is ${JSON.stringify(f.familyHeights)}, not one height`);
      // A6 — the 8px rhythm and the bar's own zero padding.
      r12Check(f.gap === "8px", `A6 @${tier}: the bar's gap is ${f.gap}`);
      r12Check(f.padding.every((p) => p === "0px"), `A6 @${tier}: the bar's padding is ${f.padding.join("/")}`);
      for (const g of f.gaps) {
        if (g.endsAtCount || !g.sameLine) continue;
        r12Check(Math.abs(g.gap - 8) <= 0.5, `A6 @${tier}: the gap ${g.pair} is ${g.gap}px, expected 8px`);
      }
      // A7 — the count ends on the bar's **content** edge, in the tiers where the
      // row still has free space for `margin-left: auto` to resolve into (the
      // contract's U-5: below that, `auto` is 0 and the count follows Clear).
      if (R12_WIDE.includes(width)) {
        r12Check(f.countRight !== null && Math.abs(f.contentRight - f.countRight) <= 1, `A7 @${tier}: the count ends ${f.countRight === null ? "nowhere" : Math.round((f.contentRight - f.countRight) * 100) / 100}px from the bar's content edge`);
      }
      // A11 — a narrow tier may not buy its single line by hiding controls.
      if (width === 430) {
        r12Check(f.countPainted && f.clearPainted, `A11 @${tier}: count/clear painted = ${f.countPainted}/${f.clearPainted}`);
      }
      // A1/A10 — nothing outside the closed set is drawn in the bar.
      r12Check(f.strays.length === 0, `A1/A10 @${tier}: the bar draws controls outside the closed set — ${f.strays.join(", ")}`);

      // B1 — the explicit cross-axis alignment. `items-start` here is exactly the
      // defect the round names: columns then take their own content height.
      r12Check(b.alignItems === "stretch", `B1 @${tier}: [data-board] aligns its columns with ${b.alignItems}`);
      // B6 — the count is constant at seven columns, at every tier. The equal
      // heights above are only meaningful over *these* seven boxes, so the count
      // is asserted here beside them (the A leg owns the `data-status` order).
      r12Check(b.columns.length === 7, `B6 @${tier}: the board draws ${b.columns.length} columns, expected 7`);
      // B2/B3 — seven equal heights, each equal to the board's **content** box.
      r12Check(b.spread <= 1, `B2 @${tier}: the column heights spread ${b.spread}px (${b.heights.join(", ")})`);
      r12Check(b.offContent <= 1, `B3 @${tier}: the tallest column differs from the board's ${b.contentH}px content box by ${b.offContent}px`);
      // B5/B9 — the column is not its own scroller; the body is, and it is the
      // only one inside the column.
      r12Check(b.columns.every((c) => c.overflowY !== "auto" && c.overflowY !== "scroll"), `B5 @${tier}: a column is its own vertical scroller — ${b.columns.map((c) => c.overflowY).join(", ")}`);
      r12Check(b.columns.every((c) => c.bodyOverflowY === "auto"), `B5 @${tier}: the column bodies scroll as ${b.columns.map((c) => c.bodyOverflowY).join(", ")}`);
      r12Check(b.columns.every((c) => c.scrollers === 1), `B9 @${tier}: vertical scrollers per column = ${b.columns.map((c) => c.scrollers).join(", ")}`);
      // B8 — reverse: the equal heights are not "every column collapsed to its
      // content". At least the shortest column's box must exceed the tallest
      // natural content height.
      const shortest = Math.min(...b.heights);
      const tallestNatural = Math.max(...b.columns.map((c) => c.natural));
      r12Check(shortest > tallestNatural, `B8 @${tier}: the shortest column (${shortest}px) is not taller than the tallest natural content (${tallestNatural}px)`);
      // B10 — reverse: the column body has height and the cards are drawn.
      r12Check(b.columns.every((c) => c.bodyHeight > 0), `B10 @${tier}: a column body has height ${b.columns.map((c) => c.bodyHeight).join(", ")}`);
      r12Check(b.columns.every((c) => c.cards >= 1), `B10 @${tier}: a column shows ${b.columns.map((c) => c.cards).join(", ")} cards`);

      // B4's baseline is the **1512×900** tier only — the 950 stop must not
      // overwrite it, or the adapt delta would compare 950 against 700.
      if (width === 1512 && height === 900) r12Heights[width] = b.heights[0];
      r12Tiers[tier] = { rows: f.rows, columns: b.columns.length, contentH: b.contentH, heights: b.heights, spread: b.spread, offContent: b.offContent, docOverflow: m.docOverflow };
    }

    // B4 — the equal-height chain follows the **viewport**, pixel for pixel: the
    // chain states `flex: 1 1 auto` and never a height, so 200px of viewport is
    // 200px of column. A written-in px passes B2/B3 and fails here.
    await page.setViewportSize({ width: 1512, height: 700 });
    await page.waitForTimeout(180);
    const adapt = await measureR12();
    r12Check(adapt.board.spread <= 1 && adapt.board.offContent <= 1, `B4 @1512x700: the columns spread ${adapt.board.spread}px and differ from the board by ${adapt.board.offContent}px`);
    const moved = r12Heights[1512] - adapt.board.heights[0];
    r12Check(Math.abs(moved - 200) <= 1, `B4 @1512x900→700: the column height moved ${Math.round(moved * 100) / 100}px when the viewport height moved 200px`);
    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);

    // --- five viewports, none may overflow horizontally -----------------------
    const viewports = [];
    for (const width of [1512, 1240, 980, 760, 500, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        return { width: de.clientWidth, scrollWidth: de.scrollWidth, ok: de.scrollWidth <= de.clientWidth + 1 };
      });
      viewports.push({ width, ...overflow });
    }

    const interactions = {
      drawerOpened: drawerOpen.state === "open" && drawerOpen.title !== "",
      drawerClosed: drawerClosed === "closed",
      agentSessionHook: drawerOpen.agentSessionHook,
      moveMenuOpened: moveMenu.open && moveMenu.rows === moveMenu.expected,
      themeCycleReturns: themeStart === themeEnd,
      themeRun,
      langZh: langAfterZh === "zh",
      langEn: langAfterEn === "en",
    };

    /* ---- R11 ①/② · R13 — the status filter, the roster press and the assignee
       constraint ---------------------------------------------------------------
       The design contracts' machine checks, ported to the shipped app: R11 §5
       (the status control's domain/order/OR-and-AND semantics) and R13 §10.3
       (the named assignee, the width-neutral capsule, the roster press that only
       narrows). Every assertion is a **data hook + attribute** or a computed
       value — never a class name (R11 §5 C′9, R13 §5.4).

       Two families of the contracts' rows are deliberately not asserted:
       the JS-off rows (R11 A4.x / A8 / C-12) — a Vue SPA has no SSR, the written
       deviation the block contract already records (C06) — and R11's C-6 ("the
       press writes the name into no filter"), which R13 replaced with the
       opposite: the press narrows the assignee. R13 修订（seg3 · 决定甲）then
       narrowed *that* again: the press writes the assignee and **nothing else**
       — no view switch, no status write, no toggle-off — and the bar's `x` is
       withdrawn, leaving the control's own `Assignee: All` row as the removal
       path (design/fidelity-r13.md §10.1/§10.3 C1–C4). */
    const r11Failures = [];
    const r11Check = (ok, message) => { if (!ok) r11Failures.push(message); };

    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(120);
    await page.click('[data-nav-item="board"]');
    if (await page.evaluate(() => document.querySelector("[data-filters]")?.hasAttribute("hidden") === true)) {
      await page.click("[data-filter-toggle]");
      await page.waitForTimeout(120);
    }

    const readR11 = () => page.evaluate(() => {
      const painted = (el) => !!el && el.getClientRects().length > 0;
      const attr = (el, name) => (el ? el.getAttribute(name) : null);
      const items = [...document.querySelectorAll("[data-assignee-item]")];
      const bar = document.querySelector("[data-filters]");
      const childHook = (el) => {
        for (const hook of ["data-filter-assignee", "data-filter-priority",
          "data-filter-status", "data-filter-label", "data-filter-clear", "data-filter-count"]) {
          if (el.hasAttribute(hook)) return hook;
        }
        return el.tagName.toLowerCase();
      };
      const statusRaw = attr(document.querySelector("[data-filter-status]"), "data-filter-status-value") ?? "all";
      // The board's own cards, not the document's: the waiting view renders the
      // same `<Card>` for the awaiting task, so `[data-card]` alone counts it
      // twice (M1's overlay is one card in two surfaces).
      const boardCards = [...document.querySelectorAll("[data-board] [data-card]")];
      const statusSet = statusRaw === "all" ? [] : statusRaw.split(",");
      // R15 ② — the assignee control is a `<details>` now, so its value rides the
      // control's own attribute rather than a form value (a `<details>` has none).
      const name = attr(document.querySelector("[data-filter-assignee]"), "data-filter-assignee-value") || "all";
      const ASSIGNEE_STATIC = ["all", "me", "human", "agent"];
      const assigneeRows = [...document.querySelectorAll("[data-filter-assignee] [data-assignee-filter-option]")]
        .map((el) => attr(el, "data-assignee-filter-option"));
      const priorityRows = [...document.querySelectorAll("[data-filter-priority] [data-filter-priority-option]")];
      // The assignee half alone — the roster press writes only this condition
      // (R13 修订 §10.1 row 1), so the card set it produces is stated without
      // the status conjunct the retired four-step route used to add.
      const assigneeMatches = (el) => {
        const cardName = attr(el, "data-assignee") ?? "";
        const kind = attr(el, "data-assignee-kind");
        if (name === "all") return true;
        if (name === "me") return cardName === "Terry";
        if (name === "human" || name === "agent") return kind === name;
        return cardName === name;
      };
      const cardMatches = (el) => {
        const okStatus = statusSet.length === 0 ? true : statusSet.includes(attr(el, "data-status"));
        return assigneeMatches(el) && okStatus;
      };
      return {
        statusCount: document.querySelectorAll("[data-filter-status]").length,
        statusValue: statusRaw,
        statusText: document.querySelector("[data-filter-status-text]")?.textContent.trim() ?? null,
        optionValues: [...document.querySelectorAll("[data-filter-status-option]")].map((el) => attr(el, "data-status-value")),
        pressedOptions: [...document.querySelectorAll("[data-filter-status-option]")]
          .filter((el) => attr(el, "aria-pressed") === "true").map((el) => attr(el, "data-status-value")),
        optionDots: document.querySelectorAll("[data-filter-status-option][data-status] .td-status-dot").length,
        columnStatuses: [...new Set([...document.querySelectorAll("[data-column][data-status]")].map((el) => attr(el, "data-status")))].sort(),
        cardStatuses: [...new Set(boardCards.map((el) => attr(el, "data-status")))].sort(),
        visibleCardStatuses: boardCards.filter(painted).map((el) => attr(el, "data-status")),
        statusDismiss: !!document.querySelector("[data-filter-status][data-dismiss-on-outside]"),
        dismissCount: document.querySelectorAll("[data-dismiss-on-outside]").length,
        barOrder: bar ? [...bar.children].filter((el) => painted(el) && !el.classList.contains("td-sr")).map(childHook) : [],
        itemNames: items.map((el) => attr(el, "data-assignee-item")),
        nameButtonTags: [...new Set([...document.querySelectorAll("[data-agent-assignee]")].map((el) => el.tagName))],
        buttonsPerItem: items.map((el) => el.querySelectorAll("[data-agent-assignee]").length),
        clearsPerItem: items.map((el) => el.querySelectorAll("[data-assignee-clear]").length),
        activeItems: items.filter((el) => attr(el, "data-assignee-active") === "true").map((el) => attr(el, "data-assignee-item")),
        pressedNames: [...document.querySelectorAll("[data-agent-assignee]")]
          .filter((el) => attr(el, "aria-pressed") === "true").map((el) => attr(el, "data-assignee")),
        // R13 修订 §10.1 row 4 — the `x` is gone document-wide, so this single
        // probe is the whole of its check (count 0 at rest, while a name is in
        // force, and after every click path).
        clearCount: document.querySelectorAll("[data-assignee-clear]").length,
        assigneeValue: name,
        // R15 ② — every assignee row carries `[data-assignee-filter-option]` with
        // **its own value** now (the four static ones included; the `<option>`s
        // and their bare selects are gone), so the given name is whatever the
        // four static values are not.
        assigneeRows,
        staticOptions: assigneeRows.filter((value) => ASSIGNEE_STATIC.includes(value)).length,
        namedOptionValues: assigneeRows.filter((value) => !ASSIGNEE_STATIC.includes(value)),
        assigneeText: document.querySelector("[data-filter-assignee-text]")?.textContent.trim() ?? null,
        assigneeSummaryTag: document.querySelector("[data-filter-assignee-summary]")?.tagName ?? null,
        assigneeDismiss: !!document.querySelector("[data-filter-assignee][data-dismiss-on-outside]"),
        assigneeOpen: document.querySelector("[data-filter-assignee]")?.hasAttribute("open") ?? false,
        currentAssigneeRows: [...document.querySelectorAll('[data-assignee-filter-option][aria-current="true"]')]
          .map((el) => attr(el, "data-assignee-filter-option")),
        priorityValue: attr(document.querySelector("[data-filter-priority]"), "data-filter-priority-value") || "all",
        priorityText: document.querySelector("[data-filter-priority-text]")?.textContent.trim() ?? null,
        priorityDismiss: !!document.querySelector("[data-filter-priority][data-dismiss-on-outside]"),
        priorityOpen: document.querySelector("[data-filter-priority]")?.hasAttribute("open") ?? false,
        priorityRowValues: priorityRows.map((el) => attr(el, "data-priority-value")),
        priorityDots: priorityRows.filter((el) => el.querySelector(".td-status-dot") !== null).length,
        priorityDotColors: priorityRows
          .filter((el) => el.querySelector(".td-status-dot") !== null)
          .map((el) => getComputedStyle(el.querySelector(".td-status-dot")).backgroundColor),
        currentPriorityRows: [...document.querySelectorAll('[data-filter-priority-option][aria-current="true"]')]
          .map((el) => attr(el, "data-priority-value")),
        selectCountInBar: bar.querySelectorAll("select").length,
        b22Options: document.querySelectorAll("[data-assignee-option]").length,
        b22InMenu: [...document.querySelectorAll("[data-assignee-option]")].filter((el) => el.closest("[data-assignee-menu]")).length,
        countText: document.querySelector("[data-filter-count]")?.textContent.trim() ?? null,
        toastChildren: document.querySelector("[data-toast-region]")?.children.length ?? 0,
        listState: attr(document.querySelector("[data-list]"), "data-list-state"),
        listRowCount: document.querySelectorAll("[data-list-rows] [data-list-row]").length,
        listRowStatuses: [...document.querySelectorAll("[data-list-rows] [data-list-status]")].map((el) => attr(el, "data-status")),
        viewCurrent: attr(document.querySelector('[data-nav-item][aria-current="page"]'), "data-nav-item"),
        listPressed: attr(document.querySelector('[data-view="list"]'), "aria-pressed"),
        // The second half of the view indicator (R13 §10.3 C1.2): which tab of
        // the topbar's `[data-view-toggle]` states itself pressed.
        viewPressed: attr(document.querySelector('[data-view-toggle] [data-view][aria-pressed="true"]'), "data-view"),
        boardHidden: document.querySelector("[data-board-view]")?.hasAttribute("hidden") ?? null,
        // The board's rendered card set, read off the same painted cards the
        // board draws — the re-filter the roster press must produce (§10.3 C1.4).
        visibleCardNames: boardCards.filter(painted).map((el) => attr(el, "data-assignee")),
        visibleCardIds: boardCards.filter(painted).map((el) => attr(el, "data-identifier")),
        expectedRows: boardCards.filter(cardMatches).length,
        expectedIds: boardCards.filter(cardMatches).map((el) => `${attr(el, "data-identifier")}/${attr(el, "data-assignee")}/${attr(el, "data-status")}`),
        expectedAssigneeRows: boardCards.filter(assigneeMatches).length,
        expectedAssigneeIds: boardCards.filter(assigneeMatches).map((el) => attr(el, "data-identifier")),
        listIds: [...document.querySelectorAll("[data-list-rows] [data-list-row]")].map((el) => attr(el.querySelector("[data-list-identifier]"), "title") ?? el.textContent.trim()),
        columns: document.querySelectorAll("[data-column]").length,
      };
    });

    /** The roster's geometry: width-neutrality, the capsule and the row heights. */
    const measureRoster = () => page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const hosts = [...document.querySelectorAll("[data-agent-row] [data-agent-text]")];
      const active = document.querySelector('[data-assignee-item][data-assignee-active="true"]');
      const activeName = active?.querySelector("[data-agent-assignee]") ?? null;
      const host = active?.closest("[data-agent-row] [data-agent-text]") ?? null;
      const firstHost = hosts[0] ?? null;
      const firstItem = firstHost?.querySelector("[data-assignee-item]") ?? null;
      const cs = active ? getComputedStyle(active) : null;
      const nameCs = activeName ? getComputedStyle(activeName) : null;
      const hostCs = host ? getComputedStyle(host) : null;
      const railEl = document.querySelector("[data-sidebar]");
      return {
        rows: hosts.map((el) => ({ clip: el.scrollWidth - el.clientWidth, overflow: getComputedStyle(el).overflowX })),
        // The rail's own box. `rows[].clip === 0` above is satisfied by a host
        // that simply *grew*, which is how the roster escaped the rail: the host
        // is a flex item with `overflow: visible`, so its `min-width: auto` floor
        // was its whole one-line run, and the run's right edge landed past the
        // 248px column's `overflow-x: auto` cut. The box the names must actually
        // fit in is this one (T-20261016-130046).
        rail: railEl
          ? { clip: railEl.scrollWidth - railEl.clientWidth, scrollWidth: railEl.scrollWidth, clientWidth: railEl.clientWidth }
          : null,
        rowHeights: [...document.querySelectorAll("[data-agent-row]")].map((el) => round(el.getBoundingClientRect().height)),
        activeCount: document.querySelectorAll('[data-assignee-item][data-assignee-active="true"]').length,
        capsule: cs ? {
          radius: cs.borderTopLeftRadius,
          paddingLeft: cs.paddingLeft,
          paddingRight: cs.paddingRight,
          marginLeft: cs.marginLeft,
          marginRight: cs.marginRight,
          background: cs.backgroundColor,
          borderTopWidth: cs.borderTopWidth,
        } : null,
        nameColor: nameCs?.color ?? null,
        hostOverflow: hostCs?.overflowX ?? null,
        // U-6 — how far the **active** bed bleeds past its own host's padding
        // box, and whether it is the row's first name (the one the prototype
        // sheared 6px off). A positive bleed on a first-in-row item is the 6px
        // the host's `overflow: hidden` would have clipped.
        activeBleed: host && active ? round(host.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(host).paddingLeft) - active.getBoundingClientRect().left) : null,
        activeIsFirst: !!(host && active && host.querySelector("[data-assignee-item]") === active),
        activePainted: !!active && active.getClientRects().length > 0,
        firstItemPainted: !!firstItem && firstItem.getClientRects().length > 0,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--brand-accent").trim(),
        accentSoft: getComputedStyle(document.documentElement).getPropertyValue("--brand-accent-soft").trim(),
        // T-20261017-021412 ② — the comma is the roster's separator, and its
        // correctness is two properties at once:
        //   * **line** — no rendered line may begin with one (`", assistant"`
        //     was what a greedy wrap produced while the separator was a free
        //     text node between items);
        //   * **structure** — the comma belongs to the item whose name it
        //     follows, so it travels with that name across a wrap.
        // Character rects group into lines (the row may wrap); every
        // comma-bearing text node is traced to its nearest element ancestor, and
        // the items' own text is read to see which of them carry the separator.
        separator: (() => {
          const hosts = [...document.querySelectorAll("[data-agent-row] [data-agent-text]")];
          const lineHeads = hosts.map((host) => {
            const chars = [];
            const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (let i = 0; i < node.data.length; i += 1) {
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const rect = range.getBoundingClientRect();
                if (!rect.width && !rect.height) continue;
                chars.push({ ch: node.data[i], x: rect.x, y: Math.round(rect.y) });
              }
            }
            const lines = new Map();
            for (const char of chars) {
              if (!lines.has(char.y)) lines.set(char.y, []);
              lines.get(char.y).push(char);
            }
            return [...lines.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, line]) => line.sort((a, b) => a.x - b.x).map((char) => char.ch).join(""));
          });
          const strayCommas = [];
          const scope = document.querySelector("[data-agents-presence]") ?? document.body;
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.data.includes(",")) continue;
            if (!node.parentElement?.closest("[data-assignee-item]")) strayCommas.push(node.data.trim());
          }
          const items = [...scope.querySelectorAll("[data-assignee-item]")].map((item) => {
            const siblings = [...(item.parentElement?.querySelectorAll(":scope > [data-assignee-item]") ?? [])];
            return {
              name: item.getAttribute("data-assignee-item"),
              endsWithComma: /,\s*$/.test(item.textContent ?? ""),
              last: siblings.at(-1) === item,
            };
          });
          return { lineHeads, strayCommas, items };
        })(),
      };
    });

    const restR11 = await readR11();
    const restRoster = await measureRoster();
    const R11_KEYS = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];

    // T-20261017-021412 ② — the separator is bound to the name it follows.
    // A line-head comma is the visible defect (`", assistant"` alone on a
    // wrapped line); a comma outside `[data-assignee-item]` is its cause, and
    // the per-item separator distribution says the comma is attached to exactly
    // the items that need one (every item but the last).
    for (const [rowIndex, lines] of restRoster.separator.lineHeads.entries()) {
      for (const [lineIndex, text] of lines.entries()) {
        const head = text.trimStart()[0] ?? "";
        r11Check(head !== ",", `roster row ${rowIndex} line ${lineIndex} begins with a comma: ${JSON.stringify(text)}`);
      }
    }
    r11Check(
      restRoster.separator.strayCommas.length === 0,
      `comma text outside [data-assignee-item]: ${JSON.stringify(restRoster.separator.strayCommas)}`,
    );
    r11Check(
      restRoster.separator.items.every((item) => item.endsWithComma === !item.last),
      `roster item separators: ${restRoster.separator.items.map((item) => `${item.name}=${item.endsWithComma ? "comma" : "bare"}${item.last ? "(last)" : ""}`).join(", ")}`,
    );

    // A · structure (R11 §5.1 A1–A3′, R13 §5 A1–A3, R2.1)
    r11Check(restR11.statusCount === 1, `[data-filter-status] count ${restR11.statusCount} !== 1`);
    r11Check(restR11.statusValue === "all", `resting status value ${restR11.statusValue} !== all`);
    r11Check(restR11.statusText === "Status: All", `resting status text ${JSON.stringify(restR11.statusText)}`);
    r11Check(restR11.optionValues.length === 8, `[data-filter-status-option] count ${restR11.optionValues.length} !== 8`);
    r11Check(restR11.optionValues[0] === "all", `the first status row must be \`all\`, got ${restR11.optionValues[0]}`);
    r11Check(
      JSON.stringify(restR11.optionValues.slice(1).sort()) === JSON.stringify([...R11_KEYS].sort()),
      `status option values ${restR11.optionValues.slice(1).join(",")} !== the seven first-class statuses`,
    );
    // A2′ — the domain is the board's own: the menu's seven keys, the seven
    // columns and the cards' own `data-status` are one set. This is the
    // "no magic numbers" check the design states as a set equality.
    r11Check(
      JSON.stringify(restR11.columnStatuses) === JSON.stringify([...R11_KEYS].sort()),
      `[data-column][data-status] ${restR11.columnStatuses.join(",")} !== the seven statuses`,
    );
    r11Check(
      restR11.cardStatuses.every((value) => R11_KEYS.includes(value)),
      `[data-card][data-status] carries ${restR11.cardStatuses.join(",")}`,
    );
    r11Check(restR11.optionDots === 7, `${restR11.optionDots} status dots, expected 7 (one per non-\`all\` row)`);
    r11Check(restR11.pressedOptions.length === 1 && restR11.pressedOptions[0] === "all", `at rest aria-pressed=${restR11.pressedOptions.join(",")}`);
    r11Check(restR11.statusDismiss === true, "[data-filter-status] must join the light-dismiss membership");
    r11Check(
      JSON.stringify(restR11.barOrder) === JSON.stringify(["data-filter-assignee", "data-filter-priority", "data-filter-status", "data-filter-label", "data-filter-clear", "data-filter-count"]),
      `bar order ${restR11.barOrder.join(" · ")}`,
    );
    // R13 修订 A1/A2 — the roster items, one name button each, no `x` at all.
    r11Check(restR11.itemNames.length > 0, "the roster renders no [data-assignee-item]");
    r11Check(restR11.itemNames.length === new Set(restR11.itemNames).size, `duplicate roster names ${restR11.itemNames.join(",")}`);
    r11Check(restR11.buttonsPerItem.every((n) => n === 1), `name buttons per item ${restR11.buttonsPerItem.join(",")}`);
    r11Check(restR11.clearsPerItem.every((n) => n === 0), `the roster must hold no [data-assignee-clear]: ${restR11.clearsPerItem.join(",")}`);
    r11Check(restR11.nameButtonTags.length === 1 && restR11.nameButtonTags[0] === "BUTTON", `roster names are ${restR11.nameButtonTags.join(",")}, expected BUTTON`);
    r11Check(restR11.activeItems.length === 0, `at rest ${restR11.activeItems.length} roster items are active`);
    // R13 修订 A1 — the `x` is withdrawn document-wide (markup/rule/handler/aria):
    // 0 at rest, and 0 at every point a name is in force or the control resets.
    r11Check(restR11.clearCount === 0, `[data-assignee-clear] count ${restR11.clearCount} !== 0`);
    // R13 A3/R2.1 — the control's four static rows, no named option at rest, and
    // B22's bare seats untouched by this round's hook.
    r11Check(restR11.staticOptions === 4, `static assignee options ${restR11.staticOptions} !== 4`);
    r11Check(restR11.namedOptionValues.length === 0, `at rest ${restR11.namedOptionValues.length} named options exist`);
    r11Check(restR11.assigneeValue === "all", `resting assignee value ${restR11.assigneeValue} !== all`);
    r11Check(restR11.b22Options === restR11.b22InMenu, `[data-assignee-option] ${restR11.b22Options} seats, ${restR11.b22InMenu} inside [data-assignee-menu]`);

    // R15 ② · A — the two converted controls are `dropdown` panels, not `<select>`s
    // (design/fidelity-r15.md §2.2): no native select survives in the bar, both
    // controls join the light-dismiss membership, and each summary states the
    // chosen row's own copy. The rows are the domain the document authors — the
    // four static assignee values and `all` plus the five priorities — with
    // `aria-current` on exactly the chosen one, and the priority rows carry the
    // colour dot beside their copy (the ruling's ③).
    r11Check(restR11.selectCountInBar === 0, `R15 ②: ${restR11.selectCountInBar} <select> still in the bar`);
    r11Check(restR11.assigneeDismiss === true && restR11.priorityDismiss === true, "R15 ②: both converted controls must join the light-dismiss membership");
    r11Check(restR11.assigneeSummaryTag === "SUMMARY", `R15 ②: the assignee trigger is <${restR11.assigneeSummaryTag}>, expected <summary>`);
    r11Check(restR11.assigneeText === "Assignee: All", `R15 ②: the assignee trigger states ${JSON.stringify(restR11.assigneeText)}`);
    r11Check(restR11.priorityText === "Priority: All", `R15 ②: the priority trigger states ${JSON.stringify(restR11.priorityText)}`);
    r11Check(
      JSON.stringify(restR11.assigneeRows) === JSON.stringify(["all", "me", "human", "agent"]),
      `R15 ②: the assignee rows are ${restR11.assigneeRows.join(",")}`,
    );
    r11Check(
      JSON.stringify(restR11.priorityRowValues) === JSON.stringify(["all", "urgent", "high", "medium", "low", "none"]),
      `R15 ②: the priority rows are ${restR11.priorityRowValues.join(",")}`,
    );
    r11Check(restR11.priorityDots === 5, `R15 ②: ${restR11.priorityDots} priority dots, expected 5 (one per non-\`all\` row)`);
    r11Check(
      new Set(restR11.priorityDotColors).size === 5,
      `R15 ②: five priorities share ${new Set(restR11.priorityDotColors).size} dot colour(s): ${[...new Set(restR11.priorityDotColors)].join(" | ")}`,
    );
    r11Check(restR11.currentAssigneeRows.length === 1 && restR11.currentAssigneeRows[0] === "all", `R15 ②: assignee aria-current=${restR11.currentAssigneeRows.join(",")}`);
    r11Check(restR11.currentPriorityRows.length === 1 && restR11.currentPriorityRows[0] === "all", `R15 ②: priority aria-current=${restR11.currentPriorityRows.join(",")}`);
    r11Check(restR11.assigneeOpen === false && restR11.priorityOpen === false, "R15 ②: both panels must rest closed");

    // R15 ② · C — the panels really open and choose: a press on the summary
    // paints the menu, a press on a row writes the value, restates the trigger,
    // moves `aria-current` and closes the panel. Clear (B04's own control) is the
    // way back for both.
    await page.click("[data-filter-assignee] > summary");
    await page.waitForTimeout(90);
    const r15Opened = await readR11();
    r11Check(r15Opened.assigneeOpen === true, "R15 ②: pressing the assignee summary must open its panel");
    await page.click('[data-assignee-filter-option="me"]');
    await page.waitForTimeout(150);
    const r15Me = await readR11();
    r11Check(r15Me.assigneeValue === "me", `R15 ②: the menu press wrote ${r15Me.assigneeValue}`);
    r11Check(r15Me.assigneeText === "Assignee: Me", `R15 ②: the trigger states ${JSON.stringify(r15Me.assigneeText)}`);
    r11Check(r15Me.assigneeOpen === false, "R15 ②: choosing closes the panel");
    r11Check(r15Me.currentAssigneeRows.length === 1 && r15Me.currentAssigneeRows[0] === "me", `R15 ②: aria-current rows ${r15Me.currentAssigneeRows.join(",")}`);
    r11Check(r15Me.countText !== restR11.countText, `R15 ②: the count must follow the choice (${JSON.stringify(restR11.countText)} → ${JSON.stringify(r15Me.countText)})`);
    await page.click("[data-filter-priority] > summary");
    await page.waitForTimeout(90);
    await page.click('[data-filter-priority-option][data-priority-value="urgent"]');
    await page.waitForTimeout(150);
    const r15Urgent = await readR11();
    r11Check(r15Urgent.priorityValue === "urgent", `R15 ②: the priority press wrote ${r15Urgent.priorityValue}`);
    r11Check(r15Urgent.priorityText === "Priority: Urgent", `R15 ②: the priority trigger states ${JSON.stringify(r15Urgent.priorityText)}`);
    r11Check(
      r15Urgent.priorityOpen === false && r15Urgent.currentPriorityRows.length === 1 && r15Urgent.currentPriorityRows[0] === "urgent",
      `R15 ②: priority panel ${r15Urgent.priorityOpen}/${r15Urgent.currentPriorityRows.join(",")}`,
    );
    await page.click("[data-filters] [data-filter-clear]");
    await page.waitForTimeout(150);
    const r15Cleared = await readR11();
    r11Check(r15Cleared.assigneeValue === "all" && r15Cleared.priorityValue === "all", `R15 ②: Clear left ${r15Cleared.assigneeValue}/${r15Cleared.priorityValue}`);
    r11Check(r15Cleared.countText === restR11.countText, `R15 ②: Clear must restore the count (${JSON.stringify(r15Cleared.countText)})`);
    // The board's Clear raises `toast.filtersCleared`; let it retire so the later
    // sections' toast reads bracket a quiet region (2500ms + a 200ms exit).
    await page.waitForTimeout(2900);

    // C · interaction (R11 §5.3 C-1…C-5, R13 §5.3 C1–C5)
    const openStatusMenu = async () => {
      const open = await page.evaluate(() => document.querySelector("[data-filter-status]")?.hasAttribute("open") ?? false);
      if (!open) {
        await page.click("[data-filter-status] > summary");
        await page.waitForTimeout(90);
      }
    };
    const closeFloating = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(90);
    };
    const pressStatus = async (key) => {
      await openStatusMenu();
      await page.click(`[data-filter-status-option][data-status-value="${key}"]`);
      await page.waitForTimeout(120);
    };

    // C-2 — one status: the set is exactly that status, and the cards follow.
    await pressStatus("in_review");
    const r11Solo = await readR11();
    r11Check(r11Solo.statusValue === "in_review", `after In Review the value is ${r11Solo.statusValue}`);
    r11Check(r11Solo.statusText === "Status: In Review", `single-status text ${JSON.stringify(r11Solo.statusText)}`);
    r11Check(r11Solo.visibleCardStatuses.length > 0 && r11Solo.visibleCardStatuses.every((s) => s === "in_review"), `visible card statuses ${r11Solo.visibleCardStatuses.join(",")}`);
    r11Check(/^showing \d+ of \d+$/.test(r11Solo.countText ?? ""), `the count must take the filtered form, got ${JSON.stringify(r11Solo.countText)}`);

    // C-3 — a second status joins it: OR, stated in menu order.
    await pressStatus("in_progress");
    const r11Or = await readR11();
    r11Check(r11Or.statusValue === "in_progress,in_review", `OR value ${r11Or.statusValue} (menu order: in_progress first)`);
    r11Check(r11Or.statusText === "Status: In Progress +1", `multi-status text ${JSON.stringify(r11Or.statusText)}`);
    r11Check(
      r11Or.visibleCardStatuses.length > 0 && r11Or.visibleCardStatuses.every((s) => s === "in_progress" || s === "in_review"),
      `OR visible statuses ${[...new Set(r11Or.visibleCardStatuses)].join(",")}`,
    );

    // C-4 — `all` clears the set.
    await pressStatus("all");
    const r11All = await readR11();
    r11Check(r11All.statusValue === "all", `after All the value is ${r11All.statusValue}`);
    r11Check(r11All.pressedOptions.length === 1 && r11All.pressedOptions[0] === "all", `after All aria-pressed=${r11All.pressedOptions.join(",")}`);

    // Roster press — one fact changes (R13 修订 §10.3 C1): the assignee condition
    // narrows to the name, and **nothing else moves**.
    const rosterNames = restR11.itemNames;
    const [firstName, secondName] = rosterNames;
    r11Check(rosterNames.length >= 2, `the fixture must offer two roster names, got ${rosterNames.length}`);
    await page.click(`[data-agent-assignee="${firstName}"]`);
    await page.waitForTimeout(400);
    const r11Route = await readR11();
    // C1.1 — the name is written into the control, exactly as its own row would.
    r11Check(r11Route.assigneeValue === firstName, `the press wrote assignee ${r11Route.assigneeValue}, expected ${firstName}`);
    // C1.2 — **both** halves of the view indicator are unmoved (nav aria-current
    // and the topbar tab's aria-pressed).
    r11Check(r11Route.viewCurrent === restR11.viewCurrent, `the press switched the view ${restR11.viewCurrent} → ${r11Route.viewCurrent}`);
    r11Check(r11Route.viewPressed === restR11.viewPressed, `the press switched the view tab ${restR11.viewPressed} → ${r11Route.viewPressed}`);
    r11Check(r11Route.listPressed === restR11.listPressed, `[data-view="list"] aria-pressed=${r11Route.listPressed}`);
    // C1.3 — the status set is not written at all.
    r11Check(r11Route.statusValue === restR11.statusValue, `the press wrote status ${restR11.statusValue} → ${r11Route.statusValue}`);
    // C1.4 — and the `x` never appears.
    r11Check(r11Route.clearCount === 0, `a name in force raised ${r11Route.clearCount} [data-assignee-clear]`);
    // R15 ② — the trigger states the chosen row's own copy, which for a given
    // name is the name itself (R13's reading, kept across the conversion).
    r11Check(r11Route.assigneeText === firstName, `R15 ②: the trigger states ${JSON.stringify(r11Route.assigneeText)}, expected ${JSON.stringify(firstName)}`);
    // The capsule and the named option follow the value (§10.3 C2.capsule/C2.domain).
    r11Check(r11Route.activeItems.length === 1 && r11Route.activeItems[0] === firstName, `active roster items ${r11Route.activeItems.join(",")}`);
    r11Check(r11Route.pressedNames.length === 1 && r11Route.pressedNames[0] === firstName, `pressed names ${r11Route.pressedNames.join(",")}`);
    r11Check(r11Route.namedOptionValues.length === 1 && r11Route.namedOptionValues[0] === firstName, `named options ${r11Route.namedOptionValues.join(",")}`);
    r11Check(r11Route.b22Options === restR11.b22Options, `B22's seat count moved ${restR11.b22Options} → ${r11Route.b22Options}`);
    // The narrowing is real: the board re-filters to the assignee alone — **no**
    // status conjunct (that was the retired four-step route), so the rendered
    // card set is exactly the assignee-only match.
    r11Check(
      r11Route.visibleCardNames.length > 0 && r11Route.visibleCardNames.every((n) => n === firstName),
      `the board still shows names ${[...new Set(r11Route.visibleCardNames)].join(",")} — expected only ${firstName}`,
    );
    r11Check(
      r11Route.visibleCardIds.length === r11Route.expectedAssigneeRows,
      `the board shows ${r11Route.visibleCardIds.length} cards (${r11Route.visibleCardIds.join(" | ")}), ${r11Route.expectedAssigneeRows} expected (${r11Route.expectedAssigneeIds.join(" | ")})`,
    );

    // R13 §5.2 — the capsule's geometry and its width neutrality, measured with
    // **this** name in force. `firstName` is a row's first name, which is the
    // position U-6 is about: the bed's 6px left bleed is the part a clipping host
    // would shear off.
    const r11Capsule = await measureRoster();
    r11Check(r11Capsule.activeCount === 1, `${r11Capsule.activeCount} capsules are active`);
    r11Check(r11Capsule.capsule?.radius === "999px", `capsule radius ${r11Capsule.capsule?.radius}`);
    r11Check(r11Capsule.capsule?.paddingLeft === "6px" && r11Capsule.capsule?.paddingRight === "6px", `capsule padding ${r11Capsule.capsule?.paddingLeft}/${r11Capsule.capsule?.paddingRight}`);
    r11Check(r11Capsule.capsule?.marginLeft === "-6px" && r11Capsule.capsule?.marginRight === "-6px", `capsule inline margin ${r11Capsule.capsule?.marginLeft}/${r11Capsule.capsule?.marginRight}`);
    r11Check(r11Capsule.capsule?.borderTopWidth === "0px", `the capsule is a bed, not a shell (border ${r11Capsule.capsule?.borderTopWidth})`);
    r11Check(r11Capsule.capsule?.background === "rgba(15, 122, 115, 0.1)", `capsule ground ${r11Capsule.capsule?.background}, expected the accent-soft token`);
    r11Check(r11Capsule.nameColor === "rgb(15, 122, 115)", `the selected name's colour ${r11Capsule.nameColor}, expected the accent token`);
    // B6 — width neutrality: no roster row's single-line host is elided.
    r11Check(r11Capsule.rows.every((r) => r.clip === 0), `roster clip ${r11Capsule.rows.map((r) => r.clip).join(",")} — the capsule must cost no width`);
    // B3 — the row heights do not move.
    r11Check(
      JSON.stringify(r11Capsule.rowHeights) === JSON.stringify(restRoster.rowHeights),
      `roster row heights moved ${restRoster.rowHeights.join(",")} → ${r11Capsule.rowHeights.join(",")}`,
    );
    // U-6 — the correction: the host clips nothing, and the bed really does
    // bleed its 6px past the host's content edge with its cap intact.
    r11Check(r11Capsule.hostOverflow === "visible", `the roster text host overflow is ${r11Capsule.hostOverflow}, expected visible (R13 §8 U-6)`);
    r11Check(
      r11Capsule.activeIsFirst === true && r11Capsule.activeBleed !== null && r11Capsule.activeBleed >= 5 && r11Capsule.activePainted,
      `the first-in-row capsule bleeds ${r11Capsule.activeBleed}px (first=${r11Capsule.activeIsFirst}, painted=${r11Capsule.activePainted})`,
    );
    r11Check(restRoster.rows.every((r) => r.clip === 0), `at rest the roster clips ${restRoster.rows.map((r) => r.clip).join(",")}`);
    // B03 · R-1 — the rail is the box the names must fit in. A host that grows
    // instead of wrapping passes `rows[].clip === 0` and still hands the overflow
    // to `.td-sidebar`'s own `overflow-x: auto`, which is a 248px column hiding
    // real content behind a scrollbar most readers never take. Both observations
    // are needed; neither alone says the names are on screen.
    r11Check(restRoster.rail?.clip === 0, `at rest the sidebar rail scrolls ${restRoster.rail?.clip}px (scrollWidth ${restRoster.rail?.scrollWidth} > clientWidth ${restRoster.rail?.clientWidth}) — the roster is escaping the rail instead of fitting it`);
    r11Check(r11Capsule.rail?.clip === 0, `with a capsule the sidebar rail scrolls ${r11Capsule.rail?.clip}px (scrollWidth ${r11Capsule.rail?.scrollWidth} > clientWidth ${r11Capsule.rail?.clientWidth})`);

    // R13 §10.3 C4 — switching names moves the capsule, never doubles it, and
    // still writes nothing but the assignee.
    if (secondName) {
      await page.click(`[data-agent-assignee="${secondName}"]`);
      await page.waitForTimeout(300);
      const r11Switch = await readR11();
      r11Check(r11Switch.activeItems.length === 1 && r11Switch.activeItems[0] === secondName, `switched active ${r11Switch.activeItems.join(",")}`);
      r11Check(r11Switch.namedOptionValues.length === 1 && r11Switch.namedOptionValues[0] === secondName, `switched named option ${r11Switch.namedOptionValues.join(",")}`);
      r11Check(r11Switch.assigneeValue === secondName, `switched value ${r11Switch.assigneeValue}`);
      r11Check(r11Switch.statusValue === restR11.statusValue, `switching names moved the status set to ${r11Switch.statusValue}`);
      r11Check(r11Switch.viewCurrent === restR11.viewCurrent, `switching names moved the view to ${r11Switch.viewCurrent}`);
      r11Check(r11Switch.clearCount === 0, `switching names raised ${r11Switch.clearCount} [data-assignee-clear]`);

      // R13 §10.3 C3 — the **control's own `Assignee: All` row** is the removal
      // path now (the `x` is gone): it resets the capsule and `aria-pressed`,
      // and moves no other condition. R15 ② — the row is a menu `button`, so the
      // panel is opened first, exactly as a user would.
      const beforeReset = await readR11();
      if (!beforeReset.assigneeOpen) {
        await page.click("[data-filter-assignee] > summary");
        await page.waitForTimeout(90);
      }
      await page.click('[data-assignee-filter-option="all"]');
      await page.waitForTimeout(150);
      const afterReset = await readR11();
      r11Check(afterReset.assigneeValue === "all", `after the control's \`all\` row the assignee is ${afterReset.assigneeValue}`);
      r11Check(afterReset.namedOptionValues.length === 0, `after the \`all\` row ${afterReset.namedOptionValues.length} named options remain`);
      r11Check(afterReset.activeItems.length === 0, `after the \`all\` row ${afterReset.activeItems.length} roster items stay active`);
      r11Check(afterReset.pressedNames.length === 0, `after the \`all\` row ${afterReset.pressedNames.length} names stay pressed`);
      r11Check(afterReset.clearCount === 0, `the \`all\` row raised ${afterReset.clearCount} [data-assignee-clear]`);
      r11Check(afterReset.statusValue === beforeReset.statusValue, `the \`all\` row moved the status set ${beforeReset.statusValue} → ${afterReset.statusValue}`);
      r11Check(afterReset.viewCurrent === beforeReset.viewCurrent, `the \`all\` row switched the view to ${afterReset.viewCurrent}`);
      r11Check(afterReset.toastChildren === beforeReset.toastChildren, "the `all` row must not raise a toast");
      r11Check(
        afterReset.visibleCardIds.length >= beforeReset.visibleCardIds.length,
        "clearing the assignee must widen (or hold) the card set, never narrow it",
      );
    }

    // R13 §10.3 C2 — pressing the name already in force is **idempotent**: the
    // control stays on that name, the capsule stays, and no toggle-off happens.
    await page.click(`[data-agent-assignee="${firstName}"]`);
    await page.waitForTimeout(300);
    const r11Reopen = await readR11();
    r11Check(r11Reopen.assigneeValue === firstName, `the press wrote ${r11Reopen.assigneeValue}`);
    const statusBeforeRepeat = r11Reopen.statusValue;
    const viewBeforeRepeat = r11Reopen.viewCurrent;
    await page.click(`[data-agent-assignee="${firstName}"]`);
    await page.waitForTimeout(200);
    const r11Repeat = await readR11();
    r11Check(r11Repeat.assigneeValue === firstName, `the repeat press left the assignee on ${r11Repeat.assigneeValue} — pressing the name in force is idempotent`);
    r11Check(r11Repeat.activeItems.length === 1 && r11Repeat.activeItems[0] === firstName, `the repeat press left ${r11Repeat.activeItems.length} active items`);
    r11Check(r11Repeat.pressedNames.length === 1 && r11Repeat.pressedNames[0] === firstName, `the repeat press left pressed names ${r11Repeat.pressedNames.join(",")}`);
    r11Check(r11Repeat.statusValue === statusBeforeRepeat, `the repeat press moved the status set ${statusBeforeRepeat} → ${r11Repeat.statusValue}`);
    r11Check(r11Repeat.viewCurrent === viewBeforeRepeat, `the repeat press switched the view to ${r11Repeat.viewCurrent}`);
    r11Check(r11Repeat.clearCount === 0, `the repeat press raised ${r11Repeat.clearCount} [data-assignee-clear]`);
    await closeFloating();

    // R13 §10.3 C4 — no click path anywhere raises the `x`: sweep the two roster
    // names, the bar, the board, the four nav items, both view tabs, the filter
    // toggle and the body, reading the count after each. The control's own path
    // is the `all`-row press above, so this sweep does not need to re-open a menu.
    //
    // The clicks are dispatched with `HTMLElement.click()` inside the page rather
    // than through Playwright's actionability machinery: this is a "does the hook
    // appear" sweep, not a UI-driving one, and a real click on a hidden or
    // animating target is both stronger (it still fires the handler) and free
    // (no 30s stability wait per selector, which is what turned this block into
    // the whole suite's critical path when everything else was competing for the
    // browser). The state the clicks disturb is restored below.
    const CLEAR_SWEEP = [
      `[data-agent-assignee="${firstName}"]`,
      `[data-agent-assignee="${secondName}"]`,
      "[data-filters]",
      "[data-board]",
      '[data-nav-item="board"]',
      '[data-nav-item="list"]',
      '[data-nav-item="activity"]',
      '[data-nav-item="waiting"]',
      '[data-view-toggle] [data-view="board"]',
      '[data-view-toggle] [data-view="list"]',
      "[data-filter-toggle]",
      "body",
    ];
    const sweep = await page.evaluate((selectors) => {
      let max = 0;
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.click();
        max = Math.max(max, document.querySelectorAll("[data-assignee-clear]").length);
      }
      return max;
    }, CLEAR_SWEEP);
    r11Check(sweep === 0, `a click path raised ${sweep} [data-assignee-clear] (C4: the count is 0 on every path)`);
    await page.waitForTimeout(200); // let the view switches the sweep triggered settle

    // The sweep left the view, the view tab, the filters bar and the assignee
    // condition disturbed; put them all back so the trailing reset (and every
    // section after this one) reads the resting board. The view and the bar come
    // first — the bar may be hidden, and the assignee control is inside it. The
    // assignee is the one that matters: a name still in force would filter the
    // M1/B27 sections' cards out of the board.
    await page.click('[data-view-toggle] [data-view="board"]').catch(() => {});
    await page.waitForTimeout(80);
    if (await page.evaluate(() => document.querySelector("[data-filters]")?.hasAttribute("hidden") === true)) {
      await page.click("[data-filter-toggle]");
      await page.waitForTimeout(120);
    }
    if (!(await page.evaluate(() => document.querySelector("[data-filter-assignee]")?.hasAttribute("open") ?? false))) {
      await page.click("[data-filter-assignee] > summary");
      await page.waitForTimeout(90);
    }
    await page.click('[data-assignee-filter-option="all"]');
    await page.waitForTimeout(120);

    // Base state again, so the sections after this one read the resting board.
    await page.click("[data-nav-item='board']");
    await page.waitForTimeout(150);


    // ---- M1 · R12x · B27 — the 「等你回复」queue -------------------------------
    //
    // The block's own list, evaluated where it has to be evaluated: in a browser,
    // against computed style and live DOM. Everything here is a selector, a
    // computed value or a text comparison — never "it looks right". The badge
    // half is M1's (the board still wears it); the queue half is B27's.
    const m1 = await page.evaluate(() => {
      const badge = document.querySelector("[data-card-waiting]");
      const awaitingCard = document.querySelector('[data-card][data-identifier="TD-13"]');
      const countPill = document.querySelector('[data-nav-count="waiting"]');
      const rows = [...document.querySelectorAll("[data-waiting-item]")];
      // M6 — the queue now has two producers: the awaiting card (TD-13) and the
      // delivered cards whose own `acceptance_mode` is `human` (TD-7, TD-8).
      // The six-field rule below is about the awaiting row, so it
      // selects that row explicitly; the order rule is asserted separately.
      const item = rows.find((row) => row.getAttribute("data-task") === "TD-13") ?? null;
      // Resolve the accent the same way the stylesheet does, so the comparison is
      // value-to-value rather than hex-vs-rgb.
      const probe = document.createElement("span");
      probe.style.color = "var(--color-primary)";
      document.body.appendChild(probe);
      const accentColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        badges: document.querySelectorAll("[data-card-waiting]").length,
        // §8-04 is a *per-card* rule ("every awaiting card renders exactly one
        // [data-card-waiting], and it appears on no other card"). The view is
        // co-mounted (design §3.2: a waiting row *is* the card component, and the
        // inactive view is `hidden`, not unmounted), so the one awaiting card is
        // legitimately on screen twice — once in its column, once as a row — and
        // the meaningful counts are the board's and the per-card ones below.
        boardBadges: document.querySelectorAll("[data-board] [data-card-waiting]").length,
        cardsWithTwoBadges: [...document.querySelectorAll("[data-card]")].filter(
          (card) => card.querySelectorAll("[data-card-waiting]").length > 1,
        ).length,
        strayBadges: [...document.querySelectorAll("[data-card-waiting]")].filter(
          (node) => node.closest("[data-card]") === null,
        ).length,
        badgeReason: badge?.getAttribute("data-waiting-reason") ?? null,
        badgeLabel: badge?.textContent?.trim() ?? null,
        badgeColor: badge ? getComputedStyle(badge).color : null,
        accentColor,
        badgeAria: badge?.getAttribute("aria-label") ?? null,
        cardStatus: awaitingCard?.getAttribute("data-status") ?? null,
        badgeColumn: badge?.closest("[data-column]")?.getAttribute("data-status") ?? null,
        columns: document.querySelectorAll("[data-column]").length,
        cardsWithAwaitingStatus: document.querySelectorAll('[data-card][data-status="awaiting"]').length,
        navItems: [...document.querySelectorAll("[data-nav-item]")].map((el) => el.getAttribute("data-nav-item")),
        countText: countPill?.textContent?.trim() ?? null,
        countHidden: countPill ? countPill.hasAttribute("hidden") : null,
        rows: rows.length,
        // B27.1 — the six fields a row owes, read off the one row this fixture
        // has: actor (+ kind), reason (+ kind), identifier (with the whole value
        // on `title`), title, the stamp, the opener.
        itemTask: item?.getAttribute("data-task") ?? null,
        itemIds: rows.map((row) => row.getAttribute("data-task")),
        acceptance: (() => {
          const row = rows.find((candidate) => candidate.getAttribute("data-task") === "TD-7");
          if (!row) return null;
          return {
            reason: row.querySelector("[data-waiting-reason]")?.textContent?.trim() ?? null,
            reasonKind: row.querySelector("[data-waiting-reason]")?.getAttribute("data-waiting-reason-kind") ?? null,
            actor: row.querySelector("[data-waiting-actor]")?.textContent?.trim() ?? null,
            since: row.getAttribute("data-since"),
          };
        })(),
        itemSince: item?.getAttribute("data-since") ?? null,
        actor: item?.querySelector("[data-waiting-actor]")?.textContent?.trim() ?? null,
        actorKind: item?.querySelector("[data-waiting-actor]")?.getAttribute("data-assignee-kind") ?? null,
        reason: item?.querySelector("[data-waiting-reason]")?.textContent?.trim() ?? null,
        reasonKind: item?.querySelector("[data-waiting-reason]")?.getAttribute("data-waiting-reason-kind") ?? null,
        task: item?.querySelector("[data-waiting-task]")?.textContent?.trim() ?? null,
        taskTitleAttr: item?.querySelector("[data-waiting-task]")?.getAttribute("title") ?? null,
        taskTitle: item?.querySelector("[data-waiting-task-title]")?.textContent?.trim() ?? null,
        sinceDatetime: item?.querySelector("[data-waiting-since]")?.getAttribute("datetime") ?? null,
        sinceText: item?.querySelector("[data-waiting-since]")?.textContent?.trim() ?? null,
        openLabel: item?.querySelector("[data-waiting-open]")?.getAttribute("aria-label") ?? null,
        // B27.2 — the head's name and its tally.
        headTitle: document.querySelector("[data-waiting-title]")?.textContent?.trim() ?? null,
        // R15 ④ — the head's description: a `<p>` inside the header's text block,
        // carrying a `data-i18n` hook and **no** `data-waiting-*` seat of its own.
        headSub: document.querySelector("[data-waiting-head] .td-waiting-head-text p")?.textContent?.trim() ?? null,
        headSubTag: document.querySelector("[data-waiting-head] p")?.tagName ?? null,
        headSubHooks: [...(document.querySelector("[data-waiting-head] p")?.attributes ?? [])].map((a) => a.name),
        headCount: document.querySelector("[data-waiting-count]")?.textContent?.trim() ?? null,
        headCountHidden: document.querySelector("[data-waiting-count]")?.hasAttribute("hidden") ?? null,
        // §8-09(a): no freshness/claim affordance anywhere inside a card.
        freshnessHooks: document.querySelectorAll(
          "[data-card] [data-card-agent-stale], [data-card] [data-card-claimable], [data-card] [data-freshness], [data-card] [data-stale]",
        ).length,
      };
    });

    // §8-13 — the awaiting card's move menu must offer no route to in_review,
    // done or blocked, and must offer canceled.
    const awaitingMenu = await page.evaluate(() => {
      const kebab = document.querySelector('[data-card][data-identifier="TD-13"] [data-card-menu]');
      kebab?.click();
      return null;
    });
    void awaitingMenu;
    await page.waitForTimeout(120);
    const awaitingMenuLabels = await page.evaluate(() =>
      [...document.querySelectorAll("[data-move-to]")].map((el) => el.textContent.trim()),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);

    // §8-02/§8-03 — the nav item switches the view, and only the awaiting card
    // count is loud. Clicking it is the writer check: a button that does nothing
    // would leave the board on screen.
    await page.click('[data-nav-item="waiting"]');
    await page.waitForTimeout(150);
    const waitingView = await page.evaluate(() => {
      const section = document.querySelector("[data-waiting-view]");
      // R10 ① — the board gives way **whole**, wrapper included: the view root is
      // what carries `hidden` now, because hiding only the board would leave the
      // board-level empty state floating above whichever view replaces it.
      const boardView = document.querySelector("[data-board-view]");
      return {
        current: document.querySelector('[data-nav-item="waiting"]')?.getAttribute("aria-current") ?? null,
        viewVisible: section ? !section.hasAttribute("hidden") : false,
        boardHidden: boardView ? boardView.hasAttribute("hidden") : false,
        boardPainted: boardView ? boardView.getClientRects().length > 0 : false,
        // B27.3 — the empty state is *resident*: "shown" means the attribute is
        // off, not that the node exists.
        emptyShown: document.querySelector("[data-waiting-empty]")?.hasAttribute("hidden") === false,
        // §29.2 — the board's filter bar stands down here too.
        filtersPainted: (document.querySelector("[data-filters]")?.getClientRects().length ?? 0) > 0,
      };
    });
    // The contract's own B27 rules, read while the queue is on screen.
    const waitingResults = await evaluateRuleSet(waitingRules);
    await page.click('[data-nav-item="board"]');
    await page.waitForTimeout(120);

    const AWAITING_COMMENT_AT = "2026-10-12T00:02:00Z";
    const m1Failures = [];
    const check = (ok, message) => { if (!ok) m1Failures.push(message); };
    check(m1.boardBadges === 1, `board [data-card-waiting] count ${m1.boardBadges} !== 1`);
    check(m1.cardsWithTwoBadges === 0, "no single card may render two [data-card-waiting]");
    check(m1.strayBadges === 0, "every [data-card-waiting] must sit inside a [data-card]");
    check(m1.badgeReason === "E1", `badge reason ${m1.badgeReason} !== E1`);
    check(m1.badgeLabel === "Awaiting you", `badge label ${m1.badgeLabel}`);
    check(m1.badgeColor === m1.accentColor, `badge colour ${m1.badgeColor} !== accent ${m1.accentColor}`);
    check(m1.cardStatus !== "awaiting", `[data-card] must keep its stage, got ${m1.cardStatus}`);
    check(m1.badgeColumn === "in_progress", `badge column ${m1.badgeColumn} !== in_progress`);
    check(m1.columns === 7, `[data-column] count ${m1.columns} !== 7`);
    check(m1.cardsWithAwaitingStatus === 0, "no card root may carry data-status=awaiting");
    check(m1.navItems.length === 4 && m1.navItems.includes("waiting"), `nav items ${m1.navItems.join(",")}`);
    check(m1.countText === "3", `count pill ${m1.countText} !== 3 (one question + two acceptances)`);
    check(m1.countHidden === false, "a non-zero count must not be hidden");
    check(m1.freshnessHooks === 0, "no freshness hook may exist inside a card");
    check(!awaitingMenuLabels.some((label) => /In Review|Done|Blocked/i.test(label)), `awaiting menu offers ${awaitingMenuLabels.join("|")}`);
    check(awaitingMenuLabels.some((label) => /Canceled/i.test(label)), "awaiting menu must offer Canceled");

    // B27 — the queue. Three rows (one awaiting question, two accepted-waiting
    // deliveries), the awaiting row's six fields, the stamp it carries stated
    // twice (attribute + `datetime`), and the head's own name and tally.
    check(m1.rows === 3, `[data-waiting-item] count ${m1.rows} !== 3`);
    // Oldest first: TD-7/TD-8 are delivered cards from the fixture's older
    // stamp, TD-13 is the awaiting question. The order is the queue's rule, not
    // the fixture's listing order.
    check(
      JSON.stringify(m1.itemIds) === JSON.stringify(["TD-7", "TD-8", "TD-13"]),
      `waiting row order ${JSON.stringify(m1.itemIds)}`,
    );
    check(m1.acceptance !== null, "the delivered human-mode card must be in the queue");
    check(m1.acceptance.reason === "Ready for acceptance" && m1.acceptance.reasonKind === "acceptance", `acceptance reason ${m1.acceptance?.reason} (${m1.acceptance?.reasonKind})`);
    check(m1.acceptance.actor === "elon", `acceptance row's actor ${m1.acceptance?.actor} — the assignee that delivered it`);
    check(m1.acceptance.since === "2026-10-01T00:00:00Z", `acceptance row's since ${m1.acceptance?.since} — the delivery instant`);
    check(m1.itemTask === "TD-13", `the row names ${m1.itemTask}, expected TD-13`);
    check(m1.actor === "linus" && m1.actorKind === "agent", `actor ${m1.actor} (${m1.actorKind}) — the card's assignee waits`);
    check(m1.reason === "Question" && m1.reasonKind === "question", `reason ${m1.reason} (${m1.reasonKind})`);
    check(m1.task === "TD-13" && m1.taskTitleAttr === "TD-13", `task cell ${m1.task} / title ${m1.taskTitleAttr}`);
    check(m1.taskTitle === "Confirm the release scope before the cut", `task title ${m1.taskTitle}`);
    check(m1.itemSince === AWAITING_COMMENT_AT, `the row's since ${m1.itemSince} !== the triggering comment ${AWAITING_COMMENT_AT}`);
    check(m1.sinceDatetime === m1.itemSince, `stamp datetime ${m1.sinceDatetime} !== the row's own ${m1.itemSince}`);
    check(/^\d+[dhm] ago$/.test(m1.sinceText ?? ""), `stamp text ${m1.sinceText}`);
    check((m1.openLabel ?? "").startsWith("Open "), `opener aria-label ${m1.openLabel}`);
    check(m1.headTitle === "Waiting on me", `head title ${m1.headTitle}`);
    // R15 ④ — the header states what the view is as well as what it is called.
    check(m1.headSub === "Everything waiting on your answer, oldest first.", `R15 ④: head description ${JSON.stringify(m1.headSub)}`);
    check(m1.headSubTag === "P", `R15 ④: the description is <${m1.headSubTag}>, expected <p>`);
    check(
      m1.headSubHooks.includes("data-i18n") && !m1.headSubHooks.some((name) => name.startsWith("data-waiting-")),
      `R15 ④: the description's hooks are ${JSON.stringify(m1.headSubHooks)} — a \`data-i18n\` seat and no \`data-waiting-*\` of its own`,
    );
    check(m1.headCount === "3 waiting on you", `head count ${m1.headCount}`);
    check(m1.headCountHidden === false, "a non-empty queue must show its tally");
    check(waitingView.current === "page", "the waiting nav item must carry aria-current");
    check(waitingView.viewVisible === true, "the waiting view must be visible");
    check(waitingView.boardHidden === true, "the board view must be hidden while the waiting view is up");
    check(waitingView.boardPainted === false, "the board view must not be painted while the waiting view is up");
    check(waitingView.emptyShown === false, "a non-empty view must not show the empty state");
    check(waitingView.filtersPainted === false, "the board's filter bar must stand down on the queue");

    // The in-flight list rules are answered inside the r9 section's own window
    // (the read is held open there), so their records are folded in here and
    // every declared rule is counted exactly once.
    // ---- R12x · B26 — the Activity view ---------------------------------------
    //
    // Authority: `design/activity/DESIGN-activity.md` §3 admission / §4 levels /
    // §5 folding / §6 interaction / §8 empty states, block contract
    // `design/BLOCKS.md` B26. These are the rules only a live DOM can answer —
    // routing, the count, the three filters, the fold's window, the boundary, the
    // keyboard and the drawer the rows land on. The static half of B26 lives in
    // the contract (`test/web/blocks.contract.mjs`).
    const b26Failures = [];
    const b26Check = (ok, message) => { if (!ok) b26Failures.push(message); };

    /** BLOCKS.md B26's closed vocabulary — the 39 names, no more (sorted).
     *  R15 ① added the five the dropdown conversion needs (`filter-summary`,
     *  `filter-text`, `filter-option`, `filter-value`, `value`) and retired one
     *  (`filter-reset`); `design/BLOCKS.md` B26 "Auxiliary hooks" is the record
     *  this list is read against. */
    const B26_HOOK_NAMES = [
      "actor", "at", "burst", "burst-count", "burst-count-label", "burst-item", "change", "day", "day-kind",
      "day-label", "detail", "empty", "empty-kind", "empty-reset", "feed", "filter", "filter-count",
      "filter-option", "filter-summary", "filter-text", "filter-value", "filters", "group", "line",
      "mark-read", "more", "open", "page", "row", "sentence", "task", "task-id", "task-title", "title",
      "unread", "unread-count", "unread-divider", "value", "view",
    ];

    // A press on a nav item used to answer with a toast; nothing may raise one now.
    const toastSeatsBefore = await page.evaluate(() => document.querySelectorAll("[data-toast-region] > *").length);
    await page.click('[data-nav-item="activity"]');
    await page.waitForTimeout(300);

    // The contract's own B26 rules, read here and nowhere else: the view is open
    // and the ledger has been read.
    const activityResults = await evaluateRuleSet(activityRules);

    const b26Rest = await page.evaluate(() => {
      const root = document.querySelector("[data-activity-view]");
      const rows = [...root.querySelectorAll("[data-activity-row]")];
      const days = [...root.querySelectorAll("[data-activity-day]")];
      const stampOf = (day) => day.querySelectorAll("[data-activity-row]").length;
      const within = (node) => {
        const owner = node.closest("[data-activity-day]");
        return owner !== null && days.includes(owner) ? 1 : 0;
      };
      const countText = root.querySelector("[data-activity-filter-count]")?.textContent?.trim() ?? "";
      const pill = document.querySelector('[data-nav-count="activity"]');
      return {
        rootHidden: root.hasAttribute("hidden"),
        rootPainted: root.getClientRects().length > 0,
        navCurrents: [...document.querySelectorAll("[data-nav] [data-nav-item][aria-current='page']")].map((el) => el.getAttribute("data-nav-item")),
        boardHidden: document.querySelector("[data-board-view]")?.hasAttribute("hidden") ?? null,
        listHidden: document.querySelector("[data-list]")?.hasAttribute("hidden") ?? null,
        // The other three views must stand down *visibly*. The board and the list
        // state it on the `hidden` attribute; the waiting view is `v-show`n, so
        // for it (and for all three) the reading that cannot be faked is "paints
        // nothing".
        waitingHidden: document.querySelector("[data-waiting-view]")?.hasAttribute("hidden") ?? null,
        waitingPainted: (document.querySelector("[data-waiting-view]")?.getClientRects().length ?? 0) > 0,
        boardPainted: (document.querySelector("[data-board-view]")?.getClientRects().length ?? 0) > 0,
        listPainted: (document.querySelector("[data-list]")?.getClientRects().length ?? 0) > 0,
        dayCount: days.length,
        dayKeys: days.map((day) => day.getAttribute("data-day")),
        dayKinds: days.map((day) => day.getAttribute("data-activity-day-kind")),
        dayRowCounts: days.map(stampOf),
        rowsOwnedByOneDay: rows.map(within),
        rowAts: rows.map((row) => row.getAttribute("data-at")),
        stampMatches: rows.map((row) => row.querySelector("[data-activity-at]")?.getAttribute("datetime") === row.getAttribute("data-at")),
        rowEvents: rows.map((row) => row.getAttribute("data-event")),
        rowTasks: rows.map((row) => row.getAttribute("data-task")),
        invisibleRows: rows.filter((row) => row.hasAttribute("hidden")).length,
        // C02's sibling invariant, in the form this view can hold it: two row
        // hooks are per-row state (`data-activity-unread` / `data-activity-burst`),
        // so uniformity is stated over the six *fields* every row must carry.
        incompleteRows: rows.filter(
          (row) =>
            row.querySelectorAll(":scope [data-activity-line] > [data-activity-actor]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-sentence]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-task]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-task-id]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-task-title]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-at]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-open]").length !== 1 ||
            row.querySelectorAll(":scope [data-activity-detail]").length !== 1,
        ).length,
        dayPages: days.map((day) => day.getAttribute("data-activity-page")),
        linesOutsideRows: root.querySelectorAll("[data-activity-line]").length - rows.length,
        // §29.2 — the board's filter bar narrows cards, so it stands down with the
        // board area and comes back with it.
        filtersHidden: document.querySelector("[data-filters]")?.hasAttribute("hidden") ?? null,
        filtersPainted: (document.querySelector("[data-filters]")?.getClientRects().length ?? 0) > 0,
        // BLOCKS.md B26 fixes the view's `data-activity-*` vocabulary at 35 names
        // and says "no more": the closed list is what keeps two rounds from
        // inventing parallel hooks for one fact.
        hookNames: [...new Set([...root.outerHTML.matchAll(/data-activity-([a-z-]+)/g)].map((match) => match[1]))].sort(),
        countSentence: countText,
        countArg: root.querySelector("[data-activity-filter-count]")?.getAttribute("data-i18n-arg") ?? null,
        pillText: pill?.textContent?.trim() ?? null,
        pillHidden: pill?.hasAttribute("hidden") ?? null,
        unreadRows: rows.filter((row) => row.hasAttribute("data-activity-unread")).length,
        dividers: root.querySelectorAll("[data-activity-unread-divider]").length,
        dividerCount: root.querySelector("[data-activity-unread-count]")?.textContent?.trim() ?? null,
        dividerDay: root.querySelector("[data-activity-unread-divider]")?.closest("[data-activity-day]")?.getAttribute("data-day") ?? null,
        emptyShown: [...root.querySelectorAll("[data-activity-empty]")].filter((el) => !el.hasAttribute("hidden")).map((el) => el.getAttribute("data-activity-empty-kind")),
        projectEmptyPresent: root.querySelectorAll('[data-activity-empty][data-activity-empty-kind="project"]').length,
        filterEmptyReset: root.querySelectorAll('[data-activity-empty][data-activity-empty-kind="filter"] [data-activity-empty-reset]').length,
        footHidden: root.querySelector(".td-activity-foot")?.hasAttribute("hidden") ?? null,
        morePresent: root.querySelectorAll("[data-activity-more]").length,
        lineHeight: (() => {
          const line = root.querySelector("[data-activity-row] [data-activity-line]");
          return line ? getComputedStyle(line).height : null;
        })(),
        detailTags: [...root.querySelectorAll("[data-activity-detail]")].map((el) => el.tagName),
        toastSeats: document.querySelectorAll("[data-toast-region] > *").length,
      };
    });

    // §5 — the fold: one row for a run of edits, its count equal to the members it
    // holds, and every member inside the five-minute window.
    const b26Burst = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-activity-row][data-activity-burst]")];
      const row = rows[0];
      if (!row) return { rows: 0 };
      const members = [...row.querySelectorAll("[data-activity-burst-item]")];
      const at = new Date(row.getAttribute("data-at")).getTime();
      const badge = row.querySelector("[data-activity-burst-count]");
      return {
        rows: rows.length,
        label: badge?.textContent?.trim() ?? null,
        value: badge?.getAttribute("data-activity-burst-count") ?? null,
        labelCount: row.querySelector("[data-activity-burst-count-label]")?.textContent?.trim() ?? null,
        members: members.length,
        memberSpanMs: members.length === 0 ? null : Math.max(...members.map((member) => Math.abs(new Date(member.getAttribute("data-at")).getTime() - at))),
        memberActors: [...new Set(members.map((member) => member.closest("[data-activity-row]").getAttribute("data-actor")))],
        memberTask: members[0]?.closest("[data-activity-row]")?.getAttribute("data-task") ?? null,
        rowActor: row.getAttribute("data-actor"),
        rowTask: row.getAttribute("data-task"),
        rowGroup: row.getAttribute("data-activity-group"),
        memberKinds: members.map((member) => member.getAttribute("data-activity-change")),
      };
    });

    // §4 L3 — opening a row's detail must not reflow the feed: the panel is
    // attached to the row, not laid out under it.
    const b26Detail = await page.evaluate(async () => {
      const root = document.querySelector("[data-activity-view]");
      const feed = root.querySelector("[data-activity-feed]");
      const row = [...root.querySelectorAll("[data-activity-row]")].find((el) => el.querySelector("[data-activity-change]"));
      const before = { scroll: feed.scrollHeight, body: document.documentElement.scrollHeight };
      row.querySelector("[data-activity-detail]")?.setAttribute("open", "");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const panel = row.querySelector(".td-activity-changes");
      const after = { scroll: feed.scrollHeight, body: document.documentElement.scrollHeight };
      const style = panel ? getComputedStyle(panel) : null;
      const out = {
        lines: row.querySelectorAll("[data-activity-change]").length,
        position: style?.position ?? null,
        display: style?.display ?? null,
        reflowedFeed: after.scroll !== before.scroll,
        reflowedBody: after.body !== before.body,
        negativeLeft: panel ? panel.getBoundingClientRect().left < 0 : null,
      };
      row.querySelector("[data-activity-detail]")?.removeAttribute("open");
      return out;
    });

    // §6 — the three filters narrow, the count follows the rows, and the address
    // bar shadows the three of them.
    const b26Filters = await page.evaluate(async () => {
      // R15 ① — a filter is a press on a dropdown row now, not `select.value`
      // plus a synthetic `change`: open the control's own panel, press the row
      // the domain names, and let the control's document click handler close it.
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const press = async (host, rowSelector) => {
        host.querySelector("summary")?.click();
        await sleep(40);
        host.querySelector(rowSelector)?.click();
        await sleep(70);
      };
      const set = async (slot, value) =>
        press(document.querySelector(`[data-activity-filter="${slot}"]`), `[data-activity-filter-option][data-activity-value="${value}"]`);
      const read = () => {
        const root = document.querySelector("[data-activity-view]");
        const rows = [...root.querySelectorAll("[data-activity-row]")].filter((row) => !row.hasAttribute("hidden"));
        return {
          rows: rows.length,
          kinds: [...new Set(rows.map((row) => row.getAttribute("data-assignee-kind")))],
          groups: [...new Set(rows.map((row) => row.getAttribute("data-activity-group")))],
          tasks: [...new Set(rows.map((row) => row.getAttribute("data-task")))],
          count: root.querySelector("[data-activity-filter-count]")?.textContent?.trim() ?? "",
          // R16 §4.4 — the feed's payload moved from the fragment to the query,
          // so the shadow these assertions read is `location.search`.
          search: globalThis.location.search,
          empty: [...root.querySelectorAll("[data-activity-empty]")].filter((el) => !el.hasAttribute("hidden")).map((el) => el.getAttribute("data-activity-empty-kind")),
          dayCount: root.querySelectorAll("[data-activity-day]").length,
          triggers: ["actor", "event", "task"].map((slot) => root.querySelector(`[data-activity-filter="${slot}"] [data-activity-filter-text]`)?.textContent?.trim() ?? null),
          values: ["actor", "event", "task"].map((slot) => root.querySelector(`[data-activity-filter="${slot}"]`)?.getAttribute("data-activity-filter-value") ?? null),
          // One chosen row per control (each control's own `aria-current`), read
          // through the control rather than document-wide so the three do not
          // blur into one list.
          currents: ["actor", "event", "task"].map(
            (slot) =>
              root
                .querySelector(`[data-activity-filter="${slot}"] [data-activity-filter-option][aria-current="true"]`)
                ?.getAttribute("data-activity-value") ?? null,
          ),
          // The board's own priority condition, read from this same window: the
          // two Clear controls must not touch each other's bar (§2.4, C12).
          boardPriority: document.querySelector("[data-filter-priority]")?.getAttribute("data-filter-priority-value") ?? null,
        };
      };
      const actorControl = document.querySelector('[data-activity-filter="actor"]');
      const out = { before: read() };
      actorControl.querySelector("summary")?.click();
      await sleep(60);
      out.openPanel = {
        open: actorControl.hasAttribute("open"),
        painted: (actorControl.querySelector('[data-activity-filter-option][data-activity-value="agent"]')?.getClientRects().length ?? 0) > 0,
        text: actorControl.querySelector("[data-activity-filter-text]")?.textContent?.trim() ?? null,
        dismiss: actorControl.hasAttribute("data-dismiss-on-outside"),
      };
      // …the panel really paints, so close it again before the rounds below.
      actorControl.querySelector("summary")?.click();
      await sleep(60);
      out.closedAgain = actorControl.hasAttribute("open");
      // A board filter in force for the whole round: the activity Clear must
      // leave it exactly where it was.
      await press(document.querySelector("[data-filter-priority]"), '[data-filter-priority-option][data-priority-value="urgent"]');
      await set("actor", "agent");
      out.agent = read();
      await set("event", "delivery");
      out.agentDelivery = read();
      await set("actor", "all");
      await set("event", "all");
      await set("task", "TD-6");
      out.task = read();
      await set("task", "all");
      // A filter that matches nothing: a task with no delivery of its own.
      await set("event", "delivery");
      await set("task", "TD-7");
      out.emptyMatch = read();
      // The empty state's own button is the way back.
      document.querySelector('[data-activity-empty][data-activity-empty-kind="filter"] [data-activity-empty-reset]')?.click();
      await sleep(80);
      out.afterReset = read();
      // R15 ③/④ — the bar's Clear is B04's own control: the three activity slots
      // go back to `all`, the board's priority condition is untouched, and the
      // board's own confirmation toast is raised here too (the ruling's ④).
      await set("event", "delivery");
      out.beforeClear = read();
      const clear = document.querySelector("[data-activity-filters] [data-filter-clear]");
      out.clearHook = clear !== null;
      clear?.click();
      await sleep(80);
      out.afterClear = read();
      out.toastAfterClear = [...document.querySelectorAll("[data-toast-region] > *")].map((el) => el.textContent.trim());
      // …and back to the resting board condition for the sections after this one.
      await press(document.querySelector("[data-filter-priority]"), '[data-filter-priority-option][data-priority-value="all"]');
      out.afterBoardRestore = read();
      return out;
    });

    // §6 — `j` / `k` walk the visible rows' open buttons. The presses go through
    // the real keyboard (not a synthetic event on `document`), so the walk starts
    // from the element the browser actually has focused — which is what the
    // handler reads.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("j");
    await page.waitForTimeout(80);
    const keyFirst = await page.evaluate(() => ({
      open: document.activeElement?.getAttribute("data-activity-open") ?? null,
      label: document.activeElement?.getAttribute("aria-label") ?? null,
    }));
    await page.keyboard.press("j");
    await page.waitForTimeout(80);
    const keySecond = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
    await page.keyboard.press("k");
    await page.waitForTimeout(80);
    const keyBack = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
    const b26Keys = {
      first: keyFirst.open,
      firstLabel: keyFirst.label,
      second: keySecond,
      back: keyBack,
      wrappable: keyFirst.label !== null && keySecond !== null && keyFirst.label !== keySecond && keyFirst.label === keyBack,
    };

    // §6 — one number, three readers: the pill, the boundary and its count.
    const b26Read = await page.evaluate(async () => {
      const root = document.querySelector("[data-activity-view]");
      const read = () => ({
        unreadRows: root.querySelectorAll("[data-activity-row][data-activity-unread]").length,
        dividers: root.querySelectorAll("[data-activity-unread-divider]").length,
        dividerCount: root.querySelector("[data-activity-unread-count]")?.textContent?.trim() ?? null,
        pillHidden: document.querySelector('[data-nav-count="activity"]')?.hasAttribute("hidden") ?? null,
        pillText: document.querySelector('[data-nav-count="activity"]')?.textContent?.trim() ?? null,
        count: root.querySelector("[data-activity-filter-count]")?.textContent?.trim() ?? "",
      });
      const before = read();
      root.querySelector("[data-activity-mark-read]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { before, after: read() };
    });

    // B26.6 — `Load older` unfolds the next page of day groups and retires.
    const b26Older = await page.evaluate(async () => {
      const root = document.querySelector("[data-activity-view]");
      const foot = root.querySelector(".td-activity-foot");
      const read = () => ({
        days: root.querySelectorAll("[data-activity-day]").length,
        rows: root.querySelectorAll("[data-activity-row]").length,
        footHidden: foot.hasAttribute("hidden"),
        pages: [...root.querySelectorAll("[data-activity-day]")].map((day) => day.getAttribute("data-activity-page")),
      });
      const before = read();
      root.querySelector("[data-activity-more]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { before, after: read() };
    });

    // §6 / F2 — a row opens the board's own drawer (B09), and the task anchor is
    // the row's second way into the same drawer: pressing it opens it **in place**,
    // so the view stays the activity view. (It used to route back to the board.)
    const b26Drawer = await page.evaluate(async () => {
      const root = document.querySelector("[data-activity-view]");
      const row = root.querySelector("[data-activity-row]");
      const identifier = row.getAttribute("data-task");
      row.querySelector("[data-activity-open]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const drawer = document.querySelector("[data-detail-drawer]");
      const opened = {
        state: drawer?.getAttribute("data-state") ?? null,
        identifier: drawer?.getAttribute("data-identifier") ?? null,
        rows: root.querySelectorAll("[data-activity-row]").length,
      };
      return { identifier, opened };
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const b26Link = await page.evaluate(() => {
      const root = document.querySelector("[data-activity-view]");
      const link = root.querySelector("[data-activity-task]");
      const href = link.getAttribute("href");
      link.click();
      return { href };
    });
    await page.waitForTimeout(250);
    const b26AfterLink = await page.evaluate(() => {
      const drawer = document.querySelector("[data-detail-drawer]");
      return {
        feedView: document.querySelector("[data-activity-view]")?.hasAttribute("hidden") === false,
        boardView: document.querySelector("[data-board-view]")?.hasAttribute("hidden") === false,
        drawerState: drawer?.getAttribute("data-state") ?? null,
        identifier: drawer?.getAttribute("data-identifier") ?? null,
      };
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // The press no longer leaves the feed, so the geometry sweep below is already
    // on the surface it means to measure — there is no view to step back into.

    // §7 / §9 — no sideways overflow with the feed open, at the five review tiers.
    const b26ViewportFailures = [];
    for (const width of [1512, 1240, 980, 760, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(180);
      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
      });
      if (overflow.scrollWidth > overflow.clientWidth + 1) {
        b26ViewportFailures.push(`activity view overflows at ${width}: ${overflow.scrollWidth} > ${overflow.clientWidth}`);
      }
    }
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.waitForTimeout(150);

    // §9.1 — the view's copy comes from the one catalogue, and a language switch
    // translates it (no bare key may survive anywhere in the view).
    await page.evaluate(() => document.querySelector('[data-lang-option="zh"]')?.click());
    await page.waitForTimeout(200);
    const b26Zh = await page.evaluate(() => {
      const root = document.querySelector("[data-activity-view]");
      return {
        title: root.querySelector("[data-activity-title]")?.textContent?.trim() ?? null,
        day: root.querySelector("[data-activity-day-label]")?.textContent?.trim() ?? null,
        openLabel: root.querySelector("[data-activity-open]")?.getAttribute("aria-label") ?? null,
        keyText: [...root.querySelectorAll("[data-i18n]")].filter((el) => el.textContent.trim() === el.getAttribute("data-i18n")).length,
        // R15 ①/③/⑤ — the converted controls' copy is the catalogue's, so a
        // language switch re-states every trigger (they carry no `data-i18n` seat
        // of their own, the way the board's label and status triggers do not)
        // and the activity bar's own accessible name is the dedicated word.
        activityTriggers: ["actor", "event", "task"].map(
          (slot) => root.querySelector(`[data-activity-filter="${slot}"] [data-activity-filter-text]`)?.textContent?.trim() ?? null,
        ),
        activityBarLabel: root.querySelector("[data-activity-filters]")?.getAttribute("aria-label") ?? null,
        clearText: root.querySelector("[data-activity-filters] [data-filter-clear]")?.textContent?.trim() ?? null,
        boardTriggers: ["[data-filter-assignee-text]", "[data-filter-priority-text]"].map(
          (selector) => document.querySelector(selector)?.textContent?.trim() ?? null,
        ),
        waitingSub: document.querySelector("[data-waiting-head] p")?.textContent?.trim() ?? null,
      };
    });
    await page.evaluate(() => document.querySelector('[data-lang-option="en"]')?.click());
    await page.waitForTimeout(200);
    const b26En = await page.evaluate(() => {
      const root = document.querySelector("[data-activity-view]");
      return {
        title: root.querySelector("[data-activity-title]")?.textContent?.trim() ?? null,
        openLabel: root.querySelector("[data-activity-open]")?.getAttribute("aria-label") ?? null,
      };
    });

    const noiseEvents = [
      "task_heartbeat",
      "session_registered",
      "session_closed",
      "progress",
      "label_gc",
      "project_created",
      "project_updated",
      "attachment_updated",
      "import_completed",
    ];
    b26Check(b26Rest.rootHidden === false, "the activity view must not be hidden after its nav press");
    b26Check(b26Rest.rootPainted === true, "the activity view must be painted");
    b26Check(b26Rest.navCurrents.length === 1 && b26Rest.navCurrents[0] === "activity", `nav current ${b26Rest.navCurrents.join(",")}`);
    b26Check(
      b26Rest.boardHidden === true && b26Rest.listHidden === true && !b26Rest.boardPainted && !b26Rest.listPainted && !b26Rest.waitingPainted,
      `board/list/waiting must all stand down (painted ${b26Rest.boardPainted}/${b26Rest.listPainted}/${b26Rest.waitingPainted})`,
    );
    b26Check(b26Rest.toastSeats === toastSeatsBefore, "the nav press must not raise a toast");
    b26Check(b26Rest.dayCount >= 3, `day groups ${b26Rest.dayCount} < 3`);
    b26Check(b26Rest.dayKeys.every((key, index) => index === 0 || key < b26Rest.dayKeys[index - 1]), `day keys not strictly decreasing: ${b26Rest.dayKeys.join(",")}`);
    b26Check(b26Rest.rowAts.every((at, index) => index === 0 || at <= b26Rest.rowAts[index - 1]), "rows must be newest-first in document order");
    b26Check(b26Rest.rowsOwnedByOneDay.every((count) => count === 1), "every row must sit inside exactly one day group");
    b26Check(b26Rest.stampMatches.every(Boolean), "each row's visible stamp must equal its own data-at");
    b26Check(b26Rest.detailTags.every((tag) => tag === "DETAILS"), "the row detail must be a native <details>");
    b26Check(b26Rest.rowEvents.every((event) => !noiseEvents.includes(event)), `noise reached the feed: ${b26Rest.rowEvents.join(",")}`);
    b26Check(b26Rest.invisibleRows === 0, `${b26Rest.invisibleRows} rows are hidden without a filter`);
    b26Check(b26Rest.incompleteRows === 0, `${b26Rest.incompleteRows} rows are missing one of their six fields`);
    b26Check(b26Rest.linesOutsideRows === 0, `${b26Rest.linesOutsideRows} [data-activity-line] nodes sit outside a row`);
    b26Check(b26Rest.dayPages.every((page) => Number(page) === 1), `day pages before \`Load older\`: ${b26Rest.dayPages.join(",")}`);
    b26Check(
      JSON.stringify(b26Rest.hookNames) === JSON.stringify(B26_HOOK_NAMES),
      `the view's data-activity-* vocabulary drifted: ${b26Rest.hookNames.filter((n) => !B26_HOOK_NAMES.includes(n)).join(",") || "—"} extra, ${B26_HOOK_NAMES.filter((n) => !b26Rest.hookNames.includes(n)).join(",") || "—"} missing`,
    );
    b26Check(b26Rest.filtersHidden === true && !b26Rest.filtersPainted, "the board's filter bar must stand down on the feed");
    b26Check(b26Rest.countSentence === `${b26Rest.dayRowCounts.reduce((sum, n) => sum + n, 0)} entries`, `count sentence ${b26Rest.countSentence}`);
    b26Check(b26Rest.countArg === String(b26Rest.dayRowCounts.reduce((sum, n) => sum + n, 0)), `count arg ${b26Rest.countArg}`);
    b26Check(b26Rest.pillText === String(b26Rest.unreadRows), `pill ${b26Rest.pillText} !== unread rows ${b26Rest.unreadRows}`);
    b26Check(b26Rest.pillHidden === false, "a non-zero unread count must not be hidden");
    b26Check(b26Rest.dividers === 1, `unread dividers ${b26Rest.dividers} !== 1`);
    b26Check(b26Rest.dividerCount === b26Rest.pillText, `divider count ${b26Rest.dividerCount} !== pill ${b26Rest.pillText}`);
    b26Check(b26Rest.emptyShown.length === 0, `an empty state is showing on a full ledger: ${b26Rest.emptyShown.join(",")}`);
    b26Check(b26Rest.projectEmptyPresent === 1 && b26Rest.filterEmptyReset === 1, "both empty states must exist, the filter one holding its reset");
    b26Check(b26Rest.morePresent === 1, "`Load older` must exist");
    b26Check(b26Rest.footHidden === false, "`Load older` must be offered while a page is unread");
    b26Check(b26Rest.lineHeight === "30px", `row height ${b26Rest.lineHeight} !== 30px`);
    b26Check(b26Burst.rows === 1, `burst rows ${b26Burst.rows} !== 1`);
    b26Check(b26Burst.label === `×${b26Burst.members}`, `burst label ${b26Burst.label} vs ${b26Burst.members} members`);
    b26Check(b26Burst.value === String(b26Burst.members), `burst attribute ${b26Burst.value} vs ${b26Burst.members} members`);
    b26Check((b26Burst.labelCount ?? "").startsWith(String(b26Burst.members)), `burst summary ${b26Burst.labelCount}`);
    b26Check(b26Burst.members >= 2, `a burst must fold at least two rows, got ${b26Burst.members}`);
    b26Check(b26Burst.memberSpanMs !== null && b26Burst.memberSpanMs <= 5 * 60_000, `burst window ${b26Burst.memberSpanMs}ms exceeds five minutes`);
    b26Check(b26Burst.memberTask === b26Burst.rowTask && b26Burst.memberActors.every((actor) => actor === b26Burst.rowActor), "a burst may only fold one actor's edits on one task");
    b26Check(b26Burst.rowGroup === "meta", `a folded row's group must be meta, got ${b26Burst.rowGroup}`);
    b26Check(b26Detail.lines >= 1, "an opened row must show its changes");
    b26Check(b26Detail.position === "absolute", `the change panel must be positioned, got ${b26Detail.position}`);
    b26Check(b26Detail.display !== "none", "an opened panel must be displayed");
    b26Check(b26Detail.reflowedFeed === false && b26Detail.reflowedBody === false, "opening a row must not reflow the feed");
    b26Check(b26Filters.agent.rows > 0 && b26Filters.agent.kinds.length === 1 && b26Filters.agent.kinds[0] === "agent", `actor=agent left ${b26Filters.agent.kinds.join(",")}`);
    b26Check(b26Filters.agent.count === `${b26Filters.agent.rows} entries`, `actor=agent count ${b26Filters.agent.count} for ${b26Filters.agent.rows} rows`);
    b26Check(b26Filters.agent.search === "?actor=agent", `actor=agent query ${b26Filters.agent.search}`);
    b26Check(b26Filters.agentDelivery.groups.join(",") === "delivery", `agent+delivery groups ${b26Filters.agentDelivery.groups.join(",")}`);
    b26Check(b26Filters.task.tasks.length === 1 && b26Filters.task.tasks[0] === "TD-6", `task=TD-6 left ${b26Filters.task.tasks.join(",")}`);
    b26Check(b26Filters.emptyMatch.rows === 0, `the empty filter left ${b26Filters.emptyMatch.rows} rows`);
    b26Check(b26Filters.emptyMatch.empty.join(",") === "filter", `empty kind ${b26Filters.emptyMatch.empty.join(",")}`);
    b26Check(b26Filters.emptyMatch.dayCount === 0, "a filter that matches nothing must paint no day group");
    b26Check(b26Filters.afterReset.rows === b26Filters.before.rows, `reset restored ${b26Filters.afterReset.rows} of ${b26Filters.before.rows}`);

    // R15 ① — the three controls are dropdown panels (design/fidelity-r15.md
    // §2.3): the panel paints on a press on the summary, the trigger states the
    // chosen row's own copy, the value rides the control's own attribute, and
    // `aria-current` follows on exactly one row.
    b26Check(b26Filters.openPanel.open === true && b26Filters.openPanel.painted === true, `R15 ①: the actor panel ${b26Filters.openPanel.open}/${b26Filters.openPanel.painted}`);
    b26Check(b26Filters.openPanel.dismiss === true, "R15 ①: the three controls must join the light-dismiss membership");
    b26Check(b26Filters.openPanel.text === "Anyone", `R15 ①: the resting actor trigger reads ${JSON.stringify(b26Filters.openPanel.text)}`);
    b26Check(b26Filters.closedAgain === false, "R15 ①: a second press on the summary must close the panel");
    b26Check(b26Filters.agent.triggers[0] === "Agents", `R15 ①: the actor trigger reads ${JSON.stringify(b26Filters.agent.triggers[0])}`);
    b26Check(b26Filters.agentDelivery.triggers[1] === "Delivery", `R15 ①: the event trigger reads ${JSON.stringify(b26Filters.agentDelivery.triggers[1])}`);
    b26Check(b26Filters.task.triggers[2] === "TD-6", `R15 ①: the task trigger reads ${JSON.stringify(b26Filters.task.triggers[2])}`);
    b26Check(
      b26Filters.agent.values.join(",") === "agent,all,all" && b26Filters.agent.currents.join(",") === "agent,all,all",
      `R15 ①: value/aria-current ${b26Filters.agent.values.join(",")}/${b26Filters.agent.currents.join(",")}`,
    );
    b26Check(b26Filters.afterReset.values.join(",") === "all,all,all", `R15 ①: the empty state's reset left ${b26Filters.afterReset.values.join(",")}`);

    // R15 ③/④ — the bar's Clear is B04's own control, told apart by the bar the
    // press came from: the three activity slots go back to `all`, the board's
    // priority condition is untouched, and the board's own confirmation toast is
    // raised here too (the ruling's ④).
    b26Check(b26Filters.clearHook === true, "R15 ③: the activity bar must carry B04's [data-filter-clear]");
    b26Check(b26Filters.beforeClear.search === "?event=delivery", `R15 ③: the round left the address at ${b26Filters.beforeClear.search}`);
    b26Check(b26Filters.afterClear.values.join(",") === "all,all,all", `R15 ③: Clear left the three slots ${b26Filters.afterClear.values.join(",")}`);
    b26Check(b26Filters.afterClear.rows === b26Filters.before.rows, `R15 ③: Clear restored ${b26Filters.afterClear.rows} of ${b26Filters.before.rows} rows`);
    b26Check(b26Filters.afterClear.search === "", `R15 ③: Clear left the address at ${b26Filters.afterClear.search}`);
    b26Check(b26Filters.afterClear.currents.join(",") === "all,all,all", `R15 ③: Clear left the chosen rows at ${b26Filters.afterClear.currents.join(",")}`);
    b26Check(
      b26Filters.before.boardPriority === "all" && b26Filters.afterClear.boardPriority === "urgent",
      `R15 ③: the board's priority moved "${b26Filters.before.boardPriority}" → "${b26Filters.afterClear.boardPriority}" across the activity round (expected all → urgent: Clear must not touch the board bar)`,
    );
    b26Check(b26Filters.afterBoardRestore.boardPriority === "all", `R15 ③: the board's priority did not return to all (${b26Filters.afterBoardRestore.boardPriority})`);
    b26Check(
      b26Filters.toastAfterClear.some((text) => text === "Filters cleared"),
      `R15 ③/④: Clear must raise the board's own confirmation toast, saw ${JSON.stringify(b26Filters.toastAfterClear)}`,
    );
    // …and let it retire before the sections below, so their toast reads bracket
    // a quiet region (the toast lives 2500ms + a 200ms exit).
    await page.waitForTimeout(2900);
    b26Check(b26Filters.afterReset.search === "", `reset must clear the query, got ${b26Filters.afterReset.search}`);
    b26Check(b26Keys.wrappable === true, `j/k focus walk: first=${b26Keys.first} second=${b26Keys.second} back=${b26Keys.back}`);
    b26Check((b26Keys.firstLabel ?? "").startsWith("Open "), `row button aria-label ${b26Keys.firstLabel}`);
    b26Check(b26Read.before.unreadRows > 0 && b26Read.before.dividers === 1, "a fresh reader must see one boundary over the new rows");
    b26Check(b26Read.after.unreadRows === 0 && b26Read.after.dividers === 0, "`Mark all read` must take the boundary down");
    b26Check(b26Read.after.pillHidden === true, "`Mark all read` must hide the zero pill");
    b26Check(b26Read.after.count === b26Read.before.count, "`Mark all read` must not remove a row");
    b26Check(b26Older.after.days > b26Older.before.days || b26Older.after.footHidden === true, "`Load older` must unfold a day or retire");
    b26Check(b26Older.after.footHidden === true, "`Load older` must retire once the ledger is exhausted");
    b26Check(b26Older.after.rows > b26Older.before.rows, "`Load older` must reveal rows");
    b26Check(
      b26Older.after.pages.includes("2") && b26Older.after.pages.some((page, index) => index > 0 && Number(page) > Number(b26Older.before.pages[index] ?? 1)),
      `\`Load older\` must mark the unfolded days page 2, got ${b26Older.after.pages.join(",")}`,
    );
    b26Check(b26Drawer.opened.state === "open", `a row must open the drawer, state ${b26Drawer.opened.state}`);
    b26Check(b26Drawer.opened.identifier === b26Drawer.identifier, `drawer shows ${b26Drawer.opened.identifier}, row names ${b26Drawer.identifier}`);
    b26Check(b26Link.href === `#/task/${b26Drawer.identifier}`, `task anchor href ${b26Link.href}`);
    b26Check(
      b26AfterLink.feedView === true && b26AfterLink.boardView === false && b26AfterLink.drawerState === "open" && b26AfterLink.identifier === b26Drawer.identifier,
      `the task anchor must open the drawer in place, leaving the activity view on screen (feed=${b26AfterLink.feedView}, board=${b26AfterLink.boardView}, drawer=${b26AfterLink.drawerState}, ${b26AfterLink.identifier})`,
    );
    b26Check(b26ViewportFailures.length === 0, b26ViewportFailures.join("; "));
    b26Check(b26Zh.title === "动态" && b26Zh.day === "今天", `zh copy ${b26Zh.title} / ${b26Zh.day}`);
    b26Check((b26Zh.openLabel ?? "").startsWith("打开 "), `zh open label ${b26Zh.openLabel}`);
    b26Check(b26Zh.keyText === 0, `${b26Zh.keyText} elements render their own key`);
    // R15 ①/③/⑤ — a language switch re-states all five converted triggers (they
    // read the catalogue through the same `$t` the rest of the view does), the
    // bar's clear control is B04's copy in both languages, and the two named
    // landmarks read differently.
    b26Check(
      JSON.stringify(b26Zh.activityTriggers) === JSON.stringify(["任何人", "全部事件", "全部任务"]),
      `R15 ① zh: the activity triggers read ${b26Zh.activityTriggers.join(" / ")}`,
    );
    b26Check(b26Zh.clearText === "清除", `R15 ③ zh: the bar's clear control reads ${JSON.stringify(b26Zh.clearText)}`);
    b26Check(b26Zh.activityBarLabel === "动态筛选", `R15 ⑤ zh: the bar's own name is ${JSON.stringify(b26Zh.activityBarLabel)}`);
    b26Check(
      JSON.stringify(b26Zh.boardTriggers) === JSON.stringify(["负责人：全部", "优先级：全部"]),
      `R15 ② zh: the board's converted triggers read ${b26Zh.boardTriggers.join(" / ")}`,
    );
    b26Check(
      b26Zh.waitingSub === "所有等你答复的事项，最久的排在最前。",
      `R15 ④ zh: the queue's description reads ${JSON.stringify(b26Zh.waitingSub)}`,
    );
    b26Check(b26En.title === "Activity", `en copy after the cycle ${b26En.title}`);
    b26Check((b26En.openLabel ?? "").startsWith("Open "), `en open label ${b26En.openLabel}`);
    await page.click('[data-nav-item="board"]');
    await page.waitForTimeout(120);
    const b26Back = await page.evaluate(() => {
      const bar = document.querySelector("[data-filters]");
      return {
        filtersHidden: bar?.hasAttribute("hidden") ?? null,
        filtersPainted: (bar?.getClientRects().length ?? 0) > 0,
        activityHidden: document.querySelector("[data-activity-view]")?.hasAttribute("hidden") ?? null,
        boardPainted: (document.querySelector("[data-board-view]")?.getClientRects().length ?? 0) > 0,
      };
    });
    b26Check(b26Back.filtersHidden === false && b26Back.filtersPainted, "the filter bar must come back with the board");
    b26Check(b26Back.activityHidden === true && b26Back.boardPainted === true, "the board must come back and the feed stand down");

    // ---- R16 · the address layer (URL routing) --------------------------------
    //
    // The round's own four claims, measured where they can only be measured: in a
    // real browser, on a real address. Every deep link below is a **real load**
    // (`about:blank` → the address), never a `goto` between two URLs that differ
    // only in their fragment: those are same-document navigations, the boot
    // branch does not re-run, and a probe that skipped this would report "the
    // second address is not a route" when what happened is "only the first load
    // was tested" (design/fidelity-r16.md §1 rule 4, which is exactly the trap
    // the contract's own first probe fell into).
    //
    // The history half drives `history.back()` / `forward()` **inside the page**
    // rather than through Playwright's `goBack()`: the entries these presses
    // create are same-document ones, and Playwright's navigation plumbing is
    // built for the other kind. It runs last, because each load re-boots the app.
    const r16Failures = [];
    const r16Check = (ok, message) => { if (!ok) r16Failures.push(message); };
    const R16_ORIGIN = `http://127.0.0.1:${port}`;

    /** What the document says about itself: the address, the nav, the view roots. */
    const readAddress = () =>
      page.evaluate(() => {
        const painted = (selector) => (document.querySelector(selector)?.getClientRects().length ?? 0) > 0;
        return {
          pathname: globalThis.location.pathname,
          search: globalThis.location.search,
          hash: globalThis.location.hash,
          navCurrent: document.querySelector("[data-nav] [data-nav-item][aria-current='page']")?.getAttribute("data-nav-item") ?? null,
          navCurrents: document.querySelectorAll("[data-nav] [data-nav-item][aria-current='page']").length,
          toggles: [...document.querySelectorAll("[data-view-toggle] [data-view]")].map(
            (el) => `${el.getAttribute("data-view")}=${el.getAttribute("aria-pressed")}`,
          ),
          entries: globalThis.history.length,
          board: painted("[data-board-view]"),
          list: painted("[data-list]"),
          activity: painted("[data-activity-view]"),
          waiting: painted("[data-waiting-view]"),
          filterValues: ["actor", "event", "task"].map(
            (slot) => document.querySelector(`[data-activity-filter="${slot}"]`)?.getAttribute("data-activity-filter-value") ?? null,
          ),
        };
      });

    /** A real load of one address, settled enough to read. */
    const loadAddress = async (path) => {
      await page.goto("about:blank");
      await page.goto(`${R16_ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-nav]", { timeout: 20_000 });
      await page.waitForTimeout(400);
      return readAddress();
    };

    // ① — each view has its own address, and a deep link lands on it: the view
    // root is the only one painted, and the sidebar's single `aria-current` is
    // the same view. This is the acceptance's "deep link / refresh must not 404"
    // read from inside the document (the server answers the shell; the *view* is
    // the frontend's, which is the point of the round).
    const r16Routes = {};
    for (const [path, view] of [
      ["/board", "board"],
      ["/list", "list"],
      ["/activity", "activity"],
      ["/waiting", "waiting"],
    ]) {
      const seen = await loadAddress(path);
      r16Routes[path] = seen;
      r16Check(seen.pathname === path, `${path} landed on ${seen.pathname}`);
      r16Check(seen.navCurrent === view && seen.navCurrents === 1, `${path} nav current ${seen.navCurrent} (${seen.navCurrents} marked)`);
      r16Check(seen[view] === true, `${path} painted the wrong view: ${JSON.stringify({ board: seen.board, list: seen.list, activity: seen.activity, waiting: seen.waiting })}`);
      r16Check(
        ["board", "list", "activity", "waiting"].filter((name) => seen[name]).length === 1,
        `${path} painted more than one view root`,
      );
    }

    // §4.3 step 6 — a `/activity` deep link must come up with its **ledger**, not
    // with the "nothing has ever happened here" state. The feed's read is driven
    // by the view, so this is the assertion that the boot reader really does run
    // after the view watcher is alive: a reader wired in too early would land a
    // deep link on a ledger that had not been read and would announce the project
    // empty state over a project with twelve rows in it.
    await page.goto("about:blank");
    await page.goto(`${R16_ORIGIN}/activity`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-activity-row]", { timeout: 20_000 }).catch(() => {});
    const r16DeepFeed = await page.evaluate(() => ({
      rows: document.querySelectorAll("[data-activity-row]").length,
      emptyShown: [...document.querySelectorAll("[data-activity-empty]")].filter((el) => !el.hasAttribute("hidden")).length,
    }));
    r16Check(
      r16DeepFeed.rows > 0 && r16DeepFeed.emptyShown === 0,
      `a /activity deep link showed ${r16DeepFeed.rows} rows and ${r16DeepFeed.emptyShown} empty states`,
    );

    // ② — the default entry point is the board, and the address says so.
    for (const alias of ["/", "/index.html"]) {
      const seen = await loadAddress(alias);
      r16Check(seen.pathname === "/board" && seen.navCurrent === "board" && seen.board, `${alias} did not land on the board (${seen.pathname}/${seen.navCurrent})`);
    }
    // …and a path that is not a route is silently corrected to the same place,
    // which is the whole reason the server may answer 200 for anything.
    const r16Unknown = await loadAddress("/borad");
    r16Check(r16Unknown.pathname === "/board" && r16Unknown.board, `/borad was not corrected to the board (${r16Unknown.pathname})`);

    // The drawer's own fragment is not a route and survives the correction.
    const r16Drawer = await loadAddress("/#/task/TD-1");
    r16Check(
      r16Drawer.pathname === "/board" && r16Drawer.hash === "#/task/TD-1" && r16Drawer.board,
      `a drawer fragment was consumed: ${r16Drawer.pathname}${r16Drawer.hash}`,
    );

    // §4.4 / 裁定 ① — an old share link is read, entered and redirected to the
    // query form, and the fragment it arrived in is consumed.
    const r16Legacy = await loadAddress("/#/activity?actor=agent&event=status&task=TD-128");
    r16Check(
      r16Legacy.pathname === "/activity" && r16Legacy.search === "?actor=agent&event=status&task=TD-128" && r16Legacy.hash === "",
      `the old feed address redirected to ${r16Legacy.pathname}${r16Legacy.search}${r16Legacy.hash}`,
    );
    r16Check(r16Legacy.activity && r16Legacy.navCurrent === "activity", "an old feed address must enter the feed");
    r16Check(r16Legacy.filterValues.join(",") === "agent,status,TD-128", `the old address restored ${r16Legacy.filterValues.join(",")}`);
    const r16LegacyBare = await loadAddress("/#/activity");
    r16Check(
      r16LegacyBare.pathname === "/activity" && r16LegacyBare.search === "" && r16LegacyBare.hash === "",
      `the bare old address redirected to ${r16LegacyBare.pathname}${r16LegacyBare.search}${r16LegacyBare.hash}`,
    );

    // ③ — the nav writes the address, a filter narrows it in place, and back /
    // forward walk the views (and only the views: a filter is a `replaceState`,
    // so it is never an entry).
    await page.goto("about:blank");
    await page.goto(`${R16_ORIGIN}/board`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-nav]", { timeout: 20_000 });
    await page.waitForTimeout(400);
    const r16Before = await readAddress();
    await page.click('[data-nav-item="activity"]');
    await page.waitForTimeout(250);
    const r16AtFeed = await readAddress();
    r16Check(r16AtFeed.pathname === "/activity" && r16AtFeed.navCurrent === "activity", `the nav press wrote ${r16AtFeed.pathname}`);
    r16Check(r16AtFeed.entries === r16Before.entries + 1, `a view change must add one history entry (${r16Before.entries} → ${r16AtFeed.entries})`);
    // A filter is writer B: the query changes, the path and the entry count do not.
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const host = document.querySelector('[data-activity-filter="actor"]');
      host.querySelector("summary")?.click();
      await sleep(40);
      host.querySelector('[data-activity-filter-option][data-activity-value="agent"]')?.click();
      await sleep(80);
    });
    const r16Filtered = await readAddress();
    r16Check(r16Filtered.search === "?actor=agent" && r16Filtered.pathname === "/activity", `a filter wrote ${r16Filtered.pathname}${r16Filtered.search}`);
    r16Check(r16Filtered.entries === r16AtFeed.entries, `a filter must not add a history entry (${r16AtFeed.entries} → ${r16Filtered.entries})`);
    await page.click('[data-nav-item="waiting"]');
    await page.waitForTimeout(250);
    const r16AtQueue = await readAddress();
    r16Check(r16AtQueue.pathname === "/waiting" && r16AtQueue.waiting && r16AtQueue.navCurrent === "waiting", `the queue landed on ${r16AtQueue.pathname}`);
    r16Check(r16AtQueue.toggles.join(",") === "board=false,list=false", `on /waiting the toggle reads ${r16AtQueue.toggles.join(",")}`);

    await page.evaluate(() => globalThis.history.back());
    await page.waitForTimeout(250);
    const r16BackOne = await readAddress();
    r16Check(
      r16BackOne.pathname === "/activity" && r16BackOne.search === "?actor=agent" && r16BackOne.activity,
      `back #1 landed on ${r16BackOne.pathname}${r16BackOne.search}`,
    );
    r16Check(r16BackOne.filterValues[0] === "agent", `back #1 lost the filter the address names (${r16BackOne.filterValues.join(",")})`);
    await page.evaluate(() => globalThis.history.back());
    await page.waitForTimeout(250);
    const r16BackTwo = await readAddress();
    r16Check(r16BackTwo.pathname === "/board" && r16BackTwo.board && r16BackTwo.navCurrent === "board", `back #2 landed on ${r16BackTwo.pathname}`);
    r16Check(r16BackTwo.toggles.join(",") === "board=true,list=false", `on /board the toggle reads ${r16BackTwo.toggles.join(",")}`);
    await page.evaluate(() => globalThis.history.forward());
    await page.waitForTimeout(250);
    const r16Forward = await readAddress();
    r16Check(r16Forward.pathname === "/activity" && r16Forward.activity, `forward landed on ${r16Forward.pathname}`);

    // C8 / F2 — a row's task anchor opens the drawer in place and writes no
    // address at all: the view stays the feed's, the filters stay in the query,
    // and the fragment stays free for the drawer's own `#/task/<id>` deep link
    // (§4.4). It no longer routes back to the board, so it adds no history entry
    // and moves no `aria-current`.
    const r16Anchor = await page.evaluate(() => {
      document.querySelector("[data-activity-task]")?.click();
      return true;
    });
    await page.waitForTimeout(300);
    const r16AfterAnchor = await readAddress();
    r16Check(
      r16Anchor && r16AfterAnchor.pathname === "/activity" && r16AfterAnchor.search === r16Forward.search && r16AfterAnchor.hash === "",
      `the task anchor left the address at ${r16AfterAnchor.pathname}${r16AfterAnchor.search}${r16AfterAnchor.hash} (the feed was on ${r16Forward.pathname}${r16Forward.search})`,
    );
    r16Check(r16AfterAnchor.activity && !r16AfterAnchor.board, `the task anchor must leave the activity view on screen (activity=${r16AfterAnchor.activity}, board=${r16AfterAnchor.board})`);
    r16Check(r16AfterAnchor.navCurrent === "activity", `the task anchor moved \`aria-current\` to ${r16AfterAnchor.navCurrent}`);
    // No `history.length` assertion here on purpose: this leg of the harness runs
    // at the tab's session-history cap (measured: 48 entries, so a `pushState` no
    // longer moves the number), which would make "must not add an entry" pass
    // whether or not the anchor wrote one. The address assertion above is the one
    // that discriminates — with the old `navigate("board")` in place it reports
    // "left the address at /board" and goes red.

    // ---- the loading skeletons ------------------------------------------------
    //
    // Every view shows a skeleton **only while a real read is in flight** (the
    // product ruling behind the screens): a project switch, the list's entry read,
    // the activity backfill, the waiting payloads, and the drawer's card read. The
    // harness holds each request open and samples inside the window — nothing in
    // `web/src` is slowed down.
    //
    // It runs **after** R16 on purpose: its view switches push history entries, and
    // R16's own "a view change writes one entry" check reads `history.length`,
    // which Chromium caps at 50. R16 leaves the page on the activity feed with a
    // drawer open, so the section starts by returning to the board. Every delay
    // is restored in `finally`.
    const skeletonFailures = [];
    const skeletonCheck = (ok, message) => { if (!ok) skeletonFailures.push(message); };
    let skeletonReadings = {};

    /** Everything the legs read, in one round trip. "Painted" = has a client rect. */
    const readSkeletons = () =>
      page.evaluate(() => {
        const painted = (el) => !!el && el.getClientRects().length > 0;
        const paintedAll = (sel) => [...document.querySelectorAll(sel)].filter(painted).length;
        const view = document.querySelector("[data-board-view]");
        const list = document.querySelector("[data-list]");
        const activityRoot = document.querySelector("[data-activity-view]");
        const waitingRoot = document.querySelector("[data-waiting-view]");
        const drawer = document.querySelector("[data-detail-drawer]");
        return {
          board: {
            loading: view?.getAttribute("data-view-loading") ?? null,
            busy: view?.getAttribute("aria-busy") ?? null,
            state: view?.getAttribute("data-board-state") ?? null,
            groups: paintedAll('[data-view-skeleton="board"]'),
            skeletonCards: paintedAll('[data-view-skeleton="board"] .td-skel-card'),
            cards: paintedAll("[data-board] [data-card]"),
            columnEmpties: paintedAll('[data-empty][data-empty-kind="column"]'),
            columns: paintedAll("[data-board] [data-column]"),
            counts: [...document.querySelectorAll("[data-column-count]")].map((el) => el.textContent.trim()),
          },
          list: {
            state: list?.getAttribute("data-list-state") ?? null,
            skeleton: painted(document.querySelector("[data-skeleton]")),
            rowsShown: painted(document.querySelector("[data-list-rows]")),
            rows: document.querySelectorAll("[data-list-rows] [data-list-row]").length,
          },
          activity: {
            loading: activityRoot?.getAttribute("data-view-loading") ?? null,
            busy: activityRoot?.getAttribute("aria-busy") ?? null,
            skeleton: painted(document.querySelector('[data-view-skeleton="activity"]')),
            days: paintedAll("[data-activity-day]"),
            empties: paintedAll("[data-activity-empty]"),
            rows: paintedAll("[data-activity-row]"),
          },
          waiting: {
            loading: waitingRoot?.getAttribute("data-view-loading") ?? null,
            busy: waitingRoot?.getAttribute("aria-busy") ?? null,
            skeleton: painted(document.querySelector('[data-view-skeleton="waiting"]')),
            listPainted: painted(document.querySelector("[data-waiting-list]")),
            emptyPainted: painted(document.querySelector("[data-waiting-empty]")),
            rows: paintedAll("[data-waiting-item]"),
          },
          detail: {
            state: drawer?.getAttribute("data-state") ?? null,
            busy: drawer?.getAttribute("aria-busy") ?? null,
            skeletons: paintedAll("[data-detail-skeleton]"),
            realTitle: !!document.querySelector("[data-detail-title]"),
            overlay: painted(document.querySelector("[data-detail-overlay]")),
          },
        };
      });

    /** Wait until a view root says its read has landed (`data-view-loading`). */
    const waitForViewSettled = (selector) =>
      page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("data-view-loading") === "false",
        selector,
        { timeout: 20_000 },
      );

    const pickProject = async (name) => {
      await page.click("[data-project-switcher] > summary");
      await page.waitForTimeout(150);
      await page.click(`[data-project-option="${name}"]`);
    };

    try {
      await page.setViewportSize({ width: 1512, height: 950 });
      // R16's last leg opens a drawer in place on the activity feed.
      await page.evaluate(() => document.querySelector("[data-detail-close]")?.click());
      await page.waitForTimeout(250);
      await page.click('[data-nav-item="board"]');
      await page.waitForTimeout(150);
      await waitForViewSettled("[data-board-view]");
      await page.waitForTimeout(120);
      const settledBoard = await readSkeletons();
      const cardsBefore = settledBoard.board.cards;
      skeletonCheck(cardsBefore > 0, "the populated board draws no card to compare against");

      // S1 — board, top-bar dropdown, populated → empty project.
      tasksDelayMs = 900;
      await pickProject("Orchestrator");
      await page.waitForTimeout(200);
      const s1 = await readSkeletons();
      skeletonCheck(s1.board.loading === "true", `S1 board: data-view-loading is ${s1.board.loading}`);
      skeletonCheck(s1.board.busy === "true", `S1 board: aria-busy is ${s1.board.busy}`);
      skeletonCheck(s1.board.state === "data", `S1 board: data-board-state is ${s1.board.state}`);
      skeletonCheck(s1.board.groups === 7, `S1 board: ${s1.board.groups} column skeletons, expected 7`);
      skeletonCheck(s1.board.skeletonCards === 21, `S1 board: ${s1.board.skeletonCards} skeleton cards, expected 21 (3 per column)`);
      skeletonCheck(s1.board.cards === 0, `S1 board: ${s1.board.cards} cards painted during the read`);
      skeletonCheck(s1.board.columnEmpties === 0, `S1 board: ${s1.board.columnEmpties} column empty states painted during the read`);
      skeletonCheck(s1.board.counts.every((text) => text === "0"), `S1 board: column counts read ${s1.board.counts.join(",")} during the read`);
      tasksDelayMs = 0;
      await waitForViewSettled("[data-board-view]");
      await page.waitForTimeout(120);
      const s1Done = await readSkeletons();
      skeletonCheck(s1Done.board.groups === 0, `S1 board: ${s1Done.board.groups} skeletons survive the settled read`);
      skeletonCheck(s1Done.board.state === "empty", `S1 board: the empty project settles to ${s1Done.board.state}`);

      // S2 — board, sidebar row, empty → populated project.
      tasksDelayMs = 900;
      await page.click('[data-project-list] [data-project="MeerkatTaskPanel"]');
      await page.waitForTimeout(200);
      const s2 = await readSkeletons();
      skeletonCheck(s2.board.loading === "true" && s2.board.groups === 7, `S2 board: ${s2.board.loading}/${s2.board.groups} during the sidebar switch`);
      skeletonCheck(s2.board.cards === 0, `S2 board: ${s2.board.cards} cards painted during the sidebar switch`);
      tasksDelayMs = 0;
      await waitForViewSettled("[data-board-view]");
      await page.waitForTimeout(150);
      const s2Done = await readSkeletons();
      skeletonCheck(s2Done.board.cards === cardsBefore, `S2 board: ${s2Done.board.cards} cards after the switch, expected ${cardsBefore}`);
      skeletonCheck(
        s2Done.board.counts.reduce((sum, text) => sum + Number(text), 0) === cardsBefore,
        `S2 board: the column counts sum to ${s2Done.board.counts.reduce((sum, text) => sum + Number(text), 0)}, expected ${cardsBefore}`,
      );

      // S3 — list, a project switch while the view is already open. This is the
      // regression the single `listLoading` computed exists for: the attribute,
      // the skeleton and the rows must all follow the *combined* state.
      await page.click('[data-view="list"]');
      await waitForListSettled();
      await page.waitForTimeout(120);
      tasksDelayMs = 900;
      await pickProject("Orchestrator");
      await page.waitForTimeout(200);
      const s3 = await readSkeletons();
      skeletonCheck(s3.list.state === "loading", `S3 list: data-list-state is ${s3.list.state} during a project switch`);
      skeletonCheck(s3.list.skeleton && !s3.list.rowsShown, `S3 list: skeleton ${s3.list.skeleton} / rows host ${s3.list.rowsShown} during the read`);
      skeletonCheck(s3.list.rows === 0, `S3 list: the loading list holds ${s3.list.rows} row(s)`);
      tasksDelayMs = 0;
      await waitForListSettled();
      await page.waitForTimeout(120);
      const s3Done = await readSkeletons();
      skeletonCheck(s3Done.list.state === "data" && !s3Done.list.skeleton, `S3 list: settles to ${s3Done.list.state} (skeleton ${s3Done.list.skeleton})`);
      await pickProject("MeerkatTaskPanel");
      await waitForListSettled();
      await page.waitForTimeout(120);
      await page.click('[data-view="board"]');
      await page.waitForTimeout(120);

      // S4 — activity: the board-wide backfill. Switch away from the ledger first
      // so the next entry is a real backfill, then hold the read open.
      await page.click('[data-nav-item="activity"]');
      await waitForViewSettled("[data-activity-view]");
      await page.waitForTimeout(150);
      await pickProject("Orchestrator");
      await waitForViewSettled("[data-activity-view]");
      await page.waitForTimeout(150);

      activitiesDelayMs = 900;
      await pickProject("MeerkatTaskPanel");
      await page.waitForTimeout(250);
      const s4 = await readSkeletons();
      skeletonCheck(s4.activity.loading === "true", `S4 activity: data-view-loading is ${s4.activity.loading}`);
      skeletonCheck(s4.activity.busy === "true", `S4 activity: aria-busy is ${s4.activity.busy}`);
      skeletonCheck(s4.activity.skeleton, "S4 activity: the skeleton is not painted");
      skeletonCheck(s4.activity.days === 0, `S4 activity: ${s4.activity.days} day group(s) painted during the read`);
      skeletonCheck(s4.activity.empties === 0, `S4 activity: ${s4.activity.empties} empty state(s) painted during the read`);
      activitiesDelayMs = 0;
      await waitForViewSettled("[data-activity-view]");
      await page.waitForTimeout(200);
      const s4Done = await readSkeletons();
      skeletonCheck(!s4Done.activity.skeleton && s4Done.activity.rows > 0, `S4 activity: settles with ${s4Done.activity.rows} rows (skeleton ${s4Done.activity.skeleton})`);

      // S5 — waiting: a pure view entry issues no read (no skeleton), a project
      // switch does (skeleton), and the empty state waits for the read.
      await page.click('[data-nav-item="waiting"]');
      await waitForViewSettled("[data-waiting-view]");
      await page.waitForTimeout(150);
      const s5Rest = await readSkeletons();
      skeletonCheck(s5Rest.waiting.loading === "false", `S5 waiting: a view entry is in a read (${s5Rest.waiting.loading})`);
      skeletonCheck(!s5Rest.waiting.skeleton && s5Rest.waiting.listPainted, "S5 waiting: the settled queue is not the list");

      tasksDelayMs = 900;
      await pickProject("Orchestrator");
      await page.waitForTimeout(200);
      const s5 = await readSkeletons();
      skeletonCheck(s5.waiting.loading === "true", `S5 waiting: data-view-loading is ${s5.waiting.loading}`);
      skeletonCheck(s5.waiting.busy === "true", `S5 waiting: aria-busy is ${s5.waiting.busy}`);
      skeletonCheck(s5.waiting.skeleton, "S5 waiting: the skeleton is not painted");
      skeletonCheck(!s5.waiting.listPainted && !s5.waiting.emptyPainted, `S5 waiting: queue ${s5.waiting.listPainted} / empty ${s5.waiting.emptyPainted} painted during the read`);
      tasksDelayMs = 0;
      await waitForViewSettled("[data-waiting-view]");
      await page.waitForTimeout(150);
      const s5Done = await readSkeletons();
      skeletonCheck(!s5Done.waiting.skeleton && s5Done.waiting.emptyPainted, `S5 waiting: the empty project settles to queue ${s5Done.waiting.listPainted} / empty ${s5Done.waiting.emptyPainted}`);

      await pickProject("MeerkatTaskPanel");
      await waitForViewSettled("[data-waiting-view]");
      await page.waitForTimeout(200);
      const s5Back = await readSkeletons();
      skeletonCheck(s5Back.waiting.rows >= 1 && !s5Back.waiting.emptyPainted, `S5 waiting: back on the populated project, ${s5Back.waiting.rows} row(s)`);

      // S6 — the drawer: the panel opens with its skeleton before the card read
      // lands (it used to stay invisible until every read returned).
      await page.click('[data-nav-item="board"]');
      await page.waitForTimeout(150);
      detailDelayMs = 900;
      await page.click("[data-board] [data-card]");
      await page.waitForTimeout(250);
      const s6 = await readSkeletons();
      skeletonCheck(s6.detail.state === "open", `S6 drawer: data-state is ${s6.detail.state} during the card read`);
      skeletonCheck(s6.detail.busy === "true", `S6 drawer: aria-busy is ${s6.detail.busy}`);
      skeletonCheck(s6.detail.skeletons === 2, `S6 drawer: ${s6.detail.skeletons} skeleton blocks painted, expected 2 (head + body)`);
      skeletonCheck(!s6.detail.realTitle, "S6 drawer: the real title is already rendered during the read");
      skeletonCheck(s6.detail.overlay, "S6 drawer: the scrim is not painted with the panel");
      detailDelayMs = 0;
      await page.waitForSelector("[data-detail-title]", { state: "attached", timeout: 20_000 });
      await page.waitForTimeout(150);
      const s6Done = await readSkeletons();
      skeletonCheck(s6Done.detail.skeletons === 0, `S6 drawer: ${s6Done.detail.skeletons} skeleton blocks survive the read`);
      skeletonCheck(s6Done.detail.busy === "false" && s6Done.detail.realTitle, `S6 drawer: settles to busy ${s6Done.detail.busy}, title ${s6Done.detail.realTitle}`);
      await page.click("[data-detail-close]");
      await page.waitForTimeout(250);

      skeletonReadings = { cardsBefore, s1, s1Done, s2, s2Done, s3, s3Done, s4, s4Done, s5Rest, s5, s5Done, s5Back, s6, s6Done };
    } catch (err) {
      skeletonFailures.push(`the skeleton legs could not run: ${err.message}`);
    } finally {
      tasksDelayMs = 0;
      activitiesDelayMs = 0;
      detailDelayMs = 0;
      // Leave the run where the following sections expect it: board view, the
      // populated project, no overlay. A failure above may leave the drawer open.
      await page.evaluate(() => document.querySelector("[data-detail-close]")?.click()).catch(() => {});
      await page.click('[data-nav-item="board"]').catch(() => {});
      await page.waitForTimeout(150);
      const current = await page.evaluate(() => document.querySelector('[data-project-list] [aria-current="page"]')?.getAttribute("data-project") ?? null);
      if (current !== "MeerkatTaskPanel") await pickProject("MeerkatTaskPanel").catch(() => {});
      await page.waitForTimeout(150);
    }

    // ---- M7 · C-PREFIX-1 — a refused create is visible (T-20261014-042811) ---
    //
    // The round's own question, one layer above the wire: when `POST /api/v1/projects`
    // answers 400 or 409, does the reader see anything at all? Until this leg's
    // subject was written `CreateProjectModal.submit()` had **no `catch`**, so the
    // dialog simply sat there and the only trace was a rejected promise in the
    // console — the contract's §9 C4/C6 rows were green while the UI was silent
    // (§6 M7: 失败可见 / 弹窗留守 / 无成功 toast / 无落库; the copy is
    // implementation-side by §7.5, so nothing here reads the words).
    //
    // This is the harness's one section that drives the **real** board instead of
    // the fixture. The two refusals it turns on are rules of
    // `src/core/commands/projects.mjs` — a prefix that normalizes away, and one
    // another project already numbers its cards with — so a fixture taught to
    // refuse them would be a second copy of the rule under test. A real `taskd`
    // boots on an ephemeral port over a throwaway data dir, seeded with the one
    // project that owns the effective prefix `DEMO` (the CLI carrier of §9 C4),
    // and the built app is driven the way a reader drives it: switcher → New
    // project → type → submit.
    const m7Failures = [];
    const m7Check = (ok, message) => { if (!ok) m7Failures.push(message); };
    const m7 = { cases: {}, statuses: [], consoleErrors: [], pageErrors: [], appConsoleErrors: [] };
    let m7Context = null;
    let m7Taskd = null;
    let m7Dir = null;
    try {
      const { createTaskd } = await import("../../src/server/index.mjs");
      m7Dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-m7-"));
      m7Taskd = await createTaskd({ dataDir: m7Dir, host: "127.0.0.1", port: 0, env: {} });

      const m7Seed = await fetch(`${m7Taskd.url}/api/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "demo", name: "From the CLI" }),
      });
      m7Check(m7Seed.status === 200 || m7Seed.status === 201, `the seed project (--id demo) failed: ${m7Seed.status}`);

      /** The board's projects, by name — what "no project may land" is read against. */
      const m7Projects = async () => {
        const envelope = await (await fetch(`${m7Taskd.url}/api/v1/projects`)).json();
        return envelope.data.projects.map((project) => project.name);
      };

      m7Context = await browser.newContext();
      const m7Page = await m7Context.newPage();
      m7Page.on("console", (msg) => { if (msg.type() === "error") m7.consoleErrors.push(msg.text()); });
      m7Page.on("pageerror", (error) => m7.pageErrors.push(String(error)));
      m7Page.on("response", (response) => {
        if (response.request().method() === "POST" && response.url().endsWith("/api/v1/projects")) m7.statuses.push(response.status());
      });

      await m7Page.goto(m7Taskd.url, { waitUntil: "load" });
      await m7Page.waitForSelector("[data-project-switcher]", { timeout: 15_000 });
      await m7Page.waitForTimeout(400);

      /**
       * The live toasts — never the inert `<template data-toast-template>`'s own
       * child, which is a real node in the tree (Vue appends it) and carries a
       * `data-toast` of its own.
       */
      const m7Toasts = () =>
        m7Page.evaluate(() =>
          [...document.querySelectorAll("[data-toast-region] [data-toast]")]
            .filter((el) => !el.closest("[data-toast-template]"))
            .map((el) => ({
              kind: el.getAttribute("data-toast-kind"),
              text: el.querySelector("[data-toast-text]")?.textContent?.trim() ?? "",
              painted: el.getBoundingClientRect().width > 0,
            })),
        );

      const m7DialogOpen = () =>
        m7Page.evaluate(() => document.querySelector("[data-create-project]")?.hasAttribute("hidden") === false);

      /** Open the dialog the way a reader does: the switcher's menu, then New project. */
      const m7OpenDialog = async () => {
        await m7Page.$eval("[data-project-switcher]", (el) => { el.open = true; });
        await m7Page.$eval("[data-project-new]", (el) => el.click());
        await m7Page.waitForTimeout(200);
      };

      /** Type into both fields — an `input` event per field, which is what `v-model` listens for. */
      const m7Fill = (name, prefix) =>
        m7Page.evaluate(
          ([nextName, nextPrefix]) => {
            for (const [selector, value] of [["[data-create-project-name]", nextName], ["[data-create-project-prefix]", nextPrefix]]) {
              const field = document.querySelector(selector);
              field.value = value;
              field.dispatchEvent(new Event("input", { bubbles: true }));
            }
          },
          [name, prefix],
        );

      // The in-page press: `page.click` waits for actionability, and the submit
      // button is `:disabled` until both fields hold text (`canSubmit`, §7.3).
      const m7Submit = () => m7Page.$eval("[data-create-project-form] button[type=submit]", (el) => el.click());

      /** Nothing on screen before the next case, so no case reads a stale toast. */
      const m7Quiet = () =>
        m7Page.waitForFunction(
          () => [...document.querySelectorAll("[data-toast-region] [data-toast]")].filter((el) => !el.closest("[data-toast-template]")).length === 0,
          null,
          { timeout: 8_000 },
        );

      const m7Holds = async (kind) => {
        try {
          await m7Page.waitForSelector(`[data-toast-region] [data-toast][data-toast-kind="${kind}"]`, { state: "visible", timeout: 4_000 });
          return true;
        } catch {
          return false;
        }
      };

      /** One refusal, start to finish; returns what the reader was left looking at. */
      const m7Refusal = async (key, name, prefix) => {
        await m7Quiet();
        // A refusal leaves the dialog up, so only the first attempt opens it: the
        // rest are the repair-and-try-again pass a reader makes.
        if (!(await m7DialogOpen())) await m7OpenDialog();
        m7Check(await m7DialogOpen(), `${key} — the dialog must be up before the submit`);
        const before = await m7Projects();
        await m7Fill(name, prefix);
        await m7Submit();
        const shown = await m7Holds("danger");
        const seen = { shown, toasts: await m7Toasts(), dialogOpen: await m7DialogOpen(), projects: await m7Projects(), before };
        m7.cases[key] = seen;
        m7Check(shown, `${key} — the refusal must raise a danger toast (saw ${JSON.stringify(seen.toasts)}, wire ${m7.statuses.join(",")})`);
        m7Check(
          seen.toasts.length === 1 && seen.toasts[0].kind === "danger" && seen.toasts[0].painted && seen.toasts[0].text !== "",
          `${key} — exactly one painted danger toast (saw ${JSON.stringify(seen.toasts)})`,
        );
        m7Check(!seen.toasts.some((toast) => toast.kind === "success"), `${key} — a refused create must not announce success`);
        m7Check(seen.dialogOpen, `${key} — the dialog must stay up holding what was typed`);
        m7Check(
          JSON.stringify(seen.projects) === JSON.stringify(seen.before),
          `${key} — the refusal must land no project (${seen.before.join(",")} → ${seen.projects.join(",")})`,
        );
        return seen;
      };

      // ① a prefix that normalizes to nothing — §9 C6, M4.
      const m7Empty = await m7Refusal("emptyPrefix", "Zombie", "####");

      // ② a prefix another project already numbers its cards with — §9 C4, M5.
      //    Same status as ①, different repair: the two must not read alike.
      const m7Taken = await m7Refusal("takenPrefix", "From the UI", "demo");
      m7Check(
        m7Empty.toasts[0] !== undefined && m7Taken.toasts[0] !== undefined && m7Empty.toasts[0].text !== m7Taken.toasts[0].text,
        "the two 400s must not share one sentence — different causes, different repairs",
      );

      // ③ the control: the same dialog, still up, holding a prefix nobody claims.
      //    Without it, "no success toast" above would be satisfied by a dead dialog.
      await m7Quiet();
      m7Check(await m7DialogOpen(), "the control — the dialog the two refusals left up is the one that creates");
      await m7Fill("Fresh", "zz");
      await m7Submit();
      const m7Created = await m7Holds("success");
      const m7CreatedToasts = await m7Toasts();
      m7.cases.control = { shown: m7Created, toasts: m7CreatedToasts, dialogClosed: !(await m7DialogOpen()), projects: await m7Projects() };
      m7Check(m7Created, `the control — a prefix nobody holds must still create (saw ${JSON.stringify(m7CreatedToasts)})`);
      m7Check(m7CreatedToasts.length === 1 && m7CreatedToasts[0].kind === "success", `the control — one success toast and nothing else (saw ${JSON.stringify(m7CreatedToasts)})`);
      m7Check(m7.cases.control.dialogClosed, "the control — a created project closes the dialog");
      m7Check(m7.cases.control.projects.includes("Fresh"), `the control — the new project is on the board (${m7.cases.control.projects.join(",")})`);

      // ④ a 409. This dialog never sends an `id` (§4 M1), so the wire's own
      //    `ID_CONFLICT` is unreachable from the form; the harness answers one
      //    POST with the envelope `src/server` emits for it (whose shape
      //    `test/server/project-prefix-binding.test.mjs` C5 pins) to show the
      //    catch is about *failure*, not about the 400 it was written for.
      await m7Page.route("**/api/v1/projects", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { code: "ID_CONFLICT", message: "project id already exists", http: 409 } }),
        });
      });
      try {
        await m7Refusal("conflict", "Same id", "qq");
      } finally {
        await m7Page.unroute("**/api/v1/projects");
      }

      m7Check(m7.statuses.join(",") === "400,400,200,409", `the four submits must be answered 400,400,200,409 in that order (saw ${m7.statuses.join(",")})`);

      // The app's own console, with the browser's resource notices set aside: a
      // non-2xx response is logged by Chromium itself ("Failed to load resource:
      // … 400"), and this leg asks for three of them. What must not appear is the
      // app leaving the reader nothing — before the catch existed this list held
      // Vue's `ApiError: …`, the refused create's only trace.
      const m7Notices = m7.consoleErrors.filter((text) => text.startsWith("Failed to load resource"));
      m7.appConsoleErrors = m7.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
      m7.resourceNotices = m7Notices.length;
      m7Check(m7.appConsoleErrors.length === 0, `the refusal must reach the reader, not the console: ${m7.appConsoleErrors.join(" | ")}`);
      m7Check(m7.pageErrors.length === 0, `no uncaught exception: ${m7.pageErrors.join(" | ")}`);
    } catch (err) {
      m7Failures.push(`the real-board leg could not run: ${err.message}`);
    } finally {
      if (m7Context) await m7Context.close();
      if (m7Taskd) await m7Taskd.close();
      if (m7Dir) rmSync(m7Dir, { recursive: true, force: true });
    }

    /* ---- UI fixes · dropdown anchoring, combo values, status dots, chips,
       cross-view narrowing and platform colours ----------------------------
       A self-contained pass: it reloads the board rather than inheriting the
       route/theme/language the routing leg left behind. Every assertion targets
       a behaviour Terry reported, so a regression here is a user-visible one,
       not a geometry nicety. */
    const uiFailures = [];
    const uiCheck = (ok, message) => {
      if (!ok) uiFailures.push(message);
    };
    const ui = {};
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelectorAll("[data-card]").length > 0, null, { timeout: 10_000 });

      // ① Every filter dropdown opens *visibly*: fixed-position, anchored, and
      //    the point under its centre is the menu itself. Before the anchoring
      //    rule the 32px bar clipped the panel and the click fell through.
      ui.filters = {};
      for (const hook of ["data-filter-assignee", "data-filter-priority", "data-filter-status", "data-filter-label"]) {
        const control = page.locator(`[${hook}]`);
        await control.locator("summary").click();
        await page.waitForTimeout(60);
        ui.filters[hook] = await control.locator(".td-details-menu").evaluate((menu) => {
          const rect = menu.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            position: getComputedStyle(menu).position,
            anchored: menu.getAttribute("data-anchored"),
            hitInside: hit !== null && menu.contains(hit),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
          };
        });
        const reading = ui.filters[hook];
        uiCheck(reading.position === "fixed" && reading.anchored === "true", `${hook}: the menu is ${reading.position}/${reading.anchored}, not a fixed anchored panel`);
        uiCheck(reading.hitInside, `${hook}: the menu's centre is not hit-testable (the bar still clips it)`);
        await control.locator("summary").click();
        await page.waitForTimeout(30);
      }
      ui.barOverflow = await page.evaluate(() => getComputedStyle(document.querySelector("[data-filters]")).overflowX);
      uiCheck(ui.barOverflow === "auto", `[data-filters] overflow-x is ${ui.barOverflow}, the contract expects auto`);

      // ② The reporter shows what it holds, for a roster row and for a new name.
      await page.click("[data-new-task]");
      await page.waitForTimeout(120);
      const reporterInput = page.locator("[data-create-task] [data-reporter-input]");
      await reporterInput.click();
      await reporterInput.fill("linus");
      await page.waitForTimeout(80);
      await page.locator('[data-create-task] [data-reporter-option][data-reporter-value="linus"]').click();
      await page.waitForTimeout(80);
      ui.reporterPicked = await reporterInput.inputValue();
      uiCheck(ui.reporterPicked === "linus", `the reporter box shows ${JSON.stringify(ui.reporterPicked)} after choosing linus`);
      await reporterInput.click();
      await reporterInput.fill("New Reporter");
      await page.waitForTimeout(80);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(80);
      ui.reporterNew = await reporterInput.inputValue();
      uiCheck(ui.reporterNew === "New Reporter", `the reporter box shows ${JSON.stringify(ui.reporterNew)} after typing a new name`);

      // ③ The status control is a dropdown whose rows (and trigger) wear the
      //    board's coloured dot.
      const statusControl = page.locator("[data-create-task-status]");
      ui.statusTag = await statusControl.evaluate((el) => el.tagName);
      uiCheck(ui.statusTag === "DETAILS", `[data-create-task-status] is a <${ui.statusTag}>, not the dot-bearing dropdown`);
      await statusControl.locator("summary").click();
      await page.waitForTimeout(60);
      ui.statusRows = await statusControl.locator("[data-create-task-status-option]").count();
      ui.statusDots = await statusControl.locator("[data-create-task-status-option] .td-status-dot").count();
      uiCheck(ui.statusRows === 5 && ui.statusDots === 5, `the status menu has ${ui.statusRows} rows and ${ui.statusDots} dots, expected 5/5`);
      await statusControl.locator('[data-create-task-status-option][data-status-value="blocked"]').click();
      await page.waitForTimeout(60);
      ui.statusValue = await statusControl.getAttribute("data-create-task-status-value");
      ui.statusDot = await statusControl.evaluate((el) => {
        const dot = el.querySelector("summary .td-status-dot");
        const probe = document.createElement("span");
        probe.className = "td-status-dot";
        probe.setAttribute("data-status", "blocked");
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { got: getComputedStyle(dot).backgroundColor, expected };
      });
      uiCheck(ui.statusValue === "blocked", `the status value is ${ui.statusValue} after choosing blocked`);
      uiCheck(ui.statusDot.got === ui.statusDot.expected, `the trigger dot is ${ui.statusDot.got}, expected the blocked token ${ui.statusDot.expected}`);

      // ④ A long relation title cannot grow the chip past the routing track.
      await page.locator("[data-create-task] [data-parent-input]").click();
      await page.locator("[data-create-task] [data-parent-input]").fill("TD");
      await page.waitForTimeout(80);
      await page.locator("[data-create-task] [data-parent-option]").first().click();
      await page.waitForTimeout(80);
      ui.chip = await page.evaluate(() => {
        const chip = document.querySelector("[data-create-task] [data-parent-chip]");
        const title = chip?.querySelector(".td-combo-title");
        if (title) title.textContent = "A very long parent title ".repeat(20);
        const track = document.querySelector("[data-create-right]");
        const panel = document.querySelector("[data-create-task-panel]");
        const rect = chip?.getBoundingClientRect();
        return {
          chipRight: rect?.right,
          panelRight: panel?.getBoundingClientRect().right,
          chipWidth: rect?.width,
          trackWidth: track?.getBoundingClientRect().width,
          titleScroll: title?.scrollWidth,
          titleClient: title?.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      uiCheck(
        ui.chip.chipRight !== undefined && ui.chip.chipRight <= ui.chip.panelRight + 1,
        `the relation chip ends at ${ui.chip.chipRight}, past the dialog's ${ui.chip.panelRight}`,
      );
      uiCheck(
        ui.chip.chipWidth <= ui.chip.trackWidth + 1,
        `the relation chip is ${ui.chip.chipWidth}px in a ${ui.chip.trackWidth}px track`,
      );
      uiCheck(
        ui.chip.titleScroll > ui.chip.titleClient,
        `the chip title did not ellipsise (${ui.chip.titleScroll} / ${ui.chip.titleClient})`,
      );
      uiCheck(ui.chip.documentOverflow <= 0, `the dialog overflows the document by ${ui.chip.documentOverflow}px`);
      await page.click("[data-modal-close]");
      await page.waitForTimeout(80);

      // ⑤ A roster press narrows Activity and Waiting, not only board/list.
      await page.locator('[data-agent-assignee="linus"]').click();
      await page.waitForTimeout(80);
      await page.click('[data-nav-item="activity"]');
      await page.waitForFunction(() => document.querySelectorAll("[data-activity-row]").length > 0, null, { timeout: 10_000 });
      ui.activityActors = await page.locator("[data-activity-row]").evaluateAll((rows) => [...new Set(rows.map((row) => row.getAttribute("data-actor")))]);
      uiCheck(ui.activityActors.length > 0 && ui.activityActors.every((actor) => actor === "linus"), `Activity's narrowed rows name ${JSON.stringify(ui.activityActors)}, expected every row to be linus`);
      await page.click('[data-nav-item="waiting"]');
      await page.waitForFunction(() => document.querySelectorAll("[data-waiting-item]").length > 0, null, { timeout: 10_000 });
      ui.waitingActors = await page.locator("[data-waiting-item] [data-waiting-actor]").evaluateAll((els) => [...new Set(els.map((el) => el.textContent.trim()))]);
      uiCheck(ui.waitingActors.length > 0 && ui.waitingActors.every((actor) => actor === "linus"), `Waiting's narrowed rows name ${JSON.stringify(ui.waitingActors)}, expected every row to be linus`);

      // ⑥ The platform palette is mapped per theme. A probe row is enough: the
      //    sidebar's own rows cannot carry nine platforms without reworking the
      //    fixture, and the rule under test is the attribute → token mapping.
      ui.brand = await page.evaluate(() => {
        const root = document.documentElement;
        const previous = root.getAttribute("data-theme");
        const row = document.createElement("div");
        row.setAttribute("data-agent-row", "gemini");
        row.setAttribute("data-agent-brand", "gemini");
        const badge = document.createElement("span");
        badge.className = "td-platform-badge";
        badge.setAttribute("data-agent-platform", "gemini");
        const dot = document.createElement("span");
        dot.className = "td-platform-dot";
        const label = document.createElement("span");
        label.className = "td-platform-name";
        label.textContent = "gemini";
        badge.append(dot, label);
        const name = document.createElement("button");
        name.className = "td-agent-assignee";
        name.setAttribute("data-agent-assignee", "gemini-probe");
        name.textContent = "gemini";
        row.append(badge, name);
        document.body.append(row);
        root.setAttribute("data-theme", "dark");
        const dark = getComputedStyle(badge).color;
        if (previous === null) root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", previous);
        const light = getComputedStyle(badge).color;
        const nameLight = getComputedStyle(name).color;
        row.remove();
        return { light, dark, nameLight, previous };
      });
      uiCheck(ui.brand.light === "rgb(66, 133, 244)", `the light Gemini badge is ${ui.brand.light}, expected #4285F4`);
      uiCheck(ui.brand.dark === "rgb(138, 180, 248)", `the dark Gemini badge is ${ui.brand.dark}, expected #8AB4F8`);
      uiCheck(
        ui.brand.nameLight !== ui.brand.light,
        `the assignee name is ${ui.brand.nameLight}, the platform hue leaked into it`,
      );

      // Back to the resting board for the legs after this one (there are none
      // today, but the fixtures are shared with future additions).
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelectorAll("[data-card]").length > 0, null, { timeout: 10_000 });
    } catch (err) {
      uiFailures.push(`the UI-fix pass could not run: ${err.message}`);
    }

    /* I3 · reopen — a terminal card's one writable action. The fixture's TD-10
       is `done`; the probe opens it, proves the field controls are still
       read-only, checks the reason minimum, and reopens it. It runs after the
       other passes because it changes the fixture row's status. */
    const reopenFailures = [];
    const reopenCheck = (ok, message) => { if (!ok) reopenFailures.push(message); };
    try {
      await page.evaluate(() => document.querySelector('[data-card][data-identifier="TD-10"]')?.click());
      await page.waitForTimeout(300);

      const before = await page.evaluate(() => {
        const button = document.querySelector("[data-detail-reopen]");
        return {
          visible: !!button && !button.hidden,
          readonlyRoot: document.querySelector("[data-detail-drawer]")?.getAttribute("data-readonly") ?? null,
          statusDisabled: document.querySelector("[data-detail-status]")?.disabled ?? null,
        };
      });
      reopenCheck(before.visible, "the terminal drawer does not offer the reopen control");
      reopenCheck(before.readonlyRoot === "true", `the terminal drawer root does not state data-readonly (${before.readonlyRoot})`);
      reopenCheck(before.statusDisabled === true, "the terminal drawer's status control is not disabled");

      await page.evaluate(() => document.querySelector("[data-detail-reopen]")?.click());
      await page.waitForTimeout(80);

      const setReason = (value) =>
        page.evaluate((text) => {
          const input = document.querySelector("[data-detail-reopen-reason]");
          if (!input) return false;
          input.value = text;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }, value);

      reopenCheck(await setReason("short"), "the reopen prompt did not render");
      await page.waitForTimeout(40);
      const shortDisabled = await page.evaluate(() => document.querySelector("[data-detail-reopen-confirm]")?.disabled ?? null);
      reopenCheck(shortDisabled === true, "the confirm is enabled with a reason shorter than 8 characters");

      await setReason("customer found a regression");
      await page.waitForTimeout(40);
      const longDisabled = await page.evaluate(() => document.querySelector("[data-detail-reopen-confirm]")?.disabled ?? null);
      reopenCheck(longDisabled === false, "the confirm stays disabled with a valid reason");

      await page.evaluate(() => document.querySelector("[data-detail-reopen-confirm]")?.click());
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({
        chip: document.querySelector("[data-detail-status-chip]")?.getAttribute("data-status") ?? null,
        card: document.querySelector('[data-card][data-identifier="TD-10"]')?.getAttribute("data-status") ?? null,
        readonlyRoot: document.querySelector("[data-detail-drawer]")?.getAttribute("data-readonly") ?? null,
      }));
      reopenCheck(after.chip === "todo", `the drawer still shows ${after.chip} after reopening`);
      reopenCheck(after.card === "todo", `the card still reads ${after.card} after reopening`);
      reopenCheck(after.readonlyRoot === null, "the drawer stayed read-only after the reopen");

      await page.evaluate(() => document.querySelector("[data-detail-close]")?.click());
      await page.waitForTimeout(150);
    } catch (err) {
      reopenFailures.push(`the reopen probe could not run: ${err.message}`);
    }

    const results = [
      ...boardResults,
      ...listResults,
      ...railResults,
      ...panelResults,
      ...drawerResults,
      ...listEn.loadingResults,
      ...activityResults,
      ...waitingResults,
    ];
    const failures = results.filter((r) => !r.ok);
    // A px comparator read off an element with no layout box (a closed subtree)
    // degrades to the probe's existence criterion — it is not a pass *as a
    // measurement*, so it is reported rather than hidden. See px-assert.mjs.
    const notMeasured = results.filter((r) => r.notMeasured === true);
    const viewportFailures = viewports.filter((v) => !v.ok);
    return {
      consoleErrors,
      pageErrors,
      failures,
      viewports,
      viewportFailures,
      interactions,
      reopen: { failures: reopenFailures },
      m1,
      m1Failures,
      r6: { failures: r6Failures, themeSweep, titleGeometry, listDetail, panel: panelGeometry, rail },
      r7: { failures: r7Failures, wide, rail: railBand, drawerHead: closeR7 },
      r8: { failures: r8Failures, headWide, headNarrow, identifiers, drawerIdentifier, dark, light },
      r8c: { failures: r8cFailures, optionRows, parentPicked, afterClear, dependsChips, parentTrack: parentTrackReadings },
      r9: { failures: r9Failures, register, controls, listEn, listZh, loadingRules: listLoadingRules.length },
      r10: {
        failures: r10Failures,
        boardRest,
        filteredOut,
        cleared,
        trulyEmpty,
        restored,
        drawerRest,
        fill,
        narrowFill,
      },
      skeleton: { failures: skeletonFailures, readings: skeletonReadings },
      r12: {
        failures: r12Failures,
        tiers: R12_TIERS.map((t) => `${t.width}x${t.height}`),
        tierGeometry: r12Tiers,
        adaptHeight: adapt.board.heights[0],
        heights: r12Heights,
      },
      r11: { failures: r11Failures },
      b26: {
        failures: b26Failures,
        rest: b26Rest,
        burst: b26Burst,
        filters: b26Filters,
        read: b26Read,
        older: b26Older,
        keys: b26Keys,
        viewportFailures: b26ViewportFailures,
      },
      r12Id: { failures: r12IdFailures, longId: LONG_ID, clamped: CLAMPED, longHead, spill, listRead },
      r14: { failures: r14Failures, focus: r14Focus, relations: r14Relations, close: r14Close, ring: r14Ring },
      attachmentPreview: { failures: previewFailures, rest: previewRest, closed: previewClosed },
      drawerTabs: {
        failures: drawerTabsFailures,
        tabs: tabsRead,
        trail: trailRead,
        chronology: chronoRead,
        reports: reportsRead,
        acceptance: acceptanceRead,
        leftovers: leftoversRead,
      },
      m7: {
        failures: m7Failures,
        cases: m7.cases,
        statuses: m7.statuses,
        appConsoleErrors: m7.appConsoleErrors,
        pageErrors: m7.pageErrors,
        resourceNotices: m7.resourceNotices ?? 0,
      },
      ui: { failures: uiFailures, ...ui },
      r16: {
        failures: r16Failures,
        routes: r16Routes,
        legacy: r16Legacy,
        deepFeed: r16DeepFeed,
        unknown: r16Unknown,
        drawerFragment: r16Drawer,
        feed: r16AtFeed,
        queue: r16AtQueue,
        backOne: r16BackOne,
        backTwo: r16BackTwo,
        forward: r16Forward,
        afterAnchor: r16AfterAnchor,
      },
      geometry,
      notMeasured,
      counts: { rules: results.length, failed: failures.length, notMeasured: notMeasured.length, ...geometry },
      fixtureTasks: data.tasks.length,
    };
  } finally {
    await browser.close();
    server.close();
  }
}

/* The harness doubles as a module: `web/scripts/shot-compare.mjs` imports the
   fixture server, the Playwright resolver and the in-page rule evaluator from
   here rather than growing a second copy of each. Only run the smoke when this
   file *is* the process entry point. */
/* A private copy of `src/foundation/entry-guard.mjs` — `web/` is a workspace of its own with its own
   lockfile, so it does not reach into `src/foundation/`. Node resolves `import.meta.url` through
   `realpath` while leaving `process.argv[1]` as spelled, so both sides must be canonicalised:
   otherwise the guard is silently false and this harness exits 0 having measured nothing. */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isEntryPoint) run().then(
  (report) => {
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`columns=${report.geometry.columns} cards=${report.geometry.cards} rules=${report.counts.rules} failed=${report.counts.failed}`);
      console.log(`console errors=${report.consoleErrors.length} page errors=${report.pageErrors.length}`);
      for (const error of [...report.consoleErrors, ...report.pageErrors]) console.log(`  ! ${error}`);
      for (const failure of report.failures) console.log(`  ✗ ${failure.block} ${failure.kind} ${failure.selector ?? failure.probe ?? ""} — ${failure.detail}`);
      if (report.notMeasured.length > 0) {
        console.log(`not measured (no layout box): ${report.notMeasured.length} px assertion(s)`);
        for (const record of report.notMeasured) console.log(`  · ${record.block} ${record.probe} — ${record.detail}`);
      }
      console.log(`viewports: ${report.viewports.map((v) => `${v.width}${v.ok ? "ok" : "OVERFLOW"}`).join(" ")}`);
      console.log(`interactions: ${JSON.stringify(report.interactions)}`);
      if (report.m1Failures.length > 0) {
        console.log(`M1 · B27 (waiting) — ${report.m1Failures.length} failed:`);
        for (const failure of report.m1Failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("M1 · B27 (waiting) — the board badge, the queue's six fields, the tally, the filter bar's stand-down and the move menu all pass");
      }
      if (report.r6.failures.length > 0) {
        console.log(`R6 (fidelity) — ${report.r6.failures.length} failed:`);
        for (const failure of report.r6.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R6 (fidelity) — theme glyphs, title clamp, list geometry and the settings modal all pass");
      }
      if (report.r7.failures.length > 0) {
        console.log(`R7 (fidelity) — ${report.r7.failures.length} failed:`);
        for (const failure of report.r7.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R7 (fidelity) — nav glyphs, count pills, the footer's breakpoint split and the drawer head all pass");
      }
      if (report.r8.failures.length > 0) {
        console.log(`R8 (fidelity) — ${report.r8.failures.length} failed:`);
        for (const failure of report.r8.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R8 (fidelity) — the six-column head, the dark dialog's three layers and the identifier's cap all pass");
      }
      if (report.r9.failures.length > 0) {
        console.log(`R9 (fidelity) — ${report.r9.failures.length} failed:`);
        for (const failure of report.r9.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R9 (fidelity) — one dismiss rule, one filter control and the list's two exclusive states all pass");
      }
      if (report.r10.failures.length > 0) {
        console.log(`R10 (fidelity) — ${report.r10.failures.length} failed:`);
        for (const failure of report.r10.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R10 (fidelity) — the board's two states, the drawer's four save states and the description's fill all pass");
      }
      if (report.skeleton.failures.length > 0) {
        console.log(`Skeletons (loading) — ${report.skeleton.failures.length} failed:`);
        for (const failure of report.skeleton.failures) console.log(`  ✗ ${failure}`);
      } else {
        const read = report.skeleton.readings;
        console.log(
          `Skeletons (loading) — project switch: ${read.s1?.board.groups} column skeletons / ${read.s1?.board.skeletonCards} cards over ${read.cardsBefore} real cards, ` +
            `list ${read.s3?.list.state}, activity ${read.s4?.activity.skeleton ? "skeleton" : "—"} then ${read.s4Done?.activity.rows} rows, ` +
            `waiting ${read.s5?.waiting.skeleton ? "skeleton" : "—"} then ${read.s5Done?.waiting.emptyPainted ? "empty" : "—"}, ` +
            `drawer ${read.s6?.detail.skeletons} blocks then the real head — all pass`,
        );
      }
      if (report.r8c.failures.length > 0) {
        console.log(`B24 (fidelity) — ${report.r8c.failures.length} failed:`);
        for (const failure of report.r8c.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(`B24 (fidelity) — ${report.r8c.optionRows.length} relation rows carry identifier + one-line title (${report.r8c.optionRows.filter((row) => row.clipped).length} actually clipped), the parent field shows one chip (${JSON.stringify(report.r8c.parentPicked.mono)} …) and the depends-on field ${report.r8c.dependsChips.length} chips, all pass`);
        for (const [label, reading] of Object.entries(report.r8c.parentTrack)) {
          console.log(`B24 (fidelity) — parent field @${label}: track ${reading.rest.track}px, box ${reading.rest.input}px and no ✕ at rest (${reading.rest.clearDisplay}); with a value box ${reading.valued.input} + gap ${reading.valued.gap} + ✕ ${reading.valued.clearWidth} = ${Math.round((reading.valued.input + reading.valued.gap + reading.valued.clearWidth) * 100) / 100}px (${reading.valued.clearDisplay}), ✕ right edge ${reading.valued.clearRight} vs track right ${reading.valued.trackRight}, menu ${reading.valued.menuWidth}px — all pass`);
        }
      }
      if (report.r12.failures.length > 0) {
        console.log(`R12 (fidelity) — ${report.r12.failures.length} failed:`);
        for (const failure of report.r12.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(`R12 (fidelity) — the filters bar's one line at ${report.r12.tiers.join("/")} and the board's equal-height chain (columns ${report.r12.heights[1512]}px @1512x900 → ${report.r12.adaptHeight}px @1512x700, ${report.r12.tierGeometry["1512x950"]?.heights[0]}px @1512x950) all pass`);
      }
      if (report.r11.failures.length > 0) {
        console.log(`R11/R13 (fidelity) — ${report.r11.failures.length} failed:`);
        for (const failure of report.r11.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R11/R13 (fidelity) — the status filter, the roster's assignee-only press, the named assignee, the width-neutral capsule and the withdrawn `x` (count 0 on every click path) all pass");
      }
      if (report.b26.failures.length > 0) {
        console.log(`R12x · B26 (activity) — ${report.b26.failures.length} failed:`);
        for (const failure of report.b26.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          `R12x · B26 (activity) — routing, ${report.b26.rest.dayCount} day groups / ${report.b26.rest.dayRowCounts.reduce((sum, n) => sum + n, 0)} rows, ` +
            `the burst's ${report.b26.burst.members}-member window, the three filters, the single unread boundary (${report.b26.read.before.dividerCount}), ` +
            "`Load older`, `j`/`k` and the row's drawer all pass",
        );
      }
      if (report.r12Id.failures.length > 0) {
        console.log(`R12-id (fidelity) — ${report.r12Id.failures.length} failed:`);
        for (const failure of report.r12Id.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(`R12-id (fidelity) — the drawer head and the card / list row both show ${report.r12Id.longId} whole under the ten-character cap, and .td-id-full does not spill (${report.r12Id.spill.fullClass} match, cards ${report.r12Id.spill.cards}, rows ${report.r12Id.spill.rows})`);
      }
      if (report.r14.failures.length > 0) {
        console.log(`R14 (drawer) — ${report.r14.failures.length} failed:`);
        for (const failure of report.r14.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          `R14 (drawer) — opening focuses the drawer panel, never [data-detail-close] (activeElement ${report.r14.focus.active}), ` +
            `its box computes ${report.r14.close.width}×${report.r14.close.height} with the head at ${report.r14.close.headHeight}px, ` +
            `its focus ring is ${report.r14.ring.width} ${report.r14.ring.style} ${report.r14.ring.color}, ` +
            `and the relation rows read ${report.r14.relations.join(" / ")}`,
        );
      }
      if (report.attachmentPreview.failures.length > 0) {
        console.log(`Attachment preview — ${report.attachmentPreview.failures.length} failed:`);
        for (const failure of report.attachmentPreview.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("Attachment preview — image / pdf / video / markdown open in a full-screen blob-backed dialog, ✕ and Escape close it without closing the drawer and hand focus back to the row, and the zip row offers no open affordance");
      }
      if (report.drawerTabs.failures.length > 0) {
        console.log(`v4 (drawer tabs) — ${report.drawerTabs.failures.length} failed:`);
        for (const failure of report.drawerTabs.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          `v4 (drawer tabs) — six tabs, Sessions last; the session section is inside the Sessions panel; ` +
            `the trail reads ${report.drawerTabs.trail.statuses.join("/")} with ${report.drawerTabs.trail.resumes} Resume; ` +
            `Reports ${report.drawerTabs.reports.rows}, Acceptance ${report.drawerTabs.acceptance.items}, Leftovers ${report.drawerTabs.leftovers.rows}`,
        );
      }
      if (report.m7.failures.length > 0) {
        console.log(`M7 · C-PREFIX-1 (create-project refusal) — ${report.m7.failures.length} failed:`);
        for (const failure of report.m7.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          `M7 · C-PREFIX-1 (create-project refusal) — on a real board, \`####\` and a taken prefix each raise one visible danger toast ` +
            `with the dialog held open and no project written (wire ${report.m7.statuses.join(",")}), a free prefix still creates, and the synthetic 409 lands in the same catch`,
        );
      }
      if (report.ui.failures.length > 0) {
        console.log(`UI fixes — ${report.ui.failures.length} failed:`);
        for (const failure of report.ui.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          `UI fixes — the four filter dropdowns anchor unclipped (bar overflow ${report.ui.barOverflow}), ` +
            `reporter holds ${JSON.stringify(report.ui.reporterPicked)} / ${JSON.stringify(report.ui.reporterNew)}, ` +
            `status is a ${report.ui.statusTag} with ${report.ui.statusDots} dot rows and chooses ${report.ui.statusValue}, ` +
            `the long parent chip stays in its ${Math.round(report.ui.chip.trackWidth)}px track, ` +
            `Activity narrows to ${JSON.stringify(report.ui.activityActors)} and Waiting to ${JSON.stringify(report.ui.waitingActors)}, ` +
            `and the Gemini platform badge resolves ${report.ui.brand.light} / ${report.ui.brand.dark} (light/dark) with names left alone`,
        );
      }
      if (report.r16.failures.length > 0) {
        console.log(`R16 (routing) — ${report.r16.failures.length} failed:`);
        for (const failure of report.r16.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          "R16 (routing) — the four views load from their own addresses (each root painted alone, one `aria-current`), `/` and `/index.html` " +
            `redirect to ${report.r16.routes["/board"].pathname}, an unknown path is corrected to the board while a drawer fragment survives, ` +
            `the old \`#/activity?…\` link redirects to ${report.r16.legacy.pathname}${report.r16.legacy.search} with the fragment consumed, ` +
            `and nav / filter / back / forward walk the views with the toggle and the filters in step (back #1 ${report.r16.backOne.pathname}${report.r16.backOne.search}, back #2 ${report.r16.backTwo.pathname})` +
            `, and the feed's task anchor opens its drawer in place with ${report.r16.afterAnchor.pathname}${report.r16.afterAnchor.search} left as it was`,
        );
      }
      if (report.reopen.failures.length > 0) {
        console.log(`I3 (reopen) — ${report.reopen.failures.length} failed:`);
        for (const failure of report.reopen.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log(
          "I3 (reopen) — a terminal drawer offers one audited action: the fields stay read-only, " +
            "the confirm enforces the 8-character reason, and the card returns to todo",
        );
      }
    }
    const interactionOk =
      report.interactions.drawerOpened &&
      report.interactions.drawerClosed &&
      report.interactions.agentSessionHook &&
      report.interactions.moveMenuOpened &&
      report.interactions.themeCycleReturns &&
      report.interactions.langZh &&
      report.interactions.langEn;
    const ok =
      report.failures.length === 0 &&
      report.consoleErrors.length === 0 &&
      report.pageErrors.length === 0 &&
      report.viewportFailures.length === 0 &&
      report.m1Failures.length === 0 &&
      report.r6.failures.length === 0 &&
      report.r7.failures.length === 0 &&
      report.r8.failures.length === 0 &&
      report.r8c.failures.length === 0 &&
      report.r9.failures.length === 0 &&
      report.r10.failures.length === 0 &&
      report.skeleton.failures.length === 0 &&
      report.r12.failures.length === 0 &&
      report.r11.failures.length === 0 &&
      report.b26.failures.length === 0 &&
      report.r12Id.failures.length === 0 &&
      report.r14.failures.length === 0 &&
      report.attachmentPreview.failures.length === 0 &&
      report.drawerTabs.failures.length === 0 &&
      report.m7.failures.length === 0 &&
      report.ui.failures.length === 0 &&
      report.r16.failures.length === 0 &&
      report.reopen.failures.length === 0 &&
      interactionOk;
    process.exit(ok ? 0 : 1);
  },
  (err) => {
    if (err.code === "SKIP") {
      console.log(`SKIP: ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  },
);
