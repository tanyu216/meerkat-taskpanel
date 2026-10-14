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

import { DomainError } from "../../shared/errors.mjs";
import { DICT_KINDS, PRIORITIES, STATUSES, TASK_KINDS } from "../domain/enums.mjs";

/** The six operations this module covers. */
export const TASK_OPS = Object.freeze({
  create: "tasks.create",
  update: "tasks.update",
  move: "tasks.move",
  deliver: "tasks.deliver",
  assign: "tasks.assign",
  archive: "tasks.archive",
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
  both("assignee_kind", { vocab: DICT_KINDS }),
  both("assignee_id"),
  both("reporter"),
  both("reporter_kind", { vocab: DICT_KINDS }),
  both("reporter_id"),
  both("force_create", { type: BOOLEAN }),
  both("idem"),
  both("allow_dup", { type: BOOLEAN }),
  sugar("target", "meta.target"),
  both("review_of"),
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
]);

const DELIVER = Object.freeze([
  wireOnly("to", { vocab: STATUSES }),
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

const FIELDS = Object.freeze({
  [TASK_OPS.create]: CREATE,
  [TASK_OPS.update]: UPDATE,
  [TASK_OPS.move]: MOVE,
  [TASK_OPS.deliver]: DELIVER,
  [TASK_OPS.assign]: ASSIGN,
  [TASK_OPS.archive]: ARCHIVE,
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
  [TASK_OPS.deliver]: Object.freeze([]),
  [TASK_OPS.assign]: Object.freeze([]),
  [TASK_OPS.archive]: Object.freeze([]),
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
