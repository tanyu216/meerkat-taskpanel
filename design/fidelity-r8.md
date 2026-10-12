# UI 保真契约 · R8 — Terry 三项列表/弹窗反馈（Before 契约）

> 卡：`T-20261012-211516` · 日期 2026-10-12 · 范围「R8：Terry 三项 taskpanel UI 反馈」· 定位「§⑨.1 Before = 结构契约」。
> 来源：Terry 2026-10-12 21:11 三项反馈 —— ① 深色「创建任务」弹窗与背景分不清；② 任务列表缺列标题（仅 ID 有）+ 数据行未对齐；③ 任务 ID 省略截断，最多 8 字符。父伞卡 `T-20261012-165652`。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 「期望计算样式」一律取自**原型在真实浏览器中的 computed style 实测**；实现侧一律**实读源码**（本轮**未**到场实测 `web/dist`，凡未实测处均已标注）。
> 关系卡：实现卡（`web/**` 镜像改动）与验证卡由 Elon 派发；**本卡只产契约与原型改动，不含实现代码**。
> 基线 commit：`1ae47f7`（R7 修订交付，本卡开工时的 HEAD）。

## 0. 结论摘要

- 三项**全部落在既有块**（① B10 弹窗 · ② B08 列表 · ③ B07/B08/B09 的标识符渲染点）⇒ 本契约**不引入新块**；仅新增两个钩子/类：`.td-id`（截断类的兜底）与实现侧 `[data-create-task-panel]`（见 §2.1）。
- **三项都是设计变更**（原型侧同样缺口径，不是「实现偏离原型」）：本轮**无「无设计变更」项**（§3 逐项说明）。
- ① 的根因**不是单点**：深色下**三层同时失分离** —— 遮罩（原型 `--scrim` 只在 `:root` 定义、深色沿用 ⇒ 不压暗）、面板边框（`--color-td-line` #1f262a 贴着画布 #0f1417 与面板面 #161b1e）、面板阴影（`--shadow-pop` 的色相取自画布色 ⇒ 深色下高度不可见）。**浅色三者不变**。
- ② 的根因是**列头与行不同源**：`.td-list-head` 是 `display:flex` 且只含 1 个 `list.columns.identifier` label，而行是 **6 轨 grid** ⇒ 除 ID 外全列无标题，且列头没有任何列宽可与行对齐。**列头升级为与行同一份 6 轨模板**，列集合与行 cell **一一对应**（§2.2 列全 6 列）。
- ③ 的口径 = **「8 字符 + …」**：ID 本体最多 **8** 字符，超出追加省略号；**机制是渲染层字符切片**（`display = len > 8 ? slice(0,8) + "…" : full`），不用 CSS 宽度近似（`max-width` 是宽度行为、随字体漂移，无法保证「恰好 8 字符」）；`title` 保留**全 ID**，行根 / 抽屉根的 `data-identifier` 也保留全 ID。配套 `.td-id` 类只做**单行**兜底。
- ③ 有**真实触发样本**：真实 ID 长度 6（`TD-128`）～9（`PROJ-0007`）⇒ 9 字符 ID 确实存在，不是假想边界。原型已注入 `PROJ-0007` 作为可见样本。
- 契约实测订正 3 条（§1 R8-1 / R8-2 / R8-3）：`minmax(0, 1fr)` 的 computed 值被解析成像素；`max-width: 9ch` **不得**用来断言「8 字符」；实现侧弹窗面板**当前无可机检钩子**。
- 三项均有 selector 级机检断言（§7 A/B 两类），供实现卡「During」直接落测。**§7 C 列出 4 条「不得断言」**。

---

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：

1. 「期望计算样式」= 原型在真实浏览器（Chromium，headless）中的 **computed style 实测值**，不是 `src/input.css` 里某条声明的字面值；两者不一致时实测值胜，并把矛盾记入 §1 的实测订正。
2. 「实现位点」= 实读 `web/**` 后的选择器。**本轮实现侧一律未到场实测**（未构建 `web/dist`）⇒ 实现位点标注「实读」；凡引用实现现值处均如此标注，不得当作实测传播。
3. token 名：原型侧沿用 `--color-td-*` / `--scrim` / `--shadow-pop` / `--r-*`；实现侧以 `web/src/styles/tokens.css` 的 `--brand-*` 为准（同义）。
4. 本轮原型 console / pageerror 均为 `[]`（自检工具 `workspace/T-20261012-211516/tools/selfcheck.json`）。

**实测对本契约的订正（3 条）**：

- **R8-1（项②，关键）**：**不得**用字面 `74px minmax(0, 1fr) 108px 132px 96px 72px` 断言列头/行的 `grid-template-columns`。computed 层会把 `minmax(0, 1fr)` **解析成用后像素**，且**随视口变化**：原型实测 1512 档 `74px 648px 108px 132px 96px 72px`、760 档 `74px 96px 108px 132px 96px 72px`、430 档 `64px 144px 84px`。可机检的信号是 **`.td-list-head` 的该字符串与 `.td-list-row` 的该字符串逐字相等**（两侧各自解析，解析规则相同 ⇒ 相等仍成立）。
- **R8-2（项③，关键）**：**不得**用 `.td-id` 的 `max-width: 9ch` 断言「至多 8 字符」。`ch` 是**宽度**单位，落在字体度量上：原型实测该元素 computed `max-width` = **`65.0215px`**（≈ 7.22px/ch），而字距（`.td-mono` 带 `letter-spacing: -0.01em`）、字体回退或合成字形都会让「9ch 恰好装下 9 个字形」不再成立。可机检的「8 字符」信号**只有** DOM 文本本身（`textContent`）。`.td-id` 只断言**单行**（`white-space: nowrap`）与兜底存在性。
- **R8-3（项①，实现侧）**：实现侧弹窗面板**当前既无 data-* 钩子也无类名**，只能以 `[data-create-task] > div` 定位 —— 那是**位置锚**，与 BLOCKS.md 的「禁位置锚」相悖。本契约把 `[data-create-task-panel]` 列为实现侧的**必补钩子**（原型侧对应 `.modal-box`），否则 ① 的实现侧断言无处可落。

**共用 token 实测值（原型）**：

| token | light | dark |
|---|---|---|
| `--scrim` | `rgba(15, 20, 23, 0.32)` | **`rgba(0, 0, 0, 0.55)`**（R8 新增覆写） |
| `--shadow-pop` | `0 8px 24px rgba(15, 20, 23, 0.1), 0 1px 2px rgba(15, 20, 23, 0.06)` | **`0 16px 40px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.5)`**（R8 新增覆写） |
| `--color-td-line` | `#e6e8eb` | `#1f262a` |
| `--color-td-line-strong` | — | `#313b41` |
| `--color-td-surface` | `#ffffff` | `#161b1e` |
| `--color-td-bg` | — | `#0f1417` |

深色断点块有两处**必须同改**（文件既有约定，CSS 无法跨 media 边界共享声明）：`design/prototype/src/input.css:html[data-theme="dark"]` 与其孪生 `design/prototype/src/input.css:@media (prefers-color-scheme: dark) > html[data-theme="auto"]`。

**改动后实测摘要（原型，`tools/selfcheck.json`，49/49 条断言通过）**

| 量 | light | dark |
|---|---|---|
| `[data-create-task]` `background-color` | `rgba(15, 20, 23, 0.32)`（**不变**） | `rgba(0, 0, 0, 0.55)` |
| `[data-create-task] .modal-box` `border-top-color` | `rgb(230, 232, 235)`（**不变**） | `rgb(49, 59, 65)` |
| `[data-create-task] .modal-box` `box-shadow` | `rgba(15, 20, 23, 0.1) 0px 8px 24px 0px, rgba(15, 20, 23, 0.06) 0px 1px 2px 0px`（**不变**） | `rgba(0, 0, 0, 0.6) 0px 16px 40px 0px, rgba(0, 0, 0, 0.5) 0px 2px 8px 0px` |
| `[data-detail-overlay]` `background-color` | `rgba(15, 20, 23, 0.32)` | `rgba(0, 0, 0, 0.55)` |
| `.td-list-head` `display` / 可见单元 | `grid` / 1512·760 → 6、430 → 3 | 同 |
| `.td-list-head` `gap` / `padding-left` | `12px` / `12px`（与行相等） | 同 |
| `[data-skeleton] .td-list-head > :only-child` `grid-column` | `1 / -1` | 同 |
| `[data-list-identifier]` / `[data-card-identifier]` / `[data-detail-identifier]` 的 `textContent`（9 字符样本） | `PROJ-000…`（`title` = `PROJ-0007`） | 同 |
| 同上，6 字符样本（`TD-128`） | `TD-128`（不截断） | 同 |
| 行根 / 卡根 / 抽屉根 `data-identifier` | 全 ID（`PROJ-0007`） | 同 |
| 页面溢出（1512 / 1240 / 980 / 760 / 430） | `scrollWidth === clientWidth`，5/5 通过；`console` / `pageerror` 皆 0 | 同 |

---

## 2. 逐项契约

### 2.1 项① `B10.dark-separation` — 深色下弹窗与背景的分离

*证据：原型 1512 档 light / dark 实测（`tools/baseline.json` 为改动前基线，`tools/selfcheck.json` 为改动后）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B10.dark-separation` |
| 唯一 selector（遮罩） | `dialog.modal[data-create-task]` —— 原型把面纱上在 **dialog 自身**（`design/prototype/src/input.css:.modal { background-color: var(--scrim) }`；daisyUI 的 `.modal::backdrop` 是 `display: none`，不是独立层） |
| 唯一 selector（面板） | `[data-create-task] .modal-box`（原型类集 `modal-box td-modal-box`）。实现侧**必补** `[data-create-task-panel]` |
| data-* 钩子 | `[data-create-task]`（已存在）· `[data-create-project]`（同 `.modal-box` 口径，一并生效）· 实现侧新增 `[data-create-task-panel]` / `[data-create-project-panel]` |
| 同 token 的旁证面 | `[data-detail-overlay]`（原型 `.td-scrim`）—— 读同一个 `--scrim` ⇒ 深色同步加深，属**预期**，不需另写规则 |

**期望 computed —— 深色（`html[data-theme="dark"]`）**

| 元素 | 属性 | 期望（实测） |
|---|---|---|
| `[data-create-task]` | `background-color` | `rgba(0, 0, 0, 0.55)` |
| `[data-create-task] .modal-box` | `border-top-color` | `rgb(49, 59, 65)`（= `--color-td-line-strong` #313b41） |
| `[data-create-task] .modal-box` | `border-top-width` / `border-top-style` | `1px` / `solid`（不变） |
| `[data-create-task] .modal-box` | `box-shadow` | 含 `rgba(0, 0, 0, 0.6)`（= 新的 `--shadow-pop`） |
| `[data-create-task] .modal-box` | `background-color` | `rgb(22, 27, 30)`（= `--color-td-surface`，**不变**） |
| `[data-detail-overlay]` | `background-color` | `rgba(0, 0, 0, 0.55)`（同 `--scrim`） |

> `html[data-theme="auto"]` 在系统深色下走孪生块 ⇒ **同值**。

**期望 computed —— 浅色（回归，三者必须不变）**

| 元素 | 属性 | 期望（实测） |
|---|---|---|
| `[data-create-task]` | `background-color` | `rgba(15, 20, 23, 0.32)` |
| `[data-create-task] .modal-box` | `border-top-color` | `rgb(230, 232, 235)`（= `--color-td-line`） |
| `[data-create-task] .modal-box` | `box-shadow` | **不含** `rgba(0, 0, 0, 0.6)`；仍为 `rgba(15, 20, 23, 0.1) 0px 8px 24px 0px, rgba(15, 20, 23, 0.06) 0px 1px 2px 0px` |

**「到场复现」—— 改动前的深色实测（`tools/baseline.json`，HEAD `1ae47f7`）**

| 量 | 深色实测（改动前） | 判定 |
|---|---|---|
| `[data-create-task]` `background-color` | `rgba(15, 20, 23, 0.32)` | 与浅色**同值** ⇒ 深色遮罩根本没有加深 |
| 面板 `border-top-color` | `rgb(31, 38, 42)`（#1f262a） | 贴着画布 #0f1417 与面板面 #161b1e ⇒ 边不可辨 |
| 面板 `box-shadow` | `rgba(15, 20, 23, 0.1) 0 8px 24px, rgba(15, 20, 23, 0.06) 0 1px 2px` | 阴影色相取自画布色 ⇒ 深色下高度不可见 |
| `--scrim`（深色） | `rgba(15, 20, 23, 0.32)` | = light 值 ⇒ 深色无覆写 |
| `--shadow-pop`（深色） | 同 `:root` light 值 | 深色无覆写 |

⇒ **Terry 所见成立**，且根因是三层同时失分离。

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异（实读） | 归类 |
|---|---|---|---|---|
| 1 | 遮罩不是「压暗」而是**提亮** | `web/src/components/create/CreateTaskModal.vue`:`[data-create-task]` | 类集用 Tailwind `bg-neutral/32`（daisyUI `--color-neutral` 32%）。深色 `--color-neutral:#2a3236`（`web/src/styles/tokens.css`:`[data-theme="dark"]`）比画布 `--brand-bg:#0f1417` **更亮** ⇒ 32% 的 it 叠在画布上把背景**提亮**，弹窗反而更贴背景 | 缺 |
| 2 | 面板边框用 `--brand-border` | `web/src/components/create/CreateTaskModal.vue`:`[data-create-task] > div` | `border border-(--brand-border)` ⇒ 深色 `#1f262a`，与画布 / 面板面近乎同度；原型深色改用 `--color-td-line-strong` `#313b41` | 缺 |
| 3 | 深色 `--shadow-pop` 无覆写 | `web/src/styles/tokens.css`:`[data-theme="dark"]` | `--shadow-pop` **只**在 `:root`（light）定义，深色块未重述 ⇒ 阴影色相仍是 `rgba(15,20,23,·)` ≈ 画布色 ⇒ 深色下高度不可见 | 缺 |
| 4 | `--brand-scrim` token **不存在** | `web/src/styles/tokens.css`（`:root` 与 `[data-theme="dark"]` 两处皆无） | 原型有 `--scrim`（light `.32` / dark `.55`），实现侧从未把它移植进 `web/**` ⇒ 没有可覆写的单一遮罩 token | 缺 |
| 5 | 面板**无可机检钩子** | `web/src/components/create/CreateTaskModal.vue`:`[data-create-task] > div` | 面板 `div` 既无 `data-*` 也无类名，只有工具类 ⇒ 只能位置锚定位（见 R8-3） | 缺 |
| 6 | 抽屉 / 权限面板的遮罩各用各的 alpha | `web/src/components/detail/DetailDrawer.vue`:`[data-detail-overlay]`（`bg-neutral opacity-32`）· `web/src/components/review/AccessPanel.vue`:`[data-access-overlay]`（`bg-neutral/40`） | 原型这两个面与弹窗**共用一个 `--scrim`**；实现侧三处各写各的 ⇒ 深色下同样提亮 | 口径 |

**落地建议表（实现侧镜像 —— 只写期望，不写实现代码）**

| # | 建议 | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 新增 `--brand-scrim`：light **保持现值**，dark = `rgba(0, 0, 0, 0.55)` | `web/src/styles/tokens.css`（`:root` 与 `[data-theme="dark"]`，及 `html[data-theme="auto"]` 的 media 孪生） | light 必须**逐字复现今日的 `bg-neutral/32`**（`color-mix(in oklab, var(--color-neutral) 32%, transparent)`），否则浅色会被改到（§7 C4） |
| 2 | 弹窗遮罩改用该 token | `web/src/components/create/CreateTaskModal.vue`:`[data-create-task]`、`CreateProjectModal.vue`:`[data-create-project]` | 抽屉 / 权限面板随后统一（口径一致） |
| 3 | 深色面板边框改用强调线 | `web/src/styles/app.css` 或 `tokens.css`：`[data-theme="dark"] [data-create-task-panel]` | 期望值 = `rgb(49, 59, 65)`；浅色不动 |
| 4 | 深色覆写 `--shadow-pop` | `web/src/styles/tokens.css`:`[data-theme="dark"]` | 期望 `box-shadow` 含 `rgba(0, 0, 0, 0.6)` |
| 5 | 补 `[data-create-task-panel]` / `[data-create-project-panel]` | `CreateTaskModal.vue` / `CreateProjectModal.vue` 的面板 `div` | 让 ① 有非位置锚可断言（R8-3） |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N1 | 浅色 `[data-create-task]` 的 `background-color` | 与本轮改动前**逐字相同**（回归门） |
| N2 | 浅色 `[data-create-task] .modal-box` 的 `border-top-color` | = `--color-td-line` 浅色值（不被 `-strong` 命中） |
| N3 | 深色 `[data-create-task] .modal-box` 的 `background-color` | `rgb(22, 27, 30)` —— **面板面不改**（改的是边与影，不是面） |
| N4 | 深色遮罩的相对明度 | 必须**低于**浅色遮罩 —— 即「压暗」而非「提亮」（这条正是 Terry 反馈的机检形式） |

---

### 2.2 项② `B08.list-header` — 列表列头（6 列，与行同轨）

*证据：原型 1512 / 760 / 430 三档 light 实测（`tools/selfcheck.json`）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B08.list-header` |
| 唯一 selector（列头） | `.td-list-group:not([data-skeleton]) .td-list-head` |
| 唯一 selector（行） | `[data-list-rows] .td-list-row` |
| data-* 钩子 | 列头单元用 `data-i18n="list.columns.*"`；行单元走既有钩子（下表） |
| 共享列模板 | `.td-list-head, .td-list-row { grid-template-columns: 74px minmax(0, 1fr) 108px 132px 96px 72px; gap: 12px; padding: 0 12px; }` —— **同一份声明**，这是「同源」的机检形式 |
| ≤759（`@media (max-width: 759px)`） | 同一条规则改为 `64px minmax(0, 1fr) 84px`（列头与行**一起**）；中间 3 列 `display: none`（列头与行**一起**） |

**期望 computed**

| 元素 | 属性 | 期望（实测） |
|---|---|---|
| `.td-list-head`（真实分组） | `display` | `grid`（改动前 `flex`） |
| `.td-list-head` | `grid-template-columns` | **与 `[data-list-rows] .td-list-row` 的该字符串逐字相等**。实测（两侧同值）：1512 档 `74px 648px 108px 132px 96px 72px` · 760 档 `74px 96px 108px 132px 96px 72px` · 430 档 `64px 144px 84px` |
| `.td-list-head` | `gap` / `padding-left` | 与行相等（`12px` / `12px`） |
| `.td-list-head` | `height` / `text-transform` / `color` / `background-color` / `border-bottom` | **不变**（`32px` / `uppercase` / `--color-td-ink-3` / `--color-td-sunken` / `1px solid --color-td-line`） |
| `.td-list-head > *` | 计数 | **6**（≤759 档 3 个 `display: none`） |
| `.td-list-head > *` | `justify-self` | `start`（列头单元靠格起端，与行同规则） |
| `[data-skeleton] .td-list-head > :only-child` | `grid-column` | `1 / -1` —— 加载文案**跨满整行**（它不是一个列标签；不这样做会在 74px 的第 1 轨里折行） |
| `[data-skeleton] .td-list-head > *` | 计数 | **1**（加载态不入列） |

**列集合（6 列全列 —— 列头 label ↔ 行 cell 一一对应）**

| # | 列 | 列头 label 钩子 | 列头 i18n key | 列头初值 | 行 cell 钩子 | 行轨宽 | ≤759 |
|---|---|---|---|---|---|---|---|
| 1 | ID | `.td-list-head > :nth-child(1)` | `list.columns.identifier`（既有） | `ID` | `[data-list-identifier]` | `74px` | 可见 |
| 2 | Title | `.td-list-head > :nth-child(2)` | `list.columns.title`（**新**） | `Title` | `[data-list-title]` | `minmax(0, 1fr)` | 可见 |
| 3 | Status | `.td-list-head > :nth-child(3)` | `list.columns.status`（**新**） | `Status` | `[data-list-status]` | `108px` | **隐藏** |
| 4 | Assignee | `.td-list-head > :nth-child(4)` | `list.columns.assignee`（**新**） | `Assignee` | `[data-list-assignee]` | `132px` | **隐藏** |
| 5 | Priority | `.td-list-head > :nth-child(5)` | `list.columns.priority`（**新**） | `Priority` | `[data-list-priority]` | `96px` | **隐藏** |
| 6 | Revision | `.td-list-head > :nth-child(6)` | `list.columns.revision`（**新**） | `Revision` | `[data-list-revision]` | `72px` | 可见 |

> 轨宽顺序与 `.td-list-row` 的 `grid-template-columns` **同序**：`74px · 1fr · 108px · 132px · 96px · 72px`。
> 隐藏的是**中间 3 列**（Status / Assignee / Priority），与行 cell 的 `td-hide-sm` 一一对应 —— 两侧**同一套** `td-hide-sm`，不是两套。

**新增 i18n key（en + zh，各 5 个；两侧字典必须仍是集合相等的 220 个）**

| key | en | zh |
|---|---|---|
| `list.columns.title` | `Title` | `标题` |
| `list.columns.status` | `Status` | `状态` |
| `list.columns.assignee` | `Assignee` | `负责人` |
| `list.columns.priority` | `Priority` | `优先级` |
| `list.columns.revision` | `Revision` | `版本` |

**「到场复现」—— 改动前实测（`tools/baseline.json`）**

| 量 | 1512 档实测（改动前） | 判定 |
|---|---|---|
| `.td-list-head`（真实分组） `display` | `flex` | 与行的 `grid` **不同源** |
| `.td-list-head` `grid-template-columns` | `none` | 列头没有列宽 ⇒ 结构上不可能与行对齐 |
| `.td-list-head` `gap` | `normal` | 同上 |
| `.td-list-head` 单元计数 / 可见 | **1** / 1（`list.columns.identifier` = `ID`，宽 12.66px） | 仅有 ID 一列有标题 |
| `[data-list-rows] .td-list-row` `grid-template-columns` | `74px 96px 108px 132px 96px 72px` | 行是 6 轨 ⇒ 列头 1 项 vs 行 6 轨 |
| 430 档行 `grid-template-columns` | `64px 144px 84px` | 窄屏行是 3 轨，列头仍无轨道 |

⇒ **Terry 所见成立**：「仅 ID 有列标题」是结构事实（列头只有 1 个 label），「不像表格」是因为列头与行不共享任何列定义。

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异（实读） | 归类 |
|---|---|---|---|---|
| 1 | 列头只有 1 列 | `web/src/components/board/ListView.vue`:`.td-list-head` | 只含 `<span>{{ $t("list.columns.identifier") }}</span>` 一个子元素 ⇒ 5 列无标题 | 缺 |
| 2 | 列头 `display: flex` | `web/src/styles/app.css`:`.td-list-head` | `display: flex`，无 `grid-template-columns`；行是 6 轨 grid ⇒ 不同源 | 缺 |
| 3 | 列头无共享模板声明 | `web/src/styles/app.css`:`.td-list-head` vs `.td-list-row` | 行的轨宽 / `gap` / `padding` 三者在列头上**都不存在**（列头只有 `padding: 0 var(--space-3)`） | 缺 |
| 4 | 窄屏只改行、不改列头 | `web/src/styles/app.css`:`@media (max-width: 759px)` | 该块只有 `.td-list-row` 的 3 轨与 `.td-list-row > .td-hide-sm`；**没有任何 `.td-list-head` 规则** ⇒ 窄屏列头会按 6 轨铺而行走 3 轨 | 缺 |
| 5 | 5 个 `list.columns.*` key 不存在 | `web/src/i18n/catalogue.mjs` | `list.*` 只有 `list.label` / `list.loading` / `list.columns.identifier` / `list.emptyRow`；两语言皆然（`test/web/i18n.catalogue.mjs` 同） | 缺 |
| 6 | 行 cell 的 6 列钩子 | `web/src/components/board/ListView.vue`:`[data-list-row]` | 6 个 cell 顺序与钩子与原型**逐字一致**（`identifier` `title` `status` `assignee` `priority` `revision`），`td-hide-sm` 落在第 3/4/5 个 | 对齐 |

**落地建议表（实现侧镜像）**

| # | 建议 | 作用位点 | 备注 |
|---|---|---|---|
| 1 | 把行的 `grid-template-columns` / `gap` / `padding` 提取成 `.td-list-head, .td-list-row` 共享规则 | `web/src/styles/app.css` | 同源是**机制**，不是巧合；不要在两处各写一遍（会漂） |
| 2 | `.td-list-head` 由 `flex` 改 `grid`，其余声明保留 | 同上 | 高度 / 字面（uppercase / 11px / letter-spacing）不变 |
| 3 | `.td-list-head > *` 加 `justify-self: start; min-width: 0` | 同上 | 与行的 `> *` 规则合并为同一选择器组 |
| 4 | ≤759 块里把 `.td-list-head` 加进行轨规则与 `td-hide-sm` 规则 | 同上 | 两条都加；否则窄屏重新错位 |
| 5 | 列头补 5 个 `<span data-i18n="list.columns.*">`（第 3/4/5 个带 `td-hide-sm`） | `web/src/components/board/ListView.vue`:`.td-list-head` | 顺序=上表；不可复用 `list.columns.identifier` 顶替 |
| 6 | `catalogue.mjs` 补 5 个 key × 2 语言 | `web/src/i18n/catalogue.mjs` | 与 `test/web/i18n.catalogue.mjs` 的镜像需同步（属实现卡范围） |
| 7 | 加载态列头**保持单 span**，并让它在模板上跨满 | `web/src/components/board/ListView.vue`:`.td-list-head`（`data-skeleton` 分组） | 不改就会在 74px 第 1 轨里折行 |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N1 | `.td-list-head` 的单元计数 | `6`（不是 1；≤759 档仍是 6 个元素、3 个 `display:none`） |
| N2 | 列头任一单元 `textContent` | **不得**以 `list.` 开头（不得把 i18n key 直接渲染出来） |
| N3 | `.td-list-head > *` 的 `justify-self` | 全部 `start`（标题与行内容同一起点） |
| N4 | `[data-skeleton] .td-list-head > *` 计数 | `1` —— 加载文案不是列标签 |
| N5 | ≤759 档 `.td-list-head` 与 `.td-list-row` 的可见单元数 | 两侧**相等**（皆 3） |

---

### 2.3 项③ `B07/B08/B09.identifier-clamp` — 任务 ID 上限「8 字符 + …」

*证据：原型 1512 档 light 实测（`tools/selfcheck.json`）；三处渲染点的 selector 逐条列于下表。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B07/B08/B09.identifier-clamp` |
| 唯一 selector（列表） | `[data-list-rows] [data-list-identifier]` |
| 唯一 selector（卡片） | `[data-card-identifier]`（原型同元素带 `.td-card-id`） |
| 唯一 selector（抽屉） | `[data-detail-identifier]` |
| data-* 钩子 | 上述三个**读**钩子不变；行根 `[data-list-row][data-identifier]` 与抽屉根 `[data-detail-drawer][data-identifier]` 继续携带**全 ID** |
| 兜底类 | `.td-id`（`display: inline-block; max-width: 9ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom`） |
| 口径 | **「8 字符 + …」**：`display = full.length > 8 ? full.slice(0, 8) + "…" : full` |

**机制（裁定，勿改）**

| 项 | 裁定 | 理由 |
|---|---|---|
| 显示口径 | **8 字符 + 省略号**（本体 ≤8，超出再加 `…`） | 硬切会让两个长 ID 视觉同名；省略号是通用截断信号 |
| 截断机制 | **渲染层字符切片**（`String.prototype.slice`） | `max-width` 是**宽度**行为，随字体 / 字距漂移，无法保证「恰好 8 字符」；字符切片确定、可机检（R8-2） |
| `.td-id` 的角色 | **单行兜底**（`nowrap` + 溢出省略），**不是**截断机制本身 | 双保险：即便某个渲染路径漏切片，也不会折行 |
| 全 ID 的可读性 | `title` = 全 ID（悬浮）；行根 / 抽屉根的 `data-identifier` = 全 ID | 复制、a11y、测试取全值不因截断而受损 |
| **不做** | JS 之外的第二处巨型文案；不截断组合框的 `.td-combo-id` | 三处渲染点之外的面不在本轮范围 |

**期望值（三处一致）**

| 元素 | 属性 / 值 | 期望 |
|---|---|---|
| `[data-list-identifier]` / `[data-card-identifier]` / `[data-detail-identifier]` | `white-space` | `nowrap` |
| 同上 | `title` | **=== 全 ID**（非空、非截断值） |
| 同上 | `textContent` | `full.length <= 8 ? full : full.slice(0, 8) + "…"` |
| 同上 | `textContent.length` | `<= 9` |
| 同上 | 类集 | 含 `.td-id` |
| `[data-list-row]` | `data-identifier` | 全 ID（非截断值） |
| `[data-detail-drawer]` | `data-identifier` | 全 ID（**本轮新增**；改动前该属性不存在，见 §5） |
| 9 字符样本 `PROJ-0007` | `textContent` | `PROJ-000…`（8 字符 + `…`） |
| 6 字符 ID（如 `TD-128`） | `textContent` | `TD-128`（**不截断**、不加省略号） |

**「到场复现」—— 改动前实测（`tools/baseline.json`）**

| 量 | 实测（改动前） | 判定 |
|---|---|---|
| 三处 ID 元素的 `white-space` | `normal` | 无单行约束 |
| 三处 ID 元素的 `max-width` | `none` | 无宽度上限 |
| 三处 ID 元素的 `overflow` / `text-overflow` | `visible` / `clip` | 无任何截断 |
| 三处 ID 元素的 `title` | `null`（三处皆无） | 全 ID 无处可读 |
| `cardSpans` / `listRows` 的 `text` | 全 ID（`TD-131` …） | 未截断 |
| 三处 ID 元素的 `font-family` | `"JetBrains Mono", ui-monospace, …` | **等宽面**（这是 `ch` 单位可用的前提，也是 R8-2 仍不足以断言的对照） |
| `[data-detail-drawer]` `data-identifier` | `null` | 抽屉根**不带**全 ID ⇒ 切片后必须有别的全值来源（见下） |

⇒ **Terry 所见成立且必要**：原型侧同样没有任何截断口径；而真实 ID 有 9 字符样本（`PROJ-0007`），8 字符上限确有触发场景。

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异（实读） | 归类 |
|---|---|---|---|---|
| 1 | 列表 ID 无截断、无 `title` | `web/src/components/board/ListView.vue`:`[data-list-identifier]` | `class="td-mono text-[12px] text-(--brand-text-3)"`，无 `title`、无宽度约束 | 缺失口径 |
| 2 | 卡片 ID 无截断、无 `title` | `web/src/components/board/Card.vue`:`[data-card-identifier]` | `class="td-mono text-[11px] text-(--brand-text-3)"`（**注意：实现侧不带 `.td-card-id`**，只用工具类），无 `title` | 缺失口径 |
| 3 | 抽屉 ID 无截断、无 `title` | `web/src/components/detail/DetailDrawer.vue`:`[data-detail-identifier]` | `class="td-mono"`，无 `title` | 缺失口径 |
| 4 | 无 `.td-id` 类 | `web/src/styles/app.css`（全文件） | 无该规则 | 缺 |
| 5 | 行根 / 卡根已带全 ID | `ListView.vue`:`[data-list-row]` 的 `:data-identifier` · `Card.vue`:`[data-card]` 的 `:data-identifier` | **已对齐**（全 ID 走属性，不走文本） | 对齐 |
| 6 | 无任何代码从 DOM 读回 ID | `web/**`、`web/scripts/dom-smoke.mjs`、`test/web/blocks.contract.mjs` | 三个 ID 钩子**只被写入**，从未被读回；定位一律走 `[data-identifier]` 属性 ⇒ 文本截断**不会**打断任何查找（原型侧则有一处读回，已随本轮改掉，见 §5） | 对齐 |

**落地建议表（实现侧镜像）**

| # | 建议 | 作用位点 | 备注 |
|---|---|---|---|
| 1 | 加一个纯函数算出显示值（`len > 8 ? slice(0,8) + "…" : value`），三处渲染点共用 | `web/src/**`（组件或 shared helper） | 复用同一实现，避免三处各写一遍 |
| 2 | 三处渲染点：文本 = 该函数结果；`title` = 全 ID | `ListView.vue`:`[data-list-identifier]` · `Card.vue`:`[data-card-identifier]` · `DetailDrawer.vue`:`[data-detail-identifier]` | `title` 与文本必须来自**同一个**全 ID 变量 |
| 3 | 三处加 `.td-id`（或等价工具类组合） | `web/src/styles/app.css` | 期望 computed：`white-space: nowrap`、`max-width: 9ch` |
| 4 | 三个钩子的**读**语义不动 | 同上 | 无代码读回（偏离表 #6），故无迁移负担 |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N1 | 三处 ID 的 `textContent` 长度 | `<= 9`（且等于 `rule(title)`） |
| N2 | 三处 ID 的 `title` | 非空，且 `=== ` 该条目的全 ID |
| N3 | 6 字符 ID 的 `textContent` | 与 `title` **逐字相等**（不因上限而误截） |
| N4 | `[data-list-row]` / `[data-card]` / `[data-detail-drawer]` 的 `data-identifier` | 全 ID（**不得**等于截断值） |
| N5 | `.td-combo-id`（组合框选项里的 ID） | **不在本轮范围**：不得以本轮名义改动 |

---

## 3. 与既有轮次的边界（正交声明，必须显式）

| 本轮项 | 与既有轮次的关系 |
|---|---|
| ① `B10.dark-separation` | **正交于 R7**（R7 只动 B03 侧栏 footer 与 B09 抽屉关闭按钮）；正交于 R3/R4 的「弹窗两栏 / 变宽变高」（那是**尺寸与内容**，本轮动的是**深色的遮罩 / 边 / 影**，尺寸与浅色全部不动）。 |
| ② `B08.list-header` | **正交于 R7**；与 B13（加载态）有**接触但不重叠**：加载态那处 `.td-list-head` **保持单 span**，本轮只给它一条「跨满模板」的规则（否则会被新列模板挤进 74px；见 §2.2 落地建议 7）。 |
| ③ `B07/B08/B09.identifier-clamp` | **正交于 R7 ④**（那是抽屉头的**关闭按钮位置**，本轮动的是**标识符文本**，同一 B09 头部的不同元素）。正交于 R2/R5/R6 的一切（本轮不碰 chip / 标签 / 组合框）。 |

**本轮无「无设计变更」项。** 三项都是设计变更 —— 原型侧同样没有对应口径（① 深色三层皆无覆写；② 列头只有 1 个 label 且非 grid；③ 完全无截断口径）。三项的**原型改动已随本卡落地**（`design/prototype/src/input.css` / `index.html` / `app.js` / `tw.css` 重建），并已同步 `design/DESIGN.md` §24 / `design/BLOCKS.md`。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目（含「一致」者）

| # | 项 | 块 | selector / hook | 期望 | 现状（实现，实读） | 差异类型 |
|---|---|---|---|---|---|---|
| 1 | ① | B10 | `[data-create-task]` | 深色遮罩 `rgba(0,0,0,0.55)`；浅色不变 | `bg-neutral/32` ⇒ 深色**提亮** | 缺 |
| 2 | ① | B10 | `.modal-box` / 实现 `[data-create-task-panel]`（缺） | 深色 `border-top-color: rgb(49,59,65)` | `border-(--brand-border)` ⇒ `#1f262a` | 缺 |
| 3 | ① | B10 | 同上 | 深色 `box-shadow` 含 `rgba(0,0,0,0.6)` | `--shadow-pop` 深色无覆写 | 缺 |
| 4 | ① | B10 | 同上 | 深色 `background-color: rgb(22,27,30)` | 同值 | **一致** |
| 5 | ① | B09 | `[data-detail-overlay]` | 深色 `rgba(0,0,0,0.55)` | `bg-neutral opacity-32` ⇒ 提亮 | 口径 |
| 6 | ② | B08 | `.td-list-head` | `display: grid` | `display: flex` | 缺 |
| 7 | ② | B08 | `.td-list-head` ↔ `[data-list-rows] .td-list-row` | `grid-template-columns` 两侧**字符串相等** | 列头无该声明 | 缺 |
| 8 | ② | B08 | 同上 | `gap` / `padding-left` 与行相等 | 列头 `gap: normal` | 缺 |
| 9 | ② | B08 | `.td-list-head > :nth-child(1)` | `list.columns.identifier` = `ID` | 同 key、同值 | **一致** |
| 10 | ② | B08 | `.td-list-head > :nth-child(2)` | `list.columns.title` = `Title` / `标题` | 无此 key、无此 label | 缺 |
| 11 | ② | B08 | `.td-list-head > :nth-child(3)` | `list.columns.status` + `td-hide-sm` | 无 | 缺 |
| 12 | ② | B08 | `.td-list-head > :nth-child(4)` | `list.columns.assignee` + `td-hide-sm` | 无 | 缺 |
| 13 | ② | B08 | `.td-list-head > :nth-child(5)` | `list.columns.priority` + `td-hide-sm` | 无 | 缺 |
| 14 | ② | B08 | `.td-list-head > :nth-child(6)` | `list.columns.revision` = `Revision` / `版本` | 无 | 缺 |
| 15 | ② | B08 | `[data-list-identifier]` 行 cell | 第 1 轨、可见 | 同序、同钩子 | **一致** |
| 16 | ② | B08 | `[data-list-title]` 行 cell | 第 2 轨、可见、`justify-self: stretch` | 同 | **一致** |
| 17 | ② | B08 | `[data-list-status]` 行 cell | 第 3 轨、`td-hide-sm` | 同 | **一致** |
| 18 | ② | B08 | `[data-list-assignee]` 行 cell | 第 4 轨、`td-hide-sm` | 同 | **一致** |
| 19 | ② | B08 | `[data-list-priority]` 行 cell | 第 5 轨、`td-hide-sm` | 同 | **一致** |
| 20 | ② | B08 | `[data-list-revision]` 行 cell | 第 6 轨、可见 | 同 | **一致** |
| 21 | ② | B08 | ≤759 的 `.td-list-head` | 与行**同** 3 轨、同隐藏 3 列 | 窄屏无任何列头规则 | 缺 |
| 22 | ② | B13 | `[data-skeleton] .td-list-head > :only-child` | 单 span 保留 + `grid-column: 1 / -1` | 单 span（无 grid 上下文） | 口径 |
| 23 | ③ | B08 | `[data-list-identifier]` | `rule(title)`、`title` = 全 ID、`.td-id` | 全 ID、无 `title` | 缺失口径 |
| 24 | ③ | B07 | `[data-card-identifier]` | 同上 | 全 ID、无 `title` | 缺失口径 |
| 25 | ③ | B09 | `[data-detail-identifier]` | 同上 | 全 ID、无 `title` | 缺失口径 |
| 26 | ③ | B08 | `[data-list-row][data-identifier]` | 全 ID | 全 ID | **一致** |
| 27 | ③ | B07 | `[data-card][data-identifier]` | 全 ID | 全 ID | **一致** |
| 28 | ③ | B09 | `[data-detail-drawer][data-identifier]` | 全 ID（**原型本轮补齐**） | 实现侧未装配该属性 | 缺 |
| 29 | ③ | — | `.td-id` | 单行兜底类存在 | 无 | 缺 |
| 30 | ③ | B24/B25 | `.td-combo-id` | **不在本轮范围** | 不截断 | **一致（有意）** |

### 4.2 匹配项（本轮三项命中的既有块，逐个列明）

| 命中的块 | 命中处 | 本轮对它做什么 | 不做 |
|---|---|---|---|
| **B07 · Card** | 卡片的 `[data-card-identifier]` | 加 `.td-id` + `title` + 切片 | 不动卡片的任何其它 part / state / 一致性项 |
| **B08 · List view** | `.td-list-head`（列头）与 `[data-list-rows]` 的行 | 列头 6 列 + 与行同轨；行 ID 切片 | 不动行的 6 个 cell 结构、不动 `template[data-list-row-template]` 的钩子集 |
| **B09 · Task detail drawer** | 抽屉头的 `[data-detail-identifier]` | 加 `.td-id` + `title` + 切片；抽屉根补 `data-identifier` | 不动 R7 ④ 的关闭按钮、不动属性区 / 主体区 |
| **B10 · Create-task modal** | `[data-create-task]` 与 `.modal-box` | 深色遮罩 / 边 / 影三层 | 不动 R3/R4 的两栏结构、字段、尺寸 |
| **B13 · Loading state** | `[data-skeleton] .td-list-head` | 只加一条「跨满模板」规则 | 不动 3 条 shimmer 行、不改加载文案 key |
| **B19 · Access panel**（旁及） | `[data-access-overlay]` | 只记录「遮罩 token 应统一」 | 本轮不改（见 §9 未覆盖项） |
| **B11 · Create-project modal**（旁及） | 与 B10 共用 `.modal-box` | 深色边 / 影**自动**同口径 | 不额外改动 |

### 4.3 负向注记清单

| # | 注记 |
|---|---|
| 1 | 本轮**不**改任何 `web/**` 与 `test/**`（无实现代码）。 |
| 2 | 本轮**不**引入新块；只新增 `.td-id`（一次）与实现侧 `[data-create-task-panel]`（一次）。 |
| 3 | 本轮**不**改浅色的任何视觉（三处浅色回归门见 §2.1 / §7 B1–B3）。 |
| 4 | 本轮**不**改 `.td-chip` 的类名碰撞问题（那是独立的设计编辑，不得夹带）。 |
| 5 | 本轮**不**动组合框 / toast / 骨架行 / 关联链接里的 ID。 |
| 6 | 实现侧浅色遮罩与原型浅色遮罩**本就不等**（实现 `bg-neutral/32` = `rgba(31,42,46,0.32)`；原型 `rgba(15,20,23,0.32)`）—— 这是**改动前既有**的差异，本轮不处理（见 §7 C4）。 |

---

## 5. 本轮的两处「读回」修正（原型侧，记入契约以免下游踩坑）

ID 的 DOM 文本自本轮起是**截断值**，因此凡是**从该文本反查实体**的代码都必须改读属性。原型侧实测有这一处，已随本轮修掉：

| # | 位点 | 改动 | 为什么必须改 |
|---|---|---|---|
| 1 | 抽屉评论提交处理器（原型 `design/prototype/app.js`：读 `[data-detail-identifier]` 的 `textContent` 反查卡片） | 改读 `[data-detail-drawer]` 的 `data-identifier`；并由抽屉渲染处写入该属性 | 截断后 `text` 是 `TD-128` 或 `PROJ-000…`，用它做 `[data-card][data-identifier="…"]` 的键会**找不到卡**（9 字符样本必挂） |
| 2 | 原型 `[data-detail-drawer]` 根 | 新增 `data-identifier`（改动前实测 `null`） | 上一条的全值来源 |

**实现侧无需同类迁移**：实读确认 `web/**` 里三个 ID 钩子**只被写入、从未被读回**，实体定位一律走 `[data-identifier]` 属性（§2.3 偏离表 #6）。此条作为**回归约束**保留：实现卡不得引入「读 ID 文本反查实体」的新代码。

---

## 6. 截图口径

**§⑨.1 基线**：视口 `1512 / 1240 / 980 / 760 / 430` × `light / dark`，**同视口 · 同主题 · 同语言（en）**，原型侧基线，落 `workspace/T-20261012-211516/shots/`（**不进仓**）。

| 画面 | 命名 | 每档必须可见 |
|---|---|---|
| 列表视图 | `r8-list-<width>-<mode>.png` | ① **6 列列头**（ID · Title · Status · Assignee · Priority · Revision）与数据行**逐列对齐**；② ≥760 档 6 列全可见、≤430 档只 ID/Title/Revision 三列；③ `PROJ-000…` 的 **9 字符样本截断可见**（悬浮读出全 ID `PROJ-0007`） |
| 创建任务弹窗打开态 | `r8-modal-<width>-<mode>.png` | 深色档：**面板与遮罩 / 画布三层可分辨**（边可辨、影可见、遮罩压暗）；浅色档：与改动前**逐帧无差别**（回归） |

**硬门**：每帧 `scrollWidth <= clientWidth + 1`（无页面级横向溢出）；`html[data-theme]` 确为期望态；`console` / `pageerror` 均为 0。主题一律由原型自身的 `[data-theme-switch]` 三态循环驱动（截图即验证该控件）。

**shots.json** 逐帧记录：`state` / `width` / `mode` / `applied` / `themeOk` / `overflowOk` / `headerCells` / `headerVisibleCells` / `modalOpen` / `sampleId`（`text` + `title`）。

---

## 7. 机检断言清单（供实现卡「During」直接落测）

**禁行号锚**；每条只写「selector → 断言 → 期望」。A 类可落在 `test/web/blocks.contract.mjs` 的既有 rule kinds（`count` / `classes` / `text` / `order` / `absent` / `domain`）；B 类可落在 `web/scripts/dom-smoke.mjs`（`computed` / `text` / 几何 probe）。**本轮不改 `test/**`**，此表是给实现卡与验证卡的待办。

### A. 结构类（`blocks.contract`）

| # | selector | 断言 | 期望 |
|---|---|---|---|
| A1 | `.td-list-group:not([data-skeleton]) .td-list-head > *` | count | `6` |
| A2 | 同上 | order（`data-i18n`） | `list.columns.identifier` · `.title` · `.status` · `.assignee` · `.priority` · `.revision`（**恰此顺序**） |
| A3 | `.td-list-group:not([data-skeleton]) .td-list-head > *:nth-child(3\|4\|5)` | classes | 各含 `td-hide-sm` |
| A4 | `.td-list-group:not([data-skeleton]) .td-list-head > *:nth-child(1\|2\|6)` | classes | **不含** `td-hide-sm` |
| A5 | `[data-skeleton] .td-list-head > *` | count | `1` |
| A6 | `[data-list-rows] .td-list-row > *` | count | `6`；order = `[data-list-identifier]` · `[data-list-title]` · `[data-list-status]` · `[data-list-assignee]` · `[data-list-priority]` · `[data-list-revision]` |
| A7 | `[data-list-identifier]` | classes | 含 `td-id` |
| A8 | `[data-card-identifier]` | classes | 含 `td-id` |
| A9 | `[data-detail-identifier]` | classes | 含 `td-id` |
| A10 | `[data-card-identifier][title]` | count | `=== count [data-card-identifier]`（**每个**卡片 ID 都有 `title`） |
| A11 | `[data-detail-identifier][title]` | count | `1` |
| A12 | `[data-list-identifier][title]` | count | `=== count [data-list-rows] .td-list-row`（**每行**都有 `title`） |
| A13 | 原型：`[data-create-task] .modal-box` | count | `1`；实现：`[data-create-task-panel]` | count `1`（**必补钩子**，R8-3） |
| A14 | 原型：`[data-create-project] .modal-box` | count | `1`（同口径自动生效） |
| A15 | `web/src/i18n/catalogue.mjs` 的 `list.columns.*` | 存在性 | `identifier` · `title` · `status` · `assignee` · `priority` · `revision` 六者 en/zh 皆在 |

### B. 计算样式 / 几何类（`dom-smoke`）

| # | selector | 断言 | 期望 |
|---|---|---|---|
| B1 | `[data-create-task]`（dark） | `background-color` | `rgba(0, 0, 0, 0.55)` |
| B2 | `[data-create-task]`（light） | `background-color` | 与本轮改动前**逐字相同**（回归门） |
| B3 | `[data-create-task] .modal-box`（dark） | `border-top-color` | `rgb(49, 59, 65)` |
| B4 | `[data-create-task] .modal-box`（light） | `border-top-color` | `= --color-td-line` 浅色值（未被 `-strong` 命中） |
| B5 | `[data-create-task] .modal-box`（dark） | `box-shadow` | 含 `rgba(0, 0, 0, 0.6)` |
| B6 | `[data-create-task] .modal-box`（light） | `box-shadow` | **不含** `rgba(0, 0, 0, 0.6)` |
| B7 | `[data-create-task] .modal-box`（dark） | `background-color` | `rgb(22, 27, 30)`（面不改） |
| B8 | `[data-detail-overlay]`（dark） | `background-color` | `rgba(0, 0, 0, 0.55)`（同 token；实现侧为建议项） |
| B9 | `.td-list-group:not([data-skeleton]) .td-list-head`（≥760） | `display` | `grid` |
| B10 | `.td-list-head` ↔ `[data-list-rows] .td-list-row`（1512 / 760 / 430） | `grid-template-columns` | 两侧**字符串相等**（**不**写字面 `minmax`，见 R8-1） |
| B11 | 同上 | `gap` / `padding-left` | 两侧相等 |
| B12 | `.td-list-head > *` | `display !== none` 的计数 | 1512 / 760 → `6`；430 → `3` |
| B13 | `.td-list-head > *` | `justify-self` | 全 `start` |
| B14 | `[data-skeleton] .td-list-head > :only-child` | `grid-column` | `1 / -1` |
| B15 | `[data-list-identifier]` / `[data-card-identifier]` / `[data-detail-identifier]` | `white-space` | `nowrap` |
| B16 | 同上 | `title` | `=== ` 该条目的**全 ID** |
| B17 | 同上 | `textContent` | `=== title.length > 8 ? title.slice(0,8) + "…" : title` |
| B18 | 同上 | `textContent.length` | `<= 9` |
| B19 | `[data-card-identifier]`（9 字符样本） | `textContent` | `PROJ-000…`（8 字符 + `…`）；`title` = `PROJ-0007` |
| B20 | 任一 6 字符 ID（如 `TD-128`） | `textContent` | `=== title`（**不截断**） |
| B21 | `[data-list-row]` | `data-identifier` | 全 ID（≠ `textContent`，当它被截断时） |
| B22 | `[data-detail-drawer]` | `data-identifier` | `=== ` 抽屉 ID 的全值 |
| B23 | `[data-card]` | `data-identifier` | 全 ID |
| B24 | 页面（5 档） | `scrollWidth <= clientWidth + 1` | 全 `true` |

### C. 「不得断言」的负向注记

| # | 不得断言 | 原因 |
|---|---|---|
| C1 | `.td-list-head` 的 `grid-template-columns` **字面**等于 `74px minmax(0, 1fr) …` | computed 会把 `minmax(0,1fr)` 解成像素（实测 `74px 96px 108px 132px 96px 72px`）。只断**两侧字符串相等**（R8-1） |
| C2 | 用 `.td-id` 的 `max-width: 9ch` 证明「至多 8 字符」 | `ch` 是宽度单位、随字体与 `letter-spacing` 漂移；「8 字符」只由 `textContent` 断言（R8-2） |
| C3 | `title` 出现在 CSS 层，或 `title` 的字面值出现在样式表 | `title` 是 DOM 属性，不是样式 |
| C4 | 浅色遮罩等于原型的 `rgba(15, 20, 23, 0.32)` | 实现浅色现值是 `bg-neutral/32`（`rgba(31,42,46,0.32)`）；本轮**不**改浅色（§4.3 注记 6）。实现侧只断「浅色与本轮前**逐字相同**」 |
| C5 | `.td-list-head > *` 的 `grid-template-columns` 单独存在于列头 | 共享模板是同一条规则；拆成两条即违反「同源」的机制 |

---

## 8. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/DESIGN.md` | **新增 §24「Review round R8 — the list's header, the dark dialog, the identifier's cap」**：记 ① 深色浮层分离三层口径（`--scrim` / 面板 border `-strong` / `--shadow-pop` 深色覆写，浅色不变）；② 列头 6 列且与行同轨（含 ≤759 分档与加载态跨满）；③ ID 上限「8 字符 + …」+ 渲染层切片 + `title` 全 ID；并改写受影响的「当前态」句（§2.1 遮罩 / §4 列表组 / §7 Themes / §13 i18n キー数） | 已改 |
| `design/BLOCKS.md` | **B08**：列头 6 列、与行同 6 轨 grid、≤759 隐藏中间 3 列、加载态头跨满；**B07/B09**：三处 ID 渲染点的截断口径与 `title`；**B10**：深色遮罩 / 边 / 影三层口径；**i18n hooks**：`list.columns.*` 五个新 key 与「215 → 220」计数 | 已改 |
| `design/prototype/README.md` | **规格清单外的增项**（与 R7 / R7rev 同理：该文件描述的就是被改的原型）：列表段记 6 列列头与 ID 上限；Coverage 表的语言行 key 数 `215 → 220` | 已改 |
| `design/fidelity-r7.md` | **不改**：本轮与 R7 正交（§3），R7 契约仍然成立 | 不改（有意） |
| `test/**` / `web/**` | **不改**（卡的红线：无实现代码） | 不改（红线） |

---

## 9. 口径红线与未覆盖项

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | 三处 ID 的**显示值**只能由「8 字符 + `…`」规则产生；不得为个别样本特判。 |
| R2 | 列头与行必须**共用同一份**列模板声明；把轨宽写两遍即违反本契约的机制（即便当下数值相等）。 |
| R3 | 浅色遮罩 / 面板边 / 面板影**不得**随本轮的深色覆写而改变。 |
| R4 | `title` 与 DOM 文本必须出自**同一**全 ID 变量；不得让两者各自计算（会成为下一处漂移）。 |
| R5 | 实体定位一律走 `data-identifier` **属性**；不得新写「读 ID 文本反查实体」的代码（§5）。 |

**未覆盖项（明确不在本轮，留给后续裁定）**

| # | 项 | 说明 |
|---|---|---|
| F1 | `[data-access-overlay]`（`bg-neutral/40`）与 `[data-detail-overlay]`（`bg-neutral opacity-32`）的 alpha 不统一 | 原型侧三面共用一个 `--scrim`；实现侧三个 alpha。本轮只把弹窗遮罩列为**硬性**，其余为**一致项建议**（§2.1 落地建议 2）。统一它们的浅色外观会改动未被 Terry 反馈的面 ⇒ 留给后续卡。 |
| F2 | 实现侧卡片 ID 用工具类（`td-mono text-[11px]`）而**不带** `.td-card-id` | 原型用 `.td-card-id`。这是一个**改动前既有**的类名差异，且不影响本轮断言（`.td-id` 独立成立）⇒ 不在本轮 |
| F3 | 「8 字符」对**中英混排 / 不同字体**的稳定性 | 本轮只保证 CJK 无关的 ASCII ID（真实 ID 皆为 `PREFIX-数字`）。若未来出现非 ASCII 前缀，需重新裁定（`slice` 按 UTF-16 码元计数）。 |
| F4 | 组合框（`.td-combo-id`）与 toast 里的 ID | 不截断（§2.3 机制表「不做」）；若 Terry 后续反馈菜单里也需要上限，另开卡。 |
| F5 | `design/prototype/src/input.css` 的 `.td-chip` 类名碰撞 | 独立的设计编辑，**不得**夹带进 R8 增量（§4.3 注记 4）。 |
