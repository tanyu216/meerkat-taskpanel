# 建项目 prefix 字段 ↔ 卡号前缀 绑定契约 · C-PREFIX-1

> prefix 字段决定卡号前缀；**唯一口径 = 服务端把项目的 `meta.prefix` 规范化后存为项目前缀，铸号读它**；归一化只有一份（`identifierPrefix`）；老项目与 CLI 路径回退 `identifierPrefix(id)`。

> 卡：`T-20261014-003808`（goal：依原型冻结口径，裁定「建项目 prefix 字段」与「卡号前缀」的绑定，产出可实现、可验证的唯一契约。flow A 前置。）
> **裁定来源**：卡工作区 `design-spec.md`（负责 agent Jobs 的裁定 + 详细契约规格，本节 §3/§4 逐条落地它）。本文件是**执行方**把它写成的契约文档。
> 分工：**C1 = 本契约**（写面 `design/**`，**零实现**）→ **C2 = 实现**（Linus 另卡）→ **C3 = 独立验证**（Turing）。本文件是 C2/C3 的**唯一口径**。
> 路径选择（design-spec §4.1 允许执行方二选一/自择，并在 Report 说明）：**新建 `design/contracts/` 下的独立契约文档**，而非并入 `design/DESIGN.md` 的 B11 章节——理由：`DESIGN.md` 与 `BLOCKS.md` 正在被同仓另一 lane（`T-20261014-001418`）写入，独立文件把文件级冲突面降到零；`design/README.md` 的目录树已补 `contracts/` 一行。
> 事实源：原型 = `design/prototype/app.js`、`design/prototype/index.html`（**实读**，符号级；本 lane **未**驱动浏览器）；实现 = `web/src/components/create/CreateProjectModal.vue`、`web/src/services/api.js`、`web/src/components/shell/Sidebar.vue`、`web/src/lib/monogram.js`、`src/server/routes/projects.mjs`、`src/core/commands/projects.mjs`、`src/core/storage/repositories/projects.mjs`、`src/core/domain/task.mjs`、`src/shared/ids.mjs`、`src/shared/wire.mjs`（**实读未实测**）；归一化函数与路由请求面 = **实测**（纯函数 + 静态 lint，原始输出见 §10）。
> 基线 commit：`3bb992a`（= 本 lane 的开工点，= `main`）。
> 本文件为**新增文件**：未改动 `DESIGN.md` / `fidelity-*.md` / `design/prototype/**` 一行；`BLOCKS.md` 仅按 design-spec §4.2 补 §B11 一行（见 §10 F 段，冲突面已在 Report 点明）。

## 0. 结论摘要

- **① 裁定 = 是：建项目 modal 的 prefix 字段决定该项目的卡号前缀。** 唯一口径 = **服务端读 `meta.prefix`**：UI **保持**提交 `{ name, meta: { prefix } }`（**不改**发 `id`）；服务端在创建时把该值经 `identifierPrefix` 规范化后**存为该项目的卡号前缀**；铸号读**项目存的前缀**，不再直接由 `id` 推导。未提供前缀者（老项目、CLI 建的项目）**回退** `identifierPrefix(id)`——即存量行为不变。
- **② 可实现判据与示例见 §3.3 / §4 / §5 / §6 / §9**，登记落点 = 本文件 + `design/README.md` 目录树一行 + `design/BLOCKS.md` §B11 一行（design-spec §4）。
- **③ 不以实现反推原型。** §2 先取原型证据（符号级），原型立场「该字段 = 该项目的编号前缀」与本裁定**同向**；原型无「项目 id」这一概念，故本裁定在**机制**上是实现侧的选择（design-spec §1 已定），在**语义**上完全服从原型。
- **④ 原型该字段的语义 = 无需调整**（`design-spec.md` §3.2「不改原型行为」）。原型侧另有 6 处**与本裁定正交**的出入/遗漏，逐条列在 §8 交 Elon；本 lane **未改原型一行**。
- **一处必须先说的口径精度（卡面示例在原型上打不进）：** Acceptance ② 的例子 `prefix demo_x ⇒ 卡号 DEMO-X-0001` 里的 `demo_x` 是**归一化函数的例子**，**不是** UI 字段可输入的值——原型给该字段 `maxlength="4"`。`demo_x`（6 字符）只能来自 CLI/API。design-spec §5 已就此给出口径（推荐 (a)：**保留 ≤4**，卡面示例改为 ≤4 输入，如 `demo ⇒ DEMO-0001`），**需 Elon 签核**（§8 E6）。
- **实现面结论（供 C2 排期）**：改动面 = `src/core/commands/projects.mjs`、`src/core/storage/repositories/projects.mjs`、`src/core/domain/task.mjs`（铸号读项目前缀）+ `web/src/components/create/CreateProjectModal.vue`（必填、去掉冗余大写）+ 一处 wire/契约快照（§7.4，可随蒙版裁定推迟）。**建议零 migration**（见 §7.2）。

---

## 1. 口径与证据规则

**闭集词表（逐字使用，不得自创）**：`对齐` = 两侧**实测**同值；`一致` = 两侧书面/符号级同义（未实测）；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本文件不出现任何「文件 + 数字行号」形式的引用；卡面与 `design-spec.md` 里的行号仅供定位，不转录）。

**证据分级（每条结论必须能归入其中一级）**：

1. **实测**——真跑出来的：本轮 `identifierPrefix` / `formatIdentifier` 取值（纯函数，Node 直跑）、路由声明式请求体（`scripts/verify/route-request.mjs --print`）、`meta.prefix` 读点扫描（`grep`）。原始输出见 §10。
2. **实读**——逐符号读过源码/原型，未运行。
3. **实读未实测**——实现侧（`web/**`、`src/**`）的运行行为本轮一律属此级：本 lane 未构建 `web/dist`、未起 `taskd`、未驱动浏览器、未进容器。§7 的每条都是实读值，凡涉及运行时行为者在 §9 明标「C/D 腿未跑」。
4. **不伪造**：未跑的写「未跑」；原型侧未驱动浏览器者，不写「实测」。

---

## 2. 原型（oracle）证据——字段「就是」编号前缀

以下全部为**实读**（符号级），未跑浏览器：

| # | 位置 | 事实 |
|---|---|---|
| P1 | `design/prototype/app.js`：`PROJECT_PREFIX` 字面量 | `{ MeerkatTaskPanel: "TD", Orchestrator: "ORC", "Site Refresh": "SR" }`——**键 = 项目名，值 = 编号前缀**。种子本身即证明两者是**两个独立属性**：项目「MeerkatTaskPanel」的前缀是 `TD`，不是名字的任何缩写。 |
| P2 | `design/prototype/index.html`：`form[data-create-project-form]` | 两个输入 `[data-create-project-name]` 与 `[data-create-project-prefix]` **均带 `required`**；提示键 `createProject.field.prefixHint` =「Up to four characters, for example TD.」；`[data-create-project-prefix]` 带 `maxlength="4"`。 |
| P3 | `design/prototype/app.js`：`[data-create-project-form]` 的 `submit` 处理器 | 取 `[data-create-project-prefix]` 的值 → `$.trim(...).toUpperCase()`；守卫 `if (!name || !prefix) { focus(name); return; }`——**空前缀不建项目**；成功路径 `PROJECT_PREFIX[name] = prefix`（**前缀挂在项目上**），随后 `setProject(name)` 并提示。 |
| P4 | `design/prototype/app.js`：`nextIdentifier(project)` | `var prefix = PROJECT_PREFIX[project] \|\| "TD";` → 扫当前 DOM 里同前缀的卡取最大序号 → `return prefix + "-" + (highest + 1);`。由建卡路径调用（建卡时 `identifier: nextIdentifier(project)`）。 |
| P5 | `design/prototype/index.html`：`[data-project-list]` 三行 | 行文本 = 项目名（`.td-side-name`），而 `.td-side-icon` 的文本 = `ORC` / `TD` / `SR`——**即前缀**（`MeerkatTaskPanel` 的 `TD` ≠ 名字首字母；另两个是巧合重合）。 |

**原型立场，一句话**：建项目时的 prefix 字段 = **该项目的编号前缀**；必填；建完立刻参与编号（P4）；同一个值同时被当作项目在侧栏的短码（P5）。

**两点必须点名的原型细节**（下游别踩）：

1. 原型**没有「项目 id」这个实体**——项目在原型里以**名字**为键（`data-project` = 名字），前缀是它的一个**属性**（P1）。⇒ 本裁定选「前缀作为项目的独立属性、`id` 保持不透明」是**忠实于原型**的；「把用户短码塞进 id」反倒是原型里不存在的东西。
2. 原型**动态新建**的项目行**不渲染** `.td-side-icon`（P3 的提交处理器只拼 `name` + 计数）⇒ 原型自己也没把「前缀 → 侧栏短码」接进建项目流程。这条是 §8 E4 的证据。

---

## 3. 裁定

### 3.1 主裁定（唯一口径 = 服务端读 `meta.prefix`）

> **建项目 modal 的 `[data-create-project-prefix]` 字段决定该项目所有卡号的数字前缀，且唯一经由：字段值 → `meta.prefix` → 服务端规范化 → 项目前缀（存储）→ 铸号读取。**

数据流（`+` = 本轮新增，其余为既有设施）：

```
[data-create-project-prefix] ──(trim)──▶ POST /api/v1/projects { name, meta:{ prefix } }
                                              │   （UI 不变：仍然只发 name + meta.prefix）
                                  src/server/routes/projects.mjs : POST（既有：透传 body.meta）
                                              │
                                  src/core/commands/projects.mjs : createProject
                                              │   + M4：identifierPrefix(meta.prefix) === "" ⇒ 拒
                                              │   + 规范化并落库（§7.2）
                                              ▼
                                       项目前缀（每项目一条）
                                              │
                                  src/core/storage/repositories/projects.mjs : allocateIdentifier
                                              │   + 读「项目前缀」（缺省回退 identifierPrefix(id)）
                                              ▼
                                        卡号 = PREFIX-NNNN
```

**五条「必须」**：

- **M1｜UI 口径不变，不改发 `id`。** UI **保持**提交 `{ name, meta: { prefix } }`；`meta.prefix` 从「只写不读」变为**唯一前端入口**。（**不要**改成 `id`：项目 `id` 在实现里是不透明主键，被路由 `/api/v1/projects/:id`、`selectProject(id)`、SQL join、外键引用；把用户短码塞进主键是语义变更，且原型里 `id` 与 `prefix` 本就无此绑定——P1。）
- **M2｜服务端规范化，且只规范化一次。** 创建时把 `input.meta.prefix` 经 `identifierPrefix` 规范化后**存为该项目的前缀**（§7.2 给出两种落库形，建议 (i) 零 migration）。规范化**只发生在服务端**；UI **不得**再折叠一次（§4）。
- **M3｜铸号读项目前缀，不再由 `id` 推导。** `repositories.projects.allocateIdentifier` 取「项目前缀」；**有效前缀 = 项目存的前缀（非空）否则 `identifierPrefix(project.id)`**。⇒ 未提供前缀者（老项目、CLI 建的项目）**行为与今天逐字相同**（存量卡号不变，未来卡号也不变）。
- **M4｜空前缀必须拒绝。** 若 `identifierPrefix(input.meta?.prefix) === ""`（如 `####`），**拒绝创建**，`VALIDATION_FAILED`（HTTP 400），项目不得落库。理由与判据见 §5。
- **M5｜前缀唯一（跨两个来源）**：见 §6。

### 3.2 备选与拒绝理由（卡面点名的两条候选）

| 候选 | 判定 | 理由 |
|---|---|---|
| **(A) 服务端读 `meta.prefix`**（**采定**） | ✅ | ① UI **已经**发 `{name, meta:{prefix}}`、服务端 `createProject({meta})` **已经**把它落库（`meta_json`）⇒ 当前**唯一缺陷 = 铸号时不读它**，修法最小；② **项目 `id` 保持不透明**，路由/`selectProject`/SQL join/外键零影响；③ 与原型同构：**前缀是项目的一个属性**（P1），不是身份的载体；④ 存量与 CLI 路径靠「回退 `identifierPrefix(id)`」**逐字不变**。 |
| **(B) UI 提交 `id`** | ❌ | 把**用户输入的短码**变成主键：路由段、`selectProject(id)`、SQL join 全部改吃一个用户可控串；`id` 与 `prefix` 的语义纠缠（`id="demo"` 而前缀是 `DEMO`）需要处处二次解释；且与原型不符——原型里没有「id 即前缀」这回事。 |

> 说明（如实登记，不藏）：采纳 (A) 的**代价**是「同一条归一化规则、两个入口两种载体」——CLI 用 `--id`（id 即前缀来源），UI 用 `meta.prefix`（属性即前缀来源）。本裁定**接受该不对称**（收益是 `id` 保持不透明），并把不对称登记为下游注意项（§8 E7）。两条入口**共用同一个归一化函数**，这是不对称不致分叉的前提（§4）。

### 3.3 判定样例（可直接照抄进测试）

| 输入（UI 字段 / CLI `--id`） | 存的前缀 | 第 1 张卡 | 第 2 张卡 | 第 10 张卡 |
|---|---|---|---|---|
| `td` | `TD` | `TD-0001` | `TD-0002` | `TD-0010` |
| `TD` | `TD` | `TD-0001` | `TD-0002` | `TD-0010` |
| `or c` | `OR-C` | `OR-C-0001` | — | — |
| `demo_x`（**仅 CLI/API 可达**，UI 字段是 4 字符上限） | `DEMO-X` | `DEMO-X-0001` | `DEMO-X-0002` | `DEMO-X-0010` |
| 空（老项目 / CLI 建的项目 `--id demo`） | 回退 `identifierPrefix(id)` = `DEMO` | `DEMO-0001` | — | — |
| `####` | **必须拒绝**（§5 M4） | — | — | — |

前三行的**归一化结果**为**实测值**（§10 A 段，直跑 `identifierPrefix` / `formatIdentifier`）；`####` 行为是**新增口径**（§5）⇒ 实现前为红。

**两处对 `design-spec.md` §3.3 的修正（本文件以实测为准）**：
1. 该表把 `td` 的卡号示例写成 `TD-0007`。`next_task_number` 初值为 1，**新建项目的第一张卡是 `TD-0001`**；`0007` 是 fixture 里 `PROJ-0007` 的号，不属本口径。若该行本意是「项目已有 6 张卡」，须写明前提，否则测试会照它写错。
2. 该表「（空 / legacy）⇒ `identifierPrefix(id)`」**正确**，本契约把它提升为正式条款 M3（回退路径），并补上「存量行为逐字不变」的证据口径（§9 C 腿）。

---

## 4. 与归一化规则（`identifierPrefix`）的关系

**唯一归一化函数**：`src/shared/ids.mjs` `identifierPrefix`。实测语义（§10 A 段）：`trim` → `toUpperCase` → 把**非 `[A-Za-z0-9]` 的连续段**折叠为**一个** `-` → 去掉两端的 `-`。故：

- `identifierPrefix("demo_x")` = `DEMO-X`；`identifierPrefix("or c")` = `OR-C`；`identifierPrefix("td")` = `TD`（**三者均为实测值，与 `design-spec.md` §1 逐字一致**）。
- `identifierPrefix` 对**已规范化**的值**幂等**（`identifierPrefix("DEMO-X")` = `DEMO-X`）⇒ §6 的唯一性比较可以在两个来源上安全地直接比对。
- `identifierPrefix("###")` = `""`（空前缀，见 §5）；`identifierPrefix("--x--")` = `X`。
- 序号宽度**不变**：`IDENTIFIER_PAD` = 4，序号从 `projects.next_task_number`（初值 1）自增。**本契约不裁定序号宽度**（原型侧的不填充出入见 §8 E1）。
- `formatIdentifier(prefix, serial)` = `${prefix}-${serial 补 4 位}`。示例：前缀 `demo_x` ⇒ `DEMO-X-0001`。

**UI 侧不得再归一化一次（对 `design-spec.md` §3.2.2 的修正）**：design-spec 建议「UI 值发送前归一化：`identifierPrefix(form.prefix)`」。**该条无法按字面执行，且不应执行**：

- **做不到**：`web/src/**` 与 `src/**` 之间**没有**任何 import（实测：`grep` 全仓，`web/src` 内无 `src/shared` 引用）。UI 要调 `identifierPrefix` 只有两条路——把函数**抄一份**到前端（那就是**第二份归一化规则**，正是本仓已知的漂移类，参见 i18n catalogue 的三份镜像），或把 `src/shared` 打进前端包（跨层依赖，`web/` 与 `src/` 是两个构建）。
- **不必**：M2 规定服务端规范化一次。UI 交**原文**（`form.prefix.trim()`），服务端 `identifierPrefix` 一张口。
- ⇒ **本条落地为**：`CreateProjectModal.vue` **去掉**提交时的 `.toUpperCase()`（它与服务端的 `toUpperCase` 重复，且**永远无法**复现折叠与去边）。原型的 `.toUpperCase()`（P3）**不构成分歧**：仓库里 `identifierPrefix` 的第一步就是大写，且实测在 `[A-Za-z0-9]` 上 `identifierPrefix(s) === s.toUpperCase()`（**842,234 例，0 处不符**，§10 B 段）。

**含非字母数字的输入**（`ab_c` → 原型显示 `AB_C` vs 本口径 `AB-C`）不属上面这条等价域，是本轮发现的原型侧缺口，列 §8 E2 交 Elon。**本契约不放宽规则、也不改原型**。

---

## 5. 必备收口：空归一化前缀的「僵尸项目」

**事实（实读）**：`src/core/commands/projects.mjs` `assertPrefixAvailable` 的注释**明确**为空前缀让路（大意：「normalizes to the empty prefix (`###`) is left to the pre-existing guard in `identifierFor` … this check is about collisions, not emptiness, so it steps aside when the prefix is `""`」）；`repositories.projects.create` 不校验；`identifierFor` 到**第一张卡**才抛 `VALIDATION_FAILED`。

**为什么本裁定必须收口**：前缀未接入前，`meta.prefix` 无人读，项目永远靠 id 推前缀（UUID ⇒ 前缀必然非空），所以这条路径**不可达**；一旦按 M2 把前缀**存下来并参与铸号**，值 `####`（4 字符，`maxlength=4` 内、可打）会存下一个**空前缀**，项目此后**永远生不出卡**——板上的僵尸项目。**这是裁定自身引入的可达缺陷，必须由裁定关掉。**

**M4（新增）**：项目创建时，若 `identifierPrefix(input.meta?.prefix) === ""` 且 `meta.prefix` **确有提供**，**拒绝创建**，`VALIDATION_FAILED`（HTTP 400），项目不得落库。**未提供** `meta.prefix` 者不受此条约束（走 M3 回退，其空前缀由 `identifierFor` 的既有守卫兜底，两处不互相取代）。

- 实现落点（建议，C2 自定）：`src/core/commands/projects.mjs` `createProject` 内；`details` 建议 `{ field: "meta.prefix" }`。
- 覆盖面：UI 字段提交 `####`，以及 API/CLI 显式带 `meta.prefix` 的调用。
- ⚠️ 与 §5 的既有让路注释**冲突**：那条注释是**刻意的**。本契约把它收窄为「**只在未提供前缀时**让路」，即 `assertPrefixAvailable` 的让路语义保留、**新增**一个「提供了却不可用 ⇒ 拒」的守卫，两者并存不矛盾。

**判据（C 腿，§9）**：`POST /api/v1/projects {"name":"x","meta":{"prefix":"####"}}` ⇒ 400 `VALIDATION_FAILED`，且 `GET /api/v1/projects` 中**不存在**该项目——**实现前为红**。

---

## 6. 唯一性、不可变、拒绝面

- **M5｜前缀唯一（跨两个来源）**：两个项目只要**有效前缀**相同，在板上就不可区分（会各自发 `OPENCLAW-TEAM-0007`）⇒ 既有的 `assertPrefixAvailable` 必须**加宽**为：候选的**有效前缀** vs 每个既有项目的**有效前缀**（=`identifierPrefix(项目前缀 ?? 项目 id)`，归档项目也算，因为归档不退还前缀——它发出的标识符还在卡上）。`identifierPrefix` 的**幂等性**（§4）是这条能直接比对的前提。两种拒绝的边界要分清：与既有项目 `id` **字面相同** ⇒ `ID_CONFLICT`（409，主键）；**有效前缀相同而字面不同**（UI 前缀 `demo` vs CLI `--id demo`）⇒ `VALIDATION_FAILED`（400）。
- **M6｜前缀创建后不可改**：`PATCH /api/v1/projects/:id` 的声明请求体**无**前缀位（**实测**：`body declared [labels, meta, name, readme]`，§10 D 段）——注意 `meta` 是整体替换/合并语义，**若** C2 把前缀存在 `meta.prefix` 里，则 M6 需要一条**显式的不可变性规则**（PATCH 时忽略/拒绝改写 `meta.prefix`），否则用户能改前缀而存量卡号不跟着变。UI **不得**提供改前缀入口（原型亦无项目编辑界面，两侧`一致`）。
- **M7｜拒绝的呈现**：请求被拒时，**弹窗不关闭、不建项目、不提示成功**；错误文案属**实现侧**（`web/src/i18n/extra.mjs`），**本契约不造句**（设计轮不新增 i18n 键——`design/prototype/app.js` 的 `MESSAGES` 与两份 catalogue 镜像本轮**零改动**，见 §7.5）。可观测判据只到「失败可见、弹窗留守、无项目落库」。

---

## 7. 逐面口径（C2 的改动面清单）

### 7.1 `src/core/commands/projects.mjs` / 存储层（核心改动）

| # | 位置 | 要求 |
|---|---|---|
| 7.1.1 | `createProject` | 规范化 `input.meta?.prefix`（提供时），**M4** 校验，落库（§7.2） |
| 7.1.2 | `repositories.projects.create` | 接受并存下**项目前缀**（§7.2）；`id` 语义**不变**（无 `id` 仍铸 UUID） |
| 7.1.3 | `repositories.projects.allocateIdentifier` | 取**有效前缀** = 项目前缀（非空）否则 `identifierPrefix(project.id)`，再 `formatIdentifier(prefix, serial)` |
| 7.1.4 | `domain/task.mjs` `identifierFor` | 现签名 `(projectId, serial)` 以 id 推前缀 ⇒ 需要一个**按前缀铸号**的等价入口（新函数或加参），且**保留**「空前缀 ⇒ `VALIDATION_FAILED`」的守卫语义（M3 的回退路径依赖它） |
| 7.1.5 | `assertPrefixAvailable` | 按 **M5** 加宽为「有效前缀 vs 有效前缀」 |

### 7.2 前缀落在哪（**两种落库形，建议 (i)**）

- **(i) 存回 `meta.prefix`（规范化后的值）——建议。** 零 migration（`meta_json` 已存在）、零 schema 变更、`POST` 的**声明请求体不变**（`meta` 已在）、**契约快照不需更新**（§10 D 段实测：`POST /api/v1/projects` 的 `declared == reads == [id, labels, meta, name, readme]`，加一个读点不改变声明）。代价：把一个**身份性**的键放进「自由 meta」（`createProject` 头注说 meta 是 free-form）；契约必须显式声明 `meta.prefix` 是**保留键**（服务端所有，规范化后写入，客户端不可直接改）。
- **(ii) 新增一级列 `prefix`。** 语义更干净（身份不寄居 meta），代价是**一次 migration**（新版本号 + 迁移注册表 + pre-commit 的迁移校验和基线）与 wire/快照的连带改动。**只有在 Elon 明确要求时才选它**；本契约按 (i) 给出判据。

### 7.3 `web/src/components/create/CreateProjectModal.vue`（唯一必须改的前端文件）

| | 现状（实读） | 本契约要求 |
|---|---|---|
| 提交体 | `api.createProject({ name: form.name.trim(), meta: form.prefix.trim() ? { prefix: form.prefix.trim().toUpperCase() } : {} })` | `{ name, meta: { prefix: form.prefix.trim() } }`——**仍发 `meta.prefix`**（M1），**去掉 `.toUpperCase()`**（§4），字段必填后 `meta.prefix` **恒在**（不再有「空则不写 meta」的分支） |
| 可提交条件 | `canSubmit = form.name.trim() !== ""` | **`name` 与 `prefix` 皆非空**（原型 P2/P3：两个 input 都 `required`，守卫是 `if (!name || !prefix)`）⇒ 空前缀时**不发出请求** |
| 字段属性 | `maxlength="4"`，无 `pattern` | 保持 `maxlength="4"`（原型 P2）；**不加** `pattern`（本轮不约束字符集；非字母数字的后果见 §8 E2） |
| 清空时机 | 打开弹窗时清空两个字段 | 保持 |

### 7.4 wire / 契约快照

design-spec §3.1.5 要求「`GET/PATCH` 的 wire 投影把 `prefix` 一并回传（供 UI 展示）」。**实测**：今天**没有任何**面消费项目前缀（侧栏短码走的是 `web/src/lib/monogram.js` `initialsOf(project.name)`，不是前缀——见 §8 E4）。⇒ 本契约把它记为**条件条款**：
- 只在**侧栏短码裁定为「前缀」**（§8 E4）之后才需要；届时 `src/shared/wire.mjs` 加 `prefix` 字段，并**必须**同步刷新契约快照（`node scripts/verify/contract.mjs --update`）与 `shape_check` 的消费面，否则 `contract-gate` 红。
- 若 E4 裁定为「名字首字母」，则**不加**该键（省一次快照变更 + 一次消费面回归）。
- **已激活（2026-10-14，卡 `T-20261014-011936-4`）**：E4 已裁定为**前缀** ⇒ 该键**需要**加。语义由 `design/contracts/side-rail-short-code.md`（C-RAIL-1）§4 钉死：字段名 `prefix`、值 = **有效前缀**（非 `meta.prefix` 原样——legacy/CLI 项目的有效前缀是服务端派生值，客户端复现不了）、**只读**、须 `--update` 刷新快照与消费面（该节 R-W1–R-W3）。

### 7.5 i18n / 文案

`createProject.field.prefix`（「Identifier prefix」/「标识前缀」）与 `createProject.field.prefixHint`（「Up to four characters, for example TD.」/「最多四个字符，例如 TD。」）**保持原样**——它们已经描述的就是本裁定后的语义。本轮**不新增、不修改任何 i18n 键**（`design/prototype/app.js` 的 `MESSAGES`、`web/src/i18n/catalogue.mjs`、`test/web/i18n.catalogue.mjs` 三处镜像**零改动**）。C2 若需要「拒绝」文案，落在 `web/src/i18n/extra.mjs`（实现侧自撰），不进两份 catalogue。

---

## 8. 与原型/卡面示例的出入、未决项（**交 Elon**；本 lane 未改原型一行）

> 依据 Acceptance ③④ 与 design-spec §5：以下各项**均正交于**「字段 ↔ 卡号前缀」的绑定裁定（绑定口径已由 §3 独立成立）。逐项给「现状 / 证据 / 建议 / 归属」，**不自行发散、不自行改原型**。同仓另有 lane（`T-20261014-001418`）正在写 `design/DESIGN.md`、`design/BLOCKS.md`、`design/fidelity-r8.md`、`design/fidelity-r12.md`、`design/prototype/app.js`——本节内容**一律不落笔到那些文件**（`BLOCKS.md` §B11 的登记只加一行，见 §10 F 段），正是为了不与之抢面。

**E1 · 序号宽度：原型不填充，卡面示例与实现都填充。**
- 现状：原型**静态种子** `TD-112 … TD-134`（不填充），运行时 `nextIdentifier` 也 `prefix + "-" + (highest + 1)`（不填充）；但同一原型里另有 `PROJ-0007`（9 字符，填充）——它是 R8「8 字符 + `…`」截断契约的**唯一种子**。卡面 Acceptance ② 的例子 `DEMO-X-0001` 是**填充**形。
- 立场：**本契约按 `IDENTIFIER_PAD`=4（填充）执行**（与卡面示例、与实现现状、与存量卡号一致），并**明确记录**原型侧的不填充。**不裁定**（绑定口径与序号宽度正交）。
- 若照原型改成不填充：R8 的截断样本 `PROJ-0007` 会失去唯一触发点（`TD-134` 只有 6 字符），R8 的机检与 `test/web/identifier.test.mjs` 的边界样本都要重排 ⇒ **代价大于收益，建议维持填充**。

**E2 · 归一化覆盖面：原型只大写，本口径会折叠非字母数字。**
- 现状（**实测**，§10 B 段）：在 `[A-Za-z0-9]` 上二者**完全一致**（842,234 例 0 不符）；含其它字符时不一致——`ab_c`：原型 `AB_C`，本口径 `AB-C`；`a.b`：原型 `A.B`，本口径 `A-B`；`-ab-`：原型 `-AB-`，本口径 `AB`。
- 归属：这是**原型侧没有实现归一化**的缺口（设计基线只做 `toUpperCase`），非本裁定引入。
- 建议：**默认按 `identifierPrefix`**（design-spec §1 也已采定同一函数），原型不改即可实现。若产品要「前缀 = 原样大写」，那才是**「原型需改」**（把 `PROJECT_PREFIX[name] = prefix` 改为折叠非字母数字 + 去边），理由须写清：否则 CLI 与 UI 会各有一套规则。**交 Elon 择一。**

**E3 · 重复前缀：原型允许，实现拒绝（实现更严）。**
- 现状：原型 `nextIdentifier` 只看当前项目 DOM，两个项目取同一前缀不会被拦（P3/P4）；实现侧 `assertPrefixAvailable` 拒绝。
- 归属：**原型的遗漏**，非需求矛盾 ⇒ 按 Acceptance ③ 不需回 Elon，**保留实现侧更严的行为**。记录于此以免下游误读为「实现对不齐原型」。

**E4 · 侧栏短码（`.td-side-icon`）：原型是「前缀」，实现是「名字首字母」。**
- 现状：原型 `[data-project-list]` 三行的 `.td-side-icon` = `ORC`/`TD`/`SR`（= 前缀，P5）；实现 `Sidebar.vue` 渲染 `initialsOf(project.name)`（`web/src/lib/monogram.js`）。三个种子里两个**巧合重合**（`Orchestrator`→`ORC`、`Site Refresh`→`SR`），**只有 `MeerkatTaskPanel` 分叉**：原型 `TD`，实现 `MT`。另：原型**动态新建**的项目行根本不渲染该 span（§2 细节 2）。
- 归属：**正交于卡号前缀**（卡号前缀已由 §3 定死）；`BLOCKS.md §B03` 的措辞（「prefix monogram, rail only」）与本裁定**同向**，但改它要动 `monogram.js` + `Sidebar.vue` + `test/web/monogram.test.mjs` + 块契约里的 `[data-side-icon]` 规则，**并触发 §7.4 的 wire/快照变更**。⇒ **建议单开一张卡**裁定「蒙版 = 前缀 还是 名字首字母」，本契约不改。
- **已裁定（2026-10-14，卡 `T-20261014-011936-4`）：口径 = 前缀。** 唯一口径见 `design/contracts/side-rail-short-code.md`（C-RAIL-1）；实现侧 `initialsOf(name)` 是偏离，另卡修正。上文「实现 `MT`」的**字面值**经实测更正为 **`MEE`**（两侧种子名都无空格，该契约 §0 ④ / §9 A 段），分叉的存在不变。

**E5 · M4（空前缀拒绝）收窄了 `assertPrefixAvailable` 的既有让路。** 本契约只把让路限定在「未提供前缀」的情形，并新增「提供了却不可用 ⇒ 拒」。这是对既有**刻意**注释的收窄（不是推翻），**请 Elon 确认**；未确认前 C2 不得顺手改（否则等于代 Elon 定口径）。

**E6 · 卡面示例 `demo_x` 在 UI 里打不进去（design-spec §5 的开放项）。**
- `demo_x` 6 字符 > 原型给字段的 `maxlength="4"`。本契约读作「`demo_x` 是归一化函数的说明例」（卡面 Acceptance ① 正是拿它举 `identifierPrefix` 的例子），**不是** UI 输入例。design-spec §5 推荐 **(a) 保留 ≤4、把卡面示例改为 ≤4 输入**——本契约按 (a) 落文档（§3.3 用 `td` / `or c` / `demo` 作可输入示例，`demo_x` 保留为 API/CLI 例）。
- 备选 (b)：放宽 `maxlength` 支持 `DEMO-X` 这类多段前缀 ⇒ **原型需改 + 实现需改**，须 Elon 批准。**请 Elon 签核 (a)。**

**E7 · 「同一条规则、两个入口两种载体」的不对称（如实登记）。**
- CLI `project create --id demo` 以 **id** 为前缀来源；UI 以 **`meta.prefix`** 为前缀来源。两者共用 `identifierPrefix`，靠 **M5** 的有效前缀比较保证不撞号。
- 归属：design-spec §1 已接受该不对称（收益 = `id` 保持不透明）。此处登记为下游注意项：**任何**新增的建项目入口（脚本、导入、md 迁移）必须显式选一边，不得引入第三套。

---

## 9. 机检断言清单（C2 落地后应全绿；C/D 腿本轮未跑）

### A · 源码静态（**宿主机允许**；纯 `grep` / 静态 lint）

| # | 断言 | 落点/命令 |
|---|---|---|
| A1 | `POST /api/v1/projects` 的声明请求体含 `meta`，且 handler 真的读它（M2 的前置） | `node scripts/verify/route-request.mjs --print`——**本轮已实测 PASS**：`declared [id, labels, meta, name, readme] reads [id, labels, meta, name, readme]`（§10 D 段） |
| A2 | UI 提交体**仍含** `meta.prefix`、**不含** `id`（M1） | `CreateProjectModal.vue` 的 `api.createProject(...)` 实参 |
| A3 | UI 提交体**不再**出现 `.toUpperCase()`（§4） | 同上 |
| A4 | `canSubmit` 以 `name` **与** `prefix` 皆非空为条件 | `CreateProjectModal.vue` 的 `canSubmit` |
| A5 | 归一化函数**只有一份** | `identifierPrefix` 定义点只有 `src/shared/ids.mjs`；`web/src/**` 内不得出现折叠非字母数字的正则 |
| A6 | 铸号路径不再直接由 `id` 推前缀（M3） | `repositories.projects.allocateIdentifier` 读项目前缀 + 回退分支；`identifierFor` 不再是唯一入口 |
| A7 | `meta.prefix` 的唯一读点是**服务端**（M2/M3/M5） | `grep -rnE "\.prefix\b\|meta\[['\"]prefix" src web/src`——本轮基线：`src/**` **0 读点**（§10 C 段） |
| A8 | `PATCH` 仍不接受前缀位（M6 的前置） | `route-request --print`——**本轮已实测**：`declared [labels, meta, name, readme]`（§10 D 段）。若前缀存 `meta.prefix`，**另需**一条显式的「PATCH 不改 `meta.prefix`」实现与测试（M6） |
| A9 | 原型未被动过 | `git diff --stat -- design/prototype` 为空 |

### B · 纯函数（**宿主机允许**，无浏览器无服务）

| # | 断言 |
|---|---|
| B1 | `identifierPrefix("demo_x") === "DEMO-X"`；`identifierPrefix("or c") === "OR-C"`；`identifierPrefix("td") === "TD"` |
| B2 | `formatIdentifier("DEMO-X", 1) === "DEMO-X-0001"`（补零 4 位） |
| B3 | `identifierPrefix` **幂等**：`identifierPrefix(identifierPrefix(s)) === identifierPrefix(s)`（M5 直接比对的前提） |
| B4 | `identifierPrefix(s) === s.toUpperCase()`，∀ `s ∈ [A-Za-z0-9]{1,4}`——本轮实测 **842,234 例 0 不符** |
| B5 | `identifierPrefix("###") === ""`，且 `identifierFor("###", 1)` 抛 `VALIDATION_FAILED`（M3 回退路径的既有守卫仍在） |

### C · 容器内真跑（**必须 `npm run verify:docker` / `docker/verify-in-container.sh`**；本 lane **未跑**）

| # | 断言 | 预期 |
|---|---|---|
| C1 | `POST /api/v1/projects {name:"Demo", meta:{prefix:"demo"}}` | 200/201；项目落库 |
| C2 | 该项目内建两张卡 | 卡号依次 `DEMO-0001`、`DEMO-0002` |
| C3 | **回退**：`POST` 一个不带 `meta.prefix` 的项目（等价 CLI `--id demo`），再建卡 | `DEMO-0001`——**存量/CLI 行为逐字不变** |
| C4 | **撞号**：既有 `--id demo` 的项目，再 UI 建 `meta.prefix:"demo"` | 400 `VALIDATION_FAILED`（M5，有效前缀相同） |
| C5 | 同 `id` 重复创建 | 409 `ID_CONFLICT` |
| C6 | `{name:"x", meta:{prefix:"####"}}`（**M4 新增**） | 400 `VALIDATION_FAILED`，且列表里查不到该项目——**实现前为红** |
| C7 | 存量回归：老项目（UUID id、无前缀）建卡 | 卡号前缀仍 = `identifierPrefix(UUID)`，与升级前逐字相同 |
| C8 | CLI 等价：`taskctl project create --id demo_x --name Demo` + 建卡 | `DEMO-X-0001` |

### D · 浏览器（宿主机允许；需 `web/dist` + 可启动浏览器，本 lane **未跑**）

| # | 断言 |
|---|---|
| D1 | 打开建项目弹窗，只填 name、prefix 留空 ⇒ **不发出** `POST /api/v1/projects`（拦截 `fetch`，调用次数 0） |
| D2 | 填 prefix `demo` + name ⇒ 请求体 `{"name":…,"meta":{"prefix":"demo"}}`，**无** `id` 键、**无** 大写改写（原文） |
| D3 | 建完后当前项目第一张卡的 `[data-card-identifier]` 文本以 `DEMO-` 开头（端到端） |
| D4 | 关弹窗再开 ⇒ 两字段清空（既有行为不回归） |

**不得断言**（负向注记）：不断言字段的 `pattern`/`inputmode`（本轮不约束字符集，§7.3）；不断言序号宽度（§8 E1 未决）；不断言侧栏短码值（§8 E4 未决）；不断言拒绝文案字面（§6 M7）；不断言 `prefix` 在 wire 上（§7.4 条件条款）。

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
"###"               -> prefix ""                  | id "-0001"   ← formatIdentifier 不校验；identifierFor 在此抛错
"--x--"             -> prefix "X"                 | id "X-0001"
"xxxxxxxx"          -> prefix "XXXXXXXX"          | id "XXXXXXXX-0001"
```
（`or c` → `OR-C` 亦实测同值。）

**B 段 · 等价域穷举（实测）**

```
$ node --input-type=module -e "… identifierPrefix(s) !== s.toUpperCase() …"
checked 842234 strings; mismatches: 0 []
```
（1–3 字符全量 238,328 + 4 字符定种子抽样 603,906，字符集 `[A-Za-z0-9]`）

**B′ 段 · 幂等性穷举（实测；M5 直接比对的前提，对应 §9 B3）**

```
$ node --input-type=module -e "… identifierPrefix(identifierPrefix(s)) !== identifierPrefix(s) …"
idempotence checked 11110 strings; violations: 0 []
```
（1–4 字符全量，字符集 `a b _ - . <空格> X # 9 Z`——刻意含 `_`、`.`、空格、`#`、两端 `-` 等会触发折叠/去边的字符）

**C 段 · `meta.prefix` 读点扫描（实测）**

```
$ grep -rnE "\.prefix\b|meta\[[\"']prefix|prefix\]" src/ web/src/
web/src/i18n/catalogue.mjs                        ← 2 处：i18n 键名（标签文案），非 meta
web/src/components/create/CreateProjectModal.vue  ← 4 处：局部变量 form.prefix + 写入表达式 + 标签/输入
⇒ meta.prefix 读点：src/** 与 web/src/** 均为 0（本契约 M2/M3 要把它变成**服务端**的读点）
```

**D 段 · 声明式请求体（实测，静态 lint）**

```
$ node scripts/verify/route-request.mjs --print
POST  /api/v1/projects
  body  declared [id, labels, meta, name, readme]   reads [id, labels, meta, name, readme]
PATCH /api/v1/projects/:id
  body  declared [labels, meta, name, readme]       reads [labels, meta, name, readme]
```
⇒ 三个结论都是**跑出来的**：① `meta` **已声明且已被 read** ⇒ M2/M3 不需要改请求声明、**不需要改契约快照**；② `PATCH` **不接受前缀位** ⇒ M6 需**单独**一条「PATCH 不改 `meta.prefix`」的规则（若选 §7.2 (i)）；③ `id` 已声明且已 read，但 M1 明确**不使用**它（保持 UUID 铸造）。

**E 段 · 未跑的部分（明写，不圆）**

- 本 lane **未**运行 `taskd`、**未**构建 `web/dist`、**未**驱动浏览器、**未**进容器。§9 的 A 腿（除已注明者）与 B 腿在宿主机可复跑；C/D 两腿由 C2 落地时与 C3 验证时执行。
- 原型侧**未**驱动浏览器：§2 的五条是**实读**（符号级），不是实测。若 C3 要更强证据，建议在宿主 Chromium 上按 P3 建一个 `zx` 前缀的项目再建卡，读回 `PROJECT_PREFIX` 与该卡 identifier，并把原始输出附在其报告里。
- 本契约**未**验证任何存量数据的分布（例如 `meta.prefix` 是否已在某个本地库里被写过）。C2 的 C7 腿即是这条的回归位。

**F 段 · 落笔范围（本轮改动清单）**

| 文件 | 动作 |
|---|---|
| `design/contracts/project-prefix-binding.md` | **新增**（本文件） |
| `design/README.md` | 目录树补一行 `contracts/` 及一段说明（非共享文件，零冲突面） |
| `design/BLOCKS.md` | **仅** §B11 补一行原型登记（design-spec §4.2）；⚠️ 该文件正被 lane `T-20261014-001418` 写入，**冲突面已在 Report 点明** |
| 其余（`DESIGN.md` / `fidelity-*.md` / `design/prototype/**` / `web/**` / `src/**` / `test/**`） | **零改动**（原型侧改动提案见 §8，交 Elon） |
