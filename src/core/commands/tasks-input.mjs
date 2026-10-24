/**
 * What a task command accepts — declared once, in wire terms.
 *
 * A task command's input used to be written down three times by hand: the CLI's
 * `flags:` array, the CLI's request body, and the route's `shape({…})`. Nothing
 * compared them — `scripts/verify/route-request.mjs` ties a declaration to its
 * handler's reads, `scripts/verify/contract.mjs` ties it to the committed
 * snapshot, and neither of them looks at `src/cli`. This module is the single
 * record both surfaces project from:
 *
 *   * `src/server/requests.mjs#project`  → the route's request shape
 *   * `src/cli/commands/task-input.mjs`  → the command's flags and its body
 *
 * ## What a field says, and what it deliberately does not
 *
 * A field carries its **wire** name (`if_version`, `no_report`), its primitive
 * type, the domain vocabulary that closes it if any, and its multiplicity. The
 * wire name belongs here because it *is* the command's public interface — it is
 * what the frozen contract publishes. What does not belong here is anything
 * cosmetic: the CLI's flag spelling (`--if-version`), its `required`, its
 * `<value>` placeholder and its help summary all live in the CLI-side table,
 * because they are how a caller *spells* an input, not what the input is.
 *
 * ## The surface marker
 *
 *   * `"both"` — the route declares it and the CLI has a flag for it.
 *   * `"wire"` — only a direct caller sends it; no CLI flag owns it.
 *   * `"cli"`  — no wire field of its own: the flag's value is written to
 *                `foldsInto`, a path inside the body.
 *
 * `tasks.create` is the one operation where a name appears on both sides: the
 * route accepts a top-level `target` and folds it into `meta` itself, so a
 * direct caller need know nothing about the fold, while the CLI's `--target` is
 * folded on the way out into `meta.target`. Two inputs, two surfaces, one word —
 * which is precisely the kind of thing that used to be invisible.
 *
 * `if_version` and `session_id` are supplied by *global* CLI flags, not by a
 * per-command one; the CLI-side table records that, and a command that accepts
 * the global without forwarding it (see `tasks.update`) says so by marking the
 * field `"wire"`.
 */

import { DomainError } from "../../foundation/errors.mjs";
import { CARD_ACCEPTANCE_MODES } from "../domain/acceptance-mode.mjs";
import { PRIORITIES, STATUSES, TASK_KINDS } from "../domain/enums.mjs";

/** The nine operations this module covers. */
export const TASK_OPS = Object.freeze({
  create: "tasks.create",
  update: "tasks.update",
  move: "tasks.move",
  reopen: "tasks.reopen",
  claim: "tasks.claim",
  deliver: "tasks.deliver",
  assign: "tasks.assign",
  archive: "tasks.archive",
  heartbeat: "tasks.heartbeat",
});

/** The primitive types a field can carry. */
const STRING = "string";
const INTEGER = "integer";
const BOOLEAN = "boolean";
const OBJECT = "object";

/**
 * One field.
 *
 * @param {string} key the wire name
 * @param {"both"|"wire"|"cli"} surface
 * @param {{type?: string, vocab?: readonly string[]|null, repeat?: boolean, nested?: object[], foldsInto?: string}} [options]
 */
function field(key, surface, options = {}) {
  return Object.freeze({
    key,
    surface,
    type: options.type ?? STRING,
    vocab: options.vocab ?? null,
    repeat: options.repeat ?? false,
    nested: options.nested ?? null,
    foldsInto: options.foldsInto ?? null,
  });
}

/** A field both surfaces carry. */
const both = (key, options) => field(key, "both", options);
/** A field only a direct caller sends. */
const wireOnly = (key, options) => field(key, "wire", options);
/** A CLI-only input, written to `foldsInto` inside the body. */
const sugar = (key, foldsInto, options) => field(key, "cli", { foldsInto, ...options });

/**
 * `report`'s nested shape on the deliver route. Its fields are wire-only: the
 * CLI hands the object over whole (built from `--report-file`), it does not
 * offer a flag per member.
 */
const REPORT = Object.freeze([
  wireOnly("conclusion"),
  wireOnly("acceptance", { type: OBJECT, repeat: true }),
  wireOnly("evidence", { type: OBJECT, repeat: true }),
  wireOnly("leftovers"),
  wireOnly("seg"),
]);

const CREATE = Object.freeze([
  both("project_id"),
  both("title"),
  both("description"),
  both("status", { vocab: STATUSES }),
  both("priority", { vocab: PRIORITIES }),
  both("kind", { vocab: TASK_KINDS }),
  both("labels", { repeat: true }),
  both("meta", { type: OBJECT }),
  sugar("acceptance", "meta.acceptance", { repeat: true }),
  both("assignee"),
  // `assignee_kind` / `reporter_kind` say what that name *is* — `human`, or the
  // platform it runs on. There is no list to check them against; `isActorKind`
  // refuses a blank one, and that is the whole vocabulary.
  both("assignee_kind"),
  both("assignee_id"),
  both("reporter"),
  both("reporter_kind"),
  both("reporter_id"),
  both("force_create", { type: BOOLEAN }),
  both("idem"),
  both("allow_dup", { type: BOOLEAN }),
  sugar("target", "meta.target"),
  // 0037 — the per-card acceptance decision. `auto` is a project word, so a
  // card states a concrete mode; an omitted value falls back to the project (or
  // `human` when the project is `auto`).
  both("acceptance_mode", { vocab: CARD_ACCEPTANCE_MODES }),
  // 0031 — the legacy boolean alias, kept for one release (`true → agent`,
  // `false → off`).
  both("review_required", { type: BOOLEAN }),
  both("review_of"),
  both("review_round", { type: INTEGER }),
  both("parent"),
  wireOnly("identifier"),
  wireOnly("source_path"),
  wireOnly("target"),
]);

/**
 * The route declares `acceptance` as sugar over `meta.acceptance`; on create the
 * CLI folds it itself and the route never sees a field by that name. The
 * asymmetry is stated here rather than being an accident of which file was
 * written first.
 */
const UPDATE = Object.freeze([
  both("title"),
  both("description"),
  both("priority", { vocab: PRIORITIES }),
  both("kind", { vocab: TASK_KINDS }),
  both("labels", { repeat: true }),
  both("meta", { type: OBJECT }),
  both("acceptance", { repeat: true }),
  // 0032 — a human's audited prune of the frozen baseline. `acceptance_revision`
  // is the optimistic lock; `reason` is the audit row the DB trigger reads.
  both("acceptance_drop", { repeat: true }),
  both("acceptance_revision", { type: INTEGER }),
  // 0037 — the controlled acceptance override. `reason` is required when the
  // change leaves `agent` (waives a review).
  both("acceptance_mode", { vocab: CARD_ACCEPTANCE_MODES }),
  // 0031 — the legacy boolean alias, kept for one release.
  both("review_required", { type: BOOLEAN }),
  both("reason"),
  wireOnly("if_version", { type: INTEGER }),
  wireOnly("assignee"),
  wireOnly("reporter"),
  wireOnly("force_create", { type: BOOLEAN }),
]);

const MOVE = Object.freeze([
  both("to", { vocab: STATUSES }),
  both("if_version", { type: INTEGER }),
  both("no_report", { type: BOOLEAN }),
  both("allow_steal", { type: BOOLEAN }),
  both("reason"),
  both("awaiting_reason"),
  both("blocked_reason"),
  // 0034 — the question a worker asks when it stops in `awaiting`. Written as a
  // `question` comment in the same transaction as the move.
  both("question"),
]);

/**
 * `tasks.reopen` — the one destination is `todo`, so it is a positional
 * characteristic of the operation, not a wire field. The reason is required by
 * the command layer (the same audited-exception pattern as `--allow-steal`);
 * `if_version` rides the global flag.
 */
const REOPEN = Object.freeze([
  both("reason"),
  both("if_version", { type: INTEGER }),
]);

/**
 * `tasks.claim` — the claim/reclaim verb.
 *
 * A `todo → in_progress` move is a claim, but a claim is **not** a transition:
 * it is also how a stale `in_progress` claim is reused, re-claimed or taken
 * over (`domain/claim.mjs#decideClaim`). The status does not change, so the
 * transition route cannot express it, and this operation is the wire shape of
 * `commands.claim`.
 */
const CLAIM = Object.freeze([
  both("allow_steal", { type: BOOLEAN }),
  both("reason"),
  both("if_version", { type: INTEGER }),
  // Opt-in: re-derive the `blocks` predecessors before taking the claim. The
  // default claim trusts the caller's own read (the poll already withholds
  // blocked cards), and `issue move … in_progress` stays the caller's business.
  both("check_blockers", { type: BOOLEAN }),
]);

const DELIVER = Object.freeze([
  // 0037 — `--to done` is the `off` card's direct acceptance: the report and the
  // move land in one transaction, so the evidence the done gate reads exists.
  both("to", { vocab: STATUSES }),
  both("report", { type: OBJECT, nested: REPORT }),
  both("if_version", { type: INTEGER }),
  both("no_report", { type: BOOLEAN }),
  both("reason"),
  both("seg"),
  both("session_id"),
]);

const ASSIGN = Object.freeze([
  both("assignee"),
  both("assignee_id"),
  both("reporter"),
  both("reporter_id"),
  both("force_create", { type: BOOLEAN }),
  wireOnly("if_version", { type: INTEGER }),
]);

const ARCHIVE = Object.freeze([
  both("if_version", { type: INTEGER }),
  both("days", { type: INTEGER }),
]);

/**
 * `tasks.heartbeat` carries **no body field at all**, and that is the honest
 * declaration rather than a missing one: the card is the route's `:ref`, and the
 * pulsing actor is the caller's own identity — which every write already carries
 * and no caller should have to restate. The empty list is still written down,
 * because it is the record that pairs the route with `issue heartbeat`
 * (`scripts/verify/route-request.mjs`): a command absent from here would be a
 * command the lint cannot see, which is the silent hole the declaration exists to
 * close.
 */
const HEARTBEAT = Object.freeze([]);

const FIELDS = Object.freeze({
  [TASK_OPS.create]: CREATE,
  [TASK_OPS.update]: UPDATE,
  [TASK_OPS.move]: MOVE,
  [TASK_OPS.reopen]: REOPEN,
  [TASK_OPS.claim]: CLAIM,
  [TASK_OPS.deliver]: DELIVER,
  [TASK_OPS.assign]: ASSIGN,
  [TASK_OPS.archive]: ARCHIVE,
  [TASK_OPS.heartbeat]: HEARTBEAT,
});

/**
 * The wire's required list, per operation. It is *not* the CLI's: `--project`
 * and `--title` are required at the command line while a create body tolerates
 * them, because the route also serves callers that set a field another way. The
 * CLI's own list lives in the CLI-side table (`D16`).
 */
const REQUIRED = Object.freeze({
  [TASK_OPS.create]: Object.freeze([]),
  [TASK_OPS.update]: Object.freeze([]),
  [TASK_OPS.move]: Object.freeze(["to"]),
  [TASK_OPS.reopen]: Object.freeze([]),
  [TASK_OPS.claim]: Object.freeze([]),
  [TASK_OPS.deliver]: Object.freeze([]),
  [TASK_OPS.assign]: Object.freeze([]),
  [TASK_OPS.archive]: Object.freeze([]),
  [TASK_OPS.heartbeat]: Object.freeze([]),
});

/**
 * The fields a task command accepts, in wire terms.
 *
 * @param {string} op one of `TASK_OPS`
 * @returns {{op: string, fields: readonly object[], required: readonly string[]}}
 */
export function inputOf(op) {
  const fields = FIELDS[op];
  if (fields === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `no input declaration for ${JSON.stringify(op)}`,
      details: { field: "op", known: Object.values(TASK_OPS) },
      hint: { fix: "use one of TASK_OPS — a typo here would otherwise project an empty shape" },
    });
  }
  return { op, fields, required: REQUIRED[op] };
}
