# T-20261012-234655 — 并发加固独立验证（R1/R2/R3 复跑）Report

**结论：PASS** —— R1 ✓ / R2 ✓（含 DEF-234655-R2 残留路径闭环）/ R3 ✓；无 diff 相关回归红；4 条变异均有牙齿。

| | |
|---|---|
| 卡 | `/Users/tanyu/.openclaw/team/tasks/T-20261012-234655.md` |
| 被测对象（SUT） | lane HEAD `7cb8e42ae688596f449795586e2640d6e7fb4308`（`lane/T-20261012-234655-seg1`） |
| R2 修复提交 | `b6eab96` `fix(server): R2 residual — the attachment content write joins the 503 path`（是 HEAD 祖先） |
| 只读性 | 未改仓库树、未 push。`git status` 仅 `docs/verify/T-20261012-234655/`（本卡证据） |
| 证据 | `docs/verify/T-20261012-234655/evidence/**`，逐文件 sha256 见 `evidence/MANIFEST.txt` |
| ⚠ 提交受阻 | 本 lane 沙箱把 `.git` 挂成只读（`index.lock: Operation not permitted`，主仓 `.git` 亦不可写）⇒ **无法创建 commit**。分支 `lane/T-20261012-234655-seg1` 仍停在 `7cb8e42`（无新提交）。交付改为「工作树内文件 + `integration.patch`」，二者见 §7 |

## 0 环境判据（先说清楚，否则下面的数字会被误读）

本 lane 沙箱**禁 `bind(2)`**：`127.0.0.1:0`、`127.0.0.1:8765`、`::1`、`0.0.0.0`、AF_UNIX 全部 `EPERM`（`evidence/env-listen-eperm.log`）。直跑 `src/server/main.mjs` 得 `taskd: Error: listen EPERM: operation not permitted 127.0.0.1`，指针永不落盘。

⇒ 一切真 socket 测试在本 lane 必红，且**与本 diff 无关**（工作树与 HEAD 逐字节相同）。应对：

1. R1/R2 的线上语义用**进程内 HTTP 夹具** `evidence/lib/inproc-http.mjs`：把请求直接交给 `createServer(handler)` 注册的**真实 request listener**（真实 router / `errorResponse` / `mapSqliteError` / `handleAttachmentContent`），仅替换 socket 层（`writeHead`+`end` 是本 server 的全部应答契约）；
2. **锁竞争仍是真实的跨进程 SQLite 写锁**（另起进程 `BEGIN IMMEDIATE` 持同一 DB 文件），不是模拟。

## 1 R2 重测（重点：`PUT /api/v1/attachments/:id/content`）

`node docs/verify/T-20261012-234655/evidence/r2-wire-busy.mjs` → **exit 0**（输出 `evidence/r2-probe.log`）

| 场景 | 结果 |
|---|---|
| 持锁 **8s**（>5s），固定 `busy_timeout=5000ms` × 3 次重试 | **200**，`elapsed 8048ms` —— 有界重试**吸收**了竞争，且**非 500** |
| 持锁 **6s**（>5s），`busy_timeout=1000ms` × 3（预算耗尽） | **503 `DB_BUSY` + `Retry-After: 1`**，`details.op=attachments.setSize`，`elapsed 3380ms` |
| 持锁 250ms（预算内，`busy_timeout=100ms`） | **200**，行 `size=65536` 与盘上字节一致，GET 回读 65536B |
| 被拒的那次写 | `size` 仍为 0，附件目录**无 `.part` 残留**（拒绝不留痕） |

旧 DEF-234655-R2 形态（`500 VALIDATION_FAILED / database is locked`）已消失；只有在把修复注回旧写法后才复现（见 §5 变异 B）。

## 2 R1 回归（多实例护栏）

- `node --test test/concurrency/writer-guard.test.mjs` → exit 1，**tests 11 / pass 10 / fail 1**；唯一红是「two real daemons」（需要真 socket）⇒ 环境项。指针归属、化石锁、单实例规则 10/10 绿。
- 跨进程补证 `node docs/verify/T-20261012-234655/evidence/r1-lock-and-pointer.mjs` → **exit 0**：
  - 第二真实进程被拒：`REFUSED BOARD_ALREADY_RUNNING http=409`（exit 1，非 0）；
  - **非属主实例退出不误删活指针**：子进程 `removeRuntimePointer({pid: 自身})` → `removed=false`，指针文件**字节不变**且仍指向活实例；属主退出时才删（返回 `true`）；
  - 属主 SIGTERM → 自己的锁被释放；属主 SIGKILL 留下的**化石锁**被后继进程记录 `writer_lock_stale` 后接管。

## 3 R3 回归（裸 repo API 收敛）

- `node --test test/concurrency/repository-boundary.test.mjs` → **exit 0，8/8**。
- `node docs/verify/T-20261012-234655/evidence/r3-bare-repo.mjs` → **exit 0**（`evidence/r3-probe.log`）：
  - `claimCas` 后裸 `stealStaleClaim`（同刻 bound / 宽松到明天 / 缺 bound 字段）一律 `VALIDATION_FAILED/400`，`claimedBy=linus`、`version` 不变（**不双写**）；
  - **真并发**：两个真实进程同时裸 `claimCas` → 恰好 1 个 `claimed=true`，`version` 只 +1；两进程同时裸 `stealStaleClaim`（烂 claim + 严格 bound）→ 恰好 1 个成功，另一个 400，`version` 只 +1；
  - 该偷的仍能偷：真腐烂 claim（一天前）+ 严格 bound → 成功；
  - 源码扫描 116 个文件：`claimCas`/`stealStaleClaim`/`moveCas` 调用点**只在 `src/core/commands/**`**，`src/cli`/`src/server` 无 `repositories/` 直连。
- `node --test test/concurrency/db-busy.test.mjs` → exit 1，tests 13 / pass 6 / fail 7；7 条全是 `listen EPERM`（该套件已从卡的 11 条长到 13 条，其中 6 条不依赖 socket，全绿）。

## 4 回归

- `npm test` → **exit 1**，tests **2204** / pass **1943** / fail **148** / cancelled **111** / skip **2**。
- 归类（`node evidence/classify-failures.mjs evidence/npm-test.log` → `evidence/npm-test-classification.txt`）：

| 类 | 块数 |
|---|---|
| 父测试中止级联（cascade） | 111 |
| 夹具起不来 / 从未应答 `/health`（bind EPERM） | 107 |
| 显式 `listen EPERM` | 71 |
| 覆盖率门被饿死（src/cli、src/server 覆盖不达标，因其 socket 测试全跑不起来） | 2 |
| **无法归因环境的** | **0** |

- 互补正证：把 34 个含红的文件剔掉，剩 **114 个无 socket 依赖的测试文件**（`evidence/socket-free-test-files.txt`）→ `node --test <114 files>` **exit 0**，tests **1652** / pass **1650** / fail **0** / skip 2。
- `npm run verify` → exit 0（manifests 7 / skill OK / migrations 16）。`npm run check:skills` → exit 0（payload + 4 plugin 镜像同步）。
- `npm run verify:docker` → exit 1：`docker.sock: operation not permitted`（沙箱禁 socket）。**环境项，按 Elon 口径不阻断**；也因此无法在本 lane 复跑 Elon 点名的容器门 ENOSPC 场景。

## 5 变异/反例（有牙齿）

全部在 `git archive HEAD` 的**纯净副本**上施加（不改 lane 工作树）：`bash docs/verify/T-20261012-234655/evidence/mutations.sh`，产物 `evidence/mutations/**` 与 `mutations.txt`。

| 变异 | 新红断言 | 结论 |
|---|---|---|
| A：删掉指针的 pid 属主校验（R1） | `refuses to delete the pointer a live instance is using`（writer-guard 10→9） | 有牙齿 |
| B：附件写退回裸 `.run()`（R2 旧写法） | r2 探针该 200 处得 **500 `VALIDATION_FAILED`**（正是 DEF-234655-R2 形态） | 有牙齿 |
| C：重试预算塌成 1 次（R2） | db-busy：`retries an outermost transaction…`、`gives up after the budget…` 变红 | 有牙齿 |
| D：命令层外注入裸 `claimCas` | repository-boundary 源扫描 + r3 探针同时报 `src/server/rogue-writer.mjs: claimCas` | 有牙齿 |

基线红集在变异后保持不变（只多不少），说明新增红确实来自变异本身。

## 6 未跑 / 不可跑登记

- 真 socket 端到端（两个 `taskd` 同数据目录、HTTP over TCP）：本 lane 禁 bind，改用「进程内夹具 + 跨进程真锁」；TCP 分帧/keep-alive/背压不在 R1/R2/R3 的判据内。
- `npm run verify:docker`：docker socket 被拒（环境）。
- R4/R5：卡未要求，上游 §9 已登记「未做属卡内许可」。

## 7 交付

**提交受阻（须由集成侧补一次 commit）**：本 lane 沙箱把 `.git` 目录设为只读，`git add/commit` 报 `Unable to create '…/.git/worktrees/…/index.lock': Operation not permitted`（主仓 `.git` 同样不可写，已实测）。因此 **分支 `lane/T-20261012-234655-seg1` 仍停在 `7cb8e42`，本卡没有新 commit** —— 请集成方在本 lane 工作树内补一次提交（或直接应用 `integration.patch`）。

- 分支：`lane/T-20261012-234655-seg1`（tip `7cb8e42`，未推进）
- 待集成内容：`docs/verify/T-20261012-234655/**`（report.md + evidence/**），共 35 个新文件
- 可直接应用的补丁：`docs/verify/T-20261012-234655/integration.patch`（`git apply -p1` from repo root；全为新增文件，不改任何实现）
- 建议 commit message：`chore(verify): T-20261012-234655 R1/R2/R3 复跑 — R2 残留闭环 + 变异证据 + Report`
- 证据清单与逐文件 sha256：`docs/verify/T-20261012-234655/evidence/MANIFEST.txt`
