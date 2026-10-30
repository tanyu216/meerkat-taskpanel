/**
 * The one foundation reading of "this card is a container, not a unit of work".
 *
 * An `epic` aggregates other cards: it is never claimed and never pulses, and
 * its container auto-start enters `in_progress` with no holder on purpose
 * (`src/core/README.md` § the container state). Anything that watches *workers*
 * — a heartbeat, a claim, an assignee — must therefore skip it, or it reports
 * the board's designed state as a defect on every pass.
 *
 * The storage enum stays core-side (`src/core/domain/enums.mjs#TASK_KIND.EPIC`):
 * `foundation` may not import `core`, so the literal lives here once rather than
 * being re-spelled at each call site. `isUnownedContainer` in
 * `src/core/domain/claim.mjs` keeps its own, narrower meaning (the unowned
 * auto-start state, on camelCase core DTOs) and is not replaced by this.
 */

export const CONTAINER_KIND = "epic";

/**
 * @param {{kind?: unknown}|null|undefined} task a wire card or a core DTO
 * @returns {boolean} true when the card is a container
 */
export function isContainer(task) {
  return task?.kind === CONTAINER_KIND;
}
