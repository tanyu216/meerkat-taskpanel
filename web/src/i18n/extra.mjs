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
    "toast.reportRequired": "Moving %s to In Review needs a report",
    "toast.moveConflict": "Conflict on %s — reload and retry",
    "toast.resynced": "Board resynced",
    "toast.relationNone": "No relations",
    "attach.placeholder": "No attachments",
    // R15 ② — `assignee.clear` names the bar's `✕`, and the prototype withdrew
    // *both* the control and its key (R13 修订 · 决定甲: the removal path is the
    // assignee dropdown's own `Assignee: All` row). The implementation still
    // ships the `x`, so its string is implementation-authored and lives here —
    // the two catalogue copies are byte-locked mirrors, and a key the prototype
    // does not carry cannot ride in them.
    "assignee.clear": "Remove assignee filter",
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
    "toast.reportRequired": "将 %s 移至待评审需要一份报告",
    "toast.moveConflict": "%s 发生冲突 —— 请重新载入后重试",
    "toast.resynced": "看板已补齐",
    "toast.relationNone": "无关联",
    "attach.placeholder": "无附件",
    "assignee.clear": "移除负责人筛选",
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
