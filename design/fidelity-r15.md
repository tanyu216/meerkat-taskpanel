# UI 保真契约 · R15 — Activity 筛选栏 = board/list 的同一件控件 · Clear 替代 Reset · Waiting head 加描述

> 卡：`T-20261013-165112-2`（父史诗 `T-20261013-165112`）· 日期 2026-10-13 · 来源 Terry（2026-10-13 三条）。
> 范围：`design/prototype/index.html` 的 **B26.1 筛选栏** 与 **B27.2 头部**，加各自的 CSS / 交互层与词典。**零实现**：`web/**`、`test/**`、`src/**`、`server/**` 一行不动。
> 事实源：`design/prototype/index.html` + `design/prototype/src/input.css`（`tw.css` 为其构建产物）+ `design/prototype/app.js` + `design/BLOCKS.md`。**原型页在真实浏览器里的实测值是唯一事实源**，`.css` 里某条声明的字面值不是。
> 证据口径：所有实测值由 `workspace/T-20261013-165112-2/evidence/r15.mjs` 在 Chromium headless（Playwright，Chromium **153.0.8010.12**）里真跑所得；原始记录 `r15-measure.json`（20 轮 × 两侧逐块 computed/几何/DOM）、`verify-r15.json`（63 条断言 × 两侧的逐条 pass/fail + actual），截图 `shots/{before,after}-{board,activity,waiting}-{1512,1240,980,760,430}-{en,zh}.png`。**未跑的一律标注**。
> 基线 commit：**`6888821`**（本卡开工时 lane worktree `lane/T-20261013-165112-2-seg1` 的 HEAD）。同族前序：**R13**（`T-20261013-154954`，B04 的 assignee 名册）与 **R14**（`T-20261013-154930`，B09 抽屉逐块对账）。本轮三个子项与 B04/B26/B27 直接相关。

## 0. 结论摘要

- **三条都落地，且都带「before 红 / after 绿」的双侧实测**：断言 63 条，**after 63/63 通过**，**before 39/63**（24 条红）——13 个断言 id 由红转绿，即本轮的全部差异（`A2 A3 A8 A9 A10 A13 A15 A17 B3 B5 C4 C5 A20 A21`）。
- **① 的判据落在「同一件控件」上，不是「长得像」**：`[data-activity-filters]` 与 `[data-filters]` **同级同构**——同为 `section.td-filters` 具名地标、同 `aria-label`、同 flex 外壳；三个 `select` 的**计算样式与 board 的两个 `<select>` 逐字节相同**（`height:30px` / `padding:0 26px 0 8px` / `border-radius:6px` / `12px`·`400`）；控件是筛选条的**直接子元素**，各自的 `.td-sr` 标牌作**兄弟**座位（`for=`/`id=`）。原型侧的实质改动只有一处：条容器由 `div` 改为 board 同款具名 `section`。**实现侧**另有自创包装（`span.td-select-caret`），登记为 §4 **R15-B01**。
- **② 的判据是「同一个钩子」，不是「同一句词」**：`[data-activity-filter-reset]` 与 `activity.filter.reset` **退场**，槽位改挂 **`[data-filter-clear]`** + **`filters.clear`**（B04 的 Clear 一直在用的钩子与键），尾部顺序、`btn btn-ghost btn-sm` 外壳、计算盒（`56.44×28`）与 board 的 Clear **完全相同**。两条 Clear 靠**按下的那条条**区分，不靠第二个钩子名。
- **③ 的判据是「同一个座位」**：Waiting head 由单行标题变为**标题 + 描述**的两行文本块（`.td-waiting-head-text` + `.td-waiting-sub`），头部高度**由 21.59 变 41.59 —— 与 Activity 头部逐值相同**，描述的 `12px` / `rgb(126,138,145)` / `margin-top:2px` 与 `td-activity-sub` **逐值相同**，`[data-waiting-count]` 原位（`margin-left:auto`）不动。描述只挂 `data-i18n` 座位，**不新增任何 `data-waiting-*`** —— 该视图的辅助钩子集仍是 14 个名字。
- **i18n 增量口径 = 净零键、加一条字符串**：`activity.filter.reset`（en `"Reset"` / zh `"重置"`）**删除**，`waiting.subtitle`（en `"Everything waiting on your answer, oldest first."` / zh `"所有等你答复的事项，最久的排在最前。"`）**新增**，`en`/`zh` 各 280 键不变、逐键同序不变。**这条增量必须由实现卡镜像进两份目录副本**（§7）。
- **原型 HTML 改后仍「可见 + 可交互」**：20 轮（`{en,zh} × {1512,1240,980,760,430}`）**`console.error = 0`、`pageerror = 0`、横向溢出 0/20**；JS-off 两轮（1512/430）证明三处改动**不依赖脚本**（§6.3）。
- **「before」是复现出来的，不是回忆出来的**：`evidence/snapshot-before.mjs` 把 `index.html` / `app.js` / `tw.css` 三者按 `HEAD` 内容还原到 `/tmp/r15tw/before/` 并**逐文件比对为 `== HEAD`**，两侧同 harness、同浏览器、同 viewport 各跑一遍（§6.1）。

---

## 1. 口径与证据规则

**闭集口径（逐字使用，不得自创词）**：`对齐` = 与原型一致（本轮以**两侧实测同值**为准）；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差说明）。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本页不出现任何「文件 + 数字行号」形式的引用）。跨文档引用只写「文档名 §小节」或 selector。**断言只用 `data-*` 钩子 + 属性 + 计算样式**；class 名只用于描述样式与被测关系的**取值对齐**，不作契约锚。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / `getBoundingClientRect` / `scrollWidth`·`clientWidth` / DOM 计数 / 真实指针与键盘），**不是** CSS 文件里的声明字面值。
2. 载体 = 内置静态 HTTP 服务服务对应目录，URL `http://127.0.0.1:<随机端口>/index.html`（**不是 `file://`**）。
3. 矩阵 = 宽度 `1512 / 1240 / 980 / 760 / 430` × 主题 `light` × 语言 `en` + `zh` 必测；每档断言 `scrollWidth == clientWidth`（§5 B7）。
4. 交互轮用**真实点击 / 真实选择**（Playwright `click` / `selectOption`），不是合成事件。
5. **JS-off** = 同一份静态文档在 `javaScriptEnabled:false` 下加载（§5 A21），验证静态 markup 自身完备。
6. **实现侧本轮为「实读」，未实测**：未构建 `web/dist`（`web/node_modules` 为空、离线缓存为 linux/arm64），未起 dev server。凡涉及实现的位点一律标「实读」；§4 的「实现现状」列没有一个是实测值。
7. **不得伪造**：任何未验证项在正文里明写「未验证 / 实读未实测」。本页所有原型数字均可在 `verify-r15.json` / `r15-measure.json` 里逐条比对。
8. **两侧同源**：`before` = `/tmp/r15tw/before`（`HEAD` 的三个文件），`after` = 工作区 `design/prototype`；两者同一 harness、同一浏览器、同一 viewport 轮次，**差值即本轮的改动**。

---

## 2. 交互契约

只写「原型如此 + 实现应为」。所有选择器以原型为准（§5 的 A/C 腿逐条实测）。

### 2.1 ① · 三档筛选与 board/list 筛选是同一件控件

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 条容器 | `section.td-filters[data-activity-filters]`，**与 B04 的 `section.td-filters#td-filters[data-filters]` 同元素种类**（A2 实测 `section vs section`；before 为 `div`） | 同 |
| 地标名 | 带 `data-i18n-aria-label="filters.label"` + `aria-label="Filters"`（zh `筛选`），**与 board 条同名**（A3 实测两侧均 `Filters`；before 为 `null`） | 同 |
| 外壳 | `display:flex` · `align-items:center` · `flex-wrap:wrap` · `gap:8px` · `min-width:0`（B1 实测与 `[data-filters]` **逐属性相同**） | 同 |
| 控件行 | 三个 `select.select.select-sm.td-select` 是条的**直接子元素**，顺序 `actor · event · task`（A4 实测 `kidOrder` 含 `select:actor`） | 同 |
| 字段壳 | 三控件的 computed 与 board 的两个 `<select>` **逐字节相同**：`height:30px`、`padding:0 26px 0 8px`、`font-size:12px`、`font-weight:400`、`border-radius:6px`、`border-top-color:rgb(230,232,235)`、`background-color:rgb(255,255,255)`、`cursor:pointer`（B2 实测） | 同 |
| 标牌座位 | 每个控件由**紧邻的 `.td-sr` 兄弟**命名（`for=`/`id=`），不是包装盒（A6 实测三控件均 `true`） | 同 |
| 尾部 | `[data-filter-clear]` 然后 `[data-activity-filter-count]`，与 board 条的 `Clear · count` 同序（A7 实测 `tail = button>span`） | 同 |
| 域与计数 | 三档仍是 B26 自己的 `actor`/`event`/`task`；计数仍是 `[data-activity-filter-count]`（`aria-live="polite"`，A11 实测 `polite`） | 同 |

**本轮不改控件文案。** 三个控件的 option 词（`activity.filter.*`）逐字保留：board 的「字段: 值」写法（`Assignee: All`）与 Activity 的「裸值」写法（`Anyone` / `All events` / `All tasks`）**不是同一件事**——`Event: Status` / `Event: All events` 这类前缀既与原词重复，又会改写 8 条已出货的字符串并牵动两份目录副本。本轮判据取**控件的同一性**（元素种类、外壳、座位、尾部、计算样式），取的不是文案同形；§8 U1 记下这条裁定的理由与反对读法。

### 2.2 ② · 清空控件 = B04 的 Clear（同一钩子、同一把键）

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 钩子 | `[data-filter-clear]`（A8 实测命中；before 无） | 同 |
| 词典键 | `data-i18n="filters.clear"`（A9 实测 `filters.clear`） | 同 |
| 词面 | en `Clear` / zh `清除`（C4 实测 `clear="清除"`；before 为 `重置`） | 同 |
| 外壳与盒 | `btn btn-ghost btn-sm`；computed `height:28px`、`padding:0 12px`、`font-size:12px`、`border-radius:6px`，盒 `56.44×28` —— 与 board 的 Clear **逐值相同**（B3 实测两侧同值） | 同 |
| 位置 | 条尾第一位，计数在其右（A7） | 同 |
| 退场 | `[data-activity-filter-reset]` **不再存在**于该条（A10 实测 `0`） | 同 |
| 分流 | 同一个文档级 `[data-filter-clear]` 处理器**按按下的那条条**分流：在 `[data-activity-filters]` 内 ⇒ 重置三档 activity 过滤；在 `[data-filters]` 内 ⇒ 走原 `resetFilters()` 路径 | 同（Vue 侧两个组件各自绑定，不冲突） |
| 行为不变 | 三档回 `all`、计数回未过滤总数、board 的两档过滤**原样不动**；board 的 Clear 仍重置 board（C1/C2/C3 实测两侧**均通过**） | 同 |
| 空态的重置钮 | `[data-activity-empty-reset]`（B26.5 筛空空态内嵌）**保持原钩子与原键** `activity.empty.filter.reset`，且**不带** `[data-filter-clear]`（A19 实测 `clear=false`） | 同；它不是筛选条上的控件，是另一处的另一种供给 |

### 2.3 ③ · Waiting head = 标题 + 描述

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 结构 | `[data-waiting-head]` 的子元素为 `div.td-waiting-head-text` + `span.td-waiting-count`（after 实测 `kids`；before 为裸 `h1` + `span`） | 同 |
| 文本块 | 标题与描述同在一个文本块内（A15 实测 `wrap=true`，块类 `td-waiting-head-text`） | 同 |
| 描述 | `<p class="td-waiting-sub" data-i18n="waiting.subtitle">`，tag `p`，与 B26 描述的 tag **相同**（A17 实测 `p vs p`） | 同 |
| 座位 | **只挂 `data-i18n`**，无 `data-waiting-*`（A14 实测 `0`）—— 与 B26.1「header 自己的标题与副标题只挂 `data-i18n`」同规则 | 同 |
| 头部高度 | `1216×41.59`，**与 Activity 头部逐值相同**（B… §3 表） | 同 |
| 描述盒 | `263.61×18`；`font-size:12px`、`color:rgb(126,138,145)`、`margin-top:2px`，与 `td-activity-sub`（`250.86×18`）**逐值相同**（B5 实测两侧同值） | 同 |
| 计数 | `[data-waiting-count]` 原位、原词（A16 实测在） | 同 |
| 与 B27 家族规矩 | 只在本视图自己的名字下声明（`.td-waiting-head-text` / `.td-waiting-sub`），不让两个头部互相牵动 | 同 |

### 2.4 未变（本轮**不得**触碰的交互）

- **board/list 的筛选条**：`[data-filters]` 的任何钩子、任何控件、Clear 的任何行为（C3 只作回归证明，不改它）。
- **B26 的 feed / 空态 / Load older / 行开卡 / `j`·`k`**：与本轮无关。
- **B26.5 的 `[data-activity-empty-reset]`**：原钩子、原键、原行为。
- **`design/activity/**`**：设计源页与其 `check-activity.mjs` **本卡未动**（§7 记为必须同步项，§8 U2）。

---

## 3. 视觉规格（数值即结论）

令牌守恒声明：**本轮不新增、不改名任何设计令牌**。以下数值全部来自原型实测（1512×950，light，en；除注明外）。

| 量 | before 实测 | after 实测 | 出处（文件:选择器） |
|---|---|---|---|
| 筛选条外壳（两条同值） | `flex / center / wrap / 8px / 0px / visible` | 同 | `.td-filters` |
| Activity 条容器 | `div`，`aria-label = null` | **`section`，`aria-label = "Filters"`（zh `筛选`）** | `[data-activity-filters]` |
| Activity 三控件字段壳 | `30px / 0 26px 0 8px / 12px / 400 / 6px` | **同（与 board 的两 `<select>` 逐字节相同）** | `.td-select` |
| Activity 清空控件 | `Reset`，盒 `58.78×28`，钩子 `[data-activity-filter-reset]` | **`Clear`，盒 `56.44×28`，`[data-filter-clear]`** | 条尾 |
| board 的 Clear（对照） | `Clear`，盒 `56.44×28` | 不变 | `[data-filters] [data-filter-clear]` |
| Activity 计数 | `15 entries`，盒 `72.25×18` | 同 | `[data-activity-filter-count]` |
| Waiting 头部 | `1216×21.59`，子 = `h1` + `span` | **`1216×41.59`**，子 = `div.td-waiting-head-text` + `span` | `[data-waiting-head]` |
| Activity 头部（对照） | `1216×41.59` | 不变 | `.td-activity-head` |
| Waiting 描述 | — | `263.61×18`，`12px` / `rgb(126,138,145)` / `margin-top:2px` | `.td-waiting-sub` |
| Activity 描述（对照） | `250.86×18`，`12px` / `rgb(126,138,145)` / `margin-top:2px` | 不变 | `.td-activity-sub` |
| Waiting 标题 | `16px/600`，盒 `107.34×21.59` | `16px/600`，盒 `263.61×21.59`（文本块撑开） | `.td-waiting-title` |
| 横向溢出（20 轮） | `0/20` | `0/20` | `documentElement` |

> `tw.css` 是构建产物：本轮 `src/input.css` 的增量（`.td-waiting-head-text` / `.td-waiting-sub` 两条）**由同一工具链重建**，且先做过**零改动复现**——用 `HEAD` 的 `src/input.css` 重跑构建，输出与已提交的 `tw.css` **逐字节相同**（§6.2），故重建后的 diff 只有新增的 8 行。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

> 「实现现状」全部为**实读**（§1.6），未实测。原型列全部为**实测**。

| id | 块 | 根 / 关键钩子 | 判定 | 原型实测期望 | 实现现状（文件:符号，实读） | 偏差说明 |
|---|---|---|---|---|---|---|
| R15-B01 | ① 筛选条容器 | `[data-activity-filters]` | `口径` | `section` + `filters.label` 具名地标（与 `[data-filters]` 同种类同名） | `web/src/components/board/ActivityView.vue`：`<div class="flex min-w-0 flex-wrap items-center gap-2" data-activity-filters>`，**无 `aria-label`、无 `data-i18n-aria-label`** | 种类由 `div` 改 `section`；补名 |
| R15-B02 | ① 控件包装 | 三个 `select[data-activity-filter]` | `自创` | 控件是筛选条的**直接子元素**（原型无包装） | `ActivityView.vue`：每个 `<select>` 外包一层 `<span class="td-select-caret">` + 内联 `svg.td-icon-sm`（`app.css:.td-select-caret`）；`app.css:.td-select` **不带** caret 的 `background-image`（C08 禁六位色值字面量） | **实现自创**。原型里同一个「包装盒是这组件发明的」问题在 B04 侧已于 R12 修掉（`FiltersBar.vue` 的自述），ActivityView 侧残留 ⇒ 本轮判据要求它按 B04 的形状收口：控件是条的直接子元素 |
| R15-B03 | ② 清空控件 | `[data-activity-filters] [data-filter-clear]` | `口径` | 钩子 `[data-filter-clear]` + 键 `filters.clear` + 盒 `56.44×28` | `ActivityView.vue`：`data-activity-filter-reset` + `data-i18n="activity.filter.reset"` + `$t("activity.filter.reset")`，`@click="onReset"` | 钩子与键都要换；`onReset` 的**行为**保留（`resetActivityFilters()` + `writeActivityHash()`） |
| R15-B04 | ② 退场项 | `[data-activity-filter-reset]` / `activity.filter.reset` | `缺` | 该条上**不存在**（A10 实测 `0`） | 三条出现：`ActivityView.vue` 的按钮、`test/web/blocks.contract.mjs`（B26 钩子清单 + `count == 1`）、`web/manifests/board-m2.json`（`selector: [data-activity-filter-reset]`） | 实现 + 契约测试 + ui-align 清单**同时**要改（§7） |
| R15-B05 | ② 空态复位钮 | `[data-activity-empty-reset]` | `对齐` | 原钩子、原键 `activity.empty.filter.reset`，**不带** `[data-filter-clear]`（A19 实测 `clear=false`） | `ActivityView.vue` 空态内嵌同钩子同键 | 无需改（**匹配项**） |
| R15-B06 | ③ Waiting 头部 | `[data-waiting-head]` → 文本块 + 描述 | `缺` | `div.td-waiting-head-text` 内含 `[data-waiting-title]` + `p.td-waiting-sub[data-i18n="waiting.subtitle"]`；头部高 `41.59` | `web/src/components/board/WaitingView.vue`：头部只有 `[data-waiting-title]` 与 `[data-waiting-count]`（实读） | 两行文本块与描述双缺；计数原位 |
| R15-B07 | ③ 描述座位 | `[data-i18n="waiting.subtitle"]` | `缺失口径` | 只挂 `data-i18n`，无 `data-waiting-*`（A14 实测 `0`） | 键不存在于 `web/src/i18n/catalogue.mjs`（实读） | 新增键，须由实现卡镜像（§7） |

### 4.2 匹配项（本轮命中但无需改动）

| 块 | 根 | 实测依据 | 备注 |
|---|---|---|---|
| B26 三档域与计数 | `[data-activity-filter]` / `[data-activity-filter-count]` | A4/A7/A11；`aria-live="polite"` | **不得**再动域与计数 |
| B04 的 Clear | `[data-filters] [data-filter-clear]` | B3/C3（两侧均通过） | 本轮只把它**复制**到另一条条上，自身零改动 |
| B26 头部 | `.td-activity-head` | 头部 `1216×41.59` 两侧同值 | ③ 只学它，不改它 |
| B27.2 计数胶囊 | `[data-waiting-count]` | A16 | 原位、原词 |
| B27 的 14 个辅助钩子 | `data-waiting-*` | A14（描述不带 `data-waiting-*`） | 集合不变 |
| R12 的 B04「控件是条的直接子元素」 | `[data-filters] > select` | B1/B2（两侧同值） | ① 就是它的镜像面 |

### 4.3 负向注记清单（本轮**不得**触碰）

1. **B04 本体**：任何钩子、任何控件、Clear 的行为与位置。
2. **B26 的 feed / 空态 / Load older / 行开卡 / 键盘 `j`·`k`**：与本轮无关。
3. **`[data-activity-empty-reset]`**：原钩子、原键、原行为（它是空态的供给，不是条上的控件）。
4. **`design/activity/**`**：本卡未动（§8 U2 记其必须同步）。
5. **`web/**`、`test/**`、`src/**`、`server/**`**：一行不动（本卡只写 `design/**`）。
6. **令牌**：不新增、不改名、不新增色值字面量。

---

## 5. 机检断言清单（A 结构 / B 几何·计算样式 / C 交互）

运行器：`workspace/T-20261013-165112-2/evidence/r15.mjs`（**不进仓**）。每条 = `id | 断言式 | 原型实测期望 | 归属`。**两侧各跑一遍**：`after 63/63 通过`；`before 39/63`（24 红）；**13 个 id 由红转绿**。行数分布：A20 / B7 / C7 各在 10 个「宽度 × 语言」档各跑一次，A21 在 1512/430 两档各跑一次。

### A · 结构

| id | 选择器 | 断言式 | 期望 | 归属 | before |
|---|---|---|---|---|---|
| A1 | `[data-activity-filters]` | 存在 | `present` | 双侧 | 绿 |
| A2 | `[data-activity-filters]` vs `[data-filters]` | 同元素种类 | `section == section` | 双侧 | **红**（`div vs section`） |
| A3 | `[data-activity-filters]` vs `[data-filters]` | 同 `aria-label` 且非空 | `Filters == Filters` | 双侧 | **红**（`null`） |
| A4 | `[data-activity-filters]` 的控件行 | 三档是条自己的直接子元素、序 `actor·event·task` | `3 :: …select:actor…` | 双侧 | 绿 |
| A5 | 同上 | 每个控件含 `td-select`（与 board 同字段族） | 3/3 | 双侧 | 绿 |
| A6 | 同上 | 每个控件有 `.td-sr` 兄弟标牌（`for=`/`id=`） | 3/3 | 双侧 | 绿 |
| A7 | 条的孩子序 | 尾 = `[data-filter-clear]` 再计数 | `button>span` | 双侧 | 绿 |
| A8 | `[data-activity-filters] [data-filter-clear]` | 命中 | `filters.clear` | 双侧 | **红**（absent） |
| A9 | 同上 | `data-i18n == "filters.clear"` | `filters.clear` | 双侧 | **红** |
| A10 | `[data-activity-filters] [data-activity-filter-reset]` | 计数 `== 0` | `0` | 双侧 | **红**（`1`） |
| A11 | `[data-activity-filter-count]` | `aria-live == "polite"` | `polite` | 双侧 | 绿 |
| A12 | `[data-waiting-view]` | 按下侧栏后可开 | `true` | 双侧 | 绿 |
| A13 | `[data-waiting-head]` 的描述座位 | 存在 | 实测文案 | 双侧 | **红**（absent） |
| A14 | `[data-waiting-head] [data-waiting-sub]` | 计数 `== 0` | `0` | 双侧 | 绿（两侧皆无，**不能单独证明**；与 A13/A15 同读） |
| A15 | 文本块 + `wrap` | 标题与描述同块 | `td-waiting-head-text / wrapped=true` | 双侧 | **红** |
| A16 | `[data-waiting-count]` | 在位 | 实测文案 | 双侧 | 绿 |
| A17 | Waiting 描述 vs Activity 描述 | 同 tag | `p vs p` | 双侧 | **红** |
| A18 | — | 静态轮 `console.error == 0 && pageerror == 0` | `0` | 双侧 | 绿 |
| A19 | `[data-activity-empty-reset]` | 原键 + **不带** `[data-filter-clear]` | `clear=false` | 双侧 | 绿 |
| A20 | 三处座位（×10 档） | 每档清空控件与描述都在 | `both present` | 双侧 | **红**（×10，before 无这两处） |
| A21 | JS-off（×1512/430） | 条 `section` + `Filters` + `Clear`/`filters.clear` + 三 `<select>` + `waiting.subtitle` 全在位 | 全通过 | 双侧 | **红**（×2） |

### B · 几何 / 计算样式（真浏览器 computed，1512×950 light en）

| id | 选择器 | 断言式（computed） | 期望 | 归属 | before |
|---|---|---|---|---|---|
| B1 | 两条的 `self` | 逐属性相同 | `flex/center/wrap/8px/0px/visible` | 双侧 | 绿 |
| B2 | 三控件的字段壳 vs board 一 `<select>` | `height`/`padding`/`border-radius` 三者相同 | `30px / 0 26px 0 8px / 6px` | 双侧 | 绿 |
| B3 | 两条的 Clear | `style` 全等 | `28px / 0 12px / 12px / 6px` | 双侧 | **红**（before 无） |
| B4 | 两条的计数 | `style` 全等 | `18px / 0px / 12px` | 双侧 | 绿 |
| B5 | Waiting 描述 vs Activity 描述 | `style` 全等 | `12px / rgb(126,138,145) / 2px / 18px` | 双侧 | **红**（before 无） |
| B6 | `documentElement` | 三视图均无横向溢出 | `0/0/0` | 双侧 | 绿 |
| B7 | 同上（×10 档） | 无横向溢出 | `0/0` | 双侧 | 绿 |

### C · 交互（真实点击 / 真实下拉 / 真实焦点）

| id | 动作 | 断言 | before | after |
|---|---|---|---|---|
| C1 | 先在 board 设 `priority=urgent`/`assignee=human`，进 activity 设 `actor=agent`，**真实点击**条上的 Clear | 三档回 `all`、计数回未过滤总数 | 绿 | 绿 |
| C2 | 同上一步之后 | board 的两档过滤**原样不动**（`urgent`/`human`） | 绿 | 绿 |
| C3 | 回 board **真实点击** `[data-filters] [data-filter-clear]` | board 两档回 `all` | 绿 | 绿 |
| C4 | 切 zh 后进 activity | Clear 词面 `清除`、条 `aria-label` `筛选` | **红** | 绿 |
| C5 | 切 zh 后进 waiting | 描述为中文且不是未解析的键名 | **红** | 绿 |
| C6 | 交互轮全程 | `console.error == 0 && pageerror == 0` | 绿 | 绿 |
| C7 | ×10 档 | 同上 | 绿 | 绿 |

> C1–C3 在**两侧都通过**：这正是 ② 的要点——本轮改的是**钩子与词**，不是**行为**。

### 5.x 不得断言（负向组）

- **不得**用 class 名当契约锚（本轮 `B1`–`B5` 用的是**两条之间取值的相等**，不是 class 存在性）。
- **不得**在原型上断言 `[data-activity-filter-reset]`（已退场）；也**不得**在 `design/activity/**` 上替它断言（那是另一份文档，见 §7）。
- **不得**把 `td-activity-sub` / `td-waiting-sub` 的**类名**断言成「同一样式」；断言的是两条的 computed 相等（B5）。
- **不得**断言 Activity 的 option 文案与 board 同形（§2.1 的裁定；见 §8 U1）。
- **不得**用 `[data-waiting-sub]` 的存在当 ③ 的判据（原型本就没有，A14 两侧皆 `0`）。

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
≈ tailwindcss v4.3.3
committed tw.css bytes : 205036
rebuilt(HEAD) bytes    : 205036
byte-identical         : true
$ node twbuild-run.mjs        # 再用改后的 src/input.css 重建
/*! 🌼 daisyUI 5.7.47 */
# git diff -- tw.css → 只新增 8 行（.td-waiting-head-text / .td-waiting-sub）
```

### 6.3 复跑命令与原始输出摘要

```text
$ node evidence/r15.mjs measure
runs per side: 10/10
runs with console/page errors: before: 0  after: 0

$ node evidence/r15.mjs verify
{ "before": { "total": 63, "pass": 39, "fail": 24 },
  "after":  { "total": 63, "pass": 63, "fail": 0 } }
changes (ids that moved): A2, A3, A8, A9, A10, A13, A15, A17, B3, B5, C4, C5, A21, A20
```

真实摘要（全部可在 `r15-measure.json` / `verify-r15.json` 逐条比对）：

| 量 | 实测 |
|---|---|
| 轮次 | `{light} × {en,zh} × {1512,1240,980,760,430}` = 20 轮 × 两侧 |
| `console.error` / `pageerror` | `0 / 0`（20 轮全同，两侧各 20） |
| 横向溢出轮次 | **0 / 20**（每轮 `scrollWidth == clientWidth`） |
| 条容器 | before `div` / aria `null` → after `section` / aria `Filters`（zh `筛选`） |
| 三控件字段壳 | 与 board 两 `<select>` 逐字节相同（`30px / 0 26px 0 8px / 12px 400 / 6px`） |
| 清空控件 | before `Reset` `58.78×28` → after `Clear` `56.44×28`（= board 的 Clear） |
| Waiting 头部 | `21.59` → `41.59`（= Activity 头部） |
| Waiting 描述 | 无 → `263.61×18`，`12px` / `rgb(126,138,145)` / `mt 2px` |
| JS-off | 三处在静态文档里齐备（1512 / 430 两轮） |
| 截图（board 视图回归） | `1512-en` 差 248 px（0.017%）、`430-zh` 594 px（0.145%）、`760-en` 36 px（0.005%）；**同侧同档重跑的噪声基线 = 100 px**，故 board 视图无结构性改动 |

### 6.4 宿主门禁的基线（`HEAD` 本就红，本卡的净增是 **1 条**）

本卡写面只有 `design/**`，但两条宿主套件**读原型文件**，所以它们的红绿会随本轮移动。为把「本卡造成的」与「开工前就在的」分开，在 `HEAD`（`6888821`）的干净检出里跑过一遍（`git worktree add --detach` 的临时检出，已删）：

| 套件 | `HEAD` | 本卡之后 | 净增 |
|---|---|---|---|
| `test/web/i18n.catalogue.test.mjs` | **3 红**：`carries the prototype's entries verbatim…` / `deep-equals the catalogue re-derived…` / `matches the prototype's real key count…` | **4 红**（同上三条 + `covers every translated hook in design/prototype/index.html`） | **+1** |
| `test/web/i18n.parity.test.mjs` | 绿（6/6） | **绿（6/6）** | 0 |
| `test/web/blocks.contract.test.mjs` | **2 红**：`counts the data-i18n* seats…` / `counts the MESSAGES keys…` | 同样 **2 红**（同两条） | 0 |

**`HEAD` 上记录与文档的实测差**（用套件自己的口径复算，见 `evidence` 侧的计数脚本）：

| 量 | `blocks.contract.mjs` 记录的 | `HEAD` 实测 | 本卡实测 |
|---|---|---|---|
| `data-i18n*` 席位总数 | `817` | **816**（`525 + 193 + 72 + 8 + 18`） | **818**（`526 + 193 + 73 + 8 + 18`） |
| `MESSAGES` en/zh 键 | `281` | **280 / 280** | **280 / 280**（净零） |

即：**这两条红在 `HEAD` 上已经存在**（另一个 lane 的 `design/prototype/**` 改动没有把记录带上），本卡既没有修掉它们、也没有让它们变多——本卡只让**上一行的两个数字各自 +1（钩子）与不变（键）**。唯一由本卡新增的红是 `i18n.catalogue.test.mjs` 的**钩子解析**那一条（`index.html` 多了一个 `waiting.subtitle` 未在冻结副本里），它在实现卡把键镜像进两份副本后消失（§7、§8 U3）。

### 6.5 证据目录

```text
workspace/T-20261013-165112-2/evidence/
  snapshot-before.mjs        # 从 HEAD 还原 before 快照（并自证 == HEAD）
  r15.mjs                    # measure / verify 双模式运行器（两侧同源）
  r15-measure.json           # 20 轮 × 两侧 × 逐块 computed/几何/DOM（原始）
  verify-r15.json            # 63 条 × 两侧的逐条 pass/fail + actual（原始）
  before-measure.json        # 首轮 before 采集（早期单侧版本，保留）
  shots/                     # 两侧 × {board,activity,waiting} × 5 宽度 × 2 语言
```

截图证明「**原型 HTML 仍可见 + 可交互**」：`after-{activity,waiting,broad}-*.png` 是真实按下侧栏项、真实下拉、真实切语言后的全幅。board 侧的对照截图与 before 的像素差证明**板面未被本轮牵动**。

---

## 7. 文档同步判定（§⑫）

| 文档 | 是否需同步 | 说明 |
|---|---|---|
| `design/BLOCKS.md` §B26 | **已同步（本卡）** | B26.1 的钩子改为 `[data-filter-clear]`；辅助钩子集 35 → **34**；新增「R15 ①」「R15 ②」两段裁定 |
| `design/BLOCKS.md` §B27 | **已同步（本卡）** | B27.2 头部加入描述座位；新增「R15 ③」一段 |
| `design/BLOCKS.md` 文首计数 | **已同步（本卡）** | `623 → 625` 个 `data-i18n*` 钩子（`525+1` 个 `data-i18n`、`98+1` 个变体）；**280 键不变**（净零） |
| `design/activity/DESIGN-activity.md` | **必须同步（未由本卡落）** | §交互 的「重置 \| `[data-activity-filter-reset]`」行、§10 的 B26.1 钩子、§i18n 表里 `activity.filter.reset` 一行。它是 B26 的设计**权威源**，现与出货原型不一致 |
| `design/activity/prototype.html` + `activity.js` + `check-activity.mjs` | **必须同步（未由本卡落）** | 同族的钩子清单与页内词典（`activity.filter.reset`）在该页仍在；`check-activity.mjs` 的钩子清单仍列 `data-activity-filter-reset`。该页有自己的机检（`node design/activity/check-activity.mjs`），**不在本仓任何门里**，故本卡未破门，但**源页已与出货原型分叉** |
| `design/DESIGN.md` §29 / §30 | **需要，本轮不改** | §29.2 的筛选条起落与 §30 的 B27 语义都不受本轮影响；§30 可补一句「头部两行」但非必需 |
| `web/src/components/board/ActivityView.vue` + `WaitingView.vue` | **实现卡（-3）** | R15-B01…B07 |
| `web/src/i18n/catalogue.mjs` + `test/web/i18n.catalogue.mjs` | **实现卡（-3）——i18n 增量** | 两份副本**必须逐行同改**：删 `"activity.filter.reset"`（en/zh 各一行）、加 `"waiting.subtitle"`（en/zh 各一行，插在 `"waiting.title"` 之后、`"waiting.count"` 之前）。**这两份副本在 `HEAD` 上已与 `app.js` 不同步**（§6.5），本卡只把差口从 3 条测试抬到 4 条；`i18n.parity`（两副本互比）**本卡之后仍为绿** |
| `test/web/blocks.contract.mjs` | **实现卡（-3）** | ① B26 段的钩子清单去掉 `[data-activity-filter-reset]`、`count == 1` 一行改挂 `[data-filter-clear]`（在条内取值）；② `STALE_PROSE_COUNTS` 的钩子记录按 §6.4 的表更新到**实测 818**（`526 + 193 + 73 + 8 + 18`）——该记录在 `HEAD` 上已经落后于文档（`817` vs 实测 `816`），本卡把差口挪到 `818`，**两条红在 `HEAD` 上就在**，不是本卡所致 |
| `web/manifests/board-m2.json` | **实现卡（-3）** | `selector: [data-activity-filter-reset]` 改挂 `[data-filter-clear]`；注意 ui-align 的分母会随原型侧选择器缺席而位移 |
| `design/README.md` / `design/prototype/README.md` | **无影响** | 索引与原型文件表不含本轮改动面 |

---

## 8. 红线与未决

### 8.0 未决项（**须 Elon 裁定，不自行发散**）

- **U1 — ① 的判据取「同一件控件」而非「文案同形」**：本轮把 ① 落在**元素种类 / 外壳 / 座位 / 尾部 / 计算样式**的同一性上，**不动**三个 option 的文案。反对读法是「Activity 的控件也该写 `Actor: Anyone` 那样带字段前缀」。不采用的三个理由：①`Event: Status`、`Event: All events` 会与原词重复，读起来是病句；②要改写 8 条已出货字符串（并牵动两份目录副本 + 实现侧的 `optionText`）；③board 的四件控件**本身就不是同一套文案**（两个 `<select>` 带前缀、两个 `<details>` 触发器各写各的），所谓「同形文案」在 board 侧并不存在。若 Elon 裁定走反对读法，则本轮 §2.1 的表格与 §5 的 A2–A6 需整段重写。
- **U2 — `design/activity/**` 的同步归属**：本卡的写面被钉为 `design/prototype/{index.html,src/input.css,app.js}` + fidelity 文档，故**未动** `design/activity/**`。但那一页是 B26 的设计权威源，现在与出货原型分叉（钩子名、词典）。请裁定：并入实现卡（-3）一起改，还是单开一张 design 同步卡。
- **U3 — i18n 镜像落地前的那条红**：为满足 ③，`design/prototype/app.js` 的 `MESSAGES` **必须**增 `waiting.subtitle` 并删 `activity.filter.reset`；而 `test/web/i18n.catalogue.mjs` 与 `web/src/i18n/catalogue.mjs` 是 `test/**` / `web/**`，本卡禁改。按 §6.4 的基线：`i18n.catalogue.test.mjs` **`HEAD` 上已红 3 条**，本卡把它抬到 **4 条**（多出的正是 `index.html` 的钩子解析那条）；`i18n.parity` 与 `blocks.contract.test.mjs` 的红数**不变**（后者两条红在 `HEAD` 已在）。这不是本轮造的缺陷，而是「设计卡先立键、实现卡再镜像」这一分工的中间态；若 Elon 要求设计卡也保持全绿，则须把两份目录副本并入本卡写面（会与「零实现」冲突），或者**由实现卡之外的单卡先行清掉 `HEAD` 上那 5 条既存红**。
- **U4 — 清空是否要跟随 board 的 toast**：board 的 Clear 会 `toast(toast.filtersCleared)`；activity 的清空**原本不 toast**，本轮**保持不 toast**（② 的文本只提到钩子与 i18n 对齐）。若裁定「交互也要同一」，那就是再加一次 toast —— 请裁决。
- **U5 — 新增 `aria-label` 是否要改成 Activity 专用词**：本轮复用 `filters.label`（`Filters` / `筛选`）作为 Activity 条的可见地标名。理由：①零新增键；②与 board 条同名 ⇒ A3 成为**取值相等**的机检。若裁定该条应有更贴合的名字（如 `Activity filters`），则需新增一键并改 A3 的判据。

### 8.1 本轮改动全集（进仓文件）

| 文件 | 改动 |
|---|---|
| `design/prototype/index.html` | ① 条容器 `div` → 具名 `section`（+ `data-i18n-aria-label`/`aria-label`）；② 尾部按钮换钩子与键（`[data-activity-filter-reset]`/`activity.filter.reset` → `[data-filter-clear]`/`filters.clear`，词面 `Reset` → `Clear`）；③ Waiting 头部改为 `div.td-waiting-head-text` + `p.td-waiting-sub` |
| `design/prototype/src/input.css` | + `.td-waiting-head-text`（`min-width:0`）与 `.td-waiting-sub`（`margin:2px 0 0` / `font-size:12px` / `color:var(--color-td-ink-3)`） |
| `design/prototype/tw.css` | 上条的构建产物（+8 行，工具链零改动复现后再建） |
| `design/prototype/app.js` | ② 文档级 `[data-filter-clear]` 处理器按条分流；空态复位钮单独绑定；词典 −`activity.filter.reset` +`waiting.subtitle`（en/zh） |
| `design/BLOCKS.md` | §B26 / §B27 同步 + 文首钩子计数 |
| `design/fidelity-r15.md` | 本文件 |

### 8.2 边界（本轮**不**动什么）

1. **零实现**：`git diff -- web/ test/ src/ server/` 为空。
2. **纯度门禁**：本卡新增的进仓文件只有 `design/fidelity-r15.md`（纯 Markdown）与原型三件 + `BLOCKS.md`；正文与脚本**不含**任何网络请求调用、鉴权令牌字面量、浏览器持久化调用，也不含版本化接口路径；证据脚本全部落在项目外 workspace，**不进仓**。
3. **不改原型实现纯度**：`design/prototype/**` 仍只有 UI 结构 / 样式 / 交互形式，无真实业务实现。
4. **不新增令牌**：零新增、零改名；§3 的所有 `var(--…)` 在 `tw.css` 里早已解析。
5. **不改契约测试**：`test/**` 一行不动（R15-B04 的两处收口留给实现卡）。
