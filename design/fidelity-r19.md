# 创建面示例：三行阶梯，覆盖路由词汇 · R19

> 需求：谭玉 2026-11-11 会话原话——「创建任务的示例需要优化：1、三个示例排版应当放在独立的三行；2、示例覆盖的任务卡场景代表性不足，需要优化，比如：指派给谁来做，放到最高优先级，放在什么任务完成后来做，需要 turing 介入开发后的测试工作」。
> 分工：本轮写入面 `design/**` + `web/**` + `test/web/**`；`CHANGELOG.md` 不在此处。
> 轮次：**R19**。R18 已由 `DESIGN.md` §34（创建面收敛为一个描述框）占用。
> 口径闭集（逐字使用）：`对齐` · `缺` · `简化` · `自创` · `口径` · `缺失口径`。定位一律「文件:选择器」或「文件:符号」，不写行号锚。

## 0. 结论摘要

- **① 三个示例各占一行。** `.td-intake-examples` 从 `flex-wrap` 改为 `flex-direction: column`；每个 `.btn` 取整行（`width: 100%`、`justify-content: flex-start`），文字在行内换行，面板不被撑宽。
- **② 示例成为一条路由词汇的阶梯。** 简单例给出**指派人 + 最高优先级**；中等例给出**依赖 + 指派人**；复杂例给出**开发 → Turing 测试**的交接。三句合起来示范「描述里可以带哪些事实」，因为卡的字段最终由 director 决定。
- **③ 面没有新增 hook、没有新增 i18n key。** `[data-create-task-example]` 仍是 3 个，`data-example-kind` 仍是 `simple|medium|complex`；三份 catalogue 只改值。
- **④ 契约与浏览器腿都量到「一行一个」。** B10 新增 computed 规则（`flexDirection: column`）；dom-smoke 的 B10 腿量三行 `top` 互异、每行宽度 = 容器宽度（±2px）。
- **⑤ 重拍两帧。** `10-create-task-modal.png` = 1280×996，`26-create-narrow-760.png` = 1280×980（面板 640×498 / 640×490，DSF 2）。

## 1. 产品决策

创建面只收一段描述，字段由 director 拆卡时决定。示例因此不是装饰，而是**人类可模仿的输入规格**：它要让人看到，描述里可以写清「谁做、多急、等什么、谁接着测」。旧三句只覆盖「修什么、加什么、改什么」，没有一条带路由信息，代表性不足。

| 阶梯 | en | zh | 示范的路由事实 |
|---|---|---|---|
| simple | Fix the blank board after sign-in — assign it to Linus at the highest priority. | 修复登录后看板偶发空白的问题——交给 Linus，设为最高优先级。 | 指派人 + 优先级 |
| medium | After the filter-bar refactor lands, add label filtering — route it to the Worker. | 等筛选栏重构完成后，给看板加标签筛选——交给 Worker。 | 依赖 + 指派人 |
| complex | Ship the intake composer: Linus implements it, then Turing writes and runs the regression tests once the implementation is delivered. | 实现需求投递框：由 Linus 开发，交付后由 Turing 编写并执行回归测试。 | 开发 → 测试的角色交接 + 依赖 |

三句都仍是**一段自然语言**，不是表单；点选后照旧填入文本框，可继续编辑。卡的语言、项目归属和验收仍由 director 从描述与项目上下文决定，示例不新增字段。

## 2. 原型契约（B10）

| 座位 | 本轮取值 |
|---|---|
| 容器 | `.td-intake-examples` = `display: flex; flex-direction: column; gap: 8px` |
| 每一行 | `.td-intake-examples .btn` = `width: 100%; max-width: 100%; height: auto; justify-content: flex-start; white-space: normal; text-align: left` |
| 顺序 | 文档顺序即 simple → medium → complex；`data-example-kind` 不变 |
| hook | `[data-create-task-example]` × 3；`[data-create-task-examples]` 仍包住三行 |
| 实现镜像 | `[data-create-task-examples]` 移到按钮容器上（原型与实现在同一 hook 上量 `flexDirection`） |

**`口径`：** 原型与实现都在 `[data-create-task-examples]` 上量 `flex-direction: column`；实现按钮带 `w-full`，原型由 `.td-intake-examples .btn` 的 `width: 100%` 承担，两侧等价。

## 3. 实测（宿主 Chromium，DSF 2）

| 断言 | 实测 |
|---|---|
| 容器的 `flex-direction` | `column`（契约 computed 规则） |
| 三行的 `top` | 3 个互异值（浏览器腿） |
| 每行宽度 vs 容器 | 每行 = 容器宽度（±2px） |
| 1512×950 面板 | 640 × 498 |
| 760×900 面板 | 640 × 490 |
| `blocks.dom` | 2/2 通过；562 条规则 0 失败；console/page error 0 |
| i18n / 契约 / parity | 65 通过 / 0 失败 |

## 4. 与既有面的关系

- **`对齐`：** B10 的根、面板、表单、关闭钩子、描述框、项目下拉、hint、submit 全部未动；只重排示例容器并换文案。
- **`缺`：** 没有新增卡字段或 intake 字段；示例只是文本。
- **`自创`：** 无。三句都使用既有角色名（Linus / Worker / Turing），不引入新词。
- **`简化`：** 示例从「chip 云」简化为「三行阶梯」，阅读顺序即复杂度顺序。
- **退役：** 无。B10 的 hook 面与 i18n key 面保持原数。

## 5. 截图

沿用既有口径：device-scale-factor 2，无 toast，过渡关闭，按**面板元素**裁切。

| 帧 | 处置 | 尺寸（像素） |
|---|---|---|
| `10-create-task-modal.png` | 重拍：三行示例，1512×950 | 1280×996（640×498 @2×） |
| `26-create-narrow-760.png` | 重拍：760 宽下仍是 640 面板，三行示例 | 1280×980（640×490 @2×） |

## 6. `tw.css`

按 `design/prototype/README.md` 的构建法重建：本轮增量 **+57 bytes**，diff 只有 `.td-intake-examples` 的 `flex-wrap` → `flex-direction: column`，以及 `.btn` 的 `width: 100%`、`justify-content: flex-start` 两行；无新增类选择器、无 `:root` token 变化。

## 7. 未跑 / 边界

- **容器门禁**按仓库约定不进入编辑循环：`npm run verify:docker` 是 pre-push 门，本轮交付时由 pre-push/CI 跑。
- 本轮不改 B10 之外的面，也不改 intake 的域、HTTP 或 supervisor 路径。
- 示例是 UI 文案；它们不改变 director 的拆卡规则，只改变人类可模仿的输入样例。
