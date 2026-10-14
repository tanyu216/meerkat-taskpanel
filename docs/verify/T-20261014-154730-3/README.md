# T-20261014-154730-3 · R14 I-1/I-2 修复后的视觉**复认**（close/focus 复拍 + 五宽度复认）

> 本卡是从属卡：`T-20261014-154730`（I-1/I-2 修复）的**修复后**复核腿，也是 R14 epic 收尾的 Elon 终看腿。
> 上一轮视觉腿 `T-20261014-150729` 已出**修复前**全量图（37 图）；本卡只补「修复后」的复拍与复认，并顺带把 `design/fidelity-r14.md §4 R14-B08` 的判词补注。

## 结论

**① I-1/I-2 两处已从「差异」转为「一致」——双侧 computed 逐值相等，不止 selector 级。**

- `[data-detail-close]`：computed **`32×32`**、`display:flex`、`border 1px`、`border-radius 6px`、`rgb(74,85,94)`、图标 `16×16`；修正前实现腿为 `16×16` / `block` / `border 0` / `radius 0` / `rgb(126,138,145)`。
- 焦点环：**`2px solid rgb(15,122,115)` + `outline-offset 2px` + halo `rgba(15,122,115,0.35) 0 0 0 4px`**，双侧逐值相等；修正前实现腿为 UA 默认 `1px auto rgb(0,95,204)` 且无 halo。
- `.td-drawer-head` 高 **`78.59`**（双侧相等；修正前实现腿 `67`）；标题 `[data-detail-title]` 行高 **`21.6px`**（= 设计 `--text-lg` 配对 `1.35`；修正前实现腿 `24px`）。

**② 五宽度（1512/1240/980/760/430）无**结构**新偏差**：抽屉盒 `x/w/h` 双侧逐值相等、五档均无横向溢出、七块全 `visible`；抽屉头（`x/w/h`）**五档双侧相等**。
**但有 1 条「可见位移」的新后果必须登记**（不是新缺陷，是旧差被暴露）：见 §4-①。

**③ 契约标注已落** `design/fidelity-r14.md`（§3 关闭按钮盒行、§4.1 R14-B08 行、§4.2 R14-B08 行）；`test/web/blocks.contract.mjs` **未动**。

**本卡只出证据与读数，不代替 Elon 判 verdict。**

## 交付坐标

| 项 | 值 |
|---|---|
| 卡 | `T-20261014-154730-3` |
| lane | branch `lane/T-20261014-154730-3-seg1`（worktree `…-wt-T-20261014-154730-3-seg1`） |
| 起手 | `git merge --ff-only lane/T-20261014-154730-seg1` → HEAD `a2e644b`（修复 lane 顶端） |
| 修复提交 | `57f487f`（`T-20261014-154730`：`DetailDrawer.vue` close=`.td-iconbtn`、`app.css` 全局 `:focus-visible` base 层、`dom-smoke.mjs` computed 级断言） |
| 实现腿载体 | **本 lane 自建 `web/dist`**（`npm --prefix web ci` + `npm --prefix web run build`），并经 loopback 静态服务喂给浏览器 |
| 实现腿身份 | `assets/index-D6-f3mPs.js` **sha256:795880e663862716** · `assets/index-OQOGJCz4.css` **sha256:4630af1bdca1e1fd** · `index.html` **sha256:b6999676a800cf9d** —— 与修复 lane 现成构建**逐字节相同**（`evidence/build-identity.json`） |
| 原型腿载体 | throwaway loopback 静态服务 over `design/`（与 `150729` / `probe-close-focus.mjs` 同一载体） |
| 原型 oracle 固定 | `index.html` `7a1aaeaca792c0fa` · `app.js` `da5ff4b27ab7a987` · `tw.css` `e8d80ae7fe80b50e`（`git status -- design/` 只列本卡的 `fidelity-r14.md`） |
| 写面 | 本目录 + `design/fidelity-r14.md`（§4 R14-B08 行注）。`web/**`、`test/**`、`src/**` **零改** |
| 生成 | `evidence/capture.json` → `generated_at`；`evidence/verdict.json` → `generated_at` |

## 怎么读（判据 ↔ 读数）

| 判据 | 载体 | 结论 |
|---|---|---|
| ①-a close 盒 computed `32×32` / `radius 6px` / `display:flex`，两侧同值 | `probe-close-focus.mjs`（复用，未改）+ `b-close-*-closeup.png` | **一致**（附 `border 1px`、`rgb(74,85,94)`、图标 `16×16` 亦同值） |
| ①-b 焦点环 = 原型口径（品牌青 2px），两侧特写肉眼同观感 | 同上 + `b-focus-*-closeup.png` + `b-head-side-by-side.png` | **一致**（含 `offset 2px` 与 `4px` halo；两张特写用**同一视口裁剪框**） |
| ①-c `.td-drawer-head` 高 `78.59`；标题行高 `1.35` 生效 | 同上 | **一致**（`78.59` / `21.6px`，双侧） |
| ② 五宽度：抽屉盒 `x/w` 两侧一致、无横向溢出、七块全可见 | `capture.mjs` 组 A（`evidence/capture.json`） | **一致**；见 §4-① 的位移登记 |
| ③ 与 `150729` 差异读数逐条复核 | `compare.mjs` → `evidence/verdict.json` | I-1/I-2 **转为一致**；其余 7 条**不变**（详见 §5） |

## 1. 证据清单

**B · close/focus 特写（本卡新增；Elon 终看重点）**

| 文件 | sha256:16 | 内容 |
|---|---|---|
| `shots/b-close-proto-closeup.png` | `8264f0b396b7f25b` | 原型 · 抽屉头右端 · close **未落焦**面 |
| `shots/b-close-impl-closeup.png` | `cb412987ae64b065` | 实现（修复后）· **同一裁剪框** |
| `shots/b-focus-proto-closeup.png` | `aa24348fa4811396` | 原型 · **同一裁剪框** · 焦点落在 `[data-detail-close]` |
| `shots/b-focus-impl-closeup.png` | `f149878c4d015656` | 实现（修复后）· **同一裁剪框** · 同上 |
| `shots/b-head-side-by-side.png` | `e648b75f00d3a3f4` | 两张落焦特写并排（同裁剪框 ⇒ 可逐像素肉眼比对） |
| `shots/b-ring-side-by-side.png` | `8f586970fb617198` | 同上，并在每张下方印出该侧 computed 焦点环 |

> **裁剪框**：视口坐标 `x = 1512−460 = 1052`、`y = 0`、`460×120` —— 两侧**同尺寸同位移**，且以**视口**为基准（不是元素相对盒），故位移/尺寸差异不会被裁掉。见 `evidence/closeups.json` → `clip`。

**A · 五宽度复认（TD-128 · agent · en · 抽屉开；高 900）**

| 宽度 | proto | impl | side-by-side |
|---|---|---|---|
| 1512 | `894a63581482733d` | `b808ea71a0b45035` | `8a500aaa391de84f` |
| 1240 | `faad40ce5392d0c9` | `2be851fa03626ded` | `1afe366618b6f88d` |
| 980 | `bb4e1bbddbebcbee` | `387699b1a3862e10` | `c08396a5e092641c` |
| 760 | `30fcafe11cbe7933` | `11d3ce04dbe00ae2` | `53f3f2c7ab8dc47d` |
| 430 | `7f41910cfcbdab43` | `c48c7f8ac8841403` | `b2365cc05c1e71c2` |

> `a-w430-proto.png` 与 `150729` 同名文件的 sha256:16 **逐字节相同**（`7f41910cfcbdab43`），是「同一 oracle + 同一载体」的可复现性旁证；`d-focus-proto.png`（`cbc7dd9598aba9ea`）同。

**C/D · 附带复跑（非本卡判据，用于「无附带损伤」）**

| 文件 | sha256:16 | 说明 |
|---|---|---|
| `shots/b-human-*-…png`（3） | 见 `evidence/capture.json` → `shots` | 三态 human（`304624adcb279fdc` / `ee6228901a9062f1` / `3ec4a69e49098413`） |
| `shots/b-zh-*-…png`（3） | 同上 | 三态 zh（`ffd643dd543f7b2e` / `4cf16bf28ee1c035` / `fde53e955edc9960`） |
| `shots/b-empty-*-…png`（3） | 同上 | 三态 empty（`c7ce143f8d0edd03` / `3f2f012a893aed68` / `3e3f50bb92177e14`） |
| `shots/c-js-off-*.png`（3） | `b176283cf6673d30` / `dc8c52ed5c9ef503` / `d60f7397e3ff5934` | JS-off 结构对（与 `150729` **同哈希**，双侧均未动） |
| `shots/d-focus-*.png`、`d-scroll-*.png` | 见 `evidence/capture.json` | 交互帧（`d-focus-impl.png` `08e0d92e0327e383`：修复后焦点环已换） |

**机检读数（JSON）**

| 文件 | 内容 |
|---|---|
| `evidence/build-identity.json` | 实现腿身份 + 与修复 lane 构建的逐字节比对 + 原型 oracle 哈希 |
| `evidence/capture.json` | 组 A/B/C/D/E 的全量读数（35 图 + `readings`），载体自吐响应体哈希见 `readings.servedBuild` |
| `evidence/close-focus.json` | 复用探针 `probe-close-focus.mjs` 的输出（computed 长手 + 焦点面，双侧同一函数） |
| `evidence/closeups.json` | 特写探针 `probe-closeups.mjs` 的输出（裁剪框、close 盒几何、焦点面、**附带焦点面**） |
| `evidence/verdict.json` | 本卡判据的**机器判定**（`compare.mjs` 产出；含与 `150729` 的逐叶位移清单） |

## 2. 判据① 读数（close / focus，双侧）

**`[data-detail-close]` 盒（computed 长手；`probe-close-focus.mjs`）**

| 读数 | 原型 | 实现（修复后） | 实现（修复前，`150729`） |
|---|---|---|---|
| computed `width × height` | `32px × 32px` | `32px × 32px` | `16px × 16px` |
| rect | `32 × 32` | `32 × 32` | `16 × 16` |
| `display` | `flex` | `flex` | `block` |
| `border` | `1px`（`transparent`） | `1px`（`transparent`） | `0px` |
| `border-radius` | `6px` | `6px` | `0px` |
| `color` | `rgb(74, 85, 94)` | `rgb(74, 85, 94)` | `rgb(126, 138, 145)` |
| 图标 `svg` | `16 × 16` | `16 × 16` | `16 × 16` |
| 实现侧 class | — | `td-iconbtn ml-auto` | `ml-auto shrink-0 border-0 bg-transparent text-(--brand-text-3) cursor-pointer` |

**焦点面（`:focus-visible`，键盘 modality 由真实 `Tab` 建立后落焦）**

| 读数 | 原型 | 实现（修复后） | 实现（修复前） |
|---|---|---|---|
| `matches(":focus-visible")` | `true` | `true` | `true`（但无规则命中） |
| `outline` | `2px solid rgb(15, 122, 115)` | `2px solid rgb(15, 122, 115)` | `1px auto rgb(0, 95, 204)` |
| `outline-offset` | `2px` | `2px` | — |
| `box-shadow` | `rgba(15, 122, 115, 0.35) 0px 0px 0px 4px` | 同左 | `none` |

**头部盒**

| 读数 | 原型 | 实现（修复后） | 实现（修复前） |
|---|---|---|---|
| `.td-drawer-head` 高 | `78.59` | `78.59` | `67` |
| `[data-detail-title]` 行高 | `21.6px` | `21.6px` | `24px` |
| head 内层行（identifier/chip/close）高 | `32` | `32` | `16` |

> 判据①的三条**全部达成**：`compare.mjs` 的 `closeFocus.equalOn` 十项布尔（computed 盒、rect、display、border、radius、color、图标、head 高、标题行高、焦点环）全 `true`。

**附带焦点面（I-2 是**全局** base 层规则，故必须问「有没有越界」）**

| 座位 | 原型 | 实现（修复后） | 相等 |
|---|---|---|---|
| `[data-comment-input]` | `outline: 3px none` + halo `3px`（设计自己的 `.td-textarea:focus` 未分层规则胜出） | 同左 | ✅ |
| `[data-detail-close]` | `2px solid rgb(15,122,115)` + `2px` offset + `4px` halo | 同左 | ✅ |
| `[data-detail-id-copy]` | 同上 | 同左 | ✅ |

> 即：全局环**没有**压过设计自己的未分层规则（`@layer base` 的默认性按设计生效）。**未复核**：逐个可聚焦控件的键盘 Tab 环（本卡只读这三处 + `dom-smoke.mjs` 的实现侧断言）。

## 3. 判据② 五宽度读数

**抽屉盒 / 页面溢出 / 头部**

| 宽度 | 原型 `x/w/h` | 实现 `x/w/h` | `scrollWidth ÷ clientWidth`（P / I） | head `x/w/h`（P / I） |
|---|---|---|---|---|
| 1512 | `992 / 520 / 900` | `992 / 520 / 900` | `1512 ÷ 1512` / `1512 ÷ 1512` | `993 / 519 / 78.6` 双侧 |
| 1240 | `720 / 520 / 900` | `720 / 520 / 900` | `1240 ÷ 1240` 双侧 | `721 / 519 / 78.6` 双侧 |
| 980 | `460 / 520 / 900` | `460 / 520 / 900` | `980 ÷ 980` 双侧 | `461 / 519 / 78.6` 双侧 |
| 760 | `240 / 520 / 900` | `240 / 520 / 900` | `760 ÷ 760` 双侧 | `241 / 519 / 78.6` 双侧 |
| 430 | `0 / 430 / 900` | `0 / 430 / 900` | `430 ÷ 430` 双侧 | `1 / 429 / 78.6` 双侧 |

> 五档 `x/w/h` 与 head 盒 **双侧逐值相等**；无横向溢出（`scrollWidth == clientWidth`）。
> **修复前** head 盒为 `519 × 67`（实现），即 head 差被修复前是**可见**的。

**七块（`box` 的 `x/y/w/h`，`visible` 全 `true`）**

| 块 | 原型 @1512 | 实现 @1512 | Δw / Δh | 实现 @430 | 原型 @430 |
|---|---|---|---|---|---|
| 属性栅格 `[data-detail-props]` | `1013,136.1 479×270` | `1013,136.1 479×280.5` | `0 / +10.5` | `21,136.1 389×280.5` | `21,136.1 389×270` |
| 描述 `[data-detail-description]` | `1013,463.6 479×303.5` | `1013,474.1 479×303.5` | `0 / 0` | `21,474.1 389×323` | `21,463.6 389×323` |
| 关系 `[data-detail-relations]` | `1013,824.6 479×24` | `1013,835.1 479×24` | `0 / 0` | `21,854.6 389×24` | `21,844.1 389×24` |
| 附件 `[data-detail-attachments]` | `1013,1035.6 479×72` | `1013,1048.1 479×72` | `0 / 0` | `21,1067.6 389×72` | `21,1055.1 389×72` |
| 评论 `[data-detail-comments]` | `1013,1165.1 479×221` | `1013,1177.6 479×338` | `0 / +117` | `21,1197.1 389×338` | `21,1184.6 389×221` |
| 活动 `[data-detail-activity]` | `1013,1556.6 479×98` | `1013,1573.1 479×98` | `0 / 0` | `21,1592.6 389×98` | `21,1576.1 389×98` |
| 会话 `[data-detail-agent-session]` | `1013,864.6 479×129.5` | `1013,875.1 479×131.5` | `0 / +2` | `21,894.6 389×131.5` | `21,884.1 389×129.5` |

> 五宽度的块**宽**逐值相等（`479` / `389`），**七块全部 `visible`**，两侧**无「实现缺块」**。
> 纵坐标的 `+10.5` 位移见下条。

**实现侧自 `150729` 起的全部位移（`verdict.json` → `fiveWidths[].implMovedSince150729`，五档各 19 条叶）**

- `head.close.{x,y,w,h,display}`、`focus.{outline,boxShadow}`：**I-1/I-2 的预期后果**。
- `body.clientHeight 833 → 821`：抽屉头长高 `11.6`，滚动宿主相应变矮。
- `blocks.*.box.y`（6 处）与 `attachments.rows.*.{box,icon}.y`（4 处）：**统一 `+11.6`**，是上一条的位移；`blocks.props.box.y 124.5 → 136.1` 则与原型**对齐**。
- 原型侧同五档：**0 条位移**（`protoMovedSince150729` 全空）——oracle 与载体稳定。

## 4. 登记项（逐条读数；不藏）

**① `[data-detail-props]` 块高 `+10.5`，及其**下游位移**（**新后果，非新缺陷**）**

- 读数：`[data-detail-props]` 原型 `479×270` / 实现 `479×280.5`（Δ`+10.5`）；块内三处座位读数不同 ——
  `[data-detail-assignee]` `383×28` vs `383×31.5`、`[data-detail-reporter]` `383×28` vs `383×31.5`、`[data-detail-label-input]` `369×24`(padding `0px 6px`, r`4px`) vs `369×29.5`(padding `4px 8px`, r`6px`)。
- 与 `150729` 的关系：该块高差在 `150729` 的**块表**里已登记（属性栅格 Δ`+11`），**不是本卡新出现**；但**可见后果变了** ——
  修复前实现侧 head 矮 `11.6`，把这条 `+10.5` 抵消掉了（`description` 纵差仅 `−1.1`）；修复后 head 对齐，于是**属性栅格以下的六块整体比原型低 `10.5`**（`150729` 时是 `−1.1`）。
- 判读：**几何一致性因此比修复前更「诚实」**（错误不再互相掩盖），但**下游 `10.5px` 位移是新出现的可见差**，应转给 `T-20261014-154730` 之后的实现卡处置（本卡只登记，不做设计判断）。
- **未复核**：`+10.5` 在块内的逐行分解（三处读数之和 `+12.5` 与块高 `+10.5` 不等，未拆到行盒）。

**② `[data-detail-close]` 的 `margin-left` 有 `0.7~1.1px` 残差**

- `150729`：`350.578` vs `335.297`（Δ`15.28`，即 `32−16` 的盒径差）。
- 本卡：原型 `335.297` / 实现 `334.578`（Δ`0.719`）；`closeup` 探针同 run 内的 `head.close` 盒则**完全相等**（`x1464 / y12 / 32×32 / right1496`）。
- 判读：`ml-auto` 把按钮推到行尾，残差来自同行左侧内容（identifier + chip）的**文本度量**；`closeup` 的 rect 相等说明盒本身已齐。**登记，不判红**（`<=1.2px`，且与 I-1/I-2 无关）。

**③ `[data-detail-identifier]` 行高 / 盒高（`150729` 的**编号表**未登记，但同源 `seatCompare` 里已存在，本卡未变）**

- 原型 `42.6×18`、`line-height 18px`；实现 `43.4×16`、`line-height 16px`。
- 该差**不在** `150729` §4 的 10 条编号表内（其 §2 的逐块表也未列），本卡从 `seatCompare` 读出后登记；**与 I-1/I-2 无关**（`verdict.json` 的 `implSeatCompareMoved` 不含该座位 ⇒ 修复前后同值）。
- 同族的 `[data-detail-props]` `270` vs `280.5`、`[data-detail-assignee]`/`[data-detail-reporter]` `28` vs `31.5`、`[data-detail-agent-session]` `129.5` vs `131.5` 亦然 —— 均为**修复前就存在、`150729` 未编号登记**的读数，本卡一并列出（见 §5 表下的 `seatCompare` 清单）。

**④ 遮罩涂出色（`DF-1`，token 口径，未变）**

- 原型 `rgba(15, 20, 23, 0.32)`；实现 `oklab(0.276439 … / 0.32)`；两侧 `opacity 1`、全屏 `1512×900`、`data-state=open`。同色、同 alpha ⇒ **不是差**。

## 5. 与 `150729` 差异读数的逐条复核（判据③）

`compare.mjs` 的判定：`seatCompare` 自 `150729` 起**原型侧 0 条位移**、**实现侧 16 条叶位移**，全部属于 I-1/I-2（`.td-drawer-head` 高、`[data-detail-title]` 行高、`[data-detail-close]` 的盒/边框/圆角/色/环/display/margin）。

| # | 座位（`150729` §4 原编号） | `150729` 读数 | 本卡读数 | 判定 |
|---|---|---|---|---|
| 2 | 关闭按钮盒 `[data-detail-close]` | `16×16` vs `32×32` | **`32×32` vs `32×32`** | **差异 → 一致** |
| 3 | 焦点环 | `1px auto rgb(0,95,204)` vs `2px solid rgb(15,122,115)` | **两侧 `2px solid rgb(15,122,115)` + offset 2px + halo 4px** | **差异 → 一致** |
| 7 | 抽屉头高 `.td-drawer-head` | `78.6` vs `67` | **`78.6` vs `78.6`（computed `78.59`）** | **差异 → 一致** |
| 1 | 状态徽文本 | 原型恒 `To Do` / 实现随卡 | 本卡样本 TD-128 为 `todo`，两侧同文案 | **不变**（非 todo 卡不在本卡样本内 ⇒ **未复核**） |
| 4 | 版本座位 `[data-detail-version]` | `v3` vs `3` | `v3` vs `3` | **不变**（原型 mock 口径） |
| 5 | 头像字母 `.td-avatar` | `LI` / `JO` / `TU` vs `L` / `J` / `T` | 同 | **不变** |
| 6 | 平台值 `[data-agent-platform-value]` | `163.4×18` vs `43.4×16` | `163.4×18` vs `43.4×16` | **不变** |
| 8 | 评论块高 `[data-detail-comments]` | `221` vs `338` | `221` vs `338` | **不变**（嵌套口径） |
| 9 | 组合输入刻度 `[data-detail-label-input]` | `24` / `padding 0 6` / r`4` vs `29.5` / `padding 4 8` / r`6` | 同 | **不变** |
| 10 | 遮罩涂出色 | `rgba(15,20,23,.32)` vs `oklab(…)` | 同 | **不变**（`DF-1` token 口径，非差） |

**`seatCompare` 里「修复前后同值」的其余座位差（`150729` 编号表未登记，本卡一并列出，全部**非** I-1/I-2 后果）**

| 座位 | 原型 | 实现 | `150729` → 本卡 |
|---|---|---|---|
| `[data-detail-identifier]` | `42.6×18`，`line-height 18px` | `43.4×16`，`line-height 16px` | 同值（未变） |
| `[data-detail-props]` | `479×270` | `479×280.5` | 同值（`150729` §2 块表记 `+11`） |
| `[data-detail-assignee]` | `383×28` | `383×31.5` | 同值（未变） |
| `[data-detail-reporter]` | `383×28` | `383×31.5` | 同值（未变） |
| `[data-detail-agent-session]` | `479×129.5` | `479×131.5` | 同值（未变） |

> 即：本卡的 16 条实现侧座位位移**全部**落在 `[data-detail-close]` / `[data-detail-title]` / `.td-drawer-head` 三处，其余座位**零位移**。

**三状态腿（附带复跑）**：`b-human` / `b-zh` / `b-empty` 的原型侧自 `150729` **0 条位移**；实现侧位移数与五宽度同源（head `+11.6` 的下游位移 + close 盒 + 焦点环），无新增座位差。`b-zh` 的 `html[lang]` 仍为原型 `zh-CN` / 实现 `zh`（`150729` 已登记的 B23 口径）。`b-human` 的 `[data-detail-agent-session].hidden` 双侧 `true`。

**JS-off 腿（附带复跑）**：三图与 `150729` **同哈希** ⇒ 该腿未受修复影响（修复只动运行时的 class 与一条 base 层规则）。原型 14 钩子 `present 1/1`、`visible 0`；实现 `#app children 0`、`[data-card] 0`。

## 6. 契约标注（`design/fidelity-r14.md`，本卡唯一 `design/**` 改动）

| 位置 | 改动 |
|---|---|
| §3 表「关闭按钮盒」行 | 出处列追注：实现侧自 `T-20261014-154730` 起**直接穿 `.td-iconbtn`**（class = `td-iconbtn ml-auto`），实测 computed `32×32`/`flex`/`1px`/`6px`/`rgb(74,85,94)`，与原型等值 |
| §4.1 `R14-B08` 行 | 实现现状列 class 由 `ml-auto` 订正为 `td-iconbtn ml-auto`；偏差说明列追加「已于 `T-20261014-154730` 修复（盒径 `16×16`→`32×32`、`.td-drawer-head` `67`→`78.59`、标题行高补 `1.35`）；判定升为**盒径/computed 级**」 |
| §4.2 `R14-B08` 行 | 备注列追加：原「无需改」当时只核到 selector 级；盒径义务已由 `T-20261014-154730` 补齐，现 computed 双侧等值 ⇒ 本行结清 |

**同座位口径扫描结论（`150729` 与卡面点名的四处）**

| 座位 | 是否过时 | 处理 |
|---|---|---|
| §3 头部内边距（`.td-drawer-head` `12px 16px 12px 20px`） | 否 —— 修复未动 padding（实测 head padding 双侧 `12/16/12/20`） | 不改 |
| §5 A8（`[data-detail-close]` 与 identifier/chip 同一父元素） | 否 —— 结构断言，盒径变化不影响；本卡实测仍 `true` | 不改 |
| §5 B12（`[data-detail-status-chip]` 高 `18px`/圆角 `999px`/`12px`） | 否 —— 修复未触碰 chip；本卡 `seatCompare` 该座位无位移 | 不改 |
| §4.2 `R14-B08`（同座位「无需改」） | **是** —— 见上表 | 已加注 |

`test/web/blocks.contract.mjs` **一行未动**（另卡 `T-20261014-161018`）。

> 注：`web/**` 与 `test/**` 在本卡零改，`app.css`/`blocks.contract.mjs` 中出现的 `fidelity-r14.md` 字样均为**注释引用**（`grep -n fidelity-r14` 命中 2 处，皆非解析），故本次 `design/` 改动对测试**不可见**。

## 7. 复现

```bash
# 0) 起手：把本 lane 快进到修复 lane 顶端（非破坏）
git merge --ff-only lane/T-20261014-154730-seg1        # → a2e644b

# 1) 自建实现腿（宿主 `~/.npm` 缓存离线；仓内 .vendor 缓存是 linux/arm64）
npm --prefix web ci --prefer-offline --no-audit --no-fund
npm --prefix web run build                             # → index-D6-f3mPs.js / index-OQOGJCz4.css

# 2) 复用探针（computed 盒径 + 焦点环）
node docs/verify/T-20261014-154730/probe-close-focus.mjs \
  --dist web/dist --label postfix \
  --out docs/verify/T-20261014-154730-3/evidence/close-focus.json

# 3) 五宽度 + 三态 + JS-off + 交互（实现腿 = 本 lane 的 dist）
node docs/verify/T-20261014-154730-3/capture.mjs --dist web/dist
node docs/verify/T-20261014-154730-3/capture.mjs --only a,e --dist web/dist   # 只跑某一组

# 4) close/focus 特写（同一视口裁剪框）
node docs/verify/T-20261014-154730-3/probe-closeups.mjs --dist web/dist

# 5) 机器判定（与 150729 逐叶对账）
node docs/verify/T-20261014-154730-3/compare.mjs
```

前置：宿主可解析 Playwright（本 run 用 `~/.nvm/.../node/v24.20.0/lib/node_modules/playwright`）。`pageErrors` 本 run 为 `[]`（`capture` 与 `closeups` 两侧）。

## 8. 未复核 / 已知限制（如实登记）

1. **未跑「真板」腿。** `150729` 的 `live` 组读的是 `:9527` 上那道真板；本卡的实现腿换成**本 lane 自建 dist**（这正是本卡要做的复认），故 `:9527` 那道**修复前**的板一律未读、也未触动（该板由团队持有，本 lane 不占用其端口/数据库）。`capture.mjs` 的 `id` 组改为记录**载体实际吐出的响应体哈希**（`readings.servedBuild`），不再是「真板身份」。
2. **未做与修复 lane 构建的「同 run 双读」**：逐字节比对是在**离线**做的（`evidence/build-identity.json`，三份文件 sha256 全等），不是在浏览器里并排渲染两次。
3. **`150729` §4 第 1 条（状态徽文本）未复核**：本卡样本 TD-128 为 `todo`，两侧文案本就相同；非 todo 卡（原型 `data-i18n` 覆写缺陷）不在本卡样本内。
4. **未复核**：明/暗主题、`hover`/`active`/`disabled` 态；抽屉关闭动画中间帧；Esc 关闭与 Tab 环的完整键盘路径；**逐个可聚焦控件的焦点环**（只读了三处附带焦点面）。
5. **`+10.5` 块高差的逐行分解未做**（见 §4-①）。
6. **本卡不做设计判断**：`+10.5` 是否要改、怎么改，属实现卡/Elon 裁定。

## 9. 目录约定

卡面 `git_rules` 写「写面仅 `docs/verify/<本卡>/**`」，本目录即按此落位（与 `150729` 的 §6 说明一致：家族既有落位是 `docs/verify/<卡>/**` 与 `verification/<卡>/report.md`）。本卡另获 brief 授权改 `design/fidelity-r14.md` 一处（§4 R14-B08 行注，含同座位扫描的三行）。
