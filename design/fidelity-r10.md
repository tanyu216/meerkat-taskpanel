# UI 保真契约 · R10 — Terry 三项（board 空态 · 详情自动保存 · 创建弹窗 description 高度）

> 卡：`T-20261012-230448` · 日期 2026-10-12 · 范围「R10：Terry 三项 taskpanel UI 反馈」。
> 来源：Terry 2026-10-12 23:04 对 taskpanel（http://localhost:9527）的三项反馈 —— ① board 视图无任务卡时仍显示正常 board 组件；② 任务卡详情里 Assignee / Reporter / tag 三项编辑不自动保存；③ 创建任务弹窗的 description 组件不占满可用区域。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 证据口径：本契约的每条断言都在**真实浏览器（Chromium headless / Playwright）里对原型实测**，「期望值」即实测值；改前（before）与改后（after）各测一轮，两份原始记录见 §6。
> 关系卡：实现卡（`web/**` 镜像改动）与验证卡由 Elon 派发；**本卡只产契约与原型改动，不含实现代码**。
> 基线 commit：`241bc67`（本卡开工时的 HEAD）。同族前序：R9〔`T-20261012-224743`〕已 `done`，本卡复用其状态机口径。

## 0. 结论摘要

- 三项**全部落在既有块**（① B05/B12 · ② B09/B22/B25 · ③ B10/B23）⇒ 本契约**不引入新块**；新增三个钩子族：`[data-board-view]` 的 `data-board-state`、抽屉的 `[data-detail-save]`/`data-save-state` + `[data-detail-save-error]` + `data-detail-save-field`、以及一条 `.td-two-col` 拉伸链。
- **① 的根因是条件写窄了**：`design/prototype/app.js:applyFilters()` 的 empty 条件为 `total > 0 && shown === 0`，只覆盖「有任务但被筛掉」；`total === 0`（真·空 board）时 no-results 保持 `hidden`，7 个空列照常绘制。改前实测：真·空 board 下**被绘制的 `[data-column]` = 7**、board 级可见块 = 1（可见的是 board）；筛选全隐时**两个状态块同屏**（可见计数 = **2**）。改后两种路径皆为 **1**，且可见的是 `[data-empty][data-empty-kind="no-results"]`。
- **② 的根因是「完全没有提交路径」**：`renderDetail()` 只回填三个控件，`[data-detail-assignee-label]` / `[data-detail-reporter-label]` / `[data-detail-label-input]` 没有任何 focus-loss / change 落点，也没有失败反馈。改后为**变更即存**：单值字段在**失焦且值变**或选中名册行时提交，labels 在 chip 接受/移除时提交；统一状态区 `[data-detail-save]` 的 `data-save-state` ∈ `idle|saving|saved|error`，错误块 `[data-detail-save-error]` 只在 `error` 态可见。
- **③ 的根因是三处断链**：`.td-two-col{align-items:start}` 不拉伸 + `.td-field-grow` 是块容器（子元素的 `flex: 1 1 auto` 无处解析）+ `.td-md-panes{height:clamp(280px,46vh,520px)}` 写死。改后 1512×950 实测：编辑器底边到行底边的空隙 **65px → 0**，`.td-md-panes` **437px → 502px**。
- **① 复用 R9 口径**：R9 定了 list 的 `[data-list][data-list-state]`（视图根属性枚举状态 + 恰一可见），本卡的 board `empty↔data` **不重新定义**，逐条对齐（状态根 + 两个直接子级 + 同一次写入同时决定 `hidden`）。
- **三项均有 selector 级机检断言**（§5 A/B/C 三类），供实现卡「During」直接落测；**§5 C′ 列出 7 条「不得断言」**。
- **token 无新增、无改动**：错误块用既有 `--color-td-danger` / `--color-td-danger-soft` / `--r-md`，拉伸链用既有 `--col-gap` 一族之外无任何新值。
- **两处按实测偏离设计初稿，已在 §2 逐条记明**：`[data-board-view]` 用 `display:flex; flex-direction:column` 而非 `display:block`（后者实测把 board 压到 331.56px，见 §2.1.2）；`.td-field-grow` 补 `display:flex; flex-direction:column`（否则第 ③ 链在它这一环断掉，见 §2.3.2）。

---

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / `getBoundingClientRect` / `getClientRects` / DOM 计数 / 真实指针与键盘），不是 `src/input.css` 某条声明的字面值；两者不一致时实测值胜。
2. 「改前 / 改后」= 同一探针脚本（`workspace/T-20261012-230448/verify/r10-probe.mjs`）在原型改动前后各跑一次，同一视口族（1512×950 / 1120×800 / 760×900）、同一语言（en）、同一主题（light）；原始记录 `verify/probe-before.json` / `verify/probe-after.json`。
3. 「改前」是对 **HEAD 版原型的一份独立副本**实测的（`verify/pristine-prototype/`，逐字取自 `git show 241bc67:design/prototype/*`）—— 同一探针对同一旧版重跑，不是推断，也不是从 diff 反读。
4. 「可见」分两种度量，**必须分清**：`computed display ≠ none` 只对被状态规则**直接写入**的元素成立（`[data-board]` / `[data-empty][data-empty-kind="no-results"]`）；对它们的**后代**（如 `[data-column]`）**不成立** —— 父级 `display:none` 不改变子元素自身的 computed `display`。后代一律用 `getClientRects().length` 判定「是否被绘制」。这是 R9 §2.3 记下的同一条区分，A4 就写在它上面。
5. 本轮原型 `console` / `pageerror` 均为 `[]`（两轮皆是）。
6. 实现侧本轮**未到场实测**（未构建 `web/dist`）；凡涉及实现的位点均标注「实读」。

**共用实测值（原型，1512×950，light，en）**：

| 量 | 改前 | 改后 |
|---|---|---|
| `[data-board-view]` 元素数 | 0 | **1** |
| `[data-board-view]` 的 `data-board-state` | 无该元素 | **`data`（静止态）** |
| data 态：board 级两状态块可见计数 | 1 | 1 |
| **筛选全隐**（`shown === 0`, `total > 0`）：可见计数 | **2** | **1** |
| **真·空 board**（`total === 0`）：可见的是 | **`[data-board]`** | **no-results 空态** |
| 真·空 board 下**被绘制**的 `[data-column]` 数 | **7** | **0** |
| `[data-board]` 的 `getBoundingClientRect().height`（data 态） | `812px` | `812px`（不变） |
| `.td-main` height / `[data-column]` height | `894px` / `808px` | `894px` / `808px`（不变） |
| `[data-detail-save]` 元素数 / `data-save-state` | 0 / 无 | **1 / `idle`** |
| `[data-detail-save-error]` 元素数 / 静止 `hidden` | 0 / — | **1 / 有** |
| `data-detail-save-field` 计数 / 取值 | 0 / — | **3 / `assignee`、`reporter`、`labels`** |
| `.td-two-col` 计算 `align-items` | `start` | **`stretch`** |
| `[data-create-left]` height（1512×950） | `608.5px` | **`673.5px`** |
| `.td-two-col` 行高 / `[data-create-right]` height | `673.5px` / `673.5px` | `673.5px` / `673.5px`（不变） |
| `.td-md-editor` 底边与**行底边**的空隙 | **`65px`** | **`0px`** |
| `.td-md-editor` height / `.td-md-panes` height | `476px` / `437px` | `541px` / **`502px`** |
| `.td-md-source` height / `overflow-y` | `437px` / `auto` | `502px` / `auto`（写侧自滚动不变） |
| `.td-modal-box` scrollHeight / clientHeight（1512×950） | `799` / `799` | `799` / `799`（无内部溢出） |
| `.td-modal-box` scrollHeight / clientHeight（1120×800） | `799` / `750` | `799` / `750`（**49px 内部滚动，两轮相同**） |
| `.td-two-col` 计算 `grid-template-columns`（760×900） | `710px`（单列） | `710px`（单列） |
| `.td-md-editor` height（760×900） | `399px` | `399px` |
| `data-i18n*` 钩子数（`index.html`） | 468 | **468（不变）** |
| `MESSAGES` 键数（`app.js`） | en 220 / zh 220 | **220 / 220（不变）** |

---

## 2. 逐项契约

### 2.1 项① `B05/B12.board-two-state` — board 视图 empty ↔ data 二态互斥

**块契约表**

| | |
|---|---|
| 块 | **B05 · Board**（根）+ **B12 · Empty states**（其中一态） |
| 状态根 | `div[data-board-view][data-board-state="data" \| "empty"]` |
| 两个状态块 | `[data-board]`（data 态）· `[data-empty][data-empty-kind="no-results"]`（empty 态）—— **都是状态根的直接子级** |
| 静止态 | **`data`** —— 文档里 no-results 带 `hidden`，`[data-board]` 正常 |
| 判定 | `empty ⇔ 可见卡片数 === 0`；`data ⇔ 可见卡片数 > 0` |
| 本轮新增 | `data-board-state`（1 个属性）+ 状态根元素 1 个 + `src/input.css` 的 2 条规则（1 条透传、1 条互斥） |

**二态定义**

| 态 | `[data-board]` | `[data-empty][data-empty-kind="no-results"]` | 同屏可见数 |
|---|---|---|---|
| `data` | 可见（**无** `hidden`），`display: flex` | `hidden`，`display: none` | **1** |
| `empty` | `hidden`，`display: none` | 可见（**无** `hidden`），`display: flex` | **1** |

**规则写在「状态」上，而不是逐元素 swap**（`design/prototype/src/input.css`）：

```css
[data-board-view][data-board-state="empty"] [data-board],
[data-board-view][data-board-state="data"] [data-empty][data-empty-kind="no-results"] {
  display: none;
}
```

- 状态根同时是 `[data-main]` 的 flex 透传层：`display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0;`。
- 因为规则读**属性**，`data` 态的静态文档（JS 未跑）就已满足互斥 —— 与 R9 的 list 二态同一条理由。
- **`[data-empty][data-empty-kind="column"]` 不是成员**：它是列内空态（B12 的 column 变体，全文档 7 个，一列一个），属于那一列，不属于视图；纳入 board 级计数会把它数两遍。

**项①的 two-state 与 view 的关系**（必须显式）：board 视图与 list 视图是**两件正交的事**。`setView("list")` 隐藏的是**整个 `[data-board-view]`**（状态根），不是 `[data-board]` —— 否则 board 级空态会被落在 list 上方。实测：list 态下 `[data-board-view]` 被绘制数 = 0（改前靠直接隐藏 `[data-board]` 达到同一视觉结果，改后由状态根承担；两种写法在 `display` 读数上不可区分，见 C′4）。

| # | 现象（改前实测） | 期望（改后实测） | 差异类型 |
|---|---|---|---|
| ①-1 | 真·空 board（`total === 0`）：no-results `hidden`，7 个空列照常绘制 | `data-board-state="empty"`；no-results 可见；被绘制列 = **0** | 缺 |
| ①-2 | 筛选全隐（`total > 0 && shown === 0`）：**两个状态块同屏**，可见计数 = 2 | 可见计数 = **1**，且可见者是 no-results | 缺 |
| ①-3 | 两状态块是 `[data-main]` 下的兄弟，**无互斥机制** | 互为直接子级，由状态根的属性 + 两条 CSS 规则互斥 | 缺 |
| ①-4 | 无 board 级状态钩子 | `[data-board-view][data-board-state]` 存在，取值 ∈ {`data`, `empty`} | 缺 |
| ①-5 | 回退到 data：board 可见、no-results `hidden` | 同（`data` 态自洽） | **一致** |
| ①-6 | data 态 `[data-board]` 812px / 列 808px / `.td-main` 894px | `812 / 808 / 894`（**布局零变化**） | **一致（回归门）** |
| ①-7 | 列内空态（`data-empty-kind="column"`）7 个 | 7 个（**不受状态规则影响**） | **一致（回归门）** |

### 2.1.1 与 R9 口径的同源声明

| 维度 | R9（list） | R10（board） |
|---|---|---|
| 状态载体 | `[data-list]` 的 `data-list-state` | `[data-board-view]` 的 `data-board-state` |
| 状态取值 | `loading` \| `data` | `empty` \| `data` |
| 成员数 | 2（骨架 / 行宿主） | 2（board / no-results 空态） |
| 互斥判据 | 两者 `display ≠ none` 的计数 `=== 1` | 同 |
| 写入方式 | `setListState()` 一次写入属性 + `hidden` | `setBoardState()` 一次写入属性 + 两个 `hidden` |
| CSS | 读属性，静态即成立 | 读属性，静态即成立 |

**不重复定义**：R9 的 R5/R6 红线（二态只能由属性表达、同一次写入、静态即互斥）**原样适用于 board**，本契约只把它们的名字从 `data-list-state` 换成 `data-board-state`。

### 2.1.2 偏离设计初稿之一：状态根是 flex 透传层，不是 `display:block`

设计初稿开的是 `[data-board-view]{display:block; min-width:0}`，理由是「不改变 `[data-main]` 的 flex 上下文行为」。**实测与这个理由相反**（`verify/wrapper-experiment2.mjs`，1512×950）：

| 状态根的规则 | 状态根 height | `[data-board]` height | 首个 `[data-column]` height |
|---|---|---|---|
| 不包状态根（现状） | — | **812px** | 808px |
| `display: block` | 331.56px | **331.56px** | 327.56px |
| `display: flex; flex-direction: column; flex: 1 1 auto` | 812px | **812px** | 808px |

原因：`.td-main` 是列 flex 容器，`.td-board` 的 `flex: 1 1 auto` **只能对着 flex 父级解析**。状态根若是块容器，`[data-board]` 就成了块级 flex 容器、高度回落到内容高度，列身自滚动一并消失（这会让 R6/R8 已锁的 board 几何整体失守）。

⇒ 采用**透传层**写法，保留初稿声明的意图（不改 `[data-main]` 的 flex 行为），改掉它的字面值。§5 B 类断言里的 B-1 就是这条回归门。

### 2.2 项② `B09.drawer-autosave` — 详情 Assignee / Reporter / tag 自动保存

**块契约表**

| | |
|---|---|
| 块 | **B09 · Task detail drawer**（本轮给它一个状态区与三个字段钩子）；字段控件本体仍属 **B22**（assignee / reporter）与 **B25**（labels） |
| 抽屉根 | `aside[data-detail-drawer][data-state]` |
| 状态区 | `[data-detail-save][data-save-state="idle\|saving\|saved\|error"]`（承载属性，`hidden` 常驻，不承担文案）· `[data-detail-save-error][role="alert"]`（唯一可见半） |
| 可编辑行 | `[data-detail-assignee][data-detail-save-field="assignee"]` · `[data-detail-reporter][data-detail-save-field="reporter"]` · `[data-detail-labels][data-detail-save-field="labels"]` |
| 单值字段控件 | `[data-detail-assignee-label]` / `[data-assignee-menu]` → `[data-assignee-option]` · `[data-detail-reporter-label]` / `[data-reporter-menu]` → `[data-reporter-option]`（**钩子名一字未改**） |
| 标签集控件 | `[data-detail-label-chips]` / `[data-detail-label-chip]` / `[data-detail-label-remove]` · `[data-detail-label-input]` / `[data-detail-label-menu]` → `[data-detail-label-option]`（**钩子名一字未改**） |
| 本轮新增 | `[data-detail-save]` + `data-save-state` · `[data-detail-save-error]` · `data-detail-save-field` × 3 · `src/input.css` 的 1 条 `.td-save-error` 规则 · `app.js` 的 3 条绑定 |

**保存语义（变更即存，无 Save 按钮）**

| 字段 | 提交触发 | 失败条件 |
|---|---|---|
| `assignee` | `[data-detail-assignee-label]` **失焦且值相对打开时变化**；或选中 `[data-assignee-option]`（`comboAccept()` 会 `trigger("change")`） | 去空白后为**空** ⇒ `error` |
| `reporter` | 同规则，via `[data-detail-reporter-label]` / `[data-reporter-option]` | 同 ⇒ `error` |
| `labels` | 接受 chip（`[data-detail-label-option]` 选择 / 输入 Enter 新增）或点 `[data-detail-label-remove]` 移除 | **不可失败**（标签集允许为空） |

**状态机与反馈**（新增结构，**JS 关闭仍可见**）

```html
<span data-detail-save data-save-state="idle" hidden></span>
<span class="td-save-error" data-detail-save-error hidden role="alert">Couldn’t save — try again.</span>
```

- `[data-detail-save]` 的 `data-save-state` ∈ `idle|saving|saved|error`，**默认 `idle`**；它本身不带文案，是纯状态载体（与 `data-list-state` 同一手法）。
- `[data-detail-save-error]` 默认 `hidden`；**只有 `error` 态可见**。属性与 `hidden` 由同一次写入（`setDetailSaveState`）决定，永不出现「属性说 error、块却带 `hidden`」的分叉。
- **去抖**：一次 settle 序列服务三个字段；序列进行中到达的提交**不新起一轮**，只改写它将落到的结论 ⇒ 三次快速编辑 = 一次保存。
- **打开卡片即复位**：`[data-detail-drawer]` 打开时状态回到 `idle`，`detailSaved` 以该卡当下的 assignee / reporter 为基线 —— 「失焦但值没变」因此是**空操作**，不是一次保存。
- **失败路径（原型确定性演示，无后端）**：单值字段去空白后为空 ⇒ `error`；`error` **保持到下一次提交**。
- **文案**：错误串**内联在标记里**（无 `data-i18n` 钩子）。理由见 §7「文档同步判定」：`test/web/i18n.catalogue.mjs` 逐字镜像原型 `MESSAGES`，本卡红线不得碰 `test/**`，故按设计初稿「或直接内联」一支处理，并把多语言归属交给实现卡。

| # | 现象（改前实测） | 期望（改后实测） | 差异类型 |
|---|---|---|---|
| ②-1 | 抽屉里没有任何保存状态钩子 | `[data-detail-save]` 存在，静止 `data-save-state="idle"` | 缺 |
| ②-2 | 改 `[data-detail-assignee-label]` 的值并失焦：**无任何变化** | `data-save-state` 离开 `idle`（实测 `saving`） | 缺 |
| ②-3 | 选中 `[data-assignee-option]`：只改输入框值 | 同上（`saving`） | 缺 |
| ②-4 | 点 `[data-detail-label-remove]`：只删 chip | 同上（`saving`） | 缺 |
| ②-5 | 输入 Enter 新增 label chip：只加 chip | 同上（`saving`） | 缺 |
| ②-6 | 无失败反馈 | 单值字段置空并失焦 ⇒ `data-save-state="error"`，`[data-detail-save-error]` `display: block`（`role="alert"`） | 缺 |
| ②-7 | —— | 恢复有效值 ⇒ `saved`，错误块回 `display: none` | 缺 |
| ②-8 | 三个可编辑行的钩子集 | 各挂 `data-detail-save-field`，取值 `assignee` / `reporter` / `labels` | 缺 |
| ②-9 | `[data-detail-assignee-label]` / `[data-detail-reporter-label]` / labels 全套钩子名 | **一字未改** | **一致（回归门）** |
| ②-10 | 抽屉打开时三个控件的回填值 | 同（`renderDetail()` 的回填未改，只在其后加一次复位与基线记录） | **一致（回归门）** |
| ②-11 | 键入但**不**离开字段：无提交 | 同（`idle` 保持） | **一致（变更语义）** |

**失败路径为什么落在「空值」而不是「后端错误」**：原型没有后端，任何依赖网络的失败路径都不可复现、也不可机检。空值是**唯一**在纯前端可确定性触发的真实校验失败，所以契约的 B 类断言只需要这一条。实现侧的真实失败（409 / 网络）应复用**同一条状态机**（`saving → error`），这不改变本契约的任何 selector。

### 2.3 项③ `B10/B23.description-fill` — 创建弹窗 description 占满可用区域

**块契约表**

| | |
|---|---|
| 块 | **B10 · Create-task modal**（两列）+ **B23 · Markdown editor**（被拉伸的那个组件） |
| 弹窗根 | `[data-create-task]`（fixed 覆盖层，`inset-0` + `overflow-y: auto` + `p-6`）→ `[data-create-task-panel]`（面板；**实现侧无 `.td-modal-box`** —— R4 的视口上限改由覆盖层自身滚动表达，见 §9.2） |
| 两列 | `.td-two-col`（`grid-template-columns: minmax(0,1.6fr) minmax(0,1fr)`）→ `[data-create-left]` / `[data-create-right]` |
| 拉伸链 | `.td-two-col{align-items:stretch}` → `.td-col-left`（列 flex）→ `.td-field-grow{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}` → `.td-md-editor{flex:1 1 auto}` → `.td-md-panes{flex:1 1 auto;min-height:200px}` |
| 描述控件 | `[data-create-task-description]` = `[data-md-source]`（`height:100%` + `overflow-y:auto`，**不变**） |
| 本轮新增 | `src/input.css` 的 5 处改动（`.td-two-col` 的 `align-items`、`.td-field-grow` 的 `display`/`flex-direction`、`.td-md-editor` 的 `flex`、`.td-md-panes` 去 `height` 改 `flex`+`min-height`），无新属性、无新元素、无新类 |

| # | 现象（改前实测） | 期望（改后实测） | 差异类型 |
|---|---|---|---|
| ③-1 | `.td-two-col` 计算 `align-items: start`；左列 608.5px，右列 673.5px | `align-items: stretch`；左列 **673.5px**（= 行高） | 缺 |
| ③-2 | 编辑器底边到行底边留 **65px** 空白（Terry 的「底部一大块空白」） | **0px** | 缺 |
| ③-3 | `.td-md-panes` 固定 `clamp(280px, 46vh, 520px)` ⇒ 437px | `flex: 1 1 auto; min-height: 200px` ⇒ **502px**（> 280px） | 缺 |
| ③-4 | `.td-field-grow` 是块容器，`flex: 1 1 auto` 对子元素无效 | `display: flex; flex-direction: column` ⇒ `[data-md-editor]` 的 `flex` 可解析 | 缺 |
| ③-5 | 写侧 `.td-md-source` 437px + 自滚动 | 502px + `overflow-y: auto`（**手感不变**） | **一致（回归门）** |
| ③-6 | 弹窗视口上限（R4）：实现以覆盖层 `[data-create-task]` 自身滚动表达（无 `.td-modal-box`） | 1120×800 覆盖层竖向溢出 **实读 `0px`**（原型 `.td-modal-box` 记 49px 内部滚动；1512×950 未单独复测） | **实现侧等价（回归门）；差异见 §9.2** |
| ③-7 | 760×900：`.td-two-col` 单列、编辑器 399px | 单列、399px（**窄屏不强制撑满**） | **一致（回归门）**；实现现测 760 双列（裁定 (b) 要求修正，见 §9.3） |
| ③-8 | 工作区垂直滚动 `scrollWidth <= clientWidth + 1` | 同 | **一致（回归门）** |

### 2.3.1 偏离设计初稿之二：`.td-field-grow` 必须是列 flex 容器

设计初稿的第 ③ 项只列了 `.td-two-col` / `.td-md-editor` / `.td-md-panes` 三处。照做后实测：左列确实拉到 673.5px，但**编辑器底边到行底边仍有 302px 空隙**，`.td-md-panes` = 200px（正好是 `min-height` 地板）。

原因：`.td-field-grow` 是**块**容器。`.td-md-editor` 的 `flex: 1 1 auto` 无处解析 ⇒ 退回内容高度（= panes 的 `min-height` + 工具条）。补 `display: flex; flex-direction: column` 后链才通，实测空隙 `302px → 0px`、`.td-md-panes` `200px → 502px`。字段标签自带 `margin-bottom: 4px`，所以新的 flex 上下文不额外产生间距。

### 2.3.2 设计初稿 C1 / C3 两条断言的实测复核（**均不成立，已换写**）

| 初稿断言 | 实测 | 处置 |
|---|---|---|
| **C1**：`[data-md-editor]` 底边与 **`[data-create-left]`** 底边差 ≤ 8px | **改前改后都是 0px** —— 左列在 `start` 与 `stretch` 两态都是内容高度，而编辑器就是它的最后一个孩子。**该量不具判别力** | **换写**为「编辑器底边 vs **行底边**（`.td-two-col`）」：65px → 0px（§5 B-6 的 B-6a） |
| **C3**：1120×800 时 `.td-modal-box` 无内部竖向溢出 | **改前改后都是 49px 溢出**（scrollHeight 799 / clientHeight 750）。该溢出由**右列 8 个字段**的自然高度决定，与 description 无关；且 R4 明文设计为「盖上视口上限 + 自己滚」，所以它**是设计行为，不是缺陷** | **改判**：不作为 ③ 的验收断言；改为回归门「1120×800 的溢出量与改前**相同**（49px）」（§5 B-7） |

两条都写在这里而不是悄悄删掉：初稿的两条断言在**两个状态上都为同一值**，任何一端都不会因它们变红或变绿 —— 留着会让实现卡误以为测过了。

---

## 3. 与既有轮次的边界（正交声明，必须显式）

| 本轮项 | 与既有轮次的关系 |
|---|---|
| ① `B05/B12.board-two-state` | **与 R9 同源不同物**：R9 是 list 的 `loading↔data`（`[data-list][data-list-state]`），本轮是 **board** 的 `empty↔data`（`[data-board-view][data-board-state]`）。两者都是「视图根属性 + 两成员恰一可见」，但**状态载体、成员、取值范围全不同**，互不替代（§2.1.1）。**正交于 R8**（不动 6 轨列模板、不动加载态列头跨满）；**正交于 R3/R5**（不动 `[data-empty][data-empty-kind="column"]` 与它的 `[data-column-add]`）。 |
| ② `B09.drawer-autosave` | **正交于 R3**（R3 建了抽屉的 assignee/reporter 组合框；本轮**不改**它的名册、模糊匹配、键盘循环，只给它加提交落点）。**正交于 R5**（R5 建了 labels chip；本轮**不改** chip 的接受/移除实现，只在既有 `change` 落点后追加一次状态写入）。**正交于 R7**（R7 定的抽屉关闭按钮与 `[data-detail-close]` 未动）。**正交于 R8**（R8 定的 `[data-detail-identifier]` 截断未动）。 |
| ③ `B10/B23.description-fill` | **与 R4 有接触但正交**：R4 给了 `.td-modal-box` 的视口上限与内部滚动、以及 `.td-md-panes` 的固定 `clamp` 高度；本轮**保留前者**（C3 已复核）、**替换后者**（固定高度 ⇒ flex + 地板）。**正交于 R8**（暗色三层分离全在 `.modal-box` 与 veil 上，未被触碰）。**正交于 R5**（`.td-md-*` 之外的一列字段未动）。 |

**本轮三项都是设计变更**（原型侧同样没有对应口径）：① 无 board 级状态、② 无提交路径与反馈、③ 固定的视口高度规则。三项的**原型改动已随本卡落地**（`index.html` / `app.js` / `src/input.css` / `tw.css` 重建），并已同步 `design/DESIGN.md` §26 与 `design/BLOCKS.md`。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

| # | 项 | 块 | id / role | selector / hook | 期望 | 改前（原型实测） | 差异类型 |
|---|---|---|---|---|---|---|---|
| 1 | ① | B05 | 状态根 | `[data-board-view]` | 存在，计数 1 | 无该元素 | 缺 |
| 2 | ① | B05 | 状态根属性 | `data-board-state` | ∈ {`data`,`empty`}，静止 `data` | 无该属性 | 缺 |
| 3 | ① | B05 | data 态成员 | `[data-board]` | `empty` 态 `display: none` + `hidden` | 两态都 `display: flex` | 缺 |
| 4 | ① | B12 | empty 态成员 | `[data-empty][data-empty-kind="no-results"]` | `data` 态 `display: none` + `hidden` | 仅 `total>0 && shown===0` 时可见 | 缺 |
| 5 | ① | B05/B12 | 互斥判据 | 两成员 `display ≠ none` 的计数 | **`=== 1`**（两条路径皆然） | 筛选全隐时 = **2** | 缺 |
| 6 | ① | B05 | 后代可见性 | `[data-board] [data-column]` 的 `getClientRects()` | `empty` 态 **0 个**被绘制 | 7 个 | 缺 |
| 7 | ① | B12 | 列内空态（**非成员**） | `[data-empty][data-empty-kind="column"]` | 计数 7，两态皆不受影响 | 7 | **一致（回归门）** |
| 8 | ① | B05 | 透传层几何 | `[data-board-view]` / `[data-board]` rect | 812 / 812（= 改前） | 812 / 812 | **一致（回归门）** |
| 9 | ① | B08 | 视图切换 | `[data-board-view]` 在 list 态 | 不可绘制（`getClientRects()` = 0） | 由 `[data-board]` 的 `hidden` 达到同一结果 | 口径 |
| 10 | ② | B09 | 状态区（属性载体） | `[data-detail-save]` + `data-save-state` | 计数 1；∈ `idle\|saving\|saved\|error` | 无 | 缺 |
| 11 | ② | B09 | 失败反馈 | `[data-detail-save-error]` | 计数 1；`role="alert"`；仅 `error` 态 `display ≠ none` | 无 | 缺 |
| 12 | ② | B09 | 字段钩子 | `data-detail-save-field` | 计数 3，取值 `assignee`/`reporter`/`labels`，各在对应行根上 | 无 | 缺 |
| 13 | ② | B22 | assignee 控件本体 | `[data-detail-assignee-label]` / `[data-assignee-option]` | **钩子名不变** | 同名 | **一致（回归门）** |
| 14 | ② | B22 | reporter 控件本体 | `[data-detail-reporter-label]` / `[data-reporter-option]` | **钩子名不变** | 同名 | **一致（回归门）** |
| 15 | ② | B25 | labels 控件本体 | `[data-detail-label-input]` / `[data-detail-label-option]` / `[data-detail-label-chip]` / `[data-detail-label-remove]` | **钩子名不变** | 同名 | **一致（回归门）** |
| 16 | ② | B09 | 空值失败路径 | `[data-detail-assignee-label]` 置空 + 失焦 | `data-save-state="error"`，错误块可见 | 无任何变化 | 缺 |
| 17 | ③ | B10 | 两列交叉轴 | `.td-two-col` 的 `align-items` | `stretch` | `start` | 缺 |
| 18 | ③ | B10 | 左列填充 | `[data-create-left]` rect.height | `= .td-two-col` 行高（673.5px @1512×950） | 608.5px（差 65px） | 缺 |
| 19 | ③ | B10/B23 | 断链修复点 | `.td-field-grow` 的 `display` | `flex` + `flex-direction: column` | `block` | 缺 |
| 20 | ③ | B23 | 编辑器填充 | `.td-md-editor` 的 `flex` | `1 1 auto` | `<flex>` 默认（`0 1 auto`） | 缺 |
| 21 | ③ | B23 | 面板高度 | `.td-md-panes` 的 `height` / `min-height` | 无固定 `height`；`min-height: 200px`；实测 502px | `clamp(280px, 46vh, 520px)` = 437px | 缺 |
| 22 | ③ | B23 | 写侧自滚动 | `[data-md-source]` 的 `height` / `overflow-y` | `100%` / `auto` | 同 | **一致（回归门）** |
| 23 | ③ | B10 | 弹窗视口上限 | 覆盖层 `[data-create-task]` 的 `overflow-y`（**实现侧无 `.td-modal-box`**，见 §9.2） | `auto`；1120×800 溢出 `0px` | 同 | **实现侧等价（回归门）** |
| 24 | ③ | B10 | 窄屏边界 | `.td-two-col` @760 的 `grid-template-columns` | 单列（`710px`） | 同 | **一致（回归门）** |
| 25 | ③ | B23 | 窄屏地板 | `.td-md-editor` height @760×900 | `≥ 200px`（实测 399px） | 399px | **一致（回归门）** |

### 4.2 匹配项（本轮三项命中的既有块，逐个列明）

| 命中的块 | 命中处 | 本轮对它做什么 | 不做 |
|---|---|---|---|
| **B05 · Board** | `[data-board]` 与其在 `[data-main]` 中的位置 | 包进 `[data-board-view]` 状态根（**board 自身一字未改**）；`setView()` 改隐藏状态根 | 不动 7 个 `[data-column]`、不动 `refreshColumns()`、不动 `.td-board` 的滚动与列宽 |
| **B12 · Empty states** | `[data-empty][data-empty-kind="no-results"]` | 成为 `empty` 态的成员；可见条件放宽为 `shown === 0` | 不动 `.td-empty-lg` 的品牌标记、不动两行文案与 `[data-filter-clear]`、不动列内空态变体 |
| **B09 · Task detail drawer** | `[data-detail-drawer]` 的 body 顶部 | 新增一个状态区（1 个属性载体 + 1 个 `role="alert"` 块）；打开时复位 | 不动 head、不动 `.td-drawer-body` 的滚动、不动 `[data-detail-close]`（R7）、不动 `[data-detail-identifier]` 截断（R8） |
| **B22 · Assignee / Reporter control** | `[data-detail-assignee]` / `[data-detail-reporter]` | 各加 `data-detail-save-field`；**绑定**一次 focus-loss 与一次 change | 不动名册、不动 `comboAccept()` 的接受语义、不动创建弹窗那一份（`[data-create-task-form]` 内的同族控件不参与本轮保存） |
| **B25 · Label control** | `[data-detail-labels]` | 加 `data-detail-save-field`；在既有 `change` 落点后追加状态写入 | 不动 chip 的生成/移除、不动名册增长语义、不动创建弹窗那一份 |
| **B10 · Create-task modal** | `.td-two-col` / `.td-field-grow` / `.td-modal-box` | 交叉轴改 `stretch`；`.td-field-grow` 改列 flex | 不动两个轨道定义、不动 R8 的暗色三层、不动 `resetCreateTask()` |
| **B23 · Markdown editor** | `.td-md-editor` / `.td-md-panes` / `.td-md-source` | 加 `flex: 1 1 auto`；去固定高度、改 `flex` + `min-height` | 不动三档模式开关、不动高亮层与 textarea 的共享度量、不动 `[data-md-source]` 的自滚动 |
| **B13 · Loading state**（旁及） | `[data-skeleton]` | 无 | 不动 —— 它是 **list** 的加载态，与本轮 **board** 空态不是同一条状态机（§2.1.1） |

### 4.3 负向注记清单

| # | 注记 |
|---|---|
| 1 | 本轮**不**改任何 `web/**` 与 `test/**`（卡的红线：无实现代码）。 |
| 2 | 本轮**不**引入新块；新增 5 个**属性/钩子**（`data-board-state`、`[data-detail-save]`、`data-save-state`、`[data-detail-save-error]`、`data-detail-save-field`），无新类名成为契约锚（`.td-save-error` 只是样式，不是断言锚）。 |
| 3 | 本轮**不**给 board 空态新写一套状态机：口径逐条复用 R9 的 `[data-list][data-list-state]`（§2.1.1），名字换成 board 的。 |
| 4 | 本轮**不**动 `[data-empty][data-empty-kind="column"]`：列内空态与 board 级空态是两件事，A2/A4 的计数**不得**把它纳入。 |
| 5 | 本轮**不**改 `renderDetail()` 的回填逻辑：只在其后追加一次状态复位与基线记录（②-10 是回归门）。 |
| 6 | 本轮**不**给创建弹窗的同族控件（`[data-create-task-form]` 内的 assignee/reporter/labels）加自动保存：Terry 的三项反馈只点了**详情抽屉**，创建弹窗是**提交一次**的表单，语义不同。 |
| 7 | 本轮**不**重拍截图集：`design/prototype/README.md` 的截图段已如实记录 R7/R8/R9 的过期范围，R10 追加一条（§7）。 |
| 8 | 本轮**不**新增 i18n 键：错误串内联，`data-i18n*` 钩子数 468 与 `MESSAGES` 220/220 两轮相同（§5 A-9 是回归门，理由见 §7）。 |

---

## 5. 机检断言清单（供实现卡「During」直接落测）

**禁行号锚**；每条只写「selector → 断言 → 期望」。

**落点（三类各一处，均属实现卡范围，本轮不改）**

| 类 | 落点 | 判据 |
|---|---|---|
| A · 结构 | `test/web/blocks.contract.mjs`（既有 rule kinds）+ `web/manifests/board-m2.json` 的 `blocks` | 节点计数 / 存在性 / 钩子集 / 属性枚举 |
| B · 计算样式与几何 | `web/manifests/board-m2.json` 的 `style.targets`，由 `ui-align board-m2 --strict` 执行（R6/R8/R9 的 `rN-*` 行即在此）；细粒度几何可另落 `web/scripts/dom-smoke.mjs` | `getComputedStyle` / `getBoundingClientRect` 的实测值 |
| C · 交互 | 驱动层（`web/scripts/dom-smoke.mjs` 或截图/探针脚本） | 真实事件驱动的状态变化 |

实现卡的 Acceptance 把 B 类绑在 **`ui-align board-m2 --strict` 0 失败**上，所以 §5 B 的每一行都应成为 `board-m2.json` 里的一条 target（新增行按既有 `rN-*` 命名惯例，例如 `r10-board-view` / `r10-md-fill`）。

### A. 结构类（`blocks.contract`）

| # | selector | 断言 | 期望 |
|---|---|---|---|
| A1 | `[data-board-view]` | 元素计数 | `1` |
| A2 | `[data-board-view]` | 属性存在 | 含 `data-board-state`；取值 ∈ {`data`, `empty`} |
| A3 | `[data-board]` / `[data-empty][data-empty-kind="no-results"]` | 父级 | 两者 `parentElement` **同为** `[data-board-view]` |
| A4 | `[data-empty][data-empty-kind="column"]` | 计数 | `7`，且**不在** A3 的两成员之列（`data-empty-kind` 必须逐字匹配 `no-results`） |
| A5 | `[data-detail-save]` | 计数 / 属性 | `1`；含 `data-save-state`，取值 ∈ {`idle`, `saving`, `saved`, `error`} |
| A6 | `[data-detail-save-error]` | 计数 / 属性 | `1`；`role="alert"`；静止态带 `hidden` |
| A7 | `[data-detail-save-field]` | 计数 / 取值集合 | `3`；恰为 {`assignee`, `reporter`, `labels`} |
| A8 | `[data-detail-assignee][data-detail-save-field="assignee"]` 等三行 | 钩子共存 | 三个既有行根**各自**同时带旧钩子与新属性（不是新元素） |
| A9 | `data-i18n` / `data-i18n-aria-label` / `data-i18n-title` / `data-i18n-placeholder` 合计 | 计数（**回归门**） | `468`（不因本轮增删） |

### B. 计算样式 / 几何类（`dom-smoke`）

| # | selector | 断言 | 期望 |
|---|---|---|---|
| B-1 | `[data-board-view]` = `[data-board]`（data 态，1512×950） | rect.height / `.td-main` rect.height / 首个 `[data-column]` rect.height | **实现侧 `894px` / `894px` / `808px`**（**与改前相同** —— 透传层回归门，§2.1.2；原型记 812，口径差与 `[data-filters]` 归属见 §9.1） |
| B-2 | `[data-board-view][data-board-state="empty"]` | `[data-board]` 的 `hidden` / `display` | **有** / `none` |
| B-3 | `[data-board-view][data-board-state="empty"]` | `[data-empty][data-empty-kind="no-results"]` 的 `hidden` / `display` | **无** / `flex` |
| B-4 | `[data-board-view][data-board-state="data"]` | 同上两成员 | `[data-board]` **无**/`flex`；no-results **有**/`none` |
| B-5 | `[data-list][data-list-state="data"]` 时 `[data-board-view]` | `getClientRects().length` | `0`（list 态下 board 视图整体退出绘制） |
| B-6 | `.td-two-col`（1512×950，弹窗开启且过渡落定） | `align-items` | `stretch` |
| B-6a | `[data-md-editor]` rect.bottom 与 `.td-two-col` rect.bottom 之差 | 空隙 | `≤ 8px`（实测 `0px`；**不得**改用 `[data-create-left]` 作参照，§2.3.2） |
| B-7 | `[data-create-task]` 覆盖层（1120×800） | `scrollHeight - clientHeight` | **实现侧 `0px`**（R4 的「盖上视口上限 + 自己滚」由覆盖层 `overflow-y: auto` 表达，**无 `.td-modal-box`**；原型记 49px 内部滚动 —— 见 §9.2） |
| B-8 | `.td-md-panes`（1512×950） | 计算 `height` | `> 280px`（实测 `502px`；证明随可用高度增长而非旧固定值） |
| B-9 | `.td-md-panes` | `min-height` | `200px` |
| B-10 | `.td-md-editor` | `flex-grow` / `flex-basis` | `1` / `auto` |
| B-11 | `[data-md-source]` | `height` / `overflow-y` | `100%` / `auto`（写侧自滚动不变，回归门） |
| B-12 | `.td-two-col`（760×900） | `grid-template-columns` 的轨道数 | `1`（**裁定 (b)：对齐基线「≤760 单列」**；实现现测 2，需 impl 修正 —— 见 §9.3）；`.td-md-editor` height `≥ 200px` |
| B-13 | 页面（1512 / 1120 / 760） | `scrollWidth <= clientWidth + 1` | 全 `true` |
| B-14 | `[data-detail-save-error]`（非 `error` 态） | `display` | `none` |

### C. 交互类（驱动层：真实点击 / 键盘 / 真实焦点）

| # | 场景 | 断言 | 期望 |
|---|---|---|---|
| C-1 | 初始加载 | `[data-board-view]` 的 `data-board-state` | `data` |
| C-2 | 搜索框填入无匹配串（`total > 0`, `shown === 0`） | `data-board-state` / 两成员可见计数 / 被绘制列数 | `empty` / **`1`** / `0` |
| C-3 | 清空搜索框 | 同上 | `data` / `1` / `7` |
| C-4 | 切到 list 视图并等落定 | `[data-board-view]` 的 `getClientRects().length` / `[data-list]` 的 `display` | `0` / `flex` |
| C-5 | 打开一张卡片的抽屉 | `data-save-state` | `idle`；`[data-detail-save-error]` `display: none` |
| C-6 | 改 `[data-detail-assignee-label]` 的值，使其**失去焦点** | `data-save-state` | 离开 `idle`（`saving` / `saved`） |
| C-7 | 接 C-6，等一次 settle | 同上，随后 | `idle`（错误块全程 `display: none`） |
| C-8 | 在 `[data-detail-assignee-label]` 里选中一个 `[data-assignee-option]` | `data-save-state` | 离开 `idle` |
| C-9 | 点 `[data-detail-label-remove]` | `data-save-state` | 离开 `idle` |
| C-10 | 在 `[data-detail-label-input]` 输入新名并 Enter | `data-save-state` | 离开 `idle` |
| C-11 | 把 `[data-detail-assignee-label]` 置为纯空白并失焦 | `data-save-state` / 错误块 | `error` / `display: block`，`role="alert"` |
| C-12 | 接 C-11，改回有效值并失焦 | `data-save-state` / 错误块 | `saved` → `idle` / `display: none` |
| C-13 | 打开卡片 A，改一个字段，关掉，再打开卡片 B | `data-save-state` | 回到 `idle`（不复用 A 的结论） |
| C-14 | 键入一个字段但**不**离开它 | `data-save-state` | `idle`（无提交） |
| C-15 | 语言切 `zh` 后重跑 C-2 / C-6 / C-11 | 同上（文案变、态不变；错误块文案本轮为内联英文，见 §7） | 同 C-2 / C-6 / C-11 |
| C-16 | **脚本关闭**下加载 | `data-board-state` / 被绘制列数 / `[data-detail-save]` 的 `data-save-state` / 错误块 `hidden` | `data` / `7` / `idle` / **有** |

### C′. 「不得断言」的负向注记

| # | 不得断言 | 原因 |
|---|---|---|
| C′1 | 用 `computed display` 判定 `[data-board]` **后代**（`[data-column]`）是否可见 | 父级 `display:none` 不改变子元素自身的 computed `display`；`empty` 态下 7 个列仍读作 `flex`。后代一律用 `getClientRects().length`（§1 规则 4、A-6）。 |
| C′2 | 把 `[data-empty][data-empty-kind="column"]` 纳入 board 级计数 | 它是**列内**空态，一列一个（7 个），不属于视图级状态；纳入会让 A3/A5 恒坏。 |
| C′3 | `data-board-state` 与两成员的 `hidden` **各自**独立成立 | 三者由 `setBoardState()` **同一次写入**决定；断言应查**一致性**（态为 `empty` ⇔ no-results 无 `hidden`），不得只查其一。 |
| C′4 | 用 `computed display` 区分「list 态下 board 视图是否退出」 | 改后由 `[data-board-view]` 承担，`[data-board]` 自身的 computed `display` 仍是 `flex`（父级被隐藏）。用 C-4 的 `getClientRects()`。 |
| C′5 | **C1 初稿**：以 `[data-create-left]` 底边作 C1 的参照 | 左列在两态都是内容高度 ⇒ 该差恒为 `0px`，无判别力。用行底边（B-6a）。 |
| C′6 | **C3 初稿**：1120×800 无内部溢出 | 两轮实测皆为 49px，且是 R4 的盖上+自滚设计。用「与改前相同」（B-7）。 |
| C′7 | 依赖 `saved` 态的**驻留时长** | `420ms × 2` 是原型把它做成「可见过程」的演示节拍，不是契约；契约只要求四个状态存在、属性与错误块一致、提交使状态离开 `idle`。实现侧可以是任意真实请求时长。 |
| C′8 | 用类名选 `.td-save-error` 作断言锚 | 它是**样式**不是契约：口径锚一律 `data-*`（设计初稿 §2.4 C′ 原文）。 |
| C′9 | 断言错误块的文案（`Couldn’t save — try again.`）在多语言下被翻译 | 本轮该串**内联**、无 `data-i18n` 钩子（§7）；多语言归属是**实现卡**的决定。断言只查 `role` / 可见性 / 状态一致性。 |

---

## 6. 证据与复跑

**探针**：`workspace/T-20261012-230448/verify/r10-probe.mjs`（Playwright / Chromium headless；视口 1512×950 / 1120×800 / 760×900；`file://` 打开原型；`console` / `pageerror` 收集；含一次 `javaScriptEnabled: false` 的上下文）。

**原始记录**：`verify/probe-before.json`（改动前）· `verify/probe-after.json`（改动后）。**均不进仓**。

**「改前」是怎么测到的（可复核）**：`verify/pristine-prototype/`（`index.html` 285264 + `app.js` 113793 + `tw.css` 192093 bytes，逐字取自 `git show 241bc67:design/prototype/*`，`vendor/` 原样拷贝）由 `verify/make-pristine.mjs` 生成；探针以该副本的 `index.html` 为入参实测。因此「改前」一栏是**同一探针对同一原型的旧版重跑**，不是推断、也不是从 diff 反读。

**透传层实验（§2.1.2 的证据）**：`verify/wrapper-experiment2.mjs` —— 不改仓、不重建，直接在页内把 `[data-board]` 包进不同规则的状态根并量 board 高度（`block` ⇒ 331.56px；`flex: 1 1 auto` ⇒ 812px；不包 ⇒ 812px）。

**tw.css 重建**：`verify/build-tw.mjs`（临时建 `design/prototype/node_modules` 符号链接 → 跑 vendored tailwindcss → 删链接）。`192093 → 192724` bytes（**+631**）；新增的类选择器**只有** `.td-save-error` 一个。过程中发现并**修掉**了两处注释令牌膨胀：把注释里的 `steps` / `blur` 两个裸词改掉后，daisyUI `.steps`（约 4.9KB）与 Tailwind `.blur` 不再被扫描器产出 —— 这条正是构建段落警告的「静默膨胀」，记在此处供后续轮次复用。

| 画面 | 命名 | 取证什么 |
|---|---|---|
| board data 态 | `r10-<label>-board-data.png` | ① 的 data 态（两轮同帧：812px board、7 列） |
| 筛选全隐 | `r10-<label>-board-empty-filtered.png` | ① 的**同屏**路径（改前同帧是「no-results + board」两块同屏） |
| 真·空 board | `r10-<label>-board-empty-total0.png` | ① 的 Terry 原现象（改前同帧是 7 个空列 + 列内 `No tasks`；改后只剩空态块） |
| 抽屉打开 | `r10-<label>-detail-open.png` | ② 的静止态（改后状态区存在且 `idle`） |
| 抽屉失败态 | `r10-<label>-detail-error.png` | ② 的失败反馈（改后可见 `Couldn’t save — try again.`） |
| 创建弹窗（宽 / 中 / 窄） | `r10-<label>-create-{wide,mid,narrow}.png` | ③ 的填充（改前宽屏编辑器下方留 65px 空带、改后贴到行底） |
| **脚本关闭** | `r10-<label>-no-js.png` | 关闭 JS 后结构仍在：状态根与 `data-board-state="data"` 自洽（board 可见、no-results `hidden`、7 列照常），抽屉状态区与错误块（`hidden`）都在，18 张卡照常渲染 |

**硬门（两轮皆通过）**：`console` = 0、`pageerror` = 0。

**实现侧证据口径**：本契约对实现侧的断言一律标「实读」，**未**构建 `web/dist` 实测；实现卡的「During」应把 §5 的 A/B/C 三类落成真正的机检（`test/web/blocks.contract.mjs` · `web/manifests/board-m2.json` + `ui-align board-m2 --strict` · 驱动层），验证卡独立复跑同一张表。

---

## 7. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/DESIGN.md` | **新增 §26「Review round R10 — the board's own empty state, drawer saves, and a description that fills」**：26.1 board 二态与「复用 R9 口径」的对照表；26.2 抽屉自动保存的四态、触发点、失败路径与「打开即复位」的理由；26.3 description 拉伸链与两处被替换的初稿断言（C1/C3）；26.4 实测对照与偏离记录 | **已改** |
| `design/BLOCKS.md` | **B05**：根改为「状态根的直接子级」并加 R10 段落（二态、透传层、列内空态非成员）；**B12**：`no-results` 成员的可见条件改口径 + R10 段落；**B09**：性质表加状态区与三个 `data-detail-save-field` + R10 段落（四态、触发、失败）；**B10**：加 R10 段落（拉伸链、被换写的两条初稿断言）；**B23**：根表与段落更新（去固定高度、加 `flex`、地板 200px）；**Auxiliary hooks**：新增 `data-board-state`、`[data-detail-save]` / `data-save-state`、`[data-detail-save-error]`、`data-detail-save-field` 四行 | **已改** |
| `design/prototype/README.md` | 规格清单外的增项（与 R7/R8/R9 同理：该文件描述的就是被改的原型）：Interaction map 增 I17（board 二态）与 I18（抽屉保存），`app.js` 行补 I17/I18；表后补 R10 规则段（状态根、保存状态机、拉伸链）；截图段**新增 R10 过期声明**；构建段落更新 `192093 → 192724 bytes`（并记录 `steps`/`blur` 两处令牌膨胀） | **已改** |
| `design/prototype/src/input.css` / `tw.css` | 5 处规则（状态根透传 + 二态互斥、`.td-save-error`、`.td-two-col` 交叉轴、`.td-field-grow` 列 flex、`.td-md-editor` flex、`.td-md-panes` flex + 地板）；`tw.css` 按既有流程重建 | **已改 + 已重建** |
| `src/styles/tokens.css`（实现侧 token）/ `design/DESIGN.md` 的 token 表 | **无新增、无改动** —— 错误块用既有 `--color-td-danger` / `--color-td-danger-soft`，拉伸链不引入任何新值，braces/radius 全部沿用 | **不改（有意）** |
| `design/fidelity-r6.md` / `-r7` / `-r8` / `-r9` | **不改**：本轮与它们正交（§3），旧契约仍成立 | **不改（有意）** |
| `test/**` / `web/**` | **不改**（卡的红线：无实现代码） | **不改（红线）** |
| **i18n 归属（显式判定）** | 错误串**内联、无 `data-i18n` 钩子**。原因：`test/web/i18n.catalogue.mjs` 逐字镜像原型 `app.js` 的 `MESSAGES`（en 220 / zh 220），且 `i18n.catalogue.test.mjs` 同时校验「条目逐行相等」与「每个 `data-i18n` 钩子可解析」；本卡不得碰 `test/**`，因此新增键或新增钩子都会把该套件**在 host 上变红**。设计初稿 §2.3 明写「或直接内联」，故取内联一支，并把多语言归属交给实现卡（实现侧加键时字符串可自定，契约只锁 `data-*` 与可见性） | **已判定（内联）** |

**判定依据的实测**：本轮 `index.html` 的 `data-i18n*` 钩子数 **468（不变）**、`app.js` 的 `MESSAGES` 键数 **en 220 / zh 220（不变）** —— 与 `test/web/i18n.catalogue.test.mjs` 在基线 commit 上量到的数字一致。

---

## 8. 口径红线与未覆盖项

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | board 视图的二态只能由 `[data-board-view]` 的 `data-board-state` 表达，且**同一次写入**同时决定两成员的 `hidden`；不得出现「属性说 `empty`、no-results 却带 `hidden`」的分叉。 |
| R2 | 二态互斥必须**在静态文档里就成立**（读属性）；`data` 是静止态，`hidden` 的分布必须与之一致。 |
| R3 | `[data-empty][data-empty-kind="column"]` 永远**不是** board 级状态的成员；不得把它纳入任何 board 级计数或规则。 |
| R4 | `[data-board-view]` 必须是 `[data-main]` 的 flex 透传层；改成块容器会把 board 压到内容高度（§2.1.2 有三条实测）。 |
| R5 | 抽屉的保存状态只能由 `[data-detail-save]` 的 `data-save-state` 表达；`[data-detail-save-error]` 的可见性由它同一次写入决定，不得各写一半。 |
| R6 | 自动保存是**变更即存**：不得引入 Save 按钮（Terry 要的是「自动」），也不得改成逐键提交（无明确提交点，不可机检）。 |
| R7 | 描述的填充只能由**拉伸链**表达（`stretch` → `.td-field-grow` 列 flex → `.td-md-editor` flex → `.td-md-panes` flex+地板）；不得改回任何**视口驱动**的固定 `height`（那正是 R10 ③ 的根因）。 |
| R8 | `.td-modal-box` 的视口上限与内部滚动（R4）不得为「消除 49px 内部滚动」而移除 —— 那是设计行为，且与 description 无关（§2.3.2）。 |
| R9 | 本轮**不从** `design/prototype/**` 新增 i18n 键：原型 `MESSAGES` 被 `test/web/i18n.catalogue.mjs` 逐字镜像。要加键的卡片必须在**同一提交**里同步该镜像文件（或按 R9 的先例给出理由）。 |

**未覆盖项（明确不在本轮，留给后续裁定）**

| # | 项 | 说明 |
|---|---|---|
| F1 | 创建弹窗里同族控件的自动保存 | 本轮只做**详情抽屉**（Terry 的反馈点位）。创建弹窗是提交一次的表单，语义不同（§4.3 注记 6）。 |
| F2 | 保存的**真实后端失败**（409 / 网络 / 并发冲突） | 原型无后端。契约锁的是状态机与可见性；实现侧接同一状态机即可（§2.2 末段）。 |
| F3 | `saved` 态是否要有**文案** | 本轮 `[data-detail-save]` 是纯属性载体（与 `data-list-state` 同手法），只有 `error` 有可见半。若 Terry 后续要「已保存」提示，另开卡。 |
| F4 | 失败文案的多语言 | 见 §7：本轮内联英文，归属实现卡（C′9）。 |
| F5 | 截图集重拍 | 见 §4.3 注记 7 / `design/prototype/README.md` 截图段的 R10 声明。 |
| F6 | board 的 `loading` 态 | 本轮 board 只有 `empty` / `data` 两态（Terry 只报了空态）。若后续要给 board 加载骨架，应**扩展** `data-board-state` 的取值集，而不是另起一个属性。 |
| F7 | `total === 0` 的可达性 | 原型的三个项目**各自都有卡片**（13 / 5 / 3），所以「真·空 board」在 UI 上不可达；探针以「摘掉全部 `[data-card]` 后触发真实过滤 pass」的方式驱动同一段代码（§6 探针的 `boardTrulyEmpty` 步骤）。契约的判据 `empty ⇔ shown === 0` 已把 `total === 0` 作为其子集覆盖。 |

---

## 9. 回写裁定：实现侧期望值（2026-10-13 · R10 验证 §4 三条口径差）

> **来源**：R10 独立验证卡 `T-20261012-230448-3`（PASS）§4；裁定卡 `T-20261013-012017`。
> **口径**：以下为 **实现侧（`web/**` @ `5383ef1`）实测** 的期望值；原型侧记录（§2 各表、§2.3.2）保留为历史，不据此判实现 FAIL。度量来自验证卡 lane B 结构探针（`workspace/T-20261012-230448-3/review/evidence/laneB/probe-structure.json`，真实浏览器 `getBoundingClientRect` / `getComputedStyle`）。
> **优先级**：本节优先于 §5 旧期望值；§5 对应行（B-1 / B-7 / B-12）已就地更新。

### 9.1 项① board 绝对高：812（原型）→ **894（实现侧）**

| 量 | 原型（§2.1 探针） | **实现侧（实测）** |
|---|---|---|
| `[data-board-view]` rect.height | （无该元素） | **894px** |
| `[data-board]` rect.height（data 态，1512×950） | 812px | **894px** |
| `.td-main` rect.height | 894px | **894px** |
| 首个 `[data-column]` rect.height | 808px | **808px** |
| `.td-main` 竖直溢出 | 0 | **49px** |

- **期望值（实现侧）**：`[data-board-view]` = `[data-board]` = `.td-main` = **894px**（透传层：`[data-board-view]{height:100%}` 对 `main` 解析），首列 **808px**。
- **`[data-filters]` 归属**：过滤条（实测 **49px**）**是 `main` 的子级、与 board 同层**；`[data-board-view]{height:100%}` 取满 `main`(894) 后，`main` 内容高 = 894 + 49 ⇒ **竖直溢出 49px**。原型侧过滤条为 30px 且 board 只占 812，故原型无此溢出。
- **非 R10 引入**：`app.css` 记该 board 高 **894「before/after 一致」**（`verify/probe-*.json`）⇒ 回归门（`[data-board-view]` 不改 board 几何）在实现侧**成立**；49px 溢出为**预先存在**（验证卡已核实）。
- **声明形式适配宿主**：契约 R4 红线写「`[data-board-view]` 必须是 `[data-main]` 的 flex 透传层」；实现侧 `main` 是 grid item（非 flex 列），故等价实现为 `height:100%`（`app.css` 注明「同一意图的等价声明」）。透传**意图**不变，声明形式适配宿主布局。
- **落地**：§5 **B-1** 期望值由 `812 / 894 / 808` 改为 **`894 / 894 / 808`**（实现侧）；原型值 812 仅存于 §2.1 探针表。

### 9.2 项② `.td-modal-box`：实现未采用 → **等价覆盖层**

| 原型（R4 表达） | **实现侧（实测）** |
|---|---|
| `dialog[data-create-task]` → `.td-modal-box`（`max-height: calc(100vh-48px)` + `overflow-y:auto`） | `[data-create-task]`（`fixed inset-0 overflow-y-auto p-6`，承载 `role="dialog"`/`aria-modal`）→ `[data-create-task-panel]`（面板，**无 `max-height`**） |
| `.td-modal-box` scrollHeight/clientHeight（1120×800）= 799/750 ⇒ **49px 内部滚动** | 覆盖层 `[data-create-task]` 竖向溢出（1120×800）= **0px**（等价物「装得下」，非 49px 内部滚动） |

- **期望值（实现侧）**：R4 的「盖上视口上限 + 自己滚」由 **`[data-create-task]` 覆盖层自身的 `overflow-y:auto`** 表达；**不要求**实现有 `.td-modal-box`。1120×800 覆盖层溢出 **0px**。
- **未复测项（如实标注）**：覆盖层 1512×950 的溢出量未单独复测（原型侧该视口为 799/799 无溢出）。
- **落地**：§5 **B-7** 换写为对 `[data-create-task]` 覆盖层的断言（期望 `0px`）；§2.3 落点行「弹窗根」（原 `.td-modal-box`）更正为 `[data-create-task]` / `[data-create-task-panel]`（③-6 / §4.1 行 23 同步）。
- **全局口径**：本契约 §2–§4 中凡以 `.td-modal-box` 描述 **实现侧落点** 者，一律以本节等价 selector 为准；§2.1/§2.3.2 探针里 `.td-modal-box` 的数值（799/750 等）**保留**，仅作原型侧历史，不再作为实现侧断言。

### 9.3 项③ 760 断点：**裁定 (b) — 对齐基线，≤760 单列**

- **基线意图（既有文档，非本轮新造）**：`design/DESIGN.md` §18.5 明写「tracks … stack at **≤760px**, which is its own media query rather than the shell's 759px one, **because the dialog has to be single-column *at* 760**」；`design/prototype/**` 用原生 `@media (max-width:760px)`（包含式）⇒ 原型 **760 单列**。契约 §2.3 ③-7 / §5 B-12 记「760 单列」与之同源。
- **实现侧现状（实测）**：`CreateTaskModal.vue` 用 Tailwind v4 `max-[760px]:grid-cols-1` ⇒ 编译为 `@media (width < 760px)`（**排他式**）⇒ **760 双列、759 单列**（探针：@760×900 轨道 = 2「407.375px 254.625px」；@759×900 = 1「677px」）。
- **裁定**：**(b) 对齐基线** —— 基线意图明确且经推理（弹窗有自己的查询、比 shell 早 1px 折叠），原型（本轮设计载体）已实现；实现侧的排他式是 Tailwind v4 移植产物、非设计决策。**保持契约「≤760 单列」不变**，由实现侧修正。
- **为何不取 (a)**：(a) 需把契约改为「≤759 单列」并同步 `DESIGN.md` §18.5 与**原型**（`design/prototype/**` 的媒体查询），即改三处、且使原型与设计文档互相矛盾；(b) 只改实现一处，原型/文档/契约三者保持一致 —— 最小改动即最大一致。
- **修正落点（供 impl 卡，本轮不写实现）**：单列应为**默认**、双列只在 **≥761px** 生效，等价 Tailwind 写法 `grid-cols-1 min-[761px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]`（或等价包含式）；保留 `minmax(0, …)` 防横向溢出。
- **预期**：修正后 @760×900 轨道数 = **1**（§5 B-12 期望 `1` 保持）；`.td-md-editor` 高度随之从 @760 的 **499px**（双列态）回到单列口径（原型 399px 量级）。当前 §5 B-12 与验证探针在 760 会红 —— 那是**待 impl 修正**的偏差，非契约错误。

### 9.4 文档同步判定（§⑫）

| 文档 | 是否改动 | 理由 |
|---|---|---|
| `design/fidelity-r10.md` | **已改** | 本节 + §5 B-1/B-7/B-12 + §2.3 弹窗根/③-6/③-7 + §4.1 行 23 |
| `design/BLOCKS.md` | **不改（有意）** | BLOCKS.md 描述的是**原型**侧块结构（B10 的 `dialog[data-create-task] → .td-modal-box`）；原型确实用 `.td-modal-box`，改它会破坏 原型↔BLOCKS 一致性。实现侧等价物由本契约 §9.2 承载。 |
| `design/DESIGN.md` | **不改（有意）** | §18.5 的「dialog 在 ≤760 单列」与裁定 (b) **一致**（基线意图正是 (b) 的依据）；§18.5 的 `.td-modal-box` 属设计/原型侧表达。 |
| `design/prototype/**` | **不改（有意）** | 原型媒体查询已是包含式（≤760 单列），符合裁定 (b)。 |
| `web/**` / `test/**` / `src/**` | **不改（红线）** | 本轮只改契约；760 修正由 Elon 另派 impl 卡。 |

**结论**：三条口径差已逐条给出实现侧期望值并回写；项①③ 为**契约/实现口径对齐**，项③ 裁定 **(b)、需另派 impl 卡**（Linus）；本卡不写实现。
