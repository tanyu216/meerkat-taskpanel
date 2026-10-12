# UI 保真契约 · R7 — Terry 四项反馈（Before 契约）

> 卡：`T-20261012-210221` · 日期 2026-10-12 · 范围「R7：Terry 四项侧栏反馈」· 定位「§⑨.1 Before = 结构契约」。
> 来源：Terry 2026-10-12 20:59 侧栏三项反馈 + 21:06 追加第 ④ 项。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 期望值一律取自**原型在真实浏览器中的 computed style 实测**；实现侧一律**实读 + 到场实测**（构建产物 `web/dist`）。
> 关系卡：实现 `T-20261012-210221-2`（blocked）· 验证 `T-20261012-210221-3`（blocked）。本卡**只产契约与原型改动，不含实现代码**。

## 0. 结论摘要

- 四项**全部落在既有块**（①B03 nav ②B03 项目行 ③B03 footer ④B09 抽屉头）⇒ 本契约不引入新块；仅 ③ 新增一个钩子 `[data-access-cell]`（见 §2.4）。
- **③ 是本轮唯一的设计变更**：footer 由「一行三等分」改为「三行纵排堆叠」。原型 `src/input.css` + `index.html` 已改，`tw.css` 已重建，`DESIGN.md` §23 / `BLOCKS.md` B03 已同步。①②④ **无原型改动**（原型即契约，实现对齐原型）。
- ① 偏离类型 = **样式类缺失 + 钩子误用**：实现 nav svg `class="size-4"` 缺 `td-icon` ⇒ 实测 `fill: rgb(0,0,0)` / `stroke: none`（实心块），原型 `fill: none` / `stroke-width: 1.5px`；且实现 4/4 nav svg 误带 `data-side-icon` ⇒ rail 被 monogram chip 规则命中（实测 980 档 `border-width: 1px` + 灰底），原型 rail 的 nav glyph 是裸 16px（`border: 0`）。
- ② 偏离类型 = **类 / 钩子落点 / count 语义**：实现 pill 类集 `badge badge-sm td-mono`（**缺 `td-count`**，实测 34.45×20 / 圆角 4px），原型 `badge badge-sm td-count`（20×18 / 圆角 999px）；`data-project-count` 实现落在**行 button**（3/3），原型落在 **pill span**；count 缺省语义两端一致（`null` 不渲染，属既定期望）。
- ② **到场复现判定：Terry 所见 =「样式不同」，不是「未显示」**——构建产物在 1440 档三行都渲染出了数字（12 / 4 / 2），只是没有 `.td-count` 品牌面。详见 §2.5。
- ④ 偏离类型 = **位置 + 字形**：实现 `[data-detail-close]` 是 `flex-col` header 的**第 3 行**（实测 `close.top 72 ≥ title.bottom 68`，`sameRow=false`，字形为文字 `✕`）；原型在**顶部行**内（`sameRow=true`、与 identifier 同心、`right` 与行右缘重合、内含 `svg.td-icon` + ✕ path）。
- **契约实测订正 3 条**（§1 R7-1 / R7-2 / R7-3）：④ 的「同行」不得用 bbox `top` 之差断言（原型自身差 7px，因两盒高不同）；`margin-inline-start: auto` 在 computed style 里**已被解析成用后像素值**，不得断言字面 `auto`；③ 的 rail 档容器是**内容宽**（14px）而非 rail 全宽——这是**改动前既有**行为，非本轮引入。
- 四条契约均有 selector 级机检断言（§8），`blocks.contract`（结构）与 `dom-smoke`（计算样式）两类分列，供验证卡「During」直接落测。

---

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）。

**定位规则**：一律「**文件:选择器**」，**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：

1. 「期望计算样式」= 原型在真实浏览器（Chromium，headless）中的 **computed style 实测值**，不是 `src/input.css` 里某条声明的字面值；两者不一致时实测值胜，并把矛盾记入对应偏离表（归类 `口径`）。
2. 「实现位点」= 实读 `web/src/**` 后的选择器；凡未实测的实现态一律标注「未实测」。
3. token 名：原型侧沿用 `--color-td-*` / `--r-*`；实现侧 brand token 名以 `web/src/styles/tokens.css` 为准（同义）。
4. 以下**实测值**为本次两次到场的公共基线：原型 `console` / `pageerror` 均为 `[]`；构建产物 `web/dist` 同样为 `[]`。

**实测对本契约的订正（3 条）**：

- **R7-1（项④，关键）**：「close 与 identifier 同行」**不得**用 bbox `top` 之差断言。原型实测 `close.top = 12`、`identifier.top = 19`（Δ = **7px**）——同一 flex 行内两盒高度不同（close 32px 高、identifier 18px 高），**同行而顶边不齐**。可机检的同行信号是 **中心线重合**（实测 ΔcenterY = **0**）＋ **行容器同一**（`close.parentElement === identifier.parentElement`）。契约按中心线断言。
- **R7-2（项④）**：`margin-inline-start: auto` 在 `getComputedStyle()` 里**返回用后像素值**（原型实测 `335.297px`），**不是**字面 `auto`——`auto` 不是可断言的 computed 值。靠右的机检改断 **几何**：`close.right ≈ 行容器.right`（原型实测 Δ = **0**）。若需断言「声明层」的 `auto`，只能读 CSSOM `matchedCSSRules`，本契约不采用。
- **R7-3（项③）**：rail 档（≤1023）footer 容器实测宽 **14px**（= 图标内容宽），**不是** rail 的 48/56px 内容宽——`.td-sidebar` 在 rail 是 `align-items: center`，footer 作为 flex item **收窄到内容**。该行为**改动前即存在**（原 grid 三等分时为 3×14 = 42px），R7 **未改变**它。故 rail 断言一律按「cell 宽度 = 容器内容宽」「cell 高 24px / 居中 / 无 label·caret」，**不断言容器宽**。

**共用 token 冻结值（原型 light）**：`accent` #0f7a73 · `surface` #ffffff · `line` #e6e8eb · `ink` #14181b · `ink-2` #4a555e · `ink-3` #7e8a91。radius：`--r-sm` 4px · `--r-md` 6px · `--r-full` 999px。rail 断点：`max-width: 1023px`。

---

## 2. 逐项契约

### 2.1 项① `B03.nav-icon` — nav 图标

*证据：原型 1512 / 980 两档实测；`count [data-nav] [data-nav-item] svg` = **4**（board / list / activity / waiting）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B03.nav-icon` |
| 唯一 selector | `[data-nav] [data-nav-item] svg` |
| data-* 钩子 | `[data-nav]`（容器）· `[data-nav-item]`（项，值 `board`/`list`/`activity`/`waiting`）；**nav svg 自身不得带 `data-side-icon`** |
| 期望类集 | svg 类集**含** `td-icon`（`td-icon` 是 `app.css` 的品牌组件类，非 Tailwind 工具类） |
| 期望 computed（≥1024，light） | `fill: none` · `stroke: <该项 button 的 computed color>`（实测：非选中项 `rgb(74, 85, 94)`；选中项 `rgb(15, 122, 115)`＝accent）· `stroke-width: 1.5px` · `stroke-linecap: round` · `stroke-linejoin: round` |
| 期望几何（≥1024） | svg bbox **16 × 16** |
| 期望 computed（rail ≤1023） | 同上一行，**另加**：`border-top-width: 0px` · `border-left-width: 0px` · `background-image: none` · `background-color: rgba(0, 0, 0, 0)`；bbox 仍 **16 × 16**（**不**被 monogram chip 规则命中） |
| 字面 path（四项，逐字） | board `M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z` · list `M4 6h16M4 12h16M4 18h16` · activity `M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2` · waiting `M5 5h14v10H9l-4 4V5Z` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | **nav svg 缺 `td-icon` 类** | `web/src/components/shell/Sidebar.vue:[data-nav] [data-nav-item] svg` | 实测类集只有 `size-4` ⇒ 无 `fill:none` / `stroke:currentColor` / `stroke-width:1.5` / round 面：实测 `fill: rgb(0, 0, 0)`、`stroke: none`、`stroke-width: 1px`、`linecap: butt`、`linejoin: miter` ⇒ 字形按默认实心块渲染 | 缺 |
| 2 | **nav svg 误带 `data-side-icon`** | `web/src/components/shell/Sidebar.vue:[data-nav] [data-nav-item] svg[data-side-icon]` | 实测 **4/4** nav svg 带该钩子；该钩子是**项目 monogram** 的（`web/src/components/shell/Sidebar.vue:[data-project] [data-side-icon]`），rail 的 chip 规则按属性选择器命中 ⇒ 980 档实测 nav svg `border-width: 1px`、`background-color: rgb(230, 232, 235)`、bbox **24 × 24** | 缺 |
| 3 | 字形本身 | `web/src/components/shell/Sidebar.vue:[data-nav] [data-nav-item] svg path` | 四 path 与原型**逐字相同** ⇒ 本项**与字形无关**，记此行为的是澄清「不是画错图标，是没上样板」 | 对齐 |

**落地建议表**

| # | 建议 | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | nav svg 类集加 `td-icon`（`size-4` 可留，两处 16px 同值） | `web/src/components/shell/Sidebar.vue:[data-nav] [data-nav-item] svg` | 与原型类集一致 |
| 2 | 去掉 nav svg 上的 `data-side-icon` | 同上 | 该钩子归项目 monogram span；勿以「加作用域」代替，nav 本就不该有这个钩子 |
| 3 | 确认 rail chip 规则只命中 monogram | `web/src/styles/app.css:[data-sidebar] [data-side-icon]` | 现有规则已按 `[data-sidebar] [data-project] [data-side-icon]` 隐藏、按 `[data-sidebar] [data-side-icon]` 出 chip；**去掉误带的钩子后二者自动归位**，不必改规则 |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N1 | `count [data-nav] [data-nav-item] svg[data-side-icon]` | `0` |
| N2 | rail（980）`[data-nav] [data-nav-item] svg` 的 `border-top-width` | `0px` |
| N3 | rail（980）`[data-nav] [data-nav-item] svg` 的 `background-image` | `none`（且 `background-color` 透明） |
| N4 | `[data-nav] [data-nav-item] svg` 的 `fill` | ≠ `rgb(0, 0, 0)`（即 `none`） |

---

### 2.2 项② `B03.project-count` — 项目计数

*证据：原型 1512 / 1240 实测（3 行 `[data-project]`，各一颗 pill）；980 档 pill `display: none`。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B03.project-count` |
| 唯一 selector | `[data-project] [data-project-count]`（**pill span**，非行 button） |
| data-* 钩子 | `data-project-count`（**数字元素本身** = pill）· `data-side-count`（rail 隐藏钩子，**同一 pill** 上）· 行钩子 `[data-project]` |
| 期望类集 | pill 类集**含** `td-count`（原型 `badge badge-sm td-count`） |
| 期望 computed（count 为有限数字，含 `0`） | `font-family` 含 mono（实测 `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`）· `width: 20px` · `height: 18px` · `background-color: rgb(255, 255, 255)`（surface）· `border-top-width: 1px` · `border-radius: 999px` · `display: flex` · 文本 = 该数字 |
| 期望（count 缺省 = `null` / `undefined`） | pill **允许不存在**（既定期望，**非缺陷**；不伪造 `0`） |
| 期望（rail ≤1023） | pill `display: none`（与 `.td-count` 的既有 rail 隐藏一致） |
| 计数关系 | `count [data-project] [data-project-count]` = `count button[data-project]`（每行至多一颗，`null` 行 0 颗） |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | **pill 缺 `td-count` 类** | `web/src/components/shell/Sidebar.vue:[data-project] [data-side-count]` | 实测类集 `badge badge-sm td-mono` ⇒ 无品牌面：实测 `width 34.45px`（原型 20px）、`height 20px`（原型 18px）、`border-radius 4px`（原型 999px）。mono 字体与 surface 底、1px 边**恰好相同** ⇒ 差异集中在**尺寸与圆角** | 缺 |
| 2 | **`data-project-count` 落在行 button** | `web/src/components/shell/Sidebar.vue:button[data-project][data-project-count]` | 实测 **3/3** 行 button 带该钩子、`[data-project] [data-project-count]` 后代命中 **0**；原型相反（span 上 3/3，button 上 0）⇒ 钩子命名的是「数字元素」，实现把数字元素的钩子挂到了行 | 缺 |
| 3 | `td-mono` 冗余 | `web/src/components/shell/Sidebar.vue:[data-project] [data-side-count]` | `td-count` 自带 mono 面；留着不产生可见差异（实测字体已是 mono） | 口径（**不作硬失败**） |
| 4 | count 缺省语义 | `web/src/components/shell/Sidebar.vue:[data-project] [data-side-count]` | `v-if="project.count !== null"` ⇒ `null` 不渲染，`0` 渲染 ⇒ 与原型/DESIGN §20.1 **一致** | 对齐 |

**落地建议表**

| # | 建议 | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | pill 类集改 `badge badge-sm td-count` | `web/src/components/shell/Sidebar.vue:[data-project] span[data-side-count]` | `web/src/styles/app.css:.td-count` 已存在且逐值等于原型（20×18 / mono / 999px / hairline）⇒ 无需新增规则 |
| 2 | `data-project-count` 从行 button 移到 pill span；`data-side-count` 留在 pill | 同上 + `web/src/components/shell/Sidebar.vue:button[data-project]` | `data-side-count` 是 R6 的 rail 隐藏钩子，保留（实测 rail `display:none` 已生效） |
| 3 | 保留 `v-if` 缺省语义 | 同上 | `0` 要显示、未知不显示 |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N5 | `count button[data-project][data-project-count]` | `0` |
| N6 | `[data-project] [data-project-count]` 的 `tagName` | `SPAN` |
| N7 | `[data-project] [data-project-count]` 的类集 | 含 `td-count` |
| N8 | rail（980）`[data-project] [data-project-count]` 的 `display` | `none` |

---

### 2.3 项③ `B03.footer-stacked` — footer 三行堆叠（**设计变更**）

*证据：改动后的原型 1512 / 1240 / 980 / 760 / 430 五档实测。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B03.footer-stacked` |
| 唯一 selector | 容器 `[data-access-status]`；行 `[data-access-status] [data-access-cell]`；三行内分别含 `[data-theme-switch]` / `[data-lang-select]` / `[data-access-open]` |
| data-* 钩子 | `[data-access-status]`（容器）· **`[data-access-cell]`（新增，三个行 button 各一）** · 行内既有钩子：`[data-theme-switch]` + `[data-theme-label]` · `[data-lang-select]` + `[data-lang-label]` + `.td-caret` · `[data-access-open]` |
| 期望 computed-容器（全档） | `display: flex` · `flex-direction: column` · `grid-template-columns: none` · `border-top-width: 1px` · `padding: 8px 0 0` |
| 期望 computed-行（≥1024，light） | `display: flex` · `flex-direction: row`（**行内仍单行**）· `justify-content: flex-start` · `gap: 8px` · `padding: 0px 8px` · `height: 28px` · `width` = 容器内容宽（1512 实测 223px） |
| 期望几何-行（≥1024） | 三行 bbox `top` **严格递增**，步长 = 行高（1512 实测 800 / 828 / 856，Δ = 28）；三行 `left` = 容器 `left`（实测均 12）；三行宽 = 容器内容宽 |
| 期望分隔线（≥1024） | 第 2/3 行 `border-block-start-width: 1px`；**第 1 行 `0px`**；三行 `border-inline-start-width` 全 `0`（实测 1px / 0px 序列 = `[0, 1, 1]`，inline-start 全 `0`） |
| 期望 computed-行（rail ≤1023） | `display: flex` · `flex-direction: row` · `justify-content: center` · `gap: 0px` · `padding: 0px` · `height: 24px` · `width` = 容器内容宽（实测 14px＝内容宽，见 R7-3） |
| 期望可见性（rail ≤1023） | 行内 label（`.td-side-text` / `[data-side-text]`）`display: none`；`.td-caret` `display: none` |
| 顺序（上→下） | theme → language → settings（= DOM 顺序，与改动前的左→右一致） |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 容器仍是一行三格 | `web/src/components/shell/SidebarFooter.vue:[data-access-status]`（类 `grid grid-cols-3`）+ `web/src/styles/app.css:[data-access-status]` | 实测 1440 档 `display: grid`、`flex-direction: row`、`grid-template-columns: 74.33px 74.33px 74.34px`；三行 bbox `top` **全等**（860 / 860 / 860）⇒ 单行并列 | 口径（**设计变更**，非缺陷） |
| 2 | 分隔线是竖线 | `web/src/styles/app.css:.td-access-cell` | 实测第 2/3 行 `border-inline-start-width: 1px`、`border-block-start-width: 0px` ⇒ 竖分隔线；目标为行间横向 hairline | 口径（**设计变更**） |
| 3 | 行内排布 | `web/src/styles/app.css:.td-access-cell` | 实测 `justify-content: center`、`gap: 6px`、`padding: 0px 2px`；目标 `flex-start` / `8px` / `0 8px` | 口径（**设计变更**） |
| 4 | **缺 `data-access-cell` 钩子** | `web/src/components/shell/SidebarFooter.vue:[data-access-status] > button` | 实测 `[data-access-cell]` 命中 **0**、三个直接子元素均无该钩子 ⇒ §8 的 selector 级断言在实现侧无法寻址 | 缺 |
| 5 | rail 档 | `web/src/styles/app.css:.td-access-cell`（≤1023 块） | 实测 980 档 `justify-content: center`、`gap: 0px`、`height: 24px`、label/caret `display: none` ⇒ **这一档已对齐**（改动只需保持） | 对齐 |
| 6 | 行内单行（R6 ⑦⑧） | `web/src/styles/app.css:.td-access-cell` | 实测两档 `flex-direction: row`、`[data-theme-switch]` 内 3 个 glyph 仅 1 个可见、无 `hidden="false"` 字面 ⇒ R6 ⑦ 的修复**保持** | 对齐 |

**落地建议表**

| # | 建议 | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 容器改 `flex-direction: column`（去掉 `grid-cols-3`） | `web/src/components/shell/SidebarFooter.vue:[data-access-status]` + `web/src/styles/app.css:[data-access-status]` | 桌面宽 223px（1512） |
| 2 | 行 button 加 `data-access-cell` | `web/src/components/shell/SidebarFooter.vue:[data-access-status] > button` | 三个都要（与原型一致） |
| 3 | `.td-access-cell` 改 `justify-content: flex-start` / `gap: 8px` / `padding: 0 8px` / `text-align: start`，去 `border-inline-start`，加 `.td-access-cell + .td-access-cell { border-block-start: 1px solid var(--brand-border) }` | `web/src/styles/app.css:.td-access-cell` | 值照原型 `src/input.css` 的 R7 规则；**不新造 token** |
| 4 | rail 块内补 `justify-content: center`（其余已有） | `web/src/styles/app.css` 的 `@media (max-width: 1023px)` 内 `.td-access-cell` | 保持既有 label/caret 隐藏 |
| 5 | footer 变高后复核侧栏底部 | `web/src/components/shell/SidebarFooter.vue:[data-access-status]` | 桌面 +28px、rail +0px（rail 行高由 24 起、行数由并列改堆叠 ⇒ rail 高度 33 → 81，实测原型 81px，五档均无横向溢出） |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N9 | `[data-access-status] [data-access-cell]` 三行 bbox `top` | **不全等**（禁单行并列） |
| N10 | `[data-access-status]` 的 `grid-template-columns` | `none` |
| N11 | 第 1 行 `[data-access-cell]` 的 `border-block-start-width` | `0px`（首行不画线） |
| N12 | `[data-access-status] [data-access-cell]` 的 `border-inline-start-width` | 全 `0px`（无竖线） |
| N13 | rail（980）`[data-access-cell]` 内 `.td-caret` 的 `display` | `none` |

---

### 2.4 项④ `B09.detail-close` — 详情抽屉关闭按钮（**对齐修复，无原型改动**）

*证据：原型 1512 实测（抽屉 `data-state="open"`）；实现 1440 / 980 实测。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | `B09.detail-close` |
| 唯一 selector | `[data-detail-close]`；参照 `[data-detail-identifier]`、`[data-detail-title]` |
| data-* 钩子 | `[data-detail-close]`（既有）· 同行容器内的 `[data-detail-identifier]` + `[data-detail-status-chip]` · 标题 `[data-detail-title]` |
| 期望结构 | `[data-detail-close]` 与 `[data-detail-identifier]` **同一父元素**（`close.parentElement === identifier.parentElement`），该父元素 computed `display: flex` **且** `flex-direction: row`（实测原型 `flex` / `row`） |
| 期望几何 | 两者 bbox **中心线重合**：`abs(close.centerY − identifier.centerY) ≤ 2`（原型实测 **0**，见 R7-1） |
| 期望几何-靠右 | `abs(行容器.right − close.right) ≤ 2`（原型实测 **0**，见 R7-2） |
| 期望字形 | `[data-detail-close]` 内实体含 **`svg.td-icon`**，其 `path` 的 `d` = `M6 6l12 12M18 6 6 18`，且该 svg `fill: none`、`stroke-width: 1.5px`（实测一致） |
| 期望类集 | 原型用 `td-iconbtn`；**实现 `web/src/styles/app.css` 无 `.td-iconbtn`** ⇒ 硬断言以「结构 + `svg.td-icon` + 几何」为准，`.td-iconbtn` 仅为原型类名，实现可用等价类 |
| 期望顺序 | `[data-detail-title]` 在**行容器之后**（原型：行容器含 identifier + chip + close，标题是其下一兄弟） |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | **close 落在标题下方独占一行** | `web/src/components/detail/DetailDrawer.vue:[data-detail-close]` | 实测 `sameRow = false`、父容器 `flex-direction: column`；`close.top 72 ≥ title.bottom 68` ⇒ 在标题**下方**、`ΔcenterY = 56` | 缺 |
| 2 | 字形是文字 `✕` | `web/src/components/detail/DetailDrawer.vue:[data-detail-close]` | 实测 `textContent = "✕"`、内部**无 svg**（`glyphTag = null`）、盒宽 `12.2px`；原型为 32×32 的 `svg.td-icon` 图标按钮 | 缺 |
| 3 | 无靠右约束 | `web/src/components/detail/DetailDrawer.vue:[data-detail-close]` | 实测 `margin-inline-start: 0px`；原型该按钮在行内**靠右**（实测 `right` 与行右缘差 0） | 缺 |
| 4 | 头部结构 | `web/src/components/detail/DetailDrawer.vue:header` | 实测 header 三个直接子：`div`（identifier + chip）→ `h2[data-detail-title]` → `button[data-detail-close]`；目标是把 button 移入第 1 个 `div` 并靠右 | 缺 |
| 5 | identifier 与 chip | `web/src/components/detail/DetailDrawer.vue:[data-detail-identifier]` / `[data-detail-status-chip]` | 实测二者已在同一 `div`（类 `flex items-center gap-2`）内，与原型同构 ⇒ 只需把 close 并入该 div | 对齐 |

**落地建议表**

| # | 建议 | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 把 `[data-detail-close]` 移入含 `[data-detail-identifier]` 的 `flex` 行 `div` 内 | `web/src/components/detail/DetailDrawer.vue:[data-detail-identifier]` 的父 `div` | 行容器保持 `display:flex` / `flex-direction:row` |
| 2 | 靠右用 `margin-inline-start: auto`（或等价 `ml-auto`） | `web/src/components/detail/DetailDrawer.vue:[data-detail-close]` | 断言按几何（R7-2），不按 class |
| 3 | 字形换 `svg.td-icon` + ✕ path（`M6 6l12 12M18 6 6 18`），去文字 `✕` | 同上 | 尺寸由实现自定（原型 32×32，`td-iconbtn` 类在本仓不存在 ⇒ 不照抄类名） |
| 4 | 保留 `aria-label`/`data-i18n` 无障碍名 | 同上 | 现状已有 `$t('drawer.close')` |

**负向断言**

| # | 断言 | 期望 |
|---|---|---|
| N14 | `close.top >= title.bottom`（即 close 在标题下方） | `false` |
| N15 | `close.top < title.top` | `true`（原型实测 `close.top 12 < title.top 44`） |
| N16 | `close.parentElement` 的 `flex-direction` | `row`（禁 `column`） |
| N17 | `[data-detail-close]` 的 `textContent` 内是否含 `✕` 字符 | 允许含（SVG 无文本），但**必须**另有 `svg.td-icon` |

---

## 3. 与 R6 ⑦⑧ 的边界（正交声明，必须显式）

- **R6 ⑦** 管的是 theme 行**活动图标可见性**（presence-based `hidden` 规则 + `svg[data-theme-icon][hidden]{display:none}`）。**R7 ① 是 nav 图标**，两者不重叠：nav svg **没有** `data-theme-icon`。实测复核本轮两端：原型 `visibleGlyphs = 1`、`literalHiddenFalse = 0`；实现 `visibleGlyphs = 1`、`literalHiddenFalse = 0` ⇒ **R6 ⑦ 的修复在本轮必须保持**（改动 `[data-nav]` 的类集不得顺手波及 `[data-theme-icon]`）。
- **R6 ⑧** 管的是 **cell 内部**三元素单行横排（icon → label → caret 同一行）。**R7 ③ 改的是 cell 之间**：由横向并列改纵向堆叠。**两者正交、不矛盾**：③ 要求「**行内仍单行** + **行间纵排**」。本契约因此把 `[data-access-cell]` 的 `flex-direction: row`（行内）与容器 `[data-access-status]` 的 `flex-direction: column`（行间）**分别断言**（§8 A/B 表），以防实现误把行内也拉成多行。
- 实现侧实测（本轮基线）：容器 `flex-direction: row`（错，应为列）、行内 `flex-direction: row`（对，须保持）。修正只动容器与行的排布参数，**不动行内的子序**。

---

## 4. Full block list（含匹配项）

### 4.1 本轮 block 条目（新增/变更/维持）

| 块 id | 归属既有块 | 唯一 selector | data-* 钩子 | 状态 | 说明 |
|---|---|---|---|---|---|
| `B03.nav-icon` | B03 · Sidebar / Nav | `[data-nav] [data-nav-item] svg` | `[data-nav]` · `[data-nav-item]`（**去** nav svg 上的 `data-side-icon`） | amended | 契约化既有子块；原型无改动 |
| `B03.project-count` | B03 · Sidebar / Projects | `[data-project] [data-project-count]` | `[data-project-count]`（pill）· `[data-side-count]`（同 pill）· `[data-project]` | amended | 钩子落点 + 类 + 尺寸契约化；原型无改动 |
| `B03.footer-stacked` | B03 · Sidebar / Footer controls | `[data-access-status] [data-access-cell]` | **`[data-access-cell]`（新增）** · `[data-access-status]` | **new（子块） + amended（布局）** | **本轮唯一设计变更**；原型已改（`index.html` + `src/input.css` + `tw.css`） |
| `B09.detail-close` | B09 · Task detail drawer / Head | `[data-detail-close]` | `[data-detail-close]`（既有） | amended | 位置 + 字形契约化；原型无改动 |

### 4.2 匹配项（这四个条目命中的既有块，逐个列明）

| 既有块（BLOCKS.md） | 被本轮的哪一项匹配 | 本轮是否改动 | 说明 |
|---|---|---|---|
| **B03 · Sidebar** | ① ② ③ | **是**（仅 footer 布局 + 一个新钩子） | B03 的 Nav / Projects / Footer controls 三行描述同步；Agents / Legend 行不动 |
| **B09 · Task detail drawer** | ④ | 否 | B09 的 Head 行已列 `[data-detail-close]`（与 identifier / title / status-chip 并列），无需改文案；契约只在形状上收紧 |
| B02 · Top bar | — | 否 | 未被匹配（`[data-view-toggle]` 归 R6 ①） |
| B04–B08 / B10–B19 | — | 否 | 未被匹配；`[data-access-panel]`（B19）**不是**本轮的 footer，别把 `[data-access-*]` 前缀混为一谈：`[data-access-status]` / `[data-access-cell]` 属 **B03 footer**，`[data-access-panel]` / `[data-access-open]` 属 **B19**（`[data-access-open]` 恰是 footer 里**打开** B19 的那一行） |
| B15 · Legend / B18 · States | — | 否 | 原型独有面（实现不渲染）；在 rail 截图里可见的「States」入口与本轮无关 |
| B20 / B21 · 主题/语言弹窗 | — | 否 | 已于 v1.4 退役（tombstone） |
| B22–B25（R3–R6 控件） | — | 否 | 未被匹配 |

### 4.3 负向注记清单（negative assertions，与 §8 对齐）

| # | 断言 | 期望 | 项 |
|---|---|---|---|
| N1 | `count [data-nav] [data-nav-item] svg[data-side-icon]` | `0` | ① |
| N2 | rail `[data-nav] [data-nav-item] svg` `border-top-width` | `0px` | ① |
| N3 | rail `[data-nav] [data-nav-item] svg` `background-image` | `none` | ① |
| N4 | `[data-nav] [data-nav-item] svg` `fill` | `none`（≠ `rgb(0,0,0)`） | ① |
| N5 | `count button[data-project][data-project-count]` | `0` | ② |
| N6 | `[data-project] [data-project-count]` `tagName` | `SPAN` | ② |
| N7 | `[data-project] [data-project-count]` 类集 | 含 `td-count` | ② |
| N8 | rail `[data-project] [data-project-count]` `display` | `none` | ② |
| N9 | `[data-access-status] [data-access-cell]` 三行 `top` | 不全等 | ③ |
| N10 | `[data-access-status]` `grid-template-columns` | `none` | ③ |
| N11 | 第 1 行 `border-block-start-width` | `0px` | ③ |
| N12 | 三行 `border-inline-start-width` | 全 `0px` | ③ |
| N13 | rail `[data-access-cell]` 内 `.td-caret` `display` | `none` | ③ |
| N14 | `close.top >= title.bottom` | `false` | ④ |
| N15 | `close.top < title.top` | `true` | ④ |
| N16 | `close.parentElement` `flex-direction` | `row` | ④ |
| N17 | `[data-detail-close]` 内 `svg.td-icon` | 存在（`path` = ✕） | ④ |

---

## 5. 「到场复现」记录（Terry 所见）

**手段**：把**构建产物** `web/dist` 用本仓自带的 fixture API 静态服务起来（沿用 `web/scripts/dom-smoke.mjs` 的 `startServer()`），headless Chromium 打开，实测 **1440** 与 **980** 两档（light、en）。`console` / `pageerror` 均为 `[]`。**未改写任何 `web/**` 与 `test/**`**。

| 观测点（1440 档） | 实测值 |
|---|---|
| `[data-project]` 行数 | **3** |
| `[data-project] [data-project-count]`（pill 后代） | **0** |
| `button[data-project][data-project-count]` | **3**，首个属性值 `"12"` |
| `[data-project] [data-side-count]`（pill span） | **3**，`tagName = SPAN`，文本 `12`，类集 `badge badge-sm td-mono` |
| pill computed | `font-family` = `"JetBrains Mono", ui-monospace, …`（mono）· `width` **34.4531px** · `height` **20px** · `background-color` `rgb(255, 255, 255)` · `border-top-width` `1px` · `border-radius` **4px** · `display` `flex` |
| 原型 `.td-count`（1512 档实测） | `width` **20px** · `height` **18px** · `border-radius` **999px** · 其余同上 |

**判定（Terry 所见）**：**「样式不同」，不是「未显示」。** 计数 pill 在构建产物里**确实渲染**（每行一颗、数字正确：12 / 4 / 2），`text_count` 也拿得到；偏差是**没有 `.td-count` 品牌面**——宽 34.45px、高 20px、圆角 4px（daisyUI `badge-sm` 默认几何）取代了 20×18 / 全圆角的品牌面。此外钩子 `data-project-count` 挂在**行 button** 上而非 pill，与原型契约相反（对用户不可见，但对机检可见）。

**980 档（rail）**：`[data-side-count]` 的 `display: none` ⇒ rail 隐藏行为**已对齐**（Terry 的反馈只涉及宽档）。

**未到场项（如实标注）**：本项**未**在实现侧跑主题/语言切换组合；`task_count` 的**缺省（`null`）**分支未用真实 fixture 触发，其期望按契约（不渲染 pill）与 DESIGN §20.1 记，标为**推算**、非实测。

---

## 6. 截图口径

- **视口**：§⑨.1 五档 `1512 / 1240 / 980 / 760 / 430`（宽度），高度 900。
- **主题**：light + dark，共 10 帧；主题由**原型自身的 `[data-theme-switch]`** 驱动（三态循环 light → dark；断言 `html[data-theme]` 实测为 `meerkat-taskpanel` / `dark`）。
- **语言**：en（默认，不切换）。
- **原型侧基线（本卡已产出）**：`workspace/T-20261012-210221/shots/proto-<width>-<theme>.png`（10 张，**不进仓**）。另附 `shots.json`：逐帧的 `data-theme` / `innerWidth` / `scrollWidth` / 三行 `top` / footer 高。
- **硬门（原型侧）**：五档 × 两主题**均无横向溢出**（`scrollWidth ≤ clientWidth + 1`，实测十帧全 `true`）；`console` / `pageerror` 均为 **0**。
- **footer 三行 `top` 实测**：1512/1240 = `[800, 828, 856]`（h = 93px）；980/760 = `[812, 836, 860]`；430 = `[816, 840, 864]`（h = 81px）。
- **实现侧（后续验证卡执行）**：同五档 × 两主题，与原型并排人工比对；**不做像素 diff**（沿用 R6 的 O7 裁决）。430 档若 headless 下限受限则以机检为准。
- **本契约的实测基线**：原型（改动后）五档 computed style 全量 + 抽屉 open 态；实现侧 1440 / 980 的 computed style。

---

## 7. 机检断言点（`blocks.contract` / `dom-smoke` 可加）

**汇总口径**：按两类分列：`blocks.contract`（结构 / 计数 / 钩子 / 几何）与 `dom-smoke`（计算样式）。**本卡只给点位，不实现断言**；测试文件属实现/验证卡域，本卡不代改 `test/web/**`。

### A. `blocks.contract` 类（结构，16 条）

| # | 项 | 选择器 / 断言 | 期望 |
|---|---|---|---|
| 1 | ① | `count [data-nav] [data-nav-item] svg` | `4` |
| 2 | ① | `count [data-nav] [data-nav-item] svg[data-side-icon]` | `0` |
| 3 | ① | `[data-nav] [data-nav-item] svg` 类集 | 含 `td-icon` |
| 4 | ② | `[data-project] [data-project-count]` 计数 | = `count button[data-project]` 或更少（`null` 行 0 颗） |
| 5 | ② | `count button[data-project][data-project-count]` | `0` |
| 6 | ② | `[data-project] [data-project-count]` `tagName` | `SPAN` |
| 7 | ② | `[data-project] [data-project-count]` 类集 | 含 `td-count` |
| 8 | ③ | `count [data-access-status] [data-access-cell]` | `3` |
| 9 | ③ | 三个 `[data-access-cell]` 内的钩子集 | `{data-theme-switch, data-lang-select, data-access-open}` 各 1，且顺序 theme→language→settings |
| 10 | ③ | `[data-access-status] > *` 计数 | `3`（无第四行） |
| 11 | ③ | `count [data-access-status] [data-access-cell]:not([data-access-cell])` | `0`（防选择器写错） |
| 12 | ③ | 三行 `top` 两两不等（`new Set(tops).size`） | `3` |
| 13 | ④ | `close.parentElement === identifier.parentElement` | `true` |
| 14 | ④ | `close.parentElement` 内 `count [data-detail-identifier]` | `1` |
| 15 | ④ | `[data-detail-close]` 内 `count svg.td-icon` | `>= 1` |
| 16 | ④ | `[data-detail-close] svg.td-icon path` 的 `d` | `M6 6l12 12M18 6 6 18` |

### B. `dom-smoke` 类（计算样式 / 几何，21 条）

| # | 项 | 选择器 → 属性 | 期望 |
|---|---|---|---|
| 1 | ① | `[data-nav] [data-nav-item] svg` → `fill` | `none` |
| 2 | ① | `[data-nav] [data-nav-item] svg` → `stroke-width` | `1.5px` |
| 3 | ① | `[data-nav] [data-nav-item] svg` → `stroke-linecap` / `stroke-linejoin` | `round` / `round` |
| 4 | ① | `[data-nav] [data-nav-item] svg` → `stroke` | = 该项 `[data-nav-item]` 的 `color`（非 `none`） |
| 5 | ① | `[data-nav] [data-nav-item] svg` bbox | `16 × 16`（±1） |
| 6 | ① | rail（980）`[data-nav] [data-nav-item] svg` → `border-top-width` / `background-image` | `0px` / `none` |
| 7 | ② | `[data-project] [data-project-count]` → `width` / `height` | `20px` / `18px` |
| 8 | ② | `[data-project] [data-project-count]` → `border-radius` | `999px` |
| 9 | ② | `[data-project] [data-project-count]` → `font-family` | 含 `mono` |
| 10 | ② | `[data-project] [data-project-count]` → 文本 | `^\d+$`（数字，含 `0`） |
| 11 | ② | rail（980）`[data-project] [data-project-count]` → `display` | `none` |
| 12 | ③ | `[data-access-status]` → `display` / `flex-direction` | `flex` / `column` |
| 13 | ③ | `[data-access-status]` → `grid-template-columns` | `none` |
| 14 | ③ | `[data-access-cell]` `top` 序列（≥1024） | 严格递增（1512 实测 `800, 828, 856`，Δ = 行高） |
| 15 | ③ | `[data-access-cell]` → `width` vs 容器内容宽；`left` vs 容器 `left` | 各 `≤ 1px` 差（全宽行） |
| 16 | ③ | 第 1/2/3 行 → `border-block-start-width` | `0px` / `1px` / `1px` |
| 17 | ③ | 三行 → `border-inline-start-width` | 全 `0px` |
| 18 | ③ | `[data-access-cell]` → `flex-direction`（行内） | `row`（R6 ⑧ 保持） |
| 19 | ③ | rail（980）`[data-access-cell]` → `justify-content` / `gap` / `height` | `center` / `0px` / `24px` |
| 20 | ④ | `[data-detail-close]` → `abs(centerY − identifier.centerY)` | `≤ 2`（原型实测 0，见 R7-1） |
| 21 | ④ | 行容器 `right` − `close.right`；`close.top < title.top` | `≤ 2`；`true` |

### C. 三条「不得断言」的负向注记

1. `[data-detail-close]` 的 computed `margin-inline-start` **不得断言 `auto`** —— 浏览器返回**用后像素值**（原型实测 `335.297px`，见 R7-2）。改断几何（B 表第 21 条）。
2. `[data-detail-close]` 与 `[data-detail-identifier]` 的 bbox `top` **不得断言相等** —— 同行的两盒高度不同（原型实测 Δ = **7px**，见 R7-1）。改断中心线（B 表第 20 条）。
3. `[data-access-status]` 的**容器宽度**在 rail 档**不得断言等于 rail 内容宽** —— 实测 14px（内容宽），是**改动前既有**行为（见 R7-3）。只断行高 / 居中 / label·caret 隐藏。

---

## 8. 文档同步判定

- **`design/prototype/index.html`**：**已改**（理由：① 新增 `data-access-cell` 钩子使契约 selector 在原型可寻址；② footer 注释由「three equal thirds」改为「three stacked full-width rows」；③ 三个 cell 的方位注释由 left/centre/right 改为 top/middle/bottom）。**DOM 顺序未变**（theme → language → settings，与改动前左→右一致）。
- **`design/prototype/src/input.css`**：**已改** —— `.td-access-status` 由 `grid` + `repeat(3, minmax(0,1fr))` + `align-items: stretch` 改为 `flex` + `flex-direction: column`；`.td-access-cell` 由「居中 / gap 6px / padding 0 2px / border-inline-start」改为「flex-start / gap 8px / padding 0 8px / `text-align: start` / 无竖线」；`.td-access-cell:first-child{border-inline-start:0}` 删除，新增 `.td-access-cell + .td-access-cell{border-block-start:1px solid var(--color-td-line)}`（复用既有 `--color-td-line`，**未新造 token**）；≤1023 块内补 `justify-content: center`。注释同步改写。
- **`design/prototype/tw.css`**：**已重建**（`tailwindcss -i src/input.css -o tw.css`，v4.3.3 / daisyUI 5.7.47；`node_modules` 未落 `design/prototype/`，经临时 build 目录 + 瞬时 symlink，构建后已删除）。重建 diff 为 4 处：3 处是本轮的 footer 规则，另 2 处（`.mask`、`.grow`）是**既有源码早已存在、而上一次提交的 `tw.css` 尚未收录**的散在候选（`.mask` 只出现在 SVG `<mask>` 与注释、`grow` 只是 `td-field-grow` 的子串），二者在文档里**无元素命中** ⇒ 惰性规则，无可见影响。详见 lane-report。
- **`design/BLOCKS.md`**：**已改** —— B03「Footer controls」行由「**three equal thirds**（`display: grid`, `repeat(3, minmax(0,1fr))`）… separated by a hairline on the inline start」改为「**three stacked full-width rows**（`display: flex`, `flex-direction: column`），顺序 theme · language · settings，行间横向 hairline（`border-block-start`）」；新增 `[data-access-cell]` 钩子；≤1023 rail 段由「three thirds hold … centred 24px icon」改为「the three rows hold and become centred 24px icon rows」。
- **`design/DESIGN.md`**：**已改** —— 新增 **§23 Review round R7**，记录 ③ 为**显式设计变更**（footer 一行三等格 → 三行堆叠）及其理由与约束；§12「当前态」句改写（`Sidebar footer` 表行 + 「Three equal thirds, each centred.」段 + 「The footer stays three equal thirds down to the smallest width」段，均改为三行堆叠；对历史轮次含冲突断言者只加标注「（已于 R7 变更）」并指向 §23，**不改写 §15/§16/§17 的历史记录**）。
- **`CHANGELOG.md`**：**不加条目**（本卡交付设计契约 + 原型，产品行为变化由实现卡记录）。
- **`design/fidelity-r7.md`**：本文件，新文档。
- **本卡写入面复核**：只写 `design/fidelity-r7.md`（新增）、`design/prototype/index.html`、`design/prototype/src/input.css`、`design/prototype/tw.css`、`design/DESIGN.md`、`design/BLOCKS.md`；**未改 `web/**`、未改 `test/**`**（`web/dist` 只读起服务）。

---

## 9. 口径红线与未覆盖项

**红线（硬）**

1. **禁用行号**：一律「文件:选择器」；跨文档引用只用「文档名 §小节」或 selector。
2. **禁止只写「不一致」**：四项均已逐块枚举（选择器 + 差异 + 归类）。
3. **期望值以原型实测为准**：凡规格所记与实测冲突处，以实测落块契约表，并把冲突记入 §1 的 R7-1 / R7-2 / R7-3。
4. **不改 `web/**`、不改 `test/**`**；`web/dist` 只读。
5. **未实测项显式标注**：② 的 `null` 分支与实现侧主题/语言组合标为**推算/未到场**，不写成结论。

**未覆盖 / 待裁定（非本卡结论）**

| # | 议题 | 现状 | 建议 |
|---|---|---|---|
| **F1** | 实现侧 `.td-iconbtn` 类缺失 | 原型 `[data-detail-close]` 用 `td-iconbtn`（32×32），`web/src/styles/app.css` **无该类** | 契约硬断言以「结构 + `svg.td-icon` + 几何」为准；实现可自定按钮尺寸或补一个等价类，**不照抄类名** |
| **F2** | `[data-access-cell]` 是实现侧新钩子 | 实现当前 **0** 命中 | 实现卡须补（三个 cell 各一）；若实现拒绝补钩子，则 `blocks.contract` 的 ③ 断言须改按 `[data-access-status] > *` 寻址——**须书面偏差** |
| **F3** | rail 档 footer 容器宽 = 内容宽（14px） | 改动前后**一致**（R7-3） | 本卡不动；若产品希望 rail 的 footer 分隔线铺满 64px，须另开设计裁定（会改变 rail 观感） |
| **F4** | footer 变高的侧栏空间 | 桌面 +28px（93px）、rail 由 33 → 81px 高 | 五档均无横向溢出；若在低矮视口（<760 高）出现侧栏竖向滚动，属既有 `overflow-y: auto` 行为，由验证卡记录 |
| **F5** | `tw.css` 重建带入 2 条惰性规则 | `.mask` / `.grow`，无元素命中 | 由「构建产物必须自源重建」的既有政策解释；若要零噪声，须另开一次「重建并清理惰性候选」的提交 |
