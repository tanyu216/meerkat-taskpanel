/**
 * How a task command's input is *spelled* at the command line.
 *
 * The other half of the record lives in `src/core/commands/tasks-input.mjs`
 * (`inputOf`): what an input is, its wire name, its type, its vocabulary, its
 * multiplicity, and which surface carries it. This module adds only what is the
 * CLI's own business — the flag a field is reached by, its `<value>`
 * placeholder, its help summary, whether the command insists on it, and whether
 * it rides a **global** flag instead of one of its own.
 *
 * `repeat` and the coercion are *not* repeated here: both come from the field's
 * declared type, so a list field cannot be spelled as a scalar by accident. The
 * two places the CLI's own vocabulary wins are `--meta k=v` (a `kv` binding for
 * a field the wire calls an object) and `--report-file`, whose value is a path
 * the command reads and parses rather than the object it eventually sends.
 *
 * ## Why the CLI may import that module and not the core barrel
 *
 * `src/core/commands/tasks-input.mjs` imports exactly two things
 * (`shared/errors.mjs`, `domain/enums.mjs`) and reaches no storage — which is
 * what lets the CLI read the declaration without dragging `node:sqlite` into a
 * process whose whole point is that it talks to the board over HTTP.
 * `test/cli/imports.test.mjs` pins that: the CLI's only `src/core` import is
 * this leaf, and the leaf stays pure.
 *
 * ## Order
 *
 * Fields project in declaration order, and that order is what `--help` prints,
 * so `tasks-input.mjs` lists them in the order the CLI has always shown them.
 * The wire never sees the order: `contract.mjs` sorts a shape's properties.
 */

import { inputOf, TASK_OPS } from "../../core/commands/tasks-input.mjs";

/** `assignee_kind` → `assigneeKind`; `if_version` → `ifVersion`. */
const camel = (wire) => wire.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
/** `assignee_kind` → `assignee-kind`; `if_version` → `if-version`. */
const kebab = (wire) => wire.replace(/_/g, "-");

/**
 * Fields a global flag already supplies. No per-command flag is generated for
 * them — the registry forbids a command redeclaring a global — and whether the
 * command *forwards* them is the declaration's `surface` marker to state.
 */
export const RIDES_A_GLOBAL = Object.freeze({ if_version: "if-version", session_id: "session-id" });

/** The coercion a flag binds with, from the field's declared type. */
const AS = Object.freeze({ string: "string", integer: "number", boolean: "boolean", object: "string" });

/**
 * The spelling table: per operation, per field key.
 *
 * Everything here has a default, so an entry is only needed when the CLI
 * deviates from it: `flag` defaults to `kebab(key)` and `key` to `camel(key)`,
 * a `value` placeholder is supplied only for flags that take one, and `required`
 * only where the command insists (D16 — the wire's own required list is the
 * declaration's, and the two legitimately differ).
 *
 * Exported so `test/cli/task-input.test.mjs` can prove no entry here is dead: a
 * mistyped key would otherwise match no field, and the field would quietly fall
 * back to the derived spelling — the silent-`undefined` failure mode this table
 * is most exposed to.
 */
export const SPELLING = Object.freeze({
  [TASK_OPS.create]: Object.freeze({
    project_id: { flag: "project", key: "project", value: "<id>", required: true },
    title: { value: "<text>", required: true },
    description: { value: "<text>" },
    status: { value: "<status>" },
    priority: { value: "<low|medium|high|urgent>" },
    kind: { value: "<task|epic|deploy>" },
    labels: { flag: "label", value: "<label>" },
    meta: { as: "kv" },
    acceptance: { value: "<text>", summary: "Acceptance criterion; repeatable." },
    assignee: { value: "<text>", summary: "Free text; resolved against the dictionary." },
    assignee_id: { value: "<id>" },
    assignee_kind: { value: "<agent|human>" },
    reporter: { value: "<text>" },
    reporter_id: { value: "<id>" },
    reporter_kind: { value: "<agent|human>" },
    force_create: { summary: "Skip dictionary fuzzy matching." },
    idem: { value: "<key>", summary: "Explicit idempotency key; a match re-uses the existing task." },
    allow_dup: { summary: "Bypass the idempotency guard and create a duplicate anyway." },
    target: {
      value: "<t>",
      summary: "The card's target — stored in its meta; also the idempotency key's target slot.",
    },
    review_of: { value: "<id>", summary: "Idempotency key's source slot (a card under review)." },
    parent: { value: "<id>", summary: "Idempotency key's source slot (a parent card)." },
  }),
  [TASK_OPS.update]: Object.freeze({
    title: { value: "<text>" },
    description: { value: "<text>" },
    priority: { value: "<priority>" },
    kind: { value: "<task|epic|deploy>" },
    labels: { flag: "label", value: "<label>" },
    meta: { as: "kv" },
    acceptance: { value: "<text>" },
  }),
  [TASK_OPS.move]: Object.freeze({
    // `to` is the command's second positional, not a flag: the CLI reads it as
    // `ctx.args.to`, and the declaration carries it because the wire field is real.
    to: { positional: true },
    no_report: { summary: "Waive the report for this round (needs --reason)." },
    allow_steal: { summary: "Claim a card assigned to somebody else (needs --reason; audited)." },
    reason: { value: "<why>", summary: "Why this move is audited (a report waiver or an --allow-steal)." },
    awaiting_reason: { value: "<E1..E5>", summary: "Why this card needs a human — required by `issue move <ref> awaiting`." },
  }),
  [TASK_OPS.deliver]: Object.freeze({
    // The flag carries a path; the body carries the parsed object. Reading and
    // parsing is the command's job, so only the spelling changes here.
    report: { flag: "report-file", key: "reportFile", value: "<file|->", summary: "Report JSON, or `-` for stdin." },
    no_report: { summary: "Waive the report for this round (needs --reason)." },
    reason: { value: "<why>" },
    seg: { value: "<seg>" },
  }),
  [TASK_OPS.assign]: Object.freeze({
    assignee: { value: "<text>" },
    assignee_id: { value: "<id>" },
    reporter: { value: "<text>" },
    reporter_id: { value: "<id>" },
  }),
  [TASK_OPS.archive]: Object.freeze({
    days: { value: "<n>", summary: "Override the 7-day window." },
  }),
});

/** A field's spelling, with the defaults filled in. */
function spellingFor(op, field) {
  const entry = SPELLING[op]?.[field.key] ?? {};
  return {
    flag: entry.flag ?? kebab(field.key),
    key: entry.key ?? camel(field.key),
    as: entry.as ?? AS[field.type] ?? "string",
    value: entry.value ?? null,
    summary: entry.summary ?? null,
    required: entry.required ?? false,
    positional: entry.positional ?? false,
  };
}

/**
 * The flag specs a command passes to the registry.
 *
 * @param {string} op one of `TASK_OPS`
 * @returns {object[]} today's `flags:` array, built rather than transcribed
 */
export function projectFlags(op) {
  const { fields } = inputOf(op);
  const specs = [];
  for (const field of fields) {
    if (field.surface === "wire") continue; // no CLI flag owns it
    if (Object.hasOwn(RIDES_A_GLOBAL, field.key)) continue; // a global already provides it
    const { flag, key, as, value, summary, required, positional } = spellingFor(op, field);
    if (positional) continue; // the command's `positionals` already carries it
    specs.push({
      flag,
      key,
      as,
      ...(value === null ? {} : { value }),
      ...(field.repeat ? { repeat: true } : {}),
      ...(summary === null ? {} : { summary }),
      ...(required ? { required: true } : {}),
    });
  }
  return specs;
}

/** Set `a.b` inside the body, one level deep — how a CLI-only field is folded. */
function fold(body, path, value) {
  const dot = path.indexOf(".");
  if (dot === -1) {
    body[path] = value;
    return;
  }
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  body[head] = { ...(body[head] ?? {}), [tail]: value };
}

/**
 * The request body, projected from the declaration.
 *
 * The field *list* is the declaration's — a field added there that this call
 * site forgets arrives as `undefined` and is left out, and one this call site
 * passes that the declaration does not know is a gate failure
 * (`scripts/verify/route-request.mjs`). The *values* stay local, because only
 * the call site knows how a flag becomes a value (`flags.forceCreate === true`,
 * a parsed report, a path).
 *
 * `undefined` is dropped so an unpassed flag leaves no field on the wire;
 * CLI-only fields are written to their `foldsInto` path instead.
 *
 * @param {string} op one of `TASK_OPS`
 * @param {Record<string, unknown>} values keyed by *wire* name
 */
export function projectBody(op, values) {
  const { fields } = inputOf(op);
  const body = {};
  for (const field of fields) {
    if (field.surface === "wire") continue; // a direct caller's field; the CLI does not send it
    if (!Object.hasOwn(values, field.key)) continue;
    const value = values[field.key];
    if (value === undefined) continue;
    if (field.foldsInto === null) body[field.key] = value;
    else fold(body, field.foldsInto, value);
  }
  return body;
}
