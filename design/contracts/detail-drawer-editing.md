# 详情抽屉编辑面三处口径契约（`depends_on` 方向 / 附件硬删 / 尺寸文案） · C-DRAWER-1

> **口径一句话**：抽屉三个编辑面的**语义**以**服务端 / DAG 为准**，原型只锚**结构、几何与计算样式**；下面三处口径逐条钉死，每处给「改动前 / 改动后」逐字引文，并给出**可核判据**。
>
> 卡：`T-20261015-065623`（goal：把 Elon 裁定后的口径写回 design 文档：§4.4 依赖方向 = 甲（入边）、附件硬删语义、尺寸文案 D6 偏离登记；不改原型本体）。
> **裁定来源**：`T-20261014-212017-7`（Jobs 设计保真认证）的 `kind=decision` 评论（2026-10-14T22:53:31.043Z）**D1 / D2 / D6** 三条；以及本卡 `kind=change` 前提订正 + `kind=decision` 文档落点裁定 = **甲**（2026-10-14T23:11Z）。本文件是**执行方**把这三条写成的契约文档。
> 分工：**本卡 = 设计侧口径登记**（写面 `design/**`，**零实现、零原型改动**）；实现已由 `T-20261014-212017-4` 交付（commit `c1a1e4d`），**本文件不改它一行**。
> 事实源：实现 = `web/src/stores/board.js`、`web/src/lib/attachments.js`、`web/src/components/detail/DetailDrawer.vue`、`src/core/commands/relations.mjs`、`src/server/routes/relations.mjs`、`src/core/storage/repositories/relations.mjs`、`src/core/storage/md/import.mjs`、`src/core/storage/md/export.mjs`、`src/shared/wire.mjs`、`src/server/routes/attachments.mjs`（**实读**）；原型 = `design/prototype/index.html`、`design/prototype/app.js`（**实读**，符号级；本 lane **未**驱动浏览器）；散文 = 卡工作区 `workspace/T-20261014-212017-3/design-spec.md` §4.3 / §4.4（**实读**）。`formatFileSize` 与原型 `attachmentSizeLabel` 取值 = **实测**（纯函数 Node 直跑 + 逐字转写复核；原始输出见 §7）。
> 基线 commit：`103d8cb`（= 本 lane 的开工点 = 本地 `main` = 分支 `lane/T-20261015-065623-seg1`）。
> **本文件为新增文件**：未改动 `design/prototype/**` 一行；未改动 `design/DESIGN.md` / `design/BLOCKS.md` / `fidelity-*.md`（理由见 §5、§8）。`design/README.md` 仅按本卡裁定补**索引一行**。

## 0. 结论摘要

- **① `depends_on` 方向 = 甲（入边）。** 抽屉 chips 显示的是**该任务的依赖** —— 即「本任务在等谁」，也就是指向本卡的 `blocks` 边（wire 的 `blocked_by`，`source` = 前置任务、`target` = 本卡）。**不是**「本卡阻塞了谁」（出边）。写一条 `depends_on` 落为 `blocks` 边，**`source` = 前置任务**、`target` = 本卡。裁定原文：「**D1 depends_on 播种方向 → 甲（维持实现：chips 取该任务的依赖=入边/blocked_by）**」。
- **② 附件移除 = 硬删（行与字节同去）。** 移除是**一个动作**：字节先改名到 staging，行删除在**同一个持有写锁的事务**内完成，staging 文件仅在该事务提交后丢弃。不可恢复；**重传即恢复路径**；不留 `deleted_at` / 墓碑；移除后下载端点 `404`。裁定原文：「**D2 附件移除=硬删 → 追认**」。
- **③ 尺寸文案（D6）= 已声明的可见文案偏离，实现维持。** 实现把字节数写成 `B / KB / MB` 三段（`< 1 KiB` ⇒ `"17 B"`），原型写成 `1 KB` / `0 KB` 两段。裁定原文：「**D6 尺寸文案偏离（17 B / 空 vs 1 KB / 0 KB）→ 准予维持**（登记为已声明的可见文案偏离）」。**本卡的职责就是这份登记**（§3.3）。
- **④ 一处口径精度（实测，见 §3.3 与 §7）。** 裁定的简写「`17 B` / **空**」里的「空」指的是 `formatFileSize` 的**非数值守卫**（`undefined` / `NaN` / 负数 ⇒ `""`）；**存储里的字面零**渲染成 `"0 B"`，不是 `""`。下游据此断言，**不要**写成「`0` ⇒ `""`」。
- **⑤ 三处都是「散文 / 原型 vs 实现」的口径差，不是实现缺陷。** 原型**无真值后端**（`design/prototype/**` 零 fetch / XHR / 存储，`design-spec.md` §1 红线），所以 ①③ 是**散文口径漂移**、② 是**文档补记**；三者一律**不动实现、不动原型**（`T-20261014-212017-7` D1 原文：「…不动实现」）。
- **⑥ 本卡零实现、零原型改动、零 i18n 键。** 改动面 = **本文件** + `design/README.md` 一行（§6）。`BLOCKS.md §B09` 尾注已声明 `[data-attachment-row|name|size]` 为实现侧钩子，与 ③ 无关，不动。

---

## 1. 口径与证据规则

**闭集词表（逐字使用，不得自创）**：`对齐` = 两侧**实测**同值；`一致` = 两侧书面 / 符号级同义（未实测）；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件#符号**」；**禁止行号锚**（本文件不出现任何「文件 + 数字行号」形式的引用）。引文一律**逐字**，含标点。

**证据分级（每条结论必须能归入其中一级）**：

1. **实测** —— 真跑出来的：本轮 `formatFileSize` 取值（纯函数，Node 直跑）与原型 `attachmentSizeLabel` 的逐字转写复核（同一组输入，同一 Node 会话；原始输出见 §7）。
2. **实读** —— 逐符号读过源码 / 原型 / 散文，未运行。
3. **实读未实测** —— 实现侧的**运行行为**本轮一律属此级：本 lane **未**构建 `web/dist`、未起 `taskd`、未驱动浏览器、未进容器。凡涉及运行时的读数，其**独立实测**由 `T-20261014-212017-7`（真 taskd + 真 SQLite + 真 Chromium）与 `T-20261014-212017-4`（真 HTTP 写路径）承担，本文件只引用其结论并给锚点。
4. **不伪造**：未跑的写「未跑」；原型侧未驱动浏览器者，不写「实测」。

**「原型是不是 oracle」的边界（沿用 `design/README.md` 的口径）**：原型是**结构、几何、计算样式**的基线；**内容语义**在原型无真值后端时**不是** oracle。本文件三处口径全部落在**语义**侧 —— 因此 oracle 是**实现**（裁定逐条如此：① 「维持实现」、③ 「准予维持（实现）」），而**不是**原型的字面文案。

---

## 2. Acceptance ① —— 逐处「改动前 / 改动后」引文

三处各给「改动前」（漂移的散文 / 原型字面）与「改动后」（本契约钉死的口径）。**「改动前」的散文只存在于团队工作区**（`workspace/T-20261014-212017-3/design-spec.md`），仓内 `design/**` 此前**不承载**这三处任何一处 —— 这正是卡面前提订正的实测结论（`T-20261015-065623` `kind=change` 评论：① §4.4 方向散文只在工作区；② 仓内无抽屉附件编辑语义；③ `design/`、`docs/` 无 KiB/KB 尺寸文案）。

### 2.1 ① `depends_on` 方向

**改动前（散文口径 = 出边）** —— `workspace/T-20261014-212017-3/design-spec.md` §4.4：

> **设计裁定**：`depends_on` ↔ 关系类型 `blocks`（……）。`Blocks` 组由只读链接升级为 **B24 chip 组合**（抽屉 hook 族），Parent/Related 保持只读。

> 注：以上「改动前」引文中的外部协议章节锚已于 2026-10-22 略去（以 `（……）` 代记），命题不变；产品口径见 §3.1 与 `src/core/domain/relation.mjs`。

> **种子**：openDetail 在 relations `fill()` 后，遍历 `.td-rel[data-detail-relations]` 中 `relations.blocks` 的 `.td-rel-item` 内的 `[data-relation-link]`，对每个标识符 `addComboChip($dependsInput, COMBO.detailDepends, id, "")`，随后**移除该 `.td-rel-item`**（Blocks 改由 chip 组合承载，避免双源）。

**改动前（原型本体的同款写法）** —— `design/prototype/app.js`（`openDetail` 内，`depends_on` 注释与种子循环）：

> `/* depends_on. The card's `blocks` relation and this control are the same fact, so the card is the seed: each read-only link becomes a chip, and the row that carried them goes — one fact, one source, from here on the chips. */`
> `if (!$item.find('[data-i18n="relations.blocks"]').length) return;`

> 注：该原型注释已随 `design/prototype/app.js` 同步刷新（2026-10-22）；只删去外部协议章节锚，句子其余部分不变。

⇒ 两侧的**种子源**都是抽屉 Relations 段里**标着 `relations.blocks`（`Blocks` / `阻塞`）那一行**（`design/prototype/index.html`：`<span class="td-rel-item">` 内 `data-i18n="relations.blocks"` + 若干 `[data-relation-link]`，例如 `TD-130`、`TD-126`）。该行的自然读法 =「本卡阻塞了谁」= **出边**；原型无真值后端，无法自证方向 ⇒ 散文把出边当成了 `depends_on` 的种子。

**改动后（本契约 §3.1）** —— chips = 该任务的**依赖 / 入边**：

> 抽屉 `depends_on` chips 的**每一项**都是**该任务在等的一张卡**（前置任务）。数据来源 = wire 的 **`blocked_by`** 数组（`source` = 前置任务、`target` = 本卡）；渲染只取 `target === 本卡` 的行，chip 文本 = `source` 那张卡的 `identifier`。写一条 `depends_on` = 落一条 `blocks` 边，**`source` = 前置任务**、`target` = 本卡。

### 2.2 ② 附件移除语义

**改动前（散文只到 DOM 层；无存储语义）** —— `workspace/T-20261014-212017-3/design-spec.md` §4.3：

> 移除：`[data-attachment-remove]` ⇒ 删除该行；若区内无行则追加空态 `[data-i18n="attachments.none"]`；`detailCommit("attachments", false)`。

**改动前（原型本体同款）** —— `design/prototype/app.js`（`[data-attachment-remove]` 处理器）：只把该 `.td-file` 行从抽屉里摘掉（无后端，红线禁止原型带实现）。⇒ 散文与原型都**只描述行的消失**，对「字节去哪了」「可不可恢复」**沉默**：这是**缺失口径**，不是「原型说软删」。

**改动后（本契约 §3.2）** —— 移除 = **硬删**：

> 移除一个附件 = **行与字节同去**，在**一个动作**内完成，不可恢复。行删除与字节改名在**同一个持有写锁的事务**内；staging 文件仅在该事务**提交后**丢弃。不留墓碑（不引入 `deleted_at`）、不留孤儿字节；**重传即恢复路径**；移除后该附件的下载端点答 `404`。

### 2.3 ③ 尺寸文案（D6）

**改动前（原型字面）** —— `design/prototype/app.js#attachmentSizeLabel`（逐字）：

> `/* A size read off the picked file, stated the way the card states it: whole KB below a megabyte, one decimal above, and never a bare zero. */`
> `if (!bytes || bytes < 0) return "0 KB";`
> `if (bytes < 1024) return "1 KB";`
> `if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";`
> `return (bytes / (1024 * 1024)).toFixed(1) + " MB";`

⇒ 原型的两段式：**不足 1 KiB 一律报 `"1 KB"`**（实测 `17` ⇒ `"1 KB"`），**零 / 缺失一律报 `"0 KB"`**（实测 `0`、`undefined`、`NaN` ⇒ `"0 KB"`）。原型运行时的夹具是 `12 KB` / `248 KB` / `1.2 MB` 一档（`design/prototype/index.html` 的 `.td-file-size` 行），**该分支在原型里根本走不到** —— 这处偏离是**源码级**确立的（`T-20261014-212017-7` 差异表 D6 的「机械推断」列原文：「源码级确立（原型运行时夹具为 12 KB，该分支不出现）」）。

**改动后（本契约 §3.3）** —— 实现的三段式，**登记为已声明的可见文案偏离**：

> `formatFileSize(bytes)`：非有限值或负值 ⇒ `""`；`< 1 KiB` ⇒ `"<n> B"`（整数字节）；`< 1 MiB` ⇒ `"<max(1, n)> KB"`；否则 `"<n.n> MB"`。**偏离成立且被准予**：实现比原型**更精确**（报出真实字节数而非把 `<1 KiB` 抬成 `"1 KB"`），且**不改信息层级**（仍是「名 + 尺寸 + 动作」一行）；可见影响为 **P4（极低）**。

---

## 3. 三处口径条款（可实现、可验证）

### 3.1 `depends_on` 方向 = 甲（入边）

**术语**：`depends_on` **不是**一列、也不是一种关系类型 —— 它是 `blocks` 边在「等待者」这一侧的**反向视图**。

**存储编码（唯一表示）**

| 面 | 锚点 | 事实 |
|---|---|---|
| 关系类型 | `src/core/domain/relation.mjs#normalizeRelation` | `blocks` 是三种关系类型之一（`parent` / `blocks` / `related`） |
| 方向约定 | `src/core/commands/relations.mjs#addRelation` 注释 | 「A `blocks` edge is a `depends_on` link (the drawer's ④): **source is the prerequisite, target is the card that waits on it**」 |
| 读（入边） | `src/core/storage/repositories/relations.mjs#listBlockerOf` | `SELECT * FROM task_relations WHERE relation_type = 'blocks' AND **target_task_id = ?**` ⇒ 指向本卡的边（本卡的前置任务） |
| 读（出边） | `src/core/storage/repositories/relations.mjs#listBlockedBy` | 同式但 `**source_task_id = ?**` ⇒ 本卡阻塞的卡（**不是** chips 的来源） |
| 列表面 | `src/core/commands/relations.mjs#listRelations` | `{ relations, children, ancestors, blockedBy: listBlockerOf(id), blocks: listBlockedBy(id) }` |
| wire | `src/server/routes/relations.mjs`（`GET /api/v1/tasks/:ref/relations`） | 回 `blocked_by` = `listing.blockedBy.map(relationToWire)`；`blocks` = `listing.blocks.map(...)`。`relationToWire` 形状 = `{ id, type, source, target, origin, created_at }`（`src/shared/wire.mjs#relationToWire`） |
| CLI | `src/cli/commands/relation.mjs`（`relation list`） | 打印 `["blocked_by", r.source, "#" + r.id]` —— 入边行的**第三列即前置任务标识符** |
| 渲染 | `web/src/stores/board.js#detailDepends` | 读 `board.detail.relations.blocked_by`，**筛 `row.target === 本卡 id`**，chip 文本 = `board.tasks` 里 `row.source` 那张卡的 `identifier`；chip 同时携带 `relationId`（= 移除用的边 id） |
| 写 | `web/src/stores/board.js#addDepends` | `api.addRelation(ref, { type: "blocks", **target: task.id** })`，其中 `ref` = 前置任务的 id（或标识符） |
| 移除 | `web/src/stores/board.js#removeDepends` | 按 `relationId` 删边（板上没有 `depends_on` 语法糖） |
| md 口径 | `src/core/storage/md/import.mjs` 头注 | 「`depends_on: [X]` means X must finish before this card, so the edge is `blocks` with **source = X (the blocker), target = this task** — the M5 ruling」 |
| md 回写 | `src/core/storage/md/export.mjs` | 由 **`listBlockerOf(task)`** 重建 `depends_on`（同一方向的双向一致） |

**排版面**：抽屉 Relations 段的 `Blocks` 行由 chip 组合**取代**（同一事实不留两个源）。原型侧同一句写在 `design/prototype/app.js` 的 `openDetail` 内（「the row that carried them goes — one fact, one source」），实现侧同一句写在 `web/src/components/detail/DetailDrawer.vue` 的 `relationGroups` 计算属性里（`if (link.type === "blocks") continue;`）与 `[data-detail-depends]` 的模板注释里（「The card's **prerequisites** are an editable multi-select…」）。**两处排版一致；分歧只在「取哪一侧的边」，本契约裁定为入边。**

**失败路径（方向的下游后果）**：写一条会成环的 `depends_on`（含自指）被**服务端**的关系守卫拒绝 —— `assertBlockEdgeAllowed`（`src/core/domain/relation.mjs#assertBlockEdgeAllowed`，`wouldCreateBlockCycle`）抛 `RELATION_CYCLE`；DB 侧另有触发器 `0017_block_cycle.sql` 二次兜底。客户端**不复制**这次图遍历（`web/src/stores/board.js#addDepends` 注释：「the board's relation guards are the guarantee, and this client does not duplicate the graph walk it could only get wrong」），只把错误码翻成一句人话。

**一处易升格为「口径」的细节**：`listBlockedBy` 这个名字读起来像「本卡被谁阻塞」，但它返回的是「**本卡阻塞的卡**」（`source = 本卡`）—— 与它的兄弟 `listBlockerOf`（「本卡的阻塞者」，`target = 本卡`）**正好相反**。wire 字段 `blocked_by` 绑的是 `listBlockerOf`，所以**wire 字段名是准的**；只有仓库方法名 `listBlockedBy` 反直觉。本契约把它点出来，**不改名**（改名会波及 `listRelations`、路由与测试）。

### 3.2 附件移除 = 硬删

**一句话**：移除一个附件，**行与字节同去，不可恢复，重传即恢复路径**。

**依据（裁定）**：`T-20261014-212017-4` 的裁定，`src/server/routes/attachments.mjs` 头注 §「Removal is a hard delete, and it is one act」逐字：

> 「T-20261014-212017-4's ruling: an attachment is removed **for good** — the row and its bytes go together. Nothing here is recoverable, and re-uploading the file is the whole recovery story. The alternative (a `deleted_at` column) would buy an undo the drawer does not offer while leaving the bytes on disk for a reader to find, which is a worse answer to "is it gone?" than "yes".」

**动作的原子性（`removeAttachmentRow`，`src/server/routes/attachments.mjs#removeAttachmentRow`）**：

1. 事务外先算 staging 名 `${path}.<newId()>.part`；
2. 事务内：`existsSync(path)` ⇒ `renameSync(path, staged)`（**字节先离位**）⇒ `attachments.remove(id)`（**行后删除**，删不到则抛 `NOT_FOUND`）；
3. 事务**提交之后**才 `rmSync(staged, { force: true })` 丢弃 staging。

⇒ 三条边界逐条被覆盖：**被拒的写**（`DB_BUSY` 耗尽重试预算、行在手下消失）把字节 `renameSync` 回原位、事务回滚恢复行 ⇒ 板回到原样；**重试**重跑函数体，`existsSync` 守卫使 rename 幂等（第二趟字节已在 staging）；**没有字节的行**（`PUT …/content` 从未到达）是**寻常情形**不是错误（无物可 rename，行照删）。**提交后的 `rmSync` 失败被有意吞掉**：留下的 `.part` 是垃圾，而在此抛错会把一次**已经发生**的删除报成失败。

**可见后果**：`DELETE /api/v1/attachments/:id` 答 `{ removed: true, attachment: … }`（`src/server/routes/attachments.mjs`，路由声明 `DELETE /api/v1/attachments/:id`）；此后 `GET /api/v1/tasks/:ref/attachments` 的列表里**不再有该行**，`GET /api/v1/attachments/:id/content` 答 **`404`**（`-4` 报告实测：「移除 ⇒ 列表 0 行**且** content 端点转 `404`（硬删，行与字节同去）」）。抽屉侧 `web/src/stores/board.js#removeAttachment` 的注释即一句口径：「Remove an attachment **for good** (the board hard-deletes the row and its bytes)」，移除后 `reloadDetailAttachments()` 重读列表（**chips / 行一律以板答为准**，不本地乐观删）。

**上传窗口一侧的对称条款（非本卡范围，但同一张存储面的另一半，登记以免误读）**：上传是**两个请求**（`POST …/attachments` 铸行 + `PUT …/content` 存字节），行先落、字节后半程失败 ⇒ 客户端**回滚该行**（`uploadAttachment` 的 catch 里 `removeAttachment(id)`），不留零字节幽灵。⇒ 「行数 = 文件数」这条不变量由**客户端**在失败路径上补，不是服务端事务的一部分。

### 3.3 尺寸文案（D6）—— 已声明的可见文案偏离

**偏离登记（本卡的核心交付物）**

| | 原型（`design/prototype/app.js#attachmentSizeLabel`） | 实现（`web/src/lib/attachments.js#formatFileSize`） |
|---|---|---|
| `< 1 KiB` | `"1 KB"` | `"<n> B"`（如 `17` ⇒ `"17 B"`） |
| 非数值 / 负值（`undefined`/`NaN`/`-1`） | `"0 KB"` | `""`（空串） |
| 字面零（`0`） | `"0 KB"` | **`"0 B"`**（见下方口径精度） |
| `< 1 MiB` | `"<round(n/1024)> KB"` | `"<max(1, round(n/1024))> KB"` |
| `≥ 1 MiB` | `"<n.n> MB"` | `"<n.n> MB"`（**一致**） |

**裁定**：`T-20261014-212017-7` `kind=decision`（2026-10-14T22:53:31.043Z）：

> 「**D6 尺寸文案偏离（17 B / 空 vs 1 KB / 0 KB）→ 准予维持**（登记为已声明的可见文案偏离，`kind=change` 记 what+why）：实现更精确且不改信息层级；P4 极低。设计侧文案同步下一轮对齐（owner Jobs）。**不另开卡。**」

**口径精度（必读；本节是本卡对裁定的唯一补充）**：裁定的简写「`17 B` / **空**」里的「空」= `formatFileSize` 的**非数值守卫**（`!Number.isFinite(size) || size < 0` ⇒ `""`），**不是**「零 ⇒ 空」。实测：`formatFileSize(0)` = **`"0 B"`**。⇒ 下游**不得**把这条写成「`0` ⇒ `""`」。

而且，**从 wire 来的行永远走不到 `""`**：`src/shared/wire.mjs#attachmentToWire` 回 `size: attachment.size ?? 0`，仓储 `src/core/storage/repositories/attachments.mjs#insert` / `#setSize` 只存**非负整数**（负数抛 `VALIDATION_FAILED`）⇒ 可触及的输出是 `"0 B"`、`"17 B"`、`"12 KB"`、`"1.2 MB"`。`""` 是**防御性守卫**（喂进去的若不是数，宁可空，也不印 `NaN B`）。

**落点（可见面）**：`web/src/lib/attachments.js#attachmentRows` 把每行映射成 `{ id, name, size: formatFileSize(file.size), contentType }`；抽屉渲染 `<span class="td-file-size" data-attachment-size>{{ file.size }}</span>`（`web/src/components/detail/DetailDrawer.vue`）。原型侧同一席位的 class 是 `.td-file-size`（原型**不**带 `data-attachment-size`，该钩子是实现侧独有并由 `test/web/blocks.contract.mjs` §B09 背书，`design/BLOCKS.md` §B09 尾注已登记）—— 这条与 D6 **正交**，本卡不动。

**一处必须点名的算子差（同席位的第二个字面差，一并登记）**：`< 1 MiB` 档，原型用 `Math.round(n/1024)`、实现用 `Math.max(1, Math.round(n/1024))`。当 `1024 ≤ n < 1536` 时两者都出 `"1 KB"`；差出现于**进位的下界附近** —— 实测 `1048575` 两侧都出 `"1024 KB"`，故**可观测差别只在「是否可能印出 `0 KB`」**：原型的 `round` 在 `n ∈ [0,1024)` 区间被上一行的 `1 KB` 提前截住，实现的 `max(1, …)` 是同一意图的显式写法（「有字节就不报 0」）。⇒ 两侧在这条上的**意图一致**，不构成新偏离；登记以示已核。

---

## 4. Acceptance ② —— 与实现对齐的判据（可核）

本卡的 ② 是「**不得引入与实现相反的口径**」。判据是：**本文件 §3 的每条都能在实现里找到一个逐字锚点，且没有第二条相反的定义**。逐条：

| 条款 | 判据（实现锚点） | 反例（若本契约写反会命中什么） |
|---|---|---|
| ① chips = 入边 | `web/src/stores/board.js#detailDepends` 读 `relations.blocked_by` 并筛 `row.target === 本卡 id`；`#addDepends` 写 `{ type: "blocks", target: task.id }` | 若写成出边，锚点会落在 `relations.blocks` 或 `#listBlockedBy` —— 本文件对这两者的描述是**反例说明**（§3.1 末段「一处易升格的细节」），不是条款 |
| ② 硬删 | `src/server/routes/attachments.mjs#removeAttachmentRow`（rename + 行删同事务、提交后丢弃 staging）；`web/src/stores/board.js#removeAttachment` 注释「for good」 | 若写成软删，会引用 `deleted_at` —— 而**该列不存在**：`src/core/storage/migrations/` 零命中；`src/` 全文唯一一处 `deleted_at` 是 `attachments.mjs` 头注里点名的**被否决备选**（「The alternative (a `deleted_at` column) would …」） |
| ③ 三段式文案 | `web/src/lib/attachments.js#formatFileSize` 三个分支 + 非数值守卫 | 若写成原型两段式，会与实测值 `"17 B"` / `"0 B"` 冲突（§7 原始输出） |

**复核命令（宿主允许项：纯静态 / 纯函数；未跑容器、未起 taskd）**：

```bash
# ① 方向：入边是 chips 的来源，出边不是
grep -n "blocked_by" web/src/stores/board.js src/server/routes/relations.mjs
grep -n "target: task.id" web/src/stores/board.js
# ② 硬删：无墓碑列
grep -rn "deleted_at" src/core/storage/migrations/ ; echo "expect no matches (exit 1) — no tombstone column"
grep -rn "deleted_at" src/   # ⇒ 唯一一处 = attachments.mjs 注释里被否决的备选
grep -n "for good" src/server/routes/attachments.mjs web/src/stores/board.js
# ③ 尺寸：三段式 + 守卫
grep -n "Math.max(1" web/src/lib/attachments.js
node --input-type=module -e "import('./web/src/lib/attachments.js').then(m => console.log(m.formatFileSize(17), JSON.stringify(m.formatFileSize(0)), JSON.stringify(m.formatFileSize(undefined))))"
# ⇒ 17 B  "0 B"  ""
```

第二条命令的 `grep "deleted_at"` **期望零命中** —— 本文件把「无墓碑」当**条款**（§3.2），故它必须可被证伪。

---

## 5. Acceptance ③ —— 未改动的面

- **`design/prototype/**` 一行未改。** 本 lane 未写 `index.html` / `app.js` / `tw.css` / `vendor/**` / `src/input.css`。原型是**只读基线**（`design/README.md` §Status：「The prototype remains the read-only design baseline contract for the frontend」）。
- **不需要「独立注记文件」。** 卡面 ③ 允许「若原型本身需注记，用独立注记文件」；本轮认定**不需要**：三处口径里，只有 ① 与原型本体有关，而**原型本体并没有「说错」**—— 它的注释只说「`blocks` 关系与本控件是同一事实」（`design/prototype/app.js`），**没有**断言方向；说错方向的是**工作区散文**（§2.1），而散文不在仓内、不入版本。⇒ 原型的注释**保持原样**，方向由本契约钉死，**无需注记文件**。
- **`design/DESIGN.md` / `design/BLOCKS.md` 未改。** 两条理由：① 本卡 `kind=decision` 的裁定原文明确「**不改** `design/prototype/**`、不改 `DESIGN.md`/`BLOCKS.md`」（「`DESIGN.md`/`BLOCKS.md` 正被别的 lane 写入」—— 文件级冲突面最小化）；② **实测它们不承载这三处口径**：`grep "depends_on" design/DESIGN.md` 零命中；`design/BLOCKS.md` 只在卡片 scalars 里列 `data-relations-blocks`（B07 的卡面属性，与抽屉编辑方向无关），无 KiB/KB 尺寸文案。⇒ 「不改」不留下任何与本契约矛盾的散文。
- **零 i18n 键、零实现、零测试改动。** 本卡不新增 `data-i18n*` 钩子，不动 `test/**`、`src/**`、`web/**`、`server/**`。

---

## 6. 落点与索引

- **落点 = 新建本文件**（裁定 = **甲**，`T-20261015-065623` 的 `kind=decision` 2026-10-14T23:11Z）。理由逐条（裁定原文）：① 严格落在卡面写面 `design/**`（另一选项会越出到团队工作区、不入仓版本、无单一事实源）；② 仓内有先例 —— `design/contracts/project-prefix-binding.md` 头注即「执行方把卡工作区 `design-spec.md` 写成的契约文档」，且 `design/README.md` 已把 `contracts/` 定义为 topic-scoped 单一事实源；③ 单文件冲突面最小。
- **索引 = `design/README.md` 的 `contracts/` 段补一句**（本卡唯一的第二处改动）。该段现行写法是把四份契约逐一列名并各给一句「它管什么」；本文件按同一句式追加一条。
- **本文件不并入任何编号 fidelity 轮**（`fidelity-r*.md` 是轮记录，本文件是 topic-scoped 契约，与 `contracts/` 家族同款）。

---

## 7. 证据与复跑（原始输出）

**复跑环境**：宿主 Node（`docs/docker.md` §Host-allowed checks 的宿主允许项 —— 纯函数直跑属静态检查，非「运行应用」）。**未进容器、未起 taskd、未驱动浏览器。**

**7.1 实现的 `formatFileSize`（实测，`web/src/lib/attachments.js`，真 import）**

```bash
node --input-type=module -e "
import { formatFileSize, attachmentRows } from './web/src/lib/attachments.js';
const vals = [0, 1, 17, 1023, 1024, 1536, 1048575, 1048576, 1572864, undefined, null, NaN, -1, 'abc'];
for (const v of vals) console.log(String(v).padEnd(10), '=>', JSON.stringify(formatFileSize(v)));
"
```

原始输出：

```text
0          => "0 B"
1          => "1 B"
17         => "17 B"
1023       => "1023 B"
1024       => "1 KB"
1536       => "2 KB"
1048575    => "1024 KB"
1048576    => "1.0 MB"
1572864    => "1.5 MB"
undefined  => ""
null       => "0 B"
NaN        => ""
-1         => ""
abc        => ""
```

`attachmentRows([{ id: 'a1', filename: 'x.md' }])`（缺 `size`）⇒ `[{"id":"a1","name":"x.md","size":"","contentType":null}]` —— 即**缺尺寸的行渲染成空串**；这是 `""` 分支在行级唯一可触达的入口。

**7.2 原型的 `attachmentSizeLabel`（逐字转写复核）**

原型函数闭包在 `app.js` 的 IIFE 内、未导出，故按 §2.3 的**逐字转写**在同一 Node 会话重跑（标为转写，非原型模块真实 import）：

```bash
node -e "
function proto(bytes) {
  if (!bytes || bytes < 0) return '0 KB';
  if (bytes < 1024) return '1 KB';
  if (bytes < 1024*1024) return Math.round(bytes/1024) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
for (const v of [0,1,17,1023,1024,1536,1048575,1048576,1572864,undefined,null,NaN,-1]) console.log(String(v).padEnd(10), '=>', JSON.stringify(proto(v)));
"
```

原始输出：

```text
0          => "0 KB"
1          => "1 KB"
17         => "1 KB"
1023       => "1 KB"
1024       => "1 KB"
1536       => "2 KB"
1048575    => "1024 KB"
1048576    => "1.0 MB"
1572864    => "1.5 MB"
undefined  => "0 KB"
null       => "0 KB"
NaN        => "0 KB"
-1         => "0 KB"
```

⇒ §3.3 表里 `≥ 1 MiB` 一行的「一致」= 本表与 7.1 表在 `1048576` / `1572864` 两行**同值**（`"1.0 MB"` / `"1.5 MB"`），其余各行按表列的偏离成立。

**7.3 引用他人的运行时读数（非本 lane 实测，如实标注）**

| 结论 | 来源 | 证据指针 |
|---|---|---|
| chips 取**入边**（判别夹具同时有入/出边） | `T-20261014-212017-7`（真 taskd + 真 Chromium） | 报告「§5.1 chips 取入边 **成立**（判别夹具 `delta`：入边 gamma / 出边 epsilon ⇒ chips = `["PROBE-0004"]` = gamma）」；`workspace/T-20261014-212017-7/report.md` |
| 附件移除 ⇒ 列表 0 行 **且** content 端点 `404` | `T-20261014-212017-4`（真 HTTP 写路径） | 报告 ④ 附件：「移除 ⇒ 列表 0 行**且** content 端点转 `404`（硬删，行与字节同去）」；`workspace/T-20261014-212017-4/report.md` |
| D6 偏离为**源码级**确立（原型运行时夹具走不到该分支） | `T-20261014-212017-7` | 差异表 D6 行；`workspace/T-20261014-212017-7/report.md` |

---

## 8. 边界、未决与出界项

- **本卡不动实现。** 三处的裁定一律「维持 / 追认 / 准予实现」，**没有一处要求改实现**（`T-20261014-212017-7` D1：「…不动实现」）。若后续有人把 §3 读成「实现待改清单」，那是误读。
- **出界项（同轮裁定、不在本卡三项之内）：D8 失败 toast（准予）。** `T-20261014-212017-7` 同一条评论还裁定了：实现的失败路径**多一条 toast**（原型无 toast 调用点），性质为「原型遗漏的最小补充」（原型无服务端），已声明非静默 ⇒ **准予**、**登记**、不另开卡。**本卡只承接 ① ② ③ 三项**（卡面 `goal` 与 `Acceptance` 逐字如此），**不在此处补写 D8 契约**；若需要，另立设计侧登记卡。
- **未决不新增。** 本文件不向 Elon 提新问题：三处裁定均有原文，落点亦已裁定为甲。
- **一处**口径精度**已在 §3.3 登记**（裁定简写的「空」= 非数值守卫，不是「零 ⇒ 空」），它**不与裁定冲突**：裁定的实体条款是「维持**实现**」，而实现的实测行为即 §3.3 的三段式。本节把它写明，是为了杜绝下游把它反向读成一条实现要改的要求。
- **`design/BLOCKS.md` 的一句话不动。** 「`[data-attachment-row|name|size]` 是实现侧钩子、原型不得回填」（§B09 尾注）与 D6 正交；本文件引它仅为定位可见席位，不改它一个字。

## 9. 修订记录

### v1.0 —— `T-20261015-065623`（doc-only；写面 `design/contracts/**` + `design/README.md` 一行；基线 `103d8cb`）

**一句话**：把 `T-20261014-212017-7` 的 D1 / D2 / D6 三条裁定写成一份可核契约（本文件），并给 `design/README.md` 的 `contracts/` 段补索引一行。零实现、零原型改动、零 i18n 键。

| 处 | 内容 | 依据 |
|---|---|---|
| §2.1 / §3.1 | `depends_on` 方向 = **入边**（`blocked_by`）；写边 `source` = 前置任务、`target` = 本卡 | `-7` D1（甲）；实现锚点见 §3.1 表 |
| §2.2 / §3.2 | 附件移除 = **硬删**（行与字节同去、不可恢复、无墓碑、`404`） | `-7` D2（追认）；`-4` 实测读数 |
| §2.3 / §3.3 | 尺寸文案 = **已声明的可见文案偏离**（三段式 vs 两段式），实现维持；附**口径精度**一条 | `-7` D6（准予维持）；本轮实测（§7） |
| §4 | 与实现对齐的**可核判据**（含一条期望零命中的反证命令） | 卡面 Acceptance ② |
| §5 | **未改动面**声明（原型 / DESIGN / BLOCKS / 实现 / 测试） | 卡面 Acceptance ③；`kind=decision` 落点裁定 |

### v1.1 —— 2026-10-22（doc-only；写面 `design/contracts/**`）

**一句话**：清除两处「改动前」引文中的外部协议文档章节锚；原型本体的同款注释已同步刷新。命题、判据与实现锚点一字未动。

| 处 | 订正 / 登记 | 依据 |
|---|---|---|
| §2.1 第一段引文 | 外部章节锚以 `（……）` 代记，并加日期说明；命题不变 | 外部文档不在本仓库，锚点不可解析 |
| §2.1 第二段引文 | 与 `design/prototype/app.js` 的新注释同步；仅删去外部锚 | 原型同步修改 |
