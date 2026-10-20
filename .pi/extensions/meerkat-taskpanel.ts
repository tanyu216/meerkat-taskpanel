/**
 * The Pi extension — how Pi finds the board skill without a copy of it, and how
 * a session receives the per-repo issue-tracker check.
 *
 * The logic lives in `meerkat-taskpanel-core.mjs` so `node --test` can drive it
 * with a fake `pi`; this file is the host entry point and calls `register(pi)`.
 *
 * Pi is a Shape-B host: it loads a JS/TS module that exposes lifecycle callbacks, and it
 * runs the module *as written*. The root `package.json` declares both halves under `pi`:
 *
 *   "pi": { "skills": ["./skills"], "extensions": ["./.pi/extensions/meerkat-taskpanel.ts"] }
 *
 * so the skills path is declared there as well; this module re-registers the same
 * directory at runtime, which is what the reference implementation does
 * (`obra/superpowers` @ v7.0.0, `.pi/extensions/superpowers.ts`) and what keeps working
 * on a Pi build that discovers skills only through `resources_discover`.
 *
 * The `import type` is deliberately undeclared and never type-checked by this repository:
 * Pi supplies `ExtensionAPI` at load time. That is the reference's documented arrangement
 * (`docs/porting-to-a-new-harness.md` § "Build/dependency check") and it is why this file
 * costs the project no dependency. If Pi is ever changed to type-check or bundle plugin
 * sources, that check must be revisited deliberately — not answered by adding a devDep.
 *
 * The directory resolves from this file, so it follows the package wherever it is
 * installed: `resolve(<repo>/<.pi>/<extensions>, "../..")` is the package root, and its
 * `skills/` is the one tree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register } from "./meerkat-taskpanel-core.mjs";

export default function meerkatTaskpanelPiExtension(pi: ExtensionAPI): void {
  register(pi);
}
