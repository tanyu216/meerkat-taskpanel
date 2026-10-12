# UI 保真契约 · R6 — Terry 八项反馈（Before 契约）

> 卡：`T-20261012-192813`（R6 保真契约）· 只产契约，不写实现。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 期望值一律取自**原型**；实现的核对一律**实读复核**。

## 0. 结论摘要（≤14 行）

- 八项**全部落在既有块**（①B02 ②B03 ③B19 ④B07 ⑤B08 ⑥B09 ⑦B03-footer ⑧B03-footer）⇒ 本契约不引入任何新钩子、新块。
- 实证手段：把原型载入真实浏览器（Chromium，1512 / 980 两档，light，en）量 **computed style**，并用 CSSOM 匹配规则核对**级联胜者**；`console` / `pageerror` 均为 `[]`。
- 项① 原型选中态确有高亮（`fg=accent` `bg=surface`）；实现**三处齐缺**（无 `td-tabs` / `td-tab` / 无任何激活绑定）⇒ 完全无高亮，与反馈相符。
- 项② 原型选中 `fg=accent` + `bg=accent-soft`；实现只有灰底（`--brand-active`）+ `font-medium`，**缺 accent 文字色**。
- 项③ 实现是**右侧抽屉** `min(520px,100vw)`，原型是**居中模态**；**且原型模态实宽为 `min(480px, calc(100vw - 32px))`**，非 spec 所记的 `min(920px)`（见 §4 修订 R2）。
- 项④ 实现标题无截断；原型 `-webkit-line-clamp:2` + `overflow:hidden`，实测长标题被**裁到 2 行**（`scrollHeight 94 > clientHeight 38`）。
- 项⑤ 实现无分组壳、无组头、列模板与行部件齐偏（status 是裸 `span`、priority 无 `.td-pri`）。
- 项⑥ 实现只有 daisyUI `badge`，**无 status dot**；**且原型自身 `[data-detail-status-chip]` 的实测色/圆角与 spec 所记不符**（见 §7 修订 R1）。
- 项⑦ 实现壳为 `flex-col`（竖排）⇒ 观感折行；**原型 DOM 层 3 个 `svg[data-theme-icon]` 齐全、同刻 1 个可见**，故「无图标」在 DOM 层不可复现（视觉层未实测，见 §8 F5）。
- 项⑧ 实现壳为 `flex-col`；caret 走 `data-caret` 而无 `.td-caret` 类 ⇒ 原型的 rail 隐藏规则不按类名生效（改由 `[data-sidebar] [data-caret]` 兜底）。
- 共通**根因三缺口**：实现侧无 `--brand-accent` / `--brand-accent-soft` token、无 `.td-chip` / `.td-chip-status` 规则、无 `.td-access-cell` / `.td-caret` / `.td-side-text` 类（token 缺口见 §1）。
- 结论：`design/BLOCKS.md` 主体**无需改动**（§12）；`CHANGELOG.md` **不加**条目；落档仅本文件。

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）。

**定位规则**：一律「**文件:选择器**」，**禁止行号**（`§⑨.1` / `§⑥.1` clause 11）。跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：
1. 「期望计算样式」= 原型在真实浏览器中的 **computed style 实测值**，不是 tw.css 里某条声明的字面值。两者不一致时（原型自身存在同名重复声明），实测值胜，并把该矛盾记入对应 偏离表（归类 `口径`）。
2. 「实现位点」= 实读 `web/src/**` 后的选择器；凡未在浏览器里实测的实现态，标注「未实测」。
3. token 名沿用原型 `--color-td-*` / `--r-*`；实现侧 brand token 名以 `web/src/styles/tokens.css` 为准。

**「实读复核」对本 spec 的修订（4 条，均以浏览器实测为准）**：

- **R1（项⑥，最重要）**：原型 `[data-detail-status-chip]` 实测为**青底药丸**——`bg=accent-soft` / `radius=999px` / `padding=2px 4px 2px 8px` / `font-size=12px` / `fg=ink`。spec §2.6 所记（`bg=surface` / `11px` / `radius=--r-sm` / `fg=ink-2`）是 tw.css 中**较早**那对 `.td-chip` + `.td-chip-status` 的值；同名 `.td-chip` 在 `@layer utilities` 内**被再声明一次且更靠后**，级联胜者为后者（CSSOM `matchedCSSRules` 逐条证实）。这意味着**原型自相矛盾**，与 BLOCKS.md 无关。凡「surface / 11px 小 chip」的期望，须由设计 owner 裁一次（见 §13 F6）。
- **R2（项③）**：原型 `[data-access-panel]` 实测 `width = 480px`（`min(480px, calc(100vw - 32px))`）、`max-height = 720px`。spec §2.3 记的 `min(920px,…)` / `760px` 来自 `.td-states-panel, .td-access-panel` 的**共享规则**，面板自身随后把两条都收窄了。落地建议若照 spec 修成 920px，反而会**偏离原型**。
- **R3（项④）**：原型 `[data-card-title]` 的 `display` 声明是 `-webkit-box`，但 Chromium `getComputedStyle().display` **返回 `flow-root`**（legacy 值的序列化）。故机检**不得断言 `display`**，改断言 `-webkit-line-clamp` + `overflow` + 几何（见 §5）。
- **R4（项⑤）**：`grid-template-columns` 的 computed 值是**已解析的 used 值**（1512 档实测 `74px 648px 108px 132px 96px 72px`），不是声明的 `minmax(0,1fr)` 字面串。机检须按「首/尾列 + 列数」或按容器宽换算断言（见 §6）。

**共用 token 冻结值（原型 light；§2.9 口径）**：`accent`#0f7a73 · `accent-soft`rgba(15,122,115,.1) · `surface`#ffffff · `sunken`#f5f6f7 · `hover`#f0f2f3 · `line`#e6e8eb · `ink`#14181b · `ink-2`#4a555e · `ink-3`#7e8a91。radius：`--r-sm`4px · `--r-md`6px · `--r-lg`8px。status（7）：backlog#6c777e · todo#5a6b75 · in_progress#ac640d · in_review#6e56cf · blocked#c0392b · done#187a4c · canceled#b8c0c5。

**实现侧已确认的 token gap（实读 `web/src/styles/tokens.css`）**：**无** `--brand-accent`（#0f7a73）与 `--brand-accent-soft`（rgba(15,122,115,.1)）；该青值目前只出现在 `--brand-focus-ring` 里。选中/激活用的 `--brand-active` 是灰 `#e6e8eb`。项①②⑥⑧ 的 accent 态全部依赖这个缺口被补上（light + dark 双值），补 token 须同步 `DESIGN.md`（**非本卡**）。

## 2. 项① Top bar board/list 切换选中高亮（B02）

*证据：原型 1512 / 980 两档实测，选中按钮 `aria-pressed="true"`。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B02 · view toggle（`[data-view-toggle]` 子块） |
| 根选择器 | `[data-view-toggle]`（原型 `div.tabs.tabs-box.td-tabs[data-view-toggle][role="group"]`） |
| 状态选择器 | `[data-view-toggle] [data-view="board"][aria-pressed="true"]`（选中）/ `[data-view="list"][aria-pressed="false"]`（未选中）；容器 `[data-view-toggle]`（`.td-tabs`） |
| 期望计算样式-容器 | bg `--color-td-sunken`#f5f6f7 · border `1px solid --color-td-line`#e6e8eb · radius `--r-md`6px · padding 2px · height 32px · `display:flex` |
| 期望计算样式-未选中 | fg `--color-td-ink-2`#4a555e · bg transparent · border 0 · radius `--r-sm`4px · font 12px/500 · height 26px · padding `0 8px` · gap 4px |
| 期望计算样式-选中 | **fg `--color-td-accent`#0f7a73** · **bg `--color-td-surface`#ffffff** · **border `1px solid --color-td-line`#e6e8eb** · radius `--r-sm`4px · font 12px/500 · height 26px |
| 期望计算样式-hover | fg `--color-td-ink`#14181b · bg `--color-td-hover`#f0f2f3 |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 缺 `td-tabs` 壳类 | `web/src/components/shell/TopBar.vue:[data-view-toggle]` | 容器类为 `tabs tabs-box h-8 min-h-8`，**无 `.td-tabs`** ⇒ 无 sunken 底 / line 边 / `--r-md`（容器实测高度 32px 与原型相同，故此项只差配色与圆角） | 缺 |
| 2 | 按钮缺 `td-tab` 类 | `web/src/components/shell/TopBar.vue:[data-view-toggle] button.tab` | 按钮类为 `tab h-full gap-1`，**无 `.td-tab`** ⇒ 无 26px 高 / 12px/500 / `--r-sm` / 选中态规则 | 缺 |
| 3 | **选中态无任何高亮** | `web/src/components/shell/TopBar.vue:[data-view-toggle] button[aria-pressed="true"]` | 实现绑 `aria-pressed`，既未加载 `.td-tab[aria-pressed="true"]`，也未被 daisyUI 命中——daisyUI 的 tab 激活态只认 `.tab-active` / `[aria-selected="true"]` / `[aria-current="true"]` / `[aria-current="page"]`（见 `design/prototype/tw.css:.tabs-lift > .tab:is(.tab-active, [aria-selected="true"], [aria-current="true"], [aria-current="page"])` 一族），**`aria-pressed` 不在其中** ⇒ 选中与未选中视觉全等 | 缺 |
| 4 | 激活语义双轨 | `web/src/components/shell/TopBar.vue:[data-view-toggle]` | 原型只用 `aria-pressed`；实现同样只用 `aria-pressed` ⇒ **本项对齐**，记此行为的是澄清「不是漏绑 daisyUI，而是语义本身不被 daisyUI 消费」 | 对齐 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 容器加 `td-tabs` 类（与 `tabs tabs-box` 并存） | `web/src/components/shell/TopBar.vue:[data-view-toggle]` | 与原型类集一致 |
| 2 | 按钮加 `td-tab` 类 | `web/src/components/shell/TopBar.vue:[data-view-toggle] button[data-view]` | 同上 |
| 3 | 在 `app.css` 补三条规则 `.td-tabs` / `.td-tab` / `.td-tab[aria-pressed="true"]`，值照块契约表 | `web/src/styles/app.css` | 与原型逐值一致 |
| 4 | 二选一：维持 `aria-pressed`（原型口径，**优先**）；或改绑 daisyUI（此时须同时加 `.tab-active` 或改 `aria-current="page"`，并放弃原型配色） | `web/src/components/shell/TopBar.vue:[data-view-toggle] button[data-view]` | 选前者方可沿用品牌 token；选中态 fg/bg 依赖 §1 的 accent token 缺口 |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `count [data-view-toggle] [data-view]` | `2` | blocks.contract |
| 2 | `[data-view-toggle]` computed `background-color` | `== sunken`（#f5f6f7） | dom-smoke |
| 3 | `[data-view-toggle] [data-view][aria-pressed="true"]` computed `color` | `== accent`（#0f7a73） | dom-smoke |
| 4 | `[data-view-toggle] [data-view][aria-pressed="true"]` computed `background-color` | `== surface`（#ffffff） | dom-smoke |
| 5 | `[data-view-toggle] [data-view][aria-pressed="true"]` vs `[aria-pressed="false"]` 的 `color` | **不相等**（选中态可区分） | dom-smoke |
| 6 | `count [data-view-toggle] [data-view][aria-pressed="true"]` | `1` | dom-smoke |

## 3. 项② Sidebar 菜单项选中高亮（B03）

*证据：原型 1512 / 980 两档实测；`[data-nav-item]` 计数 4（board / list / activity / waiting）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B03 · nav |
| 根选择器 | `nav[data-nav]`（原型 `nav.td-nav[data-nav]`）→ 项 `button.td-nav-item[data-nav-item]` |
| 状态选择器 | `[data-nav-item][aria-current="page"]`（选中）；`[data-nav-item]`（基态） |
| 期望计算样式-基态 | fg `--color-td-ink-2`#4a555e · bg transparent · border `1px solid transparent` · radius `--r-md`6px · height 32px · padding `0 8px` · gap 8px · width 100% · text-align left · font 13px/500 |
| 期望计算样式-选中 | **fg `--color-td-accent`#0f7a73** · **bg `--color-td-accent-soft`rgba(15,122,115,.1)**（其余同基态） |
| 期望计算样式-hover | fg `--color-td-ink`#14181b · bg `--color-td-hover`#f0f2f3 |
| 期望计算样式-项目项 | `[data-project][aria-current="page"]` 同款（原型 `.td-side-item[aria-current="page"]` 与 `.td-nav-item` 共用同一条规则） |
| 项数 | `count [data-nav-item]` = **4**（board / list / activity / waiting；C6 已批准冻结基线 3→4） |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 选中底用灰、非 accent-soft | `web/src/components/shell/Sidebar.vue:[data-nav-item][aria-current="page"]` | `aria-[current=page]:bg-(--brand-active)` = `#e6e8eb`（灰）代替 `accent-soft`（青 10%） | 口径 |
| 2 | **缺 accent 文字色** | `web/src/components/shell/Sidebar.vue:[data-nav-item][aria-current="page"]` | 选中项只加 `font-medium`，**无 `text-(--brand-accent)`** ⇒ 文字仍为继承色；原型选中项文字为青 | 缺 |
| 3 | 缺 `td-nav-item` 基类 | `web/src/components/shell/Sidebar.vue:[data-nav-item]` | 无 32px 高 / `--r-md` / 13px/500 / `1px solid transparent` 基样式（改由 Tailwind 工具类近似；高度 32px 由 `py-1` + 行高凑出） | 口径 |
| 4 | 无 `--brand-accent` / `--brand-accent-soft` token | `web/src/styles/tokens.css` | 实现侧**根本没有 accent 青 token**（青值仅见于 `--brand-focus-ring`）⇒ 偏离 1/2 的修复前提 | 缺 |
| 5 | 项目项同款处理 | `web/src/components/shell/Sidebar.vue:[data-project][aria-current="page"]` | 与 `[data-nav-item]` 同源缺失（同一条 Tailwind 串） | 缺 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | `tokens.css` 增 `--brand-accent: #0f7a73` + `--brand-accent-soft: rgba(15,122,115,.1)`（含 dark 值） | `web/src/styles/tokens.css` | **token 缺口**，见 §1；须与 `DESIGN.md` token 章节同步（非本卡） |
| 2 | 选中规则改绑 `aria-[current=page]:bg-(--brand-accent-soft) aria-[current=page]:text-(--brand-accent)` | `web/src/components/shell/Sidebar.vue:[data-nav-item]` | 与原型逐值一致 |
| 3 | 基态补 `h-8 rounded-[6px] border border-transparent text-[13px] font-medium` | `web/src/components/shell/Sidebar.vue:[data-nav-item]` | 与原型 `.td-nav-item` 逐值一致 |
| 4 | 项目项 `[data-project][aria-current="page"]` 同规则 | `web/src/components/shell/Sidebar.vue:[data-project]` | 原型 `.td-side-item[aria-current]` 同款 |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `count [data-nav-item]` | `4` | blocks.contract（DOMAINS.NAV） |
| 2 | `count [data-nav-item][aria-current="page"]` | `1` | dom-smoke |
| 3 | `[data-nav-item][aria-current="page"]` computed `color` | `== accent`（#0f7a73） | dom-smoke |
| 4 | `[data-nav-item][aria-current="page"]` computed `background-color` | `== accent-soft`（rgba(15,122,115,.1)），**≠** `--brand-active` | dom-smoke |
| 5 | `[data-nav-item]` computed `height` | `32px` | dom-smoke |
| 6 | `[data-nav-item]` computed `border-radius` | `6px` | dom-smoke |

## 4. 项③ Access 弹窗（B19）

*证据：原型 1512 / 980 两档实测（脚本内把 `[data-access-panel]` 置为 `data-state="open"` 后量取）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B19 · Access & token settings |
| 根选择器 | `[data-access-panel]`（原型 `section.td-access-panel[data-access-panel][data-state="closed\|open"][role="dialog"][aria-modal="true"][aria-hidden]`，默认带 `hidden`） |
| 状态选择器 | `[data-access-panel][data-state="open"]` / `"closed"`；遮罩 `[data-access-overlay][data-state]` |
| 期望计算样式-面板 | **居中模态**：`position:fixed` · `top:50%` · `left:50%` · `transform:translate(-50%,-50%)` · **`width:min(480px, calc(100vw - 32px))`**（实测 480px）· **`max-height:min(88vh, 720px)`** · bg `--color-td-surface`#ffffff · border `1px solid --color-td-line`#e6e8eb · radius `--r-lg`8px · `box-shadow:--shadow-pop` · `display:flex` · `flex-direction:column` |
| 子块钩子 | 头 `[data-access-close]` · `[data-i18n=access.model.bind]` · `[data-cidr-whitelist][data-cidr-enabled]` → `[data-cidr-list]` → n × `[data-cidr-row]`（`[data-cidr-value]` input + `[data-cidr-remove]`）+ `[data-cidr-add]` · `[data-cidr-switch]`（daisyUI toggle） · `[data-i18n=access.model.token]` · `[data-token-block][data-token-revealed]` → `[data-token-value]` + `[data-token-reveal]`（`[data-token-icon="hidden\|shown"]`）+ `[data-token-copy]` + `[data-token-reset]` · 文案 `access.token.generated` / `.private` |
| token 值口径 | 原型 `[data-token-value]` 文本 = `td_` + **12** 个 `•`（保 `td_` 前缀）；`Reveal` 只切掩码 |
| CIDR 种子 | 原型 3 行：`192.168.0.0/16` · `10.0.0.0/8` · `203.0.113.0/24` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | **形态是右侧抽屉、非居中模态** | `web/src/components/review/AccessPanel.vue:[data-access-panel]` | `fixed end-0 w-[min(520px,100vw)]`（右侧贴边、520px）vs 原型居中模态 480px / `translate(-50%,-50%)` ⇒ 位置、宽度、进入动画三处不同 | 自创 |
| 2 | CIDR **只读**、无增删控件 | `web/src/components/review/AccessPanel.vue:[data-cidr-list]` | 行内 `input` 带 `readonly disabled`；**无 `[data-cidr-add]` / `[data-cidr-remove]`**（M6b ruling O6：无读写路由） | 口径（ruling） |
| 3 | CIDR 第 3 行值不同 | `web/src/components/review/AccessPanel.vue:[data-cidr-row]` | `127.0.0.1/32` vs 原型 `203.0.113.0/24`（BLOCKS.md B19 同样记 `203.0.113.0/24` 为种子值） | 缺 |
| 4 | `[data-cidr-switch]` 为 `disabled` | `web/src/components/review/AccessPanel.vue:[data-cidr-switch]` | 原型可切换（display-only 但可动），实现禁用不可动 | 简化 |
| 5 | token 掩码口径不同 | `web/src/components/review/AccessPanel.vue:[data-token-value]` | 实现掩码 = `token.slice(0,6)` + 18 × `•`（露 `td_` + 3 位、共 24 字符）、reveal 显示**全量明文**；原型掩码恒为 `td_` + 12 `•`、reveal 只切掩码 | 口径 |
| 6 | token reveal 图标为 emoji | `web/src/components/review/AccessPanel.vue:[data-token-icon]` | `<span>🙈/👁</span>` vs 原型内联 `<svg>`（eye / eye-off 路径） | 自创 |
| 7 | 面板无 `aria-labelledby` | `web/src/components/review/AccessPanel.vue:[data-access-panel]` | 用 `:aria-label`；原型用 `aria-labelledby="td-access-title"`（h2 带 id） | 口径 |
| 8 | 多出 `[data-connection-block]` + `[data-resync]` | `web/src/components/review/AccessPanel.vue:[data-connection-block]` | 原型无此块（M6b 自创；surface-disposition #3） | 自创 |
| 9 | 面板几何 | — | **本条计入 R2**：spec 记的原型 `min(920px)` / `760px` 经实测不成立（原型实测 480 / 720） | 口径 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 面板形态改回**居中模态**，几何照块契约表（`min(480px, calc(100vw - 32px))`、`max-height:min(88vh,720px)`、`translate(-50%,-50%)`） | `web/src/components/review/AccessPanel.vue:[data-access-panel]` | **按实测 480px，勿照 spec 的 920px**（R2）；若产品坚持抽屉 ⇒ 须书面偏差并同步 `BLOCKS.md` B19 |
| 2 | CIDR 只读口径**书面偏差**（ruling O6）并在契约注明 | `web/src/components/review/AccessPanel.vue:[data-cidr-list]` | 不加死按钮 |
| 3 | 第 3 行改 `203.0.113.0/24`（或书面偏差） | `web/src/components/review/AccessPanel.vue` ranges | 与原型、BLOCKS.md B19 一致 |
| 4 | token 掩码改 `td_` + 12 `•`，reveal 只切掩码 | `web/src/components/review/AccessPanel.vue:[data-token-value]` | 与原型口径一致 |
| 5 | reveal 图标改内联 `<svg data-token-icon>` | `web/src/components/review/AccessPanel.vue:[data-token-icon]` | 与原型一致 |
| 6 | 换 `aria-labelledby="td-access-title"` 并在标题上落 id | `web/src/components/review/AccessPanel.vue:[data-access-panel]` | 原型口径 |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `[data-access-panel]` | 存在且 `role="dialog"` / `aria-modal="true"` / 默认 `hidden` | blocks.contract |
| 2 | `[data-access-panel][data-state]` | 值 ∈ `{open, closed}` | blocks.contract |
| 3 | `count [data-cidr-row]` | `3` | dom-smoke |
| 4 | `[data-token-value]` 文本 | 匹配 `^td_•+$`（掩码口径：`td_` 前缀 + 纯 `•`） | dom-smoke |
| 5 | `[data-access-panel][data-state="open"]` computed `transform` | 含 `-50%` 平移（`matrix` 的 e/f 为负宽高的一半） | dom-smoke |
| 6 | `[data-access-panel][data-state="open"]` computed `width` | `<= 480px` 且 `== min(480, 视口 - 32)` | dom-smoke |
| 7 | `[data-cidr-add]` / `[data-cidr-remove]` | 按 ruling O6：**允许缺席**（不设 `min`）；若 O6 被驳回 ⇒ 反向断言存在 | blocks.contract（条件） |

## 5. 项④ 卡片标题两行截断（B07）

*证据：原型实测；另注入一段超长标题实测其被裁到 2 行（`clientHeight 38px` / `scrollHeight 94px` / `line-height 18.9px`）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B07 · Card（标题元素） |
| 根选择器 | `[data-card-title]`（原型 `button.td-card-title[data-card-title]`） |
| 状态选择器 | `[data-card-title]`（基态）；父态 `[data-card][data-done="true"] [data-card-title]` / `[data-card][data-canceled="true"] [data-card-title]` |
| 期望计算样式 | `display:-webkit-box`（**computed 序列化为 `flow-root`，见 R3**）· `-webkit-line-clamp:2` · `-webkit-box-orient:vertical` · `overflow:hidden` · `width:100%` · `margin:2px 0 0` · `padding:0` · font 14px/500 · line-height 1.35 · fg `--color-td-ink`#14181b · text-align left · bg transparent · border 0 |
| 变体 | done ⇒ fg `--color-td-ink-3`#7e8a91；canceled ⇒ fg ink-3 + `text-decoration:line-through` |
| 几何判据 | 当标题超过 2 行时：`clientHeight ≈ 2 × line-height`，且 `scrollHeight > clientHeight` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | **无两行截断** | `web/src/components/board/Card.vue:[data-card-title]` | 类为 `p-0 text-left text-[14px] border-0 bg-transparent text-inherit cursor-pointer`：**无 `line-clamp` / `-webkit-box` / `overflow-hidden`** ⇒ 标题可无限换行 | 缺 |
| 2 | 缺标题级 done/canceled 变体 | `web/src/components/board/Card.vue:[data-card-title]`（父态） | 实现只在卡片层有 `.td-card[data-done="true"], .td-card[data-canceled="true"] { opacity: .72 }`（见 `web/src/styles/app.css:.td-card[data-done="true"]`），**标题的 ink-3 / line-through 两条规则不存在** | 缺 |
| 3 | 无 `margin-top` | `web/src/components/board/Card.vue:[data-card-title]` | 原型 `margin:2px 0 0`；实现无上外边距 ⇒ 与上方头行的间距少 2px | 口径 |
| 4 | `data-done` / `data-canceled` 已具备 | `web/src/components/board/Card.vue:[data-card]` | 卡片确实按 `task.status` 输出 `data-done` / `data-canceled` ⇒ 变体规则**有挂载点**，只差规则本身 | 对齐 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 标题加 `line-clamp-2`（Tailwind 即 `display:-webkit-box` + `-webkit-box-orient:vertical` + `-webkit-line-clamp:2` + `overflow:hidden` 的组合；等价于原型声明）。若组件内不便，则在 `app.css` 落 `.td-card-title` 规则 | `web/src/components/board/Card.vue:[data-card-title]` | 值照块契约表；`display` 勿写断言（R3） |
| 2 | 补 `mt-0.5`（2px） | 同上 | 与原型 `margin:2px 0 0` 一致 |
| 3 | 补 done/canceled 标题变体规则（ink-3 / + line-through） | `web/src/styles/app.css` 或组件内 | 选择器用 `[data-card][data-done="true"] [data-card-title]`（挂载点已存在） |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `[data-card-title]` computed `-webkit-line-clamp` | `2` | dom-smoke |
| 2 | `[data-card-title]` computed `overflow` | `hidden` | dom-smoke |
| 3 | `[data-card-title]` computed `width` | `100%`（等于卡片内容宽） | dom-smoke |
| 4 | 长标题（>2 行）元素 | `scrollHeight > clientHeight` 且 `clientHeight ≈ 2 × line-height` | dom-smoke |
| 5 | `[data-card-title]` computed `display` | **不断言**（Chromium 序列化为 `flow-root`，R3） | — |
| 6 | `[data-card][data-done="true"] [data-card-title]` computed `color` | `== ink-3`（#7e8a91） | dom-smoke |

## 6. 项⑤ List 视图（B08）

*证据：原型实测（脚本内把 `[data-list]` 显隐互换、并把 `template[data-list-row-template]` 克隆 3 行后量取）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B08 · List view |
| 根选择器 | `section.td-list[data-list]`（与 `[data-board]` 互斥；原型默认带 `hidden`） |
| 状态选择器 | `[data-list][hidden]`（board 视图）/ 无 `hidden`（list 视图）；骨架 `[data-skeleton]` |
| 期望计算样式-分组壳 | `section.td-list` → `.td-list-group`：bg `--color-td-surface`#ffffff · border `1px solid --color-td-line`#e6e8eb · radius `--r-lg`8px · `overflow:hidden` |
| 期望计算样式-组头 | `.td-list-head`：height 32px · `display:flex` · `align-items:center` · padding `0 12px` · font 11px/500 · letter-spacing .06em（实测 0.66px）· uppercase · fg `--color-td-ink-3`#7e8a91 · bg `--color-td-sunken`#f5f6f7 · border-bottom `1px solid --color-td-line` |
| 期望计算样式-行 | `.td-list-row`：`display:grid` · `grid-template-columns: 74px minmax(0,1fr) 108px 132px 96px 72px` · `gap:12px` · `align-items:center` · `min-height:40px` · padding `0 12px` · border-top `1px solid --color-td-line`（首行无） |
| 行部件 | `[data-list-identifier]`(mono) · `[data-list-title]`(截断) · `[data-list-status]` → chip(`badge-sm td-chip td-chip-status`) + `span.td-status-dot` + `[data-list-status-label]` · `[data-list-assignee]` · `[data-list-priority]` ≈ `.td-pri` · `[data-list-revision]`(mono) |
| 模板 | `template[data-list-row-template]` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 无分组壳 `.td-list-group` | `web/src/components/board/ListView.vue:[data-list]` | 根是 `div.p-3`，平铺无 surface 壳 / line 边 / `--r-lg` 卡片 | 缺 |
| 2 | **无组头 `.td-list-head`** | `web/src/components/board/ListView.vue:[data-list]` | 原型有 sundered 底 + uppercase 的表头行（如 `ID`）；实现无 | 缺 |
| 3 | 列模板不同 | `web/src/components/board/ListView.vue:[data-list-row]` | `grid-cols-[92px_minmax(0,1fr)_auto_auto_auto_auto] gap-3 p-2` vs 原型 `74px minmax(0,1fr) 108px 132px 96px 72px` / `gap:12px` / `padding:0 12px` | 口径 |
| 4 | 行无 `.td-list-row` 类 | `web/src/components/board/ListView.vue:[data-list-row]` | 无 `min-height:40px` / `border-top` 规则；实现用 `border-b`（**下边框**）而原型用 `border-top`（上边框、首行去边） | 口径 |
| 5 | 行元素类型不同 | `web/src/components/board/ListView.vue:[data-list-row]` | 实现是 `<button>`（`aria-selected` 载体）；原型模板行是 `<div>` | 口径 |
| 6 | status 未用 chip | `web/src/components/board/ListView.vue:[data-list-status]` | 裸 `<span>` + `[data-list-status-label]`，**无 `badge-sm td-chip td-chip-status`、无 `span.td-status-dot`** | 缺 |
| 7 | priority 未用 `.td-pri` | `web/src/components/board/ListView.vue:[data-list-priority]` | 纯文本标签，无 `.td-pri` 域样式（卡片侧 `web/src/components/board/Card.vue:[data-card-priority]` 有 `.td-pri`，列表侧没有） | 缺 |
| 8 | skeleton 列不同 | `web/src/components/board/ListView.vue:[data-skeleton]` | 骨架用与真行相同的 `grid-cols-[92px_minmax(0,1fr)_auto_auto_auto_auto] gap-3 p-2`；原型骨架行是 `.td-list-row.is-skeleton`（沿用 74px 模板） | 口径 |
| 9 | 行部件钩子齐全 | `web/src/components/board/ListView.vue:[data-list-rows]` | 六个 `[data-list-*]` 钩子均在（与原型同构） | 对齐 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 引入 `.td-list-group` / `.td-list-head` / `.td-list-row` 三条规则，值照块契约表 | `web/src/styles/app.css` + `web/src/components/board/ListView.vue` | 或等价 Tailwind，但**类名与取值须可机检** |
| 2 | 列模板对齐 `74px minmax(0,1fr) 108px 132px 96px 72px`、`gap:12px`、`padding:0 12px`、`min-height:40px` | `web/src/components/board/ListView.vue:[data-list-row]` | 与原型逐值一致；机检须知 R4（computed 为 used 值） |
| 3 | 行边框改 `border-top`（首行去边） | 同上 | 与原型一致 |
| 4 | status 部件改用 chip + dot、priority 改用 `.td-pri` | `web/src/components/board/ListView.vue:[data-list-status]` / `[data-list-priority]` | 复用 ⑥ 的 chip 体系；**chip 取值以 §7 的 R1 裁定为准** |
| 5 | 补组头行（`ID` 等列名，随 `list.columns.*` i18n 走） | `web/src/components/board/ListView.vue:[data-list]` | 与原型一致 |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `count [data-list]` | `1`，且 `[data-list][hidden]` 与 `[data-board]` 互斥 | blocks.contract |
| 2 | 行部件钩子 `[data-list-identifier]` / `[data-list-title]` / `[data-list-status]` / `[data-list-assignee]` / `[data-list-priority]` / `[data-list-revision]` | 各 `>= 1` | blocks.contract |
| 3 | `count .td-list-group` | `>= 1` | blocks.contract |
| 4 | `count .td-list-head`（或 `[data-list-head]`） | `>= 1` | blocks.contract |
| 5 | `[data-list-row]` computed `display` | `grid` | dom-smoke |
| 6 | `[data-list-row]` computed `grid-template-columns` | 首列 `74px`、末列 `72px`、共 6 轨（中轨为 used 像素值，见 R4） | dom-smoke |
| 7 | `[data-list-row]` computed `min-height` | `40px` | dom-smoke |
| 8 | `[data-list-status] .td-status-dot` | `count == 1` | dom-smoke |

## 7. 项⑥ 抽屉 status badge（B09）

*证据：原型实测 + CSSOM `matchedCSSRules` 逐条核对级联胜者（详见 R1）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B09 · drawer head（status chip 子块） |
| 根选择器 | `[data-detail-status-chip]`（原型 `span.badge.badge-sm.td-chip.td-chip-status[data-detail-status-chip][data-status]`） |
| 状态选择器 | `[data-detail-status-chip][data-status="backlog\|todo\|in_progress\|in_review\|blocked\|done\|canceled"]` |
| 期望计算样式（**实测**） | 壳：height 18px · `display:flex` · `align-items:center` · gap 4px · `padding:2px 4px 2px 8px` · font 12px/500 · line-height 12px · fg `--color-td-ink`#14181b · bg `--color-td-accent-soft`rgba(15,122,115,.1) · border `1px solid --color-td-line`#e6e8eb · radius **999px** |
| 期望计算样式（**spec 版**，与实测冲突） | 壳：height 18px · `padding:0 6px` · font 11px/500 · line-height 1 · fg `--color-td-ink-2`#4a555e · bg `--color-td-surface`#ffffff · border `1px solid --color-td-line` · radius `--r-sm`4px |
| dot 子部件 | `span.td-status-dot[aria-hidden]`：**6×6px**（`.td-chip-status .td-status-dot` 覆盖基类 8×8；与 spec 一致，两条口径都成立） · `border-radius:999px` · bg `var(--status-color)`（按 `data-status` 映射） |
| 标签子部件 | `[data-detail-status-chip-label]` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 仅 `badge`，缺 `badge-sm td-chip td-chip-status` | `web/src/components/detail/DetailDrawer.vue:[data-detail-status-chip]` | 类只有 `badge` ⇒ 无 18px 高 / 11–12px 字 / chip 底色 / line 边 / `--r-sm`（全用 daisyUI `badge` 默认：`--radius-selector` 圆角、`--size` 高度、`--badge-bg/fg`） | 缺 |
| 2 | **无 status dot 子元素** | `web/src/components/detail/DetailDrawer.vue:[data-detail-status-chip]` | 原型 chip 内有 `span.td-status-dot`（6×6、按 `data-status` 着色）；实现只有 `[data-detail-status-chip-label]` | 缺 |
| 3 | 缺 `.td-chip` / `.td-chip-status` 规则 | `web/src/styles/app.css` | 实现侧**无这两条规则**（`.td-status-dot` 有，chip 无） | 缺 |
| 4 | `.td-status-dot` 尺寸口径 | `web/src/styles/app.css:.td-status-dot` | 实现为 `size-2`（**8px**），原型在 chip 内是 **6px** ⇒ 若直接复用会把 dot 放大 2px，须补 chip 作用域下的 6px 覆盖 | 口径 |
| 5 | **原型自身两套 chip 值（R1）** | `design/prototype/tw.css:.td-chip` | 同一 `@layer utilities` 内 `.td-chip` 被声明两次且后者更靠后 ⇒ 原型实测落在**青底药丸**一套上；spec 的 surface/11px/4px 一套实际上**不生效** | 口径 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | chip 加 `badge-sm td-chip td-chip-status` | `web/src/components/detail/DetailDrawer.vue:[data-detail-status-chip]` | 与原型类集一致 |
| 2 | 在 label 前插入 `span.td-status-dot[aria-hidden]` | 同上 | 复用既有 `.td-status-dot`（`web/src/styles/app.css`） |
| 3 | 在 `app.css` 补 `.td-chip` + `.td-chip-status` + `.td-chip-status .td-status-dot{width:6px;height:6px}` | `web/src/styles/app.css` | **取值待 R1 裁定**：取实测药丸一套（accent-soft / 999px / 12px）还是 spec 的 rounded-rect 一套；未裁定前**不要**照 spec 值实现 |
| 4 | 补 accent token（同 §3 建议 1） | `web/src/styles/tokens.css` | 药丸一套的底色依赖 `--brand-accent-soft` |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `[data-detail-status-chip]` | 类集含 `badge-sm` / `td-chip` / `td-chip-status` | dom-smoke |
| 2 | `[data-detail-status-chip] .td-status-dot` | `count == 1` | dom-smoke |
| 3 | `[data-detail-status-chip]` computed `height` | `18px` | dom-smoke |
| 4 | `[data-detail-status-chip][data-status]` | 值 ∈ 7 态闭集 | blocks.contract |
| 5 | `[data-detail-status-chip] .td-status-dot` computed 宽/高 | `6px` / `6px` | dom-smoke |
| 6 | `[data-detail-status-chip]` computed `background-color` / `border-radius` | **待 R1 裁定后固定**（实测口径：`accent-soft` / `999px`） | dom-smoke（条件） |

## 8. 项⑦ 主题切换格（B03 sidebar footer）

*证据：原型实测（1512 + 980 两档；980 落 ≤1023px rail）。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B03 · sidebar footer（`[data-access-status]` 三等分，左格） |
| 根选择器 | `[data-theme-switch]`（原型 `button.td-access-cell[data-theme-switch][data-theme-mode]`） |
| 状态选择器 | `[data-theme-switch][data-theme-mode="light\|dark\|auto"]`；图标 `[data-theme-icon="light\|dark\|auto"]`（同刻仅 1 个可见，另 2 个 `[hidden]`）；标签 `[data-theme-label]` |
| 期望计算样式-壳 | `display:flex` · `flex-direction:row` · `align-items:center` · `justify-content:center` · gap **6px** · height **28px** · `padding:0 2px` · **`width:100%`** · font **12px**/500 · fg `--color-td-ink-2`#4a555e · bg transparent · `border:0` · `border-inline-start:1px solid --color-td-line`（`.td-access-cell:first-child` 时该边为 `0`） · radius `--r-sm`4px |
| 期望计算样式-图标 | `svg.td-icon.td-icon-sm` 14×14 · `stroke:currentColor` · `stroke-width:1.5` · 非当前态 `[hidden]` ⇒ `display:none` |
| 期望计算样式-标签 | `span.td-side-text`：`min-width:0` · `overflow:hidden` · `text-overflow:ellipsis` · `white-space:nowrap` |
| 期望计算样式-hover / focus | hover：fg `--color-td-ink` · bg `--color-td-hover`#f0f2f3；`:focus-visible`：`outline:2px solid --color-td-accent` · `outline-offset:-2px` |
| 期望计算样式-rail（≤1023px） | `.td-access-cell{gap:0; height:24px; padding:0}` · 文本标签 `display:none` |
| 语义 | 三态循环（**无 `aria-pressed`**）；`data-theme-mode` 镜像到 `<html>`；`[data-theme-label]` ∈ en `{Light, Dark, Auto}` / zh `{浅色, 深色, 自动}` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 壳竖排（`flex-col`） | `web/src/components/shell/SidebarFooter.vue:[data-theme-switch]` | `flex flex-col items-center gap-0.5 px-1 py-2` ⇒ 图标与标签**上下堆叠**；原型 `flex-direction:row` gap 6px height 28px | 缺 |
| 2 | 缺 `.td-access-cell` 类 | `web/src/components/shell/SidebarFooter.vue:[data-theme-switch]` | 无 28px 高 / gap 6px / `border-inline-start` 分隔线 / hover bg / focus outline / `--r-sm` | 缺 |
| 3 | 字号与内距 | 同上 | 实现 `text-[11px]`（原型 12px）、`px-1 py-2`（原型 `padding:0 2px`）、`gap-0.5` = 2px（原型 6px） | 口径 |
| 4 | 标签用 `data-side-text`（无 `.td-side-text` 类） | `web/src/components/shell/SidebarFooter.vue:[data-theme-switch] span[data-theme-label]` | 原型的省略号 / nowrap 规则不按类名生效；实现靠 rail 媒体查询 `display:none`，**不是省略** | 口径 |
| 5 | **DOM 层 3 个图标与原型同构** | `web/src/components/shell/SidebarFooter.vue:[data-theme-switch] svg[data-theme-icon]` | `v-for="mode in modes" :hidden="themeMode !== mode"` ⇒ 3 个 `svg[data-theme-icon]` 均在 DOM，同刻 1 个可见（另有 `web/src/styles/app.css:svg[data-theme-icon][hidden]{display:none}` 兜底）⇒ Elon 转述的「实现报无对应图标」在 **DOM 层不可复现** | 对齐 |
| 6 | `data-theme-mode` 镜像 | `web/src/components/shell/SidebarFooter.vue:[data-theme-switch][data-theme-mode]` | 实现同步输出 `data-theme-mode` ⇒ 与原型同构 | 对齐 |
| 7 | rail 档格指标缺 | `web/src/styles/app.css` | 无 `.td-access-cell{gap:0;height:24px;padding:0}` 等价规则（壳未用该类） | 缺 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 壳改横排并加 `td-access-cell` 类（或等价 `flex flex-row items-center justify-center gap-[6px] h-7 px-0.5 text-[12px]`） | `web/src/components/shell/SidebarFooter.vue:[data-theme-switch]` | 值与原型逐项一致 |
| 2 | 标签改 `td-side-text` 类（保留 `data-side-text`） | 同上 `span[data-theme-label]` | 省略号 / nowrap 生效 |
| 3 | rail（≤1023px）补 `.td-access-cell{gap:0;height:24px;padding:0}` | `web/src/styles/app.css` | 与原型 rail 块逐值一致 |
| 4 | 浏览器实测复核「图标是否可见」并记录结论 | —（浏览器） | 见 F5：DOM 层已证 3 个图标在；**视觉层本卡未实测** |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `count [data-theme-switch]` | `1` | blocks.contract |
| 2 | `count [data-theme-switch] svg[data-theme-icon]` | `3` | dom-smoke |
| 3 | `count [data-theme-switch] svg[data-theme-icon]:not([hidden])` | `1` | dom-smoke |
| 4 | `[data-theme-switch]` computed `flex-direction` | `row` | dom-smoke |
| 5 | `[data-theme-switch]` computed `gap` | `6px` | dom-smoke |
| 6 | `[data-theme-switch]` computed `height` | `28px` | dom-smoke |
| 7 | `[data-theme-label]` 文本 | ∈ en `{Light, Dark, Auto}` / zh `{浅色, 深色, 自动}` | dom-smoke |
| 8 | 视口 980 `[data-theme-switch]` computed `height` / `gap` | `24px` / `0px`（rail） | dom-smoke |

## 9. 项⑧ 语言切换格（B03 sidebar footer）

*证据：原型实测（1512 + 980 两档）；菜单选中态取自 `[data-lang-option][aria-pressed="true"]`。*

**块契约表**

| 项 | 值 |
|---|---|
| 块 id | B03 · sidebar footer（`[data-access-status]` 三等分，中格） |
| 根选择器 | `[data-lang-select]`（原型 `button.td-access-cell[data-lang-select]`） |
| 状态选择器 | `[data-lang-select][aria-expanded="true\|false"]`；子：globe `svg.td-icon.td-icon-sm` · `[data-lang-label]` · **`svg.td-caret`（原型只用类名，无 `data-caret` 属性）**；菜单 `[data-lang-menu]`（`hidden` 切换）→ `[data-lang-option="en\|zh"]` |
| 期望计算样式-壳 | 同 `.td-access-cell`：`display:flex` · `flex-direction:row` · `align-items:center` · `justify-content:center` · gap 6px · height 28px · `padding:0 2px` · `border-inline-start:1px solid --color-td-line`（中格**有**该边） · radius `--r-sm`4px · font 12px/500 · fg `--color-td-ink-2` · bg transparent |
| 期望计算样式-caret | `.td-caret`：`flex:none` · `color:--color-td-ink-3`#7e8a91 · 14×14 |
| 期望计算样式-标签 | `[data-lang-label]` 用 `td-side-text`：nowrap + ellipsis |
| 期望计算样式-rail（≤1023px） | `.td-access-cell{gap:0;height:24px;padding:0}` + **`.td-caret{display:none}`** + 文本 `display:none` |
| 期望计算样式-菜单 | `[data-lang-menu]`：`min-width:148px`；`[data-lang-option][aria-pressed="true"]` fg `--color-td-accent` · bg `--color-td-accent-soft`；`.td-lang-check` 默认 `visibility:hidden`、选中态 `visible` |
| 语义 | trigger `aria-haspopup="menu"` + `aria-expanded`；`[data-lang-label]` ∈ `{EN, 中文}` |

**实现偏离表**

| # | 偏离点 | 实现位点（文件:选择器） | 行为差异 | 归类 |
|---|---|---|---|---|
| 1 | 壳竖排（`flex-col`） | `web/src/components/shell/SidebarFooter.vue:[data-lang-select]` | globe / label / caret **纵向三行**（观感「折行」）；原型单行横排 | 缺 |
| 2 | 缺 `.td-access-cell` 类 | 同上 | 无 28px 高 / gap 6px / hover / focus / `--r-sm`（分隔线已由 `border-s border-s-(--brand-border)` 近似到位） | 缺 |
| 3 | 字号与内距 | 同上 | `text-[11px]` / `px-1 py-2` / `gap-0.5` vs 原型 12px / `padding:0 2px` / gap 6px | 口径 |
| 4 | caret 用 `data-caret`（无 `.td-caret` 类） | `web/src/components/shell/SidebarFooter.vue:[data-lang-select] svg[data-caret]` | 样式走 `size-3.5 shrink-0 text-(--brand-text-3)`；因无 `.td-caret`，原型 rail 的 `.td-caret{display:none}` **不适用**；现由 `web/src/styles/app.css` 的 `@media (max-width:1023px)` 里 `[data-sidebar] [data-caret]{display:none}` 兜底 ⇒ **功能等价、类名口径不同** | 口径 |
| 5 | 标签用 `data-side-text`（无 `.td-side-text` 类） | `web/src/components/shell/SidebarFooter.vue:[data-lang-select] span[data-lang-label]` | 省略号规则不按类名生效（rail 仍 `display:none`） | 口径 |
| 6 | 菜单选中态无 accent 底 | `web/src/components/shell/SidebarFooter.vue:[data-lang-menu] [data-lang-option]` | 选中用 `text-primary font-medium`，**无 `bg-(--brand-accent-soft)`**；原型为 accent 文字 + accent-soft 底 | 口径 |
| 7 | 菜单选中 check 用 `visible/invisible` | 同上 | 与原型 `visibility` 口径一致 | 对齐 |
| 8 | `aria-haspopup` / `aria-expanded` | `web/src/components/shell/SidebarFooter.vue:[data-lang-select]` | 实现齐备（`aria-haspopup="menu"` + `:aria-expanded`） | 对齐 |

**落地建议表**

| # | 建议（类名 / 规则 / token） | 作用位点（文件:选择器） | 备注 |
|---|---|---|---|
| 1 | 壳改横排并加 `td-access-cell` 类（或等价 `flex flex-row items-center justify-center gap-[6px] h-7 px-0.5 text-[12px]`） | `web/src/components/shell/SidebarFooter.vue:[data-lang-select]` | 与原型逐项一致 |
| 2 | caret 改 `td-caret` 类（保留 `data-caret`） | 同上 `svg[data-caret]` | rail `display:none` 改由类口径承担 |
| 3 | 标签改 `td-side-text` 类（保留 `data-side-text`） | 同上 `span[data-lang-label]` | 省略号生效 |
| 4 | rail（≤1023px）补 `.td-access-cell{gap:0;height:24px;padding:0}` | `web/src/styles/app.css` | 与原型 rail 块逐值一致 |
| 5 | 菜单选中态改 `aria-pressed="true"` → `bg-(--brand-accent-soft) text-(--brand-accent)` | `web/src/components/shell/SidebarFooter.vue:[data-lang-menu] [data-lang-option]` | 依赖 §1 的 accent token 缺口 |
| 6 | 整格标签走 `td-access-cell` 后，`border-inline-start` 由类承担，可去掉 `border-s-(--brand-border)` | 同上 | 避免双重来源 |

**本项机检断言点表**

| # | 选择器 | 期望 | 归属（blocks.contract / dom-smoke） |
|---|---|---|---|
| 1 | `count [data-lang-select]` | `1` | blocks.contract |
| 2 | `[data-lang-select]` computed `flex-direction` | `row` | dom-smoke |
| 3 | `[data-lang-select]` computed `gap` | `6px` | dom-smoke |
| 4 | `[data-lang-select]` 子节点顺序 | `svg → [data-lang-label] → svg.td-caret`（横排三段） | dom-smoke |
| 5 | 视口 980 `[data-lang-select] svg.td-caret` computed `display` | `none` | dom-smoke |
| 6 | `[data-lang-option][aria-pressed="true"]` computed `background-color` | `== accent-soft` | dom-smoke |
| 7 | `[data-lang-option][aria-pressed="true"] .td-lang-check` computed `visibility` | `visible` | dom-smoke |
| 8 | `[data-lang-label]` 文本 | ∈ `{EN, 中文}` | dom-smoke |

## 10. 机检断言点（blocks.contract / dom-smoke 可加）

**汇总口径**：§2–§9 各表的断言点按两类分列。`blocks.contract`（结构 / 计数 / 域）与 `dom-smoke`（计算样式）。**本卡只给点位，不实现断言**；实现落 M2b / E2a，测试文件属 Linus / Turing 域，本卡不代改 `test/web/**`。

**A. `blocks.contract` 类（结构，13 条）**

| # | 项 | 选择器 / 断言 | 期望 |
|---|---|---|---|
| 1 | ① | `count [data-view-toggle] [data-view]` | `2` |
| 2 | ② | `count [data-nav-item]` | `4`（DOMAINS.NAV） |
| 3 | ③ | `[data-access-panel]` | 有 `role="dialog"` + `aria-modal="true"`，默认 `hidden` |
| 4 | ③ | `[data-access-panel][data-state]` | ∈ `{open, closed}` |
| 5 | ③ | `[data-cidr-add]` / `[data-cidr-remove]` | 按 ruling O6 允许缺席；驳回则反向断言存在 |
| 6 | ⑤ | `count [data-list]` | `1`，且与 `[data-board]` 显隐互斥 |
| 7 | ⑤ | 行部件 `[data-list-identifier\|title\|status\|assignee\|priority\|revision]` | 各 `>= 1` |
| 8 | ⑤ | `count .td-list-group` / `count .td-list-head` | 各 `>= 1` |
| 9 | ⑥ | `[data-detail-status-chip][data-status]` | 值 ∈ 7 态闭集 |
| 10 | ⑦ | `count [data-theme-switch]` | `1` |
| 11 | ⑧ | `count [data-lang-select]` | `1` |
| 12 | ⑧ | `[data-lang-select]` | 有 `aria-haspopup="menu"` |
| 13 | ⑦⑧ | `[data-access-status]` 直接子格 | `3`（三等分） |

**B. `dom-smoke` 类（计算样式，28 条）**

| # | 项 | 选择器 → 属性 | 期望 |
|---|---|---|---|
| 1 | ① | `[data-view-toggle]` → `background-color` | sunken #f5f6f7 |
| 2 | ① | `…[aria-pressed="true"]` → `color` | accent #0f7a73 |
| 3 | ① | `…[aria-pressed="true"]` → `background-color` | surface #ffffff |
| 4 | ① | 选中 vs 未选中 `color` | 不相等 |
| 5 | ① | `count …[aria-pressed="true"]` | `1` |
| 6 | ② | `[data-nav-item][aria-current="page"]` → `color` | accent |
| 7 | ② | `[data-nav-item][aria-current="page"]` → `background-color` | accent-soft，≠ `--brand-active` |
| 8 | ② | `[data-nav-item]` → `height` / `border-radius` | 32px / 6px |
| 9 | ② | `count [data-nav-item][aria-current="page"]` | `1` |
| 10 | ③ | `[data-access-panel][data-state="open"]` → `transform` | 含 `-50%` 平移 |
| 11 | ③ | `[data-access-panel][data-state="open"]` → `width` | `min(480, 视口-32)` |
| 12 | ③ | `count [data-cidr-row]` | `3` |
| 13 | ③ | `[data-token-value]` 文本 | `^td_•+$` |
| 14 | ④ | `[data-card-title]` → `-webkit-line-clamp` | `2` |
| 15 | ④ | `[data-card-title]` → `overflow` | `hidden` |
| 16 | ④ | 长标题 `scrollHeight > clientHeight` | `true` |
| 17 | ④ | `[data-card][data-done="true"] [data-card-title]` → `color` | ink-3 #7e8a91 |
| 18 | ⑤ | `[data-list-row]` → `display` | `grid` |
| 19 | ⑤ | `[data-list-row]` → `grid-template-columns` | 首 `74px` / 末 `72px` / 6 轨（R4） |
| 20 | ⑤ | `[data-list-row]` → `min-height` | `40px` |
| 21 | ⑤ | `[data-list-status] .td-status-dot` | `count == 1` |
| 22 | ⑥ | `[data-detail-status-chip]` 类集 | 含 `badge-sm` / `td-chip` / `td-chip-status` |
| 23 | ⑥ | `[data-detail-status-chip] .td-status-dot` → 宽/高 | 6px / 6px |
| 24 | ⑥ | `[data-detail-status-chip]` → `height` | `18px` |
| 25 | ⑦ | `[data-theme-switch]` → `flex-direction` / `gap` / `height` | row / 6px / 28px |
| 26 | ⑦ | `count svg[data-theme-icon]` 与 `:not([hidden])` | `3` / `1` |
| 27 | ⑧ | `[data-lang-select]` → `flex-direction` / `gap`；子序 | row / 6px / `svg→label→caret` |
| 28 | ⑧ | `[data-lang-option][aria-pressed="true"]` → `background-color` / `.td-lang-check` `visibility` | accent-soft / visible |

**C. 三条「不得断言」的负向注记**

1. `[data-card-title]` computed `display` —— Chromium 把 legacy `-webkit-box` 序列化为 `flow-root`（R3）。
2. `[data-list-row]` computed `grid-template-columns` 的**字面串** —— computed 返回 used 像素值（R4）。
3. `[data-detail-status-chip]` 的 `background-color` / `border-radius` —— **在 R1 裁定前**不得固定（原型自相矛盾）。

## 11. 截图对比口径

- **视口**：1512 / 1240 / 980 / 760 / 430。**430 档 headless 下限为 500**，故 430 档以**机检为准、无截图**（O4 既定裁决）。
- **主题**：light + dark（`<html data-theme>` = `meerkat-taskpanel` / `dark`）。
- **语言**：en + zh。
- **每项关键态**：
  - ① toggle 两态（board 选中 / list 选中）。
  - ② nav 四个目的地各自选中态（board / list / activity / waiting）。
  - ③ Access 面板 `data-state="open"`（light/dark × en/zh），另附 CIDR 与 token 块各一张。
  - ④ 含超长标题的卡片（须能看出截断为 2 行）。
  - ⑤ list 视图整页（含组头、行、status chip、priority）。
  - ⑥ 抽屉 open、七个 status 值各一张（backlog / todo / in_progress / in_review / blocked / done / canceled）。
  - ⑦ 主题格三态（light / dark / auto）+ 980 rail 一张。
  - ⑧ 语言格两态（en / zh 触发）+ 菜单展开一张 + 980 rail（caret 应消失）一张。
- **对比方式**：原型与 Vue **同视口 / 同主题 / 同语言**并排人工比对；**不做像素 diff**（结构 + 几何 + 人工，沿用 O7 裁决）。
- **硬门**：`console` / `pageerror` 为 `[]`；五档均无横向溢出。
- **本契约的实测基线**：原型在 Chromium / 1512 与 980 / light / en 下的 computed style（本次载入 `console`+`pageerror` 均为 `[]`）；本卡**未产出截图**，故 ⑦ 的「图标是否可见」等**视觉层结论标注「未实测」**。

## 12. 文档同步判定

- **`design/BLOCKS.md`**：**无需改动**（结论）。八项分别落在既有 **B02**（view toggle）/ **B03**（nav + footer 三格）/ **B07**（`[data-card-title]`）/ **B08**（List view）/ **B09**（drawer head）/ **B19**（Access）小节内；本契约**不引入任何新钩子、新块**。B03 已记载 `[data-access-status]` 三等分 + `[data-theme-switch]` / `[data-lang-select]` / `.td-caret`，B19 已记载 `[data-cidr-*]` / `[data-token-*]` 全套。
  - **例外待办（均属实现卡，非本卡）**：① 若修复引入新 token（`--brand-accent` / `--brand-accent-soft`）⇒ 同步 `DESIGN.md` token 章节；② 若 B19 面板形态由抽屉改回模态 ⇒ 同步 `DESIGN.md`（B19 段）；③ 若产品选择保留抽屉 / 保留 CIDR 只读 ⇒ **书面偏差**须回写 `BLOCKS.md` B19。
  - **实读发现的既有漂移（本卡不改，仅记录）**：`design/BLOCKS.md` B03 的 Nav 行仍写 `[data-nav-item="board" | "list" | "activity"]`（3 项），而原型与实现均为 **4** 项（含 `waiting`，C6 已批准）⇒ BLOCKS.md 该行待 M1/M2b 顺手补齐。
- **`CHANGELOG.md`**：**不加条目**。本卡只产契约，无产品行为变化。
- **`design/fidelity-r6.md`**：本文件，新文档。
  - **索引登记**：`design/README.md` 是 `design/` 的**目录说明**（列出 `PRD.md` / `DESIGN.md` / `BLOCKS.md` / `prototype/` / `assets/`），并未逐份登记设计文档，故按本卡**硬写面（只写 `design/fidelity-r6.md` 一个文件）不登记**；是否把本文件加入该说明，留待 Elon / 修复卡裁定。
- **本卡写入面复核**：仅新增 `design/fidelity-r6.md`；未改 `design/BLOCKS.md`、未改 `design/prototype/**`、未改 `web/src/**`、未改 `test/**`。

## 13. 口径红线与未覆盖项

**红线（硬）**

1. **禁用行号**：一律「文件:选择器」；跨文档引用只用「文档名 §小节」或 selector。
2. **禁止只写「不一致」**：③⑤⑥⑦⑧ 均已逐块枚举（选择器 + 差异 + 归类）。
3. **期望值以原型实测为准**：凡 spec 所记与实测冲突处，以实测落 `block 契约表`，并把冲突记入 偏离表（归类 `口径`）——本卡共 4 处（R1–R4）。
4. **不改 `BLOCKS.md` 主体、不改 `web/src`、不改测试**。
5. **未实测项显式标注**：不得把推测写成结论。

**未覆盖 / 待裁定（非本卡结论）**

| # | 议题 | 现状 | 建议 |
|---|---|---|---|
| **F1** | ③ B19 面板形态：原型居中模态 vs 实现右侧抽屉 | 实测量化：模态 `min(480px, 100vw-32px)` / `max-height:min(88vh,720px)` / `translate(-50%,-50%)`；抽屉 `min(520px,100vw)` 贴右 | 修回模态（保持「原型即契约」） |
| **F2** | ③ CIDR 只读（ruling O6，无读写路由） | 实现 `readonly disabled`、无 `[data-cidr-add]` / `[data-cidr-remove]` | 批准为书面偏差，不造死按钮 |
| **F3** | accent token 缺口 | 实现无 `--brand-accent` / `--brand-accent-soft`；影响 ①②⑥⑧ | 批准增补（light + dark），修复卡同步 `DESIGN.md` |
| **F4** | ⑤ list 列模板 `92px → 74px` 等值对齐 | 实现 `[92px, 1fr, auto×4]` / `gap-3` / `p-2`；原型 6 轨定宽 | 按原型对齐；若因响应式保留现状 ⇒ 书面偏差 |
| **F5** | ⑦「实现报无对应图标」 | DOM 层**不可复现**：实现与原型均有 3 个 `svg[data-theme-icon]`、同刻 1 个可见 | 浏览器视觉实测后按实判：可见 ⇒ 误报；不可见 ⇒ 另开缺陷卡 |
| **F6（新增）** | ⑥（及 ⑤ 的 list chip）原型 `.td-chip` **同名重复声明**，实测落在青底药丸一套 | 实测：`bg=accent-soft` / `radius=999px` / `12px` / `padding:2px 4px 2px 8px`；spec 记的 surface / 11px / 4px 一套被级联覆盖、实际不生效 | 请设计 owner 二选一后固定：**(a)** 认实测药丸口径（则 ⑥ 的 chip 取 accent-soft / 999px / 12px）；**(b)** 认 spec 的 rounded-rect 口径（则需同时修正原型的重复声明，并说明原型现状即为缺陷）。**裁定前不得固定 ⑥ 的 bg/radius 断言** |
