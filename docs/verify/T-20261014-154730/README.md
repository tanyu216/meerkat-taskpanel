# T-20261014-154730 · R14 I-1/I-2 —— 关闭按钮盒径 32×32 与焦点环对齐原型

> 上一腿（`T-20261014-150729`，本目录的邻居）五宽度对照出图 37 张，几何/布局全一致，
> 但登记了两处**合同背书的偏差**：I-1 关闭按钮盒径（契约写 `32×32 .td-iconbtn`，实现
> 实测 `16×16`）、I-2 焦点环（原型 2px 品牌青，实现 UA 蓝 1px）。本卡修这两处，
> 并把它们从 **selector 级**升到 **computed 盒径 / 焦点环级** 入门禁。

## 结论

**两处偏差均已消除：`[data-detail-close]` 的 computed 盒径与原型逐值相同，焦点环逐值相同，
`drawer-head` 高度回到原型的 78.59px；两处各有 computed 级断言入门禁，且负数自证变红。**

- **I-1** 关闭按钮：`16×16 / block / 0 边框 / 0 圆角 / ink-3` → **`32×32 / flex / 1px transparent / 6px / ink-2`**，
  与原型**逐值相等**（含 `rectWidth/rectHeight`、`alignItems/justifyContent`、`flex`）。
  连带 `drawer-head` `67` → `81` → **`78.59`**（原型 `78.59`）。
- **I-2** 焦点环：`1px auto rgb(0, 95, 204) · offset 0 · halo none` →
  **`2px solid rgb(15, 122, 115) · offset 2px · halo rgba(15, 122, 115, 0.35) 0 0 0 4px`**，
  与原型**逐值相等**。
- ② 的 head 差里有一半不在按钮上：标题 `[data-detail-title]` 只写了字号（16px）而把**行高
  留给继承**（body 的 1.5 ⇒ 24px），设计 `--text-lg` 是 `16px / 1.35` 的**一对**。补上
  `--leading-title` 后 head = `32 + 21.59 + 25 = 78.59`，与原型等值。这一条是修 ① 时**新发现**
  的（上一腿只测到按钮盒径，没测 head 的两个子元素）。

## 交付坐标

| 项 | 值 |
|---|---|
| 卡 | `T-20261014-154730` |
| 被验仓 | lane worktree `…-wt-T-20261014-154730-seg1`，branch `lane/T-20261014-154730-seg1`（基 `7cb8e42`，先并入依赖 lane `96ae580`） |
| 实现修复 | `web/src/components/detail/DetailDrawer.vue`（①）、`web/src/styles/app.css`（②） |
| 防回归断言 | `web/scripts/dom-smoke.mjs` 的 **R14 (drawer)** 段（既有 R14 断言位） |
| 两侧读数器 | `probe-close-focus.mjs`（**同一个函数**读原型与实现，避免读数差异来自探针） |
| 实现腿载体 | 本 worktree 的 `web/dist`，经 Playwright route interception（`docs/verify/T-20261014-125122/fixture.mjs`）；**不是** `:9527` 上别的 lane 的构建 |
| 原型腿载体 | `design/prototype/index.html`，经临时 loopback 静态载体 |

### 两侧构建的身份（`evidence/probe-*.json` → `distAssets`）

| 轮次 | `assets/index-*.js` | `assets/index-*.css` |
|---|---|---|
| before（未修） | `2PH8KyYB` · sha256:16 `8c600ba1f3bbd8d5` | `DC60oicY` · `81539880ba430f6b` |
| after（本卡） | `D6-f3mPs` · sha256:16 `795880e663862716` | `OQOGJCz4` · `4630af1bdca1e1fd` |

## 1. 逐值读数（before → after，两侧同一探针）

| 量 | 原型 | 实现 before | 实现 after |
|---|---|---|---|
| `[data-detail-close]` rect | `32×32` | `16×16` | **`32×32`** ✅ |
| computed `width`/`height` | `32px/32px` | `16px/16px` | **`32px/32px`** ✅ |
| `display` | `flex` | `block` | **`flex`** ✅ |
| `border` | `1px solid rgba(0,0,0,0)` | `0px solid rgb(126,138,145)` | **`1px solid rgba(0,0,0,0)`** ✅ |
| `border-radius` | `6px` | `0px` | **`6px`** ✅ |
| `color` | `rgb(74, 85, 94)` | `rgb(126, 138, 145)` | **`rgb(74, 85, 94)`** ✅ |
| `align-items`/`justify-content` | `center/center` | `normal/normal` | **`center/center`** ✅ |
| `flex` | `0 0 auto` | `0 0 auto` | `0 0 auto` |
| 图标 `svg` | `16×16` | `16×16` | `16×16`（**盒变大、图标不变**） |
| **`.td-drawer-head` 高** | **`78.59`** | `67` | **`78.59`** ✅ |
| ├ 行（id/chip/close） | `32` | `18` | **`32`** ✅ |
| └ `[data-detail-title]` | `16px/21.6px → 21.59` | `16px/24px → 24` | **`16px/21.6px → 21.59`** ✅ |
| 焦点 `outline` | `2px solid rgb(15, 122, 115)` | `1px auto rgb(0, 95, 204)` | **`2px solid rgb(15, 122, 115)`** ✅ |
| `outline-offset` | `2px` | `0px` | **`2px`** ✅ |
| `box-shadow` | `rgba(15, 122, 115, 0.35) 0px 0px 0px 4px` | `none` | **`rgba(15, 122, 115, 0.35) 0px 0px 0px 4px`** ✅ |
| `matches(":focus-visible")` | `true` | `true` | `true` |

`before` 行的原型侧与上一腿 `docs/verify/T-20261014-150729/evidence.json` 的
`readings.focus.proto` / `readings.impl.w1512.head.close` 一致（`32×32` vs `16×16`，
`2px solid` vs `1px auto rgb(0, 95, 204)`），即两套独立载体读同一对数字。

## 2. 防回归断言（③）

落在 `web/scripts/dom-smoke.mjs` 的 **R14 (drawer)** 段；失败进 `report.r14.failures`，
`process.exit(1)`。**不新增、不改动 `test/web/blocks.contract.mjs` 的契约条目**，
所以 `shot-compare.mjs` 报的规则数与 ui-align manifest 全不受影响。

| 断言 | 判据 |
|---|---|
| 盒径 · computed | `width==="32px" && height==="32px"` |
| 盒径 · rect | `rectWidth===32 && rectHeight===32`（读数对与矩形必须一致） |
| 盒径 · 居中 | `display==="flex" && alignItems==="center" && justifyContent==="center"` |
| 盒径 · 边 | `1px / solid / rgba(0, 0, 0, 0)` |
| 盒径 · 圆角 | `borderRadius==="6px"`（`--radius-field` = 设计 `--r-md`） |
| 图标 | `svg.td-icon` 仍 `16×16`——盒变大**不等于**图标变大 |
| head | `|headHeight − 78.59| ≤ 1`（原型实测值） |
| 焦点环 · 前置 | `matches(":focus-visible") === true`——否则读到的可能是 UA 环 |
| 焦点环 · outline | `2px / solid / rgb(15, 122, 115)` |
| 焦点环 · offset | `2px` |
| 焦点环 · halo | `rgba(15, 122, 115, 0.35) 0px 0px 0px 4px` |

**关于 `:focus-visible` 的模态**：抽屉是被**指针点击**打开的（`page.click("[data-card]")`），
指针交互之后 Chromium 正确地不再对 script-focus 的按钮匹配 `:focus-visible`。设计画的环
是**键盘**那一面，所以探针先按一次 `Tab` 建立键盘模态、再聚焦按钮，并把
`matches(":focus-visible")` 作为**前置条件**断言——不成立就报错，而不是把 UA 的环当成设计的环。

## 3. 负数自证（③ 的后半）

`evidence/mutations.json`；三次改动均**只动实现**，每次重建 `web/dist` 后跑同一支 dom-smoke：

| 变异 | 改法 | 退出码 | R14 变红条数 | 首条失败 |
|---|---|---|---|---|
| **M1** | I-1 回退：关闭按钮换回原来的四条 utility（`16×16`、无边、无圆角） | **1** | **6** | `computes 16px×16px, expected 32px×32px`；head `64.59px, expected 78.59px ±1` |
| **M2** | I-2 **只换颜色**：环规则留着，颜色由 `--brand-accent` 换成 `--brand-text-3` | **1** | **1** | `focus outline is 2px solid rgb(126, 138, 145), expected 2px solid rgb(15, 122, 115)` |
| **M3** | I-2 规则**整块删除**（= 修前状态：作者零规则） | **1** | **3** | `1px auto rgb(0, 95, 204), expected 2px solid rgb(15, 122, 115)`（与上一腿实测的修前值逐字相同） |
| **还原** | `git checkout --` 后重建 | **0** | 0 | `R14 (drawer) — … box computes 32px×32px … head at 78.59375px … focus ring is 2px solid rgb(15, 122, 115)` |

M2 只红 1 条正说明这条断言**只对颜色敏感**；M3 红 3 条说明规则整体消失时三条都咬得住；
M1 红 6 条把盒径、rect、居中、边、圆角、head 一起咬住。

## 4. 文件清单

| 文件 | 说明 |
|---|---|
| `probe-close-focus.mjs` | 两侧读数器；`node … --dist web/dist [--out f.json] [--label name]` |
| `evidence/probe-before.json` | 修前读数（构建 `2PH8KyYB`/`DC60oicY`） |
| `evidence/probe-after.json` | 修后读数（构建 `D6-f3mPs`/`OQOGJCz4`） |
| `evidence/mutations.json` | 三次变异 + 还原的退出码与失败断言原文 |
| `evidence/domsmoke-{before,after}.log` | 门禁全文（before 那次跑的是**旧**断言集，故只有 after 含新条目） |
| `evidence/mut-M{1,2,3}.log` | 三次变异的门禁全文 |

## 5. 登记（本卡未改，供裁定）

1. **契约行 `design/fidelity-r14.md` 未改。** 该文件 §4 R14-B08 的判词仍是
   「**无需改（匹配项）**」，§3 的 `关闭按钮盒 32×32 .td-iconbtn` 才是被本卡执行的那一行。
   卡面 ④ 写明「实现/契约零改（除①②）」，故本卡不动契约；**R14-B08 的 selector 级判词已被
   本卡取代**，建议由契约侧在下一轮标注。
2. **`docs/verify/T-20261014-150729/**` 是纯路径搬迁（41/41 blob 逐字节相同，`R100`）。**
   其 `README.md` / `capture.mjs` 里仍写着 `design/verify/T-20261014-150729/…` 的用法示例——
   该目录 README 自己已写明「若家族以 `docs/verify/` 为准，本目录可整目录平移，**无需改内容**」，
   故按纯搬迁处理，未动其中一字。若裁定要求路径自洽，是一处独立的后续小改。
3. **上一腿 README §4 的 10 行差异读数里，本卡只处理 I-1/I-2 两条。** 其余（刻度/文本形制）
   未在本卡范围内。
