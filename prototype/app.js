/* ============================================================================
   TaskDashboard v1 prototype — interaction layer
   ----------------------------------------------------------------------------
   jQuery (slim build) only. Every binding uses `$(...).on(...)` with `data-*`
   hooks; no bare document.querySelector / addEventListener anywhere.
   No network, no storage, no tokens — this file is a pure static prototype.
   Interaction map: design-spec §6 (I1–I12).
   ========================================================================== */
(function ($) {
  "use strict";

  /* ------------------------------------------------------------------ data */

  var STATUSES = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "canceled",
  ];

  var PROJECT_PREFIX = {
    TaskDashboard: "TD",
    Orchestrator: "ORC",
    "Site Refresh": "SR",
  };

  /* In-memory message catalogue. English is the default language and `zh`
     mirrors every key; the catalogue lives in this file and is never fetched.
     Keys are the same namespace the markup carries in `data-i18n`, so the
     static copy and the copy `app.js` generates translate together. `%s`
     placeholders are filled positionally by text(). */
  var MESSAGES = {
    en: {
      /* chrome */
      "app.title": "TaskDashboard — Board",
      "app.brand": "TaskDashboard",
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
      /* sidebar footer — three equal cells, one affordance each */
      "access.theme.switch.dark": "Switch to dark theme",
      "access.theme.switch.light": "Switch to light theme",
      "access.theme.light": "Light",
      "access.theme.dark": "Dark",
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
      "app.title": "TaskDashboard — 看板",
      "app.brand": "TaskDashboard",
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
      "access.theme.switch.dark": "切换到深色主题",
      "access.theme.switch.light": "切换到浅色主题",
      "access.theme.light": "浅色",
      "access.theme.dark": "深色",
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

  var LANGS = ["en", "zh"];

  /* The stand-in token the panel opens with. Twelve characters, generated once
     per load in memory — the prototype stores it nowhere. */
  var TOKEN_LENGTH = 12;
  var TOKEN_PREFIX = "td_";

  var ME = "Terry";

  /* Avatar monograms for the team. One letter for the human owner, two for the
     agent handles — the same labels the static markup carries. */
  var MONOGRAM = {
    Terry: "T",
    elon: "EL",
    jobs: "JO",
    linus: "LI",
    turing: "TU",
    simons: "SI",
    assistant: "AS",
  };

  var state = {
    project: "TaskDashboard",
    view: "board",
    lang: "en",
    moveIdentifier: null,
    searchTimer: null,
    /* Token panel state. Value and reveal flag live in memory for the lifetime
       of the page and are written back to nothing. */
    token: { value: "", revealed: false },
  };

  /* --------------------------------------------------------------- helpers */

  /* Looks a key up in the active language, falling back to English and then to
     the key itself, so a missing translation degrades to visible copy rather
     than to an empty string. `%s` placeholders are filled in order. */
  function text(key, a, b) {
    var table = MESSAGES[state.lang] || MESSAGES.en;
    var value = table[key];
    if (value === undefined) value = MESSAGES.en[key];
    if (value === undefined) return key;
    var args = [];
    if (a !== undefined && a !== null) args.push(a);
    if (b !== undefined && b !== null) args.push(b);
    for (var i = 0; i < args.length; i++) {
      value = value.replace("%s", args[i]);
    }
    return value;
  }

  function statusLabel(status) {
    return text("status." + status);
  }

  function priorityLabel(priority) {
    return text("priority." + priority);
  }

  /* Card scalars live in data-* attributes (design-spec §5.6). */
  function attr($el, name) {
    var value = $el.attr("data-" + name);
    return value === undefined || value === null ? "" : String(value);
  }

  function initials(name) {
    var parts = String(name).split(" ");
    var out = "";
    for (var i = 0; i < parts.length && out.length < 2; i++) {
      if (parts[i]) out += parts[i].charAt(0).toUpperCase();
    }
    return out || "?";
  }

  function monogram(name) {
    return MONOGRAM[name] || initials(name);
  }

  function numeric(id) {
    var n = String(id).replace(/[^0-9]/g, "");
    return n ? parseInt(n, 10) : 0;
  }

  /* ------------------------------------------------------- I12 · toast ---- */

  function toast(message, kind) {
    var $template = $("[data-toast-template]").html();
    if (!$template) return;
    var $item = $($.trim($template));
    $item.attr("data-toast-kind", kind || "info");
    $item.find("[data-toast-text]").text(message);
    $("[data-toast-region]").append($item);

    window.setTimeout(function () {
      $item.attr("data-state", "leaving");
      window.setTimeout(function () {
        $item.remove();
      }, 200);
    }, 2500);
  }

  /* Concurrent-write stand-in: every mutation advances the revision readout. */
  function bumpRevision() {
    var $value = $("[data-revision-value]");
    var next = parseInt($value.text(), 10) + 1;
    if (isNaN(next)) next = 1;
    $value.text(next);
  }

  /* ------------------------------------------------- board / column state */

  function refreshColumns() {
    $("[data-column]").each(function () {
      var $column = $(this);
      var visible = $column.find("[data-card]:not([hidden])").length;
      $column.find("[data-column-count]").text(visible);
      $column
        .find('[data-empty][data-empty-kind="column"]')
        .prop("hidden", visible !== 0);
    });
  }

  /* I1/I2 · single place where a card changes status. */
  function moveCard($card, status, announce) {
    if (!$card.length || STATUSES.indexOf(status) === -1) return;

    var identifier = attr($card, "identifier");
    var previous = attr($card, "status");
    if (previous === status) return;

    var $body = $(
      '[data-column][data-status="' + status + '"] [data-column-body]'
    );
    if (!$body.length) return;

    var $empty = $body.find('[data-empty][data-empty-kind="column"]');
    if ($empty.length) {
      $empty.before($card);
    } else {
      $body.append($card);
    }

    $card.attr("data-status", status);
    $card.attr("data-done", String(status === "done"));
    $card.attr("data-canceled", String(status === "canceled"));
    $card.find("[data-card-stripe]").attr("title", statusLabel(status));

    refreshColumns();

    if (announce !== false) {
      toast(
        text("toast.moved") +
          " " +
          identifier +
          " → " +
          statusLabel(status),
        status === "blocked" ? "danger" : "success"
      );
      bumpRevision();
      if (state.view === "list") renderList();
    }
  }

  /* I6 / I8 · one filter pass drives cards, column counts and the count readout */
  function applyFilters() {
    var query = $.trim(String($("[data-search-input]").val() || "")).toLowerCase();
    var byAssignee = $("[data-filter-assignee]").val();
    var byPriority = $("[data-filter-priority]").val();
    var byLabel = $("[data-filter-label]").val();

    var total = 0;
    var shown = 0;

    $("[data-card]").each(function () {
      var $card = $(this);

      if (attr($card, "project") !== state.project) {
        $card.prop("hidden", true);
        return;
      }
      total++;

      var ok = true;

      if (query) {
        var haystack = [
          $card.find("[data-card-title]").text(),
          attr($card, "identifier"),
          attr($card, "labels"),
          attr($card, "assignee"),
          attr($card, "priority"),
        ]
          .join(" ")
          .toLowerCase();
        ok = haystack.indexOf(query) !== -1;
      }

      if (ok && byAssignee !== "all") {
        ok =
          byAssignee === "me"
            ? attr($card, "assignee") === ME
            : attr($card, "assignee-kind") === byAssignee;
      }

      if (ok && byPriority !== "all") {
        ok = attr($card, "priority") === byPriority;
      }

      if (ok && byLabel !== "all") {
        ok =
          ("," + attr($card, "labels") + ",").indexOf("," + byLabel + ",") !==
          -1;
      }

      $card.prop("hidden", !ok);
      if (ok) shown++;
    });

    refreshColumns();

    $("[data-filter-count]").text(
      shown === total
        ? total === 1
          ? text("filters.count.one")
          : text("filters.count.many", total)
        : text("filters.count.filtered", shown, total)
    );

    $('[data-empty][data-empty-kind="no-results"]').prop(
      "hidden",
      !(total > 0 && shown === 0)
    );

    if (state.view === "list") renderList();
  }

  function resetFilters() {
    $("[data-search-input]").val("");
    $("[data-filter-assignee]").val("all");
    $("[data-filter-priority]").val("all");
    $("[data-filter-label]").val("all");
    applyFilters();
  }

  /* -------------------------------------------------------- I7 · views ---- */

  function setView(view) {
    state.view = view;

    $("[data-board]").prop("hidden", view !== "board");
    $("[data-list]").prop("hidden", view !== "list");

    $("[data-view-toggle] [data-view]").each(function () {
      var $button = $(this);
      $button.attr(
        "aria-pressed",
        String($button.attr("data-view") === view)
      );
    });

    $("[data-nav-item]").each(function () {
      var $item = $(this);
      var name = $item.attr("data-nav-item");
      if (name !== "board" && name !== "list") return;
      if (name === view) {
        $item.attr("aria-current", "page");
      } else {
        $item.removeAttr("aria-current");
      }
    });

    if (view === "list") renderList();
  }

  /* List rows are derived from the cards that survived the current filters. */
  function renderList() {
    var $host = $("[data-list-rows]");
    var markup = $.trim($("[data-list-row-template]").html() || "");
    if (!$host.length || !markup) return;

    $host.empty();

    var rows = 0;
    $("[data-card]:not([hidden])").each(function () {
      var $card = $(this);
      var $row = $(markup);
      var status = attr($card, "status");
      var priority = attr($card, "priority");

      $row.attr("data-identifier", attr($card, "identifier"));
      $row.find("[data-list-identifier]").text(attr($card, "identifier"));
      $row.find("[data-list-title]").text($card.find("[data-card-title]").text());
      $row
        .find("[data-list-status]")
        .attr("data-status", status)
        .find("[data-list-status-label]")
        .text(statusLabel(status));
      $row.find("[data-list-assignee]").text(attr($card, "assignee"));
      $row
        .find("[data-list-priority]")
        .attr("data-priority", priority)
        .attr("aria-label", text("prop.priorityValue", priorityLabel(priority)))
        .find("[data-list-priority-label]")
        .text(priorityLabel(priority));
      $row.find("[data-list-revision]").text(attr($card, "version"));
      $host.append($row);
      rows++;
    });

    if (!rows) {
      $host.append(
        $('<div class="td-empty"></div>').append(
          $('<span class="td-empty-title"></span>').text(text("list.emptyRow"))
        )
      );
    }
  }

  /* ------------------------------------------------------- i18n · switch -- */

  /* One pass over every translated hook in the document: `data-i18n` sets the
     text, the three attribute variants set placeholder / aria-label / title.
     `data-i18n-arg` supplies a `%s` value that is itself looked up as a key, so
     a column hint can name its own status in whatever language is active. */
  function applyLang(lang) {
    if (LANGS.indexOf(lang) === -1) lang = "en";
    state.lang = lang;
    $("html").attr("lang", lang === "zh" ? "zh-CN" : "en");

    translateTree($(document));

    applyLanguageOptions();

    refreshGeneratedCopy();
  }

  /* Resolves one hook. The optional `data-i18n-arg` is looked up as a key
     first, so `column.add` + `status.todo` reads "Add task to To Do" in
     English and "在待办中新建任务" in Chinese. */
  function translated($el, keyAttribute) {
    var key = $el.attr(keyAttribute);
    var arg = $el.attr("data-i18n-arg");
    return arg ? text(key, text(arg)) : text(key);
  }

  /* Rewrites every translation hook inside a subtree. Called for the whole
     document on a language switch, and for the drawer on open — the drawer's
     body is copied out of an inert <template>, which the document pass cannot
     reach, so it needs the same treatment once it lands. */
  function translateTree($scope) {
    $scope.find("[data-i18n]").each(function () {
      $(this).text(translated($(this), "data-i18n"));
    });

    $scope.find("[data-i18n-placeholder]").each(function () {
      $(this).attr("placeholder", translated($(this), "data-i18n-placeholder"));
    });

    $scope.find("[data-i18n-aria-label]").each(function () {
      $(this).attr("aria-label", translated($(this), "data-i18n-aria-label"));
    });

    $scope.find("[data-i18n-title]").each(function () {
      $(this).attr("title", translated($(this), "data-i18n-title"));
    });
  }

  /* The two glyphs are inline SVG, and SVG elements carry no `hidden` IDL
     attribute — `prop("hidden", …)` writes a JS expando and the `[hidden]` rule
     never matches. The attribute is what hides them. */
  function showGlyph($glyph, show) {
    if (show) $glyph.removeAttr("hidden");
    else $glyph.attr("hidden", "");
  }

  /* One place owns the theme: the `data-theme` attribute, which glyph the
     footer switch shows, the theme's name in that switch, and the label that
     names the state one press reaches. The first pass and the press both come
     through here, so the switch and the document can never disagree about the
     active theme. */
  function applyTheme(dark) {
    var $switch = $("[data-theme-switch]");
    var label = text(dark ? "access.theme.switch.light" : "access.theme.switch.dark");
    $("html").attr("data-theme", dark ? "dark" : "taskdash");
    showGlyph($switch.find('[data-theme-icon="light"]'), !dark);
    showGlyph($switch.find('[data-theme-icon="dark"]'), dark);
    $switch
      .find("[data-theme-label]")
      .text(text(dark ? "access.theme.dark" : "access.theme.light"));
    /* the control is a switch, so `aria-pressed` carries the state and the
       label carries both the state in force and the state one press reaches */
    $switch.attr("aria-pressed", String(dark)).attr("aria-label", label).attr("title", label);
  }

  /* Same idea for the language: `<html lang>`, the language's own short name in
     the footer trigger, and which option in the menu reads as chosen. */
  function applyLanguageOptions() {
    $("[data-lang-label]").text(text("access.lang.short." + state.lang));
    $("[data-lang-option]").each(function () {
      var $option = $(this);
      $option.attr("aria-pressed", String($option.attr("data-lang-option") === state.lang));
    });
  }

  /* Copy the interaction layer writes itself — card attributes, drawer property
     values, the theme button's promise — has no static hook to rewrite, so it
     is regenerated from the current state on every language change. */
  function refreshGeneratedCopy() {
    applyTheme($("html").attr("data-theme") === "dark");

    $("[data-card]").each(function () {
      var $card = $(this);
      var priorityCopy = text(
        "prop.priorityValue",
        priorityLabel(attr($card, "priority"))
      );
      $card
        .find("[data-card-stripe]")
        .attr("title", statusLabel(attr($card, "status")));
      $card
        .find("[data-card-priority]")
        .attr("aria-label", priorityCopy)
        .attr("title", priorityCopy);
      $card
        .find("[data-card-menu]")
        .attr("aria-label", text("card.move", attr($card, "identifier")));
    });

    var $drawer = $("[data-detail-drawer]");
    if ($drawer.attr("data-state") === "open") {
      var status = $drawer.find("[data-detail-status]").attr("data-status");
      var priority = $drawer.find("[data-detail-priority]").attr("data-priority");
      $drawer
        .find("[data-detail-status-label], [data-detail-status-chip-label]")
        .text(statusLabel(status));
      $drawer.find("[data-detail-priority-label]").text(priorityLabel(priority));
      $drawer
        .find("[data-detail-priority] .td-pri")
        .attr("aria-label", text("prop.priorityValue", priorityLabel(priority)));
    }

    renderToken();
    applyFilters();
  }

  function setLang(lang) {
    if (LANGS.indexOf(lang) === -1 || lang === state.lang) return;
    applyLang(lang);
    toast(lang === "zh" ? text("toast.langZh") : text("toast.langEn"), "info");
  }

  /* ------------------------------------------------ overlay focus helper -- */

  /* A panel that is still `visibility: hidden` on the frame it opens cannot
     take focus, so the whole opening is deferred by one transition length —
     the same 200ms the closing paths wait out. Shared by the drawer, the states
     showcase and all three dialogs so they behave alike. */
  function focusWhenOpen($target, $panel) {
    window.setTimeout(function () {
      if ($panel.attr("data-state") === "open") $target.trigger("focus");
    }, 200);
  }

  /* ------------------------------------------ the language menu ----------- */

  /* The footer's centre cell is a dropdown, not an entry to a dialog. It is
     positioned the way the card's "Move to" menu is — `position: fixed` beside
     the invoking control — for the same reason: the sidebar is a scroll
     container, so an absolutely positioned menu would be clipped by it and
     would drag a scrollbar along with it. It opens upward, because the cell it
     belongs to sits at the bottom of the rail.
     The trigger's own box is read in viewport coordinates, which is what
     `position: fixed` is measured against; `offset()` is document-relative and
     so drifts once the sidebar has been scrolled. */
  function closeLangMenu() {
    $("[data-lang-menu]").prop("hidden", true).removeAttr("style");
    $("[data-lang-select]").attr("aria-expanded", "false");
  }

  function openLangMenu($button) {
    var $menu = $("[data-lang-menu]");
    var box = $button[0].getBoundingClientRect();
    $menu.prop("hidden", false);
    var width = $menu.outerWidth();
    var left = Math.max(
      8,
      Math.min(box.left + box.width - width, $(window).width() - width - 8)
    );
    $menu
      .css({
        position: "fixed",
        top: Math.max(8, box.top - $menu.outerHeight() - 4) + "px",
        left: left + "px",
        zIndex: 70,
      });
    $button.attr("aria-expanded", "true");
  }

  /* ------------------------------------------ dialog · B19 access --------- */

  /* The one remaining dialog. `data-state` drives the transition and `hidden`
     keeps the panel out of the static document; the panel leaves `hidden` a
     frame before `data-state` flips so the transition has a start point, and
     focus moves inside once it can take it. Closing lands the caret back on the
     footer cell that opened it. */
  function openAccess() {
    var $panel = $("[data-access-panel]");
    if ($panel.attr("data-state") === "open") return;
    $("[data-access-overlay]").prop("hidden", false).width();
    $("[data-access-overlay]").attr("data-state", "open");
    $panel.prop("hidden", false).width();
    $panel.attr("data-state", "open").attr("aria-hidden", "false");
    focusWhenOpen($("[data-access-close]"), $panel);
  }

  function closeAccess() {
    var $panel = $("[data-access-panel]");
    if ($panel.attr("data-state") !== "open") return;
    $panel.attr("data-state", "closed").attr("aria-hidden", "true");
    $("[data-access-overlay]").attr("data-state", "closed");
    window.setTimeout(function () {
      if ($panel.attr("data-state") !== "closed") return;
      $panel.prop("hidden", true);
      $("[data-access-overlay]").prop("hidden", true);
    }, 200);
    $("[data-access-open]").trigger("focus");
  }

  /* -------------------------------------------- B19 · access + token ------ */

  /* The panel shows a stand-in credential, never a real one: the value is
     generated here, masked here, and reset here. It is written to the DOM and
     to nothing else — no storage, no transport, no clipboard. */
  function maskToken(token) {
    var value = String(token);
    var head = value.slice(0, TOKEN_PREFIX.length);
    var bullets = "";
    for (var i = head.length; i < value.length; i++) bullets += "•";
    return head + bullets;
  }

  /* Seeded from Math.random() and Date.now(), then stretched with a Lehmer
     generator so the stand-in reads like a credential and differs on every
     reset while staying in memory only. */
  function newToken() {
    var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    var seed =
      ((new Date().getTime() + Math.floor(Math.random() * 1000000000)) %
        2147483646) +
      1;
    var out = "";
    for (var i = 0; i < TOKEN_LENGTH; i++) {
      seed = (seed * 48271) % 2147483647;
      out += alphabet.charAt(seed % alphabet.length);
    }
    return TOKEN_PREFIX + out;
  }

  function renderToken() {
    var revealed = state.token.revealed;
    $("[data-token-value]").text(
      revealed ? state.token.value : maskToken(state.token.value)
    );
    $("[data-token-block]").attr("data-token-revealed", String(revealed));

    var $reveal = $("[data-token-reveal]");
    var label = revealed ? text("access.token.hide") : text("access.token.reveal");
    $reveal.attr("aria-pressed", String(revealed));
    $reveal.attr("aria-label", label).attr("title", label);
    $reveal.find('[data-token-icon="hidden"]').prop("hidden", revealed);
    $reveal.find('[data-token-icon="shown"]').prop("hidden", !revealed);
  }

  /* One whitelist row, built from the same markup the three seeded rows carry,
     so a row added at runtime is indistinguishable from a seeded one: same
     delegated handlers, same translation hooks. The row is a placeholder —
     the value is never validated, compared, stored or sent anywhere. */
  function cidrRow(value) {
    var $row = $('<li class="td-cidr-row" data-cidr-row></li>');

    var $input = $(
      '<input class="td-input td-mono td-cidr-value" type="text" autocomplete="off" spellcheck="false" data-cidr-value>'
    )
      .attr("data-i18n-aria-label", "access.cidr.value")
      .attr("aria-label", text("access.cidr.value"))
      .val(value || "");

    var $remove = $(
      '<button type="button" class="td-iconbtn" data-cidr-remove></button>'
    )
      .attr("data-i18n-aria-label", "access.cidr.remove")
      .attr("data-i18n-title", "access.cidr.remove")
      .attr("aria-label", text("access.cidr.remove"))
      .attr("title", text("access.cidr.remove"))
      .append(ICON_CLOSE);

    return $row.append($input).append($remove);
  }

  /* ------------------------------------------------------- I3 · details --- */

  function openDetail($card) {
    if (!$card || !$card.length) return;

    var data = {
      identifier: attr($card, "identifier"),
      internalId: attr($card, "id"),
      status: attr($card, "status"),
      priority: attr($card, "priority"),
      project: attr($card, "project"),
      assignee: attr($card, "assignee"),
      kind: attr($card, "assignee-kind"),
      version: attr($card, "version"),
    };

    var $drawer = $("[data-detail-drawer]");

    /* head + property grid -------------------------------------------------- */
    $drawer.find("[data-detail-identifier]").text(data.identifier);
    $drawer
      .find("[data-detail-title]")
      .text($card.find("[data-card-title]").text() || data.identifier);

    $drawer
      .find("[data-detail-status-chip]")
      .attr("data-status", data.status)
      .find("[data-detail-status-chip-label]")
      .text(statusLabel(data.status));

    $drawer
      .find("[data-detail-status]")
      .attr("data-status", data.status)
      .find("[data-detail-status-label]")
      .text(statusLabel(data.status));

    var $priority = $drawer.find("[data-detail-priority]");
    $priority.attr("data-priority", data.priority);
    $priority.find("[data-detail-priority-label]").text(
      priorityLabel(data.priority)
    );
    $priority
      .find(".td-pri")
      .attr("aria-label", text("prop.priorityValue", priorityLabel(data.priority)));

    /* reuse the card's own monogram so card, list and drawer never disagree */
    var $avatar = $drawer.find("[data-detail-assignee-avatar]");
    var cardMono = $.trim($card.find("[data-card-assignee]").text());
    $avatar
      .text(cardMono || monogram(data.assignee))
      .attr("data-assignee-kind", data.kind);
    $avatar.attr("title", data.assignee);
    $drawer.find("[data-detail-assignee-label]").text(data.assignee);
    $drawer.find("[data-detail-assignee]").attr("data-assignee-kind", data.kind);

    /* agent cards advertise their platform next to the role name */
    var platform = $card.find("[data-card-agent-badge]").attr("data-agent-platform") || "";
    var $platformChip = $drawer.find("[data-detail-assignee-platform]");
    if (platform) {
      $platformChip
        .prop("hidden", false)
        .attr("data-agent-platform", platform)
        .text(platform);
    } else {
      $platformChip.prop("hidden", true);
    }

    /* reporter stands in for "created by" until the activity block takes over */
    var reporter = attr($card, "reporter") || ME;
    $drawer.find("[data-detail-reporter-label]").text(reporter);
    $drawer
      .find("[data-detail-reporter-avatar]")
      .text(monogram(reporter))
      .attr("title", reporter);

    $drawer.find("[data-detail-project-label]").text(data.project);
    $drawer.find("[data-detail-id]").text(data.internalId);
    $drawer.find("[data-detail-id-copy]").attr("data-copy-value", data.internalId);
    $drawer.find("[data-detail-version]").text(data.version);

    /* per-card body sections (inline <template data-detail-for="…">) -------- */
    var markup = $.trim(
      $('template[data-detail-for="' + data.identifier + '"]').html() || ""
    );
    var $source = $('<div data-detail-slot-source hidden></div>').append(
      markup ? $(markup) : ""
    );

    function fill(target, name, emptyKey) {
      var $target = $drawer.find(target);
      var $slot = $source.find('[data-slot="' + name + '"]');
      $target.empty();
      if ($slot.length && $slot.children().length) {
        $target.append($slot.children());
      } else if (emptyKey) {
        $target.append(
          $('<span class="text-xs text-td-ink-3"></span>')
            .attr("data-i18n", emptyKey)
            .text(text(emptyKey))
        );
      }
    }

    fill("[data-detail-description]", "description", "description.none");
    fill("[data-detail-relations]", "relations", "relations.none");
    fill("[data-detail-attachments]", "attachments", "attachments.none");
    fill("[data-detail-comments]", "comments", null);
    fill("[data-detail-activity]", "activity", null);

    var $sessionSlot = $source.find('[data-slot="agent-session"]');
    var $sessionSection = $drawer.find("[data-detail-agent-session]");
    var $sessionBody = $drawer.find("[data-detail-agent-session-body]");
    $sessionBody.empty();
    if ($sessionSlot.length && $sessionSlot.children().length) {
      $sessionBody.append($sessionSlot.children());
      $sessionSection.prop("hidden", false);
    } else {
      $sessionSection.prop("hidden", true);
    }

    $source.remove();

    /* the copied template still carries the language it was authored in */
    translateTree($drawer);

    /* selection + open state ----------------------------------------------- */
    $("[data-card]").attr("aria-selected", "false");
    $card.attr("aria-selected", "true");
    $("[data-detail-overlay]").prop("hidden", false).width();
    $("[data-detail-overlay]").attr("data-state", "open");
    $drawer.attr("data-state", "open").attr("aria-hidden", "false");
    focusWhenOpen($drawer.find("[data-detail-close]"), $drawer);
  }

  /* ------------------------------------------ B18 · states showcase ------- */

  function openStates() {
    var $panel = $("[data-states-panel]");
    if ($panel.attr("data-state") === "open") return;
    $("[data-states-overlay]").prop("hidden", false).width();
    $("[data-states-overlay]").attr("data-state", "open");
    $panel.attr("data-state", "open").attr("aria-hidden", "false");
    focusWhenOpen($("[data-states-close]"), $panel);
  }

  function closeStates() {
    var $panel = $("[data-states-panel]");
    if ($panel.attr("data-state") !== "open") return;
    $panel.attr("data-state", "closed").attr("aria-hidden", "true");
    $("[data-states-overlay]").attr("data-state", "closed");
    window.setTimeout(function () {
      if ($("[data-states-overlay]").attr("data-state") === "closed") {
        $("[data-states-overlay]").prop("hidden", true);
      }
    }, 200);
    $("[data-states-open]").trigger("focus");
  }

  function closeDetail() {
    var $drawer = $("[data-detail-drawer]");
    if ($drawer.attr("data-state") !== "open") return;
    $drawer.attr("data-state", "closed").attr("aria-hidden", "true");
    $("[data-detail-overlay]").attr("data-state", "closed");
    window.setTimeout(function () {
      if ($("[data-detail-overlay]").attr("data-state") === "closed") {
        $("[data-detail-overlay]").prop("hidden", true);
      }
    }, 200);
    $("[data-card]").attr("aria-selected", "false");
  }

  /* ------------------------------------------------------- I2 · move menu - */

  function closeMoveMenu() {
    $("[data-move-menu]").prop("hidden", true).removeAttr("style");
    $("[data-card-menu]").attr("aria-expanded", "false");
  }

  function openMoveMenu($button) {
    var $menu = $("[data-move-menu]");
    var $card = $button.closest("[data-card]");
    state.moveIdentifier = attr($card, "identifier");

    $menu.prop("hidden", false);
    var offset = $button.offset();
    var width = $menu.outerWidth();
    var left = Math.max(
      8,
      Math.min(
        offset.left + $button.outerWidth() - width,
        $(window).width() - width - 8
      )
    );
    $menu
      .css({
        position: "fixed",
        top: offset.top + $button.outerHeight() + 4 + "px",
        left: left + "px",
        zIndex: 70,
      })
      .find("[data-move-to]")
      .each(function () {
        var current = $(this).attr("data-move-to") === attr($card, "status");
        $(this).attr("aria-current", String(current));
      });

    $button.attr("aria-expanded", "true");
  }

  /* --------------------------------------------------------- I9/I10 · modal */

  /* A native <dialog> can only be opened through showModal()/close(), which
     jQuery has no equivalent for — hence the direct element calls below. */
  function openModal(selector) {
    var el = $(selector)[0];
    if (el && typeof el.showModal === "function" && !el.open) el.showModal();
    else if (el) el.setAttribute("open", "open");
  }

  function closeModal(selector) {
    var el = $(selector)[0];
    if (el && typeof el.close === "function") el.close();
  }

  function nextIdentifier(project) {
    var prefix = PROJECT_PREFIX[project] || "TD";
    var highest = 0;
    $("[data-card]").each(function () {
      var id = attr($(this), "identifier");
      if (id.indexOf(prefix + "-") === 0) {
        highest = Math.max(highest, numeric(id));
      }
    });
    return prefix + "-" + (highest + 1);
  }

  function newInternalId() {
    var stamp = String(new Date().getTime()).slice(-8);
    return "td_01HQ9" + stamp;
  }

  var PRI_GLYPH =
    '<svg class="td-pri-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
    '<rect x="2.5" y="2.5" width="7" height="7" rx="1"></rect>' +
    '<line x1="2" y1="6" x2="10" y2="6"></line></svg>';

  var ICON_RELATION =
    '<svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"></path></svg>';
  var ICON_ATTACH =
    '<svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M21 11 12.3 20a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 1 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 1 1-2.3-2.4l8.5-8.5"></path></svg>';
  var ICON_COMMENT =
    '<svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H8l-4 2.5V12A7.5 7.5 0 0 1 11.5 4.5h1A7.5 7.5 0 0 1 20 12Z"></path></svg>';
  var ICON_KEBAB =
    '<svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"></circle></svg>';
  var ICON_CLOSE =
    '<svg class="td-icon td-icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M6 6l12 12M18 6 6 18"></path></svg>';

  /* Builds the same hook-complete card markup as the static board. */
  function buildCard(task) {
    var $card = $('<article class="td-card" data-card draggable="true"></article>');
    $card.attr({
      "data-identifier": task.identifier,
      "data-id": task.internalId,
      "data-status": task.status,
      "data-priority": task.priority,
      "data-project": task.project,
      "data-assignee": task.assignee,
      "data-assignee-kind": task.kind,
      "data-labels": task.labels.join(","),
      "data-version": "v1",
      "data-comments": "0",
      "data-attachments": "0",
      "data-relations-parent": "0",
      "data-relations-blocks": "0",
      "data-relations-related": "0",
      "data-reporter": task.reporter,
      "data-done": String(task.status === "done"),
      "data-canceled": String(task.status === "canceled"),
    });

    var $stripe = $(
      '<span class="td-card-stripe" data-card-stripe aria-hidden="true"></span>'
    ).attr("title", statusLabel(task.status));
    $card.append($stripe);

    var $menu = $(
      '<button type="button" class="td-card-menu" data-card-menu aria-haspopup="menu" aria-expanded="false"></button>'
    )
      .attr("aria-label", text("card.move", task.identifier))
      .append(ICON_KEBAB);
    $card.append(
      $('<div class="td-card-top"></div>')
        .append(
          $('<span class="td-card-id" data-card-identifier></span>').text(
            task.identifier
          )
        )
        .append($menu)
    );

    $card.append(
      $('<button type="button" class="td-card-title" data-card-title></button>').text(
        task.title
      )
    );

    var $labels = $('<div class="td-card-labels" data-card-labels></div>');
    $.each(task.labels, function (index, label) {
      $labels.append(
        $('<span class="td-chip td-chip-label"></span>')
          .attr("data-label", label)
          .text(label)
      );
    });
    if (task.labels.length) $card.append($labels);

    var $priority = $('<span class="td-pri" data-card-priority role="img"></span>')
      .attr("aria-label", text("prop.priorityValue", priorityLabel(task.priority)))
      .attr("title", text("prop.priorityValue", priorityLabel(task.priority)))
      .append(PRI_GLYPH);

    var $avatar = $('<span class="td-avatar" data-card-assignee></span>')
      .attr("title", task.assignee)
      .text(monogram(task.assignee));

    var $badge = $('<span class="td-agent-badge" data-card-agent-badge hidden></span>');
    var $role = $('<span class="td-agent-role td-mono" data-card-agent-role hidden></span>')
      .attr("title", task.assignee)
      .text(task.assignee);
    if (task.kind === "agent") {
      $avatar.prop("hidden", true);
      $badge
        .prop("hidden", false)
        .attr("data-agent-platform", task.platform)
        .text(task.platform);
      $role.prop("hidden", false);
    }

    var $meta =
      '<span class="td-meta" data-card-relations hidden>' +
      '<span data-relation-parent hidden>' +
      ICON_RELATION +
      '<span class="td-mono">0</span></span>' +
      '<span data-relation-blocks hidden>' +
      ICON_RELATION +
      '<span class="td-mono">0</span></span>' +
      '<span data-relation-related hidden>' +
      ICON_RELATION +
      '<span class="td-mono">0</span></span></span>' +
      '<span class="td-meta" data-card-attachment-count hidden title="Attachments">' +
      ICON_ATTACH +
      '<span class="td-mono">0</span></span>' +
      '<span class="td-meta" data-card-comment-count hidden title="Comments">' +
      ICON_COMMENT +
      '<span class="td-mono">0</span></span>';

    $card.append(
      $('<div class="td-card-foot"></div>')
        .append($priority)
        .append($avatar)
        .append($badge)
        .append($role)
        .append($('<div class="td-card-foot-right"></div>').append($meta))
    );

    return $card;
  }

  function insertCard($card, status) {
    var $body = $('[data-column][data-status="' + status + '"] [data-column-body]');
    if (!$body.length) return false;
    var $empty = $body.find('[data-empty][data-empty-kind="column"]');
    if ($empty.length) {
      $empty.before($card);
    } else {
      $body.append($card);
    }
    return true;
  }

  function setProject(project, announce) {
    state.project = project;
    $("[data-project-current]").text(project);

    $("[data-project-option]").each(function () {
      var $option = $(this);
      if ($option.attr("data-project-option") === project) {
        $option.attr("aria-current", "true");
      } else {
        $option.removeAttr("aria-current");
      }
    });

    $("[data-project-list] [data-project]").each(function () {
      var $item = $(this);
      if ($item.attr("data-project") === project) {
        $item.attr("aria-current", "page");
      } else {
        $item.removeAttr("aria-current");
      }
    });

    applyFilters();

    if (announce) {
      toast(text("toast.projectSwitched") + " " + project, "info");
    }
  }

  /* ---------------------------------------------------- clipboard helper -- */

  /* Clipboard writes need the Selection API and document.execCommand, which
     have no jQuery equivalent — used only here, with a throwaway helper node. */
  function copyText(value) {
    if (!value) return;
    var helper = document.createElement("textarea");
    helper.value = value;
    helper.setAttribute("readonly", "readonly");
    document.body.appendChild(helper);
    helper.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(helper);
    toast(ok ? text("toast.copied") + ": " + value : value, ok ? "success" : "info");
  }

  /* =========================================================== bindings === */

  $(function () {
    /* I7 · view toggle ----------------------------------------------------- */
    $("[data-view-toggle]").on("click", "[data-view]", function () {
      setView($(this).attr("data-view"));
    });

    $("[data-nav]").on("click", "[data-nav-item]", function () {
      var name = $(this).attr("data-nav-item");
      if (name === "board" || name === "list") {
        setView(name);
        return;
      }
      var $count = $("[data-filter-count]");
      toast(
        text("toast.activity") +
          " " +
          $("[data-revision-value]").text() +
          " · " +
          $count.text(),
        "info"
      );
    });

    /* B04 · filters -------------------------------------------------------- */
    var debouncedFilter = function () {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(applyFilters, 150);
    };

    $("[data-search]").on("input", "[data-search-input]", debouncedFilter);
    $("[data-filters]").on(
      "change",
      "[data-filter-assignee], [data-filter-priority], [data-filter-label]",
      applyFilters
    );
    $(document).on("click", "[data-filter-clear]", function () {
      resetFilters();
      toast(text("toast.filtersCleared"), "info");
    });
    $("[data-filter-toggle]").on("click", function () {
      var $button = $(this);
      var open = $button.attr("aria-pressed") !== "true";
      $button.attr("aria-pressed", String(open));
      $("[data-filters]").prop("hidden", !open);
    });

    /* I8 · project switching ---------------------------------------------- */
    $("[data-project-switcher]").on("click", "[data-project-option]", function () {
      $("[data-project-switcher]").removeAttr("open");
      setProject($(this).attr("data-project-option"), true);
    });
    $("[data-project-list]").on("click", "[data-project]", function () {
      setProject($(this).attr("data-project"), true);
    });

    /* I3 · open detail (card body, or the title button inside it) --------- */
    $("[data-board], [data-list]").on("click", "[data-card]", function (event) {
      if ($(event.target).closest("[data-card-menu], [data-move-menu]").length) {
        return;
      }
      openDetail($(this));
    });

    /* I4 · close detail ---------------------------------------------------- */
    $("[data-detail-close]").on("click", closeDetail);
    $("[data-detail-overlay]").on("click", closeDetail);

    $(document).on("keydown", function (event) {
      if (event.key === "Escape" || event.key === "Esc") {
        closeMoveMenu();
        closeLangMenu();
        closeDetail();
        closeStates();
        closeAccess();
      }
    });

    /* B18 · states showcase ------------------------------------------------ */
    $("[data-states-open]").on("click", openStates);
    $("[data-states-close]").on("click", closeStates);
    $("[data-states-overlay]").on("click", closeStates);

    /* I11 · theme (left footer cell) -------------------------------------- */

    /* A switch, not a chooser: the press applies the other theme to the
       document, the glyph and the cell's own name at once — there is no
       intermediate surface and nothing to dismiss. `applyTheme` writes the
       label, so the cell and the document agree the moment this runs. */
    $("[data-theme-switch]").on("click", function () {
      var dark = $("html").attr("data-theme") !== "dark";
      applyTheme(dark);
      toast(dark ? text("toast.themeDark") : text("toast.themeLight"), "info");
    });

    /* Language (centre footer cell) — a dropdown, not a chooser ------------ */

    /* The trigger toggles the menu the same way a card kebab does; the menu
       floats above the cell, so it is never clipped by the scrolling rail. */
    $("[data-lang-select]").on("click", function () {
      closeMoveMenu();
      if ($(this).attr("aria-expanded") === "true") closeLangMenu();
      else openLangMenu($(this));
    });

    /* `setLang` runs the document-wide pass, which also rewrites the short name
       in the middle footer cell. Choosing closes the menu either way; picking
       the language already in force is a no-op in `setLang`, so it reports
       nothing — there is no switch to announce. */
    $("[data-lang-menu]").on("click", "[data-lang-option]", function () {
      closeLangMenu();
      setLang($(this).attr("data-lang-option"));
    });

    /* B19 · access + token settings ---------------------------------------- */
    $("[data-access-open]").on("click", openAccess);
    $("[data-access-close]").on("click", closeAccess);
    $("[data-access-overlay]").on("click", closeAccess);

    $("[data-token-reveal]").on("click", function () {
      state.token.revealed = !state.token.revealed;
      renderToken();
    });

    /* Announced, not performed: the prototype reports the action in a toast
       and never touches the clipboard. */
    $("[data-token-copy]").on("click", function () {
      toast(text("toast.tokenCopied"), "success");
    });

    $("[data-token-reset]").on("click", function () {
      state.token.value = newToken();
      state.token.revealed = true;
      renderToken();
      toast(text("toast.tokenReset"), "success");
    });

    /* CIDR whitelist — a front-end-only list. Add appends an empty row and puts
       the caret in it; remove drops the row it belongs to. Neither touches
       anything outside the DOM. */
    $("[data-cidr-add]").on("click", function () {
      var $row = cidrRow("");
      $("[data-cidr-list]").append($row);
      $row.find("[data-cidr-value]").trigger("focus");
    });

    $("[data-cidr-list]").on("click", "[data-cidr-remove]", function () {
      $(this).closest("[data-cidr-row]").remove();
    });

    /* B17 · error state — Retry re-runs the real render pass */
    $("[data-error-retry]").on("click", function () {
      applyFilters();
      toast(text("toast.reloaded"), "success");
    });

    /* I2 · card menu → move ------------------------------------------------- */
    $("[data-board]").on("click", "[data-card-menu]", function (event) {
      event.stopPropagation();
      closeMoveMenu();
      /* the press stops propagating, so the document handler below never gets
         the chance to shut the other floating menu */
      closeLangMenu();
      openMoveMenu($(this));
    });

    $("[data-move-menu]").on("click", "[data-move-to]", function () {
      var status = $(this).attr("data-move-to");
      var $card = $(
        '[data-card][data-identifier="' + state.moveIdentifier + '"]'
      );
      closeMoveMenu();
      moveCard($card, status, true);
    });

    /* Both menus float away from the control that opened them, so both close on
       a press that lands outside themselves and their triggers. */
    $(document).on("click", function (event) {
      if (
        !$(event.target).closest(
          "[data-move-menu], [data-card-menu], [data-lang-menu], [data-lang-select]"
        ).length
      ) {
        closeMoveMenu();
        closeLangMenu();
      }
    });

    /* I1 · drag and drop --------------------------------------------------- */
    $("[data-board]").on("dragstart", "[data-card]", function (event) {
      var original = event.originalEvent;
      var $card = $(this);
      state.moveIdentifier = attr($card, "identifier");
      $card.attr("data-dragging", "true");
      if (original && original.dataTransfer) {
        original.dataTransfer.effectAllowed = "move";
        original.dataTransfer.setData("text/plain", state.moveIdentifier);
      }
    });

    $("[data-board]").on("dragend", "[data-card]", function () {
      $(this).removeAttr("data-dragging");
      $("[data-column]").removeAttr("data-drag-over");
      $("[data-drop-placeholder]").remove();
    });

    $("[data-board]").on("dragover", "[data-column-body]", function (event) {
      event.preventDefault();
      var original = event.originalEvent;
      var $body = $(this);
      if (original && original.dataTransfer) {
        original.dataTransfer.dropEffect = "move";
      }
      $("[data-column]").not($body.closest("[data-column]")).removeAttr("data-drag-over");
      $body.closest("[data-column]").attr("data-drag-over", "true");
      if (!$body.find("[data-drop-placeholder]").length) {
        $body.append('<div class="td-drop-placeholder" data-drop-placeholder></div>');
      }
    });

    $("[data-board]").on("dragleave", "[data-column-body]", function (event) {
      var original = event.originalEvent;
      if (original && original.relatedTarget && $.contains(this, original.relatedTarget)) {
        return;
      }
      $(this).closest("[data-column]").removeAttr("data-drag-over");
      $(this).find("[data-drop-placeholder]").remove();
    });

    $("[data-board]").on("drop", "[data-column-body]", function (event) {
      event.preventDefault();
      var $body = $(this);
      var original = event.originalEvent;
      var identifier =
        state.moveIdentifier ||
        (original && original.dataTransfer
          ? original.dataTransfer.getData("text/plain")
          : "");

      $("[data-column]").removeAttr("data-drag-over");
      $("[data-drop-placeholder]").remove();

      moveCard(
        $('[data-card][data-identifier="' + identifier + '"]'),
        $body.closest("[data-column]").attr("data-status"),
        true
      );
    });

    /* I5 · comment --------------------------------------------------------- */
    $("[data-comment-form]").on("submit", function (event) {
      event.preventDefault();
      var $form = $(this);
      var $input = $form.find("[data-comment-input]");
      var body = $.trim(String($input.val() || ""));
      if (!body) {
        $input.trigger("focus");
        return;
      }

      var $comment = $('<article class="td-comment"></article>');
      $comment.append(
        $('<span class="td-avatar"></span>').text(monogram(ME))
      );
      $comment.append(
        $("<div></div>")
          .append(
            $('<div class="td-comment-meta"></div>')
              .append(
                $('<span class="font-medium text-td-ink"></span>').text(ME)
              )
              .append(
                $("<span></span>")
                  .attr("data-i18n", "comment.human")
                  .text(text("comment.author"))
              )
              .append(
                $('<span class="td-mono"></span>').text(text("comment.now"))
              )
          )
          .append($('<div class="td-comment-body"></div>').text(body))
      );

      $("[data-detail-comments]").prepend($comment);
      $input.val("");

      var identifier = $("[data-detail-identifier]").text();
      var $card = $('[data-card][data-identifier="' + identifier + '"]');
      if ($card.length) {
        var count = parseInt(attr($card, "comments"), 10) + 1;
        if (isNaN(count)) count = 1;
        $card.attr("data-comments", count);
        $card
          .find("[data-card-comment-count]")
          .prop("hidden", false)
          .find(".td-mono")
          .text(count);
      }

      toast(text("toast.commented"), "success");
      bumpRevision();
    });

    /* I9 · create task ----------------------------------------------------- */
    $("[data-new-task]").on("click", function () {
      $("[data-create-task-project]").val(state.project);
      openModal("[data-create-task]");
    });

    $("[data-board]").on("click", "[data-column-add]", function () {
      var status = $(this).closest("[data-column]").attr("data-status");
      $("[data-create-task-status]").val(status);
      $("[data-create-task-project]").val(state.project);
      openModal("[data-create-task]");
    });

    $("[data-create-task-form]").on("submit", function (event) {
      event.preventDefault();
      var $form = $(this);
      var title = $.trim(String($form.find("[data-create-task-title]").val() || ""));
      if (!title) {
        $form.find("[data-create-task-title]").trigger("focus");
        return;
      }

      var $assignee = $form.find("[data-create-task-assignee] option:selected");
      var status = $form.find("[data-create-task-status]").val();
      var project = $form.find("[data-create-task-project]").val();

      var task = {
        identifier: nextIdentifier(project),
        internalId: newInternalId(),
        title: title,
        status: status,
        priority: $form.find("[data-create-task-priority]").val(),
        assignee: $assignee.val(),
        kind: $assignee.attr("data-assignee-kind") || "human",
        platform: $assignee.attr("data-agent-platform") || "",
        reporter: ME,
        project: project,
        labels: [],
      };

      var $card = buildCard(task);
      var placed = insertCard($card, status);

      closeModal("[data-create-task]");
      /* jQuery has no form-reset equivalent, so the native method is used. */
      $form[0].reset();
      $("[data-create-task-project]").val(state.project);
      $("[data-create-task-status]").val("backlog");
      $("[data-create-task-priority]").val("none");

      if (!placed) return;
      applyFilters();
      toast(text("toast.created") + " " + task.identifier, "success");
      bumpRevision();
    });

    /* I10 · create project ------------------------------------------------- */
    $("[data-project-switcher]").on("click", "[data-project-new]", function () {
      $("[data-project-switcher]").removeAttr("open");
      openModal("[data-create-project]");
    });

    $("[data-create-project-form]").on("submit", function (event) {
      event.preventDefault();
      var $form = $(this);
      var name = $.trim(String($form.find("[data-create-project-name]").val() || ""));
      var prefix = $.trim(
        String($form.find("[data-create-project-prefix]").val() || "")
      ).toUpperCase();
      if (!name || !prefix) {
        $form.find("[data-create-project-name]").trigger("focus");
        return;
      }

      var $entry = $(
        '<button type="button" class="td-side-item" data-project></button>'
      )
        .attr("data-project", name)
        .append($('<span class="td-side-name td-mono"></span>').text(name))
        .append($('<span class="td-count" data-project-count></span>').text("0"));
      $("[data-project-list]").append($entry);

      var $option = $(
        '<li><button type="button" data-project-option></button></li>'
      );
      $option
        .find("button")
        .attr("data-project-option", name)
        .append($('<span class="td-mono"></span>').text(name));
      $("[data-project-switcher] .menu [data-project-new]")
        .closest("li")
        .before($option);

      $("[data-create-task-project]").append(
        $("<option></option>").attr("value", name).text(name)
      );
      PROJECT_PREFIX[name] = prefix;

      closeModal("[data-create-project]");
      /* jQuery has no form-reset equivalent, so the native method is used. */
      $form[0].reset();
      setProject(name, false);
      toast(text("toast.projectCreated") + " " + name, "success");
    });

    /* modals — the Cancel buttons close their own dialog ------------------- */
    $("[data-create-task]").on("click", "[data-modal-close]", function () {
      closeModal("[data-create-task]");
    });
    $("[data-create-project]").on("click", "[data-modal-close]", function () {
      closeModal("[data-create-project]");
    });

    /* detail extras -------------------------------------------------------- */
    $("[data-detail-id-copy]").on("click", function () {
      copyText($(this).attr("data-copy-value"));
    });

    $("[data-detail-drawer]").on("click", "[data-agent-session-id]", function () {
      copyText($.trim($(this).text()));
    });

    $("[data-detail-drawer]").on("click", "[data-agent-resume]", function () {
      toast(text("toast.resume"), "info");
    });

    $("[data-detail-drawer]").on("click", "[data-relation-link]", function () {
      var identifier = $.trim($(this).text());
      var $card = $('[data-card][data-identifier="' + identifier + '"]');
      if ($card.length) {
        openDetail($card);
        toast(text("toast.linked") + " " + identifier, "info");
      } else {
        toast(identifier, "info");
      }
    });

    /* list rows open the same drawer -------------------------------------- */
    $("[data-list]").on("click", "[data-list-row]", function () {
      var $card = $(
        '[data-card][data-identifier="' + $(this).attr("data-identifier") + '"]'
      );
      if ($card.length) openDetail($card);
    });

    /* ---------------------------------------------------------- first pass */
    $("[data-detail-overlay]").prop("hidden", true);
    $("[data-detail-drawer]").attr("aria-hidden", "true");
    $("[data-states-overlay]").prop("hidden", true);
    $("[data-states-panel]").attr("aria-hidden", "true");
    $("[data-access-overlay]").prop("hidden", true);
    $("[data-access-panel]").attr("aria-hidden", "true");
    $("[data-lang-menu]").prop("hidden", true);

    /* The stand-in token is minted once per load, then rendered masked. */
    state.token.value = newToken();
    /* applyLang re-renders the generated copy and finishes with a filter pass,
       so the English default and the derived counts settle together. */
    applyLang("en");
  });
})(jQuery);
