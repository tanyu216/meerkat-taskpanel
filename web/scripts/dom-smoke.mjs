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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSER_LAYER_RULES, IMPLEMENTED_CONTRACT_ITEMS } from "../../test/web/blocks.contract.mjs";

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
    id: overrides.id ?? `td_${projectId}_${status}`,
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
  const mk = (id, name, taskCount) => ({
    id,
    name,
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
  const projects = [mk("p1", "MeerkatTaskPanel", 12), mk("p2", "Orchestrator", 4), mk("p3", "Site Refresh", 2)];
  const orderDebug = [
    { id: "p1", name: "MeerkatTaskPanel", order: 1, total: 0.9, archived: false },
    { id: "p2", name: "Orchestrator", order: 2, total: 0.4, archived: false },
    { id: "p3", name: "Site Refresh", order: 3, total: 0.2, archived: false },
  ];
  // 12 cards, all in the default project (p1), covering the seven statuses.
  const tasks = [
    // TD-1 is the card the drawer opens on in the interaction pass, so it is the
    // one that carries attachments — the same shape the prototype's sampled card
    // has (two rows). `meta.attachment_count` states the same number the list
    // shows, so the card badge and the drawer cannot disagree.
    fixture("p1", "backlog", {
      identifier: "TD-1",
      title: "Draft the onboarding copy",
      priority: "low",
      labels: ["design"],
      assignee: AGENT.pi,
      meta: {
        attachment_count: 2,
        attachments: [
          { filename: "board-keyboard-spec.md", size: 12 * 1024 },
          { filename: "focus-order-record.png", size: 248 * 1024 },
        ],
      },
    }),
    fixture("p1", "backlog", { identifier: "TD-2", title: "Collect the install survey", priority: "none", labels: [], assignee: AGENT.human }),
    fixture("p1", "todo", { identifier: "TD-3", title: "Wire the board", priority: "high", labels: ["bug"], assignee: AGENT.claude }),
    fixture("p1", "todo", { identifier: "TD-4", title: "Polish the empty states", priority: "medium", labels: ["ui"], assignee: AGENT.codex }),
    fixture("p1", "in_progress", { identifier: "TD-5", title: "Fix the renderer", priority: "urgent", labels: ["bug", "ui"], assignee: AGENT.codex }),
    fixture("p1", "in_progress", { identifier: "TD-6", title: "Profile the board scroll", priority: "high", labels: ["perf"], assignee: AGENT.claude }),
    fixture("p1", "in_review", { identifier: "TD-7", title: "Audit the token store", priority: "medium", labels: ["security"], assignee: AGENT.openclaw }),
    fixture("p1", "in_review", { identifier: "TD-8", title: "Redesign the sidebar rail", priority: "low", labels: ["design", "ui"], assignee: AGENT.pi }),
    fixture("p1", "blocked", { identifier: "TD-9", title: "Waiting on review", priority: "high", labels: ["bug"], assignee: AGENT.claude }),
    // M1 · the 「等你回复」card. Its status is the overlay, so it is *listed* under
    // in_progress (the seventh column count does not change) and it wears the
    // badge; `awaiting_reason` is the entry category the badge carries.
    fixture("p1", "awaiting", { identifier: "TD-13", title: "Confirm the release scope before the cut", priority: "urgent", labels: ["design"], assignee: AGENT.claude, awaiting_reason: "E1" }),
    fixture("p1", "done", { identifier: "TD-10", title: "Ship the CLI", priority: "low", labels: [], assignee: AGENT.human }),
    fixture("p1", "canceled", { identifier: "TD-11", title: "Drop the legacy importer", priority: "none", labels: ["perf"], assignee: AGENT.openclaw }),
    fixture("p1", "done", { identifier: "TD-12", title: "Lock down the webhooks", priority: "medium", labels: ["security", "design"], assignee: AGENT.pi }),
  ];
  const entries = [
    { id: "a1", kind: "agent", display_name: "linus", normalized_name: "linus", platform: "claude" },
    { id: "a2", kind: "agent", display_name: "jobs", normalized_name: "jobs", platform: "codex" },
    { id: "a3", kind: "agent", display_name: "elon", normalized_name: "elon", platform: "openclaw" },
    { id: "a4", kind: "agent", display_name: "assistant", normalized_name: "assistant", platform: "pi" },
    { id: "h1", kind: "human", display_name: "Terry", normalized_name: "terry", platform: null },
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
    "TD-13": [
      { id: "cm-1", task_id: "TD-13", kind: "note", author_kind: "agent", author_id: "linus", body: "我先把迁移写完了。", refs: [], created_at: "2026-10-12T00:01:00Z" },
      { id: "cm-2", task_id: "TD-13", kind: "decision", author_kind: "human", author_id: "Terry", body: "范围确认：这一版不做第 8 列。后面还有一句不该出现在摘要里。", refs: [], created_at: "2026-10-12T00:02:00Z" },
    ],
  };
  // M2 — the audit trail the drawer's activity stream renders (B09). One row per
  // sentence the catalogue names plus the move's own `from → to` line, so both
  // rungs of the relative-time ladder (`…h ago` and `…d ago`) are exercised.
  const activities = [
    { id: "act-1", task_id: "TD-1", actor_kind: "human", actor_id: "Terry", event: "task_created", changes: {}, revision: 1, created_at: "2026-10-09T08:00:00Z" },
    { id: "act-2", task_id: "TD-1", actor_kind: "agent", actor_id: "jobs", event: "task_claimed", changes: {}, revision: 2, created_at: "2026-10-10T08:00:00Z" },
    { id: "act-3", task_id: "TD-1", actor_kind: "human", actor_id: "Terry", event: "task_moved", changes: { from: "backlog", to: "todo" }, revision: 3, created_at: "2026-10-11T08:00:00Z" },
    { id: "act-4", task_id: "TD-1", actor_kind: "agent", actor_id: "jobs", event: "comment_added", changes: {}, revision: 4, created_at: "2026-10-12T02:00:00Z" },
  ];
  return { projects, orderDebug, tasks, entries, labels, comments, activities };
}

/**
 * Boot the fixture API + static `web/dist` server.
 *
 * `port` defaults to 0 (an ephemeral port), which is what the smoke itself and
 * `shot-compare.mjs` want. A caller that has to *name* the port up front — the
 * `ui-align` machine check, whose `devServer` leg is handed a free port by the
 * engine — passes `{ port }` so the server binds where the engine is looking.
 */
export function startServer({ port = 0 } = {}) {
  const data = fixtureApi();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const ok = (d) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, data: d }));
    };

    if (path === "/health") return ok({ status: "ok", revision: 5 });
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
    if (activitiesFor) return ok({ task_id: decodeURIComponent(activitiesFor[1]), activities: data.activities });
    if (path.startsWith("/api/v1/tasks/")) return ok({ task: data.tasks[0], report_waivers: [] });
    if (path === "/api/v1/assignees" || path === "/api/v1/reporters") return ok({ entries: data.entries });
    if (path === "/api/v1/labels") return ok({ labels: data.labels });
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
    server.listen(port, "127.0.0.1", () => resolvePromise({ server, port: server.address().port, data }));
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
  const px = (value) => Number.parseFloat(value);
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
  for (const { block, rule } of rules) {
    const record = { block, kind: rule.kind, selector: rule.selector ?? null, probe: rule.probe ?? null, within: rule.within ?? null, ok: true, detail: "" };
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
          for (const node of nodes) {
            const actual = getComputedStyle(node)[rule.property];
            const fail = (why) => { record.ok = false; record.detail = `${rule.property} = ${actual} ${why}`; };
            if (rule.equals !== undefined && actual !== rule.equals) { fail(`!= ${rule.equals}`); break; }
            if (rule.equalsVar !== undefined && actual !== expected) { fail(`!= var(${rule.equalsVar}) = ${expected}`); break; }
            if (rule.notEquals !== undefined && actual === rule.notEquals) { fail(`== ${rule.notEquals}`); break; }
            if (rule.notEqualsVar !== undefined && actual === expected) { fail(`== var(${rule.notEqualsVar}) = ${expected}`); break; }
            if (rule.contains !== undefined && !actual.includes(rule.contains)) { fail(`does not contain ${rule.contains}`); break; }
            if (rule.startsWith !== undefined && !actual.startsWith(rule.startsWith)) { fail(`does not start with ${rule.startsWith}`); break; }
            if (rule.endsWith !== undefined && !actual.endsWith(rule.endsWith)) { fail(`does not end with ${rule.endsWith}`); break; }
            if (rule.tokens !== undefined && trackCount(actual) !== rule.tokens) { fail(`is not ${rule.tokens} tracks`); break; }
            if (rule.equalsPx !== undefined && Math.abs(px(actual) - rule.equalsPx) > 0.5) { fail(`!= ${rule.equalsPx}px`); break; }
            if (rule.maxPx !== undefined && px(actual) > rule.maxPx) { fail(`> ${rule.maxPx}px`); break; }
            if (rule.minPx !== undefined && px(actual) < rule.minPx) { fail(`< ${rule.minPx}px`); break; }
            if (rule.differsFrom !== undefined) {
              const other = doc.querySelector(rule.differsFrom);
              if (!other || getComputedStyle(other)[rule.property] === actual) { fail(`is not distinguishable from ${rule.differsFrom}`); break; }
            }
          }
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
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-column]", { timeout: 8000 });
    await page.waitForTimeout(600);

    const boardRules = EVALUATED_RULES.filter((e) => !e.rule.when || e.rule.when === "board view").map((e) => ({ block: e.block, rule: e.rule }));
    const listRules = EVALUATED_RULES.filter((e) => e.rule.when === "list view").map((e) => ({ block: e.block, rule: e.rule }));
    const railRules = EVALUATED_RULES.filter((e) => e.rule.when === "rail").map((e) => ({ block: e.block, rule: e.rule }));
    const panelRules = EVALUATED_RULES.filter((e) => e.rule.when === "panel open").map((e) => ({ block: e.block, rule: e.rule }));

    const boardResults = await page.evaluate(evaluateRules, boardRules);
    await page.click('[data-view="list"]');
    await page.waitForTimeout(200);
    const listResults = await page.evaluate(evaluateRules, listRules);
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
      return {
        state: drawer?.getAttribute("data-state") ?? null,
        hidden: drawer?.hasAttribute("hidden") ?? true,
        title,
        agentSessionHook: session !== null,
      };
    });

    // The contract rules whose precondition is the *open drawer* — its attachment
    // and activity rows are projected from the task on screen, so they exist here
    // and nowhere else. Evaluated between the open and the Escape.
    const drawerRules = EVALUATED_RULES.filter((entry) => entry.rule.when === "drawer open").map((entry) => ({
      block: entry.block,
      rule: entry.rule,
    }));
    const drawerResults = await page.evaluate(evaluateRules, drawerRules);

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
    const railResults = await page.evaluate(evaluateRules, railRules);
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

    // ③ — the settings dialog is the prototype's centred modal: open it at the
    // measured viewport and check the geometry, then close it again.
    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(150);
    await page.click("[data-access-open]");
    await page.waitForTimeout(200);
    const panelResults = await page.evaluate(evaluateRules, panelRules);
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
    r6Check(panelGeometry.cidrRows === 3, `the CIDR list has ${panelGeometry.cidrRows} rows, expected 3`);
    r6Check(/^td_•+$/.test(panelGeometry.tokenMask), `the token mask is ${JSON.stringify(panelGeometry.tokenMask)}`);
    r6Check(
      panelGeometry.tokenIconsVisible.length === 1,
      `${panelGeometry.tokenIconsVisible.length} token glyphs visible, expected 1`,
    );
    await page.click("[data-access-close]");
    await page.waitForTimeout(200);
    const panelClosed = await page.evaluate(() => ({
      state: document.querySelector("[data-access-panel]")?.getAttribute("data-state"),
      hidden: document.querySelector("[data-access-panel]")?.hasAttribute("hidden"),
    }));
    r6Check(panelClosed.state === "closed" && panelClosed.hidden === true, "the settings panel did not close");

    // ⑤ — the list's own relations: one dot per status chip, and a rule that runs
    // *between* rows (the first row draws no top edge).
    for (const dots of listDetail.dotsPerChip) r6Check(dots === 1, `a list status chip holds ${dots} status dots, expected 1`);
    r6Check(listDetail.firstTopBorder === 0, `the first list row draws a ${listDetail.firstTopBorder}px top border, expected none`);
    r6Check(listDetail.laterTopBorder === 1, `the second list row draws a ${listDetail.laterTopBorder}px top border, expected 1`);

    // --- five viewports, none may overflow horizontally -----------------------
    const viewports = [];
    for (const width of [1512, 1240, 980, 760, 500]) {
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

    // ---- M1 · the 「等你回复」surface ----------------------------------------
    //
    // The design's §8 list, evaluated where it has to be evaluated: in a browser,
    // against computed style and live DOM. Everything here is a selector, a
    // computed value or a text comparison — never "it looks right".
    const m1 = await page.evaluate(() => {
      const badge = document.querySelector("[data-card-waiting]");
      const awaitingCard = document.querySelector('[data-card][data-identifier="TD-13"]');
      const countPill = document.querySelector('[data-nav-count="waiting"]');
      const rows = [...document.querySelectorAll("[data-waiting-card]")];
      const summary = document.querySelector("[data-waiting-payload-summary]");
      const details = document.querySelector("[data-waiting-payload-details]");
      const full = document.querySelector("[data-waiting-payload-full]");
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
        rowStatuses: rows.map((row) => row.getAttribute("data-status")),
        summary: summary?.textContent?.trim() ?? null,
        detailsTag: details?.tagName ?? null,
        detailsOpen: details ? details.hasAttribute("open") : null,
        full: full?.textContent?.trim() ?? null,
        fullMaxWidth: full ? getComputedStyle(full).maxWidth : null,
        fullWhiteSpace: full ? getComputedStyle(full).whiteSpace : null,
        // §8-14 caps the payload at `max-width: 68ch`. A browser reports
        // `maxWidth` as a resolved px length, never in `ch`, so the literal has to
        // be resolved in the *element's own* font (font-size included) for the
        // comparison to mean anything.
        maxChPx: (() => {
          if (!full) return null;
          const cs = getComputedStyle(full);
          const probe = document.createElement("span");
          probe.style.position = "absolute";
          probe.style.visibility = "hidden";
          probe.style.whiteSpace = "pre";
          probe.style.fontFamily = cs.fontFamily;
          probe.style.fontSize = cs.fontSize;
          probe.style.fontWeight = cs.fontWeight;
          probe.style.fontStyle = cs.fontStyle;
          probe.style.fontStretch = cs.fontStretch;
          probe.style.letterSpacing = cs.letterSpacing;
          probe.textContent = "0".repeat(68);
          document.body.appendChild(probe);
          const width = probe.getBoundingClientRect().width;
          probe.remove();
          return width;
        })(),
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
      const board = document.querySelector("[data-board]");
      return {
        current: document.querySelector('[data-nav-item="waiting"]')?.getAttribute("aria-current") ?? null,
        viewVisible: section ? !section.hasAttribute("hidden") : false,
        boardHidden: board ? board.hasAttribute("hidden") : false,
        emptyShown: !!document.querySelector("[data-waiting-empty]"),
      };
    });
    await page.click('[data-nav-item="board"]');
    await page.waitForTimeout(120);

    const FIRST_SENTENCE = "范围确认：这一版不做第 8 列。";
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
    check(m1.countText === "1", `count pill ${m1.countText} !== 1`);
    check(m1.countHidden === false, "a non-zero count must not be hidden");
    check(m1.rows === 1, `[data-waiting-card] count ${m1.rows} !== 1`);
    check(m1.rowStatuses.every((s) => s === "awaiting"), `row statuses ${m1.rowStatuses.join(",")}`);
    check(m1.summary === FIRST_SENTENCE, `summary ${JSON.stringify(m1.summary)}`);
    check(m1.detailsTag === "DETAILS", `payload disclosure tag ${m1.detailsTag}`);
    check(m1.detailsOpen === false, "the payload disclosure must be closed by default");
    check((m1.full ?? "").includes("不该出现在摘要里"), "the full text must be the comment verbatim");
    check(m1.fullWhiteSpace === "pre-wrap", `payload white-space ${m1.fullWhiteSpace}`);
    check(
      m1.maxChPx !== null && Number.parseFloat(m1.fullMaxWidth) <= m1.maxChPx + 0.5,
      `payload max-width ${m1.fullMaxWidth} exceeds 68ch (${m1.maxChPx}px at this font)`,
    );
    check(m1.freshnessHooks === 0, "no freshness hook may exist inside a card");
    check(!awaitingMenuLabels.some((label) => /In Review|Done|Blocked/i.test(label)), `awaiting menu offers ${awaitingMenuLabels.join("|")}`);
    check(awaitingMenuLabels.some((label) => /Canceled/i.test(label)), "awaiting menu must offer Canceled");
    check(waitingView.current === "page", "the waiting nav item must carry aria-current");
    check(waitingView.viewVisible === true, "the waiting view must be visible");
    check(waitingView.boardHidden === true, "the board must be hidden while the waiting view is up");
    check(waitingView.emptyShown === false, "a non-empty view must not show the empty state");

    const results = [...boardResults, ...listResults, ...railResults, ...panelResults, ...drawerResults];
    const failures = results.filter((r) => !r.ok);
    const viewportFailures = viewports.filter((v) => !v.ok);
    return {
      consoleErrors,
      pageErrors,
      failures,
      viewports,
      viewportFailures,
      interactions,
      m1,
      m1Failures,
      r6: { failures: r6Failures, themeSweep, titleGeometry, listDetail, panel: panelGeometry, rail },
      geometry,
      counts: { rules: results.length, failed: failures.length, ...geometry },
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
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) run().then(
  (report) => {
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`columns=${report.geometry.columns} cards=${report.geometry.cards} rules=${report.counts.rules} failed=${report.counts.failed}`);
      console.log(`console errors=${report.consoleErrors.length} page errors=${report.pageErrors.length}`);
      for (const error of [...report.consoleErrors, ...report.pageErrors]) console.log(`  ! ${error}`);
      for (const failure of report.failures) console.log(`  ✗ ${failure.block} ${failure.kind} ${failure.selector ?? failure.probe ?? ""} — ${failure.detail}`);
      console.log(`viewports: ${report.viewports.map((v) => `${v.width}${v.ok ? "ok" : "OVERFLOW"}`).join(" ")}`);
      console.log(`interactions: ${JSON.stringify(report.interactions)}`);
      if (report.m1Failures.length > 0) {
        console.log(`M1 (awaiting) — ${report.m1Failures.length} failed:`);
        for (const failure of report.m1Failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("M1 (awaiting) — badge, view, count, payload and menu all pass");
      }
      if (report.r6.failures.length > 0) {
        console.log(`R6 (fidelity) — ${report.r6.failures.length} failed:`);
        for (const failure of report.r6.failures) console.log(`  ✗ ${failure}`);
      } else {
        console.log("R6 (fidelity) — theme glyphs, title clamp, list geometry and the settings modal all pass");
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
