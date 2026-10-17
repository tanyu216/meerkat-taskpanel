/**
 * The block contract's px comparators — `equalsPx`, `minPx`, `maxPx` — as a
 * judgement over a **raw computed value** and a **box fact**.
 *
 * ## Why this is not inline in the page
 *
 * `web/scripts/dom-smoke.mjs` runs its rule evaluator inside the browser
 * (`page.evaluate`). A `px` comparator there used to be
 * `Math.abs(parseFloat(actual) - expected) > 0.5` (and the `<` / `>` siblings),
 * which has two holes:
 *
 *   * `getComputedStyle()` returns `"auto"` for a rendered element whose width
 *     does not apply (`display:inline`) and for every element in a non-rendered
 *     subtree. `parseFloat("auto")` is `NaN`, every comparison against `NaN` is
 *     false, so the assertion **passed while measuring nothing**.
 *   * `"100%"` parses as `100`, a fake pixel value — a rule asserting
 *     `equalsPx: 100` would pass on any viewport.
 *
 * A length is a px length only when the browser spells it with a `px` unit. The
 * page therefore reports the raw value and whether the element has a layout box,
 * and this module judges in Node — where it is testable without a browser.
 *
 * ## The two non-px cases are not the same thing
 *
 *   * **No layout box** (a closed subtree: `display:none` itself or an ancestor,
 *     `display:contents`, not connected). There is nothing to measure, and the
 *     probe's existence criterion (the node matched, its `count` if declared)
 *     still holds. The verdict is *not measured*, recorded as a note — the
 *     degradation the card asks for, not a false red.
 *   * **A box, but a non-px value** (inline `width:auto`, a percentage
 *     `max-width`, `line-height:normal`, a typo'd property). The assertion asked
 *     for a pixel length in a context where one exists or should, so it fails
 *     loudly rather than passing vacuously.
 */

/** A computed CSS length: digits, optional fraction/exponent, and a `px` unit. */
const PX_LENGTH = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)px$/;

/** The numeric px value of a computed length, or `null` when it is not one. */
export function parsePxValue(value) {
  const match = PX_LENGTH.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * Judge one px comparator.
 *
 * @param {object} rule     the contract rule (`property`, one of the three comparators)
 * @param {{value: string, hasBox: boolean}} reading  the raw computed value and
 *        whether the element generated a layout box in the state it was read in
 * @returns {{ok: boolean, detail?: string, note?: string}}
 */
export function pxVerdict(rule, reading) {
  const property = rule.property;
  const value = reading.value;

  if (typeof reading.hasBox !== "boolean") {
    return { ok: false, detail: `${property} = ${JSON.stringify(value)} — the evaluator did not report whether the element has a layout box` };
  }

  const numeric = parsePxValue(value);
  if (numeric === null) {
    if (!reading.hasBox) {
      return {
        ok: true,
        note: `${property} = ${JSON.stringify(value)} — not measured (no layout box: the element is in a non-rendered subtree); the probe's existence criterion still holds`,
      };
    }
    const parsed = Number.parseFloat(value);
    const fake = Number.isNaN(parsed) ? "parseFloat reads NaN" : `parseFloat would read ${parsed}, which is not a pixel length`;
    return {
      ok: false,
      detail: `${property} = ${JSON.stringify(value)} is not a px length (${fake}) — a px comparator cannot measure it; assert a structural criterion or a measurable property`,
    };
  }

  if (rule.equalsPx !== undefined && Math.abs(numeric - rule.equalsPx) > 0.5) {
    return { ok: false, detail: `${property} = ${JSON.stringify(value)} != ${rule.equalsPx}px` };
  }
  if (rule.maxPx !== undefined && numeric > rule.maxPx) {
    return { ok: false, detail: `${property} = ${JSON.stringify(value)} > ${rule.maxPx}px` };
  }
  if (rule.minPx !== undefined && numeric < rule.minPx) {
    return { ok: false, detail: `${property} = ${JSON.stringify(value)} < ${rule.minPx}px` };
  }
  return { ok: true };
}

/**
 * Fold the page's raw px readings into the harness's result records.
 *
 * `evaluateRules` attaches `record.px = [{ value, hasBox }, …]` for every node a
 * px rule matched (one reading per matched node) and leaves the comparator
 * undecided; this consumes the readings, flips `ok` on the first failing one and
 * drops the payload. A not-measured reading (no layout box) marks
 * `record.notMeasured = true` so the harness reports the degradation rather
 * than hiding it. `record.index` links a record back to the rule array that
 * produced it.
 */
export function applyPxVerdicts(records, rules) {
  for (const record of records) {
    if (!record.px) continue;
    const rule = rules[record.index]?.rule;
    for (const reading of record.px) {
      if (!record.ok) break;
      if (!rule) continue;
      const verdict = pxVerdict(rule, reading);
      if (!verdict.ok) {
        record.ok = false;
        record.detail = verdict.detail;
        break;
      }
      if (verdict.note) {
        record.notMeasured = true;
        if (!record.detail) record.detail = verdict.note;
      }
    }
    delete record.px;
  }
  return records;
}
