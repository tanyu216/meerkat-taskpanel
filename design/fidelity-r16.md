# 前端 URL 路由契约 · R16 — 四视图各得一个地址（path 方案）· 默认入口重定向 board · 深链/刷新/历史/侧栏高亮

> 卡：`T-20261013-183505-2`（父 epic `T-20261013-183505` · 需求 D「前端 URL 路由」，来源 谭玉 2026-10-13 18:33 webchat）。
> 分工：**D1 = 本契约**（写面 `design/**`，零实现）→ **D2 = 实现**（`T-20261013-183505-3`，写面 `web/**` + 必要 `test/web/**`）→ **D3 = 独立验证**（`T-20261013-183505-4`，`review_of=D2`）。本文件是 D2/D3 的**唯一口径**。
> 口径来源：卡 `## Background` 给的两个候选与判据——「Elon 倾向 path + fallback；若 fallback 代价高/需改 server 写面，则选 hash」。本契约**实测**了那个条件的另一半（§1、§6），答案是：fallback **已经在**、**零服务器改动** ⇒ 取 **path**。
> **Elon 裁定（卡 `## Comments` 2026-10-13T10:46:33.515Z · 经 sessions_send 转记）**——本 lane 于 10:41:06Z 起，**裁定比开工晚到 5 分钟**，handoff 未含；本契约已按其口径对齐（**逐条对齐表见 §4.8**）。裁定原文：**「path 路由 + 零服务器改动**已批准（实读 `src/server/static.mjs` `fileOrIndex` SPA fallback 属实）。四项口径：① 旧 `#/activity?…` → **双读兼容**：canonical 用 query `/activity?…`，旧 hash 读入并重定向（不硬断旧分享链接）；② 详情抽屉 `#/task/<id>` → **保留 hash**（抽屉非四视图之一，最小改动），仅登记为后续可选升级、不在本卡实现；③ list → **独立 `/list`**（Terry 明确四视图各自独立页面）；④ 历史边界 → 视图切换 `pushState`、筛选收窄 `replaceState`；toast/抽屉**不进**历史。」
> 范围：`design/fidelity-r16.md`（本文件）+ `DESIGN.md §32` + `design/BLOCKS.md §B03` 一句交叉引用。**零实现**：`web/**`、`test/**`、`src/**`、`server/**` 一行不动（`BLOCKS.md` 的那句是文档同步，见 §7）。
> 事实源：服务端 = `src/server/static.mjs`、`src/server/index.mjs`、`src/shared/constants.mjs`（**真跑实测**，§6）；前端 = `web/vite.config.js`、`web/src/**`（**实读，未实测**——本 lane 没有 `web/dist`、没有 `web/node_modules`，未构建、未起服务）；原型 = `design/prototype/{index.html,app.js}`（**真浏览器实测**，§6）。
> 证据口径：`evidence/r16-route-probe.txt`（**8/8**）、`evidence/r16-prototype-address-probe.txt`（**10/10**）；两个探针与原始输出见 §10。**未跑的（D2 的实现侧行为）一律标注「实读未实测」**。
> 基线 commit：**`49f6f77`**（= `main`，本 lane 的开工点）。同族前序：**R12x**（四视图落地、B26/B27）、**R13**（侧栏名册胶囊）、**R14**（B09 逐块对账）、**R15**（筛选控件统一 `dropdown`）。

## 0. 结论摘要

- **① 方案 = path，不是 hash。** 服务器**已经有** SPA fallback：`static.mjs:fileOrIndex` 对**无扩展名的未知路径**回落 `index.html`，`index.mjs` 的 `handle` 在 GET/HEAD 且路径不以 `/api/` 开头时**先试静态、再 404**。探针的 **8 条断言全 PASS**：`/`、四个视图地址、`/activity?…`、两条尾斜杠、`/index.html` **全部 200 + `text/html`（就是 shell）**，而 `/assets/gone.js` 与 `/api/v1/nope` **仍是 404 JSON**（`evidence/r16-route-probe.txt`）。⇒ **零服务器改动、不触 `src/server` 写面**，卡里「若 fallback 代价高则选 hash」的前件不成立。
- **② 映射表五条**（§3）：`/`（→ 规范化到 `/board`）· `/board` · `/list` · `/activity` · `/waiting`；另有**四条非路由输入**各有归宿：别名 `/`、`/index.html` → `/board`，尾斜杠 → 去掉尾斜杠的规范形，未知路径 → `/board`（三者都 `replaceState`，无 404、无 toast、无新表面），以及**旧的 `#/activity…` 地址 → 读入 + 重定向到 `/activity?…`**（Elon 裁定 ①，§4.4）。
- **③ 行为＝「地址是真相」。** 只有**两个写者**：换视图 `navigate()` 用 **`pushState`**（前进/后退撤销视图），改筛选用 **`replaceState`**（前进/后退**不**撤销筛选——这正是 `activity.js` 今天对 hash 的既有规矩）。**一个读者** `applyLocation()` 供开机与 `popstate` 共用。深链/刷新 = 开机跑一次读者；未知地址 = 规范化到 `/board`；侧栏高亮 = 当前路由的纯函数（`[data-nav]` 内**恰一个** `aria-current="page"`）。
- **④ 与既有 activity hash 的关系 = 规范地址「并入 query」，旧式「双读兼容并重定向」（Elon 裁定 ①）。** 筛选的规范地址是 `/activity?actor=agent`：槽位、顺序（actor→event→task）、`all` 省略、域外拒绝四条规矩**逐条保留**，只换载体（fragment → query，`location.hash` → `location.search`）。**旧式 `#/activity?…` 继续可读**：路径是别名而 fragment 是动态流的地址时，读它、落视图与筛选，再把地址**重定向**（`replaceState`）成规范 query 形——旧分享链接不断。解析器**只有一个**（`readActivityQuery`），旧 fragment 只是第二个**载体**，不是第二套规矩。fragment 的其余内容（抽屉的 `#/task/<id>`；Elon 裁定 ②：**保留 hash**）**不读、不写、不改**。
- **⑤ 原型一致性 = 无视觉/交互变更，且这一条是「跑出来的」、不是宣称的。** 探针在真 Chromium（1512×950）里驱动原型：按侧栏 → 视图换、**地址一位没动**、`history.length` 一位没长（8→8）；按筛选 → 地址写成 `#/activity?actor=agent`、**`history.length` 仍不变**（`replaceState`）；回 board 后**地址仍停在 activity 的旧值**（陈旧地址，原型今天就会留下一个与视图不符的地址栏）；activity 上顶栏 toggle 两值**都是 `false`**（`board=false list=false`）。⇒ **原型根本不存在 URL 层**：R16 加的是产品壳里的一层新代码，**零新增 DOM**，原型既没有要改的面、也没有可对账的期望值（§7）。
- **⑥ 一处必须先说的出入。** 实现侧 `ActivityView.vue` 的 `onMounted` 已经有一条「`#/activity` 地址**进入** activity 视图」的规矩，而**原型没有**这条（实测：带 `#/activity?actor=agent&event=status&task=TD-128` 真加载，视图根仍是 board、侧栏高亮仍是 board，只有三个筛选值被恢复）；那段代码的注释引的是 `design/activity/DESIGN-activity.md §6`，而该节只写了**筛选**入 URL 的那一半，没有写「进入视图」。「深链直达四视图」是 epic 的硬需求 ⇒ R16 **把这条规矩接过来、写成契约、并由路由器统一拥有**（§4.5、§7.3）：这是本契约**新增的口径**（`缺失口径`），不是对原型某个数字的对账。
- **不做的事（边界，§9）**：不加卡片级路由（`/board/<ref>`）、不把抽屉写进地址、不把 board/list 的筛选或搜索写进地址、不动 `?theme=`/`?lang=`（那两个是**原型专用**入口开关，`design/activity/activity.js`，不是产品槽位）。

---

## 1. 口径与证据规则

**闭集口径（逐字使用，不得自创词）**：`对齐` = 两侧实测同值；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达（须有书面偏差说明）；`缺失口径` = 两端都没有、本轮首次定义。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**（本页不出现任何「文件 + 数字行号」形式的引用）。断言只用 `data-*` 钩子 + 属性 + 计算样式 + `location`/`history` 的公开读法。

**证据规则**：

1. 「服务器支持 path 路由」这句话在本轮是**跑出来的**，不是读注释读出来的：探针用**替身** `web/dist`（仓库里根本没有这个目录）把真实的 `createTaskd` 起在 loopback 随机端口，逐个请求候选地址，记录 status / content-type / body 指纹。原始输出见 §10。
2. 「原型没有 URL 层」同样是**跑出来的**：内置静态服务 + 宿主已装的 Playwright Chromium headless，真实指针按侧栏与下拉行。原始输出见 §10。
3. **实现侧（`web/**`）本轮一律「实读未实测」**：没有 `web/dist`、没有 `web/node_modules`，未构建、未起服务、未驱动。§5 的每一条都是实读值，任何未验证项都会明写。
4. **地址必须逐条真加载**：`page.goto` 到**只有 fragment 不同**的 URL 是**同文档导航**，开机分支不会重跑——探针的第一版就踩了这个坑（三个地址共用一个页面，第三条被读成「地址无效」，其实是「只测了第一次加载」）。凡测「深链/刷新」者，**每条地址必须 `about:blank` → 真加载**。这条同样是 D3 的复现前提（§6 C 腿）。
5. **不伪造**：未跑的写「未跑」；本地观测到的边界（例如 `history.length` 的绝对值受先前 `goto` 影响）只以**增量**断言。
6. 探针与原始输出**不在仓库里**（本卡零实现），它们在卡工作区 `evidence/`；文件内容与命令见 §10，任何人可复跑。

---

## 2. ① URL 方案：path（含理由与服务器能力约束）

| | **path（本轮采定）** | hash |
|---|---|---|
| 地址形 | `/board` · `/list` · `/activity?actor=agent` · `/waiting` | `/#/board` · `/#/activity?actor=agent` |
| 服务器改动 | **零**——fallback 已在（§6 实测 8/8） | 零 |
| 资源路径 | 需要 `base: "/"`（绝对资源 URL）——**已经是**（`web/vite.config.js`：`base: "/"`，注释「the frontend is mounted at the root」） | 无所谓 |
| fragment 归属 | **整段留给抽屉** `#/task/<id>`（B26/`DESIGN-activity.md §6` 的既有规矩：筛选入 URL **不污染** `#/task/<id>`） | 与抽屉**抢同一格**：`#/activity?…` 与 `#/task/…` 是两套公式挤在一个 fragment 里 |
| 筛选载荷 | 真正的 query（`?actor=agent`） | fragment 里再写一层 `?`（`#/activity?actor=agent`） |
| 无服务器 404 可依 | 是：任何无扩展名路径都答 200 shell ⇒ **未知路由的归宿必须由前端定**（违反不了「无 404」这条验收，代价是前端要自己定义口径） | 同 |
| 脚本关闭时 | 五条地址拿到**同一份** `index.html` 字节 ⇒ 无脚本文档**永远是 board**（§4.7） | 同 |

**判据与结论**：卡给的判据是「fallback 代价高 / 需改 server 写面 ⇒ 选 hash」。实测该判据**不成立**：fallback 在 `static.mjs:fileOrIndex`（无扩展名的未知路径回落 `index.html`，**有**扩展名的缺失资源仍是真 404），调度在 `index.mjs:handle`（GET/HEAD 且非 `/api/` ⇒ 先试静态）。八条候选地址全部 200 拿 shell（§6 A 腿）。**取 path。**

**取 path 时必须写在契约里的五条服务器约束**（都不需要改服务器，但实现方必须知道）：

1. **保留命名空间**：`/api/**` 由服务器拥有（`index.mjs:handle` 用前缀把它挡在静态之前；`/api/v1/nope` 实测 404 JSON），`/health` 由服务器拥有。四个路由名与服务器路由表**不冲突**——表里全是 `/api/v1/**`（外加 `/api/v1/attachments/:id/content` 的内容正则）与 `/health`。
2. **扩展名就是边界**：缺失的**带扩展名**路径是**真 404**（实测 `/assets/gone.js` → 404 JSON）。所以路由**不得**长得像资源、也不得依赖「带扩展名的未知路径会回落 shell」。
3. **尾斜杠由服务器先抹平**：`index.mjs:handle` 在派发前 `replace(/\/+$/, "")`，`safeResolve` 也做归一。⇒ `/board/` 拿到的是 shell（实测 200）；但**浏览器地址栏仍是 `/board/`**，所以**规范化由前端负责**（§4.3）。
4. **shell 是 `no-cache`、带哈希的资源是 `max-age=3600`**（`static.mjs:createStaticHost`）：深链永远拿到当天的壳，这条是 path 路由能安全落地的前提之一。
5. **前提：`web/dist` 存在**。检查点不存在时（纯后端 checkout）**每条地址都是 404 JSON**——`test/server/static.test.mjs` 的「a checkout with no build」正是这条。所以 D3 的「无 404」必须在**有前端构建的**环境里测（§6 备注）。

---

## 3. ② route ↔ view 映射表

**表就是全集**（闭集；大小写敏感、精确匹配、不认前缀）：

| # | 地址（规范形） | 视图 | 侧栏 `[data-nav-item]` 当前 | 顶栏 `[data-view]` 按下 | 备注 |
|---|---|---|---|---|---|
| 1 | `/` | board | `board` | `board` | **别名**：开机即 `replaceState` 规范化为 `/board`（「默认入口重定向」就是这一条） |
| 2 | `/board` | board | `board` | `board` | 规范形 |
| 3 | `/list` | list | `list` | `list` | 规范形 |
| 4 | `/activity` （+ `?actor&event&task`） | activity | `activity` | **两个都 `false`** | query 是**唯一**有载荷的路由（§4.6） |
| 5 | `/waiting` | waiting | `waiting` | **两个都 `false`** | 规范形 |

**非路由输入的四条归宿**（同属映射，因为它们也必须落进上表）：

| 输入 | 归宿 | 写不写历史 |
|---|---|---|
| `/` 、`/index.html`（Vite 入口） | → `/board`（fragment 原样带着） | `replaceState`（不留条目） |
| 带尾斜杠的已匹配路由（`/board/`、`/waiting/`） | → 去掉尾斜杠的规范形 | `replaceState` |
| **旧的动态流地址**：路径是别名（`/`、`/index.html`）而 fragment 是 `#/activity…` | → `/activity`（+ 该 fragment 的三个槽 → query），**fragment 被消费掉** | `replaceState`（Elon 裁定 ①：读入并重定向） |
| 任何其它路径（`/nope`、`/borad`、`/board/PROJ-0001`） | → `/board` | `replaceState` |

**为什么未知路径的归宿是 `/board` 而不是错误面**：服务器给未知的无扩展名路径**一律 200 shell**（实测），所以「没有这条路由」只能在**前端**表达；而四个视图之外的**任何新表面**（错误页、toast）都与 ⑤「无视觉/交互变更」冲突。把未知归一到默认视图，是本轮唯一既满足「无 404」、又不新增表面的选择。代价明写：**手写错的地址会被静默纠正**（本地单用户板，代价为零）。`/board/PROJ-0001` 形态被 `static.mjs` 的注释点名过（「what a client-side router (vue-router) needs to serve」），本轮**不开**这条路由，但表是**可扩展的**——将来加卡片级路由只是往表里加一行，**规则一条都不用改**（§9 O-1）。

---

## 4. ③ 行为契约

### 4.1 一条总则：**地址是真相，视图是镜像**

`view` 不再由界面直接写；它由**地址**决定。今天实现侧写视图的地方有四处（§5），R16 之后**没有一处**直接写 `view`。

### 4.2 **两个写者、一个读者**（唯一写入口径）

| 角色 | 名字（建议） | 何时 | 历史行为 | 纪律 |
|---|---|---|---|---|
| 写者 A · 换视图 | `navigate(view)` | 侧栏按下、顶栏 toggle 按下、R13 名册路由、动态流里的任务路由 | **`pushState(null, "", 目标规范地址)`** | 目标地址**已是当前地址**时**直接返回**，不写历史（与 `activity.js` 既有的「驻留地址不再写一次」同一规矩，`test/web/activity.feed.test.mjs` 今天就在断言它：写者对驻留地址**一次也不调** `replaceState`） |
| 写者 B · 改筛选 | `replaceActivityQuery()` | activity 视图自己的三个筛选控件、Clear、空态里的 Clear | **`replaceState(null, "", pathname + search + hash)`** | **路径与 fragment 原样保留**——只换 query。地址里只有 `all` 时不写 `?`（`/activity`，不是 `/activity?`） |
| 读者 | `applyLocation(location)` | **开机**与 **`popstate`** 两处共用 | **绝不写历史** | 解析路径 → 视图；若是 `/activity`，再按 query 落三个筛选 |

**不写 `history.state`**：地址是全部真相，state 载荷会变成第二个可与之矛盾的来源。`pushState`/`replaceState` 的第二参数恒为 `null`。

### 4.3 开机（深链 / 刷新）

1. 读 `location.pathname` → 查表（先抹尾斜杠）→ 命中即视图。
2. **未命中时先看 fragment**（Elon 裁定 ①）：若路径是**别名**而 `location.hash` 是动态流的旧地址（`legacyActivityQuery()` 命中），则视图为 **activity**、三个筛选取自该 fragment，然后把地址 **`replaceState` 重定向**成 `/activity` + 该 fragment 的三个槽（**fragment 被消费掉**——它就是被搬进 query 的那份载荷）。
3. 仍未命中（别名或未知）：视图为 board；若是**别名**（`/`、`/index.html`）或**未知路径**，`replaceState` 规范化为 `/board`（**fragment 原样带着**，路由不解析它——那是抽屉的格子）。
4. 若当前路由是 `/activity`：按 query 落筛选（§4.6）。
5. 视图的落定必须走**与 `popstate` 同一条 `applyLocation` 路径**，只是**不写历史**——「刷新/深链」与「后退」是同一件事的两种触发，不允许两份实现（**旧 fragment 的读入也在这条路径里**，所以后退回到一条旧形地址时同样被读、被重定向）。
6. 落视图会触发既有的加载副作用（例如 activity 的账本回填由「视图是 activity」驱动）；因此**开机解析必须发生在视图 watcher 已经活着之后**（`App.vue` 的挂载阶段），否则一条深链会进入一个空账本。

### 4.4 与既有 activity hash 的关系：**并入 query（canonical）+ 旧式双读兼容并重定向**

- 今天：`web/src/stores/activity.js` 的 `activityHash()` 产出 `#/activity?actor=agent`，`writeActivityHash()` 用 `replaceState` 写 `location.hash`，`readActivityHash()` 开机读回筛选；原型一侧**行为一模一样**（实测：按筛选 → `#/activity?actor=agent`，`history.length` 不变）。
- R16 的**规范形**是 query：`/activity?actor=agent`。**四条规矩逐条保留**：槽位集合与顺序（`actor` → `event` → `task`）、`all` 不写、`encodeURIComponent`、**取值不在域内就不写**（`actor` 只认 `all|me|human|agent`，`event` 只认 `all|status|comment|delivery`，`task` 认任何标识符）。
- **旧式 `#/activity?…` 读入并重定向**（Elon 裁定 ①，2026-10-13 10:46Z）：
  - **触发条件精确为**：路径**没有**命中路由表，且**是别名**（`/` 或 `/index.html`），且 fragment 以 `#/activity` 开头。今天这个应用在任何路径上写 hash，但读者手上的链接只有 `/` 与 `/index.html` 两种路径形，所以这条覆盖全部真实的旧链接。**路径命中路由表时 fragment 一律不管**（它可能是抽屉的 `#/task/<id>`）。
  - **动作**：视图落 **activity**（旧链接是一条**直达动态流的深链**，不是只恢复筛选）、三个筛选取自 fragment、地址 `replaceState` 成 `/activity` + 三个槽（**fragment 被消费**）。因此 `/#/activity?actor=agent&event=status&task=TD-128` 会变成 `/activity?actor=agent&event=status&task=TD-128`，`location.hash` 变空。
  - **解析器只有一个**：`readActivityQuery()` 同时吃 query 形与（剥掉 `#/activity` 前缀与 `?` 之后的）旧形，所以旧形**不可能**长出第二套域规则；`legacyActivityQuery(hash)` 只做「是不是动态流的地址、载荷是哪一段」这一件事，返回 `null` 或 `?…`。
  - **写者只写 query**：旧形**永不被写出**（它只是被读、被消费）。
- **fragment 的其余内容由路由无视**：不读、不写、不改。抽屉的 `#/task/<id>` 因此**一位不变**——Elon 裁定 ② 明确**保留 hash**（抽屉不是四视图之一，最小改动），把它升级成路径/带历史是**后续可选项**，不在本卡实现（§9 O-2）。

### 4.5 视图切换的四个入口，一律走 `navigate()`

**`navigate(v)` 写的地址 = 目标视图的规范地址（§3）**；四个视图里只有 activity 的规范地址带载荷，所以 `navigate("activity")` 写的是 **`/activity` + 当前筛选槽**（`?actor` → `?event` → `?task`，§4.6 的四条规矩不变）——离开动态流再回来，地址落回读者离开时那三个条件，与 §4.6 末条「筛选值活在 store 里、回来自会照旧」是同一条口径。按旧字面写裸 `/activity` 会产出**陈旧地址**（地址无条件、屏幕有条件），正是本轮要消灭的东西。⇒ **本节字面按此修订**（取法来源：Elon 2026-10-13T19:14:20Z 裁定 ③「采纳实现取法」；§11 记）。

| 入口（今天） | 今天怎么写 | R16 之后 |
|---|---|---|
| 侧栏 `[data-nav-item]`（`Sidebar.vue:onNav`） | `setView(item)` | `navigate(item)` → `pushState(目标视图规范地址)`（activity 含当前筛选槽） |
| 顶栏 `[data-view="board"\|"list"]`（`TopBar.vue`） | `setView(mode)` | `navigate(mode)` |
| 名册名字按下（`Sidebar.vue:onAssignee`） | **实读**：仍 `setView("list")` + `writeStatusFilter(["in_progress","in_review"])`——**R11 的路由那一半**，而 `DESIGN.md §31.3` / `BLOCKS.md §B03` 的 R13 修订（决定甲）把它**撤掉了**；原型实测**同意甲**（按下 → 视图与状态集都没动，§7.1）⇒ 这是**本轮之前就存在的**设计文本 vs（实现 + `dom-smoke` harness）漂移（§9 O-5） | **若这半边还在**，它必须走 `navigate("list")`（写地址 + 进历史）；**本轮不裁决**它该不该在——D2 只负责让它在时走对口径 |
| 动态流一行里的任务锚（`ActivityView.vue:onTask`） | `view.value = "board"` | `navigate("board")` → `pushState('/board')` |
| **开机地址**（`ActivityView.vue:onMounted` 里的 `#/activity` 判断） | `view.value = "activity"` | **删掉**：由 §4.3 的 `applyLocation` 统一拥有（§7.3 的口径说明） |

### 4.6 `/activity` 的 query 语义

- 槽位即地址的全部载荷：`?actor=…&event=…&task=…`，**顺序固定** `actor → event → task`（与今天一致）。
- **`all` 不写**；三者都在 `all` 时**整段 query 不写**（`/activity`）。
- **槽位语义（一处精确化，与今天等价）**：一个槽位**缺失**、值是 `all`、或值**不在域内**，三者**同义**——都表示「这一格没有条件」。`task` 例外：它取任何标识符。
- 重复槽位按**出现顺序**逐个应用，**最后一个被接受的值胜出**（沿用今天逐对遍历的行为）。
- 其余 query 槽位**忽略**（不读、不写、不抹——路由只对 `/activity` 的这三个槽负责）。
- **筛选永不进历史**：三个控件、Clear、空态的 Clear 都走 `replaceState`。⇒ **后退只撤销视图，从不撤销筛选**（这是把 `activity.js` 今天的规矩**推广**成整套契约的规矩）。
- 开机/后退**进入** `/activity` 时，筛选**按地址原样落定**（缺失槽位 ⇒ `all`），不保留上次会话里的残留：地址是这一格的真相。⇒「刷新不丢」与「后退不脏」是同一条规矩。
- 从 `/activity?actor=agent` 离开到别的视图，**不动** activity 的三个筛选（地址对别的视图没有这一格的发言权；筛选值活在 store 里，回来自会照旧——地址是真相的**范围**仅限当前路由）。

### 4.7 不变的东西（R16 不得触碰）

1. **脚本关闭时的文档**：五条地址拿到**同一份** shell 字节，无脚本默认视图**永远是 board**（`[data-board-view]` 可见，其余三个根 `hidden`）。**path 路由不能、也不需要**让无脚本读者直达到别的视图——那是服务器渲染的事，不在本轮。（⇒ 深链是 **JS-only** 能力，明写。）
2. **侧栏高亮**：`[data-nav]` 范围内**恰一个** `[data-nav-item]` 带 `aria-current="page"`，且它就是当前路由；`[data-project]` 行自己的 `aria-current`（当前项目）**另有主人，不改**。
3. **顶栏 toggle**：`[data-view="board"|"list"]` 的 `aria-pressed` 只对 board/list 两条路由为 `true`；在 `/activity`、`/waiting` 上**两者皆 `false`**（toggle 陈述的是「看板区域在显示什么」，而不是「当前在哪一页」）。**实测原型**：board 上 `board=true list=false`，按侧栏进 activity 后 `board=false list=false`（§10 驱动表 `viewToggle` 列）——R16 照抄这个状态，不新增第三个语义。
4. **筛选条可见性**：`boardArea`（board|list）才有筛选条——路由化**不得**改变它；`/activity`、`/waiting` 上筛选条仍然退场。
5. **卡片筛选与搜索不进地址**：`?` 的命名空间在**本轮**只有 activity 的三个槽（§9 O-3）。主题/语言的偏好**永不进地址**（`DESIGN.md §21`：浏览器本地）。
6. **`?theme=` / `?lang=`** 是 `design/activity/activity.js` 里**原型专用**的入口开关（`DESIGN-activity.md` §「原型的入口，不是产品设计的一部分」），**不是**产品槽位，且与 `/activity?actor=…` 不在同一个文档里，无冲突。

### 4.8 与 Elon 裁定（2026-10-13T10:46:33.515Z · 卡 Comments · 经 sessions_send 转记）的逐条对齐

裁定**比本 lane 开工晚 5 分钟**（10:41:06Z 起），handoff 未含；本契约已按其口径对齐，逐条落点如下。**没有一条与裁定冲突**；唯一的**改动**是 ②——它推翻的是本契约**第一版草稿**的判断（草稿选「旧式不做兼容读」），本版按裁定改为**双读兼容并重定向**（§4.4）。

| 裁定 | 本契约的落点 | 状态 |
|---|---|---|
| （首句）path 路由 + 零服务器改动**已批准** | §2 + §10 A 腿——并把它的前提**从「实读」升级成 8/8 实测**（五条候选地址全 200 shell；缺失资源与 `/api/v1/nope` 仍 404 JSON） | 对齐；本契约**独立复现**了裁定的前提 |
| **①** 旧 `#/activity?…` → **双读兼容**：canonical 用 query，旧 hash 读入并重定向，不硬断旧分享链接 | §3 第四条归宿 · §4.3 步骤 2 · §4.4 · §5（`legacyActivityQuery`）· §6 B4 / C12 | **本版按裁定改**（第一版草稿相反；改动记在 §11） |
| **②** 详情抽屉 `#/task/<id>` → **保留 hash**，仅登记为后续可选升级、不在本卡实现 | §4.4 末段 · §9 O-2（原文即「保留」，现补上「升级成路径或带历史 = 后续可选，不在本卡」） | 对齐（本契约的判断与裁定同向） |
| **③** list → **独立 `/list`** | §3 映射表第 3 行（四视图各一条路由；`/list` 不是 `/board` 的一个态） | 对齐 |
| **④** 历史边界：视图切换 `pushState`、筛选收窄 `replaceState`；**toast/抽屉不进历史** | §4.2 两个写者 · §4.6「筛选永不进历史」· §9 O-2（toast 本就不写 `history`；抽屉不进地址 ⇒ 不进历史） | 对齐 |

> 编号即裁定原文的编号（①–④）；「path 已批准」是它的首句，不是第五项。

---

## 5. 实现侧改动面（**实读，未实测**）

按「一个模块一张表、两个写者、一个读者」落。**建议**的模块与名字（D2 可以改名字，但**不得**改职责划分与写入口径）：

- **新模块**（建议 `web/src/lib/route.js`）：路由表（§3 五行 + 四条归宿，含旧 fragment 的读入与重定向）、纯函数 `routeFor(pathname)` / `pathFor(view)` / `activityQuery(filters)` / `readActivityQuery(searchOrLegacy)` / `legacyActivityQuery(hash)`。**解析与格式化必须是不带 `location` 的纯函数**——`activityHash()` 今天就是这条先例（`test/web/activity.feed.test.mjs` 不碰 `location` 就断言了它的形状）。`legacyActivityQuery(hash)` 只回答「这是不是动态流的旧地址、载荷是哪一段」（`null` / `""` / `"?…"`），**域规则一律交给 `readActivityQuery`**，不许长出第二套。
- `web/src/stores/ui.js`：`view`/`setView` 改为路由派生；`setView` 的职责换成 `navigate`。
- `web/src/stores/activity.js`：`HASH_SLOTS`/`activityHash`/`writeActivityHash`/`readActivityHash` 换成 query 形态；写者的目标从 `location.hash` 换成 `location.search`，**且保留 pathname 与 fragment**（写者**永不写**旧形——旧形只被读、被消费）。
- `web/src/components/board/ActivityView.vue`：两处 `view.value = …`（`onTask`、`onMounted`）交出所有权。
- `web/src/components/shell/Sidebar.vue`：`onNav`、`onAssignee`。
- `web/src/components/shell/TopBar.vue`：toggle 的按下。
- `web/src/App.vue`：挂载时 `applyLocation`，并注册 **`popstate`**（今天 `web/src/**` 与原型 `design/prototype/app.js` 都**没有** `popstate`/`hashchange` 监听——两边都是 grep 枚举出来的零，不是抽样）。
- `test/web/activity.feed.test.mjs`：今天断言 hash 形状与 `#/task/TD-1` 的那几条（`activityHash()` 的四条形状、`readActivityHash` 的三条、写者那条「驻留地址不再写」）改成 query 形态；`#/task/…` 那条搬到路由自己的用例里。
- `web/scripts/dom-smoke.mjs`：B26 快照里的 `hash` 字段与两条 `b26Check`（`#/activity?actor=agent`、Reset 后 `#/activity`）改成读 `location.search` 的 `?actor=agent` 与 `""`。**这是那条老规矩的又一例（动一个地址写法就抖掉断言它的 harness）**：本轮的抖恰好落在 `test/web/activity.feed.test.mjs` 与 `web/scripts/dom-smoke.mjs` 两处，两处都在 D2 的写面（`web/**`）内——没有一处逃到别的卡的写面去。

---

## 6. 机检断言清单（D2 落地后应全绿；**今天全红**——路由不存在）

### A · 服务器（静态检查 + 一条真跑）

| id | 断言 | 怎么测 |
|---|---|---|
| A1 | `/`、`/board`、`/list`、`/activity`、`/waiting`、`/activity?actor=agent`、`/board/`、`/index.html` **八条都 200 且 `content-type: text/html`**，body 是 shell | 起 `taskd`（有 `web/dist`）逐个 `fetch`；**今天已绿**（§10 探针 8/8），D3 复跑即复现 |
| A2 | `/assets/gone.js` → **404 `application/json`**；`/api/v1/nope` → **404 JSON** | 同上；**今天已绿** |
| A3 | 四个路由名不在服务器路由表里（表里只有 `/api/v1/**` + `/health`） | 静态：`src/server/routes/**` + `index.mjs` 的 `/health` 分支 |

### B · 纯函数（无浏览器）

| id | 断言 |
|---|---|
| B1 | `pathFor` 五个视图 → `/board` `/list` `/activity` `/waiting`（顺序即上表） |
| B2 | `routeFor("/")`、`routeFor("/index.html")`、`routeFor("/nope")`、`routeFor("/borad")` **都**是 board，且**都**带「需规范化」的标志；`routeFor("/board/")` 是 board 且带该标志；`routeFor("/Board")` 是 board（大小写敏感 ⇒ 未知） |
| B3 | `activityQuery({all,all,all})` → `""`；`{agent,all,all}` → `"?actor=agent"`；`{all,delivery,"TD-6"}` → `"?event=delivery&task=TD-6"`；三槽齐 → `"?actor=agent&event=status&task=TD-1"`（顺序固定） |
| B4 | `readActivityQuery("?actor=nonsense")` → 三个筛选**全 `all`**（域外值 = 无条件），返回 `false`；`"#/task/TD-1"` 不被读；`"?actor=agent&actor=all"` 后者胜 |
| B5 | 写者的 URL 合成**保留 pathname 与 fragment**：给定 `{pathname:"/activity", search:"", hash:"#/task/TD-1"}`，写出的第三个参数是 `/activity?actor=agent#/task/TD-1` |
| B6 | 写者**幂等**：目标地址与当前地址相同时**不调用** `replaceState`（沿用今天 `activityHash` 的那条断言） |
| B7 | **旧形识别（裁定 ①）**：`legacyActivityQuery("#/activity?actor=agent&event=status&task=TD-128")` → `"?actor=agent&event=status&task=TD-128"`；`legacyActivityQuery("#/activity")` → `""`；`legacyActivityQuery("#/task/TD-1")` → `null`；`legacyActivityQuery("")` → `null` |
| B8 | **旧形不另立规矩**：`legacyActivityQuery` 的输出喂给 `readActivityQuery` 时行为与 query 形**逐条相同**（域外值 → 无条件；`all` → 不写） |

### C · 浏览器驱动（真 Chromium；**逐条真加载**见 §1.4）

| id | 断言 | 怎么测 |
|---|---|---|
| C1 | 四个视图地址各自**真加载**后：目标视图根可见、其余三个 `hidden`、`[data-nav]` 内**恰一个** `aria-current="page"` 且是它 | 每条 `about:blank` → `goto` |
| C2 | `/` 与 `/index.html` 真加载后 `location.pathname === "/board"`（默认重定向落地） | 同上 |
| C3 | 侧栏按下 `activity` 后：视图换、`location.pathname === "/activity"`、**`history.length` +1** | 真实指针 |
| C4 | 在 `/activity` 按筛选 `actor=agent`：`location.search === "?actor=agent"`、**`history.length` 不变**（筛选不进历史） | 真实指针开下拉 + 点行（R15 之后是 `dropdown` 面板） |
| C5 | 依次 `/board` → `/activity` → `/waiting`，`history.back()` 两次：地址与视图**逐级回退**，第二次落在 `/board`；且**筛选值不被回退**（对照 C4） | `page.goBack()` |
| C6 | 深链 `/activity?actor=agent&event=status&task=TD-128` 真加载：视图是 activity、三个控件的值就是这三个、**账本已回填**（不是空态） | 真加载 + 等回填 |
| C7 | 未知地址 `/nope` 真加载：视图是 board、`location.pathname` 已被规范化为 `/board`、**无新 toast** | 真加载；toast 用**增量**判（`[data-toast-region] [data-toast]` 的计数与操作前比），**不要**断言绝对 0——`template[data-toast-template]` 里就坐着一个 `[data-toast]` 样板，模板子树在 Vue 下可被 query 到 |
| C8 | 抽屉对照：在 `/activity` 点一行内的任务锚 → 视图回 board、`location.pathname === "/board"`、**fragment 未被写**（`location.hash === ""`） | 真实指针 |
| C9 | 脚本关闭（`javaScriptEnabled:false`）下四条地址真加载：都是同一份 shell、board 可见、其余三个 `hidden`（§4.7 ①） | 原型侧已有同类惯例 |
| C10 | 在 `/activity` 与 `/waiting` 上，`[data-view="board"]`、`[data-view="list"]` 的 `aria-pressed` **都是 `false`**；在 `/board`/`/list` 上恰一个为 `true`（§4.7 ③；原型实测值见 §10） | 真加载 + 读属性 |
| C11 | `[data-nav]` 内带 `aria-current="page"` 的 `[data-nav-item]` **恰一个**，且 `[data-project]` 行的 `aria-current`（当前项目）与它互不影响（§4.7 ②） | 真加载 + 读属性（**范围必须限定在 `[data-nav]`**——项目行复用同一属性名） |
| C12 | **旧分享链接可用（裁定 ①）**：真加载 `/#/activity?actor=agent&event=status&task=TD-128` → 视图是 activity、三个控件的值就是这三个、`location.pathname === "/activity"`、`location.search === "?actor=agent&event=status&task=TD-128"`、**`location.hash === ""`**（fragment 被消费）、**`history.length` 不变**（重定向用 `replaceState`）；再加载 `/#/activity` → 同样的重定向到 `/activity`（不带 `?`） | 真加载（每条 `about:blank` → `goto`） |
| C13 | **抽屉的 fragment 不被消费（裁定 ②）**：真加载 `/#/task/TD-1` → 视图是 board、`location.pathname === "/board"`、**`location.hash` 仍是 `#/task/TD-1`**（路由不读不写它；抽屉不开——今天也不开） | 真加载 + 读 `location` |

**D3 的运行前提**：① 必须在**有 `web/dist`** 的环境里跑（无构建时每条地址都是 404 JSON，§2 约束 5）；② 每条地址**真加载**（§1.4）；③ `web/dist` 必须是**当次**构建的产物（旧 `dist` 会让 C 腿指着一个没有路由的壳）。

---

## 7. ⑤ 原型一致性与三处必须点名的出入

### 7.1 结论：**无视觉/交互变更**

R16 加的是**地址层**，在**产品壳**里；原型是一个静态文档 + 一个 jQuery 层，**地址层不是它的表面**。实测（§10 原型探针 10/10 + 一条观察）证明这不是宣称：

- 侧栏按下 → 视图换、**地址一位没动**、`history.length` 8→8；
- 筛选按下 → 地址写成 `#/activity?actor=agent`、`history.length` 仍 8（`replaceState`）；
- 带 `#/activity?actor=agent&event=status&task=TD-128` 真加载 → **筛选恢复了、视图没换**（`[data-activity-view]` 仍 `hidden`，`[data-nav-item]` 当前仍是 `board`）；
- **地址会留在原地不管视图**（同一次驱动里实测）：在 activity 上按筛选后地址是 `#/activity?actor=agent`，再按侧栏回到 board，**地址仍是 `#/activity?actor=agent`**——视图是 board。⇒ 原型今天会留下一个**与当前视图不符的陈旧地址**。这正是 R16 要消灭的那类东西，也是「原型没有 URL 层」最直白的一条证据；
- 名册名字按下 → 视图与状态集**都没动**（nav `board` → `board`，`data-filter-status-value` 一直是 `all`），与 R13 决定甲一致（§7.3.3）。

⇒ **原型既没有要改的面，也没有可对账的期望值**：本轮对原型**零改动**，`design/prototype/**` 一行不动（`design/BLOCKS.md` 只加一句交叉引用，§7.2）。原型的四个视图根、`aria-current` 唯一性、顶栏 toggle 的两值性、筛选条的归属，是 R16 **不得削弱**的既有不变量（§4.7），它们各有自己的 harness（`test/web/blocks.contract.mjs`、`web/scripts/dom-smoke.mjs`、`web/manifests/board-m2.json`）继续守着。

### 7.2 `BLOCKS.md §B03` 的一句交叉引用

`§B03` 现在写「handler 把每个 `[data-nav-item]` 交给 `setView()`」。R16 之后按下还**写下地址**，那句话会成为**半句真话**。因此 `§B03` 加一句（不改块结构、不改钩子、不动计数）：**按下经 `navigate()`，既换视图也写地址**，并指向本文件与 `DESIGN.md §32`。这与 R14 在 `§B09` 登记实现侧事实是同一类文档同步。

### 7.3 与原型/设计文档的**出入**（必须先说，不能悄悄圆过去）

1. **实现侧 `ActivityView.vue:onMounted` 已经有一条「`#/activity` 地址进入视图」的规矩，原型没有。** 原型只把地址当**筛选载荷**读（实测：带 `#/activity?…` 真加载，视图根仍是 board、侧栏高亮仍是 board，只有三个筛选值被恢复），实现把「进入视图」也加上了，而那段注释引的 `design/activity/DESIGN-activity.md §6` **只写了筛选那一半**。⇒ 按闭集口径：实现这半边是**自创**；R16 把它**接过来写成契约**（epic 要求深链直达四视图），并顺手**收权**——它从视图的 `onMounted` 搬到路由器，由 `applyLocation` 统一拥有（§4.5），免得每加一个视图就多一处「开机看地址」的分支。**这不改变视觉**（视图根与 `hidden` 属性都没变），只改变**谁拥有**这条规矩。**Elon 裁定 ① 又把它盖了一次**：旧形 `#/activity?…` 要**读入并重定向**到 `/activity?…`，而重定向的落点是 activity 视图 ⇒ 同一条「进入」规矩现在**两个载体都适用**（旧形与 query 形），实现侧原来的行为因此被**保留**（而不是被 R16 抹掉），只是换了个拥有者。
2. **载荷位置变了，规矩没变。** `#/activity?…` → `/activity?…`。**视觉与交互零变更**（地址栏不是文档），但**任何断言 hash 字面量的 harness 必须跟着改**（§5 末两条）。这是本轮唯一「会抖别人」的地方，明写在此。
3. **名册按下的「路由那一半」：设计文本 vs（实现 + harness）不一致，且这在 R16 之前就存在。** 三列实测/实读：**原型** = 按下只写名字（视图 `board`→`board`、状态集恒 `all`，与决定甲一致）；**设计文本** = `BLOCKS.md §B03` 与 `DESIGN.md §31.3` 已按甲撤销路由与状态集；**实现** = `Sidebar.vue:onAssignee` 仍 `setView("list")` + `writeStatusFilter(["in_progress","in_review"])`，而 `web/scripts/dom-smoke.mjs` 的 R11 段正**断言**这条路由写下的状态集（`in_progress,in_review`）。⇒ 实现与 harness 站在 R11，设计文本站在甲。**R16 不裁决谁对**（那是 R13 那条线的账），但两个后果必须交给 D2：(a) 若这半边保留，它必须走 `navigate("list")`（否则按下会换视图却不写地址，正是本轮要消灭的**陈旧地址**）；(b) 若顺手按甲删掉它，`dom-smoke` 的那条断言会红——**那属于 D2 的写面（`web/**`）但要先有裁定**，见 §9 O-5。

---

## 8. 文档同步判定（epic ④ 的一半）

| 文档 | 判定 | 依据 |
|---|---|---|
| `design/DESIGN.md` | **要写**：新增 `§32`（本轮的规范小节，§32.1–§32.6） | 四视图与侧栏导航的权威陈述在 `§29.2`/`§30`，而 URL 层是新的横切面 |
| `design/BLOCKS.md` | **写一句**：`§B03` 交叉引用（§7.2） | 块结构零变化；那句话不然会变半真 |
| `design/activity/DESIGN-activity.md` §6 | **不改**：它是 B26 当轮的对账记录（记录不改），其「筛选态入 URL」由本文件接管并换载体（§4.4） | 记录 vs 规范：规范进 `DESIGN.md §32` |
| `README.md` / `README.zh-CN.md` | **无影响**（附理由）：README 讲项目、安装、路线图，不描述板的地址方案；M6 的路线图条目不含 URL 路由 | 路由是 M6b 之后的一层实现细节 |
| `docs/web-local-first.md` | **无影响**（附理由）：该页讲的是**远程 token 访问**的缺口与 loopback 前提；URL 路由不改鉴权、不改 API 前缀、不改 `/events` 的 `?after=` 游标 | 两者唯一的接触点是「前端从同源根取相对 URL」，`base: "/"` 已经如此 |
| `docs/contract.md` | **无影响**：那是 **HTTP API 契约快照**（routes + 请求形状 + 错误码 + wire 字段）；本轮**不加任何 API 路由**，服务器零改动（§6 A3） | |

---

## 9. 边界（本轮不动）与未决项（**须 Elon 裁定，不自行发散**）

### 9.1 边界

- **不动**：`web/**`、`test/**`、`src/**`、`design/prototype/**`（一行）。
- **不加**：卡片级路由（`/board/<ref>`）、抽屉的地址（`#/task/<id>` 或路径）、board/list 的筛选与搜索进地址、主题/语言进地址、任何新 UI 表面（错误页/toast/加载态）。
- **不删**：抽屉的 `#/task/<id>` 锚（无脚本读者的可点链接）与其作为「从行找到卡」的键（`activityCard` 的读法）。

### 9.2 未决项

| id | 问题 | 本契约的取法 | 若要改，代价 |
|---|---|---|---|
| O-1 | 卡片级路由 `/board/<ref>`（`static.mjs` 注释点名的形态）是否本轮一起开？ | **不开**。表是闭集但**可扩展**，加一行即可，规则不变 | 加一行 + 一条「深链直接开抽屉」的断言；但会立刻撞上 O-2（抽屉与历史的契约），所以建议两者一起裁 |
| O-2 | 抽屉要不要也进地址（`#/task/<id>` 真的写、`popstate` 真的开抽屉）？ | **不**——**Elon 裁定 ② 已定：保留 hash，不动**；升级为路径或带历史是**后续可选项**，不在本卡。后果明写：在 `/activity` 从一行里打开卡片会 `pushState('/board')`，此时**后退**把视图退回 `/activity` 而**抽屉仍开着**（抽屉不在地址里，后退管不到它） | 需要一条新契约（抽屉的开/关与历史的关系），并与「无新交互表面」冲突——建议留作独立需求 |
| O-3 | board/list 的筛选、搜索要不要进地址？ | **不**。本轮 query 命名空间只有 activity 的三个槽 | 会改变「可分享」的含义（今天只有动态流可说「这个链接是我的视图」），并要定第二套槽位口径 |
| O-4 | 旧式 `#/activity?…` 要不要**兼容读**？ | **要——Elon 裁定 ① 已定：双读兼容并重定向**（§4.4）。第一版草稿选的「不做」被推翻 | 已裁决，不再是未决项；实施要点是「解析器只有一个」（B8）与「重定向用 `replaceState`」（C12） |
| O-5 | **名册按下的路由那一半**（§7.3.3）：实现 + `dom-smoke` 仍按 R11 路由到 list 并写状态集，设计文本（甲）已撤销——**谁对？** | **不裁决**；D2 在当前状态（保留）下必须让它走 `navigate("list")` | 若按甲删除：`dom-smoke` 的 R11 断言要改（在 `web/**` 写面内，但需先裁定）；若保留：需把 `BLOCKS.md §B03` / `DESIGN.md §31.3` 的措辞与实现重新对齐 |

---

## 10. 证据与复跑

两个探针都在卡工作区（**不在仓库里**），只**读**仓库（或 `design/prototype/**`），不改任何仓内文件。

```bash
# A · 服务器：path 路由到底要不要改服务器？（替身 web/dist + 真 createTaskd + loopback）
node <workspace>/evidence/r16-route-probe.mjs <repo-root>          # → 8/8，原始输出 r16-route-probe.txt
# B · 原型：它对地址有没有观点？（内置静态服务 + Playwright Chromium headless 1512×950，真实指针）
node <workspace>/evidence/r16-prototype-address-probe.mjs <repo-root>  # → 10/10，原始输出 r16-prototype-address-probe.txt
# C · 既有服务端契约（宿主允许：node --test）
node --test test/server/static.test.mjs                             # → 8/8（含 `/board/PROJ-0001` 回落与 `/api` 不被遮蔽）
```

`<workspace>` = `/Users/tanyu/.openclaw/team/workspace/T-20261013-183505-2`。

**A 腿的原始结论**（`r16-route-probe.txt`）：14 条候选地址的 status/content-type 表 + 8 条断言全 PASS，其中「`/` 与四个路由名 + query + 两条尾斜杠 + `/index.html` 都是 200 `text/html` 的 shell」「`/nope` 也是 200 shell（⇒ 服务器对坏路由**没有** 404）」「缺失资源与 `/api/v1/nope` 仍是 404 JSON」「shell 是 `no-cache`」。

**B 腿的原始结论**（`r16-prototype-address-probe.txt`）：三条地址真加载后的视图/高亮/筛选值表（第三行 `agent / status / TD-128`，而 `activity` 仍是 `hidden`、高亮仍是 `board`）+ 驱动表（`at rest` → `nav press` → `filter press` → `before roster` → `roster press` 五次快照的 `href`/`hash`/`entries`/`nav`/`statusFilter`/`viewToggle`）+ 10 条断言全 PASS + 一条**观察行**（名册按下后视图仍是 `board`，与决定甲一致，见 §7.3.3）。驱动表里三处要留意：`before roster` 那一行的地址**仍是** `#/activity?actor=agent` 而视图已是 `board`（陈旧地址，§7.1）；`nav press` 那一行 `viewToggle` 是 `board=false list=false`（§4.7 ③ 的实测值）；`roster press` 让视图、状态集、地址**都不动**。

**未跑（明写）**：D2 的实现侧一行都没有实测——没有 `web/dist`、没有 `web/node_modules`，未构建、未起服务、未驱动。§5 的每一条都是**实读**；§6 的 B/C 腿**今天全红**（路由尚不存在），它们是对 D2 的验收清单，不是本轮的自证。

---

## 11. 修订记录

| 版本 | commit | 内容 |
|---|---|---|
| 第一版草稿 | `82c21da`（本 lane 私有，**未进 main**） | 按卡 `## Background` 落稿：path 方案、映射表、地址是真相、**activity 筛选「并入 query，旧式 hash 不做兼容读」** |
| **本版（唯一口径）** | 本 lane 的最终 commit（见卡 `## Report` 记的 sha） | 对齐 **Elon 裁定（2026-10-13T10:46:33.515Z，卡 `## Comments`，经 sessions_send 转记；比本 lane 开工晚 5 分钟）**：旧式 `#/activity?…` 改为**双读兼容并重定向**（§3/§4.3/§4.4/§5/§6 B4·B7·B8·C12），并补记 ②抽屉保留 hash（新增 §6 C13 与 §9 O-2 的「后续可选」措辞）、③`/list` 独立、④历史边界三条已对齐的条目（§4.8）。**唯一被改变的判断是 O-4**（兼容读：不做 → 做）。 |
| **§4.5 字面修订**（doc-sync · `T-20261014-031420`） | 见该卡 `## Report` 记的 sha | 按 **Elon 裁定 ③（2026-10-13T19:14:20Z）**：§4.5 的写入口地址口径由 `pushState('/' + item)`（activity 会写成裸 `/activity`）修订为**目标视图规范地址（activity 含当前筛选槽）**，与 §3 规范地址（三槽）、§4.2「目标规范地址」、§4.6「地址是真相」一致。**只改 §4.5 字面**——映射表（§3）、断言清单（§6）、结论（§1/§7/§8）、§5 的实现建议与姓名一律不动；本文件其余各处「唯一口径」不变。 |

> 第一版草稿的 sha 只作记录：它已被本版取代，不构成第二份口径（§4.4 的规矩以本版为准）。
