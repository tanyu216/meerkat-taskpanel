/**
 * T-20261014-125122 — independent recheck of the **integration tip** of R14's
 * two batch-B faces, on the built artefact (`web/dist`) in a real Chromium:
 *
 *   ① the relations row's structure (D37 / R14-B23 / BLOCKS.md §R14) — selector
 *      level: `[data-detail-relations]` is `div.td-rel`, one `.td-rel-item` per
 *      kind, all three catalogue names rendered with the catalogue's own words,
 *      each item holding `button.td-copy[data-relation-link]`.
 *   ② the drawer-open focus beat (`C2`) — `document.activeElement` after the
 *      opening is `[data-detail-close]`, and the implementation gets there by the
 *      *prototype's* beat (200 ms `setTimeout` + a `data-state === "open"`
 *      read-back), not by a `nextTick` flush.
 *
 * It also reads the two surfaces a regression would most likely show up on — the
 * card's own three relation counters (BLOCKS.md §R14: "a card and the drawer it
 * opens spell a kind identically") and the area's empty face on a card with no
 * relation — and it records the raw frame trace of the opening so the focus
 * reading can be audited rather than believed.
 *
 * ── Carrier ──────────────────────────────────────────────────────────────────
 * `listen(2)` is denied in this lane (every family, `EPERM`), so the page is
 * served by Playwright route interception against the built `dist` — the real
 * browser, the real layout, the real computed style, only the transport
 * replaced. See `fixture.mjs`'s header.
 *
 * Usage:
 *   node verify-integration.mjs --dist web/dist [--out out.json] [--label name]
 *   node verify-integration.mjs --dist <dir> --only relations     # mutations
 *   node verify-integration.mjs --dist <dir> --only focus
 *
 * Exit codes: 0 all checks green · 1 a check failed · 2 environment (no browser,
 * no `dist`) · 3 harness error. `--only <leg>` still *reports* every check but
 * only lets the named leg decide the exit code, which is what the negative
 * (mutation) round drives.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { DRAWER_ID, EMPTY_ID, ORIGIN, fixtureApi, mountRoutes } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const DIST = resolve(argOf("dist", join(REPO, "web/dist")));
/**
 * The `web/` tree the built `dist` came from. It defaults to this worktree, and
 * the negative round points it at the staged copy each mutation was built from,
 * so the source-level checks always describe the same SUT as the bundle.
 */
const SRC_WEB = resolve(argOf("src", join(REPO, "web")));
const OUT = argOf("out", null);
const LABEL = argOf("label", "impl");
const ONLY = argOf("only", null);

/** `--single-process` skips the Mach rendezvous registration the sandbox denies. */
const LAUNCH_ARGS = ["--single-process"];

const results = [];
const record = (id, leg, selector, assertion, expected, actual, pass, note = "") =>
  results.push({ id, leg, selector, assertion, expected, actual, pass: !!pass, note });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chk = (id, leg, selector, assertion, expected, actual, note = "") =>
  record(id, leg, selector, assertion, expected, actual, same(expected, actual), note);
const chkFn = (id, leg, selector, assertion, expected, actual, fn, note = "") =>
  record(id, leg, selector, assertion, expected, actual, fn(actual), note);

const read = (path) => readFileSync(path, "utf8");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function resolvePlaywright() {
  const roots = [process.env.PLAYWRIGHT_ROOT, join(process.cwd(), "node_modules")].filter(Boolean);
  for (const base of ["/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules"]) roots.push(base);
  try {
    const nvm = join(homedir(), ".nvm/versions/node");
    if (existsSync(nvm)) for (const v of readdirSync(nvm)) roots.push(join(nvm, v, "lib/node_modules"));
  } catch {
    /* best effort */
  }
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      return createRequire(join(root, "noop.js"))("playwright");
    } catch {
      /* next */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ readings */

/** The relations row of whatever drawer is open right now. */
const readRelations = () => {
  const root = document.querySelector("[data-detail-relations]");
  if (!root) return null;
  const cs = getComputedStyle(root);
  const items = [...root.querySelectorAll(".td-rel-item")];
  const norm = (el) =>
    el === null ? "null" : el === document.body ? "body" : `<${el.tagName.toLowerCase()}${el.hasAttribute("data-detail-close") ? " data-detail-close" : ""}>`;
  return {
    rootTag: root.tagName.toLowerCase(),
    rootHasTdRel: root.classList.contains("td-rel"),
    display: cs.display,
    flexWrap: cs.flexWrap,
    gap: cs.gap,
    itemCount: items.length,
    items: items.map((item) => {
      const label = item.querySelector("span[data-i18n]");
      return {
        tag: item.tagName.toLowerCase(),
        hasTdRelItem: item.classList.contains("td-rel-item"),
        labelKey: label?.getAttribute("data-i18n") ?? null,
        labelText: label?.textContent.trim() ?? null,
        links: [...item.querySelectorAll("[data-relation-link]")].map((el) => ({
          tag: el.tagName.toLowerCase(),
          isTdCopy: el.classList.contains("td-copy"),
          text: el.textContent.trim(),
          active: el === document.activeElement,
        })),
      };
    }),
    noneKey: root.querySelector('[data-i18n="relations.none"]')?.getAttribute("data-i18n") ?? null,
    noneText: root.querySelector('[data-i18n="relations.none"]')?.textContent.trim() ?? null,
    noneTag: root.querySelector('[data-i18n="relations.none"]')?.tagName.toLowerCase() ?? null,
    activeInRow: norm(document.activeElement),
  };
};

/**
 * Open the drawer on one card and record the opening frame by frame.
 *
 * The "is the focus move load-bearing?" question is answered directly: a
 * `.focus()` issued **in the task that opens the panel** (the `nextTick` beat's
 * frame) and again at the **first frame the panel reads `data-state="open"`** is
 * probed for whether it actually took — `.td-drawer`'s closed face is
 * `visibility: hidden` (R14 §8 U4) and a hidden element is not focusable, so the
 * probe is a silent no-op until the transition has moved off progress 0.
 */
const traceOpen = async (identifier) => {
  const t0 = performance.now();
  const stamp = () => +(performance.now() - t0).toFixed(1);
  const drawer = document.querySelector("[data-detail-drawer]");
  const close = document.querySelector("[data-detail-close]");
  const describe = (el) =>
    el === null ? "null" : el === document.body ? "body" : `<${el.tagName.toLowerCase()}${el.hasAttribute("data-detail-close") ? " data-detail-close" : ""}>`;
  const sample = (label) => ({
    label,
    t: stamp(),
    state: drawer?.getAttribute("data-state") ?? null,
    visibility: drawer ? getComputedStyle(drawer).visibility : null,
    active: describe(document.activeElement),
  });
  const trace = [];
  const card = document.querySelector(`[data-card][data-identifier="${identifier}"]`);
  if (!card) return { error: `no card ${identifier}` };

  trace.push(sample("rest"));
  card.click();
  const atClickTask = sample("click-task");
  let probeAtClick = null;
  if (close) {
    close.focus();
    probeAtClick = document.activeElement === close;
    if (probeAtClick) close.blur();
  }
  trace.push({ ...atClickTask, probeFocusTook: probeAtClick });

  let probeFirstOpenFrame = null;
  await new Promise((resolveFrame) => {
    const started = performance.now();
    const step = () => {
      const frame = sample("raf");
      trace.push(frame);
      if (probeFirstOpenFrame === null && frame.state === "open" && close) {
        close.focus();
        probeFirstOpenFrame = document.activeElement === close;
        if (probeFirstOpenFrame) close.blur();
      }
      if (performance.now() - started < 600) requestAnimationFrame(step);
      else resolveFrame();
    };
    requestAnimationFrame(step);
  });
  return {
    trace,
    probeAtClick,
    probeFirstOpenFrame,
    probeFirstFrameVisibility: trace.find((row) => row.state === "open")?.visibility ?? null,
  };
};

/** The card's own three relation counters (BLOCKS.md §R14: same three kinds). */
const readCardCounters = (identifier) => {
  const card = document.querySelector(`[data-card][data-identifier="${identifier}"]`);
  if (!card) return null;
  return {
    parent: card.getAttribute("data-relations-parent"),
    blocks: card.getAttribute("data-relations-blocks"),
    related: card.getAttribute("data-relations-related"),
  };
};

const readDrawerState = () => {
  const drawer = document.querySelector("[data-detail-drawer]");
  const el = document.activeElement;
  return {
    state: drawer?.getAttribute("data-state") ?? null,
    hidden: drawer?.hasAttribute("hidden") ?? null,
    visibility: drawer ? getComputedStyle(drawer).visibility : null,
    active:
      el === null ? "null" : el === document.body ? "body" : `<${el.tagName.toLowerCase()}${el.hasAttribute("data-detail-close") ? " data-detail-close" : ""}>`,
  };
};

/* ------------------------------------------------------------- static source */

function sourceChecks(srcWeb = join(REPO, "web")) {
  const drawerSrc = read(join(srcWeb, "src/components/detail/DetailDrawer.vue"));
  const protoSrc = read(join(REPO, "design/prototype/app.js"));

  const beat = /const FOCUS_BEAT_MS = (\d+);/.exec(drawerSrc);
  chkFn("S1", "focus:source", "web/src/components/detail/DetailDrawer.vue", "the focus beat is one transition length (200ms)", 200, beat ? Number(beat[1]) : null, (v) => v === 200, "design/prototype/app.js waits the same 200ms");
  chkFn(
    "S2",
    "focus:source",
    "web/src/components/detail/DetailDrawer.vue",
    'the hand-off is a deferred setTimeout that reads data-state back before focusing (the prototype\'s focusWhenOpen)',
    "match",
    /window\.setTimeout\(\s*\(\)\s*=>\s*\{[^}]*board\.drawerState === "open"[^}]*\.focus\(\)[^}]*\},\s*FOCUS_BEAT_MS\s*\)/s.test(drawerSrc) ? "match" : "no match",
    (v) => v === "match",
  );
  chkFn(
    "S3",
    "focus:source",
    "web/src/components/detail/DetailDrawer.vue",
    "no nextTick is used for the hand-off (the beat is the timeout, not an attribute flush; the two remaining hits are the comment that explains why not)",
    { calls: 0, importedFromVue: false },
    {
      calls: (drawerSrc.match(/\bnextTick\s*\(/g) ?? []).length,
      importedFromVue: /import\s*\{[^}]*\bnextTick\b[^}]*\}\s*from\s*"vue"/.test(drawerSrc),
    },
    (v) => v.calls === 0 && v.importedFromVue === false,
  );
  chkFn(
    "S4",
    "focus:source",
    "web/src/components/detail/DetailDrawer.vue",
    "the beat is armed only on the open edge (watch(open), early return when closed)",
    "match",
    /watch\(open,\s*\(isOpen\)\s*=>\s*\{\s*if \(!isOpen\) return;/.test(drawerSrc) ? "match" : "no match",
    (v) => v === "match",
  );
  chkFn(
    "S5",
    "focus:source",
    "design/prototype/app.js · focusWhenOpen",
    "the prototype's own beat is 200ms + a data-state read-back (the oracle the implementation follows)",
    "match",
    /function focusWhenOpen\(\$target, \$panel\) \{\s*window\.setTimeout\(function \(\) \{\s*if \(\$panel\.attr\("data-state"\) === "open"\) \$target\.trigger\("focus"\);\s*\}, 200\);\s*\}/s.test(protoSrc)
      ? "match"
      : "no match",
    (v) => v === "match",
  );
  chkFn(
    "S6",
    "focus:source",
    "web/src/components/detail/DetailDrawer.vue",
    "no `hidden` attribute is left on the panel (R14 §8 U4: data-state is the one state source)",
    { asideFound: true, hiddenOnAside: false, dataStateBound: true },
    (() => {
      const aside = /<aside[\s\S]*?data-detail-drawer[\s\S]*?>/.exec(drawerSrc)?.[0] ?? "";
      return {
        asideFound: aside.length > 0,
        hiddenOnAside: /\shidden\b|:hidden=/.test(aside),
        dataStateBound: /:data-state=/.test(aside),
      };
    })(),
    (v) => v.asideFound === true && v.hiddenOnAside === false && v.dataStateBound === true,
    "the scrim keeps its own `hidden`/`:hidden` — that half is the contract's (R14 §2.1)",
  );
}

/** The built bundle must be *this* source: the same hooks and the same beat. */
function distChecks(distDir) {
  const assetDir = join(distDir, "assets");
  const js = existsSync(assetDir)
    ? readdirSync(assetDir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => ({ name: f, body: read(join(assetDir, f)) }))
    : [];
  return {
    assets: js.map((f) => ({ name: f.name, sha256: sha256(f.body), bytes: Buffer.byteLength(f.body) })),
    bundle: js.map((f) => f.body).join("\n"),
  };
}

/**
 * Who writes the card's three relation counters? Only `Card.vue` *reads*
 * `meta.relations_parent|blocks|related`, so this scan records where, if
 * anywhere, the wire ever writes them — an observation for the report, not an
 * assertion about this round's faces.
 */
function scanCounterProducers() {
  const roots = [join(REPO, "src"), join(REPO, "web/src")];
  const hits = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const rel of readdirSync(root, { recursive: true })) {
      const file = join(root, String(rel));
      if (!/\.(mjs|js|vue)$/.test(file)) continue;
      const body = read(file);
      if (!/relations_(parent|blocks|related)/.test(body)) continue;
      const lines = body.split("\n").filter((line) => /relations_(parent|blocks|related)/.test(line));
      hits.push({ file: file.replace(`${REPO}/`, ""), writes: lines.filter((line) => /[:=]\s*.*relations_(parent|blocks|related)|relations_(parent|blocks|related)\s*:/.test(line) && !/Number\(/.test(line)).length, lines: lines.length });
    }
  }
  return hits;
}

/* ----------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw Object.assign(new Error(`no built app at ${DIST}`), { code: "SKIP" });
  const playwright = resolvePlaywright();
  if (!playwright) throw Object.assign(new Error("Playwright is not installed on this host"), { code: "SKIP" });

  sourceChecks(SRC_WEB);
  const { assets, bundle } = distChecks(DIST);

  chkFn("D1", "dist", "web/dist/assets/*.js", "the built bundle carries the grouped relation markup", 1, bundle.includes("td-rel-item") ? 1 : 0, (v) => v === 1);
  chkFn("D2", "dist", "web/dist/assets/*.js", "the built bundle carries the relation link hook", 1, bundle.includes("data-relation-link") ? 1 : 0, (v) => v === 1);
  const beatRe = /drawerState===`open`&&[A-Za-z0-9_$.?]+\.focus\(\)\},([A-Za-z0-9_$]+)\)/;
  const beatMatch = beatRe.exec(bundle);
  chkFn("D3", "dist", "web/dist/assets/*.js", 'the built bundle carries the deferred beat: focus only after reading drawerState === "open"', "match", beatMatch ? "match" : "no match", (v) => v === "match");
  const beatValue = beatMatch ? new RegExp(`\\b${beatMatch[1]}=([0-9]+)`).exec(bundle)?.[1] : null;
  chkFn("D4", "dist", "web/dist/assets/*.js", "…and the deferred beat is the 200ms one", 200, beatValue ? Number(beatValue) : null, (v) => v === 200);
  chkFn(
    "D5",
    "dist",
    "web/dist/assets/*.js",
    "the shipped catalogue names all three relation kinds plus the empty face",
    [],
    ["relations.parent", "relations.blocks", "relations.related", "relations.none"].filter((k) => !bundle.includes(k)),
    (missing) => missing.length === 0,
    "the list is the *missing* keys",
  );

  const evidence = { label: LABEL, dist: DIST, src: SRC_WEB, locales: {}, prototype: null, assets };
  const consoleErrors = [];
  const pageErrors = [];
  evidence.observations = {
    cardRelationCounters: {
      note: "the card's `data-relations-*` values are read from `meta.relations_parent|blocks|related`; nothing in `src/server` writes those fields, so on a board whose seed data omits them the counters read 0 and `[data-card-relations]` stays hidden",
      files: scanCounterProducers(),
    },
  };

  /**
   * One browser per locale: `--single-process` (the flag this sandbox needs,
   * see `LAUNCH_ARGS`) cannot survive a second `newContext()` — the browser
   * disconnects — so each leg gets its own launch rather than sharing one.
   */
  for (const locale of ["en", "zh"]) {
    const browser = await playwright.chromium.launch({ args: LAUNCH_ARGS });
    try {
      const leg = `relations@${locale}`;
      const focusLeg = `focus@${locale}`;
      const context = await browser.newContext();
      await context.addInitScript(({ lang }) => {
        /* `about:blank` and other opaque origins deny storage; the app's own
           origin is the one that matters, so the seeding is best-effort. */
        try {
          globalThis.localStorage?.setItem("meerkat-taskpanel.theme", "light");
          globalThis.localStorage?.setItem("meerkat-taskpanel.lang", lang);
        } catch {
          /* opaque origin — the app's document still gets the values */
        }
      }, { lang: locale });
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(`${leg}: ${msg.text()}`);
      });
      page.on("pageerror", (err) => pageErrors.push(`${leg}: ${String(err)}`));
      await mountRoutes(page, { distDir: DIST, data: fixtureApi() });
      await page.goto(`${ORIGIN}/board`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-card]", { timeout: 15_000 });
      await page.waitForTimeout(400);

      evidence.locales[locale] = { cardCounters: await page.evaluate(readCardCounters, DRAWER_ID) };

      /* ① the relations row, read with the drawer open on the rich card ---- */
      await page.evaluate(async (identifier) => {
        document.querySelector(`[data-card][data-identifier="${identifier}"]`).click();
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          if (document.querySelectorAll("[data-detail-relations] .td-rel-item").length > 0) break;
          await new Promise((r) => setTimeout(r, 40));
        }
      }, DRAWER_ID);
      await page.waitForTimeout(320);
      const row = await page.evaluate(readRelations);
      evidence.locales[locale].relations = row;

      chk("R1", leg, "[data-detail-relations]", "the hook rides a `div` that carries `.td-rel` (D37: not the `<section>`, not a `<ul>`)", { tag: "div", tdRel: true }, { tag: row?.rootTag ?? null, tdRel: row?.rootHasTdRel ?? null });
      chkFn("R2", leg, ".td-rel", "the row is the prototype's flex-wrap box with a 4px/8px gap", { display: "flex", flexWrap: "wrap", gap: "4px 8px" }, { display: row?.display, flexWrap: row?.flexWrap, gap: row?.gap }, (v) => v.display === "flex" && v.flexWrap === "wrap" && v.gap === "4px 8px");
      chk("R3", leg, "[data-detail-relations] .td-rel-item", "one group per kind — the fixture carries three kinds, so exactly three items", 3, row?.itemCount ?? null);
      chk(
        "R4",
        leg,
        ".td-rel-item > span[data-i18n]",
        "the three groups are led by the three catalogue names, in the domain's own order (parent · blocks · related)",
        ["relations.parent", "relations.blocks", "relations.related"],
        (row?.items ?? []).map((item) => item.labelKey),
      );
      chkFn(
        "R5",
        leg,
        ".td-rel-item > span[data-i18n]",
        `the rendered words are the catalogue's own (${locale})`,
        locale === "en" ? ["Parent", "Blocks", "Related"] : ["父任务", "阻塞", "关联"],
        (row?.items ?? []).map((item) => item.labelText),
        (actual) => same(actual, locale === "en" ? ["Parent", "Blocks", "Related"] : ["父任务", "阻塞", "关联"]),
      );
      chkFn(
        "R6",
        leg,
        ".td-rel-item button.td-copy[data-relation-link]",
        "every group holds at least one copy link, and every link is a `button.td-copy` (R14-B17's box)",
        { groups: 3, links: 4, tags: ["button"], tdCopy: true, emptyGroups: 0 },
        {
          groups: (row?.items ?? []).length,
          links: (row?.items ?? []).reduce((n, item) => n + item.links.length, 0),
          tags: [...new Set((row?.items ?? []).flatMap((item) => item.links.map((l) => l.tag)))],
          tdCopy: (row?.items ?? []).flatMap((item) => item.links.map((l) => l.isTdCopy)).every(Boolean),
          emptyGroups: (row?.items ?? []).filter((item) => item.links.length === 0).length,
        },
        (v) => v.groups === 3 && v.links === 4 && same(v.tags, ["button"]) && v.tdCopy === true && v.emptyGroups === 0,
      );
      chk(
        "R7",
        leg,
        "[data-detail-relations] .td-rel-item [data-relation-link]",
        "the links resolve to the other cards' identifiers (the wire's ids are looked up, not printed)",
        ["TD-125", "TD-130", "TD-126", "TD-127"],
        (row?.items ?? []).flatMap((item) => item.links.map((l) => l.text)),
      );
      chk(
        "R8",
        leg,
        "[data-card][data-identifier=PROJ-0007][data-relations-*]",
        "the card and the drawer it opens spell the same three kinds, and the card's counts agree with the drawer's group sizes",
        { kinds: ["parent", "blocks", "related"], counts: { parent: "1", blocks: "2", related: "1" } },
        {
          kinds: Object.entries(evidence.locales[locale].cardCounters ?? {})
            .filter(([, value]) => value !== null)
            .map(([key]) => key),
          counts: evidence.locales[locale].cardCounters,
        },
        "the card's counts are fixture-seeded (`meta.relations_*`); see the report's observation O1",
      );

      /* ② the focus beat, traced from the same click ---------------------- */
      await page.keyboard.press("Escape");
      await page.waitForTimeout(320);
      const before = await page.evaluate(readDrawerState);
      chkFn(
        "F0",
        focusLeg,
        "[data-detail-drawer] (at rest)",
        "the closed face is `visibility: hidden` + no `hidden` attribute — the pair that makes the wait load-bearing",
        { visibility: "hidden", hidden: false },
        { visibility: before.visibility, hidden: before.hidden },
        (v) => v.visibility === "hidden" && v.hidden === false,
      );

      const trace = await page.evaluate(traceOpen, DRAWER_ID);
      evidence.locales[locale].openTrace = trace;
      chk("F1", focusLeg, "[data-detail-drawer] (click task)", "the panel is not focused from the opening task: a `.focus()` there does not take (this is the frame a `nextTick` beat lands in)", false, trace?.probeAtClick ?? null);
      chk("F2", focusLeg, "[data-detail-drawer] (first open frame)", '…and it still does not take on the first frame the panel reads `data-state="open"`', false, trace?.probeFirstOpenFrame ?? null);
      const firstOpen = (trace?.trace ?? []).find((r) => r.state === "open");
      chkFn("F3", focusLeg, "[data-detail-drawer] (first open frame)", "on that first open frame `document.activeElement` is not the close button yet (the beat has not elapsed)", true, firstOpen?.active ?? null, (v) => v !== "<button data-detail-close>");
      const settled = await page.evaluate(readDrawerState);
      evidence.locales[locale].settled = settled;
      chkFn("F4", focusLeg, "[data-detail-close]", "after the beat, `document.activeElement` is the drawer's close button (not `body`)", "<button data-detail-close>", settled.active, (v) => v === "<button data-detail-close>");
      chk("F5", focusLeg, "[data-detail-drawer] (settled)", "the drawer really is open when the focus is read (data-state + visibility)", { state: "open", visibility: "visible" }, { state: settled.state, visibility: settled.visibility });
      const focusAt = (trace?.trace ?? []).find((r) => r.active === "<button data-detail-close>");
      chkFn("F6", focusLeg, "[data-detail-close]", "the focus lands no earlier than one beat after the click (the prototype's 200ms wait, measured)", true, { firstOpenMs: firstOpen?.t ?? null, focusMs: focusAt?.t ?? null }, (v) => typeof v.focusMs === "number" && v.focusMs >= 200 && v.focusMs <= 600, "raw frame trace in the evidence JSON");

      /* the empty face, on the card with no relation ---------------------- */
      await page.keyboard.press("Escape");
      await page.waitForTimeout(320);
      await page.evaluate(async (identifier) => {
        document.querySelector(`[data-card][data-identifier="${identifier}"]`).click();
        await new Promise((r) => setTimeout(r, 400));
      }, EMPTY_ID);
      await page.waitForTimeout(300);
      const emptyRow = await page.evaluate(readRelations);
      evidence.locales[locale].emptyRelations = emptyRow;
      chk(
        "R9",
        leg,
        "[data-detail-relations] (card with no relation)",
        "with no relation the area renders the catalogue's `relations.none` span and no group",
        { groups: 0, noneKey: "relations.none", noneText: locale === "en" ? "No relations" : "暂无关联" },
        { groups: emptyRow?.itemCount ?? null, noneKey: emptyRow?.noneKey ?? null, noneText: emptyRow?.noneText ?? null },
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    } finally {
      await browser.close();
    }
  }

  {
    const browser = await playwright.chromium.launch({ args: LAUNCH_ARGS });
    try {
    /* the prototype's own markup, for the parity reading ------------------- */
    const protoPage = await browser.newPage();
    await protoPage.goto(`file://${join(REPO, "design/prototype/index.html")}`, { waitUntil: "domcontentloaded" });
    await protoPage.waitForTimeout(600);
    const proto = await protoPage.evaluate(() => {
      const root = document.querySelector("[data-detail-relations]");
      const items = [...root.querySelectorAll(".td-rel-item")];
      const slot = document.querySelector('[data-slot="relations"]');
      const cs = getComputedStyle(root);
      return {
        rootTag: root.tagName.toLowerCase(),
        rootClasses: [...root.classList],
        display: cs.display,
        flexWrap: cs.flexWrap,
        gap: cs.gap,
        items: items.map((item) => ({
          tag: item.tagName.toLowerCase(),
          labelKey: item.querySelector("span[data-i18n]")?.getAttribute("data-i18n") ?? null,
          labelText: item.querySelector("span[data-i18n]")?.textContent.trim() ?? null,
          links: [...item.querySelectorAll("[data-relation-link]")].map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}:${el.textContent.trim()}`),
        })),
        slotItems: slot ? slot.querySelectorAll(".td-rel-item").length : null,
        catalogueKeys: [...document.querySelectorAll('[data-i18n^="relations."]')].map((el) => el.getAttribute("data-i18n")),
      };
    });
    evidence.prototype = proto;
    chkFn(
      "P1",
      "prototype",
      "design/prototype/index.html",
      "the prototype's row is the same `div.td-rel` box, flex-wrap with a 4px/8px gap",
      { display: "flex", flexWrap: "wrap", gap: "4px 8px" },
      { display: proto.display, flexWrap: proto.flexWrap, gap: proto.gap },
      (v) => v.display === "flex" && v.flexWrap === "wrap" && v.gap === "4px 8px",
    );
    chkFn(
      "P2",
      "prototype",
      'design/prototype/index.html [data-slot="relations"]',
      "the prototype's shape is `span.td-rel-item` → label + `button.td-copy[data-relation-link]` (the shape the ruling took)",
      { itemTag: "span", linkTags: ["button"], tdCopy: true },
      {
        itemTag: proto.items[0]?.tag ?? null,
        linkTags: [...new Set(proto.items.flatMap((item) => item.links.map((l) => l.split(".")[0])))],
        tdCopy: proto.items.every((item) => item.links.every((l) => l.startsWith("button.td-copy"))),
        labelKeys: proto.items.map((item) => item.labelKey),
      },
      (v) => v.itemTag === "span" && same(v.linkTags, ["button"]) && v.tdCopy === true && v.labelKeys.every((k) => k?.startsWith("relations.")),
    );
    chk(
      "P3",
      "prototype",
      "[data-i18n^=relations.] (prototype markup)",
      "the prototype's static markup names two kinds inline; the third (`relations.related`) is named in the catalogue, not in its static seats (BLOCKS.md §R14 records that gap)",
      ["relations.parent", "relations.blocks"],
      [...new Set(proto.catalogueKeys)],
    );
    await protoPage.close();
    } finally {
      await browser.close();
    }
  }

  chk("C1", "console", "page console", "zero console errors on the driven pages", [], consoleErrors);
  chk("C2", "console", "page errors", "zero uncaught page errors on the driven pages", [], pageErrors);

  const failed = results.filter((r) => !r.pass);
  const gating = ONLY ? failed.filter((r) => r.leg.includes(ONLY)) : failed;
  const report = {
    label: LABEL,
    dist: DIST,
    only: ONLY,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    gatingFailed: gating.length,
    results,
    evidence,
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  const byLeg = new Map();
  for (const item of results) {
    const row = byLeg.get(item.leg) ?? { leg: item.leg, pass: 0, fail: 0 };
    if (item.pass) row.pass += 1;
    else row.fail += 1;
    byLeg.set(item.leg, row);
  }
  for (const row of byLeg.values()) process.stdout.write(`${row.leg.padEnd(18)} pass ${String(row.pass).padStart(3)}  fail ${row.fail}\n`);
  process.stdout.write(`TOTAL ${results.length} · pass ${results.length - failed.length} · fail ${failed.length}${ONLY ? ` · gating(${ONLY}) fail ${gating.length}` : ""}\n`);
  for (const item of failed) process.stdout.write(`  ✗ ${item.id} [${item.leg}] ${item.assertion}\n      expected ${JSON.stringify(item.expected)}\n      actual   ${JSON.stringify(item.actual)}\n`);
  if (!ONLY && failed.length === 0) {
    const en = evidence.locales.en;
    process.stdout.write(
      `relations row (en)   ${en.relations.itemCount} groups · ${en.relations.items.map((i) => `${i.labelText}(${i.labelKey})×${i.links.length}`).join(" / ")}\n` +
        `relations row (zh)   ${evidence.locales.zh.relations.items.map((i) => `${i.labelText}×${i.links.length}`).join(" / ")}\n` +
        `focus beat (en)      first-open-frame visibility=${en.openTrace.probeFirstFrameVisibility} · click-task probe took=${en.openTrace.probeAtClick} · first-open-frame probe took=${en.openTrace.probeFirstOpenFrame} · settled active=${en.settled.active} (data-state=${en.settled.state}, visibility=${en.settled.visibility})\n`,
    );
  }
  process.exitCode = gating.length === 0 ? 0 : 1;
}

main().catch((err) => {
  if (err.code === "SKIP") {
    process.stdout.write(`SKIP: ${err.message}\n`);
    process.exit(2);
  }
  console.error(err);
  process.exit(3);
});
