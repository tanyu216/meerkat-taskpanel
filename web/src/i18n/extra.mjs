/**
 * UI strings the prototype catalogue does not carry.
 *
 * `catalogue.mjs` is a byte-locked copy of the prototype's `MESSAGES` (220 keys,
 * en/zh in exact parity). It carries every string the prototype's own markup can
 * render; the prototype has no network, so it has no copy for a live-update
 * conflict, a reconnect or a resync. Those states are new in M6b, so their
 * strings live here, in the same two languages and with the same parity contract.
 * `test/web/i18n.parity.test.mjs` checks this table for the same en/zh key parity
 * the catalogue promises, and that nothing here shadows a catalogue key.
 *
 * One M1 key deliberately lives on the other side: `nav.waiting` names the 4th
 * nav item, which the prototype's own markup now authors (`design/prototype/
 * index.html`, the B03 extension approved with `count [data-nav-item] 3→4`), and
 * a prototype hook must resolve against the *catalogue* — see
 * `i18n.catalogue.test.mjs`, "covers every translated hook". So it is in
 * `catalogue.mjs`, not duplicated here. The rest of M1's `waiting.*` vocabulary
 * has no prototype consumer and stays below.
 */
export const EXTRA = {
  en: {
    // B19 · the access panel's persistent states. The prototype has no network,
    // so its catalogue stops at the demo strings; these are the save/load and
    // staged-rotation sentences the shipped panel needs.
    "access.token.placeholder": "A new token will be generated on save",
    "access.save": "Save",
    "access.saving": "Saving…",
    "access.saved": "Access settings saved",
    "access.loading": "Loading access settings…",
    "access.loadFailed": "Could not load the access settings.",
    "access.envManaged": "Managed by TASKD_ALLOW_CIDRS on the host — edit the service environment to change it.",
    "access.cidr.empty": "Every range needs a value before it can be saved.",
    "access.cidr.none": "No ranges — every remote address will be refused.",
    "conflict.title": "This task changed elsewhere",
    "conflict.hint": "Your change was not applied. Reload the task to see the current version, then try again.",
    "conflict.reload": "Reload task",
    "conflict.dismiss": "Dismiss",
    "toast.moveFailed": "Could not move %s — the transition is not allowed",
    // C-PREFIX-1 M7 — a refused create-project. The wire explains itself in
    // English and technical terms, so these three are the dialog's own words;
    // which one is shown follows the refusal's `details.field`/`conflictProjectId`
    // (see `CreateProjectModal.vue`). No catalogue key exists for any of them:
    // the prototype has no network, so it has no refused create at all.
    "toast.projectCreateFailed": "Could not create the project",
    "toast.projectPrefixUnusable": "Could not create the project — the identifier prefix has no letters or digits",
    "toast.projectPrefixTaken": "Could not create the project — another project already numbers its cards with that prefix",
    "toast.reportRequired": "Moving %s to In Review needs a report",
    "toast.reopened": "Reopened",
    "toast.moveConflict": "Conflict on %s — reload and retry",
    "toast.resynced": "Board resynced",
    "toast.relationNone": "No relations",
    // T-20261014-152924 ④ — the sentences a **failure code** resolves to.
    //
    // The board used to print the server's own `message`, which for a refused
    // write is the storage engine talking (`CHECK constraint failed: claimed_by
    // IS NULL OR status <> 'backlog'`, the string Terry saw on a drag). Every
    // refusal now renders `t(errorTextKey(err))` instead — a code is the only
    // half of an error a client may branch on, so it is the only half the UI
    // reads (`web/src/i18n/messages.mjs`, `web/src/stores/board.js`).
    //
    // `error.generic` is the **fallback for every code without a sentence**,
    // including the technical ones (`EXECUTION_STATE_CORRUPT`, `VALIDATION_FAILED`,
    // `SQLITE_UNAVAILABLE`) and any code a newer server invents. A refusal whose
    // code the board does not know must still say something readable, and it
    // must not be the wire's own words.
    "error.generic": "That action did not complete — retry, or contact an administrator.",
    "error.notFound": "%s is no longer on the board — reload it.",
    "error.busy": "The board is writing — try again in a moment.",
    "error.network": "The board did not respond. Check that taskd is running, then retry.",
    "error.notAssignee": "%s is assigned to somebody else.",
    "error.executionActive": "%s is being worked on by somebody else right now.",
    "error.claimOnBacklog": "%s is in Backlog, where nothing can be claimed.",
    "error.acceptanceForbidden": "%s cannot be closed by you under this board's acceptance policy.",
    "error.reviewPending": "%s still has an open review for this delivery round — finish or cancel it first.",
    "error.childrenOpen": "%s still has an unfinished child card — finish or cancel it first.",
    // T-20261014-212017-4 — the sentences the drawer's four new edit surfaces
    // need. Each names a refusal the reader can act on: a status that the state
    // machine will not take, a dependency that would close a loop, a file the
    // board will not store. Without them all four would fall back to
    // `error.generic`, which is readable but says nothing about the repair.
    "error.relationCycle": "That dependency would create a loop — a card cannot wait on itself.",
    // T-20261015-175921 ③ — `RELATION_CYCLE`'s **third** shape, an edge that
    // joins an ancestor and a descendant of the parent chain (`details.chain =
    // "ancestor"`, set by `domain/relation.mjs#assertBlockEdgeAllowed`). What:
    // one sentence that names both ends and the reason, in place of the loop's
    // own words. Why: that refusal is not a loop — nothing waits on itself and
    // no edge closes a cycle — so the shared sentence told the reader the wrong
    // thing about the graph they are looking at. Implementation-authored, like
    // every `error.*` key here: the prototype has no network, so it carries no
    // refusal vocabulary to contradict or to extend.
    "error.relationAncestor": "That dependency would join an ancestor and a descendant — cards on one parent chain cannot depend on each other.",
    "error.relationCrossProject": "Dependencies must stay inside one project.",
    "error.attachTooLarge": "That file is larger than the board's 64 MiB limit.",
    "error.attachType": "That file type is not allowed on the board.",
    "attach.placeholder": "No attachments",
    // The drawer's relative-time ladder reaches under a minute. The prototype's
    // own "just now" is `comment.now`, a comment-scoped key that only its demo
    // composer writes; the drawer's comments **and** activity trail share this
    // generic rung, so the word lives here rather than under a comment name.
    "time.justNow": "just now",
    // The drawer's inline preview: a previewable row's filename is a disclosure
    // button, and the region it opens is a named surface of its own.
    "attachment.preview": "Attachment preview",
    "attachment.previewOpen": "Preview",
    "attachment.previewClose": "Close preview",
    "attachment.previewLoading": "Loading preview…",
    "attachment.previewError": "This attachment could not be loaded.",
    // R13 修订（seg3 · 决定甲）— `assignee.clear` is gone from here too. R15 ②
    // authored it locally (the prototype had already withdrawn the key, while the
    // implementation still shipped the `✕`); with the `✕` withdrawn on **both**
    // sides there is no consumer left, so the implementation-authored string goes
    // with the control. The two byte-locked catalogue copies already ship one key
    // fewer, which is why nothing needs re-adding there.
    // R15 ① — the Activity bar's own accessible name. The prototype reuses
    // `filters.label` for both bars; the implementation card's ruling (Elon
    // 2026-10-13T10:45Z, ⑤) gives this one a **dedicated** word instead, so the
    // two named landmarks do not read as the same region to a screen reader.
    "activity.filters.label": "Activity filters",
    // R10 ② — the drawer's save failure. The prototype inlines this one string
    // (its catalogue is mirrored byte for byte by `test/web/i18n.catalogue.mjs`),
    // so it has no catalogue key to reuse: it lives here, like every other
    // implementation-authored state, and reaches the block through `data-i18n`.
    "detail.saveError": "Couldn’t save — try again.",
    // v4 — the drawer's six-tab shell. The prototype's tab labels are
    // literals, but the shipped board is localised, so the same six words live
    // here (the prototype has no copy for a live session trail or a reports
    // panel at all).
    "drawer.tabs.label": "Task detail sections",
    // The panel's accessible name while its card is being read. The real title is
    // not available yet, so the loading branch names the dialog by what it is
    // doing; the skeleton itself is decorative.
    "drawer.loading": "Loading card",
    "drawer.tab.details": "Details",
    "drawer.tab.activity": "Activity",
    "drawer.tab.reports": "Reports",
    "drawer.tab.acceptance": "Acceptance",
    "drawer.tab.leftovers": "Leftovers",
    "drawer.tab.sessions": "Sessions",
    "drawer.report.round": "round %s",
    "drawer.reports.empty": "No reports yet.",
    "drawer.commentHintAwaiting": "Submitting answers the question — the card is re-queued for the agent.",
    "drawer.acceptance.empty": "No acceptance criteria yet.",
    "drawer.leftovers.empty": "No leftovers — this round closed with nothing outstanding.",
    "drawer.leftovers.round": "round %s",
    "drawer.acceptance.met": "Met",
    "drawer.acceptance.partial": "Partial",
    "drawer.acceptance.not_met": "Not met",
    "drawer.acceptance.not_applicable": "Not applicable",
    "drawer.session.status.running": "Running",
    "drawer.session.status.closed": "Closed",
    "drawer.session.status.failed": "Failed",
    "drawer.session.owner": "owner",
    "drawer.session.seg": "seg",
    "drawer.session.phase": "phase",
    // Reopen is implementation-only — the prototype deliberately offers no
    // terminal action — so its copy lives here, not in the catalogue.
    "drawer.reopen": "Reopen",
    "drawer.reopenReason": "Why is this card being reopened? (at least 8 characters)",
    "drawer.reopenTooShort": "Say why — at least 8 characters.",
    "drawer.reopenConfirm": "Reopen card",
    "drawer.reopenCancel": "Cancel",
    // M1 · first-class `awaiting` and the 「等你回复」view (design §5). The
    // count key uses `%s` because the runtime fills positionally — `{n}` would
    // print itself (design §10-C2).
    //
    // `waiting.count` / `waiting.empty` (and the two `waiting.payload.*` keys,
    // whose only consumer was M1's inline payload) moved out in R12x
    // (`T-20261013-014701-7`): the shipped 「等你回复」view is now B27, whose copy
    // lives in the prototype catalogue, and `extra.mjs` may not shadow a
    // catalogue key. `status.awaiting`, the badge's own `waiting.aria.badge` and
    // the five `waiting.reason.E*` categories stay — the card still wears them.
    "status.awaiting": "Awaiting you",
    "waiting.aria.badge": "Awaiting your reply",
    "waiting.reason.E1": "Change of scope",
    "waiting.reason.E2": "Change of the acceptance baseline",
    "waiting.reason.E3": "Design / aesthetic direction",
    "waiting.reason.E4": "Security / data safety",
    "waiting.reason.E5": "Architecture direction",
    // The event vocabulary the prototype never had: archive, sessions, import
    // progress, and the generic fallback an unknown event reads as.
    "activity.archived": "archived this task",
    "activity.session": "recorded a session",
    "activity.progress": "recorded progress",
    "activity.other": "recorded an event",
    "activity.detail.archived": "Archived from",
    // 0038 — one acceptance vocabulary: a project default and a per-card
    // snapshot. None of these exist in the prototype.
    "createProject.field.acceptance": "Acceptance",
    "createProject.field.reviewer": "Reviewer",
    "createProject.field.reviewerHint": "Leave blank to use the deployment reviewer",
    "createProject.acceptance.auto": "Auto — the creator decides per card",
    "createProject.acceptance.off": "Off — no review",
    "createProject.acceptance.agent": "Agent — an agent reviews",
    "createProject.acceptance.human": "Human — a person closes",
    "createTask.field.acceptance": "Acceptance",
    "createTask.acceptance.off": "Off",
    "createTask.acceptance.agent": "Agent review",
    "createTask.acceptance.human": "Human",
    "createTask.reviewHint.off": "No review: the deliverer may close this card.",
    "createTask.reviewHint.agent": "An independent agent reviews before the card is closed.",
    "createTask.reviewHint.human": "A human closes this card.",
    "review.chip": "Needs review",
    "review.label": "Acceptance",
    "review.mode.off": "Off",
    "review.mode.agent": "Agent review",
    "review.mode.human": "Human",
    "error.reviewRequired": "%s needs an approved review before it can be done.",
  },
  zh: {
    "access.token.placeholder": "保存时将重新生成 access token",
    "access.save": "保存",
    "access.saving": "保存中…",
    "access.saved": "访问设置已保存",
    "access.loading": "正在读取访问设置…",
    "access.loadFailed": "无法读取访问设置。",
    "access.envManaged": "由主机上的 TASKD_ALLOW_CIDRS 管理；请修改服务环境变量。",
    "access.cidr.empty": "每个网段都需要填写内容后才能保存。",
    "access.cidr.none": "列表为空 —— 所有远程地址都将被拒绝。",
    "conflict.title": "此任务已在别处被修改",
    "conflict.hint": "你的修改未生效。请重新载入该任务以获取最新版本，然后再试一次。",
    "conflict.reload": "重新载入任务",
    "conflict.dismiss": "忽略",
    "toast.moveFailed": "无法移动 %s —— 该状态迁移不被允许",
    "toast.projectCreateFailed": "无法创建项目",
    "toast.projectPrefixUnusable": "无法创建项目 —— 标识前缀不含任何字母或数字",
    "toast.projectPrefixTaken": "无法创建项目 —— 已有项目用该前缀编号",
    "toast.reportRequired": "将 %s 移至待评审需要一份报告",
    "toast.reopened": "已重开",
    "toast.moveConflict": "%s 发生冲突 —— 请重新载入后重试",
    "toast.resynced": "看板已补齐",
    "toast.relationNone": "无关联",
    "error.generic": "操作未完成，请重试或联系管理员。",
    "error.notFound": "%s 已不在看板上 —— 请重新载入。",
    "error.busy": "看板正在写入 —— 请稍后重试。",
    "error.network": "看板没有响应。请确认 taskd 正在运行，然后重试。",
    "error.notAssignee": "%s 已指派给他人。",
    "error.executionActive": "%s 正由他人处理中。",
    "error.claimOnBacklog": "%s 位于 Backlog，其中的卡片不能认领。",
    "error.acceptanceForbidden": "按本看板的收口策略，%s 不能由你关闭。",
    "error.reviewPending": "%s 本轮仍有一张未解决的审核卡 —— 请先完成或取消它。",
    "error.childrenOpen": "%s 仍有未完成的子任务卡 —— 请先完成或取消它。",
    "error.relationCycle": "该依赖会形成环 —— 卡片不能等待自己。",
    // 同上：`RELATION_CYCLE` 的第三种形状（祖先/后代），与「环 / 自环」那句分开。
    "error.relationAncestor": "该依赖会把祖先与后代连起来 —— 同一条父链上的卡片不能互相依赖。",
    "error.relationCrossProject": "依赖必须留在同一个项目内。",
    "error.attachTooLarge": "该文件超过看板 64 MiB 的上限。",
    "error.attachType": "看板不接受该文件类型。",
    "attach.placeholder": "无附件",
    // 同上：抽屉的相对时间阶梯向下延伸到 1 分钟以内。
    "time.justNow": "刚刚",
    "attachment.preview": "附件预览",
    "attachment.previewOpen": "查看",
    "attachment.previewClose": "关闭预览",
    "attachment.previewLoading": "正在加载预览…",
    "attachment.previewError": "该附件无法加载。",
    "activity.filters.label": "动态筛选",
    "detail.saveError": "保存失败 —— 请重试。",
    // 同上：抽屉的六枚 tab 与报告/验收/会话轨迹文案。
    "drawer.tabs.label": "任务详情分区",
    "drawer.loading": "正在加载卡片",
    "drawer.tab.details": "详情",
    "drawer.tab.activity": "活动",
    "drawer.tab.reports": "报告",
    "drawer.tab.acceptance": "验收",
    "drawer.tab.leftovers": "遗留",
    "drawer.tab.sessions": "会话",
    "drawer.report.round": "第 %s 轮",
    "drawer.reports.empty": "暂无报告。",
    "drawer.commentHintAwaiting": "提交即作为答复 —— 卡片会重新排队交给 Agent。",
    "drawer.acceptance.empty": "暂无验收项。",
    "drawer.leftovers.empty": "本轮无遗留。",
    "drawer.leftovers.round": "第 %s 轮",
    "drawer.acceptance.met": "已满足",
    "drawer.acceptance.partial": "部分满足",
    "drawer.acceptance.not_met": "未满足",
    "drawer.acceptance.not_applicable": "不适用",
    "drawer.session.status.running": "运行中",
    "drawer.session.status.closed": "已关闭",
    "drawer.session.status.failed": "失败",
    "drawer.session.owner": "负责人",
    "drawer.session.seg": "分段",
    "drawer.session.phase": "阶段",
    "drawer.reopen": "重开",
    "drawer.reopenReason": "为什么要重开这张卡？（至少 8 个字符）",
    "drawer.reopenTooShort": "请说明原因 —— 至少 8 个字符。",
    "drawer.reopenConfirm": "重开卡片",
    "drawer.reopenCancel": "取消",
    "status.awaiting": "等你回复",
    "waiting.aria.badge": "等待你的回复",
    "waiting.reason.E1": "范围变更",
    "waiting.reason.E2": "验收基线变更",
    "waiting.reason.E3": "设计 / 美学方向",
    "waiting.reason.E4": "安全 / 数据安全",
    "waiting.reason.E5": "架构方向",
    "activity.archived": "归档了任务",
    "activity.session": "记录了会话",
    "activity.progress": "记录了进度",
    "activity.other": "记录了一次事件",
    "activity.detail.archived": "归档前状态",
    "createProject.field.acceptance": "验收",
    "createProject.field.reviewer": "审核人",
    "createProject.field.reviewerHint": "留空则使用部署级 reviewer",
    "createProject.acceptance.auto": "自动 —— 建卡时由创建者决定",
    "createProject.acceptance.off": "关闭 —— 无需评审",
    "createProject.acceptance.agent": "代理 —— 由代理评审",
    "createProject.acceptance.human": "人工 —— 由人关闭",
    "createTask.field.acceptance": "验收",
    "createTask.acceptance.off": "关闭",
    "createTask.acceptance.agent": "代理评审",
    "createTask.acceptance.human": "人工",
    "createTask.reviewHint.off": "无需评审：交付者可直接关闭。",
    "createTask.reviewHint.agent": "关闭前由独立代理评审。",
    "createTask.reviewHint.human": "此卡由人关闭。",
    "review.chip": "需审核",
    "review.label": "验收",
    "review.mode.off": "关闭",
    "review.mode.agent": "代理评审",
    "review.mode.human": "人工",
    "error.reviewRequired": "%s 需要先通过本轮审核才能完成。",
  },
};
