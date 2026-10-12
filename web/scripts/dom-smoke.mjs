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

    const boardResults = await page.evaluate(evaluateRules, boardRules);
    await page.click('[data-view="list"]');
    await waitForListSettled();
    await page.waitForTimeout(120);
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
        state: drawer?.getAttribute("data-state") ?? null,
        hidden: drawer?.hasAttribute("hidden") ?? true,
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
        const expected = (entry.title ?? "").length > 8 ? `${(entry.title ?? "").slice(0, 8)}…` : entry.title;
        r8Check(entry.hasIdClass, `${selector} ${JSON.stringify(entry.title)} does not wear .td-id`);
        r8Check(entry.whiteSpace === "nowrap", `${selector} white-space is ${entry.whiteSpace}, expected nowrap`);
        r8Check(typeof entry.title === "string" && entry.title.length > 0, `${selector} carries no title`);
        r8Check(entry.text === expected, `${selector} renders ${JSON.stringify(entry.text)}, expected ${JSON.stringify(expected)}`);
        r8Check(entry.text.length <= 9, `${selector} renders ${entry.text.length} characters`);
        // N4/B21-B23 — the root keeps the whole value, and the rendered text may
        // never be the thing read back (it is the truncated form whenever the id
        // is long enough to be truncated at all).
        r8Check(entry.root === entry.title, `${selector}: the root's data-identifier ${JSON.stringify(entry.root)} != the title ${JSON.stringify(entry.title)}`);
      }
    }
    // A 6-character id is not truncated and gains no ellipsis (the fixture's ids
    // are all short, so every one of them is a below-the-cap sample; the cap's own
    // trigger — a 9-character id — is covered by `test/web/identifier.test.mjs`,
    // which can construct one without touching the shared fixture).
    for (const entry of identifiers["[data-card-identifier]"]) {
      if ((entry.title ?? "").length <= 8) r8Check(entry.text === entry.title, `a ${entry.title.length}-character id was altered: ${JSON.stringify(entry.text)}`);
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
      const loadingResults = await page.evaluate(evaluateRules, listLoadingRules);
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
    await page.click("[data-new-task]");
    await page.waitForTimeout(300);
    const fill = await page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const row = rect("[data-create-two-col]");
      const left = rect("[data-create-left]");
      const editor = rect("[data-md-editor]");
      const panes = rect(".td-md-panes");
      const source = rect("[data-md-source]");
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
          const el = document.querySelector("[data-md-source]");
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

    // …and the same chain one breakpoint down, where there is no neighbour to
    // stretch to: the panes' floor is what keeps the editor usable.
    await page.setViewportSize({ width: 500, height: 900 });
    await page.waitForTimeout(250);
    const narrowFill = await page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const editor = document.querySelector("[data-md-editor]")?.getBoundingClientRect();
      const panes = document.querySelector(".td-md-panes")?.getBoundingClientRect();
      const source = document.querySelector("[data-md-source]")?.getBoundingClientRect();
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

    /* ---- R11 ①/② · R13 — the status filter, the roster route and the assignee
       constraint ---------------------------------------------------------------
       The design contracts' machine checks, ported to the shipped app: R11 §5
       (the status control's domain/order/OR-and-AND semantics, the roster names
       that route) and R13 §5 (the named assignee, the width-neutral capsule, the
       bar's `x`). Every assertion is a **data hook + attribute** or a computed
       value — never a class name (R11 §5 C′9, R13 §5.4).

       Two families of the contracts' rows are deliberately not asserted:
       the JS-off rows (R11 A4.x / A8 / C-12) — a Vue SPA has no SSR, the written
       deviation the block contract already records (C06) — and R11's C-6 ("the
       press writes the name into no filter"), which R13 §2.2 replaces with the
       opposite: the press narrows as well as routes. */
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
        for (const hook of ["data-filter-assignee", "data-assignee-clear", "data-filter-priority",
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
      const name = document.querySelector("[data-filter-assignee]")?.value ?? "all";
      const cardMatches = (el) => {
        const cardName = attr(el, "data-assignee") ?? "";
        const kind = attr(el, "data-assignee-kind");
        const okName = name === "all" ? true
          : name === "me" ? cardName === "Terry"
          : name === "human" || name === "agent" ? kind === name
          : cardName === name;
        const okStatus = statusSet.length === 0 ? true : statusSet.includes(attr(el, "data-status"));
        return okName && okStatus;
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
        clearCount: document.querySelectorAll("[data-assignee-clear]").length,
        clearHidden: attr(document.querySelector("[data-assignee-clear]"), "hidden") !== null,
        clearPainted: painted(document.querySelector("[data-assignee-clear]")),
        clearInsideBar: !!document.querySelector("[data-filters] [data-assignee-clear]"),
        clearIsSibling: (() => {
          const clear = document.querySelector("[data-assignee-clear]");
          const control = document.querySelector("[data-filter-assignee]");
          return !!clear && !!control && control.nextElementSibling === clear;
        })(),
        clearGlyph: document.querySelector("[data-assignee-clear]")?.textContent.trim() ?? null,
        assigneeValue: name,
        staticOptions: [...document.querySelectorAll("[data-filter-assignee] option")]
          .filter((el) => !el.hasAttribute("data-assignee-filter-option")).length,
        namedOptionValues: [...document.querySelectorAll("[data-filter-assignee] [data-assignee-filter-option]")]
          .map((el) => attr(el, "data-assignee-filter-option")),
        b22Options: document.querySelectorAll("[data-assignee-option]").length,
        b22InMenu: [...document.querySelectorAll("[data-assignee-option]")].filter((el) => el.closest("[data-assignee-menu]")).length,
        countText: document.querySelector("[data-filter-count]")?.textContent.trim() ?? null,
        toastChildren: document.querySelector("[data-toast-region]")?.children.length ?? 0,
        listState: attr(document.querySelector("[data-list]"), "data-list-state"),
        listRowCount: document.querySelectorAll("[data-list-rows] [data-list-row]").length,
        listRowStatuses: [...document.querySelectorAll("[data-list-rows] [data-list-status]")].map((el) => attr(el, "data-status")),
        viewCurrent: attr(document.querySelector('[data-nav-item][aria-current="page"]'), "data-nav-item"),
        listPressed: attr(document.querySelector('[data-view="list"]'), "aria-pressed"),
        boardHidden: document.querySelector("[data-board-view]")?.hasAttribute("hidden") ?? null,
        expectedRows: boardCards.filter(cardMatches).length,
        expectedIds: boardCards.filter(cardMatches).map((el) => `${attr(el, "data-identifier")}/${attr(el, "data-assignee")}/${attr(el, "data-status")}`),
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
      return {
        rows: hosts.map((el) => ({ clip: el.scrollWidth - el.clientWidth, overflow: getComputedStyle(el).overflowX })),
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
      };
    });

    const restR11 = await readR11();
    const restRoster = await measureRoster();
    const R11_KEYS = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];

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
    // R13 A1/A2 — the roster items, one name button each, no `x` inside.
    r11Check(restR11.itemNames.length > 0, "the roster renders no [data-assignee-item]");
    r11Check(restR11.itemNames.length === new Set(restR11.itemNames).size, `duplicate roster names ${restR11.itemNames.join(",")}`);
    r11Check(restR11.buttonsPerItem.every((n) => n === 1), `name buttons per item ${restR11.buttonsPerItem.join(",")}`);
    r11Check(restR11.clearsPerItem.every((n) => n === 0), `the roster must hold no [data-assignee-clear]: ${restR11.clearsPerItem.join(",")}`);
    r11Check(restR11.nameButtonTags.length === 1 && restR11.nameButtonTags[0] === "BUTTON", `roster names are ${restR11.nameButtonTags.join(",")}, expected BUTTON`);
    r11Check(restR11.activeItems.length === 0, `at rest ${restR11.activeItems.length} roster items are active`);
    // R13 A2.2/A4.4 — exactly one `x`, inside the bar, the control's sibling, hidden.
    r11Check(restR11.clearCount === 1, `[data-assignee-clear] count ${restR11.clearCount} !== 1`);
    r11Check(restR11.clearInsideBar === true, "the `x` must live inside [data-filters]");
    r11Check(restR11.clearIsSibling === true, "the `x` must be [data-filter-assignee]'s next sibling");
    r11Check(restR11.clearHidden === true && restR11.clearPainted === false, "the `x` must be hidden and unpainted at rest");
    r11Check(restR11.clearGlyph === "✕", `the \`x\` glyph is ${JSON.stringify(restR11.clearGlyph)}`);
    // R13 A3/R2.1 — the control's four static rows, no named option at rest, and
    // B22's bare seats untouched by this round's hook.
    r11Check(restR11.staticOptions === 4, `static assignee options ${restR11.staticOptions} !== 4`);
    r11Check(restR11.namedOptionValues.length === 0, `at rest ${restR11.namedOptionValues.length} named options exist`);
    r11Check(restR11.assigneeValue === "all", `resting assignee value ${restR11.assigneeValue} !== all`);
    r11Check(restR11.b22Options === restR11.b22InMenu, `[data-assignee-option] ${restR11.b22Options} seats, ${restR11.b22InMenu} inside [data-assignee-menu]`);

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

    // Roster route — press a name and read the four facts (R11 C-5 + R13 C1).
    const rosterNames = restR11.itemNames;
    const [firstName, secondName] = rosterNames;
    r11Check(rosterNames.length >= 2, `the fixture must offer two roster names, got ${rosterNames.length}`);
    await page.click(`[data-agent-assignee="${firstName}"]`);
    await page.waitForTimeout(400); // the list view reads on entry
    const r11Route = await readR11();
    r11Check(r11Route.viewCurrent === "list", `the route left the view on ${r11Route.viewCurrent}`);
    r11Check(r11Route.listPressed === "true", `[data-view="list"] aria-pressed=${r11Route.listPressed}`);
    r11Check(r11Route.statusValue === "in_progress,in_review", `the route wrote status ${r11Route.statusValue}`);
    r11Check(r11Route.assigneeValue === firstName, `the route wrote assignee ${r11Route.assigneeValue}, expected ${firstName}`);
    r11Check(r11Route.activeItems.length === 1 && r11Route.activeItems[0] === firstName, `active roster items ${r11Route.activeItems.join(",")}`);
    r11Check(r11Route.pressedNames.length === 1 && r11Route.pressedNames[0] === firstName, `pressed names ${r11Route.pressedNames.join(",")}`);
    r11Check(r11Route.namedOptionValues.length === 1 && r11Route.namedOptionValues[0] === firstName, `named options ${r11Route.namedOptionValues.join(",")}`);
    r11Check(r11Route.clearHidden === false && r11Route.clearPainted === true, "the `x` must appear with a named assignee");
    r11Check(r11Route.b22Options === restR11.b22Options, `B22's seat count moved ${restR11.b22Options} → ${r11Route.b22Options}`);
    r11Check(r11Route.listState === "data", `the list settled on ${r11Route.listState}`);
    r11Check(r11Route.listRowCount === r11Route.expectedRows, `list shows ${r11Route.listRowCount} rows (${r11Route.listIds.join(" | ")}), ${r11Route.expectedRows} expected (${r11Route.expectedIds.join(" | ")})`);
    r11Check(r11Route.listRowCount > 0, "the route narrowed to nothing");
    // R11 §5 C-5 — every routed row is in flight. The list's chip states the
    // card's **raw** status, and M1's `awaiting` is an overlay a card wears while
    // it stays on `in_progress` (the board renders it in that column, and the
    // filter matches it there) — so `awaiting` is the third member of the "in
    // flight" set here, not an escape hatch. On the prototype, where the overlay
    // does not exist, the set is the contract's two.
    r11Check(
      r11Route.listRowStatuses.every((s) => s === "in_progress" || s === "in_review" || s === "awaiting"),
      `routed rows carry statuses ${[...new Set(r11Route.listRowStatuses)].join(",")}`,
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

    // R13 C4 — switching names moves the capsule, never doubles it.
    if (secondName) {
      await page.click(`[data-agent-assignee="${secondName}"]`);
      await page.waitForTimeout(300);
      const r11Switch = await readR11();
      r11Check(r11Switch.activeItems.length === 1 && r11Switch.activeItems[0] === secondName, `switched active ${r11Switch.activeItems.join(",")}`);
      r11Check(r11Switch.namedOptionValues.length === 1 && r11Switch.namedOptionValues[0] === secondName, `switched named option ${r11Switch.namedOptionValues.join(",")}`);
      r11Check(r11Switch.assigneeValue === secondName, `switched value ${r11Switch.assigneeValue}`);
      r11Check(r11Switch.statusValue === "in_progress,in_review", `switching names moved the status set to ${r11Switch.statusValue}`);

      // R13 C3 — the `x` clears the assignee and nothing else.
      const beforeX = await readR11();
      await page.click("[data-assignee-clear]");
      await page.waitForTimeout(150);
      const afterX = await readR11();
      r11Check(afterX.assigneeValue === "all", `after \`x\` the assignee is ${afterX.assigneeValue}`);
      r11Check(afterX.namedOptionValues.length === 0, `after \`x\` ${afterX.namedOptionValues.length} named options remain`);
      r11Check(afterX.activeItems.length === 0, `after \`x\` ${afterX.activeItems.length} roster items stay active`);
      r11Check(afterX.clearHidden === true && afterX.clearPainted === false, "after `x` the control must hide again");
      r11Check(afterX.statusValue === beforeX.statusValue, `\`x\` moved the status set ${beforeX.statusValue} → ${afterX.statusValue}`);
      r11Check(afterX.viewCurrent === "list", `\`x\` switched the view to ${afterX.viewCurrent}`);
      r11Check(afterX.toastChildren === beforeX.toastChildren, "`x` must not raise a toast");
      r11Check(
        afterX.countText === beforeX.countText || afterX.listRowCount >= beforeX.listRowCount,
        "clearing the assignee must widen (or hold) the row set, never narrow it",
      );
    }

    // R13 C5 — pressing the name in force again is the capsule's own close: the
    // assignee goes, the view and the status set stay.
    await page.click(`[data-agent-assignee="${firstName}"]`);
    await page.waitForTimeout(300);
    const r11Reopen = await readR11();
    r11Check(r11Reopen.assigneeValue === firstName, `re-route wrote ${r11Reopen.assigneeValue}`);
    const statusBeforeToggle = r11Reopen.statusValue;
    await page.click(`[data-agent-assignee="${firstName}"]`);
    await page.waitForTimeout(200);
    const r11Toggle = await readR11();
    r11Check(r11Toggle.assigneeValue === "all", `the toggle left the assignee on ${r11Toggle.assigneeValue}`);
    r11Check(r11Toggle.activeItems.length === 0, `the toggle left ${r11Toggle.activeItems.length} active items`);
    r11Check(r11Toggle.statusValue === statusBeforeToggle, `the toggle moved the status set ${statusBeforeToggle} → ${r11Toggle.statusValue}`);
    r11Check(r11Toggle.viewCurrent === "list", `the toggle switched the view to ${r11Toggle.viewCurrent}`);
    r11Check(r11Toggle.clearHidden === true, "the toggle must hide the `x`");
    await closeFloating();

    // Base state again, so the sections after this one read the resting board.
    await page.click("[data-nav-item='board']");
    await page.waitForTimeout(150);


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
      // R10 ① — the board gives way **whole**, wrapper included: the view root is
      // what carries `hidden` now, because hiding only the board would leave the
      // board-level empty state floating above whichever view replaces it.
      const boardView = document.querySelector("[data-board-view]");
      return {
        current: document.querySelector('[data-nav-item="waiting"]')?.getAttribute("aria-current") ?? null,
        viewVisible: section ? !section.hasAttribute("hidden") : false,
        boardHidden: boardView ? boardView.hasAttribute("hidden") : false,
        boardPainted: boardView ? boardView.getClientRects().length > 0 : false,
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
    check(waitingView.boardHidden === true, "the board view must be hidden while the waiting view is up");
    check(waitingView.boardPainted === false, "the board view must not be painted while the waiting view is up");
    check(waitingView.emptyShown === false, "a non-empty view must not show the empty state");

    // The in-flight list rules are answered inside the r9 section's own window
    // (the read is held open there), so their records are folded in here and
    // every declared rule is counted exactly once.
    const results = [...boardResults, ...listResults, ...railResults, ...panelResults, ...drawerResults, ...listEn.loadingResults];
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
      r7: { failures: r7Failures, wide, rail: railBand, drawerHead: closeR7 },
      r8: { failures: r8Failures, headWide, headNarrow, identifiers, drawerIdentifier, dark, light },
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
      r12: {
        failures: r12Failures,
        tiers: R12_TIERS.map((t) => `${t.width}x${t.height}`),
        tierGeometry: r12Tiers,
        adaptHeight: adapt.board.heights[0],
        heights: r12Heights,
      },
      r11: { failures: r11Failures },
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
        console.log("R11/R13 (fidelity) — the status filter, the roster route, the named assignee, the width-neutral capsule and the bar's `x` all pass");
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
      report.r9.failures.length === 0 &&
      report.r10.failures.length === 0 &&
      report.r12.failures.length === 0 &&
      report.r11.failures.length === 0 &&
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
