/**
 * The minimal Vue reactivity surface the web modules under test actually use —
 * an external-framework boundary stub (see `./vue-loader.mjs` for the why).
 *
 * Behaviour, chosen to be faithful under synchronous test assertions:
 *   * `reactive` is the identity function — mutations land on the same object,
 *     so `board.tasks = [...]` is observable exactly where the store put it;
 *   * `computed` is a lazy getter — reading `.value` re-runs the function, so a
 *     read after a mutation sees the new value (there is no caching to go stale);
 *   * `ref` is `{ value }`.
 *
 * Anything a module imports that is not exported here fails at link time
 * (ESM named-import validation), which is the loud failure we want.
 */

export function reactive(target) {
  return target;
}

export function computed(getter) {
  return {
    get value() {
      return getter();
    },
  };
}

export function ref(value) {
  return { value };
}
