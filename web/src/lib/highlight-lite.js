/* ============================================================================
   highlight-lite.js — a minimal, dependency-free source highlighter.
   ----------------------------------------------------------------------------
   Vendor provenance: written for this prototype and vendored as a local file.
   Loaded with a plain <script> tag from prototype/vendor/; no network, no
   storage, no CDN, no eval.

   Two surfaces, both pure functions returning HTML:

     HighlightLite.code(source, language) → html
       Fenced-code highlighting for the Markdown preview. Languages:
       js / javascript, ts, json, css, html / xml, sh / bash / shell, py /
       python, and `md` / `markdown`. An unknown language is escaped and shown
       unhighlighted rather than guessed at.

     HighlightLite.markdown(source) → html
       Markdown *source* highlighting for the editor pane. Every character of
       the input is reproduced verbatim — only <span> wrappers are added — so
       the highlighted layer stays glyph-for-glyph aligned with the transparent
       <textarea> on top of it.

   Both escape their input: a fence's contents are never trusted as markup.
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

  function span(kind, text) {
    return '<span class="td-hl-' + kind + '">' + escapeHtml(text) + "</span>";
  }

  /* A single left-to-right pass driven by one alternation. Each rule is
     [regex, tokenClass]; the first rule that matches at the cursor wins, so
     ordering is the precedence. Anything unmatched is escaped as plain text. */
  function tokenize(source, rules) {
    var text = String(source === undefined || source === null ? "" : source);
    var out = "";
    var index = 0;

    while (index < text.length) {
      var matched = false;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        rule.re.lastIndex = index;
        var hit = rule.re.exec(text);
        if (hit && hit.index === index) {
          if (rule.cls) out += span(rule.cls, hit[0]);
          else out += escapeHtml(hit[0]);
          index += hit[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        out += escapeHtml(text.charAt(index));
        index++;
      }
    }
    return out;
  }

  function re(pattern) {
    return new RegExp(pattern, "y");
  }

  /* ------------------------------------------------------------ code ---- */

  var STRING = { re: re('"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`'), cls: "str" };
  var COMMENT_SLASH = { re: re("\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"), cls: "com" };
  var COMMENT_HASH = { re: re("#[^\\n]*"), cls: "com" };
  var NUMBER = { re: re("\\b\\d(?:[\\d_]*\\.?[\\d_]*)?(?:[eE][+-]?\\d+)?\\b"), cls: "num" };
  var KEYWORD = {
    re: re(
      "\\b(?:function|return|if|else|for|while|do|break|continue|var|let|const|new|typeof|instanceof|class|extends|super|this|try|catch|finally|throw|switch|case|default|in|of|delete|void|yield|async|await|export|import|from|true|false|null|undefined|interface|type|enum|public|private|readonly|static)\\b"
    ),
    cls: "key",
  };
  var BOOLEAN = { re: re("\\b(?:true|false|null|None|True|False)\\b"), cls: "num" };
  var CALL = { re: re("[A-Za-z_$][\\w$]*(?=\\()"), cls: "fn" };
  var PROPERTY = { re: re("[A-Za-z_$][\\w$]*(?=\\s*:)"), cls: "key" };

  var LANGUAGES = {
    javascript: [COMMENT_SLASH, STRING, KEYWORD, NUMBER, CALL],
    typescript: [
      COMMENT_SLASH,
      STRING,
      { re: re("\\b(?:number|string|boolean|any|unknown|never|void)\\b"), cls: "key" },
      KEYWORD,
      NUMBER,
      CALL,
    ],
    json: [
      STRING,
      PROPERTY,
      { re: re("\\b(?:true|false|null)\\b"), cls: "key" },
      NUMBER,
    ],
    css: [
      { re: re("\\/\\*[\\s\\S]*?\\*\\/"), cls: "com" },
      STRING,
      { re: re("--[\\w-]+"), cls: "key" },
      { re: re("#[0-9A-Fa-f]{3,8}\\b"), cls: "num" },
      { re: re("\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|s|ms|vh|vw|fr|deg|ch)?\\b"), cls: "num" },
      {
        re: re("@[a-z-]+|::?[a-z-]+|\\.[\\w-]+|#[\\w-]+"),
        cls: "fn",
      },
    ],
    xml: [
      { re: re("<!--[\\s\\S]*?-->"), cls: "com" },
      { re: re("<\\/?(?=[A-Za-z])"), cls: "key" },
      { re: re("\\/?>"), cls: "key" },
      STRING,
      { re: re("[A-Za-z_:][\\w:.-]*(?==)"), cls: "fn" },
    ],
    shell: [
      COMMENT_HASH,
      STRING,
      { re: re("\\$\\{[^}]*\\}|\\$[A-Za-z_][\\w]*"), cls: "key" },
      { re: re("(?:^|\\n)\\s*[a-z][\\w-]*"), cls: "fn" },
      { re: re("\\s-[A-Za-z-]+"), cls: "num" },
    ],
    python: [
      COMMENT_HASH,
      { re: re('"""([\\s\\S]*?)"""|\'\'\'([\\s\\S]*?)\'\'\''), cls: "str" },
      STRING,
      {
        re: re(
          "\\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|pass|global|nonlocal|assert|yield|await|async|and|or|not|is|in|None|True|False|self)\\b"
        ),
        cls: "key",
      },
      NUMBER,
      CALL,
    ],
  };

  LANGUAGES.js = LANGUAGES.javascript;
  LANGUAGES.ts = LANGUAGES.typescript;
  LANGUAGES.html = LANGUAGES.xml;
  LANGUAGES.sh = LANGUAGES.shell;
  LANGUAGES.bash = LANGUAGES.shell;
  LANGUAGES.py = LANGUAGES.python;
  LANGUAGES.markdown = [];
  LANGUAGES.md = [];

  function code(source, language) {
    var key = String(language || "").toLowerCase();
    var rules = LANGUAGES[key];
    if (!rules) return escapeHtml(source);
    if (!rules.length) return highlightMarkdown(source);
    return tokenize(source, rules);
  }

  /* ------------------------------------------------ markdown source ---- */

  /* One pass, line by line, with fenced regions tracked across lines. Every
     branch emits the original characters verbatim inside its span. */
  function highlightMarkdown(source) {
    var text = String(source === undefined || source === null ? "" : source);
    var lines = text.split("\n");
    var out = [];
    var fence = null; /* { marker, length } while inside a fenced block */

    lines.forEach(function (line) {
      var open = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);

      if (fence) {
        if (open && open[2].charAt(0) === fence.marker) {
          out.push(span("fence", line));
          fence = null;
        } else {
          out.push(span("code", line));
        }
        return;
      }

      if (open) {
        out.push(span("fence", line));
        fence = { marker: open[2].charAt(0), length: open[2].length };
        return;
      }

      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push(span("rule", line));
        return;
      }

      var heading = /^(\s{0,3})(#{1,6})(\s+)([\s\S]*)$/.exec(line);
      if (heading) {
        out.push(
          heading[1] +
            span("marker", heading[2]) +
            heading[3] +
            span("heading", heading[4])
        );
        return;
      }

      var quote = /^(\s{0,3}>\s?)([\s\S]*)$/.exec(line);
      if (quote) {
        out.push(span("marker", quote[1]) + inlineSource(quote[2]));
        return;
      }

      var item = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?([\s\S]*)$/.exec(line);
      if (item) {
        out.push(
          item[1] +
            span("marker", item[2]) +
            item[3] +
            (item[4] ? span("marker", item[4]) : "") +
            inlineSource(item[5])
        );
        return;
      }

      out.push(inlineSource(line));
    });

    return out.join("\n");
  }

  /* Inline markdown, character-preserving. Each rule matches a fixed-length
     slice of the original line and re-emits it inside a span. */
  var INLINE_RULES = [
    { re: /`[^`\n]*`/, cls: "code" },
    { re: /!?\[[^\]\n]*\]\([^)\n]*\)/, cls: "link" },
    { re: /(?:\*\*|__)[\s\S]+?(?:\*\*|__)/, cls: "strong" },
    { re: /\*[^*\n]+\*|_[^_\n]+_/, cls: "em" },
    { re: /~~[^~\n]+~~/, cls: "del" },
    { re: /<\/?[A-Za-z][^>\n]*>/, cls: "code" },
    { re: /&[A-Za-z]+;|&#\d+;/, cls: "code" },
  ];

  function inlineSource(text) {
    if (!text) return escapeHtml(text);
    var rules = INLINE_RULES.map(function (rule) {
      return { re: new RegExp(rule.re.source, "y"), cls: rule.cls };
    });
    return tokenize(text, rules);
  }

  root.HighlightLite = {
    code: code,
    markdown: highlightMarkdown,
    escape: escapeHtml,
  };
})(window);
