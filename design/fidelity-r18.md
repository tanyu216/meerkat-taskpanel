# 创建面收敛为一个描述框 · R18 — 投递 → supervisor → director 建卡

> 需求：谭玉 2026-11-11 会话原话——「web ui 的创建任务重构一下，用户只需要一个输入框来描述任务（给出三个示例从简单到复杂），提交时通过事件发布给 supervisor，由 supervisor 交由 director 去创建任务」。
> 分工：本轮写入面 `design/**` + `web/**` + `test/web/**` + 实现所需的 `src/**`/`test/**`；`CHANGELOG.md` 不在此处。
> 轮次：**R18**。R17 已由 `DESIGN.md` §33（空状态家族）占用，本文件不重号。
> 口径闭集（逐字使用）：`对齐` · `缺` · `简化` · `自创` · `口径` · `缺失口径`。定位一律「文件:选择器」或「文件:符号」，不写行号锚。

## 0. 结论摘要

- **① 创建面只保留一个描述框。** 旧表单的八个路由字段与验收模式全部退出创建面；用户写一段话、选一个项目、提交。项目下拉在输入框旁（需求方在 2026-11-11 问答中选定）。
- **② 提交不再建卡，而是投递一条 intake 请求。** 同一事务写 `intake_requests` 行 + `intake_requested` 活动行；subscriber 把它当 dispatch 唤醒 continue；poll 扫 pending、写 director 行；director lane 建卡后 `intake complete` 回填 refs。没有新增 LLM control turn，`src/orchestrator/**` 仍只说 `taskctl`。
- **③ 三个示例从简单到复杂，点击即填入**（可再编辑）。复杂示例是一句长句，因此示例按钮**换行**而不是把面板撑宽。
- **④ 原型仍是 oracle，且这一轮同步到了新面。** B10 重写；B22/B23/B25 缩到抽屉侧；B24 退役并保留编号；`create-dialog-kind`（C-KIND-1）与 `dialog-track-parity` 随主体退役。
- **⑤ 量出来的对齐。** 面板 `min(640px, 100vw − 32px)`、两侧 16px gutter、描述框 8rem 下限、三个示例、空文本时提交禁用——原型与实现在同一视口下同值（§3、§4）。`tw.css` 存在**先于本轮**的构建漂移（§6），本轮增量可归因。

## 1. 产品决策

创建是**人类向决策通道投递意图**，不是人类预先路由。旧表单要求提交者先决定 title、description、priority、assignee、status、reporter、labels、parent/depends 和验收模式，而 card 还不存在。R18 把这件事交回 board 的既有梯子：

```text
human description  →  supervisor (signal)  →  director lane (decision)  →  cards
```

- 请求是 board 状态（`intake_requests`，`pending | consumed | failed`），不是卡；事件只是信号。
- director 只读文件系统，用 `taskctl issue create` 建 1..N 张卡，每张一个可独立落地的交付、一个 routing-table 角色、以及 `meta.intake_request=<id>`。
- 描述没有可做的事 ⇒ `intake fail --reason`，人类能看到原因并重新提交；没有 reopen。
- 可见性：提交的 toast、终态 toast（前端按 id 回读请求）、`taskctl console` 的 pending 列表。看板不新增 intake 列或详情页。

## 2. 原型契约（B10/B22/B23/B24/B25）

| 座位 | 本轮取值 |
|---|---|
| 面板 | `.td-modal-box.td-intake-box` = `min(640px, calc(100vw − 32px))`；scrim 每侧 16px |
| 描述框 | `.td-textarea.td-intake-text`，`min-height: 8rem`，`resize: vertical`，焦点用设计自己的 3px halo |
| 示例 | `[data-create-task-example]` × 3，`data-example-kind=simple|medium|complex`；`.btn` 允许换行（`white-space: normal`、`max-width: 100%`、`height: auto`） |
| 项目 | `[data-create-task-project]` 原生 `<select>`，默认当前工作项目 |
| 提示 | `[data-create-task-hint]` 说明 supervisor → director 的路径 |
| 提交 | `[data-create-task-submit]`，空文本/无项目时 `disabled` |
| 退役 | 旧 Title/Description 编辑器、Priority、Assignee、Status、Reporter、Labels、Parent、Depends-on、验收模式控件；`[data-create-two-col]`、`[data-create-left]`、`[data-create-right]`、`.td-field-grow` 的创建侧规则一并退出 |

原型行为：示例 chip 填入文本框；提交显示 `toast.intakeAccepted` 并清空；`resetCreateTask()` 只重置文本框与项目。

## 3. 实现侧的实测（宿主 Chromium，1512×950 / 760×900，DSF 2）

`web/scripts/dom-smoke.mjs` 的 B10 腿，在本交付的构建上：

| 断言 | 实测 |
|---|---|
| 描述框是 `<textarea>` | ✔ |
| 项目是 `<select>` 且选项 > 0，开窗即有默认项目 | ✔ |
| 空文本时提交 `disabled` | ✔ |
| 三个示例 chip | 3 |
| 旧双栏与旧 title 字段不存在 | 0 / 0 |
| 点「中等」示例后文本框非空、提交解禁 | ✔ |
| 提交体 = `{project_id, text, idem}`，文本与框内一致、idem 非空 | ✔ |
| 成功后弹窗关闭、出现「Received …」toast | ✔ |
| 重新打开时文本框为空、提交禁用 | ✔ |

同日同一构建的其余浏览器面：`dom-smoke` **561 条规则 0 失败**、console/page error 0、五个视口无横向溢出；`combo-menu-geometry` **23/23**（create 采样随第二个 surface 退役，抽屉样本原样通过）；`test/web/**` **510 通过 / 0 失败**（含 bundle 字面量与契约快照）。

## 4. 退出与退役（逐条）

| 主体 | 处置 | 证据 |
|---|---|---|
| B24 Parent / Depends-on（创建侧） | 退役，保留 B24 编号与 `absent` 断言 | `test/web/blocks.contract.mjs` B24；dom-smoke 561 规则中的 absent 全绿 |
| B23 编辑器（创建侧） | 退出；B23 改为 drawer 作用域，`when: "drawer editing"` | dom-smoke 打开抽屉 → 点 `[data-detail-description-edit]` → 量 7 条计算样式 → 取消并还焦点 |
| B22 Assignee/Reporter（创建侧） | 退出；B22 只保留抽屉侧（reporter 是只读值） | bundle 字面量扫描只要求仍存在的 hook |
| B25 Labels（创建侧） | 退出；B25 只保留 `[data-detail-labels]` | 同上 |
| `test/web/create-dialog-kind.test.mjs`（C-KIND-1） | 删除：创建面不再建卡，"对话框不得有 kind" 的载体消失 | 文件不存在 |
| `web/scripts/dialog-track-parity.mjs` | 删除：无第二条 track 可比 | `test/web/blocks.dom.test.mjs` 只剩两条腿 |
| 截图 | `10`、`26` 重拍；12 张 create-dialog 帧退役；抽屉侧 `43`、`45`–`48` 保留 | §5 |

## 5. 截图

沿用既有口径：device-scale-factor 2，无 toast，过渡关闭，`1512×950` 与 `760×900`，按**面板元素**裁切。

| 帧 | 处置 | 尺寸（像素） |
|---|---|---|
| `10-create-task-modal.png` | 重拍：composer，描述框聚焦（设计焦点环） | 1280×936（640×468 @2×） |
| `26-create-narrow-760.png` | 重拍：760 宽下仍是 640 面板 | 1280×920（640×460 @2×） |
| `23/24/25/27/28/29/30/39/40/41/42/44-*` | 退役（拍摄对象已从产品消失） | — |
| `43-detail-labels`、`45`–`48` | 保留 | — |

## 6. `tw.css` 的构建漂移（先于本轮）

按 `design/prototype/README.md` 的构建法（Tailwind v4.3.3 + daisyUI 5.7.47，外部工具链经临时 `node_modules` 软链）重建：

- 用 **HEAD 的** `index.html`/`app.js`/`src/input.css` 重建 ⇒ 与已提交 `tw.css` 相差 **147 行**（`.link`/`.ring`/`.sr-only` 由源码中的词触发、部分注释被剥离）。这说明已提交产物在 R15/R16 之后**没有重建**，不是本轮引入。
- 本轮的增量 = **14 行**：`.td-modal-box.td-intake-box`、`.td-intake-text`、`.td-intake-examples` 及其 `.btn` 换行规则。
- 一个过程中发现的层序事实：原型把组件类放在 `@layer utilities`（`src/input.css` 的注释已写明原因），本轮追加块最初写成 `@layer components` 因而输给 `.td-modal-box`；改为 `@layer utilities` 后量到 640px。

## 7. 未跑 / 边界

- **容器门禁**按仓库约定不进入编辑循环：`npm run verify:docker` 是 pre-push 门，本轮交付时由 pre-push/CI 跑。本文只记录宿主静态 + 浏览器腿。
- **端到端（真实 board + live pool）** 需要 `taskd` 与常驻池同机运行；本 lane 以单测 + 伪造 CLI 覆盖了 enqueue/settle 的形状，真实 director turn 的联调留给合入后的整体验收（计划 §8.5 的步骤）。
- 截图集的其余帧仍带 R9–R11 一轮遗留的陈旧（README 的 recapture 记录已说明），本轮只动了与创建面相关的帧。
- 本轮不新增看板列、详情页或消息通道；director 的"不可执行"是 `fail --reason`，不是对话式澄清。
