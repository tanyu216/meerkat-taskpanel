# UI 保真契约 · R11 — 状态筛选，与「点名字 ⇒ 进 list」的路由

> 卡：`T-20261013-014701-2`（父 epic `T-20261013-014701`）· 日期 2026-10-13 · 范围「Terry 需求①②」。
> 来源：Terry 两项需求 —— ① list 视图的 filters 增「**状态**」筛选项；② Sidebar「Active agents」区的 **Assignee 名字可点击** ⇒ 路由到 list 视图 + 预置状态筛选 = `{in_progress, in_review}`。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 证据口径：本契约每条断言都在**真实浏览器（Chromium headless / Playwright）里对原型实测**，「期望值」即实测值；改前（before）与改后（after）各测一轮，两份原始记录见 §6。
> 关系卡：实现卡（`web/**` 镜像改动）与验证卡由 Elon 派发；**本卡只产契约与原型改动，不含实现代码**。
> 基线 commit：`4824298`（本卡开工时的 HEAD）。同族前序：R9〔`T-20261012-224743`〕定了 list 的二态与轻关闭；R10〔`T-20261012-230448`〕把该二态口径搬到 board。本卡复用两者的口径，不重新定义。

## 0. 结论摘要

- 两项**全部落在既有块**（① B04 · ② B03 → B08）⇒ 本契约**不引入新块**；新增两个钩子族：状态筛选的 `data-filter-status-value` / `[data-filter-status-summary]` / `[data-filter-status-text]` / `[data-filter-status-option]` + `data-status-value`，以及名册按钮的 `[data-agent-assignee]`。
- **① 的控件形态是「第二个 dropdown」，也是本 bar 唯一的「多选」**：`<details class="dropdown" data-dismiss-on-outside>`，与 `[data-filter-label]` 同族、同 `.td-label-trigger` 度量（R9 ②）、同 `.td-label-menu` 外壳。**没有**用原生 `<select>`（单选表达不了 ② 要的两值），**没有**用 `<select multiple>`（不是下拉）。
- **值域 = 一等 7 status（禁魔数）**：`data-filter-status-value` = `"all"` **或**逗号连接的 7 值子集，顺序恒为 `DESIGN.md` §2.3 的 key 序。改动前的实测：menu 的 7 个 `data-status-value` 与 7 个 `[data-column][data-status]`、18 张卡的 `[data-card][data-status]` **取值集合完全相同** —— 这条等式就是「禁魔数」的机检口径（§5 A2′）。
- **多选语义 = OR**：命中任一选中状态即通过；`all`（或空）= 不过滤；与其他三项筛选（assignee / priority / label）之间是 **AND**，与既有口径一致。
- **② 是「路由」不是「按名字收窄」**：按下 ⇒ `setView("list")` + 写 `data-filter-status-value="in_progress,in_review"` + `applyFilters()`。**assignee 筛选不写名字**（边界见 §2.3：一等 assignee 筛选值域 = `all|me|human|agent`，不含具名；「按人名收窄」是要扩值域的另一需求）。
- **`in_progress` / `in_review` 口径明写**：`in_progress` = 已被认领、正在跑；`in_review` = 已交出手、等验收。二者是 7 个 status 里**唯一**两个表示「在途」的（`blocked` 已停、`done`/`canceled` 已了结、`backlog`/`todo` 未开工）。
- **键位/可达性零成本**：控件是原生 `<details>`/`<summary>`/`<button>`，名册名是真 `<button>` ⇒ `Enter`/`Space`/`Tab`/`:focus-visible` 全部来自元素本身，无 `role`、无 `tabindex`、无 key handler。
- **token 无新增、无改动**：圆点走既有一属性→一变量的管道（`[data-status="<key>"]` ⇒ `--status-color` ⇒ `--color-td-st-*`），trigger 复用 `.td-label-trigger`，菜单外壳复用 `.td-label-menu`。`tw.css` 重建后新增的类选择器**恰好两个**：`.td-status-menu`、`.td-agent-assignee`。
- **JS 关闭下结构可见**：控件、8 个 option、6 个名册按钮**全部是静态 markup**（§5 A8）。
- **机检断言 A1–A10 逐条可判**（§5），改前/改后各一轮，两轮 `console` / `pageerror` 均为 **0**。
- **一处与既有测试记录的冲突已如实记录**（§7）：本卡按 R-6 新增 4 个 i18n 键 ×2 语言 ⇒ 原型 `MESSAGES` 220 → 224、`data-i18n*` 钩子 612 → 622，而 `test/web/blocks.contract.mjs` 的 `STALE_PROSE_COUNTS` 与 `test/web/i18n.catalogue.mjs` 都**逐字记录**着旧数字，且 `test/**` 是本卡红线。冲突与修法见 §7。

---

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / `getBoundingClientRect` / `getClientRects` / DOM 计数 / 真实指针与键盘），不是 `src/input.css` 某条声明的字面值；两者不一致时实测值胜。
2. 「改前 / 改后」= 同一探针脚本（`workspace/T-20261013-014701-2/verify/r11-probe.mjs`）在原型改动前后各跑一次，同一视口（1512×950）、同一语言族（en 为断言语言；`zh` 另取一帧）、同一主题（light）；原始记录 `verify/probe-before.json` / `verify/probe-after.json`（**均不进仓**）。
3. 「改前」是对 **HEAD 版原型的一份独立副本**实测的（`verify/pristine/`，逐字取自 `git show 4824298:design/prototype/*`，由 `verify/make-pristine.mjs` 生成）—— 同一探针对同一旧版重跑，不是推断，也不是从 diff 反读。
4. 「可见」分两种度量，**必须分清**：`computed display ≠ none` 只对被状态规则**直接写入**的元素成立；对它们的**后代**不成立（父级 `display:none` 不改变子元素自身的 computed `display`）。后代一律用 `getClientRects().length` 判定「是否被绘制」——这是 R9 §2.3 / R10 §1 规则 4 的同一条区分，A8 就写在它上面。
5. 本轮原型 `console` / `pageerror` 均为 **0**（两轮皆是，§6）。
6. 实现侧本轮**未到场实测**（未构建 `web/dist`）；凡涉及实现的位点均标注「实读」。

**共用实测值（原型，1512×950，light，en）**：

| 量 | 改前 | 改后 |
|---|---|---|
| `[data-filters] [data-filter-status]` 元素数 | **0** | **1** |
| `data-filter-status-value`（静止值） | 无该元素 | **`all`** |
| `[data-filter-status-summary]` 元素 / 标签 / 文本 | 无 | **1 / `SUMMARY` / `Status: All`** |
| `[data-filter-status-option]` 计数 | 0 | **8**（`all` + 7） |
| `[data-filter-status-option][data-status-value]` 取值集合 | — | **`{all,backlog,todo,in_progress,in_review,blocked,done,canceled}`** |
| 与 `[data-column][data-status]` / `[data-card][data-status]` 的取值集合之差 | — | **∅（完全相等）** |
| 每个 option 的 8px 圆点数（`all` 行除外） | — | **7/7 行各 1 个** |
| 静止 `aria-pressed="true"` 的 option | — | **`all`（恰 1 个）** |
| `[data-filters] > *` 可见顺序 | Assignee · Priority · Label · Clear · count | **Assignee · Priority · Status · Label · Clear · count** |
| 四个字段控件的 computed `height` | status 无；其余 `30` | **`30` / `30` / `30` / `30`** |
| `[data-agents-presence] [data-agent-assignee]` 计数 / 标签 | **0** | **6 / 全 `BUTTON`** |
| `[data-agent-row="claude"] .td-agent-text` 文本 | `jobs, linus, simons` | `jobs, linus, simons`（**不变**） |
| `[data-dismiss-on-outside]` 成员 | `project` · `label` | **`project` · `label` · `status`** |
| 按下 `[data-agent-assignee="jobs"]` 后的 `[data-view="list"][aria-pressed]` | 无该按钮 | **`true`** |
| 同上：`data-filter-status-value` | — | **`in_progress,in_review`** |
| 同上：`aria-pressed="true"` 的 option | — | **`in_progress` · `in_review`** |
| 同上：trigger 文本 | — | **`Status: In Progress +1`** |
| 同上：`[data-filter-assignee]` 的值 | — | **`all`（名字未被写入）** |
| 同上：`[data-list-rows] [data-list-status]` 取值集合 | — | **`{in_progress, in_review}`**（4 行） |
| 同上：`[data-filter-count]` 文本 | — | **`showing 4 of 12`** |
| 单独按下 `In Review`：`visibleCardStatuses` | — | **`{in_review}`**（2 张） |
| 单独按下 `In Review`：`[data-filter-count]` | — | **`showing 2 of 12`** |
| `[data-filter-clear]` 之后四项筛选值 | — | **`all` / `all` / `all` / `all`** |
| 同上：`[data-filter-count]` | — | **`12 tasks`** |
| 脚本关闭：被绘制的 option / 名册按钮 | 0 / 0 | **8 / 6** |
| 脚本关闭：`[data-card]` 计数 | 18 | 18（**不变**） |
| `data-i18n*` 钩子数（`index.html`） | 612 | **622**（§7） |
| `MESSAGES` 键数（`app.js`） | en 220 / zh 220 | **224 / 224**（§7） |
| `tw.css` bytes | 192724 | **193283**（+559，新增类选择器恰 2 个） |
| `app.js` 里出现类选择器的 jQuery 选择器数 | 15 / 322 | **15 / 332**（新增 10 个选择器全为 `data-*`，A9） |
| 页面 `scrollWidth` / `clientWidth` | 1512 / 1512 | 1512 / 1512（无溢流） |

---

## 2. 逐项契约

### 2.1 项① `B04.status-filter` — 状态筛选（多选下拉，值域对齐一等 status）

**形状**（`index.html`，`design/BLOCKS.md` §B04）：

| | |
|---|---|
| 根 | `<details class="dropdown" data-filter-status data-filter-status-value="all" data-dismiss-on-outside>` |
| 值 | `data-filter-status-value`：`"all"` **或**逗号连接的 7 值子集（如 `"in_progress,in_review"`） |
| 触发 | `<summary class="btn btn-sm td-label-trigger" data-filter-status-summary role="button" aria-haspopup="menu">` → `[data-filter-status-text]` |
| 菜单 | `<ul class="dropdown-content menu td-label-menu td-status-menu">` |
| 选项 | `[data-filter-status-option]` × 8 —— `all` 一行，其后 7 个一等 status 各一行；每行 `data-status-value` + `data-status`（色彩管道）+ 自己的 `aria-pressed` |
| 关合 | `data-dismiss-on-outside`（R9 的轻关闭成员制，第三个成员） |

**语义**：多选 = **OR**；`all` / 空 = 不过滤；与他项筛选之间 = AND。`applyFilters()` 通过一个读点 `statusFilterValues()` 取值（回写则是 `writeStatusFilter()`），与既有 assignee / priority / label 同层。

**值域对齐一等 status（禁魔数）**：取值**只允许** `all` 与 `DESIGN.md` §2.3 的 7 个 key。做法不是把 7 个 key 抄进脚本，而是**把菜单本身当作值域**：`statusOptionValues()` 从 `[data-filter-status-option]` 读出这 7 个 key。因此第 8 个 status = **多一行 markup**，别无他改；脚本也永远说不出文档没有的 status。实测：菜单 7 值 == 7 个列 / 18 张卡的 `data-status` 取值集合（§5 A2′）。

**`in_progress` / `in_review` 口径（明写）**：

| key | 含义 | 为什么在「在途」集合里 |
|---|---|---|
| `in_progress` | 已被认领、正在跑 | 有归属人且未交出手 —— 唯一的「正在做」 |
| `in_review` | 已交出手、等验收 | 产物已存在、还没被接受 —— 「做完了但没了结」 |

这两个是 ② 的预置值，也是本 bar 里最常被连选的两个。其余五个都不在途：`blocked` 已停、`done` / `canceled` 已了结、`backlog` / `todo` 未开工。

**色彩**：每行的圆点是 **8px**（与 `DESIGN.md` §2.3 列头口径同一枚 token），颜色走**既有**管道 —— 行上写 `data-status="<key>"`，`src/input.css` 的 `@layer utilities` 把 `--status-color` 指到 `--color-td-st-*`，`.td-status-dot` 读变量。**没有**新 token、**没有**新色值，`canceled` 仍是非文本层（只做圆点，不做文字色）。

**视觉（无新增）**：trigger 直接复用 `.td-label-trigger`（30px / 12px / 400 / `--color-td-ink` / 14px caret @ right 6px）—— 与 R9 ② 给 label 控件的同一套度量，因此 bar 里四个字段控件实测 computed `height` **全部 30px**（§5 A3）。菜单外壳复用 `.td-label-menu`（`min-width: 200px` / `max-height: 60vh` / 同一描边与投影），只有「一行 = 圆点 + 名字 + `nowrap`」和「选中行取 accent 色」两条是新的。**极简**：无图标、无边框、无徽标。

**i18n**：新增 4 个键（`filters.status`、`filters.status.all`、`filters.statusOption`、`filters.statusMore`），**EN + ZH 两表都加**；7 个状态名复用既有 `status.<key>`。trigger 文本三态：`Status: All` / 单值 `Status: <Label>` / 多值 `Status: <首值> +<n-1>`（如 `Status: In Progress +1`，ZH `状态：进行中 +1`）。**注意**：新增键会牵动 `test/**` 的两处逐字镜像 —— 见 §7，这是本轮唯一一处「规格与红线冲突」，已如实记录。

**与 label 控件的差异（为什么不复用它的单选）**：label 菜单用 `aria-current` 标「当前那一行」，那是**单选**的语义，一个值对一行；状态筛选要表达**集合**，所以**每一行**都写 `aria-pressed`（选中与未选中都写），触发 `all` 时只有 `all` 行为 `true`。

### 2.2 项② `B03 → B08.roster-route` — 名册名字 ⇒ list 视图 + 预置状态

**形状**（`index.html`，`design/BLOCKS.md` §B03）：`.td-agent-text` 由**一整串文本**改为**逐名字 button**，逗号仍是静态文本：

```html
<span class="td-side-name td-agent-text td-mono"><button type="button" class="td-agent-assignee td-mono"
  data-agent-assignee="jobs" data-assignee="jobs" data-assignee-kind="agent">jobs</button>, <button …>linus</button>, …</span>
```

**解耦**：可点击性挂在 `[data-agent-assignee]`（`data-*` 钩子），**不挂 class** —— 一行的 `.td-agent-assignee` 只负责脸，绑定与机检都读钩子。`data-assignee` / `data-assignee-kind` 与名册控件（B22/B25 的 `[data-assignee-option]`）同构，便于实现侧复用同一条取值路径。

**行为（唯一行为，逐字）**：按下 `[data-agent-assignee]` ⇒

1. `setView("list")` —— 切 list 视图，含 R9 ③ 的 `loading` → `data` 时间线；
2. 写 `[data-filter-status]` 的 `data-filter-status-value="in_progress,in_review"`，并把两个对应 `[data-filter-status-option]` 置 `aria-pressed="true"`（其余 `false`）—— 由 `writeStatusFilter()` **一次写入**决定，属性与 8 行的 `aria-pressed` 不会分叉；
3. `applyFilters()` —— list 行随即按**过滤后的卡片**投影（B08 的同一 `renderList()`，W 投影链路一字未改）。

**可达性零成本**：名字是真 `<button>` ⇒ `Enter` / `Space` / `Tab` / `:focus-visible` 全部来自元素本身，无需 `role` / `tabindex` / key handler。**脸 = 它替掉的文本**：无外壳、无描边、无内边距，唯一附加提示是 `cursor: pointer` 与 hover 下划线（`src/input.css` 的 `.td-agent-assignee`）——侧栏首先是读数，一排像工具条的按钮会和旁边的数字打架。

**视觉中性（回归门）**：`.td-agent-text` 的 `textContent` 改前改后**同为 `jobs, linus, simons`**（§1 表、§5 A8′）。≤1023px 的 rail 里整条 `.td-agent-text` 照旧 `display: none`（含按钮）。

**i18n**：**不新增键**。名字是**数据**（athenaeum 里的角色名），与 `[data-assignee-option]` 的名字同级，不进 `MESSAGES`；因此名册一侧不进 §7 的 i18n 冲突。

### 2.3 边界（明写，两条）

| # | 边界 | 理由 |
|---|---|---|
| 边界 1 | **本行为不按该名字收窄 assignee**。按下 `jobs` 之后 `[data-filter-assignee]` 仍是 `all`（§1 表、§5 A4 实测） | 一等 assignee 筛选的值域是 `all \| me \| human \| agent`（B04）—— `me` 是本地人类，`human` / `agent` 是**种类**，**不含具名**。Terry 的需求口径（父 epic Background）只说「筛选状态 in_progress/in_review 的任务」。**若需「按该人名收窄」⇒ 需扩 assignee 值域，属另一需求** |
| 边界 2 | 按下 `jobs` **不按平台**（`claude`）收窄 | 一行 = 一个**平台** + 若干**名字**；需求点的是**名字**。按平台路由是另一个控件，本轮没有要求 |

两条边界都**不是**未决项，而是**裁定**：它们把「路由」与「查询」分开——路由的语义是「看在途的工作」，不是「看 jobs 的工作」。

**另注（时间线）**：`setView("list")` 起 `loading` 并排了 450ms 的 `renderList` 定时器；同一次按下里 `applyFilters()` 会**同步**调一次 `renderList()` 把状态推到 `data`。定时器随后触发时再渲染一次，内容相同。**结果**：骨架不会在屏上停留 450ms，而是当帧即被行替换——这是 R-4 三步顺序的直接后果（第 3 步本来就要求行「随即」出现），不是回归。

---

## 3. 与既有轮次的边界（正交声明，必须显式）

| 轮次 | 它的口径 | 本轮与它的关系 |
|---|---|---|
| **R9 ②（`B04.label-consistency`）** | label 控件 = `.td-label-trigger` 度量 + `.td-select` 扁平，bar 三个控件同高 | **复用，不改**：status 控件挂同一个 `.td-label-trigger`，因此 A3 的「四控同高」是 R9 口径的直接延伸。label 控件本体一字未动 |
| **R9 ①（轻关闭）** | `[data-dismiss-on-outside]` 是**成员制**，一个 handler、一条 `Esc` 分支 | **加入一个成员**：`[data-filter-status]` 带该属性即成成员，**handler 与 `Esc` 分支零改动**（这正是成员制的意义） |
| **R9 ③（`B08/B13.list-two-state`）** | `[data-list][data-list-state]` 的 `loading` ↔ `data` | **复用，不改**：② 的路由经 `setView("list")`，时间线照旧（§2.3 末注） |
| **R10 ①（`B05/B12.board-two-state`）** | board 视图 `data-board-state` 的 `data` ↔ `empty` | **正交**：状态筛选走的是同一条 `applyFilters()`，`shown === 0` 时 board 照旧进 `empty` 态。本轮**不改** `setBoardState()` |
| **R10 ②（`B09` 抽屉自动保存）** | `[data-detail-save]` 四态 | **正交**：与筛选/视图无关 |
| **R10 ③（`B23` 编辑器填充）** | 拉伸链 | **正交** |
| **R5（`B25` 标签控件）** | label 的 roster 控件 | **正交**：本轮不碰 label 的取值路径，只把 label **筛选**控件当作 status 控件的**形状范本** |
| **R8（`B08` list 头 / 标识符截断）** | 六列表头 + 8 字符截断 | **正交**：`renderList()` 一字未改，行模板一字未改 |

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

| # | 项 | 块 | 块内角色 | selector / hook | 期望 | 改前（原型实测） | 差异类型 |
|---|---|---|---|---|---|---|---|
| 1 | ① | B04 | 控件根 | `[data-filters] [data-filter-status]` | 计数 1，带 `data-dismiss-on-outside` | 无该元素 | 缺 |
| 2 | ① | B04 | 值载体 | `data-filter-status-value` | `"all"` **或** 7 值子集（逗号连接，`DESIGN.md` §2.3 序） | 无该属性 | 缺 |
| 3 | ① | B04 | 触发 | `[data-filter-status-summary]` → `[data-filter-status-text]` | `<summary>` 文本 = `Status: All`（单值 = `Status: <Label>`，多值 = `Status: <首值> +<n-1>`） | 无 | 缺 |
| 4 | ① | B04 | 选项 | `[data-filter-status-option]` + `data-status-value` | 计数 **8**；取值集合 == `{all} ∪ DESIGN.md §2.3 的 7 key` | 0 | 缺 |
| 5 | ① | B04 | 值域对齐 | 7 个 option 值 vs `[data-column][data-status]` / `[data-card][data-status]` | **集合相等**（禁魔数的机检口径） | — | **缺失口径**（本轮首次定义） |
| 6 | ① | B04 | 多选态 | 每个 option 的 `aria-pressed` | 8 行**都**写；静止仅 `all` 为 `true` | 无 | 缺 |
| 7 | ① | B04 | 圆点 | 每个非 `all` 行的 `.td-status-dot` | 计数 7（每行 1 个）；`8px`；色 = `var(--status-color)` | 无 | 缺 |
| 8 | ① | B04 | 过滤执行 | `applyFilters()` 读 `statusFilterValues()` | OR 语义、AND 与其他筛选同层；`all`/空不过滤 | 无状态子句 | 缺 |
| 9 | ① | B04 | 复位 | `resetFilters()` | 写回 `all` 并清 8 行 `aria-pressed`；连同 assignee / priority / label | 仅复位前三项 | 缺 |
| 10 | ① | B04 | 轻关闭成员 | `[data-filter-status][data-dismiss-on-outside]` | 计数 1；成员集 = `{project, label, status}` | 成员集 = `{project, label}` | 缺 |
| 11 | ① | B04 | 视觉一致 | `.td-label-trigger` 的 computed `height` 与两个 `<select>` | 四控同为 **30px** | status 控件不存在（三控同 30） | **一致（回归门）** |
| 12 | ① | B04 | bar 顺序 | `[data-filters] > *` 的可见序 | Assignee · Priority · **Status** · Label · Clear · count | Assignee · Priority · Label · Clear · count | 缺 |
| 13 | ② | B03 | 名册名 | `[data-agent-assignee]`（+ `data-assignee` / `data-assignee-kind`） | 计数 6；元素全为 `<button>` | 0（纯文本 `.td-agent-text`） | 缺 |
| 14 | ② | B03 | 路由行为 | 按下 `[data-agent-assignee="jobs"]` | `[data-view="list"][aria-pressed="true"]`；`[data-list]` 无 `hidden` | 无该按钮 | 缺 |
| 15 | ② | B03/B04 | 预置 | 同上 ⇒ `data-filter-status-value` | `"in_progress,in_review"`；两行 `aria-pressed="true"` | — | 缺 |
| 16 | ② | B04 | **边界 1（不得收窄）** | 同上 ⇒ `[data-filter-assignee]` 的值 | **`all`**（名字**不得**写入） | — | **缺失口径** |
| 17 | ② | B08 | 投影 | `[data-list-rows] [data-list-status]` | 取值集合 ⊆ `{in_progress, in_review}`，**非空** | — | 缺（投影链路复用） |
| 18 | ② | B08 | 计数口径 | `[data-filter-count]` | 过滤后 = `showing 4 of 12`（`filters.count.filtered`） | — | **一致（回归门）** |
| 19 | ② | B03 | 视觉中性 | `.td-agent-row[data-agent-row="claude"] .td-agent-text` 的 `textContent` | `jobs, linus, simons`（**不变**） | 同 | **一致（回归门）** |
| 20 | ①+② | B04 | JS 关闭 | 8 option / 6 名册按钮 / `Status: All` 触发文本 | 全部存在且被绘制（静态 markup） | 均不存在 | 缺 |
| 21 | ①+② | — | 页面溢流 | `documentElement.scrollWidth <= clientWidth + 1` | `true`（1512/1512） | `true` | **一致（回归门）** |

### 4.2 匹配项（本轮两项命中的既有块，逐个列明）

| 命中的块 | 命中处 | 本轮对它做什么 | 不做 |
|---|---|---|---|
| **B04 · Filters bar** | 第三个字段控件的位置（Priority 与 Label 之间） | 新增 `[data-filter-status]` 一个 `<details>` + 8 行菜单；`applyFilters()` / `resetFilters()` 各增一个读点与一个写点 | 不动 `[data-filter-assignee]` / `[data-filter-priority]` 两个 `<select>`、不动 `[data-filter-label]` 控件本体、不动 `[data-filter-clear]` 的 handler、不动 `[data-filter-count]` 的文案口径 |
| **B03 · Sidebar** | `.td-agent-text` 的内容 | 一整串文本 → 逐名字 `<button data-agent-assignee>`（逗号留作静态文本）；`src/input.css` 增 `.td-agent-assignee` 一条脸规则 | 不动 `[data-agent-platform]` 徽标、不动 `[data-presence]`、不动行高/间距、不动 ≤1023px 的 rail 隐藏规则、不动 `[data-order-score]` / `[data-order-rank]` / footer 三格 |
| **B08 · List view** | `renderList()` 的投影 | **一行未改**；② 只是让这条投影多一个入口 | 不动行模板、不动 `[data-list-state]` 二态、不动六列表头（R8）、不动行内 6 个单元格钩子 |
| **Floating controls（R9 轻关闭）** | 「成员」一栏 | 成员表加 `[data-detail-status]`…（即 `[data-filter-status]`）一行 | 不动 handler、不动 `Esc` 分支、不动「单开」规则、不动非成员的名单 |
| **i18n hooks** | `MESSAGES` 两表 | **EN + ZH 各加 4 键**（`filters.status` / `.all` / `statusOption` / `statusMore`） | 不动既有键、不动 `%s` 占位约定、不动 `data-i18n-arg` 的「先当 key 解析」约定 |
| **Auxiliary hooks** | 辅助钩子表 | 加 4 行（`data-filter-status-value`、`[data-filter-status-summary]`→`[data-filter-status-text]`、`[data-filter-status-option]`+`data-status-value`、`[data-agent-assignee]`） | 不动既有 25 行 |

### 4.3 负向注记清单

| # | 注记 |
|---|---|
| 1 | 本轮**不**改任何 `web/**` 与 `test/**`（卡的红线：无实现代码）。 |
| 2 | 本轮**不**引入新块；新增**两个钩子族**（状态筛选族、名册按钮），新增**两个类选择器**（`.td-status-menu`、`.td-agent-assignee`）——后者是**样式**，不是契约锚；契约锚一律 `data-*`（§5 A9）。 |
| 3 | 本轮**不**给状态筛选新写一套过滤引擎：读点接在既有 `applyFilters()` 的同层，与 assignee / priority / label 并列。 |
| 4 | 本轮**不**动 `[data-filter-label]` 的单选语义：`aria-current` 仍是 label 的，`aria-pressed` 是 status 的。两套语义**并存不互借**。 |
| 5 | 本轮**不**把「按人名收窄」做进 assignee 筛选（§2.3 边界 1）；它是要扩值域的另一需求。 |
| 6 | 本轮**不**把名册路由做成可键盘触发的自绘控件：它是真 `<button>`，因此不引入 `role` / `tabindex` / key handler。 |
| 7 | 本轮**不**重拍截图集：`design/prototype/README.md` 的截图段已如实记录 R7–R10 的过期范围，R11 追加一条（§7）。 |
| 8 | 本轮**不**在 `design/prototype/**` 里新增 UI 文案的自由串：4 个新键全部走 `MESSAGES`（EN+ZH），状态名复用 `status.<key>`。副作用（`test/**` 镜像）见 §7。 |
| 9 | 本轮**不**改 `DESIGN.md` §2.3 的 7 status 表、token 表、或 `BRAND.md`：新控件的颜色**全部**来自既有变量。 |

---

## 5. 机检断言清单（供实现卡「During」直接落测）

**禁行号锚**；每条 = 「selector → 断言 → 期望」，并给 **改前 / 改后**实测与**机检命令**。

**落点（三类各一处，均属实现卡范围，本轮不改）**

| 类 | 落点 | 判据 |
|---|---|---|
| A · 结构 | `test/web/blocks.contract.mjs`（既有 rule kinds）+ `web/manifests/board-m2.json` 的 `blocks` | 节点计数 / 存在性 / 钩子集 / 属性枚举 |
| B · 计算样式与几何 | `web/manifests/board-m2.json` 的 `style.targets`，由 `ui-align board-m2 --strict` 执行（R6/R8/R9/R10 的 `rN-*` 行即在此） | `getComputedStyle` / `getBoundingClientRect` 的实测值 |
| C · 交互 | 驱动层（`web/scripts/dom-smoke.mjs` 或截图/探针脚本） | 真实事件驱动的状态变化 |

实现卡的 Acceptance 把 B 类绑在 **`ui-align board-m2 --strict` 0 失败**上，所以 B 类每一行都应成为 `board-m2.json` 里的一条 target（按既有 `rN-*` 惯例命名，例如 `r11-status-trigger` / `r11-roster-name`）。

### A. 结构类（`blocks.contract`）

| # | selector | 断言 | 期望 | 改前 | 改后 | 机检命令 |
|---|---|---|---|---|---|---|
| A1 | `[data-filters] [data-filter-status]`；其 `data-filter-status-value`；`[data-filter-status-summary]` 文本 | 存在 / 默认值 / 文本 | 计数 `1`；`"all"`；`Status: All` | 0 / — / — | **1 / `all` / `Status: All`** | `node verify/r11-probe.mjs after` → `checks.initial.statusExists/statusValue/statusSummaryText` |
| A2 | `[data-filter-status-option]` 的 `data-status-value` | 计数 / 取值集合 | `8`；== `{all,backlog,todo,in_progress,in_review,blocked,done,canceled}`（**禁魔数**） | 0 | **8 / 集合相等** | 同上 → `checks.initial.optionCount/optionValues` |
| A2′ | 上述 7 值 vs `[data-column][data-status]` 与 `[data-card][data-status]` | **集合等式** | 三者取值的 7 key 集合**完全相等**（值域对齐一等 status 的机检口径） | — | **相等** | 同上 → `checks.initial.optionValues` ✕ `columnStatuses` / `cardStatuses` |
| A3 | 四个字段控件的 computed `height`（`[data-filter-status] > summary`、`[data-filter-label] > summary`、`[data-filter-assignee]`、`[data-filter-priority]`） | 全相等 | `30px` ×4（R9 口径） | status 无；其余 30 | **30 / 30 / 30 / 30** | 同上 → `checks.initial.heights` |
| A3′ | `[data-filters] > *` 的可见顺序 | 顺序 | Assignee · Priority · **Status** · Label · Clear · count | 无 status | **含 status，位置正确** | 同上 → `checks.initial.barOrder` |
| A6 | `[data-filter-status-option][data-status-value]` 非 `all` 行内的 `.td-status-dot` 计数 | 每行 1 个 | `7` | 0 | **7** | 同上 → `checks.initial.optionDots` |
| A7 | `[data-dismiss-on-outside]` 的成员 | 成员集 | 含 `status`；全集 = `{project, label, status}` | `{project,label}` | **`{project,label,status}`** | 同上 → `checks.initial.dismissMembers` |
| A8′ | `[data-agent-assignee]` 的计数 / 标签 | 计数 / 标签 | `6`，全为 `BUTTON` | 0 | **6 / 全 BUTTON** | 同上 → `checks.initial.agentNames/agentNameTags` |
| A8″ | `[data-agent-row="claude"] .td-agent-text` | `textContent` | `jobs, linus, simons`（**回归门**：拆分不得改文本） | 同 | **同** | 同上 → `checks.initial.agentRowText` |
| A8‴ | `[data-filter-status]` 的 `data-status-value` 是否为合法枚举 | 值域 | `"all"` 或 7 值子集（逗号连接，禁其它串） | — | **`all`**；预置后 `in_progress,in_review` | 同上 → `checks.initial.statusValue` + `checks.afterAgentClick.statusValue` |

### B. 计算样式 / 几何类（`dom-smoke`）

| # | selector | 断言 | 期望 | 改前 | 改后 |
|---|---|---|---|---|---|
| B-1 | `[data-filter-status] > summary`（= `.td-label-trigger`） | `height` / `minHeight` / `fontSize` / `fontWeight` / `color` | `30px` / `30px` / `12px` / `400` / `--color-td-ink` | 无 | **与 label 触发逐项相同** |
| B-2 | 同上的 caret（`.td-icon-sm`） | `width` / `height` / `position` / 右移 | `14px` / `14px` / `absolute` / `right 6px` | 无 | **同 R9 口径** |
| B-3 | 菜单 `.td-status-menu` 的一行（`[data-filter-status-option]`） | `display` / `gap` / `white-space` | `flex` / `8px` / `nowrap` | 无 | **同左** |
| B-4 | 行内圆点 `.td-status-dot` | `width` / `height` / `borderRadius` / `backgroundColor` | `8px` / `8px` / `999px` / 该 status 的 `--color-td-st-*` | 无 | **同左** |
| B-5 | 选中行 `[data-filter-status-option][aria-pressed="true"]` | `color` | `--color-td-accent` | 无 | **同左** |
| B-6 | `[data-agent-assignee]`（名册名） | `padding` / `borderTopWidth` / `backgroundColor` | `0px` / `0px` / `rgba(0, 0, 0, 0)`（无外壳：脸 = 文本） | 无 | **同左** |
| B-7 | `[data-agent-assignee]` 的 `fontFamily` / `fontSize` | 面 | `mono` / `12px`（由 `.td-mono` + `font-size: inherit` 决定，**没有**规则重述字面） | 无 | **同左** |
| B-8 | 页面（1512 / 1240 / 980 / 760 / 500） | `scrollWidth <= clientWidth + 1` | 全 `true` | `true` | **`true`** |

### C. 交互类（驱动层：真实点击 / 键盘 / 真实焦点）

| # | 场景 | 断言 | 期望 | 改前 | 改后 |
|---|---|---|---|---|---|
| C-1 | 初始加载 | `data-filter-status-value` / `[data-filter-status-summary]` 文本 | `all` / `Status: All` | 无 | **同左** |
| C-2 | 单独按下 `In Review` 行 | `data-filter-status-value` / 可见 `[data-card]` 的 `data-status` 集合 / `[data-filter-count]` | `in_review` / `{in_review}`（非空）/ `showing <n> of 12`（**filtered 口径**） | 无 | **`in_review` / `{in_review}` / `showing 2 of 12`** |
| C-3 | 再按下 `In Progress` 行（不按 `all`） | 值 / 可见集合 | `in_progress,in_review`（**OR**，集合增大）/ ⊆ 两值 | 无 | **同左** |
| C-4 | 按下 `all` 行 | 值 / `aria-pressed` | `all` / 仅 `all` 行为 `true` | 无 | **同左** |
| C-5 | 按下 `[data-agent-assignee="jobs"]` | 三件事逐条 | ①`[data-view="list"][aria-pressed="true"]` 且 `[data-list]` 无 `hidden`；②值 `in_progress,in_review` 且两行 `aria-pressed="true"`；③`[data-list-rows] [data-list-status]` ⊆ 两值且非空 | 无 | **全部成立**（4 行 / 集合 = 两值） |
| C-6 | 接 C-5 ⇒ 检查 assignee | `[data-filter-assignee]` 的值 | **`all`**（边界 1：名字不得写入） | — | **`all`** |
| C-7 | 按下 `[data-filter-clear]` | 四项筛选值 / 8 行 `aria-pressed` / `[data-filter-count]` | `all`×4 / 仅 `all` 为 `true` / `12 tasks` | 三项复位 | **四项全复位** |
| C-8 | 按下 `Esc`（状态菜单开着） | `[data-filter-status]` 的 `open` | 无（成员制的既有分支） | 无该菜单 | **关闭** |
| C-9 | 状态菜单开着时按下菜单外 | 同上 | 无 | — | **关闭** |
| C-10 | 语言切 `zh` 后重跑 C-1 / C-5 | 触发文本 / 菜单文案 | `状态：全部` · `状态：进行中 +1`（文案变、**态不变**） | — | **同左** |
| C-11 | 键盘：`Tab` 到名册名 → `Enter` | 同上 C-5 | 成立（真 `<button>`，无需额外 key handler） | — | **同左** |
| C-12 | **脚本关闭**下加载 | `[data-filter-status]` / 8 option 被绘制数 / 6 名册按钮被绘制数 / `[data-filter-status-summary]` 文本 | 8 / 6 / `Status: All` | 0 / 0 / — | **8 / 6 / `Status: All`** |

### C′. 「不得断言」的负向注记

| # | 不得断言 | 原因 |
|---|---|---|
| C′1 | 用 `computed display` 判定 option 是否「可见」 | 菜单未 `open` 时 option 的**父级**可能被 daisyUI 隐藏；后代一律 `getClientRects().length`（§1 规则 4）。A8 就写在它上面。 |
| C′2 | 断言 `data-filter-status-value` 的**内部顺序**由「按下先后」决定 | 写点把子集**规范成菜单序**（`in_progress` 恒在 `in_review` 前），因此同一集合恒为同一字符串。断言查**集合**（拆逗号后排序比较），不查按键序。 |
| C′3 | 断言 `all` 行的圆点数 | `all` 不是 status，**没有**圆点（实测 0）。A6 只数非 `all` 行。 |
| C′4 | 断言 `aria-current` 出现在状态行上 | 状态用 `aria-pressed`（多选）；`aria-current` 是 label 控件的单选口径，两者**并存不互借**（§4.3 注记 4）。 |
| C′5 | 断言状态值与**卡片**的 `data-status` 是同一字符串常量表 | 「禁魔数」的判据是**集合等式**（A2′），不是「脚本里有第二张常量表」——脚本**故意没有**第二张表，它读菜单。 |
| C′6 | 断言按名字之后 `[data-filter-assignee]` 变成该名字 | **边界 1 明确禁止**（§2.3）；值域不含具名，断言它会把一个**未定义**的行为冻结成契约。 |
| C′7 | 断言 `setView("list")` 后骨架**停留** 450ms | §2.3 末注：同帧的 `applyFilters()` 会立即把状态推到 `data`。时间线**存在**（`loading` 可达），但不驻留；断言驻留会锁死一次实现细节。 |
| C′8 | 断言名册名的**具体文字**在多语言下被翻译 | 名字是**数据**（角色名），不进 `MESSAGES`；`zh` 下仍是 `jobs, linus, simons`。 |
| C′9 | 用类名（`.td-status-menu` / `.td-agent-assignee`）作断言锚 | 它们是**样式**不是契约：契约锚一律 `data-*`（§5 A9）。 |

---

## 6. 证据与复跑

**探针**：`workspace/T-20261013-014701-2/verify/r11-probe.mjs`（Playwright / Chromium headless；视口 1512×950；`file://` 打开原型；收集 `console` / `pageerror`；含一次 `javaScriptEnabled: false` 的上下文）。

**原始记录**：`verify/probe-before.json` · `verify/probe-after.json`（**均不进仓**）。

**「改前」是怎么测到的（可复核）**：`verify/pristine/`（`index.html` + `app.js` + `tw.css` + `package.json` + `favicon.svg`，逐字取自 `git show 4824298:design/prototype/*`；`vendor/` 与 `src/` 原样拷贝）由 `verify/make-pristine.mjs` 生成；探针以该副本的 `index.html` 为入参实测。因此「改前」一栏是**同一探针对同一原型的旧版重跑**，不是推断、也不是从 diff 反读。

**复跑命令（逐条）**：

> 这些命令不像上文那样以仓库为根：探针脚本在本卡的工作区里，而**工作区在仓库之外**（运行时由卡片的执行者创建）。先设 `W` 指向那个工作区的 `verify/`，其余命令即可原样粘贴。

```sh
W=<本卡工作区>/verify    # 在仓库之外；按你手上的实际路径填
node "$W/make-pristine.mjs"          # 生成 HEAD 版副本（改前一列的证据）
node "$W/r11-probe.mjs" before       # 改前：A1–A10 逐条打 PASS/FAIL
node "$W/r11-probe.mjs" after        # 改后：同上
node "$W/a9-selectors.mjs"           # A9：选择器脱钩（静态）
node "$W/build-tw.mjs"               # 按 README §Build 重建 tw.css（含字节数与类选择器计数）
node "$W/shots-r11.mjs"              # §6 的帧 + 接触表
node --test test/web/i18n.catalogue.test.mjs test/web/blocks.contract.test.mjs   # §7.1：52 条中 6 条红（记录待同步）
```

**A9（选择器脱钩，静态）实测**：`app.js` 里 jQuery 选择器参数共 **322 → 332**（+10，**全部** `data-*`）；带类名的选择器 **15 → 15（不变）**（其中 `[data-project-switcher] .menu [data-project-new]` 是既有的一处，非本轮引入）；本轮两个入口函数 `statusOptionValues` / `statusFilterValues` / `renderStatusFilter` / `writeStatusFilter` / `closeStatusMenu` 内**类选择器 0 个**。

**tw.css 重建**：`verify/build-tw.mjs`（临时建 `design/prototype/node_modules` 符号链接 → 跑 vendored tailwindcss → 删链接）。`192724 → 193283` bytes（**+559**）；新增的类选择器**恰好两个**（`.td-status-menu`、`.td-agent-assignee`），**无一个**是注释裸词被扫描器误产出的（R10 记下的 `steps`/`blur` 那类膨胀本轮未发生——构建后逐选择器 diff，added = 2 / removed = 0）。

| 画面 | 命名 | 取证什么 |
|---|---|---|
| board 静止 | `r11-board.png` | ① 的静止态：bar 四个控件、`Status: All` |
| 状态菜单开 | `r11-status-menu-open.png` | ① 的 8 行菜单：`all` + 7 个圆点行 |
| 状态菜单开（中） | `r11-status-menu-zh.png` | ① 的双语：`状态：全部` 与 7 个中文状态名 |
| 单独 `In Review` | `r11-status-in-review.png` | ① 的单选路径：卡片只剩 `in_review`，计数进 filtered 口径 |
| 名册路由后 | `r11-agent-jobs-list.png` | ② 的唯一行为：list 视图 + 4 行 + `Status: In Progress +1` |
| 名册路由后（bar 裁切） | `r11-agent-jobs-filters.png` | **边界 1**：`Status: In Progress +1` 与 `Assignee: All` 同帧 |
| 侧栏裁切 | `r11-sidebar.png` | ② 的视觉中性：名字是可点的，但脸与文本无异 |
| 过滤栏裁切 | `r11-filters.png` | ① 的控制高度与顺序 |

**硬门（两轮皆通过）**：`console` = **0**、`pageerror` = **0**。

**实现侧证据口径**：本契约对实现侧的断言一律标「实读」，**未**构建 `web/dist` 实测；实现卡的「During」应把 §5 的 A/B/C 三类落成真正的机检（`test/web/blocks.contract.mjs` · `web/manifests/board-m2.json` + `ui-align board-m2 --strict` · 驱动层），验证卡独立复跑同一张表。

---

## 7. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/DESIGN.md` | **新增 §27「Review round R11 — the status filter, and the roster names that route to it」**：27.1 控件形态与多选值域（含被否决的 `<select>` / `<select multiple>` / 7 个 select / chip 行的理由）、27.2 路由与控制名边界、27.3 被否决备选表、27.4 实测 | **已改** |
| `design/BLOCKS.md` | **B04**：控件表加 `[data-filter-status]` 行 + 状态选择器行 + 「bar 顺序」段 + R11 ① 段（值/值域/语义/行/选中态/触发/`all` 清空）；**B03**：Agents 行改写 + R11 ② 段（名字可点、路由三步、不收窄、视觉中性、rail 隐藏）；**B08**：R11 ② 段（投影链路复用、`renderList()` 未改）；**Floating controls**：成员表加 `[data-filter-status]`；**Auxiliary hooks**：加 4 行 | **已改** |
| `design/prototype/index.html` · `app.js` · `src/input.css`（+ 重建 `tw.css`） | 状态筛选控件（8 行静态标记）+ 名册 6 个按钮；`app.js` 加 5 个函数 + 2 个 handler + 2 处读点 + 4×2 个 i18n 键；`src/input.css` 加 2 条规则块；`tw.css` 按既有流程重建 | **已改 + 已重建** |
| `design/prototype/README.md` | I-map 补 **I19（状态筛选）/ I20（名册路由）** 两行；`app.js` 文件行补 I19/I20；Coverage 表加「Status filter」行；轻关闭段落从「两个 `<details>`」改为「三个」并注明第三个**靠带属性入伙、没加任何分支**；表后补 R11 规则段；截图段追加 **R11 过期声明**；构建段更新 `192724 → 193283 bytes`；Language 行的键对数 `220 → 224` | **已改** |
| `design/fidelity-r9.md` / `-r10.md` / `-r8.md` / `-r7.md` / `-r6.md` | **不改**：本轮与它们正交（§3），旧契约仍成立 | **不改（有意）** |
| `design/BLOCKS.md` 文件头（「252 `data-i18n*` hooks / 198 catalogue keys」） | **不改**：该数字早已被 `test/web/blocks.contract.mjs` 判为 `STALE_PROSE_COUNTS`（实测 612 / 220），且该记录**在 `test/**` 里**、本卡不得碰。本轮把实测推高到 622 / 224，**不动文件头**以免制造第二处不一致 | **不改（有意 + 已记）** |
| `web/**` · `src/**` · `test/**` | **不改**（卡的红线：无实现代码） | **不改（红线）** |
| **i18n 归属（显式判定）** | 本卡**按设计规格 R-6 新增 4 个 i18n 键 ×2 语言**（`filters.status` / `filters.status.all` / `filters.statusOption` / `filters.statusMore`），状态名复用既有 `status.<key>` | **已判定（新增键）** |

### 7.1 i18n 冲突（规格 R-6 × 红线「不改 `test/**`」）

**这是一处真实的冲突，如实记录，不掩盖。**

- **实测**：`design/prototype/index.html` 的 `data-i18n*` 钩子 **612 → 622**（`data-i18n=` 395 → 404，`data-i18n-aria-label=` 47 → 48）；`design/prototype/app.js` 的 `MESSAGES` 键 **en 220 / zh 220 → 224 / 224**。
- **冲突点**：`design/fidelity-r10.md` §7 的 R9 红线写着「本轮**不从** `design/prototype/**` 新增 i18n 键：原型 `MESSAGES` 被 `test/web/i18n.catalogue.mjs` 逐字镜像」。本轮的设计规格 R-6 **明确要求新增这 4 个键**，并写明「EN+ZH 两表都要加」。两处逐字镜像都在 `test/**`：
  - `test/web/blocks.contract.mjs` 的 `STALE_PROSE_COUNTS` 记录 `measured: 612`（hooks）与 `measured: 220`（keys），并由 `blocks.contract.test.mjs` 的「the recorded counts are re-measured against the documents」**实测比对**；
  - `test/web/i18n.catalogue.mjs` 是原型 `MESSAGES` 的**逐字提取**（220 − 17 prototype-only = 203），`i18n.catalogue.test.mjs` 断言 `CATALOGUE` 与「从 `design/prototype/app.js` 重新导出的表」`deepEqual`。
- **后果（已实测，可复核）**：本轮改动后，**host 上** `node --test test/web/i18n.catalogue.test.mjs test/web/blocks.contract.test.mjs` 实测 **52 条：46 pass / 6 fail**，红的恰是下列 6 条（记录的设计意图就是「fails the suite until the record follows」，见 `blocks.contract.test.mjs` 自述）：
  1. `blocks.contract.test.mjs` › counts the data-i18n* seats in design/prototype/index.html —— `622 ≠ 612`，且分部 `404/144/48/8/18 ≠ 395/144/47/8/18`；
  2. `blocks.contract.test.mjs` › counts the MESSAGES keys in design/prototype/app.js —— `224 ≠ 220`；
  3. `i18n.catalogue.test.mjs` › carries the prototype's entries verbatim, minus the prototype-only keys；
  4. `i18n.catalogue.test.mjs` › deep-equals the catalogue re-derived from `design/prototype/app.js`, minus the prototype-only keys；
  5. `i18n.catalogue.test.mjs` › matches the prototype's real key count minus the prototype-only keys —— `203 !== 207`（224 − 17）；
  6. `i18n.catalogue.test.mjs` › covers every translated hook in design/prototype/index.html —— `data-i18n names a key neither shipped nor recorded prototype-only: filters.status.all`。
  同族第 7 条（`blocks.contract.test.mjs` › states the prototype's MESSAGES count in design/prototype/README.md）本轮**已同步**：它比对 README 的 prose 与 `app.js`，`design/prototype/README.md` 的 Language 行已 `220 → 224`，**两侧都是 224**，故该条**不红**（实测通过）。
- **为什么不去修**：修法恰在 `test/**`（把 612→622、220→224、并把 4 个键加进 `test/web/i18n.catalogue.mjs` 与 `web/src/i18n/catalogue.mjs` 两份镜像），而 `test/**` 是本卡红线。**归实现卡 / 验证卡**：实现侧本就需要这 4 个键（新控件的文案），落地时两份镜像与记录必须同一次提交内跟上——这正是「两份手抄镜 + 一份重测记录」这套机制的已知代价。
- **旁注（容器门看不见）**：`.dockerignore` 丢掉 `design/`，所以这三条在 `verify:docker` 的镜像里**会 skip**；它们只在**全量 checkout 的 host `node --test`** 上红。这一点 R10 已记（`design/fidelity-r10.md` §7 同族），本轮沿用。

---

## 8. 口径红线与未覆盖项

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | 状态筛选的值只能是 `all` 或 `DESIGN.md` §2.3 的 7 个 key 组成的逗号连接子集；**不得**出现任何别的字符串，**不得**把 7 个 key 抄成脚本里的第二张常量表（值域读菜单，见 §2.1）。 |
| R2 | 多选语义是 **OR**（命中任一即通过）；`all` / 空 = 不过滤；与其他筛选之间是 **AND**。三者缺一不可。 |
| R3 | 状态控件的值是**集合**，所以「选中态」只能由**每一行**的 `aria-pressed` 表达；**不得**改用 `aria-current`（那是 label 控件的单选口径，两者不互借）。 |
| R4 | 控件的视觉**必须**复用 `.td-label-trigger`（度量）与 `.td-label-menu`（外壳）；**不得**新增 token、色值或第二套高度（R9 ② 的 bar 一致性就是它们同高）。 |
| R5 | 名册路由**不得**按名字收窄 assignee（§2.3 边界 1）；要收窄 ⇒ 先扩 assignee 值域，另开卡。 |
| R6 | 名册路由**不得**顺手按平台收窄（§2.3 边界 2）。 |
| R7 | 名册名**必须**是真 `<button>` + `[data-agent-assignee]` 钩子：**不得**加 `role` / `tabindex` / key handler 自绘，**不得**把可点击性挂在 class 上。 |
| R8 | 控件、8 个 option、6 个名册按钮、`Status: All` 默认触发文本**必须**是静态 markup（JS 关闭下结构可见，A8/C-12）；行为（路由 / 预置 / 过滤）需 JS —— 如实标注。 |
| R9 | 本轮**已**从 `design/prototype/**` 新增 i18n 键（§7.1 记录的冲突）；**后续**任何从原型新增键的卡片，**必须在同一提交**里同步 `test/web/i18n.catalogue.mjs`、`web/src/i18n/catalogue.mjs` 与 `test/web/blocks.contract.mjs` 的 `STALE_PROSE_COUNTS` 记录（或按 §7.1 的先例给出理由）。 |
| R10 | `[data-filter-status]` 的轻关闭**只能**靠 `data-dismiss-on-outside` 入伙；**不得**为它新写 handler 分支或 `Esc` 分支（R9 成员制的意义）。 |

**未覆盖项（明确不在本轮，留给后续裁定）**

| # | 项 | 说明 |
|---|---|---|
| F1 | 「按 assignee **具名**收窄」 | §2.3 边界 1；需扩 assignee 筛选值域（`all\|me\|human\|agent` → 含名字），是**另一需求**。 |
| F2 | 状态筛选的 **URL / 深链** 表达 | 本轮值只在 DOM 属性上；要不要进 URL（可分享的筛选态）属路由设计，未定。 |
| F3 | 名册路由的**返回**路径 | 从 list 回到 board 用既有 `[data-view-toggle]`；是否要「返回原视图」的栈，未定。 |
| F4 | 已选状态的**数量上限** / 全选 | 7 个全选等价于 `all`，本轮未做归一（`all + 7` 与「7 个全选」是两个不同字符串但同一结果）；如需等价化，另开卡。 |
| F5 | `blocked` 是否算「在途」 | 本轮裁定**不算**（§2.1 口径表）。若 Terry 后续要把「在途」扩到含 `blocked`，改的是**预置集合**（`writeStatusFilter([...])` 的实参），不是控件。 |
| F6 | 名册路由的**语气反馈**（toast） | `[data-filter-clear]` 有 `toast.filtersCleared`；路由本轮**不发** toast（无新键、无噪音）。若要反馈，另开卡。 |
| F7 | 截图集重拍 | 见 §4.3 注记 7 / `design/prototype/README.md` 截图段的 R11 声明 —— 过滤栏已连续三轮过期。 |
| F8 | `test/**` 三处镜像的同步 | §7.1；归实现卡 / 验证卡。 |
