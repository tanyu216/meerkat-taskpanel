/**
 * R8 ③ — the identifier's display value, for the **two** render points that
 * still clamp.
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
 * **Who calls this (R12).** Two render points: B07's `Card.vue` and B08's
 * `ListView.vue`. The third one used to be the drawer's head, and R12 made that
 * element the **exception** — it shows the id verbatim and wears `.td-id-full`
 * to lift the width cap (`design/fidelity-r12.md` §2.1/§2.2, §2.4), so it no
 * longer calls this function and must not start again (R12 §8 R3). The cap the
 * two remaining callers inherit is unchanged, and `.td-id-full` must not be
 * added to them (R12 §8 R1) — the cards and the list rows are the density-first
 * scan surfaces where eight characters plus `…` is what R8 ruled.
 *
 * The **full** value never leaves the DOM: it stays on the element's `title`
 * (hover, a11y) and on the row / card / drawer root's `data-identifier`
 * attribute, which is the only thing identity is ever *read back* from — see
 * `design/fidelity-r8.md` §5, whose rule is that nothing may resolve an entity
 * from this function's output. R12 restates it for the drawer head even though
 * its text now equals the whole id: being the whole id is a display fact, not a
 * read-back contract (`design/fidelity-r12.md` §2.1).
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
