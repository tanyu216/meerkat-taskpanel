# 侧栏项目短码（`.td-side-icon`）口径契约 · C-RAIL-1

> 侧栏 rail 的项目短码**唯一口径 = 该项目的有效前缀**（与卡号前缀**同值同源**）；实现侧的 `initialsOf(name)`（名字首字母）是**偏离**，实现改动另开卡。

> 卡：`T-20261014-011936-4`（goal：裁定侧栏项目短码口径——原型=前缀 `TD`/`ORC`/`SR` vs 实现=`initialsOf(name)`——定唯一口径并落设计源）。
> **裁定来源**：`design/contracts/project-prefix-binding.md`（C-PREFIX-1）**§8 E4** 的未决项——该节写明「**建议单开一张卡**裁定『蒙版 = 前缀 还是 名字首字母』」，本卡即该卡；且 **§7.4** 的 wire 条款是**以本裁定为条件**的条件条款。
> 分工：**本卡 = 设计裁定 + 设计源更新（写面 `design/**`，零实现）**；C-PREFIX-1 的实现卡是 `T-20261014-011936`（Linus，写面 `src/**` + `CreateProjectModal.vue`），**本契约不改它一行、也不改原型一行**。
> 事实源：原型 = `design/prototype/index.html`、`design/prototype/app.js`、`design/prototype/src/input.css`、`design/BLOCKS.md`（**实读**，符号级；本 lane **未**驱动浏览器）；实现 = `web/src/lib/monogram.js`、`web/src/components/shell/Sidebar.vue`、`test/web/monogram.test.mjs`、`src/shared/wire.mjs`、`src/server/routes/projects.mjs`、`src/shared/ids.mjs`（**实读**）；`initialsOf` / `identifierPrefix` 取值 = **实测**（纯函数 Node 直跑，原始输出见 §9）。
> 基线 commit：`61f7f3a`（= 本 lane 的开工点，= `main`，= 分支 `lane/T-20261014-011936-4-seg1`）。
> **本文件为新增文件**：未改动 `design/prototype/**` 一行；`design/BLOCKS.md` §B03 仅补一段口径指针（§10 F 段）。

## 0. 结论摘要

- **① 裁定 = 前缀。** 侧栏项目短码 = 该项目的**有效前缀**，即 C-PREFIX-1 **M3** 定义的那个值：**项目存储的前缀（非空），否则 `identifierPrefix(项目 id)`**。同一个值同时是该项目所有卡号的数字前缀 ⇒ 板上看到的 `TD-0001` 与 rail 里看到的 `TD` 是**同一个属性**，不是两次推导。
- **② 本裁定与原型 oracle 同向，且与设计源书面表述同向。** 原型三行的短码 `ORC`/`TD`/`SR` 逐字等于 `design/prototype/app.js` `PROJECT_PREFIX` 的三条值（§2 R1/R2）；原型 CSS 两处注释**逐字**写着「project prefix monogram」（§2 R3/R4）；`design/BLOCKS.md §B03` 的 Projects 行**逐字**写着「prefix monogram, rail only」（§2 R5）。⇒ **要改的是实现，不是原型**，因此**不触发**卡面 ② 的「与原型矛盾 ⇒ 按 §⑨.1 交 Elon 裁定」分支；Elon/operator 的双签（卡面 ③）照常走。
- **③ 与 C-PREFIX-1 的关系：闭合 §8 E4，并激活 §7.4 的条件条款。** 本裁定使「E4 裁定为前缀」成立 ⇒ `src/shared/wire.mjs` 的 `projectToWire` 需回传一个**只读的 `prefix`**（= 有效前缀），并同步刷新契约快照。**本契约把该字段的语义钉死为「有效前缀」**（服务端派生），**不是** `meta.prefix` 原样——理由见 §4。
- **④ 一处分叉事实的更正（实测）。** 卡面与 C-PREFIX-1 §8 E4 把实现侧的短码写作 `MT`；`MT` 是 `initialsOf("Meerkat Task Panel")`（**带空格**）的值。原型与实现的种子名都是**无空格**的 `MeerkatTaskPanel`（`design/prototype/index.html`；`web/scripts/dom-smoke.mjs`），实测 `initialsOf("MeerkatTaskPanel")` = **`MEE`**。⇒ **分叉的存在**不变（结论不受影响），**分叉的字面值**为 `TD` vs **`MEE`**（§2 R9、§9 A 段）。
- **⑤ 一处必须先说的实现陷阱（实测）。** 「有效前缀」若照朴素写法 `identifierPrefix(meta.prefix) || identifierPrefix(id)` 求，`meta.prefix` 缺席时会得到字符串 **`"UNDEFINED"`**（`identifierPrefix` 第一步是 `String(...)`，而 `String(undefined) === "undefined"`）——一个**真值**，于是回退分支**永不执行**，短码渲染成 `UNDEFINED`。必须显式判「确有字符串」再归一化（§5、§9 C 段）。
- **⑥ 两处未决交 Elon**：U1 原型自身的**遗漏**（新建项目行不带短码，§2 R6）在本裁定下如何落地；U2 **长前缀**的 chip 宽度（存量项目的有效前缀可达 36 字符，实测，§9 A 段）——原型无 in-oracle 证据。
- **⑦ 本卡零实现、零原型改动、零 i18n 键**：改动面 = 本文件 + `design/README.md` 一行 + `design/BLOCKS.md §B03` 一段（§10 F 段）。

---

## 1. 口径与证据规则

**闭集词表（逐字使用，不得自创）**：`对齐` = 两侧**实测**同值；`一致` = 两侧书面/符号级同义（未实测）；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本文件不出现任何「文件 + 数字行号」形式的引用）。

**证据分级（每条结论必须能归入其中一级）**：

1. **实测**——真跑出来的：本轮 `initialsOf` / `identifierPrefix` 取值、有效前缀公式的取值与幂等复核（纯函数，Node 直跑，原始输出见 §9）。
2. **实读**——逐符号读过源码/原型/设计文档，未运行。
3. **实读未实测**——实现侧的**运行行为**本轮一律属此级：本 lane **未**构建 `web/dist`、未起 `taskd`、未驱动浏览器、未进容器。
4. **不伪造**：未跑的写「未跑」；原型侧未驱动浏览器者，不写「实测」。

---

## 2. 原型（oracle）证据——短码「就是」前缀

以下全部为**实读**（符号级），未跑浏览器：

| # | 位置 | 事实 |
|---|---|---|
| **R1** | `design/prototype/index.html`:`[data-project-list]` 三行 | 每行的 `.td-side-icon` 文本 = `ORC` / `TD` / `SR`；同一行的 `.td-side-name` 文本 = `Orchestrator` / `MeerkatTaskPanel` / `Site Refresh`。⇒ **短码与名字是两个独立字符串**。 |
| **R2** | `design/prototype/app.js`:`PROJECT_PREFIX` 字面量 | `{ MeerkatTaskPanel: "TD", Orchestrator: "ORC", "Site Refresh": "SR" }`——**键 = 项目名，值 = 编号前缀**，与 R1 的三行**逐字对应**。种子本身即判据：`MeerkatTaskPanel` 的前缀是 `TD`，不是名字的任何缩写。 |
| **R3** | `design/prototype/src/input.css`:`.td-side-icon`（基态） | 规则上方的注释**逐字**：「project prefix monogram — hidden unless the sidebar is an icon rail」；基态 `display: none`。 |
| **R4** | `design/prototype/src/input.css`（≤1023px 档的 `.td-side-icon`） | 注释**逐字**：「the project rows keep their identity through the prefix monogram」；该档 chip 几何 = 24×24、`border-radius: var(--r-sm)`、`border: 1px`、选中行换 accent 面。 |
| **R5** | `design/BLOCKS.md` §B03 Projects 行 | `.td-side-icon`（**prefix monogram**, rail only）——**设计源书面已定**，且这是**实现侧自己引用过的那句**（`web/src/components/shell/Sidebar.vue` 的注释逐字引它，见 R9）。 |
| **R6** | `design/prototype/app.js`:`[data-create-project-form]` 的 `submit` 处理器 | 成功路径只向 `[data-project-list]` **追加**一个 `button.td-side-item`，内含 `.td-side-name` + `[data-project-count]`——**不含 `.td-side-icon`**。⇒ 原型**自己没把「建项目 → 短码」接完**；这是一处**遗漏**（原型有该钩子的三行都是静态种子），不是「短码 = 名字首字母」的证据（该行**两个 span 都没有**）。 |
| **R7** | `design/prototype/app.js`:`setProject` | 只切 `aria-current`（`[data-project-list] [data-project]` 与 `[data-project-option]` 两处），**不建行**。⇒ R6 追加的那行是侧栏 rail 里唯一的新增行。 |
| **R8** | `design/prototype/app.js`:`nextIdentifier` | `var prefix = PROJECT_PREFIX[project] \|\| "TD";`——**编号侧**的兜底。实现在此处已由 C-PREFIX-1 **M3** 改为回退 `identifierPrefix(id)`（原型该兜底值 `"TD"` 是 demo 文案，见 §5）。 |
| **R9** | `web/src/lib/monogram.js`:`initialsOf`；`web/src/components/shell/Sidebar.vue`:`[data-project] [data-side-icon]` | 实现把 `.td-side-icon` 的文本渲染为 `initialsOf(project.name)`（名字压缩成 ≤3 个大写）。**实测**：`initialsOf("Orchestrator")` = `ORC`、`initialsOf("Site Refresh")` = `SR`、`initialsOf("MeerkatTaskPanel")` = **`MEE`**（§9 A 段）。⇒ 三个种子里两个**巧合重合**，只有 `MeerkatTaskPanel` 分叉：原型 `TD` vs 实现 `MEE`。**同一处代码的注释逐字引用了 R5 的「prefix monogram」**，即实现**自己知道**该渲染前缀——偏离是**代码与注释不一致**，不是设计口径不明。 |

**原型立场，一句话**：项目的**短码 = 该项目的编号前缀**（同一个属性、同一个值），且它在 rail 档承担该项目的**身份标识**（R3/R4 两处注释明说）。

**两点必须点名的原型细节**（下游别踩）：

1. **巧合重合不构成证据**。R1 三行里 `Orchestrator`→`ORC`、`Site Refresh`→`SR` 与「名字首字母」同值——**只有一个判据行**（`MeerkatTaskPanel`：`TD` vs `MEE`）。任何把三行当「两个口径差不多」的读法都是错的；种子被刻意选成名字无法推出前缀（R2）。
2. **短码是装饰性的**（`aria-hidden="true"`，两侧一致），所以它**必须是别处已有信息的重复**：`prefix` 已经写在该项目的每一张卡上（`[data-card-identifier]` 的 `PREFIX-NNNN`）。名字派生的短码同样是重复，但重复的是**另一个**属性；这正是本裁定要收掉的「两个属性、一个短码」。

---

## 3. 裁定

### 3.1 主裁定（唯一口径 = 项目的有效前缀）

> **侧栏 `[data-project] [data-side-icon]` 的文本 = 该项目的「有效前缀」，逐字渲染，不做任何二次加工。**
>
> **有效前缀**（沿用 C-PREFIX-1 **M3** 的定义，不另立一份）：项目的**存储前缀**（非空）**否则** `identifierPrefix(项目 id)`。

数据流（`+` = 本轮新增的口径，其余为既有设施或 C-PREFIX-1 已定的设施）：

```
项目（存储前缀 = identifierPrefix(meta.prefix)，C-PREFIX-1 M2）
   │
   ├─▶ repositories.projects.allocateIdentifier ──▶ 卡号 = PREFIX-NNNN        （C-PREFIX-1 M3，已定）
   │
   └─▶ 有效前缀 = 存储前缀（非空）否则 identifierPrefix(project.id)          （C-PREFIX-1 M3，已定）
              │  + 服务端把它投影到 wire 的只读字段 `prefix`（§4）
              ▼
        GET /api/v1/projects → projects[].prefix
              │  + 客户端逐字渲染，不做推导
              ▼
        .td-side-icon 文本 = prefix                                            （本契约）
```

**五条「必须」**：

- **M1｜短码的值 = 有效前缀，不是别的。** 具体地，**不是** `meta.prefix` 的**原文**（未规范化）、**不是**项目名或其缩写、**不是** id 原样。`meta.prefix` 只在**服务端**经 `identifierPrefix` 规范化一次（C-PREFIX-1 M2），该规范化后的值才是短码的来源。
- **M2｜服务端派生一次，客户端零推导。** 短码在客户端**必须**是「读到的字符串原样渲染」。UI 里**不得**出现 `.toUpperCase()`、**不得**出现折叠非字母数字的正则、**不得**调用任何「前缀函数」——与 C-PREFIX-1 §4 拒绝「UI 再归一化一次」是**同一条规则**（那里拒绝的是第二份归一化规则，这里拒绝的是第二份**派生**规则）。落点见 §6。
- **M3｜值缺失 ⇒ 渲染空，不得回退名字派生。** 若一个项目**无法铸号**（有效前缀为 `""`），短码渲染**空字符串**——`<span data-side-icon>` **仍在**（钩子不动，rail 的 chip 规则照常生效），只是文本为空。**明令禁止**在此分支回退 `initialsOf`：那会把「两个口径」重新引回来，且只在**最不可能被测到**的项目上出现（§7 U2 的同类项目）。当前实现的 `initialsOf("")` = `""` 已经是这个行为（§9 A 段），所以这条**不改变**空值时的观感。
- **M4｜逐字渲染，不截断。** 短码**不做**省略、**不做** `…`、**不做**首字母压缩。理由是 M5 的**可见唯一性**：截断会把两个不同项目缩成同一个 chip（`ORCHESTRATOR` 与 `ORCHESTRA-2` 同首字母），而「两个项目在板上无可区分」正是 C-PREFIX-1 M5 要禁止的事。长度后果与未决项见 §7 **U2**。
- **M5｜短码继承前缀的不可变与唯一——C-PREFIX-1 M5/M6 的第二个消费面。** 短码随前缀**创建后不可变**（M6：项目改名不改短码、PATCH 不得改前缀）；两个项目**有效前缀**相同者在板上**已经**不可区分（M5）——现在这一点**用户可见**（rail 里两个 chip 一模一样），所以 M5 不再是纯铸号层的约束。本裁定**不放宽、也不加严** M5/M6，只登记「它多了一个可见消费面」。

### 3.2 备选与拒绝理由

| 候选 | 判定 | 理由 |
|---|---|---|
| **(A) 短码 = 有效前缀**（**采定**） | ✅ | ① **原型 oracle 逐字如此**（R1/R2），且设计源书面（R3/R4/R5）**早已如此**——本裁定不改设计口径，只把它落到实现；② 与卡号前缀**同值同源**：一个属性、两处显示，用户学一次映射（rail 的 `TD` ↔ 卡号 `TD-0001`）；③ 前缀是**服务端持有**、**已验证唯一**（M5）、**创建后不可变**（M6）的字段——短码因此免费获得这三条保证；④ 与 R4「rail 档承担项目身份」的意图一致。 |
| **(B) 短码 = `initialsOf(name)`**（现状） | ❌ | ① **与原型反向**（R1/R2/R3/R4/R5 五处）；② 与卡号前缀是**两个值**，且名字派生的值**无法**从卡号反推；③ **重命名即漂移**——名字可改而前缀不可改（M6），短码会跟着名字变，rail 的身份标识随一次改名而变；④ **无唯一性**：`Site Refresh` 与 `Site Rework` 同为 `SR`，且没有任何机制禁止（M5 只管前缀）；⑤ 采用它意味着**改设计源**（把 `BLOCKS.md` §B03、原型 CSS 两处注释与 `PROJECT_PREFIX` 种子一起改写）——即**以实现反推原型**，§⑨.1 与 §⑨.1 Addendum II「复现，不改写」都禁止。 |
| **(C) 两个都显示**（前缀 + 名字首字母） | ❌ | 原型无此形态（`.td-side-icon` 只有一个文本节点，R1），是**自创结构**（§⑨.1 反模式）；且 24×24 的 chip（R4）装不下两段文本。 |
| **(D) 客户端读 `meta.prefix` 自己兜底** | ❌ | `meta` 今天**已经**在 wire 上（§4），看似零成本，但：① 客户端**算不出** legacy 项目的有效前缀（`identifierPrefix(id)`；`web/src` 与 `src/shared` 之间无 import，C-PREFIX-1 §4 实测）⇒ 存量项目「rail 空、卡号有前缀」，正是 M3 要保护的群体；② 让一个**保留键**（服务端所有）变成 UI 读点，等于把身份寄居在自由 meta 里再**公开**它。⇒ 见 §4 对 wire 的要求。 |

> **说明（如实登记，不藏）**：采纳 (A) 的**代价**是**一次 wire 字段 + 一次契约快照刷新**（§4），而 (B) 的初值代价是**零**（`name` 已在 wire 上）。本条不对称是**真实的**，本裁定**选择付这个代价**，理由如上表 ①②③④——其中 ④（不反推原型）是**硬约束**，不是权衡项。

---

## 4. 与 C-PREFIX-1 的关系（闭合 E4、激活 §7.4）

**E4 的闭合**：C-PREFIX-1 §8 把「侧栏短码 = 前缀 还是 名字首字母」列为**正交于绑定裁定的未决项**，并写明「**建议单开一张卡**裁定」。本卡即该卡，本文件即裁定。⇒ E4 状态：**已裁定 = 前缀**。

**§7.4 的激活**：C-PREFIX-1 §7.4 对 `prefix` 上 wire 的写法是**条件条款**——「只在侧栏短码裁定为『前缀』（§8 E4）之后才需要；届时 `src/shared/wire.mjs` 加 `prefix` 字段，并**必须**同步刷新契约快照与 shape_check 的消费面」。本裁定使该条件**成立**，因此：

- **R-W1｜`projectToWire` 增一个只读字段 `prefix`。** 字段名 = `prefix`（沿用 §7.4 的措辞）；**语义 = 有效前缀**（§3.1 的定义），**不是** `meta.prefix` 原样。理由：legacy/CLI 项目的有效前缀是**服务端派生值**，客户端复现不了（§3.2 (D) ①）；且「一份推导在服务端」是 C-PREFIX-1 的既定原则（§4）。
- **R-W2｜该字段只读。** `PATCH /api/v1/projects/:id` 的声明请求体**不含** `prefix`（**实测**：`declared [labels, meta, name, readme]`，C-PREFIX-1 §10 D 段；本轮未复跑）。⚠️ 但 `meta` 是**合并**语义（`{...current.meta, ...body.meta}`，`src/server/routes/projects.mjs`），所以若前缀存回 `meta.prefix`（§7.2 方案 (i)），**M6 的「PATCH 不改 `meta.prefix`」守卫仍是必需的**——本裁定不改变这一点，只登记：少掉 M6，读路径（`prefix`）与写路径（`meta.prefix`）会**静默脱钩**，rail 与卡号从那一刻起互相矛盾。
- **R-W3｜快照与消费面必须同步。** 增一个 wire 字段会改变契约快照（`scripts/verify/contract.mjs` 逐字段记名与类型；快照落在 `test/fixtures/contract/api.snapshot.json`）⇒ 实现卡必须跑 `node scripts/verify/contract.mjs --update` 并确认消费面，否则 `contract-gate` 红。

**一处对 §7.4 成本描述的更正（实读）**：`projectToWire` **已经**投影整个 `meta`（`src/shared/wire.mjs`），且 `GET /api/v1/projects` 的每一条都走它（`src/server/routes/projects.mjs` 的 `ranked.map((item) => projectToWire(item.entry))`）。⇒ 若实现选 §7.2 的 **(i)**（前缀存回 `meta.prefix`），**客户端今天就读得到该值**、**零 wire/快照变更**。本裁定**仍然**要求顶层只读 `prefix`，理由只在上面的 R-W1（legacy 派生值 + 单一推导点）；即：**这笔快照成本是买「存量项目的短码不为空」的，不是买「UI 能读到前缀」的**。

**不变项（明写，避免下游误读）**：C-PREFIX-1 的 **M1–M6 一条不改**；本裁定**不加新契约点**，只**增一个消费面**，并把该消费面对 wire 的要求显式写死（R-W1–R-W3）。C-PREFIX-1 §5 的 M4（空前缀拒建）在本裁定下**多了一个理由**：它同时保证「新建项目必有短码」。

---

## 5. 与归一化（`identifierPrefix`）的关系

**唯一归一化函数**：`src/shared/ids.mjs` `identifierPrefix`。语义（C-PREFIX-1 §4 实测）：`trim` → `toUpperCase` → 把非 `[A-Za-z0-9]` 的连续段折叠为一个 `-` → 去掉两端的 `-`；对**已规范化**的值**幂等**。

- **短码不二次归一化。** 服务端存的已经是规范化后的值（M2），wire 回传的也是它 ⇒ 客户端**逐字**渲染。§3.1 M2 即此条。
- **原型 `nextIdentifier` 的 `|| "TD"` 兜底不得复制到短码侧**（R8）。那条兜底是**编号侧**的 demo 文案，实现在编号侧已由 C-PREFIX-1 M3 换成 `identifierPrefix(id)`——**同一个正确做法**在短码侧就是 §7.4 的 R-W1（服务端回传有效前缀）。短码侧**没有**自己的兜底（M3：空就空）。
- **名字与短码的关系 = 无。** 项目名与前缀是两个独立属性（R2 的种子本身即证明）；把名字接进短码就是 R9 的偏离。

**一处实测陷阱（必须写进实现卡，§9 C 段）**：

求「有效前缀」时，`meta.prefix` **缺席**与**为空串**是两件事。朴素写法的失败已实测：

```
identifierPrefix(undefined) === "UNDEFINED"      ← String(undefined) → "undefined" → 大写
identifierPrefix(null)      === "NULL"
identifierPrefix("")        === ""
```

⇒ `identifierPrefix(meta?.prefix) || identifierPrefix(id)` 在 `meta` **存在但无 `prefix`** 或 `meta` 为 `undefined` 时得到真值 **`"UNDEFINED"`**，**回退分支永不执行**，chip 渲染成 `UNDEFINED`（实测输出见 §9 C 段）。**正确形**（本轮实测，8 例全对）：

```js
// 只在「确有字符串」时归一化；否则按空处理，再回退 id
const raw = project.meta?.prefix;
const effective = (typeof raw === "string" ? identifierPrefix(raw) : "") || identifierPrefix(project.id);
```

（`identifierPrefix` 的**幂等性**是这条能安全地同时对「已规范化的存量值」与「规范化一次的新值」生效的前提——C-PREFIX-1 §4 / §9 B3 已实测，本契约 §9 C 段复核了三个样本。）

---

## 6. 逐面口径（下游实现卡的改动面清单）

> 本节**不**指定实现内部结构（那是实现卡的自由），只钉**必须成立的行为**与**不得出现的形态**。C-PREFIX-1 的实现卡是 `T-20261014-011936`（Linus），其 Boundary 是 `commands/projects.mjs` / 存储层 / `domain/task.mjs` / `CreateProjectModal.vue` + 一处 wire 快照，**不含侧栏** ⇒ 侧栏这一面需要**另开一张实现卡**（或由 Elon 并入该卡并**扩写其 Boundary**）。

| # | 位置 | 现状（实读） | 本契约要求 |
|---|---|---|---|
| 6.1 | `src/shared/wire.mjs`:`projectToWire` | 投影 `id/name/labels/meta/readme/task_count/archived_at/created_at/updated_at`，**无 `prefix`** | 增**只读** `prefix` = 有效前缀（R-W1）；同步 `test/fixtures/contract/api.snapshot.json`（R-W3）。派生点**建议**只有一处（例如随 C-PREFIX-1 §7.1.3 的「有效前缀」读取点一起，铸号与投影共用），因为两处各写一遍正是 §3.1 M2 禁止的「第二份推导」。 |
| 6.2 | `web/src/lib/monogram.js`:`initialsOf` | 名字压缩成 ≤3 大写（`web/src/**` 内**唯一**消费者是 `Sidebar.vue`，**实测**见 §9 B 段） | **不再是**项目短码的来源。该文件应**改语义**（成为「读/校验前缀」的纯函数）或**删除**；**不要**留着 `initialsOf` 供别处使用——它没有任何别的消费者（B 段实测），留着就是给下一个人留一条回头路。 |
| 6.3 | `web/src/components/shell/Sidebar.vue`:`[data-project] [data-side-icon]` | `initials: initialsOf(project.name)`（`:54`），模板渲染 `{{ project.initials }}` | `prefix: project.prefix`；模板**逐字**渲染该字符串。**保留** `class="td-mono"`、`data-side-icon`、`aria-hidden="true"`（R1/R4/R5 与 B03 的钩子形态不动）。**注释**里引用 B03「prefix monogram」那两行**保持**——裁定后它们**变成真的**。 |
| 6.4 | `test/web/monogram.test.mjs` | 断言 `initialsOf` 的 9 条取直（含 `initialsOf("MeerkatTaskPanel") === "MEE"`） | 随 6.2 改写或删除。**注意**：该测试是**唯一**把「名字派生」写成契约的地方，它**必须**与 6.2 同一步改，否则留下一条断言现状的红。 |
| 6.5 | `test/web/blocks.contract.mjs`（B03） | 只有一条 `[data-side-icon]` 规则：**在 `[data-nav]` 内 count = 0**（nav glyph 不得带该钩子） | **保持原样**。本裁定**不**新增规则：把 fixture 的短码值写成规则，等于把 demo 数据变成契约（该文件头部已把这条列为禁则）；短码的值属 **DOM 腿**（§8 D 段），由驱动式断言取证。 |
| 6.6 | `design/BLOCKS.md` §B03 | `.td-side-icon`（**prefix monogram**, rail only） | **已同向，不改文字**；仅补一段指向本契约的口径指针（§10 F 段）。 |
| 6.7 | **不在本契约内**：卡片的**头像 monogram** | `web/src/components/board/Card.vue`:`[data-card-assignee]` 渲染 `assigneeName[0]`；`design/BLOCKS.md` §B07 记作「monogram avatar」 | **本契约不管**。那是**人/agent** 的首字母头像，与项目短码是两个对象、两套规则（一个派生自**人**的名字、一个取自**项目**的前缀）。下游别把两处「monogram」混成一条规则。 |

---

## 7. 未决 / 交 Elon

**U1 · 原型自身的遗漏：新建项目行不带短码（R6）。**
- 现状：原型 `[data-create-project-form]` 的提交处理器追加的行只含 `.td-side-name` + `[data-project-count]`；`setProject` 不建行（R7）。⇒ 原型**从未**演示「建项目 → 短码出现」，静态三行是唯一带 chip 的形态。
- 本裁定的后果：前缀在建项目时**必填**（C-PREFIX-1 M2/M4）⇒ **新建项目必有短码**，实现里新行**必须**带 chip。这是一处**声明式补充**（§⑨.1 Addendum II 规则 2：遗漏可最小补充，但**必须登记**）。
- **请 Elon 择一**：**(a)** 依本契约——实现补短码、**原型不动**（**推荐**：原型保留为「静态三行」的设计基线，实现侧补充已被本文件登记；代价 = 原型与实际行为在这一点上不同）；**(b)** 另开一张**小设计卡**把动态行也补进原型（会动 `design/prototype/**` ⇒ 重算 `STALE_PROSE_COUNTS` / i18n 计数 / ui-align 分母，**本卡不做**）。
- 登记：本卡**不改原型一行**；若 Elon 选 (b)，本契约 §2 R6 的表述需随之更新。

**U2 · 长前缀的 chip 宽度（原型无 in-oracle 证据）。**
- 现状：有效前缀对**存量项目**（无存储前缀、id 为 UUID）= `identifierPrefix(uuid)`，**实测 36 字符**（`A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D`，§9 A 段）；原型的 chip 是**固定 24×24**（R4），三个种子前缀长度 ≤4。
- 本裁定的取向：**逐字渲染、不截断**（M4），理由是截断破坏 M5 的可见唯一性。
- **请 Elon 确认**该取向；另一选项（chip 给最大宽度 + `ellipsis`）须**同时**回答「两台不同项目截断后同形」怎么办——本契约不在两者间自选，因为**原型对此无证据**，属产品取舍。
- 实现卡须就此**取一次实测**（§8 D4）：长前缀在 64px / 56px 两档 rail 下的溢出行为，并把数字附进报告。

**U3 · 设计源一致性核查（结论：无矛盾）。**
- 实读 `design/**`：提及项目短码/项目 monogram 的位置**全部**写作「prefix monogram」或本契约（§2 R3/R4/R5）；`design/BLOCKS.md` §B07 的「monogram avatar」指人物头像（6.7），不是项目短码。
- ⇒ **设计源内部不存在**「短码 = 名字首字母」的书面口径 ⇒ 本裁定**不触发**卡面 ② 的「与原型矛盾 ⇒ 交 Elon 裁定」分支。

**U4 · 承接 C-PREFIX-1 的未决项（不变）**：E1 序号宽度 / E2 归一化覆盖面（`ab_c` 折叠）/ E6 `maxlength`（`demo_x` 打不进 UI）三条**仍开**；本裁定**不表态**。

---

## 8. 机检断言清单（实现卡落地后应全绿；C/D 两腿**本卡未跑**）

### A · 源码静态（**宿主机允许**；纯 `grep` / 静态 lint / 直跑纯函数）

| # | 断言 | 落点/命令 |
|---|---|---|
| A1 | 项目短码不再派生自名字 | `web/src/components/shell/Sidebar.vue` 的 `[data-project]` 行**不**出现 `initialsOf` / `project.name` 参与短码 |
| A2 | 派生/归一化点唯一 | `initialsOf` 在 `web/src/**` 的消费者数 = **0**（本轮基线 1，§9 B 段）；`identifierPrefix` 定义点仍只有 `src/shared/ids.mjs` |
| A3 | 客户端零推导 | `web/src/**` 内不出现 `.toUpperCase()` 或折叠非字母数字的正则（与 C-PREFIX-1 §9 A3/A5 同一条） |
| A4 | wire 回传有效前缀 | `node scripts/verify/contract.mjs --print` 的 wire 段含 `projects.prefix`（**类型 string**）；快照已 `--update`（R-W3） |
| A5 | `prefix` 只读 | `node scripts/verify/route-request.mjs --print`：`PATCH /api/v1/projects/:id` 的 declared 体**不含** `prefix` |
| A6 | 原型未被动过 | `git diff --stat -- design/prototype` 为空 |
| A7 | 钩子形态未动 | `[data-side-icon]` 仍在 `[data-project]` 行内、仍 `aria-hidden="true"`、仍带 `td-mono`；`[data-nav]` 内 `[data-side-icon]` 仍为 0（B03 既有规则，6.5） |

### B · 纯函数（**宿主机允许**，无浏览器无服务）

| # | 断言 |
|---|---|
| B1 | 有效前缀：存储前缀 `"td"` ⇒ `"TD"`；`"or c"` ⇒ `"OR-C"`（**实测**，§9 C 段） |
| B2 | 有效前缀回退：无存储前缀 + id `"demo"` ⇒ `"DEMO"`（= C-PREFIX-1 M3 的存量行为） |
| B3 | **陷阱负例**：`meta` 为 `{}` 或 `undefined` + id 为 UUID ⇒ **不得**得到 `"UNDEFINED"`，须得 `identifierPrefix(id)`（§5、§9 C 段） |
| B4 | 幂等：`identifierPrefix(identifierPrefix(s)) === identifierPrefix(s)`，样本 `"TD"` / `"DEMO-X"` / `identifierPrefix(uuid)`（§9 C 段 3/3） |
| B5 | 空有效前缀 ⇒ **空串**（不是 `initialsOf` 的任何值），且 `identifierFor` 的既有守卫仍抛 `VALIDATION_FAILED`（C-PREFIX-1 §9 B5） |

### C · 容器内真跑（**必须 `npm run verify:docker` / `docker/verify-in-container.sh`**；本 lane **未跑**）

| # | 断言 | 预期 |
|---|---|---|
| C1 | `GET /api/v1/projects` 每条**都有** `prefix` 字段 | 类型 string |
| C2 | UI 建项目（`meta.prefix:"td"`）⇒ 该项目 `prefix === "TD"`，其卡号 `TD-0001` | 短码与卡号同源 |
| C3 | **存量回归**：老项目（UUID id、无前缀）⇒ `prefix === identifierPrefix(id)`，卡号前缀与升级前逐字相同 | M3 回退路径 |
| C4 | `meta.prefix:"####"`（C-PREFIX-1 M4）⇒ 400，项目不落库 ⇒ 不存在「短码空却活着」的项目 | 与 M4 互为收口 |
| C5 | 两个项目有效前缀相同 ⇒ 第二个被拒（M5）⇒ **rail 里不存在两个同形 chip** | 可见唯一性 |

### D · 浏览器（宿主机允许；需 `web/dist` + 可启动浏览器，本 lane **未跑**）

| # | 断言 |
|---|---|
| D1 | 项目 X 的卡号显示 `PREFIX-…` ⇒ rail 里该项目行的 `[data-side-icon]` 文本 === 同一 `PREFIX`（**端到端同源**，本裁定唯一的核心断言） |
| D2 | 改该项目**名字**（若实现提供入口）⇒ 短码**不变**（M6 的短码侧表达） |
| D3 | ≤1023px 档短码可见、名字隐藏（rail 既有规则不回归）；≥1024px 档短码不显示（R3） |
| D4 | **U2 取证**：长前缀（存量项目）在 64px / 56px 两档 rail 下不产生横向溢出、不裁剪名字行的其它部分；实测数字入报告 |
| D5 | U1 落地后：新建项目 ⇒ 新行**立即**带短码，且等于刚输入的前缀 |

**不得断言**（负向注记）：不断言短码的**字体/颜色/边框**（那属 `ui-align` 的 computed-style 腿）；不断言 rail 里 chip 的**个数**（fixture 派生多重性，`blocks.contract.mjs` 头部禁则）；不断言 C-PREFIX-1 §8 E1/E2/E6 三条未决项；不断言拒绝文案字面（C-PREFIX-1 M7）。

---

## 9. 证据与复跑

**A 段 · 两个候选值 + 有效前缀取值（实测，宿主机纯函数）**

```
$ node --input-type=module -e "import { identifierPrefix } from './src/shared/ids.mjs';
                                import { initialsOf } from './web/src/lib/monogram.js'; …"

--- 原型三个种子：短码的两个候选值 ---
"Orchestrator"       initialsOf = "ORC"  | identifierPrefix = "ORCHESTRATOR"     | len 12
"MeerkatTaskPanel"   initialsOf = "MEE"  | identifierPrefix = "MEERKATTASKPANEL" | len 16
"Site Refresh"       initialsOf = "SR"   | identifierPrefix = "SITE-REFRESH"     | len 12

--- legacy 回退（UUID 形 id，存量项目） ---
id a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d
identifierPrefix(id) = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D" | len 36
```

⇒ ① 判据行 `MeerkatTaskPanel`：原型 `TD` vs 实现 `MEE`（分叉**存在**，字面值更正见 §0 ④）；② 另两行**巧合重合**，不构成证据；③ U2 的长度数字 = **36** 字符（对照 R4 的 24×24 chip）。

**B 段 · `initialsOf` 消费者扫描（实测）**

```
$ grep -rn "initialsOf" web/src web/scripts test
web/src/lib/monogram.js:15:export function initialsOf(name) {
web/src/components/shell/Sidebar.vue:31:import { initialsOf } from "../../lib/monogram.js";
web/src/components/shell/Sidebar.vue:54:    initials: initialsOf(project.name),
test/web/monogram.test.mjs:12/14/16…37（测试自身的 9 条断言）
⇒ web/src/** 内的生产消费者 = 1（Sidebar.vue）；其余匹配是定义点、测试与注释。
   Card.vue 的 monogram 是 assignee 首字母（6.7），不是本函数。
```

**C 段 · 有效前缀公式：陷阱与正形（实测）**

```
$ node --input-type=module -e "… identifierPrefix(undefined) / 朴素形 / 守卫形 …"

--- 归一化函数对空值的取值（陷阱来源） ---
identifierPrefix(undefined) = "UNDEFINED"
identifierPrefix("")        = ""
identifierPrefix(null)      = "NULL"

--- 朴素形 identifierPrefix(meta?.prefix) || identifierPrefix(id) ---
naive(meta={}, id=uuid) = "UNDEFINED"          ← 真值 ⇒ 回退永不执行、chip 渲染 UNDEFINED

--- 守卫形 (typeof raw === "string" ? identifierPrefix(raw) : "") || identifierPrefix(id) ---
meta={"prefix":"td"}      id=uuid   => "TD"
meta={"prefix":"or c"}    id=uuid   => "OR-C"
meta={}                   id=uuid   => "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D"   ← 回退生效
meta=undefined            id="demo" => "DEMO"
meta=undefined            id=uuid   => "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D"
meta={"prefix":"####"}    id="p1"   => "P1"                                   ← 归一化后为空 ⇒ 回退
meta={"prefix":""}        id="p1"   => "P1"
meta={"prefix":"DEMO-X"}  id="whatever" => "DEMO-X"

--- 幂等复核（M5/§6 直接比对的前提） ---
"TD"                                     idempotent: true
"DEMO-X"                                 idempotent: true
"A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D"   idempotent: true
```

**D 段 · 声明式请求体（**引用**，本轮未复跑）**：`PATCH /api/v1/projects/:id` 的 declared 体 = `[labels, meta, name, readme]`（C-PREFIX-1 §10 D 段的**实测**记录）。本轮**未**重跑 `scripts/verify/route-request.mjs`——R-W2 / §8 A5 的取证归实现卡。

**E 段 · 未跑的部分（明写，不圆）**

- 本 lane **未**运行 `taskd`、**未**构建 `web/dist`、**未**驱动浏览器、**未**进容器。§8 的 A/B 两腿可复跑；C/D 两腿由实现卡与独立验证卡执行。
- 原型侧**未**驱动浏览器：§2 的 R1–R8 是**实读**（符号级），不是实测。若 Elon/Turing 要更强证据，建议在宿主 Chromium 上按 R6 建一个 `zx` 前缀的项目，读回该行的 `.td-side-icon` 是否存在，并把原始输出附在报告里——这正是 U1 的证据位。
- 本裁定**未**核查任何本地库里存量项目的 id 形态分布（UUID 与否）。U2 的 36 字符是 UUID 形 id 的**上界样本**，不是分布。

**F 段 · 落笔范围（本轮改动清单）**

| 文件 | 动作 |
|---|---|
| `design/contracts/side-rail-short-code.md` | **新增**（本文件） |
| `design/README.md` | `contracts/` 段落补一句（第二份契约） |
| `design/BLOCKS.md` | **仅** §B03 补一段口径指针（3 行，仿 §B11 的既有写法） |
| `design/contracts/project-prefix-binding.md` | **仅**在 §8 E4 与 §7.4 各补一行「已裁定 / 已激活」的**指针**（不改原判） |
| 其余（`design/prototype/**` / `design/DESIGN.md` / `design/fidelity-*.md` / `web/**` / `src/**` / `test/**` / i18n 三份镜像） | **零改动** |

---

## 10. 附：与「前缀 = 卡号前缀」绑定裁定的边界（防止下游把两张卡做成一件事）

| 问题 | 归谁 |
|---|---|
| 建项目 prefix 字段是否决定卡号前缀？归一化函数是哪一支？M1–M6 | **C-PREFIX-1**（`design/contracts/project-prefix-binding.md`），已冻结 |
| 侧栏短码显示的是「前缀」还是「名字首字母」？短码从 chain 的哪个字段取？ | **本契约（C-RAIL-1）** |
| 上面两件事的**代码**改动 | C-PREFIX-1 的实现卡 = `T-20261014-011936`（Linus，写面不含侧栏）；**侧栏这一面另开实现卡**（§6 抬头） |
| 卡片的**人物**头像 monogram | `design/BLOCKS.md` §B07；与本契约无关（6.7） |
