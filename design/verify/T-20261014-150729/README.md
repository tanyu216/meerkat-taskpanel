# T-20261014-150729 · R14 详情抽屉「原型 ↔ 实现」五宽度视觉对照

> R14 epic（`T-20261013-154925`）收尾条件里的「**Elon 亲看原型↔实现五宽度截图**」那一条。
> 链路此前只有 computed/DOM/selector 级判真（`154930-3`），`125122` 明确登记「未做像素级截图对比」；本目录补这一腿。

## 结论

**五宽度几何完全一致，抽屉内容逐块可读；另登记 10 行差异读数（9 条可见差 + 1 条同色口径澄清，其中 1 条是原型自身缺陷）。**

- 五宽度抽屉盒 **逐像素一致**：`x/w` 双侧同为 `992/520`、`720/520`、`460/520`、`240/520`、`0/430`，两侧各宽度 **无横向溢出**（`scrollWidth == clientWidth`）。
- 七个内容块（属性栅格 · 描述 · 关系 · 附件 · 评论 · 活动 · 会话）在**五个宽度 × 两侧**全部 `visible`，宽度同值（≥760 为 479；430 为 389）。
- 三态（agent / human / zh）与两个空席位（`relations.none`、`attachments.none`）双侧各至少一图。
- **未发现「实现缺失某块」**；差异集中在刻度/盒径/文本形制（见 §4），且其中 1 条是**原型侧**的缺陷。

**本卡只出证据与读数，不代替 Elon 判 verdict。**

## 交付坐标

| 项 | 值 |
|---|---|
| 卡 | `T-20261014-150729` |
| 被验仓（只读） | `/Users/tanyu/Documents/meerkat-taskpanel`（本 lane worktree `…-wt-T-20261014-150729-seg1`，branch `lane/T-20261014-150729-seg1`） |
| 写面 | 本目录（`design/verify/T-20261014-150729/**`）—— 实现/契约**零改** |
| 原型腿 | `design/prototype/index.html` + `app.js`，经 `capture.mjs` 的只读静态载体加载 |
| 实现腿 | `http://127.0.0.1:9527/` 所服务的构建：`assets/index-2PH8KyYB.js` **sha256:8c600ba1f3bbd8d5** · `assets/index-DC60oicY.css` **sha256:81539880ba430f6b**（本目录 `evidence.json` → `readings.servedBuild`，同一 run 内从响应体实测） |
| 生成 | 见 `evidence.json` → `generated_at` |

## 怎么读（判据）

| 判据 | 定义 | 载体 |
|---|---|---|
| ① 五宽度 | 视口宽 1512/1240/980/760/430，高 900；两侧同卡（TD-128）、同态（en · agent）、同开度 | `shots/a-w*-side-by-side.png` + `evidence.json` → `readings.{proto,impl}.w*` |
| ② 三态 | default(agent TD-128) / human(TD-126) / zh(TD-128)；关系三目录 = Parent(TD-128) + Blocks(TD-128) + Related(TD-126)；空态 = `relations.none` + `attachments.none`(PROJ-0007) | `shots/b-*-side-by-side.png` |
| ③ JS-off 静态结构 | **判据 = JS 禁用下，抽屉结构钩子是否仍在 DOM 中、且布局盒可见**（`w/h>0` 且 `visibility≠hidden`） | `shots/c-js-off-side-by-side.png` + `readings.jsOff` |
| ④ 交互态 | 打开落焦 `document.activeElement === [data-detail-close]`；遮罩涂出色 / 全屏盒；抽屉体自身滚动面（`scrollTop/scrollHeight/clientHeight`） | `shots/d-*-side-by-side.png` + `readings.{focus,overlay,scroll}` |
| ⑤ 逐块可见 | 每块的 `getBoundingClientRect()` 宽高 + `visibility/display`，逐宽度逐侧 | `readings.{proto,impl}.w*.blocks` |

## 1. 证据清单

**A · 五宽度（TD-128 · agent · en · 抽屉打开态）**

| 文件 | sha256:16 | 宽度 → 态 → 结论 |
|---|---|---|
| `a-w1512-proto.png` | `cbc7dd9598aba9ea` | 1512 · 原型 · 抽屉 `x=992 w=520 h=900`，七块全可见 |
| `a-w1512-impl.png` | `75481baad7ea93c3` | 1512 · 实现 · 同上几何；差异见 §4 |
| `a-w1512-side-by-side.png` | `8789d0a98586b8e3` | 1512 · 并排面（交付面） |
| `a-w1240-proto.png` | `e239c6206bfbfe5e` | 1240 · 原型 · `x=720 w=520` |
| `a-w1240-impl.png` | `947e6c68f95c2bce` | 1240 · 实现 · 同上 |
| `a-w1240-side-by-side.png` | `ec1b492daec72b21` | 1240 · 并排面 |
| `a-w980-proto.png` | `1ab890a54ef58896` | 980 · 原型 · `x=460 w=520` |
| `a-w980-impl.png` | `bdc5c733dc7dfdbd` | 980 · 实现 · 同上 |
| `a-w980-side-by-side.png` | `f0e370841a938bd8` | 980 · 并排面 |
| `a-w760-proto.png` | `e86b2c035f0577fb` | 760 · 原型 · `x=240 w=520` |
| `a-w760-impl.png` | `f096311ceba66c37` | 760 · 实现 · 同上 |
| `a-w760-side-by-side.png` | `21d1c7f65ff7b29d` | 760 · 并排面 |
| `a-w430-proto.png` | `7f41910cfcbdab43` | 430 · 原型 · `x=0 w=430`（`max-width:100vw` 生效） |
| `a-w430-impl.png` | `15a8a1919a3ab838` | 430 · 实现 · 同上 |
| `a-w430-side-by-side.png` | `a1e123d2e72d56e9` | 430 · 并排面 |

**B · 三态（1512）**

| 文件 | sha256:16 | 态 → 结论 |
|---|---|---|
| `b-human-proto.png` / `b-human-impl.png` / `b-human-side-by-side.png` | `88c228418f946d28` / `e7fc143b53a99e20` / `3ad8f2f5b97802b6` | **human 卡 TD-126**（Terry · `human`）· 会话段按域规则**隐藏**（双侧 `session.hidden=true`）· 关系目录 `Related` 各一行 |
| `b-zh-proto.png` / `b-zh-impl.png` / `b-zh-side-by-side.png` | `ffd643dd543f7b2e` / `ee6e37c4ff5a6219` / `caf395220055e881` | **zh**（`html[lang]`：原型 `zh-CN` / 实现 `zh` —— 各侧自己的 locale id，B23 口径）· 关系目录中文 `父任务`/`阻塞` 双侧一致 |
| `b-empty-proto.png` / `b-empty-impl.png` / `b-empty-side-by-side.png` | `31c6930382f8a248` / `d45462966a7e5a07` / `df7216df2e4dfed5` | **空态 PROJ-0007**（9 字符 id）· `relations.none` 与 `attachments.none` 双侧同文案、同位置 |

> **关系三目录**：`Parent` 与 `Blocks` 由 TD-128 一图给全，`Related` 由 TD-126 一图给出；**原型没有同时带三目录的卡**（18 张卡的 `data-relations-*` 计数里最多两目录，实测扫描）。实现侧的 `RELATION_ORDER` 支持一张卡给全（`DetailDrawer.vue:202`），但**本卡没出那张图** —— 上表是「双侧各至少一次」的满足方式，不是两侧同卡同目录的对照。这是**原型样本限制**。

**C · JS-off 静态结构（1512）**

| 文件 | sha256:16 | 结论 |
|---|---|---|
| `c-js-off-proto.png` | `b176283cf6673d30` | 原型：**18 张卡**静态渲染，抽屉钩子 **14/14 present**、**0 visible**（关闭面 `translateX(100%)`+`visibility:hidden`） |
| `c-js-off-impl.png` | `dc8c52ed5c9ef503` | 实现：`#app` **children=0 / text 0 字符**，`[data-card]` **0**，抽屉钩子 **0/14 present** |
| `c-js-off-side-by-side.png` | `d60f7397e3ff5934` | 并排面：左侧整块看板可读，右侧空白 —— SPA 的 by-design 结构差 |

**D · 交互态（1512）**

| 文件 | sha256:16 | 结论 |
|---|---|---|
| `d-focus-proto.png` / `d-focus-impl.png` | `cbc7dd9598aba9ea` / `75481baad7ea93c3` | 落焦帧与 A 组 open 帧**字节相同**（同态同帧，可复现性旁证）；`activeElement` 双侧 = `BUTTON[data-detail-close]` |
| `d-focus-proto-closeup.png` / `d-focus-impl-closeup.png` | `5752b9bbb880a59c` / `d64fdd3c664c75ec` | 抽屉头特写：焦点环形态**不同**（原型 `2px solid rgb(15,122,115)` + box-shadow；实现 UA 默认 `1px auto rgb(0,95,204)`） |
| `d-scroll-proto.png` / `d-scroll-impl.png` | `afe7f49d96c91aae` / `02bafc0425e9e71d` | 抽屉体自身滚动面到底：滚动前 `scrollHeight 1616 / clientHeight 821`（原型）、`1633 / 833`（实现），双侧 `overflow-y:auto`，均能滚到评论+活动尾部 |
| `d-focus-side-by-side.png` / `d-scroll-side-by-side.png` | `1e99d08ad83757e5` / `b0dc54b58badd08f` | 两张并排面 |
| 遮罩 | — | 双侧 `[data-detail-overlay]` `hidden=false`、`data-state=open`、全屏 `1512×900`、`opacity 1`、alpha 均 `0.32`；涂出色原型 `rgba(15,20,23,0.32)` / 实现 `oklab(0.276439 -0.0125 -0.0113 / 0.32)` —— **同色，token 口径（DF-1），不是差** |

**LIVE · 卡面指定的运行实例，不经任何拦截**

| 文件 | sha256:16 | 结论 |
|---|---|---|
| `live-board-1512.png` | `786ca5588f189539` | `:9527` 真板（真数据、真 bundle） |
| `live-drawer-1512.png` | `aed4866bc6f65f49` | 真板点卡开抽屉成功（开在真实卡 `OPENCLAW-T…`）；`[data-detail-version]` 实测渲染 `3`、`[data-detail-relations]` 实测 `No relations` |

## 2. 机检读数（`evidence.json` 摘要）

**五宽度几何**（`drawer.x / drawer.w / drawer.h`，`page.scrollWidth ÷ clientWidth`）

| 宽度 | 原型 | 实现 |
|---|---|---|
| 1512 | `992 / 520 / 900` · `1512÷1512` | `992 / 520 / 900` · `1512÷1512` |
| 1240 | `720 / 520 / 900` · `1240÷1240` | `720 / 520 / 900` · `1240÷1240` |
| 980 | `460 / 520 / 900` · `980÷980` | `460 / 520 / 900` · `980÷980` |
| 760 | `240 / 520 / 900` · `760÷760` | `240 / 520 / 900` · `760÷760` |
| 430 | `0 / 430 / 900` · `430÷430` | `0 / 430 / 900` · `430÷430` |

**逐块盒（宽 × 高，`visible` 全为 true）**

| 块 | 原型 @1512 / @430 | 实现 @1512 / @430 | Δ |
|---|---|---|---|
| 属性栅格 `[data-detail-props]` | `479×270` / `389×270` | `479×281` / `389×281` | **+11** |
| 描述 `[data-detail-description]` | `479×304` / `389×323` | `479×304` / `389×323` | 0 |
| 关系 `[data-detail-relations]` | `479×24` / `389×24` | `479×24` / `389×24` | 0 |
| 附件 `[data-detail-attachments]` | `479×72` / `389×72` | `479×72` / `389×72` | 0 |
| 评论 `[data-detail-comments]` | `479×221` / `389×221` | `479×338` / `389×338` | **+117**（见 §4-8，嵌套口径） |
| 活动 `[data-detail-activity]` | `479×98` / `389×98` | `479×98` / `389×98` | 0 |
| 会话 `[data-detail-agent-session]` | `479×130` / `389×130` | `479×132` / `389×132` | +2 |

**交互**

| 读数 | 原型 | 实现 |
|---|---|---|
| 落焦元素 | `BUTTON[data-detail-close]` | `BUTTON[data-detail-close]` |
| 焦点环 | `2px solid rgb(15,122,115)`，`box-shadow` 有 | `1px auto rgb(0,95,204)`，`box-shadow: none` |
| 滚动面 | `overflow-y:auto`，`1616 / 821`，滚到 `795` | `overflow-y:auto`，`1633 / 833`，滚到 `800` |

**JS-off（§判据③）**

| 钩子 | 原型 present / visible | 实现 present / visible |
|---|---|---|
| `[data-detail-drawer]` 及 9 个抽屉钩子 | 1 / **0**（各） | **0 / 0** |
| `.td-rel-item` / `.td-file` / `.td-comment` / `.td-activity` | 2 / 0 · 2 / 0 · 3 / 0 · 4 / 0 | 0 / 0（各） |
| `[data-card]` | 18 | 0 |
| `#app` | 无（静态文档） | `children:0 · text:0` |

> 原型在 JS-off 下**结构在、不可见**（抽屉是关闭面）；实现在 JS-off 下**结构不存在**（SPA 未挂载）。两侧差异是设计使然，本卡只登记读数。

## 3. 未复核 / 已知限制（如实登记）

1. **实现腿不是本 lane 自建的 dist。** 本 host 无前端 `node_modules`（`web/.vendor/npm-cache` 是 linux/arm64，darwin 上 `vite build` 不可用），故实现腿 = **卡面指定的运行实例 `:9527` 所服务的同一份构建**，静态半经 loopback 代理取得、API 半由本目录 `fixture.mjs` 定格；身份以 bundle 名 + 响应体 sha256 记录（见「交付坐标」）。**未做**：从 lane 源码重建 `web/dist` 后与 `:9527` 产物做字节比对。
2. **两侧背景看板数据不同**（原型静态 18 卡；实现 = fixture 7 卡）。对照面是**抽屉本身**，背景看板不计入比对。
3. **fixture 相对时间是按生成时刻锚定的**（`fixture.mjs` 的 `ago()`），所以 `2h ago` 这类文案只在本 run 的时间点上有意义；原型侧是静态写死的同一文案。两侧 `title` 属性里的绝对时间戳因此不同。
4. **未复核**：明/暗主题、`hover`/`active`/`disabled` 等非本篇点名的态；抽屉关闭动画中间帧；`--only` 之外的键盘路径（Esc 关闭、Tab 环）。
5. 实现腿的 `#/task/<id>`：实测**卡点击不写 hash**（开抽屉后地址为 `/board`）、**带 hash 载入不打开**（`data-state=closed`，地址保留 hash）。本卡两腿一律用**点击**驱动，未据此判红。

## 4. 差异登记（可见差，附读数；**不代替裁决**）

| # | 座位 | 原型 | 实现 | 读数（`seatCompare`） | 读法 |
|---|---|---|---|---|---|
| 1 | 抽屉头状态徽 `[data-detail-status-chip]` | **对所有卡恒为 `status.todo`** | 跟随该卡真实状态 | TD-126：P `data-status=in_review` / 文案 `To Do`；I `In Review`。PROJ-0007：P `backlog` / 文案 `To Do`；I `Backlog` | **原型缺陷**：`[data-detail-status-chip-label]` 静态带 `data-i18n="status.todo"`（`index.html:3433`），`openDetail()` 写完 `.text(statusLabel(...))` **之后**才 `translateTree($drawer)`（`app.js:1917`）⇒ 静态键把逐卡状态覆写回去 |
| 2 | 关闭按钮盒 `[data-detail-close]` | `32×32`、`border 1px`、`radius 6px`、`display:flex`、图标 `rgb(74,85,94)` | `16×16`、`border 0`、`radius 0`、`display:block`、图标 `rgb(126,138,145)` | `rect 32×32` vs `16×16` | **合同本身写的就是 `32×32`（`fidelity-r14.md`:113 关闭按钮盒 = 32×32 / `.td-iconbtn`）**；`154930-3` 的 R14-B08 判「匹配项·无需改」在 selector 级为真、**在盒径级不成立** —— 这正是本视觉腿要补的那一类差 |
| 3 | 焦点环 | `2px solid rgb(15,122,115)` + `box-shadow` | `1px auto rgb(0,95,204)`（UA 默认）+ `box-shadow:none` | `readings.focus` | 打开落焦肉眼可见（`d-focus-*-closeup.png`） |
| 4 | 版本座位 `[data-detail-version]` | `v3` | `3` | 文本 `v3` vs `3` | 原型静态卡属性写作 `data-version="v3"`、抽屉原样写出；live 真板实测亦渲染 `3` ⇒ **原型 mock 口径，不是实现缺陷** |
| 5 | 头像字母 `.td-avatar` | 两字（`LI` / `JO` / `TU`） | 一字（`L` / `J` / `T`） | `LI` vs `L` | `DetailDrawer.vue:61` `initial()` 取首字；原型静态模板写两字 |
| 6 | 会话行平台值 `[data-agent-platform-value]` | `--agent-platform claude`（`163.4×18`） | `claude`（`43.4×16`） | 文本 + 盒宽 | `BLOCKS.md`:806 写的是 `--agent-platform claude`；`blocks.contract.mjs` B16 的 manual note 说的是它「sets the `--agent-platform` 自定义属性」——**两处措辞不一致**，本条只登记可见差 |
| 7 | 抽屉头高 | `78.6` | `67`（Δ11.6） | `.td-drawer-head` | 主要由 #2 的关闭盒 32→16 贡献；identifier 行高 `18` vs `16` 亦有份 |
| 8 | 评论块高 | `221` | `338`（Δ117） | `[data-detail-comments]` | **不是缺控件**：两侧都有 `[data-comment-input]`；原型把 `form[data-comment-form]` 放在 `[data-detail-comments]` **之外**（`index.html`:3738），实现把 textarea **放在之内**（`DetailDrawer.vue`:654）—— 嵌套口径差 |
| 9 | 组合输入刻度 | `padding 0px 6px`、`radius 4px`、高 `24` | `padding 4px 8px`、`radius 6px`、高 `29.5` | `[data-detail-label-input]` | 与 #1/#2 同族：盒径刻度差 |
| 10 | 遮罩涂出色 | `rgba(15,20,23,0.32)` | `oklab(0.276439 … / 0.32)` | `readings.overlay` | **不是差**：同色、同 alpha，回灌契约 §5 B22 / `DF-1` 的 token 口径 |

## 5. 复现

```bash
node design/verify/T-20261014-150729/capture.mjs                 # 全量（a/b/e/c/d/live）
node design/verify/T-20261014-150729/capture.mjs --only a        # 只跑某一组（a·五宽度 / b·三态 / e·座位读数 / c·JS-off / d·交互 / live）
node design/verify/T-20261014-150729/capture.mjs --live-port 9527 --out <dir>
```

前置：宿主可解析 Playwright（本 run 用 `~/.nvm/.../node/v24.20.0/lib/node_modules/playwright`，Chromium `153.0.8010.12`），且 `--live-port` 上跑着服务 `web/dist` 的 `taskd`。产物 = `shots/*.png` + `evidence.json`；`pageErrors` 本 run 为 `[]`。

## 6. 目录约定（一处不符，已如实登记）

卡面 `git_rules` 写的写面是 `design/verify/<本卡>/**`，本目录按卡面落位。**仓库里既有的落位是另外两处**，均无 `design/verify`：

- `docs/verify/<卡>/**` —— harness + 证据 JSON（唯一先例 `docs/verify/T-20261013-154930-3/`）；
- `verification/<卡>/report.md` —— 文字报告。

`git log --all -- 'design/verify/**'` 为空，即本目录是该路径的首个落位。若家族以 `docs/verify/` 为准，本目录可整目录平移，无需改内容。
