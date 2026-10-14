/**
 * R14 · 独立验证 —— 对**实现**（`web/dist`，真 Chromium）跑 `design/fidelity-r14.md`
 * §5 的 A/B/C 断言清单 + §8.1 D01–D50 的逐条判定点 + §4.3 的负向注记 + 五宽度 /
 * JS-off / 零增量自查。
 *
 * 用法:
 *   node verify-r14-impl.mjs --dist <web/dist 目录> [--out out.json] [--label name]
 *
 * 载体说明（沙箱事实）：本审计沙箱禁止 `listen(2)`，也禁止 Chromium 注册 Mach
 * rendezvous 端口；前者用 Playwright 路由拦截替代，后者用 `--single-process`
 * 绕过。两条都在**真 Chromium**里跑：真解析、真排版、真 computed。
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { fixtureApi, mountRoutes, RICH_ID, PLAIN_ID, LONG_ID } from "./fixture.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const DIST = resolve(argOf("dist", "web/dist"));
const OUT = argOf("out", null);
const LABEL = argOf("label", "impl");

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

/** `--single-process` skips the Mach rendezvous registration the sandbox denies. */
export const LAUNCH_ARGS = ["--single-process"];

const results = [];
const record = (id, leg, selector, assertion, expected, actual, pass, note = "") =>
  results.push({ id, leg, selector, assertion, expected, actual, pass: !!pass, note });

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chk = (id, leg, selector, assertion, expected, actual, note = "") =>
  record(id, leg, selector, assertion, expected, actual, same(expected, actual), note);
const chkFn = (id, leg, selector, assertion, expected, actual, fn, note = "") =>
  record(id, leg, selector, assertion, expected, actual, fn(actual), note);

/* ---------------------------------------------------------------- colours */

/**
 * Resolve a computed colour to `[r, g, b, a]`.
 *
 * The implementation carries some tokens as `color-mix(in oklab, …)`, so the
 * browser hands the colour back in `oklab()` notation rather than `rgb()`. The
 * comparison has to be made on the **painted** colour, not on its spelling.
 */
function parseColor(text) {
  if (typeof text !== "string") return null;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  const oklab = /^oklab\(([^)]+)\)$/.exec(text);
  if (oklab) {
    const raw = oklab[1].replace("/", " ").split(/[\s,]+/).filter(Boolean).map(Number);
    const [L, a, b] = raw;
    const alpha = raw.length > 3 ? raw[3] : 1;
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const linear = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    const encode = (c) => Math.round(Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) * 255);
    return [...linear.map(encode), alpha];
  }
  return null;
}

/** Same painted colour within `tol` (0–255) per channel and 0.01 on alpha. */
const colorClose = (expected, actual, tol = 6) => {
  const a = parseColor(actual);
  const b = parseColor(expected);
  if (!a || !b) return false;
  return a.every((v, i) => (i === 3 ? Math.abs(v - b[3]) <= 0.01 : Math.abs(v - b[i]) <= tol));
};

/* ------------------------------------------------------------------ in-page */

/** Readings taken while the drawer is open on the rich card. */
function readOpen() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const tag = (el) => (el ? el.tagName.toLowerCase() : null);
  const cs = (target, key) => {
    const el = typeof target === "string" ? q(target) : target;
    return el ? getComputedStyle(el)[key] : null;
  };
  const size = (target) => {
    const el = typeof target === "string" ? q(target) : target;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), x: +r.x.toFixed(2) };
  };
  const px = (target, key) => {
    const value = cs(target, key);
    return value === null ? null : +Number.parseFloat(value).toFixed(2);
  };
  const children = (el) => (el ? Array.from(el.children).map(tag) : null);
  const classes = (el) => (el ? el.getAttribute("class") : null);
  const rectOf = (target) => {
    const el = typeof target === "string" ? q(target) : target;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), w: +r.width.toFixed(2) };
  };

  const drawer = q("[data-detail-drawer]");
  const overlay = q("[data-detail-overlay]");
  const identifier = q("[data-detail-identifier]");
  const chip = q("[data-detail-status-chip]");
  const header = drawer?.querySelector("header") ?? null;
  const body = drawer?.querySelector(".td-drawer-body") ?? null;
  const props = q("[data-detail-props]");
  const propValue = q("[data-detail-status]");
  const labelChip = q("[data-detail-label-chip]");
  const labelRemove = q("[data-detail-label-remove]");
  const sections = qa("[data-detail-drawer] section");
  const sectionTitle = q("[data-detail-drawer] .td-section-title");
  const gfm = q("[data-detail-description]");
  const session = q("[data-detail-agent-session]");
  const sessionBox = q("[data-agent-session]");
  const fileRow = q("[data-attachment-row]");
  const comment = q("[data-detail-comments] .td-comment");
  const commentMeta = q("[data-detail-comments] .td-comment-meta");
  const commentAvatar = q("[data-detail-comments] .td-avatar");
  const commentBody = q("[data-detail-comments] .td-comment-body");
  const decision = q("[data-detail-comments] .td-comment-decision");
  const activityRow = q("[data-detail-activity] .td-activity");
  const activityTs = q("[data-detail-activity] .td-activity-ts");
  const idCopy = q("[data-detail-id-copy]");
  const form = q("[data-comment-form]");
  const textarea = q("[data-comment-input]");
  const title = q("[data-detail-title]");
  const labelRow = q("[data-detail-labels]");

  /* R14 §3 D34 — the rhythm between two block children of the description. */
  const gfmChildren = gfm ? Array.from(gfm.children) : [];
  const gfmSecond = gfmChildren[1] ?? null;

  return {
    state: {
      dataState: drawer?.getAttribute("data-state") ?? null,
      overlayState: overlay?.getAttribute("data-state") ?? null,
      overlayHidden: overlay?.hasAttribute("hidden") ?? null,
      overlayCount: qa("[data-detail-overlay]").length,
      drawerCount: qa("[data-detail-drawer]").length,
    },
    drawerShell: {
      hasHidden: drawer?.hasAttribute("hidden") ?? null,
      hasAriaHidden: drawer?.hasAttribute("aria-hidden") ?? null,
      role: drawer?.getAttribute("role") ?? null,
      ariaModal: drawer?.getAttribute("aria-modal") ?? null,
      ariaLabelledby: drawer?.getAttribute("aria-labelledby") ?? null,
      labelledbyTarget: drawer?.getAttribute("aria-labelledby") ? !!document.getElementById(drawer.getAttribute("aria-labelledby")) : false,
      labelledbyIsH2: document.getElementById("td-detail-title")?.tagName.toLowerCase() ?? null,
      width: cs(drawer, "width"),
      maxWidth: cs(drawer, "maxWidth"),
      position: cs(drawer, "position"),
      zIndex: cs(drawer, "zIndex"),
      borderInlineStartWidth: px(drawer, "borderInlineStartWidth"),
      borderInlineStartColor: cs(drawer, "borderInlineStartColor"),
      boxShadow: cs(drawer, "boxShadow"),
      background: cs(drawer, "backgroundColor"),
      color: cs(drawer, "color"),
      transform: cs(drawer, "transform"),
      visibility: cs(drawer, "visibility"),
    },
    overlayShell: {
      position: cs(overlay, "position"),
      inset: [cs(overlay, "top"), cs(overlay, "right"), cs(overlay, "bottom"), cs(overlay, "left")],
      background: cs(overlay, "backgroundColor"),
      opacity: cs(overlay, "opacity"),
      zIndex: cs(overlay, "zIndex"),
      /* Token口径（回灌契约 §5 B22 / §8.3 DF-1）：遮罩的涂出色必须**源于该侧自己的遮罩
         令牌**。写一个瞬时探针（`background: var(--brand-scrim)`）把令牌解析出的涂出色
         取出来，跟遮罩本体比 —— 相等即证明遮罩读的就是这枚令牌，**不对 light 值做跨侧
         字面量相等断言**。探针随读随删，不影响随后的几何读数。 */
      scrimTokenResolved: (() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--brand-scrim)";
        probe.setAttribute("aria-hidden", "true");
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      })(),
    },
    header: {
      padding: [px(header, "paddingTop"), px(header, "paddingRight"), px(header, "paddingBottom"), px(header, "paddingLeft")],
      borderBottomWidth: px(header, "borderBottomWidth"),
      isDrawerHead: classes(header)?.includes("td-drawer-head") ?? false,
    },
    body: {
      padding: [px(body, "paddingTop"), px(body, "paddingRight"), px(body, "paddingBottom"), px(body, "paddingLeft")],
      overflowY: cs(body, "overflowY"),
      minHeight: cs(body, "minHeight"),
      flex: cs(body, "flex"),
      scrollbarWidth: cs(body, "scrollbarWidth"),
      isDrawerBody: classes(body)?.includes("td-drawer-body") ?? false,
      /* The content box: what a `width: 100%` child (table, textarea) resolves to. */
      contentWidth: body ? +(body.clientWidth - Number.parseFloat(cs(body, "paddingLeft")) - Number.parseFloat(cs(body, "paddingRight"))).toFixed(2) : null,
    },
    identifier: {
      tag: tag(identifier),
      text: identifier?.textContent ?? null,
      className: classes(identifier),
      hasFullClass: identifier?.classList.contains("td-id-full") ?? null,
      countWithClass: qa("[data-detail-identifier].td-id-full").length,
      fontSize: px(identifier, "fontSize"),
      color: cs(identifier, "color"),
      maxWidth: cs(identifier, "maxWidth"),
      overflow: cs(identifier, "overflow"),
      textOverflow: cs(identifier, "textOverflow"),
      whiteSpace: cs(identifier, "whiteSpace"),
      scrollWidth: identifier?.scrollWidth ?? null,
      clientWidth: identifier?.clientWidth ?? null,
      title: identifier?.getAttribute("title") ?? null,
    },
    titleBlock: {
      tag: tag(title),
      fontSize: px(title, "fontSize"),
      fontWeight: cs(title, "fontWeight"),
      id: title?.id ?? null,
      text: title?.textContent ?? null,
    },
    chip: {
      tag: tag(chip),
      height: px(chip, "height"),
      borderRadius: cs(chip, "borderRadius"),
      fontSize: px(chip, "fontSize"),
      dot: size(chip ? chip.querySelector(".td-status-dot") : null),
      labelText: chip?.querySelector("[data-detail-status-chip-label]")?.textContent ?? null,
    },
    close: {
      tag: tag(q("[data-detail-close]")),
      hasIcon: !!q("[data-detail-close] svg.td-icon"),
      box: size("[data-detail-close]"),
      sameRowAsIdentifier: q("[data-detail-close]")?.parentElement === identifier?.parentElement,
      sameRowAsChip: q("[data-detail-close]")?.parentElement === chip?.parentElement,
    },
    save: {
      carrierTag: tag(q("[data-detail-save]")),
      carrierState: q("[data-detail-save]")?.getAttribute("data-save-state") ?? null,
      carrierHidden: q("[data-detail-save]")?.hasAttribute("hidden") ?? null,
      errorTag: tag(q("[data-detail-save-error]")),
      errorRole: q("[data-detail-save-error]")?.getAttribute("role") ?? null,
      errorHidden: q("[data-detail-save-error]")?.hasAttribute("hidden") ?? null,
      errorI18n: q("[data-detail-save-error]")?.getAttribute("data-i18n") ?? null,
      errorFontSize: px("[data-detail-save-error]", "fontSize"),
      errorBorderColor: cs("[data-detail-save-error]", "borderTopColor"),
      errorBackground: cs("[data-detail-save-error]", "backgroundColor"),
      errorRadius: cs("[data-detail-save-error]", "borderRadius"),
      errorMarginBottom: px("[data-detail-save-error]", "marginBottom"),
      fields: qa("[data-detail-save-field]").map((el) => el.getAttribute("data-detail-save-field")),
    },
    props: {
      tag: tag(props),
      display: cs(props, "display"),
      gridTemplateColumns: cs(props, "gridTemplateColumns"),
      rowGap: px(props, "rowGap"),
      columnGap: cs(props, "columnGap"),
      alignItems: cs(props, "alignItems"),
      childCount: props?.childElementCount ?? null,
      i18nCount: qa('[data-detail-props] [data-i18n^="prop."]').length,
      labelFont: px("[data-detail-props] .td-prop-label", "fontSize"),
      labelColor: cs("[data-detail-props] .td-prop-label", "color"),
    },
    propValue: {
      display: cs(propValue, "display"),
      gap: px(propValue, "gap"),
      minHeight: px(propValue, "minHeight"),
      paddingLeft: px(propValue, "paddingLeft"),
      fontSize: px(propValue, "fontSize"),
      borderTopWidth: px(propValue, "borderTopWidth"),
      borderRadius: cs(propValue, "borderRadius"),
      cursor: cs(propValue, "cursor"),
      tags: ["[data-detail-status]", "[data-detail-priority]", "[data-detail-project]"].map((s) => tag(q(s))),
      statusChildren: children(q("[data-detail-status]")),
      priorityChildren: children(q("[data-detail-priority]")),
      hasChevron: !!q("[data-detail-status] svg"),
      projectLabelClass: classes(q("[data-detail-project-label]")),
    },
    idCopy: {
      tag: tag(idCopy),
      className: classes(idCopy),
      copyValue: idCopy?.getAttribute("data-copy-value") ?? null,
      svgCount: idCopy ? idCopy.querySelectorAll("svg").length : 0,
      display: cs(idCopy, "display"),
      gap: px(idCopy, "gap"),
      fontFamily: cs(idCopy, "fontFamily"),
      fontSize: px(idCopy, "fontSize"),
      padding: [px(idCopy, "paddingTop"), px(idCopy, "paddingRight")],
      borderRadius: cs(idCopy, "borderRadius"),
      color: cs(idCopy, "color"),
    },
    version: {
      display: cs("[data-detail-version]", "display"),
      minHeight: px("[data-detail-version]", "minHeight"),
      paddingLeft: px("[data-detail-version]", "paddingLeft"),
    },
    labelsRow: {
      className: classes(labelRow),
      display: cs(labelRow, "display"),
      minHeight: px(labelRow, "minHeight"),
      paddingLeft: px(labelRow, "paddingLeft"),
      chipCount: qa("[data-detail-label-chip]").length,
      chipTag: tag(labelChip),
      chipClass: classes(labelChip),
      chipChildren: children(labelChip),
      chipHeight: px(labelChip, "height"),
      chipRadius: cs(labelChip, "borderRadius"),
      chipFontSize: px(labelChip, "fontSize"),
      chipPadding: [px(labelChip, "paddingTop"), px(labelChip, "paddingRight"), px(labelChip, "paddingBottom"), px(labelChip, "paddingLeft")],
      chipBackground: cs(labelChip, "backgroundColor"),
      chipTitle: labelChip?.getAttribute("title") ?? null,
      removeTag: tag(labelRemove),
      removeChildren: children(labelRemove),
      removeWidth: px(labelRemove, "width"),
      removeHeight: px(labelRemove, "height"),
      removeAria: labelRemove?.getAttribute("aria-label") ?? null,
      removeTitle: labelRemove?.getAttribute("title") ?? null,
      removeSvgCount: labelRemove ? labelRemove.querySelectorAll("svg.td-icon-sm").length : 0,
    },
    sections: {
      count: sections.length,
      firstPaddingTop: px(sections[0], "paddingTop"),
      firstPaddingBottom: px(sections[0], "paddingBottom"),
      firstBorderTop: px(sections[0], "borderTopWidth"),
      secondPaddingTop: px(sections[1], "paddingTop"),
      secondPaddingBottom: px(sections[1], "paddingBottom"),
      secondBorderTop: px(sections[1], "borderTopWidth"),
      className: classes(sections[0]),
      titleCount: qa("[data-detail-drawer] .td-section-title").length,
      titleFontSize: px(sectionTitle, "fontSize"),
      titleWeight: cs(sectionTitle, "fontWeight"),
      titleLetterSpacing: cs(sectionTitle, "letterSpacing"),
      titleTransform: cs(sectionTitle, "textTransform"),
      titleColor: cs(sectionTitle, "color"),
      titleMarginBottom: px(sectionTitle, "marginBottom"),
      titles: qa("[data-detail-drawer] .td-section-title").map((el) => el.textContent.trim()),
    },
    description: {
      tag: tag(gfm),
      className: classes(gfm),
      parentTag: tag(gfm?.parentElement),
      fontSize: px(gfm, "fontSize"),
      lineHeight: cs(gfm, "lineHeight"),
      color: cs(gfm, "color"),
      gfmCountInDrawer: qa("[data-detail-drawer] .td-gfm").length,
      blockGap: gfmSecond ? +Number.parseFloat(getComputedStyle(gfmSecond).marginTop).toFixed(2) : null,
      h4: {
        fontSize: px(gfm?.querySelector("h4"), "fontSize"),
        weight: cs(gfm?.querySelector("h4"), "fontWeight"),
        marginTop: px(gfm?.querySelector("h4"), "marginTop"),
      },
      ul: { paddingLeft: px(gfm?.querySelector("ul:not(.td-task-list)"), "paddingLeft") },
      liGap: (() => {
        const list = gfm?.querySelector("ul:not(.td-task-list)");
        const second = list?.children[1] ?? null;
        return second ? +Number.parseFloat(getComputedStyle(second).marginTop).toFixed(2) : null;
      })(),
      code: {
        fontSize: px(gfm?.querySelector("code"), "fontSize"),
        background: cs(gfm?.querySelector("code"), "backgroundColor"),
        borderRadius: cs(gfm?.querySelector("code"), "borderRadius"),
        borderTopWidth: px(gfm?.querySelector("code"), "borderTopWidth"),
      },
      pre: {
        padding: [px(gfm?.querySelector("pre"), "paddingTop"), px(gfm?.querySelector("pre"), "paddingLeft")],
        borderRadius: cs(gfm?.querySelector("pre"), "borderRadius"),
      },
      blockquote: {
        borderLeftWidth: px(gfm?.querySelector("blockquote"), "borderLeftWidth"),
        color: cs(gfm?.querySelector("blockquote"), "color"),
      },
      table: {
        width: cs(gfm?.querySelector("table"), "width"),
        borderCollapse: cs(gfm?.querySelector("table"), "borderCollapse"),
      },
      th: {
        background: cs(gfm?.querySelector("th"), "backgroundColor"),
        fontWeight: cs(gfm?.querySelector("th"), "fontWeight"),
      },
      taskList: {
        className: classes(gfm?.querySelector("ul.td-task-list")),
        display: cs(gfm?.querySelector("ul.td-task-list"), "display"),
        itemDisplay: cs(gfm?.querySelector("ul.td-task-list li"), "display"),
        itemGap: px(gfm?.querySelector("ul.td-task-list li"), "gap"),
        listStyle: cs(gfm?.querySelector("ul.td-task-list"), "listStyleType"),
        paddingLeft: px(gfm?.querySelector("ul.td-task-list"), "paddingLeft"),
      },
      check: {
        count: gfm ? gfm.querySelectorAll(".td-check").length : 0,
        box: size(gfm?.querySelector(".td-check")),
        borderRadius: cs(gfm?.querySelector(".td-check"), "borderRadius"),
        checkedTrue: cs(gfm?.querySelector('.td-check[data-checked="true"]'), "borderTopColor"),
        checkedFalse: cs(gfm?.querySelector('.td-check[data-checked="false"]'), "borderTopColor"),
        checkedTrueInk: cs(gfm?.querySelector('.td-check[data-checked="true"]'), "color"),
        checkedFalseInk: cs(gfm?.querySelector('.td-check[data-checked="false"]'), "color"),
      },
    },
    relations: {
      tag: tag(q("[data-detail-relations]")),
      parentTag: tag(q("[data-detail-relations]")?.parentElement),
      className: classes(q("[data-detail-relations]")),
      display: cs("[data-detail-relations]", "display"),
      flexWrap: cs("[data-detail-relations]", "flexWrap"),
      gap: cs("[data-detail-relations]", "gap"),
      itemCount: qa("[data-detail-relations] .td-rel-item").length,
      itemTags: qa("[data-detail-relations] .td-rel-item").map(tag),
      itemLabels: qa("[data-detail-relations] .td-rel-item [data-i18n]").map((el) => el.getAttribute("data-i18n")),
      links: qa("[data-detail-relations] [data-relation-link]").map((el) => ({ tag: tag(el), className: classes(el), text: el.textContent.trim() })),
      emptySeat: q("[data-detail-relations] [data-i18n='relations.none']")?.tagName.toLowerCase() ?? null,
    },
    attachments: {
      tag: tag(q("[data-detail-attachments]")),
      parentTag: tag(q("[data-detail-attachments]")?.parentElement),
      rowCount: qa("[data-attachment-row]").length,
      rowTag: tag(fileRow),
      rowClass: classes(fileRow),
      display: cs(fileRow, "display"),
      gap: px(fileRow, "gap"),
      padding: [px(fileRow, "paddingTop"), px(fileRow, "paddingLeft")],
      borderWidth: px(fileRow, "borderTopWidth"),
      borderRadius: cs(fileRow, "borderRadius"),
      iconClass: classes(fileRow?.querySelector("svg")),
      nameClass: classes(q("[data-attachment-name]")),
      nameFontSize: px("[data-attachment-name]", "fontSize"),
      nameWeight: cs("[data-attachment-name]", "fontWeight"),
      nameColor: cs("[data-attachment-name]", "color"),
      sizeClass: classes(q("[data-attachment-size]")),
      sizeFont: cs("[data-attachment-size]", "fontFamily"),
      sizeFontSize: px("[data-attachment-size]", "fontSize"),
      sizeColor: cs("[data-attachment-size]", "color"),
      sizeMarginLeft: cs("[data-attachment-size]", "marginLeft"),
      rowRect: rectOf(fileRow),
      sizeRect: rectOf(q("[data-attachment-size]")),
      emptySeat: q("[data-detail-attachments] [data-i18n='attachments.none']")?.tagName.toLowerCase() ?? null,
    },
    comments: {
      tag: tag(q("[data-detail-comments]")),
      parentTag: tag(q("[data-detail-comments]")?.parentElement),
      rowCount: qa("[data-detail-comments] .td-comment").length,
      rowTag: tag(comment),
      rowClass: classes(comment),
      display: cs(comment, "display"),
      gap: px(comment, "gap"),
      paddingTop: px(comment, "paddingTop"),
      borderTopWidth: px(comment, "borderTopWidth"),
      /* R14 §3 `.td-comment`: `border-top: 1px` with the **first row exempt**
         (`:first-child`), so the pair is read row by row, not off row one. */
      rowBorders: qa("[data-detail-comments] .td-comment").map((el) => +Number.parseFloat(getComputedStyle(el).borderTopWidth).toFixed(2)),
      avatarCount: qa("[data-detail-comments] .td-avatar").length,
      avatarClass: classes(commentAvatar),
      metaCount: qa("[data-detail-comments] .td-comment-meta").length,
      metaDisplay: cs(commentMeta, "display"),
      metaGap: px(commentMeta, "gap"),
      metaFontSize: px(commentMeta, "fontSize"),
      metaText: commentMeta?.textContent.replace(/\s+/g, " ").trim() ?? null,
      metaI18n: qa("[data-detail-comments] .td-comment-meta [data-i18n]").map((el) => el.getAttribute("data-i18n")),
      bodyClass: classes(commentBody),
      bodyFontSize: px(commentBody, "fontSize"),
      bodyWhiteSpace: cs(commentBody, "whiteSpace"),
      bodyColor: cs(commentBody, "color"),
      decisionCount: qa("[data-detail-comments] .td-comment-decision").length,
      decisionPaddingLeft: px(decision, "paddingLeft"),
      decisionBorderLeft: px(decision, "borderLeftWidth"),
      decisionBorderColor: cs(decision, "borderLeftColor"),
    },
    commentForm: {
      tag: tag(form),
      childTags: children(form),
      labelCount: form ? form.querySelectorAll("label").length : 0,
      labelTag: tag(form?.querySelector("label")),
      labelClass: classes(form?.querySelector("label")),
      labelFor: form?.querySelector("label")?.getAttribute("for") ?? null,
      labelI18n: form?.querySelector("label")?.getAttribute("data-i18n") ?? null,
      textareaTag: tag(textarea),
      textareaId: textarea?.id ?? null,
      textareaClass: classes(textarea),
      textareaWidth: cs(textarea, "width"),
      textareaMinHeight: px(textarea, "minHeight"),
      textareaPadding: [px(textarea, "paddingTop"), px(textarea, "paddingLeft")],
      textareaFontSize: px(textarea, "fontSize"),
      textareaBorderWidth: px(textarea, "borderTopWidth"),
      textareaRadius: cs(textarea, "borderRadius"),
      textareaResize: cs(textarea, "resize"),
      hintCount: qa("[data-comment-form] [data-i18n='drawer.commentHint']").length,
      hintFontSize: px("[data-comment-form] [data-i18n='drawer.commentHint']", "fontSize"),
      hintColor: cs("[data-comment-form] [data-i18n='drawer.commentHint']", "color"),
      submitTag: tag(q("[data-comment-submit]")),
      submitClass: classes(q("[data-comment-submit]")),
      submitText: q("[data-comment-submit]")?.textContent.trim() ?? null,
    },
    activity: {
      tag: tag(q("[data-detail-activity]")),
      parentTag: tag(q("[data-detail-activity]")?.parentElement),
      rowCount: qa("[data-detail-activity] .td-activity").length,
      rowTag: tag(activityRow),
      rowClass: classes(activityRow),
      display: cs(activityRow, "display"),
      alignItems: cs(activityRow, "alignItems"),
      gap: px(activityRow, "gap"),
      paddingTop: px(activityRow, "paddingTop"),
      fontSize: px(activityRow, "fontSize"),
      color: cs(activityRow, "color"),
      tsClass: classes(activityTs),
      tsFont: cs(activityTs, "fontFamily"),
      tsFontSize: px(activityTs, "fontSize"),
      tsMarginLeft: cs(activityTs, "marginLeft"),
      tsWhiteSpace: cs(activityTs, "whiteSpace"),
    },
    session: {
      sectionTag: tag(session),
      sectionHidden: session?.hasAttribute("hidden") ?? null,
      sectionPadding: [px(session, "paddingTop"), px(session, "paddingBottom")],
      sectionBorderTop: px(session, "borderTopWidth"),
      boxTag: tag(sessionBox),
      boxPadding: [px(sessionBox, "paddingTop"), px(sessionBox, "paddingLeft")],
      boxBackground: cs(sessionBox, "backgroundColor"),
      boxBorder: px(sessionBox, "borderTopWidth"),
      boxRadius: cs(sessionBox, "borderRadius"),
      badgeTag: tag(q("[data-agent-session] [data-agent-platform]")),
      badgeClass: classes(q("[data-agent-session] [data-agent-platform]")),
      badgePlatform: q("[data-agent-session] [data-agent-platform]")?.getAttribute("data-agent-platform") ?? null,
      badgeHeight: px("[data-agent-session] [data-agent-platform]", "height"),
      platformValueTag: tag(q("[data-agent-platform-value]")),
      platformValueClass: classes(q("[data-agent-platform-value]")),
      platformValueFont: cs("[data-agent-platform-value]", "fontFamily"),
      platformValueFontSize: px("[data-agent-platform-value]", "fontSize"),
      resumeTag: tag(q("[data-agent-resume]")),
      resumeClass: classes(q("[data-agent-resume]")),
      resumeMarginLeft: cs("[data-agent-resume]", "marginLeft"),
      idSeat: q("[data-detail-agent-session-body] [data-i18n='session.id']")?.textContent.trim() ?? null,
      idTag: tag(q("[data-agent-session-id]")),
      idClass: classes(q("[data-agent-session-id]")),
      idText: q("[data-agent-session-id]")?.textContent.trim() ?? null,
      copyBoxCount: qa("[data-detail-drawer] .td-copy").length,
    },
    templates: {
      hasHidden: q("[data-detail-templates]")?.hasAttribute("hidden") ?? null,
      insideDrawer: !!q("[data-detail-drawer] [data-detail-templates]"),
      templateCount: qa("template[data-detail-for]").length,
      divForCount: qa("div[data-detail-for]").length,
      liveSlotCount: qa("[data-slot]").length,
    },
    overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
  };
}

/** Readings taken with the drawer closed (the hooks must exist at rest). */
function readClosed() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const drawer = q("[data-detail-drawer]");
  return {
    dataState: drawer?.getAttribute("data-state") ?? null,
    hasHidden: drawer?.hasAttribute("hidden") ?? null,
    visibility: drawer ? getComputedStyle(drawer).visibility : null,
    transform: drawer ? getComputedStyle(drawer).transform : null,
    overlayHidden: q("[data-detail-overlay]")?.hasAttribute("hidden") ?? null,
    hooksAtRest: [
      "[data-detail-drawer]",
      "[data-detail-identifier]",
      "[data-detail-props]",
      "[data-detail-labels]",
      "[data-detail-comments]",
      "[data-detail-activity]",
      "[data-detail-attachments]",
      "[data-detail-relations]",
      "[data-detail-agent-session]",
      "[data-detail-save]",
      "[data-detail-save-error]",
      "[data-detail-templates]",
      "[data-comment-form]",
    ].map((s) => qa(s).length),
  };
}

/** The empty-state readings on the card without extras. */
function readEmptyStates() {
  const q = (s) => document.querySelector(s);
  const tag = (el) => (el ? el.tagName.toLowerCase() : null);
  return {
    relationsNone: tag(q("[data-detail-relations] [data-i18n='relations.none']")),
    attachmentsNone: tag(q("[data-detail-attachments] [data-i18n='attachments.none']")),
    attachmentsRows: document.querySelectorAll("[data-attachment-row]").length,
    labelChips: document.querySelectorAll("[data-detail-label-chip]").length,
    comments: document.querySelectorAll("[data-detail-comments] .td-comment").length,
    activity: document.querySelectorAll("[data-detail-activity] .td-activity").length,
    attachmentSeatText: q("[data-detail-attachments] [data-i18n='attachments.none']")?.textContent.trim() ?? null,
    relationsSeatText: q("[data-detail-relations] [data-i18n='relations.none']")?.textContent.trim() ?? null,
  };
}

/* ------------------------------------------------------------------ driver */

async function main() {
  const playwright = resolvePlaywright();
  if (!playwright) {
    console.error("no playwright available");
    process.exit(2);
  }
  const data = fixtureApi();
  /* `--single-process` Chromium is not stable across context teardown in this
     sandbox, so every pass gets its own browser (launch is ~0.3s). */
  const launch = () => playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS, timeout: 30000 });

  const openPage = async (browser, { width = 1512, height = 950, theme = "light", lang = "en", javaScriptEnabled = true } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled });
    await context.addInitScript(
      ([t, l]) => {
        try {
          localStorage.setItem("meerkat-taskpanel.theme", t);
          localStorage.setItem("meerkat-taskpanel.lang", l);
        } catch {
          /* storage unavailable for this origin — the defaults are light/en anyway */
        }
      },
      [theme, lang],
    );
    const page = await context.newPage();
    const errors = { console: 0, page: 0, messages: [] };
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors.console += 1;
        errors.messages.push(`console: ${m.text()}`);
      }
    });
    page.on("pageerror", (e) => {
      errors.page += 1;
      errors.messages.push(`pageerror: ${String(e.message)}`);
    });
    await mountRoutes(page, { distDir: DIST, data });
    await page.goto("http://app.test/board", { waitUntil: "load" });
    return { context, page, errors };
  };

  const waitForBoard = (page) => page.waitForSelector("[data-card]", { timeout: 20000 });
  const openCard = async (page, identifier) => {
    await page.click(`[data-card][data-identifier="${identifier}"]`);
    await page.waitForFunction(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") === "open", null, { timeout: 10000 });
    await page.waitForTimeout(260);
  };
  const closeCard = async (page) => {
    await page.click("[data-detail-close]");
    await page.waitForFunction(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") === "closed", null, { timeout: 10000 });
  };

  /* ------------------------------------------------ main pass · 1512 light en */
  const mainBrowser = await launch();
  const mainPass = await openPage(mainBrowser);
  mainPass.browser = mainBrowser;
  await waitForBoard(mainPass.page);
  const closed = await mainPass.page.evaluate(readClosed);

  chk("A6", "A", "[data-detail-drawer]", "抽屉本体不带 hidden（§8 U4 裁定）", false, closed.hasHidden);
  chk("A6b", "A", "[data-detail-drawer]", "关闭态 = translateX(100%) + visibility:hidden（原型同形）", ["none", "hidden"], [
    closed.transform === "matrix(1, 0, 0, 1, 520, 0)" ? "none" : closed.transform,
    closed.visibility,
  ]);
  chk("A6c", "A", "[data-detail-overlay]", "遮罩关闭态带 hidden", true, closed.overlayHidden);
  chkFn("A6d", "A", "13 枚 B09 钩子（关闭态）", "逐个 count >= 1", true, closed.hooksAtRest, (v) => v.every((n) => n >= 1));

  await openCard(mainPass.page, RICH_ID);
  const open = await mainPass.page.evaluate(readOpen);

  /* ---- A legs -------------------------------------------------------- */
  chk("A1", "A", "[data-detail-drawer]", "count == 1", 1, open.state.drawerCount);
  chk("A2", "A", "[data-detail-overlay]", "count == 1", 1, open.state.overlayCount);
  chk("A3", "A", "[data-detail-identifier]", "classList 含 td-id-full 计数 == 1", 1, open.identifier.countWithClass);
  record(
    "A4",
    "A",
    "[data-detail-templates]",
    "§5 归属列已改「原型」（回灌契约 T-20261014-112216）：**实现侧 N/A** —— 模板源（`template[data-detail-for]` / slot 多重性）是原型腿的断言",
    "原型腿 · N/A",
    { hasHidden: open.templates.hasHidden, templateCount: open.templates.templateCount, divForCount: open.templates.divForCount },
    true,
    "实现侧无 clone 机制（§4 R14-B32 已判 `简化`）；模板源断言由原型腿 verify-r14-proto.mjs 承载，不在本腿裁决。实现侧读数仅登记",
  );
  record(
    "A6e",
    "A",
    "[data-detail-templates] / [data-detail-drawer]",
    "§5 归属列已改「原型」（模板宿主位置）：**实现侧 N/A**；实现侧 `aside` 无 hidden 的义务由 §8.0 U4 / §8.1 D08 承载（见 A6）",
    "原型腿 · N/A",
    { templateInsideDrawer: open.templates.insideDrawer, asideHasHidden: open.drawerShell.hasHidden },
    true,
    `aside hidden = ${open.drawerShell.hasHidden}（U4 义务，A6 已断言）；模板宿主位置由原型腿承载`,
  );
  chk("A7", "A", "[data-detail-drawer][aria-labelledby]", "指向 td-detail-title，且该元素存在、是 h2", ["td-detail-title", true, "h2"], [
    open.drawerShell.ariaLabelledby,
    open.drawerShell.labelledbyTarget,
    open.drawerShell.labelledbyIsH2,
  ]);
  chk("A8", "A", "[data-detail-close] · identifier · chip", "三者同一父元素", [true, true], [open.close.sameRowAsIdentifier, open.close.sameRowAsChip]);
  chk("A9", "A", "[data-detail-props]", "childElementCount == 16", 16, open.props.childCount);
  chk("A10", "A", "[data-detail-save-field]", "三处 == assignee/reporter/labels", ["assignee", "reporter", "labels"], open.save.fields);
  chk("A11", "A", "[data-detail-save] / [data-detail-save-error]", "idle + 载体 hidden + role=alert + 错块 hidden", ["idle", true, "alert", true], [
    open.save.carrierState,
    open.save.carrierHidden,
    open.save.errorRole,
    open.save.errorHidden,
  ]);
  chk("A12", "A", "[data-detail-save-error]", "原型无 data-i18n；实现保留座位（§8 U2 裁定 = 口径偏离）", "detail.saveError", open.save.errorI18n, "允许的书面偏差，非缺陷");
  chk("A13", "A", "[data-detail-description]", "tag / class / 父", ["div", "td-gfm", "section"], [open.description.tag, open.description.className, open.description.parentTag]);
  chk("A14", "A", "relations · attachments · comments · activity", "四者都是 div", ["div", "div", "div", "div"], [open.relations.tag, open.attachments.tag, open.comments.tag, open.activity.tag]);
  chk("A14b", "A", "同上", "四者的父都是 section", ["section", "section", "section", "section"], [
    open.relations.parentTag,
    open.attachments.parentTag,
    open.comments.parentTag,
    open.activity.parentTag,
  ]);
  chk("A15", "A", "[data-detail-agent-session]", "tag == section", "section", open.session.sectionTag);
  chk("A16", "A", "status / priority / project", "三者 tag == button", ["button", "button", "button"], open.propValue.tags);
  chk("A17", "A", "[data-detail-status] 子元素", "== [span, span, svg]", ["span", "span", "svg"], open.propValue.statusChildren);
  chk("A18", "A", "[data-detail-id-copy]", "button + data-copy-value 非空 + 内含 1 个 svg", ["button", true, 1], [
    open.idCopy.tag,
    (open.idCopy.copyValue ?? "") !== "",
    open.idCopy.svgCount,
  ]);
  const assigneeAttrs = await mainPass.page.evaluate(() => [
    document.querySelector("[data-detail-assignee]")?.getAttribute("data-assignee-kind") ?? null,
    document.querySelector("[data-detail-assignee-avatar]")?.getAttribute("data-assignee-kind") ?? null,
    document.querySelector("[data-detail-assignee-platform]")?.getAttribute("data-agent-platform") ?? null,
  ]);
  chk("A19", "A", "[data-detail-assignee] / -avatar / -platform", "kind ×2 == agent，platform == openclaw", ["agent", "agent", "openclaw"], assigneeAttrs);
  chk("A20", "A", "[data-comment-form]", "子 = [label, textarea, div]｜label 1｜#td-comment-input｜hint 1｜form 1", [["label", "textarea", "div"], 1, "td-comment-input", 1, 1], [
    open.commentForm.childTags,
    open.commentForm.labelCount,
    open.commentForm.textareaId,
    open.commentForm.hintCount,
    open.commentForm.tag === "form" ? 1 : 0,
  ]);
  chk("A22", "A", "遮罩 / 抽屉 z-index", "40 / 50", ["40", "50"], [open.overlayShell.zIndex, open.drawerShell.zIndex]);
  chkFn("A23", "A", '[data-detail-props] [data-i18n^="prop."]', "count >= 8", true, open.props.i18nCount, (v) => v >= 8);
  chk("A24", "A", "JS-on 轮", "console.error == 0 && pageerror == 0", [0, 0], [mainPass.errors.console, mainPass.errors.page]);

  /* ---- B legs -------------------------------------------------------- */
  chk("B1", "B", "[data-detail-drawer]", "width / max-width / position", ["520px", "1512px", "fixed"], [open.drawerShell.width, open.drawerShell.maxWidth, open.drawerShell.position]);
  chk("B2", "B", "[data-detail-identifier]", "max-width / overflow / text-overflow / white-space", ["none", "visible", "clip", "nowrap"], [
    open.identifier.maxWidth,
    open.identifier.overflow,
    open.identifier.textOverflow,
    open.identifier.whiteSpace,
  ]);
  chkFn("B3", "B", "[data-detail-identifier]", "scrollWidth == clientWidth（9 字符 PROJ-0007 不裁）", true, [open.identifier.scrollWidth, open.identifier.clientWidth], (v) => v[0] === v[1] && v[0] > 0);
  chk("B4", "B", ".td-drawer-body 内边距", "16 / 20 / 24 / 20", [16, 20, 24, 20], open.body.padding);
  chk("B5", "B", ".td-drawer-body", "overflow-y == auto", "auto", open.body.overflowY);
  chk("B6", "B", "aside > header.td-drawer-head", "padding 四值", [12, 16, 12, 20], open.header.padding);
  chk("B7", "B", "[data-detail-props]", "grid / 96px 轨道 / row-gap 4px / 无列间距", ["grid", "96px 383px", 4, "normal"], [
    open.props.display,
    open.props.gridTemplateColumns,
    open.props.rowGap,
    open.props.columnGap,
  ]);
  chk("B8", "B", ".td-section-title", "11px / uppercase / 0.66px / margin-bottom 8px", [11, "uppercase", "0.66px", 8], [
    open.sections.titleFontSize,
    open.sections.titleTransform,
    open.sections.titleLetterSpacing,
    open.sections.titleMarginBottom,
  ]);
  chk("B9", "B", "section[data-detail-agent-session]", "padding 16 / 16、border-top 1px", [16, 16, 1], [
    open.session.sectionPadding[0],
    open.session.sectionPadding[1],
    open.session.sectionBorderTop,
  ]);
  chk("B10", "B", "[data-detail-description]", "13px / 19.5px / ink-2", [13, "19.5px", "rgb(74, 85, 94)"], [
    open.description.fontSize,
    open.description.lineHeight,
    open.description.color,
  ]);
  chk("B11", "B", "[data-detail-drawer] .td-gfm", "count == 1", 1, open.description.gfmCountInDrawer);
  chk("B12", "B", "[data-detail-status-chip]", "18px / 999px / 12px", [18, "999px", 12], [open.chip.height, open.chip.borderRadius, open.chip.fontSize]);
  chk("B13", "B", "[data-detail-labels]", "类 / display / min-height / padding-left", ["td-prop-value td-prop-combo", "flex", 28, 6], [
    open.labelsRow.className,
    open.labelsRow.display,
    open.labelsRow.minHeight,
    open.labelsRow.paddingLeft,
  ]);
  chk("B14", "B", "[data-detail-label-chip]", "tag / 子 [span,button] / 18px / 999px / 12px / 左内边距 8px", ["span", ["span", "button"], 18, "999px", 12, 8], [
    open.labelsRow.chipTag,
    open.labelsRow.chipChildren,
    open.labelsRow.chipHeight,
    open.labelsRow.chipRadius,
    open.labelsRow.chipFontSize,
    open.labelsRow.chipPadding[3],
  ]);
  chk("B15", "B", "[data-detail-label-remove]", "tag / 子 [svg] / 16×16", ["button", ["svg"], 16, 16], [
    open.labelsRow.removeTag,
    open.labelsRow.removeChildren,
    open.labelsRow.removeWidth,
    open.labelsRow.removeHeight,
  ]);
  chk("B16", "B", "[data-agent-session]", "8px 10px / border 1px / 圆角 6px", [[8, 10], 1, "6px"], [
    open.session.boxPadding,
    open.session.boxBorder,
    open.session.boxRadius,
  ]);
  chk("B18", "B", "[data-detail-activity] .td-activity", "flex / baseline / 3px / 12px", ["flex", "baseline", 3, 12], [
    open.activity.display,
    open.activity.alignItems,
    open.activity.paddingTop,
    open.activity.fontSize,
  ]);
  chkFn("B19", "B", "documentElement", "无横向溢出", true, open.overflow, (v) => v.scrollWidth === v.clientWidth);
  chk("B20", "B", "[data-detail-drawer]", "表面 light 白 + 左边框 1px", ["rgb(255, 255, 255)", 1], [open.drawerShell.background, open.drawerShell.borderInlineStartWidth]);
  chk("B20b", "B", ".td-drawer 边框色", "light rgb(230,232,235)", "rgb(230, 232, 235)", open.drawerShell.borderInlineStartColor);
  chkFn("B20c", "B", ".td-drawer", "box-shadow 非 none", true, open.drawerShell.boxShadow, (v) => v !== "none");
  chk("B20d", "B", "[data-detail-overlay]", "fixed / inset 0 / opacity 1", ["fixed", ["0px", "0px", "0px", "0px"], "1"], [
    open.overlayShell.position,
    open.overlayShell.inset,
    open.overlayShell.opacity,
  ]);
  record(
    "B22",
    "B",
    "[data-detail-overlay]",
    "light 遮罩 = **该侧自己的遮罩令牌**（token 口径，回灌契约 §5 B22 / §8.3 DF-1）：实现读既有共享令牌 `--brand-scrim`，涂出色 == 令牌解析值 且 alpha≈0.32；**不对 light 值做跨侧字面量相等断言**（原型 `rgba(15,20,23,.32)` ≠ 实现 `rgb(31,42,46)/32%`，`DF-1` 登记）",
    "== var(--brand-scrim)（非透明，alpha 0.32）",
    open.overlayShell.background,
    (() => {
      const painted = parseColor(open.overlayShell.background);
      return (
        !!painted &&
        painted[3] > 0.3 &&
        painted[3] < 0.34 &&
        colorClose(open.overlayShell.scrimTokenResolved, open.overlayShell.background, 2)
      );
    })(),
    `token($brand-scrim) → ${JSON.stringify(parseColor(open.overlayShell.scrimTokenResolved))}；overlay → ${JSON.stringify(parseColor(open.overlayShell.background))}（DF-1：light 字面量与原型故意不同，dark 两侧同值见 B22b）`,
  );
  chk("B24", "B", ".td-file（附件行）", "flex / padding 6px 8px / border 1px / 圆角 6px", ["flex", [6, 8], 1, "6px"], [
    open.attachments.display,
    open.attachments.padding,
    open.attachments.borderWidth,
    open.attachments.borderRadius,
  ]);
  chk("B25", "B", ".td-comment 两行", "flex / padding-top 8px / 首行无 border、次行 1px", ["flex", 8, [0, 1]], [
    open.comments.display,
    open.comments.paddingTop,
    open.comments.rowBorders,
  ]);
  chkFn("B26", "B", "富卡样本（TD-128 等价）", "评论 ≥1、meta ≥1、头像 ≥1、.td-rel-item ≥1、relation-link ≥1", true, [
    open.comments.rowCount,
    open.comments.metaCount,
    open.comments.avatarCount,
    open.relations.itemCount,
    open.relations.links.length,
  ], (v) => v.every((n) => n >= 1));
  chkFn("B27", "B", ".td-comment-decision", "count >= 1", true, open.comments.decisionCount, (v) => v >= 1);

  /* ---- D 腿：§8.1 D01–D50 里不被 A/B/C 覆盖的判定点 ---------------- */
  chk("D11", "D", "aside > header", "border-bottom 1px", 1, open.header.borderBottomWidth);
  chk("D13", "D", ".td-drawer-body", "min-height 0 + scrollbar-width thin + flex 1 1 auto", ["0px", "thin", "1 1 auto"], [
    open.body.minHeight,
    open.body.scrollbarWidth,
    open.body.flex,
  ]);
  chk("D18", "D", "[data-detail-identifier]", "12px / ink-3", [12, "rgb(126, 138, 145)"], [open.identifier.fontSize, open.identifier.color]);
  chk("D19", "D", "[data-detail-title]", "16px / 600", [16, "600"], [open.titleBlock.fontSize, open.titleBlock.fontWeight]);
  record(
    "D21",
    "D",
    ".td-save-error",
    "12px / 边框 rgb(192,57,43) / 圆角 6px / margin-bottom 12px（四项逐值）+ 底色：原型是不透明 rgb(251,238,236)，实现是同色 12% 的 color-mix，**按涂在抽屉白底上的复合色**比",
    [12, "rgb(192, 57, 43)", "6px", 12],
    [open.save.errorFontSize, open.save.errorBorderColor, open.save.errorRadius, open.save.errorMarginBottom],
    "底色另见 D21b",
  );
  const errorResolved = parseColor(open.save.errorBackground);
  const composited = errorResolved ? errorResolved.slice(0, 3).map((v) => v * errorResolved[3] + 255 * (1 - errorResolved[3])) : null;
  record(
    "D21b",
    "D",
    ".td-save-error 底色",
    "复合到白底后 ≈ rgb(251,238,236)（容差 8/255）",
    [251, 238, 236],
    composited ? composited.map((v) => +v.toFixed(1)) : null,
    !!composited && composited.every((v, i) => Math.abs(v - [251, 238, 236][i]) <= 8),
    `token → ${JSON.stringify(errorResolved)}`,
  );
  chk("D24", "D", ".td-prop-label", "12px / ink-3（座位由 A23 判）", [12, "rgb(126, 138, 145)"], [open.props.labelFont, open.props.labelColor]);
  record(
    "D25",
    "D",
    ".td-prop-value",
    "gap 6 / min-height 28 / padding 0 6px / 13px / 透明 1px 边 / 圆角 4px；display：CSS 声明 inline-flex，作为 grid item 被**块化成 flex**（原型同）",
    ["flex", 6, 28, 6, 13, 1, "4px"],
    [
      open.propValue.display,
      open.propValue.gap,
      open.propValue.minHeight,
      open.propValue.paddingLeft,
      open.propValue.fontSize,
      open.propValue.borderTopWidth,
      open.propValue.borderRadius,
    ],
    "声明值 inline-flex 见 audit-static 的 dist CSS 断言",
  );
  chk("D26", "D", "[data-detail-status]", "cursor: pointer", "pointer", open.propValue.cursor);
  chk("D27", "D", "[data-detail-labels]", "根本身即值盒（B13 已判）＋含 chips 盒", ["td-prop-value td-prop-combo", true], [open.labelsRow.className, open.labelsRow.chipCount > 0]);
  chk("D28", "D", "[data-detail-id-copy]", "gap 6 / mono / 12px / padding 2px 6px / 圆角 4px（display 同 D25 的块化）", ["flex", 6, 12, [2, 6], "4px"], [
    open.idCopy.display,
    open.idCopy.gap,
    open.idCopy.fontSize,
    open.idCopy.padding,
    open.idCopy.borderRadius,
  ]);
  chkFn("D28b", "D", "[data-detail-id-copy]", "字体族是 mono", true, open.idCopy.fontFamily, (v) => /mono/i.test(String(v)));
  record(
    "D29",
    "D",
    "section.td-section",
    "非首段：padding-top 16 / padding-bottom 16 / border-top 1px",
    [16, 16, 1],
    [open.sections.secondPaddingTop, open.sections.secondPaddingBottom, open.sections.secondBorderTop],
    "`:first-child` 去 padding/border 是**规则**层事实（本轮的 body 首个子元素是保存态载体，原型同），由 audit-static 的 dist CSS 断言；见报告 §D29",
  );
  chk("D29b", "D", "section.td-section", "类名与分区数（7 段：属性…活动）", ["td-section", 7], [open.sections.className, open.sections.count]);
  chk("D30", "D", ".td-section-title", "500 / ink-3 / margin-bottom 8px（字号等由 B8 判）", ["500", "rgb(126, 138, 145)", 8], [
    open.sections.titleWeight,
    open.sections.titleColor,
    open.sections.titleMarginBottom,
  ]);
  chk("D34", "D", "[data-detail-description] > * + *", "块间 margin-top 8px", 8, open.description.blockGap);
  chk("D35", "D", ".td-gfm 富元素", "h4 13/600/margin-top 12；ul padding-left 18；li+li 2；code 盒；pre 圆角 6；blockquote 左边 2", [
    [13, "600", 12],
    18,
    2,
    "4px",
    "6px",
    2,
  ], [
    [open.description.h4.fontSize, open.description.h4.weight, open.description.h4.marginTop],
    open.description.ul.paddingLeft,
    open.description.liGap,
    open.description.code.borderRadius,
    open.description.pre.borderRadius,
    open.description.blockquote.borderLeftWidth,
  ]);
  chkFn("D35b", "D", ".td-gfm code", "行内 code 有底/有边（盒）", true, [open.description.code.background, open.description.code.borderTopWidth], (v) => v[0] !== "rgba(0, 0, 0, 0)" && v[1] > 0);
  chk("D35c", "D", ".td-gfm table", "width 100%（= 卡体内容宽）/ border-collapse collapse / th 有底色", ["479px", "collapse", true], [
    open.description.table.width,
    open.description.table.borderCollapse,
    open.description.th.background !== "rgba(0, 0, 0, 0)",
  ]);
  chk("D35d", "D", ".td-gfm pre", "padding 8px 10px", [8, 10], open.description.pre.padding);
  chk("D36", "D", ".td-gfm 任务清单", "ul.list-style none + padding-left 2px；li display flex / gap 6；.td-check 13×13 圆角 3px；勾选与否靠 color/border 换 token", [
    ["none", 2],
    ["flex", 6],
    [13, 13, "3px"],
    true,
  ], [
    [open.description.taskList.listStyle, open.description.taskList.paddingLeft],
    [open.description.taskList.itemDisplay, open.description.taskList.itemGap],
    [open.description.check.box?.w ?? null, open.description.check.box?.h ?? null, open.description.check.borderRadius],
    open.description.check.checkedTrue !== open.description.check.checkedFalse && open.description.check.checkedTrueInk !== open.description.check.checkedFalseInk,
  ]);
  chkFn("D37", "D", "[data-detail-relations]", "td-rel / wrap / gap 4px 8px / 两个 .td-rel-item 带 relations.parent|blocks 座位", true, [
    open.relations.className,
    open.relations.flexWrap,
    open.relations.gap,
    open.relations.itemLabels,
  ], (v) => v[0] === "td-rel" && v[1] === "wrap" && v[2] === "4px 8px" && JSON.stringify(v[3].sort()) === JSON.stringify(["relations.blocks", "relations.parent"]));
  chkFn("D37b", "D", "[data-relation-link]", "都是 button.td-copy 且文本是任务标识符", true, open.relations.links, (v) => v.length === 2 && v.every((l) => l.tag === "button" && String(l.className).includes("td-copy") && l.text.length > 0));
  chk("D38", "D", "[data-detail-comments]", "钩子在 div 上（父 section）", ["div", "section"], [open.comments.tag, open.comments.parentTag]);
  chk("D39", "D", ".td-comment", "gap 8px", 8, open.comments.gap);
  chk("D40", "D", ".td-comment 内部", "头像 ≥1（.td-avatar）/ meta flex gap 6 12px 且有 kin 座位 / 正文 13px pre-line ink-2", [
    true,
    ["flex", 6, 12],
    [13, "pre-line", "rgb(74, 85, 94)"],
  ], [
    open.comments.avatarCount >= 1 && open.comments.avatarClass === "td-avatar",
    [open.comments.metaDisplay, open.comments.metaGap, open.comments.metaFontSize],
    [open.comments.bodyFontSize, open.comments.bodyWhiteSpace, open.comments.bodyColor],
  ]);
  chkFn("D40b", "D", ".td-comment-meta", "kin 座位含 comment.decision|comment.human|comment.agent 与时间戳", true, open.comments.metaI18n, (v) => v.some((k) => /^comment\.(decision|human|agent)$/.test(k)) && v.some((k) => /^time\./.test(k)));
  chk("D41", "D", ".td-comment-decision", "padding-left 8px / border-left 2px accent", [8, 2], [open.comments.decisionPaddingLeft, open.comments.decisionBorderLeft]);
  chkFn("D41b", "D", ".td-comment-decision", "左边色 = accent token（非透明）", true, open.comments.decisionBorderColor, (v) => v !== "rgba(0, 0, 0, 0)");
  chk("D42", "D", ".td-file 内部", "文件名 12px/500；尺寸 mono 11px **且贴行尾**（原型用 margin-left:auto；实现用别的机制，按几何判）", [12, "500", 11, true], [
    open.attachments.nameFontSize,
    open.attachments.nameWeight,
    open.attachments.sizeFontSize,
    !!open.attachments.rowRect && !!open.attachments.sizeRect && Math.abs(open.attachments.rowRect.right - 8 - open.attachments.sizeRect.right) < 1.5,
  ], `size.marginLeft=${open.attachments.sizeMarginLeft}（used），row.right=${open.attachments.rowRect?.right} size.right=${open.attachments.sizeRect?.right}`);
  chkFn("D42b", "D", ".td-file 家族", "行/名/尺寸都挂 .td-file* 类，图标是 .td-icon", true, [
    open.attachments.rowClass,
    open.attachments.nameClass,
    open.attachments.sizeClass,
    open.attachments.iconClass,
  ], (v) => String(v[0]).includes("td-file") && String(v[1]).includes("td-file-name") && String(v[2]).includes("td-file-size") && String(v[3]).includes("td-icon"));
  chkFn("D42c", "D", "[data-attachment-size]", "字体族 mono", true, open.attachments.sizeFont, (v) => /mono/i.test(String(v)));
  chk("D43", "D", "section[data-detail-agent-session]", "有 .td-session 盒且未隐藏（agent 卡）", ["div", false], [open.session.boxTag, open.session.sectionHidden]);
  chkFn("D43b", "D", ".td-session", "bottom 是 sunken 底（非透明）", true, open.session.boxBackground, (v) => v !== "rgba(0, 0, 0, 0)");
  chk("D44", "D", "[data-agent-session] 行 1", "平台徽 badge.td-agent-badge + data-agent-platform；值 mono 12px；Resume 是 btn 且推右", [
    ["span", true, "openclaw"],
    [12, true],
    "button",
    "button",
  ], [
    [open.session.badgeTag, /badge/.test(String(open.session.badgeClass)) && /td-agent-badge/.test(String(open.session.badgeClass)), open.session.badgePlatform],
    [open.session.platformValueFontSize, /mono/i.test(String(open.session.platformValueFont))],
    open.session.resumeTag,
    open.session.resumeClass?.includes("btn-outline") ? "button" : `class=${open.session.resumeClass}`,
  ]);
  chk("D45", "D", "[data-agent-session-id]", "座位上是 session.id 且 id 挂 .td-copy", [true, true], [
    (open.session.idSeat ?? "").length > 0,
    String(open.session.idClass).includes("td-copy"),
  ]);
  chkFn("D46", "D", ".td-activity-ts", "行族类 td-activity + ts mono 11px 推右（auto 的 used 值 > 0）nowrap", true, [
    open.activity.rowClass,
    open.activity.tsFontSize,
    open.activity.tsMarginLeft,
    open.activity.tsWhiteSpace,
  ], (v) => v[0] === "td-activity" && v[1] === 11 && Number.parseFloat(v[2]) > 0 && v[3] === "nowrap");
  chkFn("D46b", "D", ".td-activity-ts", "字体族 mono", true, open.activity.tsFont, (v) => /mono/i.test(String(v)));
  chk("D47", "D", "[data-comment-form]", "label.td-sr[for=td-comment-input] + textarea + hint + submit", ["label", "td-comment-input", "td-sr", 1], [
    open.commentForm.labelTag,
    open.commentForm.labelFor,
    open.commentForm.labelClass,
    open.commentForm.hintCount,
  ]);
  chk("D48", "D", ".td-textarea", "width 100%（= 卡体内容宽）/ min-height 64px / padding 6px 8px / 13px / 1px 边 / 圆角 6px / resize vertical", [
    "479px",
    64,
    [6, 8],
    13,
    1,
    "6px",
    "vertical",
  ], [
    open.commentForm.textareaWidth,
    open.commentForm.textareaMinHeight,
    open.commentForm.textareaPadding,
    open.commentForm.textareaFontSize,
    open.commentForm.textareaBorderWidth,
    open.commentForm.textareaRadius,
    open.commentForm.textareaResize,
  ]);
  chk("D50", "D", "[data-detail-label-chip] / -remove", "chip 类含 badge + td-chip 且有 title；remove 带 aria-label=\"Clear …\" 与 title", [true, true, true, true], [
    /(^|\s)badge(\s|$)/.test(String(open.labelsRow.chipClass)) && /(^|\s)td-chip(\s|$)/.test(String(open.labelsRow.chipClass)),
    (open.labelsRow.chipTitle ?? "").length > 0,
    /^Clear /.test(String(open.labelsRow.removeAria)),
    (open.labelsRow.removeTitle ?? "").length > 0,
  ]);
  chk("D50b", "D", "[data-detail-label-remove]", "remove 内含 svg.td-icon-sm（不是文字 ✕）", 1, open.labelsRow.removeSvgCount);

  /* ---- C legs（真实点击 / 键盘 / 焦点） ----------------------------- */
  chk("C1", "C", "[data-detail-drawer] / [data-detail-overlay]", "data-state=open｜遮罩 open 且 hidden 摘除", ["open", "open", false], [
    open.state.dataState,
    open.state.overlayState,
    open.state.overlayHidden,
  ]);
  const focusAfterOpen = await mainPass.page.evaluate(() => {
    const el = document.activeElement;
    return {
      onClose: el?.hasAttribute("data-detail-close") ?? false,
      tag: el ? el.tagName.toLowerCase() : null,
      insideDrawer: !!(el && el.closest?.("[data-detail-drawer]")),
    };
  });
  record(
    "C2",
    "C",
    "[data-detail-close]",
    "【只记归属 · 不计 verdict】打开后焦点落 `[data-detail-close]` —— 由另卡 `T-20261014-082552`（`c8c5ccb`）交付，已由 `T-20261014-084606-4` 独立验证 PASS；本卡 SUT 单 lane 不含该修复（Elon 裁定，2026-10-14T03:37Z）",
    "归属 T-20261014-082552 · 不计 verdict",
    focusAfterOpen,
    true,
    "单 lane SUT 预期未带该交互；据此判红属误报（首轮 seg2 已因此误报）。集成批次 B 合并两 lane 后 C2 成立。实现侧读数仅登记",
  );

  await mainPass.page.click("[data-detail-label-input]");
  await mainPass.page.waitForTimeout(160);
  const labelMenu = await mainPass.page.evaluate(() => {
    const menu = document.querySelector("[data-detail-label-menu]");
    return {
      visible: menu ? menu.checkVisibility({ contentVisibilityAuto: true }) : null,
      options: document.querySelectorAll("[data-detail-label-option]").length,
      display: menu ? getComputedStyle(menu).display : null,
    };
  });
  record("C3", "C", "[data-detail-label-menu]", "聚焦输入即开菜单且选项 > 0（实现 v-show，原型 hidden — 同意图）", [true, true], [labelMenu.visible, labelMenu.options > 0], labelMenu.visible === true && labelMenu.options > 0, `display=${labelMenu.display}`);

  const chipsBefore = await mainPass.page.evaluate(() => document.querySelectorAll("[data-detail-label-chip]").length);
  await mainPass.page.click("[data-detail-label-remove]");
  await mainPass.page.waitForTimeout(220);
  const afterRemove = await mainPass.page.evaluate(() => ({
    chips: document.querySelectorAll("[data-detail-label-chip]").length,
    saveState: document.querySelector("[data-detail-save]")?.getAttribute("data-save-state") ?? null,
  }));
  chk("C4", "C", "[data-detail-label-remove]", "点 remove 少一枚 chip", [2, 1], [chipsBefore, afterRemove.chips]);
  chkFn("C5", "C", "[data-detail-save]", "真实提交把状态推离 idle", true, afterRemove.saveState, (v) => v !== null && v !== "idle");

  await mainPass.page.click("[data-detail-assignee-label]");
  await mainPass.page.keyboard.press("ArrowDown");
  await mainPass.page.waitForTimeout(160);
  const assigneeMenu = await mainPass.page.evaluate(() => {
    const menu = document.querySelector("[data-assignee-menu]");
    return {
      visible: menu ? menu.checkVisibility({ contentVisibilityAuto: true }) : null,
      options: document.querySelectorAll("[data-assignee-option]").length,
    };
  });
  chkFn("C6", "C", "[data-assignee-menu]", "ArrowDown 打开菜单（选项 > 0）", true, assigneeMenu.visible, (v) => v === true, `options=${assigneeMenu.options}`);

  await closeCard(mainPass.page);
  const closedAgain = await mainPass.page.evaluate(() => ({
    state: document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") ?? null,
    overlayHidden: document.querySelector("[data-detail-overlay]")?.hasAttribute("hidden") ?? null,
  }));
  chk("C7", "C", "[data-detail-close]", "关闭：state=closed 且遮罩 hidden 复位", ["closed", true], [closedAgain.state, closedAgain.overlayHidden]);

  await openCard(mainPass.page, RICH_ID);
  await mainPass.page.keyboard.press("Escape");
  await mainPass.page.waitForTimeout(280);
  const afterEsc = await mainPass.page.evaluate(() => document.querySelector("[data-detail-drawer]")?.getAttribute("data-state") ?? null);
  chk("C8", "C", "Esc", "重开后按 Esc → closed", "closed", afterEsc);
  chk("C9", "C", "全 C 轮", "console.error == 0 && pageerror == 0", [0, 0], [mainPass.errors.console, mainPass.errors.page]);

  /* ---- §4.3 负向注记（不得触碰的钩子族） ---------------------------- */
  await openCard(mainPass.page, RICH_ID);
  const negative = await mainPass.page.evaluate((longId) => {
    const card = document.querySelector(`[data-card][data-identifier="${longId}"]`);
    return {
    cardIdentifierText: card?.querySelector("[data-card-identifier]")?.textContent ?? null,
    cardIdentifierHasFull: card?.querySelector("[data-card-identifier]")?.classList.contains("td-id-full") ?? null,
    slotSourceCount: document.querySelectorAll("[data-detail-slot-source]").length,
    drawerEmptyMarkers: document.querySelectorAll("[data-detail-drawer] [data-empty]").length,
    attachmentHooks: ["[data-attachment-row]", "[data-attachment-name]", "[data-attachment-size]"].map((s) => document.querySelectorAll(s).length),
    activityHooks: ["[data-activity-row]", "[data-activity-actor]", "[data-activity-ts]"].map((s) => document.querySelectorAll(s).length),
    };
  }, LONG_ID);
  chk("N1", "N", "[data-card-identifier]（11 字符样本）", "卡片标识符仍是裁断形（含 …）且不带 .td-id-full（§4.3 注记 1）", [true, false], [
    (negative.cardIdentifierText ?? "").includes("…"),
    negative.cardIdentifierHasFull,
  ]);
  chk("N2", "N", "[data-detail-slot-source]", "U1(b) 裁定：实现侧已删（0）", 0, negative.slotSourceCount);
  chk("N3", "N", "[data-detail-drawer] [data-empty]", "抽屉空态不是 B12 的 [data-empty]", 0, negative.drawerEmptyMarkers);
  chkFn("N4", "N", "[data-attachment-*] / [data-activity-*]", "U1(a)：两族自创钩子保留", true, [...negative.attachmentHooks, ...negative.activityHooks], (v) => v.every((n) => n >= 1));

  await closeCard(mainPass.page);
  /* R12/R14-B05 — 同一个 11 字符任务在两个渲染点：卡片裁断、抽屉头完整。 */
  await openCard(mainPass.page, LONG_ID);
  const longReading = await mainPass.page.evaluate(() => ({
    drawerText: document.querySelector("[data-detail-identifier]")?.textContent ?? null,
    drawerHasFull: document.querySelector("[data-detail-identifier]")?.classList.contains("td-id-full") ?? null,
    drawerClamped: (() => {
      const el = document.querySelector("[data-detail-identifier]");
      return el ? el.scrollWidth > el.clientWidth : null;
    })(),
  }));
  chk("D14", "D", "[data-detail-identifier]（11 字符）", "抽屉头显示完整 id（不做字符切片）且带 .td-id-full 不裁", [LONG_ID, true, false], [
    longReading.drawerText,
    longReading.drawerHasFull,
    longReading.drawerClamped,
  ]);
  await closeCard(mainPass.page);
  await mainPass.context.close();
  await mainPass.browser.close();

  /* ---- D26 hover（真实指针） ---------------------------------------- */
  const hoverBrowser = await launch();
  const hover = await openPage(hoverBrowser);
  await waitForBoard(hover.page);
  await openCard(hover.page, RICH_ID);
  await hover.page.hover("[data-detail-status]");
  await hover.page.waitForTimeout(220);
  const hoverReading = await hover.page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector("[data-detail-status]"));
    return { background: cs.backgroundColor, borderColor: cs.borderTopColor };
  });
  chkFn("D26h", "D", "button.td-prop-value:hover", "hover 换底 + 换边框（真实指针）", true, hoverReading, (v) => v.background !== "rgba(0, 0, 0, 0)" && v.borderColor !== "rgba(0, 0, 0, 0)");
  await hover.context.close();
  await hoverBrowser.close();

  /* ---- 五宽度（开态） ----------------------------------------------- */
  const widthRows = [];
  for (const width of [1512, 1240, 980, 760, 430]) {
    const browser = await launch();
    const session = await openPage(browser, { width });
    await waitForBoard(session.page);
    await openCard(session.page, RICH_ID);
    const reading = await session.page.evaluate(() => {
      const drawer = document.querySelector("[data-detail-drawer]");
      const identifier = document.querySelector("[data-detail-identifier]");
      const r = drawer.getBoundingClientRect();
      return {
        drawerWidth: +r.width.toFixed(2),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        identifierScroll: identifier.scrollWidth,
        identifierClient: identifier.clientWidth,
        identifierText: identifier.textContent,
      };
    });
    const expect = Math.min(520, width);
    record(
      "B21",
      "B",
      `[data-detail-drawer] @${width}`,
      "宽 == min(520, 视口)、无横向溢出、identifier 不裁",
      expect,
      reading.drawerWidth,
      Math.abs(reading.drawerWidth - expect) < 0.6 && reading.scrollWidth === reading.clientWidth && reading.identifierScroll === reading.identifierClient,
      JSON.stringify(reading),
    );
    widthRows.push({ width, ...reading });
    await session.context.close();
    await browser.close();
  }

  /* ---- zh ------------------------------------------------------------ */
  const zhBrowser = await launch();
  const zh = await openPage(zhBrowser, { width: 1512, lang: "zh" });
  await waitForBoard(zh.page);
  await openCard(zh.page, RICH_ID);
  const zhReading = await zh.page.evaluate(() => ({
    lang: document.documentElement.lang,
    chip: document.querySelector("[data-detail-status-chip-label]")?.textContent?.trim() ?? null,
    sectionTitle: document.querySelector("[data-detail-drawer] .td-section-title")?.textContent?.trim() ?? null,
    overflow: document.documentElement.scrollWidth === document.documentElement.clientWidth,
  }));
  chk(
    "B23",
    "B",
    "html[lang]（zh）",
    "lang = **该侧自己的 locale id**（回灌契约 §5 B23：原型 `zh-CN` / 实现镜像 `web/src/i18n/catalogue.mjs` 的 `zh`）+ chip + 分区标题 + 无溢出",
    ["zh", "待办", "属性", true],
    [zhReading.lang, zhReading.chip, zhReading.sectionTitle, zhReading.overflow],
  );
  await zh.context.close();
  await zhBrowser.close();

  /* ---- dark ---------------------------------------------------------- */
  const darkBrowser = await launch();
  const dark = await openPage(darkBrowser, { theme: "dark" });
  await waitForBoard(dark.page);
  await openCard(dark.page, RICH_ID);
  const darkReading = await dark.page.evaluate(() => ({
    surface: getComputedStyle(document.querySelector("[data-detail-drawer]")).backgroundColor,
    ink: getComputedStyle(document.querySelector("[data-detail-drawer]")).color,
    scrim: getComputedStyle(document.querySelector("[data-detail-overlay]")).backgroundColor,
  }));
  chk("B22b", "B", "[data-detail-drawer]（dark）", "dark 表面 / 文字 / 遮罩换 token", ["rgb(22, 27, 30)", "rgb(230, 237, 240)", "rgba(0, 0, 0, 0.55)"], [
    darkReading.surface,
    darkReading.ink,
    darkReading.scrim,
  ]);
  await dark.context.close();
  await darkBrowser.close();

  /* ---- 空态（无附件 / 无关联 / 无评论的卡） ------------------------- */
  const emptyBrowser = await launch();
  const emptySession = await openPage(emptyBrowser);
  await waitForBoard(emptySession.page);
  await openCard(emptySession.page, PLAIN_ID);
  const empty = await emptySession.page.evaluate(readEmptyStates);
  chk("A21", "A", "抽屉空态", "relations.none / attachments.none 都是 span", ["span", "span"], [empty.relationsNone, empty.attachmentsNone]);
  chk("A21b", "A", "[data-detail-attachments]", "无附件的卡 0 行且出现空态座位", [0, true], [empty.attachmentsRows, empty.attachmentsNone !== null]);
  chkFn("A21c", "A", "空态座位文本", "渲染后的文本非空（不是裸 key）", true, [empty.attachmentSeatText, empty.relationsSeatText], (v) => v.every((t) => typeof t === "string" && t.length > 0 && !t.includes(".")));
  await emptySession.context.close();
  await emptyBrowser.close();

  /* ---- JS-off（静态可见性对照） ------------------------------------- */
  const noJsBrowser = await launch();
  const noJs = await openPage(noJsBrowser, { javaScriptEnabled: false });
  const noJsReading = await noJs.page.evaluate(() => ({
    appChildren: document.querySelector("#app")?.childElementCount ?? null,
    drawerHooks: document.querySelectorAll("[data-detail-drawer]").length,
    noscript: document.querySelectorAll("noscript").length,
  }));
  record("A25i", "A", "实现（JS-off）", "记录实现自身的 JS-off 读数（原型 A25/A26 由 verify-r14-proto.mjs 跑）", "记录", noJsReading, true, "实现是 SPA，#app 由 JS 挂载；静态可见性只能在原型侧断言，见报告 §no-JS");
  await noJs.context.close();
  await noJsBrowser.close();

  const summary = {
    label: LABEL,
    dist: DIST,
    total: results.length,
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    failed: results.filter((r) => !r.pass).map((r) => `${r.id} :: ${r.assertion} → expected ${JSON.stringify(r.expected)}, actual ${JSON.stringify(r.actual)}`),
  };
  const payload = { summary, results, widthRows, open, closed, empty, zh: zhReading, dark: darkReading, noJs: noJsReading, errors: mainPass.errors };
  if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!process.env.R14_QUIET) {
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${String(r.id).padEnd(6)} ${r.leg} ${r.assertion} :: ${JSON.stringify(r.actual)}`);
  }
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
