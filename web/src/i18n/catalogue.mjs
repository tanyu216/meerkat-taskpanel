/**
 * The prototype board catalogue, extracted verbatim as pure data.
 *
 * Source of truth: `prototype/app.js`, the `MESSAGES` object literal (lines
 * 35-499 of that file: `en` at 36, `zh` at 271). Keys and strings below are
 * copied byte-for-byte — do not "improve" the copy, re-wrap the strings or
 * reorder the keys; the whole point of this module is that it is the *same*
 * catalogue the prototype ships.
 *
 * ---------------------------------------------------------------------------
 * Measured counts (host-static, this extraction)
 * ---------------------------------------------------------------------------
 *   catalogue keys      en 214 / zh 214, exact 1:1 mirror (identical key sets,
 *                       identical key order, no duplicates, no empty values)
 *   `%s` placeholders  204 keys carry none, 8 carry one, 2 carry two — and the
 *                       histogram is identical for en and zh, key for key
 *   data-i18n* hooks    606 in `prototype/index.html`:
 *                         389 `data-i18n=`
 *                         144 `data-i18n-arg=`
 *                          47 `data-i18n-aria-label=`
 *                          18 `data-i18n-title=`
 *                           8 `data-i18n-placeholder=`
 *
 * ---------------------------------------------------------------------------
 * Discrepancy to record: `prototype/BLOCKS.md` header is stale
 * ---------------------------------------------------------------------------
 * Its header (lines 8-9) claims **252 `data-i18n*` hooks** and **198 catalogue
 * keys**. Both are wrong against the shipped files; measured above are 606 and
 * 214. BLOCKS.md's own body (line 578) already says "214 keys per language",
 * so only the header drifted. Machine checks must therefore count from the
 * real data/DOM and never assert a prose number from that header.
 *
 * ---------------------------------------------------------------------------
 * Coverage: nothing in the prototype failed to come across
 * ---------------------------------------------------------------------------
 * Every one of the 606 hooks resolves: all 389 `data-i18n`, 47 `-aria-label`,
 * 18 `-title` and 8 `-placeholder` values are real catalogue keys, and every
 * key composed at runtime (`status.*`, `priority.*`, `access.theme.*`,
 * `access.lang.short.*` in `app.js`) exists too. `data-i18n-arg` is different
 * in kind: its 144 values are arguments, not keys — the prototype resolves one
 * with `text(arg)`, which returns the argument verbatim when it is not itself a
 * key (see `translated()`, `app.js` ~line 896). 22 of them are literal labels
 * ("ci", "ux", "3"); the rest name keys. `translate()` reproduces that fallback
 * exactly, so both cases behave as they do in the prototype.
 *
 * ---------------------------------------------------------------------------
 * Where this lives, and where it is going
 * ---------------------------------------------------------------------------
 * This is the runtime home of the catalogue (plain ESM, zero dependencies,
 * importable by both Vite and `node --test`). It is a byte-identical copy of
 * `test/web/i18n.catalogue.mjs`, which stays in `test/**` because its suite
 * (`i18n.catalogue.test.mjs`) does source-text analysis on the literal; the
 * parity between the two copies is asserted by `test/web/i18n.parity.test.mjs`
 * rather than left to trust. Do not edit one without the other.
 *
 * The `translate()` helper is a faithful port of the prototype's `text()`
 * (`prototype/app.js`, lines 538-550): active language, then English, then the
 * key itself, with `%s` filled positionally.
 */

export const LANGUAGES = Object.freeze(["en", "zh"]);
export const DEFAULT_LANGUAGE = "en";

/* Verbatim from `prototype/app.js`. */
export const CATALOGUE = {
    en: {
      /* chrome */
      "app.title": "TaskPanel — Board",
      "app.brand": "TaskPanel",
      "app.tagline": "Agent Task Collaboration",
      "project.new": "New project…",
      "topbar.search.label": "Search tasks",
      "topbar.search.placeholder": "Search tasks, #ID, labels…",
      "topbar.filters": "Toggle filters",
      "topbar.view": "View",
      "topbar.view.board": "Board",
      "topbar.view.list": "List",
      "topbar.live": "Live",
      "topbar.revision.title": "Global revision",
      "topbar.newTask": "New task",
      "nav.label": "Views",
      "nav.board": "Board",
      "nav.list": "List",
      "nav.activity": "Activity",
      "sidebar.projects": "Projects",
      "sidebar.agents": "Active agents",
      "sidebar.legend": "Legend",
      "sidebar.states": "States",
      "presence.running": "running",
      "presence.idle": "idle",
      /* filters */
      "filters.label": "Filters",
      "filters.assignee": "Assignee",
      "filters.assignee.all": "Assignee: All",
      "filters.assignee.me": "Assignee: Me",
      "filters.assignee.human": "Assignee: Human",
      "filters.assignee.agent": "Assignee: Agent",
      "filters.priority": "Priority",
      "filters.priority.all": "Priority: All",
      "filters.priority.urgent": "Priority: Urgent",
      "filters.priority.high": "Priority: High",
      "filters.priority.medium": "Priority: Medium",
      "filters.priority.low": "Priority: Low",
      "filters.priority.none": "Priority: None",
      "filters.labelLabel": "Label",
      "filters.label.all": "Label: All",
      "filters.labelOption": "Label: %s",
      "filters.clear": "Clear",
      "filters.count.initial": "12 tasks",
      "filters.count.one": "1 task",
      "filters.count.many": "%s tasks",
      "filters.count.filtered": "showing %s of %s",
      /* status + priority vocabulary */
      "status.backlog": "Backlog",
      "status.todo": "To Do",
      "status.in_progress": "In Progress",
      "status.in_review": "In Review",
      "status.blocked": "Blocked",
      "status.done": "Done",
      "status.canceled": "Canceled",
      "priority.urgent": "Urgent",
      "priority.high": "High",
      "priority.medium": "Medium",
      "priority.low": "Low",
      "priority.none": "None",
      /* columns + cards */
      "column.add": "Add task to %s",
      "column.empty.title": "No tasks",
      "column.empty.hint": "Drop a card here to move it to %s.",
      "column.empty.add": "Add",
      "card.moveTo": "Move to",
      "card.move": "Move %s to another column",
      "noResults.title": "No tasks match your filters",
      "noResults.hint": "Adjust the search or clear the filters to see the full board.",
      "noResults.clear": "Clear filters",
      /* list */
      "list.label": "Task list",
      "list.loading": "Loading tasks",
      "list.columns.identifier": "ID",
      "list.emptyRow": "No task in this project",
      /* detail drawer */
      "drawer.properties": "Properties",
      "drawer.close": "Close details",
      "prop.status": "Status",
      "prop.priority": "Priority",
      "prop.priorityValue": "Priority: %s",
      "prop.assignee": "Assignee",
      "prop.reporter": "Reporter",
      "prop.project": "Project",
      "prop.labels": "Labels",
      "prop.id": "ID",
      "prop.version": "Version",
      "drawer.description": "Description",
      "description.none": "No description yet.",
      "drawer.relations": "Relations",
      "relations.parent": "Parent",
      "relations.blocks": "Blocks",
      "relations.none": "No relations",
      "drawer.session": "Agent session",
      "session.id": "Session",
      "drawer.resume": "Resume",
      "drawer.attachments": "Attachments",
      "attachments.none": "No attachments",
      "drawer.comments": "Comments",
      "comment.human": "human",
      "comment.agent": "agent",
      "comment.decision": "decision",
      "comment.author": "human",
      "comment.now": "just now",
      "drawer.comment": "Comment",
      "drawer.commentPlaceholder": "Write a comment…",
      "drawer.commentHint": "Comments are recorded in the activity log.",
      "drawer.submit": "Submit",
      "drawer.activity": "Activity",
      "activity.created": "created this task",
      "activity.claimed": "claimed the task",
      "activity.commented": "commented",
      "time.hoursAgo": "%sh ago",
      "time.daysAgo": "%sd ago",
      /* modals */
      "createTask.title": "New task",
      "createTask.field.title": "Title",
      "createTask.field.titleHint": "Short, verb first. Shown on the card.",
      "createTask.field.description": "Description",
      "createTask.field.status": "Status",
      "createTask.field.priority": "Priority",
      "createTask.field.assignee": "Assignee",
      "createTask.field.project": "Project",
      "createTask.field.reporter": "Reporter",
      "createTask.field.parent": "Parent",
      "createTask.field.parentHint": "The task this one rolls up to. One parent, at most.",
      "createTask.field.depends": "Depends on",
      "createTask.field.dependsHint": "Tasks that must finish first. Leave blank to create.",
      "createTask.field.labels": "Labels",
      "createTask.field.labelsHint": "Labels grow as they are used. There is nothing to manage.",
      "createTask.optional": "Optional",
      /* The two roster controls: free text, fuzzy match, no roster editor. */
      "combo.assigneePlaceholder": "Search or type a new name…",
      "combo.reporterPlaceholder": "Search or type a new name…",
      "combo.empty": "No match — a new name is saved when you use it.",
      "combo.new": "· new",
      /* The label control: the same free-text mode, many per task. */
      "combo.labelsPlaceholder": "Search or type a new label…",
      "combo.noLabels": "No matching label — type a new one.",
      "combo.hint": "Up and down to choose, Enter to accept, Escape to dismiss.",
      /* The two relation controls pick from the project's existing tasks. */
      "combo.parentPlaceholder": "Search project tasks…",
      "combo.dependsPlaceholder": "Add a prerequisite…",
      "combo.noTasks": "No matching task in this project.",
      "combo.clear": "Clear",
      "combo.taskHint": "Up and down to choose, Enter to accept, Escape to dismiss.",
      /* Markdown editor chrome. */
      "md.label": "Markdown view",
      "md.write": "Write",
      "md.preview": "Preview",
      "md.split": "Split",
      "md.hint": "Markdown · rendered locally",
      "createTask.option.owner": "Terry · owner",
      "createTask.submit": "Create task",
      "createProject.title": "New project",
      "createProject.field.name": "Name",
      "createProject.field.prefix": "Identifier prefix",
      "createProject.field.prefixHint": "Up to four characters, for example TD.",
      "createProject.field.description": "Description",
      "createProject.submit": "Create project",
      "modal.cancel": "Cancel",
      "modal.close": "Close",
      /* states gallery */
      "states.title": "UI states",
      "states.close": "Close the states preview",
      "states.loading": "Loading",
      "states.loadingNote": "Skeleton placeholders hold the row height until data settles.",
      "states.emptyColumn": "Empty column",
      "states.emptyColumnNote": "An empty column stays a drop target.",
      "states.emptyResults": "No results",
      "states.emptyResultsNote": "Shown when the active filters match nothing.",
      "states.error": "Error",
      "states.errorNote": "Raised when the board cannot be loaded.",
      "states.toasts": "Toasts",
      "states.toastsNote": "Operation feedback, dismissed after 2.5 seconds.",
      /* error state */
      "error.title": "Could not load tasks",
      "error.hint": "The board did not respond. Check the connection and try again.",
      "error.retry": "Retry",
      /* toasts */
      "toast.moved": "Moved",
      "toast.commented": "Comment added",
      "toast.created": "Created",
      "toast.projectCreated": "Created project",
      "toast.projectSwitched": "Switched to project",
      "toast.copied": "Copied to clipboard",
      "toast.filtersCleared": "Filters cleared",
      "toast.themeDark": "Dark theme on",
      "toast.themeLight": "Light theme on",
      "toast.themeAuto": "Auto theme on — following the system",
      "toast.resume": "Resuming agent session",
      "toast.linked": "Opened linked task",
      "toast.activity": "Board revision",
      "toast.reloaded": "Tasks reloaded",
      "toast.langEn": "Switched to English",
      "toast.langZh": "Switched to Chinese",
      "toast.tokenCopied": "Token copied",
      "toast.tokenReset": "Token reset",
      "toast.sample.info": "Switched to project Orchestrator",
      "toast.sample.success": "Moved TD-128 → Done",
      "toast.sample.danger": "TD-118 is blocked",
      /* sidebar footer — three equal cells, one affordance each.
         The theme cell is a three-state cycle, so its label names the state in
         force and the state one press reaches: `Theme: Light. Activate for
         Dark.` The three state names are the same keys the visible label uses. */
      "access.theme.aria": "Theme: %s. Activate for %s.",
      "access.theme.light": "Light",
      "access.theme.dark": "Dark",
      "access.theme.auto": "Auto",
      "access.lang.open": "Choose language",
      "access.lang.group": "Choose a language",
      "access.lang.en": "English",
      "access.lang.zh": "中文",
      "access.lang.short.en": "EN",
      "access.lang.short.zh": "中文",
      /* access + token settings */
      "access.open": "Access and token settings",
      "access.title": "Access",
      "access.close": "Close access settings",
      "access.model.bind": "Binds to 0.0.0.0 by default — reachable from other devices on the network.",
      "access.model.token": "Requests from outside localhost must present the token.",
      "access.cidr.note": "Allowed source ranges (CIDR). Traffic outside these ranges is rejected.",
      "access.cidr.enabled": "IP allow-list in force",
      "access.cidr.disabled": "IP allow-list is off",
      "access.cidr.add": "Add allowed range",
      "access.cidr.remove": "Remove this range",
      "access.cidr.value": "Allowed source range",
      "access.token.title": "Access token",
      "access.token.reveal": "Reveal token",
      "access.token.hide": "Hide token",
      "access.token.copy": "Copy token",
      "access.token.reset": "Reset token",
      "access.token.generated": "Generated randomly at install time.",
      "access.token.private": "Keep it private — do not share publicly.",
    },
    zh: {
      /* chrome */
      "app.title": "TaskPanel — 看板",
      "app.brand": "TaskPanel",
      "app.tagline": "Agent 任务协作面板",
      "project.new": "新建项目…",
      "topbar.search.label": "搜索任务",
      "topbar.search.placeholder": "搜索任务、#ID、标签…",
      "topbar.filters": "显示或隐藏筛选栏",
      "topbar.view": "视图",
      "topbar.view.board": "看板",
      "topbar.view.list": "列表",
      "topbar.live": "实时",
      "topbar.revision.title": "全局修订号",
      "topbar.newTask": "新建任务",
      "nav.label": "视图导航",
      "nav.board": "看板",
      "nav.list": "列表",
      "nav.activity": "动态",
      "sidebar.projects": "项目",
      "sidebar.agents": "活跃 Agent",
      "sidebar.legend": "图例",
      "sidebar.states": "状态总览",
      "presence.running": "运行中",
      "presence.idle": "空闲",
      /* filters */
      "filters.label": "筛选",
      "filters.assignee": "负责人",
      "filters.assignee.all": "负责人：全部",
      "filters.assignee.me": "负责人：我",
      "filters.assignee.human": "负责人：人类",
      "filters.assignee.agent": "负责人：Agent",
      "filters.priority": "优先级",
      "filters.priority.all": "优先级：全部",
      "filters.priority.urgent": "优先级：紧急",
      "filters.priority.high": "优先级：高",
      "filters.priority.medium": "优先级：中",
      "filters.priority.low": "优先级：低",
      "filters.priority.none": "优先级：无",
      "filters.labelLabel": "标签",
      "filters.label.all": "标签：全部",
      "filters.labelOption": "标签：%s",
      "filters.clear": "清除",
      "filters.count.initial": "12 个任务",
      "filters.count.one": "1 个任务",
      "filters.count.many": "%s 个任务",
      "filters.count.filtered": "显示 %s / 共 %s",
      /* status + priority vocabulary */
      "status.backlog": "待排期",
      "status.todo": "待办",
      "status.in_progress": "进行中",
      "status.in_review": "待验收",
      "status.blocked": "已阻塞",
      "status.done": "已完成",
      "status.canceled": "已取消",
      "priority.urgent": "紧急",
      "priority.high": "高",
      "priority.medium": "中",
      "priority.low": "低",
      "priority.none": "无",
      /* columns + cards */
      "column.add": "在%s中新建任务",
      "column.empty.title": "暂无任务",
      "column.empty.hint": "把卡片拖到这里，即可移动到%s。",
      "column.empty.add": "添加",
      "card.moveTo": "移动到",
      "card.move": "把 %s 移动到其他列",
      "noResults.title": "没有符合筛选条件的任务",
      "noResults.hint": "调整搜索条件或清除筛选，即可看到完整看板。",
      "noResults.clear": "清除筛选",
      /* list */
      "list.label": "任务列表",
      "list.loading": "正在加载任务",
      "list.columns.identifier": "ID",
      "list.emptyRow": "该项目暂无任务",
      /* detail drawer */
      "drawer.properties": "属性",
      "drawer.close": "关闭详情",
      "prop.status": "状态",
      "prop.priority": "优先级",
      "prop.priorityValue": "优先级：%s",
      "prop.assignee": "负责人",
      "prop.reporter": "创建人",
      "prop.project": "项目",
      "prop.labels": "标签",
      "prop.id": "内部 ID",
      "prop.version": "版本",
      "drawer.description": "描述",
      "description.none": "暂无描述。",
      "drawer.relations": "关联",
      "relations.parent": "父任务",
      "relations.blocks": "阻塞",
      "relations.none": "暂无关联",
      "drawer.session": "Agent 会话",
      "session.id": "会话",
      "drawer.resume": "继续会话",
      "drawer.attachments": "附件",
      "attachments.none": "暂无附件",
      "drawer.comments": "评论",
      "comment.human": "人类",
      "comment.agent": "Agent",
      "comment.decision": "决策",
      "comment.author": "人类",
      "comment.now": "刚刚",
      "drawer.comment": "发表评论",
      "drawer.commentPlaceholder": "写下评论…",
      "drawer.commentHint": "评论会记录到活动流中。",
      "drawer.submit": "提交",
      "drawer.activity": "活动",
      "activity.created": "创建了任务",
      "activity.claimed": "认领了任务",
      "activity.commented": "发表了评论",
      "time.hoursAgo": "%s 小时前",
      "time.daysAgo": "%s 天前",
      /* modals */
      "createTask.title": "新建任务",
      "createTask.field.title": "标题",
      "createTask.field.titleHint": "简短，动词开头。显示在卡片上。",
      "createTask.field.description": "描述",
      "createTask.field.status": "状态",
      "createTask.field.priority": "优先级",
      "createTask.field.assignee": "负责人",
      "createTask.field.project": "项目",
      "createTask.field.reporter": "创建人",
      "createTask.field.parent": "父任务",
      "createTask.field.parentHint": "本任务归属的任务。最多一个父任务。",
      "createTask.field.depends": "前置依赖",
      "createTask.field.dependsHint": "须先完成的任务。留空即可创建。",
      "createTask.field.labels": "标签",
      "createTask.field.labelsHint": "标签随使用而生，无需管理。",
      "createTask.optional": "可选",
      "combo.assigneePlaceholder": "搜索或输入新姓名…",
      "combo.reporterPlaceholder": "搜索或输入新姓名…",
      "combo.empty": "无匹配——使用时将保存为新姓名。",
      "combo.new": "· 新",
      "combo.labelsPlaceholder": "搜索或输入新标签…",
      "combo.noLabels": "无匹配标签——输入新标签。",
      "combo.hint": "↑↓ 选择，Enter 确认，Esc 关闭。",
      "combo.parentPlaceholder": "搜索项目内任务…",
      "combo.dependsPlaceholder": "添加前置任务…",
      "combo.noTasks": "该项目中没有匹配的任务。",
      "combo.clear": "清除",
      "combo.taskHint": "↑↓ 选择，Enter 添加，Esc 关闭。",
      "md.label": "Markdown 视图",
      "md.write": "编辑",
      "md.preview": "预览",
      "md.split": "分栏",
      "md.hint": "Markdown · 本地渲染",
      "createTask.option.owner": "Terry · 所有者",
      "createTask.submit": "创建任务",
      "createProject.title": "新建项目",
      "createProject.field.name": "名称",
      "createProject.field.prefix": "标识前缀",
      "createProject.field.prefixHint": "最多四个字符，例如 TD。",
      "createProject.field.description": "描述",
      "createProject.submit": "创建项目",
      "modal.cancel": "取消",
      "modal.close": "关闭",
      /* states gallery */
      "states.title": "界面状态",
      "states.close": "关闭状态总览",
      "states.loading": "加载中",
      "states.loadingNote": "数据就绪前，骨架占位保持行高。",
      "states.emptyColumn": "空列",
      "states.emptyColumnNote": "空列仍可作为放置目标。",
      "states.emptyResults": "无结果",
      "states.emptyResultsNote": "当前筛选没有匹配项时显示。",
      "states.error": "错误",
      "states.errorNote": "看板加载失败时显示。",
      "states.toasts": "轻提示",
      "states.toastsNote": "操作反馈，2.5 秒后自动消失。",
      /* error state */
      "error.title": "无法加载任务",
      "error.hint": "看板没有响应。请检查连接后重试。",
      "error.retry": "重试",
      /* toasts */
      "toast.moved": "已移动",
      "toast.commented": "已添加评论",
      "toast.created": "已创建",
      "toast.projectCreated": "已创建项目",
      "toast.projectSwitched": "已切换到项目",
      "toast.copied": "已复制",
      "toast.filtersCleared": "已清除筛选",
      "toast.themeDark": "已切换到深色主题",
      "toast.themeLight": "已切换到浅色主题",
      "toast.themeAuto": "已切换到自动主题（跟随系统）",
      "toast.resume": "正在继续 Agent 会话",
      "toast.linked": "已打开关联任务",
      "toast.activity": "看板修订",
      "toast.reloaded": "任务已重新加载",
      "toast.langEn": "已切换到英文",
      "toast.langZh": "已切换到中文",
      "toast.tokenCopied": "已复制 Token",
      "toast.tokenReset": "Token 已重置",
      "toast.sample.info": "已切换到项目 Orchestrator",
      "toast.sample.success": "已移动 TD-128 → 已完成",
      "toast.sample.danger": "TD-118 已阻塞",
      /* sidebar footer — three equal cells, one affordance each */
      "access.theme.aria": "主题：%s。点击切换到%s。",
      "access.theme.light": "浅色",
      "access.theme.dark": "深色",
      "access.theme.auto": "自动",
      "access.lang.open": "选择语言",
      "access.lang.group": "选择语言",
      "access.lang.en": "English",
      "access.lang.zh": "中文",
      "access.lang.short.en": "EN",
      "access.lang.short.zh": "中文",
      /* access + token settings */
      "access.open": "访问与 Token 设置",
      "access.title": "访问",
      "access.close": "关闭访问设置",
      "access.model.bind": "默认绑定 0.0.0.0 —— 同一网络内的其他设备可以直接访问。",
      "access.model.token": "来自 localhost 之外的请求必须携带 Token。",
      "access.cidr.note": "允许的来源网段（CIDR）。超出这些范围的流量将被拒绝。",
      "access.cidr.enabled": "IP 白名单已启用",
      "access.cidr.disabled": "IP 白名单已关闭",
      "access.cidr.add": "新增允许网段",
      "access.cidr.remove": "删除该网段",
      "access.cidr.value": "允许的来源网段",
      "access.token.title": "访问 Token",
      "access.token.reveal": "显示 Token",
      "access.token.hide": "隐藏 Token",
      "access.token.copy": "复制 Token",
      "access.token.reset": "重置 Token",
      "access.token.generated": "安装时随机生成。",
      "access.token.private": "请妥善保管，不要公开分享。",
    },
  };

/* Deep-frozen so an import cannot mutate the shared catalogue. */
for (const table of Object.values(CATALOGUE)) Object.freeze(table);
Object.freeze(CATALOGUE);

/** Normalises a language tag to a catalogue table, falling back to English. */
export function tableFor(language) {
  return CATALOGUE[language] || CATALOGUE[DEFAULT_LANGUAGE];
}

/** True when `key` exists in `language` (independent of the en fallback). */
export function hasKey(language, key) {
  return Object.prototype.hasOwnProperty.call(tableFor(language), key);
}

/**
 * Port of the prototype's `text(key, a, b)`: look the key up in `language`,
 * fall back to English, then to the key itself (visible copy beats an empty
 * string), and replace each `%s` with the next argument, in order.
 */
export function translate(language, key, ...args) {
  const value = tableFor(language)[key] ?? CATALOGUE[DEFAULT_LANGUAGE][key] ?? key;
  let out = value;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === undefined || args[i] === null) continue;
    out = out.replace("%s", String(args[i]));
  }
  return out;
}
