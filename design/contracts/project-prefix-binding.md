# 建项目 prefix 字段 ↔ 卡号前缀 绑定契约 · C-PREFIX-1

> 字段即项目 `id`；前缀由 `identifierPrefix` **唯一**产出。

> 卡：`T-20261014-003808`（goal：依原型冻结口径，裁定「建项目 prefix 字段」与「卡号前缀」的绑定，产出可实现、可验证的唯一契约。flow A 前置。）
> 分工：**C1 = 本契约**（写面 `design/**`，**零实现**）→ **C2 = 实现**（Linus 另卡）→ **C3 = 独立验证**（Turing）。本文件是 C2/C3 的**唯一口径**。
> 口径来源：卡面 `## Background`（Linus 在 `T-20261014-002458` 的发现：UI 只发 `name`+`meta.prefix`、服务端铸 UUID、`meta.prefix` 只写不读）+ Acceptance ①②③④。
> 事实源：原型 = `design/prototype/app.js`、`design/prototype/index.html`（**实读**，符号级；本 lane **未**驱动浏览器）；实现 = `web/src/components/create/CreateProjectModal.vue`、`web/src/services/api.js`、`web/src/components/shell/Sidebar.vue`、`web/src/lib/monogram.js`、`src/server/routes/projects.mjs`、`src/core/commands/projects.mjs`、`src/core/storage/repositories/projects.mjs`、`src/core/domain/task.mjs`、`src/shared/ids.mjs`（**实读未实测**）；归一化函数 = `identifierPrefix` / `formatIdentifier` / `identifierFor`（**实测**，纯函数，见 §10）。
> 基线 commit：`3bb992a`（= 本 lane 的开工点，= `main`）。
> 本文件**不存在于任何既有契约文档内**（新文件），未改动 `DESIGN.md` / `BLOCKS.md` / `fidelity-*.md` / `design/prototype/**` 一行——同仓另有 lane 正在写这些文件（见 §8 末）。

## 0. 结论摘要

- **① 裁定 = 是：prefix 字段决定卡号前缀。** 唯一口径 = **UI 把该字段的值（`trim`，**不做**大小写/字符改写）作为 `POST /api/v1/projects` 的 `id` 提交**；服务端把 `id` 存为项目 `id`；卡号 = `identifierPrefix(project.id)` + `-` + 4 位序号。**不采用**「服务端读 `meta.prefix`」（理由与备选对照见 §3.2）。归一化关系见 §4：**唯一**归一化函数是 `identifierPrefix`（`demo_x` → `DEMO-X`），UI **不得**再折叠一次。
- **② 可实现判据与示例见 §3.3 / §5 / §6 / §9。** 登记落点 = 本文件（`design/contracts/project-prefix-binding.md`）+ `design/README.md` 目录树一行（非共享文件，无冲突面）。
- **③ 不以实现反推原型。** 本契约的每一条先取原型证据（§2，符号级引文），再对齐仓库**既有的唯一身份规则**（`src/core/commands/projects.mjs` 头注：「a project id is normalized to the prefix its tasks are numbered with」，CLI `project create --id` 的 summary：「Project id; also the identifier prefix」）。没有任何一条是从 `web/**` 的实现现状倒推出来的。
- **④ 原型该字段的语义 = 无需调整**（原型的语义**正是**「该项目的编号前缀」，与本裁定逐字一致）。原型侧另有 **5 处与本裁定正交**的出入/遗漏，逐条列在 §8 交 Elon 裁定；本 lane **未改原型一行**（Acceptance ③ 的红线）。
- **实现面结论（供 C2 排期）：零服务端改动、零契约快照改动。** `POST /api/v1/projects` 的**声明**请求体**已经**含 `id`（`src/server/routes/projects.mjs` 的 `CREATE_BODY`，`test/fixtures/contract/api.snapshot.json` 同步收录 `id`)；改动面只有 `web/src/**` 的**一行级**提交体（§7.1）+ 一处**建议**的服务端收口（§5，属口径变更，**需 Elon 确认**）。
- **卡面示例的一处精度（先说，不圆过去）：** 卡面 Acceptance ② 的例子 `prefix demo_x ⇒ 卡号 DEMO-X-0001` 里的 `demo_x` 是**归一化函数的例子**，**不是** UI 字段可输入的值——原型给该字段 `maxlength="4"`，`demo_x` 有 6 个字符，UI 打不进去。UI 路径最长的前缀是 4 字符（⇒ `XXXX-0001`）；`demo_x` 只能来自 CLI/API（`--id demo_x`）。两种路径的前缀规则**同一条**（§4）。**不要**为了迁就这个例子去放宽 `maxlength`（那会与原型矛盾，见 §8 E6）。

---

## 1. 口径与证据规则

**闭集词表（逐字使用，不得自创）**：`对齐` = 两侧**实测**同值；`一致` = 两侧书面/符号级同义（未实测）；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本文件不出现任何「文件 + 数字行号」形式的引用）。

**证据分级（每条结论必须能归入其中一级）**：

1. **实测**——真跑出来的：本轮的 `identifierPrefix` / `formatIdentifier` / `identifierFor` 取值（纯函数，Node 直跑，原始输出见 §10）。这一级是本契约**唯一**的运行时证据。
2. **实读**——逐符号读过源码/原型，未运行。
3. **实读未实测**——实现侧（`web/**`、`src/**`）本轮一律属此级：本 lane 未构建 `web/dist`、未起 `taskd`、未驱动浏览器、未进容器。§7 的每条都是实读值，凡涉及运行时行为者均在 §9 明标「C 腿/D 腿未跑」。
4. **不伪造**：未跑的写「未跑」；原型侧凡未驱动浏览器者，不写「实测」。

---

## 2. 原型（oracle）证据——字段「就是」编号前缀

以下全部为**实读**（符号级），未跑浏览器：

| # | 位置 | 事实 |
|---|---|---|
| P1 | `design/prototype/app.js`：`PROJECT_PREFIX` 字面量 | `{ MeerkatTaskPanel: "TD", Orchestrator: "ORC", "Site Refresh": "SR" }`——**键 = 项目名，值 = 编号前缀**。种子本身即证明两者是**两个独立属性**：项目「MeerkatTaskPanel」的前缀是 `TD` 而不是名字的任何缩写。 |
| P2 | `design/prototype/index.html`：`form[data-create-project-form]` | 两个输入 `[data-create-project-name]` 与 `[data-create-project-prefix]` **均带 `required`**；prefill/hint 键 `createProject.field.prefixHint` = 「Up to four characters, for example TD.」；`[data-create-project-prefix]` 带 `maxlength="4"`。 |
| P3 | `design/prototype/app.js`：`[data-create-project-form]` 的 `submit` 处理器 | 取 `[data-create-project-prefix]` 的值 → `$.trim(...).toUpperCase()`；守卫 `if (!name || !prefix) { focus(name); return; }`——**空前缀不建项目**；成功路径把 `PROJECT_PREFIX[name] = prefix`（**前缀挂到该项目上**），然后 `setProject(name)` 并提示。 |
| P4 | `design/prototype/app.js`：`nextIdentifier(project)` | `var prefix = PROJECT_PREFIX[project] \|\| "TD";` → 扫当前 DOM 里同前缀的卡取最大序号 → `return prefix + "-" + (highest + 1);`。由建卡路径调用（建卡时 `identifier: nextIdentifier(project)`）。 |
| P5 | `design/prototype/index.html`：`[data-project-list]` 三行 | 行文本 = 项目名（`.td-side-name`），而 `.td-side-icon` 的文本 = `ORC` / `TD` / `SR`——**即前缀**（`MeerkatTaskPanel` 的 `TD` ≠ 名字首字母；另两个是巧合重合）。 |

**原型立场，一句话**：建项目时的 prefix 字段 = **该项目的编号前缀**；必填；建完立刻参与编号（P4）；同一个值同时被当作项目在侧栏的短码（P5）。

---

## 3. 裁定

### 3.1 主裁定（唯一口径）

> **建项目 modal 的 `[data-create-project-prefix]` 字段决定该项目所有卡号的数字前缀，且唯一经由：字段值 → `POST /api/v1/projects` 的 `id` → 项目 `id` → `identifierPrefix(project.id)`。**

数据流（逐跳，全部是既有设施，无新增）：

```
[data-create-project-prefix]  ──(trim，原文)──▶  POST /api/v1/projects { id, name }
                                                     │
                                          src/server/routes/projects.mjs : POST
                                                     │  body.id
                                          src/core/commands/projects.mjs : createProject
                                                     │
                                          src/core/storage/repositories/projects.mjs : create
                                                     │  const id = input.id ?? newId()
                                                     ▼
                                              projects.id  ──┬─▶ allocateIdentifier(projectId)
                                                             │      └─ identifierFor(projectId, serial)
                                                             │            └─ identifierPrefix(projectId)
                                                             └─▶ 卡号 = PREFIX-NNNN
```

**三条「必须」**：

- **M1**：UI 提交的请求体**含** `id`，其值 = `[data-create-project-prefix]` 的值 `trim()` 后的**原文**（**不做** `.toUpperCase()`，**不做**任何字符折叠——见 §4）。
- **M2**：UI 提交的请求体**不含** `meta.prefix`；本契约生效后 `meta.prefix` 不再是任何口径的一部分（历史行里的值惰性，无读点，见 §7.2）。
- **M3**：卡号前缀**只能**由 `identifierPrefix(project.id)` 产出，唯一产出点仍是 `src/core/domain/task.mjs` `identifierFor`（经 `src/core/storage/repositories/projects.mjs` `allocateIdentifier`）。**不得**新增第二个前缀来源（`web/**`、`src/server/**`、`src/shared/**` 都不许出现第二份折叠正则）。

### 3.2 备选与拒绝理由（卡面点名的两条候选）

| 候选 | 判定 | 理由 |
|---|---|---|
| **(A) UI 提交 `id`**（**采定**） | ✅ | ① 请求体**已经**声明 `id`（`CREATE_BODY`，快照已收录）⇒ **零服务端改动、零快照改动**；② 与**既有唯一身份规则**同一条（`createProject` 头注、CLI `--id` 的 summary、`assertPrefixAvailable` 比对的都是 `identifierPrefix(project.id)`）；③ 唯一性检查**现成**（`assertPrefixAvailable`，含归档项目）；④ 前缀与项目身份**同源**，不可能分叉。 |
| **(B) 服务端读 `meta.prefix`** | ❌ | ① `meta` 是**自由字段**（`createProject` 头注：「a project is a name, a label set and free-form meta」），把身份搬进自由字段会让「前缀」有**两个真源**（`id` 归一化 vs `meta.prefix`），需要**第二套**唯一性规则与**第二套**解析顺序（CLI 建的项目没有 `meta.prefix`，得回落到 `identifierPrefix(id)`）——这正是「一份规则变成两份」的漂移类；② 它保留 UUID 作 `id`，于是板上出现「`id` 是 UUID、卡号是 `DEMO-X-0001`」的项目，`identifierPrefix(projectId)` 这个名字与语义脱钩；③ 改动面反而更大（新列或新读点 + 唯一性 + `identifierFor` 改签名）。 |
| **(C) 其它：新增 `prefix` 列，服务端由前缀生成 `id`** | ❌ | 与 (B) 同罪而多一处 schema 变更；对 (A) 没有任何增量信息。 |

### 3.3 判定样例（可直接照抄进测试）

| 输入（UI 字段 / CLI `--id`） | 项目 `id` | 第 1 张卡 | 第 2 张卡 | 第 10 张卡 |
|---|---|---|---|---|
| `TD` | `TD` | `TD-0001` | `TD-0002` | `TD-0010` |
| `demo` | `demo` | `DEMO-0001` | `DEMO-0002` | `DEMO-0010` |
| `demo_x`（**仅 CLI/API 可达**，UI 打不进 6 字符） | `demo_x` | `DEMO-X-0001` | `DEMO-X-0002` | `DEMO-X-0010` |
| `or12` | `or12` | `OR12-0001` | — | — |
| `####` | **必须拒绝**（§5） | — | — | — |

上表 `TD` / `demo` / `demo_x` / `or12` 四行的**归一化结果**为**实测值**（§10 A 段，直跑 `identifierPrefix` / `formatIdentifier`）；`####` 行为是**新增口径**（§5），实现前为红。

---

## 4. 与归一化规则（`identifierPrefix`）的关系

**唯一归一化函数**：`src/shared/ids.mjs` `identifierPrefix`。实测语义（§10）：`trim` → `toUpperCase` → 把**非 `[A-Za-z0-9]` 的连续段**折叠为**一个** `-` → 去掉两端的 `-`。故：

- `identifierPrefix("demo_x")` = `DEMO-X`（**实测**）；`identifierPrefix("meerkat-taskpanel")` = `MEERKAT-TASKPANEL`；`identifierPrefix("Site Refresh")` = `SITE-REFRESH`；`identifierPrefix("--x--")` = `X`；`identifierPrefix("###")` = `""`（空前缀，见 §5）。
- 序号宽度**不变**：`IDENTIFIER_PAD` = 4，序号从 `projects.next_task_number`（初值 1）自增。**本契约不裁定序号宽度**（原型侧的不填充出入见 §8 E1）。
- `formatIdentifier(projectId, serial)` 与 `identifierFor(projectId, serial)` 在**非空前缀**上同值（前者不校验空前缀，后者对空前缀抛 `VALIDATION_FAILED`）；卡号分配走的是后者（`allocateIdentifier`）。

**UI 侧不得再归一化一次。** 今天的 `CreateProjectModal.vue` 在提交时做 `.toUpperCase()`——它与 `identifierPrefix` 的 `toUpperCase` **重复**。两份「大写规则」就是漂移的开始，且 UI 那份**永远无法**复现折叠与去边（那是 `identifierPrefix` 的职责）。故 **M1 要求提交原文**。

**「原文提交」是否背离原型 P3 的 `.toUpperCase()`？不背离。** 原型只大写、不折叠非字母数字，也**没有**独立的前缀归一化函数；仓库里**有**一个（`identifierPrefix`），它的第一步就是大写。因此：

- 在 `[A-Za-z0-9]` 上（UI 字段的合理输入域），`identifierPrefix(s) === s.toUpperCase()` —— **实测，842,234 例，0 处不符**（§10 B 段：穷举 1–3 字符全量 238,328 + 4 字符定种子抽样 603,906）。
- ⇒ 字段原文提交后，前缀与原型 P3/P4 的存储值**逐字符相同**；UI 无需大小写改写，原型无需改动，规则只有一份。

**含非字母数字的输入**（`ab_c` → 原型 `AB_C-1` vs 实现 `AB-C-0001`）不属上面这条等价域，是本轮**发现的原型侧缺陷**（不是本裁定的后果：CLI `--id ab_c` 今天就是这个结果），列 §8 E2 交 Elon，**本契约不改原型、也不放宽规则**。

---

## 5. 必备收口：空归一化前缀的「僵尸项目」

**事实（实读）**：`src/core/commands/projects.mjs` `assertPrefixAvailable` 的注释**明确**为空前缀让路（「An id that normalizes to the empty prefix (`###`) is left to the pre-existing guard in `identifierFor` … this check is about collisions, not emptiness, so it steps aside when the prefix is `""`」）；`repositories.projects.create` 不校验；`identifierFor` 到**第一张卡**才抛 `VALIDATION_FAILED`。

**为什么本裁定必须收口**：在裁定之前，UI 从不发 `id`，项目 id 永远是刚铸的 UUID（前缀必然非空），所以这条路径**不可达**；采纳 (A) 之后，用户输入的字符串**成为** `id`，`####`（4 字符，`maxlength=4` 内、可打）会建出一个**永远生不出卡**的项目——板上的僵尸项目。**这是裁定自身引入的可达缺陷，必须由裁定关掉。**

**M4（新增）**：项目创建时，若 `identifierPrefix(input.id) === ""`，**拒绝创建**，响应 `VALIDATION_FAILED`（HTTP 400），项目不得落库。该规则属**创建**，不是**编号**（`identifierFor` 的既有守卫保留不动，两处不互相取代）。

- 实现落点（建议，C2 自定）：`src/core/commands/projects.mjs` `createProject` 内、`assertPrefixAvailable` 之前；`details` 建议 `{ field: "id" }`（与 `assertPrefixAvailable` 同形）。
- 覆盖面：**两侧入口**都吃到——UI 字段提交 `####`，以及 CLI `taskctl project create --id '####'`。
- ⚠️ **这是口径变更**：它推翻 `assertPrefixAvailable` 注释里那句**刻意的**让路。**需 Elon 确认**（§8 E5）。若不确认，则本契约记录为「已知缺陷、按现状放行」，M4 在 C2 卡里降级为可选。

**判据（C 腿，见 §9）**：`POST /api/v1/projects {"id":"####","name":"x"}` ⇒ 400 `VALIDATION_FAILED`，且 `GET /api/v1/projects` 中**不存在**该项目。

---

## 6. 唯一性、不可变、拒绝面

- **M5｜前缀唯一（归一化后）**：两个项目只要归一化后前缀相同，在板上就不可区分（会各自发 `OPENCLAW-TEAM-0007`）⇒ 保留既有拒绝（`assertPrefixAvailable`，**含归档项目**：归档不退还前缀，因为它发出的标识符还在卡上）。**不得**为 (A) 放宽它。注意两种拒绝的边界：`id` 字面相同 ⇒ `ID_CONFLICT`（409，主键）；字面不同但归一化相同（`demo` vs `DEMO`）⇒ `VALIDATION_FAILED`（400，`assertPrefixAvailable`）。
- **M6｜前缀创建后不可改**：`PATCH /api/v1/projects/:id` 的声明请求体**无** `id`（`src/server/routes/projects.mjs` `PATCH_BODY`；**实测**见 §10 D 段：`declared [labels, meta, name, readme]`）⇒ 保留；UI **不得**提供改前缀的入口（原型亦无项目编辑界面，两侧`一致`）。
- **M7｜拒绝的呈现**：请求被拒时，**弹窗不关闭、不建项目、不发 toast 成功**；错误文案属**实现侧**（`web/src/i18n/extra.mjs`），**本契约不造句**（设计轮不得新增 i18n 键——`design/prototype/app.js` 的 `MESSAGES` 与两份 catalogue 镜像本轮**零改动**，见 §7.3）。可观测判据只到「失败可见、弹窗留守、无项目落库」为止。
- **M8｜字段值即身份，不得二次解释**：`project.id` 不得被任何面**当作前缀**直接渲染（见 §7.4）。

---

## 7. 逐面口径（C2 的改动面清单）

### 7.1 `CreateProjectModal.vue`（唯一必须改的实现文件）

| | 现状（实读） | 本契约要求 |
|---|---|---|
| 提交体 | `api.createProject({ name: form.name.trim(), meta: form.prefix.trim() ? { prefix: form.prefix.trim().toUpperCase() } : {} })` | `api.createProject({ id: form.prefix.trim(), name: form.name.trim() })`——**含 `id`、无 `meta`**（M1/M2） |
| 可提交条件 | `canSubmit = form.name.trim() !== ""` | **`name` 与 `prefix` 皆非空**（原型 P2/P3：两个 input 都 `required`，守卫是 `if (!name || !prefix)`）⇒ 空前缀时**不发出请求** |
| 字段属性 | `maxlength="4"`，无 `pattern` | 保持 `maxlength="4"`；**不加**字符集 `pattern`（正文围与原型 P2 的书面面相反部分零改动；非字母数字的后果见 §8 E2） |
| 输入大小写 | 提交时 `.toUpperCase()` | **去掉**（§4：归一化只有一份） |
| 清空时机 | 打开弹窗时清空两个字段 | 保持 |

### 7.2 `meta.prefix` 的收尾

**实测事实（§10 C 段）**：`meta.prefix` 在 `src/**` 与 `web/src/**` 内**零读点**——今天唯一的出现处是 `CreateProjectModal.vue` 的**写入**表达式、`form.prefix` 这个**局部变量**，以及两条 i18n 键名（`createProject.field.prefix` / `.prefixHint`，是标签文案，与 `meta` 无关）。⇒ M2 落地后，`meta.prefix` 的写点归零，**没有读点需要改**。历史行里的 `meta.prefix` **不迁移、不清理**（惰性数据，无读点即无行为）。

### 7.3 i18n / 文案

`createProject.field.prefix`（「Identifier prefix」/「标识前缀」）与 `createProject.field.prefixHint`（「Up to four characters, for example TD.」/「最多四个字符，例如 TD。」）**保持原样**——它们已经描述的就是本裁定后的语义。**本轮不新增、不修改任何 i18n 键**（`design/prototype/app.js` 的 `MESSAGES`、`web/src/i18n/catalogue.mjs`、`test/web/i18n.catalogue.mjs` 三处镜像**零改动**）。若 C2 需要「拒绝」的文案，落在 `web/src/i18n/extra.mjs`（实现侧自撰），不进两份 catalogue。

### 7.4 渲染面：凡显示「前缀」者，走 `identifierPrefix`

`project.id` 在采纳 (A) 之后是**用户输入串**（如 `demo`），**不等于**前缀（`DEMO`）。因此**任何**要显示前缀的面**必须**用 `identifierPrefix(project.id)`，不得直接渲染 `project.id`。今天实现侧**没有**这样的面（侧栏短码走的是 `web/src/lib/monogram.js` `initialsOf(project.name)`——**那正是 §8 E4 的分叉点**），所以本条是**前瞻约束**，本轮无改动面。

---

## 8. 与原型/卡面示例的出入、未决项（**交 Elon**；本 lane 未改原型一行）

> 依据 Acceptance ③④：以下各项**均正交于**「字段 ↔ 卡号前缀」的绑定裁定（绑定口径已由 §3 独立成立）。逐项给「现状 / 证据 / 建议 / 归属」，**不自行发散、不自行改原型**。同仓另有 lane（`T-20261014-001418`）正在写 `design/DESIGN.md`、`design/BLOCKS.md`、`design/fidelity-r8.md`、`design/fidelity-r12.md`、`design/prototype/app.js`——**本节内容一律不落笔到那些文件**，正是为了不与之抢面。

**E1 · 序号宽度：原型不填充，卡面示例与实现都填充。**
- 现状：原型**静态种子** `TD-112 … TD-134`（不填充），运行时 `nextIdentifier` 也 `prefix + "-" + (highest + 1)`（不填充）；但同一个原型里另有 `PROJ-0007`（9 字符，填充）——它是 R8「8 字符 + `…`」截断契约的**唯一种子**。实现侧一律 `padStart(4, "0")`（`PROJ-0007` 正好是它的产物）。卡面 Acceptance ② 的例子 `DEMO-X-0001` 是**填充**形。
- 立场：**本契约按填充执行**（与卡面示例、与实现现状一致），并**明确记录**原型侧的不填充。**不裁定**（绑定口径与序号宽度正交）。
- 若要照原型改成不填充：R8 的截断样本 `PROJ-0007` 会失去唯一触发点（`TD-134` 只有 6 字符），R8 §2.3 的机检与 `test/web/identifier.test.mjs` 的边界样本都要跟着重排 ⇒ **代价大于收益，建议维持填充**。

**E2 · 归一化覆盖面：原型只大写，冻结规则会折叠非字母数字。**
- 现状（**实测**，§10 B 段）：在 `[A-Za-z0-9]` 上二者**完全一致**（842,234 例 0 不符）；在含其它字符时不一致——`ab_c`：原型 `AB_C` + 序号，实现 `AB-C-0001`；`a.b`：原型 `A.B`，实现 `A-B`；`-ab-`：原型 `-AB-`，实现 `AB`。
- 归属：这不是本裁定引入的（CLI `--id ab_c` 今天已是 `AB-C`），它是**原型侧没有实现归一化**的缺口。
- 建议：**默认按冻结规则**（`identifierPrefix`），即**原型不必改**即可实现（UI 字段域 `[A-Za-z0-9]` 内两者可证等价，见 §4）。若产品要「前缀 = 原样大写」，那才是 **「原型需改」**（把 `PROJECT_PREFIX[name] = prefix` 改成折叠非字母数字 + 去边），理由须写清：否则 `--id demo_x` 与 UI 会各有一套规则。**交 Elon 择一**。

**E3 · 重复前缀：原型允许，实现拒绝（实现更严）。**
- 现状：原型 `nextIdentifier` 只看当前项目的 DOM，两个项目取同一前缀不会被拦（P4/P3）；实现侧 `assertPrefixAvailable` 拒绝。
- 归属：**原型的遗漏**，非需求矛盾 ⇒ 按 Acceptance ③ 不需回 Elon，**保留实现侧更严的行为**。此处记录以免下游把它读成「实现对不齐原型」。

**E4 · 侧栏短码（`.td-side-icon`）：原型是「前缀」，实现是「名字首字母」。**
- 现状：原型 `[data-project-list]` 三行的 `.td-side-icon` = `ORC`/`TD`/`SR`（= 前缀，P5）；实现 `Sidebar.vue` 渲染 `initialsOf(project.name)`（`web/src/lib/monogram.js`）。三个种子里两个巧合重合（`Orchestrator`→`ORC`、`Site Refresh`→`SR`），**只有 `MeerkatTaskPanel` 分叉**：原型 `TD`，实现 `MT`。另：原型**动态新建**的项目行**根本不渲染** `.td-side-icon`（提交处理器只拼 `name` + `count`）⇒ 原型自己也没把蒙版接进建项目流程。
- 归属：**正交于卡号前缀**（卡号前缀已由 §3 定死）；`BLOCKS.md §B03` 的措辞（「prefix monogram, rail only」）与本裁定**同向**，但改它要动 `monogram.js` + `Sidebar.vue` + `test/web/monogram.test.mjs` + 块契约里的 `[data-side-icon]` 规则。⇒ **建议单开一张卡**裁定「蒙版 = 前缀 还是 名字首字母」，本契约不改。

**E5 · §5 M4（空前缀项目拒绝）是**口径变更**。**
- 它推翻 `assertPrefixAvailable` 注释里**刻意的**让路。**需 Elon 确认**。确认前 C2 不得顺手改（否则等于代 Elon 定口径）。

**E6 · 卡面示例 `demo_x` 在 UI 里打不进去。**
- `demo_x` 6 字符 > 原型给字段的 `maxlength="4"`。本契约读作「`demo_x` 是归一化函数的说明例」（卡面 Acceptance ① 正是拿它举 `identifierPrefix` 的例子），**不是** UI 输入例。若 Elon 的原意是「UI 也要能输入 `demo_x`」，那就是**原型需改**（放宽 `maxlength` 并改写 `prefixHint` 文案），且要连带处理 §8 E2（6 字符里带 `_`）。**请 Elon 确认本读法。**

---

## 9. 机检断言清单（C2 落地后应全绿；D 腿需 `web/dist` + 浏览器）

### A · 源码静态（**宿主机允许**；纯 `grep`/`node --check` 级）

| # | 断言 | 命令/落点 |
|---|---|---|
| A1 | `POST /api/v1/projects` 的**声明**请求体含 `id`，且 handler **真的读**它 | `node scripts/verify/route-request.mjs --print`——**本轮已实测 PASS**：`body declared [id, labels, meta, name, readme]  reads [id, labels, meta, name, readme]`（§10 D 段）；快照 `test/fixtures/contract/api.snapshot.json` 同步收录 `id` |
| A2 | 建项目提交体**含 `id`** | `CreateProjectModal.vue` 的 `api.createProject(...)` 实参 |
| A3 | 提交体**不含 `meta`**（`meta.prefix` 写点归零） | 同上 |
| A4 | `meta.prefix` 在 `src/**` + `web/src/**` **零读点** | `grep -rnE "\.prefix\b\|meta\[['\"]prefix" src web/src` |
| A5 | 归一化函数**只有一份** | `identifierPrefix` 的定义点只有 `src/shared/ids.mjs`；`web/**` 内不得出现折叠非字母数字的正则 |
| A6 | `canSubmit` 以 `name` **与** `prefix` 皆非空为条件 | `CreateProjectModal.vue` 的 `canSubmit` |
| A7 | 原型未被动过 | `git diff --stat -- design/prototype` 为空 |
| A8 | `PATCH /api/v1/projects/:id` **不接受** `id`（前缀不可改，M6） | `node scripts/verify/route-request.mjs --print`——**本轮已实测**：`body declared [labels, meta, name, readme]`（无 `id`）；本契约落地后仍须为空 |

### B · 纯函数（**宿主机允许**，无浏览器无服务）

| # | 断言 |
|---|---|
| B1 | `identifierPrefix("demo_x") === "DEMO-X"` |
| B2 | `formatIdentifier("demo_x", 1) === "DEMO-X-0001"`；`identifierFor("demo_x", 1)` 同值 |
| B3 | `identifierPrefix(s) === s.toUpperCase()`，∀ `s ∈ [A-Za-z0-9]{1,4}`（1–3 字符穷举，4 字符抽样）——本轮实测 **842,234 例 0 不符** |
| B4 | `identifierPrefix("###") === ""` 且 `identifierFor("###", 1)` 抛 `VALIDATION_FAILED`（§5 的既有守卫仍在） |

### C · 容器内真跑（**必须 `npm run verify:docker` / `docker/verify-in-container.sh`**；本 lane **未跑**）

| # | 断言 | 预期 |
|---|---|---|
| C1 | `POST /api/v1/projects {id:"demo", name:"Demo"}` | 201/200，项目 `id === "demo"` |
| C2 | 该项目内建两张卡 | 卡号依次 `DEMO-0001`、`DEMO-0002` |
| C3 | 同 `id` 再来一次 | 409 `ID_CONFLICT` |
| C4 | `{id:"DEMO"}`（字面不同、归一化相同） | 400 `VALIDATION_FAILED` |
| C5 | `{id:"####"}`（**M4 新增**） | 400 `VALIDATION_FAILED`，且列表里查不到该项目——**实现前为红** |
| C6 | CLI 等价路径：`taskctl project create --id demo_x --name Demo` + 建卡 | `DEMO-X-0001` |

### D · 浏览器（宿主机允许；需 `web/dist` + 可启动浏览器，本 lane **未跑**）

| # | 断言 |
|---|---|
| D1 | 打开建项目弹窗，只填 name、prefix 留空 ⇒ **不发出** `POST /api/v1/projects`（拦截 `fetch` 断言调用次数为 0） |
| D2 | 填 prefix `demo` + name ⇒ 请求体 `{"id":"demo","name":…}`，且**无** `meta` 键 |
| D3 | 建完后当前项目第一张卡的 `[data-card-identifier]` 文本以 `DEMO-` 开头（端到端） |
| D4 | 关闭弹窗再打开 ⇒ 两个字段都清空（既有行为不回归） |

**不得断言**（负向注记）：不断言字段的 `pattern`/`inputmode`（本契约未约束字符集，§7.1）；不断言序号宽度（§8 E1 未决）；不断言侧栏短码值（§8 E4 未决）；不断言拒绝文案的字面（§6 M7：实现侧自撰）。

---

## 10. 证据与复跑

**A 段 · `identifierPrefix` / `formatIdentifier` 取值（实测，宿主机纯函数）**

```
$ node --input-type=module -e "import {identifierPrefix, formatIdentifier} from './src/shared/ids.mjs'; …"
"demo_x"            -> prefix "DEMO-X"            | id "DEMO-X-0001"
"DEMO_X"            -> prefix "DEMO-X"            | id "DEMO-X-0001"
"demo-x"            -> prefix "DEMO-X"            | id "DEMO-X-0001"
"TD"                -> prefix "TD"                | id "TD-0001"
"td"                -> prefix "TD"                | id "TD-0001"
"MeerkatTaskPanel"  -> prefix "MEERKATTASKPANEL"  | id "MEERKATTASKPANEL-0001"
"Site Refresh"      -> prefix "SITE-REFRESH"      | id "SITE-REFRESH-0001"
"ab_c"              -> prefix "AB-C"              | id "AB-C-0001"
"a.b"               -> prefix "A-B"               | id "A-B-0001"
"###"               -> prefix ""                  | id "-0001"      ← formatIdentifier 不校验；identifierFor 在此抛错
"--x--"             -> prefix "X"                 | id "X-0001"
"xxxxxxxx"          -> prefix "XXXXXXXX"          | id "XXXXXXXX-0001"
```

**B 段 · 等价域穷举（实测）**

```
$ node --input-type=module -e "… identifierPrefix(s) !== s.toUpperCase() …"
checked 842234 strings; mismatches: 0 []
```
（1–3 字符全量 238,328 + 4 字符定种子抽样 603,906，字符集 `[A-Za-z0-9]`）

**C 段 · `meta.prefix` 读点扫描（实测）**

```
$ grep -rnE "\.prefix\b|meta\[[\"']prefix|prefix\]" src/ web/src/
web/src/i18n/catalogue.mjs                      ← 2 处：i18n 键名（标签文案），非 meta
web/src/components/create/CreateProjectModal.vue ← 4 处：局部变量 form.prefix + 写入表达式 + 标签/输入
⇒ meta.prefix 的读点：0
```

**D 段 · 声明式请求体（实测，静态 lint）**

```
$ node scripts/verify/route-request.mjs --print
POST  /api/v1/projects
  body  declared [id, labels, meta, name, readme]   reads [id, labels, meta, name, readme]
PATCH /api/v1/projects/:id
  body  declared [labels, meta, name, readme]       reads [labels, meta, name, readme]
```
⇒ 两个结论都是**跑出来的**：① `id` **已声明且已被 read**（§3 的「零服务端改动」由此成立）；② `PATCH` **不接受 `id`** ⇒ 前缀创建后不可改（§6 M6）由 lint 直接背书。

**E 段 · 未跑的部分（明写，不圆）**

- 本 lane **未**运行 `taskd`、**未**构建 `web/dist`、**未**驱动浏览器、**未**进容器。§9 的 A 腿（除已注明的 A1/A4）与 B 腿在宿主机可复跑；C/D 两腿由 C2 落地时与 C3 验证时执行。
- 原型侧**未**驱动浏览器：§2 的五条是**实读**（符号级），不是实测。若 C3 要更强的证据，建议在宿主 Chromium 上按原型 P3 建一个 `zx` 前缀的项目再建卡，读回 `PROJ…`/`ZX-1` 与 `PROJECT_PREFIX`，并把原始输出附在其报告里。

**F 段 · 落笔范围（本轮改动清单）**

| 文件 | 动作 |
|---|---|
| `design/contracts/project-prefix-binding.md` | **新增**（本文件） |
| `design/README.md` | 目录树补一行 `contracts/`（2 行以内，非共享文件） |
| 其余（`DESIGN.md` / `BLOCKS.md` / `fidelity-*.md` / `design/prototype/**` / `web/**` / `src/**` / `test/**`） | **零改动**（原型侧改动提案见 §8，交 Elon） |
