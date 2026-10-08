/**
 * Label use-cases (§4.4, rulings F2/F3/F5).
 *
 * There is **no** management surface: no `addLabel`, no `removeLabel`, no
 * `renameLabel`. The registry grows when a task names a label, exactly the way
 * the assignee/reporter dictionaries grow, and the only thing a caller can ask
 * for directly is a read plus the GC's own housekeeping sweep.
 *
 *   - `resolveLabels`  — the write path, called *inside* a task write's
 *     transaction. It registers the labels a task names (assigning colours for
 *     new ones), then reconciles `use_count` against what the task named before.
 *   - `listLabels`     — the read path.
 *   - `collectUnusedLabels` — the timed GC. Eligible labels are soft-deleted and
 *     one `label_gc` activity records the sweep.
 *
 * `resolveLabels` does not write its own activity row: the task command records
 * the label audit inside its own `changes_json`, so a task write stays one
 * transaction with one activity (the same rule the dictionary follows).
 */

import { LABEL_PALETTE, LABEL_TTL_DAYS_DEFAULT } from "../../shared/constants.mjs";
import { isCollectable, labelDisplayName, nextColor, normalizeLabelName } from "../domain/labels.mjs";
import { transaction } from "../storage/unit-of-work.mjs";

/**
 * Register the labels named on one task, in the caller's transaction.
 *
 * Identity is `norm`, so `["Bug", "bug"]` is a single label; the array returned
 * (`stored`) holds the registry's **display names** and is what the task row
 * stores (F3-B: `tasks.labels` keeps display-name strings).
 *
 * `use_count` bookkeeping (F5-B) is a diff: a label the task names now but did
 * not before is `+1` (and refreshes `last_seen_at`); one it named before but no
 * longer does is `-1`. Re-submitting the same labels is therefore a no-op — no
 * duplicate row, no count drift, no timestamp churn.
 *
 * @param {object} ctx
 * @param {{projectId: string, names: string[], previousLabels?: string[], now: string}} input
 * @returns {{stored: string[], audit: object[]}}
 */
export function resolveLabels(ctx, input) {
  const { repos } = ctx;
  const { projectId, names, previousLabels = [], now } = input;

  // Colours already taken by this project's *active* labels, extended as we go so
  // two new labels in one call cannot land on the same colour.
  const consumed = repos.labels.usedColors(projectId);
  /** @type {Map<string, object>} */
  const byNorm = new Map();
  const stored = [];
  const audit = [];
  const seen = new Set();

  for (const raw of Array.isArray(names) ? names : []) {
    const key = normalizeLabelName(raw);
    if (seen.has(key)) continue; // duplicate spelling inside one payload
    seen.add(key);

    const existing = repos.labels.getByNorm(projectId, key);
    let label;
    let action;
    if (existing === null) {
      const color = nextColor(consumed, LABEL_PALETTE);
      consumed.push(color);
      const result = repos.labels.upsert({
        projectId,
        norm: key,
        displayName: labelDisplayName(raw),
        color,
        now,
        id: ctx.newId(),
      });
      label = result.entry;
      action = result.action;
    } else {
      // First-seen wins: reuse the stored spelling and colour (a resurrected
      // label keeps both). `upsert` only clears `archived_at` when needed.
      const result = repos.labels.upsert({
        projectId,
        norm: key,
        displayName: existing.displayName,
        color: existing.color,
        now,
        id: existing.id,
      });
      label = result.entry;
      action = result.action;
    }

    byNorm.set(key, label);
    stored.push(label.displayName);
    audit.push({ norm: key, displayName: label.displayName, color: label.color, action });
  }

  const before = new Set(
    (Array.isArray(previousLabels) ? previousLabels : []).map((name) => normalizeLabelName(name)),
  );
  for (const key of seen) {
    if (!before.has(key)) repos.labels.addUse(byNorm.get(key).id, now);
  }
  for (const key of before) {
    if (seen.has(key)) continue;
    const label = repos.labels.getByNorm(projectId, key);
    if (label !== null) repos.labels.removeUse(label.id);
  }

  return { stored, audit };
}

/**
 * The read surface. No project filter means "every project".
 * @param {object} ctx
 * @param {{projectId?: string, q?: string, limit?: number, includeArchived?: boolean}} [filter]
 */
export function listLabels(ctx, filter = {}) {
  return ctx.repos.labels.list(filter);
}

/**
 * One GC sweep (F1-C's timer calls this; it is also directly callable).
 *
 * A label is collected only when **all** of these hold:
 *   1. `use_count = 0` and it is not already archived (the candidate query),
 *   2. `last_seen_at` is older than `ttlDays`,
 *   3. a **live reference scan** agrees with the stored count (F3-B's hard
 *      requirement). If `use_count` and the scan disagree, the archive is
 *      **skipped and warned about** — never silently mis-archived.
 *
 * Collecting means `archived_at` is set (soft delete) and, if anything was
 * collected, one `task_activities` row (`event = 'label_gc'`, `task_id = NULL`)
 * records the sweep. A sweep that collects nothing writes **nothing** — the
 * zero-disturbance guarantee the existing "one activity per command" tests need.
 *
 * @param {object} ctx
 * @param {{now?: string, ttlDays?: number}} [input]
 * @returns {{archived: object[], kept: number, mismatched: object[]}}
 */
export function collectUnusedLabels(ctx, input = {}) {
  const { repos } = ctx;
  const now = input.now ?? ctx.now();
  const ttlDays = input.ttlDays ?? LABEL_TTL_DAYS_DEFAULT;

  return transaction(
    ctx.db,
    () => {
      const candidates = repos.labels.listUnusedActive();
      const archived = [];
      const mismatched = [];

      for (const label of candidates) {
        if (!isCollectable(label, { now, ttlDays })) continue;

        // Reconcile the counter against reality before trusting it (F3-B).
        const scan = repos.labels.referenceCount(label.projectId, label.norm);
        if (scan !== label.useCount) {
          mismatched.push({
            id: label.id,
            projectId: label.projectId,
            norm: label.norm,
            displayName: label.displayName,
            useCount: label.useCount,
            scanned: scan,
          });
          if (typeof ctx.logger === "function") {
            ctx.logger({
              event: "label_gc_mismatch",
              labelId: label.id,
              projectId: label.projectId,
              norm: label.norm,
              useCount: label.useCount,
              scanned: scan,
              note: "use_count disagrees with the live reference scan — archive skipped",
            });
          }
          continue;
        }

        if (repos.labels.archive(label.id, now)) {
          archived.push({
            id: label.id,
            projectId: label.projectId,
            norm: label.norm,
            displayName: label.displayName,
          });
        }
      }

      if (archived.length > 0) {
        repos.activities.append({
          taskId: null,
          actorKind: "system",
          actorId: "taskd",
          event: "label_gc",
          changes: {
            archived,
            kept: candidates.length - archived.length,
            mismatched: mismatched.length,
            reason: "ttl",
            ttlDays,
          },
          createdAt: now,
        });
      }

      return { archived, kept: candidates.length - archived.length, mismatched };
    },
    { op: "labels.gc" },
  );
}
