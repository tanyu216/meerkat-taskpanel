# UI 保真契约 · R13 — Active agents Assignee 的选中态（assignee 过滤 + 胶囊 + `x` 移除）

> 卡：`T-20261013-033415` · 日期 2026-10-13 · 范围「Terry 需求：点击 Active agents 的 Assignee 时，list 也要按该人名收窄；被点的名字要有已选中高亮，且可点 `x` 移除」。
> **本文件是 R11 ② 的扩展（R11 边界 1）**：`design/fidelity-r11.md` §2.3 边界 1 明写「按该人名收窄 ⇒ 需扩 assignee 值域，属另一需求」；本卡即该需求。R11 ② 的「名册名是一跳路由」原样成立并**被本卡扩写**（路由**同时**是一次收窄）；R11 的其余条文不动。
> 来源：Terry（2026-10-13 03:29）—— Active Agents 点击 Assignee 时右侧 list 只按状态过滤、未把 assignee 本身纳入筛选范围，且被点的 Assignee 缺少选中高亮。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md`。
> 证据口径：每条断言都在**真实浏览器（Chromium headless / Playwright，127.0.0.1 回环静态服务）**里对原型实测；「期望值」即实测值。原始记录见 §6。
> 基线 commit：`3ceac16117349da02bb20c5e0423decc3eeb18e0`（本卡开工时的 HEAD）。
> 关系卡：实现卡（`web/**` 镜像改动）由 Elon 另派；**本卡只产契约与原型改动，不含实现代码**。

## 0. 结论摘要

- 本轮**不新增块**：名册在 **B03**，控件在 **B04**，落点是 **B08**。BLOCKS.md 改 **B03**（名册项结构 + 胶囊）与 **B04**（assignee 域扩展 + 具名 option 按需生成）两处。
- **单一路由变双条件**：按名册名 ⇒ ① `setView("list")` ② `writeStatusFilter(["in_progress","in_review"])` ③ `writeAssigneeFilter("<name>")` ④ 一次 `applyFilters()`。①② 是 R11 既有行为，本次**保留不动**；③ 是本卡新增。两者是 **AND**（「在飞的」∩「这个人的」）。
- **筛选状态的唯一真相仍是控件本身**：`[data-filter-assignee]` 的 `.value`。本卡把它的域从 `all | me | human | agent` 扩为 `all | me | human | agent | <display_name>`；具名项**不在文档里**，由 `renderAssigneeFilter()` 照值**按需生成**，离开具名值时移除。名册胶囊由**同一个值**渲染 ⇒ 胶囊与控件不可能互相矛盾。
- **胶囊**：被选中的 `[data-assignee-item]` 取 `data-assignee-active="true"`，壳（1px 边 + `--color-td-active` 床 + `999px` 药丸圆角，高 20px）在**包裹项**上，名按钮仍是 R11 的平面文字。`x` 是静态 markup、静止时 `hidden`，与名按钮是**兄弟**（嵌套 `<button>` 非法）。
- **`x` 只清 assignee**：不切视图、不动 status/priority/label/search、不开合菜单、不产生 toast；事件 `stopPropagation()`。
- **令牌守恒**：零新自定义属性、零颜色字面量；`tw.css` 重建后 `:root` 声明集合与基线**逐字节相等**（B5，205 条，新增 / 删除 / 改写均为 0），新增 34 行**全部是有意写的规则**（无扫描器误产）。
- **机检 A/B/C 共 45 条逐条可判，45/45 通过**（§5、§6）；改后一轮 `console.error` = 0、`pageerror` = 0。
- **一处真实发现（实测，非声明）**：**`[data-assignee-option]` 这个钩子名已被 B22（R3）占用**——创建弹窗与抽屉的 assignee 菜单各有 7 个裸 `[data-assignee-option]`（共 14 个，值恒为空串，名在 `data-assignee-value`）。所以 spec §4 A3「`[data-assignee-option]` 静止 == 0」**照字面不可判**：该计数在基线就是 14。本契约把该断言**限定到控件内**（`[data-filter-assignee] [data-assignee-option]`），并把它作为 §8 未决 U-1 交回 Jobs 裁定。实现侧另有一条**真实的串扰面**：`app.js` 有一条 `$(document).on("click", "[data-assignee-option]", …)` 的**全局委托**，本卡新增的 `<option>` 会落在它的选择器里（实测无触发：原生 `<option>` 不作为 DOM 点击目标冒泡），但这是实现卡必须知道的一条。
- **i18n：恰一个新键** `assignee.clear`（`x` 的可及名，唯一没有既键可复用的一处）：`MESSAGES` **en 281 → 282 / zh 297 → 298**；`index.html` 的 `data-i18n-aria-label` 座位 **72 → 78**（六个名各一）。
- **宿主全量套件 A/B 实测（改前 3ceac16 / 改后 96d2e97）**：`tests 1838 / skipped 2` 两侧相同；**pass 1830→1829、fail 6→7**。**新增红恰 1 条**：`web/blocks.contract` › `states the prototype's MESSAGES count in design/prototype/README.md` —— 该测试拿 `design/prototype/README.md` 里写死的键数（280）与原型实测比，新键使它变成 281。**spec §7 预期的「镜像红同族扩大」实测未发生**：`web/i18n.catalogue` 的 4 条镜像红在基线就已全红，+1 键**没有新增**它们的条数（两侧同 4 条）。⇒ 新增红唯一且成因明确，但**成因文件的修复点不在本卡写面内**（见 §7 与 §8 U-4）。
- **一处未裁定的代价（实测）**：胶囊比平面文字宽 **20px**（claude 行 143 → 163px），而行的单行宿主只有 **144px** ⇒ 1512 档下该行**尾部 `simons` 被省略号截断 19px**（其余三行不受影响）。spec §3.2 只保护**行高**（实测位移 0），对**行宽**未置一词。本卡**不自选**修法，记入 §8 未决 U-3 并如实上屏（见 §6 帧）。

---

## 1. 口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**证据规则（三腿归因）**：每条断言标明它是 **A 结构**（DOM 计数 / 属性，JS-off 与 JS-on 各跑）、**B 几何·计算样式**（真浏览器 computed）、还是 **C 交互**（真实点击 / 真实键盘 / 真实焦点）。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。断言**只用 data 钩子 + 属性**；**禁止**以 class 名作锚（`.td-assignee-item`、`.td-assignee-clear`、`.td-agent-assignee` 只用于样式）。

---

## 2. 交互契约

### 2.1 名册项结构（`design/prototype/index.html`，静态 markup）

一个名字 = 一个 `[data-assignee-item]` 包裹**两个兄弟 button**：

```html
<span class="td-assignee-item" data-assignee-item="jobs">
  <button type="button" class="td-agent-assignee td-mono"
          data-agent-assignee="jobs" data-assignee="jobs" data-assignee-kind="agent"
          aria-pressed="false">jobs</button>
  <button type="button" class="td-assignee-clear"
          data-assignee-clear="jobs" hidden
          data-i18n-aria-label="assignee.clear" aria-label="Remove assignee filter">✕</button>
</span>
```

| | |
|---|---|
| 项计数 | **6**：`jobs`、`linus`、`simons`（claude 行）、`elon`（openclaw 行）、`turing`（codex 行）、`assistant`（pi 行） |
| 每项内容 | 恰 **1** 个 `[data-agent-assignee]` + 恰 **1** 个 `[data-assignee-clear]`；后者的 `data-assignee-clear` **恒等于**本项的 `data-assignee-item` |
| 逗号 | 仍是**静态文本**，留在项与项之间（同一个文本宿主内）——行继续读作一句 |
| `x` 的静止态 | **静态存在**、`hidden`。JS 关闭 ⇒ 无选中态 ⇒ 清除按钮全隐，结构完整可见 |
| `aria-pressed` | 名按钮携带；静止 `"false"`，选中 `"true"`（由渲染器写，见 2.2 后） |

`[data-assignee-clear]` 的**可及名**由 `data-i18n-aria-label="assignee.clear"` 承担（glyph 自己说不出「移除什么」）。

### 2.2 按下名字（`[data-agent-assignee]`，当前未选中）

按序四步，**不得增减**：

| # | 动作 | 归属 |
|---|---|---|
| ① | `setView("list")` | R11 既有，保留 |
| ② | `writeStatusFilter(["in_progress", "in_review"])` | R11 既有，保留 |
| ③ | `writeAssigneeFilter("<name>")` | **R13 新增** |
| ④ | 一次 `applyFilters()` | 一次滤波，写与渲染在同一遍里 |

③ 与 ② 的结果**同时**生效，语义 = **AND**：卡片必须**既**属于该名、**又**处于在飞状态。R11 的注释「the name itself is written into no filter」由此**不成立**，已在 `app.js` 改写。

### 2.3 按下**已选中**的名字（同一名字再按）= 切换关闭

仅 `writeAssigneeFilter("all")` + `applyFilters()`；**status 不动、视图不动**。语义与点 `x` 等价（`aria-pressed` 按钮的惯常切换语义 + F3 裁定）。

### 2.4 按下 `x`（`[data-assignee-clear]`）

仅 `writeAssigneeFilter("all")` + `applyFilters()`。**必须**：

| 不得 | 说明 |
|---|---|
| 不切视图 | 视图仍是 list |
| 不改 status | `data-filter-status-value` 原值不变 |
| 不改 priority / label / search | 三个控件一个不碰 |
| 不开合任何菜单 | 无 open / close |
| 不产生 toast | `[data-toast-region]` 子节点数不变 |
| `event.stopPropagation()` | 事件停在本按钮，不落到名册项（否则会走到 2.2 的路由） |

### 2.5 切换另一个名字

`writeAssigneeFilter("<另一名>")`：新名 option 就位、旧名 option 移除；名册**恰一个** `data-assignee-active="true"`。

### 2.6 `filters.assignee` 匹配规则（`applyFilters()` 内，唯一处改）

```
if (ok && byAssignee !== "all") {
  ok = byAssignee === "me"      ? attr($card,"assignee") === ME
     : (byAssignee === "human" || byAssignee === "agent")
                                 ? attr($card,"assignee-kind") === byAssignee
     : attr($card,"assignee") === byAssignee;      /* 具名分支：R13 新增 */
}
```

| | |
|---|---|
| 域 | **`all \| me \| human \| agent \| <display_name>`**；末项为本卡新增 |
| `me` | 本地人（`ME`），比 `data-assignee` |
| `human` / `agent` | 两个**类**，比 `data-assignee-kind` |
| `<display_name>` | 比 `data-assignee` —— 卡片**本来就有**的属性（抽屉也读它），控件不引入第二个「这张卡归谁」的来源 |
| 与 status | **AND**（叠乘）；query / priority / label / status-OR 四个子句**一字不动** |
| 空集 | `all`（或空串）⇒ 该子句整体跳过，不做特例 |

### 2.7 重置

`resetFilters()` 已有 `$("[data-filter-assignee]").val("all")` ⇒ **复用**；具名 option 的清除与名册的还原由 `renderAssigneeFilter()` 在同一遍 `applyFilters()` 里自动覆盖，不新增分支。

### 2.8 单一真相与渲染器

- **唯一真相 = 控件本身**：`[data-filter-assignee]` 的 `.value`。
- **名册由值渲染**（镜像 R11 的 `renderStatusFilter()`）：`renderAssigneeFilter()` 读 `.value`，把「名 === 值」的项置 `data-assignee-active="true"`、写其 `aria-pressed="true"`、显其 `x`；其余项还原（`"false"` / `hidden`）。
- **option 也由值调和**：不在值里的具名 option 一律移除。因此**任一路径**改值（按名、点 `x`、人动原生 `<select>`、`resetFilters()`）都收敛到同一遍渲染，胶囊与控件**不可能**互相矛盾，也不可能留下一个「名册没在显示的名字」。
- **至多一个具名 option**：任一时刻 `[data-filter-assignee] [data-assignee-option]` 计数 ∈ {0, 1}。

---

## 3. 视觉规格（数值即结论）

### 3.1 三态

| 态 | 选择器 | 视觉 |
|---|---|---|
| 默认 | `[data-assignee-item]` | R11 原样：**无壳无边框无内衬**，文字即控件；指针 + hover 下划线 |
| hover | 名按钮 `:hover` | 下划线（R11 既有） |
| 选中 | `[data-assignee-item][data-assignee-active="true"]` | **胶囊壳**（3.2）+ 右侧 `x` 显现 |
| focus | `:focus-visible` | 名按钮取 R11 既有焦点环（全局 `:where(…):focus-visible`，实测 `outline-color: rgb(15, 122, 115)` / 2px）；`x` 取 `--color-td-focus`（实测 `rgba(15, 122, 115, 0.35)` / 2px / offset 1）|

### 3.2 胶囊（选中态）

```
[data-assignee-item][data-assignee-active="true"]{
  display:inline-flex; align-items:center; gap:2px;
  height:20px; padding:0 4px 0 6px;
  border:1px solid var(--color-td-line-strong);
  border-radius:999px;
  background:var(--color-td-active);
  color:var(--color-td-ink);
}
```

- **壳在包裹项上，不在名按钮上**：名按钮保持 `.td-agent-assignee td-mono`（11px mono），即「文字即控件」的脸不变、点击目标不变。
- **不改名册行的盒高**：胶囊 20px（+2px 边 = 22px）在一个 **28px** 的行内，实测选中/静止的行高**位移 0**（B3）。
- **宽度不在保护范围**：胶囊比平面文字宽 20px，1512 档该行尾部被省略号截断 —— 见 §0 末条与 §8 U-3。

### 3.3 `x` 清除按钮

```
[data-assignee-clear]{
  display:inline-flex; align-items:center; justify-content:center;
  width:14px; height:14px; padding:0; border:0; border-radius:999px;
  font-size:10px; line-height:1;
  color:var(--color-td-ink-3); background:transparent; cursor:pointer;
}
[data-assignee-clear]:hover{ color:var(--color-td-ink); background:var(--color-td-hover); }
[data-assignee-clear]:focus-visible{ outline:2px solid var(--color-td-focus); outline-offset:1px; }
```

- glyph 是**文本** `✕`：无图片资产、无图标字体、无新 token。
- 静止态的隐藏由 `hidden` 属性承担（preflight 的 `[hidden]{display:none !important}` 胜出），**不**由本段的 `display` 承担。

### 3.4 域扩展的呈现（`[data-filter-assignee]`）

- 4 个**静态** option 不动（`all | me | human | agent`），静止 option 计数 **4**。
- 具名时由 JS 生成**一个** `<option data-assignee-option="<name>" value="<name>">`（文案 = 名）并选中；每选中新名先移除旧具名项；清空时移除全部具名项。
- **原生 `<select>` 不显示胶囊**（胶囊只在名册侧）：控件只承载**值**（F1/F4 裁定）。

### 3.5 令牌守恒

新增样式**零**新自定义属性、**零**颜色字面量；`src/input.css` 的改动 = 在既有名册规则段之后**追加** `.td-assignee-*` 段落（只引用既有 `--color-td-*`）。实测见 B5。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

**新增块：0 个。** 本轮的全部改动落在既有块内。

| 块 | 改点 | 类型 |
|---|---|---|
| **B03 · Sidebar** | 名册一行三处：① 每个名字由裸 `<button>` 变为 `[data-assignee-item]` 包裹「名按钮 + `x` 按钮」的兄弟结构；② 名按钮新增 `data-assignee` / `data-assignee-kind` / `aria-pressed`；③ 新增 `[data-assignee-clear]`（静态 `hidden`）。R11 ② 段补一笔：本卡把「路由」扩为「路由 + 按名收窄」，并说明胶囊只在被选中的项上。 | **改** |
| **B04 · Filters bar** | `[data-filter-assignee]` 的域扩为 `all \| me \| human \| agent \| <display_name>`；具名 option 按需生成 / 移除；该控件的值仍由 `renderAssigneeFilter()` 单一渲染。 | **改** |

### 4.2 匹配项（本轮命中的既有块，逐个列明）

| 块 | 命中的钩子 / 规则 | 本轮如何被命中 | 是否改 |
|---|---|---|---|
| **B03 · Sidebar** | `[data-agents-presence]` → `[data-agent-row]` → `.td-agent-text` → `[data-agent-assignee]` | 名册行的最小单元由「名按钮」变为「项」，胶囊挂在该单元上 | **改**（见 4.1） |
| **B04 · Filters bar** | `[data-filter-assignee]` 的 `value` 域 | 域由 4 值扩为 5 类值；具名项由 JS 写入控件 | **改** |
| **B08 · List view** | `[data-list]` → `[data-list-rows]` → `[data-list-row]` | 名册路由的**落点**：双条件滤波后行集 = 「该名 ∩ 在飞」。B08 本体**一行未改**（行仍由存活卡片派生） | **不改（命中）** |
| **B22 · Assignee / Reporter control (R3)** | `[data-assignee-menu]` → `[data-assignee-option]`（裸，名在 `data-assignee-value`） | **钩子名相撞**：B22 已在两个对话框里各占 7 个 `[data-assignee-option]`（共 14）。本卡的具名 option 与它们**同名但不同物**（本卡的带**值**且只在控件内）。另：`app.js` 有一条 `$(document).on("click", "[data-assignee-option]", …)` 的全局委托落在本卡新增元素的选择器内 | **不改（命中，见 §0 / §8 U-1）** |
| **B15 · Legend** | — | 未命中（本轮不动图例） | 不改 |
| **B02 · Top bar** | `[data-view-toggle] [data-view]` | 未命中：视图切换器**只**有 `board \| list`，本卡不经它切视图 | 不改 |

### 4.3 负向注记清单（本轮**不得**触碰）

| # | 不得 |
|---|---|
| N1 | 不得给筛选条新增第 5 个控件、不得把胶囊搬到 bar 上（F1 裁定：胶囊只在名册侧） |
| N2 | 不得把 assignee 过滤做成**多选**（F2：值域本是标量、需求说「该名」） |
| N3 | 不得在清 assignee 时**连带清 status**（F6 明写：`x` **仅**移除 assignee） |
| N4 | 不得按**平台**收窄（R11 边界 2 保持） |
| N5 | 不得新增 token / 色相 / 图片资产 |
| N6 | 不得改 `web/**`、`src/**`、`test/**`、`design/activity/**`、`design/prototype/README.md` |
| N7 | 不得以 **class 名**作断言锚 |

---

## 5. 机检断言清单（A 结构 / B 几何·计算样式 / C 交互）

断言**只用 data 钩子 + 属性**。A 组在 **JS-off 与 JS-on 两态**各跑一遍；B/C 在 JS-on 跑。脚本 `verify-r13.mjs`（本卡工作区，**不进仓**），原始记录 `verify-r13.json`。

### 5.1 A 组 · 结构

| # | 态 | 断言 | 实测 |
|---|---|---|---|
| A1.1 | JS-on 静止 | `[data-assignee-item]` 计数 == 6 | 6 |
| A1.2 | JS-on 静止 | 每项恰 1 个 `[data-agent-assignee]`、恰 1 个 `[data-assignee-clear]`，且后者的 `data-assignee-clear` == 本项名 | 6/6 |
| A2.1 | JS-on 静止 | 每项无 `data-assignee-active` 或 == `"false"` | 全 `"false"` |
| A2.2 | JS-on 静止 | 每个 `[data-assignee-clear]` 的 `hidden` 存在且**不可见** | 6/6 |
| A3.1 | JS-on 静止 | `[data-filter-assignee]` 的**静态** option（无 `data-assignee-option`）计数 == 4 | 4 |
| A3.2 | JS-on 静止 | `[data-filter-assignee] [data-assignee-option]` == 0 | 0 |
| A3.3 | JS-on 静止 | `[data-filter-assignee]`.value == `"all"` | `all` |
| A4.1 | **JS-off** | `[data-assignee-item]` 计数 == 6 | 6 |
| A4.2 | **JS-off** | 六个名文各自可读且等于其项名 | `jobs,linus,simons,elon,turing,assistant` |
| A4.3 | **JS-off** | 每个 `x` 静态存在、`hidden`、**不绘制** | 6/6 |
| A4.4 | **JS-off** | `[data-filter-assignee] [data-assignee-option]` == 0 且静态 option == 4 | 0 / 4 |
| A4.5 | **JS-off** | 六个 `x` 的 glyph 都是 `✕` | 6/6 |

> **A3.2 / A4.4 的限定**：spec §4 原文写 `[data-assignee-option]`（不限域），**照字面不可判** —— 该计数在基线上就是 **14**（B22 在两个对话框里的 assignee 菜单占位，见 §4.2）。本契约把它限定到控件内，并以反向断言保住 B22 的 14 个座位**一动不动**（实测 14 → 14）。

### 5.2 B 组 · 几何 / 计算样式（真浏览器，computed）

| # | 断言 | 实测 |
|---|---|---|
| B1.1 | 选中项 `border-radius` == `999px` | `999px` |
| B1.2 | 选中项 `border-top-width` == `1px`（≠ 0） | `1px` |
| B1.3 | 选中项 `display` == `inline-flex` | `inline-flex` |
| B2.1 | 静止项 `border-top-width` == `0px`（无壳） | 六项皆 `0px` |
| B3.1 | 四行 `[data-agent-row]` 盒高：选中后 − 静止 ≤ **0** | 位移 `0`（四行全 0） |
| B4.1 | 五档 1512 / 1240 / 980 / 760 / 430：`documentElement.scrollWidth <= clientWidth` | `1512/1512 · 1240/1240 · 980/980 · 760/760 · 430/430` |
| B4.2 | ≤1023：`[data-assignee-item]` 不可见 | 980 / 760 / 430 皆 false |
| B4.3 | >1023：`[data-assignee-item]` 可见 | 1240 / 1512 皆 true |
| B5.1 | `tw.css` 的 `:root` 自定义属性集合与基线**逐字节相等** | 205 条，新增 0 / 删除 0 / 改写 0 |

### 5.3 C 组 · 交互（真实点击 / 真实键盘 / 真实焦点）

| # | 断言 | 实测 |
|---|---|---|
| C1.1 | 点 `[data-agent-assignee="jobs"]` ⇒ `[data-nav-item="list"]` 为 current | `list` |
| C1.2 | 承接 C1：`[data-filter-status]` 的 `data-filter-status-value` == `"in_progress,in_review"` | 同 |
| C1.3 | 承接 C1：`[data-filter-assignee]`.value == `"jobs"` | `jobs` |
| C1.4 | 承接 C1：list 可见行数 == 脚本**独立**算出的「`assignee==jobs` 且 `status ∈ {in_progress,in_review}` 且属当前项目」卡数 | 1 == 1（项目 `MeerkatTaskPanel`，卡 `TD-125`） |
| C2.1 | `[data-assignee-item="jobs"]` 的 `data-assignee-active` == `"true"`，其名按钮 `aria-pressed` == `"true"` | 同 |
| C2.2 | 其 `[data-assignee-clear]` 无 `hidden` 且**可见** | 同 |
| C2.3 | 名册恰 **1** 个 active | 1 |
| C3.1 | 点 `[data-assignee-clear="jobs"]` ⇒ value == `"all"` | `all` |
| C3.2 | 承接 C3：`[data-filter-assignee] [data-assignee-option]` == 0 | 0 |
| C3.3 | 承接 C3：status 值**不变**（仍 `"in_progress,in_review"`） | 同 |
| C3.4 | 承接 C3：jobs 项还原静止（active `"false"`、`x` 复隐） | 同 |
| C3.5 | 承接 C3：视图仍为 list | `list` |
| C4.1 | 在 jobs 选中时点 `linus` ⇒ 名册恰 1 个 active（= linus） | `linus` |
| C4.2 | 承接 C4：`[data-filter-assignee] [data-assignee-option]` 恰 1 个且 == `"linus"` | `["linus"]` |
| C4.3 | 承接 C4：value == `"linus"` | `linus` |
| C5.1 | 再点已选中的 `linus` ⇒ value == `"all"` | `all` |
| C5.2 | 承接 C5：名册 0 active | 0 |
| C5.3 | 承接 C5：status **不变** | `in_progress,in_review` |
| C6.1 | 键盘 Tab 到名按钮：`:focus-visible` 环存在且 `outline-color` **非透明** | `rgb(15, 122, 115)` / 2px solid |
| C6.2 | 该按钮 **Enter** ⇒ C1（value/status/view 三者同时成立） | `jobs` / `in_progress,in_review` / `list` |
| C6.3 | 键盘 Tab 到 `x`：`:focus-visible` 环存在且 `outline-color` **非透明** | `rgba(15, 122, 115, 0.35)` / 2px solid |
| C6.4 | 该按钮 **Enter** ⇒ C3（value 回 `all`、status 不变） | `all` / `in_progress,in_review` |
| C7.1 | 两次点击**不新增** `[data-toast-region]` 子节点 | 0 → 0 |
| C7.2 | 全程 `console.error` == 0 | 0 |
| C7.3 | 全程 `pageerror` == 0 | 0 |

### 5.4 不得断言（负向）

- 不得断言任何 **class 名**（`.td-assignee-item` / `.td-assignee-clear` / `.td-agent-assignee` 只用于样式）。
- 不得用**行号**锚。
- 不得断言原型专用的 `?theme=` / `?lang=` 开关形态。
- **不得**把 `[data-assignee-option]` 当**全局**计数来断言（见 5.1 的限定）。

---

## 6. 实测与复跑

| 腿 | 命令 | 结果 |
|---|---|---|
| 契约机检（A/B/C） | `node verify-r13.mjs`（本卡工作区 `workspace/T-20261013-033415/verify/`，**不进仓**） | **45/45 通过**；原始记录 `verify-r13.json` |
| 令牌守恒 | 同上的 `build-css.mjs`（重建 + 前后 `:root` 快照） | 205 → 205，**守恒**；`tw.css` 204768 → 205633 bytes（**+865**），diff = **+34 行，全为有意规则**，无扫描器误产 |
| 活动视图回归 | `node design/activity/check-activity.mjs` | **132/132 通过** |
| 宿主全量套件 A/B | `node --test`（在基线 `3ceac16` 的独立 worktree 与本 commit 各跑一轮） | `1838 / skipped 2` 两侧相同；**fail 6 → 7**，新增红恰 **1 条**（见下） |
| 截图 | `design/assets/r13/` | 六帧，逐帧见该目录 README |

**实测补充（行宽，记录不作断言）**：claude 行的单行宿主静止 143px、选中 163px（**+20px**），宿主可用 144px ⇒ **溢出 19px**（尾部 `simons` 被省略号截断）；elon / turing / assistant 三行静止=选中，**0 位移**。见 §8 U-3。

---

## 7. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/fidelity-r13.md` | 本文件：口径 + 交互/视觉契约 + **full block list（含匹配项）** + 逐条机检断言 + 实测 | **新增** |
| `design/BLOCKS.md` | **B03**：名册段补 R13（项结构 / 胶囊 / `x` / 与 R11 ② 的取代关系）；**B04**：assignee 控件行与段落补 R13（域扩 + 具名 option 按需生成 + 单一渲染器） | **已改** |
| `design/DESIGN.md` | **新增 §31**（§31.1 交互含义 / §31.2 单一真相与域扩展 / §31.3 胶囊与令牌守恒 / §31.4 叠加与 `x` 语义 / §31.5 实测 / §31.6 被否决备选 ≥5） | **已改** |
| `design/prototype/index.html` | 名册段：六个名 → 六个 `[data-assignee-item]`（兄弟双按钮）+ R13 注释 | **已改** |
| `design/prototype/app.js` | `MESSAGES` 恰 +1 键（`assignee.clear`，en/zh）；新增 `ASSIGNEE_STATIC_VALUES` / `assigneeFilterValue()` / `renderAssigneeFilter()` / `writeAssigneeFilter()`；`applyFilters()` 增加渲染调用 + assignee 具名分支；名册点击处理器改四步；新增 `[data-assignee-clear]` 处理器；R11 的「不写人名」注释改写 | **已改** |
| `design/prototype/src/input.css` | 名册规则段后追加 `.td-assignee-*` 段（胶囊 / `x` / hover / focus-visible） | **已改** |
| `design/prototype/tw.css` | 按 `README.md` §Build 重建（`204768 → 205633`，+34 行） | **已重建** |
| `design/assets/r13/**` | 六帧 + README | **新增** |
| `design/fidelity-r11.md` | **不改**：R11 条文原样成立，取代关系写在本文件表头与 §4.1（同一张卡的另一半口径未被撤） | **不改（有意 + 已记）** |
| `design/prototype/README.md` | **不改（写面闭集**：spec §0 未列此文件）。⇒ 其 Build 段的 `tw.css` 字节数（`204768`）与 I-map / Coverage 表现在**落后一轮**，见 §8 U-4 | **不改（闭集外，已记）** |
| `design/fidelity-r9.md` / `-r10.md` / `-r12.md` / `-r12-supplement.md` | **不改**：与本轮正交 | **不改（有意）** |
| `design/activity/**` | **不改**（spec 禁改；回归仍 132/132） | **不改（红线）** |
| `web/**` · `src/**` · `test/**` | **不改**（卡的红线：无实现代码）；实现侧实读记录：`web/src/components/shell/Sidebar.vue` 的 `[data-agents-presence]` 区目前是纯文本名，`web/src/stores/board.js` 的 `filters.assignee` 域目前是 `all\|me\|human\|agent`（具名传参会**不过滤任何行**）——两条都归实现卡 | **不改（红线）** |
| **i18n 归属（显式判定）** | **恰 +1 键**：`assignee.clear`（`x` 的可及名）。`MESSAGES` en 281 → 282 / zh 297 → 298；`index.html` 的 `data-i18n-aria-label` 座位 72 → 78。**无**其他键、**无**其他类别座位变化 | **已判定（+1，记账见 §0 与 §8 U-2）** |

---

## 8. 红线与未决

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | 筛选状态的唯一真相是 **`[data-filter-assignee]` 的 `.value`**；**不得**另立一个 JS 变量、`localStorage` 或第二处 DOM 值来表达它。 |
| R2 | 名册的胶囊状态**必须由值渲染**（`renderAssigneeFilter()`）；**不得**让按下名字时只改名册、不改控件。 |
| R3 | 具名 option **至多一个**且只在 `[data-filter-assignee]` **之内**；**不得**把具名项放到别的控件或文档别处。 |
| R4 | `x` **只**清 assignee：**不得**连带清 status / priority / label / search，**不得**切视图，**不得**发 toast。 |
| R5 | 叠加语义是 **AND**；**不得**把双条件改成 OR，也**不得**让 status 子句在具名时失效。 |
| R6 | 名按钮与 `x` **必须是兄弟**（嵌套 `<button>` 非法）；`x` **必须**静态存在并在静止时 `hidden`（JS-off 结构完整的唯一来源）。 |
| R7 | 胶囊的壳在**包裹项**上，**不得**搬到名按钮上；名按钮的脸保持 R11 的「文字即控件」。 |
| R8 | 行**高**不得因选中而变（实测位移必须 ≤ 0）。 |
| R9 | 零新 token / 色相 / 图片；`tw.css` 的 `:root` 集合**必须**与基线逐字节相等。 |
| R10 | 断言**只用 data 钩子 + 属性**；**不得**以 class 名或行号作锚。 |
| R11 | `[data-assignee-option]` 在文档里**不是**本卡独占的钩子（B22 已占 14 个座位）——凡读它**必须**限定到 `[data-filter-assignee]` 或 `[data-assignee-menu]` 内，**不得**全局读。 |
| R12 | `design/fidelity-r11.md` **保持原样**；凡与之冲突的条文，以本文件表头与 §4.1 的取代表为准，**不得**回改 R11 文档。 |

**未决项（明确不在本轮，留给 Jobs / Elon 裁）**

| # | 项 | 说明与实测 |
|---|---|---|
| **U-1** | **`[data-assignee-option]` 钩子名与 B22 相撞** | spec §3.4 指定具名 option 用 `[data-assignee-option="<name>"]`，但该名**已被 B22（R3）占用**：两个对话框的 assignee 菜单各 7 个裸 `[data-assignee-option]`（14 个，值恒空串），并有一条 `$(document).on("click", "[data-assignee-option]", …)` 的**全局委托**。**本轮照 spec 落地**（不自选改名），并把机检限定到控件内（§5.1）。**建议**实现卡的读点一律限定作用域；若 Jobs 要彻底消歧，可改名（如 `data-assignee-filter-option`）——**这是口径裁定，不在 lane 权限内**。 |
| **U-2** | **i18n 新键的镜像红** | 复用键优先已试：既有 `filters.clear`（"Clear"）、`combo.clear`、`noResults.clear`、`access.cidr.remove` 无一能读作「Remove assignee filter」⇒ 取 spec §8 U-1 的建议，**恰加一个** `assignee.clear`。座位 +1（`MESSAGES` +1，`index.html` aria-label 座 +6）⇒ `test/web/{i18n.catalogue,blocks.contract}.test.mjs` 的既有逐字镜像红**同族扩大**（与 R11 D1 同源），归实现卡；本卡按 §7 明令**不修 `test/**`**。 |
| **U-3** | **胶囊的宽度代价（唯一一处未裁定）** | 胶囊宽 20px（claude 行 143 → 163px），行宿主 144px ⇒ 1512 档尾部 `simons` 被省略号截断 **19px**（其余三行 0 位移）。spec §3.2 只保护**行高**，对**行宽**未置一词。可能的收尾（**未选**，留给 Jobs）：收窄胶囊内衬 / 让 `x` 覆盖在名字上（绝对定位，不吃宽度）/ 加宽侧栏 / 接受尾部截断。**本卡按 spec 的数值原样落地，不自行改向。** |
| **U-4** | **`design/prototype/README.md` 落后一轮（本卡唯一一条新增红）** | 该文件在 spec §0 的**写面闭集之外**（「多一处都不行」），本卡**未改**。它因此落后两处：① Build 段的 `tw.css` 字节数写 `204768`，本轮实测 `205633`；② **它写死的 MESSAGES 键数 280 与新键后的 281 不符** —— 这正是宿主全量套件里**唯一**的新增红（`web/blocks.contract` › `states the prototype's MESSAGES count in design/prototype/README.md`）。修复点是该文件里的两处数字（键数 `280 → 281`；字节数 `204768 → 205633`），**不在本卡写面内**，故**未改**并交回 Jobs / 集成方。I-map / Coverage 表同样未记 R13 的两条交互。 |
| **U-5** | **实现侧的两处实读（归实现卡）** | ① `web/src/components/shell/Sidebar.vue` 的名册区目前是纯 `<span data-side-name>` 文本（`grep -rn 'data-agent-assignee' web/src` = NONE）⇒ 连 R11 的路由都未落地；② `web/src/stores/board.js` 的 `visibleTasks` 对具名值**三个分支全不匹配 ⇒ 不过滤任何行**，须新增具名分支（与 §2.6 同构）。两条都**不在本卡写面**。 |
