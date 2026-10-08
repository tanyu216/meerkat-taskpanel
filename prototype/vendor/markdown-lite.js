/* ============================================================================
   markdown-lite.js — a minimal, dependency-free Markdown → HTML renderer.
   ----------------------------------------------------------------------------
   Vendor provenance: written for this prototype and vendored as a local file.
   It is loaded with a plain <script> tag from prototype/vendor/. Like every
   other vendor file here it makes no network request, reads no storage and
   ships no CDN reference — the prototype must render its preview offline.

   Scope: the GFM subset the `.td-gfm` stylesheet in src/input.css already
   knows how to dress — headings, paragraphs, fenced code, blockquotes, rules,
   ordered / unordered / task lists, tables, and the inline emphasis, code,
   link and autolink forms. Anything outside that subset is escaped and shown
   literally rather than dropped, so the preview never silently loses text.

   Public surface (one global):
     MarkdownLite.render(source, options) → html string
       options.highlight(code, language) → html   (optional; used for fences)
     MarkdownLite.escape(text) → html-escaped string
   ========================================================================== */
(function (root) {
  "use strict";

  var NAMED = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value).replace(
      /[&<>"']/g,
      function (ch) {
        return NAMED[ch];
      }
    );
  }

  /* Only the two schemes a preview can safely link to. Everything else keeps
     its text and loses its href, so a `javascript:` target can never be
     clicked through from the rendered pane. */
  function safeUrl(url) {
    var value = String(url).trim();
    return /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(value) ? value : "";
  }

  /* ----------------------------------------------------------- inline ---- */

  /* Code spans are lifted out first so the emphasis passes below can never
     reach inside them; they are re-inserted once the rest of the inline pass
     has run. A NUL byte is the placeholder because it cannot occur in the
     escaped output. */
  function inline(text, options) {
    var store = [];
    var out = String(text);

    out = out.replace(/`([^`]+)`/g, function (match, code) {
      store.push("<code>" + escapeHtml(code) + "</code>");
      return "\u0000" + (store.length - 1) + "\u0000";
    });

    out = escapeHtml(out);

    /* images before links — the syntax differs by exactly one `!` */
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (
      match,
      alt,
      url,
      title
    ) {
      var href = safeUrl(url);
      if (!href) return escapeHtml(match);
      return (
        '<img src="' +
        escapeHtml(href) +
        '" alt="' +
        escapeHtml(alt) +
        '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : "") +
        ">"
      );
    });

    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (
      match,
      label,
      url,
      title
    ) {
      var href = safeUrl(url);
      if (!href) return escapeHtml(match);
      return (
        '<a href="' +
        escapeHtml(href) +
        '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : "") +
        ">" +
        label +
        "</a>"
      );
    });

    /* bare autolinks and raw <…> autolinks */
    out = out.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, function (
      match,
      url
    ) {
      return '<a href="' + url + '">' + url + "</a>";
    });

    out = out
      .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");

    /* a backslash before punctuation is an escape: drop the backslash */
    out = out.replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, "$1");

    out = out.replace(/\u0000(\d+)\u0000/g, function (match, index) {
      return store[Number(index)];
    });

    return out;
  }

  /* ------------------------------------------------------------ blocks ---- */

  var RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  var RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
  var RE_BULLET = /^(\s*)([-*+])\s+(.*)$/;
  var RE_ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
  var RE_TABLE_DIV = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    var trimmed = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
    var cells = [];
    var current = "";
    var escaped = false;
    for (var i = 0; i < trimmed.length; i++) {
      var ch = trimmed.charAt(i);
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "|") {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  }

  function alignments(line) {
    return splitRow(line).map(function (cell) {
      var value = cell.trim();
      var left = value.charAt(0) === ":";
      var right = value.charAt(value.length - 1) === ":";
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
  }

  function cellAttribute(align) {
    return align ? ' style="text-align: ' + align + '"' : "";
  }

  /* A list item carries its own continuation lines, already de-indented. */
  function renderList(items, ordered, options) {
    var html = ordered ? "<ol>\n" : "<ul>\n";
    items.forEach(function (item) {
      var task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(item.text);
      var body;
      if (task) {
        html += '<li class="td-task-item">';
        body =
          '<span class="td-check" data-checked="' +
          (task[1].toLowerCase() === "x" ? "true" : "false") +
          '" aria-hidden="true"></span>' +
          inline(task[2], options);
      } else {
        html += "<li>";
        body = inline(item.text, options);
      }
      html += body + blockTail(item.rest, options) + "</li>\n";
    });
    return html + (ordered ? "</ol>\n" : "</ul>\n");
  }

  /* Nested blocks inside a list item are rare in this prototype; the item's
     remaining lines are rendered as a paragraph so nothing is lost. */
  function blockTail(lines, options) {
    var text = lines.join("\n").trim();
    return text ? "<p>" + inline(text, options) + "</p>" : "";
  }

  function render(source, options) {
    var opts = options || {};
    var lines = String(source === undefined || source === null ? "" : source)
      .replace(/\r\n?/g, "\n")
      .split("\n");
    var html = "";
    var i = 0;

    function flushParagraph(buffer) {
      if (!buffer.length) return;
      var text = buffer.join("\n").replace(/ {2,}\n/g, "<br>\n");
      html += "<p>" + inline(text, opts).replace(/\n/g, "\n") + "</p>\n";
      buffer.length = 0;
    }

    var paragraph = [];

    while (i < lines.length) {
      var line = lines[i];

      /* blank — closes whatever block was open */
      if (!line.trim()) {
        flushParagraph(paragraph);
        i++;
        continue;
      }

      /* fenced code ---------------------------------------------------- */
      var fence = RE_FENCE.exec(line);
      if (fence) {
        flushParagraph(paragraph);
        var marker = fence[2].charAt(0);
        var indent = fence[1].length;
        var language = fence[3] || "";
        var code = [];
        i++;
        while (i < lines.length) {
          var close = RE_FENCE.exec(lines[i]);
          if (
            close &&
            close[2].charAt(0) === marker &&
            close[2].length >= fence[2].length &&
            close[1].length <= indent
          ) {
            i++;
            break;
          }
          code.push(lines[i]);
          i++;
        }
        var raw = code.join("\n");
        var body =
          typeof opts.highlight === "function"
            ? opts.highlight(raw, language)
            : escapeHtml(raw);
        html +=
          '<pre><code class="language-' +
          escapeHtml(language || "text") +
          '">' +
          body +
          "</code></pre>\n";
        continue;
      }

      /* horizontal rule ------------------------------------------------ */
      if (RE_RULE.test(line)) {
        flushParagraph(paragraph);
        html += "<hr>\n";
        i++;
        continue;
      }

      /* heading -------------------------------------------------------- */
      var heading = RE_HEADING.exec(line);
      if (heading) {
        flushParagraph(paragraph);
        var level = Math.max(4, heading[1].length); /* titles cap at h4 */
        html +=
          "<h" +
          level +
          ">" +
          inline(heading[2], opts) +
          "</h" +
          level +
          ">\n";
        i++;
        continue;
      }

      /* blockquote — consumes its own lines, then recurses -------------- */
      if (RE_QUOTE.test(line)) {
        flushParagraph(paragraph);
        var quoted = [];
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || !lines[i].trim())) {
          if (!lines[i].trim() && !RE_QUOTE.test(lines[i + 1] || "")) break;
          quoted.push((RE_QUOTE.exec(lines[i]) || [null, ""])[1]);
          i++;
        }
        html += "<blockquote>\n" + render(quoted.join("\n"), opts) + "</blockquote>\n";
        continue;
      }

      /* table ---------------------------------------------------------- */
      if (
        line.indexOf("|") !== -1 &&
        RE_TABLE_DIV.test(lines[i + 1] || "")
      ) {
        flushParagraph(paragraph);
        var aligns = alignments(lines[i + 1]);
        var head = splitRow(line);
        html += "<table>\n<thead>\n<tr>";
        head.forEach(function (cell, index) {
          html +=
            "<th" +
            cellAttribute(aligns[index]) +
            ">" +
            inline(cell.trim(), opts) +
            "</th>";
        });
        html += "</tr>\n</thead>\n<tbody>\n";
        i += 2;
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) {
          var row = splitRow(lines[i]);
          html += "<tr>";
          for (var c = 0; c < head.length; c++) {
            html +=
              "<td" +
              cellAttribute(aligns[c]) +
              ">" +
              inline((row[c] || "").trim(), opts) +
              "</td>";
          }
          html += "</tr>\n";
          i++;
        }
        html += "</tbody>\n</table>\n";
        continue;
      }

      /* lists ---------------------------------------------------------- */
      var bullet = RE_BULLET.exec(line);
      var ordered = RE_ORDERED.exec(line);
      if (bullet || ordered) {
        flushParagraph(paragraph);
        var isOrdered = Boolean(ordered);
        var items = [];
        while (i < lines.length) {
          var currentBullet = RE_BULLET.exec(lines[i]);
          var currentOrdered = RE_ORDERED.exec(lines[i]);
          var match = isOrdered ? currentOrdered : currentBullet;
          if (!match) break;
          var rest = [];
          i++;
          while (
            i < lines.length &&
            lines[i].trim() &&
            !RE_BULLET.test(lines[i]) &&
            !RE_ORDERED.test(lines[i]) &&
            !RE_FENCE.test(lines[i]) &&
            !RE_HEADING.test(lines[i]) &&
            !RE_RULE.test(lines[i])
          ) {
            rest.push(lines[i].replace(/^\s{1,4}/, ""));
            i++;
          }
          items.push({ text: match[3], rest: rest });
        }
        html += renderList(items, isOrdered, opts);
        continue;
      }

      /* paragraph ------------------------------------------------------ */
      paragraph.push(line);
      i++;
    }

    flushParagraph(paragraph);
    return html;
  }

  root.MarkdownLite = { render: render, escape: escapeHtml };
})(window);
