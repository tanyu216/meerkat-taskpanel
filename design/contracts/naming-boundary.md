# 框架名 / 产品名边界契约 · C-NAME-1

> **唯一口径**：**产品对外契约名必须是产品自有的**——`taskctl` CLI 面 + board wire（`src/foundation/wire.mjs`）+ 契约快照代号 `schema_version`。框架词只可在 **① 指针 / ② 兼容声明 / ③ 溯源** 三种角色下出现，且**任何角色下都不得充当产品自有契约的名字**；框架**内部机制名**（外部协议文档名、`task-ops`、`redlines`、框架内部文件/符号/花名册）**不得进入产品契约与对外文档**。

> 卡：`T-20261014-011057-2`（goal：裁定 `task-interface v1` 等 openclaw-team 框架名在产品仓的可用边界。范围 = operator 2026-10-14 拍板的 **(B) 命名耦合**。）
> **裁定来源**：卡面 Background 的三问（① `task-interface` 作产品对外契约名是否合法；② 哪些框架内部名不得进产品契约/文档；③ 跨仓发版说明类引用如何标注方可保留）+ Acceptance ③ 的事实源口径。本文件是**执行方的落文**，不是新裁定。
> 分工：**本卡 = C1**（写面 `design/**`，**零实现**）→ 后续**清理卡 = C2**（Linus，按 §4 逐类处置 + §7 分批）→ **独立验证 = C3**（Turing，按 §4 每条的「判据」核落点）。本文件是 C2/C3 的**唯一口径**。
> 事实源（**实读**）：`src/shared/wire.mjs`、`src/shared/constants.mjs`、`src/core/domain/enums.mjs`、`src/core/domain/idem.mjs`、`src/core/commands/tasks.mjs`、`src/cli/index.mjs`、`test/fixtures/contract/api.snapshot.json`、`docs/contract.md`、`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`skills/meerkat-loop/**`、`skills/meerkat-taskpanel/**`、`install.sh`、`scripts/install/**`（**实读未实测**）；框架侧的协议文档与接口合同（**实读**，仓库外，路径不入仓）。
> 定位规则：一律「**文件**」或「**文件:符号**」；散文类文件以**引文**定位，**不使用行号锚**（行号会随任何一次编辑漂移）。
> 基线 commit：`61f7f3a`（= 本 lane 工作树 HEAD = `main` HEAD，开工时实测同一 sha）。
> 本文件为**新增文件**：不改任何代码；`design/README.md` 仅按 `C-PREFIX-1` 先例补一行登记（见 §8）。**未 push**（§10）。

> **⛔ 已退役（2026-10-17）。** 本裁定 2026-10-14 由 C1 落文，**§8 的双签从未取得，C2（清理）从未开工，C3（独立验证）从未执行**。2026-10-17 复核：其 §7 独立判据 ④⑤ PASS、**①②③ FAIL** —— 外部协议文档名的落点由本文件记录的 6 个文件涨到 **29 个**（约 13 个在已发布面）；`src/shared/**` 与 `src/core/domain/enums.mjs` 的 `task-interface` 未清零；`task-ops` 全仓非 0，命中全在本文件与其登记行。operator 2026-10-17 裁定 **退役并收窄**：不执行 §7 的 P0/P1/P2，把 ①②③ 换成本文件 §7.1 的**现状表**，只有 §7.2 的**两条禁令**继续生效并由 `scripts/verify/signposts.mjs` 机械执行。
>
> **随之作废**：§2 的计数与文件清单锚在 `61f7f3a`（现落后 `dev` HEAD 数百个提交），只作当时的快照；§4 里 `plugins/**` 的全部生成副本目标（12 + 8 + 4 份）**在今天的树上不存在** —— `plugins/` 已由 `39a009d` 整目录删除，`skills/` 是仓库里唯一的 skills 树；§10 的 lane 分支持已消失。**§2–§6 保留为历史落点盘点，不再是工单。**
>
> **2026-10-20 后续**：OpenClaw 专用的 markdown 卡片导入器已整块移出产品 —— `src/core/storage/md/{import,migrate-cli,project-registry,invariants-check}.mjs`、`scripts/migrate/**`、`docker/migrate-in-container.sh`、`test/migrate/**` 均已删除，`docs/migration.md` 只保留 schema 迁移闸门与 MCP 移除记录。因此本文件 §2/§4/§7 中锚在 `project-registry.mjs`、`docs/migration.md` 的 `__team__` 段或 `test/migrate/**` 的行**只作历史记录**；当前事实源已不含这些文件。
>
> **2026-10-22 后续**：外部协议文档名的树内引用已清除 —— SLA 契约内化（`a4cc5e4`）后，`threshold_ref` 指向 `docs/sla.md` §2；本次又把 §①/§㉙ 等逻辑引用改指产品自有源码/文档。§7.1 的旧「R2 / 已发布接口数据」判定随之作废；本文件只在 §9 的原始输出中保留该词作历史证据。**门禁未改**：`scripts/verify/signposts.mjs` 仍不机械拦截该词，本次按「只清文件」执行。

---

## 0. 结论摘要

- **① 裁定 = 否：`task-interface` 不得作为产品的对外契约名。** 它是 **openclaw-team 的 ACL 代号**（框架侧的接口合同，版本记于该文件 §13），产品只是它的**参考实现（reference implementation）**。产品的对外契约名自有的那一套（`taskctl` / board wire / `schema_version`）**已经在位**（§5 实测），因此这是**纠正自述**，不是新建命名。
- **① - 补：但 `task-interface v1` 可保留，且只保留在一个角色上 = 「兼容声明」。** 它陈述「本产物绑定框架 ACL 的哪一代」，只挂在**框架侧产物**（loop skill 及其 references / `board-check.mjs`）上，并**始终带归属**。这与 Acceptance ③「框架侧只保留 ACL 最小必需集 + 指针」是同一句话的两种说法。
- **② 判据 = 三轴四条**（§3）：**J1 归属**（这个词命名的是产品自己的东西，还是别人家的东西）→ **J2 角色**（别人家的东西，在此处扮演 指针 R1 / 兼容声明 R2 / 溯源 R3 中的哪一个）→ 都不属三者且指向**框架内部机制**者 = **F1 泄漏**；**J3 事实源**（框架规范与产品 schema 同时描述一个形状时，产品 schema 是事实源，框架侧只放指针）。
- **③ 逐类处置见 §4**（保留 / 改名 / 加标注，逐文件可执行）。一句话版本：**`openclaw-team` 指针类全保留**；**`task-interface` 分五个子角色**（兼容声明保留、自述改标注、自有 schema 改名、溯源改写、测试锁保留）；**外部协议文档名六处全改写**（F1）；**`task-ops` 零落点 + 立禁**。
- **④ 两处必须先说的精度：**
  1. **卡面基线与本 lane 实测有差**：`openclaw-team` **39 → 40 文件**、`task-ops` **1 → 0 文件**（§2）。`main` 在 Elon 排查与本 lane 开工点之间前进了。本文件一律以 `61f7f3a` 的实测为准。
  2. **`task-interface v1` 在产品里没有任何机器表示**：`git grep` 在 `src/server`、`src/cli`、`web/`、`scripts/verify` 全零命中；loop 的闸门读的是 board 自有的 `version` + `schema_version`（§5）。⇒ **命名耦合是纯散文层的**，这也正是本裁定可以把「保留作兼容声明」与「不得作产品契约名」同时说圆的原因。
- **⑤ 双签（Acceptance ③「Elon / operator 双签」）本 lane 未取**——它是本卡的完成条件，不是执行方可以自我满足的动作。签名栏与待答问题见 §8。

---

## 1. 口径与证据规则

**闭集词表（逐字使用，不得自创）**：

| 词 | 含义 |
|---|---|
| **指针** | 引用**外部产物的身份**（项目名 / 仓库 URL / 公共规范路径 + 章节），目的是让读者**找得到**它。 |
| **兼容声明** | 陈述「本产物绑定外部接口的**哪一代**」，并给出机器可核的**版本地板**。 |
| **溯源** | 在**源码注释**里引用外部规范作为**非规范性**的设计由来。 |
| **泄漏** | 框架**内部机制名**（既非接口、也非产品暴露/消费对象的实现细节）以**规范性**姿态进入产品契约或对外文档。 |
| **自述** | 产品用自己的话描述**自己的**对外面（CLI 面 / wire / 版本）。 |
| **归属** | 引用外部词时，同处**明示**它是别人家的（链接、路径，或显式「the X framework」）。 |
| **落点** | 该处置要改的**文件**（或 `文件:符号`）。 |
| **生成副本** | `plugins/*/skills/**` 与 `skills/meerkat-loop/{body,templates}/`——由 `scripts/sync-skills.mjs` / `scripts/sync-loop.mjs` 生成，**手改即 drift**（CI `check:skills` 红）。 |

**证据分级（每条结论必须能归入其中一级）**：

1. **实测**——本轮真跑出来的：四类词的**文件计数**与**文件清单**（`git grep -l`，§9）、`CONTRACT_SCHEMA_VERSION` / `package.json` 版本号（`grep`）、`taskctl --version --json` 的**产出串扫描**（`git grep` 在机器面零命中）。
2. **实读**——逐符号读过源码 / 规范，**未运行**。
3. **实读未实测**——凡涉及**运行时行为**者：本 lane 未构建 `web/dist`、未起 `taskd`、未跑 CLI、未进容器。§4 的每条处置都是**文本层**的，不依赖运行行为。
4. **不伪造**——未跑的一律写「未跑」；框架侧文件在**仓库外**的一次性工作区里（路径不入仓），本 lane 只**实读**，未修改、未纳入版本控制。

---

## 2. 现状实测（基线 `61f7f3a`）

> ⚠️ **本节是 `61f7f3a` 的快照，不是现状**（2026-10-17 复核：四类词的落点与计数均已变化；`plugins/**` 一栏整体作废 —— 该目录已删除）。不要按本节的数字或清单安排任何工作。

四类词在**受版本控制文件**中的落点（`git grep -l`，含 `plugins/**` 生成副本；`.data/`、`node_modules/`、`dist/` 为忽略目录，不计）：

| 类 | 卡面（Elon 排查） | 本 lane 实测 | 差 |
|---|---|---|---|
| `task-interface` | 37 文件 | **37 文件** | — |
| `openclaw-team` | 39 文件 | **40 文件** | +1 |
| 外部协议文档名 | 6 文件 | **6 文件** | — |
| `task-ops` | 1 文件 | **0 文件** | −1 |

**按「自撰（作者区）/ 生成副本（`plugins/**` + `skills/meerkat-loop/body/**`）」切分**（切法依据 CLAUDE.md「skills 是生成物，绝不手改」：作者区 = `skills/meerkat-taskpanel/**` + loop skill 的 `SKILL.md` / `references/` / `scripts/board-check.mjs`）：

| 类 | 自撰 | 生成副本 |
|---|---|---|
| `task-interface` | **17**：`README.md`·`README.zh-CN.md`·`CHANGELOG.md`·`skills/meerkat-taskpanel/{SKILL.md,references/cli.md}`·`skills/meerkat-loop/{SKILL.md,references/operation.md,scripts/board-check.mjs}`·`src/core/README.md`·`src/core/domain/{enums.mjs,idem.mjs}`·`src/shared/{README.md,status-alias.mjs,wire.mjs}`·`test/{cli/output.test.mjs,core/domain/idem.test.mjs,skill/loop.test.mjs}` | **20**（全部在 `plugins/**`） |
| `openclaw-team` | **23** | **17**（`plugins/**` 16 + `skills/meerkat-loop/body/src/shared/constants.mjs` 1） |

> 生成副本的**传播面**（实测：`check:skills` 报 8 条 skill 同步）：loop skill → `plugins/{claude,codex,pi,loop}/skills/meerkat-loop/**`；board skill → `plugins/{claude,codex,openclaw,pi}/skills/meerkat-taskpanel/**`；loop payload → 同名 4 份 `…/meerkat-loop/body/**`。任一改动落在**源**上，这些副本随 `sync-skills.mjs` 重写。

**两条差异的归因（不猜，只记事实）**：`task-ops` 归零说明该引用在 `main` 前进时已被清掉（本 lane 未做任何清理）；`openclaw-team` +1 说明新增了一处引用。两者都指向同一结论：**卡面的计数是某一次排查的快照，本文件的每条处置都必须以文件为锚，不能以计数为锚**。

外部协议文档名的六处落点（全部为**实读**；下表「现文」引文中的专名已统一记为「外部协议文档」，原始行可用 `git show 61f7f3a:<path>` 复现）：

| # | 落点 | 是否随 npm 发布 | 现文 |
|---|---|---|---|
| 1 | `docs/migration.md`（「The reserved `__team__` project」段）**（随 importer 删除）** | **是**（`docs` 在 `package.json#files`） | `__team__` is the reserved **team-internal** project (外部协议文档 §②): … |
| 2 | `src/core/README.md` | **是**（`src` 在 `files`） | L1 reading: 外部协议文档 §㉙ + `guides/task-interface.md §14`. |
| 3 | `src/core/domain/idem.mjs`（模块注释） | **是** | L1 reading: 外部协议文档 §㉙ + `guides/task-interface.md §14`. |
| 4 | `src/core/storage/md/project-registry.mjs`（`BUILDIN_PROJECTS` 注释）**（文件已删除）** | **是** | `__team__` is the reserved team-internal project (外部协议文档 §②: …) |
| 5 | `test/core/domain/idem.test.mjs` | 否（`test` 不在 `files`） | L1 reading: 外部协议文档 §㉙ + `guides/task-interface §14`. |
| 6 | `test/migrate/import-hardening.test.mjs`（describe 名）**（已删除）** | 否 | … the buildin `__team__` project (外部协议文档 ②) |

**「随 npm 发布」这一列是本表的关键**：`package.json#files` = `src` / `skills` / `plugins` / `scripts` / `docs` / `install.sh` / 三个根散文。⇒ 上表 1–4 **是** npm 包的对外面，5–6 只面对**仓库读者**。

---

## 3. 边界轴与判据

### 3.1 一句话的边界

**「产品说自己的事」用产品的名字；「产品说别人家的事」才可以用别人家的名字，且必须让读者一眼看出那是别人家的。**

### 3.2 判据（按序应用，先 J1 后 J2）

**J1 归属**——这个词命名的东西，**归谁所有**？

- **归产品**（产品的 CLI 面 / 产品铸造的 wire / 产品的发布号 / 产品自己的保留项目）⇒ 名字必须自有。此处出现框架词 = **自述误用**，处置 = **改名 / 改写**。
- **归外部** ⇒ 进 J2。

**J2 角色**——归外部的词，在此处扮演三者中的哪一个？

| 角色 | 许可 | 附加义务 |
|---|---|---|
| **R1 指针** | ✅ 保留 | **必须带归属**（URL / 路径 / 显式「the X framework」）；不得被读成产品的属性。 |
| **R2 兼容声明** | ✅ 保留 | 必须**同时**给出外部接口代号**与机器可核的版本地板**；必须挂在**框架侧产物**上，不得充当产品的自述。 |
| **R3 溯源** | ✅ 保留 | 只许在**源码注释**；同处必须给出**产品侧自足**的规范性表述（读者不需要外部规范也能懂）。 |
| **F1 泄漏** | ❌ 禁止 | 指向**框架内部机制**（不是接口，而是框架自己的实现/流程/花名册）且以规范性姿态出现者。处置 = **删除或改写为产品侧表述**。 |

**J3 事实源**——框架规范与产品 schema 同时描述一个形状时：**产品 schema 是事实源**（`src/shared/wire.mjs` + `KNOWN_CARD_KEYS` + 契约快照 `CONTRACT_SCHEMA_VERSION`）。框架侧**只放指针**（一个路径 + 一句「以对方为准」），**不得复制**一份字段表、一份枚举、一份版本号。

### 3.3 清单：可作 vs 不得泄漏

| 框架词 | 归属 | 许可角色 | 判据一句话 |
|---|---|---|---|
| **`task-interface` / `task-interface v1`** | 外部（openclaw-team 的 ACL 代号） | **仅 R2 兼容声明** | 它命名的是「loop 驱动的那一代接口」，是**跨仓绑定声明**；但它**不是**产品的 CLI 面的名字（那个叫 `taskctl`）。 |
| **`openclaw-team`** | 外部（框架项目名） | **仅 R1 指针** | 它是第三方项目的名字，产品与它**互操作**（OpenClaw 上由它承担 supervisor）。带 URL 引用是正常的、必要的。 |
| **外部协议文档名（及 `§N` 锚）** | 外部（框架的内部协议文档） | **无** | 它管的是框架的五角色 / 派单 / redlines——**产品用户不需要它**，而它在 npm 包里是一枚**悬空指针**。⇒ **F1**。 |
| **`task-ops`** | 外部（框架的内部 skill + `lib/task.mjs`） | **无** | 框架的收口实现路径。⇒ **F1**（`61f7f3a` 已零落点）。 |
| **`redlines.core.md`** | 外部（框架内部治理文档） | **无** | 同上。产品仓**零命中**，列为禁止项以防回潮。 |
| 框架**内部符号**：`poll.mjs#scanCandidates`、`poll.mjs`、`board-adapter.mjs`、`wake-cwd.mjs` | 外部（框架实现） | **至多 R3** | 以 `文件#符号` 形式出现即**锁死对方的内部实现**——对方一次改名就让产品注释静默过期。⇒ 降级为**非规范性**注释，或删去符号名。 |
| 框架**花名册/实例数据**：人员名单字面量（`elon` / `terry` / `tanyu` 三名的正则，见 §6）硬编码、`elon`/`linus`/`turing` 作**逻辑**（非示例数据） | 外部（框架实例） | **无** | 见 §6——**本卡 4 类之外**，单独记，不在本卡处置。 |

---

## 4. 逐类处置口径（可执行）

> ⛔ **本章作为「工单」已作废（2026-10-17 退役）。** 它写给 C2，而 C2 从未开工，本裁定已退役（见文首）。保留内容仅为**当时的落点盘点**：其中每一条 `plugins/**` 生成副本目标**都不存在了**（`plugins/` 已删），每条处置也不再需要执行。**§7.2 的两条禁令**才是本文件退役后唯一生效的部分。

处置词只有三个：**保留** / **改名** / **加标注**。每条给出：落点 → 处置 → 改法与理由 → 是否触发再生成。

### 4.1 类 ①：`task-interface`（37 文件）

分 **五个子角色**，因为同一枚词在不同角色下处置相反：

#### ①-a 兼容声明（**保留**）

| 落点 | 处置 |
|---|---|
| `skills/meerkat-loop/SKILL.md`（§Required board interface） | **保留** |
| `skills/meerkat-loop/references/operation.md`（§Compatibility 表） | **保留** |
| `skills/meerkat-loop/scripts/board-check.mjs`（`REQUIRED_BOARD_INTERFACE`） | **保留** |
| 12 个**生成副本**（`plugins/{claude,codex,loop,pi}/skills/meerkat-loop/{SKILL.md,references/operation.md,scripts/board-check.mjs}`） | **保留**（随源；**不得手改**） |

**理由**：这是 J2 的 R2——loop 是**框架侧的产物**（面向 claude/codex/pi 分发，永不给 OpenClaw），它必须声明自己驱动 ACL 的哪一代。`references/operation.md` 的兼容表**已经**把两侧分清了（loop 声明接口代号 + 地板；board 用自有的 `version` / `schema_version`），这正是 Acceptance ③ 要的形状，**无需改**。
**可选加固（低成本，建议 C2 顺手做）**：在 `SKILL.md` 该代码块下补一句归属——「`task-interface v1` 是 openclaw-team 的任务提供方 ACL 代号；本板是其参考实现」。一行，满足「R2 必须带归属」。

#### ①-b 产品**自述**（**加标注**）

| 落点 | 现文 | 改法 |
|---|---|---|
| `README.md`（M2 里程碑行） | `taskctl` command surface aligned with `task-interface v1` | 改为先给产品名、后给归属指针：`taskctl` command surface（= openclaw-team 的 `task-interface v1` ACL 的参考实现） |
| `README.zh-CN.md`（M2 行 + 特性段） | 同上两处 | 同上 |
| `CHANGELOG.md`（`[Unreleased]` 的 loop 段） | declares the board interface generation it requires — `task-interface v1` | 该句主语是 **loop**（框架侧产物）⇒ **保留**；若同段出现「board 的接口叫 `task-interface v1`」的读法则补归属。 |
| `skills/meerkat-taskpanel/SKILL.md`（Status 行） | The command surface is implemented and aligned with `task-interface v1` | 同上（先 `taskctl`，`task-interface v1` 作归属括注） |
| `skills/meerkat-taskpanel/references/cli.md`（引言） | It is aligned with **`task-interface v1`** | 同上 |

**理由**：J1——这些句子在描述**产品自己的命令面**，却用了别人家的名字。**不是**「产品不能提 ACL」，而是「产品不能**用 ACL 的名字当自己的名字**」。
**注意**：`skills/meerkat-taskpanel/**` 是**自撰**（它是作者区），改动后**必须** `node scripts/sync-skills.mjs`（生成副本 8 文件：`plugins/{claude,codex,openclaw,pi}/skills/meerkat-taskpanel/{SKILL.md,references/cli.md}`）。改 `README*/CHANGELOG` **不触发**再生成。
**注意（`CHANGELOG.md` 的处置）**：该句主语是 **loop**（框架侧产物），属 ①-a 的兼容声明，故列此表只为**比对**，实际处置 = **保留**，不计入 §4.5 的「加标注」4 文件。

#### ①-c 产品**自有 schema** 被外部标签命名（**改名**）

| 落点:符号 | 现文 | 改法 |
|---|---|---|
| `src/shared/README.md`（首段） | …the `task-interface v1` payload schemas… | …the board **wire** payload schemas（`wire.mjs`）… |
| `src/shared/wire.mjs`（模块注释） | The card and `task-interface v1` both speak snake_case | The card and the board wire both speak snake_case（谓词两端都是**产品自有**的东西） |
| `src/core/domain/enums.mjs`（首段 F2 裁定句） | The `task-interface v1` words `ready`/`failed` are aliases only | The **ACL's legacy** words `ready`/`failed` are aliases only（保留「它们是外来别名」的事实，去掉「产品的枚举叫 `task-interface v1`」的暗示） |
| `src/shared/status-alias.mjs`（首行） | `task-interface v1` ↔ core status aliases（F2 ruling） | 同 enums.mjs；若需指向外部规范，用 R3 形式另起一句（见 ①-d） |

**理由**：J1 + J3——这些 payload schema / 枚举 / 别名**都是产品铸造的**（`wire.mjs` 是服务端与 CLI 共用的一份投影；F2 已裁定七态为 canonical）。用外部代号命名它们，等于把产品的 schema 挂在别人的版本号下。**这是本卡最实质的一类耦合**。
**触发再生成**：**否**。实测 loop payload（`skills/meerkat-loop/body/**` = 9 文件，含 `manifest.txt`）中，`src/shared/` 只有 `{constants,errors,project-dir,redact,runtime-locator,scheduling}.mjs` 六个模块 —— `wire.mjs` / `status-alias.mjs` / `enums.mjs` **不在**其中。⇒ C2 改这四处**不需** `sync-loop`；仍应跑 `check:skills` 确认（零成本）。
**注意**：`wire.mjs` 与 `enums.mjs` 是**纯模块**，注释改动不可能改变任何运行时值；契约快照（`test/fixtures/contract/api.snapshot.json`）**不含注释**⇒ **零快照漂移**。C3 可据此断言「本类改动不移动 `schema_version`」。

#### ①-d 溯源引用（**改写**）

| 落点 | 现文 | 改法 |
|---|---|---|
| `src/core/README.md`（§Creation idempotency） | L1 reading: 外部协议文档 §㉙ + `guides/task-interface.md §14`. | 删去外部协议文档锚（F1）；保留 ACL 指针：`L1 reading: task-interface v1 §14`（或 `guides/task-interface.md §14`），**并**保证同段已用产品语言复述规则（现文已复述，符合 R3）。 |
| `src/core/domain/idem.mjs`（模块注释） | 同上 | 同上 |
| `test/core/domain/idem.test.mjs` | 同上 | 同上（一致性；该文件不随 npm 发布） |

**理由**：J2 的 R3 + F1——溯源**可以**留 ACL 指针，但外部协议文档的章节锚是框架**内部**文档的锚，在 npm 包里打不开。

#### ①-e 测试锁（**保留**，条件性）

| 落点 | 处置 |
|---|---|
| `test/skill/loop.test.mjs`（`declares the board interface it requires` + `boardInterface: "task-interface v1"`） | **保留** |

**理由**：它断言的是 **①-a**（loop 的自有声明），不是产品的自述。**仅当 ①-a 改动时**才随之改；本裁定**不动** ①-a，故测试**不动**。
**可执行判据**：C2 完成后 `node --test "test/skill/*.test.mjs"` 必须仍绿——若 ①-b 的改动意外红了它，说明改到了 ①-a 的语料。

### 4.2 类 ②：`openclaw-team`（40 文件）

#### ②-a 指针 / 跨仓说明（**保留**）

落点（**18 个自撰文件**，均为 R1）：`README.md`·`README.zh-CN.md`·`CHANGELOG.md`·`docs/{README,install,publishing,scheduling}.md`·`install.sh`·`scripts/install/{_common.sh,openclaw.sh}`·`scripts/sync-skills.mjs`·`skills/meerkat-loop/{SKILL.md,references/operation.md}`·`test/install/{claim-unassigned,scheduling-units,supervisor-enable,supervisor-plan}.test.mjs`·`test/scaffold.test.mjs`（+ 随生成的副本）。

**处置 = 保留**，理由：J1+J2-R1——这些句子解释的正是「**OpenClaw 上由别的框架承担 supervisor，本产品因此不给它装 loop**」这一跨仓事实；README 已明写「**Read it as a reference, not a universal fit**」，归属充分。
**唯一附加义务**：**保持链接**。任何把 `openclaw-team` 从「带 URL 的第三方项目」降格为「裸词」的编辑，都使该处从 R1 掉进 F1。
**与 ②-b 的分界（本子类为何「保留」而 ②-b 要改）**：本子类的 lockstep 句（`README.md` 的 Highlight 段、`docs/scheduling.md` §Scheduling 段）说的是「**框架的 poll 与本板的候选判据同构**」——它引用的是**一个概念**（poll），而 poll 本身就是**产品也有**的东西（`scripts/supervisor.mjs`）；②-b 引用的是**对方的文件#符号**（`poll.mjs#scanCandidates`），那才是锁死对方实现的写法。判据：**点名到「对方的文件/符号」= ②-b；只说到「对方的一个概念」= ②-a。**（穷举方式 = `git grep -n 'lockstep with'`，实测 13 命中，无关项仅 `test/shared/node-version.test.mjs` 的 `engines.node` 一处。）

#### ②-b 锁死框架**内部符号**（**加标注 / 改写**）

| 落点:符号 | 现文 | 改法 |
|---|---|---|
| `src/core/commands/tasks.mjs:listTasks`（candidates 注释） | …kept in lockstep with the openclaw-team `poll.mjs#scanCandidates` criteria so a provider swap changes nothing… | 保留「criteria 与框架 poll 保持一致」这一**跨仓意图**（它是真信息），但删去 `poll.mjs#scanCandidates` 这个内部符号（或降为「框架侧的 poll 扫描」）——产品侧的候选判据必须**自己**是规范性的（现文随后三条 bullet 已经自足了 ✅）。 |
| `src/shared/constants.mjs`（`CLAIM_STALE_SAME_MS` / `CLAIM_STALE_ANY_MS` 注释） | kept in lockstep with the openclaw-team framework's `poll.mjs`（`CLAIM_STALE_SAME_MS` / …） | 同上：三个阈值本身已是产品常量并有 doc 注释；把「lockstep + 对方文件」降为一句非规范性说明。 |

**理由**：J2-R3 的上限——R3 允许**溯源**，不允许**把规范性锚在对方内部符号上**。对方改一次名，产品注释静默过期。
**触发再生成**：`src/shared/constants.mjs` **在** loop payload 内（`skills/meerkat-loop/body/src/shared/constants.mjs`）⇒ 改动后 **必须** `node scripts/sync-loop.mjs` + `node scripts/sync-skills.mjs`（生成副本 4 host 各一份 `body/src/shared/constants.mjs`）。`src/core/commands/tasks.mjs` **不在** body 内（未见对应副本）⇒ 不需 sync-loop。
**风险等级**：本子类是「**可延后**」级——它不产生悬空指针（注释里的符号名不构成引用），只是**脆**。C2 可按 §7 排在 P2。

#### ②-c 示例数据（**保留**，加一句说明）

| 落点 | 处置 |
|---|---|
| `docs/projects.md`（归一化示例表：`openclaw-team`, `openclaw_team`, `openclaw.team` ⇒ `OPENCLAW-TEAM`） | **保留** |
| `test/core/commands/project-prefix.test.mjs`（同名示例 + 断言） | **保留** |

**理由**：这是**项目 id 的示例数据**，不是框架引用——`openclaw-team` 在此处与框架**同名纯属巧合**（它演示的是「非 `[A-Z0-9]` 连续段折叠为单个 `-`」这条归一化规则，`demo_x`/`demo-x`/`demo.x` 是同一行里的另一组）。
**建议（不建议本卡做）**：若要消歧，可把示例换成 `openclaw_team` 之外的第三组，但那会**改动测试断言值**（`assert.equal(identifierPrefix("openclaw-team"), "OPENCLAW-TEAM")` 等 5 处），属实现改动，须另卡。**本卡不处置**。

### 4.3 类 ③：外部协议文档名（6 文件）——**全部改写**

| 落点 | 处置 | 改法（产品侧自足表述） |
|---|---|---|
| `docs/migration.md` | **改写（该段已随 importer 删除）** | `__team__` is the reserved **team-internal** project（团队框架自用的登记项，不对应任何仓库）；删去 `(外部协议文档 §②)`。 |
| `src/core/storage/md/project-registry.mjs`（`BUILDIN_PROJECTS` 注释） | **改写（文件已删除）** | 同上。 |
| `src/core/README.md` | **改写** | 见 ①-d。 |
| `src/core/domain/idem.mjs` | **改写** | 见 ①-d。 |
| `test/core/domain/idem.test.mjs` | **改写** | 见 ①-d。 |
| `test/migrate/import-hardening.test.mjs`（describe 名） | **改写（文件已删除）** | describe 名去掉 `(外部协议文档 ②)`，改为 `(the reserved __team__ project)`。 |

**理由**：全部 F1。4/6 处随 npm 发布，其中 `docs/migration.md` 的 `__team__` 段是**用户读得到的**——一个装完 npm 包的读者手里没有该外部文档，`§②` 对他不可解析。**这不是「产品不能提框架」，而是「产品不能把框架的章节号当依据」**：`__team__` 为什么保留，产品**自己说得出**（见右列）。
**不触发**再生成（6 处均不在 loop payload 闭包内；`project-registry.mjs`、`idem.mjs`、`migration.md` 均无 `body/` 副本）。

### 4.4 类 ④：`task-ops`（0 文件）——**立禁，零落点**

| 落点 | 处置 |
|---|---|
| 无（`61f7f3a` 实测零命中） | **无需动作**；本文件把 `task-ops` 登记为 **F1 禁止项**，供 C3 在后续 PR 上做**回潮检查**（`git grep -n task-ops` 必须恒为 0）。 |

**理由**：F1——它是框架内**收口实现**在仓库外的私有路径（**字面量故意不复述**：复述一次就等于再造一块指路牌，本文件 2026-10-17 退役的直接起因），产品既不暴露也不消费。卡面记 1 处、本 lane 实测 0 处（§2），说明它在 `main` 前进时已被清掉。

### 4.5 处置总表（C2 的工单）

| 处置 | 子类 | 自撰落点（逐个） | 触发 sync |
|---|---|---|---|
| **改名** | ①-c | 4：`src/shared/README.md`·`src/shared/wire.mjs`·`src/core/domain/enums.mjs`·`src/shared/status-alias.mjs` | **否** |
| **改写** | ①-d + ③ | 6：`docs/migration.md`·`src/core/README.md`·`src/core/domain/idem.mjs`·`src/core/storage/md/project-registry.mjs`·`test/core/domain/idem.test.mjs`·`test/migrate/import-hardening.test.mjs` | **否** |
| **加标注** | ①-b | 4：`README.md`·`README.zh-CN.md`·`skills/meerkat-taskpanel/SKILL.md`·`skills/meerkat-taskpanel/references/cli.md` | **是**（后两个在作者区 ⇒ `sync-skills`，8 个 host 副本） |
| **加标注** | ②-b | 2：`src/core/commands/tasks.mjs`·`src/shared/constants.mjs` | `constants.mjs` 在 loop body 内 ⇒ **`sync-loop` + `sync-skills`**（4 个 `body/src/shared/constants.mjs` 副本）；`tasks.mjs` **否** |
| **保留** | ①-a·①-e·②-a·②-c | 25：4（类①：loop 兼容声明三文件 + `test/skill/loop.test.mjs`）+ 21（类②：②-a 19 + ②-c 2） | —（零改动 ⇒ 零 sync） |
| **立禁** | ④ | 0（零落点） | — |

> **C2 的实际改动面 = 16 个自撰文件**（4+6+4+2）。计数口径：同一文件跨多个子角色时按**处置最重**的一条计一次（如 `src/core/README.md` 同属 ①-d 与 ③，均判「改写」，计一次）。生成副本**不计入工单**——它们由 sync 重写，与源恒等；手改即 CI 红。
>
> **2026-10-20 起**：上表「改写」6 个文件中的 `docs/migration.md` 的 `__team__` 段、`project-registry.mjs`、`test/migrate/import-hardening.test.mjs` 已随 markdown importer 删除；「加标注」的 `skills/meerkat-taskpanel/**` 仍在。历史计数不再代表当前工单。
> **反向校验（C3 可直接跑）**：C2 完成后 `git diff --name-only 61f7f3a..` 的自撰文件集，应恰为该 16 个 ∪ 生成副本；出现第 17 个自撰文件即越界。

---

## 5. 与产品「事实源」口径一致性（Acceptance ③）

**结论：本裁定与事实源口径一致，且是被它推出来的，不是外加的。**

1. **产品自有契约名已经在位（实测）**：
   - CLI 面 = `taskctl`（`bin` → `src/cli/index.mjs`）；
   - wire = `src/shared/wire.mjs`（`*ToWire` 的唯一投影点，`docs/contract.md` 明写「Nothing is a second copy of a list」）；
   - 代号 = `schema_version`，值来自 `CONTRACT_SCHEMA_VERSION`（实测 **4**；`package.json#version` = **1.0.0**）。
   ⇒ 裁定「产品对外契约名必须自有」**不需要产品新增任何东西**，只需**纠正自述**。

2. **框架侧已经先行让位（实读）**：`guides/task-interface.md` §2 的 Data Model 表把 Card 字段逐字标为「= meerkat-taskpanel `KNOWN_CARD_KEYS`；未识别键原样保存在 `meta.legacy`」。⇒ ACL 规范**自己就承认产品 schema 是事实源**。本裁定的 J3 只是把这条已存在的方向写成判据。

3. **F2 裁定是先例**：`src/core/domain/enums.mjs` 首段记「Cardinal rule (F2 ruling): the card's seven states are canonical. The `task-interface v1` words `ready`/`failed` are aliases only」。⇒ **值**层面的「产品 canonical，外部是别名」**早已裁定**；本卡把它延伸到**名**层面。两者是同一条原则的两个层级，**不冲突、不重复**。

4. **机器面证据（实测，本裁定的关键支点）**：`git grep -n task-interface` 在 `src/server`、`src/cli`、`web/`、`scripts/verify`、`test/fixtures/contract/api.snapshot.json` **全零命中**；`src/cli/index.mjs` 的 `--version --json` 只产出 `{version, schema_version}`。⇒ **产品在任何机器可读界面上都不发布 `task-interface` 这个名字**。它是**纯人读标签**。
   ⇒ 由此得到 §0-④-2 的推论：**命名耦合不承载任何机器语义**，因此「保留作兼容声明」（承认绑定）与「不得作产品契约名」（纠正归属）可以并存，无需二选一。

5. **「框架侧只保留 ACL 最小必需集 + 指针」的落地形态**：
   - **最小必需集** = loop 的 `requires: board task-interface v1 — board release >= 1.0.0`（一个外部接口代号 + 一个机器可核的**地板**）；机器半由 `board-check.mjs` 查询 board 自有的 `version` 实现，**不预设**任何 `task-interface` 串。
   - **指针** = `references/operation.md` §Compatibility 的两行表：loop 声明接口代号，board 用**自己的** `version`/`schema_version` 回答。两侧各说各的，**只在表里配对**。
   ⇒ 这正是 Acceptance ③ 要求的形状；本裁定**不要求**改它，只要求**别再让产品自述借用这个代号**。

---

## 6. 相邻发现（**本卡 4 类之外**，只记不处置）

以下三条是本 lane 实测/实读时撞见的、**同一判据**能覆盖、但**不在卡面 4 类**内的问题。按 Boundary「只出契约文档；不直接改代码」，此处**只登记**，交 Elon 决定是否另开卡。

1. **框架实例花名册被硬编进产品逻辑（读：F1，可判）**：`src/core/storage/md/import.mjs` 两处以字面量 `^(elon|terry|tanyu)$` 判定 comment 的 `author_kind`（human vs agent）。这是**某个框架实例的人员名单**进入了产品的导入逻辑——比外部协议文档名更实质（它影响**行为**，不只是注释）。它既非接口、也非产品配置；按 J1/J2 应判 **F1**。**建议**：另开卡，改为可由项目配置提供的名单（或 `author_kind` 显式携带）。
2. **框架内部符号的 lockstep 注释**：见 §4.2-②-b（已在本卡 4 类内的 `openclaw-team` 引用里处置）；此处仅记「同一模式可能存在于其他耦合注释」，C2 扫一遍 `kept in lockstep with` 即可穷举（实测机制：`git grep -n 'lockstep with'`）。
3. **生成副本的传播面**：`skills/meerkat-loop/**` 与 `plugins/*/skills/**` 是**生成物**（`sync-skills.mjs` / `sync-loop.mjs`），任一处置若落在其**源**上，必须跑 sync 并让 `check:skills` 绿。§4 每条已标「触发 sync」。**C2 不得手改生成副本**（CLAUDE.md 硬规则）。

---

## 7. 执行顺序建议（供 C2 分批）

> ⛔ **分批计划已作废（2026-10-17 退役）—— 这三批从未开工，也不再执行。** 下表与紧随其后的 C3 判据保留为历史。生效中的只有 §7.2。

| 批 | 内容 | 理由 | 每批的 gate |
|---|---|---|---|
| **P0** | §4.3 全部（外部协议文档名 6 处）+ §4.1-①-d | **悬空指针**：npm 包里不可解析的章节锚，且 4/6 处在对外面。改注释/散文，**零行为**。 | `npm test`（`test/migrate/*`、`test/core/domain/idem.test.mjs`）；`npm run check:skills`（应零变更） |
| **P1** | §4.1-①-c（自有 schema 改名）+ ①-b（自述加标注） | **本卡的主诉**：产品自述借用外部代号。①-b 改自撰 skill ⇒ 跑 sync。 | `npm run check:skills` 必须绿（生成副本已同步）；`node --test "test/skill/*.test.mjs"`；`node scripts/verify/contract.mjs` **必须 0 漂移**（只改注释，快照不动） |
| **P2** | §4.2-②-b（内部符号降为溯源） | 只降低**脆性**，无对外可见变化；触及 `constants.mjs` ⇒ sync-loop。 | `npm run check:skills` + `npm test` |
| **不动** | §4.1-①-a / ①-e、§4.2-②-a / ②-c、§4.4 | 判据判为「保留」/「零落点」。 | C3 只需**证明未动**（`git diff --stat` 对这些路径为空） |

**C3（Turing）的独立判据**（逐条可核，不依赖本文件的措辞）——**未执行过，且已不是目标**；列出仅供对照：

- ① 对当时的外部协议文档名做 `git grep`，在 `src/**`、`docs/**`、`README*`、`CHANGELOG.md`、`skills/**`、`plugins/**` **恒为 0**（原始命令见 `git show 61f7f3a:<path>`）；
- ② `git grep -n 'task-ops'` 全仓**恒为 0**；
- ③ `task-interface` 的剩余落点**只**在 loop 侧兼容声明三文件及其生成副本 + `test/skill/loop.test.mjs` + （若 C2 选择保留括注）§4.1-①-b 的五个自述文件；**`src/shared/**` 与 `src/core/domain/enums.mjs` 必须清零**；
- ④ `node scripts/verify/contract.mjs` **零漂移**，`schema_version` 仍为 4（本裁定是 doc-only：**注释与散文的改动不得移动契约**）；
- ⑤ `npm run check:skills` 绿（无未同步的生成副本）。

> ① 与 ③ 在退役时**已不成立**（见文首）。它们的错误在于把「**跨仓兼容声明**」当成「泄漏」来清零 —— 当时的 SLA 章节锚确实是产品已发布的接口数据（`threshold_ref` 字段），`task-interface` 是 loop 侧对框架接口代的绑定声明。这两样当时不是命名耦合，是**跨仓契约**。**2026-10-22 订正**：SLA 契约内化（`a4cc5e4`）后，`threshold_ref` 已改指 `docs/sla.md` §2，测试现在断言外部名缺席；因此「已发布接口数据」的例外不再成立，外部协议文档名的树内引用已清除。④⑤ 仍然成立，但它们守的是**通用不变量**（契约快照不漂移、生成副本已同步），与命名边界无关。

### 7.1 现状表（取代判据 ①②③ —— 「现在是什么样」）

| 框架词 | 今天的角色 | 今天的面（示例，非穷举） |
|---|---|---|
| 外部协议文档名 / `§N` 锚 | **已清除（2026-10-22）** | 曾是 R2 跨仓兼容声明 + 已发布的接口数据；SLA 内化后 `threshold_ref` 指向 `docs/sla.md` §2（`src/foundation/sla-patrol.mjs`），测试现在断言外部名缺席。树内引用已改指产品自有权威；仅 §9 原始输出保留该词作历史证据 |
| `task-interface` / `task-interface v1` | **R2 兼容声明**（loop 侧）+ **R3 溯源**（注释） | loop 侧 `skills/meerkat-loop/**` 与 `test/skill/loop.test.mjs`；产品侧的**自述与注释**（`src/shared/**`、`src/core/domain/enums.mjs` 等） |
| `openclaw-team` | **R1 指针**（带 URL） | 跨仓事实：OpenClaw 宿主由该框架承担 supervisor，本产品因此**不给它装 loop**（`README*.md`、`docs/{install,scheduling}.md`、`install.sh`） |
| 框架**私有 store 路径** | **F1 —— 禁** | 无落点（2026-10-17 由本轮指路牌清理达成，见 §7.2 第一条） |
| 框架**内部机制词** | **F1 —— 禁** | 仅本文件，为「说明禁令」而出现（门禁对**它一个**文件按规则豁免；`design/README.md` 的登记行已改写为不枚举这些词，因此不需要豁免） |

### 7.2 现行禁令（本文件退役后唯一生效的部分）

1. **框架私有 store 根的 home 相对路径，不得出现在任何受版本控制的文件里。** 其**字面量刻意不在本文件复述** —— 复述一次就是再造一块指路牌，这正是本文件 2026-10-17 退役的直接起因（一次 `grep` 命中本文件的旧 §4.4，把会话引进了那块 store）。精确形式以 `scripts/verify/signposts.mjs` 的 `store-root` 规则为**唯一权威**。例外是两个**文档化集成子路径**：卡片目录与项目登记文件 —— 产品的迁移功能正当地读写它们，因此写在规则里作结构性豁免，不占豁免名单。
2. **框架内部机制词不得出现在任何受版本控制的文件里**（收口实现目录名、车道启动脚本、车道回收器、会话登记文件、框架治理文件名）。唯一例外是**本文件**：禁令要求它写出所禁止的词，所以门禁对它豁免——且**只对它**（`design/README.md` 的登记行已改写为不枚举这些词，是有意为之：豁免面越小，回潮越难藏）。

两条禁令由 `scripts/verify/signposts.mjs` **机械执行**（进 `npm run verify`、pre-push 与 CI）。**判据即门禁**：不再依赖人工 `git grep`。

---

## 8. 登记与签名

**登记**：`design/README.md` 的 `contracts/` 段现写「The first one is `contracts/project-prefix-binding.md`（…）」——本文件是**第二份** topic-scoped 契约，该句随本卡补一行（`C-PREFIX-1` 的先例：契约文档在 `design/README.md` 的目录树/说明段登记）。**除该行外，本卡不改 `design/**` 任何现文**（未动 `DESIGN.md` / `BLOCKS.md` / `fidelity-*.md` / `prototype/**`）。

**双签（Acceptance ③）—— 从未取得，现已不再适用（2026-10-17）**：按 `task-interface.md` §7 的接口变更要求与卡面 Acceptance ③，本裁定须 **Elon / operator 双签**方可作为 C2 的开工依据；执行方**不能自签**。**这两个 ☐ 到退役为止始终是空的**，C2 因此从未开工 —— 这是本文件「写得很细却一行没执行」的机制性原因，也是它退役的直接背景。下方两条保留为当时的待办记录：

- ☐ **Elon** —— 裁定与事实源口径一致（§5 五条）；双签建议落 `kind:confirm` comment。
- ☐ **operator** —— 范围 (B)/② 的裁定成立；`task-interface v1` 保留为**纯兼容声明**、不作产品契约名。

**留给双签方的一个待答问题**：§4.2-②-c 的示例数据 `openclaw-team`（项目 id 示例）与框架名同形。本裁定判**保留**（它是数据不是引用，且改动会动测试断言）。**2026-10-17 随退役一并按「保留」关闭** —— 该示例至今仍是刻意的示例数据（`test/core/commands/project-prefix.test.mjs` 依赖它），§7.2 的两条禁令都不触及它。

---

## 9. 原始输出（实测）

> 本节是 `61f7f3a` 的原始转录。其中的外部协议文档名按原样保留，作为「当时确实有这些落点」的证据；2026-10-22 后树内引用已清除（见文首）。

```text
$ git rev-parse --short HEAD ; git rev-parse --short refs/heads/main
61f7f3a
61f7f3a

$ git grep -l -- task-interface | wc -l
37
$ git grep -l -- openclaw-team | wc -l
40
$ git grep -l -- PROTOCOL | wc -l
6
$ git grep -il -- task-ops | wc -l
0

$ git grep -l -- PROTOCOL
docs/migration.md
src/core/README.md
src/core/domain/idem.mjs
src/core/storage/md/project-registry.mjs
test/core/domain/idem.test.mjs
test/migrate/import-hardening.test.mjs

$ git grep -rn 'task-interface' -- src/server src/cli web scripts/verify test/fixtures/contract
（零命中）

$ grep -n 'CONTRACT_SCHEMA_VERSION = ' src/shared/constants.mjs
29:export const CONTRACT_SCHEMA_VERSION = 4;
$ grep -n '"version"' package.json
3:  "version": "1.0.0",

$ find skills/meerkat-loop/body -type f | wc -l          # loop payload 实测 9（含 manifest.txt）
9

$ node scripts/verify/contract.mjs                        # 本 lane 改后：零漂移
contract: OK — 35 routes (207 request facets), 55 error codes, 116 wire fields
$ echo $?
0

$ node scripts/sync-skills.mjs --check                    # 本 lane 改后：生成副本全同步
…
skill sync: OK
$ echo $?
0
```

> 末两条是**本 lane 改动之后**跑的（宿主静态检查，非运行类）：本卡只新增 `design/contracts/naming-boundary.md` + `design/README.md` 一行，故契约快照**零漂移**（`schema_version` 仍 4）——这正是 Acceptance ③「doc-only」的可核形态，也是 §7-C3-④ 的基线。

**未跑**（不伪造）：`npm test` / `npm run verify:docker` / `taskctl` / `taskd` / 任何浏览器或容器步骤——本卡 doc-only，且按 CLAUDE.md 一切**运行**类验证在容器内；本 lane 未进入容器。§4/§5 的所有结论均为**文本层**（`git grep` + 实读），不依赖运行行为。

---

## 10. 本 lane 的边界声明

> 本章描述的是 **2026-10-14 那次 C1 落文**的情形，不是现状：它所引的 lane 分支持与 `plugins/**` 都已不存在。

- **doc-only**：本 lane 只新增本文件 + `design/README.md` 一行登记。**未改任何代码**（`src/**`、`web/**`、`skills/**`、`test/**`、`scripts/**` 零改动；当时还有 `plugins/**`，该目录已于 2026-10-17 整目录删除）。
- **未 push**：提交当时留在 lane 分支 `lane/T-20261014-011057-2-seg1`（该分支此后已被集成并清理，不再存在），供集成；分支与 sha 见 Report。
- **未跑容器**：按 CLAUDE.md，运行类验证在容器内；本卡无需运行类验证（doc-only），且本文件所依赖的全部结论已在 §9 给出**可在宿主直接复现**的静态命令。
- **对卡面的两处订正**（§2）：`openclaw-team` 计数 39→40、`task-ops` 计数 1→0，均因 `main` 在本 lane 开工点前已前进；本文件以 `61f7f3a` 实测为准。
