# 独立验证报告 · T-20261014-154730-2

**Verdict: PASS**（①②③ 全部独立复现；④ 只读成立）

| 项 | 值 |
|---|---|
| 卡 | `T-20261014-154730-2` |
| 被验 SUT | lane worktree `…-wt-T-20261014-154730-2-seg1`，branch **`lane/T-20261014-154730-2-seg1`**，HEAD **`a2e644b`**（= `lane/T-20261014-154730-seg1` tip，未并 main） |
| 本报告所在 | 同 branch 工作树 `verification/T-20261014-154730-2/**`（commit 未能创建，见「落盘」） |
| 验证性质 | **只读**：被验仓 tracked 面无 M/A/D（`git status` 仅 `??` 本报告目录） |

被验构建身份：本 lane 独立 `vite build` 出 `index-D6-f3mPs.js`（sha256:16 `795880e663862716`）+ `index-OQOGJCz4.css`（`4630af1bdca1e1fd`），与 SUT `docs/verify/T-20261014-154730/README.md` 记录的 **after** 构建**逐字节相同**（=我在验的就是卡上那份实现）。

## 环境适配（先声明，非 SUT 的问题）

本 lane 的 macOS 沙箱**禁 `listen()`**（TCP 与 unix socket 皆 `EPERM`）且**禁 Chromium 的 Mach rendezvous**（裸 `chromium.launch` → `bootstrap_check_in … Permission denied`）。因此：

* 浏览器用 **`--single-process --no-zygote`** 启动（经 `pw-wrapper.mjs` 注入，未改 SUT 的 `probe-close-focus.mjs`）；
* 两侧载体全部走 **Playwright route interception**，零 socket：原型腿服务 `design/prototype/`，实现腿服务 `web/dist` + 门禁自己的 fixture；
* 门禁的 **API handler 与 fixture 取自 `web/scripts/dom-smoke.mjs` 本身**（`node:http.createServer` 经 shim 截获 handler、不 bind 端口）。

工具：node v24.20.0 · playwright 1.63.0 · chromium_headless_shell-1243。

## ① I-1 关闭按钮 computed 盒径 + head 高度 —— 真绿

命令（同函数读原型与实现）：
```
PLAYWRIGHT_ENTRY=/tmp/T-20261014-154730-2/pw-wrapper.mjs \
node /tmp/T-20261014-154730-2/probe.mjs --dist web/dist --width 1512 --out probe-1512.json
```
读数（`proto` / `impl` **逐值相等**）：

| 量 | 原型 | 实现 | 判 |
|---|---|---|---|
| `[data-detail-close]` rect / computed | `32×32` / `32px×32px` | `32×32` / `32px×32px` | ✅ |
| `display` / `align-items` / `justify-content` | `flex` / `center` / `center` | 同 | ✅ |
| `border` | `1px solid rgba(0,0,0,0)` | 同 | ✅ |
| `border-radius` | `6px` | `6px` | ✅ |
| `color` | `rgb(74, 85, 94)` | 同 | ✅ |
| 图标 `svg` | `16×16` | `16×16`（盒变大、图标不变） | ✅ |
| **`.td-drawer-head` 高** | **`78.59`** | **`78.59`** | ✅ |
| ├ 行（id/chip/close） | `32` | `32` | ✅ |
| └ `[data-detail-title]` | `16px`/`21.6px` | 同 | ✅ |

窄宽复核：`--width 760` 与 `--width 430` 下 `impl` 同为 `32×32` + `head 78.59`（`evidence/probe-760.json`、`probe-430.json`）。

## ② I-2 焦点环 computed —— 真绿

命令同上（同一探针的 focus 面，键盘模态 `Tab` 后读，断言前置 `matches(":focus-visible")`）。

| 量 | 原型 | 实现 | 判 |
|---|---|---|---|
| `outline` | `2px solid rgb(15, 122, 115)` | 同 | ✅（非 UA `1px auto rgb(0, 95, 204)`） |
| `outline-offset` | `2px` | `2px` | ✅ |
| `box-shadow` | `rgba(15, 122, 115, 0.35) 0 0 0 4px` | 同 | ✅ |
| `matches(":focus-visible")` | `true` | `true` | ✅ |

760/430 复合同值。

## ③ 门禁断言非恒真（负数自证）—— 真红

**为什么不是直接 `node web/scripts/dom-smoke.mjs`**：该 harness（a）自起 fixture server、（b）对 `/api/v1/tasks` 注册 `route.continue()`（需真 server）——本 lane 无 `listen` 跑不了整支。故我跑了它的 **R14 I-1/I-2 断言块本身**：从 `web/scripts/dom-smoke.mjs` **逐字节切出 L752–922**（171 行，slice sha256 `2abf710135f98d162d9b87a328a3a64b9cb2643c5b0c350ef4297d2fbcd2c6d4`），在同一份 `r14Check` 语义（有失败 ⇒ exit 1）下执行，fixture 数据与 API handler 取自该 harness 自己（`startServer`）。

负向在**临时整仓副本**（`/tmp/T-20261014-154730-2/mut-repo`，含 `.gitignore`）改 `web/src`、重建、再把该构建喂给门禁断言；**被验 lane 树零改动**。副本基线（未改）重建出与 lane **同字节** `OQOGJCz4/D6-f3mPs`，故变异对照有效。

| 变异 | 改法 | 门禁退出码 | 红条数 | 首条失败 |
|---|---|---|---|---|
| **基（副本未改）** | — | **0** | 0 | — |
| **M1** | I-1 回退旧四条 utility（`16×16` 无边无圆角） | **1** | **6** | `computes 16px×16px, expected 32px×32px`；head `64.59px` |
| **M2** | I-2 **只换色**（`--brand-accent`→`--brand-text-3`） | **1** | **1** | `2px solid rgb(126, 138, 145), expected … rgb(15, 122, 115)` |
| **M3** | I-2 环规则**整块删除** | **1** | **3** | `1px auto rgb(0, 95, 204), expected 2px solid rgb(15, 122, 115)`（=修前值） |
| **还原** | 撤回 M1–M3 后重建 | **0** | 0 | — |

还原后重建资产 hash 回到 `OQOGJCz4/D6-f3mPs`（与 lane 同字节），红→绿往返可复现。`console errors` / `page errors` 全程 `0`。

## ④ 五宽度无回归

命令：`node --import http-shim/register.mjs widths.mjs --static-root web/dist`（开抽屉后读）。

| viewport | 抽屉宽 | 文档横向溢出 | 抽屉内容横向溢出 |
|---|---|---|---|
| 1512 | **520** | 否（sw 1512 = cw 1512） | 否 |
| 1240 | **520** | 否（1240 = 1240） | 否 |
| 980 | **520** | 否（980 = 980） | 否 |
| 760 | **520** | 否（760 = 760） | 否 |
| 430 | **430**（`min(520px,100vw)`） | 否（430 = 430） | 否 |

抽屉宽 `520/520/520/520/430`、无横向溢出，与卡面一致。

## 登记（未验证 / 边界，如实记）

1. **整支门禁进程未跑**：`node web/scripts/dom-smoke.mjs` 需 `listen`，本 lane 沙箱禁止。我跑的是它的 **R14 I-1/I-2 断言块逐字节切片** + 它自己的 fixture/handler；同文件其余规则（R7/R9/其他 R14 条目）**本卡未验**。
2. **`verify:docker` / 容器腿未跑**（本 lane 无 docker/网络）。handoff 记的已知负载敏感红（`exporter OTLP push` / `coverage gate`）未复核。
3. **`design/fidelity-r14.md` 契约未动**（卡面 ④ 亦要求零改）。SUT 登记的「§4 R14-B08 判词已被本卡取代」我此处未改，供契约侧裁定。
4. 变异为**副本重建**（非 lane 树就地改），故「M1 换回 utility」依赖 tailwind 扫描面一致——副本含 `.gitignore`，基线重建与 lane **同字节**即为此作了对照。
5. 证据与可复执行脚本见 `evidence/`（`probe.mjs` / `gate.mjs` / `widths.mjs` / `pw-wrapper.mjs` / `http-shim-*.mjs`）。

## 落盘 / 集成

被验树 **零 tracked 改动**（`git status --porcelain` 仅 `?? verification/T-20261014-154730-2/`）。交付物：

| 路径 | 说明 |
|---|---|
| `verification/T-20261014-154730-2/report.md` | 本报告 |
| `verification/T-20261014-154730-2/evidence/**` | 读数 JSON + 可复执行脚本 |
| `/tmp/T-20261014-154730-2/T-20261014-154730-2.patch` | 上述 **18 个文件**的 `git format-patch`（由 `evidence/**` 现生成），可在 lane 分支 `git am` 落地 |

**commit 未能创建**：本 lane 沙箱把 worktree 的 gitdir（`…/meerkat-taskpanel/.git/worktrees/…-2-seg1/`）与对象库**设为只读**（`index.lock`/`objects` 写入均 `EPERM`），且审批策略为 never，无法升级。故分支停在 **`lane/T-20261014-154730-2-seg1` @ `a2e644b`**（未含本报告）。集成侧落盘命令：
```
cd <lane worktree>
git add verification/T-20261014-154730-2
git commit -m "chore(verify): T-20261014-154730-2 独立只读复核 …" -- verification/T-20261014-154730-2
```
