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
    "connection.reconnecting": "Reconnecting…",
    "connection.resync": "Resync",
    "connection.resyncTitle": "Replay anything missed since the last event",
    "connection.title": "Connection",
    "connection.hint": "The board follows the live stream. Replay anything missed if a change did not arrive.",
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
    "error.attachTooLarge": "That file is larger than the board's 8 MiB limit.",
    "error.attachType": "That file type is not allowed on the board.",
    "attach.placeholder": "No attachments",
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
  },
  zh: {
    "connection.reconnecting": "正在重连…",
    "connection.resync": "补齐",
    "connection.resyncTitle": "重放自上次事件以来遗漏的更新",
    "connection.title": "连接",
    "connection.hint": "看板跟随实时事件流。若有更新未到达，可在此补齐。",
    "conflict.title": "此任务已在别处被修改",
    "conflict.hint": "你的修改未生效。请重新载入该任务以获取最新版本，然后再试一次。",
    "conflict.reload": "重新载入任务",
    "conflict.dismiss": "忽略",
    "toast.moveFailed": "无法移动 %s —— 该状态迁移不被允许",
    "toast.projectCreateFailed": "无法创建项目",
    "toast.projectPrefixUnusable": "无法创建项目 —— 标识前缀不含任何字母或数字",
    "toast.projectPrefixTaken": "无法创建项目 —— 已有项目用该前缀编号",
    "toast.reportRequired": "将 %s 移至待评审需要一份报告",
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
    "error.relationCycle": "该依赖会形成环 —— 卡片不能等待自己。",
    // 同上：`RELATION_CYCLE` 的第三种形状（祖先/后代），与「环 / 自环」那句分开。
    "error.relationAncestor": "该依赖会把祖先与后代连起来 —— 同一条父链上的卡片不能互相依赖。",
    "error.relationCrossProject": "依赖必须留在同一个项目内。",
    "error.attachTooLarge": "该文件超过看板 8 MiB 的上限。",
    "error.attachType": "看板不接受该文件类型。",
    "attach.placeholder": "无附件",
    "activity.filters.label": "动态筛选",
    "detail.saveError": "保存失败 —— 请重试。",
    "status.awaiting": "等你回复",
    "waiting.aria.badge": "等待你的回复",
    "waiting.reason.E1": "范围变更",
    "waiting.reason.E2": "验收基线变更",
    "waiting.reason.E3": "设计 / 美学方向",
    "waiting.reason.E4": "安全 / 数据安全",
    "waiting.reason.E5": "架构方向",
  },
};
