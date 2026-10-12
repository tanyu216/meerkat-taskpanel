# DESIGN-activity — sidebar「Activity」优化设计（契约项 **B26**）

> 卡：`T-20261013-014701-6`（父 `T-20261013-014701-5`）· 上游 Terrence：「sidebar 的 Activity 啥也不是」
> 状态：**待 Terry 审核（门）** —— 审核通过才可派 E2 实现卡。
> 写面：本目录 `design/activity/**`。**不改** `design/DESIGN.md`、`design/BLOCKS.md`、
> `design/prototype/**`、`web/**`、`src/**`、`test/**`；**不写产品实现**。
> 本文件不含行号锚点：文档之间只以「`文件名` §小节名」互引。

---

## 0. 一句话

把侧栏的 Activity 从一个**形似目的地却无效**的按钮，做成项目的
**「发生了什么 / 什么在等我」账本**：项目级、只含有意义的事件、按天分组、突发折叠、
可筛选、可跳转、密度可扫、空态诚实。

交付物（全部在本目录）：

| 文件 | 作用 |
|---|---|
| `DESIGN-activity.md` | 本文件：诊断 + 设计 + Block 清单 + 机检断言 + §⑫ 判定 + 边界 |
| `prototype.html` | 静态原型（可离线打开；复用 `design/prototype/tw.css` 与 vendored jQuery，0 网络） |
| `activity.js` | 交互层：筛选 / 抽屉 / 未读 / 分页 / 中英切换 / 键盘 |
| `check-activity.mjs` | 机检：静态套件 + 渲染套件（`node design/activity/check-activity.mjs`） |
| `README.md` | 目录索引与状态 |
| `screenshots/` | 渲染证据（清单见 §渲染证据） |

---

## 1. 现状诊断

### 1.1 证据

| 图 | 说明 |
|---|---|
| `screenshots/01-current-board-1512.png` | 现状：看板 + 侧栏，`Activity` 是四项导航里的第三项 |
| `screenshots/02-current-activity-click-noop.png` | 现状：**点击 Activity 之后**——画面与上一张逐像素相同 |

两张图取自上游用 Playwright 采集的现状诊断（1512×900，驱动运行中的本地板），
本目录只做复制与归档，未重拍。

### 1.2 实测事实（机器可复核）

1. 侧栏 `nav` 四项：`board | list | activity | waiting`。
2. 点击 `[data-nav-item="activity"]` **前后**，`aria-current="page"` 恒为 `board`；
   文档里 `[data-activity-view]` 与 `[data-view="activity"]` 的计数都是 **0**。
3. 实现侧 `Sidebar.vue` 的可路由集合是 `["board", "list", "waiting"]`——`activity`
   被 `onNav` 直接忽略。
4. 原型侧 `design/BLOCKS.md` 的 **B03** 导航行只列到 `board | list | activity`，
   **没有任何区块**与之对应（对照 `waiting`：B03 的扩展段说明了它的来处）。

### 1.3 为何「啥也不是」

一句话：**它既没有信息，也不是一个诚实的「无内容」**。

- 它**形似目的地**（在导航里、有 glyph、有 hover/选中态、和另外三项并排），却**不是**目的地。
  点下去没有任何反馈，等于向使用者承诺了一个不存在的地方。
- 代价不是「少一个功能」，而是**侵蚀对整条导航的信任**：使用者学到「侧栏的项可能是死的」，
  这条经验会外溢到真正可用的 `board / list / waiting` 上。
- 它也不是**诚实的空**。诚实的长相是「这个项目还没有发生过什么」——一个说明了自己为何为空的区域。
  现在这个按钮连这个都不是：它不说明任何事。

### 1.4 直接把原始事件流倒出来会更糟

数据面是**存在**的：任务详情抽屉 B09 的 `[data-detail-activity]` 已有「actor + 句子 + 相对时间」的行，
服务端也有 `/activities` 路由与 SSE。所以「把原始流渲染成列表」是唾手可得的——
**但那正是要避免的**。原始事件里混着：

- 心跳（`heartbeat`）、在线/离线 presence；
- 会话起止（session start/stop）、SSE 重连；
- 逐字段自动保存产生的中间修订、无用户可见变化的 revision 递增。

这些东西**对机器有意义、对人没有**。把它们原样铺开，得到的是噪音墙：
信息量随行数增长而**下降**，因为要读的那几行被淹掉了。
⇒ 这个设计的第一性问题是**选择**，第二才是呈现。

---

## 2. 设计目标

> 让 Activity 成为项目的 **「发生了什么 / 什么在等我」账本**。

四个问题，一个视图回答：

| 问题 | 由谁回答 |
|---|---|
| 最近发生了什么？ | 天分组 + 行（§层级） |
| 谁做的、在哪张卡上？ | `actor` + 任务标识与标题（§层级） |
| 什么是我还不知道的？ | 未读分界 + 侧栏计数（§层级 · §交互） |
| 太长看不完怎么办？ | 突发折叠 + 筛选 + `Load older`（§聚合 · §交互） |

---

## 3. 信息选择（价值的地基）

### 3.1 判据

> 一个事件**当且仅当**它改变了「人类理解或推进这个项目所需要知道的事」才准入。

这条判据以**可枚举的 allow-list**（下表）落地，而不是形容词。原型里每个准入的变更都带
`data-activity-change="<kind>"`，便于逐条核对。

### 3.2 allow-list（准入）

| 事件 | 行钩子 `data-activity-event` | 文案键（动词） | 为什么准入 |
|---|---|---|---|
| 任务创建 | `created` | `activity.verb.created` | 项目的历史从这里开始 |
| 任务被认领 | `claimed` | `activity.verb.claimed` | 「谁在做」是推进项目要直到的事 |
| **状态迁移**（含 →`blocked` / →`in_review` / →`done` / →`canceled`） | `status` | `activity.verb.status` | 唯一直接回答「进展到哪了」的事件 |
| 评论新增（区分 human / agent 作者） | `comment` | `activity.verb.commented` | 决策与阻塞的载体 |
| 交付 / report 落地 | `delivery` | `activity.verb.delivered` | 「等的东西到了」——`waiting` 视图的另一面 |
| 附件新增 | `attachment` | `activity.verb.attached` | 证据落地 |
| 父任务 / 依赖关系变更 | `relation` | `activity.verb.linked` | 结构性变化，改变「能不能做」 |
| 标签增删 | `label` | `activity.verb.label` | 分类变化，影响检索 |
| 负责人变更 | `assignee` | `activity.verb.assignee` | 「换人了」是协作事实 |

### 3.3 排除（噪声，禁止出现）

| 事件 | 为何排除 |
|---|---|
| 心跳 `heartbeat` | 频率最高、信息量为零；是存活信号，不是项目事实 |
| 在线 / 离线 presence | 同上；侧栏 B03 的 Active agents 已经在回答这个问题 |
| 会话起止（session start / stop） | 机器生命周期，不是项目生命周期 |
| 逐字段自动保存的中间修订 | 同一次编辑的中间态；只保留**净变化** |
| SSE 重连 | 传输层事件 |
| 无用户可见变化的 revision 递增 | 计数器在动，东西没动 |
| **同人 create 之后紧接的 self-claim** | 瞬时自认领不改变任何外部事实；**并入上一行**（原型 `TD-134` 行即此例，展开可见 `Claim` 一行） |

### 3.4 事件筛选的取值映射（显式，不做隐含推断）

筛选栏的 `[data-activity-filter="event"]` 只有 spec 规定的四档取值。准入事件与它们的对应关系：

| `data-activity-group` | 含义 | `Status` | `Comments` | `Delivery` | `All events` |
|---|---|---|---|---|---|
| `status` | 状态迁移 | ● | | | ● |
| `comment` | 评论 | | ● | | ● |
| `delivery` | 交付报告 | | | ● | ● |
| `meta` | 创建 / 认领 / 附件 / 关系 / 标签 / 负责人 | | | | ● |

**这是有意的**：这三档回答的是三个具体问题——「什么改了状态」「说了什么」「交付了什么」。
其余准入事件是背景，在 `All events` 下完整出现。**没有被隐藏的事件**——`All events` 是默认档，
且筛选计数永远等于当前可见行数（§机检断言 · 5）。

---

## 4. 层级

三层信息密度，一层未读分界。

### L1 · 天分组 `[data-activity-day]`

- 根携带 `data-day="YYYY-MM-DD"`（ISO，机检据此断言**非递增**）。
- 标题 `Today` / `Yesterday` / 绝对日期，键为 `activity.day.today`、`activity.day.yesterday`；
  绝对日期**不进词典**——它没有句子要翻译，只有一个日期要本地化，由 JS 用
  `Intl.DateTimeFormat` 按 `lang` 生成（`Saturday, Oct 10` / `10月10日星期六`）。
  **静态文本必须等于脚本在 en 下会算出的那一个字符串**（机检 `S2.6`）——
  否则 JS 关闭的文档与 JS 打开的文档会对「今天是哪天」给出不同答案。
  这几天的标题带 `data-activity-day-kind="absolute"` 以区别于两个相对标题。
- 天标题 **sticky**（`position: sticky`），滚动时始终说明「你在哪一天」。

### L2 · 行 `[data-activity-row]`

| 片段 | 钩子 | 形态 |
|---|---|---|
| 左侧刻度 | `.td-activity-tick` | 2×14px 圆角竖条；**未读为 accent**，突发行更淡。它是扫描时的锚点 |
| 操作者 | `[data-activity-actor]` | 等宽；`data-assignee-kind="agent\|human"` 区分智能体与人类（沿用看板既有约定） |
| 句子 | `[data-activity-sentence]` | 动词短语，i18n 键，**只有动词**——宾语是下一格的链接 |
| 任务 | `[data-activity-task]` | **真实 `<a href="#/task/<id>">`**：`标识符`（等宽）+ `标题`（1 行 clamp） |
| 时间 | `[data-activity-at]` | 等宽；可见文本是相对时间，`datetime` 是 ISO，`title` 是绝对时间 |
| 打开 | `[data-activity-open]` | 图标按钮，可聚焦，`aria-label` = `Open <ID>`（键盘的入口，见 §交互） |

### L3 · 展开详情 `[data-activity-detail]`

**原生 `<details>`**，展开该行的 changes（`status: in_progress → in_review`、`+ design`、
`assignee: elon → jobs`、`+ collect-log.txt`）。用原生元素是**有意的**：

- JS 关闭时它**照常可用**——展开/收起由浏览器完成，不是由脚本完成；
- 它天然键盘可达，不需要补 `aria-expanded` / 焦点管理；
- 它不制造第二套状态。

**它的 `<summary>` 是 30px 行上的又一个条目，不是一个额外的行**：`<details>` 本身就在
`.td-activity-line` 里（行的最右端），所以**收起状态的行高恰好 30px**（§密度），
展开时变更列表以**贴着该行的浮层**出现（`position: absolute`，锚在行根上），
**不重排** feed——否则每展开一次，下面的行都要跳一下。

> 为什么不做成「展开就把下面的行推下去」：那要求 `<summary>` **单独**占一行（收起时它也占一行），
> 于是每行都多出一条 30px 的说明行，密度直接减半——正是 §密度 要避免的。
> 而「整个行就是 `<summary>`」又会让**点行 = 展开变更**，与 §交互 的「点行 = 打开抽屉」相撞。
> 浮层是同时满足「收起 30px」「原生 details」「两个操作面各自独立」的唯一解。

变更行的 `data-activity-change="<kind>"` 标出这条变更是什么；状态迁移的 `from`/`to` 各带一个
`.status.td-status-dot` 配 `[data-status]`，颜色从既有 `--st-*` 语义 token 取（§token）。

**一个实现注记**（Chromium 行为，非设计选择）：收起的 `<details>` 在 Chromium 里**仍保留其内容的
布局盒**，于是浮层即使「不可见」也会污染页面几何（横向溢出检查会因此变红）。
因此 scoped 样式里显式写了 `.td-activity-detail:not([open]) > .td-activity-changes { display: none }`——
把浮层真正移出布局，而不是依赖 UA 行为。

### 未读分界 `[data-activity-unread-divider]`

- 形态：accent-soft 底色的一整行，两侧 hairline，中间 `New since your last visit` + 计数。
- **位置**：在**包含边界的那一天分组内部，紧跟最后一条未读行之后**。
  这样「这条线以上的都是新的」成立，且这条线不会随着行被筛掉而与它描述的行分离。
- 未读语义**只存本地**（与 §21 主题/语言偏好一致）；本原型不引入任何网络读写。

---

## 5. 聚合（突发折叠）`[data-activity-burst]`

**规则**：同 `actor` + 同 `task` + 同事件族，在 **5 分钟窗口**内的连续事件 ⇒ 折叠成**一行**。

- 折叠行带 `[data-activity-burst-count]`（值 = 被折叠的条数，可见文本 `×N`）。
- 视觉更轻：左侧刻度降到 hairline 色，`×N` 承担重量——它是「这里发生过一串」的压缩标记，
  不是一条新事件。
- 展开（原生 `<details>`，同 L3）逐条列出，每条一个 `[data-activity-burst-item]`，带自己的
  `data-at`（机检据此断言窗口 ≤ 5 分钟）。
- 折叠行的 `data-at` 取窗口内**最新**的那一条。

**为什么是 5 分钟**：这是「一次操作轮次」的量级——智能体在一轮里连续改字段（负责人、标签、状态）
通常在几分钟内完成，而不同轮次之间隔得更久。窗口取小了压不住长尾，取大了会把两次独立操作
误并成一次。5 分钟是这条线。

**「同事件族」在这里是 field-edit 族**：折叠的是「同一个 actor 对同一张卡连续改字段」，
即 `assignee` / `label` / `priority` / `title` / 状态迁移。折叠行自己的 `data-event` 记作 `meta`
（字段编辑族），展开后逐条以 `data-activity-change="<字段>"` 说明改的是哪一个字段。
这正是 §信息选择 排除「逐字段自动保存的中间修订」时要保住的东西：**净变化保留、中间态丢弃**——
所以折叠的是**有意义的多次改动**，不是同一次改动的中间快照。

---

## 6. 交互

| 交互 | 钩子 | 行为 |
|---|---|---|
| 点行 | `[data-activity-line]` | **就地打开该任务详情抽屉**（与看板卡点击同一路径：`[data-detail-drawer][data-state="open"]` + `[data-detail-overlay]`） |
| 点任务标识 / 标题 | `[data-activity-task]` | 真实 `<a href="#/task/<id>">` 回看板并聚焦；**JS 关闭下仍是可点链接** |
| 展开变更 | `[data-activity-detail]` | 原生 `<details>`，JS 关闭下可用 |
| 筛选 | `[data-activity-filter="actor\|event\|task"]` | 三档独立；命中行数实时进 `[data-activity-filter-count]`（`aria-live="polite"`） |
| 重置 | `[data-activity-filter-reset]`、`[data-activity-empty-reset]` | 回到 `All` 三档 |
| 筛选态入 URL | `history.replaceState` | `#/activity?actor=agent&event=status&task=TD-128`——可分享、刷新不丢。**不污染** `#/task/<id>` |
| 一键已读 | `[data-activity-mark-read]` | 清 `[data-activity-unread]`，分界线与侧栏计数一起归零 |
| 侧栏计数 | `[data-nav-count="activity"]` | 复用 B03 的 `.badge.td-count`；**0 时 `hidden`**，与 `waiting` 同一规则 |
| 加载更早 | `[data-activity-more]` | 掀开下一页天分组；**不做无限滚动**——诚实、键盘可达、位置确定。**翻完即退场**，**项目级空时一开始就没有**（没有「更早」可加载，摆一个按钮就是死控件那套谎）；但**筛选空时它留着**——命中的行可能就在没掀开的那一页 |
| 键盘 · 行内 | `[data-activity-open]` | 真按钮：Enter/Space 打开抽屉，`aria-label` 说明打开哪张卡 |
| 键盘 · 移动 | `j` / `k` | 在可见行的 `[data-activity-open]` 之间上下移动焦点（已实现并断言） |
| 关闭抽屉 | `[data-detail-close]`、遮罩、`Esc` | 三种都关 |

**指针与键盘的分工**：行体是**指针操作面**（`cursor: pointer`），`[data-activity-open]`
是它的**键盘等价物**并承担可访问名。两者都放在行的第一层，**不嵌套**——
把整行做成 `role="button"` 会把任务链接变成嵌套可交互元素，那是可访问性缺陷，不是简化。

**未读数字只有一个**：侧栏计数、分界线、分界计数三者读**同一个数**（当前可见的未读行数），
因此三者不可能互相矛盾；筛选把新行藏起来时，三者一起退场——而不是留一个对着空气的数字。

---

## 7. 密度与响应式

- 行高 **30px**（**收起态**：连变更的 disclosure 也在这一行里，见 §层级 L3，所以它不额外占高）；
  正文 **12px**，meta（标识符 / 操作者 / 时间）**11px 等宽**，句子 12px。
- 行间 1px hairline（`--color-td-line`）；天标题是一道 sunken 底 + 底边 hairline。
- 900px 高约容 **25 行**（本原型一页 15 行）。
- **只有一档密度**，与 list 视图同度量（同一 30px 行、同一 12px meta 字号）；**不做密度开关**。

**≤760px 的一处让步（显式记录）**：六个字段排在一条 30px 线上约需 560px 轨道。
在 761px 以下，行改为**两行**（第一行 actor + 句子 + 时间，第二行任务标识 + 标题），
而不是把标题压到看不清。这是**布局**让步，不是**密度**档位——宽档的 30px 节奏不变。
理由：标题是行里信息量最大的字段，把它 truncate 成 3 个字符等于把信息选择（§信息选择）白做。

---

## 8. 空态与边界

| 情形 | 呈现 | 钩子 |
|---|---|---|
| **项目级空**（从未发生过任何可准入事件） | 「这个项目还没有发生过什么」+ 引导语 | `[data-activity-empty][data-activity-empty-kind="project"]` |
| **筛选空**（有事件，但没有符合筛选的） | 「没有动态符合这些筛选」+ **Reset** 内嵌按钮 | `[data-activity-empty][data-activity-empty-kind="filter"]` + `[data-activity-empty-reset]` |
| 错误态 | 复用 **B17** 既有约定（`[data-error-state]`、danger-soft 面、`Retry`）——本视图不新造错误态 | B17 |
| 超长任务标题 | **1 行 clamp**（`-webkit-line-clamp: 1`），**不是** `text-overflow: ellipsis`——与既有 C4 断言同一口径 | `.td-activity-task-title` |

两个空态**在静态文档里都是 `hidden`**：静态文档是「发生过事情」的那一读，
脚本才是把它们换上来的东西。这与 B05/B12 的二态口径一致。

**两者互斥**：项目级空只在**一条可准入事件都没有**时出现；筛选空只在**有事件、但当前命中为 0** 时出现。
命中 0 时可见行数 = 0（§机检断言 · 6）。

---

## 9. i18n 与 token

### 9.1 词典纪律

- 原型把词典放在 `prototype.html` 的 `<script type="application/json" data-activity-i18n>` 里。
  这样**静态可解析**：`check-activity.mjs` 用 `JSON.parse` 读它，以**集合相等**证明 en/zh 齐备
  （同一个证明手法 `design/BLOCKS.md` 对 `app.js` 的 `MESSAGES` 使用）。
- 文档里**所有** `data-i18n*` 钩子引用的键都在两侧存在；且 `data-i18n` 元素的**静态文本逐字等于
  en 词典的取值**——这条断言的意义是：**JS 关闭的文档与 JS 打开的文档是同一份文档**，
  而不是「英文在 HTML 里、中文在脚本里」的两份。
- **不把开发者注释渲染成 UI 文案**：`prototype.html` 与 `activity.js` 里的注释只解释为什么，
  从不带 `data-i18n`，也不出现在任何可见位置。
- `data-i18n-arg` 先按**键**解析、再按**字面量**：`activity.open` + `TD-134` 填出 `Open TD-134`，
  而 `column.add` + `status.todo` 这类组合会填出译文（沿用既有约定）。

### 9.2 en / zh 对照表

本原型词典共 **79 键**，其中 **50 键是新增**（余下 29 键与实现侧现有 `MESSAGES` 同名，直接复用）。
`app.title` 属复用键但取值不同：本文档是 Activity 文档，实现侧是 Board 文档，各自描述自己。

**新增键（50）**

| 键 | en | zh |
|---|---|---|
| `time.minutesAgo` | `%sm ago` | `%s 分钟前` |
| `activity.title` | Activity | 动态 |
| `activity.subtitle` | What happened, and what is waiting for you. | 发生了什么，以及什么在等你。 |
| `activity.navCount` | `%s unread` | `%s 条未读` |
| `activity.open` | `Open %s` | `打开 %s` |
| `activity.markRead` | Mark all read | 全部标为已读 |
| `activity.unread` | New since your last visit | 自上次查看后 |
| `activity.burstCount` | `%s changes folded` | `已折叠 %s 项变更` |
| `activity.more` | Load older | 加载更早 |
| `activity.day.today` | Today | 今天 |
| `activity.day.yesterday` | Yesterday | 昨天 |
| `activity.filter.actor.label` | Actor | 操作者 |
| `activity.filter.actor.all` | Anyone | 任何人 |
| `activity.filter.actor.human` | Humans | 人类 |
| `activity.filter.actor.agent` | Agents | 智能体 |
| `activity.filter.event.label` | Event | 事件 |
| `activity.filter.event.all` | All events | 全部事件 |
| `activity.filter.event.status` | Status | 状态 |
| `activity.filter.event.comment` | Comments | 评论 |
| `activity.filter.event.delivery` | Delivery | 交付 |
| `activity.filter.task.label` | Task | 任务 |
| `activity.filter.task.all` | All tasks | 全部任务 |
| `activity.filter.reset` | Reset | 重置 |
| `activity.filter.count` | `%s entries` | `%s 条动态` |
| `activity.verb.created` | created | 创建了 |
| `activity.verb.claimed` | claimed | 认领了 |
| `activity.verb.status` | moved | 移动到 |
| `activity.verb.commented` | commented on | 评论了 |
| `activity.verb.delivered` | reported on | 提交了交付报告 |
| `activity.verb.attached` | attached a file to | 添加了附件到 |
| `activity.verb.linked` | linked | 关联了 |
| `activity.verb.label` | labelled | 更新了标签 |
| `activity.verb.assignee` | reassigned | 改派了 |
| `activity.verb.updated` | updated | 更新了 |
| `activity.detail.changes` | Changes | 变更 |
| `activity.detail.status` | Status | 状态 |
| `activity.detail.labels` | Labels | 标签 |
| `activity.detail.assignee` | Assignee | 负责人 |
| `activity.detail.attachment` | Attachment | 附件 |
| `activity.detail.relation` | Relation | 关联 |
| `activity.detail.comment` | Comment | 评论 |
| `activity.detail.delivery` | Delivery | 交付 |
| `activity.detail.created` | Created | 创建 |
| `activity.detail.claimed` | Claim | 认领 |
| `activity.detail.reason` | Reason | 原因 |
| `activity.empty.project.title` | Nothing has happened yet | 这个项目还没有发生过什么 |
| `activity.empty.project.hint` | Create a task, or wait for an agent to claim one — the first entry appears here. | 新建一个任务，或等智能体认领——第一条动态会出现在这里。 |
| `activity.empty.filter.title` | No activity matches these filters | 没有动态符合这些筛选 |
| `activity.empty.filter.hint` | Widen the filters to see the full log. | 放宽筛选即可看到完整记录。 |
| `activity.empty.filter.reset` | Reset filters | 重置筛选 |

**复用键（29，取值取自实现侧现有 `MESSAGES`，不重写）**

`app.brand`、`app.tagline`、`topbar.view`、`topbar.view.board`、`topbar.view.list`、`topbar.live`、
`topbar.revision.title`、`topbar.newTask`、`nav.label`、`nav.board`、`nav.list`、`nav.activity`、
`nav.waiting`、`sidebar.projects`、`sidebar.agents`、`presence.running`、`presence.idle`、
`status.backlog`、`status.todo`、`status.in_progress`、`status.in_review`、`status.blocked`、
`status.done`、`status.canceled`、`drawer.close`、`drawer.activity`、`time.hoursAgo`、`time.daysAgo`，
以及 `app.title`（取值随文档而变）。

**给 E2 实现卡的提示**：`activity.created` / `activity.claimed` / `activity.commented` 三个键在实现侧
**已存在**，但句子形态不同（「created this task」vs 本设计的「created」+ 任务链接）。
本设计取新的 `activity.verb.*` 命名空间，**不覆盖**旧键——旧的仍服务 B09。

### 9.3 token 纪律

- **不新增色相**：状态迁移用既有 `--st-*` / `--color-td-st-*`；agent/human 用既有 `data-assignee-kind` 约定；
  未读用既有 `--color-td-accent` 与 `--color-td-accent-soft`；空态用既有 `.td-empty`。
- 新样式只有 `prototype.html` 内一段 **scoped `<style>`**，类名为 `.td-activity-*`。
- **机器可证明的 token 守恒**（§机检断言 · 10）：该 `<style>` 块
  （a）**不声明任何自定义属性**、（b）**不含任何颜色字面量**（`#hex` / `rgb()` / `hsl()` / `oklch()`）、
  （c）**读到的每一个 `var(--…)` 都已在 `design/prototype/tw.css` 里定义**。
  第三条是「不新增色相」的**强形式**：不只是「没写新颜色」，而是「没有引用一个不存在的 token」。

---

## 10. Block 清单（full block list）

契约项 **B26 · Activity view**（新），以及 **B03** 的一处扩展。
每块给 root selector、钩子与角色。

| 块 | Root | 钩子 / 角色 |
|---|---|---|
| **B26** | `[data-activity-view]` | 视图根（main 区当 `view=activity` 时显示） |
| B26.1 头部 + 筛选 | `[data-activity-filters]` | `[data-activity-filter="actor\|event\|task"]`、`[data-activity-filter-reset]`、`[data-activity-filter-count]`（`aria-live="polite"`）；头部另有 `[data-activity-title]` 与 `[data-activity-mark-read]` |
| B26.2 feed | `[data-activity-feed]` | → `[data-activity-day]` → `[data-activity-row]` → `[data-activity-actor]` / `[data-activity-sentence]` / `[data-activity-task]` / `[data-activity-at]` / `[data-activity-detail]` |
| B26.3 未读分界 | `[data-activity-unread-divider]` | + `[data-activity-unread-count]`（计数）、`[data-activity-mark-read]`（一键已读） |
| B26.4 突发折叠 | `[data-activity-burst]` | + `[data-activity-burst-count]`（`×N`）、`[data-activity-burst-item]`（展开后的逐条） |
| B26.5 空态 | `[data-activity-empty][data-activity-empty-kind="project\|filter"]` | 筛选空态内嵌 `[data-activity-empty-reset]` |
| B26.6 加载更早 | `[data-activity-more]` | `Load older`（翻开 `[data-activity-day][data-activity-page]` 的下一页） |
| **B03 扩展** | `[data-nav-item="activity"]` | 获得 `aria-current="page"` 语义 + `[data-nav-count="activity"]`（0 时 `hidden`） |

### 辅助钩子（实现细节，不属于 §4 的块契约）

| 钩子 | 用途 |
|---|---|
| `[data-activity-line]` | 行的指针操作面（点它打开抽屉） |
| `[data-activity-open]` | 行的键盘等价物与可访问名（`Open <ID>`） |
| `[data-activity-task-id]` / `[data-activity-task-title]` | 任务标识 / 标题（后者承载 1 行 clamp） |
| `data-activity-unread` | 行上的未读标记（属性存在 = 未读） |
| `data-activity-event` | 该行的事件族（§信息选择 的 allow-list 名） |
| `data-activity-group` | 该行在事件筛选里的桶（§事件筛选的取值映射） |
| `data-task` / `data-actor` / `data-assignee-kind` / `data-at` | 行的数据面：任务、操作者、种类、ISO 时刻 |
| `data-activity-day` / `data-day` / `data-activity-day-kind` | 天分组根、ISO 日期、相对/绝对标题 |
| `data-activity-page` | 第几页（`2` 起为 `Load older` 揭开的部分） |
| `data-activity-change` | 变更行的种类（`status` / `label` / `assignee` / …） |
| `[data-activity-burst-count-label]` | 突发 `<details>` 的 summary 文本 |
| `[data-activity-unread-count]` | 分界线上的未读计数（自带 `.td-activity-unread-count`，**不用** `.td-count`——后者在 ≤1023px 被移植样式表整体隐藏，那是给 64px rail 让位的规则，不该波及主区） |
| `[data-activity-i18n]` | 词典的静态载体（`<script type="application/json">`） |
| `[data-detail-drawer]` / `[data-detail-overlay]` / `[data-detail-close]` | B09 的既有根、遮罩与关闭钮——**本设计不改 B09**，只是复用它作为行的落点 |

---

## 11. 一致项（用于机检）

1. **导航项与视图互斥**：`[data-nav]` 内**恰好一个** `[data-nav-item][aria-current="page"]`，且是 `activity`。
   （注意范围：B03 侧栏的 **项目行** 也带 `aria-current="page"`（当前项目），
   所以「唯一」必须**限定在 `[data-nav]` 内**，不能对全文档断言。）
2. **天分组时间非递增**：`[data-activity-day]` 的 `data-day` 非递增。
3. **行时间非递增**：文档序内 `[data-activity-row]` 的 `data-at` 非递增，
   且每行的 `[data-activity-at]@datetime` 等于该行的 `data-at`。
4. **天分组覆盖所有可准入事件**：每个 `[data-activity-row]` 都在（且只在一个）`[data-activity-day]` 内。
5. **不新增色相**：scoped `<style>` 的 token 集合前后逐字节相等（§token 的三条强形式）。
6. **i18n en/zh parity**：79 键两侧集合相等；每个 `data-i18n*` 钩子两侧可解析。
7. **无行号锚点**：文档互引只写「文件名 §小节名」。
8. **JS 关闭下结构可见**：天分组 + 行 + 任务标识 + 时间 + `<details>` 全部在静态 HTML 里。

---

## 12. 机检断言（逐条可判）

`node design/activity/check-activity.mjs`（加 `--static-only` 跳过浏览器；加 `--shots` 同时产出截图）。
**零依赖**：只用 Node 标准库，渲染套件驱动宿主已装的 Playwright，经一个**回环**临时静态服务加载页面
（除 `127.0.0.1` 外无网络）。**Playwright 不可达时渲染套件判 FAIL 而不是 SKIP**——
一条没人能评估的断言不是通过的断言。

对应 spec §5 的九条，逐条给出「断言 ↔ selector ↔ 判定方式」：

| # | 断言 | 依据 selector | 判定方式 | check id |
|---|---|---|---|---|
| 1 | 视图根与 feed 存在 | `[data-activity-view]`、`[data-activity-feed]` | 静态：各出现恰好一次 | `S1.1` `S1.2` |
| 2 | 天分组 / 行时间非递增 | `[data-activity-day]@data-day`、`[data-activity-row]@data-at`、`[data-activity-at]@datetime` | 静态：逐对比较文档序 | `S2.2` `S2.4` `S2.5` |
| 3 | JS 关闭下静态文档已含 天分组 + 行 + 标识 + 时间 + `<details>` | 上列钩子 | 静态：计数相等且 `<template>` 计数为 0；**渲染**：`javaScriptEnabled:false` 上下文里逐项复核 | `S3.1`–`S3.7`、`R8.1`–`R8.5` |
| 4 | 导航互斥 + 计数 0 时 `hidden` | `[data-nav-item="activity"]`、`[data-nav-count="activity"]` | 静态：`[data-nav]` 内唯一 `aria-current`、`[hidden]⇒display:none` 规则存在、脚本写 `hidden`；**渲染**：`markAllRead()` 后断言 `pill.hidden === true` | `S4.1`–`S4.6`、`R3.1`–`R3.3` |
| 5 | 筛选变窄、计数 == 命中行数、reset 复原 | `[data-activity-filter]`、`[data-activity-filter-count]` | 静态：每行的 actor/task 都有对应 option、group 或为显式背景；**渲染**：`actor=agent` 后逐行复核 `data-assignee-kind`、计数 == 可见行数、hash 写入、reset 复原 | `S5.1`–`S5.4`、`R2.1`–`R2.10` |
| 6 | 空态：可准入 0 或命中 0 ⇒ `[data-activity-empty]`，且此时 0 行 | `[data-activity-empty]`、`[data-activity-empty-reset]` | 静态：两种 kind 齐备、静态均 `hidden`、脚本按 `admissible===0` / `shown===0` 分支；**渲染**：命中 0 时可见行 = 0 且**筛选**空态（非项目空态）可见 | `S6.1`–`S6.5`、`R2.5`–`R2.8` |
| 7 | 突发：5 分钟窗口 N 条 ⇒ 1 行且 count == N | `[data-activity-burst]`、`[data-activity-burst-count]`、`[data-activity-burst-item]@data-at` | 静态：`count` == 明细条数、可见文本 `×N`、窗口跨度 ≤ 5 分钟、actor/task 与折叠对象一致 | `S7.1`–`S7.6` |
| 8 | i18n：新键 en/zh 齐备 | `[data-activity-i18n]`、全部 `data-i18n*` | 静态：`JSON.parse` 后集合相等 + 逐钩子可解析 + **静态文本逐字等于 en 取值** | `S8.1`–`S8.8` |
| 9 | 五档无横向溢出 + `console errors == []` | 整个 `[data-activity-view]` 子树 | 渲染：1512 / 1240 / 980 / 760 / 430，逐元素 `getBoundingClientRect().right ≤ clientWidth+1`，且 `console`/`pageerror` 为 0 | `R7.*` |

**spec §5 之外的补充断言**（本设计的自证部分）：

| 断言 | check id |
|---|---|
| 令牌守恒三条（无新自定义属性、无颜色字面量、引用的 token 都已在 tw.css 定义） | `S9.1`–`S9.4` |
| 只引用冻结样式表与 vendored 脚本，无 CDN / 外链 / `//` | `S9.5` `S9.6` |
| 文档：无行号锚、Block 清单齐备、allow-list 落地、§⑫ 判定、边界声明 | `S10.1`–`S10.6` |
| 首屏基线：15 行、计数 15、pill 4、分界在线、无空态 | `R1.3`–`R1.10` |
| `Load older` 掀开下一页并在翻完后退场 | `R4.1` `R4.2` |
| 项目级空：只出项目空态（不出筛选空态），且不提供 `Load older` | `R6b.1` `R6b.2` |
| 绝对日期标题的静态文本 == 脚本在 en 下会算出的字符串 | `S2.6` |
| 突发的每一条明细都是字段编辑（族一致） | `S7.5` |
| 点行开抽屉、抽屉指名任务、关闭可用 | `R5.1`–`R5.4` |
| 切中文：`<html lang>`、文案、计数句、相对时间、绝对日期、专有名词 | `R6.1`–`R6.6` |

**当前结果：132 条断言，全部通过**（`node design/activity/check-activity.mjs`；80 条静态 + 52 条渲染）。

---

## 13. 渲染证据（`screenshots/`）

浅色为主；1 张深色、1 张中文、1 张 JS 关闭、1 张突发展开。

| 文件 | 内容 |
|---|---|
| `01-current-board-1512.png` | 现状：看板 + 侧栏（Activity 项可见）——取自上游诊断证据 |
| `02-current-activity-click-noop.png` | 现状：点 Activity 之后（与上图一致 ⇒ 死控件）——同上 |
| `10-activity-1512.png` | 新设计整屏（侧栏 Activity 激活 + 未读计数 4） |
| `11-activity-1240.png` / `12-activity-980.png` | 断点（980 处侧栏已收成 rail） |
| `13-activity-760.png` / `14-activity-430.png` | 窄档（行的两行布局；430 无横向溢出） |
| `20-activity-dark.png` | 深色主题（`?theme=dark`） |
| `21-activity-zh.png` | 中文（`?lang=zh`） |
| `22-activity-nojs.png` | **禁用 JS**：天分组 / 行 / 标识 / 时间 / `<details>` 全在 |
| `23-activity-empty.png` | 项目级空态 |
| `24-activity-filter-empty.png` | 筛选空态（Humans × Delivery ⇒ 0 命中） |
| `25-activity-burst.png` | 突发折叠展开（`jobs` 在 `TD-123` 上 08:41–08:44 的 4 条） |
| `26-activity-drawer.png` | 点行打开该任务详情抽屉（行 → B09 的落点） |

生成方式：`node design/activity/check-activity.mjs --shots`（同一脚本，避免多一个交付物）。
截图前统一注入「禁用 transition / animation」，避免抓到过渡中间帧。

---

## 14. 文档同步判定（§⑫）

| 文档 | 本轮是否同步 | 理由 |
|---|---|---|
| `design/DESIGN.md` | **不改（有意）** | 本卡产出的是**待 Terry 审核的设计提案**（设计先行门）。未批准的视图写进 DESIGN 会把提案写进冻结基线，并越过审核门 |
| `design/BLOCKS.md` | **不改（有意）** | 同上。B26 的条目在**审核通过后**由 E2 实现卡落进 BLOCKS |
| `design/prototype/**` | **不改（有意）** | `design/prototype/index.html` 是**实现的契约基线**，被 `test/web/blocks.contract.mjs` 逐块锁定；把未批准视图写进去会立刻与契约测试冲突。**同步落点 = Terry 通过后的 E2 实现卡** |
| `web/**` / `src/**` | **不改（红线）** | 本卡不写产品实现 |
| `test/**` | **不改（红线）** | 新增实现侧 i18n 键会动到 `test/web/i18n.catalogue.mjs`；本卡不碰 |
| `design/activity/**` | **新增** | 本卡的交付面 |

**结论：本卡不触发 `design/DESIGN.md` / `design/BLOCKS.md` / `design/prototype/**` 的同步。**
同步的落点在 **E2 实现卡**（Terry 通过后）：届时新增 `design/DESIGN.md` 一节、
`design/BLOCKS.md` 的 B26 条目、把 B26 落进原型基线并把断言交给 `test/web/blocks.contract.mjs`。
本节的**存在本身**即满足 §⑫ 的第一条（显式声明判定与理由）。

---

## 15. 交付边界（不写实现）

- 写面**只有** `design/activity/**`。
- **不碰**：`design/DESIGN.md`、`design/BLOCKS.md`、`design/prototype/**`、`web/**`、`src/**`、`test/**`。
- **不写产品实现**：本目录没有任何运行时源码；`prototype.html` 是**设计载体**，不是产品代码。
- 技术栈封闭：复用 `design/prototype/tw.css`（`<link>` 引用，**不重建**）与
  `design/prototype/vendor/` 下的 jQuery slim；**无 CDN、无外链、无网络请求**。
  唯一的网络面是机检自己起的**回环**静态服务（`127.0.0.1`），用于让浏览器能相对解析 `../prototype/`。
- 提交用显式路径：`git commit -- design/activity/...`；**不 push**。

---

## 16. 已知偏离与校准说明

| 项 | 说明 |
|---|---|
| `?theme=` / `?lang=` 查询开关 | 真板上这两个状态来自侧栏页脚（B03）；本原型没有页脚，因此**原型专用**的 URL 开关由截图脚本与手工阅读使用。JS 关闭时文档停留在 light / en 的默认档。这是**原型的入口**，不是产品设计的一部分 |
| 「固定当下」 | 原型把整个 feed 的相对时间锚在**一个固定时刻**（`2026-10-13T09:51:00Z`，比最新一条晚 9 分钟），而不是 `Date.now()`。否则每张截图、每次复核都会随当天时钟变化，设计件的证据就不再可复现 |
| `23-activity-empty` 的产生方式 | 没有「清空项目」的界面入口，所以项目级空态由截图脚本经 `window.tdActivity` 驱动产出（`24-activity-filter-empty` 则走**真实**筛选路径）。两者都记录在此，不假装是点出来的 |
| 抽屉内的 `[data-detail-activity]` | 本设计**不改 B09**。原型里的抽屉是**替身**：只有根、关闭钮与 Activity 段，段内由点击的那张卡的历史填充，好让「点行 → 抽屉」有个落点。完整 B09 在 `design/BLOCKS.md` |
| 侧栏被裁剪 | 原型的侧栏是 B03 的 **nav + Projects + Active agents**；Legend（B15）、States（B18）与页脚控件与本设计无关，未复制。这不改变 B03 的契约 |
| ≤760px 的两行行 | 见 §密度与响应式。它是布局让步，**不是**密度档位；宽档的 30px 节奏与「只有一档密度」的结论不变 |
| 变更详情是**浮层**而非把行推下去 | 见 §层级 L3 的推导：这是「收起态恰好 30px」「原生 `<details>`」「点行=抽屉 与 点 ▸=展开 互不干扰」三条同时成立的唯一解。浮层带边框与阴影，与身后的行明确分离 |
| 选择 30px 与「~25 行」 | 这是上游 spec 的**权威密度决策**，不是本 lane 的选择。第一版原型把 `<details>` 放在行下面，行实际高约 59px（900px 只能容 ~13 行），**违反了该决策**，因此改为现在的结构并复测 |

---

## 17. Open questions（不擅自改规格，列给 Terry）

1. **Activity 与 `waiting` 的入口关系**。本设计假设两者在侧栏**同级并列**
   （`waiting` 回答「什么在等我」，Activity 回答「发生了什么」——一句话：waiting 是收件箱，
   Activity 是账本）。若 Terry 认为应当合并成一个「动态」页的两段（未读在上、历史在下），
   则 B26 的根与 B03 的扩展都要重画，但 §信息选择 / §层级 / §聚合 三条不变。
2. **未读语义的持久化边界**。本设计按**本地**（localStorage 语义，与 §21 主题/语言偏好一致）。
   若改成服务端已读游标，则「未读」变成跨设备事实，`[data-nav-count="activity"]` 也从本地态
   变成服务端字段——这会影响 M6 的 API 面，需要单独裁定。
3. **计数的量词**。`[data-activity-filter-count]` 报的是**当前可见的行数**（突发折叠算 1 行），
   文案取 `%s entries`。若 Terry 希望它报**事件条数**（折叠行算 N），则数字与可见行数不再相等，
   §机检断言 · 5 的判据要相应改写。本设计取前者，因为「计数 == 你能数出来的行数」是一个
   使用者能自己验算的口径。
