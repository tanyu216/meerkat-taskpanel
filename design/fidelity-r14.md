# UI 保真契约 · R14 — 详情抽屉（B09 及关联块）原型↔实现逐块对账

> 卡：`T-20261013-154930` · 日期 2026-10-13 · 来源 Terry（2026-10-13）：「详情抽屉『工程实现与原型设计重新对齐——原型里很多样式细节没落地到工程实现』」。
> 范围：**B09 详情抽屉本体 + 抽屉组合用到的关联块**（B16 会话溯源 / B22 assignee·reporter / B23 GFM 只读面 / B24 relations / B25 labels / R10 保存态 / 空态 / 模板源）。
> 事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B27）。**原型页在真实浏览器里的实测值是唯一事实源**，`.css` 里某条声明的字面值不是。
> 证据口径：所有「原型实测值」都由 `workspace/T-20261013-154930/evidence/probe-r14.mjs` / `verify-r14.mjs` 在 Chromium headless（Playwright，Chromium **153.0.8010.12**）里真跑所得，原始记录 `r14-measure.json` / `verify-r14.json`，截图 `shots/d-open-*.png`。**未跑的一律标注**。
> 基线 commit：**`02176bb`**（本卡开工时 lane worktree `lane/T-20261013-154930-seg1` 的 HEAD，与 `main` 同点）。同族前序：**R12**〔`T-20261013-023310`〕只裁定了「抽屉头标识符完整 id」一处；本卡把抽屉整体逐块对回，**并复核 R12 是否已落地**（§4 R14-B05：**未落地**）。
> 关系卡：实现 B2（`T-20261013-154930-2`）、验证 B3（`T-20261013-154930-3`）。**本卡只产契约 + 原型改动，不含实现代码**。

## 0. 结论摘要

- **对账了 36 个块**（§4）。判定分布：**对齐 3 / 缺 10 / 简化 12 / 自创 3 / 口径 8 / 缺失口径 0**。
- **本轮要补的样式细节全集 = 50 条**（§8），逐条给「原型出处 · 原型实测值 · 实现现状（文件:符号）· 目标 · 机检断言编号」，B2 可不看法庭逐条实现。
- **原型本轮零改动**（§6.1 给出确证理由）：本卡实测未发现原型自身缺陷或自相矛盾；`design/prototype/**` 一行未动。**故不与 A1（`154954`）争 `design/prototype/index.html` 的写面**。
- **机检断言 69 条**（A 结构 28 / B 几何·计算样式 32 / C 交互 9），`verify-r14.mjs` 对原型实跑 **69/69 通过**（`verify-r14.json` 的 `summary` 实测 `{"A":28,"B":32,"C":9}`），`console.error = 0`、`pageerror = 0`（A24 / C9 两轮各自计数）。
- **一处必须点名的既有项**：**R12 未落地**。契约 `design/fidelity-r12.md` §2.1/§2.2 要求 `[data-detail-identifier]` 去掉字符切片并追加 `.td-id-full`；实测 `web/` 全树 **`grep -rn "td-id-full" web/` 零命中**，`web/src/components/detail/DetailDrawer.vue` 的 `[data-detail-identifier]` 仍是 `{{ identifierText(identifier) }}`（`web/src/lib/identifier.js:identifierText` 8 字符 + `…`）。**这是 §4 R14-B05，B2 必须一并补。**
- **三处「自创」是既有契约测试已经背书的实现侧钩子**（`[data-attachment-row]`/`[data-attachment-name]`/`[data-attachment-size]`/`[data-activity-row]`/`[data-activity-actor]`/`[data-activity-ts]`，见 `test/web/blocks.contract.mjs` §B09 `states`；`[data-detail-slot-source]` 只在该组件里）。原型**没有**这些钩子 ⇒ 是「原型无、实现新增」。**采纳/回退须 Elon 裁定**（§8 未决 U1）——本卡只登记，不单方面改原型，也不改 `test/**`。
- **不变式**：五宽度（1512/1240/980/760/430）× light/zh **全部无横向溢出**（B19 / B21 / B23）；抽屉本体宽度 = `min(520, 视口)`（B21：520/520/520/520/**430**）。
- **回灌（2026-10-14，卡 `T-20261014-112216`）**：独立验证 `T-20261013-154930-3`（verdict FAIL）暴露的 **3 条口径问题**已落回本契约 —— ① B22 的 light 遮罩取「**既有令牌口径保留**」（§3 遮罩行 / §4.1 R14-B03 / §5 B22 / §8.1 D07 四处同步 + §8.3 `DF-1` 登记）；② §5 B23 的 `lang` 期望由字面 `zh-CN` 改为「**镜像该侧自己的 locale id**」（原型 `zh-CN` / 实现 `zh`）；③ §5 A4 / A6 的**归属列**由「双侧」改「**原型**」。**未放宽任何真缺陷断言**：§8.1 D42（附件行几何）等 `缺`／`简化` 项的判定与断言原样保留，实现侧的必修面不变。

---

## 1. 口径与证据规则

**闭集口径（逐字使用，不得自创词）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差说明）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本页不出现任何「文件 + 数字行号」形式的引用，本节也不举这种反例，以免被扫描器误判）。跨文档引用只写「文档名 §小节」或 selector。**断言只用 `data-*` 钩子 + 属性**；class 名只用于描述样式，**不得作契约锚**。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / `getBoundingClientRect` / `scrollWidth`·`clientWidth` / DOM 计数 / 真实指针与键盘），**不是** CSS 文件里的声明字面值；两者冲突时**实测值胜**（§0 的 `max-width: 100vw` → `computed 1512px` 就是这条规则的产物）。
2. 载体 = **Playwright 内置静态 HTTP 服务**服务 `design/prototype/`，URL `http://127.0.0.1:<随机端口>/index.html`（**不是 `file://`**）。Chromium headless 版本见头部。
3. 矩阵 = 宽度 `1512 / 1240 / 980 / 760 / 430` × 主题 `light`（+ `dark` 补充）× 语言 `en`（+ `zh` 必测）。每档断言 `documentElement.scrollWidth == clientWidth`。
4. **打开抽屉用真实点击** `[data-card]`（`page.click`），不是派发合成事件；实测打开的是 **`PROJ-0007`**（9 字符 id，正是 R12 的判据样本）。
5. **JS-off** = 同一份静态文档在 `javaScriptEnabled:false` 下加载，验证静态 markup 自身完备（A25 / A26）。
6. **实现侧本轮为「实读」，未实测**：未构建 `web/dist`、未起 dev server（本卡写面只有 `design/**`，构建产物属实现卡工作）。凡涉及实现的位点一律标「实读」；**§4 的「实现现状」列没有一个是实测值**，不得当读数引用。
7. **不得伪造**：任何未验证项在正文里明写「未验证 / 实读未实测」。本页所有原型数字均可在 `verify-r14.json` 里逐条比对。
8. **`[data-slot]` 的测量陷阱**：原型把卡体放在 `<template data-detail-for>` 里，`[data-slot]` 位于 **inert `template.content`**，因此 `document.querySelectorAll("[data-slot]")` **返回 0**（A5 实测 `[18, 87, 0]`：18 个模板 / 87 个 slot 在 `template.content` 里 / 0 个在活 DOM 里）。任何「数 slot」的断言必须穿 `template.content`，否则会写出一个永假的规则。

---

## 2. 交互契约

只写「原型如此 + 实现应为」。所有选择器以原型为准（§6 的 A/C 腿逐条实测）。

### 2.1 开合（B09 本体）

| | 原型如此（实测） | 实现应为 |
|---|---|---|
| 状态载体 | `aside[data-detail-drawer]` 的 **`data-state`** ∈ `closed`\|`open`\|`closing`；**遮罩**用 `[data-detail-overlay][data-state]` **+ `hidden`** | 同（`data-state` 是唯一状态源） |
| 关闭态视觉 | `.td-drawer` 自带 `transform: translateX(100%)` + `visibility: hidden`（C1/C7：关闭后 `data-state="closed"`、`aria-hidden="true"`、遮罩 `hidden` 回来） | 同；**`aside` 本体不带 `hidden`**（见 §4 R14-B01），`hidden` 只属于遮罩 |
| 打开 | 真实点击卡片 → `data-state="open"`、`aria-hidden="false"`、遮罩 `data-state="open"` 且 `hidden` 摘除（C1 实测 `{state:"open",aria:"false",overlayState:"open",overlayHidden:false}`） | 同 |
| 焦点 | 打开后焦点落在 `[data-detail-close]`（C2 实测 `focused:true`） | 同 |
| 关闭 | 点 `[data-detail-close]` 或按 `Esc` → `data-state="closed"`、`aria-hidden="true"`、遮罩 ≤400ms 内 `hidden` 复位（C7 / C8 实测均 `closed`） | 同 |
| 无障碍 | `role="dialog"`、`aria-modal="true"`、**`aria-labelledby="td-detail-title"`**，且该 id 落在 `<h2 data-detail-title id="td-detail-title">` 上（A7 实测 `["td-detail-title", true]`） | 同；**实现侧当前缺这两个座位** ⇒ 缺（R14-B02） |

### 2.2 头部（head）

- 一行三件：`[data-detail-identifier]` · `[data-detail-status-chip]` · `[data-detail-close]`，**同一个父元素**（A8 实测 `closeSameRow:true`），关闭按钮由 `margin-left:auto` 推到行尾。
- 第二行是标题：`h2[data-detail-title]`（A7 实测 `aria-labelledby` 指向它是 `<h2>`）。
- `[data-detail-status-chip]` 内有 `[data-detail-status-chip-label]`，且**色点与词并存**（×2 是颜色不是唯一信号）：实测量得 chip 高 18px / 圆角 999px / 字号 12px（B12）。
- `[data-detail-close]` 的图形是 `svg.td-icon`（✕），不是文字字符（A17 的 `[data-detail-status]` 与 R7 ④ 的 close svg 同族）。

### 2.3 保存态（R10 ②，三字段一区）

- `[data-detail-save][data-save-state]` 是**属性载体**：`hidden`，`idle` 是出厂值（A11 实测 `["idle", true, "alert", true]`）。
- `[data-detail-save-error][role="alert"]` 是它**唯一的可见半边**：除 `error` 外恒 `hidden`；**原型上它没有 `data-i18n` 座位**（A12 实测 `null`），文案内联。
- 三个提交点同行挂钩：`[data-detail-save-field]` ∈ `assignee` / `reporter` / `labels`（A10 实测 `["assignee","reporter","labels"]`）。
- 真实提交把状态推离 `idle`：C5 实测删掉一个 label chip 后 `data-save-state = "saving"`。

### 2.4 属性网格（Properties）

- `[data-detail-props]` 是 **8 对「标签 + 值」= 16 个直接子元素**（A9 实测 `16`），顺序固定：status · priority · assignee · reporter · project · labels · id · version。
- **三个值是可点的控件，不是文本**：`[data-detail-status]` / `[data-detail-priority]` / `[data-detail-project]` 都是 `<button>`（A16 实测 `["button","button","button"]`）。
- status 行 = 色点 + 标签 + **chevron svg**（A17 实测 `["span","span","svg"]`）；priority 行同构（`.td-pri` 字形 + 标签 + chevron）。
- assignee / reporter 是 **B22 的组合控件**：`[data-detail-assignee]` 带 `data-assignee-kind`，头像 `[data-detail-assignee-avatar]` 也带；agent 卡上 `[data-detail-assignee-platform]` 带 `data-agent-platform`（A19 实测 `["agent","agent","openclaw"]`）。
- labels 是 **B25 的多值 chip 控件**，根 `[data-detail-labels]` 本身带 `data-detail-save-field="labels"`（A10）。
- id 行 = `[data-detail-id]` + `[data-detail-id-copy]`（`<button>`，带 **`data-copy-value`** 与一个 `svg`；A18 实测 `["button","td_01HQ8ZM4K2P7RQY",1]`）。

### 2.5 卡体分区（Body）

- **钩子挂在哪**（A13–A15 实测）：`[data-detail-description]` = `div.td-gfm`，父是 `section`；`[data-detail-relations]`/`[data-detail-attachments]`/`[data-detail-comments]`/`[data-detail-activity]` 都是 `section` 的**内容子 div**；**只有 `[data-detail-agent-session]` 挂在 `section` 本体上**。
- **空态**：由 `app.js:openDetail()` 的 `fill()` 按卡片 slot 的有无注入 `<span class="text-xs text-td-ink-3" data-i18n="description.none|relations.none|attachments.none">`（A21 实测标签名 `span`/`span`）。**抽屉的空态是普通 `span + data-i18n`，不是 B12 的 `[data-empty]`**——不得张冠李戴。
- **comments 无空态**：`fill(..., "comments", null)`，卡片没有 comments slot 时该容器为空（实测 `[data-detail-comments]` 高 0）。
- 评论表单是「标签 + 输入 + 提示 + 提交」四件：`label`（`for="td-comment-input"`）+ `textarea#td-comment-input[data-comment-input]` + `[data-i18n="drawer.commentHint"]` + `[data-comment-submit]`（A20 实测 `[["label","textarea","div"],1,"td-comment-input",1,1]`）。
- **模板源**：`[data-detail-templates]` **不在抽屉里**（A6 实测 `tplInsideDrawer:false`，父是 `body`），**不带 `hidden`**，内含 **18 个 `template[data-detail-for="TD-…"]`**，`template.content` 内共 **87 个 `[data-slot]`**（A5/A26 实测，JS-off 下同样 `18 / 87`）。

### 2.6 关联控件（B22 / B25 在抽屉里的两处实例）

- B22：`[data-assignee-menu]` / `[data-assignee-option]` / `[data-reporter-menu]` / `[data-reporter-option]`；键盘 `ArrowDown` 打开菜单（C6 实测 `hidden:true` 表示「有未隐藏的菜单」）。**不得**与 B04 的 `[data-assignee-filter-option]` 混淆（R13 §2.9）。
- B25：`[data-detail-labels]` → `[data-detail-label-chips]` → 每枚 `[data-detail-label-chip][data-detail-label-value]` + `[data-detail-label-remove]`；`[data-detail-label-input]`（`aria-controls="td-label-menu-detail"`）→ `[data-detail-label-menu]` → `[data-detail-label-option][data-detail-label-value]`。聚焦输入框即开菜单（C3 实测 `hidden:false`）；点 remove 少一枚 chip（C4 实测 `2 → 1`）。

---

## 3. 视觉规格（数值即结论）

令牌守恒声明：**本轮不新增、不改名任何设计令牌**；并且**不改任何既有令牌的值**。遮罩（原型 `.td-scrim` 的 `--scrim` ↔ 实现 `[data-detail-overlay]` 的 `--brand-scrim`）按 R14 裁定取「**既有令牌口径保留**」——实现侧只有 `--brand-scrim` 一枚遮罩令牌，**不得为追平原型字面量而改它**（书面偏差见 §8.3 `DF-1`）。因此下表「遮罩」一行**并列给出两侧各自的解析值**：原型字面量是实测，实现侧是 `T-20261013-154930-3` 的 computed 实测读数。其余数值全部来自原型实测（1512×950，light，en，卡片 `PROJ-0007`，除注明外）。

| 量 | 原型实测值 | 出处（文件:选择器） |
|---|---|---|
| 抽屉宽度 | `520px`（视口 ≥520）；`430px`（视口 430） | `design/prototype/src/input.css:.td-drawer`（`width: var(--shell-drawer)`，`--shell-drawer: 520px`） |
| 抽屉定位 / 上限 | `position: fixed`；`max-width: 100vw`（computed `1512px`） | `.td-drawer` |
| 抽屉表面 | light `rgb(255,255,255)` / dark `rgb(22,27,30)`；文字 light `rgb(20,24,27)` / dark `rgb(230,237,240)` | `.td-drawer` + `--color-td-surface` / `--color-td-ink` |
| 抽屉左边框 | `1px`，light `rgb(230,232,235)` | `.td-drawer`（`--color-td-line`） |
| 抽屉层级 / 遮罩层级 | `50` / `40` | `.td-drawer` / `.td-scrim` |
| 遮罩（**原型**的表达式） | light `rgba(15,20,23,0.32)` / dark `rgba(0,0,0,0.55)`，打开态 `opacity: 1` | `.td-scrim`（`--scrim`） |
| 遮罩（**既有令牌口径保留** —— 实现侧，R14 裁定；同一枚 `--brand-scrim` 被 `CreateTaskModal` / `CreateProjectModal` / `DetailDrawer.vue` 三面共持） | light `oklab(0.276439 … / .32)` ≡ **`rgb(31,42,46)` / 32%**（= `--color-neutral` light `#1f2a2e` 的 32%，来自 `color-mix(in oklab, var(--color-neutral) 32%, transparent)`）；dark `rgba(0,0,0,0.55)`（**与原型同值，不变**） | `web/src/styles/tokens.css:--brand-scrim`（`T-20261013-154930-3` computed 实测） |
| 头部内边距 | `12px 16px 12px 20px` | `.td-drawer-head` |
| 卡体（滚动宿主）内边距 | `16px 20px 24px`；`overflow-y: auto` | `.td-drawer-body` |
| 头部标识符 | `12px`，`rgb(126,138,145)`，`max-width: none` / `overflow: visible` / `text-overflow: clip` / `white-space: nowrap`；9 字符 `PROJ-0007` 实测 `scrollWidth == clientWidth == 64`（不裁） | `.td-id.td-id-full` + `[data-detail-identifier]` |
| 标题 h2 | `16px` / `600` | `[data-detail-title]`（`.text-lg.font-semibold`） |
| 状态 chip | 高 `18px`，圆角 `999px`，字号 `12px`，色点 `6×6` | `.td-chip` / `.td-chip-status .td-status-dot` |
| 关闭按钮盒 | `32×32` | `.td-iconbtn`（**实现侧自 `T-20261014-154730` 起直接穿该类**：`DetailDrawer.vue:[data-detail-close]` 的 class = `td-iconbtn ml-auto`，实测 computed `32×32`/`display:flex`/`border 1px`/`radius 6px`/`rgb(74,85,94)`，与原型等值；见 `T-20261014-154730-3`） |
| 保存错块 | `border: 1px` `rgb(192,57,43)`，底 `rgb(251,238,236)`，圆角 `6px`，字号 `12px`，`margin-bottom: 12px` | `.td-save-error` |
| 属性网格 | `display: grid`，`grid-template-columns: 96px <余>`，`row-gap: 4px`，`column-gap: normal(0)`，`align-items: center` | `.td-props` |
| 属性标签 | `12px`，`rgb(126,138,145)` | `.td-prop-label` |
| 属性值 | `inline-flex`，`gap: 6px`，`min-height: 28px`，`padding: 0 6px`，字号 `13px`，`1px` 透明边框，圆角 `4px` | `.td-prop-value` |
| 属性值（可点） | `cursor: pointer`；hover 底 `--color-td-hover` + 边框转 `--color-td-line` | `button.td-prop-value:hover` |
| labels 行（例外） | `flex-wrap: wrap`，`align-items: flex-start`，`gap: 4px`，`padding: 4px 6px` | `.td-prop-labels`（**注意：原型 markup 未使用该类**，见 §8 D31） |
| 复制控件 `.td-copy` | `inline-flex`，`gap: 6px`，`font-family: mono`，`12px`，`rgb(74,85,94)`，`padding: 2px 6px`，圆角 `4px` | `.td-copy` |
| GFM 面 | `13px`，`line-height: 1.5`（实测 `19.5px`），`rgb(74,85,94)` | `.td-gfm` |
| section | `padding: 16px 0`，`border-top: 1px solid var(--color-td-line)`；`:first-child` 去 padding-top 与 border-top | `.td-section` |
| section 标题 | `11px` / `500` / `letter-spacing: 0.06em`（实测 `0.66px`）/ `uppercase` / `rgb(126,138,145)` / `margin: 0 0 8px` | `.td-section-title` |
| relations 容器 | `flex`，`flex-wrap: wrap`，`gap: 4px 8px` | `.td-rel` |
| 附件行 | `flex`，`gap: 8px`，`padding: 6px 8px`，`border: 1px`，圆角 `6px`；文件名 `12px/500` 墨色；尺寸 mono `11px` 灰、`margin-left: auto` | `.td-file` / `.td-file-name` / `.td-file-size` |
| 会话盒 | `padding: 8px 10px`，底 `rgb(245,246,247)`（sunken），`border: 1px`，圆角 `6px` | `.td-session` |
| 评论行 | `flex`，`gap: 8px`，`padding: 8px 0`，`border-top: 1px`（`:first-child` 无）；正文 `13px`、`white-space: pre-line` | `.td-comment` / `.td-comment-body` |
| 决策评论 | `padding-left: 8px`，`border-left: 2px solid var(--color-td-accent)` | `.td-comment-decision` |
| 活动行 | `flex`，`gap: 8px`，`align-items: baseline`，`padding: 3px 0`，`12px`，`rgb(74,85,94)` | `.td-activity` |
| 活动时间戳 | mono `11px` 灰，`margin-left: auto`，`nowrap` | `.td-activity-ts` |

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目（36 块 · 逐块判定）

> 「实现现状」全部为**实读**（§1.6），未实测。原型列全部为**实测**。

| id | 块 | 根 / 关键钩子 | 判定 | 原型实测期望 | 实现现状（文件:符号，实读） | 偏差说明 |
|---|---|---|---|---|---|---|
| R14-B01 | 抽屉壳层 | `aside[data-detail-drawer]` | `口径` | `fixed`、宽 `520px`、`max-width:100vw`、`z-index:50`、关闭态 `transform:translateX(100%)`+`visibility:hidden`、**无 `hidden` 属性** | `web/src/styles/app.css:.td-drawer`（`w-[min(560px,100vw)]`、`z-[60]`、`border-inline-start`、`box-shadow`）；`DetailDrawer.vue:[data-detail-drawer]`（`:hidden="!open"`、`:aria-hidden`） | 宽度 560→**520**；z 60→**50**；`aside` 上多出的 `hidden` 是自创（原型的关闭态靠 transform+visibility），保留 `data-state` 即可 |
| R14-B02 | 抽屉 a11y 座位 | `aside[data-detail-drawer]` ↔ `[data-detail-title]` | `缺` | `aria-labelledby="td-detail-title"` 且 `#td-detail-title` 落在 `<h2 data-detail-title>` 上（A7 `["td-detail-title", true]`） | `DetailDrawer.vue`：`aside` 无 `aria-labelledby`；`h2[data-detail-title]` 无 `id` | 两个座位都没落 |
| R14-B03 | 遮罩 | `[data-detail-overlay]` | `口径` | `z-index:40`、`position:fixed`、`inset:0`、`background: var(--scrim)`、`hidden`+`data-state` 双载体 | `DetailDrawer.vue:[data-detail-overlay]`（`z-50`、`bg-(--brand-scrim)`、`:hidden`、`:data-state`） | z 50→**40**（要低于抽屉）；**遮罩色：既有令牌口径保留** —— 实现读既有共享令牌 `--brand-scrim`，light 解析值 `rgb(31,42,46)/32%` ≠ 原型字面量 `rgba(15,20,23,.32)`（dark 两侧同值 `rgba(0,0,0,.55)`）。**该令牌不改值** ⇒ 书面偏差登记 §8.3 `DF-1`，§5 B22 已按 token 口径改写 |
| R14-B04 | 头部盒 | `aside[data-detail-drawer] > header` | `缺` | `padding: 12px 16px 12px 20px`；`border-bottom: 1px` | `DetailDrawer.vue` header（`p-4`、`border-b`） | 统一 16px → **非对称 12/16/12/20** |
| R14-B05 | 头部标识符 | `[data-detail-identifier]` | `缺` | 文本 = **完整 id**（`PROJ-0007`），class 含 **`.td-id-full`**，computed `max-width:none`/`overflow:visible`/`text-overflow:clip`（B2/B3）；JS-off 下 `TD-128` 亦带 `.td-id-full`（A25） | `DetailDrawer.vue:[data-detail-identifier]`：`class="td-mono td-id"`、`{{ identifierText(identifier) }}`；`web/src/lib/identifier.js:identifierText`（8 字符 + `…`）；`grep -rn "td-id-full" web/` **零命中** | **R12 未落地**：切片未去、`.td-id-full` 未加、`app.css` 无该规则 |
| R14-B06 | 标题 | `[data-detail-title]` | `缺` | `16px` / `600` | `DetailDrawer.vue:<h2 data-detail-title>` 无字号/字重 utility（Tailwind preflight 下继承正文） | 补 `text-[16px] font-semibold` |
| R14-B07 | 状态 chip | `[data-detail-status-chip]` → `-label` | `对齐` | `.badge.badge-sm.td-chip.td-chip-status` + 6px 点 + 词；高 18px / 圆角 999px / 12px（B12） | `DetailDrawer.vue` 同 class 列表；`app.css:.td-chip` / `.td-chip-status .td-status-dot` | 无需改（**匹配项**）。**该行的 `对齐` 判定仅指 class／盒径级（= B12）——内容级不成立**：原型的 chip label 曾恒显静态 `status.todo`（原型缺陷，见 §8.4 `PF-1`）⇒ 该座位的**内容**不得以原型当 oracle |
| R14-B08 | 关闭按钮 | `[data-detail-close]` | `对齐` | 与 identifier/chip 同行、行尾；`svg.td-icon` 非文字；盒 32×32（R7 ④） | `DetailDrawer.vue:[data-detail-close]`（`td-iconbtn ml-auto`、`svg.td-icon size-4`） | 无需改（**匹配项**）—— **已于 `T-20261014-154730` 修复**（盒径 `16×16`→`32×32`、`.td-drawer-head` `67`→`78.59`、标题行高补 `1.35`）；判定升为**盒径/computed 级**（`T-20261014-154730-3`）。此前的「匹配项」在 selector 级为真、在盒径级不成立 |
| R14-B09 | 保存态 | `[data-detail-save]` / `[data-detail-save-error]` | `口径` | 载体 `hidden` + `data-save-state="idle"`；错块 `role="alert"`、`hidden`、**无 `data-i18n`**；`.td-save-error` 盒（§3） | `DetailDrawer.vue`：载体与错块齐备，但错块多一个 `data-i18n="detail.saveError"`（键在 `web/src/i18n/extra.mjs`）；`app.css:.td-save-error` 齐 | 文案座位口径不同（R10 §7 原文「no `data-i18n` hook」已过时）——**偏差已书面记录，见 §8 U2**；样式值对齐 |
| R14-B10 | 属性网格 | `[data-detail-props]` | `口径` | `grid`、`96px <余>`、`row-gap:4px`、**`column-gap: normal(0)`**（B7 实测 `["grid","96px 383px","4px"]`） | `DetailDrawer.vue:[data-detail-props]`（`grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1`） | 多出 `gap-x-3`（12px 列间距）；原型**没有**列间距 |
| R14-B11 | 属性行 · status | `[data-detail-status]` / `-label` | `简化` | **`<button>`** + 色点 + 标签 + chevron（A16/A17） | `DetailDrawer.vue`：静态 `<div>` 只含 `[data-detail-status-label]` | 由控件退化为文本：无点、无 chevron、不可点 |
| R14-B12 | 属性行 · priority | `[data-detail-priority]` / `-label` | `简化` | **`<button>`** + `.td-pri` 字形 + 标签 + chevron | `DetailDrawer.vue`：静态 `<div>` 只含 label | 同上；缺 `.td-pri` 字形与 `aria-label` |
| R14-B13 | 属性行 · assignee（B22） | `[data-detail-assignee]` | `简化` | 根带 `data-assignee-kind`；头像 `.td-avatar` 带 `data-assignee-kind`；平台徽 `[data-detail-assignee-platform]` 带 `data-agent-platform`（A19）；输入 seeded | `DetailDrawer.vue`：根无 `data-assignee-kind`；头像无 kind、非 `.td-avatar`；平台是纯 span、**无 `data-agent-platform`** | 三个属性座位缺失 |
| R14-B14 | 属性行 · reporter（B22） | `[data-detail-reporter]` | `简化` | 头像 `.td-avatar` + seeded 输入 + `[data-detail-reporter-label]` | `DetailDrawer.vue`：结构在，头像非 `.td-avatar`、无 kind | 样式与座位不一致 |
| R14-B15 | 属性行 · project | `[data-detail-project]` | `简化` | **`<button>`** + `[data-detail-project-label]`（mono） | `DetailDrawer.vue`：静态 `<div>` | 可点性丢失 |
| R14-B16 | 属性行 · labels（B25） | `[data-detail-labels]` | `简化` | 根自身带 `td-prop-value td-prop-combo`（`min-height:28px`、`padding:0 6px`，B13）；chips 在输入框**之前** | `DetailDrawer.vue`：`[data-detail-labels]` 是无 class 的内层 div，prop 样式挂在外层 div；`ComboField.vue` 把 chips 渲染在输入框**之后** | 行度量与 chips 顺序都偏 |
| R14-B17 | 属性行 · internal id | `[data-detail-id]` / `[data-detail-id-copy]` | `口径` | `[data-detail-id-copy]` = `<button>`，带 `data-copy-value`，内含 `svg`（A18）；`.td-copy` 盒（mono 12px / `2px 6px` / 圆角 4px / hover） | `DetailDrawer.vue`：`<button>` + `data-copy-value` ✅，但图标是文字 `⧉`、无 `.td-copy` 度量 | 同意图不同表达：图标须换成 `svg.td-icon-sm`，盒须按 `.td-copy` |
| R14-B18 | 属性行 · version | `[data-detail-version]` | `口径` | `.td-prop-value.td-mono`：`min-height:28px`、`padding:0 6px`、mono 13px | `DetailDrawer.vue`：`td-mono` + `min-h-7` + `px-1`（4px） | padding 4→6px |
| R14-B19 | 卡体宿主 | `[data-detail-drawer] > div.td-drawer-body` | `缺` | `padding: 16px 20px 24px`；`overflow-y:auto`；`min-height:0`；`flex:1 1 auto`；`scrollbar-width: thin` | `DetailDrawer.vue`：`flex-1 flex-col gap-4 overflow-y-auto p-4` | 内边距与滚动细节（`gap-4` 是原型没有的 16px 间距，原型靠 `.td-section` 的 padding 造节奏） |
| R14-B20 | 分区与分区标题 | `section.td-section` / `.td-section-title` | `缺` | section `padding:16px 0` + `border-top:1px`（`:first-child` 去二者）；标题 `11px/500/0.06em/uppercase/灰/margin 0 0 8px`（B8/B9） | `DetailDrawer.vue`：每段 `border-t pt-3`，标题 `text-[13px] font-semibold mb-2` | 字号 13→**11**、字重 600→**500**、缺 `uppercase` 与 `letter-spacing`、padding 12→**16** |
| R14-B21 | 描述区根 | `[data-detail-description]` | `口径` | 是 **`div.td-gfm`**，父为 `section`（A13 实测 `["div","td-gfm","section"]`） | `DetailDrawer.vue`：钩子挂在 `<section>` 本体上，`.td-gfm` 是其子 div | 钩子位置由内容容器上移到 section（影响选择器语义与样式作用域） |
| R14-B22 | GFM 只读面（B23） | `[data-detail-description]` 内的 `.td-gfm` | `缺` | 完整富样式：`> * + *` 8px、`h4` 13px/600、`ul` `padding-left:18px`、`li+li` 2px、`code`、`pre`、`blockquote`、`table`（`border-collapse`、`th` 底 sunken）、`.td-task-list` / `.td-check`（13×13、`data-checked=true` 转 success 色） | `web/src/styles/app.css:.td-gfm`：只有 `font-size` / `line-height` / `pre` / `code` 四条 | 富渲染面基本未落地（表格、引用、任务清单、行内 code 盒） |
| R14-B23 | relations（B24） | `[data-detail-relations]` → `[data-relation-link]` | `简化` | `div.td-rel`（flex wrap，`gap:4px 8px`）内若干 `.td-rel-item`，每项 = `[data-i18n="relations.parent|blocks|related"]` 标签 + `button.td-copy[data-relation-link]` | `DetailDrawer.vue`：`<ul>` + `<a data-relation-link>`，文本为 `type · label` | 分组与标签座位丢失（`relations.parent` / `relations.blocks` 不再渲染） |
| R14-B24 | 会话分区壳（B16） | `[data-detail-agent-session]` → `-body` | `简化` | **`section` 本体**带钩子（A15）；`.td-session` 盒（§3）；空 slot 时 `hidden` | `DetailDrawer.vue`：`section` 带钩子 ✅（与原型同）；但无 `.td-session` 盒 | 骨架对齐、盒子缺失 |
| R14-B25 | 会话内部（B16） | `[data-agent-session]` 家族 | `简化` | 行 1：`.badge.badge-xs.td-agent-badge[data-agent-platform]` + `[data-agent-platform-value]`（mono 12px）+ `button.btn.btn-outline.btn-xs[data-agent-resume]`（推右）；行 2：`[data-i18n="session.id"]` + `span.td-copy[data-agent-session-id]` | `DetailDrawer.vue`：两行裸 `<p>`；平台是 `<span>`（无徽章盒）；session id 无 `.td-copy` | 徽章、盒子、mono 座位、copy 盒均缺 |
| R14-B26 | 附件 | `[data-detail-attachments]` | `缺` | 卡片有 slot 时若干 `.td-file`（§3 盒）；无 slot 时注入 `span[data-i18n="attachments.none"]`（A21） | `DetailDrawer.vue`：`[data-attachment-row]` + Tailwind，无 `.td-file` 规则 | 行盒度量未落地（空态有 👍） |
| R14-B27 | 附件数据钩子 | `[data-attachment-row]` / `-name` / `-size` | `自创` | 原型**没有**这三个钩子（只有 `.td-file-name` / `.td-file-size` 两个 class） | `DetailDrawer.vue:[data-attachment-row]`；已由 `test/web/blocks.contract.mjs` §B09 `states` 背书 | 采纳（回填原型 + BLOCKS）还是回退到 class 形状，**须 Elon 裁定（§8 U1）** |
| R14-B28 | 评论 | `[data-detail-comments]` | `缺` | `article.td-comment` = `.td-avatar` + `.td-comment-meta`（作者 + `[data-i18n="comment.human|agent|decision"]` + `.td-mono[title][data-i18n="time.*"]`）+ `.td-comment-body`；`border-top` 而非 bottom；第一行无 border | `DetailDrawer.vue`：无头像、无 kin 座位内的徽章、**无时间戳**、`border-b` | 评论的元信息行大面积缺失（B26 实测富卡上 `.td-comment-meta` / `.td-avatar` 均 ≥1） |
| R14-B29 | 评论表单 | `[data-comment-form]` | `缺` | `label[for=td-comment-input]` + `textarea#td-comment-input.td-textarea` + `[data-i18n="drawer.commentHint"]` + `[data-comment-submit]`（A20） | `DetailDrawer.vue`：只有 `textarea` + `button`；无 `label`、无 hint；textarea 无 `.td-textarea` 规则 | 座位与度量双缺 |
| R14-B30 | 活动流 | `[data-detail-activity]` | `简化` | `div.td-activity` ×N：actor（`.font-medium`，agent 加 `.td-mono`）+ 句子 + `.td-activity-ts`（mono 11px 灰、推右、nowrap）（B18/B27） | `DetailDrawer.vue`：Tailwind utility 复刻（`flex items-baseline gap-2 py-[3px] text-[12px]`） | 度量接近但无 `.td-activity` 家族；时间戳座位齐 |
| R14-B31 | 活动数据钩子 | `[data-activity-row]` / `-actor` / `-ts` | `自创` | 原型**没有**这三个钩子 | `DetailDrawer.vue:[data-activity-row]`；已被 `test/web/blocks.contract.mjs` §B09 背书 | 同 R14-B27（§8 U1） |
| R14-B32 | 模板源 | `[data-detail-templates]` → `template[data-detail-for]` → `[data-slot]` | `简化` | **不在抽屉内**、**不带 `hidden`**、**18 个** `template[data-detail-for="TD-…"]`、`template.content` 内 **87 个** `[data-slot]`（A5/A6/A26） | `DetailDrawer.vue`：在 `<aside>` 内、带 `hidden`、只有一个 `[data-detail-for="*"]`、6 个**空** slot | 多重性与内容都被压平（框架无 clone 机制是理由，但「不在抽屉内 + 不隐藏 + 逐卡槽位」是契约事实） |
| R14-B33 | 槽位暂存钩子 | `[data-detail-slot-source]` | `自创` | 原型**没有**这个钩子 | `DetailDrawer.vue:[data-detail-slot-source]`；未被任何契约测试登记 | 原型无、契约无 ⇒ 建议删除或回填登记（§8 U1） |
| R14-B34 | 空态 | `[data-i18n="description.none\|relations.none\|attachments.none"]` | `口径` | 由 `fill()` 注入的 **`span.text-xs.text-td-ink-3`**（A21 实测 `["span","span"]`；实测文案 `No relations` / `No attachments`） | `DetailDrawer.vue`：`<p class="text-[12px] text-(--brand-text-3)" data-i18n=…>` | 同座位、不同标签名（`span` vs `p`）与字号（`text-xs`=12px ✅ 一致） |
| R14-B35 | B22 抽屉内菜单 | `[data-assignee-menu]` / `[data-assignee-option]` / `[data-reporter-menu]` / `[data-reporter-option]` | `对齐` | 抽屉内两个实例，`<ul role="listbox">` + `<li><button>`；键盘 ArrowDown 开（C6） | `ComboField.vue` 通过 `hookMenu`/`hookOption` 生成 | 无需改（**匹配项**） |
| R14-B36 | B25 抽屉内控件 | `[data-detail-label-*]` | `简化` | chips 盒（`.badge.td-chip`：高 18px / 圆角 999px / 12px / `padding 2px 4px 2px 8px` / accent-soft 底 / `title`）；remove = `button.td-chip-remove` **16×16**，内含 `svg.td-icon-sm`，`aria-label="Clear <name>"`、`title="Clear"`（B14/B15 实测） | `ComboField.vue`：chip `inline-flex … rounded-[4px] border bg-(--brand-sunken) text-[11px]`；remove 是文字 `✕` | chip 盒与 remove 图形都偏（`badge.td-chip` 的 18px/999px 未用） |

### 4.2 匹配项（本轮命中但无需改动）

| 块 | 根 | 实测依据 | 备注 |
|---|---|---|---|
| R14-B07 状态 chip | `[data-detail-status-chip]` → `-label` | B12；类列表与原型逐字相同 | **不得**再动（避免连锁回归） |
| R14-B08 关闭按钮 | `[data-detail-close]` | A8（同行、行尾）；R7 ④ 的 `svg.td-icon` 已在实现 | 同上。**注（`T-20261014-154730-3`）**：本行「无需改」当时只核到 selector 级（同行/行尾 + 图形非文字）；盒径 `32×32` 一侧的实现义务由 `T-20261014-154730` 补齐，现 computed 双侧等值 ⇒ 本行结清 |
| R14-B35 B22 抽屉内菜单 | `[data-assignee-menu]` 等 | C6（键盘可开） | 同上 |
| `[data-detail-save-field]` 三挂钩 | `[data-detail-assignee]`/`[data-detail-reporter]`/`[data-detail-labels]` | A10 | 实现已齐 |
| `[data-detail-save]` 载体 | `[data-detail-save][data-save-state]` | A11（`idle` + `hidden`） | 实现已齐 |
| 抽屉根 `data-identifier` | `aside[data-detail-drawer][data-identifier]` | r12 §2.1 起就有；本次随 B05 一并复核 | 身份读取点，**不得**改成读文本 |
| `[data-detail-agent-session]` 挂在 `section` | 同 | A15 | 实现已与原型一致 |

### 4.3 负向注记清单（本轮**不得**触碰）

1. **B07 卡片标识符**：`[data-card-identifier]` 仍「8 字符 + …」，**不得**带 `.td-id-full`（R12 反向断言 A4–A6 的期望）。
2. **B08 列表行标识符**：`[data-list-identifier]` 同上。
3. **B04 筛选器的 assignee**：`[data-assignee-filter-option]` 与 B22 的 `[data-assignee-option]` **不得混用**（R13 §2.9）。
4. **B12 空态**：`[data-empty]` 不是抽屉的空态；抽屉是 `span/p + data-i18n`。
5. **B10 创建弹窗里的 B22/B25 实例**：同一控件、另一套钩子族（`[data-create-*]`），本轮**只对账抽屉族**。
6. **`design/prototype/**`**：本卡零改动（§6.1）；A1（`154954`）若在动 `index.html`，本卡不与其争写面。
7. **`web/**`、`test/**`、`src/**`、`server/**`**：一行不动（本卡只写 `design/**`）。

---

## 5. 机检断言清单（A 结构 / B 几何·计算样式 / C 交互）

运行器：`workspace/T-20261013-154930/evidence/verify-r14.mjs`（**不进仓**）。每条 = `id | 选择器 | 断言式 | 原型实测期望 | 归属`。**全部对原型实跑，69/69 通过**（`verify-r14.json`）；行数分布 **A 28 / B 32 / C 9**——A25/A26 各在 1512 与 430 两档各跑一次（故 A 表 26 个 id ⇒ 28 行），B21 五档、B22/B23 各两档（故 B 表 26 个 id ⇒ 32 行）。

### A · 结构（DOM 计数 / 属性；A25–A26 为 JS-off 轮）

| id | 选择器 | 断言式 | 原型实测期望 | 归属 |
|---|---|---|---|---|
| A1 | `[data-detail-drawer]` | `count == 1` | `1` | 双侧 |
| A2 | `[data-detail-overlay]` | `count == 1` | `1` | 双侧 |
| A3 | `[data-detail-identifier]` | `classList` 含 `td-id-full` 计数 `== 1` | `1` | 双侧（**实现当前 0**） |
| A4 | `[data-detail-templates]` | 无 `hidden` 且 `template[data-detail-for]` 数 > 0 | `[false, true]` | **原型**（模板源是原型腿的断言：§4 R14-B32 已判实现侧 `简化`，§5.x 明文禁把模板/slot 多重性断言到实现） |
| A5 | `template[data-detail-for]` / `[data-slot]` | `count == 18`；`template.content` 内 `[data-slot] == 87`；活 DOM `[data-slot] == 0` | `[18, 87, 0]` | 原型（实现是 1 / 6 / 0，见 §4） |
| A6 | `[data-detail-templates]` / `[data-detail-drawer]` | 模板宿主**不在**抽屉内；`aside` 无 `hidden` | `[false, false]` | **原型**（**模板宿主位置**一条；harness 记作 A6/A6e。`aside` 无 `hidden` 的实现侧义务**不因此消失**，由 §8.0 U4 裁定 + §8.1 D08 承载） |
| A7 | `[data-detail-drawer][aria-labelledby]` | 属性 `== "td-detail-title"` 且指向存在的元素 | `["td-detail-title", true]` | 双侧（**实现当前 null**） |
| A8 | `[data-detail-close]` 与 identifier / chip | 三者同一父元素 | `true` | 双侧 |
| A9 | `[data-detail-props]` | `childElementCount == 16` | `16` | 双侧 |
| A10 | 三个 `[data-detail-save-field]` | `== "assignee"/"reporter"/"labels"` | 同 | 双侧 |
| A11 | `[data-detail-save]` / `[data-detail-save-error]` | `data-save-state=="idle"` + 载体 `hidden` + 错块 `role=="alert"` + `hidden` | `["idle", true, "alert", true]` | 双侧 |
| A12 | `[data-detail-save-error]` | **无** `data-i18n` | `null` | 原型（实现有 ⇒ 口径偏差 §8 U2） |
| A13 | `[data-detail-description]` | tag `div`、class `td-gfm`、父 `section` | `["div","td-gfm","section"]` | 双侧 |
| A14 | `[data-detail-relations]` / `-attachments` / `-comments` / `-activity` | 均为 `div` 且父为 `section`（activity 的父同为 `section`） | `["div","section","div","section","div","div"]` | 双侧 |
| A15 | `[data-detail-agent-session]` | tag `== "section"` | `"section"` | 双侧 |
| A16 | `[data-detail-status]` / `-priority` / `-project` | 三者 tag `== "button"` | `["button","button","button"]` | 双侧（**实现全是 div**） |
| A17 | `[data-detail-status]` 子元素 | `== ["span","span","svg"]` | 同 | 双侧 |
| A18 | `[data-detail-id-copy]` | tag `button` + `data-copy-value` 非空 + 内含 1 个 `svg` | `["button","td_01HQ8ZM4K2P7RQY",1]` | 双侧 |
| A19 | `[data-detail-assignee]` / `-avatar` / `-platform` | `data-assignee-kind=="agent"` ×2；`data-agent-platform=="openclaw"` | 同 | 双侧 |
| A20 | `[data-comment-form]` | 子 = `["label","textarea","div"]`；`label` 数 1；`data-comment-input#td-comment-input`；hint 座位 1；submit 1 | 同 | 双侧 |
| A21 | 抽屉空态 | `[data-detail-relations] > [data-i18n="relations.none"]` 与 attachments 对应项 tag `== "span"` | `["span","span"]` | 原型（实现用 `p`） |
| A22 | `[data-detail-overlay]` / `[data-detail-drawer]` | `z-index` `"40"` / `"50"` | `["40","50"]` | 双侧（**实现 50/60**） |
| A23 | `[data-detail-props] [data-i18n^="prop."]` | `count >= 8` | `15`（实测计数） | 原型（实现 0 ⇒ 缺座位） |
| A24 | — | JS-on 轮 `console.error == 0 && pageerror == 0` | `{0,0}` | 双侧 |
| A25 | 13 个 B09 钩子（JS-off ×1512/430） | 逐个 `count >= 1`；identifier 带 `td-id-full`、`max-width == "none"` | 全通过 | 原型（**证明静态 markup 自足**） |
| A26 | `[data-detail-templates]`（JS-off） | 无 `hidden`、`18` 个模板、`87` 个 slot | `[false,18,87]` | 原型 |

### B · 几何 / 计算样式（真浏览器 computed，1512×950 light en）

| id | 选择器 | 断言式（computed） | 原型实测期望 |
|---|---|---|---|
| B1 | `[data-detail-drawer]` | `width`/`max-width`/`position` | `["520px","1512px","fixed"]`（`max-width:100vw` 解析为视口 px） |
| B2 | `[data-detail-identifier]` | `max-width`/`overflow`/`text-overflow`/`white-space` | `["none","visible","clip","nowrap"]` |
| B3 | `[data-detail-identifier]` | `scrollWidth == clientWidth`（9 字符 `PROJ-0007`） | `[64,64]` |
| B4 | `[data-detail-drawer] .td-drawer-body` | `padding` 四值 | `["16px","20px","24px","20px"]` |
| B5 | 同 | `overflow-y` | `"auto"` |
| B6 | `aside > header` | `padding` 四值 | `["12px","16px","12px","20px"]` |
| B7 | `[data-detail-props]` | `display`/`gridTemplateColumns`/`rowGap` | `["grid","96px 383px","4px"]` |
| B8 | `.td-section-title` | `font-size`/`text-transform`/`letter-spacing`/`margin-bottom` | `["11px","uppercase","0.66px","8px"]` |
| B9 | `section[data-detail-agent-session]` | `padding-top`/`padding-bottom`/`border-top-width` | `["16px","16px","1px"]` |
| B10 | `[data-detail-description]` | `font-size`/`line-height`/`color` | `["13px","19.5px","rgb(74, 85, 94)"]` |
| B11 | `[data-detail-drawer] .td-gfm` | `count == 1` | `1` |
| B12 | `[data-detail-status-chip]` | `height`/`border-radius`/`font-size` | `["18px","999px","12px"]` |
| B13 | `[data-detail-labels]` | `class`/`display`/`min-height`/`padding-left` | `["td-prop-value td-prop-combo","flex","28px","6px"]` |
| B14 | `[data-detail-label-chip]` | tag / 子元素 / `height`/`border-radius`/`font-size`/`padding-left` | `["span",["span","button"],"18px","999px","12px","8px"]` |
| B15 | `[data-detail-label-remove]` | tag / 子元素 / `width`/`height` | `["button",["svg"],"16px","16px"]` |
| B16 | `[data-agent-session]` | `padding` / `border-top-width` / `border-radius`（底色随主题，记录不断言） | `["8px","10px",…,"1px","6px"]` |
| B18 | `[data-detail-activity] > *` | `display`/`align-items`/`padding-top`/`font-size` | `["flex","baseline","3px","12px"]` |
| B19 | `documentElement` | `scrollWidth == clientWidth` | `true` |
| B20 | `[data-detail-drawer]` | 记录 `transform` / 表面色 / 遮罩（不断言） | `matrix(1,0,0,1,0,0)` / `rgb(255,255,255)` / `rgba(15,20,23,0.32)` |
| B21 | `[data-detail-drawer]`（五档宽度） | 宽 `== min(520, 视口)`；无横向溢出；identifier 不被裁 | 1512/1240/980/760 → `520`；430 → `430`；identifier 恒 `63.95px` 未裁 |
| B22 | `[data-detail-drawer]`（light/dark） | `data-theme` 生效；表面/遮罩换 token；遮罩**按各侧自己的遮罩令牌**解析（原型 `--scrim` / 实现 `--brand-scrim`），**不对 light 值做跨侧字面量相等断言**（§8.3 `DF-1`） | 表面 light `rgb(255,255,255)` / dark `rgb(22,27,30)`（**两侧同值，逐字断言**）；遮罩 light = 原型 `rgba(15,20,23,0.32)` / 实现 `oklab(0.276439 … / .32)` ≡ `rgb(31,42,46)/32%`（**token 口径，允许不同**）；遮罩 dark `rgba(0,0,0,0.55)`（**两侧同值**） |
| B23 | `html[lang]`（zh，1512/430） | `lang` = **该侧自己的 locale id**（原型 `zh-CN`；实现镜像 `web/src/i18n/catalogue.mjs:LANGUAGES` 的 `en`\|`zh`，由 `web/src/i18n/index.js` 写 `documentElement.lang`）且无溢出；chip 文案 `待办`；分区标题 `属性` | 原型 `zh-CN`（本页实测，全通过）；实现 `zh`（`T-20261013-154930-3` 实测）⇒ 本条改约后两侧均判通过，不再是恒红项 |
| B24 | `.td-file`（TD-128） | `display`/`padding`/`border-top-width`/`border-radius` | `["flex","6px","8px","1px","6px"]` |
| B25 | `.td-comment`（TD-128） | `display`/`padding-top`/`border-top-width` | `["flex","8px","1px"]` |
| B26 | TD-128 富卡 | 评论 ≥1、`meta` ≥1、头像 ≥1、`.td-rel-item` ≥1、`[data-relation-link]` ≥1 | 全 `true` |
| B27 | `.td-comment-decision`（TD-128） | `count >= 1` | `1` |

### C · 交互（真实点击 / 键盘 / 焦点）

| id | 动作 | 断言 | 原型实测 |
|---|---|---|---|
| C1 | `page.click('[data-card]')` | 抽屉 `data-state=="open"`、`aria-hidden=="false"`、遮罩 `data-state=="open"` 且 `hidden` 摘除 | `{open,false,open,false}` |
| C2 | 打开后 | 焦点在 `[data-detail-close]` 上 | `true` |
| C3 | `focus([data-detail-label-input])` | `[data-detail-label-menu]` 去掉 `hidden` 且 `[data-detail-label-option] > 0` | `{hidden:false,options:15}` |
| C4 | `click([data-detail-label-remove])` | chip 数 −1 | `2 → 1` |
| C5 | 同上（提交点） | `[data-detail-save]` 状态离开 `idle` | `"saving"` |
| C6 | `focus([data-detail-assignee-label])` + `ArrowDown` | 存在未隐藏的 `[data-assignee-menu]` | `true`（选项 8） |
| C7 | `click([data-detail-close])` | `data-state=="closed"`、`aria-hidden=="true"`、遮罩 `hidden` 复位 | 全通过 |
| C8 | 重开 + `Esc` | `data-state=="closed"` | `"closed"` |
| C9 | 全 C 轮 | `console.error == 0 && pageerror == 0` | `{0,0}` |

### 5.x 不得断言（负向组）

- **不得**在实现侧断言 `.td-*` class 的存在（class 是样式，不是契约锚）。
- **不得**在实现侧断言 `data-i18n` 座位集合等于原型（实现用 `$t()` 渲染是合法表达；要断言的是**渲染后的文本**等于目录值，见 §8 D22/D37）。
- **不得**把原型的 `18` 个模板 / `87` 个 slot 多重性断言到实现（框架无 clone 机制，见 §4 R14-B32）。A4 / A6 的**归属列据此写「原型」**（模板源整组是原型腿的断言；实现侧只保留 `aside` 无 `hidden` 这一条义务，见 §8.0 U4 / §8.1 D08）。
- **不得**对遮罩的 light 值做**跨侧字面量相等**断言（原型 `rgba(15,20,23,.32)` vs 实现 `rgb(31,42,46)/32%`）；要断言的是「各侧读**自己的**遮罩令牌 + 该令牌随主题换值 + dark 两侧同值 `rgba(0,0,0,.55)`」（见 §8.3 `DF-1`）。
- **不得**在原型上断言 `[data-attachment-row]` / `[data-activity-row]` / `[data-detail-slot-source]`（原型没有，见 §8 U1）。
- **不得**断言 `[data-detail-save-error]` 有 `data-i18n`（A12 实测 `null`）。
- **不得**用 `[data-slot]` 的活 DOM 计数当「槽位数」（A5 实测恒 0，见 §1.8）。

---

## 6. 实测与复跑

### 6.1 原型改动：**零**

本卡对 `design/prototype/**` **一行未改**（`git status` 在该路径下为空；见提交的改动清单只含 `design/fidelity-r14.md`）。理由（实测支撑，非声明）：

1. 抽屉的钩子、状态机、空态、模板源在五宽度 × light/zh × JS on/off 下**自洽**，`console`/`pageerror` 恒 0（A24/C9）。
2. 五档宽度**无横向溢出**，抽屉宽度按 `min(520, 视口)` 收缩（B21），430 档 identifier 仍未裁（`63.95px`）。
3. 唯一疑似「死规则」`.td-prop-labels`（`src/input.css` 定义、markup 未使用）**不影响任何实测值**，属注释级观察，不作为改动理由（§8 D31 记录了处置）。
4. `design-spec §9` 要求「先测后改」；本卡先测后结论，**无一处需要改**。

> 因此本卡不与 A1（`154954`）争 `design/prototype/index.html` 的写面。

### 6.2 复跑命令与原始输出摘要

```text
$ node workspace/T-20261013-154930/evidence/probe-r14.mjs
wrote …/evidence/r14-measure.json runs: 20 jsOff: 2

$ node workspace/T-20261013-154930/evidence/verify-r14.mjs
{"total":69,"pass":69,"fail":0}
```

`probe-r14.mjs` 的 20 轮 = `{light,dark} × {en,zh} × {1512,1240,980,760,430}`；`jsOff` 2 轮 = `{1512,430}`。

真实摘要（全部可在 `r14-measure.json` / `verify-r14.json` 逐条比对）：

| 量 | 实测 |
|---|---|
| 打开的卡片 | `PROJ-0007`（9 字符） |
| `console.error` / `pageerror` | `0 / 0`（20 轮全同） |
| 横向溢出轮次 | **0 / 20**（每轮 `scrollWidth == clientWidth`） |
| 抽屉宽（light/en 五档） | `520 / 520 / 520 / 520 / 430` |
| 卡体滚动宿主 | `clientHeight 871` / `scrollHeight 1303`（可滚） |
| section 标题点 | 7 个（Properties/Description/Relations/Agent session/Attachments/Comments/Activity），全部 `11px uppercase` |
| zh 抽样 | `lang=zh-CN`、chip `待办`、标题 `属性`、关系空态 `暂无关联` |
| dark 抽样 | 抽屉 `rgb(22,27,30)`、文字 `rgb(230,237,240)`、遮罩 `rgba(0,0,0,0.55)` |

### 6.3 证据目录

```text
workspace/T-20261013-154930/evidence/
  r14-measure.json     # 20 轮 × 逐块 computed/几何/DOM（原始）
  verify-r14.json      # 69 条断言的逐条 pass/fail + actual（原始）
  probe-r14.mjs        # 采集器
  verify-r14.mjs       # 断言运行器
  shots/d-open-1512.png  d-open-1240.png  d-open-980.png  d-open-760.png  d-open-430.png
  shots/d-open-1512-zh.png  shots/d-open-1512-dark.png
```

截图证明「**原型 HTML 本身可见 + 可交互**」：`d-open-*.png` 是真实点击卡片后的打开态全幅。

---

## 7. 文档同步判定（§⑫）

| 文档 | 是否需同步 | 说明 |
|---|---|---|
| `design/BLOCKS.md` §B09 | **需要，但本轮不改** | R14 不新增任何 `data-*` 契约（§4 的 36 块全部用既有钩子）；唯一的候选是 §8 U1（是否把 `[data-attachment-row]` 家族 / `[data-slot-source]` 登记进 B09），**须先由 Elon 裁定方向**再落文档，避免把一处待裁定的自创写成既成事实 |
| `design/BLOCKS.md` §B09 R10 段「with no `data-i18n` hook」 | **已过时** | 实现用的是 `web/src/i18n/extra.mjs:detail.saveError`；该句与 R10 §7 的口径需随 U2 一起重写（本卡只登记） |
| `design/DESIGN.md` | 无影响 | 本轮不触任何设计决策、不新增令牌 |
| `design/README.md` | 无影响 | 索引已按 `fidelity-r*.md` 家族收录，无需新增行 |
| `design/prototype/README.md` | 无影响 | 原型零改动 ⇒ 说明不变 |
| `design/fidelity-r12.md` | **无需改**（但**必须点名未落地**） | R12 的契约内容本身不变；它是本轮的**输入**，未落地这件事登记在 §0 与 §4 R14-B05 |
| `design/BLOCKS.md`（§B09 `Scrim` 行）· `design/fidelity-r8.md` · `design/DESIGN.md` | **无需改**（**回灌** `T-20261014-112216` 的判定） | 回灌只动本契约：§B09 的 `Scrim` 行只登记钩子 `[data-detail-overlay][data-state]`，遮罩的**令牌口径**本已由 `design/BLOCKS.md` §B10 的 R8 段（「one token, every veil」+ 实现侧 light 值「must not be churned」）与 `design/fidelity-r8.md` 的实现偏离表承载 ⇒ 无新增事实可登记；§8.3 `DF-1` 只是把它**点名到 B09 这一面**并给出跨侧断言口径 |

---

## 8. 红线与未决 + 本轮要补的样式细节全集

### 8.0 未决项（**须 Elon 裁定，不自行发散**）

- **U1 — 三条「自创」钩子族怎么收口**：`[data-attachment-row]` / `[data-attachment-name]` / `[data-attachment-size]` / `[data-activity-row]` / `[data-activity-actor]` / `[data-activity-ts]`（已被 `test/web/blocks.contract.mjs` §B09 背书）在原型中**不存在**；`[data-detail-slot-source]` 则**已在** `design/BLOCKS.md` 的 Auxiliary hooks 表与 `design/prototype/app.js` 中出现（原文「只在该组件里／在原型中不存在」据此**如实修正**），U1(b) 的判定对象是它作为**实现侧**是否存在消费方。
  - 选项 A：**回填原型**（在 `index.html` 的抽屉 markup 上补这些钩子）+ 登记进 `BLOCKS.md` §B09 ⇒ 变成 `缺失口径`。代价：改 `design/prototype/index.html`（与 A1 串行）。
  - 选项 B：**回退实现**到原型的 class 形状（`.td-file` / `.td-activity`）⇒ 变成 `对齐`。代价：改 `test/web/blocks.contract.mjs`（本卡禁改）+ 实现卡工作量。
  - 本卡**不选**，只登记。B2 **在裁定前不得**照此清单动这两族。
  - **▶ 裁定（Elon，2026-10-13）**：**U1(a)** —— 该六枚钩子已被 `test/web/blocks.contract.mjs` §B09 背书 ⇒ **不修原型**（禁以实现反推原型 markup）；改在 `design/BLOCKS.md` §B09 登记为「实现侧测试钩子（原型无 / 测试背书 / 实现保留）」。契约与 `test/**` 不动。**U1(b)** —— `[data-detail-slot-source]` **归 B2**：先确认无消费方则删除；若确有功能消费方则改登记 `design/BLOCKS.md`。
- **U2 — `[data-detail-save-error]` 的文案座位**：R10 §7 与 `BLOCKS.md` §B09 写「no `data-i18n` hook」，实现用 `data-i18n="detail.saveError"`（键在 `extra.mjs`，是**实现自撰**的合法归宿）。若裁定「保留座位」，则 R10 那两处文字须改；若裁定「回到内联」，则实现要去掉座位、文案内联。**本卡按现状记为 `口径` + 书面偏差**（§4 R14-B09）。
  - **▶ 裁定（Elon，2026-10-13）**：**保留**实现座位 `data-i18n="detail.saveError"`；`design/BLOCKS.md` §B09 与 `design/fidelity-r10.md` §7 的措辞按此改写为「原型内联、实现侧有座位」；契约对原型的 **A12 不变**。
- **U3 — R12 的落地归属**：R12 的契约已存在、实现未落地（§0、§4 R14-B05）。请裁定是由 **B2（本族实现卡）** 一并补，还是单独开一张 R12 实现卡。
  - **▶ 裁定（Elon，2026-10-13）**：R12 实现（`340710c` / 源 merge `0c3df7b`）**非 main 祖先** ⇒ 集成遗漏；由 R12 族卡 `T-20261013-033933` 以**非破坏 `merge --no-ff`** 并入 main 收尾（本卡不处理）。**实测补记（本卡基线）**：该 `merge --no-ff` 已落地为 main 的 `6888821`，`git merge-base --is-ancestor 0c3df7b main` 现为真 ⇒ U3 已收口。
- **U4 — 抽屉 `hidden` 与 C06**：原型 `aside` 只靠 `data-state` + `transform/visibility`；实现额外挂 `hidden`（并配 `.td-drawer[hidden]{display:none}`）。C06 的措辞（「`hidden` 或 `data-state`」）两种都对，故本卡记 `口径` 而非违规；**若采纳 B01 的目标（去 `hidden`）**，请确认不触碰 C06 的措辞。
  - **▶ 裁定（Elon，2026-10-13）**：采纳 B01 目标 —— **去 `aside` 的 `hidden`**，改由 `data-state` 驱动；移除自创 `:aria-hidden`；**C06 措辞不动**（本卡不处理，只记结论）。

### 8.1 本轮要补的样式细节全集（50 条，供 B2 逐条实现）

> 格式：`编号 | 原型出处（文件:选择器） | 原型值/规则 | 实现现状（文件:符号） | 判定 | 机检断言编号`。
> 目标值即「原型值」一列；**不得**写成「大致加上某某样式」。实现现状一律**实读**。

**A. 抽屉壳层（D01–D13）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D01 | `prototype/src/input.css:.td-drawer` | `width: var(--shell-drawer)` = **520px** | `app.css:.td-drawer` `w-[min(560px,100vw)]` | 口径 | B21/B1 |
| D02 | 同上 | `max-width: 100vw` | `.td-drawer` 已有 | 对齐 | B1 |
| D03 | 同上 | `border-inline-start: 1px solid var(--color-td-line)`（light `rgb(230,232,235)`） | `.td-drawer` 已有 | 对齐 | B20 |
| D04 | 同上 | `box-shadow: var(--shadow-pop)` | `.td-drawer` 已有 | 对齐 | B20 |
| D05 | 同上 | `z-index: 50` | `.td-drawer` `z-[60]` | 口径 | A22 |
| D06 | `.td-scrim` | `z-index: 40`；`position: fixed`；`inset: 0` | `DetailDrawer.vue:[data-detail-overlay]` `z-50` | 口径 | A22 |
| D07 | `.td-scrim` | `background-color: var(--scrim)`；打开态 `opacity: 1`。**既有令牌口径保留**：实现读等价的既有令牌 `--brand-scrim`（light 解析 `rgb(31,42,46)/32%` ≠ 原型字面量 `rgba(15,20,23,.32)`；dark 两侧同值 `rgba(0,0,0,.55)`）—— 该令牌**不得改值**，书面偏差见 §8.3 `DF-1` | `bg-(--brand-scrim)` | 口径 | B20/B22 |
| D08 | `.td-drawer` | 关闭态 `transform: translateX(100%)` + `visibility: hidden`；**无 `hidden` 属性** | `DetailDrawer.vue` 额外 `:hidden="!open"` | 自创 | A6 |
| D09 | `.td-drawer` | **无 `aria-hidden`** | 实现写了 `:aria-hidden` | 自创 | —（§8 U4 待裁定） |
| D10 | `.td-drawer-head` | `padding: 12px 16px 12px 20px` | header `p-4`（16px 四边） | 缺 | B6 |
| D11 | `.td-drawer-head` | `border-bottom: 1px solid var(--color-td-line)` | `border-b border-b-(--brand-border)` | 对齐 | — |
| D12 | `.td-drawer-body` | `padding: 16px 20px 24px` | 卡体 `p-4` | 缺 | B4 |
| D13 | `.td-drawer-body` | `overflow-y: auto`、`min-height: 0`、`flex: 1 1 auto`、`scrollbar-width: thin` | `flex-1 overflow-y-auto`（缺 `min-h-0` / `scrollbar-width`） | 缺 | B5 |

**B. 头部（D14–D19）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D14 | `[data-detail-identifier]`（`.td-id.td-id-full`） | 文本 = **完整 id**，**不做字符切片** | `DetailDrawer.vue`：`identifierText(identifier)`（`lib/identifier.js` 切 8 字符） | 缺 | A3 |
| D15 | `app.css` 对应位置需**新增** `.td-id-full` | `max-width: none; overflow: visible; text-overflow: clip;` | `app.css` 无该规则（`grep td-id-full web/` 零命中） | 缺 | B2 |
| D16 | 同上 | 带 `.td-id-full` 时 computed `["none","visible","clip","nowrap"]` | 当前 computed 为 `9ch` 路径（实读，未实测） | 缺 | B2/B3 |
| D17 | `.td-id-full` 规则须**紧随** `.td-id` 同层定义 | 同特异性下后者胜出 | — | 缺 | B2 |
| D18 | `[data-detail-identifier]` | `12px`、`rgb(126,138,145)` | `DetailDrawer.vue`：`td-mono td-id`（无字号/颜色 utility） | 缺 | — |
| D19 | `[data-detail-title]`（`.text-lg.font-semibold`） | `16px` / `600` | `<h2 data-detail-title>` 无字号/字重 utility | 缺 | — |
| D20 | `aside[data-detail-drawer]` | `aria-labelledby="td-detail-title"`，`h2[data-detail-title][id="td-detail-title"]` | 两者皆无 | 缺 | A7 |

**C. 保存态与属性网格（D21–D28）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D21 | `.td-save-error` | `border:1px` `rgb(192,57,43)`、底 `rgb(251,238,236)`、圆角 `6px`、`12px`、`margin-bottom:12px` | `app.css:.td-save-error` 已有等价规则 | 对齐 | — |
| D22 | `[data-detail-save-error]` | **无 `data-i18n`** | 实现挂 `data-i18n="detail.saveError"` | 口径 | A12（§8 U2） |
| D23 | `.td-props` | `grid-template-columns: 96px minmax(0,1fr)`；`row-gap: 4px`；**无列间距** | `DetailDrawer.vue` 多 `gap-x-3`（12px） | 口径 | B7 |
| D24 | `.td-prop-label` | `12px`、`rgb(126,138,145)` + `data-i18n="prop.*"` 座位 | 尺寸/颜色 ✅（`text-[12px] text-(--brand-text-3)`）；**无 `data-i18n` 座位** | 缺 | A23 |
| D25 | `.td-prop-value` | `inline-flex`、`gap: 6px`、`min-height: 28px`、`padding: 0 6px`、`13px`、`border: 1px transparent`、圆角 `4px` | 各值 `gap-1`(4px) / `px-1`(4px)，无透明边框与圆角 | 缺 | — |
| D26 | `button.td-prop-value` | `cursor: pointer`；hover `background: var(--color-td-hover)` + `border-color: var(--color-td-line)` | `[data-detail-status]`/`-priority`/`-project` 是 `<div>` | 简化 | A16 |
| D27 | `[data-detail-labels]` | 根**自身**是 `.td-prop-value.td-prop-combo`（`min-height:28px`、`padding:0 6px`） | prop 样式挂在外层 div，根是无 class 内层 div | 简化 | B13 |
| D28 | `.td-copy` | `inline-flex`、`gap:6px`、mono `12px`、`rgb(74,85,94)`、`padding: 2px 6px`、圆角 `4px` | `[data-detail-id-copy]` 用文字 `⧉`，无该度量 | 口径 | A18 |

**D. 分区与标题（D29–D32）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D29 | `.td-section` | `padding: 16px 0`；`border-top: 1px solid var(--color-td-line)`；`:first-child` 去二者 | 实现用 `border-t pt-3`（12px） | 缺 | B9 |
| D30 | `.td-section-title` | `font-size: 11px`；`font-weight: 500`；`letter-spacing: 0.06em`；`text-transform: uppercase`；`color: ink-3`；`margin: 0 0 8px` | `text-[13px] font-semibold mb-2` | 缺 | B8 |
| D31 | `.td-prop-labels` | 定义存在但 **markup 未使用**（死规则）——**本卡不改原型**；若 B2 决定给 labels 行一个专属类，此规则即为现成目标 | 无 | 口径（记录） | — |
| D32 | `[data-detail-description]` 的**挂点** | 挂在 `div.td-gfm`（内容容器），父为 `section` | 实现把它挂在 `<section>` 本体 | 口径 | A13 |

**E. GFM 只读面（D33–D36）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D33 | `.td-gfm` | `font-size: 13px`；`line-height: 1.5`；`color: ink-2` | `app.css:.td-gfm` 用 `--text-14` | 缺 | B10 |
| D34 | `.td-gfm > * + *` | `margin-top: 8px` | 无 | 缺 | — |
| D35 | `.td-gfm` 富元素 | `h4` 13px/600 `margin:12px 0 0`；`ul/ol` `padding-left:18px`；`li+li` 2px；`code` 盒（sunken 底、1px 边、圆角 4px）；`pre`（`8px 10px`、圆角 6px）；`blockquote`（`border-left: 2px`、ink-3）；`table`（`width:100%`、`border-collapse`、`th` 底 sunken） | `app.css:.td-gfm` 只有 `pre`/`code` 两条 | 缺 | — |
| D36 | `.td-gfm .td-task-list` / `.td-check` | 无项目符号、`display:flex`；`.td-check` 13×13、圆角 3px、`[data-checked="true"]` → success 色 | 无 | 缺 | — |

**F. 卡体分区（D37–D46）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D37 | `[data-detail-relations]` 挂点 + `.td-rel` | 挂在 `div.td-rel`（`flex-wrap`、`gap:4px 8px`），每项 `.td-rel-item` = `[data-i18n="relations.parent\|blocks\|related"]` + `button.td-copy[data-relation-link]` | 挂在 `<section>`；`<ul>` + `type · label` 文本链接 | 简化 | A14/B26 |
| D38 | `[data-detail-comments]` 挂点 | `div`（父 `section`） | 挂在 `<section>` 本体 | 口径 | A14 |
| D39 | `.td-comment` | `flex`、`gap:8px`、`padding:8px 0`、`border-top:1px`（`:first-child` 无） | `flex-col`、`border-b`、无 `gap:8px` | 缺 | B25 |
| D40 | `.td-comment` 内部 | `.td-avatar` + `.td-comment-meta`（`flex`、`gap:6px`、`12px`、ink-3，含作者 + kin + `[data-i18n="time.*"]` 时间戳）+ `.td-comment-body`（13px、ink-2、`white-space: pre-line`） | 无头像、无时间戳、`<p>` 正文 | 缺 | B26 |
| D41 | `.td-comment-decision` | `padding-left: 8px`；`border-left: 2px solid var(--color-td-accent)` | 无 | 缺 | B27 |
| D42 | `.td-file` | `flex`、`gap:8px`、`padding:6px 8px`、`1px` 边、圆角 `6px`；`.td-file-name` 12px/500；`.td-file-size` mono 11px 灰、`margin-left:auto`；`.td-file + .td-file` `margin-top:8px` | `DetailDrawer.vue` Tailwind 近似，无 `.td-file` 家族 | 缺 | B24 |
| D43 | `.td-session` | `padding: 8px 10px`；底 `rgb(245,246,247)`；`1px` 边；圆角 `6px` | 无盒子（两行裸 `<p>`） | 缺 | B16 |
| D44 | `[data-agent-session]` 行 1 | `.badge.badge-xs.td-agent-badge[data-agent-platform]` + `[data-agent-platform-value]`（mono 12px）+ `button.btn.btn-outline.btn-xs[data-agent-resume]` 推右 | span + p + `btn btn-ghost btn-xs` | 缺 | A19 |
| D45 | `[data-agent-session]` 行 2 | `[data-i18n="session.id"]` + `span.td-copy[data-agent-session-id]` | `<p>` + 裸 span（无 `.td-copy`） | 缺 | — |
| D46 | `.td-activity` | `flex`、`gap:8px`、`align-items:baseline`、`padding:3px 0`、`12px`、ink-2；`.td-activity-ts` mono 11px 灰、`margin-left:auto`、`nowrap` | Tailwind 近似（`flex items-baseline gap-2 py-[3px] text-[12px]`） | 简化 | B18 |

**G. 评论表单与空态（D47–D50）**

| id | 原型出处 | 原型值/规则 | 实现现状 | 判定 | 断言 |
|---|---|---|---|---|---|
| D47 | `[data-comment-form]` | `label.td-sr[for="td-comment-input"]`（`data-i18n="drawer.comment"`）+ `textarea#td-comment-input.td-textarea` + `[data-i18n="drawer.commentHint"]`（11px ink-3）+ `button.btn.btn-primary.btn-sm[data-comment-submit]` | 只有 `textarea` + `button` | 缺 | A20 |
| D48 | `.td-textarea` | `width:100%`；`min-height:64px`；`padding:6px 8px`；`13px`；`1px` 边；圆角 `6px`；`resize: vertical`；hover/focus 换边框 + `box-shadow: 0 0 0 3px var(--color-td-focus)` | Tailwind 近似（`min-h-16`、`rounded-[6px]`、`p-2`） | 缺 | — |
| D49 | 空态 | 注入 **`span.text-xs.text-td-ink-3[data-i18n="description.none\|relations.none\|attachments.none"]`**（A21 实测 tag `span`） | `<p class="text-[12px] text-(--brand-text-3)" data-i18n=…>` | 口径 | A21 |
| D50 | `.td-chip` / `.td-chip-remove`（labels 行） | chip = `.badge.td-chip`（高 18px、圆角 999px、12px、`padding 2px 4px 2px 8px`、accent-soft 底、`title`）；remove = `button.td-chip-remove` **16×16**、内含 `svg.td-icon-sm`、`aria-label="Clear <name>"`、`title="Clear"` | `ComboField.vue`：chip `rounded-[4px] bg-(--brand-sunken) text-[11px]`；remove 是文字 `✕` | 缺 | B14/B15 |

### 8.2 边界（本轮**不**动什么）

1. **零实现**：`web/**`、`test/**`、`src/**`、`server/**` 一行不动；`git diff -- web/ test/ src/` 为空。
2. **纯度门禁**：本卡新增的进仓文件只有 `design/fidelity-r14.md`（纯 Markdown）——本文件内**不含**任何网络请求调用、鉴权令牌字面量、浏览器持久化调用，也不含版本化接口路径；证据脚本全部落在项目外 workspace，**不进仓**。（这条门禁的九种模式本文件命中 0；本句本身不逐字写出它们，以免扫描器把说明文当作命中。）
3. **不改原型实现纯度**：即使 §4 的 B27/B31/B33 是「实现侧多出来的钩子」，也**不**用改原型的方式去追平（§8 U1 待裁定）。
4. **不新增 i18n 键**：本卡不要求任何新键；`detail.saveError` 已存在于 `web/src/i18n/extra.mjs`（实现自撰归宿），两个目录副本（`test/web/i18n.catalogue.mjs` / `web/src/i18n/catalogue.mjs`）**不得**因本轮而分叉。
5. **不改契约测试**：`test/web/blocks.contract.mjs`、`web/scripts/dom-smoke.mjs` 一律不动——U1 的两种收口方式都会触及它们，因此**先裁定后施工**。

### 8.3 偏差登记（与原型字面量的偏离 · `DF`）

> 只登记**已裁定、且实现侧不改**的偏离；裁定前不得据此动实现。**登记 ≠ 放宽**：§8.1 的 `缺`／`简化`（含 D42 附件行几何）不在此表，判定与断言原样保留。格式 = `id | 偏离点（契约位点） | 原型字面量 | 契约采用的口径 | 理由 | 裁定/出处`。

| id | 偏离点（契约位点） | 原型字面量（实测） | 契约采用的口径 | 理由 | 裁定/出处 |
|---|---|---|---|---|---|
| **`DF-1`** | **light 遮罩的涂出色** —— §3「遮罩」行 · §4.1 R14-B03 · §5 B22 · §8.1 D07 | `rgba(15,20,23,0.32)`（= `#0f1417`，即原型深色画布色；`design/prototype/src/input.css:--scrim`） | **既有令牌口径保留**：实现读**既有共享令牌** `--brand-scrim`（`web/src/styles/tokens.css:--brand-scrim`）⇒ light 解析 `oklab(0.276439 … / .32)` ≡ **`rgb(31,42,46)` / 32%**（= `--color-neutral` light `#1f2a2e` 的 32%）；**dark 两侧同值 `rgba(0,0,0,0.55)`，不变** | ① `--brand-scrim` 是**既有共享令牌**，被 `CreateTaskModal` / `CreateProjectModal` / `DetailDrawer.vue` **三面共持**（实读）⇒ 改值 = 跨面回归，超出本轮写面（本轮只写 `design/**`）。② 实现侧**要求三面同值**：`web/scripts/dom-smoke.mjs` 的 R8 检查**断言抽屉遮罩与弹窗 scrim 相等**（其失败消息原文：`the drawer's veil … != the dialog's scrim — they share one token`）⇒ 为抽屉单独改值即违该不变式。③ 触 §3「令牌守恒」红线（本轮不改既有令牌的值）。④ light 值本就是实现侧**自己的既有值**（R8 为深色覆写而把它提成令牌时**刻意保留**，原文「the light value is the one those surfaces have always carried」/「must not be churned」；见 `design/fidelity-r8.md` §实现偏离表 与 `design/BLOCKS.md` §B10 R8 段）；原型字面量 `rgba(15,20,23,.32)` 是**原型专有表述**（`.td-scrim` 读它自己的 `--scrim`），不是实现侧的令牌语义 | **Elon 裁定**（2026-10-14，卡 `T-20261013-154930-3` `## Comments` · decision）：取「保留既有令牌 + 改约/改断言」。独立验证原始读数见 `T-20261013-154930-3` §4.3 与 `review/evidence/r14-impl.json`（B22） |
| **`DF-2`** | **版本座 `[data-detail-version]` 的值形态** —— §4.1 `R14-B18`（属性行 · version） | `v3`（卡属性静态样例；`design/prototype/index.html:[data-detail-version]`，`design/prototype/app.js` 原样写出） | **实现侧渲染 `data.version` 的真实值**（`web/src/components/detail/DetailDrawer.vue:[data-detail-version]` 的 `versionText` ⇒ `3`）；**live 真板实测亦为 `3`** | `v3` 是原型 mock 数据的表达，**不是值语义**；实现（及真数据）取真实值更正确 ⇒ **实现不改** | **Jobs 裁定**（2026-10-14，本卡 `T-20261014-154730-4`，待 Elon 验收）。来源读数：`T-20261014-150729` §4 #4 |
| **`DF-3`** | **头像 monogram 的取字规则** —— `.td-avatar` · `[data-card-assignee]` · `[data-detail-assignee-avatar]` · `[data-detail-reporter-avatar]` | **人类 1 字**（`T`）、**agent 2 字**（`EL` / `JO` / `LI` / `TU` / `SI` / `AS`）—— `design/prototype/app.js:MONOGRAM` 表 + `design/prototype/app.js:monogram()`（回退 `design/prototype/app.js:initials()`，取每个词首字母、至多 2 个） | **实现侧一律 1 字**（`web/src/components/board/Card.vue:monogram` 的 `charAt(0)`；`web/src/components/detail/DetailDrawer.vue:initial()`）；**本轮不改实现** | agent 2 字是**原型专有表达** —— `design/BLOCKS.md` 从未把字数写成契约；实现侧既有简化（与 `--r-full` 圆盒一致）登记为可接受 | **Jobs 裁定**（2026-10-14，本卡 `T-20261014-154730-4`，待 Elon 验收）。**若 Elon 要追平原型 ⇒ 另开实现卡**（`web/**` 非本卡写面）。来源读数：`T-20261014-150729` §4 #5 |
| **`DF-4`** | **会话行平台值 `[data-agent-platform-value]` 的座位内容** —— §4.1 `R14-B25`（B16 会话溯源）· §5 B16 | `--agent-platform claude`（会话行 `td-mono` 文本；`design/prototype/index.html:[data-agent-platform-value]`） | **该座位内容 = 平台 id**（如 `claude` / `openclaw` / `codex` / `pi`；实现 `web/src/components/detail/DetailDrawer.vue:[data-agent-platform-value]` 渲染平台 id，由 `web/src/stores/board.js:platformOf()` 派生）；**live 真板亦为 id 形态**。`--agent-platform` **既不是该座位的内容、也不是实仓中存在的 CSS 自定义属性** | 原型字面量是原型的 mock/CLI 回显表达，**不构成内容契约**；`design/BLOCKS.md` §B16 原措辞（把 `--agent-platform claude` 写成座位值）读起来像「可见文本」，据此订正 | **Jobs 裁定**（2026-10-14，本卡 `T-20261014-154730-4`，待 Elon 验收）；同行订正 `design/BLOCKS.md` §B16 文案（**仅文档，`test/**` 非本卡写面**）。来源读数：`T-20261014-150729` §4 #6 |

**据此的跨侧断言口径**（§5 B22 / §5.x 已按此写）：遮罩**只**断言「各侧读自己的遮罩令牌 + 该令牌随主题换值 + dark 两侧同值 `rgba(0,0,0,0.55)`」，**不对 light 的绝对值做跨侧相等断言**；抽屉表面色（light `rgb(255,255,255)` / dark `rgb(22,27,30)`）仍**逐字**断言，深色遮罩加深这一 R8 结论不受影响。

> **交叉指引（I-8）**：`T-20261014-150729` §4 #10 的「遮罩涂出色 `rgba(15,20,23,.32)` vs `oklab(…)`」**≡ `DF-1`**（同色同 alpha，token 口径）—— **非差、不新增行**，复核按 `DF-1` 的跨侧断言口径执行。

### 8.4 原型侧登记（该座位不得以原型作 oracle · `PF`）

> 与 §8.3 `DF` 相对：`DF` 是「原型对、契约改约」；**`PF` 是原型自身的缺陷** —— 原型在此座位**内容**级的读数**不得**当 oracle，复核/机检只能以「实现跟随运行时真值」为准。**登记 ≠ 放宽**：§8.1 的判定与断言、§5 的机检项原样保留。

| id | 座位 | 机制 | 义（该座位 oracle 归属） |
|---|---|---|---|
| **`PF-1`** | 抽屉头状态徽 `[data-detail-status-chip] > [data-detail-status-chip-label]` | 卡模板的该座位**静态带 `data-i18n="status.todo"`**（`design/prototype/index.html`）；`design/prototype/app.js:openDetail()` 先按 `data.status` 写下**逐卡真实状态**，随后 `design/prototype/app.js:translateTree()` 把该 `data-i18n` 钩子重新解析，**覆写回模板默认的 `To Do`**。已被 `design/prototype/app.js:openDetail()` 中 `translateTree($drawer)` 之后的复述修好（`T-20261014-154730-4`）；修复**只动 `app.js`**，`index.html` 的静态钩子保留给 JS-off 默认态 | **该座位的 oracle = 实现「跟随该卡真实状态」**（原型修好后同义）。**修复前**，该座位的内容**不得**当 oracle。**修复后**，`index.html` 的静态默认态**仍非 oracle** —— 逐卡状态只在运行期成立（JS-off 下该座位无法表达任何逐卡状态）。对照口径：chip 的**盒径/类/字号**（§5 B12 = `18px`/`999px`/`12px`）与 `[data-detail-status-chip]` 的 `data-status` 属性**两侧一致、照旧断言**，只有**内容（label 文本）**这一维按本条走 |
