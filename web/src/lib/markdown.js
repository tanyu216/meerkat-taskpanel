/**
 * Markdown + source highlighting (B23).
 *
 * The renderers are the prototype's own first-party vendored files
 * (`prototype/vendor/markdown-lite.js`, `highlight-lite.js`), copied here rather
 * than re-implemented so the preview and the highlight layer behave exactly as
 * the design baseline does. Both are dependency-free IIFEs that publish one
 * global and escape their own input — there is no DOMPurify, no markdown-it and
 * no network request, which is why the board can render GFM offline.
 *
 * Importing them for their side effect is deliberate: they attach
 * `MarkdownLite` / `HighlightLite` to `window`. The wrappers below degrade to
 * plain escaped text if a global is somehow absent, so a missing renderer loses
 * formatting but never throws or drops text.
 */
import "./markdown-lite.js";
import "./highlight-lite.js";

/** HTML-escape, from the vendored renderer when present. */
export function escapeHtml(text) {
  const md = globalThis.MarkdownLite;
  if (md) return md.escape(String(text ?? ""));
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Markdown source → sanitised HTML (the preview pane). */
export function renderMarkdown(source) {
  const md = globalThis.MarkdownLite;
  const hl = globalThis.HighlightLite;
  if (!md) return escapeHtml(source);
  return md.render(String(source ?? ""), {
    highlight: (code, language) => (hl ? hl.code(code, language) : md.escape(code)),
  });
}

/** Markdown source → HTML that reproduces every glyph (the highlight layer). */
export function highlightMarkdown(source) {
  const hl = globalThis.HighlightLite;
  return hl ? hl.markdown(String(source ?? "")) : escapeHtml(source);
}
