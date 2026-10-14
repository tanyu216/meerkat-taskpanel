/**
 * T-20261014-150729 · the visual leg's fixture API for the **implementation** side.
 *
 * Independent carrier, lineage `docs/verify/T-20261013-154930-3/fixture.mjs`
 * (whose router shape is reused verbatim; the *sample* is re-authored here so a
 * fixture card renders the same content as the prototype card it is paired
 * with). The router is the only shape this harness needed to borrow — the mock
 * data is what makes the pairing readable.
 *
 * Why a fixture at all, when the card hands us a live board at :9527:
 *   * requirement ① needs the **same card** on both sides at five widths;
 *   * requirement ② needs a named agent card, a named human card and a card
 *     with no relations at all — a live board cannot be asked for those;
 * so the impl leg is driven by route interception over the **same bundle the
 * live server serves** (the static half is proxied to :9527, never re-built).
 *
 * The three cards mirror prototype `design/prototype/index.html`:
 *   TD-128  · agent  · relations Parent + Blocks · 2 attachments · 4 activity rows
 *   TD-126  · **human** · relations Related       · 1 attachment
 *   PROJ-0007 · agent · **no relations, no attachments** (both empty states)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

const ok = (data) => ({ ok: true, data });

/** The three cards the evidence is read off, named after the prototype's own. */
export const CARDS = Object.freeze({
  AGENT: "TD-128",
  HUMAN: "TD-126",
  EMPTY: "PROJ-0007",
});

/* --------------------------------------------------------------- markdown */

/** TD-128's description, written as the markdown the impl renders. */
const AGENT_DESCRIPTION = [
  "Board navigation is mouse-only today. Keyboard users can reach a card but cannot move it between columns.",
  "",
  "#### Acceptance",
  "",
  "- Tab order follows the visual column order",
  "- Enter opens the detail drawer for the focused card",
  "",
  "```",
  '<section class="td-col" data-column data-status="todo">',
  "```",
  "",
  "| Key | Action |",
  "| --- | --- |",
  "| Enter | Open detail |",
  "| Esc | Close detail |",
  "",
  "> Keep the DOM order stable so focus never jumps between columns.",
  "",
  "- [x] Roving tabindex on cards",
  "- [ ] Announce the new column after a move",
].join("\n");

/** TD-126's description. */
const HUMAN_DESCRIPTION = [
  "The list view pops in with no transition. Add skeleton rows while the first page settles.",
  "",
  "#### Rules",
  "",
  "- Shimmer is a linear 1.4 second loop",
  "- Skeletons disappear on first paint, never on a timer",
  "",
  "```",
  "animation: td-shimmer 1.4s linear infinite;",
  "```",
  "",
  "| Rows | State |",
  "| --- | --- |",
  "| 3 | Skeleton |",
  "",
  "> Match the final row height so nothing shifts when the real rows arrive.",
  "",
  "- [x] Three skeleton rows",
  "- [ ] Reduced motion fallback",
].join("\n");

/** PROJ-0007's description. */
const EMPTY_DESCRIPTION = [
  "Selecting several cards should allow one status change for the whole selection.",
  "",
  "#### Open questions",
  "",
  "- Where does the selection counter live",
  "- Does selection survive a filter change",
  "",
  "```",
  '<div data-card data-selected="true">',
  "```",
  "",
  "| Input | Behaviour |",
  "| --- | --- |",
  "| Shift click | Extend selection |",
  "",
  "> Selection must be visible without relying on colour alone.",
  "",
  "- [ ] Selection model",
  "- [ ] Bulk move action",
].join("\n");

/* ------------------------------------------------------------------ data */

const PEOPLE = {
  linus: { id: "a1", display_name: "linus", kind: "agent", platform: "claude" },
  jobs: { id: "a2", display_name: "jobs", kind: "agent", platform: "codex" },
  elon: { id: "a3", display_name: "elon", kind: "agent", platform: "openclaw" },
  terry: { id: "h1", display_name: "Terry", kind: "human", platform: null },
};

export function fixtureApi() {
  const project = {
    id: "p1",
    name: "MeerkatTaskPanel",
    prefix: "TD",
    workspace_path: "/w/p1",
    labels: [],
    meta: {},
    readme: null,
    task_count: 3,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const mk = (over) => ({
    id: over.id ?? `td_${over.identifier.replace(/[^A-Za-z0-9]/g, "_")}`,
    identifier: over.identifier,
    project_id: "p1",
    title: over.title,
    description: over.description ?? "",
    status: over.status ?? "todo",
    priority: over.priority ?? "medium",
    kind: "task",
    labels: over.labels ?? [],
    awaiting_reason: null,
    meta: over.meta ?? {},
    assignee: over.assignee,
    reporter: PEOPLE.terry,
    version: over.version ?? 1,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });

  /* TD-128 — mirrors the prototype card's own attributes:
     todo · high · a11y,board · linus(agent) · reporter Terry · v3 · 2 files. */
  const agent = mk({
    identifier: CARDS.AGENT,
    id: "td_01HQ8ZC4M2K7V9P",
    title: "Wire keyboard navigation across board columns",
    description: AGENT_DESCRIPTION,
    status: "todo",
    priority: "high",
    labels: ["a11y", "board"],
    assignee: PEOPLE.linus,
    version: 3,
    meta: {
      attachment_count: 2,
      attachments: [
        { filename: "board-keyboard-spec.md", size: 12 * 1024 },
        { filename: "focus-order-record.png", size: 248 * 1024 },
      ],
    },
  });

  /* TD-126 — the human card: in_review · medium · ui · Terry(human) · v2. */
  const human = mk({
    identifier: CARDS.HUMAN,
    id: "td_01HQ7Y1A9B3C5DJM",
    title: "Skeleton loading for list view",
    description: HUMAN_DESCRIPTION,
    status: "in_review",
    priority: "medium",
    labels: ["ui"],
    assignee: PEOPLE.terry,
    version: 2,
    meta: {
      attachment_count: 1,
      attachments: [{ filename: "skeleton-rows.png", size: 180 * 1024 }],
    },
  });

  /* PROJ-0007 — the empty pair, and the 9-character identifier R12 §5 A1/A4
     names as the width probe. */
  const empty = mk({
    identifier: CARDS.EMPTY,
    id: "td_01HQ8ZM4K2P7RQY",
    title: "Add bulk status change to board selection",
    description: EMPTY_DESCRIPTION,
    status: "backlog",
    priority: "none",
    labels: ["ux", "board"],
    assignee: PEOPLE.elon,
    version: 1,
    meta: { attachment_count: 0, attachments: [] },
  });

  /* A companion card per relation link, so every `.td-copy` address in a
     relation row resolves to a card the board also holds. */
  const companions = [
    ["TD-125", "Draft the v1 prototype of the task board", "backlog", "medium", ["design"], PEOPLE.jobs],
    ["TD-130", "Tighten filter debounce and query state", "todo", "medium", ["perf"], PEOPLE.elon],
    ["TD-121", "Normalise priority colour tokens", "todo", "low", ["design"], PEOPLE.jobs],
    ["TD-119", "Add per-project identifier prefixes", "backlog", "low", ["ui"], PEOPLE.elon],
  ].map(([identifier, title, status, priority, labels, assignee]) =>
    mk({ identifier, title, status, priority, labels, assignee })
  );

  const tasks = [agent, human, empty, ...companions];

  const entries = Object.values(PEOPLE);
  const labels = ["a11y", "board", "ui", "ux", "design", "perf"].map((norm, i) => ({
    id: `l${i + 1}`,
    project_id: "p1",
    norm,
    display_name: norm,
    color: null,
  }));

  const at = (d) => `2026-10-${d}T00:00:00Z`;
  /* Every `target` is the address of a card the board also holds, so a relation
     link resolves to that card's own identifier the way it does on a real
     board. A target that resolves to nothing is what makes the row print an
     internal id — a fixture bug this leg is meant to surface, not to hide. */
  const idOf = (identifier) => tasks.find((t) => t.identifier === identifier)?.id;
  const relationsByTask = {
    [CARDS.AGENT]: [
      { id: "rel-1", type: "parent", source: agent.id, target: idOf("TD-125"), created_at: at("01") },
      { id: "rel-2", type: "blocks", source: agent.id, target: idOf("TD-130"), created_at: at("01") },
      { id: "rel-3", type: "blocks", source: agent.id, target: idOf(CARDS.HUMAN), created_at: at("01") },
    ],
    [CARDS.HUMAN]: [
      { id: "rel-4", type: "related", source: human.id, target: agent.id, created_at: at("01") },
    ],
  };

  /* Relative times are anchored to *now*, because the prototype authors its own
     "2h ago" as static text (`data-i18n-arg`, `title="2026-10-08 09:12"`) while
     the implementation computes the phrase from `created_at`. Anchoring is what
     makes the two sides read as the same card; the absolute instants printed in
     the title attribute therefore differ, and the run's own timestamp bounds
     what the phrase means. */
  const ago = ({ d = 0, h = 0, m = 0 } = {}) =>
    new Date(Date.now() - ((d * 24 + h) * 60 + m) * 60_000).toISOString();

  const comments = [
    /* The prototype's own three: a `human` comment signed `jobs`, an `agent`
       comment signed `jobs`, and Terry's decision — kept as the oracle states
       them, oddity included. */
    {
      id: "cm-1", task_id: agent.identifier, kind: "note", author_kind: "human",
      author_id: "jobs", author: { display_name: "jobs" },
      body: "Tab order looks right in the recording. Keep the stripe colour as the only status signal inside a card.",
      refs: [], created_at: ago({ h: 2 }),
    },
    {
      id: "cm-2", task_id: agent.identifier, kind: "note", author_kind: "agent",
      author_id: "jobs", author: { display_name: "jobs" },
      body: "Applied roving tabindex to the card list. Waiting on the decision about the Escape key scope.",
      refs: [], created_at: ago({ h: 3 }),
    },
    {
      id: "cm-3", task_id: agent.identifier, kind: "decision", author_kind: "human",
      author_id: "Terry", author: { display_name: "Terry" },
      body: "Escape closes the drawer only, never the board selection. Moving this to In Progress today.",
      refs: [], created_at: ago({ h: 4 }),
    },
    {
      id: "cm-4", task_id: human.identifier, kind: "note", author_kind: "human",
      author_id: "jobs", author: { display_name: "jobs" },
      body: "Row grid is fixed at six columns, so the skeleton keeps the same rhythm as the real rows.",
      refs: [], created_at: ago({ h: 2 }),
    },
    {
      id: "cm-5", task_id: human.identifier, kind: "decision", author_kind: "human",
      author_id: "Terry", author: { display_name: "Terry" },
      body: "Three rows is enough. More than three reads as a slow interface.",
      refs: [], created_at: ago({ h: 22 }),
    },
  ];

  const activities = [
    ["act-1", agent.id, "human", "Terry", "task_created", { identifier: CARDS.AGENT, status: "backlog" }, 1, { d: 3 }],
    ["act-2", agent.id, "agent", "jobs", "task_claimed", {}, 2, { d: 2 }],
    ["act-3", agent.id, "human", "Terry", "task_moved", { from: "backlog", to: "todo" }, 3, { d: 1 }],
    ["act-4", agent.id, "agent", "jobs", "comment_added", { commentId: "cm-2", kind: "note" }, 4, { h: 2 }],
    ["act-5", human.id, "agent", "jobs", "task_created", { identifier: CARDS.HUMAN, status: "todo" }, 1, { h: 22 }],
    ["act-6", human.id, "human", "Terry", "task_moved", { from: "todo", to: "in_progress" }, 2, { h: 22 }],
    ["act-7", human.id, "agent", "jobs", "task_moved", { from: "in_progress", to: "in_review" }, 3, { h: 2 }],
    ["act-8", human.id, "human", "Terry", "comment_added", { commentId: "cm-4", kind: "note" }, 4, { h: 2 }],
  ].map(([id, task_id, actor_kind, actor_id, event, changes, revision, when]) => ({
    id, task_id, actor_kind, actor_id, event, changes, revision, created_at: ago(when),
  }));

  const sessions = [
    { session_id: "sess_claude_01HQ19XD1NZZQ", task_id: agent.id, status: "running", agent_id: "a1", started_at: "2026-10-06T09:02:00Z" },
    { session_id: "sess_codex_01HQ7Y1A9B3D", task_id: human.id, status: "ended", agent_id: "a2", started_at: "2026-10-07T17:00:00Z" },
  ];

  return { projects: [project], order_debug: [{ id: "p1", name: project.name, order: 1, total: 0.9, archived: false }], tasks, entries, labels, relationsByTask, comments, activities, sessions };
}

/* ---------------------------------------------------------------- router */

/** `{ok:true,data:…}` for an `/api/v1` path, or `null` when the path is not ours. */
export function apiReply(path, search, data) {
  const url = new URL(`http://fixture.test${path}${search}`);
  const p = url.pathname;
  if (p === "/health") return ok({ status: "ok", revision: 5 });
  if (p === "/api/v1/projects") return ok({ projects: data.projects, order_debug: data.order_debug });
  if (p === "/api/v1/tasks") {
    const projectId = url.searchParams.get("project_id");
    return ok({ tasks: data.tasks.filter((t) => !projectId || t.project_id === projectId) });
  }
  if (p === "/api/v1/assignees" || p === "/api/v1/reporters") return ok({ entries: data.entries });
  if (p === "/api/v1/labels") return ok({ labels: data.labels });
  const sub = /^\/api\/v1\/tasks\/([^/]+)\/(comments|relations|activities|sessions)$/.exec(p);
  if (sub) {
    const ref = decodeURIComponent(sub[1]);
    const task = data.tasks.find((t) => t.identifier === ref || t.id === ref) ?? data.tasks[0];
    if (sub[2] === "comments") return ok({ comments: data.comments.filter((c) => c.task_id === task.identifier || c.task_id === task.id) });
    if (sub[2] === "relations") return ok({ relations: data.relationsByTask[task.identifier] ?? [] });
    if (sub[2] === "activities") return ok({ task_id: task.id, activities: data.activities.filter((a) => a.task_id === task.id) });
    return ok({ sessions: data.sessions.filter((s) => s.task_id === task.id) });
  }
  if (p.startsWith("/api/v1/tasks/")) {
    const ref = decodeURIComponent(p.slice("/api/v1/tasks/".length).split("/")[0]);
    const task = data.tasks.find((t) => t.identifier === ref || t.id === ref) ?? data.tasks[0];
    return ok({ task, report_waivers: [] });
  }
  if (p.startsWith("/api/v1/")) return ok({});
  return null;
}

/** A static file for a non-API path out of `dist`, `index.html` as the fallback. */
export function staticFile(distDir, pathname) {
  const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(distDir, rel);
  if (!existsSync(file) || statSync(file).isDirectory() || !extname(file)) file = join(distDir, "index.html");
  if (!existsSync(file)) return null;
  return { body: readFileSync(file), contentType: MIME[extname(file)] ?? "application/octet-stream" };
}

/**
 * Fulfil every request of `page` from the **live build** + this fixture.
 *
 * `livePort` is the loopback server the card names (9527) — the static half is
 * proxied to it rather than read from a local `web/dist`, because this host has
 * no frontend `node_modules` (the committed npm cache is linux/arm64) and so
 * cannot rebuild the bundle. What is captured is therefore the *served* build,
 * never a lane-local one; `capture.mjs` records its asset hashes as identity.
 */
export async function mountRoutes(page, { livePort, data, origin = "app.test" }) {
  const { get } = await import("node:http");
  const proxy = (pathname, search) =>
    new Promise((resolve) => {
      const req = get({ host: "127.0.0.1", port: livePort, path: `${pathname}${search}`, timeout: 8000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], body: Buffer.concat(chunks) }));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== origin) return route.fulfill({ status: 404, body: "off-origin" });

    if (url.pathname === "/api/v1/events") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "no-cache" },
        body: "retry: 10000\n\n: connected\n\n",
      });
    }
    const reply = apiReply(url.pathname, url.search, data);
    if (reply) {
      return route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(reply) });
    }
    const res = await proxy(url.pathname, url.search);
    if (!res) return route.fulfill({ status: 502, body: "live build unreachable" });
    return route.fulfill({ status: res.status, contentType: res.contentType ?? "application/octet-stream", body: res.body });
  });
}
