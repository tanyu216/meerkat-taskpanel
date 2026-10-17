# UI 保真契约 · R12 补充 — filters 条的单行口径，与 board 七列的等高链

> 卡：`T-20261013-023717`（父 epic 无）· 日期 2026-10-13 · 范围「原型已有、契约未固化」的两处口径。
> 权威 Acceptance：卡 `T-20261013-023717` 的 Comments 里 **Elon 权威 Acceptance**（2026-10-12T18:40:39Z）。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/BLOCKS.md`（B01–B25）。
> 证据口径：度量类**全部是原型在真实浏览器（Chromium headless / CDP）里的实测值**（§1.2、§8）；
> 实现侧本轮**未到场实测**（本 lane 无 `web/node_modules`/`web/dist`，见 §1.2 规则 3、§6 归因列）。
> 关系：**本卡只写规范**——不改原型（除截图基线）、不写实现、不落机检清单（R-6）。实现由修复卡
> `T-20261013-023722` 落，机检清单的 A 腿由同一张卡随修复一起落（先落会把 live 清单转红）。
> 同族前序：R9〔`T-20261012-224743`〕定了 filters 条的**一个控件家族**（`.td-select` / `.td-label-trigger`
> 同度量）；R10〔`T-20261012-230448`〕把 board 视图拆成二态并把等高链写进 `[data-board-view]` 的直通；
> R11〔`T-20261013-014701-2`〕给这条 bar 加了第三个字段控件（状态筛选）。本契约**复用三者的口径，不重新定义**。
> 编号：R12 主契约文件 `design/fidelity-r12.md` 已被**并发卡 `T-20261013-023310`** 占用 ⇒ 本卡产出**补充契约**
> （本文件），R12 写回时可折叠（R-1）。

## 0. 结论摘要

- **两处口径各有唯一的「唯一事实源」**：① B04 的单行与控件度量 —— 方向由 R-2 定（单行、不含 `flex-wrap`），
  度量由原型实测定（§2.2 表）；② B05 的等高 —— 由原型 `align-items:stretch` + 直通链解析得到，**不写死高度**（§3）。
- **原型现状（实测，en + light，六个档位）**：`.td-filters` 是 `flex-wrap: wrap`，**1512/1240/980/760 一行、
  430 折成两行**；`.td-board` 的 `align-items` 已是 `stretch`，**7 列盒高两两差 0px、且每列盒高 == board 内容盒高
  （0px 差）**，视口换高时列高随动（900→700：758px → 558px）。
- **因此本轮的方向是「把原型已有的写成可机检契约」+「给 filters 条一个已批准的方向偏差」**：B05 几乎无需改向
  （原型即目标态）；B04 的**折行**是对原型的**已批准书面偏差**（Elon ②），**度量**（高度/间距/padding/字体/caret）
  仍逐项对齐原型。
- **filters 条的批准口径 = `flex-wrap: nowrap` + 栏内横向滚动溢出策略**（`overflow-x:auto; min-width:0`），
  `[data-filter-count]` 保持 `margin-left:auto`；**文档级零横向溢出**在六档实测成立（原型；实现侧见 §5 A8）。
- **原型控件度量（实测，六档恒定）**：三个字段控件（`.td-select` ×2 + `.td-label-trigger`；R11 后含状态控件共四个）
  盒高 **30px**、`12px`/`400`、圆角 `6px`、`padding: 0 26px 0 8px`、caret `14×14` 绝对定位、
  **距 summary 边框盒右缘 7px**（CSS 声明 `right:6px` 是对**内边距盒**说的，R9-1 的既有修正）；
  `[data-filter-clear]` = `btn-sm` 28px；`[data-filter-count]` 18px；**控件间距 8px**、**栏自身 padding 0**。
- **原型 board 度量（实测）**：`gap: 16px`（`--col-gap`）、`padding-bottom: 4px`（其余三边 0）、
  `overflow-x: auto`（**文档唯一横滚容器**）/`overflow-y: hidden`；`[data-column]` 的 `overflow-y` 是 `visible`，
  **列内唯一纵滚容器是 `[data-column-body]`**（`overflow-y:auto`，七列各一）。
- **实现侧的两条硬伤（实读，E④ 必列）**：`web/src/components/board/Board.vue` 的 `[data-board]` 带 **`items-start`**
  （交叉轴 `flex-start` ⇒ 列取内容高 ⇒ 七列不等高，**与原型 `stretch` 相反**）；
  `web/src/components/board/FiltersBar.vue` 的 `[data-filters]` 带 **`flex-wrap`**（= 原型行为，但**违反 R-2 方向**），
  且**没有**溢出策略（无 `overflow-x`/`min-width`）。逐条见 §6。
- **机检断言四条腿各有唯一天职**（R-6）：A = 清单块（结构/计数）·B = `test/web/blocks.contract.mjs`（可声明的
  computed 规则）·C = `web/.ui-align.json` 的 style targets（双侧 computed）·D = 驱动层
  `web/scripts/dom-smoke.mjs` 的 R12 段（**行数与列高关系只能在这一腿判定**）。**本卡只给规范**（§5、附录）。
- **零增量**：不新增/修改 i18n 键、不新增 token/颜色/图标；**无行号锚**（§8.3）。
- **§⑫ 判定**：本轮**触及约定**（B04/B05 的口径被固化成机检断言）⇒ 同步 `design/BLOCKS.md` §B04/§B05 各一段（§7）。

### 0.1 与 Elon 权威 Acceptance 的逐条对应

| # | Elon ①–⑥ | 落在本文件 | 证据 |
|---|---|---|---|
| E① | 契约写明 B04/B05 口径 + **目标视口**（≥1512×950 与 430 档）+ 逐条可机检断言 | §2、§3、§5；（目标视口 §5.0） | 原型实测六档（§8.1） |
| E② | B04：filters 条**单行（不含 `flex-wrap`；给溢出策略）** + 控件**高度/间距/padding** 与原型逐项对齐（**写期望 computed**） | §2.1（口径）、§2.2（期望值表）、§2.3（溢出策略） | 实测 30px/8px/0/`6px`/caret（§2.2） |
| E③ | B05：`[data-board]` 列容器 `align-items:stretch`，每列高 == board 高且 7 列等高（≤1px） | §3.1（等高链）、§3.2（期望值表） | 实测 spread 0px、delta 0px（§3.2） |
| E④ | 「原型 vs 实现」逐项偏差清单（**含匹配项**），至少覆盖 `Board.vue` 根 `items-start` 与 `FiltersBar` `flex-wrap` | §6（含 8 条 `对齐` 匹配项） | 实读 + 实测双来源 |
| E⑤ | **原型截图基线** + **具名验证法** | 交付物 3（`design/assets/r12/proto-board-*.png`）+ §8 | 五帧 + 命令串（§8.1） |
| E⑥ | **§⑫ 判定** | §7 | — |

---

## 1. 口径与证据规则

### 1.1 口径（闭集，逐字使用）

**偏差分类**（与 `design/fidelity-r11.md` §1 同一张表，不另立）：

| 词 | 含义 |
|---|---|
| `对齐` | 与原型一致（**匹配项**；E④ 要求清单里必须有） |
| `缺` | 原型有、实现无 |
| `简化` | 实现存在但能力被削弱 |
| `自创` | 原型无、实现新增 |
| `口径` | 同意图的**不同表达**（须有书面偏差或既有裁定） |
| `缺失口径` | 两端都没有、本轮首次定义 |

### 1.2 证据规则（三腿归因，逐条标明，R-7）

1. **`实测`** = 真实浏览器测得。命令 + 原始 json 路径随条目给出（本文 `verify/r12-probe.mjs` →
   `verify/proto-measure.json` / `verify/proto-console.json`，**均不进仓**）。
2. **`实读`** = 只读源码（给 `文件:选择器` / 符号）。**不得冒充实测。**
3. **`推断`** = 写推导链（前提 → 结论），并**指定验证卡或修复卡的验证方式**。
4. 「期望值」= 原型在真实浏览器里的**实测值**（`getComputedStyle` / `getBoundingClientRect` / DOM 计数），
   **不是** `src/input.css` 某条声明的字面值；两者不一致时实测值胜（本轮即有一例：caret 的 `right` 声明 6px、实测 7px）。
5. **`auto` 边距不可由 computed style 读回**：`getComputedStyle(el).marginLeft` 对 `margin-left:auto`
   返回的是**已解析的 used 值**（本轮实测 1512 档 = `674.328px`）。因此凡「贴右端」一类断言，
   **判据只能是几何**（盒右缘 == 内容盒右缘），不能写成 `marginLeft === "auto"`。这是 A7 的判据订正（§5 A 组）。
6. **「可见」分两种度量，必须分清**（R9/R10/R11 的同一区分）：`computed display ≠ none` 只对
   **被状态规则直接写入**的元素成立；后代一律用 `getClientRects().length`。本契约另加一条本轮实测出来的边界：
   `.td-sr` 视觉隐藏 `<label>` 是 **1×1 的裁剪盒**，`getClientRects()` **非空** ⇒ 「可见子级」必须
   **显式排除 `.td-sr`**，否则 B04 会把两个隐藏 label 数成控件（F2 的「6 个可见 + 2 个 `.td-sr`」正是这条）。
7. **「一行」的判据是 flex 线的控件中心，不是 `top`**：`align-items:center` 下同一行的控件中心恒等，
   而各自高度不同（30px 的 select 与 28px 的 `btn-sm`）⇒ `top` 天然相差 1px。行数 = 控件
   `rect.top + rect.height/2` 的去重数（容差 1px）。这是 A2/A9 的判据（§5 A 组）。
8. 本轮原型 `console` / `pageerror` **均为 0**（六档全轮，§8.2）。
9. 实现侧本轮**未到场实测**：本 lane 的 worktree 没有 `web/node_modules` 也没有 `web/dist`（二者皆 gitignore），
   `ui-align` 的实现腿以**退出码 2** 结束（§8.1 表）；凡涉及实现的位点一律标 `实读`（§6 归因列）。

### 1.3 定位规则

一律「**文件:选择器**」或「**文件:符号**」，**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

---

## 2. B04 契约 — filters 条（单行 + 溢出策略 + 控制度量）

### 2.1 方向（Elon ②，覆盖「对齐原型折行」的推断）

**口径**：栏恒为**一行**。

| 属性 | 值 | 说明 |
|---|---|---|
| `[data-filters]` `flex-wrap` | **`nowrap`** | 子控件 `flex: 0 0 auto`（不收缩、不换行） |
| `[data-filters]` `flex-direction` | `row` | 与原型同（实测 `row`） |
| `[data-filters]` `align-items` | `center` | 与原型同（实测 `center`） |
| 溢出策略 | `overflow-x: auto` | **栏自身**成为横向滚动容器；窄档超出部分在**栏内**横滚 |
| | `min-width: 0` | 允许在 flex/grid 父里收缩到内容宽以下 |
| `[data-filter-count]` | `margin-left: auto` | 宽档贴栏**内容盒**右缘（判据见 §5 A7） |

**与原型的关系**：原型 `.td-filters` 是 `flex-wrap: wrap`（实测 `wrap`，六档皆是）⇒「不折行」是对原型的
**已批准书面偏差**（Elon 权威验收 ②）。**度量（高度/间距/padding/字体/caret）仍逐项对齐原型**（§2.2）。

**被否决备选（四条，逐条给理由）**：

| 备选 | 为什么不采用 |
|---|---|
| (a) 保留 `flex-wrap: wrap` | 那就是缺陷本身：Terry 报的折行，不该被契约固化成目标态 |
| (b) 让控件收缩（`min-width:0` + `flex-shrink:1`） | 破 30px/12px 同族度量与 caret 位置 —— 四个字段控件会在窄档各缩到不同宽度，看不再是一排控件 |
| (c) 窄档隐藏 `[data-filter-count]` | 丢信息，且引入**第二态**（要额外的机检断言去守「什么时候隐藏」） |
| (d) `nowrap` 但不给 `overflow-x` | 直接制造**文档级横向溢出**，违反五档无溢出门禁（A8） |

### 2.2 期望 computed 值表（原型实测，en + light；六档恒定）

**栏本体** —— `design/prototype/index.html` `section#td-filters[data-filters]`，样式块 `design/prototype/src/input.css` 的 `.td-filters`：

| 属性 | 期望（原型实测） | 备注 |
|---|---|---|
| `display` | `flex` | |
| `flex-direction` | `row` | |
| `flex-wrap` | `wrap`（**原型**）→ 契约 **`nowrap`** | 见 §2.1 |
| `align-items` | `center` | |
| `gap` | `8px` | 六档同值 |
| `min-width` | `0px` | |
| `padding`（四边） | `0px` / `0px` / `0px` / `0px` | **栏自身无内边距**；原型的栏内边距由 `.td-main`（`var(--main-pad-x)`/`-y`）提供 |
| `overflow-x` / `overflow-y` | `visible` / `visible`（**原型**）→ 契约 `overflow-x: auto` | 见 §2.1 |
| 栏盒高（1512 档） | `30px` | = 最高的子控件（无纵向内边距） |
| 可见子级数 | **6**（另 2 个 `.td-sr`） | 见 §1.2 规则 6 |
| 行的中心去重数 | **1**（1512/1240/980/760/1512×950/1512×700）；**2**（430） | 430 的折行 = 已批准偏差的对象（§1.2 规则 7） |

**字段控件家族** —— 三个（R11 后四个）同族控件，六档实测**全部 30px**：

| 选择器 | `height` | `minHeight` | `fontSize` | `fontWeight` | `borderRadius` | `paddingLeft` | `paddingRight` | caret |
|---|---|---|---|---|---|---|---|---|
| `[data-filter-assignee]` | `30px` | `30px` | `12px` | `400` | `6px` | `8px` | `26px` | 背景图 caret，`right 6px center`，`14×14` |
| `[data-filter-priority]` | `30px` | `30px` | `12px` | `400` | `6px` | `8px` | `26px` | 同上 |
| `[data-filter-status] > summary`（= `.td-label-trigger`） | `30px` | `30px` | `12px` | `400` | `6px` | `8px` | `26px` | 内联 `svg.td-icon-sm`：`14×14`、`position:absolute`、**距 summary 边框盒右缘 7px** |
| `[data-filter-label] > summary`（= `.td-label-trigger`） | `30px` | `30px` | `12px` | `400` | `6px` | `8px` | `26px` | 同上 |

**非字段控件**：

| 选择器 | 期望（原型实测） |
|---|---|
| `[data-filter-clear]` | `height` **28px** / `min-height` 28px / `12px` / `500` / `6px` / `padding 12px`（= `btn btn-ghost btn-sm`） |
| `[data-filter-count]` | `height` **18px** / `12px` / `400` / `border-radius 0px` / `padding 0`；`margin-left: auto`（宽档，§1.2 规则 5） |

**间距** —— 相邻**同线**控件的盒间隙（原型实测，六档恒定）：

| 相邻对 | 间隙 |
|---|---|
| `[data-filter-assignee]` → `[data-filter-priority]` | **8px** |
| `[data-filter-priority]` → `[data-filter-status]` | **8px** |
| `[data-filter-status]` → `[data-filter-label]` | **8px** |
| `[data-filter-label]` → `[data-filter-clear]` | **8px** |

> **与 `.td-select` 声明的关系**：`design/prototype/src/input.css` 的 `.td-select` 声明 `height:30px; min-height:30px;
> padding:0 26px 0 8px`，**实测一致**（30/30/8/26）⇒ 本表与声明**无冲突**。
> `.td-label-trigger` 的 caret 是**声明 6px / 实测 7px** 的一例：`right:6px` 对内边距盒说，1px 边框在外 ⇒
> 边框盒读 7px。**契约取实测 7px**（与 `test/web/blocks.contract.mjs` B04 段记的「R9-1 修正」同一条）。

### 2.3 溢出策略与目标视口

- **溢出策略**：见 §2.1 表。**430 档是全档中唯一「栏内横向滚动」必然生效的档位** ⇒ A4 必须在 430 档同时实测
  三件事：一行 + 栏内可滚（`scrollWidth > clientWidth`）+ 文档零横向溢出。
- **目标视口（E①/E②）**：
  - **必测档**：**≥1512×950**（大桌面）与 **430 档**（窄手机）；
  - **完整机检矩阵**（`web/.ui-align.json` 已固化）：**1512 / 1240 / 980 / 760 / 430 × 900**；
  - **视口自适应档**：**1512×700**（§3.2 的 B4 用它）；
  - 本轮额外实测 **1512×950** 一档（Elon ①的 ≥950 字面），结论与 1512×900 同族（§3.2）。
- **语言/主题**：断言语言 = `en`、主题 = `light`（双侧一致由 `web/.ui-align.json` 的 `theme`/`locale`/`localeTag`
  与 `apply` 段把守；原型是 markup 默认，不读 storage）。

---

## 3. B05 契约 — board 七列等高 + 视口自适应

### 3.1 等高链（R-4）

**链的解析**（原型实测；原型 `design/prototype/src/input.css`）：

| 环节 | 选择器 | 关键声明 | 实测 |
|---|---|---|---|
| 直通 | `[data-board-view]` | `display:flex; flex-direction:column; flex:1 1 auto; min-width:0; min-height:0` | 是 board 的父，且是二态根（R10 ①） |
| 容器 | `.td-board` / `[data-board]` | `display:flex; gap:var(--col-gap); **align-items:stretch**; flex:1 1 auto; min-height:0; min-width:0; overflow-x:auto; overflow-y:hidden; padding-bottom:4px` | `alignItems` = **`stretch`** |
| 列 | `section.td-col` / `[data-column]` | `display:flex; flex-direction:column; flex:0 0 var(--col-w); min-height:0` | `overflow-y` = **`visible`** |
| 列体 | `.td-col-body` / `[data-column-body]` | `display:flex; flex-direction:column; gap:8px; min-height:120px; overflow-y:auto` | `overflow-y` = **`auto`**，七列各一 |

⇒ **7 列等高且列高 == board 内容盒高**由 `align-items:stretch` + 直通链解析得到，**不写死高度**。

**口径（逐条）**：

1. `[data-board]` 的交叉轴对齐 = **`stretch`**（默认值也须**显式**写进契约的期望 computed）。
2. 7 列盒高两两差 **≤ 1px**。
3. 每列盒高 **== `[data-board]` 内容盒高**（≤ 1px）。
4. **视口自适应**：换视口高（900 → 700）后列高**随动**且仍相等；**禁写死 px**。
5. 列内**唯一纵向滚动容器 = `[data-column-body]`**；`[data-column]` 自身 `overflow-y ∉ {auto, scroll}`。

### 3.2 期望值表（原型实测，en + light）

| 档位 | `[data-board]` 内容盒高 | 7 列盒高 | 两两差（spread） | 列高 − 内容盒高 | `[data-column]` `overflow-y` | `[data-column-body]` `overflow-y` | 列内纵滚元素数 | board `scrollWidth` / `clientWidth` |
|---|---|---|---|---|---|---|---|---|
| 1512×950 | **808px** | 808px ×7 | **0px** | **0px** | `visible` ×7 | `auto` ×7 | 7（每列 1） | 2196 / 1216 |
| 1512×900 | **758px** | 758px ×7 | 0px | 0px | `visible` | `auto` | 7 | 2196 / 1216 |
| 1240×900 | 758px | 758px ×7 | 0px | 0px | `visible` | `auto` | 7 | 2196 / 944 |
| 980×900 | 758px | 758px ×7 | 0px | 0px | `visible` | `auto` | 7 | 2196 / 868 |
| 760×900 | 733px | 733px ×7 | 0px | 0px | `visible` | `auto` | 7 | 2196 / 664 |
| 430×900 | 695px | 695px ×7 | 0px | 0px | `visible` | `auto` | 7 | 2196 / 342 |
| 1512×700（自适应） | **558px** | 558px ×7 | 0px | 0px | `visible` | `auto` | 7 | 2196 / 1216 |

**容器本体**（`[data-board]` computed，六档同值）：`display:flex` · `align-items:stretch` · `gap:16px`（`--col-gap`）·
`overflow-x:auto` · `overflow-y:hidden` · `padding: 0 0 4px 0` · `min-height:0` · `min-width:0`。

**反向证据（B8/B10 的事实基础）**：列的自然内容高（表头 + 进度条 + 列体 `scrollHeight`）六档恒定
= `298 / 298 / 298 / 262 / 150 / 279 / 150`，**每一列都远小于其盒高**（如 1512×900 档最矮 150px 对 758px）
⇒「列高 == 该列内容高（未拉伸）」**为假**，等高**确由拉伸得到**。列体盒高实测
`267.56 / 267.56 / 267.56 / 231.78 / 120 / 248.67 / 120`（120px 是 `.td-col-body` 的 `min-height` 地板）。

**视口随动的算术**：900 → 700（−200）⇒ 内容盒高 758 → 558（−200），**逐像素等同**。

**文档级**：六个档位 `documentElement.scrollWidth == clientWidth`（0px 溢出），`body.scrollWidth` 亦同值。
`[data-board]` 是**文档唯一的横向滚动容器**（其 `scrollWidth` 2196 恒大于 `clientWidth`）。

---

## 4. 设计裁定 R-1…R-9（本卡定；下游不得改向）

| # | 裁定 |
|---|---|
| **R-1** | **契约载体与编号**：R12 主契约文件 `design/fidelity-r12.md` 已被并发卡 `T-20261013-023310` 占用 ⇒ 本卡产出**补充契约** `design/fidelity-r12-supplement.md`（本轮唯一新文档）。**不改 `design/DESIGN.md`**（避免与并发 lane 同文件互写；本轮裁定记在本文件 §4，R12 写回时可折叠）。**不改 `design/prototype/**`**（只读 + 截图）。 |
| **R-2** | **B04 = 单行、不含 `flex-wrap`**（Elon ②，覆盖「对齐原型折行」的推断）：口径与四条被否决备选见 §2.1。度量（高度/间距/padding/字体/caret）仍逐项对齐原型（§2.2）。 |
| **R-3** | **状态控件的在册与 pending**：`[data-filter-status]` 族落地属 **E1-2**（`T-20261013-014701-3`），**不是**本卡与修复卡的缺陷。契约**枚举在册**（「在册不消失」），其落地检查标 **pending**；**A 组断言必须不依赖状态控件**（只约束「共有控件」子集 + 相对顺序）⇒ 修复卡在无状态控件时也能全绿。 |
| **R-4** | **B05 等高链口径**：见 §3.1 五条。 |
| **R-5** | **必须含反向（负向）断言**：A9/A10/A11、B8/B9/B10（§5）。 |
| **R-6** | **机检断言的落地归属**（本卡只写规范、不落）：**A 腿**（结构/计数，清单六词）→ `web/manifests/board-m2.json` 新增块 `B04-r12`/`B05-r12`，**由修复卡 `T-20261013-023722` 随修复一起落**（先落会把 live 清单转红）；**B 腿**（可声明的 computed 规则）→ `test/web/blocks.contract.mjs`；**C 腿**（双侧 computed style 目标）→ `web/.ui-align.json` / 清单 `style.targets`（非阻塞，只上屏）；**D 腿**（几何/行数/多视口/多高度）→ 驱动层 `web/scripts/dom-smoke.mjs` 的 **R12 段**（`npm test` 内求值）——**行数与列高关系只能在这一腿判定**。 |
| **R-7** | **证据归因三类**（`实测`/`实读`/`推断`），逐条标明，任何一条不得无来源。 |
| **R-8** | **零增量**：不新增/修改任何 i18n 键；不新增 token/颜色/图标；无行号锚；除截图基线外不改原型、不改实现。 |
| **R-9** | **目标视口**：见 §2.3。430 档是全档中唯一「栏内横向滚动」必然生效的档位。 |

### 4.1 两条附带裁定（本轮实测逼出来的，写进契约以消歧）

| # | 裁定 | 理由 |
|---|---|---|
| **R-6a** | **A 腿与 D 腿的分工按「可否用清单六词表达」切**，不按「结构/几何」切：清单的 check 词汇是 `selector`/`scope`/`count`/`min`/`max`/`nonEmpty`，**没有可见性谓词** ⇒ **A10（闭集外的可见控件）的可判半边落 D 腿**，A 腿只承载它**可表达**的那半（每个在册族的 `count` + 相对顺序）。同理 A1 的「可见」= D 腿。 | 本卡实测：`.td-sr` 是 1×1 裁剪盒、`getClientRects()` 非空 ⇒ 纯计数会把隐藏 label 数成控件；清单又没有可见性谓词。把「表达不了的那半」留在 A 腿会让断言**必然误判或必然假绿**。 |
| **R-6b** | **C 腿要断言 `flex-wrap`/`overflow-x`，必须先把这两个名字加进 `web/.ui-align.json` 的 `styleProps`**：`ui-align` 的默认属性集（`lib/config.mjs` 的 `DEFAULT_STYLE_PROPS`）**含 `alignItems`/`gap`/`padding*`/`overflow` 简写，但不含 `flexWrap`、也不含 `overflowX`/`overflowY`**。这是一行**配置**改动，**不改工具任何一行**。 | 不改的话，A3/A4 的 C 腿会**静默不比较**（属性不在集合里 ⇒ 不产生 diff）——一条「上屏却无效」的断言。 |

---

## 5. 机检断言清单（A/B/C/D 四组）

> 每条 = 「档位 + 测什么 + 期望值 + 归属腿 + 失败含义」。期望值来自**原型实测**（度量类）或**本契约口径**
> （R-2/R-4）；冲突时**以原型实测改度量期望值、以口径守方向**。
> **本卡只写规范**（R-6）；A 腿的可粘贴片段见**附录 A**，D 腿的伪码见**附录 B**。

### 5.0 档位常量（四条腿共用）

| 名 | 值 |
|---|---|
| `WIDE_TIERS` | `1512 · 1240 · 980 × 900`（**无栏内溢出**的档；A7 的适用范围） |
| `ALL_TIERS` | `1512 · 1240 · 980 · 760 · 430 × 900`（`web/.ui-align.json` 的 `viewports`） |
| `ADAPT_TIER` | `1512 × 700`（B4 专用） |
| `ELON_WIDE` | `1512 × 950`（Elon ①的字面；本轮已实测，§3.2） |
| 语言 / 主题 | `en` / `light` |

### 5.1 A 组 · B04 filters 条

| id | 断言 | 判据 | 期望值 | 归属腿 | 失败含义 |
|---|---|---|---|---|---|
| A1 | 控件族 = **闭集** `{assignee, priority, [status], label, clear, count}`，无闭集外的**可见**控件 | `scope:[data-filters]` 的直接子级里，各在册钩子的 `count` + 「直接子级中既非在册族也非 `.td-sr` 且被绘制」的元素数 == 0 | 在册族各 1（`[data-filter-status]` **max 1**，缺席不计失败）；闭集外可见控件 **0** | **A**（可表达半：族计数 + 相对顺序）＋ **D**（闭集外的可见性，R-6a） | 出现第五个筛选控件族，或状态控件落地后被计数成「闭集外」——契约的枚举不再等于文档 |
| A2 | **一行**（所有档位，**含 430**） | 可见子级（排除 `.td-sr`）的**线中心**去重数 `== 1`（容差 1px，§1.2 规则 7） | 去重数 **1** | **D** | 栏折行 —— R-2 的方向被破；430 档的折行正是本轮要消除的原型行为 |
| A3 | `[data-filters]` 的 `flexWrap == "nowrap"`、`flexDirection == "row"`、`alignItems == "center"` | computed style | `nowrap` / `row` / `center` | **B** ＋ **C**（`flexWrap` 需先加进 `styleProps`，R-6b） | 栏回到 `wrap`（= 原型行为），或方向/交叉轴被顺手改掉 |
| A4 | **溢出策略在场** | `overflowX ∈ {auto, scroll}` 且 `minWidth == "0px"`（computed）；430 档 `[data-filters].scrollWidth > clientWidth`（**栏内确有可滚余量**）**且**文档 `scrollWidth <= clientWidth` | `auto`/`0px`；430 档**两个不等式同时成立** | **B**（策略在场）＋ **D**（430 档的两侧不等式）＋ **引擎**（文档级，A8） | `nowrap` 了但没给滚动容器 ⇒ 或窄档内容被裁、或文档级横向溢出；两者都是 (d) 备选 |
| A5 | 同族字段控件**等高**，且等于该侧族高 | `getBoundingClientRect().height`：`[data-filter-assignee]` / `[data-filter-priority]` / `[data-filter-status] > summary` / `[data-filter-label] > summary` | **原型实测 30px ×4**；**实现侧 32px ×4**（已由 R9 ② 与 `test/web/blocks.contract.mjs` B04 段记录，§6 第 7/8 行）⇒ **判据 = 四者相等**（绝对值分侧） | **D** ＋ **C** | 家族里有一个控件不同高 —— R9 ② 的整条理由（bar 读成一排控件）就没了 |
| A6 | 控件间距 == 原型实测；栏内边距 == 原型实测 | 相邻同线控件盒间隙；`[data-filters]` 的 `padding*` computed | 间隙 **8px**（四对，§2.2）；栏 padding **0 / 0 / 0 / 0** | **D**（间隙）＋ **C**（padding） | 间距漂移（8 → 12/16）或栏内边距被加厚 ⇒ 栏盒高不再等于控件高（30px），与 board 的间距节奏脱节 |
| A7 | `[data-filter-count]` **贴右端** | **几何**：`[data-filter-count]` 盒右缘 == `[data-filters]` **内容盒**右缘（容差 1px）。**适用范围 = `WIDE_TIERS`**（无栏内溢出，故内容盒 == 可见盒） | 1512/1240/980 三档差 **0px**（原型实测） | **D** ＋ **C** | 计数离开右缘 —— 宽档的读数从「栏尾」漂到「Clear 旁边」 |
| A8 | `ALL_TIERS` **无横向溢出**、`console`/`pageerror` == 0 | `html` 的 `scrollWidth <= clientWidth`（引擎口径，`over > 0` 即失败）；console 白名单外为空 | 六档溢出 **0px**、console/pageerror **0** | **引擎**（`ui-align`，`web/manifests/board-m2.json` 的 `overflowTargets`） | 页面级横滚或运行时异常 —— 门禁级失败 |
| A9 | **反向**：任何档位出现**第二行**即失败（行数 >1） | 同 A2 | 去重数 **1** | **D** | A2 的镜像；防止把「一行」松懈成「大致一行」 |
| A10 | **反向**：栏内出现**闭集外**的可见控件即失败 | 同 A1 | 闭集外可见控件 **0** | **A**（可表达半）＋ **D**（可见性，R-6a） | 契约的枚举不再等于文档：新增筛选控件没进契约 |
| A11 | **反向**：窄档（430）不得靠「隐藏控件」过关 —— `[data-filter-count]`、`[data-filter-clear]` **仍被绘制** | `getClientRects().length > 0` | 两个都 **> 0** | **D** | 有人用 `hidden`/`display:none` 换掉一行的达成 ⇒ 备选 (c) 被偷偷采用，信息丢失 |

> **A7 的判据订正（记录）**：设计规格 §3 写的是 `marginLeft == "auto"`。实测反例：`getComputedStyle` 对
> `margin-left:auto` 返回**已解析的 used 值**（1512 档原型实测 `674.328px`）。故判据改为**几何**（§1.2 规则 5）。
> 这是**规格偏差**，已记 `report.md §2`。

### 5.2 B 组 · B05 board 列等高 / 视口自适应

| id | 断言 | 判据 | 期望值 | 归属腿 | 失败含义 |
|---|---|---|---|---|---|
| B1 | `[data-board]` computed `alignItems == "stretch"` | computed style | `stretch` | **B** ＋ **C** | 交叉轴回落到 `flex-start`（实现现状 `items-start`，§6 第 12 行）⇒ 列取内容高、七列不等高 |
| B2 | 7 列**等高** | 逐档：`max(colHeight) − min(colHeight) <= 1px` | **0px**（六档实测） | **D** | 至少一列与其余不等高 |
| B3 | **列高 == board 内容盒高** | 逐档：每列 `rect.height` == `[data-board]` 内容盒高（容差 1px） | **0px**（六档实测） | **D** | 列没吃满 board —— 等高成立了但**不是**、或**不只是**拉伸（如写死高度） |
| B4 | **视口自适应**：`ADAPT_TIER` 重跑 B2/B3 仍成立，且列高**随视口高变** | 第二档高度；并断言 `colHeight(900) − colHeight(700)` == 视口高差 | 900 → 700：列高 **758 → 558**（差 **200px == 视口高差**） | **D** | 高度被写死（换视口不动）或只部分随动 |
| B5 | `[data-column]` 自身 `overflowY ∉ {auto, scroll}`；`[data-column-body]` 的 `overflowY == "auto"` | computed style | `visible` ×7 / `auto` ×7（六档实测） | **B** ＋ **D** | 列自己成了纵滚容器 ⇒ 滚动条出现在列外框上，「列体内滚」的唯一性被破 |
| B6 | 列数恒 **7**、`data-status` 序列恒定 | 计数 + 序列 | `7`；`backlog, todo, in_progress, in_review, blocked, done, canceled`（六档实测，逐字同序） | **A** | 列集合或列序被改 —— 等高断言会在一组「不是这七列」的盒子上通过 |
| B7 | `ALL_TIERS` 无横向溢出、console 干净 | 同 A8 | 同 A8 | **引擎** | 同 A8 |
| B8 | **反向**：「列高 == 该列内容高（未拉伸）」**必须为假** —— 至少最矮列的盒高 > 其内容高 | 列盒高 vs 列自然内容高（表头 + 进度条 + 列体 `scrollHeight`） | 六档实测：每列盒高 >> 内容高（最矮列 1512×900 档 **758 > 150**） | **D** | 有人用「让所有列都塌成内容高」或「写死一个共同小高度」伪造等高 |
| B9 | **反向**：**列内** `overflow-y ∈ {auto, scroll}` 的元素数 **≤ 1** | 逐列计数 | 每列 **1**（= `[data-column-body]` 本身；六档实测 board 内共 7 = 七列各一） | **D** | 列内出现第二个纵滚容器（嵌套滚动 = 滚轮行为不可预测） |
| B10 | **反向**：不得靠固定高/内容塌陷制造「等高」——`[data-column-body]` 高度 > 0 **且**卡片可见 | rect + 卡片计数 | 列体盒高 **> 0**（实测 120–267.56px）×7；每列可见卡片 **≥ 1**（原型 18 张分布在七列：2/2/2/2/1/2/1） | **D** | 列体被压成 0 高或卡片被隐藏 ⇒ 等高是「空盒等高」 |

### 5.3 C 组 · 双侧 computed style（非阻塞，只上屏）

**前置**：按 R-6b，先把 `flexWrap`、`overflowX`、`overflowY` 三个名字加进 `web/.ui-align.json` 的 `styleProps`。

**targets（`web/.ui-align.json` 或清单 `style.targets`）**：`[data-filters]`（**已存在**，名 `filters`）·
`[data-board]`（**已存在**，名 `board`）· 新增 `.td-select` · 新增 `[data-filter-label] > summary` ·
新增 `[data-filter-count]` · 新增 `[data-column]`。

**逐属性期望**（原型侧 = 原型实测；实现侧 = 该侧应有值）：

| target | 属性 | 原型侧 | 实现侧 |
|---|---|---|---|
| `[data-filters]` | `gap` | `8px` | 期望 `8px` |
| `[data-filters]` | `alignItems` | `center` | 期望 `center` |
| `[data-filters]` | `flexWrap` | `wrap`（**原型即偏差源**，C 腿在此**预期不一致**） | 期望 `nowrap` |
| `[data-filters]` | `padding*` | `0px` ×4 | 期望 `0px` ×4（现状 `16px`/`8px`，§6 第 3 行） |
| `.td-select` | `height`/`minHeight` | `30px` / `30px` | `32px` / `32px`（R9 ② 的既有口径） |
| `.td-select` | `fontSize`/`fontWeight`/`borderRadius` | `12px`/`400`/`6px` | 同 |
| `.td-select` | `paddingLeft`/`paddingRight` | `8px`/`26px` | 同 |
| `[data-filter-label] > summary` | `height`/`minHeight` | `30px`/`30px` | `32px`/`32px` |
| `[data-filter-count]` | `fontSize` | `12px` | 同 |
| `[data-board]` | `alignItems` | `stretch` | 期望 `stretch`（现状 `flex-start`，§6 第 12 行） |
| `[data-board]` | `gap` | `16px` | 期望 `16px`（现状 `12px`，§6 第 13 行） |
| `[data-board]` | `overflowX`/`overflowY` | `auto`/`hidden` | 期望 `auto`/`hidden` |
| `[data-column]` | `overflowY` | `visible` | 期望 ≠ `auto`/`scroll` |

> C 腿**非阻塞**（`web/.ui-align.json` 的 `style.blocking: false`）——它上屏只为把差异点亮，**不**构成门禁；
> 门禁在 A/B/D 三腿。别把 C 腿的红当成失败（也别把它的绿当成通过）。

### 5.4 D 组 · 驱动层（几何 / 行数 / 多视口 / 多高度）

伪码见**附录 B**。D 腿承载的 id：**A2/A4/A5/A6(间隙)/A7/A9/A10(可见性半)/A11 · B2/B3/B4/B8/B9/B10**
（另 `B5` 的 `[data-column]` 半边）。**每一条都必须在 `ALL_TIERS` 上跑一遍**（三档递增的循环），
`B4` 另跑 `ADAPT_TIER`。

---

## 6. 「原型 vs 实现」逐项偏差清单（E④；含匹配项）

**原型侧值 = 实测**（§1.2 规则 1）；**实现侧值 = 实读**（§1.2 规则 3、9）。**归属卡**：`R12修` = `T-20261013-023722`
（修复卡，落 `web/**` + A 腿清单块）；`E1-2` = `T-20261013-014701-3`（状态控件族）；`—` = 无（匹配项或纯记录）。

### 6.1 B04 · filters 条

| # | 文件:选择器 | 分类 | 原型值（实测） | 实现值（实读） | 归因 | 归属卡 |
|---|---|---|---|---|---|---|
| 1 | `web/src/components/board/FiltersBar.vue:[data-filters]` | **口径**（**方向相反**） | `flex-wrap: wrap` | `flex-wrap: wrap`（Tailwind `flex-wrap`） | 原型**实测** / 实现**实读** | `R12修` |
| 2 | `web/src/components/board/FiltersBar.vue:[data-filters]` | **对齐** | `gap: 8px` | `gap-2` = `8px` | 实测 / 实读 | — |
| 3 | `web/src/components/board/FiltersBar.vue:[data-filters]` | **口径** | `padding: 0`（四边；栏内边距由 `.td-main` 出） | `px-4 py-2` = `16px`/`8px`（栏自出内边距） | 实测 / 实读 | `R12修` + **未决 U-1** |
| 4 | `web/src/components/board/FiltersBar.vue:[data-filters]` | **缺** | 原型不是滚动容器（`overflow: visible`，靠折行容纳） | **无** `overflow-x` / `min-width` ⇒ 溢出策略缺席 | 实测 / 实读 | `R12修` |
| 5 | `web/src/components/board/FiltersBar.vue:[data-filter-count]` | **对齐** | `margin-left: auto`（宽档贴右，1512/1240/980 差 0px） | `ms-auto`（`margin-inline-start: auto`，`dir=ltr` ⇒ 同效） | 实测 / 实读 | — |
| 6 | `web/src/components/board/FiltersBar.vue:[data-filter-status]` | **缺** | 在册，是 bar 的**第三个字段控件**（实测 `[data-filters] > [data-filter-status]` 存在，盒高 30px） | 整族缺席（可见子级 **5** 个：assignee 壳 · priority 壳 · label · clear · count） | 实测 / 实读 | `E1-2`（**非** `R12修`，R-3） |
| 7 | `web/src/components/board/FiltersBar.vue:[data-filter-label] > summary` | **口径** | `.td-label-trigger` 盒高 **30px** | **32px**（`test/web/blocks.contract.mjs` B04 段 `equalsPx: 32`） | 实测 / 实读 | —（R9 ②/M2c ① 既有口径） |
| 8 | `web/src/components/board/FiltersBar.vue:select.td-select` | **口径** | `.td-select` 盒高 **30px** | **32px**（同上，实现族 32px 在 4px 网格上） | 实测 / 实读 | — |
| 9 | `web/src/components/board/FiltersBar.vue:[data-filter-label-summary]` | **对齐** | 触发器的值读作**纯文本**（实测 `border-radius 0px`、`padding 0`；markup 上的 `badge td-chip td-chip-label` 被 `.td-label-trigger [data-filter-label-summary]` 规则还原） | 纯文本 `<span>`（markup 里就没有 chip 类） | 实测 / 实读 | — |
| 10 | `web/src/components/board/FiltersBar.vue:[data-filter-clear]` | **对齐** | `btn btn-ghost btn-sm`：盒高 **28px**、`12px`/`500`、`padding 12px`、圆角 `6px` | `btn btn-ghost btn-sm` | 实测 / 实读 | — |
| 11 | `web/src/components/board/FiltersBar.vue:[data-filters]`（可见子级数） | **缺** | **6**（另 2 个 `.td-sr`） | **5** | 实测 / 实读 | `E1-2`（同第 6 行） |
| 12 | `web/src/components/board/FiltersBar.vue:[data-filter-label]`（markup 族） | **对齐** | `<details class="dropdown" data-dismiss-on-outside>` + `[data-filter-label-value]` | 同（`<details class="dropdown" data-filter-label :data-filter-label-value data-dismiss-on-outside>`） | 实测 / 实读 | — |

### 6.2 B05 · board

| # | 文件:选择器 | 分类 | 原型值（实测） | 实现值（实读） | 归因 | 归属卡 |
|---|---|---|---|---|---|---|
| 13 | `web/src/components/board/Board.vue:[data-board]` | **缺**（**E④ 点名**） | `align-items: stretch` | `items-start`（`flex-start`）⇒ 列取内容高、七列不等高 | 实测 / 实读 | `R12修` |
| 14 | `web/src/components/board/Board.vue:[data-board]` | **口径** | `gap: 16px`（`--col-gap`） | `gap-3` = `12px` | 实测 / 实读 | `R12修` + **未决 U-1** |
| 15 | `web/src/components/board/Board.vue:[data-board]` | **口径** | `padding: 0 0 4px 0` | `p-3` = `12px`（四边） | 实测 / 实读 | `R12修` + **未决 U-1** |
| 16 | `web/src/components/board/Board.vue:[data-board]` | **对齐** | `overflow-x: auto` / `overflow-y: hidden`（**文档唯一横滚容器**） | `overflow-x-auto overflow-y-hidden` | 实测 / 实读 | — |
| 17 | `web/src/components/board/Board.vue:[data-board]` | **口径** | `flex: 1 1 auto; min-height: 0; min-width: 0` | `h-full`（`height: 100%`）；无 `min-height: 0` | 实测 / 实读 | —（容器模型不同；R10 ① 已记录） |
| 18 | `web/src/components/board/Board.vue:[data-board-view]` + `web/src/styles/app.css:[data-board-view]` | **口径** | `flex: 1 1 auto`（原型 `[data-main]` 是 flex column） | `height: 100%`（实现的 `main` 是 grid item、子级块级） | 实读 / 实读 | —（R10 ① 的既定表达） |
| 19 | `web/src/components/board/Column.vue:[data-column]` | **口径** | `flex: 0 0 var(--col-w)`（`--col-w: 300px`）；**无** `max-height` | `flex-[0_0_268px]`（268px）+ `max-h-full` | 实读 / 实读 | —（列宽属 B06；`max-h-full` 只是**上限**、不是拉伸） |
| 20 | `web/src/components/board/Column.vue:[data-column]` | **对齐** | `overflow-y: visible`（**不是**列自身的纵滚容器） | 未声明 `overflow-y` ⇒ `visible` | 实测 / 实读 | — |
| 21 | `web/src/components/board/Column.vue:[data-column-body]` | **对齐** | `overflow-y: auto`（**列内唯一纵滚容器**） | `overflow-y-auto` | 实测 / 实读 | — |
| 22 | `web/src/components/App.vue:main` + `web/src/components/board/FiltersBar.vue` | **推断** | —（原型 `[data-main]` 是 **flex column**，`gap: 12px`，padding 由 `--main-pad-*` 出；板吃 `flex: 1 1 auto`） | 实现的 `main` 是 grid item（`[grid-area:main] min-w-0 overflow-auto`）、**块级**子：先是 FiltersBar（自出 `py-2` + `border-b`），再是 `[data-board-view]`（`height: 100%`）⇒ 两者高度之和 = main 内容高 **+ bar 高** ⇒ **推断** `main` 会纵向滚动 / 板被推到折线下 | 实读 → **推断**（推导链见本行） | `R12修` → **未决 U-2**（需测量确认） |
| 23 | `web/src/styles/app.css:[data-board-view][data-board-state=…]` | **对齐** | 二态互斥由读属性的规则表达（原型 `src/input.css` 同形） | 同形（`display: none` 成对） | 实测 / 实读 | — |

**匹配项统计**：第 2/5/9/10/12/16/20/21/23 行 = **9 条 `对齐`**（E④ 的「含匹配项」；
其中第 2/5/9/10/16/20/21 是**本轮两条口径直接落到的位点**：栏间距、计数贴右、纯文本值、clear 的 `btn-sm`、
板的横滚/hidden、列的 `overflow-y:visible`、列体的 `auto`）。

**E④ 点名两条已覆盖**：`Board.vue` 根 `items-start` = 第 13 行；`FiltersBar` `flex-wrap` = 第 1 行。

---

## 7. §⑫ 文档影响判定

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/BLOCKS.md` | **§B04** 追加「R12 补充」：一行控件家族 + 顺序 + 溢出策略 + 状态控件**在册（pending）**；**§B05** 追加「R12 补充」：列等高链 + 列高 == board 高（视口自适应）+ 唯一纵向滚动容器 | **已改**（本次仅两段） |
| `design/fidelity-r12-supplement.md` | 本文件 | **新增** |
| `design/assets/r12/proto-board-{1512,1240,980,760,430}.png` | 原型截图基线（en + light，五档） | **新增** |
| `design/DESIGN.md` | **不改**：避免与并发 lane（`T-20261013-023310` 追加 §28）同文件互写；本轮裁定记在本文件 §4，R12 写回时可折叠 | **不改（有意）** |
| `design/prototype/**` | **不改**（只读 + 截图；R-8） | **不改（红线）** |
| `design/fidelity-r12.md` | **不改**（并发卡 `T-20261013-023310` 的隔离 worktree 已在写；R-1） | **不改（红线）** |
| `web/**` · `src/**` · `test/**` | **不改**（本卡只写规范；实现归修复卡 `T-20261013-023722`） | **不改（红线）** |
| **i18n 归属（显式判定）** | 本卡**零 i18n 增量**：不新增/修改任何键，不新增 `data-i18n*` 钩子（R-8）。因此 R11 §7.1 记录的 `test/web/**` 三处镜像冲突**不因本卡变化**（§8.4） | **已判定（无增量）** |
| **接口/数据结构/架构/配置/约定** | **触及「约定」**（B04/B05 的口径被固化成机检断言）；**不触及** 接口（无路由/wire 字段变更）、数据结构（无 DTO/schema 变更）、架构（无模块依赖变更）、配置（**除 R-6b 的一行 `styleProps` 增补**，且属修复卡） | **已判定** |

---

## 8. 具名验证法、边界与红线

### 8.1 可跑的命令串（E⑤）

```sh
# ① 原型实测（本卡已跑；六档 + 五帧截图）—— 原始记录 <本卡工作区>/verify/proto-*.json
#    探针脚本在仓库之外的本卡工作区里，按你手上的实际路径替换 <本卡工作区>。
node <本卡工作区>/verify/r12-probe.mjs --shots

# ② 结构/溢出/console 腿（引擎）—— 当前实现：A 腿块未落，只作「无回归」基线
node <外部框架目录>/tools/ui-align/check.mjs --config web/.ui-align.json board-m2 --json

# ③ 双侧 computed style 腿（非阻塞；含 R12 新增 targets 后才有 R12 行）
node <外部框架目录>/tools/ui-align/check.mjs --config web/.ui-align.json board-m2 --style --json

# ④ B 腿（可声明的 computed 规则；R12 规则由修复卡落）
node --test test/web/blocks.contract.test.mjs

# ⑤ D 腿（驱动层 R12 段，由修复卡落；npm test 内求值）
npm test

# ⑥ 截图基线（原型；en + light）
ls design/assets/r12/proto-board-{1512,1240,980,760,430}.png
```

| 命令 | 本轮结果 | 说明 |
|---|---|---|
| ① | **通过** | 六档全部实测；`console` 0 / `pageerror` 0；五帧落 `design/assets/r12/` |
| ② | **退出码 2** | `目标页不可达`：本 lane 的 worktree 无 `web/dist`/`web/node_modules`（F12）⇒ 实现腿起不来。**这是环境事实，不是断言失败** |
| ③ | 同上（依赖 ②） | — |
| ④ | **1 文件 / 2 条红** | 红的是 `data-i18n*` 席位计数与 `MESSAGES` 键数 —— **R11 §7.1 已记录的既有冲突**（记录 612/220，文档 622/224），在 `test/**`（本卡红线）。**与本轮改动无关**（§8.4） |
| ⑤ | 未跑 | 需 `web/dist` |

### 8.2 硬门（原型侧，六档全轮）

`console errors = 0` · `pageErrors = 0` · 文档横向溢出 `0px` ×6。原始记录
`verify/proto-console.json`（**不进仓**）。

### 8.3 零增量 / 无行号锚声明

- **零 i18n 增量**：本卡不新增/修改任何键、不新增 `data-i18n*` 钩子（R-8）。
- **零新 token / 颜色 / 图标**：契约只引用原型既有变量（`--col-gap`、`--col-w`、`--main-pad-*`、`--r-md`、`--color-td-*`）。
- **无行号锚**：全文引用一律「文件:选择器」或「文档名 §小节」；**无** `file:123` 形态。
- **本卡不写实现**：`web/**`、`src/**`、`test/**` 一字未动。

### 8.4 边界与未决项

| # | 项 | 说明 |
|---|---|---|
| **U-1** | **栏/板的「内边距承载者」** | 原型把栏内边距与板间距交给 `.td-main`（`padding: var(--main-pad-y) var(--main-pad-x)`、`gap: 12px`），实现把内边距放在栏（`px-4 py-2`）与板（`p-3`）自己身上。**两者若不同时收敛，A6 的「栏 padding == 0」与第 14/15 行会互相牵制**。裁定建议：以**首个控件到视口/内容边缘的可见距离**为口径（A6 的 padding 半改成「栏盒高 == 控件高」+ 边缘距离），或在修复卡同时收敛承载者。**本卡不改方向，只标未决**。 |
| **U-2** | **`main` 的纵向预算**（第 22 行） | 实现的 `main` 是块级容器、`[data-board-view]` 取 `height: 100%`，而 FiltersBar 是它的**块级兄弟**（自带 `py-2` + `border-b`）⇒ **推断**两者高度之和超出 `main` 的内容盒 ⇒ `main` 纵向滚动、板下沿落到折线下。**须由修复卡在浏览器里测量确认**（原型侧不存在此问题：`[data-main]` 是 flex column，板吃 `flex: 1 1 auto`，栏与板共享一条纵向预算）。 |
| **U-3** | **C 腿 `styleProps` 增补**（R-6b） | `flexWrap`/`overflowX`/`overflowY` 不在 `ui-align` 的默认属性集里；不加 ⇒ A3/A4 的 C 腿**静默不比较**。一行配置改动，归修复卡。 |
| **U-4** | **`≥1512×950` 与机检的 900 高** | Elon ①的字面是「≥1512×950」，而 `web/.ui-align.json` 固化的 `height` 是 **900**（`viewports` 五档 × 900）。本卡已补测 1512×950 一档（§3.2，结论同族）。若要把 950 纳入常态机检，改的是 `web/.ui-align.json` 的 `height`（一行），归修复卡/后续卡。 |
| **U-5** | **430 档的计数可见性** | 430 档 `nowrap` + `overflow-x:auto` 下 flex 自由空间为负 ⇒ `margin-left:auto` 解析为 **0** ⇒ `[data-filter-count]` 落在 `[data-filter-clear]` 之后（**与原型 ≤979 档的实测行为同形**：该档原型 `margin-left` 实测 `0px`，计数紧跟 Clear）。A7 因此在 430 档**不适用**，只有 A11 守它「仍被绘制」。**若需求要它在窄档也贴视口右缘，那是另一个设计问题**（需固定/粘滞定位），本卡不改方向。 |
| **F-1** | **状态控件的落地** | 归 `E1-2`（`T-20261013-014701-3`，R-3）。A 组断言刻意**不依赖**它（`[data-filter-status]` 用 `max: 1`），修复卡在它缺席时应能全绿。 |
| **F-2** | **列宽 268px vs 300px**（第 19 行） | 属 **B06**，不在本轮口径内；`--col-w` 的收敛留给 B06 的契约。 |

### 8.5 红线（后续卡片必须遵守）

| # | 红线 |
|---|---|
| R1 | `[data-filters]` **不得**回到 `flex-wrap: wrap`（§2.1）；**不得**用「让控件收缩」或「窄档隐藏控件」达成一行（(b)/(c) 备选）。 |
| R2 | `[data-filters]` 一旦 `nowrap`，**必须**同时给 `overflow-x:auto` + `min-width:0`（(d) 备选）；**文档级横向溢出恒为 0** 是门禁。 |
| R3 | 状态控件是**在册**的（`[data-filter-status]`），其**落地检查标 pending**；**不得**让 A 组断言依赖它（R-3）。 |
| R4 | `[data-board]` 的交叉轴对齐**必须**是 `stretch`；列高**不得**用写死 px 制造等高（B4/B8/B10 的反向断言就是在守这条）。 |
| R5 | **列内唯一纵向滚动容器 = `[data-column-body]`**；`[data-column]` 自身 `overflow-y` 不得进 `{auto,scroll}`（B5/B9）。 |
| R6 | 契约锚一律 `data-*`；`.td-select`/`.td-label-trigger`/`.td-col` 等**类名只在 C 腿的 style targets 里出现**（那里比的是样式，不是契约）。 |
| R7 | 本卡**零 i18n 增量**；后续任何改原型的卡，i18n 三处镜像的同步义务按 R11 §7.1 执行。 |

---

## 附录 A · `web/manifests/board-m2.json` 可直接粘贴的块片段

> **只写规范，不落清单**（R-6）：这两块由修复卡 `T-20261013-023722` **随修复一起**加进 `blocks` 数组
> （`status` 从 `pending` 起，修复完成后改 `delivered`）。用**清单六词**（`selector`/`scope`/`count`/`min`/`max`/`nonEmpty`）
> 表达**可表达的那半**；表达不了的那半（可见性、行数、几何）留给 D 腿（附录 B）。
> **注意**：相对顺序用**通用兄弟组合子** `~` 表达（无行号锚、无位置索引），状态控件缺席时依然成立（R-3）。

```json
{
  "id": "B04-r12",
  "name": "R12 — filters 条：控件族闭集 + 相对顺序 + 单行口径的可表达半",
  "evidence": "design/fidelity-r12-supplement.md §2/§5 A 组；design/BLOCKS.md §B04（R12 补充）",
  "status": "pending",
  "checks": [
    { "selector": "[data-filters]", "count": 1, "desc": "过滤条根唯一" },
    { "scope": "[data-filters]", "selector": "[data-filter-assignee]", "count": 1 },
    { "scope": "[data-filters]", "selector": "[data-filter-priority]", "count": 1 },
    { "scope": "[data-filters]", "selector": "[data-filter-label]", "count": 1 },
    { "scope": "[data-filters]", "selector": "[data-filter-clear]", "count": 1, "desc": "文档唯一 clear 钩子（B04 既有口径）" },
    { "scope": "[data-filters]", "selector": "[data-filter-count]", "count": 1 },
    { "scope": "[data-filters]", "selector": "[data-filter-status]", "max": 1, "desc": "状态控件在册；缺席（E1-2 未落地）不计失败 —— R-3" },
    { "scope": "[data-filters]", "selector": "[data-filter-assignee] ~ [data-filter-priority]", "count": 1, "desc": "顺序 Assignee → Priority（用 ~ 表达，不依赖位置索引）" },
    { "scope": "[data-filters]", "selector": "[data-filter-priority] ~ [data-filter-label]", "count": 1, "desc": "顺序 Priority →(Status)→ Label；status 缺席时同样成立" },
    { "scope": "[data-filters]", "selector": "[data-filter-label] ~ [data-filter-clear]", "count": 1, "desc": "顺序 Label → Clear" },
    { "scope": "[data-filters]", "selector": "[data-filter-clear] ~ [data-filter-count]", "count": 1, "desc": "顺序 Clear → count" }
  ]
}
```

```json
{
  "id": "B05-r12",
  "name": "R12 — board 列等高/视口自适应：结构半（几何由驱动层把守）",
  "evidence": "design/fidelity-r12-supplement.md §3/§5 B 组；design/BLOCKS.md §B05（R12 补充）",
  "status": "pending",
  "checks": [
    { "selector": "[data-board]", "count": 1, "desc": "板根唯一" },
    { "selector": "[data-board-view] > [data-board]", "count": 1, "desc": "板是二态根的直接子级（R10 ①）" },
    { "scope": "[data-board]", "selector": "[data-column]", "count": 7, "desc": "恰好 7 列（scope 到板内，避开文档片段）" },
    { "scope": "[data-board]", "selector": "[data-column][data-status]", "count": 7, "desc": "每列带 data-status" },
    { "scope": "[data-board]", "selector": "[data-column-body]", "count": 7, "desc": "每列一个列体 = 列内唯一纵滚容器（B5/B9）" }
  ]
}
```

> **A 腿为什么止于此（R-6a）**：清单六词无**可见性**谓词，也无**行数/几何**谓词 ⇒
> 「**一行**」（A2/A9）、「闭集外的**可见**控件」（A10）、「四个控件**等高**」（A5）、「计数**贴右缘**」（A7）、
> 「栏内**可滚余量**」（A4 的 430 半）、以及 B 组的**全部几何**（B2/B3/B4/B8/B9/B10），
> **只能**在 D 腿判定。把它们硬塞进 A 腿只会得到必然假绿（属性不在集合里就静默不比）。

## 附录 B · 驱动层 `web/scripts/dom-smoke.mjs` 的 R12 段（伪码）

> 与 R10 段同形：`r10Check(cond, message)` 收集失败、`page.setViewportSize` 逐档循环、末尾并进 `report`。
> **每条断言在 `ALL_TIERS` 各跑一次**；`B4` 另跑 `ADAPT_TIER`。选择器一律 `data-*`。

```js
// ---- R12 · filters 条的单行口径 与 board 七列等高链 ------------------------
const r12Failures = [];
const r12Check = (ok, message) => { if (!ok) r12Failures.push(message); };

// 在页内量一个档位：返回裸数（不做判断），判断留在 Node 侧，便于逐条给出人话。
const measureR12 = () => page.evaluate(() => {
  const r2 = (n) => Math.round(n * 100) / 100;
  const painted = (el) => !!el && el.getClientRects().length > 0;
  const bar = document.querySelector("[data-filters]");
  // 可见子级 = 被绘制 **且** 不是 .td-sr（1×1 裁剪盒，getClientRects 非空 —— §1.2 规则 6）
  const kids = [...bar.children].filter((el) => painted(el) && !el.classList.contains("td-sr"));
  const centers = kids.map((el) => {
    const r = el.getBoundingClientRect();
    return r2(r.top + r.height / 2);
  }).sort((a, b) => a - b);
  const rows = centers.filter((c, i) => i === 0 || c - centers[i - 1] > 1).length;   // 规则 7
  const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
  const barRect = bar.getBoundingClientRect();
  const barStyle = getComputedStyle(bar);
  const contentRight = barRect.right - parseFloat(barStyle.paddingRight);
  const assets = ["[data-filter-assignee]", "[data-filter-priority]",
                  "[data-filter-status] > summary", "[data-filter-label] > summary"]
    .map((s) => box(s)).filter(Boolean).map((r) => r2(r.height));

  const board = document.querySelector("[data-board]");
  const bs = getComputedStyle(board);
  const bRect = board.getBoundingClientRect();
  const contentH = r2(bRect.height - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom));
  const cols = [...board.querySelectorAll("[data-column]")];
  const colH = cols.map((c) => r2(c.getBoundingClientRect().height));
  const bodyH = cols.map((c) => { const b = c.querySelector("[data-column-body]"); return b ? r2(b.getBoundingClientRect().height) : 0; });
  const cards = cols.map((c) => [...c.querySelectorAll("[data-card]")].filter(painted).length);
  const naturalH = cols.map((c) => {
    const h = c.querySelector("[data-column-header]"), p = c.querySelector("[data-column-progress]"), b = c.querySelector("[data-column-body]");
    return r2((h ? h.getBoundingClientRect().height : 0) + (p ? p.getBoundingClientRect().height : 0) + (b ? b.scrollHeight : 0));
  });
  return {
    rows, bool: barStyle.flexWrap, dir: barStyle.flexDirection, align: barStyle.alignItems,
    gap: barStyle.gap, barPad: [barStyle.paddingTop, barStyle.paddingRight, barStyle.paddingBottom, barStyle.paddingLeft],
    barOverflowX: barStyle.overflowX, barMinWidth: barStyle.minWidth,
    barScrolls: bar.scrollWidth > bar.clientWidth,
    countRight: box("[data-filter-count]") ? r2(box("[data-filter-count]").right) : null, contentRight: r2(contentRight),
    countPainted: painted(document.querySelector("[data-filter-count]")),
    clearPainted: painted(document.querySelector("[data-filter-clear]")),
    assetHeights: assets,
    colHeights: colH, colNatural: naturalH, bodyHeights: bodyH, cards,
    colOverflowY: cols.map((c) => getComputedStyle(c).overflowY),
    bodyOverflowY: cols.map((c) => getComputedStyle(c.querySelector("[data-column-body]")).overflowY),
    boardAlign: bs.alignItems, boardContentH: contentH,
    colHeightSpread: r2(Math.max(...colH) - Math.min(...colH)),
    colVsBoard: r2(Math.max(...colH.map((h) => Math.abs(h - contentH)))),
    verticalScrollersPerColumn: cols.map((c) =>
      [...c.querySelectorAll("*")].filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY)).length),
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

const HEIGHTS = {};
for (const width of [1512, 1240, 980, 760, 430]) {
  await page.setViewportSize({ width, height: 900 });
  const m = await measureR12();

  // A2 / A9 — 一行（含 430）
  r12Check(m.rows === 1, `@${width} the filters bar is ${m.rows} rows, expected 1`);
  // A3 — nowrap / row / center
  r12Check(m.bool === "nowrap" && m.dir === "row" && m.align === "center", `@${width} filters bar is ${m.bool}/${m.dir}/${m.align}`);
  // A4 — 溢出策略在场；430 档栏内确有可滚余量
  r12Check(["auto", "scroll"].includes(m.barOverflowX) && m.barMinWidth === "0px", `@${width} the bar overflow strategy is ${m.barOverflowX}/${m.barMinWidth}`);
  r12Check(width !== 430 || m.barScrolls, `@430 the bar has no scrollable slack (scrollWidth === clientWidth)`);
  // A5 — 同族字段控件等高（绝对值分侧：原型 30px / 实现 32px）
  r12Check(new Set(m.assetHeights).size === 1, `@${width} the field family is ${JSON.stringify(m.assetHeights)}, not one height`);
  // A6 — 间距 8px / 栏 padding 0
  r12Check(m.gap === "8px", `@${width} the bar gap is ${m.gap}`);
  r12Check(m.barPad.every((p) => p === "0px"), `@${width} the bar padding is ${m.barPad.join("/")}`);
  // A7 — 计数贴右缘（仅无溢出的宽档）
  if (width >= 980) r12Check(Math.abs(m.contentRight - m.countRight) <= 1, `@${width} the count ends ${m.contentRight - m.countRight}px from the bar's content edge`);
  // A11 — 430 档不得靠隐藏控件过关
  if (width === 430) r12Check(m.countPainted && m.clearPainted, `@430 count/clear painted = ${m.countPainted}/${m.clearPainted}`);
  // A10（可见性半）— 闭集外的可见直接子级 = 0
  //   （族集合在 Node 侧给出；页内只回传被绘制且非 .td-sr 且不匹配任一族钩子的元素数）

  // B1 — stretch
  r12Check(m.boardAlign === "stretch", `@${width} [data-board] aligns its columns with ${m.boardAlign}`);
  // B2 / B3 — 等高，且列高 == board 内容盒高
  r12Check(m.colHeightSpread <= 1, `@${width} the column heights spread ${m.colHeightSpread}px`);
  r12Check(m.colVsBoard <= 1, `@${width} the tallest column differs from the board's content box by ${m.colVsBoard}px`);
  // B5 / B9 — 列自身不纵滚；列内纵滚元素 ≤ 1（= 列体）
  r12Check(!m.colOverflowY.some((o) => o === "auto" || o === "scroll"), `@${width} a column is its own vertical scroller: ${m.colOverflowY}`);
  r12Check(m.bodyOverflowY.every((o) => o === "auto"), `@${width} the column bodies scroll as ${m.bodyOverflowY}`);
  r12Check(m.verticalScrollersPerColumn.every((n) => n === 1), `@${width} vertical scrollers per column = ${m.verticalScrollersPerColumn}`);
  // B8 — 反向：至少最矮列的盒高 > 其内容高（等高不是「一起塌成内容高」）
  r12Check(Math.min(...m.colHeights) > Math.max(...m.colNatural), `@${width} the shortest column (${Math.min(...m.colHeights)}px) is not taller than the tallest natural content (${Math.max(...m.colNatural)}px)`);
  // B10 — 反向：列体高度 > 0 且卡片可见
  r12Check(m.bodyHeights.every((h) => h > 0), `@${width} a column body has height ${m.bodyHeights}`);
  r12Check(m.cards.every((n) => n >= 1), `@${width} a column shows ${m.cards} cards`);
  // A8 / B7 — 文档级无横向溢出
  r12Check(m.docOverflow <= 0, `@${width} the document overflows horizontally by ${m.docOverflow}px`);

  HEIGHTS[width] = m.colHeights[0];
}

// B4 — 视口自适应：列高随视口高逐像素随动
await page.setViewportSize({ width: 1512, height: 700 });
const adapt = await measureR12();
r12Check(adapt.colHeightSpread <= 1 && adapt.colVsBoard <= 1, `@1512x700 the columns spread ${adapt.colHeightSpread}px and differ from the board by ${adapt.colVsBoard}px`);
r12Check(Math.abs((HEIGHTS[1512] - adapt.colHeights[0]) - 200) <= 1, `@1512 the column height moved ${HEIGHTS[1512] - adapt.colHeights[0]}px when the viewport height moved 200px`);
```

> **收尾**：把 `r12Failures` 并入既有 `report`（与 `r10Failures` 同层），失败即非零退出；`console`/`pageerror`
> 的白名单沿用本文件既有机制（不得新增白名单项）。
