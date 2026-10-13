# `design/activity/` — the sidebar「Activity」proposal

**状态：待 Terry 审核（门）。** 审核通过前不派实现卡；本目录不进冻结基线。

上游：Terry 「sidebar 的 Activity 啥也不是」。本目录是这一轮的设计交付物：
**诊断 + 设计 + 可交互静态原型 + 机检**。设计与理由的全文在
[`DESIGN-activity.md`](DESIGN-activity.md)——本文件只是索引。

## 文件

| 文件 | 用途 |
|---|---|
| [`DESIGN-activity.md`](DESIGN-activity.md) | 设计文档：现状诊断、信息选择（allow-list）、层级、聚合、交互、密度、空态、i18n 对照表、Block 清单、一致项、机检断言、§⑫ 判定、交付边界、Open questions |
| `prototype.html` | 静态原型。可离线直接打开；**结构在 JS 关闭下完整可见**（天分组 / 行 / 任务标识 / 时间 / 原生 `<details>`） |
| `activity.js` | 交互层：筛选、抽屉、未读、分页、中英切换、`j`/`k`。只做增强，不做渲染 |
| `check-activity.mjs` | 机检：静态套件（解析 HTML/JS/文档）+ 渲染套件（Playwright 驱动，回环加载）。退出码即结论 |
| `screenshots/` | 渲染证据（清单见 `DESIGN-activity.md` §渲染证据） |

## 怎么跑

```bash
node design/activity/check-activity.mjs                # 静态 + 渲染，155 条断言
node design/activity/check-activity.mjs --static-only   # 不起浏览器
node design/activity/check-activity.mjs --shots         # 重新产出 screenshots/
```

`check-activity.mjs` 只用 Node 标准库；渲染套件驱动宿主的 Playwright，经一个 `127.0.0.1`
临时静态服务加载页面（除回环外无网络）。**Playwright 不可达时渲染套件判 FAIL 而非 SKIP**。

## 怎么读原型

直接打开 `prototype.html` 即可（`file://` 亦可，样式与脚本都是相对路径）。
两个**原型专用**的 URL 开关对应真板上侧栏页脚的两个状态：

- `prototype.html?theme=dark` — 深色；
- `prototype.html?lang=zh` — 中文。

其余交互都在页面上：点行开抽屉、点 `▸` 展开变更、三个下拉筛选、`Mark all read`、`Load older`。

## 边界

- 写面**只有**本目录。**不改** `design/DESIGN.md`、`design/BLOCKS.md`、`design/prototype/**`、
  `web/**`、`src/**`、`test/**`；**不写产品实现**。
- 技术栈封闭：复用 `design/prototype/tw.css`（`<link>` 引用，不重建）与
  `design/prototype/vendor/` 下的 jQuery slim。无 CDN、无外链、无网络请求。
- 同步落点在 **E2 实现卡**（Terry 通过后）：届时才写 `DESIGN.md` 一节、`BLOCKS.md` 的 B26 条目、
  原型基线与契约测试。判定与理由见 `DESIGN-activity.md` §文档同步判定（§⑫）。
