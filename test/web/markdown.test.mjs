/**
 * The drawer's Markdown sink (TP-0123).
 *
 * Report conclusions, comments, acceptance notes and leftovers are rendered by
 * `web/src/lib/markdown.js`. These assertions pin the safe subset the drawer
 * relies on: emphasis survives, raw HTML is escaped and an unsafe link scheme
 * loses its href. They run in Node, so the container — which has no browser and
 * skips `blocks.dom` — still proves the sink cannot emit markup the board did
 * not write.
 */

import assert from "node:assert/strict";
import test from "node:test";

// The vendored renderer attaches its global to `window`; the wrapper reads it
// from `globalThis`. Set the alias before the dynamic import runs.
globalThis.window = globalThis;
const { renderMarkdown } = await import("../../web/src/lib/markdown.js");

test("emphasis becomes markup", () => {
  assert.ok(renderMarkdown("**x**").includes("<strong>x</strong>"));
});

test("raw HTML is escaped and never becomes an element", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
});

test("a javascript: link keeps its text and loses its href", () => {
  const html = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(html.includes("x"));
  assert.ok(!html.includes("href="));
});

test("empty source renders nothing", () => {
  assert.equal(renderMarkdown(""), "");
});
