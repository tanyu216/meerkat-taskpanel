# 抽屉附件在线预览口径契约（可预览集合 / 字节通路 / 原型偏离） · C-ATTACH-PREVIEW-1

> **口径一句话**：抽屉里能否预览，由**已存储的 `content_type`** 决定；预览字节经 **blob URL** 进入页面，下载端点**恒为** `content-disposition: attachment`，board 的 origin 永远不渲染用户内容。
>
> 事实源（实读）：`src/shared/constants.mjs`（白名单与上限）、`src/shared/attachments.mjs`（类型归一与扩展名映射）、`src/server/routes/attachments.mjs`（字节端点）、`web/src/lib/attachments.js`（`previewKind`）、`web/src/components/detail/DetailDrawer.vue`（预览弹窗）、`test/contract/**` / `test/server/**` / `test/web/**` / `test/cli/**` 与 `web/scripts/dom-smoke.mjs`（判据）。
> **本文件是新增文件**：不改 `design/prototype/**` 一行；不改 `design/DESIGN.md` / `design/BLOCKS.md` 的既有规则，只在 §B09 尾注补一段实现侧钩子的登记。

## 0. 结论摘要

- **① 可预览集合 = 四族，由 `content_type` 派生。** `image/{png,jpeg,gif,webp,bmp}` → 图片；`video/{mp4,webm}` → 视频；`application/pdf` → PDF；`text/markdown` → Markdown。其余类型（含 `content_type` 为 `null` 的行）**不可预览**，仍只有下载/移除。
- **② 判定不看扩展名，也不看 `attachments.kind`。** `kind IN ('inline','attachment')` 自建表起就没有第二个写入方；可预览是**类型的能力**，不是**行的属性**。本契约不引入 `kind='inline'` 的写入面。
- **③ 字节通路 = fetch → Blob → `URL.createObjectURL`。** `GET /api/v1/attachments/:id/content` 的三个 header 不变：`content-disposition: attachment`、`x-content-type-options: nosniff`、`cache-control: no-store`。不新增 `inline` 分支、不新增 `/preview` 路由、不加 `Range`（blob 全量缓冲且可 seek）。
- **④ 白名单 = 封闭集。** `text/html` 与 `image/svg+xml` 仍然**不可存储**；视频只收 `video/mp4` 与 `video/webm`（`video/quicktime`、`video/ogg` 不收：能传不能播比不支持更糟）。
- **⑤ 单文件上限 = 64 MiB。** 该值在 `ERROR_CODES.ATTACHMENT_TOO_LARGE` 与抽屉两种语言的 `error.attachTooLarge` 里有手抄回声，`test/contract/attachment-policy.test.mjs` 把它们钉到常量上。
- **⑥ 预览是覆盖整个视口的弹窗，同一时刻只有一个；✕ 与 Escape 都只关闭弹窗、不关闭抽屉，焦点归还给触发它的行按钮。** 关闭抽屉 / 换卡 / 行消失 / 组件卸载都会 revoke blob URL。
- **⑦ 弹窗必须 Teleport 到 `<body>`。** `.td-drawer` 带 `transform`，会成为 `position: fixed` 子元素的包含块；留在抽屉里的"全屏"层只会覆盖抽屉自己。

## 1. 原型偏离（本契约存在的理由）

原型 `design/prototype/index.html` 的附件行只有**下载**与**移除**两个按钮（`[data-attachment-download]` / `[data-attachment-remove]`），**没有**「打开/预览」的席位。本轮只改实现，并把新增钩子登记为 **implementation-only**：

| 钩子 | 席位 |
|---|---|
| `[data-attachment-open]` | 可预览行的文件名（`<button>`，带 `aria-haspopup="dialog"` / `aria-controls`） |
| `[data-attachment-preview]` | 全屏弹窗（`role="dialog"`、`aria-modal="true"`），`data-attachment-preview-kind="image\|video\|pdf\|markdown"` |
| `[data-attachment-preview-close]` | 弹窗头部的 ✕ |
| `[data-attachment-preview-loading]` | 弹窗的加载句 |
| `[data-attachment-preview-error]` | 弹窗的失败句（字节 404 时） |

登记位置：`test/web/blocks.contract.mjs` 的 `AUXILIARY_HOOKS`、`design/BLOCKS.md` §B09 尾注、本文件。**原型不回填**（契约不是从实现反写原型的）。下一次设计轮需要补这一笔；在补上之前，原型与实现在这一处**有意不一致**。

## 2. 可核判据

- 纯函数：`node --test test/web/attachments.test.mjs`（四族命中、大小写/参数折叠、其余为 `null`）。
- 策略：`node --test test/contract/attachment-policy.test.mjs`（视频两容器在册、两处页面类型不在册、扩展名映射、64 MiB、三处文案与常量同值）。
- HTTP：`node --test test/server/attachments.test.mjs`（视频行可建、字节端点仍答 `attachment` + `nosniff` + `no-store`）。
- 浏览器：`node web/scripts/dom-smoke.mjs`（四族各开一次、源是 `blob:`、弹窗覆盖整个视口且不在抽屉子树内、焦点落在 ✕ 上、✕ 与 Escape 都只关闭弹窗并把焦点还给行按钮、zip 行没有 `[data-attachment-open]`）。

## 3. 明确不做

- 缩略图 / 首帧；评论内附件预览；md 内相对路径图片解析到同卡附件；`Range` 与边下边播；按类型分档的大小上限；`kind='inline'`；`txt`/`csv`/`json` 的文本预览；在 done/canceled 卡上放开下载或预览。
