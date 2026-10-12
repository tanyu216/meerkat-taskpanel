# UI 保真契约 · R12 — 抽屉头的标识符逐字显示完整 task id

> 卡：`T-20261013-023310` · 日期 2026-10-13 · 范围「Terry 需求：任务详情抽屉的标识符要看到完整 id」。
> 来源：Terry —— 详情抽屉（**B09**）里的标识符要看到完整 id，例如 `TD-20261012-222353`，而不是 `TD-20261…`；**B07 卡片 / B08 列表保持现状不变**（仍是「8 字符 + …」）。
> 契约唯一事实源：`design/prototype/index.html` + `design/prototype/src/input.css` + `design/prototype/app.js` + `design/prototype/tw.css` + `design/BLOCKS.md`（B01–B25）。
> 证据口径：本契约每条断言都在**真实浏览器（Chromium headless / Playwright）里对原型实测**，「期望值」即实测值；改前（before）/ 改后（after）各测一轮，两份原始记录见 §6。
> 关系卡：实现卡（`web/**` 镜像改动）与验证卡由 Elon 派发；**本卡只产契约与原型改动，不含实现代码**。
> 基线 commit：`2eb6a9e`（本卡开工时的 HEAD）。同族前序：**R8**〔`T-20261012-211516`〕定了「8 字符 + …」的上限口径、`.td-id` 单行兜底与「身份不走在文本里」的规则；本卡**只对 B09 解除宽度上限**，R8 的其余口径原样成立——取代关系逐条写在 §2.4 与 §3。

## 0. 结论摘要

- 需求**只落在既有块 B09** ⇒ 本契约**不引入新块**、**不新增任何 `data-*` 钩子**（`[data-detail-identifier]` 与其根 `[data-detail-drawer][data-identifier]` 都已存在），也**不引入新的 i18n 键**（id 是**数据**，不是文案）。
- 上限在原型里是**两处**实现（`design/prototype/src/input.css` 的 `.td-id` 宽度上限 + `design/prototype/app.js` 的 `identifierText()` 字符切片）。**只改一处不足以「显示完整 id」**：切片去掉、`.td-id` 的 `max-width: 9ch` + `overflow: hidden` + `text-overflow: ellipsis` 仍会把长 id **视觉裁切**（实测：18 字符样本在改前被裁到 65.02px，见 §5 A3′）。所以本轮**两处都动，且只动 B09 那条路径**。
- **渲染层**：`openDetail()` 写 `[data-detail-identifier]` 时**删除 `identifierText()` 调用**，直接写卡片 `data-identifier` 的原值。`identifierText()` **函数保留**——B08 的 `renderList()` 与 B07 动态卡片的渲染点仍用它。
- **样式层**：B09 头部的 class 列表**追加**变体类 **`.td-id-full`**（`max-width: none; overflow: visible; text-overflow: clip;`），**与 `.td-id` 并存**、**不改 `.td-id` 本体**。其余（`display`、`white-space: nowrap`、`vertical-align`）**继承 `.td-id`**。
- **一处真实发现（实测，非声明）**：三处标识符在浏览器里 computed `display` 都是 **`block`**，不是 `.td-id` 声明的 `inline-block` —— 它们各自是 flex 行 / grid 单元格的**子项**，`inline-block` 被 blockify。R12 **不动 display**，去上限只改 `max-width` / `overflow` / `text-overflow` 三项（§5 A2 实测）。
- **B07 / B08 逐字不动**（反向断言 A4–A6）：卡片的静态 markup 与 `renderList()` 的调用一行未改，文本仍是 `PROJ-000…`、computed 上限仍在（卡片 59.603px、列表行 65.0215px），两者都**不含** `.td-id-full`。
- **零 i18n 增量**（A9）：`index.html` 的 `data-i18n*` 座位 **622 → 622**（分部逐个相等），`app.js` 的 `MESSAGES` 键 **en 224 / zh 224 → 224 / 224**。
- **`tw.css` 重建后新增类选择器恰好 1 个**（A10）：`.td-id-full`；逐行 diff 只有 5 行新增，**无**注释裸词被扫描器误产的成分（F8 的坑本轮未触发）。
- **机检断言 A1–A10 逐条可判**（§5），改前 / 改后各一轮，两轮 `console` / `pageerror` 均为 **0**（A8）。
- **本卡不改 `web/**`、`test/**`**：实现侧改点已实读定位（§2.3 表），随实现卡落地。

---

## 1. 契约口径与证据规则

**口径（闭集，逐字使用）**：`对齐` = 与原型一致；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」（或「文件:符号」），**禁止行号**；跨文档引用只用「文档名 §小节」或 selector。

**证据规则**：

1. 「期望值」= 原型在真实浏览器中的**实测值**（`getComputedStyle` / `getBoundingClientRect` / `getClientRects` / `scrollWidth`·`clientWidth` / DOM 计数 / 真实指针），不是 `src/input.css` 某条声明的字面值；两者不一致时**实测值胜**（§0 的 `display: block` 就是这条规则的产物）。
2. 「改前 / 改后」= 同一探针脚本（`workspace/T-20261013-023310/verify/r12-probe.mjs`）在原型改动前后各跑一次，同一视口（1512×950）、同一语言族（en 为断言语言）、同一主题（light）；原始记录 `verify/probe-before.json` / `verify/probe-after.json`（**均不进仓**）。
3. 「改前」是对 **HEAD 版原型的一份独立副本**实测的（`verify/pristine/`，逐字取自 `git show 2eb6a9e:design/prototype/*`，由 `verify/make-pristine.mjs` 生成）—— 同一探针对同一旧版重跑，不是推断，也不是从 diff 反读。
4. **`9ch` 是一个宽度，不是一个字符串**：`getComputedStyle().maxWidth` 把 `max-width: 9ch` 解析成 px（随字面（face）的 advance width 与元素自身 `font-size` 变化：**卡片 11px → 59.603px**，**抽屉头 / 列表行 12px → 65.0215px**）。因此契约里**「上限在」= 一个有限的 px 值**，「上限解除」= 字面 `none`；**不得**断言 computed 值等于字符串 `9ch`。
5. 本轮原型 `console` / `pageerror` 均为 **0**（两轮皆是，§6）。
6. 实现侧本轮**未到场实测**（未构建 `web/dist`）；凡涉及实现的位点均标注「实读」。

**共用实测值（原型，1512×950，light，en）**：

| 量 | 改前 | 改后 |
|---|---|---|
| 抽屉头 `[data-detail-identifier]` 文本（打开 9 字符卡 `PROJ-0007`） | **`PROJ-000…`** | **`PROJ-0007`** |
| 同上：`title` | `PROJ-0007` | `PROJ-0007`（**不变**） |
| 同上：class 列表 | `td-mono text-xs text-td-ink-3 td-id` | **`… td-id td-id-full`** |
| 同上：computed `max-width` / `overflow` / `text-overflow` | `65.0215px` / `hidden` / `ellipsis` | **`none` / `visible` / `clip`** |
| 同上：computed `white-space` / `display` | `nowrap` / `block` | `nowrap` / `block`（**不变**） |
| 同上：`scrollWidth` / `clientWidth` | `64` / `64` | `64` / `64` |
| 同上（**18 字符样本诊断** `TD-20261012-222353`，运行时换文本） | `scrollWidth 128` > `clientWidth 65` ⇒ **被裁** | `scrollWidth 128` = `clientWidth 128` ⇒ **不裁** |
| 抽屉根 `[data-detail-drawer]` 的 `data-identifier` | `PROJ-0007` | `PROJ-0007`（**不变**） |
| 抽屉内 `[data-detail-id]`（`td_…`）文本 | `td_01HQ8ZM4K2P7RQY` | 同（**不变**、无 `.td-id`） |
| 卡片 `[data-card-identifier]`（9 字符卡）文本 / 上限 | `PROJ-000…` / `59.603px` ellipsis | `PROJ-000…` / **同一值**（**不变**） |
| 卡片 `[data-card-identifier]` 的 class 列表 | `td-card-id td-id` | **同一（不含 `td-id-full`）** |
| 列表行 `[data-list-identifier]`（9 字符行）文本 / 上限 | `PROJ-000…` / `65.0215px` ellipsis | `PROJ-000…` / **同一值**（**不变**） |
| 列表行 `[data-list-identifier]` 的 class 列表 | `td-mono text-xs text-td-ink-3 td-id` | **同一（不含 `td-id-full`）** |
| 短 id 回归（6 字符 `TD-128`，两处） | `TD-128`（两处皆无省略号） | `TD-128`（**不变**） |
| 脚本关闭：抽屉头种子 | `TD-128`、`td-id`、被绘制、`max-width 65.0215px` | `TD-128`、**`td-id td-id-full`**、被绘制、**`max-width none`** |
| 脚本关闭：`[data-card]` 计数 | `18` | `18`（**不变**） |
| `data-i18n*` 座位数（`index.html`，静态） | `622`（404/8/48/18/144） | **`622`（分部逐个相等）** |
| `MESSAGES` 键数（`app.js`） | en `224` / zh `224` | **`224` / `224`** |
| `tw.css` bytes | `193283` | **`193372`**（+89；新增类选择器恰 1 个） |
| 五档视口（1512/1240/980/760/500）下的抽屉头：9 字符自然文本 | `63.95px`（`max-width 65.0215px`），未被裁；页面无溢流 | 同宽，`max-width none`，未被裁；页面无溢流 |
| 同上，**运行时换成 18 字符样本** | **`65.02px`（被上限压住）** | **`127.89px`（完整）**，五档**都仍在抽屉内**、页面无溢流 |
| 页面 `scrollWidth` / `clientWidth` | `1512` / `1512` | `1512` / `1512`（无溢流） |
| `console` / `pageerror` | `0` / `0` | `0` / `0` |

---

## 2. 逐项契约

### 2.1 项① `B09.drawer-head-full-id` — 头部文本 = 逐字完整 id

**形状**（`design/prototype/index.html`，`design/BLOCKS.md` §B09）：

| | |
|---|---|
| 根 | `aside[data-detail-drawer][data-state="closed\|open\|closing"]`（既有，未动） |
| 头部标识符 | `span.td-mono.text-xs.text-td-ink-3.td-id.td-id-full` + `[data-detail-identifier]` |
| 文本来源 | 卡片 `[data-card][data-identifier]` 的**原值**（`openDetail()` 的 `data.identifier`），**不做任何切片** |
| `title` | **同一个**完整 id（既有行为，不改） |
| 抽屉根 | `[data-detail-drawer][data-identifier]` = 同一个完整 id（R8 起就有，**不改**） |

**裁定（唯一写法，勿改）**：`design/prototype/app.js:openDetail()` 里写 `[data-detail-identifier]` 的那一处，`.text(identifierText(data.identifier))` 改为 `.text(data.identifier)`；`.attr("title", data.identifier)` 一字不动。**`identifierText()` 函数保留**，它的两个剩余调用点（`renderList()` → B08；动态卡片 markup → B07）**一行不改**。

**为什么不能只改切片**：`identifierText` 停用后文本已是全串，但元素仍带 `.td-id`（`max-width: 9ch` + `overflow: hidden` + `text-overflow: ellipsis`）⇒ 超出 9ch 的 id 会被**宽度**裁掉并再次显示省略号 —— 「显示完整 id」在视觉上不成立。实测（§5 A3′）：18 字符样本在改前 `scrollWidth 128 > clientWidth 65`，改后 `128 = 128`。这是本轮**必须**同时给出去上限处置的原因。

**身份不走在文本里（R8 的规则继续成立）**：任何「按 id 解析」的代码读 `[data-detail-drawer]` 的 `data-identifier`，**不得**读本元素的 `textContent`。改后文本**恰好等于**完整 id 会让这条规则显得多余，但它是**契约**：文本是显示值，属性才是身份（R8 §2.3 原话，本卡不撤）。

### 2.2 项② `B09.drawer-head-uncapped` — 变体类 `.td-id-full`

**规则**（`design/prototype/src/input.css`，紧跟 `.td-id` 之后、**同一层**，保证同特异性下后者胜出）：

```css
.td-id-full {
  max-width: none;
  overflow: visible;
  text-overflow: clip;
}
```

**为什么是变体类而不是改 `.td-id` 本体**：`.td-id` 被 **B07 卡片**与 **B08 列表行**共用；改本体等于把上限一并解除 —— 与「B07/B08 保持不变」的需求直接冲突。变体类让「解除」只发生在带上它的那一个元素上，且**共存**写法（`.td-id` 管单行与基线，`.td-id-full` 只撤宽度）意味着两处规则各自只说自己负责的那件事。

**为什么去掉上限仍然不会破版**：id 是**无空格的单 token**，`.td-id` 的 `white-space: nowrap`（被继承）足以保证它不折行；`nowrap` + `ellipsis` 的**裁切**只在存在宽度上限时发生 —— 撤掉上限即「完整可见且不折行」。`display` 与 `vertical-align` 继续来自 `.td-id`。

**实现侧镜像（实读，未实测）**：

| 位点 | 现状 | 本轮契约要求 |
|---|---|---|
| `web/src/components/detail/DetailDrawer.vue`:`[data-detail-identifier]` | `class="td-mono td-id"`、`{{ identifierText(identifier) }}` | 追加 `td-id-full`、模板直接插值 `{{ identifier }}`（**去掉** `identifierText`） |
| `web/src/styles/app.css`:`td-id` | 与原型逐字相同的 6 条声明 | 紧随其后追加 `.td-id-full` 规则块（同上） |
| `web/src/lib/identifier.js` | `identifierText()` | **保留**（B07 `Card.vue` / B08 `ListView.vue` 继续用） |
| `web/src/components/board/Card.vue` · `web/src/components/board/ListView.vue` | 带 `td-id` | **不改**（反向断言 A4–A6 即它们的期望） |

### 2.3 边界（明写）

| # | 边界 | 理由 |
|---|---|---|
| 边界 1 | **只动 B09 头部那一个元素**。`.td-id` 本体、B07 的静态卡片 markup、B08 的 `renderList()` 投影**逐字不动** | 需求原话就限定在「详情抽屉」；卡片与列表是**密度**优先的扫描面，8 字符 + … 正是它们需要的（R8 的裁定） |
| 边界 2 | **不新增 `data-*` 钩子、不新增 i18n 键、不新增 token / 颜色 / 图标** | id 是数据不是文案；本轮是纯粹的「上限解除」（R-6 / R-7） |
| 边界 3 | `title` 与 `[data-detail-drawer][data-identifier]` **保持完整 id**；`[data-detail-id]`（`td_…` 内部 id）**不动** | 既有行为；本元素与身份解耦的规则不变 |
| 边界 4 | 抽屉头**不设最大宽度、不做折行**：长 id 一旦超过抽屉宽度就横向溢出（不换行、不省略） | id 是无空格单 token；换行会把一个不可分串拆成两行，比溢出更不可读。**本卡不含**「超长 id 在抽屉里如何收尾」的裁定（§8 未覆盖项 F1） |
| 边界 5 | `design/prototype/index-topbar-stacked.html`（`T-20261013-001301` 的顶栏试作变体）**不改** | 它是**另一张卡的冻结副本**（连 R11 的状态筛选都没进去），不是契约文档；它共享 `app.js` 后，其长 id（最长 9 字符 `PROJ-0007` ≤ `9ch` 上限）视觉**无回归**（§5 A3′ 的前置事实：9 字符在 65.02px 的框内） |
| 边界 6 | **不改** `web/**`、`test/**`、`src/**`、仓根 | 卡的红线：本卡只产契约与原型改动 |

### 2.4 B09 与 R8 的取代关系（逐条，不得含糊）

R8 §2.3（`design/fidelity-r8.md`，卡 `T-20261012-211516`）把上限写成**三处渲染点一致**的口径。R12 **只对其中一处**改口径，因此 R8 的条文**部分被取代**。该文档**保持原样**（它是本轮的**历史记录**，不是待改的当前口径）；取代关系以本表为准：

| R8 的条文（`design/fidelity-r8.md` §2.3 / §5） | R12 后 |
|---|---|
| 「唯一 selector（抽屉）」= `[data-detail-identifier]`，与另两处**同口径** | **被取代**：抽屉头是**例外**，不再受 8 字符上限 |
| `[data-detail-identifier]` 的 `textContent` = `full.slice(0,8) + "…"`（9 字符样本 `PROJ-000…`） | **被取代**：= **完整 id**（`PROJ-0007`） |
| 三处 `textContent.length <= 9` | **被取代**（抽屉一处）：长度 = id 长度，无上界 |
| 三处 `title` = 全 ID | **继续成立**（未改） |
| 「类集含 `.td-id`」 | **继续成立**（`.td-id-full` 是**追加**，不是替换） |
| 三处 `white-space: nowrap` | **继续成立**（抽屉头由 `.td-id` 继承） |
| `[data-detail-drawer][data-identifier]` = 全 ID；身份只从属性读 | **继续成立**（本卡的 2.1 末段重述） |
| B07 卡片 / B08 列表的**全部**条文 | **继续成立**（本卡未动，A4–A6 反向断言） |
| B10 深色弹窗（R8 项①） | **不受影响**（正交，§3） |

---

## 3. 与既有轮次的边界（正交声明，必须显式）

| 轮次 | 它的口径 | 本轮与它的关系 |
|---|---|---|
| **R8 ③（`B07/B08/B09.identifier-clamp`）** | 「8 字符 + …」+ `.td-id` 单行兜底 + 身份只走 `data-identifier` | **部分取代**（只对 B09 头部，逐条见 §2.4）；B07/B08 部分**原样成立**。函数与兜底类都保留 |
| **R8 ②（`B08.list-header`）** | 列表六列表头 | **正交**：本轮不碰表头、不碰 `renderList()` |
| **R8 ①（`B10.dark-separation`）** | 深色弹窗遮罩 / 边 / 影 | **正交** |
| **R11 ①（`B04.status-filter`）** | 状态多选筛选 | **正交**：`applyFilters()` / `renderList()` 一字未动 |
| **R11 ②（`B03 → B08.roster-route`）** | 名册名路由到 list + 预置状态 | **正交**：它经 `renderList()` 投影，行标识符仍走 `identifierText()`（A5 反向断言覆盖） |
| **R10 ②（`B09` 抽屉自动保存）** | `[data-detail-save]` 四态 | **正交**：同一个抽屉的**不同元素** |
| **R10 ①（`B05/B12.board-two-state`）** · **③（`B23` 编辑器填充）** | board 二态 / 拉伸链 | **正交** |
| **R9 ①②③（轻关闭 / label 控件 / list 二态）** | — | **正交**：本轮不碰任何 dropdown、不碰 list 状态机 |
| **`T-20261013-001301`（顶栏堆叠试作）** | `index-topbar-stacked.html` 的顶栏版式 | **正交 + 不镜像**（§2.3 边界 5） |

---

## 4. Full block list（含匹配项）

### 4.1 本轮条目

| # | 项 | 块 | 块内角色 | selector / hook | 期望 | 改前（原型实测） | 差异类型 |
|---|---|---|---|---|---|---|---|
| 1 | ① | B09 | 头部标识符文本 | `[data-detail-identifier]` 的 `textContent` | **=== 卡片完整 id**（无 `…`） | `PROJ-000…`（9 字符样本） | **口径**（R8 的截断口径 → 逐字） |
| 2 | ① | B09 | 渲染层 | `design/prototype/app.js:openDetail()` | 该路径**不再**调用 `identifierText()`；`.attr("title", …)` 不变 | 调用 `.text(identifierText(data.identifier))` | **口径** |
| 3 | ② | B09 | 变体类 | `[data-detail-identifier].td-id-full` | class 列表**含** `td-id-full`（**且仍含 `td-id`**） | 无该类 | **缺失口径**（本轮首次定义） |
| 4 | ② | B09 | 计算样式 | 同上 | `max-width: none` · `overflow: visible` · `text-overflow: clip` · `white-space: nowrap` | `65.0215px` / `hidden` / `ellipsis` / `nowrap` | **缺** |
| 5 | ② | B09 | 不裁切 | 同上 | `scrollWidth <= clientWidth + 1` | 9 字符样本即已成立；**18 字符样本不成立**（128 > 65） | **缺**（长度诊断 §5 A3′） |
| 6 | ①② | B09 | 身份解耦 | `[data-detail-drawer][data-identifier]` · `[data-detail-identifier][title]` | 两者 = **完整 id** | 同（既有） | **一致（回归门）** |
| 7 | ①② | B09 | 内部 id 不动 | `[data-detail-id]` | 文本 = `td_…`、**类集不含 `.td-id`** | 同 | **一致（回归门）** |
| 8 | — | B09 | 短 id 回归 | 6 字符卡（`TD-128`）打开抽屉 | 文本 = `TD-128`（无省略号、无 `…`） | 同 | **一致（回归门）** |
| 9 | — | B09 | 脚本关闭 | `[data-detail-identifier]` 静态种子 | 被绘制；含 `td-id-full`；文本 = 其 `title` | 种子在、无 `td-id-full`、`max-width 65.0215px` | **缺** |
| 10 | — | — | 页面溢流 | `documentElement.scrollWidth <= clientWidth + 1` | `true`（1512/1512） | `true` | **一致（回归门）** |

### 4.2 匹配项（本轮命中的既有块，逐个列明）

| 命中的块 | 命中处 | 本轮对它做什么 | 不做 |
|---|---|---|---|
| **B09 · Task detail drawer** | 头部的 `[data-detail-identifier]` 一个元素 + 它的渲染点 | 文本改逐字；class 追加 `.td-id-full`；`openDetail()` 去一处调用；`src/input.css` 加一条变体规则；`tw.css` 重建 | 不动头部其余元素（status chip / 关闭按钮）、不动属性区 / 正文区 / 评论 / 活动流、不动 `[data-detail-save]` 四态、不动抽屉的开合状态机与轻关闭 |
| **B07 · Card** | `[data-card-identifier]` | **无**（反向断言的锚） | 不动静态 markup 的省略文本、不动动态卡片渲染点的 `identifierText()`、不动 `.td-card-id` |
| **B08 · List view** | `[data-list-identifier]`（`renderList()` 投影） | **无**（反向断言的锚） | 不动 `renderList()`、不动行模板、不动六列表头 |
| **`.td-id`（R8 的兜底类）** | `design/prototype/src/input.css` | 只补一句注释（B09 例外指向 `.td-id-full`） | **不动它的任何一条声明**、不动它在另两处的用法 |
| **i18n hooks** | `MESSAGES` 两表 + `index.html` 的 `data-i18n*` | **零增量**（A9 逐字相等） | 不动任何键、不动任何钩子 |
| **Auxiliary hooks** | 辅助钩子表（`design/BLOCKS.md` §Auxiliary hooks） | **无新行**：`[data-detail-identifier]` 早已在表内 | 不动既有行 |

### 4.3 负向注记清单

| # | 注记 |
|---|---|
| 1 | 本轮**不**改任何 `web/**` 与 `test/**`（卡的红线：无实现代码）；实现侧改点只作「实读」记录（§2.2）。 |
| 2 | 本轮**不**引入新块、**不**新增 `data-*` 钩子；新增的**唯一**类选择器是 `.td-id-full`（A10）。 |
| 3 | 本轮**不**改 `.td-id` 本体的语义：它仍是「最多 8 字符 + …」在样式层的单行兜底，仍服务 B07/B08。 |
| 4 | 本轮**不**把上限解除做成「按 id 长度分支」的脚本判断（那会让显示口径漂移）；去上限是**纯 CSS**，与数据无关。 |
| 5 | 本轮**不**动 `identifierText()` 的实现与其两个调用点。 |
| 6 | 本轮**不**给抽屉头新增 `title` / `aria-label` / 复制按钮：`title` 既有且已是完整 id；「复制完整 id」是抽屉内部 id 行（`[data-detail-id-copy]`）已有的能力。 |
| 7 | 本轮**不**重拍截图集；`design/prototype/README.md` 的截图段已如实记录 R7–R11 的过期范围，R12 追加一条（§7）。 |
| 8 | 本轮**不**在 `design/prototype/**` 里新增 UI 文案的自由串（零 i18n 增量）。 |
| 9 | 本轮**不**改 `design/fidelity-r8.md`：它是历史契约，取代关系写在本文 §2.4（同一张卡的另一半口径未被撤）。 |

---

## 5. 机检断言清单（供实现卡「During」直接落测）

**禁行号锚**；每条 = 「selector → 断言 → 期望」，并给 **改前 / 改后**实测与**机检命令**。正反两组：**A1–A3 / A7 / A3′ 证「完整显示」**，**A4–A6 证「别处仍截断」**。

**落点（三类各一处，均属实现卡范围，本轮不改）**

| 类 | 落点 | 判据 |
|---|---|---|
| A · 结构 | `test/web/blocks.contract.mjs`（既有 rule kinds）+ `web/manifests/board-m2.json` 的 `blocks` | 节点计数 / 存在性 / 钩子集 / 属性枚举 / class 集 |
| B · 计算样式与几何 | `web/manifests/board-m2.json` 的 `style.targets`，由 `ui-align board-m2 --strict` 执行（R6/R8/R9/R10/R11 的 `rN-*` 行即在此） | `getComputedStyle` / `getBoundingClientRect` 的实测值 |
| C · 交互 | 驱动层（`web/scripts/dom-smoke.mjs` 或截图/探针脚本） | 真实事件驱动的状态变化 |

实现卡的 Acceptance 把 B 类绑在 **`ui-align board-m2 --strict` 0 失败**上，所以 B 类每一行都应成为 `board-m2.json` 里的一条 target（按既有 `rN-*` 惯例命名，例如 `r12-drawer-id-uncapped` / `r12-drawer-id-text`）。

### A. 结构类（`blocks.contract`）

| # | selector | 断言 | 期望 | 改前 | 改后 | 机检命令 |
|---|---|---|---|---|---|---|
| **A1** | `[data-detail-identifier]`（打开一张 **id > 8 字符**的卡：`[data-card][data-identifier="PROJ-0007"]`） | `textContent` | **=== 该卡完整 id**（`PROJ-0007`），**不含 `…`** | `PROJ-000…` | **`PROJ-0007`** | `node verify/r12-probe.mjs after` → `checks.drawerLong.head.text` |
| **A2** | 同上 | computed `max-width` / `text-overflow` / `white-space` | **`none` / `clip` / `nowrap`** | `65.0215px` / `ellipsis` / `nowrap` | **`none` / `clip` / `nowrap`** | 同上 → `checks.drawerLong.head.maxWidth` 等 |
| **A3** | 同上 | `scrollWidth <= clientWidth + 1` | `true` | `64 / 64`（**9 字符样本在 9ch 内，改前即成立**） | `64 / 64` | 同上 → `checks.drawerLong.head.scrollWidth/clientWidth` |
| **A3′** | 同上，**运行时把文本换成 18 字符样本** `TD-20261012-222353`（**长度诊断，不是已发货数据**） | `scrollWidth <= clientWidth + 1` | `true`（去上限在**Terry 报的长度**上成立） | **`false`**（128 > 65 ⇒ 被裁） | **`true`**（128 = 128） | 同上 → `checks.longLengthDiagnostic.clipped` |
| **A6** | `[data-detail-identifier]` 的 `classList` | 含 / 不含 | **含 `td-id-full`**（且**仍含 `td-id`**） | 不含 `td-id-full` | **含两者** | 同上 → `checks.drawerLong.head.classes` |
| **A7** | `[data-detail-identifier]`（**脚本关闭**） | 存在 + 被绘制 + 含 `td-id-full` + 文本 = `title` | 全成立（静态种子） | 种子在、**不含** `td-id-full` | **全成立** | 同上 → `checks.noJs.head` |
| **A8** | 页面 `console` / `pageerror` | 计数 | 两轮皆 **0** | 0 / 0 | **0 / 0** | 同上 → `consoleErrors` / `pageErrors` |

### A′. 反向断言（**别处仍截断** —— 与 A1–A6 同等强度，缺一不可）

| # | selector | 断言 | 期望 | 改前 | 改后 | 机检命令 |
|---|---|---|---|---|---|---|
| **A4** | `[data-card][data-identifier="PROJ-0007"] [data-card-identifier]`（B07） | `textContent` + computed 上限 + `text-overflow` | **`PROJ-000…`**（= `len>8 ? slice(0,8)+"…" : id`）；`max-width` = **有限 px**（实测 **59.603px**）；`text-overflow: ellipsis` | 同 | **同一值（逐字不变）** | `node verify/r12-probe.mjs after` → `checks.cards.long` |
| **A5** | `[data-list-rows] [data-list-row][data-identifier="PROJ-0007"] [data-list-identifier]`（B08） | 同上 | **`PROJ-000…`**；`max-width` = **有限 px**（实测 **65.0215px**）；`ellipsis` | 同 | **同一值（逐字不变）** | 同上 → `checks.list.long` |
| **A6′** | `[data-card-identifier].td-id-full` / `[data-list-identifier].td-id-full` 计数 | 计数 | **0 / 0**（变体类**不得**外溢） | 0 / 0 | **0 / 0** | 同上 → `checks.cards.withFullClass` / `checks.list.withFullClass` |
| **A6″** | 短 id 回归：`[data-card][data-identifier="TD-128"]` 打开的抽屉 | `textContent` | `TD-128`（**无省略号**） | `TD-128` | **`TD-128`** | 同上 → `checks.drawerShort.head.text` |
| **A4′** | `[data-detail-drawer][data-identifier]` 与 `[data-detail-identifier][title]` | 值 | **=== 完整 id**（身份只走属性） | `PROJ-0007` | **`PROJ-0007`** | 同上 → `checks.drawerLong.rootIdentifier/title` |
| **A7′** | `[data-detail-id]`（`td_…`） | 文本 + 类集 | 文本 = `td_…`；类集**不含** `td-id` / `td-id-full` | 同 | **同** | 同上 → `checks.drawerLong.internalId` |

### B. 计算样式 / 几何类（`dom-smoke` / `ui-align`）

| # | selector | 断言 | 期望 | 改前 | 改后 |
|---|---|---|---|---|---|
| B-1 | `[data-detail-identifier]` | `max-width` / `overflow` / `text-overflow` | `none` / `visible` / `clip` | `65.0215px` / `hidden` / `ellipsis` | **同左** |
| B-2 | 同上 | `white-space` / `display` / `vertical-align` | `nowrap` / `block`（flex 子项被 blockify）/ `bottom` | 同 | **同左（未改）** |
| B-3 | 同上 | `font-size` / `font-family` | `12px` / `"JetBrains Mono", …` | 同 | **同左** |
| B-4 | `[data-card-identifier]`（11px） | `max-width` | **有限 px**（实测 `59.603px`） | 同 | **同左（反向门）** |
| B-5 | `[data-list-identifier]`（12px） | `max-width` | **有限 px**（实测 `65.0215px`） | 同 | **同左（反向门）** |
| B-6 | 页面（1512 / 1240 / 980 / 760 / 500 各开一档） | `documentElement.scrollWidth <= clientWidth + 1` | 五档全 `true` | `true` | **`true`（实测 1512/1512 · 1240/1240 · 980/980 · 760/760 · 500/500）** |
| B-7 | `[data-detail-identifier]`，五档 × 18 字符样本（F1 诊断） | 宽度 + 是否留在抽屉内 + 页面是否溢流 | 五档皆**完整且不溢出** | 五档皆 **`65.02px`**（被上限压住）、`fitsDrawer` `true` | **五档皆 `127.89px`、`fitsDrawer` `true`、页面 `false`** |

### C. 交互类（驱动层：真实点击 / 真实文本换入）

| # | 场景 | 断言 | 期望 | 改前 | 改后 |
|---|---|---|---|---|---|
| C-1 | 按下 `[data-card][data-identifier="PROJ-0007"]`（真实点击卡片） | 抽屉 `data-state="open"`；头部文本 / `title` / 根 `data-identifier` | `open`；三者 = `PROJ-0007` | `open`；文本 `PROJ-000…` | **`open`；三者 `PROJ-0007`** |
| C-2 | 关上，再按 `[data-card][data-identifier="TD-128"]` | 头部文本 | `TD-128`（短 id 不回归） | `TD-128` | **`TD-128`** |
| C-3 | 切 `[data-view="list"]` 后 | `[data-list-identifier]` 的文本 / 上限 | 仍 `8 + …`、上限仍在 | 同 | **同（反向门）** |
| C-4 | 在打开的抽屉里把 `[data-detail-identifier]` 的文本换成 18 字符样本 | `scrollWidth` vs `clientWidth` | **不裁** | **裁**（128 > 65） | **不裁**（128 = 128） |

### C′. 「不得断言」的负向注记

| # | 不得断言 | 原因 |
|---|---|---|
| C′1 | 断言 computed `max-width === "9ch"` | `9ch` 是**宽度**，computed 值恒为 px（卡片 59.603px / 12px 面 65.0215px）。上限的判据是「有限 px 值」，解除的判据是字面 `none`（§1 规则 4）。 |
| C′2 | 断言 `[data-detail-identifier]` 的 `display === "inline-block"` | 实测 `block`：它是 flex 行的子项，`inline-block` 被 blockify。断言声明值会锁死一个**没有发生**的事实。 |
| C′3 | 断言抽屉头有**最大宽度**或**折行** | 边界 4：去上限后长 id 横向溢出是**有意**的；换行会把不可分串拆成两行。溢出如何收尾不在本轮（§8 F1）。 |
| C′4 | 用 `.td-id-full` **是否存在**代替 A1 | 类只是**机制**；需求是**文本完整可见**（A1/A2/A3/A3′）。只断言类会让一个「类在、但 `identifierText` 仍被调用」的实现通过。 |
| C′5 | 断言 `[data-detail-identifier]` 的文本**不等于** id 长度 ≤ 9 | 它恰好等于完整 id —— 长度无上界（§2.4）。 |
| C′6 | 断言 `title` / `data-identifier` 也跟着变 | 它们**本来就**是完整 id（A4′ 的「不变」是回归门，不是新行为）。 |
| C′7 | 断言抽屉头**滚动**（`overflow: auto`）来容纳长 id | `overflow: visible` 是裁定（B-1）；改成滚动容器会把「完整可见」降级为「可滚动」。 |

---

## 6. 证据与复跑

**探针**：`workspace/T-20261013-023310/verify/r12-probe.mjs`（Playwright / Chromium headless；主档 1512×950，另跑 1512 / 1240 / 980 / 760 / 500 五档宽度扫描；`file://` 打开原型；收集 `console` / `pageerror`；含一次 `javaScriptEnabled: false` 的上下文；A3′、B-7 与 C-4 用**运行时文本换入**做长度诊断，断言只在换入后的瞬时状态上取，取完即还原）。

**原始记录**：`verify/probe-before.json` · `verify/probe-after.json` · `verify/static-checks.json`（**均不进仓**）。

**「改前」是怎么测到的（可复核）**：`verify/pristine/`（`index.html` + `app.js` + `tw.css` + `package.json` + `favicon.svg`，逐字取自 `git show 2eb6a9e:design/prototype/*`；`vendor/` 与 `src/` 原样拷贝）由 `verify/make-pristine.mjs` 生成；探针以该副本的 `index.html` 为入参实测。因此「改前」一栏是**同一探针对同一原型的旧版重跑**，不是推断、也不是从 diff 反读。

**复跑命令（逐条，可直接粘）**：

```sh
W=/Users/tanyu/.openclaw/team/workspace/T-20261013-023310/verify
node "$W/make-pristine.mjs"          # 生成基线版副本（默认锚定 2eb6a9e；改前一列的证据）
node "$W/r12-probe.mjs" before       # 改前：A1–A8 逐条打 PASS/FAIL
node "$W/r12-probe.mjs" after        # 改后：同上
node "$W/build-tw.mjs"               # 按 README §Build 重建 tw.css（含字节数与类 token 计数）
node "$W/static-checks.mjs"          # A9（i18n 零增量） + A10（tw.css 恰一个新增类）
```

**基线锚定（可复核性）**：本卡提交后 `HEAD` 就是本轮 commit，所以 `make-pristine.mjs` 与 `static-checks.mjs` 都**显式接受并默认使用基线 sha `2eb6a9e`**（而不是 `HEAD`）。在 `dc8f5ad` 上原样复跑仍得到同一组 before / after 数字。

**A9（i18n 零增量，静态）实测**：`index.html` 的 `data-i18n*` 座位 **622 → 622**（`data-i18n` 404、`-placeholder` 8、`-aria-label` 48、`-title` 18、`-arg` 144，**分部逐个相等**）；`app.js` 的 `MESSAGES` 键 **en 224 / zh 224 → 224 / 224**。（与 R11 §1 表的 622 / 224 起点一致，说明 R11 之后没有第三方改动这两个数。）

**A10（tw.css 重建）实测**：`193283 → 193372` bytes（**+89**）；`.class` token `344 → 345`，**added = `{td-id-full}` / removed = `{}`**；逐行 diff **只有 5 行新增**（即 `.td-id-full` 规则块）。R10 记下的「注释裸词被扫描器误产类」本轮**未触发**（R12 的注释用词已避开 `stack` 一类的组件名，构建后逐 token diff 为证）。

**硬门（两轮皆通过）**：`console` = **0**、`pageerror` = **0**。

**实现侧证据口径**：本契约对实现侧的断言一律标「实读」，**未**构建 `web/dist` 实测；实现卡的「During」应把 §5 的 A/A′/B/C 四类落成真正的机检（`test/web/blocks.contract.mjs` · `web/manifests/board-m2.json` + `ui-align board-m2 --strict` · 驱动层），验证卡独立复跑同一张表。

---

## 7. 文档同步判定（§⑫）

| 文档 | 本轮同步点 | 状态 |
|---|---|---|
| `design/fidelity-r12.md` | 本文件：口径 + 组件/选择器 + 边界 + **逐条机检断言（含反向断言）** | **新增** |
| `design/BLOCKS.md` | **B09**：R8 段改写为「头部标识符 = 逐字完整 id + `.td-id-full` 去上限」（身份解耦与 `[data-detail-id]` 两条保留）；**B07 / B08** 各补一句交叉引用（「R12 只动 B09，本处维持 R8 上限」）；**头部 hooks 表**里 `[data-detail-identifier]` 的表述随 B09 段更新 | **已改** |
| `design/DESIGN.md` | **新增 §28「Review round R12 — the drawer's identifier shows the whole id」**：28.1 两处实现（切片 + 宽度）与为什么必须都动、28.2 变体类与边界、28.3 被否决备选表、28.4 实测 | **已改** |
| `design/prototype/index.html` | 抽屉头 `[data-detail-identifier]` 追加 `td-id-full` + 一段 R12 注释 | **已改** |
| `design/prototype/app.js` | `openDetail()` 去掉该路径的 `identifierText()` 调用 + 注释；`identifierText()` 的函数注释补一句 B09 例外 | **已改** |
| `design/prototype/src/input.css` | `.td-id` 注释补 B09 例外；其后新增 `.td-id-full` 规则块 | **已改** |
| `design/prototype/tw.css` | 按 README §Build 重建（+89 bytes，新增类选择器恰 1 个） | **已重建** |
| `design/prototype/README.md` | I-map **表后新增 R12 规则段**（不新增 I 行：本轮无新交互，抽屉头是既有 I3 的显示口径）；Coverage 表新增「Drawer identifier」一行；**Build 段的 `tw.css` 字节数**（`193283 → 193372`）；**截图段追加 R12 声明**（三张抽屉帧逐张检视：`TD-131` / `TD-122` / `TD-131`，皆 6 字符 ⇒ 帧面无可见变化） | **已改** |
| `design/fidelity-r8.md` | **不改**：它是历史契约，取代关系写在 `fidelity-r12.md` §2.4（同一张卡的另一半口径未被撤） | **不改（有意 + 已记）** |
| `design/fidelity-r9.md` / `-r10.md` / `-r11.md` | **不改**：本轮与它们正交（§3） | **不改（有意）** |
| `web/**` · `src/**` · `test/**` | **不改**（卡的红线：无实现代码）；实现侧改点只作「实读」记录（§2.2） | **不改（红线）** |
| **i18n 归属（显式判定）** | 本轮**零 i18n 增量**：id 是**数据**不是文案；`MESSAGES` 键与 `data-i18n*` 钩子数前后**逐一相等**（A9） | **已判定（零增量）** |

---

## 8. 口径红线与未覆盖项

**红线（后续卡片必须遵守）**

| # | 红线 |
|---|---|
| R1 | **只有 B09 的头部标识符**逐字显示完整 id；**不得**把去上限外溢到 B07 卡片或 B08 列表行（反向断言 A4–A6 冻结）。 |
| R2 | 去上限**必须**由类名写死的 **`.td-id-full`** 表达（`max-width: none; overflow: visible; text-overflow: clip`），与 `.td-id` **并存**；**不得**改 `.td-id` 本体，**不得**新增第二个变体类或按长度分支的脚本判断。 |
| R3 | `identifierText()` **保留**，且**只**服务 B07/B08 两条路径；**不得**在抽屉头重新引入它，也**不得**为抽屉另写一个切片函数。 |
| R4 | `title` 与 `[data-detail-drawer][data-identifier]` **恒为完整 id**；身份解析**只**读属性，**不得**读 `[data-detail-identifier]` 的文本（即便改后文本恰好是完整 id）。 |
| R5 | 抽屉头**不设最大宽度、不折行、不滚动**（`nowrap` + `overflow: visible`）；长 id 横向溢出是**有意**的（边界 4）。 |
| R6 | 零 i18n 增量：**不得**为「完整 id」新增任何键或钩子（id 是数据）；零新 token / 颜色 / 图标。 |
| R7 | 实现侧落这条口径时**必须**改 `web/src/styles/app.css` 的 `.td-id-full` 与 `web/src/components/detail/DetailDrawer.vue` 的模板；`web/src/lib/identifier.js` 与 `Card.vue` / `ListView.vue` **不得**改（反向门）。 |
| R8 | `design/fidelity-r8.md` **保持原样**；凡与之冲突的条文，以本文件 §2.4 的取代表为准，**不得**回改 R8 文档。 |

**未覆盖项（明确不在本轮，留给后续裁定）**

| # | 项 | 说明 |
|---|---|---|
| F1 | **超长 id 在抽屉头的收尾** | 去上限后，一个远超抽屉宽度的 id 会横向溢出。**已测**（B-7，五档 × 18 字符样本）：`127.89px` 在 1512 / 1240 / 980 / 760 / 500 **五档都仍在抽屉内**、页面无溢流 —— 即 Terry 报的长度**当前无需收尾**。但**更长的 id**（抽屉宽度的量级，或更窄的视口 / 更长的语言环境）会溢出，要不要截断退让（仍回到 8+…）、缩字号、或允许折行，本轮**未裁定**（边界 4）。 |
| F2 | **卡片 / 列表的复制路径** | 卡片与列表仍显 8+…，复制完整 id 目前只能进抽屉（内部 id 行有 `[data-detail-id-copy]`；**任务标识符本身没有复制钮**）。要不要给卡片加「复制完整 id」，是另一需求。 |
| F3 | **实现侧两份镜像的同步** | `web/src/lib/identifier.js` 的注释仍写着「三处渲染点」口径；实现卡改 `DetailDrawer.vue` 时该注释**应**同批更新（本轮 `test/**` 与 `web/**` 都是红线，只登记）。 |
| F4 | **`index-topbar-stacked.html` 的镜像** | 边界 5：该试作变体不镜像本卡（沿用 R11 的先例）。若它要被扶正为契约文档，需另开卡。 |
| F5 | **截图集重拍** | 见 §4.3 注记 7 / `design/prototype/README.md` 截图段 —— 抽屉头已连续多轮未重拍。 |
