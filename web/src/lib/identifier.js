/**
 * R8 ③ — the identifier's display value.
 *
 * A task's identifier renders at most **eight characters plus `…`**; anything
 * shorter renders verbatim, with no ellipsis. Real ids run to nine
 * (`PROJ-0007`), which is why the cap has a trigger rather than being a
 * hypothetical edge.
 *
 * The cut is a **character slice**, not a CSS width. `max-width: 9ch` is a
 * *width*: it depends on the face's advance width and its `letter-spacing`, so
 * it cannot promise "exactly eight characters" — measured in the prototype it
 * resolves to 65.02px, which is a different character count at a different
 * font. The slice is deterministic and machine-checkable, and `.td-id` (the
 * single-line guard in `app.css`) is the belt to this braces: even if some
 * render path forgot to slice, the string still would not wrap.
 *
 * The **full** value never leaves the DOM: it stays on the element's `title`
 * (hover, a11y) and on the row / card / drawer root's `data-identifier`
 * attribute, which is the only thing identity is ever *read back* from — see
 * `design/fidelity-r8.md` §5, whose rule is that nothing may resolve an entity
 * from this function's output.
 *
 * @param {unknown} value the task's full identifier
 * @returns {string} the display string — `value` when it is short enough, else
 *   its first eight characters followed by `…`
 */
export const IDENTIFIER_LIMIT = 8;

export function identifierText(value) {
  const id = String(value ?? "");
  return id.length > IDENTIFIER_LIMIT ? `${id.slice(0, IDENTIFIER_LIMIT)}…` : id;
}
