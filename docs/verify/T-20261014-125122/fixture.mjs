/**
 * R14 integration recheck (T-20261014-125122) — an **independent** fixture and
 * carrier for the built app.
 *
 * Why a second fixture: `web/scripts/dom-smoke.mjs` and
 * `docs/verify/T-20261013-154930-3/fixture.mjs` are both artefacts of the rounds
 * under review here, so neither can be the oracle for *this* card. This module
 * carries its own sample and its own router.
 *
 * Why not a socket: this lane's sandbox denies `listen(2)` for every family
 * (`0.0.0.0`, `127.0.0.1`, `::1` — all `EPERM`, see
 * `evidence/env-no-listen.txt`), which is also why `test/web/blocks.dom.test.mjs`
 * cannot boot its own server here. So every request of the page is fulfilled by
 * **Playwright route interception** instead: the browser is still a real
 * Chromium (real parse, real layout, real computed style), only the transport is
 * replaced. The same carrier was used by the previous verification leg
 * (`docs/verify/T-20261013-154930-3/fixture.mjs`), for the same reason.
 *
 * The sample the drawer is opened on carries **all three** relation kinds on one
 * screen (`parent` · `blocks` (two links) · `related`) plus a second card with no
 * relation at all, so the grouped row and its empty face are both readable
 * without changing the fixture. The identifiers of the relation targets are the
 * prototype's own demo values (`TD-125` … `TD-127`, `design/prototype/index.html`),
 * which keeps the two sides' readings comparable word for word.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

/** The page origin. Route interception answers it; no DNS, no socket. */
export const ORIGIN = "http://app.test";
/** The card the drawer is opened on: one link of each of the three kinds. */
export const DRAWER_ID = "PROJ-0007";
/** The card with no relation at all — the area's empty face. */
export const EMPTY_ID = "TD-2";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const ok = (data) => ({ ok: true, data });

const ROSTER = [
  { id: "a1", kind: "agent", display_name: "linus", normalized_name: "linus", platform: "claude" },
  { id: "a2", kind: "agent", display_name: "jobs", normalized_name: "jobs", platform: "codex" },
  { id: "a3", kind: "agent", display_name: "elon", normalized_name: "elon", platform: "openclaw" },
  { id: "h1", kind: "human", display_name: "Terry", normalized_name: "terry", platform: null },
];

/**
 * The sample. Four cards, one project: the drawer card, the empty-relation card
 * and the three relation targets the drawer's links name.
 */
export function fixtureApi() {
  const project = {
    id: "p1",
    name: "MeerkatTaskPanel",
    prefix: "TD",
    workspace_path: "/w/p1",
    labels: [],
    meta: {},
    readme: null,
    task_count: 5,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const mk = (identifier, over = {}) => ({
    id: over.id ?? `td_${identifier.replace(/[^A-Za-z0-9]/g, "_")}`,
    identifier,
    project_id: "p1",
    title: over.title ?? `Card ${identifier}`,
    description: over.description ?? "",
    status: over.status ?? "todo",
    priority: over.priority ?? "medium",
    kind: "task",
    labels: over.labels ?? [],
    awaiting_reason: null,
    meta: over.meta ?? {},
    assignee: over.assignee ?? ROSTER[0],
    reporter: over.reporter ?? ROSTER[3],
    version: 1,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });

  /**
   * `PROJ-0007` is the card the drawer opens on. Its `meta` carries the three
   * relation counters the card itself reads (`Card.vue` → `data-relations-*`,
   * BLOCKS.md §R14: "the same three the card's own counters carry"), stated to
   * match the wire edges below so the two surfaces can be read against each
   * other. Note the honest caveat registered in the report: **no route in
   * `src/server` writes these three meta fields** — they arrive with seeded
   * fixture data (here) and read `0` on a board that has none.
   */
  const rich = mk(DRAWER_ID, {
    title: "Collect the install survey",
    status: "todo",
    priority: "high",
    meta: { relations_parent: 1, relations_blocks: 2, relations_related: 1 },
  });
  const plain = mk(EMPTY_ID, { title: "Quiet card", status: "backlog" });
  const parent = mk("TD-125", { title: "Parent card", status: "in_progress" });
  const blocksA = mk("TD-130", { title: "Blocked card A", status: "blocked" });
  const blocksB = mk("TD-126", { title: "Blocked card B", status: "blocked" });
  const related = mk("TD-127", { title: "Related card", status: "in_review" });

  const tasks = [rich, plain, parent, blocksA, blocksB, related];

  /**
   * The drawer card's edges, keyed by the internal id the way the real route
   * scopes them (`src/server/routes/relations.mjs`). One `parent`, two `blocks`
   * (so a group is visibly *a group*, not a 1:1 row), one `related` — the third
   * kind is the one this round's ruling restored, so it must be present for the
   * reading to mean anything.
   */
  const relations = {
    [rich.id]: [
      { id: "rel-parent", type: "parent", source: parent.id, target: rich.id, origin: null, created_at: "2026-10-01T00:00:00Z" },
      { id: "rel-blocks-a", type: "blocks", source: rich.id, target: blocksA.id, origin: null, created_at: "2026-10-01T00:01:00Z" },
      { id: "rel-blocks-b", type: "blocks", source: rich.id, target: blocksB.id, origin: null, created_at: "2026-10-01T00:02:00Z" },
      { id: "rel-related", type: "related", source: rich.id, target: related.id, origin: null, created_at: "2026-10-01T00:03:00Z" },
    ],
  };

  return {
    projects: [project],
    order_debug: [{ id: "p1", name: project.name, order: 1, total: 0.9, archived: false }],
    tasks,
    entries: ROSTER,
    labels: [],
    relations,
    comments: {},
    activities: [],
    sessions: [],
  };
}

/** `{ok:true,data:…}` for an `/api/v1` path, or `null` when the path is not ours. */
export function apiReply(path, search, data) {
  const url = new URL(`http://fixture.test${path}${search ?? ""}`);
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
    if (sub[2] === "comments") return ok({ comments: data.comments[task.id] ?? [] });
    if (sub[2] === "relations") return ok({ relations: data.relations[task.id] ?? [] });
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

/** A static file out of `distDir`; SPA paths fall back to `index.html`. */
export function staticFile(distDir, pathname) {
  const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(distDir, rel);
  if (!existsSync(file) || statSync(file).isDirectory() || !extname(file)) file = join(distDir, "index.html");
  if (!existsSync(file)) return null;
  return { body: readFileSync(file), contentType: MIME[extname(file)] ?? "application/octet-stream" };
}

/**
 * Fulfil every request of `page` from `distDir` + the fixture API.
 *
 * The live stream is answered **once** and then left to the app's own retry beat
 * (`services/events.js`), exactly as the previous leg's carrier did: an
 * never-closed body would hang the route instead of exercising it.
 */
export async function mountRoutes(page, { distDir, data }) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "app.test") return route.fulfill({ status: 404, body: "off-origin" });

    if (url.pathname === "/api/v1/events") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "no-cache" },
        body: "retry: 10000\n\n: connected\n\n",
      });
    }
    const reply = apiReply(url.pathname, url.search, data);
    if (reply) return route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(reply) });
    const file = staticFile(distDir, url.pathname);
    if (!file) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });
}
