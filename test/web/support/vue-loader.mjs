/**
 * A Node module-resolution hook that aliases the bare `vue` specifier to a
 * minimal, in-repo shim (`./vue-shim.mjs`).
 *
 * WHY THIS EXISTS — the honest boundary
 * ------------------------------------
 * The store modules under test (`stores/board.js`, `stores/ui.js`,
 * `i18n/index.js`) import `reactive` / `computed` / `ref` from `vue`. The
 * container that runs `node --test` **deliberately ships no `node_modules`**
 * (`docker/Dockerfile`: "no devDependencies and no `node_modules` ever enter
 * this image" — the runtime stage's only frontend contribution is the static
 * `web/dist`). So the real Vue package is *unavailable by design* wherever the
 * suite is gated, and a test that reached for it would pass on a developer
 * laptop and fail in CI.
 *
 * Vue is the one **external framework boundary** of these modules — exactly the
 * kind of thing the card allows us to stub (like a fake `fetch` or
 * `EventSource`). We stub *only* Vue's reactivity primitives, never anything
 * inside `web/src`. The shim is deliberately tiny and faithful for synchronous
 * assertions:
 *
 *   * `reactive(o)` returns `o` itself, so reads and writes are the plain
 *     object's — identity is preserved;
 *   * `computed(fn)` recomputes lazily on every `.value` read, so a value read
 *     after a mutation always reflects it;
 *   * `ref(v)` is `{ value: v }`.
 *
 * A missing export is loud, not silent: ESM link-time validation throws if a
 * module under test imports a Vue API the shim does not provide, so the shim
 * cannot quietly mask a real dependency.
 *
 * Register it from a test file with:
 *   import { register } from "node:module";
 *   register("./support/vue-loader.mjs", import.meta.url);
 * then load the module under test with a dynamic `import()` (loaders apply to
 * imports that happen *after* `register`).
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vue") {
    return { url: new URL("./vue-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
