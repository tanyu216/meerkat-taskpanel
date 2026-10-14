# Report — T-20261014-152924-2 · 独立只读验证：拖拽回 Backlog 的 claim 释放修复 + 全站错误信息用户化

**结论：PASS（①–⑤ 逐条达成，读数全部在 §2）。** 被验 SUT = 本 lane worktree HEAD **`da709a1`**（代码本体 `291bcd3`，测试 `edf20e1`/`da709a1`；base = 当前 main **`7cb8e42`**，未并 main）。
①/② 在**真 SQLite + 真路由处理器 + 真 `errorResponse` 信封**上跑到 26/26 与 19/19；③ 在**真 Chromium + 构建产物**上跑到 28/28（未知/技术 code → zh+en 本地化兜底，界面从不渲染 wire 的 `message`）；
④ 四例负向抽件全部按预期变红、还原三探针全绿；⑤ 被验树零改（`git diff HEAD` 空）。

## 0 · 判定总览

| # | 条目 | 判定 | 关键读数 |
|---|---|---|---|
| ① | `in_progress → todo → backlog` 无 CHECK、落 backlog 后 `claimed_by IS NULL`；`in_progress ↔ awaiting` 期间锁保留 | **PASS** | `todo → backlog` **http 200**（不再 275）；离开周期 `claimed_by/claimed_at/heartbeat_at` 三列同一次 UPDATE 清空；四值锁集 `{in_progress, awaiting, in_review, blocked}` 全程 `claimed_by=linus`。`26/26 checks` |
| ② | 错误信封无技术串，原始 SQL 仅在 `details.sqlite` | **PASS** | 典型失败路径 6 条：`message` 命中 `/constraint failed\|SQLITE\|SqliteError/` = **0**；`details.sqlite.message` 保留原始 SQL（`CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'` 等）。全量扫描 504 + 72 = **576 个信封，0 命中**，引擎原文 72/72 保留 |
| ③ | 未知/技术 code → 本地化兜底人话（zh+en），不渲染 `message` | **PASS** | 真 Chromium：`BRAND_NEW_CODE_2099` → en `That action did not complete …` / zh `操作未完成，请重试或联系管理员。`；`EXECUTION_STATE_CORRUPT` → 同一兜底；映射码 `not_assignee`/`CLAIM_ON_BACKLOG` 各给自己的人话。wire 的 `CHECK constraint failed: …` 在 toast 里 **0** 次出现。源码 + 构建产物 + 渲染页面三读，`28/28 checks` |
| ④ | 负向对抗：旧行为 ⇒ 变红 | **PASS** | M1 claim 释放改回旧形状 ⇒ ① 红 5 条；M2 抽掉 `not_assignee` 的 code→键 ⇒ ③ 红 2 条（兜底命中）；M3 抽掉 `safeMessage` 守卫 ⇒ ② 红 1 条；M4 让 toast 再渲染 wire message ⇒ ③ 红 11 条。**还原后三探针 exit 0** |
| ⑤ | 只读约束 + 未验证项如实登记 | **PASS** | `git status --short` 仅 `?? docs/verify/T-20261014-152924-2/`；`git diff HEAD` 与 `git diff --cached` 皆空；`web/**`、`src/**`、`test/**`、`design/**` 逐字未动。未验证项见 §5 |

## 1 · 交付坐标 / 载体

| 项 | 值 |
|---|---|
| lane worktree | `/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261014-152924-2-seg1` |
| branch | **`lane/T-20261014-152924-2-seg1`** |
| 被验 SUT | **`da709a1`**（= 本 worktree HEAD；代码本体 `291bcd3`，base `7cb8e42` = 当前 main，未并） |
| 交付提交 | 见 `evidence/commit.txt`（本 lane 沙箱 **不能写共享 `.git`**，`git add` 即 `index.lock: Operation not permitted` ⇒ 落在可 fetch 的镜像仓 `/tmp/lane-mirror-T-20261014-152924-2`，分支同名） |
| 探针脚本 | `repro-claim-release.mjs`（①）· `scan-error-envelope.mjs`（②）· `check-ui-fallback.mjs`（③）· `mutations.mjs`（④） |
| 读数 | `evidence/*.json`（逐 check 的 pass/fail + 每条读数）+ `evidence/*.txt` |

**为什么不是 HTTP 套接字**：本 lane 沙箱拒绝 `listen(2)`（`listen EPERM: operation not permitted 127.0.0.1`，见 `evidence/env-listen-EPERM.txt`），所以 `createTaskd` 无法起服务，
`test/server/error-envelope.test.mjs` 的 2 条也是同一原因变红（§4）。①/② 因此走**套接字以下的同一代码路径**：`registerApiRoutes` 注册的真路由 + 真 handler + 真 `errorResponse`（`src/server/index.mjs#handle` 用的同一个函数）+ 真 SQLite 文件。
③ 的页面由 Playwright 路由拦截供给（真 Chromium：真解析、真布局、真渲染；只换了传输）。

## 2 · ① 复现链（命令 + 读数）

```bash
node docs/verify/T-20261014-152924-2/repro-claim-release.mjs --root . \
  --out docs/verify/T-20261014-152924-2/evidence/repro-claim-release.json   # exit 0 · 26/26
```

| 步 | 读数 |
|---|---|
| 新卡 | `status=todo`、`claimed_by=null` |
| `todo → in_progress`（linus） | http **200**；`claimed_by=linus`、`heartbeat_at` 有戳 |
| **`in_progress → todo`** | http **200**；`claimed_by=null`、`claimed_at=null`、`heartbeat_at=null`（**这一腿旧实现会把锁留下**，正是 Terry 拖拽撞 CHECK 的前半段） |
| **`todo → backlog`** | http **200**（旧路径此处 `275 CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'`）；落库 `status=backlog`、`claimed_by=null`；`GET /tasks/:ref` 回读一致 |
| `in_progress → awaiting`（E1） | http 200；`claimed_by=linus`（**锁保留**），`awaiting_reason=E1` |
| `awaiting → in_progress` | http 200；`claimed_by=linus`（同一执行者，未重查 routing lock） |
| `in_progress → in_review`（waiver） | http 200；`claimed_by=linus`（四值口径：`in_review` 留在周期内） |
| `in_review → in_progress`（rework） | `claimed_by=linus` |
| `in_progress → blocked` / `blocked → in_progress` | `claimed_by=linus` / `claimed_by=linus` |
| `in_progress → canceled`、`in_review → done` | `claimed_by=null`（终态释放） |
| 域层口径 | `CLAIM_HOLDING_STATUSES = ["in_progress","awaiting","in_review","blocked"]`；`holdsClaim()` 对 `backlog/todo/done/canceled` 全 false |
| **CHECK 仍然活着**（只可能由外部写者触发） | 用原始 SQL 造出**修复前的库内状态**（`in_progress → todo` 把 `claimed_by` 留下）后再 `UPDATE … status='backlog'` ⇒ `errcode 275` → 映射为 **`CLAIM_ON_BACKLOG`**，`message="A backlog task cannot hold a claim."`，原文在 `details.sqlite.message` |

## 3 · ② 错误信封扫描（脚本 + 结果）

```bash
node docs/verify/T-20261014-152924-2/scan-error-envelope.mjs --root . \
  --out docs/verify/T-20261014-152924-2/evidence/scan-error-envelope.json  # exit 0 · 19/19
```

谓词按卡面逐字符：`/constraint failed|SQLITE|SqliteError/`（脚本内另含卡面 ② 行里的 `NOT NULL constraint|UNIQUE constraint`）。

| 族 | 触发 | http / code | `message`（原文摘录） | `details.sqlite.message` |
|---|---|---|---|---|
| 未找到 | `GET /api/v1/tasks/NOPE-0001` | 404 `NOT_FOUND` | `no task NOPE-0001` | — |
| 唯一 | 重复 identifier 建卡 | 409 `IDENTIFIER_CONFLICT` | `Identifier already exists in this project.` | `UNIQUE constraint failed: tasks.project_id, tasks.identifier` |
| 版本冲突 | `move` 带陈旧 `if_version` | 409 `VERSION_CONFLICT` | `task changed under us (version 1, expected 999)` | — |
| 约束 CHECK | 外部写者把已认领卡改成 backlog | 409 `CLAIM_ON_BACKLOG` | `A backlog task cannot hold a claim.` | `CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'` |
| 约束 NOT NULL | 原始 INSERT 无 title | 400 `VALIDATION_FAILED` | `Input failed validation.` | `NOT NULL constraint failed: tasks.title` |
| 触发器 RAISE | 原始 UPDATE 改不可变关系 | 409 `RELATION_IMMUTABLE` | `database rejected the write during relations.update: RELATION_IMMUTABLE` | `RELATION_IMMUTABLE` |
| **全量扫** | 56 个 `ERROR_CODES` × 9 条引擎原文 = **504** 个信封 | — | **0 命中** | — |
| **全量扫** | 8 个 `SQLITE_ERRCODE` × 9 条引擎原文 = **72** 个信封 | — | **0 命中** | 72/72 保留原文 |

（`RELATION_IMMUTABLE` 那条的 `message` 是 `raiseMessage()` 给 RAISE 码写的句子，带的是**reason code**而不是引擎原文；卡面谓词不命中，且 UI 面该码走 `error.generic`。）

## 4 · ③ UI 面（源码 + 构建产物 + 真渲染）

```bash
# 构建产物（写在 /tmp，见 §5：lane 的写面不含 web/dist）
cd /tmp/T-20261014-152924-2.EDqwyN/sut/web && node node_modules/vite/bin/vite.js build \
  --outDir /tmp/T-20261014-152924-2.EDqwyN/dist-tip --emptyOutDir     # vite 8.3.4, 51 modules, exit 0
node docs/verify/T-20261014-152924-2/check-ui-fallback.mjs --root . \
  --dist /tmp/T-20261014-152924-2.EDqwyN/dist-tip --label tip \
  --out docs/verify/T-20261014-152924-2/evidence/ui-fallback.json     # exit 0 · 28/28
```

构建产物取自 `git archive HEAD`（= `da709a1`）的干净副本，bundle `index-BvR4R1L1.js`（sha256 前 16：`1cef1c8039219d85`）。

真 Chromium（`--single-process`，本沙箱禁止多进程 Chromium 的 mach rendezvous）点击卡片 kebab → `[data-move-to]`，API 被替换成带**未知/技术 code + 原始 SQL `message`** 的 409 信封，读 `[data-toast-region] > [data-toast] > [data-toast-text]`：

| 用例 | code | 语言 | toast 读数 |
|---|---|---|---|
| 未知 code | `BRAND_NEW_CODE_2099` | en | `That action did not complete — retry, or contact an administrator.` ✅ = 兜底句 |
| 未知 code | `BRAND_NEW_CODE_2099` | zh | `操作未完成，请重试或联系管理员。` ✅ |
| 技术/内部码 | `EXECUTION_STATE_CORRUPT` | zh | `操作未完成，请重试或联系管理员。` ✅ |
| 映射码 | `not_assignee` | en | `TD-2 is assigned to somebody else.` ✅ |
| 映射码 | `CLAIM_ON_BACKLOG` | zh | `TD-2 位于 Backlog，其中的卡片不能认领。` ✅ |

同一轮断言：wire 的 `CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'` 与 `/constraint failed|SQLITE|SqliteError/` 在 toast 里 **0 命中**；无未捕获 page error。
**源码 + 构建产物双读**：`stores/board.js` 两处拒绝点都是 `t(errorTextKey(err), <ref>)`、`CreateTaskModal.vue#submit` 同形，两个文件里 **没有** `err.message` 读取（`api.js` 只在 `Error` 基类的 `message` 里存 wire 文本，供栈/控制台，不进模板）；
`i18n/messages.mjs#errorTextKey` 对未知 code 返回 `error.generic`（不回退到 `message`）；bundle 里 zh/en 兜底句与 `error.generic|notAssignee|claimOnBacklog|notFound|busy` 键都在，且 bundle 内 **无** 引擎原文。

## 5 · ⑤ 只读约束 / 未验证项（如实登记）

**只读**：`git status --short` → 仅 `?? docs/verify/T-20261014-152924-2/`；`git diff HEAD`、`git diff --cached` 皆空；`src/**`、`web/**`、`test/**`、`design/**` 逐字未动。
所有负向抽件都只改 `/tmp` 里 `git archive HEAD` 的**拷贝**（`mutations.mjs --base /tmp/...`），被验工作树零改。`web/dist` 未在本 lane 生成（构建输出全在 `/tmp`）。

**回归面（非卡面要求，但可归因）**：

| 树 | 命令 | 读数 |
|---|---|---|
| tip `da709a1` | `npm test` | exit 1 — `tests 2223 · pass 1960 · fail 148 · cancelled 113 · skipped 2`（日志内 `EPERM` 161 处） |
| base `7cb8e42` | `node --test`（干净 archive 副本） | exit 1 — `2204 / 1943 / 148 / 111 / 2`（`EPERM` 157 处） |
| 定向套件 | `node --test test/contract/state-machine.test.mjs test/core/storage/sqlite-errors.test.mjs test/web/error-text.test.mjs test/web/board.store.test.mjs` | **exit 0 — 84/84** |

失败名集合逐名对照（`evidence/red-set-diff.txt`）：base 340 名、tip 344 名、base-only **0**；tip-only 恰好是本卡新增的 `test/server/error-envelope.test.mjs` 两条 + 其父 suite 名，成因是本沙箱禁止 `listen(2)`（`evidence/env-listen-EPERM.txt`），**非代码红**。

**未验证 / 登记项**：

1. **真 HTTP 传输未经本 lane 验证**（`listen(2)` EPERM）。等价替代载体已在 §1/§2 说明：套接字以下逐层同源（真路由 + 真 handler + 真 `errorResponse` + 真 SQLite）。该 HTTP 断言本来就有套件件（tip 树里那 2 条），在能 `listen` 的环境跑 `node --test test/server/error-envelope.test.mjs` 即可闭合。
2. **顺带观察（不属本卡，未验证其是否缺陷）**：HTTP 面无法写 `blocked_reason` —— `POST /tasks/:ref/move` 的 body 声明与 `registerTaskRoutes` 都不转发该字段（`src/server/**` 里 grep `blocked_reason` 零命中），而 `commands.moveStatus` 接 `blockedReason`、`domain/enums.mjs#BLOCKED_REASONS` 有 8 个字面量。故经 HTTP `→ blocked` 的卡 `blocked_reason` 恒为 `NULL`。本卡只读，未改、未定性。
3. Docker 门（`verify:docker`）、`listen` 类 UI 门（`ui-align`、`blocks.dom`）未跑：与本卡面无关且同族沙箱限制（前一轮 T-20261014-125122 §4.1 已登记同因）。
4. ③ 的浏览器只跑了 **Chromium**（`chromium-1243`）；Firefox/WebKit 未跑（不是本卡面）。

## 6 · ④ 负向对抗读数（脚本 + 红条）

```bash
node docs/verify/T-20261014-152924-2/mutations.mjs --worktree . --base /tmp/T-20261014-152924-2.EDqwyN/mutants
# exit 0（四例全红且命中命名断言 + 还原三探针全绿）· 读数 evidence/mutations.json
```

| 例 | 抽掉什么（一行文本级 revert） | 探针 | 退出码 | 红条 | 命中 |
|---|---|---|---|---|---|
| M1 | `moveCas` 里的 release 块（旧形状） | ① | **1** | **5** | `in_progress → todo **releases** …`、`todo → backlog is accepted …`、回读、`canceled`/`done` 释放 |
| M2 | `ERROR_TEXT_KEYS` 里 `not_assignee` 的 code→键 | ③ | **1** | **2** | `source · unknown + internal codes → error.generic…`、`page · mapped-notAssignee-en: the toast is the localized sentence`（**兜底 `error.generic` 命中**） |
| M3 | `safeMessage` 的引擎文本守卫（返回原文） | ② | **1** | **1** | `② sweep · every ERROR_CODES entry (56) × 9 engine messages`（引擎原文回到 `message`） |
| M4 | `board.js` 让 toast 再渲染 `err.message` | ③ | **1** | **11** | 全部 `wire's message is never rendered` + `localized sentence` 断言 |
| 还原 | 不变的三探针跑 pristine 树 | ①②③ | **0 / 0 / 0** | 0 / 0 / 0 | ① `26/26`、② `19/19`、③ `28/28` |

M1/M3/M4 的红是**定向**的（M1 只红 claim 相关断言，M3 只红全量扫那条，M4 只红渲染面），说明这些断言不是恒真：修复一被放回旧形状，它们就变红。

## 7 · 一次跑完（as-delivered 读数）

```bash
node docs/verify/T-20261014-152924-2/repro-claim-release.mjs     --root .   # exit 0 · 26/26
node docs/verify/T-20261014-152924-2/scan-error-envelope.mjs     --root .   # exit 0 · 19/19
node docs/verify/T-20261014-152924-2/check-ui-fallback.mjs       --root . --dist <dist>  # exit 0 · 28/28
node docs/verify/T-20261014-152924-2/mutations.mjs               --worktree . --base /tmp/…  # exit 0
```

四条 stdin/stdout 摘要与退出码见 `evidence/verdict.txt`（`exits: 01=0 02=0 03=0 04=0`）。

**③ 的 flake 与处置（如实登记）**：本沙箱的多进程 Chromium 起不来（mach rendezvous `Permission denied (1100)`），改用 `--single-process` 后单进程 Chromium 偶发中途死掉，Playwright 的 promise 随之永不 settle（探针当时以 **exit 13「pending top-level await」** 收场、且不写读数）。
交付版因此给每一步加了 deadline + 重试（死进程 ⇒ 重新起浏览器再跑同一条用例）：连跑 3 次 **exit 0 · 28/28**，无 flake。
