# UI 保真契约 · R9 — Terry 三项列表/交互反馈（Before 契约）

> 卡：`T-20261012-224743` · 日期 2026-10-12 · 范围「R9：Terry 三项 taskpanel UI 反馈」· 定位「§⑨.1 Before = 结构契约 」。
> 来源：Terry 2026-10-12 22:47 对 taskpanel（http://localhost:9527）的三项反馈 —— ① topbar 项目下拉失焦不关闭；② filters 的 Label 组件点外不关闭且与 Priority/Assignee 不一致；③ List 视图 loading 与 data 同时渲染。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 证据口径：本契约的每条断言都在**真实浏览器（Chromium headless / Playwright）里对原型实测**，「期望值」即实测值；改前（before）与改后（after）各测一轮，两份原始记录见 §6。
> 关系卡：实现卡（`web/**` 镜像改动）与验证卡由 Elon 派发；**本卡只产契约与原型改动，不含实现代码**。
> 基线 commit：`66c822d`（本卡开工时的 HEAD）。

## 0. 结论摘要

- 三项**全部落在既有块**（① B02 · ② B04 · ③ B08/B13）⇒ 本契约**不引入新块**；新增两个钩子：`[data-dismiss-on-outside]`（属性，加在既有 `<details>` 上）与 `[data-list]` 的 `data-list-state`。
- **① 与 ② 统一为一类规则 = 是。** 共同 selector = **`[data-dismiss-on-outside]`**：一条 document 级规则决定「点外部 / `Esc` 关闭」，成员资格就是该属性本身（不看类名、不看钩子清单）。原型侧两个成员：`[data-project-switcher]`（B02）与 `[data-filter-label]`（B04）。
- **① 的真实缺口是「完全没有」**：改前实测，项目下拉在**合成点击**与**真实指针点击**下都保持 `open`，`Esc` 也不关；它的浮层压住 filters 条，实测**吃掉**了打给 filter 控件的点击（Playwright 点击 `[data-filter-label] > summary` 被 `[data-project-option="Orchestrator"]` 拦截 30s 超时）—— 这就是「必须先点下拉本身才关」的机制。
- **② 的关闭行为改前已成立、但来路不同**：`[data-filter-label]` 改前已有专属的 document 级 handler（按钩子名匹配），所以「点外关闭」实测为真。**本轮把它与 ① 归并**到同一属性规则下（口径统一），并把它的**几何**对齐 `.td-select`。
- **② 的视觉不一致是实测的**：改前 `.td-label-trigger` = `28px` / `weight 500` / `color rgb(74,85,94)`（ink-2）/ `padding 0 8px`，内层 `[data-filter-label-summary]` 是 `span.badge.badge-sm.td-chip.td-chip-label` = `border 1px` + `background rgba(15,122,115,0.1)` + `border-radius 999px`；两侧 `.td-select` = `30px` / `400` / `rgb(20,24,27)`（ink）。改后三者同高 30px、同文字处理。
- **③ 的根因是「缺一次状态切换」**：`renderList()` 填 `[data-list-rows]` 后**从不**隐藏 `[data-skeleton]`。改前实测 `[data-skeleton]` 与 `[data-list-rows]` 的 `display` 同时 ≠ none（计数 **2**）；改后两种状态各为 **1**。
- 三项均有 selector 级机检断言（§5 A/B 两类），供实现卡「During」直接落测；**§5 C 列出 6 条「不得断言」**。
- **token 无新增、无改动**：三项都用既有 token 表达（`.td-label-trigger` 只是把 `.td-select` 已在用的值与规则挪过来）。

---

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / DOM 计数 / 真实指针点击），不是 `src/input.css` 某条声明的字面值；两者不一致时实测值胜。
2. 「改前 / 改后」= 同一探针脚本（`workspace/T-20261012-224743/verify/r9-probe.mjs`）在原型改动前后各跑一次，同一视口（1512×950）、同一语言（en）、同一主题（light）；原始记录 `verify/probe-before.json` / `verify/probe-after.json`。
3. 「点外部」分两种，**分别记录**：`synthetic` = 向 `[data-filter-count]` 派发冒泡 click（只考察 handler 逻辑）；`real` = 真实指针点击一个**由命中测试选出**的惰性点（`document.elementFromPoint` 网格扫描，排除 `details` / `button` / `a` / 输入 / `[data-card]` / `[data-nav-item]`，实测落在 topbar 左上角 `(4,4)`）。两者会分歧：浮层遮挡只影响后者。
4. 本轮原型 `console` / `pageerror` 均为 `[]`（两轮皆是）。
5. 实现侧本轮**未到场实测**（未构建 `web/dist`）；凡涉及实现的位点均标注「实读」。

**共用实测值（原型，1512 light）**：

| 量 | 改前 | 改后 |
|---|---|---|
| `.td-label-trigger` `height` / `min-height` | `28px` / `28px` | **`30px` / `30px`** |
| `.td-label-trigger` `padding` | `0px 8px` | **`0px 26px 0px 8px`** |
| `.td-label-trigger` `font-size` / `font-weight` | `12px` / `500` | `12px` / **`400`** |
| `.td-label-trigger` `color` | `rgb(74, 85, 94)`（ink-2） | **`rgb(20, 24, 27)`**（ink） |
| `.td-label-trigger` `border-radius` | `6px` | `6px`（不变） |
| `.td-label-trigger` caret `width`×`height` | `14px`×`14px` | `14px`×`14px`（不变） |
| caret 距**边框盒**右边 / 垂直居中偏移 | （内联流式，无定位） | **`7px` / `0px`** |
| `[data-filter-label-summary]` `border-width` | `1px` | **`0px`** |
| `[data-filter-label-summary]` `background-color` | `rgba(15, 122, 115, 0.1)` | **`rgba(0, 0, 0, 0)`** |
| `[data-filter-label-summary]` `padding` | `2px 4px 2px 8px` | **`0px`** |
| `[data-filter-label-summary]` `border-radius` | `999px` | **`0px`** |
| `[data-filter-label-summary]` `font-size` / `font-weight` | `12px` / `500` | `12px` / **`400`** |
| `[data-filter-assignee]` / `[data-filter-priority]` `height` | `30px` / `30px` | `30px` / `30px`（不变） |
| 三控件同高（assignee / priority / label） | `30 / 30 / **28**` | **`30 / 30 / 30`** |
| `.td-chip-label` 计数（全文档） | `29` | `29`（不变；`28` 个非 trigger 者仍 `border-radius: 999px`） |
| `[data-list]` `data-list-state` | 无该属性 | **`data`（静止态）** |
| `[data-skeleton]` `hidden` / `display` | 无 / `block` | **有 / `none`** |
| `[data-skeleton]` + `[data-list-rows]` 中 `display ≠ none` 的计数 | **2** | **1** |

**caret「`right 6px`」的口径订正（R9-1）**：`.td-select` 的 caret 是 `background-image` 的 `background-position: right 6px center`，定位区域是**内边距盒**；`[data-label-trigger] > .td-icon-sm` 是绝对定位子元素，`right: 6px` 同样相对**内边距盒**。因此对**边框盒**实测的右边距是 **`7px`**（6 + 1px 边框），不是 6px。断言应写「caret 右边距 = 6px（内边距盒）/ 7px（边框盒）」，**不得**写「6px」并在边框盒上量（那会误判为差 1px）。

---

## 2. 逐项契约

### 2.1 项① `B02.dismiss` — topbar 项目下拉失焦即关

**块契约表**

| | |
|---|---|
| 块 | **B02 · Top bar**（本轮改其一个控制，不改 bar 的布局与其它控制） |
| 根 | `header[data-topbar]` |
| 控制 | `[data-project-switcher]`（`<details class="dropdown" data-dismiss-on-outside>`） |
| 菜单 | `ul.dropdown-content.menu` → `[data-project-option="…"]` × 3 + `[data-project-new]` |
| 触发 | `[data-project-switcher] > summary`（**`<summary>` 即触发**，不另设按钮） |
| 本轮新增 | `data-dismiss-on-outside`（1 个属性，无新元素、无新类、无新 i18n key） |

| # | 现象（改前实测） | 期望（改后实测） | 差异类型 |
|---|---|---|---|
| ①-1 | 打开后点 `[data-filter-count]`（合成 click）：`switcherOpen = true` | `false` | 缺 |
| ①-2 | 打开后真实指针点 topbar 惰性点：`switcherOpen = true` | `false` | 缺 |
| ①-3 | 打开后按 `Esc`：`switcherOpen = true` | `false` | 缺 |
| ①-4 | 先开 switcher 再开 label：`details[open]` 计数 = **2** | 计数 = **1**（开第二个时第一个先关） | 缺 |
| ①-5 | 浮层遮挡：真实指针点 `[data-filter-label] > summary` 被 `[data-project-option="Orchestrator"]` 拦截（30s 超时） | 无遮挡（浮层已关） | 缺 |

**共同 selector（本轮的归并结论）**：`[data-dismiss-on-outside]`。②亦为其成员 —— 见 §2.2。

**实现提示（lane）**

- 单一 document 级规则：`$(document).on("click", function (e) { if (!$(e.target).closest("[data-dismiss-on-outside]").length) { $("[data-dismiss-on-outside][open]").removeAttr("open"); } });`
- 单开规则：`$(document).on("click", "[data-dismiss-on-outside] > summary", function () { var $self = $(this).closest("[data-dismiss-on-outside]"); if ($self.attr("open") !== undefined) return; $("[data-dismiss-on-outside][open]").not($self).removeAttr("open"); });` —— **`if ($self.attr("open") !== undefined) return;` 不可省**：派发时刻 `<details>` 尚未 toggle，一个已开的成员此刻正走在「关闭」的路上，不该把兄弟一起拖下水。
- `Esc`：在既有 `keydown` 的 Escape 分支内追加 `$("[data-dismiss-on-outside]").removeAttr("open");`（**不新建** keydown 绑定）。
- `closest` 判定不可换成「target === summary」：点菜单项、点 `<summary>` 内的 svg 都算「在自己内部」。

### 2.2 项② `B04.label-consistency` — Label 组件与 Priority/Assignee 一致

**块契约表**

| | |
|---|---|
| 块 | **B04 · Filters bar**（本轮改其 label 控制的外壳与文字处理，不改过滤语义） |
| 根 | `section#td-filters[data-filters]` |
| 控制 | `[data-filter-label]`（`<details class="dropdown" data-dismiss-on-outside data-filter-label-value="all">`） |
| 触发 | `[data-filter-label] > summary.td-label-trigger`（`role="button"`，`aria-haspopup="menu"`） |
| 值 | `[data-filter-label-summary]`（**保持钩子名不变**，仍由 `data-filter-label-value` 复述；R9 后渲染为**纯文本**） |
| 菜单 | `ul.dropdown-content.menu.td-label-menu` → `[data-filter-label-option]` × 17（`data-label-value`、选中者 `aria-current`） |
| 同排控件 | `[data-filter-assignee]` / `[data-filter-priority]`（`select.select-sm.td-select`）· `[data-filter-clear]` · `[data-filter-count]` |
| 本轮新增 | `data-dismiss-on-outside`（1 个属性）+ `src/input.css` 的两条规则（trigger 度量、trigger 内 summary 去装饰） |

| # | 现象（改前实测） | 期望（改后实测） | 差异类型 |
|---|---|---|---|
| ②-1 | 点外关闭：**已成立**（合成与真实点击皆为 `labelOpen = false`） | 仍为 `false`，但**改由 `[data-dismiss-on-outside]` 驱动** | 口径（归并） |
| ②-2 | `Esc` 关闭：`labelOpen = true`（**不关**） | `false` | 缺 |
| ②-3 | 与 `[data-project-switcher]` 并存：计数 2 | 计数 1（单一打开） | 缺 |
| ②-4 | 外壳 `28px` / `500` / `ink-2` / `padding 0 8px` | `30px`（= `.td-select`）/ `400` / `ink` / `padding 0 26px 0 8px` | 缺 |
| ②-5 | caret 无定位（内联流式） | 14px chevron，`right 6px`（内边距盒）/ 垂直居中 | 缺 |
| ②-6 | 内层 `[data-filter-label-summary]` 是 `badge td-chip td-chip-label`：`border 1px` + 着色底 + `999px` | `border 0` / 透明底 / `padding 0` / `radius 0` / `12px` / `400`（**纯文本**） | 缺 |
| ②-7 | 三控件同高：`30 / 30 / 28` | `30 / 30 / 30` | 缺 |
| ②-8 | 全局 `.td-chip-label` = 29 个，皆 pill | 计数仍 29；**非 trigger 的 28 个仍是 `999px` pill** | **一致（回归门）** |

**去内层双层装饰的做法（作用域口径）**：新规则 `design/prototype/src/input.css:.td-label-trigger [data-filter-label-summary]` 把内层压平，**全局 `.td-chip-label` 一字不动**。改后实测：`[data-filter-label-summary]` 仍**带着** `badge badge-sm td-chip td-chip-label` 三个类（DOM 未变，钩子与类都在），但它在 trigger 内**渲染为纯文本**；卡片 / 抽屉 / 两个弹窗里的 28 个 label chip 仍为 `border-radius: 999px` 的 pill。

**保留不动的口径（R3 的边界）**：`[data-filter-label]` 仍是 `<details class="dropdown">` 而**不是** `<select>`；`data-filter-label-value` 仍是值的唯一载体（写在**拥有 `[data-filter-label]` 钩子的元素**上）；17 个选项、`aria-current`、`[data-label-value]` 全部不变。

**Fork B 备选（已评估，未采用，供 Elon 复核）**

| 备选 | 内容 | 结论 |
|---|---|---|
| B2 | 把 label 改成原生 `<select>`（与 Priority/Assignee 完全同构） | **未采用**：推翻 R3 已定设计 —— 该控件的要害是「17 项 + 未展开态示值」（addendum 点名此控件），`<select>` 装不下这个形状。**列入 Report 供 Elon 复核。** |
| B3 | 反向把 assignee / priority 改成 dropdown | **未采用**：改动面更大，且要重写 `DESIGN.md` 组件表里 `select select-sm` 那一行（B04 之外的多处也共用 `.td-select`）。**列入 Report 供 Elon 复核。** |

### 2.3 项③ `B08/B13.list-two-state` — List 视图 loading ↔ data 二态互斥

**块契约表**

| | |
|---|---|
| 块 | **B08 · List view**（根）+ **B13 · Loading state**（其中一态） |
| 根 | `section[data-list][data-list-state="loading" \| "data"][hidden]` |
| 二态载体 | `[data-skeleton]`（`.td-list-group`，含 `list.loading` 文案与 3 条 shimmer 行）· `[data-list-rows]`（另一 `.td-list-group` 内的行宿主；同行还带 6 列 `.td-list-head`） |
| 静止态 | **`data`** —— 文档里 `[data-skeleton]` 带 `hidden`，`[data-list-rows]` 已是正常态 |
| 本轮新增 | `data-list-state`（1 个属性）+ `src/input.css` 的两条状态规则（见下） |

**二态定义**

| 态 | `[data-skeleton]` | `[data-list-rows]` | 同屏可见数 |
|---|---|---|---|
| `loading` | 可见（**无** `hidden`），`display: block` | `display: none`（且子元素计数 = 0） | **1** |
| `data` | `hidden`，`display: none` | `display: block`，子元素计数 ≥ 1（或空态行） | **1** |

**规则写在「状态」上，而不是逐元素 swap**（`design/prototype/src/input.css`）：

```css
[data-list][data-list-state="loading"] [data-list-rows],
[data-list][data-list-state="loading"] .td-list-group:not([data-skeleton]) { display: none; }

[data-list][data-list-state="data"] [data-skeleton] { display: none; }
```

- 第一条的两个 selector 各司其职：`[data-list-rows]` 那条**直接**落在被断言的元素上（父级 `display:none` 不会改变子元素自身的 computed `display`，只藏父级会让 §5 B9 的互斥计数读到 2）；`.td-list-group:not([data-skeleton])` 那条把**同组的 6 列列头**一起带走 —— 否则 loading 态会在「加载中」标题下多出一条无数据的 `ID / Title / …` 列头带。
- 因为规则读**属性**，`data` 态的静态文档（JS 未跑）就已满足互斥。

| # | 现象（改前实测） | 期望（改后实测） | 差异类型 |
|---|---|---|---|
| ③-1 | `[data-list]` 无状态钩子；`visibleOfPair = 2`（骨架与行同屏） | 属性存在；两种态各 `= 1` | 缺 |
| ③-2 | 切到 list 视图后立即：`skeletonDisplay = block`、`rowsDisplay = block`、行数 12 | `attr=loading` / 骨架 `block` / 行宿主 `none` / 行数 **0** | 缺 |
| ③-3 | 静止后：`skeletonDisplay = block`（骨架永不下台） | `attr=data` / 骨架 `none`（`hidden`）/ 行宿主 `block` / 行数 12 | 缺 |
| ③-4 | 文档静止态（JS 后）与 JS 前都是「两态同屏」 | 文档静止即为 `data` 态（骨架 `hidden`），与 JS 跑完后一致 | 缺 |

**原型把 loading 做成时间线（最小手段，供实现卡参考而非照抄）**：打开 list 视图 ⇒ 先 `loading`，`450ms` 后 `renderList()` 落 `data`。这让**两种态都可从界面复现**（截图 / 录屏 / 复跑都不需要测试后门）。**硬要求仍是**：任何时刻两态在 DOM 上互斥且可由 selector 机检。过滤条的一次 re-render（`applyFilters`）**不**重进 loading —— 它直接调 `renderList()`，只有**进入视图**才是「一次取数」。

**对既有截图集的影响（必须显式）**：`06-list-view` 等列表帧现在**必须等落定**（探针等 900ms）。`design/prototype/README.md` 的截图段已记录本轮的过期范围与重拍注意事项。

---

## 3. 与既有轮次的边界（正交声明，必须显式）

| 本轮项 | 与既有轮次的关系 |
|---|---|
| ① `B02.dismiss` | **正交于 R7/R8**（不动 topbar 布局、不动 brand、不动 revision 组）；**正交于 R3/R5**（不动 label chip 本体）。① 改的是这**一个 `<details>` 的关闭来路**，bar 上其它控制一字未动。 |
| ② `B04.label-consistency` | **正交于 R5**（R5 是 B25「label 控制」= 创建弹窗 / 抽屉里的可编辑 label 组合框；本轮是 **B04 过滤条里的 label 筛选项**，两者共用 label 名册但没有任何 DOM 交集 —— 本轮的 `.td-chip-label` 作用域正是为了保证不碰到 R5 的 chip）。**正交于 R3**（R3 定了「label 过滤是 dropdown 不是 select」；本轮**不改**这个结论，只改它的外壳度量与文字处理）。 |
| ③ `B08/B13.list-two-state` | **与 R8 有接触但正交**：R8 给了 `.td-list-head` 6 轨模板并规定**加载态头跨满**（`grid-column: 1 / -1`）；本轮把加载态**整组**在 `data` 态下架 —— 那条跨满规则在 `loading` 态仍原样生效，未被替代。**正交于 R7**（不碰侧栏 footer / 抽屉关闭按钮）。 |

**本轮无「无设计变更」项。** 三项都是设计变更（原型侧同样没有对应口径）：① 完全无 outside-click；② 关闭行为两端不同源、几何不一致；③ 无状态钩子。三项的**原型改动已随本卡落地**（`index.html` / `app.js` / `src/input.css` / `tw.css` 重建），并已同步 `design/DESIGN.md` §25 与 `design/BLOCKS.md`。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

| # | 项 | 块 | selector / hook | 期望 | 改前（原型实测） | 差异类型 |
|---|---|---|---|---|---|---|
| 1 | ① | B02 | `[data-project-switcher]` | 带 `data-dismiss-on-outside` | 无该属性 | 缺 |
| 2 | ① | B02 | `[data-project-switcher] > summary` | 触发（`<summary>` 即触发） | 同 | **一致** |
| 3 | ① | B02 | `[data-project-switcher][open]` | 点外 / `Esc` 后计数 0 | 点外与 `Esc` 后皆 1 | 缺 |
| 4 | ① | B02 | `[data-dismiss-on-outside][open]` | 任一时刻计数 ≤ 1 | 与 label 同开时 = 2 | 缺 |
| 5 | ② | B04 | `[data-filter-label]` | 带 `data-dismiss-on-outside` | 无该属性（有专属 handler） | 口径 |
| 6 | ② | B04 | `.td-label-trigger` | `height/min-height 30px` | `28px` | 缺 |
| 7 | ② | B04 | `.td-label-trigger` | `font-weight 400` / `color` = ink | `500` / ink-2 | 缺 |
| 8 | ② | B04 | `.td-label-trigger` | `padding 0 26px 0 8px` | `0 8px` | 缺 |
| 9 | ② | B04 | `.td-label-trigger > .td-icon-sm` | 14px、`right 6px`（内边距盒）、垂直居中 | 内联流式、无定位 | 缺 |
| 10 | ② | B04 | `[data-filter-label-summary]` | `border 0` / 透明底 / `padding 0` / `radius 0` | `1px` / 着色底 / `2px 4px 2px 8px` / `999px` | 缺 |
| 11 | ② | B04 | `[data-filter-label-summary]` | 钩子名不变、仍复述 `data-filter-label-value` | 同 | **一致** |
| 12 | ② | B04 | `[data-filter-assignee]` / `[data-filter-priority]` | `height 30px`、不动 | `30px` | **一致** |
| 13 | ② | B04 | 三控件同高 | `30 / 30 / 30` | `30 / 30 / 28` | 缺 |
| 14 | ② | B04 | `[data-filter-label-option]` × 17 + `aria-current` | 不动 | 17 项、选中者 `aria-current` | **一致** |
| 15 | ② | B25/全局 | `.td-chip-label` | **不动**（非 trigger 者仍 `999px` pill） | `999px` | **一致（回归门）** |
| 16 | ③ | B08 | `[data-list]` | 带 `data-list-state`，静止 = `data` | 无该属性 | 缺 |
| 17 | ③ | B08 | `[data-list][data-list-state="loading"] [data-list-rows]` | `display: none`、子元素 = 0 | 可见、12 行 | 缺 |
| 18 | ③ | B08 | `[data-list][data-list-state="data"] [data-skeleton]` | `hidden` / `display: none` | 可见（永不下台） | 缺 |
| 19 | ③ | B13 | `[data-skeleton]` | 仅 `loading` 态可见；含 1 条文案 + 3 条 shimmer 行 | 3 条 shimmer 行（无态） | 缺 |
| 20 | ③ | B08/B13 | 互斥计数（骨架 + 行宿主中 `display ≠ none` 者） | **1** | **2** | 缺 |
| 21 | ③ | B08 | `[data-list-rows] .td-list-row` × n | `data` 态下 ≥1（本原型 12） | 12（但与骨架同屏） | **一致（数量）** |
| 22 | ③ | B13 | `[data-skeleton] .td-list-head > :only-child` | `grid-column: 1 / -1`（R8 规则） | 同（R8 已生效） | **一致** |

### 4.2 匹配项（本轮三项命中的既有块，逐个列明）

| 命中的块 | 命中处 | 本轮对它做什么 | 不做 |
|---|---|---|---|
| **B02 · Top bar** | `[data-project-switcher]` | 加 `data-dismiss-on-outside`；进 R9 的单一 document 规则 | 不动 brand / search / view toggle / revision / `[data-new-task]` / bar 的两行折行 |
| **B04 · Filters bar** | `[data-filter-label]` 与其 trigger | 加 `data-dismiss-on-outside`；trigger 度量对齐 `.td-select`；trigger 内 summary 去装饰 | 不动 assignee/priority 两个 `<select>`、不动 `[data-filter-clear]` / `[data-filter-count]`、不动 17 个选项与 `aria-current`、不动 `data-filter-label-value` 的载体 |
| **B08 · List view** | `[data-list]` 根与其两个 group | 加 `data-list-state`；写两条状态规则（其中一条带走数据组的列头） | 不动 R8 的 6 轨列模板、不动 6 个行 cell 的钩子集、不动 `template[data-list-row-template]`、不动行 ID 的 R8 截断 |
| **B13 · Loading state** | `[data-skeleton]` | 成为 `loading` 态的**唯一**载体；文档静止时 `hidden` | 不动 3 条 shimmer 行、不动 `list.loading` 文案 key、不动 B18 里那份静态 `[data-loading-state]` 演示 |
| **B03 · Sidebar**（旁及） | `[data-view="list"]` / `[data-nav-item="list"]` | 只影响「切到 list 视图」的**时序**（先 loading 后 data） | 不动 `aria-pressed` / `aria-current` 的写入逻辑 |
| **B18 · States showcase**（旁及） | `[data-loading-state]` | 无 | 不动 —— 它是**卡片级**加载演示，与本轮的**列表级** `[data-skeleton]` 不是同一个东西 |

### 4.3 负向注记清单

| # | 注记 |
|---|---|
| 1 | 本轮**不**改任何 `web/**` 与 `test/**`（卡的红线：无实现代码）。 |
| 2 | 本轮**不**引入新块；只新增两个**属性**钩子（`data-dismiss-on-outside`、`data-list-state`），无新类名成为契约锚。 |
| 3 | 本轮**不**改全局 `.td-chip-label` / `.td-chip` / `.badge`：去装饰一律在 `.td-label-trigger` 作用域内（§2.2）。 |
| 4 | 本轮**不**给 B22/B24/B25 的名册菜单与卡片浮层换 dismiss 规则：它们从非 `<details>` 的触发器浮出，规则不同源（§2.1 表「Untouched」）。 |
| 5 | 本轮**不**改 `.td-select`（assignee / priority 的现值就是目标值；改它们是另一张卡）。 |
| 6 | 本轮**不**重拍截图集：R9 的改动落在 filters 条与列表帧上，**整集尚未重拍**，`design/prototype/README.md` 截图段已如实记录过期范围。 |
| 7 | 本轮**不**用 `popover` 属性重写触发结构（§2.1 的 A2 备选：与 `<details>` 不兼容，需重写触发，评估为过重）。 |

---

## 5. 机检断言清单（供实现卡「During」直接落测）

**禁行号锚**；每条只写「selector → 断言 → 期望」。

**落点（三类各一处，均属实现卡范围，本轮不改）**

| 类 | 落点 | 判据 |
|---|---|---|
| A · 结构 | `test/web/blocks.contract.mjs`（既有 rule kinds）+ `web/manifests/board-m2.json` 的 `blocks` | 节点计数 / 存在性 / 钩子集 |
| B · 计算样式与几何 | `web/manifests/board-m2.json` 的 `style.targets`，由 `ui-align board-m2 --strict` 执行（R6/R8 的 `r6-*` / `r8-*` 行即在此）；细粒度几何可另落 `web/scripts/dom-smoke.mjs` | `getComputedStyle` / `getBoundingClientRect` 的实测值 |
| C · 交互 | 驱动层（`web/scripts/dom-smoke.mjs` 或截图/探针脚本） | 真实事件驱动的状态变化 |

实现卡的 Acceptance 把 B 类绑在 **`ui-align board-m2 --strict` 0 失败**上，所以 §5 B 的每一行都应成为 `board-m2.json` 里的一条 target（新增行按既有 `rN-*` 命名惯例，例如 `r9-label-trigger` / `r9-list-skeleton`），而不是只写在脚本里。

### A. 结构类（`blocks.contract`）

| # | selector | 断言 | 期望 |
|---|---|---|---|
| A1 | `[data-project-switcher]` | 属性存在 | 含 `data-dismiss-on-outside` |
| A2 | `[data-filter-label]` | 属性存在 | 含 `data-dismiss-on-outside` |
| A3 | `[data-dismiss-on-outside]` | 元素为 `<details class="dropdown">`；两成员皆在其中 | 原型 = 2（`[data-project-switcher]` · `[data-filter-label]`）。**不得**断言「恰好 2」当成上限 —— 成员资格是开放的（§8 R2），第三个 dropdown 加上该属性即可入册，计数只会变多 |
| A4 | `[data-list]` | 属性存在 | 含 `data-list-state`；取值 ∈ {`loading`, `data`} |
| A5 | `[data-list][data-list-state="loading"] [data-list-rows]` | 子元素计数 | `0` |
| A6 | `[data-list][data-list-state="data"] [data-list-rows]` | 子元素计数 | `>= 1`（或空态行） |
| A7 | `[data-skeleton]` | 计数 | `1`（B18 的 `[data-loading-state]` **不是** `[data-skeleton]`，不计入） |
| A8 | `[data-skeleton] .td-list-head > *` | 计数 | `1`（R8 口径保持） |
| A9 | `[data-filter-label-summary]` | 计数 | `1`（钩子名未变） |
| A10 | `[data-filter-label-option]` | 计数 | `17`（不变） |

### B. 计算样式 / 几何类（`dom-smoke`）

| # | selector | 断言 | 期望 |
|---|---|---|---|
| B1 | `.td-label-trigger` | `height` / `min-height` | `30px` / `30px` |
| B2 | `.td-label-trigger` | `font-weight` / `font-size` | `400` / `12px` |
| B3 | `.td-label-trigger` | 与 `[data-filter-assignee]`、`[data-filter-priority]` 的 `height` | **三者相等** |
| B4 | `[data-filter-label-summary]` | `border-top-width` | `0px` |
| B5 | `[data-filter-label-summary]` | `background-color` | 透明（`rgba(0, 0, 0, 0)`） |
| B6 | `[data-filter-label-summary]` | `border-radius` | **≠** `999px`（实测 `0px`） |
| B7 | `.td-chip-label:not([data-filter-label-summary])` | `border-radius`（**回归门**） | `999px`（全局 pill 未被作用域规则波及） |
| B8 | `[data-list][data-list-state="loading"]` | `[data-skeleton]` 的 `hidden` 属性 | **无**；`[data-list-rows]` 的 `display` = `none` |
| B9 | `[data-list]`（任一态） | `[data-skeleton]` 与 `[data-list-rows]` 中 `display ≠ none` 的计数 | **`=== 1`** |
| B10 | `[data-list][data-list-state="data"]` | `[data-skeleton]` 的 `hidden` 属性 / `display` | **有** / `none` |
| B11 | `.td-label-trigger > .td-icon-sm` | 尺寸 / 右边距 / 垂直偏移 | `14px`×`14px` / `6px`（**内边距盒**，即边框盒 `7px`）/ `0px` |
| B12 | 页面（各视口） | `scrollWidth <= clientWidth + 1` | 全 `true` |

### C. 交互类（驱动层：真实点击 / 键盘）

| # | 场景 | 断言 | 期望 |
|---|---|---|---|
| C1 | 开 `[data-project-switcher] > summary` | `[data-project-switcher][open]` | 存在 |
| C2 | 接 C1，点 `[data-filter-count]`（合成 click） | `[data-dismiss-on-outside][open]` 计数 | `0` |
| C3 | 接 C1，真实指针点**惰性点**（命中测试选出，见 §1 规则 3） | 同上 | `0` |
| C4 | 开 `[data-filter-label] > summary`，再点 `[data-filter-count]` | 同上 | `0` |
| C5 | 先开 switcher 再开 label | `[data-dismiss-on-outside][open]` 计数 | `<= 1`，且开的是 label |
| C6 | 任一成员打开时按 `Esc` | `[data-dismiss-on-outside][open]` 计数 | `0` |
| C7 | 切到 list 视图后**立即**取样 | `data-list-state` / 骨架 `display` / 行宿主 `display` / 行数 | `loading` / `block` / `none` / `0` |
| C8 | 等落定后取样 | 同上 | `data` / `none` / `block` / `>= 1` |
| C9 | 语言切 `zh` 后重跑 C7/C8 | 同上（文案变、态不变） | 同 C7/C8 |

### C′. 「不得断言」的负向注记

| # | 不得断言 | 原因 |
|---|---|---|
| C′1 | caret 右边距「`6px`」在**边框盒**上量 | `right: 6px` 的定位区域是内边距盒；边框盒实测 `7px`（§1 R9-1）。 |
| C′2 | `[data-filter-label-summary]` 的类名被移除 | 本轮**保留** `badge td-chip td-chip-label` 三个类，只靠作用域规则压平；断言「类没了」会与实现相反（§2.2）。 |
| C′3 | `.td-chip-label` 全文档计数下降 | 计数仍为 `29`；被压平的是**渲染**，不是 DOM 成员（§2.2）。 |
| C′4 | `data-list-state` 与骨架的 `hidden` **各自**独立成立 | 两者由同一次写入同时落（`setListState`），断言应查**一致性**（态为 `loading` ⇔ 骨架无 `hidden`），不得只查其一。 |
| C′5 | 依赖 loading 态的**时长** | `450ms` 是原型的演示节拍，不是契约；契约只要求「两态互斥 + 两态可复现」。实现侧可以是任意真实取数时长。 |
| C′6 | 用 `:has()` 或类名选到「数据组」 | 契约锚是 `[data-list-rows]` 与 `[data-skeleton]` 本身；`.td-list-group:not([data-skeleton])` 只是原型 CSS 的实现细节，不是契约（§2.3 已注明它为何存在）。 |

---

## 6. 证据与复跑

**探针**：`workspace/T-20261012-224743/verify/r9-probe.mjs`（Playwright / Chromium headless，视口 1512×950，`file://` 打开原型，`console` / `pageerror` 收集）。
**原始记录**：`verify/probe-before.json`（改动前）· `verify/probe-after.json`（改动后）。**均不进仓**。

**「改前」是怎么测到的（可复核）**：`verify/pristine-prototype/` 是 HEAD 版原型的一份**独立副本**（`index.html` 284400 + `app.js` 110933 + `tw.css` 191414 bytes，逐字取自 `git show HEAD:design/prototype/*`，`vendor/` 原样拷贝），探针以 `R9_PROTO=<该副本>/index.html` 对它实测。因此「改前」一栏是**同一探针对同一原型的旧版重跑**，不是推断，也不是从 diff 反读。

**断言表（机器产出）**：`verify/r9-assertions.md` —— 由 `verify/compare.mjs` 读两份 JSON 生成，51 条逐行列出 `selector → 断言 → 期望 → 改前 → 改后 → ✔`，**51/51 通过**；表尾附「探针之外的静态计数」直接量 `design/prototype/index.html`（`data-dismiss-on-outside` = 2 · `data-list-state` = 1 · `[data-skeleton]` = 1 · `[data-filter-label-summary]` = 1 · `[data-filter-label-option]` = 17）。

| 画面 | 命名 | 取证什么 |
|---|---|---|
| 项目下拉打开 | `r9-<label>-switcher-open.png` | ① 的打开态（浮层压在 filters 条上） |
| 点外部之后 | `r9-<label>-switcher-after-outside.png` | ① 的关闭（改前同帧仍开、改后已关） |
| label 下拉打开 | `r9-<label>-label-open.png` | ② 的 trigger 外观（与前两控件同壳同字） |
| 点外部之后 | `r9-<label>-label-after-outside.png` | ② 的关闭 |
| 切到 list 的瞬间 | `r9-<label>-list-switch.png` | ③ `loading` 态（改前同帧是「骨架 + 12 行」同屏） |
| 落定之后 | `r9-<label>-list-settled.png` | ③ `data` 态 |
| **脚本关闭** | `r9-<label>-no-js.png` | 关闭 JS 后结构仍在：两个 dismiss 成员与 `data-list-state` 都在，静止态自洽（`data` + 骨架 `hidden`），18 张卡照常渲染，trigger 仍 30px |

**硬门（两轮皆通过）**：`console` = 0、`pageerror` = 0。

**实现侧证据口径**：本契约对实现侧的断言一律标「实读」，**未**构建 `web/dist` 实测；实现卡的「During」应把 §5 的 A/B/C 三类落成真正的机检（`test/web/blocks.contract.mjs` · `web/manifests/board-m2.json` + `ui-align board-m2 --strict` · 驱动层），验证卡（Turing）独立复跑同一张表。

---

## 7. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/DESIGN.md` | **新增 §25「Review round R9 — one dismiss rule, one filter control, two list states」**：25.1 单一 dismiss 规则与成员/非成员；25.2 label trigger 与 `.td-select` 同度量、作用域压平、B2/B3 备选被评估未采用；25.3 list 二态与「状态规则而非逐元素 swap」的理由；25.4 实测对照。**另改 §18.2 组件表**：`label filter` 的 daisyUI 列由 `dropdown + menu + badge` 改为 `dropdown + menu (R9: the value is flat text, not a badge)` | **已改** |
| `design/BLOCKS.md` | **B02**：switcher 行加 `data-dismiss-on-outside` + 新增「Floating controls — the light-dismiss rule (R9)」小节（成员 / 非成员 / 单开 / `<summary>` 口径）；**B04**：label 行加属性 + R9 段落（度量、作用域、与两个 `<select>` 的关系）；**B08**：根加 `data-list-state` + R9 段落；**B13**：整节重写为表（根 / 态 / 文案）+ 二态互斥与「时间线」注记；**Auxiliary hooks**：`[data-filter-label-summary]` 描述改为「flat text」，新增 `[data-dismiss-on-outside]`、`data-list-state` 两行 | **已改** |
| `design/prototype/README.md` | **规格清单外的增项**（与 R7/R8 同理：该文件描述的就是被改的原型）：Interaction map 增 `I16`（light dismiss）与 list 载入行、label 行改写；表后补 R9 规则段与「list 视图是时间线」段；截图段**新增 R9 过期声明**；`app.js` 行补 I15/I16；Coverage 表 Loading 行；构建段落 `139 KB → 188 KB`（并注明旧值早已过期） | **已改** |
| `design/prototype/src/input.css` / `tw.css` | 三处规则（`.td-label-trigger` 度量、`.td-label-trigger [data-filter-label-summary]` 压平、两条 list 状态规则）；`tw.css` 按既有流程重建（`192093` bytes） | **已改 + 已重建** |
| `src/styles/tokens.css`（实现侧 token）/ `design/DESIGN.md` 的 token 表 | **无新增、无改动** —— 三项都用既有 token（`--color-td-ink`、`--color-td-surface`、`--color-td-line`、`--r-md`、`.td-select` 已在用的同一组值） | **不改（有意）** |
| `design/fidelity-r6.md` / `-r7` / `-r8` | **不改**：本轮与它们正交（§3），旧契约仍成立 | **不改（有意）** |
| `test/**` / `web/**` | **不改**（卡的红线：无实现代码） | **不改（红线）** |

---

## 8. 口径红线与未覆盖项

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | 浮层的「点外关闭」只由 `[data-dismiss-on-outside]` 决定；**不得**再为某个控制写「按钩子名匹配」的专属关闭逻辑（那是 R9 归并掉的那一份）。 |
| R2 | 成员资格靠**属性**，不靠类名、不靠 selector 清单；新增成员只加属性，不改 handler。 |
| R3 | `.td-chip-label` 是卡片 / 抽屉 / 弹窗 label chip 的载体，**不得**为过滤条的视觉需求改动它；压平只能作用域在 `.td-label-trigger` 内。 |
| R4 | `[data-filter-label]` 不得退化为原生 `<select>`（R3 已定：17 项 + 未展开示值）。 |
| R5 | 列表二态只能由 `[data-list]` 的 `data-list-state` 表达，且**同一次写入**同时决定骨架的 `hidden`；不得出现「属性说 loading、骨架却带 `hidden`」的分叉。 |
| R6 | 二态互斥必须**在静态文档里就成立**（读属性），不得只靠脚本在 render 时逐元素切换。 |

**未覆盖项（明确不在本轮，留给后续裁定）**

| # | 项 | 说明 |
|---|---|---|
| F1 | **B22/B24/B25 名册菜单与卡片浮层**的 dismiss 规则 | 它们从非 `<details>` 的触发器浮出，改造成本与语义都不同（`.td-combo` 有键盘循环、卡片菜单有 `stopPropagation` 交互）。本轮只**声明它们不是成员**，不统一。若 Terry 后续反馈「卡片菜单点外不关」，另开卡。 |
| F2 | `.td-select` 的 `<select>` 与 label dropdown 的**语义**差异 | 本轮统一的是**外壳与文字度量**，不是控件语义：两个 `<select>` 仍由表单值承载，label 仍由 `data-filter-label-value` 承载。 | 
| F3 | 实现侧（`web/**`）的对应位点 | 本轮**未**实读 `web/dist`，也**未**读 `web/src` 的对应组件（超出卡的红线）。实现卡的位点由实现卡自证；本契约只给 selector 与断言。 |
| F4 | 截图集重拍 | 见 §4.3 注记 6 / `design/prototype/README.md` 截图段的 R9 声明。 |
| F5 | loading 态的**时长 / 抖动** | 契约不管时长（§5 C′5）；真实取数时长由实现决定，重拍时需等落定。 |
