# UI 保真契约 · R15 — 筛选控件统一 daisyUI `dropdown` 面板 · Clear 替代 Reset · Waiting head 加描述

> 卡：`T-20261013-165112-2`（父史诗 `T-20261013-165112`）· 日期 2026-10-13 · 来源 Terry（2026-10-13）。
> **口径 = Elon 裁定的「口径 B」（卡片 `## Comments` 2026-10-13 08:59:38Z · `kind=decision`）**：所有 filter 控件统一改用 daisyUI `dropdown` 面板组件，**放弃 `<select>`**，影响面含 board/list 的 assignee/priority；清空按钮统一 **Clear**；Waiting on me 补描述；须同步 `DESIGN.md §18.2` 组件映射表。
> 范围：`design/prototype/{index.html,src/input.css,app.js}` + `design/BLOCKS.md` §B04/§B26/§B27 + `design/DESIGN.md §18.2` + 本文件。**零实现**：`web/**`、`test/**`、`src/**`、`server/**` 一行不动。
> 事实源：`design/prototype/index.html` + `src/input.css`（`tw.css` 为其构建产物）+ `app.js` + `design/BLOCKS.md`。**原型页在真实浏览器里的实测值是唯一事实源**，`.css` 里某条声明的字面值不是。
> 证据口径：所有实测值由 `workspace/T-20261013-165112-2/evidence/r15.mjs` 在 Chromium headless（Playwright，Chromium **153.0.8010.12**）里真跑所得；原始记录 `r15-measure.json`（20 轮 × 两侧逐块 computed/几何/DOM）、`verify-r15.json`（73 条断言 × 两侧的逐条 pass/fail + actual），截图 `shots/{before,after}-{board,activity,waiting}-{1512,1240,980,760,430}-{en,zh}.png`。**未跑的一律标注**。
> 基线 commit：**`6888821`**（本 lane 的开工点；本卡第一版契约已提交为 `af43e0a`，口径 B 的改动叠在其上）。同族前序：**R9**（触发器外壳）、**R11 ①**（status 下拉）、**R13**（assignee 域名册）、**R14**（B09 抽屉逐块对账）。

## 0. 结论摘要

- **四条都落地，且都带「before 红 / after 绿」的双侧实测**：断言 73 条，**after 73/73 通过**，**before 32/73**（41 条红）——**31 个断言 id 由红转绿**，即本轮的全部差异（`A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14 A15 A17 B2 B5 C1 C2 C4 C5 C6 C8 C9 C11 C13 C14 C15 C16 A19 A20`）。
- **① board/list 与 Activity 的七个筛选控件现在是一种控件**：两处筛选条各是一个具名 `section.td-filters`，其七个字段控件全是 **`<details class="dropdown" data-dismiss-on-outside>`**，触发器是 **`summary.btn.btn-sm.td-label-trigger`**（`role="button"` / `aria-haspopup="menu"` / 带 `aria-label`），菜单是 **`ul.dropdown-content.menu.td-label-menu`**。`[data-filters] select` 与 `[data-activity-filters] select` 均为 **0**（before：2 / 3）。
- **② 七个触发器逐属性同壳**：`height/min-height: 30px`、`padding: 0 26px 0 8px`、`font-size: 12px`、`font-weight: 400`、`border-radius: 6px`、`border-top-color: rgb(230,232,235)`、背景 `rgb(255,255,255)`、`cursor: pointer` —— **七者 computed 完全相同**（before：五个原生 `<select>` 没有触发器，B2 红）。且每个触发器**盒宽等于它替换掉的那个 `<select>`**（`assignee 108.5`、`priority 97.77`、`actor 78.09`、`event 90.92`、`task 83.36`），即换组件**不动版**。
- **③ 清空按钮统一为 B04 的 Clear**：Activity 的 `[data-activity-filter-reset]` / `activity.filter.reset` / `Reset` **退场**，改挂 `[data-filter-clear]` / `filters.clear` / `Clear`（盒 `56.44×28`，与 board 的 Clear **逐值相同**）；两条 Clear 靠**按下的那条条**分流。
- **④ Waiting head 补描述**：头部 `21.59 → 41.59`（= Activity 头部），描述 `12px` / `rgb(126,138,145)` / `margin-top:2px`（= `td-activity-sub`），新增键 `waiting.subtitle`（en/zh）。
- **⑤ 文档同步**：`DESIGN.md §18.2` 的 `assignee / priority filters` 行由 `select select-sm` 改为 `dropdown` + `menu`，并补 status / activity filters / filter clear 三行；`BLOCKS.md` §B04/§B26/§B27 与文首计数随改（见 §7）。
- **i18n 增量口径 = 净零键**：删 `activity.filter.reset`（en `"Reset"` / zh `"重置"`）、加 `waiting.subtitle`（en `"Everything waiting on your answer, oldest first."` / zh `"所有等你答复的事项，最久的排在最前。"`）⇒ **en/zh 各 280 键不变、逐键同序不变**。本轮**不新增任何键**：三个新控件复用已有的 `filters.*` / `activity.filter.*` 行文案，行钩子的取值（`data-activity-value`）是**值**不是键。`index.html` 的 `data-i18n*` 席位 `623 → 625`（`521 data-i18n` + `104` 变体）。
- **原型改后仍「可见 + 可交互」**：20 轮（`{en,zh} × {1512,1240,980,760,430}`）`console.error = 0`、`pageerror = 0`、横向溢出 **0/20**；**JS-off 两轮**（1512/430）证明七处控件、菜单、Clear 与描述**都不依赖脚本**（面板静止时全关）。
- **换组件在静止态几乎不动像素**：board 视图 before/after 像素差 `296 px`（1512-en，0.021%）、`72 px`（430-en，0.018%），同侧同档重跑的噪声基线 **100 px** ⇒ 与版式噪声同量级。Activity 条 `7 509 px`（0.52%）、Waiting 头 `95 417 px`（6.6%）——后两者是本轮真正动过的面。

---

## 1. 口径与证据规则

**闭集口径（逐字使用，不得自创词）**：`对齐` = 两侧实测同值；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差说明）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本页不出现任何「文件 + 数字行号」形式的引用）。**断言只用 `data-*` 钩子 + 属性 + 计算样式**；class 名只用于描述样式与等价关系，不作契约锚。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / `getBoundingClientRect` / `scrollWidth`·`clientWidth` / DOM 计数 / 真实指针与键盘），**不是** CSS 文件里的声明字面值。
2. 载体 = 内置静态 HTTP 服务服务对应目录，URL `http://127.0.0.1:<随机端口>/index.html`（**不是 `file://`**）。
3. 矩阵 = 宽度 `1512 / 1240 / 980 / 760 / 430` × 主题 `light` × 语言 `en` + `zh` 必测；每档断言 `scrollWidth == clientWidth`（§5 B7）。
4. **下拉的开合与选择用真实指针**：`page.click` 打在 `summary` 与 `menuitem` 的 `button` 上，不是合成事件，也不是 `page.selectOption`。
5. **JS-off** = 同一份静态文档在 `javaScriptEnabled:false` 下加载（§5 A19），验证静态 markup 自身完备：七个控件在位、面板全关、无 `<select>`。
6. **实现侧本轮为「实读」，未实测**：未构建 `web/dist`（`web/node_modules` 为空、离线缓存为 linux/arm64），未起 dev server。§4 的「实现现状」列没有一个是实测值。
7. **不得伪造**：任何未验证项在正文里明写「未验证 / 实读未实测」。本页所有原型数字均可在 `verify-r15.json` / `r15-measure.json` 里逐条比对。
8. **两侧同源**：`before` = `/tmp/r15tw/before`（`HEAD` 的 `index.html` / `app.js` / `tw.css`），`after` = 工作区 `design/prototype`；同一 harness、同一浏览器、同一 viewport 轮次，**差值即本轮的改动**。

---

## 2. 交互契约

只写「原型如此 + 实现应为」。所有选择器以原型为准（§5 的 A/C 腿逐条实测）。

### 2.1 一种控件：daisyUI `dropdown` 面板（口径 B）

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 控件 | `<details class="dropdown" data-dismiss-on-outside>`；board 四个（`[data-filter-assignee]` · `[data-filter-priority]` · `[data-filter-status]` · `[data-filter-label]`）、activity 三个（`[data-activity-filter="actor"\|"event"\|"task"]`）（A5 实测 `4 / 3`；before `2 / 2` 与 `0 / 3`） | 同 |
| 原生 `<select>` | **两个筛选条里一个都不剩**（A4 实测 `0 / 0`；before `2 / 3`） | 同 |
| 触发器 | `summary.btn.btn-sm.td-label-trigger`，带 `role="button"`、`aria-haspopup="menu"`、`aria-label`（`data-i18n-aria-label` 座位）；A7 实测七者全中 | 同 |
| 菜单 | `ul.dropdown-content.menu.td-label-menu`，行是 `<li><button type="button" …>`（A8 实测七者全有） | 同 |
| 光散 | 七个控件都带 `data-dismiss-on-outside`（A6 实测 `7/7`）—— 与 B02 的项目切换器同一成员资格 | 同 |
| 值载体 | 控件上的 `-value` 属性：`data-filter-assignee-value` / `data-filter-priority-value` / `data-filter-status-value` / `data-filter-label-value` / `data-activity-filter-value`；静止值 `"all"`（A11 实测七者各恰一条、全为 `"all"`） | 同 |
| 触发器的值 | 触发器里的 `-text` / `-summary` 座位以**纯文本**陈述所选行（A7/B2）；**不带 `data-i18n`**（脚本拥有它，与 board 的 label/status 触发器同规矩） | 同 |
| 选择 | 真实点行 ⇒ 写值属性、关自己的菜单、重述触发器、重跑筛选（C2/C4/C9 实测） | 同 |
| 行数域 | `assignee:4 · priority:6 · status:8 · label:17`（A12 实测，与 before 同）；`actor:3 · event:4 · task:10`（A13 实测，与 before 同） | 同 |
| 顺序 | board `Assignee · Priority · Status · Label · Clear · count`；activity `Actor · Event · Task · Clear · count`（A9/A10 实测，元素种类由 `select` 变 `details`，序不变） | 同 |

**为什么是「同一个组件」而不是「长得像」**：`dropdown` + `menu` 是 daisyUI 的组件形状本身——`<details>` 承担开合、`<summary>` 承担触发器与无障碍名、`dropdown-content` 承担浮层、`menu` 承担行——七个控件用的是同一组 daisyUI 类、同一套 `.td-label-trigger` / `.td-label-menu` 令牌覆盖。`DESIGN.md §18.2` 的映射表因此从「两个 `select` + 两个 `dropdown`」收敛成「四个 `dropdown`」（+ Activity 三个），`select select-sm` 只留在创建弹窗的三个字段上。

**状态语义不对称是故意的**：status 是**多选**（`aria-pressed` 陈述一个集合，组合 OR），其余六个是**单选**（`aria-current` 陈述唯一所选，与 label 控件同）。

### 2.2 board/list 的 assignee 与 priority（本轮由 `select` 改为 `dropdown`）

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| assignee 值 | `data-filter-assignee-value` ∈ `all` · `me` · `human` · `agent`，或 R13 的**给定名字** | 同 |
| assignee 行 | `[data-assignee-filter-option]` × 4 静态（钩子**值**即该行的值：`all`/`me`/`human`/`agent`），外加**至多一个**给定名字行（R13 `renderAssigneeFilter()` 生成、离开即移除）；所选行 `aria-current="true"`（C2/C5/C6 实测：4 行 → 加名 5 行 → 回到 `all` 4 行） | 同 |
| assignee 触发器文案 | 所选行**自己的文案**（静态行的 `filters.assignee.*`，给定名字行就是那个名字本身 —— R13 的口径）；C2 实测 `Assignee: Agent`、C5 实测 `jobs` | 同 |
| priority 值/行 | `data-filter-priority-value` ∈ `all` · `urgent` · `high` · `medium` · `low` · `none`；行 `[data-filter-priority-option]` + `data-priority-value`，并带 `data-priority`（**色点自己的绑定**，与卡片/图例同一个 `--status-color` 规则）+ `.status.td-status-dot`；所选行 `aria-current`（C4 实测 `Priority: Urgent`） | 同 |
| R13 名册按下 | 仍是**同一个单一写入器**：名册按下 = `writeAssigneeFilter(<name>)`，与"在面板里选那个名字"是同一次移动（C5 实测：值 `jobs`、5 行、名册胶囊 `data-assignee-active="true"`） | 同 |
| 移除给定名字 | **控件自己的 `Assignee: All` 行，别无他途**（R13 修订 · 决定甲；C6 实测回到 4 行、胶囊清空）；R13 seg2 的 `[data-assignee-clear]` 仍然**不存在** | 同 |

### 2.3 Activity 的三个筛选（本轮由 `select` 改为 `dropdown`）

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 三条控件 | `[data-activity-filter="actor"\|"event"\|"task"]`，各是 `<details class="dropdown" data-dismiss-on-outside>`；静止值 `data-activity-filter-value="all"`（A5/A11 实测） | 同 |
| 行 | `[data-activity-filter-option]` + `data-activity-value`；所选行 `aria-current="true"`（A13/C9 实测） | 同 |
| 触发器 | `[data-activity-filter-summary]`（`summary`）→ `[data-activity-filter-text]` 陈述所选行**自己的文案**；C9 实测选 `agent` 后触发器读 `Agents` | 同 |
| 选择 | 真实点行 ⇒ 写值、关菜单、重述、重跑（C9 实测 15 → 11 条、`aria-current` 跟随） | 同 |
| URL | 选择仍写 `#/activity?actor=agent`，清空回 `#/activity`（C10/C11 实测，与 before 同） | 同 |
| 拖尾 | `[data-activity-filter-count]`（`aria-live="polite"`）仍在位（A16 实测两侧皆 `polite`） | 同 |
| 空态 | `[data-activity-empty-reset]`（B26.5 筛空空态内嵌）**原钩子原键**、**不带** `[data-filter-clear]`（A19 实测 `clear=false`） | 同；它不是条上的控件 |

### 2.4 清空控件统一为 B04 的 Clear

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 钩子与键 | 两条条尾都是 `[data-filter-clear]` + `data-i18n="filters.clear"`（A14 实测两侧皆中；A15 实测 activity 侧 `[data-activity-filter-reset]` 已 `0`） | 同 |
| 词面与盒 | `Clear` / `清除`，`btn btn-ghost btn-sm`，盒 `56.44×28` —— 两条条上**逐值相同**（B3 实测） | 同 |
| 分流 | 同一个文档级 `[data-filter-clear]` 处理器**按按下的那条条**分流：在 `[data-activity-filters]` 内 ⇒ 重置 activity 三档；在 `[data-filters]` 内 ⇒ 走原 `resetFilters()` | 同（Vue 侧两个组件各自绑定，不冲突） |
| 行为 | 三档回 `all`、计数回未过滤总数、board 的两档过滤**原样不动**（C11/C12 实测）；board 的 Clear 仍重置 board 四件（C7 实测） | 同；C3/C7/C10/C11 在**两侧都通过**——本轮改的是**钩子与词**，不是**行为** |
| board 侧 | `resetFilters()` 现在写四个**值属性**（`writeAssigneeFilter("all")` / `writePriorityFilter("all")` / label / status）并关掉四个菜单 | 同 |

### 2.5 Waiting head = 标题 + 描述

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 结构 | `[data-waiting-head]` 的子元素为 `div.td-waiting-head-text` + `span.td-waiting-count`（after 实测） | 同 |
| 描述 | `<p class="td-waiting-sub" data-i18n="waiting.subtitle">`，tag `p`，与 B26 描述的 tag **相同**（A17 实测） | 同 |
| 座位 | **只挂 `data-i18n`**，无 `data-waiting-*`（A17 实测 `0`）—— 与 B26.1「header 自己的标题与副标题只挂 `data-i18n`」同规则 ⇒ 该视图的辅助钩子集仍 14 个名字 | 同 |
| 头部高度 | `1216×41.59`，**与 Activity 头部逐值相同** | 同 |
| 描述盒 | `12px` / `rgb(126,138,145)` / `margin-top:2px`，与 `td-activity-sub` **逐值相同**（B5 实测） | 同 |
| 计数 | `[data-waiting-count]` 原位、原词 | 同 |
| 家族名 | 只在本视图自己的名字下声明（`.td-waiting-head-text` / `.td-waiting-sub`），不让两个头部互相牵动 | 同 |

### 2.6 未变（本轮**不得**触碰的交互）

- 四个控件各自的**域与语义**（`all/me/human/agent`；六个优先级；七个状态每个默认档「all」与「all」档；16 个标签）。
- 状态控件的 **OR/AND** 语义与 `Status: <first> +n` 的读法（R11 ①）。
- **R13** 的单一写入器、名册按下、`[data-assignee-clear]` 的缺席。
- B26 的 feed / 未读分界 / 崩溃折叠 / `Load older` / 行开卡 / `j`·`k`；B27 的队列语义与 oldest-first。
- `[data-activity-empty-reset]`：原钩子、原键、原行为。
- **`design/activity/**`**：设计源页及其 `check-activity.mjs` **本卡未动**（§7 记为必须同步项，§8 U2）。

---

## 3. 视觉规格（数值即结论）

令牌守恒声明：**本轮不新增、不改名任何设计令牌**，不新增任何色值字面量。以下数值全部来自原型实测（1512×950，light，en；除注明外）。

| 量 | before 实测 | after 实测 |
|---|---|---|
| 筛选条外壳（两条同值） | `flex / center / wrap / 8px / 0px / visible` | 同 |
| board 条的字段控件 | 2 × `select` + 2 × `details` | **4 × `details.dropdown`** |
| Activity 条的字段控件 | 3 × `select` | **3 × `details.dropdown`** |
| 七者触发器计算样式 | 五个 `<select>` **无触发器**（B2 红；只有 status/label 两个 `30px / 0 26px 0 8px / 12px 400 / 6px`） | **七者完全相同**：`height/min-height 30px`、`padding 0 26px 0 8px`、`12px`、`400`、`rgb(20,24,27)`、底 `rgb(255,255,255)`、边 `rgb(230,232,235)`、圆角 `6px`、`cursor: pointer` |
| 触发器盒宽 | `assignee 108.5 / priority 97.77 / status 93.38 / label 87.8 / actor 78.09 / event 90.92 / task 83.36`（前五者是 `<select>` 自己的盒） | **逐值不变**（换组件不动版） |
| Activity 清空控件 | `Reset`，钩子 `[data-activity-filter-reset]`，盒 `58.78×28` | **`Clear`，`[data-filter-clear]`，盒 `56.44×28`**（= board 的 Clear） |
| board 的 Clear | `Clear`，盒 `56.44×28` | 不变 |
| board 计数 | `12 tasks`，盒 `57.8×18` | 不变 |
| Activity 计数 | `15 entries`，盒 `72.25×18` | 不变 |
| Waiting 头部 | `1216×21.59`（`h1` + `span`） | **`1216×41.59`**（`div.td-waiting-head-text` + `span`），= Activity 头部 |
| Activity 头部 | `1216×41.59` | 不变 |
| Waiting 描述 | — | `p`，`12px` / `rgb(126,138,145)` / `margin-top:2px`，= `td-activity-sub` |
| 横向溢出（20 轮） | `0/20` | `0/20` |
| board 视图像素差（对照） | — | `1512-en 296 px (0.021%)`、`430-en 72 px (0.018%)`；**同侧噪声基线 100 px** |
| Activity 条 / Waiting 头像素差（对照） | — | `1512-en 7 509 px (0.52%)` / `95 417 px (6.6%)` |

> `tw.css` 是构建产物：`src/input.css` 的增量（`.td-waiting-head-text` / `.td-waiting-sub` 两条）**由同一工具链重建**，且先做过**零改动复现**——用 `HEAD` 的 `src/input.css` 重跑构建，输出与已提交的 `tw.css` **逐字节相同**，故重建后的 diff 只有新增的 8 行。**口径 B 的改动没有再动 CSS**（`dropdown` / `menu` / `.td-label-trigger` 的规则早已存在），故本轮 `tw.css` 的净增量就是那 8 行。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

> 「实现现状」全部为**实读**（§1.6），未实测。原型列全部为**实测**。

| id | 块 | 根 / 关键钩子 | 判定 | 原型实测期望 | 实现现状（文件:符号，实读） | 偏差说明 |
|---|---|---|---|---|---|---|
| R15-B01 | ① activity 控件的包装 | 三个 `[data-activity-filter]` | `自创` | 控件是筛选条的**直接子元素**（原型无包装） | `web/src/components/board/ActivityView.vue`：每个 `<select>` 外包 `<span class="td-select-caret">` + 内联 `svg.td-icon-sm`（`app.css:.td-select-caret`） | **整段作废**：口径 B 把三个控件换成 `dropdown`，包装随之删除（见 R15-B02） |
| R15-B02 | ① Activity 三控件 → `dropdown` | `[data-activity-filter="actor\|event\|task"]` | `简化` | 各是 `<details class="dropdown" data-dismiss-on-outside>` + `summary.btn.btn-sm.td-label-trigger` + `ul.dropdown-content.menu` | `ActivityView.vue`：`<select class="select select-sm td-select" data-activity-filter="actor">`，值走 `:value` + `@change` | 控件种类、值载体、行、触发器文案、钩子（+`-summary`/`-text`/`-option`/`-value`）全要改 |
| R15-B03 | ① Activity 条容器 | `[data-activity-filters]` | `口径` | `section` + `filters.label` 具名地标 | `ActivityView.vue`：`<div class="flex …" data-activity-filters>`，无 `aria-label` | 种类改 `section`；补名 |
| R15-B04 | ② board assignee → `dropdown` | `[data-filter-assignee]` | `简化` | `<details>` + `data-filter-assignee-value` + `[data-assignee-filter-option]` 行 + `[data-filter-assignee-text]` 触发器 | `web/src/components/board/FiltersBar.vue`：`<select … data-filter-assignee v-model="board.filters.assignee">`；`app.css` 注释仍写「`width: auto` … the moment the two `<select>`s become the filters bar's **direct** children」 | 控件种类与值载体要改；R13 的名册按下仍走同一个单一写入器 |
| R15-B05 | ② board priority → `dropdown` | `[data-filter-priority]` | `简化` | 同上，行 `[data-filter-priority-option]` × 6 + `data-priority` 色点 | `FiltersBar.vue`：`<select … data-filter-priority v-model="board.filters.priority">` | 同上；色点绑定复用既有 `[data-priority]` |
| R15-B06 | ③ 清空控件统一 | activity 条尾 | `口径` | `[data-filter-clear]` + `filters.clear` + `Clear` | `ActivityView.vue`：`data-activity-filter-reset` + `$t("activity.filter.reset")` + `@click="onReset"` | 钩子与键要换；`onReset` 的行为保留 |
| R15-B07 | ③ 退场项 | `[data-activity-filter-reset]` / `activity.filter.reset` | `缺` | 该条上**不存在** | 三处：`ActivityView.vue` 按钮、`test/web/blocks.contract.mjs`（B26 钩子清单 + `count == 1`）、`web/manifests/board-m2.json`（`selector: [data-activity-filter-reset]`） | 实现 + 契约测试 + ui-align 清单同时要改（§7） |
| R15-B08 | ④ Waiting head 描述 | `[data-waiting-head]` → 文本块 + 描述 | `缺` | `div.td-waiting-head-text` 内含 `[data-waiting-title]` + `p.td-waiting-sub[data-i18n="waiting.subtitle"]`；头 `41.59` | `web/src/components/board/WaitingView.vue`：头部只有 `[data-waiting-title]` 与 `[data-waiting-count]`（实读） | 两行文本块与描述双缺；计数原位 |
| R15-B09 | ④ 描述座位 | `[data-i18n="waiting.subtitle"]` | `缺失口径` | 只挂 `data-i18n`，无 `data-waiting-*` | 键不存在于 `web/src/i18n/catalogue.mjs`（实读） | 新增键，须由实现卡镜像（§7） |
| R15-B10 | ⑤ 组件映射表 | `DESIGN.md §18.2` | `口径` | 该表 `assignee / priority filters` 行 = `dropdown` + `menu`；补 status / activity filters / filter clear 三行 | 该行原文为 `select select-sm`（本卡已改本仓的 `DESIGN.md`） | 实现侧无需动作；此项是文档同步 |

### 4.2 匹配项（本轮命中但无需改动）

| 块 | 根 | 实测依据 | 备注 |
|---|---|---|---|
| status 下拉（R11 ①） | `[data-filter-status]` | A5/A12；`aria-pressed` 集合语义 | **不得**再动它的多选语义 |
| label 下拉（R3/R9 ②） | `[data-filter-label]` | A5/A12；17 行 | 本轮只把它的壳推广给另外五个 |
| board 的 Clear | `[data-filters] [data-filter-clear]` | B3/C3/C7（两侧皆通过） | 零改动，被复制到另一条上 |
| R13 的单一写入器与名册按下 | `writeAssigneeFilter()` / `[data-agent-assignee]` | C5/C6 | 名字的域与移除路径都不变 |
| B26 的 feed / 空态 / Load older | `[data-activity-feed]` 等 | C9/C10/C11 | 域与 URL 契约不变 |
| B27 的 14 个辅助钩子 | `data-waiting-*` | A17 | 集合不变 |
| `.td-select` | create dialog 的三个字段 | §3 | 规则保留；它已不在任何筛选条上 |
| `dropdown` `menu` 家族本体 | `.td-label-trigger` / `.td-label-menu` | B2/B3 | 本轮是**使用者增加**，规则零改动 |

### 4.3 负向注记清单（本轮**不得**触碰）

1. **状态控件的多选语义**：`data-filter-status-value` 的逗号集合与每行 `aria-pressed`（R11 ①）——不能因为其余六个是单选就把它降成单选。
2. **R13 的名册路径**：`[data-assignee-clear]` 仍然**不存在**（R13 修订 · 决定甲）。
3. **B22 的 `[data-assignee-option]`**：抽屉/弹窗里的名册菜单（14 个裸座位）与筛选条的 `[data-assignee-filter-option]` **不得混用**（R13 §2.9）。
4. **`[data-activity-empty-reset]`**：原钩子、原键、原行为。
5. **`design/activity/**`**：本卡未动（§8 U2）。
6. **`web/**`、`test/**`、`src/**`、`server/**`**：一行不动。
7. **令牌与色值**：不新增、不改名、不新增字面量。

---

## 5. 机检断言清单（A 结构 / B 几何·计算样式 / C 交互）

运行器：`workspace/T-20261013-165112-2/evidence/r15.mjs`（**不进仓**）。**两侧各跑一遍**：`after 73/73 通过`；`before 32/73`（41 红）；**31 个 id 由红转绿**。行数分布：A20 / B7 / C18 各在 10 个「宽度 × 语言」档各跑一次，A19 在 1512/430 两档各跑一次。

### A · 结构

| id | 选择器 | 断言式 | 期望 | before |
|---|---|---|---|---|
| A1 | 两条筛选条 | 都在 | `true/true` | 绿 |
| A2 | 条容器种类 | activity 条 == board 条 | `section == section` | **红**（`div vs section`） |
| A3 | 条的无障碍名 | 同名且非空 | `Filters == Filters` | **红**（`null`） |
| A4 | `select` 计数 | 两条皆 `0` | `0/0` | **红**（`2/3`） |
| A5 | `details.dropdown` 计数 | `4/3` | `4/3` | **红**（`2/2`、`0/3`） |
| A6 | `data-dismiss-on-outside` | 七者全有 | `7/7` | **红** |
| A7 | 触发器 | `summary.btn.td-label-trigger` + `role=button` + `aria-haspopup=menu` + `aria-label` | 七者全中 | **红**（五者无触发器） |
| A8 | 菜单 | `ul.dropdown-content.menu` | 七者全有 | **红** |
| A9 | board 条孩子序 | `assignee·priority·status·label·clear·count` | 同 | **红**（前两者 `select`） |
| A10 | activity 条孩子序 | `actor·event·task·clear·count` | 同 | **红**（前三者 `select`） |
| A11 | 值载体 | 七者各恰一条 `-value` 且 == `"all"` | 同 | **红** |
| A12 | 四个菜单行域 | `assignee:4,priority:6,status:8,label:17` | 同 | **红**（assignee/priority 记 0） |
| A13 | 三个菜单行域 | `actor:3,event:4,task:10` | 同 | **红**（皆 0） |
| A14 | 两条的 Clear | 都是 `[data-filter-clear]` + `filters.clear` | 同 | **红**（activity 侧为 `-reset`） |
| A15 | activity 退场钩子 | `[data-activity-filter-reset]` == `[data-filter-clear]` | 同 | **红** |
| A16 | 两个计数 | `aria-live="polite"` | `polite/polite` | 绿 |
| A17 | Waiting 描述 | 在位、只挂 `data-i18n`、计数在位 | 同 | **红** |
| A18 | — | 静态轮 `console.error == 0 && pageerror == 0` | `0` | 绿 |
| A19 | JS-off（×1512/430） | 七控件在位、`select == 0`、面板全关、`Clear`/`filters.clear`、`waiting.subtitle` | 全通过 | **红**（×2） |
| A20 | 三处座位（×10 档） | 每档 activity 三 `dropdown`、`select == 0`、Waiting 描述在 | `3/0/true` | **红**（×10） |

### B · 几何 / 计算样式（真浏览器 computed，1512×950 light en）

| id | 选择器 | 断言式（computed） | 期望 | before |
|---|---|---|---|---|
| B1 | 两条的 `self` | 逐属性相同 | `flex/center/wrap/8px/0px/visible` | 绿 |
| B2 | **七个触发器** | 逐属性相同 | `30px / 0 26px 0 8px / 12px 400 / 6px / rgb(20,24,27) / rgb(255,255,255) / rgb(230,232,235)` | **红**（五者无触发器） |
| B3 | 两条的 Clear | `style` 全等 | `28px / 0 12px / 12px / 6px` | **红**（before 不同的钩子但同样式；本卡取"钩子+样式"两者，见 A14/B3 同读） |
| B4 | 两条的计数 | `style` 全等 | `18px / 0px / 12px` | 绿 |
| B5 | Waiting 描述 vs Activity 描述 | `style` 全等 | `12px / rgb(126,138,145) / 2px / 18px` | **红**（before 无） |
| B6 | `documentElement` | 三视图无横向溢出 | `0/0/0` | 绿 |
| B7 | 同上（×10 档） | 无横向溢出 | `0/0` | 绿 |

### C · 交互（真实点击 / 真实菜单 / 真实语言切换）

| id | 动作 | 断言 | before | after |
|---|---|---|---|---|
| C1 | 真实点 `[data-filter-assignee] > summary` | 面板 `[open]` | **红** | 绿 |
| C2 | 再点 `[data-assignee-filter-option="agent"]` | 值 `agent`、触发器 `Assignee: Agent`、菜单关 | **红** | 绿 |
| C3 | 同上之后 | 板面变窄（可见卡数与计数句跟着变） | 绿 | 绿 |
| C4 | priority 同流程选 `urgent` | 值 `urgent`、触发器 `Priority: Urgent` | **红** | 绿 |
| C5 | 真实点名册 `jobs`（R13） | 值 `jobs`、**5 行**、触发器读 `jobs`、名册胶囊选中 | **红** | 绿 |
| C6 | 再开面板点 `Assignee: All` | 值 `all`、**回到 4 行**、胶囊清空 | **红** | 绿 |
| C7 | 真实点 board 的 Clear | 四件回 `all`、计数回 `12 tasks` | 绿 | 绿 |
| C8 | 真实点 `[data-activity-filter="actor"] > summary` | 面板 `[open]` | **红** | 绿 |
| C9 | 点 `data-activity-value="agent"` | 值 `agent`、触发器 `Agents`、`aria-current` 跟随、条目数变 | **红** | 绿 |
| C10 | 同上 | URL `#/activity?actor=agent` | 绿 | 绿 |
| C11 | 真实点该条的 Clear | 三档回 `all`、条目回 15、URL 回 `#/activity` | 绿 | 绿 |
| C12 | 先给 board 设 `priority=urgent`，再走 activity 一轮 + Clear | board 的 priority **仍是 `urgent`** | 绿 | 绿 |
| C13 | 切 zh 后 board 条 | 触发器 `负责人：全部` / `优先级：全部`、条名 `筛选` | **红** | 绿 |
| C14 | 切 zh 后 activity 条 | `任何人` / `全部事件` / `清除` / 条名 `筛选` | **红** | 绿 |
| C15 | 在 zh 下于面板里选 `delivery` | 触发器 `交付` | **红** | 绿 |
| C16 | 切 zh 后 waiting head | 中文描述 | **红** | 绿 |
| C17 | 交互轮全程 | `console.error == 0 && pageerror == 0` | 绿 | 绿 |
| C18 | ×10 档 | 同上 | 绿 | 绿 |

> C3 / C7 / C10 / C11 / C12 在**两侧都通过**：这正是本轮的要点——改的是**组件形状、钩子与词**，不是**筛选行为**。

### 5.x 不得断言（负向组）

- **不得**用 class 名当契约锚（`B1`–`B5` 用的是**两侧取值相等**，不是 class 存在性）。
- **不得**在原型上断言 `[data-activity-filter-reset]`（已退场）；也**不得**在 `design/activity/**` 上替它断言（另一份文档，见 §7）。
- **不得**用 `[data-activity-filter-text]` 的 `data-i18n` 断言触发器文案（它**故意没有**该座位，文案由脚本从"所选行自己的文本"得出）。
- **不得**断言状态控件是单选（它是 `aria-pressed` 的集合）。
- **不得**用 `[data-select]`/`.td-select` 断言筛选条上的控件（那里已经没有 `<select>`）。

---

## 6. 实测与复跑

### 6.1 两侧的构造

```text
before = /tmp/r15tw/before   # HEAD 的 index.html / app.js / tw.css，逐文件比对为 == HEAD
after  = <worktree>/design/prototype
# 两侧同 harness、同浏览器、同 viewport 轮次；差值即本轮改动。
$ node evidence/snapshot-before.mjs
snapshot index.html: == HEAD  true
snapshot app.js:     == HEAD  true
snapshot tw.css:     == HEAD  true
```

### 6.2 `tw.css` 的可复现重建

```text
$ node twbuild-check.mjs      # 用 HEAD 的 src/input.css 重跑同一工具链
committed tw.css bytes : 205036
rebuilt(HEAD) bytes    : 205036
byte-identical         : true
# 口径 B 的改动没有再动 CSS（dropdown/menu/.td-label-trigger 早已存在）⇒ tw.css 净增量 = waiting 的 8 行
```

### 6.3 复跑命令与原始输出摘要

```text
$ node evidence/r15.mjs measure
runs per side: 10/10
runs with console/page errors: before: 0  after: 0

$ node evidence/r15.mjs verify
{ "before": { "total": 73, "pass": 32, "fail": 41 },
  "after":  { "total": 73, "pass": 73, "fail":  0 } }
ids that moved: A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14 A15 A17 B2 B5
                C1 C2 C4 C5 C6 C8 C9 C11 C13 C14 C15 C16 A19 A20
after fails: (none)
```

真实摘要（全部可在 `r15-measure.json` / `verify-r15.json` 逐条比对）：

| 量 | 实测 |
|---|---|
| 轮次 | `{light} × {en,zh} × {1512,1240,980,760,430}` = 20 轮 × 两侧 |
| `console.error` / `pageerror` | `0 / 0`（两侧各 20 轮全同） |
| 横向溢出轮次 | **0 / 20** |
| 控件种类 | before `2/3` 个 `<select>` → after **0**；`dropdown` `2/2` + `0/3` → **`4/3`** |
| 七个触发器 | after 逐属性同壳 `30px / 0 26px 0 8px / 12px 400 / 6px`；盒宽与各自替换掉的 `<select>` 相同 |
| board Clear / activity Clear | `56.44×28` / `56.44×28`（逐值相同） |
| Activity 一轮 | 选 `agent` ⇒ 15 → 11 条、URL `#/activity?actor=agent`；Clear ⇒ 15 条、`#/activity` |
| R13 名册 | 点名 `jobs` ⇒ 5 行、值 `jobs`、胶囊选中；点 `Assignee: All` ⇒ 4 行 |
| zh | 触发器 `负责人：全部` / `优先级：全部` / `任何人` / `全部事件`；选 `delivery` ⇒ `交付` |
| Waiting 描述 | `21.59 → 41.59`（= Activity 头部）；`12px` / `rgb(126,138,145)` / `mt 2px` |
| JS-off | 七控件在位、面板全关、无 `<select>`、`waiting.subtitle` 在（1512 / 430 两轮） |
| 像素差（含噪声基线 100 px） | board `296 px (0.021%)`@1512-en、`72 px (0.018%)`@430-en；activity `7 509 px (0.52%)`；waiting `95 417 px (6.6%)` |

### 6.4 宿主门禁的基线（`HEAD` 本就红，本卡的净增是 **1 条**）

本卡写面只有 `design/**`，但两条宿主套件**读原型文件**，所以它们的红绿会随本轮移动。为把「本卡造成的」与「开工前就在的」分开，在 `HEAD`（`6888821`）的干净检出里跑过一遍（`git worktree add --detach` 的临时检出，已删）：

| 套件 | `HEAD` | 本卡之后 | 净增 |
|---|---|---|---|
| `test/web/i18n.catalogue.test.mjs` | **3 红**（verbatim / deep-equal / key-count） | **4 红**（+ `covers every translated hook in design/prototype/index.html`） | **+1** |
| `test/web/i18n.parity.test.mjs` | 绿 6/6 | **绿 6/6** | 0 |
| `test/web/blocks.contract.test.mjs` | **2 红**（`data-i18n*` seats / MESSAGES keys） | 同样 **2 红** | 0 |

用套件自己的口径复算的记录 vs 实测：

| 量 | `blocks.contract.mjs` 记录的 | `HEAD` 实测 | 本卡实测 |
|---|---|---|---|
| `data-i18n*` 席位总数 | `817` | **816**（`525 + 193 + 72 + 8 + 18`） | **818**（`521 + 193 + 78 + 8 + 18`） |
| `MESSAGES` en/zh 键 | `281` | **280 / 280** | **280 / 280**（净零） |

即：**那 5 条红在 `HEAD` 上已经存在**（另一个 lane 的 `design/prototype/**` 改动没有把记录带上），本卡既没有修掉它们、也没有让它们变多。唯一由本卡新增的红是 `i18n.catalogue.test.mjs` 的**钩子解析**那一条（`index.html` 多了一个 `waiting.subtitle` 未在冻结副本里），它在实现卡把键镜像进两份副本后消失（§7、§8 U3）。

### 6.5 证据目录

```text
workspace/T-20261013-165112-2/evidence/
  snapshot-before.mjs        # 从 HEAD 还原 before 快照（并自证 == HEAD）
  r15.mjs                    # measure / verify 双模式运行器（两侧同源）
  dropdown-fn.mjs            # 口径 B 的逐控件功能探针（第一版，保留原始输出）
  r15-measure.json           # 20 轮 × 两侧 × 逐块 computed/几何/DOM（原始）
  verify-r15.json            # 73 条 × 两侧的逐条 pass/fail + actual（原始）
  shots/                     # 两侧 × {board,activity,waiting} × 5 宽度 × 2 语言
```

截图证明「**原型 HTML 仍可见 + 可交互**」：`after-*.png` 是真实按下侧栏项、真实开面板、真实选择、真实切语言后的全幅；board 侧 before/after 的像素差（与噪声基线同量级）证明**换组件不动版**。

---

## 7. 文档同步判定（§⑫）

| 文档 | 是否需同步 | 说明 |
|---|---|---|
| `design/BLOCKS.md` §B04 | **已同步（本卡）** | Controls 行改为「all four are `dropdown` panels」；新增 Assignee / Priority selector 两行；R9 段补「family is seven triggers and no `<select>`」的读法；删去「assignee 与 priority 是两个原生 `<select>`」的旧句，改写为 R15 ② 的更正；R13 段的 Value/Named/Static/Capsule 四行按 dropdown 重写 |
| `design/BLOCKS.md` §B26 | **已同步（本卡）** | B26.1 行改为「each a `<details class="dropdown">`」；新增 B26.1a（一个 activity 控件的形状）；新增 R15 ① 的 before/after 对照表与 R15 ③ 段；辅助钩子集 `34 → 39`（并点名新增/退场的五个） |
| `design/BLOCKS.md` §B27 | **已同步（本卡）** | B27.2 行补描述座位；R15 ④ 段（本卡第一版写就，内容仍准；卡片的编号体系里 Waiting 描述是 ④） |
| `design/BLOCKS.md` 文首计数 | **已同步（本卡）** | `data-i18n*` 席位 `623 → 625`（`521 data-i18n` + `104` 变体）；**280 键不变**（净零） |
| `design/DESIGN.md §18.2` | **已同步（本卡）** | `assignee / priority filters` 行 = `dropdown` + `menu`；补 status / activity filters / filter clear 三行；表后加 R15 ①② 的段落说明这是一次**记录的更正**、`select select-sm` 只留在创建弹窗 |
| `design/activity/DESIGN-activity.md` | **必须同步（未由本卡落）** | §交互 的「重置 \| `[data-activity-filter-reset]`」行、§10 的 B26.1 钩子、§i18n 表里 `activity.filter.reset` 一行；三个控件的形状（`select` → `dropdown`）也要改。它是 B26 的设计**权威源** |
| `design/activity/prototype.html` + `activity.js` + `check-activity.mjs` | **必须同步（未由本卡落）** | 同族的钩子清单与页内词典（`activity.filter.reset`）在该页仍在；`check-activity.mjs` 的钩子清单仍列 `data-activity-filter-reset`。该页有自己的机检（`node design/activity/check-activity.mjs`），**不在本仓任何门里**，故本卡未破门，但**源页已与出货原型分叉** |
| `design/DESIGN.md` §8 的「use the component, keep the brand」 | 无需改 | 本轮正是这条规则的执行（`select` → `dropdown` 是组件选择，不是绕过组件） |
| `web/src/components/board/{FiltersBar,ActivityView,WaitingView}.vue` | **实现卡（-3）** | R15-B02…B09 |
| `web/src/i18n/catalogue.mjs` + `test/web/i18n.catalogue.mjs` | **实现卡（-3）——i18n 增量** | 两份副本**必须逐行同改**：删 `"activity.filter.reset"`（en/zh 各一行）、加 `"waiting.subtitle"`（en/zh 各一行，插在 `"waiting.title"` 之后、`"waiting.count"` 之前） |
| `test/web/blocks.contract.mjs` | **实现卡（-3）** | ① B04 段：assignee/priority 由 `select` 改 `dropdown`，钩子清单补 `-summary`/`-text`/`-value` 与行钩子；② B26 段：去掉 `[data-activity-filter-reset]`、`count == 1` 一行改挂 `[data-filter-clear]`，补三个 activity 控件的新钩子；③ `STALE_PROSE_COUNTS` 的钩子记录按 §6.4 更新到实测 **818**（`521 + 193 + 78 + 8 + 18`）——该记录在 `HEAD` 上已经落后（`817` vs 实测 `816`），两条红在 `HEAD` 上就在 |
| `web/manifests/board-m2.json` | **实现卡（-3）** | `selector: [data-activity-filter-reset]` 改挂 `[data-filter-clear]`；`r12-select`（`.td-select`）在原型侧已不在筛选条上（只剩创建弹窗），注意 ui-align 的分母位移 |
| `design/prototype/README.md` | **无影响**（实读核对） | I21 行说「the feed narrows from three controls」，换组件后仍为真；文件表与 key-pair 计数（280）不变 |

---

## 8. 红线与未决

### 8.1 未决项（**须 Elon 裁定，不自行发散**）

- **U1 — `design/activity/**` 的同步归属**：本卡的写面被钉为 `design/prototype/**` + `BLOCKS.md` + `DESIGN.md §18.2` + 本文件，故**未动** `design/activity/**`。但那一页是 B26 的设计权威源，现在与出货原型分叉（控件形状、钩子名、词典）。请裁定：并入实现卡（-3）一起改，还是单开一张 design 同步卡。
- **U2 — i18n 镜像落地前的那条红**：为满足 ④，`design/prototype/app.js` 的 `MESSAGES` **必须**增 `waiting.subtitle` 并删 `activity.filter.reset`；而两份目录副本是 `test/**` / `web/**`，本卡禁改。按 §6.4 的基线：`i18n.catalogue.test.mjs` **`HEAD` 上已红 3 条**，本卡把它抬到 **4 条**；`i18n.parity` 与 `blocks.contract.test.mjs` 的红数**不变**。这不是本轮造的缺陷，而是「设计卡先立键、实现卡再镜像」这一分工的中间态；若要设计卡也全绿，须把两份副本并入本卡写面（会与「零实现」冲突）。
- **U3 — priority 行是否带色点**：本轮给 priority 的六行加了 `.status.td-status-dot`（读行自己的 `data-priority` → `--status-color`），理由是它与 status 同属板面的"颜色标量"，而 assignee 的行是名字（纯文本）。反读法是「六个新控件都该是纯文本行」。若改判，删掉 priority 行里的点即可（`data-priority` 保留——卡片/图例/抽屉都读它）。
- **U4 — 清空是否要跟随 board 的 toast**：board 的 Clear 会 `toast(toast.filtersCleared)`；activity 的清空**原本不 toast**，本轮**保持不 toast**（裁定只提到钩子与 i18n 对齐）。若裁定「交互也要同一」，请明示。
- **U5 — Activity 条的 `aria-label` 复用 `filters.label`**：与 board 条同名（`Filters` / `筛选`），好处是零新增键且 A3 成为「取值相等」的机检。若要更贴合的名字（如 `Activity filters`），需新增一键并改 A3。
- **U6 — `<summary>` 的键盘行为**：原生 `<select>` 自带的方向键/首字母选择在 `dropdown` 面板下不存在；本轮**照抄 status/label 的既有行为**（`<summary>` 可聚焦、Enter/Space 开合，菜单行按 Tab 走），**没有**为七个控件加方向键导航。这是与既有家族一致的现状，但值得裁定是否升级为 `role="menu"` + 方向键。
- **U7 — 组件改名**：七个控件的触发器现在都叫 `.td-label-trigger`，而这个类名是 R9 为**标签**控件起的。类名不作契约锚，且改名的收益是措辞而非行为；本轮**保留**（`DESIGN.md §18.2` 仍指向它）。若裁定改名，`input.css` / `app.css` / 两个 `.vue` / `tw.css` 一起动。

### 8.2 本轮改动全集（进仓文件）

| 文件 | 改动 |
|---|---|
| `design/prototype/index.html` | ② board 的 assignee/priority 由 `<select>` 改为 `dropdown` 面板（`data-filter-assignee-value` / `data-filter-priority-value` / `[data-filter-assignee-text]` / `[data-filter-priority-text]` / 行钩子）；① activity 条由 `div`+3×`select` 改为具名 `section` + 3×`dropdown`（`-summary`/`-text`/`-option`/`-value`）；③ activity 清空控件换 `[data-filter-clear]`+`filters.clear`+`Clear`；④ Waiting 头部改两行文本块 + `p.td-waiting-sub` |
| `design/prototype/app.js` | assignee/priority 的值读写改走 `-value` 属性（`assigneeFilterValue()` / `priorityFilterValue()` / `writeAssigneeFilter()` / `writePriorityFilter()` / `renderPriorityFilter()` / `closeAssigneeMenu()` / `closePriorityMenu()`）；`renderAssigneeFilter()` 的行增删由 `<option>` 改为 `<li><button>`；`resetFilters()` 写四个值属性并关四个菜单；activity 的 `readActivityFilters()` / `syncActivityControls()` / 新增 `renderActivityFilters()` 走属性；两个 bar 的行点击绑定；`refreshGeneratedCopy()` 末尾补 `renderActivityFilters()` |
| `design/prototype/src/input.css` | + `.td-waiting-head-text`（`min-width:0`）、`.td-waiting-sub`（`margin:2px 0 0` / `12px` / `var(--color-td-ink-3)`）—— 口径 B 未再动 CSS |
| `design/prototype/tw.css` | 上条的构建产物（+8 行；工具链零改动复现后再建） |
| `design/BLOCKS.md` | §B04（Controls + 两个 selector 行 + R9/R13/R15 段）、§B26（B26.1 + B26.1a + R15 ①/③ 段 + 辅助钩子 39）、§B27（R15 ④）、文首钩子计数 |
| `design/DESIGN.md` | §18.2 组件映射表四行 + R15 ①② 说明段 |
| `design/fidelity-r15.md` | 本文件 |

### 8.3 边界（本轮**不**动什么）

1. **零实现**：`git diff -- web/ test/ src/ server/` 为空。
2. **纯度门禁**：本卡进仓的都是 `design/**`（原型三件 + 三个 md）；正文与脚本**不含**任何网络请求调用、鉴权令牌字面量、浏览器持久化调用，也不含版本化接口路径；证据脚本全部落在项目外 workspace，**不进仓**。
3. **不改原型实现纯度**：`design/prototype/**` 仍只有 UI 结构 / 样式 / 交互形式，无真实业务实现。
4. **不新增令牌**：零新增、零改名、零新增色值字面量；§3 的所有 `var(--…)` 在 `tw.css` 里早已解析。
5. **不改契约测试**：`test/**` 一行不动（R15-B07 的两处收口留给实现卡）。
