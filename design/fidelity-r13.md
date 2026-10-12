# UI 保真契约 · R13 — Active agents Assignee 的选中态（assignee 过滤 + 胶囊 + `x` 移除）

> 卡：`T-20261013-033415` · 日期 2026-10-13 · 范围「Terry 需求：点击 Active agents 的 Assignee 时，list 也要按该人名收窄；被点的名字要有已选中高亮，且可点 `x` 移除」。
> **本文件是 R11 ② 的扩展（R11 边界 1）**：`design/fidelity-r11.md` §2.3 边界 1 明写「按该人名收窄 ⇒ 需扩 assignee 值域，属另一需求」；本卡即该需求。R11 ② 的「名册名是一跳路由」原样成立并**被本卡扩写**（路由**同时**是一次收窄）；R11 的其余条文不动。
> 来源：Terry（2026-10-13 03:29）—— Active Agents 点击 Assignee 时右侧 list 只按状态过滤、未把 assignee 本身纳入筛选范围，且被点的 Assignee 缺少选中高亮。
> **本版（seg2）是 seg1 的修订版**：seg1 交付并集成 main（本文件基线 commit `0b95188`）；Jobs 用真浏览器读数复核后三条裁定照改 —— ① 选中胶囊改**宽度中性**、`x` 从名册移入 **B04**；② 具名 option 钩子改名 `[data-assignee-filter-option]`（原名与 B22 的 14 座相撞）；③ 补齐 `design/prototype/README.md`。逐条见 §9「seg2 修订索引」。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md` + `design/prototype/README.md`。
> 证据口径：每条断言都在**真实浏览器（Chromium headless / Playwright，127.0.0.1 回环静态服务）**里对原型实测；「期望值」即实测值。原始记录见 §6。
> 基线 commit：`0b9518888facf7a61c48b5533d68ff5d5ba58f9f`（本段开工时的 HEAD = seg1 的提交）。
> 关系卡：实现卡（`web/**` 镜像改动）由 Elon 另派；**本卡只产契约与原型改动，不含实现代码**。

## 0. 结论摘要

- 本轮**不新增块**：名册在 **B03**，控件与清除按钮在 **B04**，落点是 **B08**。BLOCKS.md 改 **B03**（名册项结构 + 胶囊；**不再含 `x`**）与 **B04**（assignee 域扩展 + 具名 option 按需生成 + **新增 `[data-assignee-clear]`**）两处。
- **单一路由变双条件**：按名册名 ⇒ ① `setView("list")` ② `writeStatusFilter(["in_progress","in_review"])` ③ `writeAssigneeFilter("<name>")` ④ 一次 `applyFilters()`。①② 是 R11 既有行为，本次**保留不动**；③ 是本卡新增。两者是 **AND**（「在飞的」∩「这个人的」）。
- **筛选状态的唯一真相仍是控件本身**：`[data-filter-assignee]` 的 `.value`。本卡把它的域从 `all | me | human | agent` 扩为 `all | me | human | agent | <display_name>`；具名项**不在文档里**，由 `renderAssigneeFilter()` 照值**按需生成**，离开具名值时移除。名册胶囊由**同一个值**渲染 ⇒ 胶囊与控件不可能互相矛盾。
- **胶囊（seg2 落点）**：被选中的 `[data-assignee-item]` 取 `data-assignee-active="true"`，样式 = `padding: 0 6px` + `margin-inline: -6px`（**等量抵消 ⇒ 净增宽 0**）+ `border-radius: 999px` + `background: var(--color-td-accent-soft)`；其内的 `[data-agent-assignee]` 取 `color: var(--color-td-accent)`。壳在**包裹项**上，名按钮仍是 R11 的平面文字，非选中的项**无壳**。
- **`x`（seg2 落点）**：**一个** `[data-assignee-clear]`，是 `[data-filter-assignee]` 的**紧邻兄弟**（B04 内），静态 markup、静止 `hidden`，**仅当控件值是一个具名值时显现**。它**只清 assignee**：不切视图、不动 status/priority/label/search、不开合菜单、不产生 toast；事件 `stopPropagation()`。
- **宽度中性是硬指标**：胶囊在**任何档位**都不得使名册行的单行文本省略（`clippedPx == 0`）。实测五档 1512 / 1240 / 980 / 760 / 430 全 **0**（B6），行高位移仍为 **0**（B3）。
- **钩子改名（seg2）**：具名 option 用 **`[data-assignee-filter-option]`**，**不是** `[data-assignee-option]` —— 后者已被 B22（R3）占用（两个对话框的 assignee 菜单共 **14** 个裸座位），且 `app.js` 有一条 `$(document).on("click", "[data-assignee-option]", …)` 的**全局委托**；改名后该委托**不再命中**本卡任何元素，B22 的 14 座实测不变（A 组 R2.1）。
- **令牌守恒**：零新自定义属性、零颜色字面量；`tw.css` 重建后 `:root` 声明集合与基线**逐字节相等**（B5，205 条，新增 / 删除 / 改写均为 0）。`tw.css` 本轮 205633 → **205606** bytes（**−27**），diff = **+6 / −8 行，全为有意规则**，无扫描器误产。
- **机检 A/B/C 共 55 条逐条可判，55/55 通过**（§5、§6）；`console.error` = 0、`pageerror` = 0。
- **文档补齐（seg2）**：`design/prototype/README.md` 写面已纳入 ⇒ 其 MESSAGES 键数 `280 → 281`、`tw.css` 字节 `204768 → 205606`、I-map 补 `I20`（改写）与 `I22`（新增）、Coverage 表补 R13 三行。**该文件此前是 seg1 唯一的宿主新增红，现已归零**（§6 的 A/B 表）。
- **一处实测代价（seg2 新增，如实记账，未自选修法）**：宽度中性的代价是**床越界**。宿主 `.td-side-name` 自带 `overflow: hidden`（R8 的省略号就是在它身上做的），所以胶囊那 6px 的左侧外扩**在行首名字上被宿主裁掉**：实测 `jobs` / `elon` / `turing` / `assistant`（每行第一个名）左帽被裁 **6px**，`linus` / `simons`（行中、行尾）**完整**。R-1 只要求「`clippedPx == 0`（不省略名字）」——该指标**达标**；床的左帽被裁是同一规则的镜像面，R-1 未置一词。见 §8 U-6。

---

## 1. 口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**证据规则（三腿归因）**：每条断言标明它是 **A 结构**（DOM 计数 / 属性，JS-off 与 JS-on 各跑）、**B 几何·计算样式**（真浏览器 computed）、还是 **C 交互**（真实点击 / 真实键盘 / 真实焦点）。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。断言**只用 data 钩子 + 属性**；**禁止**以 class 名作锚（`.td-assignee-item`、`.td-assignee-clear`、`.td-agent-assignee` 只用于样式）。

---

## 2. 交互契约

### 2.1 名册项结构（`design/prototype/index.html`，静态 markup）

一个名字 = 一个 `[data-assignee-item]` 包裹**恰好一个**名按钮（**seg2：项内不再有清除按钮**）：

```html
<span class="td-assignee-item" data-assignee-item="jobs">
  <button type="button" class="td-agent-assignee td-mono"
          data-agent-assignee="jobs" data-assignee="jobs" data-assignee-kind="agent"
          aria-pressed="false">jobs</button>
</span>
```

| | |
|---|---|
| 项计数 | **6**：`jobs`、`linus`、`simons`（claude 行）、`elon`（openclaw 行）、`turing`（codex 行）、`assistant`（pi 行） |
| 每项内容 | 恰 **1** 个 `[data-agent-assignee]`，**0** 个 `[data-assignee-clear]`（seg2） |
| 逗号 | 仍是**静态文本**，留在项与项之间（同一个文本宿主内）——行继续读作一句 |
| `aria-pressed` | 名按钮携带；静止 `"false"`，选中 `"true"`（由渲染器写，见 2.8） |

**为什么项内没有 `x`（seg2 的裁定理由，记录在案）**：名册行的单行宿主只有 **143 / 144px**（余量 1px），胶囊的内衬已是 12px；再放一个 14px 的按钮，结构上不可能不截断一个名字。R-1 因此把清除按钮移到 **B04**，紧邻它真正清除的那个控件。

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

### 2.4 按下 `x`（`[data-assignee-clear]`，**B04 内、`[data-filter-assignee]` 的紧邻兄弟**）

```html
<button type="button" class="td-assignee-clear" data-assignee-clear hidden
        data-i18n-aria-label="assignee.clear" aria-label="Remove assignee filter">✕</button>
```

仅 `writeAssigneeFilter("all")` + `applyFilters()`。**必须**：

| 不得 | 说明 |
|---|---|
| 不切视图 | 视图仍是 list |
| 不改 status | `data-filter-status-value` 原值不变 |
| 不改 priority / label / search | 三个控件一个不碰 |
| 不开合任何菜单 | 无 open / close |
| 不产生 toast | `[data-toast-region]` 子节点数不变 |
| `event.stopPropagation()` | 事件停在本按钮，不落到宿主/名册（否则会走到 2.2 的路由） |

**显现规则（唯一）**：`renderAssigneeFilter()` 里 `$("[data-assignee-clear]").prop("hidden", named === null)` —— 即**只有控件值是一个具名值**时才显现。`all` / `me` / `human` / `agent` 四值**都不显现**：`all` 是未筛态（控件自己的第一行就是出口），三个「类」是控件的行，都不需要第二个出口。

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

`resetFilters()` 已有 `$("[data-filter-assignee]").val("all")` ⇒ **复用**；具名 option 的清除、名册的还原与 `x` 的复隐由 `renderAssigneeFilter()` 在同一遍 `applyFilters()` 里自动覆盖，不新增分支。

### 2.8 单一真相与渲染器

- **唯一真相 = 控件本身**：`[data-filter-assignee]` 的 `.value`。
- **名册与 `x` 由值渲染**（镜像 R11 的 `renderStatusFilter()`）：`renderAssigneeFilter()` 读 `.value`，把「名 === 值」的项置 `data-assignee-active="true"` 并写其名按钮 `aria-pressed="true"`；其余项还原 `"false"`。**同一次调用**里把唯一的 `[data-assignee-clear]` 按「值是否具名」显隐。
- **option 也由值调和**：不在值里的具名 `[data-assignee-filter-option]` 一律移除。因此**任一路径**改值（按名、点 `x`、人动原生 `<select>`、`resetFilters()`）都收敛到同一遍渲染，胶囊、`x` 与控件**不可能**互相矛盾，也不可能留下一个「名册没在显示的名字」。
- **至多一个具名 option**：任一时刻 `[data-filter-assignee] [data-assignee-filter-option]` 计数 ∈ {0, 1}。

### 2.9 钩子命名（seg2 修订 · R-2）

| 钩子 | 归属 | 说明 |
|---|---|---|
| `[data-assignee-filter-option]` | **本卡（B04）** | 控件里按需生成的**具名** option；`value` = 名、文案 = 名 |
| `[data-assignee-option]` | **B22（不改）** | 两个对话框 assignee 菜单的 14 个**裸**座位（名在 `data-assignee-value`）。文档级委托 `$(document).on("click", "[data-assignee-option]", …)` 是它的读点 |

改名后：B22 的 14 座**实测不变**（A 组 R2.1）；该全局委托的选区里**不再有**本卡任何元素（本卡的具名 option 与它不同名）。**后续卡片必须遵守**：`[data-assignee-option]` 的读点一律是 B22 的，**不得**把它当作本卡的钩子读。

---

## 3. 视觉规格（数值即结论）

### 3.1 三态

| 态 | 选择器 | 视觉 |
|---|---|---|
| 默认 | `[data-assignee-item]` | R11 原样：**无壳无边框无内衬**，文字即控件；指针 + hover 下划线 |
| hover | 名按钮 `:hover` | 下划线（R11 既有）；选中项上取 `--color-td-accent`（胶囊规则的选择器权重更高，胜过 `.td-agent-assignee:hover`） |
| 选中 | `[data-assignee-item][data-assignee-active="true"]` | **宽度中性胶囊床**（3.2）；名取 `--color-td-accent` |
| focus | `:focus-visible` | 名按钮取 R11 既有焦点环（实测 `outline-color: rgb(15, 122, 115)` / 2px / solid）；`x` 取 `--color-td-focus`（实测 `rgba(15, 122, 115, 0.35)` / 2px / offset 1） |

### 3.2 胶囊（选中态 · **宽度中性**）

```
[data-assignee-item][data-assignee-active="true"]{
  padding: 0 6px;                 /* +12px 盒宽 */
  margin-inline: -6px;            /* −12px 行进：净增宽 0 */
  border-radius: 999px;           /* 药丸 */
  background: var(--color-td-accent-soft);
}
[data-assignee-item][data-assignee-active="true"] [data-agent-assignee]{
  color: var(--color-td-accent);
}
```

- **零净增宽是硬指标**：`padding` 与 `margin-inline` 大小相等、方向相反 ⇒ 该项在**行内的推进量**与静止时**逐像素相同**，行尾名字不再被省略号截断。实测五档 `clippedPx == 0`（B6）。
- **床越界，文字不动**：盒的**边框盒**因此向左右各外扩 6px（盖住左边的空隙/右边的逗号），而**文字起点仍在原位** —— 名字不位移。
- **无边框、无固定高**：壳只由「床 + 圆角」构成（seg2 删去了 1px 边与 20px 高）。静止项 `border-top-width == 0px`，选中项同样 `0px`（B1.6 / B2.1）。
- **壳在包裹项上，不在名按钮上**：名按钮保持 `.td-agent-assignee td-mono`（11px mono），即「文字即控件」的脸不变、点击目标不变。
- **不改名册行的盒高**：项仍是行内盒，实测选中/静止的 `[data-agent-row]` 盒高**位移 0**（B3）。

### 3.3 `x` 清除按钮（**B04 内，assignee 控件的紧邻兄弟**）

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
- 可及名由 `data-i18n-aria-label="assignee.clear"` 承担（glyph 自己说不出「移除什么」）。

### 3.4 域扩展的呈现（`[data-filter-assignee]`）

- 4 个**静态** option 不动（`all | me | human | agent`），静止 option 计数 **4**。
- 具名时由 JS 生成**一个** `<option data-assignee-filter-option="<name>" value="<name>">`（文案 = 名）并选中；每选中新名先移除旧具名项；清空时移除全部具名项。
- **原生 `<select>` 不显示胶囊**（胶囊只在名册侧）：控件只承载**值**（F1/F4 裁定）。

### 3.5 令牌守恒

新增样式**零**新自定义属性、**零**颜色字面量。本轮引用的两个颜色都是文档**既有** token：`--color-td-accent-soft`（床）与 `--color-td-accent`（名）—— 已由 §1「不新增 token / 色相」的约束确认，并由 B5 的 `:root` 集合守恒**实测**背书。

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

**新增块：0 个。** 本轮的全部改动落在既有块内。

| 块 | 改点 | 类型 |
|---|---|---|
| **B03 · Sidebar** | 名册一行两处：① 每个名字由裸 `<button>` 变为 `[data-assignee-item]` **只包裹一个名按钮**（**seg2：项内不再有 `x`**）；② 名按钮新增 `data-assignee` / `data-assignee-kind` / `aria-pressed`。R11 ② 段补一笔：本卡把「路由」扩为「路由 + 按名收窄」，并说明胶囊只在被选中的项上、且宽度中性。 | **改** |
| **B04 · Filters bar** | ① `[data-filter-assignee]` 的域扩为 `all \| me \| human \| agent \| <display_name>`；具名 option（`[data-assignee-filter-option]`）按需生成 / 移除；② **新增 `[data-assignee-clear]`**，作为 assignee 控件的紧邻兄弟，值具名时显现。该控件的值仍由 `renderAssigneeFilter()` 单一渲染。 | **改** |

### 4.2 匹配项（本轮命中的既有块，逐个列明）

| 块 | 命中的钩子 / 规则 | 本轮如何被命中 | 是否改 |
|---|---|---|---|
| **B03 · Sidebar** | `[data-agents-presence]` → `[data-agent-row]` → `.td-agent-text` → `[data-agent-assignee]` | 名册行的最小单元由「名按钮」变为「项」，胶囊挂在该单元上 | **改**（见 4.1） |
| **B04 · Filters bar** | `[data-filter-assignee]` 的 `value` 域；`[data-filters]` 的成员集合 | 域由 4 值扩为 5 类值；具名项由 JS 写入控件；**新增一个成员**（清除按钮）挂在 assignee 控件之侧 | **改** |
| **B08 · List view** | `[data-list]` → `[data-list-rows]` → `[data-list-row]` | 名册路由的**落点**：双条件滤波后行集 = 「该名 ∩ 在飞」。B08 本体**一行未改**（行仍由存活卡片派生） | **不改（命中）** |
| **B22 · Assignee / Reporter control (R3)** | `[data-assignee-menu]` → `[data-assignee-option]`（裸，名在 `data-assignee-value`） | **曾钩子名相撞，seg2 已解**：seg1 的具名 option 与 B22 的 14 座同名；本段改名为 `[data-assignee-filter-option]`，B22 的选区与全局委托**均不含**本卡元素（A 组 R2.1 实测 14 → 14） | **不改（命中，见 §2.9）** |
| **B15 · Legend** | — | 未命中（本轮不动图例） | 不改 |
| **B02 · Top bar** | `[data-view-toggle] [data-view]` | 未命中：视图切换器**只**有 `board \| list`，本卡不经它切视图（路由走 `setView()`） | 不改 |

### 4.3 负向注记清单（本轮**不得**触碰）

| # | 不得 |
|---|---|
| N1 | 不得把胶囊搬出**名册项**（F1 裁定：胶囊只在名册侧；控件只承载值） |
| N2 | 不得把 assignee 过滤做成**多选**（F2：值域本是标量、需求说「该名」） |
| N3 | 不得在清 assignee 时**连带清 status**（F6 明写：`x` **仅**移除 assignee） |
| N4 | 不得按**平台**收窄（R11 边界 2 保持） |
| N5 | 不得新增 token / 色相 / 图片资产 |
| N6 | 不得改 `web/**`、`src/**`、`test/**`、`design/activity/**` |
| N7 | 不得以 **class 名**作断言锚 |
| N8 | **不得**给名册项加第二个按钮（seg2 的裁定：行宽无余量，任何额外按钮只能截断名字） |
| N9 | **不得**把 `[data-assignee-filter-option]` 改回 `[data-assignee-option]`（B22 的 14 座 + 文档级委托，见 §2.9） |

---

## 5. 机检断言清单（A 结构 / B 几何·计算样式 / C 交互）

断言**只用 data 钩子 + 属性**。A 组在 **JS-off 与 JS-on 两态**各跑一遍；B/C 在 JS-on 跑。脚本 `verify-r13.mjs`（本卡工作区，**不进仓**），原始记录 `verify-r13.json`。

### 5.1 A 组 · 结构

| # | 态 | 断言 | 实测 |
|---|---|---|---|
| A1.1 | JS-on 静止 | `[data-assignee-item]` 计数 == 6 | 6 |
| A1.2 | JS-on 静止 | 每项恰 1 个 `[data-agent-assignee]`、**0** 个 `[data-assignee-clear]` | 6/6 |
| A2.1 | JS-on 静止 | 每项无 `data-assignee-active` 或 == `"false"` | 全 `"false"` |
| A2.2 | JS-on 静止 | 文档恰 1 个 `[data-assignee-clear]`，其 `hidden` 存在且**不可见** | 1 个，`hidden` / 不绘制 |
| A3.1 | JS-on 静止 | `[data-filter-assignee]` 的**静态** option（无 `data-assignee-filter-option`）计数 == 4 | 4 |
| A3.2 | JS-on 静止 | `[data-filter-assignee] [data-assignee-filter-option]` == 0 | 0 |
| A3.3 | JS-on 静止 | `[data-filter-assignee]`.value == `"all"` | `all` |
| **R2.1** | JS-on 静止 | `[data-assignee-option]` 文档计数 == 14 **且**其中 14 个都在 `[data-assignee-menu]` 内（B22 座位不变、本卡元素不在其选区） | 14 / 14 |
| A4.1 | **JS-off** | `[data-assignee-item]` 计数 == 6 | 6 |
| A4.2 | **JS-off** | 六个名文各自可读且等于其项名 | `jobs,linus,simons,elon,turing,assistant` |
| A4.3 | **JS-off** | 每项恰 1 名按钮、0 清除按钮 | 6/6 |
| A4.4 | **JS-off** | 文档恰 1 个 `[data-assignee-clear]`（在 `[data-filters]` 内）、`hidden`、**不绘制** | 1 / 在 bar / `hidden` / 不绘制 |
| A4.5 | **JS-off** | 该 `x` 的 glyph 是 `✕` | `✕` |
| A4.6 | **JS-off** | `[data-filter-assignee] [data-assignee-filter-option]` == 0 且静态 option == 4 | 0 / 4 |

### 5.2 B 组 · 几何 / 计算样式（真浏览器，computed）

| # | 断言 | 实测 |
|---|---|---|
| B1.1 | 选中项 `border-radius` == `999px` | `999px` |
| B1.2 | 选中项 `padding-left` / `padding-right` == `6px` | `6px` / `6px` |
| B1.3 | 选中项 `margin-left` / `margin-right` == `-6px`（宽度中性的抵消对） | `-6px` / `-6px` |
| B1.4 | 选中项 `background-color` == 浏览器解析后的 `--color-td-accent-soft` | `rgba(15, 122, 115, 0.1)` == 同 |
| B1.5 | 选中项内 `[data-agent-assignee]` 的 `color` == 浏览器解析后的 `--color-td-accent` | `rgb(15, 122, 115)` == 同 |
| B1.6 | 选中项 `border-top-width` == `0px`（床，不是壳） | `0px` |
| B2.1 | 静止项 `border-top-width` == `0px`（无壳） | 六项皆 `0px` |
| B3.1 | 四行 `[data-agent-row]` 盒高：选中后 − 静止 ≤ **0** | 位移 `0`（四行全 0） |
| **B6.1** | 静止：每行单行宿主 `scrollWidth − clientWidth` == 0 | `jobs:0 · elon:0 · turing:0 · assistant:0` |
| **B6.2** | 选中（胶囊在）：同一量 @1512 与 @1240 == 0（**R-1 的硬指标**） | @1512 全 0 · @1240 全 0 |
| **B6.3** | 选中（胶囊在）：同一量 @980 / @760 / @430 ≤ 0（该三档名册整体隐藏） | 全 `[0,0,0,0]` |
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
| C2.2 | 承接 C2：**B04 的** `[data-assignee-clear]` 无 `hidden` 且**可见** | 同 |
| C2.3 | 名册恰 **1** 个 active | 1 |
| C3.1 | 点 `[data-assignee-clear]` ⇒ value == `"all"` | `all` |
| C3.2 | 承接 C3：`[data-filter-assignee] [data-assignee-filter-option]` == 0 | 0 |
| C3.3 | 承接 C3：status 值**不变**（仍 `"in_progress,in_review"`） | 同 |
| C3.4 | 承接 C3：名册还原静止（active `"false"`）**且** `x` 复隐 | 同 |
| C3.5 | 承接 C3：视图仍为 list | `list` |
| C4.1 | 在 jobs 选中时点 `linus` ⇒ 名册恰 1 个 active（= linus） | `linus` |
| C4.2 | 承接 C4：`[data-filter-assignee] [data-assignee-filter-option]` 恰 1 个且 == `"linus"` | `["linus"]` |
| C4.3 | 承接 C4：value == `"linus"` | `linus` |
| C5.1 | 再点已选中的 `linus` ⇒ value == `"all"` | `all` |
| C5.2 | 承接 C5：名册 0 active | 0 |
| C5.3 | 承接 C5：status **不变** | `in_progress,in_review` |
| C5.4 | 承接 C5：`x` 随名字一起复隐 | 不绘制 |
| C6.1 | 键盘 Tab 到名按钮：`:focus-visible` 环存在且 `outline-color` **非透明** | `rgb(15, 122, 115)` / 2px solid |
| C6.2 | 该按钮 **Enter** ⇒ C1（value/status/view 三者同时成立） | `jobs` / `in_progress,in_review` / `list` |
| C6.3 | 键盘 Tab 到 `[data-assignee-clear]`：`:focus-visible` 环存在且 `outline-color` **非透明** | `rgba(15, 122, 115, 0.35)` / 2px solid |
| C6.4 | 该按钮 **Enter** ⇒ C3（value 回 `all`、status 不变） | `all` / `in_progress,in_review` |
| C7.1 | 两次点击**不新增** `[data-toast-region]` 子节点 | 0 → 0 |
| C7.2 | 全程 `console.error` == 0 | 0 |
| C7.3 | 全程 `pageerror` == 0 | 0 |

### 5.4 不得断言（负向）

- 不得断言任何 **class 名**（`.td-assignee-item` / `.td-assignee-clear` / `.td-agent-assignee` 只用于样式）。
- 不得用**行号**锚。
- 不得断言原型专用的 `?theme=` / `?lang=` 开关形态。
- **不得**把 `[data-assignee-option]` 当**本卡**的钩子读（它是 B22 的；本卡的是 `[data-assignee-filter-option]`，见 §2.9）。

---

## 6. 实测与复跑

| 腿 | 命令 | 结果 |
|---|---|---|
| 契约机检（A/B/C） | `node verify-r13.mjs`（本卡工作区 `workspace/T-20261013-033415/verify/`，**不进仓**） | **55/55 通过**；原始记录 `verify-r13.json` |
| 令牌守恒 | 同上的 `build-css.mjs`（重建 + 前后 `:root` 快照） | 205 → 205，**守恒**；`tw.css` 205633 → **205606** bytes（**−27**），diff = **+6 / −8 行，全为有意规则**，无扫描器误产 |
| 活动视图回归 | `node design/activity/check-activity.mjs` | **132/132 通过** |
| 宿主全量套件 A/B | `node --test`（在基线 `0b95188` 的独立 worktree 与本 commit 各跑一轮） | 见下 |
| 截图 | `design/assets/r13/` | 六帧，逐帧见该目录 README |

**A/B（宿主全量套件 · 每侧都在自己的 commit 上跑）**

| | 基线 `0b95188`（seg1） | 本 commit `e64bf6c`（seg2） | 差 |
|---|---|---|---|
| tests / skipped | 1841 / 2 | 1841 / 2 | 同 |
| pass / fail | 1832 / **7** | 1833 / **6** | **−1** |
| 失败 suite | 2（`web/blocks.contract — the recorded counts…`、`catalogue vs prototype`） | 2（同） | 同 |
| **新增红** | — | — | **0 条** |
| **转绿** | — | — | **1 条**：`web/blocks.contract` › `states the prototype's MESSAGES count in design/prototype/README.md`（seg1 的唯一新增红，R-3 的修复点） |

余下 6 条红在**两侧同一集合**内（`counts the data-i18n* seats`、`counts the MESSAGES keys`、`carries the prototype's entries verbatim`、`deep-equals the catalogue re-derived`、`matches the prototype's real key count`、`covers every translated hook`），均为 R12x 已记的 `test/web` 目录/钩子镜像落后（归实现卡），**不是本卡引入**。

**集成实测（另一独立 worktree，不落任何分支）**：把本 commit 合进当时的 `main`（`8d6432b`，其自 0b95188 起只动 `test/**` 与 `web/**`，**未动 `design/**`**）—— **merge 无冲突**；合后在那个 worktree 里跑全量套件，得 **1841 / pass 1833 / fail 6 / skipped 2**，失败集合与上表「本 commit」一列**逐条相同**。即：相对 `main` 亦**零新增红**。

**实测补充（床的越界与被裁，记录不作断言）**：宿主 `.td-side-name` 自带 `overflow: hidden`（R8 的省略号规则）。宽度中性的胶囊把**边框盒**向左右各外扩 6px，而**文字推进量**不动 ⇒

- 行首名（`jobs` / `elon` / `turing` / `assistant`）：床的左侧 6px 落在宿主 padding box 之外，被 `overflow: hidden` **裁掉** —— 实测 `clipL = 6px`；
- 行中名（`linus`）与行尾名（`simons`）：床的两端都落在宿主内，**完整圆帽** —— 实测 `clipL = clipR = 0`；
- 两种情形下 `scrollWidth − clientWidth` 均为 **0**（B6 达标），即**没有任何名字被省略**。

见 §8 U-6。

---

## 7. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/fidelity-r13.md` | 本文件：口径 + 交互/视觉契约 + **full block list（含匹配项）** + 逐条机检断言 + 实测 + seg2 修订索引 | **新增 / 修订** |
| `design/BLOCKS.md` | **B03**：名册段补 R13（项结构 / 宽度中性胶囊 / **项内不再有 `x`** / 与 R11 ② 的取代关系）；**B04**：assignee 控件行与段落补 R13（域扩 + `[data-assignee-filter-option]` 按需生成 + **新增 `[data-assignee-clear]`** + 单一渲染器） | **已改** |
| `design/DESIGN.md` | **§31**（§31.1 交互含义 / §31.2 单一真相与域扩展 / §31.3 胶囊与令牌守恒 / §31.4 叠加与 `x` 语义 / §31.5 实测 / §31.6 被否决备选）更新到 seg2 落点，§31.6 **被否决备选 ≥5 条**（含新增的「内联带 ✕ 的胶囊」） | **已改** |
| `design/prototype/index.html` | 名册段：六个名 → 六个 `[data-assignee-item]`（**各含一个名按钮**）+ R13 注释；B04：`[data-filter-assignee]` 之后新增 `[data-assignee-clear]` | **已改** |
| `design/prototype/app.js` | `MESSAGES` 恰 +1 键（`assignee.clear`，en/zh）；`ASSIGNEE_STATIC_VALUES` / `assigneeFilterValue()` / `renderAssigneeFilter()` / `writeAssigneeFilter()`；`applyFilters()` 增加渲染调用 + assignee 具名分支；名册点击处理器四步 + 「已选中再按 = 关闭」；**B04 的 `[data-assignee-clear]` 处理器**（`$("[data-filters]").on(...)`，`stopPropagation()`）；R11 的「不写人名」注释改写；具名钩子改名 | **已改** |
| `design/prototype/src/input.css` | 名册规则段后追加 R13 段（宽度中性胶囊 / 名色 / `x` / hover / focus-visible） | **已改** |
| `design/prototype/tw.css` | 按 `README.md` §Build 重建（`205633 → 205606`，+6 / −8 行） | **已重建** |
| `design/prototype/README.md` | **seg2 纳入写面**：MESSAGES 键数 `280 → 281`；`tw.css` 字节 `204768 → 205606`；I-map 改写 `I20`、新增 `I22`；Coverage 表补 R13 三行；R11 段的「route, not a filter on the name」改为「曾是（R13 扩域）」并新增 R13 段 | **已改** |
| `design/assets/r13/**` | 六帧 + README | **新增 / 重截** |
| `design/fidelity-r11.md` | **不改**：R11 条文原样成立，取代关系写在本文件表头与 §4.1（同一张卡的另一半口径未被撤） | **不改（有意 + 已记）** |
| `design/fidelity-r9.md` / `-r10.md` / `-r12.md` / `-r12-supplement.md` | **不改**：与本轮正交 | **不改（有意）** |
| `design/activity/**` | **不改**（spec 禁改；回归仍 132/132） | **不改（红线）** |
| `web/**` · `src/**` · `test/**` | **不改**（卡的红线：无实现代码）；实现侧实读记录：`web/src/components/shell/Sidebar.vue` 的 `[data-agents-presence]` 区目前是纯文本名，`web/src/stores/board.js` 的 `filters.assignee` 域目前是 `all\|me\|human\|agent`（具名传参会**不过滤任何行**）——两条都归实现卡 | **不改（红线）** |
| **i18n 归属（显式判定）** | **恰 +1 键**：`assignee.clear`（`x` 的可及名）。`MESSAGES` en **281** / zh **281**（1:1 镜像）；`index.html` 的 `data-i18n-aria-label` 座位 **72 → 73**（seg1 的 6 座随名册内 `x` 一同删除，B04 的 `x` 补 1 座）。**无**其他键、**无**其他类别座位变化 | **已判定（+1）** |

---

## 8. 红线与未决

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | 筛选状态的唯一真相是 **`[data-filter-assignee]` 的 `.value`**；**不得**另立一个 JS 变量、`localStorage` 或第二处 DOM 值来表达它。 |
| R2 | 名册的胶囊状态与 `x` 的显隐**必须由值渲染**（`renderAssigneeFilter()`）；**不得**让按下名字时只改名册、不改控件。 |
| R3 | 具名 option **至多一个**且只在 `[data-filter-assignee]` **之内**；**不得**把具名项放到别的控件或文档别处。 |
| R4 | `x` **只**清 assignee：**不得**连带清 status / priority / label / search，**不得**切视图，**不得**发 toast。 |
| R5 | 叠加语义是 **AND**；**不得**把双条件改成 OR，也**不得**让 status 子句在具名时失效。 |
| R6 | `[data-assignee-clear]` **必须**静态存在、静止 `hidden`、**恰一个**，且是 `[data-filter-assignee]` 的**紧邻兄弟**（JS-off 结构完整的唯一来源）。 |
| R7 | 胶囊的壳在**包裹项**上，**不得**搬到名按钮上；名按钮的脸保持 R11 的「文字即控件」。 |
| R8 | 行**高**不得因选中而变（实测位移必须 ≤ 0）。 |
| R9 | **宽度中性不得回退**：选中项**必须**同时带 `padding: 0 6px` 与 `margin-inline: -6px`（或任何等量抵消对），使**任何档位**的 `clippedPx == 0`。**不得**为了让床好看而吃掉行宽。 |
| R10 | 零新 token / 色相 / 图片；`tw.css` 的 `:root` 集合**必须**与基线逐字节相等。 |
| R11 | 断言**只用 data 钩子 + 属性**；**不得**以 class 名或行号作锚。 |
| R12 | 本卡的具名 option 钩子是 **`[data-assignee-filter-option]`**；**不得**改回或复用 `[data-assignee-option]`（B22 的 14 座 + 文档级委托）。 |
| R13 | `design/fidelity-r11.md` **保持原样**；凡与之冲突的条文，以本文件表头与 §4.1 的取代表为准，**不得**回改 R11 文档。 |
| R14 | 名册项**不得**再加第二个按钮：该行宿主只有 143 / 144px（余量 1px），任何额外按钮结构上只能截断一个名字（N8）。 |

**未决项（明确不在本轮，留给 Jobs / Elon 裁）**

| # | 项 | 说明与实测 |
|---|---|---|
| **U-1** | ~~`[data-assignee-option]` 钩子名与 B22 相撞~~ **已裁（seg2 R-2）** | seg1 记录：spec §3.4 的钩子名被 B22 占用（14 座 + 全局委托）。**Jobs 已裁定改名** ⇒ 本段落地为 `[data-assignee-filter-option]`，并把「B22 14 座不变、本卡元素不在其选区」变成断言 R2.1。**本条关闭。** |
| **U-2** | **i18n 新键与镜像红** | 复用键优先已试：既有 `filters.clear` / `combo.clear` / `noResults.clear` / `access.cidr.remove` 无一能读作「Remove assignee filter」⇒ **恰加一个** `assignee.clear`。**seg2 实测更正**：spec §7 预期的「`test/web/{i18n.catalogue,blocks.contract}` 逐字镜像红同族扩大」**未发生** —— `web/i18n.catalogue` 的 4 条镜像红在基线就已全红，+1 键没有新增条数（两侧同 4 条）。归实现卡。 |
| **U-3** | ~~胶囊的宽度代价~~ **已裁（seg2 R-1）** | seg1 记录：胶囊宽 20px ⇒ 1512 档 claude 行尾 `simons` 被省略 19px。**Jobs 已裁定宽度中性** ⇒ 本段落地为 `padding: 0 6px` + `margin-inline: -6px`，实测五档 `clippedPx == 0`（B6）。**本条关闭**，其代价改写为 U-6。 |
| **U-4** | ~~`design/prototype/README.md` 落后一轮~~ **已裁（seg2 R-3）** | seg1 记录：该文件在写面闭集外，故落后两处（键数 280 / 字节 204768），并因此是 seg1 **唯一**的宿主新增红。**Jobs 已把该文件纳入写面** ⇒ 本段补齐：键数 `280 → 281`、字节 `204768 → 205606`、I-map 与 Coverage 补 R13。**该红已归零**（§6 A/B）。**本条关闭。** |
| **U-5** | **实现侧的两处实读（归实现卡）** | ① `web/src/components/shell/Sidebar.vue` 的名册区目前是纯 `<span data-side-name>` 文本（`grep -rn 'data-agent-assignee' web/src` = NONE）⇒ 连 R11 的路由都未落地；② `web/src/stores/board.js` 的 `visibleTasks` 对具名值**三个分支全不匹配 ⇒ 不过滤任何行**，须新增具名分支（与 §2.6 同构）。两条都**不在本卡写面**。另：实现卡的读点须用 **`[data-assignee-filter-option]`**，且 `[data-assignee-clear]` 的落点是**筛选条**而非名册。 |
| **U-6** | **宽度中性的镜像代价：床的左帽被宿主裁掉（seg2 新实测，未裁定）** | 宿主 `.td-side-name` 自带 `overflow: hidden`（R8 的省略号就做在它身上）。床向左右各外扩 6px，于是**行首名**（`jobs` / `elon` / `turing` / `assistant`）的左帽被裁 **6px**（实测 `clipL = 6`），呈**左侧平直、右侧圆帽**的不对称药丸；**行中名**（`linus`）与**行尾名**（`simons`）两端**完整**（`clipL = clipR = 0`）。**R-1 的指标（不省略名字 ⇒ `clippedPx == 0`）全部达标**；被裁的只是**床**，不是文字。可能收尾（**未选**，留给 Jobs）：① 接受（床本来就要越界，行首的平直边读作「贴着行首」）；② 给宿主 `.td-agent-text` 在名册行内改 `overflow: visible`（需评估对 R8 省略号与 ≤1023 隐藏的影响）；③ 把内衬从 6px 降到宿主余量内（会牺牲床的可读性）。**本卡按 R-1 的数值原样落地，不自行改向。** |

---

## 9. seg2 修订索引（R-1 … R-4）

| # | Jobs 裁定 | 本段落点 | 证据 |
|---|---|---|---|
| **R-1** | 选中胶囊改**宽度中性**；名册项**删** `x`；`x` 移入 **B04**、`[data-filter-assignee]` 之后；再按已选中名 = 关闭（保留） | §2.1 / §2.3 / §2.4 / §3.2 / §3.3 / §4.1 | B1.2–B1.3（`6px` / `-6px`）、B6（五档 `clippedPx == 0`）、C2.2 / C3.1 / C3.4 / C5.4 |
| **R-2** | `[data-assignee-option]` → **`[data-assignee-filter-option]`**（生成处 + 契约 + BLOCKS + 机检）；核 B22 的 14 座不变、全局委托不再命中本卡元素 | §2.9 / §3.4 / §4.2 / §5.1 R2.1 / §8 R12 | A3.2 / A4.6（控件内 0 个）、R2.1（文档 14 个，全在 `[data-assignee-menu]` 内）、C4.2 |
| **R-3** | 补齐 `design/prototype/README.md`：MESSAGES `280 → 281`、`tw.css` 字节、I-map / Coverage 补 R13 | §7（README 行） | 宿主 `web/blocks.contract` › `states the prototype's MESSAGES count in design/prototype/README.md` **转绿**（复跑读数 `claim 281 == app.js 281`） |
| **R-4** | 同步 `fidelity-r13.md` / `BLOCKS.md` / `DESIGN.md`；重跑 A/B/C 与 `check-activity`；重截六帧 + README | 本文件 + §6 + `design/assets/r13/README.md` | `verify-r13.json`（55/55）、`check-activity` 132/132、`tw-tokens.json`（conserved） |
