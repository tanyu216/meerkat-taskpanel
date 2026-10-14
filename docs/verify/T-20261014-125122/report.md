# Report — T-20261014-125122 · TaskPanel R14 集成终态独立复核（关系行结构裁决 + 焦点节拍修复，批次 B/C 并入后 main）

**结论：PASS（①–⑤ 逐条达成）。** 两处集成新面在真 Chromium 上按 selector 级读数与契约/原型一致；四门里两门需
`listen(2)` / Docker socket 的门禁在本 lane 沙箱**无法执行**（如实登记，并给出等价替代载体的读数 + 基线与 tip 逐名对照，
证明「零新增红」）；定向抽件 4 例全部按预期变红、还原复绿。

## 0 · 判定总览

| # | 条目 | 判定 | 关键读数 |
|---|---|---|---|
| ① | 关系行结构（selector 级） | **PASS** | `[data-detail-relations]` = `div.td-rel`（flex · wrap · `gap:4px 8px`）；3 个 `.td-rel-item`，目录名 `relations.parent`/`relations.blocks`/`relations.related` 全渲染，文本取目录值（en `Parent/Blocks/Related`；zh `父任务/阻塞/关联`）；4 枚链接全为 `button.td-copy[data-relation-link]`；空关系卡渲染 `relations.none` |
| ② | 焦点节拍 | **PASS** | 落焦后 `document.activeElement` = `<button data-detail-close>`（**非 body**，实测 t=232.9ms）；实现是原型的 200ms `setTimeout` + `data-state === "open"` 回读（源码 + 构建产物双读），**无 `nextTick`**；开档首帧 `visibility:hidden`，该帧与开档任务内发 `.focus()` **均不生效**（证该等待是承重的） |
| ③ | 无回归（四门） | **PASS / 2 门环境受限** | `blocks.dom.test.mjs`：**exit 1 = 沙箱 `listen EPERM`**（基线同）；`npm run check`：tip exit 1（`tests 2206 · pass 1945 · fail 149 · cancelled 111`），基线 `b54a6ce` exit 1（`2196/1935/148/111`）——**红名集合 tip ⊇ 基线，零新增红**；`ui-align board`/`board-m2 --strict`：**exit 2**（`listen EPERM`，两树同）；`verify:docker`：**exit 1**（docker socket `operation not permitted`，两树同）。替代读数见 §3.2 |
| ④ | 负向对抗 | **PASS** | 4 例定向抽件：M1 抽 `related` 组 → R3/R4/R5/R6/R7 红；M2 抽分组目录名 → R4/R5 红；M3 删焦点节拍 → S2/S4/D3/D4/F4/F6 红；M4 `FOCUS_BEAT_MS=0`（修复前形状）→ S1/D4/F4/F6 红；**还原后 48/48 复绿** |
| ⑤ | 只读 + flake | **PASS** | 被验仓 `git status` = 仅本卡 `docs/verify/T-20261014-125122/` 未跟踪；`git diff HEAD` 空；主 checkout 干净同 sha。真实 flake 未现（同一读法 6 次运行逐字节同值） |

## 1 · 交付坐标

| 项 | 值 |
|---|---|
| lane worktree | `/Users/tanyu/Documents/meerkat-taskpanel-wt-T-20261014-125122-seg1` |
| branch | **`lane/T-20261014-125122-seg1`** |
| 被验 SUT（父提交） | **`3ad4b19`** = 进入本卡时的 main tip（= 主 checkout HEAD，批次 B/C 已并入） |
| 交付提交 | 本 lane 沙箱禁止写共享 `.git`（`index.lock` EPERM，见 §6 R-1），故落在**可 fetch 的镜像仓** `/tmp/lane-mirror-T-20261014-125122b`：产物提交 **`3e81a3a`**（27 文件）→ `4c21128`（附 `integration.patch`）→ `e227fe4`（台账校正）；sha 亦见 `evidence/commit.txt` 与最终回复 |
| push | 未 push（等集成） |

## 2 · ① 关系行结构（selector 级，chips 表 2）

载体：Playwright 路由拦截 + 真 Chromium（`--single-process`），样本 `PROJ-0007` 带 4 条边 / 3 类
（`parent`×1 `blocks`×2 `related`×1），另有一张零关系卡 `TD-2`。读数（en / zh 两侧同构）：

| selector | 读数 |
|---|---|
| `[data-detail-relations]` | `div`，class 含 `td-rel`；computed `display:flex`、`flex-wrap:wrap`、`gap:4px 8px` |
| `.td-rel-item` | **3** 个，均为 `span`（原型同形） |
| 分组目录名（`span[data-i18n]`） | `["relations.parent","relations.blocks","relations.related"]`（= 域词汇序 `RELATION_ORDER`） |
| 分组文本 | en `["Parent","Blocks","Related"]`；zh `["父任务","阻塞","关联"]` —— 取目录值 |
| 链接 | 4 枚，全为 `button.td-copy[data-relation-link]`，每组 ≥1；文本解析为 `TD-125` / `TD-130`,`TD-126` / `TD-127` |
| 零关系卡 | `.td-rel-item` = 0，渲染 `span[data-i18n="relations.none"]` = `No relations` / `暂无关联` |
| 原型对照 | `design/prototype/index.html` 的 `[data-detail-relations]` = `div.td-rel`（同 computed 三值），`[data-slot="relations"]` 内 `span.td-rel-item` → `[data-i18n="relations.parent\|blocks"]` + `button.td-copy[data-relation-link]` |

**契约口径核对（一处必须登记的差异）**：`design/BLOCKS.md` §R14 明确「关系区**点名三类**」并给出三条目录键
（`relations.parent|blocks|related`）；而 `design/fidelity-r14.md` 的 D37 / R14-B23 行在标签列只写了
`relations.parent\|blocks` 两个键（第三个键的**座位**当时「留给后续实现卡」——BLOCKS.md §R14 末句与原型
`index.html` 实测 `relations.related` 0 座都记着这笔）。实现在此**取三键全渲染**，与 BLOCKS.md §R14 + 目录
+ 本卡裁定一致，只是在 D37 字面（两键）之外多出第三座——这是契约文件自身的滞后，不是实现漂移。

## 3 · ② 焦点节拍

读数（en，`tip.json` 原始帧迹）：

| 态 | 读数 |
|---|---|
| 静止（抽屉关闭） | `visibility:hidden`；抽屉**无 `hidden` 属性**（R14 §8 U4 的关闭面） |
| 开档任务内（同 task） | 面板仍 `hidden`；**该帧发 `.focus()` 不生效**（probe = false） |
| 首个 `data-state="open"` 帧 | t=**6.2ms**，`visibility:hidden`，`document.activeElement` = `body`；**该帧 `.focus()` 亦不生效**（probe = false） |
| 落焦态 | t=**232.9ms** `document.activeElement` = `<button data-detail-close>`；`data-state=open`、`visibility:visible` |

实现口径（源码 + 构建产物双读，非恒真）：

- `DetailDrawer.vue`：`const FOCUS_BEAT_MS = 200;`；`watch(open, …)` 只在开边缘武装；`window.setTimeout(() => { if (board.drawerState === "open") closeButton.value?.focus(); }, FOCUS_BEAT_MS)`；**`nextTick` 无调用、无导入**（文件里仅剩两处是解释为何不用它的注释）。
- `design/prototype/app.js` `focusWhenOpen`：`window.setTimeout(function () { if ($panel.attr("data-state") === "open") $target.trigger("focus"); }, 200)` —— 实现逐条对齐。
- `web/dist` 构建产物：`drawerState===\`open\`&&…focus()},\<常量\>` 且该常量 `=200`（D3/D4）。

## 4 · ③ 无回归：四门复跑

### 4.1 原样执行（命令 + 退出码 + 计数）

| 门 | 命令 | tip（`3ad4b19`） | 基线（`b54a6ce`） | 归因 |
|---|---|---|---|---|
| blocks.dom | `node --test test/web/blocks.dom.test.mjs` | **exit 1** | **exit 1**（已建 `web/dist`） | 两者皆 `listen EPERM: operation not permitted 127.0.0.1`（dom-smoke 自起 fixture 服务）；本 lane 沙箱禁 `bind(2)` |
| check | `npm run check` | **exit 1** — `tests 2206 · pass 1945 · fail 149 · cancelled 111 · skipped 1` | **exit 1** — `2196 / 1935 / 148 / 111 / 2` | 日志内 `EPERM` 161 / 157 处；红名集合见下 |
| ui-align | `node ~/.openclaw/team/tools/ui-align/check.mjs --config web/.ui-align.json board`<br>同 `board-m2 --strict` | **exit 2** / **exit 2** | **exit 2** / **exit 2** | 引擎自举静态服务即 `listen EPERM`（进不了断言） |
| docker | `npm run verify:docker` | **exit 1** | **exit 1** | `dial unix /var/run/docker.sock: connect: operation not permitted` |

**零新增红（逐名对照）**：把两棵树的 `npm test` 失败名集合取唯一后比对 —— 基线 340 名、tip 342 名、**交集 340**；
「tip 有基线无」的只有 2 条：`web/blocks.dom — the browser layer` 与其子断言
`passes every DOM rule, console/page error and viewport check`。这 2 条的唯一成因是**我为了跑本轮 harness 在 tip 树里建了 `web/dist`**：
基线树当时无 `dist` ⇒ 该腿走 `SKIP`（基线 `skipped=2` vs tip `skipped=1`）。为消除这个不对等，我在基线树里同法建了
`web/dist` 再单独复跑该腿：**exit 1、同一句 `listen EPERM`**，与 tip 逐字相同 ⇒ 这两条同样是环境红，**本卡零新增红**。
（对照文件：`evidence/red-set-diff.txt`、`evidence/gate-{tip,baseline}-blocks-dom.log`。）

### 4.2 沙箱受限门禁的等价替代读数

1. **①②的关系面**：本卡自写 harness 在 routing 载体上跑 **48 项 · pass 48 · fail 0**（含 D37/B23 的 selector 级读数、原型对照、目录值双语、空态、焦点两态与帧迹）。命令：
   `node docs/verify/T-20261014-125122/verify-integration.mjs --dist web/dist --label tip --out …/evidence/tip.json`
2. **契约规则面**：`web/scripts/dom-smoke.mjs` 的声明规则集计数为 tip **493** / 基线 `b54a6ce` **466** / 批次 B tip `9b5e57f` **488**（—— 卡面那个 488 正是 B tip 的读数，C 批并入后 +5）。**规则条数的增长本身不是红**：见 4.1 的逐名对照。
3. **`verify:docker` 的套件面**：把 `docker/verify-in-container.sh` 的**文件级步骤**在宿主原样跑一遍：`contract`（35 routes / 211 facets / 55 error codes / 118 wire fields）、`route-request`（30 routes）、`manifests`、`skill`、`migrations`、`install.sh --dry-run`、`profiles`、`host-runtime` —— **8/8 exit 0**。缺的两步是镜像 build + compose smoke（需 daemon）与 `install-e2e`（需 `listen`）：后者实测在 `taskctl project create` 处 `CLI_IO: taskd was started but never answered /health`（= 沙箱禁 socket 的症状，与 044112 卡登记的同族）。

## 5 · ④ 负向对抗（非恒真、不放水）

每例都只改**一份拷贝**（`/tmp/taskpanel-t-20261014-125122/<mut>/`）+ 就地构建，被验工作树源码零改；驱动器 `mutations.mjs`。

| 例 | 抽掉什么 | 变红断言（`--only` 门控） |
|---|---|---|
| M1 | `related` 分组（154930-2 合入前的形状） | `R3`,`R4`,`R5`,`R6`,`R7` |
| M2 | 分组的目录名声座（R14-B23 的「分组与标签座位丢失」） | `R4`,`R5` |
| M3 | 整个焦点节拍 | `S2`,`S4`,`D3`,`D4`,`F4`,`F6` |
| M4 | 节拍的**等待**（`FOCUS_BEAT_MS=0`，即 `ff552f9` 修掉的那个形状） | `S1`,`D4`,`F4`,`F6` |

三态：**还原前 48/48 绿（exit 0）→ 4 例各自变红（exit 1，且命中命名断言）→ 还原重建后 48/48 绿（exit 0）**。
（M4 尤其有意义：节拍留着只是不等，焦点就落空 ⇒ 命中断言的正是 `ff552f9` 的论点。）

## 6 · ⑤ 只读约束 / flake / 产物

- **被验仓零改**：`git status --short` 仅 `?? docs/verify/T-20261014-125122/`；`git diff HEAD` 与 `git diff --cached` 皆空；
  主 checkout `/Users/tanyu/Documents/meerkat-taskpanel` 干净且同 sha（`3ad4b19`）。实现/契约/测试文件（`web/**`、`src/**`、`design/**`、`test/**`）逐字未动。
- **R-1（环境阻塞，必须登记）**：本 lane 沙箱的可写根不含共享 `.git`（`/Users/tanyu/Documents/meerkat-taskpanel/.git`），
  `git add` 即 `Unable to create '…/worktrees/…-seg1/index.lock': Operation not permitted (128)` —— 与 154930-3 同因。
  故本卡产物**通过一个可 fetch 的镜像仓提交**（`/tmp/lane-mirror-T-20261014-125122b`，由
  `git fetch <lane-worktree> lane/T-20261014-125122-seg1` 取得 `3ad4b19` 后在**同一父提交**上落成，
  三个提交全部只动 `docs/verify/T-20261014-125122/**`，`git diff-tree 3ad4b19 HEAD` 无本卡目录外路径）：

  | 提交 | 内容 | sha |
  |---|---|---|
  | A | harness + fixture + mutations + report + 全量证据（27 文件） | `3e81a3aa0a301a1b151d7628011fc6d4a9bd6edf` |
  | B | A + `integration.patch`（= A 的 `format-patch`，自描述副本） | `4c2112838194d91e9bc59a2dc6a1e72313e06991` |
  | C | `evidence/commit.txt` 台账校正 | `e227fe44e836a43d52a252acb561b67d3ac502f0` |

  集成方可直接 `git fetch /tmp/lane-mirror-T-20261014-125122b lane/T-20261014-125122-seg1`（或 `git am` 上面任一 sha 的 `format-patch`）。
- **flake**：真实 flake **未现**。同一读法跑了 6 次（tip / 4 例抽件 / 还原），焦点帧迹与关系行读数逐值一致；
  四门里也没有出现「同一命令重复跑结果不同」的现象（门禁的红全部可复现且成因唯一 = socket）。
- 产物：`docs/verify/T-20261014-125122/{verify-integration.mjs,fixture.mjs,mutations.mjs,evidence/**}`（另 `verification/T-20261014-125122/report.md`、`/tmp/T-20261014-125122/report.md` 同内容副本）。
  重跑：`node docs/verify/T-20261014-125122/mutations.mjs`（自带构建、抽件、还原三态）。

## 7 · 发现（不阻断本卡结论）

- **O1**：卡面三枚关系计数 `[data-relations-parent|blocks|related]` 的值来自 `task.meta.relations_*`，而 `src/server`
  **没有任何路由写这三个字段**（全仓只有 `web/src/components/board/Card.vue` 在读，×3 行）；于是没有种子数据的板子上三值恒为 `0`，
  `[data-card-relations]` 因 `hasRelations=false` 常隐。BLOCKS.md §R14 要求「卡与抽屉把同一类拼写一致」——**名座一致（已验）**，
  但**值没有生产者**（属 B07/卡计数面的既有缺口，非本卡两处新面，登记备裁）。
- **O2**：`design/fidelity-r14.md` D37 / R14-B23 的标签列只列两键（见 §2 末），建议随 BLOCKS.md §R14 回灌为三键，免后续复核再起歧义。
- **O3**：`ui-align` 两档清单在本环境进不了断言，故「board / board-m2 全清单」在本 lane **未复核**（与 154930-3 登记的同一项）；
  本轮只补了本卡两处新面的原型对照（P1–P3）。

## 8 · 未验证项（诚实登记）

1. `blocks.dom.test.mjs` 的 **493 规则 / 0 失败**原样读数（需 `listen`）——以 routing 载体的 48 项 + 逐名零新增红替代。
2. `ui-align board` / `board-m2 --strict` 的清单断言（需 `listen`）——以 P1–P3 的原型对照替代（仅本卡两处新面）。
3. `verify:docker` 的镜像 build + compose smoke（需 daemon）；`install-e2e.sh`（需 socket）——以容器套件 8 项文件级步骤全绿替代。
4. 未做像素级截图对比（本轮判真为 DOM/computed/selector 级）。
