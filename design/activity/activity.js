/* =====================================================================
   B26 · Activity view — interaction layer
   ---------------------------------------------------------------------
   Three rules shape this file.

   1 · It only enhances. Every row, day group, empty state and <details> is
       already in prototype.html, so the document reads correctly with this
       script switched off (blocked, 404ing, or disabled in the browser) —
       which is exactly what the 22-activity-nojs capture shows.

   2 · It touches no network. The catalogue is inline markup, the relative
       times are measured against a fixed reference instant rather than the
       wall clock, and nothing is fetched. Reopening the file a week from now
       renders the same board it renders today.

   3 · It is a prototype, not a product. The shapes it writes are the shapes
       the E2 card has to write (see DESIGN-activity.md §交付边界), so a
       reader can diff this file against the real implementation.
   ===================================================================== */
(function () {
  "use strict";

  var $ = window.jQuery;

  /* The one instant the whole feed is relative to. A prototype reading
     `Date.now()` would print a different board every morning and would make
     every capture irreproducible; a fixed "now" is the honest choice for a
     design artefact. 09:51Z is nine minutes after the newest entry. */
  var REFERENCE_NOW = Date.parse("2026-10-13T09:51:00Z");

  var DAY_MS = 86400000;

  var state = {
    lang: "en",
    filters: { actor: "all", event: "all", task: "all" },
    page: 1,
    unread: 0,
    shown: 0
  };

  var catalogue = { en: {}, zh: {} };

  /* ------------------------------------------------------------- i18n -- */

  function readCatalogue() {
    var el = document.querySelector("[data-activity-i18n]");
    if (!el) return;
    try {
      var parsed = JSON.parse(el.textContent);
      catalogue.en = parsed.en || {};
      catalogue.zh = parsed.zh || {};
    } catch (err) {
      /* A broken catalogue must not blank the page: the markup already holds
         the English, which is the same floor a script-less reader gets. */
      catalogue = { en: {}, zh: {} };
    }
  }

  /* Looks a key up in the active language, then in English, then returns the
     key itself — the same three-step fallback app.js uses, so a missing
     translation degrades to visible copy rather than to an empty string. */
  function t(key, arg) {
    var table = catalogue[state.lang] || catalogue.en;
    var value = table[key];
    if (value === undefined) value = catalogue.en[key];
    if (value === undefined) return key;
    if (arg !== undefined && arg !== null) value = value.replace("%s", arg);
    return value;
  }

  /* `data-i18n-arg` is resolved as a key first and as a literal second, so
     `activity.open` + `TD-128` fills in the identifier untouched while
     `column.add` + `status.todo` would fill in a translation. */
  function argFor($el) {
    var arg = $el.attr("data-i18n-arg");
    if (arg === undefined) return undefined;
    var table = catalogue[state.lang] || catalogue.en;
    if (table[arg] !== undefined || catalogue.en[arg] !== undefined) return t(arg);
    return arg;
  }

  function applyI18n(scope) {
    var $scope = scope ? $(scope) : $(document);
    $scope.find("[data-i18n]").addBack("[data-i18n]").each(function () {
      var $el = $(this);
      $el.text(t($el.attr("data-i18n"), argFor($el)));
    });
    $scope.find("[data-i18n-placeholder]").each(function () {
      var $el = $(this);
      $el.attr("placeholder", t($el.attr("data-i18n-placeholder"), argFor($el)));
    });
    $scope.find("[data-i18n-aria-label]").each(function () {
      var $el = $(this);
      $el.attr("aria-label", t($el.attr("data-i18n-aria-label"), argFor($el)));
    });
    $scope.find("[data-i18n-title]").each(function () {
      var $el = $(this);
      $el.attr("title", t($el.attr("data-i18n-title"), argFor($el)));
    });
  }

  /* -------------------------------------------------------- time copy -- */

  /* Each `[data-activity-at]` carries the absolute instant in `datetime` and
     the absolute string in `title`; the visible cell is the relative form.
     Recomputed rather than hard-coded so a language switch re-words it. */
  function relativeTime(iso) {
    var ms = Date.parse(iso);
    if (isNaN(ms)) return "";
    var mins = Math.max(0, Math.round((REFERENCE_NOW - ms) / 60000));
    if (mins < 1) return t("time.minutesAgo", 1);
    if (mins < 60) return t("time.minutesAgo", mins);
    var hours = Math.round(mins / 60);
    if (hours < 24) return t("time.hoursAgo", hours);
    return t("time.daysAgo", Math.round((REFERENCE_NOW - ms) / DAY_MS));
  }

  function applyTimes() {
    $("[data-activity-at]").each(function () {
      var $el = $(this);
      $el.text(relativeTime($el.attr("datetime")));
    });
  }

  /* The two oldest day headings are absolute dates rather than "Today" /
     "Yesterday", so they are formatted by the platform instead of sitting in
     the catalogue — there is no sentence to translate, only a date to
     localise. */
  function applyDayLabels() {
    $('[data-activity-day-kind="absolute"] time').each(function () {
      var $el = $(this);
      var ms = Date.parse($el.attr("datetime") + "T12:00:00Z");
      if (isNaN(ms)) return;
      try {
        $el.text(
          new Intl.DateTimeFormat(state.lang === "zh" ? "zh-CN" : "en-US", {
            weekday: "long",
            month: "short",
            day: "numeric"
          }).format(new Date(ms))
        );
      } catch (err) {
        /* An engine without Intl keeps the English date already in the
           markup — degraded, never blank. */
      }
    });
  }

  /* ---------------------------------------------------------- filters -- */

  function rows() {
    return $("[data-activity-row]");
  }

  function pageOf($row) {
    return Number($row.closest("[data-activity-day]").attr("data-activity-page") || 1);
  }

  /* Which events the three event-filter values address. Everything else is
     the backdrop: the filter answers "what changed state / what was said /
     what was delivered" and nothing more, so the rest shows under
     `All events` alone. DESIGN-activity.md §信息选择 carries the same
     table between the allow-list and the control. */
  var EVENT_GROUPS = { status: "status", comment: "comment", delivery: "delivery" };

  function matchesFilters($row) {
    var f = state.filters;
    if (f.actor !== "all" && $row.attr("data-assignee-kind") !== f.actor) return false;
    if (f.event !== "all" && $row.attr("data-activity-group") !== EVENT_GROUPS[f.event]) return false;
    if (f.task !== "all" && $row.attr("data-task") !== f.task) return false;
    return true;
  }

  function applyFilters() {
    var shown = 0;
    var unread = 0;

    rows().each(function () {
      var $row = $(this);
      var ok = pageOf($row) <= state.page && matchesFilters($row);
      if (ok) {
        shown += 1;
        if ($row.is("[data-activity-unread]")) unread += 1;
      }
      $row.attr("hidden", ok ? null : "hidden");
    });

    /* A day group with nothing left in it goes too — an empty "Today"
       heading reads as a bug, not as an empty day. */
    $("[data-activity-day]").each(function () {
      var $day = $(this);
      var revealed = Number($day.attr("data-activity-page") || 1) <= state.page;
      var any = $day.find("[data-activity-row]").filter(function () {
        return matchesFilters($(this));
      }).length;
      $day.attr("hidden", revealed && any > 0 ? null : "hidden");
    });

    state.shown = shown;
    applyUnread(unread);
    applyEmptyStates(shown);
  }

  function applyEmptyStates(shown) {
    var admissible = rows().length;
    $('[data-activity-empty][data-activity-empty-kind="project"]').attr(
      "hidden",
      admissible === 0 ? null : "hidden"
    );
    $('[data-activity-empty][data-activity-empty-kind="filter"]').attr(
      "hidden",
      admissible > 0 && shown === 0 ? null : "hidden"
    );

    var $count = $("[data-activity-filter-count]");
    $count.attr("data-i18n-arg", String(shown));
    $count.text(t("activity.filter.count", shown));

    refreshFoot();
  }

  /* `Load older` is offered only when there is both another page and a log
     to extend. A project with no events at all has nothing older to load,
     and a button that promises otherwise is the same lie the dead Activity
     nav item told. Under a *filter* that matches nothing the button stays:
     the match may be sitting on the unloaded page. */
  function refreshFoot() {
    var more = $('[data-activity-day][data-activity-page="' + (state.page + 1) + '"]').length > 0;
    $(".td-activity-foot").attr("hidden", more && rows().length > 0 ? null : "hidden");
  }

  function readFilters() {
    $("[data-activity-filter]").each(function () {
      var $el = $(this);
      var name = $el.attr("data-activity-filter");
      if (state.filters[name] !== undefined) state.filters[name] = $el.val();
    });
  }

  function syncControls() {
    ["actor", "event", "task"].forEach(function (name) {
      $('[data-activity-filter="' + name + '"]').val(state.filters[name]);
    });
  }

  function writeHash() {
    var parts = [];
    ["actor", "event", "task"].forEach(function (name) {
      if (state.filters[name] !== "all") {
        parts.push(name + "=" + encodeURIComponent(state.filters[name]));
      }
    });
    var hash = "#/activity" + (parts.length ? "?" + parts.join("&") : "");
    if (window.location.hash === hash) return;
    try {
      window.history.replaceState(null, "", hash);
    } catch (err) {
      window.location.hash = hash;
    }
  }

  function readHash() {
    var hash = window.location.hash || "";
    if (hash.indexOf("#/activity") !== 0) return;
    var qs = hash.indexOf("?") === -1 ? "" : hash.slice(hash.indexOf("?") + 1);
    if (!qs) return;
    qs.split("&").forEach(function (pair) {
      var bits = pair.split("=");
      var name = decodeURIComponent(bits[0]);
      var value = decodeURIComponent(bits[1] || "");
      if (state.filters[name] !== undefined && value) state.filters[name] = value;
    });
  }

  /* ----------------------------------------------------------- unread -- */

  /* One number, one meaning: the unread rows the reader can currently see.
     The sidebar pill, the feed's divider and its counter all read it, so the
     three cannot disagree — and when a filter hides the new rows, all three
     say so by going away rather than by showing a number with nothing under
     it. */
  function applyUnread(unread) {
    state.unread = unread;

    var $pill = $('[data-nav-count="activity"]');
    if ($pill.length) {
      $pill.text(String(unread));
      $pill.attr("data-i18n-arg", String(unread));
      $pill.attr("aria-label", t("activity.navCount", unread));
      /* At zero the pill is hidden — the rule `waiting` already follows. */
      $pill.attr("hidden", unread === 0 ? "hidden" : null);
    }

    var $divider = $("[data-activity-unread-divider]");
    if ($divider.length) {
      $divider.attr("hidden", unread === 0 ? "hidden" : null);
      $divider.find("[data-activity-unread-count]").text(String(unread));
    }
  }

  function markAllRead() {
    rows().removeAttr("data-activity-unread");
    applyFilters();
  }

  /* ------------------------------------------------------------- paging */

  function loadOlder() {
    var next = state.page + 1;
    if (!$('[data-activity-day][data-activity-page="' + next + '"]').length) return false;
    state.page = next;
    applyFilters();
    return true;
  }

  /* ------------------------------------------------------------- drawer */

  function openDrawer($row) {
    if (!$row || !$row.length) return false;
    var id = $row.attr("data-task");
    $("[data-detail-identifier]").text(id);
    $("[data-detail-title]").text($row.find("[data-activity-task-title]").text());

    /* The drawer's own Activity section is the task's history, drawn from the
       same feed the reader just clicked in. This proposal changes nothing
       about B09; the section is filled only so the row's "open" affordance
       lands somewhere rather than on an empty shell. */
    var $into = $("[data-detail-activity]").empty();
    rows().filter(function () {
      return $(this).attr("data-task") === id && $(this).attr("hidden") === undefined;
    }).each(function () {
      var $other = $(this);
      var sentenceKey = $other.find("[data-activity-sentence]").attr("data-i18n");
      $("<div>")
        .addClass("td-activity")
        .append(
          $("<span>")
            .addClass($other.attr("data-assignee-kind") === "agent" ? "font-medium td-mono" : "font-medium")
            .text($other.attr("data-actor")),
          $("<span>").text(sentenceKey ? t(sentenceKey) : ""),
          $("<span>")
            .addClass("td-activity-ts td-mono")
            .attr("title", $other.find("[data-activity-at]").attr("title"))
            .text(relativeTime($other.attr("data-at")))
        )
        .appendTo($into);
    });

    $("[data-detail-drawer]").attr("data-state", "open");
    $("[data-detail-overlay]").attr("data-state", "open").removeAttr("hidden");
    return true;
  }

  function closeDrawer() {
    $("[data-detail-drawer]").attr("data-state", "closed");
    $("[data-detail-overlay]").attr("data-state", "closed").attr("hidden", "hidden");
    return true;
  }

  /* ------------------------------------------------------------ keyboard */

  function focusableRows() {
    return $("[data-activity-open]").filter(function () {
      return !$(this).closest("[hidden]").length;
    });
  }

  function moveFocus(step, from) {
    var $focusable = focusableRows();
    if (!$focusable.length) return false;
    var index = $focusable.index(from);
    if (index === -1) index = step > 0 ? -1 : 0;
    var next = index + step;
    if (next < 0) next = $focusable.length - 1;
    if (next >= $focusable.length) next = 0;
    $focusable.eq(next).trigger("focus");
    return true;
  }

  /* -------------------------------------------------------------- boot -- */

  function query(name) {
    var m = window.location.search.match(new RegExp("[?&]" + name + "=([^&]+)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* Prototype-only switches. The shipped board reaches these two states from
     the sidebar footer (B03); this file ships no footer, so the capture
     script — and anyone reading the prototype by hand — sets them on the
     URL: `?theme=dark`, `?lang=zh`. Nothing else reads the URL, and with the
     script off the document rests on the light/no-record default. */
  function applyThemeParam() {
    var modes = { light: "meerkat-taskpanel", dark: "dark", auto: "auto" };
    var theme = query("theme");
    if (!theme || !modes[theme]) return;
    $("html").attr("data-theme", modes[theme]).attr("data-theme-mode", theme);
  }

  function setLang(lang) {
    state.lang = lang === "zh" ? "zh" : "en";
    $("html").attr("lang", state.lang === "zh" ? "zh-CN" : "en");
    applyI18n();
    applyTimes();
    applyDayLabels();
    applyFilters();
  }

  function wire() {
    $("[data-activity-filter]").on("change", function () {
      readFilters();
      writeHash();
      applyFilters();
    });

    $("[data-activity-filter-reset], [data-activity-empty-reset]").on("click", function () {
      state.filters = { actor: "all", event: "all", task: "all" };
      syncControls();
      writeHash();
      applyFilters();
    });

    $("[data-activity-mark-read]").on("click", markAllRead);
    $("[data-activity-more]").on("click", loadOlder);

    /* The row body is a pointer affordance; `[data-activity-open]` is its
       keyboard twin and carries the accessible name. A press on the task
       link or on the disclosure is left alone — neither is a request for
       this drawer. */
    $("[data-activity-line]").on("click", function (event) {
      if ($(event.target).closest("a, button, details, summary").length) return;
      openDrawer($(this).closest("[data-activity-row]"));
    });

    $("[data-activity-open]").on("click", function () {
      openDrawer($(this).closest("[data-activity-row]"));
    });

    $("[data-detail-close], [data-detail-overlay]").on("click", closeDrawer);

    $(document).on("keydown", function (event) {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      if ($(event.target).is("input, textarea, select")) return;
      if (moveFocus(event.key === "j" ? 1 : -1, $(event.target).closest("[data-activity-open]"))) {
        event.preventDefault();
      }
    });
  }

  $(function () {
    readCatalogue();
    applyThemeParam();
    readHash();
    syncControls();
    wire();
    setLang(query("lang") || "en");

    /* The check script and the capture script both drive the page through
       this handle rather than reaching into the DOM themselves. */
    window.tdActivity = {
      state: state,
      t: t,
      setLang: setLang,
      applyFilters: applyFilters,
      markAllRead: markAllRead,
      loadOlder: loadOlder,
      openDrawer: function (id) {
        var $row = rows().filter(function () {
          return $(this).attr("data-task") === id;
        }).first();
        return openDrawer($row);
      },
      closeDrawer: closeDrawer,
      relativeTime: relativeTime,
      referenceNow: REFERENCE_NOW
    };
  });
})();
