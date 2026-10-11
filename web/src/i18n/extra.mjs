/**
 * UI strings the prototype catalogue does not carry.
 *
 * `catalogue.mjs` is a byte-locked copy of the prototype's `MESSAGES` (214 keys,
 * en/zh in exact parity) and must not grow — the prototype has no network, so it
 * has no copy for a live-update conflict, a reconnect or a resync. Those states
 * are new in M6b, so their strings live here, in the same two languages and with
 * the same parity contract. `test/web/i18n.parity.test.mjs` checks this table
 * for the same en/zh key parity the catalogue promises.
 */
export const EXTRA = {
  en: {
    "connection.reconnecting": "Reconnecting…",
    "connection.resync": "Resync",
    "connection.resyncTitle": "Replay anything missed since the last event",
    "conflict.title": "This task changed elsewhere",
    "conflict.hint": "Your change was not applied. Reload the task to see the current version, then try again.",
    "conflict.reload": "Reload task",
    "conflict.dismiss": "Dismiss",
    "toast.moveFailed": "Could not move %s — the transition is not allowed",
    "toast.reportRequired": "Moving %s to In Review needs a report",
    "toast.moveConflict": "Conflict on %s — reload and retry",
    "toast.resynced": "Board resynced",
    "toast.relationNone": "No relations",
    "attach.placeholder": "No attachments",
    // M1 · first-class `awaiting` and the 「等你回复」view (design §5). The
    // count key uses `%s` because the runtime fills positionally — `{n}` would
    // print itself (design §10-C2).
    "status.awaiting": "Awaiting you",
    "nav.waiting": "Waiting on me",
    "waiting.count": "%s waiting on you",
    "waiting.empty": "Nothing is waiting on you",
    "waiting.payload.summary": "Waiting on your reply",
    "waiting.payload.expand": "Show the full question",
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
    "conflict.title": "此任务已在别处被修改",
    "conflict.hint": "你的修改未生效。请重新载入该任务以获取最新版本，然后再试一次。",
    "conflict.reload": "重新载入任务",
    "conflict.dismiss": "忽略",
    "toast.moveFailed": "无法移动 %s —— 该状态迁移不被允许",
    "toast.reportRequired": "将 %s 移至待评审需要一份报告",
    "toast.moveConflict": "%s 发生冲突 —— 请重新载入后重试",
    "toast.resynced": "看板已补齐",
    "toast.relationNone": "无关联",
    "attach.placeholder": "无附件",
    "status.awaiting": "等你回复",
    "nav.waiting": "等你回复",
    "waiting.count": "%s 件等你回复",
    "waiting.empty": "没有在等你回复的卡",
    "waiting.payload.summary": "等待你的回复",
    "waiting.payload.expand": "展开完整问题",
    "waiting.aria.badge": "等待你的回复",
    "waiting.reason.E1": "范围变更",
    "waiting.reason.E2": "验收基线变更",
    "waiting.reason.E3": "设计 / 美学方向",
    "waiting.reason.E4": "安全 / 数据安全",
    "waiting.reason.E5": "架构方向",
  },
};
