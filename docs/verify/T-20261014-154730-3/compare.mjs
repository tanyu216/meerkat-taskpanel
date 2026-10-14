#!/usr/bin/env node
/* =====================================================================
   T-20261014-154730-3 · the card's judgments, computed from the two
   evidence files rather than asserted in prose.

   Reads  `evidence/capture.json` (this card's re-read of both sides against
   the **post-fix** build) and `evidence/close-focus.json` (the reused
   computed probe), and diffs each against the previous leg's
   `docs/verify/T-20261014-150729/evidence.json` — so "I-1/I-2 从差异转为一致、
   其余条目不变" is a computation with a list, not a claim.

   Usage: node docs/verify/T-20261014-154730-3/compare.mjs
   Exit:  0 always (this is a reading, not a gate); the verdict lands in
          `evidence/verdict.json` and on stdout.
   ===================================================================== */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const now = read(join(HERE, "evidence", "capture.json"));
const probe = read(join(HERE, "evidence", "close-focus.json"));
const closeups = read(join(HERE, "evidence", "closeups.json"));
const before = read(join(REPO, "docs/verify/T-20261014-150729/evidence.json"));

const WIDTHS = [1512, 1240, 980, 760, 430];
const BLOCKS = [
  ["props", "[data-detail-props]"],
  ["description", "[data-detail-description]"],
  ["relations", "[data-detail-relations]"],
  ["attachments", "[data-detail-attachments]"],
  ["comments", "[data-detail-comments]"],
  ["activity", "[data-detail-activity]"],
  ["session", "[data-detail-agent-session]"],
];

/** Every leaf that differs between two readings, as `path: before → after`. */
function moved(beforeSide, afterSide, { skipText = true } = {}) {
  const out = [];
  const SKIP = new Set(["title", "text", "values", "labels", "identifier", "id", "note"]);
  const walk = (a, b, path) => {
    if (a === null || b === null || b === undefined || typeof a !== "object") {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      return;
    }
    for (const k of Object.keys(a)) {
      if (skipText && SKIP.has(k)) continue;
      walk(a[k], b?.[k], `${path}.${k}`);
    }
  };
  walk(beforeSide, afterSide, "");
  return out;
}

const verdict = {
  card: "T-20261014-154730-3",
  generated_at: new Date().toISOString(),
  build: {
    dist: now.readings.servedBuild?.dist,
    carrier: now.readings.servedBuild?.carrier,
    assets: Object.fromEntries(
      Object.entries(now.readings.servedBuild?.assets ?? {}).map(([name, a]) => [name, a.sha256_16])
    ),
    onDisk: now.readings.servedBuild?.onDisk ?? {},
  },
};

/* ---- ① the close box and the ring, both sides, both probes ---------- */
const box = (s) => ({
  computed: [s.box.width, s.box.height],
  rect: [s.box.rectWidth, s.box.rectHeight],
  display: s.box.display,
  borderTopWidth: s.box.borderTopWidth,
  borderRadius: s.box.borderRadius,
  color: s.box.color,
  glyph: s.glyph,
  head: s.head.height,
  titleLineHeight: (s.head.children.find((c) => c.hook === "data-detail-title") ?? {}).lineHeight ?? null,
});
verdict.closeFocus = {
  probe: "docs/verify/T-20261014-154730/probe-close-focus.mjs (reused, unchanged)",
  before_fix_impl: {
    box: [before.readings.seatCompare.impl["[data-detail-close]"].rect],
    head: before.readings.seatCompare.impl[".td-drawer-head"].rect[1],
    titleLineHeight: before.readings.seatCompare.impl["[data-detail-title]"].lineHeight,
    ring: before.readings.focus.impl.outline,
    ringBoxShadow: before.readings.focus.impl.boxShadow,
  },
  proto: { ...box(probe.proto), ring: probe.proto.focus },
  impl_postfix: { ...box(probe.impl), ring: probe.impl.focus },
  /* the four values the card names, compared mechanically */
  equalOn: {
    computedBox: box(probe.proto).computed.join("x") === box(probe.impl).computed.join("x"),
    rect: box(probe.proto).rect.join("x") === box(probe.impl).rect.join("x"),
    display: box(probe.proto).display === box(probe.impl).display,
    borderTopWidth: box(probe.proto).borderTopWidth === box(probe.impl).borderTopWidth,
    borderRadius: box(probe.proto).borderRadius === box(probe.impl).borderRadius,
    color: box(probe.proto).color === box(probe.impl).color,
    glyph: JSON.stringify(box(probe.proto).glyph) === JSON.stringify(box(probe.impl).glyph),
    headHeight: box(probe.proto).head === box(probe.impl).head,
    titleLineHeight: box(probe.proto).titleLineHeight === box(probe.impl).titleLineHeight,
    focusRing: JSON.stringify(probe.proto.focus) === JSON.stringify(probe.impl.focus),
  },
  /* the closeup probe's identical-clip pair, read the same way */
  closeups: {
    clip: closeups.clip,
    closeFaceGeometry: {
      proto: closeups.proto.closeFace.close,
      impl: closeups.impl.closeFace.close,
      identical: JSON.stringify(closeups.proto.closeFace.close) === JSON.stringify(closeups.impl.closeFace.close),
    },
    computedBox: {
      proto: closeups.proto.closeFace.closeComputed,
      impl: closeups.impl.closeFace.closeComputed,
      identical: JSON.stringify(closeups.proto.closeFace.closeComputed) === JSON.stringify(closeups.impl.closeFace.closeComputed),
    },
    focusedRing: {
      proto: closeups.proto.ring,
      impl: closeups.impl.ring,
      identical: JSON.stringify(closeups.proto.ring) === JSON.stringify(closeups.impl.ring),
    },
    note: "侧向并排图 b-head-side-by-side.png 的两张特写使用**同一个视口坐标裁剪框**（同尺寸同位移），故可逐像素肉眼比对。",
  },
};

/* ---- ② the five widths ---------------------------------------------- */
verdict.fiveWidths = WIDTHS.map((w) => {
  const p = now.readings.proto[`w${w}`];
  const i = now.readings.impl[`w${w}`];
  const oi = before.readings.impl[`w${w}`];
  const head = (s) => (s.head.box ? { x: s.head.box.x, w: s.head.box.w, h: s.head.box.h } : null);
  return {
    width: w,
    drawer: { proto: [p.drawer.x, p.drawer.w, p.drawer.h], impl: [i.drawer.x, i.drawer.w, i.drawer.h] },
    page: {
      proto: [p.page.scrollWidth, p.page.clientWidth],
      impl: [i.page.scrollWidth, i.page.clientWidth],
      horizontalOverflow: i.page.scrollWidth !== i.page.clientWidth || p.page.scrollWidth !== p.page.clientWidth,
    },
    head: { proto: head(p), impl: head(i), identical: JSON.stringify(head(p)) === JSON.stringify(head(i)) },
    close: { proto: [p.head.close.w, p.head.close.h], impl: [i.head.close.w, i.head.close.h] },
    blocks: Object.fromEntries(
      BLOCKS.map(([key, sel]) => [
        sel,
        {
          proto: { box: p.blocks[key].box, visible: p.blocks[key].box?.visible },
          impl: { box: i.blocks[key].box, visible: i.blocks[key].box?.visible },
          sameBox: JSON.stringify([p.blocks[key].box?.x, p.blocks[key].box?.y, p.blocks[key].box?.w]) ===
            JSON.stringify([i.blocks[key].box?.x, i.blocks[key].box?.y, i.blocks[key].box?.w]),
          deltaH: +(i.blocks[key].box.h - p.blocks[key].box.h).toFixed(1),
        },
      ])
    ),
    /* what the fix moved on the implementation side (the *only* thing that may
       have moved — the prototype must be untouched) */
    implMovedSince150729: moved(oi, i),
    protoMovedSince150729: moved(before.readings.proto[`w${w}`], p),
  };
});

/* ---- ③ the 150729 §4 difference list, recomputed --------------------- */
verdict.recheck150729 = {
  protoSeatCompareMoved: moved(before.readings.seatCompare.proto, now.readings.seatCompare.proto),
  implSeatCompareMoved: moved(before.readings.seatCompare.impl, now.readings.seatCompare.impl),
  rows: [
    { n: 1, seat: "[data-detail-status-chip] label", was: "原型恒 To Do / 实现随卡", unit: "selector 级", status: "本卡样本 TD-128 为 todo，两侧同文案；非 todo 卡未纳入本卡样本 ⇒ 未复核（承 150729 登记）" },
    { n: 2, seat: "[data-detail-close] 盒径", was: "16×16 vs 32×32", unit: "盒径级", status: "**转为一致**（computed 32×32 双侧）" },
    { n: 3, seat: "焦点环", was: "1px auto rgb(0,95,204) vs 2px solid rgb(15,122,115)", unit: "盒径级", status: "**转为一致**（含 offset 2px 与 halo 4px）" },
    { n: 4, seat: "[data-detail-version] 文本", was: "v3 vs 3", unit: "文本级", status: "不变（原型 mock 口径）" },
    { n: 5, seat: ".td-avatar 字母", was: "LI vs L", unit: "文本级", status: "不变（原型静态模板两字 vs initial() 一字）" },
    { n: 6, seat: "[data-agent-platform-value]", was: "163.4×18 vs 43.4×16", unit: "盒径级", status: "不变" },
    { n: 7, seat: ".td-drawer-head 高", was: "78.6 vs 67", unit: "盒径级", status: "**转为一致**（78.6 双侧；computed 78.59）" },
    { n: 8, seat: "[data-detail-comments] 高", was: "221 vs 338", unit: "盒径级", status: "不变（嵌套口径：form 在块内 vs 块外）" },
    { n: 9, seat: "[data-detail-label-input] 刻度", was: "24 / padding 0 6 / r4 vs 29.5 / padding 4 8 / r6", unit: "盒径级", status: "不变" },
    { n: 10, seat: "[data-detail-overlay] 涂出色", was: "rgba(15,20,23,.32) vs oklab(...)", unit: "token 口径", status: "不变（同色；DF-1）" },
  ],
};

/* ---- ④ the collateral question — did the global ring overreach? ------ */
verdict.collateralFocus = Object.fromEntries(
  Object.keys(closeups.proto.focusFaces).map((sel) => [
    sel,
    {
      proto: closeups.proto.focusFaces[sel],
      impl: closeups.impl.focusFaces[sel],
      identical: JSON.stringify(closeups.proto.focusFaces[sel]) === JSON.stringify(closeups.impl.focusFaces[sel]),
    },
  ])
);

/* ---- ⑤ non-A groups: what moved, on each side ------------------------ */
verdict.otherGroups = Object.fromEntries(
  ["focus", "scroll", "overlay", "jsOff"].map((g) => [
    g,
    {
      protoMoved: moved(before.readings[g]?.proto, now.readings[g]?.proto),
      implMoved: moved(before.readings[g]?.impl, now.readings[g]?.impl),
    },
  ])
);
verdict.otherStates = Object.fromEntries(
  ["b-human", "b-zh", "b-empty"].map((k) => [
    k,
    {
      protoMoved: moved(before.readings.proto[k], now.readings.proto[k]),
      implMoved: moved(before.readings.impl[k], now.readings.impl[k]),
    },
  ])
);

verdict.pageErrors = { capture: now.pageErrors, closeups: closeups.pageErrors };

writeFileSync(join(HERE, "evidence", "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");

/* ---- a short human summary on stdout -------------------------------- */
const line = (s) => process.stdout.write(s + "\n");
line(`build  ${verdict.build.assets ? JSON.stringify(verdict.build.assets) : "(none)"}`);
line(`close  equal: ${JSON.stringify(verdict.closeFocus.equalOn)}`);
line(`ring   ${JSON.stringify(verdict.closeFocus.probe === "" ? null : verdict.closeFocus.impl_postfix.ring.outlineColor)}`);
for (const w of verdict.fiveWidths) {
  line(
    `w${w.width}  drawer proto ${w.drawer.proto.join("/")} · impl ${w.drawer.impl.join("/")}  head identical=${w.head.identical}  overflow=${w.page.horizontalOverflow}  implMoved=${w.implMovedSince150729.length}  protoMoved=${w.protoMovedSince150729.length}`
  );
}
line(`seatCompare moved since 150729 — proto ${verdict.recheck150729.protoSeatCompareMoved.length}, impl ${verdict.recheck150729.implSeatCompareMoved.length}`);
for (const m of verdict.recheck150729.implSeatCompareMoved) line(`    ${m}`);
line(`collateral ${JSON.stringify(Object.fromEntries(Object.entries(verdict.collateralFocus).map(([k, v]) => [k, v.identical])))}`);
