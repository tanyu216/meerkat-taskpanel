/**
 * Host-only DOM smoke + block-contract runner (M6b · F2 L2).
 *
 * The **browser layer**: it serves the built app (`web/dist`) against a small
 * fixture API, opens it in a headless Chromium, and reports
 *
 *   * every **console error** and **page error** (the acceptance bar is zero), and
 *   * the result of each `BROWSER_LAYER_RULES` assertion from
 *     `test/web/blocks.contract.mjs`, evaluated against the live DOM.
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

import { BROWSER_LAYER_RULES } from "../../test/web/blocks.contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
export const DIST = resolve(WEB, "dist");

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
    meta: {},
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
 * here are fixture data, never asserted — the 99 browser-layer rules assert
 * structure, not how many rows this function returns.
 */
export function fixtureApi() {
  const mk = (id, name) => ({
    id,
    name,
    workspace_path: `/w/${id}`,
    labels: [],
    meta: {},
    readme: null,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  const projects = [mk("p1", "MeerkatTaskPanel"), mk("p2", "Orchestrator")];
  const orderDebug = [
    { id: "p1", name: "MeerkatTaskPanel", order: 1, total: 0.9, archived: false },
    { id: "p2", name: "Orchestrator", order: 2, total: 0.4, archived: false },
  ];
  // 12 cards, all in the default project (p1), covering the seven statuses.
  const tasks = [
    fixture("p1", "backlog", { identifier: "TD-1", title: "Draft the onboarding copy", priority: "low", labels: ["design"], assignee: AGENT.pi }),
    fixture("p1", "backlog", { identifier: "TD-2", title: "Collect the install survey", priority: "none", labels: [], assignee: AGENT.human }),
    fixture("p1", "todo", { identifier: "TD-3", title: "Wire the board", priority: "high", labels: ["bug"], assignee: AGENT.claude }),
    fixture("p1", "todo", { identifier: "TD-4", title: "Polish the empty states", priority: "medium", labels: ["ui"], assignee: AGENT.codex }),
    fixture("p1", "in_progress", { identifier: "TD-5", title: "Fix the renderer", priority: "urgent", labels: ["bug", "ui"], assignee: AGENT.codex }),
    fixture("p1", "in_progress", { identifier: "TD-6", title: "Profile the board scroll", priority: "high", labels: ["perf"], assignee: AGENT.claude }),
    fixture("p1", "in_review", { identifier: "TD-7", title: "Audit the token store", priority: "medium", labels: ["security"], assignee: AGENT.openclaw }),
    fixture("p1", "in_review", { identifier: "TD-8", title: "Redesign the sidebar rail", priority: "low", labels: ["design", "ui"], assignee: AGENT.pi }),
    fixture("p1", "blocked", { identifier: "TD-9", title: "Waiting on review", priority: "high", labels: ["bug"], assignee: AGENT.claude }),
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
  return { projects, orderDebug, tasks, entries, labels };
}

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
  const out = [];
  for (const { block, rule } of rules) {
    const record = { block, kind: rule.kind, selector: rule.selector ?? null, within: rule.within ?? null, ok: true, detail: "" };
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

    const boardRules = BROWSER_LAYER_RULES.filter((e) => !e.rule.when || e.rule.when === "board view").map((e) => ({ block: e.block, rule: e.rule }));
    const listRules = BROWSER_LAYER_RULES.filter((e) => e.rule.when === "list view").map((e) => ({ block: e.block, rule: e.rule }));

    const boardResults = await page.evaluate(evaluateRules, boardRules);
    await page.click('[data-view="list"]');
    await page.waitForTimeout(200);
    const listResults = await page.evaluate(evaluateRules, listRules);

    // The states showcase has its own precondition; open it, evaluate, close it.
    const statesRules = BROWSER_LAYER_RULES.filter((e) => e.rule.when === "states showcase open").map((e) => ({ block: e.block, rule: e.rule }));
    await page.evaluate(() => document.querySelector("[data-states-open]")?.click());
    await page.waitForTimeout(150);
    const statesResults = await page.evaluate(evaluateRules, statesRules);
    await page.evaluate(() => document.querySelector("[data-states-close]")?.click());
    await page.waitForTimeout(120);

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
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const drawerClosed = await page.evaluate(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state"));

    // The shared "Move to" menu: opened from a card's kebab, one row per status.
    await page.evaluate(() => document.querySelector("[data-card-menu]")?.click());
    await page.waitForTimeout(120);
    const moveMenu = await page.evaluate(() => ({
      open: !!document.querySelector("[data-move-menu]"),
      rows: document.querySelectorAll("[data-move-to]").length,
    }));
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
    // live inside a `<details>` that would otherwise have to be opened for a
    // hit-test, so the handler is invoked directly (the binding is the same).
    await page.evaluate(() => document.querySelector('[data-lang-option="zh"]')?.click());
    await page.waitForTimeout(150);
    const langAfterZh = await page.evaluate(() => document.documentElement.getAttribute("lang"));
    await page.evaluate(() => document.querySelector('[data-lang-option="en"]')?.click());
    await page.waitForTimeout(150);
    const langAfterEn = await page.evaluate(() => document.documentElement.getAttribute("lang"));

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
      moveMenuOpened: moveMenu.open && moveMenu.rows === 7,
      themeCycleReturns: themeStart === themeEnd,
      themeRun,
      langZh: langAfterZh === "zh",
      langEn: langAfterEn === "en",
    };

    const results = [...boardResults, ...listResults, ...statesResults];
    const failures = results.filter((r) => !r.ok);
    const viewportFailures = viewports.filter((v) => !v.ok);
    return {
      consoleErrors,
      pageErrors,
      failures,
      viewports,
      viewportFailures,
      interactions,
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
      for (const failure of report.failures) console.log(`  ✗ ${failure.block} ${failure.kind} ${failure.selector ?? ""} — ${failure.detail}`);
      console.log(`viewports: ${report.viewports.map((v) => `${v.width}${v.ok ? "ok" : "OVERFLOW"}`).join(" ")}`);
      console.log(`interactions: ${JSON.stringify(report.interactions)}`);
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
