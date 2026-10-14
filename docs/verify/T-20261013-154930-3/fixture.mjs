/**
 * R14 verification fixture — an **independent** fixture API + static server.
 *
 * Independence matters here: `web/scripts/dom-smoke.mjs` is part of what B2
 * edited, so its fixture cannot be the oracle for B2's own round. This module
 * carries its own sample (a nine-character identifier with attachments,
 * relations of both catalogue kinds, a decision comment, an agent session and
 * an activity trail) and its own request router.
 *
 * Two carriers are offered:
 *   * `mountRoutes(page, …)` — fulfil every request through Playwright route
 *     interception, so no TCP socket is needed (the audit sandbox denies
 *     `listen(2)`; the browser is still a real Chromium and still lays out).
 *   * `serve(dir, …)` — the classic `http.createServer` carrier, for hosts that
 *     do allow binding a loopback port.
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
};

const ok = (data) => ({ ok: true, data });

const AGENT = {
  linus: { id: "a1", display_name: "linus", kind: "agent", platform: "claude" },
  jobs: { id: "a2", display_name: "jobs", kind: "agent", platform: "codex" },
  elon: { id: "a3", display_name: "elon", kind: "agent", platform: "openclaw" },
  terry: { id: "h1", display_name: "Terry", kind: "human", platform: null },
};

/**
 * The sample the drawer is opened on.
 *
 * `PROJ-0007` is nine characters — the smallest value that exercises the
 * identifier cap (`web/src/lib/identifier.js` slices at eight), i.e. exactly the
 * sample `design/fidelity-r12.md` §5 A1/A4 and R14 §4 R14-B05 name.
 */
export const RICH_ID = "PROJ-0007";
export const PLAIN_ID = "TD-2";
/** Eleven characters: past the render layer's cap (ten since T-20261014-001418). */
export const LONG_ID = "PROJ-0007123";

const RICH_DESCRIPTION = [
  "#### Scope",
  "",
  "Body with **bold**, `code` and a [link](https://example.test/x).",
  "",
  "- first item",
  "- second item",
  "",
  "| col | val |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "> quoted note",
  "",
  "```",
  "block code",
  "```",
  "",
  "- [x] shipped",
  "- [ ] pending",
].join("\n");

export function fixtureApi() {
  const project = {
    id: "p1",
    name: "MeerkatTaskPanel",
    prefix: "TD",
    workspace_path: "/w/p1",
    labels: [],
    meta: {},
    readme: null,
    task_count: 2,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const mkTask = (over = {}) => ({
    id: over.id ?? `td_${(over.identifier ?? "TD-1").replace(/[^A-Za-z0-9]/g, "_")}`,
    identifier: over.identifier ?? "TD-1",
    project_id: "p1",
    title: over.title ?? "Sample card",
    description: over.description ?? "",
    status: over.status ?? "todo",
    priority: over.priority ?? "medium",
    kind: "task",
    labels: over.labels ?? [],
    awaiting_reason: null,
    meta: over.meta ?? {},
    assignee: over.assignee ?? AGENT.terry,
    reporter: over.reporter ?? AGENT.terry,
    version: over.version ?? 1,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });

  const rich = mkTask({
    identifier: RICH_ID,
    title: "Collect the install survey",
    description: RICH_DESCRIPTION,
    status: "todo",
    priority: "high",
    labels: ["bug", "ui"],
    assignee: AGENT.elon,
    reporter: AGENT.terry,
    version: 3,
    meta: {
      attachment_count: 2,
      attachments: [
        { filename: "board-keyboard-spec.md", size: 12 * 1024 },
        { filename: "focus-order-record.png", size: 248 * 1024 },
      ],
    },
  });
  const plain = mkTask({ identifier: PLAIN_ID, title: "Quiet card", status: "backlog" });
  const long = mkTask({ identifier: LONG_ID, title: "Over-cap identifier", status: "todo" });

  const tasks = [rich, plain, long];
  const entries = Object.values(AGENT);
  const labels = ["bug", "ui", "design", "perf", "security"].map((norm, index) => ({
    id: `l${index + 1}`,
    project_id: "p1",
    norm,
    display_name: norm,
    color: null,
  }));

  /* R14 D37/B23 — one link of each catalogue kind (`parent` / `blocks`), so the
     grouped `.td-rel-item` shape has something to group. The rich card is the
     only one that has them: the quiet card is what the empty state is read off. */
  const relationsByTask = {
    [RICH_ID]: [
      { id: "rel-1", type: "parent", source: rich.id, target: plain.id, created_at: "2026-10-01T00:00:00Z" },
      { id: "rel-2", type: "blocks", source: rich.id, target: plain.id, created_at: "2026-10-01T00:00:00Z" },
    ],
  };

  /* R14 D40/D41/B26/B27 — a plain note and a quoted decision, one author of each
     kind, so the meta line has all three of its seats and the decision class has
     a row to sit on. */
  const comments = [
    {
      id: "cm-1",
      task_id: RICH_ID,
      kind: "note",
      author_kind: "human",
      author_id: "Terry",
      author: { display_name: "Terry" },
      body: "first line\nsecond line",
      refs: [],
      created_at: "2026-10-12T00:01:00Z",
    },
    {
      id: "cm-2",
      task_id: RICH_ID,
      kind: "decision",
      author_kind: "agent",
      author_id: "linus",
      author: { display_name: "linus" },
      body: "scope confirmed",
      refs: [],
      created_at: "2026-10-12T00:02:00Z",
    },
  ];

  const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString();
  const activities = [
    { id: "act-1", task_id: rich.id, actor_kind: "human", actor_id: "Terry", event: "task_created", changes: { identifier: RICH_ID, status: "backlog" }, revision: 1, created_at: minutes(30 * 60) },
    { id: "act-2", task_id: rich.id, actor_kind: "agent", actor_id: "jobs", event: "task_moved", changes: { from: "backlog", to: "todo" }, revision: 2, created_at: minutes(8 * 60) },
    { id: "act-3", task_id: rich.id, actor_kind: "human", actor_id: "Terry", event: "comment_added", changes: { commentId: "cm-1", kind: "discuss" }, revision: 3, created_at: minutes(4 * 60) },
  ];

  /* R14 D43/D44/D45 — a running session, i.e. the one the drawer prefers. */
  const sessions = [
    { session_id: "s-1f2e", task_id: rich.id, status: "running", agent_id: "a3", started_at: "2026-10-12T00:00:00Z" },
  ];

  return {
    projects: [project],
    order_debug: [{ id: "p1", name: project.name, order: 1, total: 0.9, archived: false }],
    tasks,
    entries,
    labels,
    relationsByTask,
    comments,
    activities,
    sessions,
  };
}

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
 * Fulfil every request of `page` from `distDir` + the fixture API.
 *
 * `javaScriptEnabled:false` is handled by the caller — with scripts off the
 * browser still fetches the document, which is exactly what the JS-off leg
 * wants to inspect.
 */
export async function mountRoutes(page, { distDir, data }) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "app.test") return route.fulfill({ status: 404, body: "off-origin" });

    if (url.pathname === "/api/v1/events") {
      /* The live stream: answer once and let the browser re-open it on its own
         beat (`services/events.js` retries; the status chip reads `connecting`). */
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
    const file = staticFile(distDir, url.pathname);
    if (!file) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
  });
}

/** Loopback carrier for hosts that allow `listen(2)`. */
export async function serve({ distDir, data, port = 0 }) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const reply = apiReply(url.pathname, url.search, data);
    if (url.pathname === "/api/v1/events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write("retry: 10000\n\n: connected\n\n");
      return;
    }
    if (reply) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(reply));
    }
    const file = staticFile(distDir, url.pathname);
    if (!file) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": file.contentType });
    res.end(file.body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}
