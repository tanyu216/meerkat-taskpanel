/**
 * Tests for `src/cli/commands/task-input.mjs` — the CLI's half of a command's
 * input declaration.
 *
 * The cross-surface pairing (declaration ↔ route ↔ command) is the gate's job
 * (`test/verify/route-request.test.mjs`). What only this module can answer is
 * whether *its own* two projections are coherent, and each case here is chosen
 * because the failure it catches is otherwise silent:
 *
 *   * a field with no flag, no global and no positional is an input a caller
 *     cannot set — and nothing reds, because the field simply never appears;
 *   * a spelling entry whose key names no field is inert, so the field falls
 *     back to the derived spelling and the table quietly stops applying — the
 *     `undefined`-never-throws failure mode hand-kept tables are prone to;
 *   * a projected flag whose name collides with a global is a registry failure
 *     ("a command may not redeclare a global"), one command load away;
 *   * a body key the declaration does not know is dropped without complaint.
 *
 * The last one is covered by construction: `projectBody` iterates the
 * declaration, so an unknown key in the *values* map can never reach the wire.
 * That is asserted below rather than assumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputOf, TASK_OPS } from "../../src/core/commands/tasks-input.mjs";
import {
  projectBody,
  projectFlags,
  RIDES_A_GLOBAL,
  SPELLING,
} from "../../src/cli/commands/task-input.mjs";

const OPS = Object.values(TASK_OPS);
const kebab = (wire) => wire.replace(/_/g, "-");

/** The flag a field is reached by: its spelling entry, else the derived name. */
const flagOf = (op, field) => SPELLING[op]?.[field.key]?.flag ?? kebab(field.key);

describe("cli/commands/task-input — the CLI side of the declaration", () => {
  it("keeps every non-wire field reachable at the command line", () => {
    for (const op of OPS) {
      const flags = new Set(projectFlags(op).map((spec) => spec.flag));
      for (const field of inputOf(op).fields) {
        if (field.surface === "wire") continue; // a direct caller's field; the CLI does not take it
        const positional = SPELLING[op]?.[field.key]?.positional === true;
        const global = Object.hasOwn(RIDES_A_GLOBAL, field.key);
        assert.equal(
          positional || global || flags.has(flagOf(op, field)),
          true,
          `${op}: "${field.key}" has no flag, no global and no positional — nothing can set it`,
        );
      }
    }
  });

  it("has no dead spelling entry", () => {
    for (const op of OPS) {
      const known = new Set(inputOf(op).fields.map((field) => field.key));
      for (const key of Object.keys(SPELLING[op] ?? {})) {
        assert.equal(known.has(key), true, `${op}: the spelling table names "${key}", which the declaration does not have`);
      }
    }
  });

  it("never projects a flag for a field that already rides a global", () => {
    for (const op of OPS) {
      const flags = projectFlags(op).map((spec) => spec.flag);
      for (const globalFlag of Object.values(RIDES_A_GLOBAL)) {
        assert.equal(flags.includes(globalFlag), false, `${op} redeclares the global --${globalFlag}`);
      }
    }
  });

  it("projects a flag for exactly the fields whose surface is not wire", () => {
    for (const op of OPS) {
      const fields = inputOf(op).fields.filter((field) => field.surface !== "wire");
      const expected = fields
        .filter((field) => !Object.hasOwn(RIDES_A_GLOBAL, field.key) && SPELLING[op]?.[field.key]?.positional !== true)
        .map((field) => flagOf(op, field));
      assert.deepEqual(projectFlags(op).map((spec) => spec.flag), expected, op);
    }
  });

  it("carries the declaration's multiplicity onto the flag", () => {
    // `--acceptance` repeats because the field does; a list spelled as a scalar
    // would silently keep only the last value.
    const labels = projectFlags(TASK_OPS.create).find((spec) => spec.flag === "label");
    const acceptance = projectFlags(TASK_OPS.create).find((spec) => spec.flag === "acceptance");
    assert.equal(labels.repeat, true);
    assert.equal(acceptance.repeat, true);
    assert.equal(projectFlags(TASK_OPS.create).find((spec) => spec.flag === "title").repeat, undefined);
  });

  it("covers the CLI's fields in the body, and leaks no wire-only field into it", () => {
    for (const op of OPS) {
      const { fields } = inputOf(op);
      const values = Object.fromEntries(
        fields.map((field) => [field.key, field.type === "object" ? { probe: "x" } : `${field.key}-v`]),
      );
      const body = projectBody(op, values);
      const heads = new Set(
        fields
          .filter((field) => field.surface !== "wire")
          .map((field) => (field.foldsInto === null ? field.key : field.foldsInto.split(".")[0])),
      );
      assert.deepEqual(Object.keys(body).sort(), [...heads].sort(), `${op}: body keys`);
      for (const field of fields) {
        if (field.surface !== "wire") continue;
        assert.equal(Object.hasOwn(body, field.key), false, `${op}: wire-only "${field.key}" reached the CLI body`);
      }
    }
  });

  it("drops a field the caller did not pass, rather than sending null", () => {
    assert.deepEqual(projectBody(TASK_OPS.archive, { days: undefined, if_version: 3 }), { if_version: 3 });
    assert.deepEqual(projectBody(TASK_OPS.archive, {}), {});
    assert.deepEqual(projectBody(TASK_OPS.archive, { days: 0 }), { days: 0 }, "a falsy value is a value");
  });

  it("folds a CLI-only field into the path its declaration names", () => {
    assert.deepEqual(projectBody(TASK_OPS.create, { acceptance: ["a"] }), { meta: { acceptance: ["a"] } });
    assert.deepEqual(
      projectBody(TASK_OPS.create, { meta: { k: "v" }, target: "t" }),
      { meta: { k: "v", target: "t" } },
      "a fold joins `meta` rather than replacing it",
    );
  });

  it("refuses an op it does not know, instead of projecting an empty shape", () => {
    assert.throws(
      () => inputOf("tasks.creat"),
      (error) => {
        assert.equal(error.code, "VALIDATION_FAILED");
        return true;
      },
    );
  });
});
