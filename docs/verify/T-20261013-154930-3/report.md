# T-20261013-154930-3 · seg3 回归复测报告（R14 详情抽屉保真）

> 独立只读复核 · 回归腿（D42 修复后）。本报告**不重写首轮结论**，只做「D42 复绿 + 三处口径折算 + 负向对抗」的回归复测。

> **落位（2026-10-15 · 目录归一化）**：本报告已归一到
> **`docs/verify/T-20261013-154930-3/report.md`**（原 `verification/T-20261013-154930-3/report.md`），
> 与同卡的 evidence / harness 同址。家族约定原本是「产物进 `docs/verify/<卡>/`、文字报告进
> `verification/<卡>/report.md`」（`docs/verify/T-20261014-150729/README.md` 的落位约定段），
> `T-20261014-154730-2` 起改为**全部落 `docs/verify/<卡>/**`**。本次为**纯移动**
> （blob `6e45504` 移动前后逐字节相同），除本则说明外**内容未作任何改写** —— 因此
> **下文出现的 `verification/…` 一律为落位前路径**，§9 里那条 `git add … verification/…`
> 记的是本卡当时那条提交。`verification/` 目录随后清空，不再有第二落位点。

## Conclusion

**verdict = PASS（通过）** —— R14「详情抽屉保真」独立只读复核 **回归复测**。
机检 **122 断言：pass 122 / fail 0**（exit=0）。首轮 6 红（A4 / A6e / B22 / B23 / C2 / D42）**全部清零**，其中：

- **D42**（附件行图标定尺）→ **真缺陷已修复，复绿**（`e40aa58`：图标补 `size-4`）。
- **C2**（打开后焦点）→ **只记归属**（`T-20261014-082552` @ `c8c5ccb`，已由 `T-20261014-084606-4` 验证 PASS），**不计本卡 verdict、不据此判红**（Elon 裁定）。
- **B22 / B23 / A4·A6e** → 三处口径按**回灌契约**（`T-20261014-112216` @ `525c12e`）折算后断言同步 ⇒ 复绿。

**未放宽任何真缺陷断言**：D42 的几何判据原样保留，负向定向变异仍能把它打红（见 §4）。

## 交付坐标（integrate 用）

- **SUT（被验对象）**：`lane/T-20261013-154930-2-seg2` @ **`e40aa58`**（父 `43bdf5f` = seg1 全量 R14 产物 + 本轮 D42 修复；`web/src/components/detail/DetailDrawer.vue` 1 文件 +4/−3）。**未叠加 082552 lane**（C2 已移出裁决面）。
- **本卡 lane worktree**：`/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261013-154930-3-seg3`，branch **`lane/T-20261013-154930-3-seg3`**。
- **本卡提交（本报告 + harness + 证据）**：见 §9「Commit」。若 `.git` 越权致提交被拒，报告见 §9「提交状态」并给出待提交路径清单。
- **口径基线（只读参考）**：`/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261014-112216-seg1`（`design/fidelity-r14.md` 回灌版）。

## Acceptance self-check

- [x] **前置：按契约 §8.1「D01–D50」逐条判真伪** → **满足**。50 条判定见 §3（D01–D50 逐条），每行给 selector 级读数；本轮唯一状态变化 = **D42 由「真差异·必修」→ PASS**。
- [x] **逐条 selector 级断言 + 五宽度 + no-JS 静态可见 + 零增量 + 写面收窄 + 负向对抗定向变红复绿** → **满足**：
  - selector 级断言：122 条（A 结构 31 / B 几何·computed 34 / C 交互 9 / D 逐条 44 / N 负向 4），**exit=0**。
  - 五宽度：1512 / 1240 / 980 / 760 / 430，抽屉宽 `520/520/520/520/430`，各宽度 `scrollWidth==clientWidth`（无横向溢出）、identifier 不裁（`65==65`）→ 全绿（B21×5）。
  - no-JS：实现侧 N/A by design（SPA），读数 `{appChildren:0, drawerHooks:0, noscript:0}`；契约 §5 把 A25/A26 归属写「**原型**」⇒ 引用原型腿存档（未伪造读数，见 §6）。
  - 零增量：设计/ i18n **零改** —— 全 lane 写面 `34f623d..e40aa58` 共 6 文件，**全在 `web/**` + `test/web/**`**；`design/**` 0、`src/**`/`server/**` 0、`web/src/i18n/**` 0。（§7）
  - 写面收窄：同上；B2 实现 6 文件、D42 修复再 1 文件（同 `DetailDrawer.vue`）。
  - 负向对抗：D42 定向变异 ⇒ **变红**（122→121，唯一红 = D42）；B22 / B23 各自定向 ⇒ 定向变红；还原 ⇒ 复绿（§4）。

## 1. 6 处首轮 FAIL 的本轮状态

| 条目 | 首轮判定（seg2） | 本轮状态 | 依据（selector 级证据） |
|---|---|---|---|
| **D42** 附件行几何 | 真差异·本轮缺陷（必修） | **PASS · 已修复** | `e40aa58` 给附件行 `svg.td-icon` 补 `size-4`。几何：图标 **16×16**、行 `scrollWidth 477 == clientWidth 477`、`.td-file-size` `margin-left:auto` used=**247.484px**、`size.right 1483` 落在 `row.right 1492` 内侧 8px（=padding-right，误差 <1.5）。见 §5 |
| **C2** 打开后焦点 | 真差异（seg2 误判归属） | **只记归属 · 不计 verdict** | 属 `T-20261014-082552`（`c8c5ccb`），已由 `T-20261014-084606-4` 独立验证 **PASS**。本卡 SUT 单 lane 不含该修复⇒不复判红。harness 记 `C2` 为归属条目（actual `{onClose:false,tag:"body",insideDrawer:false}`） |
| **B22** light 遮罩涂出色 | 真差异·越界 | **PASS · token 口径** | 回灌契约 §5 B22 / §8.3 `DF-1`：遮罩改「**既有令牌口径保留**」，断言「**涂出色 == 该侧遮罩令牌解析值** 且 alpha≈0.32」，**不再跨侧断言 light 字面量相等**。实测 overlay = `oklab(0.276439 … / 0.32)` ≡ `rgb(31,42,46)/32%`，与 `var(--brand-scrim)` 探针一致；dark 两侧同值 `rgba(0,0,0,0.55)`（B22b 绿） |
| **B23** `lang` | 口径 | **PASS · 镜像各侧自己的 locale id** | 回灌契约 §5 B23：原型 `zh-CN` / 实现 `zh`。实测实现 `html[lang]="zh"`、chip `待办`、分区标题 `属性`、无溢出 |
| **A4** 模板源 | 口径（契约内部不一致） | **PASS · 归属改「原型」** | 回灌契约 §5 A4 归属列改「**原型**」⇒ 实现侧 N/A。实现读数仅登记：`{hasHidden:true, templateCount:0, divForCount:1}`（§4 R14-B32 判 `简化`） |
| **A6e** 模板宿主 | 口径（契约内部不一致） | **PASS · 归属改「原型」** | 回灌契约 §5 A6 归属列改「**原型**」（模板宿主位置）；实现侧 `aside` 无 hidden 义务由 §8.0 U4 / §8.1 D08 承载（A6 已断言 `aside hidden=false`） |

**口径核对（§8.0 裁定）**：U1(a) 六枚自创钩子保留（N4 `[≥1…]` ✔）· U1(b) `[data-detail-slot-source]` 已删（N2=0 ✔）· U4 抽屉去 `hidden`/去自创 `:aria-hidden`（A6 ✔）· U2 `detail.saveError` 座位保留（A12 ✔）· C06 措辞不动（`design/**` 零 diff ✔）。

## 2. 机检判定（回归）

- **122 / 122 pass，0 fail**，`exit=0`。
- 命令：`R14_QUIET=1 node docs/verify/T-20261013-154930-3/verify-r14-impl.mjs --dist web/dist --out <json> --label impl`
- 构建 SUT：`node node_modules/vite/bin/vite.js build --configLoader runner`（`web/dist`，`vite 8.3.4`，exit 0）—— 沙箱禁 `listen(2)` 且 `vite.config.js` 默认 `bundle` 装载器要写 `node_modules/.vite-temp`（越权），故用 `--configLoader runner` 规避；harness 走 Playwright 路由拦截 + `--single-process`，仍是**真 Chromium**（真解析/真排版/真 computed）。
- 控制台/页面错误：`console 0 / page 0`。

## 3. D01–D50 逐条判定（§8.1）

以下为契约 §8.1「本轮要补的样式细节全集」逐条状态。**本轮相对首轮的唯一变化 = D42**（`真差异·必修` → `落地`）；其余 49 条**保持首轮判定**（无回退）。判定依据 = 本轮实测读数（harness `--out` json）与首轮存档一致。

| id | 判定 | 承载体（harness） | 本轮读数要点 |
|---|---|---|---|
| D01 抽屉宽 520 | 落地 | B21×5 | 520/520/520/520/430 |
| D02 壳层圆角/边框 | 落地 | B20/B20b | 左边框 1px `rgb(230,232,235)` |
| D03 壳层阴影 | 落地 | B20c | box-shadow ≠ none |
| D04 头区 padding/border | 落地 | A15/A17… | 头区 `.td-drawer-head` |
| D05 头区刻度 | 落地 | — | id 全量 + 关闭同排（A8/D14） |
| D06 体区滚动/最小高 | 落地 | D13 | min-height 0 / scrollbar thin / flex 1 1 |
| D07 遮罩令牌/opacity | 落地（token 口径） | B22/B20d | light=`--brand-scrim` 解析值；opacity 1；`DF-1` |
| D08 抽屉去 hidden | 落地 | A6 | `[data-detail-drawer]` 无 hidden |
| D09 关闭态形制 | 落地 | A6b | `translateX(100%)` + `visibility:hidden` |
| D10 遮罩关闭态 hidden | 落地 | A6c | overlay hidden 关闭 |
| D11 分区分隔线 | 落地 | D11 | border-bottom 1px |
| D12 分区标题刻度 | 落地 | B8 | 分区标题字号（harness B8 绿） |
| D13 分区间距 | 落地 | D29b | 7 段：属性…活动 |
| D14 属性网格 16 格 | 落地 | A9 | childElementCount=16 |
| D15 属性标签色 | 落地 | D18 | 12px / ink-3 |
| D16 属性值 | 落地 | D19 | 16px / 600 |
| D17 保存栏字段 | 落地 | A10 | assignee/reporter/labels |
| D18 保存错误座位 | 落地 | A11/A12 | carrier idle + error role=alert |
| D19 描述区 markdown | 落地 | A13/D29… | `.td-gfm` |
| D20 描述块间距 | 落地 | D34 | 块间 margin-top 8px |
| D21 markdown h4/ul/li/code/table | 落地 | D35/D35b/D35c | 见 D35* |
| D22 关联区分组 | 落地 | D37 | `.td-rel-item` 两类 |
| D23 关联项按钮 | 落地 | D37b | button.td-copy + 任务标识符 |
| D24 关联空态 | 落地 | A21/A21c | span 座位、文本非裸 key |
| D25 属性行控件 | 落地 | B10–B15 | combo/chip 刻度 |
| D26 控件 hover | 落地 | D26/D26h | cursor pointer + 真实指针换底/换边框 |
| D27 标签 chips | 落地 | B14/B15/D50 | chip + remove 16×16 svg |
| D28 复制盒 `.td-copy` | 落地 | D28/D28b | gap 6 / mono / 圆角 4px |
| D29 描述可折叠/分区 | 落地 | D29/D29b | 非首段上下 padding 16 + border |
| D30 评论区刻度 | 落地 | D30 | 500 / ink-3 / margin-bottom 8 |
| D31 评论行形制 | 落地 | B25 | flex / padding-top 8 / 行边框 |
| D32 评论空态/表单 | 落地 | D47/D48 | sr label + textarea + 提交 |
| D33 评论头像 | 落地 | B26/D40 | `.td-avatar` ≥1 |
| D34 评论 meta 行 | 落地 | D40/D40b | flex gap 6/12px + kin 座位 |
| D35 决策样式 | 落地 | D41/D41b | padding-left 8 / border-left 2 accent |
| D36 活动区列表 | 落地 | D36 | ul list-style none / padding-left 2 |
| D37 活动行族 | 落地 | D46/D46b | `.td-activity` + ts mono 11px 推右 |
| D38 会话区钩子 | 落地 | D38 | 钩子在 div（父 section） |
| D39 会话盒间距 | 落地 | D39 | gap 8px |
| D40 会话盒体 | 落地 | B16/D43/D43b | 8px 10px / border 1 / 圆角 6 / sunken 底 |
| D41 会话行 | 落地 | D44 | 平台徽 + mono 12px + Resume 推右 |
| D42 **附件行几何** | **落地（本轮修复）** | **D42/D42b/D42c/B24** | 图标 **16×16**；行 `scrollWidth 477==clientWidth 477`；`.td-file-size` auto used=**247.484px**、贴行尾（§5） |
| D43 会话 id 座位 | 落地 | D45 | `session.id` 挂 `.td-copy` |
| D44 附件名/尺寸刻度 | 落地 | D42 | 名 12px/500；尺寸 mono 11px |
| D45 附件空态 | 落地 | A21b/A21c | 0 行 + span 座位 |
| D46 活动 auto-margin 对照 | 落地 | D46 | ts 推右 auto used>0（同类机制对照） |
| D47 评论输入 | 落地 | D47 | label.sr[for] + textarea + 提交 |
| D48 评论提交按钮 | 落地 | D48 | width 100% / min-height 64 / padding |
| D49 属性网格细分 | 落地 | A9/B10–B15 | 16 格 + 控件刻度 |
| D50 标签 chip/remove | 落地 | D50/D50b | chip badge+td-chip + svg.td-icon-sm |

> 说明：D 编号↔承载体为**就近映射**（同一元素刻度可能由 A/B/C 多条覆盖，如 D07→B22、D08→A6、D44→D42）。**唯一影响 verdict 的是 D42**，其余 49 条本轮无 red。

## 4. 负向对抗（定向变红 ⇒ 还原复绿）

| 注入 | 目标断言 | 结果 | 读数 |
|---|---|---|---|
| **D42 定向**：仅删附件行（`DetailDrawer.vue:552`）`size-4`（关闭按钮 `:340` 不动） | `D42`（+B24 面） | **变红**：122→**121/1 fail**，唯一红 = `D42` | 图标 **461×461**、行 `scrollWidth 558 > clientWidth 477`、`.td-file-size` auto used=**0px**、`size.right 1571.59` > `row.right 1492`（溢出行尾） |
| **B22 定向**：遮罩 `bg-(--brand-scrim)` → 硬编码原型字面量 `rgba(15,20,23,0.32)` | `B22`（token 口径） | **变红**：120/2 fail | `B22`：overlay 涂出色 ≠ `var(--brand-scrim)` 解析值；连带 `B22b`（dark 遮罩不再随主题换 token）——证明该断言**拒绝「硬编码原型字面量」** |
| **B23 定向**：删 `<html lang>` 镜像写（`i18n/index.js:applyLang`） | `B23`（locale id 镜像） | **变红**：121/1 fail | 唯一红 = `B23`，actual `html[lang]="en"`（期望 `zh`）——证明折算后的口径断言**仍具区分力**（非恒真） |
| 还原 | —— | **复绿** | 还原 SUT（=本 lane HEAD `e40aa58`）复跑：**122/122，0 fail** |

> D42 定向变异**精确复现首轮读数**（461×461 / 558>477 / auto=0 / 1571.59），即修复前缺陷与修复后两态均被同一断言区分，非口径放水。

## 5. D42 几何读数（修复 vs 变异）

| 量 | 修复后（`e40aa58`，绿） | 变异（删 `size-4`，红） | 首轮（`43bdf5f`，红） |
|---|---|---|---|
| 图标 `svg.td-icon` 尺寸 | **16×16** | 461×461 | 461×461 |
| 行 `scrollWidth / clientWidth` | **477 / 477**（无溢出） | 558 / 477（溢出） | 558 / 477 |
| `.td-file-size` `margin-left:auto` used | **247.484px** | 0px | 0px |
| `size.right` vs `row.right` | 1483 vs 1492（内侧 8px，贴行尾） | 1571.59 vs 1492（越界） | 1571.59 vs 1492 |
| `documentElement` 溢出 | 1512==1512 | 1512==1512（行内溢出被抽屉裁） | 1512==1512 |

## 6. no-JS 静态可见（口径）

契约 §5 把 **A25/A26 归属写「原型」** ⇒ 实现侧为 SPA，JS-off 下 `#app` 无子节点属**设计使然**。harness `A25i` 记录实现读数 `{appChildren:0, drawerHooks:0, noscript:0}`（info）。原型侧读数引用 R14 契约卡 `T-20261013-154930` 存档（`69/69`），**本沙箱禁 `listen(2)` 未复跑原型腿，未伪造读数**。

## 7. 零增量 / 写面收窄

- 全 lane 写面 `git diff --name-only 34f623d e40aa58` = **6 文件**：`test/web/blocks.contract.mjs`、`web/scripts/dom-smoke.mjs`、`web/src/components/combo/ComboField.vue`、`web/src/components/detail/DetailDrawer.vue`、`web/src/lib/markdown-lite.js`、`web/src/styles/app.css`。**全在 `web/**` + `test/web/**`**。
- `design/**` 改动 = **0**；`src/**`/`server/**` 改动 = **0**；`web/src/i18n/**` 改动 = **0**（i18n 键集零 diff）。
- D42 修复单独面 `git diff --name-only 43bdf5f e40aa58` = **1 文件**（`web/src/components/detail/DetailDrawer.vue`）。

## 8. 证据 / 产物

| 产物 | 路径 | sha256(前16) |
|---|---|---|
| 回归机检读数（122/122） | `docs/verify/T-20261013-154930-3/evidence/r14-seg3-impl.json` | `79911e1f42161da7` |
| 负向 · D42 | `docs/verify/T-20261013-154930-3/evidence/r14-seg3-adv-d42.json` | `4d358899d1fb04ec` |
| 负向 · B22 | `docs/verify/T-20261013-154930-3/evidence/r14-seg3-adv-b22.json` | `c30e36953632a6d3` |
| 负向 · B23 | `docs/verify/T-20261013-154930-3/evidence/r14-seg3-adv-b23.json` | `3fef05df7b4a494e` |
| D42 几何（修复后） | `docs/verify/T-20261013-154930-3/evidence/probe-d42-seg3.json` | `72f384705811f780` |
| D42 几何（变异） | `docs/verify/T-20261013-154930-3/evidence/probe-d42-mut.json` | `671504e9b30fcfa2` |
| harness（同步口径后） | `docs/verify/T-20261013-154930-3/verify-r14-impl.mjs` | `108789cd3bd7b0b5` |
| 构建产物 | `web/dist/assets/index-*.js` | `acf8d28d9968fd2a` |

harness 同步点（仅限 `docs/verify/<本卡>/` 自有文件）：① `readOpen.overlayShell` 增瞬时令牌探针 `scrimTokenResolved`（随读随删）；② `A4`/`A6e` 改「原型腿 · N/A」（实现读数仅登记）；③ `B22` 改 token 口径（涂出色 == `var(--brand-scrim)` 解析值且 alpha≈0.32，不再跨侧字面量相等）；④ `C2` 改「只记归属 · 不计 verdict」；⑤ `B23` 期望 `zh-CN`→`zh`（镜像各侧自己的 locale id）。

## 9. Commit

- branch：**`lane/T-20261013-154930-3-seg3`**
- HEAD（SUT）：**`e40aa5898f453d61cdd5d7629772d847ad6dbc18`**（= 被验对象，未改）
- 本卡提交：**见下「提交状态」**（提交仅含 `docs/verify/T-20261013-154930-3/**` 与 `verification/T-20261013-154930-3/report.md`，显式路径）。

### 提交状态

**EPERM · 本卡未能提交**（与 seg2 同因）。沙箱 `git-common-dir` = `/Users/tanyu/Documents/meerkat-taskpanel/.git` **在可写根之外**；`git add` 即被拒：

```
$ git add docs/verify/T-20261013-154930-3 verification/T-20261013-154930-3
fatal: Unable to create '…/meerkat-taskpanel/.git/worktrees/…-seg3/index.lock': Operation not permitted   (exit 128)
```

**待提交路径清单（显式，供集成段 `git add`）**：

- `docs/verify/T-20261013-154930-3/verify-r14-impl.mjs`（口径同步后）
- `docs/verify/T-20261013-154930-3/fixture.mjs`、`docs/verify/T-20261013-154930-3/probe-d42-geometry.mjs`
- `docs/verify/T-20261013-154930-3/evidence/r14-seg3-impl.json`
- `docs/verify/T-20261013-154930-3/evidence/r14-seg3-adv-d42.json`
- `docs/verify/T-20261013-154930-3/evidence/r14-seg3-adv-b22.json`
- `docs/verify/T-20261013-154930-3/evidence/r14-seg3-adv-b23.json`
- `docs/verify/T-20261013-154930-3/evidence/probe-d42-seg3.json`
- `docs/verify/T-20261013-154930-3/evidence/probe-d42-mut.json`
- `verification/T-20261013-154930-3/report.md`（本报告）

（`web/dist`、`web/node_modules` 被 `.gitignore` 覆盖，不入库；`.git` 越权 ⇒ 无本卡 commit sha 可报。SUT sha `e40aa58` 不受影响。）

## 10. Reconcile / Leftovers

- 只读约束遵守：SUT 实现（`web/**`、`design/**`、`src/**`、`server/**`、`test/**`）**零改**；写面仅本卡 `docs/verify/**` + `verification/**` + `/tmp/**` + 本 lane worktree 构建产物（`web/dist`、符号链 `web/node_modules`，均被 `.gitignore` 覆盖）。
- 未验证项（诚实登记）：① 原型腿 `verify-r14.mjs` 未在本沙箱复跑（`listen EPERM`），no-JS/模板源引用契约卡存档；② 未做像素级截图对比（本轮 computed/DOM 级判真）；③ 六枚自创钩子中 `data-activity-*` 仅「存在性+计数」（N4）；④ B22 的 dark 侧同值由 B22b 覆盖，light 绝对值按 `DF-1` 允许与原型不同。
