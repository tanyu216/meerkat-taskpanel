#!/usr/bin/env node
/**
 * T-20261014-152924-2 acceptance ③ — what the board *shows* for a refusal.
 *
 * Two questions, read on three layers:
 *
 *   1. **Source**: the only place a failure becomes words is
 *      `web/src/i18n/messages.mjs#errorTextKey` (code → key), and the two
 *      call sites that report a refusal (`stores/board.js`,
 *      `CreateTaskModal.vue`) hand that key to `t()`. No call site reads the
 *      envelope's `message` — that string is the storage engine's prose.
 *   2. **Build artefact**: the sentences really are in `web/dist` (both
 *      languages) and no engine text is.
 *   3. **Rendered page**: real Chromium renders the built app against a mocked
 *      API, a real card's move menu is clicked, and the refusal comes back with
 *      an unknown/technical `code` **and** a raw engine `message`. The toast
 *      must read the localized fallback — and must not be the wire's text.
 *
 * Carrier: the app is served by Playwright route interception (no socket — this
 * lane denies `listen(2)`), reusing the fixture of the previous verification
 * leg (`docs/verify/T-20261014-125122/fixture.mjs`: sample cards + static file
 * mapping) and overriding the move endpoint with the refusal under test.
 *
 *   node docs/verify/T-20261014-152924-2/check-ui-fallback.mjs \
 *     --root . --dist /tmp/T-20261014-152924-2.../dist-tip \
 *     --out docs/verify/T-20261014-152924-2/evidence/ui-fallback.json
 *
 * Exit 0 ⇔ every reading holds. `--root` re-points the whole probe (source
 * reads, messages module, fixture) at another tree — that is how ④'s "remove an
 * i18n key" replay builds its mutant.
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const flag = name.startsWith("--") ? name : `--${name}`;
  const hit = process.argv.slice(2).find((a) => a === flag || a.startsWith(`${flag}=`));
  if (hit === undefined) return fallback;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const ROOT = resolve(String(arg("--root", resolve(HERE, "../../.."))));
const DIST = resolve(String(arg("--dist", join(ROOT, "web/dist"))));
const OUT = arg("--out", null);
const LABEL = String(arg("--label", "tip"));
console.log(`# probe ${LABEL}: root=${ROOT} dist=${DIST} dist/index.html=${existsSync(join(DIST, "index.html"))}`);

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { resolveText, errorTextKey } = await load("web/src/i18n/messages.mjs");
const { mountRoutes, fixtureApi, ORIGIN } = await load("docs/verify/T-20261014-125122/fixture.mjs");

/** The card's predicate. */
const ENGINE_TEXT = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;
/** The two sentences the fallback must be, quoted from `web/src/i18n/extra.mjs`. */
const GENERIC = {
  en: "That action did not complete — retry, or contact an administrator.",
  zh: "操作未完成，请重试或联系管理员。",
};

const checks = [];
const readings = [];

function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail: detail ?? "" });
}

function resolvePlaywright() {
  const roots = [process.env.PLAYWRIGHT_ROOT, join(ROOT, "web/node_modules")]
    .concat(["/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules"]);
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
    /* npm absent */
  }
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      return createRequire(join(root, "noop.js"))("playwright");
    } catch {
      /* next root */
    }
  }
  return null;
}

// ------------------------------------------------------------ 1. source read

const boardSrc = readFileSync(join(ROOT, "web/src/stores/board.js"), "utf8");
const modalSrc = readFileSync(join(ROOT, "web/src/components/create/CreateTaskModal.vue"), "utf8");
const messagesSrc = readFileSync(join(ROOT, "web/src/i18n/messages.mjs"), "utf8");

check(
  "source · the move path renders `t(errorTextKey(err), identifier)`",
  boardSrc.includes("t(errorTextKey(err), task.identifier)") && boardSrc.includes("t(errorTextKey(err), identifier)"),
  "stores/board.js: both refusal sites (moveTask + openDetail)",
);
check(
  "source · no call site renders the envelope's `message`",
  /err\.message|error\.message|\.error\.message/.test(boardSrc) === false &&
    /err\.message|error\.message/.test(modalSrc) === false,
  "stores/board.js + components/create/CreateTaskModal.vue contain no `.message` read",
);
check(
  "source · the create-task modal reports by code too",
  modalSrc.includes("t(errorTextKey(err))"),
  "components/create/CreateTaskModal.vue#submit",
);
check(
  "source · unknown codes resolve to `error.generic` (no message fallback)",
  messagesSrc.includes('export const GENERIC_ERROR_KEY = "error.generic"') &&
    messagesSrc.includes("? ERROR_TEXT_KEYS[code]") === true,
  "i18n/messages.mjs#errorTextKey",
);
for (const language of ["en", "zh"]) {
  check(
    `source · resolveText('${language}', 'error.generic') is the quoted sentence`,
    resolveText(language, "error.generic") === GENERIC[language],
    JSON.stringify(resolveText(language, "error.generic")),
  );
}

// The code → key mapping itself, exercised in node (the same table the bundle
// carries): an unknown code and a known-but-internal one both land on the
// fallback; a mapped code keeps its own sentence.
const codeKeys = {
  brand_new_code_2099: errorTextKey({ code: "BRAND_NEW_CODE_2099", message: "CHECK constraint failed: x" }),
  execution_state_corrupt: errorTextKey({ code: "EXECUTION_STATE_CORRUPT", message: "in_progress without claimed_by" }),
  validation_failed: errorTextKey({ code: "VALIDATION_FAILED", message: "CHECK constraint failed: y" }),
  not_assignee: errorTextKey({ code: "not_assignee", message: "assigned elsewhere" }),
  claim_on_backlog: errorTextKey({ code: "CLAIM_ON_BACKLOG", message: "CHECK constraint failed: z" }),
};
check(
  "source · unknown + internal codes → error.generic; mapped codes keep their key",
  codeKeys.brand_new_code_2099 === "error.generic" &&
    codeKeys.execution_state_corrupt === "error.generic" &&
    codeKeys.validation_failed === "error.generic" &&
    codeKeys.not_assignee === "error.notAssignee" &&
    codeKeys.claim_on_backlog === "error.claimOnBacklog",
  JSON.stringify(codeKeys),
);

// ------------------------------------------------- 2. build artefact read

const assetDir = join(DIST, "assets");
const js = existsSync(assetDir)
  ? readdirSync(assetDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(assetDir, name))
  : [];
check("build · the artefact has a JS bundle", js.length > 0, js.map((p) => p.replace(DIST, "dist")).join(", "));
let bundleText = "";
for (const file of js) bundleText += readFileSync(file, "utf8");
const bundleSha = createHash("sha256").update(bundleText).digest("hex").slice(0, 16);
for (const language of ["en", "zh"]) {
  check(`build · the ${language} fallback sentence is in the bundle`, bundleText.includes(GENERIC[language]), GENERIC[language]);
}
check(
  "build · the mapped keys are in the bundle",
  ["error.generic", "error.notAssignee", "error.claimOnBacklog", "error.notFound", "error.busy"].every((key) => bundleText.includes(key)),
  "error.generic / error.notAssignee / error.claimOnBacklog / error.notFound / error.busy",
);
check(
  "build · no engine text is in the bundle",
  ENGINE_TEXT.test(bundleText) === false,
  `bundle ${bundleSha} carries no /${ENGINE_TEXT.source}/`,
);

// ------------------------------------------------------- 3. rendered page

const playwright = resolvePlaywright();
check("browser · playwright is resolvable", playwright !== null, playwright === null ? "not found in any root" : "found");

/** One refusal to show: `code` + the wire `message` that must never surface. */
const CASES = [
  { id: "unknown-en", lang: "en", code: "BRAND_NEW_CODE_2099", expected: GENERIC.en },
  { id: "unknown-zh", lang: "zh", code: "BRAND_NEW_CODE_2099", expected: GENERIC.zh },
  { id: "internal-zh", lang: "zh", code: "EXECUTION_STATE_CORRUPT", expected: GENERIC.zh },
  { id: "mapped-notAssignee-en", lang: "en", code: "not_assignee", expected: "%s is assigned to somebody else." },
  { id: "mapped-claimOnBacklog-zh", lang: "zh", code: "CLAIM_ON_BACKLOG", expected: "%s 位于 Backlog，其中的卡片不能认领。" },
];
const WIRE_MESSAGE = "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'";

if (playwright !== null) {
  /**
   * A single-process Chromium can die mid-request in this sandbox, and a
   * Playwright promise attached to the dead process then never settles (the
   * process used to exit with a pending top-level await — exit code 13, no
   * reading). Every browser step therefore gets a deadline: a stall becomes a
   * rejection, the case is retried on a fresh browser, and a *reading* is only
   * ever reported from a run that finished.
   */
  const withTimeout = async (promise, ms, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // `--single-process` (plus a disabled zygote): this sandbox denies the Mach
  // port rendezvous the multi-process Chromium needs to bootstrap
  // (`bootstrap_check_in … Permission denied (1100)`), while the renderer itself
  // is untouched — the page is still parsed, laid out and painted by Chromium.
  const launchArgs = ["--single-process", "--no-zygote", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  const launch = async () => {
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await withTimeout(playwright.chromium.launch({ headless: true, args: launchArgs }), 60000, "chromium launch");
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastError;
  };

  /** One case on a fresh context; the browser may be replaced between cases. */
  async function runCase(browser, testCase) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await context.addInitScript(
        ([key, value]) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            /* a blocked store — the default language is used then */
          }
        },
        ["meerkat-taskpanel.lang", testCase.lang],
      );
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("pageerror", (err) => consoleErrors.push(String(err)));

      // Fixture first, then the refusal override: Playwright matches the
      // last-registered matching route, so the move endpoint is ours.
      await mountRoutes(page, { distDir: DIST, data: fixtureApi() });
      await page.route("**/api/v1/tasks/*/move", (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            ok: false,
            error: {
              code: testCase.code,
              message: WIRE_MESSAGE,
              http: 409,
              details: { sqlite: { errcode: 275, message: WIRE_MESSAGE } },
              hint: null,
            },
          }),
        }),
      );

      await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForSelector("[data-card-menu]", { timeout: 15000 });
      } catch (err) {
        const dump = await page.evaluate(() => document.body.innerText).catch(() => "<no body>");
        throw new Error(`the card never rendered (${testCase.id}): ${err.message}\n--- page text ---\n${dump}`);
      }
      const identifier = await page.$eval("[data-card-identifier]", (node) => node.textContent.trim());
      await page.click("[data-card-menu]");
      await page.waitForSelector("[data-move-menu] [data-move-to]", { timeout: 5000 });
      await page.click("[data-move-menu] [data-move-to]");
      // `[data-toast-region] > [data-toast] > [data-toast-text]`: the direct
      // children of the live region are the runtime toasts; the inert
      // `[data-toast-template]` copy is not one.
      const toastSelector = "[data-toast-region] > [data-toast] > [data-toast-text]";
      try {
        await page.waitForSelector(toastSelector, { timeout: 5000 });
      } catch (err) {
        const dump = await page.evaluate(() => document.body.innerText).catch(() => "<no body>");
        throw new Error(`no toast for ${testCase.id} (${err.message})\n--- page text ---\n${dump}`);
      }
      const toast = await page.$eval(toastSelector, (node) => node.textContent.trim());
      return { identifier, toast, consoleErrors };
    } finally {
      await withTimeout(context.close(), 20000, "context close").catch(() => {});
    }
  }

  let browser = await launch();
  try {
    for (const testCase of CASES) {
      let reading;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          reading = await withTimeout(runCase(browser, testCase), 90000, `${testCase.id} case`);
          break;
        } catch (err) {
          lastError = err;
          // A dead single-process Chromium is a transport problem, not a
          // reading: relaunch and try the same case again.
          await withTimeout(browser.close(), 20000, "browser close").catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));
          browser = await launch();
        }
      }
      if (reading === undefined) throw lastError;
      const expected = testCase.expected.replace("%s", reading.identifier);
      readings.push({
        case: testCase.id,
        lang: testCase.lang,
        code: testCase.code,
        identifier: reading.identifier,
        toast: reading.toast,
        expected,
        wire_message: WIRE_MESSAGE,
      });
      check(
        `page · ${testCase.id}: the toast is the localized sentence for the code`,
        reading.toast === expected,
        `toast=${JSON.stringify(reading.toast)} expected=${JSON.stringify(expected)}`,
      );
      check(
        `page · ${testCase.id}: the wire's message is never rendered`,
        reading.toast.includes(WIRE_MESSAGE) === false && ENGINE_TEXT.test(reading.toast) === false && reading.toast !== WIRE_MESSAGE,
        `toast=${JSON.stringify(reading.toast)}`,
      );
      check(`page · ${testCase.id}: no uncaught page error`, reading.consoleErrors.length === 0, reading.consoleErrors.join(" | ") || "none");
    }
  } finally {
    await withTimeout(browser.close(), 20000, "browser close").catch(() => {});
  }
}

// ---------------------------------------------------------------- verdict

const failed = checks.filter((c) => !c.ok);
const payload = {
  label: LABEL,
  root: ROOT,
  dist: DIST,
  dist_js_sha256_16: bundleSha,
  ran_at: new Date().toISOString(),
  predicate: String(ENGINE_TEXT),
  readings,
  checks,
  verdict: failed.length === 0 ? "PASS" : "FAIL",
};

for (const r of readings) {
  console.log(`page ${r.case.padEnd(26)} lang=${r.lang} code=${r.code.padEnd(22)} toast=${JSON.stringify(r.toast)}`);
}
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}  [${c.detail}]`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks pass — verdict ${payload.verdict}`);
if (OUT !== null && OUT !== true) {
  mkdirSync(dirname(resolve(String(OUT))), { recursive: true });
  writeFileSync(resolve(String(OUT)), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`readings → ${resolve(String(OUT))}`);
}
process.exit(failed.length === 0 ? 0 : 1);
