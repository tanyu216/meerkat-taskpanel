/**
 * The domain surface.
 *
 * Everything importable from `src/core/domain` without reaching for Node I/O:
 * enums, the state machine, DTOs and their validators, the delivery gate, the
 * dictionary resolver and the invariant registry. `src/core/storage` and
 * `src/core/commands` build on exactly this.
 */

export * from "./enums.mjs";
export * from "./status.mjs";
export * from "./priority.mjs";
export * from "./task.mjs";
export * from "./idem.mjs";
export * from "./comment.mjs";
export * from "./relation.mjs";
export * from "./report.mjs";
export * from "./delivery-gate.mjs";
export * from "./dictionary.mjs";
export * from "./labels.mjs";
export * from "./claim.mjs";
export * from "./invariants.mjs";
