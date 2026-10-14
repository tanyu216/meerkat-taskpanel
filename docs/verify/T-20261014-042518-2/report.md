# T-20261014-042518-2 — 排序路径 R15/R16 缺陷：登记与评估（只读）

- **卡**：TaskPanel — 缺陷登记/评估：排序路径 R15/R16（候选读先截断 limit=200 再过滤；`sort_order` 无生产写入方）
- **性质**：只读登记 / 评估。**未改任何实现文件**（`src/`、`test/`、`design/` 零改动）。
- **分支 / 基线**：`lane/T-20261014-042518-2-seg1` @ `9e4c1aa7b74661d9396511f51685a6e8e5fdcaa8`（起手 = 本卡开工时的 `main`；开工与落笔两次 `git rev-parse HEAD` 一致）
- **证据**：`docs/verify/T-20261014-042518-2/`（本报告 + 复现脚本 + `evidence/`）

---

## 0. 两个必须先说清的前提

### 0.1 权重序**已经实现并落地**，本卡「在实现卡前判定」的前提已失效

| 事件 | 时刻（+0800） |
|---|---|
| 本卡创建（`created_at` 2026-10-13T20:25:18Z） | 2026-10-14 **04:25** |
| 权重序实现 `872f3cd feat(order): assignee 任务权重排序 C-WEIGHT-1` | 2026-10-14 **05:03** |
| 合入 main `bddb308 merge: …（T-20261014-043124）` | 2026-10-14 **07:57** |
| 本卡释放 backlog→todo（comment 2026-10-14T14:01Z） | 2026-10-14 **22:01** |

`git merge-base --is-ancestor 872f3cd HEAD` → **0**（是祖先）。所以本卡不是在「实现前排雷」，
而是在**回溯核验**：这两条今天还阻塞不阻塞、有没有被顺手消解。

### 0.2 卡面的编号与契约的编号**对不上**——按实质登记，不按编号

卡面 Background 把两条缺陷都挂在「契约 §8 R15-R16」下，但契约 §8 的编号是：

| 契约编号 | 契约正文 | 卡面里对应的是 |
|---|---|---|
| **R16** | ① wire 不带依赖数；② **候选读先截断再过滤**（`listCandidates` = `list({status:"todo"})` 默认 `limit=200` 再在 JS 里按 assignee 过滤） | 卡面 **①** |
| **R15** | **`blocked_at` 离开 blocked 后不清空**（`moveCas` 只写不清） | 卡面里**没有**这一条 |
| （无编号） | —— | 卡面 **②**（`sort_order` 无生产写入方）在 §8 里没有专门条目（语境在 §7.1 / §8 R12） |

⇒ 本报告按**实质**登记三条，各给独立结论：**D1 = R16 截断 / D2 = sort_order / D3 = R15 `blocked_at`**。

---

## 1. D1 — 候选读「先截断 `limit=200`，再在 JS 里按 assignee 过滤」（契约 §8 R16 后半）

### 1.1 只读复现

脚本：`docs/verify/T-20261014-042518-2/repro-r15-r16.mjs`（完整输出 `evidence/repro-output.txt`）。
它只用仓库自己的模块，数据落在 `os.tmpdir()` 的一次性目录，**不碰仓库、不碰团队板库、不起服务**。

fixture：同一项目 **207** 张 `todo`——`other` 的 200 张先建（占 ORDER BY 前 200 行），`linus` 的 5 张**最后建**
（`created_at` 递增，故必落在第 201–205 行）。

**旧形状（fix 前的 `listCandidates` 正是这个形状）**：

```
repos.tasks.list({status:"todo"})       -> 200 行（仓库默认 TASK_LIST_DEFAULT_LIMIT=200）
  .filter(t => t.assigneeId === linus)  -> 0 行
linus 在表里实际有                       -> 5 张
=> 5 张可领卡对 poll 读完全不可见
  EXPLAIN QUERY PLAN — 旧形状（只 status + LIMIT ? OFFSET ?）
    10 | 0 | SEARCH tasks USING INDEX ix_tasks_heartbeat (status=?)
    65 | 0 | USE TEMP B-TREE FOR ORDER BY
```

**新形状（HEAD）**：

```
commands.listCandidates({assignee:"linus"}) -> 6 张（5 张 BULK-0200..0204 + 早先建的 seed）
linus 的 todo 卡在表里                       -> 6 张
=> 6 张全部给出，越过了旧的第 200 行断点
```

代码指针（`evidence/code-pointers.txt` 全表）：

- **旧**：`872f3cd^:src/core/commands/tasks.mjs:719` `list({status:"todo"}).filter(isAssignee)`；
  `:810` `allBlockersDone(ctx, taskId)` **逐卡一次读（N+1）**。摘录见 `evidence/prefix-candidates.txt`。
- **截断来源**：`src/shared/constants.mjs:381` `TASK_LIST_DEFAULT_LIMIT = 200`；
  `src/core/storage/repositories/tasks.mjs:178` 无显式 limit 时套用它。
- **新**：`src/core/commands/tasks.mjs:854` `orderedCandidates()`；`:865/868/874` 三处 `limit: null`
  （状态 + assignee 下推到 SQL）；`:880` `relations.openEdgeCounts()` 一次批量边读，
  `src/core/storage/repositories/relations.mjs:176`；`src/core/storage/repositories/tasks.mjs:177` `unbounded`。
- **传输面没有再加 limit**：`src/server/routes/tasks.mjs:229`（candidates 路由不读 limit）、
  `src/cli/commands/issue.mjs:143`（无 `--limit` 旗标）。

### 1.2 结论：**不阻塞——已被权重序实现卡消解；不需要修复卡，也不需要并行**

`872f3cd` 在实现权重序的同时**照契约 §8 R16 的要求**把作用域下推到了 SQL、去掉了 `LIMIT`、
把 N+1 换成一次批量读；这不是本卡要补的洞，是 C2 的实现卡已经履行掉的义务。断言也已落位：

- `test/server/task-order.test.mjs:253` — 「assertion 10: the scope reaches SQL before the order does」（造了越过第 200 行的卡）
- `test/core/commands/task-order-scale.test.mjs:157` — `assert.ok(scope > 200, …)`（单 assignee 作用域 251 张，实跑报告）
- 本卡实跑：三个文件 37 项全绿（`evidence/tests.txt`）

**非阻塞残留（登记，不建议为它单开卡）**：仓库默认 `limit=200` 本身仍在——那是契约 §7.1「默认不变」的承诺
的一部分（默认板序冻结、md 导出复用同一条 `ORDER BY`）；`web/` 的 `limit=500` 在契约「边界之外」。
若要动它们，属于另一张卡的权衡，不属于 R16。

---

## 2. D2 — `sort_order` 无生产写入方（恒 0）（卡面 Background ②）

### 2.1 只读复现

```
SELECT DISTINCT sort_order FROM tasks -> [0]      （208 行、覆盖所有写入路径）
src/ 里唯一的写入方：src/core/storage/md/import.mjs:1100  sortOrder: 0    ← 字面量 0
版序回退：repositories/tasks.mjs:184  ORDER BY sort_order ASC, created_at ASC, project_id ASC, identifier ASC
=> 板内默认序 = 创建顺序（fixture 里 board 序与 identifier 序逐项相同：true）
```

补充事实：`sort_order` **在 wire 上**（`src/shared/wire.mjs:46`），**仓库层可 patch**（`PATCHABLE` 含 `sortOrder`，
`src/core/storage/repositories/tasks.mjs:35`），但**没有任何面暴露它**——HTTP PATCH 的字段集只有
`title/description/priority/kind/labels`（`src/server/routes/tasks.mjs:253`），CLI 无对应旗标。

### 2.2 结论：**不阻塞；不修（本卡范围内）**

理由三条，逐条可核：

1. **权重序完全不读它**：`grep -n sortOrder src/shared/task-order.mjs` → **无匹配**。
   契约 §6.3 的末级全序是 `priority → W → created_at → status → project_id → identifier`，
   与 `sort_order` 无关。⇒ 卡面担心的「在错的一页里排得整整齐齐」**不由这条引起**（那条是 D1，已消解）。
2. **它今天不是缺陷，是一个未启用的产品位**：恒 0 时 `ORDER BY` 退化成创建序，行为与文档一致、无静默错。
   要「修」，先得回答「这块板要不要人工拖拽排序」——那是产品决定，不是缺陷修复。
3. **风险登记（给未来卡，不是给本卡）**：若将来真加写入面，默认板序会从「创建序」变成「人工序」，
   而 md 导出复用了同一条 `ORDER BY`（契约 §2 S1 的字节不变承诺）——**两件事必须一起设计**。

⇒ 建议**不另立 flow B 修复卡**；若 Elon 想关掉「wire 上有、没人写」这个空档，请开**产品决定卡**，
并在卡面里点名「默认序 + md 导出」这对耦合。

---

## 3. D3 — `blocked_at` 离开 `blocked` 后不清空（契约 §8 R15）

### 3.1 只读复现

```
真做一次 move：todo → blocked → in_progress（然后读取该行）
status            = in_progress
blocked_at        = 2026-07-16T12:00:00.000Z   <-- 90 天前的时间戳仍在
blocked_reason    = null                        <-- 离开即清（对照）
status_changed_at = <本次 move 的时刻>
=> 列语义 = 「最近一次进入 blocked 的时刻」，moveCas 只有写入分支、没有清除分支
   （repositories/tasks.mjs:328-331；对照 :322/:326 的 awaiting_reason / blocked_reason 每次 move 都重写）
```

**陷阱的实际大小**（同一行、状态取有 SLA 阈值的 `in_review`、新状态已待 1 小时）：

```
HEAD（门 ON）                 : S.normalised = 0.041667   （1h / 24h）
若 `blocked_at` 未被门住       : S.normalised = 1.0        （90d / 24h，封顶）
delta                         : 0.958333 的加权分 —— 静默、无报错
门的位置：src/shared/task-order.mjs:212
  card.status === "blocked" ? card.blockedAt : card.statusChangedAt || card.createdAt
```

### 3.2 结论：**不阻塞；不修（契约 §11 U10 已明确「本契约不要求改」）**

1. **门已经关严**，且有独立断言：`test/shared/task-order.test.mjs:353`
   「does not read `blocked_at` on a card that is not blocked」（本卡实跑绿）。
2. **「保留上次阻塞起点」是被别人用着的语义，不是遗漏**：
   - md 往返：`test/contract/md-blocked-reason.test.mjs:268` 断言 `blocked_at` 仍标注上次阻塞；
   - 存储层：`test/core/storage/repositories/repositories.test.mjs:217` 明确「只在进入时写、历史保留」；
   - SLA 巡检：`src/shared/sla-patrol.mjs:710-713` 把 `blocked_at` 当 block 的 origin（`confidence: "high"`），
     `measure_start_kind = "blocked_at"` 会出现在告警里。
3. **改成「离开即清」是一次 schema 语义变更**，会同时动 md 往返口径 + 巡检 origin + 上述若干断言，
   影响面未知——契约已把它明确踢给「另开卡评估」（§11 U10）。

**非阻塞残留（登记，给后续卡）**：本卡只核到权重序这一个消费者已上门。`sla-patrol` 也读 `blocked_at`
（`src/shared/sla-patrol.mjs:710-713`）——建议 C3 或一张 patrol 卡顺手确认那条路径同样按 status 门住，
本卡不越界去改。

---

## 4. Acceptance 逐条对照

| # | 要求 | 结果 |
|---|---|---|
| ① | 只读复现两缺陷并给证据指针（查询路径 + `EXPLAIN QUERY PLAN` / 代码符号） | **已给**。复现脚本 + 输出 + 代码指针见 §1–§3 与 `evidence/`（含两形状的 `EXPLAIN QUERY PLAN`、`DISTINCT sort_order`、真 move 后的行读数） |
| ② | 判定各自是否**阻塞**权重序实现，给「先修 / 并行 / 不修（附理由）」 | **已给**：D1 = **不阻塞（已被 C2 实现卡消解 ⇒ 无需动作）**；D2 = **不修**（权重序不读它；要动是产品决定）；D3 = **不修**（门已关严 + 断言在；改语义影响面未知，契约 §11 U10 明确不要求） |
| ③ | 若判定需修 ⇒ 由 Elon 另立 flow B 修复卡；本卡只做登记/评估 | **无需立卡**：三条都不需要修复卡。两条建议路由（非阻塞、不在本卡范围）：(a) `sla-patrol` 的 `blocked_at` 门复核；(b) 「要不要人工排序位」的产品决定卡 |
| ④ | 只读；未 push 报账 | **只读**：`src/`、`test/`、`design/` 零改动；唯一落库内容是 `docs/verify/T-20261014-042518-2/**` 证据档案。**未 push**，见 §5 |

---

## 5. 报账

- **改动面**：无实现改动。`git status --short` 只应出现本卡的证据档案（`docs/verify/T-20261014-042518-2/**`）。
- **执行的验证**：宿主 `node --test`（`docs/docker.md` §Host-allowed checks 明确允许「`node --test` 和 `node --check`」），
  7 组共 161 项全绿（`evidence/tests.txt`）；复现脚本为纯只读、只写 `os.tmpdir()`。
  **未跑容器套件**（本卡只读、无实现改动，无需 `verify:docker`）；**未读线上 `taskd` 的 `.data/board.sqlite`**。
- **集成**：分支 `lane/T-20261014-042518-2-seg1`，commit sha 见下（落笔时 `HEAD` = `9e4c1aa`，本卡只在 `docs/` 追加一个目录）。
- **push**：未 push。
